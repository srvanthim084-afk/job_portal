/**
 * WhatsApp template sending (0158): approved Business templates, a personalised message per candidate, the queue, retry and receipts.
 *
 * Meta's Graph API is NEVER called: WHATSAPP_API_URL points at a local server that answers like it (and refuses chosen numbers).
 *
 *   - only an administrator creates / edits / syncs templates; recruiters see only the ones that can be sent
 *   - the spec's example renders exactly: "Hello Rahul Kumar, ... position ... Shortlisted ..."
 *   - a candidate with no mobile number, no WhatsApp opt-in, a "do not contact" flag, or a missing field is not sent to - and is told why
 *   - the parameters sent to WhatsApp are each candidate's own, in the order the template expects
 *   - the same click twice sends once; a retry re-queues ONLY the failed messages
 *   - delivery receipts move sent -> delivered -> read; STOP opts a candidate out
 *   - a recruiter sees their own history, an administrator everyone's by recruiter; a second recruiter is held back by the cooldown
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { startTestDb, applyTestEnv, makeClient } from './harness.mjs';

const DB_PORT = 5703;
const API_PORT = 9973;
const WA_PORT = 9974;
const base = `http://127.0.0.1:${API_PORT}`;
const PW = 'WaSend#2026xyz';
const SECRET = 'wa-app-secret-for-tests';
const BIZ = 'BIZ777';

let dbh, server, raw, graph, admin, recA, recB, drainQueue;

function startMockGraph(port) {
  const sent = [];
  const refuse = new Set();
  let templates = [];
  const srv = createServer((req, res) => {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.method === 'GET' && /\/message_templates/.test(req.url)) { res.end(JSON.stringify({ data: templates })); return; }
      const body = JSON.parse(b || '{}');
      sent.push({ url: req.url, auth: req.headers.authorization, body });
      if (refuse.has(String(body.to))) { res.statusCode = 400; res.end(JSON.stringify({ error: { message: '(#131026) Message undeliverable' } })); return; }
      res.end(JSON.stringify({ messages: [{ id: `wamid.${sent.length}` }] }));
    });
  });
  return new Promise((r) => srv.listen(port, '127.0.0.1', () => r({
    sent, refuse, setTemplates(t) { templates = t; }, clear() { sent.length = 0; },
    stop: () => new Promise((x) => { srv.closeAllConnections?.(); srv.close(x); }),
  })));
}

async function staff(email, role, id, extra = {}) {
  const { hashPassword } = await import('../src/auth.js');
  const u = (await raw(`insert into users (email, password_hash, role) values ($1, $2, $3) returning id`, [email, await hashPassword(PW), role])).rows[0].id;
  if (role === 'recruiter') {
    await raw(`insert into recruiters (id, user_id, name, email, company_id, is_team_lead) values ($1,$2,$3,$4,'co_ws',$5)`,
      [id, u, extra.name || `Rec ${id}`, email, !!extra.teamLead]);
  } else {
    await raw(`insert into admins (id, user_id, name, email) values ($1,$2,'Admin WS',$3)`, [id, u, email]);
  }
  const c = makeClient(base);
  await c.get('/api/health');
  const r = await c.post('/api/auth/login', { email, password: PW, role });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return c;
}

async function candidate(id, name, phone, { optIn = true, dnc = false } = {}) {
  await raw(`insert into candidates (id, name, email, phone, location, whatsapp_opt_in, do_not_contact)
             values ($1,$2,$3,$4,'Nellore',$5,$6)`, [id, name, `${id}@tl-sink.local`, phone, optIn, dnc]);
}

const drain = async () => { for (let i = 0; i < 20; i += 1) { const o = await drainQueue({ limit: 50 }); if (!o.claimed) break; } };
const sign = (s) => `sha256=${createHmac('sha256', SECRET).update(s).digest('hex')}`;
async function webhook(payload) {
  const body = JSON.stringify(payload);
  const res = await fetch(`${base}/api/whatsapp-agent/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) }, body });
  return res.status;
}

const SPEC_BODY = 'Hello {{candidate_name}},\nWe reviewed your profile for the {{job_title}} position at TeamLink.\n'
  + 'Your application status is {{application_status}}.\nOur team will contact you with further details.\nThank you,\nTeamLink Recruitment Team';
const specTemplate = (over = {}) => ({
  name: 'Profile review update', waName: 'profile_review_update', language: 'en', category: 'UTILITY', waStatus: 'approved',
  body: SPEC_BODY, footer: 'TeamLink Consultants', ...over,
});

test('boot', async () => {
  dbh = await startTestDb(DB_PORT);
  graph = await startMockGraph(WA_PORT);
  applyTestEnv(dbh.url, {
    PUBLIC_ORIGIN: base, DISABLE_BACKGROUND_WORK: 'true', OUTBOUND_ALLOWLIST: '',
    WHATSAPP_API_KEY: 'wa-access-token-for-tests', WHATSAPP_PHONE_ID: '555000111', WHATSAPP_API_URL: `http://127.0.0.1:${WA_PORT}/v21.0`,
    WHATSAPP_BUSINESS_ID: BIZ, WHATSAPP_APP_SECRET: SECRET, WHATSAPP_VERIFY_TOKEN: 'v',
  });
  raw = (sql, params) => dbh.db.query(sql, params);
  await raw(`insert into companies (id, name) values ('co_ws', 'Send Co')`);
  const { createApp } = await import('../src/app.js');
  ({ drainQueue } = await import('../src/notify/bulk.js'));
  const app = createApp({ logger: { error() {}, log() {} } });
  await new Promise((r) => { server = app.listen(API_PORT, r); });
  admin = await staff('admin.ws@tl-sink.local', 'admin', 'a_ws');
  recA = await staff('a.ws@tl-sink.local', 'recruiter', 'r_wsa', { name: 'Priya Sharma' });
  recB = await staff('b.ws@tl-sink.local', 'recruiter', 'r_wsb', { name: 'Kiran Rao' });
  await raw(`insert into jobs (id, title, company_id, location, mode, exp_label, pay_label, salary_min, salary_max, employment_type, status, skills, published_at, description, recruiter_id)
             values ('j_ws1', 'Software Developer', 'co_ws', 'Hyderabad', 'Onsite', '1-3 yrs', '₹5 LPA', 5, 5, 'Full-time', 'open', '{Java}', now(), 'x', 'r_wsa')`);
  await candidate('c_rahul', 'Rahul Kumar', '+91 98765 00001');
  await candidate('c_anita', 'Anita Devi', '9876500002');
  await candidate('c_nophone', 'No Phone', '');
  await candidate('c_badphone', 'Bad Phone', '12345');
  await candidate('c_noopt', 'No Optin', '9876500005', { optIn: false });
  await candidate('c_dnc', 'Do Not Contact', '9876500006', { dnc: true });
  await candidate('c_sita', 'Sita Rani', '9876500007');
  await raw(`insert into applications (id, job_id, candidate_id, recruiter_id, stage) values ('app_rahul', 'j_ws1', 'c_rahul', 'r_wsa', 'shortlisted')`);
  await raw(`insert into applications (id, job_id, candidate_id, recruiter_id, stage) values ('app_sita', 'j_ws1', 'c_sita', 'r_wsa', 'applied')`);
});

let T;     // the approved template
test('only an administrator manages templates; the form is validated field by field', async () => {
  assert.equal((await recA.post('/api/whatsapp/templates', specTemplate())).status, 403);
  const bad = await admin.post('/api/whatsapp/templates', specTemplate({ waName: 'Has Spaces', body: 'Hi {{nope}}', language: 'english' }));
  assert.equal(bad.status, 400);
  assert.ok(bad.body.error.details.waName && bad.body.error.details.language && bad.body.error.details.body, JSON.stringify(bad.body));
  const ok = await admin.post('/api/whatsapp/templates', specTemplate());
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  T = ok.body.template;
  assert.equal(T.sendable, true);
  assert.deepEqual(T.params.map((p) => p.key), ['candidate_name', 'job_title', 'application_status']);
  assert.equal(T.footer, 'TeamLink Consultants');
  const dup = await admin.post('/api/whatsapp/templates', specTemplate({ name: 'Another' }));
  assert.equal(dup.status, 201, 'the same WhatsApp name and language is the same template - it is updated, not duplicated');
  assert.equal(dup.body.template.id, T.id);
  assert.equal(dup.body.template.name, 'Another');
  assert.equal(dup.body.template.version, 2);
  T = dup.body.template;
});

test('recruiters see only templates that can be sent; one WhatsApp has not approved is hidden and refused', async () => {
  const p = await admin.post('/api/whatsapp/templates', specTemplate({ name: 'Pending one', waName: 'pending_one', waStatus: 'pending' }));
  assert.equal(p.status, 201);
  assert.equal(p.body.template.sendable, false);
  assert.ok(p.body.template.notSendableBecause.some((x) => /not approved/.test(x)), JSON.stringify(p.body.template.notSendableBecause));
  const list = (await recA.get('/api/whatsapp/templates')).body;
  assert.ok(list.templates.some((t) => t.waName === 'profile_review_update'));
  assert.ok(!list.templates.some((t) => t.waName === 'pending_one'));
  assert.equal(list.canManage, false);
  const all = (await admin.get('/api/whatsapp/templates?all=true')).body;
  assert.ok(all.templates.some((t) => t.waName === 'pending_one'));
  assert.equal((await recA.get(`/api/whatsapp/templates/${p.body.template.id}`)).status, 404);
  const send = await recA.post('/api/whatsapp/send', { templateId: p.body.template.id, candidateIds: ['c_rahul'], sendKey: 'key-pending-0001' });
  assert.equal(send.status, 409);
  assert.equal((await recA.put(`/api/comm/templates/${T.id}`, { name: 'x', body: 'y' })).status, 422, 'the plain text editor cannot overwrite a WhatsApp template');
});

test('preview: every candidate gets their own message from the database; the spec example comes out exactly', async () => {
  const r = await recA.post('/api/whatsapp/preview', { templateId: T.id, candidateIds: ['c_rahul', 'c_anita', 'c_nophone', 'c_badphone', 'c_noopt', 'c_dnc', 'c_sita'] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const by = Object.fromEntries(r.body.candidates.map((c) => [c.candidateId, c]));
  assert.equal(by.c_rahul.preview.body,
    'Hello Rahul Kumar,\nWe reviewed your profile for the Software Developer position at TeamLink.\nYour application status is Shortlisted.\nOur team will contact you with further details.\nThank you,\nTeamLink Recruitment Team');
  assert.equal(by.c_rahul.number, '919876500001');
  assert.equal(by.c_rahul.sendable, true);
  assert.equal(by.c_sita.preview.body.includes('Hello Sita Rani'), true);
  assert.match(by.c_sita.preview.body, /status is Applied\./);
  assert.ok(!/undefined|null|\{\{/.test(by.c_rahul.preview.body + by.c_sita.preview.body));
  // not sendable, each with its own reason
  assert.match(by.c_anita.blocked.map((b) => b.reason).join(), /job title/i);
  assert.match(by.c_nophone.blocked[0].reason, /no mobile number/);
  assert.match(by.c_badphone.blocked[0].reason, /valid/);
  assert.ok(by.c_noopt.blocked.some((b) => b.kind === 'optin'));
  assert.ok(by.c_dnc.blocked.some((b) => b.kind === 'dnc'));
  assert.deepEqual(r.body.counts, { selected: 7, ready: 2, blocked: 5 });
  // a missing field never leaks as "undefined" or the raw braces
  for (const c of r.body.candidates) assert.ok(!/undefined|null|\{\{/.test(c.preview ? c.preview.body : ''), c.candidateId);
});

test('a fallback fills a missing field; choosing the job fills the rest', async () => {
  const f = await admin.post('/api/whatsapp/templates', specTemplate({ name: 'With fallbacks', waName: 'with_fallbacks',
    fallbacks: { application_status: 'Under review', job_title: 'an open role' } }));
  assert.equal(f.status, 201, JSON.stringify(f.body));
  const r = await recA.post('/api/whatsapp/preview', { templateId: f.body.template.id, candidateIds: ['c_anita'] });
  const a = r.body.candidates[0];
  assert.equal(a.sendable, true, JSON.stringify(a.blocked));
  assert.match(a.preview.body, /for the an open role position/);
  assert.match(a.preview.body, /status is Under review\./);
  const j = await recA.post('/api/whatsapp/preview', { templateId: f.body.template.id, candidateIds: ['c_anita'], jobId: 'j_ws1' });
  assert.match(j.body.candidates[0].preview.body, /for the Software Developer position/);
});

let batch;
test('send: one personalised template message per candidate, in the template\'s parameter order, through the shared queue', async () => {
  graph.clear();
  const r = await recA.post('/api/whatsapp/send', { templateId: T.id, candidateIds: ['c_rahul', 'c_sita', 'c_nophone', 'c_dnc'], sendKey: 'send-key-0001-aaaa', campaignName: 'Nellore walk-in reminder' });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  batch = r.body.batchId;
  assert.equal(r.body.queued, 2);
  assert.equal(r.body.campaignName, 'Nellore walk-in reminder');
  assert.deepEqual(r.body.skipped.map((s) => s.id).sort(), ['c_dnc', 'c_nophone']);
  assert.equal(graph.sent.length, 0, 'nothing is sent inside the request');
  const early = (await recA.get(`/api/whatsapp/batches/${batch}`)).body;
  assert.equal(early.pending, 2);
  await drain();
  assert.equal(graph.sent.length, 2);
  const bodyFor = (to) => graph.sent.find((m) => m.body.to === to).body;
  const rahul = bodyFor('919876500001');
  assert.equal(rahul.type, 'template');
  assert.deepEqual(rahul.template.name, 'profile_review_update');
  assert.deepEqual(rahul.template.language, { code: 'en' });
  assert.deepEqual(rahul.template.components, [{ type: 'body', parameters: [
    { type: 'text', text: 'Rahul Kumar' }, { type: 'text', text: 'Software Developer' }, { type: 'text', text: 'Shortlisted' }] }]);
  const sita = bodyFor('919876500007');
  assert.deepEqual(sita.template.components[0].parameters.map((p) => p.text), ['Sita Rani', 'Software Developer', 'Applied']);
  assert.equal(graph.sent[0].auth, 'Bearer wa-access-token-for-tests');
  const done = (await recA.get(`/api/whatsapp/batches/${batch}`)).body;
  assert.equal(done.finished, true);
  assert.equal(done.sent, 2);
  assert.ok(done.rows.every((x) => x.status === 'sent' && x.providerRef && x.message && x.name));
  assert.match(done.rows.find((x) => x.candidateId === 'c_rahul').message, /^Hello Rahul Kumar,/);
});

test('the same click twice, or a retried request, sends nothing a second time', async () => {
  graph.clear();
  const again = await recA.post('/api/whatsapp/send', { templateId: T.id, candidateIds: ['c_rahul', 'c_sita'], sendKey: 'send-key-0001-aaaa' });
  assert.equal(again.status, 200);
  assert.equal(again.body.duplicate, true);
  assert.equal(again.body.batchId, batch);
  await drain();
  assert.equal(graph.sent.length, 0);
  const n = (await raw(`select count(*)::int n from message_logs where batch_id = $1`, [batch])).rows[0].n;
  assert.equal(n, 2);
});

test('a failure keeps WhatsApp\'s reason; retry re-queues ONLY the failed one and never resends the sent', async () => {
  await raw(`insert into applications (id, job_id, candidate_id, recruiter_id, stage) values ('app_anita', 'j_ws1', 'c_anita', 'r_wsa', 'interview_scheduled')`);
  await raw(`insert into applications (id, job_id, candidate_id, recruiter_id, stage) values ('app_noopt', 'j_ws1', 'c_noopt', 'r_wsa', 'applied')`);
  await candidate('c_x1', 'Xavier One', '9876500011'); await candidate('c_x2', 'Yamini Two', '9876500012');
  for (const [i, c] of ['c_x1', 'c_x2'].entries()) await raw(`insert into applications (id, job_id, candidate_id, recruiter_id, stage) values ($1,'j_ws1',$2,'r_wsa','applied')`, [`app_x${i}`, c]);
  graph.clear(); graph.refuse.add('919876500012');
  const r = await recA.post('/api/whatsapp/send', { templateId: T.id, candidateIds: ['c_x1', 'c_x2'], sendKey: 'send-key-0002-bbbb' });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  await drain();
  assert.equal(graph.sent.length, 2);
  const s1 = (await recA.get(`/api/whatsapp/batches/${r.body.batchId}`)).body;
  assert.equal(s1.sent, 1); assert.equal(s1.failed, 1);
  const bad = s1.rows.find((x) => x.status === 'failed');
  assert.equal(bad.candidateId, 'c_x2');
  assert.match(bad.error, /131026|undeliverable/);
  // WhatsApp now accepts the number; retry sends exactly one more message, to the one that failed
  graph.refuse.clear(); graph.clear();
  const rt = await recA.post(`/api/whatsapp/batches/${r.body.batchId}/retry`, {});
  assert.equal(rt.status, 202); assert.equal(rt.body.retried, 1);
  await drain();
  assert.equal(graph.sent.length, 1);
  assert.equal(graph.sent[0].body.to, '919876500012');
  const s2 = (await recA.get(`/api/whatsapp/batches/${r.body.batchId}`)).body;
  assert.equal(s2.sent, 2); assert.equal(s2.failed, 0);
  // a second retry has nothing to do
  const rt2 = await recA.post(`/api/whatsapp/batches/${r.body.batchId}/retry`, {});
  assert.equal(rt2.body.retried, 0);
  await drain();
  assert.equal(graph.sent.length, 1);
  // somebody else's batch is not theirs to retry or see
  assert.equal((await recB.get(`/api/whatsapp/batches/${r.body.batchId}`)).status, 404);
});

test('delivery receipts move a message sent -> delivered -> read; a failed receipt is recorded; replies of STOP / START change the opt-in', async () => {
  const ref = (await raw(`select provider_ref from message_logs where batch_id = $1 and candidate_id = 'c_rahul'`, [batch])).rows[0].provider_ref;
  const hook = (st) => webhook({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { statuses: [st] } }] }] });
  assert.equal(await hook({ id: ref, status: 'delivered', timestamp: '1760000000', pricing: { billable: true, category: 'utility' } }), 200);
  await new Promise((r) => setTimeout(r, 300));
  let row = (await raw(`select status, delivered_at, read_at, credits from message_logs where provider_ref = $1`, [ref])).rows[0];
  assert.equal(row.status, 'delivered'); assert.ok(row.delivered_at); assert.equal(row.read_at, null); assert.equal(Number(row.credits), 1);
  await hook({ id: ref, status: 'read', timestamp: '1760000100' });
  await new Promise((r) => setTimeout(r, 300));
  row = (await raw(`select status, read_at from message_logs where provider_ref = $1`, [ref])).rows[0];
  assert.equal(row.status, 'delivered'); assert.ok(row.read_at);
  // an out-of-order "failed" after delivery never moves it backwards
  await hook({ id: ref, status: 'failed', errors: [{ title: 'late', message: 'x' }] });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await raw(`select status from message_logs where provider_ref = $1`, [ref])).rows[0].status, 'delivered');
  // the batch screen shows it
  const s = (await recA.get(`/api/whatsapp/batches/${batch}`)).body;
  assert.equal(s.delivered, 1); assert.equal(s.read, 1);

  // STOP
  graph.clear();
  const reply = (text) => webhook({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { messages: [{ from: '919876500007', id: `m${Math.random()}`, type: 'text', text: { body: text } }] } }] }] });
  assert.equal(await reply('STOP'), 200);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal((await raw(`select whatsapp_opt_in from candidates where id = 'c_sita'`)).rows[0].whatsapp_opt_in, false);
  const p = await recA.post('/api/whatsapp/preview', { templateId: T.id, candidateIds: ['c_sita'] });
  assert.ok(p.body.candidates[0].blocked.some((b) => b.kind === 'optin'), 'an opted-out candidate is skipped from now on');
  assert.equal(await reply('start'), 200);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal((await raw(`select whatsapp_opt_in from candidates where id = 'c_sita'`)).rows[0].whatsapp_opt_in, true);
});

test('the contact cooldown still applies: a second recruiter is held back from someone just contacted', async () => {
  const r = await recB.post('/api/whatsapp/send', { templateId: T.id, candidateIds: ['c_rahul'], sendKey: 'send-key-0003-cccc' });
  assert.ok([202, 200].includes(r.status), JSON.stringify(r.body));
  assert.equal(r.body.queued, 0);
  assert.ok(r.body.skipped.some((s) => s.id === 'c_rahul'), JSON.stringify(r.body));
});

test('history: a recruiter sees their own sends; an administrator sees everyone\'s, by recruiter', async () => {
  const mine = (await recA.get('/api/whatsapp/history')).body;
  assert.ok(mine.batches.length >= 2);
  assert.ok(mine.batches.every((b) => b.recruiter === 'Priya Sharma' && b.templateName));
  assert.equal(mine.byRecruiter, undefined);
  const theirs = (await recB.get('/api/whatsapp/history')).body;
  assert.equal(theirs.batches.length, 0);
  const all = (await admin.get('/api/whatsapp/history')).body;
  assert.ok(all.byRecruiter.some((x) => x.recruiter === 'Priya Sharma' && x.sent >= 4));
  const first = mine.batches.find((b) => b.batchId === batch);
  assert.equal(first.total, 2); assert.equal(first.sent, 2);
  assert.equal(first.campaignName, 'Nellore walk-in reminder');
});

test('a WhatsApp send is a named campaign: it is listed under Templates & Campaigns -> Campaigns, to the people who may see it', async () => {
  const mine = (await recA.get('/api/comm/campaigns')).body.campaigns.filter((c) => c.channel === 'whatsapp');
  const c = mine.find((x) => x.batchId === batch);
  assert.ok(c, JSON.stringify(mine));
  assert.equal(c.name, 'Nellore walk-in reminder');
  assert.deepEqual([c.messages, c.sent, c.pending, c.failed], [2, 2, 0, 0]);
  assert.deepEqual(c.usedIn, ['Another']);
  assert.equal(c.status, 'completed');
  assert.equal((await recB.get('/api/comm/campaigns')).body.campaigns.filter((x) => x.channel === 'whatsapp' && x.batchId === batch).length, 0);
  assert.ok((await admin.get('/api/comm/campaigns?channel=whatsapp')).body.campaigns.some((x) => x.batchId === batch));
  assert.equal((await recA.get('/api/comm/campaigns?channel=call')).body.campaigns.filter((x) => x.channel === 'whatsapp').length, 0);
  assert.ok((await recA.get('/api/comm/campaigns?q=walk-in')).body.campaigns.some((x) => x.batchId === batch));
  // an unnamed send gets a name from its template
  const un = await admin.post('/api/whatsapp/send', { templateId: T.id, candidateIds: ['c_noopt'], sendKey: 'send-key-0009-iiii', includeNoOptIn: true });
  assert.match(un.body.campaignName, /^Another - /);
});

test('opt-in: only an administrator or team lead may include candidates with no opt-in on record, and it is recorded in the same queue', async () => {
  const no = await recA.post('/api/whatsapp/send', { templateId: T.id, candidateIds: ['c_noopt'], sendKey: 'send-key-0004-dddd', includeNoOptIn: true });
  assert.equal(no.status, 403);
  const own = await recA.post('/api/whatsapp/send', { templateId: T.id, candidateIds: ['c_noopt'], sendKey: 'send-key-0005-eeee' });
  assert.equal(own.body.queued, 0);
  assert.ok(own.body.skipped[0].kinds.includes('optin'));
  graph.clear();
  const yes = await admin.post('/api/whatsapp/send', { templateId: T.id, candidateIds: ['c_noopt'], sendKey: 'send-key-0006-ffff', includeNoOptIn: true });
  assert.equal(yes.status, 202, JSON.stringify(yes.body));
  assert.equal(yes.body.queued, 1);
});

test('sync from WhatsApp Business: approved templates come in; numbered ones need their fields matched before they can be sent', async () => {
  graph.setTemplates([
    { id: 'm1', name: 'interview_invite_v2', language: 'en', status: 'APPROVED', category: 'UTILITY', components: [
      { type: 'HEADER', format: 'TEXT', text: 'Interview with {{1}}' },
      { type: 'BODY', text: 'Hi {{1}}, your interview for {{2}} is on {{3}} at {{4}}.' },
      { type: 'FOOTER', text: 'TeamLink' },
      { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Confirm' }, { type: 'URL', text: 'Open job', url: 'https://x.test/job/{{1}}' }] }] },
    { id: 'm2', name: 'rejected_one', language: 'en', status: 'REJECTED', category: 'MARKETING', components: [{ type: 'BODY', text: 'Hello' }] },
  ]);
  assert.equal((await recA.post('/api/whatsapp/templates/sync', {})).status, 403);
  const s = await admin.post('/api/whatsapp/templates/sync', {});
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.equal(s.body.sync.added, 2); assert.equal(s.body.sync.needsMapping, 1);
  const all = (await admin.get('/api/whatsapp/templates?all=true')).body.templates;
  const inv = all.find((t) => t.waName === 'interview_invite_v2');
  assert.equal(inv.sendable, false);
  assert.ok(inv.notSendableBecause.some((x) => /not matched/.test(x)), JSON.stringify(inv.notSendableBecause));
  assert.deepEqual(inv.buttons.map((b) => b.type), ['quick_reply', 'url']);
  assert.equal(all.find((t) => t.waName === 'rejected_one').sendable, false);
  // a sync is repeatable
  assert.equal((await admin.post('/api/whatsapp/templates/sync', {})).body.sync.added, 0);

  // match the numbers to fields (the admin's edit form)
  const form = (await admin.get(`/api/whatsapp/templates/${inv.id}`)).body.form;
  assert.equal(form.numbered, 4);
  const save = await admin.put(`/api/whatsapp/templates/${inv.id}`, {
    ...form, headerParam: 'recruiter_name', params: ['first_name', 'job_title', 'interview_date', 'interview_time'],
    buttons: [{ type: 'quick_reply', text: 'Confirm' }, { type: 'url', text: 'Open job', url: 'https://x.test/job/{{1}}', urlParam: 'job_id' }],
  });
  assert.equal(save.status, 200, JSON.stringify(save.body));
  assert.equal(save.body.template.sendable, true, JSON.stringify(save.body.template.notSendableBecause));
  assert.match(save.body.template.body, /^Hi \{\{first_name\}\}, your interview for \{\{job_title\}\} is on \{\{interview_date\}\} at \{\{interview_time\}\}\./);

  // header, body and the button each get their own parameters
  await raw(`insert into interviews (id, candidate_id, job_id, application_id, type, scheduled_date, scheduled_time, status)
             values ('iv_ws1','c_rahul','j_ws1','app_rahul','HR Round', current_date + 3, '11:00 AM', 'Scheduled')`);
  const pv = await recA.post('/api/whatsapp/preview', { templateId: inv.id, candidateIds: ['c_rahul'] });
  const rahul = pv.body.candidates[0];
  assert.equal(rahul.sendable, true, JSON.stringify(rahul.blocked));
  assert.match(rahul.preview.body, /^Hi Rahul, your interview for Software Developer is on \d{1,2} \w{3} \d{4} at 11:00 AM\./);
  assert.equal(rahul.preview.header.text, 'Interview with Priya Sharma');
  assert.equal(rahul.preview.buttons[1].shownUrl, 'https://x.test/job/j_ws1');
  await raw(`delete from contact_log where candidate_id = 'c_rahul'`).catch(() => {});
  graph.clear();
  const sent = await admin.post('/api/whatsapp/send', { templateId: inv.id, candidateIds: ['c_rahul'], sendKey: 'send-key-0007-gggg', override: true, overrideReason: 'testing the template' });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  await drain();
  const comps = graph.sent[0].body.template.components;
  assert.deepEqual(comps.map((c) => c.type), ['header', 'body', 'button']);
  assert.equal(comps[0].parameters[0].text, 'TeamLink Recruitment Team');
  assert.equal(comps[1].parameters.length, 4);
  assert.deepEqual(comps[2], { type: 'button', sub_type: 'url', index: '1', parameters: [{ type: 'text', text: 'j_ws1' }] });
});

test('the outbound allow-list still protects real candidates', async () => {
  process.env.OUTBOUND_ALLOWLIST = '9000000000';
  try {
    await candidate('c_guard', 'Guarded Person', '9876500099');
    await raw(`insert into applications (id, job_id, candidate_id, recruiter_id, stage) values ('app_guard','j_ws1','c_guard','r_wsa','applied')`);
    graph.clear();
    const r = await recA.post('/api/whatsapp/send', { templateId: T.id, candidateIds: ['c_guard'], sendKey: 'send-key-0008-hhhh' });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    await drain();
    assert.equal(graph.sent.length, 0);
    const s = (await recA.get(`/api/whatsapp/batches/${r.body.batchId}`)).body;
    assert.equal(s.failed, 1);
    assert.match(s.rows[0].error, /restricted/);
  } finally { process.env.OUTBOUND_ALLOWLIST = ''; }
});

test('shutdown', async () => {
  await new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
  await graph.stop();
  await dbh.stop();
});
