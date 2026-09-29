-- ---------------------------------------------------------------------
-- 0057 — a recruiter enters a candidate by hand
--
-- Until now a candidate row could arrive three ways: the person
-- registered, a job-board email was parsed, or a spreadsheet was
-- imported. There was no way for a recruiter sitting with a CV and a
-- phone call to type one in. "+ Add Candidate" on the talent pool
-- called a function that did not exist and fell through to a toast.
--
-- A manual entry form knows things none of the other three routes do -
-- the recruiter was on the call. Date of birth, an alternate number,
-- why they are looking, whether they will relocate and where, which
-- shift they want, who referred them. Those have nowhere to go today,
-- so they go here.
--
-- WHAT THIS DOES NOT DO. It adds columns and three child tables; it
-- changes no existing column, no existing policy, and no existing row.
-- Every column is nullable or defaulted, so every candidate already in
-- the database stays exactly as valid as it was.
--
-- THE CHILD TABLES EXIST BECAUSE THE FORM IS REPEATABLE. `education` on
-- `candidates` is one free-text line and stays that way - it is what the
-- resume page prints and what the parser writes. A recruiter entering
-- three qualifications and four previous employers needs rows, not a
-- longer string, and a recruiter searching "B.Sc Nursing, 2019" needs
-- them to be columns.
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- the candidate, as the person on the phone described themselves
-- ---------------------------------------------------------------------
alter table candidates
  -- identity
  add column if not exists date_of_birth   date,
  add column if not exists alt_phone       text,
  add column if not exists alt_email       text,
  add column if not exists state           text,
  add column if not exists district        text,
  add column if not exists address         text,
  add column if not exists pincode         text,
  add column if not exists nationality     text,
  add column if not exists photo_file      text,
  add column if not exists photo_storage_path text,
  add column if not exists photo_mime      text,

  -- career, beyond what a CV states
  add column if not exists relevant_exp_years numeric,
  add column if not exists employment_type text,
  add column if not exists available_from  date,
  add column if not exists immediate_joiner boolean not null default false,
  add column if not exists job_status      text,
  add column if not exists job_change_reason text,
  add column if not exists preferred_shift text,
  add column if not exists willing_to_relocate boolean,
  add column if not exists relocation_location text,

  -- skills the existing arrays do not cover
  add column if not exists soft_skills     text[] default '{}',
  add column if not exists tools           text[] default '{}',

  -- how this person reached us
  add column if not exists source          text,
  add column if not exists source_details  text,
  add column if not exists hiring_type     text,
  add column if not exists priority        text,
  add column if not exists availability    text,
  add column if not exists candidate_reference text,
  add column if not exists referred_by     text,
  add column if not exists assigned_recruiter_id text
    references recruiters(id) on delete set null,

  -- the documents, described
  add column if not exists resume_version  text,
  add column if not exists resume_source   text,
  add column if not exists cover_letter    text,

  -- how they agreed to be contacted. whatsapp_opt_in and do_not_contact
  -- already exist and are NOT redefined here; these are the two channels
  -- that had no flag of their own.
  add column if not exists email_opt_in    boolean not null default true,
  add column if not exists sms_opt_in      boolean not null default true,
  add column if not exists preferred_contact_method text,

  -- what the recruiter wrote down
  add column if not exists candidate_notes text,
  add column if not exists recruiter_notes text,
  add column if not exists internal_remarks text,
  add column if not exists tags            text[] default '{}',

  -- who typed it in, so a hand-entered row is distinguishable from a
  -- parsed one without guessing from which fields happen to be filled
  add column if not exists entry_method    text,
  add column if not exists created_by      uuid references users(id);

create index if not exists cand_source_idx   on candidates (source);
create index if not exists cand_tags_gin     on candidates using gin (tags);
create index if not exists cand_alt_phone_idx on candidates (alt_phone);

-- ---------------------------------------------------------------------
-- education, one row per qualification
-- ---------------------------------------------------------------------
create table if not exists candidate_education (
  id             bigserial primary key,
  candidate_id   text not null references candidates(id) on delete cascade,
  qualification  text,
  specialization text,
  institution    text,
  passing_year   int,
  score          text,                  -- "72%" and "8.1 CGPA" are both this
  education_type text,                  -- full-time | part-time | distance | online
  sort_order     int not null default 0,
  created_at     timestamptz not null default now()
);
create index if not exists cedu_by_candidate
  on candidate_education (candidate_id, sort_order);

-- ---------------------------------------------------------------------
-- previous employment, one row per employer
--
-- `previous_companies` on `candidates` is an array of names and stays
-- untouched - the matcher and the search read it. This is the detail
-- behind those names.
-- ---------------------------------------------------------------------
create table if not exists candidate_experience (
  id               bigserial primary key,
  candidate_id     text not null references candidates(id) on delete cascade,
  company          text,
  job_title        text,
  start_date       date,
  end_date         date,
  currently_working boolean not null default false,
  location         text,
  employment_type  text,
  responsibilities text,
  leaving_reason   text,
  sort_order       int not null default 0,
  created_at       timestamptz not null default now()
);
create index if not exists cexp_by_candidate
  on candidate_experience (candidate_id, sort_order);

-- ---------------------------------------------------------------------
-- documents other than the resume
--
-- The resume keeps its own columns on `candidates` because everything
-- from the parser to the screening reads them by name. This is for the
-- cover letter, the offer letter, the payslip and the degree
-- certificate - files with no column of their own.
-- ---------------------------------------------------------------------
create table if not exists candidate_documents (
  id           bigserial primary key,
  candidate_id text not null references candidates(id) on delete cascade,
  kind         text,                    -- 'cover_letter' | 'certificate' | 'other'
  file_name    text not null,
  storage_path text not null,
  mime         text,
  size         bigint,
  uploaded_by  uuid references users(id),
  created_at   timestamptz not null default now()
);
create index if not exists cdoc_by_candidate
  on candidate_documents (candidate_id, created_at desc);

-- ---------------------------------------------------------------------
-- who may read and write the three tables
--
-- Exactly the rule `candidates` already applies, expressed by joining
-- back to it: if RLS lets you see the candidate, you see their
-- education, their employment and their documents. Nothing here widens
-- what anybody can see, and a candidate can read their own.
-- ---------------------------------------------------------------------
alter table candidate_education enable row level security;
alter table candidate_education force  row level security;
create policy cedu_read on candidate_education for select
  using (exists (select 1 from candidates c where c.id = candidate_education.candidate_id));
create policy cedu_write on candidate_education for all
  using      (app_is_admin() or app_role() = 'recruiter'
              or candidate_id = app_candidate_id())
  with check (app_is_admin() or app_role() = 'recruiter'
              or candidate_id = app_candidate_id());

alter table candidate_experience enable row level security;
alter table candidate_experience force  row level security;
create policy cexp_read on candidate_experience for select
  using (exists (select 1 from candidates c where c.id = candidate_experience.candidate_id));
create policy cexp_write on candidate_experience for all
  using      (app_is_admin() or app_role() = 'recruiter'
              or candidate_id = app_candidate_id())
  with check (app_is_admin() or app_role() = 'recruiter'
              or candidate_id = app_candidate_id());

alter table candidate_documents enable row level security;
alter table candidate_documents force  row level security;
create policy cdoc_read on candidate_documents for select
  using (exists (select 1 from candidates c where c.id = candidate_documents.candidate_id));
create policy cdoc_write on candidate_documents for all
  using      (app_is_admin() or app_role() = 'recruiter'
              or candidate_id = app_candidate_id())
  with check (app_is_admin() or app_role() = 'recruiter'
              or candidate_id = app_candidate_id());

grant select, insert, update, delete on candidate_education  to app_api;
grant select, insert, update, delete on candidate_experience to app_api;
grant select, insert, update, delete on candidate_documents  to app_api;
grant usage, select on sequence candidate_education_id_seq  to app_api;
grant usage, select on sequence candidate_experience_id_seq to app_api;
grant usage, select on sequence candidate_documents_id_seq  to app_api;

-- ---------------------------------------------------------------------
-- the duplicate check does NOT live here, and that is deliberate
--
-- RLS hides a candidate owned by a different recruiter, which is right
-- for reading and useless for "does this mobile already exist?". Asked
-- under the recruiter's own rights the answer is "no" for everybody
-- else's candidate, and a second record gets created - the silent
-- duplicate the brief forbids.
--
-- A `security definer` function looked like the fix and is not: the
-- policies on `candidates` test session settings (app.role,
-- app.recruiter_id) rather than the database role, and those settings
-- belong to the CALLER's session whoever the function runs as. Changing
-- the role changes nothing.
--
-- So the lookup is done in the route against the admin session this
-- codebase already uses for exactly this (`ENGINE` in
-- api/src/routes/candidates.js), and what comes back is then filtered
-- against what the caller may actually read. A row they may not read is
-- reported as taken, with no name, no address and no number - enough to
-- stop a duplicate, not enough to learn anything about somebody else's
-- candidate.
-- ---------------------------------------------------------------------
