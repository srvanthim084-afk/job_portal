-- ---------------------------------------------------------------------
-- 0020 — a message that failed is not a message that was sent
--
-- Every candidate message is recorded, and a failure is recorded
-- honestly: `failed`, with the provider's reason. What was missing is
-- what happens NEXT. While EmailJS was refusing server-side calls, four
-- messages to one candidate were refused - her application confirmation,
-- her AI interview invitation and its deadline - and once the setting was
-- fixed, nothing went back for them. She simply never heard from us.
--
-- Two things are added:
--
--   event      which message a delivery row was, so a retry can know
--              what it is retrying rather than guessing
--   the queue  the failed deliveries still worth another attempt
--
-- Deliberately NOT a blind replay. A three-day-old "interview scheduled"
-- is worse than silence if the interview has since moved, so the retry
-- sends the message for the candidate's CURRENT state. The queue exists
-- to find who was missed, not to re-run history.
-- ---------------------------------------------------------------------

alter table notification_deliveries
  add column if not exists event text,
  -- How many times we have gone back for this one. A provider that is
  -- down for a day must not produce a thousand attempts.
  add column if not exists retry_of bigint references notification_deliveries(id) on delete set null;

create index if not exists notification_deliveries_failed_idx
  on notification_deliveries (application_id, channel, created_at desc)
  where status = 'failed';

/* The 12-argument form. The 11-argument one stays, delegating, because
   several callers still use it and a signature change would break them
   silently at run time rather than loudly here. */
create or replace function record_delivery(
  p_application_id text,
  p_candidate_id text,
  p_job_id text,
  p_channel text,
  p_status text,
  p_to_address text,
  p_provider text,
  p_provider_ref text,
  p_error text,
  p_applied_at timestamptz,
  p_interview_expiry timestamptz,
  p_event text
) returns bigint
language plpgsql security definer set search_path = public as $$
declare v_attempt int; v_id bigint;
begin
  select coalesce(max(attempt), 0) + 1 into v_attempt
    from notification_deliveries
   where application_id = p_application_id and channel = p_channel;

  insert into notification_deliveries
    (application_id, candidate_id, job_id, channel, status, to_address,
     provider, provider_ref, error, attempt,
     job_id_sent, applied_at_sent, interview_expiry, event)
  values
    (p_application_id, p_candidate_id, p_job_id, p_channel, p_status, p_to_address,
     p_provider, p_provider_ref, left(p_error, 2000), v_attempt,
     p_job_id, p_applied_at, p_interview_expiry, p_event)
  returning id into v_id;

  return v_id;
end $$;

/**
 * Who never heard from us.
 *
 * An application is in the queue when its MOST RECENT attempt on a
 * channel failed - so a message that failed and was later delivered is
 * not chased again, and a channel that has never been configured is not
 * in here at all, because that is a configuration problem rather than a
 * delivery one.
 */
create or replace function failed_deliveries_pending(p_channel text default 'email')
returns table (
  application_id text,
  candidate_id   text,
  job_id         text,
  to_address     text,
  attempts       int,
  last_error     text,
  last_attempt   timestamptz,
  stage          text
)
language sql security definer set search_path = public as $$
  with latest as (
    select distinct on (d.application_id, d.channel)
           d.application_id, d.candidate_id, d.job_id, d.channel,
           d.status, d.to_address, d.error, d.created_at, d.attempt
      from notification_deliveries d
     where d.channel = p_channel
     order by d.application_id, d.channel, d.created_at desc
  )
  select l.application_id, l.candidate_id, l.job_id, l.to_address,
         l.attempt, l.error, l.created_at, a.stage
    from latest l
    join applications a on a.id = l.application_id
   where l.status = 'failed'
     -- Three goes. Past that it is not a transient failure and a human
     -- should look at it.
     and l.attempt < 3
     and coalesce(l.to_address, '') <> ''
     -- Somebody who asked not to be contacted is not chased.
     and not exists (
       select 1 from candidates c
        where c.id = l.candidate_id and c.do_not_contact)
   order by l.created_at
   limit 200;
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant execute on function
      record_delivery(text, text, text, text, text, text, text, text, text,
                      timestamptz, timestamptz, text),
      failed_deliveries_pending(text)
      to app_api;
  end if;
end $$;
