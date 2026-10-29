-- ---------------------------------------------------------------------
-- 0164 - a recruiter sees the responses that came to THEM, not another recruiter's mailbox imports
--
-- applications_read let a recruiter read an application when it was assigned to them (or their team) OR when it was on a job they own.
-- The second branch meant that when recruiter B's Shine / Naukri mailbox imported a candidate onto a job that recruiter A owns (an
-- imported response attaches to the requirement of that title), A saw B's candidate too - so one recruiter (the owner of most jobs) saw
-- nearly everybody. Now an application imported from a recruiter's mailbox belongs to that mailbox's recruiter (and their team lead, and
-- Admin); the owner of the job does not see it unless it is also theirs. Everything else is unchanged: own and team applications, and
-- applications on one's own jobs that came any other way (the portal, Easy Apply, walk-ins) or that have no owner.
-- Candidates stay a shared database for searching (candidates_read is not touched).
-- ---------------------------------------------------------------------
drop policy if exists applications_read on applications;
create policy applications_read on applications for select using (
  app_is_admin()
  or candidate_id = app_candidate_id()
  or (app_role() = 'recruiter' and (
        app_recruiter_in_scope(recruiter_id)
        or (app_job_in_scope(applications.job_id)
            and (applications.import_method is distinct from 'recruiter_email' or applications.recruiter_id is null))))
  or (app_role() = 'client' and stage = any (app_client_visible_stages()) and exists (
        select 1 from jobs j where j.id = applications.job_id
          and j.company_id = app_client_company()))
);
