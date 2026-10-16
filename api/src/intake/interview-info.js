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
import { questionSeconds } from '../interview/policy.js';

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
