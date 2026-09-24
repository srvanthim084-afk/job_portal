-- =====================================================================
-- A delivery that was deliberately not attempted, because the address
-- cannot receive anything.
--
-- WHY THIS EXISTS. RFC 2606 and RFC 6761 set aside example.com,
-- example.net, example.org and the .test, .example, .invalid and
-- .localhost top-level domains so that documentation and testing can use
-- addresses that reach nobody. The verification tools in this repository
-- create candidates on example.com by design, and every interview and
-- application they exercised sent a real message to an address that
-- cannot exist: the mail server accepted it, found no such domain, and
-- returned it. The recruiter's mailbox filled with "Address not found",
-- and a steady stream of bounces is how a provider learns to distrust a
-- sender.
--
-- The provider now declines to send to those domains. That decision has
-- to be recordable, because the audit trail answers "what did we send
-- this person" and "we chose not to, and here is why" is an answer -
-- whereas leaving it out would make the row look lost.
--
-- It is NOT `failed`: nothing went wrong and there is nothing to fix.
-- It is NOT `skipped_no_address`: there IS an address, it simply has no
-- inbox behind it. The difference matters when somebody is looking for
-- candidates nobody could reach.
--
-- Widening a CHECK constraint accepts every row that was valid before,
-- so this cannot fail on existing data.
-- =====================================================================

alter table notification_deliveries
  drop constraint if exists notification_deliveries_status_check;

alter table notification_deliveries
  add constraint notification_deliveries_status_check
  check (status in (
    'sent',
    'failed',
    'not_configured',
    'not_applicable',
    'skipped_no_address',
    -- The address is on a domain reserved for testing. Nothing was sent
    -- and nothing should have been.
    'skipped_test_address'
  ));
