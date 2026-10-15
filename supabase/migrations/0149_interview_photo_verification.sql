-- =====================================================================
-- 0149 - AI interview: a confirmed photo, the instructions and the consent
--        come BEFORE an interview can start
--
-- The interview session (questions, deadline, timers) used to be created
-- the moment a candidate opened the interview. It now needs a READY
-- verification for that application first:
--
--   pending -> photo_captured -> photo_confirmed -> ready -> used
--
--   * photo_captured   an image is stored (private storage, encrypted by the API; only its KEY is here)
--   * photo_confirmed  the candidate looked at it and pressed Confirm (a retake replaces the image and
--                      starts the confirmation again)
--   * ready            the instructions were acknowledged AND the consent to the stated processing of the
--                      image was given, against a notice version; this is what the server checks
--   * used             the interview session was created from it (the row is tied to that interview);
--                      one verification starts one session, never two
--
-- The check lives in the database functions and in POST /ai-interviews/session, not in the page.
-- A candidate writes nothing here directly: every change goes through the SECURITY DEFINER functions
-- below, which check the row is the caller's. Staff READ the row under the same visibility as the
-- application (RLS); the image itself is served by an authenticated route, never by a public URL.
--
-- Camera unavailable: the candidate can report it (camera_help_*) and a recruiter/admin can WAIVE the
-- photo for that application (method staff_waiver, with a reason, audited). The instructions are still
-- acknowledged; no image consent is recorded because no image exists.
--
-- Retention: retention_until is set when the photo is stored; a sweep deletes the file and clears the key
-- (image_deleted_at). Interviews that were already running when this was installed are exempt
-- (verification_exempt) so nobody in the middle of an interview is locked out.
-- =====================================================================

create table if not exists ai_interview_verifications (
  id                    text primary key,
  candidate_id          text not null references candidates(id)   on delete cascade,
  application_id        text not null references applications(id) on delete cascade,
  job_id                text not null references jobs(id)         on delete cascade,
  interview_id          text references ai_interviews(id) on delete set null,
  method                text not null default 'photo' check (method in ('photo', 'staff_waiver')),
  status                text not null default 'pending'
                          check (status in ('pending', 'photo_captured', 'photo_confirmed', 'ready', 'used', 'expired', 'cancelled')),
  -- the image: a storage KEY (never a URL), what it is, how big, its hash
  image_path            text,
  image_mime            text,
  image_size            int,
  image_sha256          text,
  image_replaced_count  int not null default 0,
  captured_at           timestamptz,
  image_confirmed_at    timestamptz,
  instructions_ack_at   timestamptz,
  consent_given         boolean not null default false,
  consent_at            timestamptz,
  notice_version        text,
  verified_at           timestamptz,
  session_started_at    timestamptz,
  retention_until       timestamptz,
  image_deleted_at      timestamptz,
  camera_help_at        timestamptz,
  camera_help_note      text,
  waived_by             uuid references users(id),
  waived_at             timestamptz,
  waive_reason          text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index if not exists aiv_application_idx on ai_interview_verifications (application_id, created_at desc);
create index if not exists aiv_candidate_idx   on ai_interview_verifications (candidate_id);
create index if not exists aiv_interview_idx   on ai_interview_verifications (interview_id);
create index if not exists aiv_retention_idx   on ai_interview_verifications (retention_until)
  where image_path is not null;

alter table ai_interview_verifications enable row level security;
alter table ai_interview_verifications force  row level security;

-- Exactly the application's own visibility: the candidate (their own), the recruiter / client for that
-- company, a BDE, an admin. Nobody else.
drop policy if exists aiv_read on ai_interview_verifications;
create policy aiv_read on ai_interview_verifications for select using (
  exists (select 1 from applications a where a.id = ai_interview_verifications.application_id)
);

alter table ai_interviews add column if not exists verification_exempt boolean not null default false;
alter table ai_interviews add column if not exists verification_id text;

-- Interviews already under way when this was installed carry on without a photo.
update ai_interviews set verification_exempt = true
 where status in ('in_progress', 'warning_issued', 'scheduled', 'rescheduled');

-- ---------------------------------------------------------------------
-- the audit line every function below writes (no image, no address, no browser string)
-- ---------------------------------------------------------------------
create or replace function ai_verification_audit(
  p_candidate text, p_interview text, p_action text, p_detail jsonb, p_actor uuid default null, p_role text default 'candidate'
) returns void
language sql security definer set search_path = public as $$
  insert into ai_interview_audit (interview_id, candidate_id, action, detail, actor_id, actor_role)
  values (p_interview, p_candidate, p_action, coalesce(p_detail, '{}'::jsonb), p_actor, p_role);
$$;

-- ---------------------------------------------------------------------
-- begin (or carry on with) the verification for one application
-- ---------------------------------------------------------------------
create or replace function ai_verification_begin(
  p_id text, p_candidate text, p_application text, p_valid_minutes int default 180
) returns ai_interview_verifications
language plpgsql security definer set search_path = public as $$
declare
  a   record;
  v   ai_interview_verifications;
begin
  select id, candidate_id, job_id into a from applications where id = p_application and candidate_id = p_candidate;
  if not found then raise exception 'that application is not yours'; end if;

  -- an unfinished verification that sat too long is closed, so a photo cannot be kept for later
  update ai_interview_verifications
     set status = 'expired', updated_at = now()
   where application_id = p_application and candidate_id = p_candidate
     and status in ('pending', 'photo_captured', 'photo_confirmed', 'ready')
     and created_at < now() - make_interval(mins => greatest(1, p_valid_minutes));

  select * into v from ai_interview_verifications
   where application_id = p_application and candidate_id = p_candidate
     and status in ('pending', 'photo_captured', 'photo_confirmed', 'ready')
   order by created_at desc limit 1;
  if found then return v; end if;

  insert into ai_interview_verifications (id, candidate_id, application_id, job_id)
  values (p_id, p_candidate, p_application, a.job_id)
  returning * into v;
  perform ai_verification_audit(p_candidate, null, 'verification.started',
    jsonb_build_object('verificationId', v.id, 'applicationId', p_application));
  return v;
end $$;

-- ---------------------------------------------------------------------
-- a photo was stored: it replaces any earlier unconfirmed one and restarts the confirmation
-- returns the key of the file it replaced (the route deletes it)
-- ---------------------------------------------------------------------
create or replace function ai_verification_photo(
  p_id text, p_candidate text, p_path text, p_mime text, p_size int, p_sha text, p_retention_days int
) returns text
language plpgsql security definer set search_path = public as $$
declare v ai_interview_verifications; old text;
begin
  select * into v from ai_interview_verifications where id = p_id and candidate_id = p_candidate for update;
  if not found then raise exception 'no such verification'; end if;
  if v.status not in ('pending', 'photo_captured', 'photo_confirmed', 'ready') then
    raise exception 'this verification is closed';
  end if;
  if v.method = 'staff_waiver' then raise exception 'the photo was waived for this interview'; end if;
  old := v.image_path;
  update ai_interview_verifications
     set image_path = p_path, image_mime = p_mime, image_size = p_size, image_sha256 = p_sha,
         image_replaced_count = image_replaced_count + case when old is null then 0 else 1 end,
         captured_at = now(), image_confirmed_at = null,
         instructions_ack_at = null, consent_given = false, consent_at = null, notice_version = null,
         verified_at = null, status = 'photo_captured',
         retention_until = now() + make_interval(days => greatest(1, p_retention_days)),
         image_deleted_at = null, updated_at = now()
   where id = p_id;
  perform ai_verification_audit(p_candidate, null, 'verification.photo_captured',
    jsonb_build_object('verificationId', p_id, 'applicationId', v.application_id, 'size', p_size,
                       'retake', old is not null));
  return old;
end $$;

-- ---------------------------------------------------------------------
-- the candidate looked at the photo and confirmed it
-- ---------------------------------------------------------------------
create or replace function ai_verification_confirm(p_id text, p_candidate text)
returns ai_interview_verifications
language plpgsql security definer set search_path = public as $$
declare v ai_interview_verifications;
begin
  select * into v from ai_interview_verifications where id = p_id and candidate_id = p_candidate for update;
  if not found then raise exception 'no such verification'; end if;
  if v.status in ('photo_confirmed', 'ready') then return v; end if;      -- idempotent
  if v.status <> 'photo_captured' or v.image_path is null then
    raise exception 'capture a photo first';
  end if;
  update ai_interview_verifications
     set image_confirmed_at = now(), status = 'photo_confirmed', updated_at = now()
   where id = p_id returning * into v;
  perform ai_verification_audit(p_candidate, null, 'verification.photo_confirmed',
    jsonb_build_object('verificationId', p_id, 'applicationId', v.application_id));
  return v;
end $$;

-- ---------------------------------------------------------------------
-- the instructions were acknowledged and the consent was given: the verification is READY
-- ---------------------------------------------------------------------
create or replace function ai_verification_consent(
  p_id text, p_candidate text, p_notice_version text, p_instructions boolean, p_consent boolean
) returns ai_interview_verifications
language plpgsql security definer set search_path = public as $$
declare v ai_interview_verifications;
begin
  select * into v from ai_interview_verifications where id = p_id and candidate_id = p_candidate for update;
  if not found then raise exception 'no such verification'; end if;
  if v.status = 'ready' then return v; end if;                             -- idempotent
  if p_instructions is not true then raise exception 'the instructions must be acknowledged'; end if;
  if v.method = 'photo' then
    if v.status <> 'photo_confirmed' or v.image_path is null then raise exception 'confirm your photo first'; end if;
    if p_consent is not true then raise exception 'the consent is required'; end if;
  elsif v.status <> 'pending' then
    raise exception 'this verification is closed';
  end if;
  update ai_interview_verifications
     set instructions_ack_at = now(),
         consent_given = (v.method = 'photo'), consent_at = case when v.method = 'photo' then now() end,
         notice_version = left(p_notice_version, 40),
         verified_at = now(), status = 'ready', updated_at = now()
   where id = p_id returning * into v;
  perform ai_verification_audit(p_candidate, null, 'verification.ready',
    jsonb_build_object('verificationId', p_id, 'applicationId', v.application_id,
                       'noticeVersion', left(p_notice_version, 40), 'method', v.method));
  return v;
end $$;

-- ---------------------------------------------------------------------
-- is there a READY verification for this application, fresh enough?   (read only; the route calls it
-- BEFORE the questions are generated)
-- ---------------------------------------------------------------------
create or replace function ai_verification_ready(p_candidate text, p_application text, p_valid_minutes int default 180)
returns text
language sql stable security definer set search_path = public as $$
  select id from ai_interview_verifications
   where candidate_id = p_candidate and application_id = p_application and status = 'ready'
     and verified_at > now() - make_interval(mins => greatest(1, p_valid_minutes))
   order by verified_at desc limit 1;
$$;

-- ---------------------------------------------------------------------
-- the interview was created: tie the verification to it, once. Returns false when somebody else
-- got there first (the route then rolls the new interview back).
-- ---------------------------------------------------------------------
create or replace function ai_verification_claim(p_id text, p_candidate text, p_interview text)
returns boolean
language plpgsql security definer set search_path = public as $$
declare n int; v ai_interview_verifications;
begin
  update ai_interview_verifications
     set status = 'used', interview_id = p_interview, session_started_at = now(), updated_at = now()
   where id = p_id and candidate_id = p_candidate and status = 'ready' and interview_id is null
   returning * into v;
  get diagnostics n = row_count;
  if n = 0 then return false; end if;
  update ai_interviews set verification_id = p_id where id = p_interview;
  perform ai_verification_audit(p_candidate, p_interview, 'verification.session_authorized',
    jsonb_build_object('verificationId', p_id, 'applicationId', v.application_id));
  return true;
end $$;

-- ---------------------------------------------------------------------
-- camera unavailable: the candidate says so (staff are told by the route)
-- ---------------------------------------------------------------------
create or replace function ai_verification_camera_help(p_id text, p_candidate text, p_note text)
returns void
language plpgsql security definer set search_path = public as $$
declare v ai_interview_verifications;
begin
  select * into v from ai_interview_verifications where id = p_id and candidate_id = p_candidate for update;
  if not found then raise exception 'no such verification'; end if;
  update ai_interview_verifications
     set camera_help_at = now(), camera_help_note = nullif(left(btrim(coalesce(p_note, '')), 300), ''), updated_at = now()
   where id = p_id;
  perform ai_verification_audit(p_candidate, null, 'verification.camera_help_requested',
    jsonb_build_object('verificationId', p_id, 'applicationId', v.application_id));
end $$;

-- ---------------------------------------------------------------------
-- a recruiter / admin waives the photo for one application (camera unavailable). The route has already
-- checked that the person may see this application.
-- ---------------------------------------------------------------------
create or replace function ai_verification_waive(
  p_id text, p_application text, p_actor uuid, p_role text, p_reason text, p_valid_minutes int default 180
) returns ai_interview_verifications
language plpgsql security definer set search_path = public as $$
declare a record; v ai_interview_verifications;
begin
  if p_reason is null or btrim(p_reason) = '' then raise exception 'a reason is required'; end if;
  select id, candidate_id, job_id into a from applications where id = p_application;
  if not found then raise exception 'no such application'; end if;

  update ai_interview_verifications set status = 'cancelled', updated_at = now()
   where application_id = p_application and status in ('pending', 'photo_captured', 'photo_confirmed', 'ready');

  insert into ai_interview_verifications (id, candidate_id, application_id, job_id, method, waived_by, waived_at, waive_reason)
  values (p_id, a.candidate_id, a.id, a.job_id, 'staff_waiver', p_actor, now(), left(btrim(p_reason), 300))
  returning * into v;
  perform ai_verification_audit(a.candidate_id, null, 'verification.photo_waived',
    jsonb_build_object('verificationId', p_id, 'applicationId', a.id, 'reason', left(btrim(p_reason), 300)),
    p_actor, p_role);
  return v;
end $$;

-- ---------------------------------------------------------------------
-- retention: the images whose time is up, and the note that one was removed
-- ---------------------------------------------------------------------
create or replace function ai_verification_images_due(p_limit int default 200)
returns table (id text, image_path text)
language sql stable security definer set search_path = public as $$
  select v.id, v.image_path from ai_interview_verifications v
   where v.image_path is not null and v.retention_until is not null and v.retention_until < now()
   order by v.retention_until limit greatest(1, p_limit);
$$;

create or replace function ai_verification_image_removed(p_id text)
returns void
language plpgsql security definer set search_path = public as $$
declare v ai_interview_verifications;
begin
  update ai_interview_verifications
     set image_path = null, image_deleted_at = now(), updated_at = now()
   where id = p_id and image_path is not null
   returning * into v;
  if found then
    perform ai_verification_audit(v.candidate_id, v.interview_id, 'verification.photo_deleted',
      jsonb_build_object('verificationId', p_id, 'reason', 'retention period ended'), null, 'system');
  end if;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant select on ai_interview_verifications to app_api;
    grant execute on function ai_verification_begin(text, text, text, int) to app_api;
    grant execute on function ai_verification_photo(text, text, text, text, int, text, int) to app_api;
    grant execute on function ai_verification_confirm(text, text) to app_api;
    grant execute on function ai_verification_consent(text, text, text, boolean, boolean) to app_api;
    grant execute on function ai_verification_ready(text, text, int) to app_api;
    grant execute on function ai_verification_claim(text, text, text) to app_api;
    grant execute on function ai_verification_camera_help(text, text, text) to app_api;
    grant execute on function ai_verification_waive(text, text, uuid, text, text, int) to app_api;
    grant execute on function ai_verification_images_due(int) to app_api;
    grant execute on function ai_verification_image_removed(text) to app_api;
    grant execute on function ai_verification_audit(text, text, text, jsonb, uuid, text) to app_api;
  end if;
end $$;
