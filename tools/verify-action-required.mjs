/**
 * Candidate Home: Search Jobs -> Action Required -> profile statistics.
 *
 *   order       the hero search, then "⚡ Action Required", then the profile
 *               strip, profile views and "Complete your profile"
 *   data        pending AI interviews come from the server (applications'
 *               ai_interview_due_at, stage applied/ai_screening, no completed
 *               interview); "Due in N days" in India calendar days; "Overdue"
 *   count       "2 items need your attention" -> "1 item needs ..." -> hidden
 *   attend      opens the existing AI interview page for THAT application
 *   search      the hero search still searches; no console errors
 *   phone       no sideways scroll, the same order
 *
 * Creates accounts and jobs, so it refuses :4323.
 *   TL_URL=http://127.0.0.1:4418/ node tools/verify-action-required.mjs
 */
import { chromium } from 'playwright';

const BASE = (process.env.TL_URL || 'http://127.0.0.1:4418/').replace(/\/?$/, '/');
const u = new URL(BASE);
if (!['127.0.0.1', 'localhost'].includes(u.hostname) || u.port === '4323') {
  console.error(`Refusing to run against ${BASE}: this creates accounts. Use an isolated instance.`);
  process.exit(2);
}
let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  PASS  ${name}`); }
  catch (e) { console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n')[0]}`); failed += 1; }
};
const must = (c, m) => { if (!c) throw new Error(m); };
const s = Date.now().toString(36);
const RECRUITER = process.env.TL_RECRUITER_EMAIL || 'recruiter@teamlink.com';
const PW = process.env.TL_RECRUITER_PASSWORD || process.env.DEV_PASSWORD || 'TeamLink@2026';

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1366, height: 900 } });
const p = await ctx.newPage();
const errors = [];
p.on('pageerror', (e) => errors.push(String(e).slice(0, 160)));
p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text().slice(0, 160)); });
const home = async (page, tag) => {
  await page.goto('about:blank');
  await page.goto(BASE + `?${tag}=${Date.now()}#/candidate/home`);
  await page.waitForFunction(() => window.TL && TL.ready === true && window.STATE && STATE.session, null, { timeout: 30000 });
  await page.waitForTimeout(2500);
  await page.evaluate(() => document.querySelectorAll('.tlpo-ov .tlpo-btn.ghost, .tlpo-ov .tlpo-skip').forEach((x) => x.click()));
  await page.waitForTimeout(500);
};
const strip = (page) => page.evaluate(() => (document.getElementById('tlActionRequired') || {}).innerText || '');
const order = (page) => page.evaluate(() => Array.from(document.querySelector('.cp-wrap').children).slice(0, 5)
  .map((e) => e.id || String(e.className).split(' ')[0]));

await p.goto(BASE + '#/');
await p.waitForFunction(() => window.TL && TL.ready === true);
const titles = [`HR Recruiter ${s}`, `Medical Billing Executive ${s}`];
const jobs = await p.evaluate(async ({ e, pw, titles }) => {
  await TL.api.post('/auth/login', { email: e, password: pw, role: 'recruiter' });
  const boot = await TL.api.get('/bootstrap');
  const me = (boot.data.recruiters || []).find((r) => r.id === boot.session.id) || {};
  const out = [];
  for (const t of titles) {
    const j = await TL.api.post('/jobs', { title: t, companyId: me.companyId, location: 'Hyderabad', mode: 'Onsite', exp: '0-2 yrs',
      pay: '₹3 LPA', salaryMin: 3, salaryMax: 3, type: 'Full-time', status: 'open', skills: ['Communication'], desc: 'Verification job - safe to delete.' });
    await TL.api.put(`/jobs/${j.job.id}/screening-questions`, { questions: [] });
    out.push(j.job.id);
  }
  await TL.api.post('/auth/logout', {});
  return out;
}, { e: RECRUITER, pw: PW, titles });
await p.evaluate(async ({ s, jobs }) => {
  await TL.api.post('/auth/register', { name: 'Action Tester', email: `action.${s}@tl-verify.test`, password: `Act${s}99x`,
    phone: '9' + String(Math.floor(1e8 + Math.random() * 9e8)), preferredLocation: 'Hyderabad', expectedCtc: 3,
    noticePeriod: 'Immediate', preferredWorkModes: ['Hybrid'] });
  for (const id of jobs) await TL.api.post('/applications', { jobId: id });
}, { s, jobs });

console.log(`\naction required on the candidate home  (${BASE})`);
await home(p, 'a');

await check('order: Search Jobs, then Action Required, then the profile statistics', async () => {
  const o = await order(p);
  must(o[0] === 'cp-hero' && o[1] === 'tlActionRequired' && o[2] === 'pstrip', o.join(' > '));
});

await check('two pending AI interviews from the server, the countdown and "2 items need your attention"', async () => {
  const t = await strip(p);
  must(/2 items need your attention/.test(t), t);
  must(titles.every((x) => t.includes(x)), 'job titles missing: ' + t);
  const due = await p.evaluate(() => DATA.applications.filter((a) => a.candidateId === STATE.session.id)[0].aiInterviewDueAt);
  const expect = await p.evaluate((d) => window.TLActionRequired.dueState(Date.parse(d), Date.now()).text, due);
  must(t.includes(expect), `expected "${expect}" in: ${t}`);
});

await check('a passed deadline reads Overdue; a completed interview drops out and the count follows; none -> no section', async () => {
  await p.evaluate(() => {
    const m = DATA.applications.filter((a) => a.candidateId === STATE.session.id);
    m[1].aiInterviewDueAt = new Date(Date.now() - 5 * 86400000).toISOString();
    render();
  });
  await p.waitForTimeout(500);
  must(/Overdue/.test(await strip(p)), 'no Overdue');
  await p.evaluate(() => {
    const a = DATA.applications.filter((x) => x.candidateId === STATE.session.id)[0];
    TL.aiInterviews = (TL.aiInterviews || []).concat([{ id: 'v1', applicationId: a.id, status: 'completed' }]);
    render();
  });
  await p.waitForTimeout(500);
  must(/1 item needs your attention/.test(await strip(p)), 'the count did not follow');
  await p.evaluate(() => {
    const a = DATA.applications.filter((x) => x.candidateId === STATE.session.id)[1];
    TL.aiInterviews.push({ id: 'v2', applicationId: a.id, status: 'completed' });
    render();
  });
  await p.waitForTimeout(500);
  must(await p.evaluate(() => document.querySelectorAll('#tlActionRequired').length) === 0, 'section still shown with nothing pending');
});

await check('Attend AI Interview opens the AI interview page of that application', async () => {
  await home(p, 'b');
  const pick = await p.evaluate(() => {
    const btn = document.querySelector('#tlActionRequired .tlar-btn');
    const sub = btn.closest('.tlar-item').querySelector('.tlar-sub').textContent;
    btn.click();
    return sub;
  });
  await p.waitForTimeout(1500);
  const page = await p.evaluate(() => ({ hash: location.hash, text: (document.querySelector('#app').innerText || '').replace(/\s+/g, ' ') }));
  must(/^#\/ai-interview\//.test(page.hash), page.hash);
  const title = titles.find((x) => pick.includes(x));
  must(title && page.text.includes(title), `the interview page is not for ${title}`);
  must(!/could not be found/i.test(page.text), 'interview not found');
});

await check('the hero search still searches (typed "Python")', async () => {
  await home(p, 'c');
  await p.fill('.cp-hero input', 'Python');
  await p.click('.cp-hero button:has-text("Search Jobs")');
  await p.waitForTimeout(1500);
  must(/candidate\/search|#\/jobs/.test(await p.evaluate(() => location.hash)), 'did not go to the results');
});

await check('phone: no sideways scroll, the same order', async () => {
  const m = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await m.addCookies(await ctx.cookies());
  const mp = await m.newPage();
  await home(mp, 'd');
  must(await mp.evaluate(() => document.documentElement.scrollWidth - innerWidth) <= 0, 'sideways scroll');
  const o = await order(mp);
  must(o[0] === 'cp-hero' && o[1] === 'tlActionRequired', o.join(' > '));
  await m.close();
});

await check('no script errors on the way', async () => { must(!errors.length, errors.join(' | ')); });

await b.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
