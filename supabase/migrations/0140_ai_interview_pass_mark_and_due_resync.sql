-- ---------------------------------------------------------------------
-- 0140 - the AI interview pass mark (65%), and no leftover 48-hour dates
--
-- 1. THE PASS MARK. A finished AI interview used to move every regular
--    application to "AI Interview Done", whatever the score. Now the score
--    of the attempt just completed (always the latest completed one: a
--    suspended attempt has no score and never gets here) decides:
--      >= the pass mark (AI Settings `aiInterviewPassMark`, default 65)
--         -> Shortlisted: in the recruiter's ATS pipeline, the same place
--            the AI resume screening's auto-shortlist puts a candidate;
--      below it -> AI Interview Done, for the recruiter to review (as before).
--    The move is forward-only (a candidate already past Shortlisted is not
--    pulled back), is recorded with the score and the pass mark in the stage
--    history and the application's timeline, and the recruiter is told.
--    Walk-ins are not touched here: their rule is eligibility at 50% (0139).
--
-- 2. LEFTOVER DEADLINES. 0133 made the interview's date follow the job's,
--    but its backfill and the job-date trigger only looked at applications
--    still at Applied / AI Screening. Others kept the old "applied + 48
--    hours" date - an open job with no closing date still said "the date is
--    over". Now every application whose interview is still to be taken
--    follows its job: no job date, no interview date.
-- ---------------------------------------------------------------------

/* the setting, visible beside the other AI settings */
update app_settings
   set value = value || jsonb_build_object('aiInterviewPassMark', 65)
 where key = 'ai' and not (value ? 'aiInterviewPassMark');

create or replace function ai_interview_pass_mark() returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select case when (value->>'aiInterviewPassMark') ~ '^[0-9]+(\.[0-9]+)?$'
                  and (value->>'aiInterviewPassMark')::numeric between 1 and 100
                 then (value->>'aiInterviewPassMark')::numeric end
       from app_settings where key = 'ai'),
    65)
$$;

-- ---------------------------------------------------------------------
-- 1. the interview result reaches the pipeline
-- ---------------------------------------------------------------------
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
    update applications set stage = v_to, updated_at = now() where id = p_application_id;
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

-- ---------------------------------------------------------------------
-- 2. the interview's date follows the job's - for every interview still to be taken
-- ---------------------------------------------------------------------
create or replace function ai_interview_due_pending(p_application_id text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from applications a where a.id = p_application_id
                   and a.stage not in ('rejected', 'selected', 'joined', 'no_show'))
     and not exists (select 1 from ai_interviews iv
                      where iv.application_id = p_application_id
                        and iv.status in ('completed', 'evaluating', 'evaluated', 'suspended'))
$$;

create or replace function jobs_ai_due_follows_expiry() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.expires_at is distinct from old.expires_at then
    update applications a
       set ai_interview_due_at = new.expires_at
     where a.job_id = new.id
       and ai_interview_due_pending(a.id)
       and a.ai_interview_due_at is distinct from new.expires_at;
  end if;
  return new;
end $$;

/* Puts every pending interview's date back on its job's. Returns how many changed. */
create or replace function ai_interview_due_resync() returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update applications a
     set ai_interview_due_at = j.expires_at
    from jobs j
   where j.id = a.job_id
     and ai_interview_due_pending(a.id)
     and a.ai_interview_due_at is distinct from j.expires_at;
  get diagnostics n = row_count;
  return n;
end $$;

select ai_interview_due_resync();

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant execute on function ai_interview_pass_mark(), ai_interview_recorded(text, numeric),
      ai_interview_due_pending(text), ai_interview_due_resync() to app_api;
  end if;
end $$;
