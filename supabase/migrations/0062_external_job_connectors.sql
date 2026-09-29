-- ---------------------------------------------------------------------
-- 0062 — named connectors, dismissing a match, and the index the
--        hundred-job query needs
--
-- 0049 built the external-jobs tables around ONE way of collecting:
-- a feed URL and an optional bearer token. That is enough for a partner
-- feed written to order and enough for nothing else. Adzuna wants its
-- credentials as query parameters, JSearch wants RapidAPI headers,
-- Jooble wants a POST with the key in the path, and Greenhouse and Lever
-- want a board token per company. None of those is "a URL and a token".
--
-- So a source may now name a CONNECTOR - a piece of code that knows one
-- board's dialect (api/src/external/connectors.js) - and the existing
-- `manual`, `feed` and `api` methods keep working exactly as they did.
--
-- ADDITIVE ONLY. No column is dropped, no table is renamed, and the
-- check constraint is WIDENED, so every row already stored stays valid.
-- ---------------------------------------------------------------------

alter table job_sources
  add column if not exists connector text;

comment on column job_sources.connector is
  'Which adapter in api/src/external/connectors.js collects for this source (adzuna, jooble, jsearch, remotive, greenhouse, lever, …). Null for feed/api/manual sources.';

/*
 * One more collection method, beside the three that exist.
 * Widened, never narrowed: everything the old constraint accepted is
 * still accepted.
 */
alter table job_sources drop constraint if exists job_sources_job_collection_method_check;
alter table job_sources add constraint job_sources_job_collection_method_check
  check (job_collection_method in ('manual', 'feed', 'api', 'connector'));

-- ---------------------------------------------------------------------
-- "not interested"
--
-- A candidate who has looked at a job and does not want it should not be
-- shown it again every time the list is rebuilt. Recorded on the MATCH
-- rather than on the job, because it is this candidate's opinion and not
-- a fact about the posting - somebody else may still want it.
--
-- Nullable and defaulted to nothing, so every existing match is
-- "not dismissed" without being touched.
-- ---------------------------------------------------------------------
alter table candidate_external_job_matches
  add column if not exists dismissed_at timestamptz;

create index if not exists cejm_live_idx
  on candidate_external_job_matches (candidate_id, match_percentage desc)
  where dismissed_at is null;

-- ---------------------------------------------------------------------
-- the index the hundred-job query reads
--
-- `candidate_external_job_matches (candidate_id, match_percentage desc)`
-- already exists from 0049 and is the half that matters most. This is
-- the other half: the join filters open, non-duplicate postings and
-- orders the ties by how recently they were posted.
-- ---------------------------------------------------------------------
create index if not exists xjob_live_idx
  on external_jobs (status, posted_at desc nulls last)
  where duplicate_of is null;

-- ---------------------------------------------------------------------
-- when a posting was last seen in a sync
--
-- A job that stops appearing in its source's feed has been taken down.
-- `synced_at` records the last time it was returned, so the sweep can
-- mark anything unseen for a fortnight as closed rather than leaving
-- dead postings in front of candidates for ever. The column exists;
-- this is the index that makes finding the stale ones cheap.
-- ---------------------------------------------------------------------
create index if not exists xjob_stale_idx
  on external_jobs (synced_at)
  where status = 'open';
