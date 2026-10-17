-- ---------------------------------------------------------------------
-- 0154 - an administrator can set a recruiter's password AS GIVEN (no forced change at first sign-in)
--
-- staff_recruiter_password(id, hash) always set must_change_password = true: the recruiter had to choose a new
-- password the first time they signed in, so the password the administrator typed never stayed. When the team has been
-- given a password already and the owner wants exactly that one to keep working, the administrator passes
-- p_must_change = false. The default stays true (the old behaviour), and nothing here is ever called by a script or a
-- background job: it runs only from the admin's own "set password" action.
--
-- Written to the audit log - who, for whom, whether a change is still required - and never the password.
-- ---------------------------------------------------------------------
create or replace function staff_recruiter_password(p_id text, p_hash text, p_must_change boolean)
returns boolean
language plpgsql security definer set search_path = public as $$
declare v_user uuid;
begin
  if not app_is_admin() then
    raise exception 'only an administrator may reset a password' using errcode = '42501';
  end if;
  select user_id into v_user from recruiters where id = p_id;
  if v_user is null then return false; end if;
  update users set password_hash = p_hash, must_change_password = coalesce(p_must_change, true),
                   password_set_at = now(), updated_at = now()
   where id = v_user;
  perform audit_write('staff.password_set', 'recruiter', p_id,
    jsonb_build_object('mustChangePassword', coalesce(p_must_change, true)));
  return true;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant execute on function staff_recruiter_password(text, text, boolean) to app_api;
  end if;
end $$;
