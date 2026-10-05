-- ---------------------------------------------------------------------
-- 0113 — Job source separation (owner, 2026-10-05)
--
--   JOBS PAGE          = TEAMLINK jobs only
--   EXTERNAL JOBS PAGE = EXTERNAL jobs only
--   never mixed, and enforced by the query rather than hidden afterwards.
--
-- WHERE EACH KIND LIVES (audited before this was written):
--
--   jobs            every row is written by TeamLink itself - the recruiter
--                   / admin job form (POST /api/jobs), requirement intake
--                   (source 'intake'), bulk posting, the walk-in drive
--                   migration (0106). No importer writes here.
--   external_jobs   every row came from an external source (Naukri, Shine,
--                   Indeed, LinkedIn, Greenhouse, Lever, feeds...), with
--                   its source in job_sources (name, provider). The
--                   API already says so: jobSourceType / jobSourceName
--                   (0108, api/src/external/shapes.js).
--
-- The table a row is in was therefore the only identifier, and a free-text
-- `jobs.source` column that the API accepts could, in principle, name an
-- external portal. So `jobs` gets ONE normalised field, source_type
-- (TEAMLINK | EXTERNAL), with the owner's names:
--
--   - existing rows are CLASSIFIED, not edited: an id that is an external
--     id, or a `source` naming an external portal/feed, is EXTERNAL; every
--     other row is TEAMLINK. Each decision is written to job_source_audit.
--     No job is deleted and no other column changes.
--   - a new row is TEAMLINK automatically (the trigger below), whatever the
--     writer sends: the recruiter never selects it. An import never writes
--     here - it writes external_jobs, which is EXTERNAL by definition and
--     keeps its source name.
--   - jobs_open - what every candidate-facing Jobs-page query reads - now
--     says `source_type = 'TEAMLINK'` itself.
--
-- Saved searches remember the dataset they were made on (source_type), so
-- running one later can never widen it.
-- ---------------------------------------------------------------------

/* ===================================================================== *
 * 1. the field, and the audit of the rows already there
 * ===================================================================== */
alter table jobs add column if not exists source_type text;

create table if not exists job_source_audit (
  id           bigserial primary key,
  job_id       text not null,
  source_type  text not null check (source_type in ('TEAMLINK', 'EXTERNAL')),
  source_name  text,
  reason       text not null,
  audited_at   timestamptz not null default now()
);
create index if not exists job_source_audit_job on job_source_audit (job_id, audited_at desc);

comment on table job_source_audit is
  'How each jobs row was classified TEAMLINK / EXTERNAL (0113), and any later reclassification. Read-only history; nothing is deleted.';

/* The names of external portals, feeds and aggregators a `source` might
   carry. Matched as whole words, case-insensitively. */
create or replace function job_source_is_external_name(p text) returns boolean
language sql immutable as $$
  select coalesce(p, '') ~* ('(^|[^a-z])(naukri|indeed|shine|linkedin|monster|foundit|glassdoor|timesjobs|apna|'
    || 'workindia|internshala|greenhouse|lever|remotive|adzuna|jooble|jsearch|serpapi|ziprecruiter|'
    || 'external|aggregator|job ?feed)([^a-z]|$)')
$$;

do $$
begin
  /* First run only: rows that have no classification yet. */
  insert into job_source_audit (job_id, source_type, source_name, reason)
  select j.id,
         case when j.id ~ '^xjob_' or job_source_is_external_name(j.source) then 'EXTERNAL' else 'TEAMLINK' end,
         case when j.id ~ '^xjob_' or job_source_is_external_name(j.source) then nullif(btrim(j.source), '') else 'TeamLink' end,
         case when j.id ~ '^xjob_' then 'initial audit: an external job id'
              when job_source_is_external_name(j.source) then 'initial audit: source names an external portal ("' || j.source || '")'
              when j.source = 'intake' then 'initial audit: requirement intake (posted by TeamLink)'
              else 'initial audit: posted through TeamLink' end
    from jobs j
   where j.source_type is null;

  update jobs j
     set source_type = case when j.id ~ '^xjob_' or job_source_is_external_name(j.source) then 'EXTERNAL' else 'TEAMLINK' end
   where j.source_type is null;
end $$;

alter table jobs alter column source_type set default 'TEAMLINK';
alter table jobs alter column source_type set not null;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'jobs_source_type_check') then
    alter table jobs add constraint jobs_source_type_check check (source_type in ('TEAMLINK', 'EXTERNAL'));
  end if;
end $$;
create index if not exists jobs_source_type_idx on jobs (source_type);

comment on column jobs.source_type is
  'TEAMLINK (posted through TeamLink) | EXTERNAL (classified as an external job by the 0113 audit). Set by the database, never by the writer.';

/* ===================================================================== *
 * 2. new rows are TEAMLINK; the value is not the writer's to change
 * ===================================================================== */
create or replace function jobs_source_type_guard() returns trigger
language plpgsql as $$
begin
  /* job_source_reclassify() below is the one way to change it. */
  if coalesce(current_setting('teamlink.job_source_reclassify', true), '') = 'on' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.source_type := 'TEAMLINK';
  else
    new.source_type := old.source_type;
  end if;
  return new;
end $$;

drop trigger if exists jobs_source_type_guard on jobs;
create trigger jobs_source_type_guard before insert or update on jobs
  for each row execute function jobs_source_type_guard();

/* Reclassify one job, with the reason recorded. Database owner only (not
   granted to the API role): a correction is a deliberate act. */
create or replace function job_source_reclassify(p_job text, p_type text, p_reason text)
returns text
language plpgsql security definer set search_path = public as $$
declare v_name text;
begin
  if p_type not in ('TEAMLINK', 'EXTERNAL') then
    raise exception 'source type must be TEAMLINK or EXTERNAL' using errcode = '22023';
  end if;
  perform set_config('teamlink.job_source_reclassify', 'on', true);
  update jobs set source_type = p_type where id = p_job returning source into v_name;
  perform set_config('teamlink.job_source_reclassify', 'off', true);
  if not found then return null; end if;
  insert into job_source_audit (job_id, source_type, source_name, reason)
  values (p_job, p_type, case when p_type = 'TEAMLINK' then 'TeamLink' else nullif(btrim(v_name), '') end,
          coalesce(nullif(btrim(p_reason), ''), 'reclassified'));
  return p_type;
end $$;
revoke all on function job_source_reclassify(text, text, text) from public;

/* ===================================================================== *
 * 3. the views: same bodies as 0106, and jobs_open is TeamLink's only
 * ===================================================================== */
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
  'What the Jobs page may list: Active TeamLink jobs only (0113), no walk-in whose date and end time have passed (0106).';

/* ===================================================================== *
 * 4. a saved search remembers which dataset it was made on
 * ===================================================================== */
alter table candidate_saved_searches add column if not exists source_type text not null default 'TEAMLINK';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'candidate_saved_searches_source_type_check') then
    alter table candidate_saved_searches add constraint candidate_saved_searches_source_type_check
      check (source_type in ('TEAMLINK', 'EXTERNAL'));
  end if;
end $$;
/* The same filters on the two pages are two different searches. */
drop index if exists saved_searches_filters_uq;
create unique index if not exists saved_searches_filters_uq
  on candidate_saved_searches (candidate_id, source_type, filters_key);

comment on column candidate_saved_searches.source_type is
  'The dataset the search was made on and is always run against: TEAMLINK (the Jobs page) or EXTERNAL (External Jobs). 0113.';

/* The alert engine's list, now with the scope (return type changes, so
   the function is replaced rather than redefined). */
drop function if exists saved_search_engine_list(text[]);
create function saved_search_engine_list(p_freq text[])
returns table (id text, candidate_id text, label text, filters jsonb,
               alert_frequency text, channels text[],
               last_alerted_at timestamptz, last_digest_at timestamptz,
               created_at timestamptz, source_type text)
language plpgsql security definer set search_path = public as $$
begin
  perform saved_search_engine_guard();
  return query
    select s.id, s.candidate_id, s.label, s.filters, s.alert_frequency, s.channels,
           s.last_alerted_at, s.last_digest_at, s.created_at, s.source_type
      from candidate_saved_searches s
     where s.alert_frequency = any(p_freq);
end $$;

/* ===================================================================== *
 * 5. the audit, for the administrator
 * ===================================================================== */
create or replace function job_source_summary()
returns table (dataset text, source_type text, source_name text, open_jobs bigint, all_jobs bigint)
language sql stable security invoker set search_path = public as $$
  select 'jobs', j.source_type,
         case when j.source_type = 'TEAMLINK' then 'TeamLink' else coalesce(nullif(btrim(j.source), ''), 'External') end,
         count(*) filter (where j.status = 'open' and not j.paused and not j.archived),
         count(*)
    from jobs j group by 2, 3
  union all
  select 'external_jobs', 'EXTERNAL', coalesce(s.name, x.source_id),
         count(*) filter (where x.status = 'open'), count(*)
    from external_jobs x left join job_sources s on s.id = x.source_id
   group by 3
  order by 1, 2, 3
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant select on jobs_with_counts, jobs_open to app_api;
    grant select on job_source_audit to app_api;
    grant execute on function job_source_is_external_name(text) to app_api;
    grant execute on function saved_search_engine_list(text[]) to app_api;
    grant execute on function job_source_summary() to app_api;
  end if;
end $$;
