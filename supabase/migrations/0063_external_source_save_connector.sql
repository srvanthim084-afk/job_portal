-- ---------------------------------------------------------------------
-- 0063 — saving a source's connector
--
-- 0062 added `job_sources.connector` but not the way to write it:
-- external_source_save() from 0049 takes nine arguments and knows
-- nothing about the column, so a source created through the admin screen
-- came back with connector NULL and the sync had no adapter to call.
--
-- WHY A NEW FILE. 0062 is already applied, and this project's migration
-- runner is tamper-evident: editing a file it has recorded aborts the
-- run. Appending to it would have broken every deployment that had
-- already taken 0062 - including this one.
--
-- `create or replace` with a tenth parameter creates a SECOND function
-- rather than replacing the first, so the nine-argument version stays
-- exactly where it is and anything still calling it keeps working.
-- ---------------------------------------------------------------------
-- ---------------------------------------------------------------------
create or replace function external_source_save(
  p_id text, p_name text, p_source_type text,
  p_collection text, p_application text,
  p_auto_apply boolean, p_active boolean,
  p_feed_url text, p_credential_env text,
  p_connector text
) returns job_sources
language plpgsql security definer set search_path = public as $$
declare out_row job_sources;
begin
  insert into job_sources (id, name, source_type, job_collection_method,
                           application_method, auto_apply_supported, active,
                           feed_url, credential_env, connector)
       values (p_id, p_name, coalesce(p_source_type, 'job_board'),
               coalesce(p_collection, 'manual'), coalesce(p_application, 'redirect'),
               coalesce(p_auto_apply, false), coalesce(p_active, false),
               p_feed_url, p_credential_env, p_connector)
  on conflict (id) do update set
       name = excluded.name,
       source_type = excluded.source_type,
       job_collection_method = excluded.job_collection_method,
       application_method = excluded.application_method,
       auto_apply_supported = excluded.auto_apply_supported,
       active = excluded.active,
       feed_url = excluded.feed_url,
       credential_env = excluded.credential_env,
       connector = excluded.connector,
       updated_at = now()
  returning * into out_row;
  return out_row;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant execute on function external_source_save(
      text, text, text, text, text, boolean, boolean, text, text, text) to app_api;
  end if;
end $$;
