/**
 * The two-day AI interview window, and the messages that hang off it.
 *
 * The deadline was previously a sentence in a specification. Nothing
 * stored it, so nothing could act on it: a candidate who applied and
 * forgot heard nothing, and an application that would never move sat in
 * "applied" indefinitely.
 *
 * `ai_interview_due_queue()` answers what is owed right now — a 24-hour
 * reminder, a two-hour final warning, or an expiry notice — and each one
 * is sent at most once, recorded in `ai_interview_reminders`.
 *
 * This runs inside the API process on an interval rather than as a cron
 * job, because the deployment target is a single server and a missed
 * reminder is worse than a duplicate process. The queue is idempotent, so
 * running it twice sends nothing twice.
 */
import { dispatchEvent } from './events.js';
import { withUser } from '../db.js';

/** How often to look. The finest-grained warning is two hours out. */
const EVERY_MS = Number(process.env.AI_INTERVIEW_SWEEP_MS || 15 * 60 * 1000);

/**
 * The sweep's identity.
 *
 * Reading every candidate's pending application is an administrative
 * read, and RLS decides that from `app.role`. This session exists only
 * inside the server process: it is never derived from a cookie, never
 * returned to a client, and cannot be requested.
 */
const SWEEP_SESSION = { userId: '', role: 'admin', profileId: null };

const EVENT_FOR = {
  reminder: 'AI_INTERVIEW_REMINDER',
  final:    'AI_INTERVIEW_FINAL',
  expired:  'AI_INTERVIEW_EXPIRED',
};

/**
 * Send everything that is due.
 *
 * @returns {Promise<{sent:number, failed:number, kinds:object}>}
 */
export async function sweepInterviewDeadlines() {
  const out = { sent: 0, failed: 0, kinds: {} };

  const due = await withUser(SWEEP_SESSION, async (c) => {
    // Mark anything already past its deadline before reading, so an
    // abandoned interview reports as expired rather than in progress.
    await c.query(`select ai_interview_expire_overdue()`);
    return (await c.query(`select * from ai_interview_due_queue()`)).rows;
  });

  for (const row of due) {
    const event = EVENT_FOR[row.kind];
    if (!event) continue;

    let ok = false;
    try {
      const res = await dispatchEvent(SWEEP_SESSION, event, {
        applicationId: row.application_id,
        candidateId: row.candidate_id,
        jobId: row.job_id,
        dueAt: row.due_at,
      });
      // "Nothing is configured" is not a delivery, but it is also not a
      // failure worth retrying every fifteen minutes forever: the mark is
      // set either way, and the delivery log records what actually
      // happened on each channel.
      ok = !res.error;
    } catch (err) {
      console.error(`[notify] ${event} for ${row.application_id} failed:`, err.message);
    }

    if (ok) {
      out.sent++;
      out.kinds[row.kind] = (out.kinds[row.kind] || 0) + 1;
      await withUser(SWEEP_SESSION, (c) =>
        c.query(`select ai_interview_reminder_sent($1,$2)`, [row.application_id, row.kind]))
        .catch((err) => console.error('[notify] could not mark a reminder sent:', err.message));
    } else {
      out.failed++;
    }
  }

  return out;
}

/**
 * Start the interval. Returns a stop function.
 *
 * The first sweep is deliberately delayed: a server that has just booted
 * is usually mid-deploy, and a burst of reminders is the last thing a
 * restart should cause.
 */
export function startDeadlineSweep() {
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      const r = await sweepInterviewDeadlines();
      if (r.sent || r.failed) {
        console.log(`[notify] interview deadlines: ${r.sent} sent, ${r.failed} failed`,
          JSON.stringify(r.kinds));
      }
    } catch (err) {
      console.error('[notify] the deadline sweep failed:', err.message);
    }
  };

  const first = setTimeout(tick, 30_000);
  const timer = setInterval(tick, EVERY_MS);
  first.unref?.();
  timer.unref?.();

  return () => { stopped = true; clearTimeout(first); clearInterval(timer); };
}
