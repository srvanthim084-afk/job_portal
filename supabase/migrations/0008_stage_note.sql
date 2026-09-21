-- ---------------------------------------------------------------------
-- 0008 — record the note (and who moved it) on the stage-history row
--
-- The API used to write the note afterwards:
--
--   update application_stage_history set note=$1
--    where application_id=$2 order by id desc limit 1
--
-- That statement is not valid PostgreSQL. UPDATE has no ORDER BY or LIMIT
-- (it is MySQL syntax), so it failed with a syntax error every single time
-- a recruiter moved a candidate WITH a note. The call site wrapped it in
-- `.catch(() => {})` and commented "history is advisory; never fail the
-- move over it" — but in PostgreSQL a failed statement aborts the whole
-- transaction, so every query after it in the same request came back
-- 25P02 "current transaction is aborted" and the move failed with a
-- DATABASE_ERROR. The catch that was meant to make the note optional is
-- what made the move impossible.
--
-- There is also no UPDATE policy or grant on application_stage_history,
-- deliberately: history is append-only. So the note has to be part of the
-- INSERT the trigger already performs, not an edit afterwards.
--
-- The API sets `app.stage_note` (transaction-local, like app.user_id) just
-- before the UPDATE on applications; the trigger reads it. One statement,
-- no extra privileges, and the note can no longer disagree with the move
-- it describes.
-- ---------------------------------------------------------------------

create or replace function log_stage_change() returns trigger
language plpgsql as $$
declare
  v_note text := nullif(current_setting('app.stage_note', true), '');
  v_raw  text := nullif(current_setting('app.user_id', true), '');
  v_user uuid := null;
begin
  -- app.user_id is a users.id for a signed-in caller and '' for anonymous.
  -- Anything else would abort this transaction on the cast, which is the
  -- exact failure this migration exists to remove.
  if v_raw ~ '^[0-9a-fA-F-]{36}$' then
    v_user := v_raw::uuid;
  end if;

  if tg_op = 'UPDATE' and new.stage is distinct from old.stage then
    insert into application_stage_history
      (application_id, from_stage, to_stage, changed_by, note)
    values (new.id, old.stage, new.stage, v_user, v_note);
  elsif tg_op = 'INSERT' then
    insert into application_stage_history
      (application_id, from_stage, to_stage, changed_by, note)
    values (new.id, null, new.stage, v_user, v_note);
  end if;
  return new;
end $$;
