/**
 * Resume-first registration (0117), driven in a real browser.
 *
 *     node tools/verify-register-resume-flow.mjs     (dev server on :4323)
 *
 * Upload a resume -> it is read on the server -> the page shows what it
 * found and asks ONLY for current location, preferred location, work mode,
 * expected salary and password (notice period is asked on the profile step) -> the email answers a
 * code -> Create account -> "Your profile has been created from your
 * resume" with only the missing details.
 *
 * Also: an unreadable file says so and keeps the resume, offering retry
 * and the manual form; "Enter my details manually" shows the seven-step
 * form; and nothing the resume said is asked again.
 *
 * On a dev server without mail, the code is shown on the page as a
 * development code; that is what this script types.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const BASE = (process.env.TL_URL || 'http://localhost:4323/').replace(/\/$/, '');
const fail = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`); if (!ok) fail.push(what); };

const DIR = resolve('var/test-resumes');
mkdirSync(DIR, { recursive: true });
const stamp = Date.now().toString(36);
const digits = String(Date.now()).slice(-9);
const email = `rahul.flow.${stamp}@mailbox-teamlink-tests.in`;
const RESUME = resolve(DIR, `resume-first-${stamp}.txt`);
writeFileSync(RESUME, [
  'RAHUL KUMAR', 'Senior Software Engineer',
  `Email: ${email} | Phone: +91 9${digits}`,
  'LinkedIn: https://www.linkedin.com/in/rahul-kumar-dev', 'Hyderabad, Telangana', '',
  'PROFESSIONAL SUMMARY', 'Backend engineer with 5 years of experience building Java and Spring Boot services.', '',
  'TECHNICAL SKILLS', 'Java, Spring Boot, SQL, Hibernate, Microservices, REST APIs, MySQL, Git', '',
  'WORK EXPERIENCE',
  'ABC Technologies Pvt Ltd - Senior Software Engineer (Jun 2022 - Present)',
  'XYZ Solutions - Software Engineer (Jul 2020 - May 2022)',
  'Infotech Systems - Associate Software Engineer (Jun 2019 - Jun 2020)', '',
  'EDUCATION', 'B.Tech (Computer Science), JNTU Hyderabad, 2019, 74%',
  'Intermediate (MPC), Sri Chaitanya Junior College, 2015, 92%', 'SSC, ZP High School, 2013, 9.2 CGPA', '',
  'PROJECTS', 'Payment Gateway Integration - Spring Boot service handling UPI payments',
  'Inventory Reporting Dashboard - SQL and Java reporting for retail stores', '',
  'CERTIFICATIONS', 'Oracle Certified Professional Java SE 11 Developer', 'AWS Certified Cloud Practitioner', '',
  'LANGUAGES', 'English, Telugu, Hindi',
].join('\n'));
const BROKEN = resolve(DIR, `scan-${stamp}.pdf`);
writeFileSync(BROKEN, Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n', 'latin1'));

const browser = await chromium.launch();

async function openRegister(viewport) {
  const page = await (await browser.newContext({ viewport })).newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(String(e.message)));
  await page.goto(`${BASE}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.TL && window.TL.ready === true, null, { timeout: 30000 });
  await page.evaluate(() => { location.hash = '#/register/candidate'; });
  await page.waitForSelector('#tlrfHost', { timeout: 15000 });
  return page;
}

/* ---- the first thing on the page is the resume upload ---------------- */
const page = await openRegister({ width: 1280, height: 1000 });
check(await page.evaluate(() => document.getElementById('registerForm').hidden), 'the seven-step form is hidden behind the resume upload');
check(await page.isVisible('[data-tlrf="pick"]'), 'the upload button is the first control');
check(await page.isVisible('[data-tlrf="manual"]'), '"Enter my details manually" is offered');

/* ---- upload: read on the server, summary shown ------------------------ */
await page.setInputFiles('#tlrfFile', RESUME);
await page.waitForSelector('#tlrfLoc', { timeout: 90000 });
const found = await page.textContent('.tlrf-found');
for (const want of ['Rahul Kumar', '5 yrs experience', 'skills', '3 education records', '3 companies', '2 projects', '2 certifications']) {
  check(found.includes(want), `found on the resume: ${want}`);
}
const asked = await page.evaluate(() => ({
  name: !!document.getElementById('tlrfC_name'),
  phone: !!document.getElementById('tlrfC_phone'),
  ids: [...document.querySelectorAll('#tlrfHost input, #tlrfHost select')].map((x) => x.id).filter(Boolean),
}));
check(!asked.name && !asked.phone, 'name and mobile are not asked again');
check(!asked.ids.some((id) => /skill|company|qualif|educ|designation|exper/i.test(id)),
  `no resume field is asked again (${asked.ids.join(', ')})`);
check(await page.inputValue('#tlrfEmail') === email, 'the email comes from the resume');

/* ---- nothing goes without the required answers ------------------------ */
check(await page.inputValue('#tlrfLoc') === 'Hyderabad', 'current location starts from the resume, for the candidate to confirm');
await page.fill('#tlrfLoc', '');
await page.click('[data-tlrf="create"]');
const errs = await page.evaluate(() => [...document.querySelectorAll('#tlrfHost .tlrf-err')].map((e) => e.textContent));
check(errs.some((e) => /Current Location is required/.test(e)), 'current location is required');
check(errs.some((e) => /verify your email/i.test(e)), 'the email must be verified first');

/* ---- the six answers + the code --------------------------------------- */
await page.fill('#tlrfLoc', 'Hyderabad');
for (const c of ['Hyderabad', 'Bengaluru']) { await page.fill('#tlrfPrefIn', c); await page.press('#tlrfPrefIn', 'Enter'); }
check(!(await page.$('#tlrfNotice')), 'notice period is not on the registration form');
await page.check('#tlrfModes input[value="Hybrid"]');
await page.fill('#tlrfSal', '10');
await page.check('#tlrfTerms');
await page.check('#tlrfComm');
await page.click('[data-tlrf="sendcode"]');
await page.waitForSelector('#tlrfCode', { timeout: 20000 });
const dev = await page.$('.tlrf-dev b');
check(!!dev, 'a code was issued (shown as a development code on a server without mail)');
if (dev) {
  await page.fill('#tlrfCode', '000000');
  await page.click('[data-tlrf="verify"]');
  await page.waitForTimeout(800);
  check(/not right/i.test(await page.textContent('#tlrfHost')), 'a wrong code is refused');
  await page.fill('#tlrfCode', (await dev.textContent()).trim());
  await page.click('[data-tlrf="verify"]');
  await page.waitForSelector('#tlrfEmail[readonly]', { timeout: 20000 });
  check(true, 'the email is verified');
}
await page.fill('#tlrfPw', 'Resum3first9');
await page.fill('#tlrfPw2', 'Resum3first9');
await page.click('[data-tlrf="create"]');
await page.waitForFunction(() => /Registration Successful/.test((document.getElementById('tlrfHost') || {}).textContent || ''),
  null, { timeout: 60000 }).catch(() => {});
const done = (await page.textContent('#tlrfHost')).replace(/\s+/g, ' ');
check(/Registration Successful/.test(done), 'the account is created');
check(/TL-CAN-\d{6}/.test(done), 'the Candidate ID is shown');
check(/Your profile has been created from your resume\./.test(done), '"Your profile has been created from your resume."');
const pct = Number((/Profile Completeness: (\d+)%/.exec(done) || [])[1]);
check(pct > 0 && pct < 100, `Profile Completeness is shown and below 100 while something is missing (${pct}%)`);
check(/Availability/.test(done) && /Notice/i.test(done) && !/Key skills|Education|Resume:/.test(done), 'only the missing details are listed (notice period, availability)');
const me = await page.evaluate(() => window.TL.api.get('/me/profile-completeness'));
check(me.percent === pct, `the page and the server agree (${me.percent}%)`);
const prof = await page.evaluate(() => window.TL.api.get('/auth/me'));
const c = (prof && prof.profile) || {};
check((c.skills || []).includes('Spring Boot'), 'skills are on the profile');
check(c.currentCompany === 'ABC Technologies Pvt Ltd', 'the current company is on the profile');
check(!c.noticePeriod && c.location === 'Hyderabad', 'the candidate\'s answers are on the profile');
check(!!c.resumeFile, 'the resume is attached');
check(page.errors.length === 0, `no page errors (${page.errors.join(' | ')})`);
await page.screenshot({ path: resolve(DIR, `resume-first-done-${stamp}.png`) });

/* ---- an unreadable resume, on a phone ---------------------------------- */
const phone = await openRegister({ width: 390, height: 860 });
await phone.setInputFiles('#tlrfFile', BROKEN);
await phone.waitForSelector('[data-tlrf="retry"]', { timeout: 90000 });
const msg = (await phone.textContent('#tlrfHost')).replace(/\s+/g, ' ');
check(/We couldn't extract your resume automatically\. Please review or enter the missing information manually\./.test(msg),
  'the owner\'s message for an unreadable resume');
check(/is saved - nothing is lost/.test(msg), 'and the resume is kept');
check(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no sideways scroll at 390px');
await phone.click('[data-tlrf="manual"]');
check(await phone.evaluate(() => !document.getElementById('registerForm').hidden), '"Enter my details manually" shows the seven-step form');

await browser.close();
console.log(fail.length ? `\n${fail.length} FAILED` : '\nall passed');
process.exit(fail.length ? 1 : 0);
