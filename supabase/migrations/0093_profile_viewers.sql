-- ---------------------------------------------------------------------
-- 0093 — "Who viewed my profile"
--
-- view_events (0001) records who opened what, but its policy lets only
-- the VIEWER read a row, so a candidate could never learn that anybody
-- had looked. The Profile Performance page filled the gap with a single
-- "Profile viewed" line read out of the browser. This replaces both with
-- rows the server writes and the candidate can read - safely:
--
--   candidate_profile_views         one row per viewer, per day, per role
--                                   (job): the same recruiter opening the
--                                   profile five times today is ONE view
--                                   with view_count 5
--   candidate_search_appearances    how many recruiter searches returned
--                                   the candidate on the page they looked
--                                   at, per day, with one sample query
--                                   (role + city only)
--   candidate_profile_view_digests  the 7 PM IST digest, one row per
--                                   candidate per day - the claim that
--                                   makes "never twice" true
--   candidate_profile_view_prefs    the candidate's own opt-in for the
--                                   digest by email / WhatsApp (in-app is
--                                   always on)
--
-- WHAT A CANDIDATE MAY SEE. Never a viewer's id, email, phone, company or
-- client name. A TeamLink recruiter is "Priya (TeamLink Recruiter)" - or
-- "A TeamLink recruiter" when the administrator turns names off - and a
-- client is ALWAYS "A hiring team" (0051: the candidate never sees the
-- word "Client" or who the client is). The role is the job title, and only
-- when that job is one the candidate can see anyway.
--
-- Nobody writes these tables directly. Every write goes through a
-- definer function below that takes the viewer from the SESSION, never
-- from anything the browser said.
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- an administrator's "Login as" session must not count as a view
-- ---------------------------------------------------------------------
alter table sessions add column if not exists impersonated_by uuid;

comment on column sessions.impersonated_by is
  'Set when an administrator opened this session with Login As (0093). Views recorded from such a session are not counted.';

create or replace function session_mark_impersonated(p_token_hash text)
returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not (app_role() = 'admin' and app_user_id() is not null) then
    raise exception 'only a signed-in administrator can mark a session' using errcode = '42501';
  end if;
  update sessions set impersonated_by = app_user_id()
   where token_hash = p_token_hash and impersonated_by is null;
  return found;
end $$;

-- ---------------------------------------------------------------------
-- tables
-- ---------------------------------------------------------------------
create table if not exists candidate_profile_views (
  id               bigserial primary key,
  candidate_id     text not null references candidates(id) on delete cascade,
  -- No foreign keys on the viewer or the job: deleting a recruiter or a
  -- job must neither erase the candidate's history nor make two rows
  -- collide on the one-a-day key below.
  viewer_user_id   uuid not null,
  viewer_role      text not null check (viewer_role in ('recruiter','bde','client','admin')),
  -- A snapshot of the first name for staff viewers, for display only.
  -- Never filled for a client viewer: a hiring team is never named.
  viewer_first_name text,
  job_id           text,
  source           text not null default 'profile'
                   check (source in ('profile','resume','search_card','application')),
  viewed_on        date not null,                 -- the day in India
  first_viewed_at  timestamptz not null default now(),
  last_viewed_at   timestamptz not null default now(),
  view_count       int not null default 1 check (view_count >= 1)
);

create unique index if not exists candidate_profile_views_one_a_day
  on candidate_profile_views (candidate_id, viewer_user_id, coalesce(job_id, ''), viewed_on);
create index if not exists candidate_profile_views_recent
  on candidate_profile_views (candidate_id, last_viewed_at desc);
create index if not exists candidate_profile_views_day
  on candidate_profile_views (viewed_on);

create table if not exists candidate_search_appearances (
  candidate_id  text not null references candidates(id) on delete cascade,
  day           date not null,
  count         int  not null default 0 check (count >= 0),
  -- {"role": "...", "city": "..."} - the last search of the day, never
  -- who ran it and never a company.
  sample_query  jsonb not null default '{}'::jsonb,
  updated_at    timestamptz not null default now(),
  primary key (candidate_id, day)
);

create table if not exists candidate_profile_view_digests (
  candidate_id    text not null references candidates(id) on delete cascade,
  day             date not null,
  viewers         int  not null default 0,
  in_app          text,
  email_status    text,
  whatsapp_status text,
  created_at      timestamptz not null default now(),
  primary key (candidate_id, day)
);

create table if not exists candidate_profile_view_prefs (
  candidate_id    text primary key references candidates(id) on delete cascade,
  digest_email    boolean not null default false,
  digest_whatsapp boolean not null default false,
  updated_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- row level security
--
-- Staff may read the raw view rows for analytics, under the candidate
-- rules they already have (the EXISTS is itself filtered by the policy on
-- candidates). Candidates have NO policy on the raw tables: they read
-- through candidate_profile_viewers_v and the summary function, which
-- never return an id, an email or a company.
-- ---------------------------------------------------------------------
alter table candidate_profile_views        enable row level security;
alter table candidate_search_appearances   enable row level security;
alter table candidate_profile_view_digests enable row level security;
alter table candidate_profile_view_prefs   enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'candidate_profile_views'
                  and policyname = 'profile_views_staff_read') then
    create policy profile_views_staff_read on candidate_profile_views for select
      using (app_role() in ('recruiter','bde','admin')
             and exists (select 1 from candidates c where c.id = candidate_id));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'candidate_search_appearances'
                  and policyname = 'search_appearances_staff_read') then
    create policy search_appearances_staff_read on candidate_search_appearances for select
      using (app_role() in ('recruiter','bde','admin')
             and exists (select 1 from candidates c where c.id = candidate_id));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'candidate_profile_view_digests'
                  and policyname = 'profile_view_digests_own') then
    create policy profile_view_digests_own on candidate_profile_view_digests for select
      using (candidate_id = app_candidate_id());
  end if;
  if not exists (select 1 from pg_policies where tablename = 'candidate_profile_view_prefs'
                  and policyname = 'profile_view_prefs_own') then
    create policy profile_view_prefs_own on candidate_profile_view_prefs for all
      using (candidate_id = app_candidate_id())
      with check (candidate_id = app_candidate_id());
  end if;
end $$;

-- ---------------------------------------------------------------------
-- settings: names on or off, digest on or off
-- ---------------------------------------------------------------------
insert into app_settings (key, value) values
  ('profile_viewers', '{"showRecruiterNames": true, "dailyDigest": true}'::jsonb)
on conflict (key) do nothing;

create or replace function profile_viewers_setting(p_key text, p_default boolean)
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select (value ->> p_key)::boolean from app_settings where key = 'profile_viewers'),
                  p_default)
$$;

-- ---------------------------------------------------------------------
-- display rules, in ONE place
-- ---------------------------------------------------------------------
create or replace function profile_viewer_display_name(p_role text, p_first text)
returns text
language sql stable security definer set search_path = public as $$
  select case
    when p_role = 'client' then 'A hiring team'
    when p_role in ('recruiter','bde')
         and profile_viewers_setting('showRecruiterNames', true)
         and coalesce(btrim(p_first), '') <> ''
      then btrim(p_first) || ' (TeamLink Recruiter)'
    else 'A TeamLink recruiter'
  end
$$;

/** Can this candidate see this job anyway - on the board, or applied to it? */
create or replace function profile_viewer_job_visible(p_candidate text, p_job text)
returns boolean
language sql stable security definer set search_path = public as $$
  select p_job is not null and exists (
    select 1 from jobs j
     where j.id = p_job
       and ((j.status = 'open' and not coalesce(j.paused, false) and not coalesce(j.archived, false)
             and (j.expires_at is null or j.expires_at > now()))
            or exists (select 1 from applications a
                        where a.job_id = j.id and a.candidate_id = p_candidate)))
$$;

-- ---------------------------------------------------------------------
-- the candidate's window: no ids, no emails, no companies
-- ---------------------------------------------------------------------
create or replace view candidate_profile_viewers_v as
  select v.id                                                   as row_id,
         profile_viewer_display_name(v.viewer_role, v.viewer_first_name) as display_name,
         case when v.viewer_role = 'client' then 'hiring_team' else 'recruiter' end as viewer_kind,
         case when profile_viewer_job_visible(v.candidate_id, v.job_id)
              then (select j.title from jobs j where j.id = v.job_id) end   as role_title,
         v.last_viewed_at                                       as viewed_at,
         v.viewed_on,
         v.source,
         v.view_count
    from candidate_profile_views v
   where v.candidate_id = app_candidate_id();

comment on view candidate_profile_viewers_v is
  'What a candidate may read about who viewed them (0093): a safe display name, the role title when visible, when, and how. Never an id, an email, a company or a client.';

-- ---------------------------------------------------------------------
-- recording a view - the viewer comes from the session
--
-- Returns what happened, so the API can say so:
--   'recorded' | 'repeat' (same viewer, day and job: view_count + 1)
--   | 'self' | 'impersonated' | 'system' | 'not_staff'
-- ---------------------------------------------------------------------
create or replace function profile_view_record(p_candidate text, p_job text, p_source text,
                                               p_token_hash text)
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := app_user_id();
  v_role text := app_role();
  v_first text;
  v_day date := (now() at time zone 'Asia/Kolkata')::date;
  v_new boolean;
begin
  if v_user is null then return 'system'; end if;           -- engines and jobs
  if v_role not in ('recruiter','bde','client','admin') then return 'not_staff'; end if;
  if exists (select 1 from candidates c where c.id = p_candidate and c.user_id = v_user) then
    return 'self';
  end if;
  if exists (select 1 from sessions s where s.token_hash = p_token_hash
                                        and s.user_id = v_user
                                        and s.impersonated_by is not null) then
    return 'impersonated';
  end if;
  if not exists (select 1 from candidates c where c.id = p_candidate) then
    raise exception 'no such candidate' using errcode = 'P0002';
  end if;

  if v_role in ('recruiter','bde','admin') then
    select split_part(btrim(n), ' ', 1) into v_first from (
      select name as n from recruiters where user_id = v_user and v_role = 'recruiter'
      union all select name from bde_users where user_id = v_user and v_role = 'bde'
      union all select name from admins where user_id = v_user and v_role = 'admin') x
    limit 1;
    v_first := nullif(left(regexp_replace(coalesce(v_first, ''), '[^[:alpha:].''-]', '', 'g'), 30), '');
  end if;

  insert into candidate_profile_views as v
    (candidate_id, viewer_user_id, viewer_role, viewer_first_name, job_id, source, viewed_on)
  values (p_candidate, v_user, v_role, v_first, nullif(p_job, ''),
          coalesce(nullif(p_source, ''), 'profile'), v_day)
  on conflict (candidate_id, viewer_user_id, coalesce(job_id, ''), viewed_on)
  do update set view_count = v.view_count + 1, last_viewed_at = now()
  returning (xmax = 0) into v_new;

  return case when v_new then 'recorded' else 'repeat' end;
end $$;

-- ---------------------------------------------------------------------
-- search appearances - the page a recruiter actually looked at
-- ---------------------------------------------------------------------
create or replace function profile_search_hidden(p_candidate text)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from candidates c where c.id = p_candidate and coalesce(c.is_private, false))
      or exists (select 1 from user_prefs p join candidates c on c.user_id = p.user_id
                  where c.id = p_candidate
                    and p.key = 'teamlink_profile_visibility_v1'
                    and jsonb_typeof(p.value) = 'object'
                    and p.value ->> p_candidate = 'false')
$$;

create or replace function profile_search_appearances_add(p_candidates text[], p_sample jsonb,
                                                          p_token_hash text)
returns int
language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := app_user_id();
  v_day date := (now() at time zone 'Asia/Kolkata')::date;
  v_n int := 0;
  v_c text;
begin
  if v_user is null or app_role() not in ('recruiter','bde','client','admin') then return 0; end if;
  if exists (select 1 from sessions s where s.token_hash = p_token_hash and s.user_id = v_user
                                        and s.impersonated_by is not null) then
    return 0;
  end if;
  foreach v_c in array coalesce(p_candidates, '{}') loop
    continue when profile_search_hidden(v_c);
    continue when exists (select 1 from candidates c where c.id = v_c and c.user_id = v_user);
    insert into candidate_search_appearances as a (candidate_id, day, count, sample_query)
    values (v_c, v_day, 1, coalesce(p_sample, '{}'::jsonb))
    on conflict (candidate_id, day) do update
      set count = a.count + 1,
          sample_query = case when coalesce(p_sample, '{}'::jsonb) = '{}'::jsonb
                              then a.sample_query else p_sample end,
          updated_at = now();
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

-- ---------------------------------------------------------------------
-- the candidate's numbers
-- ---------------------------------------------------------------------
create or replace function profile_viewer_summary()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_c text := app_candidate_id();
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  if v_c is null then
    raise exception 'only a candidate has a "who viewed my profile"' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'views30',     (select count(*) from candidate_profile_views
                     where candidate_id = v_c and viewed_on > v_today - 30),
    'viewsPrev30', (select count(*) from candidate_profile_views
                     where candidate_id = v_c and viewed_on > v_today - 60 and viewed_on <= v_today - 30),
    'viewsToday',  (select count(*) from candidate_profile_views
                     where candidate_id = v_c and viewed_on = v_today),
    'viewsTotal',  (select count(*) from candidate_profile_views where candidate_id = v_c),
    'appear30',    (select coalesce(sum(count), 0) from candidate_search_appearances
                     where candidate_id = v_c and day > v_today - 30),
    'appearPrev30',(select coalesce(sum(count), 0) from candidate_search_appearances
                     where candidate_id = v_c and day > v_today - 60 and day <= v_today - 30),
    'appear90',    (select coalesce(sum(count), 0) from candidate_search_appearances
                     where candidate_id = v_c and day > v_today - 90),
    'shortlisted30', (select count(*) from application_stage_history h
                        join applications a on a.id = h.application_id
                       where a.candidate_id = v_c and h.to_stage = 'shortlisted'
                         and h.created_at > now() - interval '30 days'),
    'shortlistedPrev30', (select count(*) from application_stage_history h
                        join applications a on a.id = h.application_id
                       where a.candidate_id = v_c and h.to_stage = 'shortlisted'
                         and h.created_at > now() - interval '60 days'
                         and h.created_at <= now() - interval '30 days'),
    'weeks', (select jsonb_agg(jsonb_build_object('start', w.start, 'views', w.n) order by w.start)
                from (select (v_today - 7 * g - 6) as start,
                             (select count(*) from candidate_profile_views v
                               where v.candidate_id = v_c
                                 and v.viewed_on between v_today - 7 * g - 6 and v_today - 7 * g) as n
                        from generate_series(0, 7) g) w),
    'searches', (select coalesce(jsonb_agg(jsonb_build_object(
                          'day', s.day, 'count', s.count,
                          'role', nullif(s.sample_query ->> 'role', ''),
                          'city', nullif(s.sample_query ->> 'city', '')) order by s.day desc), '[]'::jsonb)
                   from (select * from candidate_search_appearances
                          where candidate_id = v_c and day > v_today - 30
                          order by day desc limit 10) s)
  );
end $$;

-- ---------------------------------------------------------------------
-- the digest engine's door (no person behind it - see 0086)
-- ---------------------------------------------------------------------
create or replace function profile_view_engine_guard() returns void
language plpgsql as $$
begin
  if not (app_role() = 'admin' and app_user_id() is null) then
    raise exception 'profile-view digests are run by the engine only' using errcode = '42501';
  end if;
end $$;

/** Candidates with views on p_day and no digest row for it yet. */
create or replace function profile_view_digest_due(p_day date)
returns table (candidate_id text, viewers int, staff int, hiring_teams int)
language plpgsql security definer set search_path = public as $$
begin
  perform profile_view_engine_guard();
  return query
    select v.candidate_id,
           count(distinct v.viewer_user_id)::int,
           count(distinct v.viewer_user_id) filter (where v.viewer_role <> 'client')::int,
           count(distinct v.viewer_user_id) filter (where v.viewer_role = 'client')::int
      from candidate_profile_views v
     where v.viewed_on = p_day
       and not exists (select 1 from candidate_profile_view_digests d
                        where d.candidate_id = v.candidate_id and d.day = p_day)
     group by v.candidate_id;
end $$;

/** Claim the (candidate, day) digest. True only for the first caller. */
create or replace function profile_view_digest_claim(p_candidate text, p_day date, p_viewers int)
returns boolean
language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  perform profile_view_engine_guard();
  insert into candidate_profile_view_digests (candidate_id, day, viewers)
  values (p_candidate, p_day, coalesce(p_viewers, 0))
  on conflict do nothing;
  get diagnostics v_n = row_count;
  return v_n > 0;
end $$;

create or replace function profile_view_digest_result(p_candidate text, p_day date,
                                                      p_channel text, p_status text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  perform profile_view_engine_guard();
  update candidate_profile_view_digests
     set in_app          = case when p_channel = 'in_app'   then left(p_status, 120) else in_app end,
         email_status    = case when p_channel = 'email'    then left(p_status, 120) else email_status end,
         whatsapp_status = case when p_channel = 'whatsapp' then left(p_status, 120) else whatsapp_status end
   where candidate_id = p_candidate and day = p_day;
end $$;

/** The candidate's digest opt-ins, for the engine. */
create or replace function profile_view_digest_prefs(p_candidates text[])
returns table (candidate_id text, digest_email boolean, digest_whatsapp boolean)
language plpgsql security definer set search_path = public as $$
begin
  perform profile_view_engine_guard();
  return query select p.candidate_id, p.digest_email, p.digest_whatsapp
                 from candidate_profile_view_prefs p where p.candidate_id = any(p_candidates);
end $$;

/** 180 days and gone. */
create or replace function profile_views_cleanup()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_views int; v_app int; v_dig int;
begin
  perform profile_view_engine_guard();
  delete from candidate_profile_views where viewed_on < (now() at time zone 'Asia/Kolkata')::date - 180;
  get diagnostics v_views = row_count;
  delete from candidate_search_appearances where day < (now() at time zone 'Asia/Kolkata')::date - 180;
  get diagnostics v_app = row_count;
  delete from candidate_profile_view_digests where day < (now() at time zone 'Asia/Kolkata')::date - 180;
  get diagnostics v_dig = row_count;
  return jsonb_build_object('views', v_views, 'appearances', v_app, 'digests', v_dig);
end $$;

-- ---------------------------------------------------------------------
-- grants
-- ---------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant select on candidate_profile_views, candidate_search_appearances,
                    candidate_profile_view_digests to app_api;
    grant select, insert, update on candidate_profile_view_prefs to app_api;
    grant select on candidate_profile_viewers_v to app_api;
    grant execute on function session_mark_impersonated(text) to app_api;
    grant execute on function profile_view_record(text, text, text, text) to app_api;
    grant execute on function profile_search_appearances_add(text[], jsonb, text) to app_api;
    grant execute on function profile_viewer_summary() to app_api;
    grant execute on function profile_view_digest_due(date) to app_api;
    grant execute on function profile_view_digest_claim(text, date, int) to app_api;
    grant execute on function profile_view_digest_result(text, date, text, text) to app_api;
    grant execute on function profile_view_digest_prefs(text[]) to app_api;
    grant execute on function profile_views_cleanup() to app_api;
    grant execute on function profile_viewer_display_name(text, text) to app_api;
    grant execute on function profile_viewer_job_visible(text, text) to app_api;
    grant execute on function profile_viewers_setting(text, boolean) to app_api;
    grant execute on function profile_search_hidden(text) to app_api;
  end if;
end $$;

-- The Notification Settings screen lists one row per template.
insert into notification_templates (event_key, label, fires_on) values
  ('profile_view_digest', 'Profile Views — Daily Digest', array['PROFILE_VIEWS_DIGEST'])
on conflict (event_key) do nothing;

comment on table candidate_profile_views is
  'Who viewed a candidate profile (0093): one row per viewer per IST day per job. Written only by profile_view_record(); candidates read it through candidate_profile_viewers_v.';
