-- ---------------------------------------------------------------------
-- 0045 — a verifier can take its own candidate back out
--
-- The acceptance tests create a REAL candidate and a REAL application,
-- because a test that stubs those proves nothing about the thing it
-- claims to prove. They remove the requirement they raised, and they
-- could not remove the person: there is no route that deletes an
-- applicant, correctly, because an ATS where a recruiter can erase
-- somebody has no audit trail.
--
-- So one test candidate was left behind per run, in among the real ones,
-- and a recruiter opening their portal found "Screening Candidate
-- 1790224297436" sitting there looking exactly like somebody who had
-- applied. Clearing them by hand afterwards is not a fix - it is a thing
-- somebody has to remember, and they will not.
--
-- WHAT THIS CAN TOUCH, and it is deliberately almost nothing:
--
--   an ADMIN, and nobody else;
--   a candidate whose email is on a domain RFC 2606 and RFC 6761 RESERVE
--   for testing - .invalid, .test, example.com, example.org,
--   example.net. Those can never belong to a real person, because they
--   can never receive mail. Anything else is REFUSED, loudly, with the
--   address named.
--
-- It matches on the ADDRESS and never on the name. "Test" and "Demo" are
-- real surnames, and a rule that reads them as fixtures deletes a real
-- candidate on the day one applies.
-- ---------------------------------------------------------------------

create or replace function candidate_purge_test(p_candidate_id text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_email text;
  v_name  text;
  v_user  uuid;
  v_apps  int := 0;
begin
  if not app_is_admin() then
    raise exception 'only an administrator may remove a test candidate'
      using errcode = '42501';
  end if;

  select email, name, user_id into v_email, v_name, v_user
    from candidates where id = p_candidate_id;

  if v_email is null and v_name is null then
    return jsonb_build_object('removed', false, 'reason', 'no such candidate');
  end if;

  /*
   * The whole safety of this function is this condition.
   *
   * A reserved domain cannot receive mail, so nobody real can be behind
   * one. Everything else - including an address that merely looks like a
   * fixture - is somebody, and is refused.
   */
  if v_email is null or not (
       lower(v_email) like '%@%.invalid'
    or lower(v_email) like '%@%.test'
    or lower(v_email) like '%@example.com'
    or lower(v_email) like '%@example.org'
    or lower(v_email) like '%@example.net')
  then
    raise exception 'refusing to remove %: % is not a reserved test address',
      coalesce(v_name, p_candidate_id), coalesce(v_email, 'no address')
      using errcode = '42501';
  end if;

  select count(*)::int into v_apps from applications where candidate_id = p_candidate_id;

  delete from application_events
   where application_id in (select id from applications where candidate_id = p_candidate_id);
  delete from notification_deliveries
   where application_id in (select id from applications where candidate_id = p_candidate_id);
  delete from notifications where candidate_id = p_candidate_id;
  delete from applications where candidate_id = p_candidate_id;
  delete from candidates where id = p_candidate_id;

  -- The portal account it was given, found from the candidate's own row
  -- rather than by matching an address, and only ever a candidate login.
  if v_user is not null then
    delete from users where id = v_user and role = 'candidate';
  end if;

  return jsonb_build_object(
    'removed', true, 'email', v_email,
    'applications', v_apps, 'login', v_user is not null);
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant execute on function candidate_purge_test(text) to app_api;
  end if;
end $$;
