-- ---------------------------------------------------------------------
-- 0027 — a company can add its own recruiters
--
-- There was no way to create a recruiter login at all. The seeded
-- accounts were the only ones that could ever exist, so a real company
-- adding a colleague meant somebody editing the database by hand.
--
-- SECURITY DEFINER because it writes to `users`, which app_api cannot
-- insert into directly - correctly, since that table is how anybody
-- signs in. The function checks for an administrator itself rather than
-- trusting the route to have done it.
--
-- The password arrives ALREADY HASHED. The plain value never reaches the
-- database, and nothing here returns it.
-- ---------------------------------------------------------------------

create or replace function staff_recruiter_create(
  p_name text,
  p_email text,
  p_password_hash text,
  p_title text,
  p_company_id text
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

  -- Whichever company was named, or the one the deployment already has.
  v_company := coalesce(p_company_id, (select id from companies order by id limit 1));

  insert into users (email, password_hash, role, must_change_password, password_set_at)
  values (v_email, p_password_hash, 'recruiter', true, now())
  returning id into v_user;

  v_id := 'r_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12);

  insert into recruiters (id, user_id, name, email, company_id, title, initials)
  values (v_id, v_user, p_name, v_email, v_company, coalesce(p_title, 'Recruiter'),
          upper(substr(p_name, 1, 1)
            || coalesce(substr(split_part(p_name, ' ', 2), 1, 1), '')));

  return jsonb_build_object('id', v_id, 'name', p_name, 'email', v_email,
                            'companyId', v_company, 'mustChangePassword', true);
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant execute on function
      staff_recruiter_create(text, text, text, text, text) to app_api;
  end if;
end $$;
