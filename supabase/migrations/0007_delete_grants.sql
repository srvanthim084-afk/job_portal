-- =====================================================================
-- Missing DELETE privileges.
--
-- 0004_roles.sql granted DELETE on a narrow list of tables, on the
-- reasoning that the application soft-deletes almost everywhere. But the
-- API does expose hard deletes for an admin — DELETE /api/jobs/:id is the
-- obvious one — and `jobs` was not on that list.
--
-- The result was a confusing failure mode: the RLS policy said an admin
-- may delete a job, so the intent was clearly there, but the ROLE had no
-- delete privilege, so Postgres refused with 42501 and the API reported
-- "You do not have permission to change this" to an administrator who
-- unambiguously did.
--
-- Two independent permission layers have to agree. RLS decides WHICH rows
-- a caller may touch; the GRANT decides whether the role may perform that
-- kind of statement at all. Neither substitutes for the other.
-- =====================================================================

grant delete on
  jobs,               -- DELETE /api/jobs/:id        (admin only, per RLS)
  candidates,         -- candidates_delete policy    (admin only)
  interviews,
  offers,
  notifications,
  ai_interviews,      -- cascades to ai_interview_answers
  candidate_reports,
  comm_templates,
  recent_searches,
  view_events,
  feedback
  to app_api;

-- Deliberately NOT granted: `applications` already has DELETE from
-- 0004_roles.sql, and `users`, `sessions`, `companies`, `stages`,
-- `schema_migrations` and the delivery/audit tables stay undeletable by
-- the application role. An audit trail you can delete through the API is
-- not an audit trail.
