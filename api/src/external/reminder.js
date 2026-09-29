/**
 * "You opened this. Did you apply?"
 *
 * A candidate who followed a link to an employer's site and never came
 * back to say what happened leaves a row reading "Clicked" for ever.
 * Their own list is then wrong, and so is every count built on it.
 *
 * ONE REMINDER PER APPLICATION, FOR EVER. Not one per sweep, not one a
 * day. The row is CLAIMED in the same statement that marks it (0077), so
 * two overlapping runs cannot both take it and nothing in here has to be
 * careful about that.
 *
 * WHAT IT NEVER SAYS. Nothing in this message asserts that anything was
 * submitted, received or verified. It says what TeamLink actually knows:
 * the candidate opened a link, and only they can say what happened next.
 */
import { withUser } from '../db.js';
import { newId } from './normalise.js';
import { config } from '../config.js';

/* The server acting as itself. Same identity the other sweeps use. */
const ENGINE = { userId: '', role: 'admin', profileId: null };

/*
 * ZERO IS A NUMBER SOMEBODY MEANT.
 *
 * `Number(x) || 24` turns 0 into 24, because zero is falsy - so setting
 * EXTERNAL_APPLY_REMINDER_HOURS=0 to try the sweep out quietly asked for
 * a day's wait and looked as though the sweep did not work at all.
 */
const hours = () => {
  const asked = Number(process.env.EXTERNAL_APPLY_REMINDER_HOURS);
  return Number.isFinite(asked) && asked >= 0 ? asked : 24;
};

/**
 * @returns {{ claimed, sent, skipped, failed }}
 */
export async function sendApplyReminders() {
  const out = { claimed: 0, sent: 0, skipped: 0, failed: 0 };

  const due = await withUser(ENGINE, async (c) => (await c.query(
    `select * from external_application_claim_reminders($1, $2)`,
    [hours(), 200])).rows);

  out.claimed = due.length;
  if (!due.length) return out;

  const base = String(config.publicOrigin || '').replace(/\/$/, '');
  const link = `${base}/#/candidate/external-jobs`;

  for (const a of due) {
    try {
      /*
       * READ THE STATUS AGAIN, HERE.
       *
       * The claim happened a moment ago and the send is happening now.
       * A candidate who answered in between has already told us, and
       * reminding them then reads as a portal that does not listen.
       */
      const fresh = await withUser(ENGINE, async (c) => (await c.query(
        `select a.status, a.confirmed_at, a.candidate_id,
                j.title, j.company, c2.do_not_contact
           from external_applications a
           join external_jobs j on j.id = a.external_job_id
           join candidates  c2 on c2.id = a.candidate_id
          where a.id = $1`, [a.id])).rows[0]);

      if (!fresh || fresh.status !== 'clicked' || fresh.confirmed_at) {
        out.skipped += 1;
        continue;
      }

      /* Whatever the rest of the application already honours about not
         contacting somebody, this honours too. A reminder is not more
         important than that. */
      if (fresh.do_not_contact) { out.skipped += 1; continue; }

      const title = fresh.title || 'a job';
      const company = fresh.company || 'an employer';

      await withUser(ENGINE, (c) => c.query(
        `select notify_create($1,$2,'candidate','EXTERNAL_APPLY_REMINDER',$3,$4,
                              null,null,$5,null,$6::jsonb)`,
        [newId('ntf'), fresh.candidate_id,
         'Did you apply?',
         `You opened ${title} at ${company}. Did you apply? Confirm on TeamLink.`,
         fresh.candidate_id,
         JSON.stringify({ applicationId: a.id, link, jobTitle: title, company })]));

      out.sent += 1;
    } catch (err) {
      out.failed += 1;
      console.error('[external] reminder failed for', a.id, err.message);
      /* The one reminder this application was owed must not be spent on
         a message that never left. */
      try {
        await withUser(ENGINE, (c) => c.query(
          `select external_application_release_reminder($1)`, [a.id]));
      } catch (e2) { /* it will simply not be retried */ }
    }
  }

  return out;
}

export function startApplyReminderSweep() {
  const every = Number(process.env.EXTERNAL_APPLY_REMINDER_MS || 60 * 60 * 1000);
  let stopped = false;
  let running = false;

  const run = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const out = await sendApplyReminders();
      if (out.sent || out.failed) {
        console.log(`[external] ${out.sent} apply reminder(s) sent`
          + (out.skipped ? `, ${out.skipped} skipped` : '')
          + (out.failed ? `, ${out.failed} failed` : ''));
      }
    } catch (err) {
      console.error('[external] the reminder sweep failed:', err.message);
    } finally {
      running = false;
    }
  };

  /* Not on boot. A server restarted five times during a deploy must not
     be five chances to message somebody. */
  const first = setTimeout(run, Number(process.env.EXTERNAL_APPLY_REMINDER_FIRST_MS || 10 * 60 * 1000));
  const timer = setInterval(run, every);
  first.unref?.();
  timer.unref?.();

  return () => { stopped = true; clearTimeout(first); clearInterval(timer); };
}
