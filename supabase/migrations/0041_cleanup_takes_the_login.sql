-- ---------------------------------------------------------------------
-- 0041 — the cleanup takes the login too
--
-- intake_cleanup_mock removed the sample mailbox, the applications and
-- the candidates, and left every portal ACCOUNT those candidates had
-- standing. A candidate created by the intake gets a login - that is the
-- point of it - and deleting the person while leaving the account behind
-- leaves a credential with nobody attached to it.
--
-- It accumulated exactly as you would expect. A database that should
-- have held two logins held eleven: three recruiter accounts from
-- mailboxes connected during testing and six candidate accounts whose
-- candidates had been deleted underneath them months earlier. Each one
-- could still sign in.
--
-- The accounts are deleted with the people they belonged to, and ONLY
-- those: an account is taken only when it is the account of a candidate
-- being removed. Nothing here can reach an administrator, a recruiter,
-- or a candidate who is staying.
-- ---------------------------------------------------------------------

create or replace function intake_cleanup_mock(p_confirm boolean default false)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_boxes    text[];
  v_apps     text[];
  v_touched  text[];
  v_doomed   text[];
  v_users    uuid[];
  v_messages int;
begin
  if not app_is_admin() then
    raise exception 'only an administrator may remove the sample mailboxes'
      using errcode = '42501';
  end if;

  select coalesce(array_agg(id), '{}') into v_boxes
    from email_mailboxes where provider = 'mock';

  if array_length(v_boxes, 1) is null then
    return jsonb_build_object('mailboxes', 0, 'messages', 0,
      'applications', 0, 'candidates', 0, 'logins', 0, 'keptCandidates', 0);
  end if;

  select count(*)::int into v_messages
    from email_messages where mailbox_id = any(v_boxes);

  -- Applications traceable to one of those emails.
  select coalesce(array_agg(a.id), '{}'),
         coalesce(array_agg(distinct a.candidate_id), '{}')
    into v_apps, v_touched
    from applications a
    join email_messages m on m.message_id = a.source_message_id
   where m.mailbox_id = any(v_boxes);

  /*
   * Only the people who exist SOLELY because of the demo.
   *
   * Somebody who arrived through a sample email and has since applied
   * for a real role keeps their profile and that application. Deleting
   * them because of where they first came from would lose real work.
   */
  select coalesce(array_agg(c.id), '{}') into v_doomed
    from candidates c
   where c.id = any(v_touched)
     and not exists (
       select 1 from applications a2
        where a2.candidate_id = c.id
          and not (a2.id = any(v_apps)));

  /*
   * The accounts those people sign in with.
   *
   * Taken from the candidate row rather than matched on an address, so
   * this can only ever reach an account a doomed candidate actually
   * points at - and the role is checked as well, because a shared
   * address that someone linked to a staff account must not be caught
   * by a cleanup of sample data.
   */
  select coalesce(array_agg(u.id), '{}') into v_users
    from candidates c
    join users u on u.id = c.user_id
   where c.id = any(v_doomed)
     and u.role = 'candidate';

  if p_confirm then
    -- Applications first, then the people who had nothing else and the
    -- accounts they signed in with, then the mailboxes (their messages
    -- cascade).
    delete from applications where id = any(v_apps);
    delete from candidates   where id = any(v_doomed);
    delete from users        where id = any(v_users);
    delete from email_mailboxes where id = any(v_boxes);
  end if;

  return jsonb_build_object(
    'mailboxes',      coalesce(array_length(v_boxes, 1), 0),
    'messages',       v_messages,
    'applications',   coalesce(array_length(v_apps, 1), 0),
    'candidates',     coalesce(array_length(v_doomed, 1), 0),
    'logins',         coalesce(array_length(v_users, 1), 0),
    'keptCandidates', coalesce(array_length(v_touched, 1), 0)
                      - coalesce(array_length(v_doomed, 1), 0));
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant execute on function intake_cleanup_mock(boolean) to app_api;
  end if;
end $$;
