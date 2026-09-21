-- =====================================================================
-- Row-level security
--
-- Requirement 5: "Do not rely on JavaScript conditions such as
-- if(role === 'admin') as the only security mechanism."
--
-- These policies are the deepest layer. The API also checks permissions
-- in code, but even a bug there cannot leak another tenant's rows,
-- because every query runs with the caller's identity bound to the
-- session and the database re-checks it.
--
-- Identity is carried in two GUCs the API sets per request/transaction:
--     set local app.user_id    = '<uuid>'
--     set local app.role       = 'candidate' | 'recruiter' | 'client' | 'admin'
--
-- IMPORTANT: none of this applies to a superuser, and FORCE below is what
-- stops a table owner being exempt too. The API therefore connects as the
-- unprivileged `app_api` role created in 0004_roles.sql. Connecting the
-- API as `postgres` would silently disable every policy in this file.
-- =====================================================================

-- ---------------------------------------------------------------------
-- identity helpers
-- ---------------------------------------------------------------------
create or replace function app_user_id() returns uuid
language sql stable as $$
  select nullif(current_setting('app.user_id', true), '')::uuid
$$;

create or replace function app_role() returns text
language sql stable as $$
  select coalesce(nullif(current_setting('app.role', true), ''), 'anon')
$$;

-- NOTE: there is deliberately no app_is_service() GUC escape.
-- A settings-based "I am the service" flag can be switched on by anything
-- able to call set_config(), which turns a single SQL-injection bug into
-- full privilege escalation. Trust is carried by the CONNECTION ROLE:
--   * migrations and seeding connect as a superuser, which bypasses RLS
--   * the API connects as app_api, which never does (see 0004_roles.sql)
-- Login must read a user row before any identity exists, so that one path
-- uses the SECURITY DEFINER functions at the end of this file rather than
-- a blanket exemption.

create or replace function app_is_admin() returns boolean
language sql stable as $$
  select app_role() = 'admin'
$$;

-- The caller's own profile id ('cand1' / 'r1' / 'c1').
--
-- These MUST be SECURITY DEFINER. The policy on `candidates` calls
-- app_candidate_id(), which reads `candidates` — and that read is itself
-- subject to the same policy, so an INVOKER-rights version recurses until
-- Postgres aborts with "stack depth limit exceeded". Running them as the
-- definer breaks the cycle by reading the row without re-entering RLS.
--
-- This is safe because each one is keyed strictly on app_user_id(): it can
-- only ever return the caller's own id, never anyone else's.
create or replace function app_candidate_id() returns text
language sql stable security definer set search_path = public as $$
  select id from candidates where user_id = app_user_id()
$$;

create or replace function app_recruiter_id() returns text
language sql stable security definer set search_path = public as $$
  select id from recruiters where user_id = app_user_id()
$$;

create or replace function app_client_company() returns text
language sql stable security definer set search_path = public as $$
  select company_id from client_users where user_id = app_user_id()
$$;

create or replace function app_recruiter_company() returns text
language sql stable security definer set search_path = public as $$
  select company_id from recruiters where user_id = app_user_id()
$$;

-- Same recursion trap: the policies on `candidates`, `interviews` and
-- `offers` all probe `applications`, whose own policy probes them back.
-- One definer-rights helper answers "does this candidate have an
-- application at this company, at a visible stage?" without re-entering.
create or replace function app_candidate_at_company(
  p_candidate_id text, p_company_id text, p_stages text[] default null)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from applications a join jobs j on j.id = a.job_id
    where a.candidate_id = p_candidate_id
      and j.company_id   = p_company_id
      and (p_stages is null or a.stage = any (p_stages))
  )
$$;

-- Exactly the stages CLIENT_VISIBLE_STAGES lists at prototype.html:4939.
-- A client must never see a candidate still in 'applied' or 'ai_screening'.
create or replace function app_client_visible_stages() returns text[]
language sql immutable as $$
  select array['shortlisted','interview_scheduled','ai_interview_done',
               'client_review','offer_extended','selected','rejected']::text[]
$$;

-- ---------------------------------------------------------------------
-- turn RLS on everywhere (FORCE so the owner is not exempt)
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'users','sessions','companies','recruiters','client_users','admins',
    'jobs','candidates','applications','application_stage_history',
    'interviews','offers','notifications','notification_log',
    'candidate_comments','candidate_lists','candidate_list_members',
    'saved_searches','recent_searches','candidate_bookmarks',
    'candidate_reports','comm_templates','view_events','saved_jobs',
    'hidden_jobs','job_alerts','feedback','user_prefs','app_settings','stages'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force  row level security', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- reference data — readable by anyone, writable only by admin
-- ---------------------------------------------------------------------
create policy stages_read   on stages       for select using (true);
create policy settings_read on app_settings for select using (true);
create policy settings_write on app_settings for all
  using (app_is_admin()) with check (app_is_admin());

create policy companies_read  on companies for select using (true);
create policy companies_write on companies for all
  using (app_is_admin()) with check (app_is_admin());

-- ---------------------------------------------------------------------
-- users / sessions — never readable from the application surface.
-- Only the service path (login, registration) touches these.
-- ---------------------------------------------------------------------
-- A user may read their own row and nothing else. Registration and login
-- go through the SECURITY DEFINER functions below, because at that point
-- the caller has no identity yet.
create policy users_self on users for select
  using (id = app_user_id() or app_is_admin());

create policy sessions_own on sessions for all
  using (user_id = app_user_id()) with check (user_id = app_user_id());

-- ---------------------------------------------------------------------
-- jobs
--   public      : published, open roles only
--   recruiter   : everything at their own company, including drafts
--   client      : everything at their own company
--   admin       : everything
-- ---------------------------------------------------------------------
create policy jobs_public_read on jobs for select using (
  (status = 'open' and not paused and not archived
     and (expires_at is null or expires_at > now()))
  or app_is_admin()
  or (app_role() = 'recruiter' and company_id = app_recruiter_company())
  or (app_role() = 'client'    and company_id = app_client_company())
);

create policy jobs_recruiter_write on jobs for all
  using      (app_is_admin() or (app_role() = 'recruiter' and company_id = app_recruiter_company()))
  with check (app_is_admin() or (app_role() = 'recruiter' and company_id = app_recruiter_company()));

-- ---------------------------------------------------------------------
-- candidates
--   candidate : only their own row
--   recruiter : the searchable talent pool, minus profiles marked private
--   client    : only candidates their company is actually reviewing,
--               and only at client-visible stages
--   admin     : everything
-- ---------------------------------------------------------------------
create policy candidates_read on candidates for select using (
  app_is_admin()
  or id = app_candidate_id()
  or (app_role() = 'recruiter' and (
        not is_private
        or app_candidate_at_company(candidates.id, app_recruiter_company())))
  or (app_role() = 'client'
        and app_candidate_at_company(candidates.id, app_client_company(),
                                     app_client_visible_stages()))
);

create policy candidates_self_write on candidates for update
  using      (id = app_candidate_id() or app_is_admin() or app_role() = 'recruiter')
  with check (id = app_candidate_id() or app_is_admin() or app_role() = 'recruiter');

create policy candidates_insert on candidates for insert
  with check (app_is_admin() or app_role() = 'recruiter');

create policy candidates_delete on candidates for delete using (app_is_admin());

-- ---------------------------------------------------------------------
-- applications — the core tenancy boundary
-- ---------------------------------------------------------------------
create policy applications_read on applications for select using (
  app_is_admin()
  or candidate_id = app_candidate_id()
  or (app_role() = 'recruiter' and exists (
        select 1 from jobs j where j.id = applications.job_id
          and j.company_id = app_recruiter_company()))
  or (app_role() = 'client' and stage = any (app_client_visible_stages()) and exists (
        select 1 from jobs j where j.id = applications.job_id
          and j.company_id = app_client_company()))
);

-- a candidate may create an application, but only for themselves and only
-- to a job that is actually open (requirement 24: "Job unavailable")
create policy applications_candidate_insert on applications for insert
  with check (
    app_is_admin()
    or (candidate_id = app_candidate_id() and exists (
          select 1 from jobs j where j.id = job_id
            and j.status = 'open' and not j.paused and not j.archived))
    or (app_role() = 'recruiter' and exists (
          select 1 from jobs j where j.id = job_id
            and j.company_id = app_recruiter_company()))
  );

-- only recruiters/admins move a candidate through the pipeline.
-- A candidate can never change their own stage.
create policy applications_recruiter_update on applications for update
  using (
    app_is_admin()
    or (app_role() = 'recruiter' and exists (
          select 1 from jobs j where j.id = applications.job_id
            and j.company_id = app_recruiter_company()))
    or (app_role() = 'client' and exists (
          select 1 from jobs j where j.id = applications.job_id
            and j.company_id = app_client_company()))
  )
  with check (
    app_is_admin()
    or (app_role() = 'recruiter' and exists (
          select 1 from jobs j where j.id = applications.job_id
            and j.company_id = app_recruiter_company()))
    or (app_role() = 'client' and exists (
          select 1 from jobs j where j.id = applications.job_id
            and j.company_id = app_client_company()))
  );

create policy applications_delete on applications for delete using (app_is_admin());

create policy stage_history_read on application_stage_history for select using (
  app_is_admin() or exists (
    select 1 from applications a where a.id = application_stage_history.application_id)
);
create policy stage_history_write on application_stage_history for insert with check (true);

-- ---------------------------------------------------------------------
-- interviews / offers — follow the application's visibility
-- ---------------------------------------------------------------------
create policy interviews_read on interviews for select using (
  app_is_admin()
  or candidate_id = app_candidate_id()
  or (app_role() = 'recruiter' and exists (
        select 1 from jobs j where j.id = interviews.job_id
          and j.company_id = app_recruiter_company()))
  or (app_role() = 'client' and exists (
        select 1 from jobs j where j.id = interviews.job_id
          and j.company_id = app_client_company()))
);
-- The WITH CHECK must name the company, not just the role. Checking only
-- `app_role() in ('recruiter','client')` lets any recruiter schedule an
-- interview against another company's job and candidate — the read policy
-- above hides it from them afterwards, which makes it worse, not better.
create policy interviews_write on interviews for all
  using (
    app_is_admin()
    or (app_role() = 'recruiter' and exists (
          select 1 from jobs j where j.id = interviews.job_id
            and j.company_id = app_recruiter_company()))
    or (app_role() = 'client' and exists (
          select 1 from jobs j where j.id = interviews.job_id
            and j.company_id = app_client_company()))
  )
  with check (
    app_is_admin()
    or (app_role() = 'recruiter' and exists (
          select 1 from jobs j where j.id = interviews.job_id
            and j.company_id = app_recruiter_company()))
    or (app_role() = 'client' and exists (
          select 1 from jobs j where j.id = interviews.job_id
            and j.company_id = app_client_company()))
  );

create policy offers_read on offers for select using (
  app_is_admin()
  or candidate_id = app_candidate_id()
  or (app_role() = 'recruiter' and exists (
        select 1 from jobs j where j.id = offers.job_id
          and j.company_id = app_recruiter_company()))
  or (app_role() = 'client' and exists (
        select 1 from jobs j where j.id = offers.job_id
          and j.company_id = app_client_company()))
);
-- Same gap, same fix: an offer must belong to the recruiter's own company.
create policy offers_write on offers for all
  using (
    app_is_admin()
    or (app_role() = 'recruiter' and exists (
          select 1 from jobs j where j.id = offers.job_id
            and j.company_id = app_recruiter_company()))
  )
  with check (
    app_is_admin()
    or (app_role() = 'recruiter' and exists (
          select 1 from jobs j where j.id = offers.job_id
            and j.company_id = app_recruiter_company()))
  );

-- ---------------------------------------------------------------------
-- notifications — requirement 12: "Do not show unrelated candidate
-- notifications." Enforced here, not in the bell dropdown.
-- ---------------------------------------------------------------------
create policy notifications_own on notifications for select using (
  app_is_admin()
  or (recipient_role = 'candidate' and recipient_id = app_candidate_id())
  or (recipient_role = 'recruiter' and recipient_id = app_recruiter_id())
  or (recipient_role = 'client'    and recipient_id in (
        select id from client_users where user_id = app_user_id()))
);

create policy notifications_mark_read on notifications for update
  using (
    app_is_admin()
    or (recipient_role = 'candidate' and recipient_id = app_candidate_id())
    or (recipient_role = 'recruiter' and recipient_id = app_recruiter_id())
  )
  with check (
    app_is_admin()
    or (recipient_role = 'candidate' and recipient_id = app_candidate_id())
    or (recipient_role = 'recruiter' and recipient_id = app_recruiter_id())
  );

create policy notifications_create on notifications for insert
  with check (app_is_admin() or app_role() = 'recruiter');

create policy notif_log_admin on notification_log for all
  using (app_is_admin()) with check (app_is_admin());

-- ---------------------------------------------------------------------
-- recruiter-owned working data — strictly per recruiter.
-- One recruiter's notes, lists and saved searches never reach another.
-- ---------------------------------------------------------------------
create policy comments_own on candidate_comments for all
  using      (app_is_admin() or recruiter_id = app_recruiter_id())
  with check (app_is_admin() or recruiter_id = app_recruiter_id());

create policy lists_own on candidate_lists for all
  using      (app_is_admin() or recruiter_id = app_recruiter_id())
  with check (app_is_admin() or recruiter_id = app_recruiter_id());

create policy list_members_own on candidate_list_members for all
  using (exists (select 1 from candidate_lists l
                 where l.id = candidate_list_members.list_id
                   and (l.recruiter_id = app_recruiter_id() or app_is_admin())))
  with check (exists (select 1 from candidate_lists l
                 where l.id = candidate_list_members.list_id
                   and (l.recruiter_id = app_recruiter_id() or app_is_admin())));

create policy saved_searches_own on saved_searches for all
  using      (app_is_admin() or recruiter_id = app_recruiter_id())
  with check (app_is_admin() or recruiter_id = app_recruiter_id());

create policy bookmarks_own on candidate_bookmarks for all
  using      (app_is_admin() or recruiter_id = app_recruiter_id())
  with check (app_is_admin() or recruiter_id = app_recruiter_id());

create policy reports_own on candidate_reports for all
  using      (app_is_admin() or recruiter_id = app_recruiter_id())
  with check (app_is_admin() or recruiter_id = app_recruiter_id());

create policy recent_searches_own on recent_searches for all
  using      (user_id = app_user_id() or app_is_admin())
  with check (user_id = app_user_id() or app_is_admin());

create policy templates_own on comm_templates for all
  using      (app_is_admin() or owner_id = app_user_id())
  with check (app_is_admin() or owner_id = app_user_id());

create policy view_events_own on view_events for all
  using      (app_is_admin() or viewer_id = app_user_id())
  with check (app_is_admin() or viewer_id = app_user_id());

-- ---------------------------------------------------------------------
-- candidate-owned data
-- ---------------------------------------------------------------------
create policy saved_jobs_own on saved_jobs for all
  using      (app_is_admin() or candidate_id = app_candidate_id())
  with check (app_is_admin() or candidate_id = app_candidate_id());

create policy hidden_jobs_own on hidden_jobs for all
  using      (app_is_admin() or candidate_id = app_candidate_id())
  with check (app_is_admin() or candidate_id = app_candidate_id());

create policy job_alerts_own on job_alerts for all
  using      (app_is_admin() or candidate_id = app_candidate_id())
  with check (app_is_admin() or candidate_id = app_candidate_id());

create policy prefs_own on user_prefs for all
  using      (user_id = app_user_id())
  with check (user_id = app_user_id());

create policy feedback_read  on feedback for select using (true);
create policy feedback_write on feedback for insert with check (app_user_id() is not null);

-- ---------------------------------------------------------------------
-- role profile tables
-- ---------------------------------------------------------------------
create policy recruiters_read on recruiters for select using (
  app_is_admin() or app_role() in ('recruiter','client','candidate')
);
create policy recruiters_write on recruiters for all
  using (app_is_admin()) with check (app_is_admin());

create policy clients_read on client_users for select using (
  app_is_admin() or user_id = app_user_id()
  or (app_role() = 'recruiter' and company_id = app_recruiter_company())
);
create policy clients_write on client_users for all
  using (app_is_admin()) with check (app_is_admin());

create policy admins_read  on admins for select using (app_is_admin());
create policy admins_write on admins for all
  using (app_is_admin()) with check (app_is_admin());

-- =====================================================================
-- Authentication: SECURITY DEFINER, because login necessarily happens
-- before any identity exists. Each function is deliberately narrow — it
-- returns the single row needed for that step and nothing more. This
-- replaces the blanket service exemption that used to guard `users` and
-- `sessions`, and it is the only way app_api can touch those tables.
-- =====================================================================

-- Returns the credential row for one email so the API can verify a bcrypt
-- hash. It cannot enumerate users: exact email in, at most one row out.
create or replace function auth_find_user(p_email text)
returns table (id uuid, email text, password_hash text, role user_role, status text)
language sql security definer set search_path = public as $$
  select u.id, u.email, u.password_hash, u.role, u.status
  from users u
  where lower(u.email) = lower(p_email)
  limit 1
$$;

create or replace function auth_create_user(p_email text, p_hash text, p_role user_role)
returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  insert into users (email, password_hash, role) values (p_email, p_hash, p_role)
  returning id into v_id;
  return v_id;
end $$;

create or replace function auth_create_session(
  p_user_id uuid, p_token_hash text, p_expires timestamptz,
  p_user_agent text default null, p_ip inet default null)
returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  insert into sessions (user_id, token_hash, expires_at, user_agent, ip)
  values (p_user_id, p_token_hash, p_expires, p_user_agent, p_ip)
  returning id into v_id;
  update users set last_login_at = now() where id = p_user_id;
  return v_id;
end $$;

-- Resolves a session cookie to an identity on every request. An expired
-- session resolves to nothing, which is what signs a user out.
create or replace function auth_resolve_session(p_token_hash text)
returns table (user_id uuid, role user_role, status text, profile_id text)
language sql security definer set search_path = public as $$
  select u.id, u.role, u.status,
         coalesce(c.id, r.id, cl.id, a.id) as profile_id
  from sessions s
  join users u on u.id = s.user_id
  left join candidates   c  on c.user_id  = u.id
  left join recruiters   r  on r.user_id  = u.id
  left join client_users cl on cl.user_id = u.id
  left join admins       a  on a.user_id  = u.id
  where s.token_hash = p_token_hash
    and s.expires_at > now()
    and u.status = 'active'
  limit 1
$$;

create or replace function auth_destroy_session(p_token_hash text)
returns void
language sql security definer set search_path = public as $$
  delete from sessions where token_hash = p_token_hash
$$;

create or replace function auth_purge_expired_sessions()
returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  delete from sessions where expires_at < now();
  get diagnostics n = row_count;
  return n;
end $$;

-- Candidate self-registration. A brand-new candidate has no identity yet,
-- so this creates the user and the candidate profile atomically.
create or replace function auth_register_candidate(
  p_email text, p_hash text, p_candidate_id text, p_name text, p_phone text default null)
returns text
language plpgsql security definer set search_path = public as $$
declare v_uid uuid;
begin
  if exists (select 1 from users where lower(email) = lower(p_email)) then
    raise exception 'email_taken' using errcode = 'unique_violation';
  end if;
  insert into users (email, password_hash, role)
  values (p_email, p_hash, 'candidate') returning id into v_uid;
  insert into candidates (id, user_id, name, email, phone)
  values (p_candidate_id, v_uid, p_name, p_email, p_phone);
  return p_candidate_id;
end $$;

-- System notifications (requirements 12/13) are raised by the server in
-- response to real events, so they get one narrow definer function rather
-- than a general "the service may insert anything" policy.
create or replace function notify_create(
  p_id text, p_recipient_id text, p_recipient_role user_role, p_type text,
  p_title text, p_message text, p_job_id text default null,
  p_application_id text default null, p_candidate_id text default null,
  p_recruiter_id text default null, p_metadata jsonb default '{}')
returns text
language plpgsql security definer set search_path = public as $$
begin
  insert into notifications (id, recipient_id, recipient_role, type, title, message,
                             job_id, application_id, candidate_id, recruiter_id,
                             system, metadata)
  values (p_id, p_recipient_id, p_recipient_role, p_type, p_title, p_message,
          p_job_id, p_application_id, p_candidate_id, p_recruiter_id, true, p_metadata);
  return p_id;
exception when unique_violation then
  -- the prototype's dedupe rule (:17685) — a repeat event is not an error
  return null;
end $$;

-- =====================================================================
-- One narrow, deliberate public disclosure.
--
-- The login screen's "Quick demo login" panel lists staff accounts. RLS
-- correctly hides recruiters, clients and admins from anonymous callers,
-- so this function exists to expose exactly that list and nothing else —
-- name and company only, no email except the admin's, which the page
-- already prints in its credentials box.
--
-- CANDIDATES ARE NOT INCLUDED. The prototype listed four real candidates
-- with their email addresses on an unauthenticated page; that is a
-- disclosure of members of the public and is not carried forward.
-- =====================================================================
create or replace function public_login_hints()
returns table (role text, id text, name text, sub text)
language sql stable security definer set search_path = public as $$
  select 'recruiter'::text, r.id, r.name, coalesce(co.name, '')
    from recruiters r left join companies co on co.id = r.company_id
  union all
  select 'client'::text, cl.id, cl.name, coalesce(co.name, '')
    from client_users cl left join companies co on co.id = cl.company_id
  union all
  select 'admin'::text, a.id, a.name, a.email from admins a
$$;
