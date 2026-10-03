-- ---------------------------------------------------------------------
-- 0100 — the AI Career Assistant keeps its conversations
--
-- The candidate's "AI Career Assistant" was keyword matching in the
-- browser, and the transcript lived in page state: a refresh lost it.
-- The assistant now answers from the server (a model when AI_API_KEY is
-- set, the rules engine when it is not), and the conversation is stored
-- here so it survives a refresh and a second device.
--
-- WHAT IS STORED. The candidate's own text and the assistant's FINAL
-- reply - never the raw tool payloads the model saw on the way (profile
-- rows, job lists), which are re-read from the source each time. Token
-- counts are kept so the cost of the feature can be watched.
--
-- WHO SEES IT. The candidate, and nobody else: recruiters and admins have
-- no policy here. A conversation with a career coach is the candidate's
-- business, in the same way their saved searches are (0086).
-- ---------------------------------------------------------------------

create table if not exists career_assistant_conversations (
  id            text primary key,
  candidate_id  text not null references candidates(id) on delete cascade,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists career_assistant_conversations_cand
  on career_assistant_conversations (candidate_id, updated_at desc);

create table if not exists career_assistant_messages (
  id               bigserial primary key,
  conversation_id  text not null references career_assistant_conversations(id) on delete cascade,
  -- denormalised so the policy and the hourly limit need no join
  candidate_id     text not null references candidates(id) on delete cascade,
  role             text not null check (role in ('user','assistant')),
  text             text not null check (char_length(text) between 1 and 20000),
  tools_used       jsonb not null default '[]'::jsonb,
  -- 'ai' (a model answered), 'rules' (the rules engine answered),
  -- null for the candidate's own messages
  engine           text check (engine is null or engine in ('ai','rules')),
  input_tokens     int,
  output_tokens    int,
  created_at       timestamptz not null default now()
);

create index if not exists career_assistant_messages_conv
  on career_assistant_messages (conversation_id, id);
create index if not exists career_assistant_messages_rate
  on career_assistant_messages (candidate_id, created_at desc) where role = 'user';

-- One row per message the candidate sends, kept when a chat is cleared:
-- the hourly limit is counted here, so "Clear chat" does not reset it.
-- No update or delete is granted on it to the API at all.
create table if not exists career_assistant_usage (
  id            bigserial primary key,
  candidate_id  text not null references candidates(id) on delete cascade,
  engine        text check (engine is null or engine in ('ai','rules')),
  created_at    timestamptz not null default now()
);

create index if not exists career_assistant_usage_cand
  on career_assistant_usage (candidate_id, created_at desc);

create or replace function career_assistant_touch() returns trigger
language plpgsql as $$
begin
  update career_assistant_conversations set updated_at = now() where id = new.conversation_id;
  return new;
end $$;

drop trigger if exists career_assistant_touch on career_assistant_messages;
create trigger career_assistant_touch after insert on career_assistant_messages
  for each row execute function career_assistant_touch();

/* A message must belong to a conversation of the same candidate. */
create or replace function career_assistant_same_owner() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from career_assistant_conversations c
                  where c.id = new.conversation_id and c.candidate_id = new.candidate_id) then
    raise exception 'career_assistant_owner: conversation belongs to someone else' using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists career_assistant_same_owner on career_assistant_messages;
create trigger career_assistant_same_owner before insert on career_assistant_messages
  for each row execute function career_assistant_same_owner();

alter table career_assistant_conversations enable row level security;
alter table career_assistant_messages      enable row level security;
alter table career_assistant_usage         enable row level security;

drop policy if exists career_assistant_conversations_own on career_assistant_conversations;
create policy career_assistant_conversations_own on career_assistant_conversations for all
  using (app_role() = 'candidate' and candidate_id = app_candidate_id())
  with check (app_role() = 'candidate' and candidate_id = app_candidate_id());

drop policy if exists career_assistant_messages_own on career_assistant_messages;
create policy career_assistant_messages_own on career_assistant_messages for all
  using (app_role() = 'candidate' and candidate_id = app_candidate_id())
  with check (app_role() = 'candidate' and candidate_id = app_candidate_id());

drop policy if exists career_assistant_usage_read on career_assistant_usage;
create policy career_assistant_usage_read on career_assistant_usage for select
  using (app_role() = 'candidate' and candidate_id = app_candidate_id());
drop policy if exists career_assistant_usage_insert on career_assistant_usage;
create policy career_assistant_usage_insert on career_assistant_usage for insert
  with check (app_role() = 'candidate' and candidate_id = app_candidate_id());

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant select, insert, update, delete on career_assistant_conversations to app_api;
    grant select, insert, delete on career_assistant_messages to app_api;
    grant usage, select on sequence career_assistant_messages_id_seq to app_api;
    grant select, insert on career_assistant_usage to app_api;
    grant usage, select on sequence career_assistant_usage_id_seq to app_api;
  end if;
end $$;

comment on table career_assistant_messages is
  'AI Career Assistant chat (0100). The candidate''s text and the assistant''s final reply only - no tool payloads. Readable by that candidate alone.';
