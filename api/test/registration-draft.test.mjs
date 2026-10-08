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
 *   - the email answers a 6-digit code before the account exists
 *   - a resume without an email: the address is asked and verified
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

async function verifyEmail(c, email) {
  const s = await c.post(`/api/registration/drafts/${c.draft.draftId}/email-code`, { email }, c.h);
  assert.equal(s.status, 200, JSON.stringify(s.body));
  const code = s.body.devCode || codeFor(email);
  assert.ok(code, 'a code was sent');
  const v = await c.post(`/api/registration/drafts/${c.draft.draftId}/verify-email`, { email, code }, c.h);
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.equal(v.body.emailVerified, true);
  return v;
}

const ENTERED = {
  currentLocation: 'Hyderabad',
  preferredLocation: 'Hyderabad, Bengaluru',
  noticePeriod: '30 Days',
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
  assert.equal(d.emailVerified, false, 'the email still has to answer its code');
  assert.equal(d.needsVerification.length, 0);
  /* the AI failed (mock answered nonsense) and the parser's reading stood */
  assert.equal(d.source, 'parser');

  /* the account cannot be made before the email answers its code */
  const early = await createAccount(c, { name: d.fields.name, email, phone: d.fields.phone });
  assert.equal(early.status, 400);
  assert.match(JSON.stringify(early.body), /verify your email/i);

  await verifyEmail(c, email);
  const reg = await createAccount(c, { name: d.fields.name, email, phone: d.fields.phone });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  assert.ok(reg.body.candidateCode.startsWith('TL-CAN-'));
  assert.equal(reg.body.profileWarning, null);

  const cand = (await raw(`select * from candidates where id=$1`, [reg.body.candidateId])).rows[0];
  assert.equal(cand.name, 'Rahul Kumar');
  assert.equal(cand.email_verified, true);
  assert.equal(cand.resume_storage_path, row.resume_storage_path, 'the same stored resume, attached');
  assert.equal(cand.current_company, 'ABC Technologies Pvt Ltd');
  assert.equal(Number(cand.exp_years), 5);
  assert.ok(cand.skills.includes('Spring Boot'));
  assert.equal(cand.location, 'Hyderabad');
  assert.equal(cand.preferred_location, 'Hyderabad, Bengaluru');
  assert.equal(cand.notice_period, '30 Days');
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
    'only availability (joining date, relocation) is missing - the resume and the six answers covered the rest');
  assert.deepEqual(comp.missing[0].fields.map((f) => f.key), ['joining', 'relocation']);
  const st = Object.fromEntries(comp.fields.map((f) => [f.key, f.status]));
  assert.equal(st.skills, 'EXTRACTED');
  assert.equal(st.education, 'EXTRACTED');
  assert.equal(st.name, 'EXTRACTED');
  assert.equal(st.expectedSalary, 'USER_PROVIDED');
  assert.equal(st.joining, 'MISSING');

  /* the score rises as the missing details are completed */
  await raw(`update candidates set immediate_joiner = false, available_from = '2026-11-15' where id=$1`, [cand.id]);
  const mid = await c.get('/api/me/profile-completeness');
  assert.equal(mid.status, 200, JSON.stringify(mid.body));
  assert.equal(mid.body.percent, 92, 'one of the two availability details is not enough for the section');
  assert.deepEqual(mid.body.missing[0].fields.map((f) => f.key), ['relocation']);
  await raw(`update candidates set willing_to_relocate = true where id=$1`, [cand.id]);
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

  await verifyEmail(c, email);
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
  await verifyEmail(c2, email2);
  const reg2 = await createAccount(c2, { name: up2.body.fields.name, email: email2, phone: up2.body.fields.phone });
  assert.equal(reg2.status, 201, JSON.stringify(reg2.body));
  const cand2 = (await raw(`select ctc from candidates where id=$1`, [reg2.body.candidateId])).rows[0];
  assert.equal(Number(cand2.ctc), 600000);
});

test('a resume with no email: the address is asked, verified, and used', async () => {
  const c = await client();
  const up = await upload(c, resumeText({ email: null, phone: mobile() }));
  assert.equal(up.status, 201, JSON.stringify(up.body));
  assert.equal(up.body.fields.email, undefined);
  assert.equal(up.body.ask.email, true);
  const email = `noemail.${uniq()}@mailbox-teamlink-tests.in`;
  await verifyEmail(c, email);
  const reg = await createAccount(c, { name: up.body.fields.name, email, phone: up.body.fields.phone });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  const cand = (await raw(`select email, email_verified, profile_field_sources from candidates where id=$1`, [reg.body.candidateId])).rows[0];
  assert.equal(cand.email, email);
  assert.equal(cand.email_verified, true);
  assert.equal(cand.profile_field_sources.email, 'USER_PROVIDED');
});

test('an existing email or mobile: no second account', async () => {
  const email = `dup.${uniq()}@mailbox-teamlink-tests.in`;
  const phone = mobile();
  const first = await client();
  const up = await upload(first, resumeText({ email, phone }));
  await verifyEmail(first, email);
  assert.equal((await createAccount(first, { name: up.body.fields.name, email, phone: up.body.fields.phone })).status, 201);

  /* same email: told at the code step, before anything else */
  const again = await client();
  const up2 = await upload(again, resumeText({ email, phone: mobile() }));
  assert.equal(up2.body.existing.email, true);
  const code = await again.post(`/api/registration/drafts/${up2.body.draftId}/email-code`, { email }, again.h);
  assert.equal(code.status, 409);
  assert.match(code.body.error.message, /already exists/i);

  /* same mobile: flagged on upload, refused at creation */
  const other = `dup2.${uniq()}@mailbox-teamlink-tests.in`;
  const third = await client();
  const up3 = await upload(third, resumeText({ email: other, phone }));
  assert.equal(up3.body.existing.phone, true);
  await verifyEmail(third, other);
  const reg = await createAccount(third, { name: up3.body.fields.name, email: other, phone: up3.body.fields.phone });
  assert.equal(reg.status, 409);
  const n = (await raw(`select count(*)::int as n from candidates where right(regexp_replace(phone,'\\D','','g'),10) = $1
                          and user_id is not null`, [phone])).rows[0].n;
  assert.equal(n, 1);
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

test('teardown', async () => {
  await new Promise((r) => server.close(r));
  const { stopBackgroundWork } = await import('../src/app.js');
  stopBackgroundWork();
  const { closePool } = await import('../src/db.js');
  await closePool();
  await mock.stop();
  await dbh.stop();
});
