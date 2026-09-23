-- ---------------------------------------------------------------------
-- 0039 — the calling configuration a recruiter can actually set
--
-- ai_call_settings held how the agent SPEAKS - its name, its languages,
-- what it discloses - and nothing about how a call is placed. The
-- provider, the caller ID a candidate sees, whether calls go out
-- automatically: none of it existed, so the screen asking for them had
-- nowhere to put the answers.
--
-- The credentials are NOT here and never will be. An account SID and an
-- auth token are read from the server environment, because a settings
-- table is readable by every recruiter and a form that takes an API key
-- hands it to everybody who can open the developer tools. What lives
-- here is which provider to use and how to behave; what proves you may
-- use it stays on the server.
--
-- Editable by a recruiter as well as an admin. These are operational -
-- the number that shows on a candidate's phone, how many times to try -
-- and the person running the desk is the one who knows them. What stays
-- admin-only is disclosure and recording, which carry legal weight.
-- ---------------------------------------------------------------------

alter table ai_call_settings
  add column if not exists provider text not null default 'not_selected',
  add column if not exists api_url  text,
  add column if not exists caller_id text,
  add column if not exists auto_interview_calls boolean not null default false,
  add column if not exists auto_reminder_calls  boolean not null default false;

create or replace function ai_call_settings_update(p_patch jsonb, p_actor text)
returns void
language plpgsql security definer set search_path = public as $$
declare v_admin boolean := app_is_admin();
begin
  if not (v_admin or app_role() in ('recruiter', 'bde')) then
    raise exception 'not allowed to change the calling configuration'
      using errcode = '42501';
  end if;

  update ai_call_settings set
    /* ---- operational: a recruiter may set these ------------------- */
    provider     = coalesce(nullif(p_patch->>'provider',''), provider),
    api_url      = case when p_patch ? 'apiUrl'
                        then nullif(btrim(p_patch->>'apiUrl'), '') else api_url end,
    caller_id    = case when p_patch ? 'callerId'
                        then nullif(btrim(p_patch->>'callerId'), '') else caller_id end,
    auto_interview_calls = coalesce((p_patch->>'autoInterviewCalls')::boolean,
                                    auto_interview_calls),
    auto_reminder_calls  = coalesce((p_patch->>'autoReminderCalls')::boolean,
                                    auto_reminder_calls),
    retry_no_answer        = coalesce((p_patch->>'retryNoAnswer')::int, retry_no_answer),
    retry_interval_minutes = coalesce((p_patch->>'retryIntervalMinutes')::int,
                                      retry_interval_minutes),
    call_window_start = coalesce((p_patch->>'callWindowStart')::time, call_window_start),
    call_window_end   = coalesce((p_patch->>'callWindowEnd')::time, call_window_end),
    max_duration_seconds = coalesce((p_patch->>'maxDurationSeconds')::int,
                                    max_duration_seconds),

    /* ---- what the agent says: admin only -------------------------- *
     * Disclosure and recording carry legal weight in several places,
     * so they are not a recruiter's to change on a busy afternoon. A
     * non-admin patch leaves them exactly as they were rather than
     * failing, so saving the operational fields still works.
     */
    agent_name   = case when v_admin
                        then coalesce(nullif(p_patch->>'agentName',''), agent_name)
                        else agent_name end,
    company_name = case when v_admin
                        then coalesce(nullif(p_patch->>'companyName',''), company_name)
                        else company_name end,
    default_language = case when v_admin
                        then coalesce(nullif(p_patch->>'defaultLanguage',''), default_language)
                        else default_language end,
    disclose_ai  = case when v_admin
                        then coalesce((p_patch->>'discloseAi')::boolean, disclose_ai)
                        else disclose_ai end,
    ai_disclosure = case when v_admin
                        then coalesce(nullif(p_patch->>'aiDisclosure',''), ai_disclosure)
                        else ai_disclosure end,
    recording_enabled = case when v_admin
                        then coalesce((p_patch->>'recordingEnabled')::boolean, recording_enabled)
                        else recording_enabled end,
    recording_disclosure = case when v_admin
                        then coalesce(nullif(p_patch->>'recordingDisclosure',''), recording_disclosure)
                        else recording_disclosure end,
    updated_at = now()
  where id = 'default';
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant execute on function ai_call_settings_update(jsonb, text) to app_api;
  end if;
end $$;
