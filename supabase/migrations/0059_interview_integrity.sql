-- ---------------------------------------------------------------------
-- 0059 — another person in the room: two strikes, and the second stops it
--
-- 0056 gave the interview `ai_interview_flags`, which records that
-- something was observed. What it cannot do is COUNT. The rule this adds
-- is a rule about counting:
--
--   violation 1  -> warn, and carry on
--   violation 2  -> suspend, and a recruiter decides what happens next
--
-- and the two detectors - a second person on camera, a second voice on
-- the microphone - share one counter. A person then a voice is two
-- strikes, not one each.
--
-- WHY THE COUNTER IS IN THE DATABASE AND NOT IN THE PAGE. The page doing
-- the counting is the page the candidate is sitting in front of. A
-- counter in JavaScript is a counter they can reset with F5, and an
-- integrity rule that a reload clears is not a rule. So the browser
-- reports an observation and the DATABASE decides whether it is strike
-- one or strike two, in one statement, and hands back what to show.
--
-- WHAT THIS DOES NOT DO. It does not judge anybody. A flag is evidence
-- with a confidence attached; suspending an interview stops the session
-- and asks a recruiter to look. Nothing here rejects a candidate,
-- changes a score, or moves an application.
--
-- THE EXISTING PROCTOR IS UNTOUCHED. Leaving the tab, continuous
-- background noise and a lost camera already end the interview on their
-- own terms and keep doing exactly that; they are technical conditions,
-- not accusations, and they are deliberately NOT part of this counter.
-- §10 of the brief is explicit: microphone noise alone must not mean
-- somebody else was in the room.
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- the interview carries its own strike count
-- ---------------------------------------------------------------------
alter table ai_interviews
  add column if not exists integrity_status text not null default 'none'
    check (integrity_status in ('none','warning','suspended','under_review','cleared')),
  add column if not exists integrity_strikes int not null default 0
    check (integrity_strikes >= 0),
  add column if not exists suspended_at    timestamptz,
  add column if not exists suspend_reason  text,
  -- Who let it run again, and when. An interview that was suspended and
  -- is now open again has to say so - otherwise the record reads as if
  -- it was never stopped.
  add column if not exists reopened_at     timestamptz,
  add column if not exists reopened_by     uuid references users(id),
  add column if not exists reopen_reason   text;

/*
 * The statuses §8 asks for, added to the list 0056 established rather
 * than to a second one beside it. WIDENED ONLY: every value that was
 * legal before is still legal, so no existing row can be rejected.
 *
 *   in_progress  is "Active"
 *   warning_issued, suspended, under_review, rescheduled  are new
 */
alter table ai_interviews drop constraint if exists ai_interviews_status_check;
alter table ai_interviews add constraint ai_interviews_status_check
  check (status in ('draft','scheduled','invited','in_progress','completed',
                    'evaluating','evaluated','abandoned','expired','cancelled',
                    'warning_issued','suspended','under_review','rescheduled'));

-- ---------------------------------------------------------------------
-- the flag records which strike it was, and what was shown
--
-- `ai_interview_flags` already has interview_id, candidate_id, flag_type,
-- description, evidence, severity, review_status, reviewed_by,
-- reviewed_at and occurred_at. These are the columns §9 asks for that it
-- does not have.
-- ---------------------------------------------------------------------
alter table ai_interview_flags
  add column if not exists strike_no        int,
  -- The raw number the detector produced, and the word a recruiter reads.
  -- Both, because "High" is what the table shows and 0.91 is what an
  -- argument about the threshold needs.
  add column if not exists confidence       numeric
    check (confidence is null or confidence between 0 and 1),
  add column if not exists confidence_band  text
    check (confidence_band is null or confidence_band in ('low','medium','high')),
  add column if not exists detector         text,
  -- The words the candidate actually saw. A record that says "a warning
  -- was issued" without saying what it said is not reviewable.
  add column if not exists warning_message  text,
  add column if not exists status_after     text,
  add column if not exists recruiter_notes  text,
  add column if not exists application_id   text references applications(id) on delete set null,
  add column if not exists job_id           text references jobs(id) on delete set null;

create index if not exists aif_strike_idx
  on ai_interview_flags (interview_id, strike_no);

-- ---------------------------------------------------------------------
-- A CANDIDATE CANNOT TOUCH ANY OF IT
--
-- §7 and §9: these records are immutable to the candidate. RLS on this
-- table lets them READ their own flags - they were shown the warning,
-- hiding the record of it helps nobody - and nothing else. Every write
-- goes through the definer function below or a recruiter's review.
-- ---------------------------------------------------------------------
alter table ai_interview_flags enable row level security;
alter table ai_interview_flags force  row level security;

drop policy if exists aif_read on ai_interview_flags;
create policy aif_read on ai_interview_flags for select using (
  app_is_admin()
  or app_role() in ('recruiter', 'bde')
  or candidate_id = app_candidate_id()
);

/* No candidate branch, deliberately: insert, update and delete are staff
   only, and the candidate's own browser reaches the table exclusively
   through interview_integrity_report() below. */
drop policy if exists aif_staff_write on ai_interview_flags;
create policy aif_staff_write on ai_interview_flags for all
  using      (app_is_admin() or app_role() in ('recruiter', 'bde'))
  with check (app_is_admin() or app_role() in ('recruiter', 'bde'));

grant select on ai_interview_flags to app_api;
grant insert, update on ai_interview_flags to app_api;

-- ---------------------------------------------------------------------
-- one observation in, one decision out
--
-- SECURITY DEFINER because the candidate's own session must be able to
-- report what their browser saw without holding any right to write a
-- flag, set a status, or read anybody else's interview. It takes the
-- session id - the secret the interview link carries - so an observation
-- can only ever be attached to the session that produced it.
--
-- THE ROUTE PROVES WHOSE INTERVIEW IT IS, not this function. A definer
-- function sees every row, so ownership cannot be checked inside it; the
-- caller loads the interview under the candidate's own rights first
-- (`where id = $1 and candidate_id = $2`, with RLS underneath) and only
-- then reports. Saying so here because the absence of a check in a
-- definer function should always be explained.
--
-- IT IS THE ONLY PLACE THE COUNTER MOVES, and it moves under a row lock,
-- so two detectors firing in the same second cannot both read "0 strikes"
-- and both write "strike 1".
--
-- Returns the strike number, what to do, and the exact words to show.
-- ---------------------------------------------------------------------
create or replace function interview_integrity_report(
  p_interview_id text,
  p_type         text,         -- 'additional_person' | 'additional_voice'
  p_confidence   numeric,
  p_evidence     jsonb
) returns table (
  strike_no int, action text, message text, interview_status text, integrity_status text
)
language plpgsql security definer set search_path = public as $$
declare
  v        record;
  v_n      int;
  v_band   text;
  v_msg    text;
  v_action text;
  v_label  text;
  v_status text;
begin
  if p_type not in ('additional_person', 'additional_voice') then
    raise exception 'unknown detection type';
  end if;

  /* The row is locked for the whole decision, so the count that is read
     is the count that is written. */
  select i.* into v from ai_interviews i
   where i.id = p_interview_id for update;
  if not found then
    raise exception 'no such interview session';
  end if;

  /* Already stopped. The second strike is the last one that counts, and
     a detector still firing while the suspension screen paints must not
     push the number to three. */
  if v.integrity_status = 'suspended' then
    return query select v.integrity_strikes, 'suspended'::text,
      'This interview is already suspended.'::text, v.status, v.integrity_status;
    return;
  end if;

  v_n := v.integrity_strikes + 1;

  v_band := case when p_confidence >= 0.85 then 'high'
                 when p_confidence >= 0.65 then 'medium'
                 else 'low' end;

  v_label := case p_type when 'additional_person' then 'Additional Person'
                         else 'Additional Voice' end;

  if v_n >= 2 then
    v_action := 'suspend';
    v_status := 'suspended';
    v_msg := case p_type
      when 'additional_person' then
        'Interview Suspended: Another person was detected in the interview area '
        || 'for a second time. The interview has been suspended and the recruitment '
        || 'team will review the session.'
      else
        'Interview Suspended: Another voice was detected for a second time. '
        || 'The interview has been suspended and the recruitment team will review '
        || 'the session.'
      end;

    update ai_interviews
       set integrity_strikes = v_n,
           integrity_status  = 'suspended',
           status            = 'suspended',
           suspended_at      = now(),
           suspend_reason    = v_label || ' detected twice'
     where id = v.id;
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
           /* The lifecycle status only moves to warning_issued from a
              running interview. A completed or evaluating one keeps the
              status it earned; the integrity_status carries the warning. */
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
          jsonb_build_object('type', p_type, 'strike', v_n,
                             'confidence', p_confidence, 'band', v_band,
                             'evidence', coalesce(p_evidence, '{}'::jsonb)),
          'system');

  return query select v_n, v_action, v_msg,
    (select i.status from ai_interviews i where i.id = v.id), v_status;
end $$;

grant execute on function interview_integrity_report(text, text, numeric, jsonb) to app_api;

comment on function interview_integrity_report(text, text, numeric, jsonb) is
  'One confirmed detection in, one decision out. Counts strikes under a row lock so a reload cannot reset them; strike 2 suspends. Never rejects a candidate.';

-- ---------------------------------------------------------------------
-- reopening, which is a person''s decision and is recorded as one
-- ---------------------------------------------------------------------
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
         /* A NEW session id, so the link the candidate already has cannot
            be used to walk back into the suspended session. Two v4 uuids
            with the hyphens taken out - 256 bits of randomness, hex, and
            url-safe without pgcrypto, which this database does not have
            (see the note at the top of 0001). */
         session_id = replace(gen_random_uuid()::text, '-', '')
                   || replace(gen_random_uuid()::text, '-', ''),
         reopened_at = now(), reopened_by = p_actor, reopen_reason = p_reason,
         suspended_at = null
   where id = p_interview_id
   returning * into v;
  if not found then raise exception 'no such interview'; end if;

  insert into ai_interview_audit (interview_id, candidate_id, action, detail, actor_id, actor_role)
  values (v.id, v.candidate_id, 'integrity.reopened',
          jsonb_build_object('reason', p_reason, 'rescheduledFor', p_reschedule),
          p_actor, 'recruiter');
  return v;
end $$;

grant execute on function interview_integrity_reopen(text, text, uuid, timestamptz) to app_api;
