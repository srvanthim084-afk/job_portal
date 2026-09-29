-- ---------------------------------------------------------------------
-- 0048 — the talent pool: a status of its own, and a record of how it got there
--
-- A candidate in the pool has TWO positions and they are not the same
-- thing. `applications.stage` says where one application has got to; it
-- is per job, and a person sourced for four requirements has four of
-- them. What was missing is where the PERSON is: sourced, spoken to,
-- interested, invited, registered. The talent pool screen derived it
-- from whatever it could see - an application here, a portal account
-- there, the outcome of the last AI call - which worked for most rows
-- and could not express the one case the brief is most explicit about:
--
--   "Invited - No Response" MUST be different from "Not Interested".
--
-- A candidate who was keen, was sent an invitation and never activated
-- it is a candidate to chase. One who said no is not. Derived from an
-- application and a portal account, both look identical: nothing.
--
-- So the status is stored, and the three things that move it are
-- recorded rather than inferred:
--
--   candidate_imports          which upload a person arrived on, who ran
--                              it, and what the file was called
--   candidate_merge_logs       which import decided two rows were one
--                              person, and what was added to the survivor
--   candidate_contact_history  every attempt to reach them, on every
--                              channel, with its outcome
--
-- WHAT THIS DOES NOT DO. It does not move anybody. Every existing
-- candidate starts at the status their current data already implies, and
-- the ATS stage is left completely alone - a pool status is not a
-- pipeline stage and merging the two would lose both.
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- the status itself
-- ---------------------------------------------------------------------

create table if not exists pool_statuses (
  id         text primary key,
  label      text not null,
  sort_order int  not null,
  -- Whether this status means the recruiter still has something to do.
  actionable boolean not null default false
);

insert into pool_statuses (id, label, sort_order, actionable) values
  ('sourced',             'Sourced',              10, true),
  ('ai_contacted',        'AI Contacted',         20, false),
  ('interested',          'Interested',           30, true),
  ('not_interested',      'Not Interested',       40, false),
  ('callback_requested',  'Callback Requested',   45, true),
  ('unreachable',         'No Response to Calls', 50, true),
  ('invited',             'Invited',              60, false),
  -- The distinction the brief insists on, and the reason for this file.
  ('invited_no_response', 'Invited – No Response',70, true),
  ('registered',          'Registered',           80, false),
  ('in_process',          'In Interview Process', 90, false),
  ('placed',              'Selected / Joined',   100, false)
on conflict (id) do update set
  label = excluded.label,
  sort_order = excluded.sort_order,
  actionable = excluded.actionable;

alter table candidates
  add column if not exists pool_status text not null default 'sourced'
    references pool_statuses(id);

-- ---------------------------------------------------------------------
-- where the existing rows start
--
-- Read off what is already true, so nothing is invented and nobody is
-- moved backwards. Deliberately conservative: a candidate whose
-- application is live is "in process" even if an AI call once said they
-- were interested, because the application is the later fact.
-- ---------------------------------------------------------------------

update candidates c set pool_status = 'placed'
 where exists (select 1 from applications a
                where a.candidate_id = c.id and a.stage in ('selected', 'joined'));

update candidates c set pool_status = 'in_process'
 where c.pool_status = 'sourced'
   and exists (select 1 from applications a
                where a.candidate_id = c.id
                  and a.stage in ('shortlisted', 'with_bde', 'interview_scheduled',
                                  'ai_interview_done', 'client_review', 'offer_extended'));

update candidates c set pool_status = 'registered'
 where c.pool_status = 'sourced'
   and exists (select 1 from users u where u.id = c.user_id);

update candidates c set pool_status = 'ai_contacted'
 where c.pool_status = 'sourced'
   and exists (select 1 from ai_call_sessions s where s.candidate_id = c.id);

-- ---------------------------------------------------------------------
-- indexes the pool needs (requirement 29)
--
-- The pool is searched on phone and email every time a duplicate is
-- looked for, which is once per imported row: a 400-row upload does 400
-- of these. Both were unindexed.
-- ---------------------------------------------------------------------

create index if not exists cand_email_lower_idx on candidates (lower(email));
-- The LAST TEN DIGITS, because that is what the duplicate check compares:
-- "+91 98450 00111" and "9845000111" are one number.
create index if not exists cand_phone10_idx
  on candidates (right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10));
create index if not exists cand_pool_status_idx on candidates (pool_status);
create index if not exists apps_candidate_job_idx on applications (candidate_id, job_id);

-- ---------------------------------------------------------------------
-- where a candidate came from
-- ---------------------------------------------------------------------

create table if not exists candidate_imports (
  id            text primary key,
  filename      text,
  format        text,                       -- 'csv' | 'xlsx'
  total_rows    int  not null default 0,
  created_count int  not null default 0,
  merged_count  int  not null default 0,
  skipped_count int  not null default 0,
  -- The mapping that was actually used, after the recruiter's
  -- corrections: "why did this column land in Notice Period" has an
  -- answer months later.
  column_map    jsonb not null default '{}'::jsonb,
  imported_by   uuid references users(id),
  recruiter_id  text,
  created_at    timestamptz not null default now()
);
create index if not exists candidate_imports_by_who on candidate_imports (recruiter_id, created_at desc);

alter table candidates
  add column if not exists import_id text references candidate_imports(id),
  add column if not exists sourced_at timestamptz;

-- ---------------------------------------------------------------------
-- which two rows were one person
-- ---------------------------------------------------------------------

create table if not exists candidate_merge_logs (
  id           bigserial primary key,
  candidate_id text not null references candidates(id) on delete cascade,
  import_id    text references candidate_imports(id),
  -- Matched on what: 'email', 'phone', 'email+phone', 'name+company'...
  matched_on   text,
  -- What the incoming row said, and what was actually filled in. The
  -- merge only ever fills gaps, so this is the record of which gaps.
  incoming     jsonb not null default '{}'::jsonb,
  filled       jsonb not null default '{}'::jsonb,
  merged_by    uuid references users(id),
  created_at   timestamptz not null default now()
);
create index if not exists candidate_merge_logs_by_cand on candidate_merge_logs (candidate_id, created_at desc);

-- ---------------------------------------------------------------------
-- every attempt to reach them
--
-- ai_call_sessions already records the CALLS in detail; this is the
-- wider log the pool screen reads - calls, invitations, reminders - so
-- "last contacted" is one query rather than a union of four.
-- ---------------------------------------------------------------------

create table if not exists candidate_contact_history (
  id           bigserial primary key,
  candidate_id text not null references candidates(id) on delete cascade,
  job_id       text references jobs(id) on delete set null,
  channel      text not null,               -- 'ai_call' | 'email' | 'sms' | 'whatsapp'
  direction    text not null default 'out',
  outcome      text,                        -- 'interested' | 'not_interested' | 'no_answer' | 'sent' | ...
  detail       text,
  ref_id       text,                        -- the ai_call_sessions row, invite row, ...
  contacted_by uuid references users(id),
  created_at   timestamptz not null default now()
);
create index if not exists cch_by_candidate on candidate_contact_history (candidate_id, created_at desc);
create index if not exists cch_by_job on candidate_contact_history (job_id, created_at desc);

-- ---------------------------------------------------------------------
-- who may read any of it
--
-- The same rule the rest of the pool follows: whatever RLS on
-- `candidates` already decides a recruiter can see. None of these tables
-- widens that - each one is joined back to a candidate row the reader
-- can already read - and none of them is writable directly.
-- ---------------------------------------------------------------------

alter table candidate_imports enable row level security;
alter table candidate_imports force  row level security;
create policy cimp_read on candidate_imports for select using (
  app_is_admin() or app_role() in ('recruiter', 'bde')
);
create policy cimp_no_direct_write on candidate_imports for all
  using (app_is_admin()) with check (app_is_admin());

alter table candidate_merge_logs enable row level security;
alter table candidate_merge_logs force  row level security;
create policy cml_read on candidate_merge_logs for select using (
  app_is_admin()
  or (app_role() in ('recruiter', 'bde') and exists (
        select 1 from candidates c where c.id = candidate_merge_logs.candidate_id))
);
create policy cml_no_direct_write on candidate_merge_logs for all
  using (app_is_admin()) with check (app_is_admin());

alter table candidate_contact_history enable row level security;
alter table candidate_contact_history force  row level security;
create policy cch_read on candidate_contact_history for select using (
  app_is_admin()
  or candidate_id = app_candidate_id()
  or (app_role() in ('recruiter', 'bde') and exists (
        select 1 from candidates c where c.id = candidate_contact_history.candidate_id))
);
create policy cch_no_direct_write on candidate_contact_history for all
  using (app_is_admin()) with check (app_is_admin());

-- ---------------------------------------------------------------------
-- moving a candidate's pool status
--
-- SECURITY DEFINER, and it only ever moves FORWARD through the
-- lifecycle - with two deliberate exceptions, because both are things
-- that genuinely happen:
--
--   a candidate who said no can be sourced again for a different role,
--   so 'not_interested' may be set from anything;
--   'invited_no_response' may be set from 'invited', which is a sideways
--   move rather than a forward one.
--
-- Everything else is guarded, so a stale webhook arriving late cannot
-- take somebody who has since been placed back to "AI Contacted".
-- ---------------------------------------------------------------------

create or replace function candidate_pool_status(
  p_candidate_id text,
  p_status text,
  p_reason text default null
) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_now  int;
  v_next int;
  v_cur  text;
begin
  select pool_status into v_cur from candidates where id = p_candidate_id;
  if v_cur is null then return null; end if;

  select sort_order into v_now  from pool_statuses where id = v_cur;
  select sort_order into v_next from pool_statuses where id = p_status;
  if v_next is null then
    raise exception '"%" is not a pool status', p_status;
  end if;

  if p_status in ('not_interested', 'invited_no_response', 'callback_requested', 'unreachable')
     or v_next > v_now then
    update candidates
       set pool_status = p_status, updated_at = now()
     where id = p_candidate_id;
    return p_status;
  end if;

  -- Already further along; the caller is told what it actually is.
  return v_cur;
end $$;

/**
 * Record one contact attempt, and move the status if it implies one.
 *
 * The two belong together: every path that contacts a candidate has to
 * do both, and splitting them is how a call gets logged without the
 * status moving, or the reverse.
 */
create or replace function candidate_contact_record(
  p_candidate_id text,
  p_channel text,
  p_outcome text,
  p_job_id text default null,
  p_detail text default null,
  p_ref_id text default null,
  p_by uuid default null
) returns bigint
language plpgsql security definer set search_path = public as $$
declare
  v_id bigint;
begin
  insert into candidate_contact_history
    (candidate_id, job_id, channel, outcome, detail, ref_id, contacted_by)
  values (p_candidate_id, p_job_id, p_channel, p_outcome, p_detail, p_ref_id, p_by)
  returning id into v_id;

  -- What the outcome means for where this person now sits.
  if    p_outcome = 'interested'         then perform candidate_pool_status(p_candidate_id, 'interested', p_detail);
  elsif p_outcome = 'not_interested'     then perform candidate_pool_status(p_candidate_id, 'not_interested', p_detail);
  elsif p_outcome = 'callback_requested' then perform candidate_pool_status(p_candidate_id, 'callback_requested', p_detail);
  elsif p_outcome = 'no_answer'          then perform candidate_pool_status(p_candidate_id, 'ai_contacted', p_detail);
  elsif p_channel = 'ai_call'            then perform candidate_pool_status(p_candidate_id, 'ai_contacted', p_detail);
  end if;

  return v_id;
end $$;

/**
 * An invitation that was never taken up.
 *
 * Run by the sweep rather than set at invite time, because "no response"
 * is the absence of something and can only be known after a wait. The
 * window is a parameter so it can be tuned without a migration.
 */
create or replace function candidates_invited_no_response(p_days int default 7)
returns int
language plpgsql security definer set search_path = public as $$
declare
  n int;
begin
  with stale as (
    select c.id
      from candidates c
      join candidate_invites i on i.candidate_id = c.id
     where c.pool_status = 'invited'
       and c.user_id is null                       -- never activated
     group by c.id
    having max(i.created_at) < now() - make_interval(days => p_days)
  )
  update candidates c
     set pool_status = 'invited_no_response', updated_at = now()
    from stale s
   where c.id = s.id;
  get diagnostics n = row_count;
  return n;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant select on pool_statuses, candidate_imports, candidate_merge_logs,
                    candidate_contact_history to app_api;
    grant execute on function
      candidate_pool_status(text, text, text),
      candidate_contact_record(text, text, text, text, text, text, uuid),
      candidates_invited_no_response(int)
      to app_api;
  end if;
end $$;
