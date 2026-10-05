-- ---------------------------------------------------------------------
-- 0112 — Save & Post: outbound job publishing to several destinations
--
-- A recruiter saves a TeamLink job and picks where it goes:
--
--   TEAMLINK_PORTAL   the job is open on the portal (jobs_open)
--   TEAMLINK_WEBSITE  the public jobs feed the company website embeds
--                     (/feeds/jobs.json, /feeds/jobs.xml, JSON-LD on the
--                     job page)
--   NAUKRI, SHINE,    third-party job sites. Each needs an agreement with
--   INDEED            that platform and the credentials it issues, entered
--                     by an administrator under Administration ->
--                     Integrations. Without them the row says
--                     "Integration Required" and NOTHING is sent.
--
--   publishing_destinations       the catalogue; a new destination is a
--                                 row here plus a connector in code
--   publishing_integrations       per-destination configuration. Secrets
--                                 are AES-256-GCM ciphertext made with
--                                 INTEGRATION_SECRET_KEY (server env);
--                                 only a 4-character hint is stored in
--                                 the clear. Administrators only.
--   publishing_integration_events who changed which setting, and every
--                                 Test Connection - never a value
--   job_publications              one row per (job, destination): what
--                                 the recruiter asked for, what the
--                                 platform confirmed, the external id
--                                 and URL, attempts and the last error
--   job_publication_events        the audit trail of every row
--
-- POSTED IS NEVER OUR OWN SAY-SO. A partner row is 'posted' only from a
-- success response that carries an external id and/or URL; Indeed's feed
-- model sits at 'awaiting_confirmation' until Indeed confirms (callback or
-- status check). TeamLink's own destinations are 'posted' only once the
-- job is publicly readable at the URL stored on the row.
--
-- ADDITIVE ONLY. Nothing existing is changed.
-- ---------------------------------------------------------------------

/* ===================================================================== *
 * 1. the catalogue
 * ===================================================================== */
create table if not exists publishing_destinations (
  key              text primary key check (key ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  label            text not null,
  -- 'own': TeamLink's own systems, works with no configuration.
  -- 'partner': a third-party platform behind an authorized integration.
  kind             text not null check (kind in ('own', 'partner')),
  -- ticked by default on the Save & Post form
  default_selected boolean not null default false,
  sort_order       int not null default 100,
  -- the connection types this destination accepts (partner only)
  connection_types text[] not null default '{}',
  active           boolean not null default true
);

insert into publishing_destinations (key, label, kind, default_selected, sort_order, connection_types) values
  ('TEAMLINK_PORTAL',  'TeamLink Job Portal', 'own',     true,  10, '{}'),
  ('TEAMLINK_WEBSITE', 'TeamLink Website',    'own',     true,  20, '{}'),
  ('NAUKRI',           'Naukri',              'partner', false, 30, '{api,partner_feed}'),
  ('SHINE',            'Shine',               'partner', false, 40, '{api,partner_feed}'),
  ('INDEED',           'Indeed',              'partner', false, 50, '{xml_feed,api}')
on conflict (key) do nothing;

/* ===================================================================== *
 * 2. per-destination configuration (administrators only)
 * ===================================================================== */
create table if not exists publishing_integrations (
  destination      text primary key references publishing_destinations(key) on delete cascade,
  enabled          boolean not null default false,
  -- api:          TeamLink calls the platform's authorized partner API
  -- xml_feed:     the platform pulls TeamLink's signed XML feed (Indeed)
  -- partner_feed: same, for a platform's partner feed programme
  connection_type  text check (connection_type in ('api', 'xml_feed', 'partner_feed')),
  endpoint_url     text,           -- the authorized API base URL (api)
  auth_type        text check (auth_type in ('bearer', 'api_key_header', 'basic', 'oauth2_client_credentials')),
  token_url        text,           -- oauth2_client_credentials only
  status_url       text,           -- optional: where confirmation can be polled
  account_id       text,           -- employer / account / publisher id (not a secret)
  client_id        text,           -- OAuth client id (not a secret)
  options          jsonb not null default '{}'::jsonb,   -- paths, timeouts
  /* {"v":1,"iv":"..","tag":"..","ct":".."} - the JSON map of secrets
     (apiKey, clientSecret, feedToken, callbackSecret), encrypted. */
  secrets_enc      text,
  -- {"apiKey":"1a2b", ...}: at most the last 4 characters, for "•••• saved"
  secret_hints     jsonb not null default '{}'::jsonb,
  last_test_at     timestamptz,
  last_test_ok     boolean,
  last_test_message text,
  last_sync_at     timestamptz,
  last_error       text,
  last_error_at    timestamptz,
  updated_by       uuid,
  updated_at       timestamptz not null default now()
);

create table if not exists publishing_integration_events (
  id           bigserial primary key,
  destination  text not null references publishing_destinations(key) on delete cascade,
  -- 'config_saved' | 'secret_saved' | 'secret_cleared' | 'enabled' |
  -- 'disabled' | 'test_ok' | 'test_failed' | 'publish_pending' | 'callback'
  event        text not null,
  -- field NAMES only. Never a value.
  detail       text,
  actor        uuid,
  created_at   timestamptz not null default now()
);
create index if not exists pie_dest_idx on publishing_integration_events (destination, created_at desc);

/* ===================================================================== *
 * 3. one row per (job, destination)
 * ===================================================================== */
create table if not exists job_publications (
  id               bigserial primary key,
  job_id           text not null references jobs(id) on delete cascade,
  destination      text not null references publishing_destinations(key),
  -- what the recruiter asked for: on that destination, or taken off it
  desired          text not null default 'published' check (desired in ('published', 'removed')),
  status           text not null default 'pending' check (status in (
                     'pending',                -- queued
                     'posting',                -- a worker holds it right now
                     'posted',                 -- confirmed, with a URL / external id
                     'awaiting_confirmation',  -- listed in a feed, platform has not confirmed
                     'failed',                 -- the platform said no / did not answer; retried
                     'integration_required',   -- no authorized integration configured
                     'removed')),              -- taken down (or never needed to be)
  external_job_id  text,
  external_url     text,
  attempts         int not null default 0,
  next_attempt_at  timestamptz,
  last_attempt_at  timestamptz,
  last_error       text,
  -- the one worker allowed to act on this row (see job_publication_claim)
  claimed_at       timestamptz,
  claim_token      text,
  -- a hash of what was last sent, so an edit is pushed once
  pushed_hash      text,
  confirmed_at     timestamptz,
  removed_at       timestamptz,
  requested_by     uuid,           -- who ticked it (users.id)
  requested_at     timestamptz not null default now(),
  posted_by        uuid,           -- who pressed Save & Post for the posting that went out
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (job_id, destination)
);
create index if not exists jp_due_idx on job_publications (status, next_attempt_at);
create index if not exists jp_dest_idx on job_publications (destination, status);

create table if not exists job_publication_events (
  id              bigserial primary key,
  publication_id  bigint not null references job_publications(id) on delete cascade,
  job_id          text not null,
  destination     text not null,
  event           text not null,  -- requested / posting / posted / failed / ...
  from_status     text,
  to_status       text,
  detail          text,
  actor           uuid,           -- null: the publishing worker
  created_at      timestamptz not null default now()
);
create index if not exists jpe_pub_idx on job_publication_events (publication_id, created_at desc);
create index if not exists jpe_job_idx on job_publication_events (job_id, created_at desc);

/* ===================================================================== *
 * row level security
 *
 * Integrations and their audit: administrators only (the publishing
 * worker runs as role admin with no user id, which app_is_admin() also
 * admits). Publications: an administrator, or the recruiter who owns the
 * job, may READ; every write goes through the API's worker identity
 * after the API has checked that the caller may change the job.
 * ===================================================================== */
alter table publishing_destinations       enable row level security;
alter table publishing_integrations       enable row level security;
alter table publishing_integration_events enable row level security;
alter table job_publications              enable row level security;
alter table job_publication_events        enable row level security;
alter table publishing_integrations       force row level security;
alter table job_publications              force row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'publishing_destinations'
                  and policyname = 'publishing_destinations_read') then
    create policy publishing_destinations_read on publishing_destinations for select using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'publishing_destinations'
                  and policyname = 'publishing_destinations_admin') then
    create policy publishing_destinations_admin on publishing_destinations for all
      using (app_is_admin()) with check (app_is_admin());
  end if;

  if not exists (select 1 from pg_policies where tablename = 'publishing_integrations'
                  and policyname = 'publishing_integrations_admin') then
    create policy publishing_integrations_admin on publishing_integrations for all
      using (app_is_admin()) with check (app_is_admin());
  end if;
  if not exists (select 1 from pg_policies where tablename = 'publishing_integration_events'
                  and policyname = 'publishing_integration_events_admin') then
    create policy publishing_integration_events_admin on publishing_integration_events for all
      using (app_is_admin()) with check (app_is_admin());
  end if;

  if not exists (select 1 from pg_policies where tablename = 'job_publications'
                  and policyname = 'job_publications_read') then
    create policy job_publications_read on job_publications for select using (
      app_is_admin()
      or (app_role() = 'recruiter' and exists (
            select 1 from jobs j where j.id = job_publications.job_id
                                   and j.recruiter_id = app_recruiter_id())));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'job_publications'
                  and policyname = 'job_publications_write') then
    create policy job_publications_write on job_publications for all
      using (app_is_admin()) with check (app_is_admin());
  end if;

  if not exists (select 1 from pg_policies where tablename = 'job_publication_events'
                  and policyname = 'job_publication_events_read') then
    create policy job_publication_events_read on job_publication_events for select using (
      app_is_admin()
      or (app_role() = 'recruiter' and exists (
            select 1 from jobs j where j.id = job_publication_events.job_id
                                   and j.recruiter_id = app_recruiter_id())));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'job_publication_events'
                  and policyname = 'job_publication_events_write') then
    create policy job_publication_events_write on job_publication_events for insert
      with check (app_is_admin());
  end if;
end $$;

comment on table job_publications is
  'Save & Post (0112): one row per (job, destination). posted only from a confirmed response (partner) or a verified public URL (TeamLink).';
