-- ---------------------------------------------------------------------
-- 0035 — the recruiter as an employee, not just a login
--
-- A recruiter row held a name, an email and a company. Everything an
-- administrator needs to manage one - who they are on the payroll,
-- which team they sit in, what they were hired as - lived nowhere, so
-- "add a recruiter" meant editing the database and "which team is Kiran
-- on?" had no answer.
--
-- The login itself already exists and already works: users.status is
-- the active/suspended flag the login path reads, so deactivating
-- somebody is a status change rather than a deletion. Nothing here
-- creates a second account for a person - the same users row is what
-- the Recruiter Portal authenticates against.
-- ---------------------------------------------------------------------

alter table recruiters
  add column if not exists employee_id   text,
  add column if not exists mobile        text,
  add column if not exists department    text,
  add column if not exists designation   text,
  add column if not exists recruiter_role text,
  add column if not exists team          text,
  add column if not exists last_activity_at timestamptz;

-- One employee id per company, when one is given at all.
create unique index if not exists recruiters_employee_id_key
  on recruiters (company_id, lower(employee_id))
  where employee_id is not null and btrim(employee_id) <> '';

/**
 * Create the employee, the profile and the login in one go.
 *
 * Replaces the five-argument form from 0027. That one took only a name
 * and an email, which was enough to prove a login worked and not enough
 * to run a desk.
 *
 * SECURITY DEFINER because it writes to `users`, which app_api cannot
 * insert into directly - correctly, since that table is how anybody
 * signs in. It checks for an administrator itself rather than trusting
 * the route to have done it. The password arrives ALREADY HASHED; the
 * plain value never reaches the database.
 */
create or replace function staff_recruiter_create(
  p_name text,
  p_email text,
  p_password_hash text,
  p_title text,
  p_company_id text,
  p_employee_id text default null,
  p_mobile text default null,
  p_department text default null,
  p_recruiter_role text default null,
  p_team text default null,
  p_status text default 'active'
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_user uuid;
  v_id   text;
  v_email text := lower(trim(p_email));
  v_company text;
begin
  if not app_is_admin() then
    raise exception 'only an administrator may add a recruiter'
      using errcode = '42501';
  end if;
  if coalesce(v_email, '') = '' then
    raise exception 'an email address is required';
  end if;
  if exists (select 1 from users where lower(email) = v_email) then
    raise exception 'that address already signs in' using errcode = '23505';
  end if;

  v_company := coalesce(p_company_id, (select id from companies order by id limit 1));

  insert into users (email, password_hash, role, status,
                     must_change_password, password_set_at)
  values (v_email, p_password_hash, 'recruiter',
          case when p_status = 'inactive' then 'suspended' else 'active' end,
          true, now())
  returning id into v_user;

  v_id := 'r_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12);

  insert into recruiters (id, user_id, name, email, company_id, title, initials,
                          employee_id, mobile, department, designation,
                          recruiter_role, team)
  values (v_id, v_user, p_name, v_email, v_company,
          coalesce(p_title, 'Recruiter'),
          upper(substr(p_name, 1, 1)
            || coalesce(substr(split_part(p_name, ' ', 2), 1, 1), '')),
          nullif(btrim(coalesce(p_employee_id, '')), ''),
          nullif(btrim(coalesce(p_mobile, '')), ''),
          nullif(btrim(coalesce(p_department, '')), ''),
          coalesce(p_title, 'Recruiter'),
          nullif(btrim(coalesce(p_recruiter_role, '')), ''),
          nullif(btrim(coalesce(p_team, '')), ''));

  return jsonb_build_object('id', v_id, 'name', p_name, 'email', v_email,
                            'companyId', v_company, 'status', p_status);
end $$;

/** Turn a login on or off. The person and their work are untouched. */
create or replace function staff_recruiter_status(p_id text, p_active boolean)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_user uuid;
begin
  if not app_is_admin() then
    raise exception 'only an administrator may change a login'
      using errcode = '42501';
  end if;
  select user_id into v_user from recruiters where id = p_id;
  if v_user is null then
    raise exception 'that recruiter has no login account';
  end if;
  update users set status = case when p_active then 'active' else 'suspended' end,
                   updated_at = now()
   where id = v_user;
  return jsonb_build_object('id', p_id, 'status', case when p_active then 'active' else 'inactive' end);
end $$;

/** A new password, hashed by the caller. Never the value. */
create or replace function staff_recruiter_password(p_id text, p_hash text)
returns boolean
language plpgsql security definer set search_path = public as $$
declare v_user uuid;
begin
  if not app_is_admin() then
    raise exception 'only an administrator may reset a password'
      using errcode = '42501';
  end if;
  select user_id into v_user from recruiters where id = p_id;
  if v_user is null then return false; end if;
  update users set password_hash = p_hash, must_change_password = true,
                   password_set_at = now(), updated_at = now()
   where id = v_user;
  return true;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant execute on function
      staff_recruiter_create(text, text, text, text, text, text, text, text, text, text, text),
      staff_recruiter_status(text, boolean),
      staff_recruiter_password(text, text)
      to app_api;
  end if;
end $$;
