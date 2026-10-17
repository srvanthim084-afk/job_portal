-- ---------------------------------------------------------------------
-- 0155 - an administrator can correct a recruiter's login email (a typo such as tmllink.in for tmlink.in)
--
-- The email IS the login, and the Edit screen deliberately never changed it. A mistyped address at the time the account
-- was made then leaves the person unable to sign in with their real address, with no way to fix it short of a new account.
-- This moves the SAME account to the corrected address: the password, the company, the team, every job and application
-- stay exactly as they are - only the address changes, in the login and in the recruiter's profile together.
--
-- Refused when another account (any role) already uses the address. Audited with the old and the new address and never a
-- password. Nothing calls it automatically: it runs only from the administrator's own action.
-- ---------------------------------------------------------------------
create or replace function staff_recruiter_email(p_id text, p_email text)
returns text
language plpgsql security definer set search_path = public as $$
declare v_user uuid; v_old text; v_new text;
begin
  if not app_is_admin() then
    raise exception 'only an administrator may change a login email' using errcode = '42501';
  end if;
  v_new := lower(btrim(coalesce(p_email, '')));
  if v_new !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'that is not a valid email address' using errcode = '22023';
  end if;
  select user_id, email into v_user, v_old from recruiters where id = p_id;
  if v_user is null then return 'no_account'; end if;
  if exists (select 1 from users where lower(email) = v_new and id <> v_user)
     or exists (select 1 from recruiters where lower(email) = v_new and id <> p_id) then
    raise exception 'that address already signs in' using errcode = '23505';
  end if;
  update users set email = v_new, updated_at = now() where id = v_user;
  update recruiters set email = v_new where id = p_id;
  perform audit_write('staff.email_corrected', 'recruiter', p_id,
    jsonb_build_object('from', v_old, 'to', v_new));
  return 'ok';
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant execute on function staff_recruiter_email(text, text) to app_api;
  end if;
end $$;
