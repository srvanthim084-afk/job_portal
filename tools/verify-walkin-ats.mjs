/**
 * The walk-in ATS (0107) in a real browser - owner's Section 23.
 *
 *   setup  two recruiters (created by the admin), a regular and a walk-in job
 *          (today, check-in window open) by recruiter A, four candidates who
 *          register and apply through the API, one resume uploaded
 *   1  Manage Jobs -> View Applicants opens the job's applicant page: tiles add
 *      up, every walk-in applicant is Registered, 23.3 columns present
 *   2  server-side search (name / mobile / Application ID) and the Stage filter
 *   3  open an applicant and go back: the search and filters are still set
 *   4  details page: candidate, job, application, walk-in block, timeline,
 *      other applications; add a note, rate 4 stars, Mark Attended
 *   5  an invalid move is not offered and the server refuses it directly
 *   6  bulk Mark Interviewed on two (one valid, one not): "1 updated, 1 skipped"
 *   7  Check-in tab: find by mobile, Check In -> "Already checked in"; again = no duplicate
 *   8  resume: View / Download work for A (authenticated fetch); logged out = 401;
 *      recruiter B = refused
 *   9  export CSV: the 23.19 columns
 *  10  edit the walk-in venue -> Update history shows old/new; Send now -> notified
 *  11  recruiter B opening A's job by URL is denied
 *  12  two recruiters on one applicant (A twice): the second save gets the conflict
 *  13  the candidate's My Applications: Registered rail, Application ID, walk-in
 *      details; no notes, no rating, no "No Show"
 *  14  regular job: View Applicants still works, stage dropdown moves it (existing route)
 *
 * Screenshots: scratchpad or var/verify-shots/walkin-ats-*.png (look at them).
 *
 * Creates accounts, so it refuses :4323. Run against an isolated instance:
 *   TL_URL=http://127.0.0.1:4422/ node tools/verify-walkin-ats.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = (process.env.TL_URL || 'http://127.0.0.1:4422/').replace(/\/?$/, '/');
const url = new URL(BASE);
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.port === '4323') {
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
const stamp = Date.now().toString(36);
const ADMIN = { email: process.env.TL_ADMIN_EMAIL || 'admin@teamlink.com', password: process.env.TL_PASSWORD || 'TeamLink@2026' };
const PW = `Walkin${stamp}9`;
const IST = 330 * 60000;
const hhmm = (ms) => new Date(ms + IST).toISOString().slice(11, 16);
const today = new Date(Date.now() + IST).toISOString().slice(0, 10);
const phone = () => '9' + String(Math.floor(1e8 + Math.random() * 9e8));

const browser = await chromium.launch();
async function open(ctx, hash) {
  const page = await ctx.newPage();
  await page.goto(BASE + (hash || '#/'));
  await page.waitForFunction(() => window.TL && TL.ready === true, null, { timeout: 30000 });
  await page.waitForTimeout(400);
  return page;
}
const api = (page, method, path, body) => page.evaluate(([m, p, b]) => window.TL.api[m](p, b)
  .then((v) => ({ ok: true, v }), (e) => ({ ok: false, code: e.code, message: e.message })), [method, path, body]);
async function signIn(ctx, email, password, role) {
  const page = await open(ctx, '#/');
  const r = await api(page, 'post', '/auth/login', { email, password, role });
  must(r.ok, `sign-in failed for ${email}: ${r.message}`);
  if (r.v && (r.v.mustChangePassword || (r.v.session && r.v.session.mustChangePassword))) {
    must((await api(page, 'post', '/auth/password', { current: password, next: password + 'x' })).ok, 'password change');
    must((await api(page, 'post', '/auth/password', { current: password + 'x', next: password })).ok, 'password change back');
  }
  await page.reload();
  await page.waitForFunction(() => window.TL && TL.ready === true && window.STATE && STATE.session, null, { timeout: 30000 });
  return page;
}
const go = async (page, hash, wait = 1200) => { await page.evaluate((hh) => { location.hash = hh; }, hash); await page.waitForTimeout(wait); };
const shot = (page, name) => page.screenshot({ path: join(SHOTS, `walkin-ats-${name}.png`), fullPage: true });
const text = (page, sel) => page.$eval(sel, (e) => e.innerText).catch(() => '');
const waitText = (page, sel, s, ms = 15000) => page.waitForFunction(([q, x]) => { const e = document.querySelector(q); return !!e && e.innerText.includes(x); }, [sel, s], { timeout: ms }).then(() => true, () => false);
const clickText = (page, sel, re) => page.evaluate(([s, r]) => {
  const rx = new RegExp(r);
  const b = Array.from(document.querySelectorAll(s)).find((x) => rx.test(x.textContent) && x.offsetParent);
  if (!b) return false; b.click(); return true;
}, [sel, re.source]);

/* ---------------- setup ---------------- */
const adminCtx = await browser.newContext({ viewport: { width: 1400, height: 950 } });
const admin = await signIn(adminCtx, ADMIN.email, ADMIN.password, 'admin');
const companies = await api(admin, 'get', '/companies');
const COMPANY = companies.ok && (companies.v.companies || [])[0] && companies.v.companies[0].id;
if (!COMPANY) { console.log('No company on this instance.'); await browser.close(); process.exit(1); }
const RA = { name: `Anita ${stamp}`, email: `anita.${stamp}@tl-verify.test` };
const RB = { name: `Bharat ${stamp}`, email: `bharat.${stamp}@tl-verify.test` };
for (const p of [RA, RB]) {
  const r = await api(admin, 'post', '/staff/recruiters', { name: p.name, email: p.email, password: PW, companyId: COMPANY });
  must(r.ok, `could not create ${p.name}: ${r.message}`);
}
const ctxA = await browser.newContext({ viewport: { width: 1400, height: 950 }, acceptDownloads: true });
const ctxB = await browser.newContext({ viewport: { width: 1400, height: 950 } });
const A = await signIn(ctxA, RA.email, PW, 'recruiter');
const B = await signIn(ctxB, RB.email, PW, 'recruiter');

const from = hhmm(Date.now() - 30 * 60000) > hhmm(Date.now()) ? '00:00' : hhmm(Date.now() - 30 * 60000);
const to = hhmm(Date.now() + 3 * 3600000) < hhmm(Date.now()) ? '23:59' : hhmm(Date.now() + 3 * 3600000);
const mkJob = async (body) => {
  const r = await api(A, 'post', '/jobs', { companyId: COMPANY, location: 'Hyderabad', mode: 'Onsite', exp: '0-2 yrs',
    pay: '₹3 LPA', status: 'open', skills: ['Communication'], desc: 'Verification job - safe to delete.', ...body });
  must(r.ok, `job: ${r.message}`);
  await api(A, 'put', `/jobs/${r.v.job.id}/screening-questions`, { questions: [] });
  return r.v.job;
};
const WJ = await mkJob({ title: `Walk-in Support Executive ${stamp}`, postingKind: 'walkin', type: 'Walk-in',
  walkinDate: today, walkinFrom: from, walkinTo: to, walkinVenue: 'Hotel Grand, Hall A', walkinContact: 'Ravi', walkinPhone: '9000011111' });
const RJ = await mkJob({ title: `Regular Accounts Assistant ${stamp}`, type: 'Full-time' });

const cands = [];
for (const [i, n] of ['Asha', 'Bala', 'Chitra', 'Dev'].entries()) {
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 900 } });
  const p = await open(ctx, '#/');
  const c = { name: `${n} Verify ${stamp}`, email: `${n.toLowerCase()}.${stamp}@tl-verify.test`, phone: phone(), ctx, page: p };
  const reg = await api(p, 'post', '/auth/register', { name: c.name, email: c.email, password: PW, phone: c.phone,
    preferredLocation: 'Hyderabad', expectedCtc: 3, noticePeriod: 'Immediate', preferredWorkModes: ['Work From Office'] });
  must(reg.ok, `register ${n}: ${reg.message}`);
  const ap = await api(p, 'post', '/applications', { jobId: WJ.id });
  must(ap.ok, `apply ${n}: ${ap.message}`);
  c.app = ap.v.application;
  if (i === 0) {
    const a2 = await api(p, 'post', '/applications', { jobId: RJ.id });
    must(a2.ok, 'apply regular');
    c.regApp = a2.v.application;
    const up = await p.evaluate(async () => {
      const pdf = '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n';
      const fd = new FormData();
      fd.append('resume', new Blob([pdf], { type: 'application/pdf' }), 'Asha_Verify_CV.pdf');
      const m = document.cookie.match(/tl_csrf=([^;]+)/);
      const r = await fetch('/api/uploads/resume', { method: 'POST', body: fd, credentials: 'same-origin', headers: { 'x-csrf-token': m ? m[1] : '' } });
      return r.status;
    });
    must(up === 201, 'resume upload ' + up);
  }
  cands.push(c);
}
const [C1, C2, C3, C4] = cands;
await A.reload();
await A.waitForFunction(() => window.TL && TL.ready === true, null, { timeout: 30000 });

console.log(`\nwalk-in ATS  (${BASE})`);

await check('1. Manage Jobs -> View Applicants opens the job\'s applicant page; tiles add up; all Registered', async () => {
  await go(A, '#/recruiter/manage-jobs');
  const opened = await A.evaluate((id) => { window.mjApplicantsModal(id); return location.hash; }, WJ.id);
  await A.waitForTimeout(1800);
  must(/applicants=/.test(await A.evaluate(() => location.hash)), 'route ' + opened);
  await A.waitForSelector('.tlwa-table tbody tr', { timeout: 15000 });
  const tiles = await A.$$eval('.tlwa-tiles .stat-tile', (els) => els.map((e) => [e.querySelector('.lbl').textContent, e.querySelector('.val').textContent]));
  const t = Object.fromEntries(tiles);
  must(t['Total Registrations'] === '4' && t.Registered === '4', 'tiles ' + JSON.stringify(t));
  must(t['Slot Capacity'] === 'No limit', 'capacity tile');
  const heads = await A.$$eval('.tlwa-table thead th', (els) => els.map((e) => e.textContent));
  for (const hh of ['Application ID', 'Candidate', 'Mobile / Email', 'Location', 'Qualification', 'Experience', 'Salary (current / expected)', 'Notice', 'Resume', 'Job', 'Applied', 'Stage', 'Status', 'Rating']) {
    must(heads.includes(hh), 'column ' + hh);
  }
  const stages = await A.$$eval('.tlwa-table tbody tr td:nth-child(13)', (els) => els.map((e) => e.innerText.trim()));
  must(stages.length === 4 && stages.every((s) => s.startsWith('Registered')), 'stages ' + stages);
  await shot(A, '1-applicants');
});

await check('2. server-side search by name, mobile and Application ID; Stage filter', async () => {
  const rows = async () => A.$$eval('.tlwa-table tbody tr', (els) => els.map((e) => e.innerText));
  await A.fill('#tlwaQ', C2.name);
  await A.click('text=🔍 Search'); await A.waitForTimeout(1200);
  let r = await rows(); must(r.length === 1 && r[0].includes(C2.name), 'name ' + r.length);
  await A.fill('#tlwaQ', C3.phone); await A.click('text=🔍 Search'); await A.waitForTimeout(1200);
  r = await rows(); must(r.length === 1 && r[0].includes(C3.name), 'mobile');
  await A.fill('#tlwaQ', C4.app.reference); await A.click('text=🔍 Search'); await A.waitForTimeout(1200);
  r = await rows(); must(r.length === 1 && r[0].includes(C4.name), 'application id');
  await A.fill('#tlwaQ', ''); await A.click('text=🔍 Search'); await A.waitForTimeout(1000);
  await A.selectOption('.mj-toolbar select:nth-of-type(2)', 'attended'); await A.waitForTimeout(1200);
  r = await rows(); must(r.length === 1 && /No applicants match/.test(r[0]), 'stage filter attended -> none');
  await A.selectOption('.mj-toolbar select:nth-of-type(2)', 'registered'); await A.waitForTimeout(1200);
  r = await rows(); must(r.length === 4, 'stage filter registered -> 4');
});

await check('3. filters persist after opening an applicant and coming back', async () => {
  await A.fill('#tlwaQ', 'Verify'); await A.click('text=🔍 Search'); await A.waitForTimeout(1200);
  await A.evaluate((id) => TLWalkinAts.open(id), C1.app.id);
  await A.waitForSelector('.tlwa-grid', { timeout: 15000 });
  await A.click('text=← Back to applicants'); await A.waitForTimeout(1500);
  const q = await A.$eval('#tlwaQ', (e) => e.value);
  const st = await A.$eval('.mj-toolbar select:nth-of-type(2)', (e) => e.value);
  must(q === 'Verify' && st === 'registered', `after back: q=${q} stage=${st}`);
  // and across a reload (sessionStorage)
  await A.reload(); await A.waitForFunction(() => window.TL && TL.ready === true, null, { timeout: 30000 }); await A.waitForTimeout(1500);
  must((await A.$eval('#tlwaQ', (e) => e.value)) === 'Verify', 'after reload');
  await A.evaluate(() => TLWalkinAts.clear()); await A.waitForTimeout(1000);
});

await check('4. details page: every block; add a note, rate 4 stars, Mark Attended', async () => {
  await A.evaluate((id) => TLWalkinAts.open(id), C1.app.id);
  await A.waitForSelector('.tlwa-grid', { timeout: 15000 });
  const all = await text(A, '.tlwa');
  for (const s of ['Candidate ID', 'Application ID', 'Walk-in information', 'Venue', 'Hotel Grand, Hall A', 'Contact person', 'Check-in time',
    'Recruiter notes', 'Timeline', 'Applied → Registered', 'Every application by this candidate', RJ.id]) must(all.includes(s), 'missing ' + s);
  await A.fill('#tlwaNewNote', `Good communication <b>${stamp}</b>`);
  await clickText(A, 'button', /^Add note$/);
  must(await waitText(A, '.tlwa', `Good communication <b>${stamp}</b>`), 'note shown as text (escaped)');
  await A.click('.tlwa-star:nth-of-type(4)');
  must(await A.waitForFunction(() => document.querySelectorAll('.tlwa-star.on').length === 4, null, { timeout: 15000 }).then(() => true, () => false), 'stars');
  await clickText(A, 'button', /^Mark Attended$/);
  await waitText(A, '.tlwa', 'Registered → Attended');
  const after = await text(A, '.tlwa');
  must(after.includes('Registered → Attended'), 'timeline has the move');
  must(after.includes('Attended time'), 'walk-in block');
  await shot(A, '4-details');
});

await check('5. an invalid move is not offered, and the server refuses it directly', async () => {
  const offered = await A.$$eval('.tlwa-acts button', (els) => els.map((e) => e.textContent));
  must(!offered.some((t) => /Mark Selected/.test(t)), 'Selected offered from Attended: ' + offered);
  const r = await api(A, 'post', `/ats/applications/${C2.app.id}/stage`, { stage: 'selected' });
  must(!r.ok && r.code === 'INVALID_TRANSITION' && /Registered to Selected/.test(r.message), 'server: ' + r.code + ' ' + r.message);
});

await check('6. bulk Mark Interviewed (one valid, one not): "1 updated, 1 skipped" with the name', async () => {
  await A.evaluate(() => TLWalkinAts.back()); await A.waitForTimeout(1500);
  await A.evaluate(([a, b]) => { TLWalkinAts.sel(a, true); TLWalkinAts.sel(b, true); }, [C1.app.id, C2.app.id]);
  await A.waitForTimeout(300);
  must(await clickText(A, '.mj-bulkbar button', /^Mark Interviewed$/), 'bulk button');
  await A.waitForTimeout(600);
  must(/Move 2 applicants to Interviewed/.test(await text(A, '#fcrModalHost')), 'confirmation');
  await clickText(A, '#fcrModalHost button', /^Move 2$/);
  await waitText(A, '#fcrModalHost', 'updated,');
  const res = await text(A, '#fcrModalHost');
  await A.evaluate(() => { const b = document.querySelector('#fcrModalHost'); if (b && !/updated,/.test(b.innerText)) b.remove(); });
  must(/1 updated, 1 skipped \(invalid transition\)/.test(res) && res.includes(C2.name), 'result: ' + res.slice(0, 200));
  await shot(A, '6-bulk-result');
  await clickText(A, '#fcrModalHost button', /^Done$/);
});

await check('7. Check-in: find by mobile, Check In, then "Already checked in" and no duplicate', async () => {
  await A.evaluate(() => window.fcrCloseModal && fcrCloseModal());
  await A.evaluate(() => TLWalkinAts.tab('checkin')); await A.waitForTimeout(1200);
  must(/Check-in is open/.test(await text(A, '.tlwa-window')), 'window open');
  await A.fill('#tlwaCheckQ', C3.phone); await A.click('text=Find'); await waitText(A, '.tlwa', C3.name);
  must(await clickText(A, '.tlwa button', /^Check In$/), 'Check In button');
  must(await waitText(A, '.tlwa', 'Already checked in'), 'state after check-in');
  const again = await api(A, 'post', `/ats/applications/${C3.app.id}/check-in`, { action: 'check_in' });
  must(again.ok && again.v.result.already === true, 'second check-in is a no-op');
  const tl = await api(A, 'get', `/ats/applications/${C3.app.id}/timeline`);
  must(tl.v.timeline.filter((x) => x.kind === 'checked_in').length === 1, 'one check-in entry');
  await shot(A, '7-checkin');
  await A.evaluate(() => TLWalkinAts.tab('applicants')); await A.waitForTimeout(800);
});

await check('8. resume: View / Download for A; logged out 401; recruiter B refused', async () => {
  const status = (page, path) => page.evaluate((p) => fetch(p, { credentials: 'same-origin' }).then((r) => r.status), path);
  const path = `/api/ats/applications/${C1.app.id}/resume`;
  must((await status(A, path)) === 200, 'A view');
  const [dl] = await Promise.all([A.waitForEvent('download', { timeout: 10000 }), A.evaluate((id) => TLWalkinAts.resume(id, true), C1.app.id)]);
  must(/Asha_Verify_CV\.pdf/.test(dl.suggestedFilename()), 'download name ' + dl.suggestedFilename());
  must((await status(B, path)) === 404, 'B refused');
  const anonCtx = await browser.newContext(); const anon = await open(anonCtx, '#/');
  must((await status(anon, path)) === 401, 'logged out');
  must((await status(C1.page, path)) === 200, 'the candidate themselves');
  must((await status(C2.page, path)) === 404, 'another candidate');
  await anonCtx.close();
});

await check('9. export CSV with the 23.19 columns', async () => {
  const [dl] = await Promise.all([A.waitForEvent('download', { timeout: 15000 }), A.evaluate(() => TLWalkinAts.exportList('csv'))]);
  const p = await dl.path();
  const { readFileSync } = await import('node:fs');
  const csv = readFileSync(p, 'utf8').replace(/^﻿/, '');
  const header = csv.split(/\r?\n/)[0];
  for (const col of ['Stage', 'Status', 'Rating', 'Checked-in time', 'Attended time', 'Interviewed time', 'Walk-in status', 'Application Source']) must(header.includes(col), 'column ' + col);
  must(!csv.includes(`Good communication`), 'no notes in a general export');
  must(csv.split(/\r?\n/).filter(Boolean).length === 5, 'four applicants + header');
});

await check('10. edit the walk-in venue -> Update history old/new; Send now -> applicants notified', async () => {
  const r = await api(A, 'put', `/jobs/${WJ.id}`, { title: WJ.title, companyId: COMPANY, postingKind: 'walkin', type: 'Walk-in', walkinVenue: 'Hotel Grand Annexe, Hall B' });
  must(r.ok, 'edit ' + r.message);
  await A.evaluate(() => TLWalkinAts.tab('history')); await A.waitForTimeout(2500);
  let t = await text(A, '.tlwa');
  must(t.includes('Venue') && t.includes('Hotel Grand, Hall A') && t.includes('Hotel Grand Annexe, Hall B'), 'history old/new');
  if (/Send now/.test(t)) { await clickText(A, '.tlwa button', /^Send now$/); await A.waitForTimeout(3000); }
  else await A.waitForTimeout(16000);       // the sweep (merge window 5 s on this instance)
  await A.evaluate(() => TLWalkinAts.tab('history')); await A.waitForTimeout(2000);
  t = await text(A, '.tlwa');
  must(/Sent/.test(t) && /Applicants notified/.test(t), 'notification recorded: ' + t.slice(0, 300));
  const bell = await api(C2.page, 'get', '/bootstrap');
  must(JSON.stringify(bell.v.data.notifications).includes('Hotel Grand Annexe, Hall B'), 'candidate told the new venue');
  await shot(A, '10-history');
});

await check('11. recruiter B opening A\'s job by URL is denied', async () => {
  await go(B, `#/recruiter/manage-jobs?applicants=${encodeURIComponent(WJ.id)}`, 2500);
  const t = await text(B, '#app');
  must(/does not exist or is not one of yours/.test(t), 'B sees: ' + t.slice(0, 160));
  must(!t.includes(C1.name), 'no applicant names');
  await go(B, `#/recruiter/manage-jobs?applicants=${encodeURIComponent(WJ.id)}&app=${encodeURIComponent(C1.app.id)}`, 2500);
  must(/not one you can open/.test(await text(B, '#app')), 'details denied');
  await shot(B, '11-denied');
});

await check('12. two recruiters on one applicant: the second save gets the conflict, nothing overwritten', async () => {
  const A2 = await ctxA.newPage();
  await A2.goto(BASE + `#/recruiter/manage-jobs?applicants=${encodeURIComponent(WJ.id)}&app=${encodeURIComponent(C4.app.id)}`);
  await A2.waitForFunction(() => window.TL && TL.ready === true, null, { timeout: 30000 });
  await A.evaluate((id) => TLWalkinAts.open(id), C4.app.id);
  await A.waitForSelector('.tlwa-grid', { timeout: 15000 }); await A2.waitForSelector('.tlwa-grid', { timeout: 15000 });
  await clickText(A2, 'button', /^Mark Attended$/); await A2.waitForTimeout(1500);
  const toast = A.waitForSelector('.toast', { timeout: 6000 }).then((e) => e.innerText());
  await clickText(A, 'button', /^Mark Rejected$/);
  const msg = await toast;
  must(msg.includes('This applicant was updated by someone else. Refresh to see the latest.'), 'toast: ' + msg);
  const now = await api(A, 'get', `/ats/applications/${C4.app.id}`);
  must(now.v.application.stage === 'attended', 'stage kept: ' + now.v.application.stage);
  await A2.close();
});

await check('13. the candidate: My Applications shows the walk-in rail, Application ID and details - nothing internal', async () => {
  const p = C2.page;
  await p.reload(); await p.waitForFunction(() => window.TL && TL.ready === true, null, { timeout: 30000 });
  await go(p, '#/candidate/applications', 2500);
  await p.waitForTimeout(1500);
  await p.evaluate(() => document.querySelectorAll('.tlpo-ov .tlpo-btn.ghost, .tlpo-ov .tlpo-skip').forEach((b) => b.click()));
  await p.waitForTimeout(600);
  const t = await text(p, '#app');
  must(t.includes(C2.app.reference), 'Application ID');
  must(t.includes('Registered') && t.includes('Under review'), 'walk-in rail');
  must(t.includes('Hotel Grand Annexe, Hall B'), 'walk-in venue');
  for (const bad of ['No Show', 'Good communication', 'Interviewed', 'Rating']) must(!t.includes(bad), 'leaks ' + bad);
  await shot(p, '13-candidate');
});

await check('14. regular job: View Applicants works and a stage move uses the existing route', async () => {
  await A.evaluate((id) => window.mjApplicantsModal(id), RJ.id); await A.waitForTimeout(1500);
  await A.waitForSelector('.tlwa-table tbody tr', { timeout: 15000 });
  const tiles = await A.$$eval('.tlwa-tiles .lbl', (els) => els.map((e) => e.textContent));
  must(tiles.includes('New Applications') && !tiles.includes('Total Registrations'), 'regular tiles');
  await A.evaluate((id) => TLWalkinAts.open(id), C1.regApp.id);
  await A.waitForSelector('#tlwaStageSel', { timeout: 15000 });
  await A.selectOption('#tlwaStageSel', 'shortlisted');
  await clickText(A, '.tlwa-acts button', /^Move$/); await A.waitForTimeout(1800);
  const r = await api(A, 'get', `/ats/applications/${C1.regApp.id}`);
  must(r.v.application.stage === 'shortlisted', 'moved: ' + r.v.application.stage);
  await shot(A, '14-regular');
});

console.log(`\n${failed ? failed + ' FAILED' : 'all passed'}`);
await browser.close();
process.exit(failed ? 1 : 0);
