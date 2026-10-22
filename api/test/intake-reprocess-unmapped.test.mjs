/**
 * Candidates imported from a Shine / Naukri email whose role was refused as "a sentence" have NO application (the message says
 * "needs a requirement"). This puts them where they belong:
 *
 *   - the role rule counts real words, so "Urgent | Hiring For BRANDING & MARKETING / CREATIVE CONTENT STRATEGIST" is a title (a real sentence is not)
 *   - the waiting messages are imported again: the requirement is created from the title, the EXISTING candidate is matched (no duplicate),
 *     the application is created and the message becomes "imported"
 *   - nobody is written to: no email / SMS / WhatsApp leaves, and the login waits under the administrator's "Send login emails" count
 *   - a recruiter's button imports only their own mailboxes' messages; an administrator's, all of them
 *   - what still cannot be turned into a requirement stays waiting
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb, applyTestEnv, makeClient } from './harness.mjs';

const DB_PORT = 5707;
const API_PORT = 9981;
const base = `http://127.0.0.1:${API_PORT}`;
const PW = 'Reproc#2026xyz';
const LONG = 'Urgent | Hiring For BRANDING & MARKETING / CREATIVE CONTENT STRATEGIST';

let dbh, server, raw, admin, recA, recB, roleTitle;
const sentOut = [];
let n = 0;
const id = (p) => `${p}_${Date.now().toString(36)}${(n++).toString(36)}`;

function shineRaw(name, mail, phone, role) {
  return [
    `Message-ID: <${id('m')}@mailer.test>`, 'From: Shine <recruiters@alerts.shine.com>', 'To: inbox@tl-mailbox-test.in',
    `Subject: Email Response-${role}`, `Date: ${new Date().toUTCString()}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '',
    [`You have received an email response for ${role}.`, 'The candidate profile is detailed below:', `Candidate Name: ${name}`, `Email: ${mail}`,
      `Mobile: ${phone}`, `Applied Role: ${role}`, 'Experience: 3 Yrs 0 Month', 'Skills: branding, marketing, content'].join('\r\n'), '',
  ].join('\r\n');
}
async function waiting(mailbox, name, mail, phone, role = LONG) {
  const cand = id('cand');
  await raw(`insert into candidates (id, name, email, phone, location) values ($1,$2,$3,$4,'Hyderabad')`, [cand, name, mail, phone]);
  const mid = id('msg');
  await raw(`insert into email_messages (id, mailbox_id, message_id, from_address, to_address, subject, status, reason, raw, candidate_id)
             values ($1,$2,$3,'recruiters@alerts.shine.com','inbox@tl-mailbox-test.in',$4,'needs_mapping','Applied role could not be identified',$5,$6)`,
    [mid, mailbox, id('mid'), `Email Response-${role}`, shineRaw(name, mail, phone, role), cand]);
  return { cand, mid };
}
async function staff(email, role, rid) {
  const { hashPassword } = await import('../src/auth.js');
  const u = (await raw(`insert into users (email, password_hash, role) values ($1,$2,$3) returning id`, [email, await hashPassword(PW), role])).rows[0].id;
  if (role === 'recruiter') await raw(`insert into recruiters (id, user_id, name, email, company_id) values ($1,$2,$3,$4,'co_rp')`, [rid, u, `Rec ${rid}`, email]);
  else await raw(`insert into admins (id, user_id, name, email) values ($1,$2,'Admin RP',$3)`, [rid, u, email]);
  const c = makeClient(base); await c.get('/api/health');
  assert.equal((await c.post('/api/auth/login', { email, password: PW, role })).status, 200);
  return c;
}
const appsOf = async (cand) => (await raw(`select a.id, a.import_login_notified_at, j.title, j.status from applications a join jobs j on j.id = a.job_id where a.candidate_id = $1`, [cand])).rows;
const status = async (mid) => (await raw(`select status, application_id from email_messages where id = $1`, [mid])).rows[0];

test('boot', async () => {
  dbh = await startTestDb(DB_PORT);
  applyTestEnv(dbh.url, { PUBLIC_ORIGIN: base, DISABLE_BACKGROUND_WORK: 'true', INTAKE_NOTIFY_CANDIDATES: 'true', AI_API_KEY: '' });
  raw = (sql, params) => dbh.db.query(sql, params);
  await raw(`insert into companies (id, name) values ('co_rp', 'Reprocess Co')`);
  ({ roleTitle } = await import('../src/intake/process.js'));
  const { providers } = await import('../src/notify/providers.js');
  for (const ch of ['email', 'sms', 'whatsapp']) providers[ch].send = async (m) => { sentOut.push([ch, m.to]); return { status: 'sent', provider: 'test' }; };
  const { createApp } = await import('../src/app.js');
  const app = createApp({ logger: { error() {}, log() {} } });
  await new Promise((r) => { server = app.listen(API_PORT, r); });
  await new Promise((r) => setTimeout(r, 1200));
  admin = await staff('admin.rp@tl-sink.local', 'admin', 'a_rp');
  recA = await staff('a.rp@tl-sink.local', 'recruiter', 'r_rpa');
  recB = await staff('b.rp@tl-sink.local', 'recruiter', 'r_rpb');
  await raw(`insert into email_mailboxes (id, address, provider, source, recruiter_id, status) values
             ('mbx_rpa', 'a.shine@tl-mailbox-test.in', 'imap', 'shine', 'r_rpa', 'connected'), ('mbx_rpb', 'b.shine@tl-mailbox-test.in', 'imap', 'shine', 'r_rpb', 'connected')`);
});

test('the role rule counts words, not the symbols a board puts between them', () => {
  assert.equal(roleTitle(LONG), LONG);
  assert.equal(roleTitle('Urgent | HIRING – BRANDING & MARKETING / CREATIVE CONTENT STRATEGIST'), 'Urgent | HIRING – BRANDING & MARKETING / CREATIVE CONTENT STRATEGIST');
  assert.equal(roleTitle('Hiring for Radiologist'), 'Radiologist');
  assert.equal(roleTitle('Staff Nurse'), 'Staff Nurse');
  // a sentence, a nothing, an address, one that is far too long: still refused
  assert.equal(roleTitle('We are looking for a candidate who can join immediately and work with our team'), '');
  assert.equal(roleTitle('Not mentioned'), '');
  assert.equal(roleTitle('someone@example.com'), '');
  assert.equal(roleTitle('x'.repeat(90)), '');
});

let a1, a2, b1, odd;
test('a recruiter\'s button imports only the messages of their own mailboxes; no candidate is written to', async () => {
  a1 = await waiting('mbx_rpa', 'Asha Marketing', 'asha.rp@cand-mailbox-test.in', '9811100001');
  a2 = await waiting('mbx_rpa', 'Bala Creative', 'bala.rp@cand-mailbox-test.in', '9811100002');
  b1 = await waiting('mbx_rpb', 'Chitra Brand', 'chitra.rp@cand-mailbox-test.in', '9811100003');
  const before = (await raw(`select count(*)::int n from candidates`)).rows[0].n;
  const r = await recA.post('/api/intake/messages/reprocess-unmapped', {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.tried, r.body.imported, r.body.stillWaiting, r.body.failed], [2, 2, 0, 0], JSON.stringify(r.body));
  assert.match(r.body.note, /No candidate was emailed/);
  for (const x of [a1, a2]) {
    const apps = await appsOf(x.cand);
    assert.equal(apps.length, 1, 'the candidate now has an application');
    assert.equal(apps[0].title, LONG);
    assert.equal(apps[0].import_login_notified_at, null, 'and has not been written to');
    const m = await status(x.mid);
    assert.equal(m.status, 'processed'); assert.ok(m.application_id);
  }
  assert.equal((await raw(`select count(*)::int n from candidates`)).rows[0].n, before, 'the existing candidates were matched, not duplicated');
  assert.equal((await raw(`select count(*)::int n from jobs where title = $1`, [LONG])).rows[0].n, 1, 'one requirement for the role');
  assert.equal((await appsOf(b1.cand)).length, 0, 'the other recruiter\'s message was not touched');
  assert.equal((await status(b1.mid)).status, 'needs_mapping');
  assert.deepEqual(sentOut, [], 'no email, SMS or WhatsApp left');
});

test('the logins wait for the administrator: they are in the "Send login emails" count, not sent', async () => {
  const pending = (await raw(`select candidate_id from intake_logins_pending() where kind = 'mail'`)).rows.map((x) => x.candidate_id);
  assert.ok(pending.includes(a1.cand) && pending.includes(a2.cand));
  const ev = (await raw(`select detail from application_events e where kind = 'candidate.notified' and application_id = (select id from applications where candidate_id = $1)`, [a1.cand]).catch(() => ({ rows: [] }))).rows;
  if (ev.length) assert.match(JSON.stringify(ev), /held for the administrator/);
});

test('an administrator imports all that is waiting; what cannot be a requirement stays waiting; asking again does nothing', async () => {
  odd = await waiting('mbx_rpb', 'Dev Nobody', 'dev.rp@cand-mailbox-test.in', '9811100004', 'We are looking for a candidate who can join immediately and work with our team');
  const r = await admin.post('/api/intake/messages/reprocess-unmapped', {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.tried, r.body.imported, r.body.stillWaiting], [2, 1, 1], JSON.stringify(r.body));
  assert.equal((await appsOf(b1.cand)).length, 1);
  assert.equal((await appsOf(odd.cand)).length, 0);
  assert.equal((await status(odd.mid)).status, 'needs_mapping');
  assert.equal((await raw(`select count(*)::int n from jobs where title = $1`, [LONG])).rows[0].n, 1, 'the second response joined the same requirement');
  assert.deepEqual(sentOut.filter(([, to]) => /cand-mailbox-test/.test(to)), [], 'no candidate was written to (the recruiter is told about the one that still needs a requirement, as always)');
  const again = await recB.post('/api/intake/messages/reprocess-unmapped', {});
  assert.equal(again.status, 200);
  assert.deepEqual([again.body.tried, again.body.imported, again.body.stillWaiting], [1, 0, 1], 'only the one that cannot be a requirement is left');
});

test('the Applications list of the owning recruiter now shows them', async () => {
  const l = await recA.get('/api/applications');
  assert.equal(l.status, 200, JSON.stringify(l.body).slice(0, 200));
  const apps = l.body.applications || l.body.items || [];
  const mine = apps.filter((x) => x.jobId && x.candidateId === a1.cand);
  assert.equal(mine.length, 1);
});

test('shutdown', async () => {
  await new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
  await dbh.stop();
});
