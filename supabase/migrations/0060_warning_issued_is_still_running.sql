-- ---------------------------------------------------------------------
-- 0060 — a warned interview is still a running interview
--
-- 0059 gave the interview a status of `warning_issued` after the first
-- integrity violation, which is exactly what §8 asks for. Two functions
-- written long before that status existed test for `in_progress` by
-- name, and so a candidate who had been warned once could not answer
-- another question:
--
--   ai_interview_answer()          raised "that interview is already
--                                  finished" on the very next answer,
--                                  which turned strike one into strike
--                                  two in everything but the wording.
--   ai_interview_expire_overdue()  skipped warned interviews entirely,
--                                  so one left open past its deadline
--                                  would sit there for good.
--
-- Both are widened to treat `warning_issued` as what it is: running,
-- with a warning against it. `suspended` is deliberately NOT added -
-- that one must stop, and it does.
--
-- `create or replace` only; neither function changes what it does, and
-- the migrations that defined them are left untouched.
-- ---------------------------------------------------------------------

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
  if v_status = 'suspended' then
    raise exception 'that interview is suspended';
  end if;
  -- `warning_issued` is a running interview. The candidate has been told
  -- once; the whole point of a two-strike rule is that they carry on.
  if v_status not in ('in_progress', 'warning_issued') then
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

create or replace function ai_interview_expire_overdue() returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update ai_interviews
     set status = 'expired'
   where status in ('in_progress', 'warning_issued')
     and expires_at is not null and expires_at < now();
  get diagnostics n = row_count;
  return n;
end $$;

-- The partial index 0014 created is on `status = 'in_progress'`. A
-- warned interview is rare and the table is small, so a second partial
-- index would cost more to maintain than the scan it saves; the query
-- above simply falls back to a sequential scan for those rows.
