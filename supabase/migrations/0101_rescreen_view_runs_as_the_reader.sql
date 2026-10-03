-- ---------------------------------------------------------------------
-- 0101 - applications_needing_rescreen runs as the READER
--
-- 0043 created this view without security_invoker, so it ran as its
-- owner and read `applications` and `candidates` past their row level
-- security. It has no WHERE of its own about who is asking, and it is
-- granted to app_api: any signed-in account - a candidate, a client -
-- could list every application in the database with its AI score.
--
-- Nothing in the API reads it; it exists so "which scores are stale" is
-- a question anybody can ask. With security_invoker the answer is the
-- same question asked through the asker's own policies: an administrator
-- (or the screening engine) sees all of them, a recruiter their own, a
-- candidate theirs, and nobody sees anyone else's.
--
-- tools/verify-rls.mjs "VIEWS respect RLS" has failed on this view since
-- 0043; it passes from here.
-- ---------------------------------------------------------------------

alter view applications_needing_rescreen set (security_invoker = true);
