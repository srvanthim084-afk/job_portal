-- ---------------------------------------------------------------------
-- 0167 — a DEPARTMENT's job roles: the list the import offers, and who may read the "interested / not interested" answers
--
-- Jobs that come from the ATS (tl_...) are written by the portal's TeamLink integration with no recruiter owner, so the recruiter-owner
-- rule (app_job_in_scope, 0118) matches none of them: a recruiter's own-jobs list was empty and 0166 would have hidden every answer from
-- every recruiter. What a TeamLink job DOES carry is its department (jobs.department, from the requirement), and a recruiter carries
-- theirs (recruiters.department, set from TeamLink). So the department is the scope:
--
--   app_job_in_department(job)   admin: any job. Anybody else: a job of THEIR department. Education / Educational, Manufacture /
--                                Manufacturing, Medical / Med... are compared on their first four letters, the way the desks already are.
--   app_import_jobs(q)           the job roles the caller may import a list FOR: TeamLink jobs of their department, closed ones included
--                                (a past requirement is still a requirement), open first.
--
-- candidate_job_interest is then readable for a job of the caller's department only: the Medical desk sees what was said for Medical roles,
-- the IT desk for IT roles, and neither sees the other's. Admin sees all.
-- ---------------------------------------------------------------------

create or replace function app_dept_key(p text) returns text
language sql immutable as $$
  select nullif(left(lower(regexp_replace(coalesce(p, ''), '[^A-Za-z]', '', 'g')), 4), '')
$$;

create or replace function app_job_in_department(p_job_id text) returns boolean
language sql stable security definer set search_path = public as $$
  select app_is_admin()
      or exists (select 1
                   from jobs j
                   join recruiters r on r.id = app_recruiter_id()
                  where j.id = p_job_id
                    and app_dept_key(j.department) is not null
                    and app_dept_key(j.department) = app_dept_key(r.department))
$$;

create or replace function app_import_jobs(p_q text default '')
returns table (id text, title text, location text, status text, department text)
language sql stable security definer set search_path = public as $$
  select j.id, j.title, j.location, j.status, j.department
    from jobs j
   where j.id like 'tl\_%'
     and app_job_in_department(j.id)
     and (coalesce(p_q, '') = '' or j.title ilike '%' || p_q || '%')
   order by (j.status = 'open') desc, j.published_at desc nulls last, j.id
   limit 300
$$;

drop policy if exists cji_read on candidate_job_interest;
create policy cji_read on candidate_job_interest for select using (
  app_is_admin()
  or (app_role() in ('recruiter', 'bde')
      and app_job_in_department(candidate_job_interest.job_id)
      and exists (select 1 from candidates c where c.id = candidate_job_interest.candidate_id))
);

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant execute on function app_dept_key(text) to app_api;
    grant execute on function app_job_in_department(text) to app_api;
    grant execute on function app_import_jobs(text) to app_api;
  end if;
end $$;
