-- ---------------------------------------------------------------------
-- 0135 - Naukri and Shine mailboxes, each owned by the recruiter Admin chose
--
-- TeamLink receives Naukri responses in one mailbox and Shine responses in
-- another. Admin connects each one (Admin -> Integrations -> Naukri & Shine
-- Email Import) and names the recruiter whose records it feeds.
--
--   source          'naukri' | 'shine' - the ONLY board this mailbox imports.
--                   A Shine email in the Naukri mailbox is left unread, and the
--                   other way round. NULL = an older mailbox (any board).
--   recruiter_id    (existing) the owner: every candidate and application the
--                   mailbox creates is that recruiter's.
--   secrets_sealed  the mailbox credential (an app password), sealed with
--                   AES-256-GCM under INTEGRATION_SECRET_KEY (publishing/secrets.js)
--                   on the server. Never returned by any API, never logged.
--                   NULL = the older way: the server's environment variables.
--
-- Admin only: connecting, reassigning and disconnecting go through definer
-- functions that check app_is_admin() themselves. Changing the owner never
-- moves a candidate - it decides who the NEXT imports belong to, and it is
-- an explicit, audited action of its own.
--
-- RECRUITER ISOLATION. Every recruiter could read every mailbox and every
-- imported email (0019). Now a recruiter reads their own mailboxes and their
-- emails only (and, as before, mailboxes nobody owns); Admin reads all.
-- ---------------------------------------------------------------------
alter table email_mailboxes
  add column if not exists source          text,
  add column if not exists secrets_sealed  text,
  add column if not exists auth_method     text,
  add column if not exists connected_at    timestamptz,
  add column if not exists connected_by    uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'email_mailboxes_source_chk') then
    alter table email_mailboxes add constraint email_mailboxes_source_chk
      check (source is null or source in ('naukri', 'shine'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'email_mailboxes_auth_chk') then
    alter table email_mailboxes add constraint email_mailboxes_auth_chk
      check (auth_method is null or auth_method in ('app_password', 'oauth', 'environment'));
  end if;
end $$;

-- ---------------------------------------------------------------------
-- who reads what
-- ---------------------------------------------------------------------
drop policy if exists email_mailboxes_read on email_mailboxes;
create policy email_mailboxes_read on email_mailboxes for select using (
  app_is_admin()
  or app_role() = 'bde'
  or (app_role() = 'recruiter' and (recruiter_id is null or recruiter_id = app_recruiter_id()))
);

drop policy if exists email_messages_read on email_messages;
create policy email_messages_read on email_messages for select using (
  app_is_admin()
  or app_role() = 'bde'
  or (app_role() = 'recruiter' and exists (
        select 1 from email_mailboxes m
         where m.id = email_messages.mailbox_id
           and (m.recruiter_id is null or m.recruiter_id = app_recruiter_id())))
);

-- ---------------------------------------------------------------------
-- Admin: connect (after the server has proved the login works)
-- ---------------------------------------------------------------------
create or replace function source_mailbox_save(
  p_id text, p_address text, p_source text, p_recruiter_id text, p_provider text,
  p_config jsonb, p_sealed text, p_auth text)
returns text
language plpgsql security definer set search_path = public as $$
declare v_row email_mailboxes; v_id text;
begin
  if not app_is_admin() then raise exception 'ADMIN_ONLY'; end if;
  if p_source not in ('naukri', 'shine') then raise exception 'BAD_SOURCE'; end if;
  if not exists (select 1 from recruiters where id = p_recruiter_id) then raise exception 'NO_SUCH_RECRUITER'; end if;

  select * into v_row from email_mailboxes where address = lower(p_address);
  if found then
    /* the same address cannot quietly change board or owner: that is a reassignment, done on purpose */
    if v_row.source is not null and v_row.source <> p_source then raise exception 'MAILBOX_OTHER_SOURCE'; end if;
    if v_row.recruiter_id is not null and v_row.recruiter_id <> p_recruiter_id then raise exception 'MAILBOX_OWNED'; end if;
    update email_mailboxes set
      provider = p_provider, source = p_source, recruiter_id = p_recruiter_id,
      config = coalesce(p_config, '{}'::jsonb), secrets_sealed = p_sealed, auth_method = p_auth,
      status = 'connected', last_error = null, auto_sync = true,
      connected_at = now(), connected_by = app_user_id(), updated_at = now()
     where id = v_row.id
    returning id into v_id;
  else
    insert into email_mailboxes
      (id, address, provider, source, recruiter_id, display_name, auto_sync, rules, config,
       secrets_sealed, auth_method, status, connected_at, connected_by)
    values (p_id, lower(p_address), p_provider, p_source, p_recruiter_id,
            case p_source when 'naukri' then 'Naukri mailbox' else 'Shine mailbox' end,
            true, '{}'::jsonb, coalesce(p_config, '{}'::jsonb), p_sealed, p_auth, 'connected', now(), app_user_id())
    returning id into v_id;
  end if;

  perform audit_write(case when found then 'intake.mailbox_reconnected' else 'intake.mailbox_connected' end,
    'mailbox', v_id, jsonb_build_object('source', p_source, 'recruiterId', p_recruiter_id, 'address', lower(p_address)));
  return v_id;
end $$;

/* the credential, stored again after a successful re-test (rotation) */
create or replace function source_mailbox_reconnect(p_id text, p_sealed text, p_config jsonb)
returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not app_is_admin() then raise exception 'ADMIN_ONLY'; end if;
  update email_mailboxes set
    secrets_sealed = coalesce(p_sealed, secrets_sealed),
    config = coalesce(p_config, config),
    status = 'connected', last_error = null, auto_sync = true,
    connected_at = now(), connected_by = app_user_id(), updated_at = now()
   where id = p_id and source is not null;
  if not found then return false; end if;
  perform audit_write('intake.mailbox_reconnected', 'mailbox', p_id, '{}'::jsonb);
  return true;
end $$;

/* disconnect: the credential is erased, nothing more is read; what was imported stays */
create or replace function source_mailbox_disconnect(p_id text)
returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not app_is_admin() then raise exception 'ADMIN_ONLY'; end if;
  update email_mailboxes set
    secrets_sealed = null, status = 'disconnected', auto_sync = false, updated_at = now()
   where id = p_id;
  if not found then return false; end if;
  perform audit_write('intake.mailbox_disconnected', 'mailbox', p_id, '{}'::jsonb);
  return true;
end $$;

/* an explicit change of owner - for the imports from now on; no candidate moves */
create or replace function source_mailbox_reassign(p_id text, p_recruiter_id text)
returns boolean
language plpgsql security definer set search_path = public as $$
declare v_old text;
begin
  if not app_is_admin() then raise exception 'ADMIN_ONLY'; end if;
  if not exists (select 1 from recruiters where id = p_recruiter_id) then raise exception 'NO_SUCH_RECRUITER'; end if;
  select recruiter_id into v_old from email_mailboxes where id = p_id;
  if not found then return false; end if;
  update email_mailboxes set recruiter_id = p_recruiter_id, updated_at = now() where id = p_id;
  perform audit_write('intake.mailbox_reassigned', 'mailbox', p_id,
    jsonb_build_object('from', v_old, 'to', p_recruiter_id));
  return true;
end $$;

/* a sync was run (who asked, how it went) - counts only, no message content */
create or replace function source_mailbox_synced_audit(p_id text, p_detail jsonb)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from email_mailboxes where id = p_id and source is not null) then
    perform audit_write('intake.mailbox_synced', 'mailbox', p_id, coalesce(p_detail, '{}'::jsonb));
  end if;
end $$;

/* the counts the Admin table shows */
create or replace function source_mailbox_stats()
returns table (mailbox_id text, processed int, imported int, duplicates int, review int, failed int, ignored int, pending int)
language sql stable security definer set search_path = public as $$
  select m.id,
         count(e.id) filter (where e.status <> 'new')::int,
         count(e.id) filter (where e.status = 'processed' and e.candidate_id is not null)::int,
         count(e.id) filter (where e.status = 'duplicate')::int,
         count(e.id) filter (where e.status in ('needs_review', 'needs_mapping'))::int,
         count(e.id) filter (where e.status = 'failed')::int,
         count(e.id) filter (where e.status = 'ignored')::int,
         count(e.id) filter (where e.status = 'new')::int
    from email_mailboxes m
    left join email_messages e on e.mailbox_id = m.id
   where app_is_admin() and m.source is not null
   group by m.id;
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant execute on function
      source_mailbox_save(text, text, text, text, text, jsonb, text, text),
      source_mailbox_reconnect(text, text, jsonb),
      source_mailbox_disconnect(text),
      source_mailbox_reassign(text, text),
      source_mailbox_synced_audit(text, jsonb),
      source_mailbox_stats()
      to app_api;
  end if;
end $$;
