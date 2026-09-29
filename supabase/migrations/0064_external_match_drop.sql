-- ---------------------------------------------------------------------
-- 0064 — taking a match away again
--
-- 0049 grants `app_api` select and insert on candidate_external_job_matches
-- and nothing else: every write goes through a `security definer`
-- function, which is the right shape and was missing one function.
-- There was no way to REMOVE a match.
--
-- That mattered as soon as the matcher learned to refuse a score. A
-- German-language customer-service post with no skills, no stated role
-- and no location was scored 87% for a Python graduate under an older
-- rule - the number came almost entirely from the advert being ten days
-- old. The matcher now declines to score a posting that says too little,
-- but re-running it could only ADD and update rows, so the old 87% sat
-- at the top of that candidate's list and no amount of re-matching moved
-- it. The delete failed with "permission denied" and was swallowed.
--
-- Re-running the matching has to be able to take something away as well
-- as put something there.
-- ---------------------------------------------------------------------

create or replace function external_match_drop(
  p_candidate_id text,
  p_external_job_id text
) returns boolean
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  delete from candidate_external_job_matches
   where candidate_id = p_candidate_id
     and external_job_id = p_external_job_id;
  get diagnostics n = row_count;
  return n > 0;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant execute on function external_match_drop(text, text) to app_api;
  end if;
end $$;

comment on function external_match_drop(text, text) is
  'Removes one candidate/job match. Used when re-matching finds a score that can no longer be justified (0064).';
