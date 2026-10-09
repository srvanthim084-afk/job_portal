/**
 * Administration -> Integrations -> Email (SMTP), SMS Gateway, WhatsApp Business (0122).
 *
 * Against a real Postgres with RLS, a REAL SMTP server on localhost, and local stand-ins for
 * MSG91 / Fast2SMS / Twilio / the WhatsApp Cloud API:
 *   - only the administrator can read or change them
 *   - required fields are checked with inline errors per field
 *   - a secret is sealed in the database, never comes back, blank keeps and "-" clears
 *   - Test sends a REAL message through the provider with the SAVED settings
 *   - once connected, the senders every module uses (providers.email / sms / whatsapp) read these
 *     settings; Disconnect gives the channel back to the environment
 *   - every save, connect, disconnect and test is in the history, without any value
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { SMTPServer } from 'smtp-server';
import { startTestDb, applyTestEnv, makeClient } from './harness.mjs';

const DB_PORT = 5597;
const API_PORT = 9951;
const MOCK_PORT = 9952;
const SMTP_PORT = 2631;
const PW = 'Chan123admin';
const SMTP_PASS = 'smtp-secret-pass-2026';
const SMS_KEY = 'sms-secret-key-ABCDEF1234567890';
const WA_TOKEN = 'EAAG-whatsapp-permanent-token-9988776655';

let dbh, server, mock, smtp, raw, admin, recruiter, providers;
const hits = [];                    // what the provider stand-ins received
let waReply = () => ({ status: 200, body: { messages: [{ id: 'wamid.1' }] } });
const mails = [];

const base = `http://127.0.0.1:${API_PORT}`;

async function login(email, role) {
  const c = makeClient(base);
  await c.get('/api/health');
  const r = await c.post('/api/auth/login', { email, password: PW, role });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return c;
}

test('boot', async () => {
  mock = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      hits.push({ method: req.method, url: req.url, headers: req.headers, body });
      const json = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.url.startsWith('/msg91')) return json(200, { type: 'success', message: 'msg91-ref-1' });
      if (req.url.startsWith('/fast2sms')) return json(200, { return: true, request_id: 'f2s-1' });
      if (req.url.startsWith('/twilio')) return json(201, { sid: 'SMtwilio1' });
      if (req.url.startsWith('/wa/')) { const r = waReply(body); return json(r.status, r.body); }
      return json(404, {});
    });
  });
  await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));

  smtp = new SMTPServer({
    authOptional: false, hideSTARTTLS: true, disabledCommands: ['STARTTLS'],
    onAuth(auth, _s, cb) { return auth.username === 'mailer' && auth.password === SMTP_PASS ? cb(null, { user: 1 }) : cb(new Error('Invalid login')); },
    onData(stream, _s, cb) { let d = ''; stream.on('data', (x) => { d += x; }); stream.on('end', () => { mails.push(d); cb(); }); },
  });
  await new Promise((r) => smtp.listen(SMTP_PORT, '127.0.0.1', r));

  dbh = await startTestDb(DB_PORT);
  applyTestEnv(dbh.url, {
    PUBLIC_ORIGIN: base, DISABLE_BACKGROUND_WORK: 'true',
    INTEGRATION_SECRET_KEY: 'test-only-integration-secret-key-000000000',
    MSG91_API_URL: `http://127.0.0.1:${MOCK_PORT}/msg91/flow`,
    FAST2SMS_API_URL: `http://127.0.0.1:${MOCK_PORT}/fast2sms/bulk`,
    TWILIO_API_URL: `http://127.0.0.1:${MOCK_PORT}/twilio/2010-04-01`,
    WHATSAPP_API_URL: `http://127.0.0.1:${MOCK_PORT}/wa`,
    OUTBOUND_ALLOWLIST: '',
    EMAIL_API_KEY: '', EMAIL_SMTP_HOST: '', EMAIL_SMTP_USER: '', EMAIL_SMTP_PASS: '', EMAIL_FROM: '',
    EMAILJS_SERVICE_ID: '', EMAILJS_TEMPLATE_ID: '', EMAILJS_PUBLIC_KEY: '', EMAILJS_PRIVATE_KEY: '',
    SMS_API_KEY: '', SMS_API_URL: '', WHATSAPP_API_KEY: '', WHATSAPP_PHONE_ID: '',
  });
  raw = (sql, params) => dbh.db.query(sql, params);
  await raw(`insert into companies (id, name) values ('co_ch', 'Channel Co')`);
  const { hashPassword } = await import('../src/auth.js');
  const hash = await hashPassword(PW);
  const mk = async (email, role, table, id) => {
    const u = (await raw(`insert into users (email,password_hash,role) values ($1,$2,$3) returning id`, [email, hash, role])).rows[0].id;
    if (table === 'recruiters') await raw(`insert into recruiters (id, name, email, company_id, user_id) values ($1,'Rec',$2,'co_ch',$3)`, [id, email, u]);
    else await raw(`insert into admins (id, name, email, user_id) values ($1,'Super Admin',$2,$3)`, [id, email, u]);
  };
  await mk('admin.ch@tl-sink.local', 'admin', 'admins', 'adm_ch');
  await mk('rec.ch@tl-sink.local', 'recruiter', 'recruiters', 'rec_ch');
  const { createApp } = await import('../src/app.js');
  ({ providers } = await import('../src/notify/providers.js'));
  const app = createApp({ logger: { error() {}, log() {} } });
  await new Promise((r) => { server = app.listen(API_PORT, r); });
  admin = await login('admin.ch@tl-sink.local', 'admin');
  recruiter = await login('rec.ch@tl-sink.local', 'recruiter');
});

test('only the Super Admin can open or change the channels', async () => {
  assert.equal((await makeClient(base).get('/api/admin/integration-channels')).status, 401);
  assert.equal((await recruiter.get('/api/admin/integration-channels')).status, 403);
  assert.equal((await recruiter.put('/api/admin/integration-channels/email', { config: { host: 'x' } })).status, 403);
  assert.equal((await recruiter.post('/api/admin/integration-channels/sms/test', { to: '9876543210' })).status, 403);
  const r = await admin.get('/api/admin/integration-channels');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.secretKeyConfigured, true);
  assert.deepEqual(r.body.channels.map((c) => c.channel), ['email', 'sms', 'whatsapp']);
  for (const c of r.body.channels) { assert.equal(c.status, 'Not Connected'); assert.equal(c.mode, 'Demo'); }
  // nothing sends until a channel is connected
  assert.equal(providers.email.configured(), false);
  assert.equal(providers.sms.configured(), false);
  assert.equal(providers.whatsapp.configured(), false);
});

test('required fields are checked, each error under its own field', async () => {
  let r = await admin.put('/api/admin/integration-channels/email', { config: { host: '', port: '99999', fromAddress: 'nope', username: '' }, secrets: {} });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  const d = r.body.error.details;
  assert.match(d.host, /required/i); assert.match(d.port, /1 to 65535/); assert.match(d.fromAddress, /valid email/i);
  assert.match(d.username, /required/i); assert.match(d.password, /required/i);

  r = await admin.put('/api/admin/integration-channels/sms', { config: { provider: 'Twilio', senderId: '' }, secrets: {} });
  assert.match(r.body.error.details.senderId, /required/i); assert.match(r.body.error.details.twilioSid, /SID/);
  assert.match(r.body.error.details.apiKey, /required/i);
  r = await admin.put('/api/admin/integration-channels/sms', { config: { provider: 'MSG91', senderId: 'TOOLONGSENDER' }, secrets: { apiKey: SMS_KEY } });
  assert.match(r.body.error.details.senderId, /6 letters/);

  r = await admin.put('/api/admin/integration-channels/whatsapp', { config: {}, secrets: {} });
  assert.match(r.body.error.details.phoneNumberId, /required/i); assert.match(r.body.error.details.businessId, /required/i);
  assert.match(r.body.error.details.accessToken, /required/i);
  assert.equal((await raw(`select count(*)::int n from integration_channels`)).rows[0].n, 0, 'nothing was saved');
});

test('Email: Save & Connect seals the password; it never comes back; blank keeps, "-" clears', async () => {
  const cfg = { host: '127.0.0.1', port: String(SMTP_PORT), fromAddress: 'hr@tmlink.in', username: 'mailer', encryption: 'None', fromName: 'TeamLink HR' };
  const r = await admin.put('/api/admin/integration-channels/email', { config: cfg, secrets: { password: SMTP_PASS } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const c = r.body.channel;
  assert.equal(c.status, 'Connected'); assert.equal(c.mode, 'Live');
  assert.equal(c.summary, `127.0.0.1:${SMTP_PORT}`);
  assert.equal(c.secrets.password.saved, true);
  assert.doesNotMatch(JSON.stringify(r.body), new RegExp(SMTP_PASS), 'the password came back');
  const stored = (await raw(`select config, secrets_enc from integration_channels where channel='email'`)).rows[0];
  assert.doesNotMatch(JSON.stringify(stored), new RegExp(SMTP_PASS), 'the password is stored in plain text');
  assert.match(stored.secrets_enc, /"ct"/, 'sealed');
  const list = await admin.get('/api/admin/integration-channels');
  assert.doesNotMatch(JSON.stringify(list.body), new RegExp(SMTP_PASS));

  // blank keeps
  const again = await admin.put('/api/admin/integration-channels/email', { config: { ...cfg, fromName: 'TeamLink People' }, secrets: { password: '' } });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.channel.secrets.password.saved, true);
  // "-" clears, and a connected channel then cannot be saved without one
  const cleared = await admin.put('/api/admin/integration-channels/email', { config: cfg, secrets: { password: '-' } });
  assert.equal(cleared.status, 400);
  assert.match(cleared.body.error.details.password, /required/i);
  // put it back
  assert.equal((await admin.put('/api/admin/integration-channels/email', { config: cfg, secrets: { password: SMTP_PASS } })).status, 200);
});

test('Email: Test sends a REAL message through the SMTP server; a wrong password is reported without leaking it', async () => {
  const before = mails.length;
  const t = await admin.post('/api/admin/integration-channels/email/test', {});
  assert.equal(t.status, 200, JSON.stringify(t.body));
  assert.equal(t.body.ok, true, t.body.message);
  assert.equal(mails.length, before + 1);
  assert.match(mails[mails.length - 1], /Subject: TeamLink test email/);
  assert.match(mails[mails.length - 1], /To: admin\.ch@tl-sink\.local/, 'default recipient is the administrator');
  assert.match(mails[mails.length - 1], /From: "?TeamLink HR"? <hr@tmlink\.in>/);
  assert.equal(t.body.channel.lastTest.ok, true);

  await admin.put('/api/admin/integration-channels/email', {
    config: { host: '127.0.0.1', port: String(SMTP_PORT), fromAddress: 'hr@tmlink.in', username: 'mailer', encryption: 'None', fromName: 'TeamLink HR' },
    secrets: { password: 'wrong-password-xyz-123' }, connect: false });
  const bad = await admin.post('/api/admin/integration-channels/email/test', { to: 'someone@mailbox.in' });
  assert.equal(bad.body.ok, false);
  assert.doesNotMatch(JSON.stringify(bad.body), /wrong-password-xyz-123/);
  assert.equal(bad.body.channel.lastTest.ok, false);
  await admin.put('/api/admin/integration-channels/email', {
    config: { host: '127.0.0.1', port: String(SMTP_PORT), fromAddress: 'hr@tmlink.in', username: 'mailer', encryption: 'None', fromName: 'TeamLink HR' },
    secrets: { password: SMTP_PASS } });
});

test('Email: once connected the senders every module uses read these settings; Disconnect gives it back', async () => {
  assert.equal(providers.email.configured(), true, 'connected: the SMTP settings from the database are in use');
  const before = mails.length;
  const s = await providers.email.send({ to: 'candidate@mailbox.in', subject: 'Offer letter', text: 'Congratulations', html: '<p>Congratulations</p>' });
  assert.equal(s.status, 'sent', JSON.stringify(s));
  assert.equal(mails.length, before + 1);
  assert.match(mails[mails.length - 1], /From: "?TeamLink HR"? <hr@tmlink\.in>/);

  const d = await admin.post('/api/admin/integration-channels/email/disconnect', {});
  assert.equal(d.body.channel.status, 'Not Connected'); assert.equal(d.body.channel.mode, 'Demo');
  assert.equal(providers.email.configured(), false, 'disconnected: back to the (empty) environment');
  const n = await providers.email.send({ to: 'candidate@mailbox.in', subject: 's', text: 't' });
  assert.equal(n.status, 'not_configured');

  const c = await admin.post('/api/admin/integration-channels/email/connect', {});
  assert.equal(c.body.channel.status, 'Connected');
  assert.equal(providers.email.configured(), true);
});

const smsCfg = (over = {}) => ({ provider: 'MSG91', senderId: 'TMLINK', dltAgreement: 'tpl_agree_1', dltOtp: 'tpl_otp_1', dltBulk: 'tpl_bulk_1', ...over });

test('SMS: MSG91, Fast2SMS and Twilio each get the provider\'s own request, with the DLT template', async () => {
  let r = await admin.put('/api/admin/integration-channels/sms', { config: smsCfg(), secrets: { apiKey: SMS_KEY } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.doesNotMatch(JSON.stringify(r.body), new RegExp(SMS_KEY));
  assert.equal(r.body.channel.summary, 'MSG91 · TMLINK');

  hits.length = 0;
  let t = await admin.post('/api/admin/integration-channels/sms/test', { to: '9876543210' });
  assert.equal(t.body.ok, true, t.body.message);
  const m = hits.find((h) => h.url.startsWith('/msg91'));
  assert.equal(m.headers.authkey, SMS_KEY);
  const mb = JSON.parse(m.body);
  assert.equal(mb.template_id, 'tpl_bulk_1');
  assert.equal(mb.recipients[0].mobiles, '919876543210');
  assert.match(mb.recipients[0].VAR1, /TeamLink test message/, 'bulk: ONE variable, the message');

  r = await admin.put('/api/admin/integration-channels/sms', { config: smsCfg({ provider: 'Fast2SMS' }), secrets: {} });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  hits.length = 0;
  t = await admin.post('/api/admin/integration-channels/sms/test', { to: '9876543210' });
  assert.equal(t.body.ok, true, t.body.message);
  const f = hits.find((h) => h.url.startsWith('/fast2sms'));
  assert.equal(f.headers.authorization, SMS_KEY);
  assert.equal(JSON.parse(f.body).route, 'dlt'); assert.equal(JSON.parse(f.body).message, 'tpl_bulk_1');
  assert.equal(JSON.parse(f.body).numbers, '9876543210');

  r = await admin.put('/api/admin/integration-channels/sms', { config: smsCfg({ provider: 'Twilio', senderId: '+15005550006', twilioSid: 'AC123456789' }), secrets: {} });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  hits.length = 0;
  t = await admin.post('/api/admin/integration-channels/sms/test', { to: '9876543210' });
  assert.equal(t.body.ok, true, t.body.message);
  const w = hits.find((h) => h.url.startsWith('/twilio'));
  assert.match(w.url, /\/Accounts\/AC123456789\/Messages\.json$/);
  assert.equal(w.headers.authorization, `Basic ${Buffer.from(`AC123456789:${SMS_KEY}`).toString('base64')}`);
  assert.match(w.body, /To=%2B919876543210/); assert.match(w.body, /From=%2B15005550006/);
});

test('SMS: the senders use the administrator\'s provider and the template for the purpose; a missing template is refused, not lost', async () => {
  await admin.put('/api/admin/integration-channels/sms', { config: smsCfg(), secrets: {} });      // back to MSG91
  assert.equal(providers.sms.configured(), true);
  hits.length = 0;
  const otp = await providers.sms.send({ to: '9876543210', text: 'x', purpose: 'otp', vars: ['482913', '10'] });
  assert.equal(otp.status, 'sent', JSON.stringify(otp));
  const ob = JSON.parse(hits.find((h) => h.url.startsWith('/msg91')).body);
  assert.equal(ob.template_id, 'tpl_otp_1');
  assert.equal(ob.recipients[0].VAR1, '482913'); assert.equal(ob.recipients[0].VAR2, '10');
  const ag = await providers.sms.send({ to: '9876543210', text: 'x', purpose: 'agreement', vars: ['Asha', 'AG-77', 'https://tm.link/s/1'] });
  assert.equal(ag.status, 'sent');
  assert.equal(JSON.parse(hits[hits.length - 1].body).template_id, 'tpl_agree_1');
  const plain = await providers.sms.send({ to: '9876543210', text: 'Your interview is tomorrow' });
  assert.equal(JSON.parse(hits[hits.length - 1].body).recipients[0].VAR1, 'Your interview is tomorrow');
  assert.equal(plain.status, 'sent');

  await admin.put('/api/admin/integration-channels/sms', { config: smsCfg({ dltOtp: '' }), secrets: {} });
  const n = hits.length;
  const refused = await providers.sms.send({ to: '9876543210', text: 'x', purpose: 'otp', vars: ['1', '2'] });
  assert.equal(refused.status, 'failed');
  assert.match(refused.error, /No DLT template id/);
  assert.equal(hits.length, n, 'nothing was sent to the operator');
});

test('WhatsApp: Test reaches the Cloud API; plain text outside the 24-hour window is explained; templates by purpose', async () => {
  const cfg = { businessPhone: '+919876500000', phoneNumberId: '1098765', businessId: 'WABA-77', language: 'en', templateAgreement: 'agreement_link', templateOtp: 'otp_code', templateBulk: '' };
  const r = await admin.put('/api/admin/integration-channels/whatsapp', { config: cfg, secrets: { accessToken: WA_TOKEN } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.doesNotMatch(JSON.stringify(r.body), new RegExp(WA_TOKEN));
  assert.equal(r.body.channel.summary, '+919876500000');

  hits.length = 0;
  waReply = () => ({ status: 400, body: { error: { message: 'Re-engagement message', code: 131047 } } });
  let t = await admin.post('/api/admin/integration-channels/whatsapp/test', { to: '9876543210' });
  assert.equal(t.body.ok, false);
  assert.match(t.body.message, /24-hour/);
  assert.doesNotMatch(JSON.stringify(t.body), new RegExp(WA_TOKEN));

  waReply = () => ({ status: 200, body: { messages: [{ id: 'wamid.OK' }] } });
  await admin.put('/api/admin/integration-channels/whatsapp', { config: { ...cfg, templateBulk: 'general_message' }, secrets: {} });
  hits.length = 0;
  t = await admin.post('/api/admin/integration-channels/whatsapp/test', { to: '9876543210' });
  assert.equal(t.body.ok, true, t.body.message);
  const h = hits.find((x) => x.url.startsWith('/wa/'));
  assert.equal(h.url, '/wa/1098765/messages');
  assert.equal(h.headers.authorization, `Bearer ${WA_TOKEN}`);
  assert.equal(JSON.parse(h.body).template.name, 'general_message');

  // the senders: agreement carries its three variables, bulk carries the one message
  assert.equal(providers.whatsapp.configured(), true);
  hits.length = 0;
  const a = await providers.whatsapp.send({ to: '9876543210', text: 'x', purpose: 'agreement', vars: ['Asha', 'AG-77', 'https://tm.link/s/1'] });
  assert.equal(a.status, 'sent', JSON.stringify(a));
  const ab = JSON.parse(hits[0].body);
  assert.equal(ab.template.name, 'agreement_link');
  assert.deepEqual(ab.template.components[0].parameters.map((p) => p.text), ['Asha', 'AG-77', 'https://tm.link/s/1']);
  await providers.whatsapp.send({ to: '9876543210', text: 'Your interview is tomorrow' });
  const bb = JSON.parse(hits[1].body);
  assert.equal(bb.template.name, 'general_message');
  assert.equal(bb.template.components[0].parameters[0].text, 'Your interview is tomorrow');
});

test('the history records every action, with field names and never a value', async () => {
  for (const ch of ['email', 'sms', 'whatsapp']) {
    const h = await admin.get(`/api/admin/integration-channels/${ch}/events`);
    assert.equal(h.status, 200);
    assert.ok(h.body.events.length >= 2, `${ch}: ${h.body.events.length} events`);
    const text = JSON.stringify(h.body);
    for (const secret of [SMTP_PASS, SMS_KEY, WA_TOKEN, 'wrong-password-xyz-123']) assert.doesNotMatch(text, new RegExp(secret));
  }
  const kinds = (await admin.get('/api/admin/integration-channels/email/events')).body.events.map((e) => e.event);
  for (const k of ['config_saved', 'secret_saved', 'connected', 'test_ok', 'test_failed', 'disconnected']) assert.ok(kinds.includes(k), `email history has ${k}: ${kinds}`);
  assert.equal((await recruiter.get('/api/admin/integration-channels/email/events')).status, 403);
  assert.equal((await admin.get('/api/admin/integration-channels/fax/events')).status, 404);
});

test('shutdown', async () => {
  await new Promise((r) => server.close(r));
  const { stopBackgroundWork } = await import('../src/app.js');
  stopBackgroundWork();
  const { closePool } = await import('../src/db.js');
  await closePool();
  await dbh.stop?.();
  await new Promise((r) => mock.close(r));
  await new Promise((r) => smtp.close(r));
});
