-- ---------------------------------------------------------------------
-- 0156 - who has been imported but has never been given their login
--
-- Candidates brought in BEFORE the login email existed (a Naukri / Shine mail import with the sending paused, a spreadsheet
-- import, a hand-added profile) never received their portal login. This lists exactly who is still waiting, so an
-- administrator can see the number and then send to them on purpose (Admin -> Naukri & Shine Email Import).
--
--   mail      imported from a Naukri / Shine email, has an open application, and was never sent the login/interview email
--   sourced   imported another way (a file, typed in), has no portal account yet, was never invited, and has no mail-import
--             application (those are in "mail")
--
-- Never listed: somebody marked do-not-contact, somebody with no email (mail) / no email or phone (sourced), a candidate who
-- already has an account they can sign in with (sourced), and nobody who is staff - the candidates table only.
-- SECURITY DEFINER so the answer does not depend on which recruiter's mailbox the evidence sits behind.
-- ---------------------------------------------------------------------
create or replace function intake_logins_pending()
returns table (kind text, candidate_id text, application_id text)
language sql stable security definer set search_path = public as $$
  select 'mail'::text, x.candidate_id, x.application_id
    from (select distinct on (a.candidate_id) a.candidate_id, a.id as application_id
            from applications a
            join candidates c on c.id = a.candidate_id
           where a.import_method = 'recruiter_email'
             and a.import_login_notified_at is null
             and a.stage in ('applied', 'ai_screening')
             and not coalesce(c.do_not_contact, false)
             and coalesce(btrim(c.email), '') <> ''
             and not exists (select 1 from applications b
                              where b.candidate_id = a.candidate_id and b.import_method = 'recruiter_email'
                                and b.import_login_notified_at is not null)
           order by a.candidate_id, a.applied_at desc nulls last) x
  union all
  select 'sourced'::text, c.id, null::text
    from candidates c
   where candidate_is_imported(c.id)
     and c.user_id is null
     and not coalesce(c.do_not_contact, false)
     and (coalesce(btrim(c.email), '') <> '' or coalesce(btrim(c.phone), '') <> '')
     and not candidate_invited(c.id)
     and not exists (select 1 from applications a where a.candidate_id = c.id and a.import_method = 'recruiter_email');
$$;

/* one email per candidate: once they were written to, every mail-import application of theirs counts as told */
create or replace function intake_login_notice_claim_all(p_candidate_id text)
returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update applications set import_login_notified_at = now()
   where candidate_id = p_candidate_id and import_method = 'recruiter_email' and import_login_notified_at is null;
  get diagnostics n = row_count;
  return n;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant execute on function intake_logins_pending() to app_api;
    grant execute on function intake_login_notice_claim_all(text) to app_api;
  end if;
end $$;
