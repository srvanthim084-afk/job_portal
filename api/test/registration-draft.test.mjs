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
  preferredWorkModes: ['Hybrid'],
  noticePeriod: '30 days',             /* mandatory on the registration page, as are location and salary */
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
    /* the mobile OTP has its own tests below; the older ones are about the email and the resume */
    REGISTRATION_PHONE_VERIFY: '', REGISTRATION_OTP_REQUIRED: '', SMS_API_KEY: '',   /* unset = the default: no mobile OTP */
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
  /* total experience from ALL three jobs' dates (Jun 2019 - Present), not the one figure the summary states */
  assert.ok(d.fields.expYears >= 7, `total experience from every job's dates: ${d.fields.expYears}`);
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
  assert.equal(Number(cand.exp_years), d.fields.expYears);
  assert.ok(cand.skills.includes('Spring Boot'));
  assert.equal(cand.location, 'Hyderabad');
  assert.equal(cand.preferred_location, 'Hyderabad, Bengaluru');
  assert.equal(cand.notice_period, '30 days', 'notice period is asked (and required) at registration');
  assert.deepEqual(cand.preferred_work_modes, ['Hybrid']);
  assert.equal(Number(cand.expected_ctc), 10);
  assert.equal(cand.certifications.length, 2);
  assert.equal(cand.linkedin, 'https://www.linkedin.com/in/rahul-kumar-dev');
  assert.equal(cand.profile_field_sources.skills, 'EXTRACTED');
  assert.equal(cand.profile_field_sources.noticePeriod, 'USER_PROVIDED', 'given on the registration page');

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
  assert.deepEqual(comp.missing.map((m) => m.key), ['availability'], 'availability is what is still missing');
  assert.deepEqual(comp.missing[0].fields.map((f) => f.key), ['joining', 'relocation']);
  const st = Object.fromEntries(comp.fields.map((f) => [f.key, f.status]));
  assert.equal(st.skills, 'EXTRACTED');
  assert.equal(st.education, 'EXTRACTED');
  assert.equal(st.name, 'EXTRACTED');
  assert.equal(st.expectedSalary, 'USER_PROVIDED');
  assert.equal(st.noticePeriod, 'USER_PROVIDED');
  assert.equal(st.joining, 'MISSING');

  /* never 100% while a detail is missing, and the score rises when it is completed */
  const mid = await c.get('/api/me/profile-completeness');
  assert.equal(mid.status, 200, JSON.stringify(mid.body));
  assert.equal(mid.body.percent, 92);
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

test('the plain seven-step registration still requires a notice period; the resume-first one does not', async () => {
  const c = await client();
  const r = await c.post('/api/auth/register', {
    name: 'No Notice', email: `nonotice.${uniq()}@mailbox-teamlink-tests.in`, phone: mobile(),
    password: 'Plain1person', preferredLocation: 'Pune', expectedCtc: 4,
    preferredWorkModes: ['Office'], consent: CONSENT,
  });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(r.body.error.details.noticePeriod, 'Please select a notice period');
});

/* ------------------------------------------------------------------ *
 * the simplified registration: the resume is optional, seven profile fields
 * ------------------------------------------------------------------ */
const SIMPLE = { password: 'Simpl3reg9pass', confirmPassword: 'Simpl3reg9pass', consent: { terms: true, communication: false, resumeProcessing: false },
  /* mandatory on the registration page */
  preferredLocation: 'Pune', noticePeriod: 'Immediate', expectedCtc: 5 };

async function noResumeDraft(c) {
  const r = await c.post('/api/registration/drafts', { noResume: true });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  c.draft = r.body;
  c.h = { headers: { 'x-draft-token': r.body.draftToken } };
  return r;
}

test('no resume: the seven fields are typed, the email answers its code, the account is made without the old preferences, and they are signed in', async () => {
  const email = `norez.${uniq()}@mailbox-teamlink-tests.in`;
  const phone = mobile();
  const c = await client();
  await noResumeDraft(c);
  assert.equal(c.draft.resume, null);
  assert.equal(c.draft.status, 'pending');
  await verifyEmail(c, email);

  const fix = await c.patch(`/api/registration/drafts/${c.draft.draftId}`, {
    corrections: { name: 'Asha Verma', phone, highestEducation: "Master's Degree", title: 'Data Analyst',
      currentCompany: 'Globex Corp', skills: ['SQL', 'sql', 'Excel', 'Excel ', 'Python'] } }, c.h);
  assert.equal(fix.status, 200, JSON.stringify(fix.body));
  assert.deepEqual(fix.body.corrections.skills, ['SQL', 'Excel', 'Python'], 'the same skill twice is one skill');

  const reg = await c.post('/api/auth/register', { name: 'Asha Verma', email, phone, ...SIMPLE,
    draftId: c.draft.draftId, draftToken: c.h.headers['x-draft-token'] });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));

  const cand = (await raw(`select * from candidates where id=$1`, [reg.body.candidateId])).rows[0];
  assert.equal(cand.name, 'Asha Verma');
  assert.equal(cand.email_verified, true);
  assert.equal(cand.resume_storage_path, null, 'no resume was uploaded');
  assert.equal(cand.current_company, 'Globex Corp');
  assert.deepEqual(cand.skills, ['SQL', 'Excel', 'Python']);
  const edu = (await raw(`select qualification from candidate_education where candidate_id=$1`, [cand.id])).rows;
  assert.equal(edu.length, 1);
  assert.equal(edu[0].qualification, "Master's Degree");
  /* the optional communication consent was declined: not granted; terms granted */
  const consents = (await raw(`select kind, status from candidate_consents where candidate_id=$1`, [cand.id])).rows;
  assert.ok(consents.some((x) => x.kind === 'terms' && x.status === 'granted'));
  assert.ok(!consents.some((x) => x.kind === 'communication' && x.status === 'granted'));
  /* the session was established: a signed-in call works with the same client */
  const me = await c.get('/api/me/profile-completeness');
  assert.equal(me.status, 200, JSON.stringify(me.body));
});

test('fresher: the resume employment is not put on the profile', async () => {
  const email = `fresh.${uniq()}@mailbox-teamlink-tests.in`;
  const phone = mobile();
  const c = await client();
  const up = await upload(c, resumeText({ email, phone }));
  assert.equal(up.status, 201);
  assert.equal(up.body.fields.currentCompany, 'ABC Technologies Pvt Ltd');
  await verifyEmail(c, email);
  await c.patch(`/api/registration/drafts/${c.draft.draftId}`, { corrections: { title: null, currentCompany: null } }, c.h);
  const reg = await c.post('/api/auth/register', { name: 'Rahul Kumar', email, phone, fresher: true, ...SIMPLE,
    draftId: c.draft.draftId, draftToken: c.h.headers['x-draft-token'] });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  const cand = (await raw(`select current_company, exp_years from candidates where id=$1`, [reg.body.candidateId])).rows[0];
  assert.equal(cand.current_company, null);
  assert.equal(Number(cand.exp_years), 0);
});

test('replacing the resume keeps the verified email and reads the new file', async () => {
  const email = `swap.${uniq()}@mailbox-teamlink-tests.in`;
  const c = await client();
  await upload(c, resumeText({ name: 'First Person', email, phone: mobile() }));
  await verifyEmail(c, email);
  const second = resumeText({ name: 'Second Person', email, phone: mobile() }).replace('ABC Technologies Pvt Ltd', 'Other Systems Ltd');
  const r = await c.post(`/api/registration/drafts/${c.draft.draftId}/resume`, fileForm(Buffer.from(second, 'utf8'), 'second.txt'), c.h);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.resume.fileName, 'second.txt');
  assert.equal(r.body.fields.name, 'Second Person');
  assert.equal(r.body.fields.currentCompany, 'Other Systems Ltd');
  assert.equal(r.body.emailVerified, true, 'the address already answered its code');
});

test('a highest education outside the list is refused', async () => {
  const c = await client();
  await noResumeDraft(c);
  const bad = await c.patch(`/api/registration/drafts/${c.draft.draftId}`, { corrections: { highestEducation: 'Wizard School' } }, c.h);
  assert.equal(bad.status, 400);
  assert.ok(bad.body.error.details.highestEducation);
});

test('duplicate email: two submissions at once make one account, and a later attempt is told the address exists', async () => {
  const email = `dup.${uniq()}@mailbox-teamlink-tests.in`;
  const c = await client();
  await noResumeDraft(c);
  await verifyEmail(c, email);
  const body = { name: 'Dup Person', email, phone: mobile(), ...SIMPLE, draftId: c.draft.draftId, draftToken: c.h.headers['x-draft-token'] };
  const both = await Promise.all([c.post('/api/auth/register', body), c.post('/api/auth/register', body)]);
  assert.equal(both.filter((x) => x.status === 201).length, 1, both.map((x) => x.status).join(','));
  assert.equal((await raw(`select count(*)::int as n from candidates where lower(email)=lower($1)`, [email])).rows[0].n, 1);

  const c2 = await client();
  await noResumeDraft(c2);
  const again = await c2.post(`/api/registration/drafts/${c2.draft.draftId}/email-code`, { email }, c2.h);
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'EMAIL_TAKEN');
  assert.match(again.body.error.details.email, /already exists.*Login/i);

  /* and straight to the register route */
  const c3 = await client();
  const direct = await c3.post('/api/auth/register', { name: 'Dup Person', email, phone: mobile(), ...SIMPLE,
    draftId: c2.draft.draftId, draftToken: c2.h.headers['x-draft-token'] });
  assert.ok([400, 409].includes(direct.status), JSON.stringify(direct.body));
});

test('the seven-step registration still requires its four preferences', async () => {
  const c = await client();
  const r = await c.post('/api/auth/register', {
    name: 'No Prefs', email: `noprefs.${uniq()}@mailbox-teamlink-tests.in`, phone: mobile(),
    password: 'Plain1person', consent: CONSENT,
  });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  for (const k of ['preferredLocation', 'expectedCtc', 'noticePeriod', 'preferredWorkModes']) assert.ok(r.body.error.details[k], k);
});

test('pasted resume text is read like a file, on a new draft or an existing one', async () => {
  const email = `paste.${uniq()}@mailbox-teamlink-tests.in`;
  const c = await client();
  const text = resumeText({ name: 'Paste Person', email, phone: mobile() });
  const r = await c.post('/api/registration/drafts', { resumeText: text });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.status, 'extracted');
  assert.equal(r.body.fields.name, 'Paste Person');
  assert.equal(r.body.resume, null, 'no file');
  c.draft = r.body; c.h = { headers: { 'x-draft-token': r.body.draftToken } };
  const short = await c.post(`/api/registration/drafts/${c.draft.draftId}/text`, { resumeText: 'too short' }, c.h);
  assert.equal(short.status, 400);
  const again = await c.post(`/api/registration/drafts/${c.draft.draftId}/text`, { resumeText: text.replace('Paste Person'.toUpperCase(), 'OTHER PERSON') }, c.h);
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.fields.name, 'Other Person');
  const noToken = await c.post(`/api/registration/drafts/${c.draft.draftId}/text`, { resumeText: text });
  assert.equal(noToken.status, 401);

  /* and the account: the classic form's fields, WhatsApp opt-in, the exact degree */
  await verifyEmail(c, email);
  await c.patch(`/api/registration/drafts/${c.draft.draftId}`, { corrections: { qualification: 'B.Tech/B.E', highestEducation: "Bachelor's Degree" } }, c.h);
  const reg = await c.post('/api/auth/register', { name: 'Paste Person', email, phone: mobile(), ...SIMPLE,
    currentLocation: 'Hyderabad', preferredLocation: 'Pune', whatsappOptIn: true,
    draftId: c.draft.draftId, draftToken: c.h.headers['x-draft-token'] });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  const row = (await raw(`select whatsapp_opt_in, location, preferred_location, education from candidates where id=$1`, [reg.body.candidateId])).rows[0];
  assert.equal(row.whatsapp_opt_in, true);
  assert.equal(row.location, 'Hyderabad');
  assert.equal(row.preferred_location, 'Pune');
});

/* ------------------------------------------------------------------ *
 * the mobile OTP (0123): both codes before the account
 * ------------------------------------------------------------------ */
test('email code AND mobile OTP: the account needs both, for the same address and number', async () => {
  process.env.REGISTRATION_PHONE_VERIFY = 'true';
  try {
    const email = `otp.${uniq()}@mailbox-teamlink-tests.in`;
    const phone = mobile();
    const c = await client();
    await noResumeDraft(c);
    await verifyEmail(c, email);
    const body = () => ({ name: 'Otp Person', email, phone, ...SIMPLE, draftId: c.draft.draftId, draftToken: c.h.headers['x-draft-token'] });

    /* email verified, mobile not: refused, and nothing is created */
    const early = await c.post('/api/auth/register', body());
    assert.equal(early.status, 400, JSON.stringify(early.body));
    assert.match(early.body.error.details.phone, /verify your mobile number/i);
    assert.equal((await raw(`select count(*)::int as n from candidates where lower(email)=lower($1)`, [email])).rows[0].n, 0);

    /* an invalid number is refused before any code is sent */
    const bad = await c.post(`/api/registration/drafts/${c.draft.draftId}/phone-otp`, { phone: '12345' }, c.h);
    assert.equal(bad.status, 400);

    /* the OTP: sent (development: shown, as there is no SMS gateway in the test) */
    const sent = await c.post(`/api/registration/drafts/${c.draft.draftId}/phone-otp`, { phone }, c.h);
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.match(sent.body.devCode, /^\d{6}$/);
    const again = await c.post(`/api/registration/drafts/${c.draft.draftId}/phone-otp`, { phone }, c.h);
    assert.equal(again.status, 429, 'one OTP every 30 seconds');

    /* a wrong code is refused; the right one verifies */
    const wrong = await c.post(`/api/registration/drafts/${c.draft.draftId}/verify-phone`,
      { phone, code: sent.body.devCode === '000000' ? '111111' : '000000' }, c.h);
    assert.equal(wrong.status, 400);
    assert.match(wrong.body.error.details.code, /Invalid OTP/);
    const ok = await c.post(`/api/registration/drafts/${c.draft.draftId}/verify-phone`, { phone, code: sent.body.devCode }, c.h);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.phoneVerified, true);
    assert.equal(ok.body.emailVerified, true);

    /* a different number than the one verified: refused */
    const other = await c.post('/api/auth/register', { ...body(), phone: mobile() });
    assert.equal(other.status, 400);
    assert.match(other.body.error.details.phone, /verify your mobile number/i);

    const reg = await c.post('/api/auth/register', body());
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    const row = (await raw(`select email_verified, mobile_verified from candidates where id=$1`, [reg.body.candidateId])).rows[0];
    assert.deepEqual(row, { email_verified: true, mobile_verified: true });

    /* a second person with the same number is told it exists */
    const c2 = await client();
    await noResumeDraft(c2);
    const dup = await c2.post(`/api/registration/drafts/${c2.draft.draftId}/phone-otp`, { phone }, c2.h);
    assert.equal(dup.status, 409);
    assert.match(dup.body.error.details.phone, /already exists/);
  } finally {
    process.env.REGISTRATION_PHONE_VERIFY = '';
  }
});

test('where OTP is required, the older form cannot register straight through /auth/register', async () => {
  process.env.REGISTRATION_OTP_REQUIRED = 'true';
  try {
    const c = await client();
    const r = await c.post('/api/auth/register', {
      name: 'Bare Form', email: `bare.${uniq()}@mailbox-teamlink-tests.in`, phone: mobile(),
      password: 'Plain1person', preferredLocation: 'Pune', expectedCtc: 4, noticePeriod: 'Immediate',
      preferredWorkModes: ['Office'], consent: CONSENT,
    });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.ok(r.body.error.details.email, 'the email must answer its code');
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
