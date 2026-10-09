/**
 * "Build your profile" (0124), driven in a real browser.
 *
 *     TL_URL=http://127.0.0.1:4443 node tools/verify-profile-wizard.mjs
 *
 * Needs a dev server WITHOUT mail (the registration code is shown on the page) and the demo
 * recruiter (recruiter@teamlink.com / TeamLink@2026, LOAD_SEED=true).
 *
 * Covers: self-registered candidate -> Home -> the prompt (OK / Later); Later -> banner + server
 * state "skipped"; OK -> Step 1 of 5; a bad file refused; a DOCX read (2 projects are 2, bullets are
 * not jobs, skills distinct) with NOTHING saved before Finish; refresh resumes on the same step
 * with the same edits; review edits win; details already given are not asked again; validation;
 * Finish saves once (a retry adds nothing), shows Profile ready and lands on #/candidate/home;
 * the prompt does not come back; the profile page and the recruiter see the saved data;
 * skipping the resume works; a recruiter-added candidate gets the prompt after the password
 * reset; phone-width layout.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { makeDocx } from './lib/docx.mjs';

const BASE = (process.env.TL_URL || 'http://localhost:4323/').replace(/\/$/, '');
/* With a mail sink (SINK_LOG = its log file) codes and the invite's temporary password are read from it. */
const SINK_LOG = process.env.SINK_LOG || '';
async function fromSink(to, re) {
  if (!SINK_LOG) return null;
  for (let i = 0; i < 30; i++) {
    if (existsSync(SINK_LOG)) {
      const blocks = readFileSync(SINK_LOG, 'utf8').split('===== MESSAGE =====')
        .map((b) => b.replace(/=\r?\n/g, ''))           /* quoted-printable soft line breaks, per message */
        .filter((b) => b.includes('To: ' + to));
      const last = blocks.pop();
      const m = last && re.exec(last);
      if (m) return m[1];
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}
const fail = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`); if (!ok) fail.push(what); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DIR = resolve('var/test-resumes');
mkdirSync(DIR, { recursive: true });
const stamp = Date.now().toString(36);
const mobile = () => '9' + String(Math.floor(1e8 + Math.random() * 9e8));
const RESUME = resolve(DIR, `wizard-${stamp}.docx`);
writeFileSync(RESUME, makeDocx([
  'PRIYA SHARMA', 'priya.sharma.dev@gmail.com | +91 98765 43210', 'Hyderabad', '',
  'PROFESSIONAL SUMMARY', 'Data analyst with three years of SQL and Power BI reporting.', '',
  'EDUCATION', 'B.Sc (Statistics), Osmania University, 2021, 78%', 'Intermediate (MPC), Narayana College, 2018', '',
  'WORK EXPERIENCE',
  'ABC Technologies Pvt Ltd - Data Analyst (Jul 2022 - Present)', '• Built dashboards in Power BI.', '• Automated Excel reports.',
  'Infotech Systems - Associate Analyst (Jun 2021 - Jun 2022)', '• Cleaned SQL data.', '',
  'PROJECTS', '- Student Management System', '- Personal Portfolio Website', '',
  'CERTIFICATIONS', 'Microsoft Certified: Power BI Data Analyst Associate', '',
  'SKILLS', 'SQL, Excel, Python, sql, Power BI',
]));
const BAD = resolve(DIR, `wizard-bad-${stamp}.txt`);
writeFileSync(BAD, 'not a resume');

const browser = await chromium.launch();
async function newPage(viewport = { width: 1280, height: 900 }) {
  const page = await (await browser.newContext({ viewport })).newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(String(e.message)));
  await page.goto(`${BASE}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.TL && window.TL.ready === true, null, { timeout: 30000 });
  return page;
}
const text = (page, sel) => page.evaluate((s) => (document.querySelector(s) || {}).innerText || '', sel);
const stepNo = (page) => page.evaluate(() => (document.getElementById('tlpoStepNo') || {}).textContent || '');
const api = (page, method, path, body) => page.evaluate(async ({ m, p, b }) => {
  try { return { ok: true, body: await TL.api[m](p, b) }; } catch (e) { return { ok: false, status: e.status, message: e.message }; }
}, { m: method, p: path, b: body });

/* the mobile OTP: the development server shows it on the page (no SMS gateway) */
async function verifyPhone(page, phone) {
  if (phone) { await page.fill('#tlrfPhone', phone); await page.dispatchEvent('#tlrfPhone', 'change'); }
  await page.click('[data-tlrf="sendotp"]');
  await page.waitForSelector('#tlrfOtp', { timeout: 15000 });
  await page.waitForSelector('#tlrfHost .tlrf-dev b', { timeout: 15000 });
  const otp = await page.evaluate(() => [...document.querySelectorAll('#tlrfHost .tlrf-dev b')].map((b) => b.textContent).find((t) => /^\d{6}$/.test(t)));
  await page.fill('#tlrfOtp', otp || '');
  await page.click('[data-tlrf="verifyotp"]');
  await page.waitForFunction(() => !!document.querySelector('[data-tlrf="changephone"]'), null, { timeout: 15000 });
  return true;
}

/* the registration, through the page */
async function register(page, email) {
  await page.evaluate(() => { location.hash = '#/register/candidate'; });
  await page.waitForSelector('#tlrfName', { timeout: 15000 });
  await page.fill('#tlrfName', 'Wizard Person'); await page.dispatchEvent('#tlrfName', 'change');
  await verifyPhone(page, mobile());
  await page.fill('#tlrfLoc', 'Hyderabad'); await page.dispatchEvent('#tlrfLoc', 'change');
  await page.selectOption('#tlrfQual', 'B.Sc'); await page.dispatchEvent('#tlrfQual', 'change');
  await page.fill('#tlrfSkillIn', 'Excel'); await page.press('#tlrfSkillIn', 'Enter');
  await page.fill('#tlrfPref', 'Hyderabad, Pune'); await page.dispatchEvent('#tlrfPref', 'change');
  await page.fill('#tlrfEmail', email); await page.dispatchEvent('#tlrfEmail', 'change');
  await page.click('[data-tlrf="sendcode"]');
  await page.waitForSelector('#tlrfCode', { timeout: 20000 });
  await sleep(400);
  let code = (await text(page, '#tlrfHost .tlrf-dev b')).trim();
  if (!code) code = await fromSink(email, /verification code is (\d{6})/);
  await page.fill('#tlrfCode', code || '');
  await page.click('[data-tlrf="verify"]');
  await page.waitForFunction(() => /✓ Verified/.test(document.getElementById('tlrfHost').innerText), null, { timeout: 15000 });
  await page.fill('#tlrfPw', 'Wizard3pass9'); await page.fill('#tlrfPw2', 'Wizard3pass9');
  await page.check('#tlrfTerms'); await page.check('#tlrfResumeOk');
  await page.click('[data-tlrf="create"]');
  await page.waitForFunction(() => location.hash === '#/candidate/home', null, { timeout: 30000 });
}

/* ---- 2. self-registered: Home, then the prompt ------------------------------- */
const email = `wizard.${stamp}@mailbox-teamlink-tests.in`;
let p = await newPage();
await register(p, email);
await p.waitForSelector('#tlpoHost .tlpo-modal', { timeout: 15000 });
check(/Build your profile to get better job matches/.test(await text(p, '#tlpoHost')), '2: after registering, Home shows "Build your profile to get better job matches."');
check(await p.isVisible('#tlpoHost .tlpo-btn.pri') && /OK/.test(await text(p, '#tlpoHost .tlpo-btn.pri')) && /Later/.test(await text(p, '#tlpoHost .tlpo-btn.ghost')), '2: OK and Later');
const me = await p.evaluate(() => STATE.session.id);

/* ---- 3. Later: Home, a banner, and the server remembers ----------------------- */
await p.click('#tlpoHost .tlpo-btn.ghost');
await sleep(800);
check(!(await p.$('#tlpoHost .tlpo-ov')), '3: Later closes the prompt');
check((await p.evaluate(() => location.hash)) === '#/candidate/home', '3: ...and the candidate is on Home');
const st1 = await api(p, 'get', `/candidates/${me}/onboarding`);
check(st1.ok && st1.body.status === 'skipped', `3: the server remembers "skipped" (${JSON.stringify(st1.body && st1.body.status)})`);
await p.reload(); await p.waitForFunction(() => window.TL && TL.ready && window.STATE && STATE.session, null, { timeout: 30000 });
await sleep(1500);
check(!(await p.$('#tlpoHost .tlpo-modal')), '3: on the next visit no box in front of the page');
check(/Complete your profile/.test(await text(p, '#tlpoBanner')) && /\d+% complete/.test(await text(p, '#tlpoBanner')), '3: ...a "Complete your profile" banner with the %');

/* ---- OK starts at Step 1 of 5 --------------------------------------------- */
await p.click('#tlpoBanner .tlpo-btn.pri');
await p.waitForSelector('#tlpoStepNo', { timeout: 10000 });
check((await stepNo(p)) === 'Step 1 of 5', '3: the wizard starts at Step 1 of 5 (Resume)');

/* ---- 4/5. a bad file, then a real resume ------------------------------------- */
await p.setInputFiles('#tlpoFile', BAD);
await sleep(300);
check(/PDF, DOC or DOCX/.test(await text(p, '#tlpoHost .tlpo-err')), '4: an unsupported file is refused with a clear message');
await p.setInputFiles('#tlpoFile', RESUME);
await p.waitForFunction(() => /Step 2 of 5/.test((document.getElementById('tlpoStepNo') || {}).textContent || '') && !document.querySelector('.tlpo-spin'), null, { timeout: 60000 });
const counts = await p.evaluate(() => [...document.querySelectorAll('.tlpo-count')].map((x) => x.innerText.replace(/\s+/g, ' ')));
check(counts.includes('2 Projects'), `5: 2 projects counted as 2 (${counts.join(' | ')})`);
check(counts.includes('2 Work experience'), '5: two jobs - the bullets are not jobs');
check(counts.includes('4 Key skills'), '4: skills distinct (SQL, Excel, Python, Power BI)');
const before = await api(p, 'get', `/candidates/${me}/onboarding`);
const row0 = await p.evaluate((id) => DATA.candidateById(id), me);
check((row0.skills || []).join(',') === 'Excel' && !(row0.experienceRecords || []).length, '7: nothing read from the resume is on the profile yet (only what registration saved)');
check(before.body.status === 'in_progress', '10: the server says in_progress');

/* ---- 3: review, edits win, skills in their own card ---------------------------------- */
await p.click('#tlpoHost .tlpo-btn.pri');
await p.waitForFunction(() => /Step 3 of 5/.test(document.getElementById('tlpoStepNo').textContent), null, { timeout: 10000 });
check(await p.isVisible('#tlpoSec_skills.key'), '4: Key skills are a separate, highlighted card');
check((await p.$$eval('#tlpoChips_skills .tlpo-chip', (x) => x.length)) === 4, '4: four skill tags');
const proj = await p.$$eval('#tlpoSec_projects .tlpo-row', (x) => x.length);
check(proj === 2, `5: two project cards (${proj})`);
check(/Responsibilities/.test(await text(p, '#tlpoSec_work')) && /dashboards/.test(await p.inputValue('#tlpoR_experience_0_responsibilities')), '4: a job keeps its responsibilities');
await p.fill('#tlpoChipIn_skills', 'tableau'); await p.press('#tlpoChipIn_skills', 'Enter');
await p.fill('#tlpoChipIn_skills', 'SQL'); await p.press('#tlpoChipIn_skills', 'Enter');
check((await p.$$eval('#tlpoChips_skills .tlpo-chip', (x) => x.length)) === 5, '4: a duplicate skill is not added; a new one is');
await p.fill('#tlpoTitle2', 'Senior Data Analyst');
await sleep(1200);   // the draft is saved after a short pause

/* ---- 10. refresh: same step, same edits ------------------------------------- */
await p.reload(); await p.waitForFunction(() => window.TL && TL.ready && window.STATE && STATE.session, null, { timeout: 30000 });
await sleep(1200);
await p.click('#tlpoBanner .tlpo-btn.pri');
await p.waitForSelector('#tlpoStepNo', { timeout: 10000 });
check((await stepNo(p)) === 'Step 3 of 5', '10: after a refresh the wizard reopens on Step 3');
check((await p.inputValue('#tlpoTitle2')) === 'Senior Data Analyst', '10: ...with the edit kept');
check((await p.$$eval('#tlpoChips_skills .tlpo-chip', (x) => x.length)) === 5, '10: ...and the added skill');

/* ---- 8/9. additional details: validation, then saved -------------------------- */
await p.click('#tlpoHost .tlpo-btn.pri');
await p.waitForFunction(() => /Step 4 of 5/.test(document.getElementById('tlpoStepNo').textContent), null, { timeout: 10000 });
for (const id of ['#tlpo_notice', '#tlpo_sal', '#tlpoChipIn_preferredRoles']) {
  check(await p.isVisible(id), `8: ${id} is asked`);
}
check(!(await p.$('#tlpo_curloc')) && !(await p.$('#tlpoChipIn_preferredLocations')), '9: current and preferred location (given at registration) are not asked again');
check(/Work from Office/.test(await text(p, '#tlpoBody')) && /Hybrid/.test(await text(p, '#tlpoBody')) && /Remote/.test(await text(p, '#tlpoBody')), '8: work mode: Work from Office / Hybrid / Remote');
check(!/Full name|Highest/i.test(await text(p, '#tlpoBody')), '9: nothing from registration is asked again here');
await p.click('#tlpoHost .tlpo-btn.pri');
check((await p.$$eval('#tlpoBody .tlpo-f.bad', (x) => x.length)) === 4, '8: the four still needed are validated');
await p.selectOption('#tlpo_notice', '30 days');
await p.fill('#tlpo_sal', '8.5');
await p.fill('#tlpoChipIn_preferredRoles', 'Data Analyst'); await p.press('#tlpoChipIn_preferredRoles', 'Enter');
await p.check('.tlpo-mode input[value="Hybrid"]');

/* ---- finish: saved, Profile ready, Home ---------------------------------------- */
await p.click('#tlpoHost .tlpo-btn.pri');
await p.waitForSelector('#tlpoHost .tlpo-ready', { timeout: 30000 });
check(/\d+% complete/.test(await text(p, '#tlpoHost')), '11: "Profile ready" with the completion %');
await p.waitForFunction(() => !document.querySelector('#tlpoHost .tlpo-ov') && location.hash === '#/candidate/home', null, { timeout: 10000 });
check(true, '12: then straight to #/candidate/home, no extra click');
const st2 = await api(p, 'get', `/candidates/${me}/onboarding`);
check(st2.body.status === 'completed' && st2.body.draft === null, '11: the server says completed; the draft is gone');
const c1 = await p.evaluate((id) => DATA.candidateById(id), me);
check(c1.title === 'Senior Data Analyst', '7: the candidate\'s edit won over the resume');
check((c1.skills || []).length === 5 && (c1.experienceRecords || []).length === 2 && (c1.educationRecords || []).length >= 2, '11: skills, jobs and education saved');
check(c1.location === 'Hyderabad' && c1.noticePeriod === '30 days' && Number(c1.expectedCtc) === 8.5 && (c1.preferredWorkModes || []).includes('Hybrid'), '8: the six details saved');
/* a retry of Finish adds nothing */
const again = await api(p, 'post', `/candidates/${me}/onboarding/complete`, { experienceRecords: (c1.experienceRecords || []).map((x) => ({ company: x.company, jobTitle: x.jobTitle, employmentType: x.employmentType, responsibilities: x.responsibilities })) });
const c2 = (await api(p, 'get', `/candidates/${me}/onboarding`)).body;
check(again.ok && c2.status === 'completed', '5: a repeated Finish is accepted');
await p.reload(); await p.waitForFunction(() => window.TL && TL.ready && window.STATE && STATE.session, null, { timeout: 30000 });
await sleep(1500);
const c3 = await p.evaluate((id) => DATA.candidateById(id), me);
check((c3.experienceRecords || []).length === 2, `5: still two jobs after a retry (${(c3.experienceRecords || []).length})`);
check(!(await p.$('#tlpoHost .tlpo-ov')) && !(await p.$('#tlpoBanner')), '11: a finished profile is not asked about again (no box, no banner)');
await p.evaluate(() => { location.hash = '#/candidate/profile'; });
await sleep(1500);
check(/Senior Data Analyst/.test(await text(p, '#app')), '13: the Profile page shows the saved data');
check(p.errors.length === 0, `no page errors (${p.errors.join(' | ')})`);

/* ---- 14. the recruiter sees it ------------------------------------------------ */
const r = await newPage();
const rl = await api(r, 'post', '/auth/login', { email: 'recruiter@teamlink.com', password: 'TeamLink@2026', role: 'recruiter' });
check(rl.ok, '14: recruiter signs in');
const seen = await api(r, 'get', `/candidates/${me}`);
const rc = seen.ok ? (seen.body.candidate || seen.body) : null;
check(!!rc && (rc.skills || []).length === 5 && rc.preferredLocation === 'Hyderabad, Pune', `14: the recruiter portal reads the saved profile (${seen.ok ? 'ok' : seen.status + ' ' + seen.message})`);

/* ---- 6. skip the resume, type it in (phone width) ------------------------------ */
const p2 = await newPage({ width: 390, height: 844 });
await register(p2, `wizard.skip.${stamp}@mailbox-teamlink-tests.in`);
await p2.waitForSelector('#tlpoHost .tlpo-modal', { timeout: 15000 });
await p2.click('#tlpoHost .tlpo-btn.pri');
await p2.waitForSelector('.tlpo-skip', { timeout: 10000 });
check(await p2.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'phone: no horizontal scroll');
await p2.click('.tlpo-skip');
await p2.waitForFunction(() => /Step 3 of 5/.test(document.getElementById('tlpoStepNo').textContent), null, { timeout: 10000 });
await p2.fill('#tlpoChipIn_skills', 'Tally, GST'); await p2.press('#tlpoChipIn_skills', 'Enter');
await p2.click('#tlpoHost .tlpo-btn.pri');
await p2.selectOption('#tlpo_notice', 'Immediate');
await p2.fill('#tlpo_sal', '25000'); await p2.selectOption('.tlpo-unit', 'month');
await p2.fill('#tlpoChipIn_preferredRoles', 'Accountant'); await p2.press('#tlpoChipIn_preferredRoles', 'Enter');
await p2.check('.tlpo-mode input[value="Office"]');
await p2.click('#tlpoHost .tlpo-btn.pri');
await p2.waitForFunction(() => location.hash === '#/candidate/home' && !document.querySelector('#tlpoHost .tlpo-ov'), null, { timeout: 30000 });
const s2 = await p2.evaluate(() => DATA.candidateById(STATE.session.id));
check((s2.skills || []).join(',') === 'Excel,Tally,GST' && Number(s2.expectedCtc) === 3, `6: skip the resume, type it in: saved (${s2.skills} / ${s2.expectedCtc} LPA)`);
check(p2.errors.length === 0, `phone: no page errors (${p2.errors.join(' | ')})`);

/* ---- 1. recruiter-added candidate: login, password reset, then the prompt ------- */
const addEmail = `wizard.added.${stamp}@mailbox-teamlink-tests.in`;
const add = await api(r, 'post', '/candidates', { firstName: 'Added', lastName: 'Person', gender: 'Female', email: addEmail, phone: mobile(), location: 'Hyderabad' });
const addedId = add.ok ? (add.body.candidate || add.body).id : null;
check(!!addedId, `1: recruiter adds a candidate (${add.ok ? 'ok' : add.status + ' ' + add.message})`);
if (addedId) {
  const inv = await api(r, 'post', `/candidates/${addedId}/invite`, {});
  check(inv.ok, `1: the login email is sent (${inv.ok ? 'ok' : inv.status + ' ' + inv.message})`);
  const temp = await fromSink(addEmail, /Temporary password:\s*(\S+)/i);
  if (!temp) {
    console.log('     (1: no SINK_LOG with the invite email - set SINK_LOG to check the login + password reset)');
  } else {
    const p3 = await newPage();
    await p3.evaluate(() => { location.hash = '#/login/candidate'; });
    const li = await api(p3, 'post', '/auth/login', { email: addEmail, password: temp, role: 'candidate' });
    check(li.ok, '1: the candidate signs in with the emailed password');
    await p3.evaluate(() => TL.refresh());
    await p3.waitForSelector('#tlFirstCur', { timeout: 15000 });
    check(!(await p3.$('#tlpoHost .tlpo-ov')), '1: nothing else is asked while the password must be changed');
    await p3.fill('#tlFirstCur', temp);
    await p3.fill('#tlFirstNew', 'NewAdded9pass'); await p3.fill('#tlFirstNew2', 'NewAdded9pass');
    await p3.click('form button[type="submit"]');
    await p3.waitForFunction(() => location.hash === '#/candidate/home', null, { timeout: 20000 });
    check(true, '1: after the password reset the candidate lands on Candidate Home');
    await p3.waitForSelector('#tlpoHost .tlpo-modal', { timeout: 15000 }).catch(() => {});
    check(!!(await p3.$('#tlpoHost .tlpo-modal')), '1: ...and the Build your profile prompt appears');
    check(p3.errors.length === 0, `1: no page errors (${p3.errors.join(' | ')})`);
  }
}

await browser.close();
console.log(fail.length ? `\n${fail.length} FAILED:\n - ${fail.join('\n - ')}` : '\nall passed');
process.exit(fail.length ? 1 : 0);
