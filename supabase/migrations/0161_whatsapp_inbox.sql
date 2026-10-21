-- ---------------------------------------------------------------------
-- 0161 - the WhatsApp Inbox: conversations, unread, assignment, campaign replies, message status
--
-- 0160 added several numbers and a per-number message table. The Inbox needs more of it, so this EXTENDS those tables (no second store):
--
--   whatsapp_conversations       one row per (number, contact): who it is, who it is assigned to, the last message and its status, when the
--                                contact last wrote, and the CAMPAIGN the latest reply belongs to (and how sure we are of that)
--   whatsapp_conversation_reads  when each person last opened a conversation - unread is "their messages after that"
--   whatsapp_messages            + conversation, delivery status (sent / delivered / read / failed), media, the message replied to,
--                                the campaign (batch) an outgoing message belonged to and a reply was matched to
--
-- CAMPAIGN MATCHING. An incoming message is tied to a campaign only when the data supports it: it is a reply to a message of that campaign
-- (WhatsApp says which message in `context.id`) = 'reply'; otherwise the most recent campaign message sent to this contact in the last 3 days =
-- 'recent' (shown as "most likely"); otherwise to none. Nothing else is called a campaign reply.
--
-- WHO SEES A CONVERSATION. An administrator, and anyone who may use the number - unless the conversation is ASSIGNED, in which case only the
-- person it is assigned to (and administrators). A campaign's sender is the first assignee; an administrator can reassign at any time, the
-- history stays with the conversation.
-- ---------------------------------------------------------------------
create table if not exists whatsapp_conversations (
  id               text primary key,
  number_id        text not null references whatsapp_numbers(id),
  contact          text not null,
  contact_name     text,
  candidate_id     text references candidates(id) on delete set null,
  assigned_to      uuid references users(id) on delete set null,
  assigned_by      uuid references users(id) on delete set null,
  assigned_at      timestamptz,
  last_message_at  timestamptz not null default now(),
  last_message_text text,
  last_direction   text,
  last_status      text,
  last_inbound_at  timestamptz,
  last_human_out_at timestamptz,               -- a person's message (template or reply): the assistant's automatic replies do not count
  campaign_batch_id text,
  campaign_name    text,
  campaign_match   text check (campaign_match in ('reply', 'recent')),
  created_at       timestamptz not null default now(),
  unique (number_id, contact)
);
create index if not exists wac_last_idx on whatsapp_conversations (last_message_at desc);
create index if not exists wac_assigned_idx on whatsapp_conversations (assigned_to);
create index if not exists wac_campaign_idx on whatsapp_conversations (campaign_batch_id);

create table if not exists whatsapp_conversation_reads (
  conversation_id text not null references whatsapp_conversations(id) on delete cascade,
  user_id         uuid not null references users(id) on delete cascade,
  read_at         timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

alter table whatsapp_messages
  add column if not exists conversation_id   text references whatsapp_conversations(id) on delete cascade,
  add column if not exists status            text,
  add column if not exists error             text,
  add column if not exists media             jsonb,
  add column if not exists context_wamid     text,
  add column if not exists campaign_batch_id text,
  add column if not exists campaign_name     text,
  add column if not exists campaign_match    text,
  add column if not exists sent_by           uuid references users(id) on delete set null;
create index if not exists wam_conv_idx on whatsapp_messages (conversation_id, created_at);
create index if not exists wam_campaign_idx on whatsapp_messages (campaign_batch_id) where campaign_batch_id is not null;
create index if not exists wam_wamid_idx on whatsapp_messages (wa_message_id) where wa_message_id is not null;

alter table whatsapp_conversations      enable row level security;
alter table whatsapp_conversations      force  row level security;
alter table whatsapp_conversation_reads enable row level security;
alter table whatsapp_conversation_reads force  row level security;

-- ---------------------------------------------------------------------
-- who may see a conversation
-- ---------------------------------------------------------------------
create or replace function whatsapp_conversation_allowed(p_conv text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from whatsapp_conversations c
     where c.id = p_conv
       and (app_is_admin()
            or (whatsapp_number_allowed(c.number_id) and (c.assigned_to is null or c.assigned_to = app_user_id())))
  );
$$;

drop policy if exists wac_read on whatsapp_conversations;
create policy wac_read on whatsapp_conversations for select using (whatsapp_conversation_allowed(id));
drop policy if exists war_own on whatsapp_conversation_reads;
create policy war_own on whatsapp_conversation_reads for select using (user_id = app_user_id());
drop policy if exists wam_read on whatsapp_messages;
create policy wam_read on whatsapp_messages for select using (conversation_id is not null and whatsapp_conversation_allowed(conversation_id));

-- a name and department for a staff user (the tables behind them are not open to every recruiter)
create or replace function whatsapp_staff_info(p_user uuid) returns table (name text, department text, role text)
language sql stable security definer set search_path = public as $$
  select coalesce(r.name, b.name, a.name, u.email), coalesce(r.department, case when u.role = 'bde' then 'BDE' end), u.role
    from users u left join recruiters r on r.user_id = u.id left join bde_users b on b.user_id = u.id left join admins a on a.user_id = u.id
   where u.id = p_user;
$$;

-- ---------------------------------------------------------------------
-- record a message: finds / creates the conversation, matches the campaign, keeps the summary, drops a duplicate
-- ---------------------------------------------------------------------
drop function if exists whatsapp_message_record(text, text, text, text, text, text, text, text);
create or replace function whatsapp_message_record(
  p_number text, p_direction text, p_contact text, p_name text, p_body text, p_wamid text, p_kind text,
  p_by text default null, p_user uuid default null, p_media jsonb default null, p_context text default null,
  p_status text default null, p_batch text default null, p_at timestamptz default null, p_error text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  d text := regexp_replace(coalesce(p_contact, ''), '\D', '', 'g');
  v_conv text; v_cand text; v_id bigint; v_at timestamptz := coalesce(p_at, now());
  v_batch text := null; v_campaign text := null; v_match text := null; v_assigned uuid; v_kind text := coalesce(p_kind, 'text');
  v_human boolean := p_direction = 'out' and v_kind in ('template', 'reply');
begin
  if length(d) = 11 and left(d, 1) = '0' then d := substr(d, 2); end if;
  if length(d) = 10 then d := '91' || d; end if;
  if d = '' or not exists (select 1 from whatsapp_numbers where id = p_number) then return jsonb_build_object('skipped', true); end if;

  select id into v_cand from candidates where length(d) >= 10 and right(regexp_replace(coalesce(phone, ''), '\D', '', 'g'), 10) = right(d, 10) limit 1;
  v_conv := 'wac_' || substr(md5(p_number || ':' || d), 1, 16);
  insert into whatsapp_conversations (id, number_id, contact, contact_name, candidate_id, last_message_at)
  values (v_conv, p_number, d, left(p_name, 120), v_cand, v_at)
  on conflict (number_id, contact) do update
     set contact_name = coalesce(nullif(whatsapp_conversations.contact_name, ''), excluded.contact_name),
         candidate_id = coalesce(whatsapp_conversations.candidate_id, excluded.candidate_id);

  if p_direction = 'out' and p_batch is not null then
    v_batch := p_batch;
    select max(campaign_name) into v_campaign from message_logs where batch_id = p_batch;
    v_match := null;
  elsif p_direction = 'in' then
    -- exactly the message that was replied to, when WhatsApp says which one
    if p_context is not null then
      select m.campaign_batch_id, m.campaign_name into v_batch, v_campaign
        from whatsapp_messages m where m.wa_message_id = p_context and m.campaign_batch_id is not null limit 1;
      if v_batch is null then
        select ml.batch_id, ml.campaign_name into v_batch, v_campaign from message_logs ml where ml.provider_ref = p_context and ml.campaign_name is not null limit 1;
      end if;
      if v_batch is not null then v_match := 'reply'; end if;
    end if;
    -- otherwise the most recent campaign message this contact was sent, within 3 days: "most likely"
    if v_batch is null then
      select m.campaign_batch_id, m.campaign_name into v_batch, v_campaign
        from whatsapp_messages m
       where m.conversation_id = v_conv and m.direction = 'out' and m.campaign_batch_id is not null and m.created_at > v_at - interval '3 days'
       order by m.created_at desc limit 1;
      if v_batch is not null then v_match := 'recent'; end if;
    end if;
  end if;

  insert into whatsapp_messages (number_id, direction, contact, contact_name, candidate_id, kind, body, wa_message_id, sent_by_name, created_at,
                                 conversation_id, status, error, media, context_wamid, campaign_batch_id, campaign_name, campaign_match, sent_by)
  values (p_number, p_direction, d, left(p_name, 120), v_cand, v_kind, left(p_body, 4000), nullif(p_wamid, ''), left(p_by, 120), v_at,
          v_conv, case when p_direction = 'out' then coalesce(p_status, 'sent') end, left(p_error, 500), p_media, nullif(p_context, ''),
          v_batch, v_campaign, v_match, p_user)
  on conflict (number_id, wa_message_id) where wa_message_id is not null do nothing
  returning id into v_id;
  if v_id is null then return jsonb_build_object('duplicate', true, 'conversation_id', v_conv); end if;

  update whatsapp_conversations c
     set last_message_at = greatest(c.last_message_at, v_at), last_message_text = left(p_body, 300), last_direction = p_direction,
         last_status = case when p_direction = 'out' then coalesce(p_status, 'sent') end,
         last_inbound_at = case when p_direction = 'in' then greatest(coalesce(c.last_inbound_at, v_at), v_at) else c.last_inbound_at end,
         last_human_out_at = case when v_human then greatest(coalesce(c.last_human_out_at, v_at), v_at) else c.last_human_out_at end,
         campaign_batch_id = case when v_batch is not null and (p_direction = 'out' or v_match is not null) then v_batch else c.campaign_batch_id end,
         campaign_name     = case when v_batch is not null and (p_direction = 'out' or v_match is not null) then v_campaign else c.campaign_name end,
         campaign_match    = case when v_batch is not null and p_direction = 'in' then (case when c.campaign_batch_id = v_batch and c.campaign_match = 'reply' then 'reply' else v_match end)
                              when v_batch is not null then null else c.campaign_match end,
         assigned_to = case when c.assigned_to is null and v_human and p_user is not null
                              and exists (select 1 from users u where u.id = p_user and u.role in ('recruiter', 'bde', 'admin')) then p_user else c.assigned_to end,
         assigned_at = case when c.assigned_to is null and v_human and p_user is not null then now() else c.assigned_at end
   where c.id = v_conv
  returning c.assigned_to into v_assigned;

  return jsonb_build_object('id', v_id, 'conversation_id', v_conv, 'created', true, 'campaign_name', v_campaign, 'campaign_match', v_match,
                            'assigned_to', v_assigned, 'number_id', p_number);
end $$;

-- delivery receipts for what was sent from the portal (sent -> delivered -> read, or failed); never moves a message backwards
create or replace function whatsapp_message_status(p_ref text, p_status text, p_error text) returns text
language plpgsql security definer set search_path = public as $$
declare v_conv text; v_rank int; v_new int := case p_status when 'sent' then 1 when 'delivered' then 2 when 'read' then 3 when 'failed' then 9 else 0 end;
begin
  if coalesce(p_ref, '') = '' or v_new = 0 then return null; end if;
  select conversation_id, case status when 'sending' then 0 when 'sent' then 1 when 'delivered' then 2 when 'read' then 3 when 'failed' then 9 else 0 end
    into v_conv, v_rank from whatsapp_messages where wa_message_id = p_ref and direction = 'out' limit 1;
  if v_conv is null then return null; end if;
  if p_status = 'failed' and v_rank >= 2 then return null; end if;      -- already delivered: a late "failed" is noise
  if p_status <> 'failed' and v_new <= v_rank then return null; end if;
  update whatsapp_messages set status = p_status, error = case when p_status = 'failed' then left(p_error, 500) else null end where wa_message_id = p_ref and direction = 'out';
  update whatsapp_conversations c set last_status = p_status
   where c.id = v_conv and c.last_direction = 'out'
     and c.last_message_at = (select max(created_at) from whatsapp_messages where conversation_id = v_conv);
  return v_conv;
end $$;

-- opening a conversation marks it read for that person only
create or replace function whatsapp_conversation_mark_read(p_conv text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not whatsapp_conversation_allowed(p_conv) then raise exception 'not allowed' using errcode = '42501'; end if;
  insert into whatsapp_conversation_reads (conversation_id, user_id, read_at) values (p_conv, app_user_id(), now())
  on conflict (conversation_id, user_id) do update set read_at = now();
end $$;

-- an administrator gives a conversation to a person (or takes it back to the number's team); the history stays
create or replace function whatsapp_conversation_assign(p_conv text, p_user uuid) returns whatsapp_conversations
language plpgsql security definer set search_path = public as $$
declare v whatsapp_conversations;
begin
  if not app_is_admin() then raise exception 'only an administrator may assign conversations' using errcode = '42501'; end if;
  if p_user is not null and not exists (select 1 from users where id = p_user and role in ('recruiter', 'bde', 'admin')) then
    raise exception 'that person cannot be assigned a conversation' using errcode = '22023';
  end if;
  update whatsapp_conversations set assigned_to = p_user, assigned_by = app_user_id(), assigned_at = case when p_user is null then null else now() end
   where id = p_conv returning * into v;
  if not found then raise exception 'no such conversation' using errcode = 'P0002'; end if;
  perform audit_write('whatsapp_conversation.assigned', 'whatsapp_conversation', p_conv, jsonb_build_object('assigned_to', p_user));
  return v;
end $$;

-- the conversation of a message that is being replied to or sent (the caller has already been checked by the route)
create or replace function whatsapp_conversation_open(p_number text, p_contact text) returns text
language sql stable security definer set search_path = public as $$
  select id from whatsapp_conversations c where c.number_id = p_number and c.contact = p_contact
$$;

-- ---------------------------------------------------------------------
-- what is already there: the 0160 messages and the campaign messages in message_logs become conversations
-- ---------------------------------------------------------------------
do $$
declare r record; n int := 0;
begin
  -- the per-number messages written before this migration (inbound, the assistant's replies, portal replies)
  for r in select * from whatsapp_messages where conversation_id is null order by id loop
    perform 1;
    insert into whatsapp_conversations (id, number_id, contact, contact_name, candidate_id, last_message_at)
    values ('wac_' || substr(md5(r.number_id || ':' || r.contact), 1, 16), r.number_id, r.contact, r.contact_name, r.candidate_id, r.created_at)
    on conflict (number_id, contact) do nothing;
    update whatsapp_messages set conversation_id = 'wac_' || substr(md5(r.number_id || ':' || r.contact), 1, 16),
           status = case when r.direction = 'out' then 'sent' end where id = r.id;
    n := n + 1;
  end loop;
  -- campaign / template messages the portal sent (queue rows that WhatsApp accepted)
  for r in select * from message_logs
            where channel = 'whatsapp' and status in ('sent', 'delivered') and coalesce(to_address, '') <> '' and provider_ref is not null
              and queued_at > now() - interval '30 days' order by coalesce(sent_at, queued_at) loop
    perform whatsapp_message_record(coalesce(r.whatsapp_number_id, 'wan_primary'), 'out', r.to_address, r.candidate_name, r.body, r.provider_ref,
      'template', r.recruiter_name, r.sent_by, null, null,
      case when r.read_at is not null then 'read' when r.status = 'delivered' then 'delivered' else 'sent' end,
      case when r.campaign_name is not null then r.batch_id end, coalesce(r.sent_at, r.queued_at), null);
    n := n + 1;
  end loop;
  -- each conversation's summary from its messages
  update whatsapp_conversations c set
     last_message_at = m.at, last_message_text = left(m.body, 300), last_direction = m.direction, last_status = m.status
    from (select distinct on (conversation_id) conversation_id, created_at at, body, direction, status from whatsapp_messages where conversation_id is not null
           order by conversation_id, created_at desc, id desc) m
   where m.conversation_id = c.id;
  update whatsapp_conversations c set last_inbound_at = x.t from (select conversation_id, max(created_at) t from whatsapp_messages where direction = 'in' group by 1) x where x.conversation_id = c.id;
  update whatsapp_conversations c set last_human_out_at = x.t
    from (select conversation_id, max(created_at) t from whatsapp_messages where direction = 'out' and kind in ('template', 'reply') group by 1) x where x.conversation_id = c.id;
  update whatsapp_conversations c set campaign_batch_id = x.b, campaign_name = x.n
    from (select distinct on (conversation_id) conversation_id, campaign_batch_id b, campaign_name n from whatsapp_messages
           where campaign_batch_id is not null order by conversation_id, created_at desc) x where x.conversation_id = c.id;
  raise notice 'inbox backfill: % rows', n;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant select on whatsapp_conversations, whatsapp_conversation_reads to app_api;
    grant execute on function whatsapp_conversation_allowed(text) to app_api;
    grant execute on function whatsapp_staff_info(uuid) to app_api;
    grant execute on function whatsapp_message_record(text, text, text, text, text, text, text, text, uuid, jsonb, text, text, text, timestamptz, text) to app_api;
    grant execute on function whatsapp_message_status(text, text, text) to app_api;
    grant execute on function whatsapp_conversation_mark_read(text) to app_api;
    grant execute on function whatsapp_conversation_assign(text, uuid) to app_api;
    grant execute on function whatsapp_conversation_open(text, text) to app_api;
  end if;
end $$;
