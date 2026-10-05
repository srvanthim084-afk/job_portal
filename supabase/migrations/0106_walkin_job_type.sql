-- ---------------------------------------------------------------------
-- 0106 - Walk-in is a JOB TYPE, not a section.
--
-- WHY. A walk-in interview is a job posting with a date, a time window,
-- a venue and a person to ask for at the gate. Rounds 1-2 also built a
-- separate "Walk-in Drives" module (0099, 0103) with its own pages, its
-- own navigation item and its own registrations. The owner's decision
-- (2026-10-05): one Jobs section, one job card, one Apply Now, one ATS.
-- Walk-ins are `jobs.posting_kind = 'walkin'` (0083 already gave them
-- their date, times, venue and contact), and this migration adds the
-- rest of what such a posting needs.
--
-- WHAT THIS ADDS
--   jobs.walkin_address / walkin_map_link / walkin_documents /
--   walkin_instructions / walkin_capacity       the shared contract with
--                                               0107 (identical
--                                               statements, IF NOT EXISTS)
--   walkin_starts_at() / walkin_ends_at()       IST instants of a drive,
--                                               derived, never stored
--   jobs_with_counts.walkin_registered          how many applied, for the
--                                               seat count (a candidate's
--                                               own RLS would count 1)
--   jobs_open                                   no longer lists a walk-in
--                                               whose end time has passed
--                                               (the job page still opens
--                                               and says Closed; staff
--                                               screens read the jobs table)
--   walkin_apply_check()                        capacity and "closed", at
--                                               SAVE time, under a row lock
--   apply_identity_check() / application_form_save()
--                                               mobile / email matching for
--                                               the application form
--   application_form_details                    what the candidate typed on
--                                               the form, per application
--   candidate_identity_reviews                  "mobile matches one record,
--                                               email another": flagged for
--                                               a recruiter, never merged
--   walkin_job_outbox / walkin_job_notices       the cancellation notice when
--                                               a walk-in is closed early
--   walkin_drives_migrate()                     drives -> walk-in jobs,
--                                               registrations -> applications
--                                               (run by the API at boot,
--                                               after every migration, so the
--                                               walk-in stages of 0107 exist)
--
-- WHAT IS LEFT ALONE. walkin_drives, walkin_registrations and
-- walkin_notifications keep every row. Nothing reads or writes them any
-- more except walkin_drives_migrate(), which only reads them.
-- ---------------------------------------------------------------------

/* ---------------------------------------------------------------- *
 * the shared contract (0107 carries the same statements)
 * ---------------------------------------------------------------- */
alter table jobs add column if not exists walkin_address      text;
alter table jobs add column if not exists walkin_map_link     text;
alter table jobs add column if not exists walkin_documents    text;      -- one item per line
alter table jobs add column if not exists walkin_instructions text;
alter table jobs add column if not exists walkin_capacity     int check (walkin_capacity is null or walkin_capacity > 0);

create or replace function walkin_starts_at(p_date text, p_from text) returns timestamptz
  language sql immutable as $$ select case when p_date ~ '^\d{4}-\d{2}-\d{2}$'
    then ((p_date || ' ' || coalesce(nullif(p_from,''),'00:00'))::timestamp at time zone 'Asia/Kolkata') end $$;
create or replace function walkin_ends_at(p_date text, p_to text) returns timestamptz
  language sql immutable as $$ select case when p_date ~ '^\d{4}-\d{2}-\d{2}$'
    then ((p_date || ' ' || coalesce(nullif(p_to,''),'23:59'))::timestamp at time zone 'Asia/Kolkata') end $$;

/* A posting typed "Walk-in" by an older screen but filed under the
   default kind is a walk-in: the job type follows the posting kind from
   now on, so the two are made to agree once. */
update jobs set posting_kind = 'walkin'
 where coalesce(employment_type, '') ~* '^walk'
   and coalesce(posting_kind, 'job') in ('job', '');

/* Three quick filter chips: the walk-ins happening today and this week
   (to Sunday, IST), and Internship. Appended to the admin's list once,
   switched on; the admin can hide or reorder them like any chip. */
update app_settings
   set value = jsonb_set(value, '{chips}', coalesce(value->'chips', '[]'::jsonb) || jsonb_build_array(
         jsonb_build_object('key', 'walkin_today', 'label', 'Walk-in today', 'enabled', true),
         jsonb_build_object('key', 'walkin_week', 'label', 'Walk-in this week', 'enabled', true),
         jsonb_build_object('key', 'internship', 'label', 'Internship', 'enabled', true)))
 where key = 'quick_filters'
   and not coalesce(value->'chips', '[]'::jsonb) @> '[{"key":"walkin_today"}]'::jsonb;

/* ---------------------------------------------------------------- *
 * how many have applied to a walk-in, whoever asks
 * ---------------------------------------------------------------- */
create or replace function walkin_registered_count(p_job text) returns int
language sql stable security definer set search_path = public as $$
  select count(*)::int from applications where job_id = p_job
$$;

/* The two views expand j.* once, when they are created (0073, 0083,
   0095), so they are rebuilt to carry the new columns. Same bodies, plus
   the seat count and the walk-in end rule. */
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
  /* A walk-in whose end time has passed is over. A date that is not a
     calendar date (typed by an older form) gives no end and stays. */
  and not (posting_kind = 'walkin'
           and coalesce(walkin_ends_at(walkin_date, walkin_to) <= now(), false));

comment on view jobs_open is
  'What a candidate may see: Active postings only, and no walk-in whose date and end time have passed (0106).';

/* ---------------------------------------------------------------- *
 * applying to a walk-in: closed and full are decided at SAVE time
 *
 * Called inside the transaction that inserts the application. The job
 * row is locked FOR UPDATE, so two candidates pressing Submit for the
 * last seat queue here: the second counts the first's application and
 * is told "Registrations full". Definer, because a candidate can see
 * only their own applications and cannot lock a job.
 * ---------------------------------------------------------------- */
create or replace function walkin_apply_check(p_job text) returns text
language plpgsql security definer set search_path = public as $$
declare v record; v_end timestamptz; v_n int;
begin
  select id, posting_kind, status, walkin_date, walkin_to, walkin_capacity
    into v from jobs where id = p_job for update;
  if not found or v.posting_kind is distinct from 'walkin' then return 'ok'; end if;
  v_end := walkin_ends_at(v.walkin_date, v.walkin_to);
  if v_end is not null and v_end <= now() then return 'closed'; end if;
  if v.walkin_capacity is not null then
    select count(*)::int into v_n from applications where job_id = p_job;
    if v_n >= v.walkin_capacity then return 'full'; end if;
  end if;
  return 'ok';
end $$;

/* ---------------------------------------------------------------- *
 * mobile / email matching
 *
 * The last ten digits are one telephone (0071's rule). A candidate's
 * own RLS hides every other candidate, so the question "does this number
 * belong to somebody else?" is answered here, in counts and kinds only:
 * no other candidate's id, name or contact detail ever leaves.
 * ---------------------------------------------------------------- */
create or replace function apply_digits(p text) returns text
language sql immutable as $$
  select nullif(right(regexp_replace(coalesce(p, ''), '\D', '', 'g'), 10), '')
$$;

create or replace function apply_identity_check(p_phone text, p_email text)
returns table (phone_self boolean, email_self boolean,
               phone_other_accounts int, email_other_accounts int,
               phone_other_records int, email_other_records int,
               one_other_account boolean)
language plpgsql stable security definer set search_path = public as $$
declare v_me text := app_candidate_id(); v_d text := apply_digits(p_phone);
        v_e text := lower(btrim(coalesce(p_email, '')));
begin
  if app_role() is distinct from 'candidate' or v_me is null then
    raise exception 'only a signed-in candidate can check this' using errcode = '42501';
  end if;
  if length(coalesce(v_d, '')) < 10 then v_d := null; end if;
  if v_e = '' then v_e := null; end if;
  return query
  with ph as (
    select c.id, c.user_id from candidates c
     where v_d is not null and apply_digits(c.phone) = v_d
  ), em as (
    select c.id, c.user_id from candidates c
     where v_e is not null
       and (lower(btrim(c.email)) = v_e
            or exists (select 1 from users u where u.id = c.user_id and lower(u.email) = v_e))
  ), others as (
    select id, user_id from ph where id <> v_me
    union select id, user_id from em where id <> v_me
  )
  select exists (select 1 from ph where id = v_me),
         exists (select 1 from em where id = v_me),
         (select count(*)::int from ph where id <> v_me and user_id is not null),
         (select count(*)::int from em where id <> v_me and user_id is not null),
         (select count(*)::int from ph where id <> v_me and user_id is null),
         (select count(*)::int from em where id <> v_me and user_id is null),
         (select count(distinct id) from others where user_id is not null) = 1
           and not exists (select 1 from others where user_id is null);
end $$;

/* ---------------------------------------------------------------- *
 * what the candidate typed on the form
 * ---------------------------------------------------------------- */
create table if not exists application_form_details (
  application_id     text primary key references applications(id) on delete cascade,
  candidate_id       text not null references candidates(id) on delete cascade,
  job_id             text not null references jobs(id) on delete cascade,
  job_type           text not null check (job_type in ('regular', 'walk-in')),
  full_name          text,
  mobile             text,
  email              text,
  current_location   text,
  preferred_location text,
  qualification      text,
  specialization     text,
  experience_years   numeric,
  current_salary     text,
  expected_salary    numeric,
  notice_period      text,
  resume_file        text,
  identity_review    boolean not null default false,
  created_at         timestamptz not null default now()
);
create index if not exists application_form_details_job_idx on application_form_details (job_id);

comment on table application_form_details is
  'The application form as submitted (0106). The candidate profile is updated only with non-empty values; this keeps what was typed for this application.';

alter table application_form_details enable row level security;
alter table application_form_details force  row level security;
/* Whoever can see the application can see its form (the candidate, the
   job's recruiter, admin): the applications policy decides, through the
   subquery. */
drop policy if exists application_form_details_read on application_form_details;
create policy application_form_details_read on application_form_details
  for select using (exists (select 1 from applications a where a.id = application_id));

/* ---------------------------------------------------------------- *
 * a mobile and an email that point at different people
 * ---------------------------------------------------------------- */
create table if not exists candidate_identity_reviews (
  id                  bigserial primary key,
  application_id      text references applications(id) on delete cascade,
  candidate_id        text not null references candidates(id) on delete cascade,
  typed_mobile        text,
  typed_email         text,
  mobile_candidate_ids text[] not null default '{}',
  email_candidate_ids  text[] not null default '{}',
  reason              text not null,
  status              text not null default 'open' check (status in ('open', 'resolved')),
  created_at          timestamptz not null default now(),
  resolved_at         timestamptz,
  resolved_by         text
);
create index if not exists candidate_identity_reviews_open_idx
  on candidate_identity_reviews (created_at desc) where status = 'open';

comment on table candidate_identity_reviews is
  'Possible duplicate people found by the application form (0106): the typed mobile and email match different candidate records. Never merged automatically; a recruiter reviews.';

alter table candidate_identity_reviews enable row level security;
alter table candidate_identity_reviews force  row level security;
/* Staff only: an admin, or a recruiter who can see the application. A
   candidate never reads this table (it names other candidate ids). */
drop policy if exists candidate_identity_reviews_read on candidate_identity_reviews;
create policy candidate_identity_reviews_read on candidate_identity_reviews
  for select using (
    app_role() = 'admin'
    or (app_role() = 'recruiter'
        and exists (select 1 from applications a where a.id = application_id)));
drop policy if exists candidate_identity_reviews_resolve on candidate_identity_reviews;
create policy candidate_identity_reviews_resolve on candidate_identity_reviews
  for update using (
    app_role() = 'admin'
    or (app_role() = 'recruiter'
        and exists (select 1 from applications a where a.id = application_id)));

/*
 * Store the form, and a review when the identity is split. Called by the
 * applicant, after the application exists. Returns true when a review
 * was opened.
 */
create or replace function application_form_save(p_app text, p_job_type text, p_form jsonb, p_review_reason text)
returns boolean
language plpgsql security definer set search_path = public as $$
declare a record; v_d text; v_e text; v_ph text[]; v_em text[];
begin
  select id, candidate_id, job_id into a from applications where id = p_app;
  if not found then raise exception 'no such application' using errcode = 'P0002'; end if;
  if not (app_role() = 'candidate' and a.candidate_id = app_candidate_id()) then
    raise exception 'only the applicant can store this form' using errcode = '42501';
  end if;
  insert into application_form_details (application_id, candidate_id, job_id, job_type,
      full_name, mobile, email, current_location, preferred_location, qualification,
      specialization, experience_years, current_salary, expected_salary, notice_period,
      resume_file, identity_review)
  values (a.id, a.candidate_id, a.job_id, p_job_type,
      left(p_form->>'name', 120), left(p_form->>'mobile', 20), left(p_form->>'email', 160),
      left(p_form->>'currentLocation', 160), left(p_form->>'preferredLocation', 160),
      left(p_form->>'qualification', 160), left(p_form->>'specialization', 160),
      nullif(p_form->>'experienceYears', '')::numeric, left(p_form->>'currentSalary', 40),
      nullif(p_form->>'expectedSalary', '')::numeric, left(p_form->>'noticePeriod', 40),
      left(p_form->>'resumeFile', 200), p_review_reason is not null)
  on conflict (application_id) do nothing;

  if p_review_reason is null then return false; end if;
  v_d := apply_digits(p_form->>'mobile');
  v_e := lower(btrim(coalesce(p_form->>'email', '')));
  select coalesce(array_agg(c.id order by c.id), '{}') into v_ph from candidates c
   where length(coalesce(v_d, '')) = 10 and apply_digits(c.phone) = v_d;
  select coalesce(array_agg(c.id order by c.id), '{}') into v_em from candidates c
   where v_e <> '' and (lower(btrim(c.email)) = v_e
         or exists (select 1 from users u where u.id = c.user_id and lower(u.email) = v_e));
  insert into candidate_identity_reviews (application_id, candidate_id, typed_mobile, typed_email,
      mobile_candidate_ids, email_candidate_ids, reason)
  values (a.id, a.candidate_id, left(p_form->>'mobile', 20), left(p_form->>'email', 160),
      v_ph, v_em, left(p_review_reason, 200));
  return true;
end $$;

/* ---------------------------------------------------------------- *
 * a walk-in closed early: its applicants are told, once
 *
 * The trigger only writes down that it happened (a trigger cannot send
 * an SMS, and must not fail a save if a gateway is down). The API's
 * sweep sends the messages and claims each (outbox, application,
 * channel) before sending, so a restart cannot send one twice.
 * ---------------------------------------------------------------- */
create table if not exists walkin_job_outbox (
  id           bigserial primary key,
  job_id       text not null references jobs(id) on delete cascade,
  kind         text not null check (kind in ('cancelled')),
  detail       jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  processed_at timestamptz
);
create index if not exists walkin_job_outbox_pending_idx on walkin_job_outbox (created_at) where processed_at is null;

create table if not exists walkin_job_notices (
  id             bigserial primary key,
  outbox_id      bigint not null references walkin_job_outbox(id) on delete cascade,
  application_id text not null references applications(id) on delete cascade,
  candidate_id   text not null,
  channel        text not null check (channel in ('portal', 'email', 'sms', 'whatsapp')),
  status         text not null default 'pending',
  to_address     text,
  provider       text,
  provider_ref   text,
  error          text,
  created_at     timestamptz not null default now(),
  unique (outbox_id, application_id, channel)
);

alter table walkin_job_outbox enable row level security;
alter table walkin_job_outbox force  row level security;
alter table walkin_job_notices enable row level security;
alter table walkin_job_notices force  row level security;
drop policy if exists walkin_job_outbox_read on walkin_job_outbox;
create policy walkin_job_outbox_read on walkin_job_outbox for select using (app_role() = 'admin');
drop policy if exists walkin_job_notices_read on walkin_job_notices;
create policy walkin_job_notices_read on walkin_job_notices for select using (app_role() = 'admin');

create or replace function walkin_job_close_watch() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_end timestamptz;
begin
  if old.posting_kind is distinct from 'walkin' then return new; end if;
  if not (old.status = 'open' and not old.archived) then return new; end if;
  if not (new.status in ('closed', 'draft') or new.archived) then return new; end if;
  v_end := walkin_ends_at(old.walkin_date, old.walkin_to);
  /* Closing it after the drive is housekeeping, not a cancellation. */
  if v_end is null or v_end <= now() then return new; end if;
  insert into walkin_job_outbox (job_id, kind, detail)
  values (old.id, 'cancelled', jsonb_build_object(
    'title', old.title, 'date', old.walkin_date, 'from', old.walkin_from, 'to', old.walkin_to,
    'venue', old.walkin_venue, 'contact', old.walkin_contact, 'phone', old.walkin_phone));
  return new;
end $$;

drop trigger if exists walkin_job_close_watch on jobs;
create trigger walkin_job_close_watch after update of status, archived on jobs
  for each row execute function walkin_job_close_watch();

create or replace function walkin_engine_guard() returns void
language plpgsql as $$
begin
  if not (app_role() = 'admin' and app_user_id() is null) then
    raise exception 'walk-in notices are sent by the API engine only' using errcode = '42501';
  end if;
end $$;

create or replace function walkin_outbox_pending()
returns setof walkin_job_outbox
language plpgsql security definer set search_path = public as $$
begin
  perform walkin_engine_guard();
  return query select * from walkin_job_outbox where processed_at is null order by id limit 50;
end $$;

/* Everybody who applied and has not been turned down, with what a
   message needs. */
create or replace function walkin_outbox_recipients(p_outbox bigint)
returns table (application_id text, reference text, candidate_id text, name text, email text,
               phone text, do_not_contact boolean, email_opt_in boolean, sms_opt_in boolean,
               whatsapp_opt_in boolean, stage text)
language plpgsql security definer set search_path = public as $$
begin
  perform walkin_engine_guard();
  return query
    select a.id, a.reference, c.id, c.name, c.email, c.phone,
           coalesce(c.do_not_contact, false), coalesce(c.email_opt_in, true), coalesce(c.sms_opt_in, true),
           coalesce(c.whatsapp_opt_in, false), a.stage
      from walkin_job_outbox o
      join applications a on a.job_id = o.job_id
      join candidates c on c.id = a.candidate_id
     where o.id = p_outbox and a.stage not in ('rejected', 'withdrawn')
     order by a.applied_at;
end $$;

create or replace function walkin_notice_claim(p_outbox bigint, p_app text, p_candidate text, p_channel text)
returns bigint
language plpgsql security definer set search_path = public as $$
declare v_id bigint;
begin
  perform walkin_engine_guard();
  insert into walkin_job_notices (outbox_id, application_id, candidate_id, channel)
  values (p_outbox, p_app, p_candidate, p_channel)
  on conflict do nothing returning id into v_id;
  return v_id;
end $$;

create or replace function walkin_notice_settle(p_id bigint, p_status text, p_to text, p_provider text,
                                                p_ref text, p_error text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  perform walkin_engine_guard();
  update walkin_job_notices set status = p_status, to_address = p_to, provider = p_provider,
         provider_ref = p_ref, error = left(p_error, 500)
   where id = p_id;
end $$;

create or replace function walkin_outbox_done(p_outbox bigint)
returns void
language plpgsql security definer set search_path = public as $$
begin
  perform walkin_engine_guard();
  update walkin_job_outbox set processed_at = now() where id = p_outbox;
end $$;

/* ---------------------------------------------------------------- *
 * the old drives become walk-in jobs
 *
 * Idempotent: a drive is migrated once (walkin_drive_job_map), a
 * registration once (the application's unique candidate+job). Cancelled
 * registrations are not applications and are not carried over. The
 * stage follows the registration where the walk-in stages exist (0107:
 * registered / attended / no_show); before they exist the ordinary
 * first stage is used, and a later run does not touch an application
 * that already exists.
 * ---------------------------------------------------------------- */
create table if not exists walkin_drive_job_map (
  drive_id    text primary key,
  job_id      text not null,
  migrated_at timestamptz not null default now()
);
alter table walkin_drive_job_map enable row level security;
alter table walkin_drive_job_map force  row level security;
drop policy if exists walkin_drive_job_map_read on walkin_drive_job_map;
create policy walkin_drive_job_map_read on walkin_drive_job_map for select using (app_role() = 'admin');

create or replace function walkin_drives_migrate()
returns table (drives int, applications int)
language plpgsql security definer set search_path = public as $$
declare d record; r record; v_job text; v_co text; v_stage text; v_drives int := 0; v_apps int := 0;
        v_n int;
begin
  perform walkin_engine_guard();
  if to_regclass('public.walkin_drives') is null then
    return query select 0, 0; return;
  end if;
  for d in select * from walkin_drives order by created_at loop
    select m.job_id into v_job from walkin_drive_job_map m where m.drive_id = d.id;
    if v_job is null then
      v_job := 'j_wk_' || d.id;
      v_co := coalesce(d.company_id,
                       (select j.company_id from jobs j where j.id = d.job_id),
                       (select rc.company_id from recruiters rc where rc.id = d.created_by_recruiter_id));
      insert into jobs (id, title, company_id, recruiter_id, location, mode, exp_label, pay_label,
                        employment_type, posting_kind, education, skills, description,
                        status, published_at, walkin_date, walkin_from, walkin_to, walkin_venue,
                        walkin_address, walkin_map_link, walkin_documents, walkin_contact,
                        walkin_phone, walkin_capacity, source)
      values (v_job, d.title, v_co, d.created_by_recruiter_id, d.city, 'Onsite',
              d.experience_required, d.salary_range, 'Walk-in', 'walkin', d.qualification,
              coalesce(d.skills, '{}'),
              coalesce(nullif(d.description, ''), 'Walk-in interviews for ' || d.job_role || ' in ' || d.city || '.'),
              case when d.status in ('UPCOMING', 'ONGOING') then 'open' else 'closed' end,
              d.created_at, to_char(d.drive_date, 'YYYY-MM-DD'), to_char(d.start_time, 'HH24:MI'),
              to_char(d.end_time, 'HH24:MI'), d.venue_name, d.full_address, d.map_link,
              nullif(array_to_string(coalesce(d.documents_to_carry, '{}'), E'\n'), ''),
              d.contact_person_name, d.contact_phone, d.max_seats, 'walkin_drive')
      on conflict (id) do nothing;
      insert into walkin_drive_job_map (drive_id, job_id) values (d.id, v_job) on conflict do nothing;
      v_drives := v_drives + 1;
    end if;

    for r in select * from walkin_registrations where drive_id = d.id and status <> 'CANCELLED' loop
      v_stage := case r.status when 'ATTENDED' then 'attended' when 'NO_SHOW' then 'no_show' else 'registered' end;
      if not exists (select 1 from stages s where s.id = v_stage) then
        v_stage := case when exists (select 1 from stages s where s.id = 'registered') then 'registered' else 'applied' end;
      end if;
      insert into applications (id, job_id, candidate_id, recruiter_id, stage, source, posting_type,
                                applied_at, applied_on)
      values ('app_wk_' || r.id, v_job, r.candidate_id, d.created_by_recruiter_id, v_stage,
              'walkin_drive', 'walkin', r.registered_at, (r.registered_at at time zone 'Asia/Kolkata')::date)
      on conflict do nothing;
      get diagnostics v_n = row_count;
      v_apps := v_apps + v_n;
    end loop;
  end loop;
  return query select v_drives, v_apps;
end $$;

comment on function walkin_drives_migrate() is
  'Walk-in drives (0099) become walk-in jobs and their registrations applications (0106). Idempotent; run by the API at boot. The drive tables are left as they are, read-only.';

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant select on jobs_with_counts, jobs_open to app_api;
    grant select on application_form_details, candidate_identity_reviews to app_api;
    grant update on candidate_identity_reviews to app_api;
    grant select on walkin_job_outbox, walkin_job_notices, walkin_drive_job_map to app_api;
    grant execute on function walkin_starts_at(text, text) to app_api;
    grant execute on function walkin_ends_at(text, text) to app_api;
    grant execute on function walkin_registered_count(text) to app_api;
    grant execute on function walkin_apply_check(text) to app_api;
    grant execute on function apply_digits(text) to app_api;
    grant execute on function apply_identity_check(text, text) to app_api;
    grant execute on function application_form_save(text, text, jsonb, text) to app_api;
    grant execute on function walkin_outbox_pending() to app_api;
    grant execute on function walkin_outbox_recipients(bigint) to app_api;
    grant execute on function walkin_notice_claim(bigint, text, text, text) to app_api;
    grant execute on function walkin_notice_settle(bigint, text, text, text, text, text) to app_api;
    grant execute on function walkin_outbox_done(bigint) to app_api;
    grant execute on function walkin_drives_migrate() to app_api;
  end if;
end $$;
