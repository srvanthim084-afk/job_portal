-- =====================================================================
-- 0114: deleting a candidate no longer fails on the resume-score queue
--
-- 0094 queues a re-score whenever a candidate's education or experience
-- rows change - including when one is DELETED. Deleting the candidate
-- itself cascades to those rows, their AFTER DELETE trigger then queued
-- a re-score for the candidate that was being deleted, and the queue's
-- foreign key refused it:
--
--   insert or update on table "candidate_resume_score_queue" violates
--   foreign key constraint "candidate_resume_score_queue_candidate_id_fkey"
--
-- so the whole delete was rolled back. Since 0109 the registration form
-- writes education rows for every candidate, which made every candidate
-- who registered through it impossible to delete - the test-candidate
-- purge said "That refers to something which no longer exists", and an
-- account deletion would have failed the same way.
--
-- A row removed together with its candidate has nothing left to score.
-- The function is the same otherwise; the triggers that call it are
-- unchanged.
-- =====================================================================

create or replace function resume_score_enqueue() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_id text;
begin
  -- Separate statements: a CASE naming new.candidate_id fails on the
  -- candidates table, whose rows have no such field.
  if tg_table_name = 'candidates' then
    v_id := new.id;
  elsif tg_op = 'DELETE' then
    v_id := old.candidate_id;
    -- Deleted along with the candidate (ON DELETE CASCADE): nothing to queue.
    if not exists (select 1 from candidates where id = v_id) then
      return null;
    end if;
  else
    v_id := new.candidate_id;
  end if;
  if v_id is not null then
    insert into candidate_resume_score_queue (candidate_id) values (v_id)
    on conflict (candidate_id) do update set queued_at = now();
  end if;
  return null;
end $$;
