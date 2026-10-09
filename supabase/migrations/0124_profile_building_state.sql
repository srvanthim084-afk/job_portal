-- ---------------------------------------------------------------------
-- 0124 - "Build your profile": where the candidate is, on the server
--
-- 0074 remembered only HOW MANY TIMES a candidate had said "later". The
-- profile-building wizard needs more than a count:
--
--   status   not_started | in_progress | skipped | completed
--   step     the step they were on (0-based), so a refresh - or a sign-in
--            on another device - reopens the wizard where they left it
--   draft    what they had typed and confirmed so far (the working copy
--            of the profile), so nothing is lost between visits and
--            NOTHING reaches the profile columns until they finish
--
-- ON THE RECORD, NOT IN THE BROWSER: the same reason as 0074. A candidate
-- who stops on a phone and continues on a laptop is continuing.
--
-- The draft is the candidate's own working copy. It is never read by a
-- recruiter, never searched, and is cleared when the profile is saved.
--
-- DDL first, backfill last: an UPDATE on `candidates` queues trigger
-- events, and DDL on the same table after it fails with "pending trigger
-- events" (learnt in 0120).
-- ---------------------------------------------------------------------
alter table candidates
  add column if not exists onboarding_status text not null default 'not_started',
  add column if not exists onboarding_step int not null default 0,
  add column if not exists onboarding_draft jsonb,
  add column if not exists onboarding_updated_at timestamptz,
  add column if not exists onboarding_completed_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'candidates_onboarding_status_chk') then
    alter table candidates add constraint candidates_onboarding_status_chk
      check (onboarding_status in ('not_started', 'in_progress', 'skipped', 'completed'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'candidates_onboarding_step_chk') then
    alter table candidates add constraint candidates_onboarding_step_chk
      check (onboarding_step between 0 and 10);
  end if;
end $$;

-- ---------------------------------------------------------------------
-- reading it
-- ---------------------------------------------------------------------
create or replace function candidate_onboarding_get(p_candidate_id text)
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
           'status', onboarding_status,
           'step', onboarding_step,
           'draft', onboarding_draft,
           'laterCount', coalesce(profile_onboarding_later_count, 0),
           'completedAt', onboarding_completed_at,
           'updatedAt', onboarding_updated_at)
    from candidates where id = p_candidate_id;
$$;

-- ---------------------------------------------------------------------
-- writing it
--
-- p_status NULL keeps the status; a COMPLETED profile is never moved back
-- to in_progress / skipped by a stale tab (p_restart = true is the
-- candidate choosing to rebuild it). The draft is replaced when given and
-- cleared when p_clear_draft. Returns the state as candidate_onboarding_get.
--
-- A definer function for the reason in 0074: `candidates` is behind row
-- level security and a blocked UPDATE affects zero rows without an error.
-- The ROUTE decides who may call it.
-- ---------------------------------------------------------------------
create or replace function candidate_onboarding_save(
  p_candidate_id text, p_status text, p_step int, p_draft jsonb,
  p_clear_draft boolean default false, p_restart boolean default false)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare cur text;
begin
  select onboarding_status into cur from candidates where id = p_candidate_id;
  if not found then return null; end if;
  if p_status is not null and p_status not in ('not_started', 'in_progress', 'skipped', 'completed') then
    raise exception 'bad onboarding status %', p_status;
  end if;

  update candidates set
    onboarding_status = case
      when p_status is null then onboarding_status
      when onboarding_status = 'completed' and p_status <> 'completed' and not coalesce(p_restart, false)
        then onboarding_status
      else p_status end,
    onboarding_step = case when p_step is null then onboarding_step else greatest(0, least(10, p_step)) end,
    onboarding_draft = case when coalesce(p_clear_draft, false) then null
                            when p_draft is not null then p_draft
                            else onboarding_draft end,
    onboarding_completed_at = case
      when p_status = 'completed' and onboarding_completed_at is null then now()
      when p_restart and p_status is distinct from 'completed' then null
      else onboarding_completed_at end,
    onboarding_updated_at = now()
  where id = p_candidate_id;

  return candidate_onboarding_get(p_candidate_id);
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant execute on function candidate_onboarding_get(text) to app_api;
    grant execute on function candidate_onboarding_save(text, text, int, jsonb, boolean, boolean) to app_api;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- backfill, LAST: anyone who already said "later" is "skipped"
-- ---------------------------------------------------------------------
update candidates set onboarding_status = 'skipped'
 where coalesce(profile_onboarding_later_count, 0) > 0 and onboarding_status = 'not_started';
