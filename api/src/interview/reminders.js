/**
 * Interview reminders, on a timer.
 *
 *   day_before   18:00 IST the day before - only for an interview booked
 *                before that moment (one booked at 20:00 for tomorrow has
 *                just been told)
 *   two_hours    2 hours before the start
 *   status_nudge to the RECRUITER, 2 hours after the end, if the interview
 *                is still 'Scheduled': "update the status (Completed / No Show)"
 *
 * Only for Scheduled interviews whose prep kit has been sent. Each
 * reminder is claimed in interview_prep_messages under a key of
 * (interview, kind, start time), so it goes once however many sweeps run
 * - and a reschedule, which changes the start time, starts afresh while a
 * cancellation stops them all.
 *
 * Quiet hours (21:00-08:00 IST) hold back SMS and WhatsApp; email always
 * goes. The one exception: the two-hour reminder for an interview that
 * starts before 10:00, which would otherwise never reach a phone.
 */
import { withUser } from '../db.js';
import { ENGINE, startsAt, sendInterviewMessage } from './kit-service.js';

const H = 3600_000;
const IST_MS = 330 * 60 * 1000;

/** 18:00 IST on the day before `start`. */
export function dayBeforeSlot(start) {
  const ist = new Date(start.getTime() + IST_MS);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() - 1, 18, 0) - IST_MS);
}

const istHour = (d) => new Date(d.getTime() + IST_MS).getUTCHours();

async function claim(id, kind, slot) {
  return withUser(ENGINE, async (c) => (await c.query(
    `select prep_reminder_claim($1,$2,$3) as ok`, [id, kind, slot])).rows[0].ok);
}

/**
 * @param opts { now }
 * @returns { dayBefore, twoHours, nudges }
 */
export async function runInterviewReminders(opts = {}) {
  const now = opts.now ?? Date.now();
  const out = { dayBefore: 0, twoHours: 0, nudges: 0 };
  const today = new Date(now + IST_MS).toISOString().slice(0, 10);
  const rows = await withUser(ENGINE, async (c) => (await c.query(
    `select i.id, i.scheduled_date, i.scheduled_time, i.duration_minutes, i.status, i.job_id,
            i.candidate_id, i.application_id, i.type, k.sent_at as kit_sent_at,
            j.title as job_title, j.recruiter_id, a.recruiter_id as app_recruiter_id, cand.name as candidate_name
       from interviews i
       join interview_prep_kits k on k.interview_id = i.id and k.sent_at is not null
       join jobs j on j.id = i.job_id
       left join applications a on a.id = i.application_id
       left join candidates cand on cand.id = i.candidate_id
      where i.status = 'Scheduled'
        and i.scheduled_date between ($1::date - 2) and ($1::date + 2)`, [today])).rows);

  for (const r of rows) {
    const start = startsAt(r.scheduled_date, r.scheduled_time);
    if (!start) continue;
    const slot = start.toISOString();
    const s = start.getTime();
    try {
      const dbs = dayBeforeSlot(start).getTime();
      if (now >= dbs && now < s - 2 * H && new Date(r.kit_sent_at).getTime() < dbs) {
        if (await claim(r.id, 'day_before', slot)) {
          await sendInterviewMessage(r.id, 'day_before', { now, slot });
          out.dayBefore += 1;
        }
      }
      if (now >= s - 2 * H && now < s) {
        if (await claim(r.id, 'two_hours', slot)) {
          await sendInterviewMessage(r.id, 'two_hours', { now, slot, ignoreQuietHours: istHour(start) < 10 });
          out.twoHours += 1;
        }
      }
      const end = s + Number(r.duration_minutes || 60) * 60000;
      if (now >= end + 2 * H && now < end + 48 * H) {
        const recruiter = r.app_recruiter_id || r.recruiter_id;
        if (recruiter && await claim(r.id, 'status_nudge', slot)) {
          await withUser(ENGINE, (c) => c.query(
            `select notify_create($1,$2,'recruiter','INTERVIEW_STATUS_DUE',$3,$4,$5,$6,$7,$8,$9::jsonb)`,
            [`ntf_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, recruiter,
             `Update the interview status - ${r.candidate_name || 'candidate'}`,
             `The ${r.type || 'interview'} with ${r.candidate_name || 'the candidate'} for ${r.job_title} ended over 2 hours ago `
               + 'and is still marked Scheduled. Mark it Completed or No Show.',
             r.job_id, r.application_id, r.candidate_id, recruiter, JSON.stringify({ interviewId: r.id })]));
          out.nudges += 1;
        }
      }
    } catch (err) {
      console.error(`[prep-kit] reminder for ${r.id} failed:`, err.message);
    }
  }
  return out;
}

export function startInterviewPrepSweep() {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const r = await runInterviewReminders();
      if (r.dayBefore || r.twoHours || r.nudges) {
        console.log(`[prep-kit] reminders: ${r.dayBefore} day-before, ${r.twoHours} two-hour, ${r.nudges} status nudge(s)`);
      }
    } catch (err) {
      console.error('[prep-kit] the reminder sweep failed:', err.message);
    } finally { running = false; }
  };
  const first = setTimeout(run, Number(process.env.PREP_REMINDER_FIRST_MS || 45_000));
  const timer = setInterval(run, Number(process.env.PREP_REMINDER_SWEEP_MS || 5 * 60 * 1000));
  first.unref?.(); timer.unref?.();
  return () => { clearTimeout(first); clearInterval(timer); };
}
