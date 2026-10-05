/**
 * Who viewed my profile, in a real browser.
 *
 *   1  a recruiter opens a candidate's profile twice  -> the candidate sees ONE
 *      view, with the recruiter's first name and the role
 *   2  the client opens their shortlist               -> "A hiring team"
 *   3  the candidate's page never shows an email, a company or "client"
 *   4  Home shows "N profile views this month"; Profile Performance lists them
 *   5  a Talent Pool search counts as a search appearance (the page shown)
 *   6  the administrator turns names off             -> "A TeamLink recruiter"
 *   7  a Login As session records nothing
 *
 * Creates accounts and a job, so it refuses :4323. Run against an isolated
 * instance:
 *   TL_URL=http://127.0.0.1:4422/ TL_CLIENT_EMAIL=... node tools/verify-profile-viewers.mjs
 * Without TL_CLIENT_EMAIL the administrator creates a client login for the job's
 * company (POST /api/staff/clients, temporary password changed at first sign-in).
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = (process.env.TL_URL || 'http://127.0.0.1:4422/').replace(/\/?$/, '/');
const url = new URL(BASE);
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.port === '4323') {
  console.error(`Refusing to run against ${BASE}: this creates accounts. Use an isolated instance.`);
  process.exit(2);
}
const SHOTS = process.env.TL_SHOTS || '';
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

let failed = 0; let skipped = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  PASS  ${name}`); }
  catch (e) { console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n')[0]}`); failed += 1; }
};
const must = (c, m) => { if (!c) throw new Error(m); };
const stamp = Date.now().toString(36);
const phone = () => '9' + String(Math.floor(1e8 + Math.random() * 9e8));
const PW = process.env.DEV_PASSWORD || 'TeamLink@2026';
const RECRUITER = process.env.TL_RECRUITER_EMAIL || 'recruiter@teamlink.com';
const ADMIN = process.env.TL_ADMIN_EMAIL || 'admin@teamlink.com';
const CLIENT = process.env.TL_CLIENT_EMAIL || '';

const browser = await chromium.launch();
async function open(ctx, hash) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('        page error:', e.message));
  await page.goto(BASE + hash);
  await page.waitForFunction(() => window.TL && TL.ready === true, null, { timeout: 30000 });
  await page.waitForTimeout(500);
  return page;
}
const ready = (page) => page.waitForFunction(() => window.TL && TL.ready === true, null, { timeout: 30000 });
const signIn = async (page, email, password) => {
  const r = await page.evaluate(({ e, p }) => TL.api.post('/auth/login', { email: e, password: p })
    .then(() => 'ok', (err) => err.message), { e: email, p: password });
  must(r === 'ok', `could not sign in as ${email}: ${r}`);
  await page.reload(); await ready(page);
  await page.waitForFunction(() => window.STATE && STATE.session, null, { timeout: 15000 });
  await page.waitForTimeout(600);
};
const go = async (page, hash) => {
  await page.evaluate((h) => { location.hash = h; }, hash);
  await page.waitForTimeout(1200);
  await page.evaluate(() => { document.querySelectorAll('.tlpo-ov .tlpo-btn.ghost, .tlpo-ov .tlpo-skip').forEach((b) => b.click()); });
};
const viewers = (page) => page.evaluate(() => TL.api.get('/candidate/profile-viewers'));
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false }); };

/* The recruiter, a job, a candidate who applied. */
const rc = await browser.newContext({ viewport: { width: 1366, height: 900 } });
const rp = await open(rc, '#/');
await signIn(rp, RECRUITER, PW);
const recName = await rp.evaluate(() => { const r = DATA.recruiterById ? DATA.recruiterById(STATE.session.id) : null; return r ? r.name : ''; });
const first = String(recName).trim().split(/\s+/)[0];
const job = await rp.evaluate(async (s) => {
  const boot = await TL.api.get('/bootstrap');
  const myCo = ((boot.data.recruiters || []).find((r) => boot.session && r.id === boot.session.id) || {}).companyId; const co = (boot.data.companies || []).find((x) => x.id === myCo) || (boot.data.companies || [])[0];
  const j = await TL.api.post('/jobs', { title: `Medical Coder ${s}`, companyId: co.id, location: 'Hyderabad',
    mode: 'Onsite', exp: '0-2 yrs', pay: '₹3 LPA', salaryMin: 3, salaryMax: 3, type: 'Full-time',
    status: 'open', skills: ['ICD-10'], description: 'Verification job - safe to delete.' });
  return { id: j.job.id, title: j.job.title, company: co.name, companyId: co.id };
}, stamp);

const cc = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const cp = await open(cc, '#/');
const cand = { email: `viewers.${stamp}@tl-verify.test`, password: `Viewers${stamp}9`, name: `Viewed Person ${stamp}` };
const reg = await cp.evaluate((b) => TL.api.post('/auth/register', b).then((r) => r.candidateId, (e) => 'ERR ' + e.message), {
  name: cand.name, email: cand.email, password: cand.password, phone: phone(),
  preferredLocation: 'Hyderabad', expectedCtc: 4, noticePeriod: 'Immediate', preferredWorkModes: ['Hybrid'],
});
if (String(reg).startsWith('ERR')) { console.error('could not register:', reg); process.exit(1); }
cand.id = reg;
await cp.reload(); await ready(cp);
const appId = await cp.evaluate((j) => TL.api.post('/applications', { jobId: j }).then((r) => r.application && r.application.id), job.id);

console.log(`\nwho viewed my profile  (${BASE})`);

await check('1. a recruiter opens the profile twice -> one view, first name and role', async () => {
  await rp.reload(); await ready(rp);
  await go(rp, `#/recruiter/candidate-profile?id=${cand.id}`);
  await rp.waitForTimeout(1000);
  await rp.reload(); await ready(rp);
  await go(rp, `#/recruiter/candidate-profile?id=${cand.id}`);
  await rp.waitForTimeout(1000);
  const v = await viewers(cp);
  must(v.viewers.length === 1, `expected 1 view, got ${v.viewers.length}`);
  must(v.viewers[0].displayName === `${first} (TeamLink Recruiter)`, `name: ${v.viewers[0].displayName}`);
  must(v.viewers[0].roleTitle === job.title, `role: ${v.viewers[0].roleTitle}`);
  must(v.viewers[0].viewCount === 2, `view count ${v.viewers[0].viewCount}`);
  await go(cp, '#/candidate/viewers');
  await cp.waitForSelector('.tlpv-row', { timeout: 8000 });
  const text = await cp.evaluate(() => document.querySelector('.tlpv-two').innerText);
  must(text.includes(`${first} (TeamLink Recruiter) viewed your profile for ${job.title}`), `page: ${text.slice(0, 200)}`);
  await shot(cp, 'viewers-recruiter');
});

/*
 * The client login. TL_CLIENT_EMAIL uses an existing one; otherwise the
 * administrator creates one for the job's company through the supported
 * API (POST /api/staff/clients - a temporary password the client must
 * change at first sign-in), and the client changes it, as a real client
 * would. The passwords are generated here and never printed.
 */
let client = CLIENT ? { email: CLIENT, password: process.env.TL_CLIENT_PASSWORD || PW, made: false } : null;
async function makeClientLogin() {
  const ac = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const ap = await open(ac, '#/');
  await signIn(ap, ADMIN, PW);
  const temp = `Tmp${stamp}#${Math.random().toString(36).slice(2, 8)}A1`;
  const made = await ap.evaluate((b) => TL.api.post('/staff/clients', b).then((r) => r, (e) => ({ error: e.message })), {
    name: `Hiring Lead ${stamp}`, email: `client.${stamp}@tl-verify.test`, password: temp, confirmPassword: temp,
    companyId: job.companyId, title: 'Hiring Manager',
  });
  await ac.close();
  must(made && made.client && made.mustChangePassword === true, 'could not create the client login: ' + JSON.stringify(made));
  must(!JSON.stringify(made).includes(temp), 'the create response carried the password');
  return { email: made.client.email, password: temp, made: true };
}

await check('2. the client opens their shortlist -> "A hiring team"', async () => {
  if (!client) client = await makeClientLogin();
  const ok = await rp.evaluate((id) => TL.api.put(`/applications/${id}/status`, { stage: 'shortlisted' }).then(() => 'ok', (e) => e.message), appId);
  must(ok === 'ok', 'could not shortlist: ' + ok);
  const kc = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const kp = await open(kc, '#/');
  if (client.made) {
    /* first sign-in with the temporary password: it must be changed */
    const first = await kp.evaluate(({ e, p }) => TL.api.post('/auth/login', { email: e, password: p }), { e: client.email, p: client.password });
    must(first.session && first.session.role === 'client' && first.session.mustChangePassword === true,
      'the temporary password was not flagged: ' + JSON.stringify(first.session));
    const next = `Own${stamp}#${Math.random().toString(36).slice(2, 8)}B2`;
    const ch = await kp.evaluate(({ c, n }) => TL.api.post('/auth/password', { current: c, next: n }).then(() => 'ok', (e) => e.message),
      { c: client.password, n: next });
    must(ch === 'ok', 'could not change the temporary password: ' + ch);
    client.password = next;
  }
  await signIn(kp, client.email, client.password);
  must(await kp.evaluate(() => STATE.session && STATE.session.role === 'client'), 'not signed in as the client');
  await go(kp, '#/client/shortlisted');
  await kp.waitForTimeout(1500);
  await kc.close();
  await cp.reload(); await ready(cp); await go(cp, '#/candidate/viewers');
  await cp.waitForSelector('.tlpv-row', { timeout: 8000 });
  const text = await cp.evaluate(() => document.querySelector('.tlpv-two').innerText);
  must(text.includes(`A hiring team reviewed your profile for ${job.title}`), `page: ${text.slice(0, 300)}`);
  await shot(cp, 'viewers-hiring-team');
});

await check('3. the page never shows an email, a company name or the word "client"', async () => {
  const text = await cp.evaluate(() => document.querySelector('.tlpv-two').innerText + ' ' + document.querySelector('.tlpv-stats').innerText);
  must(!/client/i.test(text), 'the word "client" is on the page');
  must(!text.includes(RECRUITER) && !text.includes((client && client.email) || '@@'), 'an email is on the page');
  must(!text.includes(job.company), `the company "${job.company}" is on the page`);
  const json = JSON.stringify(await viewers(cp));
  must(!/client/i.test(json) && !json.includes(job.company) && !json.includes('@'), 'the API response carries something it must not');
});

await check('4. Home shows the views this month; Profile Performance lists the viewers', async () => {
  await go(cp, '#/candidate/home');
  await cp.waitForSelector('.tlpv-home', { timeout: 8000 });
  const home = await cp.evaluate(() => document.querySelector('.tlpv-home').innerText);
  must(/\d+ profile views? this month/.test(home), home);
  await shot(cp, 'viewers-home');
  await go(cp, '#/candidate/performance');
  const perf = await cp.evaluate(() => document.body.innerText);
  must(perf.includes(`${first} (TeamLink Recruiter)`), 'Profile Performance does not list the recruiter');
});

await check('5. a Talent Pool search counts as a search appearance', async () => {
  const before = (await viewers(cp)).summary.appear30;
  await go(rp, '#/recruiter/talent-pool');
  await rp.waitForTimeout(800);
  await rp.evaluate((n) => { tpSet('q', n); }, `Viewed Person ${stamp}`);
  await rp.waitForTimeout(3500);
  const after = (await viewers(cp)).summary.appear30;
  must(after === before + 1, `appearances ${before} -> ${after}`);
});

await check('6. names off: "A TeamLink recruiter"', async () => {
  const ac = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const ap = await open(ac, '#/');
  await signIn(ap, ADMIN, PW);
  await go(ap, '#/admin/notification-settings');
  await ap.waitForSelector('#tlpvAdmin', { timeout: 8000 });
  await shot(ap, 'viewers-admin');
  await ap.evaluate(() => { const b = document.querySelector('#tlpvAdmin input[onchange*="showRecruiterNames"]'); if (b.checked) b.click(); });
  await ap.waitForTimeout(1200);
  const names = (await viewers(cp)).viewers.map((v) => v.displayName);
  must(names.includes('A TeamLink recruiter') && !names.some((n) => n.includes(first)), names.join(', '));
  await ap.evaluate(() => TL.api.put('/admin/profile-viewer-settings', { showRecruiterNames: true }));
  await ac.close();
});

await check('7. a Login As session records nothing', async () => {
  const before = (await viewers(cp)).viewers.reduce((a, v) => a + v.viewCount, 0);
  const ac = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const ap = await open(ac, '#/');
  await signIn(ap, ADMIN, PW);
  const recId = await rp.evaluate(() => STATE.session.id);
  const r = await ap.evaluate((id) => TL.api.post(`/staff/recruiters/${id}/login-as`, {}).then(() => 'ok', (e) => e.message), recId);
  must(r === 'ok', 'login as: ' + r);
  await ap.reload(); await ready(ap);
  await go(ap, `#/recruiter/candidate-profile?id=${cand.id}`);
  await ap.waitForTimeout(1500);
  const after = (await viewers(cp)).viewers.reduce((a, v) => a + v.viewCount, 0);
  if (after !== before) console.log('        ', JSON.stringify((await viewers(cp)).viewers));
  must(after === before, `views went from ${before} to ${after}`);
  await ac.close();
});

await cp.setViewportSize({ width: 390, height: 844 });
await go(cp, '#/candidate/viewers');
await cp.waitForTimeout(800);
await shot(cp, 'viewers-mobile');

await browser.close();
console.log(failed ? `\n${failed} check(s) failed${skipped ? ` (${skipped} skipped)` : ''}` : '\nall checks passed');
process.exit(failed - skipped > 0 ? 1 : 0);
