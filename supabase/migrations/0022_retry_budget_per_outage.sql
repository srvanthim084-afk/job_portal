-- ---------------------------------------------------------------------
-- 0022 — three attempts at THIS message, not three in a lifetime
--
-- 0020 stopped chasing a delivery after three attempts, which is right:
-- past that it is not a transient failure and a human should look at it.
-- It read that count from notification_deliveries.attempt, which is a
-- lifetime counter for the application and channel - it counts every
-- message ever sent to that person about that application.
--
-- So a candidate who has had a confirmation, an invitation, a deadline
-- reminder and three stage updates is already at attempt 6, and the
-- moment a provider goes down she is INELIGIBLE for the retry that
-- exists for exactly her case. The longer somebody has been in the
-- pipeline, the less the safety net covers them. Found when a real
-- candidate's send failed on a provider quota and the queue came back
-- empty.
--
-- The budget is now the run of consecutive failures since the last
-- message that actually got through. A working channel resets it, so
-- three means three goes at the message in front of us.
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
  -- Two passes, because a window function cannot be nested inside
  -- another one: rank first, then find where the last success sits.
  with ranked as (
    select d.application_id, d.candidate_id, d.job_id, d.status,
           d.to_address, d.error, d.created_at,
           row_number() over (partition by d.application_id
                                  order by d.created_at desc) as rn
      from notification_deliveries d
     where d.channel = p_channel
  ),
  marked as (
    select r.*,
           -- Where the most recent delivered message sits in that order.
           -- Null when nothing has ever got through.
           min(case when r.status in ('sent', 'delivered') then r.rn end)
             over (partition by r.application_id) as last_ok,
           count(*) over (partition by r.application_id) as total
      from ranked r
  ),
  latest as (
    select m.application_id, m.candidate_id, m.job_id, m.status,
           m.to_address, m.error, m.created_at,
           -- Consecutive failures since the last success; everything ever
           -- sent, when nothing has ever succeeded.
           (coalesce(m.last_ok, m.total + 1) - 1)::int as run
      from marked m
     where m.rn = 1
  )
  select l.application_id, l.candidate_id, l.job_id, l.to_address,
         l.run, l.error, l.created_at, a.stage
    from latest l
    join applications a on a.id = l.application_id
    join candidates c on c.id = l.candidate_id
   where l.status in ('failed', 'not_configured')
     -- Three goes at THIS message. A delivered message resets the count.
     and l.run < 3
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
