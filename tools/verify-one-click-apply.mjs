/**
 * Apply Now is one click (0118), in a real browser.
 *
 *   TL_URL=http://127.0.0.1:4424/ node tools/verify-one-click-apply.mjs
 *
 * Creates accounts and applications, so it refuses :4323 - run it against
 * an isolated instance (see tools/verify-registration.mjs).
 *
 *   A   profile complete -> one click: the button says "Applying…" and is off,
 *       then "Applied ✓"; a toast "Applied successfully to <title> at <company>";
 *       no form, no modal; the Applications page lists it at once as Applied today
 *   A2  a double tap creates one application
 *   U   Undo in the toast (five seconds) takes the application back
 *   R   a failure: error toast with Retry, the button is "Apply Now" again;
 *       Retry applies
 *   D   already applied: "Applied ✓" from the start, after a refresh, on Search
 *       Jobs; the server refuses a second one
 *   P   resume missing -> "Please complete your profile to apply" [Complete
 *       Profile] [Cancel]; Cancel applies nothing; Complete Profile -> resume
 *       -> back on the job and applied by itself
 *   X   an external job is listed on the Applications page as "Applied (External)"
 *   E/G the application is in the pipeline with its job, source and AI match
 *   B   signed out -> Email / Mobile -> existing account signs in -> applied
 *   B2  signed out, new email -> registration (resume first) -> applied
 *   H   an unbuilt profile whose "Build your profile" box is up
 *   M   phone width: single tap, bottom toast, no sheet or form
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
const DIR = resolve('var/test-resumes'); mkdirSync(DIR, { recursive: true });
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');

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
const toastText = (page) => page.evaluate(() => (document.getElementById('tl1cToastHost') || {}).textContent || '');
const noModal = (page) => page.evaluate(() => {
  const host = document.getElementById('fcrModalHost');
  return !document.querySelector('.tlaf, #tlafForm, .tlsq-ov, .tlpu-sheet')
    && !(host && host.textContent.trim());
});
const myApps = async (page) => {
  const r = await api(page, 'get', '/applications');
  return r.ok ? (r.r.applications || r.r || []) : [];
};

/* An open TeamLink job (not external, not a walk-in that has closed). */
const scout = await open('#/');
const jobs = await scout.evaluate(() => (DATA.openJobs ? DATA.openJobs() : DATA.jobs)
  .filter((j) => !/^xjob_/.test(j.id) && j.status !== 'closed' && !j.paused && !j.archived
    && !(window.TLWalkinJobs && TLWalkinJobs.isWalkin(j)))
  .map((j) => ({ id: j.id, title: j.title })));
await scout.context().close();
check(jobs.length >= 5, `open TeamLink jobs to apply to (${jobs.length})`);
const [J1, J2, J3, J4, J5] = jobs;

/* A signed-in candidate; withResume: a resume on file, so the profile is complete. */
async function freshCandidate(page, tag, withResume = true) {
  const email = `oneclick.${tag}.${stamp}@mailbox-teamlink-tests.in`;
  const reg = await api(page, 'post', '/auth/register', {
    name: 'One Click ' + tag, email, password: 'OneClick' + stamp + '7', phone: mobile(),
    preferredLocation: 'Hyderabad', expectedCtc: 4, noticePeriod: 'Immediate', preferredWorkModes: ['Office'],
    consent: { terms: true, communication: true, resumeProcessing: true },
  });
  if (!reg.ok) throw new Error('could not register a test candidate: ' + reg.msg);
  await page.evaluate(() => TL.refresh());
  if (withResume) await addResume(page);
  return { email, password: 'OneClick' + stamp + '7' };
}
async function addResume(page) {
  await page.evaluate(async () => {
    const f = new File([new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52, 10, 37, 37, 69, 79, 70, 10])], 'resume.pdf', { type: 'application/pdf' });
    await TL.uploadResume(f);
    await TL.refresh();
  });
  await page.waitForTimeout(600);
}
/* The Apply Now button of the page's job (the page re-renders as data arrives). */
const jobBtn = (page) => page.locator('#app button.btn-block:not([disabled]):has-text("Apply")').first();

/* ---- A: profile complete, one click ------------------------------------- */
const page = await open('#/');
const me = await freshCandidate(page, 'a');
const before = await page.evaluate(() => DATA.candidateById(STATE.session.id));
check(!!(before && before.resumeFile), 'A: the profile is complete (a resume is on file)');
await page.evaluate((id) => { location.hash = '#/job/' + id; }, J1.id);
await page.waitForSelector('#app button.btn-primary.btn-block', { timeout: 15000 });
await page.waitForTimeout(800);
check(/Apply/.test(await jobBtn(page).textContent()), 'A: the job page has an Apply Now button');
/* Slow the server a little so the "Applying…" state can be seen. */
await page.route('**/api/applications/one-click', async (route) => { await new Promise((r) => setTimeout(r, 900)); route.continue(); });
await jobBtn(page).click({ timeout: 10000 });
await page.waitForFunction(() => Array.from(document.querySelectorAll('button')).some((b) => b.textContent.trim() === 'Applying…' && b.disabled), null, { timeout: 4000 })
  .then(() => check(true, 'A: the button says "Applying…" and is disabled'), () => check(false, 'A: the button says "Applying…" and is disabled'));
check(await noModal(page), 'A: no form, modal, drawer or page opened');
await page.waitForSelector('#tl1cDone', { timeout: 20000 }).catch(() => {});
await page.unroute('**/api/applications/one-click');
const t1 = await toastText(page);
check(new RegExp('Applied successfully to ' + J1.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(t1), `A: toast "Applied successfully to ${J1.title} at <company>" (${t1.replace(/\s+/g, ' ').slice(0, 90)})`);
check(/ at /.test(t1), 'A: the toast names the company');
check(await page.evaluate(() => Array.from(document.querySelectorAll('#app button')).some((b) => b.textContent.trim() === 'Applied ✓' && b.disabled)),
  'A: the button is now "Applied ✓" and disabled');
check(await noModal(page), 'A: ...still no form or modal');
const apps1 = await myApps(page);
const app1 = apps1.find((a) => a.jobId === J1.id);
check(!!app1, 'A: the application exists');
await page.evaluate(() => { location.hash = '#/candidate/applications'; });
await page.waitForTimeout(1200);
const listText = await page.evaluate(() => document.getElementById('app').textContent.replace(/\s+/g, ' '));
check(listText.includes(J1.title), 'A: the Applications page lists it at once');
check(/Applied/.test(listText), 'A: ...with the status "Applied"');
check(/Applied\s*·?\s*(Today|\d{1,2}\s\w{3}|\d{4}-\d{2}-\d{2})|Today/i.test(listText), 'A: ...dated today');

/* ---- A2: a double tap creates one application -------------------------- */
await page.evaluate((id) => { location.hash = '#/job/' + id; }, J2.id);
await page.waitForSelector('#app button.btn-primary.btn-block', { timeout: 15000 });
await page.waitForTimeout(800);
await page.evaluate(() => {
  const b = document.querySelector('#app button.btn-primary.btn-block');
  b.click(); b.click();
});
await page.evaluate((id) => { window.applyToJob(id); window.applyToJob(id); }, J2.id);
await page.waitForSelector('#tl1cDone, #tl1cAlready', { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(1200);
const apps2 = (await myApps(page)).filter((a) => a.jobId === J2.id);
check(apps2.length === 1, `A2: a double tap created ${apps2.length} application (1 expected)`);

/* ---- U: Undo ------------------------------------------------------------ */
await page.evaluate((id) => { location.hash = '#/job/' + id; }, J3.id);
await page.waitForSelector('#app button.btn-primary.btn-block', { timeout: 15000 });
await page.waitForTimeout(800);
await jobBtn(page).click({ timeout: 10000 });
await page.waitForFunction((t) => ((document.getElementById('tl1cMsg') || {}).textContent || '').includes(t) && !!document.getElementById('tl1cUndo'), J3.title, { timeout: 20000 }).catch(() => {});
check(await page.evaluate(() => !!document.getElementById('tl1cUndo')), 'U: the toast offers Undo');
await page.click('#tl1cUndo', { timeout: 5000 }).catch((e) => console.log('undo click:', String(e.message).split('\n')[0]));
await page.waitForTimeout(1500);
check(!(await myApps(page)).some((a) => a.jobId === J3.id), 'U: Undo took the application back');
check(await page.evaluate(() => Array.from(document.querySelectorAll('#app button')).some((b) => /^Apply/.test(b.textContent.trim()) && !b.disabled)),
  'U: the button is "Apply Now" again');

/* ---- R: a failure, then Retry ------------------------------------------- */
await page.waitForTimeout(500);
let failNext = true;
await page.route('**/api/applications/one-click', (route) => {
  if (failNext) { failNext = false; return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'BOOM', message: 'Something went wrong. Please retry.' } }) }); }
  return route.continue();
});
await jobBtn(page).click({ timeout: 10000 });
await page.waitForSelector('#tl1cFail', { timeout: 15000 }).catch(() => {});
check(await page.evaluate(() => !!document.getElementById('tl1cRetry')), 'R: the error toast has a Retry action');
check(await page.evaluate(() => Array.from(document.querySelectorAll('#app button')).some((b) => /^Apply/.test(b.textContent.trim()) && !b.disabled)),
  'R: the button is back to "Apply Now"');
await page.click('#tl1cRetry').catch(() => {});
await page.waitForSelector('#tl1cDone', { timeout: 20000 }).catch(() => {});
check(await page.evaluate(() => !!document.getElementById('tl1cDone')), 'R: Retry applied');
await page.unroute('**/api/applications/one-click');
check((await myApps(page)).filter((a) => a.jobId === J3.id).length === 1, 'R: ...once');

/* ---- D: already applied, refresh, Search Jobs, the server -------------- */
await page.reload();
await page.waitForFunction(() => window.TL && TL.ready === true && window.STATE && STATE.session, null, { timeout: 30000 });
await page.waitForTimeout(1500);
await page.evaluate((id) => { location.hash = '#/job/' + id; }, J1.id);
await page.waitForTimeout(1500);
check(await page.evaluate(() => Array.from(document.querySelectorAll('#app button')).some((b) => b.textContent.trim() === 'Applied ✓' && b.disabled)),
  'D: after a refresh the job still shows "Applied ✓" (disabled)');
await page.evaluate(() => { location.hash = '#/jobs'; });
await page.waitForTimeout(1800);
check(await page.evaluate(() => /Applied ✓/.test(document.getElementById('app').textContent)), 'D: Search Jobs shows "Applied ✓" on the card');
check(await noModal(page), 'D: Search Jobs: no form');
const twice = await api(page, 'post', '/applications/one-click', { jobId: J1.id });
check(twice.ok && twice.r.existing === true, 'D: the server returns the same application, never a second');
const raw = await api(page, 'post', '/applications', { jobId: J1.id });
check(!raw.ok || raw.r.existing === true || raw.code === 'DUPLICATE_APPLICATION', 'D: the plain apply API refuses a duplicate too');
const one = (await myApps(page)).filter((a) => a.jobId === J1.id);
check(one.length === 1, 'D: still one application for the job');
check(page.errors.length === 0, `no page errors (${page.errors.join(' | ')})`);

/* ---- X: an external application is listed as "Applied (External)" -------- */
/* The external-jobs feed is off on a plain dev server, so the server's answer
   is stood in; Apply Now on an external job itself is covered by
   verify-external-compliance.mjs. */
await page.route('**/api/external/applications', (route) => route.fulfill({
  status: 200, contentType: 'application/json',
  body: JSON.stringify({ applications: [{ id: 'xapp_1', externalJobId: 'xjob_1', jobTitle: 'Accounts Executive', company: 'Acme Ltd', sourceName: 'Naukri', status: 'clicked', statusLabel: 'Apply Clicked', createdAt: new Date().toISOString() }] }),
}));
await page.evaluate(() => { location.hash = '#/candidate/search'; });
await page.waitForTimeout(500);
await page.evaluate(() => { location.hash = '#/candidate/applications'; });
await page.waitForSelector('#tl1cExt', { timeout: 10000 }).catch(() => {});
const extTxt = await page.evaluate(() => (document.getElementById('tl1cExt') || {}).textContent || '');
check(/Accounts Executive/.test(extTxt) && /Acme Ltd/.test(extTxt) && /Applied \(External\)/.test(extTxt),
  'X: the Applications page lists the external job as "Applied (External)"');
check(await page.evaluate(() => /Application ID|Open details/.test((document.getElementById('tl1cExt') || {}).textContent || '') === false),
  'X: ...separate from the TeamLink applications (no ATS stage claimed)');
await page.unroute('**/api/external/applications');

/* ---- P: resume missing -> prompt -> Cancel -> Complete Profile -> auto-apply */
const pp = await open('#/');
const pMe = await freshCandidate(pp, 'p', false);
await pp.evaluate((id) => { location.hash = '#/job/' + id; }, J4.id);
await pp.waitForSelector('#app button.btn-primary.btn-block', { timeout: 15000 });
await pp.waitForTimeout(1000);
await pp.evaluate(() => { if (typeof window.tlpoClose === 'function') tlpoClose(); });
await jobBtn(pp).click({ timeout: 10000 });
await pp.waitForSelector('#tl1cProfile', { timeout: 10000 }).catch(() => {});
const pt = await pp.evaluate(() => (document.getElementById('tl1cProfile') || {}).textContent || '');
check(/Please complete your profile to apply/.test(pt), 'P: "Please complete your profile to apply"');
check(await pp.evaluate(() => !!document.getElementById('tl1cPpGo') && !!document.getElementById('tl1cPpCancel')), 'P: [Complete Profile] [Cancel]');
check(!(await pp.evaluate(() => !!document.getElementById('tlafForm'))), 'P: ...and no application form');
await pp.click('#tl1cPpCancel');
await pp.waitForTimeout(500);
check(!(await myApps(pp)).some((a) => a.jobId === J4.id), 'P: Cancel applied nothing');
await jobBtn(pp).click({ timeout: 10000 });
await pp.waitForSelector('#tl1cPpGo', { timeout: 10000 });
await pp.click('#tl1cPpGo');
await pp.waitForTimeout(1500);
check(/^#\/candidate\/(resume|profile)/.test(await pp.evaluate(() => location.hash)), 'P: Complete Profile goes to the profile / resume step');
await addResume(pp);                                  // the candidate uploads the resume
await pp.waitForSelector('#tl1cDone', { timeout: 25000 }).catch(() => {});
check(await pp.evaluate(() => /^#\/job\//.test(location.hash)), 'P: ...then back to the job');
check(await pp.evaluate(() => !!document.getElementById('tl1cDone')), 'P: ...and the application was sent by itself');
check((await myApps(pp)).some((a) => a.jobId === J4.id), 'P: the application exists');

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
const out = await open('#/job/' + J5.id);
await out.evaluate((id) => window.applyToJob(id), J5.id);
await out.waitForSelector('#tl1cForm', { timeout: 10000 }).catch(() => {});
const box = (await out.textContent('#fcrModalHost').catch(() => '') || '').replace(/\s+/g, ' ');
check(/Apply to/.test(box) && /Email \/ Mobile Number/.test(box), 'B: "Apply to <job>" with Email / Mobile Number only');
await out.fill('#tl1cId', me.email);
await out.click('#tl1cGo');
await out.waitForSelector('#tl1cPw', { state: 'visible', timeout: 10000 }).catch(() => {});
await out.fill('#tl1cPw', me.password);
await out.click('#tl1cGo');
await out.waitForSelector('#tl1cDone', { timeout: 30000 }).catch(() => {});
check(await out.evaluate(() => !!document.getElementById('tl1cDone')), 'B: signed in, and the application was submitted automatically');

/* ---- B2: signed out, a new person registers (resume first) --------------- */
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
await nw.waitForFunction(() => { const n = document.getElementById('tlrfName'); return n && n.value; }, null, { timeout: 90000 });
await nw.fill('#tlrfEmail', newEmail); await nw.dispatchEvent('#tlrfEmail', 'change');
await nw.fill('#tlrfLoc', 'Hyderabad'); await nw.dispatchEvent('#tlrfLoc', 'change');
await nw.fill('#tlrfPref', 'Hyderabad'); await nw.dispatchEvent('#tlrfPref', 'change');
await nw.fill('#tlrfSal', '5'); await nw.dispatchEvent('#tlrfSal', 'change');
await nw.selectOption('#tlrfNotice', 'Immediate'); await nw.dispatchEvent('#tlrfNotice', 'change');
if (!(await nw.inputValue('#tlrfQual'))) { await nw.selectOption('#tlrfQual', 'B.Sc'); await nw.dispatchEvent('#tlrfQual', 'change'); }
await nw.check('#tlrfTerms'); await nw.check('#tlrfResumeOk');
await nw.click('[data-tlrf="sendcode"]');
await nw.waitForSelector('.tlrf-dev b', { timeout: 20000 }).catch(() => {});
const code = await nw.textContent('.tlrf-dev b').catch(() => '');
check(/^\d{6}$/.test(String(code).trim()), 'B2: an email code (development server shows it)');
await nw.fill('#tlrfCode', String(code).trim());
await nw.click('[data-tlrf="verify"]');
await nw.waitForSelector('#tlrfEmail[readonly]', { timeout: 20000 }).catch(() => {});
/* the mobile OTP (development: shown on the page) */
if (await nw.$('[data-tlrf="sendotp"]')) {
  if (!(await nw.inputValue('#tlrfPhone'))) { await nw.fill('#tlrfPhone', mobile()); await nw.dispatchEvent('#tlrfPhone', 'change'); }
  await nw.click('[data-tlrf="sendotp"]');
  await nw.waitForSelector('#tlrfOtp', { timeout: 20000 }).catch(() => {});
  const otp = await nw.evaluate(() => [...document.querySelectorAll('#tlrfHost .tlrf-dev b')].map((b) => b.textContent).find((t) => /^\d{6}$/.test(t)));
  await nw.fill('#tlrfOtp', otp || '');
  await nw.click('[data-tlrf="verifyotp"]');
  await nw.waitForSelector('[data-tlrf="changephone"]', { timeout: 20000 }).catch(() => {});
}
await nw.fill('#tlrfPw', 'NewPerson9pass'); await nw.fill('#tlrfPw2', 'NewPerson9pass');
await nw.click('[data-tlrf="create"]');
await nw.waitForSelector('#tl1cDone, #tl1cProfile', { timeout: 60000 }).catch(() => {});
check(await nw.evaluate(() => !!document.getElementById('tl1cDone')), 'B2: registered with a resume, and the application was submitted automatically');
check((await myApps(nw)).some((a) => a.jobId === J2.id), 'B2: the application is on the new account');

/* ---- H: an unbuilt profile, arriving the usual way: the "Build your profile"
        box is up on the home page, and must not stand between the candidate
        and Apply Now on a job page ------------------------------------------ */
const hp = await open('#/');
await freshCandidate(hp, 'h');
await hp.reload();
await hp.waitForFunction(() => window.TL && TL.ready === true && window.STATE && STATE.session, null, { timeout: 30000 });
await hp.waitForTimeout(1500);
const upOnHome = await hp.evaluate(() => !!document.querySelector('#tlpoHost .tlpo-ov'));
await hp.evaluate((id) => { location.hash = '#/job/' + id; }, J3.id);
await hp.waitForTimeout(1800);
check(!(await hp.evaluate(() => !!document.querySelector('#tlpoHost .tlpo-ov'))),
  `H: the profile prompt does not cover the job page (it was ${upOnHome ? 'up' : 'not up'} on the home page)`);
await jobBtn(hp).click({ timeout: 10000 }).catch(() => {});
await hp.waitForSelector('#tl1cDone', { timeout: 20000 }).catch(() => {});
check(await hp.evaluate(() => !!document.getElementById('tl1cDone') && !document.getElementById('tlafForm')),
  'H: one click on Apply Now submits the application - no form, no questions');

/* ---- M: phone width: single tap, bottom toast, no sheet or form ---------- */
const ph = await open('#/', { width: 390, height: 844 });
await freshCandidate(ph, 'm');
await ph.evaluate((id) => { location.hash = '#/job/' + id; }, J5.id);
await ph.waitForSelector('#app button.btn-primary.btn-block', { timeout: 15000 });
await ph.waitForTimeout(1000);
await ph.evaluate(() => { if (typeof window.tlpoClose === 'function') tlpoClose(); });
await jobBtn(ph).click({ timeout: 10000 });
await ph.waitForSelector('#tl1cDone', { timeout: 20000 }).catch(() => {});
const fits = await ph.evaluate(() => {
  const t = document.getElementById('tl1cDone');
  const r = t ? t.getBoundingClientRect() : null;
  return {
    toast: !!r, over: document.documentElement.scrollWidth - window.innerWidth,
    inside: !!r && r.left >= 0 && r.right <= window.innerWidth,
    bottom: !!r && r.top > window.innerHeight / 2,
    form: !!document.querySelector('.tlaf, #tlafForm, .tlpu-sheet, #fcrModalHost .modal'),
  };
});
check(fits.toast && fits.inside && fits.bottom && !fits.form && fits.over <= 2, `M: one tap, bottom toast, no sheet or form (${JSON.stringify(fits)})`);
await ph.screenshot({ path: resolve(DIR, `one-click-phone-${stamp}.png`) });

await browser.close();
console.log(fail.length ? `\n${fail.length} FAILED` : '\nall passed');
process.exit(fail.length ? 1 : 0);
