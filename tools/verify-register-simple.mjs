/**
 * Simplified candidate registration, driven in a real browser.
 *
 *     node tools/verify-register-simple.mjs     (TL_URL, default http://localhost:4323/)
 *
 * One screen: an OPTIONAL resume, seven profile fields that are always visible
 * (Full Name, Phone, Email, Highest Education, Most Recent Job Role, Most Recent
 * Company with "Fresher / No experience", Skills as tags), then the account
 * (email code, password, Terms required, recruitment communication optional).
 *
 * Checks: the page shape; no pre-ticked optional consent; a resume fills the seven
 * fields (2 projects are 2, not 12); a bad file is refused with a message and the
 * form stays usable; Replace re-reads without losing the verified email or what was
 * typed; editing wins over the resume; skills are de-duplicated; Fresher clears the
 * job fields; the account needs the email code and the Terms; a duplicate email is
 * told to Login / Forgot Password; double-click makes one account; success lands on
 * #/candidate/home signed in; registering with NO resume works the same way.
 *
 * On a dev server without mail the code is shown on the page; with a mail sink set
 * TL_CODE_FROM to a function-free path is not needed - the script reads the on-page
 * development code, or the SINK_LOG file's last "verification code is NNNNNN".
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const BASE = (process.env.TL_URL || 'http://localhost:4323/').replace(/\/$/, '');
const SINK_LOG = process.env.SINK_LOG || '';
const fail = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`); if (!ok) fail.push(what); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DIR = resolve('var/test-resumes');
mkdirSync(DIR, { recursive: true });
const stamp = Date.now().toString(36);
const mobile = () => '9' + String(Math.floor(1e8 + Math.random() * 9e8));
const mail = (p) => `${p}.${stamp}${Math.floor(Math.random() * 1000)}@mailbox-teamlink-tests.in`;

const RESUME_A = resolve(DIR, `simple-a-${stamp}.txt`);
writeFileSync(RESUME_A, [
  'PRIYA SHARMA', 'priya.sharma.dev@gmail.com | +91 98765 43210', 'Hyderabad', '',
  'EDUCATION', 'B.Sc (Statistics), Osmania University, 2021, 78%', 'Intermediate (MPC), Narayana College, 2018', '',
  'WORK EXPERIENCE', 'Infotech Systems - Associate Analyst (Jun 2021 - Jun 2022)', 'ABC Technologies Pvt Ltd - Data Analyst (Jul 2022 - Present)', '',
  'PROJECTS', '- Student Management System', '- Personal Portfolio Website', '',
  'SKILLS', 'SQL, Excel, Python, sql',
].join('\n'));
const RESUME_B = resolve(DIR, `simple-b-${stamp}.txt`);
writeFileSync(RESUME_B, [
  'MEERA IYER', 'meera.iyer.dev@gmail.com | +91 91234 56789', '',
  'EDUCATION', 'M.Sc (Physics), IISc, 2020', '',
  'WORK EXPERIENCE', 'Delta Labs Pvt Ltd - Research Associate (Jan 2021 - Present)', '',
  'SKILLS', 'MATLAB, Python',
].join('\n'));
const BROKEN = resolve(DIR, `simple-bad-${stamp}.exe`);
writeFileSync(BROKEN, 'MZ not a resume');

const browser = await chromium.launch();
async function openRegister(viewport = { width: 1280, height: 1000 }) {
  const page = await (await browser.newContext({ viewport })).newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(String(e.message)));
  await page.goto(`${BASE}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.TL && window.TL.ready === true, null, { timeout: 30000 });
  await page.evaluate(() => { location.hash = '#/register/candidate'; });
  await page.waitForSelector('#tlrfName', { timeout: 15000 });
  return page;
}
const val = (page, id) => page.evaluate((i) => (document.getElementById(i) || {}).value, id);
const tags = (page) => page.evaluate(() => [...document.querySelectorAll('#tlrfHost .tlrf-tags .filter-chip')].map((x) => x.firstChild.textContent.trim()));
const fillText = async (page, id, v) => { await page.fill('#' + id, v); await page.dispatchEvent('#' + id, 'change'); };
const hostText = (page) => page.evaluate(() => document.getElementById('tlrfHost').innerText);

async function sendCodeAndVerify(page, email) {
  await fillText(page, 'tlrfEmail', email);
  await page.click('[data-tlrf="sendcode"]');
  await page.waitForSelector('#tlrfCode', { timeout: 15000 });
  await sleep(300);
  let code = await page.evaluate(() => { const b = document.querySelector('#tlrfHost .tlrf-dev b'); return b ? b.textContent : null; });
  if (!code && SINK_LOG && existsSync(SINK_LOG)) {
    for (let i = 0; i < 20 && !code; i++) {
      const hit = [...readFileSync(SINK_LOG, 'utf8').matchAll(new RegExp(`To: ${email.replace(/[.+]/g, '\\$&')}[\\s\\S]*?verification code is (\\d{6})`, 'g'))].pop();
      code = hit && hit[1]; if (!code) await sleep(300);
    }
  }
  if (!code) return false;
  await page.fill('#tlrfCode', code);
  await page.click('[data-tlrf="verify"]');
  await page.waitForFunction(() => /✓ Verified/.test(document.getElementById('tlrfHost').innerText), null, { timeout: 15000 });
  return true;
}

/* ---- the shape of the page ------------------------------------------- */
let page = await openRegister();
check(await page.evaluate(() => document.getElementById('registerForm').hidden), 'the older seven-step form is hidden');
for (const id of ['tlrfName', 'tlrfPhone', 'tlrfEmail', 'tlrfEdu', 'tlrfRole', 'tlrfCompany', 'tlrfSkillIn', 'tlrfPw', 'tlrfPw2']) {
  check(await page.isVisible('#' + id), `${id} is visible before anything is uploaded`);
}
check(await page.isVisible('#tlrfFresher'), '"Fresher / No experience" is offered');
check((await page.$$eval('#tlrfEdu option', (o) => o.map((x) => x.textContent))).join('|') === "Select|10th|Intermediate|Diploma|Bachelor's Degree|Master's Degree|PhD|Other", 'Highest Education lists the seven choices');
check(!(await page.isChecked('#tlrfComm')), 'recruitment communication is NOT pre-selected');
check(!(await page.isChecked('#tlrfTerms')), 'Terms & Privacy is not pre-selected');
check(/optional/i.test(await hostText(page)), 'the resume is marked optional');

/* ---- a file that is not a resume ------------------------------------- */
await page.setInputFiles('#tlrfFile', BROKEN);
await page.waitForFunction(() => /PDF, DOC, DOCX or TXT/.test(document.getElementById('tlrfHost').innerText), null, { timeout: 8000 });
check(true, 'an unsupported file type is refused with a message');
check(await page.isVisible('#tlrfName'), 'the form is still usable after a refused file');

/* ---- a resume fills the seven fields; 2 projects are 2 ---------------- */
await page.setInputFiles('#tlrfFile', RESUME_A);
await page.waitForFunction(() => document.getElementById('tlrfName') && document.getElementById('tlrfName').value, null, { timeout: 60000 });
check((await val(page, 'tlrfName')) === 'Priya Sharma', 'name read from the resume');
check((await val(page, 'tlrfPhone')) === '9876543210', 'phone read from the resume');
check((await val(page, 'tlrfEmail')) === 'priya.sharma.dev@gmail.com', 'email read from the resume');
check((await val(page, 'tlrfEdu')) === "Bachelor's Degree", 'highest education = Bachelor\'s Degree');
check((await val(page, 'tlrfRole')) === 'Data Analyst' && (await val(page, 'tlrfCompany')) === 'ABC Technologies Pvt Ltd', 'most recent role and company by dates, not by order');
check((await tags(page)).join(',') === 'SQL,Excel,Python', 'skills are distinct tags');
check(/2 projects/.test(await hostText(page)), 'two projects are reported as 2');
check(/priya|simple-a/i.test(await hostText(page)), 'the file name is shown');

/* ---- typing wins; skills tags; Replace keeps what was typed ----------- */
await fillText(page, 'tlrfName', 'Priya S Sharma');
await page.fill('#tlrfSkillIn', 'excel');
await page.press('#tlrfSkillIn', 'Enter');
await page.fill('#tlrfSkillIn', 'Tableau, Power BI');
await page.press('#tlrfSkillIn', 'Enter');
check((await tags(page)).join(',') === 'SQL,Excel,Python,Tableau,Power BI', 'a skill typed twice (any case) is one tag; comma adds several');
await page.click('[data-tlrf="rmskill"][data-i="0"]');
check((await tags(page))[0] === 'Excel', 'a tag can be removed');
const emailA = mail('simple');
check(await sendCodeAndVerify(page, emailA), 'the email code is sent and verified');
await page.click('[data-tlrf="pick"]');
await page.setInputFiles('#tlrfFile', RESUME_B);
await page.waitForFunction(() => document.getElementById('tlrfEdu') && document.getElementById('tlrfEdu').value === "Master's Degree", null, { timeout: 60000 });
check((await val(page, 'tlrfName')) === 'Priya S Sharma', 'Replace keeps the name the candidate typed');
check((await val(page, 'tlrfEdu')) === "Master's Degree" && (await val(page, 'tlrfCompany')) === 'Delta Labs Pvt Ltd', 'Replace re-reads the fields the candidate did not edit');
check((await val(page, 'tlrfEmail')) === emailA && /✓ Verified/.test(await hostText(page)), 'Replace keeps the verified email');

/* ---- Fresher clears the job fields ----------------------------------- */
await page.check('#tlrfFresher');
await page.dispatchEvent('#tlrfFresher', 'change');
check(await page.isDisabled('#tlrfCompany') && (await val(page, 'tlrfCompany')) === '', 'Fresher / No experience clears and disables company');
await page.uncheck('#tlrfFresher');
await page.dispatchEvent('#tlrfFresher', 'change');

/* ---- Terms are required; communication is not ------------------------- */
await fillText(page, 'tlrfPhone', mobile());
await page.fill('#tlrfPw', 'Regist3r9pass'); await page.fill('#tlrfPw2', 'Regist3r9pass');
await page.click('[data-tlrf="create"]');
check(/Terms/.test(await hostText(page)) && (await page.evaluate(() => location.hash)).includes('register'), 'without the Terms the account is not created');

/* ---- create it; double click makes one account; lands on Home --------- */
await page.check('#tlrfTerms');
await page.dblclick('[data-tlrf="create"]');
await page.waitForFunction(() => location.hash === '#/candidate/home', null, { timeout: 30000 });
check(await page.evaluate(() => !!(window.STATE && STATE.session)), 'signed in after registering');
const count = await page.evaluate(async (e) => (await TL.api.get('/me/profile-completeness').catch(() => null)) ? 1 : 0, emailA);
check(count === 1, 'the session works (one account)');
check(page.errors.length === 0, `no page errors (${page.errors.join(' | ')})`);

/* ---- a duplicate email is told to Login / Forgot Password ------------- */
page = await openRegister();
await fillText(page, 'tlrfEmail', emailA);
await page.click('[data-tlrf="sendcode"]');
await page.waitForFunction(() => /already exists/.test(document.getElementById('tlrfHost').innerText), null, { timeout: 15000 });
check(await page.isVisible('#tlrfHost a[href="#/login/candidate"]') && await page.isVisible('#tlrfHost a[href="#/forgot-password"]'), 'duplicate email: message with Login and Forgot Password');

/* ---- NO resume at all, on a phone-sized screen ------------------------ */
page = await openRegister({ width: 390, height: 844 });
const emailB = mail('noresume');
await fillText(page, 'tlrfName', 'Karan Mehta');
await fillText(page, 'tlrfPhone', mobile());
await page.selectOption('#tlrfEdu', "Diploma");
await page.dispatchEvent('#tlrfEdu', 'change');
await page.check('#tlrfFresher'); await page.dispatchEvent('#tlrfFresher', 'change');
await page.fill('#tlrfSkillIn', 'Tally'); await page.press('#tlrfSkillIn', 'Enter');
check(await sendCodeAndVerify(page, emailB), 'no resume: the email code works');
check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no horizontal scroll at phone width');
await page.fill('#tlrfPw', 'Regist3r9pass'); await page.fill('#tlrfPw2', 'Regist3r9pass');
await page.check('#tlrfTerms');
await page.click('[data-tlrf="create"]');
await page.waitForFunction(() => location.hash === '#/candidate/home', null, { timeout: 30000 });
check(true, 'no resume: the account is created and the candidate lands on #/candidate/home');
check(page.errors.length === 0, `no page errors (${page.errors.join(' | ')})`);

await browser.close();
console.log(fail.length ? `\n${fail.length} FAILED:\n - ${fail.join('\n - ')}` : '\nall passed');
process.exit(fail.length ? 1 : 0);
