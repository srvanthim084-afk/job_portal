/**
 * Walk-in is a job type, and Apply Now is one application form - in a real
 * browser (specs/Walkin-Job-Type-Task.md §21; the API side is in
 * api/test/walkin-jobs.test.mjs).
 *
 *   1  a regular job's card has no walk-in badge
 *   2  a walk-in job's card has the badge and Date / Time / Venue; there is
 *      no separate walk-in page (#/walkins is the home page)
 *   3  the walk-in job page shows the date, time, venue and address
 *   4  Apply Now opens the application form (company, job title / ID / type
 *      read-only, the walk-in block)
 *   9  signed in: the form is prefilled from the profile, resume on file
 *      with Replace, and only the missing fields are asked for
 *  18  refresh mid-form: the draft comes back; it is gone after submit
 *   5  submit: the success screen with the Application ID (TL-APP-...)
 *  20  walk-in success: View on Map + Add to Calendar (.ics and Google);
 *      a regular job's success shows neither
 *   7  apply again: "You have already applied for this position." + the ID
 *   8  a regular job's form has no walk-in section
 *  16  invalid mobile / email: inline errors, nothing saved
 *  17  double-click Submit: one application
 *  19  capacity reached between opening and submitting: "Registrations full"
 *  13  a walk-in whose date has passed: Closed, Apply disabled, not listed
 *  10  signed out: register, then the same job's form opens
 *  11  the ordinary search finds the walk-in
 *  12  no "Walk-in Drives" / "Walk-ins" in the public header, the candidate
 *      header, the recruiter or the admin sidebar
 *  22  recruiter: Job Type on the job form reveals the walk-in fields and
 *      checks them; Clone makes a draft copy with a new Job ID; Post A
 *      Walk-in Job takes a calendar date, real times and the new fields
 *  23  phone width: the form has no sideways scroll
 *
 * Creates accounts and jobs, so it refuses :4323. Run against an isolated
 * instance:  TL_URL=http://127.0.0.1:4421/ node tools/verify-walkin-jobs.mjs
 * Screenshots go to TL_SHOTS (default: <os temp>/tl-verify-walkin-jobs).
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TINY_PDF, completeApplyForm } from './lib/apply-form.mjs';

const BASE = (process.env.TL_URL || 'http://127.0.0.1:4421/').replace(/\/?$/, '/');
const url = new URL(BASE);
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.port === '4323') {
  console.error(`Refusing to run against ${BASE}: this creates accounts and jobs. Use an isolated instance.`);
  process.exit(2);
}
const SHOTS = process.env.TL_SHOTS || join(tmpdir(), 'tl-verify-walkin-jobs');
mkdirSync(SHOTS, { recursive: true });

let failed = 0;
const results = [];
const ONLY = process.env.TL_ONLY ? new RegExp(process.env.TL_ONLY) : null;
const check = async (name, fn) => {
  if (ONLY && !ONLY.test(name)) return;
  try { await fn(); console.log(`  PASS  ${name}`); results.push(['PASS', name]); }
  catch (e) { console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n')[0]}`); failed += 1; results.push(['FAIL', name]); }
};
const must = (c, m) => { if (!c) throw new Error(m); };
const stamp = Date.now().toString(36);
const phone = () => '9' + String(Math.floor(1e8 + Math.random() * 9e8));
const IST = 330 * 60 * 1000;
const istDay = (plus = 0) => new Date(Date.now() + IST + plus * 86400000).toISOString().slice(0, 10);
const RECRUITER = process.env.TL_RECRUITER_EMAIL || 'recruiter@teamlink.com';
const ADMIN = process.env.TL_ADMIN_EMAIL || 'admin@teamlink.com';
const PW = process.env.TL_RECRUITER_PASSWORD || process.env.DEV_PASSWORD || 'TeamLink@2026';

const browser = await chromium.launch();
const errors = [];
const ready = (page) => page.waitForFunction(() => window.TL && TL.ready === true, null, { timeout: 30000 });
async function open(ctx, hash) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e.message)));
  await page.goto(BASE + hash);
  await ready(page);
  await page.waitForTimeout(600);
  return page;
}
const wizardAway = (page) => page.evaluate(() => {
  document.querySelectorAll('.tlpo-ov .tlpo-btn.ghost, .tlpo-ov .tlpo-skip, .tlpo-ov [data-act="later"]').forEach((b) => b.click());
});
const go = async (page, hash) => { await page.evaluate((h) => { location.hash = h; }, hash); await page.waitForTimeout(1300); await wizardAway(page); };
const shot = (page, name) => page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false });
const text = (page, sel = '#app') => page.evaluate((s) => ((document.querySelector(s) || {}).innerText || ''), sel);
async function signIn(page, email, password, role, hash) {
  const r = await page.evaluate((b) => TL.api.post('/auth/login', b).then(() => 'ok', (x) => x.message), { email, password, role });
  must(r === 'ok', `${role} could not sign in: ${r}`);
  await page.goto('about:blank'); await page.goto(BASE + hash); await ready(page); await page.waitForTimeout(1200);
  await wizardAway(page); await page.waitForTimeout(600); await wizardAway(page);
}
const clickApplyOnPage = (page) => page.evaluate(() => {
  const b = Array.from(document.querySelectorAll('#app button.btn-primary.btn-block')).find((x) => /Apply Now|Easy Apply/.test(x.textContent) && x.offsetParent);
  if (!b) return false; b.click(); return true;
});
const myApps = (page, jobId) => page.evaluate((id) => TL.api.get('/applications').then((o) => o.applications.filter((a) => a.jobId === id)), jobId);

/* ---------------- the recruiter's jobs (through the API, as the job form saves them) ---------------- */
const rc = await browser.newContext({ viewport: { width: 1360, height: 900 } });
const rp = await open(rc, '#/');
await signIn(rp, RECRUITER, PW, 'recruiter', '#/recruiter/jobs');
const made = await rp.evaluate(async ({ s, d5, dPast }) => {
  try {
    const boot = await TL.api.get('/bootstrap');
    const myCo = ((boot.data.recruiters || []).find((r) => boot.session && r.id === boot.session.id) || {}).companyId;
    const base = { companyId: myCo, location: 'Hyderabad', mode: 'Onsite', exp: '2+ yrs', pay: '₹4–6 LPA', status: 'open', skills: ['Java'], gender: 'Female' };
    const wk = (title, over) => ({ ...base, title, type: 'Walk-in', postingKind: 'walkin', walkinDate: d5, walkinFrom: '10:00', walkinTo: '16:00',
      walkinVenue: 'TeamLink Office, 3rd floor', walkinAddress: 'Road No. 1, Banjara Hills, Hyderabad 500034',
      walkinMapLink: 'https://maps.google.com/?q=Banjara+Hills', walkinContact: 'Ravi Kumar', walkinPhone: '9876500011',
      walkinDocuments: 'Updated resume (2 copies)\nPhoto ID', walkinInstructions: 'Report 15 minutes early.', ...over });
    const out = {};
    const mk = async (k, body) => { const r = await TL.api.post('/jobs', body); out[k] = { id: r.job.id, title: r.job.title }; await TL.api.put(`/jobs/${r.job.id}/screening-questions`, { questions: [] }); };
    await mk('reg', { ...base, title: `Store Associate ${s}`, type: 'Full-time' });
    await mk('reg2', { ...base, title: `Delivery Coordinator ${s}`, type: 'Full-time' });
    await mk('reg3', { ...base, title: `Front Office ${s}`, type: 'Full-time' });
    await mk('wk', wk(`Walkin Engineer ${s}`));
    await mk('wkcap', wk(`Walkin Capacity ${s}`, { walkinCapacity: 1 }));
    await mk('wkauth', wk(`Walkin Signup ${s}`));
    /* A walk-in whose date has passed: saved as a draft (a clone may
       carry an old date) and published - it reads as Closed at once. */
    await mk('wkpast', wk(`Walkin Past ${s}`, { status: 'draft', walkinDate: dPast }));
    await TL.api.post(`/jobs/${out.wkpast.id}/publish`, {});
    return out;
  } catch (err) { return String(err.message); }
}, { s: stamp, d5: istDay(5), dPast: istDay(-2) });
must(typeof made === 'object', 'could not create the test jobs: ' + made);
const J = made;

/* ---------------- candidates ---------------- */
async function newCandidate(name, withResume = true) {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await open(ctx, '#/');
  const email = `wk.${name.toLowerCase()}.${stamp}@tl-verify.test`;
  const password = `Walk${stamp}9x`;
  const ph = phone();
  const r = await page.evaluate((b) => TL.api.post('/auth/register', b).then(() => 'ok', (e) => e.message), {
    name: `${name} Verify`, email, password, phone: ph, preferredLocation: 'Hyderabad', expectedCtc: 4,
    noticePeriod: 'Immediate', preferredWorkModes: ['Hybrid'],
  });
  must(r === 'ok', 'could not register: ' + r);
  if (withResume) {
    const up = await page.evaluate(async (bytes) => {
      const fd = new FormData();
      fd.append('purpose', 'apply');
      fd.append('resume', new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }), 'resume.pdf');
      return TL.api.post('/uploads/resume', fd).then(() => 'ok', (e) => e.message);
    }, Array.from(TINY_PDF));
    must(up === 'ok', 'resume upload: ' + up);
    await page.evaluate(() => TL.api.put('/candidates/' + encodeURIComponent((window.TL.session || {}).id || ''), {}).catch(() => null));
  }
  return { ctx, page, email, password, phone: ph, name: `${name} Verify` };
}

console.log(`\nwalk-in jobs + the application form  (${BASE})`);

const pub = await browser.newContext({ viewport: { width: 1360, height: 900 } });
const pp = await open(pub, '#/');

await check('12a. public header: no "Walk-in Drives" / "Walk-ins"; #/walkins is not a page', async () => {
  const head = await text(pp, 'header');
  must(!/walk-?ins?\b|walk-in drives/i.test(head), 'header: ' + head.split('\n').join(' | '));
  must(!(await pp.$('.wk-jobs-entry')), 'the jobs page still links to walk-in drives');
  await go(pp, '#/walkins');
  must(!/Walk-in Drives/.test(await text(pp)), 'a walk-in drives page still renders');
  await shot(pp, '01-public-home');
});

await check('1 / 2. job cards: the walk-in has the badge and Date / Time / Venue; the regular one has none', async () => {
  await go(pp, '#/jobs');
  await pp.waitForTimeout(800);
  const cards = await pp.evaluate((ids) => {
    const find = (id) => Array.from(document.querySelectorAll('.job-row,.job-card')).find((el) => el.innerHTML.includes(id));
    const w = find(ids.wk), r = find(ids.reg);
    return { w: w ? w.innerText : null, r: r ? r.innerText : null };
  }, { wk: J.wk.id, reg: J.reg.id });
  must(cards.w, 'the walk-in is not in Jobs');
  must(/Walk-in Interview/.test(cards.w), 'no badge: ' + cards.w.slice(0, 200));
  must(/Date:/.test(cards.w) && /Time:/.test(cards.w) && /Venue:\s*TeamLink Office/.test(cards.w), 'no date/time/venue lines');
  must(cards.r && !/Walk-in Interview/.test(cards.r), 'the regular card has a walk-in badge');
  await pp.evaluate((id) => { const el = Array.from(document.querySelectorAll('.job-row')).find((x) => x.innerHTML.includes(id)); if (el) el.scrollIntoView({ block: 'center' }); }, J.wk.id);
  await shot(pp, '02-jobs-walkin-card');
});

await check('11. the ordinary search finds the walk-in', async () => {
  const r = await pp.evaluate((t) => TL.api.get('/jobs?q=' + encodeURIComponent(t)).then((o) => o.jobs.map((j) => j.id)), `Walkin Engineer ${stamp}`);
  must(r.includes(J.wk.id), 'not found by the search API');
  await pp.evaluate((t) => { STATE.search = STATE.search || {}; STATE.search.q = t; render(); }, `Walkin Engineer ${stamp}`).catch(() => {});
});

await check('3. the walk-in job page shows date, time, venue and address', async () => {
  await go(pp, '#/job/' + J.wk.id);
  const t = await text(pp, '.tlwk-jp');
  must(/Walk-in Interview/.test(t), 'no walk-in panel');
  must(t.includes('10:00 AM') && t.includes('4:00 PM'), 'no time: ' + t);
  must(t.includes('TeamLink Office') && t.includes('Banjara Hills'), 'no venue / address');
  must(await pp.$('.tlwk-jp a[href^="https://maps.google.com"]'), 'no View on Map');
  await shot(pp, '03-walkin-job-page');
});

const A = await newCandidate('Asha');
const ap = A.page;
await signIn(ap, A.email, A.password, 'candidate', '#/job/' + J.wk.id);

await check('12b. candidate header: Jobs, Internships, Companies, Career Resources - no Walk-in Drives', async () => {
  await go(ap, '#/candidate/search');
  const nav = await ap.evaluate(() => Array.from(document.querySelectorAll('header a, header button, nav a')).map((a) => a.textContent.trim()).join(' | '));
  must(/Jobs/.test(nav) && /Internships/.test(nav) && /Companies/.test(nav) && /Career Resources/.test(nav), 'nav: ' + nav);
  must(!/Walk-in Drives|Walk-ins/.test(nav), 'still in the nav: ' + nav);
  const drawer = await ap.evaluate(() => document.body.innerHTML.includes('#/candidate/walkins'));
  must(!drawer, 'a #/candidate/walkins link is still on the page');
  await shot(ap, '04-candidate-search');
});

await check('4 / 9. Apply Now opens the form: prefilled, read-only job fields, company, walk-in block, only the missing fields', async () => {
  await go(ap, '#/job/' + J.wk.id);
  must(await clickApplyOnPage(ap), 'no Apply button');
  await ap.waitForSelector('#tlafForm', { timeout: 8000 });
  const f = await ap.evaluate(() => ({
    title: document.getElementById('tlafJobTitle').value, id: document.getElementById('tlafJobId').value,
    type: document.getElementById('tlafJobType').value, company: document.getElementById('tlafCompany').value,
    ro: ['tlafJobTitle', 'tlafJobId', 'tlafJobType', 'tlafCompany'].every((i) => document.getElementById(i).readOnly),
    name: document.getElementById('tlafName').value, email: document.getElementById('tlafEmail').value,
    mobile: document.getElementById('tlafMobile').value, walkin: (document.querySelector('#tlafForm .tlwk-box') || {}).innerText || '',
    resume: !!document.getElementById('tlafResumeOnFile'), replace: !!document.getElementById('tlafReplace'),
    summary: !!document.getElementById('tlafSummary'),
    visible: Array.from(document.querySelectorAll('#tlafForm [data-row]')).filter((r) => r.offsetParent).map((r) => r.getAttribute('data-row')),
  }));
  must(f.id === J.wk.id && f.type === 'Walk-in' && f.title === J.wk.title, 'job fields: ' + JSON.stringify(f));
  must(f.ro, 'job fields are not read-only');
  must(f.company && !/client/i.test(f.company), 'company: ' + f.company);
  must(f.name === A.name && f.email === A.email && f.mobile === A.phone, 'not prefilled: ' + JSON.stringify(f));
  must(/Venue/.test(f.walkin) && /Date/.test(f.walkin), 'no walk-in block');
  must(f.resume && f.replace, 'the resume on file with Replace is not shown');
  must(f.summary, 'no profile summary (one-click)');
  must(!f.visible.includes('tlafName') && !f.visible.includes('tlafEmail'), 'fields already on the profile are asked again: ' + f.visible.join(','));
  must(f.visible.includes('tlafQual') && f.visible.includes('tlafExp'), 'missing fields are not asked: ' + f.visible.join(','));
  await shot(ap, '05-form-walkin-missing-only');
});

await check('18. refresh mid-form: the draft is restored', async () => {
  await ap.evaluate(() => { const b = document.getElementById('tlafEditAll'); if (b) b.click(); });
  await ap.fill('#tlafExp', '3');
  await ap.fill('#tlafLoc', 'Hyderabad');
  await ap.selectOption('#tlafQual', 'B.Tech/B.E');
  await ap.selectOption('#tlafNotice', '30 days');
  await ap.waitForTimeout(700);
  await ap.reload(); await ready(ap); await ap.waitForTimeout(1500); await wizardAway(ap);
  must(await clickApplyOnPage(ap), 'no Apply button after the refresh');
  await ap.waitForSelector('#tlafForm', { timeout: 8000 });
  const v = await ap.evaluate(() => [document.getElementById('tlafExp').value, document.getElementById('tlafQual').value, document.getElementById('tlafNotice').value]);
  must(v[0] === '3' && v[1] === 'B.Tech/B.E' && v[2] === '30 days', 'draft not restored: ' + v.join(','));
});

let REF = '';
await check('5 / 20. submit: Application ID, walk-in details, View on Map and Add to Calendar; draft cleared', async () => {
  await ap.click('#tlafSubmit');
  await ap.waitForSelector('#tlafDone, #tlafMsg:not(:empty)', { timeout: 30000 });
  if (!(await ap.$('#tlafDone'))) {
    await shot(ap, '06-submit-refused');
    throw new Error('not submitted: ' + await text(ap, '#tlafMsg') + ' | ' + await ap.evaluate(() => Array.from(document.querySelectorAll('.tlaf-err')).map((e) => e.id + '=' + e.textContent).filter((x) => !/=$/.test(x)).join(', ')));
  }
  REF = await ap.evaluate(() => document.getElementById('tlafRef').textContent.trim());
  must(/^TL-APP-\d{4}-\d{5}$/.test(REF), 'Application ID: ' + REF);
  const t = await text(ap, '#tlafDone');
  must(/Application Submitted Successfully/.test(t) && t.includes(J.wk.title), 'success text: ' + t);
  must(/Walk-in Interview Details/.test(t) && t.includes('TeamLink Office'), 'no walk-in details on the success screen');
  must(await ap.$('#tlafDone a[href^="https://maps.google.com"]'), 'no View on Map');
  must(await ap.$('#tlafDone [data-tlwk-ics]') && await ap.$('#tlafDone a[data-tlwk-gcal][href^="https://calendar.google.com/"]'), 'no Add to Calendar');
  const [dl] = await Promise.all([ap.waitForEvent('download', { timeout: 8000 }), ap.click('#tlafDone [data-tlwk-ics]')]);
  must(/\.ics$/.test(dl.suggestedFilename()), 'calendar file: ' + dl.suggestedFilename());
  const draftLeft = await ap.evaluate((id) => Object.keys(localStorage).filter((k) => k.indexOf('tl_apply_draft_v1:') === 0 && k.endsWith(':' + id)).length, J.wk.id);
  must(draftLeft === 0, 'the draft is still kept');
  const apps = await myApps(ap, J.wk.id);
  must(apps.length === 1 && apps[0].reference === REF, 'the server holds ' + JSON.stringify(apps));
  await shot(ap, '06-success-walkin');
});

await check('7. applying again: "You have already applied for this position." with the existing ID', async () => {
  await ap.evaluate(() => fcrCloseModal());
  await ap.evaluate((id) => { window.applyToJob(id); }, J.wk.id);
  await ap.waitForSelector('#tlafDup', { timeout: 8000 });
  const t = await text(ap, '#tlafDup');
  must(/You have already applied for this position\./.test(t) && t.includes(REF), 'duplicate screen: ' + t);
  must(/Venue/.test(t), 'no walk-in details on the duplicate screen');
  const direct = await ap.evaluate((b) => TL.api.post('/applications/form', b).then(() => 'created', (e) => e.code + ':' + (e.details && e.details.applicationId)),
    { jobId: J.wk.id, name: A.name, mobile: A.phone, email: A.email, currentLocation: 'Hyderabad', qualification: 'B.Tech/B.E', experienceYears: 3, noticePeriod: '30 days' });
  must(direct === 'DUPLICATE_APPLICATION:' + REF, 'server: ' + direct);
  await shot(ap, '07-duplicate');
  await ap.evaluate(() => fcrCloseModal());
});

await check('8 / 20. a regular job: the same form, no walk-in section, no calendar on success', async () => {
  await go(ap, '#/job/' + J.reg.id);
  must(!(await ap.$('.tlwk-jp')), 'a walk-in panel on a regular job');
  must(await clickApplyOnPage(ap), 'no Apply button');
  await ap.waitForSelector('#tlafForm', { timeout: 8000 });
  must(await ap.evaluate(() => document.getElementById('tlafJobType').value) === 'Regular', 'job type');
  must(!(await ap.$('#tlafForm .tlwk-box:not(.tlaf-summary)')), 'a walk-in block on a regular job');
  await shot(ap, '08-form-regular');
  const r = await completeApplyForm(ap);
  must(r.state === 'done', 'regular apply: ' + JSON.stringify(r));
  must(!(await ap.$('#tlafDone [data-tlwk-ics]')) && !(await ap.$('#tlafDone a[href^="https://maps"]')), 'calendar / map on a regular job');
  await ap.evaluate(() => fcrCloseModal());
});

await check('16. invalid mobile and email: inline errors, nothing saved', async () => {
  await ap.evaluate((id) => { window.applyToJob(id); }, J.reg2.id);
  await ap.waitForSelector('#tlafForm', { timeout: 8000 });
  await ap.click('#tlafEditAll');
  await ap.fill('#tlafMobile', '12345');
  await ap.fill('#tlafEmail', 'not-an-email');
  await ap.click('#tlafSubmit');
  await ap.waitForTimeout(500);
  const e = await ap.evaluate(() => [document.getElementById('tlafMobile_err').textContent, document.getElementById('tlafEmail_err').textContent]);
  must(/10-digit/.test(e[0]) && /valid email/.test(e[1]), 'errors: ' + e.join(' / '));
  must((await myApps(ap, J.reg2.id)).length === 0, 'something was saved');
  /* an oversized and a wrong-type resume */
  await ap.setInputFiles('#tlafResume', { name: 'big.pdf', mimeType: 'application/pdf', buffer: Buffer.concat([TINY_PDF, Buffer.alloc(5 * 1024 * 1024 + 10, 32)]) });
  await ap.waitForTimeout(300);
  must(/5 MB/.test(await ap.evaluate(() => document.getElementById('tlafResume_err').textContent)), 'no size error');
  await ap.setInputFiles('#tlafResume', { name: 'tool.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('MZ') });
  await ap.waitForTimeout(300);
  must(/PDF, DOC or DOCX/.test(await ap.evaluate(() => document.getElementById('tlafResume_err').textContent)), 'no type error');
  await shot(ap, '09-validation');
  await ap.evaluate(() => fcrCloseModal());
});

await check('17. double-click Submit: one application', async () => {
  await ap.evaluate((id) => { window.applyToJob(id); }, J.reg3.id);
  await ap.waitForSelector('#tlafForm', { timeout: 8000 });
  await ap.evaluate(() => { const b = document.getElementById('tlafSubmit'); b.click(); b.click(); document.getElementById('tlafForm').requestSubmit(); });
  await ap.waitForSelector('#tlafDone', { timeout: 30000 });
  must((await myApps(ap, J.reg3.id)).length === 1, 'not exactly one application');
  await ap.evaluate(() => fcrCloseModal());
});

await check('19. the last seat taken while the form is open: "Registrations full", nothing saved', async () => {
  const B = await newCandidate('Bala');
  await signIn(B.page, B.email, B.password, 'candidate', '#/');
  await ap.evaluate((id) => { window.applyToJob(id); }, J.wkcap.id);
  await ap.waitForSelector('#tlafForm', { timeout: 8000 });
  const took = await B.page.evaluate((b) => TL.api.post('/applications/form', b).then((r) => r.application.reference, (e) => e.message),
    { jobId: J.wkcap.id, name: B.name, mobile: B.phone, email: B.email, currentLocation: 'Hyderabad', qualification: 'B.Com', experienceYears: 1, noticePeriod: 'Immediate' });
  must(/^TL-APP-/.test(took), 'the other candidate could not take the seat: ' + took);
  await ap.click('#tlafSubmit');
  await ap.waitForSelector('#tlafMsg:not(:empty)', { timeout: 15000 });
  const m = await text(ap, '#tlafMsg');
  must(/Registrations full/.test(m), 'message: ' + m);
  must((await myApps(ap, J.wkcap.id)).length === 0, 'overbooked');
  await shot(ap, '10-registrations-full');
  await ap.evaluate(() => fcrCloseModal());
  await ap.evaluate(() => TL.refresh && TL.refresh());
  await ap.waitForTimeout(800);
  await go(ap, '#/job/' + J.wkcap.id);
  const btn = await ap.evaluate(() => Array.from(document.querySelectorAll('#app .btn-block')).map((b) => b.textContent + (b.disabled ? '[off]' : '')).join(' | '));
  must(/Registrations full\[off\]/.test(btn), 'the job page still offers Apply: ' + btn);
  await B.ctx.close();
});

await check('13. a walk-in whose date has passed: Closed, Apply disabled, not in the listing', async () => {
  await go(ap, '#/job/' + J.wkpast.id);
  const t = await text(ap, '.tlwk-jp');
  must(/closed/i.test(t), 'no Closed state: ' + t);
  const btn = await ap.evaluate(() => Array.from(document.querySelectorAll('#app .btn-block')).map((b) => b.textContent + (b.disabled ? '[off]' : '')).join(' | '));
  must(/Closed.*\[off\]/.test(btn), 'Apply is not disabled: ' + btn);
  const listed = await ap.evaluate((id) => DATA.openJobs().some((j) => j.id === id), J.wkpast.id);
  must(!listed, 'still in the candidate listing');
  await shot(ap, '11-closed-walkin');
});

await check('10. signed out: register, then the same job\'s form opens', async () => {
  const c = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await open(c, '#/job/' + J.wkauth.id);
  must(await clickApplyOnPage(p), 'no Apply button');
  await p.waitForTimeout(900);
  must(/^#\/register\/candidate/.test(await p.evaluate(() => location.hash)), 'not on registration');
  await p.fill('#regName', 'Signup Verify');
  await p.fill('#regMobile', phone());
  await p.fill('#regLocation', 'Hyderabad');
  await p.fill('#regEmail', `wk.signup.${stamp}@tl-verify.test`);
  await p.fill('#regPassword', `Signup${stamp}7`);
  await p.evaluate(() => {
    const q = document.getElementById('regQualification'); const o = Array.from(q.options).find((x) => x.value); q.value = o.value; q.dispatchEvent(new Event('change', { bubbles: true }));
    const n = document.getElementById('regNotice'); const o2 = Array.from(n.options).find((x) => x.value); n.value = o2.value; n.dispatchEvent(new Event('change', { bubbles: true }));
    const m = document.querySelector('#regWorkModeGroup input[type="checkbox"]'); if (m && !m.checked) m.click();
    ['regConsentTerms', 'regConsentResume'].forEach((id) => { const x = document.getElementById(id); if (!x.checked) x.click(); });
  });
  await p.fill('#regSkills', 'Excel, Communication');
  await p.fill('#regPrefLocation', 'Hyderabad');
  await p.fill('#regExpSalary', '4');
  await p.evaluate(() => { ['regPrefLocation', 'regExpSalary', 'regNotice'].forEach((id) => window.regTouch && regTouch(id)); validateRegisterForm(); });
  await p.click('#regSubmitBtn');
  await p.waitForFunction(() => STATE.session && STATE.session.role === 'candidate', null, { timeout: 20000 });
  await p.waitForTimeout(3000);
  await wizardAway(p);
  await p.waitForSelector('#tlafForm', { timeout: 15000 });
  must(await p.evaluate(() => document.getElementById('tlafJobId').value) === J.wkauth.id, 'the form is for another job');
  await shot(p, '12-after-signup-form');
  const r = await completeApplyForm(p);
  must(r.state === 'done', 'apply after sign-up: ' + JSON.stringify(r));
  await c.close();
});

await check('23. phone width: the form fits, no sideways scroll', async () => {
  const m = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  const mp = await open(m, '#/');
  await signIn(mp, A.email, A.password, 'candidate', '#/job/' + J.wkauth.id);
  await mp.evaluate((id) => { window.applyToJob(id); }, J.wkauth.id);
  await mp.waitForSelector('#tlafForm', { timeout: 8000 });
  const over = await mp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  must(over <= 2, 'sideways scroll by ' + over + 'px');
  await shot(mp, '13-form-phone');
  await m.close();
});

await check('12c / 22. recruiter: no Walk-in Drives; Job Type reveals and checks the walk-in fields; Clone', async () => {
  await rp.evaluate(() => TL.refresh());
  await go(rp, '#/recruiter/jobs');
  must(!/Walk-in Drives/.test(await text(rp, '.sidebar')), 'Walk-in Drives in the recruiter sidebar');
  must(await rp.$('input[name="tlwkNType"][value="walkin"]'), 'no Job Type on AI Job Creation');
  must(await rp.evaluate(() => document.getElementById('tlwkNFields').style.display === 'none'), 'walk-in fields shown for a regular job');
  await rp.click('input[name="tlwkNType"][value="walkin"]');
  must(await rp.evaluate(() => document.getElementById('tlwkNFields').style.display !== 'none'), 'walk-in fields not revealed');
  await shot(rp, '14-recruiter-job-type');
  /* clone the walk-in: a new id, a draft, the editor open with the walk-in fields */
  const before = await rp.evaluate(() => DATA.jobs.length);
  await rp.evaluate((id) => tlwkClone(id), J.wk.id);
  await rp.waitForTimeout(1500);
  const clone = await rp.evaluate(() => { const j = DATA.jobs[DATA.jobs.length - 1]; return { id: j.id, status: j.status, kind: j.postingKind, venue: j.walkinVenue, n: DATA.jobs.length }; });
  must(clone.n === before + 1 && clone.id !== J.wk.id && clone.status === 'draft' && clone.kind === 'walkin' && clone.venue === 'TeamLink Office, 3rd floor', 'clone: ' + JSON.stringify(clone));
  must(await rp.evaluate(() => document.querySelector('input[name="tlwkEType"][value="walkin"]') && document.querySelector('input[name="tlwkEType"][value="walkin"]').checked), 'the editor does not load the walk-in type');
  must(await rp.evaluate(() => document.getElementById('tlwkEVenue').value) === 'TeamLink Office, 3rd floor', 'walk-in fields not loaded');
  await rp.fill('#tlwkEDate', '');
  await rp.evaluate(() => { document.getElementById('tlwkEDate').value = '2020-01-01'; });
  await rp.evaluate((id) => saveEditJob(id), clone.id);
  await rp.waitForTimeout(400);
  must(/past/.test(await rp.evaluate(() => document.getElementById('tlwkEDate_err').textContent)), 'a past date was accepted');
  await rp.evaluate((d) => { document.getElementById('tlwkEDate').value = d; document.getElementById('tlwkEVenue').value = 'Second Venue'; }, istDay(9));
  await rp.evaluate((id) => saveEditJob(id), clone.id);
  await rp.waitForTimeout(2500);
  const saved = await rp.evaluate((id) => TL.api.get('/jobs/' + id).then((r) => [r.job.walkinVenue, r.job.walkinDate, r.job.jobType], (e) => e.message), clone.id);
  must(Array.isArray(saved) && saved[0] === 'Second Venue' && saved[1] === istDay(9) && saved[2] === 'walk-in', 'clone save: ' + JSON.stringify(saved));
  await shot(rp, '15-recruiter-clone');
});

await check('22b. recruiter: Post A Walk-in Job has a calendar date, real times and the new fields, and saves them', async () => {
  await rp.evaluate(() => tnavWalkinModal());
  await rp.waitForSelector('#tlwkTAddress', { timeout: 5000 });
  const types = await rp.evaluate(() => [document.getElementById('twDate').type, document.getElementById('twFrom').type, document.getElementById('twTo').type]);
  must(types.join(',') === 'date,time,time', 'inputs: ' + types.join(','));
  const title = `Posted Walkin ${stamp}`;
  await rp.evaluate(({ t, d }) => {
    const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
    set('twTitle', t); set('twLoc', 'Hyderabad'); set('twDate', d); set('twFrom', '09:30'); set('twTo', '13:00');
    set('twVenue', 'Hall B'); set('twExp', 'Fresher'); set('twQual', 'Any graduate'); set('twPay', '₹2–3 LPA');
    set('twSkills', 'Communication'); set('twContact', 'Meena'); set('twPhone', '9876512345');
    document.getElementById('twGender').value = 'Female';
    set('tlwkTAddress', '4 Lake Road, Hyderabad 500001'); set('tlwkTDocs', 'Resume' + String.fromCharCode(10) + 'Photo ID'); set('tlwkTCap', '30');
    const ai = document.getElementById('twAi'); if (ai) ai.checked = false;
  }, { t: title, d: istDay(6) });
  await shot(rp, '16-post-walkin-form');
  await rp.evaluate(() => tnavWalkinSubmit());
  let job = null;
  for (let i = 0; i < 20 && !job; i++) {
    await rp.waitForTimeout(1000);
    job = await rp.evaluate((t) => TL.api.get('/jobs?view=all&mine=all&limit=200').then((r) => r.jobs.find((j) => j.title === t) || null), title);
  }
  must(job, 'the walk-in did not reach the server');
  must(job.jobType === 'walk-in' && job.walkinDate === istDay(6) && job.walkinStartTime === '09:30' && job.walkinAddress === '4 Lake Road, Hyderabad 500001'
    && job.walkinSlotCapacity === 30 && /Photo ID/.test(job.walkinDocumentsToCarry || ''), 'saved: ' + JSON.stringify(job).slice(0, 400));
});

await check('12d. admin sidebar: no Walk-in Drives', async () => {
  const ac = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const a = await open(ac, '#/');
  await signIn(a, ADMIN, PW, 'admin', '#/admin/jobs');
  must(!/Walk-in Drives/.test(await text(a, '.sidebar')), 'in the admin sidebar');
  await go(a, '#/admin/walkins');
  must(!/Walk-in Drives/.test(await text(a)), 'the admin walk-ins page still renders');
  await ac.close();
});

await check('no page errors', async () => {
  const mine = errors.filter((e) => !/ResizeObserver|Failed to fetch|NetworkError/.test(e));
  must(!mine.length, mine.slice(0, 3).join(' / '));
});

await browser.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
console.log(`screenshots: ${SHOTS}`);
process.exit(failed ? 1 : 0);
