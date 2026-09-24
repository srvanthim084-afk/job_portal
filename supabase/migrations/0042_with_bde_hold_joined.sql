-- ---------------------------------------------------------------------
-- 0042 — With BDE, Hold and Joined
--
-- Three stages a recruitment desk uses every day and the pipeline did
-- not have. They were being kept in somebody's head, or in a note, which
-- means a profile sitting with a BDE for a fortnight looks exactly like
-- one nobody has touched.
--
--   With BDE   The profile has left the recruiter and is with the
--              business development executive who owns the client
--              relationship. It has NOT reached the client yet, and the
--              difference is the whole point of the stage.
--   Hold       The client or the candidate has paused. Not a rejection,
--              and recording it as one loses somebody who is still live.
--   Joined     The candidate actually started work. The end of the
--              pipeline, and what the placement is invoiced on -
--              "Selected" is a decision, "Joined" is the outcome.
--
-- TWO PROPERTIES ARE ADDED TO EVERY STAGE, because the new ones are not
-- like the old ones and the difference has to live somewhere the code
-- can read:
--
--   notify_candidate  Whether a move to this stage is told to the
--                     candidate. "Your application has moved to With
--                     BDE" means nothing to them and leaks how we work;
--                     "you are on Hold" is worse - it is the kind of
--                     sentence that loses a candidate who was only ever
--                     waiting a week. Both are OURS. Joined is theirs.
--   client_visible    Which stages a client sees at all. This was a
--                     hardcoded array inside a policy function, so every
--                     new stage silently defaulted to invisible with
--                     nothing on screen to say so. It is now a column,
--                     and the seven existing stages keep exactly the
--                     visibility they had.
--
-- The existing stages are renumbered by tens. Their ORDER is unchanged -
-- this only makes room between them, which an integer sort_order
-- otherwise has none of.
-- ---------------------------------------------------------------------

alter table stages
  add column if not exists notify_candidate boolean not null default true,
  add column if not exists client_visible   boolean not null default false;

-- The seven a client could already see, unchanged.
update stages set client_visible = true
 where id in ('shortlisted', 'interview_scheduled', 'ai_interview_done',
              'client_review', 'offer_extended', 'selected', 'rejected');

-- Room between the existing stages, same order.
update stages set sort_order = sort_order * 10;

insert into stages (id, label, kanban, sort_order, notify_candidate, client_visible) values
  -- After Shortlisted (30), before Client Review (60): the profile has
  -- left the recruiter and has not reached the client.
  ('with_bde', 'With BDE', false, 35, false, false),
  -- After Selected (80). The outcome, not the decision.
  ('joined',   'Joined',   false, 85, true,  true),
  -- Before Rejected (90), because it is the other thing that stops a
  -- pipeline - but it is a pause, not an end.
  ('hold',     'Hold',     false, 88, false, false)
on conflict (id) do update set
  label            = excluded.label,
  sort_order       = excluded.sort_order,
  notify_candidate = excluded.notify_candidate,
  client_visible   = excluded.client_visible;

/*
 * Which stages a client sees, read from the table.
 *
 * This was array['shortlisted', ...] written into the function, so a
 * stage added later was invisible to clients by omission rather than by
 * decision - and nothing anywhere said which it was. STABLE rather than
 * IMMUTABLE now that it reads a table: it is used in a policy, where
 * stable is what is required and what it always truthfully was.
 */
create or replace function app_client_visible_stages() returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(id), '{}')::text[] from stages where client_visible
$$;

/*
 * Is a move to this stage the candidate's business?
 *
 * Read by the API before it sends anything, so an internal stage is
 * silent on every channel at once rather than in each of four places
 * that would have to remember separately.
 */
create or replace function stage_notifies_candidate(p_stage text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select notify_candidate from stages where id = p_stage), true)
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant execute on function app_client_visible_stages() to app_api;
    grant execute on function stage_notifies_candidate(text) to app_api;
  end if;
end $$;

/*
 * Joining reminders stop once somebody has joined.
 *
 * The sweep looks for offers whose joining date is a week or a day away
 * and whose application is still at offer_extended or selected. Without
 * this, a candidate who started on Monday is reminded on Monday that
 * they are starting on Monday. The stage now says they arrived.
 */
comment on column stages.notify_candidate is
  'false for stages that are ours, not the candidate''s: no email, SMS, '
  'WhatsApp, call or portal notification is sent when an application '
  'moves here.';
comment on column stages.client_visible is
  'Whether a client may see an application at this stage at all. Read by '
  'app_client_visible_stages(), which the row-level security policies use.';

/*
 * A template row for the one new message that is sent.
 *
 * With BDE and Hold send nothing, so they get no template - a row a
 * recruiter can fill in for a message that will never go out is a
 * promise the software does not keep. Joined does send, so it can be
 * given its own EmailJS template like every other event.
 */
insert into notification_templates (event_key, label, fires_on) values
  ('candidate_joined', 'Joined', array['STAGE_JOINED'])
on conflict (event_key) do nothing;
