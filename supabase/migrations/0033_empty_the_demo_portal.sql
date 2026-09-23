-- ---------------------------------------------------------------------
-- 0033 — empty the portal, for good this time
--
-- The purge ran through the API and reported success repeatedly while
-- nothing was removed. Two faults, and the second hid the first:
--
--   the deletes did not commit
--   the "after" count was taken INSIDE the same transaction, so it saw
--   the function's own uncommitted deletes and reported zero
--
-- A check that runs inside the transaction it is checking can only ever
-- agree with it. The honest count is the one a separate request makes,
-- and by that measure every earlier run left all 414 candidates in
-- place.
--
-- This runs as a migration instead: on the admin connection, outside the
-- API's transaction handling and row-level security, once, and part of
-- the same durable write as every other migration. If it fails it fails
-- loudly at boot rather than returning a cheerful JSON body.
--
-- Two logins survive. Everything else goes.
-- ---------------------------------------------------------------------

do $$
declare
  v_keep text[] := array['admin@teamlink.com', 'teamlinkmed001@tmlink.in'];
  v_company text := 'tmlink';
begin
  -- A home for the surviving recruiter before the seeded companies go,
  -- so their row never points at nothing.
  insert into companies (id, name) values (v_company, 'TeamLink Consultants')
  on conflict (id) do nothing;

  update recruiters set company_id = v_company where lower(email) = any(v_keep);

  -- Work first, then the people who did it, then the places.
  delete from applications;
  delete from candidates;
  delete from jobs;

  delete from client_users;
  delete from recruiters where lower(email) <> all(v_keep);
  delete from admins      where lower(email) <> all(v_keep);
  delete from bde_users;

  -- The logins last: every profile hangs from a user row.
  delete from users where lower(email) <> all(v_keep);

  delete from companies where id <> v_company;

  -- Say so at boot, so the migration cannot pass silently the way the
  -- API call did.
  raise notice 'portal emptied: % candidates, % applications, % jobs remain',
    (select count(*) from candidates),
    (select count(*) from applications),
    (select count(*) from jobs);
end $$;
