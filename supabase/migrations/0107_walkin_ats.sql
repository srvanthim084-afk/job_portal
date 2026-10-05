-- ---------------------------------------------------------------------
-- 0107 — the walk-in ATS (owner's Section 23, Walk-in-Job-Type 10/13.2/14/16)
--
-- Walk-in is a JOB TYPE (jobs.posting_kind = 'walkin', 0083). Its
-- applications live in the one `applications` table, with the one stage
-- column, moved through the one stage mechanism (stages +
-- application_stage_history + log_stage_change, 0001/0008/0042/0051).
-- This migration EXTENDS that mechanism; it builds no second ATS.
--
--   stages.applies_to        which job kind a stage belongs to
--                            (regular | walkin | all). The regular stages
--                            are untouched; Selected and Rejected are
--                            shared; Registered, Attended, Interviewed and
--                            No Show are walk-in only.
--   stage_transitions        the walk-in transition table (data, not a
--                            list in a screen). Regular jobs keep their
--                            existing free movement exactly as before.
--   triggers on applications the initial stage of a walk-in application is
--                            Registered whoever inserts it; every stage
--                            change of a walk-in application is checked
--                            against stage_transitions; overrides need a
--                            reason; every ATS change bumps `version`.
--   application_stage_history  gains reason / source / is_override /
--                            action - still append-only.
--   ats_move_stage / ats_bulk_move / ats_check_in  the definer functions the
--                            API calls (explicit access check inside).
--   application_notes, application_ratings, resume_access_log,
--   job_update_history, walkin_reschedules, walkin_ats_messages,
--   ats_recruiter_alerts, job_ats_settings, walkin_ats_settings.
--   walkin_mark_no_shows()   the No Show sweep (engine only, IST, grace,
--                            idempotent, reschedule-aware).
--
-- Shared contract with 0106 (agent W1): the five jobs columns and the two
-- walkin_*_at functions below are written with IF NOT EXISTS / OR REPLACE
-- and identical text, so either migration may run first.
-- ---------------------------------------------------------------------

-- =====================================================================
-- 0. the shared contract (identical in 0106)
-- =====================================================================
alter table jobs add column if not exists walkin_address      text;
alter table jobs add column if not exists walkin_map_link     text;
alter table jobs add column if not exists walkin_documents    text;      -- one item per line
alter table jobs add column if not exists walkin_instructions text;
alter table jobs add column if not exists walkin_capacity     int check (walkin_capacity is null or walkin_capacity > 0);
create or replace function walkin_starts_at(p_date text, p_from text) returns timestamptz
  language sql immutable as $$ select case when p_date ~ '^\d{4}-\d{2}-\d{2}$'
    then ((p_date || ' ' || coalesce(nullif(p_from,''),'00:00'))::timestamp at time zone 'Asia/Kolkata') end $$;
create or replace function walkin_ends_at(p_date text, p_to text) returns timestamptz
  language sql immutable as $$ select case when p_date ~ '^\d{4}-\d{2}-\d{2}$'
    then ((p_date || ' ' || coalesce(nullif(p_to,''),'23:59'))::timestamp at time zone 'Asia/Kolkata') end $$;

-- =====================================================================
-- 1. stages: which job kind a stage belongs to, and the walk-in set
-- =====================================================================
alter table stages add column if not exists applies_to text not null default 'regular';
do $$ begin
  alter table stages add constraint stages_applies_to_chk check (applies_to in ('regular','walkin','all'));
exception when duplicate_object then null; end $$;

comment on column stages.applies_to is
  'Which job kind may use this stage: regular (every stage before 0107), walkin (Registered, Attended, Interviewed, No Show) or all (Selected, Rejected). Enforced by walkin_ats_before_update().';

update stages set applies_to = 'all' where id in ('selected', 'rejected');

/*
 * notify_candidate = false: a walk-in stage move never messages the
 * candidate by itself (23.18: Selected / Rejected messages are sent by a
 * recruiter, with a template, never automatically; No Show is never
 * announced). candidate_label is what the candidate's own screens print
 * (0051): "Missed" rather than No Show, "Under review" rather than an
 * internal step name. sort_order 101+ puts them after every regular stage,
 * so nothing that walks the regular order meets them first.
 */
insert into stages (id, label, kanban, sort_order, notify_candidate, client_visible, candidate_label, applies_to) values
  ('registered',  'Registered',  false, 101, false, false, 'Registered',   'walkin'),
  ('attended',    'Attended',    false, 102, false, true,  'Attended',     'walkin'),
  ('interviewed', 'Interviewed', false, 103, false, true,  'Under review', 'walkin'),
  ('no_show',     'No Show',     false, 104, false, false, 'Missed',       'walkin')
on conflict (id) do update set
  applies_to       = excluded.applies_to,
  notify_candidate = excluded.notify_candidate,
  candidate_label  = excluded.candidate_label;

/** 'walkin' for a walk-in job, 'regular' for anything else (0083's posting_kind). */
create or replace function job_kind(p_job_id text) returns text
language sql stable security definer set search_path = public as $$
  select case when j.posting_kind = 'walkin' then 'walkin' else 'regular' end
    from jobs j where j.id = p_job_id
$$;

/** May a job of this kind use this stage? */
create or replace function stage_applies(p_stage text, p_kind text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from stages s where s.id = p_stage
                  and (s.applies_to = 'all' or s.applies_to = p_kind))
$$;

-- =====================================================================
-- 2. the walk-in transition table (23.4)
-- =====================================================================
create table if not exists stage_transitions (
  job_kind    text not null check (job_kind in ('walkin')),
  from_stage  text not null references stages(id),
  to_stage    text not null references stages(id),
  is_override boolean not null default false,
  primary key (job_kind, from_stage, to_stage)
);
comment on table stage_transitions is
  'Allowed stage moves per job kind (23.4). Walk-in jobs only: regular jobs keep the free movement they always had. is_override = the move needs a reason, stored in application_stage_history.reason.';

insert into stage_transitions (job_kind, from_stage, to_stage, is_override) values
  ('walkin', 'registered',  'attended',    false),
  ('walkin', 'registered',  'rejected',    false),
  ('walkin', 'registered',  'no_show',     false),
  ('walkin', 'attended',    'interviewed', false),
  ('walkin', 'attended',    'rejected',    false),
  ('walkin', 'interviewed', 'selected',    false),
  ('walkin', 'interviewed', 'rejected',    false),
  ('walkin', 'no_show',     'attended',    true),
  ('walkin', 'selected',    'rejected',    true),
  ('walkin', 'rejected',    'attended',    true),
  ('walkin', 'rejected',    'interviewed', true)
on conflict (job_kind, from_stage, to_stage) do update set is_override = excluded.is_override;

alter table stage_transitions enable row level security;
alter table stage_transitions force row level security;
drop policy if exists stage_transitions_read on stage_transitions;
create policy stage_transitions_read on stage_transitions for select using (true);

-- =====================================================================
-- 3. applications: version, who/when, check-in / attendance, status
-- =====================================================================
alter table applications add column if not exists version        int not null default 1;
alter table applications add column if not exists updated_by     uuid;
alter table applications add column if not exists checked_in_at  timestamptz;
alter table applications add column if not exists checked_in_by  uuid;
alter table applications add column if not exists attended_at    timestamptz;
alter table applications add column if not exists attended_by    uuid;
alter table applications add column if not exists interviewed_at timestamptz;
alter table applications add column if not exists interviewed_by uuid;
alter table applications add column if not exists no_show_at     timestamptz;

/*
 * STATUS IS DERIVED FROM THE STAGE, so the two can never contradict
 * each other (23.4). A generated column rather than a second field a
 * recruiter could set to "Active" on a rejected application.
 */
alter table applications add column if not exists application_status text
  generated always as (case
    when stage = 'hold' then 'On hold'
    when stage in ('selected', 'rejected', 'no_show', 'joined') then 'Closed'
    else 'Active' end) stored;

create index if not exists applications_job_stage_idx on applications (job_id, stage);
create index if not exists applications_job_applied_idx on applications (job_id, applied_at desc);

comment on column applications.version is
  'Bumped on every ATS change (stage, check-in, attendance). A save that names an older version is refused (23.8).';

-- =====================================================================
-- 4. the history: reason, source, override, action (still append-only)
-- =====================================================================
alter table application_stage_history add column if not exists reason      text;
alter table application_stage_history add column if not exists source      text;
alter table application_stage_history add column if not exists is_override boolean not null default false;
alter table application_stage_history add column if not exists action      text not null default 'stage';
create index if not exists ash_app_created_idx on application_stage_history (application_id, created_at);

comment on column application_stage_history.action is
  'stage (a stage move), applied (the insert), checked_in, message_sent. Built into the applicant timeline (23.13).';

/*
 * The trigger 0008 wrote, with the four new facts. Everything it did
 * before it still does, in the same statement: the note travels with the
 * move (app.stage_note), so do the reason, the source and whether the
 * move was an override - all transaction-local settings the definer
 * functions below set just before the UPDATE.
 */
create or replace function log_stage_change() returns trigger
language plpgsql as $$
declare
  v_note   text := nullif(current_setting('app.stage_note', true), '');
  v_raw    text := nullif(current_setting('app.user_id', true), '');
  v_reason text := nullif(current_setting('app.stage_reason', true), '');
  v_src    text := nullif(current_setting('app.stage_source', true), '');
  v_ovr    boolean := coalesce(current_setting('app.stage_override', true), '') = '1';
  v_user   uuid := null;
begin
  if v_raw ~ '^[0-9a-fA-F-]{36}$' then
    v_user := v_raw::uuid;
  end if;
  if v_src is null then
    v_src := case when v_user is null then 'system'
                  when coalesce(current_setting('app.role', true), '') = 'candidate' then 'candidate'
                  else 'recruiter' end;
  end if;

  if tg_op = 'UPDATE' and new.stage is distinct from old.stage then
    insert into application_stage_history
      (application_id, from_stage, to_stage, changed_by, note, reason, source, is_override, action)
    values (new.id, old.stage, new.stage, v_user, v_note, v_reason, v_src, v_ovr, 'stage');
  elsif tg_op = 'INSERT' then
    insert into application_stage_history
      (application_id, from_stage, to_stage, changed_by, note, reason, source, is_override, action)
    values (new.id, null, new.stage, v_user, v_note, null, v_src, false, 'applied');
  end if;
  return new;
end $$;

/* Append-only: the API's role (app_api, which every request runs as) may
   never rewrite a history row - it has no UPDATE grant either; this is the
   second lock. Deletion only ever happens by cascade, with the
   application, which an administrator alone may delete (0002). */
create or replace function stage_history_append_only() returns trigger
language plpgsql as $$
begin
  if current_user::text = 'app_api' then
    raise exception 'The application history is append-only.' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists stage_history_append_only on application_stage_history;
create trigger stage_history_append_only before update on application_stage_history
  for each row execute function stage_history_append_only();

-- =====================================================================
-- 5. the stage machine, in the database
-- =====================================================================

/*
 * A walk-in application starts at Registered, whoever inserts it (the
 * candidate's application form, a recruiter adding somebody, a data
 * migration). Named aa_* so it fires before the other BEFORE INSERT
 * triggers (engagement guard, screening), which then see the real stage.
 */
create or replace function walkin_ats_before_insert() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_kind text := coalesce(job_kind(new.job_id), 'regular');
begin
  if v_kind = 'walkin' then
    if new.stage is null or new.stage not in ('registered', 'attended', 'interviewed', 'no_show') then
      new.stage := 'registered';
    end if;
    new.posting_type := 'walkin';
  elsif exists (select 1 from stages s where s.id = new.stage and s.applies_to = 'walkin') then
    raise exception '"%" is a walk-in stage; this is not a walk-in job.', stage_label(new.stage)
      using errcode = 'TLW07';
  end if;
  return new;
end $$;

drop trigger if exists aa_walkin_ats_insert on applications;
create trigger aa_walkin_ats_insert before insert on applications
  for each row execute function walkin_ats_before_insert();

/*
 * Every stage change, checked.
 *
 *   regular job  a walk-in-only stage is refused; anything else moves as
 *                it always did.
 *   walk-in job  the move must be in stage_transitions; an override move
 *                needs app.stage_reason. A move to a REGULAR-pipeline stage
 *                that nobody asked for explicitly (scheduling an interview
 *                moves the stage to interview_scheduled, an AI interview
 *                finishing moves it to ai_interview_done) does not apply to
 *                a walk-in and is ignored rather than allowed to break that
 *                feature; an explicit one (app.stage_explicit = '1', set by
 *                every recruiter stage endpoint) is refused with a message.
 *
 * Also stamps attended / interviewed / no-show times and bumps `version`
 * on every ATS change (stage, check-in, attendance).
 */
create or replace function walkin_ats_before_update() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_kind     text;
  v_t        record;
  v_allowed  text;
  v_explicit boolean := coalesce(current_setting('app.stage_explicit', true), '') = '1';
begin
  if new.stage is distinct from old.stage then
    perform set_config('app.stage_override', '0', true);
    v_kind := coalesce(job_kind(new.job_id), 'regular');
    if v_kind = 'walkin' then
      if not stage_applies(new.stage, 'walkin') then
        if v_explicit then
          raise exception '"%" is not a stage for walk-in jobs. Walk-in stages are Registered, Attended, Interviewed, Selected, Rejected and No Show.',
            stage_label(new.stage) using errcode = 'TLW07';
        end if;
        new.stage := old.stage;
      elsif stage_applies(old.stage, 'walkin') then
        select * into v_t from stage_transitions t
         where t.job_kind = 'walkin' and t.from_stage = old.stage and t.to_stage = new.stage;
        if not found then
          select string_agg(stage_label(t.to_stage), ', ' order by s.sort_order) into v_allowed
            from stage_transitions t join stages s on s.id = t.to_stage
           where t.job_kind = 'walkin' and t.from_stage = old.stage;
          raise exception 'A walk-in applicant cannot move from % to %.%', stage_label(old.stage), stage_label(new.stage),
            case when v_allowed is null then '' else format(' From %s the next step is: %s.', stage_label(old.stage), v_allowed) end
            using errcode = 'TLW01';
        end if;
        if v_t.is_override then
          if coalesce(btrim(current_setting('app.stage_reason', true)), '') = '' then
            raise exception 'Moving a walk-in applicant from % to % is an override and needs a reason.',
              stage_label(old.stage), stage_label(new.stage) using errcode = 'TLW02';
          end if;
          perform set_config('app.stage_override', '1', true);
        end if;
      end if;
      -- a legacy regular stage on a walk-in job (from before 0107) may move to any walk-in stage
    elsif exists (select 1 from stages s where s.id = new.stage and s.applies_to = 'walkin') then
      raise exception '"%" is a walk-in stage; this is not a walk-in job.', stage_label(new.stage)
        using errcode = 'TLW07';
    end if;

    if new.stage is distinct from old.stage then
      if new.stage = 'attended' and new.attended_at is null then
        new.attended_at := now();
        new.attended_by := app_user_id_safe();
      elsif new.stage = 'interviewed' then
        new.interviewed_at := now();
        new.interviewed_by := app_user_id_safe();
      elsif new.stage = 'no_show' then
        new.no_show_at := now();
      end if;
    end if;
  end if;

  if new.stage is distinct from old.stage
     or new.checked_in_at is distinct from old.checked_in_at
     or new.attended_at is distinct from old.attended_at then
    new.version := old.version + 1;
    new.updated_by := app_user_id_safe();
    new.updated_at := now();
  end if;
  return new;
end $$;

drop trigger if exists aa_walkin_ats_update on applications;
create trigger aa_walkin_ats_update before update on applications
  for each row execute function walkin_ats_before_update();

/*
 * Applications that were already on a walk-in job when this ran: the
 * first steps of the regular pipeline become Registered (logged in the
 * history like any other move, as System). Later regular stages are left
 * as they are - they say more than "Registered" would - and may move to
 * any walk-in stage.
 */
select set_config('app.stage_source', 'system', true);
select set_config('app.stage_reason', 'Walk-in stages introduced (0107)', true);
update applications a set stage = 'registered', posting_type = 'walkin'
  from jobs j
 where j.id = a.job_id and j.posting_kind = 'walkin'
   and a.stage in ('applied', 'ai_screening', 'shortlisted');
select set_config('app.stage_source', '', true);
select set_config('app.stage_reason', '', true);

-- =====================================================================
-- 6. who may manage an application (23.2) - the RLS update rule, as a function
-- =====================================================================
create or replace function ats_can_manage(p_app text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from applications a join jobs j on j.id = a.job_id
     where a.id = p_app
       and (app_is_admin()
            or (app_role() = 'recruiter' and app_recruiter_id() is not null
                and (a.recruiter_id = app_recruiter_id() or j.recruiter_id = app_recruiter_id()))))
$$;

create or replace function ats_job_is_mine(p_job text) returns boolean
language sql stable security definer set search_path = public as $$
  select app_is_admin()
      or (app_role() = 'recruiter' and app_recruiter_id() is not null and exists (
            select 1 from jobs j where j.id = p_job and j.recruiter_id = app_recruiter_id()))
$$;

/** A person's display name for the timeline: recruiter, admin, BDE or candidate. */
create or replace function ats_actor_name(p_user uuid) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select name from recruiters where user_id = p_user),
    (select name from admins     where user_id = p_user),
    (select name from bde_users  where user_id = p_user),
    (select name from candidates where user_id = p_user))
$$;

-- =====================================================================
-- 7. moving a stage - single, bulk
-- =====================================================================
create or replace function ats_move_stage(
  p_app text, p_to text, p_reason text default null,
  p_expected_version int default null, p_source text default 'recruiter')
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  a record;
  n record;
  v_src text := case when p_source = 'system' and app_is_admin() and app_user_id_safe() is null
                     then 'system' else 'recruiter' end;
begin
  if not ats_can_manage(p_app) then
    raise exception 'That application does not exist or is not one you can update.' using errcode = 'TLW06';
  end if;
  if not exists (select 1 from stages where id = p_to) then
    raise exception '"%" is not a pipeline stage.', p_to using errcode = 'TLW07';
  end if;

  select * into a from applications where id = p_app for update;
  if p_expected_version is not null and a.version <> p_expected_version then
    raise exception 'This applicant was updated by someone else. Refresh to see the latest.'
      using errcode = 'TLW03',
            detail = json_build_object('currentVersion', a.version, 'stage', a.stage)::text;
  end if;
  if a.stage = p_to then
    return jsonb_build_object('changed', false, 'id', a.id, 'from', a.stage, 'stage', a.stage, 'version', a.version);
  end if;

  perform set_config('app.stage_explicit', '1', true);
  perform set_config('app.stage_reason', coalesce(btrim(p_reason), ''), true);
  perform set_config('app.stage_note', '', true);
  perform set_config('app.stage_source', v_src, true);
  update applications set stage = p_to where id = p_app returning * into n;
  perform set_config('app.stage_explicit', '', true);
  perform set_config('app.stage_reason', '', true);
  perform set_config('app.stage_source', '', true);

  if n.stage = a.stage then
    raise exception '"%" is not a stage for walk-in jobs.', stage_label(p_to) using errcode = 'TLW07';
  end if;
  return jsonb_build_object('changed', true, 'id', n.id, 'from', a.stage, 'stage', n.stage,
    'version', n.version, 'override', coalesce(current_setting('app.stage_override', true), '') = '1');
end $$;

/*
 * Bulk (23.7): every item validated on its own, valid ones applied,
 * invalid ones skipped WITH the reason, one history row per applicant.
 * All of it in one transaction: the result either commits whole, as
 * reported, or not at all - it cannot half-save silently.
 */
create or replace function ats_bulk_move(p_items jsonb, p_to text, p_reason text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  it      jsonb;
  r       jsonb;
  ok      jsonb := '[]'::jsonb;
  skipped jsonb := '[]'::jsonb;
  v_name  text;
  v_ref   text;
  v_id    text;
begin
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Select at least one applicant.' using errcode = 'TLW08';
  end if;
  if jsonb_array_length(p_items) > 200 then
    raise exception 'Up to 200 applicants can be updated at once.' using errcode = 'TLW08';
  end if;
  for it in select value from jsonb_array_elements(p_items) loop
    v_id := it->>'id';
    v_name := null; v_ref := null;
    if ats_can_manage(v_id) then
      select c.name, a.reference into v_name, v_ref
        from applications a join candidates c on c.id = a.candidate_id where a.id = v_id;
    end if;
    begin
      r := ats_move_stage(v_id, p_to, p_reason, nullif(it->>'version', '')::int, 'recruiter');
      if (r->>'changed')::boolean then
        ok := ok || jsonb_build_array(r || jsonb_build_object('name', v_name, 'reference', v_ref));
      else
        skipped := skipped || jsonb_build_array(jsonb_build_object('id', v_id, 'name', v_name,
          'reference', v_ref, 'code', 'SAME_STAGE', 'reason', 'Already at ' || stage_label(p_to)));
      end if;
    exception when others then
      skipped := skipped || jsonb_build_array(jsonb_build_object('id', v_id, 'name', v_name,
        'reference', v_ref, 'code', sqlstate, 'reason', sqlerrm));
    end;
  end loop;
  return jsonb_build_object('updated', ok, 'skipped', skipped);
end $$;

-- =====================================================================
-- 8. check-in and attendance (23.6)
-- =====================================================================
create or replace function ats_check_in(
  p_app text, p_check_in boolean, p_attend boolean,
  p_override_reason text default null, p_expected_version int default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  a         record;
  j         record;
  n         record;
  v_start   timestamptz;
  v_end     timestamptz;
  v_window  boolean;
  v_reason  text := nullif(btrim(coalesce(p_override_reason, '')), '');
  v_want_in boolean;
  v_want_at boolean;
  v_moved   jsonb := null;
begin
  if not ats_can_manage(p_app) then
    raise exception 'That application does not exist or is not one you can update.' using errcode = 'TLW06';
  end if;
  select * into a from applications where id = p_app for update;
  select * into j from jobs where id = a.job_id;
  if coalesce(j.posting_kind, '') <> 'walkin' then
    raise exception 'Check-in is only for walk-in jobs.' using errcode = 'TLW07';
  end if;
  if p_expected_version is not null and a.version <> p_expected_version then
    raise exception 'This applicant was updated by someone else. Refresh to see the latest.'
      using errcode = 'TLW03',
            detail = json_build_object('currentVersion', a.version, 'stage', a.stage)::text;
  end if;

  v_want_in := coalesce(p_check_in, false) and a.checked_in_at is null;
  v_want_at := coalesce(p_attend, false) and a.stage not in ('attended', 'interviewed', 'selected');
  if not v_want_in and not v_want_at then
    return jsonb_build_object('already', true, 'id', a.id, 'stage', a.stage, 'version', a.version,
      'checkedInAt', a.checked_in_at, 'attendedAt', a.attended_at);
  end if;

  v_start := walkin_starts_at(j.walkin_date, j.walkin_from);
  v_end   := walkin_ends_at(j.walkin_date, j.walkin_to);
  v_window := v_start is not null and now() >= v_start - interval '1 hour' and now() <= v_end;
  if not v_window and v_reason is null then
    raise exception 'Check-in is open from 1 hour before the drive starts until it ends (% %–%). Give a reason to check in outside that window.',
      coalesce(j.walkin_date, 'no date set'), coalesce(nullif(j.walkin_from, ''), '00:00'), coalesce(nullif(j.walkin_to, ''), '23:59')
      using errcode = 'TLW04';
  end if;

  if v_want_in then
    update applications set checked_in_at = now(), checked_in_by = app_user_id_safe()
     where id = p_app returning * into n;
    insert into application_stage_history
      (application_id, from_stage, to_stage, changed_by, note, reason, source, is_override, action)
    values (a.id, a.stage, a.stage, app_user_id_safe(), null,
            case when v_window then null else v_reason end, 'recruiter', not v_window, 'checked_in');
  end if;
  if v_want_at then
    v_moved := ats_move_stage(p_app, 'attended',
      case when v_window then v_reason else coalesce('Outside the drive window: ' || v_reason, v_reason) end,
      null, 'recruiter');
  end if;
  select * into n from applications where id = p_app;
  return jsonb_build_object('already', false, 'id', n.id, 'stage', n.stage, 'version', n.version,
    'checkedIn', v_want_in, 'attended', v_want_at, 'outsideWindow', not v_window,
    'checkedInAt', n.checked_in_at, 'attendedAt', n.attended_at);
end $$;

-- =====================================================================
-- 9. notes, ratings, resume access
-- =====================================================================
create table if not exists application_notes (
  id             bigserial primary key,
  application_id text not null references applications(id) on delete cascade,
  candidate_id   text not null references candidates(id) on delete cascade,
  job_id         text not null references jobs(id) on delete cascade,
  note           text not null check (length(btrim(note)) between 1 and 4000),
  created_by     uuid not null references users(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists application_notes_app_idx on application_notes (application_id, created_at);
comment on table application_notes is
  'Recruiter-only notes per application (23.11). Readable by the recruiters who can manage the application and by admins; never by candidates, clients or BDEs. Editable only by the author; deletable by the author or an admin.';

create table if not exists application_ratings (
  application_id text not null references applications(id) on delete cascade,
  rated_by       uuid not null references users(id),
  rating         int  not null check (rating between 1 and 5),
  rated_at       timestamptz not null default now(),
  primary key (application_id, rated_by)
);
comment on table application_ratings is
  'One 1-5 rating per recruiter per application (23.12); the screens show the average. Never visible to candidates.';

create table if not exists resume_access_log (
  id             bigserial primary key,
  application_id text references applications(id) on delete set null,
  candidate_id   text,
  accessed_by    uuid,
  actor_role     text,
  action         text not null check (action in ('view', 'download')),
  file_path      text,
  ip             text,
  created_at     timestamptz not null default now()
);
create index if not exists resume_access_log_app_idx on resume_access_log (application_id, created_at desc);

alter table application_notes   enable row level security;
alter table application_notes   force row level security;
alter table application_ratings enable row level security;
alter table application_ratings force row level security;
alter table resume_access_log   enable row level security;
alter table resume_access_log   force row level security;

drop policy if exists application_notes_read on application_notes;
create policy application_notes_read on application_notes for select
  using (app_role() in ('recruiter', 'admin') and ats_can_manage(application_id));
drop policy if exists application_notes_insert on application_notes;
create policy application_notes_insert on application_notes for insert
  with check (created_by = app_user_id() and app_role() in ('recruiter', 'admin')
              and ats_can_manage(application_id));
drop policy if exists application_notes_update on application_notes;
create policy application_notes_update on application_notes for update
  using (created_by = app_user_id() and ats_can_manage(application_id))
  with check (created_by = app_user_id());
drop policy if exists application_notes_delete on application_notes;
create policy application_notes_delete on application_notes for delete
  using ((created_by = app_user_id() and ats_can_manage(application_id)) or (app_is_admin() and app_user_id() is not null));

drop policy if exists application_ratings_read on application_ratings;
create policy application_ratings_read on application_ratings for select
  using (app_role() in ('recruiter', 'admin') and ats_can_manage(application_id));
drop policy if exists application_ratings_write on application_ratings;
create policy application_ratings_write on application_ratings for insert
  with check (rated_by = app_user_id() and app_role() in ('recruiter', 'admin') and ats_can_manage(application_id));
drop policy if exists application_ratings_update on application_ratings;
create policy application_ratings_update on application_ratings for update
  using (rated_by = app_user_id() and ats_can_manage(application_id))
  with check (rated_by = app_user_id());
drop policy if exists application_ratings_delete on application_ratings;
create policy application_ratings_delete on application_ratings for delete
  using (rated_by = app_user_id());

-- the log: written by the person who opened the file, read by admins
drop policy if exists resume_access_log_insert on resume_access_log;
create policy resume_access_log_insert on resume_access_log for insert
  with check (accessed_by = app_user_id());
drop policy if exists resume_access_log_read on resume_access_log;
create policy resume_access_log_read on resume_access_log for select
  using (app_is_admin() or (app_role() = 'recruiter' and application_id is not null and ats_can_manage(application_id)));

-- =====================================================================
-- 10. job update history (23.14) and reschedules (23.15)
-- =====================================================================
create table if not exists job_update_history (
  id          bigserial primary key,
  job_id      text not null references jobs(id) on delete cascade,
  field       text not null,
  old_value   text,
  new_value   text,
  updated_by  uuid,
  updated_at  timestamptz not null default now()
);
create index if not exists job_update_history_job_idx on job_update_history (job_id, updated_at desc);
comment on table job_update_history is
  'Every change to a job''s walk-in date, times, venue, address, map link, contact, capacity and status (23.14), plus a row per reschedule notification sent (field = reschedule_notification). Written by triggers only.';

create table if not exists walkin_reschedules (
  id               bigserial primary key,
  job_id           text not null references jobs(id) on delete cascade,
  status           text not null default 'pending'
                     check (status in ('pending', 'sending', 'sent', 'partial', 'failed', 'cancelled', 'no_recipients')),
  old_details      jsonb not null,
  new_details      jsonb not null,
  changed_fields   text[] not null default '{}',
  first_change_at  timestamptz not null default now(),
  last_change_at   timestamptz not null default now(),
  created_by       uuid,
  sent_at          timestamptz,
  recipients       int not null default 0,
  delivered        int not null default 0,
  failed           int not null default 0,
  error            text
);
create index if not exists walkin_reschedules_job_idx on walkin_reschedules (job_id, id desc);
create unique index if not exists walkin_reschedules_one_pending on walkin_reschedules (job_id) where status = 'pending';

create or replace function walkin_details(j jobs) returns jsonb
language sql immutable as $$
  select jsonb_build_object(
    'date', j.walkin_date, 'from', j.walkin_from, 'to', j.walkin_to,
    'venue', j.walkin_venue, 'address', j.walkin_address, 'mapLink', j.walkin_map_link,
    'contact', j.walkin_contact, 'phone', j.walkin_phone)
$$;

/* Moving a walk-in into the past is not a reschedule (23.15): close it. */
create or replace function jobs_walkin_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.posting_kind = 'walkin'
     and coalesce(current_setting('app.role', true), '') in ('recruiter', 'admin')
     and (new.walkin_date is distinct from old.walkin_date
          or new.walkin_from is distinct from old.walkin_from
          or new.walkin_to is distinct from old.walkin_to)
     and new.status = 'open' and not coalesce(new.archived, false)
     and walkin_ends_at(new.walkin_date, new.walkin_to) is not null
     and walkin_ends_at(new.walkin_date, new.walkin_to) < now() then
    raise exception 'The walk-in date and time cannot be moved into the past. To end this drive, close the job instead.'
      using errcode = 'TLW05';
  end if;
  return new;
end $$;
drop trigger if exists aa_jobs_walkin_guard on jobs;
create trigger aa_jobs_walkin_guard before update on jobs
  for each row execute function jobs_walkin_guard();

create or replace function jobs_update_history() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_user   uuid := app_user_id_safe();
  v_fields text[] := '{}';
  v_old    jsonb;
  v_new    jsonb;
  v_pend   record;
  f        record;
begin
  for f in
    select * from (values
      ('walkin_date',     old.walkin_date,              new.walkin_date),
      ('walkin_from',     old.walkin_from,              new.walkin_from),
      ('walkin_to',       old.walkin_to,                new.walkin_to),
      ('walkin_venue',    old.walkin_venue,             new.walkin_venue),
      ('walkin_address',  old.walkin_address,           new.walkin_address),
      ('walkin_map_link', old.walkin_map_link,          new.walkin_map_link),
      ('walkin_contact',  old.walkin_contact,           new.walkin_contact),
      ('walkin_phone',    old.walkin_phone,             new.walkin_phone),
      ('walkin_capacity', old.walkin_capacity::text,    new.walkin_capacity::text),
      ('status',          old.status,                   new.status),
      ('paused',          old.paused::text,             new.paused::text),
      ('archived',        old.archived::text,           new.archived::text)
    ) as t(field, o, n)
  loop
    if f.o is distinct from f.n then
      insert into job_update_history (job_id, field, old_value, new_value, updated_by)
      values (new.id, f.field, f.o, f.n, v_user);
      if f.field in ('walkin_date', 'walkin_from', 'walkin_to', 'walkin_venue', 'walkin_address') then
        v_fields := v_fields || f.field;
      end if;
    end if;
  end loop;

  /* A walk-in whose date, time, venue or address changed: one pending
     reschedule per job, merged with any still waiting, so a recruiter's
     three quick saves become ONE message (the sweep sends it once the
     edits have settled). The details BEFORE the first edit are kept. */
  if new.posting_kind = 'walkin' and array_length(v_fields, 1) > 0 then
    v_old := walkin_details(old);
    v_new := walkin_details(new);
    select * into v_pend from walkin_reschedules where job_id = new.id and status = 'pending' for update;
    if found then
      update walkin_reschedules
         set new_details = v_new,
             changed_fields = (select array_agg(distinct x) from unnest(v_pend.changed_fields || v_fields) x),
             last_change_at = now()
       where id = v_pend.id;
    else
      insert into walkin_reschedules (job_id, old_details, new_details, changed_fields, created_by)
      values (new.id, v_old, v_new, v_fields, v_user);
    end if;
  end if;
  return new;
end $$;
drop trigger if exists jobs_update_history on jobs;
create trigger jobs_update_history after update on jobs
  for each row execute function jobs_update_history();

alter table job_update_history enable row level security;
alter table job_update_history force row level security;
alter table walkin_reschedules enable row level security;
alter table walkin_reschedules force row level security;

drop policy if exists job_update_history_read on job_update_history;
create policy job_update_history_read on job_update_history for select
  using (ats_job_is_mine(job_id));
drop policy if exists job_update_history_engine on job_update_history;
create policy job_update_history_engine on job_update_history for insert
  with check (app_is_admin() and app_user_id() is null);

drop policy if exists walkin_reschedules_read on walkin_reschedules;
create policy walkin_reschedules_read on walkin_reschedules for select
  using (ats_job_is_mine(job_id));
drop policy if exists walkin_reschedules_engine on walkin_reschedules;
create policy walkin_reschedules_engine on walkin_reschedules for update
  using (app_is_admin() and app_user_id() is null)
  with check (app_is_admin() and app_user_id() is null);

/* "Send now" / "Retry" from the recruiter's screen: brings the pending
   one forward, or puts a failed one back in the queue. Their own jobs only. */
create or replace function walkin_reschedule_request(p_id bigint, p_action text) returns text
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  select * into r from walkin_reschedules where id = p_id;
  if not found or not ats_job_is_mine(r.job_id) then
    raise exception 'That notification does not exist.' using errcode = 'TLW06';
  end if;
  if p_action = 'send_now' and r.status = 'pending' then
    update walkin_reschedules set last_change_at = now() - interval '1 day' where id = p_id;
    return 'queued';
  elsif p_action = 'retry' and r.status in ('failed', 'partial') then
    update walkin_reschedules set status = 'sending' where id = p_id;
    return 'retrying';
  end if;
  return r.status;
end $$;

-- =====================================================================
-- 11. messages to candidates and alerts to recruiters (claims = never twice)
-- =====================================================================
create table if not exists walkin_ats_messages (
  id             bigserial primary key,
  application_id text not null references applications(id) on delete cascade,
  candidate_id   text not null,
  job_id         text not null,
  kind           text not null,      -- reminder_day_before | reminder_morning | reschedule | decision_selected | decision_rejected
  dedupe_key     text not null,
  channel        text not null check (channel in ('portal', 'email', 'sms', 'whatsapp')),
  status         text not null default 'claimed',
  to_address     text,
  provider       text,
  provider_ref   text,
  error          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (application_id, kind, dedupe_key, channel)
);
create index if not exists walkin_ats_messages_job_idx on walkin_ats_messages (job_id, kind, dedupe_key);

create table if not exists ats_recruiter_alerts (
  id             bigserial primary key,
  recruiter_id   text not null,
  job_id         text,
  application_id text,
  kind           text not null,      -- new_application | digest | capacity_full | walkin_tomorrow | post_drive | reschedule_saved
  dedupe_key     text not null,
  channel        text not null check (channel in ('portal', 'email')),
  status         text not null default 'claimed',
  to_address     text,
  provider       text,
  error          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (recruiter_id, kind, dedupe_key, channel)
);
create index if not exists ats_recruiter_alerts_job_idx on ats_recruiter_alerts (job_id, kind);

alter table walkin_ats_messages enable row level security;
alter table walkin_ats_messages force row level security;
alter table ats_recruiter_alerts enable row level security;
alter table ats_recruiter_alerts force row level security;

drop policy if exists walkin_ats_messages_read on walkin_ats_messages;
create policy walkin_ats_messages_read on walkin_ats_messages for select
  using (app_role() in ('recruiter', 'admin') and ats_can_manage(application_id));
drop policy if exists walkin_ats_messages_engine on walkin_ats_messages;
create policy walkin_ats_messages_engine on walkin_ats_messages for all
  using (app_is_admin() and app_user_id() is null)
  with check (app_is_admin() and app_user_id() is null);

drop policy if exists ats_recruiter_alerts_read on ats_recruiter_alerts;
create policy ats_recruiter_alerts_read on ats_recruiter_alerts for select
  using (app_is_admin() or (app_role() = 'recruiter' and recruiter_id = app_recruiter_id()));
drop policy if exists ats_recruiter_alerts_engine on ats_recruiter_alerts;
create policy ats_recruiter_alerts_engine on ats_recruiter_alerts for all
  using (app_is_admin() and app_user_id() is null)
  with check (app_is_admin() and app_user_id() is null);

-- =====================================================================
-- 12. settings: per job (new-application alerts) and global (grace)
-- =====================================================================
create table if not exists job_ats_settings (
  job_id                 text primary key references jobs(id) on delete cascade,
  new_application_alerts text not null default 'auto'
                           check (new_application_alerts in ('auto', 'instant', 'digest', 'off')),
  updated_by             uuid,
  updated_at             timestamptz not null default now()
);
alter table job_ats_settings enable row level security;
alter table job_ats_settings force row level security;
drop policy if exists job_ats_settings_rw on job_ats_settings;
create policy job_ats_settings_rw on job_ats_settings for all
  using (ats_job_is_mine(job_id)) with check (ats_job_is_mine(job_id));

create table if not exists walkin_ats_settings (
  id                     int primary key default 1 check (id = 1),
  installed_at           timestamptz not null default now(),
  no_show_grace_minutes  int not null default 60 check (no_show_grace_minutes between 0 and 1440),
  high_volume_per_day    int not null default 20 check (high_volume_per_day > 0)
);
insert into walkin_ats_settings (id) values (1) on conflict (id) do nothing;
alter table walkin_ats_settings enable row level security;
alter table walkin_ats_settings force row level security;
drop policy if exists walkin_ats_settings_read on walkin_ats_settings;
create policy walkin_ats_settings_read on walkin_ats_settings for select using (true);
drop policy if exists walkin_ats_settings_admin on walkin_ats_settings;
create policy walkin_ats_settings_admin on walkin_ats_settings for update
  using (app_is_admin()) with check (app_is_admin());

comment on column walkin_ats_settings.installed_at is
  'Drives that ended before 0107 was applied are never swept to No Show: nobody could mark attendance on them.';

-- =====================================================================
-- 13. No Show (23.16)
-- =====================================================================
/*
 * After the walk-in end time plus the grace period (IST), every
 * application still Registered with no check-in and no attendance moves
 * to No Show, as System. Idempotent by construction: the next run finds
 * nothing still Registered. Reschedule-aware by construction: the end
 * time is read from the job as it is NOW. A drive that was closed (or
 * archived) BEFORE it ended was cancelled, not missed, and is skipped.
 */
create or replace function walkin_mark_no_shows(p_grace_minutes int default null, p_now timestamptz default now())
returns table (application_id text, job_id text)
language plpgsql security definer set search_path = public as $$
declare
  v_grace int;
  v_since timestamptz;
begin
  if not (app_is_admin() and app_user_id_safe() is null) then
    raise exception 'walkin_mark_no_shows is run by the engine only.' using errcode = '42501';
  end if;
  select coalesce(p_grace_minutes, s.no_show_grace_minutes), s.installed_at into v_grace, v_since
    from walkin_ats_settings s where s.id = 1;
  v_grace := coalesce(v_grace, 60);

  perform set_config('app.stage_source', 'system', true);
  perform set_config('app.stage_explicit', '1', true);
  perform set_config('app.stage_note', '', true);
  perform set_config('app.stage_reason',
    format('No check-in or attendance by %s minutes after the drive ended', v_grace), true);

  return query
  with due as (
    select a.id
      from applications a
      join jobs j on j.id = a.job_id
     where j.posting_kind = 'walkin'
       and a.stage = 'registered'
       and a.checked_in_at is null
       and a.attended_at is null
       and walkin_ends_at(j.walkin_date, j.walkin_to) is not null
       and walkin_ends_at(j.walkin_date, j.walkin_to) + make_interval(mins => v_grace) <= p_now
       and walkin_ends_at(j.walkin_date, j.walkin_to) >= coalesce(v_since, '-infinity'::timestamptz)
       and not ((j.status <> 'open' or j.archived) and exists (
             select 1 from job_update_history h
              where h.job_id = j.id and h.field in ('status', 'archived')
                and h.updated_at < walkin_ends_at(j.walkin_date, j.walkin_to)))
     for update of a skip locked
  ), moved as (
    update applications x set stage = 'no_show'
      from due where x.id = due.id
    returning x.id as app_id, x.job_id as app_job
  )
  select moved.app_id, moved.app_job from moved;

  perform set_config('app.stage_source', '', true);
  perform set_config('app.stage_explicit', '', true);
  perform set_config('app.stage_reason', '', true);
end $$;

-- =====================================================================
-- 14. what a candidate may read about their own walk-in applications (23.18)
-- =====================================================================
create or replace function candidate_status_label(p_stage text, p_kind text) returns text
language sql immutable as $$
  select case
    when p_kind = 'walkin' then case p_stage
      when 'registered' then 'Registered' when 'attended' then 'Attended'
      when 'interviewed' then 'Under review' when 'selected' then 'Selected'
      when 'rejected' then 'Not selected' when 'no_show' then 'Missed'
      else 'Registered' end
    else case
      when p_stage in ('applied', 'ai_screening') then 'Applied'
      when p_stage in ('selected', 'offer_extended', 'joined') then 'Selected'
      when p_stage = 'rejected' then 'Not selected'
      else 'Under review' end
  end
$$;

-- =====================================================================
-- 15. one job's applicant list, fast (23.3: 100+ per job)
-- =====================================================================
/*
 * The job's owner (or an admin) sees every application on that job -
 * exactly what the applications policy already grants them through
 * app_job_is_mine(). So for ONE job the scope is decided ONCE, here,
 * instead of row by row by the policy (several definer-function calls per
 * application, which on PGlite costs seconds for a few hundred rows).
 * Anybody else gets nothing. Returns {total, ids} for the page asked for.
 */
create or replace function ats_job_applicant_page(
  p_job text, p_q text default null, p_digits text default null, p_stage text default null,
  p_status text default null, p_from date default null, p_to date default null,
  p_limit int default 25, p_offset int default 0)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_ids text[];
begin
  if not ats_job_is_mine(p_job) then
    return jsonb_build_object('total', 0, 'ids', '[]'::jsonb);
  end if;
  select coalesce(array_agg(x.id order by x.applied_at desc, x.id), '{}') into v_ids
    from (
      select a.id, a.applied_at
        from applications a
       where a.job_id = p_job
         and (p_stage is null or a.stage = p_stage)
         and (p_status is null or a.application_status = p_status)
         and (p_from is null or a.applied_at >= (p_from::timestamp at time zone 'Asia/Kolkata'))
         and (p_to is null or a.applied_at < ((p_to + 1)::timestamp at time zone 'Asia/Kolkata'))
         and (p_q is null
              or a.id ilike p_q or coalesce(a.reference, '') ilike p_q
              or exists (select 1 from candidates c where c.id = a.candidate_id
                           and (c.name ilike p_q or c.email ilike p_q or c.id ilike p_q
                                or coalesce(c.candidate_reference, '') ilike p_q
                                or (p_digits is not null
                                    and regexp_replace(coalesce(c.phone, ''), '\D', '', 'g') like p_digits))))
    ) x;
  return jsonb_build_object('total', coalesce(array_length(v_ids, 1), 0),
    'ids', to_jsonb(coalesce(v_ids[(p_offset + 1):(p_offset + p_limit)], '{}')));
end $$;

/** Current-stage counts of one job, for its owner or an admin (23.5). */
create or replace function ats_job_stage_counts(p_job text) returns jsonb
language sql stable security definer set search_path = public as $$
  select case when ats_job_is_mine(p_job) then
    coalesce((select jsonb_object_agg(stage, n) from
               (select stage, count(*)::int n from applications where job_id = p_job group by stage) s), '{}'::jsonb)
  else '{}'::jsonb end
$$;

-- =====================================================================
-- grants
-- =====================================================================
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant select on stage_transitions to app_api;
    grant select, insert, update, delete on application_notes to app_api;
    grant usage, select on sequence application_notes_id_seq to app_api;
    grant select, insert, update, delete on application_ratings to app_api;
    grant select, insert on resume_access_log to app_api;
    grant usage, select on sequence resume_access_log_id_seq to app_api;
    grant select, insert on job_update_history to app_api;
    grant usage, select on sequence job_update_history_id_seq to app_api;
    grant select, update on walkin_reschedules to app_api;
    grant select, insert, update on walkin_ats_messages to app_api;
    grant usage, select on sequence walkin_ats_messages_id_seq to app_api;
    grant select, insert, update on ats_recruiter_alerts to app_api;
    grant usage, select on sequence ats_recruiter_alerts_id_seq to app_api;
    grant select, insert, update on job_ats_settings to app_api;
    grant select, update on walkin_ats_settings to app_api;
    grant execute on function job_kind(text) to app_api;
    grant execute on function stage_applies(text, text) to app_api;
    grant execute on function ats_can_manage(text) to app_api;
    grant execute on function ats_job_is_mine(text) to app_api;
    grant execute on function ats_actor_name(uuid) to app_api;
    grant execute on function ats_move_stage(text, text, text, int, text) to app_api;
    grant execute on function ats_bulk_move(jsonb, text, text) to app_api;
    grant execute on function ats_check_in(text, boolean, boolean, text, int) to app_api;
    grant execute on function walkin_reschedule_request(bigint, text) to app_api;
    grant execute on function walkin_mark_no_shows(int, timestamptz) to app_api;
    grant execute on function candidate_status_label(text, text) to app_api;
    grant execute on function ats_job_applicant_page(text, text, text, text, text, date, date, int, int) to app_api;
    grant execute on function ats_job_stage_counts(text) to app_api;
    grant execute on function walkin_starts_at(text, text) to app_api;
    grant execute on function walkin_ends_at(text, text) to app_api;
  end if;
end $$;

revoke execute on function walkin_ats_before_insert() from public;
revoke execute on function walkin_ats_before_update() from public;
revoke execute on function jobs_update_history() from public;
revoke execute on function jobs_walkin_guard() from public;
