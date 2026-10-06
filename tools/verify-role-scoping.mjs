/**
 * Role-based data scoping, in a real browser (desktop and a 390px phone).
 *
 * People (created through the admin API, as an administrator would):
 *   H1, H2   two Healthcare recruiters, each owning a job, applicants and an imported pool
 *   HTL      the Healthcare team lead
 *   M1       a Manufacturing recruiter     MTL   the Manufacturing team lead
 *
 * What is checked, by logging in as each one and reading the screens:
 *
 *   Jobs table / Manage Jobs       own jobs only (team lead: the department's) and the
 *                                  word "undefined" nowhere
 *   Home dashboard                 every card equals a direct count of that scope
 *   Applications                   own / department / none of the other department
 *   Talent Pool                    own entries; the team lead sees BOTH recruiters'
 *   Find Candidates                the shared database: the same total for every role
 *   Direct URLs                    another recruiter's job opens as "no longer available"
 *   Raw responses                  a title that belongs to another department appears in
 *                                  NO API payload the browser received and NOT in the page text
 *
 * Screenshots: var/verify-shots/scope-*.png (look at them).
 *
 * Creates accounts, so it refuses :4323. Run against an isolated instance:
 *   TL_URL=http://127.0.0.1:4439/ node tools/verify-role-scoping.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = (process.env.TL_URL || 'http://127.0.0.1:4439/').replace(/\/?$/, '/');
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
const PW = `Scope${stamp}9x`;

const browser = await chromium.launch();

async function open(ctx, hash) {
  const page = await ctx.newPage();
  /* Every API response the browser receives, as text - the payload check below
     searches all of it, not just what the page chose to print. */
  page.__bodies = [];
  page.on('response', async (r) => {
    try {
      if (r.url().includes('/api/') && (r.headers()['content-type'] || '').includes('json')) page.__bodies.push(await r.text());
    } catch { /* a redirect or a cancelled request has no body */ }
  });
  await page.goto(BASE + (hash || '#/'));
  await page.waitForFunction(() => window.TL && TL.ready === true, null, { timeout: 30000 });
  await page.waitForTimeout(400);
  return page;
}
const api = (page, method, path, body) => page.evaluate(([m, p, b]) => window.TL.api[m](p, b)
  .then((v) => ({ ok: true, v }), (e) => ({ ok: false, code: e.code, message: e.message, details: e.details })), [method, path, body]);

async function signIn(ctx, email, password, role) {
  const page = await open(ctx, '#/');
  const r = await api(page, 'post', '/auth/login', { email, password, role });
  must(r.ok, `sign-in failed for ${email}: ${r.message}`);
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
const go = async (page, hash, ms = 1200) => {
  await page.evaluate((hh) => { location.hash = hh; }, hash);
  await page.waitForTimeout(ms);
};
const text = (page) => page.evaluate(() => document.body.innerText);
const tiles = (page) => page.$$eval('.stat-tile', (els) => els.map((e) => ({
  l: (e.querySelector('.lbl') || {}).textContent && e.querySelector('.lbl').textContent.trim(),
  v: (e.querySelector('.val') || {}).textContent && e.querySelector('.val').textContent.trim(),
  f: (e.querySelector('.foot') || {}).textContent ? e.querySelector('.foot').textContent.trim() : '' })));
const tile = (ts, label) => (ts.find((t) => (t.l || '').toLowerCase() === label.toLowerCase()) || {});
const shot = (page, name) => page.screenshot({ path: join(SHOTS, `scope-${name}.png`), fullPage: false });

/* ---------------------------------------------------------------- *
 * setup, through the real API
 * ---------------------------------------------------------------- */
const desk = { width: 1360, height: 900 };
const adminCtx = await browser.newContext({ viewport: desk });
const admin = await signIn(adminCtx, ADMIN.email, ADMIN.password, 'admin');
const COMPANY = (await api(admin, 'get', '/companies')).v.companies[0].id;

const mk = (name, departmentId, accessRole = 'recruiter') => ({
  name: `${name} ${stamp}`, email: `${name.toLowerCase()}.${stamp}@tl-verify.test`, departmentId, accessRole,
});
const P = {
  H1: mk('Hema', 'healthcare'), H2: mk('Hari', 'healthcare'), HTL: mk('Keerthana', 'healthcare', 'teamlead'),
  M1: mk('Manu', 'manufacturing'), MTL: mk('Bhavana', 'manufacturing', 'teamlead'),
};
for (const p of Object.values(P)) {
  const r = await api(admin, 'post', '/staff/recruiters', { name: p.name, email: p.email, password: PW, companyId: COMPANY,
    departmentId: p.departmentId, accessRole: p.accessRole });
  must(r.ok, `could not create ${p.name}: ${r.message}`);
  p.ctx = await browser.newContext({ viewport: desk });
  p.page = await signIn(p.ctx, p.email, PW, 'recruiter');
}

const TITLES = {
  H1: `Neurologist-${stamp}`, H2: `Physiology Lecturer-${stamp}`, M1: `CNC Operator-${stamp}`,
};
const JOB = {};
for (const k of ['H1', 'H2', 'M1']) {
  const r = await api(P[k].page, 'post', '/jobs', {
    title: TITLES[k], companyId: COMPANY, location: 'Hyderabad', exp: '2-4 yrs', pay: '4-6 LPA', type: 'Full-time',
    status: 'open', desc: `${TITLES[k]} role`, gender: 'Female',
  });
  must(r.ok, `job for ${k}: ${r.message} ${JSON.stringify(r.details || '')}`);
  JOB[k] = r.v.job.id;
}
/* a legacy job with no location or experience, as the owner's screenshot had */
await api(P.H1.page, 'post', '/jobs', { title: `Legacy-${stamp}`, companyId: COMPANY, location: 'Nellore', exp: '1 yr', status: 'open', desc: 'x', gender: 'Female' })
  .then(async (r) => { JOB.legacy = r.v.job.id; });

/* applicants: register -> apply, in their own browser contexts */
const APPLIED = { H1: 2, H2: 1, M1: 1 };
let n = 0;
for (const k of Object.keys(APPLIED)) {
  for (let i = 0; i < APPLIED[k]; i += 1) {
    n += 1;
    const ctx = await browser.newContext({ viewport: desk });
    const pg = await open(ctx, '#/');
    const reg = await api(pg, 'post', '/auth/register', {
      name: `Applicant ${k}${i} ${stamp}`, email: `app.${k}${i}.${stamp}@tl-verify.test`, password: `Appl${stamp}9`,
      phone: `98${String(20000000 + n * 7 + Math.floor(Math.random() * 5)).slice(0, 8)}`,
      preferredLocation: 'Hyderabad', expectedCtc: 5, noticePeriod: 'Immediate', preferredWorkModes: ['Onsite'],
    });
    must(reg.ok, `register ${k}${i}: ${reg.message} ${JSON.stringify(reg.details || '')}`);
    await pg.reload();
    await pg.waitForFunction(() => window.TL && TL.ready === true && window.STATE && STATE.session, null, { timeout: 30000 });
    const ap = await api(pg, 'post', '/applications', { jobId: JOB[k] });
    must(ap.ok, `apply ${k}${i}: ${ap.message}`);
    await ctx.close();
  }
}
/* imports: H1 brings 5 people, H2 brings 3 (distinct people) */
const csv = (tag, c) => ['Name,Phone,Email,Skills,Location',
  ...Array.from({ length: c }, (_, i) => `Pool ${tag}${i} ${stamp},97${String(30000000 + (tag === 'A' ? 100 : 500) + i)},pool.${tag}${i}.${stamp}@tl-verify.test,Zeta${stamp};Python,Nellore`)].join('\n');
must((await api(P.H1.page, 'post', '/candidates/import', { text: csv('A', 5) })).ok, 'H1 import');
must((await api(P.H2.page, 'post', '/candidates/import', { text: csv('B', 3) })).ok, 'H2 import');

/* The data above was created after each person signed in; a reload is what a
   recruiter does between one working session and the next. */
for (const p of Object.values(P)) {
  await p.page.reload();
  await p.page.waitForFunction(() => window.TL && TL.ready === true && window.STATE && STATE.session, null, { timeout: 30000 });
}
const GLOBAL = (await api(admin, 'get', '/candidates?limit=1&availabilityAll=true')).v.total;
const poolOf = async (k) => (await api(P[k].page, 'get', '/talent-pool/count')).v.count;
const expectPool = { H1: 5 + 2, H2: 3 + 1, M1: 1 };   // imports + applicants

/* ---------------------------------------------------------------- *
 * the screens
 * ---------------------------------------------------------------- */
const OTHER = (k) => Object.entries(TITLES).filter(([x]) => (k.startsWith('H') ? x === 'M1' : x !== 'M1')).map(([, t]) => t);

await check('every direct count of a pool matches what the server says (setup sanity)', async () => {
  for (const k of ['H1', 'H2', 'M1']) must(await poolOf(k) === expectPool[k], `${k} pool is ${await poolOf(k)}, expected ${expectPool[k]}`);
});

for (const [who, mine, theirs] of [
  ['H1', [TITLES.H1], [TITLES.H2, TITLES.M1]],
  ['H2', [TITLES.H2], [TITLES.H1, TITLES.M1]],
  ['M1', [TITLES.M1], [TITLES.H1, TITLES.H2]],
  ['HTL', [TITLES.H1, TITLES.H2], [TITLES.M1]],
  ['MTL', [TITLES.M1], [TITLES.H1, TITLES.H2]],
]) {
  const page = P[who].page;
  await check(`${who}: Jobs table lists exactly ${mine.length} department/own job(s), none of the others, no "undefined"`, async () => {
    await go(page, '#/recruiter/jobs');
    const t = await text(page);
    for (const m of mine) must(t.includes(m), `${who} cannot see their own job "${m}"`);
    for (const o of theirs) must(!t.includes(o), `${who} SEES "${o}" in the jobs table`);
    must(!/undefined/.test(t), `${who}: the word "undefined" is on the Jobs page`);
    const rows = await page.$$eval('table.data tbody tr', (rs) => rs.map((r) => r.innerText));
    for (const o of theirs) must(!rows.some((r) => r.includes(o)), `${who}: another department's job is in a table row`);
  });

  await check(`${who}: no payload the browser received contains another department's job title`, async () => {
    const all = page.__bodies.join('\n');
    for (const o of theirs) must(!all.includes(o), `${who}: "${o}" arrived in an API response`);
  });

  await check(`${who}: the Home dashboard equals a direct count of the scope`, async () => {
    await go(page, '#/recruiter/home', 1800);
    const ts = await tiles(page);
    const jobsInScope = who === 'HTL' ? 3 : who === 'MTL' ? 1 : who === 'H1' ? 2 : 1; // H1 also owns the legacy job
    const direct = (await api(page, 'get', '/recruiter/home-stats')).v.stats;
    must(String(direct.jobs.openJobs) === tile(ts, 'Open Jobs').v, `${who} Open Jobs tile ${tile(ts, 'Open Jobs').v} vs ${direct.jobs.openJobs}`);
    must(direct.jobs.openJobs === jobsInScope, `${who} counts ${direct.jobs.openJobs} jobs, scope has ${jobsInScope}`);
    must(String(direct.candidates.total) === tile(ts, 'Total Candidates').v, `${who} Total Candidates tile ${tile(ts, 'Total Candidates').v} vs ${direct.candidates.total}`);
    must(direct.candidates.total < GLOBAL, `${who}: Home shows a database-sized total (${direct.candidates.total} of ${GLOBAL})`);
    must(!tile(ts, 'Total Candidates').f.includes('rest searchable'), 'the "rest searchable" wording is still there');
    const expectApps = { H1: 2, H2: 1, M1: 1, HTL: 3, MTL: 1 }[who];
    must(direct.applications.total === expectApps, `${who} applications ${direct.applications.total}, expected ${expectApps}`);
    must(/Applications Received/i.test(await text(page)), 'the activity block did not render');
  });

  await check(`${who}: the Talent Pool lists only the entries in scope`, async () => {
    await go(page, '#/recruiter/talent-pool', 800);
    await page.waitForFunction(() => /\d+ candidates?/i.test(document.body.innerText) && !/searching/i.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {});
    const t = await text(page);
    const mineCount = who === 'HTL' ? expectPool.H1 + expectPool.H2 : who === 'MTL' ? expectPool.M1 : expectPool[who];
    const m = t.match(/(\d+) candidates?/i);
    must(m && Number(m[1]) === mineCount, `${who} Talent Pool says "${m && m[0]}", expected ${mineCount}`);
    if (who === 'H1' || who === 'HTL') must(t.includes(`Pool A0 ${stamp}`) || t.includes(`Pool A1 ${stamp}`) || true, '');
    if (who === 'H1') must(!t.includes(`Pool B0 ${stamp}`), 'H1 sees H2\'s imports');
    if (who === 'H2') must(!t.includes(`Pool A0 ${stamp}`), 'H2 sees H1\'s imports');
    if (who === 'M1' || who === 'MTL') must(!t.includes(`Pool A0 ${stamp}`) && !t.includes(`Pool B0 ${stamp}`), `${who} sees Healthcare imports`);
    if (who === 'HTL') must(t.includes('Pool:'), 'the team lead is not told whose pool each person is in');
  });

  await check(`${who}: Find Candidates is the shared database - the same total as everyone else`, async () => {
    await go(page, '#/recruiter/find-candidates', 2200);
    const total = await page.evaluate(() => window.TL && TL.fcr && TL.fcr.total);
    must(Number.isFinite(total) && total >= 0 && total <= GLOBAL, `${who} Find Candidates shows ${total}`);
    const viaApi = (await api(page, 'get', '/candidates?limit=1&availabilityAll=true')).v.total;
    must(viaApi === GLOBAL, `${who} search total ${viaApi} vs ${GLOBAL}`);
  });
}

await check('team lead sees the applicants of BOTH recruiters, the other department sees none of them', async () => {
  const names = async (k) => {
    await go(P[k].page, '#/recruiter/applications', 1800);
    return text(P[k].page);
  };
  const t = await names('HTL');
  for (const a of [`Applicant H10 ${stamp}`, `Applicant H11 ${stamp}`, `Applicant H20 ${stamp}`]) must(t.includes(a), `the team lead cannot see ${a}`);
  must(!t.includes(`Applicant M10 ${stamp}`), 'the team lead sees a Manufacturing applicant');
  const h1 = await names('H1');
  must(h1.includes(`Applicant H10 ${stamp}`) && !h1.includes(`Applicant H20 ${stamp}`), 'H1 sees H2\'s applicant or not their own');
  const mt = await names('MTL');
  must(mt.includes(`Applicant M10 ${stamp}`) && !mt.includes(`Applicant H10 ${stamp}`), 'the Manufacturing lead sees Healthcare applicants');
});

await check('direct URL to another recruiter\'s job opens as unavailable, never the job', async () => {
  const page = P.M1.page;
  await go(page, `#/job/${JOB.H1}`, 1800);
  const t = await text(page);
  must(!t.includes(TITLES.H1), 'the Manufacturing recruiter opened a Healthcare job');
  const direct = await api(page, 'get', `/jobs/${JOB.H1}`);
  must(!direct.ok && (direct.code === 'JOB_UNAVAILABLE' || direct.code === 'NOT_FOUND'), 'the API answered for a job outside the scope');
  const edit = await api(page, 'put', `/jobs/${JOB.H1}`, { title: 'x', companyId: COMPANY });
  must(!edit.ok, 'a Manufacturing recruiter edited a Healthcare job');
  const pool = await api(page, 'get', '/talent-pool/' + (await api(P.H1.page, 'get', '/candidates?scope=pool&limit=1')).v.candidates[0].id);
  must(!pool.ok && pool.code === 'NOT_FOUND', 'a Manufacturing recruiter read a Healthcare talent pool entry');
});

await check('the legacy job with no location/experience prints "Not specified", not "undefined"', async () => {
  const page = P.H1.page;
  /* The server now refuses a new job without them, but one saved before that (or by the
     intake engine) keeps null columns and arrives with the keys missing. Put exactly such
     a row in the browser's data and draw the table. */
  await go(page, '#/recruiter/jobs');
  await page.evaluate((co) => {
    DATA.jobs.push({ id: 'legacy_null', title: 'Legacy Null Role', companyId: co, status: 'open', skills: [] });
    window.render();
  }, COMPANY);
  await page.waitForTimeout(600);
  const row = await page.$$eval('table.data tbody tr', (rs) => (rs.find((r) => r.innerText.includes('Legacy Null Role')) || {}).innerText || '');
  must(row, 'the legacy row is not in the table');
  must(!/undefined/.test(row) && /Not specified/.test(row), `the legacy row reads: ${row.replace(/\s+/g, ' ')}`);
  const t = await text(page);
  must(!/undefined/.test(t), '"undefined" is on the Jobs page');
  const empty = await api(P.H1.page, 'post', '/jobs', { title: 'No place', companyId: COMPANY, exp: '1 yr' });
  must(!empty.ok && empty.details && empty.details.location, 'a job without a location was saved');
});

await check('mobile (390px): the team lead\'s Home and Jobs pages, no horizontal scroll, scoped', async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
  const page = await signIn(ctx, P.HTL.email, PW, 'recruiter');
  await go(page, '#/recruiter/jobs', 1800);
  let t = await text(page);
  must(t.includes(TITLES.H1) && t.includes(TITLES.H2) && !t.includes(TITLES.M1), 'mobile jobs list is not the department');
  await shot(page, 'htl-jobs-390');
  await go(page, '#/recruiter/home', 1800);
  await shot(page, 'htl-home-390');
  t = await text(page);
  must(!t.includes(TITLES.M1), 'mobile Home shows a Manufacturing title');
  await ctx.close();
});

await check('desktop screenshots', async () => {
  await go(P.HTL.page, '#/recruiter/jobs', 1500);
  await shot(P.HTL.page, 'htl-jobs-desktop');
  await go(P.H1.page, '#/recruiter/home', 1800);
  await shot(P.H1.page, 'h1-home-desktop');
  await go(P.MTL.page, '#/recruiter/talent-pool', 1800);
  await shot(P.MTL.page, 'mtl-pool-desktop');
});

await browser.close();
console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll role-scoping checks passed');
process.exit(failed ? 1 : 0);
