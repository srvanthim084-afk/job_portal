/**
 * Shared candidates + "already contacted", end to end through the API
 * (migration 0091; routes in src/routes/shared-candidates.js and the
 * candidate routes). The rules themselves are proved one level down in
 * shared-candidates-db.test.mjs; this file proves the routes ask them and
 * enforce the answer:
 *
 *   - B reads A's candidate, cannot edit it, does not get A's notes
 *   - Log call -> B sees the orange badge and gets the warn (409, then
 *     "contact anyway" with acknowledge, logged)
 *   - A adds them to a job -> B is blocked on the server for add-to-job,
 *     call log, WhatsApp check, AI call, bulk message; a different role
 *     is allowed
 *   - Message <holder> reaches the holder's notifications
 *   - override requested -> admin approves -> B proceeds
 *   - duplicate client submission refused, admin override with a reason
 *   - bulk message skips BLOCK always and WARN by default
 *   - every one of these wrote the contact history
 *
 * Nothing leaves the machine: SMS goes to the mock provider.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb, applyTestEnv, makeClient, startMockProvider } from './harness.mjs';

const DB_PORT = 5461;
const API_PORT = 9981;
const MOCK_PORT = 9861;

let dbh, server, mock, base, raw;
let A, B, ADMIN;
const ids = {};

async function signIn(email, password) {
  const c = makeClient(base);
  await c.get('/api/health');
  const r = await c.post('/api/auth/login', { email, password });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return c;
}

async function addCandidate(who, first, phone, extra = {}) {
  const r = await who.post('/api/candidates', {
    firstName: first, lastName: 'Test', phone, gender: 'Female',
    email: `${first.toLowerCase()}.${phone}@tl-sink.local`,
    sendCredentials: false, recruiterNotes: `note by owner about ${first}`, ...extra,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.candidate.id;
}

const auditOf = async (candidateId) => (await raw(
  `select action from engagement_audit where candidate_id = $1 order by id`, [candidateId])).rows.map((r) => r.action);

/** The refusal audit is written after the response; give it a moment. */
async function eventually(fn, ms = 2000) {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
}

test('boot', async () => {
  dbh = await startTestDb(DB_PORT);
  mock = await startMockProvider(MOCK_PORT);
  applyTestEnv(dbh.url, {
    PUBLIC_ORIGIN: `http://127.0.0.1:${API_PORT}`,
    DISABLE_BACKGROUND_WORK: 'true',
    SMS_API_URL: `http://127.0.0.1:${MOCK_PORT}/sms`,
    EMAIL_API_KEY: '', EMAIL_SMTP_HOST: '', EMAIL_SMTP_USER: '', EMAIL_SMTP_PASS: '',
    EMAILJS_SERVICE_ID: '', EMAILJS_TEMPLATE_ID: '', EMAILJS_PUBLIC_KEY: '', EMAILJS_PRIVATE_KEY: '',
    OUTBOUND_ALLOWLIST: '', OUTBOUND_CALLS_ENABLED: '',
  });
  raw = (sql, params) => dbh.db.query(sql, params);

  const { hashPassword } = await import('../src/auth.js');
  const hash = await hashPassword('Shared123cand');
  await raw(`insert into companies (id, name) values ('co_x', 'Nellore Health Services')`);
  const user = async (email, role) => (await raw(
    `insert into users (email, password_hash, role) values ($1,$2,$3) returning id`, [email, hash, role])).rows[0].id;
  await raw(`insert into recruiters (id, user_id, name, email, company_id) values
               ('rA', $1, 'Ravi', 'ravi@tl-sink.local', 'co_x'),
               ('rB', $2, 'Priya', 'priya@tl-sink.local', 'co_x')`,
    [await user('ravi@tl-sink.local', 'recruiter'), await user('priya@tl-sink.local', 'recruiter')]);
  await raw(`insert into admins (id, user_id, name, email) values ('adm', $1, 'Admin', 'admin@tl-sink.local')`,
    [await user('admin@tl-sink.local', 'admin')]);
  await raw(`insert into jobs (id, title, company_id, recruiter_id, status, location) values
     ('jA',  'Senior Medical Coder',   'co_x', 'rA', 'open', 'Nellore'),
     ('jA2', 'Medical Coder II',       'co_x', 'rA', 'open', 'Nellore'),
     ('jB',  'Medical Coder',          'co_x', 'rB', 'open', 'Nellore'),
     ('jBr', 'Medical Representative', 'co_x', 'rB', 'open', 'Nellore')`);

  const { createApp } = await import('../src/app.js');
  const app = createApp({ logger: { error() {}, log() {} } });
  await new Promise((r) => { server = app.listen(API_PORT, r); });
  base = `http://127.0.0.1:${API_PORT}`;

  A = await signIn('ravi@tl-sink.local', 'Shared123cand');
  B = await signIn('priya@tl-sink.local', 'Shared123cand');
  ADMIN = await signIn('admin@tl-sink.local', 'Shared123cand');
});

test('B reads the candidate A added, read-only, without A\'s notes; private stays hidden', async () => {
  ids.c1 = await addCandidate(A, 'Asha', '9100000001');
  ids.cPriv = await addCandidate(A, 'Bhanu', '9100000002');
  await raw(`update candidates set is_private = true where id = $1`, [ids.cPriv]);

  const list = await B.get('/api/candidates?limit=200&availabilityAll=true');
  assert.equal(list.status, 200);
  const mine = list.body.candidates.find((c) => c.id === ids.c1);
  assert.ok(mine, 'another recruiter cannot see a shared candidate');
  assert.equal(mine.canEdit, false);
  assert.equal(mine.recruiterNotes, undefined, 'the owner\'s note leaked to another recruiter');
  assert.ok(!list.body.candidates.some((c) => c.id === ids.cPriv), 'a private candidate leaked');

  const own = (await A.get(`/api/candidates/${ids.c1}`)).body.candidate;
  assert.equal(own.canEdit, true);
  assert.equal(own.recruiterNotes, 'note by owner about Asha');

  const edit = await B.put(`/api/candidates/${ids.c1}`, { title: 'Hijacked' });
  assert.equal(edit.status, 403, JSON.stringify(edit.body));
  const src = await B.post(`/api/candidates/${ids.c1}/source`, { source: 'Walk-in' });
  assert.equal(src.status, 403, 'B changed the source of A\'s candidate');
  assert.equal((await B.get(`/api/candidates/${ids.cPriv}`)).status, 404);
});

test('A logs a call -> B gets the orange badge and a warning, and may contact anyway (logged)', async () => {
  const log = await A.post(`/api/candidates/${ids.c1}/call-log`,
    { outcome: 'interested', jobId: 'jA', note: 'Wants 4 LPA, can join in 15 days' });
  assert.equal(log.status, 201, JSON.stringify(log.body));
  assert.ok(log.body.comment, 'the note was not saved as a comment');

  const badge = (await B.post('/api/engagement/badges', { candidateIds: [ids.c1], jobId: 'jB' })).body.badges[ids.c1];
  assert.equal(badge.kind, 'contacted');
  assert.equal(badge.recruiterName, 'Ravi');

  const panel = await B.get(`/api/candidates/${ids.c1}/engagements?jobId=jB`);
  assert.equal(panel.status, 200);
  assert.equal(panel.body.engagements[0].recruiterName, 'Ravi');
  assert.equal(panel.body.engagements[0].sameRole, true);
  assert.equal(panel.body.engagements[0].lastOutcome, 'interested');
  assert.equal(panel.body.verdict.decision, 'warn');
  assert.match(panel.body.verdict.message, /Ravi contacted this candidate for Senior Medical Coder/);
  assert.ok(!JSON.stringify(panel.body).includes('4 LPA'), 'the private note leaked through the panel');

  const comments = await B.get(`/api/candidates/${ids.c1}/comments`);
  assert.ok(!JSON.stringify(comments.body).includes('4 LPA'), 'another recruiter read a private note');

  const warn = await B.post('/api/engagement/check', { candidateId: ids.c1, jobId: 'jB', action: 'whatsapp' });
  assert.equal(warn.status, 409);
  assert.equal(warn.body.error.code, 'ENGAGEMENT_WARN');
  const anyway = await B.post('/api/engagement/check',
    { candidateId: ids.c1, jobId: 'jB', action: 'whatsapp', acknowledge: true, record: true });
  assert.equal(anyway.status, 200, JSON.stringify(anyway.body));
  assert.ok(anyway.body.contactId, 'the WhatsApp contact was not recorded');
  assert.ok((await auditOf(ids.c1)).includes('contact_anyway'));

  const other = await B.post('/api/engagement/check', { candidateId: ids.c1, jobId: 'jBr', action: 'call' });
  assert.equal(other.status, 200, 'a different role must not be restricted');
});

test('A moves them into process -> B is blocked on the server, for this role only', async () => {
  const add = await A.post('/api/applications', { jobId: 'jA', candidateId: ids.c1 });
  assert.equal(add.status, 201, JSON.stringify(add.body));
  ids.appA = add.body.application.id;
  await A.put(`/api/applications/${ids.appA}/status`, { stage: 'interview_scheduled' });

  const badge = (await B.post('/api/engagement/badges', { candidateIds: [ids.c1], jobId: 'jB' })).body.badges[ids.c1];
  assert.equal(badge.kind, 'in_process');
  assert.equal(badge.statusLabel, 'Interview Scheduled');

  const addB = await B.post('/api/applications', { jobId: 'jB', candidateId: ids.c1 });
  assert.equal(addB.status, 409, JSON.stringify(addB.body));
  assert.equal(addB.body.error.code, 'ENGAGEMENT_BLOCKED');
  assert.match(addB.body.error.message, /Ravi is processing this candidate for Senior Medical Coder \(Interview Scheduled\)/);
  assert.equal(addB.body.error.details.engagement.holderName, 'Ravi');
  assert.ok(await eventually(async () => (await auditOf(ids.c1)).includes('blocked')),
    'the refused add-to-job was not logged');

  const call = await B.post(`/api/candidates/${ids.c1}/call-log`, { outcome: 'no_answer', jobId: 'jB' });
  assert.equal(call.status, 409);
  assert.equal(call.body.error.code, 'ENGAGEMENT_BLOCKED');

  const wa = await B.post('/api/engagement/check', { candidateId: ids.c1, jobId: 'jB', action: 'whatsapp', acknowledge: true });
  assert.equal(wa.status, 409, 'acknowledging does not lift a block');

  const ai = await B.post('/api/ai-calling/call', { candidateId: ids.c1, jobId: 'jB' });
  assert.equal(ai.status, 409, JSON.stringify(ai.body));
  assert.equal(ai.body.error.code, 'ENGAGEMENT_BLOCKED');

  // B cannot read A's application, stage or interview
  const apps = await B.get(`/api/applications?candidateId=${ids.c1}`);
  assert.equal(apps.body.applications.length, 0, 'another recruiter reads the pipeline');

  // a different role is free
  const rep = await B.post('/api/applications', { jobId: 'jBr', candidateId: ids.c1 });
  assert.equal(rep.status, 201, JSON.stringify(rep.body));
});

test('bulk message: BLOCK always skipped, WARN skipped unless ticked', async () => {
  ids.cFree = await addCandidate(B, 'Chitra', '9100000003');
  ids.cWarn = await addCandidate(A, 'Divya', '9100000004');
  await A.post(`/api/candidates/${ids.cWarn}/call-log`, { outcome: 'call_back', jobId: 'jA' });

  const send = (extra) => B.post('/api/candidates/bulk-message', {
    channel: 'sms', jobId: 'jB', body: 'Hi {{first_name}}, a coder role in Nellore.',
    candidateIds: [ids.c1, ids.cFree, ids.cWarn], ...extra,
  });
  const first = await send({});
  assert.equal(first.status, 202, JSON.stringify(first.body));
  assert.equal(first.body.queued, 1);
  assert.equal(first.body.held, 1);
  assert.equal(first.body.warned, 1);
  assert.equal(first.body.heldCandidates[0].id, ids.c1);

  const second = await send({ includeWarned: true, candidateIds: [ids.c1, ids.cWarn] });
  assert.equal(second.body.queued, 1, 'a warned candidate was not included when ticked');
  assert.equal(second.body.held, 1, 'a blocked candidate was messaged');
  assert.ok((await auditOf(ids.cWarn)).includes('contact_anyway'));

  const rows = (await raw(`select source, recruiter_id, role_key from candidate_contact_history
                            where candidate_id = $1 and source = 'bulk_message'`, [ids.cFree])).rows;
  assert.deepEqual(rows, [{ source: 'bulk_message', recruiter_id: 'rB', role_key: 'medical coder' }]);
});

test('Message <holder> reaches the holder', async () => {
  const m = await B.post('/api/engagement/message-holder',
    { candidateId: ids.c1, recruiterId: 'rA', message: 'She called me about the coder role - can we talk?' });
  assert.equal(m.status, 201, JSON.stringify(m.body));
  const n = await A.get('/api/notifications');
  assert.ok(n.body.notifications.some((x) => x.type === 'ENGAGEMENT_MESSAGE'), 'Ravi never got the message');
  const nobody = await B.post('/api/engagement/message-holder',
    { candidateId: ids.cFree, recruiterId: 'rA', message: 'hello there' });
  assert.equal(nobody.status, 400, 'messaging a recruiter with no engagement should be refused');
});

test('override: requested by B, approved by an admin with a reason, then B proceeds', async () => {
  const req = await B.post('/api/engagement/overrides', { candidateId: ids.c1, jobId: 'jB', reason: '' });
  assert.equal(req.status, 400, 'an override without a reason');
  const ok = await B.post('/api/engagement/overrides',
    { candidateId: ids.c1, jobId: 'jB', reason: 'She asked for me by name; Ravi agreed on the phone' });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.override.status, 'pending');

  assert.equal((await B.post(`/api/engagement/overrides/${ok.body.override.id}/decide`,
    { approve: true, reason: 'self' })).status, 403);
  const pending = await ADMIN.get('/api/engagement/overrides?status=pending');
  assert.ok(pending.body.overrides.some((o) => o.id === ok.body.override.id));
  const adminN = await ADMIN.get('/api/notifications?limit=200');
  assert.ok(adminN.body.notifications.some((x) => x.type === 'ENGAGEMENT_OVERRIDE_REQUEST'));

  const d = await ADMIN.post(`/api/engagement/overrides/${ok.body.override.id}/decide`,
    { approve: true, reason: 'Confirmed with both recruiters' });
  assert.equal(d.status, 200, JSON.stringify(d.body));
  assert.equal(d.body.override.status, 'approved');
  assert.equal((await ADMIN.post(`/api/engagement/overrides/${ok.body.override.id}/decide`,
    { approve: false, reason: 'twice' })).status, 409, 'decided twice');

  const addB = await B.post('/api/applications', { jobId: 'jB', candidateId: ids.c1 });
  assert.equal(addB.status, 201, JSON.stringify(addB.body));
  const a = await auditOf(ids.c1);
  for (const x of ['override_requested', 'override_approved', 'override_used']) assert.ok(a.includes(x), `${x} not logged`);
});

test('a duplicate submission to the same client is refused; an admin override lets it through', async () => {
  const toClient = await A.put(`/api/applications/${ids.appA}/status`, { stage: 'client_review' });
  assert.equal(toClient.status, 200, JSON.stringify(toClient.body));
  const second = await A.post('/api/applications', { jobId: 'jA2', candidateId: ids.c1 });
  assert.equal(second.status, 201, JSON.stringify(second.body));
  const dup = await A.put(`/api/applications/${second.body.application.id}/status`, { stage: 'client_review' });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'DUPLICATE_SUBMISSION');
  assert.match(dup.body.error.message, /already submitted to this client/);

  assert.equal((await A.post('/api/engagement/overrides',
    { candidateId: ids.c1, jobId: 'jA2', kind: 'duplicate_submission', reason: 'second opening' })).status, 403,
    'a recruiter cannot approve their own duplicate submission');
  const ovr = await ADMIN.post('/api/engagement/overrides',
    { candidateId: ids.c1, jobId: 'jA2', kind: 'duplicate_submission', reason: 'The client asked for a second opening' });
  assert.equal(ovr.status, 201, JSON.stringify(ovr.body));
  assert.equal(ovr.body.override.status, 'approved');
  const again = await A.put(`/api/applications/${second.body.application.id}/status`, { stage: 'client_review' });
  assert.equal(again.status, 200, JSON.stringify(again.body));
});

test('every action wrote the contact history', async () => {
  const rows = (await raw(`select distinct source from candidate_contact_history where candidate_id = $1`, [ids.c1])).rows
    .map((r) => r.source).sort();
  for (const s of ['application', 'interview', 'phone', 'submission', 'whatsapp']) {
    assert.ok(rows.includes(s), `${s} missing from the contact history (${rows})`);
  }
});

test('admin: conflicts lists two recruiters on one role', async () => {
  const c = await ADMIN.get('/api/engagement/conflicts');
  assert.equal(c.status, 200);
  const row = c.body.conflicts.find((x) => x.candidateId === ids.c1 && x.roleKey === 'medical coder');
  assert.ok(row, JSON.stringify(c.body));
  assert.ok(row.recruiterCount >= 2);
  assert.equal((await B.get('/api/engagement/conflicts')).status, 403);
});

test('team notes are shared, private ones are not', async () => {
  await A.post(`/api/candidates/${ids.c1}/comments`, { body: 'Prefers night shift', visibility: 'team' });
  const seen = (await B.get(`/api/candidates/${ids.c1}/comments`)).body.comments.map((c) => c.body);
  assert.ok(seen.includes('Prefers night shift'));
  assert.ok(!seen.some((b) => /4 LPA/.test(b)));
});

test('teardown', async () => {
  await new Promise((r) => server.close(r));
  const { closePool } = await import('../src/db.js');
  await closePool();
  await mock.stop();
  await dbh.stop();
});
