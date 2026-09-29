-- ---------------------------------------------------------------------
-- 0079 — a reminder about EACH job, not one reminder ever
--
-- `notifications_dedupe` is (recipient, type, job_id, application_id,
-- metadata->>'stage'). It exists so a repeated event does not become a
-- repeated message, and 0053 already widened it once for the same
-- reason this widens it again.
--
-- An external-apply reminder names an EXTERNAL application, which is not
-- `application_id` - that column references TeamLink's own applications
-- table and an external one has no row there. So two reminders about two
-- different external jobs had the same key in every column, and the
-- second was swallowed as a duplicate.
--
-- Measured: three jobs opened, one answered, the sweep correctly claimed
-- and stamped the other two and reported "2 apply reminder(s) sent" -
-- and the candidate's inbox held one. They were told about one job and
-- never about the other.
--
-- Widening a unique index cannot fail on existing data: every key that
-- was unique before is still unique with a column added.
-- ---------------------------------------------------------------------
drop index if exists notifications_dedupe;

create unique index notifications_dedupe
  on notifications (recipient_id, type, coalesce(job_id, ''),
                    coalesce(application_id, ''),
                    coalesce(metadata->>'stage', ''),
                    /* The external application this is about, when it is
                       about one. Empty for every other kind of
                       notification, so nothing else changes. */
                    coalesce(metadata->>'applicationId', ''));

comment on index notifications_dedupe is
  'The prototype duplicate rule (:17685), plus the stage (0053) and the external application (0079) - so a candidate hears once about each distinct thing, and never twice about the same one.';
