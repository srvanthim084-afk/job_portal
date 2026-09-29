-- ---------------------------------------------------------------------
-- 0077 — one reminder, and only one
--
-- A candidate who opened an employer's link and never came back to say
-- what happened leaves a row that says "Clicked" for ever. One reminder
-- is worth sending. Two is nagging, and two from two overlapping runs of
-- the same hourly sweep is a bug that only shows up under load.
--
-- THE CLAIM IS THE GUARD. The sweep does not "read a list, then send,
-- then mark". It marks and takes in ONE statement: an UPDATE ...
-- RETURNING under a row lock, so a second run starting a moment later
-- finds nothing left to claim. Nothing in the application layer has to
-- be careful.
--
-- THE STATUS IS CHECKED HERE, NOT ONLY IN THE SWEEP. A candidate who
-- answered between the sweep picking the row and the message going out
-- must not be reminded about something they have already told us.
-- ---------------------------------------------------------------------
create or replace function external_application_claim_reminders(
  p_hours int, p_limit int default 200
) returns setof external_applications
language sql security definer set search_path = public as $$
  with due as (
    select a.id
      from external_applications a
     where a.status = 'clicked'
       and a.confirmed_at is null
       and a.reminder_sent_at is null
       /* greatest(0, ...) rather than greatest(1, ...): an operator who
          sets the wait to zero, to try the sweep out, means zero. */
       and a.created_at <= now() - make_interval(hours => greatest(0, coalesce(p_hours, 24)))
     order by a.created_at asc
     limit greatest(1, coalesce(p_limit, 200))
     /* Anything another run has already taken is skipped rather than
        waited for - the point is that two runs share the work, not that
        one blocks behind the other. */
     for update skip locked
  )
  update external_applications a
     set reminder_sent_at = now(), updated_at = now()
    from due
   where a.id = due.id
  returning a.*;
$$;

/**
 * Give a claim back.
 *
 * Used when the message could not be sent at all. Leaving it claimed
 * would mean the one reminder this application was entitled to was spent
 * on a delivery that never happened.
 */
create or replace function external_application_release_reminder(p_id text)
returns void
language sql security definer set search_path = public as $$
  update external_applications
     set reminder_sent_at = null, updated_at = now()
   where id = p_id;
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant execute on function external_application_claim_reminders(int, int) to app_api;
    grant execute on function external_application_release_reminder(text) to app_api;
  end if;
end $$;
