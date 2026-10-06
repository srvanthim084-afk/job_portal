/**
 * 0115, in a real browser: Apply Now on an external job that its source has
 * taken down says "Job no longer available" - it does not leave the
 * candidate on the employer's 404.
 *
 *   L1  (desktop) External Jobs page, Apply on the reported Databricks job
 *       (Greenhouse id databricks:8015848002, which the provider stand-in
 *       answers 404 for): the message is shown on the card, no tab is left
 *       open, the employer page is never requested, and the job is closed
 *   L2  (desktop) Apply on a live job: the stored original URL opens
 *   L3  (390 px) the same two, on a phone-sized screen
 *   L4  signed out: still no External Jobs link and no external job on the
 *       public board; a live job's own page opens its URL; a closed one
 *       says "This job is no longer available" with no Apply Now
 *
 * The instance MUST route its link checks to a local stand-in
 * (EXTERNAL_LINK_CHECK_VIA=http://127.0.0.1:<LINK_MOCK>) - this refuses to
 * run otherwise - and every employer page is answered by Playwright's
 * ctx.route. Nothing reaches Greenhouse or Databricks. Isolated instance
 * only (refuses :4323). Everything this creates is removed at the end.
 *
 *   TL_URL=http://127.0.0.1:4434/ LINK_MOCK=9848 node tools/verify-external-link-health.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = (process.env.TL_URL || 'http://127.0.0.1:4434/').replace(/\/?$/, '/');
const LINK_MOCK = `http://127.0.0.1:${Number(process.env.LINK_MOCK || 9848)}`;
const SHOTS = process.env.SHOTS || 'var/verify-shots/external-link-health';
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
const num = String(Date.now()).slice(-7);

const mockHits = () => fetch(`${LINK_MOCK}/__hits`).then((r) => r.json());
const removeAtSource = (id) => fetch(`${LINK_MOCK}/__remove?id=${id}`, { method: 'POST' });

const JOBS = {
  dead: { ext: 'databricks:8015848002', title: `AI Engineer - FDE (Forward Deployed Engineer) ${stamp}`,
    url: 'https://www.databricks.com/company/careers/professional-services-operations/ai-engineer-fde-forward-deployed-engineer-8015848002?gh_jid=8015848002' },
  live: { ext: `databricks:91${num}`, title: `Verify Live Data Engineer ${stamp}`,
    url: `https://www.databricks.com/company/careers/open-positions/job?gh_jid=91${num}` },
  dead390: { ext: `databricks:82${num}`, title: `Verify Mobile AI Engineer ${stamp}`,
    url: `https://www.databricks.com/company/careers/open-positions/job?gh_jid=82${num}` },
  live390: { ext: `databricks:93${num}`, title: `Verify Mobile Live Engineer ${stamp}`,
    url: `https://www.databricks.com/company/careers/open-positions/job?gh_jid=93${num}` },
};

const browser = await chromium.launch();
const errors = [];
const STANDIN = '<!doctype html><title>employer page (local stand-in)</title><h1>Original job page</h1>';
async function context(seen, viewport = { width: 1320, height: 950 }) {
  const ctx = await browser.newContext({ viewport, ...(viewport.width < 500 ? { isMobile: true, hasTouch: true } : {}) });
  await ctx.route(/^https:\/\/([a-z0-9-]+\.)*(databricks\.com|greenhouse\.io)\//, (route) => {
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

/* ---- setup ---------------------------------------------------------------- */
const seenAdmin = [];
const actx = await context(seenAdmin);
const admin = await newPage(actx, 'admin');
let r = await api(admin, 'post', '/auth/login', { email: 'admin@teamlink.com', password: process.env.TL_ADMIN_PASSWORD || 'TeamLink@2026', role: 'admin' });
must(r.ok, 'admin login: ' + r.message);
const SRC = `vgh_${stamp}`;
const X = {};

console.log(`\nexternal link health  (${BASE})\n`);

await check('setup: a Greenhouse source with the reported job and live ones; the instance checks links through the local stand-in', async () => {
  r = await api(admin, 'post', '/external/sources', { id: SRC, name: `Verify Greenhouse ${stamp}`, sourceType: 'company_site',
    collectionMethod: 'manual', connector: 'greenhouse', applicationMethod: 'redirect', active: true });
  must(r.ok, 'source: ' + r.message);
  r = await api(admin, 'post', '/external/jobs', { sourceId: SRC, jobs: Object.values(JOBS).map((j) => ({ id: j.ext, title: j.title,
    company: 'databricks', location: 'Bengaluru, India', skills: ['Python', 'Spark'], url: j.url,
    description: 'Work with customers on AI systems. (verification posting)', postedAt: new Date().toISOString() })) });
  must(r.ok && r.v.saved === 4, 'jobs: ' + (r.message || JSON.stringify(r.v)));
  for (const [k, j] of Object.entries(JOBS)) X[k] = r.v.jobs.find((x) => x.externalJobId === j.ext || x.title === j.title) || null;
  must(Object.values(X).every(Boolean), 'ids: ' + JSON.stringify(r.v.jobs.map((x) => Object.keys(x)).slice(0, 1)));
  await removeAtSource(JOBS.dead390.ext.split(':')[1]);
  /* The instance must be asking the stand-in, not the internet. */
  const n = (await mockHits()).length;
  const a = await api(admin, 'get', `/portal/external-jobs/${X.live.id}/availability`);
  must(a.ok && a.v.available === true && a.v.checked === 'confirmed', 'live availability: ' + JSON.stringify(a.v || a));
  must((await mockHits()).length === n + 1, 'the instance did not ask the local stand-in - is EXTERNAL_LINK_CHECK_VIA set?');
});

/* ---- a candidate --------------------------------------------------------- */
async function candidate(name, viewport) {
  const seen = [];
  const ctx = await context(seen, viewport);
  const page = await newPage(ctx, name);
  const reg = await api(page, 'post', '/auth/register', { name: `Verify Link ${name}`, email: `x.link.${name}.${stamp}@tl-sink.local`,
    password: `Verify${stamp}Z9`, phone: '9' + String(Date.now()).slice(-9), preferredLocation: 'Bengaluru', expectedCtc: 5,
    noticePeriod: 'Immediate', preferredWorkModes: ['Hybrid'] });
  must(reg.ok, 'register: ' + reg.message);
  return { ctx, page, seen };
}
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
const statusOf = async (id) => (await api(admin, 'get', `/portal/external-jobs/${id}`)).v.job.status;

async function removedFlow(c, job, tag) {
  const card = await externalCard(c.page, job.title);
  must(await statusOf(X[tag].id) === 'ACTIVE', 'listed as active before the click, as on live');
  const before = c.seen.length;
  const opened = [];
  c.ctx.on('page', (p) => opened.push(p));
  await card.locator('button', { hasText: /^Apply/ }).first().click();
  await c.page.waitForFunction(() => /Job no longer available/.test(document.body.innerText), null, { timeout: 10000 });
  await c.page.waitForTimeout(800);
  const still = opened.filter((p) => !p.isClosed());
  must(still.length === 0, `a tab was left open: ${still.map((p) => p.url()).join(', ')}`);
  must(c.seen.length === before, 'the employer page was requested: ' + c.seen.slice(before).join(', '));
  must(await card.locator('[data-unavailable]', { hasText: 'Job no longer available' }).count() === 1, 'the card does not say so');
  must(await card.locator('button', { hasText: /^Apply/ }).count() === 0, 'an Apply button is still offered on the card');
  must(await statusOf(X[tag].id) === 'CLOSED', 'the job was not marked closed');
  const listed = await api(admin, 'get', `/portal/external-jobs?source=${SRC}&limit=50`);
  must(!listed.v.jobs.some((j) => j.id === X[tag].id), 'the closed job is still listed');
  await c.page.screenshot({ path: `${SHOTS}/${tag}-removed.png` });
  /* Its own page: the existing "no longer available" state, no Apply Now. */
  await open(c.page, '#/job/' + X[tag].id);
  await c.page.waitForFunction(() => /This job is no longer available/.test(document.body.innerText), null, { timeout: 15000 });
  must(await c.page.locator('button', { hasText: 'Apply Now' }).count() === 0, 'Apply Now on the closed job\'s page');
}
async function liveFlow(c, job, tag) {
  const card = await externalCard(c.page, job.title);
  const [popup] = await Promise.all([c.ctx.waitForEvent('page', { timeout: 10000 }), card.locator('button', { hasText: /^Apply/ }).first().click()]);
  await popup.waitForURL(job.url, { timeout: 10000 }).catch(() => {});
  must(popup.url() === job.url, 'opened ' + popup.url());
  must(await popup.evaluate(() => window.opener === null), 'the new tab can reach TeamLink (no opener)');
  must(/Original job page/.test(await popup.locator('h1').innerText()), 'the stand-in page');
  await popup.close();
  const rows = (await api(c.page, 'get', '/external/applications')).v.applications || [];
  const row = rows.find((x) => x.externalJobId === X[tag].id);
  must(row && row.statusLabel === 'Apply Clicked', '"Apply Clicked" not recorded: ' + JSON.stringify(row && row.status));
  await c.page.screenshot({ path: `${SHOTS}/${tag}-live.png` });
}

const desk = await candidate('desk');
await check('L1  desktop: Apply on the removed Databricks job -> "Job no longer available", no tab left open, the job is closed', async () => {
  await removedFlow(desk, JOBS.dead, 'dead');
  const hits = await mockHits();
  must(hits.some((h) => h === 'GET /https/boards-api.greenhouse.io/v1/boards/databricks/jobs/8015848002'), 'the Greenhouse job endpoint was not asked');
});
await check('L2  desktop: Apply on a live job opens the stored original URL, "Apply Clicked"', async () => {
  await liveFlow(desk, JOBS.live, 'live');
});

const phone = await candidate('phone', { width: 390, height: 844 });
await check('L3  390 px: removed -> the message on the card, no tab; live -> the original URL', async () => {
  await removedFlow(phone, JOBS.dead390, 'dead390');
  const w = await phone.page.evaluate(() => document.documentElement.scrollWidth);
  must(w <= 392, `the page scrolls sideways at 390 px (${w})`);
  await liveFlow(phone, JOBS.live390, 'live390');
});

await check('L4  signed out: no External Jobs link, none on the public board; a live job page opens its URL; a closed one says so', async () => {
  const seen = [];
  const pctx = await context(seen);
  const pub = await newPage(pctx, 'public');
  await open(pub, '#/jobs');
  const txt = await pub.locator('body').innerText();
  must(!/External Jobs/.test(await pub.locator('header, nav').first().innerText().catch(() => '')), 'an External Jobs link signed out');
  must(!txt.includes(JOBS.live.title), 'the public board lists an external job');
  must(!(await pub.locator('[data-external]').count()), 'an external row on the public board');

  await open(pub, '#/job/' + X.live.id);
  await pub.waitForSelector('#tlpxTitle', { timeout: 15000 });
  const reqs = [];
  pub.on('request', (q) => reqs.push(q.url()));
  const [popup] = await Promise.all([pctx.waitForEvent('page', { timeout: 10000 }), pub.locator('article button', { hasText: 'Apply Now' }).first().click()]);
  await popup.waitForURL(JOBS.live.url, { timeout: 10000 }).catch(() => {});
  must(popup.url() === JOBS.live.url, 'opened ' + popup.url());
  await pub.waitForTimeout(600);
  must(reqs.some((x) => /\/api\/portal\/external-jobs\/[^/]+\/click$/.test(x)), 'the click was not counted');
  await popup.close();

  await open(pub, '#/job/' + X.dead.id);
  await pub.waitForFunction(() => /This job is no longer available/.test(document.body.innerText), null, { timeout: 15000 });
  must(await pub.locator('button', { hasText: 'Apply Now' }).count() === 0, 'Apply Now on a closed job');
  must(!seen.some((x) => x.includes('8015848002')), 'the dead page was requested signed out');
  await pub.screenshot({ path: `${SHOTS}/L4-public-closed.png` });
  await pctx.close();
  delete pages.public;
});

await check('the dead employer page was never requested by anybody', async () => {
  for (const s of [seenAdmin, desk.seen, phone.seen]) must(!s.some((x) => /8015848002|gh_jid=82/.test(x)), 'requested: ' + s.join(', '));
});

await check('clean up: the verification source and its jobs are removed', async () => {
  r = await api(admin, 'del', `/external/sources/${SRC}`);
  must(r.ok, `delete ${SRC}: ${r.message}`);
});
await check('no page errors', async () => { must(errors.length === 0, errors.slice(0, 3).join(' | ')); });

await browser.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
