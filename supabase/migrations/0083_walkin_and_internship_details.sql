-- ---------------------------------------------------------------------
-- 0083 — the facts a walk-in and an internship are, as columns
--
-- Both posting types have existed since 0001 (`posting_kind` is already
-- 'job | walkin | internship'), but everything that MAKES them one lived
-- only in the browser: the walk-in's date, time, venue and - until now -
-- nothing at all for who to ask for at the gate; the internship's
-- duration, type and stipend. They were written into the generated
-- description and then lost, so:
--
--   - a recruiter editing a walk-in could not see its date,
--   - nothing could list "walk-ins this week",
--   - and a reload showed a walk-in advert with no walk-in in it.
--
-- Columns, therefore, not a JSON blob: these are asked for on a form,
-- shown on a card and will be filtered on. All nullable, so every one of
-- the 25 existing postings stays exactly as it is.
--
-- WHO TO ASK FOR IS NEW. A walk-in advert that gives an address and no
-- name sends somebody to a reception desk that has never heard of the
-- role, which is a wasted morning and a bus fare.
-- ---------------------------------------------------------------------
alter table jobs add column if not exists walkin_date    text;
alter table jobs add column if not exists walkin_from    text;
alter table jobs add column if not exists walkin_to      text;
alter table jobs add column if not exists walkin_venue   text;
alter table jobs add column if not exists walkin_contact text;
alter table jobs add column if not exists walkin_phone   text;

alter table jobs add column if not exists internship_duration text;
alter table jobs add column if not exists internship_type     text;
alter table jobs add column if not exists stipend             numeric;

comment on column jobs.walkin_contact is
  'Who a candidate asks for on arrival. Shown on the advert beside the venue.';
comment on column jobs.internship_type is
  'Paid or Unpaid, as the recruiter stated it. Stipend is only meaningful when Paid.';

/*
 * THE VIEWS EXPAND `select j.*` ONCE, AT CREATION.
 *
 * 0073 had to drop and recreate these for exactly this reason: adding a
 * column to `jobs` does not make it appear in a view that was created
 * with a star before the column existed. A `create or replace view` can
 * only APPEND columns, so the pair is dropped and rebuilt.
 */
drop view if exists jobs_open;
drop view if exists jobs_with_counts;

create view jobs_with_counts with (security_invoker = true) as
select j.*,
       (select count(*) from applications a where a.job_id = j.id)::int as applicants,
       case when j.published_at is null then null
            else greatest(0, (extract(epoch from (now() - j.published_at)) / 86400)::int)
       end as posted_days_ago
  from jobs j;

create view jobs_open with (security_invoker = true) as
select * from jobs_with_counts
where status not in ('closed','draft')
  and not paused
  and not archived
  and (expires_at is null or expires_at > now());

comment on view jobs_open is
  'What a candidate may see: Active postings only. "Active" on the posting forms is this view''s rule, not a second flag.';
