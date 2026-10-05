/**
 * Job source separation, through the real UI (owner, 2026-10-05; 0113).
 *
 *   JOBS PAGE          = TEAMLINK jobs only
 *   EXTERNAL JOBS PAGE = EXTERNAL jobs only
 *
 * The owner's acceptance tests 1-18, in a browser, desktop (1320 px) and
 * phone (390 px). Fixtures, all made here and removed at the end:
 *
 *   TeamLink (posted by the recruiter through the API the job form uses)
 *     A        "Python Engineer"  Hyderabad, Fresher, Python + Java + Spring
 *     WFH      Remote             Python
 *     URGENT   Hyderabad          Python, urgent hiring on
 *     WALKIN   Hyderabad walk-in  Python
 *   External (a Naukri partner feed, licensed in this run only, entered by hand)
 *     B        "Python Developer" Hyderabad, Fresher, Python + Django - the
 *              better match for the candidate (Python, Django)
 *     B-WFH / B-WALKIN / B-URGENT   the same filters' external twins
 *
 * Every Jobs-page state checked: no card is external (by id, by
 * data-external, by any external fixture's title), and every card is a
 * TeamLink job. No real site is contacted: employer pages are answered by
 * ctx.route. Isolated instance only - refuses :4323.
 *
 *   TL_URL=http://127.0.0.1:4428/ node tools/verify-job-source-separation.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = (process.env.TL_URL || 'http://127.0.0.1:4428/').replace(/\/?$/, '/');
const SHOTS = process.env.SHOTS || 'var/verify-shots/job-source-separation';
const u = new URL(BASE);
if (!['127.0.0.1', 'localhost'].includes(u.hostname) || u.port === '4323') {
  console.error(`Refusing to run against ${BASE}: this creates jobs and sources. Use an isolated instance.`);
  process.exit(2);
}
mkdirSync(SHOTS, { recursive: true });
const PW = process.env.DEV_PASSWORD || 'TeamLink@2026';

let passed = 0, failed = 0;
const pages = {};
const check = async (name, fn) => {
  try { const note = await fn(); passed += 1; console.log(`  PASS  ${name}${note ? `\n        ${note}` : ''}`); }
  catch (e) {
    failed += 1; console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n')[0]}`);
    for (const [k, pg] of Object.entries(pages)) await pg.screenshot({ path: `${SHOTS}/fail-${failed}-${k}.png` }).catch(() => {});
  }
};
const must = (c, m) => { if (!c) throw new Error(m); };
const stamp = Date.now().toString(36);
const isExt = (id) => /^xjob_/.test(String(id || ''));

/* A speech recogniser that "hears" window.__say (as verify-voice-search does). */
const STUB = () => {
  class FakeRecognition {
    constructor() { this.lang = 'en-IN'; this.continuous = false; this.interimResults = false; this._t = []; }
    start() {
      const say = String(window.__say || '');
      const res = (text, isFinal) => { const r = [{ transcript: text, confidence: 0.9 }]; r.isFinal = isFinal; return { resultIndex: 0, results: [r] }; };
      this._t.push(setTimeout(() => this.onresult && this.onresult(res(say, true)), 200));
    }
    stop() { this._t.forEach(clearTimeout); setTimeout(() => this.onend && this.onend(), 20); }
    abort() { this._t.forEach(clearTimeout); }
  }
  window.SpeechRecognition = FakeRecognition;
  window.webkitSpeechRecognition = FakeRecognition;
};

const browser = await chromium.launch();
const errors = [];
async function context(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1320, height: 950 }, ...opts });
  await ctx.addInitScript(STUB);
  await ctx.route(/^https:\/\/([a-z0-9-]+\.)*naukri\.com\//, (route) => route.fulfill({ status: 200, contentType: 'text/html',
    body: '<!doctype html><title>employer page (local stand-in)</title><h1>Original job page</h1>' }));
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
async function open(page, hash, wait = 1500) {
  await page.goto(BASE + '?v=' + Date.now() + hash);
  await page.waitForFunction(() => window.TL && TL.ready === true, null, { timeout: 30000 });
  await page.waitForTimeout(wait);
  await page.evaluate(() => { const b = document.querySelector('.tlpo-ov .tlpo-btn.ghost'); if (b) b.click(); });
}
const api = (page, m, p, b) => page.evaluate(([mm, pp, bb]) => TL.api[mm](pp, bb)
  .then((v) => ({ ok: 1, v }), (e) => ({ ok: 0, code: e.code, message: e.message })), [m, p, b]);

/* ---- setup ---------------------------------------------------------------- */
const T = {}, X = {}, EXT_TITLES = [];
const actx = await context();
const admin = await newPage(actx, 'admin');
let r = await api(admin, 'post', '/auth/login', { email: 'admin@teamlink.com', password: PW, role: 'admin' });
must(r.ok, 'admin login: ' + r.message);
const rctx = await context();
const rec = await newPage(rctx, 'recruiter');
r = await api(rec, 'post', '/auth/login', { email: process.env.TL_RECRUITER || 'recruiter@teamlink.com', password: PW, role: 'recruiter' });
must(r.ok, 'recruiter login: ' + r.message);
const recCo = await rec.evaluate(async () => {
  const boot = await TL.api.get('/bootstrap');
  const me = (boot.data.recruiters || []).find((x) => boot.session && x.id === boot.session.id) || {};
  return me.companyId || ((boot.data.companies || [])[0] || {}).id;
});
const SRC = `vsep_${stamp}`;
const dayAhead = (n) => new Date(Date.now() + 5.5 * 3600e3 + n * 86400e3).toISOString().slice(0, 10);
const postTL = async (key, body) => {
  const out = await api(rec, 'post', '/jobs', { companyId: recCo, status: 'open', type: 'Full-time', pay: '₹3-5 LPA', salaryMin: 3, salaryMax: 5,
    desc: 'Verification job (job source separation) - safe to delete.', ...body });
  must(out.ok, `${key}: ${out.message}`);
  T[key] = out.v.job;
  return out.v.job;
};
const importExt = async (key, title, extra = {}) => {
  const out = await api(admin, 'post', '/external/jobs', { sourceId: SRC, jobs: [{ id: `VSEP-${key}-${stamp}`, title, company: 'Verify Naukri Employer',
    location: 'Hyderabad', skills: ['Python', 'Django'], experience: 'Fresher', employmentType: 'Full-time',
    url: `https://www.naukri.com/job-listings-vsep-${key.toLowerCase()}-${stamp}`, postedAt: new Date().toISOString(),
    description: `${title}: Python and Django. Immediate joining. Urgent hiring.`, ...extra }] });
  must(out.ok && out.v.saved === 1, `${key}: ${out.message || JSON.stringify(out.v)}`);
  X[key] = out.v.jobs[0];
  EXT_TITLES.push(title);
  return out.v.jobs[0];
};

console.log(`\njob source separation  (${BASE})\n`);

await check('setup: TeamLink A / WFH / URGENT / WALKIN by the recruiter; External B / B-WFH / B-WALKIN / B-URGENT from a licensed Naukri feed', async () => {
  await postTL('A', { title: `Python Engineer TA${stamp}`, location: 'Hyderabad', mode: 'Hybrid', exp: 'Fresher', skills: ['Python', 'Java', 'Spring'] });
  await postTL('WFH', { title: `Python Support TW${stamp}`, location: 'Remote', mode: 'Remote', exp: '1-3 yrs', skills: ['Python'] });
  await postTL('URGENT', { title: `Python Data Engineer TU${stamp}`, location: 'Hyderabad', mode: 'Onsite', exp: '2-4 yrs', skills: ['Python', 'SQL'] });
  r = await api(rec, 'put', `/jobs/${T.URGENT.id}/deadline`, { urgent: true });
  must(r.ok, 'urgent: ' + r.message);
  await postTL('WALKIN', { title: `Python Walk-in TK${stamp}`, location: 'Hyderabad', mode: 'Onsite', exp: 'Fresher', skills: ['Python'],
    postingKind: 'walkin', type: 'Walk-in', walkinDate: dayAhead(3), walkinFrom: '10:00', walkinTo: '17:00', walkinVenue: 'TeamLink office',
    walkinAddress: 'Hitech City, Hyderabad', walkinContact: 'Verify Desk', walkinPhone: '9876543210' });
  for (const j of Object.values(T)) must(j.sourceType === 'TEAMLINK', `${j.title}: sourceType ${j.sourceType}`);

  const src = { id: SRC, name: `Naukri partner feed ${stamp}`, sourceType: 'partner_api', collectionMethod: 'manual', connector: 'naukri', applicationMethod: 'redirect' };
  r = await api(admin, 'post', '/external/sources', { ...src, active: false });
  must(r.ok, 'source: ' + r.message);
  r = await api(admin, 'put', `/external/sources/${SRC}/licence`, { collectionMethod: 'partner_feed', licenceStatus: 'active', consentStatus: 'granted',
    termsUrl: 'https://partner.example.org/naukri/terms', dataUsageAllowed: true, applicationRedirectAllowed: true,
    owner: 'verify-job-source-separation', notes: 'verification only - test licence' });
  must(r.ok, 'licence: ' + r.message);
  r = await api(admin, 'post', '/external/sources', { ...src, active: true });
  must(r.ok, 'activate: ' + r.message);
  await importExt('B', `Python Developer XB${stamp}`);
  await importExt('BWFH', `Python Developer Remote XW${stamp}`, { location: 'Remote', description: 'Python. Work from home.' });
  await importExt('BWALK', `Python Walk-in XK${stamp}`, { employmentType: 'Walk-in' });
  await importExt('BURGENT', `Urgent Python Hiring XU${stamp}`);
  return `TeamLink ${Object.keys(T).length}, external ${Object.keys(X).length}`;
});

/* The set of TeamLink jobs, from the ATS (staff see every row and its classification). */
async function teamlinkIds() {
  const all = await api(admin, 'get', '/jobs?view=all&limit=200');
  return new Set(all.v.jobs.filter((j) => j.sourceType === 'TEAMLINK').map((j) => j.id));
}

/** What a Jobs-page screen is showing: card ids, external markers, text. */
const screen = (page) => page.evaluate(() => {
  /* the list's cards: the Jobs page's own, its location bands' (cp-card), the public board's rows */
  const cards = [...document.querySelectorAll('.rj-card, .job-list .job-row, .cp-card')].filter((c) => /\/job\/[A-Za-z0-9_-]+/.test(c.innerHTML));
  const ids = cards.map((c) => { const m = /\/job\/([A-Za-z0-9_-]+)/.exec(c.innerHTML); return m ? m[1] : null; });
  const cnt = /(\d+) jobs? recommended for you/.exec((document.querySelector('.rj-count') || {}).textContent || '');
  return { ids, ext: document.querySelectorAll('[data-external]').length, text: document.body.innerText,
    count: cnt ? Number(cnt[1]) : null, xmock: !!document.querySelector('.xj-wrap') };
});
async function jobsPageOnly(page, what, { has = [], tl = null } = {}) {
  const s = await screen(page);
  const set = tl || await teamlinkIds();
  must(!s.ext, `${what}: ${s.ext} external card(s) on the Jobs page`);
  must(!s.xmock, `${what}: the simulated external block is drawn`);
  for (const id of s.ids) {
    must(id && !isExt(id), `${what}: an external id on the Jobs page (${id})`);
    must(set.has(id), `${what}: a card that is not a TeamLink job (${id})`);
  }
  for (const t of EXT_TITLES) must(!s.text.includes(t), `${what}: external job "${t}" is on the Jobs page`);
  for (const k of has) must(s.ids.includes(T[k].id), `${what}: TeamLink ${k} is missing (${s.ids.length} cards)`);
  return s;
}
const clearSearch = (page) => page.evaluate(() => {
  STATE.rj = STATE.rj || {};
  if (typeof window.rjClear === 'function') window.rjClear();
  STATE.rj.q = ''; STATE.rj.loc = '';
  if (typeof window.rjLocClear === 'function') window.rjLocClear();
  document.querySelectorAll('.tlpu-chip.on').forEach((b) => b.click());
  if (typeof render === 'function') render();
});

/* ---- the candidate -------------------------------------------------------- */
const cctx = await context();
const cand = await newPage(cctx, 'cand');
const candEmail = `vsep.${stamp}@tl-sink.local`;
r = await api(cand, 'post', '/auth/register', { name: 'Verify Separation Cand', email: candEmail, password: `Vsep${stamp}Z9`,
  phone: '9' + String(Date.now()).slice(-9), preferredLocation: 'Hyderabad', expectedCtc: 5, noticePeriod: 'Immediate', preferredWorkModes: ['Hybrid'] });
must(r.ok, 'register: ' + r.message);
const CAND = r.v.candidateId;
r = await api(cand, 'put', `/candidates/${CAND}`, { skills: ['Python', 'Django'], location: 'Hyderabad', preferredLocation: 'Hyderabad' });
must(r.ok, 'profile: ' + r.message);
let TL0 = await teamlinkIds();

async function jobsSuite(page, vp) {
  await check(`[${vp}] 1. Jobs: TeamLink Job A visible, External Job B not (candidate Jobs page, public board, candidate Home)`, async () => {
    await open(page, '#/candidate/search');
    await clearSearch(page);
    const s = await jobsPageOnly(page, 'candidate Jobs', { has: ['A', 'WFH', 'URGENT', 'WALKIN'], tl: TL0 });
    await page.screenshot({ path: `${SHOTS}/${vp}-01-jobs.png` });
    await open(page, '#/candidate');
    for (const t of EXT_TITLES) must(!(await page.locator('body').innerText()).includes(t), 'candidate Home shows ' + t);
    return `${s.ids.length} cards, all TeamLink; 0 external`;
  });

  await check(`[${vp}] 3 + 4. Search "Python", then "Python" + Hyderabad: only TeamLink jobs`, async () => {
    await open(page, '#/candidate/search');
    await clearSearch(page);
    await page.fill('#rjQ', 'Python');
    await page.locator('.rj-search .go, .rj-search button', { hasText: 'Search' }).first().click();
    await page.waitForTimeout(1200);
    const a = await jobsPageOnly(page, 'q=Python', { has: ['A', 'WFH', 'URGENT'], tl: TL0 });
    await page.evaluate(() => window.rjLocToggle('Hyderabad'));
    await page.waitForTimeout(1200);
    const b = await jobsPageOnly(page, 'q=Python + Hyderabad', { has: ['A', 'URGENT'], tl: TL0 });
    /* (A Remote job stays in its own "Remote / work from home" band below a
       place - the page's existing rule; it is a TeamLink job either way.) */
    await page.screenshot({ path: `${SHOTS}/${vp}-03-search.png` });
    return `"Python": ${a.ids.length} TeamLink; "Python" + Hyderabad: ${b.ids.length} TeamLink; external B (Python, Hyderabad) in neither`;
  });

  await check(`[${vp}] 6-9. Chips Fresher, Work from home, Urgent hiring, Walk-in (and every other chip): only TeamLink jobs`, async () => {
    await open(page, '#/candidate/search');
    await clearSearch(page);
    const want = { fresher: 'A', wfh: 'WFH', urgent: 'URGENT', walkin: 'WALKIN' };
    const seen = [];
    const keys = await page.$$eval('.tlpu-chips .tlpu-chip', (b) => b.map((x) => x.getAttribute('data-k')));
    must(keys.length >= 8, 'chips: ' + keys.join(','));
    for (const k of keys) {
      if (k === 'near_me') continue;                 // asks for a place; checked through the API test
      await page.click(`.tlpu-chip[data-k="${k}"]`);
      await page.waitForTimeout(1300);
      const s = await jobsPageOnly(page, `chip ${k}`, { has: want[k] ? [want[k]] : [], tl: TL0 });
      seen.push(`${k} ${s.ids.length}`);
      if (k === 'fresher' && vp === 'desktop') await page.screenshot({ path: `${SHOTS}/${vp}-06-fresher.png` });
      await page.click(`.tlpu-chip[data-k="${k}"]`);
      await page.waitForTimeout(500);
    }
    return seen.join(' · ');
  });

  await check(`[${vp}] 11. Voice "Python jobs in Hyderabad": only TeamLink jobs`, async () => {
    await open(page, '#/candidate/search');
    await clearSearch(page);
    await page.evaluate(() => { window.__say = 'Python jobs in Hyderabad'; });
    await page.click('.rj-search .tlvs-mic');
    await page.waitForSelector('#tlvsGo', { timeout: 15000 });
    await page.click('#tlvsGo');
    await page.waitForTimeout(1500);
    const s = await jobsPageOnly(page, 'voice', { has: ['A'], tl: TL0 });
    if (vp === 'phone') await page.screenshot({ path: `${SHOTS}/${vp}-11-voice.png` });
    return `${s.ids.length} TeamLink results`;
  });

  await check(`[${vp}] 14. "N jobs recommended for you" counts TeamLink jobs only`, async () => {
    await open(page, '#/candidate/search');
    await clearSearch(page);
    await page.waitForTimeout(800);
    const s = await jobsPageOnly(page, 'count', { tl: TL0 });
    must(s.count === s.ids.length, `count ${s.count} vs ${s.ids.length} cards`);
    must(s.count <= TL0.size, `count ${s.count} > TeamLink jobs ${TL0.size}`);
    return `${s.count} recommended = ${s.ids.length} TeamLink cards`;
  });
}

await jobsSuite(cand, 'desktop');

await check('1 (signed out). The public board lists TeamLink jobs only', async () => {
  const pctx = await context();
  const pub = await newPage(pctx, 'public');
  await open(pub, '#/jobs');
  await pub.evaluate(() => { STATE.search = STATE.search || {}; STATE.search.q = 'Python'; render(); });
  await pub.waitForTimeout(1200);
  const s = await jobsPageOnly(pub, 'public board', { has: ['A'], tl: TL0 });
  const counted = /(\d+)<\/b> jobs? found/.exec(await pub.content());
  must(!/from other job sites/.test(s.text), 'the count still adds external jobs');
  await pub.screenshot({ path: `${SHOTS}/desktop-01-public.png` });
  await pctx.close(); delete pages.public;
  return `${s.ids.length} rows, "${counted ? counted[1] : '?'} jobs found", no external`;
});

await check('2. External Jobs: B visible, A not', async () => {
  r = await api(cand, 'post', '/external/match', {});
  must(r.ok, 'match: ' + r.message);
  await open(cand, '#/candidate/external-jobs', 2500);
  await cand.evaluate((q) => window.xjFilter('skill', q), stamp);
  await cand.waitForSelector('.xj-card', { timeout: 20000 });
  await cand.waitForTimeout(800);
  const s = await cand.evaluate(() => ({ html: [...document.querySelectorAll('.xj-card')].map((c) => c.innerHTML).join('\n'), text: document.body.innerText }));
  must(s.text.includes(X.B.title), 'B is not on External Jobs');
  for (const j of Object.values(T)) must(!s.text.includes(j.title), `TeamLink ${j.title} is on External Jobs`);
  const ids = s.html.match(/xjob_[a-z0-9]+/g) || [];
  for (const id of s.html.match(/\/job\/([A-Za-z0-9_-]+)/g) || []) must(isExt(id.slice(5)), 'a TeamLink link on External Jobs: ' + id);
  await cand.screenshot({ path: `${SHOTS}/desktop-02-external.png` });
  return `${new Set(ids).size} external job id(s) on the page, 0 TeamLink`;
});

await check('5. AI recommendations: B out-scores A, and B is still never recommended on Jobs', async () => {
  const ext = await cand.evaluate((t) => {
    const card = [...document.querySelectorAll('.xj-card')].find((c) => c.innerText.includes(t));
    const m = card && /(\d+)% match/.exec(card.innerText);
    return m ? Number(m[1]) : null;
  }, X.B.title);
  must(ext != null, 'no % on B');
  await open(cand, '#/candidate/search');
  await clearSearch(cand);
  await cand.waitForTimeout(800);
  const tl = await cand.evaluate((id) => {
    const card = [...document.querySelectorAll('.rj-card')].find((c) => c.innerHTML.includes('/job/' + id));
    const b = card && card.querySelector('.rj-score b');
    return b ? Number(b.textContent.replace('%', '')) : null;
  }, T.A.id);
  must(tl != null, 'no % on A');
  must(ext > tl, `B ${ext}% is not above A ${tl}% - the fixture does not test the rule`);
  await jobsPageOnly(cand, 'recommended', { has: ['A'], tl: TL0 });
  const ai = await cand.locator('.rj-aibox').innerText();
  for (const t of EXT_TITLES) must(!ai.includes(t), 'the AI summary names an external job');
  return `B ${ext}% (External Jobs) > A ${tl}% (Jobs) - only TeamLink jobs recommended`;
});

await check('10. Natural language "show me fresher Python jobs in Hyderabad": parsed, then TeamLink jobs only', async () => {
  await open(cand, '#/candidate/search');
  await clearSearch(cand);
  await cand.evaluate(() => { window.__say = 'show me fresher Python jobs in Hyderabad'; });
  await cand.click('.rj-search .tlvs-mic');
  await cand.waitForSelector('#tlvsGo', { timeout: 15000 });
  const chips = await cand.$$eval('.tlvs-chip', (c) => c.map((x) => x.firstChild.textContent.trim()));
  await cand.click('#tlvsGo');
  await cand.waitForTimeout(1500);
  const s = await jobsPageOnly(cand, 'natural language', { has: ['A'], tl: TL0 });
  /* The parser's own answer, typed rather than spoken. */
  r = await api(cand, 'post', '/search/voice-parse', { text: 'show me fresher Python jobs in Hyderabad', lang: 'en-IN' });
  must(r.ok, r.message);
  const ids = r.v.semantic.results.map((x) => x.jobId);
  must(ids.every((id) => !isExt(id) && TL0.has(id)), 'the parser returned a non-TeamLink job');
  return `understood ${chips.join(' + ')}; ${s.ids.length} TeamLink cards; parser ${ids.length} TeamLink results`;
});

await check('12 + 13. Pagination and scrolling to the end: no external job on any page', async () => {
  const total = (await api(cand, 'get', '/jobs?limit=1')).v.total;
  const seen = [];
  for (let off = 0; off < total; off += 2) seen.push(...(await api(cand, 'get', `/jobs?limit=2&offset=${off}`)).v.jobs.map((j) => j.id));
  must(seen.length === total, `pages gave ${seen.length} of ${total}`);
  must(seen.every((id) => !isExt(id) && TL0.has(id)), 'an external job on a page');
  const chip = [];
  const ct = (await api(cand, 'get', '/jobs?quick=salary3&limit=1')).v.total;
  for (let off = 0; off < ct; off += 2) chip.push(...(await api(cand, 'get', `/jobs?quick=salary3&limit=2&offset=${off}`)).v.jobs.map((j) => j.id));
  must(chip.every((id) => TL0.has(id)), 'an external job on a chip page');
  /* The Jobs page draws its whole list at once (it has no pager or
     infinite loader); scroll it to the end and look again at each step. */
  await open(cand, '#/candidate/search');
  await clearSearch(cand);
  for (let i = 0; i < 12; i += 1) {
    await cand.mouse.wheel(0, 900);
    await cand.waitForTimeout(250);
    await jobsPageOnly(cand, `scroll ${i}`, { tl: TL0 });
  }
  return `${Math.ceil(total / 2)} pages of 2 (${total} jobs), ${Math.ceil(ct / 2)} chip pages, 12 scroll steps: 0 external`;
});

await check('15. Filter counts: "Hyderabad (n)" and "n match" count TeamLink jobs', async () => {
  await open(cand, '#/candidate/search');
  await clearSearch(cand);
  await cand.waitForTimeout(800);
  const rail = await cand.locator('.rj-filters').innerText();
  const m = /Hyderabad\s*\(?(\d+)\)?/.exec(rail);
  must(m, 'no Hyderabad count in the rail: ' + rail.slice(0, 200));
  const shown = Number(m[1]);
  const server = (await api(cand, 'get', '/jobs?location=Hyderabad&limit=200')).v;
  must(server.jobs.every((j) => TL0.has(j.id)), 'server count includes a non-TeamLink job');
  must(shown === server.total, `rail says Hyderabad (${shown}), TeamLink Hyderabad jobs = ${server.total}`);
  await cand.evaluate(() => window.rjLocToggle('Hyderabad'));
  await cand.waitForTimeout(1000);
  const s = await jobsPageOnly(cand, 'Hyderabad filter', { has: ['A'], tl: TL0 });
  const head = /(\d+) match/.exec(await cand.locator('.rj-fh').innerText());
  must(head && Number(head[1]) === s.ids.length, `"${head && head[0]}" vs ${s.ids.length} cards`);
  const extHyd = (await api(cand, 'get', '/portal/external-jobs?location=Hyderabad&q=' + stamp)).v.total;
  return `Hyderabad (${shown}) = ${server.total} TeamLink jobs (the ${extHyd} external Hyderabad jobs not counted); "${head[0]}"`;
});

let SAVED = null;
await check('16. A saved search made on Jobs is TEAMLINK, and stays TeamLink-only when it is run later', async () => {
  await open(cand, '#/candidate/search');
  await clearSearch(cand);
  await cand.fill('#rjQ', `Python`);
  await cand.locator('.rj-search .go, .rj-search button', { hasText: 'Search' }).first().click();
  await cand.waitForTimeout(800);
  await cand.locator('button', { hasText: 'Save this search' }).first().click();
  await cand.waitForSelector('#tlssName', { timeout: 8000 });
  await cand.fill('#tlssName', `Python ${stamp}`);
  await cand.click('#tlssSave');
  await cand.waitForTimeout(1200);
  const list = (await api(cand, 'get', '/saved-searches')).v.savedSearches;
  SAVED = list.find((x) => x.label === `Python ${stamp}`);
  must(SAVED && SAVED.sourceType === 'TEAMLINK', 'saved: ' + JSON.stringify(SAVED));
  /* Later: a new external Python job and a new TeamLink one. */
  await importExt('LATER', `Python Backend Later XL${stamp}`);
  const later = await postTL('LATER', { title: `Python Backend Later TL${stamp}`, location: 'Hyderabad', mode: 'Onsite', exp: '1-3 yrs', skills: ['Python'] });
  await open(cand, '#/candidate/alerts', 2000);
  await cand.locator('button', { hasText: 'Run search' }).first().click();
  await cand.waitForTimeout(2000);
  must(/#\/candidate\/search/.test(cand.url()), 'Run search went to ' + cand.url());
  const tl = await teamlinkIds();
  const s = await jobsPageOnly(cand, 'saved search run', { has: ['A', 'LATER'], tl });
  must(!s.text.includes(X.LATER.title), 'the new external job is in the saved search');
  await cand.screenshot({ path: `${SHOTS}/desktop-16-saved-search.png` });
  return `stored sourceType ${SAVED.sourceType}; run later: ${s.ids.length} TeamLink (new TeamLink "${later.title}" in, new external out)`;
});

await check('17. A job a recruiter posts is TEAMLINK automatically and appears on Jobs', async () => {
  await open(cand, '#/candidate/search');
  await clearSearch(cand);
  const before = (await screen(cand)).count;
  /* The recruiter does not choose the source - even a request that says so is TeamLink. */
  const j = await postTL('NEW', { title: `Python Trainee TN${stamp}`, location: 'Hyderabad', mode: 'Onsite', exp: 'Fresher', skills: ['Python'],
    source: 'Naukri', sourceType: 'EXTERNAL' });
  must(j.sourceType === 'TEAMLINK' && j.jobSourceType === 'TEAMLINK', 'stored as ' + j.sourceType);
  await open(cand, '#/candidate/search');
  await clearSearch(cand);
  const tl = await teamlinkIds();
  const s = await jobsPageOnly(cand, 'after a recruiter job', { has: ['NEW'], tl });
  must(s.count === before + 1, `count ${before} -> ${s.count}`);
  return `sourceType ${j.sourceType}; on Jobs; count ${before} -> ${s.count}`;
});

await check('18. A new import is EXTERNAL automatically and appears ONLY on External Jobs', async () => {
  await open(cand, '#/candidate/search');
  await clearSearch(cand);
  const before = (await screen(cand)).count;
  const x = await importExt('NEW', `Python Trainee Import XN${stamp}`);
  must(isExt(x.id), 'import id ' + x.id);
  const d = (await api(cand, 'get', `/portal/external-jobs/${x.id}`)).v.job;
  must(d.sourceType === 'EXTERNAL' && d.jobSourceName === `Naukri partner feed ${stamp}`, `${d.sourceType} / ${d.jobSourceName}`);
  await open(cand, '#/candidate/search');
  await clearSearch(cand);
  const tl = await teamlinkIds();
  const s = await jobsPageOnly(cand, 'after an import', { tl });
  must(s.count === before, `the Jobs count moved ${before} -> ${s.count}`);
  await open(cand, '#/candidate/external-jobs', 2500);
  await cand.evaluate((q) => window.xjFilter('skill', q), `Import XN${stamp}`);
  await cand.waitForFunction((t) => document.body.innerText.includes(t), x.title, { timeout: 15000 });
  return `${x.id}: EXTERNAL, source "${d.jobSourceName}"; External Jobs yes, Jobs no (count ${before} -> ${s.count})`;
});

await check('11 (details). A job page stays in its dataset', async () => {
  await open(cand, '#/job/' + T.A.id);
  const a = await cand.locator('body').innerText();
  must(a.includes(T.A.title), 'A details');
  must(!/Job type\s*External/.test(a), 'A is marked External');
  await open(cand, '#/job/' + X.B.id, 2500);
  await cand.waitForSelector('#tlpxTitle', { timeout: 15000 });
  const b = await cand.locator('article').first().innerText();
  must(/External/.test(b) && b.includes(X.B.title), 'B details are not marked External');
  const back = await cand.locator('button', { hasText: 'See other jobs' }).count();
  return `A: TeamLink page; B: External page${back ? '' : ''}`;
});

/* ---- the phone ------------------------------------------------------------- */
TL0 = await teamlinkIds();          // the jobs tests 16-17 added are TeamLink too
const mctx = await context({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const phone = await newPage(mctx, 'phone');
r = await api(phone, 'post', '/auth/login', { email: candEmail, password: `Vsep${stamp}Z9`, role: 'candidate' });
must(r.ok, 'phone login: ' + r.message);
await jobsSuite(phone, 'phone');
await check('[phone] 2. External Jobs: B visible, A not', async () => {
  await open(phone, '#/candidate/external-jobs', 2500);
  await phone.evaluate((q) => window.xjFilter('skill', q), stamp);
  await phone.waitForFunction((t) => document.body.innerText.includes(t), X.B.title, { timeout: 15000 });
  const txt = await phone.locator('body').innerText();
  for (const j of Object.values(T)) must(!txt.includes(j.title), 'TeamLink job on External Jobs: ' + j.title);
  must(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'the page scrolls sideways');
  await phone.screenshot({ path: `${SHOTS}/phone-02-external.png` });
});

/* ---- clean up --------------------------------------------------------------- */
await check('clean up: the verification jobs, source and saved search are removed', async () => {
  if (SAVED) await api(cand, 'del', `/saved-searches/${SAVED.id}`);
  for (const j of Object.values(T)) await api(admin, 'del', `/jobs/${j.id}`);
  r = await api(admin, 'del', `/external/sources/${SRC}`);
  must(r.ok, 'source: ' + r.message);
  const left = await teamlinkIds();
  must(Object.values(T).every((j) => !left.has(j.id)), 'a verification job is left');
});

await check('no page errors', async () => { must(!errors.length, errors.slice(0, 3).join(' | ')); });

await browser.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
