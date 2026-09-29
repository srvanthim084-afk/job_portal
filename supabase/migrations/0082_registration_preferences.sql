-- ---------------------------------------------------------------------
-- 0082 — the four preferences a registration may not be without
--
-- The registration form marks Preferred Job Location, Expected Salary,
-- Notice Period and Preferred Work Mode as required. The route now
-- refuses a registration that omits any of them, and writes them onto
-- the record it has just created.
--
-- A DEFINER FUNCTION, because that write happens on the ANONYMOUS
-- connection - the candidate has no session yet; they are being created.
-- A direct UPDATE there matches no row-level policy, affects zero rows
-- and RAISES NOTHING, which is the failure this codebase has produced
-- five times and each time silently. `auth_register_candidate` (0004)
-- exists for exactly this reason; this is its companion.
--
-- IT ONLY EVER WRITES TO A ROW THAT HAS JUST BEEN CREATED. The route
-- passes the id it generated a moment earlier, and the function refuses
-- to touch a candidate that already has any of these set - so it cannot
-- be used to overwrite a real profile's preferences from outside a
-- session.
-- ---------------------------------------------------------------------
create or replace function auth_register_preferences(
  p_candidate_id  text,
  p_location      text,
  p_expected_ctc  numeric,
  p_notice        text,
  p_work_modes    text[]
) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_touched boolean := false;
begin
  update candidates
     set preferred_location   = nullif(btrim(p_location), ''),
         expected_ctc         = p_expected_ctc,
         notice_period        = nullif(btrim(p_notice), ''),
         preferred_work_modes = coalesce(p_work_modes, '{}'),
         updated_at           = now()
   where id = p_candidate_id
     /* Only a record that has not answered these yet. A registration
        writes them once; changing them afterwards goes through the
        profile route, signed in, under the policies. */
     and coalesce(preferred_location, '') = ''
     and expected_ctc is null
     and coalesce(notice_period, '') = ''
     and coalesce(array_length(preferred_work_modes, 1), 0) = 0;

  get diagnostics v_touched = row_count;
  return v_touched;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant execute on function
      auth_register_preferences(text, text, numeric, text, text[]) to app_api;
  end if;
end $$;

comment on function auth_register_preferences(text, text, numeric, text, text[]) is
  'Writes the four required preferences onto a candidate created moments earlier, on the anonymous connection where the registration happens. Returns false if the record already had them, which the route treats as "somebody else got there first", not as an error.';
