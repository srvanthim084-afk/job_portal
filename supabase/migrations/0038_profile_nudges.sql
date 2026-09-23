-- ---------------------------------------------------------------------
-- 0038 — remembering that we already asked
--
-- "Complete your profile" is the one message here that nobody asked to
-- receive. Every other notification answers something the candidate
-- did: they applied, they were shortlisted, their interview moved. This
-- one arrives because they did NOT do something, which makes it a nudge
-- - and a nudge with no memory is a nag.
--
-- So it needs a record of its own. `candidate_invites` is the wrong
-- place: that is the account and its credentials, and mixing a reminder
-- into it would make candidate_invited() think somebody had been given
-- a login when they had only been prodded.
-- ---------------------------------------------------------------------

create table if not exists candidate_nudges (
  id           bigserial primary key,
  candidate_id text not null references candidates(id) on delete cascade,
  -- What kind of nudge. One column so a second sort can be added later
  -- without another table.
  kind         text not null,
  status       text not null check (status in
                 ('sent','failed','not_configured','skipped_no_address')),
  to_address   text,
  error        text,
  created_at   timestamptz not null default now()
);

create index if not exists candidate_nudges_lookup
  on candidate_nudges (candidate_id, kind, created_at desc);

alter table candidate_nudges enable row level security;
alter table candidate_nudges force  row level security;

create policy cn_read on candidate_nudges for select using (
  app_is_admin()
  or candidate_id = app_candidate_id()
  or app_role() in ('recruiter', 'bde')
);
create policy cn_no_direct_write on candidate_nudges for all
  using (app_is_admin()) with check (app_is_admin());

create or replace function candidate_nudge_record(
  p_candidate_id text, p_kind text, p_status text,
  p_to_address text, p_error text
) returns bigint
language plpgsql security definer set search_path = public as $$
declare v_id bigint;
begin
  insert into candidate_nudges (candidate_id, kind, status, to_address, error)
  values (p_candidate_id, p_kind, p_status, p_to_address, left(p_error, 2000))
  returning id into v_id;
  return v_id;
end $$;

/**
 * Who has a portal account, an address, a thin profile, and has not been
 * asked about it recently.
 *
 * Every condition earns its place:
 *
 *   a login          without one there is nothing to act on, so the
 *                    message is useless and slightly insulting
 *   an address       nowhere to send it otherwise
 *   genuinely thin   no resume AND something else missing. A profile
 *                    with a resume is not incomplete in the way that
 *                    matters to a recruiter
 *   three days old   somebody who registered this morning is mid-way
 *                    through, not neglecting it
 *   21 days quiet    a reminder every week is a nag
 *   twice, ever      after two the answer is no
 *   not opted out    do-not-contact stops this as it stops everything
 */
create or replace function candidates_needing_profile(p_limit int default 100)
returns table (id text, name text, email text)
language sql security definer set search_path = public as $$
  select c.id, c.name, c.email
    from candidates c
   where c.user_id is not null
     and coalesce(btrim(c.email), '') <> ''
     and not c.do_not_contact
     and coalesce(btrim(c.resume_file), '') = ''
     and (coalesce(array_length(c.skills, 1), 0) = 0
          or coalesce(btrim(c.title), '') = ''
          or coalesce(btrim(c.phone), '') = '')
     and c.created_at < now() - interval '3 days'
     and not exists (
       select 1 from candidate_nudges n
        where n.candidate_id = c.id
          and n.kind = 'profile_incomplete'
          and n.created_at > now() - interval '21 days')
     and (select count(*) from candidate_nudges n2
           where n2.candidate_id = c.id
             and n2.kind = 'profile_incomplete'
             and n2.status = 'sent') < 2
   order by c.created_at
   limit p_limit;
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant select on candidate_nudges to app_api;
    grant execute on function
      candidate_nudge_record(text, text, text, text, text),
      candidates_needing_profile(int)
      to app_api;
  end if;
end $$;
