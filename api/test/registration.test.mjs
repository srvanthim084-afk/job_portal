/**
 * The multi-step registration's server side, documents and privacy (0109),
 * end to end against a real Postgres with RLS on.
 *
 *   - every candidate has a unique TL-CAN-000123 Candidate ID (new ones
 *     by trigger, never editable), returned by /auth/register and /auth/me
 *   - duplicate email / duplicate mobile refused with the owner's words,
 *     in the database; a recruiter-typed record does not block the person
 *   - mobile format, confirm password, consent (stored with its version;
 *     required when configured)
 *   - the inline duplicate check, and its rate limit
 *   - sign-up failure lockout per origin, sign-in lockout per account
 *   - welcome email with the Candidate ID, once; never to do-not-contact or
 *     an opted-out address; one profile reminder, once, only for people
 *     who registered through this flow
 *   - documents: upload / replace / download / delete, magic bytes, type
 *     and size per kind, owner + authorised recruiter + admin only
 *   - Download My Data: own data only, no staff notes; deletion request
 *     recorded, admin processes it, nothing hard-deleted
 *
 * Nothing leaves the machine: email goes to the mock provider.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb, applyTestEnv, makeClient, startMockProvider } from './harness.mjs';

const DB_PORT = 5467;
const API_PORT = 9987;
const MOCK_PORT = 9864;

let dbh, server, mock, base, raw, msgs;
let REC, REC2, ADMIN;
const PREFS = { preferredLocation: 'Hyderabad', expectedCtc: 5, noticePeriod: 'Immediate', preferredWorkModes: ['Office'] };
const CONSENT = { terms: true, communication: true, resumeProcessing: true };
let seq = 0;
/* A domain that is not reserved, so the provider does not skip it; the
   mock provider is the only thing that ever receives the message. */
const email = (tag) => `reg.${tag}.${Date.now().toString(36)}${++seq}@mailbox-teamlink-tests.in`;
const phone = () => '9' + String(100000000 + Math.floor(Math.random() * 899999999));

async function signIn(e, p) {
  const c = makeClient(base);
  await c.get('/api/health');
  const r = await c.post('/api/auth/login', { email: e, password: p });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return c;
}

async function register(extra = {}) {
  const c = makeClient(base);
  await c.get('/api/health');
  const body = { name: 'Reg Person', email: email('p'), password: 'Regist3r9pass', phone: phone(),
    ...PREFS, consent: CONSENT, ...extra };
  const r = await c.post('/api/auth/register', body);
  c.res = r;
  c.email = body.email;
  c.password = body.password;
  if (r.status === 201) { c.id = r.body.candidateId; c.code = r.body.candidateCode; }
  return c;
}

async function eventually(fn, ms = 4000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
}
/* The queued welcome has finished (sent, failed or skipped). The test's raw
   connection shares PGlite's one session, so nothing raw runs mid-send. */
const settled = (id) => eventually(async () => (await raw(
  `select 1 from candidate_registration_messages where candidate_id = $1 and status not in ('pending','retrying')`,
  [id])).rowCount);
const mailsTo = (addr) => mock.received.filter((m) => m.url === '/email'
  && JSON.stringify(m.body.to || '').includes(addr));

/* Files, made here rather than trusted from anywhere. */
const PDF = (text) => Buffer.from(`%PDF-1.4\n1 0 obj<<>>endobj\n% ${text}\ntrailer<<>>\n%%EOF\n`, 'latin1');
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(64, 1)]);
const EXE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200, 0x90)]);
const form = (field, buf, name, extra = {}) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  fd.append(field, new Blob([buf]), name);
  return fd;
};

test('boot', async () => {
  dbh = await startTestDb(DB_PORT);
  mock = await startMockProvider(MOCK_PORT);
  applyTestEnv(dbh.url, {
    PUBLIC_ORIGIN: `http://127.0.0.1:${API_PORT}`,
    DISABLE_BACKGROUND_WORK: 'true',
    SMS_API_URL: `http://127.0.0.1:${MOCK_PORT}/sms`,
    EMAIL_API_KEY: 'test-key',
    EMAIL_FROM: 'noreply@teamlink.example',
    EMAIL_API_URL: `http://127.0.0.1:${MOCK_PORT}/email`,
    EMAIL_SMTP_HOST: '', EMAIL_SMTP_USER: '', EMAIL_SMTP_PASS: '',
    EMAILJS_SERVICE_ID: '', EMAILJS_TEMPLATE_ID: '', EMAILJS_PUBLIC_KEY: '', EMAILJS_PRIVATE_KEY: '',
    OUTBOUND_ALLOWLIST: '',
    CONSENT_VERSION: 'tc-2026-10-test',
    PRIVACY_POLICY_URL: 'https://teamlink.example/privacy',
    REGISTRATION_CONSENT_REQUIRED: '',
  });
  raw = (sql, params) => dbh.db.query(sql, params);

  const { hashPassword } = await import('../src/auth.js');
  const hash = await hashPassword('Staff123regist');
  await raw(`insert into companies (id, name) values ('co_r', 'Regtest Logistics')`);
  const user = async (e, role) => (await raw(
    `insert into users (email, password_hash, role) values ($1,$2,$3) returning id`, [e, hash, role])).rows[0].id;
  await raw(`insert into recruiters (id, user_id, name, email, company_id) values
               ('rR1', $1, 'Rekha', 'rekha@tl-sink.local', 'co_r'),
               ('rR2', $2, 'Ramu', 'ramu@tl-sink.local', 'co_r')`,
    [await user('rekha@tl-sink.local', 'recruiter'), await user('ramu@tl-sink.local', 'recruiter')]);
  await raw(`insert into admins (id, user_id, name, email) values ('admR', $1, 'Admin', 'admin.reg@tl-sink.local')`,
    [await user('admin.reg@tl-sink.local', 'admin')]);
  await raw(`insert into jobs (id, title, company_id, recruiter_id, status, location) values
     ('jR1', 'Store Associate', 'co_r', 'rR1', 'open', 'Hyderabad')`);

  const { createApp } = await import('../src/app.js');
  msgs = await import('../src/notify/registration-messages.js');
  const app = createApp({ logger: { error() {}, log() {} } });
  await new Promise((r) => { server = app.listen(API_PORT, r); });
  base = `http://127.0.0.1:${API_PORT}`;

  REC = await signIn('rekha@tl-sink.local', 'Staff123regist');
  REC2 = await signIn('ramu@tl-sink.local', 'Staff123regist');
  ADMIN = await signIn('admin.reg@tl-sink.local', 'Staff123regist');
});

/* ------------------------------------------------------------------ *
 * Candidate ID
 * ------------------------------------------------------------------ */
test('every registration gets a unique TL-CAN Candidate ID, shown back by /auth/me', async () => {
  const a = await register();
  const b = await register();
  assert.equal(a.res.status, 201, JSON.stringify(a.res.body));
  assert.match(a.code, /^TL-CAN-\d{6}$/);
  assert.match(b.code, /^TL-CAN-\d{6}$/);
  assert.notEqual(a.code, b.code);
  assert.equal(Number(b.code.slice(7)), Number(a.code.slice(7)) + 1, 'one sequence, no gaps between two in a row');

  const me = await a.get('/api/auth/me');
  assert.equal(me.body.profile.candidateCode, a.code);
  assert.equal(me.body.profile.id, a.id, 'the internal id is unchanged');
});

test('a candidate added any other way is numbered too, and the number cannot be edited', async () => {
  await raw(`insert into candidates (id, name, email) values ('cand_direct_r', 'Typed In', 'typed@tl-sink.local')`);
  const { rows } = await raw(`select candidate_code from candidates where id = 'cand_direct_r'`);
  assert.match(rows[0].candidate_code, /^TL-CAN-\d{6}$/);
  await raw(`update candidates set candidate_code = 'TL-CAN-999999' where id = 'cand_direct_r'`);
  const again = await raw(`select candidate_code from candidates where id = 'cand_direct_r'`);
  assert.equal(again.rows[0].candidate_code, rows[0].candidate_code, 'the Candidate ID changed');
  const dupes = await raw(`select candidate_code, count(*) from candidates group by 1 having count(*) > 1`);
  assert.equal(dupes.rows.length, 0, 'duplicate Candidate IDs');
  const missing = await raw(`select count(*)::int as n from candidates where candidate_code is null`);
  assert.equal(missing.rows[0].n, 0);
});

test('recruiters see the Candidate ID next to the internal id', async () => {
  const c = await register();
  await c.post('/api/applications', { jobId: 'jR1' });
  const r = await REC.get('/api/candidates/' + encodeURIComponent(c.id));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.candidate.candidateCode, c.code);
  assert.equal(r.body.candidate.id, c.id);
});

/* ------------------------------------------------------------------ *
 * duplicates and validation
 * ------------------------------------------------------------------ */
test('duplicate email and duplicate mobile are refused with the owner\'s words', async () => {
  const first = await register();
  const sameEmail = await register({ email: first.email.toUpperCase() });
  assert.equal(sameEmail.res.status, 409);
  assert.equal(sameEmail.res.body.error.code, 'EMAIL_TAKEN');
  assert.equal(sameEmail.res.body.error.message, 'An account with this email already exists. Please Login.');
  assert.ok(sameEmail.res.body.error.details.email);

  const p = phone();
  const owner = await register({ phone: p });
  assert.equal(owner.res.status, 201);
  const samePhone = await register({ phone: `+91 ${p.slice(0, 5)} ${p.slice(5)}` });
  assert.equal(samePhone.res.status, 409);
  assert.equal(samePhone.res.body.error.code, 'PHONE_TAKEN');
  assert.equal(samePhone.res.body.error.message, 'An account with this mobile number already exists.');
  const zero = await register({ phone: '0' + p });
  assert.equal(zero.res.status, 409, 'a leading 0 is the same phone');

  /* A record a recruiter typed in has no account; the person may still register. */
  const typed = phone();
  await raw(`insert into candidates (id, name, email, phone) values ('cand_typed_r2', 'Typed', 'typed2@tl-sink.local', $1)`, [typed]);
  const self = await register({ phone: typed });
  assert.equal(self.res.status, 201, JSON.stringify(self.res.body));
});

test('mobile format, confirm password and a weak password are checked on the server', async () => {
  const bad = await register({ phone: '12345' });
  assert.equal(bad.res.status, 400);
  assert.match(bad.res.body.error.details.phone, /valid 10-digit mobile/);

  const mismatch = await register({ confirmPassword: 'Different9pass' });
  assert.equal(mismatch.res.status, 400);
  assert.equal(mismatch.res.body.error.details.confirmPassword, 'Passwords do not match.');

  const weak = await register({ password: 'password', confirmPassword: 'password' });
  assert.equal(weak.res.status, 400);
  assert.ok(weak.res.body.error.details.password);

  const ok = await register({ confirmPassword: 'Regist3r9pass' });
  assert.equal(ok.res.status, 201);

  const bot = await register({ website: 'http://spam.example' });
  assert.equal(bot.res.status, 400, 'the honeypot field was accepted');
});

test('the inline duplicate check answers yes/no only, and is rate limited', async () => {
  const known = await register();
  const anon = makeClient(base);
  const r = await anon.post('/api/auth/register/check', { email: known.email, phone: '9999999999' });
  assert.equal(r.status, 200);
  assert.equal(r.body.emailTaken, true);
  assert.equal(r.body.messages.email, 'An account with this email already exists. Please Login.');
  assert.equal(Object.keys(r.body).sort().join(','), 'emailTaken,messages,phoneTaken', 'it must not say whose account');
  const free = await anon.post('/api/auth/register/check', { email: email('free') });
  assert.equal(free.body.emailTaken, false);

  process.env.REGISTER_CHECK_MAX = '1';
  const limited = await anon.post('/api/auth/register/check', { email: email('free2') });
  assert.equal(limited.status, 429);
  delete process.env.REGISTER_CHECK_MAX;
});

/* ------------------------------------------------------------------ *
 * consent
 * ------------------------------------------------------------------ */
test('consent is stored with its date, version and status', async () => {
  const c = await register();
  const rows = (await raw(`select kind, status, version, policy_url, created_at from candidate_consents
                            where candidate_id = $1 order by kind`, [c.id])).rows;
  assert.deepEqual(rows.map((x) => x.kind), ['communication', 'resume_processing', 'terms']);
  for (const x of rows) {
    assert.equal(x.status, 'granted');
    assert.equal(x.version, 'tc-2026-10-test');
    assert.equal(x.policy_url, 'https://teamlink.example/privacy');
    assert.ok(x.created_at instanceof Date);
  }
  const p = await c.get('/api/me/privacy');
  assert.equal(p.status, 200);
  assert.equal(p.body.consents.length, 3);
  assert.equal(p.body.policy.url, 'https://teamlink.example/privacy');

  const s = await c.get('/api/registration/settings');
  assert.equal(s.body.consentVersion, 'tc-2026-10-test');

  /* Withdrawing communication consent is a new row; the old one stays. */
  const w = await c.post('/api/me/consents', { kind: 'communication', status: 'withdrawn' });
  assert.equal(w.status, 200);
  const cur = (await raw(`select status from candidate_consent_current where candidate_id = $1 and kind = 'communication'`, [c.id])).rows[0];
  assert.equal(cur.status, 'withdrawn');
  const all = (await raw(`select count(*)::int as n from candidate_consents where candidate_id = $1 and kind = 'communication'`, [c.id])).rows[0];
  assert.equal(all.n, 2);
});

test('Terms are required; recruitment communication is optional (declining it is recorded, not refused)', async () => {
  const noTerms = await register({ consent: { terms: false, communication: true } });
  assert.equal(noTerms.res.status, 400);
  assert.ok(noTerms.res.body.error.details['consent.terms']);

  const decline = await register({ consent: { terms: true, communication: false } });
  assert.equal(decline.res.status, 201, JSON.stringify(decline.res.body));
  const rows = (await raw(`select kind, status from candidate_consents where candidate_id = $1 order by kind, id`, [decline.id])).rows;
  assert.ok(rows.some((r) => r.kind === 'terms' && r.status === 'granted'));
  assert.ok(!rows.some((r) => r.kind === 'communication' && r.status === 'granted'), 'declined communication must not be recorded as granted');

  process.env.REGISTRATION_CONSENT_REQUIRED = 'true';
  const missing = await register({ consent: undefined });
  assert.equal(missing.res.status, 400);
  assert.ok(missing.res.body.error.details['consent.terms']);
  assert.ok(!missing.res.body.error.details['consent.communication'], 'communication is never required');
  const ok = await register();
  assert.equal(ok.res.status, 201);
  process.env.REGISTRATION_CONSENT_REQUIRED = '';
});

/* ------------------------------------------------------------------ *
 * welcome + reminder
 * ------------------------------------------------------------------ */
test('the welcome email carries the Candidate ID and is sent once', async () => {
  const c = await register();
  const got = await eventually(() => mailsTo(c.email).length > 0);
  assert.ok(got, 'no welcome email reached the provider');
  const mail = mailsTo(c.email)[0].body;
  assert.match(mail.subject, /Welcome to TeamLink/);
  assert.ok(String(mail.html).includes(c.code) && String(mail.text).includes(c.code), 'the Candidate ID is not in the email');
  assert.ok(!/Client/.test(mail.text), 'the word Client must not appear');
  const row = await eventually(async () => (await raw(
    `select status, attempts from candidate_registration_messages where candidate_id = $1 and kind = 'welcome'`, [c.id])).rows[0]);
  assert.equal(row.status, 'sent');

  const again = await msgs.sendRegistrationMessage(c.id, 'welcome');
  assert.equal(again.status, 'duplicate');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(mailsTo(c.email).length, 1, 'the welcome went twice');
});

test('no welcome to do-not-contact or an opted-out address - and the reason is recorded', async () => {
  const quiet = await register();
  await settled(quiet.id);           // the queued welcome has run; start again from nothing
  await raw(`update candidates set do_not_contact = true where id = $1`, [quiet.id]);
  await raw(`delete from candidate_registration_messages where candidate_id = $1`, [quiet.id]);
  const before = mailsTo(quiet.email).length;
  const s = await msgs.sendRegistrationMessage(quiet.id, 'welcome');
  assert.equal(s.status, 'skipped_do_not_contact');
  assert.equal(mailsTo(quiet.email).length, before);

  const off = await register();
  await settled(off.id);
  await raw(`update candidates set email_opt_in = false where id = $1`, [off.id]);
  await raw(`delete from candidate_registration_messages where candidate_id = $1`, [off.id]);
  const before2 = mailsTo(off.email).length;
  assert.equal((await msgs.sendRegistrationMessage(off.id, 'welcome')).status, 'skipped_opted_out');
  assert.equal(mailsTo(off.email).length, before2);
});

test('one profile reminder, later, only for a thin profile registered through this flow', async () => {
  const thin = await register();
  await settled(thin.id);
  /* An older candidate, never welcomed: must never be written to. */
  await raw(`insert into users (email, password_hash, role) values ('legacy.reg@mailbox-teamlink-tests.in','x','candidate')`);
  await raw(`insert into candidates (id, user_id, name, email, created_at)
             select 'cand_legacy_r', id, 'Legacy', email, now() - interval '5 days' from users where email = 'legacy.reg@mailbox-teamlink-tests.in'`);

  /* Too soon: nothing. */
  let out = await msgs.runRegistrationSweep();
  assert.equal(mailsTo(thin.email).filter((m) => /few details/i.test(m.body.subject)).length, 0, 'reminded too soon');

  await raw(`update candidates set created_at = now() - interval '3 days' where id = $1`, [thin.id]);
  out = await msgs.runRegistrationSweep();
  assert.ok(out.reminded >= 1, JSON.stringify(out));
  const rem = mailsTo(thin.email).filter((m) => /few details/i.test(m.body.subject));
  assert.equal(rem.length, 1);
  assert.ok(String(rem[0].body.text).includes(thin.code));
  await msgs.runRegistrationSweep();
  assert.equal(mailsTo(thin.email).filter((m) => /few details/i.test(m.body.subject)).length, 1, 'reminded twice');
  assert.equal(mailsTo('legacy.reg@mailbox-teamlink-tests.in').length, 0, 'an existing candidate was written to');
});

/* ------------------------------------------------------------------ *
 * abuse limits
 * ------------------------------------------------------------------ */
test('repeated refused sign-ups from one origin are made to wait', async () => {
  const first = await register();
  await register({ email: first.email });             // a refusal, counted
  process.env.REGISTER_FAILURE_MAX = '1';
  const blocked = await register();
  assert.equal(blocked.res.status, 429);
  assert.match(blocked.res.body.error.message, /unsuccessful sign-up attempts/);
  delete process.env.REGISTER_FAILURE_MAX;
  process.env.REGISTER_FAILURE_MAX = '100000';
});

test('wrong passwords for one account lock that account for a while, not anybody else', async () => {
  const c = await register();
  const d = await register();
  process.env.LOGIN_ACCOUNT_LOCK_MAX = '3';
  const anon = makeClient(base);
  for (let i = 0; i < 3; i++) {
    const r = await anon.post('/api/auth/login', { email: c.email, password: 'wrong-password-' + i });
    assert.equal(r.status, 401);
  }
  const locked = await anon.post('/api/auth/login', { email: c.email, password: c.password });
  assert.equal(locked.status, 429);
  assert.match(locked.body.error.message, /temporarily locked/);
  const other = await anon.post('/api/auth/login', { email: d.email, password: d.password });
  assert.equal(other.status, 200, 'another account was locked too');
  delete process.env.LOGIN_ACCOUNT_LOCK_MAX;
});

/* ------------------------------------------------------------------ *
 * the profile fields the form adds
 * ------------------------------------------------------------------ */
test('the registration\'s extra fields save onto the profile', async () => {
  const c = await register();
  const r = await c.put('/api/candidates/' + c.id, {
    firstName: 'Reg', middleName: 'K', lastName: 'Person', dateOfBirth: '1998-04-12',
    whatsappNumber: '9876500011', altEmail: 'alt@mailbox-teamlink-tests.in', city: 'Hyderabad',
    state: 'Telangana', country: 'India', relevantExpYears: 2, ctc: '3.5',
    preferredEmploymentTypes: ['Full Time', 'Contract'], emailOptIn: true, smsOptIn: false,
    preferredContactMethod: 'email,whatsapp', preferredRole: 'Store Manager', willingToRelocate: true,
    educationRecords: [{ qualification: 'B.Tech', specialization: 'Mechanical', institution: 'JNTU', passingYear: 2020, score: '7.9 CGPA' },
      { qualification: '10th', score: '88%' }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const k = r.body.candidate;
  assert.equal(k.firstName, 'Reg');
  assert.equal(k.whatsappNumber, '9876500011');
  assert.equal(k.city, 'Hyderabad');
  assert.equal(k.country, 'India');
  assert.deepEqual(k.preferredEmploymentTypes, ['Full Time', 'Contract']);
  assert.equal(k.smsOptIn, false);
  assert.match(String(k.dateOfBirth), /^1998-04-1[12]/);
  const rows = (await raw(`select qualification, score from candidate_education where candidate_id = $1 order by sort_order`, [c.id])).rows;
  assert.equal(rows.length, 2);
  const badAlt = await c.put('/api/candidates/' + c.id, { altEmail: 'not-an-email' });
  assert.equal(badAlt.status, 400);
});

/* ------------------------------------------------------------------ *
 * documents (§34)
 * ------------------------------------------------------------------ */
test('documents: upload, list, download, replace and delete, by the owner', async () => {
  const c = await register();
  const up = await c.post(`/api/candidates/${c.id}/documents`, form('document', PDF('cert one'), 'Cert_One.pdf', { kind: 'certificate' }));
  assert.equal(up.status, 201, JSON.stringify(up.body));
  const id = up.body.document.id;
  assert.equal(up.body.document.fileName, 'Cert_One.pdf');

  const list = await c.get(`/api/candidates/${c.id}/documents`);
  assert.ok(list.body.documents.some((d) => d.id === id && d.kind === 'certificate'));

  const dl = await fetch(`${base}/api/candidates/${c.id}/documents/${id}/download`, {
    headers: { cookie: [...c.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ') } });
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get('content-disposition'), /attachment/);
  assert.equal(dl.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(Buffer.from(await dl.arrayBuffer()).toString('latin1').includes('cert one'));

  const rep = await c.put(`/api/candidates/${c.id}/documents/${id}`, form('document', PDF('cert two'), 'Cert_Two.pdf'));
  assert.equal(rep.status, 200, JSON.stringify(rep.body));
  assert.equal(rep.body.document.id, id, 'replace made a new document');
  assert.equal(rep.body.document.fileName, 'Cert_Two.pdf');
  const dl2 = await fetch(`${base}/api/candidates/${c.id}/documents/${id}/download`, {
    headers: { cookie: [...c.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ') } });
  assert.ok(Buffer.from(await dl2.arrayBuffer()).toString('latin1').includes('cert two'));

  const del = await c.del(`/api/candidates/${c.id}/documents/${id}`);
  assert.equal(del.status, 200);
  const gone = await c.get(`/api/candidates/${c.id}/documents/${id}/download`);
  assert.equal(gone.status, 404);
});

test('documents: type, MIME (magic bytes) and size are checked on the server', async () => {
  const c = await register();
  const exe = await c.post(`/api/candidates/${c.id}/documents`, form('document', EXE, 'marks.pdf', { kind: 'marksheet' }));
  assert.equal(exe.status, 415, 'an executable named .pdf was accepted');
  const txt = await c.post(`/api/candidates/${c.id}/documents`, form('document', Buffer.from('plain text here, nothing else'), 'marks.txt', { kind: 'marksheet' }));
  assert.equal(txt.status, 415, 'a text file is not a marksheet');
  const lie = await c.post(`/api/candidates/${c.id}/documents`, form('document', PNG, 'letter.pdf', { kind: 'experience_letter' }));
  assert.equal(lie.status, 415, 'a PNG named .pdf was accepted');
  const pdfPhoto = await c.post(`/api/candidates/${c.id}/documents`, form('document', PDF('x'), 'me.pdf', { kind: 'photo' }));
  assert.equal(pdfPhoto.status, 415, 'a PDF is not a photo');
  const photo = await c.post(`/api/candidates/${c.id}/documents`, form('document', PNG, 'me.png', { kind: 'photo' }));
  assert.equal(photo.status, 201, JSON.stringify(photo.body));
  const me = await c.get('/api/auth/me');
  assert.equal(me.body.profile.photoFile, 'me.png');
  const unknown = await c.post(`/api/candidates/${c.id}/documents`, form('document', PDF('x'), 'x.pdf', { kind: 'passport' }));
  assert.equal(unknown.status, 400);

  process.env.DOCUMENT_MAX_BYTES = '2048';
  const big = await c.post(`/api/candidates/${c.id}/documents`, form('document', PDF('y'.repeat(4000)), 'big.pdf', { kind: 'certificate' }));
  assert.equal(big.status, 413);
  delete process.env.DOCUMENT_MAX_BYTES;
});

/*
 * "Authorised recruiter" is the candidate record's own rule (0091): the
 * shared database lets every recruiter read a NON-private candidate, as it
 * does their resume; a PRIVATE candidate is readable only by their own
 * recruiter (owner, or one whose requirement they are in). Documents follow
 * the record, so they can never be more visible than the person is.
 */
test('documents: another candidate and an unrelated recruiter cannot read them; the authorised recruiter and admin can', async () => {
  const owner = await register();
  await raw(`update candidates set is_private = true where id = $1`, [owner.id]);
  const other = await register();
  const up = await owner.post(`/api/candidates/${owner.id}/documents`, form('document', PDF('private letter'), 'Cover.pdf', { kind: 'cover_letter' }));
  assert.equal(up.status, 201);
  const id = up.body.document.id;
  const path = `/api/candidates/${owner.id}/documents/${id}/download`;

  assert.equal((await other.get(path)).status, 403);
  assert.equal((await other.del(`/api/candidates/${owner.id}/documents/${id}`)).status, 403);
  const anon = makeClient(base);
  assert.equal((await anon.get(path)).status, 401);

  assert.equal((await ADMIN.get(path)).status, 200);
  /* Rekha's job; Ramu has nothing to do with this person. */
  await owner.post('/api/applications', { jobId: 'jR1' });
  assert.equal((await REC.get(path)).status, 200, 'the recruiter whose job they applied to cannot read it');
  const r2 = await REC2.get(path);
  assert.ok([403, 404].includes(r2.status), 'an unrelated recruiter read it: ' + r2.status);
});

test('the candidate can remove their resume; a recruiter cannot', async () => {
  const c = await register();
  const up = await c.post('/api/uploads/resume', form('resume', Buffer.from('Reg Person\nSkills: Excel, Tally\nHyderabad\n'), 'Resume_Reg.txt'));
  assert.equal(up.status, 201, JSON.stringify(up.body));
  await c.post('/api/applications', { jobId: 'jR1' });
  assert.equal((await REC.del(`/api/candidates/${c.id}/resume`)).status, 403);
  const del = await c.del(`/api/candidates/${c.id}/resume`);
  assert.equal(del.status, 200);
  const me = await c.get('/api/auth/me');
  assert.equal(me.body.profile.resumeFile, '');
});

/* ------------------------------------------------------------------ *
 * privacy (§40)
 * ------------------------------------------------------------------ */
test('Download My Data: the candidate\'s own data, nothing about anybody else, no staff notes', async () => {
  const c = await register();
  const other = await register();
  await c.post(`/api/candidates/${c.id}/documents`, form('document', PDF('cert'), 'Cert.pdf', { kind: 'certificate' }));
  await c.post('/api/applications', { jobId: 'jR1' });
  await raw(`update candidates set recruiter_notes = 'SECRET-NOTE-XYZ', internal_remarks = 'INTERNAL-ABC' where id = $1`, [c.id]);
  await raw(`insert into candidate_comments (candidate_id, recruiter_id, body) values ($1, 'rR1', 'COMMENT-PQR')`, [c.id]);

  const r = await fetch(`${base}/api/me/data-export`, {
    headers: { cookie: [...c.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ') } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /attachment; filename="teamlink-my-data-TL-CAN-\d{6}\.json"/);
  const text = await r.text();
  const data = JSON.parse(text);
  assert.equal(data.profile.candidate_code, c.code);
  assert.equal(data.profile.email, c.email);
  assert.equal(data.documents.length, 1);
  assert.equal(data.applications.length, 1);
  assert.ok(data.applications[0].reference && data.applications[0].status);
  assert.equal(data.consents.length, 3);
  for (const secret of ['SECRET-NOTE-XYZ', 'INTERNAL-ABC', 'COMMENT-PQR', other.email, 'recruiter_notes', 'match_score', 'ai_interview_score']) {
    assert.ok(!text.includes(secret), `the export contains ${secret}`);
  }
  assert.ok(data.notIncluded.length >= 3);
  assert.equal((await ADMIN.get('/api/me/data-export')).status, 403, 'staff have no "my data" here');
});

test('Request Account Deletion: recorded, one open at a time, admin processes, nothing hard-deleted', async () => {
  const c = await register();
  const r1 = await c.post('/api/me/deletion-request', { reason: 'Got a job' });
  assert.equal(r1.status, 201, JSON.stringify(r1.body));
  assert.equal(r1.body.request.status, 'pending');
  assert.equal((await c.post('/api/me/deletion-request', {})).status, 409);
  assert.equal((await c.post('/api/me/deletion-request/cancel', {})).status, 200);
  const r2 = await c.post('/api/me/deletion-request', { reason: 'Please remove me' });
  assert.equal(r2.status, 201);

  const other = await register();
  assert.equal((await other.get('/api/admin/deletion-requests')).status, 403);
  const list = await ADMIN.get('/api/admin/deletion-requests');
  const mine = list.body.requests.find((x) => x.id === r2.body.request.id);
  assert.ok(mine, 'the admin cannot see the request');
  assert.equal(mine.candidateCode, c.code);
  assert.equal(mine.status, 'pending');

  assert.equal((await ADMIN.post(`/api/admin/deletion-requests/${mine.id}`, { status: 'in_review' })).status, 200);
  const done = await ADMIN.post(`/api/admin/deletion-requests/${mine.id}`, { status: 'completed', note: 'Login closed', deactivate: true });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.request.deactivated, true);

  const still = await raw(`select do_not_contact from candidates where id = $1`, [c.id]);
  assert.equal(still.rows.length, 1, 'the candidate was hard-deleted');
  assert.equal(still.rows[0].do_not_contact, true);
  const login = await makeClient(base).post('/api/auth/login', { email: c.email, password: c.password });
  assert.equal(login.status, 403, 'a deactivated login still signs in');
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
