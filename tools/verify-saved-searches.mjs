/**
 * Save this search, end to end, through the real controls.
 *
 *   register -> search -> "Save this search" -> Save
 *   -> refresh -> still there on Job Alerts
 *   -> a recruiter publishes a matching job -> "1 new" appears
 *   -> Run search -> the new job is in the results
 *
 * It CREATES a candidate account and a job, so it refuses to run against
 * the live portal (:4323) - start an isolated instance first, as in the
 * project notes (LOAD_SEED=true, its own DEV_DB_DIR / PG_PORT / storage,
 * mail pointed at a sink), then:
 *
 *   TL_URL=http://127.0.0.1:4415/ node tools/verify-saved-searches.mjs
 *
 * The candidate is on a reserved .test domain, so even a misconfigured
 * instance has nobody to mail. The recruiter is the dev server's seeded
 * account (TL_RECRUITER_EMAIL / TL_RECRUITER_PASSWORD to override).
 */
import { chromium } from 'playwright';

const BASE = (process.env.TL_URL || 'http://127.0.0.1:4415/').replace(/\/?$/, '/');
const url = new URL(BASE);
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.port === '4323') {
  console.error(`Refusing to run against ${BASE}: this creates an account and a job.`
    + '\nPoint TL_URL at an isolated local instance (not :4323).');
  process.exit(2);
}
const RECRUITER = process.env.TL_RECRUITER_EMAIL || 'recruiter@teamlink.com';
const RECRUITER_PW = process.env.TL_RECRUITER_PASSWORD || process.env.DEV_PASSWORD || 'TeamLink@2026';

let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  PASS  ${name}`); }
  catch (e) { console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n')[0]}`); failed += 1; }
};
const must = (cond, msg) => { if (!cond) throw new Error(msg); };

const stamp = Date.now().toString(36);
const word = `Rigger${stamp}`;                  // unique, so only our job matches
const email = `saved.${stamp}@tl-verify.test`;
const password = `Verify${stamp}9`;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

const booted = () => page.waitForFunction(() => window.TL && TL.ready === true, null, { timeout: 30000 });
const go = async (hash) => { await page.evaluate((h) => { location.hash = h; }, hash); await page.waitForTimeout(1200); };
const dismissWizard = () => page.evaluate(() => {
  const b = document.querySelector('.tlpo-ov .tlpo-btn.ghost'); if (b) b.click();
});

console.log(`\nsave this search  (${BASE})`);

await page.goto(BASE + '#/');
await booted();

await check('a new candidate registers and lands signed in', async () => {
  const r = await page.evaluate(async (b) => {
    try {
      const out = await TL.api.post('/auth/register', b);
      return { ok: true, role: out.session && out.session.role };
    } catch (e) { return { ok: false, message: e.message }; }
  }, { name: 'Saved Search Verify', email, password, preferredLocation: 'Nellore',
       expectedCtc: 3, noticePeriod: 'Immediate', preferredWorkModes: ['Work From Office'] });
  must(r.ok && r.role === 'candidate', `register failed: ${r.message || r.role}`);
  await page.goto(BASE + '?v=' + stamp + '#/candidate/search');
  await booted();
  await page.waitForTimeout(1500);
  await dismissWizard();
});

await check('searching shows "Save this search" beside the count', async () => {
  await go('#/candidate/search');
  await dismissWizard();
  await page.fill('#rjQ', word);
  await page.press('#rjQ', 'Enter');
  await page.waitForTimeout(800);
  const t = await page.textContent('.rj-count');
  must(/Save this search/.test(t), `the count line reads "${t}"`);
});

await check('saving it from the panel works and the button turns to ✓ Saved', async () => {
  await page.click('.rj-count button');
  await page.waitForSelector('#tlssName', { timeout: 5000 });
  must((await page.inputValue('#tlssName')).toLowerCase() === word.toLowerCase(), 'the name was not pre-filled');
  await page.click('#tlssSave');
  await page.waitForTimeout(1500);
  const t = await page.textContent('.rj-count button');
  must(/Saved/.test(t), `button reads "${t}"`);
});

await check('after a full refresh it is still on Job Alerts', async () => {
  await page.reload();
  await booted();
  await go('#/candidate/alerts');
  await dismissWizard();
  await page.waitForTimeout(1200);
  const body = await page.textContent('body');
  must(body.includes(word), 'the saved search is not listed after a refresh');
});

let jobId = null;
await check('a recruiter publishes a matching job', async () => {
  const rec = await browser.newContext();
  const rp = await rec.newPage();
  await rp.goto(BASE + '#/');
  await rp.waitForFunction(() => window.TL && TL.ready === true, null, { timeout: 30000 });
  const out = await rp.evaluate(async ({ e, p, w }) => {
    try {
      await TL.api.post('/auth/login', { email: e, password: p, role: 'recruiter' });
      const boot = await TL.api.get('/bootstrap');
      const co = (boot.data.companies || [])[0];
      const j = await TL.api.post('/jobs', { title: `${w} Operator`, companyId: co.id, location: 'Nellore',
        mode: 'Onsite', exp: '1-3 yrs', pay: '₹3 LPA', salaryMin: 3, salaryMax: 3, type: 'Full-time',
        status: 'open', skills: ['Rigging'], description: 'Verification job - safe to delete.' });
      return { ok: true, id: j.job.id };
    } catch (err) { return { ok: false, message: err.message }; }
  }, { e: RECRUITER, p: RECRUITER_PW, w: word });
  await rec.close();
  must(out.ok, `publish failed: ${out.message}`);
  jobId = out.id;
});

await check('"1 new" appears on the saved search', async () => {
  await page.waitForTimeout(1500);
  await go('#/candidate/home');
  await go('#/candidate/alerts');
  await page.waitForTimeout(1500);
  const card = await page.evaluate((w) => {
    const c = [...document.querySelectorAll('.cp-card')].find((x) => x.innerText.includes(w));
    return c ? c.innerText : '';
  }, word);
  must(/1 new/.test(card), `the card reads: ${card.replace(/\s+/g, ' ')}`);
});

await check('Run search opens the results with the new job in them', async () => {
  await page.evaluate((w) => {
    const c = [...document.querySelectorAll('.cp-card')].find((x) => x.innerText.includes(w));
    [...c.querySelectorAll('button')].find((b) => /Run search/.test(b.textContent)).click();
  }, word);
  await page.waitForTimeout(3000);
  const hash = await page.evaluate(() => location.hash);
  must(hash === '#/candidate/search', `landed on ${hash}`);
  const shown = await page.evaluate((id) => !!document.querySelector(`[onclick*="${id}"]`), jobId);
  must(shown, 'the new job is not in the results');
});

await check('no page errors', async () => { must(!errors.length, errors.join(' | ')); });

await browser.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
