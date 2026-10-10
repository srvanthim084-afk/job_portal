-- ---------------------------------------------------------------------
-- 0138 - walk-in AI eligibility, and the HR / candidate notices that
--        must go out exactly once
--
-- ELIGIBILITY. A walk-in applicant is ELIGIBLE when the FINAL AI interview
-- score is 50% or more (the job's threshold, 50 unless the job says
-- otherwise): 49 -> Not Eligible, 50 / 51 / 75 / 100 -> Eligible.
--   * the final score = overall_percentage of the application's LATEST
--     completed attempt (a retake replaces the earlier result);
--   * only a real score counts: the interview completed AND content-scored
--     (something said was assessed) AND 0..100. Anything else is
--     'score_invalid' - never eligible;
--   * decided here, in the database, by a trigger on the interview row -
--     no screen and no candidate can set it. The four columns refuse any
--     write that does not come through walkin_ai_settle();
--   * eligibility is NOT attendance: attended_at / the walk-in stages are
--     untouched (0107), and so is the stage rule (walk-in stages only).
--
-- NOTICES. application_notices holds one row per (application, event):
--   APPLICATION_SUBMITTED_CANDIDATE   the candidate's confirmation (claimed
--                                     before the existing email goes)
--   WALKIN_APPLICATION_SUBMITTED_HR   to INTERNAL_HR_EMAIL, when a walk-in
--                                     application is saved
--   WALKIN_CANDIDATE_ELIGIBLE         to INTERNAL_HR_EMAIL, when the final
--                                     score makes the applicant eligible
-- The unique key is the idempotency: a refresh, a retried request, a
-- re-scored interview or a second sweep cannot make a second row, so it
-- cannot make a second email. The server sends pending rows, records
-- sent / failed with the error, and retries a failure a few times. An
-- email that fails never touches the application or its eligibility.
--
-- WALK-IN JOB FIELDS. The contact person's designation, whether the AI
-- interview is part of this walk-in, and its eligibility threshold.
-- ---------------------------------------------------------------------

-- ---- the job ----------------------------------------------------------
alter table jobs
  add column if not exists walkin_contact_designation text,
  add column if not exists walkin_ai_required        boolean not null default true,
  add column if not exists walkin_ai_threshold       numeric not null default 50;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'jobs_walkin_ai_threshold_chk') then
    alter table jobs add constraint jobs_walkin_ai_threshold_chk
      check (walkin_ai_threshold >= 0 and walkin_ai_threshold <= 100);
  end if;
end $$;

/* The two job views expand j.* once, when they are created (0073, 0106, 0113, 0125), so they
   are rebuilt to carry the new columns. Same bodies as 0125. */
drop view if exists jobs_open;
drop view if exists jobs_with_counts;

create view jobs_with_counts with (security_invoker = true) as
select j.*,
       (select count(*) from applications a where a.job_id = j.id)::int as applicants,
       case when j.published_at is null then null
            else greatest(0, (extract(epoch from (now() - j.published_at)) / 86400)::int)
       end as posted_days_ago,
       case when j.posting_kind = 'walkin' and j.walkin_capacity is not null
            then walkin_registered_count(j.id) end as walkin_registered
  from jobs j;

create view jobs_open with (security_invoker = true) as
select * from jobs_with_counts
where status not in ('closed','draft')
  and not paused
  and not archived
  and (expires_at is null or expires_at > now())
  and not (posting_kind = 'walkin'
           and coalesce(walkin_ends_at(walkin_date, walkin_to) <= now(), false))
  /* 0113: the Jobs page is TeamLink's own jobs, at the source. */
  and source_type = 'TEAMLINK';

comment on view jobs_open is
  'What the Jobs page may list: Active TeamLink jobs only (0113), no walk-in whose date and end time have passed (0106, typed dates 0137).';

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant select on jobs_with_counts, jobs_open to app_api;
  end if;
end $$;

-- ---- the application ------------------------------------------------------
alter table applications
  add column if not exists walkin_ai_score        numeric,
  add column if not exists walkin_ai_eligibility  text,
  add column if not exists walkin_ai_completed_at timestamptz,
  add column if not exists walkin_ai_decided_at   timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'applications_walkin_ai_elig_chk') then
    alter table applications add constraint applications_walkin_ai_elig_chk
      check (walkin_ai_eligibility is null or walkin_ai_eligibility in ('eligible', 'not_eligible', 'score_invalid'));
  end if;
end $$;

/* Nobody writes these but walkin_ai_settle(): not a candidate, not a screen, not a recruiter. */
create or replace function applications_walkin_ai_guard() returns trigger
language plpgsql as $$
begin
  if (new.walkin_ai_score        is distinct from old.walkin_ai_score
   or new.walkin_ai_eligibility  is distinct from old.walkin_ai_eligibility
   or new.walkin_ai_completed_at is distinct from old.walkin_ai_completed_at
   or new.walkin_ai_decided_at   is distinct from old.walkin_ai_decided_at)
   and coalesce(current_setting('app.walkin_ai_settle', true), '') <> 'on' then
    raise exception 'the AI interview score and walk-in eligibility are set by the system only'
      using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists ab_applications_walkin_ai_guard on applications;
create trigger ab_applications_walkin_ai_guard before update on applications
  for each row execute function applications_walkin_ai_guard();

-- ---- the notices ----------------------------------------------------------
create table if not exists application_notices (
  id             bigserial primary key,
  application_id text not null references applications(id) on delete cascade,
  event          text not null check (event in ('APPLICATION_SUBMITTED_CANDIDATE',
                                                'WALKIN_APPLICATION_SUBMITTED_HR',
                                                'WALKIN_CANDIDATE_ELIGIBLE')),
  status         text not null default 'pending'
                   check (status in ('pending', 'sending', 'sent', 'failed', 'skipped')),
  recipient      text,
  attempts       int not null default 0,
  last_error     text,
  detail         jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  claimed_at     timestamptz,
  sent_at        timestamptz,
  unique (application_id, event)
);
create index if not exists application_notices_due_idx on application_notices (status, created_at);

alter table application_notices enable row level security;
alter table application_notices force row level security;
drop policy if exists application_notices_read on application_notices;
create policy application_notices_read on application_notices for select using (app_is_admin());

/* A notice, once. TRUE when this call made it (the caller then sends it). */
create or replace function application_notice_open(p_application_id text, p_event text, p_detail jsonb default '{}'::jsonb)
returns boolean
language plpgsql security definer set search_path = public as $$
declare v_id bigint;
begin
  insert into application_notices (application_id, event, detail)
  values (p_application_id, p_event, coalesce(p_detail, '{}'::jsonb))
  on conflict (application_id, event) do nothing
  returning id into v_id;
  return v_id is not null;
end $$;

/* The sweep's claim: pending rows, failed ones due a retry, and any left "sending" by a crash. */
create or replace function application_notices_claim(p_limit int default 20, p_max_attempts int default 5)
returns setof application_notices
language plpgsql security definer set search_path = public as $$
begin
  return query
  update application_notices n
     set status = 'sending', claimed_at = now(), attempts = n.attempts + 1
   where n.id in (
     select x.id from application_notices x
      where x.event <> 'APPLICATION_SUBMITTED_CANDIDATE'          -- sent by the apply path itself
        and (x.status = 'pending'
         or (x.status = 'failed' and x.attempts < p_max_attempts
             and x.claimed_at < now() - make_interval(mins => least(60, 2 * x.attempts * x.attempts)))
         or (x.status = 'sending' and x.claimed_at < now() - interval '10 minutes'))
      order by x.created_at
      limit greatest(1, p_limit)
      for update skip locked)
  returning n.*;
end $$;

/* The candidate confirmation is claimed by the apply path: one claim per application. */
create or replace function application_notice_claim_one(p_application_id text, p_event text)
returns boolean
language plpgsql security definer set search_path = public as $$
declare v_id bigint;
begin
  insert into application_notices (application_id, event, status, claimed_at, attempts)
  values (p_application_id, p_event, 'sending', now(), 1)
  on conflict (application_id, event) do nothing
  returning id into v_id;
  return v_id is not null;
end $$;

create or replace function application_notice_done(p_application_id text, p_event text, p_status text,
                                                   p_recipient text, p_error text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_status not in ('sent', 'failed', 'skipped') then raise exception 'unknown notice status'; end if;
  update application_notices
     set status = p_status,
         recipient = coalesce(p_recipient, recipient),
         last_error = case when p_status = 'sent' then null else left(p_error, 500) end,
         sent_at = case when p_status = 'sent' then now() else sent_at end
   where application_id = p_application_id and event = p_event;
end $$;

-- ---- a walk-in application tells HR, the moment it is saved ----------------
create or replace function applications_walkin_hr_notice() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from jobs j where j.id = new.job_id and j.posting_kind = 'walkin') then
    perform application_notice_open(new.id, 'WALKIN_APPLICATION_SUBMITTED_HR', '{}'::jsonb);
  end if;
  return new;
end $$;

drop trigger if exists zz_applications_walkin_hr_notice on applications;
create trigger zz_applications_walkin_hr_notice after insert on applications
  for each row execute function applications_walkin_hr_notice();

-- ---- eligibility, decided once the interview is final ----------------------
create or replace function walkin_ai_settle(p_application_id text, p_notify boolean default true)
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_app   applications;
  v_job   jobs;
  v_iv    ai_interviews;
  v_score numeric;
  v_elig  text;
begin
  select * into v_app from applications where id = p_application_id;
  if not found then return null; end if;
  select * into v_job from jobs where id = v_app.job_id;
  if not found or v_job.posting_kind is distinct from 'walkin' then return null; end if;

  /* the FINAL score: the latest attempt that completed */
  select * into v_iv from ai_interviews
   where application_id = p_application_id and status in ('completed', 'evaluated')
   order by coalesce(attempt_number, 1) desc, completed_at desc nulls last
   limit 1;
  if not found then return v_app.walkin_ai_eligibility; end if;

  v_score := v_iv.overall_percentage;
  v_elig := case
    when v_score is null or v_score < 0 or v_score > 100 or not coalesce(v_iv.content_scored, false) then 'score_invalid'
    when v_score >= coalesce(v_job.walkin_ai_threshold, 50) then 'eligible'
    else 'not_eligible' end;

  if v_elig is distinct from v_app.walkin_ai_eligibility
     or v_score is distinct from v_app.walkin_ai_score then
    perform set_config('app.walkin_ai_settle', 'on', true);
    update applications
       set walkin_ai_score = case when v_elig = 'score_invalid' then null else v_score end,
           walkin_ai_eligibility = v_elig,
           walkin_ai_completed_at = v_iv.completed_at,
           walkin_ai_decided_at = now()
     where id = p_application_id;
    perform set_config('app.walkin_ai_settle', 'off', true);

    perform app_event(p_application_id, v_app.candidate_id, 'walkin.ai_eligibility',
      case v_elig
        when 'eligible' then format('Walk-in: Eligible - AI interview %s%% (needs %s%%)', round(v_score, 1), coalesce(v_job.walkin_ai_threshold, 50))
        when 'not_eligible' then format('Walk-in: Not Eligible - AI interview %s%% (needs %s%%)', round(v_score, 1), coalesce(v_job.walkin_ai_threshold, 50))
        else 'Walk-in: no valid AI interview score - not marked eligible' end,
      'system',
      jsonb_build_object('score', v_score, 'eligibility', v_elig, 'threshold', coalesce(v_job.walkin_ai_threshold, 50),
                         'interviewId', v_iv.id, 'attempt', v_iv.attempt_number));
  end if;

  if v_elig = 'eligible' and p_notify then
    perform application_notice_open(p_application_id, 'WALKIN_CANDIDATE_ELIGIBLE',
      jsonb_build_object('score', v_score, 'interviewId', v_iv.id));
  end if;
  return v_elig;
end $$;

create or replace function ai_interviews_walkin_settle() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.application_id is not null and new.status in ('completed', 'evaluated')
     and (tg_op = 'INSERT'
          or old.status is distinct from new.status
          or old.overall_percentage is distinct from new.overall_percentage
          or old.content_scored is distinct from new.content_scored) then
    perform walkin_ai_settle(new.application_id, true);
  end if;
  return new;
end $$;

drop trigger if exists zz_ai_interviews_walkin_settle on ai_interviews;
create trigger zz_ai_interviews_walkin_settle after insert or update on ai_interviews
  for each row execute function ai_interviews_walkin_settle();

/* A walk-in that does not use the AI interview has no interview to attend: the window says so
   ('not_required'), the session route refuses it, and the invitation is not sent (apply-messages.js).
   Otherwise exactly 0137's window. */
create or replace function ai_interview_window(p_application_id text)
returns table (open boolean, reason text, due_at timestamptz)
language sql stable security definer set search_path = public as $$
  with x as (
    select a.ai_interview_due_at as due, j.id as job_id, j.status, coalesce(j.archived, false) as archived,
           j.expires_at, j.posting_kind, j.walkin_date, j.walkin_ai_required
      from applications a
      left join jobs j on j.id = a.job_id
     where a.id = p_application_id
  ), r as (
    select x.*,
           case
             when x.job_id is null                                   then 'job_closed'
             when x.posting_kind = 'walkin' and x.walkin_ai_required = false then 'not_required'
             when x.status in ('closed', 'draft') or x.archived      then 'job_closed'
             when x.expires_at is not null and x.expires_at < now()  then 'job_expired'
             when x.posting_kind = 'walkin'
                  and coalesce(walkin_ends_at(x.walkin_date, null) < now(), false)
                                                                     then 'walkin_over'
             when x.due is not null and x.due < now()                then 'due_passed'
             else null
           end as reason
      from x
  )
  select r.reason is null, r.reason, coalesce(r.due, r.expires_at) from r;
$$;

/* What is already on file is settled once - quietly: no HR email for interviews finished before today. */
do $$
declare r record;
begin
  for r in select distinct a.id from applications a
             join jobs j on j.id = a.job_id and j.posting_kind = 'walkin'
             join ai_interviews i on i.application_id = a.id and i.status in ('completed', 'evaluated') loop
    perform walkin_ai_settle(r.id, false);
  end loop;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant select on application_notices to app_api;
    grant execute on function application_notice_open(text, text, jsonb), application_notices_claim(int, int),
      application_notice_claim_one(text, text), application_notice_done(text, text, text, text, text),
      walkin_ai_settle(text, boolean) to app_api;
  end if;
end $$;
