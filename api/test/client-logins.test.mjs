/**
 * POST /api/staff/clients - an administrator gives a client company a login.
 *
 * The same rules as a recruiter login: administrators only (route AND
 * database function), a temporary password that must be changed at first
 * sign-in, never returned, one address one login, a company that exists,
 * and an audit row that never holds the password.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb, applyTestEnv, makeClient } from './harness.mjs';

const DB_PORT = 5486;
const API_PORT = 9976;
const PW = 'StaffTest123';

let dbh, server, base, hashPassword;
const raw = (sql, params) => dbh.db.query(sql, params);

async function person(table, role, id, extra = {}) {
  const email = `${id}@staff-test.local`;
  const u = await raw(`insert into users (email, password_hash, role) values ($1,$2,$3) returning id`,
    [email, await hashPassword(PW), role]);
  const cols = ['id', 'user_id', 'name', 'email', ...Object.keys(extra)];
  const vals = [id, u.rows[0].id, `${role} ${id}`, email, ...Object.values(extra)];
  await raw(`insert into ${table} (${cols.join(',')}) values (${cols.map((_, i) => `$${i + 1}`).join(',')})`, vals);
  return email;
}
async function signIn(email, password = PW) {
  const c = makeClient(base);
  await c.get('/api/health');
  const r = await c.post('/api/auth/login', { email, password });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  c.login = r.body;
  return c;
}

test('boot', async () => {
  dbh = await startTestDb(DB_PORT);
  applyTestEnv(dbh.url, { PUBLIC_ORIGIN: `http://127.0.0.1:${API_PORT}`, DISABLE_BACKGROUND_WORK: 'true' });
  ({ hashPassword } = await import('../src/auth.js'));
  await raw(`insert into companies (id, name) values ('co_cl', 'Client Test Co')`);
  await person('admins', 'admin', 'a_st');
  await person('recruiters', 'recruiter', 'r_st', { company_id: 'co_cl', title: 'Recruiter' });
  const { createApp } = await import('../src/app.js');
  const app = createApp({ logger: { error() {}, log() {} } });
  await new Promise((r) => { server = app.listen(API_PORT, r); });
  base = `http://127.0.0.1:${API_PORT}`;
});

test('an administrator creates a client login: temporary password, never returned, audited', async () => {
  const admin = await signIn('a_st@staff-test.local');
  const r = await admin.post('/api/staff/clients', {
    name: 'Kavya Hiring', email: 'Kavya.Hiring@Client-Test.local', password: 'TempPass#2026', confirmPassword: 'TempPass#2026',
    companyId: 'co_cl', title: 'Hiring Manager',
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.mustChangePassword, true);
  assert.equal(r.body.client.email, 'kavya.hiring@client-test.local');
  assert.equal(r.body.client.companyId, 'co_cl');
  assert.ok(/^c_/.test(r.body.client.id));
  assert.ok(!JSON.stringify(r.body).includes('TempPass'), 'the password is never returned');

  const u = (await raw(`select role, status, must_change_password, password_hash from users where email=$1`, ['kavya.hiring@client-test.local'])).rows[0];
  assert.equal(u.role, 'client');
  assert.equal(u.must_change_password, true);
  assert.ok(u.password_hash.startsWith('$2'), 'stored hashed');

  const audit = (await raw(`select * from staff_audit where target_id=$1`, [r.body.client.id])).rows;
  assert.equal(audit.length, 1);
  assert.equal(audit[0].action, 'client_login_created');
  assert.equal(audit[0].detail.companyId, 'co_cl');
  assert.ok(audit[0].actor_id, 'who did it');
  assert.ok(!JSON.stringify(audit[0]).includes('TempPass') && !JSON.stringify(audit[0]).includes('$2'), 'no password in the audit');
});

test('the client signs in, must change the temporary password, then works normally', async () => {
  const c = await signIn('kavya.hiring@client-test.local', 'TempPass#2026');
  assert.equal(c.login.session.role, 'client');
  assert.equal(c.login.session.mustChangePassword, true);
  const ch = await c.post('/api/auth/password', { current: 'TempPass#2026', next: 'MyOwnPass#77' });
  assert.equal(ch.status, 200, JSON.stringify(ch.body));
  const again = await signIn('kavya.hiring@client-test.local', 'MyOwnPass#77');
  assert.equal(again.login.session.mustChangePassword, false);
  const me = await again.get('/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.session.role, 'client');
});

test('refused: not an administrator, a taken address, an unknown company, a bad form', async () => {
  const rec = await signIn('r_st@staff-test.local');
  const body = { name: 'X Person', email: 'x.person@client-test.local', password: 'TempPass#2026', companyId: 'co_cl' };
  assert.equal((await rec.post('/api/staff/clients', body)).status, 403);
  const anon = makeClient(base); await anon.get('/api/health');
  assert.equal((await anon.post('/api/staff/clients', body)).status, 401);

  const admin = await signIn('a_st@staff-test.local');
  const taken = await admin.post('/api/staff/clients', { ...body, email: 'KAVYA.hiring@client-test.local' });
  assert.equal(taken.status, 409);
  assert.equal(taken.body.error.code, 'EMAIL_TAKEN');
  assert.equal((await admin.post('/api/staff/clients', { ...body, companyId: 'no_such_co' })).status, 404);
  assert.equal((await admin.post('/api/staff/clients', { ...body, password: 'short' })).status, 422);
  assert.equal((await admin.post('/api/staff/clients', { ...body, confirmPassword: 'Different#1' })).status, 400);
  assert.equal((await admin.post('/api/staff/clients', { ...body, email: 'not-an-email' })).status, 422);
  assert.equal((await raw(`select count(*)::int as n from users where email='x.person@client-test.local'`)).rows[0].n, 0);
});

test('the database function itself refuses a non-administrator', async () => {
  await assert.rejects(dbh.db.exec(`begin; select set_config('app.role','recruiter',true);
    select staff_client_create('Y', 'y@client-test.local', '$2a$10$abcdefghijklmnopqrstuv', 'co_cl', null); commit;`), /only an administrator/);
  await dbh.db.exec('rollback');
  assert.equal((await raw(`select count(*)::int as n from users where email='y@client-test.local'`)).rows[0].n, 0);
});

test('shutdown', async () => {
  await new Promise((r) => server.close(r));
  const { closePool } = await import('../src/db.js');
  await closePool();
  await dbh.stop();
});
