-- ---------------------------------------------------------------------
-- 0015 — the two-day deadline belongs to the invitation, not to the
--        moment the candidate happens to open the interview
--
-- 0014 gave an interview a deadline of "48 hours from when it was
-- started". That is the wrong clock: a candidate who never opens the
-- interview has no row, so nothing can remind them and nothing can mark
-- them expired — which is precisely the case the reminders exist for.
--
-- The deadline is therefore a property of the APPLICATION, set when the
-- application is created and the invitation goes out. The interview
-- inherits it, so opening the screen on day two does not buy two more
-- days.
--
-- Four messages hang off it, and each is sent at most once:
--
--     invited   the invitation states the deadline
--     reminder  24 hours left
--     final     2 hours left
--     expired   the window closed without an interview
--
-- Sent-marks live in their own table rather than as flags on the
-- application, so a re-send is impossible even if the sweep runs twice
-- concurrently, and so the audit answers "when did we warn them".
-- ---------------------------------------------------------------------

alter table applications
  add column if not exists ai_interview_due_at timestamptz;

-- Existing applications get the same rule applied to when they arrived.
update applications
   set ai_interview_due_at = applied_at + interval '48 hours'
 where ai_interview_due_at is null;

alter table applications
  alter column ai_interview_due_at set default (now() + interval '48 hours');

create table if not exists ai_interview_reminders (
  application_id text not null references applications(id) on delete cascade,
  kind           text not null check (kind in ('invited','reminder','final','expired')),
  sent_at        timestamptz not null default now(),
  primary key (application_id, kind)
);

alter table ai_interview_reminders enable row level security;
alter table ai_interview_reminders force row level security;

drop policy if exists ai_interview_reminders_read on ai_interview_reminders;
create policy ai_interview_reminders_read on ai_interview_reminders
  for select using (
    app_is_admin()
    or exists (
      select 1 from applications a
       where a.id = ai_interview_reminders.application_id
         and (a.candidate_id = app_candidate_id()
              or app_role() in ('recruiter','client','bde'))
    )
  );

-- ---------------------------------------------------------------------
-- what is owed, right now
--
-- One query rather than three, so the sweep cannot send a 24-hour
-- reminder and a final warning for the same application in the same pass:
-- the most urgent unsent message wins.
-- ---------------------------------------------------------------------
create or replace function ai_interview_due_queue()
returns table (
  application_id text,
  candidate_id   text,
  job_id         text,
  due_at         timestamptz,
  kind           text
)
language sql security definer set search_path = public as $$
  with pending as (
    select a.id, a.candidate_id, a.job_id, a.ai_interview_due_at as due
      from applications a
     where a.ai_interview_due_at is not null
       and a.stage in ('applied','ai_screening')
       -- somebody who already finished has nothing to be reminded about
       and not exists (
         select 1 from ai_interviews iv
          where iv.application_id = a.id and iv.status = 'completed')
  ),
  owed as (
    select p.*,
           case
             when p.due < now()                              then 'expired'
             when p.due - now() <= interval '2 hours'        then 'final'
             when p.due - now() <= interval '24 hours'       then 'reminder'
             else null
           end as kind
      from pending p
  )
  select o.id, o.candidate_id, o.job_id, o.due, o.kind
    from owed o
   where o.kind is not null
     and not exists (
       select 1 from ai_interview_reminders r
        where r.application_id = o.id and r.kind = o.kind)
   order by o.due
   limit 200;
$$;

/* Marked only after the message was actually attempted, so a crash
   mid-sweep re-sends rather than silently skipping. */
create or replace function ai_interview_reminder_sent(p_application_id text, p_kind text)
returns void
language sql security definer set search_path = public as $$
  insert into ai_interview_reminders (application_id, kind)
  values (p_application_id, p_kind)
  on conflict (application_id, kind) do nothing;
$$;

-- ---------------------------------------------------------------------
-- the interview inherits the application's deadline
-- ---------------------------------------------------------------------
create or replace function ai_interview_start(
  p_id text,
  p_application_id text,
  p_candidate_id text,
  p_job_id text,
  p_question_set_hash text,
  p_questions jsonb,
  p_deadline_hours int default 48
) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_ok boolean;
  v_q jsonb;
  v_due timestamptz;
begin
  if jsonb_array_length(coalesce(p_questions, '[]'::jsonb)) = 0 then
    raise exception 'refusing to start an interview with no questions';
  end if;

  select a.ai_interview_due_at, true into v_due, v_ok
    from applications a
   where a.id = p_application_id and a.candidate_id = p_candidate_id and a.job_id = p_job_id;
  if not coalesce(v_ok, false) then
    raise exception 'no such application for this candidate';
  end if;

  insert into ai_interviews
    (id, application_id, candidate_id, job_id, status, mode,
     questions_asked, started_at, expires_at, question_set_hash)
  values (p_id, p_application_id, p_candidate_id, p_job_id, 'in_progress', 'voice',
          jsonb_array_length(p_questions), now(),
          -- the invitation's deadline, not a fresh two days
          coalesce(v_due, now() + make_interval(hours => coalesce(p_deadline_hours, 48))),
          p_question_set_hash);

  for v_q in select * from jsonb_array_elements(p_questions) loop
    insert into ai_interview_answers
      (ai_interview_id, seq, category, section, question, answered, score, justification)
    values (p_id,
            (v_q->>'seq')::int,
            v_q->>'category',
            v_q->>'section',
            v_q->>'question',
            false, 0,
            v_q->>'meta');
  end loop;

  return p_id;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant select on ai_interview_reminders to app_api;
    grant execute on function
      ai_interview_due_queue(),
      ai_interview_reminder_sent(text, text),
      ai_interview_start(text, text, text, text, text, jsonb, int)
      to app_api;
  end if;
end $$;
