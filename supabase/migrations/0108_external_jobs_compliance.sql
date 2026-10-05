-- ---------------------------------------------------------------------
-- 0108 — external jobs: licences, quality, health, audit and analytics
--
-- The external-jobs layer (0049 … 0088) collects, stores, lists and
-- redirects. What it could not do is say WHY a source is allowed to be
-- collected from, what happened to a posting that failed validation, when
-- a stored link changed, whether a source is healthy, who changed what, or
-- how many candidates actually went where. This file adds exactly those
-- records, and nothing that duplicates the job table:
--
--   job_sources (+columns)        provider identity, the per-source
--                                 configuration (allowed domains, sync
--                                 interval, rate limit, close grace period)
--                                 and health counters
--   external_source_licences      collection method, licence and consent,
--                                 terms, permissions, effective window, owner
--   external_job_quarantine       postings that failed validation, and why
--   external_job_url_changes      every change of a stored application URL
--   external_audit_log            who did what to a source, licence or job
--   external_job_events           external_job_view / external_apply_click /
--                                 external_redirect_success / _failure,
--                                 daily counts, no personal data
--   external_saved_jobs           a candidate's saved external postings
--
-- ADDITIVE ONLY. No existing column is dropped or renamed, no existing
-- function changes its signature or its behaviour. The status check on
-- external_jobs is WIDENED (one new value, 'archived'), never narrowed.
--
-- GREENHOUSE. Nothing here changes what the Greenhouse connector collects,
-- how it is stored or where Apply Now sends a candidate. The activation
-- guard treats Greenhouse, Lever and Remotive as the documented public
-- board APIs they are (no licence record needed), and every new column is
-- null or defaulted so an existing source behaves exactly as before. This
-- is proved by api/test/external-greenhouse-snapshot.test.mjs.
--
-- NO CREDENTIAL IS STORED. A source still records only the NAME of the
-- environment variable that holds its key.
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- 1. job_sources: identity, configuration, health
-- ---------------------------------------------------------------------
alter table job_sources
  /* Which board this source IS, independent of how it is collected: a
     Naukri partner feed is provider 'naukri' with method 'feed'. */
  add column if not exists provider text,
  add column if not exists disabled_reason text,
  add column if not exists disabled_at timestamptz,
  /* Centralised per-source configuration. Null = the deployment default
     (api/src/external/source-config.js). */
  add column if not exists allowed_domains text[],
  add column if not exists sync_interval_hours int,
  add column if not exists rate_limit_per_minute int,
  add column if not exists close_grace_days int,
  /* Health. */
  add column if not exists last_attempt_at timestamptz,
  add column if not exists last_success_at timestamptz,
  add column if not exists success_count int not null default 0,
  add column if not exists failure_count int not null default 0,
  add column if not exists consecutive_failures int not null default 0,
  add column if not exists avg_sync_ms numeric,
  add column if not exists open_job_count int,
  add column if not exists health_status text not null default 'unknown',
  add column if not exists next_sync_after timestamptz;

alter table job_sources drop constraint if exists job_sources_provider_check;
alter table job_sources add constraint job_sources_provider_check check (provider is null or provider in (
  'naukri', 'indeed', 'shine', 'linkedin', 'greenhouse', 'lever', 'remotive',
  'adzuna', 'jooble', 'jsearch', 'serpapi', 'other'));
alter table job_sources drop constraint if exists job_sources_health_check;
alter table job_sources add constraint job_sources_health_check
  check (health_status in ('unknown', 'healthy', 'degraded', 'unhealthy'));
alter table job_sources drop constraint if exists job_sources_config_check;
alter table job_sources add constraint job_sources_config_check check (
      (sync_interval_hours is null or sync_interval_hours between 1 and 720)
  and (rate_limit_per_minute is null or rate_limit_per_minute between 1 and 600)
  and (close_grace_days is null or close_grace_days between 1 and 365));

/* Which board a source is, from what it says about itself. A partner brand
   named anywhere wins over 'other', so a feed cannot dodge the licence
   rule by being called something vague. */
create or replace function external_source_brand(p_connector text, p_name text, p_feed_url text)
returns text language sql immutable as $$
  select case
    when lower(coalesce(p_connector, '')) in ('naukri', 'indeed', 'shine', 'linkedin', 'greenhouse',
         'lever', 'remotive', 'adzuna', 'jooble', 'jsearch', 'serpapi') then lower(p_connector)
    when coalesce(p_name, '') || ' ' || coalesce(p_feed_url, '') ~* '(^|[^a-z])naukri' then 'naukri'
    when coalesce(p_name, '') || ' ' || coalesce(p_feed_url, '') ~* '(^|[^a-z])indeed' then 'indeed'
    when coalesce(p_name, '') || ' ' || coalesce(p_feed_url, '') ~* '(^|[^a-z])linkedin' then 'linkedin'
    when coalesce(p_name, '') ~* '(^|[^a-z])shine([^a-z]|$)'
      or coalesce(p_feed_url, '') ~* '(^|[/.])shine\.com' then 'shine'
    else 'other' end
$$;

update job_sources
   set provider = external_source_brand(connector, name, feed_url)
 where provider is null;

/* What the last sync said, carried into the health columns once. */
update job_sources
   set last_attempt_at = coalesce(last_attempt_at, last_sync_at),
       last_success_at = coalesce(last_success_at,
         case when last_sync_status in ('ok', 'partial') then last_sync_at end),
       health_status = case when last_sync_status in ('ok', 'partial') then 'healthy'
                            when last_sync_status is null or last_sync_status = 'manual' then 'unknown'
                            else 'degraded' end
 where last_attempt_at is null and last_sync_at is not null;

-- ---------------------------------------------------------------------
-- 2. licences and consent
-- ---------------------------------------------------------------------
create table if not exists external_source_licences (
  source_id                    text primary key references job_sources(id) on delete cascade,
  /* How the data is collected, in words an auditor can check:
     public_api, licensed_api, partner_feed, employer_feed, manual_entry. */
  collection_method            text not null default 'public_api'
    check (collection_method in ('public_api', 'licensed_api', 'partner_feed', 'employer_feed', 'manual_entry')),
  licence_status               text not null default 'pending'
    check (licence_status in ('not_required', 'pending', 'active', 'expired', 'revoked')),
  consent_status               text not null default 'pending'
    check (consent_status in ('not_required', 'pending', 'granted', 'withdrawn')),
  terms_url                    text,
  data_usage_allowed           boolean not null default false,
  application_redirect_allowed boolean not null default false,
  effective_from               date,
  effective_until              date,
  owner                        text,
  notes                        text,
  updated_by                   text,
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now(),
  check (effective_until is null or effective_from is null or effective_until >= effective_from),
  check (terms_url is null or terms_url ~* '^https?://')
);

alter table external_source_licences enable row level security;
alter table external_source_licences force  row level security;
drop policy if exists xlic_read on external_source_licences;
create policy xlic_read on external_source_licences for select
  using (app_is_admin() or app_role() in ('recruiter', 'bde'));
revoke insert, update, delete on external_source_licences from app_api;

/*
 * Why this source may NOT be switched on, or null when it may.
 *
 *   Naukri, Indeed, Shine, LinkedIn   no public API exists. Only a licensed
 *                                     partner/employer feed ('feed'/'api'
 *                                     method, never the 'connector') with a
 *                                     complete licence record.
 *   Adzuna, Jooble, JSearch, SerpApi  keyed commercial APIs: a complete
 *                                     licence record (their terms).
 *   other feed / api                  a complete licence record.
 *   Greenhouse, Lever, Remotive,      documented public APIs / hand entry:
 *   other manual                      no record needed.
 *
 * And for ANY source: a licence recorded as expired or revoked, consent
 * withdrawn, or an effective window that has ended, blocks it.
 */
create or replace function external_licence_gap_for(
  p_source_id text, p_provider text, p_method text
) returns text
language plpgsql stable security definer set search_path = public as $$
declare
  l external_source_licences;
  has_l boolean;
  brand text := coalesce(p_provider, 'other');
  label text := case coalesce(p_provider, 'other')
    when 'naukri' then 'Naukri' when 'indeed' then 'Indeed' when 'shine' then 'Shine'
    when 'linkedin' then 'LinkedIn' when 'adzuna' then 'Adzuna' when 'jooble' then 'Jooble'
    when 'jsearch' then 'JSearch' when 'serpapi' then 'SerpApi' else 'This source' end;
  missing text[] := '{}';
begin
  select * into l from external_source_licences where source_id = p_source_id;
  has_l := found;

  if has_l and l.licence_status in ('expired', 'revoked') then
    return format('the licence recorded for this source is %s', l.licence_status);
  end if;
  if has_l and l.consent_status = 'withdrawn' then
    return 'consent recorded for this source has been withdrawn';
  end if;
  if has_l and l.effective_until is not null and l.effective_until < current_date then
    return format('the licence for this source expired on %s', to_char(l.effective_until, 'YYYY-MM-DD'));
  end if;

  if brand in ('naukri', 'indeed', 'shine', 'linkedin') and coalesce(p_method, '') = 'connector' then
    return format('%s has no authorized API connected to TeamLink. It needs a licensed partner or '
      || 'employer feed (collection method "feed" or "api") and a recorded licence before it can be switched on.', label);
  end if;

  if brand in ('naukri', 'indeed', 'shine', 'linkedin', 'adzuna', 'jooble', 'jsearch', 'serpapi')
     or (brand = 'other' and coalesce(p_method, '') in ('feed', 'api', 'connector')) then
    if not has_l then
      return format('%s needs a licence record (terms, owner, data-usage and redirect permission) before it can be switched on.', label);
    end if;
    if l.licence_status <> 'active' then missing := array_append(missing, 'licence status "active"'::text); end if;
    if l.consent_status not in ('granted', 'not_required') then missing := array_append(missing, 'consent "granted"'::text); end if;
    if coalesce(btrim(l.terms_url), '') = '' then missing := array_append(missing, 'terms URL'::text); end if;
    if coalesce(btrim(l.owner), '') = '' then missing := array_append(missing, 'owner'::text); end if;
    if not l.data_usage_allowed then missing := array_append(missing, 'data-usage permission'::text); end if;
    if not l.application_redirect_allowed then missing := array_append(missing, 'application-redirect permission'::text); end if;
    if l.effective_from is not null and l.effective_from > current_date then
      missing := array_append(missing, format('an effective date that has started (it starts %s)', to_char(l.effective_from, 'YYYY-MM-DD'))::text);
    end if;
    if array_length(missing, 1) > 0 then
      return format('%s cannot be switched on: the licence record is missing %s.', label, array_to_string(missing, ', '));
    end if;
  end if;
  return null;
end $$;

create or replace function external_source_licence_gap(p_source_id text) returns text
language sql stable security definer set search_path = public as $$
  select case when s.id is null then 'no such source'
              else external_licence_gap_for(s.id, s.provider, s.job_collection_method) end
    from (select 1) one left join job_sources s on s.id = p_source_id
$$;

/* Provider inference, the activation guard and updated_at, on every write
   to job_sources - including the definer functions 0049/0063 already use,
   so no path can switch an unlicensed source on. */
create or replace function job_sources_before_write() returns trigger
language plpgsql security definer set search_path = public as $$
declare gap text;
begin
  if new.provider is null or new.provider = 'other' then
    new.provider := external_source_brand(new.connector, new.name, new.feed_url);
  end if;
  if tg_op = 'UPDATE' then new.updated_at := now(); end if;

  /* Checked when a source is switched on, and when an active source
     changes what it is or how it is collected. */
  if new.active and (tg_op = 'INSERT' or old.active is distinct from true
                     or old.provider is distinct from new.provider
                     or old.job_collection_method is distinct from new.job_collection_method
                     or old.connector is distinct from new.connector) then
    gap := external_licence_gap_for(new.id, new.provider, new.job_collection_method);
    if gap is not null then
      raise exception 'licence_required: %', gap using errcode = 'P0001';
    end if;
    new.disabled_reason := null;
    new.disabled_at := null;
  end if;
  if tg_op = 'UPDATE' and old.active and not new.active and new.disabled_at is null then
    new.disabled_at := now();
  end if;
  return new;
end $$;

drop trigger if exists job_sources_before_write on job_sources;
create trigger job_sources_before_write before insert or update on job_sources
  for each row execute function job_sources_before_write();

-- ---------------------------------------------------------------------
-- 3. the audit trail
--
-- Written by triggers and definer functions only; nobody can edit it,
-- including an administrator (app_api holds no write grant on it).
-- ---------------------------------------------------------------------
create table if not exists external_audit_log (
  id          bigserial primary key,
  at          timestamptz not null default now(),
  actor_id    text,
  actor_role  text,
  action      text not null,
  entity      text not null,
  entity_id   text,
  old_value   jsonb,
  new_value   jsonb,
  reason      text
);
create index if not exists xaudit_at_idx on external_audit_log (at desc);
create index if not exists xaudit_entity_idx on external_audit_log (entity, entity_id, at desc);

alter table external_audit_log enable row level security;
alter table external_audit_log force  row level security;
drop policy if exists xaudit_read on external_audit_log;
create policy xaudit_read on external_audit_log for select using (app_is_admin());
revoke insert, update, delete on external_audit_log from app_api;

create or replace function external_audit_add(
  p_action text, p_entity text, p_entity_id text,
  p_old jsonb, p_new jsonb, p_reason text
) returns bigint
language plpgsql security definer set search_path = public as $$
declare v bigint;
begin
  insert into external_audit_log (actor_id, actor_role, action, entity, entity_id, old_value, new_value, reason)
  values (nullif(current_setting('app.user_id', true), ''),
          coalesce(nullif(current_setting('app.role', true), ''), 'system'),
          p_action, p_entity, p_entity_id, p_old, p_new, left(p_reason, 500))
  returning id into v;
  return v;
end $$;

/* The configuration a source is judged by - never a credential value
   (credential_env is the NAME of a variable). */
create or replace function external_source_config_json(s job_sources) returns jsonb
language sql immutable as $$
  select jsonb_build_object(
    'name', s.name, 'provider', s.provider, 'sourceType', s.source_type,
    'collectionMethod', s.job_collection_method, 'connector', s.connector,
    'applicationMethod', s.application_method, 'autoApplySupported', s.auto_apply_supported,
    'active', s.active, 'feedUrl', s.feed_url, 'credentialEnv', s.credential_env,
    'allowedDomains', s.allowed_domains, 'syncIntervalHours', s.sync_interval_hours,
    'rateLimitPerMinute', s.rate_limit_per_minute, 'closeGraceDays', s.close_grace_days,
    'monthlyQuota', s.monthly_quota, 'disabledReason', s.disabled_reason)
$$;

create or replace function job_sources_audit() returns trigger
language plpgsql security definer set search_path = public as $$
declare o jsonb; n jsonb; act text;
begin
  if tg_op = 'INSERT' then
    perform external_audit_add('source.create', 'source', new.id, null, external_source_config_json(new), null);
    return null;
  elsif tg_op = 'DELETE' then
    perform external_audit_add('source.delete', 'source', old.id, external_source_config_json(old), null, null);
    return null;
  end if;
  o := external_source_config_json(old);
  n := external_source_config_json(new);
  if o = n then return null; end if;
  act := case when old.active is distinct from new.active
              then case when new.active then 'source.activate' else 'source.deactivate' end
              else 'source.config_change' end;
  perform external_audit_add(act, 'source', new.id, o, n, new.disabled_reason);
  return null;
end $$;

drop trigger if exists job_sources_audit on job_sources;
create trigger job_sources_audit after insert or update or delete on job_sources
  for each row execute function job_sources_audit();

create or replace function external_source_licences_audit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    perform external_audit_add('licence.delete', 'licence', old.source_id, to_jsonb(old), null, null);
  else
    perform external_audit_add(case when tg_op = 'INSERT' then 'licence.create' else 'licence.change' end,
      'licence', new.source_id, case when tg_op = 'UPDATE' then to_jsonb(old) end, to_jsonb(new), null);
  end if;
  return null;
end $$;

drop trigger if exists external_source_licences_audit on external_source_licences;
create trigger external_source_licences_audit after insert or update or delete on external_source_licences
  for each row execute function external_source_licences_audit();

/* Record or update a source's licence. Administrators only. */
create or replace function external_source_licence_save(
  p_source_id text, p_collection_method text, p_licence_status text, p_consent_status text,
  p_terms_url text, p_data_usage_allowed boolean, p_application_redirect_allowed boolean,
  p_effective_from date, p_effective_until date, p_owner text, p_notes text
) returns external_source_licences
language plpgsql security definer set search_path = public as $$
declare out_row external_source_licences;
begin
  if not app_is_admin() then
    raise exception 'only an administrator can record a licence' using errcode = '42501';
  end if;
  insert into external_source_licences (source_id, collection_method, licence_status, consent_status,
      terms_url, data_usage_allowed, application_redirect_allowed, effective_from, effective_until,
      owner, notes, updated_by)
  values (p_source_id, p_collection_method, p_licence_status, p_consent_status, nullif(btrim(p_terms_url), ''),
      coalesce(p_data_usage_allowed, false), coalesce(p_application_redirect_allowed, false),
      p_effective_from, p_effective_until, nullif(btrim(p_owner), ''), nullif(btrim(p_notes), ''),
      nullif(current_setting('app.user_id', true), ''))
  on conflict (source_id) do update set
      collection_method = excluded.collection_method,
      licence_status = excluded.licence_status,
      consent_status = excluded.consent_status,
      terms_url = excluded.terms_url,
      data_usage_allowed = excluded.data_usage_allowed,
      application_redirect_allowed = excluded.application_redirect_allowed,
      effective_from = excluded.effective_from,
      effective_until = excluded.effective_until,
      owner = excluded.owner,
      notes = excluded.notes,
      updated_by = excluded.updated_by,
      updated_at = now()
  returning * into out_row;
  return out_row;
end $$;

/* Configuration that is not part of external_source_save's signature.
   Administrators only; audited by the job_sources trigger. */
create or replace function external_source_config_save(
  p_source_id text, p_provider text, p_allowed_domains text[], p_sync_interval_hours int,
  p_rate_limit_per_minute int, p_close_grace_days int, p_monthly_quota int
) returns job_sources
language plpgsql security definer set search_path = public as $$
declare out_row job_sources;
begin
  if not app_is_admin() then
    raise exception 'only an administrator can change a source' using errcode = '42501';
  end if;
  update job_sources
     set provider = coalesce(p_provider, provider),
         allowed_domains = case when p_allowed_domains is null or array_length(p_allowed_domains, 1) is null
                                then null else p_allowed_domains end,
         sync_interval_hours = p_sync_interval_hours,
         rate_limit_per_minute = p_rate_limit_per_minute,
         close_grace_days = p_close_grace_days,
         monthly_quota = p_monthly_quota
   where id = p_source_id
  returning * into out_row;
  return out_row;
end $$;

/* Switch a source off with the reason on record. Its jobs and history
   stay; the portal stops showing them because the source is inactive. */
create or replace function external_source_disable(p_source_id text, p_reason text) returns boolean
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update job_sources set active = false, disabled_reason = left(p_reason, 300), disabled_at = now()
   where id = p_source_id and active;
  get diagnostics n = row_count;
  return n > 0;
end $$;

/* The scheduled sweep: a source whose licence has expired, been revoked
   or had consent withdrawn is switched off, with the reason. Engine or
   administrator only. Returns the sources it disabled. */
create or replace function external_sources_enforce_licences()
returns table (source_id text, reason text)
language plpgsql security definer set search_path = public as $$
declare r record; gap text;
begin
  if not app_is_admin() then return; end if;
  for r in select s.id, s.provider, s.job_collection_method
             from job_sources s join external_source_licences l on l.source_id = s.id
            where s.active
              and (l.licence_status in ('expired', 'revoked') or l.consent_status = 'withdrawn'
                   or (l.effective_until is not null and l.effective_until < current_date)) loop
    gap := external_licence_gap_for(r.id, r.provider, r.job_collection_method);
    update job_sources set active = false, disabled_reason = left('licence: ' || coalesce(gap, 'not valid'), 300),
           disabled_at = now() where id = r.id;
    source_id := r.id; reason := gap;
    return next;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 4. external_jobs: content hash, admin hold, audit, URL changes
-- ---------------------------------------------------------------------
alter table external_jobs drop constraint if exists external_jobs_status_check;
alter table external_jobs add constraint external_jobs_status_check
  check (status in ('open', 'closed', 'expired', 'removed', 'archived'));

alter table external_jobs
  add column if not exists content_hash text,
  /* A status an administrator set (closed / removed / archived). A re-sync
     cannot silently reopen a posting somebody deliberately took down. */
  add column if not exists admin_hold text
    check (admin_hold is null or admin_hold in ('closed', 'removed', 'archived', 'expired'));

create index if not exists external_jobs_updated_idx on external_jobs (updated_at desc);
create index if not exists external_jobs_source_status_idx on external_jobs (source_id, status);
create index if not exists external_jobs_seen_idx on external_jobs (source_id, synced_at) where status = 'open';

create or replace function external_job_content_hash(j external_jobs) returns text
language sql immutable as $$
  select md5(concat_ws(chr(31), j.title, j.company, j.location, j.description, j.experience,
    j.salary, j.employment_type, j.education, array_to_string(j.skills, chr(30)), j.application_url))
$$;

create or replace function external_jobs_before_write() returns trigger
language plpgsql as $$
begin
  if new.admin_hold is not null then new.status := new.admin_hold; end if;
  new.content_hash := external_job_content_hash(new);
  if tg_op = 'UPDATE' then new.updated_at := now(); end if;
  return new;
end $$;

drop trigger if exists external_jobs_before_write on external_jobs;
create trigger external_jobs_before_write before insert or update on external_jobs
  for each row execute function external_jobs_before_write();

update external_jobs set content_hash = external_job_content_hash(external_jobs) where content_hash is null;

create table if not exists external_job_url_changes (
  id                bigserial primary key,
  external_job_id   text not null references external_jobs(id) on delete cascade,
  source_id         text not null references job_sources(id) on delete cascade,
  old_url           text,
  new_url           text,
  detected_at       timestamptz not null default now(),
  /* Was the new URL validated, and was it put into use? A change a sync
     refused is recorded with applied = false and the old URL kept. */
  new_url_valid     boolean,
  validation_reason text,
  applied           boolean not null default true
);
create index if not exists xurlchg_job_idx on external_job_url_changes (external_job_id, detected_at desc);
create index if not exists xurlchg_at_idx on external_job_url_changes (detected_at desc);

alter table external_job_url_changes enable row level security;
alter table external_job_url_changes force  row level security;
drop policy if exists xurlchg_read on external_job_url_changes;
create policy xurlchg_read on external_job_url_changes for select
  using (app_is_admin() or app_role() in ('recruiter', 'bde'));
revoke insert, update, delete on external_job_url_changes from app_api;

create or replace function external_jobs_audit() returns trigger
language plpgsql security definer set search_path = public as $$
declare changed text[] := '{}';
begin
  if tg_op = 'INSERT' then
    perform external_audit_add('job.create', 'external_job', new.id, null,
      jsonb_build_object('sourceId', new.source_id, 'sourceJobId', new.external_job_id,
                         'title', new.title, 'status', new.status, 'url', new.application_url), null);
    return null;
  elsif tg_op = 'DELETE' then
    perform external_audit_add('job.delete', 'external_job', old.id,
      jsonb_build_object('sourceId', old.source_id, 'sourceJobId', old.external_job_id,
                         'title', old.title, 'status', old.status), null, null);
    return null;
  end if;

  if old.application_url is distinct from new.application_url then
    insert into external_job_url_changes (external_job_id, source_id, old_url, new_url, applied)
    values (new.id, new.source_id, old.application_url, new.application_url, true);
    perform external_audit_add('job.url_change', 'external_job', new.id,
      jsonb_build_object('url', old.application_url), jsonb_build_object('url', new.application_url), null);
  end if;
  if old.status is distinct from new.status then
    perform external_audit_add(
      case when new.status = 'open' then 'job.reopen'
           when new.status in ('closed', 'expired') then 'job.close'
           else 'job.status_change' end,
      'external_job', new.id, jsonb_build_object('status', old.status),
      jsonb_build_object('status', new.status, 'adminHold', new.admin_hold), null);
  end if;
  if old.content_hash is distinct from new.content_hash then
    if old.title is distinct from new.title then changed := array_append(changed, 'title'); end if;
    if old.company is distinct from new.company then changed := array_append(changed, 'company'); end if;
    if old.location is distinct from new.location then changed := array_append(changed, 'location'); end if;
    if old.description is distinct from new.description then changed := array_append(changed, 'description'); end if;
    if old.salary is distinct from new.salary then changed := array_append(changed, 'salary'); end if;
    if old.skills is distinct from new.skills then changed := array_append(changed, 'skills'); end if;
    if old.experience is distinct from new.experience then changed := array_append(changed, 'experience'); end if;
    if old.employment_type is distinct from new.employment_type then changed := array_append(changed, 'employmentType'); end if;
    if old.education is distinct from new.education then changed := array_append(changed, 'education'); end if;
    if array_length(changed, 1) > 0 then
      perform external_audit_add('job.update', 'external_job', new.id,
        jsonb_build_object('title', old.title, 'fields', to_jsonb(changed)),
        jsonb_build_object('title', new.title, 'fields', to_jsonb(changed)), null);
    end if;
  end if;
  return null;
end $$;

drop trigger if exists external_jobs_audit on external_jobs;
create trigger external_jobs_audit after insert or update or delete on external_jobs
  for each row execute function external_jobs_audit();

/* What the sync knows about a URL it applied, or refused to apply. */
create or replace function external_job_url_change_note(
  p_external_job_id text, p_new_url text, p_valid boolean, p_reason text, p_applied boolean, p_old_url text
) returns void
language plpgsql security definer set search_path = public as $$
declare v_source text; v_id bigint;
begin
  select source_id into v_source from external_jobs where id = p_external_job_id;
  if v_source is null then return; end if;
  if p_applied then
    select id into v_id from external_job_url_changes
     where external_job_id = p_external_job_id and new_url is not distinct from p_new_url and applied
     order by detected_at desc, id desc limit 1;
    if v_id is not null then
      update external_job_url_changes set new_url_valid = p_valid, validation_reason = left(p_reason, 300)
       where id = v_id;
      return;
    end if;
  end if;
  insert into external_job_url_changes (external_job_id, source_id, old_url, new_url, new_url_valid,
                                        validation_reason, applied)
  values (p_external_job_id, v_source, p_old_url, p_new_url, p_valid, left(p_reason, 300), coalesce(p_applied, false));
  if not coalesce(p_applied, false) then
    perform external_audit_add('job.url_change_refused', 'external_job', p_external_job_id,
      jsonb_build_object('url', p_old_url), jsonb_build_object('url', p_new_url), p_reason);
  end if;
end $$;

/* The stored URL and status of every posting of one source, so a sync can
   see what a posting looked like before it is overwritten. */
create or replace function external_jobs_known(p_source_id text)
returns table (id text, external_job_id text, application_url text, status text)
language sql stable security definer set search_path = public as $$
  select j.id, j.external_job_id, j.application_url, j.status
    from external_jobs j where j.source_id = p_source_id
$$;

-- ---------------------------------------------------------------------
-- 5. quarantine
-- ---------------------------------------------------------------------
create table if not exists external_job_quarantine (
  id               bigserial primary key,
  source_id        text not null references job_sources(id) on delete cascade,
  /* The source's own id, or a hash of title + URL when it sent none. */
  fingerprint      text not null,
  external_job_id  text,
  title            text,
  company          text,
  application_url  text,
  reasons          text[] not null default '{}',
  /* 'quarantined': the posting was not stored. 'kept': recorded for the
     administrator, the posting still stored (sources whose behaviour is
     preserved unchanged, i.e. Greenhouse). */
  action           text not null default 'quarantined' check (action in ('quarantined', 'kept')),
  raw              jsonb not null default '{}',
  first_seen_at    timestamptz not null default now(),
  last_seen_at     timestamptz not null default now(),
  times_seen       int not null default 1,
  resolved_at      timestamptz,
  unique (source_id, fingerprint)
);
create index if not exists xquar_open_idx on external_job_quarantine (last_seen_at desc) where resolved_at is null;

alter table external_job_quarantine enable row level security;
alter table external_job_quarantine force  row level security;
drop policy if exists xquar_read on external_job_quarantine;
create policy xquar_read on external_job_quarantine for select
  using (app_is_admin() or app_role() in ('recruiter', 'bde'));
revoke insert, update, delete on external_job_quarantine from app_api;

create or replace function external_quarantine_put(
  p_source_id text, p_fingerprint text, p_external_job_id text, p_title text, p_company text,
  p_url text, p_reasons text[], p_action text, p_raw jsonb
) returns void
language sql security definer set search_path = public as $$
  insert into external_job_quarantine (source_id, fingerprint, external_job_id, title, company,
      application_url, reasons, action, raw)
  values (p_source_id, p_fingerprint, left(p_external_job_id, 200), left(p_title, 300), left(p_company, 200),
      left(p_url, 2048), coalesce(p_reasons, '{}'), coalesce(p_action, 'quarantined'), coalesce(p_raw, '{}'))
  on conflict (source_id, fingerprint) do update set
      external_job_id = excluded.external_job_id, title = excluded.title, company = excluded.company,
      application_url = excluded.application_url, reasons = excluded.reasons, action = excluded.action,
      raw = excluded.raw, last_seen_at = now(),
      times_seen = external_job_quarantine.times_seen + 1, resolved_at = null;
$$;

/* Postings that now pass are no longer quarantined. */
create or replace function external_quarantine_resolve(p_source_id text, p_fingerprints text[]) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update external_job_quarantine set resolved_at = now()
   where source_id = p_source_id and resolved_at is null and fingerprint = any(p_fingerprints);
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------------------------------------------------------------------
-- 6. sync runs: provider, failures, quarantine, duration, summary
-- ---------------------------------------------------------------------
alter table external_sync_runs
  add column if not exists provider text,
  add column if not exists failed int not null default 0,
  add column if not exists quarantined int not null default 0,
  add column if not exists url_changes int not null default 0,
  add column if not exists duration_ms int,
  add column if not exists error_summary text;

create or replace function external_sync_run_extend(
  p_id bigint, p_provider text, p_failed int, p_quarantined int, p_url_changes int,
  p_duration_ms int, p_error_summary text
) returns void
language sql security definer set search_path = public as $$
  update external_sync_runs
     set provider = p_provider, failed = coalesce(p_failed, 0), quarantined = coalesce(p_quarantined, 0),
         url_changes = coalesce(p_url_changes, 0), duration_ms = p_duration_ms,
         error_summary = left(p_error_summary, 1000)
   where id = p_id;
$$;

-- ---------------------------------------------------------------------
-- 7. source health and admin alerts
-- ---------------------------------------------------------------------
/*
 * One sync's outcome into the health columns.
 *   success  the source answered and the run was usable
 *   failure  the source could not be read
 *   empty    it answered with nothing while jobs are held: treated as a
 *            failure so the held jobs are never closed because of it
 * Backoff: after n consecutive failures the next scheduled attempt waits
 * base * 2^(n-1) hours, capped.
 */
create or replace function external_source_health_record(
  p_source_id text, p_outcome text, p_duration_ms int, p_threshold int,
  p_backoff_base_hours numeric, p_backoff_max_hours numeric
) returns table (consecutive_failures int, health_status text, crossed boolean, recovered boolean,
                 next_sync_after timestamptz, open_job_count int)
language plpgsql security definer set search_path = public as $$
declare s job_sources; ok boolean := p_outcome = 'success'; n int; th int := greatest(1, coalesce(p_threshold, 3));
        was text; jobs int;
begin
  select * into s from job_sources where id = p_source_id for update;
  if not found then return; end if;
  was := s.health_status;
  n := case when ok then 0 else s.consecutive_failures + 1 end;
  select count(*) into jobs from external_jobs j where j.source_id = p_source_id and j.status = 'open';

  update job_sources j set
      last_attempt_at = now(),
      last_success_at = case when ok then now() else j.last_success_at end,
      success_count = j.success_count + case when ok then 1 else 0 end,
      failure_count = j.failure_count + case when ok then 0 else 1 end,
      consecutive_failures = n,
      avg_sync_ms = case when p_duration_ms is null then j.avg_sync_ms
                         else round((coalesce(j.avg_sync_ms, 0) * (j.success_count + j.failure_count)
                                     + p_duration_ms) / (j.success_count + j.failure_count + 1)) end,
      open_job_count = jobs,
      health_status = case when ok then 'healthy' when n >= th then 'unhealthy' else 'degraded' end,
      next_sync_after = case when ok then null
        else now() + make_interval(secs => least(coalesce(p_backoff_max_hours, 48),
               coalesce(p_backoff_base_hours, 6) * power(2, n - 1)) * 3600) end
   where j.id = p_source_id;

  consecutive_failures := n;
  health_status := case when ok then 'healthy' when n >= th then 'unhealthy' else 'degraded' end;
  crossed := (not ok) and n = th;
  recovered := ok and was = 'unhealthy';
  select x.next_sync_after into next_sync_after from job_sources x where x.id = p_source_id;
  open_job_count := jobs;
  return next;
end $$;

/* The existing alerting: an in-app notification to every administrator,
   once per key (the key carries the day, so a persistent fault is
   reported daily, not every run). Also written to the audit trail. */
create or replace function external_admin_alert(
  p_key text, p_type text, p_source_id text, p_title text, p_message text, p_metadata jsonb
) returns int
language plpgsql security definer set search_path = public as $$
declare a record; sent int := 0; got text;
begin
  for a in select id from admins loop
    got := notify_create('xal_' || md5(p_key || '|' || a.id), a.id, 'admin', p_type,
                         left(p_title, 200), left(p_message, 1000), null, null, null, null,
                         coalesce(p_metadata, '{}') || jsonb_build_object('sourceId', p_source_id, 'external', true));
    if got is not null then sent := sent + 1; end if;
  end loop;
  if sent > 0 then
    perform external_audit_add('alert.' || lower(p_type), 'source', p_source_id, null,
      jsonb_build_object('title', p_title, 'message', p_message) || coalesce(p_metadata, '{}'), null);
  end if;
  return sent;
end $$;

-- ---------------------------------------------------------------------
-- 8. analytics: four events, daily counts, no personal data
-- ---------------------------------------------------------------------
create table if not exists external_job_events (
  day             date not null default current_date,
  event           text not null check (event in ('external_job_view', 'external_apply_click',
                                                 'external_redirect_success', 'external_redirect_failure')),
  external_job_id text not null,
  source_id       text,
  reason          text not null default '',
  n               int  not null default 0,
  first_at        timestamptz not null default now(),
  last_at         timestamptz not null default now(),
  primary key (day, event, external_job_id, reason)
);
create index if not exists xevents_source_idx on external_job_events (source_id, day desc);

alter table external_job_events enable row level security;
alter table external_job_events force  row level security;
drop policy if exists xevents_read on external_job_events;
create policy xevents_read on external_job_events for select
  using (app_is_admin() or app_role() in ('recruiter', 'bde'));
revoke insert, update, delete on external_job_events from app_api;

create or replace function external_job_event_add(p_external_job_id text, p_event text, p_reason text)
returns void
language plpgsql security definer set search_path = public as $$
declare v_source text; v_job text := left(coalesce(p_external_job_id, ''), 80);
begin
  select source_id into v_source from external_jobs where id = v_job;
  if v_source is null then v_job := ''; end if;      -- unknown ids are counted, not stored
  insert into external_job_events (event, external_job_id, source_id, reason, n)
  values (p_event, v_job, v_source, left(coalesce(p_reason, ''), 60), 1)
  on conflict (day, event, external_job_id, reason) do update
     set n = external_job_events.n + 1, last_at = now();
end $$;

-- ---------------------------------------------------------------------
-- 9. a candidate's saved external jobs
--
-- saved_jobs references jobs(id), so an external posting can never be a
-- row there. This is its own small table: one row per candidate per
-- posting, removed only by the candidate. A posting that closes stays
-- saved and is shown as closed - never silently dropped.
-- ---------------------------------------------------------------------
create table if not exists external_saved_jobs (
  candidate_id    text not null references candidates(id) on delete cascade,
  external_job_id text not null references external_jobs(id) on delete cascade,
  created_at      timestamptz not null default now(),
  primary key (candidate_id, external_job_id)
);

alter table external_saved_jobs enable row level security;
alter table external_saved_jobs force  row level security;
drop policy if exists xsaved_read on external_saved_jobs;
create policy xsaved_read on external_saved_jobs for select
  using (app_is_admin() or candidate_id = app_candidate_id());
revoke insert, update, delete on external_saved_jobs from app_api;

create or replace function external_saved_set(p_external_job_id text, p_saved boolean) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_cand text := app_candidate_id();
begin
  if v_cand is null then raise exception 'only a candidate can save a job' using errcode = '42501'; end if;
  if p_saved then
    if not exists (select 1 from external_jobs where id = p_external_job_id) then return false; end if;
    insert into external_saved_jobs (candidate_id, external_job_id) values (v_cand, p_external_job_id)
    on conflict do nothing;
  else
    delete from external_saved_jobs where candidate_id = v_cand and external_job_id = p_external_job_id;
  end if;
  return true;
end $$;

-- ---------------------------------------------------------------------
-- 10. the portal: search with filters and a deterministic rank, a fuller
--     details row, the redirect target with its allowed domains, and a
--     version stamp for the cache
-- ---------------------------------------------------------------------
/*
 * Score, all integers, highest first; ties broken by freshness then id so
 * the order is total and the same every time:
 *   exact title = query            100
 *   title contains the whole query  60, else any term 40
 *   a skill equals a term           25, else skills mention one 15
 *   company mentions a term         10
 *   description mentions a term      5
 *   location filter matches         20
 *   experience inside the range     10
 *   freshness (posted or seen)      10 (≤3 d), 7 (≤7), 4 (≤14), 2 (≤30)
 *   source health                    3 healthy, 1 degraded/unknown
 * With no query and the default sort, the order is exactly 0088's:
 * newest posted first.
 */
create or replace function external_portal_search(
  p_q text, p_source text, p_provider text, p_location text, p_employment_type text,
  p_experience numeric, p_salary_min numeric, p_skills text[], p_posted_days int,
  p_max_age_days int, p_sort text, p_limit int, p_offset int
) returns table (
  id text, title text, company text, location text, experience text, salary text,
  salary_min numeric, salary_max numeric, skills text[], description text,
  employment_type text, education text, posted_at timestamptz, synced_at timestamptz,
  status text, source_key text, source_name text, original_publisher text,
  exp_min numeric, exp_max numeric, last_seen_at timestamptz, provider text,
  score int, total bigint
)
language sql stable security definer set search_path = public as $$
  with params as (
    select lower(btrim(coalesce(p_q, ''))) as q,
           array(select lower(btrim(t)) from unnest(string_to_array(coalesce(p_q, ''), ',')) t
                  where btrim(t) <> '') as terms,
           lower(btrim(coalesce(p_location, ''))) as loc,
           array(select lower(btrim(s)) from unnest(coalesce(p_skills, '{}')) s where btrim(s) <> '') as want
  ),
  hits as (
    select j.*, s.name as s_name, s.provider as s_provider, s.health_status as s_health,
           coalesce(j.posted_at, j.synced_at) as fresh_at
      from external_jobs j join job_sources s on s.id = j.source_id, params p
     where j.status = 'open'
       and j.duplicate_of is null
       and s.active
       and (coalesce(p_source, '') = '' or j.source_id = p_source)
       and (coalesce(p_provider, '') = '' or s.provider = lower(p_provider))
       and (cardinality(p.terms) = 0 or exists (
             select 1 from unnest(p.terms) t
              where j.title ilike '%' || t || '%' or j.company ilike '%' || t || '%'
                 or j.location ilike '%' || t || '%'
                 or array_to_string(j.skills, ' ') ilike '%' || t || '%'
                 or j.description ilike '%' || t || '%'))
       and (p.loc = '' or j.location ilike '%' || p.loc || '%'
            or coalesce(j.city, '') ilike '%' || p.loc || '%'
            or j.location ~* '(remote|anywhere|work from home)')
       and (coalesce(btrim(p_employment_type), '') = ''
            or regexp_replace(lower(coalesce(j.employment_type, '')), '[^a-z]', '', 'g')
               = regexp_replace(lower(p_employment_type), '[^a-z]', '', 'g'))
       and (p_experience is null or (coalesce(j.exp_min, 0) <= p_experience
                                     and coalesce(j.exp_max, j.exp_min, 99) >= p_experience))
       and (p_salary_min is null or coalesce(j.salary_max, j.salary_min) >= p_salary_min)
       and (cardinality(p.want) = 0 or exists (
             select 1 from unnest(j.skills) k where lower(k) = any(p.want)))
       and (p_posted_days is null or coalesce(j.posted_at, j.synced_at) >= now() - make_interval(days => p_posted_days))
       and (p_max_age_days is null or j.posted_at is null or j.posted_at >= now() - make_interval(days => p_max_age_days))
  ),
  scored as (
    select h.*,
      ( case when p.q <> '' and lower(h.title) = p.q then 100
             when p.q <> '' and h.title ilike '%' || p.q || '%' then 60
             when exists (select 1 from unnest(p.terms) t where h.title ilike '%' || t || '%') then 40
             else 0 end
      + case when exists (select 1 from unnest(h.skills) k, unnest(p.terms) t where lower(k) = t) then 25
             when exists (select 1 from unnest(p.terms) t where array_to_string(h.skills, ' ') ilike '%' || t || '%') then 15
             else 0 end
      + case when exists (select 1 from unnest(p.terms) t where h.company ilike '%' || t || '%') then 10 else 0 end
      + case when exists (select 1 from unnest(p.terms) t where h.description ilike '%' || t || '%') then 5 else 0 end
      + case when p.loc <> '' and h.location ilike '%' || p.loc || '%' then 20 else 0 end
      + case when p_experience is not null then 10 else 0 end
      + case when h.fresh_at >= now() - interval '3 days' then 10
             when h.fresh_at >= now() - interval '7 days' then 7
             when h.fresh_at >= now() - interval '14 days' then 4
             when h.fresh_at >= now() - interval '30 days' then 2 else 0 end
      + case h.s_health when 'healthy' then 3 when 'unhealthy' then 0 else 1 end
      )::int as score
      from hits h, params p
  )
  select x.id, x.title, x.company, x.location, x.experience, x.salary,
         x.salary_min, x.salary_max, x.skills, left(x.description, 600),
         x.employment_type, x.education, x.posted_at, x.synced_at,
         x.status, x.source_id, x.s_name, x.original_publisher,
         x.exp_min, x.exp_max, x.last_seen_at, x.s_provider,
         x.score, count(*) over () as total
    from scored x
   order by case when coalesce(p_sort, '') = 'relevance' then x.score end desc nulls last,
            case when coalesce(p_sort, '') = 'relevance' then x.fresh_at end desc nulls last,
            x.posted_at desc nulls last, x.synced_at desc, x.id
   limit least(greatest(coalesce(p_limit, 50), 1), 500)
  offset greatest(coalesce(p_offset, 0), 0)
$$;

create or replace function external_portal_job_v2(p_id text)
returns table (
  id text, title text, company text, location text, experience text, salary text,
  salary_min numeric, salary_max numeric, skills text[], description text,
  employment_type text, education text, posted_at timestamptz, synced_at timestamptz,
  status text, source_key text, source_name text, original_publisher text,
  exp_min numeric, exp_max numeric, last_seen_at timestamptz, provider text, source_active boolean
)
language sql stable security definer set search_path = public as $$
  select j.id, j.title, j.company, j.location, j.experience, j.salary,
         j.salary_min, j.salary_max, j.skills, j.description,
         j.employment_type, j.education, j.posted_at, j.synced_at,
         case when s.active then j.status else 'removed' end,
         j.source_id, s.name, j.original_publisher,
         j.exp_min, j.exp_max, j.last_seen_at, s.provider, s.active
    from external_jobs j join job_sources s on s.id = j.source_id
   where j.id = p_id
$$;

create or replace function external_portal_apply_target_v2(p_id text)
returns table (id text, status text, application_url text, source_key text, source_name text,
               connector text, provider text, allowed_domains text[], source_active boolean,
               original_publisher text)
language sql stable security definer set search_path = public as $$
  select j.id, case when s.active then j.status else 'removed' end,
         j.application_url, j.source_id, s.name, s.connector, s.provider, s.allowed_domains, s.active,
         j.original_publisher
    from external_jobs j join job_sources s on s.id = j.source_id
   where j.id = p_id
$$;

/* Changes whenever any posting or source changes - including a direct
   UPDATE, because both tables now stamp updated_at in a trigger. */
create or replace function external_portal_version() returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select max(updated_at)::text from external_jobs), '') || '|'
      || (select count(*) from external_jobs)::text || '|'
      || coalesce((select max(updated_at)::text from job_sources), '') || '|'
      || (select count(*) from job_sources)::text
$$;

-- ---------------------------------------------------------------------
-- grants (default privileges already let app_api execute new functions;
-- stated explicitly so a deployment that revoked PUBLIC still works)
-- ---------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant select on external_source_licences, external_audit_log, external_job_url_changes,
                    external_job_quarantine, external_job_events, external_saved_jobs to app_api;
    grant execute on function
      external_source_brand(text, text, text),
      external_licence_gap_for(text, text, text),
      external_source_licence_gap(text),
      external_audit_add(text, text, text, jsonb, jsonb, text),
      external_source_licence_save(text, text, text, text, text, boolean, boolean, date, date, text, text),
      external_source_config_save(text, text, text[], int, int, int, int),
      external_source_disable(text, text),
      external_sources_enforce_licences(),
      external_job_url_change_note(text, text, boolean, text, boolean, text),
      external_jobs_known(text),
      external_quarantine_put(text, text, text, text, text, text, text[], text, jsonb),
      external_quarantine_resolve(text, text[]),
      external_sync_run_extend(bigint, text, int, int, int, int, text),
      external_source_health_record(text, text, int, int, numeric, numeric),
      external_admin_alert(text, text, text, text, text, jsonb),
      external_job_event_add(text, text, text),
      external_saved_set(text, boolean),
      external_portal_search(text, text, text, text, text, numeric, numeric, text[], int, int, text, int, int),
      external_portal_job_v2(text),
      external_portal_apply_target_v2(text),
      external_portal_version()
      to app_api;
  end if;
end $$;
