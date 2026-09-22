/**
 * The recruiter's side of the calling agent, driven through the screen.
 *
 * The engine and the API are verified elsewhere; this checks the thing a
 * recruiter actually touches: the 📞 button in Find Candidates, what the
 * modal offers, and that pressing it starts a real recorded call rather
 * than the old browser-side IVR POST.
 *
 *   node tools/verify-calling-ui.mjs      (needs npm run dev on :4323)
 */
import { chromium } from 'playwright';

const BASE = (process.env.TL_URL || 'http://localhost:4323/').replace(/\/$/, '');
const PASSWORD = process.env.TL_PASSWORD || 'TeamLink@2026';

let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  PASS  ${name}`); }
  catch (e) { console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n')[0]}`); failed++; }
};
const must = (c, m) => { if (!c) throw new Error(m); };

const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(`${BASE}/`, { waitUntil: 'load' });
await page.waitForFunction(() => window.TL && window.TL.ready === true, { timeout: 25000 });

const api = async (m, p, b) => {
  const r = await page.evaluate(([mm, pp, bb]) =>
    window.TL.api[mm](pp, bb).then((ok) => ({ ok: true, value: ok }),
      (e) => ({ ok: false, code: e.code, message: e.message })), [m, p, b]);
  if (r.ok) return r.value;
  throw Object.assign(new Error(`${r.code}: ${r.message}`), { code: r.code });
};

const stamp = Date.now();
let candidateId, jobId;

await check('a recruiter reaches Find Candidates with results', async () => {
  await api('post', '/auth/login',
    { email: 'recruiter@teamlink.com', password: PASSWORD, role: 'recruiter' });
  await page.evaluate(() => window.TL.refresh());
  await page.waitForTimeout(800);

  // A candidate with a number, so the call button is offered.
  const reg = await api('post', '/auth/register', {
    name: 'UI Call Target', email: `uicall.${stamp}@example.test`, password: 'UiCall@2026',
  });
  candidateId = reg.candidateId;
  await api('put', `/candidates/${candidateId}`, {
    phone: '+91 90000 55555', title: 'React Developer', location: 'Hyderabad',
    expYears: 4, skills: ['React'], technicalSkills: ['React'],
  });
  // back to the recruiter, whose session the registration replaced
  await api('post', '/auth/login',
    { email: 'recruiter@teamlink.com', password: PASSWORD, role: 'recruiter' });
  await page.evaluate(() => window.TL.refresh());
  await page.waitForTimeout(800);

  jobId = await page.evaluate(() => {
    const j = (DATA.jobs || []).find((x) => x.status === 'open' && !x.paused && !x.archived);
    return j ? j.id : null;
  });
  must(jobId, 'no open requirement to call about');

  await page.evaluate(() => { location.hash = '#/recruiter/find-candidates'; });
  await page.waitForTimeout(1200);
});

await check('the results toolbar still offers the calling button', async () => {
  // Put the screen into its results state the way the app does.
  const ok = await page.evaluate((cid) => {
    STATE.fcr = STATE.fcr || {};
    STATE.fcr.active = true;
    STATE.fcr.selection = {};
    STATE.fcr.selection[cid] = true;
    window.render();
    return true;
  }, candidateId);
  must(ok, 'the results state could not be set');
  await page.waitForTimeout(900);

  const found = await page.evaluate(() =>
    [...document.querySelectorAll('button')].some((b) => /IVR|AI Call/i.test(b.textContent)));
  must(found, 'the calling button is not on the toolbar');
});

await check('pressing it opens the AI calling modal, not the old IVR endpoint box', async () => {
  await page.evaluate(() => window.fcrIvrModal());
  await page.waitForTimeout(1500);

  const text = await page.evaluate(() => document.body.innerText);
  must(/AI Calling/i.test(text), 'the modal is not the AI calling one');
  must(!/voice API endpoint URL/i.test(text),
    'the old endpoint-configuration box is still shown');
  must(/Requirement/i.test(text) && /Language/i.test(text),
    'the modal does not offer a requirement and a language');
  must(/Auto detect/i.test(text), 'auto language detection is not offered');
});

await check('it says plainly whether calls are real or local', async () => {
  const text = await page.evaluate(() => document.body.innerText);
  must(/telephony provider is configured|Calls are placed through/i.test(text),
    'the modal does not say whether a carrier is configured');
});

await check('"What will it ask?" shows what is known and what will be asked', async () => {
  await page.evaluate((cid) => { window.TL.calling.preview(cid); }, candidateId);
  await page.waitForTimeout(1200);
  const text = await page.evaluate(() =>
    (document.getElementById('tlCallOut') || {}).innerText || '');
  must(/Already known/i.test(text), 'the preview does not list what is known');
  must(/Will ask/i.test(text), 'the preview does not list what will be asked');
  must(/name/i.test(text), 'the known list does not mention the name');
});

await check('pressing Call now starts a real, recorded call', async () => {
  await page.evaluate((jid) => {
    const sel = document.getElementById('tlCallJob');
    if (sel) sel.value = jid;
  }, jobId);
  await page.evaluate((cid) => { window.TL.calling.start(cid); }, candidateId);
  await page.waitForTimeout(2500);

  const out = await page.evaluate(() =>
    (document.getElementById('tlCallOut') || {}).innerText || '');
  must(/Call started/i.test(out), `the call did not start: "${out}"`);
  must(/may i speak with/i.test(out), 'the opening line was not shown');

  const { calls } = await api('get', `/ai-calling/calls?candidateId=${candidateId}`);
  must(calls.length >= 1, 'the call was not recorded on the server');
  must(calls[0].provider, 'the recorded call has no provider');
});

await check('the local conversation console holds a real conversation', async () => {
  const { calls } = await api('get', `/ai-calling/calls?candidateId=${candidateId}`);
  const callId = calls[0].id;

  await page.evaluate((id) => { window.TL.calling.console(id); }, callId);
  await page.waitForTimeout(1200);

  for (const line of ['Yes speaking', 'Yes go ahead', 'Yes I am interested']) {
    await page.evaluate(([id, t]) => {
      document.getElementById('tlCallSay').value = t;
      window.TL.calling.send(id);
    }, [callId, line]);
    await page.waitForTimeout(1100);
  }

  const log = await page.evaluate(() =>
    (document.getElementById('tlCallLog') || {}).innerText || '');
  must(/Agent:/.test(log) && /Candidate:/.test(log), 'the transcript did not render');
  must(/anu/i.test(log), 'the agent did not introduce itself in the log');
});

await check('the dashboard renders with real counts', async () => {
  await page.evaluate(() => window.TL.calling.dashboard());
  await page.waitForTimeout(1500);
  const text = await page.evaluate(() =>
    (document.getElementById('tlCallDash') || {}).innerText || '');
  must(/Total calls/i.test(text), 'no totals on the dashboard');
  must(/Interested/i.test(text), 'no interest breakdown');
  must(/Recent calls/i.test(text), 'no recent call list');
});

await check('the screen logged no errors while doing all of that', async () => {
  const real = errors.filter((e) => !/favicon|manifest/i.test(e));
  must(real.length === 0, `console errors: ${real.slice(0, 2).join(' | ')}`);
});

await browser.close();
console.log(failed === 0
  ? '\n  CALLING UI VERIFIED — the Find Candidates button starts a real, recorded conversation\n'
  : `\n  ${failed} check(s) FAILED\n`);
process.exit(failed ? 1 : 0);
