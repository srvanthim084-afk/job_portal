-- ---------------------------------------------------------------------
-- 0121 — a server clock for every question, relevance on every score,
--        and a warning before any page-detected suspension
--
-- WHAT WAS MISSING
--   * The per-question timer lived only in the browser (40 s). A refresh, a
--     dropped connection or a changed clock restarted it, and the server had
--     no idea a question had run out.
--   * A score had no relevance class: an answer that was off-topic, empty, or
--     only full of the right words could not be told apart from a good one in
--     the record.
--   * The page's own detections (tab left, camera, noise) suspended on the
--     FIRST occurrence (0120). They now count in the same two-strike rule as
--     a second person / a second voice: a warning first.
--
-- ADDITIVE ONLY. Nothing that exists changes meaning.
-- ---------------------------------------------------------------------

-- ---- one deadline per question (and per follow-up), kept by the server ----
create table if not exists ai_interview_question_timers (
  interview_id text not null references ai_interviews(id) on delete cascade,
  seq          int  not null,
  part         text not null check (part in ('main', 'followup')),
  started_at   timestamptz not null default now(),
  deadline_at  timestamptz not null,
  seconds      int  not null check (seconds >= 1),
  primary key (interview_id, seq, part)
);
alter table ai_interview_question_timers enable row level security;
alter table ai_interview_question_timers force  row level security;
/* No policy and no grant of use: every read and write goes through the
   functions below, which check that the interview is the caller's. */

-- ---- what was said, how relevant it was, and how sure the transcript is ----
alter table ai_interview_answer_parts
  add column if not exists auto_submitted boolean not null default false,
  add column if not exists transcript_confidence numeric check (transcript_confidence is null or transcript_confidence between 0 and 1);

alter table ai_interview_answers
  add column if not exists relevance_class text,
  add column if not exists max_score int not null default 100,
  add column if not exists transcription_confidence numeric,
  add column if not exists needs_review boolean not null default false,
  add column if not exists review_reason text;

alter table ai_interview_answers drop constraint if exists ai_interview_answers_relevance_check;
alter table ai_interview_answers add constraint ai_interview_answers_relevance_check
  check (relevance_class is null or relevance_class in ('RELEVANT', 'PARTIALLY_RELEVANT', 'IRRELEVANT', 'NO_ANSWER'));

-- ---------------------------------------------------------------------
-- start a question's clock (idempotent: the FIRST call fixes the deadline,
-- so a refresh, a retry or a faster client clock cannot move it)
-- ---------------------------------------------------------------------
create or replace function ai_interview_question_start(
  p_id text, p_candidate_id text, p_seq int, p_part text, p_seconds int
) returns table (started_at timestamptz, deadline_at timestamptz, seconds int, server_now timestamptz, remaining_ms bigint)
language plpgsql security definer set search_path = public as $$
declare t ai_interview_question_timers;
begin
  perform ai_interview_assert_running(p_id, p_candidate_id);
  if p_part not in ('main', 'followup') then raise exception 'unknown answer part'; end if;
  if not exists (select 1 from ai_interview_answers where ai_interview_id = p_id and seq = p_seq) then
    raise exception 'that question is not part of this interview';
  end if;
  if p_part = 'followup' and not exists (
      select 1 from ai_interview_answer_parts where interview_id = p_id and seq = p_seq and part = 'followup') then
    raise exception 'no follow-up was asked for that question';
  end if;

  insert into ai_interview_question_timers (interview_id, seq, part, started_at, deadline_at, seconds)
  values (p_id, p_seq, p_part, now(), now() + make_interval(secs => greatest(1, p_seconds)), greatest(1, p_seconds))
  on conflict (interview_id, seq, part) do nothing;

  select * into t from ai_interview_question_timers where interview_id = p_id and seq = p_seq and part = p_part;
  return query select t.started_at, t.deadline_at, t.seconds, now(),
                      greatest(0, (extract(epoch from (t.deadline_at - now())) * 1000)::bigint);
end $$;

-- ---------------------------------------------------------------------
-- save one answer part. Same function as before, two optional arguments.
--   * a retried part replaces itself (unchanged)
--   * an AUTOMATIC (timeout) save never overwrites an answer that was
--     already submitted - Submit and the timer racing cannot lose words
-- ---------------------------------------------------------------------
drop function if exists ai_interview_part_save(text, text, int, text, boolean, text);

create or replace function ai_interview_part_save(
  p_id text, p_candidate_id text, p_seq int, p_part text, p_answered boolean, p_text text,
  p_auto boolean default false, p_confidence numeric default null
) returns void
language plpgsql security definer set search_path = public as $$
declare v_q text;
begin
  perform ai_interview_assert_running(p_id, p_candidate_id);

  select question into v_q
    from ai_interview_answers where ai_interview_id = p_id and seq = p_seq;
  if v_q is null then
    raise exception 'that question is not part of this interview';
  end if;

  if p_part = 'main' then
    insert into ai_interview_answer_parts
      (interview_id, seq, part, question, answered, transcript, submitted_at, auto_submitted, transcript_confidence)
    values (p_id, p_seq, 'main', v_q, coalesce(p_answered, false), left(p_text, 20000), now(),
            coalesce(p_auto, false), p_confidence)
    on conflict (interview_id, seq, part) do update
      set answered = excluded.answered,
          transcript = excluded.transcript,
          submitted_at = now(),
          auto_submitted = excluded.auto_submitted,
          transcript_confidence = excluded.transcript_confidence
      where not (coalesce(p_auto, false) and ai_interview_answer_parts.submitted_at is not null);
  elsif p_part = 'followup' then
    update ai_interview_answer_parts
       set answered = coalesce(p_answered, false),
           transcript = left(p_text, 20000),
           submitted_at = now(),
           auto_submitted = coalesce(p_auto, false),
           transcript_confidence = p_confidence
     where interview_id = p_id and seq = p_seq and part = 'followup'
       and not (coalesce(p_auto, false) and submitted_at is not null);
    if not found and not exists (
        select 1 from ai_interview_answer_parts where interview_id = p_id and seq = p_seq and part = 'followup') then
      raise exception 'no follow-up was asked for that question';
    end if;
  else
    raise exception 'unknown answer part';
  end if;

  update ai_interview_answers a
     set answered = coalesce((
           select bool_or(p.answered) from ai_interview_answer_parts p
            where p.interview_id = p_id and p.seq = p_seq and p.submitted_at is not null), false),
         answer_summary = nullif(left(coalesce((
           select string_agg(btrim(p.transcript), ' '
                    order by case p.part when 'main' then 0 else 1 end)
             from ai_interview_answer_parts p
            where p.interview_id = p_id and p.seq = p_seq
              and p.transcript is not null and btrim(p.transcript) <> ''), ''), 4000), ''),
         transcription_confidence = (
           select min(p.transcript_confidence) from ai_interview_answer_parts p
            where p.interview_id = p_id and p.seq = p_seq and p.transcript_confidence is not null)
   where a.ai_interview_id = p_id and a.seq = p_seq;

  update ai_interviews
     set questions_answered = (select count(*) from ai_interview_answers
                                where ai_interview_id = p_id and answered)
   where id = p_id;
end $$;

-- ---------------------------------------------------------------------
-- a deadline that passed while the candidate was away: the question is
-- saved as "unanswered, ran out of time" and the interview moves on. Never
-- a violation, never a suspension.
-- ---------------------------------------------------------------------
create or replace function ai_interview_expire_questions(p_id text, p_candidate_id text) returns int
language plpgsql security definer set search_path = public as $$
declare t record; n int := 0;
begin
  perform ai_interview_assert_running(p_id, p_candidate_id);
  for t in select * from ai_interview_question_timers
            where interview_id = p_id and deadline_at < now() order by seq, part loop
    if t.part = 'main' then
      if not exists (select 1 from ai_interview_answer_parts
                      where interview_id = p_id and seq = t.seq and part = 'main' and submitted_at is not null) then
        perform ai_interview_part_save(p_id, p_candidate_id, t.seq, 'main', false, null, true, null);
        n := n + 1;
      end if;
    else
      if exists (select 1 from ai_interview_answer_parts
                  where interview_id = p_id and seq = t.seq and part = 'followup' and submitted_at is null) then
        perform ai_interview_part_save(p_id, p_candidate_id, t.seq, 'followup', false, null, true, null);
        n := n + 1;
      end if;
    end if;
  end loop;
  return n;
end $$;

-- the clocks of one interview, for the candidate whose it is (the table itself is closed)
create or replace function ai_interview_clocks(p_id text, p_candidate_id text)
returns table (seq int, part text, deadline_at timestamptz, seconds int, server_now timestamptz)
language sql security definer set search_path = public stable as $$
  select t.seq, t.part, t.deadline_at, t.seconds, now()
    from ai_interview_question_timers t
    join ai_interviews i on i.id = t.interview_id
   where t.interview_id = p_id and i.candidate_id = p_candidate_id
$$;

-- ---------------------------------------------------------------------
-- finish: the same function, now also keeping relevance, max score and the
-- review flag per question
-- ---------------------------------------------------------------------
create or replace function ai_interview_finish(
  p_id text, p_candidate_id text,
  p_technical numeric, p_behavioral numeric, p_communication numeric, p_overall numeric,
  p_content_scored boolean, p_feedback text, p_transcript text, p_per jsonb,
  p_jd_relevance numeric default null, p_resume_relevance numeric default null
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_status text;
  v_p jsonb;
  v_answered int;
  v_started timestamptz;
begin
  select status, started_at into v_status, v_started
    from ai_interviews where id = p_id and candidate_id = p_candidate_id;
  if v_status is null then
    raise exception 'no such interview for this candidate';
  end if;

  select count(*) into v_answered
    from ai_interview_answers where ai_interview_id = p_id and answered;

  if v_answered = 0 and coalesce(p_overall, 0) > 0 then
    raise exception 'refusing to store a score for an interview with no answers';
  end if;

  for v_p in select * from jsonb_array_elements(coalesce(p_per, '[]'::jsonb)) loop
    update ai_interview_answers
       set score = coalesce((v_p->>'score')::numeric, 0),
           comm_score = nullif(v_p->>'commScore', '')::numeric,
           justification = v_p->>'justification',
           detail = v_p->'detail',
           relevance_class = nullif(v_p->>'relevanceClass', ''),
           max_score = coalesce(nullif(v_p->>'maxScore', '')::int, 100),
           needs_review = coalesce((v_p->>'needsReview')::boolean, false),
           review_reason = nullif(v_p->>'reviewReason', '')
     where ai_interview_id = p_id and seq = (v_p->>'seq')::int;
  end loop;

  update ai_interviews
     set status = 'completed',
         completed_at = now(),
         technical_score = p_technical,
         behavioral_score = p_behavioral,
         communication_score = p_communication,
         overall_percentage = p_overall,
         jd_relevance = p_jd_relevance,
         resume_relevance = p_resume_relevance,
         content_scored = coalesce(p_content_scored, false),
         feedback = p_feedback,
         transcript = p_transcript,
         questions_answered = v_answered,
         duration_seconds = greatest(0, extract(epoch from (now() - coalesce(v_started, now())))::int)
   where id = p_id;
end $$;

-- ---------------------------------------------------------------------
-- the two-strike rule now covers the page's own detections too
-- ---------------------------------------------------------------------
create or replace function interview_integrity_report(
  p_interview_id   text,
  p_type           text,   -- additional_person | additional_voice | left_interview | background_noise | camera_off
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

  v_n := v.integrity_strikes + 1;
  v_band := case when p_confidence >= 0.85 then 'high' when p_confidence >= 0.65 then 'medium' else 'low' end;
  v_label := case p_type
    when 'additional_person' then 'Additional Person'
    when 'additional_voice'  then 'Additional Voice'
    when 'left_interview'    then 'Left the interview window'
    when 'background_noise'  then 'Continuous background noise'
    else 'Camera off' end;
  v_q := coalesce(nullif(p_evidence->>'questionSeq', '')::int, v.questions_answered + 1);

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

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant execute on function
      ai_interview_question_start(text, text, int, text, int),
      ai_interview_part_save(text, text, int, text, boolean, text, boolean, numeric),
      ai_interview_expire_questions(text, text),
      ai_interview_clocks(text, text),
      ai_interview_finish(text, text, numeric, numeric, numeric, numeric, boolean, text, text, jsonb, numeric, numeric),
      interview_integrity_report(text, text, numeric, jsonb, int, int, int)
      to app_api;
  end if;
end $$;
