/**
 * The notices an application owes HR, exactly once (0138).
 *
 *   WALKIN_APPLICATION_SUBMITTED_HR   a walk-in application was saved - sent straight away,
 *                                     whether or not a recruiter is assigned, and long
 *                                     before any AI interview
 *   WALKIN_CANDIDATE_ELIGIBLE         the FINAL AI interview score is 50% or more (the
 *                                     job's threshold) - decided by the database
 *
 * Both go to INTERNAL_HR_EMAIL (internalhr.tmlink@gmail.com unless configured otherwise;
 * an empty value switches them off). The database row is the idempotency: one row per
 * (application, event), claimed before it is sent, so a retried request, a re-scored
 * interview or a second server cannot send it twice. A failed send is recorded with its
 * error and retried by the sweep a few times; it never touches the application.
 *
 * The candidate's own confirmation (APPLICATION_SUBMITTED_CANDIDATE) is claimed in the
 * same table by notify/apply-messages.js, which still sends it the way it always has.
 */
import { config } from '../config.js';
import { withUser } from '../db.js';
import { providers } from './providers.js';
import { emailLayout } from './layout.js';
import { dateLabel, timeRange } from '../portal/walkin-jobs.js';

const ENGINE = { userId: '', role: 'admin', profileId: null };
const base = () => String(config.publicOrigin || '').replace(/\/$/, '');
const EMAIL_RE = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[a-z]{2,}$/i;
const oneLine = (s) => String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').trim();

/** Where HR notices go. Empty = switched off. */
export function hrRecipient() {
  const v = String(config.internalHrEmail == null ? '' : config.internalHrEmail).trim();
  return EMAIL_RE.test(v) ? v : '';
}

const IST = { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true };
const when = (d) => {
  if (!d) return '';
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? '' : `${new Intl.DateTimeFormat('en-IN', IST).format(t)} IST`;
};

async function load(applicationId) {
  return withUser(ENGINE, async (c) => (await c.query(
    `select a.id, a.reference, a.applied_at, a.created_at, a.source, a.source_channel, a.stage,
            a.walkin_ai_score, a.walkin_ai_eligibility, a.walkin_ai_completed_at,
            c.id as candidate_id, c.name as candidate_name, c.email as candidate_email, c.phone as candidate_phone,
            c.resume_file,
            j.id as job_id, j.title as job_title, j.location as job_location, j.posting_kind,
            j.walkin_date, j.walkin_from, j.walkin_to, j.walkin_venue, j.walkin_address, j.walkin_map_link,
            j.walkin_contact, j.walkin_contact_designation, j.walkin_phone, j.walkin_ai_required, j.walkin_ai_threshold,
            co.name as company_name,
            (select i.status from ai_interviews i where i.application_id = a.id
              order by coalesce(i.attempt_number, 1) desc, i.created_at desc limit 1) as ai_status
       from applications a
       join candidates c on c.id = a.candidate_id
       join jobs j on j.id = a.job_id
       left join companies co on co.id = j.company_id
      where a.id = $1`, [applicationId])).rows[0] || null);
}

function aiStatusText(r) {
  if (r.walkin_ai_required === false) return 'Not required for this walk-in';
  if (r.walkin_ai_eligibility === 'eligible') return `Completed - ${Number(r.walkin_ai_score)}% (Eligible)`;
  if (r.walkin_ai_eligibility === 'not_eligible') return `Completed - ${Number(r.walkin_ai_score)}% (Not Eligible)`;
  const s = String(r.ai_status || '');
  if (s === 'in_progress' || s === 'warning_issued') return 'In progress';
  if (s === 'suspended') return 'Suspended - under recruiter review';
  if (s === 'completed' || s === 'evaluated') return 'Completed - no valid score';
  return 'Pending - invited after applying';
}

function walkinFacts(r) {
  return [
    ['Walk-in date', dateLabel(r.walkin_date)],
    ['Walk-in time', timeRange(r.walkin_from, r.walkin_to)],
    ['Venue', oneLine(r.walkin_venue)],
    ['Address', oneLine(r.walkin_address)],
    ['Google Maps', oneLine(r.walkin_map_link)],
    ['Contact person', oneLine(r.walkin_contact)],
    ['Designation', oneLine(r.walkin_contact_designation)],
    ['Contact phone', oneLine(r.walkin_phone)],
  ];
}
const atsLink = (r) => `${base()}/#/recruiter/jobs?applicants=${encodeURIComponent(r.job_id)}&app=${encodeURIComponent(r.id)}`;
const source = (r) => oneLine(r.source_channel || r.source || 'TeamLink Job Portal');

/** "New Walk-in Application - <candidate> - <job>". Exported so the words can be tested. */
export function buildWalkinHrEmail(r) {
  const name = oneLine(r.candidate_name) || 'A candidate';
  const job = oneLine(r.job_title) || 'a walk-in';
  const subject = oneLine(`New Walk-In Application - ${name} - ${job}`);
  const facts = [
    ['Candidate', name], ['Email', oneLine(r.candidate_email)], ['Phone', oneLine(r.candidate_phone)],
    ['Application ID', oneLine(r.reference || r.id)], ['Job ID', oneLine(r.job_id)], ['Job title', job],
    ['Client / Company', oneLine(r.company_name)], ['Submitted', when(r.applied_at || r.created_at)],
    ['Source', source(r)], ['Resume', r.resume_file ? 'On file - open the application in TeamLink ATS' : 'Not uploaded'],
    ['AI interview', aiStatusText(r)],
    ...walkinFacts(r),
  ];
  const body = `${name} has applied for the walk-in "${job}"${r.company_name ? ` at ${oneLine(r.company_name)}` : ''}. `
    + 'The AI interview result, when there is one, follows in a separate email.';
  return {
    subject,
    text: [subject, '', body, '', ...facts.filter((f) => f[1]).map(([k, v]) => `${k}: ${v}`), '',
      `Open in TeamLink ATS (sign-in required): ${atsLink(r)}`].join('\n'),
    html: emailLayout({ title: subject, preheader: `${name} applied for ${job}`, body, facts,
      cta: { label: 'Open in TeamLink ATS', url: atsLink(r) }, note: 'Sign-in required. Sent to TeamLink internal HR.' }),
  };
}

/** "Walk-in Candidate Eligible - <candidate> - <job>". */
export function buildEligibleHrEmail(r) {
  const name = oneLine(r.candidate_name) || 'A candidate';
  const job = oneLine(r.job_title) || 'a walk-in';
  const subject = oneLine(`Walk-In Candidate Eligible - ${name} - ${job}`);
  const facts = [
    ['Candidate', name], ['Email', oneLine(r.candidate_email)], ['Phone', oneLine(r.candidate_phone)],
    ['Application ID', oneLine(r.reference || r.id)], ['Job ID', oneLine(r.job_id)], ['Job title', job],
    ['Client / Company', oneLine(r.company_name)],
    ['Final AI interview score', `${Number(r.walkin_ai_score)}%`], ['Eligibility', 'Eligible'],
    ['Interview completed', when(r.walkin_ai_completed_at)],
    ...walkinFacts(r),
  ];
  const body = `${name} completed the AI interview for "${job}" with a final score of ${Number(r.walkin_ai_score)}% `
    + `(${Number(r.walkin_ai_threshold == null ? 50 : r.walkin_ai_threshold)}% or more is eligible), and is eligible for the walk-in. `
    + 'Eligible is not attended: attendance is recorded at the venue.';
  return {
    subject,
    text: [subject, '', body, '', ...facts.filter((f) => f[1]).map(([k, v]) => `${k}: ${v}`), '',
      `Open in TeamLink ATS (sign-in required): ${atsLink(r)}`].join('\n'),
    html: emailLayout({ title: subject, preheader: `${name} - ${Number(r.walkin_ai_score)}% - Eligible`, body, facts,
      cta: { label: 'Open in TeamLink ATS', url: atsLink(r) }, note: 'Sign-in required. Sent to TeamLink internal HR.' }),
  };
}

async function sendOne(n) {
  const done = (status, to, err) => withUser(ENGINE, (c) => c.query(
    `select application_notice_done($1,$2,$3,$4,$5)`, [n.application_id, n.event, status, to || null, err || null]));
  try {
    const to = hrRecipient();
    if (!to) { await done('skipped', null, 'INTERNAL_HR_EMAIL is not set'); return 'skipped'; }
    const r = await load(n.application_id);
    if (!r) { await done('skipped', to, 'the application no longer exists'); return 'skipped'; }
    /* never "eligible" on a score the database does not hold as eligible */
    if (n.event === 'WALKIN_CANDIDATE_ELIGIBLE' && r.walkin_ai_eligibility !== 'eligible') {
      await done('skipped', to, `eligibility is ${r.walkin_ai_eligibility || 'not decided'}`); return 'skipped';
    }
    const msg = n.event === 'WALKIN_CANDIDATE_ELIGIBLE' ? buildEligibleHrEmail(r) : buildWalkinHrEmail(r);
    let out;
    try {
      out = await providers.email.send({ to, subject: msg.subject, html: msg.html, text: msg.text,
        vars: { to_name: 'TeamLink HR', subject: msg.subject, message: msg.text, notice_kind: n.event } });
    } catch (err) { out = { status: 'failed', error: err && err.message }; }
    const ok = !!out && (out.status === 'sent' || out.status === 'delivered');
    await done(ok ? 'sent' : 'failed', to, ok ? null : (out && (out.error || out.status)) || 'not sent');
    if (!ok) console.error(`[notices] ${n.event} for ${n.application_id} not sent: ${(out && (out.error || out.status)) || 'unknown'}`);
    return ok ? 'sent' : 'failed';
  } catch (err) {
    console.error(`[notices] ${n.event} for ${n.application_id} failed:`, err && err.message);
    await done('failed', null, err && err.message).catch(() => {});
    return 'failed';
  }
}

/** One pass: every notice due. Never throws. */
export async function runApplicationNoticeSweep({ limit = 25 } = {}) {
  const out = { sent: 0, failed: 0, skipped: 0 };
  let due = [];
  try {
    due = await withUser(ENGINE, async (c) => (await c.query(`select * from application_notices_claim($1)`, [limit])).rows);
  } catch (err) {
    console.error('[notices] claim failed:', err && err.message);
    return out;
  }
  for (const n of due) out[await sendOne(n)] += 1;
  return out;
}

let kicking = null;
/** Send what is due NOW (after an application is saved, after an interview is scored). */
export function kickApplicationNotices() {
  if (kicking) return kicking;
  kicking = new Promise((resolve) => setImmediate(resolve))
    .then(() => runApplicationNoticeSweep())
    .catch(() => null)
    .finally(() => { kicking = null; });
  return kicking;
}

export function startApplicationNoticeSweep() {
  const every = Number(process.env.APPLICATION_NOTICE_SWEEP_MS || 60 * 1000);
  let stopped = false; let running = false;
  const run = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const out = await runApplicationNoticeSweep();
      if (out.sent || out.failed) console.log(`[notices] ${out.sent} sent, ${out.failed} failed`);
    } finally { running = false; }
  };
  const first = setTimeout(run, 20 * 1000);
  const timer = setInterval(run, every);
  first.unref?.(); timer.unref?.();
  return () => { stopped = true; clearTimeout(first); clearInterval(timer); };
}
