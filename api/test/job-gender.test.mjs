/**
 * Job gender (0072, 0142): Female, Male, All ("All genders") and Other - and nothing else.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb, applyTestEnv, makeClient } from './harness.mjs';

const DB_PORT = 5609;
const API_PORT = 9967;
const base = `http://127.0.0.1:${API_PORT}`;
const PW = 'JobGender123test';
let dbh, server, raw, rec;

test('boot', async () => {
  dbh = await startTestDb(DB_PORT);
  applyTestEnv(dbh.url, { PUBLIC_ORIGIN: base, DISABLE_BACKGROUND_WORK: 'true', AI_API_KEY: '', EMAIL_API_KEY: '', EMAIL_SMTP_HOST: '', EMAILJS_SERVICE_ID: '', SMS_API_KEY: '', WHATSAPP_API_KEY: '' });
  raw = (sql, params) => dbh.db.query(sql, params);
  await raw(`insert into companies (id, name) values ('co_jg', 'Gender Co')`);
  const { createApp } = await import('../src/app.js');
  const app = createApp({ logger: { error() {}, log() {} } });
  await new Promise((r) => { server = app.listen(API_PORT, r); });
  const { hashPassword } = await import('../src/auth.js');
  const u = (await raw(`insert into users (email,password_hash,role) values ('rec.jg@tl-sink.local',$1,'recruiter') returning id`, [await hashPassword(PW)])).rows[0].id;
  await raw(`insert into recruiters (id, user_id, name, email, company_id) values ('r_jg',$1,'Rec JG','rec.jg@tl-sink.local','co_jg')`, [u]);
  rec = makeClient(base); await rec.get('/api/health');
  assert.equal((await rec.post('/api/auth/login', { email: 'rec.jg@tl-sink.local', password: PW, role: 'recruiter' })).status, 200);
});

const post = (gender) => rec.post('/api/jobs', { title: `Gender ${gender}`, companyId: 'co_jg', location: 'Hyderabad', status: 'draft', gender });

test('All, Other, Female and Male are accepted and kept', async () => {
  for (const g of ['All', 'Other', 'Female', 'Male']) {
    const r = await post(g);
    assert.equal(r.status, 201, `${g}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.job.gender, g);
    assert.equal((await raw(`select gender from jobs where id = $1`, [r.body.job.id])).rows[0].gender, g);
  }
  const edit = await post('Female');
  const id = edit.body.job.id;
  const changed = await rec.put(`/api/jobs/${id}`, { ...edit.body.job, gender: 'All' });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.equal((await raw(`select gender from jobs where id = $1`, [id])).rows[0].gender, 'All', 'editing a job to All is kept');
});

test('anything else is refused, by the API and by the database', async () => {
  const bad = await post('Robot');
  assert.ok(bad.status === 400 || bad.status === 422, 'refused: ' + bad.status);
  await assert.rejects(raw(`insert into jobs (id, title, company_id, location, status, gender) values ('j_jg_x','X','co_jg','Pune','draft','Robot')`), /jobs_gender_known/);
});

test('shutdown', async () => {
  await new Promise((r) => server.close(r));
  const { stopBackgroundWork } = await import('../src/app.js'); stopBackgroundWork();
  const { closePool } = await import('../src/db.js'); await closePool();
  await dbh.stop?.();
});
