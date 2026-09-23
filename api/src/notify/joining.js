/**
 * Reminding somebody that they start on Monday.
 *
 * An offer carries a joining date and nothing ever read it. A candidate
 * accepted in September and heard nothing again until the morning they
 * were meant to turn up - which is when a no-show becomes a phone call
 * from the client rather than a question somebody could have asked a
 * week earlier.
 *
 * Runs like the interview-deadline sweep: in the API process, on a
 * timer, once per candidate per window. The windows are deliberately
 * wide apart - a week out is time to arrange things, the day before is
 * the one that stops somebody forgetting.
 */
import { withUser } from '../db.js';
import { dispatchEvent } from './events.js';

const ENGINE = { userId: '', role: 'admin', profileId: null };

/**
 * The two reminders, and how far ahead each one goes out.
 *
 * `key` is recorded so a reminder is sent once and once only - a sweep
 * that runs every few hours must not send the same one every time.
 */
const WINDOWS = [
  { key: 'joining_week',  days: 7, label: 'a week before' },
  { key: 'joining_day',   days: 1, label: 'the day before' },
];

const fmtDate = (d) => (d
  ? new Date(d).toLocaleDateString('en-GB',
      { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' })
  : undefined);

/**
 * Send whichever joining reminders are due.
 *
 * @returns {{ considered:number, sent:number, failed:number }}
 */
export async function sendJoiningReminders() {
  const out = { considered: 0, sent: 0, failed: 0 };

  for (const w of WINDOWS) {
    /*
     * Offers with a joining date falling on the target day.
     *
     * Matched on the DATE, not on a range, so a sweep that runs three
     * times in a day cannot send three reminders - and the recorded key
     * catches the case where it runs either side of midnight.
     */
    const rows = await withUser(ENGINE, async (c) => (await c.query(
      `select o.id as offer_id, o.joining_date, o.ctc,
              a.id as application_id, a.candidate_id, a.job_id, a.stage
         from offers o
         join applications a on a.id = o.application_id
        where o.joining_date is not null
          and o.joining_date = (current_date + ($1 || ' days')::interval)::date
          -- Somebody who was rejected after the offer is not joining.
          and a.stage in ('offer_extended', 'selected')
          and not exists (
            select 1 from application_events e
             where e.application_id = a.id
               and e.type = 'notify.' || $2)
        limit 200`, [String(w.days), w.key])).rows);

    out.considered += rows.length;

    for (const row of rows) {
      try {
        await dispatchEvent(ENGINE, 'JOINING_REMINDER', {
          applicationId: row.application_id,
          candidateId: row.candidate_id,
          jobId: row.job_id,
          joiningDate: fmtDate(row.joining_date),
          ctc: row.ctc == null ? undefined : String(row.ctc),
        });

        // Recorded on the application's own timeline, which is what
        // stops it being sent twice and lets a recruiter see it went.
        await withUser(ENGINE, (c) => c.query(
          `select app_event($1,$2,$3,$4,'system','{}'::jsonb)`,
          [row.application_id, row.candidate_id, `notify.${w.key}`,
           `Joining reminder sent ${w.label}`]));

        out.sent++;
      } catch (err) {
        out.failed++;
        console.error(`[joining] ${row.application_id} failed:`, err.message);
      }
    }
  }

  return out;
}

/** Start the timer. Returns a stop function. */
export function startJoiningSweep() {
  const every = Number(process.env.JOINING_SWEEP_MS || 6 * 60 * 60 * 1000);
  let stopped = false;
  let running = false;

  const run = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const out = await sendJoiningReminders();
      if (out.sent || out.failed) {
        console.log(`[joining] ${out.sent} reminder(s) sent`
          + (out.failed ? `, ${out.failed} failed` : ''));
      }
    } catch (err) {
      console.error('[joining] the sweep failed:', err.message);
    } finally {
      running = false;
    }
  };

  // Not on boot: a restart during a deploy should not be the thing that
  // decides somebody gets a reminder.
  const first = setTimeout(run, Number(process.env.JOINING_FIRST_MS || 90_000));
  const timer = setInterval(run, every);
  first.unref?.();
  timer.unref?.();

  return () => { stopped = true; clearTimeout(first); clearInterval(timer); };
}
