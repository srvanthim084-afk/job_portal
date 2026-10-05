-- ---------------------------------------------------------------------
-- 0109 — the multi-step registration, the Candidate ID, consent,
--        registration messages, documents and privacy requests
--
-- WHAT ALREADY EXISTS AND IS REUSED (nothing below replaces it)
--
--   candidates                 the profile; 0057 already added date of
--                              birth, alternate email, state, the opt-in
--                              flags, preferred contact method, relevant
--                              experience and the photo columns
--   candidate_education /      0057/0080 rows: the degree, branch,
--   candidate_experience       college, year and score of each level
--   candidate_documents        0057: the filing cabinet for everything
--                              that is not the resume
--   auth_register_candidate    0002: creates the user and the profile in
--                              one step. Re-created below with the same
--                              signature and one more check (mobile).
--   application_reference_seq  0019: the TL-APP reference. The Candidate
--                              ID copies its shape exactly.
--
-- WHAT IS NEW
--
--   candidates.candidate_code  TL-CAN-000123, for every candidate (the
--                              existing ones are numbered in the order
--                              they arrived). The id stays as it is: a
--                              hundred tables point at it.
--   a handful of columns the form needs and nothing held: first, middle
--   and last name, WhatsApp number, city, country, preferred employment
--   types
--   candidate_consents         what was agreed to, which version, when
--   candidate_registration_messages   the welcome email and the one
--                              profile reminder, each sent at most once
--   account_deletion_requests  recorded, shown to an admin, never acted
--                              on automatically
-- ---------------------------------------------------------------------

/* ---------------------------------------------------------------- *
 * 1. the Candidate ID
 * ---------------------------------------------------------------- */
alter table candidates add column if not exists candidate_code text;

/* One row, one counter - the same idea as application_reference_seq,
   without the year: a candidate keeps one number for life. */
create table if not exists candidate_code_seq (
  id int primary key default 1 check (id = 1),
  n  int not null default 0
);
insert into candidate_code_seq (id, n) values (1, 0) on conflict (id) do nothing;
/* Only the definer function below moves the counter (as 0019 does for
   application_reference_seq). */
alter table candidate_code_seq enable row level security;
alter table candidate_code_seq force  row level security;

create or replace function next_candidate_code()
returns text
language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  update candidate_code_seq set n = n + 1 where id = 1 returning n into v_n;
  if v_n is null then
    insert into candidate_code_seq (id, n) values (1, 1)
      on conflict (id) do update set n = candidate_code_seq.n + 1
      returning n into v_n;
  end if;
  return 'TL-CAN-' || lpad(v_n::text, 6, '0');
end $$;

/* Every candidate gets one, including the ones already here - oldest
   first, so the numbers read in the order people joined. */
do $$
declare r record;
begin
  for r in select id from candidates where candidate_code is null order by created_at, id loop
    update candidates set candidate_code = next_candidate_code() where id = r.id;
  end loop;
end $$;

create unique index if not exists candidates_candidate_code_idx on candidates (candidate_code);

create or replace function candidate_code_fill() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.candidate_code is null then
    new.candidate_code := next_candidate_code();
  end if;
  return new;
end $$;

drop trigger if exists candidate_code_t on candidates;
create trigger candidate_code_t before insert on candidates
  for each row execute function candidate_code_fill();

/* Nobody edits a Candidate ID: once given, it is what people quote. */
create or replace function candidate_code_keep() returns trigger
language plpgsql as $$
begin
  if old.candidate_code is not null and new.candidate_code is distinct from old.candidate_code then
    new.candidate_code := old.candidate_code;
  end if;
  return new;
end $$;

drop trigger if exists candidate_code_keep_t on candidates;
create trigger candidate_code_keep_t before update on candidates
  for each row execute function candidate_code_keep();

/* ---------------------------------------------------------------- *
 * 2. the fields the form asks for that had nowhere to go
 * ---------------------------------------------------------------- */
alter table candidates
  add column if not exists first_name   text,
  add column if not exists middle_name  text,
  add column if not exists last_name    text,
  add column if not exists whatsapp_number text,
  add column if not exists city         text,
  add column if not exists country      text,
  add column if not exists preferred_employment_types text[] default '{}';

/* Replace / Download / Delete of a document keeps one row per document. */
alter table candidate_documents
  add column if not exists updated_at timestamptz;

/* ---------------------------------------------------------------- *
 * 3. one account per mobile number, in the database
 *
 * The same function as 0002, with the same signature, so every caller
 * keeps working. The addition: a mobile number that already belongs to
 * a candidate WITH AN ACCOUNT is refused, compared on its last ten
 * digits so "+91 98765 43210", "098765 43210" and "9876543210" are one
 * telephone. A record a recruiter typed in (no account) does not block
 * the person themselves from registering.
 *
 * The advisory lock makes two registrations racing with one number
 * queue rather than both getting through.
 * ---------------------------------------------------------------- */
create or replace function phone_digits10(p text) returns text
language sql immutable as $$
  select nullif(right(regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g'), 10), '')
$$;

create or replace function auth_register_candidate(
  p_email text, p_hash text, p_candidate_id text, p_name text, p_phone text default null)
returns text
language plpgsql security definer set search_path = public as $$
declare v_uid uuid; v_digits text;
begin
  perform pg_advisory_xact_lock(hashtext('tl-register-email:' || lower(coalesce(p_email, ''))));
  if exists (select 1 from users where lower(email) = lower(p_email)) then
    raise exception 'email_taken' using errcode = 'unique_violation';
  end if;

  v_digits := phone_digits10(p_phone);
  if v_digits is not null and length(v_digits) = 10 then
    perform pg_advisory_xact_lock(hashtext('tl-register-phone:' || v_digits));
    if exists (select 1 from candidates c
                where c.user_id is not null
                  and phone_digits10(c.phone) = v_digits) then
      raise exception 'phone_taken' using errcode = 'unique_violation';
    end if;
  end if;

  insert into users (email, password_hash, role)
  values (p_email, p_hash, 'candidate') returning id into v_uid;
  insert into candidates (id, user_id, name, email, phone)
  values (p_candidate_id, v_uid, p_name, p_email, p_phone);
  return p_candidate_id;
end $$;

/*
 * Is this address / number already an account? For the form's inline
 * message only - the registration itself is the authority. Answers
 * booleans, never whose account it is.
 */
create or replace function auth_registration_taken(p_email text, p_phone text)
returns table (email_taken boolean, phone_taken boolean)
language sql stable security definer set search_path = public as $$
  select
    (coalesce(btrim(p_email), '') <> ''
       and exists (select 1 from users where lower(email) = lower(btrim(p_email)))),
    (length(coalesce(phone_digits10(p_phone), '')) = 10
       and exists (select 1 from candidates c
                    where c.user_id is not null
                      and phone_digits10(c.phone) = phone_digits10(p_phone)))
$$;

/* ---------------------------------------------------------------- *
 * 4. consent
 *
 * One row per thing agreed to, with the version of the wording that was
 * on screen. A later change of mind is a new row, not an edit: what was
 * agreed on a date stays a fact about that date.
 * ---------------------------------------------------------------- */
create table if not exists candidate_consents (
  id           bigserial primary key,
  candidate_id text not null references candidates(id) on delete cascade,
  kind         text not null check (kind in ('terms', 'communication', 'resume_processing')),
  status       text not null check (status in ('granted', 'withdrawn')),
  version      text not null,
  policy_url   text,
  source       text not null default 'registration',
  created_at   timestamptz not null default now()
);
create index if not exists ccons_by_candidate on candidate_consents (candidate_id, kind, created_at desc);

alter table candidate_consents enable row level security;
alter table candidate_consents force  row level security;
drop policy if exists ccons_read on candidate_consents;
create policy ccons_read on candidate_consents for select
  using (exists (select 1 from candidates c where c.id = candidate_consents.candidate_id));
/* Written only through the functions below. */

/*
 * At registration, on the anonymous connection - the same reason as
 * auth_register_preferences (0082). It writes only to a candidate made
 * in the last fifteen minutes that has no consent recorded yet, so it
 * cannot be used to put words in an existing person's mouth.
 */
create or replace function auth_register_consents(
  p_candidate_id text, p_version text, p_policy_url text,
  p_terms boolean, p_communication boolean, p_resume boolean)
returns int
language plpgsql security definer set search_path = public as $$
declare v_n int := 0;
begin
  if not exists (select 1 from candidates
                  where id = p_candidate_id
                    and created_at > now() - interval '15 minutes') then
    return 0;
  end if;
  if exists (select 1 from candidate_consents where candidate_id = p_candidate_id) then
    return 0;
  end if;
  if p_terms then
    insert into candidate_consents (candidate_id, kind, status, version, policy_url)
    values (p_candidate_id, 'terms', 'granted', p_version, p_policy_url);
    v_n := v_n + 1;
  end if;
  if p_communication then
    insert into candidate_consents (candidate_id, kind, status, version, policy_url)
    values (p_candidate_id, 'communication', 'granted', p_version, p_policy_url);
    v_n := v_n + 1;
  end if;
  if p_resume then
    insert into candidate_consents (candidate_id, kind, status, version, policy_url)
    values (p_candidate_id, 'resume_processing', 'granted', p_version, p_policy_url);
    v_n := v_n + 1;
  end if;
  return v_n;
end $$;

/* The candidate themselves, signed in, changing their mind later. */
create or replace function candidate_consent_set(p_kind text, p_status text, p_version text)
returns boolean
language plpgsql security definer set search_path = public as $$
declare v_cid text := app_candidate_id();
begin
  if v_cid is null then return false; end if;
  if p_kind not in ('terms', 'communication', 'resume_processing')
     or p_status not in ('granted', 'withdrawn') then
    return false;
  end if;
  insert into candidate_consents (candidate_id, kind, status, version, source)
  values (v_cid, p_kind, p_status, coalesce(nullif(p_version, ''), 'unknown'), 'profile');
  return true;
end $$;

/* The latest answer per kind. */
create or replace view candidate_consent_current with (security_invoker = true) as
  select distinct on (candidate_id, kind)
         candidate_id, kind, status, version, policy_url, source, created_at
    from candidate_consents
   order by candidate_id, kind, created_at desc, id desc;

/* ---------------------------------------------------------------- *
 * 5. the welcome email and the one profile reminder
 *
 * A row is CLAIMED before anything is sent (insert ... on conflict do
 * nothing), so two servers, a restart or a double click can never send
 * the same message twice. Every attempt's outcome is written back,
 * including the failures.
 * ---------------------------------------------------------------- */
create table if not exists candidate_registration_messages (
  id           bigserial primary key,
  candidate_id text not null references candidates(id) on delete cascade,
  kind         text not null check (kind in ('welcome', 'profile_reminder')),
  channel      text not null default 'email',
  status       text not null default 'pending',
               -- pending | sent | failed | retrying | not_configured | skipped_* | blocked_*
  attempts     int  not null default 0,
  to_address   text,
  provider     text,
  error        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (candidate_id, kind, channel)
);
create index if not exists crm_status on candidate_registration_messages (kind, status);

alter table candidate_registration_messages enable row level security;
alter table candidate_registration_messages force  row level security;
drop policy if exists crm_read on candidate_registration_messages;
create policy crm_read on candidate_registration_messages for select
  using (app_is_admin() or candidate_id = app_candidate_id());

create or replace function registration_engine_ok() returns boolean
language sql stable as $$
  select app_role() = 'admin' and app_user_id() is null
$$;

/* Claim: true when this call is the one that may send. A failed earlier
   attempt may be claimed again (up to three attempts) as 'retrying'. */
create or replace function registration_message_claim(
  p_candidate_id text, p_kind text, p_to text)
returns boolean
language plpgsql security definer set search_path = public as $$
declare v_id bigint;
begin
  if not registration_engine_ok() then raise exception 'engine only'; end if;
  insert into candidate_registration_messages (candidate_id, kind, to_address, status, attempts)
  values (p_candidate_id, p_kind, p_to, 'pending', 1)
  on conflict (candidate_id, kind, channel) do nothing
  returning id into v_id;
  if v_id is not null then return true; end if;

  update candidate_registration_messages
     set status = 'retrying', attempts = attempts + 1, updated_at = now(), to_address = p_to
   where candidate_id = p_candidate_id and kind = p_kind and channel = 'email'
     and status = 'failed' and attempts < 3
     and updated_at < now() - interval '10 minutes'
  returning id into v_id;
  return v_id is not null;
end $$;

create or replace function registration_message_done(
  p_candidate_id text, p_kind text, p_status text, p_provider text, p_error text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not registration_engine_ok() then raise exception 'engine only'; end if;
  update candidate_registration_messages
     set status = left(coalesce(p_status, 'failed'), 40), provider = p_provider,
         error = left(p_error, 500), updated_at = now()
   where candidate_id = p_candidate_id and kind = p_kind and channel = 'email';
end $$;

/* Who may hear from us at all, read once per message. */
create or replace function registration_message_target(p_candidate_id text)
returns table (id text, name text, email text, candidate_code text,
               do_not_contact boolean, email_opt_in boolean, communication text,
               has_account boolean)
language sql stable security definer set search_path = public as $$
  select c.id, c.name, c.email, c.candidate_code,
         coalesce(c.do_not_contact, false), coalesce(c.email_opt_in, true),
         (select cc.status from candidate_consents cc
           where cc.candidate_id = c.id and cc.kind = 'communication'
           order by cc.created_at desc, cc.id desc limit 1),
         c.user_id is not null
    from candidates c
   where c.id = p_candidate_id and registration_engine_ok()
$$;

/*
 * Whose profile reminder is due.
 *
 * ONLY people who registered through this flow (they have a welcome
 * row), so the existing database is never suddenly written to. At least
 * p_after_hours since registering, at most 30 days, still thin, still
 * reachable, not reminded already, and not nudged by the older
 * profile_incomplete sweep (0038) in the last week.
 */
create or replace function registration_reminders_due(p_after_hours int, p_limit int default 100)
returns table (id text)
language sql stable security definer set search_path = public as $$
  select c.id
    from candidates c
    join candidate_registration_messages w
      on w.candidate_id = c.id and w.kind = 'welcome'
   where registration_engine_ok()
     and c.user_id is not null
     and c.created_at < now() - make_interval(hours => greatest(p_after_hours, 1))
     and c.created_at > now() - interval '30 days'
     and not coalesce(c.do_not_contact, false)
     and coalesce(c.email_opt_in, true)
     and coalesce(btrim(c.email), '') <> ''
     and not exists (select 1 from candidate_registration_messages r
                      where r.candidate_id = c.id and r.kind = 'profile_reminder')
     and not exists (select 1 from candidate_nudges n
                      where n.candidate_id = c.id and n.created_at > now() - interval '7 days')
     and (
       (case when coalesce(btrim(c.resume_file), '') <> '' then 1 else 0 end)
     + (case when coalesce(array_length(c.skills, 1), 0) > 0 then 1 else 0 end)
     + (case when coalesce(btrim(c.education), '') <> ''
              or exists (select 1 from candidate_education e where e.candidate_id = c.id) then 1 else 0 end)
     + (case when coalesce(btrim(c.summary), '') <> '' then 1 else 0 end)
     + (case when coalesce(btrim(c.preferred_role), '') <> ''
              and coalesce(btrim(c.preferred_location), '') <> '' then 1 else 0 end)
     + (case when coalesce(btrim(c.linkedin), '') <> '' or coalesce(btrim(c.github), '') <> ''
              or coalesce(btrim(c.portfolio), '') <> '' then 1 else 0 end)
     + (case when c.candidate_type = 'fresher' or coalesce(btrim(c.current_company), '') <> ''
              or exists (select 1 from candidate_experience x where x.candidate_id = c.id) then 1 else 0 end)
     ) < 6
   order by c.created_at
   limit greatest(p_limit, 1)
$$;

/* ---------------------------------------------------------------- *
 * 6. account deletion requests
 *
 * Recorded and shown to an administrator. NOTHING is deleted
 * automatically, and nothing here deletes at all: an admin may close a
 * request and, if they choose, deactivate the login and stop all
 * contact; erasing the record is a deliberate, separate decision.
 * ---------------------------------------------------------------- */
create table if not exists account_deletion_requests (
  id            bigserial primary key,
  candidate_id  text not null references candidates(id) on delete cascade,
  reason        text,
  status        text not null default 'pending'
                  check (status in ('pending', 'in_review', 'completed', 'rejected', 'cancelled')),
  requested_at  timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  processed_at  timestamptz,
  processed_by  uuid references users(id),
  admin_note    text,
  deactivated   boolean not null default false
);
create unique index if not exists adr_one_open
  on account_deletion_requests (candidate_id) where status in ('pending', 'in_review');
create index if not exists adr_by_status on account_deletion_requests (status, requested_at desc);

alter table account_deletion_requests enable row level security;
alter table account_deletion_requests force  row level security;
drop policy if exists adr_read on account_deletion_requests;
create policy adr_read on account_deletion_requests for select
  using (app_is_admin() or candidate_id = app_candidate_id());
drop policy if exists adr_insert on account_deletion_requests;
create policy adr_insert on account_deletion_requests for insert
  with check (candidate_id = app_candidate_id() and status = 'pending');
/* The candidate may cancel their own open request; an admin processes. */
drop policy if exists adr_update on account_deletion_requests;
create policy adr_update on account_deletion_requests for update
  using (app_is_admin() or (candidate_id = app_candidate_id() and status = 'pending'))
  with check (app_is_admin() or (candidate_id = app_candidate_id() and status = 'cancelled'));

/*
 * An admin closing a request may also switch the login off and stop all
 * contact. users has no UPDATE policy (0070), so this is a definer
 * function with the admin check inside it.
 */
create or replace function deletion_request_deactivate(p_request_id bigint)
returns boolean
language plpgsql security definer set search_path = public as $$
declare v_cid text; v_uid uuid;
begin
  if not app_is_admin() or app_user_id() is null then return false; end if;
  select r.candidate_id into v_cid from account_deletion_requests r where r.id = p_request_id;
  if v_cid is null then return false; end if;
  select user_id into v_uid from candidates where id = v_cid;
  update candidates set do_not_contact = true where id = v_cid;
  if v_uid is not null then
    update users set status = 'suspended', updated_at = now() where id = v_uid;
    delete from sessions where user_id = v_uid;
  end if;
  update account_deletion_requests set deactivated = true, updated_at = now() where id = p_request_id;
  return true;
end $$;

/* ---------------------------------------------------------------- *
 * grants
 * ---------------------------------------------------------------- */
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant select on candidate_consents, candidate_consent_current,
                    candidate_registration_messages, account_deletion_requests to app_api;
    grant insert, update on account_deletion_requests to app_api;
    grant usage, select on sequence account_deletion_requests_id_seq to app_api;
    grant execute on function
      next_candidate_code(),
      phone_digits10(text),
      auth_register_candidate(text, text, text, text, text),
      auth_registration_taken(text, text),
      auth_register_consents(text, text, text, boolean, boolean, boolean),
      candidate_consent_set(text, text, text),
      registration_engine_ok(),
      registration_message_claim(text, text, text),
      registration_message_done(text, text, text, text, text),
      registration_message_target(text),
      registration_reminders_due(int, int),
      deletion_request_deactivate(bigint)
      to app_api;
  end if;
end $$;

comment on column candidates.candidate_code is
  'The human Candidate ID (TL-CAN-000123), given once by trigger and never changed. The id column stays the internal key.';
