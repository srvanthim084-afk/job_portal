-- ---------------------------------------------------------------------
-- 0125 — who created a job and when it went live / came down, the
--        recruiter-only Audit Log with time in portal, and the public
--        count of registered candidates
--
-- 1. JOBS. Four columns, all stamped by the database so every way a job
--    is written (the post form, bulk, walk-in, internship, import, the
--    publish button, a sweep) gets them without knowing they exist:
--
--      created_by      the user who created it (never changes)
--      unpublished_at  when it last stopped being live (closed, taken
--                      back to draft, paused or archived); cleared when
--                      it goes live again
--      last_edited_at  the last change a PERSON made, and who:
--      last_edited_by  background sweeps do not count as an edit
--
--    A job that goes live without a published_at (a draft saved as open
--    through the edit form) now gets one, so "Published On" is never
--    blank for a live job. The first publication is kept on republish,
--    as the publish route always did.
--
--    The same triggers write job.created / job.published /
--    job.unpublished / job.closed / job.draft_saved / job.updated to
--    audit_log, with the acting user, so the Audit Log can show what a
--    recruiter did after signing in.
--
-- 2. RECRUITER SESSIONS. portal_sessions is one row per recruiter sign-in:
--    login, last activity, logout and how it ended. sessions gains
--    last_seen_at and the portal session it belongs to. The rules:
--
--      * sign in            -> a portal session and an 'auth.login' row
--                              (the action code is the caller's, from
--                              api/src/audit/recruiter-activity.js, so
--                              another sign-in method adds a code there)
--      * sign out           -> 'auth.logout', logout = now
--      * 30 minutes idle    -> 'auth.auto_logout', logout = the LAST
--                              ACTIVITY, and the session token is deleted
--
--    The idle rule is applied in two places, both here in the database:
--    portal_session_touch() on every request a recruiter makes, and
--    portal_session_sweep() on a timer for browsers that were simply
--    closed. The idle length is a parameter so the API owns it.
--
--    Only recruiter sessions are tracked, and never an administrator's
--    "Login as" session (sessions.impersonated_by).
--
-- 3. public_candidate_stats(): three numbers - registered candidates,
--    new this week, active jobs. No row, no name, nothing else.
--
-- Nothing is deleted. The jobs views are recreated only because a view's
-- "j.*" is fixed when it is created; their definitions are unchanged.
-- ---------------------------------------------------------------------

/* ===================================================================== *
 * 1. jobs: creator and lifecycle stamps
 * ===================================================================== */
alter table jobs add column if not exists created_by     uuid;
alter table jobs add column if not exists unpublished_at timestamptz;
alter table jobs add column if not exists last_edited_at timestamptz;
alter table jobs add column if not exists last_edited_by uuid;

comment on column jobs.created_by     is 'users.id of whoever created the job (0125). Set by the database on insert, never changed.';
comment on column jobs.unpublished_at is 'When the job last stopped being live - closed, unpublished to draft, paused or archived (0125). Null while live or never published.';
comment on column jobs.last_edited_at is 'The last change a signed-in person made to the job (0125). Background work does not count.';
comment on column jobs.last_edited_by is 'users.id of whoever made that change (0125).';

/* The jobs that predate this: the creator is the recruiter who owns the
   job (the only creator the old schema recorded), and a job that is down
   but was once published came down at its last update at the latest. */
update jobs j set created_by = r.user_id
  from recruiters r
 where j.created_by is null and r.id = j.recruiter_id and r.user_id is not null;
update jobs set unpublished_at = updated_at
 where unpublished_at is null and published_at is not null
   and (status <> 'open' or paused or archived);

create index if not exists jobs_created_by_idx on jobs (created_by);

/* Live in the sense of "a person made it so": status open, not paused,
   not archived. Expiry is a matter of time, not of a write. */
create or replace function job_row_live(p_status text, p_paused boolean, p_archived boolean)
returns boolean language sql immutable as $$
  select coalesce(p_status = 'open' and not coalesce(p_paused, false) and not coalesce(p_archived, false), false)
$$;

create or replace function jobs_lifecycle_stamp() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := app_user_id_safe();
  v_ignore text[] := array['updated_at','urgent_alerted_at','deadline_reminded_for','last_edited_at',
                           'last_edited_by','unpublished_at','published_at','created_by'];
begin
  if tg_op = 'INSERT' then
    if new.created_by is null then
      new.created_by := coalesce(v_user,
        (select r.user_id from recruiters r where r.id = new.recruiter_id));
    end if;
    if job_row_live(new.status, new.paused, new.archived) and new.published_at is null then
      new.published_at := now();
    end if;
    if v_user is not null then
      new.last_edited_at := coalesce(new.last_edited_at, now());
      new.last_edited_by := coalesce(new.last_edited_by, v_user);
    end if;
    return new;
  end if;

  new.created_by := coalesce(old.created_by, new.created_by,
    (select r.user_id from recruiters r where r.id = new.recruiter_id));
  if job_row_live(new.status, new.paused, new.archived) then
    new.unpublished_at := null;
    if new.published_at is null then new.published_at := now(); end if;
  elsif job_row_live(old.status, old.paused, old.archived) then
    new.unpublished_at := now();
  end if;
  if v_user is not null
     and array_length(audit_changed_keys(to_jsonb(old), to_jsonb(new), v_ignore), 1) > 0 then
    new.last_edited_at := now();
    new.last_edited_by := v_user;
  end if;
  return new;
end $$;

drop trigger if exists ab_jobs_lifecycle_stamp on jobs;
create trigger ab_jobs_lifecycle_stamp before insert or update on jobs
  for each row execute function jobs_lifecycle_stamp();

/* What happened to a job, in the audit log. One row per thing a person
   would name: created, published, unpublished, closed, draft saved, edited. */
create or replace function jobs_lifecycle_audit() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_was boolean; v_is boolean;
  v_detail jsonb := jsonb_build_object('title', new.title, 'status', new.status);
begin
  v_is := job_row_live(new.status, new.paused, new.archived);
  if tg_op = 'INSERT' then
    perform audit_write('job.created', 'job', new.id, v_detail);
    if v_is then perform audit_write('job.published', 'job', new.id, v_detail);
    elsif new.status = 'draft' then perform audit_write('job.draft_saved', 'job', new.id, v_detail);
    end if;
    return null;
  end if;

  v_was := job_row_live(old.status, old.paused, old.archived);
  if v_is and not v_was then
    perform audit_write('job.published', 'job', new.id, v_detail);
  elsif v_was and not v_is then
    perform audit_write(case when new.status = 'closed' then 'job.closed' else 'job.unpublished' end,
      'job', new.id, v_detail || jsonb_build_object('paused', new.paused, 'archived', new.archived));
  elsif new.last_edited_at is distinct from old.last_edited_at then
    perform audit_write(case when new.status = 'draft' then 'job.draft_saved' else 'job.updated' end,
      'job', new.id, v_detail);
  end if;
  return null;
end $$;

drop trigger if exists jobs_lifecycle_audit on jobs;
create trigger jobs_lifecycle_audit after insert or update on jobs
  for each row execute function jobs_lifecycle_audit();

/* A staff member's display name from their user id, for "Created By" and
   "Last updated by". Staff readers only; anybody else gets null. */
create or replace function staff_name_of(p_user uuid)
returns text language sql stable security definer set search_path = public as $$
  select case when app_role() in ('recruiter','admin','bde','client') then
    coalesce((select name from recruiters   where user_id = p_user limit 1),
             (select name from admins       where user_id = p_user limit 1),
             (select name from bde_users    where user_id = p_user limit 1),
             (select name from client_users where user_id = p_user limit 1))
  end
$$;

/* The two views, unchanged, so "j.*" carries the new columns. */
drop view if exists jobs_open;
drop view if exists jobs_with_counts;

create view jobs_with_counts with (security_invoker = true) as
select j.*,
       (select count(*) from applications a where a.job_id = j.id)::int as applicants,
       case when j.published_at is null then null
            else greatest(0, (extract(epoch from (now() - j.published_at)) / 86400)::int)
       end as posted_days_ago,
       case when j.posting_kind = 'walkin' and j.walkin_capacity is not null
            then walkin_registered_count(j.id) end as walkin_registered
  from jobs j;

create view jobs_open with (security_invoker = true) as
select * from jobs_with_counts
where status not in ('closed','draft')
  and not paused
  and not archived
  and (expires_at is null or expires_at > now())
  and not (posting_kind = 'walkin'
           and coalesce(walkin_ends_at(walkin_date, walkin_to) <= now(), false))
  /* 0113: the Jobs page is TeamLink's own jobs, at the source. */
  and source_type = 'TEAMLINK';

comment on view jobs_open is
  'What the Jobs page may list: Active TeamLink jobs only (0113), no walk-in whose date and end time have passed (0106).';

/* ===================================================================== *
 * 2. recruiter portal sessions
 * ===================================================================== */
create table if not exists portal_sessions (
  id               bigserial primary key,
  user_id          uuid not null references users(id) on delete cascade,
  role             text not null,
  login_method     text not null default 'password',
  login_at         timestamptz not null default now(),
  last_activity_at timestamptz not null default now(),
  logout_at        timestamptz,
  end_reason       text check (end_reason in ('logout', 'auto_timeout')),
  ip               inet,
  user_agent       text
);
create index if not exists portal_sessions_user_idx on portal_sessions (user_id, login_at desc);
create index if not exists portal_sessions_open_idx on portal_sessions (last_activity_at) where logout_at is null;

comment on table portal_sessions is
  'One row per recruiter sign-in (0125): login, last activity, logout and how it ended. Written only by the portal_session_* functions.';

alter table portal_sessions enable row level security;
drop policy if exists portal_sessions_admin on portal_sessions;
create policy portal_sessions_admin on portal_sessions for select using (app_is_admin());

alter table sessions add column if not exists last_seen_at timestamptz;
alter table sessions add column if not exists portal_session_id bigint;

/* Closes one portal session and writes its audit row. The audit row is
   dated at the logout time, which for an idle session is its last
   activity - not the moment somebody noticed. */
create or replace function portal_session_close(p_id bigint, p_reason text, p_at timestamptz)
returns void language plpgsql security definer set search_path = public as $$
declare v portal_sessions;
begin
  update portal_sessions set logout_at = greatest(p_at, login_at), end_reason = p_reason
   where id = p_id and logout_at is null
  returning * into v;
  if v.id is null then return; end if;
  insert into audit_log (actor_user_id, actor_role, action, entity, entity_id, detail, created_at)
  values (v.user_id, v.role,
          case when p_reason = 'auto_timeout' then 'auth.auto_logout' else 'auth.logout' end,
          'session', v.id::text,
          jsonb_build_object('durationSeconds', greatest(0, extract(epoch from (v.logout_at - v.login_at)))::int,
                             'method', v.login_method,
                             'lastActivityAt', v.last_activity_at),
          v.logout_at);
end $$;

/* Opens the portal session for a session token. p_action is the stable
   action code of the sign-in ('auth.login', and later 'auth.login_hrms'
   and the like). Returns null for anybody who is not tracked. */
create or replace function portal_session_start(p_token_hash text, p_method text, p_action text)
returns bigint language plpgsql security definer set search_path = public as $$
declare v_s sessions; v_role text; v_id bigint;
begin
  if p_action !~ '^auth\.[a-z0-9_]{2,40}$' or p_method !~ '^[a-z0-9_]{2,40}$' then
    raise exception 'bad sign-in action' using errcode = '22023';
  end if;
  select * into v_s from sessions where token_hash = p_token_hash;
  if v_s.id is null or v_s.impersonated_by is not null then return null; end if;
  select role::text into v_role from users where id = v_s.user_id;
  if v_role is distinct from 'recruiter' then return null; end if;
  if v_s.portal_session_id is not null then return v_s.portal_session_id; end if;

  insert into portal_sessions (user_id, role, login_method, ip, user_agent)
  values (v_s.user_id, v_role, p_method, v_s.ip, left(v_s.user_agent, 400))
  returning id into v_id;
  update sessions set portal_session_id = v_id, last_seen_at = now() where id = v_s.id;
  insert into audit_log (actor_user_id, actor_role, action, entity, entity_id, detail)
  values (v_s.user_id, v_role, p_action, 'session', v_id::text, jsonb_build_object('method', p_method));
  return v_id;
end $$;

/* Every request a signed-in recruiter makes. 'timed_out' means the
   session had been idle longer than p_idle_minutes: it is closed at its
   last activity and the token is deleted, so this request is answered as
   signed out. Activity is written at most every 30 seconds. */
create or replace function portal_session_touch(p_token_hash text, p_idle_minutes int)
returns text language plpgsql security definer set search_path = public as $$
declare v_s sessions; v_role text; v_ps bigint; v_last timestamptz;
begin
  select * into v_s from sessions where token_hash = p_token_hash;
  if v_s.id is null then return 'none'; end if;
  if v_s.impersonated_by is not null then return 'untracked'; end if;
  select role::text into v_role from users where id = v_s.user_id;
  if v_role is distinct from 'recruiter' then return 'untracked'; end if;

  v_ps := v_s.portal_session_id;
  v_last := coalesce(v_s.last_seen_at,
                     (select last_activity_at from portal_sessions where id = v_ps));
  if v_last is not null and v_last < now() - make_interval(mins => greatest(1, p_idle_minutes)) then
    if v_ps is not null then perform portal_session_close(v_ps, 'auto_timeout', v_last); end if;
    delete from sessions where id = v_s.id;
    return 'timed_out';
  end if;

  /* A session that was open before 0125 (or opened by a way in that did
     not start one) is picked up here, once. */
  if v_ps is null then
    v_ps := portal_session_start(p_token_hash, 'session', 'auth.session_resumed');
    return 'ok';
  end if;

  if v_s.last_seen_at is null or v_s.last_seen_at < now() - interval '30 seconds' then
    update sessions set last_seen_at = now() where id = v_s.id;
    update portal_sessions set last_activity_at = now() where id = v_ps and logout_at is null;
  end if;
  return 'ok';
end $$;

/* Sign-out. Called before the session row is destroyed. */
create or replace function portal_session_end(p_token_hash text)
returns void language plpgsql security definer set search_path = public as $$
declare v_ps bigint;
begin
  select portal_session_id into v_ps from sessions where token_hash = p_token_hash;
  if v_ps is not null then perform portal_session_close(v_ps, 'logout', now()); end if;
end $$;

/* The browser was closed: every open portal session idle for longer than
   p_idle_minutes is closed at its last activity and its token deleted.
   Returns how many were closed. */
create or replace function portal_session_sweep(p_idle_minutes int)
returns integer language plpgsql security definer set search_path = public as $$
declare r record; n integer := 0;
begin
  for r in
    select id, last_activity_at from portal_sessions
     where logout_at is null
       and last_activity_at < now() - make_interval(mins => greatest(1, p_idle_minutes))
     order by id
     for update skip locked
  loop
    perform portal_session_close(r.id, 'auto_timeout', r.last_activity_at);
    delete from sessions where portal_session_id = r.id;
    n := n + 1;
  end loop;
  return n;
end $$;

/* ===================================================================== *
 * 3. public numbers for the candidate portal
 * ===================================================================== */
create or replace function public_candidate_stats()
returns table (registered_candidates bigint, new_this_week bigint, active_jobs bigint)
language sql stable security definer set search_path = public as $$
  select
    (select count(*) from candidates c join users u on u.id = c.user_id
      where u.role = 'candidate' and u.status = 'active'),
    (select count(*) from candidates c join users u on u.id = c.user_id
      where u.role = 'candidate' and u.status = 'active'
        and c.created_at >= (date_trunc('week', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata')),
    (select count(*) from jobs_open)
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant select on jobs_with_counts, jobs_open to app_api;
    grant select on portal_sessions to app_api;
    grant execute on function staff_name_of(uuid) to app_api;
    grant execute on function portal_session_start(text, text, text) to app_api;
    grant execute on function portal_session_touch(text, int) to app_api;
    grant execute on function portal_session_end(text) to app_api;
    grant execute on function portal_session_sweep(int) to app_api;
    grant execute on function public_candidate_stats() to app_api;
  end if;
end $$;
revoke execute on function portal_session_close(bigint, text, timestamptz) from public;
