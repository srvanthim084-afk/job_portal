-- ---------------------------------------------------------------------
-- 0142 - job gender: "All" and "Other" as well as Female / Male
--
-- The job form's Gender (0072) offered only Female and Male, so a role open
-- to everyone could only be left "not specified" (or, on Post a job, where
-- Gender is required, not posted at all). The owner asked for two more:
--   All    - the role is open to every gender (shown as "All genders")
--   Other  - as the poster chooses
-- Existing jobs keep what they have; nothing is rewritten.
-- ---------------------------------------------------------------------
alter table jobs drop constraint if exists jobs_gender_known;
alter table jobs
  add constraint jobs_gender_known
  check (gender is null or gender in ('Female', 'Male', 'All', 'Other'));
