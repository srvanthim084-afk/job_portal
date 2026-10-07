/*
 * "AI Hiring Demo" and "AI WhatsApp Agent", through the real UI.
 *
 * Creates a job, candidates and an application, so it refuses :4323. Run
 * against an isolated instance:
 *   TL_URL=http://127.0.0.1:4419/ node tools/verify-ai-demos.mjs
 * (WhatsApp is not configured there, which is part of what is checked.)
 */
import { chromium } from 'playwright';

const BASE = (process.env.TL_URL || 'http://127.0.0.1:4419/').replace(/\/?$/, '/');
if (/:4323\//.test(BASE)) { console.error('Refusing to run against the live instance (:4323).'); process.exit(2); }
const RECRUITER = process.env.TL_RECRUITER_EMAIL || 'recruiter@teamlink.com';
const PW = process.env.TL_RECRUITER_PASSWORD || 'TeamLink@2026';
const s = Date.now().toString(36);
let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  PASS  ${name}`); }
  catch (e) { console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n')[0]}`); failed += 1; }
};
const must = (c, m) => { if (!c) throw new Error(m); };

const RESUME = `Ravi Kumar
ravi.kumar.${s}@example.com | +91 98765 43210 | Hyderabad
SUMMARY
Recruiter with 3 years of experience in talent acquisition and sourcing.
SKILLS
Recruitment, Sourcing, Screening, ATS, Communication
EXPERIENCE
Talent Acquisition Executive, ABC Staffing  Jan 2022 - Present
EDUCATION
MBA (HR), Osmania University 2021`;

const b = await chromium.launch();
const errors = [];
async function ctx(opts = {}) {
  const c = await b.newContext({ viewport: { width: 1280, height: 860 }, ...opts });
  const p = await c.newPage();
  p.on('pageerror', (e) => errors.push(`${e.message}`));
  p.on('console', (m) => { if (m.type() === 'error' && !/MediaPipe|connect-src|Content Security Policy|Failed to load resource/i.test(m.text())) errors.push('console: ' + m.text().slice(0, 140)); });
  await p.goto(BASE + '#/'); await p.waitForFunction(() => window.TL && TL.ready === true, null, { timeout: 60000 });
  return p;
}
const open = async (p, hash) => { await p.goto('about:blank'); await p.goto(BASE + `?z=${Date.now()}${hash}`); await p.waitForFunction(() => window.TL && TL.ready === true, null, { timeout: 60000 }); await p.waitForTimeout(1200);
  await p.evaluate(() => document.querySelectorAll('.tlpo-ov .tlpo-btn.ghost, .tlpo-ov .tlpo-skip').forEach((x) => x.click())); };
const text = (p) => p.evaluate(() => document.querySelector('#app').innerText);

/* ---- setup: a job with real skills under the recruiter's company, a candidate, an application ---- */
const setup = await ctx();
const TITLE = `Talent Acquisition Lead ${s}`;
const J = await setup.evaluate(async ({ title, pw, em, s }) => {
  await TL.api.post('/auth/login', { email: em, password: pw, role: 'recruiter' });
  const boot = await TL.api.get('/bootstrap');
  const me = (boot.data.recruiters || []).find((r) => r.id === boot.session.id) || {};
  const r = await TL.api.post('/jobs', { title, companyId: me.companyId, location: 'Hyderabad', mode: 'Onsite', exp: '2-4 yrs', pay: '₹4-6 LPA',
    salaryMin: 4, salaryMax: 6, type: 'Full-time', status: 'open', skills: ['Recruitment', 'Sourcing', 'Screening', 'ATS', 'Onboarding'], education: 'Any Degree',
    desc: 'Hire for client roles across Hyderabad.' });
  await TL.api.put(`/jobs/${r.job.id}/screening-questions`, { questions: [] }).catch(() => {});
  await TL.api.post('/auth/logout', {});
  return { id: r.job.id, mine: s };
}, { title: TITLE, pw: PW, em: RECRUITER, s });
await setup.context().close();

const cand = await ctx();
const CAND_EMAIL = `demo.${s}@tl-verify.test`;
const reg = await cand.evaluate(async ({ em, s }) => TL.api.post('/auth/register', {
  name: 'Demo Candidate', email: em, password: `Demo${s}9xA`, phone: '9' + String(Math.floor(1e8 + Math.random() * 9e8)), preferredLocation: 'Hyderabad',
  expectedCtc: 4, noticePeriod: 'Immediate', preferredWorkModes: ['Onsite'], consent: { terms: true, communication: true, resumeProcessing: true },
}).then((r) => ({ ok: true, id: r.candidateId }), (e) => ({ ok: false, error: e.message })), { em: CAND_EMAIL, s });
must(reg.ok, 'could not register the test candidate: ' + reg.error);
await cand.evaluate((id) => TL.api.put('/candidates/' + id, { title: 'Recruiter', skills: ['Recruitment', 'Screening'], exp: '2 yrs', education: 'MBA' }).catch(() => null), reg.id);
await cand.evaluate((id) => TL.api.post('/applications', { jobId: id }).catch(() => null), J.id);

/* ---------------- 1. signed out ---------------- */
const vis = await ctx();
await check('1. signed out: #/ai-pipeline opens (it used to crash) with the real open jobs to choose from', async () => {
  await open(vis, '#/ai-pipeline');
  const t = await text(vis);
  must(/See TeamLink AI screen a candidate/.test(t), 'no hero: ' + t.slice(0, 120));
  must(!/Something needs a fresh click/.test(t), 'the page crashed');
  must(!/undefined/.test(t), 'undefined on the page');
  const opts = await vis.$$eval('select option', (o) => o.map((x) => x.textContent));
  must(opts.some((x) => x.includes(TITLE)), 'the real job is not offered: ' + opts.join(' | '));
  must(await vis.$('textarea#tlapText'), 'no resume box');
  must(!(await vis.$('nav.cp-nav')) , 'a visitor got the candidate header');
});

await check('2. running with nothing pasted asks for the resume instead of making something up', async () => {
  await vis.click('button:has-text("Run AI Pipeline")');
  await vis.waitForSelector('[role="alert"]');
  must(/Paste your resume text/.test(await text(vis)), 'no message');
});

await check('3. paste a real resume and run: the 7 steps show REAL results for that resume and that job', async () => {
  await vis.selectOption('select', J.id);
  await vis.fill('textarea#tlapText', RESUME);
  await vis.click('button:has-text("Run AI Pipeline")');
  await vis.waitForSelector('.ai-card', { timeout: 20000 });
  let t = await text(vis);
  must(/Ravi Kumar/.test(t) && /3 yrs/.test(t) && /Recruitment/.test(t), 'step 1 is not the pasted resume: ' + t.slice(0, 250));
  await vis.waitForFunction(() => /Job Matching/.test(document.querySelector('.ai-card h3').textContent), null, { timeout: 8000 });
  t = await text(vis);
  must(/4 of 5 required skills/.test(t) && /80%/.test(t), 'step 2 is not 4 of 5 / 80%: ' + t.slice(0, 300));
  must(/Onboarding/.test(t), 'the missing skill is not listed');
  await vis.waitForFunction(() => /AI Screening/.test(document.querySelector('.ai-card h3').textContent), null, { timeout: 8000 });
  t = await text(vis);
  must(/Screening score/.test(t) && /shortlist line of \d+/.test(t), 'step 3 has no real screening: ' + t.slice(0, 300));
  await vis.waitForFunction(() => /Candidate Ranking/.test(document.querySelector('.ai-card h3').textContent), null, { timeout: 8000 });
  must(/not part of a try-out/.test(await text(vis)), 'ranking is claimed for a try-out');
  await vis.waitForFunction(() => /AI Interview/.test(document.querySelector('.ai-card h3').textContent), null, { timeout: 12000 });
  const qs = await vis.$$eval('.transcript .tline.q', (a) => a.map((x) => x.textContent));
  must(qs.length === 5, 'expected 5 interview questions, saw ' + qs.length);
  await vis.waitForFunction(() => /Score &|Score &amp;|Score & Report/.test(document.querySelector('.ai-card h3').textContent), null, { timeout: 8000 });
  t = await text(vis);
  must(/Download report/.test(t) && !/simulated/i.test(t), 'no real report');
  must(!/undefined/.test(t), 'undefined in the report');
});

await check('4. a different resume gives a different answer; Reset clears the run', async () => {
  await vis.click('button:has-text("Reset")');
  await vis.fill('textarea#tlapText', RESUME.replace('Recruitment, Sourcing, Screening, ATS, Communication', 'Recruitment, Sourcing, Screening, ATS, Onboarding'));
  await vis.click('button:has-text("Run AI Pipeline")');
  await vis.waitForFunction(() => /Job Matching/.test((document.querySelector('.ai-card h3') || {}).textContent || ''), null, { timeout: 20000 });
  must(/5 of 5 required skills/.test(await text(vis)) && /100%/.test(await text(vis)), 'the score did not follow the resume');
  await vis.click('button:has-text("Reset")');
  must(/Click <b>Run|click Run AI Pipeline|and click Run AI Pipeline/i.test(await vis.evaluate(() => document.querySelector('.empty-note') ? document.querySelector('.empty-note').innerText : '')) || await vis.$('.empty-note'), 'Reset did not clear');
});

await check('5. refreshing #/ai-pipeline works, and the download is a real file', async () => {
  await open(vis, '#/ai-pipeline');
  must(/See TeamLink AI screen/.test(await text(vis)), 'a refresh broke the page');
  await vis.selectOption('select', J.id); await vis.fill('textarea#tlapText', RESUME);
  await vis.click('button:has-text("Run AI Pipeline")');
  await vis.waitForFunction(() => /Download report/.test(document.body.innerText), null, { timeout: 30000 });
  const [dl] = await Promise.all([vis.waitForEvent('download', { timeout: 8000 }), vis.click('button:has-text("Download report")')]);
  must(/\.txt$/.test(dl.suggestedFilename()), 'no file');
});

/* ---------------- 2. WhatsApp, signed out ---------------- */
await check('6. signed out: #/whatsapp-demo opens (it used to crash); WhatsApp is honestly reported as not configured', async () => {
  await open(vis, '#/whatsapp-demo');
  const t = await text(vis);
  must(/AI WhatsApp Agent/.test(t) && !/Something needs a fresh click/.test(t) && !/undefined/.test(t), 'the page crashed: ' + t.slice(0, 160));
  await vis.waitForFunction(() => /not configured/.test(document.body.innerText), null, { timeout: 8000 });
  must(/WhatsApp Agent is not configured\. Please configure the WhatsApp integration in the server environment\./.test(await text(vis)), 'not the agreed message');
  must(!/WHATSAPP_APP_SECRET|WHATSAPP_API_KEY/.test(await text(vis)), 'a visitor was shown variable names');
});

await check('7. the chat answers from REAL jobs, never invented ones', async () => {
  await vis.fill('#waChatInput', `jobs for ${TITLE.split(' ')[0]} ${TITLE.split(' ')[1]} in Hyderabad`);
  await vis.press('#waChatInput', 'Enter');
  await vis.waitForFunction((t) => document.querySelector('#waChatBody').innerText.includes(t), TITLE, { timeout: 15000 });
  const links = await vis.$$eval('#waChatBody a[href*="/job/"]', (a) => a.map((x) => x.getAttribute('href')));
  must(links.some((l) => l.includes(J.id)), 'no link to the real job: ' + links.join(','));
  await vis.fill('#waChatInput', 'jobs for Quantum Astrophysicist');
  await vis.press('#waChatInput', 'Enter');
  await vis.waitForFunction(() => /couldn't find any open jobs/.test(document.querySelector('#waChatBody').innerText), null, { timeout: 15000 });
  await vis.fill('#waChatInput', 'apply 1');
  await vis.press('#waChatInput', 'Enter');
  await vis.waitForFunction(() => /Apply Now|which job first/.test(document.querySelector('#waChatBody').innerText.split('apply 1').pop() || ''), null, { timeout: 15000 });
});

await check('8. a visitor asking about "my application status" is asked to sign in, and sees nobody\'s data', async () => {
  await vis.fill('#waChatInput', 'what is my application status?');
  await vis.press('#waChatInput', 'Enter');
  await vis.waitForFunction(() => /sign in/i.test(document.querySelector('#waChatBody').innerText.split('what is my application status?').pop() || ''), null, { timeout: 15000 });
  must(!/Demo Candidate/.test(await text(vis)), "someone's name appeared");
});

/* ---------------- 3. a signed-in candidate ---------------- */
await check('9. signed in as a candidate: the agent answers about THEIR application, and the pipeline can run on it', async () => {
  await open(cand, '#/whatsapp-demo');
  must(/Chatting as yourself/.test(await text(cand)), 'no identity line');
  await cand.fill('#waChatInput', 'what is my application status?');
  await cand.press('#waChatInput', 'Enter');
  await cand.waitForFunction((t) => document.querySelector('#waChatBody').innerText.includes(t), TITLE, { timeout: 15000 });
  await open(cand, '#/ai-pipeline');
  await cand.click('button:has-text("One of my applications")');
  await cand.waitForSelector('select:has(option:has-text("Choose"))', { timeout: 8000 });
  const apps = await cand.$$eval('select:has(option:has-text("Choose")) option', (o) => o.map((x) => ({ v: x.value, t: x.textContent })));
  const mine = apps.find((x) => x.t.includes(TITLE));
  must(mine, 'the candidate\'s own application is not offered: ' + JSON.stringify(apps));
  await cand.selectOption('select:has(option:has-text("Choose"))', mine.v);
  await cand.click('button:has-text("Run AI Pipeline")');
  await cand.waitForFunction(() => /Job Matching/.test((document.querySelector('.ai-card h3') || {}).textContent || ''), null, { timeout: 25000 });
  await cand.waitForFunction(() => /AI Screening/.test((document.querySelector('.ai-card h3') || {}).textContent || ''), null, { timeout: 10000 });
  must(/not shown to candidates/.test(await text(cand)), 'a candidate was shown a screening verdict about themselves');
});

/* ---------------- 4. a recruiter ---------------- */
await check('10. a recruiter runs it on a real application: the screening verdict and the real rank', async () => {
  const rec = await ctx();
  await rec.evaluate(({ em, pw }) => TL.api.post('/auth/login', { email: em, password: pw, role: 'recruiter' }).then(() => TL.refresh && TL.refresh()), { em: RECRUITER, pw: PW });
  await open(rec, '#/ai-pipeline');
  await rec.click('button:has-text("A real application")');
  await rec.waitForSelector('select:has(option:has-text("Choose"))', { timeout: 10000 });
  const apps = await rec.$$eval('select:has(option:has-text("Choose")) option', (o) => o.map((x) => ({ v: x.value, t: x.textContent })));
  const mine = apps.find((x) => x.t.includes(TITLE));
  must(mine && /Demo Candidate/.test(mine.t), 'the recruiter does not see the application with the candidate name: ' + JSON.stringify(apps.slice(0, 4)));
  await rec.selectOption('select:has(option:has-text("Choose"))', mine.v);
  await rec.click('button:has-text("Run AI Pipeline")');
  await rec.waitForFunction(() => /Candidate Ranking/.test((document.querySelector('.ai-card h3') || {}).textContent || ''), null, { timeout: 30000 });
  must(/ranks #1 of 1 applicants/.test(await text(rec)), 'no real rank: ' + (await text(rec)).slice(0, 200));
  await rec.context().close();
});

/* ---------------- 5. phone ---------------- */
await check('11. phone width: both pages fit with no sideways scroll', async () => {
  const m = await ctx({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  for (const h of ['#/ai-pipeline', '#/whatsapp-demo']) {
    await open(m, h);
    const w = await m.evaluate(() => ({ sw: document.documentElement.scrollWidth, vw: innerWidth }));
    must(w.sw <= w.vw + 1, `${h}: sideways scroll ${w.sw} > ${w.vw}`);
  }
  await m.context().close();
});

await check('no page errors', async () => { must(!errors.length, errors.slice(0, 3).join(' | ')); });
await b.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
