-- ---------------------------------------------------------------------
-- 0115 — external jobs: is the posting still there?
--
-- THE BUG (owner, 2026-10-06). A candidate pressed Apply Now on a
-- Databricks "AI Engineer - FDE" posting and landed on Databricks' own
-- "this page has been removed". Greenhouse's public API answered 404 for
-- that job; the board had dropped it. TeamLink still listed it as open,
-- because the ONLY way a posting was ever closed was "not seen by a sync
-- for close_grace_days (14) days" - and the sync itself had not run (the
-- sweep never ran at boot, and a restart reset its six-hour timer), and
-- EXTERNAL_SYNC_JOB_LIMIT (500) means a large board is never read whole,
-- so "not seen" cannot tell "removed" from "past the cap" anyway.
--
-- WHAT THIS ADDS
--
--   external_job_link_checks   the last answer the posting's own source
--                              gave about it: available, removed, or
--                              unknown (a network error, a timeout, a 403
--                              - never held against the job)
--   external_job_link_target   what a check needs to know about one job
--                              (its source job id and board, which the
--                              portal's apply target does not carry)
--   external_job_link_check_record
--                              records one answer; a CONFIRMED removal
--                              (404/410 from the provider's public job
--                              endpoint, or from the URL the job points
--                              at) closes the posting - closed, never
--                              deleted, admin_hold untouched, so a later
--                              sync that sees it again reopens it - with
--                              an audit row saying why, and releases any
--                              near-duplicate that was hidden behind it
--   external_jobs_release_closed_duplicates
--                              the same release for postings the stale
--                              sweep closed
--
-- Nothing here reads or writes a TeamLink table (jobs, applications,
-- candidates, ATS stages). Writes go through the definer functions only.
-- ---------------------------------------------------------------------

create table if not exists external_job_link_checks (
  external_job_id   text primary key references external_jobs(id) on delete cascade,
  checked_at        timestamptz not null default now(),
  outcome           text not null check (outcome in ('available', 'removed', 'unknown')),
  http_status       int,
  method            text,                 -- greenhouse_api | lever_api | url
  detail            text,
  checks            int not null default 1,
  removed_at        timestamptz
);
create index if not exists xlinkchk_checked_idx on external_job_link_checks (checked_at);

alter table external_job_link_checks enable row level security;
alter table external_job_link_checks force  row level security;
drop policy if exists xlinkchk_read on external_job_link_checks;
create policy xlinkchk_read on external_job_link_checks for select
  using (app_is_admin() or app_role() in ('recruiter', 'bde'));
revoke insert, update, delete on external_job_link_checks from app_api;

/* Everything a check needs, for any caller (the public Apply Now runs as
   an anonymous visitor). Carries no credential. */
create or replace function external_job_link_target(p_id text)
returns table (id text, status text, admin_hold text, application_url text, source_job_id text,
               board text, source_key text, source_name text, provider text, connector text,
               allowed_domains text[], source_active boolean)
language sql stable security definer set search_path = public as $$
  select j.id, case when s.active then j.status else 'removed' end, j.admin_hold,
         j.application_url, j.external_job_id, j.raw->>'board',
         j.source_id, s.name, s.provider, s.connector, s.allowed_domains, s.active
    from external_jobs j join job_sources s on s.id = j.source_id
   where j.id = p_id
$$;

create or replace function external_jobs_release_closed_duplicates() returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update external_jobs d set duplicate_of = null
   where d.duplicate_of is not null
     and d.status = 'open'
     and exists (select 1 from external_jobs c where c.id = d.duplicate_of and c.status <> 'open');
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function external_job_link_check_record(
  p_id text, p_outcome text, p_http int, p_method text, p_detail text
) returns table (closed boolean, status text)
language plpgsql security definer set search_path = public as $$
declare v_closed boolean := false; v_status text;
begin
  if p_outcome not in ('available', 'removed', 'unknown') then
    raise exception 'unknown link-check outcome %', p_outcome;
  end if;
  if not exists (select 1 from external_jobs where external_jobs.id = p_id) then
    return query select false, null::text;
    return;
  end if;

  insert into external_job_link_checks as k (external_job_id, checked_at, outcome, http_status, method, detail, removed_at)
  values (p_id, now(), p_outcome, p_http, left(p_method, 40), left(p_detail, 300),
          case when p_outcome = 'removed' then now() end)
  on conflict (external_job_id) do update set
      checked_at = now(), outcome = excluded.outcome, http_status = excluded.http_status,
      method = excluded.method, detail = excluded.detail, checks = k.checks + 1,
      removed_at = case when excluded.outcome = 'removed' then coalesce(k.removed_at, now()) else null end;

  if p_outcome = 'removed' then
    update external_jobs j set status = 'closed'
     where j.id = p_id and j.status = 'open' and j.admin_hold is null;
    v_closed := found;
    if v_closed then
      perform external_audit_add('job.link_removed', 'external_job', p_id,
        jsonb_build_object('status', 'open'),
        jsonb_build_object('status', 'closed', 'http', p_http, 'method', p_method),
        left('removed at the source: ' || coalesce(p_detail, 'not found'), 500));
      /* A near-duplicate hidden behind this posting is shown again. */
      update external_jobs d set duplicate_of = null where d.duplicate_of = p_id and d.status = 'open';
    end if;
  end if;

  select j.status into v_status from external_jobs j where j.id = p_id;
  return query select v_closed, v_status;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant select on external_job_link_checks to app_api;
    grant execute on function
      external_job_link_target(text),
      external_jobs_release_closed_duplicates(),
      external_job_link_check_record(text, text, int, text, text)
      to app_api;
  end if;
end $$;
