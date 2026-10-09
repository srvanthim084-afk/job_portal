/**
 * AI interview: a clock the server keeps, Submit and timeout as one path, and a
 * warning before any page-detected suspension (0121). Real Postgres with RLS.
 *
 *   - every question has at least 120 s (a smaller configured value is clamped up)
 *   - the first question-start fixes the deadline; a refresh gets the same one
 *   - a deadline that passed while the candidate was away is saved as "unanswered"
 *     on the next read and the interview moves on - never suspended
 *   - an automatic (timeout) save never overwrites an answer already submitted,
 *     and Submit racing the timer leaves ONE answer
 *   - Submit never completes or suspends the interview; only /finish completes it
 *   - tab / camera / noise detections warn first and suspend on the second
 *   - a failed or missing report suspends nothing
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb, applyTestEnv, makeClient } from './harness.mjs';

const DB_PORT = 5593;
const API_PORT = 9947;
const base = `http://127.0.0.1:${API_PORT}`;
const PW = 'Timer123interview';

let dbh, server, raw, policy;
let candA, candB, jobId, appA, appB;
let sA, sB;

async function staff(email, role, table, id, company) {
  const { hashPassword } = await import('../src/auth.js');
  const hash = await hashPassword(PW);
  const u = (await raw(`insert into users (email,password_hash,role) values ($1,$2,$3) returning id`, [email, hash, role])).rows[0].id;
  await raw(`insert into ${table} (id, user_id, name, email, company_id) values ($1,$2,$3,$4,$5)`, [id, u, `${role} ${id}`, email, company]);
}
async function candidate(name, email, phone) {
  const c = makeClient(base);
  await c.get('/api/health');
  const r = await c.post('/api/auth/register', {
    name, email, password: PW, phone, preferredLocation: 'Hyderabad', expectedCtc: 4,
    noticePeriod: 'Immediate', preferredWorkModes: ['Hybrid'],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return c;
}
const iv = (id) => raw(`select * from ai_interviews where id=$1`, [id]).then((r) => r.rows[0]);
const start = (c, id, seq, part = 'main') => c.post(`/api/ai-interviews/${id}/question-start`, { seq, part });
/** Answer a question; if a follow-up was asked, answer that too (so the question is complete). */
const answer = async (c, id, body) => {
  const r = await c.post(`/api/ai-interviews/${id}/answer`, body);
  if (r.status === 200 && r.body.followUp && !body.autoSubmitted && body.part !== 'followup') {
    await c.post(`/api/ai-interviews/${id}/question-start`, { seq: body.seq, part: 'followup' });
    await c.post(`/api/ai-interviews/${id}/answer`, { seq: body.seq, part: 'followup', transcript: 'For example, last quarter I filled six roles using referrals and LinkedIn, which cut time to hire by a week.', answered: true });
  }
  return r;
};

test('boot', async () => {
  dbh = await startTestDb(DB_PORT);
  applyTestEnv(dbh.url, {
    PUBLIC_ORIGIN: base, DISABLE_BACKGROUND_WORK: 'true', AI_API_KEY: '',
    INTERVIEW_QUESTION_TIME_SECONDS: '30',            // below the floor: must be clamped up
    EMAIL_API_KEY: '', EMAIL_SMTP_HOST: '', EMAIL_SMTP_USER: '', EMAIL_SMTP_PASS: '',
    EMAILJS_SERVICE_ID: '', EMAILJS_TEMPLATE_ID: '', EMAILJS_PUBLIC_KEY: '', EMAILJS_PRIVATE_KEY: '',
    SMS_API_KEY: '', WHATSAPP_API_KEY: '',
  });
  raw = (sql, params) => dbh.db.query(sql, params);
  await raw(`insert into companies (id, name) values ('co_tm', 'Timer Co')`);
  const { createApp } = await import('../src/app.js');
  policy = await import('../src/interview/policy.js');
  const app = createApp({ logger: { error() {}, log() {} } });
  await new Promise((r) => { server = app.listen(API_PORT, r); });
  await staff('rec.tm@tl-sink.local', 'recruiter', 'recruiters', 'r_tm1', 'co_tm');
  jobId = 'j_tm1';
  await raw(`insert into jobs (id, title, company_id, location, mode, exp_label, skills, status, recruiter_id, description, published_at)
             values ($1, 'HR Recruiter', 'co_tm', 'Hyderabad', 'Onsite', '1-3 yrs', $2, 'open', 'r_tm1', $3, now())`,
    [jobId, ['Sourcing', 'ATS', 'Excel'], 'Own end-to-end hiring for client roles.']);
  candA = await candidate('Tara Timer', 'tara.tm@tl-sink.local', '9500000001');
  candB = await candidate('Tarun Timer', 'tarun.tm@tl-sink.local', '9500000002');
  appA = (await candA.post('/api/applications', { jobId })).body.application.id;
  appB = (await candB.post('/api/applications', { jobId })).body.application.id;
});

test('config: a time under two minutes is clamped up to 120', () => {
  assert.equal(policy.questionSeconds(), 120);
  process.env.INTERVIEW_QUESTION_TIME_SECONDS = '90';  assert.equal(policy.questionSeconds(), 120);
  process.env.INTERVIEW_QUESTION_TIME_SECONDS = '';    assert.equal(policy.questionSeconds(), 120);
  process.env.INTERVIEW_QUESTION_TIME_SECONDS = '180'; assert.equal(policy.questionSeconds(), 180);
  process.env.INTERVIEW_QUESTION_TIME_SECONDS = '30';
});

test('the session says how long a question is, and it is never under 120', async () => {
  const r = await candA.post('/api/ai-interviews/session', { applicationId: appA });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  sA = r.body;
  assert.ok(sA.questionSeconds >= 120, `questionSeconds ${sA.questionSeconds}`);
  assert.equal(sA.questions.length, 15);
});

test('question-start: the first call fixes the deadline, a refresh gets the same one', async () => {
  const a = await start(candA, sA.interviewId, 1);
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.ok(a.body.remainingMs > 118_000 && a.body.remainingMs <= 120_000, `remaining ${a.body.remainingMs}`);
  await new Promise((r) => setTimeout(r, 1200));
  const b = await start(candA, sA.interviewId, 1);
  assert.equal(b.body.deadlineAt, a.body.deadlineAt, 'a second call moved the deadline');
  assert.ok(b.body.remainingMs < a.body.remainingMs, 'time passes on the server');
  const p = await candA.get(`/api/ai-interviews/${sA.interviewId}/progress`);
  assert.ok(p.body.clock, JSON.stringify(p.body.resumeAt) + ' ' + JSON.stringify(Object.keys(p.body)));
  assert.equal(p.body.clock.deadlineAt, a.body.deadlineAt);
  assert.deepEqual(p.body.resumeAt, { seq: 1, part: 'main' });
  // not another candidate's, not a question that does not exist
  assert.equal((await start(candB, sA.interviewId, 1)).status, 404);
  assert.equal((await start(candA, sA.interviewId, 40)).status, 404);
});

test('Submit saves the answer and moves on; the interview stays in progress', async () => {
  const r = await answer(candA, sA.interviewId, { seq: 1, transcript: 'I sourced forty candidates a week on LinkedIn for client roles.', answered: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.next.seq, 2);
  const row = await iv(sA.interviewId);
  assert.ok(['in_progress', 'warning_issued'].includes(row.status), row.status);
});

test('timeout with a partial answer saves it as an automatic submit and the interview moves on', async () => {
  await start(candA, sA.interviewId, 2);
  const r = await answer(candA, sA.interviewId, { seq: 2, transcript: 'I used the applicant tracking system to', answered: true, autoSubmitted: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const part = (await raw(`select auto_submitted, transcript from ai_interview_answer_parts where interview_id=$1 and seq=2 and part='main'`, [sA.interviewId])).rows[0];
  assert.equal(part.auto_submitted, true);
  assert.match(part.transcript, /applicant tracking/);
  assert.equal((await iv(sA.interviewId)).status === 'suspended', false);
});

test('timeout with nothing said is "unanswered" and does not suspend', async () => {
  await start(candA, sA.interviewId, 3);
  const r = await answer(candA, sA.interviewId, { seq: 3, transcript: '', answered: false, autoSubmitted: true });
  assert.equal(r.status, 200);
  const a = (await raw(`select answered from ai_interview_answers where ai_interview_id=$1 and seq=3`, [sA.interviewId])).rows[0];
  assert.equal(a.answered, false);
  assert.ok((await iv(sA.interviewId)).status !== 'suspended');
});

test('Submit and the timer racing leave ONE answer, and the automatic save never overwrites the real one', async () => {
  await start(candA, sA.interviewId, 4);
  const words = 'I closed six hires in a month by sourcing on LinkedIn and referrals.';
  const [x, y] = await Promise.all([
    answer(candA, sA.interviewId, { seq: 4, transcript: words, answered: true }),
    answer(candA, sA.interviewId, { seq: 4, transcript: '', answered: false, autoSubmitted: true }),
  ]);
  assert.equal(x.status, 200); assert.equal(y.status, 200);
  // and the other order: the automatic save lands second
  await answer(candA, sA.interviewId, { seq: 4, transcript: '', answered: false, autoSubmitted: true });
  const parts = (await raw(`select transcript, answered from ai_interview_answer_parts where interview_id=$1 and seq=4 and part='main'`, [sA.interviewId])).rows;
  assert.equal(parts.length, 1, 'one answer row');
  assert.equal(parts[0].transcript, words, 'the real answer survived');
  assert.equal(parts[0].answered, true);
  assert.equal((await raw(`select questions_answered n from ai_interviews where id=$1`, [sA.interviewId])).rows[0].n, 3, 'counted once: Q1, Q2 (partial), Q4');
});

test('a deadline that passed while the candidate was away: saved as unanswered on the next read, moved on, not suspended', async () => {
  await start(candA, sA.interviewId, 5);
  await raw(`update ai_interview_question_timers set deadline_at = now() - interval '5 seconds' where interview_id=$1 and seq=5`, [sA.interviewId]);
  const p = await candA.get(`/api/ai-interviews/${sA.interviewId}/progress`);
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.deepEqual(p.body.resumeAt, { seq: 6, part: 'main' }, 'resumes on the NEXT question');
  const part = (await raw(`select auto_submitted, answered from ai_interview_answer_parts where interview_id=$1 and seq=5 and part='main'`, [sA.interviewId])).rows[0];
  assert.equal(part.auto_submitted, true);
  assert.equal(part.answered, false);
  assert.ok((await iv(sA.interviewId)).status !== 'suspended');
});

test('only /finish completes the interview, never an answer, however many are submitted', async () => {
  for (let q = 6; q <= 14; q++) {
    await start(candA, sA.interviewId, q);
    const r = await answer(candA, sA.interviewId, { seq: q, transcript: `Answer for question ${q}: I handle sourcing and screening for client roles.`, answered: true });
    assert.equal(r.status, 200);
    assert.ok(['in_progress', 'warning_issued'].includes((await iv(sA.interviewId)).status), `status after Q${q}`);
  }
  await start(candA, sA.interviewId, 15);
  const last = await answer(candA, sA.interviewId, { seq: 15, transcript: '', answered: false, autoSubmitted: true });
  assert.equal(last.body.next, null, 'no question after the 15th');
  assert.ok(['in_progress', 'warning_issued'].includes((await iv(sA.interviewId)).status), 'the last answer alone does not complete it');
  const f = await candA.post(`/api/ai-interviews/${sA.interviewId}/finish`, {});
  assert.equal(f.status, 200, JSON.stringify(f.body));
  const row = await iv(sA.interviewId);
  assert.equal(row.status, 'completed');
  // A completed interview is never started again ("Thanks for joining..." from Question 1 once more)
  const again = await candA.post('/api/ai-interviews/session', { applicationId: appA });
  assert.equal(again.status, 409, JSON.stringify(again.body));
  assert.equal(again.body.error.code, 'INTERVIEW_ALREADY_COMPLETED');
  assert.equal((await raw(`select count(*)::int n from ai_interviews where application_id=$1`, [appA])).rows[0].n, 1, 'no second interview was made');
  // the zero-scored (unanswered) questions are in the total across all 15
  const per = (await raw(`select seq, score, relevance_class from ai_interview_answers where ai_interview_id=$1 order by seq`, [sA.interviewId])).rows;
  assert.equal(per.length, 15);
  assert.equal(per.find((p) => p.seq === 15).relevance_class, 'NO_ANSWER');
  assert.equal(Number(per.find((p) => p.seq === 15).score), 0);
});

test('page detections warn first and suspend on the second; a lost connection suspends nothing', async () => {
  const r = await candB.post('/api/ai-interviews/session', { applicationId: appB });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  sB = r.body;
  // an answer, a timeout and a Submit are never detections
  await start(candB, sB.interviewId, 1);
  await answer(candB, sB.interviewId, { seq: 1, transcript: '', answered: false, autoSubmitted: true });
  assert.equal((await iv(sB.interviewId)).integrity_strikes, 0);

  const w = await candB.post(`/api/ai-interviews/${sB.interviewId}/stop`, { kind: 'left_interview', questionSeq: 2 });
  assert.equal(w.body.action, 'warn', JSON.stringify(w.body));
  assert.equal(w.body.mayContinue, true);
  assert.match(w.body.message, /^Warning:/);
  let row = await iv(sB.interviewId);
  assert.equal(row.status, 'warning_issued');
  assert.equal(row.suspended_at, null);
  // calling start again hands back the SAME interview to carry on from, not a duplicate
  const same = await candB.post('/api/ai-interviews/session', { applicationId: appB });
  assert.equal(same.status, 200, JSON.stringify(same.body));
  assert.equal(same.body.interviewId, sB.interviewId);
  assert.equal(same.body.resumed, true);
  assert.deepEqual(same.body.resumeAt && { seq: same.body.resumeAt.seq, part: same.body.resumeAt.part }, { seq: 2, part: 'main' });
  assert.equal((await raw(`select count(*)::int n from ai_interviews where application_id=$1`, [appB])).rows[0].n, 1);
  // the interview carries on: the next answer is accepted
  assert.equal((await answer(candB, sB.interviewId, { seq: 2, transcript: 'I screen CVs against the job description every day.', answered: true })).status, 200);

  const s = await candB.post(`/api/ai-interviews/${sB.interviewId}/stop`, { kind: 'camera_lost', questionSeq: 3 });
  assert.equal(s.body.action, 'suspend', JSON.stringify(s.body));
  assert.equal(s.body.message, 'Your camera was off for too long during Question 3.');
  row = await iv(sB.interviewId);
  assert.equal(row.status, 'suspended');
  assert.equal(row.suspension_code, 'camera_off');
  assert.equal(row.suspension_question_no, 3);
  assert.equal(row.detection_count, 2);
  const sus = await candB.get(`/api/ai-interviews/${sB.interviewId}/suspension`);
  assert.equal(sus.status, 200, JSON.stringify(sus.body));
  assert.equal(sus.body.message, 'Your camera was off for too long during Question 3.');
  assert.equal(sus.body.suspended, true);
  assert.equal((await candA.get(`/api/ai-interviews/${sB.interviewId}/suspension`)).status, 404, 'not another candidates interview');
});

test('shutdown', async () => {
  await new Promise((r) => server.close(r));
  const { stopBackgroundWork } = await import('../src/app.js');
  stopBackgroundWork();
  const { closePool } = await import('../src/db.js');
  await closePool();
  await dbh.stop?.();
});
