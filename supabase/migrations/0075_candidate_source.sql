-- ---------------------------------------------------------------------
-- 0075 — where each candidate came from
--
-- `source` and `source_details` have existed since 0057, and every screen
-- wrote whatever it felt like into them: "Walk-in", "walkin", "Naukri",
-- "naukri.com", "Referred by Priya", blank. A column that holds nine
-- spellings of three things cannot be filtered on, cannot be counted, and
-- cannot answer the only question anybody asks of it - which of the ways
-- we find people is actually working.
--
-- So: a fixed vocabulary, the free text kept ALONGSIDE it rather than
-- inside it, and the existing rows folded into the vocabulary rather than
-- thrown away.
--
--   source         one of the values below, or null for "Unknown"
--   source_details the referrer's name, the board, the campus, the
--                  campaign — whatever makes the source specific
--
-- THE ORIGINAL SOURCE DOES NOT CHANGE. A candidate who applies through
-- Naukri and is later moved into the Talent Pool did not come from the
-- Talent Pool; they came from Naukri, and that is what the reporting has
-- to keep saying. A LATER source is recorded as activity, not by
-- overwriting the first one.
-- ---------------------------------------------------------------------

/* The vocabulary, as one list, so the check constraint and the screens
   cannot drift apart. */
create or replace function candidate_source_values() returns text[]
language sql immutable as $$
  select array[
    'Career Site',
    'Job Board',
    'Employee Referral',
    'Agency/Vendor',
    'Campus/Event',
    'Social Media',
    'Talent Community Signup',
    'Manual Entry',
    'Bulk Import',
    'Other'
  ]::text[];
$$;

-- ---------------------------------------------------------------------
-- folding what is already there into it
--
-- Done BEFORE the constraint, and deliberately generously: anything that
-- cannot be recognised becomes 'Other' rather than being discarded, and
-- the original text is preserved in source_details so nothing is lost.
-- ---------------------------------------------------------------------
create or replace function candidate_source_canonical(p_raw text) returns text
language plpgsql immutable as $$
declare v text := lower(btrim(coalesce(p_raw, '')));
begin
  if v = '' then return null; end if;

  /* Already one of ours. */
  if exists (select 1 from unnest(candidate_source_values()) s
              where lower(s) = v) then
    return (select s from unnest(candidate_source_values()) s where lower(s) = v);
  end if;

  if v ~ 'naukri|linkedin|indeed|shine|monster|job ?board|jobboard|foundit'
    then return 'Job Board'; end if;
  if v ~ 'refer' then return 'Employee Referral'; end if;
  if v ~ 'agenc|vendor|consultan|partner' then return 'Agency/Vendor'; end if;
  if v ~ 'campus|college|university|event|job ?fair|walk' then return 'Campus/Event'; end if;
  if v ~ 'facebook|instagram|whatsapp|telegram|twitter|social' then return 'Social Media'; end if;
  if v ~ 'career ?site|website|portal|direct|teamlink' then return 'Career Site'; end if;
  if v ~ 'import|csv|spreadsheet|bulk|excel|xlsx' then return 'Bulk Import'; end if;
  if v ~ 'manual|added by|recruiter|phone|call' then return 'Manual Entry'; end if;
  if v ~ 'talent ?community|signup|sign ?up|subscri' then return 'Talent Community Signup'; end if;

  return 'Other';
end $$;

/* Keep the original wording where there is nothing more specific already
   recorded — it is often the only note of WHICH board or WHO referred. */
update candidates
   set source_details = coalesce(nullif(btrim(source_details), ''), btrim(source))
 where source is not null
   and btrim(source) <> ''
   and candidate_source_canonical(source) is distinct from btrim(source);

update candidates
   set source = candidate_source_canonical(source)
 where source is not null;

alter table candidates drop constraint if exists candidates_source_known;
alter table candidates
  add constraint candidates_source_known
  check (source is null or source = any (candidate_source_values()));

/* Filtering and counting by source is the whole point of the column. */
create index if not exists cand_source_idx on candidates (source);

-- ---------------------------------------------------------------------
-- the candidate's activity history
--
-- There are logs for invitations, contact attempts and merges, but no
-- general one - so "the recruiter changed where this person came from"
-- had nowhere to be written down, and a source that changes without a
-- trace is a number in a report that nobody can account for.
-- ---------------------------------------------------------------------
create table if not exists candidate_activity (
  id           bigserial primary key,
  candidate_id text not null references candidates(id) on delete cascade,
  kind         text not null,          -- 'source_changed', 'source_seen', …
  summary      text not null,          -- one line, already written for a human
  detail       jsonb not null default '{}',
  actor        text,                   -- the user id, or the name of a process
  created_at   timestamptz not null default now()
);
create index if not exists cand_activity_idx
  on candidate_activity (candidate_id, created_at desc);

alter table candidate_activity enable row level security;
alter table candidate_activity force  row level security;

/* Staff may read the history of anybody they can already see, which RLS
   on `candidates` decides - so this widens nothing. The candidate does
   NOT see it: it records what recruiters did, not what happened to them. */
create policy ca_read on candidate_activity for select using (
  app_is_admin() or (app_role() in ('recruiter', 'bde') and exists (
    select 1 from candidates c where c.id = candidate_activity.candidate_id)));

create policy ca_no_direct_write on candidate_activity for all
  using (app_is_admin()) with check (app_is_admin());

grant select on candidate_activity to app_api;
grant usage, select on sequence candidate_activity_id_seq to app_api;

-- ---------------------------------------------------------------------
-- changing it, and saying so
--
-- A definer function because `candidates` is behind row level security
-- and a direct UPDATE that matches no policy affects zero rows WITHOUT
-- raising - the failure mode this codebase has now produced four times.
--
-- THE FIRST SOURCE IS NEVER OVERWRITTEN SILENTLY. Setting a source on a
-- candidate that already has a different one writes the change to the
-- history with both values, so the original is always recoverable and
-- the reporting can be explained.
-- ---------------------------------------------------------------------
create or replace function candidate_source_set(
  p_candidate_id text, p_source text, p_detail text, p_actor text
) returns text
language plpgsql security definer set search_path = public as $$
declare v_old text; v_old_detail text; v_new text;
begin
  select source, source_details into v_old, v_old_detail
    from candidates where id = p_candidate_id;
  if not found then return null; end if;

  v_new := candidate_source_canonical(p_source);

  update candidates
     set source = v_new,
         source_details = nullif(btrim(coalesce(p_detail, '')), ''),
         updated_at = now()
   where id = p_candidate_id;

  if coalesce(v_old, '') is distinct from coalesce(v_new, '') then
    insert into candidate_activity (candidate_id, kind, summary, detail, actor)
    values (p_candidate_id, 'source_changed',
            'Source changed from ' || coalesce(v_old, 'Unknown')
              || ' to ' || coalesce(v_new, 'Unknown'),
            jsonb_build_object('from', v_old, 'to', v_new,
                               'fromDetail', v_old_detail, 'toDetail', p_detail),
            p_actor);
  end if;

  return v_new;
end $$;

/**
 * A candidate who turns up again through a different door.
 *
 * The original source stays as it is; this only notes that they were
 * seen somewhere else, which is what the brief asks for and is also the
 * only version that keeps the "where did this person come from" report
 * meaning one thing.
 */
create or replace function candidate_source_seen(
  p_candidate_id text, p_source text, p_detail text, p_actor text
) returns void
language plpgsql security definer set search_path = public as $$
declare v_old text; v_new text;
begin
  select source into v_old from candidates where id = p_candidate_id;
  if not found then return; end if;

  v_new := candidate_source_canonical(p_source);
  if v_new is null then return; end if;

  /* Nothing to say when it is the door they already came through. */
  if coalesce(v_old, '') = v_new then return; end if;

  /* No source recorded at all: this becomes the original one. */
  if v_old is null then
    update candidates set source = v_new,
           source_details = coalesce(nullif(btrim(coalesce(p_detail, '')), ''), source_details),
           updated_at = now()
     where id = p_candidate_id;
    insert into candidate_activity (candidate_id, kind, summary, detail, actor)
    values (p_candidate_id, 'source_changed',
            'Source recorded as ' || v_new,
            jsonb_build_object('to', v_new, 'toDetail', p_detail), p_actor);
    return;
  end if;

  insert into candidate_activity (candidate_id, kind, summary, detail, actor)
  values (p_candidate_id, 'source_seen',
          'Also seen from ' || v_new || ' (original source ' || v_old || ' kept)',
          jsonb_build_object('also', v_new, 'original', v_old, 'detail', p_detail),
          p_actor);
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant execute on function candidate_source_values() to app_api;
    grant execute on function candidate_source_canonical(text) to app_api;
    grant execute on function candidate_source_set(text, text, text, text) to app_api;
    grant execute on function candidate_source_seen(text, text, text, text) to app_api;
  end if;
end $$;
