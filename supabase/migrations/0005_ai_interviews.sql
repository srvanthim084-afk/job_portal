-- =====================================================================
-- AI voice interviews
--
-- The prototype already runs a real voice interview (the AIIV module at
-- prototype.html:22084): it generates per-candidate questions, speaks
-- them, transcribes the answers, and scores them on content. What it
-- never had was anywhere to put the result — everything persisted to
-- localStorage, so a score existed only in the tab that produced it.
--
-- These tables are that missing destination. The scores become ATS data:
-- readable by the candidate, the recruiter, the client and an admin,
-- each scoped to what they are entitled to see.
--
-- Per-question rows are kept because the spec requires an audit trail —
-- every score carries the justification that produced it, so a disputed
-- result can be explained rather than re-run.
-- =====================================================================

create table ai_interviews (
  id                  text primary key,
  application_id      text references applications(id) on delete cascade,
  candidate_id        text not null references candidates(id) on delete cascade,
  job_id              text not null references jobs(id)       on delete cascade,
  -- an AI interview may also have a row in `interviews` (the scheduling
  -- table the existing screens read); this links the two without
  -- duplicating either
  interview_id        text references interviews(id) on delete set null,

  status              text not null default 'completed'
                        check (status in ('in_progress','completed','abandoned')),
  mode                text not null default 'voice',

  -- aggregates, 0-100
  technical_score     numeric check (technical_score     between 0 and 100),
  behavioral_score    numeric check (behavioral_score    between 0 and 100),
  communication_score numeric check (communication_score between 0 and 100),
  overall_percentage  numeric check (overall_percentage  between 0 and 100),

  questions_asked     int not null default 0,
  questions_answered  int not null default 0,

  -- FALSE when the browser captured speech but could not transcribe it
  -- (Speech Recognition needs https and a supporting browser). The score
  -- is then an estimate from response length, not from content — so it
  -- must be visibly distinguishable from a real content-based score
  -- rather than quietly presented as one.
  content_scored      boolean not null default false,

  transcript          text,
  feedback            text,
  question_set_hash   text,          -- used to prove sets are not reused
  started_at          timestamptz,
  completed_at        timestamptz not null default now(),
  created_at          timestamptz not null default now()
);
create index on ai_interviews (candidate_id);
create index on ai_interviews (job_id);
create index on ai_interviews (application_id);

-- One AI interview per candidate per job per attempt is fine, but the
-- SAME question set must never be reissued to the same candidate.
create index on ai_interviews (candidate_id, question_set_hash);

create table ai_interview_answers (
  id               bigserial primary key,
  ai_interview_id  text not null references ai_interviews(id) on delete cascade,
  seq              int  not null,
  category         text not null check (category in ('intro','resume','technical','behavioral')),
  question         text not null,
  answered         boolean not null default false,
  answer_summary   text,
  score            numeric not null default 0 check (score between 0 and 100),
  comm_score       numeric check (comm_score between 0 and 100),
  -- WHY the score is what it is. Required by the spec for audit, and the
  -- thing that makes a score defensible when a candidate challenges it.
  justification    text,
  created_at       timestamptz not null default now(),
  unique (ai_interview_id, seq)
);
create index on ai_interview_answers (ai_interview_id);

-- ---------------------------------------------------------------------
-- A score must never be recorded without the answers that produced it.
--
-- The whole point of the spec is that no number is disconnected from
-- what the candidate actually said. A completed interview carrying an
-- overall percentage but no per-question rows is exactly that, so the
-- database refuses it.
-- ---------------------------------------------------------------------
create or replace function assert_ai_interview_has_answers() returns trigger
language plpgsql as $$
declare n int;
begin
  if new.status <> 'completed' or new.overall_percentage is null then
    return new;
  end if;
  select count(*) into n from ai_interview_answers where ai_interview_id = new.id;
  if n = 0 then
    raise exception
      'ai_interview % is completed with a score but has no per-question answers', new.id
      using hint = 'Insert the answers first, then set status/overall_percentage.';
  end if;
  return new;
end $$;

-- Deferred to statement end so the answers can be inserted in the same
-- transaction as the parent row.
create constraint trigger ai_interviews_need_answers
  after insert or update on ai_interviews
  deferrable initially deferred
  for each row execute function assert_ai_interview_has_answers();

-- ---------------------------------------------------------------------
-- Visibility: candidate, recruiter, client, admin.
--
-- The candidate sees their OWN result — the spec is explicit that the
-- score is shown to them, not just to the hiring side.
-- ---------------------------------------------------------------------
alter table ai_interviews        enable row level security;
alter table ai_interviews        force  row level security;
alter table ai_interview_answers enable row level security;
alter table ai_interview_answers force  row level security;

create policy ai_interviews_read on ai_interviews for select using (
  app_is_admin()
  or candidate_id = app_candidate_id()
  or (app_role() = 'recruiter' and exists (
        select 1 from jobs j where j.id = ai_interviews.job_id
          and j.company_id = app_recruiter_company()))
  or (app_role() = 'client' and exists (
        select 1 from jobs j where j.id = ai_interviews.job_id
          and j.company_id = app_client_company()))
);

-- Only the hiring side writes results. A candidate can never record or
-- amend their own score.
create policy ai_interviews_write on ai_interviews for all
  using (
    app_is_admin()
    or (app_role() = 'recruiter' and exists (
          select 1 from jobs j where j.id = ai_interviews.job_id
            and j.company_id = app_recruiter_company()))
  )
  with check (
    app_is_admin()
    or (app_role() = 'recruiter' and exists (
          select 1 from jobs j where j.id = ai_interviews.job_id
            and j.company_id = app_recruiter_company()))
  );

-- Answers inherit the parent's visibility exactly.
create policy ai_answers_read on ai_interview_answers for select using (
  exists (select 1 from ai_interviews ai where ai.id = ai_interview_answers.ai_interview_id)
);

create policy ai_answers_write on ai_interview_answers for all
  using      (app_is_admin() or app_role() = 'recruiter')
  with check (app_is_admin() or app_role() = 'recruiter');

-- ---------------------------------------------------------------------
-- The candidate's own interview, recorded by the system during the
-- session rather than by a recruiter sitting at a desk.
--
-- SECURITY DEFINER because the person taking the interview is the
-- candidate, and a candidate must not hold write permission on a scoring
-- table. This function is the only way a session can record itself: it
-- writes the answers and the aggregates together, and it recomputes the
-- aggregates from the answers rather than trusting whatever the browser
-- claims the total was.
-- ---------------------------------------------------------------------
create or replace function ai_interview_record(
  p_id text,
  p_candidate_id text,
  p_job_id text,
  p_application_id text,
  p_mode text,
  p_content_scored boolean,
  p_transcript text,
  p_feedback text,
  p_question_set_hash text,
  p_started_at timestamptz,
  p_answers jsonb          -- [{seq,category,question,answered,answer_summary,score,comm_score,justification}]
) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_tech numeric; v_behav numeric; v_comm numeric; v_overall numeric;
  v_asked int; v_answered int;
begin
  if jsonb_array_length(coalesce(p_answers, '[]'::jsonb)) = 0 then
    raise exception 'refusing to record an AI interview with no answers';
  end if;

  insert into ai_interviews (id, application_id, candidate_id, job_id, status, mode,
                             content_scored, transcript, feedback, question_set_hash,
                             started_at, completed_at)
  values (p_id, p_application_id, p_candidate_id, p_job_id, 'in_progress',
          coalesce(p_mode, 'voice'), coalesce(p_content_scored, false),
          p_transcript, p_feedback, p_question_set_hash, p_started_at, now());

  insert into ai_interview_answers
    (ai_interview_id, seq, category, question, answered, answer_summary,
     score, comm_score, justification)
  select p_id,
         (a->>'seq')::int,
         a->>'category',
         a->>'question',
         coalesce((a->>'answered')::boolean, false),
         a->>'answer_summary',
         least(100, greatest(0, coalesce((a->>'score')::numeric, 0))),
         case when a->>'comm_score' is null then null
              else least(100, greatest(0, (a->>'comm_score')::numeric)) end,
         a->>'justification'
  from jsonb_array_elements(p_answers) a;

  -- Recomputed here, never taken from the client.
  --
  -- The weighting MUST match the one the session used
  -- (aiScore(), prototype.html:22172): technical covers the technical and
  -- resume questions, communication averages only the questions actually
  -- answered, and overall is 50/30/20. A different formula here would show
  -- the candidate one number during the interview and a different one in
  -- the ATS afterwards.
  select coalesce(round(avg(score) filter (where category in ('technical','resume'))), 0),
         coalesce(round(avg(score) filter (where category = 'behavioral')), 0),
         coalesce(round(avg(comm_score) filter (where answered)), 0),
         count(*),
         count(*) filter (where answered)
    into v_tech, v_behav, v_comm, v_asked, v_answered
  from ai_interview_answers where ai_interview_id = p_id;

  v_overall := greatest(0, least(100,
                 round(v_tech * 0.5 + v_behav * 0.3 + v_comm * 0.2)));

  update ai_interviews
     set status = 'completed',
         technical_score = v_tech,
         behavioral_score = v_behav,
         communication_score = v_comm,
         overall_percentage = v_overall,
         questions_asked = v_asked,
         questions_answered = v_answered
   where id = p_id;

  -- Move the pipeline on, without demoting anyone already further along.
  if p_application_id is not null then
    update applications
       set stage = 'ai_interview_done', ai_score = v_overall
     where id = p_application_id
       and stage not in ('selected','rejected','offer_extended','client_review');
    update applications set ai_score = v_overall where id = p_application_id;
  end if;

  update candidates set ai_interview_score = v_overall where id = p_candidate_id;

  return p_id;
end $$;

-- Has this exact question set already been put to this candidate?
create or replace function ai_question_set_used(p_candidate_id text, p_hash text)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from ai_interviews
                  where candidate_id = p_candidate_id and question_set_hash = p_hash)
$$;

-- ---------------------------------------------------------------------
-- Grants live HERE, not in 0004_roles.sql.
--
-- Migrations run in filename order, so 0004 executes before these
-- functions exist and a grant there fails the whole deploy. Anything a
-- later migration creates grants its own privileges.
-- ---------------------------------------------------------------------
grant select, insert, update on ai_interviews        to app_api;
grant select, insert, update on ai_interview_answers to app_api;
grant usage, select on sequence ai_interview_answers_id_seq to app_api;

grant execute on function
  ai_interview_record(text, text, text, text, text, boolean, text, text, text, timestamptz, jsonb),
  ai_question_set_used(text, text)
  to app_api;
