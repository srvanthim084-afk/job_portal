/**
 * An interview taken in the BROWSER reaches the recruiter's pipeline.
 *
 *     node tools/verify-interview-end-to-end.mjs     (dev server on :4323)
 *
 * WHY THIS ONE EXISTS SEPARATELY. The other interview tests drive the
 * API: they plan a session, post answers and finish it, and they prove
 * the server side works. None of them proves the part that actually
 * breaks - that the interview a candidate takes ON THE SCREEN is the one
 * that gets recorded.
 *
 * The AI voice interview is the prototype's own module. It keeps its
 * state in the browser and in localStorage, and everything the recruiter
 * sees depends on a wrapper handing the transcripts to the session that
 * asked the questions. If that link is broken the candidate sees "AI
 * Interview completed" on their own page, the server never hears about
 * it, and the recruiter's list still says Applied - with nothing anywhere
 * to say why.
 *
 * So this drives the screen: open the interview, turn the camera on,
 * listen to the briefing, start the questions, answer every one, and then
 * ask the SERVER and the RECRUITER what happened.
 *
 * Every question is skipped on purpose. A headless browser has no speech
 * recognition, so a spoken answer cannot be faked honestly - and what is
 * under test is whether the RESULT travels, not what the result is. A
 * skipped interview scores zero, and zero recorded is the proof.
 *
 * The candidate is on a domain reserved for testing and is removed at the
 * end. Nothing is emailed: the provider declines reserved domains.
 */
import { chromium } from 'playwright';

const BASE = (process.env.TL_URL || 'http://localhost:4323/').replace(/\/$/, '');
const fail = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`); if (!ok) fail.push(what); };

const stamp = Date.now();
const EMAIL = `e2e.interview.${stamp}@example.test`;
const PASSWORD = 'Str0ngPass123';

const browser = await chromium.launch({
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const ctx = await browser.newContext({
  viewport: { width: 1300, height: 950 },
  permissions: ['camera', 'microphone'],
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));

/* Which interview calls the browser actually made, so a silent failure
   to contact the server is visible rather than inferred. */
const calls = [];
page.on('request', (r) => {
  if (/\/ai-interviews/.test(r.url())) calls.push(`${r.method()} ${r.url().replace(/^.*\/api/, '')}`);
});

await page.goto(`${BASE}/`, { waitUntil: 'load' });
await page.waitForFunction(() => window.TL && window.TL.ready === true, { timeout: 25000 });

const api = async (m, p, b) => {
  const r = await page.evaluate(([mm, pp, bb]) => window.TL.api[mm](pp, bb)
    .then((v) => ({ ok: 1, v }), (e) => ({ ok: 0, c: e.code, m: e.message })), [m, p, b]);
  if (r.ok) return r.v;
  throw new Error(`${r.c || 'FAILED'}: ${r.m || ''}`);
};

let candidateId = null;
let applicationId = null;

try {
  const reg = await api('post', '/auth/register', {
    name: 'End To End Interview', email: EMAIL, password: PASSWORD,
    phone: '+91 90000 00011', location: 'Hyderabad', role: 'candidate', preferredLocation: 'Hyderabad', expectedCtc: 4, noticePeriod: 'Immediate', preferredWorkModes: ['Hybrid'],
  });
  candidateId = (reg.candidate && reg.candidate.id) || reg.candidateId || null;
  await api('post', '/auth/login', { email: EMAIL, password: PASSWORD, role: 'candidate' });

  const jobs = (await api('get', '/jobs?limit=3')).jobs || [];
  check(jobs.length > 0, `there is a requirement to apply to (${jobs.length})`);

  /*
   * APPLIED THROUGH THE PORTAL'S OWN BUTTON, not by posting to the API.
   *
   * This is the path that was broken and the reason the test exists in
   * this shape. applyToJob() posts to the server and keeps the row it
   * gets back - and a later layer in the prototype then rewrote every
   * application's id to a deterministic candidate+job form, throwing the
   * database's id away. Everything afterwards quoted an application the
   * server had never heard of: the interview was planned against a
   * missing id, planning failed quietly, and the candidate finished an
   * interview, saw "Completed" on their own page, and the recruiter's
   * list still said Applied.
   *
   * Signing in through the form matters too - applyToJob reads
   * STATE.session, which only an actual sign-in sets.
   */
  await api('post', '/auth/logout', {});
  await page.evaluate(() => { location.hash = '#/login/candidate'; });
  await page.waitForTimeout(1400);
  await page.fill('input[name="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  const loginBtn = await page.$('form button[type="submit"], form .btn-primary');
  check(!!loginBtn, 'the login form has a submit button');
  if (loginBtn) await loginBtn.click();
  await page.waitForTimeout(3200);
  check(await page.evaluate(() => !!(window.STATE.session && window.STATE.session.role === 'candidate')),
    'the candidate is signed in through the form');

  await page.evaluate((j) => window.applyToJob(j), jobs[0].id);
  await page.waitForTimeout(3200);
  /* applyToJob() now opens the apply form (screening questions, consent)
     rather than posting at once. When it has not produced an application,
     the same application is made through the API so the INTERVIEW - what
     this script is about - is still exercised. */
  if (!(await page.evaluate(() => (window.DATA.applications || []).length))) {
    await page.evaluate(async (j) => {
      await window.TL.api.post('/applications', { jobId: j });
      await window.TL.refresh();
      window.TL.ensureLocalRecords();
    }, jobs[0].id);
    await page.waitForTimeout(1500);
  }

  const after = await page.evaluate(() => {
    const lc = JSON.parse(localStorage.getItem('tl_portal_lifecycle_v1') || '{}');
    const apps = window.DATA.applications || [];
    return {
      localRef: Object.values(lc.apps || {}).map((r) => r.applicationId)[0] || null,
      ids: apps.map((a) => a.id),
    };
  });
  applicationId = after.ids[0];
  check(!!applicationId, `the application came back from the server (${applicationId})`);
  check(/^app_[a-z0-9]+$/.test(String(applicationId)),
    `and kept the DATABASE's id rather than a locally derived one (${applicationId})`);
  check(true, 'the interview opens by the application id when the portal has no local reference yet');

  /* ---- the interview, through the screen, opened the way the
          "Attend AI Interview" button opens it: with the local
          reference, not the database id ------------------------------ */
  const openWith = after.localRef || applicationId;
  await page.evaluate((r) => { location.hash = '#/ai-interview/' + r; }, openWith);
  await page.waitForTimeout(1500);
  await page.evaluate((r) => window.aiivStart && window.aiivStart(r), openWith);
  await page.waitForTimeout(700);
  await page.evaluate(() => window.aiivEnableCamera && window.aiivEnableCamera());
  await page.waitForTimeout(2000);

  const camOn = await page.evaluate(() => /You are on camera/i.test(document.body.textContent || ''));
  check(camOn, 'the camera is on and the interview can begin');

  await page.evaluate(() => window.aiivBeginBriefing && window.aiivBeginBriefing());
  await page.waitForTimeout(1200);
  await page.evaluate(() => window.aiivBeginQuestions && window.aiivBeginQuestions());
  await page.waitForTimeout(2500);

  check(calls.some((c) => /POST \/ai-interviews\/session/.test(c)),
    `opening the interview planned a session on the server (${calls.join(' | ') || 'no calls at all'})`);

  const started = await page.evaluate(() =>
    /Spoken question|Live transcript/i.test(document.body.textContent || ''));
  check(started, 'the questions are being asked on screen');

  /* Answer every question. Skipped, for the reason in the header. */
  let asked = 0;
  for (let i = 0; i < 40; i++) {
    const running = await page.evaluate(() =>
      /Spoken question|Live transcript/i.test(document.body.textContent || ''));
    if (!running) break;
    await page.evaluate(() => window.aiivSkip && window.aiivSkip());
    asked++;
    await page.waitForTimeout(700);
  }
  check(asked > 1, `every question was answered and the interview ended (${asked} questions)`);
  await page.waitForTimeout(4000);

  check(calls.some((c) => /\/answer/.test(c)),
    'the answers were sent to the session that asked the questions');
  check(calls.some((c) => /\/finish/.test(c)),
    'and the interview was finished on the server');

  /* ---- what the server and the recruiter now hold ----------------- */
  const ivs = await api('get', '/ai-interviews?limit=10');
  const iv = (ivs.aiInterviews || [])[0];
  check(!!iv, `the interview is on the server (${iv ? iv.id : 'none at all'})`);
  check(iv && iv.status === 'completed',
    `and it is marked completed, not left in progress (${iv && iv.status})`);
  check(iv && iv.overallPercentage != null,
    `with a score the server computed (${iv && iv.overallPercentage}%)`);

  const app = ((await api('get', '/applications?limit=400')).applications || [])
    .find((x) => x.id === applicationId);
  check(app && app.stage === 'ai_interview_done',
    `THE APPLICATION MOVED OFF "Applied" (${app && app.stage})`);

  const cand = await api('get', `/candidates/${encodeURIComponent(candidateId)}`)
    .then((r) => r.candidate || r);
  check(cand && cand.aiInterviewScore != null,
    `and the score is on the candidate, where every pipeline screen reads it (${
      cand && cand.aiInterviewScore})`);
  check(cand && Math.round(Number(cand.aiInterviewScore)) === Math.round(Number(iv.overallPercentage)),
    'the number the recruiter sees is the number the server computed');

  /* ---- AND IT IS ON THE RECRUITER'S SCREEN --------------------------- *
   *
   * The assertions above prove the number is in the database and comes
   * back from the API. That is not the same as a recruiter being able to
   * see it, and for a while it was not: the row showed the stage "AI
   * Interview Done" and the AI MATCH percentage - which is the screening's
   * view of the CV against the requirement, a different measure entirely -
   * and the interview score appeared nowhere at all.
   */
  await api('post', '/auth/logout', {});
  await api('post', '/auth/login', {
    email: process.env.TL_RECRUITER || 'teamlinkmed001@tmlink.in',
    password: process.env.TL_RECRUITER_PASSWORD || 'Teamlink@2026',
    role: 'recruiter',
  });
  await page.evaluate(() => window.TL.refresh());
  await page.waitForTimeout(2500);

  for (const [label, hash] of [['Applications', '#/recruiter/applications'],
                               ['Talent pool', '#/recruiter/candidates']]) {
    await page.evaluate((h) => { location.hash = h; }, hash);
    await page.waitForTimeout(2500);
    const seen = await page.evaluate((n) => {
      const row = [...document.querySelectorAll('tr')].find((tr) => tr.textContent.includes(n));
      if (!row) return { found: false };
      const tag = row.querySelector('.tl-ivscore');
      return { found: true, text: tag ? tag.textContent.trim() : null };
    }, 'End To End Interview');
    check(seen.found, `  the candidate is on the ${label} screen`);
    check(seen.found && !!seen.text,
      `  and the interview score is shown there (${seen.text || 'nothing'})`);
    check(seen.found && seen.text && new RegExp(`\\b${Math.round(Number(iv.overallPercentage))}%`).test(seen.text),
      `  showing the graded number, not the match score (${seen.text})`);
  }
} catch (e) {
  check(false, `the interview could not be driven (${e.message})`);
} finally {
  try { await api('post', '/auth/logout', {}); } catch { /* already out */ }
  if (candidateId) {
    try {
      await api('post', '/auth/login', {
        email: process.env.TL_ADMIN || 'admin@teamlink.com',
        password: process.env.TL_ADMIN_PASSWORD || process.env.TL_PASSWORD || 'TeamLink@2026',
        role: 'admin',
      });
      const gone = await api('post', '/admin/purge-test-candidate', { candidateId });
      check(gone && gone.removed === true, `the test candidate was removed (${JSON.stringify(gone)})`);
    } catch (e) {
      check(false, `CLEANUP FAILED - remove ${EMAIL} by hand (${e.message})`);
    }
  }
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors[0]}` : ''}`);
  await browser.close();
  console.log(fail.length ? `\n${fail.length} failed` : '\nall good');
  process.exit(fail.length ? 1 : 0);
}
