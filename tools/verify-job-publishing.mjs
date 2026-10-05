/**
 * Save & Post (0112) in a real browser, desktop and 390 px wide.
 *
 *   1  recruiter: the AI Job Creation form has "Post to" (Portal + Website
 *      ticked, Naukri / Shine / Indeed "Integration Required") and its
 *      button reads Save & Post
 *   2  Save & Post: Portal and Website reach Posted with real URLs that
 *      answer anonymously; Naukri / Shine / Indeed are Integration Required
 *   3  Manage Jobs shows a badge per destination, Posted ones linking out;
 *      the job's own page has the Publishing panel
 *   4  the Edit and Post A Walk-in Job forms carry the same block
 *   5  a recruiter cannot open Integrations (no menu entry, no screen, 403)
 *   6  admin: Integrations lists the platforms; a WRONG key fails Test
 *      Connection honestly; the right key passes; "•••• saved" + 4 chars
 *   7  Publish waiting jobs now -> the Naukri badge shows Posted with the
 *      external URL the (mock) platform returned
 *   8  390 px: the form block and Integrations fit, no sideways scroll
 *   9  the secret never appears in any response or on any page
 *  10  no page errors
 *
 * NO REAL PLATFORM IS CONTACTED: "Naukri" is a mock partner API started by
 * this script on 127.0.0.1, configured through the Integrations screen the
 * way an administrator would configure the real authorized endpoint.
 *
 * Creates jobs and configuration, so it refuses :4323. Run against an
 * isolated instance:  TL_URL=http://127.0.0.1:4427/ node tools/verify-job-publishing.mjs
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = (process.env.TL_URL || 'http://127.0.0.1:4427/').replace(/\/?$/, '/');
const url = new URL(BASE);
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.port === '4323') {
  console.error(`Refusing to run against ${BASE}: this creates jobs and integrations. Use an isolated instance.`);
  process.exit(2);
}
const SHOTS = process.env.TL_SHOTS || join(tmpdir(), 'tl-verify-job-publishing');
mkdirSync(SHOTS, { recursive: true });
const RECRUITER = process.env.TL_RECRUITER_EMAIL || 'recruiter@teamlink.com';
const ADMIN = process.env.TL_ADMIN_EMAIL || 'admin@teamlink.com';
const PW = process.env.TL_RECRUITER_PASSWORD || process.env.DEV_PASSWORD || 'TeamLink@2026';
const MOCK_PORT = Number(process.env.TL_MOCK_PARTNER_PORT || 9894);
const stamp = Date.now().toString(36);
const SECRET = `nk_verify_${stamp}_9f8e7d6c5b4a`;
const WRONG = `wrong_${stamp}_000000000000`;

let failed = 0;
const ONLY = process.env.TL_ONLY ? new RegExp(process.env.TL_ONLY) : null;
const check = async (name, fn) => {
  if (ONLY && !ONLY.test(name)) return;
  try { await fn(); console.log(`  PASS  ${name}`); }
  catch (e) { console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n')[0]}`); failed += 1; }
};
const must = (c, m) => { if (!c) throw new Error(m); };

/* ---------------- the mock partner platform ---------------- */
const calls = [];
let seq = 0;
const mock = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    calls.push({ method: req.method, path: req.url, auth: req.headers.authorization || '', body });
    const send = (s, o) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(o === undefined ? '' : JSON.stringify(o)); };
    if (req.headers.authorization !== `Bearer ${SECRET}`) return send(401, { message: 'invalid api key' });
    if (req.method === 'GET' && req.url === '/naukri/account') return send(200, { account: 'ok' });
    if (req.method === 'POST' && req.url === '/naukri/jobs') { seq += 1; return send(201, { jobId: `NK-V-${seq}`, jobUrl: `https://naukri.partner.test/job-listings-${stamp}-${seq}`, status: 'live' }); }
    if (req.method === 'PUT' || req.method === 'DELETE') return send(200, {});
    return send(404, { message: 'no route' });
  });
});
await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));

const browser = await chromium.launch();
const errors = [];
const leaks = [];
const ready = (page) => page.waitForFunction(() => window.TL && TL.ready === true, null, { timeout: 90000 });
/*
 * Every response the page's own code reads (the app talks to the server
 * only through fetch) is checked for the secret inside the page, and a
 * hit is reported back. (Awaiting response bodies from Playwright's
 * 'response' event stalls the page's own requests here.)
 */
async function watch(page, who) {
  page.on('pageerror', (e) => errors.push(`${who}: ${e.message}`));
  await page.route(/\/(api|feeds|hooks)\//, async (route) => {
    let res;
    if (process.env.TL_DEBUG) console.log('>>', route.request().method(), route.request().url());
    try { res = await route.fetch(); } catch (e) { if (process.env.TL_DEBUG) console.log('xx', e.message); return route.continue().catch(() => {}); }
    if (process.env.TL_DEBUG) console.log('<<', res.status(), route.request().url());
    try {
      const body = await res.body();
      const t = body.toString('utf8');
      if (t.includes(SECRET) || t.includes(WRONG)) leaks.push(`${who}: ${route.request().method()} ${route.request().url()}`);
      /* the body is already decoded: drop the encoding headers with it */
      const headers = { ...res.headers() };
      delete headers['content-encoding']; delete headers['content-length'];
      return route.fulfill({ status: res.status(), headers, body });
    } catch { return route.continue().catch(() => {}); }
  });
}
async function open(ctx, who) {
  const page = await ctx.newPage();
  await watch(page, who);
  await page.goto(BASE + '#/', { waitUntil: 'domcontentloaded' });
  await ready(page);
  return page;
}
const wizardAway = (page) => page.evaluate(() => {
  document.querySelectorAll('.tlpo-ov .tlpo-btn.ghost, .tlpo-ov .tlpo-skip, .tlpo-ov [data-act="later"]').forEach((b) => b.click());
});
const go = async (page, hash) => { await page.evaluate((h) => { location.hash = h; }, hash); await page.waitForTimeout(1400); await wizardAway(page); };
const shot = (page, name) => page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false });
const text = (page, sel = '#app') => page.evaluate((s) => ((document.querySelector(s) || {}).innerText || ''), sel);
const pageHasSecret = (page) => page.evaluate((ks) => {
  const all = document.documentElement.outerHTML + ' ' + Array.from(document.querySelectorAll('input')).map((i) => i.value).join(' ');
  return ks.some((k) => all.includes(k));
}, [SECRET, WRONG]);
async function signIn(page, email, role, hash) {
  const r = await page.evaluate((b) => TL.api.post('/auth/login', b).then(() => 'ok', (x) => x.message), { email, password: PW, role });
  must(r === 'ok', `${role} could not sign in: ${r}`);
  await page.goto('about:blank'); await page.goto(BASE + hash, { waitUntil: 'domcontentloaded' }); await ready(page); await page.waitForTimeout(1500);
  await wizardAway(page); await page.waitForTimeout(500); await wizardAway(page);
}
const pubs = (page, id) => page.evaluate((j) => TL.api.get(`/jobs/${encodeURIComponent(j)}/publications`).then((r) => r.publications), id);
const byDest = (list) => Object.fromEntries((list || []).map((p) => [p.destination, p]));
async function waitPubs(page, id, done, ms = 30000) {
  const until = Date.now() + ms;
  let last = null;
  while (Date.now() < until) {
    last = await pubs(page, id).catch(() => null);
    if (last && done(byDest(last))) return byDest(last);
    await page.waitForTimeout(1000);
  }
  throw new Error('publications did not settle: ' + JSON.stringify((last || []).map((p) => [p.destination, p.status, p.lastError])));
}

/** Fills AI Job Creation and presses Save & Post; returns the new job id. */
async function postFromForm(page, title, { tick = [] } = {}) {
  await go(page, '#/recruiter/jobs');
  await page.fill('#njTitle', title);
  await page.fill('#njLoc', 'Hyderabad, Telangana');
  await page.fill('#njExp', '0–2 yrs');
  await page.fill('#njPay', '₹2.5–3.5 LPA');
  await page.fill('#njReqs', 'Communication, MS Excel');
  await page.evaluate(() => { STATE.jobDraft.title = document.getElementById('njTitle').value; window.generateJobWithAI(); });
  await page.waitForTimeout(1800);
  await page.selectOption('#njGender', { index: 1 });
  await page.waitForSelector('#tljpDest_new[data-ready="1"]', { timeout: 15000 });
  for (const k of tick) await page.check(`#tljpDest_new input[data-dest="${k}"]`);
  const btn = page.locator('button.btn-primary[onclick*="publishGeneratedJob"]');
  must((await btn.innerText()).trim() === 'Save & Post', 'the button reads: ' + (await btn.innerText()));
  await btn.click();
  let id = null;
  for (let i = 0; i < 40 && !id; i += 1) {
    await page.waitForTimeout(500);
    id = await page.evaluate((t) => { const j = (DATA.jobs || []).find((x) => x.title === t); return j ? j.id : null; }, title);
  }
  must(id, 'the job was not created');
  return id;
}

console.log(`\nSave & Post - job publishing  (${BASE})`);
const rc = await browser.newContext({ viewport: { width: 1360, height: 900 } });
const rp = await open(rc, 'recruiter');
await signIn(rp, RECRUITER, 'recruiter', '#/recruiter/jobs');
const T1 = `Customer Support Executive ${stamp}`;
let J1 = null;

await check('1. the job form has "Post to": Portal + Website ticked, the job sites Integration Required; Save & Post', async () => {
  await go(rp, '#/recruiter/jobs');
  await rp.waitForSelector('#tljpDest_new[data-ready="1"]', { timeout: 15000 });
  const s = await rp.evaluate(() => Array.from(document.querySelectorAll('#tljpDest_new .tljp-row')).map((r) => {
    const i = r.querySelector('input'); return [i.getAttribute('data-dest'), i.checked, i.disabled, r.querySelector('.tljp-state').innerText.trim()];
  }));
  const m = Object.fromEntries(s.map((x) => [x[0], x]));
  must(m.TEAMLINK_PORTAL && m.TEAMLINK_PORTAL[1] && m.TEAMLINK_PORTAL[2], 'Portal ticked and locked: ' + JSON.stringify(m.TEAMLINK_PORTAL));
  must(m.TEAMLINK_WEBSITE && m.TEAMLINK_WEBSITE[1], 'Website ticked by default');
  for (const k of ['NAUKRI', 'SHINE', 'INDEED']) must(m[k] && !m[k][1] && /Integration Required/.test(m[k][3]), `${k}: ${JSON.stringify(m[k])}`);
  must(/administrator connects these under Administration → Integrations/.test(await text(rp, '#tljpDest_new')), 'the recruiter is told who connects them');
  await shot(rp, '01-form-post-to');
});

await check('2. Save & Post: Portal and Website Posted with real public URLs; Naukri / Shine / Indeed Integration Required, nothing sent', async () => {
  const before = calls.length;
  J1 = await postFromForm(rp, T1, { tick: ['NAUKRI', 'SHINE', 'INDEED'] });
  const p = await waitPubs(rp, J1, (b) => b.TEAMLINK_PORTAL && b.TEAMLINK_PORTAL.status === 'posted' && b.TEAMLINK_WEBSITE && b.TEAMLINK_WEBSITE.status === 'posted');
  must(p.TEAMLINK_PORTAL.externalUrl === `${BASE}job/${J1}`, 'portal URL ' + p.TEAMLINK_PORTAL.externalUrl);
  must(/\/feeds\/jobs\/.+\.json$/.test(p.TEAMLINK_WEBSITE.externalUrl), 'website URL ' + p.TEAMLINK_WEBSITE.externalUrl);
  for (const k of ['NAUKRI', 'SHINE', 'INDEED']) must(p[k] && p[k].status === 'integration_required', `${k}: ${p[k] && p[k].status}`);
  must(calls.length === before, 'a request reached the partner before it was configured');
  const page = await fetch(p.TEAMLINK_PORTAL.externalUrl, { headers: { 'accept-encoding': 'identity' } }).then(async (r) => [r.status, await r.text()]);
  must(page[0] === 200 && page[1].includes(`content="${J1}"`), 'the public job page does not answer for the job');
  must(page[1].includes('"@type":"JobPosting"'), 'no JobPosting JSON-LD');
  const entry = await fetch(p.TEAMLINK_WEBSITE.externalUrl).then((r) => r.json());
  must(entry.id === J1, 'the website feed entry');
  const feed = await fetch(`${BASE}feeds/jobs.json`).then((r) => r.json());
  must(feed.jobs.some((j) => j.id === J1), 'not in the website feed');
});

await check('3. Manage Jobs: a badge per destination, Posted ones link out; the job page has Publishing', async () => {
  await go(rp, '#/recruiter/manage-jobs');
  await rp.waitForSelector(`.tljp-badges[data-tljp-job="${J1}"]`, { timeout: 15000 });
  const b = await rp.evaluate((id) => Array.from(document.querySelectorAll(`.tljp-badges[data-tljp-job="${id}"] .tljp-chip`)).map((c) => [c.innerText.trim(), c.getAttribute('href')]), J1);
  const portal = b.find((x) => /^TeamLink Portal: Posted/.test(x[0]));
  must(portal && portal[1] === `${BASE}job/${J1}`, 'portal badge: ' + JSON.stringify(b));
  must(b.some((x) => /^TeamLink Website: Posted/.test(x[0]) && x[1]), 'website badge');
  must(b.some((x) => x[0] === 'Naukri: Integration Required' && !x[1]), 'naukri badge: ' + JSON.stringify(b));
  must(await rp.$(`[data-tljp-now="${J1}"]`), 'no Publish now button while something waits');
  await shot(rp, '02-manage-jobs-badges');
  await go(rp, `#/job/${J1}`);
  await rp.waitForSelector('#tljpJobPanel .tljp-chip', { timeout: 15000 });
  must(/TeamLink Portal: Posted/.test(await text(rp, '#tljpJobPanel')), 'job page panel');
  await shot(rp, '03-job-page-publishing');
});

await check('4. Edit and Post A Walk-in Job carry the same block; Edit shows the job\'s statuses', async () => {
  await go(rp, '#/recruiter/jobs');
  await rp.evaluate((id) => { window.startEditJob(id); }, J1);
  await rp.waitForSelector('#tljpDest_edit[data-ready="1"]', { timeout: 15000 });
  const e = await text(rp, '#tljpDest_edit');
  must(/Posted/.test(e) && /Integration Required/.test(e), 'edit block: ' + e.slice(0, 200));
  must(await rp.evaluate(() => document.querySelector('#tljpDest_edit input[data-dest="NAUKRI"]').checked), 'Naukri stays ticked on edit');
  const label = await rp.evaluate(() => document.querySelector('button.btn-primary[onclick*="saveEditJob"]').innerText.trim());
  must(label === 'Save & Post', 'edit button: ' + label);
  await rp.evaluate(() => window.cancelEditJob());
  await rp.evaluate(() => window.tnavWalkinModal());
  await rp.waitForSelector('#tljpDest_walkin[data-ready="1"]', { timeout: 15000 });
  const w = await rp.evaluate(() => document.querySelector('button.btn-primary[onclick*="tnavWalkinSubmit"]').innerText.trim());
  must(w === 'Save & Post', 'walk-in button: ' + w);
  await shot(rp, '04-walkin-post-to');
  await rp.evaluate(() => window.fcrCloseModal && window.fcrCloseModal());
});

await check('5. a recruiter cannot open Integrations', async () => {
  must(!/Integrations/.test(await text(rp, '.sidebar')), 'Integrations in the recruiter sidebar');
  const st = await rp.evaluate(() => TL.api.get('/admin/integrations').then(() => 200, (e) => e.status));
  must(st === 403, 'API answered ' + st);
  await go(rp, '#/admin/integrations');
  must(!(await rp.$('#tljpAdmHost')), 'the Integrations screen rendered for a recruiter');
});

const ac = await browser.newContext({ viewport: { width: 1360, height: 900 } });
const ap = await open(ac, 'admin');
await signIn(ap, ADMIN, 'admin', '#/admin/integrations');

async function fillNaukri(key) {
  await ap.waitForSelector('#tljpCard_NAUKRI', { timeout: 15000 });
  await ap.check('#tljpOn_NAUKRI');
  await ap.selectOption('#tljpC_NAUKRI', 'api');
  await ap.evaluate(() => window.tljpConnChanged('NAUKRI'));
  await ap.fill('#tljpE_NAUKRI', `http://127.0.0.1:${MOCK_PORT}/naukri`);
  await ap.selectOption('#tljpA_NAUKRI', 'bearer');
  await ap.fill('#tljpAcc_NAUKRI', 'TL-EMP-VERIFY');
  await ap.fill('#tljpS_NAUKRI_apiKey', key);
  await ap.click('#tljpCard_NAUKRI button:has-text("Save")');
  await ap.waitForFunction(() => /Saved\./.test((document.querySelector('#tljpCard_NAUKRI .tljp-result') || {}).textContent || ''), null, { timeout: 15000 });
}
async function testNaukri() {
  await ap.click('#tljpCard_NAUKRI button:has-text("Test Connection")');
  await ap.waitForFunction(() => /Test Connection (passed|failed)/.test((document.querySelector('#tljpCard_NAUKRI .tljp-result') || {}).textContent || ''), null, { timeout: 20000 });
  return text(ap, '#tljpCard_NAUKRI .tljp-result');
}

await check('6. admin: Integrations lists the platforms; a wrong key fails Test Connection; the right one passes; only "•••• saved"', async () => {
  must(/Integrations/.test(await text(ap, '.sidebar')), 'no Integrations entry in the admin sidebar');
  const t = await text(ap, '#tljpAdmHost');
  for (const n of ['TeamLink Job Portal', 'TeamLink Website', 'Naukri', 'Shine', 'Indeed']) must(t.includes(n), 'missing ' + n);
  must(/Works now/.test(t) && /Integration Required/.test(t), 'states');
  await fillNaukri(WRONG);
  const bad = await testNaukri();
  must(/Test Connection failed: The platform rejected the credentials/.test(bad), 'wrong key: ' + bad);
  await fillNaukri(SECRET);
  const good = await testNaukri();
  must(/Test Connection passed/.test(good), 'right key: ' + good);
  const ph = await ap.getAttribute('#tljpS_NAUKRI_apiKey', 'placeholder');
  must(ph.startsWith('•••• saved (…' + SECRET.slice(-4) + ')'), 'placeholder: ' + ph);
  must(!(await pageHasSecret(ap)), 'the secret is on the page');
  await shot(ap, '05-integrations-naukri');
});

await check('7. Publish waiting jobs now: the Naukri badge shows Posted with the platform\'s external URL', async () => {
  await ap.click('#tljpCard_NAUKRI button:has-text("Publish waiting jobs now")');
  await ap.waitForFunction(() => /waiting job\(s\) sent/.test((document.querySelector('#tljpCard_NAUKRI .tljp-result') || {}).textContent || ''), null, { timeout: 30000 });
  const p = await waitPubs(rp, J1, (b) => b.NAUKRI && b.NAUKRI.status === 'posted');
  must(/^https:\/\/naukri\.partner\.test\/job-listings-/.test(p.NAUKRI.externalUrl), 'external URL ' + p.NAUKRI.externalUrl);
  must(/^NK-V-\d+$/.test(p.NAUKRI.externalJobId), 'external id ' + p.NAUKRI.externalJobId);
  const posted = calls.filter((c) => c.method === 'POST' && c.path === '/naukri/jobs' && c.auth === `Bearer ${SECRET}` && c.body.includes(J1));
  must(posted.length === 1, `posted ${posted.length} times`);
  await rp.evaluate(() => window.TLJobPublishing.refresh());
  await go(rp, '#/recruiter/manage-jobs');
  await rp.waitForFunction((id) => /Naukri: Posted/.test((document.querySelector(`.tljp-badges[data-tljp-job="${id}"]`) || {}).innerText || ''), J1, { timeout: 15000 });
  const href = await rp.evaluate((id) => {
    const a = Array.from(document.querySelectorAll(`.tljp-badges[data-tljp-job="${id}"] a.tljp-chip`)).find((x) => /^Naukri/.test(x.innerText));
    return a && a.getAttribute('href');
  }, J1);
  must(href === p.NAUKRI.externalUrl, 'badge link ' + href);
  await shot(rp, '06-manage-jobs-naukri-posted');
});

await check('8. 390 px: the Post to block and Integrations fit with no sideways scroll', async () => {
  const mc = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const mp = await open(mc, 'recruiter-390');
  await signIn(mp, RECRUITER, 'recruiter', '#/recruiter/jobs');
  await mp.waitForSelector('#tljpDest_new[data-ready="1"]', { timeout: 15000 });
  await mp.evaluate(() => document.getElementById('tljpDest_new').scrollIntoView());
  const over = await mp.evaluate(() => {
    const b = document.getElementById('tljpDest_new').getBoundingClientRect();
    return { page: document.documentElement.scrollWidth - window.innerWidth, right: b.right - window.innerWidth };
  });
  must(over.page <= 1 && over.right <= 1, 'overflow ' + JSON.stringify(over));
  await shot(mp, '07-form-390');
  /* a job posted from the phone-width form */
  const J2 = await postFromForm(mp, `Back Office Associate ${stamp}`);
  const p = await waitPubs(mp, J2, (b) => b.TEAMLINK_PORTAL && b.TEAMLINK_PORTAL.status === 'posted' && b.TEAMLINK_WEBSITE && b.TEAMLINK_WEBSITE.status === 'posted');
  must(!p.NAUKRI, 'Naukri was not ticked, so nothing for it');
  await mc.close();
  const ac2 = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const ap2 = await open(ac2, 'admin-390');
  await signIn(ap2, ADMIN, 'admin', '#/admin/integrations');
  await ap2.waitForSelector('#tljpCard_NAUKRI', { timeout: 15000 });
  const o2 = await ap2.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  must(o2 <= 1, 'integrations overflow ' + o2);
  must(!(await pageHasSecret(ap2)), 'secret on the 390 page');
  await shot(ap2, '08-integrations-390');
  await ac2.close();
});

await check('9. the secret never appeared in any response or page', async () => {
  must(!leaks.length, 'in: ' + leaks.slice(0, 3).join(', '));
  must(!(await pageHasSecret(ap)) && !(await pageHasSecret(rp)), 'on a page');
});

await check('10. no page errors', async () => {
  const mine = errors.filter((e) => !/ResizeObserver|Failed to fetch|NetworkError/.test(e));
  must(!mine.length, mine.slice(0, 3).join(' / '));
});

await browser.close();
await new Promise((r) => mock.close(r));
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
console.log(`screenshots: ${SHOTS}`);
process.exit(failed ? 1 : 0);
