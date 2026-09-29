-- ---------------------------------------------------------------------
-- 0055 — a candidate can read the board a job came from
--
-- THE BUG. external_jobs is readable by a candidate, and job_sources was
-- not. Every query that returns a job JOINS its source - to show "via
-- Naukri" on the card, and to know whether the posting can be applied to
-- at all - so for a candidate the join matched nothing and the whole
-- result came back empty. A candidate signed in, opened External Jobs,
-- and saw "No external jobs have been matched to you yet" while 49 of
-- them sat in the table.
--
-- Matching was broken the same way and for the same reason: the matcher
-- asks for the open jobs as the candidate, got none, and stored no
-- matches. So did applying - applyExternally reads the source to find the
-- application method, got null, and would have refused every posting with
-- "this source cannot be applied to through TeamLink".
--
-- The RLS verifier missed it because it checked that a candidate can read
-- external_jobs, which is true. It is the JOIN that fails, and a table
-- read on its own never exercises one.
--
-- WHY THIS IS SAFE TO OPEN. A job_sources row holds the board's name, how
-- jobs arrive, how an application is submitted, whether the board permits
-- automation, and when it last synced. The one field that sounds
-- sensitive is `credential_env`, and it holds the NAME of an environment
-- variable - never a key. That was decided in 0049 precisely so that a
-- database dump carries no secret, and it is what makes this row
-- ordinary enough to show.
--
-- WRITES ARE UNCHANGED. A candidate still cannot insert, update or delete
-- a source: the no_direct_write policy is untouched, and every write goes
-- through the definer functions as before.
-- ---------------------------------------------------------------------

drop policy if exists jsrc_read on job_sources;

create policy jsrc_read on job_sources for select using (
  app_is_admin()
  or app_role() in ('recruiter', 'bde', 'candidate', 'client')
);

comment on table job_sources is
  'Where external jobs come from. Readable by any signed-in user because every job query joins it (0055); writable only through external_source_save. Holds the NAME of a credential environment variable, never a key.';
