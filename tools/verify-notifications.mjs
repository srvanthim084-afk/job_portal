/**
 * A message at every stage, not just the first.
 *
 * Only ONE event ever reached email, SMS or WhatsApp: the invitation sent
 * when an application was confirmed. A stage move, a scheduled interview, a
 * completed AI interview, a score, an offer — all created an in-app
 * notification and stopped there, so a candidate who did not open the
 * portal again heard nothing after applying.
 *
 * This walks one application through the whole pipeline and checks that
 * each step produced BOTH an in-app notification and a delivery attempt on
 * every channel, with the outcome recorded.
 *
 * It does not require a working mail server. With no credentials every
 * channel records `not_configured`, and that is the correct, checkable
 * outcome — the point is that the attempt happened and was recorded,
 * rather than the event passing silently.
 *
 *   node tools/verify-notifications.mjs      (needs npm run dev on :4323)
 */
import { chromium } from 'playwright';

const BASE = process.env.TL_URL || 'http://localhost:4323/';
const PASSWORD = process.env.TL_PASSWORD || 'TeamLink@2026';

let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  PASS  ${name}`); }
  catch (e) { console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n')[0]}`); failed++; }
};
const must = (c, m) => { if (!c) throw new Error(m); };

const browser = await chromium.launch();

async function open() {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForFunction(() => window.TL && window.TL.ready === true, { timeout: 25000 });
  const api = (m, p, b) => page.evaluate(([mm, pp, bb]) => window.TL.api[mm](pp, bb), [m, p, b]);
  return { ctx, page, api };
}

const CHANNELS = ['email', 'sms', 'whatsapp', 'ivr'];
const RECORDED = ['sent', 'delivered', 'failed', 'not_configured', 'pending'];

/** Every channel must have been ATTEMPTED and its outcome recorded. */
function assertAttempted(notify, where) {
  must(notify, `${where}: nothing came back from the dispatcher`);
  const st = notify.delivery_status || {};
  for (const ch of CHANNELS) {
    must(st[ch], `${where}: ${ch} was never attempted`);
    must(RECORDED.includes(st[ch]), `${where}: ${ch} recorded "${st[ch]}"`);
  }
}

const candidate = await open();
const recruiter = await open();
const email = `notify.${Date.now()}@example.test`;
let candidateId, applicationId, jobId;

await check('a candidate applies', async () => {
  const reg = await candidate.api('post', '/auth/register',
    { name: 'Notify Tester', email, password: 'NotifyTest@2026', phone: '9876500077' });
  candidateId = reg.candidateId;
  await candidate.page.evaluate(() => window.TL.refresh());
  await candidate.page.waitForTimeout(500);

  // It must be a job the RECRUITER can manage, or the stage moves later on
  // are refused by row-level security and the failure looks like a
  // notification bug instead of a test picking the wrong company.
  jobId = await candidate.page.evaluate(() => {
    const rec = DATA.recruiters.find((r) => r.email === 'recruiter@teamlink.com');
    const j = DATA.jobs.find((x) => x.status === 'open' && x.companyId === (rec || {}).companyId)
           || DATA.jobs.find((x) => x.status === 'open');
    return j ? j.id : null;
  });
  must(jobId, 'no open job');
  const app = await candidate.api('post', '/applications', { jobId, source: 'portal' });
  applicationId = app.application.id;
  assertAttempted(app.notify, 'application submitted');
});

await check('the recruiter signs in', async () => {
  const ok = await recruiter.page.evaluate(([pw]) =>
    window.TL.api.post('/auth/login',
      { email: 'recruiter@teamlink.com', password: pw, role: 'recruiter' })
      .then(() => true, () => false), [PASSWORD]);
  must(ok, 'the recruiter could not sign in');
});

/* ------------------------------------------------------------------ *
 * every stage
 * ------------------------------------------------------------------ */
for (const [stage, label] of [
  ['shortlisted', 'Shortlisted'],
  ['interview_scheduled', 'Interview Scheduled'],
  ['selected', 'Selected'],
]) {
  // eslint-disable-next-line no-loop-func
  await check(`moving to "${label}" messages the candidate`, async () => {
    const res = await recruiter.api('put', `/applications/${applicationId}/status`,
      { stage, note: `Moved to ${label} by the verification run.` });
    must(res.application.stage === stage, `the stage is ${res.application.stage}`);
    assertAttempted(res.notify, `stage ${stage}`);
  });
}

await check('scheduling an interview messages the candidate', async () => {
  const res = await recruiter.api('post', '/interviews', {
    candidateId, jobId, date: '2026-10-01', time: '11:00', mode: 'Video',
  });
  must(res.interview, 'no interview came back');
  assertAttempted(res.notify, 'interview scheduled');
});

await check('completing the AI interview messages the candidate', async () => {
  const start = await candidate.api('post', '/ai-interviews/session',
    { applicationId, count: 5 });
  for (const q of start.questions) {
    await candidate.api('post', `/ai-interviews/${start.interviewId}/answer`,
      { seq: q.seq, transcript: 'I led that work end to end and shipped it with tests.' });
  }
  const fin = await candidate.api('post', `/ai-interviews/${start.interviewId}/finish`, {});
  must(fin.notify, 'the interview finished without dispatching anything');
  assertAttempted(fin.notify.completed, 'AI interview completed');
  assertAttempted(fin.notify.scored, 'AI score available');
});

await check('extending an offer messages the candidate', async () => {
  const res = await recruiter.api('post', '/offers',
    { applicationId, ctc: 2200000, joiningDate: '2026-11-03' });
  must(res.offer, 'no offer came back');
  assertAttempted(res.notify, 'offer extended');
});

/* ------------------------------------------------------------------ *
 * what the candidate can actually see
 * ------------------------------------------------------------------ */
await check('the candidate has an in-app notification for each step', async () => {
  const types = await candidate.page.evaluate(() =>
    window.TL.api.get('/bootstrap').then((b) => (b.data.notifications || []).map((n) => n.type)));

  for (const t of ['APPLICATION_SUBMITTED', 'APPLICATION_STATUS',
                   'INTERVIEW_SCHEDULED', 'AI_INTERVIEW_COMPLETED',
                   'AI_SCORE_AVAILABLE', 'OFFER_EXTENDED']) {
    must(types.includes(t), `no in-app notification of type ${t} (have: ${[...new Set(types)].join(', ')})`);
  }
});

await check('every attempt is recorded against the application', async () => {
  const rec = await recruiter.api('get', `/applications/${applicationId}/notifications`);
  // The endpoint calls the log `attempts`.
  must(rec && Array.isArray(rec.attempts), 'no delivery log came back');
  must(rec.attempts.length >= 24,
    `only ${rec.attempts.length} delivery rows for 7 events x 4 channels`);

  const channels = new Set(rec.attempts.map((r) => r.channel));
  for (const ch of CHANNELS) must(channels.has(ch), `${ch} has no delivery rows at all`);

  // Nothing may claim it was sent when no provider is configured.
  const claimedSent = rec.attempts.filter((r) => ['sent', 'delivered'].includes(r.status));
  const configured = await recruiter.page.evaluate(() =>
    fetch('/api/health').then((r) => r.json()).then((h) => h.providers || {}));
  for (const r of claimedSent) {
    must(configured[r.channel] === 'configured',
      `${r.channel} reported "${r.status}" while it is ${configured[r.channel]}`);
  }
});

await candidate.ctx.close();
await recruiter.ctx.close();
await browser.close();

console.log(failed === 0
  ? '\n  NOTIFICATIONS VERIFIED — a message at every stage, every attempt recorded\n'
  : `\n  ${failed} check(s) FAILED\n`);
process.exit(failed ? 1 : 0);
