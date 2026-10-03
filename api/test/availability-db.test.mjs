/**
 * Candidate availability (0092), proved in the DATABASE, as the API's
 * own unprivileged role. The API suite (availability.test.mjs) covers the
 * routes, the messages and the reply page on top of this.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { startTestDb } from './harness.mjs';

const DB_PORT = 5478;
let dbh, db;
const uid = {};
const ROLE = { rA: 'recruiter', cand: 'candidate', cand2: 'candidate', admin: 'admin', client: 'client' };

async function as(who, fn) {
  const [id, role] = who === 'engine' ? ['', 'admin'] : who === 'anon' ? ['', 'anon'] : [uid[who], ROLE[who]];
  await db.exec('reset role');
  await db.query(`select set_config('app.user_id', $1, false), set_config('app.role', $2, false)`, [id, role]);
  await db.exec('set role app_api');
  try { return await fn(); } finally { await db.exec('reset role'); }
}
const q = async (sql, params) => (await db.query(sql, params)).rows;
const raw = (sql, params) => db.query(sql, params);
const hash = (t) => createHash('sha256').update(t).digest('hex');
async function expectError(fn, code) {
  try { await fn(); } catch (e) {
    if (code) assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`);
    return e;
  }
  assert.fail(`expected error ${code || ''}`);
}
const status = async (id) => (await q(`select availability_status s, availability_source src,
  availability_stale_at stale, can_join_in, notice_period from candidates where id = $1`, [id]))[0];

test('boot', async () => {
  dbh = await startTestDb(DB_PORT);
  db = dbh.db;
  await raw(`insert into companies (id, name) values ('co_x', 'Client X')`);
  for (const k of Object.keys(ROLE)) {
    const u = await raw(`insert into users (email, password_hash, role) values ($1,'x',$2) returning id`,
      [`${k}@av.test`, ROLE[k]]);
    uid[k] = u.rows[0].id;
  }
  await raw(`insert into recruiters (id, user_id, name, email, company_id) values ('rA', $1, 'Ravi', 'ra@av.test', 'co_x')`, [uid.rA]);
  await raw(`insert into admins (id, user_id, name, email) values ('adm', $1, 'Admin', 'a@av.test')`, [uid.admin]);
  await raw(`insert into client_users (id, user_id, name, email, company_id) values ('cl1', $1, 'Client', 'c@av.test', 'co_x')`, [uid.client]);
  await raw(`insert into jobs (id, title, company_id, recruiter_id, status) values ('j1', 'Medical Coder', 'co_x', 'rA', 'open')`);
  await raw(`insert into candidates (id, user_id, name, email, phone, owner_recruiter_id, notice_period)
             values ('k1', $1, 'Kavya Reddy', 'k1@av.test', '9100000001', 'rA', '30 days'),
                    ('k2', $2, 'Lakshmi', 'k2@av.test', '9100000002', null, null)`, [uid.cand, uid.cand2]);
});

test('a new candidate starts unknown; the notice period gives "can join in"', async () => {
  const s = await status('k1');
  assert.equal(s.s, 'unknown');
  assert.equal(s.can_join_in, '30 days');
});

test('the candidate changes their own status; a recruiter cannot', async () => {
  await as('cand', async () => {
    assert.equal((await q(`select availability_candidate_set('open_to_offers', '15 days', array['Medical Coder'], array['Nellore']) s`))[0].s,
      'open_to_offers');
    await expectError(() => q(`select availability_candidate_set('placed')`), '22023');
  });
  const s = await status('k1');
  assert.equal(s.s, 'open_to_offers');
  assert.equal(s.src, 'candidate');
  assert.equal(s.can_join_in, '15 days');
  assert.equal(s.notice_period, '15 days', 'can join in and notice period stay in sync');

  await as('rA', async () => {
    // the owner passes candidates_self_write, and is still refused
    await expectError(() => q(`update candidates set availability_status = 'not_looking' where id = 'k1'`), '42501');
    await expectError(() => q(`select availability_candidate_set('not_looking')`), '42501');
    // editing the notice period is allowed, and moves "can join in"
    await q(`update candidates set notice_period = '60 days' where id = 'k1'`);
  });
  assert.equal((await status('k1')).can_join_in, '60 days');

  await as('cand', async () => {
    // a candidate's own direct UPDATE is refused too - the function is the door
    await expectError(() => q(`update candidates set availability_status = 'actively_looking' where id = 'k1'`), '42501');
  });
  const hist = await q(`select from_status, to_status, source from candidate_availability_history where candidate_id = 'k1'`);
  assert.deepEqual(hist, [{ from_status: 'unknown', to_status: 'open_to_offers', source: 'candidate' }]);
});

test('applying while not looking makes them actively looking', async () => {
  await as('cand', async () => { await q(`select availability_candidate_set('not_looking')`); });
  await as('cand', async () => {
    await q(`insert into applications (id, job_id, candidate_id) values ('ap1', 'j1', 'k1')`);
  });
  const s = await status('k1');
  assert.equal(s.s, 'actively_looking');
  assert.equal(s.src, 'apply');
});

test('a recruiter adding them to a job is NOT the candidate applying', async () => {
  await as('rA', async () => {
    await q(`insert into applications (id, job_id, candidate_id) values ('ap2', 'j1', 'k2')`);
  });
  assert.equal((await status('k2')).s, 'unknown');
});

test('re-confirm: due after 30 days, at most once per 30 days', async () => {
  await raw(`update candidates set availability_confirmed_at = now() - interval '31 days' where id = 'k1'`);
  const due = await as('engine', () => q(`select id from availability_engine_due(now())`));
  assert.deepEqual(due.map((r) => r.id), ['k1']);
  await as('rA', async () => {
    await expectError(() => q(`select * from availability_engine_due(now())`), '42501');
  });

  await as('engine', async () => {
    await q(`select availability_engine_check_add('k1', 'reconfirm', $1, 'actively_looking', 'sms', '{"sms":"sent"}'::jsonb, now())`,
      [hash('tok-1')]);
    assert.equal((await q(`select id from availability_engine_due(now())`)).length, 0,
      'asked twice within 30 days');
  });
  // open to offers waits 60 days, not 30
  await as('cand2', async () => { await q(`select availability_candidate_set('open_to_offers')`); });
  await raw(`update candidates set availability_confirmed_at = now() - interval '45 days' where id = 'k2'`);
  assert.equal((await as('engine', () => q(`select id from availability_engine_due(now())`))).length, 0);
  await raw(`update candidates set availability_confirmed_at = now() - interval '61 days' where id = 'k2'`);
  assert.deepEqual((await as('engine', () => q(`select id from availability_engine_due(now())`))).map((r) => r.id), ['k2']);
});

test('the reply link: works once, without a login, only for that candidate', async () => {
  await as('anon', async () => {
    const peek = (await q(`select * from availability_reply_peek($1)`, [hash('tok-1')]))[0];
    assert.equal(peek.first_name, 'Kavya');
    assert.equal(peek.answered, false);
    assert.equal((await q(`select availability_reply($1, 'open_to_offers') r`, [hash('nope')]))[0].r, 'unknown');
    assert.equal((await q(`select availability_reply($1, 'placed') r`, [hash('tok-1')]))[0].r, 'invalid');
    assert.equal((await q(`select availability_reply($1, 'open_to_offers') r`, [hash('tok-1')]))[0].r, 'ok');
    assert.equal((await q(`select availability_reply($1, 'not_looking') r`, [hash('tok-1')]))[0].r, 'used');
  });
  const s = await status('k1');
  assert.equal(s.s, 'open_to_offers');
  assert.equal(s.src, 'reply_link');
  assert.equal((await status('k2')).s, 'open_to_offers', 'another candidate was touched');
});

test('the reply link expires after 14 days', async () => {
  await as('engine', () => q(`select availability_engine_check_add('k2', 'reconfirm', $1, 'open_to_offers', 'email', '{}'::jsonb, now() - interval '15 days')`,
    [hash('tok-old')]));
  await as('anon', async () => {
    assert.equal((await q(`select availability_reply($1, 'not_looking') r`, [hash('tok-old')]))[0].r, 'expired');
  });
});

test('no answer in 14 days -> "Not confirmed", ranked lower, cleared by any answer', async () => {
  const n = (await as('engine', () => q(`select availability_engine_lapse(now()) n`)))[0].n;
  assert.equal(n, 1);
  assert.ok((await status('k2')).stale, 'not marked Not confirmed');
  const r = (await q(`select availability_rank('actively_looking', null) a, availability_rank('open_to_offers', null) o,
                             availability_rank('unknown', null) u, availability_rank('actively_looking', now()) nc,
                             availability_rank('not_looking', null) nl`))[0];
  assert.ok(r.a < r.o && r.o < r.u && r.u < r.nc && r.nc < r.nl, JSON.stringify(r));
  await as('cand2', async () => { await q(`select availability_candidate_set('actively_looking')`); });
  assert.equal((await status('k2')).stale, null);
});

test('joined -> placed; after 90 days -> not looking', async () => {
  await as('rA', async () => { await q(`update applications set stage = 'joined' where id = 'ap1'`); });
  let s = await status('k1');
  assert.equal(s.s, 'placed');
  assert.equal(s.src, 'system');
  assert.equal((await as('engine', () => q(`select id from availability_engine_placed_due(now())`))).length, 0);
  await raw(`update candidates set availability_placed_at = now() - interval '91 days' where id = 'k1'`);
  const due = await as('engine', () => q(`select id from availability_engine_placed_due(now())`));
  assert.deepEqual(due.map((r) => r.id), ['k1']);
  assert.equal((await as('engine', () => q(`select availability_engine_release('k1') r`)))[0].r, true);
  assert.equal((await as('engine', () => q(`select availability_engine_release('k1') r`)))[0].r, false, 'released twice');
  s = await status('k1');
  assert.equal(s.s, 'not_looking');
});

test('the admin report counts statuses and checks', async () => {
  const rep = (await as('admin', () => q(`select availability_report(30) r`)))[0].r;
  assert.ok(rep.byStatus.not_looking >= 1);
  assert.ok(rep.checks.sent >= 2);
  assert.equal(rep.checks.answered, 1);
  await as('rA', async () => { await expectError(() => q(`select availability_report(30)`), '42501'); });
});

test('the backfill: recent activity -> actively looking, the rest unknown', async () => {
  // replay the backfill statement on fresh rows
  await raw(`insert into candidates (id, name, email) values ('b1', 'Old', 'b1@av.test'), ('b2', 'New', 'b2@av.test')`);
  const u = await raw(`insert into users (email, password_hash, role, last_login_at) values ('b2@av.test','x','candidate', now() - interval '2 days') returning id`);
  await raw(`update candidates set user_id = $1 where id = 'b2'`, [u.rows[0].id]);
  const { readFileSync } = await import('node:fs');
  const sql = readFileSync(new URL('../../supabase/migrations/0092_availability_status.sql', import.meta.url), 'utf8');
  const start = sql.indexOf('with active as (');
  const end = sql.indexOf(';', start);
  await raw(sql.slice(start, end));
  assert.equal((await status('b2')).s, 'actively_looking');
  assert.equal((await status('b1')).s, 'unknown');
});

test('stop', async () => { await dbh.stop(); });
