-- ---------------------------------------------------------------------
-- 0136 - the AI interview: a Submit never ends in "suspended"
--
-- Investigation (what was still left after 0120 / 0121):
--
--   * THE FINAL SUBMIT. After the last answer the page posts /finish, and
--     scoring (a model call, retried) takes a while with the interview still
--     in_progress. A detection in that window - the candidate relaxing,
--     looking away, somebody walking in - was a strike, and a second strike
--     suspended an interview whose every answer was already in. The page
--     then showed "Interview suspended" right after Submit.
--   * ONE MOMENT, TWO STRIKES. The page's detectors and the integrity
--     module report independently; one sound could be "background noise"
--     and "another voice" within a second - two strikes, suspended.
--   * A REOPENED interview kept its strikes, so the first detection after a
--     recruiter reopened it suspended it again at once.
--
-- So: once every question is answered nothing more is counted; detections
-- within 20 seconds of the last counted one are recorded but are not a new
-- strike; a low-confidence detection warns and is recorded, never a strike;
-- reopening resets the strikes. The threshold (the second strike suspends),
-- the reasons, the email and the retake are unchanged (0120 / 0121).
--
-- Retake delay: the default becomes 12 hours (720 minutes); the server
-- passes INTERVIEW_RETAKE_DELAY_MINUTES (api/src/interview/policy.js).
-- ---------------------------------------------------------------------
drop function if exists interview_integrity_report(text, text, numeric, jsonb, int, int, int);

create or replace function interview_integrity_report(
  p_interview_id   text,
  p_type           text,   -- additional_person | additional_voice | left_interview | background_noise | camera_off
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
begin
  if p_type not in ('additional_person', 'additional_voice', 'left_interview', 'background_noise', 'camera_off') then
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

  /* 2. ONE INCIDENT IS ONE STRIKE. The page (noise, tab, camera) and the integrity module
        (second person, second voice) watch independently, each with its own cooldown, so one
        sound in the room could be reported twice within a second - and two reports were two
        strikes, a suspension, for a single moment. A detection within p_incident_seconds of
        the last counted one is recorded for the recruiter and changes nothing.
     3. AN UNCERTAIN DETECTION NEVER SUSPENDS. A low-confidence observation is recorded and the
        candidate sees the warning again; it is not a strike. The threshold itself (the
        second strike suspends) is unchanged. */
  if (v.integrity_strikes > 0 and v.last_detection_at is not null
        and v.last_detection_at > now() - make_interval(secs => p_incident_seconds))
     or v_band = 'low' then
    v_action := case when v_band = 'low' and not (v.last_detection_at is not null
                       and v.last_detection_at > now() - make_interval(secs => p_incident_seconds))
                     then 'warn' else 'noted' end;
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
    return query select v.integrity_strikes, v_action, v_msg, v.status, v.integrity_status, null::timestamptz;
    return;
  end if;

  v_n := v.integrity_strikes + 1;
  v_label := case p_type
    when 'additional_person' then 'Additional Person'
    when 'additional_voice'  then 'Additional Voice'
    when 'left_interview'    then 'Left the interview window'
    when 'background_noise'  then 'Continuous background noise'
    else 'Camera off' end;

  if v_n >= 2 then
    v_action := 'suspend';
    v_status := 'suspended';
    v_msg := case p_type
      when 'additional_person' then 'Another person was detected during your answer to Question ' || v_q || '.'
      when 'additional_voice'  then 'Another voice was detected during your answer to Question ' || v_q || '.'
      when 'left_interview'    then 'The interview window was not in front during your answer to Question ' || v_q || '.'
      when 'background_noise'  then 'Continuous background noise was detected during Question ' || v_q || '.'
      else 'Your camera was off for too long during Question ' || v_q || '.' end;

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
