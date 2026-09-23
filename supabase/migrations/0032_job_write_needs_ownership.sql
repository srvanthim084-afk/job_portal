-- ---------------------------------------------------------------------
-- 0032 — an unowned requirement is not a free-for-all
--
-- 0031 let a recruiter write any job whose recruiter_id was null, so an
-- unclaimed requirement could be claimed. That was meant to keep seeded
-- and imported rows editable. It is a hole: EVERY recruiter passes
-- "recruiter_id is null", so one recruiter could rewrite another
-- company's unassigned requirement - and the RLS suite caught exactly
-- that ("r2 rewrote j1").
--
-- Writing now needs ownership. Creating does not, because the route sets
-- recruiter_id from the session and a row cannot be owned before it
-- exists; an admin assigns anything that is genuinely unowned.
-- ---------------------------------------------------------------------

drop policy if exists jobs_recruiter_write on jobs;

create policy jobs_recruiter_insert on jobs for insert
  with check (
    app_is_admin()
    or (app_role() = 'recruiter'
        and (recruiter_id is null or recruiter_id = app_recruiter_id())));

create policy jobs_recruiter_update on jobs for update
  using      (app_is_admin() or (app_role() = 'recruiter'
                                 and recruiter_id = app_recruiter_id()))
  with check (app_is_admin() or (app_role() = 'recruiter'
                                 and recruiter_id = app_recruiter_id()));

create policy jobs_recruiter_delete on jobs for delete
  using (app_is_admin() or (app_role() = 'recruiter'
                            and recruiter_id = app_recruiter_id()));
