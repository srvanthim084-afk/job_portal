/**
 * Several WhatsApp Business numbers, assigned by the administrator (0160).
 *
 * Meta's Graph API is NEVER called: WHATSAPP_API_URL points at a local server that answers like it - it knows which token belongs to
 * which phone-number id, reports a display number / verification state, accepts messages and records exactly which number and token
 * each one was sent with.
 *
 *   - administrator only; no response ever carries a token
 *   - adding a number verifies it with WhatsApp: connected / verification required / disconnected, with the reason; a duplicate is refused
 *   - assignment by department, by person and "open to all"; the primary (existing) connection is open to all until restricted
 *   - a send leaves from the number the sender chose - only one they may use; none = refused with a clear message, nothing queued
 *   - an incoming message is filed under the number it was sent to, answered from that number, and shown only to people who may use it
 *   - a number can be deactivated, reconnected, made the default and removed; every change is in the audit log
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { startTestDb, applyTestEnv, makeClient } from './harness.mjs';

const DB_PORT = 5705;
const API_PORT = 9977;
const WA_PORT = 9978;
const base = `http://127.0.0.1:${API_PORT}`;
const PW = 'WaNum#2026xyz';
const GLOBAL_SECRET = 'global-app-secret-for-tests';
const PRIMARY_PID = '555000111';
const TOK_A = 'token-for-number-A-aaaaaaaaaaaaaaaa';
const TOK_B = 'token-for-number-B-bbbbbbbbbbbbbbbb';

/* which token owns which phone-number id, and what WhatsApp says about it */
const META = {
  '111111': { token: TOK_A, display: '+91 98765 11111', name: 'Medical Hiring', code: 'VERIFIED', biz: '9000001' },
  '222222': { token: 'token-for-number-dup-ddddddddddddd', display: '+91 98765 11111', name: 'Same number again', code: 'VERIFIED', biz: '9000001' },
  '333333': { token: 'token-for-number-C-cccccccccccccccc', display: '+91 98765 33333', name: 'Pending', code: 'NOT_VERIFIED', biz: '9000001' },
  '444444': { token: TOK_B, display: '+91 98765 44444', name: 'Education Hiring', code: 'VERIFIED', biz: '9000001' },
  [PRIMARY_PID]: { token: 'primary-token-for-tests-pppppppp', display: '+91 90000 55511', name: 'TeamLink', code: 'VERIFIED', biz: '' },
};

let dbh, server, raw, graph, admin, recMed, recIt, bde, drainQueue, aId, bId, medUser, itUser;

function startMockGraph(port) {
  const sent = [];
  let counter = 0;
  const srv = createServer((req, res) => {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      const auth = String(req.headers.authorization || '').replace('Bearer ', '');
      const u = new URL(req.url, 'http://x');
      const parts = u.pathname.split('/').filter(Boolean);          // v21.0, <id>, [messages|phone_numbers]
      const id = parts[1];
      if (req.method === 'GET' && parts[2] === 'phone_numbers') {
        res.end(JSON.stringify({ data: Object.keys(META).filter((k) => META[k].biz === id).map((k) => ({ id: k })) })); return;
      }
      if (req.method === 'GET') {
        const m = META[id];
        if (!m || m.token !== auth) { res.statusCode = 401; res.end(JSON.stringify({ error: { message: 'Invalid OAuth access token.' } })); return; }
        res.end(JSON.stringify({ id, display_phone_number: m.display, verified_name: m.name, quality_rating: 'GREEN', code_verification_status: m.code })); return;
      }
      const body = JSON.parse(b || '{}');
      sent.push({ pid: id, auth, body });
      const m = META[id];
      if (!m || m.token !== auth) { res.statusCode = 401; res.end(JSON.stringify({ error: { message: 'Invalid OAuth access token.' } })); return; }
      res.end(JSON.stringify({ messages: [{ id: `wamid.${id}.${++counter}` }] }));
    });
  });
  return new Promise((r) => srv.listen(port, '127.0.0.1', () => r({
    sent, clear() { sent.length = 0; }, stop: () => new Promise((x) => { srv.closeAllConnections?.(); srv.close(x); }),
  })));
}

async function staffUser(email, role) {
  const { hashPassword } = await import('../src/auth.js');
  return (await raw(`insert into users (email, password_hash, role) values ($1, $2, $3) returning id`, [email, await hashPassword(PW), role])).rows[0].id;
}
async function login(email, role) {
  const c = makeClient(base); await c.get('/api/health');
  const r = await c.post('/api/auth/login', { email, password: PW, role });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return c;
}
const drain = async () => { for (let i = 0; i < 20; i += 1) { const o = await drainQueue({ limit: 50 }); if (!o.claimed) break; } };
const sign = (secret, s) => `sha256=${createHmac('sha256', secret).update(s).digest('hex')}`;
async function webhook(payload, secret = GLOBAL_SECRET) {
  const body = JSON.stringify(payload);
  const res = await fetch(`${base}/api/whatsapp-agent/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(secret, body) }, body });
  return res.status;
}
const inbound = (pid, from, text, id) => ({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: {
  metadata: { phone_number_id: pid }, contacts: [{ wa_id: from, profile: { name: 'Asha Candidate' } }],
  messages: [{ from, id, type: 'text', text: { body: text } }] } }] }] });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const body = (n, extra = {}) => ({ displayName: n.name, phoneNumberId: n.pid, businessAccountId: n.biz || '9000001', accessToken: n.token, ...extra });
const A = { name: 'Medical Hiring', pid: '111111', token: TOK_A };

test('boot', async () => {
  dbh = await startTestDb(DB_PORT);
  graph = await startMockGraph(WA_PORT);
  applyTestEnv(dbh.url, {
    PUBLIC_ORIGIN: base, DISABLE_BACKGROUND_WORK: 'true', OUTBOUND_ALLOWLIST: '',
    WHATSAPP_API_KEY: META[PRIMARY_PID].token, WHATSAPP_PHONE_ID: PRIMARY_PID, WHATSAPP_API_URL: `http://127.0.0.1:${WA_PORT}/v21.0`,
    WHATSAPP_APP_SECRET: GLOBAL_SECRET, WHATSAPP_VERIFY_TOKEN: 'global-verify', WHATSAPP_CHAT_RATE_MAX: '1000',
  });
  raw = (sql, params) => dbh.db.query(sql, params);
  await raw(`insert into companies (id, name) values ('co_wn', 'Numbers Co')`);
  const { createApp } = await import('../src/app.js');
  ({ drainQueue } = await import('../src/notify/bulk.js'));
  const app = createApp({ logger: { error() {}, log() {} } });
  await new Promise((r) => { server = app.listen(API_PORT, r); });
  await wait(1500);        // the start-up read of the connected channels finishes before the test touches the same connection
  process.env.INTEGRATION_SECRET_KEY = 'a-long-test-passphrase-for-sealing-secrets';

  const au = await staffUser('admin.wn@tl-sink.local', 'admin');
  await raw(`insert into admins (id, user_id, name, email) values ('a_wn', $1, 'Admin WN', 'admin.wn@tl-sink.local')`, [au]);
  medUser = await staffUser('med.wn@tl-sink.local', 'recruiter');
  await raw(`insert into recruiters (id, user_id, name, email, company_id, department) values ('r_wnm', $1, 'Meena Medical', 'med.wn@tl-sink.local', 'co_wn', 'Medical')`, [medUser]);
  itUser = await staffUser('it.wn@tl-sink.local', 'recruiter');
  await raw(`insert into recruiters (id, user_id, name, email, company_id, department) values ('r_wni', $1, 'Ishan IT', 'it.wn@tl-sink.local', 'co_wn', 'IT')`, [itUser]);
  const bu = await staffUser('bde.wn@tl-sink.local', 'bde');
  await raw(`insert into bde_users (id, user_id, name, email, company_id) values ('b_wn', $1, 'Bala BDE', 'bde.wn@tl-sink.local', 'co_wn')`, [bu]);
  admin = await login('admin.wn@tl-sink.local', 'admin');
  recMed = await login('med.wn@tl-sink.local', 'recruiter');
  recIt = await login('it.wn@tl-sink.local', 'recruiter');
  bde = await login('bde.wn@tl-sink.local', 'bde');

  /* a candidate to message, with a WhatsApp opt-in, applied to a job of Meena's, and one approved template */
  await raw(`insert into jobs (id, title, company_id, location, mode, exp_label, skills, status, recruiter_id, description, published_at)
             values ('j_wn', 'Staff Nurse', 'co_wn', 'Nellore', 'Onsite', '1-3 yrs', '{ICU}', 'open', 'r_wnm', 'x', now())`);
  await raw(`insert into candidates (id, name, email, phone, location, whatsapp_opt_in) values
             ('c_wn1', 'Asha Candidate', 'asha@tl-sink.local', '9876500201', 'Nellore', true),
             ('c_wn2', 'Bhanu Candidate', 'bhanu@tl-sink.local', '9876500202', 'Nellore', true)`);
  await raw(`insert into applications (id, job_id, candidate_id, recruiter_id, stage) values ('ap_wn1','j_wn','c_wn1','r_wnm','applied'),('ap_wn2','j_wn','c_wn2','r_wnm','applied')`);
  const t = await admin.post('/api/whatsapp/templates', { name: 'Hello', waName: 'hello_candidate', language: 'en', waStatus: 'approved', body: 'Hello {{candidate_name}}, about the {{job_title}} role.' });
  assert.equal(t.status, 201, JSON.stringify(t.body));
  globalThis.__tpl = t.body.template.id;
});

test('administrator only; the existing connection is the primary number, open to everybody, and no token is ever returned', async () => {
  assert.equal((await recMed.get('/api/admin/whatsapp-numbers')).status, 403);
  assert.equal((await recMed.post('/api/admin/whatsapp-numbers', body(A))).status, 403);
  const anon = makeClient(base); await anon.get('/api/health');
  assert.equal((await anon.get('/api/admin/whatsapp-numbers')).status, 401);
  const l = await admin.get('/api/admin/whatsapp-numbers');
  assert.equal(l.status, 200);
  const p = l.body.numbers.find((n) => n.primary);
  assert.ok(p && p.id === 'wan_primary' && p.openToAll && p.isDefault && p.phoneNumberId === PRIMARY_PID && p.hasToken);
  assert.ok(!JSON.stringify(l.body).includes(META[PRIMARY_PID].token), 'the primary token never reaches a page');
  // everybody on the staff can send from it, exactly as before
  for (const c of [recMed, recIt, bde, admin]) {
    const m = (await c.get('/api/whatsapp/my-numbers')).body.numbers;
    assert.deepEqual(m.map((n) => n.id), ['wan_primary']);
  }
});

test('adding a number verifies it with WhatsApp; the token is sealed and never comes back', async () => {
  const bad = await admin.post('/api/admin/whatsapp-numbers', { displayName: 'x', phoneNumberId: 'abc', accessToken: 'short' });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.error.details.phoneNumberId && bad.body.error.details.accessToken, JSON.stringify(bad.body));

  const r = await admin.post('/api/admin/whatsapp-numbers', body(A, { appSecret: 'app-secret-for-number-A' }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const n = r.body.number;
  aId = n.id;
  assert.equal(n.status, 'connected');
  assert.equal(n.displayPhone, '+91 98765 11111');
  assert.equal(n.verifiedName, 'Medical Hiring');
  assert.ok(n.hasToken && n.hasAppSecret && n.tokenHint === TOK_A.slice(-4) && n.webhookVerifyToken && n.webhookVerifyToken.startsWith('tlwh_'));
  const everything = JSON.stringify((await admin.get('/api/admin/whatsapp-numbers')).body) + JSON.stringify(r.body);
  assert.ok(!everything.includes(TOK_A) && !everything.includes('app-secret-for-number-A'), 'no credential in any response');
  const row = (await raw(`select access_token_enc, app_secret_enc from whatsapp_numbers where id = $1`, [aId])).rows[0];
  assert.ok(row.access_token_enc && !row.access_token_enc.includes(TOK_A), 'sealed at rest');
  assert.ok(!(await raw(`select * from audit_log where detail::text like $1`, [`%${TOK_A}%`])).rows.length, 'and never in the audit log');
});

test('a duplicate is refused, a bad token is shown as disconnected, an unfinished one as verification required, and Reconnect fixes it', async () => {
  assert.equal((await admin.post('/api/admin/whatsapp-numbers', body(A))).status, 409, 'same phone-number id');
  const dup = await admin.post('/api/admin/whatsapp-numbers', { displayName: 'Dup', phoneNumberId: '222222', businessAccountId: '9000001', accessToken: META['222222'].token });
  assert.equal(dup.status, 409, 'WhatsApp says it is the same display number');
  assert.equal((await raw(`select count(*)::int n from whatsapp_numbers where phone_number_id = '222222' and removed_at is null`)).rows[0].n, 0, 'no half-made number is left behind');

  const wrong = await admin.post('/api/admin/whatsapp-numbers', { displayName: 'Education', phoneNumberId: '444444', businessAccountId: '9000001', accessToken: 'a-token-that-is-the-wrong-one-xxxx' });
  assert.equal(wrong.status, 201);
  assert.equal(wrong.body.number.status, 'disconnected');
  assert.match(wrong.body.number.statusDetail, /Invalid OAuth/);
  bId = wrong.body.number.id;
  const fixed = await admin.post(`/api/admin/whatsapp-numbers/${bId}/verify`, { accessToken: TOK_B });
  assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
  assert.equal(fixed.body.number.status, 'connected');
  assert.equal(fixed.body.number.displayPhone, '+91 98765 44444');

  const pend = await admin.post('/api/admin/whatsapp-numbers', { displayName: 'Pending', phoneNumberId: '333333', businessAccountId: '9000001', accessToken: META['333333'].token });
  assert.equal(pend.body.number.status, 'verification_required');
  assert.match(pend.body.number.statusDetail, /NOT_VERIFIED/);
  await admin.del(`/api/admin/whatsapp-numbers/${pend.body.number.id}`);
});

test('assignment: by department, by person, or open to all - and the primary can be restricted', async () => {
  // nobody has A yet
  assert.deepEqual((await recMed.get('/api/whatsapp/my-numbers')).body.numbers.map((n) => n.id), ['wan_primary']);
  const a = await admin.put(`/api/admin/whatsapp-numbers/${aId}/access`, { departments: ['Medical'], userIds: [], openToAll: false });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.deepEqual(a.body.number.departments, ['Medical']);
  assert.equal(a.body.number.department, 'Medical');
  assert.deepEqual((await recMed.get('/api/whatsapp/my-numbers')).body.numbers.map((n) => n.id).sort(), [aId, 'wan_primary'].sort());
  assert.deepEqual((await recIt.get('/api/whatsapp/my-numbers')).body.numbers.map((n) => n.id), ['wan_primary']);

  // a specific person (the IT recruiter) and the BDE department by name
  await admin.put(`/api/admin/whatsapp-numbers/${bId}/access`, { departments: ['BDE'], userIds: [itUser], openToAll: false });
  assert.ok((await recIt.get('/api/whatsapp/my-numbers')).body.numbers.some((n) => n.id === bId));
  assert.ok((await bde.get('/api/whatsapp/my-numbers')).body.numbers.some((n) => n.id === bId), 'the BDE department');
  assert.ok(!(await recMed.get('/api/whatsapp/my-numbers')).body.numbers.some((n) => n.id === bId));
  const who = (await admin.get('/api/admin/whatsapp-numbers')).body.numbers.find((n) => n.id === bId);
  assert.deepEqual(who.users.map((u) => u.name), ['Ishan IT']);

  // the admin can see who is assignable
  const as = (await admin.get('/api/admin/whatsapp-numbers/assignable')).body;
  assert.ok(as.staff.some((u) => u.name === 'Meena Medical' && u.department === 'Medical') && as.departments.includes('Manufacturing') && as.departments.includes('Medical'));
  // a recruiter cannot change assignments
  assert.equal((await recMed.put(`/api/admin/whatsapp-numbers/${aId}/access`, { departments: ['IT'], openToAll: true })).status, 403);

  // restrict the primary: the Medical recruiter keeps A; the IT recruiter keeps B; nobody else has the primary
  await admin.put('/api/admin/whatsapp-numbers/wan_primary/access', { departments: [], userIds: [], openToAll: false });
  assert.deepEqual((await recMed.get('/api/whatsapp/my-numbers')).body.numbers.map((n) => n.id), [aId]);
  assert.deepEqual((await recIt.get('/api/whatsapp/my-numbers')).body.numbers.map((n) => n.id), [bId]);
});

test('a message leaves from the sender\'s own number; a number they have not been given is refused and nothing is queued', async () => {
  const tpl = globalThis.__tpl;
  graph.clear();
  // no numberId: Meena has exactly one number, A
  const r = await recMed.post('/api/whatsapp/send', { templateId: tpl, candidateIds: ['c_wn1'], sendKey: 'wn-send-key-0001', campaignName: 'From A' });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.equal(r.body.number.id, aId);
  await drain();
  assert.equal(graph.sent.length, 1);
  assert.deepEqual([graph.sent[0].pid, graph.sent[0].auth], ['111111', TOK_A], 'sent through number A with number A\'s own token');
  const st = (await recMed.get(`/api/whatsapp/batches/${r.body.batchId}`)).body;
  assert.match(st.numberLabel, /Medical Hiring/);
  assert.equal(st.rows[0].status, 'sent');
  assert.equal((await raw(`select whatsapp_number_id from message_logs where batch_id = $1`, [r.body.batchId])).rows[0].whatsapp_number_id, aId);

  // the IT recruiter asks for A: not theirs
  graph.clear();
  const bad = await recIt.post('/api/whatsapp/send', { templateId: tpl, candidateIds: ['c_wn2'], sendKey: 'wn-send-key-0002', numberId: aId });
  assert.equal(bad.status, 403);
  assert.equal(graph.sent.length, 0);
  assert.equal((await raw(`select count(*)::int n from message_logs where batch_id = (select batch_id from message_logs order by id desc limit 1) and candidate_id = 'c_wn2'`)).rows[0].n, 0);

  // the IT recruiter's own number is B, and the BDE (no number besides B's department) uses B too
  const ok = await recIt.post('/api/whatsapp/send', { templateId: tpl, candidateIds: ['c_wn2'], sendKey: 'wn-send-key-0003', includeWarned: true, includeNotLooking: true });
  assert.ok([202, 200].includes(ok.status), JSON.stringify(ok.body));
  assert.equal(ok.body.number.id, bId);

  // nobody given a number, nothing is sent
  await raw(`insert into users (email, password_hash, role) select 'nonum.wn@tl-sink.local', password_hash, 'recruiter' from users where email = 'it.wn@tl-sink.local'`);
  const nu = (await raw(`select id from users where email = 'nonum.wn@tl-sink.local'`)).rows[0].id;
  await raw(`insert into recruiters (id, user_id, name, email, company_id, department) values ('r_wnx', $1, 'No Number', 'nonum.wn@tl-sink.local', 'co_wn', 'Hospitality')`, [nu]);
  const nn = await login('nonum.wn@tl-sink.local', 'recruiter');
  assert.deepEqual((await nn.get('/api/whatsapp/my-numbers')).body.numbers, []);
  const none = await nn.post('/api/whatsapp/send', { templateId: tpl, candidateIds: ['c_wn1'], sendKey: 'wn-send-key-0004' });
  assert.equal(none.status, 403);
  assert.equal(none.body.error.code, 'NO_WHATSAPP_NUMBER');
  assert.match(none.body.error.message, /No WhatsApp number is assigned to you/);
  // the older free-text bulk path is held to the same rule
  const old = await nn.post('/api/candidates/bulk-message', { channel: 'whatsapp', candidateIds: ['c_wn1'], body: 'hi' });
  assert.equal(old.status, 403);
  assert.equal(old.body.error.code, 'NO_WHATSAPP_NUMBER');
});

test('several numbers: the sender must choose unless one is their default; the default can be changed', async () => {
  const tpl = globalThis.__tpl;
  await admin.put(`/api/admin/whatsapp-numbers/${bId}/access`, { departments: ['BDE'], userIds: [itUser, medUser], openToAll: false });
  const mine = (await recMed.get('/api/whatsapp/my-numbers')).body.numbers.map((n) => n.id).sort();
  assert.deepEqual(mine, [aId, bId].sort());
  graph.clear();
  const ask = await recMed.post('/api/whatsapp/send', { templateId: tpl, candidateIds: ['c_wn2'], sendKey: 'wn-send-key-0005' });
  assert.equal(ask.status, 409);
  assert.equal(ask.body.error.code, 'CHOOSE_WHATSAPP_NUMBER');
  assert.equal(graph.sent.length, 0);
  // the primary is the default, but Meena cannot use it: the default only counts among HER numbers
  await admin.post(`/api/admin/whatsapp-numbers/${bId}/default`, {});
  const list = (await admin.get('/api/admin/whatsapp-numbers')).body.numbers;
  assert.deepEqual(list.filter((n) => n.isDefault).map((n) => n.id), [bId], 'one default at a time');
  const r = await recMed.post('/api/whatsapp/send', { templateId: tpl, candidateIds: ['c_wn2'], sendKey: 'wn-send-key-0006', includeWarned: true, includeNotLooking: true });
  assert.ok([202, 200].includes(r.status), JSON.stringify(r.body));
  assert.equal(r.body.number.id, bId);
});

test('an incoming message is filed under the number it was sent to, answered from that number, and seen only by those who may use it', async () => {
  graph.clear();
  assert.equal(await webhook(inbound('111111', '919876500201', 'jobs in Nellore', 'wamid.in.A1'), 'app-secret-for-number-A'), 200, 'signed with number A\'s own app secret');
  assert.equal(await webhook(inbound(PRIMARY_PID, '919876500202', 'hello', 'wamid.in.P1')), 200, 'the primary, signed with the global secret');
  assert.equal(await webhook(inbound('111111', '919876500201', 'x', 'wamid.in.bad'), 'not-the-secret'), 403);
  assert.equal(await webhook(inbound('999999', '919876500203', 'who', 'wamid.in.U1')), 200);
  await wait(1500);
  const rowsA = (await raw(`select direction, contact, body, kind from whatsapp_messages where number_id = $1 order by id`, [aId])).rows;
  assert.deepEqual(rowsA.map((r) => [r.direction, r.contact]), [['in', '919876500201'], ['out', '919876500201']]);
  assert.equal(rowsA[0].body, 'jobs in Nellore');
  assert.equal(rowsA[1].kind, 'agent_reply');
  const rowsP = (await raw(`select direction, contact from whatsapp_messages where number_id = 'wan_primary' order by id`)).rows;
  assert.equal(rowsP[0].contact, '919876500202');
  assert.equal((await raw(`select count(*)::int n from whatsapp_messages where contact = '919876500203'`)).rows[0].n, 0, 'an event for an unknown number is ignored');
  // the reply to A's message went out through A, to the right person
  const replyA = graph.sent.find((m) => m.body.to === '919876500201' && m.body.type === 'text');
  assert.deepEqual([replyA.pid, replyA.auth], ['111111', TOK_A]);
  const replyP = graph.sent.find((m) => m.body.to === '919876500202');
  assert.deepEqual([replyP.pid, replyP.auth], [PRIMARY_PID, META[PRIMARY_PID].token]);

  // conversations are separate per number, and only for people who may use that number
  const ca = await recMed.get(`/api/whatsapp/conversations?numberId=${aId}`);
  assert.equal(ca.status, 200);
  assert.ok(ca.body.contacts.some((c) => c.contact === '919876500201' && c.received === 1));
  assert.ok(!ca.body.contacts.some((c) => c.contact === '919876500202'), 'the primary\'s contact is not in A\'s conversations');
  assert.equal((await recIt.get(`/api/whatsapp/conversations?numberId=${aId}`)).status, 403);
  const th = (await recMed.get(`/api/whatsapp/conversations/${aId}/919876500201`)).body.thread;
  assert.ok(th.some((m) => m.direction === 'in' && m.text === 'jobs in Nellore') && th.some((m) => m.direction === 'out' && m.kind === 'agent_reply'));
  assert.ok(th.some((m) => m.kind === 'template' && /Hello Asha/.test(m.text)), 'the template message sent from A is in the same conversation');
  assert.equal((await recIt.get(`/api/whatsapp/conversations/${aId}/919876500201`)).status, 403);
  const pc = await admin.get('/api/whatsapp/conversations?numberId=wan_primary');
  assert.ok(pc.body.contacts.some((c) => c.contact === '919876500202'));
  // the admin's table counts them
  const n = (await admin.get('/api/admin/whatsapp-numbers')).body.numbers.find((x) => x.id === aId);
  assert.ok(n.messagesIn >= 1 && n.messagesOut >= 1);
});

test('the Meta webhook handshake accepts the global token or any number\'s own verify token', async () => {
  const num = (await admin.get('/api/admin/whatsapp-numbers')).body.numbers.find((n) => n.id === aId);
  const get = async (token) => fetch(`${base}/api/whatsapp-agent/webhook?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(token)}&hub.challenge=777`);
  const own = await get(num.webhookVerifyToken); assert.equal(own.status, 200); assert.equal(await own.text(), '777');
  assert.equal((await get('global-verify')).status, 200);
  assert.equal((await get('nope')).status, 403);
});

test('deactivate blocks sending; activate restores it; remove frees the number; every change is in the audit log', async () => {
  const tpl = globalThis.__tpl;
  assert.equal((await recMed.post('/api/whatsapp/send', { templateId: tpl, candidateIds: ['c_wn1'], sendKey: 'wn-send-key-0007', numberId: aId, includeWarned: true, includeNotLooking: true })).status === 403, false, 'sanity: allowed while active');
  assert.equal((await admin.post(`/api/admin/whatsapp-numbers/${aId}/active`, { active: false })).body.number.active, false);
  assert.ok(!(await recMed.get('/api/whatsapp/my-numbers')).body.numbers.some((n) => n.id === aId));
  const blocked = await recMed.post('/api/whatsapp/send', { templateId: tpl, candidateIds: ['c_wn2'], sendKey: 'wn-send-key-0008', numberId: aId });
  assert.equal(blocked.status, 403);
  // a deactivated number cannot be the default; the primary cannot be deactivated or removed
  assert.equal((await admin.post(`/api/admin/whatsapp-numbers/${aId}/default`, {})).status, 422);
  assert.equal((await admin.post('/api/admin/whatsapp-numbers/wan_primary/active', { active: false })).status, 422);
  assert.equal((await admin.del('/api/admin/whatsapp-numbers/wan_primary')).status, 422);
  assert.equal((await admin.post(`/api/admin/whatsapp-numbers/${aId}/active`, { active: true })).body.number.active, true);

  // edit: the display name changes, the token stays when left blank
  const ed = await admin.put(`/api/admin/whatsapp-numbers/${aId}`, { displayName: 'Medical Hiring (renamed)', phoneNumberId: '111111', accessToken: '' });
  assert.equal(ed.status, 200, JSON.stringify(ed.body));
  assert.equal(ed.body.number.displayName, 'Medical Hiring (renamed)');
  assert.ok(ed.body.number.hasToken);
  graph.clear();
  const again = await recMed.post('/api/whatsapp/send', { templateId: tpl, candidateIds: ['c_wn2'], sendKey: 'wn-send-key-0009', numberId: aId, includeWarned: true, includeNotLooking: true });
  assert.ok([200, 202].includes(again.status), JSON.stringify(again.body));
  await drain();
  assert.equal(graph.sent.at(-1)?.auth, TOK_A, 'still sends with the saved token');

  assert.equal((await admin.del(`/api/admin/whatsapp-numbers/${bId}`)).status, 200);
  assert.ok(!(await admin.get('/api/admin/whatsapp-numbers')).body.numbers.some((n) => n.id === bId));
  assert.equal((await recIt.post('/api/whatsapp/send', { templateId: tpl, candidateIds: ['c_wn2'], sendKey: 'wn-send-key-0010', numberId: bId })).status, 403);
  // the same Meta number can be added again after removal
  const re = await admin.post('/api/admin/whatsapp-numbers', { displayName: 'Education again', phoneNumberId: '444444', businessAccountId: '9000001', accessToken: TOK_B });
  assert.equal(re.status, 201); assert.equal(re.body.number.status, 'connected');

  const actions = (await raw(`select action from audit_log where entity = 'whatsapp_number'`)).rows.map((r) => r.action);
  for (const a of ['whatsapp_number.created', 'whatsapp_number.verified', 'whatsapp_number.reconnected', 'whatsapp_number.assigned', 'whatsapp_number.default',
    'whatsapp_number.deactivated', 'whatsapp_number.activated', 'whatsapp_number.updated', 'whatsapp_number.removed']) {
    assert.ok(actions.includes(a), `audit log has ${a}: ${[...new Set(actions)].join(', ')}`);
  }
});

test('conversations: the inbox, what is waiting for a reply, and a reply from the portal inside the 24-hour window', async () => {
  // a fresh inbound on A (the earlier one was answered by the assistant, which does not count as a person replying)
  assert.equal(await webhook(inbound('111111', '919876500201', 'Is the walk-in tomorrow?', 'wamid.in.A2'), 'app-secret-for-number-A'), 200);
  await wait(1200);
  const inbox = (await recMed.get('/api/whatsapp/conversations')).body.contacts;
  const mine = inbox.find((c) => c.contact === '919876500201' && c.numberId === aId);
  assert.ok(mine, JSON.stringify(inbox));
  assert.equal(mine.needsReply, true);
  assert.equal(mine.windowOpen, true);
  assert.ok(!inbox.some((c) => c.numberId === 'wan_primary'), 'the inbox lists only the numbers this person may use');
  assert.equal((await recIt.get('/api/whatsapp/conversations')).body.contacts.filter((c) => c.numberId === aId).length, 0);
  const th = (await recMed.get(`/api/whatsapp/conversations/${aId}/919876500201`)).body;
  assert.equal(th.window.open, true);
  assert.equal(th.candidate.name, 'Asha Candidate');

  // reply: plain text, from number A, with number A's token
  graph.clear();
  const rep = await recMed.post(`/api/whatsapp/conversations/${aId}/919876500201/reply`, { text: 'Yes - 10 AM at our Nellore office.' });
  assert.equal(rep.status, 201, JSON.stringify(rep.body));
  assert.equal(graph.sent.length, 1);
  assert.deepEqual([graph.sent[0].pid, graph.sent[0].auth, graph.sent[0].body.type, graph.sent[0].body.to], ['111111', TOK_A, 'text', '919876500201']);
  assert.equal(graph.sent[0].body.text.body, 'Yes - 10 AM at our Nellore office.');
  const after = (await recMed.get(`/api/whatsapp/conversations/${aId}/919876500201`)).body.thread;
  assert.ok(after.some((m) => m.direction === 'out' && m.text.startsWith('Yes - 10 AM') && m.by === 'Meena Medical'), JSON.stringify(after.slice(-3)));
  const inbox2 = (await recMed.get('/api/whatsapp/conversations')).body.contacts.find((c) => c.contact === '919876500201');
  assert.equal(inbox2.needsReply, false, 'answered');

  // a person who may not use the number cannot read or reply
  assert.equal((await recIt.post(`/api/whatsapp/conversations/${aId}/919876500201/reply`, { text: 'hi' })).status, 403);
  assert.equal((await recMed.post(`/api/whatsapp/conversations/${aId}/919876500201/reply`, { text: '   ' })).status, 400);

  // outside the window only a template is allowed
  const none = await recMed.post(`/api/whatsapp/conversations/${aId}/919876500999/reply`, { text: 'hello' });
  assert.equal(none.status, 409); assert.equal(none.body.error.code, 'WINDOW_CLOSED');
  await raw(`update whatsapp_messages set created_at = now() - interval '25 hours' where number_id = $1 and contact = '919876500201'`, [aId]);
  const old = await recMed.post(`/api/whatsapp/conversations/${aId}/919876500201/reply`, { text: 'late' });
  assert.equal(old.status, 409); assert.equal(old.body.error.code, 'WINDOW_CLOSED');
  const closed = (await recMed.get(`/api/whatsapp/conversations/${aId}/919876500201`)).body;
  assert.equal(closed.window.open, false);

  // STOP closes the conversation for free text
  assert.equal(await webhook(inbound(PRIMARY_PID, '919876500202', 'STOP', 'wamid.in.P2')), 200);
  await wait(800);
  const stopped = await admin.post('/api/whatsapp/conversations/wan_primary/919876500202/reply', { text: 'one more thing' });
  assert.equal(stopped.status, 409); assert.equal(stopped.body.error.code, 'OPTED_OUT');
});

test('the whole conversation is on the candidate\'s profile too: what we sent, what they wrote back, and which number', async () => {
  const m = (await recMed.get('/api/candidates/c_wn1/messages')).body.messages;
  const inb = m.find((x) => x.direction === 'in' && /walk-in tomorrow/.test(x.body));
  assert.ok(inb, JSON.stringify(m.map((x) => [x.channel, x.direction, x.body.slice(0, 30)])));
  assert.equal(inb.status, 'received');
  assert.match(inb.numberName, /Medical Hiring/);
  assert.ok(m.some((x) => !x.direction && /Hello Asha/.test(x.body)), 'the template that was sent is still listed');
  assert.ok(m.some((x) => x.direction === 'out' && /10 AM/.test(x.body) && x.by === 'Meena Medical'), 'and the reply sent from the portal');
  const ts = m.map((x) => new Date(x.sentAt || x.queuedAt).getTime());
  assert.deepEqual(ts, [...ts].sort((a, b) => b - a), 'newest first');
  // somebody who may not use that number does not see what came in on it
  assert.ok(!(await recIt.get('/api/candidates/c_wn1/messages')).body.messages.some((x) => x.direction === 'in'));
});

test('shutdown', async () => {
  await new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
  await graph.stop();
  await dbh.stop();
});
