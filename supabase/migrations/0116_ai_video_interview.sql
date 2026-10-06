-- =====================================================================
-- 0116 — AI video interview: one follow-up per question, and a recording
--        of every answer
--
-- The interview already plans its questions on the server (0012/0014),
-- stores each transcript (ai_interview_answer) and grades the stored
-- transcripts at the end (ai_interview_finish). Two things it could not
-- hold:
--
--   ANSWER PARTS. A question may now be followed by at most ONE follow-up
--   ("Could you share a specific example?"). The follow-up and its answer
--   are kept as their own row, so the recruiter reads what was actually
--   asked, and the primary key makes "at most one" a property of the
--   database rather than of the browser. ai_interview_answers keeps the
--   combined words in answer_summary, which is what the existing grading
--   reads - so scoring is unchanged and still server-side.
--
--   RECORDINGS. The camera and microphone are recorded per question (and
--   per follow-up) with MediaRecorder and uploaded through the same
--   storage driver as resumes. Only the storage KEY is kept here; a file is
--   served by an API route that reads this row under the caller's own RLS,
--   so a recording is visible exactly where its interview is.
--
-- A candidate writes neither table directly. Both are written by the
-- SECURITY DEFINER functions below, which check that the interview is the
-- caller's and still running. Neither function touches a score, a
-- justification, an integrity flag or the application's stage.
-- =====================================================================

create table if not exists ai_interview_answer_parts (
  interview_id  text not null references ai_interviews(id) on delete cascade,
  seq           int  not null,
  part          text not null check (part in ('main', 'followup')),
  -- What was asked: the planned question for 'main', the follow-up for
  -- 'followup'. Copied so the record reads correctly on its own.
  question      text,
  -- Why a follow-up was asked: example | outcome | tools | reflection |
  -- no_experience | rephrase. Null for 'main'.
  kind          text,
  answered      boolean not null default false,
  transcript    text,
  submitted_at  timestamptz,
  created_at    timestamptz not null default now(),
  primary key (interview_id, seq, part)
);

alter table ai_interview_answer_parts enable row level security;
alter table ai_interview_answer_parts force  row level security;

-- Exactly the interview's own visibility: candidate (their own), the
-- recruiter and client for that company, a BDE, an admin.
drop policy if exists aiap_read on ai_interview_answer_parts;
create policy aiap_read on ai_interview_answer_parts for select using (
  exists (select 1 from ai_interviews ai where ai.id = ai_interview_answer_parts.interview_id)
);

create table if not exists ai_interview_recordings (
  id              bigserial primary key,
  interview_id    text not null references ai_interviews(id) on delete cascade,
  candidate_id    text not null references candidates(id)   on delete cascade,
  job_id          text not null references jobs(id)         on delete cascade,
  application_id  text references applications(id)          on delete cascade,
  seq             int  not null,
  part            text not null default 'main' check (part in ('main', 'followup')),
  storage_path    text not null,
  mime            text not null,
  size_bytes      int  not null check (size_bytes > 0),
  duration_ms     int,
  sha256          text,
  created_at      timestamptz not null default now(),
  unique (interview_id, seq, part)
);
create index if not exists ai_interview_recordings_cand on ai_interview_recordings (candidate_id);

alter table ai_interview_recordings enable row level security;
alter table ai_interview_recordings force  row level security;

drop policy if exists aivr_read on ai_interview_recordings;
create policy aivr_read on ai_interview_recordings for select using (
  exists (select 1 from ai_interviews ai where ai.id = ai_interview_recordings.interview_id)
);

-- ---------------------------------------------------------------------
-- the running-interview check every writer below shares
-- ---------------------------------------------------------------------
create or replace function ai_interview_assert_running(p_id text, p_candidate_id text)
returns void
language plpgsql security definer set search_path = public as $$
declare v_status text;
begin
  select status into v_status
    from ai_interviews where id = p_id and candidate_id = p_candidate_id;
  if v_status is null then
    raise exception 'no such interview for this candidate';
  end if;
  if v_status = 'suspended' then
    raise exception 'that interview is suspended';
  end if;
  if v_status not in ('in_progress', 'warning_issued') then
    raise exception 'that interview is already finished';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- one answer part
--
-- Idempotent: the same part posted twice (a retry after a dropped
-- connection) overwrites itself rather than adding a second answer.
-- ---------------------------------------------------------------------
create or replace function ai_interview_part_save(
  p_id text,
  p_candidate_id text,
  p_seq int,
  p_part text,
  p_answered boolean,
  p_text text
) returns void
language plpgsql security definer set search_path = public as $$
declare v_q text;
begin
  perform ai_interview_assert_running(p_id, p_candidate_id);

  select question into v_q
    from ai_interview_answers where ai_interview_id = p_id and seq = p_seq;
  if v_q is null then
    raise exception 'that question is not part of this interview';
  end if;

  if p_part = 'main' then
    insert into ai_interview_answer_parts
      (interview_id, seq, part, question, answered, transcript, submitted_at)
    values (p_id, p_seq, 'main', v_q, coalesce(p_answered, false), left(p_text, 20000), now())
    on conflict (interview_id, seq, part) do update
      set answered = excluded.answered,
          transcript = excluded.transcript,
          submitted_at = now();
  elsif p_part = 'followup' then
    update ai_interview_answer_parts
       set answered = coalesce(p_answered, false),
           transcript = left(p_text, 20000),
           submitted_at = now()
     where interview_id = p_id and seq = p_seq and part = 'followup';
    if not found then
      raise exception 'no follow-up was asked for that question';
    end if;
  else
    raise exception 'unknown answer part';
  end if;

  -- The combined words are what the existing grading reads.
  update ai_interview_answers a
     set answered = coalesce((
           select bool_or(p.answered) from ai_interview_answer_parts p
            where p.interview_id = p_id and p.seq = p_seq and p.submitted_at is not null), false),
         answer_summary = nullif(left(coalesce((
           select string_agg(btrim(p.transcript), ' '
                    order by case p.part when 'main' then 0 else 1 end)
             from ai_interview_answer_parts p
            where p.interview_id = p_id and p.seq = p_seq
              and p.transcript is not null and btrim(p.transcript) <> ''), ''), 4000), '')
   where a.ai_interview_id = p_id and a.seq = p_seq;

  update ai_interviews
     set questions_answered = (select count(*) from ai_interview_answers
                                where ai_interview_id = p_id and answered)
   where id = p_id;
end $$;

-- ---------------------------------------------------------------------
-- offering the follow-up
--
-- At most one per question: the primary key refuses a second, and the
-- function returns whichever follow-up is already on file, so a retried
-- answer is offered the same follow-up rather than a new one.
-- ---------------------------------------------------------------------
create or replace function ai_interview_followup_offer(
  p_id text,
  p_candidate_id text,
  p_seq int,
  p_question text,
  p_kind text
) returns text
language plpgsql security definer set search_path = public as $$
declare v_q text;
begin
  perform ai_interview_assert_running(p_id, p_candidate_id);
  if not exists (select 1 from ai_interview_answer_parts
                  where interview_id = p_id and seq = p_seq and part = 'main') then
    raise exception 'that question has not been answered yet';
  end if;

  insert into ai_interview_answer_parts (interview_id, seq, part, question, kind)
  values (p_id, p_seq, 'followup', left(p_question, 400), left(p_kind, 40))
  on conflict (interview_id, seq, part) do nothing;

  select question into v_q from ai_interview_answer_parts
   where interview_id = p_id and seq = p_seq and part = 'followup';
  return v_q;
end $$;

-- ---------------------------------------------------------------------
-- a recording
--
-- Accepted while the interview runs, and for two hours after it completes
-- so the last answer's upload - which may still be in flight when the
-- candidate's final answer finishes the interview - is not refused.
-- Returns the storage key this replaced, if any, so the API can delete the
-- superseded file.
-- ---------------------------------------------------------------------
create or replace function ai_interview_recording_add(
  p_id text,
  p_candidate_id text,
  p_seq int,
  p_part text,
  p_path text,
  p_mime text,
  p_size int,
  p_duration_ms int,
  p_sha256 text
) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_iv ai_interviews%rowtype;
  v_old text;
begin
  select * into v_iv from ai_interviews where id = p_id and candidate_id = p_candidate_id;
  if not found then
    raise exception 'no such interview for this candidate';
  end if;
  if v_iv.status = 'suspended' then
    raise exception 'that interview is suspended';
  end if;
  if v_iv.status not in ('in_progress', 'warning_issued')
     and not (v_iv.status = 'completed' and v_iv.completed_at > now() - interval '2 hours') then
    raise exception 'that interview is already finished';
  end if;
  if not exists (select 1 from ai_interview_answers where ai_interview_id = p_id and seq = p_seq) then
    raise exception 'that question is not part of this interview';
  end if;
  if p_part not in ('main', 'followup') then
    raise exception 'unknown answer part';
  end if;

  select storage_path into v_old from ai_interview_recordings
   where interview_id = p_id and seq = p_seq and part = p_part;

  insert into ai_interview_recordings
    (interview_id, candidate_id, job_id, application_id, seq, part,
     storage_path, mime, size_bytes, duration_ms, sha256)
  values (p_id, v_iv.candidate_id, v_iv.job_id, v_iv.application_id, p_seq, p_part,
          p_path, p_mime, p_size, p_duration_ms, p_sha256)
  on conflict (interview_id, seq, part) do update
    set storage_path = excluded.storage_path,
        mime = excluded.mime,
        size_bytes = excluded.size_bytes,
        duration_ms = excluded.duration_ms,
        sha256 = excluded.sha256,
        created_at = now();

  return v_old;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant select on ai_interview_answer_parts to app_api;
    grant select on ai_interview_recordings to app_api;
    grant execute on function
      ai_interview_assert_running(text, text),
      ai_interview_part_save(text, text, int, text, boolean, text),
      ai_interview_followup_offer(text, text, int, text, text),
      ai_interview_recording_add(text, text, int, text, text, text, int, int, text)
      to app_api;
  end if;
end $$;
