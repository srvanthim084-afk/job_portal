/**
 * "Send the login to everyone imported who is still waiting" (0156) - administrator only, with the count they were shown.
 *
 *   waiting = imported from a Naukri / Shine mail (open application, never sent the login email) or imported another way with no
 *             account and never invited; NOT do-not-contact, NOT without an address, NOT somebody who can already sign in, NOT staff
 *   each gets ONE message: their login (a temporary password only if they have never signed in) and, if they applied for a job,
 *   the AI interview to attend; running it again sends nothing
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb, applyTestEnv, makeClient } from './harness.mjs';

const DB_PORT = 5698;
const API_PORT = 9968;
const base = `http://127.0.0.1:${API_PORT}`;
const PW = 'BulkLogin#2026x';

let dbh, server, raw, admin, rec, providers;
const mails = [];
let n = 0;

async function candidate(id, { email = `${id}@tl-sink.local`, phone = null, account = null, source = null, importId = null, dnc = false } = {}) {
  let userId = null;
  if (account) {
    userId = (await raw(`insert into users (email, password_hash, role, must_change_password) values ($1, $2, 'candidate', $3) returning id`,
      [email || `${id}@tl-sink.local`, account.hash, account.mustChange])).rows[0].id;
  }
  await raw(`insert into candidates (id, name, email, phone, source, import_id, do_not_contact, user_id) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, `Cand ${id}`, email, phone, source, importId, dnc, userId]);
}
const app = (id, candidateId, method) => raw(
  `insert into applications (id, job_id, candidate_id, recruiter_id, import_method, stage) values ($1, 'j_bl1', $2, 'r_bl1', $3, 'applied')`, [id, candidateId, method]);
const mailTo = (id) => mails.filter((m) => m.to === `${id}@tl-sink.local`);
const hashOf = async (email) => (await raw(`select password_hash h from users where email = $1`, [email])).rows[0]?.h;
const waitDone = async () => {
  for (let i = 0; i < 80; i++) { const s = (await admin.get('/api/intake/send-logins/status')).body; if (!s.running && s.finishedAt) return s; await new Promise((r) => setTimeout(r, 150)); }
  throw new Error('the run did not finish');
};

test('boot', async () => {
  dbh = await startTestDb(DB_PORT);
  applyTestEnv(dbh.url, { PUBLIC_ORIGIN: base, DISABLE_BACKGROUND_WORK: 'true', BULK_LOGIN_PAUSE_MS: '0', INTAKE_NOTIFY_CANDIDATES: 'true' });
  raw = (sql, params) => dbh.db.query(sql, params);
  const { hashPassword } = await import('../src/auth.js');
  const hash = await hashPassword(PW);
  await raw(`insert into companies (id, name) values ('co_bl', 'Bulk Co')`);
  const au = (await raw(`insert into users (email, password_hash, role) values ('admin.bl@tl-sink.local', $1, 'admin') returning id`, [hash])).rows[0].id;
  await raw(`insert into admins (id, user_id, name, email) values ('a_bl', $1, 'Admin BL', 'admin.bl@tl-sink.local')`, [au]);
  const ru = (await raw(`insert into users (email, password_hash, role) values ('rec.bl@tl-sink.local', $1, 'recruiter') returning id`, [hash])).rows[0].id;
  await raw(`insert into recruiters (id, user_id, name, email, company_id) values ('r_bl1', $1, 'Rec BL', 'rec.bl@tl-sink.local', 'co_bl')`, [ru]);
  await raw(`insert into jobs (id, title, company_id, location, mode, exp_label, skills, status, recruiter_id, description, published_at)
             values ('j_bl1', 'Staff Nurse', 'co_bl', 'Hyderabad', 'Onsite', '1-3 yrs', $1, 'open', 'r_bl1', 'x', now())`, [['Care']]);
  await raw(`insert into candidate_imports (id, filename, format, total_rows, created_count) values ('imp_bl', 'f.xlsx', 'xlsx', 3, 3)`);

  // ---- waiting, from a Naukri / Shine mail ----
  await candidate('m1', { account: { hash, mustChange: true } });                 // account never signed in -> a fresh temporary password
  await app('app_m1', 'm1', 'recruiter_email');
  await candidate('m2', { account: { hash, mustChange: false } });                // chose their own password -> never reset
  await app('app_m2', 'm2', 'recruiter_email');
  await candidate('m6');                                                          // no account yet
  await app('app_m6', 'm6', 'recruiter_email');
  // ---- waiting, imported another way ----
  await candidate('s1', { importId: 'imp_bl' });                                  // a file, no job
  await candidate('s1b', { importId: 'imp_bl' });                                 // a file, but already applied on the portal
  await app('app_s1b', 's1b', null);
  await candidate('s4', { source: null, email: null, phone: '9876500001' });      // phone only
  // ---- NOT waiting ----
  await candidate('m3', { account: { hash, mustChange: true } });                 // already told
  await app('app_m3', 'm3', 'recruiter_email');
  await raw(`update applications set import_login_notified_at = now() where id = 'app_m3'`);
  await candidate('m4', { dnc: true, account: { hash, mustChange: true } });      // do not contact
  await app('app_m4', 'm4', 'recruiter_email');
  await candidate('m5', { email: null });                                         // mail import with no email address
  await app('app_m5', 'm5', 'recruiter_email');
  await candidate('s2', { importId: 'imp_bl', account: { hash, mustChange: false } });   // already signs in
  await candidate('s3', { source: 'Direct Registration' });                       // registered themselves: not imported
  await candidate('s5', { importId: 'imp_bl', dnc: true });                       // do not contact

  const { createApp } = await import('../src/app.js');
  ({ providers } = await import('../src/notify/providers.js'));
  providers.email.send = async (m) => { mails.push(m); return { status: 'sent', provider: 'test' }; };
  const texts = [];
  providers.sms.send = async (m) => { texts.push(m); return { status: 'sent', provider: 'test' }; };
  providers.whatsapp.send = async () => ({ status: 'sent', provider: 'test' });
  globalThis.__texts = texts;
  const a = createApp({ logger: { error() {}, log() {} } });
  await new Promise((r) => { server = a.listen(API_PORT, r); });
  const login = async (email, role) => { const c = makeClient(base); await c.get('/api/health'); const r = await c.post('/api/auth/login', { email, password: PW, role }); assert.equal(r.status, 200, JSON.stringify(r.body)); return c; };
  admin = await login('admin.bl@tl-sink.local', 'admin');
  rec = await login('rec.bl@tl-sink.local', 'recruiter');
});

test('administrator only; and it shows who is waiting before anything is sent', async () => {
  assert.equal((await rec.get('/api/intake/send-logins/pending')).status, 403);
  assert.equal((await rec.post('/api/intake/send-logins', { confirm: true, expected: 1 })).status, 403);
  const p = await admin.get('/api/intake/send-logins/pending');
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.deepEqual([p.body.mail, p.body.sourced, p.body.total], [3, 3, 6]);
  assert.equal(mails.length, 0, 'looking sends nothing');
});

test('it refuses to start without the confirmation, or with a count that is not the one that was shown', async () => {
  assert.equal((await admin.post('/api/intake/send-logins', { expected: 6 })).status, 422);
  assert.equal((await admin.post('/api/intake/send-logins', { confirm: false, expected: 6 })).status, 422);
  const wrong = await admin.post('/api/intake/send-logins', { confirm: true, expected: 5 });
  assert.equal(wrong.status, 409, JSON.stringify(wrong.body));
  assert.match(wrong.body.error.message, /changed from 5 to 6/);
  assert.equal(mails.length, 0);
});

test('the run sends each waiting person ONE message: login, and the interview if they have applied', async () => {
  const hashM2 = await hashOf('m2@tl-sink.local');
  const hashM1 = await hashOf('m1@tl-sink.local');
  const staffHash = await hashOf('rec.bl@tl-sink.local');
  const adminHash = await hashOf('admin.bl@tl-sink.local');

  const st = await admin.post('/api/intake/send-logins', { confirm: true, expected: 6 });
  assert.equal(st.status, 202, JSON.stringify(st.body));
  const done = await waitDone();
  assert.deepEqual([done.total, done.sent, done.failed], [6, 6, 0], JSON.stringify(done));

  // from a mail import: the login AND the interview
  const m1 = mailTo('m1');
  assert.equal(m1.length, 1);
  assert.match(m1[0].text, /Temporary password: \S{8,}/, 'a never-signed-in account gets a fresh temporary password');
  assert.match(m1[0].text, /Attend your AI interview:/);
  assert.match(m1[0].text, /Staff Nurse|Applied Role: Staff Nurse/);
  assert.notEqual(await hashOf('m1@tl-sink.local'), hashM1, 'and that password is now the one in the email');
  const m2 = mailTo('m2');
  assert.equal(m2.length, 1);
  assert.doesNotMatch(m2[0].text, /Temporary password/, 'somebody who chose their own password gets no new one');
  assert.match(m2[0].text, /sign in with your existing password/);
  assert.equal(await hashOf('m2@tl-sink.local'), hashM2, 'and their password is untouched');
  assert.equal(mailTo('m6').length, 1);

  // imported another way: a login; the interview only if they had applied
  const s1 = mailTo('s1');
  assert.equal(s1.length, 1);
  assert.match(s1[0].text, /Login Email: s1@tl-sink\.local/);
  assert.match(s1[0].text, /Temporary Password: \S{8,}/);
  assert.doesNotMatch(s1[0].text, /AI interview is waiting/, 'nobody applied, so there is no interview to attend');
  const s1b = mailTo('s1b');
  assert.equal(s1b.length, 1);
  assert.match(s1b[0].text, /your AI interview is waiting for you/);
  assert.match(s1b[0].text, /- Staff Nurse: /);
  assert.match(s1b[0].text, /press "Attend AI Interview"/);

  // the people who must not be written to were not
  for (const id of ['m3', 'm4', 'm5', 's2', 's3', 's5']) assert.equal(mailTo(id).length, 0, `${id} must not be emailed`);
  assert.equal(mails.length, 5, 'five emails (the sixth person has only a phone number)');
  const s4 = globalThis.__texts.filter((t) => String(t.to).endsWith('9876500001'));
  assert.equal(s4.length, 1, 'the phone-only candidate was reached by SMS, once');
  assert.doesNotMatch(String(s4[0].text), /Temporary password|password:/i, 'a text message never carries the password');
  // staff are never touched
  assert.equal(await hashOf('rec.bl@tl-sink.local'), staffHash);
  assert.equal(await hashOf('admin.bl@tl-sink.local'), adminHash);
  // everything was recorded
  assert.equal((await raw(`select count(*)::int n from applications where import_method='recruiter_email' and import_login_notified_at is not null`)).rows[0].n, 4);
  assert.ok((await raw(`select 1 from audit_log where action = 'intake.login_bulk_finished'`)).rowCount >= 1);
});

test('nothing is left waiting, and running it again sends nothing', async () => {
  const p = await admin.get('/api/intake/send-logins/pending');
  assert.deepEqual([p.body.mail, p.body.sourced, p.body.total], [0, 0, 0]);
  const before = mails.length;
  const again = await admin.post('/api/intake/send-logins', { confirm: true, expected: 0 });
  assert.equal(again.status, 202);
  await waitDone();
  assert.equal(mails.length, before);
});

test('shutdown', async () => {
  await new Promise((r) => server.close(r));
  const { stopBackgroundWork } = await import('../src/app.js');
  stopBackgroundWork();
  const { closePool } = await import('../src/db.js');
  await closePool();
  await dbh.stop?.();
});
