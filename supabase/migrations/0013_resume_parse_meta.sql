-- ---------------------------------------------------------------------
-- 0013 — what we actually know about a candidate's resume, and where else
--        they can be found
--
-- PARSE METADATA
--
-- The Resume page showed "Parse confidence 92%". That number was
-- DATA.aiSettings.resumeParseConfidence - the floor an administrator sets
-- on the AI Settings screen - printed as though it were this document's
-- score. Nothing measured a per-resume confidence, so df5d38b removed the
-- tile rather than keep asserting it.
--
-- These columns are what it takes to show a real one. They record what
-- the extractor actually did with THIS file: which parser read it, how
-- much text came out, how many fields were found, and when. The
-- confidence is then computed from those, and can be explained.
--
-- PROFILE LINKS
--
-- linkedin, github and portfolio already existed. Candidates in this
-- market are also on Naukri and Indeed, and a recruiter asks for those by
-- name, so they get their own columns rather than being crammed into
-- portfolio.
-- ---------------------------------------------------------------------

alter table candidates
  add column if not exists resume_parsed_at       timestamptz,
  add column if not exists resume_parser          text,
  add column if not exists resume_chars           int,
  add column if not exists resume_fields_detected int,
  add column if not exists resume_parse_confidence int
    check (resume_parse_confidence is null
           or resume_parse_confidence between 0 and 100),
  add column if not exists resume_parse_error     text,

  add column if not exists naukri  text,
  add column if not exists indeed  text;

comment on column candidates.resume_parse_confidence is
  'Computed from what the parser found in THIS file - never a global setting.';
