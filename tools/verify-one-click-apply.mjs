/**
 * Apply Now is one click (0118), in a real browser.
 *
 *   TL_URL=http://127.0.0.1:4424/ node tools/verify-one-click-apply.mjs
 *
 * Creates accounts and applications, so it refuses :4323 - run it against
 * an isolated instance (see tools/verify-registration.mjs).
 *
 *   A  signed in -> Apply Now -> "Application Submitted Successfully" and
 *      an Application ID at once; no application form, no questions
 *   B  signed out -> Apply Now -> Email / Mobile -> an existing account
 *      signs in -> the application is submitted automatically
 *   B2 signed out, new email -> registration (resume first) -> the
 *      application is submitted automatically after the account exists
 *   C  a profile with no resume, skills or location still applies
 *   D  applying again: "You have already applied", no second application,
 *      the job shows "✓ Applied"
 *   E  the application is in the pipeline with its job, recruiter, source
 *   F  "Complete Profile" opens the profile, separately
 *   G  the application was screened (AI match) as every application is
 *      ... and at phone width (390px) the box and the confirmation fit
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const BASE = (process.env.TL_URL || 'http://127.0.0.1:4424/').replace(/\/?$/, '/');
const url = new URL(BASE);
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.port === '4323') {
  console.error(`Refusing to run against ${BASE}: this creates accounts. Use an isolated instance.`);
  process.exit(2);
}
const PASSWORD = process.env.TL_PASSWORD || 'TeamLink@2026';
const fail = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`); if (!ok) fail.push(what); };
const stamp = Date.now().toString(36);
const mobile = () => '9' + String(Math.floor(100000000 + Math.random() * 899999999));

const browser = await chromium.launch();
async function open(hash, viewport = { width: 1280, height: 900 }) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(String(e.message)));
  await page.goto(BASE + hash);
  await page.waitForFunction(() => window.TL && TL.ready === true, null, { timeout: 30000 });
  await page.waitForTimeout(700);
  return page;
}
const api = (page, method, path, body) => page.evaluate(({ m, p, b }) =>
  window.TL.api[m](p, b).then((r) => ({ ok: true, r }), (e) => ({ ok: false, code: e.code, msg: e.message })),
  { m: method, p: path, b: body });

/* An open TeamLink job (not external, not a walk-in that has closed). */
const scout = await open('#/');
const jobs = await scout.evaluate(() => (DATA.openJobs ? DATA.openJobs() : DATA.jobs)
  .filter((j) => !/^xjob_/.test(j.id) && j.status !== 'closed' && !j.paused && !j.archived)
  .map((j) => ({ id: j.id, title: j.title })));
await scout.context().close();
check(jobs.length >= 3, `open TeamLink jobs to apply to (${jobs.length})`);
const [J1, J2, J3] = jobs;

/* A signed-in candidate with an EMPTY profile: no resume, no skills, no location. */
async function freshCandidate(page, tag) {
  const email = `oneclick.${tag}.${stamp}@mailbox-teamlink-tests.in`;
  const reg = await api(page, 'post', '/auth/register', {
    name: 'One Click ' + tag, email, password: 'OneClick' + stamp + '7', phone: mobile(),
    preferredLocation: 'Hyderabad', expectedCtc: 4, noticePeriod: 'Immediate', preferredWorkModes: ['Office'],
    consent: { terms: true, communication: true, resumeProcessing: true },
  });
  if (!reg.ok) throw new Error('could not register a test candidate: ' + reg.msg);
  await page.evaluate(() => TL.refresh());
  return { email, password: 'OneClick' + stamp + '7' };
}

/* ---- A + C: signed in, empty profile, one click ------------------------ */
const page = await open('#/');
const me = await freshCandidate(page, 'a');
const before = await api(page, 'get', '/applications/one-click/check');
check(before.ok && before.r.ready === false && before.r.missing.includes('resume'),
  `C: the profile is incomplete (missing ${before.ok ? before.r.missing.join(', ') : before.msg})`);
await page.evaluate((id) => { location.hash = '#/job/' + id; }, J1.id);
await page.waitForTimeout(1200);
const applyBtn = page.locator('button:has-text("Apply"):not([disabled])').first();
check(await applyBtn.count() > 0, 'A: the job page has an Apply button');
/* The page re-renders as data arrives; a locator re-resolves the button. */
await applyBtn.click({ timeout: 10000 })
  .catch(() => page.evaluate((id) => window.applyToJob(id), J1.id));
await page.waitForSelector('#tl1cDone', { timeout: 20000 }).catch(() => {});
const done = (await page.textContent('#fcrModalHost').catch(() => '') || '').replace(/\s+/g, ' ');
check(/Application Submitted Successfully/.test(done), 'A: "Application Submitted Successfully"');
check(/TL-APP-\d{4}-\d+/.test(done), `A: an Application ID (${(/TL-APP-[\d-]+/.exec(done) || ['none'])[0]})`);
check(/You can complete or update your profile anytime\./.test(done), 'A: "You can complete or update your profile anytime."');
check(/View Application/.test(done) && /Complete Profile/.test(done), 'A: [View Application] [Complete Profile]');
const noForm = await page.evaluate(() => !document.querySelector('.tlaf, #tlafForm, .tlsq-ov, #tlpuToastHost .tlpu-sheet')
  && !/answered|Notice Period|Current CTC|Highest Qualification/i.test((document.getElementById('fcrModalHost') || {}).textContent || ''));
check(noForm, 'A: no application form, no screening questions, no "N of N answered"');
const mine = await api(page, 'get', '/applications');
const app1 = mine.ok ? (mine.r.applications || mine.r || []).find((a) => a.jobId === J1.id) : null;
check(!!app1, 'C: the application exists although the profile is incomplete');

/* ---- D: applying again ---------------------------------------------------- */
await page.evaluate(() => fcrCloseModal());
await page.evaluate((id) => window.applyToJob(id), J1.id);
await page.waitForSelector('#tl1cAlready', { timeout: 10000 }).catch(() => {});
check(/You have already applied for this job\./.test(await page.textContent('#fcrModalHost').catch(() => '') || ''),
  'D: "You have already applied for this job."');
await page.evaluate(() => fcrCloseModal());
await page.evaluate(() => render());
await page.waitForTimeout(500);
check(await page.evaluate(() => /✓ Applied/.test(document.body.textContent)), 'D: the job shows "✓ Applied"');
const twice = await api(page, 'post', '/applications/one-click', { jobId: J1.id });
check(twice.ok && twice.r.existing === true, 'D: the server returns the same application, never a second');

/* ---- F: Complete Profile, separately ------------------------------------- */
await page.evaluate((id) => window.applyToJob(id), J2.id);
await page.waitForSelector('#tl1cDone', { timeout: 20000 }).catch(() => {});
/* A real click: it fails if anything (the profile prompt) covers the confirmation. */
const clicked = await page.click('[data-tl1c-go="profile"]', { timeout: 8000 }).then(() => true, () => false);
check(clicked, 'F: nothing covers the confirmation - Complete Profile is clickable');
await page.waitForTimeout(1500);
check(/^#\/candidate\/profile/.test(await page.evaluate(() => location.hash)), 'F: Complete Profile opens the profile');
check(await page.evaluate(() => !!document.querySelector('#tlpoHost .tlpo-card, .cap-edit, .tlps-ov, #fcrModalHost .modal')),
  'F: ...with the existing profile builder open');
check(page.errors.length === 0, `no page errors (${page.errors.join(' | ')})`);

/* ---- E + G: the pipeline, as the admin sees it ---------------------------- */
const admin = await open('#/');
const login = await api(admin, 'post', '/auth/login', { email: 'admin@teamlink.com', password: PASSWORD, role: 'admin' });
check(login.ok, 'E: admin signs in');
await admin.evaluate(() => TL.refresh());
const all = await api(admin, 'get', '/applications');
const rows = all.ok ? (all.r.applications || all.r || []) : [];
const row = rows.find((a) => app1 && a.id === app1.id);
check(!!row, 'E: the application is in the pipeline');
if (row) {
  check(row.jobId === J1.id && row.stage, `E: linked to the job, with a pipeline stage (${row.stage})`);
  check(!!row.source, `E: source kept (${row.source})`);
  check(row.matchScore !== undefined || row.aiScore !== undefined, `G: screened - AI match ${row.matchScore ?? row.aiScore}`);
}

/* ---- B: signed out, existing account ------------------------------------- */
const out = await open('#/job/' + J3.id);
await out.evaluate((id) => window.applyToJob(id), J3.id);
await out.waitForSelector('#tl1cForm', { timeout: 10000 }).catch(() => {});
const box = (await out.textContent('#fcrModalHost').catch(() => '') || '').replace(/\s+/g, ' ');
check(/Apply to/.test(box) && /Email \/ Mobile Number/.test(box), 'B: "Apply to <job>" with Email / Mobile Number only');
await out.fill('#tl1cId', me.email);
await out.click('#tl1cGo');
await out.waitForSelector('#tl1cPw', { state: 'visible', timeout: 10000 }).catch(() => {});
await out.fill('#tl1cPw', me.password);
await out.click('#tl1cGo');
await out.waitForSelector('#tl1cDone', { timeout: 30000 }).catch(() => {});
check(/Application Submitted Successfully/.test(await out.textContent('#fcrModalHost').catch(() => '') || ''),
  'B: signed in, and the application was submitted automatically');

/* ---- B2: signed out, a new person registers (resume first) --------------- */
const DIR = resolve('var/test-resumes'); mkdirSync(DIR, { recursive: true });
const newEmail = `oneclick.new.${stamp}@mailbox-teamlink-tests.in`;
const RES = resolve(DIR, `oneclick-${stamp}.txt`);
writeFileSync(RES, ['PRIYA SHARMA', 'Data Analyst', `Email: ${newEmail} | Phone: +91 ${mobile()}`, '',
  'SKILLS', 'SQL, Excel, Power BI, Python', '', 'EDUCATION', 'B.Sc (Statistics), Osmania University, 2021, 78%'].join('\n'));
const nw = await open('#/job/' + J2.id);
await nw.evaluate((id) => window.applyToJob(id), J2.id);
await nw.waitForSelector('#tl1cId', { timeout: 10000 });
await nw.fill('#tl1cId', newEmail);
await nw.click('#tl1cGo');
await nw.waitForSelector('#tlrfFile', { state: 'attached', timeout: 20000 }).catch(() => {});
check(/^#\/register\/candidate/.test(await nw.evaluate(() => location.hash)), 'B2: a new email goes to registration');
await nw.setInputFiles('#tlrfFile', RES);
await nw.waitForSelector('#tlrfLoc', { timeout: 90000 });
await nw.fill('#tlrfLoc', 'Hyderabad');
await nw.fill('#tlrfPrefIn', 'Hyderabad'); await nw.press('#tlrfPrefIn', 'Enter');
await nw.selectOption('#tlrfNotice', 'Immediate');
await nw.check('#tlrfModes input[value="Office"]');
await nw.fill('#tlrfSal', '5');
await nw.check('#tlrfTerms'); await nw.check('#tlrfComm');
await nw.click('[data-tlrf="sendcode"]');
await nw.waitForSelector('.tlrf-dev b', { timeout: 20000 }).catch(() => {});
const code = await nw.textContent('.tlrf-dev b').catch(() => '');
check(/^\d{6}$/.test(String(code).trim()), 'B2: an email code (development server shows it)');
await nw.fill('#tlrfCode', String(code).trim());
await nw.click('[data-tlrf="verify"]');
await nw.waitForSelector('#tlrfEmail[readonly]', { timeout: 20000 }).catch(() => {});
await nw.fill('#tlrfPw', 'NewPerson9pass'); await nw.fill('#tlrfPw2', 'NewPerson9pass');
await nw.click('[data-tlrf="create"]');
await nw.waitForSelector('#tl1cDone', { timeout: 60000 }).catch(() => {});
check(/Application Submitted Successfully/.test(await nw.textContent('#fcrModalHost').catch(() => '') || ''),
  'B2: registered, and the application was submitted automatically');
const nApps = await api(nw, 'get', '/applications');
check(nApps.ok && (nApps.r.applications || nApps.r || []).some((a) => a.jobId === J2.id), 'B2: the application is on the new account');

/* ---- phone width: the box and the confirmation fit ---------------------- */
const J4 = jobs[3] || J3;
const ph = await open('#/job/' + J4.id, { width: 390, height: 844 });
await ph.evaluate((id) => window.applyToJob(id), J4.id);
await ph.waitForSelector('#tl1cForm', { timeout: 10000 }).catch(() => {});
check(await ph.evaluate(() => document.documentElement.scrollWidth - window.innerWidth <= 2 && !!document.getElementById('tl1cId')),
  'phone: the Email / Mobile box fits, no sideways scroll');
await ph.evaluate(() => fcrCloseModal());
const lg = await api(ph, 'post', '/auth/login', { email: me.email, password: me.password, role: 'candidate' });
await ph.evaluate(() => TL.refresh());
await ph.waitForTimeout(800);
await ph.evaluate((id) => window.applyToJob(id), J4.id);
await ph.waitForSelector('#tl1cDone', { timeout: 20000 }).catch(() => {});
const fits = await ph.evaluate(() => {
  const b = document.querySelector('[data-tl1c-go="profile"]');
  const r = b ? b.getBoundingClientRect() : null;
  return { over: document.documentElement.scrollWidth - window.innerWidth, btn: !!r && r.right <= window.innerWidth && r.left >= 0 };
});
check(lg.ok && fits.over <= 2 && fits.btn, `phone: the confirmation fits (${JSON.stringify(fits)})`);
await ph.screenshot({ path: resolve(DIR, `one-click-phone-${stamp}.png`) });

await browser.close();
console.log(fail.length ? `\n${fail.length} FAILED` : '\nall passed');
process.exit(fail.length ? 1 : 0);
