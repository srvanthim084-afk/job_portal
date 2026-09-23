-- ---------------------------------------------------------------------
-- 0036 — the impersonation lookup could not see the account
--
-- impersonate() read `users` directly, inside withUser(null) - the same
-- anonymous context login() uses, because a session does not exist yet
-- at that point. Row-level security correctly shows an anonymous caller
-- nothing in `users`, so the lookup found no row and every "Login As
-- Recruiter" answered "That account does not exist" about an account
-- that plainly did.
--
-- login() does not have this problem because it goes through
-- auth_find_user(), which is SECURITY DEFINER. This is the same thing
-- for an account being entered by an administrator.
--
-- It returns only what the decision needs - the role and whether the
-- login is active - and never the password hash.
-- ---------------------------------------------------------------------

create or replace function auth_user_for_impersonation(p_user_id uuid)
returns table (id uuid, email text, role user_role, status text)
language sql security definer set search_path = public as $$
  select u.id, u.email, u.role, u.status
    from users u
   where u.id = p_user_id;
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant execute on function auth_user_for_impersonation(uuid) to app_api;
  end if;
end $$;
