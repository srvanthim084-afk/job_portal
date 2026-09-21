-- =====================================================================
-- TeamLink Job Portal — core schema
--
-- Ids are TEXT, not serial, everywhere a prototype id already exists
-- ('j1', 'cand1', 'r1', 'technova'). Requirement 6: a Job ID must stay
-- the same across edit/publish/unpublish, and the prototype prints those
-- ids in the UI, so they are the real primary keys.
-- =====================================================================

-- gen_random_uuid() is core since PostgreSQL 13, so pgcrypto is not needed.
-- Emails use text + a unique lower() index rather than citext, so the schema
-- carries no hard extension dependency and applies on any PG 13+ instance.
--
-- pg_trgm is optional: it powers fuzzy name/title search. Supabase ships it.
-- If it is unavailable the migration still applies and search falls back to
-- ILIKE — see the guarded block at the end of this file.

-- ---------------------------------------------------------------------
-- reference: ATS stages (ids exactly as DATA.stages defines them)
-- ---------------------------------------------------------------------
create table stages (
  id        text primary key,
  label     text not null,
  kanban    boolean not null default false,
  sort_order int  not null
);

insert into stages (id, label, kanban, sort_order) values
  ('applied',            'Applied',            true,  1),
  ('ai_screening',       'AI Screening',       true,  2),
  ('shortlisted',        'Shortlisted',        true,  3),
  ('interview_scheduled','Interview Scheduled',true,  4),
  ('ai_interview_done',  'AI Interview Done',  true,  5),
  ('client_review',      'Client Review',      false, 6),
  ('offer_extended',     'Offer Extended',     false, 7),
  ('selected',           'Selected',           false, 8),
  ('rejected',           'Rejected',           false, 9);

-- 'registered' is not a pipeline stage — the prototype renders it as
-- "Not applied yet" (stageBadge, prototype.html:1213). It is represented
-- by the absence of an application, never as a stage row.

-- ---------------------------------------------------------------------
-- auth
-- ---------------------------------------------------------------------
create type user_role as enum ('admin','recruiter','candidate','client');

create table users (
  id             uuid primary key default gen_random_uuid(),
  email          text not null,
  password_hash  text not null,
  role           user_role not null,
  status         text not null default 'active'
                   check (status in ('active','suspended','pending')),
  last_login_at  timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index on users (role);
-- case-insensitive unique emails, without needing the citext extension
create unique index users_email_lower_key on users (lower(email));

create table sessions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  token_hash  text unique not null,
  user_agent  text,
  ip          inet,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);
create index on sessions (user_id);
create index on sessions (expires_at);

-- ---------------------------------------------------------------------
-- organisations
-- ---------------------------------------------------------------------
create table companies (
  id         text primary key,          -- 'technova'
  name       text not null,
  industry   text,
  hq         text,
  founded    int,
  size_label text,                      -- '800–1,000 employees'
  color1     text,                      -- logo gradient — UI critical
  color2     text,
  about      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- role profiles — one per role, each hanging off a users row.
-- Kept as separate tables so DATA.recruiterById('r1') still resolves.
-- ---------------------------------------------------------------------
create table recruiters (
  id         text primary key,          -- 'r1'
  user_id    uuid unique references users(id) on delete cascade,
  name       text not null,
  email      text not null,
  company_id text references companies(id),
  title      text,
  initials   text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table client_users (
  id         text primary key,          -- 'c1'
  user_id    uuid unique references users(id) on delete cascade,
  name       text not null,
  email      text not null,
  company_id text references companies(id),
  title      text,
  initials   text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table admins (
  id         text primary key,          -- 'a1'
  user_id    uuid unique references users(id) on delete cascade,
  name       text not null,
  email      text not null,
  title      text,
  initials   text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- jobs
-- ---------------------------------------------------------------------
create table jobs (
  id              text primary key,     -- 'j1' — never regenerated on edit
  title           text not null,
  company_id      text references companies(id),
  recruiter_id    text references recruiters(id),
  location        text,
  mode            text,                 -- Hybrid / Remote / Onsite
  exp_label       text,                 -- '3–5 yrs'  (display)
  pay_label       text,                 -- '₹12–18 LPA' (display)
  salary_min      numeric,              -- filterable
  salary_max      numeric,
  employment_type text,                 -- Full-time / Contract / Internship / Walk-in
  hiring_type     text,
  posting_kind    text default 'job',   -- job / walkin / internship
  openings        int default 1,
  source          text,
  department      text,
  education       text,
  easy_apply      boolean default false,
  featured        boolean default false,
  status          text not null default 'draft'
                    check (status in ('open','closed','draft')),
  paused          boolean not null default false,
  archived        boolean not null default false,
  expires_at      timestamptz,
  skills          text[] default '{}',
  description     text,
  responsibilities text[] default '{}',
  requirements    text[] default '{}',
  published_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index on jobs (status, paused, archived);
create index on jobs (company_id);
create index on jobs (recruiter_id);
create index jobs_skills_gin  on jobs using gin (skills);

-- ---------------------------------------------------------------------
-- candidates — all 44 prototype fields preserved
-- ---------------------------------------------------------------------
create table candidates (
  id                  text primary key, -- 'cand1'
  user_id             uuid unique references users(id) on delete cascade,

  -- identity
  name                text not null,
  email               text not null,
  phone               text,
  location            text,
  gender              text,
  title               text,

  -- career
  exp                 text,             -- '4 yrs' (display)
  exp_years           numeric,          -- filterable
  ctc                 text,
  expected_ctc        numeric,
  notice_period       text,
  current_company     text,
  previous_companies  text[] default '{}',   -- an ARRAY in the prototype
  career_goal         text,
  preferred_role      text,
  preferred_location  text,
  candidate_type      text,
  preferred_work_modes text[] default '{}',

  -- profile
  skills              text[] default '{}',
  technical_skills    text[] default '{}',
  education           text,
  summary             text,
  certifications      text[] default '{}',
  languages           text[] default '{}',
  projects            jsonb  default '[]',
  linkedin            text,
  github              text,
  portfolio           text,

  -- resume (§3.3 of DATA-MAPPING — file itself lives in object storage)
  resume_file         text,             -- display name, e.g. 'Ananya_Rao_Resume.pdf'
  resume_storage_path text,
  resume_mime         text,
  resume_size         bigint,
  resume_uploaded_at  timestamptz,

  -- AI
  ai_interview_score  numeric,
  qualified           boolean,

  -- verification
  email_verified      boolean default false,
  mobile_verified     boolean default false,
  sms_verified        boolean default false,
  whatsapp_opt_in     boolean default false,

  -- activity
  days_silent         int,
  follow_up_sent      boolean default false,
  is_private          boolean default false,
  profile_active_days_ago  int,
  profile_updated_days_ago int,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index cand_skills_gin      on candidates using gin (skills);
create index cand_tech_skills_gin on candidates using gin (technical_skills);
create index on candidates (location);
create index on candidates (notice_period);

-- NOTE: appliedJobId / stage / matchScore are deliberately ABSENT here.
-- In the prototype they live on the candidate row, which is what forces
-- applications to be modelled twice (DATA-MAPPING §3.1). They are now
-- derived from the primary application and rehydrated onto the cached
-- candidate object at boot, so every existing call site still reads
-- cand.stage / cand.appliedJobId exactly as before.

-- ---------------------------------------------------------------------
-- applications — the single normalised pipeline (DATA-MAPPING §3.1)
-- ---------------------------------------------------------------------
create table applications (
  id            text primary key,
  job_id        text not null references jobs(id)       on delete cascade,
  candidate_id  text not null references candidates(id) on delete cascade,
  recruiter_id  text references recruiters(id),
  stage         text not null default 'applied' references stages(id),
  match_score   numeric,
  ai_score      numeric,
  source        text,                   -- portal / external / rediscovery / walkin
  posting_type  text,                   -- job / walkin / internship
  applied_at    timestamptz not null default now(),
  applied_on    date not null default current_date,
  resume_path   text,                   -- snapshot of the resume used to apply
  is_primary    boolean not null default false,
  is_demo       boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- requirement 7 / 24: one application per candidate per job
  unique (candidate_id, job_id)
);
create index on applications (job_id);
create index on applications (candidate_id);
create index on applications (stage);
create index on applications (recruiter_id);
-- at most one primary per candidate (the seeded pipeline entry)
create unique index applications_one_primary
  on applications (candidate_id) where is_primary;

create table application_stage_history (
  id             bigserial primary key,
  application_id text not null references applications(id) on delete cascade,
  from_stage     text references stages(id),
  to_stage       text not null references stages(id),
  changed_by     uuid references users(id),
  note           text,
  created_at     timestamptz not null default now()
);
create index on application_stage_history (application_id);

-- ---------------------------------------------------------------------
-- interviews
-- ---------------------------------------------------------------------
create table interviews (
  id             text primary key,      -- 'iv1'
  candidate_id   text not null references candidates(id) on delete cascade,
  job_id         text not null references jobs(id)       on delete cascade,
  application_id text references applications(id) on delete cascade,
  type           text,                  -- Technical (Human) / AI Interview / Client Round / HR Round
  scheduled_date date,
  scheduled_time text,                  -- kept as text: the UI renders '11:00 AM'
  mode           text,                  -- Video Call / TeamLink AI
  status         text not null default 'Scheduled'
                   check (status in ('Scheduled','Completed','Cancelled','No Show')),
  interviewer    text,
  ai_score       numeric,               -- requirement 15 — real scores only
  feedback       jsonb default '{}',
  is_demo        boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index on interviews (candidate_id);
create index on interviews (job_id);
create index on interviews (scheduled_date);

-- ---------------------------------------------------------------------
-- offers (requirement 3: Candidate → Application → Job)
-- ---------------------------------------------------------------------
create table offers (
  id             text primary key,
  application_id text not null references applications(id) on delete cascade,
  candidate_id   text not null references candidates(id),
  job_id         text not null references jobs(id),
  ctc            numeric,
  joining_date   date,
  status         text not null default 'extended'
                   check (status in ('extended','accepted','declined','withdrawn')),
  notes          text,
  extended_by    text references recruiters(id),
  extended_at    timestamptz not null default now(),
  responded_at   timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index on offers (application_id);
create index on offers (candidate_id);

-- ---------------------------------------------------------------------
-- notifications — shape mirrors createNotification() at :17679
-- ---------------------------------------------------------------------
create table notifications (
  id             text primary key,
  recipient_id   text not null,          -- candidate/recruiter/client/admin profile id
  recipient_role user_role not null default 'candidate',
  type           text not null,          -- APPLICATION_SUBMITTED / RECRUITER_VIEWED / BEST_FIT_JOB / …
  title          text,
  message        text,
  job_id         text references jobs(id)         on delete cascade,
  application_id text references applications(id) on delete cascade,
  candidate_id   text references candidates(id)   on delete cascade,
  recruiter_id   text references recruiters(id),
  read           boolean not null default false,
  system         boolean not null default false,
  metadata       jsonb  not null default '{}',
  created_at     timestamptz not null default now()
);
create index on notifications (recipient_id, recipient_role, read);
create index on notifications (created_at desc);

-- the prototype's duplicate rule (:17685): recipient + job + type,
-- narrowed by application when the event is about one application.
create unique index notifications_dedupe
  on notifications (recipient_id, type, coalesce(job_id,''), coalesce(application_id,''));

create table notification_log (
  id           bigserial primary key,
  channel      text not null check (channel in ('email','whatsapp','sms','ivr')),
  recipient_id text,
  to_address   text,
  template     text,
  subject      text,
  body         text,
  status       text not null default 'queued'
                 check (status in ('queued','sent','failed')),
  provider_ref text,
  error        text,
  created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- recruiter-owned working data (RLS keeps these per-recruiter)
-- ---------------------------------------------------------------------
create table candidate_comments (
  id           bigserial primary key,
  candidate_id text not null references candidates(id) on delete cascade,
  recruiter_id text not null references recruiters(id) on delete cascade,
  tag          text,
  body         text,
  created_at   timestamptz not null default now()
);
create index on candidate_comments (candidate_id);

create table candidate_lists (
  id           text primary key,
  recruiter_id text not null references recruiters(id) on delete cascade,
  name         text not null,
  created_at   timestamptz not null default now()
);

create table candidate_list_members (
  list_id      text not null references candidate_lists(id) on delete cascade,
  candidate_id text not null references candidates(id)      on delete cascade,
  added_at     timestamptz not null default now(),
  primary key (list_id, candidate_id)
);

create table saved_searches (
  id           text primary key,
  recruiter_id text not null references recruiters(id) on delete cascade,
  search_type  text not null default 'candidate',   -- candidate / ai
  name         text,
  filters      jsonb not null default '{}',
  last_performed timestamptz,
  created_at   timestamptz not null default now()
);

create table recent_searches (
  id           bigserial primary key,
  user_id      uuid not null references users(id) on delete cascade,
  label        text,
  filters      jsonb not null default '{}',
  created_at   timestamptz not null default now()
);
create index on recent_searches (user_id, created_at desc);

create table candidate_bookmarks (
  recruiter_id text not null references recruiters(id) on delete cascade,
  candidate_id text not null references candidates(id) on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (recruiter_id, candidate_id)
);

create table candidate_reports (
  id           bigserial primary key,
  candidate_id text not null references candidates(id) on delete cascade,
  recruiter_id text references recruiters(id),
  reason       text,
  created_at   timestamptz not null default now()
);

create table comm_templates (
  id           text primary key,
  owner_id     uuid references users(id) on delete cascade,
  kind         text not null check (kind in ('email','whatsapp','sms')),
  name         text not null,
  subject      text,
  body         text,
  verified     boolean default false,
  created_at   timestamptz not null default now()
);

create table view_events (
  id           bigserial primary key,
  viewer_id    uuid not null references users(id) on delete cascade,
  subject_type text not null,          -- candidate / job / application
  subject_id   text not null,
  created_at   timestamptz not null default now()
);
create index on view_events (viewer_id, subject_type, subject_id);

-- ---------------------------------------------------------------------
-- candidate-side saved state
-- ---------------------------------------------------------------------
create table saved_jobs (
  candidate_id text not null references candidates(id) on delete cascade,
  job_id       text not null references jobs(id)       on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (candidate_id, job_id)
);

create table hidden_jobs (
  candidate_id text not null references candidates(id) on delete cascade,
  job_id       text not null references jobs(id)       on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (candidate_id, job_id)
);

create table job_alerts (
  id           text primary key,
  candidate_id text not null references candidates(id) on delete cascade,
  label        text,
  query        text,
  location     text,
  frequency    text default 'daily',
  paused       boolean default false,
  personalized boolean default false,
  filters      jsonb default '{}',
  created_at   timestamptz not null default now()
);

create table feedback (
  id           text primary key,
  kind         text not null default 'candidate',
  by_name      text,
  rating       int check (rating between 1 and 5),
  body         text,
  created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- per-user preferences — the bulk of the 58 localStorage keys (§4.4)
-- ---------------------------------------------------------------------
create table user_prefs (
  user_id    uuid not null references users(id) on delete cascade,
  key        text not null,
  value      jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

-- ---------------------------------------------------------------------
-- platform settings (AI weights, thresholds) — DATA.aiSettings
-- ---------------------------------------------------------------------
create table app_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

insert into app_settings (key, value) values
  ('ai', '{
     "modelName":"TeamLink AI Engine v2.3",
     "autoShortlistThreshold":80,
     "resumeParseConfidence":92,
     "weightSkills":45,"weightExperience":30,"weightEducation":15,"weightLocation":10,
     "aiInterviewEnabled":true,"autoScreeningEnabled":true,"whatsappAutomationEnabled":true
   }'::jsonb);

-- ---------------------------------------------------------------------
-- views: the two derived values the prototype miscomputes (§3.2)
-- ---------------------------------------------------------------------

-- job.applicants is COUNTED, never stored — this is what stops the
-- counter drifting upward on every page refresh.
-- security_invoker is ESSENTIAL, not a nicety.
--
-- By default a view executes with the permissions of its OWNER, so a view
-- over an RLS-protected table hands every row to anyone who can select
-- from the view — silently bypassing every policy on `jobs`. With
-- security_invoker the view runs as the CALLER and RLS applies normally.
-- (Caught by test/api.test.mjs: draft jobs were visible to anonymous
-- users through this view while the table itself was correctly locked.)
create view jobs_with_counts with (security_invoker = true) as
select j.*,
       (select count(*) from applications a where a.job_id = j.id) as applicants,
       case
         when j.published_at is null then null
         else greatest(0, extract(day from (now() - j.published_at))::int)
       end as posted_days_ago
from jobs j;

-- the exact rule DATA.openJobs() applies, kept server-side so the
-- browser never re-implements it
create view jobs_open with (security_invoker = true) as
select * from jobs_with_counts
where status not in ('closed','draft')
  and not paused
  and not archived
  and (expires_at is null or expires_at > now());

-- ---------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------
create or replace function touch_updated_at() returns trigger
language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

do $$
declare t text;
begin
  foreach t in array array[
    'users','companies','recruiters','client_users','jobs','candidates',
    'applications','interviews','offers'
  ] loop
    execute format(
      'create trigger %I_touch before update on %I
       for each row execute function touch_updated_at()', t, t);
  end loop;
end $$;

-- record every stage change automatically (requirement 13 + 17)
create or replace function log_stage_change() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' and new.stage is distinct from old.stage then
    insert into application_stage_history (application_id, from_stage, to_stage)
    values (new.id, old.stage, new.stage);
  elsif tg_op = 'INSERT' then
    insert into application_stage_history (application_id, from_stage, to_stage)
    values (new.id, null, new.stage);
  end if;
  return new;
end $$;

create trigger applications_stage_log
  after insert or update of stage on applications
  for each row execute function log_stage_change();

-- ---------------------------------------------------------------------
-- optional: trigram indexes for fuzzy candidate/job search.
-- Supabase ships pg_trgm. If it is missing the migration still succeeds
-- and search degrades to ILIKE rather than failing to deploy.
-- ---------------------------------------------------------------------
do $$
begin
  create extension if not exists pg_trgm;
  execute 'create index if not exists jobs_title_trgm on jobs using gin (title gin_trgm_ops)';
  execute 'create index if not exists cand_name_trgm  on candidates using gin (name gin_trgm_ops)';
  raise notice 'pg_trgm indexes created';
exception when others then
  raise notice 'pg_trgm unavailable (%) - fuzzy search will use ILIKE', sqlerrm;
end $$;
