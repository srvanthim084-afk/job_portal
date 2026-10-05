-- ---------------------------------------------------------------------
-- 0104  One-click apply: candidate messages wait for the Undo window
--
-- One-click apply offers a 10-second Undo (application_undo(), 0095), but
-- the confirmation and the AI interview invitation went out the moment
-- the application existed, so an Undo could not recall them.
--
-- An application made by one-click apply now gets a HOLD row in the same
-- transaction that creates it. The candidate-facing messages are sent
-- when the hold falls due (the Undo window plus a small margin), and
-- only if the application still exists: Undo deletes the application,
-- and the hold goes with it (on delete cascade), so nothing is sent.
--
-- The hold is a row, not only a timer, so a restart in between still
-- sends once: the sweep picks up any hold that is due and unsent. The
-- claim is one UPDATE, so two sweeps (or a sweep and the in-process
-- timer) cannot both send it.
--
-- Recruiter-facing effects are unchanged and are not held.
--
-- (The screening questions on AI calls need no schema: the answer
-- source 'ai_call' was reserved by 0097, and the admin switch lives in
-- app_settings.screening.askOnAiCalls.)
-- ---------------------------------------------------------------------

create table if not exists application_outbound_holds (
  application_id text primary key references applications(id) on delete cascade,
  candidate_id   text not null,
  job_id         text not null,
  reason         text not null default 'one_click_undo',
  due_at         timestamptz not null,
  created_at     timestamptz not null default now(),
  claimed_at     timestamptz,
  sent_at        timestamptz,
  attempts       int not null default 0,
  last_error     text
);

create index if not exists application_outbound_holds_due_idx
  on application_outbound_holds (due_at) where sent_at is null;

comment on table application_outbound_holds is
  'Candidate messages of a one-click application, held until the Undo window has passed (0104).';

alter table application_outbound_holds enable row level security;
alter table application_outbound_holds force  row level security;

drop policy if exists application_outbound_holds_read on application_outbound_holds;
create policy application_outbound_holds_read on application_outbound_holds
  for select using (app_role() = 'admin');

/* The engine's door: role admin with no person behind it (as 0086). */
create or replace function application_outbound_engine_guard() returns void
language plpgsql as $$
begin
  if not (app_role() = 'admin' and app_user_id() is null) then
    raise exception 'held messages are sent by the API engine only' using errcode = '42501';
  end if;
end $$;

/*
 * Hold an application's candidate messages. Called in the transaction
 * that creates the application, by its candidate. The hold falls due
 * p_seconds after applied_at, never sooner than the 10-second Undo
 * window plus one second.
 */
create or replace function application_outbound_hold(p_app text, p_seconds numeric)
returns timestamptz
language plpgsql security definer set search_path = public as $$
declare a record; v_due timestamptz;
begin
  select id, candidate_id, job_id, applied_at into a from applications where id = p_app;
  if not found then raise exception 'no such application' using errcode = 'P0002'; end if;
  if not (app_role() = 'admin'
          or (app_role() = 'candidate' and a.candidate_id = app_candidate_id())) then
    raise exception 'only the applicant can hold these messages' using errcode = '42501';
  end if;
  insert into application_outbound_holds (application_id, candidate_id, job_id, due_at)
  values (a.id, a.candidate_id, a.job_id,
          a.applied_at + make_interval(secs => greatest(coalesce(p_seconds, 15), 11)))
  on conflict (application_id) do nothing
  returning due_at into v_due;
  return v_due;
end $$;

/* Holds that are due and not sent (or whose claim went stale). */
create or replace function application_outbound_due(p_now timestamptz, p_lease_seconds int default 600)
returns setof text
language plpgsql security definer set search_path = public as $$
begin
  perform application_outbound_engine_guard();
  return query
    select h.application_id from application_outbound_holds h
     where h.sent_at is null and h.due_at <= p_now
       and (h.claimed_at is null or h.claimed_at < p_now - make_interval(secs => p_lease_seconds))
     order by h.due_at
     limit 200;
end $$;

/*
 * Claim one due hold. One UPDATE: of two callers racing for the same row,
 * the second re-reads it after the first commits and claims nothing.
 */
create or replace function application_outbound_claim(p_app text, p_now timestamptz, p_lease_seconds int default 600)
returns setof application_outbound_holds
language plpgsql security definer set search_path = public as $$
begin
  perform application_outbound_engine_guard();
  return query
    update application_outbound_holds h
       set claimed_at = p_now, attempts = h.attempts + 1
     where h.application_id = p_app
       and h.sent_at is null
       and h.due_at <= p_now
       and (h.claimed_at is null or h.claimed_at < p_now - make_interval(secs => p_lease_seconds))
       and exists (select 1 from applications a where a.id = h.application_id)
    returning h.*;
end $$;

/* The messages were dispatched (each channel's outcome is in notification_deliveries). */
create or replace function application_outbound_done(p_app text, p_error text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  perform application_outbound_engine_guard();
  update application_outbound_holds
     set sent_at = now(), last_error = left(p_error, 400)
   where application_id = p_app;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant select on application_outbound_holds to app_api;
    grant execute on function application_outbound_hold(text, numeric) to app_api;
    grant execute on function application_outbound_due(timestamptz, int) to app_api;
    grant execute on function application_outbound_claim(text, timestamptz, int) to app_api;
    grant execute on function application_outbound_done(text, text) to app_api;
  end if;
end $$;
