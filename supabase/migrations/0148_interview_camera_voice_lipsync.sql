-- ---------------------------------------------------------------------
-- 0148 - the AI interview: camera hidden, background voices, lips that do not match the voice
--
--   * CAMERA HIDDEN / COVERED for more than 10 seconds (the page reports it) suspends the interview AT ONCE -
--     no warning first.
--   * A VOICE IN THE BACKGROUND (another voice, or noise while the room should be quiet) warns TWICE and the
--     THIRD time suspends. It has its own counter (ai_interviews.voice_strikes), so a tab switch or a second
--     person does not use up a voice warning.
--   * LIPS DO NOT MATCH THE VOICE: while the candidate answers and a voice is heard, the lips must move. When
--     the page sees sound with no lip movement for a sustained stretch it reports 'lip_sync' and the interview
--     is suspended at once (reason code lip_sync).
--   Unchanged: a person / tab leaving keep their two strikes; a low-confidence detection never suspends;
--   nothing is counted once every question is answered; a recruiter reopening clears the strikes (now the
--   voice strikes too); reason, message, email and retake (0120).
-- ---------------------------------------------------------------------
alter table ai_interviews add column if not exists voice_strikes int not null default 0;

alter table ai_interviews drop constraint if exists ai_interviews_suspension_code_check;
alter table ai_interviews add constraint ai_interviews_suspension_code_check
  check (suspension_code is null or suspension_code in
    ('additional_person', 'additional_voice', 'camera_off', 'left_interview',
     'background_noise', 'repeated_violations', 'lip_sync'));

/* The one suspend function keeps its body (0143); only the list of reason codes it accepts grows. */
do $$
declare d text;
begin
  select pg_get_functiondef('ai_interview_suspend(text,text,text,int,int,int,int,int,jsonb)'::regprocedure) into d;
  d := replace(d, '''background_noise'', ''repeated_violations'') then', '''background_noise'', ''repeated_violations'', ''lip_sync'') then');
  if d not like '%lip_sync%' then raise exception 'ai_interview_suspend: reason code list not found'; end if;
  execute d;
end $$;

drop function if exists interview_integrity_report(text, text, numeric, jsonb, int, int, int);

create or replace function interview_integrity_report(
  p_interview_id   text,
  p_type           text,   -- additional_person | additional_voice | left_interview | background_noise | camera_off | lip_sync
  p_confidence     numeric,
  p_evidence       jsonb,
  p_delay_minutes  int default 720,
  p_max_attempts   int default 2,
  p_deadline_hours int default 48,
  p_incident_seconds int default 20
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
  v_voice  boolean;   -- a voice in the background: warn twice, suspend the third time
  v_imm    boolean;   -- camera hidden / lips not matching the voice: suspend at once
  v_vn     int;
  v_susp   boolean;
  v_recent boolean;
  v_last   boolean;
begin
  if p_type not in ('additional_person', 'additional_voice', 'left_interview', 'background_noise', 'camera_off', 'lip_sync') then
    raise exception 'unknown detection type';
  end if;

  select i.* into v from ai_interviews i where i.id = p_interview_id for update;
  if not found then raise exception 'no such interview session'; end if;

  if v.integrity_status = 'suspended' or v.status = 'suspended' then
    return query select v.integrity_strikes, 'suspended'::text,
      coalesce(v.suspension_message, 'This interview is already suspended.'),
      v.status, v.integrity_status, v.retake_available_at;
    return;
  end if;
  if v.status in ('completed', 'evaluating', 'evaluated', 'expired', 'cancelled') then
    return query select v.integrity_strikes, 'ignored'::text,
      'This interview has already finished.'::text, v.status, v.integrity_status, null::timestamptz;
    return;
  end if;

  /* 1. THE LAST ANSWER IS IN. Once every question (and any follow-up that was asked) has been
        answered, the interview is being submitted and scored - nothing seen after that is a
        violation of anything. This is the window in which a final Submit used to end as
        "suspended": scoring takes a while, the status is still in_progress, and the candidate
        relaxes, looks away or talks to somebody. */
  if not exists (
        select 1 from ai_interview_answers a
         where a.ai_interview_id = v.id
           and not exists (select 1 from ai_interview_answer_parts p
                            where p.interview_id = v.id and p.seq = a.seq and p.part = 'main'
                              and p.submitted_at is not null))
     and not exists (select 1 from ai_interview_answer_parts p
                      where p.interview_id = v.id and p.part = 'followup' and p.submitted_at is null)
     and exists (select 1 from ai_interview_answers a where a.ai_interview_id = v.id) then
    return query select v.integrity_strikes, 'ignored'::text,
      'Every question has been answered.'::text, v.status, v.integrity_status, null::timestamptz;
    return;
  end if;

  v_band := case when p_confidence >= 0.85 then 'high' when p_confidence >= 0.65 then 'medium' else 'low' end;
  v_q := coalesce(nullif(p_evidence->>'questionSeq', '')::int, v.questions_answered + 1);
  v_voice := p_type in ('additional_voice', 'background_noise');
  v_imm   := p_type in ('camera_off', 'lip_sync');

  /* 2. ONE INCIDENT IS ONE STRIKE. The page (noise, tab, camera) and the integrity module
        (second person, second voice) watch independently, each with its own cooldown, so one
        sound in the room could be reported twice within a second - and two reports were two
        strikes, a suspension, for a single moment. A detection within p_incident_seconds of
        the last counted one is recorded for the recruiter and changes nothing.
     3. AN UNCERTAIN DETECTION NEVER SUSPENDS. A low-confidence observation is recorded and the
        candidate sees the warning again; it is not a strike. The threshold itself (the
        second strike suspends) is unchanged. */
  /* A hidden camera or lips that do not match the voice are never "the same moment" as an earlier warning. */
  v_last   := v.last_detection_at is not null
              and v.last_detection_at > now() - make_interval(secs => p_incident_seconds);
  v_recent := not v_imm and (v.integrity_strikes > 0 or v.voice_strikes > 0) and v_last;
  if v_recent or v_band = 'low' then
    v_action := case when v_band = 'low' and not v_last then 'warn' else 'noted' end;
    v_msg := case when v_action = 'warn' then
      'Warning: Please make sure you are alone, in a quiet place, with the interview window in front and your camera on.'
      else 'Recorded as part of the same moment as the previous warning.' end;
    insert into ai_interview_flags
      (interview_id, candidate_id, application_id, job_id, flag_type, description,
       evidence, severity, strike_no, confidence, confidence_band, detector,
       warning_message, status_after, occurred_at)
    values
      (v.id, v.candidate_id, v.application_id, v.job_id, p_type,
       case p_type
         when 'additional_person' then 'Additional Person'
         when 'additional_voice'  then 'Additional Voice'
         when 'left_interview'    then 'Left the interview window'
         when 'background_noise'  then 'Continuous background noise'
         when 'lip_sync'          then 'Lips did not match the voice'
         else 'Camera off' end
       || case when v_band = 'low' then ' (uncertain - not counted)' else ' (same moment - not counted)' end,
       coalesce(p_evidence, '{}'::jsonb), 'review', v.integrity_strikes, p_confidence, v_band,
       coalesce(p_evidence->>'detector', 'browser'), v_msg, v.status, now());
    insert into ai_interview_audit (interview_id, candidate_id, action, detail, actor_role)
    values (v.id, v.candidate_id, 'integrity.noted',
            jsonb_build_object('type', p_type, 'strike', v.integrity_strikes, 'confidence', p_confidence,
                               'band', v_band, 'counted', false, 'questionSeq', v_q), 'system');
    if v_action = 'warn' then
      update ai_interviews set last_detection_at = now() where id = v.id;
    end if;
    return query select case when v_voice then v.voice_strikes else v.integrity_strikes end,
                        v_action, v_msg, v.status, v.integrity_status, null::timestamptz;
    return;
  end if;

  v_vn := v.voice_strikes + 1;
  v_n := case when v_voice then v_vn else v.integrity_strikes + 1 end;
  /* the rule: a hidden camera / mismatched lips suspend at once; a background voice warns twice and
     suspends the third time; everything else is the old two strikes */
  v_susp := v_imm or (v_voice and v_n >= 3) or (not v_voice and not v_imm and v_n >= 2);
  v_label := case p_type
    when 'additional_person' then 'Additional Person'
    when 'additional_voice'  then 'Additional Voice'
    when 'left_interview'    then 'Left the interview window'
    when 'background_noise'  then 'Continuous background noise'
    when 'lip_sync'          then 'Lips did not match the voice'
    else 'Camera off' end;

  if v_susp then
    v_action := 'suspend';
    v_status := 'suspended';
    v_msg := case p_type
      when 'additional_person' then 'Another person was detected during your answer to Question ' || v_q || '.'
      when 'additional_voice'  then 'Another voice was detected during your answer to Question ' || v_q || '.'
      when 'left_interview'    then 'The interview window was not in front during your answer to Question ' || v_q || '.'
      when 'background_noise'  then 'Continuous background noise was detected during Question ' || v_q || '.'
      when 'lip_sync'          then 'Your lip movement did not match your voice during Question ' || v_q || '.'
      else 'Your camera was off for too long during Question ' || v_q || '.' end;

    update ai_interviews
       set integrity_strikes = case when v_voice then integrity_strikes else v_n end,
           voice_strikes     = case when v_voice then v_vn else voice_strikes end
     where id = v.id;
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
      when 'additional_voice' then
        'Warning: Another voice was detected during the interview. Please ensure '
        || 'that you are completing the interview without assistance from another person.'
      when 'left_interview' then
        'Warning: The interview window was not in front. Please keep it in front and continue the interview. '
        || 'Leaving it again may suspend the interview.'
      when 'background_noise' then
        'Warning: Continuous background noise was detected. Please move somewhere quiet and continue the interview.'
      else
        'Warning: Your camera appears to be off. Please keep it on and continue the interview.'
      end;

    if v_voice then
      v_msg := case when v_vn = 1 then
          'Warning 1 of 2: A voice was heard in the background. Voices in the background are not allowed during the interview. '
          || 'Please make sure you are alone in a quiet place. After two warnings the interview is suspended.'
        else
          'Warning 2 of 2: A voice was heard in the background again. This is your last warning - if it happens once more '
          || 'the interview will be suspended.' end;
    end if;

    update ai_interviews
       set integrity_strikes = case when v_voice then integrity_strikes else v_n end,
           voice_strikes     = case when v_voice then v_vn else voice_strikes end,
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
     case when v_susp then 'high' else 'review' end,
     v_n, p_confidence, v_band,
     coalesce(p_evidence->>'detector', 'browser'),
     v_msg,
     case when v_susp then 'suspended' else 'warning_issued' end,
     now());

  insert into ai_interview_audit (interview_id, candidate_id, action, detail, actor_role)
  values (v.id, v.candidate_id,
          case when v_susp then 'integrity.suspended' else 'integrity.warning' end,
          jsonb_build_object('type', p_type, 'strike', v_n, 'confidence', p_confidence, 'band', v_band,
                             'evidence', coalesce(p_evidence, '{}'::jsonb)),
          'system');

  return query select v_n, v_action, v_msg,
    (select i.status from ai_interviews i where i.id = v.id), v_status, v_at;
end $$;

/* A recruiter reopening the interview clears the slate: the strikes that led to the
   suspension were the reason for it, and they do not carry into the reopened session. */
create or replace function interview_integrity_reopen(
  p_interview_id text,
  p_reason       text,
  p_actor        uuid,
  p_reschedule   timestamptz
) returns ai_interviews
language plpgsql security definer set search_path = public as $$
declare v ai_interviews;
begin
  update ai_interviews
     set status = case when p_reschedule is not null then 'rescheduled' else 'in_progress' end,
         integrity_status = 'under_review',
         scheduled_at = coalesce(p_reschedule, scheduled_at),
         session_id = replace(gen_random_uuid()::text, '-', '')
                   || replace(gen_random_uuid()::text, '-', ''),
         reopened_at = now(), reopened_by = p_actor, reopen_reason = p_reason,
         suspended_at = null,
         integrity_strikes = 0,
         voice_strikes = 0,
         last_detection_at = null
   where id = p_interview_id
   returning * into v;
  if not found then raise exception 'no such interview'; end if;

  insert into ai_interview_audit (interview_id, candidate_id, action, detail, actor_id, actor_role)
  values (v.id, v.candidate_id, 'integrity.reopened',
          jsonb_build_object('reason', p_reason, 'rescheduledFor', p_reschedule, 'strikesReset', true),
          p_actor, 'recruiter');
  return v;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant execute on function interview_integrity_report(text, text, numeric, jsonb, int, int, int, int) to app_api;
  end if;
end $$;
