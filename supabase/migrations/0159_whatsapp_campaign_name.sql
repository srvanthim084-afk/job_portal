-- ---------------------------------------------------------------------
-- 0159 - a WhatsApp send is a named campaign
--
-- The recruiter names the send ("Nellore nurses - walk-in reminder"); the name is kept on every message of the batch so History and
-- Templates & Campaigns -> Campaigns can list it. message_log_queue_wa gains the name; the old 12-argument form is replaced.
-- ---------------------------------------------------------------------
alter table message_logs add column if not exists campaign_name text;

drop function if exists message_log_queue_wa(text, text, text, text, text, text, text, jsonb, text, uuid, text, text);

create or replace function message_log_queue_wa(
  p_batch text, p_candidate text, p_candidate_name text, p_to text, p_template_id text, p_template_name text,
  p_body text, p_payload jsonb, p_application text, p_actor uuid, p_actor_role text, p_actor_name text, p_campaign text
) returns message_logs
language plpgsql security definer set search_path = public as $$
declare v message_logs;
begin
  insert into message_logs
    (batch_id, candidate_id, channel, template_id, subject, body, to_address, status, sent_by, sent_by_role,
     wa_payload, application_id, template_name, candidate_name, recruiter_name, campaign_name)
  values
    (p_batch, p_candidate, 'whatsapp', p_template_id, null, p_body, nullif(btrim(coalesce(p_to, '')), ''),
     case when nullif(btrim(coalesce(p_to, '')), '') is null then 'skipped_no_contact' else 'queued' end,
     p_actor, p_actor_role, p_payload, p_application, p_template_name, p_candidate_name, left(coalesce(p_actor_name, ''), 120),
     left(nullif(btrim(coalesce(p_campaign, '')), ''), 120))
  on conflict (batch_id, candidate_id) where channel = 'whatsapp' and wa_payload is not null do nothing
  returning * into v;
  if v.id is null then
    select * into v from message_logs where batch_id = p_batch and candidate_id = p_candidate and channel = 'whatsapp' and wa_payload is not null;
  end if;
  return v;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant execute on function message_log_queue_wa(text, text, text, text, text, text, text, jsonb, text, uuid, text, text, text) to app_api;
  end if;
end $$;
