-- ---------------------------------------------------------------------
-- 0058 — what the recruiter agreed with the candidate about an interview
--
-- The manual entry form asks whether an interview is needed, of what
-- kind, in what mode, when, with whom and where. None of that can be
-- SCHEDULED at the moment it is typed: an interview in this system
-- belongs to an application, and a candidate entered by hand may not yet
-- have one. Scheduling it anyway would be inventing an application, and
-- the brief is explicit that an interview must not be scheduled unless
-- the recruiter chooses to.
--
-- So it is recorded as what it actually is - an intention agreed on a
-- phone call - and it is there, complete, when the candidate is put
-- forward for a requirement. Throwing it away because there is nowhere
-- tidy to put it would lose the one thing the recruiter learnt by
-- ringing them.
--
-- jsonb rather than nine columns because nothing queries it: it is read
-- back whole, on one screen, by the person who wrote it.
-- ---------------------------------------------------------------------
alter table candidates
  add column if not exists interview_prefs jsonb;

comment on column candidates.interview_prefs is
  'Interview intent captured on the manual entry form. NOT a scheduled interview - those live on applications.';
