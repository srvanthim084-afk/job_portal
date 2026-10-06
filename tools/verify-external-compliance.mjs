/**
 * External jobs, end to end in a real browser - the owner's final rule:
 *
 *   TEAMLINK JOB = apply inside TeamLink, the existing flow unchanged.
 *   EXTERNAL JOB = Apply Now opens the ORIGINAL job URL, in a new tab.
 *   Never the TeamLink form for an external job; never the two mixed.
 *
 *   T1  a TeamLink job opens the TeamLink application form (unchanged)
 *   T2  a Naukri fixture job: Apply Now opens exactly its stored URL
 *   T3  a Shine fixture job: the same
 *   T4  an Indeed fixture job: the same
 *       ... each click is recorded as "Apply Clicked" and no `applications`
 *       row is created; the cards carry the source's name
 *       (0113: on the External Jobs page ONLY - the Jobs page, signed in or
 *       out, never lists them; tools/verify-job-source-separation.mjs is the
 *       full separation check)
 *   T5  a job whose link is not approved: "Application link unavailable",
 *       no button
 *   T6  a re-sync updates the job, and creates no duplicate
 *   T7  an expired job: "Job no longer available", no active Apply Now
 *   +   the admin list (title | company | source | original URL | status |
 *       collected | updated), the recruiter's read-only list, and the
 *       licence guard refusing to switch an unlicensed source on
 *
 * The three partner sources are LICENSED IN THIS TEST ONLY and are fed by a
 * local mock feed through the provider contract - nothing is fetched from
 * Naukri, Shine or Indeed, and every employer page is answered by
 * Playwright's ctx.route inside the browser. Isolated instance only
 * (refuses :4323). Everything this creates is removed at the end.
 *
 *   TL_URL=http://localhost:4423/ MOCK_PORT=9863 node tools/verify-external-compliance.mjs
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';

const BASE = (process.env.TL_URL || 'http://localhost:4423/').replace(/\/?$/, '/');
const MOCK_PORT = Number(process.env.MOCK_PORT || 9863);
const SHOTS = process.env.SHOTS || 'var/verify-shots/external-compliance';
const u = new URL(BASE);
if (!['127.0.0.1', 'localhost'].includes(u.hostname) || u.port === '4323') {
  console.error(`Refusing to run against ${BASE}: this creates sources and jobs. Use an isolated instance.`);
  process.exit(2);
}
mkdirSync(SHOTS, { recursive: true });

let failed = 0;
let passed = 0;
const pages = {};
const check = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  PASS  ${name}`); }
  catch (e) {
    failed += 1; console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n')[0]}`);
    for (const [k, pg] of Object.entries(pages)) await pg.screenshot({ path: `${SHOTS}/fail-${failed}-${k}.png` }).catch(() => {});
  }
};
const must = (c, m) => { if (!c) throw new Error(m); };
const stamp = Date.now().toString(36);

/* ---- one local feed per partner: fixtures, through the provider contract ---- */
const FEEDS = {
  naukri: { name: 'Naukri', url: (n) => `https://www.naukri.com/job-listings-verify-${n}-${stamp}` },
  shine: { name: 'Shine', url: (n) => `https://www.shine.com/jobs/verify-${n}-${stamp}` },
  indeed: { name: 'Indeed', url: (n) => `https://in.indeed.com/viewjob?jk=verify${n}${stamp}` },
};
const feedJobs = {};
for (const [k, f] of Object.entries(FEEDS)) {
  feedJobs[k] = [{
    id: `${k.toUpperCase()}-${stamp}`, title: `Verify ${f.name} Accountant ${stamp}`, company: `Verify ${f.name} Employer`,
    location: 'Hyderabad', description: `Accounts payable, GST returns and month-end close - a ${f.name} fixture posting.`,
    skills: ['Tally', 'GST'], experience: '2-4 yrs', salary: '₹4-6 LPA', employmentType: 'Full-time',
    applicationUrl: f.url(1), postedAt: new Date().toISOString(),
  }];
}
const mock = createServer((req, res) => {
  const k = (/^\/feed\/(\w+)/.exec(req.url) || [])[1];
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ jobs: feedJobs[k] || [] }));
});
await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));

const browser = await chromium.launch();
const errors = [];
const STANDIN = '<!doctype html><title>employer page (local stand-in)</title><h1>Original job page</h1>';
async function context(seen) {
  const ctx = await browser.newContext({ viewport: { width: 1320, height: 950 } });
  /* No request reaches a real job site. */
  await ctx.route(/^https:\/\/([a-z0-9-]+\.)*(naukri\.com|shine\.com|indeed\.com|verify-ui-testing\.in)\//, (route) => {
    seen.push(route.request().url());
    return route.fulfill({ status: 200, contentType: 'text/html', body: STANDIN });
  });
  return ctx;
}
async function newPage(ctx, name) {
  const page = await ctx.newPage();
  pages[name] = page;
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  await page.goto(BASE + '#/');
  await page.waitForFunction(() => window.TL && TL.ready === true, null, { timeout: 30000 });
  return page;
}
async function open(page, hash) {
  await page.goto(BASE + '?v=' + Date.now() + hash);
  await page.waitForFunction(() => window.TL && TL.ready === true, null, { timeout: 30000 });
  await page.waitForTimeout(1200);
}
const api = (page, m, p, b) => page.evaluate(([mm, pp, bb]) => TL.api[mm](pp, bb)
  .then((v) => ({ ok: 1, v }), (e) => ({ ok: 0, code: e.code, message: e.message })), [m, p, b]);
const wizardAway = (page) => page.evaluate(() => { const b = document.querySelector('.tlpo-ov .tlpo-btn.ghost'); if (b) b.click(); });

/* ---- setup, as the administrator and a recruiter -------------------------- */
const seenAdmin = [];
const actx = await context(seenAdmin);
const admin = await newPage(actx, 'admin');
let r = await api(admin, 'post', '/auth/login', { email: 'admin@teamlink.com', password: process.env.TL_ADMIN_PASSWORD || 'TeamLink@2026', role: 'admin' });
must(r.ok, 'admin login: ' + r.message);
const SRC = {};
const X = {};
let TLJOB = null;

console.log(`\nexternal jobs  (${BASE})\n`);

/* Leftovers of an interrupted earlier run of THIS script (ids v<kind>_<stamp>). */
{
  const old = await api(admin, 'get', '/external/sources');
  for (const s of (old.v && old.v.sources) || []) {
    if (/^v(naukri|shine|indeed|other|nk|nk2|ui)_[a-z0-9]+$/.test(s.id)) await api(admin, 'del', `/external/sources/${s.id}`);
  }
}

await check('setup: Naukri, Shine and Indeed partner feeds - refused without a licence, licensed here, synced from local fixtures', async () => {
  for (const [k, f] of Object.entries(FEEDS)) {
    const id = `v${k}_${stamp}`;
    SRC[k] = id;
    const body = { id, name: `${f.name} partner feed ${stamp}`, sourceType: 'partner_api', collectionMethod: 'feed',
      applicationMethod: 'redirect', feedUrl: `http://127.0.0.1:${MOCK_PORT}/feed/${k}` };
    r = await api(admin, 'post', '/external/sources', { ...body, active: true });
    must(!r.ok && r.code === 'LICENCE_REQUIRED', `${f.name}: an unlicensed source must be refused, got ${r.code || 'ok'}`);
    r = await api(admin, 'post', '/external/sources', { ...body, active: false });
    must(r.ok, `${f.name} source: ${r.message}`);
    r = await api(admin, 'put', `/external/sources/${id}/licence`, { collectionMethod: 'partner_feed', licenceStatus: 'active',
      consentStatus: 'granted', termsUrl: 'https://partner.verify-ui-testing.in/terms', dataUsageAllowed: true,
      applicationRedirectAllowed: true, owner: 'verify-external-compliance', notes: 'verification only - test licence' });
    must(r.ok && r.v.licenceGap === null, `${f.name} licence: ${r.message || r.v.licenceGap}`);
    r = await api(admin, 'post', '/external/sources', { ...body, active: true });
    must(r.ok, `${f.name} activate: ${r.message}`);
    r = await api(admin, 'post', `/external/sources/${id}/sync`, {});
    must(r.ok && r.v.status === 'ok' && r.v.created === 1, `${f.name} sync: ${JSON.stringify(r.v || r)}`);
    const list = await api(admin, 'get', `/portal/external-jobs?source=${id}`);
    X[k] = list.v.jobs[0];
    must(X[k] && X[k].originalJobUrl === f.url(1), `${f.name}: stored URL ${X[k] && X[k].originalJobUrl}`);
  }
  /* A hand-entered source with no approved domain: its link is unusable (T5). */
  SRC.other = `vother_${stamp}`;
  r = await api(admin, 'post', '/external/sources', { id: SRC.other, name: `Verify Other Board ${stamp}`, collectionMethod: 'manual',
    applicationMethod: 'redirect', active: true });
  must(r.ok, 'other source: ' + r.message);
  r = await api(admin, 'post', '/external/jobs', { sourceId: SRC.other, jobs: [{ id: 'VO-1', title: `Verify Unapproved Link ${stamp}`,
    company: 'Verify Other Employer', location: 'Hyderabad', description: 'A posting whose link is on no approved domain.',
    url: 'https://careers.verify-ui-testing.in/jobs/vo1', postedAt: new Date().toISOString() }] });
  must(r.ok && r.v.saved === 1, 'other job: ' + (r.message || JSON.stringify(r.v)));
  X.other = r.v.jobs[0];

  /* A TeamLink job, by the recruiter, under their own company. */
  const rctx = await browser.newContext();
  const rp = await rctx.newPage();
  await rp.goto(BASE + '#/');
  await rp.waitForFunction(() => window.TL && TL.ready === true, null, { timeout: 30000 });
  TLJOB = await rp.evaluate(async (s) => {
    await TL.api.post('/auth/login', { email: 'recruiter@teamlink.com', password: 'TeamLink@2026', role: 'recruiter' });
    const boot = await TL.api.get('/bootstrap');
    const myCo = ((boot.data.recruiters || []).find((x) => boot.session && x.id === boot.session.id) || {}).companyId;
    const co = (boot.data.companies || []).find((x) => x.id === myCo) || (boot.data.companies || [])[0];
    const j = await TL.api.post('/jobs', { title: `Verify TeamLink Job ${s}`, companyId: co.id, location: 'Hyderabad',
      mode: 'Onsite', exp: '0-2 yrs', pay: '₹3 LPA', salaryMin: 3, salaryMax: 3, type: 'Full-time', status: 'open',
      skills: ['Tally'], description: 'Verification job - safe to delete.' });
    await TL.api.put(`/jobs/${j.job.id}/screening-questions`, { questions: [] });
    return j.job.id;
  }, stamp);
  await rctx.close();
  must(TLJOB, 'no TeamLink job');
});

/* ---- a candidate --------------------------------------------------------- */
const seenCand = [];
const cctx = await context(seenCand);
const cand = await newPage(cctx, 'cand');
r = await api(cand, 'post', '/auth/register', { name: 'Verify External Cand', email: `x.ext.${stamp}@tl-sink.local`,
  password: `Verify${stamp}Z9`, phone: '9' + String(Date.now()).slice(-9), preferredLocation: 'Hyderabad', expectedCtc: 5,
  noticePeriod: 'Immediate', preferredWorkModes: ['Hybrid'] });
if (!r.ok) console.log('register: ' + r.message);
const applicationsNow = async () => ((await api(cand, 'get', '/bootstrap')).v.data.applications || []).length;
const clicks = async () => ((await api(cand, 'get', '/external/applications')).v.applications || []);

/* 0113: external jobs are on the External Jobs page, never on the Jobs page. */
async function externalCard(page, title) {
  await open(page, '#/candidate/external-jobs');
  await wizardAway(page);
  await page.waitForFunction(() => window.TLPortalExternal && TLPortalExternal.state.jobs, null, { timeout: 20000 });
  await page.waitForFunction(() => typeof window.xjFilter === 'function' && document.querySelector('.xj-card, .xj-empty'), null, { timeout: 20000 });
  await page.evaluate((q) => window.xjFilter('skill', q), title);
  const card = page.locator('.xj-card', { hasText: title }).first();
  await card.waitFor({ timeout: 20000 });
  return card;
}
async function notOnJobsPage(page, title) {
  await open(page, '#/candidate/search');
  await wizardAway(page);
  await page.evaluate((q) => { STATE.rj = STATE.rj || {}; STATE.rj.q = q; render(); }, title);
  await page.waitForTimeout(1200);
  must(!(await page.locator('body').innerText()).includes(title), 'the Jobs page lists an external job: ' + title);
  must(!(await page.locator('[data-external]').count()), 'an external card on the Jobs page');
}

for (const [t, k] of [['T2', 'naukri'], ['T3', 'shine'], ['T4', 'indeed']]) {
  await check(`${t}  ${FEEDS[k].name}: on External Jobs (not on Jobs) with its source, Apply Now opens exactly the stored URL, "Apply Clicked" recorded, no application`, async () => {
    const title = `Verify ${FEEDS[k].name} Accountant ${stamp}`;
    await notOnJobsPage(cand, title);
    const card = await externalCard(cand, title);
    must(new RegExp(`${FEEDS[k].name} partner feed`).test(await card.innerText()), 'no source name: ' + (await card.innerText()).slice(0, 160));
    const apps = await applicationsNow();
    const before = (await clicks()).length;
    const [popup] = await Promise.all([cctx.waitForEvent('page', { timeout: 10000 }), card.locator('button', { hasText: /^Apply/ }).first().click()]);
    await popup.waitForLoadState('domcontentloaded');
    /* 0115: the tab opens blank inside the click and is pointed at the
       stored URL once the server confirms the posting still exists. */
    await popup.waitForURL(FEEDS[k].url(1), { timeout: 10000 }).catch(() => {});
    must(popup.url() === FEEDS[k].url(1), 'opened ' + popup.url());
    must(!(await cand.locator('#tlafForm').count()) && !(await cand.locator('[role="dialog"]').count()), 'a screen came in between');
    must(await popup.evaluate(() => window.opener === null), 'the new tab can reach TeamLink (no noopener)');
    await popup.close();
    await cand.waitForFunction(async (n) => (await TL.api.get('/external/applications')).applications.length > n, before, { timeout: 10000, polling: 500 });
    const row = (await clicks()).find((x) => x.externalJobId === X[k].id);
    must(row && row.status === 'clicked' && row.statusLabel === 'Apply Clicked', 'click record: ' + JSON.stringify(row && [row.status, row.statusLabel]));
    must(row.sourceName && row.createdAt, 'the record names the source and the time');
    must(await applicationsNow() === apps, 'an applications row was created');
    if (k === 'naukri') await cand.screenshot({ path: `${SHOTS}/T2-external-jobs.png` });
  });
}

await check('T1  a TeamLink job opens the TeamLink application form (unchanged), and an external job never does', async () => {
  await open(cand, '#/job/' + TLJOB);
  await wizardAway(cand);
  await cand.evaluate((id) => { setTimeout(() => window.applyToJob(id), 0); }, TLJOB);
  await cand.waitForSelector('#tlafForm', { timeout: 15000 });
  await cand.screenshot({ path: `${SHOTS}/T1-teamlink-form.png` });
  await cand.evaluate(() => { const x = document.querySelector('[data-tlaf-close]'); if (x) x.click(); });
  await cand.waitForTimeout(500);
  const before = seenCand.length;
  const [popup] = await Promise.all([cctx.waitForEvent('page', { timeout: 10000 }),
    cand.evaluate((id) => { setTimeout(() => window.applyToJob(id), 0); }, X.naukri.id)]);
  await popup.waitForLoadState('domcontentloaded');
  /* From a TeamLink job's page the external list is not loaded (0113: it is
     read only where external jobs are shown), so the tab is pointed at the
     stored URL when the server answers. */
  await popup.waitForURL(X.naukri.originalJobUrl, { timeout: 10000 }).catch(() => {});
  await cand.waitForTimeout(400);
  must(!(await cand.locator('#tlafForm').count()), 'the TeamLink form opened for an external job');
  must(popup.url() === X.naukri.originalJobUrl, 'applyToJob(external) opened ' + popup.url());
  must(seenCand.length === before + 1, 'one employer page');
  await popup.close();
});

await check('T2-T4 signed out: not on the public board; the external job page opens the stored URL directly (no TeamLink URL in between)', async () => {
  const seen = [];
  const pctx = await context(seen);
  const pub = await newPage(pctx, 'public');
  const title = `Verify Indeed Accountant ${stamp}`;
  await open(pub, '#/jobs');
  await pub.evaluate((q) => { STATE.search = STATE.search || {}; STATE.search.q = q; render(); }, title);
  await pub.waitForTimeout(1200);
  must(!(await pub.locator('body').innerText()).includes(title), 'the public board lists an external job');
  must(!(await pub.locator('[data-external]').count()), 'an external row on the public board');
  await open(pub, '#/job/' + X.indeed.id);
  await pub.waitForSelector('#tlpxTitle', { timeout: 15000 });
  must(/Source/.test(await pub.locator('article').first().innerText()), 'the details page names the source');
  const reqs = [];
  pub.on('request', (q) => reqs.push(q.url()));
  const [popup] = await Promise.all([pctx.waitForEvent('page', { timeout: 10000 }), pub.locator('article button', { hasText: 'Apply Now' }).first().click()]);
  await popup.waitForLoadState('domcontentloaded');
  await popup.waitForURL(FEEDS.indeed.url(1), { timeout: 10000 }).catch(() => {});   // 0115: blank first, then the URL
  must(popup.url() === FEEDS.indeed.url(1), 'opened ' + popup.url());
  await pub.waitForTimeout(600);
  must(reqs.some((x) => /\/api\/portal\/external-jobs\/[^/]+\/click$/.test(x)), 'the click was not counted');
  await pub.screenshot({ path: `${SHOTS}/T4-public-details.png` });
  await pctx.close();
  delete pages.public;
});

await check('T5  a link on no approved domain: "Application link unavailable", nothing opens', async () => {
  const title = `Verify Unapproved Link ${stamp}`;
  await notOnJobsPage(cand, title);
  const card = await externalCard(cand, title);
  const before = seenCand.length;
  await card.locator('button', { hasText: /^Apply/ }).first().click();
  await cand.waitForFunction(() => /Application link unavailable/.test(document.body.innerText), null, { timeout: 8000 });
  await cand.waitForTimeout(600);
  must(seenCand.length === before, 'something opened for an unusable link');
  await open(cand, '#/job/' + X.other.id);
  await cand.waitForSelector('#tlpxTitle', { timeout: 15000 });
  must(/Application link unavailable/.test(await cand.locator('article').first().innerText()), 'details page');
  must(await cand.locator('article button', { hasText: 'Apply Now' }).count() === 0, 'an Apply Now button is offered');
  await cand.screenshot({ path: `${SHOTS}/T5-link-unavailable.png` });
});

await check('T6  a re-sync updates the job and creates no duplicate', async () => {
  feedJobs.naukri[0].title = `Verify Naukri Accountant ${stamp} (Senior)`;
  r = await api(admin, 'post', `/external/sources/${SRC.naukri}/sync`, {});
  must(r.ok && r.v.status === 'ok' && r.v.created === 0 && r.v.updated === 1, 'sync: ' + JSON.stringify(r.v || r));
  const list = await api(admin, 'get', `/portal/external-jobs?source=${SRC.naukri}`);
  must(list.v.total === 1 && list.v.jobs[0].id === X.naukri.id, 'one job, the same id: ' + list.v.total);
  must(/\(Senior\)$/.test(list.v.jobs[0].title), 'not updated: ' + list.v.jobs[0].title);
});

await check('T7  an expired job: "Job no longer available", no active Apply Now', async () => {
  feedJobs.shine[0].status = 'expired';
  r = await api(admin, 'post', `/external/sources/${SRC.shine}/sync`, {});
  must(r.ok, 'sync: ' + JSON.stringify(r.v || r));
  const list = await api(admin, 'get', `/portal/external-jobs?source=${SRC.shine}`);
  must(list.v.total === 0, 'an expired job is still listed');
  await open(cand, '#/job/' + X.shine.id);
  await cand.waitForFunction(() => /no longer available/i.test(document.body.innerText), null, { timeout: 15000 });
  const txt = await cand.locator('body').innerText();
  must(/This job is no longer available/.test(txt), 'details page');
  must(await cand.locator('button', { hasText: 'Apply Now' }).count() === 0, 'Apply Now still offered');
  const before = seenCand.length;
  await cand.evaluate((id) => window.tlpxApply(id), X.shine.id);
  await cand.waitForTimeout(800);
  must(seenCand.length === before, 'something opened for an expired job');
  await cand.screenshot({ path: `${SHOTS}/T7-expired.png` });
});

await check('admin: the list (title | company | source | original URL | status | collected | updated) and the source ON/OFF', async () => {
  await open(admin, '#/admin/job-sources');
  await admin.waitForSelector('#jsJobsHost table', { timeout: 20000 });
  await admin.evaluate(() => jsJobFilter('status', 'all'));
  await admin.waitForTimeout(1500);
  const heads = (await admin.locator('#jsJobsHost thead').innerText()).toUpperCase();
  for (const hd of ['TITLE', 'COMPANY', 'SOURCE', 'ORIGINAL URL', 'STATUS', 'DATE COLLECTED', 'LAST UPDATED']) must(heads.includes(hd), 'missing ' + hd);
  const body = await admin.locator('#jsJobsHost tbody').innerText();
  must(body.includes(FEEDS.naukri.url(1)) && /Expired/.test(body), 'rows: ' + body.slice(0, 200));
  const srcRow = admin.locator('#jsHost tbody tr', { hasText: 'Indeed partner feed' });
  must(await srcRow.locator('button', { hasText: 'Disable' }).count() === 1, 'no ON/OFF for the source');
  await admin.screenshot({ path: `${SHOTS}/admin-list.png`, fullPage: true });
});

await check('recruiter: the external jobs list, with no configuration', async () => {
  const rctx = await browser.newContext({ viewport: { width: 1320, height: 900 } });
  const rp = await newPage(rctx, 'recruiter');
  r = await api(rp, 'post', '/auth/login', { email: 'recruiter@teamlink.com', password: 'TeamLink@2026', role: 'recruiter' });
  must(r.ok, 'recruiter login');
  await open(rp, '#/recruiter/external-jobs');
  await rp.waitForSelector('#jsJobsHost table', { timeout: 20000 });
  const txt = await rp.locator('main, body').first().innerText();
  must(/Verify Naukri Accountant/.test(txt), 'the list');
  must(!/Licence|Allowed apply domains|Sync now|Disable|Providers and how/.test(txt), 'technical configuration is visible to a recruiter');
  must(await rp.locator('#jsJobsHost .js-bulk').count() === 0, 'bulk actions offered to a recruiter');
  r = await api(rp, 'put', `/external/sources/${SRC.naukri}/licence`, { collectionMethod: 'partner_feed', licenceStatus: 'active',
    consentStatus: 'granted', dataUsageAllowed: true, applicationRedirectAllowed: true });
  must(!r.ok && r.code === 'FORBIDDEN', 'a recruiter changed a licence');
  await rp.screenshot({ path: `${SHOTS}/recruiter-list.png` });
  await rctx.close();
  delete pages.recruiter;
});

/* ---- clean up ------------------------------------------------------------- */
await check('clean up: the verification sources and their jobs are removed', async () => {
  for (const id of Object.values(SRC)) {
    r = await api(admin, 'del', `/external/sources/${id}`);
    must(r.ok, `delete ${id}: ${r.message}`);
  }
});
await check('no page errors', async () => { must(errors.length === 0, errors.slice(0, 3).join(' | ')); });

await browser.close();
mock.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
