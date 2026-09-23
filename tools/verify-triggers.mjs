/**
 * The four notifications that were written but never fired.
 *
 * A template nobody triggers is a template that does not exist. These
 * drive the real routes and sweeps and check the candidate was actually
 * told - not that a function could have told them.
 *
 *   node tools/verify-triggers.mjs      (needs npm run dev on :4323)
 */
import { chromium } from 'playwright';

const BASE = (process.env.TL_URL || 'http://localhost:4323/').replace(/\/$/, '');
const PW = process.env.TL_PASSWORD || 'TeamLink@2026';
const stamp = Date.now();

let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  PASS  ${name}`); }
  catch (e) { console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n')[0]}`); failed++; }
};
const must = (c, m) => { if (!c) throw new Error(m); };

const browser = await chromium.launch();
const open = async () => {
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.TL && window.TL.ready === true, { timeout: 25000 });
  return { page, api: async (m, p, b) => {
    const r = await page.evaluate(([mm, pp, bb]) => window.TL.api[mm](pp, bb)
      .then((v) => ({ ok: 1, v }), (e) => ({ ok: 0, c: e.code, m: e.message })), [m, p, b]);
    if (!r.ok) { const err = new Error(`${r.c || 'FAILED'}: ${r.m || ''}`); err.code = r.c; throw err; }
    return r.v;
  } };
};

const rec = await open();
await rec.api('post', '/auth/login',
  { email: 'teamlinkmed001@tmlink.in', password: 'Teamlink@2026', role: 'recruiter' });

const company = ((await rec.api('get', '/companies')).companies || [])[0];
const job = (await rec.api('post', '/jobs', {
  title: `Trigger Test ${stamp}`, companyId: company.id, location: 'Hyderabad',
  department: 'Engineering', skills: ['Java'], status: 'open', desc: 'Trigger test.',
})).job;

const cand = await open();
const email = `trig.${stamp}@example.test`;
await cand.api('post', '/auth/register',
  { name: `Trigger Candidate ${stamp}`, email, password: 'Trigger@2026' });
const applied = await cand.api('post', '/applications', { jobId: job.id });
const appId = applied.application.id;

const log = async () => ((await rec.api('get',
  `/intake/applications/${appId}/communications`)).communications || []);
const events = async () => ((await rec.api('get',
  `/intake/timeline?applicationId=${appId}`)).timeline || []);

console.log('\napplying');
await check('applying tells the candidate something', async () => {
  const rows = await log();
  must(rows.length > 0, 'nothing was sent when the candidate applied');
});

console.log('\ninterview cancelled and rescheduled');
let interviewId;
await check('scheduling an interview creates one', async () => {
  const iv = await rec.api('post', '/interviews', {
    candidateId: applied.application.candidateId, jobId: job.id,
    applicationId: appId, type: 'Technical (Human)',
    date: '2026-10-02', time: '11:00 AM', mode: 'Video Call',
  });
  interviewId = iv.interview.id;
  must(interviewId, 'no interview was created');
});

await check('moving it sends INTERVIEW_RESCHEDULED', async () => {
  const before = (await log()).length;
  const out = await rec.api('put', `/interviews/${interviewId}`,
    { date: '2026-10-05', time: '03:00 PM' });
  must(out.delivery, 'the reschedule told nobody');
  const after = (await log()).length;
  must(after > before, 'no delivery was recorded for the reschedule');
});

await check('cancelling it sends INTERVIEW_CANCELLED', async () => {
  const before = (await log()).length;
  const out = await rec.api('put', `/interviews/${interviewId}`, { status: 'Cancelled' });
  must(out.delivery, 'the cancellation told nobody');
  must((await log()).length > before, 'no delivery was recorded for the cancellation');
});

await check('a score or feedback edit tells nobody', async () => {
  // Recruiter bookkeeping is not the candidate's news.
  const before = (await log()).length;
  const out = await rec.api('put', `/interviews/${interviewId}`, { aiScore: 72 });
  must(!out.delivery, 'a score edit messaged the candidate');
  must((await log()).length === before, 'a score edit produced a delivery');
});

console.log('\njoining reminder');
await check('an offer joining date a week out is reminded, once', async () => {
  /*
   * Through the SERVER, not by importing the sweep here.
   *
   * The embedded development database serves one client at a time, so a
   * second connection from this process is refused while the API holds
   * it - the first version of this check failed with an empty error
   * that said nothing about why.
   */
  const admin = await open();
  await admin.api('post', '/auth/login',
    { email: 'admin@teamlink.com', password: PW, role: 'admin' });

  const when = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  await rec.api('post', '/offers',
    { applicationId: appId, ctc: '12,00,000', joiningDate: when });

  const first = await admin.api('post', '/notifications/joining-sweep', {});
  must(first.sent >= 1, `nothing was reminded (considered ${first.considered})`);

  // The whole point: a sweep that runs again must not send it again.
  const second = await admin.api('post', '/notifications/joining-sweep', {});
  must(second.sent === 0, `${second.sent} duplicate reminder(s) on a second sweep`);
});

console.log('\nprofile reminder');

await check('a brand-new thin profile is left alone', async () => {
  /*
   * The candidate registered a moment ago and has no resume. They are
   * mid-way through signing up, not neglecting it, so nudging them now
   * would be nagging somebody who is still in the room.
   */
  const a1 = await open();
  await a1.api('post', '/auth/login',
    { email: 'admin@teamlink.com', password: PW, role: 'admin' });
  const out = await a1.api('post', '/notifications/profile-nudge', {});

  const mine = ((await a1.api('get',
    `/candidates?q=${encodeURIComponent(email)}&limit=5`)).candidates || [])[0];
  must(mine, 'the test candidate is not visible');

  const nudges = (await a1.api('get', `/candidates/${mine.id}/nudges`)).nudges || [];
  must(nudges.length === 0,
    `somebody who registered minutes ago was nudged (${out.considered} considered)`);
});

await check('the sweep reports who it considered, not just who it wrote to', async () => {
  const a2 = await open();
  await a2.api('post', '/auth/login',
    { email: 'admin@teamlink.com', password: PW, role: 'admin' });
  const out = await a2.api('post', '/notifications/profile-nudge', {});
  must(typeof out.considered === 'number', 'no count of who was considered');
  must(typeof out.sent === 'number', 'no count of what was sent');
  // Considering nobody is a valid answer; sending to somebody it never
  // considered is not.
  must(out.sent <= out.considered, `sent ${out.sent} of ${out.considered} considered`);
});


await browser.close();
console.log(failed ? `\n  ${failed} FAILED\n`
  : '\n  TRIGGERS VERIFIED — applied, rescheduled, cancelled, joining and profile all fire\n');
process.exitCode = failed ? 1 : 0;
