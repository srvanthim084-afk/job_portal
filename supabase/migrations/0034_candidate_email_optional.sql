-- ---------------------------------------------------------------------
-- 0034 — a candidate without an email address is still a candidate
--
-- Naukri's response digest carries a great deal about each applicant -
-- name, current role and employer, experience, CTC, notice period,
-- location, education, skills - and no email address or phone number at
-- all. Contact details stay behind the "View" link on Naukri's own site.
--
-- `candidates.email` was NOT NULL, so there was no halfway house: 87
-- real applications could not be created at all, and the intake could
-- only mark them "needs review" and lose the rest of what it had already
-- read. Throwing away a real application because one field is absent is
-- the worst available answer.
--
-- The address becomes optional. What depends on it degrades honestly
-- rather than breaking:
--
--   candidate_portal_account()  already returns 'no email address' and
--                               creates nothing
--   every send                  already records skipped_no_address
--   the retry queue             already requires a non-empty address
--
-- So an imported candidate with no address simply cannot be written to
-- until somebody adds one, which is the truth of the situation.
-- ---------------------------------------------------------------------

alter table candidates alter column email drop not null;

-- An empty string is not an address, and would defeat every check that
-- asks whether one is present. Normalise it away.
update candidates set email = null where btrim(coalesce(email, '')) = '';

alter table candidates
  add constraint candidates_email_not_blank
  check (email is null or btrim(email) <> '');
