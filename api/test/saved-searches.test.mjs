/**
 * Saved searches and their alerts, end to end against a real Postgres
 * with RLS on.
 *
 * Self-contained: the demo data was removed from the migrations (0029,
 * 0033), so this file makes its own company, jobs and candidates rather
 * than leaning on seeded rows that are no longer there.
 *
 * Nothing leaves the machine. Email goes to the mock provider through
 * EMAIL_API_URL, SMS to the same mock, WhatsApp to a closed port; the
 * mock records what it was handed, which is what the assertions read.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb, applyTestEnv, makeClient, startMockProvider } from './harness.mjs';

const DB_PORT = 5436;
const API_PORT = 9996;
const MOCK_PORT = 9878;

let dbh, server, mock, base, raw, alerts;
const day = (h, plusDays = 0) => {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + plusDays, h, 0, 0);
};
const DAYTIME = day(6);              // 11:30 IST
const NIGHT = day(17);               // 22:30 IST
const NEXT_MORNING = day(3, 2);      // 08:30 IST, two days on - past a daily slot

let jobSeq = 0;
async function job(fields = {}) {
  jobSeq += 1;
  const id = fields.id || `jt${jobSeq}`;
  await raw(`insert into jobs (id, title, company_id, location, mode, exp_label, pay_label,
                               salary_min, salary_max, employment_type, status, skills,
                               published_at)
             values ($1,$2,'co_t',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [id, fields.title || 'Role', fields.location || 'Nellore', fields.mode || 'Onsite',
     fields.exp || '0-2 yrs', fields.pay || '₹2-3 LPA', fields.salaryMin ?? 2, fields.salaryMax ?? 3,
     fields.type || 'Full-time', fields.status || 'open', fields.skills || [],
     fields.publishedAt || new Date()]);
  return id;
}

async function candidate(name, email, phone) {
  const c = makeClient(base);
  await c.get('/api/health');
  const r = await c.post('/api/auth/register', {
    name, email, password: 'Saved123search', phone,
    preferredLocation: 'Nellore', expectedCtc: 3, noticePeriod: 'Immediate',
    preferredWorkModes: ['Work From Office'],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  c.id = r.body.candidateId;
  c.email = email;
  return c;
}

const deliveries = async (searchId) =>
  (await raw(`select channel, status, job_ids from candidate_saved_search_deliveries
               where saved_search_id = $1 order by id`, [searchId])).rows;

test('boot', async () => {
  dbh = await startTestDb(DB_PORT);
  mock = await startMockProvider(MOCK_PORT);
  applyTestEnv(dbh.url, {
    PUBLIC_ORIGIN: `http://127.0.0.1:${API_PORT}`,
    DISABLE_BACKGROUND_WORK: 'true',
    SMS_API_URL: `http://127.0.0.1:${MOCK_PORT}/sms`,
    EMAIL_API_KEY: 'test-key',
    EMAIL_FROM: 'alerts@teamlink.example',
    EMAIL_API_URL: `http://127.0.0.1:${MOCK_PORT}/email`,
    EMAIL_SMTP_HOST: '', EMAIL_SMTP_USER: '', EMAIL_SMTP_PASS: '',
    EMAILJS_SERVICE_ID: '', EMAILJS_TEMPLATE_ID: '', EMAILJS_PUBLIC_KEY: '', EMAILJS_PRIVATE_KEY: '',
    OUTBOUND_ALLOWLIST: '',
  });
  raw = (sql, params) => dbh.db.query(sql, params);
  await raw(`insert into companies (id, name) values ('co_t', 'Nellore Logistics')`);

  const { createApp } = await import('../src/app.js');
  alerts = await import('../src/notify/saved-search-alerts.js');
  const app = createApp({ logger: { error() {}, log() {} } });
  await new Promise((r) => { server = app.listen(API_PORT, r); });
  base = `http://127.0.0.1:${API_PORT}`;
});

/* ------------------------------------------------------------------ *
 * CRUD
 * ------------------------------------------------------------------ */

let A, B;

test('save, list, rename, change frequency, delete', async () => {
  A = await candidate('Asha Rao', 'asha.rao@tl-sink.local', '9000000001');
  B = await candidate('Bala Krishna', 'bala.k@tl-sink.local', '9000000002');

  const made = await A.post('/api/saved-searches', {
    filters: { q: 'Driver', locTags: ['Nellore'], ctcMin: 2, types: ['Full-time'] },
  });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const s = made.body.savedSearch;
  assert.equal(s.label, 'Driver · Nellore · ₹2L+ · Full-time');
  assert.equal(s.alertFrequency, 'daily');
  assert.deepEqual(s.channels.sort(), ['email', 'sms'], 'defaults to the channels the candidate has');

  const list = await A.get('/api/saved-searches');
  assert.equal(list.status, 200);
  assert.equal(list.body.savedSearches.length, 1);
  assert.equal(list.body.savedSearches[0].newCount, 0, 'nothing is new the moment it is saved');

  const upd = await A.put(`/api/saved-searches/${s.id}`, {
    label: 'Driving jobs', alert_frequency: 'weekly', channels: ['email'],
  });
  assert.equal(upd.status, 200);
  assert.equal(upd.body.savedSearch.label, 'Driving jobs');
  assert.equal(upd.body.savedSearch.alertFrequency, 'weekly');
  assert.deepEqual(upd.body.savedSearch.channels, ['email']);

  const del = await A.del(`/api/saved-searches/${s.id}`);
  assert.equal(del.status, 200);
  assert.equal((await A.get('/api/saved-searches')).body.savedSearches.length, 0);
});

test('unknown filter keys and values are refused, and an empty search is too', async () => {
  let r = await A.post('/api/saved-searches', { filters: { q: 'Driver', salaryHack: 1 } });
  assert.equal(r.status, 400);
  assert.match(JSON.stringify(r.body.error.details), /Unknown filter: salaryHack/);

  r = await A.post('/api/saved-searches', { filters: { types: ['Gig'] } });
  assert.equal(r.status, 400);
  assert.ok(r.body.error.details['filters.types.0']);

  r = await A.post('/api/saved-searches', { filters: { q: '   ' } });
  assert.equal(r.status, 400, 'an empty search would match every job');

  r = await A.post('/api/saved-searches', { filters: { q: 'x' }, alert_frequency: 'hourly' });
  assert.equal(r.status, 400);
});

test('the same filters saved twice return the existing search (409 with its id)', async () => {
  const one = await A.post('/api/saved-searches', { filters: { q: 'Electrician', exp: ['Fresher'] } });
  assert.equal(one.status, 201);
  // Same search, written differently: order and spacing do not make it new.
  const two = await A.post('/api/saved-searches', { filters: { exp: ['Fresher'], q: ' Electrician ' } });
  assert.equal(two.status, 409);
  assert.equal(two.body.error.code, 'DUPLICATE_SEARCH');
  assert.equal(two.body.id, one.body.savedSearch.id);
  await A.del(`/api/saved-searches/${one.body.savedSearch.id}`);
});

test('twenty is the limit, and the database enforces it', async () => {
  const C = await candidate('Chitra Devi', 'chitra.d@tl-sink.local');
  for (let i = 1; i <= 20; i += 1) {
    const r = await C.post('/api/saved-searches', { filters: { q: `role ${i}` } });
    assert.equal(r.status, 201, `#${i}: ${JSON.stringify(r.body)}`);
  }
  const over = await C.post('/api/saved-searches', { filters: { q: 'role 21' } });
  assert.equal(over.status, 409);
  assert.equal(over.body.error.code, 'SAVED_SEARCH_LIMIT');

  // Not just the route: a direct insert past twenty is refused too.
  await assert.rejects(raw(
    `insert into candidate_saved_searches (id, candidate_id, label, filters) values ('ss_x', $1, 'x', '{"q":"x"}')`,
    [C.id]), /saved_search_limit/);
});

/* ------------------------------------------------------------------ *
 * privacy
 * ------------------------------------------------------------------ */

test('a candidate cannot see, change or delete another candidate\'s searches', async () => {
  const mine = (await A.post('/api/saved-searches', { filters: { q: 'Welder' } })).body.savedSearch;

  const theirs = await B.get('/api/saved-searches');
  assert.equal(theirs.body.savedSearches.some((s) => s.id === mine.id), false);
  assert.equal((await B.put(`/api/saved-searches/${mine.id}`, { label: 'gotcha' })).status, 404);
  assert.equal((await B.del(`/api/saved-searches/${mine.id}`)).status, 404);
  assert.equal((await B.post(`/api/saved-searches/${mine.id}/viewed`)).status, 404);

  const still = (await A.get('/api/saved-searches')).body.savedSearches.find((s) => s.id === mine.id);
  assert.equal(still.label, mine.label);
});

test('staff cannot read saved searches, nor call the engine\'s functions', async () => {
  const { withUser } = await import('../src/db.js');
  const admin = (await raw(`insert into users (email,password_hash,role)
                             values ('ops@tl-sink.local','x','admin') returning id`)).rows[0].id;
  const staff = { userId: admin, role: 'admin', profileId: null };
  const n = await withUser(staff, async (c) =>
    (await c.query(`select count(*)::int n from candidate_saved_searches`)).rows[0].n);
  assert.equal(n, 0, 'an administrator sees none of them');
  await assert.rejects(withUser(staff, (c) =>
    c.query(`select * from saved_search_engine_list(array['daily'])`)), /alert engine only/);
});

/* ------------------------------------------------------------------ *
 * "N new"
 * ------------------------------------------------------------------ */

test('newCount counts matching jobs published since the search was last viewed', async () => {
  const s = (await A.post('/api/saved-searches', { filters: { q: 'Forklift' } })).body.savedSearch;
  await new Promise((r) => setTimeout(r, 20));
  await job({ title: 'Forklift Operator' });
  await job({ title: 'Cashier' });

  let row = (await A.get('/api/saved-searches')).body.savedSearches.find((x) => x.id === s.id);
  assert.equal(row.newCount, 1);

  assert.equal((await A.post(`/api/saved-searches/${s.id}/viewed`)).status, 200);
  row = (await A.get('/api/saved-searches')).body.savedSearches.find((x) => x.id === s.id);
  assert.equal(row.newCount, 0);
});

/* ------------------------------------------------------------------ *
 * alerts
 * ------------------------------------------------------------------ */

test('an instant alert is sent once per job, on every channel chosen', async () => {
  const s = (await A.post('/api/saved-searches', {
    filters: { q: 'Crane' }, alert_frequency: 'instant', channels: ['email', 'sms'],
  })).body.savedSearch;
  const before = mock.received.length;
  const jid = await job({ title: 'Crane Operator' });

  const r1 = await alerts.runSavedSearchInstant(jid, { now: DAYTIME });
  assert.equal(r1.sent, 1);
  const d = await deliveries(s.id);
  assert.deepEqual(d.map((x) => `${x.channel}:${x.status}`).sort(), ['email:sent', 'sms:sent']);
  assert.deepEqual(d[0].job_ids, [jid]);

  const email = mock.received.slice(before).find((m) => m.url === '/email');
  assert.ok(email, 'the email reached the provider');
  assert.match(email.body.subject, /New job for "Crane": Crane Operator/);
  assert.match(email.body.html, /Stop this alert/);
  assert.match(email.body.html, /saved-searches\/stop\?token=/);

  // Again, and through the sweep: nothing more.
  await alerts.runSavedSearchInstant(jid, { now: DAYTIME });
  await alerts.runSavedSearchSweep({ now: DAYTIME, kinds: ['instant'] });
  assert.equal((await deliveries(s.id)).length, 2, 'no second message for the same job');
});

test('quiet hours hold SMS back but not email', async () => {
  const s = (await A.post('/api/saved-searches', {
    filters: { q: 'Night Guard' }, alert_frequency: 'instant', channels: ['email', 'sms'],
  })).body.savedSearch;
  const jid = await job({ title: 'Night Guard' });
  await alerts.runSavedSearchInstant(jid, { now: NIGHT });
  const d = await deliveries(s.id);
  assert.deepEqual(d.map((x) => `${x.channel}:${x.status}`).sort(),
    ['email:sent', 'sms:skipped_quiet_hours']);
});

test('WhatsApp without an approved template records not_configured', async () => {
  await raw(`update candidates set whatsapp_opt_in = true where id = $1`, [A.id]);
  const s = (await A.post('/api/saved-searches', {
    filters: { q: 'Mason' }, alert_frequency: 'instant', channels: ['whatsapp'],
  })).body.savedSearch;
  const jid = await job({ title: 'Mason' });
  await alerts.runSavedSearchInstant(jid, { now: DAYTIME });
  const d = await deliveries(s.id);
  assert.equal(d.length, 1);
  assert.equal(d[0].status, 'not_configured');
});

test('the daily digest sends ONE message grouping the new jobs, once', async () => {
  const s = (await B.post('/api/saved-searches', {
    filters: { q: 'Plumber' }, alert_frequency: 'daily', channels: ['email'],
  })).body.savedSearch;
  const ids = [await job({ title: 'Plumber' }), await job({ title: 'Senior Plumber' }),
               await job({ title: 'Plumber Helper' })];
  const before = mock.received.length;

  await alerts.runSavedSearchSweep({ now: NEXT_MORNING, kinds: ['daily'] });
  const d = await deliveries(s.id);
  assert.equal(d.length, 1, 'one message, not three');
  assert.equal(d[0].status, 'sent');
  assert.deepEqual([...d[0].job_ids].sort(), [...ids].sort());
  // Other candidates' digests go out in the same sweep; this one is B's.
  const mail = mock.received.slice(before)
    .filter((m) => m.url === '/email' && (m.body.to || []).includes(B.email));
  assert.equal(mail.length, 1);
  assert.match(mail[0].body.subject, /3 new jobs for "Plumber"/);

  await alerts.runSavedSearchSweep({ now: NEXT_MORNING + 3600_000, kinds: ['daily'] });
  assert.equal((await deliveries(s.id)).length, 1, 'the same slot is not processed twice');
});

test('closed, applied, hidden and already-alerted jobs are left out of a digest', async () => {
  const D = await candidate('Dinesh Kumar', 'dinesh.k@tl-sink.local');
  const s = (await D.post('/api/saved-searches', {
    filters: { q: 'Painter' }, alert_frequency: 'daily', channels: ['email'],
  })).body.savedSearch;

  const closed = await job({ title: 'Painter (closed)' });
  const applied = await job({ title: 'Painter (applied)' });
  const hidden = await job({ title: 'Painter (hidden)' });
  const told = await job({ title: 'Painter (told)' });
  const fresh = await job({ title: 'Painter' });

  // The hits exist before anything changes - as they would on publish.
  for (const id of [closed, applied, hidden, told, fresh]) {
    await alerts.runSavedSearchInstant(id, { now: DAYTIME });
  }
  await raw(`update jobs set status = 'closed' where id = $1`, [closed]);
  assert.equal((await D.post('/api/applications', { jobId: applied })).status, 201);
  assert.equal((await D.post(`/api/hidden-jobs/${hidden}`)).status, 200);
  await raw(`insert into job_matches (id, job_id, candidate_id, score, threshold, notified)
             values ('jm_t1', $1, $2, 80, 60, true)`, [told, D.id]);

  await alerts.runSavedSearchSweep({ now: NEXT_MORNING, kinds: ['daily'] });
  const d = await deliveries(s.id);
  assert.equal(d.length, 1);
  assert.deepEqual(d[0].job_ids, [fresh]);
});

test('"Stop this alert" works without signing in, and only for that alert', async () => {
  const one = (await A.post('/api/saved-searches', { filters: { q: 'Tailor' }, alert_frequency: 'daily' })).body.savedSearch;
  const other = (await A.post('/api/saved-searches', { filters: { q: 'Baker' }, alert_frequency: 'daily' })).body.savedSearch;

  const stranger = makeClient(base);          // no cookies at all
  const ok = await stranger.get(`/api/saved-searches/stop?token=${encodeURIComponent(alerts.stopToken(one.id))}`);
  assert.equal(ok.status, 200);
  assert.match(ok.body.raw, /Alert stopped/);

  const forged = await stranger.get(`/api/saved-searches/stop?token=${encodeURIComponent(`${other.id}.${alerts.stopToken(one.id).split('.')[1]}`)}`);
  assert.equal(forged.status, 400, 'a token for one search does not stop another');

  const list = (await A.get('/api/saved-searches')).body.savedSearches;
  assert.equal(list.find((s) => s.id === one.id).alertFrequency, 'off');
  assert.equal(list.find((s) => s.id === other.id).alertFrequency, 'daily');
});

test('migration 0086 copied a browser-stored job alert into candidate_saved_searches', async () => {
  // A fresh database, with an old-style alert written before 0086 runs.
  const { PGlite } = await import('@electric-sql/pglite');
  const { readFileSync, readdirSync } = await import('node:fs');
  const { join, resolve, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../../supabase/migrations');
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const db = await new PGlite();
  for (const f of files.filter((f) => f < '0086')) await db.exec(readFileSync(join(dir, f), 'utf8'));
  const u = (await db.query(`insert into users (email,password_hash,role) values ('old@tl-sink.local','x','candidate') returning id`)).rows[0].id;
  await db.query(`insert into candidates (id, name, email, user_id) values ('cand_old','Old Alert','old@tl-sink.local',$1)`, [u]);
  await db.query(`insert into user_prefs (user_id, key, value) values ($1, 'teamlink_job_alerts_v1', $2::jsonb)`,
    [u, JSON.stringify([
      { id: 'al1', q: 'React Developer', loc: 'Hyderabad', freq: 'Weekly', paused: false },
      { id: 'al2', q: 'Tester', loc: 'Remote', freq: 'Daily', paused: true },
    ])]);
  for (const f of files.filter((f) => f >= '0086')) await db.exec(readFileSync(join(dir, f), 'utf8'));
  const rows = (await db.query(
    `select label, filters, alert_frequency from candidate_saved_searches where candidate_id = 'cand_old' order by label`)).rows;
  await db.close();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { label: 'React Developer · Hyderabad',
    filters: { q: 'React Developer', locTags: ['Hyderabad'] }, alert_frequency: 'weekly' });
  assert.deepEqual(rows[1], { label: 'Tester · Remote',
    filters: { q: 'Tester', modes: ['Remote'] }, alert_frequency: 'off' }, 'a paused alert stays quiet');
});

test('teardown', async () => {
  await new Promise((r) => server.close(r));
  const { closePool } = await import('../src/db.js');
  await closePool();
  await mock.stop();
  await dbh.stop();
});
