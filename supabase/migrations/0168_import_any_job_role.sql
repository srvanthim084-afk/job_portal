-- ---------------------------------------------------------------------
-- 0168 — a list may be imported for ANY job role, and for SEVERAL at once
--
-- 0167 offered a recruiter only the job roles of their own department. A recruiter (Ragini, say) who has been given radiology data has to be able
-- to import it for the radiology roles whoever those roles are assigned to: importing a list is not "working somebody else's job", it is
-- sourcing for it. So the import now offers every TeamLink job role (open and past, any department) to every recruiter, BDE and admin.
--
-- What stays department-scoped is who may READ the interested / not interested answers afterwards (0167): the Medical desk sees the answers
-- given for Medical roles. Two additions so the person who imported is never locked out of their own import:
--   candidate_job_interest.recorded_by   the recruiter profile who imported the answer (null for an admin), and a recruiter may read the answers they
--                                        recorded themselves, whatever the role's department.
-- ---------------------------------------------------------------------

alter table candidate_job_interest add column if not exists recorded_by text;

create or replace function app_can_import_for_job(p_job_id text) returns boolean
language sql stable security definer set search_path = public as $$
  select app_role() in ('recruiter', 'bde', 'admin')
     and exists (select 1 from jobs j where j.id = p_job_id and j.id like 'tl\_%')
$$;

create or replace function app_import_jobs(p_q text default '')
returns table (id text, title text, location text, status text, department text)
language sql stable security definer set search_path = public as $$
  select j.id, j.title, j.location, j.status, j.department
    from jobs j
   where app_role() in ('recruiter', 'bde', 'admin')
     and j.id like 'tl\_%'
     and (coalesce(p_q, '') = '' or j.title ilike '%' || p_q || '%')
   order by (j.status = 'open') desc, j.published_at desc nulls last, j.id
   limit 600
$$;

drop policy if exists cji_read on candidate_job_interest;
create policy cji_read on candidate_job_interest for select using (
  app_is_admin()
  or (app_role() in ('recruiter', 'bde')
      and (app_job_in_department(candidate_job_interest.job_id)
           or (candidate_job_interest.recorded_by is not null and candidate_job_interest.recorded_by = app_recruiter_id()))
      and exists (select 1 from candidates c where c.id = candidate_job_interest.candidate_id))
);

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant execute on function app_can_import_for_job(text) to app_api;
    grant execute on function app_import_jobs(text) to app_api;
  end if;
end $$;
