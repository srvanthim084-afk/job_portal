-- ---------------------------------------------------------------------
-- 0076 — what TeamLink actually knows about an external application
--
-- THE ONE RULE THIS WHOLE MIGRATION SERVES. TeamLink hands a candidate a
-- link to somebody else's website. It cannot see what they do there. It
-- cannot know whether they finished the form, whether the employer got
-- it, or whether the employer replied. Every "Applied" on an external
-- job is therefore the CANDIDATE'S OWN STATEMENT, and the schema is
-- shaped so the screens cannot accidentally imply otherwise.
--
-- WHAT WAS MISSING. `external_applications` recorded a status and when
-- it was created, and nothing about the conversation that produces the
-- status: when the link was opened, how many times, whether we have
-- asked the candidate yet, when they answered, whether a reminder went
-- out. Without those the portal either never asks, or asks for ever.
--
-- ADDITIVE. Five nullable or defaulted columns, two status values, one
-- log table. No column is dropped or renamed.
-- ---------------------------------------------------------------------
alter table external_applications
  /* When the CANDIDATE told us. Null on every row that is still just a
     click, which is what separates "they opened it" from "they say they
     did it". */
  add column if not exists confirmed_at     timestamptz,
  /* When the "Did you apply?" question was put to them. Set once, so the
     same click cannot produce the dialog twice. */
  add column if not exists prompt_shown_at  timestamptz,
  /* When the one reminder went. One per application, for ever. */
  add column if not exists reminder_sent_at timestamptz,
  /* The last time they opened the employer's link, and how often. A
     candidate who has opened a posting four times and answered nothing
     is a different case from one who opened it once. */
  add column if not exists last_opened_at   timestamptz,
  add column if not exists open_count       int not null default 0,
  /* The candidate's own note against one application - "asked for a
     reference", "site was down". Theirs, short, and never interpreted. */
  add column if not exists notes            text;

create index if not exists exapp_pending_idx
  on external_applications (candidate_id, status, created_at)
  where confirmed_at is null;

-- ---------------------------------------------------------------------
-- the statuses this flow actually uses
--
-- 'applied_unconfirmed' already meant exactly "the candidate says they
-- applied and we cannot check", so it is RELABELLED rather than
-- duplicated - two statuses meaning the same thing is how a report ends
-- up counting one of them.
--
-- The label carries the meaning on its face: nothing reading this table
-- can render "Applied" without also rendering where it was applied.
-- ---------------------------------------------------------------------
insert into external_application_statuses (id, label, sort_order, terminal) values
  ('clicked',   'Clicked',   5,  false),
  ('dismissed', 'Dismissed', 95, true)
on conflict (id) do nothing;

update external_application_statuses
   set label = 'Applied on External Site'
 where id = 'applied_unconfirmed';

-- ---------------------------------------------------------------------
-- every change, and who made it
--
-- For support and debugging only. It is NEVER shown to a candidate as
-- evidence that anything was verified - it records what this system was
-- told, not what an employer did.
-- ---------------------------------------------------------------------
create table if not exists external_application_status_log (
  id          bigserial primary key,
  application_id text not null references external_applications(id) on delete cascade,
  from_status text,
  to_status   text not null,
  /* 'candidate', 'recruiter', 'cron', 'system' - who caused it, not who
     they are. The user id goes in `actor_id` when there is one. */
  actor       text not null default 'system',
  actor_id    text,
  note        text,
  created_at  timestamptz not null default now()
);
create index if not exists exapp_log_idx
  on external_application_status_log (application_id, created_at desc);

alter table external_application_status_log enable row level security;
alter table external_application_status_log force  row level security;

create policy exlog_read on external_application_status_log for select using (
  app_is_admin() or app_role() in ('recruiter', 'bde'));
create policy exlog_no_direct_write on external_application_status_log for all
  using (app_is_admin()) with check (app_is_admin());

grant select on external_application_status_log to app_api;
grant usage, select on sequence external_application_status_log_id_seq to app_api;

-- ---------------------------------------------------------------------
-- opening the employer's link
--
-- Called every time the candidate presses Apply or "Open job again". It
-- never creates a second row: the unique key on (candidate, job) means
-- there is one application per posting, and this records another visit
-- to it.
-- ---------------------------------------------------------------------
create or replace function external_application_opened(p_id text)
returns int
language plpgsql security definer set search_path = public as $$
declare v_count int;
begin
  update external_applications
     set open_count = coalesce(open_count, 0) + 1,
         last_opened_at = now(),
         updated_at = now()
   where id = p_id
  returning open_count into v_count;
  return coalesce(v_count, -1);
end $$;

/** The question has been put. Set once; a second call is a no-op. */
create or replace function external_application_prompt_shown(p_id text)
returns boolean
language plpgsql security definer set search_path = public as $$
declare v_hit boolean;
begin
  update external_applications
     set prompt_shown_at = now(), updated_at = now()
   where id = p_id and prompt_shown_at is null;
  get diagnostics v_hit = row_count;
  return v_hit;
end $$;

/** Their own note against one application. Capped in the database as
    well as at the edge, so a caller that forgets cannot write an essay. */
create or replace function external_application_notes(p_id text, p_notes text)
returns external_applications
language sql security definer set search_path = public as $$
  update external_applications
     set notes = nullif(btrim(left(coalesce(p_notes, ''), 500)), ''),
         updated_at = now()
   where id = p_id
  returning *;
$$;

-- ---------------------------------------------------------------------
-- the candidate's answer
--
-- ONE PLACE WHERE STATUS CHANGES, so the audit trail cannot be bypassed
-- and the match row cannot drift out of step with the application.
--
-- THE GUARD. An application that has been answered does not silently go
-- back to 'clicked'. It is how a confirmed "yes" would quietly become an
-- open question again, and a report of "43 applied" would shrink
-- overnight with nothing to explain it. Re-opening the posting is an
-- explicit act and passes p_reopen.
--
-- @returns the status actually in force afterwards, so a caller that
--          lost a race is told the truth rather than an error.
-- ---------------------------------------------------------------------
create or replace function external_application_mark(
  p_id text,
  p_status text,
  p_actor text,
  p_actor_id text,
  p_note text default null,
  p_reopen boolean default false
) returns text
language plpgsql security definer set search_path = public as $$
declare v_old text; v_cand text; v_job text; v_confirmed timestamptz;
begin
  select status, candidate_id, external_job_id, confirmed_at
    into v_old, v_cand, v_job, v_confirmed
    from external_applications where id = p_id for update;
  if not found then return null; end if;

  if p_status not in ('clicked', 'applied_unconfirmed', 'not_applied', 'dismissed') then
    return v_old;
  end if;

  /* Nothing to do, and nothing to log. A second tab answering the same
     way is not an error. */
  if v_old = p_status then return v_old; end if;

  /* Backwards out of an answered state, without meaning to. */
  if v_old in ('applied_unconfirmed', 'not_applied')
     and p_status = 'clicked' and not p_reopen then
    return v_old;
  end if;

  update external_applications
     set status = p_status,
         confirmed_at = case
           when p_status in ('applied_unconfirmed', 'not_applied') then now()
           when p_status = 'clicked' then null
           else confirmed_at end,
         updated_at = now()
   where id = p_id;

  insert into external_application_status_log
    (application_id, from_status, to_status, actor, actor_id, note)
  values (p_id, v_old, p_status, coalesce(p_actor, 'system'), p_actor_id, p_note);

  /*
   * THE MATCH ROW MOVES WITH IT, in this same transaction.
   *
   * There is no `status` column on candidate_external_job_matches and
   * this does not add one: whether a candidate applied is already
   * answered by whether an application row exists, and a second copy of
   * that answer is a second thing that can be wrong. What the match DOES
   * hold on its own is `dismissed_at`, which decides whether the card is
   * still offered - so that is what moves.
   *
   *   dismissed      -> hide the card
   *   not applied    -> put it back; the candidate looked and did not
   *                     apply, which is not a reason to stop showing it
   *   applied        -> left alone; the Recommended list already knows
   *                     from the application row
   */
  if p_status = 'dismissed' then
    update candidate_external_job_matches
       set dismissed_at = now(), updated_at = now()
     where candidate_id = v_cand and external_job_id = v_job
       and dismissed_at is null;
  elsif p_status = 'not_applied' then
    update candidate_external_job_matches
       set dismissed_at = null, updated_at = now()
     where candidate_id = v_cand and external_job_id = v_job
       and dismissed_at is not null;
  end if;

  return p_status;
end $$;

/**
 * Write one line into the trail directly.
 *
 * Used for the FIRST click, which is not a transition - the row did not
 * exist a moment earlier - and so never passes through
 * external_application_mark. Without this the lifecycle of an
 * application starts halfway through, which is the one thing a support
 * log must not do.
 */
create or replace function external_application_log(
  p_id text, p_from text, p_to text, p_actor text, p_actor_id text, p_note text
) returns void
language sql security definer set search_path = public as $$
  insert into external_application_status_log
    (application_id, from_status, to_status, actor, actor_id, note)
  values (p_id, p_from, p_to, coalesce(p_actor, 'system'), p_actor_id, p_note);
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant execute on function external_application_log(text, text, text, text, text, text)
      to app_api;
    grant execute on function external_application_opened(text) to app_api;
    grant execute on function external_application_prompt_shown(text) to app_api;
    grant execute on function external_application_notes(text, text) to app_api;
    grant execute on function external_application_mark(text, text, text, text, text, boolean)
      to app_api;
  end if;
end $$;
