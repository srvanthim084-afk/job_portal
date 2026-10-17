/**
 * An administrator can set a recruiter's password AS GIVEN (0154): it works exactly as typed and stays - no forced
 * change at first sign-in. Only an administrator can do it, only for the one recruiter named, the default is still
 * "ask them to change it", and the audit log records who and for whom, never the password.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb, applyTestEnv, makeClient } from './harness.mjs';

const DB_PORT = 5696;
const API_PORT = 9966;
const base = `http://127.0.0.1:${API_PORT}`;
const ADMIN_PW = 'AdminPass#2026x';
const GIVEN = 'Teamlink@2026';

let dbh, server, raw, admin;

async function login(email, password) {
  const c = makeClient(base);
  await c.get('/api/health');
  const r = await c.post('/api/auth/login', { email, password, role: email.startsWith('admin') ? 'admin' : 'recruiter' });
  return { c, r };
}

test('boot', async () => {
  dbh = await startTestDb(DB_PORT);
  applyTestEnv(dbh.url, { PUBLIC_ORIGIN: base, DISABLE_BACKGROUND_WORK: 'true' });
  raw = (sql, params) => dbh.db.query(sql, params);
  const { hashPassword } = await import('../src/auth.js');
  await raw(`insert into companies (id, name) values ('co_sp', 'Pw Co')`);
  const u = (await raw(`insert into users (email, password_hash, role) values ('admin.sp@tl-sink.local', $1, 'admin') returning id`, [await hashPassword(ADMIN_PW)])).rows[0].id;
  await raw(`insert into admins (id, user_id, name, email) values ('a_sp', $1, 'Admin SP', 'admin.sp@tl-sink.local')`, [u]);
  const { createApp } = await import('../src/app.js');
  const app = createApp({ logger: { error() {}, log() {} } });
  await new Promise((r) => { server = app.listen(API_PORT, r); });
  admin = (await login('admin.sp@tl-sink.local', ADMIN_PW)).c;
});

let rec1, rec2;
test('two recruiters exist, each with a temporary password they must change', async () => {
  const mk = async (n) => (await admin.post('/api/staff/recruiters', {
    name: `Recruiter ${n}`, email: `rec${n}.sp@tl-sink.local`, password: 'TempFirst#123', confirmPassword: 'TempFirst#123', companyId: 'co_sp' })).body.recruiter;
  rec1 = await mk(1); rec2 = await mk(2);
  const r = await login('rec1.sp@tl-sink.local', 'TempFirst#123');
  assert.equal(r.r.status, 200, JSON.stringify(r.r.body));
  assert.equal(r.r.body.session.mustChangePassword, true);
});

test('the default still asks the recruiter to change it (unchanged behaviour)', async () => {
  const r = await admin.post(`/api/staff/recruiters/${rec1.id}/password`, { password: 'AdminChose#456' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.mustChangePassword, true);
  const l = await login('rec1.sp@tl-sink.local', 'AdminChose#456');
  assert.equal(l.r.body.session.mustChangePassword, true);
});

test('set AS GIVEN: it works exactly as typed, with no forced change, and a wrong capital does not', async () => {
  const before2 = (await raw(`select password_hash from users where email='rec2.sp@tl-sink.local'`)).rows[0].password_hash;
  const r = await admin.post(`/api/staff/recruiters/${rec1.id}/password`, { password: GIVEN, mustChange: false });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.mustChangePassword, false);

  const ok = await login('rec1.sp@tl-sink.local', GIVEN);
  assert.equal(ok.r.status, 200, JSON.stringify(ok.r.body));
  assert.equal(ok.r.body.session.mustChangePassword, false, 'no forced change');
  assert.equal((await login('rec1.sp@tl-sink.local', 'TEAMLINk@2026')).r.status, 401, 'passwords are case sensitive');
  assert.equal((await login('rec1.sp@tl-sink.local', 'AdminChose#456')).r.status, 401, 'the old one is gone');

  /* only the named recruiter changed */
  assert.equal((await raw(`select password_hash from users where email='rec2.sp@tl-sink.local'`)).rows[0].password_hash, before2);
  assert.equal((await login('rec2.sp@tl-sink.local', 'TempFirst#123')).r.status, 200);

  /* signing in again and again changes nothing */
  const h1 = (await raw(`select password_hash from users where email='rec1.sp@tl-sink.local'`)).rows[0].password_hash;
  for (let i = 0; i < 3; i++) await login('rec1.sp@tl-sink.local', GIVEN);
  assert.equal((await raw(`select password_hash from users where email='rec1.sp@tl-sink.local'`)).rows[0].password_hash, h1);
});

test('only an administrator can do it, and the audit log never holds the password', async () => {
  const rec = (await login('rec2.sp@tl-sink.local', 'TempFirst#123')).c;
  const denied = await rec.post(`/api/staff/recruiters/${rec1.id}/password`, { password: 'Hacked#Pass1', mustChange: false });
  assert.equal(denied.status, 403);
  assert.equal((await login('rec1.sp@tl-sink.local', GIVEN)).r.status, 200, 'still the given password');
  assert.equal((await admin.post('/api/staff/recruiters/no_such/password', { password: GIVEN, mustChange: false })).status, 404);

  const log = (await raw(`select action, detail from audit_log where action = 'staff.password_set' order by id`)).rows;
  assert.ok(log.length >= 2);
  assert.ok(log.some((x) => x.detail.mustChangePassword === false));
  assert.doesNotMatch(JSON.stringify(log), /Teamlink@2026|AdminChose|TempFirst|Hacked/i);
});

test('after that the password changes ONLY when the recruiter changes it themself - and then THEIR choice stays', async () => {
  const mine = await login('rec1.sp@tl-sink.local', GIVEN);
  assert.equal(mine.r.status, 200);
  const hBefore = (await raw(`select password_hash from users where email='rec1.sp@tl-sink.local'`)).rows[0].password_hash;

  // nothing but the recruiter's own action touches it: repeated sign-ins, a second session, the background sweeps
  for (let i = 0; i < 3; i++) await login('rec1.sp@tl-sink.local', GIVEN);
  const sweeps = await import('../src/notify/interview-deadline.js');
  await sweeps.sweepInterviewDeadlines().catch(() => {});
  assert.equal((await raw(`select password_hash from users where email='rec1.sp@tl-sink.local'`)).rows[0].password_hash, hBefore);

  // the recruiter's own Change Password
  const wrong = await mine.c.post('/api/auth/password', { current: 'NotMyPassword#1', next: 'MyOwnChoice#2026' });
  assert.ok(wrong.status >= 400, 'the current password must be right');
  const ch = await mine.c.post('/api/auth/password', { current: GIVEN, next: 'MyOwnChoice#2026' });
  assert.equal(ch.status, 200, JSON.stringify(ch.body));
  assert.equal((await login('rec1.sp@tl-sink.local', 'MyOwnChoice#2026')).r.status, 200, 'their new password works');
  assert.equal((await login('rec1.sp@tl-sink.local', GIVEN)).r.status, 401, 'the given one is replaced because THEY changed it');
  const hOwn = (await raw(`select password_hash from users where email='rec1.sp@tl-sink.local'`)).rows[0].password_hash;
  for (let i = 0; i < 2; i++) await login('rec1.sp@tl-sink.local', 'MyOwnChoice#2026');
  assert.equal((await raw(`select password_hash from users where email='rec1.sp@tl-sink.local'`)).rows[0].password_hash, hOwn, 'their choice is not touched again');
});

test('an account created for a person (as when an admin adds an HRMS recruiter) keeps the temporary-password rule: first sign-in, then they choose their own', async () => {
  const made = await admin.post('/api/staff/recruiters', {
    name: 'From Hrms', email: 'hrms.person@tl-sink.local', password: 'HrmsTemp#2026', confirmPassword: 'HrmsTemp#2026', companyId: 'co_sp' });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const first = await login('hrms.person@tl-sink.local', 'HrmsTemp#2026');
  assert.equal(first.r.status, 200);
  assert.equal(first.r.body.session.mustChangePassword, true, 'asked to choose their own at the first sign-in');
  const ch = await first.c.post('/api/auth/password', { current: 'HrmsTemp#2026', next: 'TheirOwn#2026x' });
  assert.equal(ch.status, 200, JSON.stringify(ch.body));
  const again = await login('hrms.person@tl-sink.local', 'TheirOwn#2026x');
  assert.equal(again.r.status, 200);
  assert.equal(again.r.body.session.mustChangePassword, false);
  assert.equal((await login('hrms.person@tl-sink.local', 'HrmsTemp#2026')).r.status, 401);
});

test('shutdown', async () => {
  await new Promise((r) => server.close(r));
  const { stopBackgroundWork } = await import('../src/app.js');
  stopBackgroundWork();
  const { closePool } = await import('../src/db.js');
  await closePool();
  await dbh.stop?.();
});
