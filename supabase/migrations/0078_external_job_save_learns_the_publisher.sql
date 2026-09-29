-- ---------------------------------------------------------------------
-- 0078 — the writer never learned about the columns
--
-- 0067 added `original_publisher`, `city`, `state`, `country` and
-- `last_seen_at` to `external_jobs`, for a good reason: an aggregator
-- hands back somebody else's advert, and the board it actually lives on
-- is both the licence condition for showing it and the only way a
-- candidate can tell where the Apply button will land.
--
-- The single function that writes a job, `external_job_save`, was
-- written in 0049 and takes twenty-three parameters. It was never
-- extended. So every connector has been carefully working out the
-- publisher and handing it over, and every one of those values has been
-- dropped on the floor - measured: 140 live jobs, 140 with no publisher.
--
-- It matters more now than it did: the "Did you apply?" prompt says
-- "via {publisher}", and with nothing there it says nothing.
--
-- The old signature is DROPPED rather than left beside the new one. An
-- overload that silently discards five columns is the trap this is
-- fixing, and leaving it in place leaves the trap.
-- ---------------------------------------------------------------------
drop function if exists external_job_save(
  text, text, text, text, text, text, text, text[], text, numeric, numeric,
  text, numeric, numeric, text, text, text, text, text, timestamptz, text, text, jsonb);

create or replace function external_job_save(
  p_id text, p_source_id text, p_external_job_id text,
  p_title text, p_company text, p_location text, p_description text,
  p_skills text[], p_experience text, p_exp_min numeric, p_exp_max numeric,
  p_salary text, p_salary_min numeric, p_salary_max numeric,
  p_employment_type text, p_industry text, p_education text,
  p_application_url text, p_apply_email text,
  p_posted_at timestamptz, p_status text, p_dedupe_key text, p_raw jsonb,
  -- 0067, at last
  p_original_publisher text default null,
  p_city text default null, p_state text default null, p_country text default null
) returns external_jobs
language plpgsql security definer set search_path = public as $$
declare out_row external_jobs;
begin
  insert into external_jobs (
      id, source_id, external_job_id, title, company, location, description,
      skills, experience, exp_min, exp_max, salary, salary_min, salary_max,
      employment_type, industry, education, application_url, apply_email,
      posted_at, synced_at, status, dedupe_key, raw,
      original_publisher, city, state, country, last_seen_at)
    values (
      p_id, p_source_id, p_external_job_id, p_title, p_company, p_location, p_description,
      coalesce(p_skills, '{}'), p_experience, p_exp_min, p_exp_max,
      p_salary, p_salary_min, p_salary_max,
      p_employment_type, p_industry, p_education, p_application_url, p_apply_email,
      p_posted_at, now(), coalesce(p_status, 'open'), p_dedupe_key, coalesce(p_raw, '{}'),
      p_original_publisher, p_city, p_state, p_country, now())
  on conflict (source_id, external_job_id) do update set
      title = excluded.title,
      company = excluded.company,
      location = excluded.location,
      description = excluded.description,
      skills = excluded.skills,
      experience = excluded.experience,
      exp_min = excluded.exp_min,
      exp_max = excluded.exp_max,
      salary = excluded.salary,
      salary_min = excluded.salary_min,
      salary_max = excluded.salary_max,
      employment_type = excluded.employment_type,
      industry = excluded.industry,
      education = excluded.education,
      application_url = excluded.application_url,
      apply_email = excluded.apply_email,
      posted_at = excluded.posted_at,
      synced_at = now(),
      status = excluded.status,
      dedupe_key = excluded.dedupe_key,
      raw = excluded.raw,
      /* A re-sync that cannot see the publisher must not erase one we
         already had - some sources state it and some do not, and the
         same vacancy can arrive through both. */
      original_publisher = coalesce(excluded.original_publisher,
                                    external_jobs.original_publisher),
      city    = coalesce(excluded.city,    external_jobs.city),
      state   = coalesce(excluded.state,   external_jobs.state),
      country = coalesce(excluded.country, external_jobs.country),
      last_seen_at = now(),
      updated_at = now()
  returning * into out_row;
  return out_row;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant execute on function external_job_save(
      text, text, text, text, text, text, text, text[], text, numeric, numeric,
      text, numeric, numeric, text, text, text, text, text, timestamptz, text, text, jsonb,
      text, text, text, text) to app_api;
  end if;
end $$;
