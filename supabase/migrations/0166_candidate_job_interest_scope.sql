-- ---------------------------------------------------------------------
-- 0166 — a department sees only ITS OWN "not interested" / "interested" answers
--
-- 0165 let any recruiter read every answer on a candidate they can see. A person who said "not interested" for a Medical job must not
-- show up for the IT desk, so the answer is readable only for a job that is in the caller's scope - the same function the rest of the
-- portal uses to keep one team's jobs away from another (app_job_in_scope, 0118: the recruiter's own jobs, and a team lead's team).
-- Admin still sees all. The Talent Pool filter (Status = Not Interested, optionally with a Linked job) reads this table under these rules,
-- so with no job chosen it lists only the answers given for the caller's own jobs.
-- ---------------------------------------------------------------------

drop policy if exists cji_read on candidate_job_interest;

create policy cji_read on candidate_job_interest for select using (
  app_is_admin()
  or (app_role() in ('recruiter', 'bde')
      and app_job_in_scope(candidate_job_interest.job_id)
      and exists (select 1 from candidates c where c.id = candidate_job_interest.candidate_id))
);
