/**
 * The candidate-facing messages an application sends when it is made:
 * the interview invitation (email, SMS, WhatsApp, IVR, Naukri), the
 * "Application received" confirmation when the invitation did not go out,
 * and the AI interview invitation that starts the two-day clock.
 *
 * Moved here unchanged from POST /api/applications so the same code runs
 * either straight away (every ordinary apply) or when a one-click
 * application's Undo window has passed (notify/apply-hold.js, 0104).
 *
 * Never throws: every step keeps its own try/catch, as it did in the route.
 */
import { withUser } from '../db.js';
import { dispatchInterviewNotifications } from './dispatch.js';
import { dispatchEvent } from './events.js';

export async function sendApplyMessages(session, { applicationId, candidateId, jobId }) {
  // ---- multi-channel interview notification -------------------------
  //
  // Fired after the application transaction has committed, deliberately:
  // an SMS gateway being down must never roll back a candidate's
  // application. Every channel is attempted independently inside.
  let notify = null;
  try {
    notify = await dispatchInterviewNotifications(session, { applicationId, candidateId, jobId });

    /*
     * Confirm the application itself, when nothing else already has.
     *
     * The interview invitation above doubles as a confirmation - it
     * names the role and says what happens next - so sending
     * "Application Received" beside it is two emails saying the same
     * thing a second apart. It goes out only when the invitation did
     * not, which is the case for a requirement with no AI interview.
     */
    const sent = Object.values((notify && notify.delivery_status) || {})
      .some((st) => st === 'sent' || st === 'delivered');
    if (!sent) {
      await dispatchEvent(session, 'APPLICATION_SUBMITTED', { applicationId, candidateId, jobId })
        .catch(() => null);
    } else {
      /* 0130: the candidate always gets the confirmation email ("You
         applied for <job>", with the applied date and time). When the
         invitation already went out it is email only, so no second SMS,
         WhatsApp or call says the same thing. */
      await dispatchEvent(session, 'APPLICATION_SUBMITTED', { applicationId, candidateId, jobId, channels: ['email'] })
        .catch(() => null);
    }
  } catch (err) {
    // The application stands regardless. The failure is logged, and the
    // delivery rows (or their absence) are visible on the record.
    console.error('[notify] interview notification dispatch failed:', err.message);
    notify = { error: 'dispatch_failed' };
  }

  // ---- the AI interview and its two-day window ----------------------
  //
  // This message states the deadline. It is marked sent so the sweep
  // never repeats it.
  let aiInterview = null;
  try {
    const due = await withUser(session, async (c) => {
      const row = (await c.query(
        `select ai_interview_due_at from applications where id=$1`, [applicationId])).rows[0];
      return row ? row.ai_interview_due_at : null;
    });
    aiInterview = await dispatchEvent(session, 'AI_INTERVIEW_INVITED', {
      applicationId, candidateId, jobId, dueAt: due,
    });
    await withUser(session, (c) =>
      c.query(`select ai_interview_reminder_sent($1,'invited')`, [applicationId]));
  } catch (err) {
    console.error('[notify] the AI interview invitation failed:', err.message);
    aiInterview = { error: 'dispatch_failed' };
  }

  return { notify, aiInterview };
}
