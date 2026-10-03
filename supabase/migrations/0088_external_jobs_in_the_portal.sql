-- ---------------------------------------------------------------------
-- 0088 — external jobs inside the TeamLink job portal
--
-- External jobs already have their own table (0049): they come from
-- somebody else's system, have no TeamLink company, recruiter or
-- application pipeline, and the ATS reads `jobs`. Folding them into
-- `jobs` would put vacancies TeamLink cannot fill into every recruiter
-- screen and every applicant count. So they stay where they are, and
-- what changes is that the job portal shows them.
--
--   external_portal_jobs(...)   the candidate-facing listing: open,
--                               one row per vacancy (duplicates folded),
--                               searchable, filterable by source. Callable
--                               by anybody, including a visitor who is not
--                               signed in, because the public job board is
--                               where candidates look first.
--   external_portal_job(id)     one of them, any status, for its page.
--
-- Neither returns the stored application URL, the raw payload or the
-- source's internal ids beyond what a candidate needs: the URL is used
-- by the server's redirect (GET /api/portal/external-jobs/:id/apply),
-- never handed out to be followed blindly.
--
--   external_sync_runs          one row per sync of one source: fetched,
--                               created, updated, closed, duplicates,
--                               errors. For the Job Sources screen.
-- ---------------------------------------------------------------------

create table if not exists external_sync_runs (
  id            bigserial primary key,
  source_id     text references job_sources(id) on delete cascade,
  kind          text not null default 'sync' check (kind in ('sync', 'expire')),
  started_at    timestamptz not null default now(),
  completed_at  timestamptz,
  status        text not null,
  fetched       int not null default 0,
  created       int not null default 0,
  updated       int not null default 0,
  closed        int not null default 0,
  duplicates    int not null default 0,
  skipped       int not null default 0,
  error         text
);
create index if not exists external_sync_runs_when on external_sync_runs (started_at desc);

alter table external_sync_runs enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies
                  where tablename = 'external_sync_runs' and policyname = 'exsync_staff_read') then
    create policy exsync_staff_read on external_sync_runs for select
      using (app_is_admin() or app_role() in ('recruiter', 'bde'));
  end if;
end $$;

create or replace function external_sync_run_record(
  p_source text, p_kind text, p_started timestamptz, p_status text,
  p_fetched int, p_created int, p_updated int, p_closed int,
  p_duplicates int, p_skipped int, p_error text
) returns bigint
language plpgsql security definer set search_path = public as $$
declare v_id bigint;
begin
  insert into external_sync_runs (source_id, kind, started_at, completed_at, status,
    fetched, created, updated, closed, duplicates, skipped, error)
  values (p_source, coalesce(p_kind, 'sync'), coalesce(p_started, now()), now(), p_status,
    coalesce(p_fetched, 0), coalesce(p_created, 0), coalesce(p_updated, 0), coalesce(p_closed, 0),
    coalesce(p_duplicates, 0), coalesce(p_skipped, 0), left(p_error, 500))
  returning id into v_id;
  return v_id;
end $$;

/* What a candidate sees of an external job. */
create or replace function external_portal_jobs(
  p_q text, p_source text, p_limit int, p_offset int
) returns table (
  id text, title text, company text, location text, experience text, salary text,
  salary_min numeric, salary_max numeric, skills text[], description text,
  employment_type text, education text, posted_at timestamptz, synced_at timestamptz,
  status text, source_key text, source_name text, original_publisher text, total bigint
)
language sql stable security definer set search_path = public as $$
  with hits as (
    select j.*, s.name as s_name
      from external_jobs j join job_sources s on s.id = j.source_id
     where j.status = 'open'
       and j.duplicate_of is null
       and s.active                    -- a source switched off is not shown
       and (coalesce(p_source, '') = '' or j.source_id = p_source)
       and (coalesce(btrim(p_q), '') = ''
            or j.title ilike '%' || btrim(p_q) || '%'
            or j.company ilike '%' || btrim(p_q) || '%'
            or j.location ilike '%' || btrim(p_q) || '%'
            or array_to_string(j.skills, ' ') ilike '%' || btrim(p_q) || '%')
  )
  select h.id, h.title, h.company, h.location, h.experience, h.salary,
         h.salary_min, h.salary_max, h.skills, left(h.description, 600),
         h.employment_type, h.education, h.posted_at, h.synced_at,
         h.status, h.source_id, h.s_name, h.original_publisher,
         count(*) over () as total
    from hits h
   order by h.posted_at desc nulls last, h.synced_at desc
   limit least(greatest(coalesce(p_limit, 50), 1), 500)
  offset greatest(coalesce(p_offset, 0), 0)
$$;

create or replace function external_portal_job(p_id text)
returns table (
  id text, title text, company text, location text, experience text, salary text,
  salary_min numeric, salary_max numeric, skills text[], description text,
  employment_type text, education text, posted_at timestamptz, synced_at timestamptz,
  status text, source_key text, source_name text, original_publisher text
)
language sql stable security definer set search_path = public as $$
  select j.id, j.title, j.company, j.location, j.experience, j.salary,
         j.salary_min, j.salary_max, j.skills, j.description,
         j.employment_type, j.education, j.posted_at, j.synced_at,
         case when s.active then j.status else 'removed' end,
         j.source_id, s.name, j.original_publisher
    from external_jobs j join job_sources s on s.id = j.source_id
   where j.id = p_id
$$;

/* The stored destination, for the server's redirect only. */
create or replace function external_portal_apply_target(p_id text)
returns table (id text, status text, application_url text, source_key text, source_name text,
               connector text)
language sql stable security definer set search_path = public as $$
  select j.id, case when s.active then j.status else 'removed' end,
         j.application_url, j.source_id, s.name, s.connector
    from external_jobs j join job_sources s on s.id = j.source_id
   where j.id = p_id
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant select on external_sync_runs to app_api;
    grant usage, select on sequence external_sync_runs_id_seq to app_api;
    grant execute on function external_sync_run_record(
      text, text, timestamptz, text, int, int, int, int, int, int, text) to app_api;
    grant execute on function external_portal_jobs(text, text, int, int) to app_api;
    grant execute on function external_portal_job(text) to app_api;
    grant execute on function external_portal_apply_target(text) to app_api;
  end if;
end $$;
