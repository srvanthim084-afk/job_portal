-- ---------------------------------------------------------------------
-- 0143 - a suspended interview's retake has no invented deadline
--
-- ai_interview_suspend() (0120) moved the application's interview date to
-- "retake time + 48 hours". Since 0133 the interview's date is the JOB's:
-- a job with no closing date has no deadline ("Attend any time"). The 0120
-- line contradicted that - two days after a retake opened, a candidate with
-- a no-date job read "Interview closed".
--
-- The suspension now leaves the date alone (it keeps following the job).
-- Everything else about suspending is unchanged. Applications that an older
-- suspension already moved are put back on their job's date.
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

  /* 0143: NO deadline is made up here. The interview's date is the JOB's date (0133): a job with no
     closing date has none, so a suspended candidate can attend the retake any time after the wait; a
     job with a date closes it on that date. (0120 set "retake time + 48 hours" on the application, which
     shut a no-date job's retake two days after it opened.) The retake attempt itself still has its own
     48 hours to finish once started (ai_interview_start). */

  insert into ai_interview_audit (interview_id, candidate_id, action, detail, actor_role)
  values (v.id, v.candidate_id, 'interview.suspended',
          jsonb_build_object('code', p_code, 'questionNo', p_question_no, 'detections', p_detections,
                             'attempt', v.attempt_number, 'retakeAvailableAt', v_at,
                             'evidence', coalesce(p_evidence, '{}'::jsonb)),
          'system');

  return query select true, v_at, v.attempt_number, 'suspended'::text;
end $$;

/* anything an earlier suspension moved: back on the job's date (suspended attempts included this time) */
update applications a
   set ai_interview_due_at = j.expires_at
  from jobs j
 where j.id = a.job_id
   and a.stage not in ('rejected', 'selected', 'joined', 'no_show')
   and a.ai_interview_due_at is distinct from j.expires_at
   and exists (select 1 from ai_interviews i where i.application_id = a.id and i.suspended_at is not null)
   and not exists (select 1 from ai_interviews i where i.application_id = a.id and i.status in ('completed', 'evaluating', 'evaluated'));
