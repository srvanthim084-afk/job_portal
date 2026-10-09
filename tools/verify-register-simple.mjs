/**
 * Candidate registration - the classic one-page form - driven in a real browser.
 *
 *     TL_URL=http://127.0.0.1:4443 [SINK_LOG=<mail sink log>] node tools/verify-register-simple.mjs
 *
 *   1 Personal Information   2 Professional Information   3 Resume   4 Preferences   5 Consent
 *
 * Checks: the five sections in that order with the owner's fields and stars; WhatsApp not pre-ticked;
 * a resume fills EMPTY fields only (marked), a different value for a typed field is an "AI found..."
 * tag that applies on click, the status says how many fields were detected; pasted text works the
 * same way; a bad file is refused; Experienced shows company / designation / experience; required
 * fields are checked; the email code; one account on a double click; signed in and on
 * #/candidate/home; the record holds what was entered; a duplicate email is told to Login / Forgot
 * Password; phone width has no sideways scroll.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const BASE = (process.env.TL_URL || 'http://localhost:4323/').replace(/\/$/, '');
const SINK_LOG = process.env.SINK_LOG || '';
const fail = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`); if (!ok) fail.push(what); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fromSink(to, re) {
  if (!SINK_LOG) return null;
  for (let i = 0; i < 30; i++) {
    if (existsSync(SINK_LOG)) {
      const last = readFileSync(SINK_LOG, 'utf8').split('===== MESSAGE =====')
        .map((b) => b.replace(/=\r?\n/g, '')).filter((b) => b.includes('To: ' + to)).pop();
      const m = last && re.exec(last);
      if (m) return m[1];
    }
    await sleep(300);
  }
  return null;
}

const DIR = resolve('var/test-resumes');
mkdirSync(DIR, { recursive: true });
const stamp = Date.now().toString(36);
const mobile = () => '9' + String(Math.floor(1e8 + Math.random() * 9e8));
const mail = (p) => `${p}.${stamp}${Math.floor(Math.random() * 1000)}@mailbox-teamlink-tests.in`;
const RESUME_LINES = [
  'PRIYA SHARMA', 'priya.sharma.dev@gmail.com | +91 98765 43210', 'Hyderabad', '',
  'EDUCATION', 'B.Tech (Computer Science), JNTU Hyderabad, 2021, 78%', 'Intermediate (MPC), Narayana College, 2017', '',
  'WORK EXPERIENCE', 'Infotech Systems - Associate Analyst (Jun 2021 - Jun 2022)', 'ABC Technologies Pvt Ltd - Data Analyst (Jul 2022 - Present)', '',
  'PROJECTS', '- Student Management System', '- Personal Portfolio Website', '',
  'SKILLS', 'SQL, Excel, Python, sql',
];
const RESUME = resolve(DIR, `classic-${stamp}.txt`);
writeFileSync(RESUME, RESUME_LINES.join('\n'));
const BROKEN = resolve(DIR, `classic-bad-${stamp}.exe`);
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
const fill = async (page, id, v) => { await page.fill('#' + id, v); await page.dispatchEvent('#' + id, 'change'); };
const hostText = (page) => page.evaluate(() => document.getElementById('tlrfHost').innerText);

async function verifyEmail(page, email) {
  await fill(page, 'tlrfEmail', email);
  await page.click('[data-tlrf="sendcode"]');
  await page.waitForSelector('#tlrfCode', { timeout: 15000 });
  await sleep(400);
  let code = await page.evaluate(() => { const b = document.querySelector('#tlrfHost .tlrf-dev b'); return b ? b.textContent : null; });
  if (!code) code = await fromSink(email, /verification code is (\d{6})/);
  if (!code) return false;
  await page.fill('#tlrfCode', code);
  await page.click('[data-tlrf="verify"]');
  await page.waitForFunction(() => /✓ Verified/.test(document.getElementById('tlrfHost').innerText), null, { timeout: 15000 });
  return true;
}


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

/* ---- the shape of the page -------------------------------------------------- */
let page = await openRegister();
const heads = await page.$$eval('#tlrfHost .panel-head h2', (x) => x.map((h) => h.textContent.replace(/^\d+/, '').trim()));
check(heads.join(' | ') === 'Resume | Personal Information | Professional Information | Preferences | Consent', `five sections in order (${heads.join(' | ')})`);
const labels = await page.$$eval('#tlrfHost label', (x) => x.map((l) => l.textContent.replace(/\s+/g, ' ').trim()));
for (const want of ['Full Name *', 'Email Address *', 'Mobile Number *', 'Password *', 'Confirm Password *', 'Current Location *', 'Candidate Type *',
  'Highest Qualification *', 'Key Skills *', 'Preferred Job Location *', 'Expected Salary (₹ LPA)', 'Notice Period', 'Preferred Work Mode']) {
  check(labels.some((l) => l.startsWith(want)), `field: ${want}`);
}
check(/Upload Resume \(PDF \/ DOC \/ DOCX \/ TXT\)/.test(await hostText(page)) && /fills the form below automatically/.test(await hostText(page)), 'Resume first: Upload button and "fills the form below automatically"');
check(/prefer to paste text instead\? \(optional\)/i.test(await hostText(page)) && await page.isVisible('[data-tlrf="analyze"]'), 'Resume: paste text + Analyze with AI');
check(!(await page.isChecked('#tlrfWa')) && !(await page.isChecked('#tlrfTerms')) && !(await page.isChecked('#tlrfResumeOk')), 'no consent is pre-ticked (WhatsApp optional)');
check(!(await page.isVisible('#tlrfCompany')), 'Fresher: no company / designation fields');
check(await page.isVisible('[data-tlrf="sendcode"]') && await page.isVisible('[data-tlrf="sendotp"]'), 'Send code (email) and Send OTP (mobile) are both on the page');
check(await page.evaluate(() => document.getElementById('registerForm').hidden && ![...document.querySelectorAll('.tlr-stepper')].some((x) => x.offsetParent !== null)), 'no steps: one page, the seven-step form stays hidden');
await page.check('input[name="tlrfType"][value="experienced"]');
check(await page.isVisible('#tlrfCompany') && await page.isVisible('#tlrfDesig') && await page.isVisible('#tlrfExp'), 'Experienced: Current Company, Current Designation, Total Experience');
await page.check('input[name="tlrfType"][value="fresher"]');

/* ---- a bad file (on a fresh page: the type was chosen by hand above) ----------- */
page = await openRegister();
await page.setInputFiles('#tlrfFile', BROKEN);
await sleep(300);
check(/PDF, DOC, DOCX or TXT/.test(await hostText(page)), 'an unsupported file is refused with a message');

/* ---- typed first, then a resume: fills the empties, never overwrites ----------------- */
await fill(page, 'tlrfName', 'Priya S');
await page.setInputFiles('#tlrfFile', RESUME);
await page.waitForFunction(() => /fields? detected/.test(document.getElementById('tlrfHost').innerText), null, { timeout: 60000 });
check(/Resume analyzed successfully — \d+ fields detected/.test(await hostText(page)), 'status: "Resume analyzed successfully — N fields detected"');
check((await val(page, 'tlrfName')) === 'Priya S', 'a typed name is NOT overwritten');
check(await page.isVisible('#tlrfHost .tlrf-sugg[data-k="name"]') && /AI found: Priya Sharma/.test(await hostText(page)), '...the resume\'s name is offered as "AI found: Priya Sharma"');
check((await val(page, 'tlrfEmail')) === 'priya.sharma.dev@gmail.com' && (await val(page, 'tlrfPhone')) === '9876543210', 'empty email and mobile filled from the resume');
check((await val(page, 'tlrfLoc')) === 'Hyderabad', 'empty current location filled');
check((await val(page, 'tlrfQual')) === 'B.Tech/B.E', 'qualification matched to the form\'s list (B.Tech -> B.Tech/B.E)');
check((await tags(page)).join(',') === 'SQL,Excel,Python', 'skills distinct');
check(await page.isChecked('input[name="tlrfType"][value="experienced"]') && (await val(page, 'tlrfCompany')) === 'ABC Technologies Pvt Ltd' && (await val(page, 'tlrfDesig')) === 'Data Analyst', 'experienced: most recent company and designation by dates');
check((await page.$$('#tlrfHost .ai-extracted-tag')).length >= 4, 'filled fields are marked "AI extracted"');
await page.click('#tlrfHost .tlrf-sugg[data-k="name"]');
check((await val(page, 'tlrfName')) === 'Priya Sharma', 'clicking "AI found" uses the value');

/* ---- pasted text works too ----------------------------------------------------- */
const p2 = await openRegister();
await p2.fill('#tlrfPaste', ['MEERA IYER', 'meera.iyer.dev@gmail.com | +91 91234 56789', 'Chennai', '', 'EDUCATION', 'M.Sc (Physics), IISc, 2020', '', 'SKILLS', 'MATLAB, Python'].join('\n'));
await p2.click('[data-tlrf="analyze"]');
await p2.waitForFunction(() => /fields? detected/.test(document.getElementById('tlrfHost').innerText), null, { timeout: 60000 });
check((await val(p2, 'tlrfName')) === 'Meera Iyer' && (await val(p2, 'tlrfQual')) === 'M.Sc' && (await tags(p2)).join(',') === 'MATLAB,Python', 'pasted text: Analyze with AI fills the form');

/* ---- required fields ----------------------------------------------------------- */
await page.click('[data-tlrf="create"]');
const errs = await hostText(page);
check(/verify your email/i.test(errs) && /verify your mobile number/i.test(errs) && /Password must be/.test(errs) && /Preferred Job Location is required/.test(errs) && /Terms/.test(errs), 'required fields are checked (email code, mobile OTP, password, preferred location, consents)');
check((await page.evaluate(() => location.hash)).includes('register'), 'nothing is created while fields are missing');

/* ---- complete it ---------------------------------------------------------------- */
const email = mail('classic');
check(await verifyEmail(page, email), 'the email code is sent and verified');
check(await verifyPhone(page, mobile()), 'the mobile OTP is sent and verified');
await page.fill('#tlrfPw', 'Regist3r9pass'); await page.fill('#tlrfPw2', 'Regist3r9pass');
await page.selectOption('#tlrfExp', '3'); await page.dispatchEvent('#tlrfExp', 'change');
await fill(page, 'tlrfPref', 'Hyderabad, Pune');
await fill(page, 'tlrfSal', '8');
await page.selectOption('#tlrfNotice', '30 days'); await page.dispatchEvent('#tlrfNotice', 'change');
await page.check('input[data-tlrf-mode][value="Hybrid"]');
await page.check('#tlrfTerms'); await page.check('#tlrfResumeOk'); await page.check('#tlrfWa');
await page.dblclick('[data-tlrf="create"]');
await page.waitForFunction(() => location.hash === '#/candidate/home', null, { timeout: 30000 });
check(await page.evaluate(() => !!(window.STATE && STATE.session)), 'signed in and on #/candidate/home');
await sleep(800);
const me = await page.evaluate(() => DATA.candidateById(STATE.session.id));
check(me.name === 'Priya Sharma' && me.location === 'Hyderabad', 'saved: name and current location');
check(me.preferredLocation === 'Hyderabad, Pune' && Number(me.expectedCtc) === 8 && me.noticePeriod === '30 days' && (me.preferredWorkModes || []).includes('Hybrid'), 'saved: preferences');
check(me.currentCompany === 'ABC Technologies Pvt Ltd' && me.title === 'Data Analyst' && Number(me.expYears) === 3, 'saved: company, designation, experience');
check((me.skills || []).join(',') === 'SQL,Excel,Python', 'saved: skills');
check(me.whatsappOptIn === true, 'saved: WhatsApp opt-in');
check((me.educationRecords || []).some((e) => /B\.Tech/.test(e.qualification || '')) || /B\.Tech/.test(me.education || ''), 'saved: the qualification');
check(!!me.resumeFile, 'saved: the resume is attached');
check(page.errors.length === 0, `no page errors (${page.errors.join(' | ')})`);

/* ---- a remembered seven-step choice from an older version does not bring the steps back ---- */
{
  const old = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await old.goto(`${BASE}/`, { waitUntil: 'load' });
  await old.evaluate(() => sessionStorage.setItem('tl_reg_manual_v1', '1'));
  await old.reload({ waitUntil: 'load' });
  await old.waitForFunction(() => window.TL && window.TL.ready === true, null, { timeout: 30000 });
  await old.evaluate(() => { location.hash = '#/register/candidate'; });
  await old.waitForSelector('#tlrfName', { timeout: 15000 });
  check(await old.evaluate(() => document.getElementById('registerForm').hidden && ![...document.querySelectorAll('.tlr-stepper')].some((x) => x.offsetParent !== null) && !!document.getElementById('tlrfName')), 'an old "manual" choice is forgotten: one page, no steps');
}

/* ---- signed in (an admin testing, or a candidate who just registered): still the one page ---- */
{
  const sp = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  sp.errors = []; sp.on('pageerror', (e) => sp.errors.push(String(e.message)));
  await sp.goto(`${BASE}/`, { waitUntil: 'load' });
  await sp.waitForFunction(() => window.TL && window.TL.ready === true, null, { timeout: 30000 });
  await sp.evaluate(() => TL.api.post('/auth/login', { email: 'admin@teamlink.com', password: 'TeamLink@2026', role: 'admin' }).then(() => TL.refresh()));
  await sp.evaluate(() => { location.hash = '#/register/candidate'; });
  await sp.waitForSelector('#tlrfName', { timeout: 15000 });
  await sp.waitForTimeout(800);
  const shape = await sp.evaluate(() => ({ sections: document.querySelectorAll('#tlrfHost .panel-head h2').length,
    steps: [...document.querySelectorAll('.tlr-stepper')].some((x) => x.offsetParent !== null),
    form: !!document.getElementById('registerForm') && document.getElementById('registerForm').offsetParent !== null,
    note: /You are signed in as/.test(document.getElementById('tlrfHost').innerText) }));
  check(shape.sections === 5 && !shape.steps && !shape.form, `signed in: Register is still the one page, no steps (${JSON.stringify(shape)})`);
  check(shape.note && await sp.isVisible('[data-tlrf="signout"]'), 'signed in: the page says who is signed in, with Sign out');
  check(sp.errors.length === 0, `signed in: no page errors (${sp.errors.join(' | ')})`);
}

/* ---- a duplicate email ------------------------------------------------------------ */
page = await openRegister();
await fill(page, 'tlrfEmail', email);
await page.click('[data-tlrf="sendcode"]');
await page.waitForFunction(() => /already exists/.test(document.getElementById('tlrfHost').innerText), null, { timeout: 15000 });
check(await page.isVisible('#tlrfHost a[href="#/login/candidate"]') && await page.isVisible('#tlrfHost a[href="#/forgot-password"]'), 'duplicate email: Login and Forgot Password');

/* ---- no resume, phone width ------------------------------------------------------- */
page = await openRegister({ width: 390, height: 844 });
check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'phone: no sideways scroll');
await fill(page, 'tlrfName', 'Karan Mehta');
await fill(page, 'tlrfLoc', 'Vijayawada');
await page.selectOption('#tlrfQual', 'Diploma'); await page.dispatchEvent('#tlrfQual', 'change');
await page.fill('#tlrfSkillIn', 'Tally'); await page.press('#tlrfSkillIn', 'Enter');
await fill(page, 'tlrfPref', 'Vijayawada');
check(await verifyEmail(page, mail('noresume')), 'no resume: the email code works');
check(await verifyPhone(page, mobile()), 'no resume: the mobile OTP works');
await page.fill('#tlrfPw', 'Regist3r9pass'); await page.fill('#tlrfPw2', 'Regist3r9pass');
await page.check('#tlrfTerms'); await page.check('#tlrfResumeOk');
await page.click('[data-tlrf="create"]');
await page.waitForFunction(() => location.hash === '#/candidate/home', null, { timeout: 30000 });
check(true, 'no resume: account created, on #/candidate/home');
check(page.errors.length === 0, `phone: no page errors (${page.errors.join(' | ')})`);

await browser.close();
console.log(fail.length ? `\n${fail.length} FAILED:\n - ${fail.join('\n - ')}` : '\nall passed');
process.exit(fail.length ? 1 : 0);
