-- =====================================================================
-- 0130  Apply Now: the applied date is a fact, and it can be filtered on
--
--   applications.applied_at is the moment the application was made. It
--   is stored in UTC (timestamptz) and shown in IST everywhere. Nobody
--   edits it: not the candidate, not a recruiter, not an admin through
--   the API. Every screen, export, email and filter reads this one value.
--
--   1. FROZEN. An UPDATE made by the application's own unprivileged role
--      (app_api - api/src/db.js refuses to run as anything else) keeps
--      the old applied_at and applied_on whatever the statement says.
--      Maintenance SQL run by a superuser (migrations, a data repair, the
--      test harness's raw connection) is untouched, so a correction stays
--      possible - and is a deliberate act by an administrator of the
--      database, never a button in the product.
--
--   2. FILTERABLE. "Applied Date" ranges are India days, so the range
--      query is `applied_at >= from 00:00 IST and < (to + 1) 00:00 IST`.
--      An index on applied_at serves it and the newest-first sort.
--
--   3. RECRUITER NOTICE. The "<candidate> applied for <job>" notification
--      is written by POST /applications in the same transaction as the
--      application (and goes with it on Undo: notifications cascade).
--      Nothing to add to the schema for it.
-- =====================================================================

create index if not exists applications_applied_at_idx on applications (applied_at desc);

create or replace function applications_applied_at_frozen() returns trigger
language plpgsql as $$
begin
  if not exists (select 1 from pg_roles where rolname = current_user and rolsuper) then
    new.applied_at := old.applied_at;
    new.applied_on := old.applied_on;
  end if;
  return new;
end $$;

drop trigger if exists applications_applied_at_frozen on applications;
create trigger applications_applied_at_frozen
  before update of applied_at, applied_on on applications
  for each row execute function applications_applied_at_frozen();

comment on column applications.applied_at is
  'When the application was made (UTC). Shown in IST. Frozen for API sessions (0130).';
