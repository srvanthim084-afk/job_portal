/**
 * Save & Post (0112) end to end against a real Postgres with RLS on.
 *
 * NO REAL PLATFORM IS CONTACTED. Naukri, Shine and Indeed are played by a
 * local mock partner server started here; the integrations are pointed at
 * it through Administration -> Integrations exactly as an administrator
 * would point them at the platform's authorized endpoint.
 *
 * Covered:
 *   - TeamLink Portal and Website reach Posted with their real public URL,
 *     the feeds list the job, the job page carries schema.org JobPosting
 *   - an unconfigured partner is "Integration Required" and is sent nothing
 *   - secrets: refused without INTEGRATION_SECRET_KEY, encrypted at rest,
 *     never in a response or a log line, only "saved" + 4 characters
 *   - Test Connection: bad credentials fail, good ones pass
 *   - configured later -> the waiting job goes out (publish-pending, sweep)
 *   - success with an id / URL -> Posted; 5xx -> Failed and retried with
 *     backoff; a timeout -> Failed; 2xx without id or URL -> not Posted
 *   - an edit pushes an update; closing takes it down everywhere
 *   - Indeed's feed: listed = awaiting confirmation, never Posted on our
 *     say-so; a signed callback confirms it; a bad signature is refused
 *   - never twice: two Save & Posts at once make one posting
 *   - a recruiter cannot open Integrations or publish another's job
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { startTestDb, applyTestEnv, makeClient } from './harness.mjs';

const DB_PORT = 5491;
const API_PORT = 9991;
const PARTNER_PORT = 9893;
const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '../../web');

const NAUKRI_KEY = 'nk_live_TEST_ONLY_8f3a91c2d4e5b6a7';
const SHINE_KEY = 'sh_TEST_ONLY_secret_77aa99bb';
const FEED_TOKEN = 'feedtok_TEST_ONLY_0123456789abcdef';
const CALLBACK_SECRET = 'cbsecret_TEST_ONLY_fedcba9876543210';
const SECRETS = [NAUKRI_KEY, SHINE_KEY, FEED_TOKEN, CALLBACK_SECRET];

let dbh, server, base, raw, recruiter, recruiter2, admin, partner, svc;
const logged = [];

/* ---------------- the mock partner platform ---------------- */
function startPartner() {
  const calls = [];
  const mode = { shine: 'ok', naukri: 'ok' };
  let seq = 0;
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      const [, platform, ...rest] = u.pathname.split('/');
      const path = '/' + rest.join('/');
      calls.push({ platform, method: req.method, path, headers: req.headers, body });
      const send = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };
      const key = platform === 'naukri' ? NAUKRI_KEY : SHINE_KEY;
      const authed = req.headers.authorization === `Bearer ${key}` || req.headers['x-api-key'] === key;
      if (!authed) return send(401, { error: { message: 'invalid api key' } });
      if (path === '/account' && req.method === 'GET') return send(200, { account: 'TL-EMP-1' });
      const m = mode[platform];
      if (req.method === 'POST' && path === '/jobs') {
        if (m === 'fail500') return send(500, { message: 'internal error, try later' });
        if (m === 'fail400') return send(400, { message: 'title too short' });
        if (m === 'timeout') return setTimeout(() => send(200, { id: 'late' }), 3000);
        if (m === 'noid') return send(200, { ok: true });
        seq += 1;
        return send(201, { jobId: `${platform.toUpperCase()}-${seq}`, jobUrl: `https://${platform}.partner.test/job/${seq}`, status: 'live' });
      }
      if (req.method === 'PUT' && path.startsWith('/jobs/')) return send(200, {});
      if (req.method === 'DELETE' && path.startsWith('/jobs/')) return send(204);
      if (req.method === 'GET' && path.startsWith('/jobs/')) return send(200, { status: 'live' });
      return send(404, { message: 'no such route' });
    });
  });
  return new Promise((r) => srv.listen(PARTNER_PORT, '127.0.0.1', () => r({
    calls, mode, stop: () => new Promise((s) => { srv.closeAllConnections?.(); srv.close(s); }),
  })));
}

const sawSecret = (x) => { const s = typeof x === 'string' ? x : JSON.stringify(x); return SECRETS.some((k) => s.includes(k)); };
const noSecret = (r, what) => assert.equal(sawSecret(r.body), false, `${what}: a secret came back in the response`);
const pubOf = (r, dest) => (r.body.publications || []).find((p) => p.destination === dest);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('boot', async () => {
  for (const k of ['log', 'warn', 'error', 'info']) {
    const orig = console[k].bind(console);
    console[k] = (...a) => { logged.push(a.map((x) => (x && x.stack) || (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); orig(...a); };
  }
  dbh = await startTestDb(DB_PORT);
  partner = await startPartner();
  applyTestEnv(dbh.url, {
    PUBLIC_ORIGIN: `http://127.0.0.1:${API_PORT}`,
    PUBLIC_SHARE_URL: '',
    DISABLE_BACKGROUND_WORK: 'true',
    INTEGRATION_SECRET_KEY: 'test-only-integration-secret-key-000000000',
    PUBLISH_BACKOFF_BASE_MS: '300',
    PUBLISH_HTTP_TIMEOUT_MS: '1000',
    PUBLISH_WAIT_MS: '8000',
    PUBLISH_STATUS_CHECK_MS: '600000',
    SMS_API_KEY: '', WHATSAPP_API_KEY: '', EMAIL_API_KEY: '',
    EMAIL_SMTP_HOST: '', EMAILJS_SERVICE_ID: '', EMAILJS_TEMPLATE_ID: '', EMAILJS_PUBLIC_KEY: '', EMAILJS_PRIVATE_KEY: '',
  });
  raw = (sql, params) => dbh.db.query(sql, params);
  const { hashPassword } = await import('../src/auth.js');
  const hash = await hashPassword('Staff123pass');
  await raw(`insert into companies (id, name) values ('co_pub', 'Publish Works Pvt Ltd'), ('co_pub2', 'Other Desk Ltd')`);
  const mk = async (email, role, table, id, co) => {
    const u = (await raw(`insert into users (email,password_hash,role) values ($1,$2,$3) returning id`, [email, hash, role])).rows[0].id;
    if (table === 'recruiters') await raw(`insert into recruiters (id, name, email, company_id, user_id) values ($1,'Rec',$2,$3,$4)`, [id, email, co, u]);
    else await raw(`insert into admins (id, name, email, user_id) values ($1,'Admin',$2,$3)`, [id, email, u]);
  };
  await mk('rpub@tl-sink.local', 'recruiter', 'recruiters', 'rpub1', 'co_pub');
  await mk('rpub2@tl-sink.local', 'recruiter', 'recruiters', 'rpub2', 'co_pub2');
  await mk('apub@tl-sink.local', 'admin', 'admins', 'apub1');

  const { createApp } = await import('../src/app.js');
  svc = await import('../src/publishing/service.js');
  const app = createApp({ serveStatic: WEB, logger: { error() {}, log() {} } });
  await new Promise((r) => { server = app.listen(API_PORT, '127.0.0.1', r); });
  base = `http://127.0.0.1:${API_PORT}`;
  const login = async (email, role) => {
    const c = makeClient(base);
    await c.get('/api/health');
    const r = await c.post('/api/auth/login', { email, password: 'Staff123pass', role });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return c;
  };
  recruiter = await login('rpub@tl-sink.local', 'recruiter');
  recruiter2 = await login('rpub2@tl-sink.local', 'recruiter');
  admin = await login('apub@tl-sink.local', 'admin');
});

const JOB = (over = {}) => ({
  title: 'Customer Support Executive', companyId: 'co_pub', location: 'Hyderabad, Telangana', mode: 'Onsite',
  exp: '0-2 yrs', pay: '₹2.5–3.5 LPA', salaryMin: 2.5, salaryMax: 3.5, type: 'Full-time', status: 'open',
  skills: ['Communication', 'English'], gender: 'Female', ...over,
});
async function newJob(over) {
  const r = await recruiter.post('/api/jobs', JOB(over));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  await recruiter.put(`/api/jobs/${r.body.job.id}/screening-questions`, { questions: [] });
  return r.body.job.id;
}
const ALL = ['TEAMLINK_PORTAL', 'TEAMLINK_WEBSITE', 'NAUKRI', 'SHINE', 'INDEED'];
let J1;

test('destinations: TeamLink works now; Naukri, Shine and Indeed need an integration', async () => {
  const r = await recruiter.get('/api/publishing/destinations');
  assert.equal(r.status, 200);
  const by = Object.fromEntries(r.body.destinations.map((d) => [d.key, d]));
  assert.deepEqual(Object.keys(by), ALL);
  assert.equal(by.TEAMLINK_PORTAL.ready, true);
  assert.equal(by.TEAMLINK_WEBSITE.ready, true);
  assert.equal(by.TEAMLINK_PORTAL.defaultSelected && by.TEAMLINK_WEBSITE.defaultSelected, true);
  for (const k of ['NAUKRI', 'SHINE', 'INDEED']) {
    assert.equal(by[k].ready, false);
    assert.equal(by[k].stateLabel, 'Integration Required');
    assert.equal(by[k].defaultSelected, false);
  }
});

test('Save & Post: Portal and Website reach Posted with real URLs; partners are Integration Required and sent nothing', async () => {
  J1 = await newJob();
  const before = partner.calls.length;
  const r = await recruiter.put(`/api/jobs/${J1}/publications`, { destinations: ALL });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const portal = pubOf(r, 'TEAMLINK_PORTAL');
  assert.equal(portal.status, 'posted', JSON.stringify(portal));
  assert.equal(portal.externalUrl, `${base}/job/${J1}`);
  const site = pubOf(r, 'TEAMLINK_WEBSITE');
  assert.equal(site.status, 'posted', JSON.stringify(site));
  assert.equal(site.externalUrl, `${base}/feeds/jobs/${J1}.json`);
  for (const k of ['NAUKRI', 'SHINE', 'INDEED']) {
    const p = pubOf(r, k);
    assert.equal(p.status, 'integration_required', `${k}: ${JSON.stringify(p)}`);
    assert.equal(p.statusLabel, 'Integration Required');
    assert.equal(p.externalUrl, null);
  }
  assert.equal(partner.calls.length, before, 'no request was sent to any partner');

  /* the URLs really answer, anonymously */
  const page = await fetch(portal.externalUrl).then(async (x) => ({ s: x.status, t: await x.text() }));
  assert.equal(page.s, 200);
  assert.ok(page.t.includes(`<meta name="teamlink:job" content="${J1}">`));
  assert.ok(page.t.includes('"@type":"JobPosting"'), 'schema.org JobPosting on the job page');
  const entry = await fetch(site.externalUrl).then((x) => x.json());
  assert.equal(entry.id, J1);
  assert.equal(entry.jsonLd['@type'], 'JobPosting');
  assert.equal(entry.jsonLd.hiringOrganization.name, 'Publish Works Pvt Ltd');
});

test('the website feed: JSON + RSS, cacheable, embeddable, only open jobs ticked for the website', async () => {
  const notTicked = await newJob({ title: 'Back Office Associate' });
  await recruiter.put(`/api/jobs/${notTicked}/publications`, { destinations: ['TEAMLINK_PORTAL'] });
  const res = await fetch(`${base}/feeds/jobs.json`, { headers: { origin: 'https://www.teamlink-website.test' } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.match(res.headers.get('cache-control'), /public, max-age=300/);
  const feed = await res.json();
  const ids = feed.jobs.map((j) => j.id);
  assert.ok(ids.includes(J1));
  assert.equal(ids.includes(notTicked), false, 'a job not ticked for the website is not in its feed');
  const j = feed.jobs.find((x) => x.id === J1);
  assert.equal(j.url, `${base}/job/${J1}`);
  assert.equal(j.city, 'Hyderabad');
  assert.equal(JSON.stringify(feed).includes('rpub1'), false, 'no recruiter in the public feed');
  const rss = await fetch(`${base}/feeds/jobs.xml`).then((x) => x.text());
  assert.ok(rss.startsWith('<?xml'));
  assert.ok(rss.includes(`teamlink-job-${J1}`));
  const gone = await fetch(`${base}/feeds/jobs/${notTicked}.json`);
  assert.equal(gone.status, 404);
});

test('who may do what: a recruiter cannot open Integrations or publish somebody else\'s job', async () => {
  assert.equal((await recruiter.get('/api/admin/integrations')).status, 403);
  assert.equal((await recruiter.put('/api/admin/integrations/NAUKRI', { enabled: false })).status, 403);
  assert.equal((await recruiter.post('/api/admin/integrations/NAUKRI/test', {})).status, 403);
  assert.equal((await makeClient(base).get('/api/admin/integrations')).status, 401);
  assert.equal((await recruiter2.put(`/api/jobs/${J1}/publications`, { destinations: ALL })).status, 403);
  assert.equal((await recruiter2.get(`/api/jobs/${J1}/publications`)).status, 403);
  const other = await recruiter2.get(`/api/job-publications?jobIds=${J1}`);
  assert.deepEqual(other.body.publications, {}, 'RLS: another recruiter reads none of these rows');
  const mine = await recruiter.get(`/api/job-publications?jobIds=${J1}`);
  assert.equal(mine.body.publications[J1].length, 5);
});

test('secrets: refused without INTEGRATION_SECRET_KEY, encrypted at rest, never sent back', async () => {
  const keep = process.env.INTEGRATION_SECRET_KEY;
  delete process.env.INTEGRATION_SECRET_KEY;
  try {
    const r = await admin.put('/api/admin/integrations/NAUKRI', { enabled: true, connectionType: 'api', endpointUrl: `http://127.0.0.1:${PARTNER_PORT}/naukri`,
      authType: 'bearer', secrets: { apiKey: NAUKRI_KEY } });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'INTEGRATION_SECRET_KEY_MISSING');
    assert.match(r.body.error.message, /INTEGRATION_SECRET_KEY is not set/);
    noSecret(r, 'refusal');
    const list = await admin.get('/api/admin/integrations');
    assert.equal(list.body.secretKeyConfigured, false);
  } finally { process.env.INTEGRATION_SECRET_KEY = keep; }
  const n = (await raw(`select count(*)::int n from publishing_integrations where destination='NAUKRI'`)).rows[0].n;
  assert.equal(n, 0, 'nothing was saved');

  /* an endpoint that is not https (and not this machine) is refused */
  const bad = await admin.put('/api/admin/integrations/NAUKRI', { enabled: true, connectionType: 'api', endpointUrl: 'http://naukri.example.com/api', authType: 'bearer' });
  assert.equal(bad.status, 400);
});

test('Test Connection: wrong credentials fail honestly; right ones pass; the key never comes back', async () => {
  let r = await admin.put('/api/admin/integrations/NAUKRI', { enabled: true, connectionType: 'api', endpointUrl: `http://127.0.0.1:${PARTNER_PORT}/naukri`,
    authType: 'bearer', accountId: 'TL-EMP-1', secrets: { apiKey: 'wrong-key-wrong-key-123' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  noSecret(r, 'save');
  /* saved but failing: the waiting job is tried and fails - it is not Posted */
  let t = await admin.post('/api/admin/integrations/NAUKRI/test', {});
  assert.equal(t.status, 200);
  assert.equal(t.body.ok, false);
  assert.match(t.body.message, /rejected the credentials/);
  assert.equal(t.body.message.includes('wrong-key-wrong-key-123'), false);

  r = await admin.put('/api/admin/integrations/NAUKRI', { enabled: true, connectionType: 'api', endpointUrl: `http://127.0.0.1:${PARTNER_PORT}/naukri`,
    authType: 'bearer', accountId: 'TL-EMP-1', secrets: { apiKey: NAUKRI_KEY } });
  assert.equal(r.status, 200);
  noSecret(r, 'save');
  assert.deepEqual(r.body.integration.secrets.apiKey, { saved: true, hint: NAUKRI_KEY.slice(-4) });
  t = await admin.post('/api/admin/integrations/NAUKRI/test', {});
  assert.equal(t.body.ok, true, t.body.message);
  noSecret(t, 'test');
  const stored = (await raw(`select secrets_enc, secret_hints from publishing_integrations where destination='NAUKRI'`)).rows[0];
  assert.equal(stored.secrets_enc.includes(NAUKRI_KEY), false, 'encrypted at rest');
  assert.match(stored.secrets_enc, /"v":1/);
  const ev = await admin.get('/api/admin/integrations/NAUKRI/events');
  assert.ok(ev.body.events.some((e) => e.event === 'secret_saved' && e.detail === 'Saved: apiKey'));
  assert.ok(ev.body.events.some((e) => e.event === 'test_failed'));
  noSecret(ev, 'events');
});

test('connected later: the job ticked for Naukri goes out (publish pending) and is Posted only with the platform\'s id and URL', async () => {
  await svc.settle();
  const sent = partner.calls.length;
  const r = await admin.post('/api/admin/integrations/NAUKRI/publish-pending', {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  noSecret(r, 'publish-pending');
  const pubs = await recruiter.get(`/api/jobs/${J1}/publications`);
  const nk = pubOf(pubs, 'NAUKRI');
  assert.equal(nk.status, 'posted', JSON.stringify(nk));
  assert.match(nk.externalJobId, /^NAUKRI-\d+$/);
  assert.match(nk.externalUrl, /^https:\/\/naukri\.partner\.test\/job\/\d+$/);
  /* Saving the working credentials already sent it (the sweep that runs
     when an integration is switched on); publish-pending sent nothing more. */
  assert.equal(partner.calls.slice(sent).filter((c) => c.platform === 'naukri' && c.method === 'POST').length, 0, 'not posted a second time');
  /* (the attempt made with the wrong key was refused by the platform) */
  const tried = partner.calls.filter((c) => c.platform === 'naukri' && c.method === 'POST' && c.body.includes(J1));
  assert.ok(tried.every((c) => c.headers['idempotency-key'] === `teamlink-${J1}-NAUKRI`), 'every attempt carries the same idempotency key');
  const posts = tried.filter((c) => c.headers.authorization === `Bearer ${NAUKRI_KEY}`);
  assert.equal(posts.length, 1, 'accepted once');
  assert.equal(posts[0].headers['idempotency-key'], `teamlink-${J1}-NAUKRI`);
  assert.equal(posts[0].headers['x-account-id'], 'TL-EMP-1');
  const body = JSON.parse(posts[0].body);
  assert.equal(body.referenceCode, J1);
  assert.equal(body.title, 'Customer Support Executive');
  assert.deepEqual(body.keySkills, ['Communication', 'English']);
  noSecret(pubs, 'publications');
  /* Shine and Indeed are still not configured: still nothing sent to them */
  assert.equal(pubOf(pubs, 'SHINE').status, 'integration_required');
  assert.equal(partner.calls.filter((c) => c.platform === 'shine').length, 0);
});

test('an edit to a posted job pushes an update once, and never a second posting', async () => {
  const sent = partner.calls.length;
  const r = await recruiter.put(`/api/jobs/${J1}`, JOB({ title: 'Senior Customer Support Executive' }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await sleep(400);
  await svc.reconcileJob(J1);
  const after = partner.calls.slice(sent).filter((c) => c.platform === 'naukri');
  assert.equal(after.filter((c) => c.method === 'PUT').length, 1, JSON.stringify(after.map((c) => c.method + ' ' + c.path)));
  assert.equal(after.filter((c) => c.method === 'POST').length, 0);
  assert.match(after.find((c) => c.method === 'PUT').path, /^\/jobs\/NAUKRI-\d+$/);
  assert.equal(JSON.parse(after.find((c) => c.method === 'PUT').body).title, 'Senior Customer Support Executive');
  /* nothing changed since: nothing more is sent */
  await svc.reconcileJob(J1);
  assert.equal(partner.calls.slice(sent).length, after.length);
});

test('a 5xx is Failed with the error recorded, retried with backoff, then Posted', async () => {
  partner.mode.shine = 'fail500';
  const r = await admin.put('/api/admin/integrations/SHINE', { enabled: true, connectionType: 'api', endpointUrl: `http://127.0.0.1:${PARTNER_PORT}/shine`,
    authType: 'api_key_header', options: { apiKeyHeader: 'X-Api-Key' }, secrets: { apiKey: SHINE_KEY } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await admin.post('/api/admin/integrations/SHINE/publish-pending', {});
  let p = pubOf(await recruiter.get(`/api/jobs/${J1}/publications`), 'SHINE');
  assert.equal(p.status, 'failed', JSON.stringify(p));
  assert.match(p.lastError, /HTTP 500: internal error, try later/);
  assert.equal(p.attempts, 1);
  assert.ok(p.nextAttemptAt, 'a retry is scheduled');
  /* not due yet: the sweep leaves it alone */
  const calls = partner.calls.filter((c) => c.platform === 'shine' && c.method === 'POST').length;
  await svc.sweepOnce();
  assert.equal(partner.calls.filter((c) => c.platform === 'shine' && c.method === 'POST').length, calls, 'backoff respected');
  await sleep(450);
  await svc.sweepOnce();
  p = pubOf(await recruiter.get(`/api/jobs/${J1}/publications`), 'SHINE');
  assert.equal(p.status, 'failed');
  assert.equal(p.attempts, 2, 'retried after the backoff');
  partner.mode.shine = 'ok';
  await sleep(800);
  await svc.sweepOnce();
  p = pubOf(await recruiter.get(`/api/jobs/${J1}/publications`), 'SHINE');
  assert.equal(p.status, 'posted', JSON.stringify(p));
  assert.match(p.externalJobId, /^SHINE-/);
  assert.equal(p.lastError, null);
  const shinePosts = partner.calls.filter((c) => c.platform === 'shine' && c.method === 'POST');
  assert.equal(shinePosts.at(-1).headers['x-api-key'], SHINE_KEY);
  const ev = await recruiter.get(`/api/jobs/${J1}/publications/events`);
  assert.ok(ev.body.events.filter((e) => e.destination === 'SHINE' && e.event === 'failed').length >= 2);
  noSecret(ev, 'job events');
});

test('a timeout, and a 2xx with no id or URL, are Failed - never Posted', async () => {
  const J2 = await newJob({ title: 'Field Sales Officer' });
  partner.mode.shine = 'timeout';
  partner.mode.naukri = 'noid';
  const r = await recruiter.put(`/api/jobs/${J2}/publications`, { destinations: ['TEAMLINK_PORTAL', 'NAUKRI', 'SHINE'] });
  assert.equal(r.status, 200);
  const sh = pubOf(r, 'SHINE');
  assert.equal(sh.status, 'failed', JSON.stringify(sh));
  assert.match(sh.lastError, /timed out/);
  const nk = pubOf(r, 'NAUKRI');
  assert.equal(nk.status, 'failed', JSON.stringify(nk));
  assert.match(nk.lastError, /no job id or URL - not marked Posted/);
  assert.equal(nk.externalUrl, null);
  /* Publish now, once the platform behaves */
  partner.mode.shine = 'ok';
  partner.mode.naukri = 'ok';
  await sleep(1500);
  const now = await recruiter.post(`/api/jobs/${J2}/publications/publish-now`, {});
  assert.equal(pubOf(now, 'NAUKRI').status, 'posted');
  assert.equal(pubOf(now, 'SHINE').status, 'posted');
  /* a 4xx is Failed too, with the platform's own words */
  partner.mode.naukri = 'fail400';
  const J3 = await newJob({ title: 'Data Entry Operator' });
  const r3 = await recruiter.put(`/api/jobs/${J3}/publications`, { destinations: ['NAUKRI'] });
  assert.equal(pubOf(r3, 'NAUKRI').status, 'failed');
  assert.match(pubOf(r3, 'NAUKRI').lastError, /HTTP 400: title too short/);
  partner.mode.naukri = 'ok';
});

test('Indeed XML feed: listed = awaiting confirmation (never Posted on our say-so); a signed callback confirms it', async () => {
  const r = await admin.put('/api/admin/integrations/INDEED', { enabled: true, connectionType: 'xml_feed', accountId: 'pub-123',
    secrets: { feedToken: FEED_TOKEN, callbackSecret: CALLBACK_SECRET } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  noSecret(r, 'indeed save');
  assert.ok(r.body.integration.feedUrl.endsWith('/feeds/indeed.xml?token=••••' + FEED_TOKEN.slice(-4)));
  const t = await admin.post('/api/admin/integrations/INDEED/test', {});
  assert.equal(t.body.ok, true);
  noSecret(t, 'indeed test');
  await admin.post('/api/admin/integrations/INDEED/publish-pending', {});
  let p = pubOf(await recruiter.get(`/api/jobs/${J1}/publications`), 'INDEED');
  assert.equal(p.status, 'awaiting_confirmation', JSON.stringify(p));
  assert.equal(p.statusLabel, 'Listed in feed — awaiting Indeed confirmation');
  assert.equal(p.externalUrl, null);
  /* the signed feed */
  assert.equal((await fetch(`${base}/feeds/indeed.xml`)).status, 404);
  assert.equal((await fetch(`${base}/feeds/indeed.xml?token=wrong`)).status, 404);
  const xml = await fetch(`${base}/feeds/indeed.xml?token=${FEED_TOKEN}`).then((x) => x.text());
  assert.ok(xml.includes(`<referencenumber><![CDATA[${J1}]]></referencenumber>`));
  assert.ok(xml.includes(`<url><![CDATA[${base}/job/${J1}]]></url>`));
  /* the status sweep alone does not make it Posted */
  await svc.makeDue(J1, 'INDEED');
  await svc.reconcileJob(J1);
  assert.equal(pubOf(await recruiter.get(`/api/jobs/${J1}/publications`), 'INDEED').status, 'awaiting_confirmation');
  /* confirmation */
  const body = JSON.stringify({ reference: J1, externalJobId: 'ind-9f8e7d', url: 'https://www.indeed.test/viewjob?jk=9f8e7d', status: 'live' });
  const bad = await fetch(`${base}/hooks/publishing/indeed`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-teamlink-signature': 'sha256=00' }, body });
  assert.equal(bad.status, 401);
  assert.equal(pubOf(await recruiter.get(`/api/jobs/${J1}/publications`), 'INDEED').status, 'awaiting_confirmation');
  const sig = createHmac('sha256', CALLBACK_SECRET).update(body).digest('hex');
  const ok = await fetch(`${base}/hooks/publishing/indeed`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-teamlink-signature': `sha256=${sig}` }, body });
  assert.equal(ok.status, 200, await ok.text());
  p = pubOf(await recruiter.get(`/api/jobs/${J1}/publications`), 'INDEED');
  assert.equal(p.status, 'posted');
  assert.equal(p.externalJobId, 'ind-9f8e7d');
  assert.equal(p.externalUrl, 'https://www.indeed.test/viewjob?jk=9f8e7d');
});

test('never twice: two Save & Posts at the same moment make one posting per platform', async () => {
  const J4 = await newJob({ title: 'Telecaller' });
  const before = partner.calls.filter((c) => c.method === 'POST').length;
  const [a, b] = await Promise.all([
    recruiter.put(`/api/jobs/${J4}/publications`, { destinations: ALL }),
    recruiter.put(`/api/jobs/${J4}/publications`, { destinations: ALL }),
  ]);
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  await svc.reconcileJob(J4);
  await svc.sweepOnce();
  const posts = partner.calls.filter((c) => c.method === 'POST').slice(before).filter((c) => c.body.includes(J4));
  assert.equal(posts.filter((c) => c.platform === 'naukri').length, 1);
  assert.equal(posts.filter((c) => c.platform === 'shine').length, 1);
  const rows = (await raw(`select destination, count(*)::int n from job_publications where job_id=$1 group by 1`, [J4])).rows;
  assert.ok(rows.every((x) => x.n === 1));
});

test('closing a posted job takes it down everywhere; unticking a destination takes it off that one', async () => {
  const sent = partner.calls.length;
  const r = await recruiter.post(`/api/jobs/${J1}/publish`, { publish: false });
  assert.equal(r.status, 200);
  await sleep(400);
  await svc.reconcileJob(J1);
  const pubs = await recruiter.get(`/api/jobs/${J1}/publications`);
  for (const k of ALL) assert.equal(pubOf(pubs, k).status, 'removed', `${k}: ${JSON.stringify(pubOf(pubs, k))}`);
  const dels = partner.calls.slice(sent).filter((c) => c.method === 'DELETE');
  assert.deepEqual(dels.map((c) => c.platform).sort(), ['naukri', 'shine']);
  assert.equal((await fetch(`${base}/feeds/jobs/${J1}.json`)).status, 404);
  const xml = await fetch(`${base}/feeds/indeed.xml?token=${FEED_TOKEN}`).then((x) => x.text());
  assert.equal(xml.includes(J1), false, 'dropped from the Indeed feed');

  /* reopened: it goes back up */
  await recruiter.post(`/api/jobs/${J1}/publish`, { publish: true });
  await sleep(400);
  await svc.reconcileJob(J1);
  const again = await recruiter.get(`/api/jobs/${J1}/publications`);
  assert.equal(pubOf(again, 'NAUKRI').status, 'posted', JSON.stringify(pubOf(again, 'NAUKRI')));
  assert.equal(pubOf(again, 'TEAMLINK_PORTAL').status, 'posted', JSON.stringify(pubOf(again, 'TEAMLINK_PORTAL')));
  /* unticked: only that one comes down */
  const un = await recruiter.put(`/api/jobs/${J1}/publications`, { destinations: ['TEAMLINK_PORTAL', 'TEAMLINK_WEBSITE', 'SHINE', 'INDEED'] });
  assert.equal(pubOf(un, 'NAUKRI').status, 'removed');
  assert.equal(pubOf(un, 'NAUKRI').desired, 'removed');
  assert.equal(pubOf(un, 'SHINE').status, 'posted', JSON.stringify(pubOf(un, 'SHINE')));
});

test('switched off again: a newly ticked job waits as Integration Required and nothing is sent', async () => {
  await admin.put('/api/admin/integrations/SHINE', { enabled: false, connectionType: 'api', endpointUrl: `http://127.0.0.1:${PARTNER_PORT}/shine`,
    authType: 'api_key_header', options: { apiKeyHeader: 'X-Api-Key' } });
  const J5 = await newJob({ title: 'Warehouse Supervisor' });
  const before = partner.calls.filter((c) => c.platform === 'shine').length;
  const r = await recruiter.put(`/api/jobs/${J5}/publications`, { destinations: ['TEAMLINK_PORTAL', 'SHINE'] });
  assert.equal(pubOf(r, 'SHINE').status, 'integration_required');
  assert.match(pubOf(r, 'SHINE').lastError, /Switched off/);
  assert.equal(partner.calls.filter((c) => c.platform === 'shine').length, before);
  const view = await admin.get('/api/admin/integrations');
  noSecret(view, 'admin list');
  const sh = view.body.integrations.find((i) => i.destination === 'SHINE');
  assert.equal(sh.secrets.apiKey.saved, true, 'the key is kept while switched off');
});

test('no secret was ever written to a log line', async () => {
  assert.equal(logged.some((l) => sawSecret(l)), false, logged.filter((l) => sawSecret(l)).join('\n').slice(0, 300));
});

test('shutdown', async () => {
  await sleep(300);
  await new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
  await partner.stop();
  const { closePool } = await import('../src/db.js');
  await closePool();
  await dbh.stop();
});
