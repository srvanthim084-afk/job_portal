/**
 * The Talent Pool lists the IMPORTED candidates; Find Candidates lists everybody (0153).
 *
 *   imported=true  : a spreadsheet import (import_id), a Naukri / Shine mail (the mail row, or an application made from
 *                    one - even when the mailbox belongs to another recruiter), and the ones recorded before sources
 *                    were noted (no source) - and NOT somebody who registered themselves or was typed in by hand
 *   no param       : everybody who is not private, applied to a job or not
 *   the source chips add up to the count at the top, with the same filter
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb, applyTestEnv, makeClient } from './harness.mjs';

const DB_PORT = 5694;
const API_PORT = 9964;
const base = `http://127.0.0.1:${API_PORT}`;
const PW = 'PoolImported123';

let dbh, server, raw, recA, recB;

async function staff(email, id, company) {
  const { hashPassword } = await import('../src/auth.js');
  const u = (await raw(`insert into users (email,password_hash,role) values ($1,$2,'recruiter') returning id`,
    [email, await hashPassword(PW)])).rows[0].id;
  await raw(`insert into recruiters (id, user_id, name, email, company_id) values ($1,$2,$3,$4,$5)`, [id, u, `rec ${id}`, email, company]);
  const c = makeClient(base);
  await c.get('/api/health');
  const r = await c.post('/api/auth/login', { email, password: PW, role: 'recruiter' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return c;
}
const cand = (id, source, extra = '') => raw(
  `insert into candidates (id, name, email, source${extra ? ', ' + extra.split('=')[0] : ''}) values ($1, $2, $3, $4${extra ? ', ' + extra.split('=')[1] : ''})`,
  [id, `Cand ${id}`, `${id}@tl-sink.local`, source]);
const names = (r) => r.body.candidates.map((x) => x.id).sort();

test('boot', async () => {
  dbh = await startTestDb(DB_PORT);
  applyTestEnv(dbh.url, { PUBLIC_ORIGIN: base, DISABLE_BACKGROUND_WORK: 'true' });
  raw = (sql, params) => dbh.db.query(sql, params);
  await raw(`insert into companies (id, name) values ('co_pi1', 'Pool Co'), ('co_pi2', 'Other Co')`);
  const { createApp } = await import('../src/app.js');
  const app = createApp({ logger: { error() {}, log() {} } });
  await new Promise((r) => { server = app.listen(API_PORT, r); });
  recA = await staff('rec.pi1@tl-sink.local', 'r_pi1', 'co_pi1');
  recB = await staff('rec.pi2@tl-sink.local', 'r_pi2', 'co_pi2');
  await raw(`insert into jobs (id, title, company_id, location, mode, exp_label, skills, status, recruiter_id, description, published_at)
             values ('j_pi1', 'Nurse', 'co_pi1', 'Hyderabad', 'Onsite', '1-3 yrs', $1, 'open', 'r_pi1', 'x', now())`, [['Care']]);

  await raw(`insert into candidate_imports (id, filename, format, total_rows, created_count) values ('imp_pi1', 'pool.xlsx', 'xlsx', 1, 1)`);
  await raw(`insert into email_mailboxes (id, address, provider, source, recruiter_id, status) values ('mbx_pi1', 'shine.pi@tl-mailbox-test.in', 'imap', 'shine', 'r_pi1', 'connected')`);

  // ---- imported ----
  await cand('imp_file', 'Bulk Import', 'import_id=\'imp_pi1\'');          // a spreadsheet import
  await cand('imp_legacy', null);                                          // recorded before anybody noted a source
  await cand('imp_mail', 'Shine');                                         // came in through recruiter A's Shine mailbox
  await raw(`insert into email_messages (id, mailbox_id, message_id, subject, status, candidate_id) values ('msg_pi1', 'mbx_pi1', 'mid1', 'Applied', 'processed', 'imp_mail')`);
  await cand('imp_app', 'Direct Registration');                            // registered, then matched by a Naukri mail
  await raw(`insert into applications (id, job_id, candidate_id, recruiter_id, import_method) values ('app_pi_imp', 'j_pi1', 'imp_app', 'r_pi1', 'recruiter_email')`);
  // ---- not imported ----
  await cand('self_none', 'Direct Registration');                          // registered, never applied
  await cand('self_applied', 'TeamLink Website');                          // registered and applied on the portal
  await raw(`insert into applications (id, job_id, candidate_id, recruiter_id) values ('app_pi_self', 'j_pi1', 'self_applied', 'r_pi1')`);
  await cand('typed', 'Manual Entry');
  await cand('walkin', 'Walk-in Application');
  await cand('priv', 'Bulk Import', 'is_private=true');                    // imported but private to its owner
  await raw(`update candidates set owner_recruiter_id = 'r_pi1' where id = 'priv'`);
});

test('Talent Pool (imported=true): the imported ones only - even those that came through another recruiter\'s mailbox', async () => {
  for (const who of [recA, recB]) {
    const r = await who.get('/api/candidates?limit=100&imported=true');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const expected = who === recA ? ['imp_app', 'imp_file', 'imp_legacy', 'imp_mail', 'priv'] : ['imp_app', 'imp_file', 'imp_legacy', 'imp_mail'];
    assert.deepEqual(names(r), expected);
    assert.equal(r.body.total, expected.length, 'the count at the top is the imported count');
  }
});

test('Find Candidates (no param): everybody who is not private, applied or not, imported or not', async () => {
  const b = await recB.get('/api/candidates?limit=100');
  assert.deepEqual(names(b), ['imp_app', 'imp_file', 'imp_legacy', 'imp_mail', 'self_applied', 'self_none', 'typed', 'walkin']);
  const a = await recA.get('/api/candidates?limit=100');
  assert.ok(names(a).includes('priv'), 'its owner also sees the private one');
  assert.equal(a.body.total, 9);
  // "irrespective of job applied": the ones who never applied are there, and so are the ones who did
  assert.ok(names(b).includes('self_none') && names(b).includes('self_applied'));
});

test('the Source chips add up to the Talent Pool count, with the same filter', async () => {
  const r = await recB.get('/api/candidates?limit=5&imported=true&withSourceCounts=1');
  const sum = r.body.sourceCounts.reduce((n, x) => n + x.n, 0);
  assert.equal(sum, r.body.total);
  assert.equal(r.body.total, 4);
  const counts = Object.fromEntries(r.body.sourceCounts.map((x) => [x.source, x.n]));
  assert.equal(counts['Direct Registration'], 1, 'the registered candidate matched by a Naukri mail');
  assert.equal(counts.Unknown, 1);
  assert.equal(counts.Shine, 1);
  assert.equal(counts['Bulk Import'], 1);
});

test('imported=true combines with the other filters (a source, a search)', async () => {
  const shine = await recB.get('/api/candidates?limit=100&imported=true&source=Shine');
  assert.deepEqual(names(shine), ['imp_mail']);
  const none = await recB.get('/api/candidates?limit=100&imported=true&source=Manual%20Entry');
  assert.equal(none.body.total, 0, 'a typed-in candidate is not in the Talent Pool even when asked for by source');
  const q = await recB.get('/api/candidates?limit=100&imported=true&q=imp_file');
  assert.deepEqual(names(q), ['imp_file']);
});

test('shutdown', async () => {
  await new Promise((r) => server.close(r));
  const { stopBackgroundWork } = await import('../src/app.js');
  stopBackgroundWork();
  const { closePool } = await import('../src/db.js');
  await closePool();
  await dbh.stop?.();
});
