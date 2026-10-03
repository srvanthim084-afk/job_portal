/**
 * Candidate availability status, end to end through the API (migration
 * 0092; routes/availability.js, notify/availability-checks.js, the
 * candidate search). The rules are proved one level down in
 * availability-db.test.mjs; this file proves what a person sees:
 *
 *   - registration asks it; the candidate changes it; a recruiter cannot
 *   - recruiter search hides not_looking / placed by default, "Show all"
 *     shows them, the filter and the ranking run in SQL
 *   - applying while not looking -> actively looking
 *   - clients never see a single availability field
 *   - "Still looking?" goes out after 30 days, once per 30 days, never at
 *     night; its link works without a login, once; no answer -> "Not
 *     confirmed"
 *   - joined -> placed (blocks another role), 90 days -> not looking + one
 *     message
 *   - bulk message skips placed always and not_looking by default
 *   - the admin report
 *
 * SMS goes to the mock provider; nothing leaves the machine.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb, applyTestEnv, makeClient, startMockProvider } from './harness.mjs';

const DB_PORT = 5462;
const API_PORT = 9982;
const MOCK_PORT = 9970;

let dbh, server, mock, base, raw, sweep;
let REC, ADMIN, CLIENT, CAND;
const ids = {};

const day = (hIst, plusDays = 0) => {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + plusDays, hIst, 0, 0) - 330 * 60000;
};
const NOON = day(12);
const NIGHT = day(23);

async function signIn(email, password) {
  const c = makeClient(base);
  await c.get('/api/health');
  const r = await c.post('/api/auth/login', { email, password });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return c;
}

async function register(name, email, phone, availability) {
  const c = makeClient(base);
  await c.get('/api/health');
  const r = await c.post('/api/auth/register', {
    name, email, password: 'Avail123able', phone,
    preferredLocation: 'Nellore', expectedCtc: 3, noticePeriod: '30 days',
    preferredWorkModes: ['Office'], ...(availability ? { availability } : {}),
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  c.id = r.body.candidateId;
  return c;
}

const smsTo = (phone) => mock.received.filter((m) => m.url === '/sms' && String(m.body.to).endsWith(phone));
const status = async (id) => (await raw(`select availability_status s, availability_source src,
  availability_stale_at stale from candidates where id = $1`, [id])).rows[0];

test('boot', async () => {
  dbh = await startTestDb(DB_PORT);
  mock = await startMockProvider(MOCK_PORT);
  applyTestEnv(dbh.url, {
    PUBLIC_ORIGIN: `http://127.0.0.1:${API_PORT}`,
    DISABLE_BACKGROUND_WORK: 'true',
    SMS_API_URL: `http://127.0.0.1:${MOCK_PORT}/sms`,
    EMAIL_API_KEY: '', EMAIL_SMTP_HOST: '', EMAIL_SMTP_USER: '', EMAIL_SMTP_PASS: '',
    EMAILJS_SERVICE_ID: '', EMAILJS_TEMPLATE_ID: '', EMAILJS_PUBLIC_KEY: '', EMAILJS_PRIVATE_KEY: '',
    OUTBOUND_ALLOWLIST: '',
    AVAILABILITY_RECONFIRM_MESSAGES: 'true',
  });
  raw = (sql, params) => dbh.db.query(sql, params);

  const { hashPassword } = await import('../src/auth.js');
  const hash = await hashPassword('Avail123able');
  await raw(`insert into companies (id, name) values ('co_x', 'Nellore Health Services')`);
  const user = async (email, role) => (await raw(
    `insert into users (email, password_hash, role) values ($1,$2,$3) returning id`, [email, hash, role])).rows[0].id;
  await raw(`insert into recruiters (id, user_id, name, email, company_id) values ('rA', $1, 'Ravi', 'ravi.av@tl-sink.local', 'co_x')`,
    [await user('ravi.av@tl-sink.local', 'recruiter')]);
  await raw(`insert into admins (id, user_id, name, email) values ('adm', $1, 'Admin', 'admin.av@tl-sink.local')`,
    [await user('admin.av@tl-sink.local', 'admin')]);
  await raw(`insert into client_users (id, user_id, name, email, company_id) values ('cl1', $1, 'Client', 'client.av@tl-sink.local', 'co_x')`,
    [await user('client.av@tl-sink.local', 'client')]);
  await raw(`insert into jobs (id, title, company_id, recruiter_id, status, location) values
     ('jA', 'Medical Coder', 'co_x', 'rA', 'open', 'Nellore'),
     ('jR', 'Medical Representative', 'co_x', 'rA', 'open', 'Nellore')`);

  const { createApp } = await import('../src/app.js');
  ({ runAvailabilitySweep: sweep } = await import('../src/notify/availability-checks.js'));
  const app = createApp({ logger: { error() {}, log() {} } });
  await new Promise((r) => { server = app.listen(API_PORT, r); });
  base = `http://127.0.0.1:${API_PORT}`;
  REC = await signIn('ravi.av@tl-sink.local', 'Avail123able');
  ADMIN = await signIn('admin.av@tl-sink.local', 'Avail123able');
  CLIENT = await signIn('client.av@tl-sink.local', 'Avail123able');
});

test('registration asks it; the candidate changes it; a recruiter cannot', async () => {
  CAND = await register('Kavya Reddy', 'kavya.av@tl-sink.local', '9200000001', 'not_looking');
  ids.k = CAND.id;
  let me = await CAND.get('/api/candidate/availability');
  assert.equal(me.status, 200);
  assert.equal(me.body.availability.status, 'not_looking');
  assert.equal(me.body.availability.source, 'register');

  const plain = await register('Lakshmi Devi', 'lakshmi.av@tl-sink.local', '9200000002');
  ids.l = plain.id;
  assert.equal((await status(ids.l)).s, 'actively_looking', 'the registration default is Actively looking');

  const put = await CAND.put('/api/candidate/availability',
    { status: 'open_to_offers', canJoinIn: '15 days', preferredRoles: ['Medical Coder'], preferredCities: ['Nellore'] });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(put.body.availability.status, 'open_to_offers');
  assert.equal(put.body.availability.canJoinIn, '15 days');
  assert.equal(put.body.noticePeriod, '15 days', 'can join in and notice period are not in sync');
  assert.equal((await CAND.put('/api/candidate/availability', { status: 'placed' })).status, 400);

  const rec = await REC.put(`/api/candidates/${ids.k}/availability`, { status: 'not_looking' });
  assert.equal(rec.status, 403, 'a recruiter changed a candidate\'s availability');
  assert.equal((await status(ids.k)).s, 'open_to_offers');
});

test('search: not looking is hidden by default, "Show all" shows it, the filter runs in SQL', async () => {
  await CAND.put('/api/candidate/availability', { status: 'not_looking' });
  const def = await REC.get('/api/candidates?limit=200');
  assert.ok(!def.body.candidates.some((c) => c.id === ids.k), 'not looking shown by default');
  assert.ok(def.body.candidates.some((c) => c.id === ids.l));

  const all = await REC.get('/api/candidates?limit=200&availabilityAll=true');
  const k = all.body.candidates.find((c) => c.id === ids.k);
  assert.ok(k, '"Show all" did not show them');
  assert.equal(k.availabilityStatus.status, 'not_looking');
  assert.equal(k.availabilityStatus.label, 'Not looking');

  const only = await REC.get('/api/candidates?limit=200&availability=not_looking');
  assert.deepEqual(only.body.candidates.map((c) => c.id), [ids.k]);
  assert.equal(only.body.total, 1);
});

test('applying while not looking makes them actively looking', async () => {
  const r = await CAND.post('/api/applications', { jobId: 'jA' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  ids.appK = r.body.application.id;
  const s = await status(ids.k);
  assert.equal(s.s, 'actively_looking');
  assert.equal(s.src, 'apply');
  const def = await REC.get('/api/candidates?limit=200');
  const k = def.body.candidates.find((c) => c.id === ids.k);
  assert.equal(k.availabilityStatus.status, 'actively_looking');
});

test('ranking: actively looking first, then open to offers, unknown, not confirmed', async () => {
  // four more people, set directly (the test database connection is privileged)
  for (const [id, st, stale] of [['rk_open', 'open_to_offers', false], ['rk_unknown', 'unknown', false],
                                 ['rk_stale', 'actively_looking', true], ['rk_active', 'actively_looking', false]]) {
    await raw(`insert into candidates (id, name, email, availability_status, availability_stale_at)
               values ($1, $2, $3, $4, ${stale ? 'now()' : 'null'})`, [id, `Aaa ${id}`, `${id}@tl-sink.local`, st]);
  }
  const r = await REC.get('/api/candidates?limit=200&sort=Relevance');
  const order = r.body.candidates.map((c) => c.id).filter((x) => x.startsWith('rk_'));
  assert.deepEqual(order, ['rk_active', 'rk_open', 'rk_unknown', 'rk_stale']);
  const stale = r.body.candidates.find((c) => c.id === 'rk_stale');
  assert.equal(stale.availabilityStatus.label, 'Not confirmed');
});

test('a client never sees an availability field', async () => {
  await REC.put(`/api/applications/${ids.appK}/status`, { stage: 'shortlisted' });
  const r = await CLIENT.get('/api/candidates?limit=200');
  assert.equal(r.status, 200);
  assert.ok(r.body.candidates.some((c) => c.id === ids.k), 'the client cannot see their shortlisted candidate');
  const text = JSON.stringify(r.body);
  assert.ok(!/availability|actively_looking|open_to_offers|canJoinIn/i.test(text), 'availability reached a client');
  const one = await CLIENT.get(`/api/candidates/${ids.k}`);
  assert.ok(!/availability|actively_looking/i.test(JSON.stringify(one.body)));
  const boot = await CLIENT.get('/api/bootstrap');
  assert.ok(!/availability_status|actively_looking/i.test(JSON.stringify(boot.body)));
});

test('re-confirm: asked after 30 days, once per 30 days, never at night; the link works once', async () => {
  await raw(`update candidates set availability_confirmed_at = now() - interval '31 days' where id = $1`, [ids.l]);
  await raw(`update candidates set availability_confirmed_at = now() - interval '31 days',
                                    availability_status = 'actively_looking' where id = 'rk_active'`);

  const night = await sweep({ now: NIGHT });
  assert.equal(night.skipped, 'quiet hours (21:00-08:00 IST)');
  assert.equal(night.asked, 0);
  assert.equal(smsTo('9200000002').length, 0, 'a message went out at night');

  const day1 = await sweep({ now: NOON });
  assert.ok(day1.asked >= 1, JSON.stringify(day1));
  const sms = smsTo('9200000002');
  assert.equal(sms.length, 1, 'no SMS reached the mock provider');
  assert.match(sms[0].body.message, /Still looking for a job\?/);
  assert.ok(!/Client|Nellore Health/i.test(sms[0].body.message), 'the client name reached a candidate');

  const again = await sweep({ now: NOON });
  assert.equal(smsTo('9200000002').length, 1, 'asked twice within 30 days');
  assert.equal(again.asked, 0);

  const link = sms[0].body.message.match(/Open to offers: (\S+)/)[1];
  const page = await fetch(link);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Confirm: Open to offers/);
  assert.equal((await status(ids.l)).s, 'actively_looking', 'opening the link changed the status by itself');

  const u = new URL(link);
  const post = (a) => fetch(`${base}/api/availability/reply`, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ t: u.searchParams.get('t'), a }),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const ok = await post('open_to_offers');
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.result, 'ok');
  assert.equal((await post('not_looking')).body.result, 'used', 'the link worked twice');
  const s = await status(ids.l);
  assert.equal(s.s, 'open_to_offers');
  assert.equal(s.src, 'reply_link');

  const bad =await fetch(`${base}/api/availability/reply?t=abc.def&a=open_to_offers`);
  assert.equal(bad.status, 400);
});

test('no answer in 14 days -> "Not confirmed"', async () => {
  const later = await sweep({ now: NOON + 15 * 86400000 });
  assert.ok(later.lapsed >= 1, JSON.stringify(later));
  const r = await REC.get('/api/candidates?limit=200&availability=not_confirmed');
  assert.ok(r.body.candidates.some((c) => c.id === 'rk_active'), JSON.stringify(r.body.candidates.map((c) => c.id)));
});

test('joined -> placed, blocks another role; after 90 days -> not looking + one message', async () => {
  const j = await REC.put(`/api/applications/${ids.appK}/status`, { stage: 'joined' });
  assert.equal(j.status, 200, JSON.stringify(j.body));
  assert.equal((await status(ids.k)).s, 'placed');

  const other = await REC.post('/api/engagement/check', { candidateId: ids.k, jobId: 'jR', action: 'call' });
  assert.equal(other.status, 409, 'placed did not block another role');
  assert.equal(other.body.error.code, 'ENGAGEMENT_BLOCKED');
  const addOther = await REC.post('/api/applications', { jobId: 'jR', candidateId: ids.k });
  assert.equal(addOther.status, 409, 'placed: add-to-job for another role not blocked on the server');

  // the recruiter asks, an administrator approves with a reason, it is logged
  const ask = await REC.post('/api/engagement/overrides',
    { candidateId: ids.k, jobId: 'jR', kind: 'placed', reason: 'The client let her go after a month' });
  assert.equal(ask.status, 201, JSON.stringify(ask.body));
  const yes = await ADMIN.post(`/api/engagement/overrides/${ask.body.override.id}/decide`,
    { approve: true, reason: 'Replacement period waived by the client' });
  assert.equal(yes.status, 200, JSON.stringify(yes.body));
  const addNow = await REC.post('/api/applications', { jobId: 'jR', candidateId: ids.k });
  assert.equal(addNow.status, 201, JSON.stringify(addNow.body));
  const logged = (await raw(`select action from engagement_audit where candidate_id = $1`, [ids.k])).rows.map((x) => x.action);
  for (const x of ['override_requested', 'override_approved', 'override_used']) assert.ok(logged.includes(x), x);

  const before = smsTo('9200000001').length;
  await raw(`update candidates set availability_placed_at = now() - interval '91 days' where id = $1`, [ids.k]);
  const r = await sweep({ now: NOON });
  assert.equal(r.released, 1);
  assert.equal((await status(ids.k)).s, 'not_looking');
  const msgs = smsTo('9200000001').slice(before);
  assert.equal(msgs.length, 1, 'the after-placement message did not go, or went twice');
  assert.match(msgs[0].body.message, /new role/i);
  await sweep({ now: NOON });
  assert.equal(smsTo('9200000001').length, before + 1, 'the after-placement message went twice');
});

test('bulk message: placed never, not looking only when ticked', async () => {
  await raw(`insert into candidates (id, name, email, phone, availability_status) values
     ('bm_placed', 'Placed P', 'bmp@tl-sink.local', '9200000011', 'placed'),
     ('bm_nl', 'Not Looking N', 'bmn@tl-sink.local', '9200000012', 'not_looking'),
     ('bm_ok', 'Looking L', 'bml@tl-sink.local', '9200000013', 'actively_looking')`);
  const send = (extra) => REC.post('/api/candidates/bulk-message', {
    channel: 'sms', body: 'Hi {{first_name}}', candidateIds: ['bm_placed', 'bm_nl', 'bm_ok'], ...extra,
  });
  const a = await send({});
  assert.equal(a.status, 202, JSON.stringify(a.body));
  assert.equal(a.body.placed, 1);
  assert.equal(a.body.notLooking, 1);
  assert.equal(a.body.queued, 1);
  const b = await send({ includeNotLooking: true });
  assert.equal(b.body.placed, 1, 'a placed candidate was messaged');
  assert.equal(b.body.notLooking, 0);
  assert.equal(b.body.queued, 2);
});

test('the admin report', async () => {
  const r = await ADMIN.get('/api/admin/availability/report');
  assert.equal(r.status, 200);
  assert.ok(r.body.report.byStatus.not_looking >= 1);
  assert.ok(r.body.report.checks.sent >= 2);
  assert.ok(r.body.report.checks.answered >= 1);
  assert.equal((await REC.get('/api/admin/availability/report')).status, 403);
});

test('teardown', async () => {
  await new Promise((r) => server.close(r));
  const { closePool } = await import('../src/db.js');
  await closePool();
  await mock.stop();
  await dbh.stop();
});
