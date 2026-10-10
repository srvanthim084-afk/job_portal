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

const ENGINE = { userId: '', role: 'admin', profileId: null };

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
    /* 0139: ONE confirmation per application, whatever retries or replays this path - the
       claim is a row with a unique key (application_notices), and its outcome is recorded. */
    const claimed = await withUser(ENGINE, async (c) => (await c.query(
      `select application_notice_claim_one($1,'APPLICATION_SUBMITTED_CANDIDATE') as ok`, [applicationId])).rows[0].ok)
      .catch(() => true);   // the table unreachable: send as before rather than not at all
    if (claimed) {
      let conf = null;
      if (!sent) {
        conf = await dispatchEvent(session, 'APPLICATION_SUBMITTED', { applicationId, candidateId, jobId })
          .catch(() => null);
      } else {
        /* 0130: the candidate always gets the confirmation email ("You
           applied for <job>", with the applied date and time). When the
           invitation already went out it is email only, so no second SMS,
           WhatsApp or call says the same thing. */
        conf = await dispatchEvent(session, 'APPLICATION_SUBMITTED', { applicationId, candidateId, jobId, channels: ['email'] })
          .catch(() => null);
      }
      const st = conf && conf.delivery_status ? conf.delivery_status.email : null;
      await withUser(ENGINE, (c) => c.query(`select application_notice_done($1,'APPLICATION_SUBMITTED_CANDIDATE',$2,null,$3)`,
        [applicationId, st === 'sent' || st === 'delivered' ? 'sent' : st ? 'failed' : 'skipped',
         st === 'sent' || st === 'delivered' ? null : (conf && conf.error) || (st ? `email ${st}` : 'no email address or channel')]))
        .catch(() => {});
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
    /* 0139: a walk-in that does not use the AI interview sends no invitation */
    const notRequired = await withUser(ENGINE, async (c) => (await c.query(
      `select (reason = 'not_required') as nr from ai_interview_window($1)`, [applicationId])).rows[0]);
    if (notRequired && notRequired.nr) return { notify, aiInterview: { skipped: 'not_required' } };
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
