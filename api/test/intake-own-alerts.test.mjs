/**
 * Email import must not read TeamLink's own "New application" alerts back as applications (0146).
 *
 *   - the alert the portal sends the recruiter ("<Name> applied for <Job> (Job ID ...). Application ID TL-APP-...")
 *     is classified as NOT an application, with a plain reason
 *   - a real job-board application is still an application
 *   - the clean-up takes the alerts already waiting off the review queue and leaves everything else alone
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../src/intake/parse.js';
import { SAMPLE_EMAILS } from '../src/intake/mailbox.js';
import { startTestDb } from './harness.mjs';

const OWN_ALERT = {
  from: 'TeamLink Consultants <alerts@teamlinkcs.example>',
  subject: 'New application: Pharmacology',
  text: 'Hi TeamLink Med,\n\nAkanksha reddy. G applied for Pharmacology (Job ID j_muxmlm80io0mx). Application ID TL-APP-2026-01026.\n\n'
    + 'http://localhost:4323/#/recruiter/manage-jobs?applicants=j_muxmlm80io0mx&app=app_mv7loym5gowc9\n\n— TeamLink',
};

test('the portal\'s own new-application alert is not an application', () => {
  const r = classify(OWN_ALERT);
  assert.equal(r.isApplication, false);
  assert.match(r.why, /TeamLink's own new-application alert/);
  /* whatever the subject says, an email carrying one of our Application IDs is about an application we hold */
  const r2 = classify({ ...OWN_ALERT, subject: 'Fwd: Pharmacology', text: 'Applicant name: X\nApplication ID TL-APP-2026-00031 was received.' });
  assert.equal(r2.isApplication, false);
});

test('a real job-board application is still an application', () => {
  const real = SAMPLE_EMAILS.map((m) => ({ from: m.from, subject: m.subject, text: m.text || m.body || '' }))
    .filter((m) => /naukri|candidate|applied/i.test(m.from + m.subject + m.text));
  assert.ok(real.length >= 1, 'the sample mailbox has application emails');
  assert.ok(real.some((m) => classify(m).isApplication === true), 'at least one sample application is still recognised');
  /* the same words WITHOUT one of our Application IDs are not touched by the new rule */
  const board = { from: 'Naukri <alerts@naukri.com>', subject: 'New application: Staff Nurse',
    text: 'Candidate Name: Ravi Kumar\nApplied for Staff Nurse\nMobile: 9876543210' };
  assert.equal(classify(board).isApplication, true);
});

test('the clean-up takes the waiting alerts off the queue and leaves the rest', async () => {
  const fs = await import('node:fs');
  const sql = fs.readFileSync(new URL('../../supabase/migrations/0146_ignore_own_application_alerts.sql', import.meta.url), 'utf8');
  const dbh = await startTestDb(5613);
  try {
    const raw = (q, p) => dbh.db.query(q, p);
    await raw(`insert into email_mailboxes (id, address, provider) values ('mb_oa', 'inbox.oa@tl-sink.local', 'imap')`);
    const ins = (id, subject, snippet, status) => raw(
      `insert into email_messages (id, mailbox_id, message_id, from_address, subject, snippet, status, reason)
       values ($1, 'mb_oa', $1, 'x@example.com', $2, $3, $4, 'No candidate name could be read from this email.')`, [id, subject, snippet, status]);
    await ins('m_alert', 'New application: Pharmacology', 'Hi TeamLink Med,\n\nAkanksha reddy. G applied for Pharmacology (Job ID j_x). Application ID TL-APP-2026-01026.', 'needs_review');
    await ins('m_alert2', 'New application: Dermatologist', 'Hi Med,\n\nB. Rao applied for Dermatologist (Job ID j_y). Application ID TL-APP-2026-00002.', 'needs_mapping');
    await ins('m_real', 'New application: Staff Nurse', 'Candidate Name: Ravi Kumar applied for Staff Nurse. Mobile 9876543210', 'needs_review');
    await ins('m_other', 'Re: your interview', 'Application ID TL-APP-2026-00003 - thanks', 'needs_review');
    await ins('m_done', 'New application: Pharmacology', 'X applied for Y (Job ID j). Application ID TL-APP-2026-00004.', 'processed');
    await raw(sql);
    const st = async (id) => (await raw(`select status, reason from email_messages where id = $1`, [id])).rows[0];
    assert.equal((await st('m_alert')).status, 'ignored');
    assert.match((await st('m_alert')).reason, /TeamLink's own new-application alert/);
    assert.equal((await st('m_alert2')).status, 'ignored');
    assert.equal((await st('m_real')).status, 'needs_review', 'a message with no Application ID of ours stays in the queue');
    assert.equal((await st('m_other')).status, 'needs_review', 'only "New application:" alerts are cleared');
    assert.equal((await st('m_done')).status, 'processed', 'already handled: untouched');
  } finally {
    await dbh.stop?.();
  }
});
