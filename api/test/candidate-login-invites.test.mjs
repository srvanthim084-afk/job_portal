/**
 * Candidates brought in by IMPORT or added by hand get their portal login by email - and, when they have already applied
 * for a job, the AI interview to attend - once each.
 *
 *   + Add Candidate : the login goes out by default
 *   Import Data     : the login goes out when the wizard's box is ticked (it is ticked by default in the page); not otherwise
 *   an invitation never repeats, never reaches somebody marked do-not-contact, and tells an applicant which interview to attend
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb, applyTestEnv, makeClient } from './harness.mjs';

const DB_PORT = 5700;
const API_PORT = 9970;
const base = `http://127.0.0.1:${API_PORT}`;
const PW = 'InviteTest#2026x';

let dbh, server, raw, rec;
const mails = [];
const to = (email) => mails.filter((m) => m.to === email);
const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

test('boot', async () => {
  dbh = await startTestDb(DB_PORT);
  applyTestEnv(dbh.url, { PUBLIC_ORIGIN: base, DISABLE_BACKGROUND_WORK: 'true', INVITE_WAIT_MS: '8000' });
  raw = (sql, params) => dbh.db.query(sql, params);
  const { hashPassword } = await import('../src/auth.js');
  await raw(`insert into companies (id, name) values ('co_ci', 'Invite Co')`);
  const ru = (await raw(`insert into users (email, password_hash, role) values ('rec.ci@tl-sink.local', $1, 'recruiter') returning id`, [await hashPassword(PW)])).rows[0].id;
  await raw(`insert into recruiters (id, user_id, name, email, company_id) values ('r_ci1', $1, 'Rec CI', 'rec.ci@tl-sink.local', 'co_ci')`, [ru]);
  await raw(`insert into jobs (id, title, company_id, location, mode, exp_label, skills, status, recruiter_id, description, published_at)
             values ('j_ci1', 'Lab Technician', 'co_ci', 'Hyderabad', 'Onsite', '1-3 yrs', $1, 'open', 'r_ci1', 'x', now())`, [['Care']]);
  const { createApp } = await import('../src/app.js');
  const { providers } = await import('../src/notify/providers.js');
  providers.email.send = async (m) => { mails.push(m); return { status: 'sent', provider: 'test' }; };
  providers.sms.send = async () => ({ status: 'sent', provider: 'test' });
  providers.whatsapp.send = async () => ({ status: 'sent', provider: 'test' });
  const app = createApp({ logger: { error() {}, log() {} } });
  await new Promise((r) => { server = app.listen(API_PORT, r); });
  rec = makeClient(base);
  await rec.get('/api/health');
  assert.equal((await rec.post('/api/auth/login', { email: 'rec.ci@tl-sink.local', password: PW, role: 'recruiter' })).status, 200);
});

test('+ Add Candidate: the login is emailed by default (no applications, so no interview section)', async () => {
  const r = await rec.post('/api/candidates', { firstName: 'Added', lastName: 'Person', phone: '9811111111', email: 'added.ci@tl-sink.local', gender: 'Female' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  await settle();
  const m = to('added.ci@tl-sink.local');
  assert.equal(m.length, 1, 'exactly one email');
  assert.match(m[0].text, /Login Email: added\.ci@tl-sink\.local/);
  assert.match(m[0].text, /Temporary Password: \S{8,}/);
  assert.doesNotMatch(m[0].text, /AI interview is waiting/);
});

test('Import Data: ticked (invite=true) every imported person gets the login once; not ticked, nobody is contacted', async () => {
  const csv = (a, b) => `Name,Email,Phone\nImp One,${a},9822222221\nImp Two,${b},9822222222\n`;
  const off = await rec.post('/api/candidates/import', { text: csv('off1.ci@tl-sink.local', 'off2.ci@tl-sink.local') });
  assert.equal(off.status, 201, JSON.stringify(off.body));
  assert.equal(off.body.invited, 0);
  await settle();
  assert.equal(mails.filter((m) => /off[12]\.ci@/.test(m.to)).length, 0, 'unticked: nobody contacted');

  const on = await rec.post('/api/candidates/import', { text: csv('on1.ci@tl-sink.local', 'on2.ci@tl-sink.local'), invite: 'true' });
  assert.equal(on.status, 201, JSON.stringify(on.body));
  assert.equal(on.body.invited, 2);
  await settle(1500);
  for (const e of ['on1.ci@tl-sink.local', 'on2.ci@tl-sink.local']) {
    assert.equal(to(e).length, 1, `${e} gets exactly one email`);
    assert.match(to(e)[0].text, /Temporary Password: \S{8,}/);
  }
  // the same file again: nobody is invited twice
  await rec.post('/api/candidates/import', { text: csv('on1.ci@tl-sink.local', 'on2.ci@tl-sink.local'), invite: 'true' });
  await settle(1500);
  assert.equal(to('on1.ci@tl-sink.local').length, 1);
  assert.equal(to('on2.ci@tl-sink.local').length, 1);
});

test('somebody who has already applied is told which interview to attend, with their login', async () => {
  const id = (await raw(`select id from candidates where email = 'on1.ci@tl-sink.local'`)).rows[0].id;
  await raw(`insert into applications (id, job_id, candidate_id, recruiter_id, stage) values ('app_ci1', 'j_ci1', $1, 'r_ci1', 'applied')`, [id]);
  const before = mails.length;
  const r = await rec.post(`/api/candidates/${id}/invite`, { resend: true });
  assert.ok(r.status === 200 || r.status === 201, JSON.stringify(r.body));
  await settle();
  const m = mails.slice(before).filter((x) => x.to === 'on1.ci@tl-sink.local');
  assert.equal(m.length, 1, JSON.stringify(mails.slice(before).map((x) => x.to)));
  assert.match(m[0].text, /your AI interview is waiting for you/);
  assert.match(m[0].text, /- Lab Technician: /);
  assert.match(m[0].text, /press "Attend AI Interview"/);
  assert.match(m[0].text, /Temporary Password: \S{8,}/);
});

test('somebody marked do-not-contact is never written to', async () => {
  await raw(`insert into candidates (id, name, email, source, do_not_contact) values ('c_dnc_ci', 'No Contact', 'dnc.ci@tl-sink.local', 'Bulk Import', true)`);
  const { inviteCandidate } = await import('../src/notify/invite.js');
  const out = await inviteCandidate({ id: 'c_dnc_ci', name: 'No Contact', email: 'dnc.ci@tl-sink.local', phone: null }, { invitedBy: 'test' });
  assert.equal(out.invited, false);
  assert.equal(to('dnc.ci@tl-sink.local').length, 0);
});

test('shutdown', async () => {
  await new Promise((r) => server.close(r));
  const { stopBackgroundWork } = await import('../src/app.js');
  stopBackgroundWork();
  const { closePool } = await import('../src/db.js');
  await closePool();
  await dbh.stop?.();
});
