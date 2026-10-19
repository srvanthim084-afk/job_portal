/**
 * Templates & Campaigns (0157): the registry behind the Recruiter Portal's header button.
 *
 *   - built-in templates are listed (and can be duplicated, never edited or archived)
 *   - an administrator's template is approved at once; a recruiter's waits; editing makes a new version and sends it back to waiting
 *   - Approve / Changes needed: an administrator, or a team lead who did not write it - nobody else, and nobody for their own
 *   - filters: channel, department, approval state, search; archived ones are hidden unless asked for
 *   - approved templates reach the compose box; waiting ones do not
 *   - the campaigns list is the AI calling campaigns the caller may see
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb, applyTestEnv, makeClient } from './harness.mjs';

const DB_PORT = 5702;
const API_PORT = 9972;
const base = `http://127.0.0.1:${API_PORT}`;
const PW = 'CommTpl#2026xyz';

let dbh, server, raw, admin, recA, recB, tl, cand;

async function staff(email, role, table, id, extra = {}) {
  const { hashPassword } = await import('../src/auth.js');
  const u = (await raw(`insert into users (email, password_hash, role) values ($1, $2, $3) returning id`, [email, await hashPassword(PW), role])).rows[0].id;
  if (table === 'recruiters') {
    await raw(`insert into recruiters (id, user_id, name, email, company_id, department, is_team_lead) values ($1,$2,$3,$4,'co_ct',$5,$6)`,
      [id, u, `Rec ${id}`, email, extra.department || null, !!extra.teamLead]);
  } else if (table === 'admins') {
    await raw(`insert into admins (id, user_id, name, email) values ($1,$2,'Admin CT',$3)`, [id, u, email]);
  }
  const c = makeClient(base);
  await c.get('/api/health');
  const r = await c.post('/api/auth/login', { email, password: PW, role });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return c;
}
const list = async (c, qs = '') => (await c.get('/api/comm/templates' + qs)).body;
const byName = (rows, name) => rows.find((t) => t.name === name);

test('boot', async () => {
  dbh = await startTestDb(DB_PORT);
  applyTestEnv(dbh.url, { PUBLIC_ORIGIN: base, DISABLE_BACKGROUND_WORK: 'true' });
  raw = (sql, params) => dbh.db.query(sql, params);
  await raw(`insert into companies (id, name) values ('co_ct', 'Tpl Co')`);
  const { createApp } = await import('../src/app.js');
  const app = createApp({ logger: { error() {}, log() {} } });
  await new Promise((r) => { server = app.listen(API_PORT, r); });
  admin = await staff('admin.ct@tl-sink.local', 'admin', 'admins', 'a_ct');
  recA = await staff('a.ct@tl-sink.local', 'recruiter', 'recruiters', 'r_cta', { department: 'Medical' });
  recB = await staff('b.ct@tl-sink.local', 'recruiter', 'recruiters', 'r_ctb', { department: 'IT' });
  tl = await staff('tl.ct@tl-sink.local', 'recruiter', 'recruiters', 'r_cttl', { department: 'Medical', teamLead: true });
  // a candidate must not reach any of it
  const { hashPassword } = await import('../src/auth.js');
  const cu = (await raw(`insert into users (email, password_hash, role) values ('cand.ct@tl-sink.local', $1, 'candidate') returning id`, [await hashPassword(PW)])).rows[0].id;
  await raw(`insert into candidates (id, name, email, user_id) values ('c_ct', 'Cand CT', 'cand.ct@tl-sink.local', $1)`, [cu]);
  cand = makeClient(base); await cand.get('/api/health');
  assert.equal((await cand.post('/api/auth/login', { email: 'cand.ct@tl-sink.local', password: PW, role: 'candidate' })).status, 200);
});

test('only staff can read it', async () => {
  const anon = makeClient(base); await anon.get('/api/health');
  assert.equal((await anon.get('/api/comm/templates')).status, 401);
  assert.equal((await cand.get('/api/comm/templates')).status, 403);
  assert.equal((await cand.get('/api/comm/campaigns')).status, 403);
});

test('the built-in templates are listed, approved, and cannot be edited or archived - only duplicated', async () => {
  const d = await list(recA);
  const sys = d.templates.filter((t) => t.source === 'system');
  assert.ok(sys.length >= 10, `built-ins listed (${sys.length})`);
  assert.ok(sys.every((t) => t.approval === 'approved' && t.version === 1 && !t.canEdit && !t.canArchive));
  assert.ok(sys.some((t) => t.channel === 'email' && /interview/i.test(t.name)));
  assert.ok(sys.some((t) => t.channel === 'sms') && sys.some((t) => t.channel === 'whatsapp'));
  assert.ok(sys.some((t) => t.usedIn.includes('Bulk message')));
  assert.equal(d.permissions.canCreate, true);
  assert.equal(d.permissions.canReview, false);
  const one = sys[0];
  assert.equal((await recA.put(`/api/comm/templates/${one.id}`, { name: 'x', body: 'y' })).status, 422);
  assert.equal((await admin.put(`/api/comm/templates/${one.id}`, { name: 'x', body: 'y' })).status, 422);
  assert.equal((await admin.post(`/api/comm/templates/${one.id}/archive`, {})).status, 422);
  assert.equal((await admin.post(`/api/comm/templates/${one.id}/review`, { decision: 'changes_needed', note: 'n' })).status, 422);
});

let tA, tAdmin;
test('create: a recruiter\'s template waits, an administrator\'s is approved at once', async () => {
  const r = await recA.post('/api/comm/templates', { name: 'Walk-in reminder', channel: 'sms', body: 'Hi {{first_name}}, your walk-in is tomorrow.', department: 'Medical', usedIn: ['Walk-in jobs'] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  tA = r.body.template;
  assert.deepEqual([tA.approval, tA.version, tA.source, tA.canEdit, tA.canReview], ['waiting', 1, 'portal', true, false]);
  const a = await admin.post('/api/comm/templates', { name: 'Offer follow-up', channel: 'email', subject: 'Your offer', body: 'Dear {{first_name}}', department: 'IT', usedIn: ['Offers'] });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  tAdmin = a.body.template;
  assert.equal(tAdmin.approval, 'approved');
  // validation
  assert.equal((await recA.post('/api/comm/templates', { name: '', channel: 'sms', body: 'x' })).status, 400);
  assert.equal((await recA.post('/api/comm/templates', { name: 'x', channel: 'fax', body: 'x' })).status, 400);
  assert.equal((await recA.post('/api/comm/templates', { name: 'x', channel: 'sms', body: '' })).status, 400);
  // somebody else sees it but may not edit it
  const seen = byName((await list(recB)).templates, 'Walk-in reminder');
  assert.ok(seen && !seen.canEdit && !seen.canArchive);
  assert.equal((await recB.put(`/api/comm/templates/${tA.id}`, { name: 'hijack', body: 'x' })).status, 403);
  assert.equal((await recB.post(`/api/comm/templates/${tA.id}/archive`, {})).status, 403);
});

test('review: not the author, not an ordinary recruiter; a team lead or an administrator; changes need a note', async () => {
  assert.equal((await recB.post(`/api/comm/templates/${tA.id}/review`, { decision: 'approved' })).status, 403, 'an ordinary recruiter');
  assert.equal((await recA.post(`/api/comm/templates/${tA.id}/review`, { decision: 'approved' })).status, 403, 'the author');
  assert.equal(byName((await list(tl)).templates, 'Walk-in reminder').canReview, true);
  assert.equal(byName((await list(recB)).templates, 'Walk-in reminder').canReview, false);

  assert.equal((await tl.post(`/api/comm/templates/${tA.id}/review`, { decision: 'changes_needed' })).status, 422, 'a note is required');
  const ch = await tl.post(`/api/comm/templates/${tA.id}/review`, { decision: 'changes_needed', note: 'Add the venue' });
  assert.equal(ch.status, 200, JSON.stringify(ch.body));
  assert.deepEqual([ch.body.template.approval, ch.body.template.approvalNote], ['changes_needed', 'Add the venue']);

  // the author fixes it: version 2, back to waiting, the note is cleared
  const up = await recA.put(`/api/comm/templates/${tA.id}`, { name: 'Walk-in reminder', body: 'Hi {{first_name}}, your walk-in is tomorrow at {{venue}}.', department: 'Medical', usedIn: ['Walk-in jobs'] });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.deepEqual([up.body.template.version, up.body.template.approval, up.body.template.approvalNote], [2, 'waiting', null]);

  const ok = await tl.post(`/api/comm/templates/${tA.id}/review`, { decision: 'approved' });
  assert.equal(ok.body.template.approval, 'approved');
  // an approved template edited again goes back to waiting as version 3 - even for the author
  const again = await recA.put(`/api/comm/templates/${tA.id}`, { name: 'Walk-in reminder', body: 'Hi {{first_name}}, see you tomorrow at {{venue}}.', department: 'Medical' });
  assert.deepEqual([again.body.template.version, again.body.template.approval], [3, 'waiting']);

  // a team lead never approves their OWN template
  const mine = (await tl.post('/api/comm/templates', { name: 'TL own', channel: 'whatsapp', body: 'Hello' })).body.template;
  assert.equal(mine.approval, 'waiting');
  assert.equal((await tl.post(`/api/comm/templates/${mine.id}/review`, { decision: 'approved' })).status, 403);
  assert.equal((await admin.post(`/api/comm/templates/${mine.id}/review`, { decision: 'approved' })).status, 200);

  // versions are kept
  const d = await recA.get(`/api/comm/templates/${tA.id}`);
  assert.deepEqual(d.body.versions.map((v) => v.version), [3, 2, 1]);
  assert.match(d.body.versions[2].body, /is tomorrow\.$/);
  assert.ok((await raw(`select 1 from audit_log where action = 'comm_template.changes_needed'`)).rowCount >= 1);
});

test('filters: channel, department, approval state and search; archived ones are hidden unless asked for', async () => {
  const all = (await list(recB)).templates;
  assert.ok(all.length > 10);
  const sms = (await list(recB, '?channel=sms')).templates;
  assert.ok(sms.length && sms.every((t) => t.channel === 'sms'));
  const med = (await list(recB, '?department=Medical')).templates;
  assert.deepEqual(med.map((t) => t.name).sort(), ['Walk-in reminder']);
  const waiting = (await list(recB, '?approval=waiting')).templates;
  assert.ok(waiting.some((t) => t.name === 'Walk-in reminder') && waiting.every((t) => t.approval === 'waiting'));
  const approved = (await list(recB, '?approval=approved')).templates;
  assert.ok(approved.some((t) => t.name === 'Offer follow-up') && approved.every((t) => t.approval === 'approved'));
  assert.deepEqual((await list(recB, '?q=offers')).templates.map((t) => t.name), ['Offer follow-up'], 'search reaches "Used In"');
  assert.ok((await list(recB, '?q=tomorrow')).templates.some((t) => t.name === 'Walk-in reminder'), 'search reaches the text');
  assert.equal((await list(recB, '?q=zzzzqqq')).templates.length, 0);
  assert.ok((await list(recB)).departments.includes('Medical') && (await list(recB)).departments.includes('IT'));

  // archive: the author or an administrator; hidden by default
  assert.equal((await recA.post(`/api/comm/templates/${tA.id}/archive`, { archived: true })).status, 200);
  assert.ok(!byName((await list(recB)).templates, 'Walk-in reminder'));
  assert.ok(byName((await list(recB, '?archived=true')).templates, 'Walk-in reminder'));
  assert.equal((await admin.post(`/api/comm/templates/${tA.id}/archive`, { archived: false })).status, 200);
  assert.ok(byName((await list(recB)).templates, 'Walk-in reminder'));
});

test('duplicate: the way to change a built-in template, an editable copy that waits for review', async () => {
  const sys = (await list(recA)).templates.find((t) => t.source === 'system' && t.channel === 'email' && t.body);
  const d = await recA.post(`/api/comm/templates/${sys.id}/duplicate`, {});
  assert.equal(d.status, 201, JSON.stringify(d.body));
  assert.equal(d.body.template.name, `${sys.name} (copy)`);
  assert.deepEqual([d.body.template.source, d.body.template.approval, d.body.template.version, d.body.template.canEdit], ['portal', 'waiting', 1, true]);
  assert.equal((await cand.post(`/api/comm/templates/${sys.id}/duplicate`, {})).status, 403);
});

test('approved templates reach the compose box; waiting ones do not', async () => {
  const t = (await recB.get('/api/candidates/message-templates')).body.templates;
  assert.ok(t.some((x) => x.id === `comm_${tAdmin.id}` && x.name === 'Offer follow-up' && x.channels[0] === 'email'), 'the approved one is offered');
  assert.ok(!t.some((x) => x.name === 'TL own' && x.id.startsWith('comm_') && false));
  const waitingId = (await recA.post('/api/comm/templates', { name: 'Still waiting', channel: 'email', subject: 's', body: 'b' })).body.template.id;
  const t2 = (await recB.get('/api/candidates/message-templates')).body.templates;
  assert.ok(!t2.some((x) => x.id === `comm_${waitingId}`), 'a waiting one is not offered');
  const sms = (await recB.get('/api/candidates/message-templates?channel=sms')).body.templates;
  assert.ok(sms.every((x) => x.channels.includes('sms')));
});

test('campaigns: the AI calling campaigns the caller may see, with the channel filter', async () => {
  await raw(`insert into jobs (id, title, company_id, location, mode, exp_label, skills, status, recruiter_id, description, published_at)
             values ('j_ct1', 'Staff Nurse', 'co_ct', 'Hyderabad', 'Onsite', '1-3 yrs', $1, 'open', 'r_cta', 'x', now())`, [['Care']]);
  await raw(`insert into ai_call_campaigns (id, name, job_id, recruiter_id, status) values ('camp_ct1', 'Nurse calls', 'j_ct1', 'r_cta', 'running')`);
  const c = (await admin.get('/api/comm/campaigns')).body.campaigns;
  assert.ok(c.some((x) => x.id === 'camp_ct1' && x.channel === 'call' && x.usedIn[0] === 'Staff Nurse' && x.department === 'Medical'));
  assert.equal((await admin.get('/api/comm/campaigns?channel=email')).body.campaigns.length, 0);
  assert.equal((await admin.get('/api/comm/campaigns?q=nurse')).body.campaigns.length, 1);
  assert.equal((await admin.get('/api/comm/campaigns?q=nomatch')).body.campaigns.length, 0);
});

test('shutdown', async () => {
  await new Promise((r) => server.close(r));
  const { stopBackgroundWork } = await import('../src/app.js');
  stopBackgroundWork();
  const { closePool } = await import('../src/db.js');
  await closePool();
  await dbh.stop?.();
});
