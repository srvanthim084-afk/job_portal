-- ---------------------------------------------------------------------
-- 0081 — recording the invitation we deliberately did not send
--
-- `candidate_invites.status` (0023) allows four words: sent, failed,
-- not_configured, skipped_no_address. The email provider produces two
-- more, and both are deliberate refusals rather than errors:
--
--   skipped_test_address     — the address is a test one (.invalid,
--                              example.com), so nothing was sent on
--                              purpose.
--   blocked_not_allowlisted  — the operator restricted outbound mail to
--                              an allowlist and this address is not on
--                              it. Added because real people were being
--                              written to during testing.
--
-- Neither could be recorded. The INSERT raised, which aborted the
-- surrounding transaction, and the recruiter adding the candidate was
-- told "the invitation could not be sent" with no record of the attempt
-- kept anywhere - so the one table that exists to answer "did this
-- person ever get their login, and why not" could not answer it for
-- precisely the cases where the answer is not obvious.
--
-- Measured before this migration, adding one candidate with a test
-- address:
--   [candidates] the invitation failed after the reply: new row for
--   relation "candidate_invites" violates check constraint
--   "candidate_invites_status_check"
--
-- Widening a CHECK cannot fail on existing rows: every value that
-- satisfied the old list still satisfies the longer one.
-- ---------------------------------------------------------------------
alter table candidate_invites drop constraint if exists candidate_invites_status_check;

alter table candidate_invites add constraint candidate_invites_status_check
  check (status in ('sent', 'failed', 'not_configured', 'skipped_no_address',
                    'skipped_test_address', 'blocked_not_allowlisted'));

comment on column candidate_invites.status is
  'What happened to this attempt. "sent" is the only one that means a message left. The three "skipped"/"blocked"/"not_configured" values are choices or gaps, not failures, and are kept apart from "failed" so a recruiter reading the history is not told a delivery was refused when nobody tried.';

/*
 * The invite that decides whether they can sign in reads only 'sent'
 * (0023:98), and that stays exactly as it is - a message we chose not to
 * send must not count as one they received.
 */
