-- ---------------------------------------------------------------------
-- 0099 — Walk-in drives: a date, a venue, a list of who is coming
--
-- A walk-in JOB POSTING already exists (0083: jobs.posting_kind =
-- 'walkin' with walkin_date / walkin_venue / walkin_contact). That is an
-- advert: it is applied to like any other job and lands in the pipeline.
-- What it cannot do is the thing a walk-in DRIVE is for - count heads.
-- A recruiter running a drive on Saturday needs to know how many people
-- are coming, cap the room, send the venue and the documents to bring,
-- remind them the day before, and on the day tick off who turned up.
--
-- So a drive is its own record, and MAY point at a walk-in job posting
-- (job_id). Nothing about the existing walk-in jobs changes: they keep
-- their columns, their cards and their apply flow. A drive linked to one
-- simply borrows its company, role and skills when the recruiter says so.
--
--   walkin_drives          the event: date, times, venue, seats, status
--   walkin_registrations   one row per (drive, candidate) - unique
--   walkin_notifications   one row per message per channel, and the
--                          claim that stops any message going twice
--
-- WHO SEES WHAT (row level security, below):
--   candidate   drives that are UPCOMING or ONGOING, plus any drive they
--               registered for (so My Registrations can show past ones);
--               their own registrations only
--   recruiter   the drives they created, and the registrations on them
--   admin       everything
--
-- COMPANY NAME. A drive carries company_id, exactly like a job, and a
-- candidate is shown that company's name exactly where a job card shows
-- it (jobs.company_id -> companies.name). Nothing new is disclosed: it is
-- the convention the candidate job pages follow today. The word "Client"
-- never appears in anything a candidate is sent (0051).
--
-- TIME. A drive's date and times are India Standard Time, as the
-- recruiter typed them. India has no daylight saving, so "IST" is a fixed
-- 330-minute offset and is applied as arithmetic rather than through a
-- time zone database.
-- ---------------------------------------------------------------------

create table if not exists walkin_drives (
  id                   text primary key,
  title                text not null check (char_length(btrim(title)) between 3 and 120),
  company_id           text references companies(id) on delete set null,
  -- the walk-in job posting this drive is for, when there is one (0083)
  job_id               text references jobs(id) on delete set null,
  job_role             text not null check (char_length(btrim(job_role)) between 2 and 120),
  description          text check (description is null or char_length(description) <= 5000),

  drive_date           date not null,
  start_time           time not null,
  end_time             time not null,

  venue_name           text not null check (char_length(btrim(venue_name)) between 2 and 160),
  full_address         text not null check (char_length(btrim(full_address)) between 5 and 500),
  city                 text not null check (char_length(btrim(city)) between 2 and 80),
  map_link             text check (map_link is null or map_link ~* '^https://'),

  salary_range         text check (salary_range is null or char_length(salary_range) <= 80),
  experience_required  text check (experience_required is null or char_length(experience_required) <= 80),
  qualification        text check (qualification is null or char_length(qualification) <= 160),
  skills               text[] not null default '{}',
  documents_to_carry   text[] not null default '{}',

  contact_person_name  text check (contact_person_name is null or char_length(contact_person_name) <= 80),
  contact_phone        text check (contact_phone is null or contact_phone ~ '^[0-9+()\- ]{6,20}$'),

  max_seats            int check (max_seats is null or max_seats between 1 and 100000),
  status               text not null default 'UPCOMING'
                       check (status in ('UPCOMING','ONGOING','COMPLETED','CANCELLED')),
  cancel_reason        text check (cancel_reason is null or char_length(cancel_reason) <= 500),

  -- Bumped by the API when something a registered candidate relies on
  -- changes (date, time, venue, documents). The "drive was updated"
  -- message is keyed on it, so one edit is announced once.
  version              int not null default 1,

  created_by_recruiter_id text references recruiters(id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  check (end_time > start_time)
);

create index if not exists walkin_drives_date_idx on walkin_drives (drive_date);
create index if not exists walkin_drives_owner_idx on walkin_drives (created_by_recruiter_id);
create index if not exists walkin_drives_status_idx on walkin_drives (status);

create table if not exists walkin_registrations (
  id                   text primary key,
  drive_id             text not null references walkin_drives(id) on delete cascade,
  candidate_id         text not null references candidates(id) on delete cascade,
  status               text not null default 'REGISTERED'
                       check (status in ('REGISTERED','ATTENDED','NO_SHOW','CANCELLED')),
  registered_at        timestamptz not null default now(),
  cancelled_at         timestamptz,
  attendance_marked_at timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (drive_id, candidate_id)
);

create index if not exists walkin_registrations_candidate_idx on walkin_registrations (candidate_id);

create table if not exists walkin_notifications (
  id               bigserial primary key,
  registration_id  text not null references walkin_registrations(id) on delete cascade,
  drive_id         text not null references walkin_drives(id) on delete cascade,
  candidate_id     text not null references candidates(id) on delete cascade,
  kind             text not null check (kind in
                     ('registered','reminder_day_before','reminder_morning','updated','cancelled')),
  -- what makes this message a different message from the last one of
  -- the same kind: the registration time, the drive date, the version
  dedupe_key       text not null,
  channel          text not null check (channel in ('portal','email','sms','whatsapp')),
  -- pending (claimed, being sent) / sent / failed / not_configured /
  -- skipped_no_address / skipped_opted_out / skipped_quiet_hours
  status           text not null default 'pending',
  to_address       text,
  provider         text,
  provider_ref     text,
  error            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (registration_id, kind, dedupe_key, channel)
);

create index if not exists walkin_notifications_drive_idx on walkin_notifications (drive_id);

-- ---------------------------------------------------------------------
-- what the drive's status really is, right now
--
-- The stored status moves forward on a timer (walkin_refresh_statuses),
-- but a read must never wait for the timer: a drive whose end time has
-- passed is COMPLETED whether or not the sweep has run yet.
-- ---------------------------------------------------------------------
create or replace function walkin_live_status(p_status text, p_date date, p_start time, p_end time)
returns text
language sql stable as $$
  select case
    when p_status in ('CANCELLED','COMPLETED') then p_status
    when now() >= ((p_date + p_end)   - interval '330 minutes') at time zone 'UTC' then 'COMPLETED'
    when now() >= ((p_date + p_start) - interval '330 minutes') at time zone 'UTC' then 'ONGOING'
    else 'UPCOMING'
  end
$$;

-- ---------------------------------------------------------------------
-- helpers the policies call (SECURITY DEFINER: each reads the OTHER
-- table, and an invoker-rights version would recurse through its policy)
-- ---------------------------------------------------------------------
create or replace function app_walkin_drive_is_mine(p_drive text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from walkin_drives d
     where d.id = p_drive
       and d.created_by_recruiter_id is not null
       and d.created_by_recruiter_id = app_recruiter_id())
$$;

create or replace function app_walkin_registered(p_drive text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from walkin_registrations r
     where r.drive_id = p_drive and r.candidate_id = app_candidate_id())
$$;

create or replace function walkin_touch() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists walkin_drives_touch on walkin_drives;
create trigger walkin_drives_touch before update on walkin_drives
  for each row execute function walkin_touch();
drop trigger if exists walkin_registrations_touch on walkin_registrations;
create trigger walkin_registrations_touch before update on walkin_registrations
  for each row execute function walkin_touch();
drop trigger if exists walkin_notifications_touch on walkin_notifications;
create trigger walkin_notifications_touch before update on walkin_notifications
  for each row execute function walkin_touch();

-- ---------------------------------------------------------------------
-- row level security
-- ---------------------------------------------------------------------
alter table walkin_drives        enable row level security;
alter table walkin_registrations enable row level security;
alter table walkin_notifications enable row level security;

drop policy if exists walkin_drives_read on walkin_drives;
create policy walkin_drives_read on walkin_drives for select using (
  app_is_admin()
  or (app_role() = 'recruiter' and created_by_recruiter_id is not null
      and created_by_recruiter_id = app_recruiter_id())
  or (app_role() = 'candidate' and (status in ('UPCOMING','ONGOING')
                                    or app_walkin_registered(id)))
);

drop policy if exists walkin_drives_insert on walkin_drives;
create policy walkin_drives_insert on walkin_drives for insert with check (
  app_is_admin()
  or (app_role() = 'recruiter' and created_by_recruiter_id = app_recruiter_id())
);

drop policy if exists walkin_drives_update on walkin_drives;
create policy walkin_drives_update on walkin_drives for update
  using (app_is_admin()
         or (app_role() = 'recruiter' and created_by_recruiter_id = app_recruiter_id()))
  with check (app_is_admin()
         or (app_role() = 'recruiter' and created_by_recruiter_id = app_recruiter_id()));

drop policy if exists walkin_drives_delete on walkin_drives;
create policy walkin_drives_delete on walkin_drives for delete using (
  app_is_admin()
  or (app_role() = 'recruiter' and created_by_recruiter_id = app_recruiter_id())
);

drop policy if exists walkin_registrations_read on walkin_registrations;
create policy walkin_registrations_read on walkin_registrations for select using (
  app_is_admin()
  or (app_role() = 'candidate' and candidate_id = app_candidate_id())
  or (app_role() = 'recruiter' and app_walkin_drive_is_mine(drive_id))
);

-- Attendance. A candidate never writes a registration directly: they go
-- through walkin_register / walkin_cancel below, which check the seats
-- and the date under a lock.
drop policy if exists walkin_registrations_staff_update on walkin_registrations;
create policy walkin_registrations_staff_update on walkin_registrations for update
  using (app_is_admin() or (app_role() = 'recruiter' and app_walkin_drive_is_mine(drive_id)))
  with check (app_is_admin() or (app_role() = 'recruiter' and app_walkin_drive_is_mine(drive_id)));

drop policy if exists walkin_notifications_read on walkin_notifications;
create policy walkin_notifications_read on walkin_notifications for select using (
  app_is_admin()
  or (app_role() = 'candidate' and candidate_id = app_candidate_id())
  or (app_role() = 'recruiter' and app_walkin_drive_is_mine(drive_id))
);

-- Only the notifier (the engine: role admin, no user id) records
-- deliveries. A signed-in administrator has a user id and is refused.
drop policy if exists walkin_notifications_engine_write on walkin_notifications;
create policy walkin_notifications_engine_write on walkin_notifications for all
  using (app_role() = 'admin' and app_user_id() is null)
  with check (app_role() = 'admin' and app_user_id() is null);

-- ---------------------------------------------------------------------
-- registering, and cancelling - the candidate's two writes
--
-- One function each, so the rules are checked where the row is written
-- and under a lock on the drive: two candidates pressing Register for
-- the last seat at the same moment cannot both get it.
--
-- Errors are raised with a stable prefix the API maps to a message:
--   walkin_not_found / walkin_closed / walkin_full / walkin_duplicate /
--   walkin_not_registered / walkin_not_candidate
-- ---------------------------------------------------------------------
create or replace function walkin_register(p_drive text, p_reg_id text)
returns table (registration_id text, reregistered boolean)
language plpgsql security definer set search_path = public as $$
declare
  v_cand  text := app_candidate_id();
  v_drive walkin_drives%rowtype;
  v_live  text;
  v_taken int;
  v_old   walkin_registrations%rowtype;
  v_had   boolean;
begin
  if app_role() <> 'candidate' or v_cand is null then
    raise exception 'walkin_not_candidate: only a signed-in candidate can register' using errcode = '42501';
  end if;

  select * into v_drive from walkin_drives where id = p_drive for update;
  if not found then
    raise exception 'walkin_not_found: no such drive' using errcode = 'P0002';
  end if;

  v_live := walkin_live_status(v_drive.status, v_drive.drive_date, v_drive.start_time, v_drive.end_time);
  if v_live not in ('UPCOMING','ONGOING') then
    raise exception 'walkin_closed: this drive is %', lower(v_live) using errcode = 'P0001';
  end if;

  select * into v_old from walkin_registrations where drive_id = p_drive and candidate_id = v_cand;
  v_had := found;
  if v_had and v_old.status <> 'CANCELLED' then
    raise exception 'walkin_duplicate: already registered' using errcode = 'P0001';
  end if;

  if v_drive.max_seats is not null then
    select count(*) into v_taken from walkin_registrations
     where drive_id = p_drive and status <> 'CANCELLED';
    if v_taken >= v_drive.max_seats then
      raise exception 'walkin_full: all % seats are taken', v_drive.max_seats using errcode = 'P0001';
    end if;
  end if;

  if v_had then
    -- they cancelled earlier and are coming after all: the same row
    -- (the pair is unique), with a fresh registration time
    update walkin_registrations
       set status = 'REGISTERED', registered_at = now(), cancelled_at = null,
           attendance_marked_at = null
     where id = v_old.id;
    return query select v_old.id, true;
  else
    insert into walkin_registrations (id, drive_id, candidate_id)
    values (p_reg_id, p_drive, v_cand);
    return query select p_reg_id, false;
  end if;
end $$;

create or replace function walkin_cancel(p_drive text)
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_cand text := app_candidate_id();
  v_id   text;
  v_drive walkin_drives%rowtype;
begin
  if app_role() <> 'candidate' or v_cand is null then
    raise exception 'walkin_not_candidate: only a signed-in candidate can cancel' using errcode = '42501';
  end if;
  select * into v_drive from walkin_drives where id = p_drive;
  if not found then
    raise exception 'walkin_not_found: no such drive' using errcode = 'P0002';
  end if;
  if walkin_live_status(v_drive.status, v_drive.drive_date, v_drive.start_time, v_drive.end_time)
       = 'COMPLETED' then
    raise exception 'walkin_closed: this drive has already taken place' using errcode = 'P0001';
  end if;
  update walkin_registrations
     set status = 'CANCELLED', cancelled_at = now()
   where drive_id = p_drive and candidate_id = v_cand and status = 'REGISTERED'
  returning id into v_id;
  if v_id is null then
    raise exception 'walkin_not_registered: no active registration' using errcode = 'P0001';
  end if;
  return v_id;
end $$;

/**
 * The registrations on one drive, with what the recruiter needs to run
 * the gate: who, how to reach them, and their headline profile. Only the
 * drive's owner (or an admin) gets rows; anybody else gets nothing.
 *
 * A DEFINER FUNCTION because a candidate who registered for a drive has
 * not necessarily applied to any of this recruiter's jobs, so the
 * candidates policy (0031) would hide them - and the recruiter cannot
 * check people in at a door they cannot see.
 */
create or replace function walkin_drive_registrations(p_drive text)
returns table (id text, drive_id text, candidate_id text, status text,
               registered_at timestamptz, cancelled_at timestamptz,
               attendance_marked_at timestamptz,
               name text, email text, phone text, location text, title text,
               exp text, education text, skills text[], has_resume boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  if not (app_is_admin() or (app_role() = 'recruiter' and app_walkin_drive_is_mine(p_drive))) then
    return;
  end if;
  return query
    select r.id, r.drive_id, r.candidate_id, r.status, r.registered_at, r.cancelled_at,
           r.attendance_marked_at,
           c.name, c.email, c.phone, c.location, c.title, c.exp, c.education,
           coalesce(c.skills, '{}'), coalesce(c.resume_file, '') <> ''
      from walkin_registrations r
      join candidates c on c.id = r.candidate_id
     where r.drive_id = p_drive
     order by r.registered_at;
end $$;

/** Seats taken on drives the caller can see - candidates see the count, not the people. */
create or replace function walkin_seats_taken(p_drives text[])
returns table (drive_id text, taken int)
language sql stable security definer set search_path = public as $$
  select r.drive_id, count(*)::int
    from walkin_registrations r
    join walkin_drives d on d.id = r.drive_id
   where r.drive_id = any(p_drives) and r.status <> 'CANCELLED'
     and (app_is_admin()
          or (app_role() = 'recruiter' and d.created_by_recruiter_id = app_recruiter_id())
          or (app_role() = 'candidate' and (d.status in ('UPCOMING','ONGOING')
                                            or app_walkin_registered(d.id))))
   group by r.drive_id
$$;

/**
 * Move stored statuses forward: UPCOMING -> ONGOING -> COMPLETED as the
 * clock passes the drive's start and end. The engine only. Idempotent.
 */
create or replace function walkin_refresh_statuses()
returns int
language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  if not (app_role() = 'admin' and app_user_id() is null) then
    raise exception 'walkin statuses are refreshed by the engine only' using errcode = '42501';
  end if;
  update walkin_drives d
     set status = walkin_live_status(d.status, d.drive_date, d.start_time, d.end_time)
   where d.status in ('UPCOMING','ONGOING')
     and d.status <> walkin_live_status(d.status, d.drive_date, d.start_time, d.end_time);
  get diagnostics v_n = row_count;
  return v_n;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant select, insert, update, delete on walkin_drives to app_api;
    grant select, update on walkin_registrations to app_api;
    grant select, insert, update on walkin_notifications to app_api;
    grant usage, select on sequence walkin_notifications_id_seq to app_api;
    grant execute on function walkin_live_status(text, date, time, time) to app_api;
    grant execute on function app_walkin_drive_is_mine(text) to app_api;
    grant execute on function app_walkin_registered(text) to app_api;
    grant execute on function walkin_register(text, text) to app_api;
    grant execute on function walkin_cancel(text) to app_api;
    grant execute on function walkin_drive_registrations(text) to app_api;
    grant execute on function walkin_seats_taken(text[]) to app_api;
    grant execute on function walkin_refresh_statuses() to app_api;
  end if;
end $$;

-- The Notification Settings screen lists one row per template.
insert into notification_templates (event_key, label, fires_on) values
  ('walkin_registered', 'Walk-in Drive — Registration Confirmed', array['WALKIN_REGISTERED']),
  ('walkin_reminder',   'Walk-in Drive — Reminder',               array['WALKIN_REMINDER']),
  ('walkin_updated',    'Walk-in Drive — Details Changed',        array['WALKIN_UPDATED']),
  ('walkin_cancelled',  'Walk-in Drive — Cancelled',              array['WALKIN_CANCELLED'])
on conflict (event_key) do nothing;

comment on table walkin_drives is
  'Walk-in recruitment drives (0099). May link to a walk-in job posting (jobs.posting_kind = walkin, 0083) through job_id; the posting itself is unchanged.';
comment on table walkin_registrations is
  'Who registered for which walk-in drive. One row per (drive, candidate); a cancelled registration is reactivated rather than duplicated.';
