-- ---------------------------------------------------------------------
-- 0021 — "not configured" is also a candidate who never heard from us
--
-- 0020 built the queue out of deliveries that FAILED. But the larger
-- silence is the other kind: 89 applications here whose last email
-- recorded `not_configured`, because at the time no transport existed.
-- The log is honest — we did not claim to send — but from the
-- candidate's side the two are identical. Nobody wrote to them.
--
-- Once a transport is configured, those people are exactly the ones the
-- retry exists for, so they belong in the same queue.
--
-- One exclusion is added with them: addresses at the reserved domains
-- (RFC 2606 example.com / .test / .invalid / .localhost, and .local).
-- Those can never receive mail anywhere, so an attempt is not a retry,
-- it is burnt provider quota and a bounce. Seed and test rows live
-- there, and they must not crowd out a real person.
-- ---------------------------------------------------------------------

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
    -- The address is read from the candidate rather than the old row: a
    -- correction to a mistyped address should be picked up, not retried
    -- forever against the typo.
    join candidates c on c.id = l.candidate_id
   where l.status in ('failed', 'not_configured')
     -- Three goes. Past that it is not a transient failure and a human
     -- should look at it.
     and l.attempt < 3
     and coalesce(l.to_address, '') <> ''
     and not c.do_not_contact
     -- Reserved domains: deliverable nowhere, by design.
     and l.to_address !~* '@(.*\.)?(example|invalid|test|localhost|local)$'
     and l.to_address !~* '@(example\.(com|net|org|test))$'
   order by l.created_at
   limit 200;
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant execute on function failed_deliveries_pending(text) to app_api;
  end if;
end $$;
