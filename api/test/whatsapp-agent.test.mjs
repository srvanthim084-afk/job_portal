/**
 * The AI WhatsApp Agent, end to end against a real Postgres with RLS on.
 *
 * Meta's Graph API is NEVER called: WHATSAPP_API_URL points at a local server
 * that records every message the agent sends, so the assertions read exactly
 * what a candidate's phone would receive.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { startTestDb, applyTestEnv, makeClient } from './harness.mjs';

const DB_PORT = 5517;
const API_PORT = 9917;
const WA_PORT = 9918;
const SECRET = 'wa-app-secret-for-tests-only-0000000000';
const VERIFY = 'wa-verify-token-for-tests';

let dbh; let server; let base; let raw; let wa;

function startMockGraph(port) {
  const sent = [];
  const srv = createServer((req, res) => {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => {
      try { sent.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(b || '{}') }); } catch { sent.push({ url: req.url, body: b }); }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ messages: [{ id: 'wamid.out' + sent.length }] }));
    });
  });
  return new Promise((r) => srv.listen(port, '127.0.0.1', () => r({
    sent, clear() { sent.length = 0; }, stop: () => new Promise((x) => { srv.closeAllConnections?.(); srv.close(x); }),
  })));
}

async function candidate(name, email, phone) {
  const c = makeClient(base);
  await c.get('/api/health');
  const r = await c.post('/api/auth/register', {
    name, email, password: 'Wa123agent9', phone, preferredLocation: 'Nellore', expectedCtc: 4, noticePeriod: 'Immediate',
    preferredWorkModes: ['Work From Office'], consent: { terms: true, communication: true, resumeProcessing: true },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  c.id = r.body.candidateId;
  return c;
}

const chat = (c, text, jobIds) => c.post('/api/whatsapp-agent/chat', { text, ...(jobIds ? { jobIds } : {}) });
const sign = (raw0) => `sha256=${createHmac('sha256', SECRET).update(raw0).digest('hex')}`;
const metaPayload = (from, id, text) => ({
  object: 'whatsapp_business_account',
  entry: [{ changes: [{ value: { messages: [text == null
    ? { from, id, type: 'image', image: { id: 'x' } }
    : { from, id, type: 'text', text: { body: text } }] } }] }],
});
async function webhook(payload, { sig } = {}) {
  const body = JSON.stringify(payload);
  const res = await fetch(`${base}/api/whatsapp-agent/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(sig === null ? {} : { 'x-hub-signature-256': sig || sign(body) }) },
    body,
  });
  return res.status;
}
const waitFor = async (fn, ms = 4000) => {
  const end = Date.now() + ms;
  for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) return null; await new Promise((r) => setTimeout(r, 40)); }
};

test('boot', async () => {
  dbh = await startTestDb(DB_PORT);
  wa = await startMockGraph(WA_PORT);
  applyTestEnv(dbh.url, {
    PUBLIC_ORIGIN: `http://127.0.0.1:${API_PORT}`,
    DISABLE_BACKGROUND_WORK: 'true',
    AI_API_KEY: '',
    WHATSAPP_API_KEY: 'wa-access-token-for-tests',
    WHATSAPP_PHONE_ID: '555000111',
    WHATSAPP_API_URL: `http://127.0.0.1:${WA_PORT}/v21.0`,
    WHATSAPP_VERIFY_TOKEN: VERIFY,
    WHATSAPP_APP_SECRET: SECRET,
    WHATSAPP_CHAT_RATE_MAX: '1000',
  });
  raw = (sql, params) => dbh.db.query(sql, params);
  await raw(`insert into companies (id, name) values ('co_wa', 'Nellore Care')`);
  await raw(`insert into jobs (id, title, company_id, location, mode, exp_label, pay_label, salary_min, salary_max,
               employment_type, status, skills, published_at, description)
             values ('jwa1', 'Staff Nurse', 'co_wa', 'Nellore', 'Onsite', '1-3 yrs', '₹3-4 LPA', 3, 4,
                     'Full-time', 'open', '{Patient Care,ICU}', now(), 'Care for patients in the ICU.'),
                    ('jwa2', 'Receptionist', 'co_wa', 'Hyderabad', 'Onsite', '0-2 yrs', '₹2-3 LPA', 2, 3,
                     'Full-time', 'open', '{Communication,MS Office}', now() - interval '1 day', 'Front desk.'),
                    ('jwa_draft', 'Secret Draft Role', 'co_wa', 'Nellore', 'Onsite', '0-2 yrs', '₹9 LPA', 9, 9,
                     'Full-time', 'draft', '{}', null, 'x')`);
  const { createApp } = await import('../src/app.js');
  const app = createApp({ logger: { error() {}, log() {} } });
  await new Promise((r) => { server = app.listen(API_PORT, r); });
  base = `http://127.0.0.1:${API_PORT}`;
});

let A; let B;
const PHONE_A = '9100000111';
const PHONE_B = '9100000222';

test('status: booleans for everybody, the missing names only for an administrator, never a value', async () => {
  const anon = makeClient(base);
  await anon.get('/api/health');
  const s = await anon.get('/api/whatsapp-agent/status');
  assert.equal(s.status, 200);
  assert.equal(s.body.configured, true);
  assert.equal(s.body.sending, true);
  assert.equal(s.body.webhook, true);
  assert.equal(s.body.engine, 'rules');
  assert.equal(s.body.missing, undefined, 'a visitor is not told what is configured by name');
  const text = JSON.stringify(s.body);
  for (const secret of [SECRET, VERIFY, 'wa-access-token-for-tests', '555000111']) assert.equal(text.includes(secret), false, 'no value in status');
});

test('chat validation', async () => {
  const anon = makeClient(base);
  await anon.get('/api/health');
  assert.equal((await chat(anon, '')).status, 400);
  assert.equal((await chat(anon, 'x'.repeat(501))).status, 400);
  assert.equal((await anon.post('/api/whatsapp-agent/chat', { text: 'hi', role: 'admin' })).status, 400, 'unknown fields are refused');
});

test('a visitor searches the REAL open jobs: by role, by city, and finds nothing invented', async () => {
  const anon = makeClient(base);
  await anon.get('/api/health');
  let r = await chat(anon, 'Are there any jobs in Nellore?');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.identity, 'guest');
  assert.deepEqual(r.body.jobs.map((j) => j.id), ['jwa1'], 'only the open Nellore job - not Hyderabad, not the draft');
  assert.match(r.body.reply, /Staff Nurse/);
  assert.match(r.body.reply, new RegExp(`/job/jwa1`));
  assert.equal(r.body.reply.includes('Secret Draft Role'), false);

  r = await chat(anon, 'show me jobs for receptionist');
  assert.deepEqual(r.body.jobs.map((j) => j.id), ['jwa2']);

  r = await chat(anon, 'show me jobs for React Developer');
  assert.deepEqual(r.body.jobs, []);
  assert.match(r.body.reply, /couldn't find any open jobs/i, 'no job is invented');

  r = await chat(anon, 'jobs for nurse in Hyderabad');   // none there: says so, then shows the role elsewhere
  assert.match(r.body.reply, /No open jobs in hyderabad/i);
  assert.deepEqual(r.body.jobs.map((j) => j.id), ['jwa1']);

  r = await chat(anon, 'what is my application status?');
  assert.match(r.body.reply, /sign in/i, 'nothing personal without an identity');
  assert.deepEqual(r.body.jobs, []);
});

test('"details 1" and "apply 1" use the job listed before - the apply link opens the existing application page', async () => {
  const anon = makeClient(base);
  await anon.get('/api/health');
  const list = await chat(anon, 'jobs in Nellore');
  const ids = list.body.jobs.map((j) => j.id);
  let r = await chat(anon, 'details 1', ids);
  assert.match(r.body.reply, /Staff Nurse/);
  assert.match(r.body.reply, /Patient Care/);
  r = await chat(anon, 'apply 1', ids);
  assert.match(r.body.reply, /Apply Now/);
  assert.match(r.body.reply, /\/job\/jwa1/);
  assert.match(r.body.reply, /sign in or register/i);
  r = await chat(anon, 'apply', []);
  assert.match(r.body.reply, /which job first/i, 'it does not guess a job');
  r = await chat(anon, 'details 9', ids);
  assert.match(r.body.reply, /Which job\?/);
});

test('a signed-in candidate: their own applications, interviews and AI Match - and nobody else\'s', async () => {
  A = await candidate('Asha Rao', 'asha.wa@tl-sink.local', PHONE_A);
  B = await candidate('Bala Krishna', 'bala.wa@tl-sink.local', PHONE_B);
  await raw(`update candidates set title = 'Staff Nurse', skills = '{Patient Care}', education = 'B.Sc Nursing', exp_years = 2 where id = $1`, [A.id]);
  await raw(`insert into applications (id, candidate_id, job_id, stage, applied_at) values ('app_wa1', $1, 'jwa1', 'applied', now())`, [A.id]);

  let r = await chat(A, 'what is my application status?');
  assert.equal(r.body.identity, 'candidate');
  assert.match(r.body.reply, /Staff Nurse/);
  assert.match(r.body.reply, /Status:/);
  assert.deepEqual(r.body.usedTools, ['get_my_applications']);

  r = await chat(B, 'what is my application status?');
  assert.match(r.body.reply, /haven't applied to any job yet/i, 'B sees none of A\'s applications');
  assert.equal(r.body.reply.includes('Staff Nurse'), false);

  r = await chat(A, 'details 1', ['jwa1']);
  assert.match(r.body.reply, /Your AI Match: \*50%\*/, 'AI Match = 1 of the 2 JD skills (Patient Care)');
  assert.match(r.body.reply, /missing: ICU/);

  r = await chat(A, 'apply 1', ['jwa1']);
  assert.match(r.body.reply, /profile/i);

  /* a new application is given its AI interview by the database itself, so A has one waiting */
  r = await chat(A, 'schedule an interview');
  assert.match(r.body.reply, /AI interview waiting for you/i);
  assert.match(r.body.reply, /Attend AI Interview/);
  r = await chat(B, 'schedule an interview');
  assert.match(r.body.reply, /no interview scheduled or waiting/i, 'A\'s AI interview is not B\'s');

  r = await chat(A, 'how can I improve my profile');
  assert.equal(r.status, 200);
  assert.equal(r.body.engine, 'rules', 'without an AI key the Career Assistant\'s rules engine speaks, and says so');
});

test('webhook: Meta\'s verification handshake', async () => {
  let res = await fetch(`${base}/api/whatsapp-agent/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=12345`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '12345');
  res = await fetch(`${base}/api/whatsapp-agent/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=12345`);
  assert.equal(res.status, 403);
});

test('webhook: an unsigned or wrongly signed message is refused and nothing is sent', async () => {
  wa.clear();
  assert.equal(await webhook(metaPayload('91' + PHONE_A, 'wamid.bad1', 'status'), { sig: null }), 403);
  assert.equal(await webhook(metaPayload('91' + PHONE_A, 'wamid.bad2', 'status'), { sig: 'sha256=' + '0'.repeat(64) }), 403);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(wa.sent.length, 0);
});

test('webhook: a signed message from a candidate\'s number is answered about THEM, through the WhatsApp provider', async () => {
  wa.clear();
  assert.equal(await webhook(metaPayload('91' + PHONE_A, 'wamid.ok1', 'What is my application status?')), 200);
  const m = await waitFor(() => wa.sent[0]);
  assert.ok(m, 'a reply was sent');
  assert.match(m.url, /\/v21\.0\/555000111\/messages$/);
  assert.equal(m.auth, 'Bearer wa-access-token-for-tests');
  assert.equal(m.body.messaging_product, 'whatsapp');
  assert.equal(m.body.to, '91' + PHONE_A);
  assert.match(m.body.text.body, /Staff Nurse/);
  assert.match(m.body.text.body, /Status:/);

  // "apply 1" after a job list resolves against what that phone was shown last
  wa.clear();
  await webhook(metaPayload('91' + PHONE_A, 'wamid.ok2', 'jobs in Nellore'));
  await waitFor(() => wa.sent[0]);
  wa.clear();
  await webhook(metaPayload('91' + PHONE_A, 'wamid.ok3', 'apply 1'));
  const ap = await waitFor(() => wa.sent[0]);
  assert.match(ap.body.text.body, /Staff Nurse/);
  assert.match(ap.body.text.body, /\/job\/jwa1/);
});

test('webhook: Meta retries are answered once; an unknown number gets only public help; images get a polite answer', async () => {
  wa.clear();
  await webhook(metaPayload('91' + PHONE_B, 'wamid.dup', 'jobs in Nellore'));
  await waitFor(() => wa.sent[0]);
  await webhook(metaPayload('91' + PHONE_B, 'wamid.dup', 'jobs in Nellore'));
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(wa.sent.length, 1, 'the same message id is handled once');

  wa.clear();
  await webhook(metaPayload('919999999999', 'wamid.unk', 'what is my application status?'));
  const u = await waitFor(() => wa.sent[0]);
  assert.match(u.body.text.body, /sign in/i);
  assert.equal(u.body.text.body.includes('Staff Nurse'), false, 'a stranger never sees an application');

  wa.clear();
  await webhook(metaPayload('91' + PHONE_A, 'wamid.img', null));
  const img = await waitFor(() => wa.sent[0]);
  assert.match(img.body.text.body, /text messages/i);
});

test('not configured: the page can tell, the webhook answers 503, and no message is pretended', async () => {
  const keep = { s: process.env.WHATSAPP_APP_SECRET, v: process.env.WHATSAPP_VERIFY_TOKEN };
  delete process.env.WHATSAPP_APP_SECRET; delete process.env.WHATSAPP_VERIFY_TOKEN;
  try {
    const anon = makeClient(base);
    await anon.get('/api/health');
    assert.equal((await anon.get('/api/whatsapp-agent/status')).body.configured, false);
    assert.equal((await fetch(`${base}/api/whatsapp-agent/webhook?hub.mode=subscribe&hub.verify_token=x&hub.challenge=1`)).status, 503);
    wa.clear();
    const body = JSON.stringify(metaPayload('91' + PHONE_A, 'wamid.nc', 'hi'));
    const res = await fetch(`${base}/api/whatsapp-agent/webhook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    assert.equal(res.status, 503);
    assert.equal(wa.sent.length, 0);
  } finally {
    process.env.WHATSAPP_APP_SECRET = keep.s; process.env.WHATSAPP_VERIFY_TOKEN = keep.v;
  }
});

test('no secret ever reaches a browser response', async () => {
  const text = JSON.stringify([(await chat(A, 'what is my application status?')).body, (await chat(A, 'jobs in Nellore')).body]);
  for (const secret of [SECRET, VERIFY, 'wa-access-token-for-tests']) assert.equal(text.includes(secret), false);
});

test('shutdown', async () => {
  await new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
  await wa.stop();
  await dbh.stop();
});
