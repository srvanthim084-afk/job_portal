-- ---------------------------------------------------------------------
-- 0120 — a suspension says why, tells the candidate, and opens ONE retake
--
-- WHAT WAS WRONG
--   * Pressing Submit could end the interview: the page's noise rule and
--     its second-voice rule both treated the INTERVIEWER'S OWN VOICE (and
--     the moment between Submit and the next question) as somebody else in
--     the room. Fixed in the page; nothing here.
--   * A suspension kept a loose label ("Additional Voice detected twice")
--     and nothing else: no reason code, no question number, no message the
--     candidate and the recruiter both read, no email, no way back.
--   * The page's own stops (tab left, camera lost, background noise) ended
--     the interview ON SCREEN ONLY - the database never heard of them, so
--     a recruiter saw an interview that was simply "in progress" forever.
--
-- WHAT THIS ADDS (all of it additive; no existing column or row changes
-- meaning)
--   ai_interviews   suspension_code, suspension_message, suspension_question_no,
--                   detection_count, last_detection_at           the reason
--                   suspension_email_*                           one email, once
--                   retake_available_at, retake_open_notified_at the wait + "open again"
--                   retake_blocked (+ who/when/why)              the recruiter's brake
--                   attempt_number                               1, 2 ... per application
--   applications    extra_interview_attempts                     a recruiter's grant
--
--   ai_interview_suspend()          THE one way an interview becomes suspended.
--                                   A call without a known reason code and a
--                                   message is refused. Idempotent.
--   interview_integrity_report()    the two-strike rule, now suspending through it
--   interview_retake_control()      block / unblock / grant an extra attempt, audited
--   a trigger                       numbers each new attempt for an application
--
-- NOTHING HERE REJECTS A CANDIDATE. A suspended interview is "under
-- recruiter review"; the status words are suspended / under_review, never
-- rejected or failed.
-- ---------------------------------------------------------------------

alter table ai_interviews
  add column if not exists attempt_number int not null default 1 check (attempt_number >= 1),
  add column if not exists suspension_code text,
  add column if not exists suspension_message text,
  add column if not exists suspension_question_no int,
  add column if not exists detection_count int not null default 0 check (detection_count >= 0),
  add column if not exists last_detection_at timestamptz,
  add column if not exists suspension_email_status text,
  add column if not exists suspension_email_attempts int not null default 0,
  add column if not exists suspension_email_sent_at timestamptz,
  add column if not exists retake_available_at timestamptz,
  add column if not exists retake_open_notified_at timestamptz,
  add column if not exists retake_blocked boolean not null default false,
  add column if not exists retake_blocked_by uuid references users(id),
  add column if not exists retake_blocked_at timestamptz,
  add column if not exists retake_block_reason text;

alter table ai_interviews drop constraint if exists ai_interviews_suspension_code_check;
alter table ai_interviews add constraint ai_interviews_suspension_code_check
  check (suspension_code is null or suspension_code in
    ('additional_person', 'additional_voice', 'camera_off', 'left_interview',
     'background_noise', 'repeated_violations'));

alter table applications
  add column if not exists extra_interview_attempts int not null default 0 check (extra_interview_attempts >= 0);

/* Indexes first: an index cannot be created in the same transaction after rows were updated
   ("pending trigger events"), which the backfills below do on a database with interviews in it. */
create index if not exists ai_interviews_app_attempt_idx on ai_interviews (application_id, attempt_number);
create index if not exists ai_interviews_retake_due_idx on ai_interviews (retake_available_at)
  where status = 'suspended' and retake_open_notified_at is null;

/* A new interview for an application is the next attempt. Done here, in the
   database, so no caller can choose its own number or skip one. */
create or replace function ai_interviews_number_attempt() returns trigger
language plpgsql as $$
begin
  if new.application_id is not null then
    new.attempt_number := coalesce(
      (select max(attempt_number) from ai_interviews where application_id = new.application_id), 0) + 1;
  end if;
  return new;
end $$;

drop trigger if exists ai_interviews_number_attempt on ai_interviews;
create trigger ai_interviews_number_attempt before insert on ai_interviews
  for each row execute function ai_interviews_number_attempt();

-- ---------------------------------------------------------------------
-- THE shared suspend
-- ---------------------------------------------------------------------
create or replace function ai_interview_suspend(
  p_interview_id   text,
  p_code           text,
  p_message        text,
  p_question_no    int,
  p_detections     int,
  p_delay_minutes  int,
  p_max_attempts   int,
  p_deadline_hours int,
  p_evidence       jsonb default '{}'::jsonb
) returns table (first_time boolean, retake_at timestamptz, attempt_no int, interview_status text)
language plpgsql security definer set search_path = public as $$
declare
  v        ai_interviews;
  v_extra  int;
  v_used   int;
  v_at     timestamptz;
begin
  /* No reason, no suspension. Every caller names the condition. */
  if p_code is null or p_code not in ('additional_person', 'additional_voice', 'camera_off',
                                      'left_interview', 'background_noise', 'repeated_violations') then
    raise exception 'a suspension needs a known reason code' using errcode = '22023';
  end if;
  if p_message is null or btrim(p_message) = '' then
    raise exception 'a suspension needs a reason message' using errcode = '22023';
  end if;

  select * into v from ai_interviews where id = p_interview_id for update;
  if not found then raise exception 'no such interview session'; end if;

  /* Already suspended: the same answer, and nothing happens twice (no
     second timestamp, no second email, no second retake window). */
  if v.status = 'suspended' then
    return query select false, v.retake_available_at, v.attempt_number, v.status;
    return;
  end if;
  if v.status in ('completed', 'evaluating', 'evaluated', 'expired', 'cancelled') then
    raise exception 'a finished interview cannot be suspended' using errcode = '22023';
  end if;

  /* ONE retake by default: the first suspension of an application opens a
     retake after the wait; a suspended retake does not schedule another.
     A recruiter's block overrides it, and a recruiter can grant more. */
  v_extra := coalesce((select extra_interview_attempts from applications where id = v.application_id), 0);
  v_used  := coalesce((select count(*) from ai_interviews
                        where application_id = v.application_id and status = 'suspended'), 0);   -- before this one
  v_at := case
            when v.application_id is not null
             and not v.retake_blocked
             and v_used + 1 < greatest(1, p_max_attempts) + v_extra
            then now() + make_interval(mins => greatest(0, p_delay_minutes))
            else null end;

  update ai_interviews
     set status = 'suspended',
         integrity_status = 'suspended',
         suspended_at = now(),
         suspension_code = p_code,
         suspension_message = btrim(p_message),
         suspend_reason = coalesce(nullif(suspend_reason, ''), left(btrim(p_message), 240)),
         suspension_question_no = p_question_no,
         detection_count = greatest(coalesce(p_detections, 1), 1),
         last_detection_at = now(),
         retake_available_at = v_at
   where id = v.id;

  /* The deadline to attend moves with the retake: the application's AI
     interview is "due" again, two days after the retake opens - for the
     retake only. An interview that was never suspended is not reopened. */
  if v_at is not null then
    update applications
       set ai_interview_due_at = greatest(coalesce(ai_interview_due_at, v_at),
                                          v_at + make_interval(hours => greatest(1, p_deadline_hours)))
     where id = v.application_id;
  end if;

  insert into ai_interview_audit (interview_id, candidate_id, action, detail, actor_role)
  values (v.id, v.candidate_id, 'interview.suspended',
          jsonb_build_object('code', p_code, 'questionNo', p_question_no, 'detections', p_detections,
                             'attempt', v.attempt_number, 'retakeAvailableAt', v_at,
                             'evidence', coalesce(p_evidence, '{}'::jsonb)),
          'system');

  return query select true, v_at, v.attempt_number, 'suspended'::text;
end $$;

grant execute on function ai_interview_suspend(text, text, text, int, int, int, int, int, jsonb) to app_api;

comment on function ai_interview_suspend(text, text, text, int, int, int, int, int, jsonb) is
  'The one way an interview becomes suspended. Needs a reason code and a message, is idempotent, sets the retake time, never rejects a candidate.';

-- ---------------------------------------------------------------------
-- the two-strike rule, suspending through the shared function
-- ---------------------------------------------------------------------
drop function if exists interview_integrity_report(text, text, numeric, jsonb);

create or replace function interview_integrity_report(
  p_interview_id   text,
  p_type           text,          -- 'additional_person' | 'additional_voice'
  p_confidence     numeric,
  p_evidence       jsonb,
  p_delay_minutes  int default 120,
  p_max_attempts   int default 2,
  p_deadline_hours int default 48
) returns table (
  strike_no int, action text, message text, interview_status text, integrity_status text,
  retake_at timestamptz
)
language plpgsql security definer set search_path = public as $$
declare
  v        record;
  s        record;
  v_n      int;
  v_band   text;
  v_msg    text;
  v_action text;
  v_label  text;
  v_status text;
  v_q      int;
  v_at     timestamptz;
begin
  if p_type not in ('additional_person', 'additional_voice') then
    raise exception 'unknown detection type';
  end if;

  select i.* into v from ai_interviews i where i.id = p_interview_id for update;
  if not found then raise exception 'no such interview session'; end if;

  /* Already stopped: a detector still firing while the suspension screen
     paints must not push the number to three. */
  if v.integrity_status = 'suspended' or v.status = 'suspended' then
    return query select v.integrity_strikes, 'suspended'::text,
      coalesce(v.suspension_message, 'This interview is already suspended.'),
      v.status, v.integrity_status, v.retake_available_at;
    return;
  end if;
  /* A finished interview has nothing left to suspend. */
  if v.status in ('completed', 'evaluating', 'evaluated', 'expired', 'cancelled') then
    return query select v.integrity_strikes, 'ignored'::text,
      'This interview has already finished.'::text, v.status, v.integrity_status, null::timestamptz;
    return;
  end if;

  v_n := v.integrity_strikes + 1;
  v_band := case when p_confidence >= 0.85 then 'high' when p_confidence >= 0.65 then 'medium' else 'low' end;
  v_label := case p_type when 'additional_person' then 'Additional Person' else 'Additional Voice' end;
  /* The question it happened on: what the page saw, else the one after
     the last answer. */
  v_q := coalesce(nullif(p_evidence->>'questionSeq', '')::int, v.questions_answered + 1);

  if v_n >= 2 then
    v_action := 'suspend';
    v_status := 'suspended';
    /* ONE sentence, stored once, shown to the candidate, to the recruiter
       and in the email. Plain words; no "rejected", no "failed". */
    v_msg := case p_type
      when 'additional_person' then 'Another person was detected during your answer to Question ' || v_q || '.'
      else 'Another voice was detected during your answer to Question ' || v_q || '.' end;

    update ai_interviews set integrity_strikes = v_n where id = v.id;
    select * into s from ai_interview_suspend(v.id, p_type, v_msg, v_q, v_n,
                                              p_delay_minutes, p_max_attempts, p_deadline_hours, p_evidence);
    v_at := s.retake_at;
  else
    v_action := 'warn';
    v_status := 'warning';
    v_msg := case p_type
      when 'additional_person' then
        'Warning: Another person appears to be present in the interview area. '
        || 'Please ensure that you are alone and continue the interview.'
      else
        'Warning: Another voice was detected during the interview. Please ensure '
        || 'that you are completing the interview without assistance from another person.'
      end;

    update ai_interviews
       set integrity_strikes = v_n,
           integrity_status  = 'warning',
           detection_count   = v_n,
           last_detection_at = now(),
           status = case when v.status = 'in_progress' then 'warning_issued' else v.status end
     where id = v.id;
  end if;

  insert into ai_interview_flags
    (interview_id, candidate_id, application_id, job_id, flag_type, description,
     evidence, severity, strike_no, confidence, confidence_band, detector,
     warning_message, status_after, occurred_at)
  values
    (v.id, v.candidate_id, v.application_id, v.job_id, p_type, v_label || ' detected',
     coalesce(p_evidence, '{}'::jsonb),
     case when v_n >= 2 then 'high' else 'review' end,
     v_n, p_confidence, v_band,
     coalesce(p_evidence->>'detector', 'browser'),
     v_msg,
     case when v_n >= 2 then 'suspended' else 'warning_issued' end,
     now());

  insert into ai_interview_audit (interview_id, candidate_id, action, detail, actor_role)
  values (v.id, v.candidate_id,
          case when v_n >= 2 then 'integrity.suspended' else 'integrity.warning' end,
          jsonb_build_object('type', p_type, 'strike', v_n, 'confidence', p_confidence, 'band', v_band,
                             'evidence', coalesce(p_evidence, '{}'::jsonb)),
          'system');

  return query select v_n, v_action, v_msg,
    (select i.status from ai_interviews i where i.id = v.id), v_status, v_at;
end $$;

grant execute on function interview_integrity_report(text, text, numeric, jsonb, int, int, int) to app_api;

comment on function interview_integrity_report(text, text, numeric, jsonb, int, int, int) is
  'One confirmed detection in, one decision out. Strike 1 warns; strike 2 suspends through ai_interview_suspend. Counts under a row lock so a reload cannot reset it. Never rejects a candidate.';

-- ---------------------------------------------------------------------
-- a recruiter's controls over the retake: block, unblock, grant one more
-- ---------------------------------------------------------------------
create or replace function interview_retake_control(
  p_interview_id text,
  p_action       text,        -- 'block' | 'unblock' | 'extra_attempt'
  p_reason       text,
  p_actor        uuid
) returns ai_interviews
language plpgsql security definer set search_path = public as $$
declare v ai_interviews;
begin
  if p_action not in ('block', 'unblock', 'extra_attempt') then
    raise exception 'unknown retake action' using errcode = '22023';
  end if;
  if p_reason is null or char_length(btrim(p_reason)) < 3 then
    raise exception 'a reason is required' using errcode = '22023';
  end if;

  select * into v from ai_interviews where id = p_interview_id for update;
  if not found then raise exception 'no such interview'; end if;

  if p_action = 'block' then
    update ai_interviews set retake_blocked = true, retake_blocked_by = p_actor, retake_blocked_at = now(),
           retake_block_reason = btrim(p_reason)
     where id = v.id returning * into v;
  elsif p_action = 'unblock' then
    update ai_interviews set retake_blocked = false, retake_blocked_by = p_actor, retake_blocked_at = now(),
           retake_block_reason = btrim(p_reason),
           /* a block that was set before any retake time existed leaves the
              interview with a recruiter; unblocking it opens the retake now */
           retake_available_at = case when status = 'suspended' and retake_available_at is null
                                      then now() else retake_available_at end
     where id = v.id returning * into v;
  else
    update applications set extra_interview_attempts = extra_interview_attempts + 1
     where id = v.application_id;
    update ai_interviews set retake_blocked = false,
           retake_available_at = case when status = 'suspended'
                                      then least(coalesce(retake_available_at, now()), now()) else retake_available_at end,
           retake_open_notified_at = null
     where id = v.id returning * into v;
  end if;

  insert into ai_interview_audit (interview_id, candidate_id, action, detail, actor_id, actor_role)
  values (v.id, v.candidate_id, 'retake.' || p_action,
          jsonb_build_object('reason', btrim(p_reason), 'attempt', v.attempt_number),
          p_actor, 'recruiter');
  return v;
end $$;

grant execute on function interview_retake_control(text, text, text, uuid) to app_api;

-- ---------------------------------------------------------------------
-- one email, once: claim -> send -> done
-- ---------------------------------------------------------------------
create or replace function ai_interview_notice_claim(p_interview_id text, p_kind text) returns boolean
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if p_kind = 'suspension' then
    update ai_interviews
       set suspension_email_status = 'sending', suspension_email_attempts = suspension_email_attempts + 1
     where id = p_interview_id and status = 'suspended'
       and suspension_email_sent_at is null
       and coalesce(suspension_email_status, '') <> 'sending'
       and suspension_email_attempts < 3;
  elsif p_kind = 'retake_open' then
    update ai_interviews
       set retake_open_notified_at = now()
     where id = p_interview_id and status = 'suspended'
       and retake_open_notified_at is null and not retake_blocked
       and retake_available_at is not null and retake_available_at <= now()
       and not exists (select 1 from ai_interviews n2
                        where n2.application_id = ai_interviews.application_id
                          and n2.attempt_number > ai_interviews.attempt_number);
  else
    raise exception 'unknown notice kind';
  end if;
  get diagnostics n = row_count;
  return n > 0;
end $$;

create or replace function ai_interview_notice_done(p_interview_id text, p_kind text, p_status text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_kind = 'suspension' then
    update ai_interviews
       set suspension_email_status = case when p_status = 'sent' then 'sent' else 'failed' end,
           suspension_email_sent_at = case when p_status = 'sent' then now() else suspension_email_sent_at end
     where id = p_interview_id;
  elsif p_kind = 'retake_open' and p_status <> 'sent' then
    /* The email did not go: let the next pass try again, within reason. */
    update ai_interviews set retake_open_notified_at = null
     where id = p_interview_id and retake_open_notified_at > now() - interval '1 hour'
       and (select count(*) from ai_interview_audit a where a.interview_id = ai_interviews.id and a.action = 'retake.open_email_failed') < 3;
    insert into ai_interview_audit (interview_id, candidate_id, action, detail, actor_role)
    select id, candidate_id, 'retake.open_email_failed', jsonb_build_object('status', p_status), 'system'
      from ai_interviews where id = p_interview_id;
  end if;
end $$;

grant execute on function ai_interview_notice_claim(text, text) to app_api;
grant execute on function ai_interview_notice_done(text, text, text) to app_api;

/* What the sweep needs to find, as the engine: failed suspension emails to
   retry, and retakes that have just opened. */
create or replace function ai_interview_notices_due(p_limit int default 50)
returns table (interview_id text, kind text)
language sql security definer set search_path = public stable as $$
  (select id, 'suspension'::text from ai_interviews
    where status = 'suspended' and suspension_email_sent_at is null
      and suspension_email_status = 'failed' and suspension_email_attempts < 3
      and suspended_at < now() - interval '2 minutes'
    order by suspended_at limit p_limit)
  union all
  (select id, 'retake_open'::text from ai_interviews i
    where status = 'suspended' and retake_open_notified_at is null and not retake_blocked
      and retake_available_at is not null and retake_available_at <= now()
      and not exists (select 1 from ai_interviews n2
                       where n2.application_id = i.application_id and n2.attempt_number > i.attempt_number)
    order by retake_available_at limit p_limit)
$$;

grant execute on function ai_interview_notices_due(int) to app_api;

-- ---------------------------------------------------------------------
-- backfills LAST: row updates leave pending trigger events, after which no DDL
-- on the table is allowed in this transaction
-- ---------------------------------------------------------------------
/* Interviews suspended before this existed: give them the reason they were
   already carrying, in the new columns. They get NO retake window - that
   was never promised to them, so they stay with a recruiter. */
update ai_interviews
   set suspension_code = case
         when coalesce(suspend_reason, '') ilike '%person%' then 'additional_person'
         when coalesce(suspend_reason, '') ilike '%voice%'  then 'additional_voice'
         else 'repeated_violations' end,
       suspension_message = coalesce(nullif(btrim(suspend_reason), ''), 'The interview was suspended.'),
       detection_count = greatest(integrity_strikes, 1),
       last_detection_at = coalesce(suspended_at, last_detection_at)
 where status = 'suspended' and suspension_code is null;

/* Attempt numbers for what already exists: the order the rows were made. */
update ai_interviews a
   set attempt_number = r.n
  from (select id, row_number() over (partition by application_id order by created_at, id) as n
          from ai_interviews where application_id is not null) r
 where a.id = r.id and a.attempt_number is distinct from r.n;
