/**
 * What an imported candidate's first email says about the AI interview.
 *
 * An application brought in from a Naukri / Shine email carries the same two-day AI interview as one made on the
 * portal. The email that gives them their login (intake/process.js, and the recruiter's "resend") now says so: how
 * long it is, the deadline, and how to start it. Only while the interview window is still open - for a walk-in that
 * does not use the interview, or a job that has closed, nothing is said about it.
 */
import { withUser } from '../db.js';
import { BLUEPRINT_TOTAL } from '../ai/interview.js';
import { questionSeconds, formatWhen } from '../interview/policy.js';

const ENGINE = { userId: '', role: 'admin', profileId: null };

/** @returns {Promise<{aiInterview: boolean, aiDueAt?: Date, aiQuestions?: number, aiMinutes?: number}>} */
export async function interviewInfoFor(applicationId) {
  try {
    const row = await withUser(ENGINE, async (c) => (await c.query(
      `select open, reason, due_at from ai_interview_window($1)`, [applicationId])).rows[0]);
    if (!row || !row.open) return { aiInterview: false };
    return {
      aiInterview: true,
      aiDueAt: row.due_at || null,
      aiQuestions: BLUEPRINT_TOTAL,
      aiMinutes: Math.max(5, Math.round(BLUEPRINT_TOTAL * (questionSeconds() + 25) / 60)),
    };
  } catch (err) {
    console.error('[intake] could not read the interview window:', err.message);
    return { aiInterview: false };
  }
}

/**
 * The AI interviews a candidate can attend right now: their open applications whose interview is not done and whose window
 * is still open. Used by the login emails (CANDIDATE_INVITED), so somebody who already applied for a job is told, in the same
 * message that gives them their login, which interview to attend and by when.
 *
 * @returns {Promise<Array<{applicationId: string, jobTitle: string, dueAt: Date|null}>>} at most three, newest first
 */
export async function openInterviewsFor(candidateId) {
  try {
    const rows = await withUser(ENGINE, async (c) => (await c.query(
      `select a.id, j.title, w.due_at
         from applications a
         join jobs j on j.id = a.job_id
         cross join lateral ai_interview_window(a.id) w
        where a.candidate_id = $1 and w.open
          and a.stage in ('applied', 'ai_screening')
          and not exists (select 1 from ai_interviews i
                           where i.application_id = a.id and i.status in ('completed', 'evaluating', 'evaluated'))
        order by a.applied_at desc nulls last limit 3`, [candidateId])).rows);
    return rows.map((r) => ({ applicationId: r.id, jobTitle: r.title, dueAt: r.due_at || null, dueText: r.due_at ? formatWhen(r.due_at) : '' }));
  } catch (err) {
    console.error('[intake] could not read the open interviews:', err.message);
    return [];
  }
}
