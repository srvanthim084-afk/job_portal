-- ---------------------------------------------------------------------
-- 0117 — role-based data scoping: recruiter / team lead / admin
--
-- THE BUG. A recruiter (and a team lead, who did not exist) saw the whole
-- portal: every open job was readable by every signed-in role - an OPEN
-- requirement is a public posting, so jobs_public_read had no role in it
-- - and the browser was handed all of them through /api/bootstrap, with
-- every candidate beside them. Interviews, offers, AI interviews, AI call
-- history, delivery logs and the intake mailbox were scoped by COMPANY
-- (one consultancy = one company = everybody). "Talent pool" was just the
-- shared candidate table.
--
-- THE RULE, enforced here where a route that forgets cannot leak:
--
--   recruiter   their own jobs and everything hanging off them
--   team lead   a recruiter's rights over every job / pool entry / call
--               of their DEPARTMENT, plus their own
--   admin       everything
--   candidates  SHARED (0091 stays: Find Candidates searches everyone),
--               but the recruiter-specific layer - notes, tags, who
--               imported or saved a person, talent pool membership,
--               applications, scores - is per recruiter
--
-- A team lead is a recruiter login (users.role stays 'recruiter', so the
-- ~350 existing policies, routes and screens keep working) with
-- users.is_team_lead = true and a department. The session's scope is
-- always derived from users on the server, never from the client.
-- ---------------------------------------------------------------------

-- =====================================================================
-- 1. departments
-- =====================================================================
create table if not exists departments (
  id         text primary key,
  name       text not null unique,
  sort_order int  not null default 0
);
insert into departments (id, name, sort_order) values
  ('education',        'Education',        10),
  ('healthcare',       'Healthcare',       20),
  ('it-technology',    'IT & Technology',  30),
  ('manufacturing',    'Manufacturing',    40)
on conflict (id) do update set name = excluded.name, sort_order = excluded.sort_order;

alter table departments enable row level security;
alter table departments force  row level security;
drop policy if exists departments_read on departments;
create policy departments_read on departments for select using (true);
drop policy if exists departments_admin on departments;
create policy departments_admin on departments for all
  using (app_is_admin()) with check (app_is_admin());

alter table users
  add column if not exists department_id text references departments(id),
  add column if not exists is_team_lead  boolean not null default false;
create index if not exists users_department_idx on users (department_id) where department_id is not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'users_team_lead_is_recruiter') then
    alter table users add constraint users_team_lead_is_recruiter
      check (not is_team_lead or role = 'recruiter');
  end if;
  -- A team lead leads a department. Without one the flag would mean nothing
  -- (and must never be read as "everything").
  if not exists (select 1 from pg_constraint where conname = 'users_team_lead_has_department') then
    alter table users add constraint users_team_lead_has_department
      check (not is_team_lead or department_id is not null);
  end if;
end $$;

-- the job columns the helpers below read
alter table jobs
  add column if not exists created_by    uuid references users(id) on delete set null,
  add column if not exists department_id text references departments(id);

-- =====================================================================
-- 2. the identity helpers (all keyed on app_user_id(): they can only
--    ever describe the CALLER, never anybody else)
-- =====================================================================
create or replace function app_department_id() returns text
language sql stable security definer set search_path = public as $$
  select department_id from users where id = app_user_id()
$$;

create or replace function app_is_team_lead() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select u.is_team_lead and u.role = 'recruiter' and u.department_id is not null
                     from users u where u.id = app_user_id()), false)
$$;

/** 'admin' | 'teamlead' | 'recruiter' | the plain role (candidate, client, bde, anon). */
create or replace function app_scope_role() returns text
language sql stable as $$
  select case when app_role() = 'admin' then 'admin'
              when app_role() = 'recruiter' and app_is_team_lead() then 'teamlead'
              else app_role() end
$$;

/** The department of a recruiter profile ('r1'). */
create or replace function recruiter_department(p_recruiter_id text) returns text
language sql stable security definer set search_path = public as $$
  select u.department_id from recruiters r join users u on u.id = r.user_id
   where r.id = p_recruiter_id
$$;

/** Is this recruiter profile the caller, or (for a team lead) in the caller's department? */
create or replace function app_recruiter_in_scope(p_recruiter_id text) returns boolean
language sql stable security definer set search_path = public as $$
  select p_recruiter_id is not null and (
    app_role() = 'admin'
    or (app_role() = 'recruiter' and (
          p_recruiter_id = app_recruiter_id()
          or (app_is_team_lead() and recruiter_department(p_recruiter_id) = app_department_id()))))
$$;

/** The same for a users.id (message_logs.sent_by, notes, ...). */
create or replace function app_user_in_scope(p_user uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select p_user is not null and (
    app_role() = 'admin'
    or (app_role() = 'recruiter' and (
          p_user = app_user_id()
          or (app_is_team_lead() and exists (
                select 1 from users u where u.id = p_user and u.role = 'recruiter'
                   and u.department_id = app_department_id())))))
$$;

/** Do the caller and this recruiter share a department? (team notes) */
create or replace function app_recruiter_same_department(p_recruiter_id text) returns boolean
language sql stable security definer set search_path = public as $$
  select app_role() = 'recruiter' and app_department_id() is not null
     and recruiter_department(p_recruiter_id) = app_department_id()
$$;

/** A jobs row (or a view of one) by its owner and department - the inline form. */
create or replace function app_row_in_scope(p_recruiter_id text, p_department_id text) returns boolean
language sql stable security definer set search_path = public as $$
  select app_role() = 'admin'
      or (app_role() = 'recruiter' and (
            (p_recruiter_id is not null and p_recruiter_id = app_recruiter_id())
            or (p_department_id is not null and app_is_team_lead()
                and p_department_id = app_department_id())))
$$;

create or replace function app_job_in_scope(p_job_id text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from jobs j where j.id = p_job_id
                  and app_row_in_scope(j.recruiter_id, j.department_id))
$$;

/* The two 0031 helpers keep their names (a dozen policies call them) and
   gain the team lead. The original owner comparison is kept as it was. */
create or replace function app_job_is_mine(p_job_id text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from jobs j
     where j.id = p_job_id
       and (j.recruiter_id is not distinct from app_recruiter_id()
            or (app_is_team_lead() and j.department_id is not null
                and j.department_id = app_department_id())));
$$;

create or replace function app_candidate_is_mine(p_candidate_id text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from applications a
      join jobs j on j.id = a.job_id
     where a.candidate_id = p_candidate_id
       and (j.recruiter_id is not distinct from app_recruiter_id()
            or a.recruiter_id is not distinct from app_recruiter_id()
            or (app_is_team_lead() and j.department_id is not null
                and j.department_id = app_department_id())));
$$;

create or replace function app_candidate_editable(p_candidate_id text) returns boolean
language sql stable security definer set search_path = public as $$
  select case
    when app_is_admin() then true
    when app_role() = 'candidate' then p_candidate_id = app_candidate_id()
    when app_role() = 'recruiter' then exists (
      select 1 from candidates c
       where c.id = p_candidate_id
         and (app_recruiter_in_scope(c.owner_recruiter_id)
              or app_candidate_is_mine(c.id)))
    else false end
$$;

-- The 0107 / 0097 / 0098 / 0099 helpers: same names, scope-aware.
create or replace function ats_can_manage(p_app text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from applications a join jobs j on j.id = a.job_id
     where a.id = p_app
       and (app_is_admin()
            or (app_role() = 'recruiter' and app_recruiter_id() is not null
                and (app_recruiter_in_scope(a.recruiter_id)
                     or app_row_in_scope(j.recruiter_id, j.department_id)))))
$$;

create or replace function ats_job_is_mine(p_job text) returns boolean
language sql stable security definer set search_path = public as $$
  select app_is_admin()
      or (app_role() = 'recruiter' and app_recruiter_id() is not null and app_job_in_scope(p_job))
$$;

create or replace function screening_job_writer(p_job text) returns boolean
language sql stable security definer set search_path = public as $$
  select app_is_admin()
      or (app_role() = 'recruiter' and app_job_in_scope(p_job))
$$;

create or replace function prep_kit_staff_ok(p_interview text) returns boolean
language sql stable security definer set search_path = public as $$
  select app_is_admin()
      or (app_role() = 'recruiter' and exists (
            select 1 from interviews i
             where i.id = p_interview and app_job_in_scope(i.job_id)))
$$;

create or replace function app_walkin_drive_is_mine(p_drive text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from walkin_drives d
     where d.id = p_drive
       and d.created_by_recruiter_id is not null
       and app_recruiter_in_scope(d.created_by_recruiter_id))
$$;

-- =====================================================================
-- 3. jobs: created_by + department_id
-- =====================================================================
alter table jobs
  add column if not exists created_by    uuid references users(id) on delete set null,
  add column if not exists department_id text references departments(id);
create index if not exists jobs_created_by_idx  on jobs (created_by);
create index if not exists jobs_department_idx  on jobs (department_id);

/*
 * BEST-EFFORT MAPPING OF A FREE-TEXT ROLE TO A DEPARTMENT.
 *
 * Used only by this backfill. It reads the title, the department text
 * and the company's industry; a job that matches none stays NULL and is
 * listed by tools/report-unmapped-scope.mjs for an administrator to
 * assign. Order matters: a "Medical Equipment Engineer" is Healthcare.
 */
create or replace function department_guess(p_text text) returns text
language sql immutable as $$
  select case
    when p_text ~* '(health|medic|nurs|doctor|physician|clinic|hospital|pharma|surgeon|patholog|physio|neuro|cardio|paediat|pediat|ortho|dermat|nephro|radiolog|dental|dentist|anesthes|anaesthes|psychiat|gynae|gynec|oncolog|urolog|ophthalm|ent specialist|lab technician|caregiver|midwi|therapist|ayush|paramedic|biomedical)'
      then 'healthcare'
    when p_text ~* '(teacher|tutor|lecturer|professor|school|college|academic|education|faculty|principal|trainer|curriculum|e-?learning|instructor|counsel+or|librarian)'
      then 'education'
    when p_text ~* '(manufactur|production|plant|factory|assembly|machin|mechanical|quality (control|assurance|inspector)|welder|fitter|cnc|operator|maintenance|industrial|fabricat|foundry|lathe|supervisor|warehouse|automobile|automotive|electrician|boiler)'
      then 'manufacturing'
    when p_text ~* '(software|developer|programmer|devops|data (scientist|engineer|analyst)|python|java|react|node|angular|cloud|cyber|network|sysadmin|system admin|web|full.?stack|front.?end|back.?end|ui/?ux|mobile app|android|ios|qa |tester|technolog|\mit\M|saas|database|machine learning|ai engineer)'
      then 'it-technology'
    else null end
$$;

-- created_by: the login of the recruiter who owns the job today.
update jobs j set created_by = r.user_id
  from recruiters r
 where j.created_by is null and j.recruiter_id = r.id and r.user_id is not null;

-- department_id, first from what the job itself says ...
update jobs j set department_id = department_guess(
        coalesce(j.title, '') || ' ' || coalesce(j.department, '') || ' ' ||
        coalesce((select co.industry from companies co where co.id = j.company_id), ''))
 where j.department_id is null;

-- ... and each recruiter's department is the one most of their jobs
-- already carry (only when there is a single winner).
with counts as (
  select r.user_id, j.department_id, count(*) n,
         rank() over (partition by r.user_id order by count(*) desc) rk
    from jobs j join recruiters r on r.id = j.recruiter_id
   where j.department_id is not null and r.user_id is not null
   group by r.user_id, j.department_id
), winners as (
  select user_id, min(department_id) department_id
    from counts where rk = 1 group by user_id having count(*) = 1
)
update users u set department_id = w.department_id
  from winners w
 where u.id = w.user_id and u.department_id is null and u.role = 'recruiter';

-- jobs still without a department inherit their recruiter's.
update jobs j set department_id = u.department_id
  from recruiters r join users u on u.id = r.user_id
 where j.department_id is null and j.recruiter_id = r.id and u.department_id is not null;

/*
 * The owner, the creator and the department are never the client's to
 * say. A recruiter (or team lead) always gets their own; an administrator
 * may name a department for a job they create or reassign.
 */
create or replace function jobs_scope_defaults() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_user uuid; v_dept text;
begin
  if tg_op = 'INSERT' then
    if app_role() = 'recruiter' then
      new.recruiter_id := app_recruiter_id();
      new.created_by   := app_user_id();
      new.department_id := app_department_id();
    else
      if new.recruiter_id is not null then
        select r.user_id, u.department_id into v_user, v_dept
          from recruiters r left join users u on u.id = r.user_id where r.id = new.recruiter_id;
      end if;
      new.created_by := coalesce(new.created_by, v_user, app_user_id());
      new.department_id := coalesce(new.department_id, v_dept);
    end if;
    return new;
  end if;

  -- UPDATE
  if app_role() = 'recruiter' then
    new.recruiter_id  := old.recruiter_id;
    new.created_by    := old.created_by;
    new.department_id := old.department_id;
  elsif new.recruiter_id is distinct from old.recruiter_id and new.recruiter_id is not null then
    select r.user_id, u.department_id into v_user, v_dept
      from recruiters r left join users u on u.id = r.user_id where r.id = new.recruiter_id;
    new.created_by := coalesce(new.created_by, v_user);
    if new.department_id is not distinct from old.department_id and v_dept is not null then
      new.department_id := v_dept;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists jobs_scope_defaults on jobs;
create trigger jobs_scope_defaults before insert or update on jobs
  for each row execute function jobs_scope_defaults();

-- ---- the policies -------------------------------------------------------
drop policy if exists jobs_public_read on jobs;
create policy jobs_public_read on jobs for select using (
  -- The public board is for the public. A recruiter's own screens are
  -- their desk, never the board (0031 said so in the route; this says it
  -- in the database).
  (status = 'open' and not paused and not archived
     and (expires_at is null or expires_at > now())
     and app_role() <> 'recruiter')
  or app_is_admin()
  or (app_role() = 'recruiter' and app_row_in_scope(recruiter_id, department_id))
  or (app_role() = 'client'    and company_id = app_client_company())
);

drop policy if exists jobs_recruiter_insert on jobs;
create policy jobs_recruiter_insert on jobs for insert
  with check (
    app_is_admin()
    or (app_role() = 'recruiter' and (recruiter_id is null or recruiter_id = app_recruiter_id())));

drop policy if exists jobs_recruiter_update on jobs;
create policy jobs_recruiter_update on jobs for update
  using      (app_is_admin() or (app_role() = 'recruiter' and app_row_in_scope(recruiter_id, department_id)))
  with check (app_is_admin() or (app_role() = 'recruiter' and app_row_in_scope(recruiter_id, department_id)));

drop policy if exists jobs_recruiter_delete on jobs;
create policy jobs_recruiter_delete on jobs for delete
  using (app_is_admin() or (app_role() = 'recruiter' and app_row_in_scope(recruiter_id, department_id)));

/*
 * The views list their columns when they are created, so they must be
 * recreated to carry created_by and department_id. Bodies are 0113's,
 * unchanged (jobs_open stays TeamLink's own jobs only).
 */
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
  and source_type = 'TEAMLINK';

comment on view jobs_open is
  'What the Jobs page may list: Active TeamLink jobs only (0113), no walk-in whose date and end time have passed (0106). Carries created_by and department_id (0117).';

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant select on jobs_with_counts, jobs_open to app_api;
  end if;
end $$;

-- =====================================================================
-- 4. applications and everything keyed on a job
-- =====================================================================
drop policy if exists applications_read on applications;
create policy applications_read on applications for select using (
  app_is_admin()
  or candidate_id = app_candidate_id()
  or (app_role() = 'recruiter' and (app_recruiter_in_scope(recruiter_id) or app_job_is_mine(job_id)))
  or (app_role() = 'client' and stage = any (app_client_visible_stages()) and exists (
        select 1 from jobs j where j.id = applications.job_id
          and j.company_id = app_client_company()))
);

drop policy if exists applications_recruiter_update on applications;
create policy applications_recruiter_update on applications for update
  using (
    app_is_admin()
    or (app_role() = 'recruiter' and (app_recruiter_in_scope(recruiter_id) or app_job_is_mine(job_id))))
  with check (
    app_is_admin()
    or (app_role() = 'recruiter' and (app_recruiter_in_scope(recruiter_id) or app_job_is_mine(job_id))));

drop policy if exists applications_candidate_insert on applications;
create policy applications_candidate_insert on applications for insert
  with check (
    app_is_admin()
    or (candidate_id = app_candidate_id() and exists (
          select 1 from jobs j where j.id = job_id
            and j.status = 'open' and not j.paused and not j.archived))
    or (app_role() = 'recruiter' and app_job_in_scope(job_id))
  );

-- interviews
drop policy if exists interviews_read on interviews;
create policy interviews_read on interviews for select using (
  app_is_admin() or candidate_id = app_candidate_id()
  or (app_role() = 'recruiter' and app_job_in_scope(job_id))
  or (app_role() = 'client' and exists (
        select 1 from jobs j where j.id = interviews.job_id and j.company_id = app_client_company()))
);
drop policy if exists interviews_write on interviews;
create policy interviews_write on interviews for all
  using (
    app_is_admin()
    or (app_role() = 'recruiter' and app_job_in_scope(job_id))
    or (app_role() = 'client' and exists (
          select 1 from jobs j where j.id = interviews.job_id and j.company_id = app_client_company())))
  with check (
    app_is_admin()
    or (app_role() = 'recruiter' and app_job_in_scope(job_id))
    or (app_role() = 'client' and exists (
          select 1 from jobs j where j.id = interviews.job_id and j.company_id = app_client_company())));

-- offers
drop policy if exists offers_read on offers;
create policy offers_read on offers for select using (
  app_is_admin() or candidate_id = app_candidate_id()
  or (app_role() = 'recruiter' and app_job_in_scope(job_id))
  or (app_role() = 'client' and exists (
        select 1 from jobs j where j.id = offers.job_id and j.company_id = app_client_company()))
);
drop policy if exists offers_write on offers;
create policy offers_write on offers for all
  using      (app_is_admin() or (app_role() = 'recruiter' and app_job_in_scope(job_id)))
  with check (app_is_admin() or (app_role() = 'recruiter' and app_job_in_scope(job_id)));

-- AI interviews
drop policy if exists ai_interviews_read on ai_interviews;
create policy ai_interviews_read on ai_interviews for select using (
  app_is_admin() or candidate_id = app_candidate_id()
  or (app_role() = 'recruiter' and app_job_in_scope(job_id))
  or (app_role() = 'client' and exists (
        select 1 from jobs j where j.id = ai_interviews.job_id and j.company_id = app_client_company()))
);
drop policy if exists ai_interviews_write on ai_interviews;
create policy ai_interviews_write on ai_interviews for all
  using      (app_is_admin() or (app_role() = 'recruiter' and app_job_in_scope(job_id)))
  with check (app_is_admin() or (app_role() = 'recruiter' and app_job_in_scope(job_id)));

-- delivery logs (email / SMS / WhatsApp / IVR history of an application)
drop policy if exists nd_read on notification_deliveries;
create policy nd_read on notification_deliveries for select using (
  app_is_admin() or candidate_id = app_candidate_id()
  or (app_role() = 'recruiter' and app_job_in_scope(job_id))
  or (app_role() = 'client' and exists (
        select 1 from jobs j where j.id = notification_deliveries.job_id
          and j.company_id = app_client_company()))
);

drop policy if exists job_view_daily_read on job_view_daily;
create policy job_view_daily_read on job_view_daily for select using (
  app_is_admin() or (app_role() = 'recruiter' and app_job_in_scope(job_id))
);

drop policy if exists job_publications_read on job_publications;
create policy job_publications_read on job_publications for select using (
  app_is_admin() or (app_role() = 'recruiter' and app_job_in_scope(job_id))
);
drop policy if exists job_publication_events_read on job_publication_events;
create policy job_publication_events_read on job_publication_events for select using (
  app_is_admin() or (app_role() = 'recruiter' and app_job_in_scope(job_id))
);

drop policy if exists job_shares_read on job_shares;
create policy job_shares_read on job_shares for select using (
  app_is_admin()
  or (shared_by is not null and shared_by = any (array[app_candidate_id(), app_recruiter_id()]))
  or (app_role() = 'recruiter' and app_job_in_scope(job_id))
);

-- job-keyed match and call records
drop policy if exists job_matches_read on job_matches;
create policy job_matches_read on job_matches for select using (
  app_is_admin() or candidate_id = app_candidate_id()
  or (app_role() = 'recruiter' and app_job_in_scope(job_id))
  or (app_role() in ('bde', 'client') and exists (
        select 1 from candidates c where c.id = job_matches.candidate_id))
);
drop policy if exists job_match_deliveries_read on job_match_deliveries;
create policy job_match_deliveries_read on job_match_deliveries for select using (
  app_is_admin() or exists (
    select 1 from job_matches m
     where m.id = job_match_deliveries.match_id
       and (m.candidate_id = app_candidate_id() or app_role() in ('bde', 'client')
            or (app_role() = 'recruiter' and app_job_in_scope(m.job_id))))
);

drop policy if exists ai_call_sessions_read on ai_call_sessions;
create policy ai_call_sessions_read on ai_call_sessions for select using (
  app_is_admin() or candidate_id = app_candidate_id()
  or app_role() in ('bde', 'client')
  or (app_role() = 'recruiter' and (app_recruiter_in_scope(recruiter_id)
                                    or (job_id is not null and app_job_in_scope(job_id))))
);
drop policy if exists ai_call_turns_read on ai_call_turns;
create policy ai_call_turns_read on ai_call_turns for select using (
  app_is_admin() or exists (
    select 1 from ai_call_sessions s where s.id = ai_call_turns.session_id)
);
drop policy if exists ai_call_events_read on ai_call_events;
create policy ai_call_events_read on ai_call_events for select using (
  app_is_admin() or app_role() = 'bde'
  or (app_role() = 'recruiter' and exists (
        select 1 from ai_call_sessions s where s.id = ai_call_events.session_id))
);
drop policy if exists ai_call_callbacks_read on ai_call_callbacks;
create policy ai_call_callbacks_read on ai_call_callbacks for select using (
  app_is_admin() or candidate_id = app_candidate_id() or app_role() = 'bde'
  or (app_role() = 'recruiter' and (app_recruiter_in_scope(recruiter_id)
                                    or (job_id is not null and app_job_in_scope(job_id))))
);
drop policy if exists ai_call_campaigns_read on ai_call_campaigns;
create policy ai_call_campaigns_read on ai_call_campaigns for select using (
  app_is_admin() or app_role() in ('bde', 'client')
  or (app_role() = 'recruiter' and (app_recruiter_in_scope(recruiter_id) or app_job_in_scope(job_id)))
);

-- the application timeline
drop policy if exists application_events_read on application_events;
create policy application_events_read on application_events for select using (
  app_is_admin() or candidate_id = app_candidate_id()
  or app_role() in ('bde', 'client')
  or (app_role() = 'recruiter' and (
        (application_id is not null and exists (
           select 1 from applications a where a.id = application_events.application_id))
        or (application_id is null and candidate_id is not null and app_candidate_editable(candidate_id))))
);

-- the intake mailbox belongs to the recruiter who connected it
drop policy if exists email_mailboxes_read on email_mailboxes;
create policy email_mailboxes_read on email_mailboxes for select using (
  app_is_admin() or app_role() = 'bde'
  or (app_role() = 'recruiter' and (app_recruiter_in_scope(recruiter_id) or app_user_in_scope(owner_user_id)))
);
drop policy if exists email_mailboxes_delete on email_mailboxes;
create policy email_mailboxes_delete on email_mailboxes for delete using (
  app_is_admin() or app_role() = 'bde'
  or (app_role() = 'recruiter' and (app_recruiter_in_scope(recruiter_id) or app_user_in_scope(owner_user_id)))
);
drop policy if exists email_messages_read on email_messages;
create policy email_messages_read on email_messages for select using (
  app_is_admin() or app_role() = 'bde'
  or (app_role() = 'recruiter' and (
        exists (select 1 from email_mailboxes m where m.id = email_messages.mailbox_id)
        or (application_id is not null and exists (
              select 1 from applications a where a.id = email_messages.application_id))))
);
drop policy if exists email_messages_delete on email_messages;
create policy email_messages_delete on email_messages for delete using (
  app_is_admin() or app_role() = 'bde'
  or (app_role() = 'recruiter' and exists (
        select 1 from email_mailboxes m where m.id = email_messages.mailbox_id))
);

-- walk-in drives: a team lead sees their department's recruiters'
drop policy if exists walkin_drives_read on walkin_drives;
create policy walkin_drives_read on walkin_drives for select using (
  app_is_admin()
  or (app_role() = 'recruiter' and created_by_recruiter_id is not null
      and app_recruiter_in_scope(created_by_recruiter_id))
  or (app_role() = 'candidate' and (status in ('UPCOMING','ONGOING') or app_walkin_registered(id)))
);
drop policy if exists walkin_drives_update on walkin_drives;
create policy walkin_drives_update on walkin_drives for update
  using      (app_is_admin() or (app_role() = 'recruiter' and app_recruiter_in_scope(created_by_recruiter_id)))
  with check (app_is_admin() or (app_role() = 'recruiter' and app_recruiter_in_scope(created_by_recruiter_id)));
drop policy if exists walkin_drives_delete on walkin_drives;
create policy walkin_drives_delete on walkin_drives for delete
  using (app_is_admin() or (app_role() = 'recruiter' and app_recruiter_in_scope(created_by_recruiter_id)));

drop policy if exists ats_recruiter_alerts_read on ats_recruiter_alerts;
create policy ats_recruiter_alerts_read on ats_recruiter_alerts for select
  using (app_is_admin() or (app_role() = 'recruiter' and app_recruiter_in_scope(recruiter_id)));

-- =====================================================================
-- 5. candidates: shared profile, recruiter-specific layer scoped
-- =====================================================================
alter table candidates
  add column if not exists origin text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'candidates_origin_known') then
    alter table candidates add constraint candidates_origin_known
      check (origin is null or origin in ('self_registered', 'imported', 'applied'));
  end if;
end $$;
-- How the person got here: they registered, a recruiter brought them in,
-- or they arrived by applying. (`source` stays what it was: the board.)
update candidates c set origin =
  case when c.user_id is not null then 'self_registered'
       when c.import_id is not null or c.owner_recruiter_id is not null then 'imported'
       when exists (select 1 from applications a where a.candidate_id = c.id) then 'applied'
       else 'imported' end
 where c.origin is null;

drop policy if exists candidates_read on candidates;
create policy candidates_read on candidates for select using (
  app_is_admin()
  or id = app_candidate_id()
  or (app_role() = 'recruiter' and (
        not coalesce(is_private, false)
        or app_recruiter_in_scope(owner_recruiter_id)
        or app_candidate_is_mine(candidates.id)))
  or (app_role() = 'client'
        and app_candidate_at_company(candidates.id, app_client_company(),
                                     app_client_visible_stages()))
);

drop policy if exists candidates_self_write on candidates;
create policy candidates_self_write on candidates for update
  using (
    id = app_candidate_id() or app_is_admin()
    or (app_role() = 'recruiter' and (
          app_recruiter_in_scope(owner_recruiter_id) or app_candidate_is_mine(candidates.id))))
  with check (
    id = app_candidate_id() or app_is_admin()
    or (app_role() = 'recruiter' and (
          app_recruiter_in_scope(owner_recruiter_id) or app_candidate_is_mine(candidates.id))));

-- what a recruiter did with a person: scoped like the rest
drop policy if exists cch_read on candidate_contact_history;
create policy cch_read on candidate_contact_history for select using (
  app_is_admin()
  or candidate_id = app_candidate_id()
  or app_role() = 'bde'
  or (app_role() = 'recruiter' and (
        app_recruiter_in_scope(recruiter_id)
        or app_user_in_scope(contacted_by)
        or (job_id is not null and app_job_in_scope(job_id))))
);

drop policy if exists mlog_read on message_logs;
create policy mlog_read on message_logs for select using (
  app_is_admin()
  or app_role() = 'bde'
  or candidate_id = app_candidate_id()
  or (app_role() = 'recruiter' and (app_user_in_scope(sent_by) or app_candidate_editable(candidate_id)))
);

drop policy if exists ca_read on candidate_activity;
create policy ca_read on candidate_activity for select using (
  app_is_admin()
  or (app_role() = 'bde' and exists (select 1 from candidates c where c.id = candidate_activity.candidate_id))
  or (app_role() = 'recruiter' and app_candidate_editable(candidate_id))
);

drop policy if exists ci_read on candidate_invites;
create policy ci_read on candidate_invites for select using (
  app_is_admin() or candidate_id = app_candidate_id()
  or (app_role() = 'bde' and exists (select 1 from candidates c where c.id = candidate_invites.candidate_id))
  or (app_role() = 'recruiter' and app_candidate_editable(candidate_id))
);

-- WHO IMPORTED WHOM is the importer's, and their team lead's
drop policy if exists cimp_read on candidate_imports;
create policy cimp_read on candidate_imports for select using (
  app_is_admin() or app_role() = 'bde'
  or (app_role() = 'recruiter' and app_recruiter_in_scope(recruiter_id))
);
drop policy if exists cml_read on candidate_merge_logs;
create policy cml_read on candidate_merge_logs for select using (
  app_is_admin() or app_role() = 'bde'
  or (app_role() = 'recruiter' and (
        app_user_in_scope(merged_by)
        or exists (select 1 from candidate_imports i where i.id = candidate_merge_logs.import_id)))
);

-- notes: yours, your team lead's view of your department, or - when you
-- marked one "team" - the recruiters of your own department. Never
-- another department, never the whole firm (0091's firm-wide share goes).
drop policy if exists comments_team_read on candidate_comments;
create policy comments_scope_read on candidate_comments for select using (
  app_role() = 'recruiter' and (
    app_recruiter_in_scope(recruiter_id)
    or (visibility = 'team' and app_recruiter_same_department(recruiter_id)
        and exists (select 1 from candidates c where c.id = candidate_comments.candidate_id)))
);

-- folders, bookmarks, reports: the team lead reads their department's
drop policy if exists lists_scope_read on candidate_lists;
create policy lists_scope_read on candidate_lists for select using (
  app_role() = 'recruiter' and app_recruiter_in_scope(recruiter_id));
drop policy if exists list_members_scope_read on candidate_list_members;
create policy list_members_scope_read on candidate_list_members for select using (
  exists (select 1 from candidate_lists l where l.id = candidate_list_members.list_id));
drop policy if exists bookmarks_scope_read on candidate_bookmarks;
create policy bookmarks_scope_read on candidate_bookmarks for select using (
  app_role() = 'recruiter' and app_recruiter_in_scope(recruiter_id));
drop policy if exists reports_scope_read on candidate_reports;
create policy reports_scope_read on candidate_reports for select using (
  app_role() = 'recruiter' and app_recruiter_in_scope(recruiter_id));

-- =====================================================================
-- 6. talent_pool: the recruiter-specific layer, one row per (person, recruiter)
-- =====================================================================
create table if not exists talent_pool (
  id            bigserial primary key,
  candidate_id  text not null references candidates(id) on delete cascade,
  recruiter_id  text not null references recruiters(id) on delete cascade,
  department_id text references departments(id),
  notes            text,
  internal_remarks text,
  candidate_notes  text,
  tags          text[] not null default '{}',
  origin        text not null default 'saved'
                  check (origin in ('imported', 'added', 'saved', 'applied')),
  import_id     text references candidate_imports(id) on delete set null,
  added_at      timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (candidate_id, recruiter_id)
);
create index if not exists talent_pool_recruiter_idx   on talent_pool (recruiter_id, added_at desc);
create index if not exists talent_pool_department_idx  on talent_pool (department_id, added_at desc);
create index if not exists talent_pool_candidate_idx   on talent_pool (candidate_id);

alter table talent_pool enable row level security;
alter table talent_pool force  row level security;

drop policy if exists talent_pool_read on talent_pool;
create policy talent_pool_read on talent_pool for select using (
  app_is_admin()
  or (app_role() = 'recruiter' and (
        recruiter_id = app_recruiter_id()
        or (app_is_team_lead() and department_id is not null and department_id = app_department_id())))
);
drop policy if exists talent_pool_insert on talent_pool;
create policy talent_pool_insert on talent_pool for insert
  with check (app_is_admin() or (app_role() = 'recruiter' and recruiter_id = app_recruiter_id()));
drop policy if exists talent_pool_update on talent_pool;
create policy talent_pool_update on talent_pool for update
  using      (app_is_admin() or (app_role() = 'recruiter' and recruiter_id = app_recruiter_id()))
  with check (app_is_admin() or (app_role() = 'recruiter' and recruiter_id = app_recruiter_id()));
drop policy if exists talent_pool_delete on talent_pool;
create policy talent_pool_delete on talent_pool for delete
  using (app_is_admin() or (app_role() = 'recruiter' and recruiter_id = app_recruiter_id()));


-- ---- how a person gets into a pool ------------------------------------
/* Internal: no caller check. Triggers and the definer functions below. */
create or replace function _talent_pool_upsert(
  p_candidate text, p_recruiter text, p_origin text, p_import text default null)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_candidate is null or p_recruiter is null then return; end if;
  if not exists (select 1 from recruiters where id = p_recruiter) then return; end if;
  if not exists (select 1 from candidates where id = p_candidate) then return; end if;
  insert into talent_pool (candidate_id, recruiter_id, department_id, origin, import_id)
  values (p_candidate, p_recruiter, recruiter_department(p_recruiter), p_origin,
          (select i.id from candidate_imports i where i.id = p_import))
  on conflict (candidate_id, recruiter_id) do update
     set import_id = coalesce(talent_pool.import_id, excluded.import_id)
   where talent_pool.import_id is null and excluded.import_id is not null;
end $$;

/**
 * Put a candidate in the CALLER's talent pool (a recruiter), or in a named
 * recruiter's (an administrator). A recruiter can only pool somebody they
 * may read; the recruiter id is never taken from a recruiter's request.
 */
create or replace function talent_pool_link(
  p_candidate text, p_origin text default 'saved', p_recruiter text default null,
  p_import text default null)
returns boolean
language plpgsql security definer set search_path = public as $$
declare v_rid text;
begin
  if app_role() = 'recruiter' then v_rid := app_recruiter_id();
  elsif app_role() = 'admin' then v_rid := p_recruiter;
  end if;
  if v_rid is null then return false; end if;
  if p_origin not in ('imported', 'added', 'saved', 'applied') then p_origin := 'saved'; end if;
  if app_role() = 'recruiter' and not exists (
       select 1 from candidates c
        where c.id = p_candidate
          and (not coalesce(c.is_private, false)
               or app_recruiter_in_scope(c.owner_recruiter_id)
               or app_candidate_is_mine(c.id))) then
    return false;
  end if;
  perform _talent_pool_upsert(p_candidate, v_rid, p_origin, p_import);
  return true;
end $$;

create or replace function talent_pool_link_many(p_ids text[], p_origin text default 'saved')
returns int
language plpgsql security definer set search_path = public as $$
declare n int := 0; v text;
begin
  foreach v in array coalesce(p_ids, '{}') loop
    if talent_pool_link(v, p_origin) then n := n + 1; end if;
  end loop;
  return n;
end $$;

-- a candidate created with an owner is in the owner's pool
create or replace function candidates_pool_owner() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.owner_recruiter_id is not null
     and (tg_op = 'INSERT' or new.owner_recruiter_id is distinct from old.owner_recruiter_id) then
    perform _talent_pool_upsert(new.id, new.owner_recruiter_id,
      case when new.import_id is not null then 'imported' else 'added' end, new.import_id);
  end if;
  return new;
end $$;
drop trigger if exists candidates_pool_owner on candidates;
create trigger candidates_pool_owner after insert or update of owner_recruiter_id on candidates
  for each row execute function candidates_pool_owner();

-- an applicant is in the pool of the recruiter whose job they applied to
create or replace function applications_pool_owner() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_owner text;
begin
  select recruiter_id into v_owner from jobs where id = new.job_id;
  perform _talent_pool_upsert(new.candidate_id, v_owner, 'applied');
  if new.recruiter_id is not null and new.recruiter_id is distinct from v_owner then
    perform _talent_pool_upsert(new.candidate_id, new.recruiter_id, 'applied');
  end if;
  return new;
end $$;
drop trigger if exists applications_pool_owner on applications;
create trigger applications_pool_owner after insert on applications
  for each row execute function applications_pool_owner();

-- a recruiter moved to another department takes their pool with them
create or replace function users_department_moved() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.department_id is distinct from old.department_id then
    update talent_pool set department_id = new.department_id, updated_at = now()
     where recruiter_id in (select id from recruiters where user_id = new.id);
  end if;
  return new;
end $$;
drop trigger if exists users_department_moved on users;
create trigger users_department_moved after update of department_id on users
  for each row execute function users_department_moved();

/*
 * NOTES AND TAGS LIVE ON talent_pool, NEVER ON candidates.
 *
 * The four columns 0057 added stay (dropping them would break every
 * older reader) but nothing can write them any more: an insert gets NULL
 * / empty, an update keeps what was there. What was there is copied to
 * the owner's talent_pool row below.
 */
create or replace function candidates_no_private_notes() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    new.recruiter_notes := null; new.internal_remarks := null;
    new.candidate_notes := null; new.tags := '{}';
  else
    new.recruiter_notes := old.recruiter_notes; new.internal_remarks := old.internal_remarks;
    new.candidate_notes := old.candidate_notes; new.tags := old.tags;
  end if;
  return new;
end $$;

-- ---- backfill: the pool from what is already true --------------------------
insert into talent_pool (candidate_id, recruiter_id, department_id, origin, import_id, added_at,
                         notes, internal_remarks, candidate_notes, tags)
select c.id, coalesce(c.owner_recruiter_id, i.recruiter_id),
       recruiter_department(coalesce(c.owner_recruiter_id, i.recruiter_id)),
       case when c.import_id is not null then 'imported' else 'added' end,
       c.import_id, coalesce(c.sourced_at, c.created_at),
       c.recruiter_notes, c.internal_remarks, c.candidate_notes, coalesce(c.tags, '{}')
  from candidates c
  left join candidate_imports i on i.id = c.import_id
  join recruiters r on r.id = coalesce(c.owner_recruiter_id, i.recruiter_id)
on conflict (candidate_id, recruiter_id) do nothing;

insert into talent_pool (candidate_id, recruiter_id, department_id, origin, added_at)
select a.candidate_id, j.recruiter_id, recruiter_department(j.recruiter_id), 'applied',
       min(a.applied_at)
  from applications a join jobs j on j.id = a.job_id
  join recruiters r on r.id = j.recruiter_id
 group by a.candidate_id, j.recruiter_id
on conflict (candidate_id, recruiter_id) do nothing;

-- the legacy columns are emptied only where their content now lives on a pool row
update candidates c set recruiter_notes = null, internal_remarks = null,
                        candidate_notes = null, tags = '{}'
 where (c.recruiter_notes is not null or c.internal_remarks is not null
        or c.candidate_notes is not null or coalesce(array_length(c.tags, 1), 0) > 0)
   and exists (select 1 from talent_pool tp where tp.candidate_id = c.id and tp.origin in ('imported', 'added'));

drop trigger if exists candidates_no_private_notes on candidates;
create trigger candidates_no_private_notes before insert or update on candidates
  for each row execute function candidates_no_private_notes();

/*
 * ONE PERSON, ONE ROW - the lookup an import needs.
 *
 * "Does this email or mobile already belong to a candidate?" asked under
 * a recruiter's own rights says "no" for every private profile, and the
 * import then creates a second record for somebody already on file. This
 * answers with the id and NOTHING ELSE (no name, no contact details); the
 * caller still has to be able to read the row to do anything with it.
 * Phones compare on their last ten digits, as everywhere else.
 */
create or replace function candidate_find_by_contact(p_email text, p_phone text)
returns text
language sql stable security definer set search_path = public as $$
  select c.id from candidates c
   where (coalesce(p_email, '') <> '' and lower(btrim(coalesce(c.email, ''))) = lower(btrim(p_email)))
      or (length(regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g')) >= 10
          and right(regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g'), 10)
            = right(regexp_replace(p_phone, '[^0-9]', '', 'g'), 10))
   order by c.created_at, c.id
   limit 1
$$;

/* "When was this person last contacted?" - by the caller's own scope, not
   by everybody (0091 answered for the whole firm; a date that says "a
   colleague phoned her on Tuesday" is a colleague's activity). */
create or replace function candidate_last_contacted_at(p_candidate_id text)
returns timestamptz
language sql stable security definer set search_path = public as $$
  select max(h.created_at) from candidate_contact_history h
   where h.candidate_id = p_candidate_id and cch_is_contact(h.source)
     and app_role() in ('recruiter', 'bde', 'admin')
     and (app_role() <> 'recruiter'
          or app_recruiter_in_scope(h.recruiter_id) or app_user_in_scope(h.contacted_by))
$$;

/*
 * OUTREACH ON THE HOME DASHBOARD, counted on the server, in scope.
 *
 *   recruiter   what they sent, and what the system sent about their jobs
 *   team lead   the same for their department
 *   admin       everything
 *
 * Definer, because candidates' in-app notifications are not readable by a
 * recruiter; the scope is applied inside by the same helpers the policies
 * use. A message is "viewed" only where the system records it: an in-app
 * notification being read. Nothing is inferred for email, SMS or WhatsApp.
 */
create or replace function recruiter_outreach_stats() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  if app_role() not in ('recruiter', 'admin') then
    return jsonb_build_object('totalSent', 0, 'candidatesReached', 0);
  end if;
  with msgs as (
    select m.channel, (m.status in ('sent', 'delivered')) as ok, (m.status = 'failed') as bad,
           m.candidate_id
      from message_logs m where app_user_in_scope(m.sent_by)
    union all
    select d.channel, (d.status = 'sent'), (d.status = 'failed'), d.candidate_id
      from notification_deliveries d
     where d.channel in ('email', 'sms', 'whatsapp') and app_job_in_scope(d.job_id)
  ), inapp as (
    select n.candidate_id, n.read
      from notifications n
     where n.recipient_role = 'candidate' and not n.system
       and n.job_id is not null and app_job_in_scope(n.job_id)
  )
  select jsonb_build_object(
    'email',    jsonb_build_object('sent', count(*) filter (where channel = 'email' and ok),
                                   'failed', count(*) filter (where channel = 'email' and bad),
                                   'reached', count(distinct candidate_id) filter (where channel = 'email' and ok)),
    'whatsapp', jsonb_build_object('sent', count(*) filter (where channel = 'whatsapp' and ok),
                                   'failed', count(*) filter (where channel = 'whatsapp' and bad),
                                   'reached', count(distinct candidate_id) filter (where channel = 'whatsapp' and ok)),
    'sms',      jsonb_build_object('sent', count(*) filter (where channel = 'sms' and ok),
                                   'failed', count(*) filter (where channel = 'sms' and bad),
                                   'reached', count(distinct candidate_id) filter (where channel = 'sms' and ok)),
    'inapp',    (select jsonb_build_object('sent', count(*), 'read', count(*) filter (where read)) from inapp),
    'candidatesReached', (select count(distinct x) from (
                            select candidate_id x from msgs where ok
                            union select candidate_id from inapp where candidate_id is not null) q)
  ) into v from msgs;
  return v;
end $$;


-- =====================================================================
-- 6b. "already contacted" (0091) under the new rule
--
-- 0091 let every recruiter see WHO else was working a candidate, for which
-- role, how far - in search badges, an activity panel and in the refusal
-- messages. That is another recruiter's pipeline. The rule that two
-- recruiters must not work the same person for the same role STAYS (the
-- triggers still refuse it); what changes is how much the refusal says:
-- a holder outside the caller's scope is "Another recruiter" - no name, no
-- job, no stage - and the badges and the panel list only engagements the
-- caller may see (their own; a team lead's department; an admin's all).
-- =====================================================================

/** Is a recruiter of this NAME inside the caller's scope? (messages carry names) */
create or replace function engagement_holder_visible(p_name text) returns boolean
language sql stable security definer set search_path = public as $$
  select p_name is not null and (app_role() = 'admin' or exists (
    select 1 from recruiters r where r.name = p_name and app_recruiter_in_scope(r.id)))
$$;

create or replace function engagement_block_message(
  p_reason text, p_holder text, p_job_title text, p_role_key text,
  p_status_label text, p_expires timestamptz
) returns text
language sql stable security definer set search_path = public as $$
  select case
    when p_reason = 'joined' then format(
      '%s placed this candidate (joined through TeamLink). They are held for every role until %s (replacement period).',
      case when engagement_holder_visible(p_holder) then p_holder else 'Another recruiter' end,
      coalesce(to_char(p_expires, 'DD Mon YYYY'), 'the replacement period ends'))
    when p_reason = 'placed_other_role' then format(
      'This candidate joined through TeamLink recently. Contact for another role is blocked until %s (replacement period).',
      coalesce(to_char(p_expires, 'DD Mon YYYY'), 'the replacement period ends'))
    when engagement_holder_visible(p_holder) then format(
      '%s is processing this candidate for %s%s. Hold ends %s if no activity.',
      p_holder,
      coalesce(p_job_title, initcap(p_role_key), 'this role'),
      coalesce(' (' || p_status_label || ')', ''),
      coalesce(to_char(p_expires, 'DD Mon YYYY'), 'after 30 days'))
    else format(
      'Another recruiter is already working on this candidate. Hold ends %s if no activity.',
      coalesce(to_char(p_expires, 'DD Mon YYYY'), 'after 30 days'))
  end
$$;

create or replace function engagement_block_detail(
  p_decision text, p_reason text, p_holder_id text, p_holder text, p_role_key text,
  p_job_title text, p_status_label text, p_expires timestamptz
) returns text
language sql stable security definer set search_path = public as $$
  select case when engagement_holder_visible(p_holder) then
           json_build_object('decision', p_decision, 'reason', p_reason,
             'holderRecruiterId', p_holder_id, 'holderName', p_holder,
             'roleKey', p_role_key, 'jobTitle', p_job_title,
             'statusLabel', p_status_label, 'holdExpiresAt', p_expires)::text
         else
           json_build_object('decision', p_decision, 'reason', p_reason,
             'holderRecruiterId', 'holder', 'holderName', 'Another recruiter',
             'holdExpiresAt', p_expires)::text
         end
$$;

/* The same trigger as 0091, with one change: the duplicate-submission
   refusal names the first recruiter only when that recruiter is in scope. */
create or replace function applications_engagement_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_job record;
  v_rk  text;
  v     record;
  v_dup record;
  v_ovr bigint;
  v_sub text[] := engagement_submission_stages();
  v_act text;
  v_who text;
begin
  select j.title, j.department, j.company_id into v_job from jobs j where j.id = new.job_id;
  v_rk := app_role_key(v_job.title, v_job.department);

  if app_role() = 'recruiter'
     and (tg_op = 'INSERT'
          or (new.stage = any(v_sub) and not (old.stage = any(v_sub)))) then
    v_act := case when tg_op = 'INSERT' then 'add_to_job' else 'submission' end;
    select * into v from can_engage(new.candidate_id, new.job_id, null);
    if v.decision = 'blocked' then
      raise exception '%', engagement_block_message(v.reason, v.holder_name, v.job_title,
                             v.role_key, v.status_label, v.hold_expires_at)
        using errcode = 'TLB01',
              detail = (engagement_block_detail(v.decision, v.reason, v.holder_recruiter_id,
                         v.holder_name, v.role_key, v.job_title, v.status_label,
                         v.hold_expires_at)::jsonb
                        || jsonb_build_object('candidateId', new.candidate_id))::text;
    end if;
    if v.reason = 'override' then
      update engagement_overrides set used_at = coalesce(used_at, now()) where id = v.override_id;
      perform engagement_audit_write(new.candidate_id, v_rk, new.job_id, 'override_used',
        jsonb_build_object('action', v_act, 'overrideId', v.override_id));
    end if;
  end if;

  if new.stage = any(v_sub)
     and (tg_op = 'INSERT' or not (old.stage = any(v_sub))) then

    select a2.id, a2.job_id, r.name as rname
      into v_dup
      from applications a2
      join jobs j2 on j2.id = a2.job_id
      left join recruiters r on r.id = coalesce(a2.recruiter_id, j2.recruiter_id)
     where a2.candidate_id = new.candidate_id
       and a2.id is distinct from new.id
       and v_job.company_id is not null
       and j2.company_id = v_job.company_id
       and app_role_key(j2.title, j2.department) = v_rk
       and (a2.stage = any(v_sub)
            or exists (select 1 from application_stage_history h
                        where h.application_id = a2.id and h.to_stage = any(v_sub)))
     limit 1;

    if found then
      select o.id into v_ovr from engagement_overrides o
       where o.kind = 'duplicate_submission' and o.status = 'approved'
         and o.candidate_id = new.candidate_id
         and (o.job_id = new.job_id or (o.job_id is null and o.role_key = v_rk))
         and o.used_at is null
       order by o.decided_at desc limit 1;
      if v_ovr is null then
        v_who := case when engagement_holder_visible(v_dup.rname) then v_dup.rname else null end;
        raise exception '%', format(
            'This candidate was already submitted to this client for %s by %s. A second submission needs an administrator''s override.',
            case when v_who is null then 'this role' else coalesce(v_job.title, 'this role') end,
            coalesce(v_who, 'another recruiter'))
          using errcode = 'TLD01',
                detail = json_build_object('reason', 'duplicate_submission',
                           'firstRecruiter', v_who, 'roleKey', case when v_who is null then null else v_rk end,
                           'jobTitle', case when v_who is null then null else v_job.title end,
                           'candidateId', new.candidate_id)::text;
      end if;
      update engagement_overrides set used_at = now() where id = v_ovr;
      perform engagement_audit_write(new.candidate_id, v_rk, new.job_id, 'override_used',
        jsonb_build_object('action', 'duplicate_submission', 'overrideId', v_ovr,
                           'firstApplication', v_dup.id));
    end if;
  end if;

  return new;
end $$;

/* The activity panel: only engagements the caller may see. */
create or replace function candidate_engagements(p_candidate_id text, p_job_id text default null)
returns table (
  recruiter_id text, recruiter_name text, is_me boolean,
  job_title text, role_key text, same_job boolean, same_role boolean,
  last_contact_at timestamptz, last_channel text, last_outcome text,
  level text, status text, status_label text,
  is_holder boolean, is_active boolean, hold_expires_at timestamptz
)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_rk text;
  v_visible boolean;
begin
  if app_role() not in ('recruiter', 'bde', 'admin') then
    raise exception 'staff only' using errcode = '42501';
  end if;
  select app_is_admin() or (
           app_role() = 'bde' and (not coalesce(c.is_private, false)
                                   or app_candidate_at_company(c.id, app_bde_company())))
         or (app_role() = 'recruiter' and (not coalesce(c.is_private, false)
                                          or app_recruiter_in_scope(c.owner_recruiter_id)
                                          or app_candidate_is_mine(c.id)))
    into v_visible
    from candidates c where c.id = p_candidate_id;
  if not coalesce(v_visible, false) then return; end if;

  if p_job_id is not null then
    select app_role_key(j.title, j.department) into v_rk from jobs j where j.id = p_job_id;
  end if;

  return query
    with rows as (select * from engagement_rows(array[p_candidate_id])),
         holders as (
           select distinct on (x.role_key) x.role_key, x.recruiter_id
             from rows x
            where x.active and x.level in ('contacted', 'in_process', 'joined')
            order by x.role_key, (x.level = 'joined') desc, x.last_at desc
         ),
         joined as (
           select x.recruiter_id from rows x
            where x.level = 'joined' and x.active
            order by x.joined_at desc limit 1
         )
    select e.recruiter_id, r.name, e.recruiter_id is not distinct from app_recruiter_id(),
           e.job_title, e.role_key,
           (p_job_id is not null and e.job_id = p_job_id),
           (v_rk is not null and e.role_key = v_rk),
           e.last_at, e.last_channel, e.last_outcome,
           e.level, e.status, e.status_label,
           coalesce((select true from joined jj where jj.recruiter_id = e.recruiter_id), false)
             or exists (select 1 from holders hh where hh.role_key = e.role_key
                           and hh.recruiter_id = e.recruiter_id
                           and not exists (select 1 from joined)),
           e.active, e.expires_at
      from rows e
      left join recruiters r on r.id = e.recruiter_id
     where app_recruiter_in_scope(e.recruiter_id)
     order by e.active desc, e.last_at desc;
end $$;

/* Badges: only about engagements the caller may see, so for a plain
   recruiter nothing a colleague did. */
create or replace function engagement_badges(p_ids text[], p_job_id text default null)
returns table (
  candidate_id text, kind text, role_key text, job_title text, recruiter_name text,
  status_label text, last_at timestamptz, hold_expires_at timestamptz,
  others jsonb
)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare v_rk text; v_me text := app_recruiter_id();
begin
  if app_role() not in ('recruiter', 'bde', 'admin') then
    raise exception 'staff only' using errcode = '42501';
  end if;
  if p_job_id is not null then
    select app_role_key(j.title, j.department) into v_rk from jobs j where j.id = p_job_id;
  end if;

  return query
    with vis as (
      select c.id from candidates c
       where c.id = any(p_ids[1:500])
         and (app_is_admin()
              or (app_role() = 'bde' and (not coalesce(c.is_private, false)
                                          or app_candidate_at_company(c.id, app_bde_company())))
              or (app_role() = 'recruiter' and (not coalesce(c.is_private, false)
                                               or app_recruiter_in_scope(c.owner_recruiter_id)
                                               or app_candidate_is_mine(c.id))))
    ),
    rows as (
      select e.*, r.name as rname
        from engagement_rows(array(select id from vis)) e
        left join recruiters r on r.id = e.recruiter_id
       where e.recruiter_id is distinct from v_me
         and app_recruiter_in_scope(e.recruiter_id)
    ),
    pick as (
      select distinct on (x.candidate_id) x.*,
             case when x.level = 'joined' then 'joined'
                  when x.level = 'in_process' then 'in_process'
                  else 'contacted' end as k
        from rows x
       where x.active and x.level in ('joined', 'in_process', 'contacted')
         and (x.level = 'joined' or v_rk is null or x.role_key = v_rk)
       order by x.candidate_id,
                (x.level = 'joined') desc, (x.level = 'in_process') desc, x.last_at desc
    ),
    other as (
      select x.candidate_id,
             jsonb_agg(jsonb_build_object(
               'role', coalesce(x.job_title, x.role_key), 'roleKey', x.role_key,
               'recruiter', x.rname, 'level', x.level, 'at', x.last_at)
               order by x.last_at desc) as others
        from rows x
       group by x.candidate_id
    )
    select v.id,
           coalesce(p.k, case when o.others is not null then 'other_roles' end),
           p.role_key, p.job_title, p.rname, p.status_label, p.last_at, p.expires_at,
           coalesce(o.others, '[]'::jsonb)
      from vis v
      left join pick p on p.candidate_id = v.id
      left join other o on o.candidate_id = v.id;
end $$;

-- =====================================================================
-- 7. the administrator's side: role + department
-- =====================================================================
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'staff_audit_action_check') then
    alter table staff_audit drop constraint staff_audit_action_check;
  end if;
  alter table staff_audit add constraint staff_audit_action_check
    check (action in ('client_login_created', 'recruiter_scope_set'));
end $$;

create or replace function staff_recruiter_scope_set(
  p_recruiter text, p_department text, p_team_lead boolean)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_user uuid; v_name text; v_before jsonb;
begin
  if not app_is_admin() then
    raise exception 'only an administrator may set a role or department' using errcode = '42501';
  end if;
  select user_id into v_user from recruiters where id = p_recruiter;
  if v_user is null then raise exception 'that recruiter has no login account'; end if;
  p_department := nullif(btrim(coalesce(p_department, '')), '');
  if p_department is not null then
    select name into v_name from departments where id = p_department;
    if v_name is null then raise exception '"%" is not a department', p_department; end if;
  end if;
  if coalesce(p_team_lead, false) and p_department is null then
    raise exception 'a team lead needs a department';
  end if;
  select jsonb_build_object('departmentId', department_id, 'teamLead', is_team_lead)
    into v_before from users where id = v_user;
  update users set department_id = p_department, is_team_lead = coalesce(p_team_lead, false),
                   updated_at = now()
   where id = v_user;
  update recruiters set department = v_name,
         recruiter_role = case when coalesce(p_team_lead, false) then 'Team Lead' else 'Recruiter' end,
         updated_at = now()
   where id = p_recruiter;
  insert into staff_audit (actor_id, action, target_kind, target_id, detail)
  values (app_user_id()::text, 'recruiter_scope_set', 'recruiter', p_recruiter,
          jsonb_build_object('before', v_before, 'departmentId', p_department,
                             'teamLead', coalesce(p_team_lead, false)));
  return jsonb_build_object('id', p_recruiter, 'departmentId', p_department,
                            'department', v_name, 'teamLead', coalesce(p_team_lead, false));
end $$;

/** The scope of a signed-in user, for the session. Keyed on a verified users.id. */
create or replace function auth_user_scope(p_user uuid)
returns table (department_id text, department_name text, is_team_lead boolean)
language sql stable security definer set search_path = public as $$
  select u.department_id, d.name, (u.is_team_lead and u.role = 'recruiter' and u.department_id is not null)
    from users u left join departments d on d.id = u.department_id
   where u.id = p_user
$$;

-- =====================================================================
-- 8. grants
-- =====================================================================
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant select on departments to app_api;
    grant select, insert, update, delete on talent_pool to app_api;
    grant usage, select on sequence talent_pool_id_seq to app_api;
    grant execute on function
      app_department_id(), app_is_team_lead(), app_scope_role(),
      recruiter_department(text), app_recruiter_in_scope(text), app_user_in_scope(uuid),
      app_recruiter_same_department(text), app_row_in_scope(text, text), app_job_in_scope(text),
      talent_pool_link(text, text, text, text), talent_pool_link_many(text[], text),
      candidate_find_by_contact(text, text), candidate_last_contacted_at(text),
      recruiter_outreach_stats(), engagement_holder_visible(text),
      staff_recruiter_scope_set(text, text, boolean), auth_user_scope(uuid)
      to app_api;
  end if;
end $$;

comment on table talent_pool is
  'One row per (candidate, recruiter): the recruiter-specific layer - notes, tags, how and when they were saved. Candidates are shared; this is not. 0117.';
comment on column users.is_team_lead is
  'A team lead is a recruiter login (role stays recruiter) with this flag and a department; the session derives it, the client never says. 0117.';
