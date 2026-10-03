-- ---------------------------------------------------------------------
-- 0086 — "Save this search": one list, with alerts
--
-- A candidate's job alerts lived in the BROWSER, under the user_prefs key
-- teamlink_job_alerts_v1, as {q, loc, freq}. The server never read them,
-- so an alert set to "Instant" sent nothing, ever - the page said "we will
-- tell you when matching roles are posted" and nothing did. There was
-- also a `job_alerts` table from 0001 that no route has ever written.
--
-- A saved search and a job alert are the same thing: a set of filters a
-- candidate wants to come back to, and possibly be told about. So there
-- is ONE table, and both of the old stores are copied into it below so
-- nobody loses an alert they made.
--
--   candidate_saved_searches            the search, its label, how often to alert
--   candidate_saved_search_hits         which job matched which search, and whether
--                             it has been sent - the guard that stops one
--                             job being announced twice
--   candidate_saved_search_deliveries   one row per channel per message, so "did
--                             they actually get it" has an answer
--
-- PRIVACY. A saved search says what somebody is looking for - often that
-- they are looking at all. A candidate reads and writes only their own;
-- recruiters and admins have no policy that lets them read these rows.
-- The alert engine reaches them through the definer functions at the end
-- of this file, which refuse any caller that is a signed-in person.
-- ---------------------------------------------------------------------

create table if not exists candidate_saved_searches (
  id               text primary key,
  candidate_id     text not null references candidates(id) on delete cascade,
  label            text not null check (char_length(btrim(label)) between 1 and 80),

  -- The candidate search screen's own filter object, normalised by the
  -- API (empty values dropped, lists sorted) so that two searches for the
  -- same thing are the same jsonb - and jsonb's text form is canonical,
  -- which is what makes filters_key a reliable duplicate check.
  filters          jsonb not null default '{}'::jsonb,
  filters_key      text generated always as (md5(filters::text)) stored,

  alert_frequency  text not null default 'daily'
                   check (alert_frequency in ('off','instant','daily','weekly')),
  channels         text[] not null default array['email']
                   check (channels <@ array['email','sms','whatsapp']::text[]),

  -- "5 new" means published after this. Starts at creation, so a search
  -- saved a minute ago does not announce every job already on the board.
  last_viewed_at   timestamptz not null default now(),
  last_alerted_at  timestamptz,
  -- The last daily/weekly slot this search was PROCESSED for, sent or
  -- not. A restart at 10:00 must not send the 08:00 digest twice, and a
  -- search with nothing new at 08:00 must not send at 15:00 when a job
  -- arrives - it waits for tomorrow's slot. No scheduler state needed.
  last_digest_at   timestamptz,

  -- where it came from, for the two migrated stores
  origin           text not null default 'portal',

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create unique index if not exists saved_searches_label_uq
  on candidate_saved_searches (candidate_id, lower(btrim(label)));
create unique index if not exists saved_searches_filters_uq
  on candidate_saved_searches (candidate_id, filters_key);
create index if not exists saved_searches_freq_idx
  on candidate_saved_searches (alert_frequency) where alert_frequency <> 'off';

create table if not exists candidate_saved_search_hits (
  saved_search_id  text not null references candidate_saved_searches(id) on delete cascade,
  job_id           text not null references jobs(id) on delete cascade,
  matched_at       timestamptz not null default now(),
  alerted_at       timestamptz,
  primary key (saved_search_id, job_id)
);

create index if not exists saved_search_hits_pending
  on candidate_saved_search_hits (saved_search_id) where alerted_at is null;

create table if not exists candidate_saved_search_deliveries (
  id               bigserial primary key,
  saved_search_id  text not null references candidate_saved_searches(id) on delete cascade,
  candidate_id     text not null references candidates(id) on delete cascade,
  kind             text not null check (kind in ('instant','daily','weekly')),
  channel          text not null check (channel in ('email','sms','whatsapp')),
  -- sent / failed / not_configured / skipped_no_address /
  -- skipped_quiet_hours / skipped_opted_out / blocked_not_allowlisted /
  -- skipped_test_address - whatever the provider or the rules said.
  status           text not null,
  to_address       text,
  provider         text,
  provider_ref     text,
  error            text,
  job_ids          text[] not null default '{}',
  created_at       timestamptz not null default now()
);

create index if not exists saved_search_deliveries_search
  on candidate_saved_search_deliveries (saved_search_id, created_at desc);

-- ---------------------------------------------------------------------
-- twenty, enforced here and not only in the page
-- ---------------------------------------------------------------------
create or replace function saved_searches_limit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from candidate_saved_searches where candidate_id = new.candidate_id) >= 20 then
    raise exception 'saved_search_limit: a candidate can keep at most 20 saved searches'
      using errcode = 'P0001';
  end if;
  return new;
end $$;

drop trigger if exists saved_searches_limit on candidate_saved_searches;
create trigger saved_searches_limit before insert on candidate_saved_searches
  for each row execute function saved_searches_limit();

create or replace function saved_searches_touch() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists saved_searches_touch on candidate_saved_searches;
create trigger saved_searches_touch before update on candidate_saved_searches
  for each row execute function saved_searches_touch();

-- ---------------------------------------------------------------------
-- row level security: the candidate's own, and nobody else's
-- ---------------------------------------------------------------------
alter table candidate_saved_searches          enable row level security;
alter table candidate_saved_search_hits       enable row level security;
alter table candidate_saved_search_deliveries enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies
                  where tablename = 'candidate_saved_searches' and policyname = 'saved_searches_own') then
    create policy saved_searches_own on candidate_saved_searches for all
      using (candidate_id = app_candidate_id())
      with check (candidate_id = app_candidate_id());
  end if;

  if not exists (select 1 from pg_policies
                  where tablename = 'candidate_saved_search_hits' and policyname = 'saved_search_hits_own') then
    create policy saved_search_hits_own on candidate_saved_search_hits for select
      using (exists (select 1 from candidate_saved_searches s
                      where s.id = saved_search_id and s.candidate_id = app_candidate_id()));
  end if;

  if not exists (select 1 from pg_policies
                  where tablename = 'candidate_saved_search_deliveries' and policyname = 'saved_search_deliveries_own') then
    create policy saved_search_deliveries_own on candidate_saved_search_deliveries for select
      using (candidate_id = app_candidate_id());
  end if;
end $$;

-- ---------------------------------------------------------------------
-- the alert engine's door
--
-- The engine runs inside the API process with no person behind it:
-- role 'admin' and NO user id. A signed-in administrator always has a
-- user id, so this check lets the engine in and keeps every person out -
-- which is what "staff cannot read them" has to mean in practice.
-- ---------------------------------------------------------------------
create or replace function saved_search_engine_ok() returns boolean
language sql stable as $$
  select app_role() = 'admin' and app_user_id() is null
$$;

create or replace function saved_search_engine_guard() returns void
language plpgsql as $$
begin
  if not saved_search_engine_ok() then
    raise exception 'saved searches are read by the alert engine only'
      using errcode = '42501';
  end if;
end $$;

/** Every saved search that alerts at one of these frequencies. */
create or replace function saved_search_engine_list(p_freq text[])
returns table (id text, candidate_id text, label text, filters jsonb,
               alert_frequency text, channels text[],
               last_alerted_at timestamptz, last_digest_at timestamptz,
               created_at timestamptz)
language plpgsql security definer set search_path = public as $$
begin
  perform saved_search_engine_guard();
  return query
    select s.id, s.candidate_id, s.label, s.filters, s.alert_frequency, s.channels,
           s.last_alerted_at, s.last_digest_at, s.created_at
      from candidate_saved_searches s
     where s.alert_frequency = any(p_freq);
end $$;

/** This search has been processed for the current digest slot. */
create or replace function saved_search_digest_done(p_search text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  perform saved_search_engine_guard();
  update candidate_saved_searches set last_digest_at = now() where id = p_search;
end $$;

/** Record that a job matched a search. True only the first time. */
create or replace function saved_search_hit_add(p_search text, p_job text)
returns boolean
language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  perform saved_search_engine_guard();
  insert into candidate_saved_search_hits (saved_search_id, job_id) values (p_search, p_job)
  on conflict do nothing;
  get diagnostics v_n = row_count;
  return v_n > 0;
end $$;

/** Hits not yet announced, oldest first. */
create or replace function saved_search_pending(p_search text)
returns table (job_id text, matched_at timestamptz)
language plpgsql security definer set search_path = public as $$
begin
  perform saved_search_engine_guard();
  return query
    select h.job_id, h.matched_at from candidate_saved_search_hits h
     where h.saved_search_id = p_search and h.alerted_at is null
     order by h.matched_at;
end $$;

/** These jobs have now been told; the search was alerted now. */
create or replace function saved_search_mark_alerted(p_search text, p_jobs text[])
returns void
language plpgsql security definer set search_path = public as $$
begin
  perform saved_search_engine_guard();
  update candidate_saved_search_hits set alerted_at = now()
   where saved_search_id = p_search and job_id = any(p_jobs) and alerted_at is null;
  update candidate_saved_searches set last_alerted_at = now() where id = p_search;
end $$;

create or replace function saved_search_delivery_add(
  p_search text, p_candidate text, p_kind text, p_channel text, p_status text,
  p_to text, p_provider text, p_ref text, p_error text, p_jobs text[]
) returns bigint
language plpgsql security definer set search_path = public as $$
declare v_id bigint;
begin
  perform saved_search_engine_guard();
  insert into candidate_saved_search_deliveries
    (saved_search_id, candidate_id, kind, channel, status, to_address,
     provider, provider_ref, error, job_ids)
  values (p_search, p_candidate, p_kind, p_channel, p_status, p_to,
          p_provider, p_ref, left(p_error, 500), coalesce(p_jobs, '{}'))
  returning id into v_id;
  return v_id;
end $$;

/**
 * "Stop this alert", from the link in an email. The API has already
 * verified the signed token; this only turns the one search off. Returns
 * the label so the page can say which alert was stopped.
 */
create or replace function saved_search_stop(p_search text)
returns text
language plpgsql security definer set search_path = public as $$
declare v_label text;
begin
  perform saved_search_engine_guard();
  update candidate_saved_searches set alert_frequency = 'off'
   where id = p_search returning label into v_label;
  return v_label;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant select, insert, update, delete on candidate_saved_searches to app_api;
    grant select on candidate_saved_search_hits, candidate_saved_search_deliveries to app_api;
    grant usage, select on sequence candidate_saved_search_deliveries_id_seq to app_api;
    grant execute on function saved_search_engine_list(text[]) to app_api;
    grant execute on function saved_search_hit_add(text, text) to app_api;
    grant execute on function saved_search_pending(text) to app_api;
    grant execute on function saved_search_mark_alerted(text, text[]) to app_api;
    grant execute on function saved_search_delivery_add(
      text, text, text, text, text, text, text, text, text, text[]) to app_api;
    grant execute on function saved_search_stop(text) to app_api;
    grant execute on function saved_search_digest_done(text) to app_api;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- the two old stores, copied in so nobody loses an alert
--
-- Filters are written in the same normalised shape the API writes, so a
-- migrated alert and the same search saved again collide on filters_key
-- instead of becoming two rows. The old "loc" was one of five cities or
-- Remote; a city becomes a location tag (what the search screen uses
-- now), Remote becomes the Remote work mode.
--
-- A paused alert stays quiet ('off'). Anything else keeps the frequency
-- the candidate chose, so an alert that promised to tell them does.
-- Twenty at most per candidate, newest first, as the limit says.
-- ---------------------------------------------------------------------
with old as (
  select c.id as candidate_id,
         nullif(btrim(a->>'q'), '')   as q,
         nullif(btrim(a->>'loc'), '') as loc,
         lower(coalesce(a->>'freq', 'daily')) as freq,
         coalesce((a->>'paused')::boolean, false) as paused,
         coalesce(nullif(a->>'createdAt','')::timestamptz, p.updated_at) as made,
         'prefs' as origin
    from user_prefs p
    join candidates c on c.user_id = p.user_id
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(p.value) = 'array' then p.value else '[]'::jsonb end) a
   where p.key = 'teamlink_job_alerts_v1'
     and jsonb_typeof(a) = 'object'
  union all
  select j.candidate_id,
         nullif(btrim(coalesce(j.query, j.filters->>'q')), ''),
         nullif(btrim(coalesce(j.location, j.filters->>'loc')), ''),
         lower(coalesce(j.frequency, 'daily')),
         coalesce(j.paused, false),
         j.created_at,
         'job_alerts'
    from job_alerts j
),
shaped as (
  select candidate_id, origin, made,
         jsonb_strip_nulls(jsonb_build_object(
           'q', q,
           'locTags', case when loc is not null and lower(loc) not in ('remote','any location')
                           then jsonb_build_array(loc) end,
           'modes', case when lower(loc) = 'remote' then jsonb_build_array('Remote') end
         )) as filters,
         left(coalesce(q, 'All jobs') || coalesce(' · ' || loc, ''), 80) as base_label,
         case when paused then 'off'
              when freq in ('instant','daily','weekly') then freq
              else 'daily' end as freq
    from old
   where q is not null or loc is not null
),
deduped as (
  select distinct on (candidate_id, md5(filters::text)) *
    from shaped
   order by candidate_id, md5(filters::text), made desc
),
ranked as (
  select *, row_number() over (partition by candidate_id order by made desc) as n,
            row_number() over (partition by candidate_id, lower(base_label) order by made desc) as same
    from deduped
)
insert into candidate_saved_searches (id, candidate_id, label, filters, alert_frequency, channels,
                            last_viewed_at, origin, created_at)
select 'ss_m' || substr(md5(candidate_id || filters::text), 1, 12),
       candidate_id,
       case when same = 1 then base_label
            else left(base_label, 74) || ' (' || same || ')' end,
       filters, freq, array['email'], now(), origin, made
  from ranked
 where n <= 20
on conflict do nothing;

-- ---------------------------------------------------------------------
-- the Notification Settings screen lists one row per template; these two
-- make the saved-search messages appear there, so an EmailJS template id
-- can be attached to them like any other.
-- ---------------------------------------------------------------------
insert into notification_templates (event_key, label, fires_on) values
  ('saved_search_alert',  'Saved Search — New Job',  array['SAVED_SEARCH_ALERT']),
  ('saved_search_digest', 'Saved Search — Digest',   array['SAVED_SEARCH_DIGEST'])
on conflict (event_key) do nothing;

comment on table candidate_saved_searches is
  'A candidate''s saved job searches, which are also their job alerts. Readable only by that candidate; the alert engine uses the saved_search_* definer functions.';
