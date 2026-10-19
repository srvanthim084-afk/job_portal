/**
 * Send the portal login (and the AI interview invitation) to everyone imported who has not been given it yet.
 *
 * Who is waiting is decided in the database (intake_logins_pending, 0156): candidates imported from a Naukri / Shine mail with an
 * open application and no login email yet ("mail"), and candidates imported another way who have no account and were never invited
 * ("sourced"). Nobody marked do-not-contact, nobody without an address, nobody who already has an account they sign in with, and
 * never a staff login - the candidates table only.
 *
 * Only an administrator starts it, only with the count they were shown ("expected"), and it runs in the background one candidate
 * at a time so a provider that is slow or down cannot hold anything up; progress is read from status().
 */
import { withUser } from '../db.js';
import { sendRegistrationMessage } from './login-mail.js';
import { inviteCandidate } from '../notify/invite.js';

const ENGINE = { userId: '', role: 'admin', profileId: null };
const PAUSE_MS = () => Number(process.env.BULK_LOGIN_PAUSE_MS || 200);

let job = null;          // the run in progress, or the last one

const pending = async () => withUser(ENGINE, async (c) => (await c.query(`select kind, candidate_id, application_id from intake_logins_pending()`)).rows);

export async function pendingSummary() {
  const rows = await pending();
  const mail = rows.filter((r) => r.kind === 'mail').length;
  const sourced = rows.filter((r) => r.kind === 'sourced').length;
  return { mail, sourced, total: rows.length };
}

export function status() {
  return job ? { ...job } : { running: false, total: 0, done: 0, sent: 0, failed: 0, skipped: 0 };
}

/** @returns {Promise<{started: boolean, reason?: string, total?: number}>} */
export async function startBulk({ expected, actor = 'admin', cap = 2000 } = {}) {
  if (job && job.running) return { started: false, reason: 'a run is already in progress' };
  const rows = await pending();
  if (Number.isFinite(Number(expected)) && Number(expected) !== rows.length) {
    return { started: false, reason: `the number waiting changed from ${expected} to ${rows.length} - please look at it again`, total: rows.length };
  }
  const todo = rows.slice(0, cap);
  job = { running: true, startedAt: new Date().toISOString(), total: todo.length, done: 0, sent: 0, failed: 0, skipped: 0, finishedAt: null };
  await withUser(ENGINE, (c) => c.query(
    `select audit_write('intake.login_bulk_started','candidates','bulk',$1::jsonb)`,
    [JSON.stringify({ total: todo.length, actor })])).catch(() => {});

  (async () => {
    for (const r of todo) {
      try {
        if (r.kind === 'mail') {
          /* once per candidate: take the claim for all their mail-import applications first, so a retry cannot repeat it */
          const first = await withUser(ENGINE, async (c) => (await c.query(
            `select intake_login_notice_claim($1) as ok`, [r.application_id])).rows[0].ok);
          if (!first) { job.skipped += 1; }
          else {
            await withUser(ENGINE, (c) => c.query(`select intake_login_notice_claim_all($1)`, [r.candidate_id])).catch(() => {});
            const out = await sendRegistrationMessage(r.application_id, { actor, bulk: true });
            const ok = out.sent && (out.sent.email === 'sent' || out.sent.email === 'delivered');
            if (ok) job.sent += 1; else if (out.skipped || out.notFound) job.skipped += 1; else job.failed += 1;
          }
        } else {
          const cand = await withUser(ENGINE, async (c) => (await c.query(
            `select id, name, email, phone from candidates where id = $1`, [r.candidate_id])).rows[0]);
          if (!cand) job.skipped += 1;
          else {
            const out = await inviteCandidate(cand, { invitedBy: actor });
            if (out.invited) job.sent += 1; else if (out.reason) job.skipped += 1; else job.failed += 1;
          }
        }
      } catch (err) {
        job.failed += 1;
        console.error('[bulk-logins] one failed:', err.message);
      }
      job.done += 1;
      await new Promise((res) => setTimeout(res, PAUSE_MS()));
    }
    /* written BEFORE the run is reported finished, so whoever sees "finished" can already read the audit line */
    await withUser(ENGINE, (c) => c.query(
      `select audit_write('intake.login_bulk_finished','candidates','bulk',$1::jsonb)`,
      [JSON.stringify({ sent: job.sent, failed: job.failed, skipped: job.skipped, actor })])).catch(() => {});
    job.running = false;
    job.finishedAt = new Date().toISOString();
  })().catch((err) => { if (job) { job.running = false; job.error = err.message; } });

  return { started: true, total: todo.length };
}
