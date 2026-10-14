-- ---------------------------------------------------------------------
-- 0147 - the OVERALL score (resume + AI interview) decides the move to the ATS
--
-- The owner's rule: a candidate's overall score is the resume score and the AI interview score together
-- (resume 80, interview 70 -> overall 75). Overall 65 or more moves the application to the ATS
-- (Shortlisted). Nobody moves on a resume score alone: the move waits for the interview.
--
--   * applications remembers the three numbers: overall_resume_score, overall_interview_score and
--     overall_score (the average, rounded) - what the Talent Pool "Overall score" filter reads
--   * ai_interview_recorded() works the overall out when the interview is recorded and moves the
--     application when it reaches the mark (the admin's AI-interview pass mark setting, 65 by default).
--     A candidate with no scored resume yet is judged on the interview alone, as before.
--     Nobody is ever moved back automatically. Walk-in applications keep their own rules.
--   * 'auto_overall' joins the ways an application can be "Pushed to ATS"
--   * what is already on file: the overall is worked out for every completed interview, so the filter
--     works on existing data. Nobody is moved by this migration.
-- The screening score no longer moves anybody (api/src/ai/screening.js): it is a recommendation.
-- ---------------------------------------------------------------------
alter table applications
  add column if not exists overall_score            int check (overall_score between 0 and 100),
  add column if not exists overall_resume_score     int check (overall_resume_score between 0 and 100),
  add column if not exists overall_interview_score  int check (overall_interview_score between 0 and 100);

alter table applications drop constraint if exists applications_ats_pushed_via_chk;
alter table applications add constraint applications_ats_pushed_via_chk
  check (ats_pushed_via is null or ats_pushed_via in ('auto_screening', 'auto_ai_interview', 'auto_overall', 'send_to_ats'));

create index if not exists applications_overall_score_idx on applications (candidate_id, overall_score)
  where overall_score is not null;

/* the candidate's latest scored resume (the number on the Talent Pool badge), or null */
create or replace function candidate_latest_resume_score(p_candidate text) returns int
language sql stable security definer set search_path = public as $$
  select total_score from candidate_resume_scores
   where candidate_id = p_candidate and status = 'scored' and total_score is not null
   order by scored_at desc, id desc limit 1
$$;

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
  v_to         text;
  v_from       text;
  v_interview  int := round(coalesce(p_overall, 0));
  v_resume     int;
  v_score      int;                       -- the OVERALL
  v_pass       numeric := ai_interview_pass_mark();
  v_passed     boolean;
  v_note       text;
  v_parts      text;
  v_walkin     boolean;
begin
  select * into v_app from applications where id = p_application_id;
  if not found then
    return jsonb_build_object('recorded', false, 'reason', 'no such application');
  end if;

  select * into v_job from jobs where id = v_app.job_id;
  select name into v_cand_name from candidates where id = v_app.candidate_id;
  v_from := v_app.stage;
  v_walkin := coalesce(v_job.posting_kind, 'job') = 'walkin';

  /* resume + AI interview, equally weighted; no scored resume yet: the interview alone */
  v_resume := candidate_latest_resume_score(v_app.candidate_id);
  v_score := case when v_resume is null then v_interview else round((v_resume + v_interview) / 2.0)::int end;
  v_parts := case when v_resume is null then format('AI interview %s%%', v_interview)
                  else format('resume %s%% + AI interview %s%%', v_resume, v_interview) end;
  v_passed := p_overall is not null and v_score >= v_pass and not v_walkin;

  update candidates
     set ai_interview_score = v_interview,
         updated_at = now()
   where id = v_app.candidate_id;

  update applications
     set overall_score = v_score, overall_resume_score = v_resume, overall_interview_score = v_interview
   where id = p_application_id;

  /* forward only, from a stage where "they have now done the interview" is news */
  if v_passed and v_app.stage in ('applied', 'ai_screening', 'ai_interview_pending', 'ai_interview_in_progress', 'ai_interview_done') then
    v_to := 'shortlisted';
    v_note := format('Overall %s%% (%s) - at or above the %s%% mark: moved to Shortlisted (ATS)', v_score, v_parts, round(v_pass));
  elsif v_passed and v_app.stage = 'shortlisted' then
    v_to := null;                    -- already in the pipeline
    v_note := format('Overall %s%% (%s) - at or above the %s%% mark (already Shortlisted)', v_score, v_parts, round(v_pass));
  elsif v_app.stage in ('applied', 'ai_screening', 'interview_scheduled', 'ai_interview_pending', 'ai_interview_in_progress') then
    v_to := 'ai_interview_done';
    v_note := case when v_walkin
                   then format('AI interview completed - %s%% overall', v_interview)
                   else format('Overall %s%% (%s) - below the %s%% mark: for recruiter review', v_score, v_parts, round(v_pass)) end;
  else
    v_to := null;
    v_note := format('AI interview completed - %s%%', v_interview);
  end if;

  if v_to is not null and v_to <> v_app.stage then
    perform set_config('app.stage_note', v_note, true);
    /* a move INTO the ATS made by the overall score is remembered as such ("Pushed to ATS") */
    update applications
       set stage = v_to, updated_at = now(),
           ats_pushed_at    = case when v_to = 'shortlisted' and ats_pushed_at is null then now() else ats_pushed_at end,
           ats_pushed_via   = case when v_to = 'shortlisted' and ats_pushed_at is null then 'auto_overall' else ats_pushed_via end,
           ats_pushed_score = case when v_to = 'shortlisted' and ats_pushed_at is null then v_score else ats_pushed_score end
     where id = p_application_id;
    v_moved := true;
  end if;

  perform app_event(p_application_id, v_app.candidate_id, 'interview.completed', v_note, 'system',
    jsonb_build_object('overall', v_score, 'resume', v_resume, 'interview', v_interview,
                       'passMark', v_pass, 'passed', v_passed,
                       'movedTo', case when v_moved then v_to else null end, 'from', v_from));

  v_recruiter := coalesce(v_app.recruiter_id, v_job.recruiter_id);
  if v_recruiter is not null then
    perform notify_create(
      'ntf_' || replace(gen_random_uuid()::text, '-', ''),
      v_recruiter, 'recruiter', 'AI_INTERVIEW_COMPLETED',
      'AI interview completed',
      format('%s scored %s%% in the AI interview for %s. Overall %s%% (%s).%s',
             coalesce(v_cand_name, 'A candidate'), v_interview, coalesce(v_job.title, 'a role'), v_score, v_parts,
             case when v_passed and v_moved then format(' At or above the %s%% mark - moved to Shortlisted.', round(v_pass))
                  when v_passed then format(' At or above the %s%% mark.', round(v_pass))
                  when not v_walkin then format(' Below the %s%% mark - please review.', round(v_pass))
                  else '' end),
      v_app.job_id, p_application_id, v_app.candidate_id, null,
      jsonb_build_object('overall', v_score, 'resume', v_resume, 'interview', v_interview, 'passMark', v_pass, 'passed', v_passed));
  end if;

  return jsonb_build_object(
    'recorded', true,
    'movedTo', case when v_moved then v_to else v_from end,
    'moved', v_moved,
    'passed', v_passed,
    'passMark', v_pass,
    'recruiterNotified', v_recruiter is not null,
    'overall', v_score,
    'resume', v_resume,
    'interview', v_interview);
end $$;

/* what is already on file: each application's latest completed interview + the candidate's latest resume
   score. Nothing is moved: this only fills in the numbers. */
update applications a
   set overall_interview_score = round(i.overall_percentage)::int,
       overall_resume_score = candidate_latest_resume_score(a.candidate_id),
       overall_score = case when candidate_latest_resume_score(a.candidate_id) is null then round(i.overall_percentage)::int
                            else round((candidate_latest_resume_score(a.candidate_id) + round(i.overall_percentage)) / 2.0)::int end
  from (
    select distinct on (application_id) application_id, overall_percentage
      from ai_interviews
     where application_id is not null and overall_percentage is not null
       and status in ('completed', 'evaluated')
     order by application_id, coalesce(completed_at, started_at, created_at) desc
  ) i
 where a.id = i.application_id and a.overall_score is null;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant execute on function candidate_latest_resume_score(text), ai_interview_recorded(text, numeric) to app_api;
  end if;
end $$;
