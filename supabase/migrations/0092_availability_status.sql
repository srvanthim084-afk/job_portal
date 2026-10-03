-- ---------------------------------------------------------------------
-- 0092 — is this person looking? They say so, and it stays true
--
-- A recruiter had to guess whether a candidate wanted a job at all, from
-- the notice period and the last sign-in. People who had already started
-- somewhere new kept getting calls, and people who were desperate for
-- work sat on page four of a search.
--
-- The CANDIDATE now says it, in one tap:
--
--   actively_looking   wants a job now                (green, ranked first)
--   open_to_offers     has a job, would move for a good one   (yellow)
--   not_looking        not now      (grey, hidden from search by default)
--   placed             joined through TeamLink - set by the system, held
--                      for the 90-day replacement period, then becomes
--                      not_looking and they are asked if they want a
--                      new role
--   unknown            never said
--
-- It is the candidate's, and only the candidate's. A recruiter who learns
-- otherwise on a call writes a note; they cannot change the status. The
-- database refuses it: every write goes through the definer functions
-- below, and a direct UPDATE of these columns through the API's own role
-- raises. The other writers are the candidate's reply to a "still
-- looking?" link (no login), applying for a job, and the system.
--
-- So it never goes stale: 30 days after an "actively looking" was last
-- confirmed (60 for "open to offers") the candidate is asked again, at
-- most once in any 30 days, never between 21:00 and 08:00. Unanswered for
-- 14 days, the status stays but is shown as "Not confirmed" and ranked
-- below everything except not_looking.
--
-- WHY availability_status AND NOT availability. `candidates.availability`
-- already exists (0057) - a free-text field on the manual entry form
-- ("Available after Diwali"). Reusing the name would have silently turned
-- that text into an enum and broken the form; this is a new column.
--
-- Clients never see any of it: the API attaches it only for recruiters,
-- BDEs and admins, and no client view or route reads it.
-- ---------------------------------------------------------------------

alter table candidates
  add column if not exists availability_status       text not null default 'unknown',
  add column if not exists availability_updated_at   timestamptz,
  add column if not exists availability_confirmed_at timestamptz,
  add column if not exists availability_source       text,
  -- set when a "still looking?" went unanswered for 14 days; cleared by
  -- any answer. Non-null means "Not confirmed".
  add column if not exists availability_stale_at     timestamptz,
  add column if not exists availability_placed_at    timestamptz,
  add column if not exists can_join_in               text,
  add column if not exists preferred_roles           text[] not null default '{}',
  add column if not exists preferred_cities          text[] not null default '{}';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'candidates_availability_status_known') then
    alter table candidates add constraint candidates_availability_status_known
      check (availability_status in ('actively_looking', 'open_to_offers', 'not_looking', 'placed', 'unknown'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'candidates_availability_source_known') then
    alter table candidates add constraint candidates_availability_source_known
      check (availability_source is null
             or availability_source in ('candidate', 'register', 'reply_link', 'apply', 'system'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'candidates_can_join_in_known') then
    alter table candidates add constraint candidates_can_join_in_known
      check (can_join_in is null
             or can_join_in in ('Immediate', '15 days', '30 days', '60 days', '90 days'));
  end if;
end $$;

create index if not exists cand_availability_idx on candidates (availability_status);

-- ---------------------------------------------------------------------
-- the record of every change, for the reports
-- ---------------------------------------------------------------------
create table if not exists candidate_availability_history (
  id           bigserial primary key,
  candidate_id text not null references candidates(id) on delete cascade,
  from_status  text,
  to_status    text not null,
  source       text not null,
  changed_by   uuid,
  changed_at   timestamptz not null default now()
);
create index if not exists cah_by_candidate on candidate_availability_history (candidate_id, changed_at desc);

-- ---------------------------------------------------------------------
-- "Are you still looking?" - one row per message sent
--
-- The link carries a random token; only its SHA-256 is stored, so the
-- table cannot be used to answer for anybody. Single-use (answered_at),
-- 14 days (expires_at), and it can change only the candidate it was sent
-- to.
-- ---------------------------------------------------------------------
create table if not exists availability_checks (
  id           bigserial primary key,
  candidate_id text not null references candidates(id) on delete cascade,
  kind         text not null default 'reconfirm' check (kind in ('reconfirm', 'placed_followup')),
  token_hash   text not null unique,
  status_asked text,                         -- what they had said, when asked
  channel      text,                         -- the channel that carried it
  delivery     jsonb not null default '{}'::jsonb,   -- every channel's own answer
  sent_at      timestamptz not null default now(),
  expires_at   timestamptz not null,
  answered_at  timestamptz,
  answer       text check (answer is null or answer in ('actively_looking', 'open_to_offers', 'not_looking')),
  lapsed_at    timestamptz                   -- processed as "no answer"
);
create index if not exists avc_by_candidate on availability_checks (candidate_id, sent_at desc);
create index if not exists avc_open on availability_checks (expires_at) where answered_at is null and lapsed_at is null;

alter table candidate_availability_history enable row level security;
alter table candidate_availability_history force  row level security;
alter table availability_checks            enable row level security;
alter table availability_checks            force  row level security;

create policy cah_read on candidate_availability_history for select using (
  app_is_admin()
  or candidate_id = app_candidate_id()
  or (app_role() in ('recruiter', 'bde') and exists (
        select 1 from candidates c where c.id = candidate_availability_history.candidate_id))
);
create policy cah_no_direct_write on candidate_availability_history for all
  using (app_is_admin() and app_user_id() is null)
  with check (app_is_admin() and app_user_id() is null);

/* The checks are the engine's bookkeeping; an admin may read them. */
create policy avc_read on availability_checks for select using (app_is_admin());
create policy avc_no_direct_write on availability_checks for all
  using (app_is_admin() and app_user_id() is null)
  with check (app_is_admin() and app_user_id() is null);

-- ---------------------------------------------------------------------
-- notice period <-> "can join in"
--
-- The registration form already offers exactly these five for the
-- notice period, so the two are one fact spelled two ways.
-- ---------------------------------------------------------------------
create or replace function can_join_in_from_notice(p_notice text) returns text
language sql immutable parallel safe as $$
  select case
    when p_notice is null then null
    when lower(btrim(p_notice)) in ('immediate', 'immediately', '0 days', 'none', 'serving notice') then 'Immediate'
    when lower(btrim(p_notice)) ~ '^(15 days?|2 weeks?|half a month)$' then '15 days'
    when lower(btrim(p_notice)) ~ '^(30 days?|1 months?|one month)$' then '30 days'
    when lower(btrim(p_notice)) ~ '^(45 days?|60 days?|2 months?)$' then '60 days'
    when lower(btrim(p_notice)) ~ '^(90 days?|3 months?)$' then '90 days'
    else null end
$$;

/** Inside a definer function (or a migration), not a request's own SQL. */
create or replace function app_privileged_context() returns boolean
language sql stable as $$
  select exists (select 1 from pg_roles r
                  where r.rolname = current_user and (r.rolsuper or r.rolbypassrls))
      or current_user::text = (select pg_get_userbyid(c.relowner)::text
                                 from pg_class c where c.oid = 'public.candidates'::regclass)
$$;

/*
 * THE GUARD, and the sync.
 *
 * A direct write of the status columns through the API's role is
 * refused, whoever the caller - an owning recruiter's UPDATE passes
 * candidates_self_write, so the policy alone would let it through. The
 * definer functions below are the only writers.
 *
 * A notice period edited anywhere (the profile, a recruiter's form, a
 * re-parsed CV) moves "can join in" with it.
 */
create or replace function candidates_availability_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if not app_privileged_context() then
      new.availability_status := 'unknown';
      new.availability_updated_at := null;
      new.availability_confirmed_at := null;
      new.availability_source := null;
      new.availability_stale_at := null;
      new.availability_placed_at := null;
      new.preferred_roles := '{}';
      new.preferred_cities := '{}';
    end if;
    new.can_join_in := coalesce(new.can_join_in, can_join_in_from_notice(new.notice_period));
    return new;
  end if;

  if not app_privileged_context() and (
       new.availability_status       is distinct from old.availability_status
    or new.availability_updated_at   is distinct from old.availability_updated_at
    or new.availability_confirmed_at is distinct from old.availability_confirmed_at
    or new.availability_source       is distinct from old.availability_source
    or new.availability_stale_at     is distinct from old.availability_stale_at
    or new.availability_placed_at    is distinct from old.availability_placed_at
    or new.preferred_roles           is distinct from old.preferred_roles
    or new.preferred_cities          is distinct from old.preferred_cities
    or (new.can_join_in is distinct from old.can_join_in
        and new.notice_period is not distinct from old.notice_period)) then
    raise exception 'availability is set by the candidate (or their reply link), never by a recruiter'
      using errcode = '42501';
  end if;

  if new.notice_period is distinct from old.notice_period
     and new.can_join_in is not distinct from old.can_join_in then
    new.can_join_in := coalesce(can_join_in_from_notice(new.notice_period), new.can_join_in);
  end if;
  return new;
end $$;

drop trigger if exists candidates_availability_guard on candidates;
create trigger candidates_availability_guard
  before insert or update on candidates
  for each row execute function candidates_availability_guard();

-- ---------------------------------------------------------------------
-- the one writer
-- ---------------------------------------------------------------------
create or replace function availability_write(
  p_candidate_id text,
  p_status       text,
  p_source       text,
  p_can_join_in  text default null,
  p_roles        text[] default null,
  p_cities       text[] default null,
  p_confirm      boolean default true
) returns text
language plpgsql security definer set search_path = public as $$
declare v_old text; v_new text;
begin
  select availability_status into v_old from candidates where id = p_candidate_id for update;
  if not found then return null; end if;
  v_new := coalesce(nullif(p_status, ''), v_old);

  update candidates
     set availability_status       = v_new,
         availability_updated_at   = case when v_new is distinct from v_old then now()
                                          else coalesce(availability_updated_at, now()) end,
         availability_confirmed_at = case when p_confirm then now() else availability_confirmed_at end,
         availability_source       = case when v_new is distinct from v_old or p_confirm
                                          then p_source else availability_source end,
         availability_stale_at     = case when p_confirm then null else availability_stale_at end,
         availability_placed_at    = case when v_new = 'placed' and v_old is distinct from 'placed' then now()
                                          when v_new <> 'placed' then null
                                          else availability_placed_at end,
         can_join_in               = coalesce(p_can_join_in, can_join_in),
         notice_period             = case when p_can_join_in is not null then p_can_join_in
                                          else notice_period end,
         preferred_roles           = coalesce(p_roles, preferred_roles),
         preferred_cities          = coalesce(p_cities, preferred_cities),
         updated_at                = now()
   where id = p_candidate_id;

  if v_new is distinct from v_old then
    insert into candidate_availability_history (candidate_id, from_status, to_status, source, changed_by)
    values (p_candidate_id, v_old, v_new, p_source, app_user_id_safe());
  end if;
  return v_new;
end $$;

/** The candidate, signed in: their own status and preferences. */
create or replace function availability_candidate_set(
  p_status text, p_can_join_in text default null, p_roles text[] default null, p_cities text[] default null
) returns text
language plpgsql security definer set search_path = public as $$
declare v_me text := app_candidate_id();
begin
  if app_role() <> 'candidate' or v_me is null then
    raise exception 'only the candidate can change their availability' using errcode = '42501';
  end if;
  if p_status is not null and p_status not in ('actively_looking', 'open_to_offers', 'not_looking') then
    raise exception 'not a status a candidate can choose' using errcode = '22023';
  end if;
  if p_can_join_in is not null
     and p_can_join_in not in ('Immediate', '15 days', '30 days', '60 days', '90 days') then
    raise exception 'not a joining time this form offers' using errcode = '22023';
  end if;
  return availability_write(v_me, p_status, 'candidate', p_can_join_in,
    (select array(select distinct left(btrim(x), 80) from unnest(p_roles) x where btrim(x) <> '' limit 10)),
    (select array(select distinct left(btrim(x), 80) from unnest(p_cities) x where btrim(x) <> '' limit 10)),
    p_status is not null);
end $$;

/**
 * At registration, on the anonymous connection (like 0082's
 * auth_register_preferences): only a record created in the last ten
 * minutes that has never had a status.
 */
create or replace function availability_register(p_candidate_id text, p_status text)
returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(p_status, 'actively_looking') not in ('actively_looking', 'open_to_offers', 'not_looking') then
    return false;
  end if;
  if not exists (select 1 from candidates
                  where id = p_candidate_id and availability_source is null
                    and created_at > now() - interval '10 minutes') then
    return false;
  end if;
  perform availability_write(p_candidate_id, coalesce(p_status, 'actively_looking'), 'register');
  return true;
end $$;

-- ---------------------------------------------------------------------
-- applying, and joining
-- ---------------------------------------------------------------------
create or replace function applications_availability() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_status text;
begin
  select availability_status into v_status from candidates where id = new.candidate_id;

  -- A candidate applying for a job is looking for one.
  if tg_op = 'INSERT' and app_role() = 'candidate' and new.candidate_id = app_candidate_id() then
    if v_status in ('not_looking', 'unknown') then
      perform availability_write(new.candidate_id, 'actively_looking', 'apply');
    elsif v_status in ('actively_looking', 'open_to_offers') then
      perform availability_write(new.candidate_id, v_status, 'apply');   -- a confirmation
    end if;
  end if;

  -- Joined through TeamLink: placed, for the replacement period.
  if new.stage = 'joined' and (tg_op = 'INSERT' or old.stage is distinct from 'joined') then
    perform availability_write(new.candidate_id, 'placed', 'system');
  end if;
  return new;
end $$;

drop trigger if exists applications_availability on applications;
create trigger applications_availability
  after insert or update of stage on applications
  for each row execute function applications_availability();

-- ---------------------------------------------------------------------
-- the "still looking?" link, answered without a login
-- ---------------------------------------------------------------------

/** What the reply page needs to show, and nothing more. */
create or replace function availability_reply_peek(p_token_hash text)
returns table (first_name text, kind text, answered boolean, expired boolean, answer text)
language sql stable security definer set search_path = public as $$
  select split_part(btrim(c.name), ' ', 1), k.kind, k.answered_at is not null,
         k.expires_at <= now(), k.answer
    from availability_checks k
    join candidates c on c.id = k.candidate_id
   where k.token_hash = p_token_hash
$$;

/**
 * The answer. 'ok' | 'unknown' | 'used' | 'expired' | 'invalid'.
 * Single-use, 14 days, and only ever the candidate it was sent to.
 */
create or replace function availability_reply(p_token_hash text, p_answer text)
returns text
language plpgsql security definer set search_path = public as $$
declare v availability_checks;
begin
  if p_answer not in ('actively_looking', 'open_to_offers', 'not_looking') then
    return 'invalid';
  end if;
  select * into v from availability_checks where token_hash = p_token_hash for update;
  if v.id is null then return 'unknown'; end if;
  if v.answered_at is not null then return 'used'; end if;
  if v.expires_at <= now() then return 'expired'; end if;

  update availability_checks set answered_at = now(), answer = p_answer where id = v.id;
  perform availability_write(v.candidate_id, p_answer, 'reply_link');
  return 'ok';
end $$;

-- ---------------------------------------------------------------------
-- the engine's door (role admin, no user - see 0086)
-- ---------------------------------------------------------------------
create or replace function availability_engine_guard() returns void
language plpgsql as $$
begin
  if not (app_role() = 'admin' and app_user_id() is null) then
    raise exception 'the availability engine only' using errcode = '42501';
  end if;
end $$;

/**
 * Who is due a "still looking?": actively looking and not confirmed for
 * 30 days, or open to offers for 60 - and not asked (anything) in the
 * last 30 days, not do-not-contact.
 */
create or replace function availability_engine_due(p_now timestamptz)
returns table (id text, name text, email text, phone text, status text,
               email_opt_in boolean, sms_opt_in boolean, whatsapp_opt_in boolean)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  perform availability_engine_guard();
  return query
    select c.id, c.name, c.email, c.phone, c.availability_status,
           coalesce(c.email_opt_in, true), coalesce(c.sms_opt_in, true), coalesce(c.whatsapp_opt_in, false)
      from candidates c
     where not coalesce(c.do_not_contact, false)
       and ((c.availability_status = 'actively_looking'
             and coalesce(c.availability_confirmed_at, c.availability_updated_at, c.created_at)
                 < p_now - interval '30 days')
         or (c.availability_status = 'open_to_offers'
             and coalesce(c.availability_confirmed_at, c.availability_updated_at, c.created_at)
                 < p_now - interval '60 days'))
       and not exists (select 1 from availability_checks k
                        where k.candidate_id = c.id and k.sent_at > p_now - interval '30 days')
     order by coalesce(c.availability_confirmed_at, c.availability_updated_at, c.created_at)
     limit 200;
end $$;

/** Placed more than 90 days ago: the replacement period is over. */
create or replace function availability_engine_placed_due(p_now timestamptz)
returns table (id text, name text, email text, phone text,
               email_opt_in boolean, sms_opt_in boolean, whatsapp_opt_in boolean)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  perform availability_engine_guard();
  return query
    select c.id, c.name, c.email, c.phone,
           coalesce(c.email_opt_in, true), coalesce(c.sms_opt_in, true), coalesce(c.whatsapp_opt_in, false)
      from candidates c
     where c.availability_status = 'placed'
       and coalesce(c.availability_placed_at, c.availability_updated_at) < p_now - interval '90 days'
     limit 200;
end $$;

/** placed -> not_looking, once. Returns true if it moved. */
create or replace function availability_engine_release(p_candidate_id text)
returns boolean
language plpgsql security definer set search_path = public as $$
begin
  perform availability_engine_guard();
  if not exists (select 1 from candidates where id = p_candidate_id and availability_status = 'placed') then
    return false;
  end if;
  perform availability_write(p_candidate_id, 'not_looking', 'system', null, null, null, false);
  return true;
end $$;

/** One message, recorded with every channel's answer. */
create or replace function availability_engine_check_add(
  p_candidate_id text, p_kind text, p_token_hash text, p_status_asked text,
  p_channel text, p_delivery jsonb, p_sent_at timestamptz
) returns bigint
language plpgsql security definer set search_path = public as $$
declare v_id bigint;
begin
  perform availability_engine_guard();
  insert into availability_checks
    (candidate_id, kind, token_hash, status_asked, channel, delivery, sent_at, expires_at)
  values (p_candidate_id, p_kind, p_token_hash, p_status_asked, p_channel,
          coalesce(p_delivery, '{}'::jsonb), p_sent_at, p_sent_at + interval '14 days')
  returning id into v_id;
  return v_id;
end $$;

/**
 * Fourteen days and no answer: "Not confirmed". The status itself stays
 * - it is still what they last told us - but it is shown grey and
 * ranked lower until they answer.
 */
create or replace function availability_engine_lapse(p_now timestamptz)
returns int
language plpgsql security definer set search_path = public as $$
declare n int := 0; v record;
begin
  perform availability_engine_guard();
  for v in
    select k.id, k.candidate_id, k.sent_at from availability_checks k
     where k.answered_at is null and k.lapsed_at is null
       and k.kind = 'reconfirm' and k.expires_at <= p_now
  loop
    update availability_checks set lapsed_at = p_now where id = v.id;
    update candidates
       set availability_stale_at = coalesce(availability_stale_at, p_now)
     where id = v.candidate_id
       and coalesce(availability_confirmed_at, 'epoch'::timestamptz) < v.sent_at;
    n := n + 1;
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------------
-- ranking and the report
-- ---------------------------------------------------------------------

/**
 * actively looking (confirmed) > open to offers > unknown > not confirmed
 * > not looking > placed. Lower is better.
 */
create or replace function availability_rank(p_status text, p_stale_at timestamptz)
returns int
language sql immutable parallel safe as $$
  select case
    when p_status = 'not_looking' then 4
    when p_status = 'placed' then 5
    when p_stale_at is not null then 3
    when p_status = 'actively_looking' then 0
    when p_status = 'open_to_offers' then 1
    else 2 end
$$;

create or replace function availability_report(p_days int default 30)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  if not app_is_admin() then
    raise exception 'administrators only' using errcode = '42501';
  end if;
  select jsonb_build_object(
    'byStatus', (select coalesce(jsonb_object_agg(s, n), '{}'::jsonb) from (
                   select case when availability_stale_at is not null
                                    and availability_status in ('actively_looking', 'open_to_offers')
                               then 'not_confirmed' else availability_status end as s,
                          count(*)::int as n
                     from candidates group by 1) x),
    'checks', (select jsonb_build_object(
                 'sent', count(*)::int,
                 'answered', count(*) filter (where answered_at is not null)::int,
                 'lapsed', count(*) filter (where lapsed_at is not null)::int,
                 'open', count(*) filter (where answered_at is null and lapsed_at is null
                                          and expires_at > now())::int,
                 'byAnswer', coalesce((select jsonb_object_agg(answer, n) from (
                                select answer, count(*)::int n from availability_checks
                                 where answer is not null and sent_at > now() - make_interval(days => p_days)
                                 group by answer) y), '{}'::jsonb),
                 'byChannel', coalesce((select jsonb_object_agg(coalesce(channel, 'none'), n) from (
                                select channel, count(*)::int n from availability_checks
                                 where sent_at > now() - make_interval(days => p_days)
                                 group by channel) z), '{}'::jsonb))
                 from availability_checks
                where sent_at > now() - make_interval(days => p_days)),
    'changes', (select coalesce(jsonb_object_agg(source, n), '{}'::jsonb) from (
                  select source, count(*)::int n from candidate_availability_history
                   where changed_at > now() - make_interval(days => p_days)
                   group by source) w),
    'days', p_days)
    into v;
  return v;
end $$;

-- ---------------------------------------------------------------------
-- where the existing rows start
--
-- Signed in or applied in the last 30 days: actively looking (system).
-- Joined in the last 90 days: placed. Everyone else: unknown - nothing is
-- invented about people we have not heard from.
-- ---------------------------------------------------------------------
with active as (
  select c.id, greatest(max(u.last_login_at), max(a.applied_at)) as at
    from candidates c
    left join users u on u.id = c.user_id and u.last_login_at > now() - interval '30 days'
    left join applications a on a.candidate_id = c.id and a.applied_at > now() - interval '30 days'
   where c.availability_source is null
   group by c.id
  having greatest(max(u.last_login_at), max(a.applied_at)) is not null
)
update candidates c
   set availability_status = 'actively_looking',
       availability_source = 'system',
       availability_updated_at = now(),
       availability_confirmed_at = a.at
  from active a
 where c.id = a.id;

with joined as (
  select a.candidate_id, max(h.created_at) as at
    from applications a
    join application_stage_history h on h.application_id = a.id and h.to_stage = 'joined'
   where a.stage = 'joined'
   group by a.candidate_id
  having max(h.created_at) > now() - interval '90 days'
)
update candidates c
   set availability_status = 'placed',
       availability_source = 'system',
       availability_updated_at = now(),
       availability_placed_at = j.at
  from joined j
 where c.id = j.candidate_id;

update candidates set can_join_in = can_join_in_from_notice(notice_period)
 where can_join_in is null and notice_period is not null;

insert into candidate_availability_history (candidate_id, from_status, to_status, source, changed_at)
select id, 'unknown', availability_status, 'system', now()
  from candidates
 where availability_source = 'system' and availability_status <> 'unknown'
   and not exists (select 1 from candidate_availability_history h where h.candidate_id = candidates.id);

-- ---------------------------------------------------------------------
-- the Notification Settings screen lists one row per template
-- ---------------------------------------------------------------------
insert into notification_templates (event_key, label, fires_on) values
  ('availability_check',  'Availability — Still looking?',     array['AVAILABILITY_CHECK']),
  ('availability_placed', 'Availability — After placement',    array['AVAILABILITY_PLACED'])
on conflict (event_key) do nothing;

-- ---------------------------------------------------------------------
-- who may call what
-- ---------------------------------------------------------------------
revoke execute on function availability_write(text, text, text, text, text[], text[], boolean) from public;
revoke execute on function applications_availability() from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant select on candidate_availability_history, availability_checks to app_api;
    grant usage, select on sequence candidate_availability_history_id_seq, availability_checks_id_seq to app_api;
    grant execute on function
      can_join_in_from_notice(text),
      app_privileged_context(),
      availability_candidate_set(text, text, text[], text[]),
      availability_register(text, text),
      availability_reply_peek(text),
      availability_reply(text, text),
      availability_engine_guard(),
      availability_engine_due(timestamptz),
      availability_engine_placed_due(timestamptz),
      availability_engine_release(text),
      availability_engine_check_add(text, text, text, text, text, jsonb, timestamptz),
      availability_engine_lapse(timestamptz),
      availability_rank(text, timestamptz),
      availability_report(int)
      to app_api;
  end if;
end $$;

comment on column candidates.availability_status is
  'The candidate''s own word on whether they are looking (0092). Written only by availability_* functions: the candidate, their reply link, applying, or the system (joined -> placed -> not_looking).';
