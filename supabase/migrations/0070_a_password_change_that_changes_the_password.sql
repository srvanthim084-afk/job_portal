-- ---------------------------------------------------------------------
-- 0070 — a password change that actually changes the password
--
-- THE BUG. `users` has exactly one policy on it, and it is a SELECT
-- policy (0002_rls.sql). Nothing grants UPDATE. Under row level security
-- an UPDATE that matches no policy affects ZERO ROWS AND RAISES
-- NOTHING - it is not an error, it is a write that quietly did not
-- happen.
--
-- Every place that set a password did it with a direct UPDATE:
--
--   POST /auth/password        answered {"ok":true} and changed nothing
--   resendCredentials()        emailed a new temporary password, wrote
--                              the hash to nobody, and reported success
--   the intake password reset  the same
--
-- Measured, not inferred: a candidate signs in with their temporary
-- password, calls POST /auth/password, receives 200, and then the NEW
-- password is refused while the OLD one still works. So nobody has ever
-- been able to change their password, and every "resend credentials"
-- sent somebody a password that could not sign them in.
--
-- 0069's reset worked only because it went through a security definer
-- function, which is the same shape this uses.
--
-- WHY A FUNCTION RATHER THAN A POLICY. A policy permitting users to
-- update their own row permits them to update ANY column of it -
-- `role`, `status` - and writing one narrow enough to prevent that is
-- harder to get right, and harder to keep right, than a function that
-- sets exactly three columns and nothing else.
-- ---------------------------------------------------------------------

/**
 * Set a password, and end the sessions it protected.
 *
 * @param p_keep_token_hash  the session doing the changing, which is
 *        kept so somebody changing their own password is not signed out
 *        by the act of changing it. Pass null to end every session -
 *        which is what an administrator issuing a new temporary password
 *        wants, because the point is to lock out whoever had the old one.
 *
 * @returns whether a user row was actually updated. The callers check
 *          it: reporting success for a write that matched nothing is the
 *          entire defect this migration exists to fix.
 */
create or replace function auth_set_password(
  p_user_id uuid,
  p_hash text,
  p_must_change boolean default false,
  p_keep_token_hash text default null
) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_hit boolean;
begin
  if p_user_id is null or coalesce(p_hash, '') = '' then return false; end if;

  update users
     set password_hash = p_hash,
         must_change_password = coalesce(p_must_change, false),
         password_set_at = now(),
         updated_at = now()
   where id = p_user_id;

  get diagnostics v_hit = row_count;
  if not v_hit then return false; end if;

  /*
   * A password that has been replaced must not leave the sessions it
   * authorised still standing - that is half the reason anybody changes
   * one.
   */
  delete from sessions
   where user_id = p_user_id
     and (p_keep_token_hash is null or token_hash <> p_keep_token_hash);

  return true;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant execute on function auth_set_password(uuid, text, boolean, text) to app_api;
  end if;
end $$;
