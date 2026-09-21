/**
 * The candidate's journey, driven through the real controls.
 *
 *   register -> dashboard -> open a job -> Apply Now -> confirmation
 *   -> application history -> refresh -> still signed in, application still there
 *
 * Why this file exists
 * --------------------
 * The reported bug was that login and Apply Now showed
 * "You appear to be offline - check your connection" on a machine that was
 * plainly online. The message was a lie told by the transport layer: every
 * fetch rejection mapped to that one string. The real fault was that the
 * page had been opened from disk (file://), so there was no origin to call.
 *
 * Nothing already in this repo would have caught it. The API tests talk to
 * the API directly, the interaction test drives the UI but only over http,
 * and the UI snapshots compare appearance. So the second half of this file
 * simulates each way the transport can fail and asserts that the app says
 * which one it was - because a wrong diagnosis costs more than a failure.
 *
 *   node tools/verify-candidate-flow.mjs     (needs npm run dev on :4323)
 */
import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const BASE = process.env.TL_URL || 'http://127.0.0.1:4323/';
let failed = 0;

const check = async (name, fn) => {
  try { await fn(); console.log(`  PASS  ${name}`); }
  catch (e) { console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n')[0]}`); failed++; }
};
const must = (cond, msg) => { if (!cond) throw new Error(msg); };

const browser = await chromium.launch();

/* ------------------------------------------------------------------ *
 * shared helpers
 * ------------------------------------------------------------------ */

/** Records every toast the app raises, armed before the page runs. */
const watchToasts = (page) => page.addInitScript(() => {
  window.__toasts = [];
  const arm = () => {
    const host = document.getElementById('toastHost');
    if (!host) return false;
    new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((n) => {
      if (n.nodeType === 1) window.__toasts.push(n.innerText.replace(/\s+/g, ' ').trim());
    }))).observe(host, { childList: true });
    return true;
  };
  const t = setInterval(() => { if (arm()) clearInterval(t); }, 20);
});

const toasts  = (page) => page.evaluate(() => (window.__toasts || []).slice());
const clear   = (page) => page.evaluate(() => { window.__toasts = []; });
const booted  = (page) => page.waitForFunction(() => window.TL && window.TL.ready === true, { timeout: 20000 });
const go      = async (page, hash) => { await page.evaluate((h) => { location.hash = h; }, hash); await page.waitForTimeout(700); };
const session = (page) => page.evaluate(() => (STATE.session ? STATE.session.role + ':' + STATE.session.id : null));
const clickByText = (page, re) => page.evaluate((src) => {
  const rx = new RegExp(src, 'i');
  const b = [...document.querySelectorAll('button')].find((x) => rx.test(x.textContent));
  if (b) b.click();
  return !!b;
}, re.source);

/* ================================================================== *
 * Part 1 - the whole candidate journey, once, in order
 * ================================================================== */
console.log('\ncandidate journey');

const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await watchToasts(page);

const apiCalls = [];
page.on('response', (r) => {
  const u = new URL(r.url());
  if (u.pathname.startsWith('/api/')) apiCalls.push(`${r.request().method()} ${u.pathname} ${r.status()}`);
});

await page.goto(BASE, { waitUntil: 'load' });
await booted(page);

const email = `flow.${Date.now()}@example.test`;
const PASSWORD = 'FlowTest@2026';
let candidateId = null;
let jobId = null;

await check('the page is connected to the backend', async () => {
  const d = await page.evaluate(() => TL.diagnose());
  must(d.backendConnected === true, `TL.diagnose() says: ${d.verdict}`);
  must(d.jobsInCache > 0, 'the cache holds no jobs — bootstrap returned nothing');
});

await check('register creates a real account', async () => {
  await go(page, '#/register/candidate');
  await page.evaluate(({ em, pw }) => {
    const set = (id, v) => {
      const e = document.getElementById(id);
      if (!e) return;
      e.value = v;
      e.dispatchEvent(new Event('input', { bubbles: true }));
      e.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const tick = (id) => { const e = document.getElementById(id); if (e && !e.checked) e.click(); };
    set('regName', 'Flow Test'); set('regMobile', '9876500022'); set('regLocation', 'Hyderabad');
    set('regEmail', em); set('regPassword', pw); set('regSkills', 'Java, SQL');
    set('regPrefLocation', 'Hyderabad'); set('regExpSalary', '12');
    set('regResumeText', 'QA engineer with 3 years of Java and SQL experience.');
    for (const id of ['regQualification', 'regNotice']) {
      const el = document.getElementById(id);
      if (el && el.options.length > 1) { el.selectedIndex = 1; el.dispatchEvent(new Event('change', { bubbles: true })); }
    }
    const type = document.querySelector('input[name="regCandidateType"]');
    if (type) type.click();
    tick('regConsentTerms'); tick('regConsentResume');
  }, { em: email, pw: PASSWORD });

  must(await clickByText(page, /create account/), 'no "Create account" button on the form');
  await page.waitForTimeout(3000);

  const s = await session(page);
  must(s && s.startsWith('candidate:'), `registration did not sign the candidate in (session: ${s})`);
  candidateId = s.split(':')[1];

  const said = await toasts(page);
  must(!said.some((t) => /offline/i.test(t)),
    `an offline message was shown while online: ${JSON.stringify(said)}`);
});

await check('the dashboard loads for the new candidate', async () => {
  await go(page, '#/candidate/home');
  const blank = await page.evaluate(() => document.getElementById('app').innerText.trim().length < 40);
  must(!blank, 'the candidate dashboard rendered blank');
});

await check('signing out and back in restores the same account', async () => {
  await page.evaluate(() => window.doLogout());
  await page.waitForTimeout(1500);
  must((await session(page)) === null, 'still signed in after logout');

  await clear(page);
  await go(page, '#/login/candidate');
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', PASSWORD);
  must(await clickByText(page, /sign in/), 'no sign-in button');
  await page.waitForTimeout(2500);

  const s = await session(page);
  must(s === `candidate:${candidateId}`, `expected candidate:${candidateId}, got ${s}`);
  const said = await toasts(page);
  must(!said.some((t) => /offline/i.test(t)), `offline message on login: ${JSON.stringify(said)}`);
});

await check('Apply Now creates the application', async () => {
  jobId = await page.evaluate(() => (DATA.jobs.find((j) => j.status === 'open') || DATA.jobs[0]).id);
  await go(page, '#/job/' + jobId);
  await clear(page);
  must(await clickByText(page, /apply/), 'the job page has no Apply button');
  await page.waitForTimeout(3000);

  const said = await toasts(page);
  must(said.some((t) => /submitted/i.test(t)),
    `no success confirmation was shown — toasts: ${JSON.stringify(said)}`);
  must(!said.some((t) => /offline/i.test(t)), `offline message on apply: ${JSON.stringify(said)}`);

  const mine = await page.evaluate((c) => DATA.applications.filter((a) => a.candidateId === c).length, candidateId);
  must(mine === 1, `expected 1 application in the cache, found ${mine}`);
});

await check('the server really has it (not just the UI)', async () => {
  const rows = await page.evaluate(() => TL.api.get('/bootstrap').then((b) =>
    (b.data.applications || []).map((a) => a.candidateId + '|' + a.jobId)));
  must(rows.includes(`${candidateId}|${jobId}`),
    `/api/bootstrap does not contain ${candidateId}|${jobId}`);
});

await check('a duplicate application is refused, and says so', async () => {
  const out = await page.evaluate((j) => TL.api.post('/applications', { jobId: j, source: 'portal' })
    .then(() => ({ ok: true }), (e) => ({ ok: false, code: e.code, status: e.status })), jobId);
  must(out.ok === false, 'the server accepted a second application for the same job');
  must(out.status === 409 && out.code === 'DUPLICATE_APPLICATION',
    `expected 409 DUPLICATE_APPLICATION, got ${out.status} ${out.code}`);
});

await check('a second Apply click does not fire a second POST', async () => {
  const before = apiCalls.filter((c) => c.startsWith('POST /api/applications')).length;
  await go(page, '#/job/' + jobId);
  await page.evaluate((j) => { window.applyToJob(j); window.applyToJob(j); }, jobId);
  await page.waitForTimeout(2500);
  const after = apiCalls.filter((c) => c.startsWith('POST /api/applications')).length;
  must(after === before, `${after - before} extra POST /api/applications were sent`);
});

await check('application history shows the job', async () => {
  await go(page, '#/candidate/applications');
  const title = await page.evaluate((j) => (DATA.jobById(j) || {}).title || '', jobId);
  const shown = await page.evaluate((t) => document.getElementById('app').innerText.includes(t), title);
  must(shown, `"${title}" is not on the applications page`);
});

await check('a refresh keeps the session and the application', async () => {
  await page.reload({ waitUntil: 'load' });
  await booted(page);
  must((await session(page)) === `candidate:${candidateId}`, 'the session did not survive a refresh');
  const mine = await page.evaluate((c) => DATA.applications.filter((a) => a.candidateId === c).length, candidateId);
  must(mine === 1, `after refresh the candidate has ${mine} applications, expected 1`);
});

await check('no request was answered with an unexpected error', async () => {
  const bad = apiCalls.filter((c) => {
    const status = Number(c.split(' ').pop());
    if (status < 400) return false;
    return !c.startsWith('POST /api/applications 409');   // the duplicate check above
  });
  must(bad.length === 0, `failing calls: ${bad.join(', ')}`);
});

await ctx.close();

/* ================================================================== *
 * Part 2 - what the app says when the API cannot be reached
 *
 * One message per fault, and the offline wording ONLY when the browser
 * is actually offline.
 * ================================================================== */
console.log('\nwhat it says when a call fails');

const transport = async (name, setup, expect, forbid) => {
  await check(name, async () => {
    const c = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p = await c.newPage();
    await watchToasts(p);
    try {
      await setup(c, p);
      await p.waitForTimeout(2500);
      // a second failing call: it must not raise a second identical toast
      await p.evaluate(() => (window.TL && TL.api
        ? TL.api.post('/auth/login', { email: 'a@b.test', password: 'x'.repeat(10), role: 'candidate' })
            .catch((e) => TL.api.say(e))
        : null));
      await p.waitForTimeout(1500);

      const said = await toasts(p);
      const hits = said.filter((t) => expect.test(t));
      must(hits.length === 1,
        `expected exactly one ${expect} toast, got ${hits.length}: ${JSON.stringify(said)}`);
      if (forbid) {
        must(!said.some((t) => forbid.test(t)),
          `the wrong message was shown: ${JSON.stringify(said)}`);
      }
    } finally { await c.close(); }
  });
};

await transport(
  'opened as a file:// page — says so, does not blame the connection',
  async (c, p) => { await p.goto(pathToFileURL(resolve('web/index.html')).href, { waitUntil: 'load' }); },
  /opened as a file/i,
  /offline/i,
);

await transport(
  'API not responding — says the server is unreachable, not that you are offline',
  async (c, p) => {
    await p.route('**/api/**', (r) => r.abort('connectionrefused'));
    await p.goto(BASE, { waitUntil: 'load' });
  },
  /Cannot reach the TeamLink server/i,
  /offline/i,
);

await transport(
  'browser genuinely offline — and only then, the offline message',
  async (c, p) => {
    await p.goto(BASE, { waitUntil: 'load' });
    await p.waitForFunction(() => window.TL && window.TL.ready === true, { timeout: 20000 });
    await c.setOffline(true);
  },
  /offline/i,
  null,
);

await check('a request that never answers times out (it does not hang)', async () => {
  const c = await browser.newContext();
  const p = await c.newPage();
  await p.goto(BASE, { waitUntil: 'load' });
  await booted(p);
  await p.route('**/api/auth/me', () => { /* deliberately never answered */ });
  const out = await p.evaluate(() => TL.api.get('/auth/me', { timeout: 600 })
    .then(() => ({ ok: true }), (e) => ({ ok: false, code: e.code })));
  must(out.ok === false && out.code === 'TIMEOUT', `expected TIMEOUT, got ${JSON.stringify(out)}`);
  await c.close();
});

await check('an HTTP status with no error body still maps to the right message', async () => {
  const c = await browser.newContext();
  const p = await c.newPage();
  await p.goto(BASE, { waitUntil: 'load' });
  await booted(p);
  const cases = { 401: 'UNAUTHENTICATED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'CONFLICT', 422: 'VALIDATION_FAILED', 500: 'SERVER_ERROR', 503: 'API_UNREACHABLE' };
  for (const [status, code] of Object.entries(cases)) {
    await p.route('**/api/probe', (r) => r.fulfill({ status: Number(status), body: 'not json' }));
    const got = await p.evaluate(() => TL.api.get('/probe').then(() => 'ok', (e) => e.code));
    must(got === code, `HTTP ${status} produced ${got}, expected ${code}`);
    await p.unroute('**/api/probe');
  }
  await c.close();
});

await check('a 401 from one background call does not sign the candidate out', async () => {
  const c = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await c.newPage();
  await p.goto(BASE, { waitUntil: 'load' });
  await booted(p);
  await go(p, '#/login/candidate');
  await p.fill('input[name="email"]', email);
  await p.fill('input[name="password"]', PASSWORD);
  await clickByText(p, /sign in/);
  await p.waitForTimeout(2500);
  must((await session(p)) !== null, 'could not sign in for this check');

  // a background call 401s while the cookie is still perfectly valid
  await p.route('**/api/prefs/**', (r) => r.fulfill({
    status: 401, contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'nope' } }),
  }));
  await p.evaluate(() => TL.api.del('/prefs/whatever').catch((e) => TL.api.say(e)));
  await p.waitForTimeout(2000);

  must((await session(p)) !== null,
    'one unrelated 401 signed the candidate out — /auth/me should have vetoed that');
  await c.close();
});

await browser.close();

console.log(failed === 0
  ? '\n  candidate flow VERIFIED — register, login, apply, history, refresh\n'
  : `\n  ${failed} check(s) FAILED\n`);
process.exit(failed ? 1 : 0);
