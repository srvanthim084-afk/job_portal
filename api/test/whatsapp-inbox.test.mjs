/**
 * The WhatsApp Inbox (0161): replies to campaigns arrive by themselves, matched to the campaign, unread until opened, kept per recruiter,
 * answered through the right number, with real delivery status.
 *
 *   - a campaign message and the reply to it are in ONE conversation; a reply is tied to the campaign only when that can be told (it answers
 *     one of its messages = "reply"; else the contact's most recent campaign message = "recent"; a stranger = none) and the assistant stays out of it
 *   - a retried webhook event is the same message (saved once, answered once)
 *   - unread is per person; opening a conversation reads it for that person only
 *   - a conversation belongs to the recruiter who ran the campaign: colleagues on the same number do not see it, an administrator does and can reassign it
 *   - replies go out through the conversation's number, inside the 24-hour window; a double send is one send; a refusal is shown as Failed
 *   - ticks follow Meta's receipts and never move backwards; photos and documents both ways; filters; and a live event reaches an open inbox
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { startTestDb, applyTestEnv, makeClient } from './harness.mjs';

const DB_PORT = 5706;
const API_PORT = 9979;
const WA_PORT = 9980;
const base = `http://127.0.0.1:${API_PORT}`;
const PW = 'WaInbox#2026xyz';
const SECRET = 'inbox-app-secret-for-tests';
const TOK_A = 'token-for-number-A-aaaaaaaaaaaaaaaa';
const PID_A = '111111';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082', 'hex');

let dbh, server, raw, graph, admin, recMed, recMed2, recIt, drainQueue, aId, medU, med2U, tplId;

function startMockGraph(port) {
  const sent = [];
  const refuse = new Set();
  let counter = 0;
  const srv = createServer((req, res) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      const u = new URL(req.url, 'http://x');
      const parts = u.pathname.split('/').filter(Boolean);
      const auth = String(req.headers.authorization || '').replace('Bearer ', '');
      const json = (code, o) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
      if (parts[0] === 'files') { res.setHeader('content-type', 'image/png'); res.end(PNG); return; }
      if (auth !== TOK_A) return json(401, { error: { message: 'Invalid OAuth access token.' } });
      if (req.method === 'GET' && parts[1] && parts[1].startsWith('mid')) return json(200, { url: `http://127.0.0.1:${port}/files/${parts[1]}`, mime_type: 'image/png' });
      if (req.method === 'GET') return json(200, { id: parts[1], display_phone_number: '+91 98765 11111', verified_name: 'Medical Hiring', code_verification_status: 'VERIFIED' });
      if (parts[2] === 'media') { sent.push({ pid: parts[1], upload: true, size: buf.length, type: String(req.headers['content-type'] || '').slice(0, 20) }); return json(200, { id: `up${++counter}` }); }
      const body = JSON.parse(buf.toString() || '{}');
      sent.push({ pid: parts[1], auth, body });
      if (refuse.has(String(body.to))) return json(400, { error: { message: '(#131047) Re-engagement message: more than 24 hours have passed' } });
      return json(200, { messages: [{ id: `wamid.out.${++counter}` }] });
    });
  });
  return new Promise((r) => srv.listen(port, '127.0.0.1', () => r({
    sent, refuse, clear() { sent.length = 0; }, stop: () => new Promise((x) => { srv.closeAllConnections?.(); srv.close(x); }),
  })));
}

async function staff(email, role, id, dept) {
  const { hashPassword } = await import('../src/auth.js');
  const u = (await raw(`insert into users (email, password_hash, role) values ($1, $2, $3) returning id`, [email, await hashPassword(PW), role])).rows[0].id;
  if (role === 'recruiter') await raw(`insert into recruiters (id, user_id, name, email, company_id, department) values ($1,$2,$3,$4,'co_ib',$5)`, [id, u, `Rec ${id}`, email, dept]);
  else await raw(`insert into admins (id, user_id, name, email) values ($1,$2,'Admin IB',$3)`, [id, u, email]);
  const c = makeClient(base); await c.get('/api/health');
  assert.equal((await c.post('/api/auth/login', { email, password: PW, role })).status, 200);
  return { c, u };
}
const drain = async () => { for (let i = 0; i < 20; i += 1) { const o = await drainQueue({ limit: 50 }); if (!o.claimed) break; } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const sign = (s) => `sha256=${createHmac('sha256', SECRET).update(s).digest('hex')}`;
async function webhook(value) {
  const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ value }] }] });
  return (await fetch(`${base}/api/whatsapp-agent/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) }, body })).status;
}
const inbound = (from, msg, name = 'Contact') => webhook({ metadata: { phone_number_id: PID_A }, contacts: [{ wa_id: from, profile: { name } }], messages: [{ from, ...msg }] });
const receipt = (id, status, extra = {}) => webhook({ metadata: { phone_number_id: PID_A }, statuses: [{ id, status, timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: 'x', ...extra }] });
const list = async (c, qs = '') => (await c.get('/api/whatsapp/inbox/conversations' + qs)).body.conversations;
const byContact = (rows, contact) => rows.find((r) => r.contact === contact);
const C1 = '919876500301', C2 = '919876500302', C3 = '919876500303', STRANGER = '919876500399';
let convC1, convC2, campaignBatch, firstWamid;

test('boot', async () => {
  dbh = await startTestDb(DB_PORT);
  graph = await startMockGraph(WA_PORT);
  applyTestEnv(dbh.url, {
    PUBLIC_ORIGIN: base, DISABLE_BACKGROUND_WORK: 'true', OUTBOUND_ALLOWLIST: '',
    WHATSAPP_API_KEY: 'primary-token-for-tests-pppppppp', WHATSAPP_PHONE_ID: '555000111', WHATSAPP_API_URL: `http://127.0.0.1:${WA_PORT}/v21.0`,
    WHATSAPP_APP_SECRET: SECRET, WHATSAPP_VERIFY_TOKEN: 'v', WHATSAPP_CHAT_RATE_MAX: '1000',
  });
  raw = (sql, params) => dbh.db.query(sql, params);
  await raw(`insert into companies (id, name) values ('co_ib', 'Inbox Co')`);
  const { createApp } = await import('../src/app.js');
  ({ drainQueue } = await import('../src/notify/bulk.js'));
  const app = createApp({ logger: { error() {}, log() {} } });
  await new Promise((r) => { server = app.listen(API_PORT, r); });
  await wait(1500);
  process.env.INTEGRATION_SECRET_KEY = 'a-long-test-passphrase-for-sealing-secrets';
  ({ c: admin } = await staff('admin.ib@tl-sink.local', 'admin', 'a_ib'));
  ({ c: recMed, u: medU } = await staff('med.ib@tl-sink.local', 'recruiter', 'r_ibm', 'Medical'));
  ({ c: recMed2, u: med2U } = await staff('med2.ib@tl-sink.local', 'recruiter', 'r_ibm2', 'Medical'));
  ({ c: recIt } = await staff('it.ib@tl-sink.local', 'recruiter', 'r_ibi', 'IT'));
  const n = await admin.post('/api/admin/whatsapp-numbers', { displayName: 'Medical Hiring', phoneNumberId: PID_A, businessAccountId: '9000001', accessToken: TOK_A });
  assert.equal(n.status, 201, JSON.stringify(n.body));
  aId = n.body.number.id;
  await admin.put(`/api/admin/whatsapp-numbers/${aId}/access`, { departments: ['Medical'], userIds: [], openToAll: false });
  await admin.put('/api/admin/whatsapp-numbers/wan_primary/access', { departments: [], userIds: [], openToAll: false });
  await raw(`insert into candidates (id, name, email, phone, location, whatsapp_opt_in) values
             ('c_ib1','Asha One','a1@tl-sink.local','9876500301','Nellore',true), ('c_ib2','Bhanu Two','a2@tl-sink.local','9876500302','Nellore',true)`);
  await raw(`insert into jobs (id, title, company_id, location, mode, exp_label, skills, status, recruiter_id, description, published_at)
             values ('j_ib','Staff Nurse','co_ib','Nellore','Onsite','1-3 yrs','{ICU}','open','r_ibm','x',now())`);
  await raw(`insert into applications (id, job_id, candidate_id, recruiter_id, stage) values ('ap_ib1','j_ib','c_ib1','r_ibm','applied'),('ap_ib2','j_ib','c_ib2','r_ibm','applied')`);
  const t = await admin.post('/api/whatsapp/templates', { name: 'Nurse promo', waName: 'nurse_promo', language: 'en', waStatus: 'approved', body: 'Hello {{candidate_name}}, we have nursing jobs. Interested?' });
  assert.equal(t.status, 201, JSON.stringify(t.body));
  tplId = t.body.template.id;
});

test('a campaign is sent; its messages are in the Inbox, assigned to the recruiter who ran it', async () => {
  graph.clear();
  const r = await recMed.post('/api/whatsapp/send', { templateId: tplId, candidateIds: ['c_ib1', 'c_ib2'], sendKey: 'ib-send-key-0001', campaignName: 'Nurse promo - October' });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  campaignBatch = r.body.batchId;
  await drain();
  assert.equal(graph.sent.filter((m) => m.body && m.body.type === 'template').length, 2);
  const rows = await list(recMed);
  const a = byContact(rows, C1), b = byContact(rows, C2);
  assert.ok(a && b, JSON.stringify(rows));
  convC1 = a.id; convC2 = b.id;
  assert.equal(a.assignee.id, medU);
  assert.deepEqual([a.campaign.name, a.campaign.batchId], ['Nurse promo - October', campaignBatch]);
  assert.equal(a.lastDirection, 'out');
  assert.equal(a.lastStatus, 'sent');
  assert.equal(a.unread, 0);
  assert.equal(a.needsReply, false);
  firstWamid = (await raw(`select wa_message_id from whatsapp_messages where conversation_id = $1`, [convC1])).rows[0].wa_message_id;
  assert.match(firstWamid, /^wamid\.out\./);
});

test('a reply to the campaign arrives by itself: saved, unread, matched to the campaign, and not answered by the assistant', async () => {
  graph.clear();
  // Asha answers THE campaign message (WhatsApp names it in context.id)
  assert.equal(await inbound(C1, { id: 'wamid.in.1', type: 'text', text: { body: 'Yes, interested!' }, context: { id: firstWamid } }, 'Asha'), 200);
  // Bhanu just writes (no context): most likely the campaign
  assert.equal(await inbound(C2, { id: 'wamid.in.2', type: 'text', text: { body: 'Tell me more' } }, 'Bhanu'), 200);
  // somebody nobody wrote to
  assert.equal(await inbound(STRANGER, { id: 'wamid.in.3', type: 'text', text: { body: 'jobs in Nellore' } }, 'Stranger'), 200);
  await wait(1800);
  const rows = await list(recMed);
  const a = byContact(rows, C1), b = byContact(rows, C2), s = byContact(rows, STRANGER);
  assert.deepEqual([a.unread, a.needsReply, a.lastDirection, a.lastText], [1, true, 'in', 'Yes, interested!']);
  assert.deepEqual([a.campaign.name, a.campaign.match], ['Nurse promo - October', 'reply']);
  assert.deepEqual([b.campaign.name, b.campaign.match], ['Nurse promo - October', 'recent']);
  assert.equal(a.name, 'Asha One', 'the candidate\'s own name');
  assert.ok(s, 'the stranger writes to the number the Medical team uses, so the team sees it');
  assert.equal(s.campaign, null, 'a message nobody can tie to a campaign is not called a campaign reply');
  assert.equal(s.assignee, null);
  // the assistant answered the stranger only
  assert.equal(graph.sent.filter((m) => m.body.to === C1).length, 0);
  assert.equal(graph.sent.filter((m) => m.body.to === C2).length, 0);
  assert.ok(graph.sent.some((m) => m.body.to === STRANGER && m.body.type === 'text'));
  // the thread shows the campaign and the message that was answered
  const t = (await recMed.get(`/api/whatsapp/inbox/conversations/${convC1}`)).body;
  assert.equal(t.campaignContext.name, 'Nurse promo - October');
  assert.match(t.campaignContext.originalMessage, /Hello Asha One/);
  assert.equal(t.messages.at(-1).replyTo.text.startsWith('Hello Asha One'), true, 'the reply is shown under the message it answers');
  assert.equal(t.window.open, true);
});

test('a retried webhook event is the same message: saved once, answered once', async () => {
  graph.clear();
  assert.equal(await inbound(C1, { id: 'wamid.in.1', type: 'text', text: { body: 'Yes, interested!' }, context: { id: firstWamid } }, 'Asha'), 200);
  assert.equal(await inbound(STRANGER, { id: 'wamid.in.3', type: 'text', text: { body: 'jobs in Nellore' } }, 'Stranger'), 200);
  await wait(800);
  assert.equal((await raw(`select count(*)::int n from whatsapp_messages where wa_message_id in ('wamid.in.1','wamid.in.3')`)).rows[0].n, 2);
  assert.equal(graph.sent.length, 0);
  assert.equal(byContact(await list(recMed), C1).unread, 1);
});

test('unread is per person: opening a conversation reads it for you only; the header summary follows', async () => {
  const before = (await recMed.get('/api/whatsapp/inbox/summary')).body;
  assert.equal(before.unread, 3);
  assert.equal(before.waiting, 3);
  assert.equal((await recMed.post(`/api/whatsapp/inbox/conversations/${convC1}/read`, {})).status, 200);
  assert.equal(byContact(await list(recMed), C1).unread, 0);
  assert.equal(byContact(await list(admin), C1).unread, 1, 'the administrator has not opened it');
  assert.equal((await recMed.get('/api/whatsapp/inbox/summary')).body.unread, 2);
  assert.equal((await list(recMed, '?unread=1')).length, 2);
  // a new message makes it unread again
  assert.equal(await inbound(C1, { id: 'wamid.in.4', type: 'text', text: { body: 'What salary?' }, context: { id: firstWamid } }, 'Asha'), 200);
  await wait(900);
  assert.equal(byContact(await list(recMed), C1).unread, 1);
  assert.equal(byContact(await list(recMed), C1).lastText, 'What salary?');
});

test('a conversation belongs to the recruiter who ran the campaign: a colleague on the same number, or another team, does not see it', async () => {
  const med2 = await list(recMed2);
  assert.deepEqual(med2.map((c) => c.contact), [STRANGER], 'only what nobody owns');
  assert.equal((await recMed2.get(`/api/whatsapp/inbox/conversations/${convC1}`)).status, 404);
  assert.equal((await recMed2.post(`/api/whatsapp/inbox/conversations/${convC1}/messages`, { text: 'hi' })).status, 404);
  assert.equal((await recMed2.get(`/api/whatsapp/inbox/conversations/${convC1}/media/1`)).status, 404);
  assert.deepEqual(await list(recIt), [], 'a team with no access to the number sees nothing');
  assert.equal((await list(admin)).length, 3);
  assert.equal((await recMed.put(`/api/whatsapp/inbox/conversations/${convC1}/assign`, { userId: med2U })).status, 403, 'only an administrator assigns');
});

test('an administrator reassigns a conversation; the history goes with it; unassigning returns it to the number\'s team', async () => {
  const r = await admin.put(`/api/whatsapp/inbox/conversations/${convC1}/assign`, { userId: med2U });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.conversation.assignee.id, med2U);
  assert.equal((await recMed.get(`/api/whatsapp/inbox/conversations/${convC1}`)).status, 404, 'the first recruiter no longer sees it');
  const t = (await recMed2.get(`/api/whatsapp/inbox/conversations/${convC1}`)).body;
  assert.ok(t.messages.some((m) => /Hello Asha One/.test(m.text)) && t.messages.some((m) => m.text === 'Yes, interested!'), 'the whole history moved with it');
  assert.equal(t.conversation.campaign.name, 'Nurse promo - October');
  assert.equal((await admin.put(`/api/whatsapp/inbox/conversations/${convC1}/assign`, { userId: '00000000-0000-0000-0000-000000000000' })).status, 422);
  // back to the first recruiter
  await admin.put(`/api/whatsapp/inbox/conversations/${convC1}/assign`, { userId: medU });
  assert.equal((await recMed.get(`/api/whatsapp/inbox/conversations/${convC1}`)).status, 200);
  // unassigned: the team on that number sees it
  await admin.put(`/api/whatsapp/inbox/conversations/${convC2}/assign`, { userId: null });
  assert.ok(byContact(await list(recMed2), C2));
  assert.ok((await raw(`select 1 from audit_log where action = 'whatsapp_conversation.assigned'`)).rows.length >= 3);
  await admin.put(`/api/whatsapp/inbox/conversations/${convC2}/assign`, { userId: medU });
});

test('a reply from the portal goes out through the conversation\'s number, once, and shows as sent', async () => {
  graph.clear();
  const body = { text: 'Great - the salary is 25,000 plus food. Can you come on Monday?', clientKey: 'key-reply-1' };
  const r = await recMed.post(`/api/whatsapp/inbox/conversations/${convC1}/messages`, body);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const again = await recMed.post(`/api/whatsapp/inbox/conversations/${convC1}/messages`, body);
  assert.equal(again.status, 200);
  assert.equal(again.body.duplicate, true);
  assert.equal(graph.sent.length, 1, 'a double click is one message');
  assert.deepEqual([graph.sent[0].pid, graph.sent[0].auth, graph.sent[0].body.type, graph.sent[0].body.to], [PID_A, TOK_A, 'text', C1]);
  const t = (await recMed.get(`/api/whatsapp/inbox/conversations/${convC1}`)).body;
  const mine = t.messages.at(-1);
  assert.deepEqual([mine.direction, mine.status, mine.by, mine.text.startsWith('Great')], ['out', 'sent', 'Rec r_ibm', true]);
  assert.equal(byContact(await list(recMed), C1).needsReply, false);
});

test('delivery receipts move the ticks sent -> delivered -> read, never backwards; a refusal shows as failed', async () => {
  const wamid = (await raw(`select wa_message_id from whatsapp_messages where conversation_id = $1 and kind = 'reply'`, [convC1])).rows[0].wa_message_id;
  const status = async () => (await recMed.get(`/api/whatsapp/inbox/conversations/${convC1}`)).body.messages.find((m) => m.status && m.text.startsWith('Great')).status;
  assert.equal(await receipt(wamid, 'delivered'), 200); await wait(500);
  assert.equal(await status(), 'delivered');
  assert.equal(await receipt(wamid, 'read'), 200); await wait(500);
  assert.equal(await status(), 'read');
  assert.equal(await receipt(wamid, 'delivered'), 200); await wait(300);
  assert.equal(await status(), 'read', 'an old receipt arriving late changes nothing');
  assert.equal(await receipt(wamid, 'failed', { errors: [{ title: 'late' }] }), 200); await wait(300);
  assert.equal(await status(), 'read');
  assert.equal(byContact(await list(recMed), C1).lastStatus, 'read');
  // the campaign message itself (sent from the queue) ticks too
  assert.equal(await receipt(firstWamid, 'delivered'), 200); await wait(500);
  assert.equal((await recMed.get(`/api/whatsapp/inbox/conversations/${convC1}`)).body.messages[0].status, 'delivered');

  // WhatsApp refuses a reply: it is kept, as Failed, with the reason
  graph.refuse.add(C2);
  const bad = await recMed.post(`/api/whatsapp/inbox/conversations/${convC2}/messages`, { text: 'Hello?' });
  assert.equal(bad.status, 502);
  assert.match(bad.body.error.message, /131047/);
  const t = (await recMed.get(`/api/whatsapp/inbox/conversations/${convC2}`)).body.messages.at(-1);
  assert.deepEqual([t.status, t.text], ['failed', 'Hello?']);
  assert.match(t.error, /131047/);
  graph.refuse.clear();
});

test('replies are free text only inside the 24-hour window, and not after STOP or for a do-not-contact candidate', async () => {
  await raw(`update whatsapp_conversations set last_inbound_at = now() - interval '25 hours' where id = $1`, [convC2]);
  const closed = await recMed.post(`/api/whatsapp/inbox/conversations/${convC2}/messages`, { text: 'late' });
  assert.equal(closed.status, 409); assert.equal(closed.body.error.code, 'WINDOW_CLOSED');
  assert.equal((await recMed.get(`/api/whatsapp/inbox/conversations/${convC2}`)).body.window.open, false);
  assert.equal(byContact(await list(recMed), C2).windowOpen, false);
  assert.equal((await recMed.post(`/api/whatsapp/inbox/conversations/${convC1}/messages`, { text: '   ' })).status, 400);
  await raw(`update candidates set do_not_contact = true where id = 'c_ib1'`);
  const dnc = await recMed.post(`/api/whatsapp/inbox/conversations/${convC1}/messages`, { text: 'hello' });
  assert.equal(dnc.status, 409); assert.equal(dnc.body.error.code, 'DO_NOT_CONTACT');
  await raw(`update candidates set do_not_contact = false where id = 'c_ib1'`);
  assert.equal(await inbound(C1, { id: 'wamid.in.5', type: 'text', text: { body: 'STOP' } }, 'Asha'), 200); await wait(900);
  const stop = await recMed.post(`/api/whatsapp/inbox/conversations/${convC1}/messages`, { text: 'one more' });
  assert.equal(stop.status, 409); assert.equal(stop.body.error.code, 'OPTED_OUT');
  assert.equal(await inbound(C1, { id: 'wamid.in.6', type: 'text', text: { body: 'START' } }, 'Asha'), 200); await wait(700);
});

test('photos and documents: what a contact sends is shown to those who may see it; files can be sent back', async () => {
  assert.equal(await inbound(C1, { id: 'wamid.in.7', type: 'image', image: { id: 'mid-photo-1', mime_type: 'image/png', caption: 'my certificate' } }, 'Asha'), 200); await wait(900);
  const t = (await recMed.get(`/api/whatsapp/inbox/conversations/${convC1}`)).body;
  const img = t.messages.find((m) => m.media && m.media.type === 'image');
  assert.equal(img.text, 'my certificate');
  assert.equal(img.media.mime, 'image/png');
  const f = await fetch(`${base}/api/whatsapp/inbox/media/${img.id}`, { headers: { cookie: [...recMed.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ') } });
  assert.equal(f.status, 200);
  assert.equal(f.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await f.arrayBuffer()), PNG);
  assert.equal((await fetch(`${base}/api/whatsapp/inbox/media/${img.id}`, { headers: { cookie: [...recMed2.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ') } })).status, 404, 'not for somebody who cannot see the conversation');

  const post = (c, qs, buf, mime) => fetch(`${base}/api/whatsapp/inbox/conversations/${convC1}/media${qs}`, { method: 'POST',
    headers: { cookie: [...c.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; '), 'x-csrf-token': c.jar.get('tl_csrf'), 'content-type': mime }, body: buf });
  graph.clear();
  const ok = await post(recMed, '?filename=offer.png&caption=Your%20offer', PNG, 'image/png');
  assert.equal(ok.status, 201, await ok.text());
  assert.ok(graph.sent.some((m) => m.upload), 'uploaded to WhatsApp');
  const msg = graph.sent.find((m) => m.body && m.body.type === 'image');
  assert.deepEqual([msg.pid, msg.auth, msg.body.to, msg.body.image.caption], [PID_A, TOK_A, C1, 'Your offer']);
  const last = (await recMed.get(`/api/whatsapp/inbox/conversations/${convC1}`)).body.messages.at(-1);
  assert.deepEqual([last.direction, last.media.type, last.text], ['out', 'image', 'Your offer']);
  assert.equal((await post(recMed, '?filename=x.exe', Buffer.from('MZ'), 'application/x-msdownload')).status, 400, 'a file type WhatsApp does not take');
  assert.equal((await post(recMed, '?filename=big.png', Buffer.alloc(6 * 1024 * 1024, 1), 'image/png')).status, 400, 'over the photo limit');
  assert.equal((await post(recMed2, '?filename=a.png', PNG, 'image/png')).status, 404);
});

test('filters: campaign, recruiter, department, date, unread and reply status; search; the filter options are only what this person may see', async () => {
  const f = (await recMed.get('/api/whatsapp/inbox/filters')).body;
  assert.deepEqual(f.campaigns.map((c) => c.name), ['Nurse promo - October']);
  assert.ok(f.campaigns[0].replies >= 2);
  assert.equal(f.canAssign, false);
  assert.deepEqual(f.numbers.map((n) => n.id), [aId]);
  const fa = (await admin.get('/api/whatsapp/inbox/filters')).body;
  assert.equal(fa.canAssign, true);
  assert.ok(fa.staff.some((s) => s.userId === med2U) && fa.departments.includes('Medical'));

  assert.deepEqual((await list(recMed, `?campaign=${encodeURIComponent(campaignBatch)}`)).map((c) => c.contact).sort(), [C1, C2].sort());
  assert.deepEqual((await list(admin, `?assignee=${medU}`)).map((c) => c.contact).sort(), [C1, C2].sort());
  assert.deepEqual((await list(admin, '?assignee=none')).map((c) => c.contact), [STRANGER]);
  assert.equal((await list(admin, '?department=Medical')).length >= 2, true, 'by the department of whoever it is assigned to / the number\'s team');
  assert.equal((await list(admin, '?department=Manufacturing')).length, 0);
  assert.equal((await list(recMed, '?q=asha')).length, 1);
  assert.equal((await list(recMed, '?q=9876500301')).length, 1, 'by phone number');
  const tomorrow = new Date(Date.now() + 86400000 * 2).toISOString().slice(0, 10);
  assert.equal((await list(recMed, `?from=${tomorrow}`)).length, 0);
  assert.ok((await list(recMed, `?to=${tomorrow}`)).length >= 2);
  assert.ok((await list(recMed, '?reply=needs')).every((c) => c.needsReply));
  assert.ok((await list(recMed, '?reply=replied')).every((c) => !c.needsReply));
  assert.equal((await recMed.get('/api/whatsapp/inbox/conversations?assignee=not-a-uuid')).status, 400);
});

test('the Inbox is live: an event reaches an open inbox the moment a reply arrives - and carries no message text', async () => {
  const ac = new AbortController();
  const res = await fetch(`${base}/api/whatsapp/inbox/stream`, { headers: { cookie: [...recMed.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ') }, signal: ac.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const reader = res.body.getReader();
  let seen = '';
  const pump = (async () => { const dec = new TextDecoder(); try { for (;;) { const { value, done } = await reader.read(); if (done) break; seen += dec.decode(value); } } catch { /* closed */ } })();
  await wait(300);
  assert.equal(await inbound(C2, { id: 'wamid.in.8', type: 'text', text: { body: 'a very private sentence' } }, 'Bhanu'), 200);
  for (let i = 0; i < 30 && !/event: inbox/.test(seen); i += 1) await wait(100);
  ac.abort(); await pump.catch(() => {});
  assert.match(seen, /event: inbox/);
  assert.match(seen, /"type":"message"/);
  assert.ok(!seen.includes('private sentence'), 'an event never carries what was written');
  const anon = makeClient(base); await anon.get('/api/health');
  assert.equal((await anon.get('/api/whatsapp/inbox/summary')).status, 401);
});

test('the candidate profile and the admin screen see the same conversation', async () => {
  const m = (await recMed.get('/api/candidates/c_ib1/messages')).body.messages;
  assert.ok(m.some((x) => x.direction === 'in' && x.body === 'What salary?'));
  assert.ok(m.some((x) => x.direction === 'out' && /25,000/.test(x.body)));
  assert.ok(!(await recMed2.get('/api/candidates/c_ib1/messages')).body.messages.some((x) => x.direction === 'in'), 'a colleague who may not see the conversation does not see it here either');
});

test('shutdown', async () => {
  await new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
  await graph.stop();
  await dbh.stop();
});
