/**
 * Candidate availability status, in a real browser.
 *
 *   1  the registration form asks "Are you looking for a job?"
 *   2  the candidate sets "Not looking" in one tap on their profile
 *   3  a recruiter's Talent Pool search hides them by default
 *   4  "Show all" shows them, with a grey "Not looking" badge
 *   5  a recruiter cannot change it (the server refuses)
 *   6  the candidate applies to a job
 *   7  the recruiter now sees them, green "Actively looking"
 *
 * Screenshots: var/verify-shots/availability-*.png (look at them).
 *
 * Creates accounts, so it refuses :4323. Run against an isolated instance:
 *   TL_URL=http://127.0.0.1:4421/ node tools/verify-availability.mjs
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
const RECRUITER = process.env.TL_RECRUITER_EMAIL || 'recruiter@teamlink.com';
const ADMIN_EMAIL = process.env.TL_ADMIN_EMAIL || 'admin@teamlink.com';
const PW = process.env.TL_PASSWORD || 'TeamLink@2026';

const browser = await chromium.launch();
async function open(ctx, hash) {
  const page = await ctx.newPage();
  await page.goto(BASE + (hash || '#/'));
  await page.waitForFunction(() => window.TL && TL.ready === true, null, { timeout: 30000 });
  await page.waitForTimeout(500);
  return page;
}
const api = (page, method, path, body) => page.evaluate(([m, p, b]) => window.TL.api[m](p, b)
  .then((v) => ({ ok: true, v }), (e) => ({ ok: false, code: e.code, message: e.message })), [method, path, body]);
const ready = (page) => page.waitForFunction(() => window.TL && TL.ready === true && window.STATE && STATE.session, null, { timeout: 30000 });
const go = async (page, hash) => { await page.evaluate((hh) => { location.hash = hh; }, hash); await page.waitForTimeout(900); };
const shot = (page, name) => page.screenshot({ path: join(SHOTS, `availability-${name}.png`) });

/* the recruiter and a job */
const rc = await browser.newContext({ viewport: { width: 1360, height: 900 } });
const rec = await open(rc, '#/');
must((await api(rec, 'post', '/auth/login', { email: RECRUITER, password: PW, role: 'recruiter' })).ok, 'recruiter sign-in failed');
const boot = await api(rec, 'get', '/bootstrap');
const me = boot.v.data.recruiters.find((r) => r.id === boot.v.session.id) || {};
const COMPANY = me.companyId || (boot.v.data.companies[0] || {}).id;
const job = await api(rec, 'post', '/jobs', { title: `Data Entry Operator ${stamp}`, companyId: COMPANY, location: 'Nellore',
  mode: 'Onsite', exp: '0-2 yrs', type: 'Full-time', status: 'open', skills: ['Typing'], description: 'Verification job - safe to delete.' });
if (!job.ok) { console.log('could not create a job: ' + job.message); await browser.close(); process.exit(1); }
const JOB = job.v.job;
await rec.reload(); await ready(rec);

const name = `Avail Check ${stamp}`;
const cc = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const cand = await open(cc, '#/register/candidate');

console.log(`\navailability status  (${BASE})`);

await check('1. the registration form asks whether they are looking', async () => {
  await cand.waitForSelector('#regAvailability', { timeout: 8000 });
  const opts = await cand.$$eval('#regAvailability option', (o) => o.map((x) => x.value));
  must(opts.join() === 'actively_looking,open_to_offers,not_looking', opts.join());
  must(await cand.$eval('#regAvailability', (e) => e.value) === 'actively_looking', 'the default is not Actively looking');
  await cand.$eval('#regAvailability', (e) => e.scrollIntoView({ block: 'center' }));
  await shot(cand, '1-register');
});

let CID = null;
await check('2. the candidate sets "Not looking" in one tap', async () => {
  const r = await api(cand, 'post', '/auth/register', { name, email: `avail.${stamp}@tl-verify.test`, password: `Avail${stamp}9`,
    phone: '9' + String(Math.floor(1e8 + Math.random() * 9e8)), preferredLocation: 'Nellore', expectedCtc: 3,
    noticePeriod: '15 days', preferredWorkModes: ['Office'], availability: 'actively_looking' });
  must(r.ok, r.message);
  CID = r.v.candidateId;
  await cand.reload(); await ready(cand);
  await cand.evaluate(() => document.querySelectorAll('.tlpo-ov .tlpo-btn.ghost, .tlpo-ov .tlpo-skip').forEach((b) => b.click()));
  await go(cand, '#/candidate/profile');
  await cand.waitForSelector('#tlavMe .tlav-opt', { timeout: 10000 });
  await cand.click('#tlavMe .tlav-opt:nth-child(3)');
  await cand.waitForSelector('#tlavMe .tlav-on-not_looking', { timeout: 8000 });
  const mine = await api(cand, 'get', '/candidate/availability');
  must(mine.v.availability.status === 'not_looking', JSON.stringify(mine.v));
  await shot(cand, '2-candidate-not-looking');
});

async function poolFor(page) {
  await go(page, '#/recruiter/talent-pool');
  await page.waitForSelector('#tpHost', { timeout: 15000 });
  await page.fill('#tpf_q', name).catch(() => {});
  await page.waitForTimeout(1800);
}
const rowFor = (page) => page.evaluate((n) => Array.from(document.querySelectorAll('#tpHost tbody tr'))
  .filter((tr) => tr.innerText.includes(n)).map((tr) => tr.querySelector('td.who').innerText)[0] || null, name);

await check('3. the recruiter\'s search hides them by default', async () => {
  await rec.evaluate(() => { try { sessionStorage.removeItem('tlav_filter'); } catch (e) { /* */ } });
  await poolFor(rec);
  await rec.waitForSelector('#tlavBar', { timeout: 8000 });
  must(!(await rowFor(rec)), 'a Not looking candidate is shown by default');
  await shot(rec, '3-hidden-by-default');
});

await check('4. "Show all" shows them with a grey "Not looking" badge', async () => {
  await rec.check('#tlavShowAll');
  await rec.waitForTimeout(1800);
  const row = await rowFor(rec);
  must(row && /Not looking/.test(row), `row: ${row}`);
  must(await rec.evaluate((n) => { const tr = Array.from(document.querySelectorAll('#tpHost tbody tr')).find((t) => t.innerText.includes(n));
    return !!(tr && tr.querySelector('.tlav-grey')); }, name), 'the badge is not grey');
  await shot(rec, '4-show-all-grey');
});

await check('5. a recruiter cannot change it', async () => {
  const r = await api(rec, 'put', `/candidates/${CID}/availability`, { status: 'actively_looking' });
  must(!r.ok && r.code === 'FORBIDDEN', JSON.stringify(r));
});

await check('6. the candidate applies to a job', async () => {
  const r = await api(cand, 'post', '/applications', { jobId: JOB.id });
  must(r.ok, r.message);
  const mine = await api(cand, 'get', '/candidate/availability');
  must(mine.v.availability.status === 'actively_looking' && mine.v.availability.source === 'apply', JSON.stringify(mine.v.availability));
});

await check('7. the recruiter now sees them, green "Actively looking"', async () => {
  await rec.uncheck('#tlavShowAll').catch(() => {});
  await rec.evaluate(() => window.tpLoad && tpLoad());
  await rec.waitForTimeout(1800);
  const row = await rowFor(rec);
  must(row && /Actively looking/.test(row), `row: ${row}`);
  must(await rec.evaluate((n) => { const tr = Array.from(document.querySelectorAll('#tpHost tbody tr')).find((t) => t.innerText.includes(n));
    return !!(tr && tr.querySelector('.tlav-green')); }, name), 'the badge is not green');
  await shot(rec, '7-green-after-apply');
});

/* clean up */
try {
  const ac = await browser.newContext();
  const adm = await open(ac, '#/');
  await api(adm, 'post', '/auth/login', { email: ADMIN_EMAIL, password: PW, role: 'admin' });
  if (CID) await api(adm, 'post', '/admin/purge-test-candidate', { candidateId: CID });
  await api(adm, 'del', `/jobs/${JOB.id}`);
  console.log('  cleaned up the candidate and the job');
} catch (e) { console.log('  cleanup did not finish: ' + e.message); }

await browser.close();
console.log(failed ? `\n  ${failed} FAILED\n` : '\n  AVAILABILITY VERIFIED\n');
process.exitCode = failed ? 1 : 0;
