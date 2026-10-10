/**
 * The AI interview: a Submit never ends in "suspended" (0136), against a real
 * Postgres with RLS and the policy DEFAULTS (12-hour retake, 20-second incident).
 *
 *   - Submit / a timeout / an empty answer are never detections, and send no email
 *   - one moment reported twice (two detectors, one sound) is ONE strike
 *   - a low-confidence detection warns and is recorded, never a strike
 *   - once every question is answered (the final Submit, scoring running) nothing
 *     more is counted: the interview cannot be suspended while it is being scored
 *   - a recruiter reopening the interview resets the strikes
 *   - the retake opens 12 hours after the suspension, enforced by the server
 *     (11h59m refused, 12h00m allowed)
 *   - a suspend with no reason is refused by the shared suspend function
 *   - a recruiter's block / unblock tells the candidate the new state
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb, applyTestEnv, makeClient } from './harness.mjs';

const DB_PORT = 5599;
const API_PORT = 9949;
const base = `http://127.0.0.1:${API_PORT}`;
const PW = 'Incident123interview';

let dbh, server, raw, providers;
let rec, candA, candB, candC, jobId, appA, appB, appC;
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
  return c;
}
const tick = (ms = 300) => new Promise((r) => setTimeout(r, ms));
const iv = (id) => raw(`select * from ai_interviews where id=$1`, [id]).then((r) => r.rows[0]);
const rows = async (appId) => (await raw(
  `select * from ai_interviews where application_id=$1 order by attempt_number`, [appId])).rows;
const start = (c, id, seq, part = 'main') => c.post(`/api/ai-interviews/${id}/question-start`, { seq, part });
const detect = (c, id, type, confidence, seq) => c.post(`/api/ai-interviews/${id}/integrity`, {
  type, confidence, evidence: { questionSeq: seq, detector: 'browser' } });
const mailsTo = (to) => sent.filter((m) => m.to === to);

test('boot', async () => {
  dbh = await startTestDb(DB_PORT);
  applyTestEnv(dbh.url, {
    PUBLIC_ORIGIN: base, DISABLE_BACKGROUND_WORK: 'true', AI_API_KEY: '',
    // the policy defaults are what is being tested: nothing about the retake or the incident window is set
    INTERVIEW_RETAKE_DELAY_MINUTES: '', INTERVIEW_INCIDENT_SECONDS: '', INTERVIEW_MAX_ATTEMPTS: '',
    TEAMLINK_TIMEZONE: 'Asia/Kolkata', SUPPORT_EMAIL: 'support@tl-sink.local',
    EMAIL_API_KEY: '', EMAIL_SMTP_HOST: '', EMAIL_SMTP_USER: '', EMAIL_SMTP_PASS: '',
    EMAILJS_SERVICE_ID: '', EMAILJS_TEMPLATE_ID: '', EMAILJS_PUBLIC_KEY: '', EMAILJS_PRIVATE_KEY: '',
    SMS_API_KEY: '', WHATSAPP_API_KEY: '',
  });
  raw = (sql, params) => dbh.db.query(sql, params);
  await raw(`insert into companies (id, name) values ('co_in', 'Incident Co')`);
  const { createApp } = await import('../src/app.js');
  ({ providers } = await import('../src/notify/providers.js'));
  providers.email.send = async (m) => { sent.push(m); return { status: 'sent', provider: 'test' }; };
  const app = createApp({ logger: { error() {}, log() {} } });
  await new Promise((r) => { server = app.listen(API_PORT, r); });

  rec = await staff('rec.in@tl-sink.local', 'recruiter', 'recruiters', 'r_in1', 'co_in');
  jobId = 'j_in1';
  await raw(`insert into jobs (id, title, company_id, location, mode, exp_label, skills, status, recruiter_id, description, published_at)
             values ($1, 'Support Executive', 'co_in', 'Hyderabad', 'Onsite', '0-2 yrs', $2, 'open', 'r_in1', $3, now())`,
    [jobId, ['Customer service', 'Email support'], 'Answer customer calls and emails for a retail client.']);
  candA = await candidate('Anil Incident', 'anil.in@tl-sink.local', '9500000001');
  candB = await candidate('Bina Incident', 'bina.in@tl-sink.local', '9500000002');
  candC = await candidate('Chitra Incident', 'chitra.in@tl-sink.local', '9500000003');
  appA = (await candA.post('/api/applications', { jobId })).body.application.id;
  appB = (await candB.post('/api/applications', { jobId })).body.application.id;
  appC = (await candC.post('/api/applications', { jobId })).body.application.id;
});

let a1;
test('Submit, a timeout and an empty answer are never detections and send no email', async () => {
  const s = await candA.post('/api/ai-interviews/session', { applicationId: appA });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  a1 = s.body.interviewId;
  const before = sent.length;
  await start(candA, a1, 1);
  const r1 = await candA.post(`/api/ai-interviews/${a1}/answer`, { seq: 1, transcript: 'I answered customer emails for two years.', answered: true });
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  if (r1.body.followUp) {
    await start(candA, a1, 1, 'followup');
    await candA.post(`/api/ai-interviews/${a1}/answer`, { seq: 1, part: 'followup', transcript: 'For example I closed forty tickets a day.', answered: true });
  }
  await start(candA, a1, 2);
  const r2 = await candA.post(`/api/ai-interviews/${a1}/answer`, { seq: 2, transcript: '', answered: false, autoSubmitted: true });
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  const row = await iv(a1);
  assert.equal(row.status, 'in_progress');
  assert.equal(row.integrity_strikes, 0);
  await tick();
  assert.equal(sent.length, before, 'no email for a Submit or a timeout');
});

test('one moment reported by two detectors is ONE strike, not a suspension', async () => {
  const w = await detect(candA, a1, 'additional_voice', 0.9, 3);
  assert.equal(w.body.action, 'warn', JSON.stringify(w.body));
  // the page hears the same sound as noise a moment later
  const same = await candA.post(`/api/ai-interviews/${a1}/stop`, { kind: 'background_noise', questionSeq: 3 });
  assert.equal(same.body.action, 'noted', JSON.stringify(same.body));
  assert.equal(same.body.suspended, false);
  assert.equal(same.body.mayContinue, true);
  const row = await iv(a1);
  assert.equal(row.status, 'warning_issued');
  assert.equal(row.integrity_strikes, 1);
  const flags = (await raw(`select strike_no, severity, description from ai_interview_flags where interview_id=$1 order by occurred_at, id`, [a1])).rows;
  assert.equal(flags.length, 2, 'both observations are kept for the recruiter');
  assert.match(flags[1].description, /same moment - not counted/);
  assert.equal(flags[1].severity, 'review');
});

test('a low-confidence detection warns and is recorded, but never counts', async () => {
  const s = await candB.post('/api/ai-interviews/session', { applicationId: appB });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  const id = s.body.interviewId;
  for (let i = 0; i < 3; i++) {
    // three separate moments, a minute apart
    await raw(`update ai_interviews set last_detection_at = now() - interval '1 minute' where id=$1`, [id]);
    const r = await detect(candB, id, 'additional_person', 0.5, 2);
    assert.equal(r.body.action, 'warn', JSON.stringify(r.body));
  }
  // the same uncertain moment reported again at once is just noted
  assert.equal((await detect(candB, id, 'additional_person', 0.5, 2)).body.action, 'noted');
  const row = await iv(id);
  assert.equal(row.integrity_strikes, 0, 'three uncertain detections, no strike');
  assert.notEqual(row.status, 'suspended');
  assert.equal((await raw(`select count(*)::int n from ai_interview_flags where interview_id=$1 and description like '%uncertain - not counted%'`, [id])).rows[0].n, 4);
});

test('after the last answer nothing is counted: the final Submit can never be suspended', async () => {
  // A has one strike already; every remaining question is answered (timeouts, no follow-ups)
  const n = (await raw(`select count(*)::int n from ai_interview_answers where ai_interview_id=$1`, [a1])).rows[0].n;
  for (let q = 3; q <= n; q++) {
    await start(candA, a1, q);
    const r = await candA.post(`/api/ai-interviews/${a1}/answer`, { seq: q, transcript: '', answered: false, autoSubmitted: true });
    assert.equal(r.status, 200, `Q${q}: ${JSON.stringify(r.body)}`);
  }
  // scoring is running; the candidate relaxes, somebody walks in - twice, well apart
  await raw(`update ai_interviews set last_detection_at = now() - interval '5 minutes' where id=$1`, [a1]);
  const late = await detect(candA, a1, 'additional_person', 0.95, n);
  assert.equal(late.body.action, 'ignored', JSON.stringify(late.body));
  const stop = await candA.post(`/api/ai-interviews/${a1}/stop`, { kind: 'left_interview', questionSeq: n });
  assert.equal(stop.body.action, 'ignored', JSON.stringify(stop.body));
  const row = await iv(a1);
  assert.notEqual(row.status, 'suspended');
  assert.equal(row.integrity_strikes, 1, 'unchanged');
  const fin = await candA.post(`/api/ai-interviews/${a1}/finish`, {});
  assert.equal(fin.status, 200, JSON.stringify(fin.body));
  assert.equal((await iv(a1)).status, 'completed');
});

let c1;
test('two separate moments suspend: the 12-hour retake, enforced by the server', async () => {
  const s = await candC.post('/api/ai-interviews/session', { applicationId: appC });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  c1 = s.body.interviewId;
  assert.equal((await detect(candC, c1, 'additional_voice', 0.9, 2)).body.action, 'warn');
  // a minute later: a separate moment
  await raw(`update ai_interviews set last_detection_at = now() - interval '1 minute' where id=$1`, [c1]);
  const x = await detect(candC, c1, 'additional_voice', 0.9, 4);
  assert.equal(x.body.action, 'suspend', JSON.stringify(x.body));
  const row = await iv(c1);
  assert.equal(row.status, 'suspended');
  const mins = (new Date(row.retake_available_at) - new Date(row.suspended_at)) / 60000;
  assert.ok(mins > 719.9 && mins < 720.1, `retake after ${mins} minutes (12 hours by default)`);

  await tick();
  const mail = mailsTo('chitra.in@tl-sink.local').filter((m) => /suspended/.test(m.subject));
  assert.equal(mail.length, 1);
  assert.match(mail[0].text, /which is 12 hours after the suspension/);

  // 11h59m after the suspension: refused by the server
  await raw(`update ai_interviews set suspended_at = now() - interval '11 hours 59 minutes',
                                      retake_available_at = now() + interval '1 minute' where id=$1`, [c1]);
  const early = await candC.post('/api/ai-interviews/session', { applicationId: appC });
  assert.equal(early.status, 423, JSON.stringify(early.body));
  assert.equal(early.body.error.code, 'INTERVIEW_RETAKE_WAIT');
  assert.equal((await rows(appC)).length, 1, 'nothing was created');
});

test('a recruiter block and unblock tell the candidate the new state', async () => {
  const before = mailsTo('chitra.in@tl-sink.local').length;
  const b = await rec.post(`/api/ai-interviews/${c1}/retake`, { action: 'block', reason: 'Wants a call first' });
  assert.equal(b.status, 200, JSON.stringify(b.body));
  await tick();
  const m1 = mailsTo('chitra.in@tl-sink.local').slice(before);
  assert.equal(m1.length, 1, 'one update email');
  assert.match(m1[0].subject, /under recruiter review/);
  assert.match(m1[0].text, /The retake time in our earlier email no longer applies/);
  assert.doesNotMatch(m1[0].text + m1[0].html, /reject|failed|disqualif/i);

  const u = await rec.post(`/api/ai-interviews/${c1}/retake`, { action: 'unblock', reason: 'Spoke to the candidate' });
  assert.equal(u.status, 200);
  await tick();
  const m2 = mailsTo('chitra.in@tl-sink.local').slice(before + 1);
  assert.equal(m2.length, 1, 'the new time');
  assert.match(m2[0].subject, /you can attend again on .*(am|pm)/i);
});

test('12h00m after the suspension the retake opens as a new attempt', async () => {
  await raw(`update ai_interviews set suspended_at = now() - interval '12 hours', retake_available_at = now() where id=$1`, [c1]);
  const ok = await candC.post('/api/ai-interviews/session', { applicationId: appC });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const all = await rows(appC);
  assert.deepEqual(all.map((r) => [r.attempt_number, r.status]), [[1, 'suspended'], [2, 'in_progress']]);
  assert.equal(all[1].integrity_strikes, 0);
});

test('a recruiter reopening an interview resets its strikes', async () => {
  const c2 = (await rows(appC))[1].id;
  assert.equal((await detect(candC, c2, 'camera_off', 0.9, 1)).body.action, 'warn');
  await raw(`update ai_interviews set last_detection_at = now() - interval '1 minute' where id=$1`, [c2]);
  assert.equal((await detect(candC, c2, 'camera_off', 0.9, 2)).body.action, 'suspend');
  const r = await rec.post(`/api/ai-interviews/${c2}/reopen`, { reason: 'Camera driver crashed - checked with the candidate' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const row = await iv(c2);
  assert.equal(row.integrity_strikes, 0);
  assert.equal(row.last_detection_at, null);
  // the first detection after the reopen is a warning again, not an instant suspension
  const w = await detect(candC, c2, 'camera_off', 0.9, 3);
  assert.equal(w.body.action, 'warn', JSON.stringify(w.body));
});

test('the shared suspend function refuses a suspension without a reason', async () => {
  await assert.rejects(raw(`select * from ai_interview_suspend($1, 'additional_voice', '', 3, 2, 720, 2, 48, '{}'::jsonb)`, [a1]),
    /a suspension needs a reason message/);
  await assert.rejects(raw(`select * from ai_interview_suspend($1, null, 'Something', 3, 2, 720, 2, 48, '{}'::jsonb)`, [a1]),
    /a suspension needs a known reason code/);
});

test('shutdown', async () => {
  await new Promise((r) => server.close(r));
  const { stopBackgroundWork } = await import('../src/app.js');
  stopBackgroundWork();
  const { closePool } = await import('../src/db.js');
  await closePool();
  await dbh.stop?.();
});
