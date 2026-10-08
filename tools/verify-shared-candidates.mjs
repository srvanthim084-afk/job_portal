/**
 * Shared candidates and "already contacted", in a real browser.
 *
 *   1  recruiter A adds a candidate and logs a call (Medical Coder)
 *   2  recruiter B finds them in the Talent Pool: ORANGE badge
 *      "Contacted today · Senior Medical Coder · <A>"
 *   3  B opens the profile: TeamLink activity lists A; WhatsApp is stopped
 *      by the contact cooldown (0118): who, when, channel
 *   4  A adds them to the job and moves them to Interview
 *   5  B sees the RED badge "In process", and on the profile the Call /
 *      WhatsApp / Log call buttons are disabled with the hold message
 *   6  the server refuses B's add-to-job (409 ENGAGEMENT_BLOCKED)
 *   7  B requests an admin override from the profile
 *   8  the admin approves it on Admin -> Shared candidates
 *   9  B can now add the candidate to B's job
 *
 * Screenshots: var/verify-shots/shared-*.png (look at them).
 *
 * Creates accounts, so it refuses :4323. Run against an isolated instance:
 *   TL_URL=http://127.0.0.1:4421/ node tools/verify-shared-candidates.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = (process.env.TL_URL || 'http://127.0.0.1:4421/').replace(/\/?$/, '/');
const url = new URL(BASE);
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.port === '4323') {
  console.error(`Refusing to run against ${BASE}: this creates accounts. Use an isolated instance.`);
  process.exit(2);
}
const SHOTS = join(process.cwd(), 'var', 'verify-shots');
mkdirSync(SHOTS, { recursive: true });

let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  PASS  ${name}`); }
  catch (e) { console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n')[0]}`); failed += 1; }
};
const must = (c, m) => { if (!c) throw new Error(m); };
const stamp = Date.now().toString(36);
const ADMIN = { email: process.env.TL_ADMIN_EMAIL || 'admin@teamlink.com', password: process.env.TL_PASSWORD || 'TeamLink@2026' };
const PW = `Shared${stamp}9`;

const browser = await chromium.launch();

async function open(ctx, hash) {
  const page = await ctx.newPage();
  await page.goto(BASE + (hash || '#/'));
  await page.waitForFunction(() => window.TL && TL.ready === true, null, { timeout: 30000 });
  await page.waitForTimeout(500);
  return page;
}
const api = (page, method, path, body) => page.evaluate(([m, p, b]) => window.TL.api[m](p, b)
  .then((v) => ({ ok: true, v }), (e) => ({ ok: false, code: e.code, message: e.message, details: e.details })), [method, path, body]);
async function signIn(ctx, email, password, role) {
  const page = await open(ctx, '#/');
  const r = await api(page, 'post', '/auth/login', { email, password, role });
  must(r.ok, `sign-in failed for ${email}: ${r.message}`);
  /* A recruiter created by an administrator signs in on a temporary
     password and is held on "choose a new password" until they do (0069).
     Do it the way they would, keeping the same password for this run. */
  if (r.v && (r.v.mustChangePassword || (r.v.session && r.v.session.mustChangePassword))) {
    const ch = await api(page, 'post', '/auth/password', { current: password, next: password + 'x' });
    must(ch.ok, `password change failed for ${email}: ${ch.message}`);
    const back = await api(page, 'post', '/auth/password', { current: password + 'x', next: password });
    must(back.ok, `password change back failed for ${email}: ${back.message}`);
  }
  await page.reload();
  await page.waitForFunction(() => window.TL && TL.ready === true && window.STATE && STATE.session, null, { timeout: 30000 });
  return page;
}
const go = async (page, hash) => {
  await page.evaluate((hh) => { location.hash = hh; }, hash);
  await page.waitForTimeout(900);
};
const shot = (page, name) => page.screenshot({ path: join(SHOTS, `shared-${name}.png`), fullPage: false });

/* ---------------------------------------------------------------- *
 * setup: two recruiters at one company, a job each, one candidate
 * ---------------------------------------------------------------- */
const adminCtx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
const admin = await signIn(adminCtx, ADMIN.email, ADMIN.password, 'admin');
const companies = await api(admin, 'get', '/companies');
const COMPANY = companies.ok && (companies.v.companies || [])[0] && companies.v.companies[0].id;
if (!COMPANY) { console.log('No company on this instance - create one first.'); await browser.close(); process.exit(1); }

const people = [{ name: `Ravi ${stamp}` }, { name: `Priya ${stamp}` }];
for (const p of people) {
  p.email = `${p.name.split(' ')[0].toLowerCase()}.${stamp}@tl-verify.test`;
  const r = await api(admin, 'post', '/staff/recruiters', { name: p.name, email: p.email, password: PW, companyId: COMPANY });
  must(r.ok, `could not create ${p.name}: ${r.message}`);
}
const [RA, RB] = people;
const ctxA = await browser.newContext({ viewport: { width: 1360, height: 900 } });
const ctxB = await browser.newContext({ viewport: { width: 1360, height: 900 } });
const A = await signIn(ctxA, RA.email, PW, 'recruiter');
const B = await signIn(ctxB, RB.email, PW, 'recruiter');

const job = async (page, title) => {
  const r = await api(page, 'post', '/jobs', { title: `${title} ${stamp}`, companyId: COMPANY, location: 'Nellore',
    mode: 'Onsite', exp: '0-2 yrs', type: 'Full-time', status: 'open', skills: ['Medical Coding'],
    description: 'Verification job - safe to delete.' });
  must(r.ok, `job ${title}: ${r.message}`);
  return r.v.job;
};
const JA = await job(A, 'Senior Medical Coder');
const JB = await job(B, 'Medical Coder');
const candName = `Shared Cand ${stamp}`;
const made = await api(A, 'post', '/candidates', { firstName: 'Shared', lastName: `Cand ${stamp}`, gender: 'Female',
  phone: '9' + String(Math.floor(1e8 + Math.random() * 9e8)), email: `shared.${stamp}@tl-verify.test`, sendCredentials: false });
if (!made.ok) { console.log('could not create the candidate: ' + made.message); await browser.close(); process.exit(1); }
const CID = made.v.candidate.id;

console.log(`\nshared candidates  (${BASE})`);

async function findInPool(page) {
  await go(page, '#/recruiter/talent-pool');
  await page.waitForSelector('#tpHost', { timeout: 15000 });
  await page.fill('#tpf_q', candName).catch(() => {});
  await page.waitForTimeout(1600);
}

await check('1. A logs a call about the candidate', async () => {
  const r = await api(A, 'post', `/candidates/${CID}/call-log`, { outcome: 'interested', jobId: JA.id, note: 'Keen, 15 days notice' });
  must(r.ok, r.message);
});

await check('2. B sees the orange "Contacted" badge in the Talent Pool', async () => {
  await B.reload(); await B.waitForFunction(() => window.TL && TL.ready === true, null, { timeout: 30000 });
  await findInPool(B);
  await B.waitForSelector('#tpHost .tlsc-orange', { timeout: 10000 });
  const t = await B.$eval('#tpHost .tlsc-orange', (e) => e.textContent);
  must(/Contacted today/.test(t) && t.includes(RA.name), `badge: ${t}`);
  await shot(B, '2-orange-badge');
});

await check('3. B opens the profile: TeamLink activity, and WhatsApp warns first', async () => {
  await go(B, `#/recruiter/candidate-profile?id=${CID}`);
  await B.waitForSelector('#tlscPanel table', { timeout: 10000 });
  const panel = await B.$eval('#tlscPanel', (e) => e.innerText);
  must(panel.includes(RA.name) && /Interested/.test(panel), `panel: ${panel.slice(0, 200)}`);
  must(!/15 days notice/.test(panel), 'the private note leaked into the panel');
  await shot(B, '3a-activity-panel');
  /* 0118: A's call is also a contact inside the 7-day cooldown, so B is
     stopped with who / when / channel (no "contact anyway"; only an admin or a
     team lead may override, with a reason). */
  await B.click('#tlscWa');
  await B.waitForFunction(() => /Already contacted/.test((document.getElementById('fcrModalHost') || {}).innerText || ''), null, { timeout: 8000 });
  const m = await B.$eval('#fcrModalHost', (e) => e.innerText);
  must(m.includes(RA.name) && /Channel:/.test(m) && /Date:/.test(m), `cooldown: ${m.slice(0, 200)}`);
  must(!(await B.$('#tlscAnyway')) && !(await B.$('#tlscWhy')), 'a recruiter was offered to go ahead');
  await shot(B, '3b-cooldown-popup');
  await B.evaluate(() => fcrCloseModal());
});

await check('4. A adds them to the job and moves them to Interview', async () => {
  const add = await api(A, 'post', '/applications', { jobId: JA.id, candidateId: CID });
  must(add.ok, add.message);
  const mv = await api(A, 'put', `/applications/${add.v.application.id}/status`, { stage: 'interview_scheduled' });
  must(mv.ok, mv.message);
});

await check('5. B sees the red badge, and blocked buttons on the profile', async () => {
  await B.evaluate(() => TLEngagement.invalidate());
  await findInPool(B);
  await B.waitForSelector('#tpHost .tlsc-red', { timeout: 10000 });
  const t = await B.$eval('#tpHost .tlsc-red', (e) => e.textContent);
  must(/In process/.test(t) && t.includes(RA.name), `badge: ${t}`);
  await shot(B, '5a-red-badge');
  await go(B, `#/recruiter/candidate-profile?id=${CID}`);
  await B.waitForSelector('#tlscPanel .tlsc-banner-red', { timeout: 10000 });
  const banner = await B.$eval('#tlscPanel .tlsc-banner-red', (e) => e.innerText);
  must(new RegExp(`${RA.name} is processing this candidate for Senior Medical Coder ${stamp} \\(Interview Scheduled\\)`).test(banner), banner);
  must(/Hold ends/.test(banner), 'no hold end date');
  for (const id of ['#tlscCall', '#tlscWa', '#tlscLog']) {
    must(await B.$eval(id, (e) => e.disabled), `${id} is not disabled`);
  }
  await shot(B, '5b-blocked-profile');
});

await check('6. the server refuses B adding them to the same role', async () => {
  const r = await api(B, 'post', '/applications', { jobId: JB.id, candidateId: CID });
  must(!r.ok && r.code === 'ENGAGEMENT_BLOCKED', `expected a 409 block, got ${JSON.stringify(r).slice(0, 160)}`);
});

let overrideId = null;
await check('7. B requests an admin override from the profile', async () => {
  await B.click('#tlscPanel .tlsc-banner-red button.btn-ghost');
  await B.waitForSelector('#tlscReason', { timeout: 5000 });
  await B.fill('#tlscReason', 'The candidate asked to work with me on this role');
  await B.click('#tlscSend');
  await B.waitForTimeout(1200);
  const mine = await api(B, 'get', '/engagement/overrides');
  const o = mine.ok && mine.v.overrides.find((x) => x.candidateId === CID && x.status === 'pending');
  must(o, 'no pending override request');
  overrideId = o.id;
});

await check('8. the admin approves it on Admin -> Shared candidates', async () => {
  await go(admin, '#/admin/shared-candidates');
  await admin.waitForSelector('#tlscAdmin table', { timeout: 10000 });
  await shot(admin, '8a-admin-requests');
  const btn = await admin.$(`#tlscAdmin button[onclick="TLEngagement._decide(${overrideId}, true)"]`);
  must(btn, 'no Approve button for the request');
  await btn.click();
  await admin.waitForSelector('#tlscReason', { timeout: 5000 });
  await admin.fill('#tlscReason', 'Agreed with both recruiters');
  await admin.click('#tlscSend');
  await admin.waitForTimeout(1200);
  const list = await api(admin, 'get', '/engagement/overrides');
  must(list.v.overrides.find((x) => x.id === overrideId).status === 'approved', 'not approved');
  await shot(admin, '8b-approved');
});

await check('9. B can now add the candidate to B\'s job', async () => {
  const r = await api(B, 'post', '/applications', { jobId: JB.id, candidateId: CID });
  must(r.ok, r.message);
  await go(B, `#/recruiter/candidate-profile?id=${CID}`);
  await B.evaluate(() => TLEngagement._role(location.hash.split('id=')[1], ''));
  await B.waitForTimeout(1200);
  await shot(B, '9-after-override');
});

/* ---------------------------------------------------------------- *
 * put things back
 * ---------------------------------------------------------------- */
try {
  await api(admin, 'post', '/admin/purge-test-candidate', { candidateId: CID });
  await api(admin, 'del', `/jobs/${JA.id}`);
  await api(admin, 'del', `/jobs/${JB.id}`);
  console.log('  cleaned up the candidate and both jobs (the two verify recruiter logins stay; see purge-verify-leftovers)');
} catch (e) { console.log('  cleanup did not finish: ' + e.message); }

await browser.close();
console.log(failed ? `\n  ${failed} FAILED\n` : '\n  SHARED CANDIDATES VERIFIED\n');
process.exitCode = failed ? 1 : 0;
