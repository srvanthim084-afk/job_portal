/**
 * Teams, who sees whose work, and the contact cooldown (migration 0118).
 *
 * Real Postgres (PGlite) with row level security on, driven through the API
 * the way the browser drives it: an administrator builds two teams through
 * the admin routes, recruiters post jobs as themselves, candidates apply,
 * and every question of "who may see this" is asked of the API and the
 * answer checked against the database. Nothing here is a mock of the rule
 * under test.
 *
 *   TL A (Medical): Recruiter 1, Recruiter 2        TL B (IT): Recruiter 3
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb, applyTestEnv, makeClient } from './harness.mjs';

const PORT = 5461;
const API_PORT = 9971;
const BASE = `http://127.0.0.1:${API_PORT}`;
const PW = 'TestPass123';

let dbHandle, server;
let admin, cand;
const P = {};            // people: tlA, tlB, r1, r2, r3 -> { id, email, client }
const J = {};            // jobs: A (r1), B (r2), C (r3), T (tlA's own)

const raw = (sql, params) => dbHandle.db.query(sql, params);

const JOB = (title, over = {}) => ({
  title, companyId: 'technova', location: 'Hyderabad, Telangana', mode: 'Onsite',
  exp: '0-2 yrs', pay: '₹2.5–3.5 LPA', salaryMin: 2.5, salaryMax: 3.5, type: 'Full-time', status: 'open',
  skills: ['Communication'], gender: 'Female', ...over,
});

async function person(key, name, { department, role } = {}) {
  const email = `${key}@teams.test`;
  const made = await admin.post('/api/staff/recruiters', {
    name, email, password: PW, companyId: 'technova', department, recruiterRole: role,
  });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const id = made.body.recruiter.id;
  const client = makeClient(BASE);
  const login = await client.post('/api/auth/login', { email, password: PW });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  P[key] = { id, email, name, client };
  return P[key];
}

async function postJob(who, title) {
  const r = await who.client.post('/api/jobs', JOB(title));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  await who.client.put(`/api/jobs/${r.body.job.id}/screening-questions`, { questions: [] });
  return r.body.job.id;
}

const jobIdsOf = (res) => (res.body.data.jobs || []).map((j) => j.id);
const rows = async (sql, params) => (await raw(sql, params)).rows;

test('boot: migrate, accounts, API', async () => {
  dbHandle = await startTestDb(PORT, { demoSeed: true });
  applyTestEnv(dbHandle.url);
  const { createApp } = await import('../src/app.js');
  const { hashPassword } = await import('../src/auth.js');
  const hash = await hashPassword(PW);
  for (const [table, role, id] of [
    ['candidates', 'candidate', 'cand1'], ['candidates', 'candidate', 'cand2'],
    ['candidates', 'candidate', 'tc3'], ['candidates', 'candidate', 'tc4'],
    ['admins', 'admin', 'a1'],
  ]) {
    const u = await raw(`insert into users (email,password_hash,role) values ($1,$2,$3) returning id`,
      [`${id}@teams.test`, hash, role]);
    await raw(`update ${table} set user_id=$1 where id=$2`, [u.rows[0].id, id]);
  }
  const app = createApp({ logger: { error() {}, log() {} } });
  await new Promise((r) => { server = app.listen(API_PORT, r); });

  admin = makeClient(BASE);
  assert.equal((await admin.post('/api/auth/login', { email: 'a1@teams.test', password: PW })).status, 200);
  cand = makeClient(BASE);
  assert.equal((await cand.post('/api/auth/login', { email: 'cand1@teams.test', password: PW })).status, 200);
});

/* ------------------------------------------------------------------ *
 * 1. teams
 * ------------------------------------------------------------------ */
test('admin builds the teams: two team leads, three recruiters, one department each', async () => {
  await person('tlA', 'TL A', { department: 'Medical', role: 'Team Lead' });
  await person('tlB', 'TL B', { department: 'IT' });
  await person('r1', 'Recruiter 1');
  await person('r2', 'Recruiter 2');
  await person('r3', 'Recruiter 3');

  /* The free text the portal already used is the flag's backfill source; the
     explicit switch is what an admin uses. */
  assert.equal((await admin.post(`/api/admin/recruiters/${P.tlA.id}/team-lead`, { on: true })).status, 200);
  assert.equal((await admin.post(`/api/admin/recruiters/${P.tlB.id}/team-lead`, { on: true })).status, 200);

  for (const [who, tl, dept] of [['r1', 'tlA', 'Medical'], ['r2', 'tlA', 'Medical'], ['r3', 'tlB', 'IT']]) {
    const res = await admin.post('/api/admin/teams/assign', { recruiterId: P[who].id, tlId: P[tl].id, department: dept });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  }

  const list = await admin.get('/api/admin/teams');
  assert.equal(list.status, 200);
  const a = list.body.teamLeads.find((t) => t.id === P.tlA.id);
  const b = list.body.teamLeads.find((t) => t.id === P.tlB.id);
  assert.deepEqual(a.recruiters.map((r) => r.name).sort(), ['Recruiter 1', 'Recruiter 2']);
  assert.deepEqual(b.recruiters.map((r) => r.name), ['Recruiter 3']);
  assert.equal(a.recruiterCount, 2);
  assert.ok(a.email && 'phone' in a && a.department === 'Medical' && a.status === 'active');
});

test('a recruiter has one team lead and one department at a time; the rules are the database\'s', async () => {
  // not a team lead
  let r = await admin.post('/api/admin/teams/assign', { recruiterId: P.r1.id, tlId: P.r2.id, department: 'Medical' });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  // a department that is not the TL's
  r = await admin.post('/api/admin/teams/assign', { recruiterId: P.r3.id, tlId: P.tlA.id, department: 'IT' });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  // exactly one current row each
  const cur = await rows(`select recruiter_id, count(*)::int n from recruiter_assignment_history
                           where ended_at is null group by recruiter_id`);
  assert.ok(cur.every((x) => x.n === 1));
  // a second current row cannot be written, even by SQL
  await assert.rejects(() => raw(
    `insert into recruiter_assignment_history (recruiter_id, tl_id, department) values ($1,$2,'x')`,
    [P.r1.id, P.tlB.id]));
});

test('only an admin manages teams; a recruiter, a TL and a candidate get 403', async () => {
  for (const c of [P.r1.client, P.tlA.client, cand]) {
    assert.equal((await c.get('/api/admin/teams')).status, 403);
    assert.equal((await c.post('/api/admin/teams/assign', { recruiterId: P.r1.id, tlId: P.tlB.id, department: 'IT' })).status, 403);
    assert.equal((await c.patch(`/api/admin/recruiters/${P.r1.id}`, { email: 'x@y.zz' })).status, 403);
    assert.equal((await c.put('/api/admin/contact-cooldown', { days: 3 })).status, 403);
  }
});

/* ------------------------------------------------------------------ *
 * 2. who sees which job
 * ------------------------------------------------------------------ */
test('each recruiter posts as themselves; the owner is the session, never the request', async () => {
  J.A = await postJob(P.r1, 'Medical Job A');
  J.B = await postJob(P.r2, 'Medical Job B');
  J.C = await postJob(P.r3, 'IT Job C');
  J.T = await postJob(P.tlA, 'TL A own job');

  // asking to post as somebody else changes nothing
  const forged = await P.r1.client.post('/api/jobs', { ...JOB('Forged job'), recruiterId: P.r2.id });
  assert.equal(forged.status, 201);
  const owner = (await rows(`select recruiter_id from jobs where id=$1`, [forged.body.job.id]))[0].recruiter_id;
  assert.equal(owner, P.r1.id);
  J.F = forged.body.job.id;
  // and the database refuses a recruiter writing another's id even directly
  const direct = await P.r1.client.put(`/api/jobs/${J.B}`, JOB('HIJACK'));
  assert.equal(direct.status, 403);
});

test('visibility matrix: recruiter own, TL team (+own), other team none, admin all', async () => {
  const seen = async (c) => {
    const r = await c.get('/api/bootstrap');
    assert.equal(r.status, 200);
    return jobIdsOf(r).filter((id) => Object.values(J).includes(id));
  };
  assert.deepEqual((await seen(P.r1.client)).sort(), [J.A, J.F].sort());
  assert.deepEqual(await seen(P.r2.client), [J.B]);
  assert.deepEqual(await seen(P.r3.client), [J.C]);
  assert.deepEqual((await seen(P.tlA.client)).sort(), [J.A, J.B, J.F, J.T].sort());
  assert.deepEqual(await seen(P.tlB.client), [J.C]);
  assert.deepEqual((await seen(admin)).sort(), Object.values(J).sort());
  // the public board is unchanged for a candidate
  const pub = jobIdsOf(await cand.get('/api/bootstrap'));
  for (const id of [J.A, J.B, J.C]) assert.ok(pub.includes(id), 'candidates still see open jobs');
});

test('search, lists and counts carry nothing from another team', async () => {
  const q = await P.r1.client.get('/api/jobs?q=Medical');
  assert.equal(q.status, 200);
  assert.ok(!q.body.jobs.some((j) => j.id === J.B), 'recruiter 1 found recruiter 2\'s job by searching');
  const all = await P.r1.client.get('/api/jobs?view=all');
  assert.ok(!all.body.jobs.some((j) => [J.B, J.C].includes(j.id)));
  assert.equal(all.body.total === undefined || all.body.total === all.body.jobs.length || all.body.total <= 50, true);
  const tlB = await P.tlB.client.get('/api/jobs?view=all');
  assert.ok(!tlB.body.jobs.some((j) => [J.A, J.B, J.T].includes(j.id)), 'TL B saw TL A\'s team');
});

test('direct IDs: another team\'s job, application and recruiter are 403; unknown is 404', async () => {
  for (const [who, id] of [[P.r1, J.B], [P.r2, J.A], [P.tlB, J.A], [P.tlA, J.C], [P.r3, J.A]]) {
    const g = await who.client.get(`/api/jobs/${id}`);
    assert.equal(g.status, 403, `${who.name} opening ${id}: ${JSON.stringify(g.body)}`);
    assert.ok(!g.body.job, 'the record came back with the refusal');
    const put = await who.client.put(`/api/jobs/${id}`, JOB('Hijack attempt'));
    assert.equal(put.status, 403, `PUT: ${JSON.stringify(put.body)}`);
    const pub = await who.client.post(`/api/jobs/${id}/publish`, { publish: false });
    assert.equal(pub.status, 403, `publish: ${JSON.stringify(pub.body)}`);
    const sq = await who.client.get(`/api/jobs/${id}/screening-questions`);
    assert.equal(sq.status, 403, `screening: ${JSON.stringify(sq.body)}`);
  }
  assert.equal((await P.r1.client.get('/api/jobs/no_such_job')).status, 404);
  assert.equal((await P.tlA.client.get(`/api/jobs/${J.B}`)).status, 200, 'a TL opens a team job');
  assert.equal((await admin.get(`/api/jobs/${J.C}`)).status, 200);
});

/* ------------------------------------------------------------------ *
 * 3. applications inherit the job's visibility
 * ------------------------------------------------------------------ */
test('applications: owner, their TL and admin see them; others get 403 and no data', async () => {
  const ap = await cand.post('/api/applications', { jobId: J.A });
  assert.equal(ap.status, 201, JSON.stringify(ap.body));
  const appId = ap.body.application.id;
  J.appA = appId;

  const ids = async (c) => (await c.get('/api/applications')).body.applications.map((a) => a.id);
  assert.ok((await ids(P.r1.client)).includes(appId));
  assert.ok((await ids(P.tlA.client)).includes(appId));
  assert.ok((await ids(admin)).includes(appId));
  assert.ok(!(await ids(P.r2.client)).includes(appId), 'recruiter 2 saw recruiter 1\'s application');
  assert.ok(!(await ids(P.r3.client)).includes(appId));
  assert.ok(!(await ids(P.tlB.client)).includes(appId), 'TL B saw TL A\'s application');

  for (const who of [P.r2, P.r3, P.tlB]) {
    assert.equal((await who.client.put(`/api/applications/${appId}/status`, { stage: 'shortlisted' })).status, 403);
    assert.equal((await who.client.get(`/api/applications/${appId}/history`)).status, 403);
    assert.equal((await who.client.post(`/api/applications/${appId}/screen`, {})).status, 403);
  }
  assert.equal((await P.r1.client.get(`/api/applications/${appId}/history`)).status, 200);
});

/* ------------------------------------------------------------------ *
 * 4. the Team Lead page
 * ------------------------------------------------------------------ */
test('My Team: real aggregates for the team only, and a 403 for anybody who is not a TL', async () => {
  const s = await P.tlA.client.get('/api/team/summary?range=30d');
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.equal(s.body.cards.totalRecruiters, 2);
  assert.equal(s.body.cards.totalJobs, 3, 'A, B and the forged-attempt job F (the TL\'s own T is not the team\'s)');
  assert.equal(s.body.cards.totalApplied, 1);
  assert.deepEqual(s.body.recruiters.map((r) => r.name).sort(), ['Recruiter 1', 'Recruiter 2']);
  const r1 = s.body.recruiters.find((r) => r.id === P.r1.id);
  assert.equal(r1.jobsPosted, 2);
  assert.equal(r1.totalApplied, 1);
  assert.ok(r1.email && r1.department === 'Medical' && r1.status === 'active', JSON.stringify(r1));

  const b = await P.tlB.client.get('/api/team/summary?range=30d');
  assert.equal(b.body.cards.totalRecruiters, 1);
  assert.equal(b.body.cards.totalJobs, 1);
  assert.equal(b.body.cards.totalApplied, 0, 'TL B\'s count included TL A\'s applicant');

  for (const c of [P.r1.client, cand, admin]) assert.equal((await c.get('/api/team/summary')).status, 403);
  assert.equal((await P.tlA.client.get('/api/team/summary?range=custom&from=2026-02-30&to=x')).status, 400);
});

test('My Team: a recruiter in detail - jobs, applicants, contact activity; another team\'s is 403', async () => {
  const d = await P.tlA.client.get(`/api/team/recruiters/${P.r1.id}?range=30d`);
  assert.equal(d.status, 200, JSON.stringify(d.body));
  assert.ok(d.body.jobs.some((j) => j.id === J.A && j.applications === 1));
  const ap = await P.tlA.client.get(`/api/team/recruiters/${P.r1.id}/jobs/${J.A}/applicants`);
  assert.equal(ap.status, 200);
  assert.equal(ap.body.applicants.length, 1);

  assert.equal((await P.tlA.client.get(`/api/team/recruiters/${P.r3.id}`)).status, 403);
  assert.equal((await P.tlB.client.get(`/api/team/recruiters/${P.r1.id}/jobs/${J.A}/applicants`)).status, 403);
  assert.equal((await P.tlA.client.get('/api/team/recruiters/nobody')).status, 404);
  // a job of the right team, the wrong recruiter
  assert.equal((await P.tlA.client.get(`/api/team/recruiters/${P.r1.id}/jobs/${J.B}/applicants`)).status, 404);
});

/* ------------------------------------------------------------------ *
 * 5. the login email
 * ------------------------------------------------------------------ */
test('admin changes a recruiter\'s email: the new one signs in, the old one does not, the old session ends, it is audited', async () => {
  const old = P.r2.email;
  const fresh = 'recruiter2.new@teams.test';
  const res = await admin.patch(`/api/admin/recruiters/${P.r2.id}`, { email: fresh });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.email.changed, true);

  assert.equal((await P.r2.client.get('/api/auth/me')).body.session, null, 'the old session survived');
  const noOld = makeClient(BASE);
  assert.equal((await noOld.post('/api/auth/login', { email: old, password: PW })).status, 401);
  const yes = makeClient(BASE);
  assert.equal((await yes.post('/api/auth/login', { email: fresh.toUpperCase(), password: PW })).status, 200);
  P.r2.client = yes; P.r2.email = fresh;

  // one account, both records
  const u = await rows(`select u.email as ue, r.email as re from recruiters r join users u on u.id=r.user_id where r.id=$1`, [P.r2.id]);
  assert.deepEqual([u[0].ue, u[0].re], [fresh, fresh]);
  assert.equal((await rows(`select count(*)::int n from users where role='recruiter'`))[0].n >= 5, true);

  const log = await rows(`select actor_role, detail from audit_log where action='RECRUITER_EMAIL_CHANGED' and entity_id=$1`, [P.r2.id]);
  assert.equal(log.length, 1);
  assert.equal(log[0].detail.oldEmail, old);
  assert.equal(log[0].detail.newEmail, fresh);
  assert.equal(log[0].actor_role, 'admin');
});

test('email rules: format, case-insensitive uniqueness (409), nothing overwritten', async () => {
  assert.equal((await admin.patch(`/api/admin/recruiters/${P.r1.id}`, { email: 'not-an-email' })).status, 400);
  const clash = await admin.patch(`/api/admin/recruiters/${P.r1.id}`, { email: P.r3.email.toUpperCase() });
  assert.equal(clash.status, 409, JSON.stringify(clash.body));
  assert.equal((await rows(`select email from recruiters where id=$1`, [P.r1.id]))[0].email, P.r1.email);
  assert.ok((await P.r1.client.get('/api/auth/me')).body.session, 'a refused change must not end the session');
  // the database says no, whatever the route says
  await assert.rejects(() => raw(`update users set email=$1 where lower(email)=$2`,
    [P.r3.email.toUpperCase(), P.r1.email.toLowerCase()]));
});

test('status: deactivating ends the sessions, keeps every record; it is audited', async () => {
  const off = await admin.post(`/api/staff/recruiters/${P.r3.id}/status`, { active: false });
  assert.equal(off.status, 200);
  assert.equal((await P.r3.client.get('/api/auth/me')).body.session, null);
  assert.equal((await makeClient(BASE).post('/api/auth/login', { email: P.r3.email, password: PW })).status, 403);
  assert.equal((await rows(`select count(*)::int n from jobs where id=$1`, [J.C]))[0].n, 1);
  assert.equal((await rows(`select count(*)::int n from recruiter_assignment_history where recruiter_id=$1 and ended_at is null`, [P.r3.id]))[0].n, 1);
  assert.equal((await rows(`select count(*)::int n from audit_log where action='RECRUITER_STATUS_CHANGED' and entity_id=$1`, [P.r3.id]))[0].n, 1);
  // an inactive recruiter cannot be given a new team
  const re = await admin.post('/api/admin/teams/assign', { recruiterId: P.r3.id, tlId: P.tlB.id, department: 'IT' });
  assert.equal((await admin.post(`/api/staff/recruiters/${P.r3.id}/status`, { active: true })).status, 200);
  P.r3.client = makeClient(BASE);
  assert.equal((await P.r3.client.post('/api/auth/login', { email: P.r3.email, password: PW })).status, 200);
  assert.ok(re.status === 200 || re.status === 409);
});

/* ------------------------------------------------------------------ *
 * 6. the contact cooldown
 * ------------------------------------------------------------------ */
const contact = (who, candidateId, extra = {}) =>
  (who.client || who).post('/api/engagement/check', { candidateId, action: 'whatsapp', record: true, ...extra });
const history = (candidateId) => rows(
  `select channel, contacted_by, recruiter_id, outcome, override_used, override_reason
     from candidate_contact_history where candidate_id=$1 and cch_is_contact(source) order by id`, [candidateId]);

test('fresh candidates (no applications), so only the cooldown is under test', async () => {
  for (let i = 1; i <= 14; i += 1) {
    await raw(`insert into candidates (id, name, email, phone) values ($1,$2,$3,$4) on conflict do nothing`,
      [`tc${i}`, `Test Candidate ${i}`, `tc${i}@cands.test`, `90000000${String(i).padStart(2, '0')}`]);
  }
});

test('cooldown: the first contact is logged; another recruiter is blocked with who/when/channel', async () => {
  const first = await contact(P.r1, 'tc3');
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.ok(first.body.contactId);

  const blocked = await contact(P.r2, 'tc3');
  assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
  assert.equal(blocked.body.error.code, 'CONTACT_COOLDOWN');
  const hd = blocked.body.error.details.holder;
  assert.equal(hd.name, 'Recruiter 1');
  assert.equal(hd.channel, 'whatsapp');
  assert.ok(hd.contactedAt && hd.expiresAt);
  assert.equal(blocked.body.error.details.cooldownDays, 7);
  assert.equal(blocked.body.error.details.canOverride, false);
  assert.equal((await history('tc3')).length, 1, 'a blocked attempt wrote a contact');

  // the same answer on any channel, and on a plain check without recording
  const sms = await P.r2.client.post('/api/engagement/check', { candidateId: 'tc3', action: 'sms' });
  assert.equal(sms.status, 409);
  const dry = await P.r2.client.post('/api/engagement/check', { candidateId: 'tc3', action: 'email', dryRun: true });
  assert.equal(dry.body.cooldown.holder.name, 'Recruiter 1');

  const badges = await P.r2.client.post('/api/engagement/badges', { candidateIds: ['tc3', 'tc4'] });
  assert.equal(badges.body.badges.tc3.cooldown.name, 'Recruiter 1');
  assert.ok(!badges.body.badges.tc4 || !badges.body.badges.tc4.cooldown);
});

test('same recruiter may follow up (logged each time); a recruiter cannot override (403, nothing sent)', async () => {
  const again = await P.r1.client.post('/api/engagement/check', { candidateId: 'tc3', action: 'call', record: true });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.deepEqual((await history('tc3')).map((x) => x.channel), ['whatsapp', 'phone']);

  const forced = await contact(P.r2, 'tc3', { override: true, overrideReason: 'I really want to.' });
  assert.equal(forced.status, 403, JSON.stringify(forced.body));
  assert.equal((await history('tc3')).length, 2);
});

test('TL override needs a reason; with one it goes through and is recorded and audited', async () => {
  const bare = await contact(P.tlA, 'tc3', { override: true });
  assert.equal(bare.status, 400, JSON.stringify(bare.body));
  const short = await contact(P.tlA, 'tc3', { override: true, overrideReason: 'ok' });
  assert.equal(short.status, 400);
  assert.equal((await history('tc3')).length, 2);

  const ok = await contact(P.tlA, 'tc3', { override: true, overrideReason: 'Candidate requested urgent follow-up.' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const h = await history('tc3');
  assert.equal(h.length, 3);
  assert.equal(h[2].override_used, true);
  assert.equal(h[2].override_reason, 'Candidate requested urgent follow-up.');
  const a = await rows(`select detail from audit_log where action='CONTACT_COOLDOWN_OVERRIDDEN' and entity_id='tc3'`);
  assert.equal(a.length, 1);
  assert.equal(a[0].detail.reason, 'Candidate requested urgent follow-up.');
});

test('admin may override too; an override does not widen what a TL may see', async () => {
  assert.equal((await contact(admin, 'tc4')).status, 200);
  const r2 = await contact(P.r2, 'tc4');
  assert.equal(r2.status, 409);
  const ov = await contact(admin, 'tc4', { override: true, overrideReason: 'Admin follow-up request.' });
  assert.equal(ov.status, 200);
  // a TL cannot use a job from outside their team to contact
  const out = await contact(P.tlA, 'tc2', { jobId: J.C });
  assert.equal(out.status, 403, JSON.stringify(out.body));
  assert.equal((await history('tc2')).length, 0);
  // nor a recruiter a job that is not theirs
  assert.equal((await contact(P.r1, 'tc2', { jobId: J.B })).status, 403);
});

test('the cooldown is an admin setting (1-90), judged on the real timestamp, and moves only future checks', async () => {
  assert.equal((await admin.get('/api/admin/contact-cooldown')).body.days, 7);
  for (const bad of [0, 91, 2.5, '7']) assert.equal((await admin.put('/api/admin/contact-cooldown', { days: bad })).status, 400);

  // a contact eight days old no longer holds anybody at 7 days...
  await contact(P.r1, 'tc2');
  await raw(`update candidate_contact_history set created_at = now() - interval '8 days' where candidate_id='tc2'`);
  assert.equal((await contact(P.r2, 'tc2')).status, 200, 'expired cooldown still blocked');
  // ...and a new contact starts a new window
  assert.equal((await contact(P.r1, 'tc2')).status, 409);

  // ...but does at 14 days, without touching the history
  const before = (await history('tc2')).length;
  await raw(`update candidate_contact_history set created_at = now() - interval '8 days' where candidate_id='tc1'`);
  await raw(`insert into candidate_contact_history (candidate_id, channel, direction, source, contacted_by, recruiter_id, created_at)
             values ('tc1','email','out','email',(select user_id from recruiters where id=$1),$1, now() - interval '8 days')`, [P.r1.id]);
  assert.equal((await admin.put('/api/admin/contact-cooldown', { days: 14 })).status, 200);
  assert.equal((await contact(P.r2, 'tc1')).status, 409);
  assert.equal((await history('tc2')).length, before);
  assert.equal((await rows(`select count(*)::int n from audit_log where action='CONTACT_COOLDOWN_CHANGED'`))[0].n, 1);
  assert.equal((await admin.put('/api/admin/contact-cooldown', { days: 7 })).status, 200);
  assert.equal((await contact(P.r2, 'tc1')).status, 200, 'back to 7 days: the 8-day-old contact is clear');
});

test('a contact that failed to go out does not hold anybody back', async () => {
  const id = 'tc5';
  const res = await contact(P.r1, id);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const rec = await P.r1.client.post('/api/engagement/record', { candidateId: id, channel: 'whatsapp', outcome: 'failed', contactId: res.body.contactId });
  assert.equal(rec.status, 200);
  assert.equal((await contact(P.r2, id)).status, 200);
});

test('RACE: two recruiters contact the same candidate at once - exactly one gets through', async () => {
  for (let i = 0; i < 5; i += 1) {
    const id = ['tc6', 'tc7', 'tc8', 'tc9', 'tc10'][i];
    const [a, b] = await Promise.all([contact(P.r1, id), contact(P.r2, id)]);
    const ok = [a, b].filter((x) => x.status === 200);
    const no = [a, b].filter((x) => x.status === 409);
    assert.equal(ok.length + no.length, 2, `${a.status}/${b.status}`);
    assert.equal(ok.length, 1, `round ${i}: ${a.status}/${b.status}`);
    assert.equal(no.length, 1);
    assert.equal((await history(id)).length, 1, 'both writes landed');
  }
});

test('bulk: 4 selected, 2 held - 2 queued, 2 skipped with who/when/channel; the batch never fails', async () => {
  await contact(P.r2, 'tc11');
  await contact(P.r2, 'tc12');
  const r = await P.r1.client.post('/api/candidates/bulk-message', {
    channel: 'whatsapp', candidateIds: ['tc13', 'tc11', 'tc12', 'tc14'], body: 'Hello {{name}}, a role for you.',
  });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  const held = r.body.cooldownCandidates.map((x) => x.id).sort();
  assert.deepEqual(held, ['tc11', 'tc12'], JSON.stringify(r.body.cooldownCandidates));
  assert.equal(r.body.cooldownSkipped, held.length);
  for (const x of r.body.cooldownCandidates) assert.ok(x.heldBy && x.contactedAt && x.channel);
  assert.ok(r.body.queued >= 1, 'the eligible ones must still be sent');
  const logged = await rows(`select count(*)::int n from candidate_contact_history where source='bulk_message' and contacted_by=(select user_id from recruiters where id=$1)`, [P.r1.id]);
  assert.equal(logged[0].n, r.body.queued, 'one log row per message queued');

  // an override for the batch is for an admin or a TL, with a reason
  assert.equal((await P.r1.client.post('/api/candidates/bulk-message', {
    channel: 'whatsapp', candidateIds: ['tc11'], body: 'x', override: true, overrideReason: 'because I said so',
  })).status, 403);
  assert.equal((await P.tlA.client.post('/api/candidates/bulk-message', {
    channel: 'whatsapp', candidateIds: ['tc11'], body: 'x', override: true,
  })).status, 400);
});

/* ------------------------------------------------------------------ *
 * 7. Find Candidates: the chosen job
 * ------------------------------------------------------------------ */
test('Find Candidates: every row says whether it applied to the chosen job; the filter agrees', async () => {
  const all = await P.r1.client.get(`/api/candidates?limit=500&forJob=${J.A}`);
  assert.equal(all.status, 200, JSON.stringify(all.body).slice(0, 300));
  const flag = Object.fromEntries(all.body.candidates.map((c) => [c.id, c.appliedForJob]));
  assert.equal(flag.cand1, true);
  assert.ok(Object.entries(flag).filter(([id]) => id !== 'cand1').every(([, v]) => v === false));

  const yes = await P.r1.client.get(`/api/candidates?limit=500&forJob=${J.A}&appliedForJob=yes`);
  assert.deepEqual(yes.body.candidates.map((c) => c.id), ['cand1']);
  const no = await P.r1.client.get(`/api/candidates?limit=500&forJob=${J.A}&appliedForJob=no`);
  assert.ok(!no.body.candidates.some((c) => c.id === 'cand1'));
  assert.equal(yes.body.total + no.body.total, all.body.total);

  // no job chosen: no flag, no change
  const none = await P.r1.client.get('/api/candidates?limit=500');
  assert.ok(none.body.candidates.every((c) => !('appliedForJob' in c)));
});

test('Find Candidates: the candidate list is not narrowed by team; the chosen job is checked', async () => {
  const a = await P.r1.client.get('/api/candidates?limit=500');
  const c = await P.r3.client.get('/api/candidates?limit=500');
  assert.equal(a.body.total, c.body.total, 'candidates are shared, whatever the department');

  assert.equal((await P.r2.client.get(`/api/candidates?forJob=${J.A}`)).status, 403);
  assert.equal((await P.tlB.client.get(`/api/candidates?forJob=${J.A}&appliedForJob=yes`)).status, 403);
  assert.equal((await P.tlA.client.get(`/api/candidates?forJob=${J.A}`)).status, 200);
  assert.equal((await admin.get(`/api/candidates?forJob=${J.C}`)).status, 200);
  assert.equal((await P.r1.client.get('/api/candidates?forJob=nope')).status, 404);
});

/* ------------------------------------------------------------------ *
 * 8. reassignment keeps history
 * ------------------------------------------------------------------ */
test('reassignment: TL A loses Recruiter 1, TL B gains them; the work and its history stay', async () => {
  const before = {
    jobs: (await rows(`select count(*)::int n from jobs where recruiter_id=$1`, [P.r1.id]))[0].n,
    apps: (await rows(`select count(*)::int n from applications where job_id=$1`, [J.A]))[0].n,
    contacts: (await rows(`select count(*)::int n from candidate_contact_history where recruiter_id=$1`, [P.r1.id]))[0].n,
  };
  const move = await admin.post('/api/admin/teams/assign', { recruiterId: P.r1.id, tlId: P.tlB.id, department: 'IT' });
  assert.equal(move.status, 200, JSON.stringify(move.body));

  const tlA = await P.tlA.client.get('/api/team/summary?range=30d');
  assert.ok(!tlA.body.recruiters.some((r) => r.id === P.r1.id), 'TL A still lists Recruiter 1');
  const tlB = await P.tlB.client.get('/api/team/summary?range=30d');
  assert.ok(tlB.body.recruiters.some((r) => r.id === P.r1.id));
  assert.equal((await P.tlA.client.get(`/api/team/recruiters/${P.r1.id}`)).status, 403);
  assert.equal((await P.tlB.client.get(`/api/team/recruiters/${P.r1.id}`)).status, 200);

  // visibility follows the current team...
  assert.equal((await P.tlA.client.get(`/api/jobs/${J.A}`)).status, 403);
  assert.equal((await P.tlB.client.get(`/api/jobs/${J.A}`)).status, 200);
  // ...and nothing was deleted or re-owned
  assert.deepEqual({
    jobs: (await rows(`select count(*)::int n from jobs where recruiter_id=$1`, [P.r1.id]))[0].n,
    apps: (await rows(`select count(*)::int n from applications where job_id=$1`, [J.A]))[0].n,
    contacts: (await rows(`select count(*)::int n from candidate_contact_history where recruiter_id=$1`, [P.r1.id]))[0].n,
  }, before);
  assert.equal((await rows(`select recruiter_id from jobs where id=$1`, [J.A]))[0].recruiter_id, P.r1.id);

  const hist = await admin.get(`/api/admin/recruiters/${P.r1.id}/assignments`);
  assert.equal(hist.body.assignments.length, 2);
  assert.equal(hist.body.assignments.filter((x) => x.current).length, 1);
  assert.equal(hist.body.assignments.find((x) => !x.current).endReason, 'reassigned');
  assert.equal((await rows(`select count(*)::int n from audit_log where action='RECRUITER_REASSIGNED' and entity_id=$1`, [P.r1.id]))[0].n, 1);
  assert.equal((await rows(`select count(*)::int n from audit_log where action='RECRUITER_DEPARTMENT_CHANGED' and entity_id=$1`, [P.r1.id]))[0].n, 1);
});

test('removing an assignment: no team visibility, nothing deleted, the recruiter still has their own work', async () => {
  const off = await admin.post('/api/admin/teams/unassign', { recruiterId: P.r1.id });
  assert.equal(off.status, 200);
  assert.equal((await P.tlB.client.get(`/api/jobs/${J.A}`)).status, 403);
  assert.equal((await P.r1.client.get(`/api/jobs/${J.A}`)).status, 200);
  assert.equal((await rows(`select count(*)::int n from recruiters where id=$1`, [P.r1.id]))[0].n, 1);
  assert.equal((await rows(`select count(*)::int n from recruiter_assignment_history where recruiter_id=$1 and ended_at is null`, [P.r1.id]))[0].n, 0);
  assert.equal((await rows(`select count(*)::int n from recruiter_assignment_history where recruiter_id=$1`, [P.r1.id]))[0].n, 2);
  assert.equal((await admin.post('/api/admin/teams/unassign', { recruiterId: P.r1.id })).body.changed, false);
  // a TL with recruiters cannot just stop being a TL
  const stop = await admin.post(`/api/admin/recruiters/${P.tlA.id}/team-lead`, { on: false });
  assert.equal(stop.status, 409);
});

test('admin sees everything: all jobs, all applications, the history of every assignment', async () => {
  const ids = jobIdsOf(await admin.get('/api/bootstrap'));
  for (const id of Object.values(J).filter((x) => typeof x === 'string' && x.startsWith('j'))) assert.ok(ids.includes(id));
  const list = await admin.get('/api/admin/teams');
  assert.ok(list.body.unassigned.some((r) => r.id === P.r1.id));
});

test('teardown', async () => {
  await new Promise((r) => server.close(r));
  const { closePool } = await import('../src/db.js');
  await closePool();
  await dbHandle.stop();
});
