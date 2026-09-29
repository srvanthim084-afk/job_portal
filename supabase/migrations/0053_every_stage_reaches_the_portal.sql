-- ---------------------------------------------------------------------
-- 0053 — a candidate is told about every stage, not just the first one
--
-- THE BUG. Notifications are deduplicated on
--
--     (recipient_id, type, job_id, application_id)
--
-- and every stage move writes the SAME type: APPLICATION_STATUS. So the
-- first move an application made put a row in the candidate's portal and
-- every move after it hit the unique index, raised unique_violation, and
-- was swallowed by notify_create - which returns null on a duplicate,
-- correctly, because a repeat of the same event is not an error.
--
-- The result: a candidate told "Shortlisted" was never told anything
-- again. Not when their profile went to the client, not when an
-- interview was arranged, not when they were SELECTED. The email still
-- went out, so nobody noticed; the portal - the one place a candidate
-- looks when they are wondering - silently stopped updating after the
-- first move.
--
-- THE FIX is to include which stage it was. The rule the prototype
-- actually wanted is "do not tell somebody the same thing twice", and for
-- a stage change the thing being said is the stage. A second move to the
-- same stage is still deduplicated; a move to a different one is not the
-- same event and never was.
--
-- Everything else is unaffected: a notification with no `stage` in its
-- metadata keys on an empty string, exactly as it keys today, so
-- BEST_FIT_JOB and every other type dedupe precisely as before.
--
-- Widening a unique index cannot fail on existing data - every key that
-- was unique before is still unique with a column added.
-- ---------------------------------------------------------------------

drop index if exists notifications_dedupe;

create unique index notifications_dedupe
  on notifications (recipient_id, type, coalesce(job_id, ''),
                    coalesce(application_id, ''),
                    coalesce(metadata->>'stage', ''));

comment on index notifications_dedupe is
  'The prototype duplicate rule (:17685), plus the stage - so a candidate hears about every stage their application reaches, and never hears about the same one twice.';
