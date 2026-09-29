-- ---------------------------------------------------------------------
-- 0085 — a board's category tags are not the job's required skills
--
-- The Remotive connector stored that board's `tags` array in
-- external_jobs.skills, and the matcher reads that column as "what the
-- employer asked for". The tags are a browsing taxonomy applied broadly,
-- so read as requirements they are simply wrong. Measured on the ten
-- Remotive rows on file:
--
--   "Freelance Writer"        -> ["REST"]
--   "Remote Office Assistant" -> ["CSS","git","magento","photoshop",
--                                 "php","shopify","wordpress", ... 19]
--   "Freelance Copywriter"    -> ["accounting","quickbooks", ... 10]
--
-- That did real damage rather than looking untidy: a Python graduate
-- came back as a 93% match for the writing job, because its single
-- "required skill" was REST, she lists "REST APIs", and one of one is a
-- hundred per cent of the largest component in the score.
--
-- The connector no longer writes them (connectors.js), which fixes every
-- future sync. This clears the rows already stored, so the matcher falls
-- through to reading skills out of the posting's own description - which
-- is what it already does for the other 130 jobs, none of which carry a
-- skills array at all.
--
-- NOTHING IS DELETED. Only the skills column is emptied, and only where
-- a connector filled it from a tag list. The description, the title and
-- the apply URL are untouched, and the postings stay exactly as
-- reachable as they were.
-- ---------------------------------------------------------------------
update external_jobs j
   set skills = '{}',
       updated_at = now()
  from job_sources s
 where s.id = j.source_id
   and s.connector = 'remotive'
   and coalesce(array_length(j.skills, 1), 0) > 0;

comment on column external_jobs.skills is
  'What the EMPLOYER stated as required, and only that. A board''s own category tags are not requirements (0085) - where a posting states nothing, the matcher reads the description instead.';
