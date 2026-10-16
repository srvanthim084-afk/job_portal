-- ---------------------------------------------------------------------
-- 0152 - an imported candidate's login + AI interview email goes out ONCE per application
--
-- intake/process.js sends the candidate their portal login and the AI interview invitation when an application is
-- imported from a Naukri / Shine email. The claim below is taken before anything is sent, in the statement that
-- decides, so a mailbox read again, a retry or two processes cannot send it twice. (A recruiter can still resend it
-- on purpose from the application: that path does not use this claim.)
-- ---------------------------------------------------------------------
alter table applications add column if not exists import_login_notified_at timestamptz;

create or replace function intake_login_notice_claim(p_application_id text)
returns boolean
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update applications set import_login_notified_at = now()
   where id = p_application_id and import_login_notified_at is null;
  get diagnostics n = row_count;
  return n > 0;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant execute on function intake_login_notice_claim(text) to app_api;
  end if;
end $$;
