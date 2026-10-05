/**
 * The candidate dashboard + application tracker and the recruiter's ATS
 * candidate record (0111), driven through the real UI at 1280 and 390.
 *
 *   counts      Home shows Applications / Shortlisted / Interviews / Saved
 *               Jobs / Profile Strength equal to GET /candidate/dashboard,
 *               and Profile Strength equal to the profile strip
 *   tracker     the Application tracker shows each application's real
 *               status (Shortlisted, Rejected) and the six steps
 *   interviews  Upcoming interviews: Rescheduled + Online and the walk-in
 *               (Walk-in, venue); the Interviews page says the same
 *   history     My Applications: Application ID, status, last updated on
 *               every card; the search narrows the cards (server-side)
 *   ATS record  Candidate ID (TL-CAN), source, profile + resume score,
 *               matching table, interview history, timeline events, an
 *               assessment recorded through the form
 *   referral    the optional referral link -> a second candidate registers
 *               through it -> both sides show the referral
 *   audit       Admin -> Reports lists Candidate Created, Application
 *               Submitted, Status Changed, Interview Rescheduled
 *   analytics   Admin -> Analytics shows the server's numbers (job views
 *               counted from the job pages opened here)
 *   phone       no sideways scroll on Home, Applications and the record
 *   errors      no page errors anywhere
 *
 * Creates accounts and jobs, so it refuses :4323.
 *   TL_URL=http://127.0.0.1:4426/ node tools/verify-y2-dashboard-ats.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = (process.env.TL_URL || 'http://127.0.0.1:4426/').replace(/\/?$/, '/');
const u = new URL(BASE);
if (!['127.0.0.1', 'localhost'].includes(u.hostname) || u.port === '4323') {
  console.error(`Refusing to run against ${BASE}: this creates accounts. Use an isolated instance.`);
  process.exit(2);
}
const SHOTS = process.env.TL_SHOTS || join(process.cwd(), 'var', 'verify-shots');
mkdirSync(SHOTS, { recursive: true });
let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  PASS  ${name}`); }
  catch (e) { console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n')[0]}`); failed += 1; }
};
const must = (c, m) => { if (!c) throw new Error(m); };
const s = Date.now().toString(36);
const RECRUITER = process.env.TL_RECRUITER_EMAIL || 'recruiter@teamlink.com';
const ADMIN = process.env.TL_ADMIN_EMAIL || 'admin@teamlink.com';
const PW = process.env.TL_RECRUITER_PASSWORD || process.env.DEV_PASSWORD || 'TeamLink@2026';
const CPW = `Trk${s}99x`;
const ist = (n) => new Date(Date.now() + 5.5 * 3600e3 + n * 86400e3).toISOString().slice(0, 10);

const b = await chromium.launch();
const errors = [];
const watch = (p, tag) => {
  p.on('pageerror', (e) => errors.push(`${tag}: ${String(e).slice(0, 160)}`));
  p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|status of 4\d\d/.test(m.text())) errors.push(`${tag}: ${m.text().slice(0, 160)}`); });
};
const ctxFor = async (w, h, mobile) => b.newContext(mobile ? { viewport: { width: w, height: h }, isMobile: true, hasTouch: true } : { viewport: { width: w, height: h } });
const boot = async (p, path = '#/') => {
  await p.goto('about:blank');
  await p.goto(BASE + `?v=${Date.now()}${path}`);
  await p.waitForFunction(() => window.TL && TL.ready === true, null, { timeout: 30000 });
};
const go = async (p, path, wait = 2500) => {
  await boot(p, path);
  await p.waitForFunction(() => window.STATE && STATE.session, null, { timeout: 30000 }).catch(() => {});
  await p.waitForTimeout(wait);
  await p.evaluate(() => document.querySelectorAll('.tlpo-ov .tlpo-btn.ghost, .tlpo-ov .tlpo-skip').forEach((x) => x.click()));
  await p.waitForTimeout(600);
};
const call = (p, method, path, body) => p.evaluate(async ([m, pa, bo]) => {
  try { return { ok: true, v: await TL.api[m](pa, bo) }; } catch (e) { return { ok: false, message: e.message, status: e.status }; }
}, [method, path, body]);
const text = (p, sel) => p.evaluate((x) => { const el = document.querySelector(x); return el ? el.innerText.replace(/\s+/g, ' ') : ''; }, sel);
const noSideScroll = (p) => p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

/* ---------------- setup: recruiter jobs, candidate, pipeline ---------------- */
const rc = await ctxFor(1280, 900);
const R = await rc.newPage(); watch(R, 'recruiter');
await boot(R);
must((await call(R, 'post', '/auth/login', { email: RECRUITER, password: PW, role: 'recruiter' })).ok, 'recruiter login');
const bootData = (await call(R, 'get', '/bootstrap')).v;
const me = (bootData.data.recruiters || []).find((x) => x.id === bootData.session.id) || {};
const mkJob = async (body) => {
  const r = await call(R, 'post', '/jobs', { companyId: me.companyId, location: 'Hyderabad', mode: 'Onsite', exp: '0-2 yrs',
    pay: '₹3 LPA', salaryMin: 3, salaryMax: 3, status: 'open', skills: ['Java', 'SQL'], desc: 'Verification job - safe to delete.', ...body });
  must(r.ok, 'job: ' + r.message);
  await call(R, 'put', `/jobs/${r.v.job.id}/screening-questions`, { questions: [] });
  return r.v.job;
};
const J1 = await mkJob({ title: `Java Developer ${s}`, type: 'Full-time' });
const J2 = await mkJob({ title: `SQL Analyst ${s}`, type: 'Full-time' });
const JW = await mkJob({ title: `Walk-in Support ${s}`, postingKind: 'walkin', type: 'Walk-in', walkinDate: ist(5), walkinFrom: '10:00',
  walkinTo: '13:00', walkinVenue: 'Hotel Grand, Hall Y2', walkinAddress: 'Ameerpet, Hyderabad', walkinContact: 'Ravi', walkinPhone: '9000011111' });

const cc = await ctxFor(1280, 900);
const C = await cc.newPage(); watch(C, 'candidate');
await boot(C);
const candEmail = `y2.${s}@tl-verify.test`;
const reg = await call(C, 'post', '/auth/register', { name: `Yamini Tracker ${s}`, email: candEmail, password: CPW,
  phone: '9' + String(Math.floor(1e8 + Math.random() * 9e8)), preferredLocation: 'Hyderabad', expectedCtc: 3,
  noticePeriod: 'Immediate', preferredWorkModes: ['Hybrid'] });
must(reg.ok, 'register: ' + reg.message);
const apps = {};
for (const j of [J1, J2, JW]) {
  const a = await call(C, 'post', '/applications', { jobId: j.id });
  must(a.ok, 'apply: ' + a.message);
  apps[j.id] = a.v.application;
}
await call(C, 'post', `/saved-jobs/${J2.id}`, {});
const CAND = apps[J1.id].candidateId;
/* the candidate looks at two job pages: two job views */
await go(C, `#/job/${J1.id}`, 1500);
await go(C, `#/job/${J2.id}`, 1500);

const mv = async (id, stage) => { const r = await call(R, 'put', `/applications/${id}/status`, { stage }); must(r.ok, `${stage}: ${r.message}`); };
await mv(apps[J1.id].id, 'ai_screening');
await mv(apps[J1.id].id, 'shortlisted');
await mv(apps[J2.id].id, 'rejected');
const iv = await call(R, 'post', '/interviews', { candidateId: CAND, jobId: J1.id, date: ist(3), time: '11:00 AM', mode: 'Video Call', type: 'Technical' });
must(iv.ok, 'interview: ' + iv.message);
must((await call(R, 'put', `/interviews/${iv.v.interview.id}`, { date: ist(4) })).ok, 'reschedule');
await mv(apps[J1.id].id, 'shortlisted').catch(() => {});

console.log(`\ncandidate dashboard + ATS record  (${BASE})`);

let dash;
await check('Home: the five counts equal the server, Profile Strength equals the profile strip', async () => {
  await go(C, '#/candidate/home', 3500);
  dash = (await call(C, 'get', '/candidate/dashboard')).v;
  await C.waitForSelector('#tlY2Counts', { timeout: 15000 });
  const shown = await C.evaluate(() => Object.fromEntries(Array.from(document.querySelectorAll('#tlY2Counts [data-count]'))
    .map((x) => [x.getAttribute('data-count'), x.querySelector('b').textContent.trim()])));
  const c = dash.counts;
  must(shown.applications === String(c.applications) && c.applications === 3, `applications ${shown.applications}/${c.applications}`);
  must(shown.shortlisted === String(c.shortlisted) && c.shortlisted === 1, `shortlisted ${shown.shortlisted}/${c.shortlisted}`);
  must(shown.interviews === String(c.interviews) && c.interviews === 2, `interviews ${shown.interviews}/${c.interviews}`);
  must(shown.savedJobs === String(c.savedJobs) && c.savedJobs === 1, `saved ${shown.savedJobs}/${c.savedJobs}`);
  must(shown.profileStrength === c.profileStrength + '%', `strength ${shown.profileStrength}/${c.profileStrength}`);
  const strip = await C.evaluate(() => capCompletion(DATA.candidateById(STATE.session.id)));
  must(strip === c.profileStrength, `strip ${strip} vs server ${c.profileStrength}`);
});

await check('Home: the Application tracker shows the real statuses and the six steps', async () => {
  const t = await text(C, '#tlY2Tracker');
  must(/Application tracker/.test(t), t.slice(0, 80));
  for (const w of ['Applied', 'HR Review', 'Shortlisted', 'Interview', 'Offer', 'Hired', 'Rejected', 'On Hold']) must(t.includes(w), 'missing ' + w);
  const rows = await C.evaluate(() => Array.from(document.querySelectorAll('#tlY2Tracker .tly2-app')).map((x) => ({
    id: x.getAttribute('data-app'), status: x.querySelector('.tly2-status').textContent.trim(),
    on: (x.querySelector('.cp-step.on') || {}).textContent || '' })));
  const j1 = rows.find((r) => r.id === apps[J1.id].id);
  const j2 = rows.find((r) => r.id === apps[J2.id].id);
  must(j1 && j1.status === 'Shortlisted' && j1.on === 'Shortlisted', JSON.stringify(j1));
  must(j2 && j2.status === 'Rejected', JSON.stringify(j2));
  must(!/Client/.test(t), 'the word Client reached the candidate');
});

await check('Home: Upcoming interviews - Rescheduled online interview and the walk-in with its venue', async () => {
  const t = await text(C, '#tlY2Interviews');
  must(/Rescheduled/.test(t) && /Online/.test(t), t);
  must(/Walk-in/.test(t) && /Hotel Grand, Hall Y2/.test(t), t);
  must(!/77|score/i.test(t), 'a score reached the candidate');
  const more = await text(C, '#tlY2More');
  must(/Saved jobs/.test(more) && more.includes(J2.title) && /Notifications/.test(more), more.slice(0, 200));
});
await C.screenshot({ path: join(SHOTS, 'y2-home-desktop.png'), fullPage: true });

await check('My Applications: Application ID, status and last updated on every card; search narrows them', async () => {
  await go(C, '#/candidate/applications', 3500);
  await C.waitForSelector('.tly2-hist', { timeout: 15000 });
  const metas = await C.evaluate(() => Array.from(document.querySelectorAll('.tly2-hist')).map((x) => x.innerText.replace(/\s+/g, ' ')));
  must(metas.length === 3, `${metas.length} cards with history`);
  must(metas.every((m) => /Application ID TL-APP-/.test(m) && /Last updated/.test(m)), metas[0]);
  must(metas.some((m) => /Status Rejected/.test(m)) && metas.some((m) => /Job type Walk-in/.test(m)), metas.join(' | '));
  await C.fill('#tlY2HistQ', 'SQL Analyst');
  await C.waitForTimeout(1500);
  const vis = await C.evaluate(() => Array.from(document.querySelectorAll('.tly2-hist')).filter((x) => x.closest('.cp-card').style.display !== 'none').length);
  must(vis === 1, `${vis} cards after searching`);
  must(/of 1\b/.test(await text(C, '#tlY2HistInfo')), await text(C, '#tlY2HistInfo'));
  await C.fill('#tlY2HistQ', '');
  await C.waitForTimeout(1200);
});

await check('Interviews page: state, mode and the walk-in interview', async () => {
  await go(C, '#/candidate/interviews', 3500);
  await C.waitForSelector('.tly2-ivmeta', { timeout: 15000 });
  const t = await text(C, '.cp-wrap');
  must(/Rescheduled/.test(t) && /Online/.test(t), 'interview card');
  must(/Walk-in/.test(t) && /Hotel Grand, Hall Y2/.test(t), 'walk-in card');
  must(/Upcoming \(2\)/.test(t), 'upcoming count ' + (t.match(/Upcoming \(\d+\)/) || [])[0]);
});

let code;
await check('Referral (optional): the link, a friend registers through it, both sides see it', async () => {
  await go(C, '#/candidate/home', 3000);
  await C.click('#tlY2Ref button');
  await C.waitForSelector('#tlY2RefCode', { timeout: 10000 });
  code = (await C.textContent('#tlY2RefCode')).trim();
  const link = await C.inputValue('#tlY2RefLink');
  must(/^R[0-9A-F]{8}$/.test(code) && link.includes('ref=' + code), link);
  const fc = await ctxFor(1280, 900);
  const F = await fc.newPage(); watch(F, 'friend');
  await F.goto(link);
  await F.waitForFunction(() => window.TL && TL.ready === true);
  const r = await call(F, 'post', '/auth/register', { name: `Friend ${s}`, email: `friend.${s}@tl-verify.test`, password: CPW,
    phone: '9' + String(Math.floor(1e8 + Math.random() * 9e8)), preferredLocation: 'Hyderabad', expectedCtc: 3,
    noticePeriod: 'Immediate', preferredWorkModes: ['Hybrid'] });
  must(r.ok, 'friend register ' + r.message);
  await go(F, '#/candidate/home', 2500);
  const mine = (await call(C, 'get', '/candidate/referral')).v;
  must(mine.referrals.length === 1 && mine.referrals[0].status === 'registered', JSON.stringify(mine.referrals));
  await fc.close();
});

await check('Recruiter: the ATS record - Candidate ID, source, scores, matching, interviews, timeline', async () => {
  await go(R, `#/recruiter/candidate-profile?id=${CAND}`, 3500);
  await R.waitForSelector('#tlY2Record', { timeout: 15000 });
  const f = await R.evaluate(() => Object.fromEntries(Array.from(document.querySelectorAll('#tlY2Record [data-f]'))
    .map((x) => [x.getAttribute('data-f'), (x.querySelector('.v') || x).innerText.replace(/\s+/g, ' ').trim()])));
  must(/^TL-CAN-\d{6}$/.test(f.code), 'Candidate ID ' + f.code);
  must(f.email === candEmail && /^\d{10}$/.test(f.mobile.replace(/\D/g, '').slice(-10)), 'contact');
  must(/^\d+%$/.test(f.profile), 'profile ' + f.profile);
  must(/Direct Registration/.test(f.source), 'source ' + f.source);
  /* the internal label of `shortlisted` is "Recruiter Review" (0052) - staff wording */
  must(f.stage.includes(J1.title) && /Recruiter Review|Shortlisted|Interview/.test(f.stage), 'stage ' + f.stage);
  must(f.apps === '3' && f.ivs === '1', `apps ${f.apps} ivs ${f.ivs}`);
  must(/Java/.test(f.skills) || f.skills.length > 0, 'skills');
  const rows = await R.evaluate(() => document.querySelectorAll('#tlY2Matching tbody tr[data-app]').length);
  must(rows === 3, rows + ' matching rows');
  const m = await text(R, '#tlY2Matching');
  must(/Eligible|Check/.test(m) && /TeamLink Website/.test(m) && /Walk-in Application/.test(m), m.slice(0, 300));
  must(/Rescheduled/.test(await text(R, '#tlY2IvHistory')), 'interview history');
  const tl = await text(R, '#tlY2Timeline');
  for (const k of ['Registered', 'Applied', 'Shortlisted', 'Rejected', 'Interview Scheduled', 'Interview Rescheduled']) must(tl.includes(k), 'timeline ' + k);
});

await check('Recruiter: an assessment result through the form; the Talent Pool filter finds it', async () => {
  await R.click('#tlY2Assessments summary');
  await R.fill('#tlY2AsName', 'Java');
  await R.selectOption('#tlY2AsCat', 'Java');
  await R.fill('#tlY2AsScore', '42');
  await R.fill('#tlY2AsMax', '50');
  await R.click('#tlY2Assessments button.btn-primary');
  await R.waitForFunction(() => /42 \/ 50 \(84%\)/.test((document.getElementById('tlY2Assessments') || {}).innerText || ''), null, { timeout: 10000 });
  const hit = (await call(R, 'get', '/candidates?assessment=java&assessmentMin=80&limit=200')).v;
  must((hit.candidates || []).some((x) => x.id === CAND), 'filter');
  const cand = (await call(C, 'post', `/ats/candidates/${CAND}/assessments`, { name: 'Self', score: 100 }));
  must(!cand.ok && cand.status === 403, 'a candidate may not write a score');
});
await R.screenshot({ path: join(SHOTS, 'y2-recruiter-record.png'), fullPage: true });

const ac = await ctxFor(1280, 900);
const A = await ac.newPage(); watch(A, 'admin');
await boot(A);
must((await call(A, 'post', '/auth/login', { email: ADMIN, password: PW, role: 'admin' })).ok, 'admin login');

await check('Admin -> Reports: the audit log lists the events with user, date, entity and id', async () => {
  await go(A, '#/admin/reports', 3500);
  await A.waitForSelector('#tlY2AuditTable', { timeout: 15000 });
  const acts = await A.evaluate(() => Array.from(document.querySelectorAll('#tlY2AuditTable tbody tr')).map((x) => x.getAttribute('data-action')));
  for (const a of ['candidate.created', 'application.submitted', 'status.changed', 'interview.rescheduled']) must(acts.includes(a), 'missing ' + a);
  const row = await A.evaluate(() => { const r = document.querySelector('#tlY2AuditTable tr[data-action="status.changed"]'); return r ? Array.from(r.cells).map((c) => c.innerText.trim()) : []; });
  must(row.some((c) => /\d{2} \w{3} \d{4}, \d{2}:\d{2}/.test(c)) && row.includes(RECRUITER) && row.includes('Status Changed')
    && row.includes('application') && row.some((c) => /^app_/.test(c)), JSON.stringify(row));
  await A.selectOption('#tlY2Audit select', 'interview.rescheduled');
  await A.waitForTimeout(1500);
  const only = await A.evaluate(() => Array.from(document.querySelectorAll('#tlY2AuditTable tbody tr[data-action]')).map((x) => x.getAttribute('data-action')));
  must(only.length && only.every((x) => x === 'interview.rescheduled'), only.join(','));
  must(/hand-off/i.test(await text(A, '#tlY2Handoffs')), 'hand-off queue panel');
});

await check('Admin -> Analytics: the server numbers, by job type, views counted from the job pages', async () => {
  await go(A, '#/admin/analytics', 3500);
  await A.waitForSelector('#tlY2AnaType', { timeout: 15000 });
  const a = (await call(A, 'get', '/admin/portal-analytics?days=30')).v;
  const cells = await A.evaluate(() => Array.from(document.querySelectorAll('#tlY2AnaType tbody tr')).map((r) => Array.from(r.cells).map((c) => c.innerText.trim())));
  const reg = cells.find((r) => r[0] === 'Regular'), wk = cells.find((r) => r[0] === 'Walk-in');
  must(reg && reg[2] === String(a.jobs.byType.regular.views) && reg[3] === String(a.jobs.byType.regular.applications), JSON.stringify(reg));
  must(wk && wk[3] === String(a.walkin.applications), JSON.stringify(wk));
  must(a.jobs.byType.regular.views >= 2 && a.walkin.applications >= 1, JSON.stringify(a.jobs.byType));
  const t = await text(A, '#tlY2Analytics');
  must(!t.includes(candEmail) && !t.includes('Yamini'), 'personal data in analytics');
  must(t.includes(String(a.candidates.registrations)), 'registrations');
});
await A.screenshot({ path: join(SHOTS, 'y2-admin-analytics.png'), fullPage: true });

await check('phone 390: Home, Applications and the ATS record have no sideways scroll', async () => {
  const m = await ctxFor(390, 844, true);
  await m.addCookies(await cc.cookies());
  const P = await m.newPage(); watch(P, 'phone');
  await go(P, '#/candidate/home', 3500);
  await P.waitForSelector('#tlY2Counts', { timeout: 15000 });
  must(await noSideScroll(P) <= 0, 'home scrolls sideways');
  await P.screenshot({ path: join(SHOTS, 'y2-home-phone.png'), fullPage: true });
  await go(P, '#/candidate/applications', 3000);
  await P.waitForSelector('.tly2-hist', { timeout: 15000 });
  must(await noSideScroll(P) <= 0, 'applications scroll sideways');
  await m.close();
  const mr = await ctxFor(390, 844, true);
  await mr.addCookies(await rc.cookies());
  const PR = await mr.newPage(); watch(PR, 'phone-recruiter');
  await go(PR, `#/recruiter/candidate-profile?id=${CAND}`, 3500);
  await PR.waitForSelector('#tlY2Record', { timeout: 15000 });
  must(await noSideScroll(PR) <= 0, 'record scrolls sideways');
  await mr.close();
});

await check('no page errors on the way', async () => { must(!errors.length, errors.slice(0, 5).join(' | ')); });

await b.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
