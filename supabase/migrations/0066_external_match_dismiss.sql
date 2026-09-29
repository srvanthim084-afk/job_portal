-- ---------------------------------------------------------------------
-- 0066 — "not interested", from the candidate's own session
--
-- 0062 added `dismissed_at` and 0064 added a way to DELETE a match, but
-- dismissing is done by the CANDIDATE, and a candidate cannot write to
-- this table at all: `cejm_no_direct_write` from 0049 permits only an
-- administrator, and `app_api` holds select and insert and nothing else.
--
-- So the update affected zero rows and raised nothing - row-level
-- security does not raise, it simply matches no rows - and the endpoint
-- cheerfully answered `{ dismissed: false }` while the card stayed on
-- screen. The same shape of bug as the stale match in 0064, found the
-- same way: by looking at what the database actually did rather than at
-- what the code said.
--
-- SECURITY DEFINER, with the ownership check INSIDE it. A definer
-- function sees every row, so `p_candidate_id` is matched in the WHERE
-- clause: the route has already forced a candidate to their own id, and
-- this makes the function safe even if that ever changed.
-- ---------------------------------------------------------------------

create or replace function external_match_dismiss(
  p_candidate_id text,
  p_external_job_id text
) returns boolean
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update candidate_external_job_matches
     set dismissed_at = now(), updated_at = now()
   where candidate_id = p_candidate_id
     and external_job_id = p_external_job_id
     and dismissed_at is null;
  get diagnostics n = row_count;
  return n > 0;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant execute on function external_match_dismiss(text, text) to app_api;
  end if;
end $$;

comment on function external_match_dismiss(text, text) is
  'A candidate hides one external job match. Ownership is checked in the WHERE clause because a definer function sees every row (0066).';
