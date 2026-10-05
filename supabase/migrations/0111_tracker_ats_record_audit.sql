-- ---------------------------------------------------------------------
-- 0111 — the candidate's application tracker, the ATS candidate record,
--        source tracking, referrals, assessments (extension point), the
--        admin audit log, job-view counts and the selected -> employee
--        hand-off (extension point).   (owner's spec 25/26/32/33/35-39/
--        43/44/46/48/50/51)
--
-- WHAT ALREADY EXISTS AND IS REUSED (nothing below replaces it)
--
--   stages / application_stage_history   the one pipeline (0001/0042/
--                         0051/0107). The tracker is a second NAME for a
--                         group of stages, stored on the stage row, so the
--                         rail a candidate reads can never drift from the
--                         stage the recruiter set.
--   stages.candidate_label   what a candidate is shown (0051) - still the
--                         wording for the detailed stage; the tracker
--                         phases contain no "Client" either.
--   interviews (+0098)    the interview, its location type and venue.
--   candidates.source / candidate_source_*()   the 0075 vocabulary,
--                         extended below with the owner's values; the
--                         original source still never changes silently.
--   candidate_activity, application_stage_history, staff_audit
--                         existing audit trails, read by the admin audit
--                         view instead of being copied.
--   candidate_documents (0057), candidate_resume_scores (0094),
--   candidate_code (0109) used as they are.
--
-- WHAT IS NEW
--
--   tracker_phases + stages.tracker_phase    Applied / Under Review /
--                         Shortlisted / Interview / Offer / Hired, plus
--                         Rejected and Hold off the line
--   interviews.reschedule_count / rescheduled_at / completed_at /
--   cancelled_at          so "Rescheduled" and "Interview Completed" are
--                         facts with dates, not guesses
--   applications.source_channel   the source attached to the APPLICATION
--   candidate_referrals, candidate_referral_codes   optional referrals
--   candidate_assessments   extension point only - no tests are run here
--   audit_log + admin_audit_events   the admin audit log
--   job_view_daily        anonymous, aggregate job-view counts
--   employee_handoffs + employee_handoff_payload_v   "Selected ->
--                         TeamLink employee" queue for an HRMS that does
--                         NOT exist yet; nothing is sent anywhere
--   application_records   the data-model view (spec 50)
-- ---------------------------------------------------------------------

/* ===================================================================== *
 * 1. the tracker phases (spec 25)
 * ===================================================================== */
create table if not exists tracker_phases (
  id             text primary key,
  label          text not null,          -- the status a candidate reads
  timeline_label text not null,          -- the step on the rail
  sort_order     int  not null,
  on_line        boolean not null default true   -- false: Rejected, Hold
);

insert into tracker_phases (id, label, timeline_label, sort_order, on_line) values
  ('applied',      'Applied',      'Applied',     10, true),
  ('under_review', 'Under Review', 'HR Review',   20, true),
  ('shortlisted',  'Shortlisted',  'Shortlisted', 30, true),
  ('interview',    'Interview',    'Interview',   40, true),
  ('offer',        'Offer',        'Offer',       50, true),
  ('hired',        'Hired',        'Hired',       60, true),
  ('rejected',     'Rejected',     'Rejected',    70, false),
  ('hold',         'On Hold',      'On Hold',     80, false)
on conflict (id) do update set label = excluded.label, timeline_label = excluded.timeline_label,
  sort_order = excluded.sort_order, on_line = excluded.on_line;

alter table tracker_phases enable row level security;
drop policy if exists tracker_phases_read on tracker_phases;
create policy tracker_phases_read on tracker_phases for select using (true);

alter table stages add column if not exists tracker_phase text references tracker_phases(id);

update stages set tracker_phase = case id
    when 'applied'                  then 'applied'
    when 'registered'               then 'applied'       -- walk-in: registered for the drive
    when 'ai_screening'             then 'under_review'
    when 'with_bde'                 then 'under_review'
    when 'client_review'            then 'under_review'
    when 'shortlisted'              then 'shortlisted'
    when 'ai_interview_pending'     then 'interview'
    when 'interview_scheduled'      then 'interview'
    when 'ai_interview_in_progress' then 'interview'
    when 'ai_interview_done'        then 'interview'
    when 'ai_evaluation_done'       then 'interview'
    when 'client_interview'         then 'interview'
    when 'attended'                 then 'interview'
    when 'interviewed'              then 'interview'
    when 'no_show'                  then 'interview'      -- shown with its own wording ("Missed")
    when 'offer_extended'           then 'offer'
    when 'selected'                 then 'offer'
    when 'joined'                   then 'hired'
    when 'rejected'                 then 'rejected'
    when 'hold'                     then 'hold'
    else coalesce(tracker_phase, 'under_review') end;

comment on column stages.tracker_phase is
  'Which step of the candidate''s application tracker this stage belongs to (0111). A stage added later without one reads as Under Review.';

create or replace function stage_tracker_phase(p_stage text) returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select tracker_phase from stages where id = p_stage), 'under_review')
$$;

/* ===================================================================== *
 * 2. interviews: modes and states (spec 26)
 * ===================================================================== */
alter table interviews add column if not exists reschedule_count int not null default 0;
alter table interviews add column if not exists rescheduled_at   timestamptz;
alter table interviews add column if not exists completed_at     timestamptz;
alter table interviews add column if not exists cancelled_at     timestamptz;

/* Walk-in and Hybrid join the four location types 0098 knows. */
alter table interviews drop constraint if exists interviews_location_type_chk;
alter table interviews add constraint interviews_location_type_chk
  check (location_type is null or location_type in ('in_person','video','phone','teamlink_ai','hybrid','walkin'));

create or replace function interviews_track_changes() returns trigger
language plpgsql as $$
begin
  /* A MOVE of the date or time, not a first fill. starts_at is derived
     from them by the prep kit (0098) and is not counted separately. */
  if new.status = 'Scheduled' and old.status = 'Scheduled'
     and ((old.scheduled_date is not null and new.scheduled_date is distinct from old.scheduled_date)
          or (old.scheduled_time is not null and new.scheduled_time is distinct from old.scheduled_time)) then
    new.reschedule_count := coalesce(old.reschedule_count, 0) + 1;
    new.rescheduled_at := now();
  end if;
  if new.status = 'Completed' and old.status is distinct from 'Completed' then
    new.completed_at := coalesce(new.completed_at, now());
  end if;
  if new.status = 'Cancelled' and old.status is distinct from 'Cancelled' then
    new.cancelled_at := coalesce(new.cancelled_at, now());
  end if;
  return new;
end $$;
drop trigger if exists interviews_track_changes on interviews;
create trigger interviews_track_changes before update on interviews
  for each row execute function interviews_track_changes();

/* The mode a candidate reads: Walk-in, Online, Phone, Hybrid or In person. */
create or replace function interview_mode_label(p_location_type text, p_mode text, p_posting_kind text)
returns text language sql immutable as $$
  select case
    when p_location_type = 'walkin' or (p_posting_kind = 'walkin' and coalesce(p_location_type,'in_person') = 'in_person') then 'Walk-in'
    when p_location_type = 'hybrid' or p_mode ~* 'hybrid' then 'Hybrid'
    when p_location_type = 'phone'  or p_mode ~* 'phone|call\M' and p_mode !~* 'video' then 'Phone'
    when p_location_type in ('video','teamlink_ai') or p_mode ~* 'video|online|zoom|meet|teams|teamlink|\mai\M' then 'Online'
    when p_location_type = 'in_person' or p_mode ~* 'person|office|onsite|face' then 'In person'
    else 'Online' end
$$;

/* Scheduled / Rescheduled / Completed / Cancelled (No Show reads Missed). */
create or replace function interview_state(p_status text, p_reschedules int)
returns text language sql immutable as $$
  select case
    when p_status = 'Scheduled' and coalesce(p_reschedules, 0) > 0 then 'Rescheduled'
    when p_status = 'No Show' then 'Missed'
    else p_status end
$$;

/* ===================================================================== *
 * 3. source tracking (spec 36)
 *
 * The owner's values join the 0075 vocabulary. The old values stay valid
 * (rows already carry them and the reports group by them); new spellings
 * now land on the specific value - "naukri.com" is Naukri, not just a
 * Job Board.
 * ===================================================================== */
create or replace function candidate_source_values() returns text[]
language sql immutable as $$
  select array[
    'Direct Registration',
    'Referral',
    'LinkedIn',
    'Naukri',
    'Indeed',
    'Shine',
    'External Jobs',
    'TeamLink Website',
    'Walk-in Application',
    'Career Site',
    'Job Board',
    'Employee Referral',
    'Agency/Vendor',
    'Campus/Event',
    'Social Media',
    'Talent Community Signup',
    'Manual Entry',
    'Bulk Import',
    'Other'
  ]::text[];
$$;

create or replace function candidate_source_canonical(p_raw text) returns text
language plpgsql immutable as $$
declare v text := lower(btrim(coalesce(p_raw, '')));
begin
  if v = '' then return null; end if;
  if exists (select 1 from unnest(candidate_source_values()) s where lower(s) = v) then
    return (select s from unnest(candidate_source_values()) s where lower(s) = v);
  end if;
  if v ~ 'naukri'   then return 'Naukri'; end if;
  if v ~ 'linkedin' then return 'LinkedIn'; end if;
  if v ~ 'indeed'   then return 'Indeed'; end if;
  if v ~ 'shine'    then return 'Shine'; end if;
  if v ~ 'walk'     then return 'Walk-in Application'; end if;
  if v ~ 'external' then return 'External Jobs'; end if;
  if v ~ 'monster|job ?board|jobboard|foundit' then return 'Job Board'; end if;
  if v ~ 'employee ?referral' then return 'Employee Referral'; end if;
  if v ~ 'refer' then return 'Referral'; end if;
  if v ~ 'agenc|vendor|consultan|partner' then return 'Agency/Vendor'; end if;
  if v ~ 'campus|college|university|event|job ?fair' then return 'Campus/Event'; end if;
  if v ~ 'facebook|instagram|whatsapp|telegram|twitter|social' then return 'Social Media'; end if;
  if v ~ 'teamlink|website' then return 'TeamLink Website'; end if;
  if v ~ 'career ?site|portal' then return 'Career Site'; end if;
  if v ~ 'direct|self.?regist|registration' then return 'Direct Registration'; end if;
  if v ~ 'import|csv|spreadsheet|bulk|excel|xlsx' then return 'Bulk Import'; end if;
  if v ~ 'manual|added by|recruiter|phone|call' then return 'Manual Entry'; end if;
  if v ~ 'talent ?community|signup|sign ?up|subscri' then return 'Talent Community Signup'; end if;
  return 'Other';
end $$;

/* A person who registers themselves came through Direct Registration -
   recorded at the moment it happens, never over a source somebody set.
   'anon' is the role of the registration request (auth.js withUser(null)). */
create or replace function candidates_default_source() returns trigger
language plpgsql as $$
begin
  if new.source is null and new.user_id is not null
     and coalesce(current_setting('app.role', true), '') = 'anon' then
    new.source := 'Direct Registration';
  end if;
  return new;
end $$;
drop trigger if exists candidates_default_source on candidates;
create trigger candidates_default_source before insert on candidates
  for each row execute function candidates_default_source();

/* The source of the APPLICATION: how this application reached us. */
alter table applications add column if not exists source_channel text;
alter table applications drop constraint if exists applications_source_channel_known;
alter table applications add constraint applications_source_channel_known
  check (source_channel is null or source_channel = any (candidate_source_values()));
create index if not exists applications_source_channel_idx on applications (source_channel);

/* ===================================================================== *
 * 4. referrals (spec 38) - optional, never required anywhere
 * ===================================================================== */
create table if not exists candidate_referral_codes (
  candidate_id text primary key references candidates(id) on delete cascade,
  code         text not null unique,
  created_at   timestamptz not null default now()
);

create table if not exists candidate_referrals (
  id                    bigserial primary key,
  referrer_candidate_id text not null references candidates(id) on delete cascade,
  referred_candidate_id text not null references candidates(id) on delete cascade,
  job_id                text references jobs(id) on delete set null,
  referred_at           timestamptz not null default now(),
  status                text not null default 'registered'
                          check (status in ('registered','applied','hired','not_hired','withdrawn')),
  reward_amount         numeric check (reward_amount is null or reward_amount >= 0),
  reward_status         text not null default 'none'
                          check (reward_status in ('none','pending','approved','paid','declined')),
  via                   text not null default 'link' check (via in ('link','staff')),
  recorded_by           uuid,
  notes                 text check (notes is null or char_length(notes) <= 500),
  updated_at            timestamptz not null default now(),
  check (referrer_candidate_id <> referred_candidate_id),
  unique (referred_candidate_id)          -- a person is referred once
);
create index if not exists candidate_referrals_referrer on candidate_referrals (referrer_candidate_id);

alter table candidate_referral_codes enable row level security;
alter table candidate_referrals      enable row level security;

drop policy if exists crc_own on candidate_referral_codes;
create policy crc_own on candidate_referral_codes for select
  using (candidate_id = app_candidate_id() or app_is_admin());

/* Staff read a referral when they can see the referred candidate (RLS on
   candidates decides); the referrer reads the referrals they made. */
drop policy if exists cref_read on candidate_referrals;
create policy cref_read on candidate_referrals for select using (
  app_is_admin()
  or referrer_candidate_id = app_candidate_id()
  or (app_role() in ('recruiter','bde') and exists (
        select 1 from candidates c where c.id = candidate_referrals.referred_candidate_id)));
drop policy if exists cref_staff_write on candidate_referrals;
create policy cref_staff_write on candidate_referrals for all
  using (app_is_admin() or app_role() = 'recruiter')
  with check (app_is_admin() or app_role() = 'recruiter');

/* The candidate's own code, made on first ask. */
create or replace function referral_code_for(p_candidate_id text) returns text
language plpgsql security definer set search_path = public as $$
declare v text;
begin
  if p_candidate_id is null or (p_candidate_id <> coalesce(app_candidate_id(), '') and not app_is_admin()) then
    raise exception 'not your referral code' using errcode = '42501';
  end if;
  select code into v from candidate_referral_codes where candidate_id = p_candidate_id;
  if v is not null then return v; end if;
  loop
    v := 'R' || upper(substr(md5(random()::text || clock_timestamp()::text || p_candidate_id), 1, 8));
    begin
      insert into candidate_referral_codes (candidate_id, code) values (p_candidate_id, v);
      return v;
    exception when unique_violation then
      if exists (select 1 from candidate_referral_codes where candidate_id = p_candidate_id) then
        return (select code from candidate_referral_codes where candidate_id = p_candidate_id);
      end if;
    end;
  end loop;
end $$;

/*
 * A newly registered candidate who arrived through somebody's link.
 * Only the candidate themselves, only within 14 days of registering, only
 * once, never their own code. Answers 'ok', 'already', 'invalid', 'own',
 * 'too_late' - the page says nothing either way; it is optional.
 */
create or replace function referral_claim(p_code text) returns text
language plpgsql security definer set search_path = public as $$
declare v_me text := app_candidate_id(); v_ref text; v_created timestamptz;
begin
  if v_me is null then return 'invalid'; end if;
  select candidate_id into v_ref from candidate_referral_codes where code = upper(btrim(coalesce(p_code, '')));
  if v_ref is null then return 'invalid'; end if;
  if v_ref = v_me then return 'own'; end if;
  if exists (select 1 from candidate_referrals where referred_candidate_id = v_me) then return 'already'; end if;
  select created_at into v_created from candidates where id = v_me;
  if v_created < now() - interval '14 days' then return 'too_late'; end if;
  insert into candidate_referrals (referrer_candidate_id, referred_candidate_id, status, via)
  values (v_ref, v_me,
          case when exists (select 1 from applications where candidate_id = v_me) then 'applied' else 'registered' end,
          'link');
  /* A referral is where they came from when all we knew was "they
     registered themselves"; anything more specific is kept and the
     referral is noted beside it. Either way the history says so (0075). */
  if coalesce((select source from candidates where id = v_me), 'Direct Registration') = 'Direct Registration' then
    perform candidate_source_set(v_me, 'Referral', 'Referral code ' || upper(btrim(p_code)), 'referral');
  else
    perform candidate_source_seen(v_me, 'Referral', 'Referral code ' || upper(btrim(p_code)), 'referral');
  end if;
  return 'ok';
end $$;

/* The referral follows the referred person's applications. */
create or replace function referral_follow_application() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    update candidate_referrals set status = 'applied', updated_at = now()
     where referred_candidate_id = new.candidate_id and status = 'registered';
  elsif new.stage is distinct from old.stage and new.stage = 'joined' then
    update candidate_referrals set status = 'hired', updated_at = now()
     where referred_candidate_id = new.candidate_id and status in ('registered','applied','not_hired');
  end if;
  return null;
end $$;
drop trigger if exists referral_follow_application on applications;
create trigger referral_follow_application after insert or update of stage on applications
  for each row execute function referral_follow_application();

/* ===================================================================== *
 * 5. assessments (spec 33) - an EXTENSION POINT
 *
 * There is no assessment engine in this product and none is built here.
 * This is where a result from one (an external test platform, a test a
 * recruiter conducted) is recorded so recruiters can filter on it.
 * Candidates read their own results and can never write them.
 * ===================================================================== */
create table if not exists candidate_assessments (
  id             bigserial primary key,
  candidate_id   text not null references candidates(id) on delete cascade,
  application_id text references applications(id) on delete set null,
  name           text not null check (char_length(name) between 1 and 120),   -- 'Java', 'Aptitude', ...
  category       text not null default 'Technical'
                   check (category in ('Java','Python','Aptitude','Communication','Technical','Other')),
  score          numeric check (score is null or score >= 0),
  max_score      numeric not null default 100 check (max_score > 0),
  assessed_on    date,
  status         text not null default 'completed'
                   check (status in ('assigned','in_progress','completed','expired','cancelled')),
  provider       text check (provider is null or char_length(provider) <= 120),
  external_ref   text check (external_ref is null or char_length(external_ref) <= 200),
  recorded_by    uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  check (score is null or score <= max_score)
);
create index if not exists cand_assess_candidate on candidate_assessments (candidate_id, assessed_on desc);
create index if not exists cand_assess_name on candidate_assessments (lower(name), status);

alter table candidate_assessments enable row level security;
drop policy if exists cassess_read on candidate_assessments;
create policy cassess_read on candidate_assessments for select using (
  app_is_admin()
  or candidate_id = app_candidate_id()
  or (app_role() in ('recruiter','bde','client') and exists (
        select 1 from candidates c where c.id = candidate_assessments.candidate_id)));
drop policy if exists cassess_write on candidate_assessments;
create policy cassess_write on candidate_assessments for all
  using (app_is_admin() or (app_role() = 'recruiter' and exists (
        select 1 from candidates c where c.id = candidate_assessments.candidate_id)))
  with check (app_is_admin() or (app_role() = 'recruiter' and exists (
        select 1 from candidates c where c.id = candidate_assessments.candidate_id)));

/* ===================================================================== *
 * 6. the admin audit log (spec 39)
 *
 * audit_log records what no existing trail records: candidates created,
 * updated and deleted, resumes and documents, applications submitted and
 * updated, interviews scheduled and rescheduled. Status changes are
 * ALREADY recorded, append-only, in application_stage_history - the view
 * reads them from there rather than writing them twice; likewise source
 * changes (candidate_activity) and staff logins (staff_audit).
 *
 * Field NAMES are recorded, never values: the log says "phone, location
 * changed", not the new phone number.
 * ===================================================================== */
create table if not exists audit_log (
  id            bigserial primary key,
  actor_user_id uuid,
  actor_role    text,
  action        text not null,
  entity        text not null,
  entity_id     text not null,
  detail        jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);
create index if not exists audit_log_when   on audit_log (created_at desc);
create index if not exists audit_log_entity on audit_log (entity, entity_id, created_at desc);
create index if not exists audit_log_action on audit_log (action, created_at desc);

/* Not FORCE: the definer trigger functions below (the table owner) are
   the only writers; app_api has no insert grant and only admins read. */
alter table audit_log enable row level security;
drop policy if exists audit_log_admin on audit_log;
create policy audit_log_admin on audit_log for select using (app_is_admin());

create or replace function audit_write(p_action text, p_entity text, p_entity_id text, p_detail jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare v_raw text := nullif(current_setting('app.user_id', true), '');
begin
  insert into audit_log (actor_user_id, actor_role, action, entity, entity_id, detail)
  values (case when v_raw ~ '^[0-9a-fA-F-]{36}$' then v_raw::uuid end,
          coalesce(nullif(current_setting('app.role', true), ''), 'system'),
          p_action, p_entity, p_entity_id, coalesce(p_detail, '{}'::jsonb));
end $$;

/* Which top-level fields differ, minus the ones that move on their own. */
create or replace function audit_changed_keys(p_old jsonb, p_new jsonb, p_ignore text[])
returns text[] language sql immutable as $$
  select coalesce(array_agg(k order by k), '{}')
    from (select jsonb_object_keys(p_new) k) x
   where not (k = any (p_ignore))
     and (p_old -> k) is distinct from (p_new -> k)
$$;

create or replace function audit_candidates() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_keys text[]; v_resume text[] := array['resume_file','resume_storage_path','resume_mime','resume_size','resume_uploaded_at'];
begin
  if tg_op = 'INSERT' then
    perform audit_write('candidate.created', 'candidate', new.id,
      jsonb_build_object('source', new.source, 'self_registered', new.user_id is not null));
    if new.resume_storage_path is not null then
      perform audit_write('resume.uploaded', 'candidate', new.id, '{}'::jsonb);
    end if;
    return null;
  elsif tg_op = 'DELETE' then
    perform audit_write('candidate.deleted', 'candidate', old.id, '{}'::jsonb);
    return null;
  end if;
  v_keys := audit_changed_keys(to_jsonb(old), to_jsonb(new), array[
    'updated_at','profile_active_days_ago','profile_updated_days_ago','days_silent','follow_up_sent',
    'last_login_at','resume_text','resume_parse_meta','resume_parse_error','resume_parsed_at']);
  if v_keys && v_resume then
    perform audit_write(case when old.resume_storage_path is null and old.resume_file is null
                             then 'resume.uploaded' else 'resume.changed' end,
                        'candidate', new.id, '{}'::jsonb);
  end if;
  v_keys := array(select k from unnest(v_keys) k where not (k = any (v_resume)));
  if array_length(v_keys, 1) > 0 then
    perform audit_write('candidate.updated', 'candidate', new.id, jsonb_build_object('fields', to_jsonb(v_keys)));
  end if;
  return null;
end $$;
drop trigger if exists audit_candidates on candidates;
create trigger audit_candidates after insert or update or delete on candidates
  for each row execute function audit_candidates();

create or replace function audit_applications() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_keys text[];
begin
  if tg_op = 'INSERT' then
    perform audit_write('application.submitted', 'application', new.id,
      jsonb_build_object('job_id', new.job_id, 'candidate_id', new.candidate_id,
                         'job_type', new.posting_type, 'source', new.source_channel));
    return null;
  end if;
  /* Stage moves are in application_stage_history already. */
  v_keys := audit_changed_keys(to_jsonb(old), to_jsonb(new), array[
    'stage','version','updated_at','updated_by','application_status','match_score','ai_score',
    'screening_status','screening_answer_score','screening_combined_score','screening_answered_at',
    'screening_link_nonce','screening_link_expires_at','screening_link_sent_at','screening_reminder_sent_at',
    'screening_auto_rejected_at','ai_interview_due_at','is_primary']);
  if array_length(v_keys, 1) > 0 then
    perform audit_write('application.updated', 'application', new.id, jsonb_build_object('fields', to_jsonb(v_keys)));
  end if;
  return null;
end $$;
drop trigger if exists audit_applications on applications;
create trigger audit_applications after insert or update on applications
  for each row execute function audit_applications();

create or replace function audit_interviews() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform audit_write('interview.scheduled', 'interview', new.id,
      jsonb_build_object('application_id', new.application_id, 'date', new.scheduled_date, 'time', new.scheduled_time));
  elsif (old.scheduled_date is not null and new.scheduled_date is distinct from old.scheduled_date)
     or (old.scheduled_time is not null and new.scheduled_time is distinct from old.scheduled_time) then
    perform audit_write('interview.rescheduled', 'interview', new.id,
      jsonb_build_object('application_id', new.application_id,
                         'from', concat_ws(' ', old.scheduled_date, old.scheduled_time),
                         'to', concat_ws(' ', new.scheduled_date, new.scheduled_time)));
  end if;
  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    perform audit_write('interview.status_changed', 'interview', new.id,
      jsonb_build_object('application_id', new.application_id, 'from', old.status, 'to', new.status));
  end if;
  return null;
end $$;
drop trigger if exists audit_interviews on interviews;
create trigger audit_interviews after insert or update on interviews
  for each row execute function audit_interviews();

create or replace function audit_documents() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    perform audit_write('document.deleted', 'candidate', old.candidate_id, jsonb_build_object('kind', old.kind, 'document_id', old.id));
  else
    perform audit_write(case when tg_op = 'INSERT' then 'document.uploaded' else 'document.updated' end,
      'candidate', new.candidate_id, jsonb_build_object('kind', new.kind, 'document_id', new.id));
  end if;
  return null;
end $$;
drop trigger if exists audit_documents on candidate_documents;
create trigger audit_documents after insert or update or delete on candidate_documents
  for each row execute function audit_documents();

/* Everything the admin audit screen lists, newest first. security_invoker:
   each source keeps its own RLS, and audit_log itself is admin-only. */
create or replace view admin_audit_events with (security_invoker = true) as
  select 'a' || l.id as id, l.created_at as at, l.actor_user_id, l.actor_role,
         l.action, l.entity, l.entity_id, l.detail
    from audit_log l
  union all
  select 'h' || h.id, h.created_at, h.changed_by,
         coalesce(h.source, case when h.changed_by is null then 'system' else 'recruiter' end),
         'status.changed', 'application', h.application_id,
         jsonb_build_object('from', h.from_stage, 'to', h.to_stage, 'override', h.is_override)
    from application_stage_history h
   where h.action = 'stage' and app_is_admin()
  union all
  select 'c' || ca.id, ca.created_at,
         case when ca.actor ~ '^[0-9a-fA-F-]{36}$' then ca.actor::uuid end,
         case when ca.actor ~ '^[0-9a-fA-F-]{36}$' then 'staff' else coalesce(ca.actor, 'system') end,
         'candidate.' || ca.kind, 'candidate', ca.candidate_id,
         ca.detail - 'fromDetail' - 'toDetail' - 'detail'
    from candidate_activity ca
   where app_is_admin()
  union all
  select 's' || s.id, s.created_at,
         case when s.actor_id ~ '^[0-9a-fA-F-]{36}$' then s.actor_id::uuid end, 'admin',
         'staff.' || s.action, s.target_kind, s.target_id, '{}'::jsonb
    from staff_audit s
   where app_is_admin();

/* ===================================================================== *
 * 7. job views (spec 43/44) - a count per job per day, nothing about who
 * ===================================================================== */
create table if not exists job_view_daily (
  job_id text not null references jobs(id) on delete cascade,
  day    date not null,
  views  int  not null default 0,
  primary key (job_id, day)
);
alter table job_view_daily enable row level security;
drop policy if exists job_view_daily_read on job_view_daily;
create policy job_view_daily_read on job_view_daily for select using (
  app_is_admin() or (app_role() = 'recruiter' and exists (
    select 1 from jobs j where j.id = job_view_daily.job_id and j.company_id = app_recruiter_company())));

create or replace function job_view_record(p_job_id text) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from jobs where id = p_job_id and status = 'open') then return false; end if;
  insert into job_view_daily (job_id, day, views)
  values (p_job_id, (now() at time zone 'Asia/Kolkata')::date, 1)
  on conflict (job_id, day) do update set views = job_view_daily.views + 1;
  return true;
end $$;

/* ===================================================================== *
 * 8. Selected -> TeamLink employee hand-off (spec 51) - EXTENSION POINT
 *
 * There is NO HRMS or employee system in this project. When an
 * application reaches Selected or Joined a pending hand-off row is
 * queued; employee_handoff_payload_v maps it FROM the ATS record (no
 * personal data is copied into the queue). Nothing reads the queue and
 * nothing is sent anywhere until an HRMS exists - see
 * docs/ATS-RECORD-AND-TRACKER.md, "HRMS hand-off".
 * ===================================================================== */
create table if not exists employee_handoffs (
  id             bigserial primary key,
  application_id text not null unique references applications(id) on delete cascade,
  candidate_id   text not null references candidates(id) on delete cascade,
  job_id         text not null references jobs(id) on delete cascade,
  trigger_stage  text not null,
  status         text not null default 'pending'
                   check (status in ('pending','sent','acknowledged','cancelled')),
  target         text,                 -- the HRMS it went to, once one exists
  external_ref   text,                 -- that system's employee id
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
alter table employee_handoffs enable row level security;
drop policy if exists employee_handoffs_admin on employee_handoffs;
create policy employee_handoffs_admin on employee_handoffs for select using (app_is_admin());

create or replace function employee_handoff_queue() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.stage is not distinct from old.stage then return null; end if;
  if new.stage in ('selected', 'joined') then
    insert into employee_handoffs (application_id, candidate_id, job_id, trigger_stage)
    values (new.id, new.candidate_id, new.job_id, new.stage)
    on conflict (application_id) do update
      set trigger_stage = excluded.trigger_stage, updated_at = now(),
          status = case when employee_handoffs.status = 'cancelled' then 'pending' else employee_handoffs.status end;
  elsif new.stage = 'rejected' then
    update employee_handoffs set status = 'cancelled', updated_at = now()
     where application_id = new.id and status = 'pending';
  end if;
  return null;
end $$;
drop trigger if exists employee_handoff_queue on applications;
create trigger employee_handoff_queue after update of stage on applications
  for each row execute function employee_handoff_queue();

create or replace view employee_handoff_payload_v with (security_invoker = true) as
  select h.id as handoff_id, h.status, h.trigger_stage, h.created_at, h.updated_at,
         h.application_id, a.reference as application_reference,
         h.candidate_id, c.candidate_code, c.name, c.email, c.phone, c.location,
         h.job_id, j.title as job_title, j.company_id, co.name as company_name,
         j.employment_type,
         o.ctc as offer_ctc, o.joining_date, o.status as offer_status
    from employee_handoffs h
    join applications a on a.id = h.application_id
    join candidates c   on c.id = h.candidate_id
    join jobs j         on j.id = h.job_id
    left join companies co on co.id = j.company_id
    left join lateral (select ctc, joining_date, status from offers
                        where application_id = h.application_id
                        order by extended_at desc limit 1) o on true;

/* ===================================================================== *
 * 9. the data model (spec 50): one row per application with every link
 * ===================================================================== */
create or replace view application_records with (security_invoker = true) as
  select a.id as application_id, a.reference as application_reference,
         a.candidate_id, c.candidate_code, a.job_id, j.company_id,
         coalesce(a.posting_type, j.posting_kind, 'job') as job_type,
         coalesce(a.source_channel, a.source) as source, a.source_channel,
         a.applied_at, a.stage as current_stage, stage_tracker_phase(a.stage) as tracker_phase,
         a.application_status as status, a.updated_at
    from applications a
    join candidates c on c.id = a.candidate_id
    join jobs j on j.id = a.job_id;

/* ===================================================================== *
 * 10. the application's source, set once when it arrives (and backfilled)
 * ===================================================================== */
create or replace function application_source_channel(
  p_candidate_id text, p_job_id text, p_posting_type text, p_source text
) returns text language sql stable security definer set search_path = public as $$
  select case
    when coalesce(p_posting_type, (select posting_kind from jobs where id = p_job_id)) = 'walkin'
      then 'Walk-in Application'
    when p_source = 'external' then 'External Jobs'
    when exists (select 1 from candidate_referrals r where r.referred_candidate_id = p_candidate_id
                  and r.status <> 'withdrawn') then 'Referral'
    when coalesce(p_source, 'portal') in ('portal', 'easy_apply', 'share', 'shared_link') then 'TeamLink Website'
    else candidate_source_canonical(p_source) end
$$;

create or replace function applications_set_source_channel() returns trigger
language plpgsql as $$
begin
  if new.source_channel is null then
    new.source_channel := application_source_channel(new.candidate_id, new.job_id, new.posting_type, new.source);
  else
    new.source_channel := candidate_source_canonical(new.source_channel);
  end if;
  return new;
end $$;
drop trigger if exists applications_set_source_channel on applications;
create trigger applications_set_source_channel before insert on applications
  for each row execute function applications_set_source_channel();

/* Backfill without touching updated_at, version or the audit log: the
   column is new, nothing about the application changed. */
alter table applications disable trigger audit_applications;
alter table applications disable trigger applications_touch;
update applications
   set source_channel = application_source_channel(candidate_id, job_id, posting_type, source)
 where source_channel is null;
alter table applications enable trigger audit_applications;
alter table applications enable trigger applications_touch;

/* ===================================================================== *
 * grants
 * ===================================================================== */
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant select on tracker_phases to app_api;
    grant execute on function stage_tracker_phase(text) to app_api;
    grant execute on function interview_mode_label(text, text, text) to app_api;
    grant execute on function interview_state(text, int) to app_api;
    grant execute on function candidate_source_values() to app_api;
    grant execute on function candidate_source_canonical(text) to app_api;
    grant select on candidate_referral_codes to app_api;
    grant select, insert, update on candidate_referrals to app_api;
    grant usage, select on sequence candidate_referrals_id_seq to app_api;
    grant execute on function referral_code_for(text) to app_api;
    grant execute on function referral_claim(text) to app_api;
    grant select, insert, update, delete on candidate_assessments to app_api;
    grant usage, select on sequence candidate_assessments_id_seq to app_api;
    grant select on audit_log to app_api;
    grant select on admin_audit_events to app_api;
    grant select on job_view_daily to app_api;
    grant execute on function job_view_record(text) to app_api;
    grant select on employee_handoffs to app_api;
    grant select on employee_handoff_payload_v to app_api;
    grant select on application_records to app_api;
    grant execute on function application_source_channel(text, text, text, text) to app_api;
  end if;
end $$;
