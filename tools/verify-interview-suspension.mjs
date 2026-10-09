/**
 * AI interview: Submit must not suspend; a real suspension says why and when
 * the retake opens; the recruiter sees it and controls it. Through the UI.
 *
 *   TL_URL=http://127.0.0.1:4437/ node tools/verify-interview-suspension.mjs
 *
 * Chromium's fake camera and microphone stand in for the hardware. The
 * microphone is then made DELIBERATELY LOUD (every analyser read is a loud
 * square wave) and the interviewer's voice is made to last for seconds, so
 * the exact conditions that used to suspend an interview after Submit are
 * present for the whole run. Speech recognition is stubbed as in
 * verify-ai-video-interview.mjs.
 *
 * Creates accounts and a job, so it refuses :4323.
 */
import { chromium } from 'playwright';

const BASE = (process.env.TL_URL || 'http://127.0.0.1:4437/').replace(/\/?$/, '/');
const u = new URL(BASE);
if (!['127.0.0.1', 'localhost'].includes(u.hostname) || u.port === '4323') {
  console.error(`Refusing to run against ${BASE}: this creates accounts. Use an isolated instance.`);
  process.exit(2);
}
const RECRUITER = process.env.TL_RECRUITER_EMAIL || 'recruiter@teamlink.com';
const PW = process.env.TL_RECRUITER_PASSWORD || 'TeamLink@2026';
const s = Date.now().toString(36);
let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  PASS  ${name}`); }
  catch (e) { console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n')[0]}`); failed += 1; }
};
const must = (c, m) => { if (!c) throw new Error(m); };

const STUBS = () => {
  window.__TLVI_TEST__ = { answerSecs: 30 };
  window.__spoken = [];
  window.__ttsMs = 15;
  let sayVal = '';
  Object.defineProperty(window, '__say', { configurable: true, get: () => sayVal, set: (v) => { sayVal = v; window.__sayPending = !!v; } });
  function Utt(text) { this.text = text; }
  window.SpeechSynthesisUtterance = Utt;
  const synth = {
    speaking: false, pending: false, paused: false,
    speak(u) {
      window.__spoken.push(String(u.text || ''));
      synth.speaking = true;
      setTimeout(() => { synth.speaking = false; if (typeof u.onend === 'function') u.onend(); }, window.__ttsMs);
    },
    cancel() { synth.speaking = false; }, pause() {}, resume() {}, getVoices() { return []; }, addEventListener() {},
  };
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, get: () => synth });
  class FakeRecognition {
    constructor() { this.lang = ''; this.continuous = false; this.interimResults = false; this._t = []; }
    start() {
      const res = (idx, finals) => ({ resultIndex: idx, results: finals.map((t) => { const r = [{ transcript: t, confidence: 0.9 }]; r.isFinal = true; return r; }) });
      const finals = [];
      this._i = setInterval(() => {
        if (!window.__sayPending || !window.__say) return;
        window.__sayPending = false;
        const say = String(window.__say); const idx = finals.length;
        this._t.push(setTimeout(() => { finals.push(say); if (this.onresult) this.onresult(res(idx, finals)); }, 300));
      }, 120);
    }
    stop() { this._t.forEach(clearTimeout); clearInterval(this._i); }
    abort() { this.stop(); }
  }
  window.SpeechRecognition = FakeRecognition; window.webkitSpeechRecognition = FakeRecognition;
  /* A LOUD room for the whole run: this is what used to be read as
     "continuous background noise" / "another voice" after Submit. */
  AnalyserNode.prototype.getByteTimeDomainData = function (buf) { for (let i = 0; i < buf.length; i++) buf[i] = i % 2 ? 228 : 28; };
};

const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
const errors = [];
const watch = (page, tag) => {
  page.on('pageerror', (e) => errors.push(`${tag}: ${String(e.message).slice(0, 200)}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|mediapipe|MediaPipe|Content Security Policy|connect-src|fonts\.g|423|status of 4/i.test(m.text())) errors.push(`${tag} console: ${m.text().slice(0, 200)}`);
  });
};
const ready = (page) => page.waitForFunction(() => window.TL && TL.ready === true, null, { timeout: 30000 });
const bodyText = (page) => page.evaluate(() => document.body.innerText);

/* ---- a job from the recruiter, then the candidate ------------------------ */
const rb = await browser.newContext();
const rp = await rb.newPage();
watch(rp, 'recruiter');
await rp.goto(BASE + '#/'); await ready(rp);
const jobId = await rp.evaluate(async ({ e, pw, t }) => {
  await TL.api.post('/auth/login', { email: e, password: pw, role: 'recruiter' });
  const boot = await TL.api.get('/bootstrap');
  const me = (boot.data.recruiters || []).find((r) => r.id === boot.session.id) || {};
  const j = await TL.api.post('/jobs', { title: t, companyId: me.companyId, location: 'Hyderabad', mode: 'Onsite', exp: '1-3 yrs',
    pay: '₹4 LPA', salaryMin: 4, salaryMax: 4, type: 'Full-time', status: 'open', skills: ['Sourcing', 'ATS', 'Excel'], desc: 'Verification job - safe to delete.' });
  try { await TL.api.put(`/jobs/${j.job.id}/screening-questions`, { questions: [] }); } catch (x) { /* optional */ }
  return j.job.id;
}, { e: RECRUITER, pw: PW, t: `Suspension Check ${s}` });

const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ['camera', 'microphone'] });
await ctx.addInitScript(STUBS);
const p = await ctx.newPage();
watch(p, 'candidate');
await p.goto(BASE + '#/'); await ready(p);
const email = `susp.${s}@tl-verify.test`;
await p.evaluate(async ({ email, jobId }) => {
  await TL.api.post('/auth/register', { name: 'Sushma Check', email, password: `Susp${email.length}pw9x`,
    phone: '9' + String(Math.floor(1e8 + Math.random() * 9e8)), preferredLocation: 'Hyderabad', expectedCtc: 4,
    noticePeriod: 'Immediate', preferredWorkModes: ['Hybrid'] });
  await TL.api.post('/applications', { jobId });
}, { email, jobId });
await p.goto('about:blank'); await p.goto(BASE + '#/candidate/home'); await ready(p);
await p.waitForFunction(() => window.STATE && STATE.session && STATE.session.role === 'candidate', null, { timeout: 20000 });
await p.waitForTimeout(1500);
const ref = await p.evaluate(async (jobId) => {
  await TL.refresh(); TL.ensureLocalRecords();
  const a = DATA.applications.find((x) => x.jobId === jobId && x.candidateId === STATE.session.id);
  const f = TL.aiivRec(a.id);
  return f && f.rec ? f.rec.applicationId : a.id;
}, jobId);
await p.evaluate(() => document.querySelectorAll('.tlpo-ov .tlpo-btn.ghost, .tlpo-ov .tlpo-skip').forEach((x) => x.click()));

async function startInterview() {
  await p.evaluate((r) => { location.hash = '#/ai-interview/' + r; }, ref);
  await p.waitForTimeout(1200);
  await p.getByRole('button', { name: /Start AI Video Interview/i }).first().click();
  await p.waitForSelector('.tlvi[data-phase="check"]', { timeout: 10000 });
  await p.getByRole('button', { name: /Turn on camera and microphone/i }).first().click();
  await p.waitForFunction(() => [...document.querySelectorAll('.tlvi-check')].every((x) => x.dataset.state === 'ok'), null, { timeout: 20000 }).catch(() => {});
  await p.getByRole('button', { name: /Continue to the briefing/i }).first().click();
  await p.waitForSelector('.tlvi[data-phase="briefing"]', { timeout: 8000 });
  await p.getByRole('button', { name: /Start the questions/i }).first().click();
  await p.waitForSelector('.tlvi[data-phase="interview"]', { timeout: 15000 });
}
const listening = () => p.waitForFunction(() => window.AIIV && AIIV.listening === true, null, { timeout: 15000 });
const interviewState = () => p.evaluate(async () => {
  const id = TL.__aiivSession && TL.__aiivSession.interviewId;
  return { id, phase: AIIV.phase, q: AIIV.idx + 1 };
});

console.log(`\nInterview suspension  (${BASE})`);

let ivId;
await check('Submit does not suspend, with a loud room and a long interviewer voice', async () => {
  await p.evaluate(() => { window.__ttsMs = 6000; });           // the interviewer talks for 6 s per question
  await startInterview();
  ivId = (await interviewState()).id;
  must(ivId, 'no server session');
  for (let n = 1; n <= 3; n++) {
    await listening();
    await p.evaluate((n) => { window.__say = `Answer number ${n}: I sourced forty candidates on LinkedIn and closed six hires in a month.`; }, n);
    await p.waitForTimeout(900);
    await p.click('#tlviSubmit');
    await p.waitForTimeout(500);
    must((await interviewState()).phase === 'interview', `the interview stopped right after Submit on question ${n}`);
    /* the next question's whole voice runs now, with a loud microphone */
    await p.waitForTimeout(7500);
    const st = await interviewState();
    must(st.phase === 'interview', `the interview stopped (${st.phase}) after Submit on question ${n}`);
  }
  const server = await p.evaluate(async (id) => (await TL.api.get(`/ai-interviews/${id}/progress`)).status, ivId);
  must(server === 'in_progress' || server === 'warning_issued', `server status ${server}`);
  must(!/suspended/i.test(await bodyText(p)), 'the screen says suspended');
});

await check('leaving the tab WARNS first, the interview carries on; a second leave suspends with the reason, the question and the retake time', async () => {
  await p.evaluate(() => { window.__ttsMs = 15; });
  await listening();
  const q = (await interviewState()).q;
  const leave = () => p.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const back = () => p.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await leave();
  await p.waitForSelector('.tlig-warn', { timeout: 8000 });
  must(/Warning 1\/2/.test(await p.textContent('.tlig-warn')), 'no "Warning 1/2"');
  must((await interviewState()).phase === 'interview', 'a first leave stopped the interview');
  must(!/Interview suspended/.test(await bodyText(p)), 'suspended on the first leave');
  await back();
  await p.waitForTimeout(500);
  await leave();
  await p.waitForFunction(() => /Interview suspended/.test(document.body.innerText), null, { timeout: 8000 });
  await p.waitForFunction(() => /after .*(am|pm)/i.test(document.body.innerText), null, { timeout: 8000 });
  const t = await bodyText(p);
  must(new RegExp(`The interview window was not in front during your answer to Question ${q}\.`).test(t), `no reason with Question ${q}: ${t.slice(0, 300)}`);
  must(/You can retake this interview after .*IST/.test(t), 'no retake time in IST');
  must(!/reject|failed|disqualif/i.test(t), 'the screen uses a forbidden word');
  must(!/What was observed|confidence|threshold|rms/i.test(t), 'internal detail shown');
  const row = await p.evaluate(async (id) => { try { return await TL.api.get(`/ai-interviews/${id}/suspension`); } catch (e) { return { err: `${e.status} ${e.code} ${e.message}` }; } }, ivId);
  must(row.suspended === true && row.message && row.retakeAvailableAt, JSON.stringify(row));
  must(t.includes(row.message), 'the screen and the stored message differ');
});

await check('starting again before the retake time says when, not "could not prepare"', async () => {
  await p.getByRole('button', { name: /Back to my application/i }).first().click();
  await p.waitForTimeout(1200);
  await startInterview().catch(() => {});
  await p.waitForFunction(() => /You can retake this interview after/.test(document.body.innerText), null, { timeout: 15000 });
  const t = await bodyText(p);
  must(!/could not prepare/i.test(t), 'the generic failure screen came up');
  must(/Interview suspended/.test(t), 'no suspension screen');
});

await check('the recruiter sees the reason, the question, the attempt and the retake; can grant another attempt (audited)', async () => {
  const id = ivId;
  await rp.goto(BASE + '#/recruiter/applications'); await ready(rp);
  await rp.waitForTimeout(1500);
  const list = await rp.evaluate(async () => (await TL.api.get('/ai-interviews/integrity')).interviews);
  const mine = list.find((x) => x.id === id);
  must(mine, 'the suspended interview is not in the recruiter list');
  must(mine.suspensionMessage && mine.suspensionQuestionNo && mine.attemptNumber === 1 && mine.display === 'Under Recruiter Review', JSON.stringify(mine));
  await rp.evaluate((i) => window.tlIntegrityOpen(i), id);
  await rp.waitForFunction(() => /Suspended — under recruiter review/i.test(document.body.innerText), null, { timeout: 8000 });
  const t = await bodyText(rp);
  must(/Question \d+ · Suspended/.test(t) && /Detections: 2/.test(t) && /Attempt 1/.test(t), 'reason details missing: ' + t.slice(0, 400));
  must(/Retake: Opens/.test(t), 'no retake status');
  must(/Block retake/.test(t) && /Grant another attempt now/.test(t), 'no retake controls');
  must(/Current score: none yet/.test(t), 'the score line');
  /* a reason is required */
  await rp.getByRole('button', { name: /Block retake/i }).first().click();
  await rp.waitForTimeout(400);
  must((await rp.evaluate(async (i) => (await TL.api.get(`/ai-interviews/${i}/integrity`)).retakeBlocked, id)) === false, 'blocked without a reason');
  await rp.fill('#tligRetakeWhy', 'Needs a call before another attempt');
  await rp.getByRole('button', { name: /Block retake/i }).first().click();
  await rp.waitForFunction(() => /Blocked by a recruiter/.test(document.body.innerText), null, { timeout: 8000 });
  /* Allow, then grant another attempt */
  await rp.fill('#tligRetakeWhy', 'Spoke to the candidate');
  await rp.getByRole('button', { name: /Allow retake/i }).first().click();
  await rp.waitForFunction(() => /Grant another attempt now/.test(document.body.innerText) && !/Blocked by a recruiter/.test(document.body.innerText), null, { timeout: 8000 });
  await rp.fill('#tligRetakeWhy', 'Candidate reported a technical problem');
  await rp.getByRole('button', { name: /Grant another attempt now/i }).first().click();
  await rp.waitForFunction(() => /Open now/.test(document.body.innerText), null, { timeout: 8000 });
});

await check('after the grant the candidate can start attempt 2 from Question 1, and attempt 1 is kept', async () => {
  await p.getByRole('button', { name: /Back to my application/i }).first().click();
  await p.waitForTimeout(800);
  await startInterview();
  await listening();
  const t = await p.evaluate(() => document.querySelector('#tlviQn').textContent);
  must(/^Question 1 of \d+$/.test(t), t);
  const detail = await rp.evaluate(async (i) => await TL.api.get(`/ai-interviews/${i}/integrity`), ivId);
  must(detail.attempts.length === 2, `${detail.attempts.length} attempts`);
  must(detail.attempts[0].status === 'suspended' && detail.attempts[0].suspensionMessage, 'attempt 1 was changed');
  must(detail.attempts[1].attemptNumber === 2, 'attempt number');
});

await check('no page errors', async () => { must(errors.length === 0, `page errors: ${errors.slice(0, 3).join(' | ')}`); });
await browser.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nall passed');
process.exit(failed ? 1 : 0);
