/**
 * Admin numbers that were wrong.
 *
 *   - Recruiters & Teams -> Recruiters: "Applied 10115". An application assigned to a recruiter
 *     was counted once per job that recruiter owns (a join fan-out). Each application now counts
 *     once per recruiter.
 *   - Reports -> Pipeline funnel: only the CURRENT stage was counted, so an application the AI
 *     screened and sent back to Applied, or a walk-in whose candidate finished the AI interview,
 *     showed nowhere. GET /admin/pipeline-funnel counts every application at each step it reached.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb, applyTestEnv, makeClient } from './harness.mjs';

const DB_PORT = 5597;
const API_PORT = 9953;
const base = `http://127.0.0.1:${API_PORT}`;
const PW = 'Reports123counts';

let dbh, server, raw, admin, rec;
let seq = 0;

async function staff(email, role, table, id) {
  const { hashPassword } = await import('../src/auth.js');
  const hash = await hashPassword(PW);
  const u = (await raw(`insert into users (email,password_hash,role) values ($1,$2,$3) returning id`, [email, hash, role])).rows[0].id;
  if (table) await raw(`insert into ${table} (id, user_id, name, email, company_id) values ($1,$2,$3,$4,'co_rp')`, [id, u, `${role} ${id}`, email]);
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
    name: `Report Person ${seq}`, email: `report.${seq}.${Date.now().toString(36)}@mailbox-teamlink-tests.in`,
    password: PW, phone: '93100' + String(10000 + seq).slice(-5), preferredLocation: 'Hyderabad', expectedCtc: 4,
    noticePeriod: 'Immediate', preferredWorkModes: ['Hybrid'],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  c.id = r.body.candidateId;
  return c;
}

const job = (id, recruiter, extra = '') => raw(
  `insert into jobs (id, title, company_id, location, mode, exp_label, skills, status, recruiter_id, description, published_at ${extra ? ', posting_kind, walkin_date, walkin_from, walkin_to' : ''})
   values ($1, $2, 'co_rp', 'Hyderabad', 'Onsite', '1-3 yrs', $3, 'open', $4, 'Hire well.', now() ${extra})`,
  [id, `Role ${id}`, ['Sourcing'], recruiter]);
const apply = async (c, jobId) => {
  const r = await c.post('/api/applications', { jobId });
  assert.ok(r.status === 201 || r.status === 200, JSON.stringify(r.body));
  return r.body.application.id;
};

const C = {};
const A = {};

test('boot', async () => {
  dbh = await startTestDb(DB_PORT);
  applyTestEnv(dbh.url, {
    PUBLIC_ORIGIN: base, DISABLE_BACKGROUND_WORK: 'true', AI_API_KEY: '',
    EMAIL_API_KEY: '', EMAIL_SMTP_HOST: '', EMAIL_SMTP_USER: '', EMAIL_SMTP_PASS: '',
    EMAILJS_SERVICE_ID: '', EMAILJS_TEMPLATE_ID: '', EMAILJS_PUBLIC_KEY: '', EMAILJS_PRIVATE_KEY: '',
    SMS_API_KEY: '', WHATSAPP_API_KEY: '',
  });
  raw = (sql, params) => dbh.db.query(sql, params);
  await raw(`insert into companies (id, name) values ('co_rp', 'Report Co')`);
  const { createApp } = await import('../src/app.js');
  const app = createApp({ logger: { error() {}, log() {} } });
  await new Promise((r) => { server = app.listen(API_PORT, r); });

  admin = await staff('admin.rp@tl-sink.local', 'admin', null, null);
  rec = await staff('rec.rpa@tl-sink.local', 'recruiter', 'recruiters', 'r_rpa');
  await staff('rec.rpb@tl-sink.local', 'recruiter', 'recruiters', 'r_rpb');

  /* recruiter A owns three jobs; recruiter B one, and one walk-in */
  await job('j_rp1', 'r_rpa'); await job('j_rp2', 'r_rpa'); await job('j_rp3', 'r_rpa');
  await job('j_rpb', 'r_rpb');
  await job('j_rpw', 'r_rpb', `, 'walkin', to_char((now() at time zone 'Asia/Kolkata') + interval '5 days', 'YYYY-MM-DD'), '10:00', '16:00'`);

  for (const k of ['c1', 'c2', 'c3', 'c4']) C[k] = await candidate();
  A.c1 = await apply(C.c1, 'j_rp1');
  A.c2 = await apply(C.c2, 'j_rp2');
  A.c3 = await apply(C.c3, 'j_rpb');
  A.c4 = await apply(C.c4, 'j_rpb');
  /* one of B's applications is assigned to A */
  await raw(`update applications set recruiter_id = 'r_rpa' where id = $1`, [A.c3]);
  /* a walk-in registration (a walk-in's stages are walk-in stages) */
  await raw(`insert into applications (id, job_id, candidate_id, recruiter_id, posting_type, source)
             values ('app_rpw', 'j_rpw', $1, 'r_rpb', 'walkin', 'walkin')`, [C.c2.id]);
  A.w = 'app_rpw';
});

test('Recruiters: each application counts once per recruiter, however many jobs they own', async () => {
  const r = await admin.get('/api/staff/recruiters');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const a = r.body.recruiters.find((x) => x.id === 'r_rpa');
  const b = r.body.recruiters.find((x) => x.id === 'r_rpb');
  const sum = (x) => Object.values(x.stages).reduce((s, n) => s + n, 0);
  const truth = async (id) => (await raw(
    `select count(*)::int n from applications a
      where a.stage = any($2::text[])
        and (a.recruiter_id = $1 or exists (select 1 from jobs j where j.id = a.job_id and j.recruiter_id = $1))`,
    [id, Object.keys(a.stages)])).rows[0].n;
  /* A: two on their own jobs + one assigned = 3 (it was 3 x 3 jobs = 9 before) */
  assert.equal(sum(a), 3, JSON.stringify(a.stages));
  assert.equal(sum(a), await truth('r_rpa'));
  assert.equal(a.totalCandidates, 3);
  /* B: both on j_rpb (one now assigned to A is still on B's job) - the walk-in's "registered" is not a column */
  assert.equal(sum(b), await truth('r_rpb'));
  assert.equal(sum(b), 2, JSON.stringify(b.stages));
});

test('Pipeline funnel: every application counted at each step it reached', async () => {
  /* every regular application is screened when it is submitted (ai_screened_at) and stays at
     Applied unless shortlisted - the old funnel showed none of them under AI Screening */
  /* shortlisted once, then moved back - the history remembers */
  await raw(`update applications set stage = 'shortlisted' where id = $1`, [A.c3]);
  await raw(`update applications set stage = 'applied' where id = $1`, [A.c3]);
  /* the walk-in candidate finished the AI interview; a scheduled one is not attended */
  await raw(`insert into ai_interviews (id, application_id, candidate_id, job_id, status) values ('aiv_rp1', $1, $2, 'j_rpw', 'completed')`, [A.w, C.c2.id]);
  await raw(`insert into ai_interviews (id, application_id, candidate_id, job_id, status) values ('aiv_rp2', $1, $2, 'j_rp1', 'in_progress')`, [A.c1, C.c1.id]);

  let r = await admin.get('/api/admin/pipeline-funnel');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const n = (body, key) => body.reached.find((x) => x.key === key).count;
  assert.equal(n(r.body, 'applied'), 5);
  const screened = (await raw(`select count(*)::int n from applications where ai_screened_at is not null`)).rows[0].n;
  assert.equal(screened, 4, 'the four regular applications were screened on submit; the walk-in was not');
  assert.equal(n(r.body, 'ai_screened'), 4, 'screened and left at Applied still counts as screened');
  assert.equal(n(r.body, 'shortlisted'), 1, 'shortlisted once counts');
  assert.equal(n(r.body, 'ai_interview_attended'), 1, 'only the finished AI interview, not the one in progress');
  assert.equal(n(r.body, 'walkin_attended'), 0, 'a finished AI interview is not walk-in attendance');

  /* walk-in attendance only when it is recorded */
  await raw(`update applications set stage = 'attended' where id = $1`, [A.w]);
  r = await admin.get('/api/admin/pipeline-funnel');
  assert.equal(n(r.body, 'walkin_attended'), 1);
  const cur = Object.fromEntries(r.body.current.map((x) => [x.stage, x.count]));
  assert.equal(cur.applied, 4);
  assert.equal(cur.attended, 1);
  assert.equal(r.body.current.reduce((s, x) => s + x.count, 0), 5, 'where they are now adds up to every application');
});

test('the funnel is Admin only', async () => {
  assert.equal((await rec.get('/api/admin/pipeline-funnel')).status, 403);
  assert.equal((await C.c1.get('/api/admin/pipeline-funnel')).status, 403);
  const anon = makeClient(base); await anon.get('/api/health');
  assert.equal((await anon.get('/api/admin/pipeline-funnel')).status, 401);
});

test('shutdown', async () => {
  await new Promise((r) => server.close(r));
  const { stopBackgroundWork } = await import('../src/app.js');
  stopBackgroundWork();
  const { closePool } = await import('../src/db.js');
  await closePool();
  await dbh.stop?.();
});
