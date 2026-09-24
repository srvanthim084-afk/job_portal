-- ---------------------------------------------------------------------
-- 0044 — a finished interview reaches the recruiter
--
-- A candidate sat the AI interview, answered every question, and was
-- scored. Two notifications went out, both to the CANDIDATE: "your
-- interview was submitted" and "you scored 72%".
--
-- The recruiter was told nothing. ai_interview_finish() wrote the
-- interview row and the answers and stopped there, so:
--
--   the application stayed at whatever stage it was already on, which is
--   usually "Interview Scheduled" - a board that still says the
--   interview has not happened, the morning after it did;
--   the score existed only inside ai_interviews, a table no pipeline
--   screen reads;
--   nothing appeared in the recruiter's notifications, so the only way
--   to find out was to open each candidate and look.
--
-- An interview nobody is told about is an interview that did not happen,
-- as far as the desk is concerned. This is what closes that.
--
-- WHAT IT DOES NOT DO is decide anything. The stage moves to "AI
-- Interview Done", which is a statement of fact, and no further. A score
-- of 30% does not reject anybody and a score of 95% does not shortlist
-- them: those are a person's decisions, and an interview score is
-- evidence for them, not a substitute.
-- ---------------------------------------------------------------------

/**
 * Record a finished interview against the application it belongs to.
 *
 * SECURITY DEFINER because the candidate is the one who just finished
 * the interview, and a candidate cannot - and must not be able to -
 * write their own application's stage or their recruiter's
 * notifications. The function does exactly these two things and nothing
 * a candidate could steer.
 *
 * @returns what changed, so the caller can say so rather than assume it.
 */
create or replace function ai_interview_recorded(
  p_application_id text, p_overall numeric
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_app        applications;
  v_job        jobs;
  v_cand_name  text;
  v_recruiter  text;
  v_moved      boolean := false;
  v_from       text;
begin
  select * into v_app from applications where id = p_application_id;
  if not found then
    return jsonb_build_object('recorded', false, 'reason', 'no such application');
  end if;

  select * into v_job from jobs where id = v_app.job_id;
  select name into v_cand_name from candidates where id = v_app.candidate_id;
  v_from := v_app.stage;

  /*
   * The interview score goes on the CANDIDATE, where every screen that
   * shows a candidate already looks for it.
   */
  update candidates
     set ai_interview_score = round(coalesce(p_overall, 0)),
         updated_at = now()
   where id = v_app.candidate_id;

  /*
   * The stage moves only FORWARD, and only from a stage where "they have
   * now done the interview" is news.
   *
   * An application already at Offer Extended does not go back to AI
   * Interview Done because a second interview was recorded, and one at
   * Rejected does not quietly come back to life.
   */
  if v_app.stage in ('applied', 'ai_screening', 'shortlisted', 'interview_scheduled') then
    perform set_config('app.stage_note',
      format('AI interview completed - %s%% overall', round(coalesce(p_overall, 0))), true);
    update applications
       set stage = 'ai_interview_done', updated_at = now()
     where id = p_application_id;
    v_moved := true;
  end if;

  -- On the application's own timeline, which is what a recruiter reads
  -- when they ask what has happened to this person.
  perform app_event(p_application_id, v_app.candidate_id, 'interview.completed',
    format('AI interview completed - %s%% overall', round(coalesce(p_overall, 0))),
    'system',
    jsonb_build_object('overall', round(coalesce(p_overall, 0)),
                       'movedTo', case when v_moved then 'ai_interview_done' else null end,
                       'from', v_from));

  /*
   * And the recruiter is told, in the portal.
   *
   * The same way a screening result reaches them. Whoever owns the
   * application, or failing that whoever owns the requirement - an
   * interview result with nobody to deliver it to is the problem this
   * migration exists to fix, so it does not fall silent when one of the
   * two is unset.
   */
  v_recruiter := coalesce(v_app.recruiter_id, v_job.recruiter_id);
  if v_recruiter is not null then
    perform notify_create(
      'ntf_' || replace(gen_random_uuid()::text, '-', ''),
      v_recruiter, 'recruiter', 'AI_INTERVIEW_COMPLETED',
      'AI interview completed',
      format('%s scored %s%% in the AI interview for %s.',
             coalesce(v_cand_name, 'A candidate'),
             round(coalesce(p_overall, 0)),
             coalesce(v_job.title, 'a role')),
      v_app.job_id, p_application_id, v_app.candidate_id, null,
      jsonb_build_object('overall', round(coalesce(p_overall, 0))));
  end if;

  return jsonb_build_object(
    'recorded', true,
    'movedTo', case when v_moved then 'ai_interview_done' else v_from end,
    'moved', v_moved,
    'recruiterNotified', v_recruiter is not null,
    'overall', round(coalesce(p_overall, 0)));
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant execute on function ai_interview_recorded(text, numeric) to app_api;
  end if;
end $$;
