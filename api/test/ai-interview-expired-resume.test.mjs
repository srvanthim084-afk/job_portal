/**
 * "No deadline - Attend any time" must mean it (0138).
 *
 * An attempt, once started, has its own 48 hours. One that ran out while the JOB is still open is
 * reopened where the candidate left it - same interview, same questions, a fresh attempt window -
 * instead of "This interview has passed its deadline". A closed job keeps it shut, in the job-closed words.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestDb, applyTestEnv, makeClient, startMockProvider } from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DB_PORT = 5599;
const API_PORT = 9957;
const MOCK_PORT = 9889;
const base = `http://127.0.0.1:${API_PORT}`;
const PW = 'Window123interview';
const CLOSED = 'You applied for this job, but the date is over, so you cannot attend the interview now.';

let dbh, server, raw, mock, rec;
let seq = 0;

async function staff(email, role, table, id, company) {
  const { hashPassword } = await import('../src/auth.js');
  const hash = await hashPassword(PW);
  const u = (await raw(`insert into users (email,password_hash,role) values ($1,$2,$3) returning id`, [email, hash, role])).rows[0].id;
  await raw(`insert into ${table} (id, user_id, name, email, company_id) values ($1,$2,$3,$4,$5)`, [id, u, `${role} ${id}`, email, company]);
  const c = makeClient(base);
  await c.get('/api/health');
  const r = await c.post('/api/auth/login', { email, password: PW, role });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return c;
}

async function candidate() {
  seq += 1;
  const c = makeClient(base);
  await c.get('/api/health');
  const r = await c.post('/api/auth/register', {
    name: `Window Person ${seq}`, email: `window.${seq}.${Date.now().toString(36)}@mailbox-teamlink-tests.in`,
    password: PW, phone: '93000' + String(10000 + seq).slice(-5), preferredLocation: 'Hyderabad', expectedCtc: 4,
    noticePeriod: 'Immediate', preferredWorkModes: ['Hybrid'],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  c.id = r.body.candidateId;
  c.email = r.body.email || null;
  return c;
}

async function job(id, { expires = null } = {}) {
  await raw(`insert into jobs (id, title, company_id, location, mode, exp_label, skills, status, recruiter_id, description, published_at, expires_at)
             values ($1, $2, 'co_w', 'Hyderabad', 'Onsite', '1-3 yrs', $3, 'open', 'r_w1', 'Hire well.', now(), ${expires || 'null'})`,
    [id, `Role ${id}`, ['Sourcing', 'Excel']]);
  return id;
}

async function apply(c, jobId) {
  const r = await c.post('/api/applications', { jobId });
  assert.ok(r.status === 201 || r.status === 200, JSON.stringify(r.body));
  return r.body.application.id;
}

const win = async (appId) => (await raw(`select * from ai_interview_window($1)`, [appId])).rows[0];
const due = async (appId) => (await raw(`select ai_interview_due_at from applications where id=$1`, [appId])).rows[0].ai_interview_due_at;

test('boot', async () => {
  dbh = await startTestDb(DB_PORT);
  mock = await startMockProvider(MOCK_PORT);
  applyTestEnv(dbh.url, {
    PUBLIC_ORIGIN: base,
    DISABLE_BACKGROUND_WORK: 'true',
    AI_API_KEY: '',
    STORAGE_LOCAL_DIR: resolve(HERE, '../var/test-uploads-ivresume'),
    EMAIL_API_KEY: 'test-key', EMAIL_FROM: 'noreply@teamlink.example', EMAIL_API_URL: `http://127.0.0.1:${MOCK_PORT}/email`,
    EMAIL_SMTP_HOST: '', EMAIL_SMTP_USER: '', EMAIL_SMTP_PASS: '',
    EMAILJS_SERVICE_ID: '', EMAILJS_TEMPLATE_ID: '', EMAILJS_PUBLIC_KEY: '', EMAILJS_PRIVATE_KEY: '',
    SMS_API_KEY: '', WHATSAPP_API_KEY: '', OUTBOUND_ALLOWLIST: '',
    INTERVIEW_STT_PROVIDER: '', INTERVIEW_TTS_PROVIDER: '',
  });
  raw = (sql, params) => dbh.db.query(sql, params);
  await raw(`insert into companies (id, name) values ('co_w', 'Window Co')`);
  const { createApp } = await import('../src/app.js');
  const app = createApp({ logger: { error() {}, log() {} } });
  await new Promise((r) => { server = app.listen(API_PORT, r); });
  rec = await staff('rec.w@tl-sink.local', 'recruiter', 'recruiters', 'r_w1', 'co_w');
});

const ivRow = async (id) => (await raw(`select status, expires_at, attempt_number from ai_interviews where id=$1`, [id])).rows[0];

test('an attempt that ran out of its own time, on a job with no date: reopened where it was left', async () => {
  const c = await candidate();
  const appId = await apply(c, await job('j_open_nodate'));
  const s = await c.post('/api/ai-interviews/session', { applicationId: appId });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  const id = s.body.interviewId;
  const firstQ = s.body.questions.map((q) => q.question);
  /* answer one, then let the attempt's own 48 hours run out */
  await c.post(`/api/ai-interviews/${id}/question-start`, { seq: 1, part: 'main' });
  const a = await c.post(`/api/ai-interviews/${id}/answer`, { seq: 1, part: 'main', transcript: 'I have two years of sourcing for IT roles.', answered: true });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  await raw(`update ai_interviews set expires_at = now() - interval '1 hour' where id=$1`, [id]);
  await raw(`select ai_interview_expire_overdue()`);
  assert.equal((await ivRow(id)).status, 'expired');

  const again = await c.post('/api/ai-interviews/session', { applicationId: appId });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.interviewId, id, 'the SAME interview, not a new one');
  assert.equal(again.body.resumed, true);
  assert.deepEqual(again.body.questions.map((q) => q.question), firstQ, 'the same questions - nothing to gain by letting it expire');
  const at = again.body.resumeAt;
  assert.ok(at && !(at.seq === 1 && at.part === 'main'), `carries on after the answer already given (${JSON.stringify(at)})`);
  const row = await ivRow(id);
  assert.equal(row.status, 'in_progress');
  assert.ok(new Date(row.expires_at) > new Date(Date.now() + 47 * 3600 * 1000), 'a fresh attempt window');
  assert.equal((await raw(`select count(*)::int n from ai_interviews where application_id=$1`, [appId])).rows[0].n, 1);
  const audit = (await raw(`select count(*)::int n from ai_interview_audit where interview_id=$1 and action='interview.reopened_after_attempt_expiry'`, [id])).rows[0].n;
  assert.equal(audit, 1);
  /* and answering works again */
  await c.post(`/api/ai-interviews/${id}/question-start`, { seq: at.seq, part: at.part });
  const next = await c.post(`/api/ai-interviews/${id}/answer`, { seq: at.seq, part: at.part, transcript: 'I screen CVs daily against the job description.', answered: true });
  assert.equal(next.status, 200, JSON.stringify(next.body));
});

test('a job with a date: the reopened attempt never runs past the job\'s own date', async () => {
  const c = await candidate();
  const appId = await apply(c, await job('j_open_dated', { expires: "now() + interval '10 hours'" }));
  const s = await c.post('/api/ai-interviews/session', { applicationId: appId });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  await raw(`update ai_interviews set status='expired', expires_at = now() - interval '1 minute' where id=$1`, [s.body.interviewId]);
  const again = await c.post('/api/ai-interviews/session', { applicationId: appId });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  const jobExp = (await raw(`select expires_at from jobs where id='j_open_dated'`)).rows[0].expires_at;
  assert.ok(new Date((await ivRow(s.body.interviewId)).expires_at).getTime() <= new Date(jobExp).getTime() + 1000);
});

test('the job closed: an expired attempt stays shut, in the job-closed words', async () => {
  const c = await candidate();
  const appId = await apply(c, await job('j_shut'));
  const s = await c.post('/api/ai-interviews/session', { applicationId: appId });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  await raw(`update ai_interviews set status='expired', expires_at = now() - interval '1 minute' where id=$1`, [s.body.interviewId]);
  await raw(`update jobs set status='closed' where id='j_shut'`);
  const again = await c.post('/api/ai-interviews/session', { applicationId: appId });
  assert.equal(again.status, 410, JSON.stringify(again.body));
  assert.equal(again.body.error.code, 'INTERVIEW_CLOSED');
  assert.equal(again.body.error.message, CLOSED);
  assert.equal((await ivRow(s.body.interviewId)).status, 'expired');
});

test('another candidate cannot reopen it', async () => {
  const c = await candidate();
  const other = await candidate();
  const appId = await apply(c, await job('j_mine'));
  const s = await c.post('/api/ai-interviews/session', { applicationId: appId });
  await raw(`update ai_interviews set status='expired', expires_at = now() - interval '1 minute' where id=$1`, [s.body.interviewId]);
  const ok = (await raw(`select ai_interview_resume_expired($1, $2, 48) as ok`, [s.body.interviewId, other.id])).rows[0].ok;
  assert.equal(ok, false);
  assert.equal((await ivRow(s.body.interviewId)).status, 'expired');
});

test('shutdown', async () => {
  await new Promise((r) => server.close(r));
  const { stopBackgroundWork } = await import('../src/app.js');
  stopBackgroundWork();
  const { closePool } = await import('../src/db.js');
  await closePool();
  await mock.stop();
  await dbh.stop();
});
