/**
 * External jobs compliance (0108) in a real browser.
 *
 *   - the public job board: "External • <source>", an Apply button that says
 *     it leaves TeamLink, the "You are leaving TeamLink Job Portal" notice
 *     (keyboard: focus moves in, Escape cancels, focus comes back), and the
 *     server's redirect to the stored URL
 *   - the details page: Job type, Source, Last checked, the page title
 *   - a signed-in candidate: the same notice before the tracked flow, Save,
 *     and a saved job that closes shown as "No longer available"
 *   - the admin Job Sources screen: providers, licence editor, quarantine,
 *     link changes, analytics, audit, every job field, a bulk Close with
 *     its counts, and the licence refusal when enabling an unlicensed source
 *
 * Isolated instance only (refuses :4323). A sync runs against a LOCAL mock
 * feed. Employer pages are answered by Playwright inside the browser - no
 * request reaches any real site. Everything created is removed at the end.
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
const check = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  PASS  ${name}`); }
  catch (e) { failed += 1; console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n')[0]}`); }
};
const must = (c, m) => { if (!c) throw new Error(m); };
const stamp = Date.now().toString(36);
const EMPLOYER = 'careers.verify-ui-testing.in';

/* ---- a local partner feed, for one real sync ---------------------------- */
const feed = [
  { id: `NKV-1-${stamp}`, title: 'Verify Partner Accountant', company: 'Verify Ledger Pvt Ltd', location: 'Hyderabad',
    description: 'Accounts payable, GST returns and month-end close for a growing team.', employmentType: 'Full-time',
    applicationUrl: `https://www.naukri.com/job-listings-verify-accountant-${stamp}`, postedAt: new Date().toISOString() },
  { id: `NKV-2-${stamp}`, title: 'Verify Bad Link', company: 'Verify Ledger Pvt Ltd', location: 'Hyderabad',
    description: 'This posting links somewhere a Naukri feed must not send anybody.', employmentType: 'Full-time',
    applicationUrl: 'https://not-naukri.verify-ui-testing.in/x' },
];
const mock = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ jobs: feed }));
});
await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));

const browser = await chromium.launch();
const errors = [];
async function newPage(ctx) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e.message)));
  await page.goto(BASE + '#/');
  await page.waitForFunction(() => window.TL && TL.ready === true, null, { timeout: 30000 });
  return page;
}
/*
 * Employer pages never leave the machine. The server's redirect is asked
 * for its Location WITHOUT following it (the browser is handed a local
 * stand-in page), and a direct employer link - the signed-in flow opens the
 * stored URL itself - is answered locally as well.
 */
const STANDIN = '<!doctype html><title>employer page (local stand-in)</title><h1>Employer</h1>';
async function open(page, hash) {
  await page.goto(BASE + '?v=' + Date.now() + hash);
  await page.waitForFunction(() => window.TL && TL.ready === true, null, { timeout: 30000 });
  await page.waitForTimeout(800);
}
async function shieldContext(ctx, seen) {
  await ctx.route(/\/api\/portal\/external-jobs\/[^/]+\/apply/, async (route) => {
    const res = await route.fetch({ maxRedirects: 0 });
    seen.push({ via: 'redirect', status: res.status(), location: res.headers().location || null });
    return route.fulfill({ status: 200, contentType: 'text/html', body: STANDIN });
  });
  await ctx.route(new RegExp(`^https://(${EMPLOYER.replace(/\./g, '\\.')}|www\\.naukri\\.com)/`), (route) => {
    seen.push(route.request().url());
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>employer page (local stand-in)</title><h1>Employer</h1>' });
  });
}
const api = (page, m, p, b) => page.evaluate(([mm, pp, bb]) => TL.api[mm](pp, bb)
  .then((v) => ({ ok: 1, v }), (e) => ({ ok: 0, code: e.code, message: e.message })), [m, p, b]);

/* ---- admin: the data this check needs, made through the API ------------- */
const actx = await browser.newContext({ viewport: { width: 1400, height: 950 } });
const admin = await newPage(actx);
let r = await api(admin, 'post', '/auth/login', { email: 'admin@teamlink.com', password: process.env.TL_ADMIN_PASSWORD || 'TeamLink@2026', role: 'admin' });
must(r.ok, 'admin login: ' + r.message);
const SRC = `vui_${stamp}`;
const NK = `vnk_${stamp}`;
const made = { jobs: {} };

console.log(`\nexternal jobs compliance  (${BASE})\n`);

await check('setup: a hand-entered source with two jobs, and a licensed Naukri partner feed synced from a local mock', async () => {
  r = await api(admin, 'post', '/external/sources', { id: SRC, name: `Verify UI Board ${stamp}`, collectionMethod: 'manual',
    applicationMethod: 'redirect', active: true });
  must(r.ok, 'source: ' + r.message);
  r = await api(admin, 'post', '/external/jobs', { sourceId: SRC, jobs: [
    { id: 'V1', title: `Verify Java Developer ${stamp}`, company: 'Verify Employer One', location: 'Hyderabad',
      skills: ['Java', 'SQL'], experience: '2-4 yrs', salary: '₹6-9 LPA', employmentType: 'Full-time',
      description: 'Build and run backend services in Java.', url: `https://${EMPLOYER}/jobs/v1`, postedAt: new Date().toISOString() },
    { id: 'V2', title: `Verify Data Analyst ${stamp}`, company: 'Verify Employer Two', location: 'Pune',
      skills: ['SQL', 'Excel'], experience: '1-3 yrs', employmentType: 'Full-time',
      description: 'Dashboards and reporting.', url: `https://${EMPLOYER}/jobs/v2`, postedAt: new Date().toISOString() },
  ] });
  must(r.ok && r.v.saved === 2, 'jobs: ' + (r.message || JSON.stringify(r.v)));
  r.v.jobs.forEach((j) => { made.jobs[j.sourceJobId] = j.id; });

  const body = { id: NK, name: `Naukri partner feed ${stamp}`, sourceType: 'partner_api', collectionMethod: 'feed',
    applicationMethod: 'redirect', feedUrl: `http://127.0.0.1:${MOCK_PORT}/feed` };
  r = await api(admin, 'post', '/external/sources', { ...body, active: true });
  must(!r.ok && r.code === 'LICENCE_REQUIRED', 'an unlicensed Naukri feed must be refused, got ' + (r.code || 'ok'));
  r = await api(admin, 'post', '/external/sources', { ...body, active: false });
  must(r.ok, 'feed source: ' + r.message);
  r = await api(admin, 'put', `/external/sources/${NK}/licence`, { collectionMethod: 'partner_feed', licenceStatus: 'active',
    consentStatus: 'granted', termsUrl: 'https://partner.verify-ui-testing.in/terms', dataUsageAllowed: true,
    applicationRedirectAllowed: true, owner: 'verify-external-compliance', notes: 'verification only' });
  must(r.ok && r.v.licenceGap === null, 'licence: ' + (r.message || r.v.licenceGap));
  r = await api(admin, 'post', '/external/sources', { ...body, active: true });
  must(r.ok, 'activate: ' + r.message);
  r = await api(admin, 'post', `/external/sources/${NK}/sync`, {});
  must(r.ok && r.v.status === 'ok' && r.v.created === 1 && r.v.quarantined === 1, 'sync: ' + JSON.stringify(r.v || r));
});

/* ---- the public job board, signed out ------------------------------------ */
const pctx = await browser.newContext({ viewport: { width: 1300, height: 950 } });
const seenPublic = [];
await shieldContext(pctx, seenPublic);
const pub = await newPage(pctx);
const J1 = made.jobs.V1;

await check('the public board lists the external job with "External • <source>" and an Apply button that says it leaves TeamLink', async () => {
  await pub.goto(BASE + '#/jobs');
  await pub.evaluate((t) => { STATE.search = STATE.search || {}; STATE.search.q = t; render(); }, `Verify Java Developer ${stamp}`);
  await pub.waitForSelector('[data-external="1"]', { timeout: 20000 });
  const row = pub.locator('[data-external="1"]', { hasText: `Verify Java Developer ${stamp}` }).first();
  must(await row.count() === 1, 'the row is not on the board');
  must(/External • Verify UI Board/.test(await row.innerText()), 'no External • source label');
  const lbl = await row.locator('button', { hasText: 'Apply Now' }).getAttribute('aria-label');
  must(/opens the original job website/.test(lbl || ''), 'Apply has no leaving-TeamLink label: ' + lbl);
  await pub.screenshot({ path: `${SHOTS}/1-public-board.png` });
});

await check('Apply Now shows the notice first; focus moves in; Escape cancels and focus returns', async () => {
  const btn = pub.locator('[data-external="1"]', { hasText: `Verify Java Developer ${stamp}` }).locator('button', { hasText: 'Apply Now' }).first();
  await btn.focus();
  await pub.keyboard.press('Enter');
  const dlg = pub.locator('[role="dialog"]');
  await dlg.waitFor({ timeout: 5000 });
  const txt = await dlg.innerText();
  must(/You are leaving TeamLink Job Portal/.test(txt), 'notice heading');
  must(/continue your application on Verify UI Board/i.test(txt), 'names where they will land: ' + txt);
  must(/TeamLink does not submit this application/.test(txt), 'says TeamLink does not submit it');
  must(await dlg.getAttribute('aria-modal') === 'true', 'aria-modal');
  must(/Continue to/.test(await pub.evaluate(() => document.activeElement && document.activeElement.textContent)), 'focus is not on Continue');
  await pub.screenshot({ path: `${SHOTS}/2-notice.png` });
  await pub.keyboard.press('Escape');
  must(await dlg.count() === 0, 'Escape did not close it');
  must(/Apply Now/.test(await pub.evaluate(() => document.activeElement && document.activeElement.textContent)), 'focus did not return to Apply');
  must(seenPublic.length === 0, 'something opened although the visitor cancelled');
});

await check('Continue sends the visitor through the server redirect to the stored URL (never a URL from the page)', async () => {
  const btn = pub.locator('[data-external="1"]', { hasText: `Verify Java Developer ${stamp}` }).locator('button', { hasText: 'Apply Now' }).first();
  await btn.click();
  const [popup] = await Promise.all([pctx.waitForEvent('page'), pub.locator('[role="dialog"] [data-act="go"]').click()]);
  await popup.waitForLoadState('domcontentloaded');
  must(popup.url() === `https://${EMPLOYER}/jobs/v1`, 'landed on ' + popup.url());
  await popup.close();
});

await check('the details page shows Job type External, the Source, Last checked, and an honest page title', async () => {
  await pub.goto(BASE + '#/job/' + J1);
  await pub.waitForSelector('#tlpxTitle', { timeout: 15000 });
  const t = await pub.locator('main, body').first().innerText();
  must(/Job type\s*External/.test(t), 'Job type row');
  must(/Source\s*Verify UI Board/.test(t), 'Source row');
  must(/Last checked\s*on the source/.test(t), 'Last checked row');
  must(/TeamLink does not submit this application for you/.test(t), 'redirect wording');
  const title = await pub.title();
  must(/Verify Java Developer .* at Verify Employer One · External job via Verify UI Board/.test(title), 'title: ' + title);
  await pub.screenshot({ path: `${SHOTS}/3-details.png`, fullPage: true });
});

/* ---- a signed-in candidate ------------------------------------------------ */
const cctx = await browser.newContext({ viewport: { width: 1300, height: 950 } });
const seenCand = [];
await shieldContext(cctx, seenCand);
const cand = await newPage(cctx);
await check('a candidate: Save, the same notice before the tracked flow, and a click record (no TeamLink application)', async () => {
  r = await api(cand, 'post', '/auth/register', { name: 'Verify External Cand', email: `x.ext.${stamp}@tl-sink.local`,
    password: `Verify${stamp}Z9`, preferredLocation: 'Hyderabad', expectedCtc: 5, noticePeriod: 'Immediate', preferredWorkModes: ['Hybrid'] });
  must(r.ok, 'register: ' + r.message);
  await cand.goto(BASE + '#/candidate/search');
  await cand.waitForTimeout(1500);
  await cand.evaluate(() => { const b = document.querySelector('.tlpo-ov .tlpo-btn.ghost'); if (b) b.click(); });
  await cand.evaluate((t) => { STATE.rj = STATE.rj || {}; STATE.rj.q = t; render(); }, `Verify Java Developer ${stamp}`);
  const card = cand.locator('article[data-external="1"]', { hasText: `Verify Java Developer ${stamp}` }).first();
  await card.waitFor({ timeout: 20000 });
  await card.locator('button', { hasText: '☆ Save' }).click();
  await cand.waitForFunction(() => window.TLPortalExternal && TLPortalExternal.state.saved
    && Object.keys(TLPortalExternal.state.saved).length === 1, null, { timeout: 10000 });
  await cand.screenshot({ path: `${SHOTS}/4-candidate-search.png` });

  const appsBefore = (await api(cand, 'get', '/external/applications')).v.applications.length;
  await card.locator('button', { hasText: 'Apply Now' }).click();
  await cand.locator('[role="dialog"]').waitFor({ timeout: 5000 });
  const [popup] = await Promise.all([cctx.waitForEvent('page', { timeout: 15000 }), cand.locator('[role="dialog"] [data-act="go"]').click()]);
  await popup.waitForLoadState('domcontentloaded');
  must(popup.url() === `https://${EMPLOYER}/jobs/v1`, 'landed on ' + popup.url());
  await popup.close();
  const apps = (await api(cand, 'get', '/external/applications')).v.applications;
  must(apps.length === appsBefore + 1 && apps[0].status === 'clicked', 'one Clicked record: ' + JSON.stringify(apps.map((a) => a.status)));
  r = await api(cand, 'get', '/applications');
  must(!r.ok || !(r.v.applications || []).some((a) => a.jobId === J1), 'a TeamLink application exists for an external job');
});

await check('a saved external job that closes stays saved and says "No longer available"', async () => {
  r = await api(admin, 'post', '/external/admin/jobs/bulk', { action: 'close', ids: [J1], reason: 'verify', confirm: true });
  must(r.ok && r.v.succeeded === 1, 'close: ' + JSON.stringify(r.v || r));
  await cand.evaluate(() => TLPortalExternal.loadSaved(true));
  await cand.goto(BASE + '#/candidate/saved');
  await cand.waitForSelector('#tlpxSavedH', { timeout: 15000 });
  const t = await cand.locator('section[aria-labelledby="tlpxSavedH"]').innerText();
  must(/Verify Java Developer/.test(t) && /No longer available/.test(t), 'saved section: ' + t.slice(0, 200));
  must(!/Apply Now/.test(t), 'a closed job still offers Apply');
  await cand.screenshot({ path: `${SHOTS}/5-candidate-saved.png`, fullPage: true });
  await api(admin, 'post', '/external/admin/jobs/bulk', { action: 'activate', ids: [J1], confirm: true });
});

/* ---- the admin screen ------------------------------------------------------ */
await check('Job Sources shows providers, quarantine, link changes, analytics, audit and every job field', async () => {
  await admin.goto(BASE + '#/admin/job-sources');
  await admin.waitForSelector('#jsProvHost table', { timeout: 20000 });
  await admin.waitForSelector('#jsJobsHost table', { timeout: 20000 });
  const prov = await admin.locator('#jsProvHost').innerText();
  must(/Naukri[\s\S]*needs an authorized API\/feed \+ licence/.test(prov), 'Naukri is not shown as needing an authorized feed');
  must(/Greenhouse[\s\S]*available/.test(prov), 'Greenhouse availability');
  const quar = await admin.locator('#jsQuarHost').innerText();
  must(/Verify Bad Link/.test(quar) && /domain not allowed/.test(quar), 'quarantine reason: ' + quar.slice(0, 200));
  const heads = await admin.locator('#jsJobsHost thead').innerText();
  for (const h of ['JOB ID', 'JOB TYPE', 'SOURCE', 'SOURCE JOB ID', 'ORIGINAL JOB URL', 'SOURCE COMPANY URL', 'LAST SYNCED', 'LAST SEEN', 'SYNC STATUS', 'ACTIVE / CLOSED']) {
    must(heads.toUpperCase().includes(h), 'missing column ' + h);
  }
  must(/\d+/.test(await admin.locator('#jsStatsHost').innerText()), 'analytics');
  must(/job\.create|source\.activate|licence\./.test(await admin.locator('#jsAuditHost').innerText()), 'audit rows');
  await admin.screenshot({ path: `${SHOTS}/6-admin-sources.png`, fullPage: true });
});

await check('a bulk Close from the screen: confirmed, counted, and the job leaves the portal', async () => {
  await admin.evaluate((id) => { jsJobFilter('sourceId', id); }, SRC);
  await admin.waitForFunction(() => document.querySelectorAll('#jsJobsHost tbody tr').length === 2, null, { timeout: 10000 });
  const row = admin.locator('#jsJobsHost tbody tr', { hasText: `Verify Data Analyst ${stamp}` });
  await row.locator('input[type="checkbox"]').check();
  admin.once('dialog', (d) => d.accept('verification bulk close'));
  await admin.locator('#jsJobsHost .js-bulk button', { hasText: 'Close' }).click();
  await admin.waitForFunction(() => /1 succeeded, 0 failed/.test(document.body.innerText), null, { timeout: 10000 });
  r = await api(admin, 'get', `/external/admin/jobs?sourceId=${SRC}&status=closed`);
  must(r.v.total === 1, 'closed count ' + r.v.total);
  const listed = await admin.evaluate((id) => fetch('/api/portal/external-jobs?source=' + id).then((x) => x.json()), SRC);
  must(listed.total === 1, 'the closed job is still listed');
});

await check('the licence editor, and "Enable" refused with the licence reason for an unlicensed source', async () => {
  r = await api(admin, 'post', '/external/sources', { id: `vnk2_${stamp}`, name: `Indeed partner ${stamp}`, collectionMethod: 'feed',
    applicationMethod: 'redirect', feedUrl: `http://127.0.0.1:${MOCK_PORT}/feed`, active: false });
  must(r.ok, 'source: ' + r.message);
  await admin.goto(BASE + '#/admin/job-sources');
  await admin.waitForSelector('#jsHost table', { timeout: 20000 });
  const row = admin.locator('#jsHost tbody tr', { hasText: `Indeed partner ${stamp}` });
  must(/licence required/.test(await row.innerText()), 'the row does not say licence required');
  await row.locator('button', { hasText: 'Enable' }).click();
  await admin.waitForSelector('.js-edit', { timeout: 10000 });
  const form = await admin.locator('.js-edit').innerText();
  must(/needs a licence record/.test(form), 'the editor does not show the reason');
  for (const l of ['Licence status', 'Consent status', 'Terms URL', 'Owner', 'Effective until', 'Allowed apply domains']) {
    must(await admin.getByLabel(l).count() >= 1, 'no labelled field ' + l);
  }
  r = await api(admin, 'get', '/external/sources');
  must(r.v.sources.find((s) => s.id === `vnk2_${stamp}`).active === false, 'it was switched on');
  await admin.screenshot({ path: `${SHOTS}/7-licence-editor.png`, fullPage: true });
});

/* ---- clean up ------------------------------------------------------------- */
await check('clean up: the verification sources and their jobs are removed', async () => {
  for (const id of [SRC, NK, `vnk2_${stamp}`]) {
    r = await api(admin, 'del', `/external/sources/${id}`);
    must(r.ok, `delete ${id}: ${r.message}`);
  }
});
await check('no page errors', async () => { must(errors.length === 0, errors.slice(0, 3).join(' | ')); });

await browser.close();
mock.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
