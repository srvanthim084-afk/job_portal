-- ---------------------------------------------------------------------
-- 0095 — job portal upgrades
--
--   1  quick filter chips      app_settings 'quick_filters' (admin edits)
--   3  share a job             job_shares + job_share_applications
--   4  one-click apply         application_undo(): ten seconds, owner only
--   5  last date + urgent      jobs.urgent, jobs.urgent_until (+14 days,
--                              switched off by the sweep), deadline book-
--                              keeping, recruiter reminder / closed notice
--   +  candidate alerts        notification_log gains candidate, job,
--                              event, match % and retry columns; one row
--                              per (candidate, job, event, channel)
--
-- Every function that writes across users is SECURITY DEFINER and checks
-- the caller itself; nothing here widens a table policy.
-- ---------------------------------------------------------------------

/* ===================================================================== *
 * 5. last date + urgent hiring
 * ===================================================================== */

alter table jobs add column if not exists urgent boolean not null default false;
alter table jobs add column if not exists urgent_until timestamptz;
/* When the "Urgent hiring" alert last went out for this job. NULL means it
   is due: set back to NULL whenever urgent is switched on, so turning it
   on (again) is what announces it. */
alter table jobs add column if not exists urgent_alerted_at timestamptz;
/* The deadline the recruiter was last reminded about ("extend or close?").
   Stored as the deadline itself, so extending the date earns a new
   reminder and re-running the sweep never sends a second one. */
alter table jobs add column if not exists deadline_reminded_for timestamptz;

comment on column jobs.urgent is
  'Recruiter ticked "Urgent hiring". Effective only while urgent_until is in the future (0095).';
comment on column jobs.urgent_until is
  'When urgent hiring switches itself off. now() + 14 days when urgent is turned on, unless given (0095).';

create or replace function jobs_urgent_window() returns trigger
language plpgsql as $$
begin
  if new.urgent then
    if tg_op = 'INSERT' or not coalesce(old.urgent, false) then
      new.urgent_until := coalesce(new.urgent_until, now() + interval '14 days');
      new.urgent_alerted_at := null;
    elsif new.urgent_until is null then
      new.urgent_until := now() + interval '14 days';
    end if;
    /* Republished while urgent: announce again (the per-candidate log
       still stops anybody hearing twice). */
    if tg_op = 'UPDATE' and old.status is distinct from 'open' and new.status = 'open' then
      new.urgent_alerted_at := null;
    end if;
  else
    new.urgent_until := null;
  end if;
  return new;
end $$;

drop trigger if exists jobs_urgent_window on jobs;
create trigger jobs_urgent_window before insert or update on jobs
  for each row execute function jobs_urgent_window();

create index if not exists jobs_expires_open_idx on jobs (expires_at)
  where status = 'open' and expires_at is not null;
create index if not exists jobs_urgent_idx on jobs (urgent_until) where urgent;

/* The two views expand j.* once, when they are created (see 0073, 0083),
   so they are rebuilt with the same bodies to carry the new columns. */
drop view if exists jobs_open;
drop view if exists jobs_with_counts;

create view jobs_with_counts with (security_invoker = true) as
select j.*,
       (select count(*) from applications a where a.job_id = j.id)::int as applicants,
       case when j.published_at is null then null
            else greatest(0, (extract(epoch from (now() - j.published_at)) / 86400)::int)
       end as posted_days_ago
  from jobs j;

create view jobs_open with (security_invoker = true) as
select * from jobs_with_counts
where status not in ('closed','draft')
  and not paused
  and not archived
  and (expires_at is null or expires_at > now());

comment on view jobs_open is
  'What a candidate may see: Active postings only. "Active" on the posting forms is this view''s rule, not a second flag.';

/*
 * Why an apply was refused, for a job the caller may no longer be able to
 * read: row level security hides an expired posting from candidates, so
 * without this the answer was "not found" instead of "applications
 * closed on 3 Oct". Returns the state of an existing job and nothing else.
 */
create or replace function portal_job_apply_state(p_job text)
returns table (status text, paused boolean, archived boolean, expires_at timestamptz)
language sql stable security definer set search_path = public as $$
  select j.status, j.paused, j.archived, j.expires_at from jobs j where j.id = p_job
$$;

/* Bookkeeping for the once-a-day passes (deadline alerts, recruiter
   reminders). A (kind, day) row exists once the pass for that IST day
   has run, so a restart cannot run it twice. */
create table if not exists portal_daily_runs (
  kind    text not null,
  day     date not null,
  ran_at  timestamptz not null default now(),
  detail  jsonb not null default '{}'::jsonb,
  primary key (kind, day)
);
alter table portal_daily_runs enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'portal_daily_runs'
                  and policyname = 'portal_daily_runs_admin') then
    create policy portal_daily_runs_admin on portal_daily_runs for all
      using (app_is_admin()) with check (app_is_admin());
  end if;
end $$;

/* ===================================================================== *
 * 1. quick filter chips
 * ===================================================================== */

insert into app_settings (key, value) values ('quick_filters', jsonb_build_object('chips', jsonb_build_array(
  jsonb_build_object('key','fresher',   'label','Fresher',           'enabled',true),
  jsonb_build_object('key','wfh',       'label','Work from home',    'enabled',true),
  jsonb_build_object('key','immediate', 'label','Immediate joining', 'enabled',true),
  jsonb_build_object('key','near_me',   'label','Near me',           'enabled',true),
  jsonb_build_object('key','today',     'label','Posted today',      'enabled',true),
  jsonb_build_object('key','urgent',    'label','Urgent hiring',     'enabled',true),
  jsonb_build_object('key','salary3',   'label','Salary 3 LPA+',     'enabled',true),
  jsonb_build_object('key','walkin',    'label','Walk-in',           'enabled',true)
)))
on conflict (key) do nothing;

/* ===================================================================== *
 * 3. sharing a job
 * ===================================================================== */

create table if not exists job_shares (
  id              bigserial primary key,
  job_id          text not null references jobs(id) on delete cascade,
  shared_by       text,                    -- profile id, NULL when signed out
  shared_by_role  text,
  channel         text not null default 'other'
                  check (channel in ('native','whatsapp','copy','email','linkedin','other')),
  code            text not null unique check (code ~ '^[A-Za-z0-9_-]{6,32}$'),
  clicks          int not null default 0,
  created_at      timestamptz not null default now()
);
create index if not exists job_shares_job_idx on job_shares (job_id);

create table if not exists job_share_applications (
  application_id  text primary key references applications(id) on delete cascade,
  code            text not null references job_shares(code) on delete cascade,
  created_at      timestamptz not null default now()
);
create index if not exists job_share_applications_code_idx on job_share_applications (code);

alter table job_shares enable row level security;
alter table job_share_applications enable row level security;

do $$
begin
  /* Read: the person who shared, an administrator, or the recruiter who
     owns the job. Writes only through the functions below. */
  if not exists (select 1 from pg_policies where tablename = 'job_shares' and policyname = 'job_shares_read') then
    create policy job_shares_read on job_shares for select using (
      app_is_admin()
      or (shared_by is not null and shared_by in (app_candidate_id(), app_recruiter_id()))
      or (app_role() = 'recruiter' and exists (
            select 1 from jobs j where j.id = job_shares.job_id
               and j.recruiter_id is not distinct from app_recruiter_id())));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'job_share_applications' and policyname = 'job_share_applications_admin') then
    create policy job_share_applications_admin on job_share_applications for select
      using (app_is_admin());
  end if;
end $$;

/**
 * A share of an OPEN job, by whoever is asking (signed out included).
 * The caller supplies a random code; the job must be one the public can
 * see, so a draft or an expired posting cannot be advertised this way.
 */
create or replace function job_share_create(p_job text, p_channel text, p_code text)
returns text
language plpgsql security definer set search_path = public as $$
declare v_by text; v_role text := app_role();
begin
  if not exists (select 1 from jobs j where j.id = p_job and j.status = 'open'
                   and not j.paused and not j.archived
                   and (j.expires_at is null or j.expires_at > now())) then
    return null;
  end if;
  v_by := case v_role when 'candidate' then app_candidate_id()
                      when 'recruiter' then app_recruiter_id()
                      else null end;
  insert into job_shares (job_id, shared_by, shared_by_role, channel, code)
  values (p_job, v_by, case when v_by is null then null else v_role end,
          coalesce(nullif(p_channel, ''), 'other'), p_code);
  return p_code;
end $$;

/** Somebody opened a shared link. Returns the job it points at. */
create or replace function job_share_click(p_code text)
returns text
language plpgsql security definer set search_path = public as $$
declare v_job text;
begin
  update job_shares set clicks = clicks + 1 where code = p_code returning job_id into v_job;
  return v_job;
end $$;

/** Credit an application to the share that brought it. The applicant
    only, the application's own job only, once. */
create or replace function job_share_applied(p_code text, p_application text)
returns boolean
language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  insert into job_share_applications (application_id, code)
  select a.id, s.code
    from applications a join job_shares s on s.job_id = a.job_id and s.code = p_code
   where a.id = p_application
     and (a.candidate_id = app_candidate_id() or app_is_admin())
  on conflict do nothing;
  get diagnostics v_n = row_count;
  return v_n > 0;
end $$;

/** "Shared 23 times · 9 applies" — for the job's recruiter or an admin. */
create or replace function job_share_stats(p_job text)
returns table (shares bigint, clicks bigint, applies bigint)
language plpgsql stable security definer set search_path = public as $$
begin
  if not (app_is_admin() or (app_role() = 'recruiter' and exists (
            select 1 from jobs j where j.id = p_job
               and (j.recruiter_id is not distinct from app_recruiter_id()
                    or j.recruiter_id is null)))) then
    raise exception 'job_share_stats: not your job' using errcode = '42501';
  end if;
  return query
    select (select count(*) from job_shares s where s.job_id = p_job),
           (select coalesce(sum(s.clicks), 0)::bigint from job_shares s where s.job_id = p_job),
           (select count(*) from job_share_applications x
              join job_shares s on s.code = x.code where s.job_id = p_job);
end $$;

/* ===================================================================== *
 * 4. one-click apply: Undo within ten seconds
 * ===================================================================== */

/**
 * Withdraw an application the candidate made a moment ago.
 *
 * Only the applicant, and only within p_seconds (10) of applied_at - after
 * that the application stands and the ordinary rules apply. Everything
 * hanging off the row (its notifications, history, screening) goes with
 * it through the foreign keys.
 *
 * Returns 'undone', 'not_found', 'forbidden' or 'too_late'.
 */
create or replace function application_undo(p_application text, p_seconds int default 10)
returns text
language plpgsql security definer set search_path = public as $$
declare a record;
begin
  select id, candidate_id, applied_at into a from applications where id = p_application;
  if not found then return 'not_found'; end if;
  if app_role() <> 'candidate' or a.candidate_id is distinct from app_candidate_id() then
    return 'forbidden';
  end if;
  if a.applied_at < now() - make_interval(secs => least(greatest(p_seconds, 1), 10)) then
    return 'too_late';
  end if;
  delete from applications where id = p_application;
  return 'undone';
end $$;

/* ===================================================================== *
 * candidate notifications: urgent hiring and the last date
 * ===================================================================== */

alter table notification_log add column if not exists candidate_id  text references candidates(id) on delete cascade;
alter table notification_log add column if not exists job_id        text references jobs(id) on delete cascade;
alter table notification_log add column if not exists event_type    text;
alter table notification_log add column if not exists match_percent numeric;
alter table notification_log add column if not exists sent_at       timestamptz;
alter table notification_log add column if not exists attempts      int not null default 0;
alter table notification_log add column if not exists last_attempt_at timestamptz;
alter table notification_log add column if not exists next_retry_at timestamptz;
alter table notification_log add column if not exists notification_id text;

/* In-app is a channel like the others, and a delivery that was skipped
   on purpose (opted out, nothing configured) is not a failure. */
alter table notification_log drop constraint if exists notification_log_channel_check;
alter table notification_log add constraint notification_log_channel_check
  check (channel in ('email','whatsapp','sms','ivr','in_app'));
alter table notification_log drop constraint if exists notification_log_status_check;
alter table notification_log add constraint notification_log_status_check
  check (status in ('queued','sent','failed','skipped','not_configured'));

alter table notification_log drop constraint if exists notification_log_event_check;
alter table notification_log add constraint notification_log_event_check
  check (event_type is null or event_type in ('urgent_hiring','deadline_2d','deadline_today'));

/* At most one notification per candidate, per job, per event, per channel. */
create unique index if not exists notification_log_once
  on notification_log (candidate_id, job_id, event_type, channel)
  where event_type is not null;
create index if not exists notification_log_retry_idx
  on notification_log (next_retry_at) where status in ('failed','not_configured');

comment on column notification_log.match_percent is
  'The match the candidate had with the job when this was sent - recomputed at send time (0095).';

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant select on jobs_with_counts, jobs_open to app_api;
    grant select, insert, update, delete on portal_daily_runs to app_api;
    grant select on job_shares, job_share_applications to app_api;
    grant select, insert, update on notification_log to app_api;
    grant usage, select on sequence notification_log_id_seq to app_api;
    grant execute on function portal_job_apply_state(text) to app_api;
    grant execute on function job_share_create(text, text, text) to app_api;
    grant execute on function job_share_click(text) to app_api;
    grant execute on function job_share_applied(text, text) to app_api;
    grant execute on function job_share_stats(text) to app_api;
    grant execute on function application_undo(text, int) to app_api;
  end if;
end $$;
