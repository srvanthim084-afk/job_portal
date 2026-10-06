/**
 * Role-based data scoping, end to end through the real API and the real
 * database policies (migration 0117; src/scope.js; routes/dashboard.js,
 * routes/talent-pool.js).
 *
 *   recruiter  their own jobs, applications, talent pool
 *   team lead  everything of their DEPARTMENT's recruiters
 *   admin      everything
 *   candidates SHARED (Find Candidates) - basic profile only
 *
 * The eleven rules of the owner's brief are the eleven tests below, in
 * order, plus the "undefined" fix and the team lead / department wiring.
 * People are created the way production creates them: through the admin
 * API (role + department), then they sign in and use the real routes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb, applyTestEnv, makeClient } from './harness.mjs';

const DB_PORT = 5483;
const API_PORT = 9983;

let dbh, server, base, raw;
let ADMIN, H1, H2, HTL, M1, MTL, R6;
const jobs = {};
const cands = {};

const PASSWORD = 'Scoped#Pass2026';
const j = (r) => JSON.stringify(r.body);

async function signIn(email, password = PASSWORD) {
  const c = makeClient(base);
  await c.get('/api/health');
  const r = await c.post('/api/auth/login', { email, password });
  assert.equal(r.status, 200, j(r));
  return c;
}

async function staff(name, email, departmentId, accessRole = 'recruiter') {
  const r = await ADMIN.post('/api/staff/recruiters', {
    name, email, password: PASSWORD, companyId: 'co_x', departmentId, accessRole,
  });
  assert.equal(r.status, 201, j(r));
  return signIn(email);
}

async function postJob(who, title, extra = {}) {
  const r = await who.post('/api/jobs', {
    title, companyId: 'co_x', location: 'Hyderabad', exp: '2-4 yrs', pay: '4-6 LPA',
    type: 'Full-time', status: 'open', desc: `${title} role`, gender: 'Female', ...extra,
  });
  assert.equal(r.status, 201, j(r));
  return r.body.job.id;
}

async function candidateUser(id, name, email) {
  const { hashPassword } = await import('../src/auth.js');
  const hash = await hashPassword(PASSWORD);
  const u = (await raw(`insert into users (email, password_hash, role) values ($1,$2,'candidate') returning id`,
    [email, hash])).rows[0].id;
  await raw(`insert into candidates (id, user_id, name, email, phone) values ($1,$2,$3,$4,$5)`,
    [id, u, name, email, '9' + String(Math.abs(hashCode(id)) % 1e9).padStart(9, '0')]);
  return signIn(email);
}
const hashCode = (s) => [...s].reduce((h, ch) => ((h << 5) - h + ch.charCodeAt(0)) | 0, 7);

const ids = (list) => list.map((x) => x.id);
const csv = (rows) => ['Name,Phone,Email,Skills,Location', ...rows].join('\n');

test('boot: departments, an admin, and two departments of people created through the admin API', async () => {
  dbh = await startTestDb(DB_PORT);
  applyTestEnv(dbh.url, {
    PUBLIC_ORIGIN: `http://127.0.0.1:${API_PORT}`,
    DISABLE_BACKGROUND_WORK: 'true',
    EMAIL_API_KEY: '', EMAIL_SMTP_HOST: '', EMAIL_SMTP_USER: '', EMAIL_SMTP_PASS: '',
    EMAILJS_SERVICE_ID: '', EMAILJS_TEMPLATE_ID: '', EMAILJS_PUBLIC_KEY: '', EMAILJS_PRIVATE_KEY: '',
    OUTBOUND_ALLOWLIST: '', OUTBOUND_CALLS_ENABLED: '',
  });
  raw = (sql, params) => dbh.db.query(sql, params);

  const { hashPassword } = await import('../src/auth.js');
  const hash = await hashPassword(PASSWORD);
  await raw(`insert into companies (id, name) values ('co_x', 'TeamLink Consultants')`);
  const aid = (await raw(`insert into users (email, password_hash, role) values ('admin@tl-sink.local', $1, 'admin') returning id`, [hash])).rows[0].id;
  await raw(`insert into admins (id, user_id, name, email) values ('adm', $1, 'Admin', 'admin@tl-sink.local')`, [aid]);

  const { createApp } = await import('../src/app.js');
  const app = createApp({ logger: { error() {}, log() {} } });
  await new Promise((r) => { server = app.listen(API_PORT, r); });
  base = `http://127.0.0.1:${API_PORT}`;

  ADMIN = await signIn('admin@tl-sink.local');
  const depts = await raw(`select id, name from departments order by sort_order`);
  assert.deepEqual(depts.rows.map((d) => d.name), ['Education', 'Healthcare', 'IT & Technology', 'Manufacturing']);

  H1  = await staff('Hema One',    'h1@tl-sink.local',  'healthcare');
  H2  = await staff('Hari Two',    'h2@tl-sink.local',  'healthcare');
  HTL = await staff('Keerthana',   'htl@tl-sink.local', 'healthcare', 'teamlead');
  M1  = await staff('Manu One',    'm1@tl-sink.local',  'manufacturing');
  MTL = await staff('Bhavana',     'mtl@tl-sink.local', 'manufacturing', 'teamlead');
  R6  = await staff('Rita Six',    'r6@tl-sink.local',  'it-technology');

  // the SERVER derives the scope; the sign-in says what it derived
  const me = await HTL.get('/api/auth/me');
  assert.equal(me.body.session.scopeRole, 'teamlead');
  assert.equal(me.body.session.departmentId, 'healthcare');
  assert.equal((await H1.get('/api/auth/me')).body.session.scopeRole, 'recruiter');
  assert.equal((await ADMIN.get('/api/auth/me')).body.session.scopeRole, 'admin');
});

test('admin role + department: validation, audit, and only an admin may set them', async () => {
  const bad = await ADMIN.post('/api/staff/recruiters', {
    name: 'Nobody Lead', email: 'nl@tl-sink.local', password: PASSWORD, companyId: 'co_x', accessRole: 'teamlead',
  });
  assert.equal(bad.status, 400, 'a team lead without a department was accepted: ' + j(bad));
  const nonsense = await ADMIN.post('/api/staff/recruiters', {
    name: 'Odd Dept', email: 'od@tl-sink.local', password: PASSWORD, companyId: 'co_x', departmentId: 'astrology',
  });
  assert.equal(nonsense.status, 400, j(nonsense));
  assert.equal((await H1.patch('/api/staff/recruiters/x', { accessRole: 'teamlead', departmentId: 'healthcare' })).status, 403);
  const list = (await ADMIN.get('/api/staff/recruiters')).body.recruiters;
  const keer = list.find((r) => r.email === 'htl@tl-sink.local');
  assert.equal(keer.accessRole, 'teamlead');
  assert.equal(keer.departmentId, 'healthcare');
  assert.equal(keer.department, 'Healthcare');
  const audit = await raw(`select count(*)::int n from staff_audit where action = 'recruiter_scope_set'`);
  assert.ok(audit.rows[0].n >= 6);
});

test('the job form refuses an empty location or experience, with the field named', async () => {
  const noLoc = await H1.post('/api/jobs', { title: 'Nurse', companyId: 'co_x', exp: '1 yr', status: 'open' });
  assert.equal(noLoc.status, 400);
  assert.ok(noLoc.body.error.details.location, j(noLoc));
  const noExp = await H1.post('/api/jobs', { title: 'Nurse', companyId: 'co_x', location: 'Nellore', exp: '  ', status: 'open' });
  assert.equal(noExp.status, 400);
  assert.ok(noExp.body.error.details.exp, j(noExp));
});

test('1. a Healthcare recruiter\'s job is invisible to Manufacturing - list, detail, bootstrap, picker, count', async () => {
  jobs.h1 = await postJob(H1, 'Neurologist Consultant');
  jobs.h2 = await postJob(H2, 'Staff Nurse ICU');
  jobs.m1 = await postJob(M1, 'CNC Machine Operator');
  jobs.r6 = await postJob(R6, 'Backend Developer');

  for (const who of [M1, MTL]) {
    const list = await who.get('/api/jobs?view=all&limit=200');
    assert.ok(!ids(list.body.jobs).includes(jobs.h1), 'the Healthcare job is in the Manufacturing list');
    const boot = await who.get('/api/bootstrap');
    assert.ok(!ids(boot.body.data.jobs).includes(jobs.h1), 'the Healthcare job reached the Manufacturing browser');
    assert.ok(!JSON.stringify(boot.body.data).includes('Neurologist'), 'the title leaked anywhere in the payload');
    assert.equal((await who.get(`/api/jobs/${jobs.h1}`)).status, 404);
  }
  // ?mine=all is gone, and so is every other way of asking for the board
  const wide = await M1.get('/api/jobs?mine=all&view=all');
  assert.ok(!JSON.stringify(wide.body).includes('Neurologist'));
  // the public site still sees every published job
  const anon = makeClient(base);
  assert.ok(ids((await anon.get('/api/jobs?limit=200')).body.jobs).includes(jobs.h1));
  // the Manufacturing recruiter does see their own
  assert.ok(ids((await M1.get('/api/jobs?view=all')).body.jobs).includes(jobs.m1));
});

test('2. a recruiter opening a colleague\'s job - detail, edit, publish, applicants - gets 404/403', async () => {
  assert.equal((await H1.get(`/api/jobs/${jobs.h2}`)).status, 404);
  const put = await H1.put(`/api/jobs/${jobs.h2}`, { title: 'Hijacked', companyId: 'co_x', location: 'X', exp: '1 yr' });
  assert.ok([403, 404].includes(put.status), 'edited another recruiter\'s job: ' + put.status);
  const pub = await H1.post(`/api/jobs/${jobs.h2}/publish`, { publish: false });
  assert.ok([403, 404].includes(pub.status), 'closed another recruiter\'s job: ' + pub.status);
  const apps = await H1.get(`/api/applications?jobId=${jobs.h2}`);
  assert.equal(apps.body.applications.length, 0);
  assert.equal((await raw(`select title from jobs where id = $1`, [jobs.h2])).rows[0].title, 'Staff Nurse ICU');
});

test('3. applications: recruiter own, team lead department, admin all - and the pool the same', async () => {
  const c1 = await candidateUser('cand_a1', 'Anita Apply', 'anita@tl-sink.local');
  const c2 = await candidateUser('cand_a2', 'Bala Apply', 'bala@tl-sink.local');
  const c3 = await candidateUser('cand_a3', 'Chitra Apply', 'chitra@tl-sink.local');
  const c4 = await candidateUser('cand_a4', 'Dev Apply', 'dev@tl-sink.local');
  for (const [c, job] of [[c1, jobs.h1], [c2, jobs.h2], [c3, jobs.m1], [c4, jobs.r6]]) {
    const r = await c.post('/api/applications', { jobId: job });
    assert.equal(r.status, 201, j(r));
  }
  await raw(`update applications set match_score = 88, ai_score = 91 where job_id = $1`, [jobs.h1]);
  await raw(`update applications set match_score = 40 where job_id = $1`, [jobs.h2]);

  const appsOf = async (who) => (await who.get('/api/applications?limit=500')).body.applications.map((a) => a.jobId).sort();
  assert.deepEqual(await appsOf(H1), [jobs.h1]);
  assert.deepEqual(await appsOf(H2), [jobs.h2]);
  assert.deepEqual(await appsOf(HTL), [jobs.h1, jobs.h2].sort(), 'the team lead must see ALL of the department');
  assert.deepEqual(await appsOf(M1), [jobs.m1]);
  assert.deepEqual(await appsOf(MTL), [jobs.m1], 'the Manufacturing team lead saw another department');
  assert.equal((await appsOf(ADMIN)).length, 4);

  const jobsOf = async (who) => ids((await who.get('/api/bootstrap')).body.data.jobs).sort();
  assert.deepEqual(await jobsOf(HTL), [jobs.h1, jobs.h2].sort());
  assert.deepEqual(await jobsOf(MTL), [jobs.m1]);
  assert.equal((await jobsOf(ADMIN)).length, 4);

  // talent pool: applicants are in the pool of the job's recruiter
  const pool = async (who) => ids((await who.get('/api/candidates?scope=pool&limit=500&availabilityAll=true')).body.candidates).sort();
  assert.deepEqual(await pool(H1), ['cand_a1']);
  assert.deepEqual(await pool(H2), ['cand_a2']);
  assert.deepEqual(await pool(HTL), ['cand_a1', 'cand_a2'], 'the team lead must see the whole department\'s pool');
  assert.deepEqual(await pool(MTL), ['cand_a3']);
  assert.equal((await pool(ADMIN)).length, 4);

  // the team lead (only) is told whose pool each person is in
  const tlRows = (await HTL.get('/api/candidates?scope=pool&limit=50')).body.candidates;
  assert.deepEqual(tlRows.find((c) => c.id === 'cand_a1').poolEntry.recruiters, ['Hema One']);
  const own = (await H1.get('/api/candidates?scope=pool&limit=50')).body.candidates[0];
  assert.equal(own.poolEntry.recruiters, undefined, 'a plain recruiter was told whose pool');

  // an applicant's browser payload carries only that department's people
  const boot = (await MTL.get('/api/bootstrap')).body.data;
  assert.ok(!ids(boot.candidates).includes('cand_a1'), 'a Healthcare applicant reached the Manufacturing browser');
});

test('3b. detail by id: another recruiter\'s application, interview and pool entry are 403/404', async () => {
  const appId = (await raw(`select id from applications where job_id = $1`, [jobs.h1])).rows[0].id;
  for (const who of [H2, M1, MTL]) {
    for (const path of [`/api/applications/${appId}/history`, `/api/applications/${appId}/notifications`]) {
      const r = await who.get(path);
      assert.ok([403, 404].includes(r.status) || (r.body.history && r.body.history.length === 0),
        `${path} readable by an outsider`);
    }
    assert.equal((await who.get('/api/talent-pool/cand_a1')).status, 404);
    assert.equal((await who.put('/api/talent-pool/cand_a1', { notes: 'x' })).status, 404);
  }
  assert.equal((await HTL.get('/api/talent-pool/cand_a1')).status, 200, 'the team lead may read a department pool entry');
  assert.equal((await HTL.put('/api/talent-pool/cand_a1', { notes: 'x' })).status, 404, 'a team lead edits their own row only');
  const upd = await H1.put(`/api/applications/${appId}/status`, { stage: 'shortlisted' });
  assert.equal(upd.status, 200, j(upd));
  const bad = await H2.put(`/api/applications/${appId}/status`, { stage: 'rejected' });
  assert.ok([403, 404].includes(bad.status), 'moved another recruiter\'s applicant: ' + bad.status);
  assert.equal((await HTL.put(`/api/applications/${appId}/status`, { stage: 'interview_scheduled' })).status, 200,
    'the team lead could not manage a department application');
});

test('4. Recruiter 1 imports 345 candidates through the real import route: their pool +345, Recruiter 2\'s unchanged', async () => {
  const before2 = (await H2.get('/api/talent-pool/count')).body.count;
  const before1 = (await H1.get('/api/talent-pool/count')).body.count;
  const rows = [];
  for (let i = 0; i < 345; i += 1) {
    rows.push(`Importee ${i} Quantum,98${String(10000000 + i)},imp${i}@tl-sink.local,Quantumweaving;Python,Nellore`);
  }
  const imp = await H1.post('/api/candidates/import', { text: csv(rows) });
  assert.equal(imp.status, 201, j(imp));
  assert.equal(imp.body.imported, 345, j(imp));

  assert.equal((await H1.get('/api/talent-pool/count')).body.count, before1 + 345);
  assert.equal((await H2.get('/api/talent-pool/count')).body.count, before2, 'Recruiter 2\'s pool changed');
  assert.equal((await H2.get('/api/candidates?scope=pool&q=Importee&limit=5')).body.total, 0);
  assert.equal((await H1.get('/api/candidates?scope=pool&q=Importee&limit=5')).body.total, 345);
  assert.equal((await HTL.get('/api/candidates?scope=pool&q=Importee&limit=5')).body.total, 345, 'the team lead sees the department pool');
  assert.equal((await MTL.get('/api/candidates?scope=pool&q=Importee&limit=5')).body.total, 0);
  const row = await raw(`select origin, import_id, department_id from talent_pool
                          where recruiter_id = (select id from recruiters where email = 'h1@tl-sink.local')
                            and candidate_id in (select id from candidates where email = 'imp0@tl-sink.local')`);
  assert.equal(row.rows[0].origin, 'imported');
  assert.ok(row.rows[0].import_id);
  assert.equal(row.rows[0].department_id, 'healthcare');
});

test('5. Recruiter 6 searches Find Candidates by keyword and finds the imported people - basic profile only', async () => {
  const r = await R6.get('/api/candidates?skills=Quantumweaving&limit=25&availabilityAll=true');
  assert.equal(r.status, 200);
  assert.equal(r.body.total, 345, 'the shared search did not find the imported candidates');
  const c = r.body.candidates[0];
  assert.ok(c.name && c.skills.length && c.location, 'the basic profile is incomplete');
  // and the same person is NOT in Recruiter 6's own pool
  assert.equal((await R6.get('/api/candidates?scope=pool&skills=Quantumweaving')).body.total, 0);
});

test('6. the Find Candidates total is the global candidate count, for every role', async () => {
  const global = (await raw(`select count(*)::int n from candidates`)).rows[0].n;
  assert.ok(global >= 349);
  for (const [who, name] of [[ADMIN, 'admin'], [HTL, 'HTL'], [H1, 'H1'], [H2, 'H2'], [R6, 'R6'], [M1, 'M1'], [MTL, 'MTL']]) {
    const t = (await who.get('/api/candidates?limit=1&availabilityAll=true')).body.total;
    assert.equal(t, global, `${name} sees ${t}, the database holds ${global}`);
  }
});

test('7. search results never carry notes, tags, ratings, importer, pool membership, application status or AI scores', async () => {
  // H1 writes private notes and tags on an imported person and on an applicant
  const imported = (await raw(`select id from candidates where email = 'imp7@tl-sink.local'`)).rows[0].id;
  const note = await H1.put(`/api/talent-pool/${imported}`, { notes: 'SECRET-NOTE-H1', tags: ['SECRET-TAG-H1'], internalRemarks: 'SECRET-REMARK-H1' });
  assert.equal(note.status, 200, j(note));
  await H1.put('/api/talent-pool/cand_a1', { notes: 'SECRET-NOTE-APPLICANT', tags: ['SECRET-TAG-APP'] });
  await raw(`update candidates set pool_status = 'interested', ai_interview_score = 93, qualified = true where id in ($1, 'cand_a1')`, [imported]);
  const h1id = (await raw(`select id from recruiters where email = 'h1@tl-sink.local'`)).rows[0].id;

  const { RECRUITER_ONLY_KEYS } = await import('../src/shapes.js');
  const FORBIDDEN_TEXT = ['SECRET-NOTE', 'SECRET-TAG', 'SECRET-REMARK', h1id, 'Hema One', 'imported_by', 'import_id'];
  for (const [who, name] of [[R6, 'R6'], [H2, 'H2'], [M1, 'M1'], [MTL, 'MTL']]) {
    for (const q of ['q=Importee&limit=500', 'q=Anita&limit=50', 'skills=Python&limit=500', 'limit=500']) {
      const r = await who.get(`/api/candidates?${q}&availabilityAll=true`);
      assert.equal(r.status, 200);
      const text = JSON.stringify(r.body);
      for (const needle of FORBIDDEN_TEXT) assert.ok(!text.includes(needle), `${name} ${q}: "${needle}" leaked into search results`);
      for (const c of r.body.candidates) {
        for (const k of RECRUITER_ONLY_KEYS) assert.ok(!(k in c), `${name}: "${k}" is in a shared search row`);
      }
      const OWN = { R6: [jobs.r6], H2: [jobs.h2], M1: [jobs.m1], MTL: [jobs.m1] }[name];
      for (const a of r.body.applications) {
        assert.ok(OWN.includes(a.jobId), `${name}: another recruiter's application came back`);
      }
      for (const c of r.body.candidates) {
        assert.ok(c.appliedJobId == null || OWN.includes(c.appliedJobId),
          `${name}: another recruiter's application status is on a shared row`);
      }
    }
    // the profile opened from a search is the same basic profile
    const prof = await who.get(`/api/candidates/${imported}`);
    assert.equal(prof.status, 200);
    assert.ok(!JSON.stringify(prof.body).includes('SECRET'), `${name}: the opened profile carried a note`);
    const panel = await who.get(`/api/candidates/${imported}/engagements`);
    assert.ok(!JSON.stringify(panel.body).includes('Hema One'), `${name}: the activity panel named a colleague`);
    const badges = await who.post('/api/engagement/badges', { candidateIds: [imported, 'cand_a1'] });
    assert.ok(!JSON.stringify(badges.body).includes('Hema One'), `${name}: a badge named a colleague`);
  }
  // the owner (and only the owner's team lead) still reads the layer
  const mine = (await H1.get(`/api/candidates?scope=pool&q=Importee 7&limit=5`)).body.candidates[0];
  assert.equal(mine.recruiterNotes, 'SECRET-NOTE-H1');
  assert.deepEqual(mine.tags, ['SECRET-TAG-H1']);
  const lead = (await HTL.get(`/api/talent-pool/${imported}`)).body.entry;
  assert.equal(lead.notes, 'SECRET-NOTE-H1', 'the team lead reads a department pool entry');
  assert.equal((await H2.get(`/api/talent-pool/${imported}`)).status, 404);
  // the profile of an applicant to ANOTHER recruiter's job: no pipeline for outsiders
  const outsider = await R6.get('/api/candidates/cand_a1');
  assert.equal(outsider.body.applications.length, 0);
  assert.equal(outsider.body.candidate.stage === undefined || outsider.body.candidate.stage === 'registered', true);
});

test('8. one person imported by two recruiters: one candidates row, two talent_pool rows, separate notes', async () => {
  const dup = csv(['Shared Sharma,9877700001,shared.sharma@tl-sink.local,Quantumweaving,Nellore']);
  assert.equal((await H1.post('/api/candidates/import', { text: dup })).body.imported, 1);
  const again = await H2.post('/api/candidates/import', { text: dup });
  assert.equal(again.status, 201, j(again));
  assert.equal(again.body.imported, 0);
  assert.equal(again.body.updated, 1, 'the second import must reuse the person, not create them');
  const rows = (await raw(`select id from candidates where lower(email) = 'shared.sharma@tl-sink.local'`)).rows;
  assert.equal(rows.length, 1, 'a duplicate candidates row was created');
  const cid = rows[0].id;
  const pools = (await raw(`select recruiter_id from talent_pool where candidate_id = $1 order by 1`, [cid])).rows;
  assert.equal(pools.length, 2);
  assert.equal((await H1.put(`/api/talent-pool/${cid}`, { notes: 'H1 says: strong', tags: ['h1-tag'] })).status, 200);
  assert.equal((await H2.put(`/api/talent-pool/${cid}`, { notes: 'H2 says: weak', tags: ['h2-tag'] })).status, 200);
  const e1 = (await H1.get(`/api/talent-pool/${cid}`)).body.entry;
  const e2 = (await H2.get(`/api/talent-pool/${cid}`)).body.entry;
  assert.equal(e1.notes, 'H1 says: strong');
  assert.equal(e2.notes, 'H2 says: weak');
  assert.deepEqual(e1.tags, ['h1-tag']);
  assert.deepEqual(e2.tags, ['h2-tag']);
  // the manual add form reuses an existing person too, even with "add anyway"
  const manual = await M1.post('/api/candidates', {
    firstName: 'Shared', lastName: 'Sharma', phone: '9877700001', gender: 'Male',
    email: 'shared.sharma@tl-sink.local', sendCredentials: false, allowDuplicate: true, recruiterNotes: 'M1 note',
  });
  assert.equal(manual.status, 200, j(manual));
  assert.equal(manual.body.reused, true);
  assert.equal((await raw(`select count(*)::int n from candidates where lower(email) = 'shared.sharma@tl-sink.local'`)).rows[0].n, 1);
  assert.equal((await M1.get(`/api/talent-pool/${cid}`)).body.entry.notes, 'M1 note');
  assert.equal((await raw(`select count(*)::int n from candidates where recruiter_notes is not null or internal_remarks is not null or candidate_notes is not null`)).rows[0].n, 0,
    'notes were written to candidates');
  // the private candidates row has no notes at all
  assert.equal((await raw(`select count(*)::int n from talent_pool where candidate_id = $1`, [cid])).rows[0].n, 3);
});

test('9. a candidate on the public site sees public job fields only', async () => {
  const cand = await signIn('anita@tl-sink.local');
  const PUBLIC = new Set(['id', 'title', 'companyId', 'location', 'mode', 'exp', 'pay', 'type', 'status', 'skills', 'desc',
    'responsibilities', 'requirements', 'featured', 'easyApply', 'department', 'education', 'salaryMin', 'salaryMax',
    'postingKind', 'gender', 'accommodation', 'jobType', 'applicants', 'posted', 'postedDaysAgo', 'sourceType', 'source',
    'jobSourceType', 'jobSourceName', 'originalJobUrl', 'expiresOn', 'lastDate', 'urgent', 'urgentHiring', 'lastDateToApply', 'openings', 'paused', 'archived', 'publishedAt',
    'screeningQuestions', 'walkinStatus', 'applyUrl']);
  for (const who of [cand, makeClient(base)]) {
    const list = await who.get('/api/jobs?limit=200');
    assert.ok(list.body.jobs.length >= 4);
    const text = JSON.stringify(list.body);
    for (const needle of ['Hema One', 'h1@tl-sink.local', 'Keerthana', 'recruiterId', 'createdBy', 'created_by', 'ai_score', 'aiScore', 'matchScore', 'SECRET']) {
      assert.ok(!text.includes(needle), `public job list leaks "${needle}"`);
    }
    for (const job of list.body.jobs) {
      const extra = Object.keys(job).filter((k) => !PUBLIC.has(k) && !k.startsWith('walkin') && !k.startsWith('internship') && k !== 'stipend');
      assert.deepEqual(extra, [], `non-public job fields: ${extra.join(', ')}`);
    }
    const one = await who.get(`/api/jobs/${jobs.h1}`);
    assert.equal(one.status, 200);
    assert.ok(!JSON.stringify(one.body).includes('recruiterId'));
  }
  // and a candidate cannot read the recruiter-side numbers or pool
  assert.equal((await cand.get('/api/recruiter/home-stats')).status, 403);
  assert.equal((await cand.get('/api/talent-pool/count')).status, 403);
  assert.equal((await cand.get('/api/candidates?scope=pool')).status, 403);
});

test('10. dashboard numbers equal a direct count of each role\'s scope', async () => {
  const direct = async (jobWhere, params = []) => {
    const q = (sql) => raw(sql, params).then((r) => r.rows[0]);
    const jb = await q(`select count(*)::int n, count(*) filter (where status = 'open' and not archived)::int open_jobs,
                              count(*) filter (where status <> 'closed')::int active, count(*) filter (where featured)::int featured
                         from jobs where ${jobWhere}`);
    const ap = await q(`select count(*)::int n, count(*) filter (where stage = 'shortlisted')::int shortlisted, avg(match_score) as avg
                         from applications where job_id in (select id from jobs where ${jobWhere})`);
    return { jb, ap };
  };
  const cases = [
    [H1, `recruiter_id = (select id from recruiters where email = 'h1@tl-sink.local')`],
    [H2, `recruiter_id = (select id from recruiters where email = 'h2@tl-sink.local')`],
    [HTL, `department_id = 'healthcare'`],
    [M1, `recruiter_id = (select id from recruiters where email = 'm1@tl-sink.local')`],
    [MTL, `department_id = 'manufacturing'`],
    [ADMIN, `true`],
  ];
  for (const [who, where] of cases) {
    const { stats } = (await who.get('/api/recruiter/home-stats')).body;
    const d = await direct(where);
    assert.equal(stats.jobs.total, d.jb.n, `jobs ${where}`);
    assert.equal(stats.jobs.openJobs, d.jb.open_jobs);
    assert.equal(stats.jobs.activeRoles, d.jb.active);
    assert.equal(stats.jobs.featured, d.jb.featured);
    assert.equal(stats.applications.total, d.ap.n, `applications ${where}`);
    assert.equal(stats.applications.shortlisted, d.ap.shortlisted);
    assert.equal(stats.applications.avgAiMatch, d.ap.avg == null ? null : Math.round(Number(d.ap.avg)));
  }
  // team lead = H1 + H2 added up, Manufacturing lead sees none of it
  const t = (await HTL.get('/api/recruiter/home-stats')).body.stats;
  const a = (await H1.get('/api/recruiter/home-stats')).body.stats;
  const b = (await H2.get('/api/recruiter/home-stats')).body.stats;
  assert.equal(t.jobs.total, a.jobs.total + b.jobs.total);
  assert.equal(t.applications.total, a.applications.total + b.applications.total);
  assert.equal((await MTL.get('/api/recruiter/home-stats')).body.stats.applications.total, 1);
  // the global total is NOT a dashboard number; people = applicants + pool in scope
  const h1 = (await H1.get('/api/recruiter/home-stats')).body.stats;
  assert.equal(h1.candidates.total, 347, 'Home candidates = applicants + own pool (345 imported + 1 applicant + 1 shared), not the database');
  assert.equal(h1.candidates.applied, 1);
  // zero applicants: no NaN, no error
  const fresh = await staff('Zed Zero', 'zed@tl-sink.local', 'education');
  const z = (await fresh.get('/api/recruiter/home-stats')).body.stats;
  assert.equal(z.applications.total, 0);
  assert.equal(z.applications.avgAiMatch, null);
  assert.equal(z.jobs.total, 0);
  assert.equal(z.candidates.total, 0);
  // the bootstrap carries the same numbers the endpoint answers
  const boot = (await H1.get('/api/bootstrap')).body.data.homeStats;
  assert.equal(boot.jobs.total, a.jobs.total);
  // outreach is the caller's: a message H2 sends is not in H1's count
  await raw(`insert into message_logs (candidate_id, channel, body, status, sent_by)
             values ('cand_a2','email','hi','sent', (select user_id from recruiters where email = 'h2@tl-sink.local'))`);
  assert.equal((await H1.get('/api/recruiter/home-stats')).body.stats.outreach.email.sent, 0);
  assert.equal((await H2.get('/api/recruiter/home-stats')).body.stats.outreach.email.sent, 1);
  assert.equal((await HTL.get('/api/recruiter/home-stats')).body.stats.outreach.email.sent, 1, 'the team lead counts the department\'s outreach');
  assert.equal((await MTL.get('/api/recruiter/home-stats')).body.stats.outreach.email.sent, 0);
});

test('11. tampering: a role, user id or department sent by the client widens nothing', async () => {
  const forged = {
    headers: { 'x-user-role': 'admin', 'x-role': 'admin', 'x-department-id': 'healthcare', 'x-user-id': 'adm',
               'x-recruiter-id': 'r_other', 'x-forwarded-user': 'admin@tl-sink.local' },
  };
  const q = '?role=admin&userId=adm&recruiterId=x&departmentId=healthcare&department=healthcare&scopeRole=admin&mine=all&teamLead=true';
  const clean = async (who, p) => (await who.get(p)).body;

  // jobs
  const jobsPlain = ids((await M1.get('/api/jobs?view=all&limit=200')).body.jobs).sort();
  const jobsForged = ids((await M1.get(`/api/jobs${q}&view=all&limit=200`, forged)).body.jobs).sort();
  assert.deepEqual(jobsForged, jobsPlain);
  assert.ok(!jobsForged.includes(jobs.h1));
  assert.equal((await M1.get(`/api/jobs/${jobs.h1}${q}`, forged)).status, 404);
  // applications, pool, candidates, dashboard, bootstrap
  assert.deepEqual((await clean(M1, `/api/applications${q}&limit=500`)).applications.length, 1);
  assert.equal((await M1.get(`/api/applications${q}&limit=500`, forged)).body.applications.length, 1);
  assert.equal((await M1.get(`/api/candidates${q}&scope=pool&limit=5`, forged)).body.total, 2);
  assert.equal((await M1.get(`/api/talent-pool/count${q}`, forged)).body.count, 2);
  assert.equal((await M1.get(`/api/recruiter/home-stats${q}`, forged)).body.stats.jobs.total, 1);
  const boot = await M1.get(`/api/bootstrap${q}`, forged);
  assert.deepEqual(ids(boot.body.data.jobs), [jobs.m1]);
  assert.equal(boot.body.session.scopeRole, 'recruiter');
  // a cookie-borne or body-borne identity is ignored on write
  const made = await M1.post('/api/jobs', {
    title: 'Forged Owner Job', companyId: 'co_x', location: 'Pune', exp: '1 yr', status: 'open', desc: 'x',
    gender: 'Male', recruiterId: 'r_someone_else', departmentId: 'healthcare', createdBy: 'adm', role: 'admin',
  }, forged);
  assert.equal(made.status, 201, j(made));
  const row = (await raw(`select recruiter_id, department_id, created_by from jobs where id = $1`, [made.body.job.id])).rows[0];
  assert.equal(row.department_id, 'manufacturing', 'the client chose the job\'s department');
  assert.equal(row.recruiter_id, (await raw(`select id from recruiters where email = 'm1@tl-sink.local'`)).rows[0].id);
  assert.equal(row.created_by, (await raw(`select id from users where email = 'm1@tl-sink.local'`)).rows[0].id);
  // moving a job to another department / owner through the edit is ignored
  const edit = await M1.put(`/api/jobs/${made.body.job.id}`, { title: 'Forged Owner Job 2', companyId: 'co_x', departmentId: 'healthcare', recruiterId: 'r_x', department_id: 'healthcare' });
  assert.equal(edit.status, 200, j(edit));
  assert.equal((await raw(`select department_id from jobs where id = $1`, [made.body.job.id])).rows[0].department_id, 'manufacturing');
  // writing a pool entry or role for somebody else
  assert.equal((await M1.put('/api/talent-pool/cand_a1', { notes: 'x', recruiterId: 'r_any' }, forged)).status, 404);
  assert.equal((await M1.post('/api/staff/recruiters', { name: 'Evil Admin', email: 'evil@tl-sink.local', password: PASSWORD }, forged)).status, 403);
  assert.equal((await M1.patch('/api/staff/recruiters/anything', { accessRole: 'teamlead', departmentId: 'manufacturing' }, forged)).status, 403);
  // a department-less recruiter, however they ask, sees only their own
  const lone = await staff('Lone Wolf', 'lone@tl-sink.local', '');
  assert.equal((await lone.get('/api/jobs?view=all&limit=200')).body.jobs.length, 0);
  assert.equal((await lone.get('/api/recruiter/home-stats')).body.stats.jobs.total, 0);
});

test('team lead without a department cannot exist, and one moved to another department takes their pool', async () => {
  const rid = (await raw(`select id from recruiters where email = 'lone@tl-sink.local'`)).rows[0].id;
  const lead = await ADMIN.patch(`/api/staff/recruiters/${rid}`, { accessRole: 'teamlead' });
  assert.equal(lead.status, 400, 'a team lead with no department was accepted');
  // and the database refuses it too, whoever asks
  await assert.rejects(() => raw(`update users set is_team_lead = true where email = 'lone@tl-sink.local'`).catch((e) => {
    assert.match(String(e.message), /users_team_lead_has_department|check constraint/i);
    throw new Error('refused');
  }), /refused/);

  // move H2 to Manufacturing: their pool entries follow them, their old job stays Healthcare's
  const h2id = (await raw(`select id from recruiters where email = 'h2@tl-sink.local'`)).rows[0].id;
  assert.equal((await ADMIN.patch(`/api/staff/recruiters/${h2id}`, { departmentId: 'manufacturing' })).status, 200);
  const pools = (await raw(`select distinct department_id from talent_pool where recruiter_id = $1`, [h2id])).rows;
  assert.deepEqual(pools.map((p) => p.department_id), ['manufacturing']);
  assert.equal((await raw(`select department_id from jobs where id = $1`, [jobs.h2])).rows[0].department_id, 'healthcare');
  assert.ok(!(await HTL.get('/api/applications?limit=500')).body.applications.some((a) => a.jobId === jobs.m1));
  assert.equal((await ADMIN.patch(`/api/staff/recruiters/${h2id}`, { departmentId: 'healthcare' })).status, 200);
});

test('shutdown', async () => {
  const { closePool } = await import('../src/db.js');
  await new Promise((r) => server.close(r));
  await closePool();
  await dbh.stop();
});
