-- ---------------------------------------------------------------------
-- 0153 - which candidates were IMPORTED (the Talent Pool lists only those)
--
-- Talent Pool = the candidates brought in by an import: a spreadsheet import, a Naukri / Shine mail import, and the
-- ones recorded before anybody noted a source (those were all imports). Find Candidates stays everybody, whether or
-- not they applied to a job. A candidate who registered themselves (Direct Registration, TeamLink Website, Career
-- Site, Walk-in Application, Talent Community Signup) or was typed in by hand (Manual Entry) is not "imported".
--
-- A SECURITY DEFINER function, because the evidence (the mail that created the candidate) is in tables a recruiter
-- cannot see across other recruiters' mailboxes: asked directly, a candidate imported through somebody else's
-- mailbox would look "not imported" to everyone else.
-- ---------------------------------------------------------------------
create or replace function candidate_is_imported(p_id text)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
           select 1 from candidates c
            where c.id = p_id
              and (c.import_id is not null
                   or c.source is null
                   or c.source not in ('Direct Registration', 'TeamLink Website', 'Career Site',
                                       'Walk-in Application', 'Talent Community Signup', 'Manual Entry')))
      or exists (select 1 from email_messages m where m.candidate_id = p_id)
      or exists (select 1 from applications a where a.candidate_id = p_id and a.import_method = 'recruiter_email');
$$;

create index if not exists email_messages_candidate_idx on email_messages (candidate_id) where candidate_id is not null;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant execute on function candidate_is_imported(text) to app_api;
  end if;
end $$;
