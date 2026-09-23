-- ---------------------------------------------------------------------
-- 0025 — taking the sample mailboxes back out
--
-- The intake's `mock` provider serves a fixed set of sample Naukri
-- emails so the whole workflow - parsing, the candidate, the
-- application, the message that goes out - can be exercised before
-- anybody hands over a mailbox password. Everything downstream of it is
-- real. That is the point, and it is also the problem: once a live
-- deployment has run it, the ATS holds applications from candidates who
-- do not exist and nothing on screen says which is which.
--
-- Removing them needs DELETE on `candidates`, which app_api deliberately
-- does not have: the API must not be able to delete people. So the work
-- happens in a definer function that checks for an admin itself, rather
-- than by widening a grant that exists for a good reason.
--
-- Nothing happens without p_confirm. The counts come back either way, so
-- the decision is made on the numbers rather than after them.
-- ---------------------------------------------------------------------

create or replace function intake_cleanup_mock(p_confirm boolean default false)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_boxes    text[];
  v_apps     text[];
  v_touched  text[];
  v_doomed   text[];
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
      'applications', 0, 'candidates', 0, 'keptCandidates', 0);
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

  if p_confirm then
    -- Applications first, then the people who had nothing else, then the
    -- mailboxes (their messages cascade).
    delete from applications where id = any(v_apps);
    delete from candidates   where id = any(v_doomed);
    delete from email_mailboxes where id = any(v_boxes);
  end if;

  return jsonb_build_object(
    'mailboxes',      coalesce(array_length(v_boxes, 1), 0),
    'messages',       v_messages,
    'applications',   coalesce(array_length(v_apps, 1), 0),
    'candidates',     coalesce(array_length(v_doomed, 1), 0),
    'keptCandidates', coalesce(array_length(v_touched, 1), 0)
                      - coalesce(array_length(v_doomed, 1), 0));
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant execute on function intake_cleanup_mock(boolean) to app_api;
  end if;
end $$;
