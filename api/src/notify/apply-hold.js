/**
 * One-click apply: the candidate's messages wait for the Undo window (0104).
 *
 * An application made by one-click apply can be undone for 10 seconds.
 * Its confirmation and AI interview invitation (email, SMS, WhatsApp,
 * IVR) are therefore not sent with the application: a hold row is written
 * in the application's own transaction, and the messages go out when it
 * falls due - the Undo window plus a small margin - and only if the
 * application still exists. Undo deletes the application, the hold goes
 * with it, and nothing is sent.
 *
 * Two ways a hold is sent, both through the same one-UPDATE claim, so a
 * hold is sent once whichever gets there first:
 *   - a timer in this process, set when the application is made (the
 *     normal, prompt path);
 *   - a sweep (startOutboundHoldSweep) that sends any hold that is due and
 *     unsent - which is what a restart in between relies on.
 *
 * The in-app notification is not held (it is removed by Undo already),
 * and nothing recruiter-facing is held.
 */
import { withUser } from '../db.js';
import { sendApplyMessages } from './apply-messages.js';

const ENGINE = { userId: '', role: 'admin', profileId: null };
export const UNDO_SECONDS = 10;

/** Seconds from applying to sending: the Undo window + a margin (default 5 s). */
export function holdSeconds() {
  const m = Number(process.env.ONE_CLICK_HOLD_MARGIN_SECONDS);
  const margin = Number.isFinite(m) ? Math.min(Math.max(m, 1), 120) : 5;
  return UNDO_SECONDS + margin;
}

const timers = new Map();

/** Send this hold when it falls due (in this process). */
export function scheduleHold(applicationId, dueAt) {
  const at = new Date(dueAt).getTime();
  const ms = Math.max(0, (Number.isFinite(at) ? at : Date.now() + holdSeconds() * 1000) - Date.now()) + 300;
  const prev = timers.get(applicationId);
  if (prev) clearTimeout(prev);
  const t = setTimeout(() => {
    timers.delete(applicationId);
    sendHeld(applicationId).catch((err) =>
      console.error('[apply-hold] could not send held messages:', err.message));
  }, ms);
  t.unref?.();
  timers.set(applicationId, t);
}

/** Drop the timers (all, or one application's) - what a process restart does. The rows stay. */
export function forgetScheduledHolds(applicationId) {
  if (applicationId) {
    clearTimeout(timers.get(applicationId));
    timers.delete(applicationId);
    return;
  }
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
}

/**
 * Claim one hold and send its messages. Nothing happens when it is not
 * due, already sent or claimed, or the application has been undone.
 */
export async function sendHeld(applicationId, { now = Date.now() } = {}) {
  const at = new Date(now);
  const row = await withUser(ENGINE, async (c) => (await c.query(
    `select * from application_outbound_claim($1, $2)`, [applicationId, at])).rows[0]);
  if (!row) return { sent: false };

  let out = null;
  let error = null;
  try {
    out = await sendApplyMessages(ENGINE, {
      applicationId: row.application_id, candidateId: row.candidate_id, jobId: row.job_id,
    });
  } catch (err) {
    error = err.message;
  }
  await withUser(ENGINE, (c) => c.query(`select application_outbound_done($1,$2)`, [applicationId, error]))
    .catch((err) => console.error('[apply-hold] could not mark a hold sent:', err.message));
  return { sent: !error, error: error || undefined, ...(out || {}) };
}

/** Everything due and unsent. Idempotent. */
export async function runOutboundHolds({ now = Date.now() } = {}) {
  const ids = await withUser(ENGINE, async (c) => (await c.query(
    `select application_outbound_due($1) as id`, [new Date(now)])).rows.map((r) => r.id));
  let sent = 0;
  for (const id of ids) {
    try {
      const r = await sendHeld(id, { now });
      if (r.sent) sent += 1;
    } catch (err) {
      console.error(`[apply-hold] ${id}:`, err.message);
    }
  }
  return { due: ids.length, sent };
}

export function startOutboundHoldSweep() {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const r = await runOutboundHolds();
      if (r.sent) console.log(`[apply-hold] sent ${r.sent} held application message set(s)`);
    } catch (err) {
      console.error('[apply-hold] the sweep failed:', err.message);
    } finally { running = false; }
  };
  const first = setTimeout(run, Number(process.env.OUTBOUND_HOLD_FIRST_MS || 5000));
  const timer = setInterval(run, Number(process.env.OUTBOUND_HOLD_SWEEP_MS || 30000));
  first.unref?.(); timer.unref?.();
  return () => { clearTimeout(first); clearInterval(timer); forgetScheduledHolds(); };
}
