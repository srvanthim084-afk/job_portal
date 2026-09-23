-- ---------------------------------------------------------------------
-- 0030 — a purge that reports what it actually did
--
-- 0029 counted the rows, deleted, and returned the counts it had taken
-- BEFORE deleting. So it printed "REMOVED 403 candidates" whether or not
-- a single row went, and the first version of this ran to a cheerful
-- report while the portal still held everything. A tool that cannot fail
-- visibly is worse than no tool.
--
-- It now measures again afterwards and returns both, so "removed" is a
-- subtraction anybody can check rather than a claim.
--
-- Deletes run one table at a time with GET DIAGNOSTICS, because row-level
-- security silently filters a DELETE rather than refusing it: a policy
-- that does not match simply removes nothing, and the statement still
-- succeeds. Counting the rows the statement actually touched is the only
-- way to tell the two apart.
-- ---------------------------------------------------------------------

create or replace function purge_demo_data(
  p_confirm boolean default false,
  p_keep_emails text[] default array['admin@teamlink.com', 'teamlinkmed001@tmlink.in']
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_keep    text[] := (select array_agg(lower(e)) from unnest(p_keep_emails) e);
  v_company text := 'tmlink';
  v_before  jsonb;
  v_after   jsonb;
  v_hit     jsonb := '{}'::jsonb;
  n         bigint;
begin
  if not app_is_admin() then
    raise exception 'only an administrator may empty the portal'
      using errcode = '42501';
  end if;

  select jsonb_build_object(
    'applications', (select count(*) from applications),
    'candidates',   (select count(*) from candidates),
    'jobs',         (select count(*) from jobs),
    'companies',    (select count(*) from companies),
    'recruiters',   (select count(*) from recruiters),
    'clients',      (select count(*) from client_users),
    'logins',       (select count(*) from users)
  ) into v_before;

  if not p_confirm then
    return jsonb_build_object('confirmed', false, 'before', v_before);
  end if;

  insert into companies (id, name) values (v_company, 'TeamLink Consultants')
  on conflict (id) do nothing;
  update recruiters set company_id = v_company where lower(email) = any(v_keep);

  delete from applications;  get diagnostics n = row_count;
  v_hit := v_hit || jsonb_build_object('applications', n);

  delete from candidates;    get diagnostics n = row_count;
  v_hit := v_hit || jsonb_build_object('candidates', n);

  delete from jobs;          get diagnostics n = row_count;
  v_hit := v_hit || jsonb_build_object('jobs', n);

  delete from client_users;  get diagnostics n = row_count;
  v_hit := v_hit || jsonb_build_object('clients', n);

  delete from recruiters where lower(email) <> all(v_keep);
  get diagnostics n = row_count;
  v_hit := v_hit || jsonb_build_object('recruiters', n);

  delete from admins where lower(email) <> all(v_keep);

  delete from users where lower(email) <> all(v_keep);
  get diagnostics n = row_count;
  v_hit := v_hit || jsonb_build_object('logins', n);

  delete from companies where id <> v_company;
  get diagnostics n = row_count;
  v_hit := v_hit || jsonb_build_object('companies', n);

  select jsonb_build_object(
    'applications', (select count(*) from applications),
    'candidates',   (select count(*) from candidates),
    'jobs',         (select count(*) from jobs),
    'companies',    (select count(*) from companies),
    'recruiters',   (select count(*) from recruiters),
    'clients',      (select count(*) from client_users),
    'logins',       (select count(*) from users)
  ) into v_after;

  return jsonb_build_object('confirmed', true, 'before', v_before,
                            'deleted', v_hit, 'after', v_after);
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant execute on function purge_demo_data(boolean, text[]) to app_api;
  end if;
end $$;
