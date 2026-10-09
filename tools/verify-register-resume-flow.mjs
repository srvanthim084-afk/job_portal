/**
 * Candidate registration on ONE screen (0117, 0123), driven in a real browser.
 *
 *     TL_URL=http://127.0.0.1:4471/ node tools/verify-register-resume-flow.mjs
 *
 * Everything is on the page from the start (resume, personal, education, experience, mobile
 * verification), in order, with or without a resume. The resume is mandatory (PDF or DOCX, 5 MB), fills
 * only EMPTY fields, and never replaces what was typed. Notice period is mandatory. Create Account stays
 * hidden until the mobile number is verified with an OTP, and editing the number un-verifies it.
 *
 * On a development server without an SMS gateway the OTP is shown on the page as a development code;
 * that is what this script types. Creates one candidate, so it refuses :4323.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const BASE = (process.env.TL_URL || 'http://127.0.0.1:4471/').replace(/\/?$/, '/');
if (/:4323\//.test(BASE)) { console.error('Refusing to run against the live instance (:4323).'); process.exit(2); }
const fail = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`); if (!ok) fail.push(what); };

const DIR = resolve('var/test-resumes');
mkdirSync(DIR, { recursive: true });
const stamp = Date.now().toString(36);
const digits = String(Date.now()).slice(-9);
const phone = `9${digits}`;
const email = `rahul.flow.${stamp}@mailbox-teamlink-tests.in`;

/* A real DOCX, written by hand: three small XML parts in a stored (uncompressed) zip. */
function crc32(buf) {
  let c; let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function zipStored(files) {
  const parts = []; const central = []; let offset = 0;
  for (const [name, text] of files) {
    const data = Buffer.from(text, 'utf8'); const nm = Buffer.from(name, 'utf8'); const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nm.length, 26); lh.writeUInt16LE(0, 28);
    parts.push(lh, nm, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0, 8); ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(offset, 42);
    central.push(ch, nm);
    offset += 30 + nm.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}
const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
function makeDocx(lines) {
  const body = lines.map((l) => `<w:p><w:r><w:t xml:space="preserve">${esc(l)}</w:t></w:r></w:p>`).join('');
  return zipStored([
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
    ['word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`],
  ]);
}

const RESUME = resolve(DIR, `one-screen-${stamp}.docx`);
writeFileSync(RESUME, makeDocx([
  'RAHUL KUMAR', 'Senior Software Engineer',
  `Email: ${email} | Phone: +91 ${phone}`,
  'LinkedIn: https://www.linkedin.com/in/rahul-kumar-dev', 'Hyderabad, Telangana', '',
  'PROFESSIONAL SUMMARY', 'Backend engineer with 5 years of experience building Java and Spring Boot services.', '',
  'TECHNICAL SKILLS', 'Java, Spring Boot, SQL, Hibernate, Microservices, REST APIs, MySQL, Git', '',
  'WORK EXPERIENCE',
  'ABC Technologies Pvt Ltd - Senior Software Engineer (Jun 2022 - Present)',
  'XYZ Solutions - Software Engineer (Jul 2020 - May 2022)', '',
  'EDUCATION', 'B.Tech (Computer Science), JNTU Hyderabad, 2019, 74%',
  'Intermediate (MPC), Sri Chaitanya Junior College, 2015, 92%', '',
  'PROJECTS', 'Payment Gateway Integration - Spring Boot service handling UPI payments', '',
  'LANGUAGES', 'English, Telugu, Hindi',
]));
const TXT = resolve(DIR, `one-screen-${stamp}.txt`);
writeFileSync(TXT, 'plain text resume');
const BIG = resolve(DIR, `one-screen-big-${stamp}.docx`);
writeFileSync(BIG, Buffer.concat([makeDocx(['x']), Buffer.alloc(6 * 1024 * 1024)]));

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 1000 } })).newPage();
page.errors = [];
page.on('pageerror', (e) => page.errors.push(String(e.message)));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|40[0-9]|Content Security|connect-src|fonts\.g/i.test(m.text())) page.errors.push(m.text().slice(0, 160)); });
await page.goto(`${BASE}`, { waitUntil: 'load' });
await page.waitForFunction(() => window.TL && window.TL.ready === true, null, { timeout: 30000 });
await page.evaluate(() => { location.hash = '#/register/candidate'; });
await page.waitForSelector('#tlrfHost #tlrfName', { timeout: 15000 });

const vis = (sel) => page.evaluate((s) => { const e = document.querySelector(s); if (!e || e.hidden) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }, sel);
const top = (sel) => page.evaluate((s) => { const e = document.querySelector(s); return e ? e.getBoundingClientRect().top + scrollY : -1; }, sel);
const text = (sel) => page.evaluate((s) => { const e = document.querySelector(s); return e ? e.innerText : ''; }, sel);

/* ---- everything is there from the start, with no resume --------------- */
check(await page.evaluate(() => document.getElementById('registerForm').hidden), 'the seven-step form stays hidden');
const order = ['[data-tlrf="pick"]', '#tlrfName', '#tlrfEmail', '#tlrfQual', '#tlrfInst', '#tlrfYear', '#tlrfExp', '#tlrfCompany', '#tlrfRole', '#tlrfNotice', '#tlrfPhone', '#tlrfSendOtp'];
const tops = [];
for (const sel of order) tops.push(await top(sel));
check(tops.every((t, i) => t >= 0 && (i === 0 || t >= tops[i - 1] - 1)), `resume, name, email, qualification, institute, year, experience, company, role, notice, mobile - in that order, all present with no resume (${tops.map(Math.round).join(',')})`);
for (const sel of order.slice(1, 11)) {
  check(await page.evaluate((s) => { const e = document.querySelector(s); return !!e && !e.disabled && !e.readOnly; }, sel), `${sel} is editable from the start`);
}
check(!(await vis('#tlrfCreate')), 'Create Account is hidden until the mobile number is verified');
check(!(await vis('#tlrfOtpBox')), 'no OTP box before an OTP is sent');
const stars = await page.evaluate(() => [...document.querySelectorAll('#tlrfHost .tlrf-req')].map((s) => getComputedStyle(s).color));
check(stars.length >= 10 && stars.every((c) => c === 'rgb(217, 45, 32)'), `required fields carry a red asterisk (${stars.length})`);
check((await page.$$eval('#tlrfNotice option', (o) => o.map((x) => x.textContent))).join('|') === 'Select|Immediate|15 days|30 days|60 days|90 days|Currently serving notice', 'notice period options');
check(await page.evaluate(() => /Notice period\s*\*/.test(document.querySelector('label[for="tlrfNotice"]').innerText)), 'notice period is marked with *');

/* ---- the mobile number needs the resume first, and a real number ----------- */
await page.fill('#tlrfPhone', '12345');
await page.click('#tlrfSendOtp');
check(/valid 10-digit mobile number/i.test(await text('#tlrfHost')), 'an invalid number is refused before any OTP is sent');
await page.fill('#tlrfPhone', phone);
await page.click('#tlrfSendOtp');
check(/Upload your resume first/i.test(await text('#tlrfHost')), 'a valid number with no resume: asked to upload the resume first');
check(!(await vis('#tlrfOtpBox')), 'still no OTP box');

/* ---- the resume: only PDF or DOCX, 5 MB ------------------------------------ */
await page.setInputFiles('#tlrfFile', TXT);
check(/PDF or DOCX/.test(await text('#tlrfHost')), 'a .txt resume is refused: PDF or DOCX only');
await page.setInputFiles('#tlrfFile', BIG);
check(/too large.*5 MB/i.test(await text('#tlrfHost')), 'a file over 5 MB is refused');

/* something typed first must survive the resume filling the blanks */
await page.fill('#tlrfCompany', 'Typed Corp');
await page.setInputFiles('#tlrfFile', RESUME);
await page.waitForFunction(() => /Uploaded:/.test((document.getElementById('tlrfHost') || {}).innerText || ''), null, { timeout: 90000 });
check(/Uploaded: one-screen-.*\.docx/.test(await text('#tlrfHost')), 'the uploaded file name is shown');
check(await page.inputValue('#tlrfName') === 'Rahul Kumar', 'name filled from the resume');
check(await page.inputValue('#tlrfEmail') === email, 'email filled from the resume');
check(await page.inputValue('#tlrfPhone') === phone, 'the number the resume already had is not replaced');
check(/B\.?Tech/i.test(await page.inputValue('#tlrfQual')), 'highest qualification filled from the resume');
check(/JNTU/i.test(await page.inputValue('#tlrfInst')), 'institute filled from the resume');
check(await page.inputValue('#tlrfYear') === '2019', 'year of passing filled from the resume');
check(await page.inputValue('#tlrfExp') === '5', 'total experience filled from the resume');
check(await page.inputValue('#tlrfCompany') === 'Typed Corp', 'a value the candidate typed is NOT overwritten');
check(/ABC Technologies/.test(await page.inputValue('#tlrfRole')) === false && /Engineer/i.test(await page.inputValue('#tlrfRole')), 'current role filled from the resume');
await page.fill('#tlrfName', 'Rahul K. Kumar');
check(await page.inputValue('#tlrfName') === 'Rahul K. Kumar', 'an auto-filled value can be edited');
await page.fill('#tlrfCompany', 'ABC Technologies Pvt Ltd');
check(await page.inputValue('#tlrfNotice') === '', 'notice period is never guessed: it waits for a choice');

/* ---- the OTP ---------------------------------------------------------------- */
check(!(await vis('#tlrfCreate')), 'Create Account is still hidden');
await page.fill('#tlrfPhone', '98765');
await page.click('#tlrfSendOtp');
check(/valid 10-digit mobile number/i.test(await text('#tlrfHost')), 'a short number is refused');
await page.fill('#tlrfPhone', phone);
await page.click('#tlrfSendOtp');
await page.waitForSelector('#tlrfOtpBox:not([hidden])', { timeout: 20000 });
const dev = await page.textContent('.tlrf-dev b');
check(/^\d{6}$/.test(String(dev).trim()), 'an OTP was sent (a development server shows it on the page)');
check(!(await vis('#tlrfCreate')), 'Create Account is hidden while the OTP is unverified');
await page.fill('#tlrfOtp', '123');
await page.click('[data-tlrf="verifyotp"]');
check(/Enter the 6-digit OTP/.test(await text('#tlrfOtpBox')), '"Enter the 6-digit OTP" for a short code');
await page.fill('#tlrfOtp', String(dev).trim() === '000000' ? '111111' : '000000');
await page.click('[data-tlrf="verifyotp"]');
await page.waitForFunction(() => /Invalid OTP/.test((document.getElementById('tlrfOtpBox') || {}).innerText || ''), null, { timeout: 10000 }).catch(() => {});
check(/Invalid OTP/.test(await text('#tlrfOtpBox')), '"Invalid OTP" for a wrong code');
check(!(await vis('#tlrfCreate')), 'Create Account is still hidden after a wrong OTP');
await page.fill('#tlrfOtp', String(dev).trim());
await page.click('[data-tlrf="verifyotp"]');
await page.waitForSelector('#tlrfTick:not([hidden])', { timeout: 15000 });
check(/Mobile number verified/.test(await text('#tlrfTick')), 'a green "Mobile number verified" tick');
check(await page.evaluate(() => getComputedStyle(document.getElementById('tlrfTick')).color) !== 'rgb(0, 0, 0)', 'the tick is coloured');
check(!(await vis('#tlrfOtpBox')), 'the OTP box is hidden after verifying');
check(await vis('#tlrfCreate'), 'Create Account appears after verification');
check(!(await vis('#tlrfSendOtp')), 'Send OTP is replaced by the tick');

/* editing the number un-verifies it */
await page.fill('#tlrfPhone', `9${String(Number(digits) + 1).padStart(9, '0').slice(-9)}`);
check(!(await vis('#tlrfTick')) && !(await vis('#tlrfCreate')) && (await vis('#tlrfSendOtp')), 'editing the mobile number resets verification: no tick, no Create, Send OTP is back');
await page.fill('#tlrfPhone', phone);
check(!(await vis('#tlrfCreate')), 'typing the old number back does not re-verify it: the OTP is needed again');
await page.click('#tlrfSendOtp');
await page.waitForFunction(() => /Please wait 30 seconds|Development server/.test((document.getElementById('tlrfHost') || {}).innerText || ''), null, { timeout: 15000 });
const wait30 = /Please wait 30 seconds/.test(await text('#tlrfHost'));
check(true, `asking again ${wait30 ? 'is held back for 30 seconds' : 'sent a new OTP'}`);
if (wait30) {
  /* the 30-second wait is for people: let it pass, then verify again */
  await page.waitForTimeout(31000);
  await page.click('#tlrfSendOtp');
  await page.waitForSelector('#tlrfOtpBox:not([hidden])', { timeout: 20000 });
}
const dev2 = await page.textContent('.tlrf-dev b');
await page.fill('#tlrfOtp', String(dev2).trim());
await page.click('[data-tlrf="verifyotp"]');
await page.waitForSelector('#tlrfTick:not([hidden])', { timeout: 15000 });

/* ---- Create with something missing -------------------------------------------- */
await page.click('#tlrfCreate');
const miss = await text('#tlrfHost');
check(/Complete the required fields to continue/.test(miss), '"Complete the required fields to continue"');
check(/Notice period is required/.test(miss), 'inline error: "Notice period is required"');
check(/Preferred location is required/.test(miss) && /Expected salary is required/.test(miss) && /Select at least one work mode/.test(miss), 'every missing field is flagged inline (the location came from the resume)');
check((await page.$$('#tlrfHost .tlrf-bad')).length >= 5, 'each missing field is highlighted');
check(await page.evaluate(() => /Rahul K\. Kumar/.test(document.getElementById('tlrfName').value)), 'nothing typed was lost');

/* ---- complete it -------------------------------------------------------------- */
await page.selectOption('#tlrfNotice', '30 days');
await page.fill('#tlrfLoc', 'Hyderabad');
await page.fill('#tlrfPrefIn', 'Hyderabad'); await page.press('#tlrfPrefIn', 'Enter');
await page.check('#tlrfModes input[value="Hybrid"]');
await page.fill('#tlrfSal', '10');
await page.check('#tlrfTerms'); await page.check('#tlrfComm');
await page.fill('#tlrfPw', 'Resum3first9'); await page.fill('#tlrfPw2', 'Resum3first9');
await page.click('#tlrfCreate');
await page.waitForFunction(() => /Registration Successful/.test((document.getElementById('tlrfHost') || {}).innerText || ''), null, { timeout: 60000 }).catch(() => {});
const done = (await text('#tlrfHost')).replace(/\s+/g, ' ');
check(/Registration Successful/.test(done), 'the account is created');
check(/TL-CAN-\d{6}/.test(done), 'the Candidate ID is shown');
const me = await page.evaluate(() => window.TL.api.get('/auth/me'));
const c = (me && me.profile) || {};
check(c.noticePeriod === '30 days', `the notice period is on the profile (${c.noticePeriod})`);
check(c.currentCompany === 'ABC Technologies Pvt Ltd' && c.title && /Engineer/i.test(c.title), 'company and role are on the profile');
check(/B\.?Tech/i.test(String(c.education || '')), 'the qualification is on the profile');
check(!!c.resumeFile, 'the resume is attached');
check(page.errors.length === 0, `no page errors (${page.errors.join(' | ')})`);

/* ---- phone width ---------------------------------------------------------------- */
const m = await (await browser.newContext({ viewport: { width: 390, height: 800 } })).newPage();
await m.goto(`${BASE}`, { waitUntil: 'load' });
await m.waitForFunction(() => window.TL && window.TL.ready === true, null, { timeout: 30000 });
await m.evaluate(() => { location.hash = '#/register/candidate'; });
await m.waitForSelector('#tlrfHost #tlrfName', { timeout: 15000 });
check(await m.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'at 390px nothing scrolls sideways');
check(await m.evaluate(() => { const r = document.getElementById('tlrfPhone').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; }), 'the mobile field fits the phone screen');

await browser.close();
console.log(fail.length ? `\n${fail.length} failed` : '\nall good');
process.exit(fail.length ? 1 : 0);
