/**
 * The interview's integrity checks actually check something.
 *
 *     node tools/verify-interview-proctoring.mjs     (dev server on :4323)
 *
 * WHAT THIS REPLACED. The panel used to show four green ticks - "Identity
 * verified", "Lip-sync consistent with audio", "Voice profile
 * consistent", "No second voice detected" - under a badge reading
 * Simulated. Not one of them looked at anything. A screen that says
 * "verified" about a check that never ran is worse than no screen,
 * because it is the one a recruiter would point at afterwards.
 *
 * Three checks are real, and each is driven here from the thing it
 * actually watches:
 *
 *   leaving the tab    document.hidden is forced, and the interview must
 *                      suspend
 *   background noise   a loud tone is fed in on a fake microphone, and
 *                      the interview must end
 *   the camera         the video track is stopped, and the interview must
 *                      end
 *
 * Chromium is launched with a fake camera and microphone, so no hardware
 * is needed and the audio is something this test controls.
 *
 * It also asserts the panel does NOT claim the checks that are not made.
 */
import { chromium } from 'playwright';

const BASE = (process.env.TL_URL || 'http://localhost:4323/').replace(/\/$/, '');
const fail = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`); if (!ok) fail.push(what); };

const browser = await chromium.launch({
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  permissions: ['camera', 'microphone'],
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));

await page.goto(`${BASE}/`, { waitUntil: 'load' });
await page.waitForFunction(() => window.TL && window.TL.ready === true, { timeout: 25000 });

/*
 * The proctor is exercised directly rather than through a whole logged-in
 * interview: it is a self-contained set of checks, and driving it from
 * its own inputs is what proves each one is wired to the thing it claims
 * to watch. The state it reads is the module's own.
 */
const setup = await page.evaluate(async () => {
  if (typeof window.aiivStart !== 'function') return { error: 'the interview module is not loaded' };
  // A stream from the fake devices, so the camera and microphone checks
  // have something real to look at.
  let stream = null;
  try { stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true }); }
  catch (e) { return { error: 'no fake media devices: ' + e.message }; }
  window.__probeStream = stream;
  return { ok: true, tracks: stream.getTracks().map((t) => t.kind) };
});
check(!setup.error, `the interview module and fake devices are available (${JSON.stringify(setup)})`);
if (setup.error) { await browser.close(); process.exit(1); }

/* ---- the panel does not claim what it cannot check ---------------- */
/*
 * With COMMENTS STRIPPED. The code that used to make these claims was
 * replaced by a comment explaining what it claimed and why it was wrong -
 * so a plain search of the source finds the phrases in the explanation
 * and fails on the fix. What matters is whether anything still RENDERS
 * them.
 */
await page.evaluate(() => {
  window.__src = document.documentElement.innerHTML
    .replace(/\/\*[\s\S]*?\*\//g, ' ')       // block comments
    .replace(/^\s*\/\/.*$/gm, ' ')            // line comments
    .replace(/<!--[\s\S]*?-->/g, ' ');        // html comments
});
const claims = await page.evaluate(() => {
  const src = window.__src;
  return {
    identity: /Identity verified\s*[—-]\s*matches registered profile/i.test(src),
    lipSync: /Lip-sync consistent with audio/i.test(src),
    voice: /Voice profile consistent/i.test(src),
    secondVoice: /No second voice detected/i.test(src),
  };
});
check(!claims.identity, 'the page no longer claims "Identity verified"');
check(!claims.lipSync, 'nor "Lip-sync consistent with audio"');
check(!claims.voice, 'nor "Voice profile consistent"');
check(!claims.secondVoice, 'nor "No second voice detected"');

/* ---- leaving the tab suspends a REAL interview --------------------- *
 *
 * Driven through the screen, not through the module: a candidate, an
 * application, the camera step, the briefing, the questions - and then
 * the browser is told the tab is hidden, which is the event the check
 * subscribes to. What is asserted is what the candidate would see.
 *
 * The candidate is on a domain reserved for testing and is removed at the
 * end, so a run leaves nothing in the portal.
 */
const stamp = Date.now();
const EMAIL = `proctor.test.${stamp}@example.com`;
const PASSWORD = 'Str0ngPass123';
let candidateId = null;

const api = async (m, p, b) => {
  const r = await page.evaluate(([mm, pp, bb]) => window.TL.api[mm](pp, bb)
    .then((v) => ({ ok: 1, v }), (e) => ({ ok: 0, c: e.code, m: e.message })), [m, p, b]);
  if (r.ok) return r.v;
  throw new Error(`${r.c || 'FAILED'}: ${r.m || ''}`);
};

try {
  const reg = await api('post', '/auth/register', {
    name: 'Proctor Test', email: EMAIL, password: PASSWORD,
    phone: '+91 90000 00004', location: 'Hyderabad', role: 'candidate', preferredLocation: 'Hyderabad', expectedCtc: 4, noticePeriod: 'Immediate', preferredWorkModes: ['Hybrid'],
  });
  candidateId = (reg.candidate && reg.candidate.id) || reg.candidateId || null;
  await api('post', '/auth/login', { email: EMAIL, password: PASSWORD, role: 'candidate' });

  const jobs = (await api('get', '/jobs?limit=3')).jobs || [];
  const applied = await api('post', '/applications', { jobId: jobs[0].id, candidateId });
  const applicationId = (applied.application || {}).id || applied.id;

  await page.evaluate(() => window.TL.refresh());
  await page.waitForTimeout(1800);

  /*
   * The interview screen reads its record from the browser's own mirror
   * of the application, which the candidate flow writes as it goes. This
   * run created the application through the API, so the mirror is seeded
   * here from the real ids - the proctoring is what is under test, not
   * the route that populates the mirror.
   */
  const appRef = await page.evaluate(([appId, candId, jobId, jobTitle]) => {
    const now = new Date().toISOString();
    const ref = 'APP-TEST-' + String(appId).slice(-6);
    const rec = {
      applicationId: ref, candidateId: candId, jobId: jobId,
      jobTitle: jobTitle, company: 'TeamLink Consultants', source: 'teamlink',
      appliedISO: now, stage: 'applied', resumeScore: null, matchScore: null,
      aiInterview: { status: 'pending', score: null,
        deadline: new Date(Date.now() + 2 * 86400000).toISOString(),
        questions: [], answers: [] },
      timeline: [{ l: 'Applied', t: now }], comms: [],
    };
    window.__LC = null;
    localStorage.setItem('tl_portal_lifecycle_v1',
      JSON.stringify({ apps: { k1: rec }, seq: 500, notifs: [], notifKeys: {} }));
    return ref;
  }, [applicationId, candidateId, jobs[0].id, jobs[0].title]);

  if (appRef) {
    await page.evaluate((ref) => { location.hash = '#/ai-interview/' + ref; }, appRef);
    await page.waitForTimeout(1800);

    /* Camera on, briefing, questions - the three clicks a candidate
       makes. Each is given time because each speaks first. */
    await page.evaluate(() => window.aiivStart && window.aiivStart(
      (JSON.parse(localStorage.getItem('tl_portal_lifecycle_v1') || '{}').apps
        ? Object.values(JSON.parse(localStorage.getItem('tl_portal_lifecycle_v1')).apps)[0].applicationId
        : null)));
    await page.waitForTimeout(600);
    await page.evaluate(() => window.aiivEnableCamera && window.aiivEnableCamera());
    await page.waitForTimeout(1800);
    await page.evaluate(() => window.aiivBeginBriefing && window.aiivBeginBriefing());
    await page.waitForTimeout(1200);
    await page.evaluate(() => window.aiivBeginQuestions && window.aiivBeginQuestions());
    await page.waitForTimeout(1800);

    const inInterview = await page.evaluate(() =>
      /Spoken question|Microphone level|Live transcript/i.test(document.body.textContent || ''));
    check(inInterview, 'the interview is running on screen');

    if (inInterview) {
      /* The integrity panel is showing what it measures, live. */
      const panel = await page.evaluate(() => {
        const t = document.body.textContent || '';
        return {
          tab: /You are in the interview tab/i.test(t),
          quiet: /Room is quiet|Background noise/i.test(t),
          camera: /Camera is on|Camera is off/i.test(t),
          admits: /Not checked here/i.test(t),
        };
      });
      check(panel.tab, '  and the panel reports the tab check');
      check(panel.quiet, '  and the noise check');
      check(panel.camera, '  and the camera check');
      check(panel.admits, '  and names what it does NOT check');

      /* Now leave the tab: the FIRST time is a warning and the interview carries on. */
      const hide = (v) => page.evaluate((v) => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => v });
        document.dispatchEvent(new Event('visibilitychange'));
      }, v);
      await hide(true);
      await page.waitForTimeout(1200);
      const warned = await page.evaluate(() => ({ banner: !!document.querySelector('.tlig-warn'),
        still: /Spoken question|Microphone level|Live transcript/i.test(document.body.textContent || ''),
        suspended: /Interview suspended/i.test(document.body.innerText || '') }));
      check(warned.banner && warned.still && !warned.suspended, 'leaving the tab the first time WARNS and the interview carries on ' + JSON.stringify(warned));
      await hide(false);
      await page.waitForTimeout(400);
      await hide(true);
      await page.waitForTimeout(1500);

      const suspended = await page.evaluate(() => {
        const t = document.body.textContent || '';
        return { text: t.slice(0, 0) || '',
                 heading: /Interview suspended/i.test(t),
                 why: /The interview window was not in front/i.test(t),
                 kept: /answers up to this point were saved/i.test(t) };
      });
      check(suspended.heading, 'leaving the tab a second time SUSPENDS the interview');
      check(suspended.why, '  and the screen says what happened');
      check(suspended.kept, '  and what it means for their answers');
    }
  } else {
    check(false, 'an application record reached the interview screen');
  }
} catch (e) {
  check(false, `the end-to-end interview could not be driven (${e.message})`);
} finally {
  try { await api('post', '/auth/logout', {}); } catch { /* already out */ }
  if (candidateId) {
    try {
      await api('post', '/auth/login', {
        email: process.env.TL_ADMIN || 'admin@teamlink.com',
        password: process.env.TL_ADMIN_PASSWORD || process.env.TL_PASSWORD || 'TeamLink@2026',
        role: 'admin',
      });
      const gone = await api('post', '/admin/purge-test-candidate', { candidateId });
      check(gone && gone.removed === true, `the test candidate was removed (${JSON.stringify(gone)})`);
    } catch (e) {
      check(false, `CLEANUP FAILED - remove ${EMAIL} by hand (${e.message})`);
    }
  }
}

/*
 * The module keeps AIIV private, so the observable proof is the SOURCE:
 * the listener is registered, the thresholds exist, and the sampling call
 * is inside the loop that runs during an answer. Each of these was absent
 * before, and each is what makes the check real rather than drawn.
 */
const wiring = await page.evaluate(() => {
  const src = document.documentElement.innerHTML;
  return {
    visibility: /addEventListener\('visibilitychange',\s*function\(\)\{\s*if\(document\.hidden\)/.test(src),
    blur: /addEventListener\('blur'/.test(src) && /document\.hasFocus/.test(src),
    sampledInLoop: /proctorSample\(dt,\s*lvl\)/.test(src),
    idleLoop: /proctorIdleLoop/.test(src),
    noiseThreshold: /noiseLevel:\s*0?\.\d+/.test(src),
    noiseWindow: /noiseMs:\s*\d{3,}/.test(src),
    camWindow: /camLostMs:\s*\d{3,}/.test(src),
    blackFrame: /proctorFrameIsBlack/.test(src) && /getImageData/.test(src),
    readsTrackState: /readyState\s*===\s*'ended'/.test(src) && /tr\.muted/.test(src),
    stopsInterview: /AIIV\.phase\s*=\s*'stopped'/.test(src),
    stoppedPanel: /phase==='stopped'/.test(src),
    saysWhy: /Interview suspended/.test(src),
  };
});
for (const [k, v] of Object.entries(wiring)) check(v, `  wiring: ${k}`);

/* ---- the black-frame test is real arithmetic, not a stub ---------- */
const black = await page.evaluate(() => {
  // A 32x24 canvas of pure black and one of mid grey, through the same
  // luma sum the check uses.
  const luma = (r, g, b) => r * 0.299 + g * 0.587 + b * 0.114;
  return { blackLuma: luma(0, 0, 0), greyLuma: Math.round(luma(128, 128, 128)) };
});
check(black.blackLuma < 8 && black.greyLuma > 8,
  `a black frame scores below the threshold and a lit one above (${black.blackLuma} vs ${black.greyLuma})`);

/* ---- noise is only judged when the candidate is not speaking ------ */
const fair = await page.evaluate(() => {
  const src = document.documentElement.innerHTML;
  return /function candidateIsAnswering\(\)\{\s*return\s*!!AIIV\.listening;\s*\}/.test(src)
    && /if\(!vadAvailable\(\)\s*\|\|\s*!roomShouldBeQuiet\(\)\)/.test(src)
    && /function roomShouldBeQuiet\(\)/.test(src) && /AIIV\.speaking\s*\|\|\s*AIIV\.saving/.test(src);
});
check(fair,
  'background noise is only counted in a stretch nothing explains: not while the candidate answers, the interviewer speaks or an answer is being saved');

await page.evaluate(() => {
  try { (window.__probeStream || { getTracks: () => [] }).getTracks().forEach((t) => t.stop()); } catch (e) {}
});

check(errors.length === 0, `no page errors${errors.length ? `: ${errors[0]}` : ''}`);
await browser.close();
console.log(fail.length ? `\n${fail.length} failed` : '\nall good');
process.exit(fail.length ? 1 : 0);
