-- ---------------------------------------------------------------------
-- 0012 — conducting an AI interview, turn by turn
--
-- 0005 added ai_interview_record(), which writes a FINISHED interview in
-- one call. That suited an interview conducted entirely in the browser:
-- the page asked, scored, and posted the result.
--
-- It no longer does. The questions are planned from the job description on
-- the server, the follow-ups react to what was said, and the grading runs
-- over the stored transcripts - so the interview now exists in the
-- database while it is happening, not only after it.
--
-- A candidate cannot write those rows directly, and must not be able to:
-- they would be inserting their own questions and their own scores. These
-- three SECURITY DEFINER functions are the whole surface, and each one
-- checks that the interview belongs to the caller.
--
-- Note what the candidate can and cannot set:
--   start   supplies questions, never scores
--   answer  supplies a transcript, never a score
--   finish  supplies scores computed by the SERVER from those transcripts
-- The API never passes a client-supplied score to finish.
-- ---------------------------------------------------------------------

/* Begin an interview against an application the candidate owns. */
create or replace function ai_interview_start(
  p_id text,
  p_application_id text,
  p_candidate_id text,
  p_job_id text,
  p_question_set_hash text,
  p_questions jsonb       -- [{seq,category,question,meta}]
) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_ok boolean;
  v_q jsonb;
begin
  if jsonb_array_length(coalesce(p_questions, '[]'::jsonb)) = 0 then
    raise exception 'refusing to start an interview with no questions';
  end if;

  -- The application must exist AND belong to this candidate. Without this
  -- the definer rights would let anyone open an interview on anyone.
  select exists (
    select 1 from applications
     where id = p_application_id
       and candidate_id = p_candidate_id
       and job_id = p_job_id
  ) into v_ok;
  if not v_ok then
    raise exception 'no such application for this candidate';
  end if;

  insert into ai_interviews
    (id, application_id, candidate_id, job_id, status, mode,
     questions_asked, started_at, question_set_hash)
  values (p_id, p_application_id, p_candidate_id, p_job_id, 'in_progress', 'voice',
          jsonb_array_length(p_questions), now(), p_question_set_hash);

  for v_q in select * from jsonb_array_elements(p_questions) loop
    insert into ai_interview_answers
      (ai_interview_id, seq, category, question, answered, score, justification)
    values (p_id,
            (v_q->>'seq')::int,
            v_q->>'category',
            v_q->>'question',
            false, 0,
            v_q->>'meta');
  end loop;

  return p_id;
end $$;

/* Record what was said. A transcript, never a score. */
create or replace function ai_interview_answer(
  p_id text,
  p_candidate_id text,
  p_seq int,
  p_answered boolean,
  p_summary text
) returns void
language plpgsql security definer set search_path = public as $$
declare v_status text;
begin
  select status into v_status
    from ai_interviews where id = p_id and candidate_id = p_candidate_id;
  if v_status is null then
    raise exception 'no such interview for this candidate';
  end if;
  if v_status <> 'in_progress' then
    raise exception 'that interview is already finished';
  end if;

  update ai_interview_answers
     set answered = coalesce(p_answered, false),
         answer_summary = p_summary
   where ai_interview_id = p_id and seq = p_seq;

  update ai_interviews
     set questions_answered = (select count(*) from ai_interview_answers
                                where ai_interview_id = p_id and answered)
   where id = p_id;
end $$;

/* Store the server's evaluation and close the interview. */
create or replace function ai_interview_finish(
  p_id text,
  p_candidate_id text,
  p_technical numeric,
  p_behavioral numeric,
  p_communication numeric,
  p_overall numeric,
  p_content_scored boolean,
  p_feedback text,
  p_transcript text,
  p_per jsonb            -- [{seq,score,commScore,justification}]
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_status text;
  v_p jsonb;
  v_answered int;
begin
  select status into v_status
    from ai_interviews where id = p_id and candidate_id = p_candidate_id;
  if v_status is null then
    raise exception 'no such interview for this candidate';
  end if;

  select count(*) into v_answered
    from ai_interview_answers where ai_interview_id = p_id and answered;

  -- The same rule 0005 enforces: a completed interview with nothing said
  -- is not scoreable, and a score without answers behind it is exactly
  -- what the specification forbids.
  if v_answered = 0 and coalesce(p_overall, 0) > 0 then
    raise exception 'refusing to store a score for an interview with no answers';
  end if;

  for v_p in select * from jsonb_array_elements(coalesce(p_per, '[]'::jsonb)) loop
    update ai_interview_answers
       set score = coalesce((v_p->>'score')::numeric, 0),
           comm_score = nullif(v_p->>'commScore', '')::numeric,
           justification = v_p->>'justification'
     where ai_interview_id = p_id and seq = (v_p->>'seq')::int;
  end loop;

  update ai_interviews
     set status = 'completed',
         completed_at = now(),
         technical_score = p_technical,
         behavioral_score = p_behavioral,
         communication_score = p_communication,
         overall_percentage = p_overall,
         content_scored = coalesce(p_content_scored, false),
         feedback = p_feedback,
         transcript = p_transcript,
         questions_answered = v_answered
   where id = p_id;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant execute on function
      ai_interview_start(text, text, text, text, text, jsonb),
      ai_interview_answer(text, text, int, boolean, text),
      ai_interview_finish(text, text, numeric, numeric, numeric, numeric,
                          boolean, text, text, jsonb)
      to app_api;
  end if;
end $$;
