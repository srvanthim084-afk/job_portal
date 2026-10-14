/**
 * Talent Pool: the Resume score and Overall score dropdowns (GET /api/candidates?resumeScoreMin=&overallScoreMin=).
 *
 *   - Overall score = the best overall score of any of the candidate's applications (the score the 65% auto-ATS
 *     rule reads: the screening score, with the screening answers when they are in)
 *   - a candidate who never applied has none, so the filter leaves them out; sample rows are not counted
 *   - it combines with the resume score, and both page and count like every other filter
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb, applyTestEnv, makeClient } from './harness.mjs';

const DB_PORT = 5615;
const API_PORT = 9971;
const base = `http://127.0.0.1:${API_PORT}`;
const PW = 'PoolScore123test';

let dbh, server, raw, rec;
const C = {};
let seq = 0;

async function candidate(name) {
  seq += 1;
  const c = makeClient(base);
  await c.get('/api/health');
  const r = await c.post('/api/auth/register', {
    name, email: `pool.score.${seq}.${Date.now().toString(36)}@mailbox-teamlink-tests.in`,
    password: PW, phone: '93500' + String(10000 + seq).slice(-5), preferredLocation: 'Hyderabad', expectedCtc: 4,
    noticePeriod: 'Immediate', preferredWorkModes: ['Hybrid'],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  c.id = r.body.candidateId;
  return c;
}
const app = (id, jobId, c, cols) => raw(
  `insert into applications (id, job_id, candidate_id, recruiter_id, stage, source, match_score, ai_score, screening_combined_score, is_demo)
   values ($1, $2, $3, 'r_ps', 'applied', 'portal', $4, $5, $6, $7)`,
  [id, jobId, c.id, cols.match ?? null, cols.ai ?? null, cols.combined ?? null, !!cols.demo]);
const names = async (qs) => (await rec.get(`/api/candidates?limit=100&q=Scorer&${qs}`)).body.candidates.map((x) => x.name).sort();

test('boot', async () => {
  dbh = await startTestDb(DB_PORT);
  applyTestEnv(dbh.url, {
    PUBLIC_ORIGIN: base, DISABLE_BACKGROUND_WORK: 'true', AI_API_KEY: '',
    EMAIL_API_KEY: '', EMAIL_SMTP_HOST: '', EMAIL_SMTP_USER: '', EMAIL_SMTP_PASS: '',
    EMAILJS_SERVICE_ID: '', EMAILJS_TEMPLATE_ID: '', EMAILJS_PUBLIC_KEY: '', EMAILJS_PRIVATE_KEY: '',
    SMS_API_KEY: '', WHATSAPP_API_KEY: '',
  });
  raw = (sql, params) => dbh.db.query(sql, params);
  await raw(`insert into companies (id, name) values ('co_ps', 'Score Co')`);
  const { hashPassword } = await import('../src/auth.js');
  const u = (await raw(`insert into users (email,password_hash,role) values ('rec.ps@tl-sink.local',$1,'recruiter') returning id`, [await hashPassword(PW)])).rows[0].id;
  await raw(`insert into recruiters (id, user_id, name, email, company_id) values ('r_ps',$1,'Rec PS','rec.ps@tl-sink.local','co_ps')`, [u]);
  await raw(`insert into jobs (id, title, company_id, location, mode, exp_label, skills, status, recruiter_id, description, published_at)
             values ('j_ps', 'Scoring Role', 'co_ps', 'Hyderabad', 'Onsite', '1-3 yrs', ARRAY['Sourcing'], 'open', 'r_ps', 'Role.', now())`);
  const { createApp } = await import('../src/app.js');
  const a = createApp({ logger: { error() {}, log() {} } });
  await new Promise((r) => { server = a.listen(API_PORT, r); });
  rec = makeClient(base); await rec.get('/api/health');
  assert.equal((await rec.post('/api/auth/login', { email: 'rec.ps@tl-sink.local', password: PW, role: 'recruiter' })).status, 200);

  for (const n of ['Scorer High', 'Scorer Mid', 'Scorer Low', 'Scorer Never', 'Scorer Demo', 'Scorer Answers']) C[n] = await candidate(n);
  await app('a_hi', 'j_ps', C['Scorer High'], { match: 92, ai: 92 });
  await app('a_mid', 'j_ps', C['Scorer Mid'], { match: 66, ai: 66 });
  await app('a_low', 'j_ps', C['Scorer Low'], { match: 30, ai: 30 });
  await app('a_demo', 'j_ps', C['Scorer Demo'], { match: 99, ai: 99, demo: true });
  /* the screening answers lift this one: the combined score is the one the rule reads */
  await app('a_ans', 'j_ps', C['Scorer Answers'], { match: 40, ai: 40 });
  await raw(`update applications set screening_combined_score = 70 where id = 'a_ans'`);
  /* the resume scores (what the Resume score dropdown reads) */
  const rs = (c, total) => raw(`insert into candidate_resume_scores (candidate_id, status, total_score, label) values ($1, 'scored', $2, 'Good')`, [c.id, total]);
  await rs(C['Scorer High'], 85); await rs(C['Scorer Mid'], 72); await rs(C['Scorer Low'], 55); await rs(C['Scorer Never'], 95);
});

test('Overall score: the best application score, answers included; never-applied and sample rows left out', async () => {
  assert.deepEqual(await names(''), ['Scorer Answers', 'Scorer Demo', 'Scorer High', 'Scorer Low', 'Scorer Mid', 'Scorer Never']);
  assert.deepEqual(await names('overallScoreMin=90'), ['Scorer High']);
  assert.deepEqual(await names('overallScoreMin=65'), ['Scorer Answers', 'Scorer High', 'Scorer Mid'], '65 and over: the 66, the 92, and the 70 the answers made');
  assert.deepEqual(await names('overallScoreMin=50'), ['Scorer Answers', 'Scorer High', 'Scorer Mid']);
  assert.deepEqual(await names('overallScoreMin=1'), ['Scorer Answers', 'Scorer High', 'Scorer Low', 'Scorer Mid'], 'never applied: none; sample row: not counted');
});

test('Resume score and Overall score together, and an empty value means Any', async () => {
  assert.deepEqual(await names('resumeScoreMin=70'), ['Scorer High', 'Scorer Mid', 'Scorer Never']);
  assert.deepEqual(await names('resumeScoreMin=80&overallScoreMin=65'), ['Scorer High']);
  assert.deepEqual(await names('resumeScoreMin=70&overallScoreMin=65'), ['Scorer High', 'Scorer Mid']);
  assert.equal((await names('resumeScoreMin=&overallScoreMin=')).length, 6);
  assert.equal((await names('overallScoreMin=banana')).length, 6, 'a value that is not a number is ignored');
  const page = await rec.get('/api/candidates?limit=1&offset=1&q=Scorer&overallScoreMin=65');
  assert.equal(page.body.total, 3, 'the count is the filtered count');
  assert.equal(page.body.candidates.length, 1);
});

test('shutdown', async () => {
  await new Promise((r) => server.close(r));
  const { stopBackgroundWork } = await import('../src/app.js'); stopBackgroundWork();
  const { closePool } = await import('../src/db.js'); await closePool();
  await dbh.stop?.();
});
