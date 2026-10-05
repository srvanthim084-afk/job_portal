/**
 * Voice search, in a real browser, with the browser's speech recognition
 * stubbed so the test can "say" a phrase.
 *
 *   1  no SpeechRecognition -> no mic
 *   2  public search: "Nellore lo driver job kavali" -> chips, filters, results
 *   3  remove a chip before searching; Edit puts the words in the box
 *   4  candidate Search Jobs: "fresher data entry jobs near Guntur"
 *   3b places said in Telugu / Devanagari script, rules engine (no AI key)
 *   7  by meaning, the owner's ten acceptance tests (T1-T10) on the public search
 *   8  the candidate's Search Jobs by meaning, saved with its criteria, run again
 *   5  nothing found -> "No jobs for ..." with one-tap removals
 *   6  microphone permission refused -> a clear message
 *
 * Creates accounts and jobs, so it refuses :4323:
 *   TL_URL=http://127.0.0.1:4422/ node tools/verify-voice-search.mjs
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

let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  PASS  ${name}`); }
  catch (e) { console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n')[0]}`); failed += 1; }
};
const must = (c, m) => { if (!c) throw new Error(m); };
const stamp = Date.now().toString(36);
const PW = process.env.DEV_PASSWORD || 'TeamLink@2026';
const RECRUITER = process.env.TL_RECRUITER_EMAIL || 'recruiter@teamlink.com';

/* A speech recogniser that "hears" window.__say, or fails with window.__sayError. */
const STUB = () => {
  class FakeRecognition {
    constructor() { this.lang = 'en-IN'; this.continuous = false; this.interimResults = false; this._t = []; }
    start() {
      window.__lastLang = this.lang;
      const say = String(window.__say || '');
      if (window.__sayError) {
        this._t.push(setTimeout(() => { this.onerror && this.onerror({ error: window.__sayError }); this.onend && this.onend(); }, 150));
        return;
      }
      const words = say.split(' ');
      const half = words.slice(0, Math.ceil(words.length / 2)).join(' ');
      const res = (text, isFinal) => {
        const r = [{ transcript: text, confidence: 0.9 }]; r.isFinal = isFinal;
        return { resultIndex: 0, results: [r] };
      };
      this._t.push(setTimeout(() => this.onresult && this.onresult(res(half, false)), 120));
      this._t.push(setTimeout(() => this.onresult && this.onresult(res(say, true)), 300));
    }
    stop() { this._t.forEach(clearTimeout); setTimeout(() => this.onend && this.onend(), 20); }
    abort() { this._t.forEach(clearTimeout); }
  }
  window.SpeechRecognition = FakeRecognition;
  window.webkitSpeechRecognition = FakeRecognition;
};
const NO_SR = () => { try { delete window.SpeechRecognition; delete window.webkitSpeechRecognition; } catch (e) { /* */ }
  window.SpeechRecognition = undefined; window.webkitSpeechRecognition = undefined; };

const browser = await chromium.launch();
async function open(ctx, hash) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('        page error:', e.message));
  await page.goto(BASE + hash);
  await page.waitForFunction(() => window.TL && TL.ready === true, null, { timeout: 30000 });
  await page.waitForTimeout(700);
  return page;
}
const ready = (page) => page.waitForFunction(() => window.TL && TL.ready === true, null, { timeout: 30000 });
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }); };
const say = async (page, phrase, surfaceSel) => {
  await page.evaluate((p) => { window.__say = p; window.__sayError = null; }, phrase);
  await page.click(surfaceSel);
  await page.waitForSelector('#tlvsGo, .tlvs-err, .tlvs-note', { timeout: 15000 });
};
const chips = (page) => page.evaluate(() => Array.from(document.querySelectorAll('.tlvs-chip')).map((c) => c.firstChild.textContent.trim()));

/* Jobs to find. */
let JOB = {};
{
  const rc = await browser.newContext();
  const rp = await open(rc, '#/');
  const out = await rp.evaluate(async ({ e, p, s }) => {
    await TL.api.post('/auth/login', { email: e, password: p });
    const boot = await TL.api.get('/bootstrap');
    const myCo = ((boot.data.recruiters || []).find((r) => boot.session && r.id === boot.session.id) || {}).companyId; const co = (boot.data.companies || []).find((x) => x.id === myCo) || (boot.data.companies || [])[0];
    const made = {};
    for (const [key, t, loc, mode, exp, skills, desc] of [
      ['driver', 'Driver', 'Nellore', 'Onsite', '0-2 yrs', ['Driver'], ''],
      ['tele', 'Telecaller', 'Hyderabad', 'Remote', '0-2 yrs', ['Telecaller'], ''],
      ['dataentry', 'Data Entry Operator', 'Guntur', 'Onsite', '0–1 yrs', ['Data'], ''],
      ['delivery', 'Delivery Executive', 'Nellore', 'Onsite', '0-2 yrs', ['Delivery'], ''],
      /* for the meaning checks: one says Python only in its description */
      ['py', 'Python Developer', 'Hyderabad', 'Onsite', '1-3 yrs', ['Python', 'Django'], 'Build web services.'],
      ['be', 'Backend Engineer', 'Hyderabad', 'Onsite', '1-3 yrs', ['APIs', 'PostgreSQL'], 'We build our services in Python with FastAPI.'],
      ['jv', 'Java Developer', 'Hyderabad', 'Onsite', '1-3 yrs', ['Java', 'Spring Boot'], 'Enterprise applications.'],
      ['jvb', 'Java Developer', 'Bengaluru', 'Onsite', '1-3 yrs', ['Java', 'Microservices'], 'Payments platform.'],
      ['ml', 'Machine Learning Engineer', 'Hyderabad', 'Onsite', '1-3 yrs', ['PyTorch', 'NLP'], 'Train and ship models.'],
      ['gen', 'GenAI Specialist', 'Pune', 'Hybrid', '1-3 yrs', ['Prompting'], 'Build LLM applications for customers.'],
      ['fe', 'Frontend Developer', 'Remote', 'Remote', '1-3 yrs', ['React', 'CSS'], 'Our product UI.'],
      ['tc', 'Technology Consultant', 'Hyderabad', 'Onsite', '1-3 yrs', ['SAP'], 'Advise customers on IT systems.'],
      ['and', 'Android Developer', 'Pune', 'Onsite', '1-3 yrs', ['Kotlin'], 'Build our mobile app for shops.'],
    ]) {
      const j = await TL.api.post('/jobs', { title: `${t} ${s}`, companyId: co.id, location: loc, mode, exp, pay: '₹2-3 LPA',
        salaryMin: 2, salaryMax: 3, type: 'Full-time', status: 'open', skills, desc: `${desc} Verification job - safe to delete.`.trim() });
      made[key] = j.job.id;
    }
    return made;
  }, { e: RECRUITER, p: PW, s: stamp });
  if (!out || !out.py) { console.error('could not create jobs'); process.exit(1); }
  JOB = out;
  await rc.close();
}

console.log(`\nvoice search  (${BASE})`);

await check('1. no speech recognition in the browser -> no mic', async () => {
  const ctx = await browser.newContext();
  await ctx.addInitScript(NO_SR);
  const p = await open(ctx, '#/');
  must(await p.evaluate(() => !document.querySelector('.tlvs-mic')), 'a mic is shown');
  must(await p.evaluate(() => window.TLVoiceSearch && TLVoiceSearch.supported() === false), 'reported as supported');
  await ctx.close();
});

const pub = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await pub.addInitScript(STUB);
const pp = await open(pub, '#/');

await check('2. public search: "Nellore lo driver job kavali" -> chips, filters and results', async () => {
  must(await pp.evaluate(() => !!document.querySelector('.search-card .tlvs-mic')), 'no mic in the search bar');
  const before = await pp.evaluate(() => Number(document.querySelector('.result-count b').textContent));
  await say(pp, 'Nellore lo driver job kavali', '.search-card .tlvs-mic');
  const c = await chips(pp);
  must(c.join('|') === 'Driver|Nellore', 'chips: ' + c.join('|'));
  must(await pp.evaluate(() => document.querySelector('.tlvs-priv').textContent.includes('We only receive the text')), 'privacy line');
  await shot(pp, 'voice-panel-phone');
  await pp.click('#tlvsGo');
  await pp.waitForTimeout(1200);
  const st = await pp.evaluate(() => ({ q: STATE.search.q, loc: STATE.search.loc, tags: tlLocState('pubJobs').tags,
    n: Number(document.querySelector('.result-count b').textContent),
    titles: Array.from(document.querySelectorAll('.job-list')).map((x) => x.innerText).join(' ') }));
  must(st.q === 'driver' && st.loc === 'Nellore', JSON.stringify(st).slice(0, 200));
  must(st.tags.includes('Nellore'), 'location field not set');
  must(st.n >= 1 && st.n !== before, `results ${before} -> ${st.n}`);
  must(st.titles.includes(`Driver ${stamp}`), 'the driver job is not listed');
  must(await pp.evaluate(() => STATE.recentSearches[0] && STATE.recentSearches[0].label === 'driver'), 'not in recent searches');
  await shot(pp, 'voice-public-results-phone');
});

await check('3. a chip can be removed before searching; Edit puts the words in the box', async () => {
  await say(pp, 'Hyderabad mein work from home telecaller', '.search-card .tlvs-mic');
  const c = await chips(pp);
  must(c.includes('Telecaller') && c.includes('Hyderabad') && c.includes('Work from home'), c.join('|'));
  await pp.click('.tlvs-chip:nth-child(3) button');
  must(!(await chips(pp)).includes('Work from home'), 'chip not removed');
  await pp.click('#tlvsGo');
  await pp.waitForTimeout(1000);
  const st = await pp.evaluate(() => ({ q: STATE.search.q, mode: STATE.search.mode, loc: STATE.search.loc }));
  must(st.q === 'telecaller' && st.loc === 'Hyderabad' && st.mode.length === 0, JSON.stringify(st));
  await say(pp, 'driver job kavali', '.search-card .tlvs-mic');
  await pp.click('.tlvs-acts button:first-child');      // Edit
  await pp.waitForTimeout(500);
  const box = await pp.evaluate(() => document.querySelector('.search-card input[name="q"]').value);
  /* Edit puts the search we UNDERSTOOD in the box (English), not the sentence */
  must(box === 'driver', 'box: ' + box);
});

await check('3b. places said in Telugu / Devanagari script (no AI key) -> the place chip and the jobs there', async () => {
  for (const [phrase, want, title] of [
    ['నెల్లూరు లో డ్రైవర్ జాబ్', 'Driver|Nellore', `Driver ${stamp}`],
    ['हैदराबाद में टेलीकॉलर', 'Telecaller|Hyderabad', `Telecaller ${stamp}`],
    ['గుంటూరులో డేటా ఎంట్రీ', 'Data Entry|Guntur', `Data Entry Operator ${stamp}`],
  ]) {
    await say(pp, phrase, '.search-card .tlvs-mic');
    const c = await chips(pp);
    must(c.join('|') === want, `${phrase}: chips ${c.join('|')}`);
    if (phrase.startsWith('నె')) await shot(pp, 'voice-telugu-panel-phone');
    await pp.click('#tlvsGo');
    await pp.waitForTimeout(1200);
    const st = await pp.evaluate(() => ({ loc: STATE.search.loc, tags: tlLocState('pubJobs').tags,
      titles: Array.from(document.querySelectorAll('.job-list')).map((x) => x.innerText).join(' ') }));
    const place = want.split('|')[1];
    must(st.loc === place && st.tags.includes(place), `${phrase}: ${JSON.stringify({ loc: st.loc, tags: st.tags })}`);
    must(st.titles.includes(title), `${phrase}: "${title}" is not listed`);
  }
  const engine = await pp.evaluate(() => TL.api.post('/search/voice-parse', { text: 'విజయవాడ లో నర్స్', lang: 'te-IN' }));
  must(engine.engine === 'rules', 'engine ' + engine.engine);
  await shot(pp, 'voice-telugu-results-phone');
});

/* ---- by meaning: the owner's ten acceptance tests, through the public search ---- */
const NATIVE = /[\u0900-\u097f\u0c00-\u0c7f]/;
const T = (k) => {
  const t = { py: 'Python Developer', be: 'Backend Engineer', jv: 'Java Developer', jvb: 'Java Developer', ml: 'Machine Learning Engineer',
    gen: 'GenAI Specialist', fe: 'Frontend Developer', tc: 'Technology Consultant', and: 'Android Developer', driver: 'Driver', tele: 'Telecaller' }[k];
  return `${t} ${stamp}`;
};
async function sayAndSearch(page, phrase, mic) {
  await say(page, phrase, mic);
  const c = await chips(page);
  await page.click('#tlvsGo');
  await page.waitForTimeout(1500);
  return c;
}
/* the jobs on the public list, in the order shown (the page's own functions) */
const shown = (page) => page.evaluate(() => {
  const list = sortJobs(filterJobsAdvanced(STATE.search), STATE.search.sort, null);
  return { ids: list.map((j) => j.id), q: STATE.search.q, n: Number(document.querySelector('.result-count b').textContent),
    text: Array.from(document.querySelectorAll('.job-list')).map((x) => x.innerText).join(' '),
    none: (document.getElementById('tlvsNone') || {}).innerText || '' };
});

await check('7. by meaning (T1-T10): Telugu / mixed speech -> the English intent, ranked jobs, never the Telugu text', async () => {
  const mic = '.search-card .tlvs-mic';
  const fail = [];
  const expect = (cond, msg) => { if (!cond) fail.push(msg); };
  // T1
  let c = await sayAndSearch(pp, 'నాకు హైదరాబాద్‌లో Python jobs కావాలి', mic);
  let s = await shown(pp);
  expect(c.join('|') === 'Python|Hyderabad', 'T1 chips ' + c.join('|'));
  expect(s.q === 'python' && s.ids.includes(JOB.py) && s.ids.includes(JOB.be) && !s.ids.includes(JOB.jv) && s.ids[0] === JOB.py,
    'T1 ' + JSON.stringify({ q: s.q, ids: s.ids }));
  expect(s.text.includes(T('be')), 'T1 the description-only Python job is not on the page');
  await shot(pp, 'voice-semantic-t1-phone');
  // T2
  c = await sayAndSearch(pp, 'నాకు AI related jobs కావాలి', mic);
  s = await shown(pp);
  expect(s.ids.includes(JOB.ml) && s.ids.includes(JOB.gen) && !s.ids.includes(JOB.driver) && !s.ids.includes(JOB.jv), 'T2 ' + JSON.stringify(s.ids));
  // T3
  c = await sayAndSearch(pp, 'నాకు Java developer jobs Hyderabad లో కావాలి', mic);
  s = await shown(pp);
  expect(c.join('|') === 'Java Developer|Hyderabad', 'T3 chips ' + c.join('|'));
  expect(s.ids[0] === JOB.jv && !s.ids.includes(JOB.jvb), 'T3 ' + JSON.stringify(s.ids));
  // T4
  c = await sayAndSearch(pp, 'కన్సల్టెంట్ టెక్నాలజీకి సంబంధించిన ఉద్యోగాలు కావాలి, ప్రస్తుతం హైదరాబాద్‌లో ఉన్నాను', mic);
  s = await shown(pp);
  expect(c.join('|') === 'Technology Consultant|Hyderabad', 'T4 chips ' + c.join('|'));
  expect(s.q === 'technology consultant' && s.ids[0] === JOB.tc && s.n > 0 && !/No (jobs|matching)/.test(s.none), 'T4 ' + JSON.stringify({ q: s.q, ids: s.ids, none: s.none }));
  await shot(pp, 'voice-semantic-t4-phone');
  // T5
  c = await sayAndSearch(pp, 'Hyderabad lo software jobs kavali', mic);
  s = await shown(pp);
  expect(c.join('|') === 'Software|Hyderabad' && s.n > 0 && s.ids.includes(JOB.py), 'T5 ' + c.join('|') + ' ' + JSON.stringify(s.ids));
  // T6
  c = await sayAndSearch(pp, 'పైథాన్ జాబ్స్ కావాలి', mic);
  s = await shown(pp);
  expect(c.join('|') === 'Python' && s.ids.includes(JOB.be) && s.ids.includes(JOB.py), 'T6 ' + c.join('|') + ' ' + JSON.stringify(s.ids));
  // T7
  c = await sayAndSearch(pp, 'హైదరాబాదులో జాబ్స్', mic);
  s = await shown(pp);
  expect(c.join('|') === 'Hyderabad' && s.ids.includes(JOB.tc) && s.ids.includes(JOB.py) && !s.ids.includes(JOB.driver) && !s.ids.includes(JOB.jvb),
    'T7 ' + c.join('|') + ' ' + JSON.stringify(s.ids));
  // T8
  c = await sayAndSearch(pp, 'నాకు టెక్నాలజీ ఉద్యోగాలు కావాలి', mic);
  s = await shown(pp);
  expect(c.join('|') === 'Technology' && s.ids.includes(JOB.tc) && s.ids.includes(JOB.py) && !s.ids.includes(JOB.driver), 'T8 ' + c.join('|') + ' ' + JSON.stringify(s.ids));
  // T9
  c = await sayAndSearch(pp, 'నాకు Flutter jobs Pune లో కావాలి', mic);
  s = await shown(pp);
  expect(s.ids.includes(JOB.and) && /\d+ related jobs? found\. Showing the closest matches\./.test(s.none), 'T9 ' + JSON.stringify({ ids: s.ids, none: s.none }));
  await shot(pp, 'voice-semantic-t9-related-phone');
  // T10
  c = await sayAndSearch(pp, 'నెల్లూరు లో వెల్డర్ ఉద్యోగాలు కావాలి', mic);
  s = await shown(pp);
  expect(s.n === 0 && /No matching Welder jobs found in Nellore\./.test(s.none) && !NATIVE.test(s.none), 'T10 ' + JSON.stringify({ n: s.n, none: s.none }));
  await shot(pp, 'voice-semantic-t10-none-phone');
  // never the Telugu text as the search key
  expect(!NATIVE.test(s.q), 'a native-script search key: ' + s.q);
  must(!fail.length, fail.join(' || '));
});

const cand = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await cand.addInitScript(STUB);
const cp = await open(cand, '#/');
{
  const r = await cp.evaluate((s) => TL.api.post('/auth/register', { name: `Voice Seeker ${s}`, email: `voice.${s}@tl-verify.test`,
    password: `Voice${s}9`, phone: '9' + String(Math.floor(1e8 + Math.random() * 9e8)), preferredLocation: 'Guntur',
    expectedCtc: 2, noticePeriod: 'Immediate', preferredWorkModes: ['Work From Office'] }).then(() => 'ok', (e) => e.message), stamp);
  if (r !== 'ok') { console.error('register:', r); process.exit(1); }
  await cp.reload(); await ready(cp);
  await cp.waitForFunction(() => window.STATE && STATE.session, null, { timeout: 15000 });
}

await check('4. candidate Search Jobs: "fresher data entry jobs near Guntur"', async () => {
  await cp.evaluate(() => { location.hash = '#/candidate/search'; });
  await cp.waitForTimeout(1500);
  await cp.evaluate(() => { document.querySelectorAll('.tlpo-ov .tlpo-btn.ghost, .tlpo-ov .tlpo-skip').forEach((b) => b.click()); });
  must(await cp.evaluate(() => !!document.querySelector('.rj-search .tlvs-mic')), 'no mic on Search Jobs');
  await cp.evaluate(() => { window.__say = null; });
  await cp.click('.rj-search .tlvs-mic');
  await cp.waitForSelector('.tlvs-lang', { timeout: 5000 });
  await cp.evaluate(() => tlvsClose());
  await cp.evaluate(() => { localStorage.removeItem('tlvs_lang_v1'); });
  await say(cp, 'fresher data entry jobs near Guntur', '.rj-search .tlvs-mic');
  const c = await chips(cp);
  must(c.join('|') === 'Data Entry|Guntur|Fresher', c.join('|'));
  await cp.click('#tlvsGo');
  await cp.waitForTimeout(1500);
  const st = await cp.evaluate(() => ({ q: STATE.rj.q, box: (document.getElementById('rjQ') || {}).value, exp: STATE.rj.f.exp, tags: STATE.rj.f.locTags,
    list: (document.querySelector('.rj-page') || document.body).innerText }));
  /* matched by meaning: the box shows the English search, its substring rule is off */
  must(st.q === '' && st.box === 'data entry' && st.exp.join() === 'Fresher' && st.tags.join() === 'Guntur', JSON.stringify(st).slice(0, 160));
  must(st.list.includes(`Data Entry Operator ${stamp}`), 'the data entry job is not listed');
  await shot(cp, 'voice-candidate-results');
});

await check('5. nothing found -> "No jobs for ..." with one-tap removals', async () => {
  await say(cp, 'plumber job in Nellore', '.rj-search .tlvs-mic');
  await cp.click('#tlvsGo');
  await cp.waitForSelector('#tlvsNone', { timeout: 8000 });
  const t = await cp.evaluate(() => document.getElementById('tlvsNone').innerText);
  must(/No matching Plumber jobs found in Nellore\./.test(t) && /Remove Plumber/.test(t), t);
  await shot(cp, 'voice-no-results');
  await cp.evaluate(() => { const b = Array.from(document.querySelectorAll('#tlvsNone button')).find((x) => /Remove Plumber/.test(x.textContent)); b.click(); });
  await cp.waitForTimeout(1500);
  const st = await cp.evaluate(() => ({ q: STATE.rj.q, tags: STATE.rj.f.locTags, list: document.body.innerText }));
  must(st.q === '' && st.tags.join() === 'Nellore', JSON.stringify(st).slice(0, 120));
  must(st.list.includes(`Driver ${stamp}`), 'Nellore jobs not shown after removing the chip');
});

await check('6. microphone permission refused -> a clear message', async () => {
  await cp.evaluate(() => { window.__sayError = 'not-allowed'; });
  await cp.click('.rj-search .tlvs-mic');
  await cp.waitForSelector('.tlvs-err', { timeout: 5000 });
  const t = await cp.evaluate(() => document.querySelector('.tlvs-err').textContent);
  must(/permission was denied/i.test(t), t);
  await cp.evaluate(() => tlvsClose());
});

await check('8. candidate Search Jobs by meaning; saving it keeps the normalized criteria; running it matches by meaning', async () => {
  const phrase = 'నాకు హైదరాబాద్‌లో Python jobs కావాలి';
  await cp.evaluate(() => { location.hash = '#/candidate/search'; });
  await cp.waitForTimeout(1200);
  const c = await sayAndSearch(cp, phrase, '.rj-search .tlvs-mic');
  must(c.join('|') === 'Python|Hyderabad', 'chips ' + c.join('|'));
  const st = await cp.evaluate(() => ({ q: STATE.rj.q, box: (document.getElementById('rjQ') || {}).value,
    list: (document.querySelector('.rj-page') || document.body).innerText }));
  must(st.q === '' && st.box === 'python', JSON.stringify({ q: st.q, box: st.box }));
  must(st.list.includes(T('py')) && st.list.includes(T('be')) && !st.list.includes(T('jv')), 'list: ' + st.list.slice(0, 300));
  await shot(cp, 'voice-semantic-candidate');
  /* save it from the screen, as the candidate would */
  await cp.evaluate(() => tlssSaveCurrent());
  await cp.waitForSelector('#tlssSave', { timeout: 8000 });
  await shot(cp, 'voice-semantic-save-panel');
  await cp.click('#tlssSave');
  await cp.waitForTimeout(1500);
  const saved = await cp.evaluate(() => TL.api.get('/saved-searches').then((o) => o.savedSearches));
  const mine = saved.find((x) => x.filters && x.filters.voice && x.filters.voice.originalQuery === 'నాకు హైదరాబాద్‌లో Python jobs కావాలి');
  must(mine, 'no saved search with the voice criteria: ' + JSON.stringify(saved.map((x) => x.filters)).slice(0, 300));
  const v = mine.filters.voice;
  must(v.normalizedQuery === 'python jobs in Hyderabad' && v.concepts.join() === 'python' && v.location.join() === 'Hyderabad'
    && v.language === 'MIXED' && mine.filters.q === 'python', JSON.stringify(mine.filters));
  /* run it again from Job Alerts: the screen is filled by meaning, not by the word */
  await cp.evaluate(() => { STATE.rj.q = 'zzz'; location.hash = '#/candidate/home'; });
  await cp.waitForTimeout(800);
  await cp.evaluate((id) => tlssRun(id), mine.id);
  await cp.waitForTimeout(2500);
  const run = await cp.evaluate(() => ({ hash: location.hash, q: STATE.rj.q, list: (document.querySelector('.rj-page') || document.body).innerText }));
  must(/candidate\/search/.test(run.hash) && run.q === '' && run.list.includes(T('be')) && run.list.includes(T('py')), JSON.stringify({ hash: run.hash, q: run.q }));
});

/* ================================================================== *
 * 9. the owner's master task: the 12 sentences and the priority /
 *    fallback / Edit / Again / typed-search tests, each through the real
 *    chain - mic button -> (stubbed) SpeechRecognition result -> "You
 *    said" -> Search -> the real search -> the real cards - with the
 *    report the owner asked for. A real microphone cannot be automated;
 *    the recogniser is stubbed and that is said in the report.
 * ================================================================== */
const REPORT = [];
const cards = (page, surface) => page.evaluate((s) => (s === 'candidate'
  /* Search Jobs draws two card styles: the plain list (.rj-card) and, with a
     place picked, the "Jobs in <place>" groups - read the title (h3) and
     the card's own text for the place, whichever style is on screen */
  ? Array.from(document.querySelectorAll('.rj-page h3')).filter((h3) => !h3.closest('.rj-head, .rj-aibox, .rj-side, .fcr-jd-head'))
    .map((h3) => {
      let card = h3.parentElement;
      while (card && card.querySelectorAll('h3').length === 1 && card.parentElement && card.parentElement.querySelectorAll('h3').length === 1) card = card.parentElement;
      const loc = card ? (card.innerText.split('\n').find((l) => /📍|·/.test(l) && l !== h3.textContent) || '') : '';
      return { title: h3.textContent || '', where: loc };
    })
  : Array.from(document.querySelectorAll('.job-list .job-row')).map((c) => ({ title: (c.querySelector('h3') || {}).textContent || '', where: (c.querySelector('.co-name') || {}).textContent || '' }))
).map((x) => ({ title: x.title.replace(/\s+/g, ' ').trim(), where: x.where.replace(/\s+/g, ' ').trim() })), surface);
async function uiCase(page, phrase, surface) {
  const mic = surface === 'candidate' ? '.rj-search .tlvs-mic' : '.search-card .tlvs-mic';
  await page.evaluate((p) => { window.__say = p; window.__sayError = null; }, phrase);
  await page.click(mic);
  await page.waitForSelector('#tlvsGo, .tlvs-err', { timeout: 15000 });
  const youSaid = await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('.tlvs-pn .tlvs-tr')).pop();
    return el ? el.textContent.replace(/^“|”$/g, '') : '';
  });
  const chipsNow = await chips(page);
  const canGo = await page.evaluate(() => { const b = document.getElementById('tlvsGo'); return !!b && !b.disabled; });
  if (canGo) { await page.click('#tlvsGo'); await page.waitForTimeout(1800); }
  else await page.evaluate(() => tlvsClose());
  const last = await page.evaluate(() => (window.TLVoiceSearch && TLVoiceSearch.last ? TLVoiceSearch.last() : null));
  const ui = await page.evaluate((s) => ({
    q: s === 'candidate' ? (document.getElementById('rjQ') || {}).value : (document.querySelector('.search-card input[name="q"]') || {}).value,
    tags: typeof tlLocState === 'function' ? tlLocState(s === 'candidate' ? 'rjSide' : 'pubJobs').tags.slice() : [],
    stateQ: s === 'candidate' ? STATE.rj.q : STATE.search.q,
    none: (document.getElementById('tlvsNone') || {}).innerText || '',
  }), surface);
  return { phrase, youSaid, chips: chipsNow, canGo, last, ui, cards: await cards(page, surface) };
}
function report(n, r, pass, why) {
  const s = (r.last && r.last.search) || {};
  const m = (r.last && r.last.semantic) || {};
  const row = {
    n, RAW_INPUT: r.phrase, YOU_SAID_EXACT: r.youSaid === r.phrase.normalize('NFC'),
    NORMALIZED_INTENT: s.normalizedQuery || '', ROLE: (s.role || []).join(', '), SKILLS: [...(s.technologies || []), ...(s.skills || []), ...(s.industry || [])].join(', '),
    LOCATION: (s.location || []).join(', '), MATCHED_JOB_COUNT: r.cards.length,
    TOP_MATCHED_JOBS: r.cards.slice(0, 3).map((c) => `${c.title} [${c.where.split('·').pop().trim()}]`).join(' | '),
    FALLBACK_USED: m.level ? `L${m.level} ${m.levelName}` : (m.empty ? 'none - nothing relevant' : (m.passthrough ? 'filters only' : '-')),
    FINAL_MESSAGE: r.ui.none || m.message || '', RESULT: pass ? 'PASS' : `FAIL (${why})`,
  };
  REPORT.push(row);
  return pass;
}
const has = (r, title, place) => r.cards.some((c) => c.title === `${title} ${stamp}` && (!place || c.where.includes(place)));
const allIn = (r, place) => r.cards.filter((c) => c.title.endsWith(stamp)).every((c) => c.where.includes(place));

await check('9. master task: 12 sentences + priority / fallback / Edit / Again / typed regression, through the real UI', async () => {
  const bad = [];
  const run = async (n, page, phrase, surface, test) => {
    const r = await uiCase(page, phrase, surface);
    let ok = false; let why = '';
    try { why = test(r) || ''; ok = !why; } catch (e) { why = e.message; }
    if (r.phrase && /[ఀ-౿ऀ-ॿ]/.test(r.ui.stateQ || '')) { ok = false; why = 'native text became the search key'; }
    if (!report(n, r, ok, why)) bad.push(`${n}: ${why}`);
    return r;
  };
  await pp.evaluate(() => { location.hash = '#/jobs'; });
  await pp.waitForTimeout(1000);
  const P = 'public';
  const r1 = await run('1', pp, 'నాకు హైదరాబాద్‌లో Python jobs కావాలి', P, (r) => (has(r, 'Python Developer', 'Hyderabad') && has(r, 'Backend Engineer', 'Hyderabad')
    && allIn(r, 'Hyderabad') && r.ui.q === 'python' && r.ui.tags.join() === 'Hyderabad' ? '' : JSON.stringify({ q: r.ui.q, tags: r.ui.tags, cards: r.cards.slice(0, 5) })));
  REPORT.push({ n: 'Unicode', RAW_INPUT: r1.phrase, RESULT: r1.youSaid === r1.phrase.normalize('NFC') && r1.last && r1.last.search.originalQuery === r1.phrase.normalize('NFC') ? 'PASS' : `FAIL (you said: ${r1.youSaid})` });
  if (r1.youSaid !== r1.phrase.normalize('NFC')) bad.push('Unicode: "You said" differs from the input');
  await run('2', pp, 'నాకు హైదరాబాద్‌లో Java developer jobs కావాలి', P, (r) => (r.cards.length && r.cards[0].title === `Java Developer ${stamp}` && allIn(r, 'Hyderabad')
    && r.ui.q === 'java developer' ? '' : JSON.stringify(r.cards.slice(0, 4))));
  await run('3', pp, 'నాకు AI related jobs కావాలి', P, (r) => (has(r, 'Machine Learning Engineer') && has(r, 'GenAI Specialist') && !has(r, 'Driver') && !has(r, 'Java Developer') ? '' : JSON.stringify(r.cards.slice(0, 6))));
  await run('4', pp, 'హైదరాబాద్‌లో jobs కావాలి', P, (r) => (r.cards.length && allIn(r, 'Hyderabad') && has(r, 'Technology Consultant') && r.ui.tags.join() === 'Hyderabad' ? '' : JSON.stringify(r.cards.slice(0, 6))));
  await run('5', pp, 'Python jobs', P, (r) => (has(r, 'Python Developer') && has(r, 'Backend Engineer') && !r.ui.tags.length ? '' : JSON.stringify({ tags: r.ui.tags, cards: r.cards.slice(0, 4) })));
  await run('6', pp, 'Naaku Hyderabad lo Python jobs kavali', P, (r) => (has(r, 'Python Developer', 'Hyderabad') && allIn(r, 'Hyderabad') ? '' : JSON.stringify(r.cards.slice(0, 4))));
  await run('7', pp, 'Naaku Hyderabad lo Java developer jobs kavali', P, (r) => (r.cards.length && r.cards[0].title === `Java Developer ${stamp}` && allIn(r, 'Hyderabad') ? '' : JSON.stringify(r.cards.slice(0, 4))));
  await run('8', pp, 'నాకు remote frontend jobs కావాలి', P, (r) => (has(r, 'Frontend Developer') && r.cards.filter((c) => c.title.endsWith(stamp)).every((c) => /Frontend Developer/.test(c.title)) ? '' : JSON.stringify(r.cards.slice(0, 4))));
  await run('9', pp, 'నాకు హైదరాబాద్‌లో సాఫ్ట్‌వేర్ ఉద్యోగాలు కావాలి', P, (r) => (has(r, 'Python Developer', 'Hyderabad') && allIn(r, 'Hyderabad') && !has(r, 'Driver') ? '' : JSON.stringify(r.cards.slice(0, 6))));
  await run('10', pp, 'నాకు కన్సల్టెంట్ టెక్నాలజీకి సంబంధించిన ఉద్యోగాలు కావాలి, ప్రస్తుతం హైదరాబాద్‌లో ఉన్నాను', P,
    (r) => (r.cards.length && r.cards[0].title === `Technology Consultant ${stamp}` && r.ui.q === 'technology consultant' ? '' : JSON.stringify(r.cards.slice(0, 4))));
  await run('11', pp, 'నాకు Flutter jobs Pune లో కావాలి', P, (r) => (has(r, 'Android Developer') && /related jobs? found\. Showing the closest matches\./.test(r.ui.none) ? '' : JSON.stringify({ none: r.ui.none, cards: r.cards.slice(0, 4) })));
  await run('12', pp, 'నాకు వెల్డర్ ఉద్యోగాలు కావాలి', P, (r) => (r.cards.length === 0 && /^No matching (Welder )?jobs found\./.test(r.ui.none) ? '' : JSON.stringify({ none: r.ui.none, n: r.cards.length })));

  /* location fallback: case 2 with the Hyderabad Java job closed - Java jobs elsewhere, said so */
  {
    const rc2 = await browser.newContext(); const rp2 = await open(rc2, '#/');
    await rp2.evaluate(({ e, p }) => TL.api.post('/auth/login', { email: e, password: p }), { e: RECRUITER, p: PW });
    await rp2.evaluate((id) => TL.api.post(`/jobs/${id}/publish`, { publish: false }), JOB.jv);
    await pp.evaluate(() => TL.refresh && TL.refresh());
    await pp.waitForTimeout(1200);
    await run('Location fallback', pp, 'నాకు హైదరాబాద్‌లో Java developer jobs కావాలి', P, (r) => (has(r, 'Java Developer', 'Bengaluru')
      && /No Java Developer jobs found in Hyderabad\. Showing Java Developer jobs in other locations\./.test(r.ui.none)
      && !has(r, 'Python Developer') && !has(r, 'Technology Consultant') ? '' : JSON.stringify({ none: r.ui.none, cards: r.cards.slice(0, 4) })));
    await rp2.evaluate((id) => TL.api.post(`/jobs/${id}/publish`, { publish: true }), JOB.jv);
    await rc2.close();
    await pp.evaluate(() => TL.refresh && TL.refresh());
    await pp.waitForTimeout(1200);
  }

  /* Again: the second query fully replaces the first */
  await uiCase(pp, 'నాకు హైదరాబాద్‌లో Python jobs కావాలి', P);
  await run('Voice Again', pp, 'నాకు AI related jobs కావాలి', P, (r) => (r.ui.q === 'ai' && !r.ui.tags.length && has(r, 'GenAI Specialist', 'Pune') && !has(r, 'Python Developer')
    ? '' : JSON.stringify({ q: r.ui.q, tags: r.ui.tags, cards: r.cards.slice(0, 4) })));

  /* Edit: the normalized criteria go into the inputs; what is typed then wins */
  {
    await pp.evaluate((p) => { window.__say = p; window.__sayError = null; }, 'నాకు హైదరాబాద్‌లో Java developer jobs కావాలి');
    await pp.click('.search-card .tlvs-mic');
    await pp.waitForSelector('#tlvsGo', { timeout: 15000 });
    await pp.click('.tlvs-acts button:first-child');      // Edit
    await pp.waitForTimeout(800);
    const ed = await pp.evaluate(() => ({ q: document.querySelector('.search-card input[name="q"]').value, tags: tlLocState('pubJobs').tags.slice(),
      voice: TLVoiceSearch.active('public') }));
    let why = '';
    if (!(ed.q === 'java developer' && ed.tags.join() === 'Hyderabad' && ed.voice === false)) why = JSON.stringify(ed);
    /* the person edits the box and searches: the typed search, by its own rule (title / skills / company) */
    await pp.evaluate(() => { const f = document.querySelector('.search-card.smart-search form'); f.q.value = 'python'; submitSearchForm(f); });
    await pp.waitForTimeout(1200);
    const typed = { phrase: '(typed after Edit) python + Hyderabad', youSaid: '', last: null, ui: { none: '' }, cards: await cards(pp, P) };
    if (!why && !(has(typed, 'Python Developer', 'Hyderabad') && !has(typed, 'Backend Engineer'))) why = 'typed: ' + JSON.stringify(typed.cards.slice(0, 4));
    REPORT.push({ n: 'Voice Edit', RAW_INPUT: 'నాకు హైదరాబాద్‌లో Java developer jobs కావాలి', INPUTS_AFTER_EDIT: `${ed.q} / ${ed.tags.join()}`,
      TYPED_NEXT: 'python', MATCHED_JOB_COUNT: typed.cards.length, TOP_MATCHED_JOBS: typed.cards.slice(0, 3).map((c) => c.title).join(' | '),
      RESULT: why ? `FAIL (${why})` : 'PASS' });
    if (why) bad.push('Edit: ' + why);
  }

  /* typed-search regression: typed skill, typed location, a filter, Clear */
  {
    const out = await pp.evaluate(() => {
      const f = document.querySelector('.search-card.smart-search form');
      tlLocState('pubJobs').tags = ['Hyderabad'];
      f.q.value = 'Java'; submitSearchForm(f);
      return null;
    });
    void out;
    await pp.waitForTimeout(1200);
    const javaHyd = await cards(pp, P);
    await pp.evaluate(() => toggleFilterArrayValue('mode', 'Remote', true));
    await pp.waitForTimeout(800);
    const remoteOnly = await cards(pp, P);
    await pp.evaluate(() => { toggleFilterArrayValue('mode', 'Remote', false); clearAllFilters(); });
    await pp.waitForTimeout(800);
    const cleared = await pp.evaluate(() => ({ mode: STATE.search.mode.slice(), q: STATE.search.q }));
    const ok = javaHyd.some((c) => c.title === `Java Developer ${stamp}` && c.where.endsWith('Hyderabad')) && !javaHyd.some((c) => c.title === `Python Developer ${stamp}`)
      && remoteOnly.filter((c) => c.title.endsWith(stamp)).length === 0 && !cleared.mode.length;
    REPORT.push({ n: 'Typed regression', RAW_INPUT: 'typed "Java" + location Hyderabad, then mode Remote, then Clear All Filters',
      MATCHED_JOB_COUNT: javaHyd.length, TOP_MATCHED_JOBS: javaHyd.slice(0, 3).map((c) => c.title).join(' | '),
      RESULT: ok ? 'PASS' : `FAIL (${JSON.stringify({ javaHyd: javaHyd.slice(0, 3), remoteOnly: remoteOnly.slice(0, 3), cleared })})` });
    if (!ok) bad.push('typed regression');
  }

  /* location priority on the candidate's Search Jobs: profile Bangalore */
  {
    const bc = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await bc.addInitScript(STUB);
    const bp = await open(bc, '#/');
    const reg = await bp.evaluate((s) => TL.api.post('/auth/register', { name: `Blr Seeker ${s}`, email: `blr.${s}@tl-verify.test`,
      password: `Blr${s}9x`, phone: '9' + String(Math.floor(1e8 + Math.random() * 9e8)), preferredLocation: 'Bangalore',
      expectedCtc: 4, noticePeriod: 'Immediate', preferredWorkModes: ['Work From Office'] }).then(() => 'ok', (e) => e.message), stamp);
    if (reg !== 'ok') throw new Error('register: ' + reg);
    await bp.reload(); await ready(bp);
    await bp.waitForFunction(() => window.STATE && STATE.session, null, { timeout: 15000 });
    await bp.evaluate(() => { location.hash = '#/candidate/search'; });
    await bp.waitForTimeout(1500);
    await bp.evaluate(() => { document.querySelectorAll('.tlpo-ov .tlpo-btn.ghost, .tlpo-ov .tlpo-skip').forEach((b) => b.click()); });
    await run('Location priority (spoken)', bp, 'నాకు హైదరాబాద్‌లో Python jobs కావాలి', 'candidate', (r) => (has(r, 'Python Developer', 'Hyderabad')
      && allIn(r, 'Hyderabad') && r.ui.tags.join() === 'Hyderabad' ? '' : JSON.stringify({ tags: r.ui.tags, cards: r.cards.slice(0, 4) })));
    await run('Location priority (none spoken)', bp, 'Python jobs కావాలి', 'candidate', (r) => (has(r, 'Python Developer', 'Hyderabad') && !r.ui.tags.length
      ? '' : JSON.stringify({ tags: r.ui.tags, cards: r.cards.slice(0, 4) })));
    await shot(bp, 'voice-master-candidate');
    await bc.close();
  }
  console.log('\n        ---- master task report ----');
  REPORT.forEach((row) => console.log('        ' + JSON.stringify(row)));
  must(!bad.length, bad.join(' || '));
});

await browser.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
