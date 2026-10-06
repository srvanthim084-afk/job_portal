/**
 * The scoping layer (migration 0117).
 *
 * ONE place that answers "what may this caller see?":
 *
 *   admin       everything
 *   teamlead    their own work + every job, applicant, pool entry, call and
 *               message of their DEPARTMENT
 *   recruiter   their own work
 *
 * The rule itself lives in the database - app_row_in_scope(),
 * app_recruiter_in_scope(), app_job_in_scope() and the row-level
 * security policies built on them - so a route that forgets to ask still
 * cannot leak. This module is the API's side of the same thing:
 *
 *   scopeOf(session)         who the caller is, from the SESSION. Nothing in
 *                            a request body, query string or header is read
 *                            here, so there is nothing for a client to forge.
 *   sql.*                    the SQL fragments routes put in a WHERE clause,
 *                            so the filter is applied before pagination and
 *                            before counts, and is written once.
 *   requireJob / requireJobs 404 for a job outside the caller's scope - the
 *                            same answer as a job that does not exist, so a
 *                            guessed id reveals nothing.
 *   publicSession()          the three fields the browser may be told.
 *
 * A team lead is a recruiter login (role 'recruiter') with a department and
 * the team-lead flag; both are read from `users` by the server at sign-in.
 */
import { ApiError, CODES, notFound } from './errors.js';

/** The caller's scope. `session` is req.session as built by auth.js. */
export function scopeOf(session) {
  const role = (session && session.role) || 'anon';
  const teamLead = role === 'recruiter' && !!(session && session.teamLead && session.departmentId);
  return {
    role,
    scopeRole: role === 'admin' ? 'admin' : teamLead ? 'teamlead' : role,
    userId: (session && session.userId) || null,
    recruiterId: role === 'recruiter' ? (session.profileId || null) : null,
    departmentId: (session && session.departmentId) || null,
    teamLead,
    isAdmin: role === 'admin',
    isRecruiter: role === 'recruiter',
  };
}

/** What the browser is told about the caller's scope. Derived, never echoed. */
export function publicSession(session) {
  const s = scopeOf(session);
  return {
    scopeRole: s.scopeRole,
    departmentId: s.departmentId,
    departmentName: (session && session.departmentName) || null,
    teamLead: s.teamLead,
  };
}

/**
 * SQL fragments. Each takes the table alias and returns a condition that is
 * TRUE for rows inside the caller's scope. They call the database's own
 * functions, so a route and a policy can never disagree about the rule.
 */
export const sql = {
  /** A jobs row (or jobs_with_counts / jobs_open row). */
  job: (a = 'j') => `app_row_in_scope(${a}.recruiter_id, ${a}.department_id)`,
  /** Anything keyed on a recruiter profile id. */
  recruiter: (col) => `app_recruiter_in_scope(${col})`,
  /** Anything keyed on a job id. */
  jobId: (col) => `app_job_in_scope(${col})`,
};

/**
 * 404 unless the job exists AND is in the caller's scope (RLS decides: an
 * out-of-scope job is simply not there for this connection). One query.
 */
export async function requireJob(c, jobId) {
  const { rows } = await c.query(`select id from jobs where id = $1`, [String(jobId)]);
  if (!rows.length) throw new ApiError(404, CODES.JOB_UNAVAILABLE || CODES.NOT_FOUND, 'That job could not be found.');
  return rows[0].id;
}

/** The same for a list; returns only the ids the caller may use. */
export async function jobsInScope(c, ids) {
  if (!ids || !ids.length) return [];
  const { rows } = await c.query(`select id from jobs where id = any($1::text[])`, [ids]);
  return rows.map((r) => r.id);
}

/** 404 unless this talent pool entry (candidate id) is visible to the caller. */
export async function requirePoolEntry(c, candidateId) {
  const { rows } = await c.query(
    `select tp.* from talent_pool tp where tp.candidate_id = $1
      order by (tp.recruiter_id = app_recruiter_id()) desc, tp.added_at desc limit 1`,
    [String(candidateId)]);
  if (!rows.length) throw notFound('That candidate is not in your talent pool.');
  return rows[0];
}

/** The scope fields a session carries, read on an OPEN client (never nest withUser). */
export async function scopeFields(c, userId, role) {
  if (!userId || role !== 'recruiter') {
    return { departmentId: null, departmentName: null, teamLead: false };
  }
  const { rows } = await c.query(`select * from auth_user_scope($1)`, [userId]);
  const r = rows[0] || {};
  return {
    departmentId: r.department_id || null,
    departmentName: r.department_name || null,
    teamLead: !!r.is_team_lead,
  };
}
