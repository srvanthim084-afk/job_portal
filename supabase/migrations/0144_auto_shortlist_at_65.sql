-- ---------------------------------------------------------------------
-- 0144 - overall score of 65% or more goes to the ATS
--
-- The owner's rule: a candidate whose overall score (the screening score -
-- skills, experience, location and education, with the screening answers
-- when they are in) is 65% or more is moved into the ATS (Shortlisted).
-- That is the existing AI Settings "Auto-shortlist threshold"; it was 80.
-- It becomes 65 (and "worth a look" starts 15 below it, at 50, as before).
--
-- Only the untouched default is changed: a threshold an administrator set to
-- anything other than 80 stays as they set it (and is editable any time in
-- Admin -> AI Settings).
-- ---------------------------------------------------------------------
update app_settings
   set value = jsonb_set(value, '{autoShortlistThreshold}', '65'::jsonb)
 where key = 'ai'
   and (value->>'autoShortlistThreshold') ~ '^80(\.0+)?$';
