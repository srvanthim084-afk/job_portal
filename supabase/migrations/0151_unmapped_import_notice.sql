-- ---------------------------------------------------------------------
-- 0151 - the recruiter is emailed when an imported application has no requirement to go on
--
-- A Naukri / Shine email that cannot be matched to a requirement stays "Needs a requirement" until somebody maps
-- it - and nobody was told, so it could sit unseen. Now the recruiter who owns the mailbox gets one email per
-- message saying who applied, for what, and where to map it.
--
-- Once per message: the claim below sets mapping_notified_at in the same statement that decides, so a re-sync
-- (which re-reads these messages) or two processes cannot send it twice. A failed send releases the claim and
-- tries again on a later sync, at most 3 times (mapping_notice_tries).
-- ---------------------------------------------------------------------
alter table email_messages add column if not exists mapping_notified_at timestamptz;
alter table email_messages add column if not exists mapping_notice_tries int not null default 0;

create or replace function intake_unmapped_notice_claim(p_row_id text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v email_messages;
begin
  update email_messages
     set mapping_notified_at = now(), mapping_notice_tries = mapping_notice_tries + 1
   where id = p_row_id and status = 'needs_mapping' and mapping_notified_at is null and mapping_notice_tries < 3
   returning * into v;
  if not found then return null; end if;

  return (select jsonb_build_object(
            'subject', v.subject, 'reason', v.reason, 'receivedAt', v.received_at, 'parsed', v.parsed,
            'mailbox', mb.address, 'source', mb.source,
            'recruiterId', r.id, 'recruiterName', r.name, 'recruiterEmail', r.email,
            'candidateName', c.name, 'candidateEmail', c.email, 'candidatePhone', c.phone)
            from (select 1) x
            left join email_mailboxes mb on mb.id = v.mailbox_id
            left join recruiters r on r.id = mb.recruiter_id
            left join candidates c on c.id = v.candidate_id);
end $$;

/* the send did not work: give the claim back so a later sync tries again (the counter still caps it) */
create or replace function intake_unmapped_notice_release(p_row_id text)
returns void
language sql security definer set search_path = public as $$
  update email_messages set mapping_notified_at = null where id = p_row_id and status = 'needs_mapping';
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant execute on function intake_unmapped_notice_claim(text) to app_api;
    grant execute on function intake_unmapped_notice_release(text) to app_api;
  end if;
end $$;
