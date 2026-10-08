-- ---------------------------------------------------------------------
-- 0118 — Team Leads, who sees whose work, and one cooldown on contact
--
-- THREE THINGS, ONE MIGRATION, BECAUSE EACH NEEDS THE OTHERS.
--
-- 1. TEAMS. A recruiter belongs to at most one Team Lead (TL) and one
--    department at a time. The current assignment is the one row of
--    recruiter_assignment_history with ended_at null; every earlier row
--    stays, so "who was on whose team in March" can still be answered.
--    Moving or removing a recruiter ends a row and may start another. It
--    never touches a job, an application, a candidate or a contact.
--
--    A TL is a recruiter with is_team_lead = true. The portal already had
--    the idea (recruiters.recruiter_role carries free text such as "Team
--    Lead") and every recruiter route, policy and session already works
--    for a recruiter, so a second login role would only fork them. The
--    flag is the one thing a TL adds.
--
-- 2. WHO SEES WHAT. Before this, any recruiter could read every open job
--    on the board and every interview, offer and AI interview of the
--    company they work for. Now:
--
--        recruiter  their own jobs, and the applications on them
--        TL         their own, and those of the recruiters assigned to
--                   them today
--        admin      everything
--
--    in the policies themselves, so a direct request for another team's
--    record finds nothing and no list, count or export can carry it. The
--    candidate-facing board is untouched: candidates and anonymous
--    visitors still read open jobs.
--
-- 3. ONE COOLDOWN ON CONTACT. The 0091 holds are per role and last 30
--    days. This adds the rule recruiters actually run into: a candidate
--    somebody else contacted in the last N days (default 7, an admin
--    setting) is not contacted again by a different person, on any
--    channel, for any job. The same person may always follow up. An
--    admin or a TL may override with a written reason. The check and the
--    log row are one transaction behind a per-candidate lock, so two
--    people clicking at once cannot both get through.
--
--    It extends candidate_contact_history; nothing parallel is created.
--
-- Nothing is deleted or rewritten except the policies named below, the
-- flag backfill, and the status function, which now also audits.
-- ---------------------------------------------------------------------

-- =====================================================================
-- 1. teams
-- =====================================================================

alter table recruiters add column if not exists is_team_lead boolean not null default false;

/* The recruiters the portal already calls Team Lead, by the free text it
   already holds. Only ever sets the flag; an admin can clear it. */
update recruiters
   set is_team_lead = true
 where not is_team_lead
   and recruiter_role ~* '^\s*(team\s*lead(er)?|tl)\s*$';

create index if not exists recruiters_team_lead_idx on recruiters (is_team_lead) where is_team_lead;

create table if not exists recruiter_assignment_history (
  id           bigserial primary key,
  recruiter_id text not null references recruiters(id),
  tl_id        text not null references recruiters(id),
  department   text,
  started_at   timestamptz not null default now(),
  ended_at     timestamptz,
  end_reason   text check (end_reason in ('reassigned', 'unassigned')),
  assigned_by  uuid references users(id),
  ended_by     uuid references users(id),
  created_at   timestamptz not null default now(),
  check (tl_id <> recruiter_id),
  check (ended_at is null or ended_at >= started_at)
);
/* Exactly one current assignment per recruiter. */
create unique index if not exists rah_one_current on recruiter_assignment_history (recruiter_id) where ended_at is null;
create index if not exists rah_recruiter   on recruiter_assignment_history (recruiter_id, started_at desc);
create index if not exists rah_tl_current  on recruiter_assignment_history (tl_id) where ended_at is null;
create index if not exists rah_department  on recruiter_assignment_history (department);

/* Not FORCE (the audit_log convention): the definer functions below, run
   as the owner, are the only writers. */
alter table recruiter_assignment_history enable row level security;
drop policy if exists rah_read on recruiter_assignment_history;
create policy rah_read on recruiter_assignment_history for select using (
  app_is_admin()
  or (app_role() = 'recruiter' and (
        recruiter_id = app_recruiter_id() or tl_id = app_recruiter_id()))
);

-- =====================================================================
-- 2. scope helpers (SECURITY DEFINER: the policies below call them to
--    read tables those same policies govern, which would recurse)
-- =====================================================================

create or replace function app_is_tl() returns boolean
language sql stable security definer set search_path = public as $$
  select app_role() = 'recruiter'
     and exists (select 1 from recruiters r
                  where r.user_id = app_user_id() and r.is_team_lead)
$$;

/* The recruiters assigned to the caller today (a TL), never the caller. */
create or replace function app_team_recruiter_ids() returns setof text
language sql stable security definer set search_path = public as $$
  select h.recruiter_id
    from recruiter_assignment_history h
   where h.ended_at is null
     and app_is_tl()
     and h.tl_id = app_recruiter_id()
$$;

/* May the caller see work owned by this recruiter? Admin: all. Anyone
   else: their own, and (a TL) their current team's. */
create or replace function app_recruiter_in_scope(p_recruiter_id text) returns boolean
language sql stable security definer set search_path = public as $$
  select app_is_admin()
      or (p_recruiter_id is not null and app_role() = 'recruiter' and (
            p_recruiter_id = app_recruiter_id()
            or exists (select 1 from recruiter_assignment_history h
                        where h.ended_at is null
                          and h.recruiter_id = p_recruiter_id
                          and h.tl_id = app_recruiter_id()
                          and app_is_tl())))
$$;

create or replace function app_job_in_scope(p_job_id text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from jobs j
                  where j.id = p_job_id and app_recruiter_in_scope(j.recruiter_id))
$$;

/* Does the row exist at all, whoever may read it? The API uses this to
   answer 403 (it exists, it is not yours) instead of 404 for staff. It
   returns a yes or a no, never the row. */
create or replace function app_row_exists(p_kind text, p_id text) returns boolean
language plpgsql stable security definer set search_path = public as $$
begin
  if app_role() not in ('recruiter', 'bde', 'admin') then
    return false;
  end if;
  return case p_kind
    when 'job'         then exists (select 1 from jobs         where id = p_id)
    when 'application' then exists (select 1 from applications where id = p_id)
    when 'recruiter'   then exists (select 1 from recruiters   where id = p_id)
    when 'candidate'   then exists (select 1 from candidates   where id = p_id)
    else false end;
end $$;

-- =====================================================================
-- 3. the policies
-- =====================================================================

/* jobs: the public board stays public for everyone who is not a
   recruiter. A recruiter reads their own and (a TL) their team's. */
drop policy if exists jobs_public_read on jobs;
create policy jobs_public_read on jobs for select using (
  (status = 'open' and not paused and not archived
     and (expires_at is null or expires_at > now())
     and app_role() <> 'recruiter')
  or app_is_admin()
  or (app_role() = 'recruiter' and app_recruiter_in_scope(recruiter_id))
  or (app_role() = 'client'    and company_id = app_client_company())
);

/* A recruiter posts as themselves, never as somebody else or nobody. */
drop policy if exists jobs_recruiter_insert on jobs;
create policy jobs_recruiter_insert on jobs for insert with check (
  app_is_admin()
  or (app_role() = 'recruiter' and recruiter_id = app_recruiter_id())
);

/* applications: inherit through the job. The recruiter an application is
   assigned to still reads it, as before. */
drop policy if exists applications_read on applications;
create policy applications_read on applications for select using (
  app_is_admin()
  or candidate_id = app_candidate_id()
  or (app_role() = 'recruiter' and (
        app_recruiter_in_scope(recruiter_id)
        or app_job_in_scope(applications.job_id)))
  or (app_role() = 'client' and stage = any (app_client_visible_stages()) and exists (
        select 1 from jobs j where j.id = applications.job_id
          and j.company_id = app_client_company()))
);

/* interviews, offers, AI interviews: by who owns the job, not by which
   company the viewer works for. */
drop policy if exists interviews_read on interviews;
create policy interviews_read on interviews for select using (
  app_is_admin()
  or candidate_id = app_candidate_id()
  or (app_role() = 'recruiter' and app_job_in_scope(interviews.job_id))
  or (app_role() = 'client' and exists (
        select 1 from jobs j where j.id = interviews.job_id
          and j.company_id = app_client_company()))
);
drop policy if exists interviews_write on interviews;
create policy interviews_write on interviews for all
  using (
    app_is_admin()
    or (app_role() = 'recruiter' and exists (
          select 1 from jobs j where j.id = interviews.job_id
            and j.recruiter_id is not distinct from app_recruiter_id()))
    or (app_role() = 'client' and exists (
          select 1 from jobs j where j.id = interviews.job_id
            and j.company_id = app_client_company()))
  )
  with check (
    app_is_admin()
    or (app_role() = 'recruiter' and exists (
          select 1 from jobs j where j.id = interviews.job_id
            and j.recruiter_id is not distinct from app_recruiter_id()))
    or (app_role() = 'client' and exists (
          select 1 from jobs j where j.id = interviews.job_id
            and j.company_id = app_client_company()))
  );

drop policy if exists offers_read on offers;
create policy offers_read on offers for select using (
  app_is_admin()
  or candidate_id = app_candidate_id()
  or (app_role() = 'recruiter' and app_job_in_scope(offers.job_id))
  or (app_role() = 'client' and exists (
        select 1 from jobs j where j.id = offers.job_id
          and j.company_id = app_client_company()))
);
drop policy if exists offers_write on offers;
create policy offers_write on offers for all
  using (
    app_is_admin()
    or (app_role() = 'recruiter' and exists (
          select 1 from jobs j where j.id = offers.job_id
            and j.recruiter_id is not distinct from app_recruiter_id()))
  )
  with check (
    app_is_admin()
    or (app_role() = 'recruiter' and exists (
          select 1 from jobs j where j.id = offers.job_id
            and j.recruiter_id is not distinct from app_recruiter_id()))
  );

drop policy if exists ai_interviews_read on ai_interviews;
create policy ai_interviews_read on ai_interviews for select using (
  app_is_admin()
  or candidate_id = app_candidate_id()
  or (app_role() = 'recruiter' and app_job_in_scope(ai_interviews.job_id))
  or (app_role() = 'client' and exists (
        select 1 from jobs j where j.id = ai_interviews.job_id
          and j.company_id = app_client_company()))
);
drop policy if exists ai_interviews_write on ai_interviews;
create policy ai_interviews_write on ai_interviews for all
  using (
    app_is_admin()
    or (app_role() = 'recruiter' and exists (
          select 1 from jobs j where j.id = ai_interviews.job_id
            and j.recruiter_id is not distinct from app_recruiter_id()))
  )
  with check (
    app_is_admin()
    or (app_role() = 'recruiter' and exists (
          select 1 from jobs j where j.id = ai_interviews.job_id
            and j.recruiter_id is not distinct from app_recruiter_id()))
  );

/* The timeline of an application is as visible as the application. */
drop policy if exists application_events_read on application_events;
create policy application_events_read on application_events for select using (
  app_is_admin()
  or candidate_id = app_candidate_id()
  or app_role() in ('bde', 'client')
  or (app_role() = 'recruiter' and exists (
        select 1 from applications a where a.id = application_events.application_id))
);

/* AI calls: the sessions of the caller's own work (turns follow their
   session). The events log and the campaigns follow the same rule. */
drop policy if exists ai_call_sessions_read on ai_call_sessions;
create policy ai_call_sessions_read on ai_call_sessions for select using (
  app_is_admin()
  or candidate_id = app_candidate_id()
  or app_role() in ('bde', 'client')
  or (app_role() = 'recruiter' and (
        app_recruiter_in_scope(recruiter_id)
        or (job_id is not null and app_job_in_scope(job_id))))
);
drop policy if exists ai_call_events_read on ai_call_events;
create policy ai_call_events_read on ai_call_events for select using (
  app_is_admin() or app_role() = 'bde'
  or (app_role() = 'recruiter' and exists (
        select 1 from ai_call_sessions s where s.id = ai_call_events.session_id))
);
drop policy if exists ai_call_campaigns_read on ai_call_campaigns;
create policy ai_call_campaigns_read on ai_call_campaigns for select using (
  app_is_admin() or app_role() in ('bde', 'client')
  or (app_role() = 'recruiter' and (
        app_recruiter_in_scope(recruiter_id) or app_job_in_scope(job_id)))
);

drop policy if exists job_view_daily_read on job_view_daily;
create policy job_view_daily_read on job_view_daily for select using (
  app_is_admin() or (app_role() = 'recruiter' and app_job_in_scope(job_view_daily.job_id))
);

/* The contact history: a TL reads their team's rows too. */
drop policy if exists cch_read on candidate_contact_history;
create policy cch_read on candidate_contact_history for select using (
  app_is_admin()
  or candidate_id = app_candidate_id()
  or app_role() = 'bde'
  or (app_role() = 'recruiter' and (
        recruiter_id = app_recruiter_id()
        or contacted_by = app_user_id()
        or app_recruiter_in_scope(recruiter_id)
        or (job_id is not null and app_job_in_scope(job_id))))
);

-- =====================================================================
-- 4. who did what: the audit trail
-- =====================================================================
/* audit_log (0111) already exists, is append-only for everyone but the
   definer functions, and is read by admins. The actions added here:
     RECRUITER_ASSIGNED, RECRUITER_REASSIGNED, RECRUITER_UNASSIGNED,
     RECRUITER_DEPARTMENT_CHANGED, RECRUITER_EMAIL_CHANGED,
     RECRUITER_STATUS_CHANGED, TL_ROLE_CHANGED, CONTACT_COOLDOWN_OVERRIDDEN,
     CONTACT_COOLDOWN_CHANGED
   Each detail carries the old and the new value and the reason, where
   there is one. */

create or replace function staff_actor_name() returns text
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select name from admins     where user_id = app_user_id_safe()),
    (select name from recruiters where user_id = app_user_id_safe()),
    'Staff')
$$;

-- =====================================================================
-- 5. managing teams (admin only)
-- =====================================================================

create or replace function staff_set_team_lead(p_recruiter_id text, p_on boolean)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare r recruiters;
begin
  if not app_is_admin() then
    raise exception 'only an administrator may change a team lead' using errcode = '42501';
  end if;
  select * into r from recruiters where id = p_recruiter_id for update;
  if not found then raise exception 'unknown recruiter' using errcode = 'P0002'; end if;
  if r.is_team_lead = p_on then
    return jsonb_build_object('id', r.id, 'isTeamLead', r.is_team_lead);
  end if;
  if p_on and exists (select 1 from recruiter_assignment_history
                       where recruiter_id = r.id and ended_at is null) then
    raise exception 'remove this recruiter from their team lead first' using errcode = 'TLA03';
  end if;
  if not p_on and exists (select 1 from recruiter_assignment_history
                           where tl_id = r.id and ended_at is null) then
    raise exception 'reassign this team lead''s recruiters first' using errcode = 'TLA03';
  end if;
  update recruiters set is_team_lead = p_on, updated_at = now() where id = r.id;
  perform audit_write('TL_ROLE_CHANGED', 'recruiter', r.id,
    jsonb_build_object('recruiterId', r.id, 'name', r.name,
                       'old', r.is_team_lead, 'new', p_on, 'by', staff_actor_name()));
  return jsonb_build_object('id', r.id, 'isTeamLead', p_on);
end $$;

create or replace function staff_assign_recruiter(
  p_recruiter_id text, p_tl_id text, p_department text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r recruiters; t recruiters; cur recruiter_assignment_history;
  v_dept text; v_id bigint; v_action text;
begin
  if not app_is_admin() then
    raise exception 'only an administrator may assign a recruiter' using errcode = '42501';
  end if;
  select * into r from recruiters where id = p_recruiter_id for update;
  if not found then raise exception 'unknown recruiter' using errcode = 'P0002'; end if;
  select * into t from recruiters where id = p_tl_id;
  if not found or not t.is_team_lead then
    raise exception 'that person is not a team lead' using errcode = 'TLA04';
  end if;
  if r.id = t.id then raise exception 'a team lead cannot be assigned to themselves' using errcode = 'TLA04'; end if;
  if r.is_team_lead then
    raise exception 'a team lead cannot be assigned under another team lead' using errcode = 'TLA04';
  end if;
  if not exists (select 1 from users where id = r.user_id and status = 'active') then
    raise exception 'an inactive recruiter cannot be assigned' using errcode = 'TLA01';
  end if;
  if not exists (select 1 from users where id = t.user_id and status = 'active') then
    raise exception 'that team lead is not active' using errcode = 'TLA01';
  end if;

  v_dept := coalesce(nullif(btrim(p_department), ''), nullif(btrim(t.department), ''));
  if v_dept is null then
    raise exception 'a department is required' using errcode = 'TLA02';
  end if;
  if nullif(btrim(t.department), '') is not null and lower(btrim(t.department)) <> lower(v_dept) then
    raise exception 'the department must be the team lead''s (%)', t.department using errcode = 'TLA02';
  end if;

  select * into cur from recruiter_assignment_history
   where recruiter_id = r.id and ended_at is null for update;
  if found and cur.tl_id = t.id and lower(coalesce(cur.department, '')) = lower(v_dept) then
    return jsonb_build_object('recruiterId', r.id, 'tlId', t.id, 'department', cur.department, 'changed', false);
  end if;

  if found then
    update recruiter_assignment_history
       set ended_at = now(), end_reason = 'reassigned', ended_by = app_user_id_safe()
     where id = cur.id;
  end if;
  insert into recruiter_assignment_history (recruiter_id, tl_id, department, assigned_by)
  values (r.id, t.id, v_dept, app_user_id_safe())
  returning id into v_id;

  update recruiters set department = v_dept, updated_at = now() where id = r.id;

  v_action := case when cur.id is null then 'RECRUITER_ASSIGNED' else 'RECRUITER_REASSIGNED' end;
  perform audit_write(v_action, 'recruiter', r.id,
    jsonb_build_object('recruiterId', r.id, 'name', r.name,
      'oldTlId', cur.tl_id, 'newTlId', t.id,
      'oldDepartment', cur.department, 'newDepartment', v_dept,
      'historyId', v_id, 'by', staff_actor_name()));
  if cur.id is not null and lower(coalesce(cur.department, '')) <> lower(v_dept) then
    perform audit_write('RECRUITER_DEPARTMENT_CHANGED', 'recruiter', r.id,
      jsonb_build_object('recruiterId', r.id, 'old', cur.department, 'new', v_dept, 'by', staff_actor_name()));
  end if;
  return jsonb_build_object('recruiterId', r.id, 'tlId', t.id, 'department', v_dept,
                            'historyId', v_id, 'changed', true);
end $$;

create or replace function staff_unassign_recruiter(p_recruiter_id text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare cur recruiter_assignment_history;
begin
  if not app_is_admin() then
    raise exception 'only an administrator may remove an assignment' using errcode = '42501';
  end if;
  select * into cur from recruiter_assignment_history
   where recruiter_id = p_recruiter_id and ended_at is null for update;
  if not found then
    return jsonb_build_object('recruiterId', p_recruiter_id, 'changed', false);
  end if;
  update recruiter_assignment_history
     set ended_at = now(), end_reason = 'unassigned', ended_by = app_user_id_safe()
   where id = cur.id;
  perform audit_write('RECRUITER_UNASSIGNED', 'recruiter', p_recruiter_id,
    jsonb_build_object('recruiterId', p_recruiter_id, 'oldTlId', cur.tl_id,
                       'oldDepartment', cur.department, 'historyId', cur.id, 'by', staff_actor_name()));
  return jsonb_build_object('recruiterId', p_recruiter_id, 'changed', true);
end $$;

/* The department of a recruiter who is not on a team (a team member's
   department moves with their assignment). Also a TL's own. */
create or replace function staff_recruiter_set_department(p_recruiter_id text, p_department text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare r recruiters; v text := nullif(btrim(p_department), '');
begin
  if not app_is_admin() then
    raise exception 'only an administrator may change a department' using errcode = '42501';
  end if;
  select * into r from recruiters where id = p_recruiter_id for update;
  if not found then raise exception 'unknown recruiter' using errcode = 'P0002'; end if;
  if exists (select 1 from recruiter_assignment_history where recruiter_id = r.id and ended_at is null) then
    raise exception 'change a team member''s department by reassigning them' using errcode = 'TLA02';
  end if;
  if coalesce(r.department, '') = coalesce(v, '') then
    return jsonb_build_object('id', r.id, 'department', r.department, 'changed', false);
  end if;
  update recruiters set department = v, updated_at = now() where id = r.id;
  perform audit_write('RECRUITER_DEPARTMENT_CHANGED', 'recruiter', r.id,
    jsonb_build_object('recruiterId', r.id, 'old', r.department, 'new', v, 'by', staff_actor_name()));
  return jsonb_build_object('id', r.id, 'department', v, 'changed', true);
end $$;

/* The login email. One place, so the identity changes everywhere at once:
   the sign-in record, the recruiter record, sign-in sessions (the old
   address stops working at once, not at expiry), and password-reset links
   already sent to the old address. */
create or replace function staff_recruiter_email_change(p_recruiter_id text, p_email text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r recruiters; v_old text; v_new text := lower(btrim(coalesce(p_email, '')));
begin
  if not app_is_admin() then
    raise exception 'only an administrator may change a login email' using errcode = '42501';
  end if;
  if v_new !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' or length(v_new) > 254 then
    raise exception 'that is not a valid email address' using errcode = '22023';
  end if;
  select * into r from recruiters where id = p_recruiter_id for update;
  if not found then raise exception 'unknown recruiter' using errcode = 'P0002'; end if;
  if r.user_id is null then raise exception 'that recruiter has no login account' using errcode = '22023'; end if;
  select email into v_old from users where id = r.user_id for update;
  if lower(v_old) = v_new then
    return jsonb_build_object('id', r.id, 'email', v_old, 'changed', false);
  end if;
  if exists (select 1 from users where lower(email) = v_new and id <> r.user_id)
     or exists (select 1 from bde_users where lower(email) = v_new)
     or exists (select 1 from recruiters where lower(email) = v_new and id <> r.id)
     or exists (select 1 from client_users where lower(email) = v_new)
     or exists (select 1 from admins where lower(email) = v_new) then
    raise exception 'that address already belongs to another account' using errcode = '23505';
  end if;

  update users set email = v_new, updated_at = now() where id = r.user_id;
  update recruiters set email = v_new, updated_at = now() where id = r.id;
  delete from sessions where user_id = r.user_id;
  update password_resets set used_at = now() where user_id = r.user_id and used_at is null;

  perform audit_write('RECRUITER_EMAIL_CHANGED', 'recruiter', r.id,
    jsonb_build_object('recruiterId', r.id, 'name', r.name,
                       'oldEmail', v_old, 'newEmail', v_new, 'by', staff_actor_name()));
  return jsonb_build_object('id', r.id, 'email', v_new, 'changed', true);
end $$;

/* Turn a login on or off. Redefined (0035) to leave a trail and to end the
   sessions when it is turned off, so reactivating the account later does
   not bring an old session back to life. */
create or replace function staff_recruiter_status(p_id text, p_active boolean)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_user uuid; v_old text;
begin
  if not app_is_admin() then
    raise exception 'only an administrator may change a login' using errcode = '42501';
  end if;
  select user_id into v_user from recruiters where id = p_id;
  if v_user is null then
    raise exception 'that recruiter has no login account';
  end if;
  select status into v_old from users where id = v_user for update;
  update users set status = case when p_active then 'active' else 'suspended' end,
                   updated_at = now()
   where id = v_user;
  if not p_active then
    delete from sessions where user_id = v_user;
  end if;
  if (v_old = 'active') is distinct from p_active then
    perform audit_write('RECRUITER_STATUS_CHANGED', 'recruiter', p_id,
      jsonb_build_object('recruiterId', p_id,
        'old', case when v_old = 'active' then 'active' else 'inactive' end,
        'new', case when p_active then 'active' else 'inactive' end,
        'by', staff_actor_name()));
  end if;
  return jsonb_build_object('id', p_id, 'status', case when p_active then 'active' else 'inactive' end);
end $$;

-- =====================================================================
-- 6. the contact cooldown
-- =====================================================================

alter table candidate_contact_history
  add column if not exists override_used   boolean not null default false,
  add column if not exists override_by     uuid references users(id),
  add column if not exists override_reason text;

create index if not exists cch_by_channel   on candidate_contact_history (channel);
create index if not exists cch_by_when      on candidate_contact_history (created_at);
create index if not exists cch_by_actor     on candidate_contact_history (contacted_by, created_at desc);
create index if not exists cch_cooldown     on candidate_contact_history (candidate_id, created_at desc)
  where direction = 'out';

/* The setting. An admin changes it; changing it moves future checks only,
   because every check is made against the row's own timestamp. */
insert into app_settings (key, value)
values ('contact_cooldown', '{"days": 7}'::jsonb)
on conflict (key) do nothing;

create or replace function contact_cooldown_days() returns int
language sql stable security definer set search_path = public as $$
  select greatest(1, least(90, coalesce(
    (select nullif(value->>'days', '')::int from app_settings where key = 'contact_cooldown'), 7)))
$$;

create or replace function staff_set_contact_cooldown(p_days int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_old int;
begin
  if not app_is_admin() then
    raise exception 'only an administrator may change the cooldown' using errcode = '42501';
  end if;
  if p_days is null or p_days < 1 or p_days > 90 then
    raise exception 'the cooldown is between 1 and 90 days' using errcode = '22023';
  end if;
  v_old := contact_cooldown_days();
  insert into app_settings (key, value, updated_at)
  values ('contact_cooldown', jsonb_build_object('days', p_days), now())
  on conflict (key) do update set value = excluded.value, updated_at = now();
  if v_old <> p_days then
    perform audit_write('CONTACT_COOLDOWN_CHANGED', 'setting', 'contact_cooldown',
      jsonb_build_object('old', v_old, 'new', p_days, 'by', staff_actor_name()));
  end if;
  return jsonb_build_object('days', p_days);
end $$;

/* May the caller see this candidate at all? The same rule as the shared
   pool: non-private, or theirs. (Contact is not a way round privacy.) */
create or replace function app_candidate_contactable(p_candidate_id text) returns boolean
language sql stable security definer set search_path = public as $$
  select app_is_admin() or exists (
    select 1 from candidates c
     where c.id = p_candidate_id
       and (not coalesce(c.is_private, false)
            or c.owner_recruiter_id is not distinct from app_recruiter_id()
            or app_candidate_is_mine(c.id)))
$$;

/* Who holds this candidate now: the LATEST contact inside the cooldown,
   if somebody else made it. The caller's own latest contact never holds
   them back (a follow-up is always allowed), and neither does a contact
   that failed to go out. After an admin's or a TL's override the
   overrider's row is the latest, so they can carry on without overriding
   every message. */
create or replace function contact_holder(p_candidate_id text)
returns table (id bigint, holder_name text, channel text, contacted_at timestamptz, expires_at timestamptz)
language sql stable security definer set search_path = public as $$
  select l.id,
         coalesce((select name from recruiters where user_id = l.contacted_by),
                  (select name from admins     where user_id = l.contacted_by),
                  (select name from recruiters where id = l.recruiter_id),
                  'Another recruiter'),
         l.channel,
         l.created_at,
         l.created_at + make_interval(days => contact_cooldown_days())
    from (select h.*
            from candidate_contact_history h
           where h.candidate_id = p_candidate_id
             and h.direction = 'out'
             and cch_is_contact(h.source)
             and coalesce(h.outcome, '') <> 'failed'
             and h.created_at > now() - make_interval(days => contact_cooldown_days())
           order by h.created_at desc, h.id desc
           limit 1) l
   where l.contacted_by is distinct from app_user_id_safe()
     and (l.recruiter_id is null or l.recruiter_id is distinct from app_recruiter_id())
$$;

/* ONE CONTACT, CHECKED AND LOGGED TOGETHER.
 *
 * The lock is per candidate and held to the end of the transaction, so a
 * second caller waits here, then sees the first one's row and is refused.
 * The row goes in before anything is sent; contact_finish() records how
 * the send went. Returns { ok, id } or { ok:false, code, ... }.
 *
 *   NOT_VISIBLE  the candidate is not one the caller may contact
 *   COOLDOWN     somebody else contacted them inside the cooldown
 */
create or replace function contact_begin(
  p_candidate_id text,
  p_channel      text,
  p_job_id       text default null,
  p_source       text default 'contact',
  p_override     boolean default false,
  p_reason       text default null,
  p_detail       text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_chan   text := lower(btrim(coalesce(p_channel, '')));
  v_source text := coalesce(nullif(btrim(p_source), ''), v_chan);
  v_h      record;
  v_over   boolean := false;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_id     bigint;
  v_rk     text;
begin
  if app_role() not in ('recruiter', 'bde', 'admin') then
    raise exception 'staff only' using errcode = '42501';
  end if;
  if v_chan not in ('phone', 'whatsapp', 'email', 'sms', 'ai_call') then
    raise exception 'unknown contact channel' using errcode = '22023';
  end if;
  if not cch_is_contact(v_source) then
    v_source := v_chan;
  end if;
  if p_job_id is not null and not app_job_in_scope(p_job_id) and app_role() <> 'bde' then
    raise exception 'that job is not one of yours' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtext('contact:' || p_candidate_id));

  if not app_candidate_contactable(p_candidate_id) then
    return jsonb_build_object('ok', false, 'code', 'NOT_VISIBLE');
  end if;

  select * into v_h from contact_holder(p_candidate_id);
  if found then
    if p_override then
      if not (app_is_admin() or app_is_tl()) then
        raise exception 'only an administrator or a team lead may override the cooldown'
          using errcode = '42501';
      end if;
      if v_reason is null or length(v_reason) < 5 then
        raise exception 'a reason is required to override the cooldown' using errcode = 'TLC02';
      end if;
      v_over := true;
    else
      return jsonb_build_object('ok', false, 'code', 'COOLDOWN',
        'cooldownDays', contact_cooldown_days(),
        'holder', jsonb_build_object('name', v_h.holder_name, 'channel', v_h.channel,
                                     'contactedAt', v_h.contacted_at, 'expiresAt', v_h.expires_at));
    end if;
  end if;

  if p_job_id is not null then
    select app_role_key(j.title, j.department) into v_rk from jobs j where j.id = p_job_id;
  end if;

  insert into candidate_contact_history
    (candidate_id, job_id, channel, direction, outcome, detail, contacted_by,
     recruiter_id, role_key, source, override_used, override_by, override_reason)
  values (p_candidate_id, p_job_id, v_chan, 'out', 'queued', left(p_detail, 500),
          app_user_id_safe(), app_recruiter_id(), v_rk, v_source,
          v_over, case when v_over then app_user_id_safe() end, case when v_over then v_reason end)
  returning candidate_contact_history.id into v_id;

  if v_over then
    perform audit_write('CONTACT_COOLDOWN_OVERRIDDEN', 'candidate', p_candidate_id,
      jsonb_build_object('candidateId', p_candidate_id, 'channel', v_chan, 'jobId', p_job_id,
                         'reason', v_reason, 'contactId', v_id,
                         'previousContactId', v_h.id, 'previousBy', v_h.holder_name,
                         'by', staff_actor_name()));
  end if;
  return jsonb_build_object('ok', true, 'id', v_id, 'overridden', v_over);
end $$;

/* Many at once. Each candidate is judged on their own; one being held
   never stops the others. Locks are taken in id order so two bulk sends
   over the same people cannot wait on each other forever. */
create or replace function contact_begin_many(
  p_candidate_ids text[], p_channel text, p_job_id text default null,
  p_source text default 'bulk_message', p_override boolean default false, p_reason text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_id text; v_out jsonb := '[]'::jsonb; v_r jsonb;
begin
  if coalesce(array_length(p_candidate_ids, 1), 0) > 500 then
    raise exception 'at most 500 at a time' using errcode = '22023';
  end if;
  for v_id in select distinct x from unnest(p_candidate_ids) x order by x loop
    v_r := contact_begin(v_id, p_channel, p_job_id, p_source, p_override, p_reason, null);
    v_out := v_out || jsonb_build_array(v_r || jsonb_build_object('candidateId', v_id));
  end loop;
  return v_out;
end $$;

/* How the send went. Only the row's own writer may say. A contact that
   failed to go out stops holding anybody back. */
create or replace function contact_finish(p_id bigint, p_outcome text, p_ref text default null)
returns void
language sql security definer set search_path = public as $$
  update candidate_contact_history
     set outcome = coalesce(nullif(p_outcome, ''), outcome),
         ref_id  = coalesce(p_ref, ref_id)
   where id = p_id and contacted_by is not distinct from app_user_id_safe()
$$;

/* Who holds each of these people right now - for the "Already contacted"
   badge on a list. Staff only; only candidates the caller may see. */
create or replace function contact_cooldown_badges(p_candidate_ids text[])
returns table (candidate_id text, holder_name text, channel text,
               contacted_at timestamptz, expires_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if app_role() not in ('recruiter', 'bde', 'admin') then
    raise exception 'staff only' using errcode = '42501';
  end if;
  if coalesce(array_length(p_candidate_ids, 1), 0) > 500 then
    raise exception 'at most 500 at a time' using errcode = '22023';
  end if;
  return query
    select c.id, h.holder_name, h.channel, h.contacted_at, h.expires_at
      from (select distinct x as id from unnest(p_candidate_ids) x) c
      cross join lateral contact_holder(c.id) h
     where app_candidate_contactable(c.id);
end $$;

/* An AI call is logged by contact_begin first (so the cooldown held for
   it); the trigger that logs every session links that row to the session
   instead of writing a second one. */
create or replace function ai_call_engagement_log() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_rk text; v_open bigint;
begin
  select h.id into v_open
    from candidate_contact_history h
   where h.candidate_id = new.candidate_id
     and h.channel = 'ai_call'
     and h.ref_id is null
     and h.contacted_by is not distinct from app_user_id_safe()
     and h.created_at > now() - interval '2 minutes'
   order by h.created_at desc limit 1;
  if v_open is not null then
    update candidate_contact_history set ref_id = new.id where id = v_open;
    return new;
  end if;
  if new.job_id is not null then
    select app_role_key(j.title, j.department) into v_rk from jobs j where j.id = new.job_id;
  end if;
  insert into candidate_contact_history
    (candidate_id, job_id, channel, direction, outcome, ref_id, contacted_by,
     recruiter_id, role_key, source)
  values (new.candidate_id, new.job_id, 'ai_call', 'out', 'queued', new.id,
          app_user_id_safe(), coalesce(new.recruiter_id, app_recruiter_id()), v_rk, 'ai_call');
  return new;
end $$;

-- =====================================================================
-- grants
-- =====================================================================
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant execute on function
      app_is_tl(), app_team_recruiter_ids(), app_recruiter_in_scope(text),
      app_job_in_scope(text), app_row_exists(text, text), staff_actor_name(),
      staff_set_team_lead(text, boolean), staff_assign_recruiter(text, text, text),
      staff_unassign_recruiter(text), staff_recruiter_set_department(text, text),
      staff_recruiter_email_change(text, text), staff_recruiter_status(text, boolean),
      contact_cooldown_days(), staff_set_contact_cooldown(int),
      app_candidate_contactable(text), contact_holder(text),
      contact_begin(text, text, text, text, boolean, text, text),
      contact_begin_many(text[], text, text, text, boolean, text),
      contact_finish(bigint, text, text), contact_cooldown_badges(text[])
      to app_api;
    grant select on recruiter_assignment_history to app_api;
  end if;
end $$;
