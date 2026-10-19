/**
 * "How was this score worked out?" (GET /api/candidates/:id/match-breakdown)
 *
 *   - staff only
 *   - a candidate with none of the job's skills is held to 20% at most, and the working says so (this is why a good profile can show 20%)
 *   - a candidate with the skills is not held down, and the skills found / not found are listed
 *   - the stored score and the live one are both shown, and a difference is flagged
 *   - a candidate who never applied has nothing to explain
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb, applyTestEnv, makeClient } from './harness.mjs';

const DB_PORT = 5704;
const API_PORT = 9975;
const base = `http://127.0.0.1:${API_PORT}`;
const PW = 'Why#2026xyzabc';
let dbh, server, raw, rec, cand;

test('boot', async () => {
  dbh = await startTestDb(DB_PORT);
  applyTestEnv(dbh.url, { PUBLIC_ORIGIN: base, DISABLE_BACKGROUND_WORK: 'true' });
  raw = (sql, params) => dbh.db.query(sql, params);
  const { hashPassword } = await import('../src/auth.js');
  await raw(`insert into companies (id, name) values ('co_mb', 'Why Co')`);
  const u = (await raw(`insert into users (email, password_hash, role) values ('rec.mb@tl-sink.local', $1, 'recruiter') returning id`, [await hashPassword(PW)])).rows[0].id;
  await raw(`insert into recruiters (id, user_id, name, email, company_id) values ('r_mb', $1, 'Rec MB', 'rec.mb@tl-sink.local', 'co_mb')`, [u]);
  await raw(`insert into jobs (id, title, company_id, location, mode, exp_label, skills, status, recruiter_id, description, published_at)
             values ('j_mb', 'ICU Nurse', 'co_mb', 'Nellore', 'Onsite', '2-5 yrs', '{ICU,Ventilator,Triage}', 'open', 'r_mb', 'x', now())`);
  await raw(`insert into candidates (id, name, email, phone, location, skills, technical_skills, exp_years) values
             ('c_none', 'Nurse Educator', 'none@tl-sink.local', '9876500101', 'Nellore', '{Teaching,Simulation}', '{}', 12),
             ('c_good', 'ICU Veteran', 'good@tl-sink.local', '9876500102', 'Nellore', '{ICU,Ventilator,Triage}', '{}', 3),
             ('c_noapp', 'Never Applied', 'noapp@tl-sink.local', '9876500103', 'Nellore', '{}', '{}', 1)`);
  await raw(`insert into applications (id, job_id, candidate_id, recruiter_id, stage, match_score) values
             ('a_none', 'j_mb', 'c_none', 'r_mb', 'applied', 20), ('a_good', 'j_mb', 'c_good', 'r_mb', 'applied', 55)`);
  const { createApp } = await import('../src/app.js');
  const app = createApp({ logger: { error() {}, log() {} } });
  await new Promise((r) => { server = app.listen(API_PORT, r); });
  rec = makeClient(base); await rec.get('/api/health');
  assert.equal((await rec.post('/api/auth/login', { email: 'rec.mb@tl-sink.local', password: PW, role: 'recruiter' })).status, 200);
  const cu = (await raw(`insert into users (email, password_hash, role) values ('cand.mb@tl-sink.local', $1, 'candidate') returning id`, [await hashPassword(PW)])).rows[0].id;
  await raw(`insert into candidates (id, name, email, user_id) values ('c_login', 'Login Cand', 'cand.mb@tl-sink.local', $1)`, [cu]);
  cand = makeClient(base); await cand.get('/api/health');
  assert.equal((await cand.post('/api/auth/login', { email: 'cand.mb@tl-sink.local', password: PW, role: 'candidate' })).status, 200);
});

test('staff only', async () => {
  const anon = makeClient(base); await anon.get('/api/health');
  assert.equal((await anon.get('/api/candidates/c_none/match-breakdown')).status, 401);
  assert.equal((await cand.get('/api/candidates/c_none/match-breakdown')).status, 403);
});

test('none of the job\'s skills: held to 20% at most, and it says why', async () => {
  const r = await rec.get('/api/candidates/c_none/match-breakdown?score=20');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const a = r.body.applications[0];
  assert.equal(a.jobTitle, 'ICU Nurse');
  assert.equal(a.storedScore, 20);
  assert.ok(a.liveScore <= 20, `live ${a.liveScore}`);
  assert.equal(a.ceiling, 20);
  assert.deepEqual(a.skills.missing.map((x) => x.toLowerCase()).sort(), ['icu', 'triage', 'ventilator']);
  assert.deepEqual(a.skills.matched, []);
  const skills = a.parts.find((p) => p.key === 'skills');
  assert.equal(skills.scored, 0);
  assert.deepEqual(a.parts.map((p) => p.key), ['skills', 'experience', 'education', 'location']);
  assert.ok(a.parts.every((p) => typeof p.note === 'string'));
  assert.equal(a.differs, false);
  assert.ok(!JSON.stringify(r.body).includes('resume_text'), 'the resume text is never returned');
});

test('all of the skills: not held down, and they are listed as found', async () => {
  const a = (await rec.get('/api/candidates/c_good/match-breakdown')).body.applications[0];
  assert.deepEqual(a.skills.matched.map((x) => x.toLowerCase()).sort(), ['icu', 'triage', 'ventilator']);
  assert.deepEqual(a.skills.missing, []);
  assert.equal(a.cappedBySkills, false);
  assert.ok(a.liveScore > 60, `live ${a.liveScore}`);
  assert.equal(a.storedScore, 55);
  assert.equal(a.differs, true, 'the stored 55 and the live score differ and the screen says so');
});

test('one of three skills: the ceiling is shown, and the score never goes above it', async () => {
  await raw(`insert into candidates (id, name, email, phone, location, skills, technical_skills, exp_years) values ('c_part', 'Part Match', 'part@tl-sink.local', '9876500104', 'Nellore', '{ICU}', '{}', 3)`);
  await raw(`insert into applications (id, job_id, candidate_id, recruiter_id, stage, match_score) values ('a_part', 'j_mb', 'c_part', 'r_mb', 'applied', 47)`);
  const a = (await rec.get('/api/candidates/c_part/match-breakdown')).body.applications[0];
  assert.equal(a.ceiling, 47);
  assert.ok(a.liveScore <= 47);
  assert.equal(a.cappedBySkills, a.weightedScore > 47);
  assert.deepEqual(a.skills.matched.map((x) => x.toLowerCase()), ['icu']);
  assert.equal(a.skills.missing.length, 2);
});

test('a candidate who never applied has nothing to explain', async () => {
  const r = await rec.get('/api/candidates/c_noapp/match-breakdown');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.applications, []);
  assert.match(r.body.note, /has not applied/);
  assert.equal((await rec.get('/api/candidates/nobody/match-breakdown')).status, 404);
});

test('shutdown', async () => {
  await new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
  await dbh.stop();
});
