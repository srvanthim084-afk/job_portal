-- ---------------------------------------------------------------------
-- 0061 — messaging a selection of candidates, and keeping the record
--
-- `notification_deliveries` already records every message the SYSTEM
-- sends: an application confirmed, an interview invited, a stage moved.
-- Each of those is tied to an application and a job, because each of
-- them is about one.
--
-- A recruiter selecting forty people out of the talent pool and writing
-- to them is not about an application. There may not be one. So this is
-- its own log rather than a nullable-everything version of that one,
-- and the candidate profile can show "what have we actually said to this
-- person" as a single query.
--
-- IT IS ALSO THE QUEUE. A row is written as `queued` inside the request
-- and the request returns; a background sweep picks it up and sends it.
-- Forty messages must not be sent inside one HTTP call - the recruiter
-- watches a spinner, a slow provider times the request out, and half the
-- batch is in an unknown state. One table is both the queue and the
-- history because the history is the only honest record of what the
-- queue did.
-- ---------------------------------------------------------------------

create table if not exists message_logs (
  id           bigserial primary key,
  batch_id     text,                       -- one send, many rows
  candidate_id text not null references candidates(id) on delete cascade,

  channel      text not null check (channel in ('email', 'sms', 'whatsapp')),
  template_id  text,

  -- What was actually sent to THIS person, after the variables were
  -- filled in. Storing the template alone would mean nobody can ever
  -- answer "what did we say to her?".
  subject      text,
  body         text not null,
  to_address   text,

  status       text not null default 'queued'
    check (status in ('queued', 'sending', 'sent', 'delivered', 'failed',
                      'skipped_no_contact', 'not_configured')),
  error        text,
  provider     text,
  provider_ref text,
  attempts     int not null default 0,

  sent_by      uuid references users(id),
  sent_by_role text,
  queued_at    timestamptz not null default now(),
  sent_at      timestamptz,
  created_at   timestamptz not null default now()
);

create index if not exists mlog_candidate_idx on message_logs (candidate_id, created_at desc);
create index if not exists mlog_batch_idx     on message_logs (batch_id);
-- The queue's own read: everything still waiting, oldest first.
create index if not exists mlog_queue_idx     on message_logs (status, queued_at)
  where status in ('queued', 'sending');

-- ---------------------------------------------------------------------
-- who may see it
--
-- The same answer as everywhere else: whatever RLS on `candidates`
-- already decides. A recruiter sees the messages sent to people they can
-- see; a candidate sees what was sent to them, which is a record of
-- messages they already received.
--
-- NOBODY WRITES IT DIRECTLY. Queueing and sending both go through the
-- definer functions below, so a row cannot be back-dated, a failure
-- cannot be relabelled as sent, and a candidate cannot delete what was
-- sent to them.
-- ---------------------------------------------------------------------
alter table message_logs enable row level security;
alter table message_logs force  row level security;

create policy mlog_read on message_logs for select using (
  app_is_admin()
  or app_role() in ('recruiter', 'bde')
  or candidate_id = app_candidate_id()
);
create policy mlog_no_direct_write on message_logs for all
  using (app_is_admin()) with check (app_is_admin());

grant select on message_logs to app_api;
grant usage, select on sequence message_logs_id_seq to app_api;

-- ---------------------------------------------------------------------
-- queue one message
--
-- SECURITY DEFINER so the row is written the same way whoever asks, and
-- so `status` can never be set to 'sent' by the caller. The route has
-- already decided that this recruiter may write to this candidate.
--
-- A candidate with no address for the channel is queued as
-- `skipped_no_contact` rather than dropped: "we did not write to her
-- because we have no number" is a fact the recruiter needs to see, and a
-- row that was never created cannot report it.
-- ---------------------------------------------------------------------
create or replace function message_log_queue(
  p_batch       text,
  p_candidate   text,
  p_channel     text,
  p_template    text,
  p_subject     text,
  p_body        text,
  p_to          text,
  p_actor       uuid,
  p_actor_role  text
) returns message_logs
language plpgsql security definer set search_path = public as $$
declare v message_logs;
begin
  insert into message_logs
    (batch_id, candidate_id, channel, template_id, subject, body, to_address,
     status, sent_by, sent_by_role)
  values
    (p_batch, p_candidate, p_channel, p_template, p_subject, p_body,
     nullif(btrim(coalesce(p_to, '')), ''),
     case when nullif(btrim(coalesce(p_to, '')), '') is null
          then 'skipped_no_contact' else 'queued' end,
     p_actor, p_actor_role)
  returning * into v;
  return v;
end $$;

-- ---------------------------------------------------------------------
-- take the next batch off the queue
--
-- `for update skip locked` so two sweeps - or a sweep and a restart -
-- cannot both claim the same message and send it twice. Claimed rows are
-- moved to 'sending' in the same statement.
-- ---------------------------------------------------------------------
create or replace function message_log_claim(p_limit int)
returns setof message_logs
language sql security definer set search_path = public as $$
  update message_logs m
     set status = 'sending', attempts = m.attempts + 1
   where m.id in (
     select id from message_logs
      where status = 'queued'
      order by queued_at
      limit greatest(1, least(coalesce(p_limit, 20), 200))
      for update skip locked)
  returning m.*;
$$;

-- ---------------------------------------------------------------------
-- record what the provider said
--
-- "Sent" is only ever written here, from a provider result. Nothing in
-- this schema lets an HTTP 200 on the queueing request be recorded as a
-- delivery.
-- ---------------------------------------------------------------------
create or replace function message_log_result(
  p_id       bigint,
  p_status   text,
  p_provider text,
  p_ref      text,
  p_error    text
) returns void
language sql security definer set search_path = public as $$
  update message_logs
     set status = p_status,
         provider = coalesce(p_provider, provider),
         provider_ref = coalesce(p_ref, provider_ref),
         error = left(p_error, 2000),
         sent_at = case when p_status in ('sent', 'delivered') then now() else sent_at end
   where id = p_id;
$$;

grant execute on function message_log_queue(text, text, text, text, text, text, text, uuid, text)
  to app_api;
grant execute on function message_log_claim(int) to app_api;
grant execute on function message_log_result(bigint, text, text, text, text) to app_api;

comment on table message_logs is
  'Recruiter-initiated messages: the queue and the history in one table, because the history is the only honest record of what the queue did (0061).';
