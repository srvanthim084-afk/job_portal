/**
 * Apply Now while signed out, in a real browser.
 *
 *   1  signed out, Apply Now      -> registration form, "You're applying for: <job>"
 *   2  refresh on that form       -> still applying for the same job
 *   3  registration refused       -> still on the form, same job
 *   4  registration succeeds      -> the application is submitted for that job
 *   5  signed in, Apply Now       -> applies directly, no form
 *   6  apply again                -> still one application
 *   7  Log in instead (one wrong password first) -> applied for the same job
 *   8  Cancel                     -> back on the job, nothing remembered
 *   9  the server, asked directly while signed out -> 401
 *
 * Creates accounts, so it refuses :4323. Run against an isolated instance:
 *   TL_URL=http://127.0.0.1:4416/ node tools/verify-apply-auth.mjs
 */
import { chromium } from 'playwright';

const BASE = (process.env.TL_URL || 'http://127.0.0.1:4416/').replace(/\/?$/, '/');
const url = new URL(BASE);
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.port === '4323') {
  console.error(`Refusing to run against ${BASE}: this creates accounts. Use an isolated instance.`);
  process.exit(2);
}

let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  PASS  ${name}`); }
  catch (e) { console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n')[0]}`); failed += 1; }
};
const must = (c, m) => { if (!c) throw new Error(m); };
const stamp = Date.now().toString(36);
const phone = () => '9' + String(Math.floor(1e8 + Math.random() * 9e8));

const browser = await chromium.launch();

async function open(ctx, hash) {
  const page = await ctx.newPage();
  await page.goto(BASE + hash);
  await page.waitForFunction(() => window.TL && TL.ready === true, null, { timeout: 30000 });
  await page.waitForTimeout(600);
  return page;
}
const ready = (page) => page.waitForFunction(() => window.TL && TL.ready === true, null, { timeout: 30000 });
const wizardAway = (page) => page.evaluate(() => {
  document.querySelectorAll('.tlpo-ov .tlpo-btn.ghost, .tlpo-ov .tlpo-skip').forEach((b) => b.click());
});
const bannerText = (page) => page.evaluate(() => ((document.querySelector('.tl-apply-intent') || {}).innerText || '').split(String.fromCharCode(10)).join(' '));
const clickApply = (page) => page.evaluate(() => {
  const b = Array.from(document.querySelectorAll('#app button.btn-primary.btn-block'))
    .find((x) => /Apply Now|Easy Apply/.test(x.textContent) && x.offsetParent);
  if (!b) return false;
  b.click(); return true;
});
/* What a candidate meets on the way since the later features: the resume
   score hint under 60 ("Apply anyway"), and one-click apply's "fill these
   first" sheet ("Apply without them"). Both are optional; answered the way
   a candidate in a hurry would. Screening questions are switched off on
   this script's jobs - verify-screening-questions.mjs covers them. */
const settlePrompts = async (page) => {
  for (let i = 0; i < 3; i++) {
    const hit = await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button'))
        .find((x) => /^\s*(Apply anyway|Apply without them)\s*$/.test(x.textContent) && x.offsetParent);
      if (!b) return false; b.click(); return true;
    }).catch(() => false);
    if (!hit) return;
    await page.waitForTimeout(2000);
  }
};
const myApps = (page, jobId) => page.evaluate((id) => TL.api.get('/applications')
  .then((o) => o.applications.filter((a) => a.jobId === id).length), jobId);

/* Three open TeamLink jobs to apply to, published by the seed recruiter
   of this isolated instance. */
const RECRUITER = process.env.TL_RECRUITER_EMAIL || 'recruiter@teamlink.com';
const RECRUITER_PW = process.env.TL_RECRUITER_PASSWORD || process.env.DEV_PASSWORD || 'TeamLink@2026';
const jobs = [];
{
  const rc = await browser.newContext();
  const rp = await open(rc, '#/');
  const out = await rp.evaluate(async ({ e, p, s }) => {
    try {
      await TL.api.post('/auth/login', { email: e, password: p, role: 'recruiter' });
      const boot = await TL.api.get('/bootstrap');
      const myCo = ((boot.data.recruiters || []).find((r) => boot.session && r.id === boot.session.id) || {}).companyId; const co = (boot.data.companies || []).find((x) => x.id === myCo) || (boot.data.companies || [])[0];
      const made = [];
      for (const t of ['Store Associate', 'Delivery Coordinator', 'Front Office Executive']) {
        const j = await TL.api.post('/jobs', { title: `${t} ${s}`, companyId: co.id, location: 'Hyderabad',
          mode: 'Onsite', exp: '0-2 yrs', pay: '₹3 LPA', salaryMin: 3, salaryMax: 3, type: 'Full-time',
          status: 'open', skills: ['Communication'], description: 'Verification job - safe to delete.' });
        await TL.api.put(`/jobs/${j.job.id}/screening-questions`, { questions: [] });
        made.push({ id: j.job.id, title: j.job.title });
      }
      return made;
    } catch (err) { return String(err.message); }
  }, { e: RECRUITER, p: RECRUITER_PW, s: stamp });
  must(Array.isArray(out), 'could not publish the test jobs: ' + out);
  jobs.push(...out);
  await rc.close();
}
const [J1, J2, J3] = jobs;

/* An existing account, for the email clash and the log-in path. */
const existing = { email: `apply.existing.${stamp}@tl-verify.test`, password: `Apply${stamp}9` };
{
  const ctx = await browser.newContext();
  const p = await open(ctx, '#/');
  const r = await p.evaluate((b) => TL.api.post('/auth/register', b).then(() => 'ok', (e) => e.message), {
    name: 'Apply Existing', ...existing, phone: phone(),
    preferredLocation: 'Hyderabad', expectedCtc: 4, noticePeriod: 'Immediate', preferredWorkModes: ['Hybrid'],
  });
  must(r === 'ok', 'could not create the existing account: ' + r);
  await ctx.close();
}

console.log(`\napply now while signed out  (${BASE})`);

const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const p = await open(ctx, '#/job/' + J1.id);

await check('1. signed out, Apply Now opens registration for that job', async () => {
  must(await clickApply(p), 'no Apply button on the job page: ' + await p.evaluate(() => location.hash + ' ' + ((document.querySelector('#app') || {}).innerText || '').slice(0, 200).split(String.fromCharCode(10)).join(' / ')));
  await p.waitForTimeout(800);
  must(/^#\/register\/candidate/.test(await p.evaluate(() => location.hash)), 'not on the registration page');
  const b = await bannerText(p);
  must(b.includes("You're applying for") && b.includes(J1.title), `banner: ${b}`);
  must(/Log in to apply/.test(b), 'no Log in option');
  must(await myApps(p, J1.id).catch(() => 0) === 0, 'nothing may be applied yet');
});

await check('2. a refresh keeps the same job', async () => {
  await p.reload(); await ready(p); await p.waitForTimeout(800);
  const b = await bannerText(p);
  must(b.includes(J1.title), `after refresh: ${b}`);
});

/*
 * 0109: THE FORM IS IN SEVEN STEPS NOW (teamlink-registration.js), with the
 * owner's required fields - branch, total experience, preferred role, a
 * resume, confirm password and two consents - so this fills each step
 * where it lives (TLRegistration.reveal) instead of one long page. The
 * account, the job banner and the continue-after-register are unchanged.
 */
const RESUME = process.env.TL_TEST_RESUME || 'var/test-resumes/Resume - Sravanthi.pdf';
const reveal = (id) => p.evaluate((i) => window.TLRegistration.reveal(i), id);
const put = async (id, v) => { await reveal(id); await p.fill('#' + id, v); };
async function fillForm(email) {
  await put('regName', 'Apply Flow ' + stamp);
  await put('regMobile', phone());
  await put('regLocation', 'Hyderabad');
  await put('regEmail', email);
  await reveal('regQualification');
  await p.selectOption('#regQualification', 'B.Tech');
  await put('regSpecialization', 'Commerce');
  await reveal('regExpBand');
  await p.selectOption('#regExpBand', 'fresher');
  await put('regSkills', 'Excel, Communication');
  await put('regPrefRole', 'Store Associate');
  await put('regPrefLocation', 'Hyderabad');
  await put('regExpSalary', '4');
  await p.selectOption('#regNotice', 'Immediate');
  await p.evaluate(() => { const m = document.querySelector('#regWorkModeGroup input[type="checkbox"]'); if (m && !m.checked) m.click(); });
  await reveal('regPassword');
  if (!(await p.evaluate(() => !!(window.TL && TL.pendingResume)))) {
    await p.evaluate(() => window.triggerRegisterResumeUpload());
    await p.setInputFiles('#regResumeFileInput', RESUME);
    await p.waitForFunction(() => /analyzed|could|couldn/i.test((document.getElementById('regResumeStatus') || {}).textContent || ''), null, { timeout: 30000 });
  }
  await put('regPassword', 'Apply' + stamp + '7');
  await put('regConfirmPassword', 'Apply' + stamp + '7');
  await p.evaluate(() => {
    window.TLRegistration.go(7);
    ['regConsentComms', 'regConsentTerms', 'regConsentResume'].forEach((id) => { const c = document.getElementById(id); if (!c.checked) c.click(); });
    validateRegisterForm();
  });
}

await check('3. a refused registration keeps the job (email already registered)', async () => {
  await fillForm(existing.email);
  /* The form now says so itself, under the email, before anything is
     sent; and if it is sent anyway the server refuses it the same way. */
  await p.waitForTimeout(1200);
  const inline = await p.evaluate(() => (document.getElementById('regEmailErr') || {}).textContent || '');
  const blocked = await p.evaluate(() => document.getElementById('regSubmitBtn').disabled);
  if (!blocked) { await p.click('#regSubmitBtn'); await p.waitForTimeout(1800); }
  must(/already exists/i.test(await p.evaluate(() => (document.getElementById('regEmailErr') || {}).textContent || '')),
    'no "already exists" message (inline: ' + inline + ')');
  must(/^#\/register\/candidate/.test(await p.evaluate(() => location.hash)), 'left the form');
  must((await bannerText(p)).includes(J1.title), 'the job was lost');
  must(await p.evaluate(() => !STATE.session), 'should still be signed out');
});

await check('4. registration succeeds and the application continues for that job', async () => {
  await put('regEmail', `apply.new.${stamp}@tl-verify.test`);
  await p.evaluate(() => { window.TLRegistration.go(7); validateRegisterForm(); });
  must(await p.evaluate(() => !document.getElementById('regSubmitBtn').disabled),
    'the form did not validate: ' + await p.evaluate(() => JSON.stringify(window.TLRegistration.problems())));
  await p.click('#regSubmitBtn');
  await p.waitForFunction(() => STATE.session && STATE.session.role === 'candidate', null, { timeout: 20000 });
  await p.waitForTimeout(3500);
  await wizardAway(p);
  await settlePrompts(p);
  await wizardAway(p);
  must(await myApps(p, J1.id) === 1, 'no application for the job after registering');
  const at = await p.evaluate(() => location.hash);
  must(at.includes(J1.id) || /^#\/apply-success\//.test(at), 'not on the job or its confirmation: ' + at);
  must(await p.evaluate(() => TLApplyAuth.intent()) === null, 'the job is still remembered');
});

await check('5. signed in, Apply Now applies directly', async () => {
  await p.evaluate((id) => { location.hash = '#/job/' + id; }, J2.id);
  await p.waitForTimeout(1200);
  await wizardAway(p);
  must(await clickApply(p), 'no Apply button');
  await p.waitForTimeout(1500);
  /* One-click apply (teamlink-portal-upgrades.js): a profile without a
     resume or experience is first asked for them; "Apply without them"
     is the direct apply this check has always made. */
  await settlePrompts(p);
  await p.waitForTimeout(1500);
  await wizardAway(p);
  must(!/register/.test(await p.evaluate(() => location.hash)), 'sent to registration while signed in');
  must(await myApps(p, J2.id) === 1, 'not applied');
});

await check('6. applying again does not make a second application', async () => {
  /* Fired as a click would, not awaited: a pending Apply chain handed back
     to Playwright whole has crashed the tab in the harness (a click never
     reads it). */
  await p.evaluate((id) => { window.applyToJob(id); }, J2.id);
  await settlePrompts(p);
  await p.waitForTimeout(1500);
  const direct = await p.evaluate((id) => TL.api.post('/applications', { jobId: id }).then(() => 'created', (e) => e.code || e.message), J2.id);
  must(direct === 'DUPLICATE_APPLICATION', 'server answered ' + direct);
  must(await myApps(p, J2.id) === 1, 'more than one application');
});
await ctx.close();

await check('7. Log in instead: a wrong password keeps the job, the right one applies', async () => {
  const c = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const q = await open(c, '#/job/' + J3.id);
  must(await clickApply(q), 'no Apply button');
  await q.waitForTimeout(800);
  await q.click('.tl-apply-intent a[href="#/login/candidate"]');
  await q.waitForTimeout(800);
  let b = await q.evaluate(() => (document.querySelector('.auth-form .tl-apply-intent') || {}).innerText || '');
  must(b.includes(J3.title), 'no banner on the login page: ' + b);
  await q.fill('.auth-form input[name="email"]', existing.email);
  await q.fill('.auth-form input[name="password"]', 'wrong-password-1');
  await q.click('.auth-form button[type="submit"]');
  await q.waitForTimeout(1800);
  b = await q.evaluate(() => (document.querySelector('.tl-apply-intent') || {}).innerText || '');
  must(b.includes(J3.title), 'the job was lost after a wrong password');
  const kept = await q.inputValue('.auth-form input[name="email"]');
  await q.fill('.auth-form input[name="email"]', existing.email);
  await q.fill('.auth-form input[name="password"]', existing.password);
  await q.click('.auth-form button[type="submit"]');
  await q.waitForFunction(() => STATE.session && STATE.session.role === 'candidate', null, { timeout: 20000 })
    .catch(async () => { throw new Error('not signed in (email kept after the failure: "' + kept + '"): ' + await q.evaluate(() => location.hash + ' | ' + ((document.getElementById('tlLoginError') || {}).textContent || '') + ' | ' + Array.from(document.querySelectorAll('.toast, .tl-toast')).map((t) => t.textContent).join(' / '))); });
  await q.waitForTimeout(3000);
  await wizardAway(q);
  await settlePrompts(q);
  await wizardAway(q);
  must(await myApps(q, J3.id) === 1, 'no application after logging in');
  const at = await q.evaluate(() => location.hash);
  must(at.includes(J3.id) || /^#\/apply-success\//.test(at), 'not on the job or its confirmation: ' + at);
  await c.close();
});

await check('8. Cancel goes back to the job and forgets it', async () => {
  const c = await browser.newContext();
  const q = await open(c, '#/job/' + J1.id);
  must(await clickApply(q), 'no Apply button');
  await q.waitForTimeout(800);
  await q.click('.tl-apply-intent button');
  await q.waitForTimeout(800);
  must(await q.evaluate(() => location.hash) === '#/job/' + J1.id, 'not back on the job');
  must(await q.evaluate(() => TLApplyAuth.intent()) === null, 'still remembered');
  await c.close();
});

await check('9. the server refuses an application from a signed-out browser', async () => {
  const c = await browser.newContext();
  const q = await open(c, '#/');
  const st = await q.evaluate((id) => fetch('/api/applications', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jobId: id }) }).then((r) => r.status), J1.id);
  must(st === 401 || st === 403, 'status ' + st);
  await c.close();
});

await browser.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
