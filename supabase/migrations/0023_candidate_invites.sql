-- ---------------------------------------------------------------------
-- 0023 — a candidate imported from a spreadsheet is still a candidate
--
-- A person who arrives through the Naukri mailbox gets a portal account
-- and a message carrying their login. A person imported from a CSV or
-- an Excel file got neither: a row in `candidates` and nothing else. The
-- recruiter could see them; they could not see themselves, could not
-- complete their own profile, and never heard that they were in the
-- database at all.
--
-- The account itself already has a home - candidate_portal_account()
-- from 0019 - so this adds only the missing RECORD: what was sent, on
-- which channel, and whether it got there.
--
-- It cannot live in notification_deliveries, which requires an
-- application and a job. An invitation has neither: it is about the
-- person, not about a role they have applied for.
-- ---------------------------------------------------------------------

create table if not exists candidate_invites (
  id           bigserial primary key,
  candidate_id text not null references candidates(id) on delete cascade,

  channel      text not null check (channel in ('email', 'sms', 'whatsapp')),
  status       text not null check (status in
                 ('sent', 'failed', 'not_configured', 'skipped_no_address')),

  -- Where it went, kept here because the candidate's address can change
  -- afterwards and the record has to say where the message actually went.
  to_address   text,
  provider     text,
  error        text,

  -- Whether this invitation carried a password. Never the password.
  had_credentials boolean not null default false,
  -- Who caused it: the recruiter who ran the import, or the server.
  invited_by   text,
  created_at   timestamptz not null default now()
);

create index if not exists candidate_invites_candidate_idx
  on candidate_invites (candidate_id, created_at desc);

alter table candidate_invites enable row level security;
alter table candidate_invites force  row level security;

-- The candidate may see that we wrote to them, and on which channel.
-- A recruiter may see it for anybody they can already see, which RLS on
-- `candidates` decides - so this does not widen who is visible.
create policy ci_read on candidate_invites for select using (
  app_is_admin()
  or candidate_id = app_candidate_id()
  or (app_role() in ('recruiter', 'bde') and exists (
        select 1 from candidates c where c.id = candidate_invites.candidate_id))
);

-- Only the server writes, through the function below.
create policy ci_no_direct_write on candidate_invites for all
  using (app_is_admin()) with check (app_is_admin());

create or replace function candidate_invite_record(
  p_candidate_id text,
  p_channel text,
  p_status text,
  p_to_address text,
  p_provider text,
  p_error text,
  p_had_credentials boolean,
  p_invited_by text
) returns bigint
language plpgsql security definer set search_path = public as $$
declare v_id bigint;
begin
  insert into candidate_invites
    (candidate_id, channel, status, to_address, provider, error,
     had_credentials, invited_by)
  values
    (p_candidate_id, p_channel, p_status, p_to_address, p_provider,
     left(p_error, 2000), coalesce(p_had_credentials, false), p_invited_by)
  returning id into v_id;
  return v_id;
end $$;

/**
 * Has this person already been invited on this channel, successfully?
 *
 * An import run twice must not send the same person a second set of
 * credentials - the first ones still work, and a second message saying
 * "here is your password" when it is not the password they were given
 * is worse than no message.
 */
create or replace function candidate_invited(p_candidate_id text)
returns boolean
language sql security definer set search_path = public as $$
  select exists (
    select 1 from candidate_invites
     where candidate_id = p_candidate_id
       and status in ('sent')
  );
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant select on candidate_invites to app_api;
    grant execute on function
      candidate_invite_record(text, text, text, text, text, text, boolean, text),
      candidate_invited(text)
      to app_api;
  end if;
end $$;
