-- ---------------------------------------------------------------------
-- 0028 — "AI Screening" was a waiting room, not a stage
--
-- A screening score below the threshold moved the application into the
-- `ai_screening` stage and left it there. The recruiter's list became a
-- column of identical "AI Screening" badges - one per candidate, saying
-- nothing about any of them, and hiding the score that had just been
-- worked out. The stage said the software had run. It never said what it
-- found.
--
-- Screening is a step, not a place to sit. Anything already screened and
-- still parked there goes back to `applied`, its real position in the
-- pipeline, keeping its score. Nobody is rejected and nobody is
-- shortlisted by this - only moved out of a waiting room that should not
-- have existed.
--
-- Applications still sitting there UNSCORED are left alone: the sweep
-- has not reached them yet, and moving them would make them look
-- assessed when they have not been.
-- ---------------------------------------------------------------------

update applications
   set stage = 'applied'
 where stage = 'ai_screening'
   and ai_score is not null;
