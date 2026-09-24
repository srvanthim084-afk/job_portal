-- ---------------------------------------------------------------------
-- 0043 — the screening reads the resume
--
-- "AI screening" scored a candidate against a requirement using the
-- fields on their RECORD: skills, experience, education, location. The
-- resume itself was stored, parsed once into whatever empty columns it
-- could fill, and then never looked at again.
--
-- That is not what a recruiter does. A recruiter opens the CV and looks
-- for the thing the client asked for - and finds it in a project
-- description, in a line about a previous role, in the tools listed
-- under an employer. None of that is a "skill" on a profile, and all of
-- it is evidence.
--
-- The effect was plainest on the candidates imported from Naukri's
-- summary emails: the digest carries a name, a title and a company and
-- no skills at all, so every one of them scored 0 out of 45 on skills
-- and came out at 55% - not because they were unsuitable, but because
-- nothing had read anything about them.
--
-- WHY THE TEXT IS STORED RATHER THAN RE-READ
--
-- Extracting text from a PDF costs real time, and a screening that has
-- to fetch and re-parse a file cannot run on every application as it
-- arrives. The text is already in the file; this is the same data, kept
-- where it can be read cheaply and repeatedly. It sits on `candidates`,
-- behind the same row-level security as the rest of the profile, and it
-- is NOT returned by any API - `toCandidate()` does not carry it. What
-- reads it is the scorer, server-side.
-- ---------------------------------------------------------------------

alter table candidates
  add column if not exists resume_text text;

comment on column candidates.resume_text is
  'The extracted text of the stored resume, kept so the screening can '
  'read it without re-parsing the file. Never returned by an API: it is '
  'read server-side by the scorer. Written whenever a resume is stored, '
  'by upload or by email import.';

/*
 * WHEN the score was worked out.
 *
 * `ai_score` was written with no timestamp, so "is this score older than
 * the resume it should have read?" had no answer - and that is exactly
 * the question that decides whether a screening needs running again.
 */
alter table applications
  add column if not exists ai_screened_at timestamptz;

comment on column applications.ai_screened_at is
  'When ai_score was last computed. Compared against '
  'candidates.resume_uploaded_at to find scores worked out before the '
  'resume arrived.';

/*
 * Applications whose resume arrived AFTER they were screened.
 *
 * The order is not something the software controls: a candidate applies
 * and uploads their CV five minutes later; a recruiter attaches one on
 * their behalf next morning; an email import stores the resume and the
 * screening in the same breath, but a second email brings a better one.
 * In each case the score on screen was computed from a record that had
 * no resume behind it.
 *
 * This finds them so the screening can be run again, and it is a view
 * rather than a sweep so that "which scores are out of date" is a
 * question anybody can ask.
 */
create or replace view applications_needing_rescreen as
  select a.id as application_id,
         a.candidate_id,
         a.job_id,
         a.ai_score,
         a.ai_screened_at,
         c.resume_uploaded_at
    from applications a
    join candidates c on c.id = a.candidate_id
   where c.resume_storage_path is not null
     and c.resume_text is not null
     and a.ai_screened_at is not null
     and c.resume_uploaded_at > a.ai_screened_at;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant select on applications_needing_rescreen to app_api;
  end if;
end $$;
