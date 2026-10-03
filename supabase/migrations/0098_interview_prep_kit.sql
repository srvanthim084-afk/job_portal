-- ---------------------------------------------------------------------
-- 0098 — Interview prep kit
--
-- When a recruiter schedules an interview, the candidate gets a prep kit:
-- the details, likely questions with "why they ask", tips, what to bring
-- (as a checklist), a calendar file and reminders.
--
-- HARD RULE: the candidate never learns the client's name from the kit
-- (0051). Nothing here stores or exposes the company: the candidate view
-- below has the job TITLE and no company column at all. The only thing
-- that can reveal the company is the venue address or meeting link, which
-- the recruiter types and then explicitly RELEASES - until
-- details_released_at is set, the candidate view returns null for venue,
-- link and contact.
--
--   interviews (+columns)          where, how long, who to call, notes, release
--   interview_prep_kits            one per interview: questions, tips, bring list
--   interview_prep_checklist       the candidate's ticks on the bring list
--   interview_prep_messages        every message sent about an interview, per
--                                  channel and per slot - the guard that keeps a
--                                  reminder from going twice, and that makes a
--                                  reschedule start the reminders afresh
--   candidate_interview_prep_v     what the candidate may read
--
-- Recruiters of the job (its company, or its owner) and admins read and
-- write kits; a client user cannot read them at all.
-- ---------------------------------------------------------------------

alter table interviews
  add column if not exists location_type text,
  add column if not exists venue_address text,
  add column if not exists meeting_link text,
  add column if not exists duration_minutes int,
  add column if not exists contact_person text,
  add column if not exists contact_phone text,
  add column if not exists candidate_instructions text,
  add column if not exists details_released_at timestamptz,
  add column if not exists starts_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'interviews_location_type_chk') then
    alter table interviews add constraint interviews_location_type_chk
      check (location_type is null or location_type in ('in_person','video','phone','teamlink_ai'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'interviews_prep_lengths_chk') then
    alter table interviews add constraint interviews_prep_lengths_chk
      check ((candidate_instructions is null or char_length(candidate_instructions) <= 1000)
         and (venue_address is null or char_length(venue_address) <= 500)
         and (meeting_link is null or char_length(meeting_link) <= 500)
         and (duration_minutes is null or duration_minutes between 5 and 600));
  end if;
end $$;

create index if not exists interviews_starts_at on interviews (starts_at) where status = 'Scheduled';

create table if not exists interview_prep_kits (
  id              text primary key,
  interview_id    text not null unique references interviews(id) on delete cascade,
  questions       jsonb not null default '[]'::jsonb,   -- [{q, why, topic}]
  tips            jsonb not null default '[]'::jsonb,   -- [text]
  bring_list      jsonb not null default '[]'::jsonb,   -- [{key, text}]
  generated_by    text not null default 'rules' check (generated_by in ('rules','ai')),
  engine_note     text,                                 -- why the rules ran, when AI was wanted
  generated_at    timestamptz not null default now(),
  recruiter_edited boolean not null default false,
  edited_by       text,
  edited_at       timestamptz,
  sent_at         timestamptz,
  viewed_at       timestamptz,
  created_at      timestamptz not null default now()
);

create table if not exists interview_prep_checklist (
  kit_id    text not null references interview_prep_kits(id) on delete cascade,
  item_key  text not null,
  done      boolean not null default false,
  done_at   timestamptz,
  primary key (kit_id, item_key)
);

create table if not exists interview_prep_messages (
  id            bigserial primary key,
  interview_id  text not null references interviews(id) on delete cascade,
  kind          text not null check (kind in ('scheduled','kit','day_before','two_hours',
                                              'rescheduled','cancelled','status_nudge')),
  slot          text not null default '',      -- the start time it was about
  channel       text not null check (channel in ('email','sms','whatsapp','in_app')),
  status        text not null,
  to_address    text,
  provider      text,
  provider_ref  text,
  error         text,
  created_at    timestamptz not null default now()
);
-- A reminder for one slot goes once per channel, however many sweeps run.
create unique index if not exists interview_prep_messages_once
  on interview_prep_messages (interview_id, kind, slot, channel)
  where kind in ('day_before','two_hours','status_nudge');
create index if not exists interview_prep_messages_iv on interview_prep_messages (interview_id, created_at);

-- ---------------------------------------------------------------------
-- who may touch a kit
-- ---------------------------------------------------------------------

/** The job's recruiters and admins (never a client, never a candidate). */
create or replace function prep_kit_staff_ok(p_interview text) returns boolean
language sql stable security definer set search_path = public as $$
  select app_is_admin()
      or (app_role() = 'recruiter' and exists (
            select 1 from interviews i join jobs j on j.id = i.job_id
             where i.id = p_interview
               and (j.company_id = app_recruiter_company() or j.recruiter_id = app_recruiter_id())))
$$;

/** The candidate whose interview this kit is for. */
create or replace function prep_kit_candidate_ok(p_kit text) returns boolean
language sql stable security definer set search_path = public as $$
  select app_role() = 'candidate' and exists (
    select 1 from interview_prep_kits k join interviews i on i.id = k.interview_id
     where k.id = p_kit and i.candidate_id = app_candidate_id() and k.sent_at is not null)
$$;

alter table interview_prep_kits      enable row level security;
alter table interview_prep_checklist enable row level security;
alter table interview_prep_messages  enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'interview_prep_kits' and policyname = 'prep_kits_staff') then
    create policy prep_kits_staff on interview_prep_kits for all
      using (app_role() in ('admin','recruiter','bde') and prep_kit_staff_ok(interview_id))
      with check (app_role() in ('admin','recruiter') and prep_kit_staff_ok(interview_id));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'interview_prep_checklist' and policyname = 'prep_checklist_rw') then
    create policy prep_checklist_rw on interview_prep_checklist for all
      using (prep_kit_candidate_ok(kit_id)
             or (app_role() in ('admin','recruiter','bde') and exists (
                   select 1 from interview_prep_kits k where k.id = interview_prep_checklist.kit_id)))
      with check (prep_kit_candidate_ok(kit_id));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'interview_prep_messages' and policyname = 'prep_messages_staff') then
    create policy prep_messages_staff on interview_prep_messages for select
      using (app_role() in ('admin','recruiter','bde') and prep_kit_staff_ok(interview_id));
  end if;
end $$;

-- ---------------------------------------------------------------------
-- what the candidate reads
--
-- Their own interviews, kits that have been SENT, no company anywhere,
-- and venue / link / contact only once released. The interviewer's name
-- is left out too: it is often somebody at the client.
-- ---------------------------------------------------------------------
create or replace view candidate_interview_prep_v as
  select i.id as interview_id,
         i.candidate_id,
         i.job_id,
         j.title as job_title,
         i.type, i.mode, i.status,
         i.scheduled_date, i.scheduled_time, i.starts_at,
         coalesce(i.duration_minutes, 60) as duration_minutes,
         i.location_type,
         case when i.details_released_at is not null then i.venue_address end as venue_address,
         case when i.details_released_at is not null then i.meeting_link end as meeting_link,
         case when i.details_released_at is not null then i.contact_person end as contact_person,
         case when i.details_released_at is not null then i.contact_phone end as contact_phone,
         i.details_released_at is not null as details_released,
         i.candidate_instructions,
         k.id as kit_id, k.questions, k.tips, k.bring_list, k.generated_at, k.sent_at, k.viewed_at
    from interviews i
    join jobs j on j.id = i.job_id
    left join interview_prep_kits k on k.interview_id = i.id and k.sent_at is not null
   where app_role() = 'candidate' and i.candidate_id = app_candidate_id();

/** The candidate opened their kit. First time only. */
create or replace function prep_kit_mark_viewed(p_interview text) returns timestamptz
language plpgsql security definer set search_path = public as $$
declare v timestamptz;
begin
  update interview_prep_kits k set viewed_at = coalesce(k.viewed_at, now())
    from interviews i
   where k.interview_id = p_interview and i.id = k.interview_id
     and app_role() = 'candidate' and i.candidate_id = app_candidate_id()
     and k.sent_at is not null
  returning k.viewed_at into v;
  return v;
end $$;

/** A message about an interview was attempted. Recorded by the API. */
create or replace function prep_message_add(
  p_interview text, p_kind text, p_slot text, p_channel text, p_status text,
  p_to text, p_provider text, p_ref text, p_error text
) returns bigint
language plpgsql security definer set search_path = public as $$
declare v_id bigint;
begin
  if app_role() not in ('admin','recruiter') then
    raise exception 'interview messages are recorded by the API only' using errcode = '42501';
  end if;
  insert into interview_prep_messages
    (interview_id, kind, slot, channel, status, to_address, provider, provider_ref, error)
  values (p_interview, p_kind, coalesce(p_slot, ''), p_channel, p_status, p_to, p_provider, p_ref, left(p_error, 500))
  on conflict do nothing
  returning id into v_id;
  return v_id;
end $$;

/** Claim a reminder slot (one row per interview/kind/slot) before sending it. */
create or replace function prep_reminder_claim(p_interview text, p_kind text, p_slot text)
returns boolean
language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  if not (app_role() = 'admin' and app_user_id() is null) then
    raise exception 'reminders are claimed by the API engine only' using errcode = '42501';
  end if;
  insert into interview_prep_messages (interview_id, kind, slot, channel, status)
  values (p_interview, p_kind, p_slot, 'in_app', 'claimed')
  on conflict do nothing;
  get diagnostics v_n = row_count;
  return v_n > 0;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant select, insert, update, delete on interview_prep_kits to app_api;
    grant select, insert, update, delete on interview_prep_checklist to app_api;
    grant select on interview_prep_messages to app_api;
    grant usage, select on sequence interview_prep_messages_id_seq to app_api;
    grant select on candidate_interview_prep_v to app_api;
    grant execute on function prep_kit_staff_ok(text) to app_api;
    grant execute on function prep_kit_candidate_ok(text) to app_api;
    grant execute on function prep_kit_mark_viewed(text) to app_api;
    grant execute on function prep_message_add(text, text, text, text, text, text, text, text, text) to app_api;
    grant execute on function prep_reminder_claim(text, text, text) to app_api;
  end if;
end $$;

insert into notification_templates (event_key, label, fires_on) values
  ('interview_prep_scheduled',  'Interview Prep Kit — Scheduled',   array['INTERVIEW_PREP_SCHEDULED']),
  ('interview_prep_reminder',   'Interview Prep Kit — Reminder',    array['INTERVIEW_PREP_REMINDER']),
  ('interview_prep_changed',    'Interview Prep Kit — Rescheduled / Cancelled', array['INTERVIEW_PREP_CHANGED'])
on conflict (event_key) do nothing;

comment on table interview_prep_kits is
  'A candidate''s prep kit for one interview. Never contains the client company. Candidates read candidate_interview_prep_v; clients cannot read kits.';
