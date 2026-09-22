-- ---------------------------------------------------------------------
-- 0018 — the AI calling agent
--
-- WHAT ALREADY EXISTS AND IS REUSED, NOT DUPLICATED
--
--   candidates            name, phone, email, skills, exp_years, ctc,
--                         expected_ctc, notice_period, location,
--                         preferred_location, education, resume
--   jobs                  title, skills, exp_label, pay_label, salary
--                         band, location, mode, requirements
--   applications          the pipeline row and its stage
--   notifications         the in-app feed
--   notification_deliveries   what was sent on which channel
--   stages                the ATS stage vocabulary
--
-- Nothing here re-models a candidate or a job. A call POINTS at them.
--
-- WHAT IS NEW
--
--   ai_call_campaigns     a recruiter calling a list for one requirement
--   ai_call_sessions      one call attempt, its outcome and what it learnt
--   ai_call_turns         the transcript, one row per thing said
--   ai_call_events        provider webhooks and state changes, for audit
--   ai_call_callbacks     "call me at 6" and "I want a recruiter"
--   ai_call_settings      the agent's configuration, editable by an admin
--   ai_call_consents      recording disclosure, opt-out, do-not-contact
--
-- Two columns are added to `candidates` rather than kept in a side table,
-- because they are facts about the PERSON and must apply to every call,
-- campaign and channel: do_not_contact and preferred_language.
-- ---------------------------------------------------------------------

alter table candidates
  add column if not exists do_not_contact    boolean not null default false,
  add column if not exists preferred_language text;

-- ---------------------------------------------------------------------
-- settings — one row, edited by an admin, never by code
-- ---------------------------------------------------------------------
create table if not exists ai_call_settings (
  id                    text primary key default 'default',
  agent_name            text    not null default 'Anu',
  company_name          text    not null default 'TeamLink Consultants',
  default_language      text    not null default 'en',
  supported_languages   text[]  not null default '{en,hi,te}',
  -- Where the law or the client requires it, the agent says it is an AI.
  disclose_ai           boolean not null default true,
  ai_disclosure         text    not null default
    'Just so you know, I am an AI assistant calling on behalf of the recruitment team.',
  recording_enabled     boolean not null default false,
  recording_disclosure  text    not null default
    'This call may be recorded for quality purposes.',
  max_duration_seconds  int     not null default 420,
  silence_prompt_seconds int    not null default 8,
  max_silence_prompts   int     not null default 3,
  retry_no_answer       int     not null default 2,
  retry_interval_minutes int    not null default 120,
  call_window_start     time    not null default '09:30',
  call_window_end       time    not null default '19:30',
  disclose_salary       boolean not null default true,
  disclose_client       boolean not null default false,
  voice                 text    not null default 'female-warm',
  voice_speed           numeric not null default 1.0,
  conversation_style    text    not null default 'professional-friendly',
  updated_at            timestamptz not null default now(),
  constraint ai_call_settings_single check (id = 'default')
);

insert into ai_call_settings (id) values ('default') on conflict do nothing;

-- ---------------------------------------------------------------------
-- campaigns
-- ---------------------------------------------------------------------
create table if not exists ai_call_campaigns (
  id            text primary key,
  name          text not null,
  job_id        text not null references jobs(id) on delete cascade,
  recruiter_id  text references recruiters(id),
  created_by    text,
  objective     text not null default 'screen',
  language_mode text not null default 'auto'
                  check (language_mode in ('auto','en','hi','te')),
  max_calls     int  not null default 100,
  retry_policy  jsonb not null default '{}',
  scheduled_at  timestamptz,
  status        text not null default 'draft'
                  check (status in ('draft','running','paused','completed','cancelled')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists ai_call_campaigns_job_idx on ai_call_campaigns (job_id);

-- ---------------------------------------------------------------------
-- sessions — one attempt to reach one candidate about one requirement
-- ---------------------------------------------------------------------
create table if not exists ai_call_sessions (
  id              text primary key,
  campaign_id     text references ai_call_campaigns(id) on delete set null,
  candidate_id    text not null references candidates(id) on delete cascade,
  job_id          text references jobs(id) on delete set null,
  application_id  text references applications(id) on delete set null,
  recruiter_id    text references recruiters(id),

  objective       text not null default 'screen',
  to_number       text,

  -- language
  language            text not null default 'en',
  language_confidence numeric,
  language_switched   boolean not null default false,

  -- where the conversation is, and how it ended
  state   text not null default 'call_init',
  status  text not null default 'queued'
            check (status in (
              'queued','dialing','ringing','in_progress','completed','no_answer',
              'busy','failed','cancelled','wrong_number','voicemail')),
  outcome text
            check (outcome is null or outcome in (
              'call_completed','callback_requested','interested','not_interested',
              'not_looking','salary_mismatch','location_mismatch',
              'notice_period_mismatch','already_joined','wrong_number','no_response',
              'busy','recruiter_callback','do_not_contact','technical_failure',
              'language_issue')),

  interest_status text
            check (interest_status is null or interest_status in
              ('interested','not_interested','undecided','unknown')),
  interest_reason text,

  -- what the call learnt. Columns for what the ATS filters on; jsonb for
  -- the rest, because the screening questions differ per requirement.
  current_ctc            numeric,
  expected_ctc           numeric,
  notice_period          text,
  earliest_joining_date  date,
  location_accepted      boolean,
  work_mode_accepted     boolean,
  interview_interest     boolean,
  screening              jsonb not null default '{}',
  candidate_questions    text[] default '{}',
  candidate_concerns     text[] default '{}',

  -- follow-up
  callback_required           boolean not null default false,
  callback_at                 timestamptz,
  recruiter_callback_required boolean not null default false,

  summary     text,
  transcript  text,

  -- telephony
  provider          text,
  provider_call_id  text,
  recording_url     text,
  error_code        text,
  error_detail      text,

  attempt      int not null default 1,
  retry_of     text references ai_call_sessions(id) on delete set null,
  duration_seconds int,

  queued_at   timestamptz not null default now(),
  started_at  timestamptz,
  answered_at timestamptz,
  ended_at    timestamptz,
  updated_at  timestamptz not null default now()
);

create index if not exists ai_call_sessions_cand_idx on ai_call_sessions (candidate_id, queued_at desc);
create index if not exists ai_call_sessions_job_idx  on ai_call_sessions (job_id, queued_at desc);
create index if not exists ai_call_sessions_camp_idx on ai_call_sessions (campaign_id);
create index if not exists ai_call_sessions_live_idx on ai_call_sessions (status)
  where status in ('queued','dialing','ringing','in_progress');
create unique index if not exists ai_call_sessions_provider_idx
  on ai_call_sessions (provider, provider_call_id)
  where provider_call_id is not null;

-- ---------------------------------------------------------------------
-- the transcript
-- ---------------------------------------------------------------------
create table if not exists ai_call_turns (
  id         bigserial primary key,
  session_id text not null references ai_call_sessions(id) on delete cascade,
  seq        int  not null,
  speaker    text not null check (speaker in ('agent','candidate','system')),
  text       text not null,
  language   text,
  intent     text,
  confidence numeric,
  state      text,
  at         timestamptz not null default now(),
  unique (session_id, seq)
);
create index if not exists ai_call_turns_session_idx on ai_call_turns (session_id, seq);

-- ---------------------------------------------------------------------
-- every event, including the ones that failed
-- ---------------------------------------------------------------------
create table if not exists ai_call_events (
  id         bigserial primary key,
  session_id text references ai_call_sessions(id) on delete cascade,
  type       text not null,
  provider   text,
  payload    jsonb,
  error      text,
  at         timestamptz not null default now()
);
create index if not exists ai_call_events_session_idx on ai_call_events (session_id, at desc);
create index if not exists ai_call_events_type_idx on ai_call_events (type, at desc);

-- ---------------------------------------------------------------------
-- callbacks and recruiter hand-offs
-- ---------------------------------------------------------------------
create table if not exists ai_call_callbacks (
  id           text primary key,
  session_id   text references ai_call_sessions(id) on delete cascade,
  candidate_id text not null references candidates(id) on delete cascade,
  job_id       text references jobs(id) on delete set null,
  recruiter_id text references recruiters(id),
  kind         text not null default 'candidate'
                 check (kind in ('candidate','recruiter')),
  requested_for timestamptz,
  language     text,
  reason       text,
  question     text,
  status       text not null default 'pending'
                 check (status in ('pending','done','cancelled','expired')),
  created_at   timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists ai_call_callbacks_pending_idx
  on ai_call_callbacks (requested_for) where status = 'pending';

-- ---------------------------------------------------------------------
-- consent, disclosure and opt-out — recorded as events, never inferred
-- ---------------------------------------------------------------------
create table if not exists ai_call_consents (
  id           bigserial primary key,
  candidate_id text not null references candidates(id) on delete cascade,
  session_id   text references ai_call_sessions(id) on delete set null,
  kind         text not null check (kind in
                 ('ai_disclosed','recording_disclosed','recording_declined',
                  'opt_out','do_not_contact','consent_to_continue')),
  detail       text,
  at           timestamptz not null default now()
);
create index if not exists ai_call_consents_cand_idx on ai_call_consents (candidate_id, at desc);

-- ---------------------------------------------------------------------
-- RLS
--
-- A candidate may read their own call history. Recruiters, BDEs, clients
-- and admins read through the same visibility rules the rest of the ATS
-- uses. Nobody writes directly: every write goes through the functions
-- below, because the webhooks that drive a live call arrive with no
-- session at all.
-- ---------------------------------------------------------------------
alter table ai_call_sessions  enable row level security;
alter table ai_call_sessions  force  row level security;
alter table ai_call_turns     enable row level security;
alter table ai_call_turns     force  row level security;
alter table ai_call_events    enable row level security;
alter table ai_call_events    force  row level security;
alter table ai_call_campaigns enable row level security;
alter table ai_call_campaigns force  row level security;
alter table ai_call_callbacks enable row level security;
alter table ai_call_callbacks force  row level security;
alter table ai_call_settings  enable row level security;
alter table ai_call_settings  force  row level security;
alter table ai_call_consents  enable row level security;
alter table ai_call_consents  force  row level security;

drop policy if exists ai_call_sessions_read on ai_call_sessions;
create policy ai_call_sessions_read on ai_call_sessions for select using (
  app_is_admin()
  or candidate_id = app_candidate_id()
  or app_role() in ('recruiter','bde','client')
);

drop policy if exists ai_call_turns_read on ai_call_turns;
create policy ai_call_turns_read on ai_call_turns for select using (
  app_is_admin()
  or exists (select 1 from ai_call_sessions s
              where s.id = ai_call_turns.session_id
                and (s.candidate_id = app_candidate_id()
                     or app_role() in ('recruiter','bde','client')))
);

-- The event log is an audit trail: staff only, never the candidate.
drop policy if exists ai_call_events_read on ai_call_events;
create policy ai_call_events_read on ai_call_events for select using (
  app_is_admin() or app_role() in ('recruiter','bde')
);

drop policy if exists ai_call_campaigns_read on ai_call_campaigns;
create policy ai_call_campaigns_read on ai_call_campaigns for select using (
  app_is_admin() or app_role() in ('recruiter','bde','client')
);

drop policy if exists ai_call_callbacks_read on ai_call_callbacks;
create policy ai_call_callbacks_read on ai_call_callbacks for select using (
  app_is_admin()
  or candidate_id = app_candidate_id()
  or app_role() in ('recruiter','bde')
);

drop policy if exists ai_call_settings_read on ai_call_settings;
create policy ai_call_settings_read on ai_call_settings for select using (
  app_is_admin() or app_role() in ('recruiter','bde')
);

drop policy if exists ai_call_consents_read on ai_call_consents;
create policy ai_call_consents_read on ai_call_consents for select using (
  app_is_admin()
  or candidate_id = app_candidate_id()
  or app_role() in ('recruiter','bde')
);

-- ---------------------------------------------------------------------
-- writes
-- ---------------------------------------------------------------------

/* Queue a call. Refuses the three cases that must never be dialled, in
   the database rather than in whichever caller remembered to check. */
create or replace function ai_call_queue(
  p_id text,
  p_candidate_id text,
  p_job_id text,
  p_application_id text,
  p_recruiter_id text,
  p_campaign_id text,
  p_objective text,
  p_language text,
  p_to_number text
) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_dnc boolean;
  v_phone text;
  v_live int;
begin
  select do_not_contact, coalesce(p_to_number, phone) into v_dnc, v_phone
    from candidates where id = p_candidate_id;
  if not found then
    raise exception 'no such candidate';
  end if;
  if v_dnc then
    raise exception 'candidate has asked not to be contacted';
  end if;
  if coalesce(trim(v_phone), '') = '' then
    raise exception 'candidate has no phone number';
  end if;

  -- One live call per candidate per requirement: a queue that dials the
  -- same person twice is worse than one that misses them.
  select count(*) into v_live
    from ai_call_sessions
   where candidate_id = p_candidate_id
     and coalesce(job_id,'') = coalesce(p_job_id,'')
     and status in ('queued','dialing','ringing','in_progress');
  if v_live > 0 then
    raise exception 'a call to this candidate for this requirement is already in progress';
  end if;

  insert into ai_call_sessions
    (id, candidate_id, job_id, application_id, recruiter_id, campaign_id,
     objective, language, to_number, status, state)
  values
    (p_id, p_candidate_id, p_job_id, p_application_id, p_recruiter_id, p_campaign_id,
     coalesce(p_objective,'screen'), coalesce(p_language,'en'), v_phone,
     'queued', 'call_init');

  insert into ai_call_events (session_id, type, payload)
  values (p_id, 'queued', jsonb_build_object('objective', p_objective));

  return p_id;
end $$;

/* Record one thing that was said. */
create or replace function ai_call_turn(
  p_session_id text,
  p_speaker text,
  p_text text,
  p_language text,
  p_intent text,
  p_confidence numeric,
  p_state text
) returns bigint
language plpgsql security definer set search_path = public as $$
declare v_seq int; v_id bigint;
begin
  select coalesce(max(seq), 0) + 1 into v_seq
    from ai_call_turns where session_id = p_session_id;

  insert into ai_call_turns (session_id, seq, speaker, text, language, intent, confidence, state)
  values (p_session_id, v_seq, p_speaker, p_text, p_language, p_intent, p_confidence, p_state)
  returning id into v_id;

  update ai_call_sessions
     set state = coalesce(p_state, state),
         language = coalesce(p_language, language),
         updated_at = now()
   where id = p_session_id;

  return v_id;
end $$;

/* Any state or provider change worth keeping. */
create or replace function ai_call_event(
  p_session_id text, p_type text, p_provider text, p_payload jsonb, p_error text
) returns bigint
language sql security definer set search_path = public as $$
  insert into ai_call_events (session_id, type, provider, payload, error)
  values (p_session_id, p_type, p_provider, p_payload, left(p_error, 2000))
  returning id;
$$;

/* Move the call through its telephony lifecycle. */
create or replace function ai_call_status(
  p_session_id text, p_status text, p_provider text, p_provider_call_id text
) returns void
language plpgsql security definer set search_path = public as $$
begin
  update ai_call_sessions
     set status = p_status,
         provider = coalesce(p_provider, provider),
         provider_call_id = coalesce(p_provider_call_id, provider_call_id),
         started_at  = coalesce(started_at,  case when p_status = 'dialing' then now() end),
         answered_at = coalesce(answered_at, case when p_status = 'in_progress' then now() end),
         updated_at = now()
   where id = p_session_id;

  insert into ai_call_events (session_id, type, provider, payload)
  values (p_session_id, 'status:' || p_status, p_provider,
          jsonb_build_object('providerCallId', p_provider_call_id));
end $$;

/* Everything the call learnt, written once when it ends. */
create or replace function ai_call_finish(
  p_session_id text,
  p_status text,
  p_outcome text,
  p_interest_status text,
  p_interest_reason text,
  p_data jsonb,
  p_summary text,
  p_transcript text,
  p_duration int
) returns void
language plpgsql security definer set search_path = public as $$
declare v_cand text;
begin
  update ai_call_sessions
     set status = coalesce(p_status, status),
         outcome = p_outcome,
         interest_status = p_interest_status,
         interest_reason = p_interest_reason,
         current_ctc  = nullif(p_data->>'currentCtc','')::numeric,
         expected_ctc = nullif(p_data->>'expectedCtc','')::numeric,
         notice_period = nullif(p_data->>'noticePeriod',''),
         earliest_joining_date = nullif(p_data->>'earliestJoiningDate','')::date,
         location_accepted  = (p_data->>'locationAccepted')::boolean,
         work_mode_accepted = (p_data->>'workModeAccepted')::boolean,
         interview_interest = (p_data->>'interviewInterest')::boolean,
         screening = coalesce(p_data->'screening', '{}'::jsonb),
         candidate_questions = coalesce(
           (select array_agg(value::text) from jsonb_array_elements_text(
              coalesce(p_data->'candidateQuestions','[]'::jsonb))), '{}'),
         candidate_concerns = coalesce(
           (select array_agg(value::text) from jsonb_array_elements_text(
              coalesce(p_data->'candidateConcerns','[]'::jsonb))), '{}'),
         callback_required = coalesce((p_data->>'callbackRequired')::boolean, false),
         callback_at = nullif(p_data->>'callbackAt','')::timestamptz,
         recruiter_callback_required =
           coalesce((p_data->>'recruiterCallbackRequired')::boolean, false),
         language = coalesce(nullif(p_data->>'language',''), language),
         language_confidence = nullif(p_data->>'languageConfidence','')::numeric,
         language_switched = coalesce((p_data->>'languageSwitched')::boolean, language_switched),
         summary = p_summary,
         transcript = p_transcript,
         duration_seconds = p_duration,
         ended_at = now(),
         updated_at = now()
   where id = p_session_id
   returning candidate_id into v_cand;

  -- "Never call me again" is a property of the person, not of one call.
  if coalesce((p_data->>'doNotContact')::boolean, false) then
    update candidates set do_not_contact = true where id = v_cand;
    insert into ai_call_consents (candidate_id, session_id, kind, detail)
    values (v_cand, p_session_id, 'do_not_contact', p_interest_reason);
  end if;

  -- The language somebody actually spoke is worth remembering for next time.
  if nullif(p_data->>'language','') is not null then
    update candidates set preferred_language = p_data->>'language' where id = v_cand;
  end if;

  insert into ai_call_events (session_id, type, payload)
  values (p_session_id, 'finished', jsonb_build_object('outcome', p_outcome));
end $$;

create or replace function ai_call_callback_create(
  p_id text, p_session_id text, p_candidate_id text, p_job_id text,
  p_recruiter_id text, p_kind text, p_requested_for timestamptz,
  p_language text, p_reason text, p_question text
) returns text
language sql security definer set search_path = public as $$
  insert into ai_call_callbacks
    (id, session_id, candidate_id, job_id, recruiter_id, kind,
     requested_for, language, reason, question)
  values
    (p_id, p_session_id, p_candidate_id, p_job_id, p_recruiter_id,
     coalesce(p_kind,'candidate'), p_requested_for, p_language, p_reason, p_question)
  returning id;
$$;

create or replace function ai_call_consent(
  p_candidate_id text, p_session_id text, p_kind text, p_detail text
) returns bigint
language sql security definer set search_path = public as $$
  insert into ai_call_consents (candidate_id, session_id, kind, detail)
  values (p_candidate_id, p_session_id, p_kind, p_detail)
  returning id;
$$;

/* Settings are admin-only, and changed through here so the change is
   audited rather than applied silently. */
create or replace function ai_call_settings_update(p_patch jsonb, p_actor text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if app_role() <> 'admin' then
    raise exception 'only an administrator may change the calling agent configuration';
  end if;

  update ai_call_settings set
    agent_name           = coalesce(nullif(p_patch->>'agentName',''), agent_name),
    company_name         = coalesce(nullif(p_patch->>'companyName',''), company_name),
    default_language     = coalesce(nullif(p_patch->>'defaultLanguage',''), default_language),
    supported_languages  = coalesce(
      (select array_agg(value::text) from jsonb_array_elements_text(
         p_patch->'supportedLanguages')), supported_languages),
    disclose_ai          = coalesce((p_patch->>'discloseAi')::boolean, disclose_ai),
    ai_disclosure        = coalesce(nullif(p_patch->>'aiDisclosure',''), ai_disclosure),
    recording_enabled    = coalesce((p_patch->>'recordingEnabled')::boolean, recording_enabled),
    recording_disclosure = coalesce(nullif(p_patch->>'recordingDisclosure',''), recording_disclosure),
    max_duration_seconds = coalesce((p_patch->>'maxDurationSeconds')::int, max_duration_seconds),
    retry_no_answer      = coalesce((p_patch->>'retryNoAnswer')::int, retry_no_answer),
    retry_interval_minutes = coalesce((p_patch->>'retryIntervalMinutes')::int, retry_interval_minutes),
    call_window_start    = coalesce((p_patch->>'callWindowStart')::time, call_window_start),
    call_window_end      = coalesce((p_patch->>'callWindowEnd')::time, call_window_end),
    disclose_salary      = coalesce((p_patch->>'discloseSalary')::boolean, disclose_salary),
    disclose_client      = coalesce((p_patch->>'discloseClient')::boolean, disclose_client),
    voice                = coalesce(nullif(p_patch->>'voice',''), voice),
    voice_speed          = coalesce((p_patch->>'voiceSpeed')::numeric, voice_speed),
    conversation_style   = coalesce(nullif(p_patch->>'conversationStyle',''), conversation_style),
    updated_at = now()
  where id = 'default';

  insert into ai_call_events (type, payload)
  values ('settings:updated', jsonb_build_object('by', p_actor, 'patch', p_patch));
end $$;

create or replace function ai_call_campaign_create(
  p_id text, p_name text, p_job_id text, p_recruiter_id text, p_created_by text,
  p_objective text, p_language_mode text, p_max_calls int, p_retry_policy jsonb,
  p_scheduled_at timestamptz
) returns text
language sql security definer set search_path = public as $$
  insert into ai_call_campaigns
    (id, name, job_id, recruiter_id, created_by, objective, language_mode,
     max_calls, retry_policy, scheduled_at, status)
  values
    (p_id, p_name, p_job_id, p_recruiter_id, p_created_by,
     coalesce(p_objective,'screen'), coalesce(p_language_mode,'auto'),
     coalesce(p_max_calls,100), coalesce(p_retry_policy,'{}'::jsonb),
     p_scheduled_at, case when p_scheduled_at is null then 'running' else 'draft' end)
  returning id;
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant select on ai_call_sessions, ai_call_turns, ai_call_events,
                    ai_call_campaigns, ai_call_callbacks, ai_call_settings,
                    ai_call_consents to app_api;
    grant execute on function
      ai_call_queue(text,text,text,text,text,text,text,text,text),
      ai_call_turn(text,text,text,text,text,numeric,text),
      ai_call_event(text,text,text,jsonb,text),
      ai_call_status(text,text,text,text),
      ai_call_finish(text,text,text,text,text,jsonb,text,text,int),
      ai_call_callback_create(text,text,text,text,text,text,timestamptz,text,text,text),
      ai_call_consent(text,text,text,text),
      ai_call_settings_update(jsonb,text),
      ai_call_campaign_create(text,text,text,text,text,text,text,int,jsonb,timestamptz)
      to app_api;
  end if;
end $$;
