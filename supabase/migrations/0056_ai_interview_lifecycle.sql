-- ---------------------------------------------------------------------
-- 0056 — the AI interview gets a life before it is taken
--
-- 0005 recorded an interview that had ALREADY HAPPENED: a row appeared
-- when the candidate finished, carrying the scores and the transcript.
-- That is why `completed_at` is `not null default now()` — there was no
-- such thing as an interview that had not completed.
--
-- A recruiter needs the other half: create it, configure it, schedule it,
-- send the invitation, watch it sit unstarted, extend it, resend it,
-- cancel it. This adds that lifecycle to the table that already exists
-- rather than starting a second interview system beside it.
--
-- WHAT IS NOT CHANGED. Every column 0005 created keeps its name, type and
-- meaning. Every existing row stays valid: the status CHECK is WIDENED
-- (a widened check accepts everything it accepted before), `completed_at`
-- is made NULLABLE (a null is newly allowed, nothing existing becomes
-- invalid), and every new column is nullable or defaulted. The trigger
-- that refuses a scored interview with no answers is untouched, and so is
-- `question_set_hash`.
--
-- FOUR TABLES ARE ADDED because the brief asks for records this schema
-- genuinely does not have: the questions as their own rows, the
-- evaluation as its own row, integrity flags, and coding submissions.
-- `ai_interview_answers` already holds question text alongside the
-- answer, so the new questions table carries a pointer back to it rather
-- than a second copy of the wording — one question, one row, two
-- readers.
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- the interview itself: configuration, schedule, session
-- ---------------------------------------------------------------------

alter table ai_interviews
  add column if not exists recruiter_id       text references recruiters(id),
  add column if not exists interview_type     text not null default 'mixed'
    check (interview_type in ('technical','hr','behavioral','situational',
                              'communication','role_specific','mixed')),
  add column if not exists duration_minutes   int  not null default 30
    check (duration_minutes in (15,30,45,60)),
  add column if not exists question_count     int  not null default 10
    check (question_count between 1 and 40),
  add column if not exists difficulty         text not null default 'adaptive'
    check (difficulty in ('easy','medium','hard','adaptive')),
  -- Stated rather than configurable. The brief is explicit that the
  -- interview is English only and that no language chooser exists; the
  -- column records what was used so a historical report can say so.
  add column if not exists language           text not null default 'en',
  add column if not exists scheduled_at       timestamptz,
  add column if not exists expires_at         timestamptz,
  add column if not exists invitation_sent_at timestamptz,
  add column if not exists cancelled_at       timestamptz,
  add column if not exists cancel_reason      text,
  add column if not exists confidence         text
    check (confidence is null or confidence in ('high','medium','low')),
  add column if not exists confidence_reason  text,
  -- Voice, or the text fallback when voice could not be used (§17).
  add column if not exists fallback_used      boolean not null default false,

  /*
   * THE JOB AS IT WAS, NOT AS IT IS.
   *
   * A completed interview has to stay reproducible: if the job
   * description is edited next month, the report must still show the
   * skills the questions were actually generated from. The snapshot is
   * taken when the interview starts and is never written again.
   */
  add column if not exists jd_snapshot        jsonb;

/*
 * A SECURE LINK PER INTERVIEW, NEVER REUSED.
 *
 * Unique so the same session cannot be issued twice, and separate from
 * the row id so the id can be quoted in a report without handing anybody
 * a way in.
 */
alter table ai_interviews
  add column if not exists session_id text;
create unique index if not exists ai_interviews_session_key
  on ai_interviews (session_id) where session_id is not null;

/* An interview that has not happened yet has no completion time. */
alter table ai_interviews alter column completed_at drop not null;

/*
 * The statuses a lifecycle needs. WIDENED, never narrowed — every value
 * the old constraint allowed is still allowed, so no existing row can be
 * rejected by this.
 */
alter table ai_interviews drop constraint if exists ai_interviews_status_check;
alter table ai_interviews add constraint ai_interviews_status_check
  check (status in ('draft','scheduled','invited','in_progress','completed',
                    'evaluating','evaluated','abandoned','expired','cancelled'));

comment on column ai_interviews.jd_snapshot is
  'The job and configuration as they were when the interview started, so a historical report stays reproducible after the job is edited (0056).';

-- ---------------------------------------------------------------------
-- the questions, as rows of their own
-- ---------------------------------------------------------------------

create table if not exists ai_interview_questions (
  id              bigserial primary key,
  interview_id    text not null references ai_interviews(id) on delete cascade,
  question_number int  not null,
  question        text not null,
  question_type   text not null default 'general'
    check (question_type in ('intro','resume','technical','behavioral',
                             'situational','coding','communication','general')),
  /* WHERE IT CAME FROM — the JD line, the resume claim, or the previous
     answer it followed up on. This is what makes a question defensible
     when a candidate asks why they were asked it. */
  generated_from  text,
  difficulty      text check (difficulty is null or difficulty in ('easy','medium','hard')),
  asked_at        timestamptz,
  answered_at     timestamptz,
  /* The answer row, when one exists. One question, one row, and no
     second copy of the wording. */
  answer_id       bigint references ai_interview_answers(id) on delete set null,
  created_at      timestamptz not null default now(),
  unique (interview_id, question_number)
);
create index if not exists aiq_interview_idx on ai_interview_questions (interview_id);

-- ---------------------------------------------------------------------
-- the evaluation, as its own record
--
-- Kept apart from ai_interviews so a re-evaluation is a new row rather
-- than an overwrite: the brief requires that a human interview never
-- replaces the AI one, and the same applies to a retry.
-- ---------------------------------------------------------------------

create table if not exists ai_interview_evaluations (
  id                    bigserial primary key,
  interview_id          text not null references ai_interviews(id) on delete cascade,
  technical_score       numeric check (technical_score       between 0 and 100),
  problem_solving_score numeric check (problem_solving_score between 0 and 100),
  communication_score   numeric check (communication_score   between 0 and 100),
  role_fit_score        numeric check (role_fit_score        between 0 and 100),
  skills_coverage_score numeric check (skills_coverage_score between 0 and 100),
  resume_alignment_score numeric check (resume_alignment_score between 0 and 100),
  overall_score         numeric check (overall_score         between 0 and 100),
  confidence            text check (confidence in ('high','medium','low')),
  confidence_reason     text,
  summary               text,
  strengths             jsonb not null default '[]',
  areas_to_clarify      jsonb not null default '[]',
  skills_demonstrated   jsonb not null default '[]',
  skills_not_shown      jsonb not null default '[]',
  inconsistencies       jsonb not null default '[]',
  recruiter_followup    jsonb not null default '[]',
  engine                text,          -- 'model' or 'rules', recorded per run
  generated_at          timestamptz not null default now()
);
create index if not exists aie_interview_idx on ai_interview_evaluations (interview_id, generated_at desc);

-- ---------------------------------------------------------------------
-- integrity and session flags
--
-- A FLAG IS NOT A DECISION. review_status starts 'open' and only a person
-- closes it; nothing in this schema lets a flag reject anybody.
-- ---------------------------------------------------------------------

create table if not exists ai_interview_flags (
  id            bigserial primary key,
  interview_id  text not null references ai_interviews(id) on delete cascade,
  candidate_id  text not null references candidates(id) on delete cascade,
  flag_type     text not null,
  description   text,
  evidence      jsonb not null default '{}',
  severity      text not null default 'info' check (severity in ('info','review','high')),
  review_status text not null default 'open'
    check (review_status in ('open','reviewed','dismissed','upheld')),
  reviewed_by   uuid references users(id),
  reviewed_at   timestamptz,
  occurred_at   timestamptz not null default now(),
  created_at    timestamptz not null default now()
);
create index if not exists aif_interview_idx on ai_interview_flags (interview_id);
create index if not exists aif_open_idx on ai_interview_flags (review_status) where review_status = 'open';

-- ---------------------------------------------------------------------
-- coding submissions
-- ---------------------------------------------------------------------

create table if not exists ai_interview_coding (
  id               bigserial primary key,
  interview_id     text not null references ai_interviews(id) on delete cascade,
  question_id      bigint references ai_interview_questions(id) on delete set null,
  language         text,
  submitted_code   text,
  test_results     jsonb not null default '[]',
  execution_status text,
  code_score       numeric check (code_score is null or code_score between 0 and 100),
  evaluation       text,
  submitted_at     timestamptz not null default now()
);
create index if not exists aic_interview_idx on ai_interview_coding (interview_id);

-- ---------------------------------------------------------------------
-- the audit log (§35)
--
-- Who did what to an interview and when, including the reads: the brief
-- requires that viewing a transcript or a recording is recorded, because
-- that is the part a privacy review asks about.
-- ---------------------------------------------------------------------

create table if not exists ai_interview_audit (
  id           bigserial primary key,
  interview_id text references ai_interviews(id) on delete cascade,
  candidate_id text references candidates(id) on delete cascade,
  action       text not null,
  detail       jsonb not null default '{}',
  actor_id     uuid references users(id),
  actor_role   text,
  at           timestamptz not null default now()
);
create index if not exists aia_interview_idx on ai_interview_audit (interview_id, at desc);
create index if not exists aia_action_idx on ai_interview_audit (action, at desc);

-- ---------------------------------------------------------------------
-- the pipeline (§30)
--
-- THREE STAGES ARE ADDED, AND NOTHING IS MOVED. The brief's order puts
-- Recruiter Review after the evaluation; this pipeline already has it at
-- 30, before the interview, and reordering it would change the workflow
-- every existing application is sitting in — which §1 forbids. So the new
-- stages are placed around the AI interview stages that already exist and
-- the rest of the board is left exactly where it is:
--
--   … Recruiter Review 30 · BDE Review 35 · AI Interview Pending 38
--     · Interview Scheduled 40 · AI Interview In Progress 45
--     · AI Interview Done 50 · AI Evaluation Completed 55 · Client Review 60 …
--
-- notify_candidate is false for all three: "your interview is in
-- progress" is not news to somebody who is in it, and the candidate is
-- told about the stages either side of them already.
-- ---------------------------------------------------------------------

insert into stages (id, label, kanban, sort_order, notify_candidate, client_visible, candidate_label)
values
  ('ai_interview_pending',     'AI Interview Pending',     true, 38, false, false, 'AI Interview Pending'),
  ('ai_interview_in_progress', 'AI Interview In Progress', true, 45, false, false, 'AI Interview In Progress'),
  ('ai_evaluation_done',       'AI Evaluation Completed',  true, 55, false, false, 'Evaluation Completed')
on conflict (id) do update set
  label            = excluded.label,
  kanban           = excluded.kanban,
  sort_order       = excluded.sort_order,
  notify_candidate = excluded.notify_candidate,
  client_visible   = excluded.client_visible,
  candidate_label  = excluded.candidate_label;

/* The handover chain (0052) reaches the new stages in order. */
update stages set next_stage = 'ai_interview_pending'     where id = 'with_bde';
update stages set next_stage = 'interview_scheduled'      where id = 'ai_interview_pending';
update stages set next_stage = 'ai_interview_in_progress' where id = 'interview_scheduled';
update stages set next_stage = 'ai_interview_done'        where id = 'ai_interview_in_progress';
update stages set next_stage = 'ai_evaluation_done'       where id = 'ai_interview_done';
update stages set next_stage = 'client_review'            where id = 'ai_evaluation_done';
update stages set owner = 'recruiter'
 where id in ('ai_interview_pending','ai_interview_in_progress','ai_evaluation_done');

-- ---------------------------------------------------------------------
-- who may see what
--
-- A candidate reads their own interview and nothing else. Staff read the
-- interviews of candidates they can already read. NOBODY writes directly:
-- a candidate must never be able to touch a score, an evaluation, a flag
-- or a recruiter note, and the only way in is the definer functions.
-- ---------------------------------------------------------------------

alter table ai_interview_questions enable row level security;
alter table ai_interview_questions force  row level security;
create policy aiq_read on ai_interview_questions for select using (
  app_is_admin()
  or exists (select 1 from ai_interviews i where i.id = ai_interview_questions.interview_id)
);
create policy aiq_no_direct_write on ai_interview_questions for all
  using (app_is_admin()) with check (app_is_admin());

alter table ai_interview_evaluations enable row level security;
alter table ai_interview_evaluations force  row level security;
create policy aie_read on ai_interview_evaluations for select using (
  app_is_admin()
  or exists (select 1 from ai_interviews i where i.id = ai_interview_evaluations.interview_id)
);
create policy aie_no_direct_write on ai_interview_evaluations for all
  using (app_is_admin()) with check (app_is_admin());

/*
 * FLAGS ARE STAFF-ONLY.
 *
 * "Multiple voices detected" is a recruiter's note to review, not
 * something to show the person it is about — and a candidate who can see
 * a flag can work out how to avoid raising it.
 */
alter table ai_interview_flags enable row level security;
alter table ai_interview_flags force  row level security;
create policy aif_read on ai_interview_flags for select using (
  app_is_admin() or app_role() in ('recruiter', 'bde')
);
create policy aif_no_direct_write on ai_interview_flags for all
  using (app_is_admin()) with check (app_is_admin());

alter table ai_interview_coding enable row level security;
alter table ai_interview_coding force  row level security;
create policy aic_read on ai_interview_coding for select using (
  app_is_admin()
  or exists (select 1 from ai_interviews i where i.id = ai_interview_coding.interview_id)
);
create policy aic_no_direct_write on ai_interview_coding for all
  using (app_is_admin()) with check (app_is_admin());

/* The audit log is staff-only and append-only: nobody edits history. */
alter table ai_interview_audit enable row level security;
alter table ai_interview_audit force  row level security;
create policy aia_read on ai_interview_audit for select using (
  app_is_admin() or app_role() in ('recruiter', 'bde')
);
create policy aia_no_direct_write on ai_interview_audit for all
  using (app_is_admin()) with check (app_is_admin());

-- ---------------------------------------------------------------------
-- the writes
-- ---------------------------------------------------------------------

/* Append one line to the audit log. Every other function calls it. */
create or replace function ai_interview_log(
  p_interview_id text, p_candidate_id text, p_action text,
  p_detail jsonb default '{}', p_actor uuid default null, p_role text default null
) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into ai_interview_audit (interview_id, candidate_id, action, detail, actor_id, actor_role)
  values (p_interview_id, p_candidate_id, p_action, coalesce(p_detail, '{}'), p_actor, p_role);
end $$;

/*
 * Schedule, reschedule, extend, cancel — one function, because they are
 * the same write with different arguments and three copies of it would
 * drift. Every call is logged with what changed.
 */
create or replace function ai_interview_schedule(
  p_id text, p_scheduled_at timestamptz, p_expires_at timestamptz,
  p_session_id text, p_status text, p_actor uuid default null, p_role text default null
) returns ai_interviews
language plpgsql security definer set search_path = public as $$
declare out_row ai_interviews;
begin
  update ai_interviews
     set scheduled_at = coalesce(p_scheduled_at, scheduled_at),
         expires_at   = coalesce(p_expires_at, expires_at),
         /* A session is issued once and never reissued: reusing one
            would let an old link back into a new interview. */
         session_id   = coalesce(session_id, p_session_id),
         status       = coalesce(p_status, status)
   where id = p_id
  returning * into out_row;

  if out_row.id is null then raise exception 'ai_interview % not found', p_id; end if;

  perform ai_interview_log(p_id, out_row.candidate_id, 'scheduled',
    jsonb_build_object('scheduled_at', out_row.scheduled_at,
                       'expires_at', out_row.expires_at,
                       'status', out_row.status), p_actor, p_role);
  return out_row;
end $$;

create or replace function ai_interview_cancel(
  p_id text, p_reason text, p_actor uuid default null, p_role text default null
) returns ai_interviews
language plpgsql security definer set search_path = public as $$
declare out_row ai_interviews;
begin
  update ai_interviews
     set status = 'cancelled', cancelled_at = now(), cancel_reason = p_reason
   where id = p_id and status not in ('completed', 'evaluated')
  returning * into out_row;

  if out_row.id is null then
    raise exception 'ai_interview % cannot be cancelled (missing, or already completed)', p_id;
  end if;

  perform ai_interview_log(p_id, out_row.candidate_id, 'cancelled',
    jsonb_build_object('reason', p_reason), p_actor, p_role);
  return out_row;
end $$;

create or replace function ai_interview_question_save(
  p_interview_id text, p_number int, p_question text, p_type text,
  p_generated_from text, p_difficulty text
) returns ai_interview_questions
language plpgsql security definer set search_path = public as $$
declare out_row ai_interview_questions;
begin
  insert into ai_interview_questions
      (interview_id, question_number, question, question_type, generated_from, difficulty, asked_at)
    values (p_interview_id, p_number, p_question, coalesce(p_type, 'general'),
            p_generated_from, p_difficulty, now())
  on conflict (interview_id, question_number) do update set
      question = excluded.question,
      question_type = excluded.question_type,
      generated_from = excluded.generated_from,
      difficulty = excluded.difficulty
  returning * into out_row;
  return out_row;
end $$;

create or replace function ai_interview_flag_raise(
  p_interview_id text, p_candidate_id text, p_type text,
  p_description text, p_evidence jsonb, p_severity text
) returns ai_interview_flags
language plpgsql security definer set search_path = public as $$
declare out_row ai_interview_flags;
begin
  insert into ai_interview_flags
      (interview_id, candidate_id, flag_type, description, evidence, severity)
    values (p_interview_id, p_candidate_id, p_type, p_description,
            coalesce(p_evidence, '{}'), coalesce(p_severity, 'info'))
  returning * into out_row;

  perform ai_interview_log(p_interview_id, p_candidate_id, 'flag_raised',
    jsonb_build_object('type', p_type, 'severity', out_row.severity));
  return out_row;
end $$;

create or replace function ai_interview_evaluation_save(
  p_interview_id text, p_scores jsonb, p_confidence text, p_confidence_reason text,
  p_summary text, p_strengths jsonb, p_areas jsonb, p_demonstrated jsonb,
  p_not_shown jsonb, p_inconsistencies jsonb, p_followup jsonb, p_engine text
) returns ai_interview_evaluations
language plpgsql security definer set search_path = public as $$
declare out_row ai_interview_evaluations;
begin
  insert into ai_interview_evaluations (
      interview_id, technical_score, problem_solving_score, communication_score,
      role_fit_score, skills_coverage_score, resume_alignment_score, overall_score,
      confidence, confidence_reason, summary, strengths, areas_to_clarify,
      skills_demonstrated, skills_not_shown, inconsistencies, recruiter_followup, engine)
    values (
      p_interview_id,
      (p_scores->>'technical')::numeric, (p_scores->>'problem_solving')::numeric,
      (p_scores->>'communication')::numeric, (p_scores->>'role_fit')::numeric,
      (p_scores->>'skills_coverage')::numeric, (p_scores->>'resume_alignment')::numeric,
      (p_scores->>'overall')::numeric,
      coalesce(p_confidence, 'medium'), p_confidence_reason, p_summary,
      coalesce(p_strengths, '[]'), coalesce(p_areas, '[]'), coalesce(p_demonstrated, '[]'),
      coalesce(p_not_shown, '[]'), coalesce(p_inconsistencies, '[]'),
      coalesce(p_followup, '[]'), p_engine)
  returning * into out_row;

  /* The headline number and its confidence are mirrored onto the
     interview so the existing screens keep reading one place, while the
     full record with its evidence lives here. */
  update ai_interviews
     set overall_percentage = coalesce((p_scores->>'overall')::numeric, overall_percentage),
         confidence = coalesce(p_confidence, confidence),
         confidence_reason = coalesce(p_confidence_reason, confidence_reason),
         status = case when status in ('completed','evaluating') then 'evaluated' else status end
   where id = p_interview_id;

  perform ai_interview_log(p_interview_id, null, 'evaluated',
    jsonb_build_object('overall', (p_scores->>'overall'), 'engine', p_engine));
  return out_row;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant select on ai_interview_questions, ai_interview_evaluations,
                    ai_interview_flags, ai_interview_coding, ai_interview_audit to app_api;
    grant execute on function
      ai_interview_log(text, text, text, jsonb, uuid, text),
      ai_interview_schedule(text, timestamptz, timestamptz, text, text, uuid, text),
      ai_interview_cancel(text, text, uuid, text),
      ai_interview_question_save(text, int, text, text, text, text),
      ai_interview_flag_raise(text, text, text, text, jsonb, text),
      ai_interview_evaluation_save(text, jsonb, text, text, text, jsonb, jsonb,
                                   jsonb, jsonb, jsonb, jsonb, text)
      to app_api;
  end if;
end $$;
