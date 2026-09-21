-- =====================================================================
-- Multi-channel interview notifications
--
-- Triggered when an application is confirmed: generate the interview
-- invite, then attempt delivery on EVERY channel the candidate has,
-- independently, recording what actually happened on each.
--
-- What the prototype had:
--   * Naukri / Indeed / LinkedIn / Shine were a settings toggle whose own
--     tooltip said "Simulated". No API, no delivery.
--   * SMS was a text box for "your SMS API endpoint URL".
--   * Email went out from the BROWSER via EmailJS.
-- None of that survives a page close, and none of it is auditable.
-- =====================================================================

-- ---------------------------------------------------------------------
-- The interview invite: one token per application, with a hard expiry.
--
-- The token is what goes in the link. It is random rather than derived
-- from the application id, so a candidate cannot reach someone else's
-- interview by editing a URL.
-- ---------------------------------------------------------------------
alter table applications
  add column interview_token      text unique,
  add column interview_expires_at timestamptz,
  add column interview_started_at timestamptz;

create index on applications (interview_token);

-- ---------------------------------------------------------------------
-- One row per channel attempt.
--
-- `status` carries more than sent/failed on purpose. A channel with no
-- provider configured has NOT failed — nothing was attempted — and
-- recording it as "sent" would be a lie about a message the candidate
-- never received. Both distinctions matter when someone asks why a
-- candidate says they were never told.
-- ---------------------------------------------------------------------
create table notification_deliveries (
  id             bigserial primary key,
  application_id text not null references applications(id) on delete cascade,
  candidate_id   text not null references candidates(id)   on delete cascade,
  job_id         text not null references jobs(id)         on delete cascade,

  channel        text not null check (channel in ('naukri','sms','whatsapp','email','ivr')),
  status         text not null check (status in
                   ('sent','failed','not_configured','not_applicable','skipped_no_address')),

  -- where it was sent, for audit. Phone/email are already in `candidates`;
  -- stored again here because the address can change afterwards and the
  -- log has to say where the message actually went.
  to_address     text,
  provider       text,                    -- which provider handled it
  provider_ref   text,                    -- the provider's message id
  error          text,                    -- why it failed, when it did
  attempt        int not null default 1,

  -- The SAME values across every channel for one application, so the
  -- candidate cannot be told two different expiry times.
  job_id_sent    text,
  applied_at_sent   timestamptz,
  interview_expiry  timestamptz,

  created_at     timestamptz not null default now()
);
create index on notification_deliveries (application_id);
create index on notification_deliveries (candidate_id);
create index on notification_deliveries (channel, status);
create index on notification_deliveries (created_at desc);

-- One row per channel per attempt, so a retry is a new attempt rather
-- than a silent overwrite of the previous outcome.
create unique index notification_deliveries_unique
  on notification_deliveries (application_id, channel, attempt);

-- ---------------------------------------------------------------------
-- The per-application summary the spec asks for, assembled in SQL so it
-- cannot drift from the rows it is derived from.
-- ---------------------------------------------------------------------
create view application_notification_status as
select
  a.id                          as application_id,
  a.candidate_id,
  a.job_id,
  coalesce(a.source, 'website') as source,
  a.applied_at,
  a.interview_expires_at        as interview_expiry,
  coalesce(
    jsonb_object_agg(d.channel, d.status) filter (where d.channel is not null),
    '{}'::jsonb)                as delivery_status,
  coalesce(
    array_agg(distinct d.channel) filter (where d.channel is not null),
    '{}')                       as channels_attempted
from applications a
left join notification_deliveries d
       on d.application_id = a.id
      -- only the latest attempt per channel
      and d.attempt = (select max(d2.attempt) from notification_deliveries d2
                        where d2.application_id = d.application_id
                          and d2.channel = d.channel)
group by a.id, a.candidate_id, a.job_id, a.source, a.applied_at, a.interview_expires_at;

-- security_invoker: without it this view would hand every application's
-- delivery history to anyone who can select from it (see 0001_schema.sql).
alter view application_notification_status set (security_invoker = true);

-- ---------------------------------------------------------------------
-- Visibility. Delivery history is operational data: the hiring side and
-- an admin can see it, and a candidate can see their own — they are
-- entitled to know whether they were actually contacted.
-- ---------------------------------------------------------------------
alter table notification_deliveries enable row level security;
alter table notification_deliveries force  row level security;

create policy nd_read on notification_deliveries for select using (
  app_is_admin()
  or candidate_id = app_candidate_id()
  or (app_role() = 'recruiter' and exists (
        select 1 from jobs j where j.id = notification_deliveries.job_id
          and j.company_id = app_recruiter_company()))
  or (app_role() = 'client' and exists (
        select 1 from jobs j where j.id = notification_deliveries.job_id
          and j.company_id = app_client_company()))
);

-- Only the server writes delivery outcomes, through the definer function
-- below. Nobody edits a delivery record by hand.
create policy nd_no_direct_write on notification_deliveries for all
  using (app_is_admin()) with check (app_is_admin());

-- ---------------------------------------------------------------------
-- Issue the interview invite for a confirmed application.
--
-- SECURITY DEFINER because the caller is the candidate who just applied,
-- and a candidate must not hold update rights on `applications`.
-- Idempotent: applying twice does not reissue a token or move the expiry,
-- so every channel quotes the same deadline.
-- ---------------------------------------------------------------------
create or replace function issue_interview_invite(
  p_application_id text,
  p_token text,
  p_valid_hours int default 48
) returns table (token text, expires_at timestamptz, applied_at timestamptz, job_id text)
language plpgsql security definer set search_path = public as $$
declare v applications%rowtype;
begin
  select * into v from applications where id = p_application_id;
  if not found then
    raise exception 'application % does not exist', p_application_id;
  end if;

  if v.interview_token is null then
    update applications
       set interview_token = p_token,
           interview_expires_at = now() + make_interval(hours => p_valid_hours)
     where id = p_application_id
     returning * into v;
  end if;

  return query select v.interview_token, v.interview_expires_at, v.applied_at, v.job_id;
end $$;

-- ---------------------------------------------------------------------
-- Record one channel's outcome.
--
-- Called once per channel, after the attempt. Never raises on a delivery
-- failure — a failed channel must not roll back the others, which is the
-- whole point of attempting them independently.
-- ---------------------------------------------------------------------
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
  p_interview_expiry timestamptz
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
     job_id_sent, applied_at_sent, interview_expiry)
  values
    (p_application_id, p_candidate_id, p_job_id, p_channel, p_status, p_to_address,
     p_provider, p_provider_ref, left(p_error, 2000), v_attempt,
     p_job_id, p_applied_at, p_interview_expiry)
  returning id into v_id;

  return v_id;
end $$;

-- ---------------------------------------------------------------------
grant select, insert on notification_deliveries to app_api;
grant usage, select on sequence notification_deliveries_id_seq to app_api;
grant select on application_notification_status to app_api;

grant execute on function
  issue_interview_invite(text, text, int),
  record_delivery(text, text, text, text, text, text, text, text, text, timestamptz, timestamptz)
  to app_api;
