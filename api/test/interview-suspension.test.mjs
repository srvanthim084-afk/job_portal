/**
 * AI interview suspension, its reason, its email and the retake (0120),
 * against a real Postgres with RLS.
 *
 *   - a suspension stores a reason code, the one message, the question
 *     number and a retake time; the same message is on the candidate's
 *     response, the recruiter's list and the email
 *   - the email goes once, after the save, escaped, with no "rejected" /
 *     "failed" / "disqualified"; a retry or a duplicate never sends twice
 *   - the retake opens only after the wait, decided by the server: an early
 *     request is refused with the time; it is a NEW attempt row and the old
 *     one is kept
 *   - one retake by default; a second suspension leaves it with a recruiter
 *   - a recruiter can block, unblock and grant another attempt, with a reason
 *     and an audit entry; a candidate cannot
 *   - the page's own stops (tab left, camera, noise) reach the server
 *   - the "open again" email goes once
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb, applyTestEnv, makeClient } from './harness.mjs';

const DB_PORT = 5591;
const API_PORT = 9945;
const base = `http://127.0.0.1:${API_PORT}`;
const PW = 'Suspend123interview';

let dbh, server, raw, notice, policy, providers;
let recA, recB, candA, candB;
let jobId, appA, appB;
const sent = [];

async function staff(email, role, table, id, company) {
  const { hashPassword } = await import('../src/auth.js');
  const hash = await hashPassword(PW);
  const u = (await raw(`insert into users (email,password_hash,role) values ($1,$2,$3) returning id`,
    [email, hash, role])).rows[0].id;
  await raw(`insert into ${table} (id, user_id, name, email, company_id) values ($1,$2,$3,$4,$5)`,
    [id, u, `${role} ${id}`, email, company]);
  const c = makeClient(base);
  await c.get('/api/health');
  const r = await c.post('/api/auth/login', { email, password: PW, role });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return c;
}

async function candidate(name, email, phone) {
  const c = makeClient(base);
  await c.get('/api/health');
  const r = await c.post('/api/auth/register', {
    name, email, password: PW, phone, preferredLocation: 'Hyderabad', expectedCtc: 4,
    noticePeriod: 'Immediate', preferredWorkModes: ['Hybrid'],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  c.id = r.body.candidateId;
  return c;
}

const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));
const rows = async (appId) => (await raw(
  `select * from ai_interviews where application_id=$1 order by attempt_number`, [appId])).rows;
/** Make the retake time already past, as the clock would. */
const openRetake = (id) => raw(`update ai_interviews set retake_available_at = now() - interval '1 minute' where id=$1`, [id]);
const voice = (c, id, seq) => c.post(`/api/ai-interviews/${id}/integrity`, {
  type: 'additional_voice', confidence: 0.9, evidence: { questionSeq: seq, detector: 'browser' } });

test('boot', async () => {
  dbh = await startTestDb(DB_PORT);
  applyTestEnv(dbh.url, {
    PUBLIC_ORIGIN: base,
    DISABLE_BACKGROUND_WORK: 'true',
    AI_API_KEY: '',
    INTERVIEW_RETAKE_DELAY_MINUTES: '120', INTERVIEW_MAX_ATTEMPTS: '2',
    TEAMLINK_TIMEZONE: 'Asia/Kolkata', SUPPORT_EMAIL: 'support@tl-sink.local',
    EMAIL_API_KEY: '', EMAIL_SMTP_HOST: '', EMAIL_SMTP_USER: '', EMAIL_SMTP_PASS: '',
    EMAILJS_SERVICE_ID: '', EMAILJS_TEMPLATE_ID: '', EMAILJS_PUBLIC_KEY: '', EMAILJS_PRIVATE_KEY: '',
    SMS_API_KEY: '', WHATSAPP_API_KEY: '',
  });
  raw = (sql, params) => dbh.db.query(sql, params);
  await raw(`insert into companies (id, name) values ('co_sx', 'Suspend Co'), ('co_sy', 'Other Co')`);

  const { createApp } = await import('../src/app.js');
  notice = await import('../src/notify/interview-suspension.js');
  policy = await import('../src/interview/policy.js');
  ({ providers } = await import('../src/notify/providers.js'));
  providers.email.send = async (m) => { sent.push(m); return { status: 'sent', provider: 'test' }; };

  const app = createApp({ logger: { error() {}, log() {} } });
  await new Promise((r) => { server = app.listen(API_PORT, r); });

  recA = await staff('rec.sx@tl-sink.local', 'recruiter', 'recruiters', 'r_sx1', 'co_sx');
  recB = await staff('rec.sy@tl-sink.local', 'recruiter', 'recruiters', 'r_sx2', 'co_sy');

  jobId = 'j_sx1';
  await raw(`insert into jobs (id, title, company_id, location, mode, exp_label, skills, status, recruiter_id, description, published_at)
             values ($1, 'HR Recruiter', 'co_sx', 'Hyderabad', 'Onsite', '1-3 yrs', $2, 'open', 'r_sx1', $3, now())`,
    [jobId, ['Sourcing', 'ATS', 'Excel'], 'Own end-to-end hiring for client roles.']);
  candA = await candidate('Asha <b>Suspend</b>', 'asha.sx@tl-sink.local', '9400000001');
  candB = await candidate('Bharat Suspend', 'bharat.sx@tl-sink.local', '9400000002');
  appA = (await candA.post('/api/applications', { jobId })).body.application.id;
  appB = (await candB.post('/api/applications', { jobId })).body.application.id;
});

test('policy: the numbers come from the environment, the words never say rejected', () => {
  const p = policy.retakePolicy();
  assert.deepEqual(p, { delayMinutes: 120, maxAttempts: 2, deadlineHours: 48 });
  for (const code of policy.SUSPENSION_CODES) {
    assert.doesNotMatch(policy.stopMessage(code, 4), /reject|fail|disqualif/i, code);
  }
  assert.equal(policy.stopMessage('left_interview', 4), 'The interview window was not in front during your answer to Question 4.');
  // Shown in India time; compared in UTC.
  assert.match(policy.formatWhen(new Date('2026-10-10T09:00:00Z')), /10 Oct 2026, 2:30 pm/i);
});

let first;       // candidate A's first attempt
test('two confirmed detections suspend: reason, question, retake time, one sentence everywhere', async () => {
  const s = await candA.post('/api/ai-interviews/session', { applicationId: appA });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  first = s.body.interviewId;

  const w = await voice(candA, first, 3);
  assert.equal(w.body.action, 'warn');
  assert.equal(w.body.mayContinue, true);
  const x = await voice(candA, first, 3);
  assert.equal(x.body.action, 'suspend', JSON.stringify(x.body));
  assert.equal(x.body.message, 'Another voice was detected during your answer to Question 3.');
  assert.ok(x.body.retakeAvailableAt, 'a retake time is given');

  const r = (await rows(appA))[0];
  assert.equal(r.status, 'suspended');
  assert.equal(r.suspension_code, 'additional_voice');
  assert.equal(r.suspension_message, x.body.message);
  assert.equal(r.suspension_question_no, 3);
  assert.equal(r.detection_count, 2);
  assert.equal(r.attempt_number, 1);
  const mins = (new Date(r.retake_available_at) - new Date(r.suspended_at)) / 60000;
  assert.ok(mins > 119.9 && mins < 120.1, `retake after ${mins} minutes`);

  // a detector still firing after the suspension changes nothing
  const again = await voice(candA, first, 4);
  assert.equal(again.body.action, 'suspended');
  assert.equal((await rows(appA))[0].detection_count, 2);
});

test('the email: once, after the save, the same reason, escaped, no rejection words', async () => {
  await tick(300);
  const mails = sent.filter((m) => m.to === 'asha.sx@tl-sink.local' && /suspended/.test(m.subject));
  assert.equal(mails.length, 1, 'exactly one suspension email');
  const m = mails[0];
  assert.match(m.subject, /has been suspended/);
  assert.match(m.text, /Reason: Another voice was detected during your answer to Question 3\./);
  assert.match(m.text, /You can retake the interview for HR Recruiter after .*(am|pm)/);
  assert.match(m.text, /support@tl-sink\.local/);
  assert.doesNotMatch(m.text + m.html, /reject|failed|disqualif/i);
  assert.doesNotMatch(m.html, /<b>Suspend<\/b>/, 'a name with markup is escaped');
  assert.doesNotMatch(m.text + m.html, /confidence|threshold|0\.9|rms/i, 'no internal detail');

  // a duplicate or a retry sends nothing more
  assert.equal((await notice.sendSuspensionEmail(first)).status, 'duplicate');
  notice.afterSuspension(first);
  await tick(300);
  assert.equal(sent.filter((x) => x.to === 'asha.sx@tl-sink.local' && /suspended/.test(x.subject)).length, 1);
  assert.equal((await rows(appA))[0].suspension_email_status, 'sent');
});

test('an email that fails is retried by the sweep, never lost, never blocking', async () => {
  const s = await candB.post('/api/ai-interviews/session', { applicationId: appB });
  assert.equal(s.status, 201);
  const bFirst = s.body.interviewId;
  const before = sent.length;
  providers.email.send = async () => ({ status: 'failed', provider: 'test', error: 'smtp down' });
  /* the page's own detections warn first; the second suspends */
  const w = await candB.post(`/api/ai-interviews/${bFirst}/stop`, { kind: 'left_interview', questionSeq: 2 });
  assert.equal(w.body.action, 'warn', JSON.stringify(w.body));
  assert.equal(w.body.suspended, false);
  assert.equal((await rows(appB))[0].status, 'warning_issued', 'the interview carries on after a warning');
  const st = await candB.post(`/api/ai-interviews/${bFirst}/stop`, { kind: 'left_interview', questionSeq: 2 });
  assert.equal(st.status, 200, JSON.stringify(st.body));   // the suspension itself was not held up
  assert.equal(st.body.suspended, true);
  await tick(300);
  let r = (await rows(appB))[0];
  assert.equal(r.status, 'suspended');
  assert.equal(r.suspension_email_status, 'failed');
  assert.equal(sent.length, before);

  providers.email.send = async (m) => { sent.push(m); return { status: 'sent', provider: 'test' }; };
  await raw(`update ai_interviews set suspended_at = now() - interval '10 minutes' where id=$1`, [bFirst]);
  const out = await notice.runInterviewNoticeSweep();
  assert.equal(out.suspensionRetried, 1);
  assert.equal((await notice.runInterviewNoticeSweep()).suspensionRetried, 0, 'sent once the retry worked');
  assert.equal(sent.filter((m) => m.to === 'bharat.sx@tl-sink.local' && /suspended/.test(m.subject)).length, 1);
  r = (await rows(appB))[0];
  assert.equal(r.suspension_message, 'The interview window was not in front during your answer to Question 2.');
  assert.equal(r.suspension_code, 'left_interview');
});

test('the page\'s own stop is idempotent and only the candidate\'s own', async () => {
  const bFirst = (await rows(appB))[0].id;
  const again = await candB.post(`/api/ai-interviews/${bFirst}/stop`, { kind: 'background_noise', questionSeq: 5 });
  assert.equal(again.body.firstTime, false);
  assert.equal((await rows(appB))[0].suspension_code, 'left_interview', 'the first reason stands');
  assert.equal((await raw(`select count(*)::int n from ai_interview_audit where interview_id=$1 and action='interview.suspended'`, [bFirst])).rows[0].n, 1);
  assert.equal((await candA.post(`/api/ai-interviews/${bFirst}/stop`, { kind: 'camera_off' })).status, 404, 'not their interview');
  assert.equal((await recA.post(`/api/ai-interviews/${bFirst}/stop`, { kind: 'camera_off' })).status, 403);
  assert.equal((await candB.post(`/api/ai-interviews/${bFirst}/stop`, { kind: 'rejected' })).status, 400, 'unknown kind');
});

test('retake: refused early with the time, opens after the wait as a NEW attempt, the old one kept', async () => {
  const early = await candA.post('/api/ai-interviews/session', { applicationId: appA });
  assert.equal(early.status, 423, JSON.stringify(early.body));
  assert.equal(early.body.error.code, 'INTERVIEW_RETAKE_WAIT');
  assert.match(early.body.error.message, /You can retake this interview after .*(am|pm)/);
  assert.ok(early.body.error.details.retakeAvailableAt);
  assert.equal((await rows(appA)).length, 1, 'nothing was created');

  await openRetake(first);
  const ok = await candA.post('/api/ai-interviews/session', { applicationId: appA });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.notEqual(ok.body.interviewId, first, 'a new attempt');
  assert.equal(ok.body.questions[0].seq, 1, 'questions start again from Question 1');
  const all = await rows(appA);
  assert.deepEqual(all.map((r) => [r.attempt_number, r.status]), [[1, 'suspended'], [2, 'in_progress']]);
  assert.equal(all[0].suspension_message, 'Another voice was detected during your answer to Question 3.', 'the first attempt is untouched');
  assert.equal(all[1].integrity_strikes, 0, 'the retake starts clean');
});

let second;
test('a suspended retake is final by default: under recruiter review, no new retake time', async () => {
  second = (await rows(appA))[1].id;
  await candA.post(`/api/ai-interviews/${second}/stop`, { kind: 'camera_lost', questionSeq: 1 });   // warning
  const st = await candA.post(`/api/ai-interviews/${second}/stop`, { kind: 'camera_lost', questionSeq: 1 });
  assert.equal(st.body.suspended, true);
  assert.equal(st.body.retakeAvailableAt, null);
  const r = (await rows(appA))[1];
  assert.equal(r.suspension_code, 'camera_off');
  assert.equal(r.retake_available_at, null);

  const again = await candA.post('/api/ai-interviews/session', { applicationId: appA });
  assert.equal(again.status, 423);
  assert.equal(again.body.error.code, 'INTERVIEW_UNDER_REVIEW');
  assert.doesNotMatch(JSON.stringify(again.body), /reject|disqualif/i);

  // and the recruiter is told, not the candidate rejected
  await tick(300);
  const alerts = (await raw(`select distinct dedupe_key from ats_recruiter_alerts where kind='interview_retake_suspended'`)).rows;
  assert.equal(alerts.length, 1, 'the recruiter hears once about the suspended retake');
  assert.equal(alerts[0].dedupe_key, `${appA}:attempt2`);
});

test('recruiter: sees the reason and every attempt; the candidate cannot reach the controls', async () => {
  const list = await recA.get('/api/ai-interviews/integrity');
  assert.equal(list.status, 200, JSON.stringify(list.body));
  const mine = (list.body.interviews || list.body.items || list.body).filter((x) => x.id === second || x.id === first);
  assert.equal(mine.length, 2);
  const s2 = mine.find((x) => x.id === second);
  assert.equal(s2.suspensionMessage, 'Your camera was off for too long during Question 1.');
  assert.equal(s2.attemptNumber, 2);
  assert.equal(s2.display, 'Under Recruiter Review');

  const d = await recA.get(`/api/ai-interviews/${second}/integrity`);
  assert.equal(d.status, 200, JSON.stringify(d.body));
  assert.equal(d.body.attempts.length, 2);
  assert.equal(d.body.currentScore, null, 'a suspended attempt has no score');

  assert.equal((await candA.post(`/api/ai-interviews/${second}/retake`, { action: 'extra_attempt', reason: 'let me' })).status, 403);
  assert.equal((await recB.post(`/api/ai-interviews/${second}/retake`, { action: 'extra_attempt', reason: 'not mine' })).status, 404);
  assert.equal((await recA.post(`/api/ai-interviews/${second}/retake`, { action: 'extra_attempt', reason: '' })).status, 400, 'a reason is required');
});

test('recruiter grants one more attempt: audited, and the candidate can start it', async () => {
  const g = await recA.post(`/api/ai-interviews/${second}/retake`, { action: 'extra_attempt', reason: 'Candidate reported a power cut' });
  assert.equal(g.status, 200, JSON.stringify(g.body));
  const audit = (await raw(`select detail, actor_id from ai_interview_audit where interview_id=$1 and action='retake.extra_attempt'`, [second])).rows;
  assert.equal(audit.length, 1);
  assert.equal(audit[0].detail.reason, 'Candidate reported a power cut');
  assert.ok(audit[0].actor_id, 'who did it is recorded');
  const ok = await candA.post('/api/ai-interviews/session', { applicationId: appA });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal((await rows(appA)).length, 3);
  assert.equal((await rows(appA))[2].attempt_number, 3);
});

test('recruiter block beats the clock; unblock opens it, with the "open again" email sent once', async () => {
  const bFirst = (await rows(appB))[0].id;
  const b = await recA.post(`/api/ai-interviews/${bFirst}/retake`, { action: 'block', reason: 'Needs a call first' });
  assert.equal(b.status, 200, JSON.stringify(b.body));
  await openRetake(bFirst);
  const blocked = await candB.post('/api/ai-interviews/session', { applicationId: appB });
  assert.equal(blocked.status, 423);
  assert.equal(blocked.body.error.code, 'INTERVIEW_UNDER_REVIEW');
  assert.equal((await notice.runInterviewNoticeSweep()).retakeOpened, 0, 'no "open again" email while blocked');

  const u = await recA.post(`/api/ai-interviews/${bFirst}/retake`, { action: 'unblock', reason: 'Spoke to the candidate' });
  assert.equal(u.status, 200);
  const before = sent.filter((m) => m.to === 'bharat.sx@tl-sink.local' && /open again/.test(m.subject)).length;
  const s1 = await notice.runInterviewNoticeSweep();
  const s2 = await notice.runInterviewNoticeSweep();
  assert.equal(s1.retakeOpened, 1);
  assert.equal(s2.retakeOpened, 0);
  assert.equal(sent.filter((m) => m.to === 'bharat.sx@tl-sink.local' && /open again/.test(m.subject)).length, before + 1);
  const mail = sent.filter((m) => /open again/.test(m.subject)).pop();
  assert.doesNotMatch(mail.text, /reject|failed|disqualif/i);
  assert.equal((await candB.post('/api/ai-interviews/session', { applicationId: appB })).status, 201);
});

test('the ATS score is the latest COMPLETED attempt; a suspended attempt never counts', async () => {
  const all = await rows(appA);
  // attempt 3 completes with a score; attempts 1 and 2 stay suspended
  const last = all[2].id;
  await raw(`update ai_interviews set status='completed', overall_percentage=71, completed_at=now() where id=$1`, [last]).catch(() => {});
  const d = await recA.get(`/api/ai-interviews/${last}/integrity`);
  assert.equal(d.status, 200, JSON.stringify(d.body));
  assert.equal(d.body.attempts.length, 3);
  assert.equal(d.body.currentScore, 71);
  assert.deepEqual(d.body.attempts.map((a) => a.score), [null, null, 71]);
});

test('shutdown', async () => {
  await new Promise((r) => server.close(r));
  const { stopBackgroundWork } = await import('../src/app.js');
  stopBackgroundWork();
  const { closePool } = await import('../src/db.js');
  await closePool();
  await dbh.stop?.();
});
