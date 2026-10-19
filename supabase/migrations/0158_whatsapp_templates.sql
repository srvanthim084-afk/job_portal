-- ---------------------------------------------------------------------
-- 0158 - WhatsApp template sending: approved Business API templates, per-candidate parameters, retry, delivery status
--
-- WHAT WAS THERE. `comm_templates` (0157) holds the team's wording and `message_logs` (0061) is the queue and the history. A WhatsApp
-- send put the whole composed message into ONE body variable of one configured template, so nothing could carry a header, a footer,
-- buttons or the several variables a real approved template has.
--
-- WHAT THIS ADDS (no second template store, no second queue):
--   comm_templates       wa_name / wa_language / wa_status / wa : the WhatsApp Business structure of a template - the name and language
--                        Meta knows it by, Meta's approval status, and one json document with the header, footer, buttons, the order
--                        of the body variables (which candidate field fills {{1}}, {{2}} ...) and a fallback for each. A row without
--                        wa_name stays a plain text template and can never be sent over WhatsApp: only approved templates go out.
--   message_logs         wa_payload (exactly what was handed to Meta), application, template and people names, delivery / read times,
--                        credits, and ONE row per candidate per send (a repeated click or a network retry cannot send twice).
--   functions            comm_template_wa_upsert (administrator only), message_log_queue_wa, message_log_retry (failed rows only),
--                        message_log_delivery (Meta's delivered / read / failed receipts).
-- ---------------------------------------------------------------------
alter table comm_templates
  add column if not exists wa_name     text,
  add column if not exists wa_language text,
  add column if not exists wa_status   text,
  add column if not exists wa          jsonb not null default '{}'::jsonb;

do $$
begin
  if exists (select 1 from pg_constraint where conname = 'comm_templates_source_chk') then
    alter table comm_templates drop constraint comm_templates_source_chk;
  end if;
  alter table comm_templates add constraint comm_templates_source_chk check (source in ('system', 'portal', 'meta'));
  if not exists (select 1 from pg_constraint where conname = 'comm_templates_wa_status_chk') then
    alter table comm_templates add constraint comm_templates_wa_status_chk
      check (wa_status is null or wa_status in ('approved', 'pending', 'rejected', 'paused', 'disabled', 'draft'));
  end if;
end $$;

/* a WhatsApp template is known to Meta by name AND language: one live row for each pair */
create unique index if not exists comm_templates_wa_key
  on comm_templates (wa_name, wa_language) where wa_name is not null and not archived;

alter table comm_template_versions add column if not exists wa jsonb;

-- ---------------------------------------------------------------------
-- message_logs: what a template send needs to record
-- ---------------------------------------------------------------------
alter table message_logs
  add column if not exists wa_payload     jsonb,
  add column if not exists application_id text,
  add column if not exists template_name  text,
  add column if not exists candidate_name text,
  add column if not exists recruiter_name text,
  add column if not exists delivered_at   timestamptz,
  add column if not exists read_at        timestamptz,
  add column if not exists credits        numeric,
  add column if not exists pricing        jsonb;

/* one template message per candidate per send: this is what makes a double click or a retried request harmless */
create unique index if not exists mlog_wa_once
  on message_logs (batch_id, candidate_id) where channel = 'whatsapp' and wa_payload is not null;
create index if not exists mlog_ref_idx on message_logs (provider_ref) where provider_ref is not null;
create index if not exists mlog_sender_idx on message_logs (sent_by, queued_at desc);

-- ---------------------------------------------------------------------
-- create or update a WhatsApp template (administrator only; also what "sync from WhatsApp Business" calls)
--
-- Same (wa_name, wa_language) = the same template: it is updated, and a new version is kept when the wording or the structure
-- changed. An administrator's template is approved in the portal at once; what decides whether it can be SENT is wa_status, which is
-- Meta's word (approved / pending / rejected ...), never ours.
-- ---------------------------------------------------------------------
create or replace function comm_template_wa_upsert(
  p_id text, p_wa_name text, p_language text, p_name text, p_body text, p_wa jsonb, p_wa_status text,
  p_department text, p_used_in text[], p_source text, p_actor_name text
) returns comm_templates
language plpgsql security definer set search_path = public as $$
declare v comm_templates; v_actor text := comm_actor(); v_changed boolean;
begin
  if not app_is_admin() then
    raise exception 'only an administrator may create or change a WhatsApp template' using errcode = '42501';
  end if;
  if btrim(coalesce(p_wa_name, '')) = '' then raise exception 'a WhatsApp template needs its WhatsApp template name' using errcode = '22023'; end if;
  if btrim(coalesce(p_language, '')) = '' then raise exception 'a WhatsApp template needs a language' using errcode = '22023'; end if;
  if btrim(coalesce(p_body, '')) = '' then raise exception 'a template needs some text' using errcode = '22023'; end if;
  if p_wa_status is not null and p_wa_status not in ('approved', 'pending', 'rejected', 'paused', 'disabled', 'draft') then
    raise exception 'unknown WhatsApp status' using errcode = '22023';
  end if;

  select * into v from comm_templates
   where (id = p_id) or (wa_name = p_wa_name and wa_language = p_language and not archived)
   order by (id = p_id) desc limit 1 for update;

  if not found then
    insert into comm_templates (id, owner_id, kind, name, subject, body, department, used_in, approval_state, verified, source,
                                created_by, created_by_name, updated_by, approved_by, approved_at,
                                wa_name, wa_language, wa_status, wa)
    values (p_id, app_user_id(), 'whatsapp', btrim(coalesce(nullif(btrim(p_name), ''), p_wa_name)), null, p_body,
            coalesce(nullif(btrim(coalesce(p_department, '')), ''), 'All departments'), coalesce(p_used_in, '{}'),
            'approved', true, coalesce(p_source, 'portal'),
            v_actor, left(coalesce(p_actor_name, ''), 120), v_actor, v_actor, now(),
            btrim(p_wa_name), btrim(p_language), p_wa_status, coalesce(p_wa, '{}'::jsonb))
    returning * into v;
    insert into comm_template_versions (template_id, version, name, subject, body, department, saved_by, wa)
    values (v.id, 1, v.name, v.subject, v.body, v.department, v_actor, v.wa);
    perform audit_write('comm_template.created', 'comm_template', v.id, jsonb_build_object('channel', 'whatsapp', 'wa_name', v.wa_name));
    return v;
  end if;

  if v.source = 'system' then raise exception 'a built-in template cannot be edited here - duplicate it' using errcode = '22023'; end if;
  v_changed := v.body is distinct from p_body or v.wa is distinct from coalesce(p_wa, '{}'::jsonb)
               or v.name is distinct from btrim(coalesce(nullif(btrim(p_name), ''), p_wa_name));
  update comm_templates
     set name = btrim(coalesce(nullif(btrim(p_name), ''), p_wa_name)), body = p_body,
         wa_name = btrim(p_wa_name), wa_language = btrim(p_language), wa_status = p_wa_status, wa = coalesce(p_wa, '{}'::jsonb),
         department = coalesce(nullif(btrim(coalesce(p_department, '')), ''), department),
         used_in = coalesce(p_used_in, used_in),
         version = case when v_changed then version + 1 else version end,
         updated_by = v_actor, updated_at = now(),
         approval_state = 'approved', verified = true, approval_note = null, approved_by = v_actor, approved_at = now(),
         archived = false
   where id = v.id returning * into v;
  if v_changed then
    insert into comm_template_versions (template_id, version, name, subject, body, department, saved_by, wa)
    values (v.id, v.version, v.name, v.subject, v.body, v.department, v_actor, v.wa)
    on conflict (template_id, version) do nothing;
  end if;
  perform audit_write('comm_template.updated', 'comm_template', v.id, jsonb_build_object('version', v.version, 'wa_status', v.wa_status));
  return v;
end $$;

-- ---------------------------------------------------------------------
-- queue one personalised WhatsApp template message
--
-- Never sets a status other than queued / skipped_no_contact (a provider's word is the only thing that makes a row `sent`). The same
-- (batch, candidate) a second time returns the row that is already there instead of a second message.
-- ---------------------------------------------------------------------
create or replace function message_log_queue_wa(
  p_batch text, p_candidate text, p_candidate_name text, p_to text, p_template_id text, p_template_name text,
  p_body text, p_payload jsonb, p_application text, p_actor uuid, p_actor_role text, p_actor_name text
) returns message_logs
language plpgsql security definer set search_path = public as $$
declare v message_logs;
begin
  insert into message_logs
    (batch_id, candidate_id, channel, template_id, subject, body, to_address, status, sent_by, sent_by_role,
     wa_payload, application_id, template_name, candidate_name, recruiter_name)
  values
    (p_batch, p_candidate, 'whatsapp', p_template_id, null, p_body, nullif(btrim(coalesce(p_to, '')), ''),
     case when nullif(btrim(coalesce(p_to, '')), '') is null then 'skipped_no_contact' else 'queued' end,
     p_actor, p_actor_role, p_payload, p_application, p_template_name, p_candidate_name, left(coalesce(p_actor_name, ''), 120))
  on conflict (batch_id, candidate_id) where channel = 'whatsapp' and wa_payload is not null do nothing
  returning * into v;
  if v.id is null then
    select * into v from message_logs where batch_id = p_batch and candidate_id = p_candidate and channel = 'whatsapp' and wa_payload is not null;
  end if;
  return v;
end $$;

-- ---------------------------------------------------------------------
-- retry: ONLY the failed ones, ONLY by whoever sent the batch (or an administrator); a message Meta accepted is never touched
-- ---------------------------------------------------------------------
create or replace function message_log_retry(p_batch text) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update message_logs
     set status = 'queued', error = null
   where batch_id = p_batch and channel = 'whatsapp' and wa_payload is not null
     and status in ('failed', 'not_configured')
     and attempts < 5
     and (app_is_admin() or sent_by = app_user_id());
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------------------------------------------------------------------
-- Meta's receipts: sent -> delivered -> read, or failed. Never moves a message backwards.
-- ---------------------------------------------------------------------
create or replace function message_log_delivery(
  p_ref text, p_status text, p_error text, p_at timestamptz, p_pricing jsonb
) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if coalesce(p_ref, '') = '' then return 0; end if;
  if p_status in ('delivered', 'read') then
    update message_logs
       set status = 'delivered',
           delivered_at = coalesce(delivered_at, p_at, now()),
           read_at = case when p_status = 'read' then coalesce(read_at, p_at, now()) else read_at end,
           sent_at = coalesce(sent_at, p_at, now()),
           pricing = coalesce(p_pricing, pricing),
           credits = case when p_pricing is not null and (p_pricing->>'billable') = 'true' then coalesce(credits, 1) else credits end,
           error = null
     where provider_ref = p_ref and status in ('sent', 'delivered', 'sending', 'failed');
  elsif p_status = 'failed' then
    update message_logs
       set status = 'failed', error = left(coalesce(nullif(p_error, ''), 'WhatsApp could not deliver the message'), 2000)
     where provider_ref = p_ref and status in ('sent', 'sending');
  else
    return 0;
  end if;
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------------------------------------------------------------------
-- opt-out / opt-in by replying STOP / START to a TeamLink WhatsApp message (called by the webhook, as the system)
-- ---------------------------------------------------------------------
create or replace function candidate_whatsapp_opt(p_phone10 text, p_in boolean) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if length(coalesce(p_phone10, '')) < 10 then return 0; end if;
  update candidates set whatsapp_opt_in = p_in
   where right(regexp_replace(coalesce(phone, ''), '\D', '', 'g'), 10) = p_phone10 and whatsapp_opt_in is distinct from p_in;
  get diagnostics n = row_count;
  return n;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant execute on function comm_template_wa_upsert(text, text, text, text, text, jsonb, text, text, text[], text, text) to app_api;
    grant execute on function message_log_queue_wa(text, text, text, text, text, text, text, jsonb, text, uuid, text, text) to app_api;
    grant execute on function message_log_retry(text) to app_api;
    grant execute on function message_log_delivery(text, text, text, timestamptz, jsonb) to app_api;
    grant execute on function candidate_whatsapp_opt(text, boolean) to app_api;
  end if;
end $$;
