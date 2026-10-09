/**
 * Apply Now: one click, the applied date everywhere, the date filter (0130).
 *
 *   one click -> one application (candidate, job, applied_at, "applied",
 *   source teamlink = "TeamLink Portal"), never two; the candidate's
 *   in-app notice and confirmation email and the recruiter's notice all
 *   say "Applied on <date, time> IST"; applied_at cannot be edited
 *   through the API; Applied Date ranges (India days) on the recruiter
 *   list, the candidate's history and the Talent Pool, combined with the
 *   other filters; the export carries Applied On and only the rows asked
 *   for; another recruiter sees none of it.
 *
 * Email goes to a local HTTP mock; nothing leaves the machine.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestDb, applyTestEnv, makeClient } from './harness.mjs';

const DB_PORT = 5531;
const API_PORT = 9931;
const MOCK_PORT = 9831;
const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '../../web');

let dbh, server, base, raw;
let recruiter, other, admin;
const mail = [];
const IST_DT = /Applied on \d{2} [A-Z][a-z]{2} \d{4}, \d{1,2}:\d{2} (AM|PM) IST/;
const indiaDay = (ms) => new Date(ms + 330 * 60000).toISOString().slice(0, 10);
const TODAY = () => indiaDay(Date.now());

async function startMock() {
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch { json = { raw: body }; }
      mail.push({ url: req.url, body: json });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'mock_' + mail.length }));
    });
  });
  await new Promise((r) => srv.listen(MOCK_PORT, '127.0.0.1', r));
  return srv;
}
let mock;

let seq = 0;
async function job(title, recruiterId = 'rad1') {
  seq += 1;
  const id = `jad${seq}`;
  await raw(`insert into jobs (id, title, company_id, recruiter_id, location, mode, exp_label, pay_label,
                               salary_min, salary_max, employment_type, posting_kind, status, skills, description, published_at)
             values ($1,$2,'co_ad',$3,'Nellore','Onsite','2-4 yrs','₹4-6 LPA',4,6,'Full-time','job','open',$4,'A role.',now())`,
    [id, title, recruiterId, ['Java', 'Spring', 'SQL']]);
  return id;
}

async function candidate(name) {
  const c = makeClient(base);
  await c.get('/api/health');
  const email = `${name.toLowerCase().replace(/\W+/g, '.')}.${Date.now().toString(36)}@mailbox-teamlink-tests.in`;
  const r = await c.post('/api/auth/register', {
    name, email, password: 'Applied123on', phone: '9' + String(100000000 + Math.floor(Math.random() * 899999999)),
    preferredLocation: 'Nellore', expectedCtc: 5, noticePeriod: 'Immediate', preferredWorkModes: ['Work From Office'],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  c.id = r.body.candidateId;
  c.name = name;
  await raw(`update candidates set location='Nellore', skills=$2, resume_file='cv.pdf' where id=$1`, [c.id, ['Java', 'Spring']]);
  return c;
}

async function staff(id, email, role, table, extra = '') {
  const { hashPassword } = await import('../src/auth.js');
  const hash = await hashPassword('Staff123pass');
  const u = (await raw(`insert into users (email,password_hash,role) values ($1,$2,$3) returning id`, [email, hash, role])).rows[0].id;
  await raw(`insert into ${table} (id, name, email, ${extra ? 'company_id, ' : ''}user_id)
             values ($1,$2,$3,${extra ? `'${extra}', ` : ''}$4)`, [id, id.toUpperCase(), email, u]);
  const c = makeClient(base);
  await c.get('/api/health');
  assert.equal((await c.post('/api/auth/login', { email, password: 'Staff123pass', role })).status, 200);
  return c;
}

test('boot', async () => {
  dbh = await startTestDb(DB_PORT);
  mock = await startMock();
  applyTestEnv(dbh.url, {
    PUBLIC_ORIGIN: `http://127.0.0.1:${API_PORT}`,
    DISABLE_BACKGROUND_WORK: 'true',
    SMS_API_KEY: '', WHATSAPP_API_KEY: '',
    EMAIL_API_KEY: 'test-key',
    EMAIL_FROM: 'jobs@teamlink.example',
    EMAIL_API_URL: `http://127.0.0.1:${MOCK_PORT}/email`,
    EMAIL_SMTP_HOST: '', EMAIL_SMTP_USER: '', EMAIL_SMTP_PASS: '',
    EMAILJS_SERVICE_ID: '', EMAILJS_TEMPLATE_ID: '', EMAILJS_PUBLIC_KEY: '', EMAILJS_PRIVATE_KEY: '',
    OUTBOUND_ALLOWLIST: '',
    ONE_CLICK_HOLD_MARGIN_SECONDS: '0',
  });
  raw = (sql, params) => dbh.db.query(sql, params);
  await raw(`insert into companies (id, name) values ('co_ad', 'Acme Clinics')`);

  const { createApp } = await import('../src/app.js');
  const app = createApp({ serveStatic: WEB, logger: { error() {}, log() {} } });
  await new Promise((r) => { server = app.listen(API_PORT, r); });
  base = `http://127.0.0.1:${API_PORT}`;

  recruiter = await staff('rad1', 'rad1@mailbox-teamlink-tests.in', 'recruiter', 'recruiters', 'co_ad');
  other = await staff('rad2', 'rad2@mailbox-teamlink-tests.in', 'recruiter', 'recruiters', 'co_ad');
  admin = await staff('aad1', 'aad1@mailbox-teamlink-tests.in', 'admin', 'admins');
});

let J1, J2, J3, cand, cand2, app1;

test('one click creates one application: applied, TeamLink Portal, applied_at; never a second', async () => {
  J1 = await job('Staff Nurse');
  J2 = await job('Radiographer');
  J3 = await job('Lab Technician', 'rad2');
  cand = await candidate('Asha Verma');

  const first = await cand.post('/api/applications/one-click', { jobId: J1 });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  app1 = first.body.application;
  assert.equal(app1.candidateId, cand.id);
  assert.equal(app1.jobId, J1);
  assert.equal(app1.stage, 'applied');
  assert.equal(app1.source, 'teamlink');
  assert.ok(Date.parse(app1.appliedAt) > Date.now() - 60000, 'applied_at is now');

  const again = await cand.post('/api/applications/one-click', { jobId: J1 });
  assert.equal(again.status, 200);
  assert.equal(again.body.existing, true);
  assert.equal(again.body.application.id, app1.id);
  const plain = await cand.post('/api/applications', { jobId: J1 });
  assert.equal(plain.status, 409);
  assert.equal(plain.body.error?.code || plain.body.code, 'DUPLICATE_APPLICATION');
  const n = (await raw(`select count(*)::int n from applications where candidate_id=$1 and job_id=$2`, [cand.id, J1])).rows[0].n;
  assert.equal(n, 1);

  const src = (await raw(`select source_channel from applications where id=$1`, [app1.id])).rows[0].source_channel;
  assert.equal(src, 'TeamLink Website', 'the reports keep their source channel');
});

test('candidate notification: "You applied for <job>" with the applied date and time (IST)', async () => {
  const n = (await raw(`select title, message, metadata from notifications
                         where recipient_id=$1 and type='APPLICATION_SUBMITTED' and application_id=$2`, [cand.id, app1.id])).rows[0];
  assert.ok(n, 'notification written');
  assert.equal(n.title, 'You applied for Staff Nurse');
  assert.match(n.message, IST_DT);
  assert.ok(n.metadata.appliedAt);
  const mine = await cand.get('/api/notifications');
  assert.equal(mine.status, 200);
  const list = mine.body.notifications || mine.body;
  assert.ok(list.some((x) => x.title === 'You applied for Staff Nurse'), 'the candidate can read it');
});

test('recruiter / job owner notification: "<candidate> applied for <job>", applied on, TeamLink Portal, AI match', async () => {
  const n = (await raw(`select recipient_role, title, message, metadata from notifications
                         where recipient_id='rad1' and type='APPLICATION_RECEIVED' and application_id=$1`, [app1.id])).rows[0];
  assert.ok(n, 'recruiter notification written');
  assert.equal(n.recipient_role, 'recruiter');
  assert.equal(n.title, 'Asha Verma applied for Staff Nurse');
  assert.match(n.message, IST_DT);
  assert.match(n.message, /Came from: TeamLink Portal/);
  assert.equal(n.metadata.source, 'TeamLink Portal');
  const none = (await raw(`select count(*)::int n from notifications where recipient_id='rad2' and application_id=$1`, [app1.id])).rows[0].n;
  assert.equal(none, 0, 'another recruiter is not told');
});

test('the confirmation email: "You applied for <job>" with Applied on <date, time>', async () => {
  const before = mail.length;
  const r = await cand.post('/api/applications', { jobId: J2 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const deadline = Date.now() + 5000;
  let hit = null;
  while (!hit && Date.now() < deadline) {
    hit = mail.slice(before).find((m) => m.url.startsWith('/email') && /You applied for Radiographer/.test(String(m.body.subject || '')));
    if (!hit) await new Promise((x) => setTimeout(x, 100));
  }
  assert.ok(hit, 'email sent: ' + mail.slice(before).map((m) => m.body.subject).join(' | '));
  const text = JSON.stringify(hit.body);
  assert.match(text, /Applied on \d{2} [A-Z][a-z]{2} \d{4}, \d{1,2}:\d{2} (AM|PM) IST/);
});

test('applied_at cannot be edited through the API; maintenance SQL still can', async () => {
  const was = (await raw(`select applied_at from applications where id=$1`, [app1.id])).rows[0].applied_at;
  /* As the API's own role (app_api), the way every request reaches the database. */
  await dbh.db.exec(`begin;
    set local role app_api;
    select set_config('app.role', 'admin', true), set_config('app.user_id', '', true);
    update applications set applied_at = now() - interval '9 days', applied_on = current_date - 9 where id = '${app1.id}';
    commit;`);
  const now = (await raw(`select applied_at from applications where id=$1`, [app1.id])).rows[0].applied_at;
  assert.equal(new Date(now).toISOString(), new Date(was).toISOString(), 'an API session cannot move it');

  const moved = await recruiter.put(`/api/applications/${app1.id}/status`, { stage: 'shortlisted' });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.application.appliedAt, new Date(was).toISOString(), 'a stage move leaves it alone');
});

let old;
test('Applied Date filter on the recruiter list: India days, inclusive, combined with stage; sort both ways', async () => {
  cand2 = await candidate('Bala Krishna');
  old = (await cand2.post('/api/applications', { jobId: J1 })).body.application;
  /* Backdated the only way it can be: maintenance SQL. */
  await raw(`update applications set applied_at = now() - interval '5 days' where id=$1`, [old.id]);
  const fiveAgo = indiaDay(Date.now() - 5 * 86400000);

  const all = await recruiter.get('/api/applications?jobId=' + J1);
  assert.equal(all.body.total, 2);
  assert.equal(all.body.applications[0].id, app1.id, 'newest first by default');
  const asc = await recruiter.get('/api/applications?jobId=' + J1 + '&sort=applied_asc');
  assert.equal(asc.body.applications[0].id, old.id, 'oldest first when asked');

  const today = await recruiter.get(`/api/applications?jobId=${J1}&from=${TODAY()}&to=${TODAY()}`);
  assert.deepEqual(today.body.applications.map((a) => a.id), [app1.id]);
  const day5 = await recruiter.get(`/api/applications?jobId=${J1}&from=${fiveAgo}&to=${fiveAgo}`);
  assert.deepEqual(day5.body.applications.map((a) => a.id), [old.id], 'a single day');
  const range = await recruiter.get(`/api/applications?jobId=${J1}&from=${fiveAgo}&to=${TODAY()}&stage=applied`);
  assert.deepEqual(range.body.applications.map((a) => a.id), [old.id], 'AND with the stage filter');
  const bad = await recruiter.get(`/api/applications?jobId=${J1}&from=yesterday`);
  assert.equal(bad.body.total, 2, 'a malformed date is ignored, never an error');
});

test('role scoping: another recruiter sees none of these applications, even by date', async () => {
  const r = await other.get(`/api/applications?from=${indiaDay(Date.now() - 30 * 86400000)}&to=${TODAY()}`);
  assert.equal(r.status, 200);
  assert.ok(!r.body.applications.some((a) => a.jobId === J1 || a.jobId === J2), 'not theirs');
});

test('candidate history: Applied Date range and Latest / Oldest first', async () => {
  await raw(`update applications set applied_at = now() - interval '3 days' where candidate_id=$1 and job_id=$2`, [cand.id, J2]);
  const h = await cand.get('/api/candidate/applications/history');
  assert.deepEqual(h.body.rows.map((r) => r.jobId), [J1, J2], 'latest applied first');
  const o = await cand.get('/api/candidate/applications/history?sort=oldest');
  assert.deepEqual(o.body.rows.map((r) => r.jobId), [J2, J1], 'oldest first');
  const t = await cand.get(`/api/candidate/applications/history?from=${TODAY()}&to=${TODAY()}`);
  assert.deepEqual(t.body.rows.map((r) => r.jobId), [J1]);
  assert.equal(t.body.total, 1);
  const q = await cand.get(`/api/candidate/applications/history?from=${indiaDay(Date.now() - 7 * 86400000)}&to=${TODAY()}&q=radio`);
  assert.deepEqual(q.body.rows.map((r) => r.jobId), [J2], 'AND with the search');
  const step = h.body.rows[0].steps.find((s) => s.phase === 'applied');
  assert.ok(step && step.at, 'the Applied step carries its date');
});

test('Talent Pool: Applied on and Added on ranges', async () => {
  const range = `appliedFrom=${TODAY()}&appliedTo=${TODAY()}`;
  const r = await recruiter.get(`/api/candidates?${range}&limit=100`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const ids = (r.body.candidates || r.body.rows || []).map((c) => c.id);
  assert.ok(ids.includes(cand.id), 'applied today');
  assert.ok(!ids.includes(cand2.id), 'applied five days ago');
  const added = await recruiter.get(`/api/candidates?addedFrom=${TODAY()}&addedTo=${TODAY()}&limit=100`);
  const aids = (added.body.candidates || added.body.rows || []).map((c) => c.id);
  assert.ok(aids.includes(cand.id) && aids.includes(cand2.id), 'both registered today');
  const none = await recruiter.get(`/api/candidates?addedFrom=2020-01-01&addedTo=2020-01-31&limit=100`);
  assert.equal((none.body.candidates || none.body.rows || []).length, 0);
});

test('the profile timeline says "Applied for <job> on <date>"', async () => {
  const r = await recruiter.get(`/api/ats/candidates/${cand.id}/record`);
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
  const tl = r.body.record ? r.body.record.timeline : r.body.timeline;
  const ev = tl.find((e) => e.kind === 'applied' && e.job === 'Staff Nurse');
  assert.ok(ev, 'applied event');
  assert.equal(ev.label, 'Applied');
  assert.match(ev.text, /^Applied for Staff Nurse on \d{2} [A-Z][a-z]{2} \d{4}$/);
});

test('export: Applied On (IST date and time) and exactly the applications asked for', async () => {
  const r = await recruiter.post('/api/recruiter/candidates/export', {
    ids: [cand.id, cand2.id], scope: 'filtered', applicationIds: [old.id],
    columns: ['name', 'appliedFor', 'appliedOn', 'stage'], format: 'csv',
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const lines = String(r.body.raw).replace(/^﻿/, '').trim().split(/\r\n/);
  assert.equal(lines[0], 'Name,Applied For,Applied On,Stage');
  assert.equal(lines.length, 2, 'one filtered application, one row: ' + lines.join(' / '));
  assert.match(lines[1], /^Bala Krishna,Staff Nurse,"\d{2} [A-Z][a-z]{2} \d{4}, \d{1,2}:\d{2} (AM|PM) IST",applied$/);

  const legacy = await recruiter.post('/api/recruiter/candidates/export', {
    ids: [cand.id], scope: 'selected', columns: ['name', 'appliedOn'], format: 'csv',
  });
  assert.equal(legacy.status, 200);
  assert.match(String(legacy.body.raw), /Asha Verma,"\d{2} [A-Z][a-z]{2} \d{4}/, 'the per-candidate export also carries it');

  const foreign = await other.post('/api/recruiter/candidates/export', {
    ids: [cand.id], scope: 'filtered', applicationIds: [app1.id], columns: ['name', 'appliedOn'], format: 'csv',
  });
  assert.equal(String(foreign.body.raw).replace(/^﻿/, '').trim().split(/\r\n/).length, 1, 'another recruiter exports none of them');
});

test('Undo takes the recruiter notice with the application', async () => {
  const c3 = await candidate('Chitra Nair');
  const a = (await c3.post('/api/applications/one-click', { jobId: J3 })).body.application;
  const before = (await raw(`select count(*)::int n from notifications where recipient_id='rad2' and type='APPLICATION_RECEIVED' and application_id=$1`, [a.id])).rows[0].n;
  assert.equal(before, 1, 'the owner of J3 is told');
  const u = await c3.del('/api/applications/' + a.id);
  assert.equal(u.status, 200, JSON.stringify(u.body));
  const after = (await raw(`select count(*)::int n from notifications where application_id=$1`, [a.id])).rows[0].n;
  assert.equal(after, 0);
});

test('teardown', async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => mock.close(r));
  await dbh.stop?.();
  setTimeout(() => process.exit(0), 50).unref();
});
