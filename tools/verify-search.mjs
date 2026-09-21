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

await page.evaluate(async (pw) => {
  await window.TL.api.post('/auth/login',
    { email: 'recruiter@teamlink.com', password: pw, role: 'recruiter' });
  await window.TL.refresh();
}, PASSWORD);

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
  const bad = await page.evaluate(() =>
    (window.TL.fcr.rows || [])
      .filter((c) => ![].concat(c.skills || [], c.technicalSkills || []).includes('React'))
      .map((c) => c.id));
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

await check('scheduling writes to the database and survives a reload', async () => {
  const made = await page.evaluate(async () => {
    try {
      const iv = await window.TL.scheduleInterview({
        candidateId: 'cand4', jobId: 'j4',
        date: '2026-11-20', time: '02:30 PM', mode: 'Video Call',
      });
      return { ok: true, id: iv.id, date: iv.date, time: iv.time };
    } catch (e) { return { ok: false, error: e.code || e.message }; }
  });
  if (!made.ok) throw new Error('scheduling failed: ' + made.error);
  if (made.date !== '2026-11-20') throw new Error(`date shifted: ${made.date}`);

  // reload: if it only existed in the tab, it disappears here
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.TL && window.TL.ready === true, { timeout: 20000 });
  const survived = await page.evaluate((id) =>
    DATA.interviews.some((i) => i.id === id), made.id);
  if (!survived) throw new Error('the interview did not survive a reload — it was never persisted');
});

console.log(failed ? `\nSEARCH/INTERVIEW VERIFICATION FAILED (${failed})`
                   : '\nSEARCH + INTERVIEW VERIFIED');
await browser.close();
process.exitCode = failed ? 1 : 0;
