/**
 * Email import: when the mail and the resume carry no email address, the address the mail was SENT FROM
 * is the candidate's (Reply-To first). Never a job board, a no-reply sender, the mailbox itself, or a
 * recruiter/admin/client of this portal forwarding a CV.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb, applyTestEnv } from './harness.mjs';

let dbh, senderEmail;
const mailbox = { address: 'hiring@tl-sink.local' };
const msg = (from, extra = '') => ({ from, raw: `From: ${from}\r\n${extra}Subject: Application\r\n\r\nHello` });

test('boot', async () => {
  dbh = await startTestDb(5614);
  applyTestEnv(dbh.url, { DISABLE_BACKGROUND_WORK: 'true' });
  await dbh.db.query(`insert into users (email, password_hash, role) values ('boss@tl-sink.local', 'x', 'recruiter'), ('cand@tl-sink.local', 'x', 'candidate')`);
  ({ senderEmail } = await import('../src/intake/process.js'));
});

test('the sender is the candidate: From, or Reply-To when there is one', async () => {
  assert.equal(await senderEmail(msg('Ravi Kumar <Ravi.Kumar@gmail.com>'), mailbox, null), 'ravi.kumar@gmail.com');
  assert.equal(await senderEmail(msg('Ravi <ravi@gmail.com>', 'Reply-To: "R K" <ravi.work@yahoo.in>\r\n'), mailbox, null), 'ravi.work@yahoo.in');
  assert.equal(await senderEmail(msg('cand@tl-sink.local'), mailbox, null), 'cand@tl-sink.local', 'a candidate account is fine');
});

test('never a board, a system sender, the mailbox itself or staff', async () => {
  assert.equal(await senderEmail(msg('Naukri <jobsapply@naukri.com>'), mailbox, { id: 'naukri' }), '', 'a detected board');
  assert.equal(await senderEmail(msg('x@alerts.shine.com'), mailbox, null), '', 'a board domain even if undetected');
  assert.equal(await senderEmail(msg('noreply@somecompany.com'), mailbox, null), '');
  assert.equal(await senderEmail(msg('MAILER-DAEMON@mail.example.com'), mailbox, null), '');
  assert.equal(await senderEmail(msg('Hiring <hiring@tl-sink.local>'), mailbox, null), '', 'the mailbox itself');
  assert.equal(await senderEmail(msg('Boss <boss@tl-sink.local>'), mailbox, null), '', 'a recruiter forwarding a CV');
  assert.equal(await senderEmail(msg('not an address'), mailbox, null), '');
});

test('shutdown', async () => {
  const { closePool } = await import('../src/db.js'); await closePool();
  await dbh.stop?.();
});
