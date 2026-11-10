-- ---------------------------------------------------------------------
-- 0165 — who said INTERESTED / NOT INTERESTED for which job role
--
-- A sourcing sheet carries the answer of each person to the call ("status 1", "status 2"). When it is imported FOR a job role, the answer
-- belongs to that role: interested people go to the ATS on that job, and the ones who said no stay in the Talent Pool but are on record as
-- "not interested in THAT role", so a recruiter can later filter "who told us no for this job" and not call them again for it.
--
-- One row per candidate and job; a later import overwrites the answer. Nobody is contacted by this table: it is only a record.
-- ---------------------------------------------------------------------

create table if not exists candidate_job_interest (
  candidate_id text not null references candidates(id) on delete cascade,
  job_id       text not null references jobs(id)       on delete cascade,
  interest     text not null check (interest in ('interested', 'not_interested')),
  -- the import that said so (candidate_imports.id), kept as text: an import row may be pruned, the answer should survive
  import_id    text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (candidate_id, job_id)
);

create index if not exists candidate_job_interest_job_idx
  on candidate_job_interest (job_id, interest);

alter table candidate_job_interest enable row level security;
alter table candidate_job_interest force  row level security;

-- Read: anybody who can see the candidate (RLS on `candidates` decides, so this widens nothing). Write: the server only (the import).
create policy cji_read on candidate_job_interest for select using (
  app_is_admin()
  or (app_role() in ('recruiter', 'bde') and exists (
        select 1 from candidates c where c.id = candidate_job_interest.candidate_id))
);
create policy cji_server_write on candidate_job_interest for all
  using (app_is_admin()) with check (app_is_admin());

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant select, insert, update, delete on candidate_job_interest to app_api;
  end if;
end $$;
