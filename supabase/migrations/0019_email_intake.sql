-- ---------------------------------------------------------------------
-- 0019 — Naukri email intake, and the application reference everything
--        else hangs off
--
-- WHAT ALREADY EXISTS AND IS REUSED
--
--   candidates / applications   already separate entities, with
--                               unique (candidate_id, job_id) — so one
--                               person applying to two roles is already
--                               two applications and one profile. Nothing
--                               about that changes.
--   applications.source         already per-application, so Naukri for
--                               one and LinkedIn for another is already
--                               modelled correctly.
--   ai_interviews.application_id already links a result to the
--                               APPLICATION rather than to the person.
--   notifications / notification_deliveries   the communication history.
--   application_stage_history   the stage half of the timeline.
--   users.password_hash         bcrypt, set through the auth code.
--
-- WHAT IS NEW
--
--   applications.reference      TL-APP-2026-00452. The id stays as it is
--                               because a hundred rows point at it; the
--                               reference is what people quote.
--   email_mailboxes             a recruiter's connected inbox
--   email_messages              every message seen, processed once
--   application_events          the activity timeline, per application
--   users.must_change_password  a temporary password is temporary
-- ---------------------------------------------------------------------

/* ---------------------------------------------------------------- *
 * the application reference
 *
 * Human-quotable, unique, and stable: it goes in an email, an SMS, a
 * WhatsApp message and a phone call, and a candidate reads it back to a
 * recruiter. `app_7f3k2` cannot be read down a phone line.
 * ---------------------------------------------------------------- */
alter table applications
  add column if not exists reference text;

create table if not exists application_reference_seq (
  year int primary key,
  n    int not null default 0
);

create or replace function next_application_reference(p_when timestamptz default now())
returns text
language plpgsql security definer set search_path = public as $$
declare v_year int; v_n int;
begin
  v_year := extract(year from p_when)::int;
  insert into application_reference_seq (year, n) values (v_year, 1)
    on conflict (year) do update set n = application_reference_seq.n + 1
    returning n into v_n;
  return 'TL-APP-' || v_year || '-' || lpad(v_n::text, 5, '0');
end $$;

/* Every application gets one, including the ones already here. */
do $$
declare r record;
begin
  for r in select id, applied_at from applications where reference is null order by applied_at loop
    update applications set reference = next_application_reference(r.applied_at) where id = r.id;
  end loop;
end $$;

create unique index if not exists applications_reference_idx on applications (reference);

create or replace function application_reference_fill() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.reference is null then
    new.reference := next_application_reference(coalesce(new.applied_at, now()));
  end if;
  return new;
end $$;

drop trigger if exists application_reference_t on applications;
create trigger application_reference_t before insert on applications
  for each row execute function application_reference_fill();

/* ---------------------------------------------------------------- *
 * where an application came from, traceably
 * ---------------------------------------------------------------- */
alter table applications
  add column if not exists import_method     text,   -- recruiter_email | portal | manual | api
  add column if not exists source_message_id text,   -- the email it came from
  add column if not exists imported_by       text,   -- the recruiter whose inbox it was
  add column if not exists imported_at       timestamptz;

create index if not exists applications_import_idx on applications (import_method, imported_at desc);

/* A temporary password must be temporary. */
alter table users
  add column if not exists must_change_password boolean not null default false,
  add column if not exists password_set_at      timestamptz;

/* ---------------------------------------------------------------- *
 * mailboxes
 *
 * No password is stored here. Real providers use OAuth and the token
 * lives in the server's environment or secret store; `config` holds
 * non-secret settings only, and the column is documented as such so
 * nobody is tempted.
 * ---------------------------------------------------------------- */
create table if not exists email_mailboxes (
  id           text primary key,
  address      text not null unique,
  provider     text not null default 'mock'
                 check (provider in ('mock','imap','gmail','outlook')),
  owner_user_id uuid references users(id) on delete set null,
  recruiter_id text references recruiters(id) on delete set null,
  display_name text,
  status       text not null default 'disconnected'
                 check (status in ('connected','disconnected','error')),
  auto_sync    boolean not null default true,
  last_sync_at timestamptz,
  last_error   text,
  -- Which messages count as an application. Sender domains, subject
  -- patterns and keywords - configurable, because Naukri changes its
  -- templates and a hard-coded rule silently stops importing.
  rules        jsonb not null default '{}',
  config       jsonb not null default '{}',   -- NON-SECRET settings only
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

/* ---------------------------------------------------------------- *
 * every message seen, processed exactly once
 * ---------------------------------------------------------------- */
create table if not exists email_messages (
  id            text primary key,
  mailbox_id    text references email_mailboxes(id) on delete cascade,
  -- The provider's own id. Unique, and the reason the same email cannot
  -- create the same application twice however many times a sync runs.
  message_id    text not null,
  from_address  text,
  to_address    text,
  subject       text,
  received_at   timestamptz,
  snippet       text,
  raw           text,
  has_attachment boolean not null default false,
  attachment_name text,

  status        text not null default 'new'
                  check (status in ('new','ignored','needs_mapping','needs_review',
                                    'processed','failed','duplicate')),
  reason        text,
  parsed        jsonb,
  candidate_id  text references candidates(id) on delete set null,
  application_id text references applications(id) on delete set null,
  processed_at  timestamptz,
  created_at    timestamptz not null default now(),
  unique (mailbox_id, message_id)
);

create index if not exists email_messages_status_idx on email_messages (status, received_at desc);
create index if not exists email_messages_app_idx on email_messages (application_id);

/* ---------------------------------------------------------------- *
 * the activity timeline
 *
 * Keyed on the APPLICATION, because that is what the candidate and the
 * recruiter are both looking at. Candidate-level events carry the
 * application too, so "every event references the Application ID" holds.
 * ---------------------------------------------------------------- */
create table if not exists application_events (
  id             bigserial primary key,
  application_id text references applications(id) on delete cascade,
  candidate_id   text references candidates(id) on delete cascade,
  type           text not null,
  detail         text,
  actor          text,          -- 'system', a recruiter id, or 'candidate'
  metadata       jsonb,
  at             timestamptz not null default now()
);

create index if not exists application_events_app_idx on application_events (application_id, at desc);
create index if not exists application_events_cand_idx on application_events (candidate_id, at desc);

/* ---------------------------------------------------------------- *
 * RLS
 * ---------------------------------------------------------------- */
alter table email_mailboxes     enable row level security;
alter table email_mailboxes     force  row level security;
alter table email_messages      enable row level security;
alter table email_messages      force  row level security;
alter table application_events  enable row level security;
alter table application_events  force  row level security;
alter table application_reference_seq enable row level security;
alter table application_reference_seq force row level security;

drop policy if exists email_mailboxes_read on email_mailboxes;
create policy email_mailboxes_read on email_mailboxes for select using (
  app_is_admin() or app_role() in ('recruiter','bde')
);

drop policy if exists email_messages_read on email_messages;
create policy email_messages_read on email_messages for select using (
  app_is_admin() or app_role() in ('recruiter','bde')
);

/* The candidate sees their own timeline; staff see it through the same
   visibility rules as the application itself. */
drop policy if exists application_events_read on application_events;
create policy application_events_read on application_events for select using (
  app_is_admin()
  or candidate_id = app_candidate_id()
  or app_role() in ('recruiter','bde','client')
);

/* ---------------------------------------------------------------- *
 * writes
 * ---------------------------------------------------------------- */

create or replace function app_event(
  p_application_id text, p_candidate_id text, p_type text,
  p_detail text, p_actor text, p_metadata jsonb
) returns bigint
language sql security definer set search_path = public as $$
  insert into application_events (application_id, candidate_id, type, detail, actor, metadata)
  values (p_application_id, p_candidate_id, p_type, left(p_detail, 2000),
          coalesce(p_actor, 'system'), coalesce(p_metadata, '{}'::jsonb))
  returning id;
$$;

/* Record a message the moment it is seen, before anything is decided
   about it: a sync that crashes half way must not re-import what it
   already imported. */
create or replace function email_message_seen(
  p_id text, p_mailbox_id text, p_message_id text, p_from text, p_to text,
  p_subject text, p_received timestamptz, p_snippet text, p_raw text,
  p_has_attachment boolean, p_attachment_name text
) returns text
language plpgsql security definer set search_path = public as $$
declare v_id text;
begin
  insert into email_messages
    (id, mailbox_id, message_id, from_address, to_address, subject,
     received_at, snippet, raw, has_attachment, attachment_name)
  values
    (p_id, p_mailbox_id, p_message_id, p_from, p_to, p_subject,
     coalesce(p_received, now()), left(p_snippet, 2000), left(p_raw, 200000),
     coalesce(p_has_attachment, false), p_attachment_name)
  on conflict (mailbox_id, message_id) do nothing
  returning id into v_id;

  -- Already seen: hand back the existing row so the caller can skip it.
  if v_id is null then
    select id into v_id from email_messages
     where mailbox_id = p_mailbox_id and message_id = p_message_id;
  end if;
  return v_id;
end $$;

create or replace function email_message_result(
  p_id text, p_status text, p_reason text, p_parsed jsonb,
  p_candidate_id text, p_application_id text
) returns void
language sql security definer set search_path = public as $$
  update email_messages
     set status = p_status,
         reason = p_reason,
         parsed = coalesce(p_parsed, parsed),
         candidate_id = coalesce(p_candidate_id, candidate_id),
         application_id = coalesce(p_application_id, application_id),
         processed_at = now()
   where id = p_id;
$$;

create or replace function mailbox_upsert(
  p_id text, p_address text, p_provider text, p_recruiter_id text,
  p_display_name text, p_auto_sync boolean, p_rules jsonb, p_config jsonb
) returns text
language plpgsql security definer set search_path = public as $$
declare v_id text;
begin
  insert into email_mailboxes
    (id, address, provider, recruiter_id, display_name, auto_sync, rules, config, status)
  values
    (p_id, lower(p_address), coalesce(p_provider,'mock'), p_recruiter_id, p_display_name,
     coalesce(p_auto_sync, true), coalesce(p_rules,'{}'::jsonb), coalesce(p_config,'{}'::jsonb),
     'connected')
  on conflict (address) do update
     set provider = excluded.provider,
         recruiter_id = coalesce(excluded.recruiter_id, email_mailboxes.recruiter_id),
         display_name = coalesce(excluded.display_name, email_mailboxes.display_name),
         auto_sync = excluded.auto_sync,
         rules = excluded.rules,
         config = excluded.config,
         status = 'connected',
         updated_at = now()
  returning id into v_id;
  return v_id;
end $$;

create or replace function mailbox_synced(p_id text, p_error text) returns void
language sql security definer set search_path = public as $$
  update email_mailboxes
     set last_sync_at = now(),
         last_error = p_error,
         status = case when p_error is null then 'connected' else 'error' end,
         updated_at = now()
   where id = p_id;
$$;

/**
 * Create the candidate portal account for an imported candidate.
 *
 * The password arrives already hashed - this function never sees the
 * plaintext, which is generated in the API, sent once to the candidate,
 * and never stored or logged.
 */
create or replace function candidate_portal_account(
  p_candidate_id text, p_email text, p_password_hash text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_user uuid; v_existing uuid; v_email text;
begin
  v_email := lower(trim(p_email));
  if coalesce(v_email, '') = '' then
    return jsonb_build_object('created', false, 'reason', 'no email address');
  end if;

  select user_id into v_existing from candidates where id = p_candidate_id;
  if v_existing is not null then
    return jsonb_build_object('created', false, 'reason', 'already has an account');
  end if;

  select id into v_user from users where lower(email) = v_email;
  if v_user is not null then
    -- The address already signs in - link it rather than making a second
    -- account for the same person.
    update candidates set user_id = v_user where id = p_candidate_id;
    return jsonb_build_object('created', false, 'reason', 'linked an existing login');
  end if;

  insert into users (email, password_hash, role, must_change_password, password_set_at)
  values (v_email, p_password_hash, 'candidate', true, now())
  returning id into v_user;

  update candidates set user_id = v_user where id = p_candidate_id;
  return jsonb_build_object('created', true, 'userId', v_user);
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant select on email_mailboxes, email_messages, application_events to app_api;
    grant execute on function
      next_application_reference(timestamptz),
      app_event(text, text, text, text, text, jsonb),
      email_message_seen(text, text, text, text, text, text, timestamptz, text, text, boolean, text),
      email_message_result(text, text, text, jsonb, text, text),
      mailbox_upsert(text, text, text, text, text, boolean, jsonb, jsonb),
      mailbox_synced(text, text),
      candidate_portal_account(text, text, text)
      to app_api;
  end if;
end $$;
