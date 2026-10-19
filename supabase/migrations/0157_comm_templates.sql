-- ---------------------------------------------------------------------
-- 0157 - Templates & Campaigns: the existing template table, given approval, department, versions and "used in"
--
-- `comm_templates` has existed since the first schema (owner, kind email / whatsapp / sms, name, subject, body, verified) and holds
-- the verified WhatsApp starters from the seed, but nothing read it: the Email / SMS / IVR pages keep their lists in the browser.
-- The Recruiter Portal's "Templates & Campaigns" button needs ONE shared list with an approval state, a department, where each is
-- used and what earlier versions said. This extends that table (its rows stay; `verified` becomes "approved"):
--
--   kind            the channel: call, email, sms or whatsapp ('call' is new - the IVR / AI call scripts)
--   department      'All departments' unless a department owns it
--   used_in         where it is used (a job, a message, a system event)
--   approval_state  approved / waiting / changes_needed  (verified = approved, kept in step)
--   version         1, 2, 3 ... ; every saved version is kept in comm_template_versions
--   source          'system' = built into the product (listed, never edited here, can be duplicated); 'portal' = made by the team
--
-- The workflow: an administrator's template is approved at once; anyone else's waits for a reviewer (an administrator, or a team
-- lead who is not its author) to Approve it or ask for Changes (with a note). Editing an approved template makes a new version and
-- sends it back to waiting. Nobody writes the table directly: every change is one of the SECURITY DEFINER functions below, which
-- check who is asking (the old "owner may write their own rows" policy is replaced for that reason).
-- ---------------------------------------------------------------------
alter table comm_templates drop constraint if exists comm_templates_kind_check;
alter table comm_templates add constraint comm_templates_kind_check check (kind in ('call', 'email', 'sms', 'whatsapp'));

alter table comm_templates
  add column if not exists department      text not null default 'All departments',
  add column if not exists used_in         text[] not null default '{}',
  add column if not exists approval_state  text not null default 'waiting',
  add column if not exists approval_note   text,
  add column if not exists version         int  not null default 1,
  add column if not exists source          text not null default 'portal',
  add column if not exists archived        boolean not null default false,
  add column if not exists created_by      text,
  add column if not exists created_by_name text,
  add column if not exists updated_by      text,
  add column if not exists approved_by     text,
  add column if not exists approved_at     timestamptz,
  add column if not exists updated_at      timestamptz not null default now();
alter table comm_templates alter column body set default '';
update comm_templates set body = '' where body is null;
alter table comm_templates alter column body set not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'comm_templates_approval_chk') then
    alter table comm_templates add constraint comm_templates_approval_chk check (approval_state in ('approved', 'waiting', 'changes_needed'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'comm_templates_source_chk') then
    alter table comm_templates add constraint comm_templates_source_chk check (source in ('system', 'portal'));
  end if;
end $$;

/* what already exists: the verified ones are approved, the rest wait; all are the team's (not built into the product) */
update comm_templates
   set approval_state = case when verified then 'approved' else 'waiting' end,
       created_by_name = coalesce(created_by_name, 'TeamLink'),
       approved_at = case when verified then coalesce(approved_at, created_at) end
 where version = 1 and approval_state = 'waiting' and approved_by is null;

create index if not exists comm_templates_kind_idx on comm_templates (kind, archived);

create table if not exists comm_template_versions (
  id           bigserial primary key,
  template_id  text not null references comm_templates(id) on delete cascade,
  version      int  not null,
  name         text not null,
  subject      text,
  body         text not null default '',
  department   text,
  saved_by     text,
  saved_at     timestamptz not null default now(),
  unique (template_id, version)
);
alter table comm_template_versions enable row level security;
alter table comm_template_versions force  row level security;

/* the existing rows get their version 1 on record */
insert into comm_template_versions (template_id, version, name, subject, body, department, saved_by)
select t.id, 1, t.name, t.subject, t.body, t.department, 'seed' from comm_templates t
on conflict (template_id, version) do nothing;

drop policy if exists templates_own on comm_templates;
drop policy if exists comm_templates_read on comm_templates;
create policy comm_templates_read on comm_templates for select using (
  app_is_admin() or app_role() in ('recruiter', 'bde')
);
drop policy if exists comm_template_versions_read on comm_template_versions;
create policy comm_template_versions_read on comm_template_versions for select using (
  app_is_admin() or app_role() in ('recruiter', 'bde')
);

-- ---------------------------------------------------------------------
-- who is asking (the id the row records) and whether they may review
-- ---------------------------------------------------------------------
create or replace function comm_actor() returns text
language sql stable security definer set search_path = public as $$
  select coalesce(app_recruiter_id(), app_user_id()::text, 'system');
$$;

create or replace function comm_can_review(p_created_by text) returns boolean
language sql stable security definer set search_path = public as $$
  select app_is_admin()
      or (app_role() = 'recruiter'
          and exists (select 1 from recruiters r where r.id = app_recruiter_id() and r.is_team_lead)
          and coalesce(p_created_by, '') <> coalesce(app_recruiter_id(), ''));   -- a team lead never approves their own
$$;

-- ---------------------------------------------------------------------
-- create
-- ---------------------------------------------------------------------
create or replace function comm_template_create(
  p_id text, p_name text, p_channel text, p_subject text, p_body text,
  p_department text, p_used_in text[], p_actor_name text
) returns comm_templates
language plpgsql security definer set search_path = public as $$
declare v comm_templates; v_actor text := comm_actor();
begin
  if not (app_is_admin() or app_role() = 'recruiter') then
    raise exception 'only a recruiter or an administrator may create a template' using errcode = '42501';
  end if;
  if btrim(coalesce(p_name, '')) = '' then raise exception 'a template needs a name' using errcode = '22023'; end if;
  if p_channel not in ('call', 'email', 'sms', 'whatsapp') then raise exception 'unknown channel' using errcode = '22023'; end if;
  if btrim(coalesce(p_body, '')) = '' then raise exception 'a template needs some text' using errcode = '22023'; end if;
  insert into comm_templates (id, owner_id, kind, name, subject, body, department, used_in, approval_state, verified, source,
                              created_by, created_by_name, updated_by, approved_by, approved_at)
  values (p_id, app_user_id(), p_channel, btrim(p_name), nullif(btrim(coalesce(p_subject, '')), ''), p_body,
          coalesce(nullif(btrim(coalesce(p_department, '')), ''), 'All departments'), coalesce(p_used_in, '{}'),
          case when app_is_admin() then 'approved' else 'waiting' end, app_is_admin(), 'portal',
          v_actor, left(coalesce(p_actor_name, ''), 120), v_actor,
          case when app_is_admin() then v_actor end, case when app_is_admin() then now() end)
  returning * into v;
  insert into comm_template_versions (template_id, version, name, subject, body, department, saved_by)
  values (v.id, 1, v.name, v.subject, v.body, v.department, v_actor);
  perform audit_write('comm_template.created', 'comm_template', v.id, jsonb_build_object('channel', v.kind, 'approval', v.approval_state));
  return v;
end $$;

-- ---------------------------------------------------------------------
-- edit: a new version, back to waiting unless an administrator made it
-- ---------------------------------------------------------------------
create or replace function comm_template_update(
  p_id text, p_name text, p_subject text, p_body text, p_department text, p_used_in text[]
) returns comm_templates
language plpgsql security definer set search_path = public as $$
declare v comm_templates; v_actor text := comm_actor();
begin
  select * into v from comm_templates where id = p_id for update;
  if not found then raise exception 'no such template' using errcode = 'P0002'; end if;
  if v.source = 'system' then raise exception 'a built-in template cannot be edited here - duplicate it' using errcode = '22023'; end if;
  if not (app_is_admin() or (app_role() = 'recruiter' and v.created_by = v_actor)) then
    raise exception 'you may only edit your own templates' using errcode = '42501';
  end if;
  if btrim(coalesce(p_name, '')) = '' then raise exception 'a template needs a name' using errcode = '22023'; end if;
  if btrim(coalesce(p_body, '')) = '' then raise exception 'a template needs some text' using errcode = '22023'; end if;

  update comm_templates
     set name = btrim(p_name), subject = nullif(btrim(coalesce(p_subject, '')), ''), body = p_body,
         department = coalesce(nullif(btrim(coalesce(p_department, '')), ''), 'All departments'),
         used_in = coalesce(p_used_in, '{}'),
         version = version + 1, updated_by = v_actor, updated_at = now(),
         approval_state = case when app_is_admin() then 'approved' else 'waiting' end,
         verified = app_is_admin(),
         approval_note = null,
         approved_by = case when app_is_admin() then v_actor end,
         approved_at = case when app_is_admin() then now() end
   where id = p_id returning * into v;
  insert into comm_template_versions (template_id, version, name, subject, body, department, saved_by)
  values (v.id, v.version, v.name, v.subject, v.body, v.department, v_actor);
  perform audit_write('comm_template.updated', 'comm_template', v.id, jsonb_build_object('version', v.version, 'approval', v.approval_state));
  return v;
end $$;

-- ---------------------------------------------------------------------
-- review: approve, or ask for changes (with a note)
-- ---------------------------------------------------------------------
create or replace function comm_template_review(p_id text, p_decision text, p_note text)
returns comm_templates
language plpgsql security definer set search_path = public as $$
declare v comm_templates; v_actor text := comm_actor();
begin
  select * into v from comm_templates where id = p_id for update;
  if not found then raise exception 'no such template' using errcode = 'P0002'; end if;
  if v.source = 'system' then raise exception 'a built-in template is already approved' using errcode = '22023'; end if;
  if not comm_can_review(v.created_by) then
    raise exception 'only an administrator, or a team lead who did not write it, may review a template' using errcode = '42501';
  end if;
  if p_decision not in ('approved', 'changes_needed') then raise exception 'unknown decision' using errcode = '22023'; end if;
  if p_decision = 'changes_needed' and btrim(coalesce(p_note, '')) = '' then
    raise exception 'say what needs to change' using errcode = '22023';
  end if;
  update comm_templates
     set approval_state = p_decision, verified = (p_decision = 'approved'),
         approval_note = nullif(btrim(coalesce(p_note, '')), ''),
         approved_by = v_actor, approved_at = now(), updated_at = now()
   where id = p_id returning * into v;
  perform audit_write('comm_template.' || p_decision, 'comm_template', v.id, jsonb_build_object('version', v.version));
  return v;
end $$;

-- ---------------------------------------------------------------------
-- archive / restore
-- ---------------------------------------------------------------------
create or replace function comm_template_archive(p_id text, p_archived boolean)
returns comm_templates
language plpgsql security definer set search_path = public as $$
declare v comm_templates; v_actor text := comm_actor();
begin
  select * into v from comm_templates where id = p_id for update;
  if not found then raise exception 'no such template' using errcode = 'P0002'; end if;
  if v.source = 'system' then raise exception 'a built-in template cannot be archived' using errcode = '22023'; end if;
  if not (app_is_admin() or (app_role() = 'recruiter' and v.created_by = v_actor)) then
    raise exception 'you may only archive your own templates' using errcode = '42501';
  end if;
  update comm_templates set archived = coalesce(p_archived, true), updated_at = now(), updated_by = v_actor
   where id = p_id returning * into v;
  perform audit_write('comm_template.' || case when v.archived then 'archived' else 'restored' end, 'comm_template', v.id, '{}'::jsonb);
  return v;
end $$;

-- ---------------------------------------------------------------------
-- the product's own templates: listed, approved, never edited here (idempotent)
-- ---------------------------------------------------------------------
create or replace function comm_template_seed_builtin(
  p_id text, p_name text, p_channel text, p_subject text, p_body text, p_used_in text[]
) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into comm_templates (id, kind, name, subject, body, department, used_in, approval_state, verified, source, created_by_name)
  values (p_id, p_channel, p_name, nullif(p_subject, ''), coalesce(p_body, ''), 'All departments', coalesce(p_used_in, '{}'),
          'approved', true, 'system', 'TeamLink')
  on conflict (id) do update
     set name = excluded.name, subject = excluded.subject, body = excluded.body, used_in = excluded.used_in
   where comm_templates.source = 'system';
  insert into comm_template_versions (template_id, version, name, subject, body, department, saved_by)
  values (p_id, 1, p_name, nullif(p_subject, ''), coalesce(p_body, ''), 'All departments', 'system')
  on conflict (template_id, version) do nothing;
end $$;

-- the system emails: one per event, from the table the Email Templates panel already keeps
insert into comm_templates (id, kind, name, subject, body, department, used_in, approval_state, verified, source, created_by_name)
select 'sys_event_' || n.event_key, 'email', n.label, null,
       'Sent through the email provider''s template '
         || coalesce(nullif(n.template_id, ''), '(not configured yet)')
         || ' whenever one of these happens: ' || array_to_string(n.fires_on, ', ') || '.',
       'All departments', n.fires_on, 'approved', true, 'system', 'TeamLink'
  from notification_templates n
on conflict (id) do nothing;
insert into comm_template_versions (template_id, version, name, subject, body, department, saved_by)
select t.id, 1, t.name, t.subject, t.body, t.department, 'system' from comm_templates t
on conflict (template_id, version) do nothing;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant select on comm_templates, comm_template_versions to app_api;
    grant execute on function comm_actor() to app_api;
    grant execute on function comm_can_review(text) to app_api;
    grant execute on function comm_template_create(text, text, text, text, text, text, text[], text) to app_api;
    grant execute on function comm_template_update(text, text, text, text, text, text[]) to app_api;
    grant execute on function comm_template_review(text, text, text) to app_api;
    grant execute on function comm_template_archive(text, boolean) to app_api;
    grant execute on function comm_template_seed_builtin(text, text, text, text, text, text[]) to app_api;
  end if;
end $$;
