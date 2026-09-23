-- ---------------------------------------------------------------------
-- 0024 — re-uploading a file is not a reason to write to somebody again
--
-- candidate_invited() asked "has a message been SENT?", which is the
-- wrong question on a deployment where a channel is not configured or a
-- provider is down: nothing is ever recorded as sent, so every re-import
-- of the same spreadsheet wrote to the same people again. A recruiter
-- correcting one row in a file of four hundred would have messaged all
-- four hundred a second time.
--
-- The rule is now:
--
--   once one got through          -> never again
--   otherwise, tried in the last day -> not again today
--
-- So a repeated upload is silent, while a genuine outage does not
-- silence somebody forever: the next day's import tries again. Note that
-- a second message can never carry a second password in any case -
-- candidate_portal_account() refuses to make a second account, so the
-- credentials it would carry are null.
-- ---------------------------------------------------------------------

create or replace function candidate_invited(p_candidate_id text)
returns boolean
language sql security definer set search_path = public as $$
  select exists (
    select 1 from candidate_invites
     where candidate_id = p_candidate_id
       and (status = 'sent' or created_at > now() - interval '24 hours')
  );
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant execute on function candidate_invited(text) to app_api;
  end if;
end $$;
