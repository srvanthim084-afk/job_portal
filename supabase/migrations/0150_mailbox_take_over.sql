-- ---------------------------------------------------------------------
-- 0150 - Admin can take over a recruiter's PERSONAL mailbox for Naukri / Shine, on purpose
--
-- Admin -> Naukri & Shine Email Import refused an address with "already connected to another recruiter.
-- Use Reassign on that row" - but the row it meant is a mailbox a recruiter connected for themselves in
-- the Recruiter Portal (or an older environment mailbox): source is NULL, so it is NOT in the Naukri / Shine
-- table and there is no row to press Reassign on. A dead end.
--
-- Now: connecting such an address says who has it and that it is a personal mailbox, and the admin may
-- confirm (p_take_over = true). The same mailbox row becomes the Naukri / Shine mailbox of the chosen
-- recruiter (what it already imported stays), and the move is written to the audit log with the previous
-- owner. A mailbox that is ALREADY a Naukri / Shine mailbox of somebody else is unchanged: that is still
-- a Reassign on its row, and another board is still refused.
-- ---------------------------------------------------------------------
drop function if exists source_mailbox_save(text, text, text, text, text, jsonb, text, text);

create or replace function source_mailbox_save(
  p_id text, p_address text, p_source text, p_recruiter_id text, p_provider text,
  p_config jsonb, p_sealed text, p_auth text, p_take_over boolean default false)
returns text
language plpgsql security definer set search_path = public as $$
declare v_row email_mailboxes; v_id text; v_existed boolean; v_prev text; v_owner text;
begin
  if not app_is_admin() then raise exception 'ADMIN_ONLY'; end if;
  if p_source not in ('naukri', 'shine') then raise exception 'BAD_SOURCE'; end if;
  if not exists (select 1 from recruiters where id = p_recruiter_id) then raise exception 'NO_SUCH_RECRUITER'; end if;

  select * into v_row from email_mailboxes where address = lower(p_address);
  v_existed := found;   /* FOUND changes with the insert / update below */
  if v_existed then
    /* the same address cannot quietly change board or owner: that is a reassignment, done on purpose */
    if v_row.source is not null and v_row.source <> p_source then raise exception 'MAILBOX_OTHER_SOURCE'; end if;
    if v_row.source is not null and v_row.recruiter_id is not null and v_row.recruiter_id <> p_recruiter_id then
      raise exception 'MAILBOX_OWNED';
    end if;
    /* a recruiter's own mailbox (no board): only with the admin's explicit say-so */
    if v_row.source is null and v_row.recruiter_id is not null and v_row.recruiter_id <> p_recruiter_id then
      if p_take_over is not true then
        select name into v_owner from recruiters where id = v_row.recruiter_id;
        raise exception 'MAILBOX_PERSONAL' using detail = coalesce(v_owner, v_row.recruiter_id);
      end if;
      v_prev := v_row.recruiter_id;
    end if;
    update email_mailboxes set
      provider = p_provider, source = p_source, recruiter_id = p_recruiter_id,
      display_name = case p_source when 'naukri' then 'Naukri mailbox' else 'Shine mailbox' end,
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

  perform audit_write(
    case when v_prev is not null then 'intake.mailbox_taken_over'
         when v_existed then 'intake.mailbox_reconnected' else 'intake.mailbox_connected' end,
    'mailbox', v_id,
    jsonb_build_object('source', p_source, 'recruiterId', p_recruiter_id, 'address', lower(p_address))
      || case when v_prev is not null then jsonb_build_object('previousRecruiterId', v_prev) else '{}'::jsonb end);
  return v_id;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant execute on function source_mailbox_save(text, text, text, text, text, jsonb, text, text, boolean) to app_api;
  end if;
end $$;
