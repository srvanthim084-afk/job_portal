-- ---------------------------------------------------------------------
-- 0074 — remembering that we already asked
--
-- A candidate added from the Talent Pool is emailed a login, signs in,
-- chooses a password, and lands on a profile that is ten per cent filled
-- in with no indication of what to do about it. The portal then asks
-- them to complete it, which is right - but asking on EVERY sign-in,
-- forever, is nagging, and nagging is how a prompt gets ignored.
--
-- So the two facts that decide whether to ask again live on the
-- candidate, not in the browser:
--
--   how many times they have said "later"
--   when they last said it
--
-- ON THE RECORD RATHER THAN IN localStorage, because a candidate who
-- says "later" on their phone and then opens the portal on a borrowed
-- laptop has still said "later". Browser storage would ask them again on
-- every device they own, which reads as the portal not listening.
--
-- NOTHING IS BLOCKED BY THIS. The count only decides between a modal and
-- a quiet banner; the candidate reaches the portal either way.
-- ---------------------------------------------------------------------
alter table candidates
  add column if not exists profile_onboarding_later_count int not null default 0,
  add column if not exists profile_onboarding_dismissed_at timestamptz;

-- ---------------------------------------------------------------------
-- saying "later"
--
-- A definer function for the same reason as everything else that writes
-- as the candidate: `candidates` is behind row level security and a
-- direct UPDATE that matches no policy affects zero rows WITHOUT
-- raising - which would leave the count stuck at zero and the modal
-- appearing for ever, with nothing in any log to say why. Learnt in
-- 0064, 0066 and again in 0070.
--
-- Returns the new count so the screen can decide what to show next
-- without a second round trip.
-- ---------------------------------------------------------------------
create or replace function candidate_onboarding_later(p_candidate_id text)
returns int
language plpgsql security definer set search_path = public as $$
declare v_count int;
begin
  update candidates
     set profile_onboarding_later_count = coalesce(profile_onboarding_later_count, 0) + 1,
         profile_onboarding_dismissed_at = now(),
         updated_at = now()
   where id = p_candidate_id
  returning profile_onboarding_later_count into v_count;

  /* No such candidate. -1 rather than null, so a caller that forgets to
     check still gets something that fails a "> 0" test rather than
     silently comparing null. */
  if v_count is null then return -1; end if;
  return v_count;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant execute on function candidate_onboarding_later(text) to app_api;
  end if;
end $$;
