-- =====================================================================
-- Database roles
--
-- This file is what makes the policies in 0002_rls.sql real.
--
-- A superuser — and a table owner under most configurations — bypasses
-- row-level security completely. If the API connected as either, every
-- policy would be decorative: the tests in tools/verify-rls.mjs prove
-- this by failing wholesale when run as a superuser.
--
-- So the API gets its own unprivileged role. It owns nothing, it cannot
-- create anything, and it has no BYPASSRLS attribute, which means every
-- statement it runs is filtered by the policies.
-- =====================================================================

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_api') then
    -- NOLOGIN here; the deployment grants LOGIN and sets the password from
    -- the environment, so no credential is ever written into a migration.
    create role app_api nologin;
  end if;
end $$;

-- explicitly strip anything inherited from PUBLIC
revoke all on schema public from public;
revoke all on all tables    in schema public from public;
revoke all on all functions in schema public from public;

grant usage on schema public to app_api;

-- table privileges. DELETE is granted narrowly: the API soft-deletes
-- (status/archived flags) almost everywhere, and RLS still governs which
-- rows any of this can touch.
grant select, insert, update on all tables in schema public to app_api;
grant delete on applications, saved_jobs, hidden_jobs, job_alerts,
                candidate_bookmarks, candidate_list_members, candidate_lists,
                saved_searches, candidate_comments, sessions, user_prefs
  to app_api;

-- the API never writes reference data
revoke insert, update on stages from app_api;

grant usage, select on all sequences in schema public to app_api;

-- the SECURITY DEFINER auth surface (login, registration, sessions,
-- system notifications) — the only way app_api reaches users/sessions
grant execute on function
  auth_find_user(text),
  auth_create_user(text, text, user_role),
  auth_create_session(uuid, text, timestamptz, text, inet),
  auth_resolve_session(text),
  auth_destroy_session(text),
  auth_purge_expired_sessions(),
  auth_register_candidate(text, text, text, text, text),
  public_login_hints(),
  notify_create(text, text, user_role, text, text, text, text, text, text, text, jsonb)
  to app_api;

-- identity helpers used inside the policies themselves
grant execute on function
  app_user_id(), app_role(), app_is_admin(), app_candidate_id(),
  app_recruiter_id(), app_client_company(), app_recruiter_company(),
  app_client_visible_stages(),
  app_candidate_at_company(text, text, text[])
  to app_api;

-- Runtime guards, scoped to the application role so they never apply to
-- migrations. A web request that has been running for 30 seconds is a bug,
-- and an idle open transaction holds locks that block everyone else.
alter role app_api set statement_timeout = '30s';
alter role app_api set idle_in_transaction_session_timeout = '60s';
alter role app_api set lock_timeout = '10s';

-- anything created later keeps the same shape
alter default privileges in schema public
  grant select, insert, update on tables to app_api;
alter default privileges in schema public
  grant usage, select on sequences to app_api;

-- =====================================================================
-- Deployment note
--
-- Grant LOGIN and a password out of band, never in a committed file:
--
--   ALTER ROLE app_api LOGIN PASSWORD '<from APP_DB_PASSWORD>';
--
-- The API's DATABASE_URL must connect as app_api. Pointing it at the
-- postgres superuser silently disables every policy above — so
-- tools/verify-rls.mjs asserts the connection role is NOT a superuser.
-- =====================================================================
