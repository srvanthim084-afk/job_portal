-- ---------------------------------------------------------------------
-- 0040 — the SMS and WhatsApp settings that decide whether a message is
--        accepted, rather than just sent
--
-- SMS and WhatsApp have been fully wired since the dispatcher was built:
-- they compose at every stage, from the same code as email, and report
-- `not_configured` because the credentials are not on the server. The
-- credentials are the user's to add. What was missing is everything
-- ELSE those two carriers require, and without it a correct key still
-- produces a rejected message:
--
--   SMS in India   An operator drops a message whose header is not a
--                  registered DLT sender and whose body does not match a
--                  registered DLT template. The aggregator returns
--                  success-shaped errors for this, so it looks sent.
--   WhatsApp       Meta allows free-form text only inside the 24-hour
--                  window after the candidate writes to us. A stage
--                  update is business-initiated, so it needs an approved
--                  TEMPLATE. Sending type:'text' outside that window is
--                  rejected every time.
--
-- So these are not decoration. They are the difference between a key
-- that works and a key that appears to work.
--
-- NO CREDENTIAL IS STORED HERE. The API key and the phone id stay in
-- the server environment, for the reason 0039 gives: every recruiter can
-- open the screen that edits this table. A sender header and a template
-- name are not secrets - they are printed on the message.
-- ---------------------------------------------------------------------

create table if not exists channel_settings (
  channel           text primary key,

  -- SMS -------------------------------------------------------------
  -- The six-character header a candidate sees instead of a number.
  sender_id         text,
  -- India's DLT registration: the entity is the company, the template is
  -- the approved wording. Both are issued by the operator, neither is
  -- secret, and an Indian aggregator rejects a message without them.
  dlt_entity_id     text,
  dlt_template_id   text,

  -- WhatsApp --------------------------------------------------------
  -- The approved template used for business-initiated messages. Null
  -- means free-form text, which works only inside the 24-hour window.
  template_name     text,
  template_language text not null default 'en',

  updated_at        timestamptz not null default now(),
  updated_by        text
);

alter table channel_settings enable row level security;
alter table channel_settings force  row level security;

-- Staff read it; only the definer function writes it.
create policy cs_read on channel_settings for select using (
  app_is_admin() or app_role() in ('recruiter', 'bde')
);
create policy cs_no_direct_write on channel_settings for all
  using (app_is_admin()) with check (app_is_admin());

insert into channel_settings (channel) values ('sms'), ('whatsapp')
on conflict (channel) do nothing;

/**
 * Save one channel's settings.
 *
 * Absent key means "leave it alone"; present-but-empty means CLEAR it.
 * The two have to be told apart: a recruiter removing a DLT template id
 * is saying the aggregator no longer wants one, and storing '' instead
 * of null would read as configured everywhere that checks for a value.
 *
 * Recruiters may write it. These are operational - the header on a
 * message, the name of a template somebody registered this morning -
 * and the person running the desk is the one who knows them.
 */
create or replace function channel_settings_update(
  p_channel text, p_patch jsonb, p_actor text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_row channel_settings;
begin
  if not (app_is_admin() or app_role() in ('recruiter', 'bde')) then
    raise exception 'not allowed to change channel settings'
      using errcode = '42501';
  end if;

  if p_channel not in ('sms', 'whatsapp') then
    raise exception 'there are no settings for channel %', p_channel
      using errcode = '22023';
  end if;

  update channel_settings set
    sender_id = case when p_patch ? 'senderId'
      then nullif(btrim(p_patch->>'senderId'), '') else sender_id end,
    dlt_entity_id = case when p_patch ? 'dltEntityId'
      then nullif(btrim(p_patch->>'dltEntityId'), '') else dlt_entity_id end,
    dlt_template_id = case when p_patch ? 'dltTemplateId'
      then nullif(btrim(p_patch->>'dltTemplateId'), '') else dlt_template_id end,
    template_name = case when p_patch ? 'templateName'
      then nullif(btrim(p_patch->>'templateName'), '') else template_name end,
    template_language = case when p_patch ? 'templateLanguage'
      then coalesce(nullif(btrim(p_patch->>'templateLanguage'), ''), 'en')
      else template_language end,
    updated_at = now(),
    updated_by = p_actor
  where channel = p_channel
  returning * into v_row;

  return to_jsonb(v_row);
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant execute on function channel_settings_update(text, jsonb, text) to app_api;
    grant select on channel_settings to app_api;
  end if;
end $$;
