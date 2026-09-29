-- ---------------------------------------------------------------------
-- 0073 — the views could not see 0072's columns
--
-- `jobs_with_counts` is defined as `select j.*, …` and `j.*` is expanded
-- ONCE, when the view is created. It was created in 0001, so its column
-- list is the one `jobs` had then. Adding `gender` and `accommodation`
-- to the table in 0072 therefore did nothing for anybody reading through
-- the view - which is every read in the jobs API.
--
-- Measured: a job created with gender 'Female' and accommodation true
-- came back with gender undefined and accommodation false, from the list
-- and from the detail alike. The row in `jobs` was correct all along; the
-- view in front of it was not showing those columns.
--
-- `create or replace view` cannot fix this on its own - it may only
-- APPEND columns, and appending `gender` after `posted_days_ago` would
-- leave the same trap for the next person to add a column. So both views
-- are dropped and recreated with the same bodies, which re-expands `j.*`
-- and means any column added to `jobs` in future appears without a
-- migration like this one.
--
-- `jobs_open` is dropped first because it reads from the other.
--
-- NOTHING ELSE CHANGES. Same names, same definitions, same
-- security_invoker setting, so row level security still applies as the
-- calling user rather than the view's owner.
-- ---------------------------------------------------------------------
drop view if exists jobs_open;
drop view if exists jobs_with_counts;

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

/* 0004 granted on "all tables in schema public" as it stood then; a view
   created now has none of that, so it is granted explicitly. */
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant select on jobs_with_counts, jobs_open to app_api;
  end if;
end $$;
