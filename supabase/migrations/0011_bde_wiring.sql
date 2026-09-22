-- ---------------------------------------------------------------------
-- 0011 — BDE: login hints, and a place for the pipeline to reach them
--
-- 0010 gave the role its table, its policies and its exports. This is what
-- the rest of the application needs in order to SEE it:
--
--   * public_login_hints() must list BDEs, or the Quick Demo Login panel
--     on the BDE login screen is empty and there is no way in.
--   * notify_create() already takes a user_role, so BDE notifications work
--     as soon as something sends one - nothing to change there.
-- ---------------------------------------------------------------------

create or replace function public_login_hints()
returns table (role text, id text, name text, sub text)
language sql stable security definer set search_path = public as $$
  select 'recruiter'::text, r.id, r.name, coalesce(co.name, '')
    from recruiters r left join companies co on co.id = r.company_id
  union all
  select 'client'::text, cl.id, cl.name, coalesce(co.name, '')
    from client_users cl left join companies co on co.id = cl.company_id
  union all
  select 'bde'::text, b.id, b.name, coalesce(co.name, '')
    from bde_users b left join companies co on co.id = b.company_id
  union all
  select 'admin'::text, a.id, a.name, a.email from admins a
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant execute on function public_login_hints() to app_api;
  end if;
end $$;
