-- ---------------------------------------------------------------------
-- 0080 — education and work history, after the row already exists
--
-- `candidate_education` and `candidate_experience` (0057) are written
-- once, by the create route, and never again. A candidate reviewing what
-- was read out of their CV has nowhere to put the corrections: the only
-- update endpoint takes the flat columns.
--
-- REPLACE, NOT MERGE. The candidate is looking at the whole list and
-- pressing Save; what is on the screen is what they mean to have. Trying
-- to match rows up would mean guessing which of two similar jobs they
-- edited, and guessing wrong silently duplicates one of them.
--
-- A DEFINER FUNCTION, like every other write in this schema: both tables
-- are behind row level security, and an INSERT or DELETE that matches no
-- policy affects zero rows WITHOUT raising - the failure this codebase
-- has now produced four times, each one silent.
-- ---------------------------------------------------------------------
create or replace function candidate_records_replace(
  p_candidate_id text, p_education jsonb, p_experience jsonb
) returns void
language plpgsql security definer set search_path = public as $$
declare v_employers text[];
begin
  if not exists (select 1 from candidates where id = p_candidate_id) then
    return;
  end if;

  /* Null means "leave this one alone" - a caller sending only education
     must not wipe the work history. An empty array means "there are
     none", which is a different statement and is honoured. */
  if p_education is not null then
    delete from candidate_education where candidate_id = p_candidate_id;

    insert into candidate_education
      (candidate_id, qualification, specialization, institution,
       passing_year, score, education_type, sort_order)
    select p_candidate_id,
           nullif(btrim(e->>'qualification'), ''),
           nullif(btrim(e->>'specialization'), ''),
           nullif(btrim(e->>'institution'), ''),
           /* A year that is not a year is left null rather than
              rejected: the rest of the row is still worth keeping. */
           case when (e->>'passingYear') ~ '^\d{4}$'
                then (e->>'passingYear')::int else null end,
           nullif(btrim(e->>'score'), ''),
           nullif(btrim(e->>'educationType'), ''),
           ord - 1
      from jsonb_array_elements(p_education) with ordinality as t(e, ord)
     where coalesce(btrim(e->>'qualification'), '') <> ''
        or coalesce(btrim(e->>'institution'), '') <> '';
  end if;

  if p_experience is not null then
    delete from candidate_experience where candidate_id = p_candidate_id;

    insert into candidate_experience
      (candidate_id, company, job_title, location, employment_type,
       responsibilities, sort_order)
    select p_candidate_id,
           nullif(btrim(x->>'company'), ''),
           nullif(btrim(x->>'jobTitle'), ''),
           nullif(btrim(x->>'location'), ''),
           nullif(btrim(x->>'employmentType'), ''),
           nullif(btrim(x->>'responsibilities'), ''),
           ord - 1
      from jsonb_array_elements(p_experience) with ordinality as t(x, ord)
     where coalesce(btrim(x->>'company'), '') <> ''
        or coalesce(btrim(x->>'jobTitle'), '') <> '';

    /*
     * THE EMPLOYER NAMES GO ON THE CANDIDATE TOO.
     *
     * `previous_companies` is what the search and the matcher read; the
     * detail lives in the rows above and this is the index. The create
     * route already does this, and an update that did not would leave a
     * candidate searchable by an employer they had just removed.
     */
    select array_agg(distinct company) into v_employers
      from candidate_experience
     where candidate_id = p_candidate_id and company is not null;

    update candidates
       set previous_companies = coalesce(v_employers, '{}'),
           updated_at = now()
     where id = p_candidate_id;
  end if;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant execute on function candidate_records_replace(text, jsonb, jsonb) to app_api;
  end if;
end $$;
