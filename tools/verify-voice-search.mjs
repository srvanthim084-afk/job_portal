/**
 * Voice search, in a real browser, with the browser's speech recognition
 * stubbed so the test can "say" a phrase.
 *
 *   1  no SpeechRecognition -> no mic
 *   2  public search: "Nellore lo driver job kavali" -> chips, filters, results
 *   3  remove a chip before searching; Edit puts the words in the box
 *   4  candidate Search Jobs: "fresher data entry jobs near Guntur"
 *   3b places said in Telugu / Devanagari script, rules engine (no AI key)
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
{
  const rc = await browser.newContext();
  const rp = await open(rc, '#/');
  const out = await rp.evaluate(async ({ e, p, s }) => {
    await TL.api.post('/auth/login', { email: e, password: p });
    const boot = await TL.api.get('/bootstrap');
    const myCo = ((boot.data.recruiters || []).find((r) => boot.session && r.id === boot.session.id) || {}).companyId; const co = (boot.data.companies || []).find((x) => x.id === myCo) || (boot.data.companies || [])[0];
    const made = [];
    for (const [t, loc, mode, exp] of [['Driver', 'Nellore', 'Onsite', '0-2 yrs'], ['Telecaller', 'Hyderabad', 'Remote', '0-2 yrs'],
      ['Data Entry Operator', 'Guntur', 'Onsite', '0–1 yrs'], ['Delivery Executive', 'Nellore', 'Onsite', '0-2 yrs']]) {
      const j = await TL.api.post('/jobs', { title: `${t} ${s}`, companyId: co.id, location: loc, mode, exp, pay: '₹2-3 LPA',
        salaryMin: 2, salaryMax: 3, type: 'Full-time', status: 'open', skills: [t.split(' ')[0]], description: 'Verification job - safe to delete.' });
      made.push(j.job.id);
    }
    return made;
  }, { e: RECRUITER, p: PW, s: stamp });
  if (!Array.isArray(out)) { console.error('could not create jobs'); process.exit(1); }
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
  must(box === 'driver job kavali', 'box: ' + box);
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
  const st = await cp.evaluate(() => ({ q: STATE.rj.q, exp: STATE.rj.f.exp, tags: STATE.rj.f.locTags,
    list: (document.querySelector('.rj-page') || document.body).innerText }));
  must(st.q === 'data entry' && st.exp.join() === 'Fresher' && st.tags.join() === 'Guntur', JSON.stringify(st).slice(0, 160));
  must(st.list.includes(`Data Entry Operator ${stamp}`), 'the data entry job is not listed');
  await shot(cp, 'voice-candidate-results');
});

await check('5. nothing found -> "No jobs for ..." with one-tap removals', async () => {
  await say(cp, 'plumber job in Nellore', '.rj-search .tlvs-mic');
  await cp.click('#tlvsGo');
  await cp.waitForSelector('#tlvsNone', { timeout: 8000 });
  const t = await cp.evaluate(() => document.getElementById('tlvsNone').innerText);
  must(/No jobs for Plumber · Nellore/.test(t) && /Remove Plumber/.test(t), t);
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

await browser.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
