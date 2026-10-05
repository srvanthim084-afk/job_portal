-- ---------------------------------------------------------------------
-- 0103 — Walk-in drives for signed-out visitors (and nothing else)
--
-- 0099 kept drives inside the candidate portal: the walkin_drives policy
-- has no branch for an anonymous caller, so a visitor who is not signed
-- in sees no drive at all. Drives are adverts for a public event, so the
-- public site now lists the upcoming and ongoing ones.
--
-- The policy is NOT relaxed. An anonymous branch on walkin_drives would
-- hand a signed-out caller every column of the row - the owner
-- (created_by_recruiter_id), the contact person's name and phone, the
-- linked job, the cancel reason - and leave it to each route to forget
-- none of them. Instead this one SECURITY DEFINER function is the whole
-- public surface, and the column list below is the decision, in one
-- auditable place:
--
--   shown     title, company name (the same name a public job card shows:
--             jobs.company_id -> companies.name, readable by anyone since
--             0002), role, description, date and times, venue, address,
--             city, map link, salary, experience, qualification, skills,
--             documents to carry, seats (max, and how many are taken)
--   NOT shown the contact person and phone (a signed-in candidate sees
--             them on the drive page; a public page would hand recruiters'
--             mobile numbers to scrapers), the recruiter who owns the
--             drive, the linked job id, version, cancel reason, any
--             registration or registrant
--
-- Only drives whose LIVE status (walkin_live_status, 0099) is UPCOMING or
-- ONGOING: a past, completed or cancelled drive is not public.
--
-- Admin screens need no database change: 0099 already gives an admin
-- every drive and registration, attendance updates, and
-- walkin_drive_registrations().
-- ---------------------------------------------------------------------

create or replace function walkin_public_drives(p_id text default null)
returns table (
  id                  text,
  title               text,
  company_name        text,
  job_role            text,
  description         text,
  drive_date          date,
  start_time          time,
  end_time            time,
  venue_name          text,
  full_address        text,
  city                text,
  map_link            text,
  salary_range        text,
  experience_required text,
  qualification       text,
  skills              text[],
  documents_to_carry  text[],
  max_seats           int,
  seats_taken         int,
  live_status         text
)
language sql stable security definer set search_path = public as $$
  select d.id, d.title, co.name, d.job_role, d.description, d.drive_date,
         d.start_time, d.end_time, d.venue_name, d.full_address, d.city, d.map_link,
         d.salary_range, d.experience_required, d.qualification, d.skills,
         d.documents_to_carry, d.max_seats,
         (select count(*)::int from walkin_registrations r
           where r.drive_id = d.id and r.status <> 'CANCELLED'),
         walkin_live_status(d.status, d.drive_date, d.start_time, d.end_time)
    from walkin_drives d
    left join companies co on co.id = d.company_id
   where (p_id is null or d.id = p_id)
     and walkin_live_status(d.status, d.drive_date, d.start_time, d.end_time) in ('UPCOMING','ONGOING')
$$;

comment on function walkin_public_drives(text) is
  'The public (signed-out) view of walk-in drives (0103): upcoming and ongoing only, public-safe columns only - no contact phone, owner, job link or registrations.';

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant execute on function walkin_public_drives(text) to app_api;
  end if;
end $$;
