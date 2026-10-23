-- ---------------------------------------------------------------------
-- 0162 - an imported Naukri / Shine response keeps its source, its mailbox and its thread
--
-- A response read from a source mailbox is stored in email_messages and shown in the portal. This keeps, on the message itself,
-- everything needed to place it without opening the raw mail:
--   source      naukri | shine - the provider of the mailbox it was read from (mailbox_id, message_id, candidate_id, application_id
--               and, through the mailbox, the recruiter were already there)
--   thread_id   the conversation: the first id in References, else In-Reply-To, else the message's own Message-ID
--
-- Filled by a trigger on every insert (so no read path has to remember to), and backfilled once for what is already stored.
-- Nothing here sends anything.
-- ---------------------------------------------------------------------
alter table email_messages add column if not exists source text;
alter table email_messages add column if not exists thread_id text;

create or replace function email_message_thread_id(p_raw text, p_message_id text)
returns text
language plpgsql immutable as $$
declare h text; m text[];
begin
  /* the header block only, lines unfolded */
  h := regexp_replace(split_part(replace(left(coalesce(p_raw, ''), 30000), E'\r\n', E'\n'), E'\n\n', 1), E'\n[ \t]+', ' ', 'g');
  m := regexp_match(h, E'(?:^|\n)references:[ \t]*(<[^>\n]+>)', 'i');
  if m is not null then return m[1]; end if;
  m := regexp_match(h, E'(?:^|\n)in-reply-to:[ \t]*(<[^>\n]+>)', 'i');
  if m is not null then return m[1]; end if;
  m := regexp_match(h, E'(?:^|\n)message-id:[ \t]*(<[^>\n]+>)', 'i');
  if m is not null then return m[1]; end if;
  return p_message_id;
end $$;

create or replace function email_messages_fill_source_thread()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.source is null and new.mailbox_id is not null then
    select source into new.source from email_mailboxes where id = new.mailbox_id;
  end if;
  if new.thread_id is null then
    new.thread_id := email_message_thread_id(new.raw, new.message_id);
  end if;
  return new;
end $$;

drop trigger if exists email_messages_fill_source_thread on email_messages;
create trigger email_messages_fill_source_thread
  before insert on email_messages
  for each row execute function email_messages_fill_source_thread();

update email_messages m
   set source = coalesce(m.source, (select b.source from email_mailboxes b where b.id = m.mailbox_id)),
       thread_id = coalesce(m.thread_id, email_message_thread_id(m.raw, m.message_id))
 where m.source is null or m.thread_id is null;

create index if not exists email_messages_thread_idx on email_messages (thread_id);
