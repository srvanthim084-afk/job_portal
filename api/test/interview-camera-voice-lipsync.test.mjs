/**
 * AI interview: the camera hidden, background voices, lips that do not match the voice (0148),
 * against a real Postgres.
 *
 *   - a camera hidden / covered for more than 10 s (reported by the page) suspends AT ONCE - no warning first
 *   - a background voice (another voice, or noise in a quiet stretch) warns TWICE and the THIRD suspends;
 *     it has its own counter, so a tab switch or a second person does not use up a voice warning
 *   - lips that do not match the voice suspend at once; an uncertain observation only warns
 *   - a recruiter reopening clears the voice strikes too
 *   - the reason code, the one sentence and the retake time are the same as every other suspension
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb, applyTestEnv, makeClient } from './harness.mjs';

const DB_PORT = 5688;
const API_PORT = 9960;
const base = `http://127.0.0.1:${API_PORT}`;
const PW = 'CamVoiceLip123interview';

let dbh, server, raw, policy;
const cands = [];
const sent = [];

async function candidate(n) {
  const c = makeClient(base);
  await c.get('/api/health');
  const r = await c.post('/api/auth/register', {
    name: `Cam Voice ${n}`, email: `cv${n}.cvl@tl-sink.local`, password: PW, phone: `94000022${10 + n}`,
    preferredLocation: 'Hyderabad', expectedCtc: 4, noticePeriod: 'Immediate', preferredWorkModes: ['Hybrid'],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  c.id = r.body.candidateId;
  return c;
}
/** a candidate with a running interview */
async function running(n) {
  const c = await candidate(n);
  const app = (await c.post('/api/applications', { jobId: 'j_cvl1' })).body.application.id;
  const s = await c.post('/api/ai-interviews/session', { applicationId: app });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  return { c, app, id: s.body.interviewId };
}
const row = async (id) => (await raw(`select * from ai_interviews where id=$1`, [id])).rows[0];
const report = (c, id, type, confidence = 0.9, seq = 3) => c.post(`/api/ai-interviews/${id}/integrity`, {
  type, confidence, evidence: { questionSeq: seq, detector: 'browser' } });

test('boot', async () => {
  dbh = await startTestDb(DB_PORT);
  applyTestEnv(dbh.url, {
    PUBLIC_ORIGIN: base,
    DISABLE_BACKGROUND_WORK: 'true',
    AI_API_KEY: '',
    INTERVIEW_RETAKE_DELAY_MINUTES: '720', INTERVIEW_MAX_ATTEMPTS: '2',
    INTERVIEW_INCIDENT_SECONDS: '0',   // back-to-back detections here are separate incidents (0136)
    TEAMLINK_TIMEZONE: 'Asia/Kolkata', SUPPORT_EMAIL: 'support@tl-sink.local',
    EMAIL_API_KEY: '', EMAIL_SMTP_HOST: '', EMAIL_SMTP_USER: '', EMAIL_SMTP_PASS: '',
    EMAILJS_SERVICE_ID: '', EMAILJS_TEMPLATE_ID: '', EMAILJS_PUBLIC_KEY: '', EMAILJS_PRIVATE_KEY: '',
    SMS_API_KEY: '', WHATSAPP_API_KEY: '',
  });
  raw = (sql, params) => dbh.db.query(sql, params);
  await raw(`insert into companies (id, name) values ('co_cvl', 'Cam Voice Co')`);
  const { hashPassword } = await import('../src/auth.js');
  const u = (await raw(`insert into users (email,password_hash,role) values ('rec.cvl@tl-sink.local',$1,'recruiter') returning id`,
    [await hashPassword(PW)])).rows[0].id;
  await raw(`insert into recruiters (id, user_id, name, email, company_id) values ('r_cvl1',$1,'recruiter cvl','rec.cvl@tl-sink.local','co_cvl')`, [u]);
  await raw(`insert into jobs (id, title, company_id, location, mode, exp_label, skills, status, recruiter_id, description, published_at)
             values ('j_cvl1', 'HR Recruiter', 'co_cvl', 'Hyderabad', 'Onsite', '1-3 yrs', $1, 'open', 'r_cvl1', $2, now())`,
    [['Sourcing', 'ATS', 'Excel'], 'Own end-to-end hiring for client roles.']);

  const { createApp } = await import('../src/app.js');
  policy = await import('../src/interview/policy.js');
  const { providers } = await import('../src/notify/providers.js');
  providers.email.send = async (m) => { sent.push(m); return { status: 'sent', provider: 'test' }; };
  const app = createApp({ logger: { error() {}, log() {} } });
  await new Promise((r) => { server = app.listen(API_PORT, r); });
});

test('policy: the new reason has its code and one sentence, with no rejection words', () => {
  assert.ok(policy.SUSPENSION_CODES.includes('lip_sync'));
  assert.equal(policy.stopMessage('lip_sync', 4), 'Your lip movement did not match your voice during Question 4.');
  assert.doesNotMatch(policy.stopMessage('lip_sync', 4), /reject|fail|disqualif/i);
});

test('a camera hidden for more than 10 s suspends at once - no warning first', async () => {
  const { c, id } = await running(1);
  const r = await c.post(`/api/ai-interviews/${id}/stop`, { kind: 'camera_lost', questionSeq: 5 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.action, 'suspend', JSON.stringify(r.body));
  assert.equal(r.body.suspended, true);
  assert.equal(r.body.message, 'Your camera was off for too long during Question 5.');
  assert.ok(r.body.retakeAvailableAt);
  const v = await row(id);
  assert.equal(v.status, 'suspended');
  assert.equal(v.suspension_code, 'camera_off');
  assert.equal(v.suspension_question_no, 5);
});

test('a camera hidden is not "the same moment" as an earlier warning: it still suspends at once', async () => {
  const { c, id } = await running(2);
  const w = await report(c, id, 'additional_voice', 0.9, 2);
  assert.equal(w.body.action, 'warn');
  const cam = await report(c, id, 'camera_off', 0.92, 2);   // straight after, well inside any incident window
  assert.equal(cam.body.action, 'suspend', JSON.stringify(cam.body));
  assert.equal((await row(id)).suspension_code, 'camera_off');
});

test('an uncertain camera / lip observation only warns, it never suspends', async () => {
  const { c, id } = await running(3);
  const a = await report(c, id, 'camera_off', 0.4, 1);
  assert.equal(a.body.action, 'warn');
  const b = await report(c, id, 'lip_sync', 0.5, 1);
  assert.equal(b.body.action, 'warn');
  assert.notEqual((await row(id)).status, 'suspended');
});

test('a background voice warns twice and the third time suspends', async () => {
  const { c, id } = await running(4);
  const w1 = await report(c, id, 'additional_voice', 0.9, 3);
  assert.equal(w1.body.action, 'warn');
  assert.equal(w1.body.strike, 1);
  assert.match(w1.body.message, /^Warning 1 of 2: A voice was heard in the background\. Voices in the background are not allowed/);
  assert.equal(w1.body.mayContinue, true);

  const w2 = await report(c, id, 'additional_voice', 0.9, 3);
  assert.equal(w2.body.action, 'warn', 'the second is still a warning');
  assert.equal(w2.body.strike, 2);
  assert.match(w2.body.message, /^Warning 2 of 2: .*last warning/);
  assert.equal(w2.body.mayContinue, true);
  assert.notEqual((await row(id)).status, 'suspended');

  const s = await report(c, id, 'additional_voice', 0.9, 3);
  assert.equal(s.body.action, 'suspend', JSON.stringify(s.body));
  assert.equal(s.body.message, 'Another voice was detected during your answer to Question 3.');
  assert.equal(s.body.mayContinue, false);
  const v = await row(id);
  assert.equal(v.status, 'suspended');
  assert.equal(v.suspension_code, 'additional_voice');
  assert.equal(v.voice_strikes, 3);
  assert.ok(v.retake_available_at);

  // a detector still firing afterwards changes nothing
  const again = await report(c, id, 'additional_voice', 0.9, 4);
  assert.equal(again.body.action, 'suspended');
  assert.equal((await row(id)).voice_strikes, 3);
});

test('noise in a quiet stretch counts with the voices: the page\'s own stop uses the same three', async () => {
  const { c, id } = await running(5);
  const a = await report(c, id, 'additional_voice', 0.9, 2);
  assert.equal(a.body.action, 'warn');
  const b = await c.post(`/api/ai-interviews/${id}/stop`, { kind: 'background_noise', questionSeq: 2 });
  assert.equal(b.body.action, 'warn', JSON.stringify(b.body));
  assert.equal(b.body.strike, 2);
  const s = await c.post(`/api/ai-interviews/${id}/stop`, { kind: 'background_noise', questionSeq: 2 });
  assert.equal(s.body.action, 'suspend', JSON.stringify(s.body));
  assert.equal(s.body.message, 'Continuous background noise was detected during Question 2.');
  assert.equal((await row(id)).suspension_code, 'background_noise');
});

test('a voice has its own count: a warning for leaving the window does not use one up', async () => {
  const { c, id } = await running(6);
  const left = await c.post(`/api/ai-interviews/${id}/stop`, { kind: 'left_interview', questionSeq: 1 });
  assert.equal(left.body.action, 'warn');
  const w1 = await report(c, id, 'additional_voice', 0.9, 1);
  const w2 = await report(c, id, 'additional_voice', 0.9, 1);
  assert.deepEqual([w1.body.action, w1.body.strike, w2.body.action, w2.body.strike], ['warn', 1, 'warn', 2]);
  assert.notEqual((await row(id)).status, 'suspended', 'one tab warning and two voice warnings: still running');
  const s = await report(c, id, 'additional_voice', 0.9, 1);
  assert.equal(s.body.action, 'suspend');
  const v = await row(id);
  assert.equal(v.integrity_strikes, 1);
  assert.equal(v.voice_strikes, 3);
});

test('the other detections keep their two strikes', async () => {
  const { c, id } = await running(7);
  const a = await report(c, id, 'additional_person', 0.9, 2);
  assert.equal(a.body.action, 'warn');
  const b = await report(c, id, 'additional_person', 0.9, 2);
  assert.equal(b.body.action, 'suspend');
  assert.equal((await row(id)).suspension_code, 'additional_person');
});

test('lips that do not match the voice suspend at once, with their own reason', async () => {
  const { c, id } = await running(8);
  const r = await report(c, id, 'lip_sync', 0.93, 4);
  assert.equal(r.body.action, 'suspend', JSON.stringify(r.body));
  assert.equal(r.body.message, 'Your lip movement did not match your voice during Question 4.');
  const v = await row(id);
  assert.equal(v.status, 'suspended');
  assert.equal(v.suspension_code, 'lip_sync');
  assert.equal(v.suspension_question_no, 4);
  assert.ok(v.retake_available_at);
  const flag = (await raw(`select * from ai_interview_flags where interview_id=$1 order by id desc limit 1`, [id])).rows[0];
  assert.equal(flag.flag_type, 'lip_sync');
  assert.equal(flag.description, 'Lips did not match the voice detected');
});

test('a recruiter reopening a suspension clears the voice strikes too', async () => {
  const { c, id } = await running(9);
  for (let i = 0; i < 3; i++) await report(c, id, 'additional_voice', 0.9, 1);
  assert.equal((await row(id)).voice_strikes, 3);
  await raw(`select interview_integrity_reopen($1, 'checked with the candidate', null, null)`, [id]);
  const v = await row(id);
  assert.equal(v.voice_strikes, 0);
  assert.equal(v.integrity_strikes, 0);
  const w = await report(c, id, 'additional_voice', 0.9, 1);
  assert.equal(w.body.action, 'warn', 'the first voice after a reopen warns again');
});

test('shutdown', async () => {
  await new Promise((r) => server.close(r));
  const { stopBackgroundWork } = await import('../src/app.js');
  stopBackgroundWork();
  const { closePool } = await import('../src/db.js');
  await closePool();
  await dbh.stop?.();
});
