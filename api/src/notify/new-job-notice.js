/**
 * One "new job for you" message per candidate per job - across every
 * system that sends one.
 *
 * Four alerts can each decide, independently, that a just-published job
 * is for somebody:
 *
 *   profile_match   the job matched their profile       (job-alerts.js, 0017)
 *   saved_search    it matched one of their searches    (saved-search-alerts.js, 0086)
 *   urgent_hiring   it is urgent and they match it      (portal/alerts.js, 0095)
 *   saved_job       it is like a job they saved         (saved-job-alerts.js, 0110)
 *
 * Each had its own "never twice" guard, but only for itself, so one job
 * could arrive three times. candidate_new_job_notices (0110) is the guard
 * they share: before sending, a system CLAIMS (candidate, job); the first
 * claim wins and everybody after it - including a second run of the same
 * system - is told no. A message that reached nobody (every channel
 * skipped or not configured) RELEASES its claim so another alert may
 * still try.
 *
 * Reminders about a job the candidate already knows of (the last-date
 * alerts, deadline_2d / deadline_today) are not "new job" messages and do
 * not take part.
 */
import { withUser } from '../db.js';

const ENGINE = { userId: '', role: 'admin', profileId: null };

export const NOTICE_SOURCES = ['profile_match', 'saved_search', 'urgent_hiring', 'saved_job'];

/**
 * True when the caller may send: nobody had told this candidate about
 * this job. A database error answers false - sending a duplicate is the
 * outcome this exists to prevent.
 */
export async function claimNewJobNotice(candidateId, jobId, source) {
  try {
    return await withUser(ENGINE, async (c) =>
      (await c.query(`select new_job_notice_claim($1,$2,$3) as ok`, [candidateId, jobId, source])).rows[0].ok === true);
  } catch (err) {
    console.error(`[new-job-notice] claim failed (${source}):`, err.message);
    return false;
  }
}

/** The message reached nobody: let another alert speak instead. */
export async function releaseNewJobNotice(candidateId, jobId, source) {
  try {
    await withUser(ENGINE, (c) => c.query(`select new_job_notice_release($1,$2,$3)`, [candidateId, jobId, source]));
  } catch (err) {
    console.error(`[new-job-notice] release failed (${source}):`, err.message);
  }
}

/** Did any status object from a send say a channel actually delivered? */
export const anySent = (statuses) => Object.values(statuses || {}).some((s) => s === 'sent');

/**
 * Every (candidate, job) already claimed, for a set of candidates, on an
 * engine connection the caller already holds. Rows: { candidate_id, job_id, source }.
 */
export async function noticesFor(c, candidateIds) {
  if (!candidateIds || !candidateIds.length) return [];
  return (await c.query(
    `select candidate_id, job_id, source from candidate_new_job_notices where candidate_id = any($1)`,
    [candidateIds])).rows;
}
