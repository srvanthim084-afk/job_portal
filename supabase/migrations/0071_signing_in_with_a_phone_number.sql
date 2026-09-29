-- ---------------------------------------------------------------------
-- 0071 — signing in with a phone number
--
-- WHY. A great many candidates reach this portal with a mobile number
-- and no email address: met at a walk-in, taken down over the telephone,
-- imported from a sheet that had a "Number" column and nothing else. The
-- login identity was `users.email` and the sign-in form validated its
-- box as an address, so those people could be recorded and could never
-- get in. "Add Candidate" now accepts a phone alone, which makes that
-- gap wider rather than narrower unless the phone can also sign in.
--
-- WHAT THIS IS NOT. It is not a second login system, and it does not
-- weaken the first. The same `users` row, the same password hash, the
-- same session machinery; only the way the row is FOUND changes.
--
-- AMBIGUITY IS REFUSED, NOT GUESSED. Two candidates can share a phone
-- number - a family handset, a number typed twice during an import. If a
-- number does not identify exactly one account, this returns nothing and
-- the sign-in fails in the ordinary way. Picking "the most recent one"
-- would sooner or later sign somebody into a stranger's profile, and
-- that is a worse outcome than a refused login.
--
-- ONLY CANDIDATES. `candidates` is the only profile table with a phone
-- column; staff sign in by address, as before.
-- ---------------------------------------------------------------------

/**
 * Find the account behind a login, which may be an address or a number.
 *
 * Returns the same shape as auth_find_user, which it does not replace -
 * that function is left in place and still works.
 */
create or replace function auth_find_login(p_login text)
returns table (id uuid, email text, password_hash text, role user_role, status text)
language plpgsql security definer set search_path = public as $$
declare v_digits text;
declare v_count  int;
declare v_user   uuid;
begin
  /* An address is tried first and exactly, so nothing about existing
     sign-ins changes. */
  return query
    select u.id, u.email, u.password_hash, u.role, u.status
      from users u
     where lower(u.email) = lower(btrim(coalesce(p_login, '')))
     limit 1;
  if found then return; end if;

  /*
   * The last ten digits, so +91 98450 11111, 09845011111 and
   * 9845011111 are one telephone - the same comparison the duplicate
   * check and the outbound allowlist already use.
   */
  v_digits := right(regexp_replace(coalesce(p_login, ''), '\D', '', 'g'), 10);
  if length(v_digits) < 10 then return; end if;

  select count(distinct c.user_id) into v_count
    from candidates c
   where c.user_id is not null
     and (right(regexp_replace(coalesce(c.phone, ''),     '\D', '', 'g'), 10) = v_digits
       or right(regexp_replace(coalesce(c.alt_phone, ''), '\D', '', 'g'), 10) = v_digits);

  /* Nobody, or more than one. Either way this number does not say who
     is signing in, so it does not sign anybody in. */
  if v_count <> 1 then return; end if;

  select distinct c.user_id into v_user
    from candidates c
   where c.user_id is not null
     and (right(regexp_replace(coalesce(c.phone, ''),     '\D', '', 'g'), 10) = v_digits
       or right(regexp_replace(coalesce(c.alt_phone, ''), '\D', '', 'g'), 10) = v_digits);

  return query
    select u.id, u.email, u.password_hash, u.role, u.status
      from users u where u.id = v_user;
end $$;

/*
 * Looking a number up on every sign-in attempt should not read the whole
 * candidate table.
 */
create index if not exists cand_phone_digits_idx
  on candidates ((right(regexp_replace(coalesce(phone, ''), '\D', '', 'g'), 10)))
  where user_id is not null;

create index if not exists cand_altphone_digits_idx
  on candidates ((right(regexp_replace(coalesce(alt_phone, ''), '\D', '', 'g'), 10)))
  where user_id is not null;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant execute on function auth_find_login(text) to app_api;
  end if;
end $$;
