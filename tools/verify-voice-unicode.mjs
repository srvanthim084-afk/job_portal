/**
 * Voice search keeps Telugu and Hindi text whole, all the way through.
 *
 * Reported: a Telugu search came back as "No jobs for న య ర ల జ స ట క య" -
 * the vowel signs, matras and virama (Unicode combining marks) stripped,
 * the letters left apart - in the Skills box, in "No jobs for ..." and on
 * the "Remove ..." button. The browser's transcript was fine; the server's
 * leftover-words cleaner kept letters and digits but not marks.
 *
 * This drives the REAL chain on the candidate's Search Jobs page, with a
 * speech recogniser that "hears" a fixed sentence (a real microphone cannot
 * be automated):
 *
 *   mic -> recognition (lang te-IN / hi-IN) -> "You said" (exactly the
 *   sentence) -> chips -> Search -> STATE.rj.q and the Skills box ->
 *   "No jobs for ..." and "Remove ..."
 *
 * and checks that every Telugu / Devanagari word shown is a whole word of
 * what was said. English must come out exactly as before.
 *
 * Creates an account, so it refuses :4323.
 *   TL_URL=http://127.0.0.1:4417/ node tools/verify-voice-unicode.mjs
 */
import { chromium } from 'playwright';

const BASE = (process.env.TL_URL || 'http://127.0.0.1:4417/').replace(/\/?$/, '/');
const u = new URL(BASE);
if (!['127.0.0.1', 'localhost'].includes(u.hostname) || u.port === '4323') {
  console.error(`Refusing to run against ${BASE}: this creates an account. Use an isolated instance.`);
  process.exit(2);
}

let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  PASS  ${name}`); }
  catch (e) { console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n')[0]}`); failed += 1; }
};
const must = (c, m) => { if (!c) throw new Error(m); };
const stamp = Date.now().toString(36);
const cps = (s) => [...String(s)].map((c) => c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')).join(' ');

const STUB = () => {
  class FakeRecognition {
    constructor() { this.lang = 'en-IN'; this.continuous = false; this.interimResults = false; this._t = []; }
    start() {
      window.__lastLang = this.lang;
      const say = String(window.__say || '');
      const r = [{ transcript: say, confidence: 0.9 }]; r.isFinal = true;
      this._t.push(setTimeout(() => this.onresult && this.onresult({ resultIndex: 0, results: [r] }), 200));
    }
    stop() { this._t.forEach(clearTimeout); setTimeout(() => this.onend && this.onend(), 20); }
    abort() { this._t.forEach(clearTimeout); }
  }
  window.SpeechRecognition = FakeRecognition;
  window.webkitSpeechRecognition = FakeRecognition;
};

/** Every word in `shown` written in an Indic script must be a whole word of `said`. */
function wholeWords(shown, said) {
  const words = new Set(String(said).normalize('NFC').toLowerCase().split(/\s+/));
  const bad = String(shown).normalize('NFC').toLowerCase().split(/[\s·]+/)
    .filter((w) => /[ऀ-ॿఀ-౿]/.test(w) && !words.has(w));
  return bad;
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.addInitScript(STUB);
const p = await ctx.newPage();
p.on('pageerror', (e) => console.log('        page error:', e.message));
await p.goto(BASE + '#/');
await p.waitForFunction(() => window.TL && TL.ready === true, null, { timeout: 30000 });
const reg = await p.evaluate((s) => TL.api.post('/auth/register', {
  name: `Unicode Voice ${s}`, email: `unicode.voice.${s}@tl-verify.test`, password: `Uni${s}99x`,
  phone: '9' + String(Math.floor(1e8 + Math.random() * 9e8)), preferredLocation: 'Bangalore',
  expectedCtc: 4, noticePeriod: 'Immediate', preferredWorkModes: ['Hybrid'],
}).then(() => 'ok', (e) => e.message), stamp);
must(reg === 'ok', 'register: ' + reg);
await p.goto('about:blank');
await p.goto(BASE + '#/candidate/search');
await p.waitForFunction(() => window.TL && TL.ready === true && window.STATE && STATE.session, null, { timeout: 30000 });
await p.waitForTimeout(1500);
await p.evaluate(() => document.querySelectorAll('.tlpo-ov .tlpo-btn.ghost, .tlpo-ov .tlpo-skip').forEach((b) => b.click()));

async function speak(lang, sentence) {
  await p.evaluate(() => { try { window.tlvsClose && tlvsClose(); } catch (e) { /* */ } });
  /* the panel's own language picker, as a person would choose it */
  await p.evaluate(({ l, s }) => { window.tlvsLang(l); window.__say = s; }, { l: lang, s: sentence });
  await p.click('.rj-search .tlvs-mic');
  await p.waitForSelector('#tlvsGo, .tlvs-err, .tlvs-note', { timeout: 15000 });
  const said = await p.evaluate(() => {
    const el = Array.from(document.querySelectorAll('div')).find((d) => d.textContent.trim() === 'You said:');
    const box = el ? el.nextElementSibling : null;
    /* shown inside quotation marks; the words between them are what counts */
    return { lang: window.__lastLang, youSaid: box ? box.textContent.trim().replace(/^["“]|["”]$/g, '') : null,
      chips: Array.from(document.querySelectorAll('.tlvs-chip')).map((c) => c.firstChild.textContent.trim()) };
  });
  await p.click('#tlvsGo');
  await p.waitForTimeout(1800);
  const after = await p.evaluate(() => ({
    q: (window.STATE && STATE.rj && STATE.rj.q) || '',
    skills: (document.getElementById('rjQ') || {}).value || '',
    none: (document.getElementById('tlvsNone') || {}).innerText || '',
    remove: Array.from(document.querySelectorAll('#tlvsNone button')).map((b) => b.textContent.trim()).filter((t) => /^Remove /.test(t)),
  }));
  return { ...said, ...after };
}

const report = (r, sentence) => {
  console.log(`        RAW       : ${sentence}\n        RAW CPs   : ${cps(sentence)}`);
  console.log(`        lang=${r.lang} | You said: ${r.youSaid}`);
  console.log(`        chips: ${JSON.stringify(r.chips)} | q: ${JSON.stringify(r.q)} | Skills box: ${JSON.stringify(r.skills)}`);
  console.log(`        q CPs     : ${cps(r.q)}`);
  console.log(`        No jobs   : ${JSON.stringify(r.none.split('\n')[0] || '')} | ${JSON.stringify(r.remove)}`);
};

console.log(`\nvoice search keeps Telugu and Hindi whole  (${BASE})`);

for (const [lang, sentence, label] of [
  ['te-IN', 'నాకు హైదరాబాద్‌లో Python jobs కావాలి', 'Telugu'],
  ['te-IN', 'తెలుగు సాఫ్ట్‌వేర్ డెవలపర్ హైదరాబాద్‌లో', 'Telugu with virama, ZWNJ and vowel signs'],
  ['hi-IN', 'मुझे हैदराबाद में Python jobs चाहिए', 'Hindi'],
]) {
  await check(`${label}: You said, chips, Skills box, search state, "No jobs for" and "Remove" keep every word whole`, async () => {
    const r = await speak(lang, sentence);
    report(r, sentence);
    must(r.lang === lang, `the recogniser listened in ${r.lang}, not ${lang}`);
    must(r.youSaid === sentence, `"You said" is not the sentence: ${r.youSaid}`);
    for (const [where, text] of [['chips', r.chips.join(' · ')], ['search state', r.q], ['Skills box', r.skills],
      ['No jobs for', r.none.split('\n')[0] || ''], ['Remove', r.remove.join(' · ')]]) {
      const bad = wholeWords(text, sentence);
      must(!bad.length, `${where} has broken words: ${bad.join(', ')} (${text})`);
    }
    must(r.q && r.q.trim(), 'nothing reached the search at all (the meaning-based layer turns the words into English concepts)');
  });
}

await check('English comes out exactly as before: "Python jobs in Hyderabad"', async () => {
  const r = await speak('en-IN', 'Python jobs in Hyderabad');
  report(r, 'Python jobs in Hyderabad');
  must(r.lang === 'en-IN', 'lang ' + r.lang);
  must(r.youSaid === 'Python jobs in Hyderabad', 'You said: ' + r.youSaid);
  must(r.q === 'python hyderabad' || r.q === 'python', `q: ${r.q}`);
});

await browser.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
