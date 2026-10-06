/**
 * The AI video interview screen, end to end in a real browser.
 *
 *   TL_URL=http://127.0.0.1:4436/ node tools/verify-ai-video-interview.mjs
 *   TL_SHOTS=<dir>   also write screenshots
 *
 * Chromium's fake camera and microphone (--use-fake-device-for-media-stream)
 * stand in for the hardware, so the camera, the mic level and the
 * recordings are real media. SpeechRecognition and speechSynthesis are
 * stubbed with addInitScript (as verify-voice-search does): the stub
 * "hears" window.__say and the synthesiser finishes each line at once.
 * The answer timer is shortened to 12 s for the test ONLY, through
 * window.__TLVI_TEST__ set before the page loads - production has no such
 * switch.
 *
 * Checks: the device check; the layout at 1280 (50/50, gap 16, min height
 * 400) and at 390 (stacked, sticky controls); the mirrored video; the mic
 * bar moving; AI / You transcript lines, live captions and auto-scroll; the
 * timer turning amber at 10 s and auto-submitting at 0; Submit early; a
 * follow-up; End interview with its confirmation; permission denied with
 * help and Retry; offline -> "Reconnecting" -> the same question; keyboard
 * operation; the transcript and recordings on the server, readable by the
 * job's recruiter; no score on the candidate's screen; no page errors.
 *
 * Creates accounts and a job, so it refuses :4323.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = (process.env.TL_URL || 'http://127.0.0.1:4436/').replace(/\/?$/, '/');
const u = new URL(BASE);
if (!['127.0.0.1', 'localhost'].includes(u.hostname) || u.port === '4323') {
  console.error(`Refusing to run against ${BASE}: this creates accounts. Use an isolated instance.`);
  process.exit(2);
}
const SHOTS = process.env.TL_SHOTS || '';
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const RECRUITER = process.env.TL_RECRUITER_EMAIL || 'recruiter@teamlink.com';
const PW = process.env.TL_RECRUITER_PASSWORD || process.env.DEV_PASSWORD || 'TeamLink@2026';
const SECS = 12;

let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  PASS  ${name}`); }
  catch (e) { console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n')[0]}`); failed += 1; }
};
const must = (c, m) => { if (!c) throw new Error(m); };
const s = Date.now().toString(36);
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }); };

/* Speech, stubbed: the recogniser "hears" window.__say (an interim half,
   then the whole as final); the synthesiser records and finishes at once. */
const STUBS = (secs) => {
  window.__TLVI_TEST__ = { answerSecs: secs };
  window.__spoken = [];
  let sayVal = '';
  Object.defineProperty(window, '__say', { configurable: true, get: () => sayVal, set: (v) => { sayVal = v; window.__sayPending = !!v; } });
  window.__srStarts = 0;
  function Utt(text) { this.text = text; }
  window.SpeechSynthesisUtterance = Utt;
  const synth = {
    speaking: false, pending: false, paused: false,
    speak(u) { window.__spoken.push(String(u.text || '')); setTimeout(() => { if (typeof u.onend === 'function') u.onend(); }, 15); },
    cancel() {}, pause() {}, resume() {}, getVoices() { return []; }, addEventListener() {},
  };
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, get: () => synth });
  class FakeRecognition {
    constructor() { this.lang = ''; this.continuous = false; this.interimResults = false; this._t = []; }
    start() {
      window.__srStarts += 1;
      /* A continuous recogniser: whatever the test sets in window.__say is
         "heard" once - an interim half first, then the whole as a final
         result - whether it was set before this started or while it runs. */
      const res = (idx, finals, interim) => {
        const results = finals.map((t) => { const r = [{ transcript: t, confidence: 0.9 }]; r.isFinal = true; return r; });
        if (interim) { const r = [{ transcript: interim, confidence: 0.9 }]; r.isFinal = false; results.push(r); }
        return { resultIndex: idx, results };
      };
      const finals = [];
      this._i = setInterval(() => {
        if (!window.__sayPending || !window.__say) return;
        window.__sayPending = false;
        const say = String(window.__say), words = say.split(' ');
        const idx = finals.length;
        if (this.onresult) this.onresult(res(idx, finals, words.slice(0, Math.ceil(words.length * 0.6)).join(' ')));
        this._t.push(setTimeout(() => { finals.push(say); if (this.onresult) this.onresult(res(idx, finals, '')); }, 450));
      }, 120);
    }
    stop() { this._t.forEach(clearTimeout); clearInterval(this._i); }
    abort() { this._t.forEach(clearTimeout); clearInterval(this._i); }
  }
  window.SpeechRecognition = FakeRecognition;
  window.webkitSpeechRecognition = FakeRecognition;
};

const MEDIA_ARGS = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'];
const browser = await chromium.launch({ args: MEDIA_ARGS });
const errors = [];
const watch = (page, tag) => {
  page.on('pageerror', (e) => errors.push(`${tag}: ${String(e.message).slice(0, 200)}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|net::ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|fonts\.g|mediapipe/.test(m.text())) {
      errors.push(`${tag} console: ${m.text().slice(0, 200)}`);
    }
  });
};
const ready = (page) => page.waitForFunction(() => window.TL && TL.ready === true, null, { timeout: 30000 });
const text = (page, sel) => page.evaluate((q) => (document.querySelector(q) || {}).textContent || '', sel);

/* ---- a job, from the recruiter ---------------------------------------- */
const rb = await browser.newContext();
const rp = await rb.newPage();
watch(rp, 'recruiter');
await rp.goto(BASE + '#/');
await ready(rp);
const jobTitle = `Talent Sourcer ${s}`;
const jobId = await rp.evaluate(async ({ e, pw, t }) => {
  await TL.api.post('/auth/login', { email: e, password: pw, role: 'recruiter' });
  const boot = await TL.api.get('/bootstrap');
  const me = (boot.data.recruiters || []).find((r) => r.id === boot.session.id) || {};
  const j = await TL.api.post('/jobs', { title: t, companyId: me.companyId, location: 'Hyderabad', mode: 'Onsite', exp: '1-3 yrs',
    pay: '₹4 LPA', salaryMin: 4, salaryMax: 4, type: 'Full-time', status: 'open', skills: ['Sourcing', 'ATS', 'Excel'],
    desc: 'Verification job - safe to delete.' });
  try { await TL.api.put(`/jobs/${j.job.id}/screening-questions`, { questions: [] }); } catch (x) { /* optional */ }
  return j.job.id;
}, { e: RECRUITER, pw: PW, t: jobTitle });

/* ---- the candidate ------------------------------------------------------ */
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ['camera', 'microphone'] });
await ctx.addInitScript(STUBS, SECS);
const p = await ctx.newPage();
watch(p, 'candidate');
await p.goto(BASE + '#/');
await ready(p);
const email = `video.${s}@tl-verify.test`;
const cpw = `Video${s}9x`;
await p.evaluate(async ({ email, cpw, jobId }) => {
  await TL.api.post('/auth/register', { name: 'Vidya Verify', email, password: cpw,
    phone: '9' + String(Math.floor(1e8 + Math.random() * 9e8)), preferredLocation: 'Hyderabad', expectedCtc: 4,
    noticePeriod: 'Immediate', preferredWorkModes: ['Hybrid'] });
  await TL.api.post('/applications', { jobId });
}, { email, cpw, jobId });
await p.goto('about:blank');
await p.goto(BASE + '#/candidate/home');
await ready(p);
await p.waitForFunction(() => window.STATE && STATE.session && STATE.session.role === 'candidate', null, { timeout: 20000 });
await p.waitForTimeout(1500);
const ref = await p.evaluate(async (jobId) => {
  await TL.refresh(); TL.ensureLocalRecords();
  const a = DATA.applications.find((x) => x.jobId === jobId && x.candidateId === STATE.session.id);
  const f = TL.aiivRec(a.id);
  return f && f.rec ? f.rec.applicationId : a.id;
}, jobId);
await p.evaluate(() => document.querySelectorAll('.tlpo-ov .tlpo-btn.ghost, .tlpo-ov .tlpo-skip').forEach((x) => x.click()));
await p.evaluate((r) => { location.hash = '#/ai-interview/' + r; }, ref);
await p.waitForTimeout(1500);

/* Keyboard-only: Tab until the control is focused, then press Enter. */
async function tabTo(page, rx, max = 220) {
  for (let i = 0; i < max; i++) {
    const hit = await page.evaluate((src) => {
      const a = document.activeElement;
      const label = a ? ((a.getAttribute && a.getAttribute('aria-label')) || a.textContent || '') : '';
      return a && a.tagName === 'BUTTON' && new RegExp(src, 'i').test(label.replace(/\s+/g, ' '));
    }, rx.source);
    if (hit) return true;
    await page.keyboard.press('Tab');
  }
  return false;
}
const phase = (page) => page.evaluate(() => (document.querySelector('.tlvi') || {}).dataset ? document.querySelector('.tlvi')?.dataset.phase : null);
const qLine = (page) => text(page, '#tlviQn');
const waitListening = (page, ms = 8000) => page.waitForFunction(() => window.AIIV && AIIV.listening === true, null, { timeout: ms });

console.log(`\nAI video interview  (${BASE})`);

await check('keyboard: the interview starts and the camera is turned on without a mouse', async () => {
  await p.evaluate(() => { document.activeElement && document.activeElement.blur && document.activeElement.blur(); });
  must(await tabTo(p, /Start AI Video Interview/), 'could not Tab to Start');
  await p.keyboard.press('Enter');
  await p.waitForSelector('.tlvi[data-phase="check"]', { timeout: 8000 });
  must(await tabTo(p, /Turn on camera and microphone/), 'could not Tab to the camera button');
  const ring = await p.evaluate(() => { const cs = getComputedStyle(document.activeElement); return cs.outlineStyle + ' ' + cs.outlineWidth; });
  must(/solid 3px/.test(ring), `no visible focus ring (${ring})`);
  await p.keyboard.press('Enter');
});

await check('device check: camera, microphone and internet pass; the video is mirrored', async () => {
  await p.waitForFunction(() => {
    const ck = [...document.querySelectorAll('.tlvi-check')].map((x) => x.dataset.state);
    return ck[0] === 'ok' && ck[2] === 'ok';
  }, null, { timeout: 15000 });
  await p.waitForFunction(() => [...document.querySelectorAll('.tlvi-check')][1].dataset.state === 'ok', null, { timeout: 15000 })
    .catch(() => { throw new Error('the microphone check never heard the fake microphone'); });
  await p.waitForFunction(() => { const el = document.getElementById('aiivVideo'); return el && el.videoWidth > 0; }, null, { timeout: 10000 });
  const v = await p.evaluate(() => {
    const el = document.getElementById('aiivVideo');
    const cs = getComputedStyle(el);
    return { t: cs.transform, fit: cs.objectFit, live: !!(el.srcObject && el.srcObject.getVideoTracks()[0].readyState === 'live'),
      w: el.videoWidth, onCam: /You are on camera/.test(document.body.textContent) };
  });
  must(/^matrix\(-1, 0, 0, 1/.test(v.t), `not mirrored: ${v.t}`);
  must(v.fit === 'cover', `object-fit ${v.fit}`);
  must(v.live && v.w > 0, 'no live camera picture');
  must(v.onCam, 'no "You are on camera"');
  must(await p.evaluate(() => getComputedStyle(document.getElementById('tlviCamOff')).display === 'none'),
    'the camera-off avatar is drawn over the live picture');
  must(/Internet/.test(await text(p, '.tlvi-checklist')) && /Connected/.test(await text(p, '.tlvi-checklist')), 'internet check');
  await shot(p, '1-device-check-1280');
});

let interviewId = null;

await check('keyboard: briefing and the first question', async () => {
  must(await tabTo(p, /Continue to the briefing/), 'could not Tab to Continue');
  await p.keyboard.press('Enter');
  await p.waitForSelector('.tlvi[data-phase="briefing"]', { timeout: 8000 });
  must(/Hello Vidya/.test(await text(p, '#aiivCaption')), 'the greeting does not use the candidate\'s name');
  await p.waitForFunction(() => window.__spoken.some((x) => /Hello Vidya/.test(x)), null, { timeout: 5000 }).catch(() => { throw new Error('the greeting was not spoken'); });
  must(await tabTo(p, /Start the questions/), 'could not Tab to start the questions');
  await p.keyboard.press('Enter');
  await p.waitForSelector('.tlvi[data-phase="interview"]', { timeout: 15000 });
  interviewId = await p.evaluate(() => TL.__aiivSession && TL.__aiivSession.interviewId);
  must(interviewId, 'no server session');
});

await check('layout at 1280: header, 50/50 camera | AI panel (gap 16, min height 400), transcript, controls', async () => {
  await p.evaluate(() => { window.__say = 'At my last job I sourced 40 candidates on LinkedIn for a client project, and we closed 6 hires in a month.'; });
  await waitListening(p);
  const g = await p.evaluate(() => {
    const r = (q) => document.querySelector(q).getBoundingClientRect();
    const cam = r('.tlvi-cam'), ai = r('.tlvi-ai'), tr = r('.tlvi-tr'), ctl = r('.tlvi-controls'), main = r('.tlvi-main'), head = r('.tlvi-head');
    const btns = [...document.querySelectorAll('.tlvi-controls .tlvi-btn')];
    const span = [Math.min(...btns.map((b) => b.getBoundingClientRect().left)), Math.max(...btns.map((b) => b.getBoundingClientRect().right))];
    const cs = getComputedStyle(document.querySelector('.tlvi'));
    return { cam, ai, tr, ctl, main, head, span,
      round: getComputedStyle(document.querySelector('.tlvi-round')).textTransform,
      roundText: document.querySelector('.tlvi-round').textContent,
      font: cs.fontFamily, bg: cs.backgroundColor, color: cs.color,
      primary: getComputedStyle(document.querySelector('#tlviSubmit')).backgroundColor,
      danger: getComputedStyle(document.querySelector('#tlviEnd')).borderTopColor,
      camBg: getComputedStyle(document.querySelector('.tlvi-cam')).backgroundColor,
      radius: getComputedStyle(document.querySelector('.tlvi-cam')).borderTopLeftRadius,
      qSize: getComputedStyle(document.querySelector('.tlvi-q')).fontSize,
      timer: document.getElementById('tlviTime').textContent,
      small: btns.filter((b) => b.getBoundingClientRect().height < 44 || b.getBoundingClientRect().width < 44).length,
      unlabelled: btns.filter((b) => !b.getAttribute('aria-label')).length,
      live: document.getElementById('aiivTranscript').getAttribute('aria-live'),
      maxH: getComputedStyle(document.getElementById('aiivTranscript')).maxHeight,
      labels: btns.map((b) => b.getAttribute('aria-label')) };
  });
  must(Math.abs(g.cam.width - g.ai.width) <= 1, `columns ${g.cam.width} / ${g.ai.width}`);
  must(Math.abs(g.ai.left - g.cam.right - 16) <= 1, `gap ${g.ai.left - g.cam.right}`);
  must(g.cam.height >= 400 && g.ai.height >= 400, `heights ${g.cam.height} / ${g.ai.height}`);
  must(g.head.bottom <= g.main.top && g.tr.top >= g.main.bottom && g.ctl.top >= g.tr.bottom, 'order: header, main, transcript, controls');
  must(Math.abs(g.tr.width - g.main.width) <= 1, 'the transcript is not full width');
  const mid = (g.span[0] + g.span[1]) / 2;
  must(Math.abs(mid - (g.ctl.left + g.ctl.width / 2)) <= 3, 'the controls are not centred');
  must(g.round === 'uppercase' && /Introduction|round/i.test(g.roundText), `round label ${g.round} "${g.roundText}"`);
  must(/^Question 1 of \d+$/.test(await qLine(p)), await qLine(p));
  must(/^00:\d\d$/.test(g.timer), `timer ${g.timer}`);
  must(/^"?DM Sans/.test(g.font), `font ${g.font}`);
  must(g.bg === 'rgb(243, 244, 248)' && g.color === 'rgb(21, 25, 43)', `colours ${g.bg} ${g.color}`);
  must(g.primary === 'rgb(91, 47, 201)', `primary ${g.primary}`);
  must(g.danger === 'rgb(179, 38, 30)', `destructive ${g.danger}`);
  must(g.camBg === 'rgb(16, 21, 36)' && g.radius === '16px', `camera panel ${g.camBg} ${g.radius}`);
  must(parseFloat(g.qSize) >= 24, `question size ${g.qSize}`);
  must(g.small === 0, `${g.small} control(s) under 44px`);
  must(g.unlabelled === 0, 'a control has no aria-label');
  must(g.labels.join('|') === 'Mute microphone|Turn off camera|Submit answer|End interview', g.labels.join('|'));
  must(g.live === 'polite' && g.maxH === '150px', `transcript aria-live=${g.live} max-height=${g.maxH}`);
});

await check('the mic level bar moves with the microphone', async () => {
  const seen = new Set();
  for (let i = 0; i < 25; i++) {
    seen.add(await p.evaluate(() => document.getElementById('aiivLevel').style.transform));
    await p.waitForTimeout(80);
  }
  const vals = [...seen].map((t) => Number((/scaleX\(([\d.]+)\)/.exec(t) || [])[1] || 0));
  must(vals.length > 3 && Math.max(...vals) > 0.02, `levels ${vals.slice(0, 8).join(',')}`);
});

await check('transcript: AI and You lines, the live caption, then the final words', async () => {
  const lines = await p.evaluate(() => [...document.querySelectorAll('#aiivTranscript .tlvi-line')].map((l) => ({
    who: l.querySelector('.tlvi-who').textContent, t: l.querySelector('.tlvi-txt').textContent, live: l.classList.contains('is-live') })));
  must(lines[0] && lines[0].who === 'AI' && lines[0].t === (await text(p, '#aiivCaption')), 'the question is not the first AI line');
  await p.waitForFunction(() => /we closed 6 hires/.test((document.querySelector('#aiivTranscript .tlvi-line.you') || {}).textContent || ''), null, { timeout: 5000 });
  must(await p.evaluate(() => /Live caption/.test(document.getElementById('aiivTranscript').textContent)), 'the caption is not marked live');
});

await check(`timer: amber in the last 10 s, and the answer is submitted for the candidate at 0 (test timer ${SECS} s)`, async () => {
  await p.waitForFunction(() => { const t = document.getElementById('tlviTime'); return t && Number(t.textContent.split(':')[1]) <= 10; }, null, { timeout: 8000 });
  const warn = await p.evaluate(() => { const el = document.getElementById('aiivTimer'); return { c: el.className, bg: getComputedStyle(el).backgroundColor }; });
  must(/is-warn/.test(warn.c) && warn.bg === 'rgb(255, 244, 222)', `not amber: ${warn.c} ${warn.bg}`);
  await shot(p, '2-interview-1280-amber');
  await p.waitForFunction(() => /^Question 2 of/.test((document.getElementById('tlviQn') || {}).textContent || ''), null, { timeout: 20000 });
  must(!(await p.evaluate(() => /Follow-up/.test(document.querySelector('.tlvi-q').textContent))), 'a concrete answer drew a follow-up');
});

await check('Submit early (Enter on the focused button), then ONE follow-up on the same question', async () => {
  await p.evaluate(() => { window.__say = 'Yes I can.'; });
  await waitListening(p);
  await p.waitForTimeout(900);
  await p.focus('#tlviSubmit');
  await p.keyboard.press('Enter');
  await p.waitForFunction(() => /Follow-up/.test((document.querySelector('.tlvi-q') || {}).textContent || ''), null, { timeout: 10000 });
  must(/^Question 2 of/.test(await qLine(p)), 'the follow-up moved to another question');
  must((await text(p, '#aiivCaption')) === 'Could you share a specific example?', await text(p, '#aiivCaption'));
  must(/Follow-up to question 2/.test(await text(p, '#tlviAsking')), 'the AI panel does not say follow-up');
  await shot(p, '3-follow-up');
  await p.evaluate(() => { window.__say = 'Last year I used our ATS and LinkedIn to fill a warehouse drive, and we hired 12 people in two weeks.'; });
  await waitListening(p);
  await p.waitForTimeout(900);
  await p.click('#tlviSubmit');
  await p.waitForFunction(() => /^Question 3 of/.test((document.getElementById('tlviQn') || {}).textContent || '')
    && !/Follow-up/.test(document.querySelector('.tlvi-q').textContent), null, { timeout: 10000 });
});

await check('the transcript auto-scrolls to the newest line', async () => {
  await p.waitForFunction(() => document.querySelectorAll('#aiivTranscript .tlvi-line').length >= 7, null, { timeout: 8000 }).catch(() => {});
  await p.waitForTimeout(400);
  const sc = await p.evaluate(() => { const b = document.getElementById('aiivTranscript'); return { h: b.scrollHeight, c: b.clientHeight, t: b.scrollTop }; });
  must(sc.h > sc.c, `not enough lines to scroll (${sc.h}/${sc.c})`);
  must(sc.t + sc.c >= sc.h - 4, `not at the bottom (${sc.t}+${sc.c} of ${sc.h})`);
});

await check('offline: "Reconnecting", the timer stops, then the SAME question resumes with the words kept', async () => {
  await p.evaluate(() => { window.__say = 'Before the drop I was explaining Boolean search strings'; });
  await waitListening(p);
  await p.waitForTimeout(1200);
  await ctx.setOffline(true);
  await p.waitForSelector('.tlvi-banner', { timeout: 5000 });
  must(/Reconnecting/.test(await text(p, '.tlvi-banner')), 'no Reconnecting banner');
  must(await p.evaluate(() => AIIV.listening === false && AIIV.paused === true), 'the answer did not pause');
  await shot(p, '4-reconnecting');
  await p.evaluate(() => { window.__say = 'and after it I finished: we filled the role in nine days.'; });
  await p.waitForTimeout(1500);
  await ctx.setOffline(false);
  await p.waitForFunction(() => !document.querySelector('.tlvi-banner'), null, { timeout: 20000 });
  must(/^Question 3 of/.test(await qLine(p)), `resumed on ${await qLine(p)}`);
  await waitListening(p, 10000);
  must(/We are back/.test(await text(p, '#aiivTranscript')), 'no "We are back" line');
  must(/Boolean search strings/.test(await text(p, '#aiivTranscript')), 'the words before the drop were lost');
  await p.waitForTimeout(1000);
  await p.click('#tlviSubmit');
  await p.waitForFunction(() => /^Question 4 of/.test((document.getElementById('tlviQn') || {}).textContent || ''), null, { timeout: 15000 });
});

await check('layout at 390: camera, question, transcript, controls stacked; controls sticky; no sideways scroll', async () => {
  await p.setViewportSize({ width: 390, height: 844 });
  await p.waitForTimeout(400);
  await p.evaluate(() => window.scrollTo(0, 0));
  await p.waitForTimeout(200);
  const g = await p.evaluate(() => {
    const r = (q) => document.querySelector(q).getBoundingClientRect();
    const ctl = document.querySelector('.tlvi-controls');
    return { cam: r('.tlvi-cam'), ai: r('.tlvi-ai'), tr: r('.tlvi-tr'), ctl: r('.tlvi-controls'),
      pos: getComputedStyle(ctl).position, bottom: getComputedStyle(ctl).bottom, vh: innerHeight,
      sw: document.documentElement.scrollWidth, vw: innerWidth,
      small: [...document.querySelectorAll('.tlvi-controls .tlvi-btn')].filter((b) => b.getBoundingClientRect().height < 44).length };
  });
  must(g.cam.top < g.ai.top && g.ai.top < g.tr.top && g.tr.top < g.ctl.top + 2000, 'not stacked in order');
  must(Math.abs(g.cam.width - g.ai.width) <= 1, 'camera and question are not the same width');
  must(g.pos === 'sticky' && g.bottom === '0px', `controls ${g.pos} bottom ${g.bottom}`);
  must(g.ctl.bottom <= g.vh + 1 && g.ctl.top < g.vh, `controls not on screen (${g.ctl.top}-${g.ctl.bottom} of ${g.vh})`);
  must(g.sw <= g.vw + 1, `sideways scroll ${g.sw} > ${g.vw}`);
  must(g.small === 0, 'a control is under 44px on a phone');
  await shot(p, '5-interview-390');
  await p.setViewportSize({ width: 1280, height: 900 });
  await p.waitForTimeout(300);
});

await check('End interview: a confirmation that Escape cancels; confirming submits; no score is shown', async () => {
  await p.evaluate(() => { window.__say = 'I keep a tracker in Excel for every requisition and update it daily.'; });
  await waitListening(p);
  await p.waitForTimeout(900);
  await p.click('#tlviEnd');
  await p.waitForSelector('.tlvi-dialog[role="alertdialog"]', { timeout: 4000 });
  must(/Keep going/.test(await p.evaluate(() => document.activeElement.textContent)), 'the safe choice is not focused');
  await p.keyboard.press('Escape');
  await p.waitForTimeout(300);
  must(!(await p.$('.tlvi-dialog')), 'Escape did not close the dialog');
  must(await p.evaluate(() => AIIV.phase === 'interview'), 'cancelling ended the interview');
  await p.focus('#tlviEnd');
  await p.keyboard.press('Enter');
  await p.waitForSelector('.tlvi-dialog', { timeout: 4000 });
  await p.keyboard.press('Tab');
  must(/End interview/.test(await p.evaluate(() => document.activeElement.textContent)), 'Tab did not reach End interview');
  await p.keyboard.press('Enter');
  await p.waitForSelector('.tlvi[data-phase="done"]', { timeout: 30000 });
  const done = await text(p, '.tlvi-done');
  must(/Your interview is complete/.test(done) && /What happens next/.test(done), done.slice(0, 120));
  must(!/\d+\s*%|score|rank|shortlist|reject/i.test(done), `the candidate is shown a result: ${done}`);
  must(await p.evaluate(() => window.__spoken.filter((x) => /interview is complete/i.test(x)).length === 1), 'the thank-you was not said once');
  await p.waitForFunction(() => window.TLVI.uploads.pending() === 0, null, { timeout: 60000 });
  await shot(p, '6-complete');
});

await check('on the server: completed, the transcript per question, recordings linked to candidate and job', async () => {
  const mine = await p.evaluate(async (id) => {
    const list = await TL.api.get('/ai-interviews');
    const recs = await TL.api.get(`/ai-interviews/${id}/recordings`);
    return { iv: (list.aiInterviews || []).find((x) => x.id === id), recs: recs.recordings, cand: STATE.session.id };
  }, interviewId);
  must(mine.iv && mine.iv.status === 'completed', `status ${mine.iv && mine.iv.status}`);
  const r = mine.recs;
  must(r.length >= 4, `${r.length} recordings: ${r.map((x) => x.seq + x.part).join(',')}; failed uploads: ${JSON.stringify(await p.evaluate(() => TLVI.uploads.failed()))}`);
  must(r.every((x) => x.candidateId === mine.cand && x.jobId === jobId && x.interviewId === interviewId && x.size > 0), 'a recording is not linked right');
  must(r.some((x) => x.seq === 2 && x.part === 'followup'), `the follow-up answer has no recording (have ${r.map((x) => x.seq + x.part).join(',')}; failed ${JSON.stringify(await p.evaluate(() => TLVI.uploads.failed()))})`);
  must(r.some((x) => x.seq === 3), 'the question answered across the drop has no recording');

  const staff = await rp.evaluate(async ({ id, cand }) => {
    const list = await TL.api.get(`/ai-interviews?candidateId=${encodeURIComponent(cand)}`);
    const iv = (list.aiInterviews || []).find((x) => x.id === id);
    const recs = await TL.api.get(`/ai-interviews/${id}/recordings`);
    const f = await fetch(TL.apiBase + recs.recordings[0].url.replace(/^\/api/, ''), { credentials: 'include' });
    return { per: iv ? iv.perQuestion : [], n: recs.recordings.length, type: f.headers.get('content-type'), size: (await f.arrayBuffer()).byteLength };
  }, { id: interviewId, cand: mine.cand });
  must(staff.n === r.length, 'the job\'s recruiter cannot list the recordings');
  must(/^video\/(webm|mp4)/.test(staff.type) && staff.size > 1000, `recording file ${staff.type} ${staff.size}`);
  const q3 = staff.per.find((x) => x.seq === 3) || {};
  must(/Boolean search strings/.test(q3.answerSummary || '') && /nine days/.test(q3.answerSummary || ''),
    `the answer across the drop: ${q3.answerSummary}`);
  const q2 = staff.per.find((x) => x.seq === 2) || {};
  must(/Yes I can/.test(q2.answerSummary || '') && /hired 12 people/.test(q2.answerSummary || ''), `q2 ${q2.answerSummary}`);
});

/* ---- permission denied, in a browser that does not grant it ------------ */
/* The browser refuses the camera: getUserMedia rejects with NotAllowedError, exactly as it does when the
   person clicks Block, until window.__denyMedia is cleared (which is what allowing it in the settings does). */
const dctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce', permissions: ['camera', 'microphone'] });
await dctx.addInitScript(() => {
  window.__denyMedia = true;
  if (!navigator.mediaDevices) return;
  const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = (c) => (window.__denyMedia
    ? Promise.reject(new DOMException('Permission denied', 'NotAllowedError')) : real(c));
});
await dctx.addInitScript(STUBS, SECS);
const d = await dctx.newPage();
watch(d, 'denied');

await check('permission denied: help with steps and Retry; Retry works once allowed; reduced motion respected', async () => {
  await d.goto(BASE + '#/');
  await ready(d);
  await d.evaluate(async ({ email, cpw, recruiterJob }) => {
    await TL.api.post('/auth/login', { email, password: cpw, role: 'candidate' });
    void recruiterJob;
  }, { email, cpw, recruiterJob: jobId });
  // a second application, so there is an interview still to take
  const job2 = await rp.evaluate(async (t) => {
    const boot = await TL.api.get('/bootstrap');
    const me = (boot.data.recruiters || []).find((r) => r.id === boot.session.id) || {};
    const j = await TL.api.post('/jobs', { title: t, companyId: me.companyId, location: 'Hyderabad', mode: 'Onsite', exp: '1-3 yrs',
      pay: '₹4 LPA', salaryMin: 4, salaryMax: 4, type: 'Full-time', status: 'open', skills: ['Excel'], desc: 'Verification job - safe to delete.' });
    try { await TL.api.put(`/jobs/${j.job.id}/screening-questions`, { questions: [] }); } catch (x) { /* optional */ }
    return j.job.id;
  }, `Recruitment Coordinator ${s}`);
  await d.evaluate((j) => TL.api.post('/applications', { jobId: j }), job2);
  await d.goto('about:blank');
  await d.goto(BASE + '#/candidate/home');
  await ready(d);
  await d.waitForFunction(() => window.STATE && STATE.session, null, { timeout: 20000 });
  await d.waitForTimeout(1500);
  const ref2 = await d.evaluate(async (j) => {
    await TL.refresh(); TL.ensureLocalRecords();
    const a = DATA.applications.find((x) => x.jobId === j && x.candidateId === STATE.session.id);
    const f = TL.aiivRec(a.id);
    return f && f.rec ? f.rec.applicationId : a.id;
  }, job2);
  await d.evaluate(() => document.querySelectorAll('.tlpo-ov .tlpo-btn.ghost, .tlpo-ov .tlpo-skip').forEach((x) => x.click()));
  await d.evaluate((r) => { location.hash = '#/ai-interview/' + r; }, ref2);
  await d.waitForTimeout(1200);
  await d.evaluate((r) => window.aiivStart(r), ref2);
  await d.waitForSelector('.tlvi[data-phase="check"]');
  await d.click('.tlvi-actions .tlvi-btn.primary');
  await d.waitForSelector('.tlvi-help', { timeout: 10000 });
  const help = await text(d, '.tlvi-help');
  must(/blocked|could not be started|in use|not found/i.test(help), help.slice(0, 120));
  must(await d.evaluate(() => document.querySelectorAll('.tlvi-help ol li').length >= 3), 'no step-by-step instructions');
  must(/Retry/.test(await text(d, '.tlvi-actions')), 'no Retry');
  must(await d.evaluate(() => document.querySelector('.tlvi-check').dataset.state === 'fail'), 'the camera check did not fail');
  await shot(d, '7-permission-denied');
  await d.evaluate(() => { window.__denyMedia = false; });
  await d.click('.tlvi-actions .tlvi-btn.primary');
  await d.waitForFunction(() => document.querySelector('.tlvi-check') && document.querySelector('.tlvi-check').dataset.state === 'ok', null, { timeout: 10000 })
    .catch(() => { throw new Error('Retry did not turn the camera on after permission was granted'); });
  must(!(await d.$('.tlvi-help')), 'the help stayed after Retry worked');
  const motion = await d.evaluate(() => getComputedStyle(document.getElementById('aiivLevel')).transitionDuration);
  must(motion === '0s', `transition under reduced motion: ${motion}`);
});

await check('no page errors', async () => {
  must(errors.length === 0, errors.slice(0, 4).join(' | '));
});

await browser.close();
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
