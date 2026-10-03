-- ---------------------------------------------------------------------
-- 0097 — Screening questions
--
-- A candidate answers a few questions when they apply (notice period,
-- CTC, location, relocation, anything the job needs); the recruiter sees
-- the answers beside the AI score, and the answers travel with the
-- client submission.
--
--   job_screening_questions          up to SIX per job (enforced here)
--   job_screening_settings           per-job switches ("auto-reject knockouts")
--   application_screening_answers    one row per answered question, with a
--                                    COPY of the question text, so editing a
--                                    live job never rewrites an old answer
--   candidate_screening_defaults     what pre-fills the standard questions
--                                    next time (only with the candidate's
--                                    consent)
--   screening_link_deliveries        every message about the no-password
--                                    answer link, per channel
--   applications.screening_*         status, answer score, combined score,
--                                    and the state of the answer link
--
-- WHO SEES WHAT
--
--   candidate   the questions of open jobs (and of jobs they applied to),
--               WITHOUT the must-have rules or weights - an "expected CTC
--               must be <= 12 LPA" rule is the job's budget, which stays
--               internal. Their own answers, without the knock-out flag.
--               Writes go through screening_record_answers(), which lets a
--               candidate answer once; after that only a recruiter can
--               re-open them.
--   recruiter   questions of their own jobs; answers on every application
--   admin, bde  they can already see (the applications policy decides).
--   client      answers only for applications at a client-visible stage of
--               their own company, through client_screening_answers_v -
--               never the knock-out flag, never the weights, and never the
--               "another consultancy" answer unless the recruiter shared it.
--
-- Nothing here rejects anybody. A failed must-have marks the application
-- screening_status = 'knocked_out' for the recruiter; the candidate is
-- told "Application submitted" like everybody else.
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- the standard questions, editable by an admin (AI Settings screen)
-- ---------------------------------------------------------------------
insert into app_settings (key, value) values ('screening', $json$
{
  "standard": [
    {"key": "notice_period", "enabled": true, "weight": 5,
     "text": "What is your notice period?",
     "type": "single_choice",
     "options": {"choices": ["Immediate", "15 days", "30 days", "60 days", "90 days", "Serving notice"],
                 "followUp": {"when": "Serving notice", "type": "date", "label": "Last working day"}}},
    {"key": "current_ctc", "enabled": true, "weight": 0,
     "text": "What is your current CTC?",
     "type": "number", "options": {"min": 0, "max": 500, "unit": "LPA"}},
    {"key": "expected_ctc", "enabled": true, "weight": 5,
     "text": "What is your expected CTC?",
     "type": "number", "options": {"min": 0, "max": 500, "unit": "LPA"}},
    {"key": "current_location", "enabled": true, "weight": 0,
     "text": "Where are you currently located?",
     "type": "short_text", "options": {"places": true}},
    {"key": "relocate", "enabled": true, "weight": 5,
     "text": "Are you willing to work at {location} ({mode})?",
     "type": "yes_no", "options": {}},
    {"key": "other_consultancy", "enabled": true, "weight": 0, "shareWithClient": false,
     "text": "Have you interviewed for a similar role with any company in the last 6 months through another consultancy?",
     "type": "yes_no",
     "options": {"followUp": {"when": "yes", "type": "short_text", "label": "Which company?"}}}
  ]
}
$json$::jsonb)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------
-- tables
-- ---------------------------------------------------------------------
create table if not exists job_screening_questions (
  id             text primary key,
  job_id         text not null references jobs(id) on delete cascade,
  position       int  not null default 0,
  std_key        text check (std_key in ('notice_period','current_ctc','expected_ctc',
                                         'current_location','relocate','other_consultancy')),
  text           text not null check (char_length(btrim(text)) between 1 and 200),
  type           text not null check (type in ('yes_no','number','single_choice',
                                               'multi_choice','short_text','date')),
  options        jsonb not null default '{}'::jsonb,
  is_knockout    boolean not null default false,
  knockout_rule  jsonb,
  weight         int  not null default 5 check (weight between 0 and 10),
  source         text not null default 'recruiter' check (source in ('standard','ai','recruiter')),
  -- the "another consultancy" answer is internal unless the recruiter says otherwise
  share_with_client boolean not null default true,
  created_by     uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists job_screening_questions_job on job_screening_questions (job_id, position);
create unique index if not exists job_screening_questions_std
  on job_screening_questions (job_id, std_key) where std_key is not null;

create table if not exists job_screening_settings (
  job_id                 text primary key references jobs(id) on delete cascade,
  auto_reject_knockouts  boolean not null default false,
  updated_at             timestamptz not null default now()
);

create table if not exists application_screening_answers (
  application_id    text not null references applications(id) on delete cascade,
  question_id       text not null,           -- no FK: a deleted question keeps its answers
  position          int  not null default 0,
  question_text     text not null,           -- the wording the candidate actually saw
  question_type     text not null,
  std_key           text,
  share_with_client boolean not null default true,
  answer            jsonb not null,          -- {"value": ..., "detail": ...}
  knocked_out       boolean not null default false,
  source            text not null default 'candidate'
                    check (source in ('candidate','link','recruiter_call','ai_call')),
  answered_by       text,
  answered_at       timestamptz not null default now(),
  primary key (application_id, question_id)
);

create table if not exists candidate_screening_defaults (
  candidate_id         text primary key references candidates(id) on delete cascade,
  notice_period        text,
  last_working_day     date,
  current_ctc          numeric,
  expected_ctc         numeric,
  current_location     text,
  willing_to_relocate  boolean,
  updated_at           timestamptz not null default now()
);

create table if not exists screening_link_deliveries (
  id              bigserial primary key,
  application_id  text not null references applications(id) on delete cascade,
  kind            text not null check (kind in ('link','reminder')),
  channel         text not null check (channel in ('email','sms','whatsapp')),
  status          text not null,
  to_address      text,
  provider        text,
  provider_ref    text,
  error           text,
  created_at      timestamptz not null default now()
);
create index if not exists screening_link_deliveries_app on screening_link_deliveries (application_id, created_at);

alter table applications
  add column if not exists screening_status text not null default 'not_required',
  add column if not exists screening_answer_score int,
  add column if not exists screening_combined_score int,
  add column if not exists screening_answered_at timestamptz,
  add column if not exists screening_link_nonce text,
  add column if not exists screening_link_expires_at timestamptz,
  add column if not exists screening_link_sent_at timestamptz,
  add column if not exists screening_reminder_sent_at timestamptz,
  add column if not exists screening_auto_rejected_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'applications_screening_status_chk') then
    alter table applications add constraint applications_screening_status_chk
      check (screening_status in ('not_required','pending','answered','knocked_out'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'applications_screening_score_chk') then
    alter table applications add constraint applications_screening_score_chk
      check ((screening_answer_score is null or screening_answer_score between 0 and 100)
         and (screening_combined_score is null or screening_combined_score between 0 and 100));
  end if;
end $$;

create index if not exists applications_screening_pending
  on applications (screening_status) where screening_status = 'pending';

-- ---------------------------------------------------------------------
-- six per job, enforced here and not only in the page
-- ---------------------------------------------------------------------
create or replace function screening_questions_limit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- Two saves at once must not both see five and both insert.
  perform pg_advisory_xact_lock(hashtext('screening:' || new.job_id));
  if (select count(*) from job_screening_questions
       where job_id = new.job_id and id <> new.id) >= 6 then
    raise exception 'screening_question_limit: a job can have at most 6 screening questions'
      using errcode = 'P0001';
  end if;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists screening_questions_limit on job_screening_questions;
create trigger screening_questions_limit before insert or update of job_id on job_screening_questions
  for each row execute function screening_questions_limit();

-- ---------------------------------------------------------------------
-- every new job gets the standard questions the admin has switched on
-- ---------------------------------------------------------------------
create or replace function screening_standard_for_job(p_job text) returns int
language plpgsql security definer set search_path = public as $$
declare
  v_job   record;
  v_std   jsonb;
  v_q     jsonb;
  v_pos   int := 0;
  v_text  text;
  v_n     int := 0;
  v_intern boolean;
begin
  select id, location, mode, employment_type, posting_kind into v_job from jobs where id = p_job;
  if not found then return 0; end if;
  if exists (select 1 from job_screening_questions where job_id = p_job) then return 0; end if;
  select value -> 'standard' into v_std from app_settings where key = 'screening';
  if v_std is null or jsonb_typeof(v_std) <> 'array' then return 0; end if;
  v_intern := coalesce(v_job.employment_type, '') ilike 'intern%' or coalesce(v_job.posting_kind, '') ilike 'intern%';

  for v_q in select * from jsonb_array_elements(v_std) loop
    continue when coalesce((v_q ->> 'enabled')::boolean, true) is not true;
    -- An internship has no CTC to ask about.
    continue when v_intern and (v_q ->> 'key') in ('current_ctc', 'expected_ctc');
    exit when v_n >= 6;
    v_text := replace(replace(coalesce(v_q ->> 'text', ''),
                '{location}', coalesce(nullif(btrim(v_job.location), ''), 'the job location')),
                '{mode}', coalesce(nullif(btrim(v_job.mode), ''), 'as per the job'));
    v_text := replace(v_text, ' (as per the job)', '');
    insert into job_screening_questions
      (id, job_id, position, std_key, text, type, options, weight, source, share_with_client)
    values ('sq_' || substr(md5(p_job || (v_q ->> 'key') || clock_timestamp()::text), 1, 14),
            p_job, v_pos, v_q ->> 'key', left(v_text, 200), v_q ->> 'type',
            coalesce(v_q -> 'options', '{}'::jsonb),
            least(10, greatest(0, coalesce((v_q ->> 'weight')::int, 5))),
            'standard', coalesce((v_q ->> 'shareWithClient')::boolean, true))
    on conflict do nothing;
    v_pos := v_pos + 1;
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

create or replace function screening_job_created() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform screening_standard_for_job(new.id);
  return null;
end $$;

drop trigger if exists screening_job_created on jobs;
create trigger screening_job_created after insert on jobs
  for each row execute function screening_job_created();

-- Open jobs that already exist get them too: "every job gets them".
-- Applications already made are untouched (screening_status stays
-- 'not_required'); only new applications are asked.
do $$
declare r record;
begin
  for r in select id from jobs
            where status = 'open' and not coalesce(paused, false) and not coalesce(archived, false)
  loop
    perform screening_standard_for_job(r.id);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- a new application starts 'pending' when its job asks questions
-- ---------------------------------------------------------------------
create or replace function screening_application_status() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.screening_status := case
    when exists (select 1 from job_screening_questions q where q.job_id = new.job_id) then 'pending'
    else 'not_required' end;
  new.screening_answer_score := null;
  new.screening_combined_score := null;
  return new;
end $$;

drop trigger if exists screening_application_status on applications;
create trigger screening_application_status before insert on applications
  for each row execute function screening_application_status();

-- ---------------------------------------------------------------------
-- who may touch what
-- ---------------------------------------------------------------------

/** The caller owns this job (or is an admin): may edit its questions. */
create or replace function screening_job_writer(p_job text) returns boolean
language sql stable security definer set search_path = public as $$
  select app_is_admin()
      or (app_role() = 'recruiter' and exists (
            select 1 from jobs j where j.id = p_job and j.recruiter_id = app_recruiter_id()))
$$;

alter table job_screening_questions       enable row level security;
alter table job_screening_settings        enable row level security;
alter table application_screening_answers enable row level security;
alter table candidate_screening_defaults  enable row level security;
alter table screening_link_deliveries     enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'job_screening_questions' and policyname = 'screening_q_staff_read') then
    create policy screening_q_staff_read on job_screening_questions for select using (
      screening_job_writer(job_id)
      -- a recruiter or BDE who handles an application on this job reads its
      -- questions; the applications policy decides which those are
      or (app_role() in ('recruiter', 'bde') and exists (
            select 1 from applications a where a.job_id = job_screening_questions.job_id)));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'job_screening_questions' and policyname = 'screening_q_write') then
    create policy screening_q_write on job_screening_questions for all
      using (screening_job_writer(job_id)) with check (screening_job_writer(job_id));
  end if;

  if not exists (select 1 from pg_policies where tablename = 'job_screening_settings' and policyname = 'screening_settings_rw') then
    create policy screening_settings_rw on job_screening_settings for all
      using (screening_job_writer(job_id)) with check (screening_job_writer(job_id));
  end if;

  -- Staff read the answers on applications they can already see. No
  -- write policy: answers are written by screening_record_answers().
  if not exists (select 1 from pg_policies where tablename = 'application_screening_answers' and policyname = 'screening_answers_staff_read') then
    create policy screening_answers_staff_read on application_screening_answers for select using (
      (app_is_admin() or app_role() in ('recruiter', 'bde'))
      and exists (select 1 from applications a where a.id = application_screening_answers.application_id));
  end if;

  if not exists (select 1 from pg_policies where tablename = 'candidate_screening_defaults' and policyname = 'screening_defaults_own') then
    -- The candidate's own; and the API's engine (nobody signed in), which
    -- saves them when a candidate answers through the no-password link and
    -- ticks "use these answers next time". No staff member reads them.
    create policy screening_defaults_own on candidate_screening_defaults for all
      using (candidate_id = app_candidate_id() or (app_role() = 'admin' and app_user_id() is null))
      with check (candidate_id = app_candidate_id() or (app_role() = 'admin' and app_user_id() is null));
  end if;

  if not exists (select 1 from pg_policies where tablename = 'screening_link_deliveries' and policyname = 'screening_deliveries_staff_read') then
    create policy screening_deliveries_staff_read on screening_link_deliveries for select using (
      (app_is_admin() or app_role() in ('recruiter', 'bde'))
      and exists (select 1 from applications a where a.id = screening_link_deliveries.application_id));
  end if;
end $$;

-- ---------------------------------------------------------------------
-- what a candidate (or anybody looking at an open job) may read
-- ---------------------------------------------------------------------

/*
 * The questions of a job, minus everything internal: no must-have flag,
 * no rule, no weight. Readable for open jobs, and for any job the caller
 * has applied to (so a pending application can still be answered after
 * the job closes).
 *
 * A view runs with its owner's rights, so every condition is written out
 * here rather than inherited from the policies above.
 */
create or replace view job_screening_questions_public_v as
  select q.id, q.job_id, q.position, q.std_key, q.text, q.type, q.options
    from job_screening_questions q
    join jobs j on j.id = q.job_id
   where (j.status = 'open' and not coalesce(j.paused, false) and not coalesce(j.archived, false))
      or exists (select 1 from applications a
                  where a.job_id = q.job_id and a.candidate_id = app_candidate_id());

/* A candidate's own answers - without the knock-out flag. */
create or replace view candidate_screening_answers_v as
  select s.application_id, s.question_id, s.position, s.question_text, s.question_type,
         s.std_key, s.answer, s.source, s.answered_at
    from application_screening_answers s
    join applications a on a.id = s.application_id
   where app_role() = 'candidate' and a.candidate_id = app_candidate_id();

/*
 * What a client sees: client-visible stages of their own company only.
 * No knock-out flag, no weight, no "who answered", and the "another
 * consultancy" answer only when the recruiter chose to share it.
 */
create or replace view client_screening_answers_v as
  select s.application_id, s.position, s.question_text, s.question_type, s.std_key,
         s.answer, s.answered_at
    from application_screening_answers s
    join applications a on a.id = s.application_id
    join jobs j on j.id = a.job_id
   where app_role() = 'client'
     and j.company_id = app_client_company()
     and a.stage = any (app_client_visible_stages())
     and (s.std_key is distinct from 'other_consultancy' or s.share_with_client);

-- ---------------------------------------------------------------------
-- writing answers
-- ---------------------------------------------------------------------

/**
 * Store the answers to one application, replacing any earlier set, and
 * set its screening status and answer score. The API validates the
 * answers against the questions and evaluates the must-have rules before
 * calling this; this function decides only WHO may write:
 *
 *   - the candidate who owns the application, while it is 'pending'
 *     (so once, unless a recruiter re-opens it);
 *   - the recruiter who owns the job;
 *   - an admin role: the API's engine (the signed link, a recruiter's
 *     "answered on call" after the API has checked the recruiter can see
 *     the application) or a signed-in administrator.
 *
 * p_answers: [{questionId, position, text, type, stdKey, share, answer, knockedOut}]
 */
create or replace function screening_record_answers(
  p_app text, p_answers jsonb, p_source text, p_by text, p_status text, p_score int
) returns int
language plpgsql security definer set search_path = public as $$
declare
  v_app record;
  v_a   jsonb;
  v_n   int := 0;
begin
  select id, candidate_id, job_id, screening_status into v_app from applications where id = p_app for update;
  if not found then raise exception 'screening: no such application' using errcode = 'P0002'; end if;

  if not (app_role() = 'admin'
          or (app_role() = 'candidate' and v_app.candidate_id = app_candidate_id()
              and v_app.screening_status = 'pending')
          -- the recruiter who owns the job, adding a candidate with their answers
          or (app_role() = 'recruiter' and screening_job_writer(v_app.job_id))) then
    raise exception 'screening_answers_locked: these answers cannot be changed now'
      using errcode = '42501';
  end if;
  if p_status not in ('answered', 'knocked_out') then
    raise exception 'screening: bad status %', p_status;
  end if;

  delete from application_screening_answers where application_id = p_app;
  for v_a in select * from jsonb_array_elements(coalesce(p_answers, '[]'::jsonb)) loop
    insert into application_screening_answers
      (application_id, question_id, position, question_text, question_type, std_key,
       share_with_client, answer, knocked_out, source, answered_by)
    values (p_app, v_a ->> 'questionId', coalesce((v_a ->> 'position')::int, v_n),
            left(v_a ->> 'text', 200), v_a ->> 'type', v_a ->> 'stdKey',
            coalesce((v_a ->> 'share')::boolean, true), v_a -> 'answer',
            coalesce((v_a ->> 'knockedOut')::boolean, false), p_source, left(p_by, 120));
    v_n := v_n + 1;
  end loop;

  update applications
     set screening_status = p_status,
         screening_answer_score = p_score,
         screening_answered_at = now(),
         -- the link has done its job: it stops working now
         screening_link_nonce = null
   where id = p_app;
  return v_n;
end $$;

/** A recruiter re-opens the answers: a fresh link, a fresh 7 days. */
create or replace function screening_link_issue(p_app text, p_nonce text, p_expires timestamptz)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if app_role() <> 'admin' then
    raise exception 'screening links are issued by the API only' using errcode = '42501';
  end if;
  update applications
     set screening_status = 'pending',
         screening_link_nonce = p_nonce,
         screening_link_expires_at = p_expires,
         screening_link_sent_at = now(),
         screening_reminder_sent_at = null
   where id = p_app;
end $$;

/** The one reminder, claimed so two sweeps cannot both send it. */
create or replace function screening_reminder_claim(p_app text, p_now timestamptz)
returns boolean
language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  if app_role() <> 'admin' then
    raise exception 'screening reminders are sent by the API only' using errcode = '42501';
  end if;
  update applications set screening_reminder_sent_at = p_now
   where id = p_app and screening_status = 'pending'
     and screening_reminder_sent_at is null
     and screening_link_nonce is not null
     and screening_link_sent_at <= p_now - interval '48 hours'
     and screening_link_expires_at > p_now;
  get diagnostics v_n = row_count;
  return v_n > 0;
end $$;

create or replace function screening_delivery_add(
  p_app text, p_kind text, p_channel text, p_status text, p_to text,
  p_provider text, p_ref text, p_error text
) returns bigint
language plpgsql security definer set search_path = public as $$
declare v_id bigint;
begin
  if app_role() <> 'admin' then
    raise exception 'screening deliveries are recorded by the API only' using errcode = '42501';
  end if;
  insert into screening_link_deliveries
    (application_id, kind, channel, status, to_address, provider, provider_ref, error)
  values (p_app, p_kind, p_channel, p_status, p_to, p_provider, p_ref, left(p_error, 500))
  returning id into v_id;
  return v_id;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant select, insert, update, delete on job_screening_questions, job_screening_settings to app_api;
    grant select on application_screening_answers, screening_link_deliveries to app_api;
    grant select, insert, update, delete on candidate_screening_defaults to app_api;
    grant usage, select on sequence screening_link_deliveries_id_seq to app_api;
    grant select on job_screening_questions_public_v, candidate_screening_answers_v,
                    client_screening_answers_v to app_api;
    grant execute on function screening_record_answers(text, jsonb, text, text, text, int) to app_api;
    grant execute on function screening_link_issue(text, text, timestamptz) to app_api;
    grant execute on function screening_reminder_claim(text, timestamptz) to app_api;
    grant execute on function screening_delivery_add(text, text, text, text, text, text, text, text) to app_api;
    grant execute on function screening_job_writer(text) to app_api;
    grant execute on function screening_standard_for_job(text) to app_api;
  end if;
end $$;

-- The Notification Settings screen lists one row per template.
insert into notification_templates (event_key, label, fires_on) values
  ('screening_link',     'Screening Questions — Answer Link', array['SCREENING_LINK']),
  ('screening_reminder', 'Screening Questions — Reminder',    array['SCREENING_REMINDER'])
on conflict (event_key) do nothing;

comment on table job_screening_questions is
  'Up to six questions a candidate answers when applying. Must-have rules and weights are internal; candidates read job_screening_questions_public_v.';
comment on table application_screening_answers is
  'Answers per application with a copy of the question text. Candidates read candidate_screening_answers_v (no knock-out flag); clients read client_screening_answers_v.';
