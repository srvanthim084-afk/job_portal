/**
 * The AI interview pass mark, and no leftover 48-hour dates (0140).
 *
 *   - a regular application whose finished AI interview scores at or above the pass mark (AI Settings,
 *     default 65) moves to Shortlisted - the recruiter's ATS pipeline; below it, AI Interview Done
 *   - 65 passes, 64 does not; the pass mark is read from the settings, not hard-coded
 *   - forward only: an application past Shortlisted is not pulled back; a walk-in is not moved (its rule is 0139)
 *   - the move is recorded with the score and the pass mark, and the recruiter is told
 *   - an interview still to be taken follows its job's date, at any stage - no job date, no interview date
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb, applyTestEnv, makeClient } from './harness.mjs';

const DB_PORT = 5603;
const API_PORT = 9961;
const base = `http://127.0.0.1:${API_PORT}`;
const PW = 'PassMark123test';

let dbh, server, raw;
let seq = 0;

async function candidate() {
  seq += 1;
  const c = makeClient(base);
  await c.get('/api/health');
  const r = await c.post('/api/auth/register', {
    name: `Pass Person ${seq}`, email: `pass.${seq}.${Date.now().toString(36)}@mailbox-teamlink-tests.in`,
    password: PW, phone: '93200' + String(10000 + seq).slice(-5), preferredLocation: 'Hyderabad', expectedCtc: 4,
    noticePeriod: 'Immediate', preferredWorkModes: ['Hybrid'],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  c.id = r.body.candidateId;
  return c;
}
const job = (id, extra = {}) => raw(
  `insert into jobs (id, title, company_id, location, mode, exp_label, skills, status, recruiter_id, description, published_at, expires_at, posting_kind, walkin_date, walkin_from, walkin_to)
   values ($1, $2, 'co_pm', 'Hyderabad', 'Onsite', '1-3 yrs', $3, 'open', 'r_pm', 'Hire well.', now(), $4, $5, $6, $7, $8)`,
  [id, `Role ${id}`, ['Sourcing'], extra.expires || null, extra.kind || 'job', extra.walkinDate || null, extra.walkinDate ? '10:00' : null, extra.walkinDate ? '16:00' : null]);
async function application(jobId, stage = 'applied') {
  const c = await candidate();
  const id = `app_pm_${seq}`;
  await raw(`insert into applications (id, job_id, candidate_id, recruiter_id) values ($1, $2, $3, 'r_pm')`, [id, jobId, c.id]);
  if (stage !== 'applied' && stage !== 'registered') await raw(`update applications set stage = $2 where id = $1`, [id, stage]);
  return id;
}
const record = async (appId, score) => (await raw(`select ai_interview_recorded($1, $2) as out`, [appId, score])).rows[0].out;
const stage = async (appId) => (await raw(`select stage from applications where id = $1`, [appId])).rows[0].stage;

test('boot', async () => {
  dbh = await startTestDb(DB_PORT);
  applyTestEnv(dbh.url, {
    PUBLIC_ORIGIN: base, DISABLE_BACKGROUND_WORK: 'true', AI_API_KEY: '',
    EMAIL_API_KEY: '', EMAIL_SMTP_HOST: '', EMAIL_SMTP_USER: '', EMAIL_SMTP_PASS: '',
    EMAILJS_SERVICE_ID: '', EMAILJS_TEMPLATE_ID: '', EMAILJS_PUBLIC_KEY: '', EMAILJS_PRIVATE_KEY: '',
    SMS_API_KEY: '', WHATSAPP_API_KEY: '',
  });
  raw = (sql, params) => dbh.db.query(sql, params);
  await raw(`insert into companies (id, name) values ('co_pm', 'Pass Co')`);
  await raw(`insert into recruiters (id, name, email, company_id) values ('r_pm', 'Pass Recruiter', 'rec.pm@tl-sink.local', 'co_pm')`);
  const { createApp } = await import('../src/app.js');
  const app = createApp({ logger: { error() {}, log() {} } });
  await new Promise((r) => { server = app.listen(API_PORT, r); });
  await job('j_pm');
  await job('j_pm_walk', { kind: 'walkin', walkinDate: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10) });
});

test('the pass mark is 65 by default, from the AI settings', async () => {
  assert.equal(Number((await raw(`select ai_interview_pass_mark() as p`)).rows[0].p), 65);
  assert.equal(Number((await raw(`select value->>'aiInterviewPassMark' as p from app_settings where key = 'ai'`)).rows[0].p), 65);
});

test('at or above the pass mark: Shortlisted (ATS); below it: AI Interview Done for review', async () => {
  const a72 = await application('j_pm');
  const a65 = await application('j_pm');
  const a64 = await application('j_pm');
  const r72 = await record(a72, 72);
  assert.equal(r72.passed, true);
  assert.equal(await stage(a72), 'shortlisted');
  assert.equal((await record(a65, 65)).passed, true, '65 is the pass mark itself');
  assert.equal(await stage(a65), 'shortlisted');
  assert.equal((await record(a64, 64.4)).passed, false, '64 does not pass');
  assert.equal(await stage(a64), 'ai_interview_done');

  /* recorded with the score and the pass mark */
  const h = (await raw(`select note from application_stage_history where application_id = $1 and to_stage = 'shortlisted' order by created_at desc limit 1`, [a72])).rows[0];
  assert.match(h.note, /72% - at or above the 65% pass mark: moved to Shortlisted \(ATS\)/);
  const ev = (await raw(`select metadata from application_events where application_id = $1 and type = 'interview.completed'`, [a72])).rows[0];
  assert.equal(ev.metadata.passed, true);
  assert.equal(Number(ev.metadata.passMark), 65);
  /* and the recruiter is told */
  const n = (await raw(`select message from notifications where application_id = $1 and type = 'AI_INTERVIEW_COMPLETED' order by created_at desc limit 1`, [a72])).rows[0];
  assert.match(n.message, /72%.*moved to Shortlisted/);
  const n64 = (await raw(`select message from notifications where application_id = $1 and type = 'AI_INTERVIEW_COMPLETED' order by created_at desc limit 1`, [a64])).rows[0];
  assert.match(n64.message, /Below the 65% pass mark/);
});

test('the pass mark comes from the settings', async () => {
  await raw(`update app_settings set value = value || '{"aiInterviewPassMark": 70}'::jsonb where key = 'ai'`);
  const a68 = await application('j_pm');
  assert.equal((await record(a68, 68)).passed, false);
  assert.equal(await stage(a68), 'ai_interview_done');
  await raw(`update app_settings set value = value || '{"aiInterviewPassMark": "nonsense"}'::jsonb where key = 'ai'`);
  assert.equal(Number((await raw(`select ai_interview_pass_mark() as p`)).rows[0].p), 65, 'a broken setting falls back to 65, never to 0');
  await raw(`update app_settings set value = value || '{"aiInterviewPassMark": 65}'::jsonb where key = 'ai'`);
});

test('forward only, and walk-ins are not moved by it', async () => {
  const offer = await application('j_pm', 'offer_extended');
  await record(offer, 90);
  assert.equal(await stage(offer), 'offer_extended', 'not pulled back to Shortlisted');
  const rejected = await application('j_pm', 'rejected');
  await record(rejected, 95);
  assert.equal(await stage(rejected), 'rejected', 'a rejected application does not come back to life');
  const walk = await application('j_pm_walk', 'registered');
  const r = await record(walk, 88);
  assert.equal(r.passed, false, 'the walk-in rule is eligibility at 50% (0139), not this');
  assert.equal(await stage(walk), 'registered');
});

test('an interview still to be taken follows its job\'s date, at any stage', async () => {
  const sl = await application('j_pm', 'shortlisted');
  /* the old rule left "applied + 48 hours" behind on applications past Applied */
  await raw(`update applications set ai_interview_due_at = now() - interval '9 days' where id = $1`, [sl]);
  assert.equal((await raw(`select reason from ai_interview_window($1)`, [sl])).rows[0].reason, 'due_passed');
  const n = (await raw(`select ai_interview_due_resync() as n`)).rows[0].n;
  assert.ok(n >= 1);
  assert.equal((await raw(`select ai_interview_due_at from applications where id = $1`, [sl])).rows[0].ai_interview_due_at, null, 'no job date, no interview date');
  assert.equal((await raw(`select open from ai_interview_window($1)`, [sl])).rows[0].open, true);
  /* and when the recruiter sets a date, it follows */
  await raw(`update jobs set expires_at = now() + interval '4 days' where id = 'j_pm'`);
  const due = (await raw(`select ai_interview_due_at from applications where id = $1`, [sl])).rows[0].ai_interview_due_at;
  const jexp = (await raw(`select expires_at from jobs where id = 'j_pm'`)).rows[0].expires_at;
  assert.equal(new Date(due).getTime(), new Date(jexp).getTime());
  /* a finished interview's date is history - left alone */
  await raw(`update jobs set expires_at = null where id = 'j_pm'`);
});

test('shutdown', async () => {
  await new Promise((r) => server.close(r));
  const { stopBackgroundWork } = await import('../src/app.js');
  stopBackgroundWork();
  const { closePool } = await import('../src/db.js');
  await closePool();
  await dbh.stop?.();
});
