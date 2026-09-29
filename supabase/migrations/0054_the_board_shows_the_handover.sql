-- ---------------------------------------------------------------------
-- 0054 — the three reviews appear on the board
--
-- 0052 named the reviews and recorded who hands on to whom. It did not
-- put them on the pipeline board, and the board is where a recruiter
-- actually works: the columns stopped at AI Interview Done, so a profile
-- that was ready for the BDE had nowhere to be dragged and no button to
-- press. The stages existed and the UI could not reach them.
--
-- Marking them kanban makes them columns. The order is the sort_order
-- they already have, so the board reads left to right in the order the
-- desk works:
--
--   Applied · AI Screening · Recruiter Review · BDE Review ·
--   Interview Scheduled · AI Interview Done · Client Review ·
--   Client Interview
--
-- Hold and Rejected stay off the board deliberately - they are where
-- things STOP, and a column for them turns a pipeline into a graveyard
-- somebody has to scroll past.
-- ---------------------------------------------------------------------

update stages set kanban = true
 where id in ('with_bde', 'client_review', 'client_interview');
