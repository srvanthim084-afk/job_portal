-- ---------------------------------------------------------------------
-- 0010 — the BDE role: profiles, what they may see, and what they push
--
-- A BDE (Business Development Executive) sources candidates and pushes
-- those records into the agency's ATS. That ATS is a SEPARATE PRODUCT and
-- is not part of this system, so nothing here writes to it. What this
-- migration provides is the role, the read access it needs to assemble a
-- complete candidate record, and an audit row for every push that leaves.
--
-- Read access is deliberately the recruiter's, no wider: every non-private
-- candidate, plus private ones already connected to the BDE's own company.
-- A BDE who could see private candidates at other agencies' companies
-- would be a way to export the whole pool.
--
-- Write access is deliberately none. A BDE does not edit candidates and
-- does not move anyone through the pipeline - they read and they export.
-- The only row a BDE creates is the export record itself.
-- ---------------------------------------------------------------------

create table if not exists bde_users (
  id         text primary key,          -- 'bde1'
  user_id    uuid unique references users(id) on delete cascade,
  name       text not null,
  email      text not null,
  company_id text references companies(id),
  title      text,
  initials   text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger bde_users_touch before update on bde_users
  for each row execute function touch_updated_at();

/* Every push that leaves this system, recorded before it is attempted.
   "Which candidates did we send to the ATS, when, by whom, and did it
   arrive" has to be answerable afterwards - an export is a disclosure of
   someone's personal data, and 'we think it went' is not an answer. */
create table if not exists ats_exports (
  id            text primary key,
  candidate_id  text not null references candidates(id) on delete cascade,
  application_id text references applications(id) on delete set null,
  job_id        text references jobs(id) on delete set null,
  exported_by   uuid references users(id),
  bde_id        text references bde_users(id),
  destination   text not null,          -- 'download' | provider name
  status        text not null default 'pending',
                                        -- pending | delivered | failed | not_configured
  detail        text,                   -- provider reference, or why it failed
  payload       jsonb,                  -- exactly what was sent
  created_at    timestamptz not null default now()
);
create index if not exists ats_exports_candidate_idx on ats_exports (candidate_id);
create index if not exists ats_exports_created_idx  on ats_exports (created_at desc);

-- ---------------------------------------------------------------------
-- helpers, matching the shape of the ones in 0002
-- ---------------------------------------------------------------------
create or replace function app_bde_id() returns text
language sql stable security definer set search_path = public as $$
  select id from bde_users where user_id = app_user_id()
$$;

create or replace function app_bde_company() returns text
language sql stable security definer set search_path = public as $$
  select company_id from bde_users where user_id = app_user_id()
$$;

-- ---------------------------------------------------------------------
-- row-level security
-- ---------------------------------------------------------------------
alter table bde_users  enable row level security;
alter table bde_users  force  row level security;
alter table ats_exports enable row level security;
alter table ats_exports force  row level security;

-- A BDE reads their own profile; an admin manages them.
create policy bde_self_read on bde_users for select using (
  app_is_admin() or user_id = app_user_id()
);
create policy bde_admin_write on bde_users for all
  using (app_is_admin()) with check (app_is_admin());

-- A BDE sees their own exports; an admin sees all of them.
create policy ats_exports_read on ats_exports for select using (
  app_is_admin() or exported_by = app_user_id()
);
create policy ats_exports_insert on ats_exports for insert with check (
  app_role() = 'bde' and exported_by = app_user_id()
);
create policy ats_exports_update on ats_exports for update
  using (app_role() = 'bde' and exported_by = app_user_id())
  with check (app_role() = 'bde' and exported_by = app_user_id());

-- ---------------------------------------------------------------------
-- what a BDE can read
--
-- Each of these EXTENDS an existing policy rather than replacing it. The
-- recruiter, client and candidate branches in 0002 are untouched; a new
-- permissive policy simply adds the BDE branch, so nothing already proven
-- about the other roles changes.
-- ---------------------------------------------------------------------
create policy candidates_read_bde on candidates for select using (
  app_role() = 'bde' and (
    not is_private
    or app_candidate_at_company(candidates.id, app_bde_company()))
);

create policy jobs_read_bde on jobs for select using (
  app_role() = 'bde' and status <> 'draft'
);

create policy applications_read_bde on applications for select using (
  app_role() = 'bde'
);

create policy stage_history_read_bde on application_stage_history for select using (
  app_role() = 'bde'
);

/* The AI interview score is the reason a BDE is looking at all - it is
   what they are pushing into the ATS. Requirement: the score is visible to
   the candidate, the recruiter, the client AND the BDE. */
create policy ai_interviews_read_bde on ai_interviews for select using (
  app_role() = 'bde'
);

create policy ai_answers_read_bde on ai_interview_answers for select using (
  app_role() = 'bde'
);

create policy interviews_read_bde on interviews for select using (
  app_role() = 'bde'
);

create policy notifications_read_bde on notifications for select using (
  app_role() = 'bde' and recipient_role = 'bde' and recipient_id = app_bde_id()
);

-- ---------------------------------------------------------------------
-- grants
--
-- RLS decides WHICH rows; the grant decides whether the role may touch the
-- table at all. Both are needed - a policy that permits a read on a table
-- the role has no SELECT on still fails, which is a confusing way to find
-- out (see 0007).
-- ---------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant select on bde_users to app_api;
    grant insert, update on bde_users to app_api;     -- admin-managed, RLS-gated
    grant select, insert, update on ats_exports to app_api;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- the session resolver has to know about the new profile table
--
-- Without this a BDE signs in successfully and arrives with profile_id
-- null, which reads downstream as "signed in as nobody": the dashboard
-- cannot find their record and every scoped query returns nothing.
-- ---------------------------------------------------------------------
create or replace function auth_resolve_session(p_token_hash text)
returns table (user_id uuid, role user_role, status text, profile_id text)
language sql security definer set search_path = public as $$
  select u.id, u.role, u.status,
         coalesce(c.id, r.id, cl.id, a.id, b.id) as profile_id
  from sessions s
  join users u on u.id = s.user_id
  left join candidates   c  on c.user_id  = u.id
  left join recruiters   r  on r.user_id  = u.id
  left join client_users cl on cl.user_id = u.id
  left join admins       a  on a.user_id  = u.id
  left join bde_users    b  on b.user_id  = u.id
  where s.token_hash = p_token_hash
    and s.expires_at > now()
    and u.status = 'active'
  limit 1
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant execute on function app_bde_id(), app_bde_company() to app_api;
    grant execute on function auth_resolve_session(text) to app_api;
  end if;
end $$;
