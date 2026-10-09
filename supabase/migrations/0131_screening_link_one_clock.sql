-- ---------------------------------------------------------------------
-- 0131 - a screening link is sent and expires by ONE clock
--
-- 0097's screening_link_issue stamped screening_link_sent_at with the
-- database's now() while screening_link_expires_at was computed by the API
-- from the time IT was working to (the sweep's `now`). Two clocks for one
-- link: the 48-hour reminder compares the two, so whenever they disagree the
-- reminder can never fall due (the screening-questions test, which runs the
-- sweep at a fixed date, started failing once the real date passed it).
--
-- This version takes the moment the link was sent from the caller, the same
-- clock the expiry came from. The 3-argument version stays for any caller
-- that still uses it.
-- ---------------------------------------------------------------------
create or replace function screening_link_issue(p_app text, p_nonce text, p_expires timestamptz, p_sent timestamptz)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if app_role() <> 'admin' then
    raise exception 'screening links are issued by the API only' using errcode = '42501';
  end if;
  update applications
     set screening_status = 'pending',
         screening_link_nonce = p_nonce,
         screening_link_expires_at = p_expires,
         screening_link_sent_at = coalesce(p_sent, now()),
         screening_reminder_sent_at = null
   where id = p_app;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant execute on function screening_link_issue(text, text, timestamptz, timestamptz) to app_api;
  end if;
end $$;
