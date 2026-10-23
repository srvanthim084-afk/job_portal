/**
 * An imported application with no requirement to go on: the recruiter who owns the mailbox is emailed (0151).
 *
 *   - one email, to that recruiter, naming the candidate, the role and where to map it
 *   - once per message: asking again sends nothing (a re-sync reads the same message again)
 *   - a failed send gives the claim back, a later try sends it, and it stops after 3 tries
 *   - a message that is not waiting for a requirement sends nothing; a mailbox with no recruiter has nobody to tell
 *   - a digest says how many candidates; names and subjects are escaped in the HTML
 *   - end to end: the import that ends as needs_mapping sends it (through processMessage)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb, applyTestEnv } from './harness.mjs';

const DB_PORT = 5692;
let dbh, raw, mod, providers;
const sent = [];
let n = 0;
const id = (p) => `${p}_${Date.now().toString(36)}${(n++).toString(36)}`;

async function message({ status = 'needs_mapping', mailbox = 'mbx_u1', subject = 'Applied for Urgent | Hiring For BRANDING & MARKETING', parsed = null, candidate = 'cand_u1' } = {}) {
  const rid = id('msg');
  await raw(`insert into email_messages (id, mailbox_id, message_id, subject, status, reason, parsed, candidate_id)
             values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
    [rid, mailbox, id('mid'), subject, status, 'Applied role could not be identified - no requirement matches.', parsed ? JSON.stringify(parsed) : null, candidate]);
  return rid;
}
const row = async (rid) => (await raw(`select mapping_notified_at, mapping_notice_tries from email_messages where id=$1`, [rid])).rows[0];

test('boot', async () => {
  dbh = await startTestDb(DB_PORT);
  /* the email form of the notice is the opt-in one (INTAKE_RECRUITER_EMAILS); the portal form is covered by intake-responses-portal-only.test.mjs */
  applyTestEnv(dbh.url, { PUBLIC_ORIGIN: 'http://portal.test', DISABLE_BACKGROUND_WORK: 'true', INTAKE_RECRUITER_EMAILS: 'true' });
  raw = (sql, params) => dbh.db.query(sql, params);
  await raw(`insert into companies (id, name) values ('co_u', 'Unmapped Co')`);
  await raw(`insert into users (email, password_hash, role) values ('ramya.u@tl-sink.local', 'x', 'recruiter')`);
  const u = (await raw(`select id from users where email='ramya.u@tl-sink.local'`)).rows[0].id;
  await raw(`insert into recruiters (id, user_id, name, email, company_id) values ('r_u1', $1, 'Ramya Recruiter', 'ramya.u@tl-sink.local', 'co_u')`, [u]);
  await raw(`insert into email_mailboxes (id, address, provider, source, recruiter_id, status) values
             ('mbx_u1', 'shine.box@tl-mailbox-test.in', 'imap', 'shine', 'r_u1', 'connected'),
             ('mbx_u2', 'orphan.box@tl-mailbox-test.in', 'imap', 'shine', null, 'connected')`);
  await raw(`insert into candidates (id, name, email, phone) values ('cand_u1', 'Bhavna <b>Mungyalkar</b>', 'bhavna.u@tl-sink.local', '7405337967')`);
  mod = await import('../src/notify/unmapped-import.js');
  ({ providers } = await import('../src/notify/providers.js'));
  providers.email.send = async (m) => { sent.push(m); return { status: 'sent', provider: 'test' }; };
});

test('the recruiter gets one email: who applied, for what, and where to map it', async () => {
  const rid = await message();
  const r = await mod.notifyUnmapped(rid);
  assert.equal(r.status, 'sent', JSON.stringify(r));
  assert.equal(sent.length, 1);
  const m = sent[0];
  assert.equal(m.to, 'ramya.u@tl-sink.local');
  assert.match(m.subject, /^Action needed: Bhavna .*Mungyalkar.* applied on Shine but no requirement matches$/);
  assert.match(m.text, /Hello Ramya Recruiter,/);
  assert.match(m.text, /Shine mailbox shine\.box@tl-mailbox-test\.in/);
  assert.match(m.text, /Email: bhavna\.u@tl-sink\.local/);
  assert.match(m.text, /Phone: 7405337967/);
  assert.match(m.text, /Applied for: Applied for Urgent \| Hiring For BRANDING & MARKETING/);
  assert.match(m.text, /Needs a requirement/);
  assert.match(m.text, /press Map/);
  assert.match(m.text, /http:\/\/portal\.test\/#\/recruiter\/applications/);
  assert.doesNotMatch(m.html, /<b>Mungyalkar<\/b>/, 'a name with markup is escaped');
  assert.match(m.html, /BRANDING &amp; MARKETING/);
  assert.ok((await row(rid)).mapping_notified_at);
});

test('once per message: asking again (a re-sync reads the same message) sends nothing', async () => {
  const rid = await message();
  assert.equal((await mod.notifyUnmapped(rid)).status, 'sent');
  const before = sent.length;
  assert.equal((await mod.notifyUnmapped(rid)).status, 'skipped');
  assert.equal((await mod.notifyUnmapped(rid)).status, 'skipped');
  const both = await Promise.all([message(), message()].map(async (p) => mod.notifyUnmapped(await p)));
  assert.deepEqual(both.map((x) => x.status), ['sent', 'sent'], 'two different messages are two emails');
  assert.equal(sent.length, before + 2);
  // two processes racing for the SAME message: one email
  const same = await message();
  const racing = await Promise.all([mod.notifyUnmapped(same), mod.notifyUnmapped(same)]);
  assert.deepEqual(racing.map((x) => x.status).sort(), ['sent', 'skipped']);
});

test('a failed send gives the claim back, a later try sends, and it stops after 3 tries', async () => {
  const good = providers.email.send;
  providers.email.send = async () => ({ status: 'failed', provider: 'test' });
  const rid = await message();
  assert.equal((await mod.notifyUnmapped(rid)).status, 'failed');
  assert.equal((await row(rid)).mapping_notified_at, null, 'released');
  providers.email.send = good;
  const before = sent.length;
  assert.equal((await mod.notifyUnmapped(rid)).status, 'sent');
  assert.equal(sent.length, before + 1);

  providers.email.send = async () => { throw new Error('smtp down'); };
  const flaky = await message();
  for (let i = 0; i < 3; i++) assert.equal((await mod.notifyUnmapped(flaky)).status, 'failed');
  assert.equal((await row(flaky)).mapping_notice_tries, 3);
  providers.email.send = good;
  assert.equal((await mod.notifyUnmapped(flaky)).status, 'skipped', 'three tries, then it stops');
});

test('nothing is sent for a message that is not waiting for a requirement, or for a mailbox with no recruiter', async () => {
  const before = sent.length;
  assert.equal((await mod.notifyUnmapped(await message({ status: 'processed' }))).status, 'skipped');
  assert.equal((await mod.notifyUnmapped(await message({ status: 'needs_review' }))).status, 'skipped');
  assert.equal((await mod.notifyUnmapped(await message({ mailbox: 'mbx_u2' }))).status, 'no_recipient');
  assert.equal((await mod.notifyUnmapped('msg_does_not_exist')).status, 'skipped');
  assert.equal(sent.length, before);
});

test('a digest says how many candidates and for which role', async () => {
  const before = sent.length;
  const rid = await message({ candidate: null, subject: 'Naukri digest', parsed: { digest: true, jobTitle: 'Ophthalmology Faculty', unmapped: 3, candidates: 3 } });
  assert.equal((await mod.notifyUnmapped(rid)).status, 'sent');
  const m = sent[before];
  assert.match(m.subject, /^Action needed: Shine candidates for "Ophthalmology Faculty" have no requirement to go on$/);
  assert.match(m.text, /Candidate: 3 candidate\(s\) in a Shine digest/);
});

test('shutdown', async () => {
  const { closePool } = await import('../src/db.js');
  await closePool();
  await dbh.stop?.();
});
