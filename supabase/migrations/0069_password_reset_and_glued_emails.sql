-- ---------------------------------------------------------------------
-- 0069 — a way back in
--
-- Two problems that are really one problem: people who cannot reach
-- their own account.
--
-- 1. THE ADDRESS WE STORED IS NOT THE ADDRESS THEY HAVE.
--
--    PDF text extraction runs lines together. An email at the end of one
--    line and a "Phone:" label at the start of the next arrive as a
--    single token - "someone@gmail.comPhone" - and the TLD part of the
--    address pattern, being "two or more letters", swallowed the label
--    because "comPhone" is all letters.
--
--    That string then became the LOGIN email. The candidate types the
--    address they actually own, the server correctly answers that no
--    such account exists, and there is nothing either of them can do
--    about it. Two accounts are in this state.
--
--    The parser itself is fixed in api/src/resume/fields.js; this
--    repairs the rows already written.
--
-- 2. THERE IS NO WAY TO RESET A PASSWORD.
--
--    The whole of auth is login, register, logout, me, and a password
--    change that requires you to be signed in already. Seventy-odd
--    candidate accounts exist and not one of them has a route back from
--    a forgotten password. Support cannot help either: no endpoint
--    issues a reset.
--
-- ADDITIVE. One new table, two new functions, and an UPDATE that only
-- ever shortens a value and only when the result is still a valid
-- address. Nothing is dropped or renamed.
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- 1. the glued labels
--
-- The rule is deliberately narrow: cut a label word off the end ONLY
-- when what precedes it is a real TLD. "dev@thing.company" is left
-- alone, because "company" is not a label glued onto ".com" - it is the
-- domain. An address invented here would be worse than a malformed one,
-- because a malformed one is visibly wrong.
-- ---------------------------------------------------------------------
create or replace function repair_glued_email(p_email text) returns text
language sql immutable as $$
  select regexp_replace(
    coalesce(p_email, ''),
    '(\.(com|in|org|net|edu|gov|io|co|me|info|biz|ac|uk|us|dev|app|tech|online|site|xyz))'
    || '(phones?|mobiles?|e-?mails?|contacts?|address|telephone|tel|cell|whatsapp|dob'
    || '|linkedin|github|gender|nationality|languages?|skills?|objective|career'
    || '|profile|summary)$',
    '\1', 'i');
$$;

/*
 * The candidate's own record.
 *
 * `is distinct from` rather than `<>` so a null email does not quietly
 * drop out of the count, and the collision guard so repairing one row
 * can never violate somebody else's address.
 */
update candidates c
   set email = repair_glued_email(c.email),
       updated_at = now()
 where c.email is not null
   and repair_glued_email(c.email) is distinct from c.email
   and not exists (
     select 1 from candidates o
      where o.id <> c.id
        and lower(o.email) = lower(repair_glued_email(c.email)));

/*
 * The login identity.
 *
 * This is the one that actually unlocks the account. `users_email_lower_key`
 * is a unique index on lower(email), so the guard is not optional.
 */
update users u
   set email = repair_glued_email(u.email),
       updated_at = now()
 where u.email is not null
   and repair_glued_email(u.email) is distinct from u.email
   and not exists (
     select 1 from users o
      where o.id <> u.id
        and lower(o.email) = lower(repair_glued_email(u.email)));

-- ---------------------------------------------------------------------
-- 2. password resets
--
-- The TOKEN IS NEVER STORED. Only its SHA-256 hash is, exactly as
-- sessions already do it, so a leaked database does not hand out
-- working reset links.
-- ---------------------------------------------------------------------
create table if not exists password_resets (
  id           bigserial primary key,
  user_id      uuid not null references users(id) on delete cascade,
  token_hash   text not null unique,
  expires_at   timestamptz not null,
  /* Set the moment it is spent, so a link works exactly once even if
     somebody replays it a second later. */
  used_at      timestamptz,
  requested_ip inet,
  created_at   timestamptz not null default now()
);
create index if not exists password_resets_user_idx
  on password_resets (user_id, created_at desc);

alter table password_resets enable row level security;
alter table password_resets force  row level security;

/*
 * NOBODY READS THIS TABLE THROUGH RLS. Not the owner, not an admin.
 * Everything that touches it runs unauthenticated - the person asking
 * for a reset is by definition not signed in - so the only access is
 * through the two security-definer functions below, which is also the
 * only place the rules about expiry and reuse can be enforced.
 */
create policy pr_no_direct_access on password_resets for all
  using (false) with check (false);

-- ---------------------------------------------------------------------
-- starting a reset
--
-- Returns the user when the address is known, and NOTHING when it is
-- not. The caller answers the browser identically either way: telling a
-- stranger which addresses have accounts is the one thing a forgot-
-- password form must not do.
--
-- Any earlier unused token for the same user is spent first, so asking
-- twice does not leave two live links.
-- ---------------------------------------------------------------------
create or replace function auth_password_reset_start(
  p_email text, p_token_hash text, p_expires timestamptz, p_ip inet
) returns table (user_id uuid, email text, role user_role, display_name text)
language plpgsql security definer set search_path = public as $$
declare v users;
declare v_name text;
begin
  /*
   * EVERY COLUMN IS QUALIFIED in this function. The OUT parameters are
   * named `email` and `user_id`, which are also column names on the
   * tables below, and an unqualified reference to either is rejected at
   * runtime as ambiguous - "column reference \"email\" is ambiguous" -
   * which surfaces as a reset that silently never sends.
   */
  select * into v from users u where lower(u.email) = lower(trim(p_email)) limit 1;
  if not found then return; end if;

  /* A suspended account is not a forgotten password. */
  if v.status <> 'active' then return; end if;

  update password_resets set used_at = now()
   where password_resets.user_id = v.id and used_at is null;

  insert into password_resets (user_id, token_hash, expires_at, requested_ip)
  values (v.id, p_token_hash, p_expires, p_ip);

  /*
   * What to call them in the message. A reset mail that opens "Hello,"
   * reads like the phishing it is trying not to be mistaken for, and
   * the name is the one thing the recipient can check at a glance.
   *
   * Every profile table is consulted because any role can forget a
   * password, and the address alone does not say which one they are.
   */
  select coalesce(
    (select c.name from candidates    c where c.user_id = v.id),
    (select r.name from recruiters    r where r.user_id = v.id),
    (select a.name from admins        a where a.user_id = v.id),
    (select b.name from bde_users     b where b.user_id = v.id),
    (select cu.name from client_users cu where cu.user_id = v.id)
  ) into v_name;

  return query select v.id, v.email, v.role, v_name;
end $$;

-- ---------------------------------------------------------------------
-- is this link still good?
--
-- Asked when the reset screen OPENS, so somebody who clicked a link from
-- last week is told so before they choose a password and type it twice,
-- rather than after.
--
-- READ ONLY. It does not spend the token, does not extend it, and
-- returns a bare boolean - never the user id or the address - so that a
-- guessed token confirms nothing beyond "no".
-- ---------------------------------------------------------------------
create or replace function auth_password_reset_valid(p_token_hash text)
returns boolean
language sql security definer set search_path = public as $$
  select exists (
    select 1 from password_resets
     where token_hash = p_token_hash
       and used_at is null
       and expires_at > now());
$$;

-- ---------------------------------------------------------------------
-- finishing a reset
--
-- Sets the password, spends the token, and DESTROYS EVERY SESSION the
-- account has. Somebody resetting a password may well be doing it
-- because another person is signed in as them; leaving that session
-- alive would defeat the whole exercise.
--
-- `must_change_password` is cleared: they have just chosen one.
-- ---------------------------------------------------------------------
create or replace function auth_password_reset_consume(
  p_token_hash text, p_new_hash text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_user uuid;
begin
  select pr.user_id into v_user
    from password_resets pr
   where pr.token_hash = p_token_hash
     and pr.used_at is null
     and pr.expires_at > now()
   for update;

  if v_user is null then return null; end if;

  update password_resets set used_at = now() where token_hash = p_token_hash;

  update users
     set password_hash = p_new_hash,
         must_change_password = false,
         password_set_at = now(),
         updated_at = now()
   where id = v_user;

  delete from sessions where user_id = v_user;

  return v_user;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant execute on function auth_password_reset_start(text, text, timestamptz, inet) to app_api;
    grant execute on function auth_password_reset_consume(text, text) to app_api;
    grant execute on function auth_password_reset_valid(text) to app_api;
    grant execute on function repair_glued_email(text) to app_api;
  end if;
end $$;
