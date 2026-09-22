/**
 * Where the candidate came from must survive the journey.
 *
 * A requirement is posted to Naukri, LinkedIn, Indeed, Shine and the
 * portal, and every "Apply Now" lands the candidate here. So by the time
 * an application exists, the only record of which board sent them is
 * whatever was captured on arrival.
 *
 * Nothing captured it: applyToJob() sent `source: 'portal'` for everyone,
 * so the ATS said TeamLink for every application and source-wise reporting
 * meant nothing.
 *
 * The journey is not one page load:
 *
 *     naukri.com -> /?src=naukri -> register or log in -> job -> apply
 *
 * Each step is a navigation that can drop a query string, so this walks
 * the whole path for each board and checks what the DATABASE ends up with.
 *
 *   node tools/verify-source.mjs      (needs npm run dev on :4323)
 */
import { chromium } from 'playwright';

const BASE = (process.env.TL_URL || 'http://localhost:4323/').replace(/\/$/, '');

let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  PASS  ${name}`); }
  catch (e) { console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n')[0]}`); failed++; }
};
const must = (c, m) => { if (!c) throw new Error(m); };

const browser = await chromium.launch();

/**
 * The full path a candidate takes from a job board.
 *
 * @param arrive  the URL they land on, as the board's link would send them
 * @param referer the board they came from, or null
 */
async function journey({ arrive, referer }) {
  const ctx = await browser.newContext(referer ? { extraHTTPHeaders: { referer } } : {});
  const page = await ctx.newPage();
  try {
    await page.goto(arrive, { waitUntil: 'load' });
    await page.waitForFunction(() => window.TL && window.TL.ready === true, { timeout: 25000 });

    // register — a navigation, and the first chance to lose the source
    const email = `src.${Date.now()}.${Math.random().toString(36).slice(2, 6)}@example.test`;
    const reg = await page.evaluate((em) =>
      window.TL.api.post('/auth/register',
        { name: 'Source Tester', email: em, password: 'SrcTest@2026' }), email);

    await page.evaluate(() => window.TL.refresh());
    await page.waitForTimeout(500);

    // move around the portal, as anyone would before applying
    await page.evaluate(() => { location.hash = '#/candidate/home'; });
    await page.waitForTimeout(400);
    await page.evaluate(() => { location.hash = '#/jobs'; });
    await page.waitForTimeout(400);

    const jobId = await page.evaluate(() => (DATA.jobs.find((j) => j.status === 'open') || {}).id);
    await page.evaluate((id) => { location.hash = '#/job/' + id; }, jobId);
    await page.waitForTimeout(600);

    // apply through the real control
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /apply/i.test(x.textContent));
      if (b) b.click();
    });
    await page.waitForTimeout(2500);

    // read it back from the SERVER
    const app = await page.evaluate((cid) =>
      window.TL.api.get('/bootstrap').then((b) =>
        (b.data.applications || []).find((a) => a.candidateId === cid)), reg.candidateId);

    return { source: app ? app.source : null, applicationId: app ? app.id : null };
  } finally { await ctx.close(); }
}

console.log('\nthe board that sent them, after registering and applying');

for (const [label, arrive, expected] of [
  ['?src=naukri',            `${BASE}/?src=naukri`,                  'naukri'],
  ['?src=linkedin',          `${BASE}/?src=linkedin`,                'linkedin'],
  ['?src=indeed',            `${BASE}/?src=indeed`,                  'indeed'],
  ['?src=shine',             `${BASE}/?src=shine`,                   'shine'],
  ['?utm_source=Naukri.com', `${BASE}/?utm_source=Naukri.com`,       'naukri'],
  ['?src=referral',          `${BASE}/?src=referral`,                'referral'],
  ['no tag at all',          `${BASE}/`,                             'teamlink'],
]) {
  // eslint-disable-next-line no-loop-func
  await check(`${label.padEnd(24)} -> ${expected}`, async () => {
    const out = await journey({ arrive, referer: null });
    must(out.applicationId, 'no application was created');
    must(out.source === expected,
      `the ATS recorded "${out.source}" for a candidate from ${label}`);
  });
}

await check('a board that does not tag its links is read from the referrer', async () => {
  const out = await journey({ arrive: `${BASE}/`, referer: 'https://www.linkedin.com/jobs/view/123' });
  must(out.source === 'linkedin', `recorded "${out.source}" for a LinkedIn referrer`);
});

await check('the source survives landing deep, not on the home page', async () => {
  const out = await journey({ arrive: `${BASE}/?src=naukri#/jobs`, referer: null });
  must(out.source === 'naukri', `recorded "${out.source}"`);
});

await check('a hostile source cannot pollute the reports', async () => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    await page.goto(`${BASE}/`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.TL && window.TL.ready === true, { timeout: 25000 });
    const email = `evil.${Date.now()}@example.test`;
    await page.evaluate((em) => window.TL.api.post('/auth/register',
      { name: 'Evil Source', email: em, password: 'EvilSrc@2026' }), email);
    await page.evaluate(() => window.TL.refresh());
    await page.waitForTimeout(500);
    const jobId = await page.evaluate(() => (DATA.jobs.find((j) => j.status === 'open') || {}).id);

    const out = await page.evaluate((id) =>
      window.TL.api.post('/applications',
        { jobId: id, source: '<script>alert(1)</script> DROP TABLE' })
        .then((r) => r.application.source, (e) => 'REFUSED ' + e.code), jobId);

    must(!/[<>]/.test(String(out)), `the raw value was stored: ${out}`);
  } finally { await ctx.close(); }
});

await browser.close();
console.log(failed === 0
  ? '\n  SOURCE VERIFIED — the board that sent the candidate is what the ATS records\n'
  : `\n  ${failed} check(s) FAILED\n`);
process.exit(failed ? 1 : 0);
