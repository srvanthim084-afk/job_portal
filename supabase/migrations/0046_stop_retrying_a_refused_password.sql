-- ---------------------------------------------------------------------
-- 0046 — stop re-sending a password the server has already refused
--
-- The scheduler syncs every auto-sync mailbox on a timer, and nothing
-- stopped it retrying a credential that had been rejected. A mailbox
-- connected with the wrong password therefore attempted a login every
-- few minutes, for as long as it stayed connected, which is not a
-- harmless no-op: repeated failed logins are how Google locks an
-- account, and the person it happens to is the recruiter whose mailbox
-- it is.
--
-- It cannot simply stop forever either, or fixing the password would
-- have no effect until somebody knew to go and press something.
--
-- So the FINGERPRINT of the refused credential is remembered - a sha256,
-- never the secret - and the sweep skips a mailbox whose credential
-- still fingerprints the same. Change the password in the environment
-- and the fingerprint changes with it, so the next sweep tries again by
-- itself. "Sync now" always tries, whatever is remembered: a person
-- pressing a button is asking on purpose, and one attempt locks nothing.
-- ---------------------------------------------------------------------

alter table email_mailboxes
  add column if not exists auth_refused_fingerprint text,
  add column if not exists auth_refused_at          timestamptz;

comment on column email_mailboxes.auth_refused_fingerprint is
  'sha256 of the credential the mail server refused - NEVER the secret '
  'itself. The automatic sweep skips this mailbox while the credential '
  'still hashes to this value, so a rejected password is not sent again '
  'and again until the account is locked. It resumes by itself when the '
  'credential changes.';

/**
 * Remember that a login was refused, and with which credential.
 *
 * Definer because the API role may not write email_mailboxes directly,
 * and the fingerprint is computed by the caller - this function never
 * receives the secret, only a hash of it.
 */
create or replace function mailbox_auth_refused(p_id text, p_fingerprint text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  update email_mailboxes
     set auth_refused_fingerprint = p_fingerprint,
         auth_refused_at = now()
   where id = p_id;
end $$;

/** Forget it, once a login succeeds. */
create or replace function mailbox_auth_accepted(p_id text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  update email_mailboxes
     set auth_refused_fingerprint = null,
         auth_refused_at = null
   where id = p_id;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant execute on function mailbox_auth_refused(text, text) to app_api;
    grant execute on function mailbox_auth_accepted(text) to app_api;
  end if;
end $$;
