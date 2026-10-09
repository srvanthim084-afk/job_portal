-- ---------------------------------------------------------------------
-- 0122 — Email (SMTP), SMS Gateway and WhatsApp Business, configured by the
--        administrator and read by every module that sends
--
-- One row per channel: its settings (JSON, nothing secret), its secrets
-- (ONE AES-256-GCM blob, sealed by the server with INTEGRATION_SECRET_KEY, never
-- sent back to a page), its status, and the last test. A separate history
-- table records every save, connect, disconnect and test (field names only,
-- never a value).
--
-- Only an administrator can read or write either table (row-level security);
-- the sending code reads them as the engine.
--
-- ADDITIVE. The environment settings (EMAIL_SMTP_*, SMS_*, WHATSAPP_*) keep working;
-- a CONNECTED channel here takes over from them while it is connected, and
-- Disconnect hands the channel back to the environment.
-- ---------------------------------------------------------------------

create table if not exists integration_channels (
  channel          text primary key check (channel in ('email', 'sms', 'whatsapp')),
  config           jsonb not null default '{}',
  secrets_enc      text,
  secret_hints     jsonb not null default '{}',
  status           text not null default 'not_connected' check (status in ('connected', 'not_connected')),
  last_tested_at   timestamptz,
  last_test_ok     boolean,
  last_test_message text,
  updated_by       uuid references users(id),
  updated_at       timestamptz not null default now()
);

create table if not exists integration_channel_events (
  id          bigserial primary key,
  channel     text not null,
  event       text not null,
  detail      text,
  actor       uuid references users(id),
  created_at  timestamptz not null default now()
);
create index if not exists integration_channel_events_idx on integration_channel_events (channel, id desc);

alter table integration_channels       enable row level security;
alter table integration_channels       force  row level security;
alter table integration_channel_events enable row level security;
alter table integration_channel_events force  row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'integration_channels' and policyname = 'integration_channels_admin') then
    create policy integration_channels_admin on integration_channels for all
      using (app_is_admin()) with check (app_is_admin());
  end if;
  if not exists (select 1 from pg_policies where tablename = 'integration_channel_events' and policyname = 'integration_channel_events_admin') then
    create policy integration_channel_events_admin on integration_channel_events for all
      using (app_is_admin()) with check (app_is_admin());
  end if;
end $$;
