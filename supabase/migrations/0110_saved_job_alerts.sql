-- ---------------------------------------------------------------------
-- 0110 — "New job like one you saved"
--
-- A candidate who saves a job is saying "this kind of job". When another
-- job of that kind is published, they are told: an entry in their
-- TeamLink inbox and an email naming the saved job it relates to.
--
--   candidate_saved_job_alert_settings   the candidate's switch ("Tell me
--                                        about similar new jobs", ON unless
--                                        they turn it off)
--   candidate_saved_job_alerts           one row per (candidate, new job):
--                                        what was decided, why, and what
--                                        each channel answered. The primary
--                                        key is the "never twice" guard.
--   saved_job_alert_jobs                 which publications the engine has
--                                        processed, so the sweep only looks
--                                        at what the publish hook missed
--   candidate_new_job_notices            SHARED by every "new job for you"
--                                        message: profile-match job alerts
--                                        (0017), saved-search alerts (0086),
--                                        urgent hiring (0095) and this one.
--                                        One row per (candidate, job); the
--                                        first system to claim it is the
--                                        only one that speaks.
--
-- PRIVACY. Like saved searches (0086), what somebody saved is theirs: a
-- candidate reads their own rows; staff have no policy on these tables.
-- The engine (role admin, no user id - saved_search_engine_ok()) is the
-- only writer, apart from the candidate's own switch.
-- ---------------------------------------------------------------------

/* ===================================================================== *
 * 1. the switch
 * ===================================================================== */
create table if not exists candidate_saved_job_alert_settings (
  candidate_id  text primary key references candidates(id) on delete cascade,
  enabled       boolean not null default true,
  -- 'page' (the Saved Jobs toggle) or 'email_link' (the unsubscribe link)
  changed_via   text not null default 'page' check (changed_via in ('page', 'email_link')),
  updated_at    timestamptz not null default now()
);

/* ===================================================================== *
 * 2. what was decided for each (candidate, new job)
 * ===================================================================== */
create table if not exists candidate_saved_job_alerts (
  candidate_id    text not null references candidates(id) on delete cascade,
  job_id          text not null references jobs(id) on delete cascade,   -- the NEW job
  saved_job_id    text references jobs(id) on delete set null,           -- the saved one it is like
  reason          text,            -- 'same role' / 'similar role' / 'shared skills'
  -- instant: told on publish. digest: over the day's cap, so it waits for
  -- the evening summary.
  kind            text not null check (kind in ('instant', 'digest')),
  -- sending -> sent | failed      (instant)
  -- queued  -> sending -> sent    (digest)
  -- skipped                       (told by another alert, do-not-contact,
  --                                switched off, no longer open, ...)
  status          text not null check (status in ('sending', 'queued', 'sent', 'failed', 'skipped')),
  skip_reason     text,
  day             date not null,   -- the IST day it counts against the cap
  notification_id text,            -- the inbox entry
  email_status    text,            -- sent / failed / not_configured / skipped_* - the provider's own answer
  email_ref       text,
  email_error     text,
  created_at      timestamptz not null default now(),
  sent_at         timestamptz,
  primary key (candidate_id, job_id)
);

create index if not exists saved_job_alerts_day
  on candidate_saved_job_alerts (candidate_id, day) where kind = 'instant';
create index if not exists saved_job_alerts_queued
  on candidate_saved_job_alerts (created_at) where status = 'queued';

/* ===================================================================== *
 * 3. publications the engine has processed
 * ===================================================================== */
create table if not exists saved_job_alert_jobs (
  job_id        text primary key references jobs(id) on delete cascade,
  published_at  timestamptz not null,      -- the publication that was processed
  processed_at  timestamptz not null default now(),
  candidates    int not null default 0     -- how many were told or queued
);

/* ===================================================================== *
 * 4. the shared ledger: one "new job for you" message per candidate per job
 * ===================================================================== */
create table if not exists candidate_new_job_notices (
  candidate_id  text not null references candidates(id) on delete cascade,
  job_id        text not null references jobs(id) on delete cascade,
  source        text not null check (source in ('profile_match', 'saved_search', 'urgent_hiring', 'saved_job')),
  created_at    timestamptz not null default now(),
  primary key (candidate_id, job_id)
);

/* What the alerts sent before this ledger existed counts too. */
insert into candidate_new_job_notices (candidate_id, job_id, source, created_at)
select m.candidate_id, m.job_id, 'profile_match', coalesce(m.notified_at, m.matched_at)
  from job_matches m where m.notified
on conflict do nothing;

insert into candidate_new_job_notices (candidate_id, job_id, source, created_at)
select l.candidate_id, l.job_id, 'urgent_hiring', min(coalesce(l.sent_at, l.created_at))
  from notification_log l
 where l.event_type = 'urgent_hiring' and l.status = 'sent'
   and l.candidate_id is not null and l.job_id is not null
 group by l.candidate_id, l.job_id
on conflict do nothing;

insert into candidate_new_job_notices (candidate_id, job_id, source, created_at)
select d.candidate_id, x.job_id, 'saved_search', min(d.created_at)
  from candidate_saved_search_deliveries d
  cross join lateral unnest(d.job_ids) as x(job_id)
 where d.status = 'sent' and exists (select 1 from jobs j where j.id = x.job_id)
 group by d.candidate_id, x.job_id
on conflict do nothing;

/* ===================================================================== *
 * row level security
 * ===================================================================== */
alter table candidate_saved_job_alert_settings enable row level security;
alter table candidate_saved_job_alerts         enable row level security;
alter table saved_job_alert_jobs               enable row level security;
alter table candidate_new_job_notices          enable row level security;

do $$
begin
  /* The candidate's own switch; the engine reads it (and the email's
     unsubscribe link, verified by the API, turns it off as the engine). */
  if not exists (select 1 from pg_policies where tablename = 'candidate_saved_job_alert_settings'
                  and policyname = 'saved_job_alert_settings_own') then
    create policy saved_job_alert_settings_own on candidate_saved_job_alert_settings for all
      using (candidate_id = app_candidate_id() or saved_search_engine_ok())
      with check (candidate_id = app_candidate_id() or saved_search_engine_ok());
  end if;

  if not exists (select 1 from pg_policies where tablename = 'candidate_saved_job_alerts'
                  and policyname = 'saved_job_alerts_read') then
    create policy saved_job_alerts_read on candidate_saved_job_alerts for select
      using (candidate_id = app_candidate_id() or saved_search_engine_ok());
  end if;
  if not exists (select 1 from pg_policies where tablename = 'candidate_saved_job_alerts'
                  and policyname = 'saved_job_alerts_engine') then
    create policy saved_job_alerts_engine on candidate_saved_job_alerts for all
      using (saved_search_engine_ok()) with check (saved_search_engine_ok());
  end if;

  if not exists (select 1 from pg_policies where tablename = 'saved_job_alert_jobs'
                  and policyname = 'saved_job_alert_jobs_engine') then
    create policy saved_job_alert_jobs_engine on saved_job_alert_jobs for all
      using (saved_search_engine_ok()) with check (saved_search_engine_ok());
  end if;

  if not exists (select 1 from pg_policies where tablename = 'candidate_new_job_notices'
                  and policyname = 'new_job_notices_engine') then
    create policy new_job_notices_engine on candidate_new_job_notices for select
      using (saved_search_engine_ok());
  end if;
end $$;

/* ===================================================================== *
 * the engine's functions
 * ===================================================================== */

/**
 * Claim the one "new job for you" message for (candidate, job).
 * True only for the caller that created the row: anybody else - another
 * alert system, or a second run of the same one - is told no, and must
 * not send.
 */
create or replace function new_job_notice_claim(p_candidate text, p_job text, p_source text)
returns boolean
language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  perform saved_search_engine_guard();
  insert into candidate_new_job_notices (candidate_id, job_id, source)
  values (p_candidate, p_job, p_source)
  on conflict do nothing;
  get diagnostics v_n = row_count;
  return v_n > 0;
end $$;

/**
 * Give a claim back: the message it was for reached nobody (every channel
 * skipped, opted out or not configured), so another alert may still try.
 * Only the source that holds it can release it.
 */
create or replace function new_job_notice_release(p_candidate text, p_job text, p_source text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  perform saved_search_engine_guard();
  delete from candidate_new_job_notices
   where candidate_id = p_candidate and job_id = p_job and source = p_source;
end $$;

/**
 * Decide, atomically, what happens to one (candidate, new job):
 *
 *   null     already decided before (the "never twice" guard)
 *   'told'   another alert already told them about this job - recorded
 *            as skipped, nothing is sent
 *   'instant'  under today's cap: send now (row is 'sending')
 *   'digest'   over today's cap: queued for the evening summary
 *
 * A per-candidate advisory lock makes the count and the insert one step,
 * so two publishes at the same moment cannot both be "the third today".
 */
create or replace function saved_job_alert_claim(
  p_candidate text, p_job text, p_saved_job text, p_reason text, p_day date, p_cap int
) returns text
language plpgsql security definer set search_path = public as $$
declare v_n int; v_kind text; v_told text;
begin
  perform saved_search_engine_guard();
  perform pg_advisory_xact_lock(hashtext('saved_job_alert:' || p_candidate));

  if exists (select 1 from candidate_saved_job_alerts
              where candidate_id = p_candidate and job_id = p_job) then
    return null;
  end if;

  insert into candidate_new_job_notices (candidate_id, job_id, source)
  values (p_candidate, p_job, 'saved_job')
  on conflict do nothing;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    select source into v_told from candidate_new_job_notices
     where candidate_id = p_candidate and job_id = p_job;
    insert into candidate_saved_job_alerts
      (candidate_id, job_id, saved_job_id, reason, kind, status, skip_reason, day)
    values (p_candidate, p_job, p_saved_job, p_reason, 'instant', 'skipped',
            'already told by ' || coalesce(v_told, 'another alert'), p_day);
    return 'told';
  end if;

  select count(*) into v_n from candidate_saved_job_alerts
   where candidate_id = p_candidate and day = p_day and kind = 'instant'
     and status in ('sending', 'sent');
  v_kind := case when v_n < greatest(coalesce(p_cap, 3), 0) then 'instant' else 'digest' end;

  insert into candidate_saved_job_alerts
    (candidate_id, job_id, saved_job_id, reason, kind, status, day)
  values (p_candidate, p_job, p_saved_job, p_reason, v_kind,
          case when v_kind = 'instant' then 'sending' else 'queued' end, p_day);
  return v_kind;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant select, insert, update on candidate_saved_job_alert_settings to app_api;
    grant select, insert, update on candidate_saved_job_alerts to app_api;
    grant select, insert, update on saved_job_alert_jobs to app_api;
    grant select on candidate_new_job_notices to app_api;
    grant execute on function new_job_notice_claim(text, text, text) to app_api;
    grant execute on function new_job_notice_release(text, text, text) to app_api;
    grant execute on function saved_job_alert_claim(text, text, text, text, date, int) to app_api;
  end if;
end $$;

/* ===================================================================== *
 * Notification Settings lists one row per template: these make the two
 * messages appear there, so an EmailJS template id can be attached.
 * ===================================================================== */
insert into notification_templates (event_key, label, fires_on) values
  ('saved_job_alert',  'Saved Job — Similar New Job', array['SAVED_JOB_ALERT']),
  ('saved_job_digest', 'Saved Job — Daily Digest',    array['SAVED_JOB_DIGEST'])
on conflict (event_key) do nothing;

comment on table candidate_saved_job_alerts is
  'One row per (candidate, new job) for "New job like one you saved" (0110): instant or digest, why, and each channel''s answer. The primary key is the never-twice guard.';
comment on table candidate_new_job_notices is
  'Shared by every "new job for you" alert (profile match, saved search, urgent hiring, saved job): the first to claim (candidate, job) is the only one that sends (0110).';
