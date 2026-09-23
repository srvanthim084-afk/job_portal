-- ---------------------------------------------------------------------
-- 0029 — emptying the portal of everything that was never real
--
-- The database shipped with a seed: three companies, ninety-two job
-- postings, four hundred candidates, two hundred applications and a set
-- of staff logins advertised on the login page as "sample accounts".
-- That is exactly right for a prototype and exactly wrong for a company
-- about to put its own candidates in - a recruiter cannot tell a seeded
-- application from one of theirs, and neither can a report.
--
-- This empties it. Two logins survive, named explicitly rather than
-- guessed at, because a purge that locks everybody out of the system is
-- not a purge, it is an outage.
--
-- The recruiter needs a company to belong to - RLS scopes their work by
-- it - so one is created for them before the seeded three are removed.
--
-- IRREVERSIBLE, admin only, and it does nothing without p_confirm.
-- ---------------------------------------------------------------------

create or replace function purge_demo_data(
  p_confirm boolean default false,
  p_keep_emails text[] default array['admin@teamlink.com', 'teamlinkmed001@tmlink.in']
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_keep   text[] := (select array_agg(lower(e)) from unnest(p_keep_emails) e);
  v_counts jsonb;
  v_company text := 'tmlink';
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
    'recruiters',   (select count(*) from recruiters
                      where lower(email) <> all(v_keep)),
    'clients',      (select count(*) from client_users),
    'logins',       (select count(*) from users
                      where lower(email) <> all(v_keep))
  ) into v_counts;

  if not p_confirm then
    return v_counts;
  end if;

  -- A home for the surviving recruiter, made BEFORE the seeded companies
  -- go, so their row never points at nothing.
  insert into companies (id, name)
  values (v_company, 'TeamLink Consultants')
  on conflict (id) do nothing;

  update recruiters set company_id = v_company
   where lower(email) = any(v_keep);

  -- Work first, then the people who did it, then the places they did it.
  delete from applications;
  delete from candidates;
  delete from jobs;

  delete from client_users;
  delete from recruiters where lower(email) <> all(v_keep);
  delete from admins      where lower(email) <> all(v_keep);

  -- The logins last: a user row is what every profile hangs from.
  delete from users where lower(email) <> all(v_keep);

  delete from companies where id <> v_company;

  return v_counts;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant execute on function purge_demo_data(boolean, text[]) to app_api;
  end if;
end $$;
