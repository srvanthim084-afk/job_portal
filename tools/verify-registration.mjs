/**
 * The seven-step candidate registration, the Candidate ID, consent,
 * the welcome email, and the profile's documents and privacy tools - in a
 * real browser, at desktop width and at phone width (390px).
 *
 *   REGISTRATION  Register opens the form; 7 steps with progress; Back /
 *                 Continue; data kept between steps; draft auto-save (and
 *                 never the password); required / email / mobile /
 *                 password / confirm validation in the owner's words;
 *                 duplicate email and mobile, inline and on the server;
 *                 resume type check, upload, parsing without overwriting;
 *                 account created; Candidate ID on the success screen;
 *                 profile fields saved; consent stored with its version;
 *                 welcome email with the Candidate ID
 *   PROFILE       Candidate ID shown; documents upload / replace /
 *                 download / delete; Download My Data; Request Account
 *                 Deletion -> admin sees it; recruiters see the Candidate ID
 *   A11Y / SEC    labels, focus moved to the first problem, alert summary,
 *                 keyboard (Enter continues), no XSS from a name, CSRF on a
 *                 document upload, no horizontal scroll at 390px
 *
 * Creates accounts, so it refuses :4323. Run against an isolated instance:
 *   TL_URL=http://127.0.0.1:4424/ TL_SINK_LOG=<sink log> TL_RESUME_DIR=<dir> node tools/verify-registration.mjs
 * (TL_RESUME_DIR: the output of tools/make-test-resumes.mjs.)
 */
import { chromium } from 'playwright';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = (process.env.TL_URL || 'http://127.0.0.1:4424/').replace(/\/?$/, '/');
const url = new URL(BASE);
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.port === '4323') {
  console.error(`Refusing to run against ${BASE}: this creates accounts. Use an isolated instance.`);
  process.exit(2);
}
const RESUMES = process.env.TL_RESUME_DIR || join('var', 'test-resumes');
const SINK = process.env.TL_SINK_LOG || '';
const SHOTS = process.env.TL_SHOTS || '';
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const PDF = join(RESUMES, 'Resume - Sravanthi.pdf');
const TXT = join(RESUMES, 'Resume - Sravanthi.txt');
if (!existsSync(PDF)) { console.error('Run tools/make-test-resumes.mjs first (or set TL_RESUME_DIR): ' + PDF); process.exit(2); }

let failed = 0, passed = 0;
const check = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  PASS  ${name}`); }
  catch (e) { failed += 1; console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n')[0]}`); }
};
const must = (c, m) => { if (!c) throw new Error(m); };
const stamp = Date.now().toString(36);
const phone = () => '9' + String(Math.floor(1e8 + Math.random() * 9e8));
/* Not a reserved test domain, so the provider does not skip it; the only
   mail server this instance knows is the local sink. */
const mail = (tag) => `y1.${tag}.${stamp}@mailbox-teamlink-tests.in`;
const STAFF_PW = process.env.TL_STAFF_PASSWORD || process.env.DEV_PASSWORD || 'TeamLink@2026';

const browser = await chromium.launch();
const pageErrors = [];

async function open(ctx, hash) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(String(e.message)));
  await page.goto(BASE + hash);
  await page.waitForFunction(() => window.TL && TL.ready === true, null, { timeout: 30000 });
  await page.waitForTimeout(500);
  return page;
}
const reveal = (p, id) => p.evaluate((i) => window.TLRegistration.reveal(i), id);
async function fill(p, id, v) { await reveal(p, id); await p.fill('#' + id, v); }
async function pick(p, id, v) { await reveal(p, id); await p.selectOption('#' + id, v); }
async function tick(p, sel) {
  await p.evaluate((s) => { const el = document.querySelector(s); if (el) window.TLRegistration.reveal(el.id || el.closest('[id]').id); }, sel);
  const on = await p.isChecked(sel);
  if (!on) await p.click(sel, { force: true });
}
/* Field messages are painted a moment after the field loses focus. */
const errText = async (p, id) => { await p.waitForTimeout(250); return p.evaluate((i) => {
  const e = document.getElementById(i + 'Err');
  return e && e.classList.contains('show') ? e.textContent.trim() : '';
}, id); };
/* What other features put on screen after a registration with a resume:
   the profile wizard, "your resume says something different", the resume
   score card. Each is answered the way a candidate in a hurry would. */
const dismiss = async (p) => {
  for (let i = 0; i < 4; i++) {
    const n = await p.evaluate(() => {
      let hit = 0;
      document.querySelectorAll('.tlpo-ov .tlpo-btn.ghost, .tlpo-ov .tlpo-skip').forEach((b) => { b.click(); hit++; });
      if (document.querySelector('.fcr-jd-head') && typeof window.fcrCloseModal === 'function') { window.fcrCloseModal(); hit++; }
      if (typeof window.tlrsLater === 'function' && /Your resume scored/.test(document.body.innerText)) { try { window.tlrsLater(); hit++; } catch (e) {} }
      return hit;
    });
    if (!n) return;
    await p.waitForTimeout(500);
  }
};
const step = (p) => p.evaluate(() => window.TLRegistration.step());
const cont = async (p) => { await p.click('#tlrNext'); await p.waitForTimeout(350); };

/* An account that exists already, for the duplicate checks. */
const existing = { email: mail('existing'), phone: phone() };
{
  const c = await browser.newContext();
  const p = await open(c, '#/');
  const r = await p.evaluate((b) => TL.api.post('/auth/register', b).then(() => 'ok', (e) => e.message), {
    name: 'Y1 Existing', email: existing.email, password: 'Existing' + stamp + '9', phone: existing.phone,
    preferredLocation: 'Hyderabad', expectedCtc: 4, noticePeriod: 'Immediate', preferredWorkModes: ['Office'],
    consent: { terms: true, communication: true, resumeProcessing: true },
  });
  must(r === 'ok', 'could not create the existing account: ' + r);
  await c.close();
}

console.log(`\nregistration, desktop  (${BASE})`);
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const p = await open(ctx, '#/');
const newEmail = mail('new');
const newPhone = phone();
const PASSWORD = 'Meera' + stamp + '#7';
let code = '', candidateId = '';

await check('Register button opens the registration form, in 7 steps with progress', async () => {
  await p.click('header a[href="#/register/candidate"], a.btn-primary[href="#/register/candidate"]');
  await p.waitForTimeout(800);
  must(/^#\/register\/candidate/.test(await p.evaluate(() => location.hash)), 'not on the registration page');
  const s = await p.evaluate(() => ({
    steps: document.querySelectorAll('#registerForm .tlr-step').length,
    visible: [...document.querySelectorAll('#registerForm .tlr-step')].filter((x) => !x.hidden).length,
    dots: [...document.querySelectorAll('.tlr-stepper .tlr-dot-t')].map((x) => x.textContent),
    bar: document.querySelector('[role="progressbar"]') && document.querySelector('[role="progressbar"]').getAttribute('aria-valuetext'),
    resumeFirst: !!document.querySelector('#tlrStep1 .ai-panel'),
  }));
  must(s.steps === 7 && s.visible === 1, JSON.stringify(s));
  must(s.dots.join(',') === 'Basic,Education,Experience,Preferences,Resume,Account,Review', s.dots.join(','));
  must(/Step 1 of 7/.test(s.bar || ''), 'progressbar: ' + s.bar);
  must(s.resumeFirst, 'the resume upload is not first');
});

await check('required fields: Continue refuses, says why in the owner\'s words, focuses the first, announces it', async () => {
  await cont(p);
  must(await step(p) === 1, 'moved on with an empty step');
  const s = await p.evaluate(() => ({
    summary: (document.getElementById('tlrSummary1') || {}).textContent || '',
    role: (document.getElementById('tlrSummary1') || {}).getAttribute('role'),
    focus: document.activeElement && document.activeElement.id,
    invalid: document.getElementById('regName').getAttribute('aria-invalid'),
  }));
  must(/Please enter your full name\./.test(s.summary), s.summary);
  must(s.role === 'alert', 'the summary is not announced');
  must(s.focus === 'regName', 'focus is on ' + s.focus);
  must(s.invalid === 'true', 'aria-invalid not set');
  must(await errText(p, 'regName') === 'Please enter your full name.', 'inline message');
});

await check('email and mobile format messages', async () => {
  await fill(p, 'regName', 'Meera Lakshmi Rao');
  await fill(p, 'regEmail', 'meera@');
  await p.press('#regEmail', 'Tab');
  must(await errText(p, 'regEmail') === 'Please enter a valid email address.', await errText(p, 'regEmail'));
  await fill(p, 'regMobile', '12345');
  await p.press('#regMobile', 'Tab');
  must(await errText(p, 'regMobile') === 'Please enter a valid 10-digit mobile number.', await errText(p, 'regMobile'));
  const split = await p.evaluate(() => [regFirstName.value, regMiddleName.value, regLastName.value].join('|'));
  must(split === 'Meera|Lakshmi|Rao', 'first/middle/last: ' + split);
});

await check('duplicate email and duplicate mobile are said inline, under the field', async () => {
  /* The answer comes from the server (POST /auth/register/check), so it is
     waited for - up to 8 s on a busy machine - rather than given 900 ms. */
  const errSoon = async (id, want) => {
    for (let i = 0; i < 32; i++) { if (await errText(p, id) === want) return want; }
    return errText(p, id);
  };
  await fill(p, 'regEmail', existing.email);
  await p.press('#regEmail', 'Tab');
  const em = await errSoon('regEmail', 'An account with this email already exists. Please Login.');
  must(em === 'An account with this email already exists. Please Login.', 'email: ' + em);
  await fill(p, 'regMobile', existing.phone);
  await p.press('#regMobile', 'Tab');
  const mo = await errSoon('regMobile', 'An account with this mobile number already exists.');
  must(mo === 'An account with this mobile number already exists.', 'mobile: ' + mo);
});

await check('Continue moves on once step 1 is right; Back keeps everything', async () => {
  await fill(p, 'regEmail', newEmail);
  await fill(p, 'regMobile', newPhone);
  await fill(p, 'regLocation', 'Hyderabad');
  await fill(p, 'regCity', 'Hyderabad');
  await fill(p, 'regState', 'Telangana');
  await fill(p, 'regDob', '1997-06-15');
  await pick(p, 'regGender', 'Female');
  await tick(p, '#regWaSame');
  await cont(p);
  must(await step(p) === 2, 'still on step ' + await step(p));
  const f = await p.evaluate(() => ({ focus: document.activeElement && document.activeElement.id,
    live: (document.getElementById('tlrLive') || {}).textContent }));
  must(f.focus === 'tlrStepH2', 'focus after Continue: ' + f.focus);
  await p.waitForTimeout(100);
  await p.click('#tlrBack');
  await p.waitForTimeout(300);
  const kept = await p.evaluate(() => [regName.value, regEmail.value, regLocation.value, regWhatsapp.value.replace(/\D/g, '').slice(-10)]);
  must(kept[0] === 'Meera Lakshmi Rao' && kept[1] === newEmail && kept[2] === 'Hyderabad', JSON.stringify(kept));
  must(kept[3] === newPhone, 'WhatsApp "same as mobile": ' + kept[3]);
  await cont(p);
});

await check('education: required branch, score range, then on', async () => {
  await pick(p, 'regQualification', 'B.Tech');
  await fill(p, 'regDegree', 'B.Tech in Computer Science');
  await fill(p, 'regCollege', 'JNTU Hyderabad');
  await pick(p, 'regGradYear', '2019');
  await fill(p, 'regCgpa', '8.1');
  await fill(p, 'regPct10', '105');
  await cont(p);
  must(await step(p) === 2, 'moved on without a branch');
  must(await errText(p, 'regSpecialization') === 'Please enter your specialization / branch.', await errText(p, 'regSpecialization'));
  must(await errText(p, 'regPct10') === 'Please enter a percentage between 0 and 100.', await errText(p, 'regPct10'));
  await fill(p, 'regSpecialization', 'Computer Science');
  await fill(p, 'regPct10', '88');
  await fill(p, 'regPct12', '84');
  await cont(p);
  must(await step(p) === 3, 'on ' + await step(p));
});

await check('a refresh keeps the draft (this device), never the password', async () => {
  await p.reload();
  await p.waitForFunction(() => window.TL && TL.ready === true, null, { timeout: 30000 });
  await p.waitForTimeout(900);
  const s = await p.evaluate(() => ({ step: window.TLRegistration.step(), name: regName.value, spec: regSpecialization.value,
    note: (document.getElementById('tlrRestored') || {}).textContent || '' }));
  must(s.name === 'Meera Lakshmi Rao' && s.spec === 'Computer Science', JSON.stringify(s));
  must(s.step === 3, 'restored on step ' + s.step);
  must(/Passwords are never saved/.test(s.note), 'no restore notice: ' + s.note);
});

await check('experience: total experience and skills as tags', async () => {
  await cont(p);
  must(await errText(p, 'regExpBand') === 'Please select your total experience.', await errText(p, 'regExpBand'));
  must(await errText(p, 'regSkills') === 'Please add at least one key skill.', await errText(p, 'regSkills'));
  await pick(p, 'regExpBand', '3-5');
  await fill(p, 'regDesignation', 'Software Engineer');
  await fill(p, 'regCompany', 'Northwind Systems');
  await fill(p, 'regSkills', 'Java, SQL');
  await p.press('#regSkills', 'Enter');
  await p.type('#regSkills', 'Spring Boot');
  await p.press('#regSkills', 'Enter');
  const chips = await p.evaluate(() => [...document.querySelectorAll('#regSkillsChips .tlr-chip')].map((c) => c.firstChild.textContent));
  must(chips.join('|') === 'Java|SQL|Spring Boot', chips.join('|'));
  must(await step(p) === 3, 'Enter in the skills box left the step');
  await p.click('#regSkillsChips button[data-chip-value="SQL"]');
  must((await p.inputValue('#regSkills')).indexOf('SQL') < 0, 'chip remove did not remove');
  await fill(p, 'regSkills', 'Java, SQL, Spring Boot');
  const type = await p.evaluate(() => (document.querySelector('input[name="regCandidateType"]:checked') || {}).value);
  must(type === 'experienced', 'candidate type ' + type);
  await cont(p);
  must(await step(p) === 4, 'on ' + await step(p));
});

await check('preferences: role, several locations, employment type, the four required', async () => {
  await cont(p);
  must(await errText(p, 'regPrefRole') === 'Please enter your preferred job role.', await errText(p, 'regPrefRole'));
  await fill(p, 'regPrefRole', 'Java Developer');
  await p.click('[data-pick-loc="Hyderabad"]');
  await p.click('[data-pick-loc="Bengaluru"]');
  must(await p.inputValue('#regPrefLocation') === 'Hyderabad, Bengaluru', await p.inputValue('#regPrefLocation'));
  await tick(p, 'input[name="regEmpType"][value="Full Time"]');
  await tick(p, '#regWorkModeGroup input[value="Hybrid"]');
  await fill(p, 'regExpSalary', '9.5');
  await fill(p, 'regCurSalary', '7');
  await pick(p, 'regNotice', '45 days');
  await p.click('input[name="regRelocate"][value="yes"]', { force: true });
  await tick(p, 'input[name="regComm"][value="whatsapp"]');
  await cont(p);
  must(await step(p) === 5, 'on ' + await step(p));
});

await check('resume: required, type checked, file shown with Replace / Remove / Download', async () => {
  await cont(p);
  must(await errText(p, 'regResume') === 'Please upload your resume.', await errText(p, 'regResume'));
  await p.evaluate(() => window.triggerRegisterResumeUpload());
  await p.setInputFiles('#regResumeFileInput', TXT);
  await p.waitForTimeout(400);
  must(await errText(p, 'regResume') === 'Please upload your resume as a PDF, DOC or DOCX file.', 'txt: ' + await errText(p, 'regResume'));
});

await check('parsing fills what is empty and never overwrites what was typed (AI found… instead)', async () => {
  await p.evaluate(() => window.triggerRegisterResumeUpload());
  await p.setInputFiles('#regResumeFileInput', PDF);
  await p.waitForFunction(() => /analyzed successfully|could not|couldn/i.test((document.getElementById('regResumeStatus') || {}).textContent || ''), null, { timeout: 30000 });
  await p.waitForTimeout(800);
  const s = await p.evaluate(() => ({
    status: document.getElementById('regResumeStatus').textContent,
    name: regName.value, nameTag: (document.getElementById('regNameAiTag') || {}).textContent || '',
    email: regEmail.value, linkedin: regLinkedin.value,
    card: document.getElementById('tlrResumeCard').textContent,
    acts: [...document.querySelectorAll('#tlrResumeCard [data-resume]')].map((b) => b.textContent).join(','),
  }));
  must(/analyzed successfully/i.test(s.status), s.status);
  must(s.name === 'Meera Lakshmi Rao', 'the typed name was overwritten: ' + s.name);
  must(/AI found/.test(s.nameTag), 'no "AI found" suggestion: ' + s.nameTag);
  must(s.email === newEmail, 'the typed email was overwritten');
  must(/linkedin\.com\/in\/sravanthi/.test(s.linkedin), 'an empty field was not filled: ' + s.linkedin);
  must(/Resume - Sravanthi\.pdf/.test(s.card) && /✓/.test(s.card), s.card);
  must(s.acts === 'Replace,Download,Remove', s.acts);
});

await check('optional documents are queued for the profile', async () => {
  await p.setInputFiles('[data-doc-input="certificate"]', { name: 'AWS_Certificate.pdf', mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\n% certificate\ntrailer<<>>\n%%EOF\n') });
  await p.setInputFiles('[data-doc-input="marksheet"]', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  const s = await p.evaluate(() => ({
    cert: document.getElementById('tlrDocs_certificate').textContent,
    err: document.getElementById('tlrDocErr_marksheet').textContent,
  }));
  must(/AWS_Certificate\.pdf/.test(s.cert), s.cert);
  must(/please upload PDF, JPG, PNG/.test(s.err), 'marksheet type: ' + s.err);
  await cont(p);
  must(await step(p) === 6, 'on ' + await step(p));
});

await check('password: strength, the server\'s rule, confirm must match, show / hide', async () => {
  must(await p.evaluate(() => document.getElementById('tlrAcctEmail').textContent) === newEmail, 'sign-in email not shown');
  await fill(p, 'regPassword', 'abc');
  await p.press('#regPassword', 'Tab');
  must(await errText(p, 'regPassword') === 'Password must be at least 8 characters.', await errText(p, 'regPassword'));
  must(/Weak/.test(await p.textContent('#tlrStrengthText')), await p.textContent('#tlrStrengthText'));
  await fill(p, 'regPassword', PASSWORD);
  must(/Strong|Good/.test(await p.textContent('#tlrStrengthText')), await p.textContent('#tlrStrengthText'));
  await fill(p, 'regConfirmPassword', PASSWORD + 'x');
  await p.press('#regConfirmPassword', 'Tab');
  must(await errText(p, 'regConfirmPassword') === 'Passwords do not match.', await errText(p, 'regConfirmPassword'));
  await fill(p, 'regConfirmPassword', PASSWORD);
  await p.click('[data-eye="regPassword"]');
  must(await p.getAttribute('#regPassword', 'type') === 'text', 'show did not show');
  await p.click('[data-eye="regPassword"]');
  must(await p.getAttribute('#regPassword', 'type') === 'password', 'hide did not hide');
  await p.waitForTimeout(500);
  const draft = await p.evaluate(() => localStorage.getItem(window.TLRegistration.draftKey) || '');
  must(draft.length > 50, 'no draft saved');
  must(!draft.includes(PASSWORD) && !draft.includes('abc"'), 'the password is in the draft');
  await cont(p);
  must(await step(p) === 7, 'on ' + await step(p));
});

await check('review shows the answers; consent required (owner\'s words); Create Account disabled until then', async () => {
  const s = await p.evaluate(() => ({
    review: document.getElementById('tlrReview').textContent,
    disabled: document.getElementById('regSubmitBtn').disabled,
    missing: (document.getElementById('tlrMissing') || {}).textContent || '',
    comms: document.querySelector('label[for], .consent-row') && [...document.querySelectorAll('.consent-row span')].map((x) => x.textContent).join(' | '),
  }));
  must(/Meera Lakshmi Rao/.test(s.review) && /Java Developer/.test(s.review) && /Hyderabad, Bengaluru/.test(s.review), 'review: ' + s.review.slice(0, 200));
  must(s.disabled, 'Create Account enabled without consent');
  must(/Communication consent/.test(s.missing), 'missing list: ' + s.missing);
  must(s.comms.includes('I agree to receive job opportunities and recruitment communication from TeamLink Consultancy.'), s.comms);
  must(s.comms.includes('I agree to the Terms & Conditions and Privacy Policy.'), s.comms);
  await tick(p, '#regConsentComms');
  await tick(p, '#regConsentTerms');
  await tick(p, '#regConsentResume');
  must(!(await p.evaluate(() => document.getElementById('regSubmitBtn').disabled)), 'still disabled: '
    + await p.evaluate(() => JSON.stringify(window.TLRegistration.problems())));
});

await check('Create Account: Registration Successful, Welcome to TeamLink!, Candidate ID, two buttons', async () => {
  await p.click('#regSubmitBtn');
  await p.waitForFunction(() => STATE.session && STATE.session.role === 'candidate', null, { timeout: 20000 });
  await p.waitForSelector('#tlrOk .tlr-ok-card', { timeout: 20000 });
  await p.waitForTimeout(1500);
  const s = await p.evaluate(() => ({
    text: document.querySelector('#tlrOk').innerText,
    code: document.getElementById('tlrOkCode').textContent,
    role: document.querySelector('#tlrOk [role="dialog"]') && document.querySelector('#tlrOk [role="dialog"]').getAttribute('aria-modal'),
    focus: document.activeElement && document.activeElement.id,
    buttons: [...document.querySelectorAll('#tlrOk .tlr-ok-acts button')].map((b) => b.textContent),
    docs: document.getElementById('tlrOkDocs').textContent,
  }));
  if (SHOTS) await p.screenshot({ path: join(SHOTS, 'success-desktop.png') });
  must(/Registration Successful/.test(s.text) && /Welcome to TeamLink!/.test(s.text), s.text);
  must(/Your profile has been created successfully\./.test(s.text), s.text);
  must(/^TL-CAN-\d{6}$/.test(s.code), 'Candidate ID: ' + s.code);
  must(s.buttons.join(',') === 'Complete Profile,Search Jobs', s.buttons.join(','));
  must(s.role === 'true' && s.focus === 'tlrOkH', `dialog ${s.role}, focus ${s.focus}`);
  code = s.code;
  candidateId = await p.evaluate(() => STATE.session.id);
});

await check('the profile was created with every step\'s answers; documents saved; draft gone', async () => {
  await p.waitForTimeout(2500);
  const me = await p.evaluate(() => TL.api.get('/auth/me').then((r) => r.profile));
  must(me.candidateCode === code, 'Candidate ID on the profile: ' + me.candidateCode);
  const want = { firstName: 'Meera', middleName: 'Lakshmi', lastName: 'Rao', city: 'Hyderabad', state: 'Telangana',
    preferredRole: 'Java Developer', preferredLocation: 'Hyderabad, Bengaluru', noticePeriod: '45 days',
    candidateType: 'experienced', currentCompany: 'Northwind Systems', gender: 'Female' };
  for (const [k, v] of Object.entries(want)) must(me[k] === v, `${k}: ${JSON.stringify(me[k])}`);
  must(me.skills.includes('Spring Boot'), 'skills ' + me.skills);
  must(me.preferredEmploymentTypes.includes('Full Time'), 'employment types');
  must(me.whatsappOptIn === true && me.smsOptIn === false, 'channels');
  must(me.willingToRelocate === true, 'relocate');
  must(Number(me.expectedCtc) === 9.5, 'expected ' + me.expectedCtc);
  must(/Computer Science/.test(me.education), 'education ' + me.education);
  must(/Resume - Sravanthi/.test(me.resumeFile), 'resume ' + me.resumeFile);
  must(String(me.dateOfBirth || '').startsWith('1997-06'), 'dob ' + me.dateOfBirth);
  const docs = await p.evaluate((id) => TL.api.get('/candidates/' + id + '/documents').then((r) => r.documents), candidateId);
  must(docs.some((d) => d.kind === 'certificate' && d.fileName === 'AWS_Certificate.pdf'), JSON.stringify(docs));
  const docsLine = await p.evaluate(() => (document.getElementById('tlrOkDocs') || {}).textContent || '');
  must(/1 file saved/.test(docsLine), 'success screen documents line: ' + docsLine);
  must(await p.evaluate(() => localStorage.getItem(window.TLRegistration.draftKey)) === null, 'the draft is still there');
});

await check('consent stored: date, version (configured) and status', async () => {
  const pr = await p.evaluate(() => TL.api.get('/me/privacy'));
  must(pr.consents.length === 3, JSON.stringify(pr.consents));
  must(pr.consents.every((c) => c.status === 'granted' && c.version === pr.consentVersion && c.at), JSON.stringify(pr.consents));
  must(pr.consentVersion === (process.env.TL_CONSENT_VERSION || pr.consentVersion), 'version ' + pr.consentVersion);
});

await check('welcome email with the Candidate ID reached the (local) mail server', async () => {
  if (!SINK) throw new Error('set TL_SINK_LOG to the SMTP sink log to check this');
  let found = false;
  for (let i = 0; i < 20 && !found; i++) {
    const log = existsSync(SINK) ? readFileSync(SINK, 'utf8') : '';
    found = log.includes(code) && log.includes(newEmail) && /Welcome to TeamLink/.test(log);
    if (!found) await p.waitForTimeout(500);
  }
  must(found, 'no welcome email with ' + code);
});

await check('profile: Candidate ID shown, documents upload / replace / download / delete', async () => {
  await p.click('#tlrOk [data-tlr-ok="profile"]');
  await p.waitForTimeout(1500);
  await dismiss(p);
  await p.waitForSelector('#tlrDocsBody .tlr-plist', { timeout: 10000 });
  const cid = await p.evaluate(() => (document.querySelector('.cap-phead .tlr-cid') || {}).textContent || '');
  must(cid.includes(code), 'profile Candidate ID: ' + cid);
  let list = await p.textContent('#tlrDocsBody');
  must(/AWS_Certificate\.pdf/.test(list) && /Resume - Sravanthi/.test(list), list.slice(0, 200));

  await p.selectOption('#tlrPdocKind', 'experience_letter');
  if (SHOTS) await p.screenshot({ path: join(SHOTS, 'profile-before-add.png') });
  const [fc] = await Promise.all([p.waitForEvent('filechooser'), p.click('[data-pdoc-add]')]);
  await fc.setFiles({ name: 'Relieving_Letter.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n% letter one\n%%EOF\n') });
  await p.waitForFunction(() => [...document.querySelectorAll('#tlrDocsBody li')].some((x) => /Relieving_Letter\.pdf/.test(x.textContent)), null, { timeout: 10000 });

  const id = await p.evaluate(() => {
    const li = [...document.querySelectorAll('#tlrDocsBody li')].find((x) => /Relieving_Letter/.test(x.textContent));
    return li.querySelector('[data-pdoc-replace]').getAttribute('data-pdoc-replace');
  });
  const [fc2] = await Promise.all([p.waitForEvent('filechooser'), p.click(`[data-pdoc-replace="${id}"]`)]);
  await fc2.setFiles({ name: 'Relieving_Letter_v2.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n% letter two\n%%EOF\n') });
  await p.waitForFunction(() => [...document.querySelectorAll('#tlrDocsBody li')].some((x) => /Relieving_Letter_v2\.pdf/.test(x.textContent)), null, { timeout: 10000 });

  const href = await p.getAttribute(`#tlrDocsBody a[href*="/documents/${id}/download"]`, 'href');
  const dl = await p.evaluate((h) => fetch(h, { credentials: 'same-origin' }).then(async (r) => ({ s: r.status, t: await r.text(), d: r.headers.get('content-disposition') })), href);
  must(dl.s === 200 && /letter two/.test(dl.t) && /attachment/.test(dl.d), JSON.stringify(dl).slice(0, 200));

  await p.click(`[data-pdoc-delete="${id}"]`);
  await p.click(`[data-pdoc-delete="${id}"][data-confirmed]`);
  await p.waitForFunction(() => ![...document.querySelectorAll('#tlrDocsBody li')].some((x) => /Relieving_Letter_v2/.test(x.textContent)), null, { timeout: 10000 });
  if (SHOTS) await p.screenshot({ path: join(SHOTS, 'profile-documents.png'), fullPage: true });
});

await check('a document upload without the CSRF token is refused', async () => {
  const st = await p.evaluate((cid) => {
    const fd = new FormData(); fd.append('kind', 'certificate');
    fd.append('document', new Blob(['%PDF-1.4\n%%EOF\n']), 'x.pdf');
    return fetch('/api/candidates/' + cid + '/documents', { method: 'POST', body: fd, credentials: 'same-origin' }).then((r) => r.status);
  }, candidateId);
  must(st === 403, 'status ' + st);
});

await check('Download My Data gives my own data as JSON', async () => {
  const href = await p.getAttribute('#tlrPrivBody a[href$="/me/data-export"]', 'href');
  const data = await p.evaluate((h) => fetch(h, { credentials: 'same-origin' }).then((r) => r.json()), href);
  must(data.profile.candidate_code === code && data.profile.email === newEmail, JSON.stringify(data.profile).slice(0, 120));
  must(!JSON.stringify(data).includes(existing.email), 'another person in the export');
  must(Array.isArray(data.notIncluded) && data.consents.length === 3, 'shape');
});

await check('Request Account Deletion is recorded and nothing is deleted', async () => {
  await p.click('[data-pdel="open"]');
  await p.fill('#tlrDelReason', 'Testing the request');
  await p.click('[data-pdel="send"]');
  await p.waitForFunction(() => /waiting for review/.test(document.getElementById('tlrPrivBody').textContent), null, { timeout: 10000 });
  const me = await p.evaluate(() => TL.api.get('/auth/me').then((r) => !!r.profile));
  must(me, 'the profile is gone');
});
await ctx.close();

await check('admin sees the deletion request (and processes it)', async () => {
  const c = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const q = await open(c, '#/');
  await q.evaluate((pw) => TL.api.post('/auth/login', { email: 'admin@teamlink.com', password: pw, role: 'admin' }), STAFF_PW);
  await q.evaluate(() => TL.refresh());
  await q.evaluate(() => { location.hash = '#/admin/privacy-requests'; });
  await q.waitForFunction((cd) => (document.getElementById('tlrAdminDel') || {}).textContent && document.getElementById('tlrAdminDel').textContent.includes(cd), code, { timeout: 15000 });
  const nav = await q.evaluate(() => [...document.querySelectorAll('.sidebar a, .sidebar button')].some((x) => /Privacy Requests/.test(x.textContent)));
  must(nav, 'no Privacy Requests item in the admin sidebar');
  const rid = await q.evaluate((cd) => {
    const tr = [...document.querySelectorAll('#tlrAdminDel tr')].find((x) => x.textContent.includes(cd));
    return tr.querySelector('[data-adel="in_review"]').getAttribute('data-id');
  }, code);
  await q.click(`[data-adel="in_review"][data-id="${rid}"]`);
  await q.waitForFunction((cd) => [...document.querySelectorAll('#tlrAdminDel tr')].some((x) => x.textContent.includes(cd) && /in review/.test(x.textContent)), code, { timeout: 10000 });
  if (SHOTS) await q.screenshot({ path: join(SHOTS, 'admin-privacy.png') });
  await c.close();
});

await check('recruiters see the Candidate ID beside the internal id', async () => {
  const c = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const q = await open(c, '#/');
  await q.evaluate((pw) => TL.api.post('/auth/login', { email: 'recruiter@teamlink.com', password: pw, role: 'recruiter' }), STAFF_PW);
  await q.evaluate(() => TL.refresh());
  await q.waitForTimeout(800);
  await q.evaluate((id) => { location.hash = '#/recruiter/candidate-profile?id=' + id; }, candidateId);
  await q.waitForSelector('.tlr-cid', { timeout: 15000 });
  const t = await q.textContent('.tlr-cid');
  must(t.includes(code) && t.includes(candidateId), t);
  await c.close();
});

/* ------------------------------------------------------------------ */
console.log('\nregistration, phone width 390px, keyboard');
const m = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const mp = await open(m, '#/register/candidate');
const XSS = 'Ravi <img src=x onerror="window.__xss=1"> Kumar';
const overflow = () => mp.evaluate(() => document.documentElement.scrollWidth);

await check('every step fits 390px with no horizontal scroll; Enter continues', async () => {
  must(await overflow() <= 390, 'step 1 width ' + await overflow());
  if (SHOTS) await mp.screenshot({ path: join(SHOTS, 'm-step1.png') });
  await mp.focus('#regName');
  await mp.keyboard.press('Enter');
  await mp.waitForTimeout(300);
  must(await step(mp) === 1 && await mp.evaluate(() => document.activeElement.id) === 'regName', 'Enter on an empty step');
  await mp.fill('#regName', XSS);
  await mp.fill('#regMobile', phone());
  await mp.fill('#regEmail', mail('phone'));
  await mp.fill('#regLocation', 'Nellore');
  await mp.focus('#regLocation');
  await mp.keyboard.press('Enter');
  await mp.waitForTimeout(400);
  must(await step(mp) === 2, 'Enter did not continue');
  await mp.selectOption('#regQualification', 'Diploma');
  await mp.fill('#regSpecialization', 'Electrical');
  must(await overflow() <= 390, 'step 2 width');
  await cont(mp);
  await mp.selectOption('#regExpBand', 'fresher');
  await mp.fill('#regSkills', 'Wiring, AutoCAD');
  must(await overflow() <= 390, 'step 3 width');
  if (SHOTS) await mp.screenshot({ path: join(SHOTS, 'm-step3.png') });
  await cont(mp);
  await mp.fill('#regPrefRole', 'Electrician');
  await mp.click('[data-pick-loc="Any Location"]');
  await mp.click('#regWorkModeGroup input[value="Office"]', { force: true });
  await mp.fill('#regExpSalary', '2.5');
  await mp.selectOption('#regNotice', 'Immediate');
  must(await overflow() <= 390, 'step 4 width');
  if (SHOTS) await mp.screenshot({ path: join(SHOTS, 'm-step4.png') });
  await cont(mp);
  await mp.evaluate(() => window.triggerRegisterResumeUpload());
  await mp.setInputFiles('#regResumeFileInput', join(RESUMES, 'Resume - Sravanthi.docx'));
  await mp.waitForFunction(() => /analyzed|could|couldn/i.test((document.getElementById('regResumeStatus') || {}).textContent || ''), null, { timeout: 30000 });
  must(await overflow() <= 390, 'step 5 width');
  if (SHOTS) await mp.screenshot({ path: join(SHOTS, 'm-step5.png') });
  await cont(mp);
  await mp.fill('#regPassword', 'Phone' + stamp + '42');
  await mp.fill('#regConfirmPassword', 'Phone' + stamp + '42');
  must(await overflow() <= 390, 'step 6 width');
  await cont(mp);
  must(await step(mp) === 7, 'not on review: ' + await step(mp) + ' ' + JSON.stringify(await mp.evaluate(() => window.TLRegistration.problems())));
  must(await overflow() <= 390, 'step 7 width');
});

await check('a name with markup is shown as text, never run', async () => {
  const s = await mp.evaluate(() => ({ xss: window.__xss, img: !!document.querySelector('#tlrReview img'),
    text: document.getElementById('tlrReview').textContent }));
  must(!s.xss && !s.img && s.text.includes('<img'), JSON.stringify(s).slice(0, 160));
});

await check('every visible field on every step has a label', async () => {
  const missing = await mp.evaluate(() => {
    const out = [];
    for (let n = 1; n <= 7; n++) {
      window.TLRegistration.go(n);
      document.querySelectorAll('#tlrStep' + n + ' input, #tlrStep' + n + ' select, #tlrStep' + n + ' textarea').forEach((el) => {
        if (el.type === 'hidden' || el.offsetParent === null || el.classList.contains('tlr-hidden-input')) return;
        const named = (el.id && document.querySelector('label[for="' + el.id + '"]')) || el.closest('label')
          || el.getAttribute('aria-label') || el.getAttribute('aria-labelledby');
        if (!named) out.push(el.id || el.name);
      });
    }
    window.TLRegistration.go(7);
    return out;
  });
  must(!missing.length, 'unlabelled: ' + missing.join(', '));
});

await check('phone: create the account, success screen fits, Candidate ID shown', async () => {
  await tick(mp, '#regConsentComms');
  await tick(mp, '#regConsentTerms');
  await tick(mp, '#regConsentResume');
  if (SHOTS) await mp.screenshot({ path: join(SHOTS, 'm-step7.png') });
  await mp.click('#regSubmitBtn');
  await mp.waitForSelector('#tlrOk .tlr-ok-card', { timeout: 25000 });
  await mp.waitForTimeout(800);
  if (SHOTS) await mp.screenshot({ path: join(SHOTS, 'm-success.png') });
  const s = await mp.evaluate(() => ({ code: document.getElementById('tlrOkCode').textContent, w: document.documentElement.scrollWidth,
    card: document.querySelector('#tlrOk .tlr-ok-card').getBoundingClientRect().width }));
  must(/^TL-CAN-\d{6}$/.test(s.code) && s.code !== code, 'code ' + s.code);
  must(s.w <= 390 && s.card <= 390, JSON.stringify(s));
  await mp.keyboard.press('Escape');
  must(!(await mp.$('#tlrOk')), 'Escape did not close the dialog');
});
await m.close();

await browser.close();
const errs = pageErrors.filter((e) => !/ResizeObserver/.test(e));
if (errs.length) { console.log('\npage errors:\n  ' + errs.slice(0, 5).join('\n  ')); failed += 1; }
console.log(failed ? `\n${failed} check(s) failed, ${passed} passed` : `\nall ${passed} checks passed`);
process.exit(failed ? 1 : 0);
