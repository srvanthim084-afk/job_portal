/**
 * 0125: who created a job and when it went live or came down; the
 * recruiter-only Audit Log with time in portal and the 30-minute idle
 * sign-out; the public count of registered candidates.
 *
 * Real Postgres (PGlite) with row level security on, driven through the API
 * as the browser drives it. Idle time is made by moving the recorded
 * activity back in the database - the rule under test is the server's, so
 * nothing about it is mocked.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb, applyTestEnv, makeClient } from './harness.mjs';

const PORT = 5531;
const API_PORT = 9931;
const BASE = `http://127.0.0.1:${API_PORT}`;
const PW = 'TestPass123';

let dbHandle, server;
let admin, r1, r2, cand, anon;
const U = {};                       // user ids: a1, r1, r2, cand1
const raw = (sql, params) => dbHandle.db.query(sql, params);
const rows = async (sql, params) => (await raw(sql, params)).rows;

async function signIn(email) {
  const c = makeClient(BASE);
  const res = await c.post('/api/auth/login', { email, password: PW });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return c;
}
const activity = (q = '') => admin.get('/api/admin/recruiter-activity' + (q ? '?' + q : ''));
const auditFor = async (jobId) => (await rows(
  `select action, actor_user_id from audit_log where entity = 'job' and entity_id = $1 order by id`, [jobId]));

/** The page's own classification, run on the API's own job list. */
async function jobStats() {
  globalThis.window = globalThis.window || {};
  if (!window.TLJobStats) await import('../../web/teamlink-job-stats.js');
  return window.TLJobStats;
}

test('boot: migrate, accounts, API', async () => {
  dbHandle = await startTestDb(PORT, { demoSeed: true });
  applyTestEnv(dbHandle.url, { RECRUITER_IDLE_MINUTES: '30' });
  const { createApp } = await import('../src/app.js');
  const { hashPassword } = await import('../src/auth.js');
  const hash = await hashPassword(PW);
  for (const [table, role, id] of [
    ['admins', 'admin', 'a1'], ['recruiters', 'recruiter', 'r1'], ['recruiters', 'recruiter', 'r2'],
    ['candidates', 'candidate', 'cand1'],
  ]) {
    const u = await raw(`insert into users (email,password_hash,role) values ($1,$2,$3) returning id`,
      [`${id}@activity.test`, hash, role]);
    await raw(`update ${table} set user_id=$1 where id=$2`, [u.rows[0].id, id]);
    U[id] = u.rows[0].id;
  }
  const app = createApp({ logger: { error() {}, log() {} } });
  await new Promise((r) => { server = app.listen(API_PORT, r); });
  admin = await signIn('a1@activity.test');
  cand = await signIn('cand1@activity.test');
  anon = makeClient(BASE);
});

/* ------------------------------------------------------------------ *
 * 1. jobs: creator, dates, lifecycle
 * ------------------------------------------------------------------ */
const JOB = (title, over = {}) => ({ title, companyId: 'technova', location: 'Pune', type: 'Full-time', ...over });

test('a job records who created it and when, and every step of its life', async () => {
  r1 = await signIn('r1@activity.test');
  const made = await r1.post('/api/jobs', JOB('Lifecycle Draft', { status: 'draft' }));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const j = made.body.job;
  assert.equal(j.createdById, U.r1);
  assert.equal(j.createdByName, 'Kavya Reddy');
  assert.ok(j.createdAt && !Number.isNaN(Date.parse(j.createdAt)));
  assert.equal(j.publishedAt, null, 'a draft has no Published On');
  const [db] = await rows(`select created_by, created_at from jobs where id = $1`, [j.id]);
  assert.equal(db.created_by, U.r1, 'created_by is stored');
  assert.ok(db.created_at);

  const pub = (await r1.post(`/api/jobs/${j.id}/publish`, { publish: true })).body.job;
  assert.equal(pub.status, 'open');
  assert.ok(pub.publishedAt);
  assert.equal(pub.unpublishedAt, null);

  const down = (await r1.post(`/api/jobs/${j.id}/publish`, { publish: false })).body.job;
  assert.equal(down.status, 'draft');
  assert.equal(down.publishedAt, pub.publishedAt, 'the first publication is kept');
  assert.ok(down.unpublishedAt, 'unpublishing is dated');

  const again = (await r1.post(`/api/jobs/${j.id}/publish`, { publish: true })).body.job;
  assert.equal(again.unpublishedAt, null, 'live again: no unpublished date');
  const closed = (await r1.put(`/api/jobs/${j.id}`, JOB('Lifecycle Draft', { status: 'closed' }))).body.job;
  assert.equal(closed.status, 'closed');
  assert.ok(closed.unpublishedAt, 'closing is dated');

  assert.deepEqual((await auditFor(j.id)).map((x) => x.action),
    ['job.created', 'job.draft_saved', 'job.published', 'job.unpublished', 'job.published', 'job.closed']);
  assert.ok((await auditFor(j.id)).every((x) => x.actor_user_id === U.r1), 'each step is the recruiter\'s');
});

test('a job saved as open through the edit form gets a Published On', async () => {
  const j = (await r1.post('/api/jobs', JOB('Draft Then Open', { status: 'draft' }))).body.job;
  const open = (await r1.put(`/api/jobs/${j.id}`, JOB('Draft Then Open', { status: 'open' }))).body.job;
  assert.ok(open.publishedAt);
});

test('Last Updated is the last change a person made, and by whom; the creator never changes', async () => {
  const j = (await r1.post('/api/jobs', JOB('Edited Role', { status: 'open' }))).body.job;
  const before = (await r1.get(`/api/jobs/${j.id}`)).body.job;
  await raw(`update jobs set last_edited_at = now() - interval '1 hour' where id = $1`, [j.id]);

  const edited = (await admin.put(`/api/jobs/${j.id}`, JOB('Edited Role (admin)', { status: 'open' }))).body.job;
  assert.equal(edited.lastEditedById, U.a1);
  assert.equal(edited.lastEditedByName, 'Admin User');
  assert.ok(Date.parse(edited.lastEditedAt) > Date.now() - 60_000);
  assert.equal(edited.createdById, U.r1, 'an edit does not change the creator');
  assert.equal(edited.createdByName, before.createdByName);
  assert.ok((await auditFor(j.id)).some((x) => x.action === 'job.updated' && x.actor_user_id === U.a1));

  /* background work is not an edit */
  const stamp = (await rows(`select last_edited_at from jobs where id = $1`, [j.id]))[0].last_edited_at;
  await raw(`update jobs set urgent_alerted_at = now() where id = $1`, [j.id]);
  const after = (await rows(`select last_edited_at from jobs where id = $1`, [j.id]))[0].last_edited_at;
  assert.equal(after.getTime(), stamp.getTime());
});

test('the public job shape carries no staff names; staff see the record', async () => {
  const j = (await r1.post('/api/jobs', JOB('Public Role', { status: 'open' }))).body.job;
  for (const who of [cand, anon]) {
    const seen = await who.get(`/api/jobs/${j.id}`);
    assert.equal(seen.status, 200);
    assert.ok(!('createdByName' in seen.body.job) && !('createdById' in seen.body.job) && !('lastEditedByName' in seen.body.job));
  }
  const boot = (await r1.get('/api/bootstrap')).body.data;
  const mine = boot.jobs.find((x) => x.id === j.id);
  assert.equal(mine.createdByName, 'Kavya Reddy');
  assert.ok(mine.createdAt && mine.publishedAt);
  const pub = (await anon.get('/api/bootstrap')).body.data.jobs.find((x) => x.id === j.id);
  assert.ok(pub && !('createdByName' in pub));
});

test('the cards: Total = Published + Not Published + Draft, from the real job list', async () => {
  const S = await jobStats();
  const jobs = (await admin.get('/api/bootstrap')).body.data.jobs;
  const c = S.counts(jobs);
  assert.equal(c.all, jobs.length);
  assert.equal(c.all, c.published + c.not_published + c.draft);
  const byId = Object.fromEntries(jobs.map((x) => [x.title, S.lifecycle(x)]));
  assert.equal(byId['Lifecycle Draft'], 'not_published', 'published once, now closed');
  assert.equal(byId['Public Role'], 'published');
  const draft = (await r1.post('/api/jobs', JOB('Never Published', { status: 'draft' }))).body.job;
  assert.equal(S.lifecycle(draft), 'draft');
  const unpub = (await r1.post(`/api/jobs/${(await r1.post('/api/jobs', JOB('Up And Down', { status: 'open' }))).body.job.id}/publish`, { publish: false })).body.job;
  assert.equal(unpub.status, 'draft');
  assert.equal(S.lifecycle(unpub), 'not_published', 'a draft that was published is Not Published, not Draft');
  /* the same counts as the database's own rule */
  const [db] = await rows(`select
      count(*) filter (where status = 'open' and not paused and not archived and (expires_at is null or expires_at > now()))::int published,
      count(*) filter (where status = 'draft' and published_at is null and unpublished_at is null)::int draft,
      count(*)::int total from jobs`);
  const now = S.counts((await admin.get('/api/bootstrap')).body.data.jobs);
  assert.equal(now.published, db.published);
  assert.equal(now.draft, db.draft);
  assert.equal(now.all, db.total);
});

/* ------------------------------------------------------------------ *
 * 2. sessions and the recruiter-only Audit Log
 * ------------------------------------------------------------------ */
test('sign-in and sign-out are logged, with time in portal on the Logout row', async () => {
  r2 = await signIn('r2@activity.test');
  const open = await rows(`select * from portal_sessions where user_id = $1 and logout_at is null`, [U.r2]);
  assert.equal(open.length, 1);
  assert.equal(open[0].login_method, 'password');

  let page = (await activity(`recruiter=${U.r2}`)).body;
  const login = page.rows.find((x) => x.code === 'auth.login');
  assert.ok(login, 'the Login row');
  assert.equal(login.recruiter.name, 'Nikhil Bhatt');
  assert.equal(login.module, 'Portal');
  assert.equal(login.timeInPortal.active, true);
  assert.equal(login.timeInPortal.label, 'Active now');
  assert.ok(page.summary.activeNow >= 1);
  assert.ok(page.summary.byRecruiter.some((x) => x.userId === U.r2 && x.active));

  /* 2h 05m in the portal */
  await raw(`update portal_sessions set login_at = now() - interval '2 hours 5 minutes' where user_id = $1 and logout_at is null`, [U.r2]);
  assert.equal((await r2.post('/api/auth/logout')).status, 200);
  page = (await activity(`recruiter=${U.r2}&action=auth.logout`)).body;
  assert.equal(page.total, 1);
  assert.equal(page.rows[0].action, 'Logout');
  assert.equal(page.rows[0].timeInPortal.label, '2h 05m');
  assert.equal(page.rows[0].session.endReason, 'logout');
  assert.ok(page.rows[0].session.ip, 'IP for the detail view');
  const today = page.summary.byRecruiter.find((x) => x.userId === U.r2);
  assert.ok(today.weekSeconds >= 2 * 3600, 'counted in the week');
  assert.equal((await rows(`select count(*)::int n from portal_sessions where user_id = $1 and logout_at is null`, [U.r2]))[0].n, 0);
});

test('30 minutes idle: the next request is refused and the session ends at the last activity', async () => {
  r2 = await signIn('r2@activity.test');
  const last = (await rows(`update portal_sessions set last_activity_at = now() - interval '31 minutes',
                                   login_at = now() - interval '40 minutes'
                              where user_id = $1 and logout_at is null returning last_activity_at`, [U.r2]))[0].last_activity_at;
  await raw(`update sessions set last_seen_at = $2 where user_id = $1`, [U.r2, last]);

  const res = await r2.get('/api/candidates');
  assert.equal(res.status, 401, 'signed out by the server');
  assert.equal(res.body.error.code, 'SESSION_EXPIRED');
  const [ps] = await rows(`select * from portal_sessions where user_id = $1 order by id desc limit 1`, [U.r2]);
  assert.equal(ps.end_reason, 'auto_timeout');
  assert.equal(ps.logout_at.getTime(), last.getTime(), 'logout = last activity');
  const [row] = await rows(`select * from audit_log where action = 'auth.auto_logout' and entity_id = $1`, [String(ps.id)]);
  assert.equal(row.created_at.getTime(), last.getTime(), 'the row is dated at the last activity');
  assert.equal((await rows(`select count(*)::int n from sessions where user_id = $1`, [U.r2]))[0].n, 0, 'the token is gone');

  const page = (await activity(`recruiter=${U.r2}&action=auth.auto_logout`)).body;
  const mine = page.rows.find((x) => x.session && x.session.id === String(ps.id));
  assert.equal(mine.action, 'Auto logged out');
  assert.equal(mine.timeInPortal.label, '9m', 'login to last activity');
});

test('a closed browser: the sweep signs the session out at its last activity', async () => {
  const { sweepIdleSessions } = await import('../src/auth.js');
  r2 = await signIn('r2@activity.test');
  const last = (await rows(`update portal_sessions set last_activity_at = now() - interval '45 minutes',
                                   login_at = now() - interval '75 minutes'
                              where user_id = $1 and logout_at is null returning last_activity_at`, [U.r2]))[0].last_activity_at;
  await raw(`update sessions set last_seen_at = $2 where user_id = $1`, [U.r2, last]);

  assert.ok(await sweepIdleSessions() >= 1);
  const [ps] = await rows(`select * from portal_sessions where user_id = $1 order by id desc limit 1`, [U.r2]);
  assert.equal(ps.end_reason, 'auto_timeout');
  assert.equal(ps.logout_at.getTime(), last.getTime());
  assert.equal((await rows(`select count(*)::int n from sessions where user_id = $1`, [U.r2]))[0].n, 0);
  assert.equal((await r2.get('/api/candidates')).status, 401);
  const row = (await activity(`recruiter=${U.r2}&action=auth.auto_logout`)).body.rows.find((x) => x.session && x.session.id === String(ps.id));
  assert.equal(row.timeInPortal.label, '30m', 'login to last activity');
  assert.equal(await sweepIdleSessions(), 0, 'nothing left to close');
});

test('activity keeps a session alive; a session from before 0125 is picked up once', async () => {
  r2 = await signIn('r2@activity.test');
  await raw(`update sessions set last_seen_at = now() - interval '29 minutes' where user_id = $1`, [U.r2]);
  assert.equal((await r2.get('/api/candidates')).status, 200);
  const [s] = await rows(`select last_seen_at from sessions where user_id = $1`, [U.r2]);
  assert.ok(Date.now() - s.last_seen_at.getTime() < 60_000, 'the request counted as activity');

  await raw(`update sessions set portal_session_id = null, last_seen_at = null where user_id = $1`, [U.r2]);
  assert.equal((await r2.get('/api/candidates')).status, 200);
  assert.equal((await rows(`select count(*)::int n from audit_log where action = 'auth.session_resumed' and actor_user_id = $1`, [U.r2]))[0].n, 1);
  await r2.post('/api/auth/logout');
});

test('the log is recruiters only - at the query, whatever is asked', async () => {
  /* an administrator, a candidate and the system all act */
  const adminJob = (await admin.post('/api/jobs', JOB('Admin Posted Role', { status: 'open' }))).body.job;
  assert.ok((await auditFor(adminJob.id)).some((x) => x.actor_user_id === U.a1), 'the admin\'s action is in the raw log');
  await raw(`update jobs set status = 'closed' where id = $1`, [adminJob.id]);           // system

  const all = [];
  for (let p = 1; ; p += 1) {
    const page = (await activity(`page=${p}&pageSize=100`)).body;
    all.push(...page.rows);
    if (p * page.pageSize >= page.total) break;
  }
  assert.ok(all.length > 0);
  const recruiterIds = new Set([U.r1, U.r2]);
  assert.ok(all.every((x) => recruiterIds.has(x.recruiter.userId)), 'only recruiter accounts');
  assert.ok(!all.some((x) => x.target && x.target.id === adminJob.id), 'nothing about the admin\'s job');
  assert.equal((await activity(`recruiter=${U.a1}`)).body.total, 0, 'asking for the admin finds nothing');
  assert.equal((await activity(`recruiter=${U.cand1}`)).body.total, 0);
  assert.equal((await rows(`select count(*)::int n from portal_sessions where user_id in ($1, $2)`, [U.a1, U.cand1]))[0].n, 0,
    'admin and candidate sign-ins are not tracked');

  const list = (await activity()).body;
  assert.deepEqual(list.recruiters.map((x) => x.userId).sort(), [U.r1, U.r2].sort());
  assert.ok(list.actions.some((a) => a.code === 'auth.login' && a.label === 'Login'));

  assert.equal((await r1.get('/api/admin/recruiter-activity')).status, 403);
  assert.equal((await anon.get('/api/admin/recruiter-activity')).status, 401);
});

test('candidate shortlisted, the filters, newest first, pages and the CSV', async () => {
  const moved = await r1.put('/api/applications/app_seed_cand4/status', { stage: 'shortlisted' });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  const sl = (await activity('action=candidate.shortlisted')).body;
  assert.equal(sl.total, 1);
  assert.equal(sl.rows[0].action, 'Candidate shortlisted');
  assert.equal(sl.rows[0].recruiter.userId, U.r1);
  assert.equal(sl.rows[0].module, 'Applications');

  const pub = (await activity('action=job.published')).body;
  assert.ok(pub.total >= 3 && pub.rows.every((x) => x.code === 'job.published'));
  assert.ok(pub.rows[0].target.name, 'the job is named');

  const page1 = (await activity('pageSize=5')).body;
  assert.equal(page1.rows.length, 5);
  for (let i = 1; i < page1.rows.length; i += 1) assert.ok(page1.rows[i - 1].at >= page1.rows[i].at, 'latest first');
  const page2 = (await activity('pageSize=5&page=2')).body;
  assert.ok(!page2.rows.some((x) => page1.rows.find((y) => y.id === x.id)));

  const tomorrow = new Date(Date.now() + 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  assert.equal((await activity(`from=${tomorrow}`)).body.total, 0);
  assert.equal((await activity(`from=${today}&to=${today}`)).body.total, (await activity()).body.total);

  const csv = await admin.get('/api/admin/recruiter-activity/export?action=auth.logout');
  assert.equal(csv.status, 200);
  const text = csv.body.raw;
  assert.match(text, /Date and Time \(IST\),Recruiter,Action,Job \/ Module,Time in Portal/);
  assert.match(text, /Nikhil Bhatt,Logout,Portal,2h 05m/);
});

/* ------------------------------------------------------------------ *
 * 3. registered candidates, numbers only
 * ------------------------------------------------------------------ */
test('the public count is three numbers and follows registrations', async () => {
  const first = await anon.get('/api/public/candidate-stats');
  assert.equal(first.status, 200);
  assert.deepEqual(Object.keys(first.body).sort(), ['activeJobs', 'newThisWeek', 'registeredCandidates']);
  assert.ok(Object.values(first.body).every((v) => Number.isInteger(v)));
  const [db] = await rows(`select count(*)::int n from candidates c join users u on u.id = c.user_id
                            where u.role = 'candidate' and u.status = 'active'`);
  assert.equal(first.body.registeredCandidates, db.n);
  assert.equal(first.body.activeJobs, (await rows(`select count(*)::int n from jobs_open`))[0].n);

  /* a profile a recruiter added is not a registration */
  await raw(`insert into candidates (id, name, email) values ('cand_staff_added', 'Added By Staff', 'staff.added@activity.test')`);
  assert.equal((await anon.get('/api/public/candidate-stats')).body.registeredCandidates, db.n);

  /* registering is */
  const reg = makeClient(BASE);
  await reg.get('/api/health');
  const made = await reg.post('/api/auth/register', {
    name: 'New Registrant', email: `new.${Date.now()}@activity.test`, password: 'Regist3r9pass',
    phone: '9' + String(100000000 + Math.floor(Math.random() * 899999999)),
    preferredLocation: 'Hyderabad', expectedCtc: 5, noticePeriod: 'Immediate', preferredWorkModes: ['Office'],
    consent: { terms: true, communication: true, resumeProcessing: true },
  });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const next = (await anon.get('/api/public/candidate-stats')).body;
  assert.equal(next.registeredCandidates, db.n + 1);
  assert.equal(next.newThisWeek, first.body.newThisWeek + 1);
});

test('shutdown', async () => {
  const { stopBackgroundWork } = await import('../src/app.js');
  stopBackgroundWork();
  await new Promise((r) => server.close(r));
  const { closePool } = await import('../src/db.js');
  await closePool();
  await dbHandle.stop();
});
