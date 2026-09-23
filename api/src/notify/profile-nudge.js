/**
 * Asking somebody to finish their profile, once or twice, and then
 * leaving them alone.
 *
 * This is the only message here that nobody asked to receive. Every
 * other notification answers something the candidate did - they
 * applied, they were shortlisted, their interview moved. This one
 * arrives because they did NOT do something, which makes it a nudge,
 * and a nudge with no memory is a nag.
 *
 * So the restraint is in the rule, not in the wording, and the rule
 * lives in SQL (candidates_needing_profile, 0038) where it can be read
 * and argued with rather than buried in a loop:
 *
 *   a portal account   without one there is nothing to act on
 *   an email address   nowhere to send it otherwise
 *   genuinely thin     no resume AND something else missing
 *   three days old     somebody who registered this morning is mid-way
 *                      through, not neglecting it
 *   21 days quiet      a reminder every week is a nag
 *   twice, ever        after two the answer is no
 *   not opted out      do-not-contact stops this as it stops everything
 *
 * EVERY ATTEMPT IS RECORDED, including the ones that fail, because the
 * count of two is only meaningful if it counts what actually went.
 */
import { config } from '../config.js';
import { withUser } from '../db.js';
import { providers } from './providers.js';
import { buildEventMessages } from './templates.js';

const ENGINE = { userId: '', role: 'admin', profileId: null };
const KIND = 'profile_incomplete';

/**
 * Send the reminder to whoever is due one.
 *
 * @returns {{ considered:number, sent:number, failed:number, skipped:number }}
 */
export async function sendProfileNudges({ limit = 100 } = {}) {
  const out = { considered: 0, sent: 0, failed: 0, skipped: 0 };

  const rows = await withUser(ENGINE, async (c) => (await c.query(
    `select * from candidates_needing_profile($1)`, [limit])).rows);
  out.considered = rows.length;

  const base = String(config.publicOrigin || '').replace(/\/$/, '');
  const portalUrl = `${base}/#/candidate/profile`;

  for (const person of rows) {
    const messages = buildEventMessages('PROFILE_INCOMPLETE', {
      candidateName: person.name,
      portalUrl,
      linkLabel: 'Complete My Profile',
    });
    if (!messages) { out.skipped++; continue; }

    let result;
    try {
      result = await providers.email.send({
        to: person.email,
        subject: messages.email.subject,
        html: messages.email.html,
        text: messages.email.text,
        vars: {
          to_name: person.name,
          candidate_name: person.name,
          candidate_email: person.email,
          portal_login_url: `${base}/#/login/candidate`,
          portal_link: portalUrl,
        },
      });
    } catch (err) {
      result = { status: 'failed', provider: 'email', error: err.message };
    }

    if (result.status === 'sent' || result.status === 'delivered') out.sent++;
    else if (result.status === 'failed') out.failed++;
    else out.skipped++;

    await withUser(ENGINE, (c) => c.query(
      `select candidate_nudge_record($1,$2,$3,$4,$5)`,
      [person.id, KIND, result.status, person.email, result.error || null]));
  }

  return out;
}

/**
 * The background pass.
 *
 * Once a day, not once an hour. The rule already limits who is due, but
 * a tight loop over a list that changes slowly is wasted work - and if
 * the rule is ever loosened by accident, a daily sweep bounds the
 * damage to one message rather than twenty-four.
 */
export function startProfileNudgeSweep() {
  const every = Number(process.env.PROFILE_NUDGE_MS || 24 * 60 * 60 * 1000);
  let stopped = false;
  let running = false;

  const run = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const out = await sendProfileNudges();
      if (out.sent || out.failed) {
        console.log(`[profile] ${out.sent} reminder(s) sent`
          + (out.failed ? `, ${out.failed} failed` : ''));
      }
    } catch (err) {
      console.error('[profile] the sweep failed:', err.message);
    } finally {
      running = false;
    }
  };

  // Not on boot. A server restarted five times during a deploy must not
  // be five chances to message somebody.
  const first = setTimeout(run, Number(process.env.PROFILE_NUDGE_FIRST_MS || 10 * 60 * 1000));
  const timer = setInterval(run, every);
  first.unref?.();
  timer.unref?.();

  return () => { stopped = true; clearTimeout(first); clearInterval(timer); };
}
