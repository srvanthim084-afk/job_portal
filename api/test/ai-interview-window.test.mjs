/**
 * The AI interview is open as long as the JOB is (0133).
 *
 *   - a job with no date: no deadline, the interview can be taken at any time while the job is open
 *   - a job with a last date: the interview's date IS that date, and moves when the recruiter moves it
 *   - the job closed, its last date passed: the interview closes by itself - the start is refused with
 *     the owner's words, and the candidate's application says so
 *   - on the job's last day, a candidate who applied and has not taken it gets ONE "closes today" email
 *   - the dashboard's "Upcoming interviews" counts the AI interviews still open, not only scheduled ones
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestDb, applyTestEnv, makeClient, startMockProvider } from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DB_PORT = 5589;
const API_PORT = 9945;
const MOCK_PORT = 9885;
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
    STORAGE_LOCAL_DIR: resolve(HERE, '../var/test-uploads-window'),
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

test('a job with NO date: no deadline - the interview can be taken at any time while the job is open', async () => {
  const c = await candidate();
  const appId = await apply(c, await job('j_nodate'));
  assert.equal(await due(appId), null, 'no made-up 48-hour deadline');
  const w = await win(appId);
  assert.deepEqual([w.open, w.reason], [true, null]);
  const s = await c.post('/api/ai-interviews/session', { applicationId: appId });
  assert.ok(s.status === 200 || s.status === 201, JSON.stringify(s.body));
  assert.ok(s.body.interviewId);
});

test('a job WITH a last date: the interview\'s date is that date, and moves when the job\'s does', async () => {
  const c = await candidate();
  const appId = await apply(c, await job('j_dated', { expires: "now() + interval '5 days'" }));
  const jobExp = (await raw(`select expires_at from jobs where id='j_dated'`)).rows[0].expires_at;
  assert.equal(new Date(await due(appId)).getTime(), new Date(jobExp).getTime());
  await raw(`update jobs set expires_at = now() + interval '9 days' where id='j_dated'`);
  const moved = (await raw(`select expires_at from jobs where id='j_dated'`)).rows[0].expires_at;
  assert.equal(new Date(await due(appId)).getTime(), new Date(moved).getTime(), 'the recruiter extended the job; the interview follows');
});

test('closed job, or last date passed: the interview closes by itself, in the owner\'s words', async () => {
  const c = await candidate();
  const closedApp = await apply(c, await job('j_close'));
  const expiredApp = await apply(c, await job('j_expire', { expires: "now() + interval '2 days'" }));
  await raw(`update jobs set status = 'closed' where id = 'j_close'`);
  await raw(`update jobs set expires_at = now() - interval '1 hour' where id = 'j_expire'`);

  assert.deepEqual(Object.values(await win(closedApp)).slice(0, 2), [false, 'job_closed']);
  assert.deepEqual(Object.values(await win(expiredApp)).slice(0, 2), [false, 'job_expired']);

  for (const appId of [closedApp, expiredApp]) {
    const s = await c.post('/api/ai-interviews/session', { applicationId: appId });
    assert.equal(s.status, 410, JSON.stringify(s.body));
    assert.equal(s.body.error.code, 'INTERVIEW_CLOSED');
    assert.equal(s.body.error.message, CLOSED);
  }
  /* and the database refuses it too, for anyone calling the function directly */
  await assert.rejects(raw(`select ai_interview_start('aiv_x', $1, $2, 'j_close', 'h', '[{"seq":1,"question":"q"}]'::jsonb, 48)`, [closedApp, c.id]),
    /AI_INTERVIEW_CLOSED/);

  /* the candidate's own applications say which are closed, and why */
  const boot = await c.get('/api/bootstrap');
  const mine = (boot.body.data.applications || []).filter((a) => a.candidateId === c.id);
  const byId = Object.fromEntries(mine.map((a) => [a.id, a]));
  assert.equal(byId[closedApp].aiInterviewOpen, false);
  assert.equal(byId[closedApp].aiInterviewClosedReason, 'job_closed');
  assert.equal(byId[expiredApp].aiInterviewClosedReason, 'job_expired');
});

test('the job\'s last day: ONE "closes today" email to whoever applied and has not taken it', async () => {
  const c = await candidate();
  /* closes at the end of today in India */
  const appId = await apply(c, await job('j_today', {
    expires: "(((now() at time zone 'Asia/Kolkata')::date + time '23:59') at time zone 'Asia/Kolkata')",
  }));
  const owed = (await raw(`select * from ai_interview_due_queue() where application_id = $1`, [appId])).rows;
  assert.equal(owed.length, 1);
  assert.equal(owed[0].kind, 'closing_today');

  const { sweepInterviewDeadlines } = await import('../src/notify/interview-deadline.js');
  const before = mock.received.length;
  const r1 = await sweepInterviewDeadlines();
  assert.ok((r1.kinds.closing_today || 0) >= 1, JSON.stringify(r1));
  const mails = mock.received.slice(before).filter((m) => m.url === '/email' && JSON.stringify(m.body).includes('closes today'));
  assert.equal(mails.length, 1, 'one email');
  const body = JSON.stringify(mails[0].body);
  assert.match(body, /j_today/, 'it names the Job ID');
  assert.match(body, /attend the interview before it closes/);

  const r2 = await sweepInterviewDeadlines();
  assert.equal(r2.kinds.closing_today || 0, 0, 'never twice');
});

test('"Upcoming interviews" counts the AI interviews still open to take', async () => {
  const c = await candidate();
  await apply(c, await job('j_cnt1'));
  await apply(c, await job('j_cnt2', { expires: "now() + interval '3 days'" }));
  const shut = await apply(c, await job('j_cnt3'));
  await raw(`update jobs set status = 'closed' where id = 'j_cnt3'`);
  const d = await c.get('/api/candidate/dashboard');
  assert.equal(d.status, 200, JSON.stringify(d.body));
  assert.equal(d.body.counts.aiInterviews, 2, 'two open, one closed');
  assert.equal(d.body.counts.interviews, 2, 'nothing scheduled, so the open AI interviews are the upcoming ones');
  assert.ok(shut);
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
