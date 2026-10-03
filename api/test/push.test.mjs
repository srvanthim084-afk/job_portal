/**
 * Phone notifications end to end, against a local stand-in for the push
 * services (Google / Apple) and for the SMS gateway. Nothing real is
 * called: PUSH_EXTRA_HOSTS points the sender at 127.0.0.1, and the mock
 * DECRYPTS what it receives with the browser keys this test holds - so a
 * pass means the bytes really were a valid RFC 8291 message.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createECDH, createHmac, createDecipheriv, randomBytes } from 'node:crypto';
import { startTestDb, applyTestEnv, makeClient } from './harness.mjs';

const DB_PORT = 5439;
const API_PORT = 9993;
const MOCK = 9871;
const BASE = `http://127.0.0.1:${API_PORT}`;
const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
};

let dbh, server, mock, raw, alerts, A, B;
const received = [];
const keys = new Map();          // endpoint -> { ecdh, auth }

function decrypt(endpoint, body) {
  const k = keys.get(endpoint);
  const ex = (s, i) => createHmac('sha256', s).update(i).digest();
  const xp = (p, i, l) => createHmac('sha256', p).update(Buffer.concat([i, Buffer.from([1])])).digest().subarray(0, l);
  const salt = body.subarray(0, 16); const idlen = body[20]; const asPub = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  const ikm = xp(ex(k.auth, k.ecdh.computeSecret(asPub)),
    Buffer.concat([Buffer.from('WebPush: info\0'), k.ecdh.getPublicKey(), asPub]), 32);
  const prk = ex(salt, ikm);
  const d = createDecipheriv('aes-128-gcm', xp(prk, Buffer.from('Content-Encoding: aes128gcm\0'), 16),
    xp(prk, Buffer.from('Content-Encoding: nonce\0'), 12));
  d.setAuthTag(ct.subarray(ct.length - 16));
  const pt = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  return JSON.parse(pt.subarray(0, pt.length - 1).toString());
}

/** A browser subscription whose push "service" is the mock, answering `code`. */
function browserSub(path) {
  const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
  const auth = randomBytes(16);
  const endpoint = `http://127.0.0.1:${MOCK}/${path}/${randomBytes(4).toString('hex')}`;
  keys.set(endpoint, { ecdh, auth });
  return { endpoint, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };
}

const day = (h) => { const d = new Date(); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, 0, 0); };
const DAYTIME = day(6);
let jobN = 0;
async function job(title) {
  jobN += 1;
  await raw(`insert into jobs (id, title, company_id, location, status, published_at) values ($1,$2,'co_p','Hyderabad','open',now())`,
    [`pj${jobN}`, title]);
  return `pj${jobN}`;
}
const deliveries = async (sid) => (await raw(
  `select channel, status, error from candidate_saved_search_deliveries where saved_search_id=$1 order by id`, [sid])).rows;
const subscriptions = async (cand) => (await raw(`select * from push_subscriptions where candidate_id=$1`, [cand])).rows;

async function candidate(name, email, phone) {
  const c = makeClient(BASE); await c.get('/api/health');
  const r = await c.post('/api/auth/register', { name, email, password: 'Push123alerts', phone,
    preferredLocation: 'Hyderabad', expectedCtc: 4, noticePeriod: 'Immediate', preferredWorkModes: ['Hybrid'] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  c.id = r.body.candidateId;
  return c;
}
async function subscribe(c, sub, ua, extra = {}) {
  return c.post('/api/push/subscribe', { ...sub, ...extra }, { headers: { 'user-agent': ua } });
}

test('boot', async () => {
  mock = createServer((req, res) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const endpoint = `http://127.0.0.1:${MOCK}${req.url}`;
      received.push({ url: req.url, endpoint, headers: req.headers, body });
      const code = req.url.startsWith('/gone') ? 410 : req.url.startsWith('/fail') ? 500
        : req.url.startsWith('/sms') ? 200 : 201;
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(code < 300 ? JSON.stringify({ id: 'mock' }) : 'nope');
    });
  });
  await new Promise((r) => mock.listen(MOCK, '127.0.0.1', r));

  dbh = await startTestDb(DB_PORT);
  const { generateVapidKeys } = await import('../src/notify/webpush.js');
  const v = generateVapidKeys();
  applyTestEnv(dbh.url, {
    PUBLIC_ORIGIN: BASE, DISABLE_BACKGROUND_WORK: 'true',
    VAPID_PUBLIC_KEY: v.publicKey, VAPID_PRIVATE_KEY: v.privateKey, VAPID_SUBJECT: 'mailto:alerts@teamlink.example',
    PUSH_EXTRA_HOSTS: `127.0.0.1:${MOCK}`,
    SMS_API_KEY: 'test-key', SMS_API_URL: `http://127.0.0.1:${MOCK}/sms`,
    EMAIL_SMTP_HOST: '', EMAIL_API_KEY: '', EMAILJS_SERVICE_ID: '', OUTBOUND_ALLOWLIST: '',
  });
  raw = (sql, p) => dbh.db.query(sql, p);
  await raw(`insert into companies (id, name) values ('co_p', 'Push Co')`);
  const { createApp } = await import('../src/app.js');
  alerts = await import('../src/notify/saved-search-alerts.js');
  const app = createApp({ logger: { error() {}, log() {} } });
  await new Promise((r) => { server = app.listen(API_PORT, r); });
  A = await candidate('Push Asha', 'push.asha@tl-sink.local', '9300000001');
  B = await candidate('Push Bala', 'push.bala@tl-sink.local', '9300000002');
});

test('the platform is stored from the user agent', async () => {
  for (const [ua, want, extra] of [[UA.iphone, 'ios'], [UA.android, 'android'], [UA.windows, 'desktop'],
    [UA.mac, 'ios', { platformHint: 'ios' }], [UA.mac, 'desktop']]) {
    const r = await subscribe(A, browserSub('ok'), ua, extra || {});
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.subscription.platform, want, ua.slice(13, 40));
  }
  const list = await A.get('/api/push/subscriptions');
  assert.equal(list.body.subscriptions.length, 5);
  assert.ok(list.body.subscriptions.some((s) => s.device === 'iPhone'));
  for (const s of list.body.subscriptions) await A.del(`/api/push/subscriptions/${s.id}`);
  assert.equal((await subscriptions(A.id)).length, 0);
});

test('only real push services: any other endpoint is refused', async () => {
  const sub = browserSub('ok');
  sub.endpoint = 'https://attacker.example.com/collect';
  assert.equal((await subscribe(A, sub, UA.android)).status, 400);
});

test('a test notification arrives encrypted, with a title and a body', async () => {
  const sub = browserSub('ok');
  await subscribe(A, sub, UA.android);
  const before = received.length;
  const r = await A.post('/api/push/test', {});
  assert.equal(r.body.sent, 1);
  const msg = received.slice(before).find((x) => x.endpoint === sub.endpoint);
  assert.equal(msg.headers['content-encoding'], 'aes128gcm');
  assert.match(msg.headers.authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
  const note = decrypt(sub.endpoint, msg.body);
  assert.ok(note.title && note.body, 'title and body are always there');
  await A.del(`/api/push/subscriptions/${(await subscriptions(A.id))[0].id}`);
});

test('Apple says 410: the subscription is deleted', async () => {
  await subscribe(A, browserSub('gone'), UA.iphone);
  assert.equal((await subscriptions(A.id))[0].platform, 'ios');
  await A.post('/api/push/test', {});
  assert.equal((await subscriptions(A.id)).length, 0);
});

test('other failures count; the fifth in a row removes the device', async () => {
  await subscribe(A, browserSub('fail'), UA.iphone);
  for (let i = 1; i <= 4; i += 1) {
    await A.post('/api/push/test', {});
    assert.equal((await subscriptions(A.id))[0].failed_count, i);
  }
  await A.post('/api/push/test', {});
  assert.equal((await subscriptions(A.id)).length, 0);
});

test('a saved-search alert reaches the device', async () => {
  const sub = browserSub('ok');
  await subscribe(A, sub, UA.iphone);
  const s = (await A.post('/api/saved-searches', { filters: { q: 'Welder' }, alert_frequency: 'instant', channels: ['push'] })).body.savedSearch;
  const before = received.length;
  await alerts.runSavedSearchInstant(await job('Welder'), { now: DAYTIME });
  const d = await deliveries(s.id);
  assert.deepEqual(d.map((x) => `${x.channel}:${x.status}`), ['push:sent']);
  const note = decrypt(sub.endpoint, received.slice(before).find((x) => x.endpoint === sub.endpoint).body);
  assert.equal(note.title, 'New job: Welder');
  assert.match(note.url, /#\/job\/pj/);
});

test('no device yet (an iPhone still in Safari): the alert goes by SMS instead', async () => {
  const s = (await B.post('/api/saved-searches', { filters: { q: 'Plumber' }, alert_frequency: 'instant', channels: ['push'] })).body.savedSearch;
  const before = received.filter((x) => x.url.startsWith('/sms')).length;
  await alerts.runSavedSearchInstant(await job('Plumber'), { now: DAYTIME });
  const d = await deliveries(s.id);
  assert.deepEqual(d.map((x) => `${x.channel}:${x.status}`), ['push:skipped_no_device', 'sms:sent']);
  assert.match(d[1].error, /instead of a phone notification/);
  assert.equal(received.filter((x) => x.url.startsWith('/sms')).length, before + 1);
});

test('never the same job twice: SMS already chosen means no extra fallback', async () => {
  const s = (await B.post('/api/saved-searches', { filters: { q: 'Mason' }, alert_frequency: 'instant', channels: ['push', 'sms'] })).body.savedSearch;
  const before = received.filter((x) => x.url.startsWith('/sms')).length;
  await alerts.runSavedSearchInstant(await job('Mason'), { now: DAYTIME });
  const d = await deliveries(s.id);
  assert.deepEqual(d.map((x) => `${x.channel}:${x.status}`), ['push:skipped_no_device', 'sms:sent']);
  assert.equal(received.filter((x) => x.url.startsWith('/sms')).length, before + 1, 'one SMS, not two');
});

test('an invalid VAPID subject is a clear configuration error', async () => {
  const keep = process.env.VAPID_SUBJECT;
  process.env.VAPID_SUBJECT = 'alerts@teamlink.example';            // missing mailto:
  const cfg = await fetch(`${BASE}/api/push/config`).then((r) => r.json());
  assert.equal(cfg.configured, false);
  assert.match(cfg.error, /VAPID_SUBJECT must be a mailto: or https: URL/);
  const r = await A.post('/api/push/test', {});
  assert.ok(r.body.results.every((x) => x.status === 'not_configured' && /VAPID_SUBJECT/.test(x.error)));
  process.env.VAPID_SUBJECT = keep;
  assert.equal((await fetch(`${BASE}/api/push/config`).then((x) => x.json())).configured, true);
});

test('teardown', async () => {
  await new Promise((r) => server.close(r));
  const { closePool } = await import('../src/db.js');
  await closePool();
  await new Promise((r) => mock.close(r));
  await dbh.stop();
});
