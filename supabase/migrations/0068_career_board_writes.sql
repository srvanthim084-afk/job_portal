-- ---------------------------------------------------------------------
-- 0068 — adding a company board
--
-- 0067 created `career_boards` and granted `app_api` select on it, which
-- is this codebase's pattern: reads directly, writes through a definer
-- function. The functions were missing, so the table could be read and
-- never filled - and the admin screen would have failed the same silent
-- way 0064 and 0066 did, with a write that matched no rows and raised
-- nothing.
-- ---------------------------------------------------------------------

create or replace function career_board_save(
  p_id text, p_name text, p_platform text, p_token text, p_active boolean
) returns career_boards
language plpgsql security definer set search_path = public as $$
declare out_row career_boards;
begin
  insert into career_boards (id, name, platform, board_token, active)
       values (p_id, p_name, p_platform, p_token, coalesce(p_active, true))
  on conflict (platform, board_token) do update set
       name = excluded.name,
       active = excluded.active
  returning * into out_row;
  return out_row;
end $$;

create or replace function career_board_delete(p_id text)
returns boolean
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  delete from career_boards where id = p_id;
  get diagnostics n = row_count;
  return n > 0;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant execute on function career_board_save(text, text, text, text, boolean) to app_api;
    grant execute on function career_board_delete(text) to app_api;
  end if;
end $$;
