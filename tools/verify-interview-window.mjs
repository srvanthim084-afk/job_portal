/**
 * AI interviews follow the job (0133), in a real browser.
 *
 *     TL_URL=http://127.0.0.1:4457 node tools/verify-interview-window.mjs   (needs LOAD_SEED=true: recruiter@teamlink.com)
 *
 * A candidate applies to three jobs - no date, a last date in three days, and one the recruiter then
 * closes. Home must show: "Upcoming interviews" = 2; Action Required lists two "AI Interview Pending" (one
 * "No deadline · Attend any time", one "Complete by <date>") and one "AI Interview Closed" with the owner's
 * message and no Attend button; opening the closed one says the same and offers no Start.
 */
import { chromium } from 'playwright';

const BASE = (process.env.TL_URL || 'http://localhost:4323/').replace(/\/$/, '');
const fail = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`); if (!ok) fail.push(what); };
const CLOSED = 'You applied for this job, but the date is over, so you cannot attend the interview now.';

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 1000 } })).newPage();
page.errors = [];
page.on('pageerror', (e) => page.errors.push(String(e.message)));
await page.goto(`${BASE}/`, { waitUntil: 'load' });
await page.waitForFunction(() => window.TL && TL.ready === true, null, { timeout: 30000 });
const stamp = Date.now().toString(36);

/* the recruiter posts three jobs */
const ids = await page.evaluate(async (s) => {
  await TL.api.post('/auth/login', { email: 'recruiter@teamlink.com', password: 'TeamLink@2026', role: 'recruiter' });
  const boot = await TL.api.get('/bootstrap');
  const me = (boot.data.recruiters || []).find((r) => r.id === boot.session.id) || {};
  const in3 = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  const mk = async (title, extra) => (await TL.api.post('/jobs', Object.assign({ title: title + ' ' + s, companyId: me.companyId,
    location: 'Hyderabad', mode: 'Onsite', exp: '1-3 yrs', pay: '₹3-5 LPA', salaryMin: 3, salaryMax: 5, type: 'Full-time',
    status: 'open', skills: ['Communication'], desc: 'Real test job.' }, extra || {}))).job.id;
  const out = { nodate: await mk('No Date Analyst'), dated: await mk('Dated Analyst'), toClose: await mk('Closing Analyst') };
  /* the last date to apply, as the recruiter sets it */
  await TL.api.put('/jobs/' + out.dated + '/deadline', { lastDate: in3 });
  for (const id of Object.values(out)) await TL.api.put(`/jobs/${id}/screening-questions`, { questions: [] }).catch(() => {});
  await TL.api.post('/auth/logout', {});
  return out;
}, stamp);

/* a candidate applies to all three */
await page.evaluate(async (s) => {
  await TL.api.post('/auth/register', { name: 'Window Candidate', email: `window.cand.${s}@mailbox-teamlink-tests.in`, password: 'Window3pass9',
    phone: '9' + String(Date.now()).slice(-9), preferredLocation: 'Hyderabad', expectedCtc: 4, noticePeriod: 'Immediate', preferredWorkModes: ['Office'] });
}, stamp);
for (const id of Object.values(ids)) {
  const r = await page.evaluate(async (j) => { try { await TL.api.post('/applications', { jobId: j }); return 'ok'; } catch (e) { return e.message; } }, id);
  check(r === 'ok', `applied to ${id} (${r})`);
}
const cand = await page.evaluate(() => STATE && STATE.session ? STATE.session : null);

/* the recruiter closes the third job */
const closer = await (await browser.newContext()).newPage();
await closer.goto(`${BASE}/`, { waitUntil: 'load' });
await closer.waitForFunction(() => window.TL && TL.ready === true, null, { timeout: 30000 });
const closed = await closer.evaluate(async (id) => {
  await TL.api.post('/auth/login', { email: 'recruiter@teamlink.com', password: 'TeamLink@2026', role: 'recruiter' });
  const boot = await TL.api.get('/bootstrap');
  const j = (boot.data.jobs || []).find((x) => x.id === id);
  try {
    await TL.api.put('/jobs/' + id, { title: j.title, companyId: j.companyId, location: j.location, mode: j.mode, exp: j.exp,
      pay: j.pay, salaryMin: 3, salaryMax: 5, type: j.type || 'Full-time', skills: j.skills || ['Communication'],
      desc: j.desc || 'Real test job.', status: 'closed' });
    return 'ok';
  } catch (e) { return e.status + ' ' + e.message + ' ' + JSON.stringify(e.details || {}); }
}, ids.toClose);
check(closed === 'ok', `the recruiter closed one job (${closed})`);

/* the candidate's Home */
await page.evaluate(() => TL.refresh());
await page.evaluate(() => { location.hash = '#/candidate/home'; });
await page.waitForSelector('#tlActionRequired', { timeout: 20000 });
await page.waitForTimeout(2500);
const tiles = await page.evaluate(() => {
  const t = [...document.querySelectorAll('#tlY2Counts *')].find((el) => /Upcoming interviews/.test(el.textContent || '') && el.children.length <= 3);
  return t ? t.closest('a,div').innerText.replace(/\s+/g, ' ') : document.body.innerText.match(/(\d+)\s*Upcoming interviews/)?.[0];
});
check(/\b2\b.*Upcoming interviews|Upcoming interviews.*\b2\b/.test(tiles || ''), `"Upcoming interviews" = 2 (${tiles})`);
const ar = await page.evaluate(() => document.getElementById('tlActionRequired').innerText);
check(/2 items need your attention/.test(ar), 'Action Required counts the two that can still be taken');
check((ar.match(/AI Interview Pending/g) || []).length === 2, 'two "AI Interview Pending"');
check(/No Date Analyst[^\n]*No deadline[^\n]*Attend any time/.test(ar), 'the job with no date: "No deadline · Attend any time"');
check(/Dated Analyst[^\n]*Complete by/.test(ar), 'the dated job: "Complete by <its last date>"');
check(/AI Interview Closed/.test(ar) && ar.includes(CLOSED), 'the closed job: "AI Interview Closed" with the message');
check(await page.evaluate(() => [...document.querySelectorAll('#tlActionRequired .tlar-closed button')].length === 0), '...and no Attend button on it');

/* opening the closed one directly */
const closedApp = await page.evaluate((jid) => (DATA.applications || []).find((a) => a.jobId === jid), ids.toClose);
check(!!closedApp && closedApp.aiInterviewOpen === false, 'the application says the interview is closed');
await page.evaluate((a) => { const rec = window.__lcRecFor && window.__lcRecFor(a.candidateId, a.jobId); navigate('/ai-interview/' + encodeURIComponent((rec && rec.applicationId) || a.reference || a.id)); }, closedApp);
await page.waitForTimeout(1500);
const ivPage = await page.evaluate(() => document.getElementById('app').innerText);
check(ivPage.includes(CLOSED) && !/Start AI Video Interview/.test(ivPage), 'the AI interview page: the message, no Start button');
check(page.errors.length === 0, `no page errors (${page.errors.join(' | ')})`);
console.log('candidate', cand && cand.id);

await browser.close();
console.log(fail.length ? `\n${fail.length} FAILED:\n - ${fail.join('\n - ')}` : '\nall passed');
process.exit(fail.length ? 1 : 0);
