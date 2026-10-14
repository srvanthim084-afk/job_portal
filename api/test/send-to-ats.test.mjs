/**
 * Talent Pool -> "Send to ATS" (POST /api/ats/send-to-pipeline).
 *
 *   - a candidate with no application for the job: added, at Shortlisted, source 'rediscovery',
 *     recorded in the stage history ("Sent to ATS from the Talent Pool") - Admin's "Moved to ATS" counts it
 *   - one at Applied: moved up to Shortlisted; one further along: left where it is; nobody duplicated
 *   - no message to anyone unless asked; asked: exactly one "now Shortlisted" per candidate moved,
 *     and never the "application received" / AI interview invitation of a candidate's own application
 *   - walk-in, closed and external jobs refused; another company's recruiter cannot reach the job;
 *     a candidate cannot use it
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb, applyTestEnv, makeClient } from './harness.mjs';

const DB_PORT = 5607;
const API_PORT = 9965;
const base = `http://127.0.0.1:${API_PORT}`;
const PW = 'SendAts123test';

let dbh, server, raw, admin, rec, rec2;
let seq = 0;
const C = {};

async function staff(email, role, table, id, company) {
  const { hashPassword } = await import('../src/auth.js');
  const hash = await hashPassword(PW);
  const u = (await raw(`insert into users (email,password_hash,role) values ($1,$2,$3) returning id`, [email, hash, role])).rows[0].id;
  if (table) await raw(`insert into ${table} (id, user_id, name, email, company_id) values ($1,$2,$3,$4,$5)`, [id, u, `${role} ${id}`, email, company]);
  const c = makeClient(base);
  await c.get('/api/health');
  const r = await c.post('/api/auth/login', { email, password: PW, role });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return c;
}
async function candidate() {
  seq += 1;
  const c = makeClient(base);
  await c.get('/api/health');
  const r = await c.post('/api/auth/register', {
    name: `Pool Person ${seq}`, email: `pool.${seq}.${Date.now().toString(36)}@mailbox-teamlink-tests.in`,
    password: PW, phone: '93300' + String(10000 + seq).slice(-5), preferredLocation: 'Hyderabad', expectedCtc: 4,
    noticePeriod: 'Immediate', preferredWorkModes: ['Hybrid'],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  c.id = r.body.candidateId;
  return c;
}
const job = (id, recruiter, company, extra = {}) => raw(
  `insert into jobs (id, title, company_id, location, mode, exp_label, skills, status, recruiter_id, description, published_at, posting_kind, employment_type, walkin_date)
   values ($1, $2, $3, 'Hyderabad', 'Onsite', '1-3 yrs', $4, $5, $6, 'Hire well.', now(), $7, $8, $9)`,
  [id, `Role ${id}`, company, ['Sourcing'], extra.status || 'open', recruiter, extra.kind || 'job', extra.type || 'Full-time', extra.walkinDate || null]);
const appOf = async (cand, jobId) => (await raw(`select * from applications where candidate_id=$1 and job_id=$2`, [cand, jobId])).rows[0];
const send = (client, body) => client.post('/api/ats/send-to-pipeline', body);

test('boot', async () => {
  dbh = await startTestDb(DB_PORT);
  applyTestEnv(dbh.url, {
    PUBLIC_ORIGIN: base, DISABLE_BACKGROUND_WORK: 'true', AI_API_KEY: '',
    EMAIL_API_KEY: '', EMAIL_SMTP_HOST: '', EMAIL_SMTP_USER: '', EMAIL_SMTP_PASS: '',
    EMAILJS_SERVICE_ID: '', EMAILJS_TEMPLATE_ID: '', EMAILJS_PUBLIC_KEY: '', EMAILJS_PRIVATE_KEY: '',
    SMS_API_KEY: '', WHATSAPP_API_KEY: '',
  });
  raw = (sql, params) => dbh.db.query(sql, params);
  await raw(`insert into companies (id, name) values ('co_sa', 'Send Co'), ('co_sb', 'Other Co')`);
  const { createApp } = await import('../src/app.js');
  const app = createApp({ logger: { error() {}, log() {} } });
  await new Promise((r) => { server = app.listen(API_PORT, r); });
  admin = await staff('admin.sa@tl-sink.local', 'admin', null, null, null);
  rec = await staff('rec.sa@tl-sink.local', 'recruiter', 'recruiters', 'r_sa', 'co_sa');
  rec2 = await staff('rec.sb@tl-sink.local', 'recruiter', 'recruiters', 'r_sb', 'co_sb');
  await job('j_sa', 'r_sa', 'co_sa');
  await job('j_sa_walk', 'r_sa', 'co_sa', { kind: 'walkin', type: 'Walk-in', walkinDate: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10) });
  await job('j_sa_closed', 'r_sa', 'co_sa', { status: 'closed' });
  for (const k of ['a', 'b', 'c', 'd']) C[k] = await candidate();
  /* a: applied by themselves; c: already at interview */
  assert.equal((await C.a.post('/api/applications', { jobId: 'j_sa' })).status, 201);
  assert.equal((await C.c.post('/api/applications', { jobId: 'j_sa' })).status, 201);
  await raw(`update applications set stage = 'interview_scheduled' where candidate_id = $1 and job_id = 'j_sa'`, [C.c.id]);
});

test('added, moved up, left where it is - at Shortlisted, recorded, and nobody messaged', async () => {
  const before = (await raw(`select count(*)::int n from notification_deliveries`)).rows[0].n;
  const r = await send(rec, { jobId: 'j_sa', candidateIds: [C.a.id, C.b.id, C.c.id] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.added, r.body.moved, r.body.already, r.body.refused], [1, 1, 1, 0], JSON.stringify(r.body.results));
  const by = Object.fromEntries(r.body.results.map((x) => [x.candidateId, x]));
  assert.equal(by[C.b.id].outcome, 'added');
  assert.equal(by[C.a.id].outcome, 'moved');
  assert.equal(by[C.c.id].outcome, 'already');
  assert.match(by[C.b.id].reference || '', /^TL-APP-/);

  const a = await appOf(C.a.id, 'j_sa');
  const b = await appOf(C.b.id, 'j_sa');
  const c = await appOf(C.c.id, 'j_sa');
  assert.equal(a.ats_pushed_via, 'send_to_ats', 'moved up by the button: pushed');
  assert.equal(b.ats_pushed_via, 'send_to_ats', 'added by the button: pushed');
  assert.equal(c.ats_pushed_via, null, 'left where it was: not pushed');
  assert.equal(a.stage, 'shortlisted');
  assert.equal(b.stage, 'shortlisted');
  assert.equal(b.source, 'rediscovery');
  assert.equal(c.stage, 'interview_scheduled', 'further along: untouched');
  const h = (await raw(`select note from application_stage_history where application_id = $1 and to_stage = 'shortlisted'`, [b.id])).rows[0];
  assert.equal(h.note, 'Sent to ATS from the Talent Pool');

  /* nobody messaged: no deliveries at all, no status notification, no AI interview invitation */
  assert.equal((await raw(`select count(*)::int n from notification_deliveries`)).rows[0].n, before);
  assert.equal((await raw(`select count(*)::int n from notifications where recipient_id = any($1) and type = 'APPLICATION_STATUS'`, [[C.a.id, C.b.id]])).rows[0].n, 0);

  /* again: nothing changes, nothing is duplicated */
  const again = await send(rec, { jobId: 'j_sa', candidateIds: [C.a.id, C.b.id] });
  assert.equal(again.body.already, 2);
  assert.equal((await raw(`select count(*)::int n from applications where job_id = 'j_sa' and candidate_id = $1`, [C.b.id])).rows[0].n, 1);
});

test('"Let the candidates know": exactly one Shortlisted message each', async () => {
  const r = await send(rec, { jobId: 'j_sa', candidateIds: [C.d.id], notify: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.added, 1);
  assert.equal(r.body.notified, 1);
  const n = (await raw(`select title, message from notifications where recipient_id = $1 and type = 'APPLICATION_STATUS'`, [C.d.id])).rows;
  assert.equal(n.length, 1);
  assert.doesNotMatch(n[0].message, /Send Co|client/i, 'the company is not named to the candidate');
  const d = (await raw(`select distinct event from notification_deliveries where candidate_id = $1`, [C.d.id])).rows.map((x) => x.event);
  assert.deepEqual(d, ['STAGE_CHANGED'], 'only the status message - never the "application received" or AI invitation');
});

test('walk-in, closed and other recruiters\' jobs are refused; candidates cannot use it', async () => {
  const w = await send(rec, { jobId: 'j_sa_walk', candidateIds: [C.b.id] });
  assert.equal(w.status, 409, JSON.stringify(w.body));
  assert.match(w.body.error.message, /walk-in/i);
  const cl = await send(rec, { jobId: 'j_sa_closed', candidateIds: [C.b.id] });
  assert.equal(cl.status, 409);
  const other = await send(rec2, { jobId: 'j_sa', candidateIds: [C.b.id] });
  assert.ok(other.status === 404 || other.status === 403, `another company's recruiter: ${other.status}`);
  assert.equal((await send(C.a, { jobId: 'j_sa', candidateIds: [C.b.id] })).status, 403);
  assert.equal((await send(rec, { jobId: 'j_sa', candidateIds: [] })).status, 422);
});

test('Applications page: moved to Shortlisted; further along left; walk-in refused; nobody messaged unless asked', async () => {
  await job('j_sa2', 'r_sa', 'co_sa');
  const mk = async (stage) => {
    const c = await candidate();
    const r = await c.post('/api/applications', { jobId: 'j_sa2' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const id = r.body.application.id;
    if (stage !== 'applied') await raw(`update applications set stage = $2 where id = $1`, [id, stage]);
    return { c, id };
  };
  const e = await mk('applied');
  const f = await mk('ai_interview_done');
  const g = await mk('offer_extended');
  const w = await candidate();
  await raw(`insert into applications (id, job_id, candidate_id, recruiter_id, posting_type, source) values ('app_sa_walk', 'j_sa_walk', $1, 'r_sa', 'walkin', 'walkin')`, [w.id]);

  const before = (await raw(`select count(*)::int n from notifications where type = 'APPLICATION_STATUS'`)).rows[0].n;
  const r = await rec.post('/api/ats/send-applications', { applicationIds: [e.id, f.id, g.id, 'app_sa_walk', 'app_does_not_exist'] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.moved, r.body.already, r.body.refused], [2, 1, 2], JSON.stringify(r.body.results));
  const st = async (id) => (await raw(`select stage from applications where id = $1`, [id])).rows[0].stage;
  assert.equal(await st(e.id), 'shortlisted');
  assert.equal(await st(f.id), 'shortlisted');
  assert.equal(await st(g.id), 'offer_extended', 'further along: untouched');
  assert.equal(await st('app_sa_walk'), 'registered', 'a walk-in registration is not moved from here');
  const h = (await raw(`select note from application_stage_history where application_id = $1 and to_stage = 'shortlisted'`, [e.id])).rows[0];
  assert.equal(h.note, 'Sent to ATS from Applications');
  assert.equal((await raw(`select count(*)::int n from notifications where type = 'APPLICATION_STATUS'`)).rows[0].n, before, 'nobody messaged');

  assert.equal((await raw(`select ats_pushed_via from applications where id = $1`, [e.id])).rows[0].ats_pushed_via, 'send_to_ats');
  /* a recruiter moving an application to Shortlisted by hand is not a push - and moving it back and
     pushing again does not rewrite the first push */
  const hand = await mk('applied');
  const mv = await rec.put(`/api/applications/${hand.id}/status`, { stage: 'shortlisted' });
  assert.equal(mv.status, 200, JSON.stringify(mv.body));
  assert.equal((await raw(`select ats_pushed_at from applications where id = $1`, [hand.id])).rows[0].ats_pushed_at, null, 'by hand: no badge');
  const firstPush = (await raw(`select ats_pushed_at from applications where id = $1`, [e.id])).rows[0].ats_pushed_at;
  await raw(`update applications set stage = 'applied' where id = $1`, [e.id]);
  await rec.post('/api/ats/send-applications', { applicationIds: [e.id] });
  assert.equal(new Date((await raw(`select ats_pushed_at from applications where id = $1`, [e.id])).rows[0].ats_pushed_at).getTime(), new Date(firstPush).getTime(), 'the first push stands');
  /* again: nothing moves twice */
  const again = await rec.post('/api/ats/send-applications', { applicationIds: [e.id, f.id] });
  assert.deepEqual([again.body.moved, again.body.already], [0, 2]);

  /* asked: one message each, only for those moved */
  const h2 = await mk('applied');
  const told = await rec.post('/api/ats/send-applications', { applicationIds: [h2.id], notify: true });
  assert.equal(told.body.moved, 1);
  assert.equal(told.body.notified, 1);
  assert.equal((await raw(`select count(*)::int n from notifications where recipient_id = $1 and type = 'APPLICATION_STATUS'`, [h2.c.id])).rows[0].n, 1);

  /* who may: another company's recruiter reaches nothing; a candidate is refused; an empty list is a 422 */
  const k = await mk('applied');
  const other = await rec2.post('/api/ats/send-applications', { applicationIds: [k.id] });
  assert.ok(other.status === 200 && other.body.moved === 0 && other.body.refused === 1, JSON.stringify(other.body));
  assert.equal(await st(k.id), 'applied');
  assert.equal((await k.c.post('/api/ats/send-applications', { applicationIds: [k.id] })).status, 403);
  assert.equal((await rec.post('/api/ats/send-applications', { applicationIds: [] })).status, 422);
});

test('Admin -> Availability counts them as Moved to ATS', async () => {
  const s = await admin.get('/api/admin/availability/summary');
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.ok(s.body.summary.movedToAts >= 3, JSON.stringify(s.body.summary));
});

test('shutdown', async () => {
  await new Promise((r) => server.close(r));
  const { stopBackgroundWork } = await import('../src/app.js');
  stopBackgroundWork();
  const { closePool } = await import('../src/db.js');
  await closePool();
  await dbh.stop?.();
});
