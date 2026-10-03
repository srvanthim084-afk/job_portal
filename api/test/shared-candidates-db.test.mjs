/**
 * Shared candidates and the hold rules (0091), proved in the DATABASE.
 *
 * No API process: every statement runs as the unprivileged app_api role
 * with the caller's identity in app.user_id / app.role, exactly what
 * withUser() does - so a policy or a trigger that is wrong fails here,
 * and these run anywhere PGlite does.
 *
 * The API-level suite (shared-candidates.test.mjs) proves the routes on
 * top of this; this file proves the rules themselves:
 *
 *   - B reads A's candidate, cannot edit them, cannot see a private one
 *   - B cannot read A's applications, private notes or raw contact rows,
 *     only the candidate_engagements() summary - which carries no text
 *   - "Senior Medical Coder" is "Medical Coder"; "Medical Representative"
 *     is not
 *   - A contacted only -> B warned; A in process -> B blocked (and the
 *     trigger refuses the add-to-job); a different role -> allowed
 *   - the hold lapses 30 days after the last activity; CLOSED ends it;
 *     JOINED holds every role for 90 days
 *   - a duplicate client submission is refused even for the same
 *     recruiter, and an administrator's override (with a reason) lets
 *     exactly one through, logged
 *   - an override request -> approval -> B may proceed, logged
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb } from './harness.mjs';

const DB_PORT = 5477;

let dbh, db;
const uid = {};

const raw = (sql, params) => db.query(sql, params);

/** Run fn as one person, through the API's own role. */
async function as(who, fn) {
  const [id, role] = who === 'engine' ? ['', 'admin'] : [uid[who], ROLE[who]];
  await db.exec('reset role');
  await db.query(`select set_config('app.user_id', $1, false), set_config('app.role', $2, false)`,
    [id || '', role]);
  await db.exec('set role app_api');
  try { return await fn(); } finally { await db.exec('reset role'); }
}
const q = async (sql, params) => (await db.query(sql, params)).rows;

const ROLE = { rA: 'recruiter', rB: 'recruiter', admin: 'admin', cand: 'candidate' };

async function expectError(fn, code) {
  try {
    await fn();
  } catch (e) {
    if (code) assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`);
    return e;
  }
  assert.fail(`expected error ${code || ''}`);
}

const ago = (days) => `now() - interval '${days} days'`;

test('boot', async () => {
  dbh = await startTestDb(DB_PORT);
  db = dbh.db;

  await raw(`insert into companies (id, name) values ('co_x', 'Client X'), ('co_y', 'Client Y')`);
  for (const [k, role] of [['rA', 'recruiter'], ['rB', 'recruiter'], ['admin', 'admin'], ['cand', 'candidate']]) {
    const u = await raw(`insert into users (email, password_hash, role) values ($1, 'x', $2) returning id`,
      [`${k}@db.test`, role]);
    uid[k] = u.rows[0].id;
  }
  await raw(`insert into recruiters (id, user_id, name, email, company_id) values
               ('rA', $1, 'Ravi', 'ra@db.test', 'co_x'),
               ('rB', $2, 'Priya', 'rb@db.test', 'co_x')`, [uid.rA, uid.rB]);
  await raw(`insert into admins (id, user_id, name, email) values ('adm', $1, 'Admin', 'ad@db.test')`,
    [uid.admin]);

  // jobs: A owns the coder roles at X, B owns a coder role and a rep role
  await raw(`insert into jobs (id, title, company_id, recruiter_id, status) values
     ('jA',  'Senior Medical Coder',   'co_x', 'rA', 'open'),
     ('jA2', 'Medical Coder II',       'co_x', 'rA', 'open'),
     ('jB',  'Medical Coder',          'co_x', 'rB', 'open'),
     ('jBr', 'Medical Representative', 'co_x', 'rB', 'open')`);

  // candidates: added by A (one private), and one self-registered
  await raw(`insert into candidates (id, name, email, phone, owner_recruiter_id, is_private) values
     ('c1', 'Asha',  'asha@db.test',  '9000000001', 'rA', false),
     ('c2', 'Bala',  'bala@db.test',  '9000000002', 'rA', true),
     ('c3', 'Chitra','chitra@db.test','9000000003', null, false)`);
  await raw(`update candidates set user_id = $1 where id = 'c3'`, [uid.cand]);
});

test('the role key: seniority words do not make a different role', async () => {
  const r = await q(`select app_role_key('Senior Medical Coder') a, app_role_key('Medical Coder') b,
                            app_role_key('Sr. Medical Coder II') c, app_role_key('Medical Representative') d,
                            app_role_key('', 'Lead Nursing') e`);
  assert.equal(r[0].a, 'medical coder');
  assert.equal(r[0].b, 'medical coder');
  assert.equal(r[0].c, 'medical coder');
  assert.equal(r[0].d, 'medical representative');
  assert.equal(r[0].e, 'nursing', 'the department is the fallback');
});

test('B reads the candidate A added, but not the private one, and cannot edit', async () => {
  await as('rB', async () => {
    const ids = (await q(`select id from candidates order by id`)).map((x) => x.id);
    assert.ok(ids.includes('c1'), 'shared candidate not visible to another recruiter');
    assert.ok(ids.includes('c3'), 'self-registered candidate not visible');
    assert.ok(!ids.includes('c2'), 'a PRIVATE candidate leaked to another recruiter');

    const upd = await db.query(`update candidates set title = 'hijack' where id = 'c1'`);
    assert.equal(upd.affectedRows, 0, 'B edited A\'s candidate');
    const upd3 = await db.query(`update candidates set title = 'hijack' where id = 'c3'`);
    assert.equal(upd3.affectedRows, 0, 'B edited a self-registered candidate it never worked');

    await expectError(() => q(`select candidate_records_replace('c1', '[]'::jsonb, null)`), '42501');
    await expectError(() => q(`select candidate_source_set('c1', 'Walk-in', null, 'x')`), '42501');
    assert.equal((await q(`select app_candidate_editable('c1') e`))[0].e, false);
  });
  await as('rA', async () => {
    const upd = await db.query(`update candidates set title = 'Coder' where id = 'c1'`);
    assert.equal(upd.affectedRows, 1, 'the owner can no longer edit');
    assert.equal((await q(`select app_candidate_editable('c1') e`))[0].e, true);
  });
});

test('notes: private stays private, team is shared', async () => {
  await as('rA', async () => {
    await q(`insert into candidate_comments (candidate_id, recruiter_id, body) values ('c1','rA','A private')`);
    await q(`insert into candidate_comments (candidate_id, recruiter_id, body, visibility)
             values ('c1','rA','A for the team','team')`);
  });
  await as('rB', async () => {
    const rows = await q(`select body from candidate_comments where candidate_id = 'c1'`);
    assert.deepEqual(rows.map((r) => r.body), ['A for the team']);
    await expectError(() => q(`insert into candidate_comments (candidate_id, recruiter_id, body)
                               values ('c1','rA','forged')`));
  });
});

test('contacted only -> B is warned and may continue; a different role is free', async () => {
  await as('rA', async () => {
    await q(`select engagement_record('c1', 'jA', null, 'phone', 'phone', 'interested', 'secret note', null)`);
  });
  await as('rB', async () => {
    // the raw contact rows (and their detail) are not B's to read
    assert.equal((await q(`select count(*)::int n from candidate_contact_history where candidate_id='c1'`))[0].n, 0);

    const e = await q(`select * from candidate_engagements('c1', 'jB')`);
    assert.equal(e.length, 1);
    assert.equal(e[0].recruiter_name, 'Ravi');
    assert.equal(e[0].same_role, true, 'Senior Medical Coder vs Medical Coder must be the same role');
    assert.equal(e[0].same_job, false);
    assert.equal(e[0].level, 'contacted');
    assert.equal(e[0].last_channel, 'phone');
    assert.equal(e[0].last_outcome, 'interested');
    assert.ok(!JSON.stringify(e).includes('secret note'), 'a note leaked through the summary');

    const same = (await q(`select * from can_engage('c1', 'jB', null)`))[0];
    assert.equal(same.decision, 'warn');
    assert.equal(same.holder_name, 'Ravi');

    const other = (await q(`select * from can_engage('c1', 'jBr', null)`))[0];
    assert.equal(other.decision, 'allowed', 'a different role must not be restricted');

    // warn is not a block: the add-to-job goes through
    await q(`insert into applications (id, job_id, candidate_id) values ('app_b_warn', 'jB', 'c1')`);
  });
  // tidy: that application belongs to B now; remove it for the next case
  await raw(`delete from applications where id = 'app_b_warn'`);
  await raw(`delete from candidate_contact_history where ref_id = 'app_b_warn'`);
});

test('in process -> B is blocked on the server; a different role is not', async () => {
  await as('rA', async () => {
    await q(`insert into applications (id, job_id, candidate_id) values ('app_a1', 'jA', 'c1')`);
  });
  await as('rB', async () => {
    assert.equal((await q(`select count(*)::int n from applications where candidate_id = 'c1'`))[0].n, 0,
      'B can read A\'s application');
    const v = (await q(`select * from can_engage('c1', 'jB', null)`))[0];
    assert.equal(v.decision, 'blocked');
    assert.equal(v.level, 'in_process');
    assert.ok(v.hold_expires_at, 'the hold has an end');

    const err = await expectError(
      () => q(`insert into applications (id, job_id, candidate_id) values ('app_b1', 'jB', 'c1')`), 'TLB01');
    assert.match(err.message, /Ravi is processing this candidate for Senior Medical Coder/);
    const detail = JSON.parse(err.detail);
    assert.equal(detail.holderName, 'Ravi');

    // a different role is still free
    await q(`insert into applications (id, job_id, candidate_id) values ('app_b_rep', 'jBr', 'c1')`);
  });
  // The refusal rolled back its own transaction, so nothing of the
  // attempt is left behind; the API records 'blocked' in a fresh one.
  assert.equal((await q(`select count(*)::int n from applications where id = 'app_b1'`))[0].n, 0);
  await as('rB', async () => {
    await q(`select engagement_audit_add('c1', 'medical coder', 'jB', 'blocked', '{"action":"add_to_job"}'::jsonb)`);
    await expectError(() => q(`select engagement_audit_add('c1', null, null, 'override_approved', '{}'::jsonb)`), '22023');
  });
});

test('every application event writes the contact history', async () => {
  const rows = await q(`select source, recruiter_id, role_key from candidate_contact_history
                         where candidate_id = 'c1' and source in ('application','stage_change','submission','interview')
                         order by id`);
  assert.ok(rows.some((r) => r.source === 'application' && r.recruiter_id === 'rA' && r.role_key === 'medical coder'));
  await as('rA', async () => {
    await q(`update applications set stage = 'interview_scheduled' where id = 'app_a1'`);
  });
  const after = await q(`select source from candidate_contact_history where ref_id = 'app_a1' order by id`);
  assert.deepEqual(after.map((r) => r.source), ['application', 'interview']);
  // an interview booked
  await raw(`insert into interviews (id, candidate_id, job_id, application_id, type, status)
             values ('iv_t1', 'c1', 'jA', 'app_a1', 'HR Round', 'Scheduled')`);
  const iv = await q(`select source, recruiter_id, role_key from candidate_contact_history where ref_id = 'iv_t1'`);
  assert.deepEqual(iv, [{ source: 'interview', recruiter_id: 'rA', role_key: 'medical coder' }]);
});

test('the hold lapses 30 days after the last activity', async () => {
  await raw(`update applications set applied_at = ${ago(31)} where id = 'app_a1'`);
  await raw(`update application_stage_history set created_at = ${ago(31)} where application_id = 'app_a1'`);
  await raw(`update candidate_contact_history set created_at = ${ago(31)} where candidate_id = 'c1' and recruiter_id = 'rA'`);
  await as('rB', async () => {
    const v = (await q(`select * from can_engage('c1', 'jB', null)`))[0];
    assert.equal(v.decision, 'allowed', `stale hold still enforced: ${JSON.stringify(v)}`);
  });
  // new activity by A brings the hold back
  await as('rA', async () => {
    await q(`select engagement_record('c1', 'jA', null, 'whatsapp', 'whatsapp', 'sent', null, null)`);
  });
  await as('rB', async () => {
    const v = (await q(`select * from can_engage('c1', 'jB', null)`))[0];
    assert.equal(v.decision, 'blocked', 'fresh activity on an open application holds again');
  });
});

test('CLOSED ends the hold at once', async () => {
  await as('rA', async () => {
    await q(`update applications set stage = 'rejected' where id = 'app_a1'`);
  });
  await as('rB', async () => {
    const v = (await q(`select * from can_engage('c1', 'jB', null)`))[0];
    assert.equal(v.decision, 'allowed', `a rejected application still holds: ${JSON.stringify(v)}`);
  });
});

test('override: B asks, an admin approves with a reason, B proceeds - all logged', async () => {
  // put A back in process on c3 for the coder role
  await as('rA', async () => {
    await q(`insert into applications (id, job_id, candidate_id) values ('app_a3', 'jA', 'c3')`);
  });
  let reqId;
  await as('rB', async () => {
    assert.equal((await q(`select * from can_engage('c3', 'jB', null)`))[0].decision, 'blocked');
    await expectError(() => q(`select engagement_override_request('c3', 'jB', null, 'hold', '')`), '22023');
    reqId = (await q(`select engagement_override_request('c3', 'jB', null, 'hold',
                        'The candidate called me directly about this role') id`))[0].id;
    // B cannot approve their own request
    await expectError(() => q(`select * from engagement_override_decide($1, true, 'self approve')`, [reqId]), '42501');
    const mine = await q(`select status from engagement_overrides`);
    assert.deepEqual(mine.map((r) => r.status), ['pending']);
  });
  await as('rA', async () => {
    assert.equal((await q(`select count(*)::int n from engagement_overrides`))[0].n, 0,
      'another recruiter can read B\'s override request');
  });
  await as('admin', async () => {
    const d = (await q(`select * from engagement_override_decide($1, true, 'Candidate asked for Priya')`, [reqId]))[0];
    assert.equal(d.status, 'approved');
    assert.ok(d.expires_at);
  });
  await as('rB', async () => {
    const v = (await q(`select * from can_engage('c3', 'jB', null)`))[0];
    assert.equal(v.decision, 'allowed');
    assert.equal(v.reason, 'override');
    await q(`insert into applications (id, job_id, candidate_id) values ('app_b3', 'jB', 'c3')`);
  });
  const audit = (await q(`select action from engagement_audit where candidate_id = 'c3' order by id`))
    .map((r) => r.action);
  for (const a of ['override_requested', 'override_approved', 'override_used']) {
    assert.ok(audit.includes(a), `${a} was not logged (${audit})`);
  }
});

test('a duplicate client submission is refused, even for the same recruiter', async () => {
  await raw(`insert into candidates (id, name, email, owner_recruiter_id) values ('c4', 'Devi', 'devi@db.test', 'rA')`);
  await as('rA', async () => {
    await q(`insert into applications (id, job_id, candidate_id) values ('app_d1', 'jA', 'c4')`);
    await q(`insert into applications (id, job_id, candidate_id) values ('app_d2', 'jA2', 'c4')`);
    await q(`update applications set stage = 'client_review' where id = 'app_d1'`);
    const err = await expectError(
      () => q(`update applications set stage = 'client_review' where id = 'app_d2'`), 'TLD01');
    assert.match(err.message, /already submitted to this client/);
  });
  assert.equal((await q(`select stage from applications where id = 'app_d2'`))[0].stage, 'applied');

  // an administrator overrides it, with a reason, once
  await as('admin', async () => {
    await expectError(() => q(`select engagement_override_request('c4', 'jA2', null, 'duplicate_submission', 'x')`), '22023');
    const id = (await q(`select engagement_override_request('c4', 'jA2', null, 'duplicate_submission',
                          'Client asked for the profile again for a second opening') id`))[0].id;
    await q(`select * from engagement_override_decide($1, true, 'Second opening confirmed by the client')`, [id]);
  });
  await as('rA', async () => {
    await q(`update applications set stage = 'client_review' where id = 'app_d2'`);
  });
  const used = await q(`select used_at from engagement_overrides where kind = 'duplicate_submission'`);
  assert.ok(used[0].used_at, 'the override was not marked used');
  const audit = (await q(`select action from engagement_audit where candidate_id = 'c4' order by id`)).map((r) => r.action);
  assert.ok(audit.includes('override_requested') && audit.includes('override_approved')
    && audit.includes('override_used'), audit.join(','));
});

test('JOINED holds every role for 90 days', async () => {
  await raw(`insert into candidates (id, name, email, phone, owner_recruiter_id) values ('c5', 'Esha', 'esha@db.test', '9000000005', 'rA')`);
  await as('rA', async () => {
    await q(`insert into applications (id, job_id, candidate_id) values ('app_j', 'jA', 'c5')`);
  });
  // joined is an admin/recruiter stage move; done here as the owner
  await as('rA', async () => {
    await q(`update applications set stage = 'joined' where id = 'app_j'`);
  });
  await as('rB', async () => {
    const rep = (await q(`select * from can_engage('c5', 'jBr', null)`))[0];
    assert.equal(rep.decision, 'blocked', 'joined must hold a different role too');
    assert.equal(rep.reason, 'joined');
    // the AI call trigger enforces it as well
    await expectError(() => q(`select ai_call_queue('call_x', 'c5', 'jBr', null, 'rB', null, 'screen', null, null)`), 'TLB01');
  });
  await as('rA', async () => {
    assert.equal((await q(`select * from can_engage('c5', 'jA2', null)`))[0].decision, 'allowed',
      'the placing recruiter, same role');
    const other = (await q(`select * from can_engage('c5', null, 'medical representative')`))[0];
    assert.equal(other.decision, 'blocked', 'the replacement period blocks another role for everyone');
    assert.equal(other.reason, 'placed_other_role');
  });
  // 91 days later it is over
  await raw(`update application_stage_history set created_at = ${ago(91)} where application_id = 'app_j'`);
  await raw(`update applications set applied_at = ${ago(120)} where id = 'app_j'`);
  await as('rB', async () => {
    assert.equal((await q(`select * from can_engage('c5', 'jBr', null)`))[0].decision, 'allowed');
  });
});

test('an AI call is recorded as a contact', async () => {
  await as('rB', async () => {
    await q(`select ai_call_queue('call_ok', 'c3', 'jBr', null, 'rB', null, 'screen', null, null)`);
  });
  const r = await q(`select source, recruiter_id, role_key from candidate_contact_history where ref_id = 'call_ok'`);
  assert.deepEqual(r[0], { source: 'ai_call', recruiter_id: 'rB', role_key: 'medical representative' });
});

test('badges: one per candidate, about OTHER recruiters', async () => {
  await as('rB', async () => {
    const b = await q(`select * from engagement_badges(array['c1','c3','c4','c5'], null)`);
    const by = Object.fromEntries(b.map((x) => [x.candidate_id, x]));
    assert.equal(by.c3.kind, 'in_process', JSON.stringify(by.c3));
    assert.equal(by.c3.recruiter_name, 'Ravi');
    assert.equal(by.c4.kind, 'in_process');
    assert.ok(Array.isArray(by.c1.others));
  });
  await as('rA', async () => {
    const b = await q(`select * from engagement_badges(array['c2'], null)`);
    assert.equal(b.length, 1, 'the owner sees a badge row for their private candidate');
  });
  await as('rB', async () => {
    const b = await q(`select * from engagement_badges(array['c2'], null)`);
    assert.equal(b.length, 0, 'a private candidate leaked through the badges');
    const e = await q(`select * from candidate_engagements('c2', null)`);
    assert.equal(e.length, 0, 'a private candidate leaked through the engagements');
  });
  await as('rA', async () => {
    await q(`select engagement_record('c2', 'jA', null, 'phone', 'phone', 'interested', null, null)`);
  });
  await as('rB', async () => {
    const v = (await q(`select * from can_engage('c2', 'jB', null)`))[0];
    assert.equal(v.decision, 'warn', 'the rule still applies to a private candidate');
    assert.equal(v.holder_name, null, 'who works a PRIVATE candidate leaked through can_engage');
  });
});

test('admin: the conflicts view', async () => {
  await as('rB', async () => {
    await expectError(() => q(`select * from engagement_conflicts(90)`), '42501');
  });
  await as('admin', async () => {
    const rows = await q(`select * from engagement_conflicts(90)`);
    const c3 = rows.find((r) => r.candidate_id === 'c3' && r.role_key === 'medical coder');
    assert.ok(c3, `two recruiters on c3 for the coder role not listed: ${JSON.stringify(rows)}`);
    assert.equal(c3.recruiter_count, 2);
  });
});

test('stop', async () => { await dbh.stop(); });
