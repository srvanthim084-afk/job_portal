-- ---------------------------------------------------------------------
-- 0091 — one shared candidate database, and "already contacted"
--
-- 0031 made the RECRUITER the boundary for everything: requirements,
-- applications AND candidates. For candidates that turned out to be the
-- wrong line. TeamLink is one consultancy with one pool of people; a
-- recruiter who cannot see that a nurse in Nellore is already on file
-- imports her again, calls her again, and - the expensive one - submits
-- her to the same client twice.
--
-- So from here:
--
--   candidates      SHARED. Every recruiter (and BDE, as before) reads
--                   every non-private candidate: profile, resume, skills,
--                   contact details. A private candidate is still seen
--                   only by the recruiter who owns them or whose
--                   requirement they applied to.
--   editing         UNCHANGED in effect: the owner, the recruiter whose
--                   requirement they applied to, the candidate, an admin.
--                   (see candidates_self_write below for the one branch
--                   that had to go to keep it that way.)
--   applications    UNCHANGED. Stages, screening, interviews, offers, AI
--                   scores and stage notes stay with the job's recruiter,
--                   the assigned recruiter and admin. This file does not
--                   touch a single applications policy.
--   notes           private by default, as before; a recruiter may now
--                   mark one "team" so colleagues can read it.
--
-- What one recruiter learns about another recruiter's work on a person
-- comes through ONE door, candidate_engagements(): who, which role, when,
-- on which channel, with what outcome, at which level. Never notes, never
-- message text, never scores, never anything about the client.
--
-- And the rule that makes sharing safe - two recruiters must not work the
-- same person for the same role - is decided here, by can_engage(), and
-- enforced here, by triggers on applications and ai_call_sessions, so a
-- route that forgets to ask is still refused:
--
--   another recruiter only CONTACTED them for this role   -> warn
--   another recruiter has them IN PROCESS for this role   -> block
--   they JOINED through TeamLink in the last 90 days      -> block for
--                                                            every role
--   a different role                                      -> allowed
--   the same client, the same role, a second submission   -> always
--                                                            blocked
--
-- A hold ends 30 days after the last activity, at once when the
-- engagement closes (rejected / not interested), and 90 days after a
-- joining. An administrator may override any block; the override needs a
-- reason and is written to engagement_audit.
-- ---------------------------------------------------------------------

-- =====================================================================
-- 1. the role, normalised
--
-- "Senior Medical Coder", "Sr. Medical Coder" and "Medical Coder II" are
-- one role; "Medical Representative" is another. The key is the title in
-- lower case with punctuation and the seniority words taken out. One
-- function, used everywhere, so the trigger, the badge and the report
-- cannot disagree about what "the same role" means.
-- =====================================================================
create or replace function app_role_key(p_title text, p_department text default null)
returns text
language sql immutable parallel safe as $$
  select coalesce(
    nullif(btrim(regexp_replace(regexp_replace(
      ' ' || regexp_replace(lower(coalesce(p_title, '')), '[^a-z0-9]+', ' ', 'g') || ' ',
      ' (senior|junior|sr|jr|lead|trainee|associate|executive|i|ii|iii)(?= )', ' ', 'g'),
      '\s+', ' ', 'g')), ''),
    -- A requirement with no usable title still has a department.
    nullif(btrim(regexp_replace(regexp_replace(
      ' ' || regexp_replace(lower(coalesce(p_department, '')), '[^a-z0-9]+', ' ', 'g') || ' ',
      ' (senior|junior|sr|jr|lead|trainee|associate|executive|i|ii|iii)(?= )', ' ', 'g'),
      '\s+', ' ', 'g')), ''))
$$;

-- =====================================================================
-- 2. every contact, with who and for which role
-- =====================================================================
alter table candidate_contact_history
  add column if not exists recruiter_id text references recruiters(id) on delete set null,
  add column if not exists role_key     text,
  add column if not exists source       text,
  add column if not exists stage        text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'cch_source_known') then
    alter table candidate_contact_history
      add constraint cch_source_known check (source is null or source in (
        'phone', 'whatsapp', 'sms', 'email', 'bulk_message', 'ai_call', 'invite',
        'application', 'stage_change', 'submission', 'interview', 'override'));
  end if;
end $$;

create index if not exists cch_by_candidate_role
  on candidate_contact_history (candidate_id, role_key, created_at desc);
create index if not exists cch_by_recruiter
  on candidate_contact_history (recruiter_id, created_at desc);

-- The rows already there: who wrote them, and which role they were about.
update candidate_contact_history h
   set recruiter_id = r.id
  from recruiters r
 where h.recruiter_id is null and h.contacted_by is not null and r.user_id = h.contacted_by;

update candidate_contact_history h
   set role_key = app_role_key(j.title, j.department)
  from jobs j
 where h.role_key is null and h.job_id = j.id;

update candidate_contact_history
   set source = case channel
                  when 'ai_call'  then 'ai_call'
                  when 'email'    then 'email'
                  when 'sms'      then 'sms'
                  when 'whatsapp' then 'whatsapp'
                  when 'phone'    then 'phone'
                  else null end
 where source is null;

-- The sources that are a recruiter reaching a person, as opposed to the
-- pipeline moving. "Last contacted" means these.
create or replace function cch_is_contact(p_source text) returns boolean
language sql immutable parallel safe as $$
  select p_source is null
      or p_source in ('phone', 'whatsapp', 'sms', 'email', 'bulk_message', 'ai_call', 'invite')
$$;

-- =====================================================================
-- 3. reading the contact history
--
-- It used to follow `candidates`, which was harmless while a recruiter
-- saw only their own people. Now that everybody sees everybody, the raw
-- rows (with their `detail`) would tell recruiter B what recruiter A
-- wrote. A recruiter reads the rows they wrote and the rows on their own
-- requirements; everything else arrives summarised through
-- candidate_engagements().
-- =====================================================================
drop policy if exists cch_read on candidate_contact_history;
create policy cch_read on candidate_contact_history for select using (
  app_is_admin()
  or candidate_id = app_candidate_id()
  or app_role() = 'bde'
  or (app_role() = 'recruiter' and (
        recruiter_id = app_recruiter_id()
        or contacted_by = app_user_id()
        or (job_id is not null and app_job_is_mine(job_id))))
);

/** When anybody last reached this person - the date only. */
create or replace function candidate_last_contacted_at(p_candidate_id text)
returns timestamptz
language sql stable security definer set search_path = public as $$
  select max(h.created_at) from candidate_contact_history h
   where h.candidate_id = p_candidate_id and cch_is_contact(h.source)
     and app_role() in ('recruiter', 'bde', 'admin')
$$;

-- =====================================================================
-- 4. who may read and who may edit a candidate
-- =====================================================================

/** May the caller EDIT this candidate? The candidates_self_write rule,
    as a function the definer functions below can ask. */
create or replace function app_candidate_editable(p_candidate_id text) returns boolean
language sql stable security definer set search_path = public as $$
  select case
    when app_is_admin() then true
    when app_role() = 'candidate' then p_candidate_id = app_candidate_id()
    when app_role() = 'recruiter' then exists (
      select 1 from candidates c
       where c.id = p_candidate_id
         and (c.owner_recruiter_id = app_recruiter_id()
              or app_candidate_is_mine(c.id)))
    else false end
$$;

drop policy if exists candidates_read on candidates;
create policy candidates_read on candidates for select using (
  app_is_admin()
  or id = app_candidate_id()
  or (app_role() = 'recruiter' and (
        -- THE CHANGE: the shared database.
        not coalesce(is_private, false)
        -- A private candidate, as before: only their own recruiter.
        or owner_recruiter_id = app_recruiter_id()
        or app_candidate_is_mine(candidates.id)))
  or (app_role() = 'client'
        and app_candidate_at_company(candidates.id, app_client_company(),
                                     app_client_visible_stages()))
);

/*
 * EDITING, UNCHANGED IN EFFECT.
 *
 * 0031 let a recruiter edit a candidate with NO owner. That was only ever
 * reachable for an unowned candidate who had applied to the recruiter's
 * own requirement - because nobody else was visible - and that case is
 * still covered by app_candidate_is_mine(). With every candidate now
 * visible, the same branch would hand every recruiter write access to
 * every self-registered candidate (they have no owner). So it goes, and
 * what each recruiter can actually edit is exactly what it was.
 */
drop policy if exists candidates_self_write on candidates;
create policy candidates_self_write on candidates for update
  using (
    id = app_candidate_id() or app_is_admin()
    or (app_role() = 'recruiter' and (
          owner_recruiter_id = app_recruiter_id()
          or app_candidate_is_mine(candidates.id))))
  with check (
    id = app_candidate_id() or app_is_admin()
    or (app_role() = 'recruiter' and (
          owner_recruiter_id = app_recruiter_id()
          or app_candidate_is_mine(candidates.id))));

/*
 * The side tables already READ through `candidates` (0057, 0075), so
 * they follow the new read rule with no change. Their WRITE rule allowed
 * any recruiter, which was safe only while a recruiter saw only their
 * own people. It now asks the same question as candidates_self_write.
 */
drop policy if exists cedu_write on candidate_education;
create policy cedu_write on candidate_education for all
  using      (app_is_admin() or candidate_id = app_candidate_id()
              or (app_role() = 'recruiter' and app_candidate_editable(candidate_id)))
  with check (app_is_admin() or candidate_id = app_candidate_id()
              or (app_role() = 'recruiter' and app_candidate_editable(candidate_id)));

drop policy if exists cexp_write on candidate_experience;
create policy cexp_write on candidate_experience for all
  using      (app_is_admin() or candidate_id = app_candidate_id()
              or (app_role() = 'recruiter' and app_candidate_editable(candidate_id)))
  with check (app_is_admin() or candidate_id = app_candidate_id()
              or (app_role() = 'recruiter' and app_candidate_editable(candidate_id)));

drop policy if exists cdoc_write on candidate_documents;
create policy cdoc_write on candidate_documents for all
  using      (app_is_admin() or candidate_id = app_candidate_id()
              or (app_role() = 'recruiter' and app_candidate_editable(candidate_id)))
  with check (app_is_admin() or candidate_id = app_candidate_id()
              or (app_role() = 'recruiter' and app_candidate_editable(candidate_id)));

/*
 * The two definer functions that write a candidate on a caller's behalf
 * bypass row level security by design, so they ask the question
 * themselves. Bodies are 0080's and 0075's, unchanged below the guard.
 */
create or replace function candidate_records_replace(
  p_candidate_id text, p_education jsonb, p_experience jsonb
) returns void
language plpgsql security definer set search_path = public as $$
declare v_employers text[];
begin
  if not exists (select 1 from candidates where id = p_candidate_id) then
    return;
  end if;
  /* 0091: a recruiter edits only a candidate they may edit. The engine,
     the candidate themselves and an admin are unchanged. */
  if app_role() = 'recruiter' and not app_candidate_editable(p_candidate_id) then
    raise exception 'only the recruiter who owns this candidate can edit them'
      using errcode = '42501';
  end if;

  if p_education is not null then
    delete from candidate_education where candidate_id = p_candidate_id;

    insert into candidate_education
      (candidate_id, qualification, specialization, institution,
       passing_year, score, education_type, sort_order)
    select p_candidate_id,
           nullif(btrim(e->>'qualification'), ''),
           nullif(btrim(e->>'specialization'), ''),
           nullif(btrim(e->>'institution'), ''),
           case when (e->>'passingYear') ~ '^\d{4}$'
                then (e->>'passingYear')::int else null end,
           nullif(btrim(e->>'score'), ''),
           nullif(btrim(e->>'educationType'), ''),
           ord - 1
      from jsonb_array_elements(p_education) with ordinality as t(e, ord)
     where coalesce(btrim(e->>'qualification'), '') <> ''
        or coalesce(btrim(e->>'institution'), '') <> '';
  end if;

  if p_experience is not null then
    delete from candidate_experience where candidate_id = p_candidate_id;

    insert into candidate_experience
      (candidate_id, company, job_title, location, employment_type,
       responsibilities, sort_order)
    select p_candidate_id,
           nullif(btrim(x->>'company'), ''),
           nullif(btrim(x->>'jobTitle'), ''),
           nullif(btrim(x->>'location'), ''),
           nullif(btrim(x->>'employmentType'), ''),
           nullif(btrim(x->>'responsibilities'), ''),
           ord - 1
      from jsonb_array_elements(p_experience) with ordinality as t(x, ord)
     where coalesce(btrim(x->>'company'), '') <> ''
        or coalesce(btrim(x->>'jobTitle'), '') <> '';

    select array_agg(distinct company) into v_employers
      from candidate_experience
     where candidate_id = p_candidate_id and company is not null;

    update candidates
       set previous_companies = coalesce(v_employers, '{}'),
           updated_at = now()
     where id = p_candidate_id;
  end if;
end $$;

create or replace function candidate_source_set(
  p_candidate_id text, p_source text, p_detail text, p_actor text
) returns text
language plpgsql security definer set search_path = public as $$
declare v_old text; v_old_detail text; v_new text;
begin
  select source, source_details into v_old, v_old_detail
    from candidates where id = p_candidate_id;
  if not found then return null; end if;
  /* 0091: see candidate_records_replace. */
  if app_role() = 'recruiter' and not app_candidate_editable(p_candidate_id) then
    raise exception 'only the recruiter who owns this candidate can edit them'
      using errcode = '42501';
  end if;

  v_new := candidate_source_canonical(p_source);

  update candidates
     set source = v_new,
         source_details = nullif(btrim(coalesce(p_detail, '')), ''),
         updated_at = now()
   where id = p_candidate_id;

  if coalesce(v_old, '') is distinct from coalesce(v_new, '') then
    insert into candidate_activity (candidate_id, kind, summary, detail, actor)
    values (p_candidate_id, 'source_changed',
            'Source changed from ' || coalesce(v_old, 'Unknown')
              || ' to ' || coalesce(v_new, 'Unknown'),
            jsonb_build_object('from', v_old, 'to', v_new,
                               'fromDetail', v_old_detail, 'toDetail', p_detail),
            p_actor);
  end if;

  return v_new;
end $$;

/*
 * The messages a recruiter sent stay with that recruiter.
 *
 * 0061 let every recruiter read every message_logs row, which again was
 * harmless only while a recruiter saw only their own people. A recruiter
 * now reads what they sent, and what was sent to the candidates they
 * would have seen before this file (their own, and those who applied to
 * their requirements) - which is exactly what the Communication panel
 * showed them until now.
 */
drop policy if exists mlog_read on message_logs;
create policy mlog_read on message_logs for select using (
  app_is_admin()
  or app_role() = 'bde'
  or candidate_id = app_candidate_id()
  or (app_role() = 'recruiter' and (
        sent_by = app_user_id()
        or app_candidate_editable(candidate_id)))
);

-- =====================================================================
-- 5. notes: private, or shared with the team
-- =====================================================================
alter table candidate_comments
  add column if not exists visibility text not null default 'private';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'candidate_comments_visibility') then
    alter table candidate_comments
      add constraint candidate_comments_visibility check (visibility in ('private', 'team'));
  end if;
end $$;

/* comments_own (0002) still governs every write and every private note.
   This adds one permissive READ branch: a team note, to recruiters and
   BDEs who can see the candidate. */
drop policy if exists comments_team_read on candidate_comments;
create policy comments_team_read on candidate_comments for select using (
  visibility = 'team'
  and app_role() in ('recruiter', 'bde')
  and exists (select 1 from candidates c where c.id = candidate_comments.candidate_id)
);

-- =====================================================================
-- 6. overrides, and the audit of every decision
-- =====================================================================
create table if not exists engagement_overrides (
  id                     bigserial primary key,
  candidate_id           text not null references candidates(id) on delete cascade,
  role_key               text,
  job_id                 text references jobs(id) on delete set null,
  -- hold                  another recruiter holds them for this role
  -- placed                the 90-day replacement period after a joining
  -- duplicate_submission  a second submission to the same client, same role
  kind                   text not null default 'hold'
                         check (kind in ('hold', 'placed', 'duplicate_submission')),
  requested_by           uuid references users(id),
  requester_recruiter_id text references recruiters(id) on delete set null,
  reason                 text not null check (char_length(btrim(reason)) between 3 and 1000),
  status                 text not null default 'pending'
                         check (status in ('pending', 'approved', 'denied')),
  decided_by             uuid references users(id),
  decided_at             timestamptz,
  decision_reason        text,
  -- An approval is permission for a while, not for ever.
  expires_at             timestamptz,
  used_at                timestamptz,
  created_at             timestamptz not null default now()
);
create index if not exists eo_candidate on engagement_overrides (candidate_id, role_key);
create index if not exists eo_pending   on engagement_overrides (status, created_at desc);

create table if not exists engagement_audit (
  id           bigserial primary key,
  candidate_id text not null references candidates(id) on delete cascade,
  role_key     text,
  job_id       text references jobs(id) on delete set null,
  actor        uuid references users(id),
  recruiter_id text references recruiters(id) on delete set null,
  -- contact_anyway | override_requested | override_approved |
  -- override_denied | override_used | blocked | duplicate_blocked
  action       text not null,
  detail       jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);
create index if not exists ea_candidate on engagement_audit (candidate_id, created_at desc);
create index if not exists ea_action    on engagement_audit (action, created_at desc);

alter table engagement_overrides enable row level security;
alter table engagement_overrides force  row level security;
alter table engagement_audit     enable row level security;
alter table engagement_audit     force  row level security;

/* The requester sees their own requests; an admin sees all of them.
   Written only through the functions below. */
create policy eo_read on engagement_overrides for select using (
  app_is_admin() or requested_by = app_user_id()
);
create policy eo_no_direct_write on engagement_overrides for all
  using (app_is_admin() and app_user_id() is null)
  with check (app_is_admin() and app_user_id() is null);

create policy ea_read on engagement_audit for select using (
  app_is_admin() or actor = app_user_id()
);
create policy ea_no_direct_write on engagement_audit for all
  using (app_is_admin() and app_user_id() is null)
  with check (app_is_admin() and app_user_id() is null);

/** app.user_id as a uuid, or null - never an exception. */
create or replace function app_user_id_safe() returns uuid
language sql stable as $$
  select case when current_setting('app.user_id', true) ~ '^[0-9a-fA-F-]{36}$'
              then current_setting('app.user_id', true)::uuid end
$$;

/* The write itself, for the triggers - whoever the caller is. Not
   callable by the API (revoked below). */
create or replace function engagement_audit_write(
  p_candidate_id text, p_role_key text, p_job_id text, p_action text, p_detail jsonb
) returns bigint
language plpgsql security definer set search_path = public as $$
declare v_id bigint;
begin
  insert into engagement_audit (candidate_id, role_key, job_id, actor, recruiter_id, action, detail)
  values (p_candidate_id, p_role_key, p_job_id, app_user_id_safe(), app_recruiter_id(),
          p_action, coalesce(p_detail, '{}'::jsonb))
  returning id into v_id;
  return v_id;
end $$;

/* The same, for the API: staff only, and only the actions a route may
   record on its own behalf. */
create or replace function engagement_audit_add(
  p_candidate_id text, p_role_key text, p_job_id text, p_action text, p_detail jsonb default '{}'::jsonb
) returns bigint
language plpgsql security definer set search_path = public as $$
begin
  if app_role() not in ('recruiter', 'bde', 'admin') then
    raise exception 'staff only' using errcode = '42501';
  end if;
  if p_action not in ('contact_anyway', 'blocked', 'duplicate_blocked', 'message_holder') then
    raise exception 'not an action the API records' using errcode = '22023';
  end if;
  return engagement_audit_write(p_candidate_id, p_role_key, p_job_id, p_action, p_detail);
end $$;

-- =====================================================================
-- 7. who has worked this person, for which role, how far
--
-- engagement_rows() is the one place that reads the raw activity: every
-- application (whoever owns it) and every recorded contact, folded into
-- one row per (candidate, recruiter, role). Everything a recruiter is
-- shown is derived from it, and it is NOT callable by the API - only by
-- the definer functions below, which return the summary and nothing else.
-- =====================================================================

/** The coarse status a colleague is allowed to know. */
create or replace function engagement_status(p_stage text, p_outcome text) returns text
language sql immutable parallel safe as $$
  select case
    when p_stage is not null then case
      when p_stage in ('applied', 'ai_screening') then 'applied'
      when p_stage in ('shortlisted', 'with_bde', 'hold') then 'shortlisted'
      when p_stage in ('client_review') then 'submitted'
      when p_stage in ('ai_interview_pending', 'ai_interview_in_progress', 'ai_interview_done',
                       'ai_evaluation_done', 'interview_scheduled', 'client_interview') then 'interviewing'
      when p_stage in ('offer_extended', 'selected') then 'offered'
      when p_stage = 'joined' then 'joined'
      when p_stage = 'rejected' then 'rejected'
      else 'applied' end
    when p_outcome = 'interested' then 'interested'
    when p_outcome = 'not_interested' then 'not_interested'
    else 'contacted' end
$$;

/** Stages at which the client has the candidate's profile. */
create or replace function engagement_submission_stages() returns text[]
language sql immutable as $$
  select array['client_review', 'client_interview', 'offer_extended', 'selected', 'joined']::text[]
$$;

create or replace function engagement_rows(p_ids text[])
returns table (
  candidate_id text, recruiter_id text, role_key text,
  job_id text, job_title text,
  level text, status text, status_label text,
  last_at timestamptz, last_channel text, last_outcome text,
  joined_at timestamptz, expires_at timestamptz, active boolean
)
language sql stable security definer set search_path = public as $$
  with apps as (
    select a.candidate_id,
           coalesce(a.recruiter_id, j.recruiter_id) as recruiter_id,
           app_role_key(j.title, j.department)     as role_key,
           a.job_id, j.title as job_title, a.stage, s.label as stage_label,
           greatest(a.applied_at,
                    coalesce((select max(h.created_at) from application_stage_history h
                               where h.application_id = a.id), a.applied_at)) as at,
           case when a.stage = 'joined' then
             coalesce((select max(h.created_at) from application_stage_history h
                        where h.application_id = a.id and h.to_stage = 'joined'), a.applied_at)
           end as joined_at
      from applications a
      join jobs j on j.id = a.job_id
      left join stages s on s.id = a.stage
     where a.candidate_id = any(p_ids)
  ),
  ev as (
    select candidate_id, recruiter_id, role_key, job_id, job_title, at,
           case when stage = 'joined' then 'joined'
                when stage = 'rejected' then 'closed'
                else 'in_process' end as kind,
           null::text as channel, null::text as outcome, stage, stage_label, joined_at
      from apps
     where recruiter_id is not null and role_key is not null
    union all
    select h.candidate_id, h.recruiter_id, h.role_key, h.job_id, j.title, h.created_at,
           case when h.outcome in ('not_interested', 'wrong_number') then 'closed'
                else 'contacted' end,
           h.channel, h.outcome, null, null, null
      from candidate_contact_history h
      left join jobs j on j.id = h.job_id
     where h.candidate_id = any(p_ids)
       and h.recruiter_id is not null and h.role_key is not null
       and cch_is_contact(h.source)
  ),
  agg as (
    select candidate_id, recruiter_id, role_key,
           max(at) as last_at,
           bool_or(kind = 'in_process') as open_app,
           max(joined_at) as joined_at,
           (array_agg(kind order by at desc))[1] as last_kind,
           (array_agg(job_id order by at desc))[1] as job_id,
           (array_agg(job_title order by at desc))[1] as job_title,
           (array_agg(channel order by at desc) filter (where channel is not null))[1] as last_channel,
           (array_agg(outcome order by at desc) filter (where channel is not null))[1] as last_outcome,
           (array_agg(stage order by at desc) filter (where kind = 'in_process'))[1] as open_stage,
           (array_agg(stage_label order by at desc) filter (where kind = 'in_process'))[1] as open_label,
           (array_agg(stage order by at desc) filter (where stage is not null))[1] as last_stage,
           (array_agg(stage_label order by at desc) filter (where stage is not null))[1] as last_label,
           (array_agg(stage order by at desc))[1] as top_stage,
           (array_agg(outcome order by at desc))[1] as top_outcome
      from ev
     group by candidate_id, recruiter_id, role_key
  ),
  lv as (
    select g.*,
           case when g.open_app then 'in_process'
                when g.joined_at is not null and g.joined_at > now() - interval '90 days' then 'joined'
                when g.last_kind = 'contacted' then 'contacted'
                else 'closed' end as lvl
      from agg g
  )
  select candidate_id, recruiter_id, role_key, job_id, job_title,
         lvl as level,
         case when lvl = 'in_process' then engagement_status(open_stage, null)
              when lvl = 'joined' then 'joined'
              else engagement_status(top_stage, top_outcome) end as status,
         case when lvl = 'in_process' then open_label
              when lvl = 'joined' then 'Joined'
              else last_label end as status_label,
         last_at, last_channel, last_outcome, joined_at,
         case when lvl = 'joined' then joined_at + interval '90 days'
              when lvl in ('in_process', 'contacted') then last_at + interval '30 days'
         end as expires_at,
         case when lvl = 'joined' then joined_at + interval '90 days' > now()
              when lvl in ('in_process', 'contacted') then last_at + interval '30 days' > now()
              else false end as active
    from lv
$$;

/**
 * Who holds this candidate for this role, if anyone.
 *
 * A joining in the last 90 days holds them for EVERY role. Otherwise the
 * holder is the recruiter with the most recent active (contacted or in
 * process, within 30 days of the last activity) engagement for the role.
 */
create or replace function candidate_hold(p_candidate_id text, p_role_key text)
returns table (
  recruiter_id text, recruiter_name text, role_key text, job_title text,
  level text, status text, status_label text, last_at timestamptz,
  expires_at timestamptz, last_channel text, last_outcome text
)
language sql stable security definer set search_path = public as $$
  select e.recruiter_id, r.name, e.role_key, e.job_title, e.level, e.status, e.status_label,
         e.last_at, e.expires_at, e.last_channel, e.last_outcome
    from engagement_rows(array[p_candidate_id]) e
    left join recruiters r on r.id = e.recruiter_id
   where e.active
     and (e.level = 'joined' or (p_role_key is not null and e.role_key = p_role_key))
   order by (e.level = 'joined') desc, e.last_at desc
   limit 1
$$;

/**
 * May the CALLER contact / add / submit this candidate for this job or
 * role?  'allowed' | 'warn' | 'blocked', with who holds them and why.
 *
 * With neither a job nor a role there is nothing to compare against, so
 * the strongest active engagement of ANY other recruiter decides - a
 * message that names no role could be about theirs. Choosing the role
 * narrows the check to that role.
 */
create or replace function can_engage(
  p_candidate_id text, p_job_id text default null, p_role_key text default null
) returns table (
  decision text, reason text, role_key text,
  holder_recruiter_id text, holder_name text, level text, job_title text,
  status text, status_label text, last_activity timestamptz, hold_expires_at timestamptz,
  last_channel text, last_outcome text, override_id bigint
)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_me   text := app_recruiter_id();
  v_rk   text := nullif(btrim(coalesce(p_role_key, '')), '');
  v_h    record;
  v_dec  text := 'allowed';
  v_why  text := null;
  v_ovr  bigint := null;
begin
  if app_role() not in ('recruiter', 'bde', 'admin') then
    raise exception 'staff only' using errcode = '42501';
  end if;
  if v_rk is null and p_job_id is not null then
    select app_role_key(j.title, j.department) into v_rk from jobs j where j.id = p_job_id;
  end if;

  -- 1. a joining in the last 90 days: every role
  select e.*, r.name as rname into v_h
    from engagement_rows(array[p_candidate_id]) e
    left join recruiters r on r.id = e.recruiter_id
   where e.level = 'joined' and e.active
   order by e.joined_at desc limit 1;

  if found then
    if v_h.recruiter_id is not distinct from v_me and (v_rk is null or v_rk = v_h.role_key) then
      v_dec := 'allowed'; v_why := 'own_placement';
    elsif v_h.recruiter_id is not distinct from v_me then
      v_dec := 'blocked'; v_why := 'placed_other_role';
    else
      v_dec := 'blocked'; v_why := 'joined';
    end if;
  else
    -- 2. this role
    if v_rk is not null then
      if exists (select 1 from engagement_rows(array[p_candidate_id]) e
                  where e.recruiter_id = v_me and e.role_key = v_rk
                    and e.level = 'in_process' and e.active) then
        v_dec := 'allowed'; v_why := 'own_process';
        select e.*, r.name as rname into v_h
          from engagement_rows(array[p_candidate_id]) e
          left join recruiters r on r.id = e.recruiter_id
         where e.recruiter_id = v_me and e.role_key = v_rk and e.level = 'in_process'
         limit 1;
      else
        select e.*, r.name as rname into v_h
          from engagement_rows(array[p_candidate_id]) e
          left join recruiters r on r.id = e.recruiter_id
         where e.role_key = v_rk and e.active and e.level in ('contacted', 'in_process')
         order by e.last_at desc limit 1;
      end if;
    else
      -- 3. no role: the strongest engagement of anybody else
      select e.*, r.name as rname into v_h
        from engagement_rows(array[p_candidate_id]) e
        left join recruiters r on r.id = e.recruiter_id
       where e.active and e.level in ('contacted', 'in_process')
         and e.recruiter_id is distinct from v_me
       order by (e.level = 'in_process') desc, e.last_at desc limit 1;
    end if;

    if v_why is null and v_h.recruiter_id is not null then
      if v_h.recruiter_id is not distinct from v_me then
        v_dec := 'allowed'; v_why := 'holder';
      elsif v_h.level = 'in_process' then
        v_dec := 'blocked'; v_why := 'in_process';
      else
        v_dec := 'warn'; v_why := 'contacted';
      end if;
    end if;
  end if;

  -- 4. an administrator's approval lifts a block (never a duplicate
  --    submission - that has its own override, kind duplicate_submission)
  if v_dec in ('blocked', 'warn') and v_me is not null then
    select o.id into v_ovr from engagement_overrides o
     where o.candidate_id = p_candidate_id
       and o.requester_recruiter_id = v_me
       and o.status = 'approved'
       and o.kind in ('hold', 'placed')
       and (o.expires_at is null or o.expires_at > now())
       and (o.role_key is null or v_rk is null or o.role_key = v_rk
            or (v_why in ('joined', 'placed_other_role') and o.kind = 'placed'))
     order by o.decided_at desc limit 1;
    if v_ovr is not null then
      v_dec := 'allowed'; v_why := 'override';
    end if;
  end if;

  -- 5. an administrator is never held
  if app_is_admin() and v_dec <> 'allowed' then
    v_dec := 'allowed'; v_why := 'admin';
  end if;

  -- 6. the decision always; WHO and WHAT only about a candidate the
  --    caller can see (a private one is somebody else's business)
  if not (app_is_admin() or exists (
            select 1 from candidates c
             where c.id = p_candidate_id
               and (not coalesce(c.is_private, false)
                    or c.owner_recruiter_id = v_me
                    or (v_me is not null and app_candidate_is_mine(c.id))
                    or (app_role() = 'bde' and app_candidate_at_company(c.id, app_bde_company()))))) then
    return query select v_dec, v_why, v_rk, null::text, null::text, null::text, null::text,
                        null::text, null::text, null::timestamptz, null::timestamptz,
                        null::text, null::text, v_ovr;
    return;
  end if;

  return query select v_dec, v_why, coalesce(v_rk, v_h.role_key),
                      v_h.recruiter_id, v_h.rname, v_h.level, v_h.job_title,
                      v_h.status, v_h.status_label, v_h.last_at, v_h.expires_at,
                      v_h.last_channel, v_h.last_outcome, v_ovr;
end $$;

/**
 * The ONE thing a recruiter is told about other recruiters' work on a
 * candidate: who, which role, when, how, how far. No notes, no message
 * text, no scores, nothing about the client.
 *
 * Only for a candidate the caller can see.
 */
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
  -- "Visible to the caller" is the candidates_read rule, asked directly.
  select app_is_admin() or (
           app_role() = 'bde' and (not coalesce(c.is_private, false)
                                   or app_candidate_at_company(c.id, app_bde_company())))
         or (app_role() = 'recruiter' and (not coalesce(c.is_private, false)
                                          or c.owner_recruiter_id = app_recruiter_id()
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
           -- the holder of each role (and of every role, for a joining)
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
     order by e.active desc, e.last_at desc;
end $$;

/**
 * One badge per candidate, for a list of them - the search results, the
 * talent pool. Answers about OTHER recruiters only; the caller knows what
 * they did themselves.
 *
 *   in_process / joined  red
 *   contacted            orange
 *   other_roles          grey   (worked before, not for this role)
 */
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
      -- only candidates the caller can see: read under their own rights
      select c.id from candidates c
       where c.id = any(p_ids[1:500])
         and (app_is_admin()
              or (app_role() = 'bde' and (not coalesce(c.is_private, false)
                                          or app_candidate_at_company(c.id, app_bde_company())))
              or (app_role() = 'recruiter' and (not coalesce(c.is_private, false)
                                               or c.owner_recruiter_id = v_me
                                               or app_candidate_is_mine(c.id))))
    ),
    rows as (
      select e.*, r.name as rname
        from engagement_rows(array(select id from vis)) e
        left join recruiters r on r.id = e.recruiter_id
       where e.recruiter_id is distinct from v_me
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
-- 8. recording a contact
-- =====================================================================

/**
 * One row in the contact history, on the caller's behalf: the recruiter
 * is the caller, the role comes from the job when there is one. Moves
 * the talent-pool status the same way 0048's function does.
 */
create or replace function engagement_record(
  p_candidate_id text,
  p_job_id       text,
  p_role_key     text,
  p_channel      text,
  p_source       text,
  p_outcome      text,
  p_detail       text default null,
  p_ref          text default null
) returns bigint
language plpgsql security definer set search_path = public as $$
declare
  v_id bigint;
  v_rk text := nullif(btrim(coalesce(p_role_key, '')), '');
begin
  if app_role() not in ('recruiter', 'bde', 'admin') then
    raise exception 'staff only' using errcode = '42501';
  end if;
  if not exists (select 1 from candidates where id = p_candidate_id) then
    return null;
  end if;
  if v_rk is null and p_job_id is not null then
    select app_role_key(j.title, j.department) into v_rk from jobs j where j.id = p_job_id;
  end if;

  insert into candidate_contact_history
    (candidate_id, job_id, channel, direction, outcome, detail, ref_id,
     contacted_by, recruiter_id, role_key, source)
  values (p_candidate_id, p_job_id, coalesce(nullif(p_channel, ''), p_source), 'out',
          nullif(p_outcome, ''), left(p_detail, 500), p_ref,
          app_user_id_safe(), app_recruiter_id(), v_rk, p_source)
  returning id into v_id;

  if    p_outcome = 'interested'     then perform candidate_pool_status(p_candidate_id, 'interested', null);
  elsif p_outcome = 'not_interested' then perform candidate_pool_status(p_candidate_id, 'not_interested', null);
  elsif p_outcome = 'call_back'      then perform candidate_pool_status(p_candidate_id, 'callback_requested', null);
  elsif p_outcome = 'no_answer'      then perform candidate_pool_status(p_candidate_id, 'unreachable', null);
  end if;

  return v_id;
end $$;

-- =====================================================================
-- 9. enforcement, where it cannot be forgotten
-- =====================================================================

/*
 * A refusal is NOT written to engagement_audit here: the exception rolls
 * back everything this transaction wrote, the audit row included. The API
 * catches TLB01 / TLD01 and records 'blocked' / 'duplicate_blocked' in a
 * transaction of its own (engagement_audit_add).
 *
 * Error codes the API maps to 409s (api/src/errors.js):
 *   TLB01  another recruiter holds this candidate for this role
 *   TLD01  this candidate was already submitted to this client for this role
 * The DETAIL is JSON for the screen; the MESSAGE is a sentence for a person.
 */
create or replace function engagement_block_message(
  p_reason text, p_holder text, p_job_title text, p_role_key text,
  p_status_label text, p_expires timestamptz
) returns text
language sql stable as $$
  select case
    when p_reason = 'joined' then format(
      '%s placed this candidate (joined through TeamLink). They are held for every role until %s (replacement period).',
      coalesce(p_holder, 'Another recruiter'),
      coalesce(to_char(p_expires, 'DD Mon YYYY'), 'the replacement period ends'))
    when p_reason = 'placed_other_role' then format(
      'This candidate joined through TeamLink recently. Contact for another role is blocked until %s (replacement period).',
      coalesce(to_char(p_expires, 'DD Mon YYYY'), 'the replacement period ends'))
    else format(
      '%s is processing this candidate for %s%s. Hold ends %s if no activity.',
      coalesce(p_holder, 'Another recruiter'),
      coalesce(p_job_title, initcap(p_role_key), 'this role'),
      coalesce(' (' || p_status_label || ')', ''),
      coalesce(to_char(p_expires, 'DD Mon YYYY'), 'after 30 days'))
  end
$$;

/* The JSON the screen reads off a TLB01. */
create or replace function engagement_block_detail(
  p_decision text, p_reason text, p_holder_id text, p_holder text, p_role_key text,
  p_job_title text, p_status_label text, p_expires timestamptz
) returns text
language sql stable as $$
  select json_build_object('decision', p_decision, 'reason', p_reason,
           'holderRecruiterId', p_holder_id, 'holderName', p_holder,
           'roleKey', p_role_key, 'jobTitle', p_job_title,
           'statusLabel', p_status_label, 'holdExpiresAt', p_expires)::text
$$;

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
begin
  select j.title, j.department, j.company_id into v_job from jobs j where j.id = new.job_id;
  v_rk := app_role_key(v_job.title, v_job.department);

  /* A RECRUITER adding somebody to a requirement, or sending them to the
     client: the hold rules. A candidate applying, the intake engine and
     an administrator are not held. */
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

  /* The same candidate, the same client, the same role, a second time:
     always refused, whoever asks, unless an administrator has approved
     this one with a reason. */
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
        raise exception '%', format(
            'This candidate was already submitted to this client for %s by %s. A second submission needs an administrator''s override.',
            coalesce(v_job.title, 'this role'), coalesce(v_dup.rname, 'another recruiter'))
          using errcode = 'TLD01',
                detail = json_build_object('reason', 'duplicate_submission',
                           'firstRecruiter', v_dup.rname, 'roleKey', v_rk,
                           'jobTitle', v_job.title, 'candidateId', new.candidate_id)::text;
      end if;
      update engagement_overrides set used_at = now() where id = v_ovr;
      perform engagement_audit_write(new.candidate_id, v_rk, new.job_id, 'override_used',
        jsonb_build_object('action', 'duplicate_submission', 'overrideId', v_ovr,
                           'firstApplication', v_dup.id));
    end if;
  end if;

  return new;
end $$;

drop trigger if exists applications_engagement_guard on applications;
create trigger applications_engagement_guard
  before insert or update of stage on applications
  for each row execute function applications_engagement_guard();

/* Every application event is an engagement, written down. */
create or replace function applications_engagement_log() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_job record; v_src text;
begin
  if tg_op = 'UPDATE' and new.stage is not distinct from old.stage then
    return new;
  end if;
  select j.title, j.department, j.recruiter_id into v_job from jobs j where j.id = new.job_id;
  v_src := case
    when tg_op = 'INSERT' then 'application'
    when new.stage = any(engagement_submission_stages())
         and not (old.stage = any(engagement_submission_stages())) then 'submission'
    when new.stage in ('interview_scheduled', 'client_interview', 'ai_interview_pending') then 'interview'
    else 'stage_change' end;

  insert into candidate_contact_history
    (candidate_id, job_id, channel, direction, outcome, ref_id, contacted_by,
     recruiter_id, role_key, source, stage)
  values (new.candidate_id, new.job_id, 'pipeline', 'out', new.stage, new.id,
          app_user_id_safe(), coalesce(new.recruiter_id, v_job.recruiter_id),
          app_role_key(v_job.title, v_job.department), v_src, new.stage);
  return new;
end $$;

drop trigger if exists applications_engagement_log on applications;
create trigger applications_engagement_log
  after insert or update of stage on applications
  for each row execute function applications_engagement_log();

/* An interview booked is an engagement too, whoever booked it. */
create or replace function interviews_engagement_log() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_job record;
begin
  select j.title, j.department, j.recruiter_id into v_job from jobs j where j.id = new.job_id;
  insert into candidate_contact_history
    (candidate_id, job_id, channel, direction, outcome, ref_id, contacted_by,
     recruiter_id, role_key, source)
  values (new.candidate_id, new.job_id, 'pipeline', 'out', 'interview', new.id,
          app_user_id_safe(),
          coalesce((select a.recruiter_id from applications a where a.id = new.application_id),
                   v_job.recruiter_id),
          app_role_key(v_job.title, v_job.department), 'interview');
  return new;
end $$;

drop trigger if exists interviews_engagement_log on interviews;
create trigger interviews_engagement_log
  after insert on interviews
  for each row execute function interviews_engagement_log();

/* An AI call is a call. Blocked the same way, recorded the same way. */
create or replace function ai_call_engagement_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare v record;
begin
  if app_role() = 'recruiter' then
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
  end if;
  return new;
end $$;

create or replace function ai_call_engagement_log() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_rk text;
begin
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

drop trigger if exists ai_call_engagement_guard on ai_call_sessions;
create trigger ai_call_engagement_guard
  before insert on ai_call_sessions
  for each row execute function ai_call_engagement_guard();

drop trigger if exists ai_call_engagement_log on ai_call_sessions;
create trigger ai_call_engagement_log
  after insert on ai_call_sessions
  for each row execute function ai_call_engagement_log();

-- =====================================================================
-- 10. overrides: asked for, decided, logged
-- =====================================================================
create or replace function engagement_override_request(
  p_candidate_id text, p_job_id text, p_role_key text, p_kind text, p_reason text
) returns bigint
language plpgsql security definer set search_path = public as $$
declare v_id bigint; v_rk text := nullif(btrim(coalesce(p_role_key, '')), '');
begin
  if app_role() not in ('recruiter', 'admin') then
    raise exception 'only a recruiter or an administrator can ask for an override'
      using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'an override needs a reason' using errcode = '22023';
  end if;
  if coalesce(p_kind, 'hold') not in ('hold', 'placed', 'duplicate_submission') then
    raise exception 'unknown override kind' using errcode = '22023';
  end if;
  if v_rk is null and p_job_id is not null then
    select app_role_key(j.title, j.department) into v_rk from jobs j where j.id = p_job_id;
  end if;

  insert into engagement_overrides
    (candidate_id, role_key, job_id, kind, requested_by, requester_recruiter_id, reason)
  values (p_candidate_id, v_rk, p_job_id, coalesce(p_kind, 'hold'), app_user_id_safe(),
          app_recruiter_id(), btrim(p_reason))
  returning id into v_id;

  perform engagement_audit_write(p_candidate_id, v_rk, p_job_id, 'override_requested',
    jsonb_build_object('overrideId', v_id, 'kind', coalesce(p_kind, 'hold'),
                       'reason', btrim(p_reason)));
  return v_id;
end $$;

create or replace function engagement_override_decide(
  p_id bigint, p_approve boolean, p_reason text, p_days int default 30
) returns engagement_overrides
language plpgsql security definer set search_path = public as $$
declare v engagement_overrides;
begin
  if not app_is_admin() or app_user_id_safe() is null then
    raise exception 'only an administrator decides an override' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'a decision needs a reason' using errcode = '22023';
  end if;
  update engagement_overrides
     set status = case when p_approve then 'approved' else 'denied' end,
         decided_by = app_user_id_safe(), decided_at = now(),
         decision_reason = btrim(p_reason),
         expires_at = case when p_approve
                           then now() + make_interval(days => greatest(1, least(coalesce(p_days, 30), 90)))
                      end
   where id = p_id and status = 'pending'
  returning * into v;
  if v.id is null then
    return null;
  end if;
  perform engagement_audit_write(v.candidate_id, v.role_key, v.job_id,
    case when p_approve then 'override_approved' else 'override_denied' end,
    jsonb_build_object('overrideId', v.id, 'kind', v.kind, 'reason', btrim(p_reason),
                       'requester', v.requester_recruiter_id));
  return v;
end $$;

/**
 * Admin: who is being worked by more than one recruiter for the same
 * role, and where somebody chose "Contact anyway".
 */
create or replace function engagement_conflicts(p_days int default 90)
returns table (
  candidate_id text, candidate_name text, role_key text, job_titles text[],
  recruiters text[], recruiter_count int, last_at timestamptz,
  contact_anyway int, overrides int
)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  if not app_is_admin() then
    raise exception 'administrators only' using errcode = '42501';
  end if;
  return query
    with recent as (
      select distinct e.candidate_id
        from engagement_audit e
       where e.created_at > now() - make_interval(days => p_days)
      union
      select distinct h.candidate_id
        from candidate_contact_history h
       where h.created_at > now() - make_interval(days => p_days)
         and h.recruiter_id is not null
      union
      select distinct a.candidate_id
        from applications a
       where a.applied_at > now() - make_interval(days => p_days)
          or a.updated_at > now() - make_interval(days => p_days)
    ),
    rows as (
      select e.*, r.name as rname
        from engagement_rows(array(select candidate_id from recent)) e
        left join recruiters r on r.id = e.recruiter_id
       where e.last_at > now() - make_interval(days => p_days)
    ),
    roles as (
      select x.candidate_id, x.role_key,
             array_agg(distinct x.job_title) filter (where x.job_title is not null) as titles,
             array_agg(distinct coalesce(x.rname, x.recruiter_id)) as recs,
             count(distinct x.recruiter_id)::int as n,
             max(x.last_at) as last_at
        from rows x
       group by x.candidate_id, x.role_key
    ),
    audit as (
      select a.candidate_id, a.role_key,
             count(*) filter (where a.action = 'contact_anyway')::int as anyway,
             count(*) filter (where a.action like 'override_%')::int as ovr
        from engagement_audit a
       where a.created_at > now() - make_interval(days => p_days)
       group by a.candidate_id, a.role_key
    )
    select r.candidate_id, c.name, r.role_key, coalesce(r.titles, '{}'), r.recs, r.n, r.last_at,
           coalesce(au.anyway, 0), coalesce(au.ovr, 0)
      from roles r
      join candidates c on c.id = r.candidate_id
      left join audit au on au.candidate_id = r.candidate_id
                        and au.role_key is not distinct from r.role_key
     where r.n >= 2 or coalesce(au.anyway, 0) > 0 or coalesce(au.ovr, 0) > 0
     order by r.last_at desc
     limit 500;
end $$;

-- =====================================================================
-- 11. who may call what
--
-- New functions are executable by PUBLIC unless that is taken away, and
-- the internal ones must not be reachable by the API at all.
-- =====================================================================
revoke execute on function engagement_rows(text[]) from public;
-- answers for any candidate id without asking who is calling: internal only
revoke execute on function candidate_hold(text, text) from public;
revoke execute on function engagement_audit_write(text, text, text, text, jsonb) from public;
revoke execute on function applications_engagement_guard() from public;
revoke execute on function applications_engagement_log() from public;
revoke execute on function ai_call_engagement_guard() from public;
revoke execute on function ai_call_engagement_log() from public;
revoke execute on function interviews_engagement_log() from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant select on engagement_overrides, engagement_audit to app_api;
    grant usage, select on sequence engagement_overrides_id_seq, engagement_audit_id_seq to app_api;
    grant execute on function
      app_role_key(text, text),
      cch_is_contact(text),
      candidate_last_contacted_at(text),
      app_candidate_editable(text),
      app_user_id_safe(),
      engagement_audit_add(text, text, text, text, jsonb),
      engagement_status(text, text),
      engagement_submission_stages(),
      can_engage(text, text, text),
      candidate_engagements(text, text),
      engagement_badges(text[], text),
      engagement_record(text, text, text, text, text, text, text, text),
      engagement_block_message(text, text, text, text, text, timestamptz),
      engagement_block_detail(text, text, text, text, text, text, text, timestamptz),
      engagement_override_request(text, text, text, text, text),
      engagement_override_decide(bigint, boolean, text, int),
      engagement_conflicts(int)
      to app_api;
  end if;
end $$;

comment on function candidate_engagements(text, text) is
  'The only summary of other recruiters'' work on a candidate: recruiter, role, dates, channel, outcome, level. Never notes, message text, scores or client details.';
comment on function can_engage(text, text, text) is
  'allowed | warn | blocked for the caller on this candidate and job/role (0091 hold rules). Called by the API before every contact and by the triggers on applications and ai_call_sessions.';
