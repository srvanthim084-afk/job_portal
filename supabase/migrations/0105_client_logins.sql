-- ---------------------------------------------------------------------
-- 0105 — an administrator can give a client company a login
--
-- A client (the hiring team at a company TeamLink places candidates
-- with) signs in to see its shortlist. Until now the only way to create
-- that login was to write rows into `users` and `client_users` by hand:
-- there was no screen, no API and no function for it, so it was done in
-- the database or not at all.
--
-- SAME RULES AS A RECRUITER LOGIN (0035 staff_recruiter_create):
--   - only an administrator, checked HERE rather than trusted from the
--     route
--   - the password arrives ALREADY HASHED; the plain value never reaches
--     the database, and nothing returns it
--   - it is a temporary password: must_change_password is set, so the
--     client chooses their own at first sign-in (POST /auth/password)
--   - one address, one login (the case-insensitive unique index on users)
--
-- AUDITED. Every login an administrator creates writes a row to
-- staff_audit in the same transaction: who did it, when, to which
-- company, for which address. Never the password, not even hashed.
-- ---------------------------------------------------------------------

create table if not exists staff_audit (
  id           bigserial primary key,
  actor_id     text,                    -- users.id of the administrator, as text
  action       text not null check (action in ('client_login_created')),
  target_kind  text not null,
  target_id    text not null,
  detail       jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);
create index if not exists staff_audit_when on staff_audit (created_at desc);

alter table staff_audit enable row level security;

/* Only an administrator reads it; nobody writes it except the function below. */
do $$
begin
  if not exists (select 1 from pg_policies
                  where tablename = 'staff_audit' and policyname = 'staff_audit_admin') then
    create policy staff_audit_admin on staff_audit for select using (app_is_admin());
  end if;
end $$;

/**
 * The login, the client profile and the audit row, in one go.
 * SECURITY DEFINER because app_api cannot insert into `users`.
 */
create or replace function staff_client_create(
  p_name text,
  p_email text,
  p_password_hash text,
  p_company_id text,
  p_title text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_user  uuid;
  v_id    text;
  v_email text := lower(trim(p_email));
  v_name  text := btrim(coalesce(p_name, ''));
begin
  if not app_is_admin() then
    raise exception 'only an administrator may add a client login'
      using errcode = '42501';
  end if;
  if v_email = '' then raise exception 'an email address is required'; end if;
  if v_name = '' then raise exception 'a name is required'; end if;
  if coalesce(p_password_hash, '') = '' then raise exception 'a password is required'; end if;
  if not exists (select 1 from companies where id = p_company_id) then
    raise exception 'that company does not exist' using errcode = '23503';
  end if;
  if exists (select 1 from users where lower(email) = v_email) then
    raise exception 'that address already signs in' using errcode = '23505';
  end if;

  insert into users (email, password_hash, role, status, must_change_password, password_set_at)
  values (v_email, p_password_hash, 'client', 'active', true, now())
  returning id into v_user;

  v_id := 'c_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12);

  insert into client_users (id, user_id, name, email, company_id, title, initials)
  values (v_id, v_user, v_name, v_email, p_company_id,
          nullif(btrim(coalesce(p_title, '')), ''),
          upper(substr(v_name, 1, 1) || coalesce(substr(split_part(v_name, ' ', 2), 1, 1), '')));

  insert into staff_audit (actor_id, action, target_kind, target_id, detail)
  values (app_user_id()::text, 'client_login_created', 'client_user', v_id,
          jsonb_build_object('email', v_email, 'companyId', p_company_id));

  return jsonb_build_object('id', v_id, 'name', v_name, 'email', v_email,
                            'companyId', p_company_id, 'title', nullif(btrim(coalesce(p_title, '')), ''));
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant execute on function staff_client_create(text, text, text, text, text) to app_api;
    grant select on staff_audit to app_api;
  end if;
end $$;

comment on table staff_audit is
  'Administrator actions on logins (0105: client logins created). Never holds a password.';
