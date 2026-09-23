-- ---------------------------------------------------------------------
-- 0026 — a mailbox can be disconnected, but not removed
--
-- Disconnecting a mailbox stops future syncs and leaves every message it
-- ever produced sitting in the intake queue. For a sample mailbox that
-- is exactly the wrong outcome, and for a mailbox connected by mistake -
-- a typo'd address, the wrong account - it means the mistake stays on
-- the screen forever.
--
-- Deleting was refused outright, because app_api has SELECT, INSERT and
-- UPDATE on everything but DELETE on a short explicit list, and these
-- two are not on it. That default is right: the API must not be able to
-- delete most things. But a mailbox is intake CONFIGURATION, not a
-- person and not a record of work - the same recruiter who connected it
-- should be able to take it off again.
--
-- So the grant is added for these two tables only. RLS still decides
-- which rows: staff, never a candidate. Messages go with their mailbox
-- through the existing cascade, and the applications already created
-- from them are untouched - deleting somebody's application because a
-- mailbox was removed would be a far worse surprise.
-- ---------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant delete on email_mailboxes, email_messages to app_api;
  end if;
end $$;

-- Staff only, matching the read policy. A candidate has no business
-- touching a recruiter's inbox configuration.
drop policy if exists email_mailboxes_delete on email_mailboxes;
create policy email_mailboxes_delete on email_mailboxes for delete using (
  app_is_admin() or app_role() in ('recruiter','bde')
);

drop policy if exists email_messages_delete on email_messages;
create policy email_messages_delete on email_messages for delete using (
  app_is_admin() or app_role() in ('recruiter','bde')
);
