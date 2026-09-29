-- ---------------------------------------------------------------------
-- 0050 — removing an external source, and a posting that has gone
--
-- 0049 could add a source and could not take one away, which is not a
-- state anything should be left in: a feed that turns out to be wrong,
-- or a partner whose contract ends, has to be removable, and the jobs it
-- brought in with it have to go too.
--
-- Separate file because 0049 is already applied and the migration runner
-- is tamper-evident on purpose - editing an applied file aborts the run
-- rather than leaving a database nobody can reproduce.
--
-- WHAT A DELETE REACHES. `external_jobs`, `candidate_external_job_matches`
-- and `external_applications` cascade from the source, so removing one
-- removes everything that came from it. It CANNOT reach a candidate: the
-- foreign key runs from the external tables INTO `candidates`, so the
-- cascade only ever travels away from TeamLink's own data. Deleting every
-- external source in the system does not alter one candidate row, one
-- job, one application or one ATS stage.
-- ---------------------------------------------------------------------

/*
 * Remove a source and everything collected through it.
 *
 * Returns what went with it, because "deleted" is not a useful answer
 * when the caller is about to tell somebody how much history just
 * disappeared.
 */
create or replace function external_source_delete(p_id text)
returns table (removed_jobs int, removed_matches int, removed_applications int)
language plpgsql security definer set search_path = public as $$
declare j int; m int; a int;
begin
  select count(*) into j from external_jobs where source_id = p_id;
  select count(*) into a from external_applications where source_id = p_id;
  select count(*) into m from candidate_external_job_matches x
    where exists (select 1 from external_jobs e
                   where e.id = x.external_job_id and e.source_id = p_id);

  delete from job_sources where id = p_id;

  removed_jobs := j;
  removed_matches := m;
  removed_applications := a;
  return next;
end $$;

/*
 * Remove one posting.
 *
 * For a job that was collected wrongly or withdrawn by the advertiser.
 * Marking it closed is usually better - a closed posting keeps the
 * history of who applied to it - so this exists for the case where the
 * row should never have been there at all.
 */
create or replace function external_job_delete(p_id text) returns boolean
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  delete from external_jobs where id = p_id;
  get diagnostics n = row_count;
  return n > 0;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant execute on function
      external_source_delete(text),
      external_job_delete(text)
      to app_api;
  end if;
end $$;
