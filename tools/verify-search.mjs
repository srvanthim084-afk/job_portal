/**
 * Proves Find Candidates filters in SQL, not in the browser (req. 10, 11).
 *
 * It drives the real screen and watches the network. The assertion that
 * matters is not "results appeared" — it is that applying a filter caused a
 * REQUEST, and that the filter reached the server as a query parameter
 * rather than being applied to a pre-loaded array.
 *
 *   node tools/verify-search.mjs           (needs tools/dev-server.mjs on :4323)
 */
import { chromium } from 'playwright';

const BASE = process.env.TL_URL || 'http://127.0.0.1:4323/';
/* The recruiter this deployment actually has. The demo login this file
   signed in as went with the demo data. */
import { login } from './lib/logins.mjs';
const RECRUITER = login('recruiter');
const ADMIN = login('admin');
const PASSWORD = process.env.TL_PASSWORD || 'TeamLink@2026';

let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  PASS  ${name}`); }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); failed++; }
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

const calls = [];
page.on('request', (r) => {
  const u = r.url();
  if (u.includes('/api/candidates')) calls.push(u);
});
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(BASE, { waitUntil: 'load' });
await page.waitForFunction(() => window.TL && window.TL.ready === true, { timeout: 20000 });

await page.evaluate(async (cred) => {
  await window.TL.api.post('/auth/login',
    { email: cred.email, password: cred.password, role: 'recruiter' });
  await window.TL.refresh();
}, RECRUITER);

console.log('Find Candidates — server-side search');

await check('opening the screen issues a database query', async () => {
  calls.length = 0;
  await page.evaluate(() => { location.hash = '#/recruiter/find-candidates'; });
  await page.waitForTimeout(1500);
  if (!calls.length) throw new Error('no /api/candidates request was made');
});

await check('the result window comes from the server, with a true total', async () => {
  const fcr = await page.evaluate(() => ({
    rows: (window.TL.fcr.rows || []).length,
    total: window.TL.fcr.total,
  }));
  if (fcr.rows === 0) throw new Error('no rows were loaded');
  if (typeof fcr.total !== 'number') throw new Error('no total reported');
});

await check('applying a SKILLS filter sends it to the database', async () => {
  calls.length = 0;
  await page.evaluate(() => window.fcrToggleFacet('skills', 'React'));
  await page.waitForTimeout(1200);
  const hit = calls.find((u) => /[?&]skills=React/.test(u));
  if (!hit) throw new Error(`skills never reached the server. calls: ${calls.join(' | ') || '(none)'}`);
});

await check('the rows returned actually match that filter', async () => {
  /*
   * WHOLE WORD, CASE-INSENSITIVE - the rule the server actually applies.
   *
   * This asserted an exact `includes('React')`, and the server matches
   * "React" against "React.js", "react" and "React Native" ON PURPOSE:
   * a skill is stored as the CV wrote it, and an exact match finds a
   * fraction of the people who have the skill (see the long note in
   * api/src/routes/candidates.js). Two real candidates carrying
   * "React.js" were therefore reported as the SERVER returning
   * non-matching rows, when the server was right and the check was
   * describing a filter this application deliberately does not have.
   *
   * The boundary either side is the part worth checking, so it is kept:
   * "React" must not be satisfied by "Reacting" or "Preact".
   */
  const bad = await page.evaluate(() => {
    const whole = /(^|[^a-z0-9])react([^a-z0-9]|$)/i;
    return (window.TL.fcr.rows || [])
      .filter((c) => ![].concat(c.skills || [], c.technicalSkills || [])
        .some((s) => whole.test(String(s || ''))))
      .map((c) => c.id);
  });
  if (bad.length) throw new Error(`server returned non-matching rows: ${bad.join(', ')}`);
});

await check('a LOCATION filter is sent as a query parameter', async () => {
  calls.length = 0;
  await page.evaluate(() => window.fcrToggleFacet('locs', 'Pune'));
  await page.waitForTimeout(1200);
  if (!calls.find((u) => /[?&]location=Pune/.test(u))) {
    throw new Error(`location never reached the server. calls: ${calls.join(' | ') || '(none)'}`);
  }
});

await check('a KEYWORD search is sent as a query parameter', async () => {
  calls.length = 0;
  await page.evaluate(() => { window.fcrSet('locs', []); window.fcrSet('skills', []); });
  await page.waitForTimeout(600);
  calls.length = 0;
  await page.evaluate(() => window.fcrSet('anyKw', 'Django'));
  await page.waitForTimeout(1200);
  if (!calls.find((u) => /[?&]q=Django/.test(u))) {
    throw new Error(`keyword never reached the server. calls: ${calls.join(' | ') || '(none)'}`);
  }
});

await check('an impossible filter returns nothing, from the server', async () => {
  await page.evaluate(() => window.fcrSet('anyKw', 'zzzzz-no-such-candidate'));
  await page.waitForTimeout(1200);
  const n = await page.evaluate(() => ({
    rows: (window.TL.fcr.rows || []).length, total: window.TL.fcr.total }));
  if (n.rows !== 0 || n.total !== 0) {
    throw new Error(`expected an empty result, got rows=${n.rows} total=${n.total}`);
  }
});

await check('the screen renders without throwing', async () => {
  await page.evaluate(() => window.fcrSet('anyKw', ''));
  await page.waitForTimeout(1200);
  const n = await page.evaluate(() => document.querySelectorAll('#app *').length);
  if (n < 50) throw new Error(`the screen collapsed to ${n} nodes`);
  if (errors.length) throw new Error('page errors: ' + errors.join(' | '));
});

console.log('\nInterview scheduling');

/*
 * A CANDIDATE OF ITS OWN, NOT A REAL ONE.
 *
 * This check scheduled an interview for `candidateId: 'cand4'` on
 * `jobId: 'j4'` — ids from the demo seed, which went when the demo data
 * did. Row-level security then refused the write and the failure read as
 * "scheduling is broken".
 *
 * The obvious repair is to grab the first real candidate on the board,
 * and that is the wrong repair: scheduling an interview for somebody
 * puts a record against a real person and fires the stage notifications
 * at them. A verification run must not appear in anybody's history. So
 * it makes its own candidate, uses that, and removes it at the end.
 */
let probeCandidateId = null;

await check('scheduling writes to the database and survives a reload', async () => {
  const setup = await page.evaluate(async () => {
    const stamp = Date.now();
    const job = (DATA.jobs || []).find((j) => j.status === 'open' && !j.paused && !j.archived);
    if (!job) return { ok: false, error: 'no open requirement to schedule against' };
    const imported = await window.TL.api.post('/candidates/import', {
      text: 'Name,Email,Phone\nSearch Probe ' + stamp
          + ',search.probe.' + stamp + '@example.test,+91 60000' + String(stamp).slice(-5),
    });
    const row = ((imported.detail || {}).imported || [])[0];
    return row ? { ok: true, candidateId: row.id, jobId: job.id }
               : { ok: false, error: 'the probe candidate was not created' };
  });
  if (!setup.ok) throw new Error(setup.error);
  probeCandidateId = setup.candidateId;

  const made = await page.evaluate(async ([candidateId, jobId]) => {
    try {
      const iv = await window.TL.scheduleInterview({
        candidateId, jobId,
        date: '2026-11-20', time: '02:30 PM', mode: 'Video Call',
      });
      return { ok: true, id: iv.id, date: iv.date, time: iv.time };
    } catch (e) { return { ok: false, error: e.code || e.message }; }
  }, [setup.candidateId, setup.jobId]);
  if (!made.ok) throw new Error('scheduling failed: ' + made.error);
  if (made.date !== '2026-11-20') throw new Error(`date shifted: ${made.date}`);

  // reload: if it only existed in the tab, it disappears here
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.TL && window.TL.ready === true, { timeout: 20000 });
  const survived = await page.evaluate((id) =>
    DATA.interviews.some((i) => i.id === id), made.id);
  if (!survived) throw new Error('the interview did not survive a reload — it was never persisted');
});

/* Take the probe candidate back out, whether the checks passed or not. */
if (probeCandidateId) {
  const gone = await page.evaluate(async ([id, cred]) => {
    try {
      await window.TL.api.post('/auth/login', { ...cred, role: 'admin' });
      await window.TL.api.post('/admin/purge-test-candidate', { candidateId: id });
      return true;
    } catch (e) { return false; }
  }, [probeCandidateId, ADMIN]);
  console.log(gone ? '  cleaned up: 1 probe candidate'
                   : `  NOT cleaned up: ${probeCandidateId} is still on file`);
}

console.log(failed ? `\nSEARCH/INTERVIEW VERIFICATION FAILED (${failed})`
                   : '\nSEARCH + INTERVIEW VERIFIED');
await browser.close();
process.exitCode = failed ? 1 : 0;
