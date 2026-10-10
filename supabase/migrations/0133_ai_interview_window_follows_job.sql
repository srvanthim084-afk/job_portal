-- ---------------------------------------------------------------------
-- 0133 - the AI interview is open as long as the JOB is
--
-- The owner's rule (2026-10-10):
--   * the interview closes by itself when the job is closed, when the job
--     posting's last date has passed, or when the interview's own date has
--     passed - and the candidate is told "you applied, but the date is
--     over, so you cannot attend the interview now";
--   * a job with NO date: the candidate can attend at any time while the
--     job is open;
--   * on the day the job closes, a candidate who applied and has not taken
--     the interview is emailed "the job closes today - attend before it
--     closes".
--
-- Until now the "Complete by" date was applied_at + 48 hours for every
-- application (0015), whatever the job said: a job with no closing date
-- showed "Overdue" after two days (and the interview could still be
-- started anyway), and a job that had closed still offered "Attend".
--
-- From here:
--   ai_interview_due_at = the job's last date (jobs.expires_at), or NULL
--   when the job has none. A retake (0120) still moves it to the retake's
--   own window. So a non-NULL due date is always a REAL date.
--   ai_interview_window(application) = open | the reason it is closed:
--     job_closed   the job's status is closed / draft, or it is archived
--     job_expired  the job's last date has passed
--     walkin_over  a walk-in whose date is before today (IST)
--     due_passed   the interview's own date (e.g. a retake window) passed
--   ai_interview_start refuses a closed window, so it cannot be skipped by
--   calling the API.
--
-- DDL first, the backfill last (0120: pending trigger events).
-- ---------------------------------------------------------------------

/* no artificial 48 hours any more: a new application takes the job's date (trigger below) */
alter table applications alter column ai_interview_due_at drop default;

/* the reminder bookkeeping learns the closing-day email */
alter table ai_interview_reminders drop constraint if exists ai_interview_reminders_kind_check;
alter table ai_interview_reminders add constraint ai_interview_reminders_kind_check
  check (kind in ('invited','reminder','final','expired','closing_today'));

-- ---------------------------------------------------------------------
-- is it open?
-- ---------------------------------------------------------------------
create or replace function ai_interview_window(p_application_id text)
returns table (open boolean, reason text, due_at timestamptz)
language sql stable security definer set search_path = public as $$
  with x as (
    select a.ai_interview_due_at as due, j.id as job_id, j.status, coalesce(j.archived, false) as archived,
           j.expires_at, j.posting_kind, j.walkin_date
      from applications a
      left join jobs j on j.id = a.job_id
     where a.id = p_application_id
  ), r as (
    select x.*,
           case
             when x.job_id is null                                   then 'job_closed'
             when x.status in ('closed', 'draft') or x.archived      then 'job_closed'
             when x.expires_at is not null and x.expires_at < now()  then 'job_expired'
             when x.posting_kind = 'walkin'
                  and x.walkin_date ~ '^\d{4}-\d{2}-\d{2}$'
                  and x.walkin_date::date < (now() at time zone 'Asia/Kolkata')::date
                                                                     then 'walkin_over'
             when x.due is not null and x.due < now()                then 'due_passed'
             else null
           end as reason
      from x
  )
  select r.reason is null, r.reason, coalesce(r.due, r.expires_at) from r;
$$;

-- ---------------------------------------------------------------------
-- the due date follows the job
-- ---------------------------------------------------------------------
create or replace function applications_ai_due_from_job() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.ai_interview_due_at is null then
    select j.expires_at into new.ai_interview_due_at from jobs j where j.id = new.job_id;
  end if;
  return new;
end $$;

drop trigger if exists applications_ai_due_from_job on applications;
create trigger applications_ai_due_from_job
  before insert on applications
  for each row execute function applications_ai_due_from_job();

/* the recruiter moves the job's last date: every pending interview for it moves with it */
create or replace function jobs_ai_due_follows_expiry() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.expires_at is distinct from old.expires_at then
    update applications a
       set ai_interview_due_at = new.expires_at
     where a.job_id = new.id
       and a.stage in ('applied', 'ai_screening')
       and not exists (select 1 from ai_interviews iv
                        where iv.application_id = a.id and iv.status = 'completed');
  end if;
  return new;
end $$;

drop trigger if exists jobs_ai_due_follows_expiry on jobs;
create trigger jobs_ai_due_follows_expiry
  after update of expires_at on jobs
  for each row execute function jobs_ai_due_follows_expiry();

-- ---------------------------------------------------------------------
-- what is owed (reminders): "closes today" on the job's last day
-- ---------------------------------------------------------------------
create or replace function ai_interview_due_queue()
returns table (
  application_id text,
  candidate_id   text,
  job_id         text,
  due_at         timestamptz,
  kind           text
)
language sql security definer set search_path = public as $$
  with pending as (
    select a.id, a.candidate_id, a.job_id, a.ai_interview_due_at as due
      from applications a
      join jobs j on j.id = a.job_id
     where a.ai_interview_due_at is not null
       and a.stage in ('applied','ai_screening')
       and not exists (
         select 1 from ai_interviews iv
          where iv.application_id = a.id and iv.status = 'completed')
  ),
  owed as (
    select p.*,
           case
             when p.due < now() then 'expired'
             /* the job's (or the retake's) last day, in India: one email that morning */
             when (p.due at time zone 'Asia/Kolkata')::date = (now() at time zone 'Asia/Kolkata')::date
               then 'closing_today'
             when p.due - now() <= interval '24 hours' then 'reminder'
             else null
           end as kind
      from pending p
  )
  select o.id, o.candidate_id, o.job_id, o.due, o.kind
    from owed o
   where o.kind is not null
     /* a closed job is not "closing today", and is not reminded about */
     and (o.kind = 'expired' or (select w.open from ai_interview_window(o.id) w))
     and not exists (
       select 1 from ai_interview_reminders r
        where r.application_id = o.id and r.kind = o.kind)
   order by o.due
   limit 200;
$$;

-- ---------------------------------------------------------------------
-- starting: refused when closed
-- ---------------------------------------------------------------------
create or replace function ai_interview_start(
  p_id text,
  p_application_id text,
  p_candidate_id text,
  p_job_id text,
  p_question_set_hash text,
  p_questions jsonb,
  p_deadline_hours int default 48
) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_ok boolean;
  v_q jsonb;
  v_due timestamptz;
  v_open boolean;
  v_reason text;
begin
  if jsonb_array_length(coalesce(p_questions, '[]'::jsonb)) = 0 then
    raise exception 'refusing to start an interview with no questions';
  end if;

  select a.ai_interview_due_at, true into v_due, v_ok
    from applications a
   where a.id = p_application_id and a.candidate_id = p_candidate_id and a.job_id = p_job_id;
  if not coalesce(v_ok, false) then
    raise exception 'no such application for this candidate';
  end if;

  select w.open, w.reason into v_open, v_reason from ai_interview_window(p_application_id) w;
  if not coalesce(v_open, false) then
    raise exception 'AI_INTERVIEW_CLOSED:%', coalesce(v_reason, 'job_closed');
  end if;

  insert into ai_interviews
    (id, application_id, candidate_id, job_id, status, mode,
     questions_asked, started_at, expires_at, question_set_hash)
  values (p_id, p_application_id, p_candidate_id, p_job_id, 'in_progress', 'voice',
          jsonb_array_length(p_questions), now(),
          /* the session's own lifetime: two days, never beyond the job's last date */
          least(coalesce(v_due, 'infinity'::timestamptz), now() + make_interval(hours => coalesce(p_deadline_hours, 48))),
          p_question_set_hash);

  for v_q in select * from jsonb_array_elements(p_questions) loop
    insert into ai_interview_answers
      (ai_interview_id, seq, category, section, question, answered, score, justification)
    values (p_id,
            (v_q->>'seq')::int,
            v_q->>'category',
            v_q->>'section',
            v_q->>'question',
            false, 0,
            v_q->>'meta');
  end loop;

  return p_id;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant execute on function ai_interview_window(text) to app_api;
    grant execute on function ai_interview_due_queue() to app_api;
    grant execute on function ai_interview_start(text, text, text, text, text, jsonb, int) to app_api;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- backfill, LAST: every pending interview takes its job's date (NULL when the job has none) -
-- the made-up 48-hour deadlines go
-- ---------------------------------------------------------------------
update applications a
   set ai_interview_due_at = j.expires_at
  from jobs j
 where j.id = a.job_id
   and a.stage in ('applied', 'ai_screening')
   and not exists (select 1 from ai_interviews iv
                    where iv.application_id = a.id and iv.status in ('completed', 'suspended'))
   and a.ai_interview_due_at is distinct from j.expires_at;
