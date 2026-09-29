-- ---------------------------------------------------------------------
-- 0084 — who exported whose details, and when
--
-- A resume export hands a recruiter a folder of other people's names,
-- phone numbers, addresses and CVs. That is the single largest movement
-- of personal data this product performs, and until now it left no trace
-- at all: nobody could answer "who downloaded the pool last Tuesday".
--
-- So every export writes a row here BEFORE the file is built. Before,
-- not after: an export that fails halfway has still read the data, and a
-- log that only records successes is a log that hides the interesting
-- case.
--
-- WHAT IS NOT STORED: the file, the rows, or the candidates' values. The
-- log answers who, when, how many and under which filters - enough to
-- investigate, and not a second copy of the thing being protected.
-- ---------------------------------------------------------------------
create table if not exists export_audit (
  id           bigserial primary key,
  actor_id     text,                    -- users.id, as text
  actor_role   text not null,
  actor_email  text,

  kind         text not null check (kind in ('list_csv','list_xlsx','resumes_zip')),
  scope        text not null check (scope in ('selected','filtered','page')),

  candidate_count int not null default 0,
  resume_count    int not null default 0,   -- how many actually had a file
  missing_count   int not null default 0,   -- and how many did not

  -- The filters as the screen had them, for "what was this a list OF".
  -- Values a recruiter typed, never candidate data.
  filters      jsonb not null default '{}'::jsonb,
  columns      text[] default '{}',

  ip           text,
  user_agent   text,
  created_at   timestamptz not null default now()
);

create index if not exists export_audit_actor on export_audit (actor_id, created_at desc);
create index if not exists export_audit_when  on export_audit (created_at desc);

alter table export_audit enable row level security;

/* Only an administrator reads the log. A recruiter cannot see who else
   exported what, and cannot see their own trail either - a trail you can
   read is a trail you will eventually be asked to edit. */
do $$
begin
  if not exists (select 1 from pg_policies
                  where tablename = 'export_audit' and policyname = 'export_audit_admin') then
    create policy export_audit_admin on export_audit for select
      using (app_is_admin());
  end if;
end $$;

/**
 * Write one line. A DEFINER function because the policy above grants no
 * INSERT to anybody: the log is written by the application, never by a
 * session, so it cannot be written selectively by the person being
 * logged.
 */
create or replace function export_audit_record(
  p_actor_id text, p_actor_role text, p_actor_email text,
  p_kind text, p_scope text,
  p_candidates int, p_resumes int, p_missing int,
  p_filters jsonb, p_columns text[],
  p_ip text, p_user_agent text
) returns bigint
language plpgsql security definer set search_path = public as $$
declare v_id bigint;
begin
  insert into export_audit
    (actor_id, actor_role, actor_email, kind, scope,
     candidate_count, resume_count, missing_count, filters, columns, ip, user_agent)
  values
    (p_actor_id, p_actor_role, p_actor_email, p_kind, p_scope,
     coalesce(p_candidates,0), coalesce(p_resumes,0), coalesce(p_missing,0),
     coalesce(p_filters,'{}'::jsonb), coalesce(p_columns,'{}'), p_ip,
     left(coalesce(p_user_agent,''), 400))
  returning id into v_id;
  return v_id;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant execute on function export_audit_record(
      text,text,text,text,text,int,int,int,jsonb,text[],text,text) to app_api;
    grant select on export_audit to app_api;
  end if;
end $$;

comment on table export_audit is
  'One row per export of candidate data. Written before the file is built, so a failed export is still recorded. Holds no candidate values.';
