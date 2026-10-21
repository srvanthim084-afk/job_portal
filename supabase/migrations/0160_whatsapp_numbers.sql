-- ---------------------------------------------------------------------
-- 0160 - several WhatsApp Business numbers, assigned by the administrator
--
-- WHAT WAS THERE. ONE WhatsApp connection (integration_channels 'whatsapp', or WHATSAPP_API_KEY / WHATSAPP_PHONE_ID in the environment):
-- every message went out of that number and every reply came back to it.
--
-- WHAT THIS ADDS (the existing connection is NOT replaced; it becomes the "primary" number, row wan_primary, whose credentials stay
-- where they are):
--   whatsapp_numbers             one row per connected number: its Meta phone-number id, business account, display name, status
--                                (connected / disconnected / verification_required), a sealed access token, active / default flags
--   whatsapp_number_users        which staff may send from a number (users.id: recruiters, team leaders, BDEs)
--   whatsapp_number_departments  which departments may (Manufacturing, Education, Medical, BDE, HR ...)
--   whatsapp_messages            inbound messages and the agent's replies, per number (separate conversations per number);
--                                outbound template messages stay in message_logs, which now says which number sent each
--   functions                    whatsapp_number_allowed (the one question "may I send from this number?"), whatsapp_my_numbers (what
--                                a member of staff may see: no credentials), whatsapp_number_set_access, whatsapp_message_record
--
-- The primary number is open to all staff until the administrator restricts it, so nothing that worked yesterday stops working.
-- ---------------------------------------------------------------------
create table if not exists whatsapp_numbers (
  id                   text primary key,
  source               text not null default 'portal' check (source in ('primary', 'portal')),
  display_name         text not null,
  display_phone        text,                    -- the number as WhatsApp reports it
  phone_digits         text,                    -- digits only: the same number cannot be added twice
  phone_number_id      text,                    -- Meta's id for the number (null for primary: it comes from the existing configuration)
  business_account_id  text,
  access_token_enc     text,                    -- sealed (AES-256-GCM, INTEGRATION_SECRET_KEY); never returned to a page
  app_secret_enc       text,                    -- optional: this number's Meta app secret, for webhook signatures
  webhook_verify_token text,                    -- shown to the administrator for the Meta webhook set-up
  verified_name        text,
  quality_rating       text,
  department           text,                    -- label: the departments it serves, as the administrator set them
  status               text not null default 'verification_required' check (status in ('connected', 'disconnected', 'verification_required')),
  status_detail        text,
  last_verified_at     timestamptz,
  is_default           boolean not null default false,
  active               boolean not null default true,
  open_to_all          boolean not null default false,
  created_by           uuid references users(id),
  created_at           timestamptz not null default now(),
  updated_by           uuid references users(id),
  updated_at           timestamptz not null default now(),
  removed_at           timestamptz
);
create unique index if not exists wan_phone_id_key on whatsapp_numbers (phone_number_id) where removed_at is null and phone_number_id is not null;
create unique index if not exists wan_digits_key   on whatsapp_numbers (phone_digits)    where removed_at is null and phone_digits is not null;
create unique index if not exists wan_one_default  on whatsapp_numbers (is_default)      where is_default and removed_at is null;

create table if not exists whatsapp_number_users (
  number_id   text not null references whatsapp_numbers(id) on delete cascade,
  user_id     uuid not null references users(id) on delete cascade,
  assigned_by uuid references users(id),
  assigned_at timestamptz not null default now(),
  primary key (number_id, user_id)
);
create index if not exists wan_users_user_idx on whatsapp_number_users (user_id);

create table if not exists whatsapp_number_departments (
  number_id   text not null references whatsapp_numbers(id) on delete cascade,
  department  text not null,
  assigned_by uuid references users(id),
  assigned_at timestamptz not null default now()
);
create unique index if not exists wan_depts_key on whatsapp_number_departments (number_id, lower(btrim(department)));

create table if not exists whatsapp_messages (
  id           bigserial primary key,
  number_id    text not null references whatsapp_numbers(id),
  direction    text not null check (direction in ('in', 'out')),
  contact      text not null,                  -- the other party's WhatsApp number, digits only
  contact_name text,
  candidate_id text references candidates(id) on delete set null,
  kind         text not null default 'text',   -- text / other / agent_reply / reply (a recruiter's free-text reply inside the 24-hour window)
  sent_by_name text,                           -- for a recruiter's reply: who
  body         text,
  wa_message_id text,
  created_at   timestamptz not null default now()
);
create unique index if not exists wam_once on whatsapp_messages (number_id, wa_message_id) where wa_message_id is not null;
create index if not exists wam_thread_idx on whatsapp_messages (number_id, contact, created_at);

alter table message_logs add column if not exists whatsapp_number_id text;
alter table message_logs add column if not exists number_label text;
create index if not exists mlog_number_idx on message_logs (whatsapp_number_id) where whatsapp_number_id is not null;

-- the existing connection, as the primary number
insert into whatsapp_numbers (id, source, display_name, status, status_detail, is_default, open_to_all)
values ('wan_primary', 'primary', 'Primary WhatsApp number', 'verification_required', 'Press Verify to check the connection.', true, true)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- who may see / change what
-- ---------------------------------------------------------------------
alter table whatsapp_numbers            enable row level security;
alter table whatsapp_numbers            force  row level security;
alter table whatsapp_number_users       enable row level security;
alter table whatsapp_number_users       force  row level security;
alter table whatsapp_number_departments enable row level security;
alter table whatsapp_number_departments force  row level security;
alter table whatsapp_messages           enable row level security;
alter table whatsapp_messages           force  row level security;

drop policy if exists wan_admin on whatsapp_numbers;
create policy wan_admin on whatsapp_numbers for all using (app_is_admin()) with check (app_is_admin());
drop policy if exists wanu_admin on whatsapp_number_users;
create policy wanu_admin on whatsapp_number_users for all using (app_is_admin()) with check (app_is_admin());
drop policy if exists wand_admin on whatsapp_number_departments;
create policy wand_admin on whatsapp_number_departments for all using (app_is_admin()) with check (app_is_admin());

-- the department of whoever is asking (recruiters; a BDE's department is "BDE")
create or replace function whatsapp_my_department() returns text
language sql stable security definer set search_path = public as $$
  select case when app_role() = 'bde' then 'BDE'
              else (select department from recruiters where user_id = app_user_id()) end;
$$;

-- THE ONE QUESTION: may the person asking send from this number?
create or replace function whatsapp_number_allowed(p_id text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from whatsapp_numbers n
     where n.id = p_id and n.active and n.removed_at is null
       and (app_is_admin()
            or (app_role() in ('recruiter', 'bde')
                and (n.open_to_all
                     or exists (select 1 from whatsapp_number_users u where u.number_id = n.id and u.user_id = app_user_id())
                     or exists (select 1 from whatsapp_number_departments d
                                 where d.number_id = n.id and lower(btrim(d.department)) = lower(btrim(coalesce(whatsapp_my_department(), '')))))))
  );
$$;

-- what a member of staff sees of the numbers they may use: never a credential
create or replace function whatsapp_my_numbers()
returns table (id text, display_name text, display_phone text, department text, status text, is_default boolean, is_primary boolean)
language sql stable security definer set search_path = public as $$
  select n.id, n.display_name, n.display_phone, n.department, n.status, n.is_default, n.source = 'primary'
    from whatsapp_numbers n
   where whatsapp_number_allowed(n.id)
   order by n.is_default desc, n.display_name;
$$;

-- replace who may use a number: departments, people, and "open to all staff"; keeps the label in step
create or replace function whatsapp_number_set_access(p_id text, p_departments text[], p_users uuid[], p_open boolean)
returns whatsapp_numbers
language plpgsql security definer set search_path = public as $$
declare v whatsapp_numbers; d text;
begin
  if not app_is_admin() then raise exception 'only an administrator may assign WhatsApp numbers' using errcode = '42501'; end if;
  select * into v from whatsapp_numbers where id = p_id and removed_at is null for update;
  if not found then raise exception 'no such WhatsApp number' using errcode = 'P0002'; end if;
  delete from whatsapp_number_departments where number_id = p_id;
  foreach d in array coalesce(p_departments, '{}') loop
    if btrim(d) <> '' then
      insert into whatsapp_number_departments (number_id, department, assigned_by) values (p_id, btrim(d), app_user_id())
      on conflict do nothing;
    end if;
  end loop;
  delete from whatsapp_number_users where number_id = p_id;
  insert into whatsapp_number_users (number_id, user_id, assigned_by)
  select p_id, u.id, app_user_id() from users u where u.id = any(coalesce(p_users, '{}')) and u.role in ('recruiter', 'bde', 'admin')
  on conflict do nothing;
  update whatsapp_numbers
     set open_to_all = coalesce(p_open, false), updated_by = app_user_id(), updated_at = now(),
         department = (select string_agg(department, ', ' order by lower(department)) from whatsapp_number_departments where number_id = p_id)
   where id = p_id returning * into v;
  perform audit_write('whatsapp_number.assigned', 'whatsapp_number', p_id,
    jsonb_build_object('departments', coalesce(p_departments, '{}'), 'users', coalesce(p_users, '{}'), 'open_to_all', coalesce(p_open, false)));
  return v;
end $$;

-- one default among the live numbers
create or replace function whatsapp_number_make_default(p_id text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not app_is_admin() then raise exception 'only an administrator may change the default number' using errcode = '42501'; end if;
  if not exists (select 1 from whatsapp_numbers where id = p_id and active and removed_at is null) then
    raise exception 'only an active number can be the default' using errcode = '22023';
  end if;
  update whatsapp_numbers set is_default = false where is_default and id <> p_id;
  update whatsapp_numbers set is_default = true, updated_by = app_user_id(), updated_at = now() where id = p_id;
  perform audit_write('whatsapp_number.default', 'whatsapp_number', p_id, '{}'::jsonb);
end $$;

-- inbound messages and the agent's replies, per number (the webhook and the agent call this as the system)
create or replace function whatsapp_message_record(
  p_number text, p_direction text, p_contact text, p_name text, p_body text, p_wamid text, p_kind text, p_by text default null
) returns bigint
language plpgsql security definer set search_path = public as $$
declare v bigint; c text; d text := regexp_replace(coalesce(p_contact, ''), '\D', '', 'g');
begin
  if d = '' or not exists (select 1 from whatsapp_numbers where id = p_number) then return null; end if;
  select id into c from candidates where length(d) >= 10 and right(regexp_replace(coalesce(phone, ''), '\D', '', 'g'), 10) = right(d, 10) limit 1;
  insert into whatsapp_messages (number_id, direction, contact, contact_name, candidate_id, kind, body, wa_message_id, sent_by_name)
  values (p_number, p_direction, d, left(p_name, 120), c, coalesce(p_kind, 'text'), left(p_body, 4000), nullif(p_wamid, ''), left(p_by, 120))
  on conflict (number_id, wa_message_id) where wa_message_id is not null do nothing
  returning id into v;
  return v;
end $$;

drop policy if exists wam_read on whatsapp_messages;
create policy wam_read on whatsapp_messages for select using (whatsapp_number_allowed(number_id));

-- queue one personalised template message (0158/0159) - now also records which number it leaves from
drop function if exists message_log_queue_wa(text, text, text, text, text, text, text, jsonb, text, uuid, text, text, text);
create or replace function message_log_queue_wa(
  p_batch text, p_candidate text, p_candidate_name text, p_to text, p_template_id text, p_template_name text,
  p_body text, p_payload jsonb, p_application text, p_actor uuid, p_actor_role text, p_actor_name text, p_campaign text,
  p_number text, p_number_label text
) returns message_logs
language plpgsql security definer set search_path = public as $$
declare v message_logs;
begin
  insert into message_logs
    (batch_id, candidate_id, channel, template_id, subject, body, to_address, status, sent_by, sent_by_role,
     wa_payload, application_id, template_name, candidate_name, recruiter_name, campaign_name, whatsapp_number_id, number_label)
  values
    (p_batch, p_candidate, 'whatsapp', p_template_id, null, p_body, nullif(btrim(coalesce(p_to, '')), ''),
     case when nullif(btrim(coalesce(p_to, '')), '') is null then 'skipped_no_contact' else 'queued' end,
     p_actor, p_actor_role, p_payload, p_application, p_template_name, p_candidate_name, left(coalesce(p_actor_name, ''), 120),
     left(nullif(btrim(coalesce(p_campaign, '')), ''), 120), p_number, left(p_number_label, 160))
  on conflict (batch_id, candidate_id) where channel = 'whatsapp' and wa_payload is not null do nothing
  returning * into v;
  if v.id is null then
    select * into v from message_logs where batch_id = p_batch and candidate_id = p_candidate and channel = 'whatsapp' and wa_payload is not null;
  end if;
  return v;
end $$;

-- the older free-text bulk path: stamp the number on a row it has just queued
create or replace function message_log_set_number(p_id bigint, p_number text, p_label text) returns void
language sql security definer set search_path = public as $$
  update message_logs set whatsapp_number_id = p_number, number_label = left(p_label, 160)
   where id = p_id and channel = 'whatsapp' and status = 'queued';
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant select, insert, update, delete on whatsapp_numbers, whatsapp_number_users, whatsapp_number_departments to app_api;
    grant select on whatsapp_messages to app_api;
    grant usage, select on sequence whatsapp_messages_id_seq to app_api;
    grant execute on function whatsapp_my_department() to app_api;
    grant execute on function whatsapp_number_allowed(text) to app_api;
    grant execute on function whatsapp_my_numbers() to app_api;
    grant execute on function whatsapp_number_set_access(text, text[], uuid[], boolean) to app_api;
    grant execute on function whatsapp_number_make_default(text) to app_api;
    grant execute on function whatsapp_message_record(text, text, text, text, text, text, text, text) to app_api;
    grant execute on function message_log_queue_wa(text, text, text, text, text, text, text, jsonb, text, uuid, text, text, text, text, text) to app_api;
    grant execute on function message_log_set_number(bigint, text, text) to app_api;
  end if;
end $$;
