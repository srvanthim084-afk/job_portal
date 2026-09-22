-- ---------------------------------------------------------------------
-- 0017 — job alerts: who was matched, why, what we sent, and what they did
--
-- When a requirement is published the engine scores every candidate
-- profile against it and messages the ones that clear the bar. That
-- produces an obligation: for every message sent, the ATS must be able to
-- answer
--
--     which candidate · which job · what score · which skills matched
--     when · on which channels · did each one arrive · did they click
--     · did they apply
--
-- without which nobody can tell a working alert system from one that has
-- been quietly failing for a month.
--
-- Two tables, because they answer different questions:
--
--   job_matches            one row per candidate per job — the decision
--   job_match_deliveries   one row per channel attempt — the outcome
--
-- The three status columns on job_matches are a denormalised copy of the
-- delivery rows, maintained by a trigger. They exist because the ATS grid
-- shows one line per candidate with email/SMS/WhatsApp beside it, and
-- that must not be three subqueries per row.
-- ---------------------------------------------------------------------

create table if not exists job_matches (
  id             text primary key,
  job_id         text not null references jobs(id)       on delete cascade,
  candidate_id   text not null references candidates(id) on delete cascade,

  -- the decision
  score          numeric not null check (score between 0 and 100),
  threshold      numeric not null,
  notified       boolean not null default false,
  reason         text,                      -- why, in words, for a human
  matched_skills text[] default '{}',
  -- Per-dimension detail: skills, experience, role, location, education,
  -- preferences. jsonb because the dimensions are a product decision that
  -- will change, and a migration per change is not worth it.
  breakdown      jsonb,

  matched_at     timestamptz not null default now(),
  notified_at    timestamptz,

  -- what the candidate did next
  clicked_at     timestamptz,
  applied_at     timestamptz,
  application_id text references applications(id) on delete set null,

  -- the ATS grid's three columns
  email_status    text,
  sms_status      text,
  whatsapp_status text,

  unique (job_id, candidate_id)
);

create index if not exists job_matches_job_idx   on job_matches (job_id, score desc);
create index if not exists job_matches_cand_idx  on job_matches (candidate_id, matched_at desc);
create index if not exists job_matches_notified_idx
  on job_matches (notified_at desc) where notified;

create table if not exists job_match_deliveries (
  id           bigserial primary key,
  match_id     text not null references job_matches(id) on delete cascade,
  channel      text not null check (channel in ('email','sms','whatsapp','ivr')),
  status       text not null check (status in
                 ('sent','delivered','read','failed','not_configured','skipped_no_address')),
  to_address   text,
  provider     text,
  provider_ref text,
  error        text,
  attempt      int not null default 1,
  -- Set only when a provider actually tells us. Nothing fabricates these:
  -- an unread message is null, not "delivered".
  delivered_at timestamptz,
  read_at      timestamptz,
  created_at   timestamptz not null default now(),
  unique (match_id, channel, attempt)
);

create index if not exists job_match_deliveries_match_idx on job_match_deliveries (match_id);

-- ---------------------------------------------------------------------
-- keep the grid's three columns true to the delivery rows
-- ---------------------------------------------------------------------
create or replace function job_match_delivery_rollup() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update job_matches m
     set email_status    = case when new.channel = 'email'    then new.status else m.email_status end,
         sms_status      = case when new.channel = 'sms'      then new.status else m.sms_status end,
         whatsapp_status = case when new.channel = 'whatsapp' then new.status else m.whatsapp_status end,
         notified        = m.notified or new.status in ('sent','delivered','read'),
         notified_at     = coalesce(m.notified_at,
                             case when new.status in ('sent','delivered','read') then now() end)
   where m.id = new.match_id;
  return new;
end $$;

drop trigger if exists job_match_delivery_rollup_t on job_match_deliveries;
create trigger job_match_delivery_rollup_t
  after insert or update on job_match_deliveries
  for each row execute function job_match_delivery_rollup();

-- ---------------------------------------------------------------------
-- RLS
--
-- A candidate sees their own matches. A recruiter sees matches for
-- candidates they are allowed to see at all — matching considers every
-- profile, including private ones, because the alert is for the
-- CANDIDATE's benefit; that must not become a way to read a private
-- profile through the back door.
-- ---------------------------------------------------------------------
alter table job_matches           enable row level security;
alter table job_matches           force  row level security;
alter table job_match_deliveries  enable row level security;
alter table job_match_deliveries  force  row level security;

drop policy if exists job_matches_read on job_matches;
create policy job_matches_read on job_matches for select using (
  app_is_admin()
  or candidate_id = app_candidate_id()
  or (app_role() in ('recruiter','bde','client')
      and exists (select 1 from candidates c where c.id = job_matches.candidate_id))
);

drop policy if exists job_match_deliveries_read on job_match_deliveries;
create policy job_match_deliveries_read on job_match_deliveries for select using (
  app_is_admin()
  or exists (
    select 1 from job_matches m
     where m.id = job_match_deliveries.match_id
       and (m.candidate_id = app_candidate_id() or app_role() in ('recruiter','bde','client')))
);

-- ---------------------------------------------------------------------
-- writes, through functions only
--
-- The engine runs as a system identity because it must consider every
-- candidate, including ones the posting recruiter cannot see. Confining
-- the writes to these three functions keeps that privilege to the
-- narrowest possible surface.
-- ---------------------------------------------------------------------
create or replace function job_match_record(
  p_id text,
  p_job_id text,
  p_candidate_id text,
  p_score numeric,
  p_threshold numeric,
  p_reason text,
  p_matched_skills text[],
  p_breakdown jsonb
) returns text
language plpgsql security definer set search_path = public as $$
declare v_id text;
begin
  insert into job_matches
    (id, job_id, candidate_id, score, threshold, reason, matched_skills, breakdown)
  values
    (p_id, p_job_id, p_candidate_id, p_score, p_threshold, p_reason,
     coalesce(p_matched_skills, '{}'), p_breakdown)
  on conflict (job_id, candidate_id) do update
     set score = excluded.score,
         threshold = excluded.threshold,
         reason = excluded.reason,
         matched_skills = excluded.matched_skills,
         breakdown = excluded.breakdown,
         matched_at = now()
  returning id into v_id;
  return v_id;
end $$;

create or replace function job_match_delivery(
  p_match_id text,
  p_channel text,
  p_status text,
  p_to_address text,
  p_provider text,
  p_provider_ref text,
  p_error text
) returns bigint
language plpgsql security definer set search_path = public as $$
declare v_attempt int; v_id bigint;
begin
  select coalesce(max(attempt), 0) + 1 into v_attempt
    from job_match_deliveries where match_id = p_match_id and channel = p_channel;

  insert into job_match_deliveries
    (match_id, channel, status, to_address, provider, provider_ref, error, attempt)
  values
    (p_match_id, p_channel, p_status, p_to_address, p_provider, p_provider_ref,
     left(p_error, 2000), v_attempt)
  returning id into v_id;
  return v_id;
end $$;

/* The candidate opened the job from the alert. Recorded once — the first
   click is the one that says the message worked. */
create or replace function job_match_clicked(p_id text) returns void
language sql security definer set search_path = public as $$
  update job_matches set clicked_at = coalesce(clicked_at, now()) where id = p_id;
$$;

/* They applied. Called from the application route, keyed on job and
   candidate rather than on the alert id, so an application that came
   through some other route still closes the loop. */
create or replace function job_match_applied(
  p_job_id text, p_candidate_id text, p_application_id text
) returns void
language sql security definer set search_path = public as $$
  update job_matches
     set applied_at = coalesce(applied_at, now()),
         application_id = coalesce(application_id, p_application_id)
   where job_id = p_job_id and candidate_id = p_candidate_id;
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant select on job_matches, job_match_deliveries to app_api;
    grant execute on function
      job_match_record(text, text, text, numeric, numeric, text, text[], jsonb),
      job_match_delivery(text, text, text, text, text, text, text),
      job_match_clicked(text),
      job_match_applied(text, text, text)
      to app_api;
  end if;
end $$;
