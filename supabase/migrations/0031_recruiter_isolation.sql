-- ---------------------------------------------------------------------
-- 0031 — one recruiter, one portal
--
-- The tenancy boundary was the COMPANY: every policy asked whether the
-- job belonged to `app_recruiter_company()`. So two recruiters at the
-- same company saw each other's requirements, each other's candidates,
-- each other's pipelines and each other's notes. For a single in-house
-- team that is often what you want. For a consultancy where each
-- recruiter runs their own desk it is a leak, and it grows quietly: add
-- a colleague today and they can read everything done before they
-- arrived.
--
-- The boundary becomes the RECRUITER. What a recruiter can see is what
-- they own:
--
--   jobs          the requirements they are responsible for
--   applications  the applications on those requirements, and any
--                 application assigned to them directly
--   candidates    the people they added or imported, and anyone who has
--                 applied to one of their requirements
--
-- Admins still see everything. Candidates still see their own row and
-- their own applications. Clients are unchanged - their boundary was
-- always the company, and that is correct for a client.
--
-- The PUBLIC job board is untouched: an open job stays publicly
-- readable, because that is the point of it.
--
-- Candidates need an owner to make this work, and they had none:
-- visibility came from `is_private` alone, so every recruiter could see
-- every non-private profile in the database.
-- ---------------------------------------------------------------------

alter table candidates
  add column if not exists owner_recruiter_id text references recruiters(id) on delete set null;

create index if not exists candidates_owner_idx on candidates (owner_recruiter_id);

/**
 * Is this requirement mine?
 *
 * SECURITY DEFINER because the policies on `applications` and
 * `candidates` call it to read `jobs`, and that read is itself governed
 * by a policy - which would recurse.
 */
create or replace function app_job_is_mine(p_job_id text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from jobs j
     where j.id = p_job_id
       and j.recruiter_id is not distinct from app_recruiter_id()
  );
$$;

/** Has this person applied to one of my requirements? */
create or replace function app_candidate_is_mine(p_candidate_id text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from applications a
      join jobs j on j.id = a.job_id
     where a.candidate_id = p_candidate_id
       and (j.recruiter_id is not distinct from app_recruiter_id()
            or a.recruiter_id is not distinct from app_recruiter_id())
  );
$$;

-- ---------------------------------------------------------------------
-- jobs
-- ---------------------------------------------------------------------
drop policy if exists jobs_public_read on jobs;
create policy jobs_public_read on jobs for select using (
  -- The public board, unchanged.
  (status = 'open' and not paused and not archived
     and (expires_at is null or expires_at > now()))
  or app_is_admin()
  or (app_role() = 'recruiter' and recruiter_id is not distinct from app_recruiter_id())
  or (app_role() = 'client'    and company_id = app_client_company())
);

drop policy if exists jobs_recruiter_write on jobs;
create policy jobs_recruiter_write on jobs for all
  using (
    app_is_admin()
    or (app_role() = 'recruiter'
        -- A job with no owner yet is claimable; one with an owner is not.
        and (recruiter_id is null or recruiter_id = app_recruiter_id())))
  with check (
    app_is_admin()
    or (app_role() = 'recruiter'
        and (recruiter_id is null or recruiter_id = app_recruiter_id())));

-- ---------------------------------------------------------------------
-- candidates
-- ---------------------------------------------------------------------
drop policy if exists candidates_read on candidates;
create policy candidates_read on candidates for select using (
  app_is_admin()
  or id = app_candidate_id()
  or (app_role() = 'recruiter' and (
        owner_recruiter_id = app_recruiter_id()
        or app_candidate_is_mine(candidates.id)))
  or (app_role() = 'client'
        and app_candidate_at_company(candidates.id, app_client_company(),
                                     app_client_visible_stages()))
);

drop policy if exists candidates_self_write on candidates;
create policy candidates_self_write on candidates for update
  using (
    id = app_candidate_id() or app_is_admin()
    or (app_role() = 'recruiter' and (
          owner_recruiter_id = app_recruiter_id()
          or owner_recruiter_id is null
          or app_candidate_is_mine(candidates.id))))
  with check (
    id = app_candidate_id() or app_is_admin()
    or (app_role() = 'recruiter' and (
          owner_recruiter_id = app_recruiter_id()
          or owner_recruiter_id is null
          or app_candidate_is_mine(candidates.id))));

-- ---------------------------------------------------------------------
-- applications
-- ---------------------------------------------------------------------
drop policy if exists applications_read on applications;
create policy applications_read on applications for select using (
  app_is_admin()
  or candidate_id = app_candidate_id()
  or (app_role() = 'recruiter' and (
        recruiter_id is not distinct from app_recruiter_id()
        or app_job_is_mine(applications.job_id)))
  or (app_role() = 'client' and stage = any (app_client_visible_stages()) and exists (
        select 1 from jobs j where j.id = applications.job_id
          and j.company_id = app_client_company()))
);

drop policy if exists applications_recruiter_update on applications;
create policy applications_recruiter_update on applications for update
  using (
    app_is_admin()
    or (app_role() = 'recruiter' and (
          recruiter_id is not distinct from app_recruiter_id()
          or app_job_is_mine(applications.job_id))))
  with check (
    app_is_admin()
    or (app_role() = 'recruiter' and (
          recruiter_id is not distinct from app_recruiter_id()
          or app_job_is_mine(applications.job_id))));

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant execute on function app_job_is_mine(text), app_candidate_is_mine(text)
      to app_api;
  end if;
end $$;
