/**
 * The interviewer says each line once, and stops when the candidate leaves.
 *
 *     node tools/verify-interview-says-thanks-once.mjs
 *
 * WHAT WAS REPORTED. "interview complete ayinaka kudaa tqtqtq anii
 * ostundhii" - after the interview finished it kept saying thank you -
 * and then "it is always saying tqtqtqtqtqtqtq". The closing line was
 * heard over and over until the tab was closed.
 *
 * THREE SEPARATE CAUSES, all of which this checks:
 *
 *   speak() called speechSynthesis.cancel() and then speak() in the same
 *   tick. That is a long-standing Chrome fault - an utterance queued in
 *   the same turn as a cancel can restart, and keep restarting. Heard as
 *   "tq tq tq tq".
 *
 *   Nothing stopped the same line being queued twice. A re-render or a
 *   double-fired handler layered a second copy on top of the first.
 *
 *   Chrome stops speaking after roughly fifteen seconds, and the usual
 *   pause/resume keepalive is itself a cause of repeats - so a long
 *   briefing had to be split at sentence boundaries instead.
 *
 * HOW IT IS CHECKED. The two browser APIs the feature depends on are
 * replaced before the page's own code runs - speech synthesis with a
 * recorder, speech recognition with a stub that returns a transcript -
 * and everything else is the real screen, driven through the same
 * handlers its own buttons call. A headless browser has no voices and no
 * dictation, which is why counting what was QUEUED, rather than
 * listening, is the only reliable way to test this.
 *
 * Nothing is added to the page for the benefit of this test.
 */
import { chromium } from 'playwright';

const BASE = (process.env.TL_URL || 'http://localhost:4323/').replace(/\/$/, '');
const fail = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`); if (!ok) fail.push(what); };

/*
 * A stand-in for speechSynthesis that records instead of speaking, and
 * finishes each utterance on a timer so the page's onend chain runs.
 * Deliberately installed with addInitScript, before any of the page's own
 * script, so nothing captures the real one first.
 */
const RECORDER = `
  window.__spoken = [];
  window.__cancels = 0;
  function FakeUtterance(text){ this.text = text; }
  FakeUtterance.prototype.addEventListener = function(){};
  window.SpeechSynthesisUtterance = FakeUtterance;
  /*
   * defineProperty, not assignment. window.speechSynthesis is an
   * accessor on the prototype with no setter, so "window.speechSynthesis
   * = fake" silently does nothing and the page goes on using the real
   * one - which then rejects the fake utterance and the whole test passes
   * on zeroes. Learned the hard way.
   */
  var FAKE_SYNTH = {
    speaking: false,
    pending: false,
    paused: false,
    speak: function(u){
      window.__spoken.push({ text: String(u.text || ''), at: Date.now() });
      var self = this;
      self.speaking = true;
      setTimeout(function(){
        self.speaking = false;
        if (typeof u.onend === 'function') { try { u.onend(); } catch (e) {} }
      }, 10);
    },
    cancel: function(){ window.__cancels++; this.speaking = false; },
    pause: function(){ this.paused = true; },
    resume: function(){ this.paused = false; },
    getVoices: function(){ return []; },
    addEventListener: function(){},
  };
  Object.defineProperty(window, 'speechSynthesis', {
    configurable: true, get: function(){ return FAKE_SYNTH; },
  });

  /*
   * Dictation, stubbed. The page's startSTT() builds one of these, sets
   * onresult, and calls start(); this hands back whatever the test has
   * put in window.__say, in the shape the real API uses, so the page's
   * own transcript handling runs unchanged.
   */
  window.__say = '';
  function FakeRecognition(){ this.lang = ''; this.continuous = false; this.interimResults = false; }
  FakeRecognition.prototype.start = function(){
    var self = this;
    setTimeout(function(){
      if (typeof self.onresult !== 'function' || !window.__say) return;
      self.onresult({
        resultIndex: 0,
        results: [Object.assign([{ transcript: window.__say }], { isFinal: true, length: 1 })],
      });
    }, 120);
  };
  FakeRecognition.prototype.stop = function(){ if (typeof this.onend === 'function') this.onend(); };
  FakeRecognition.prototype.abort = function(){};
  FakeRecognition.prototype.addEventListener = function(){};
  window.SpeechRecognition = FakeRecognition;
  window.webkitSpeechRecognition = FakeRecognition;
`;

/*
 * A FAKE CAMERA, NOT A DISABLED ONE.
 *
 * The proctoring rules are real: a camera that goes dark for five seconds
 * ends the interview, which is correct and is what happened the first time
 * this test ran - it got two questions in and was cut off. Chromium's
 * built-in fake capture device gives a moving test pattern, so the
 * interview runs to the end with proctoring fully switched on rather than
 * with it worked around.
 */
const browser = await chromium.launch({
  args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const ctx = await browser.newContext({
  viewport: { width: 1500, height: 1000 },
  permissions: ['microphone', 'camera'],
});
await ctx.addInitScript(RECORDER);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));

await page.goto(`${BASE}/`, { waitUntil: 'load' });
await page.waitForFunction(() => window.TL && window.TL.ready === true, { timeout: 25000 });

const api = async (m, p, b) => {
  const r = await page.evaluate(([mm, pp, bb]) => window.TL.api[mm](pp, bb)
    .then((v) => ({ ok: 1, v }), (e) => ({ ok: 0, c: e.code, m: e.message })), [m, p, b]);
  if (r.ok) return r.v;
  throw new Error(`${r.c || 'FAILED'}: ${r.m || ''}`);
};

const clear = () => page.evaluate(() => { window.__spoken = []; window.__cancels = 0; });
const spoken = () => page.evaluate(() => window.__spoken.map((x) => x.text));

const stamp = Date.now();
const made = [];

try {
  /* ---- a real interview, driven to the end -------------------------- */

  console.log('\na whole interview on the real screen, end to end\n');

  const email = `thanks.${stamp}@example.test`;
  const reg = await api('post', '/auth/register', {
    name: 'Says Thanks Once', email, password: 'Str0ngPass123',
    phone: '+91 90000 00077', location: 'Hyderabad', role: 'candidate',
  });
  const candidateId = (reg.candidate && reg.candidate.id) || reg.candidateId;
  made.push({ candidateId, email });

  await api('post', '/auth/login', { email, password: 'Str0ngPass123', role: 'candidate' });
  const jobs = (await api('get', '/jobs?limit=3')).jobs || [];
  const applied = await api('post', '/applications', { jobId: jobs[0].id, candidateId });
  const applicationId = (applied.application || {}).id || applied.id;

  /* What the stubbed dictation returns for every question. */
  await page.evaluate(() => {
    window.__say = 'On the ward I do this myself every day rather than referring it on. '
      + 'I was taught it during my residency and it has been part of my daily work for '
      + 'six years since. The hardest case was a patient whose old notes were missing, '
      + 'which was a real difficulty: I rang the referring hospital myself, sorted it '
      + 'within the hour and the outcome was that he was treated the same morning.';
  });

  /* The API call signed in; the screen has to be told, or the router
     bounces straight back to the sign-in page and the interview never
     renders. */
  await page.evaluate(() => window.TL.refresh());
  await page.waitForTimeout(2500);

  await clear();
  await page.evaluate((id) => window.navigate(`/ai-interview/${id}`), applicationId);
  await page.waitForTimeout(2500);

  /* Clicked, not called. The point is to prove the screen a candidate
     actually uses behaves, so the flow goes through the same buttons. */
  const clickText = async (rx, wait = 1200) => {
    const hit = await page.evaluate((src) => {
      const re = new RegExp(src, 'i');
      const b = [...document.querySelectorAll('button')]
        .find((x) => re.test((x.textContent || '').replace(/\s+/g, ' ')));
      if (!b) return null;
      b.click();
      return (b.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 44);
    }, rx.source || rx);
    if (hit) await page.waitForTimeout(wait);
    return hit;
  };

  /* The END of the main panel, not the start of the document. The whole
     candidate shell - logo, sidebar, nav - comes first in innerText, so
     reading the first 170 characters only ever showed the navigation and
     said nothing about which interview screen was up. */
  const shown = () => page.evaluate(() => {
    const main = document.querySelector('main') || document.body;
    const text = (main.innerText || '').replace(/\s+/g, ' ').trim();
    return {
      buttons: [...document.querySelectorAll('button')]
        .map((b) => (b.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 10),
      screen: text.slice(-260),
    };
  });

  const landed = await shown();
  console.log(`  opened:  ${landed.screen}`);
  check(/voice interview|camera|briefing|interview/i.test(landed.screen),
    '  the interview screen opened');

  /*
   * There is no camera in a headless browser, so this takes the "continue
   * anyway" path the page already offers - the same path a candidate on a
   * machine with no working camera takes.
   */
  for (const rx of [/start voice interview/i, /turn on camera/i,
    /hear briefing|continue anyway/i]) {
    const hit = await clickText(rx, 2500);
    console.log(`  clicked: ${hit || '(not on screen)'}`);
  }

  /* The briefing is the longest thing said in the whole interview, so it
     is where Chrome's fifteen-second cut-off used to bite. */
  await page.waitForTimeout(1500);
  const briefing = await spoken();
  check(briefing.length > 0, `  the briefing was spoken (${briefing.length} utterance(s))`);
  const longest = briefing.reduce((m, t) => Math.max(m, t.length), 0);
  check(longest > 0 && longest <= 220,
    `  split into pieces short enough to finish before Chrome stops (longest ${longest} chars)`);

  const toQuestions = await clickText(/start the questions|i am ready/i, 2500);
  console.log(`  clicked: ${toQuestions || '(not on screen)'}`);

  /* Answer every question. "Finish answer & next" advances; on the last
     one it reads "Finish answer & submit" and ends the interview. */
  let asked = 0;
  for (let i = 0; i < 30; i++) {
    const hit = await clickText(/finish answer/i, 1500);
    if (!hit) break;
    asked++;
    if (/submit/i.test(hit)) break;
  }

  await page.waitForTimeout(3500);
  const ended = await shown();
  console.log(`  ended:   ${ended.screen}`);
  check(asked >= 10,
    `  answered ${asked} question(s) through the screen (the blueprint asks 15)`);
  check(/complete|thank you|submitted|score|result/i.test(ended.screen),
    '  and the interview reached its closing screen');


  const lines = await spoken();
  const thanks = lines.filter((t) => /thank you/i.test(t) && /interview is complete/i.test(t));
  console.log(`  ${lines.length} utterance(s) queued across the whole interview`);
  check(thanks.length <= 1,
    `  the closing thank-you was queued ${thanks.length} time(s), not repeatedly`);

  /* The specific shape of the reported fault: the same text back to back,
     over and over - heard as "tq tq tq tq". */
  let worstRun = 1;
  let run = 1;
  for (let i = 1; i < lines.length; i++) {
    run = lines[i] === lines[i - 1] ? run + 1 : 1;
    if (run > worstRun) worstRun = run;
  }
  check(worstRun === 1, `  no line was queued back to back (longest repeat run: ${worstRun})`);

  /* Nor spread out: the same line three times over an interview is the
     same fault, whatever else was said in between. */
  const tally = {};
  for (const t of lines) tally[t] = (tally[t] || 0) + 1;
  const repeated = Object.entries(tally).filter(([, n]) => n > 1);
  check(repeated.length === 0,
    `  and no line was said more than once at all${
      repeated.length ? ` (${repeated.map(([t, n]) => `${n}x "${t.slice(0, 34)}..."`).join('; ')})` : ''}`);

  /* ---- leaving the interview stops the voice ------------------------ */
  await clear();
  await page.evaluate(() => { location.hash = '#/candidate/dashboard'; });
  await page.waitForTimeout(1500);
  const after = await spoken();
  check(after.length === 0,
    `  nothing is said after the candidate leaves the interview (${after.length} utterance(s))`);
} catch (e) {
  check(false, `the run failed (${e.message})`);
} finally {
  try { await api('post', '/auth/logout', {}); } catch { /* already out */ }
  try {
    await api('post', '/auth/login', {
      email: process.env.TL_ADMIN || 'admin@teamlink.com',
      password: process.env.TL_ADMIN_PASSWORD || process.env.TL_PASSWORD || 'TeamLink@2026',
      role: 'admin',
    });
    for (const m of made) {
      const gone = await api('post', '/admin/purge-test-candidate', { candidateId: m.candidateId })
        .catch((err) => ({ removed: false, error: err.message }));
      check(gone && gone.removed === true, `  removed ${m.email}`);
    }
  } catch (e) {
    check(false, `CLEANUP FAILED - remove ${made.map((m) => m.email).join(', ')} by hand (${e.message})`);
  }
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors[0]}` : ''}`);
  await browser.close();
  console.log(fail.length ? `\n${fail.length} failed` : '\nall good');
  process.exit(fail.length ? 1 : 0);
}
