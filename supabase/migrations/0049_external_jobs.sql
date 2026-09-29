-- ---------------------------------------------------------------------
-- 0049 — external jobs: a second source of truth, bolted on beside the first
--
-- TeamLink's own jobs, applications and ATS stages are the source of
-- truth for TeamLink's own hiring. This file adds a SEPARATE layer for
-- vacancies that belong to somebody else - a job board, a partner feed, a
-- company's own careers page - so a candidate can be matched against them
-- and, where an authorised mechanism exists, apply.
--
-- WHAT THIS FILE DELIBERATELY DOES NOT DO
--
-- It contains no `alter table` against jobs, applications, candidates,
-- stages or application_stage_history. It creates no row in any of them.
-- An external application NEVER becomes a row in `applications`, because
-- it is not one: nobody at TeamLink screens it, schedules it, or moves it
-- through a pipeline. Putting it there would corrupt every count, every
-- funnel report and every kanban column in the product.
--
-- The one and only link back to the existing schema is
-- `candidate_id references candidates(id) on delete cascade`, which
-- points INTO the existing data and can only ever be read. Deleting a
-- candidate cleans up their external rows; nothing here can write to a
-- candidate.
--
-- WHY THE STATUS VOCABULARY IS SEPARATE FROM `stages`
--
-- `external_applications.status` looks like `applications.stage` and must
-- never be joined to it. "Shortlisted" on Naukri means a stranger liked a
-- CV; "shortlisted" in TeamLink means a recruiter here moved somebody
-- forward and a client is expecting them. One must never be allowed to
-- imply the other, so they do not even share a lookup table.
--
-- NO CREDENTIALS ARE STORED HERE. A source records the NAME of the
-- environment variable holding its key (`credential_env`), never the key.
-- A database dump therefore carries no secret, and rotating a key is an
-- environment change rather than a data migration.
--
-- NO SOURCES AND NO JOBS ARE SEEDED. The feature is inert until somebody
-- adds a source, which is a deliberate act.
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- where external jobs come from
-- ---------------------------------------------------------------------

create table if not exists job_sources (
  id                    text primary key,
  name                  text not null,
  -- What kind of thing this is, for display and for reporting.
  source_type           text not null default 'job_board'
    check (source_type in ('job_board', 'company_site', 'partner_api', 'referral', 'manual')),

  -- HOW JOBS ARRIVE.
  --   manual  a recruiter enters or uploads them
  --   feed    an authorised JSON/XML feed this source publishes
  --   api     an authorised partner API, keyed from the environment
  -- Scraping a site that does not publish a feed is not an option here,
  -- and there is deliberately no value for it.
  job_collection_method text not null default 'manual'
    check (job_collection_method in ('manual', 'feed', 'api')),

  -- HOW AN APPLICATION IS SUBMITTED.
  --   none      this source cannot be applied to through TeamLink
  --   redirect  TeamLink records the application and hands the candidate
  --             the official URL; the candidate completes it themselves
  --   email     the posting names an application address
  --   api       an authorised partner submission API
  application_method    text not null default 'redirect'
    check (application_method in ('none', 'redirect', 'email', 'api')),

  -- Only ever true for a source whose owner permits automated
  -- submission. It is not a switch for trying harder.
  auto_apply_supported  boolean not null default false,
  active                boolean not null default false,

  -- For 'feed' and 'api'. The URL is not a secret; the key is, and only
  -- its ENVIRONMENT VARIABLE NAME is recorded.
  feed_url              text,
  credential_env        text,

  last_sync_at          timestamptz,
  last_sync_status      text,
  last_sync_error       text,
  last_sync_job_count   int,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create unique index if not exists job_sources_name_key on job_sources (lower(name));
create index if not exists job_sources_active_idx on job_sources (active);

-- ---------------------------------------------------------------------
-- the external jobs themselves
-- ---------------------------------------------------------------------

create table if not exists external_jobs (
  id              text primary key,
  source_id       text not null references job_sources(id) on delete cascade,
  -- The id the SOURCE uses. Unique per source, not globally.
  external_job_id text not null,

  title           text not null,
  company         text,
  location        text,
  description     text,
  skills          text[] not null default '{}',

  -- Experience and pay are kept BOTH as the source wrote them and as
  -- numbers, because "2-4 yrs" is what a candidate should see and 2 and 4
  -- are what the matcher needs.
  experience      text,
  exp_min         numeric,
  exp_max         numeric,
  salary          text,
  salary_min      numeric,
  salary_max      numeric,

  employment_type text,
  industry        text,
  education       text,

  application_url text,
  apply_email     text,

  posted_at       timestamptz,
  synced_at       timestamptz not null default now(),
  status          text not null default 'open'
    check (status in ('open', 'closed', 'expired', 'removed')),

  -- DEDUPLICATION (§5). The same vacancy advertised on three boards is
  -- three rows here, and stays three rows: each source's link, id and
  -- apply route are real and none of them can be thrown away. What is
  -- added is a shared `dedupe_key` and a pointer to whichever row was
  -- seen first, so the candidate can be shown one card instead of three
  -- without the other two being destroyed.
  dedupe_key      text,
  duplicate_of    text references external_jobs(id) on delete set null,

  -- Whatever the source actually sent, kept verbatim. When a field is
  -- parsed wrongly this is the only way to find out why without asking
  -- the source for the job again.
  raw             jsonb not null default '{}',

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  -- One row per job per source. A re-sync updates rather than duplicates.
  unique (source_id, external_job_id)
);
create index if not exists external_jobs_status_idx  on external_jobs (status);
create index if not exists external_jobs_dedupe_idx  on external_jobs (dedupe_key);
create index if not exists external_jobs_source_idx  on external_jobs (source_id);
create index if not exists external_jobs_posted_idx  on external_jobs (posted_at desc);
create index if not exists external_jobs_skills_gin  on external_jobs using gin (skills);

-- ---------------------------------------------------------------------
-- how well a candidate fits an external job
--
-- This is the ONLY place an external match score is written. The existing
-- `applications.match_score` belongs to TeamLink's own matcher and is not
-- touched by any of this.
-- ---------------------------------------------------------------------

create table if not exists candidate_external_job_matches (
  id                text primary key,
  candidate_id      text not null references candidates(id)   on delete cascade,
  external_job_id   text not null references external_jobs(id) on delete cascade,

  match_percentage  numeric not null check (match_percentage >= 0 and match_percentage <= 100),
  matching_skills   text[] not null default '{}',
  missing_skills    text[] not null default '{}',
  -- Why it scored what it scored, in the words shown to the candidate.
  -- A score with no explanation is not usable by a recruiter defending it.
  match_reasons     jsonb  not null default '[]',

  auto_apply_eligible boolean not null default false,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  unique (candidate_id, external_job_id)
);
create index if not exists cejm_candidate_idx on candidate_external_job_matches (candidate_id, match_percentage desc);
create index if not exists cejm_job_idx       on candidate_external_job_matches (external_job_id);

-- ---------------------------------------------------------------------
-- the external application status vocabulary
--
-- Separate from `stages` ON PURPOSE. See the header.
-- ---------------------------------------------------------------------

create table if not exists external_application_statuses (
  id         text primary key,
  label      text not null,
  sort_order int  not null,
  -- Whether this status means the work is finished, either way.
  terminal   boolean not null default false
);

insert into external_application_statuses (id, label, sort_order, terminal) values
  ('ready',                'Ready',                   10, false),
  ('applying',             'Applying',                20, false),
  ('applied',              'Applied',                 30, false),
  -- The honest state for a redirect: TeamLink handed over the official
  -- link and cannot see whether the candidate finished. Claiming
  -- "Applied" here would be the same lie as calling an HTTP 200 a
  -- delivered email.
  ('applied_unconfirmed',  'Applied – Not Confirmed', 35, false),
  ('application_received', 'Application Received',    40, false),
  ('under_review',         'Under Review',            50, false),
  ('shortlisted',          'Shortlisted',             60, false),
  ('interview',            'Interview',               70, false),
  ('rejected',             'Rejected',                80, true),
  ('withdrawn',            'Withdrawn',               90, true),
  ('failed',               'Failed',                 100, true),
  ('unknown',              'Unknown',                110, false)
on conflict (id) do update set
  label = excluded.label,
  sort_order = excluded.sort_order,
  terminal = excluded.terminal;

-- ---------------------------------------------------------------------
-- external applications
--
-- A parallel record, never an `applications` row.
-- ---------------------------------------------------------------------

create table if not exists external_applications (
  id                     text primary key,
  candidate_id           text not null references candidates(id)    on delete cascade,
  external_job_id        text not null references external_jobs(id) on delete cascade,
  source_id              text not null references job_sources(id)   on delete cascade,

  -- The score AT THE MOMENT OF APPLYING, copied deliberately. Re-running
  -- the matcher later must not rewrite the history of why this was sent.
  match_percentage       numeric,

  application_type       text not null default 'manual'
    check (application_type in ('manual', 'redirect', 'email', 'api', 'auto')),

  -- What the source calls it, when the source says anything at all.
  external_application_id text,
  application_url        text,

  status                 text not null default 'ready'
    references external_application_statuses(id),
  -- The source's own words, unmapped. Kept beside `status` so nothing is
  -- lost when a board invents a state we have never seen.
  external_status        text,

  submitted_at           timestamptz,
  last_status_check_at   timestamptz,
  failure_reason         text,

  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  -- One external application per candidate per external job.
  unique (candidate_id, external_job_id)
);
create index if not exists exapp_candidate_idx on external_applications (candidate_id);
create index if not exists exapp_status_idx    on external_applications (status);
create index if not exists exapp_source_idx    on external_applications (source_id);
create index if not exists exapp_check_idx     on external_applications (last_status_check_at);

-- ---------------------------------------------------------------------
-- who may see what
--
-- Nothing here widens what a reader can already see. Every table that
-- names a candidate is joined back to a `candidates` row the reader can
-- already read, and a candidate sees only their own rows.
--
-- External JOBS are the exception and are readable by any signed-in user:
-- they are public advertisements, which is the whole point of them.
--
-- No table is writable directly. Writes go through the definer functions
-- below, so every one of them is a deliberate, named operation.
-- ---------------------------------------------------------------------

alter table job_sources enable row level security;
alter table job_sources force  row level security;
create policy jsrc_read on job_sources for select using (
  app_is_admin() or app_role() in ('recruiter', 'bde')
);
create policy jsrc_no_direct_write on job_sources for all
  using (app_is_admin()) with check (app_is_admin());

alter table external_jobs enable row level security;
alter table external_jobs force  row level security;
create policy exjob_read on external_jobs for select using (
  app_is_admin() or app_role() in ('recruiter', 'bde', 'candidate', 'client')
);
create policy exjob_no_direct_write on external_jobs for all
  using (app_is_admin()) with check (app_is_admin());

alter table candidate_external_job_matches enable row level security;
alter table candidate_external_job_matches force  row level security;
create policy cejm_read on candidate_external_job_matches for select using (
  app_is_admin()
  or candidate_id = app_candidate_id()
  or (app_role() in ('recruiter', 'bde') and exists (
        select 1 from candidates c where c.id = candidate_external_job_matches.candidate_id))
);
create policy cejm_no_direct_write on candidate_external_job_matches for all
  using (app_is_admin()) with check (app_is_admin());

alter table external_applications enable row level security;
alter table external_applications force  row level security;
create policy exapp_read on external_applications for select using (
  app_is_admin()
  or candidate_id = app_candidate_id()
  or (app_role() in ('recruiter', 'bde') and exists (
        select 1 from candidates c where c.id = external_applications.candidate_id))
);
create policy exapp_no_direct_write on external_applications for all
  using (app_is_admin()) with check (app_is_admin());

alter table external_application_statuses enable row level security;
alter table external_application_statuses force  row level security;
create policy exstat_read on external_application_statuses for select using (true);
create policy exstat_no_direct_write on external_application_statuses for all
  using (app_is_admin()) with check (app_is_admin());

-- ---------------------------------------------------------------------
-- the writes
--
-- Each one is security definer so the API role can perform exactly these
-- operations and nothing else. None of them can reach an existing
-- TeamLink table: read the bodies and there is no `applications`, no
-- `jobs`, no `update candidates` anywhere in them.
-- ---------------------------------------------------------------------

create or replace function external_source_save(
  p_id text, p_name text, p_source_type text,
  p_collection text, p_application text,
  p_auto_apply boolean, p_active boolean,
  p_feed_url text, p_credential_env text
) returns job_sources
language plpgsql security definer set search_path = public as $$
declare out_row job_sources;
begin
  insert into job_sources (id, name, source_type, job_collection_method,
                           application_method, auto_apply_supported, active,
                           feed_url, credential_env)
       values (p_id, p_name, coalesce(p_source_type, 'job_board'),
               coalesce(p_collection, 'manual'), coalesce(p_application, 'redirect'),
               coalesce(p_auto_apply, false), coalesce(p_active, false),
               p_feed_url, p_credential_env)
  on conflict (id) do update set
       name = excluded.name,
       source_type = excluded.source_type,
       job_collection_method = excluded.job_collection_method,
       application_method = excluded.application_method,
       auto_apply_supported = excluded.auto_apply_supported,
       active = excluded.active,
       feed_url = excluded.feed_url,
       credential_env = excluded.credential_env,
       updated_at = now()
  returning * into out_row;
  return out_row;
end $$;

create or replace function external_source_sync_result(
  p_id text, p_status text, p_error text, p_job_count int
) returns void
language plpgsql security definer set search_path = public as $$
begin
  update job_sources
     set last_sync_at = now(),
         last_sync_status = p_status,
         last_sync_error = p_error,
         last_sync_job_count = p_job_count,
         updated_at = now()
   where id = p_id;
end $$;

/*
 * One external job, upserted on (source_id, external_job_id).
 *
 * A re-sync must be idempotent - boards republish the same vacancy every
 * day - so this updates in place and leaves `created_at` alone. The
 * source's own id is the identity; our `id` is generated once and then
 * never changes, because a match and an application both point at it.
 */
create or replace function external_job_save(
  p_id text, p_source_id text, p_external_job_id text,
  p_title text, p_company text, p_location text, p_description text,
  p_skills text[], p_experience text, p_exp_min numeric, p_exp_max numeric,
  p_salary text, p_salary_min numeric, p_salary_max numeric,
  p_employment_type text, p_industry text, p_education text,
  p_application_url text, p_apply_email text,
  p_posted_at timestamptz, p_status text, p_dedupe_key text, p_raw jsonb
) returns external_jobs
language plpgsql security definer set search_path = public as $$
declare out_row external_jobs;
begin
  insert into external_jobs (
      id, source_id, external_job_id, title, company, location, description,
      skills, experience, exp_min, exp_max, salary, salary_min, salary_max,
      employment_type, industry, education, application_url, apply_email,
      posted_at, synced_at, status, dedupe_key, raw)
    values (
      p_id, p_source_id, p_external_job_id, p_title, p_company, p_location, p_description,
      coalesce(p_skills, '{}'), p_experience, p_exp_min, p_exp_max,
      p_salary, p_salary_min, p_salary_max,
      p_employment_type, p_industry, p_education, p_application_url, p_apply_email,
      p_posted_at, now(), coalesce(p_status, 'open'), p_dedupe_key, coalesce(p_raw, '{}'))
  on conflict (source_id, external_job_id) do update set
      title = excluded.title,
      company = excluded.company,
      location = excluded.location,
      description = excluded.description,
      skills = excluded.skills,
      experience = excluded.experience,
      exp_min = excluded.exp_min,
      exp_max = excluded.exp_max,
      salary = excluded.salary,
      salary_min = excluded.salary_min,
      salary_max = excluded.salary_max,
      employment_type = excluded.employment_type,
      industry = excluded.industry,
      education = excluded.education,
      application_url = excluded.application_url,
      apply_email = excluded.apply_email,
      posted_at = excluded.posted_at,
      synced_at = now(),
      status = excluded.status,
      dedupe_key = excluded.dedupe_key,
      raw = excluded.raw,
      updated_at = now()
  returning * into out_row;
  return out_row;
end $$;

/*
 * Link rows that describe the same vacancy, WITHOUT deleting any of them.
 *
 * The earliest row in each dedupe group is the canonical one and points
 * at nothing; every later row points at it. Nothing is merged and no
 * source relationship is lost, so a candidate can still apply through
 * whichever board they prefer.
 *
 * Returns how many rows were linked.
 */
create or replace function external_jobs_relink_duplicates() returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  with groups as (
    select dedupe_key, min(created_at || id) as anchor
      from external_jobs
     where dedupe_key is not null and status = 'open'
     group by dedupe_key
    having count(*) > 1
  ),
  canonical as (
    select g.dedupe_key,
           (select j.id from external_jobs j
             where j.dedupe_key = g.dedupe_key and j.status = 'open'
             order by j.created_at, j.id limit 1) as canonical_id
      from groups g
  )
  update external_jobs j
     set duplicate_of = c.canonical_id, updated_at = now()
    from canonical c
   where j.dedupe_key = c.dedupe_key
     and j.status = 'open'
     and j.id <> c.canonical_id
     and coalesce(j.duplicate_of, '') <> c.canonical_id;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function external_match_save(
  p_id text, p_candidate_id text, p_external_job_id text,
  p_percentage numeric, p_matching text[], p_missing text[],
  p_reasons jsonb, p_auto_apply_eligible boolean
) returns candidate_external_job_matches
language plpgsql security definer set search_path = public as $$
declare out_row candidate_external_job_matches;
begin
  insert into candidate_external_job_matches (
      id, candidate_id, external_job_id, match_percentage,
      matching_skills, missing_skills, match_reasons, auto_apply_eligible)
    values (p_id, p_candidate_id, p_external_job_id, p_percentage,
      coalesce(p_matching, '{}'), coalesce(p_missing, '{}'),
      coalesce(p_reasons, '[]'), coalesce(p_auto_apply_eligible, false))
  on conflict (candidate_id, external_job_id) do update set
      match_percentage = excluded.match_percentage,
      matching_skills = excluded.matching_skills,
      missing_skills = excluded.missing_skills,
      match_reasons = excluded.match_reasons,
      auto_apply_eligible = excluded.auto_apply_eligible,
      updated_at = now()
  returning * into out_row;
  return out_row;
end $$;

/*
 * Open an external application.
 *
 * Deliberately does NOT accept a status of 'applied'. A row starts at
 * 'ready' or 'applying' and only reaches 'applied' through
 * external_application_status(), after something actually happened.
 */
create or replace function external_application_open(
  p_id text, p_candidate_id text, p_external_job_id text, p_source_id text,
  p_match_percentage numeric, p_application_type text, p_application_url text
) returns external_applications
language plpgsql security definer set search_path = public as $$
declare out_row external_applications;
begin
  insert into external_applications (
      id, candidate_id, external_job_id, source_id, match_percentage,
      application_type, application_url, status)
    values (p_id, p_candidate_id, p_external_job_id, p_source_id,
      p_match_percentage, coalesce(p_application_type, 'manual'),
      p_application_url, 'ready')
  on conflict (candidate_id, external_job_id) do update set
      -- Re-opening an existing one changes nothing about its history.
      updated_at = now()
  returning * into out_row;
  return out_row;
end $$;

/*
 * Record what the outside world said.
 *
 * `p_external_status` is the source's own wording and is stored as given.
 * `p_status` is our vocabulary and must exist in
 * external_application_statuses - an unrecognised state becomes
 * 'unknown' rather than inventing a new one or silently dropping it.
 */
create or replace function external_application_status(
  p_id text, p_status text, p_external_status text,
  p_external_application_id text, p_failure_reason text
) returns external_applications
language plpgsql security definer set search_path = public as $$
declare out_row external_applications;
        use_status text;
begin
  select id into use_status from external_application_statuses where id = p_status;
  if use_status is null then use_status := 'unknown'; end if;

  update external_applications
     set status = use_status,
         external_status = coalesce(p_external_status, external_status),
         external_application_id = coalesce(p_external_application_id, external_application_id),
         failure_reason = case when use_status = 'failed' then p_failure_reason else null end,
         submitted_at = case
           when submitted_at is not null then submitted_at
           when use_status in ('applied', 'applied_unconfirmed', 'application_received',
                               'under_review', 'shortlisted', 'interview') then now()
           else submitted_at end,
         last_status_check_at = now(),
         updated_at = now()
   where id = p_id
  returning * into out_row;
  return out_row;
end $$;

-- ---------------------------------------------------------------------
-- the API role may read these tables and call these functions. Nothing
-- else about its grants changes.
-- ---------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant select on job_sources, external_jobs, candidate_external_job_matches,
                    external_applications, external_application_statuses to app_api;
    grant execute on function
      external_source_save(text, text, text, text, text, boolean, boolean, text, text),
      external_source_sync_result(text, text, text, int),
      external_job_save(text, text, text, text, text, text, text, text[], text,
                        numeric, numeric, text, numeric, numeric, text, text, text,
                        text, text, timestamptz, text, text, jsonb),
      external_jobs_relink_duplicates(),
      external_match_save(text, text, text, numeric, text[], text[], jsonb, boolean),
      external_application_open(text, text, text, text, numeric, text, text),
      external_application_status(text, text, text, text, text)
      to app_api;
  end if;
end $$;
