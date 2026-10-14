-- ---------------------------------------------------------------------
-- 0145 - "Pushed to ATS": an application that was moved into the ATS says so
--
-- When the 65% rule (the screening score, 0144) or the AI interview's pass mark (0140) moves an
-- application to Shortlisted - the recruiter's ATS - nothing on screen said that it had happened
-- or why. The application now remembers:
--
--   ats_pushed_at     when it was moved into the ATS
--   ats_pushed_via    auto_screening     the screening score reached the threshold
--                     auto_ai_interview  the AI interview score reached the pass mark
--                     send_to_ats        a recruiter's "Send to ATS" button
--   ats_pushed_score  the score that did it (null for the button)
--
-- A recruiter who simply moves an application to Shortlisted by hand is not "pushed": those stay null.
-- The first move wins and is never overwritten. What is already on file is read back from the stage
-- history, which recorded the reason of every move.
-- ---------------------------------------------------------------------
alter table applications
  add column if not exists ats_pushed_at    timestamptz,
  add column if not exists ats_pushed_via   text,
  add column if not exists ats_pushed_score numeric;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'applications_ats_pushed_via_chk') then
    alter table applications add constraint applications_ats_pushed_via_chk
      check (ats_pushed_via is null or ats_pushed_via in ('auto_screening', 'auto_ai_interview', 'send_to_ats'));
  end if;
end $$;

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
  v_score      int := round(coalesce(p_overall, 0));
  v_pass       numeric := ai_interview_pass_mark();
  v_passed     boolean;
  v_note       text;
begin
  select * into v_app from applications where id = p_application_id;
  if not found then
    return jsonb_build_object('recorded', false, 'reason', 'no such application');
  end if;

  select * into v_job from jobs where id = v_app.job_id;
  select name into v_cand_name from candidates where id = v_app.candidate_id;
  v_from := v_app.stage;
  v_passed := p_overall is not null and v_score >= v_pass
              and coalesce(v_job.posting_kind, 'job') <> 'walkin';

  update candidates
     set ai_interview_score = v_score,
         updated_at = now()
   where id = v_app.candidate_id;

  /* forward only, from a stage where "they have now done the interview" is news */
  if v_passed and v_app.stage in ('applied', 'ai_screening', 'ai_interview_pending', 'ai_interview_in_progress', 'ai_interview_done') then
    v_to := 'shortlisted';
    v_note := format('AI interview %s%% - at or above the %s%% pass mark: moved to Shortlisted (ATS)', v_score, round(v_pass));
  elsif v_passed and v_app.stage = 'shortlisted' then
    v_to := null;                    -- already in the pipeline
    v_note := format('AI interview %s%% - at or above the %s%% pass mark (already Shortlisted)', v_score, round(v_pass));
  elsif v_app.stage in ('applied', 'ai_screening', 'shortlisted', 'interview_scheduled', 'ai_interview_pending', 'ai_interview_in_progress') then
    v_to := 'ai_interview_done';
    v_note := case when coalesce(v_job.posting_kind, 'job') = 'walkin'
                   then format('AI interview completed - %s%% overall', v_score)
                   else format('AI interview %s%% - below the %s%% pass mark: for recruiter review', v_score, round(v_pass)) end;
  else
    v_to := null;
    v_note := format('AI interview completed - %s%% overall', v_score);
  end if;

  if v_to is not null and v_to <> v_app.stage then
    perform set_config('app.stage_note', v_note, true);
    /* 0145: a move INTO the ATS made by the interview result is remembered as such ("Pushed to ATS") */
    update applications
       set stage = v_to, updated_at = now(),
           ats_pushed_at    = case when v_to = 'shortlisted' then now() else ats_pushed_at end,
           ats_pushed_via   = case when v_to = 'shortlisted' then 'auto_ai_interview' else ats_pushed_via end,
           ats_pushed_score = case when v_to = 'shortlisted' then v_score else ats_pushed_score end
     where id = p_application_id;
    v_moved := true;
  end if;

  perform app_event(p_application_id, v_app.candidate_id, 'interview.completed', v_note, 'system',
    jsonb_build_object('overall', v_score, 'passMark', v_pass, 'passed', v_passed,
                       'movedTo', case when v_moved then v_to else null end, 'from', v_from));

  v_recruiter := coalesce(v_app.recruiter_id, v_job.recruiter_id);
  if v_recruiter is not null then
    perform notify_create(
      'ntf_' || replace(gen_random_uuid()::text, '-', ''),
      v_recruiter, 'recruiter', 'AI_INTERVIEW_COMPLETED',
      'AI interview completed',
      format('%s scored %s%% in the AI interview for %s.%s',
             coalesce(v_cand_name, 'A candidate'), v_score, coalesce(v_job.title, 'a role'),
             case when v_passed and v_moved then format(' At or above the %s%% pass mark - moved to Shortlisted.', round(v_pass))
                  when v_passed then format(' At or above the %s%% pass mark.', round(v_pass))
                  when coalesce(v_job.posting_kind, 'job') <> 'walkin' then format(' Below the %s%% pass mark - please review.', round(v_pass))
                  else '' end),
      v_app.job_id, p_application_id, v_app.candidate_id, null,
      jsonb_build_object('overall', v_score, 'passMark', v_pass, 'passed', v_passed));
  end if;

  return jsonb_build_object(
    'recorded', true,
    'movedTo', case when v_moved then v_to else v_from end,
    'moved', v_moved,
    'passed', v_passed,
    'passMark', v_pass,
    'recruiterNotified', v_recruiter is not null,
    'overall', v_score);
end $$;

/* what is already on file: the first move into Shortlisted whose recorded reason says how it happened */
update applications a
   set ats_pushed_at = h.created_at,
       ats_pushed_via = h.via,
       ats_pushed_score = h.score
  from (
    select distinct on (h.application_id) h.application_id, h.created_at,
           case when h.note ~* '^AI screening [0-9]' then 'auto_screening'
                when h.note ~* '^AI interview [0-9]+% - at or above' then 'auto_ai_interview'
                when h.note ~* '^Sent to ATS from' then 'send_to_ats' end as via,
           case when h.note ~ '^AI (screening|interview) ([0-9]+)' then (regexp_match(h.note, '^AI (?:screening|interview) ([0-9]+)'))[1]::numeric end as score
      from application_stage_history h
     where h.to_stage = 'shortlisted'
       and (h.note ~* '^AI screening [0-9]' or h.note ~* '^AI interview [0-9]+% - at or above' or h.note ~* '^Sent to ATS from')
     order by h.application_id, h.created_at
  ) h
 where a.id = h.application_id and a.ats_pushed_via is null and h.via is not null;
