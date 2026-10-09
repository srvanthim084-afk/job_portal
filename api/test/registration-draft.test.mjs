/**
 * Resume-first registration (0117), end to end against a real Postgres
 * with RLS on:
 *
 *   - uploading a resume stores the file and creates a draft at once, and
 *     the draft is read immediately; the candidate then types only the
 *     location, preferences, salary and password
 *   - every education record kept, none overwritten
 *   - per-field confidence; a low-confidence value is listed for
 *     verification and NOT written to the profile unless confirmed
 *   - the MOBILE number answers a 6-digit OTP before the account exists (0123); the server
 *     refuses an account whose number was not verified, or changed after verifying
 *   - the notice period is mandatory and, from the resume registration, one of the offered options
 *   - a resume without an email: the address is typed and used
 *   - an existing email / mobile: no second account
 *   - an unreadable resume or a reading that times out: the resume is
 *     kept, the reason is given, a retry works
 *   - the AI failing: the parser's reading still stands
 *   - completeness: below 100% while a field is missing, and rising when
 *     it is filled; only missing fields are listed
 *   - an existing candidate and the plain /auth/register are unchanged
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb, applyTestEnv, makeClient, startMockProvider } from './harness.mjs';

const DB_PORT = 5481;
const API_PORT = 9981;
const MOCK_PORT = 9881;

let dbh, server, mock, base, raw;
let seq = 0;
const uniq = () => `${Date.now().toString(36)}${++seq}`;
const mobile = () => '9' + String(100000000 + Math.floor(Math.random() * 899999999));
const CONSENT = { terms: true, communication: true, resumeProcessing: true };

function resumeText({ name = 'Rahul Kumar', email, phone, extra = '' } = {}) {
  return [
    name.toUpperCase(),
    'Senior Software Engineer',
    [email ? `Email: ${email}` : '', phone ? `Phone: +91 ${phone}` : ''].filter(Boolean).join(' | '),
    'LinkedIn: https://www.linkedin.com/in/rahul-kumar-dev',
    'Hyderabad, Telangana',
    '',
    'PROFESSIONAL SUMMARY',
    'Backend engineer with 5 years of experience building Java and Spring Boot services.',
    '',
    'TECHNICAL SKILLS',
    'Java, Spring Boot, SQL, Hibernate, Microservices, REST APIs, MySQL, Git, Docker, AWS',
    '',
    'WORK EXPERIENCE',
    'ABC Technologies Pvt Ltd - Senior Software Engineer (Jun 2022 - Present)',
    'Built payment microservices in Java and Spring Boot.',
    'XYZ Solutions - Software Engineer (Jul 2020 - May 2022)',
    'Developed REST APIs and SQL reporting.',
    'Infotech Systems - Associate Software Engineer (Jun 2019 - Jun 2020)',
    'Maintained Java batch jobs.',
    '',
    'EDUCATION',
    'B.Tech (Computer Science), JNTU Hyderabad, 2019, 74%',
    'Intermediate (MPC), Sri Chaitanya Junior College, 2015, 92%',
    'SSC, ZP High School, 2013, 9.2 CGPA',
    '',
    'PROJECTS',
    'Payment Gateway Integration - Spring Boot service handling UPI payments',
    'Inventory Reporting Dashboard - SQL and Java reporting for retail stores',
    '',
    'CERTIFICATIONS',
    'Oracle Certified Professional Java SE 11 Developer',
    'AWS Certified Cloud Practitioner',
    '',
    'LANGUAGES',
    'English, Telugu, Hindi',
    extra,
  ].join('\n');
}

const fileForm = (buf, name) => {
  const fd = new FormData();
  fd.append('resume', new Blob([buf]), name);
  return fd;
};

async function client() {
  const c = makeClient(base);
  await c.get('/api/health');
  return c;
}

async function upload(c, text, name = 'resume.txt') {
  const r = await c.post('/api/registration/drafts', fileForm(Buffer.from(text, 'utf8'), name));
  c.draft = r.body;
  c.h = { headers: { 'x-draft-token': r.body && r.body.draftToken } };
  return r;
}

const codeFor = (addr) => {
  const mails = mock.received.filter((m) => m.url === '/email' && JSON.stringify(m.body || '').includes(addr));
  const last = mails[mails.length - 1];
  const m = last && /\b(\d{6})\b/.exec(JSON.stringify(last.body));
  return m ? m[1] : null;
};

/** Send the OTP and verify it. With no SMS gateway on a development server the code comes back as devCode. */
async function verifyPhone(c, phone) {
  const s1 = await c.post(`/api/registration/drafts/${c.draft.draftId}/phone-otp`, { phone }, c.h);
  assert.equal(s1.status, 200, JSON.stringify(s1.body));
  assert.ok(s1.body.devCode, 'no SMS gateway here: the development code is returned');
  const v = await c.post(`/api/registration/drafts/${c.draft.draftId}/verify-phone`, { phone, code: s1.body.devCode }, c.h);
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.equal(v.body.phoneVerified, true);
  return v;
}
/** The 30-second wait between OTPs is for people, not for tests. */
const skipCooldown = (draftId) => raw(`update registration_phone_otps set created_at = created_at - interval '2 minutes' where draft_id=$1`, [draftId]);

const ENTERED = {
  currentLocation: 'Hyderabad',
  preferredLocation: 'Hyderabad, Bengaluru',
  noticePeriod: '30 days',
  preferredWorkModes: ['Hybrid'],
  expectedCtc: 10,
  password: 'Resum3first9',
  confirmPassword: 'Resum3first9',
  consent: CONSENT,
};

async function createAccount(c, { name, email, phone }) {
  return c.post('/api/auth/register', {
    ...ENTERED, name, email, phone,
    draftId: c.draft.draftId, draftToken: c.h.headers['x-draft-token'],
  });
}

test('boot', async () => {
  dbh = await startTestDb(DB_PORT);
  mock = await startMockProvider(MOCK_PORT);
  applyTestEnv(dbh.url, {
    PUBLIC_ORIGIN: `http://127.0.0.1:${API_PORT}`,
    DISABLE_BACKGROUND_WORK: 'true',
    EMAIL_API_KEY: 'test-key',
    EMAIL_FROM: 'noreply@teamlink.example',
    EMAIL_API_URL: `http://127.0.0.1:${MOCK_PORT}/email`,
    EMAIL_SMTP_HOST: '', EMAIL_SMTP_USER: '', EMAIL_SMTP_PASS: '',
    EMAILJS_SERVICE_ID: '', EMAILJS_TEMPLATE_ID: '', EMAILJS_PUBLIC_KEY: '', EMAILJS_PRIVATE_KEY: '',
    OUTBOUND_ALLOWLIST: '',
    REGISTRATION_CONSENT_REQUIRED: '',
    /* "The AI is unavailable": a key is set and the model answers nonsense. */
    AI_API_KEY: 'test-ai-key',
    AI_API_URL: `http://127.0.0.1:${MOCK_PORT}/ai`,
  });
  raw = (sql, params) => dbh.db.query(sql, params);
  const { createApp } = await import('../src/app.js');
  const app = createApp({ logger: { error() {}, log() {} } });
  await new Promise((r) => { server = app.listen(API_PORT, r); });
  base = `http://127.0.0.1:${API_PORT}`;
});

test('the realistic resume: everything read, the candidate types only the six things, the profile is built', async () => {
  const email = `rahul.${uniq()}@mailbox-teamlink-tests.in`;
  const phone = mobile();
  const c = await client();
  const up = await upload(c, resumeText({ email, phone }));
  assert.equal(up.status, 201, JSON.stringify(up.body));
  const d = up.body;

  /* saved as a draft in the backend, immediately, with the file */
  const row = (await raw(`select status, resume_storage_path, resume_text from registration_drafts where id=$1`, [d.draftId])).rows[0];
  assert.equal(row.status, 'extracted');
  assert.ok(row.resume_storage_path, 'the resume file is stored');
  assert.ok(row.resume_text.includes('Spring Boot'));

  /* read out of the resume */
  assert.equal(d.fields.name, 'Rahul Kumar');
  assert.equal(d.fields.email, email);
  assert.equal(d.fields.expYears, 5);
  assert.equal(d.fields.currentCompany, 'ABC Technologies Pvt Ltd');
  assert.deepEqual(d.fields.previousCompanies, ['XYZ Solutions', 'Infotech Systems']);
  for (const s of ['Java', 'Spring Boot', 'SQL']) assert.ok(d.fields.skills.includes(s), s);
  assert.equal(d.fields.educationRecords.length, 3);
  assert.equal(d.fields.projects.length, 2);
  assert.equal(d.fields.certifications.length, 2);
  assert.ok(d.confidence.email >= 0.9, 'per-field confidence is returned');
  /* nothing about identity needs typing */
  assert.deepEqual(d.ask, { name: false, email: false, phone: false },
    'name, email and phone are not asked again');
  assert.equal(d.phoneVerified, false, 'the mobile number still has to answer its OTP');
  assert.equal(d.needsVerification.length, 0);
  /* the AI failed (mock answered nonsense) and the parser's reading stood */
  assert.equal(d.source, 'parser');

  /* the account cannot be made before the mobile number answers its OTP - not by calling the API directly either */
  const early = await createAccount(c, { name: d.fields.name, email, phone: d.fields.phone });
  assert.equal(early.status, 400);
  assert.match(JSON.stringify(early.body), /verify your mobile number/i);
  assert.equal((await raw(`select count(*)::int n from candidates where email=$1`, [email])).rows[0].n, 0, 'nothing was created');

  await verifyPhone(c, d.fields.phone);
  const reg = await createAccount(c, { name: d.fields.name, email, phone: d.fields.phone });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  assert.ok(reg.body.candidateCode.startsWith('TL-CAN-'));
  assert.equal(reg.body.profileWarning, null);

  const cand = (await raw(`select * from candidates where id=$1`, [reg.body.candidateId])).rows[0];
  assert.equal(cand.name, 'Rahul Kumar');
  assert.equal(cand.mobile_verified, true, 'the verified mobile number is marked verified');
  assert.equal(cand.email_verified, false, 'the email is no longer gated by a code');
  assert.equal(cand.resume_storage_path, row.resume_storage_path, 'the same stored resume, attached');
  assert.equal(cand.current_company, 'ABC Technologies Pvt Ltd');
  assert.equal(Number(cand.exp_years), 5);
  assert.ok(cand.skills.includes('Spring Boot'));
  assert.equal(cand.location, 'Hyderabad');
  assert.equal(cand.preferred_location, 'Hyderabad, Bengaluru');
  assert.equal(cand.notice_period, '30 days', 'the notice period chosen at registration');
  assert.deepEqual(cand.preferred_work_modes, ['Hybrid']);
  assert.equal(Number(cand.expected_ctc), 10);
  assert.equal(cand.certifications.length, 2);
  assert.equal(cand.linkedin, 'https://www.linkedin.com/in/rahul-kumar-dev');
  assert.equal(cand.profile_field_sources.skills, 'EXTRACTED');
  assert.equal(cand.profile_field_sources.noticePeriod, 'USER_PROVIDED');

  const edu = (await raw(`select qualification, institution, passing_year, score from candidate_education
                           where candidate_id=$1 order by sort_order`, [cand.id])).rows;
  assert.deepEqual(edu.map((e) => e.qualification), ['B.Tech', 'Intermediate', 'SSC'], 'three records, none overwritten');
  assert.equal(edu[0].institution, 'JNTU Hyderabad');
  const exp = (await raw(`select company from candidate_experience where candidate_id=$1 order by sort_order`, [cand.id])).rows;
  assert.equal(exp.length, 3);

  const drafted = (await raw(`select status, candidate_id from registration_drafts where id=$1`, [d.draftId])).rows[0];
  assert.deepEqual(drafted, { status: 'converted', candidate_id: cand.id });

  /* completeness: the profile page's twelve sections; only what is missing
     is listed, and never 100% while something is */
  const comp = reg.body.completeness;
  assert.equal(comp.percent, 92, 'eleven of twelve sections');
  assert.deepEqual(comp.missing.map((m) => m.key), ['availability'],
    'only availability (joining date, relocation) is missing - the resume and the answers covered the rest');
  assert.deepEqual(comp.missing[0].fields.map((f) => f.key), ['joining', 'relocation']);
  const st = Object.fromEntries(comp.fields.map((f) => [f.key, f.status]));
  assert.equal(st.skills, 'EXTRACTED');
  assert.equal(st.education, 'EXTRACTED');
  assert.equal(st.name, 'EXTRACTED');
  assert.equal(st.expectedSalary, 'USER_PROVIDED');
  assert.equal(st.noticePeriod, 'USER_PROVIDED');
  assert.equal(st.joining, 'MISSING');

  /* never 100% while a detail is missing, and the score rises as each is completed */
  await raw(`update candidates set immediate_joiner = false, available_from = '2026-11-15', willing_to_relocate = true where id=$1`, [cand.id]);
  const after = await c.get('/api/me/profile-completeness');
  assert.equal(after.body.percent, 100);
  assert.equal(after.body.complete, true);
  assert.equal(after.body.missing.length, 0);
});

test('a low-confidence value is listed for verification and not written unless confirmed', async () => {
  const email = `low.${uniq()}@mailbox-teamlink-tests.in`;
  const c = await client();
  const up = await upload(c, resumeText({ email, phone: mobile(), extra: '\nCurrent CTC: 6 LPA' }));
  assert.equal(up.status, 201, JSON.stringify(up.body));
  assert.ok(up.body.confidence.currentSalary < up.body.threshold);
  assert.ok(up.body.needsVerification.includes('currentSalary'));

  await verifyPhone(c, up.body.fields.phone);
  const reg = await createAccount(c, { name: up.body.fields.name, email, phone: up.body.fields.phone });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  const cand = (await raw(`select ctc from candidates where id=$1`, [reg.body.candidateId])).rows[0];
  assert.equal(cand.ctc, null, 'the unconfirmed salary was not put on the profile');

  /* confirmed, it is written */
  const email2 = `low2.${uniq()}@mailbox-teamlink-tests.in`;
  const c2 = await client();
  const up2 = await upload(c2, resumeText({ email: email2, phone: mobile(), extra: '\nCurrent CTC: 6 LPA' }));
  const p = await c2.patch(`/api/registration/drafts/${up2.body.draftId}`, { corrections: { currentSalary: '6 LPA' } }, c2.h);
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.ok(!p.body.needsVerification.includes('currentSalary'));
  await verifyPhone(c2, up2.body.fields.phone);
  const reg2 = await createAccount(c2, { name: up2.body.fields.name, email: email2, phone: up2.body.fields.phone });
  assert.equal(reg2.status, 201, JSON.stringify(reg2.body));
  const cand2 = (await raw(`select ctc from candidates where id=$1`, [reg2.body.candidateId])).rows[0];
  assert.equal(Number(cand2.ctc), 600000);
});

test('a resume with no email: the address is typed and used', async () => {
  const c = await client();
  const up = await upload(c, resumeText({ email: null, phone: mobile() }));
  assert.equal(up.status, 201, JSON.stringify(up.body));
  assert.equal(up.body.fields.email, undefined);
  assert.equal(up.body.ask.email, true);
  const email = `noemail.${uniq()}@mailbox-teamlink-tests.in`;
  await verifyPhone(c, up.body.fields.phone);
  const reg = await createAccount(c, { name: up.body.fields.name, email, phone: up.body.fields.phone });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  const cand = (await raw(`select email, profile_field_sources from candidates where id=$1`, [reg.body.candidateId])).rows[0];
  assert.equal(cand.email, email);
  assert.equal(cand.profile_field_sources.email, 'USER_PROVIDED');
});

test('an existing email or mobile: no second account', async () => {
  const email = `dup.${uniq()}@mailbox-teamlink-tests.in`;
  const phone = mobile();
  const first = await client();
  const up = await upload(first, resumeText({ email, phone }));
  await verifyPhone(first, up.body.fields.phone);
  assert.equal((await createAccount(first, { name: up.body.fields.name, email, phone: up.body.fields.phone })).status, 201);

  /* same email: refused at creation */
  const again = await client();
  const up2 = await upload(again, resumeText({ email, phone: mobile() }));
  assert.equal(up2.body.existing.email, true);
  await verifyPhone(again, up2.body.fields.phone);
  const dup = await createAccount(again, { name: up2.body.fields.name, email, phone: up2.body.fields.phone });
  assert.equal(dup.status, 409);
  assert.match(dup.body.error.message, /already exists/i);

  /* same mobile: refused when the OTP is asked for */
  const other = `dup2.${uniq()}@mailbox-teamlink-tests.in`;
  const third = await client();
  const up3 = await upload(third, resumeText({ email: other, phone }));
  assert.equal(up3.body.existing.phone, true);
  const otp = await third.post(`/api/registration/drafts/${up3.body.draftId}/phone-otp`, { phone }, third.h);
  assert.equal(otp.status, 409);
  assert.match(otp.body.error.message, /already exists/i);
  const n = (await raw(`select count(*)::int as n from candidates where right(regexp_replace(phone,'\\D','','g'),10) = $1
                          and user_id is not null`, [phone])).rows[0].n;
  assert.equal(n, 1);
});

test('the mobile OTP: a valid number, a 6-digit code, the right code, and a changed number is not verified', async () => {
  const email = `otp.${uniq()}@mailbox-teamlink-tests.in`;
  const phone = mobile();
  const c = await client();
  const up = await upload(c, resumeText({ email, phone }));
  const id = up.body.draftId;
  const post = (p, body) => c.post(`/api/registration/drafts/${id}/${p}`, body, c.h);

  assert.equal((await post('phone-otp', { phone: '12345' })).status, 400, 'not a 10-digit mobile number');
  assert.match((await post('phone-otp', { phone: '98765' })).body.error.details.phone, /valid 10-digit mobile/);
  const sent = await post('phone-otp', { phone });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  /* asked again at once: refused (one a 30 seconds) */
  assert.equal((await post('phone-otp', { phone })).status, 429);

  const short = await post('verify-phone', { phone, code: '123' });
  assert.equal(short.status, 400);
  assert.equal(short.body.error.details.code, 'Enter the 6-digit OTP');
  const wrongCode = sent.body.devCode === '000000' ? '111111' : '000000';
  const wrong = await post('verify-phone', { phone, code: wrongCode });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.error.details.code, 'Invalid OTP');
  assert.equal((await c.get(`/api/registration/drafts/${id}`, c.h)).body.phoneVerified, false);
  /* the account cannot be created on a number that has not answered */
  assert.equal((await createAccount(c, { name: 'Rahul Kumar', email, phone })).status, 400);

  const ok = await post('verify-phone', { phone, code: sent.body.devCode });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.phoneVerified, true);
  assert.equal(String(ok.body.phone), phone.slice(-10));

  /* verified for THIS number only: registering a different one is refused */
  const swapped = await createAccount(c, { name: 'Rahul Kumar', email, phone: mobile() });
  assert.equal(swapped.status, 400);
  assert.match(JSON.stringify(swapped.body), /verify your mobile number/i);
  /* asking for an OTP for another number un-verifies the draft */
  await skipCooldown(id);
  assert.equal((await post('phone-otp', { phone: mobile() })).status, 200);
  assert.equal((await c.get(`/api/registration/drafts/${id}`, c.h)).body.phoneVerified, false);
  assert.equal((await createAccount(c, { name: 'Rahul Kumar', email, phone })).status, 400, 'the old number is no longer verified either');
});

test('an unreadable resume: kept, the reason given, and nothing created', async () => {
  const c = await client();
  /* a PDF with no text layer; the "AI OCR" answers nonsense, so it stays unread */
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n', 'latin1');
  const up = await c.post('/api/registration/drafts', fileForm(pdf, 'scan.pdf'));
  assert.equal(up.status, 201, JSON.stringify(up.body));
  assert.equal(up.body.status, 'failed');
  assert.match(up.body.error.message, /couldn't extract your resume automatically/);
  const row = (await raw(`select resume_storage_path, candidate_id from registration_drafts where id=$1`, [up.body.draftId])).rows[0];
  assert.ok(row.resume_storage_path, 'the resume is kept');
  assert.equal(row.candidate_id, null, 'no candidate was created');
});

test('a reading that times out: the resume is kept and a retry reads it', async () => {
  const c = await client();
  process.env.REGISTRATION_EXTRACT_TIMEOUT_MS = '1';
  const up = await upload(c, resumeText({ email: `slow.${uniq()}@mailbox-teamlink-tests.in`, phone: mobile() }));
  process.env.REGISTRATION_EXTRACT_TIMEOUT_MS = '';
  assert.equal(up.status, 201, JSON.stringify(up.body));
  assert.equal(up.body.status, 'failed');
  assert.equal(up.body.error.code, 'EXTRACTION_TIMEOUT');

  const retry = await c.post(`/api/registration/drafts/${up.body.draftId}/retry`, {}, c.h);
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.status, 'extracted');
  assert.equal(retry.body.fields.name, 'Rahul Kumar');
});

test('a draft is only readable with its own token', async () => {
  const c = await client();
  const up = await upload(c, resumeText({ email: `tok.${uniq()}@mailbox-teamlink-tests.in`, phone: mobile() }));
  const stranger = await client();
  const r = await stranger.get(`/api/registration/drafts/${up.body.draftId}`,
    { headers: { 'x-draft-token': 'a'.repeat(48) } });
  assert.equal(r.status, 404);
  const none = await stranger.get(`/api/registration/drafts/${up.body.draftId}`);
  assert.equal(none.status, 401);
  const mine = await c.get(`/api/registration/drafts/${up.body.draftId}`, c.h);
  assert.equal(mine.status, 200);
  assert.equal(mine.body.resume_text, undefined, 'the resume text never goes back to the page');
});

test('the plain registration (no resume) is unchanged', async () => {
  const c = await client();
  const r = await c.post('/api/auth/register', {
    name: 'Plain Person', email: `plain.${uniq()}@mailbox-teamlink-tests.in`, phone: mobile(),
    password: 'Plain1person', preferredLocation: 'Pune', expectedCtc: 4, noticePeriod: 'Immediate',
    preferredWorkModes: ['Office'], consent: CONSENT,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.completeness, undefined);
});

test('the notice period is mandatory, and from the resume registration it must be one of the offered options', async () => {
  const plain = await (await client()).post('/api/auth/register', {
    name: 'No Notice', email: `nonotice.${uniq()}@mailbox-teamlink-tests.in`, phone: mobile(),
    password: 'Plain1person', preferredLocation: 'Pune', expectedCtc: 4,
    preferredWorkModes: ['Office'], consent: CONSENT,
  });
  assert.equal(plain.status, 400, JSON.stringify(plain.body));
  assert.equal(plain.body.error.details.noticePeriod, 'Notice period is required');

  const email = `nopd.${uniq()}@mailbox-teamlink-tests.in`;
  const c = await client();
  const up = await upload(c, resumeText({ email, phone: mobile() }));
  await verifyPhone(c, up.body.fields.phone);
  const body = (noticePeriod) => ({ ...ENTERED, noticePeriod, name: up.body.fields.name, email, phone: up.body.fields.phone,
    draftId: c.draft.draftId, draftToken: c.h.headers['x-draft-token'] });
  for (const bad of [undefined, '', 'Select', '7 days', 'tomorrow']) {
    const r = await c.post('/api/auth/register', body(bad));
    assert.equal(r.status, 400, `${bad}: ${JSON.stringify(r.body)}`);
    assert.match(r.body.error.details.noticePeriod, /Notice period is required|Choose a valid notice period/);
  }
  assert.equal((await raw(`select count(*)::int n from candidates where email=$1`, [email])).rows[0].n, 0);
  for (const good of ['Immediate', 'Currently serving notice']) {
    const e2 = `${good.split(' ')[0].toLowerCase()}.${uniq()}@mailbox-teamlink-tests.in`;
    const c2 = await client();
    const u2 = await upload(c2, resumeText({ email: e2, phone: mobile() }));
    await verifyPhone(c2, u2.body.fields.phone);
    const r = await c2.post('/api/auth/register', { ...ENTERED, noticePeriod: good, name: u2.body.fields.name, email: e2, phone: u2.body.fields.phone,
      draftId: c2.draft.draftId, draftToken: c2.h.headers['x-draft-token'] });
    assert.equal(r.status, 201, `${good}: ${JSON.stringify(r.body)}`);
    assert.equal((await raw(`select notice_period from candidates where id=$1`, [r.body.candidateId])).rows[0].notice_period, good);
  }
});

test('what the candidate typed on the one screen becomes the profile: education, experience and role win over the reading', async () => {
  const email = `typed.${uniq()}@mailbox-teamlink-tests.in`;
  const c = await client();
  const up = await upload(c, resumeText({ email, phone: mobile() }));
  const p = await c.patch(`/api/registration/drafts/${up.body.draftId}`, { corrections: {
    qualification: 'MBA', institution: 'Osmania University', passingYear: '2021', expYears: 7, currentCompany: 'Typed Corp', title: 'Delivery Manager' } }, c.h);
  assert.equal(p.status, 200, JSON.stringify(p.body));
  await verifyPhone(c, up.body.fields.phone);
  const reg = await createAccount(c, { name: up.body.fields.name, email, phone: up.body.fields.phone });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  const cand = (await raw(`select current_company, title, exp_years from candidates where id=$1`, [reg.body.candidateId])).rows[0];
  assert.equal(cand.current_company, 'Typed Corp');
  assert.equal(cand.title, 'Delivery Manager');
  assert.equal(Number(cand.exp_years), 7);
  const edu = (await raw(`select qualification, institution, passing_year from candidate_education where candidate_id=$1 order by sort_order`, [reg.body.candidateId])).rows;
  assert.equal(edu[0].qualification, 'MBA');
  assert.equal(edu[0].institution, 'Osmania University');
  assert.equal(String(edu[0].passing_year), '2021');
  assert.ok(edu.length >= 3, 'the other education records the resume had are still there');
});

test('where OTP is required (production, or REGISTRATION_OTP_REQUIRED=true) a bare form cannot create an account', async () => {
  process.env.REGISTRATION_OTP_REQUIRED = 'true';
  try {
    const r = await (await client()).post('/api/auth/register', {
      name: 'Bare Form', email: `bare.${uniq()}@mailbox-teamlink-tests.in`, phone: mobile(),
      password: 'Plain1person', preferredLocation: 'Pune', expectedCtc: 4, noticePeriod: '30 days',
      preferredWorkModes: ['Office'], consent: CONSENT,
    });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.match(r.body.error.message, /register with your resume and verify your mobile number/i);
  } finally {
    process.env.REGISTRATION_OTP_REQUIRED = '';
  }
});

test('teardown', async () => {
  await new Promise((r) => server.close(r));
  const { stopBackgroundWork } = await import('../src/app.js');
  stopBackgroundWork();
  const { closePool } = await import('../src/db.js');
  await closePool();
  await mock.stop();
  await dbh.stop();
});
