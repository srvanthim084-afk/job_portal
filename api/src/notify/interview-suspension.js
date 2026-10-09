/**
 * What the candidate is told when an AI interview is suspended, and when
 * the retake opens.
 *
 *   suspension email    sent ONCE per suspension, after the status and the
 *                       reason are saved (never before), through the existing
 *                       email provider and house layout. Queued, never awaited
 *                       by the request: a failed send is recorded and retried
 *                       by the sweep, and can never block or undo the suspension.
 *   "open again" email  sent ONCE per retake window, when retake_available_at
 *                       passes and the retake is still allowed.
 *   recruiter alert     when a RETAKE is suspended too (nothing more is
 *                       scheduled automatically - the recruiter decides).
 *
 * "Once" is the database's decision, not a flag in memory: ai_interview_notice_claim
 * flips the row under one statement, so a retry, a duplicate request or two
 * server processes cannot send twice. A restart loses nothing - the times
 * live on the interview row.
 *
 * The words say "suspended" and "retake", never "rejected", "failed" or
 * "disqualified", and carry no internal detail (no scores, thresholds,
 * model names or raw events). The reason is the stored suspension_message,
 * the same sentence the candidate screen and the recruiter page show.
 * Every dynamic value is escaped by the house layout.
 */
import { config } from '../config.js';
import { withUser } from '../db.js';
import { providers } from './providers.js';
import { emailLayout } from './layout.js';
import { companyLabel } from '../portal/alerts.js';
import { alertRecruiter } from './walkin-ats.js';
import { formatWhen, supportEmail, retakePolicy } from '../interview/policy.js';

const ENGINE = { userId: '', role: 'admin', profileId: null };
const base = () => String(config.publicOrigin || '').replace(/\/$/, '');
const oneLine = (s) => String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').trim();

async function load(interviewId) {
  return withUser(ENGINE, async (c) => (await c.query(
    `select i.id, i.application_id, i.attempt_number, i.suspended_at, i.suspension_message, i.suspension_code,
            i.retake_available_at, i.retake_blocked, i.status,
            c.name as candidate_name, c.email as candidate_email,
            j.id as job_id, j.title as job_title, j.recruiter_id as job_recruiter, co.name as company_name,
            a.recruiter_id as app_recruiter, a.ai_interview_due_at
       from ai_interviews i
       join candidates c on c.id = i.candidate_id
       join jobs j on j.id = i.job_id
       left join companies co on co.id = j.company_id
       left join applications a on a.id = i.application_id
      where i.id = $1`, [interviewId])).rows[0] || null);
}

/** The suspension email. Exported so the words can be tested exactly. */
export function buildSuspensionEmail(row) {
  const name = oneLine(row.candidate_name) || 'there';
  const job = oneLine(row.job_title) || 'your application';
  const company = companyLabel(row.company_name);
  const when = formatWhen(row.suspended_at);
  const reason = oneLine(row.suspension_message);
  const support = supportEmail();
  const retakeAt = row.retake_available_at && !row.retake_blocked ? formatWhen(row.retake_available_at) : '';

  const next = retakeAt
    ? [`- You can retake the interview for ${job} after ${retakeAt}. We will send you another message when it is open.`,
       '- Please attend from a quiet place, use headphones, keep your camera on, and make sure only you are speaking.']
    : ['- Your recruiter will review this interview and let you know the next steps.',
       '- If you attend another interview, please do it from a quiet place, use headphones, keep your camera on, and make sure only you are speaking.'];
  next.push(`- If you believe this was a mistake or you faced a technical problem, reply to this email${support ? ` or contact ${support}` : ''}.`);

  const subject = oneLine(`Your AI interview for ${job} has been suspended`);
  const lines = [
    `Hi ${name},`,
    `Your AI interview for ${job} at ${company} was suspended on ${when}.`,
    `Reason: ${reason}`,
    ['What happens next:', ...next].join('\n'),
    'Regards,\nTeamLink Consultants',
  ];
  return {
    subject,
    text: lines.join('\n\n'),
    html: emailLayout({
      title: subject, preheader: reason, greeting: `Hi ${name},`,
      body: [`Your AI interview for ${job} at ${company} was suspended on ${when}.`, `Reason: ${reason}`,
        ['What happens next:', ...next].join('\n')].join('\n\n'),
      note: 'Your recruiter will review this interview.',
    }),
  };
}

export function buildRetakeOpenEmail(row) {
  const name = oneLine(row.candidate_name) || 'there';
  const job = oneLine(row.job_title) || 'your application';
  const company = companyLabel(row.company_name);
  const due = row.ai_interview_due_at ? formatWhen(row.ai_interview_due_at) : '';
  const url = `${base()}/#/candidate/home`;
  const subject = oneLine(`Your AI interview for ${job} is open again`);
  const lines = [
    `Your AI interview for ${job} at ${company} is open again. You can start your retake now from your TeamLink dashboard.`,
    due ? `Please complete it by ${due}.` : '',
    'Before you start: attend from a quiet place, use headphones, keep your camera on, and make sure only you are speaking. You will do the same camera and microphone check first, and the questions start again from Question 1.',
  ].filter(Boolean);
  return {
    subject,
    text: [`Hi ${name},`, '', ...lines.flatMap((l) => [l, '']), `Open TeamLink: ${url}`, '', 'Regards,', 'TeamLink Consultants'].join('\n'),
    html: emailLayout({
      title: subject, preheader: 'Your retake is open.', greeting: `Hi ${name},`,
      body: lines.join('\n\n'), cta: { label: 'Start my interview', url },
    }),
  };
}

async function deliver(row, msg, kind) {
  if (!String(row.candidate_email || '').trim()) return { status: 'skipped_no_address' };
  try {
    const r = await providers.email.send({
      to: row.candidate_email, subject: msg.subject, html: msg.html, text: msg.text,
      vars: { to_name: row.candidate_name, candidate_name: row.candidate_name, subject: msg.subject, message: msg.text,
        portal_link: `${base()}/#/candidate/home`, job_title: row.job_title, notice_kind: kind },
    });
    return r || { status: 'failed' };
  } catch (err) {
    return { status: 'failed', error: err && err.message };
  }
}
const sentOk = (r) => r && (r.status === 'sent' || r.status === 'delivered');

/**
 * The suspension email for one interview, once. Never throws.
 * @returns {{status:string}}  sent | failed | duplicate | skipped
 */
export async function sendSuspensionEmail(interviewId) {
  try {
    const claimed = await withUser(ENGINE, async (c) => (await c.query(
      `select ai_interview_notice_claim($1,'suspension') as ok`, [interviewId])).rows[0].ok);
    if (!claimed) return { status: 'duplicate' };
    const row = await load(interviewId);
    if (!row || row.status !== 'suspended' || !row.suspension_message) {
      await withUser(ENGINE, (c) => c.query(`select ai_interview_notice_done($1,'suspension','failed')`, [interviewId]));
      return { status: 'skipped' };
    }
    const r = await deliver(row, buildSuspensionEmail(row), 'suspension');
    const ok = sentOk(r);
    await withUser(ENGINE, (c) => c.query(`select ai_interview_notice_done($1,'suspension',$2)`, [interviewId, ok ? 'sent' : 'failed']));
    if (!ok) console.error(`[interview] suspension email not sent (${r && r.status})${r && r.error ? ': ' + r.error : ''}`);
    return { status: ok ? 'sent' : 'failed' };
  } catch (err) {
    console.error('[interview] suspension email failed:', err && err.message);
    return { status: 'failed' };
  }
}

/** The retake-open email for one interview, once. Never throws. */
export async function sendRetakeOpenEmail(interviewId) {
  try {
    const claimed = await withUser(ENGINE, async (c) => (await c.query(
      `select ai_interview_notice_claim($1,'retake_open') as ok`, [interviewId])).rows[0].ok);
    if (!claimed) return { status: 'duplicate' };
    const row = await load(interviewId);
    if (!row) return { status: 'skipped' };
    const r = await deliver(row, buildRetakeOpenEmail(row), 'retake_open');
    const ok = sentOk(r);
    await withUser(ENGINE, (c) => c.query(`select ai_interview_notice_done($1,'retake_open',$2)`, [interviewId, ok ? 'sent' : 'failed']));
    return { status: ok ? 'sent' : 'failed' };
  } catch (err) {
    console.error('[interview] retake-open email failed:', err && err.message);
    return { status: 'failed' };
  }
}

/** The recruiter hears when a retake is suspended too: nothing more is scheduled by itself. */
async function alertSecondSuspension(row) {
  const recruiterId = row.app_recruiter || row.job_recruiter;
  if (!recruiterId) return;
  const key = `${row.application_id}:attempt${row.attempt_number}`;
  await alertRecruiter({
    recruiterId, jobId: row.job_id, appId: row.application_id, kind: 'interview_retake_suspended', key,
    title: `${row.candidate_name || 'A candidate'}'s retake was suspended too`,
    message: `The AI interview for ${row.job_title} was suspended again (attempt ${row.attempt_number}). `
      + `${row.suspension_message} No further retake is scheduled automatically - you can review it, allow another attempt, or leave it.`,
    facts: [['Candidate', row.candidate_name || ''], ['Job', row.job_title || ''], ['Attempt', String(row.attempt_number)]],
    url: `${base()}/#/recruiter/interview-integrity`,
  }).catch((err) => console.error('[interview] recruiter alert failed:', err && err.message));
}

/**
 * Called once the shared suspend has SAVED the suspension. Queues the
 * email and, for a suspended retake, the recruiter alert. Never awaited by
 * the request and never throws.
 */
export function afterSuspension(interviewId) {
  setImmediate(async () => {
    try {
      await sendSuspensionEmail(interviewId);
      const row = await load(interviewId);
      if (row && row.status === 'suspended' && (row.attempt_number > 1 || !row.retake_available_at)) {
        await alertSecondSuspension(row);
      }
    } catch (err) {
      console.error('[interview] after-suspension work failed:', err && err.message);
    }
  });
}

/** One pass: failed suspension emails to retry, and retakes that have just opened. */
export async function runInterviewNoticeSweep({ limit = 50 } = {}) {
  const out = { suspensionRetried: 0, retakeOpened: 0 };
  const due = await withUser(ENGINE, async (c) => (await c.query(
    `select interview_id, kind from ai_interview_notices_due($1)`, [limit])).rows);
  for (const d of due) {
    if (d.kind === 'suspension') {
      const r = await sendSuspensionEmail(d.interview_id);
      if (r.status !== 'duplicate') out.suspensionRetried++;
    } else if (d.kind === 'retake_open') {
      const r = await sendRetakeOpenEmail(d.interview_id);
      if (r.status !== 'duplicate') out.retakeOpened++;
    }
  }
  return out;
}

export function startInterviewNoticeSweep() {
  const every = Number(process.env.INTERVIEW_NOTICE_SWEEP_MS || 60 * 1000);
  let stopped = false; let running = false;
  const run = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const out = await runInterviewNoticeSweep();
      if (out.suspensionRetried || out.retakeOpened) {
        console.log(`[interview] ${out.retakeOpened} retake-open notice(s), ${out.suspensionRetried} suspension email retr(ies)`);
      }
    } catch (err) {
      console.error('[interview] the notice sweep failed:', err && err.message);
    } finally { running = false; }
  };
  const first = setTimeout(run, Number(process.env.INTERVIEW_NOTICE_SWEEP_FIRST_MS || 30 * 1000));
  const timer = setInterval(run, every);
  first.unref?.(); timer.unref?.();
  return () => { stopped = true; clearTimeout(first); clearInterval(timer); };
}

export { retakePolicy };
