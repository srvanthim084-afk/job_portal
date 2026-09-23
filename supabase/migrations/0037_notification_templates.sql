-- ---------------------------------------------------------------------
-- 0037 — one template per event, where the sender can see it
--
-- The Email Templates panel held a template id per email type, in the
-- BROWSER - STATE.notificationSettings, backed by localStorage. The
-- server never saw any of it, so every message it sent used the single
-- EMAILJS_TEMPLATE_ID from the environment whatever the panel said. A
-- recruiter could fill in eleven template ids, see them saved, and have
-- none of them used.
--
-- Two different things are recorded, because conflating them is what
-- made the panel show "template_xxxxxxx" as though it meant something:
--
--   event_key     ours. Stable, readable, and what the code looks up -
--                 `interview_scheduled` is the same event forever.
--   template_id   EmailJS's. Opaque, theirs, and only present once
--                 somebody has actually created the template there.
--
-- A row with no template_id is NOT configured, and says so. Nothing
-- invents a plausible-looking id.
-- ---------------------------------------------------------------------

create table if not exists notification_templates (
  event_key    text primary key,
  label        text not null,
  -- EmailJS's own id, e.g. template_abc123. Null until it exists.
  template_id  text,
  -- Which system event fires it, for the lookup at send time.
  fires_on     text[] not null default '{}',
  updated_at   timestamptz not null default now(),
  updated_by   text
);

alter table notification_templates enable row level security;
alter table notification_templates force  row level security;

-- Staff read it; only the definer function writes it.
create policy nt_read on notification_templates for select using (
  app_is_admin() or app_role() in ('recruiter', 'bde')
);
create policy nt_no_direct_write on notification_templates for all
  using (app_is_admin()) with check (app_is_admin());

insert into notification_templates (event_key, label, fires_on) values
  ('candidate_registration', 'Candidate Registration',
     array['APPLICATION_IMPORTED','CANDIDATE_INVITED']),
  ('interview_invitation',   'Interview Invitation',
     array['AI_INTERVIEW_INVITED']),
  ('candidate_shortlisted',  'Shortlisted',            array['STAGE_SHORTLISTED']),
  ('interview_scheduled',    'Interview Scheduled',    array['INTERVIEW_SCHEDULED']),
  ('interview_rescheduled',  'Interview Rescheduled',  array['INTERVIEW_RESCHEDULED']),
  ('candidate_selected',     'Selection',              array['STAGE_SELECTED']),
  ('candidate_rejected',     'Rejection',              array['STAGE_REJECTED']),
  ('offer_letter',           'Offer Letter',           array['OFFER_EXTENDED']),
  ('joining_reminder',       'Joining Reminder',
     array['AI_INTERVIEW_REMINDER','AI_INTERVIEW_FINAL']),
  ('candidate_followup',     'Follow-up',              array['STAGE_CHANGED']),
  ('custom_email',           'Custom Email',           array['CUSTOM'])
on conflict (event_key) do nothing;

/**
 * Save the real EmailJS template id against an event.
 *
 * An empty value CLEARS it rather than storing '' - because '' would
 * read as configured everywhere that checks for a value, and the screen
 * would say Connected about a template that does not exist.
 */
create or replace function notification_template_set(
  p_event_key text, p_template_id text, p_actor text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_row notification_templates;
begin
  if not (app_is_admin() or app_role() in ('recruiter', 'bde')) then
    raise exception 'not allowed to change notification templates'
      using errcode = '42501';
  end if;

  update notification_templates
     set template_id = nullif(btrim(coalesce(p_template_id, '')), ''),
         updated_at = now(), updated_by = p_actor
   where event_key = p_event_key
  returning * into v_row;

  if v_row.event_key is null then
    raise exception 'no such notification event: %', p_event_key;
  end if;

  return jsonb_build_object(
    'eventKey', v_row.event_key, 'label', v_row.label,
    'templateId', v_row.template_id,
    'status', case when v_row.template_id is null then 'not_connected' else 'connected' end);
end $$;

/** The template id for a system event, or null. */
create or replace function notification_template_for(p_event text)
returns text
language sql stable security definer set search_path = public as $$
  select t.template_id from notification_templates t
   where p_event = any(t.fires_on) and t.template_id is not null
   order by t.event_key limit 1;
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant select on notification_templates to app_api;
    grant execute on function
      notification_template_set(text, text, text),
      notification_template_for(text)
      to app_api;
  end if;
end $$;
