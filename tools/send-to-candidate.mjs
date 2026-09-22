/**
 * Put a real candidate through the whole journey, to a real address.
 *
 *     node tools/send-to-candidate.mjs someone@gmail.com
 *
 * Registers that person, applies them to a live job, moves them through
 * the pipeline, completes the AI interview and extends an offer — so every
 * message the portal sends goes to THAT address, one after another, as it
 * would for a real candidate.
 *
 * Where those messages end up depends on one thing only:
 *
 *   EMAIL_SMTP_* points at a mailbox that accepts us  -> the real inbox
 *   EMAIL_SMTP_* points at tools/mail-inbox.mjs       -> http://localhost:2580
 *   EMAIL_SMTP_PASS is empty                          -> nothing is sent,
 *                                                        and every attempt
 *                                                        records `not_configured`
 *
 * Nothing about the application changes between those three. The address
 * on every message is the candidate's own, read from the database.
 */
import { chromium } from 'playwright';

const TO = process.argv[2];
// Only needed the SECOND time an address is used: registering signs the
// candidate in, but coming back needs their password like anybody else.
const EXISTING_PASSWORD = process.argv[3];
const BASE = (process.env.TL_URL || 'http://localhost:4323/').replace(/\/$/, '');
const PASSWORD = process.env.TL_PASSWORD || 'TeamLink@2026';

if (!TO || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(TO)) {
  console.log('\n  usage: node tools/send-to-candidate.mjs someone@example.com [their password]');
  console.log('         (the password is only needed if that address is already registered)\n');
  process.exit(1);
}

const browser = await chromium.launch();
const open = async () => {
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.TL && window.TL.ready === true, { timeout: 25000 });
  return {
    page,
    api: async (m, p, b) => {
      const r = await page.evaluate(([mm, pp, bb]) =>
        window.TL.api[mm](pp, bb).then(
          (ok) => ({ ok: true, value: ok }),
          (e) => ({ ok: false, code: e.code, message: e.message, details: e.details })),
        [m, p, b]);
      if (r.ok) return r.value;
      const err = new Error(`${r.code || 'FAILED'}: ${r.message || ''}` +
        (r.details ? ` ${JSON.stringify(r.details)}` : ''));
      err.code = r.code;
      throw err;
    },
  };
};

const step = (n, what) => console.log(`  ${n}. ${what}`);

const candidate = await open();
const recruiter = await open();

console.log(`\n  sending the whole journey to ${TO}\n`);

/* ---- the candidate ------------------------------------------------- */
const stamp = Date.now().toString(36);
let candidateId, applicationId, jobId, dispatch = [];

const reg = await candidate.api('post', '/auth/register', {
  name: (TO.split('@')[0] || 'Candidate').replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
  email: TO,
  password: `Journey@${stamp}`,
}).catch(async (e) => {
  // The server's code for this is EMAIL_TAKEN; both are accepted so a
  // rename on either side does not turn "run it twice" into a crash.
  if (e && (e.code === 'EMAIL_TAKEN' || e.code === 'EMAIL_IN_USE')) {
    console.log('  that address is already registered here; using the existing profile');
    return null;
  }
  throw e;
});

if (reg) {
  candidateId = reg.candidateId;
  step(1, `registered ${TO}  (password for signing in: Journey@${stamp})`);
} else {
  // Registering signs the candidate in; coming back does not. The journey
  // is driven AS the candidate on purpose - applying and interviewing as
  // somebody else would not be the thing this is meant to demonstrate.
  if (!EXISTING_PASSWORD) {
    console.log(`\n  ${TO} is already registered here, and this has to run as them.`);
    console.log('  Either use a different address, or pass their password:\n');
    console.log(`      node tools/send-to-candidate.mjs ${TO} <their password>\n`);
    await browser.close();
    process.exit(1);
  }
  const me = await candidate.api('post', '/auth/login',
    { email: TO, password: EXISTING_PASSWORD, role: 'candidate' });
  candidateId = me.session?.id || me.candidateId;
  step(1, `signed in as ${TO}`);
}

/* ---- apply --------------------------------------------------------- */
await candidate.page.evaluate(() => window.TL.refresh());
await candidate.page.waitForTimeout(600);

jobId = await candidate.page.evaluate(() => {
  const j = (DATA.jobs || []).find((x) => x.status === 'open' && !x.paused && !x.archived);
  return j ? j.id : null;
});
if (!jobId) throw new Error('there is no open job to apply to');

const applied = await candidate.api('post', '/applications', { jobId, source: 'portal' })
  .catch((e) => (e.code === 'DUPLICATE_APPLICATION' ? null : Promise.reject(e)));

if (applied) {
  applicationId = applied.application.id;
  dispatch.push(['application confirmation', applied.notify]);
  dispatch.push(['AI interview invitation + deadline', applied.aiInterview]);
  step(2, 'applied — confirmation and the AI interview invitation sent');
} else {
  const mine = await candidate.api('get', '/bootstrap');
  applicationId = (mine.data.applications || []).find((a) => a.jobId === jobId)?.id;
  step(2, 'already applied to that role — continuing with the existing application');
}

/* ---- the AI interview ---------------------------------------------- */
const session = await candidate.api('post', '/ai-interviews/session', { applicationId })
  .catch(() => null);

if (session) {
  step(3, `AI interview planned — ${session.questions.length} questions, due ` +
          `${new Date(session.expiresAt).toLocaleString('en-GB')}`);

  const ANSWER = 'I owned this end to end. I built the service, wrote the tests, ' +
    'shipped it to production and measured the result afterwards, which cut the ' +
    'manual work from about two days to three hours.';
  for (const q of session.questions) {
    await candidate.api('post', `/ai-interviews/${session.interviewId}/answer`,
      { seq: q.seq, transcript: ANSWER, answered: true, voicedMs: 24000 });
  }

  const done = await candidate.api('post', `/ai-interviews/${session.interviewId}/finish`, {});
  dispatch.push(['AI interview completed', done.notify?.completed]);
  dispatch.push(['AI interview score', done.notify?.scored]);
  step(4, `interview answered and graded on the server — ` +
          `${done.aiInterview.overallPercentage}% overall`);
}

/* ---- the recruiter moves them ---------------------------------------- */
await recruiter.api('post', '/auth/login',
  { email: 'recruiter@teamlink.com', password: PASSWORD, role: 'recruiter' })
  .catch(() => {});

// The stage ids are the ones in the `stages` table, not invented here:
// a stage that does not exist is refused, and the candidate hears nothing.
for (const [stage, note] of [
  ['shortlisted',         'Strong interview — moving you forward.'],
  ['interview_scheduled', 'The client would like to meet you this week.'],
  ['client_review',       'Your profile is with the client now.'],
]) {
  const r = await recruiter.api('put', `/applications/${applicationId}/status`, { stage, note })
    .catch((e) => { console.log(`     (stage ${stage}: ${e.code || e.message})`); return null; });
  if (r) { dispatch.push([`stage: ${stage}`, r.notify]); step(5, `moved to ${stage} — message sent`); }
}

const offer = await recruiter.api('post', '/offers', {
  applicationId,
  ctc: '18,00,000',
  joiningDate: new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10),
  notes: 'We would like you to join us.',
}).catch((e) => { console.log(`     (offer: ${e.code || e.message})`); return null; });
if (offer) { dispatch.push(['offer extended', offer.notify]); step(6, 'offer extended — message sent'); }

/* ---- what actually happened ------------------------------------------ */
console.log(`\n  every message above was addressed to ${TO}\n`);
console.log('  channel outcomes, as the database recorded them:\n');

let anySent = false;
for (const [what, n] of dispatch) {
  if (!n) continue;
  const st = n.delivery_status || {};
  if (Object.values(st).some((s) => s === 'sent' || s === 'delivered')) anySent = true;
  console.log(`    ${what.padEnd(34)} ` +
    ['email', 'sms', 'whatsapp', 'ivr'].map((c) => `${c}:${st[c] || '-'}`).join('  '));
}

console.log(anySent
  ? `\n  SENT. If EMAIL_SMTP_HOST is a real mail server, check ${TO}.\n` +
    '  If it is tools/mail-inbox.mjs, read them at http://localhost:2580\n'
  : '\n  NOTHING WAS SENT — no channel is configured.\n' +
    '  Every attempt was recorded as `not_configured`, which is the honest\n' +
    '  outcome: the portal did its part and there is no mailbox to send through.\n' +
    '  Run `npm run check:mail` to see what is missing.\n');

await browser.close();
