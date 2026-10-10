-- ---------------------------------------------------------------------
-- 0141 - TeamLink Website is the poster's choice, not a default
--
-- On the job form ("Post to") the TeamLink Website box was ticked to begin
-- with. The owner wants it the other way round: a job appears on the
-- company website (tmlink.in, through /feeds/jobs.json) only when the
-- person posting it ticks TeamLink Website. The box now starts unticked,
-- on the recruiter's forms and on Admin -> Jobs -> Post a job alike.
--
-- Nothing already posted changes: jobs ticked for the website stay there,
-- jobs that were not stay off it. The TeamLink Job Portal itself is still
-- always on (locked) for an Active job.
-- ---------------------------------------------------------------------
update publishing_destinations
   set default_selected = false
 where key = 'TEAMLINK_WEBSITE';
