-- 0127: single sign-on from TeamLink HRMS (TeamLink.Enterprise).
--
-- A recruiter or admin signed in to HRMS opens the Job Portal without a
-- second login. HRMS signs a 60-second, single-use token (HS256, shared
-- secret HRMS_SSO_SECRET); api/src/sso/hrms.js checks it and opens an
-- ordinary portal session for the account with the same email. Contract:
-- docs/HRMS-SSO.md.
--
-- What the database adds:
--   hrms_sso_tokens   every token id (jti) ever accepted, until it would have
--                     expired anyway - a second use of the same token fails.
--   hrms_sso_logins   one row per HRMS session that opened the portal, so the
--                     audit log says "Login (via HRMS)" once per HRMS session,
--                     however often the user moves between the two apps.
--   sessions.hrms_sid / last_seen_at / hrms_checked_at
--                     a portal session opened from HRMS carries the HRMS
--                     session id. Both apps share ONE inactivity timeout:
--                     the portal asks HRMS whether that session is still
--                     alive (and tells it about activity here), and HRMS
--                     logging out ends every portal session with that id.
--
-- Nothing here changes a session opened with a password: hrms_sid is null
-- for those and every function below leaves them alone.

create table if not exists hrms_sso_tokens (
  jti         text primary key,
  expires_at  timestamptz not null,
  used_at     timestamptz not null default now()
);
create index if not exists hrms_sso_tokens_expires_idx on hrms_sso_tokens (expires_at);

create table if not exists hrms_sso_logins (
  hrms_sid    text primary key,
  user_id     uuid not null references users(id) on delete cascade,
  first_at    timestamptz not null default now()
);

alter table sessions add column if not exists hrms_sid        text;
alter table sessions add column if not exists last_seen_at    timestamptz;
alter table sessions add column if not exists hrms_checked_at timestamptz;
create index if not exists sessions_hrms_sid_idx on sessions (hrms_sid) where hrms_sid is not null;

-- Neither table is read by the API role directly: only through the definer
-- functions below.
alter table hrms_sso_tokens enable row level security;
alter table hrms_sso_logins enable row level security;

/* Records a token id. TRUE the first time, FALSE for a replay. Expired ids
   are dropped on the way: a token past its expiry is refused on that ground
   before this is ever called, so keeping its id longer proves nothing. */
create or replace function hrms_sso_consume_jti(p_jti text, p_expires timestamptz)
returns boolean
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  delete from hrms_sso_tokens where expires_at < now() - interval '5 minutes';
  insert into hrms_sso_tokens (jti, expires_at) values (p_jti, p_expires)
  on conflict (jti) do nothing;
  get diagnostics n = row_count;
  return n = 1;
end $$;

/* The account HRMS is vouching for: by EMAIL only (never the phone-number
   fallback auth_find_login has for candidates). */
create or replace function hrms_sso_find_account(p_email text)
returns table (user_id uuid, role user_role, status text)
language sql security definer set search_path = public as $$
  select u.id, u.role, u.status from users u
   where lower(u.email) = lower(btrim(p_email))
   limit 1
$$;

create or replace function hrms_sso_mark_session(p_token_hash text, p_sid text)
returns void
language sql security definer set search_path = public as $$
  update sessions set hrms_sid = p_sid, last_seen_at = now(), hrms_checked_at = now()
   where token_hash = p_token_hash
$$;

/* No row = not an HRMS session (or no session at all). */
create or replace function hrms_sso_session_state(p_token_hash text)
returns table (hrms_sid text, last_seen_at timestamptz, hrms_checked_at timestamptz)
language sql security definer set search_path = public as $$
  select s.hrms_sid, s.last_seen_at, s.hrms_checked_at from sessions s
   where s.token_hash = p_token_hash and s.hrms_sid is not null
$$;

/* Moves last_seen_at forward only (never back), and stamps the HRMS check. */
create or replace function hrms_sso_touch(p_token_hash text, p_seen timestamptz, p_checked boolean)
returns void
language sql security definer set search_path = public as $$
  update sessions
     set last_seen_at = greatest(coalesce(last_seen_at, p_seen), p_seen),
         hrms_checked_at = case when p_checked then now() else hrms_checked_at end
   where token_hash = p_token_hash and hrms_sid is not null
$$;

/* HRMS logged out (or its session timed out): every portal session opened
   from that HRMS session ends. Returns how many. */
create or replace function hrms_sso_end_sid(p_sid text)
returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  delete from sessions where hrms_sid = p_sid;
  get diagnostics n = row_count;
  return n;
end $$;

/* TRUE only the first time this HRMS session opens the portal. */
create or replace function hrms_sso_first_login(p_sid text, p_user uuid)
returns boolean
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  insert into hrms_sso_logins (hrms_sid, user_id) values (p_sid, p_user)
  on conflict (hrms_sid) do nothing;
  get diagnostics n = row_count;
  return n = 1;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant execute on function hrms_sso_consume_jti(text, timestamptz),
                              hrms_sso_find_account(text),
                              hrms_sso_mark_session(text, text),
                              hrms_sso_session_state(text),
                              hrms_sso_touch(text, timestamptz, boolean),
                              hrms_sso_end_sid(text),
                              hrms_sso_first_login(text, uuid)
      to app_api;
  end if;
end $$;
