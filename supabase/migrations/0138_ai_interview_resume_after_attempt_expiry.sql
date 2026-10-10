-- ---------------------------------------------------------------------
-- 0138 - "No deadline - Attend any time", and then "Interview closed"
--
-- Since 0133 the AI interview is open as long as the JOB is: a job with no
-- closing date shows "No deadline - Attend any time". But an ATTEMPT, once
-- started, still has its own 48 hours (AI_INTERVIEW_DEADLINE_HOURS), and
-- ai_interview_expire_overdue() marks an unfinished one 'expired'. The start
-- route refused every expired attempt - "This interview has passed its
-- deadline" - so a candidate who opened the interview once and did not
-- finish was locked out of a job that is still open.
--
-- Now: while the interview's window is OPEN (ai_interview_window - the job
-- open, its date not passed, a walk-in's day not over), an attempt that ran
-- out of its own time is reopened where the candidate left it, with a fresh
-- attempt window (never beyond the job's own date). The same questions, the
-- answers already given, the integrity record - nothing is reset, so
-- reopening cannot be used to see a different set of questions. When the
-- window is closed it stays refused, with the job-closed words.
-- ---------------------------------------------------------------------
create or replace function ai_interview_resume_expired(p_id text, p_candidate_id text, p_hours int default 48)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v ai_interviews;
  w record;
begin
  select * into v from ai_interviews where id = p_id and candidate_id = p_candidate_id for update;
  if not found or v.status <> 'expired' then return false; end if;
  select * into w from ai_interview_window(v.application_id);
  if w is null or not w.open then return false; end if;

  update ai_interviews
     set status = 'in_progress',
         expires_at = case when w.due_at is not null
                           then least(w.due_at, now() + make_interval(hours => greatest(p_hours, 1)))
                           else now() + make_interval(hours => greatest(p_hours, 1)) end
   where id = v.id;

  insert into ai_interview_audit (interview_id, candidate_id, action, detail, actor_role)
  values (v.id, v.candidate_id, 'interview.reopened_after_attempt_expiry',
          jsonb_build_object('previousExpiresAt', v.expires_at, 'answered', v.questions_answered), 'system');
  return true;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant execute on function ai_interview_resume_expired(text, text, int) to app_api;
  end if;
end $$;
