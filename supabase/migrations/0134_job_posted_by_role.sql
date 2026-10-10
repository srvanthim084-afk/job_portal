-- ---------------------------------------------------------------------
-- 0134 - "Posted By": the creator's role, beside their name (0125)
--
-- The Admin panel's Jobs list tells Admin-posted jobs from recruiter-posted
-- ones. 0125 already stamps jobs.created_by (users.id, set by the database
-- on insert, never changed) and names it with staff_name_of(); this adds
-- the role, read the same way - a definer function, because a recruiter's
-- session cannot read the users table.
-- ---------------------------------------------------------------------
create or replace function staff_role_of(p_user uuid)
returns text
language sql stable security definer set search_path = public as $$
  /* staff only, like staff_name_of: a candidate or a visitor is told nothing */
  select case when app_role() in ('recruiter','admin','bde','client')
    then (select u.role from users u where u.id = p_user) end;
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant execute on function staff_role_of(uuid) to app_api;
  end if;
end $$;
