-- ---------------------------------------------------------------------
-- 0014 — the interview blueprint, its deadline, and the scores it produces
--
-- THE BLUEPRINT
--
-- An interview is now a fixed shape rather than "about eight questions":
--
--     2 introduction · 5 from the job description · 5 from the resume
--     · 3 behavioural   = 15
--
-- The existing `category` column keeps its four values because a hundred
-- things read them. `section` records which part of the blueprint a
-- question came from, so "JD relevance" and "resume relevance" can be
-- scored separately even though both are technical questions.
--
-- THE DEADLINE
--
-- An interview must be completed within two days of being scheduled.
-- Without a stored deadline that rule lives in somebody's head: nothing
-- can remind the candidate, and nothing can mark an abandoned interview
-- expired.
--
-- THE SCORES
--
-- technical/behavioral/communication/overall already existed. A candidate
-- can be strong on the job's requirements and thin on their own resume -
-- that is exactly the signal a recruiter wants - so those two are scored
-- separately rather than averaged into one number.
-- ---------------------------------------------------------------------

alter table ai_interviews
  add column if not exists jd_relevance     numeric
    check (jd_relevance is null or jd_relevance between 0 and 100),
  add column if not exists resume_relevance numeric
    check (resume_relevance is null or resume_relevance between 0 and 100),
  add column if not exists expires_at       timestamptz,
  add column if not exists duration_seconds int;

-- 'expired' joins the states an interview can be in: scheduled but never
-- taken is not the same as abandoned halfway through.
alter table ai_interviews drop constraint if exists ai_interviews_status_check;
alter table ai_interviews add constraint ai_interviews_status_check
  check (status in ('in_progress','completed','abandoned','expired'));

alter table ai_interview_answers
  add column if not exists section       text,
  add column if not exists time_taken_ms int,
  -- The per-answer breakdown the report shows: technical relevance,
  -- completeness, accuracy, communication. A jsonb column rather than four
  -- more numeric ones, because the set of dimensions is a product decision
  -- that will change and a migration per change is not worth it.
  add column if not exists detail        jsonb;

create index if not exists ai_interviews_expires_idx
  on ai_interviews (expires_at) where status = 'in_progress';

-- ---------------------------------------------------------------------
-- start: record the deadline; finish: record the extra scores
-- ---------------------------------------------------------------------
create or replace function ai_interview_start(
  p_id text,
  p_application_id text,
  p_candidate_id text,
  p_job_id text,
  p_question_set_hash text,
  p_questions jsonb,
  p_deadline_hours int default 48
) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_ok boolean;
  v_q jsonb;
begin
  if jsonb_array_length(coalesce(p_questions, '[]'::jsonb)) = 0 then
    raise exception 'refusing to start an interview with no questions';
  end if;

  select exists (
    select 1 from applications
     where id = p_application_id and candidate_id = p_candidate_id and job_id = p_job_id
  ) into v_ok;
  if not v_ok then
    raise exception 'no such application for this candidate';
  end if;

  insert into ai_interviews
    (id, application_id, candidate_id, job_id, status, mode,
     questions_asked, started_at, expires_at, question_set_hash)
  values (p_id, p_application_id, p_candidate_id, p_job_id, 'in_progress', 'voice',
          jsonb_array_length(p_questions), now(),
          now() + make_interval(hours => coalesce(p_deadline_hours, 48)),
          p_question_set_hash);

  for v_q in select * from jsonb_array_elements(p_questions) loop
    insert into ai_interview_answers
      (ai_interview_id, seq, category, section, question, answered, score, justification)
    values (p_id,
            (v_q->>'seq')::int,
            v_q->>'category',
            v_q->>'section',
            v_q->>'question',
            false, 0,
            v_q->>'meta');
  end loop;

  return p_id;
end $$;

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
  p_per jsonb,
  p_jd_relevance numeric default null,
  p_resume_relevance numeric default null
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
           detail = v_p->'detail'
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

/* Marks interviews nobody finished in time. Called on read, so an expired
   interview reports itself without needing a scheduler. */
create or replace function ai_interview_expire_overdue() returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update ai_interviews
     set status = 'expired'
   where status = 'in_progress' and expires_at is not null and expires_at < now();
  get diagnostics n = row_count;
  return n;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant execute on function
      ai_interview_start(text, text, text, text, text, jsonb, int),
      ai_interview_finish(text, text, numeric, numeric, numeric, numeric,
                          boolean, text, text, jsonb, numeric, numeric),
      ai_interview_expire_overdue()
      to app_api;
  end if;
end $$;
