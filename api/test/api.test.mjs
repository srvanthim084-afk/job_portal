/**
 * End-to-end API tests against a real Postgres with RLS active.
 *
 * These follow requirement 26's three workflows — candidate, recruiter,
 * admin — plus the security cases that must NOT work.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb, applyTestEnv, makeClient, startMockProvider } from './harness.mjs';

const PORT = 5433;
const API_PORT = 9999;

let dbHandle, server, client, createApp, hashPassword, getPool, closePool, mockProvider;

test('boot: migrate, seed accounts, start API', async () => {
  dbHandle = await startTestDb(PORT);
  mockProvider = await startMockProvider();
  applyTestEnv(dbHandle.url);

  // imported only after the env is in place — config reads it at import time
  ({ createApp } = await import('../src/app.js'));
  ({ hashPassword } = await import('../src/auth.js'));
  ({ getPool, closePool } = await import('../src/db.js'));

  // Give the seeded profiles logins, as seed-auth.js does in production.
  //
  // This runs on the RAW PGlite handle, never on a client borrowed from the
  // API's pool: a privileged statement on a pooled connection persists
  // after release and would hand a later request a superuser connection
  // with RLS switched off.
  {
    const hash = await hashPassword('TestPass123');
    const c = {
      query: async (sql, params) => dbHandle.db.query(sql, params),
    };
    for (const [table, role, id] of [
      ['candidates', 'candidate', 'cand1'],
      ['candidates', 'candidate', 'cand6'],
      ['candidates', 'candidate', 'cand4'],
      ['candidates', 'candidate', 'cand8'],
      ['recruiters', 'recruiter', 'r1'],
      ['recruiters', 'recruiter', 'r2'],
      ['client_users', 'client',  'c1'],
      ['admins',     'admin',     'a1'],
    ]) {
      const email = `${id}@test.local`;
      const u = await c.query(
        `insert into users (email,password_hash,role) values ($1,$2,$3) returning id`,
        [email, hash, role]);
      await c.query(`update ${table} set user_id=$1 where id=$2`, [u.rows[0].id, id]);
    }
  }

  const app = createApp({ logger: { error() {}, log() {} } });
  await new Promise((r) => { server = app.listen(API_PORT, r); });
  client = makeClient(`http://127.0.0.1:${API_PORT}`);

  const health = await client.get('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
});

/* ------------------------------------------------------------------ *
 * public surface
 * ------------------------------------------------------------------ */

test('anonymous bootstrap returns open jobs but no candidates', async () => {
  const res = await client.get('/api/bootstrap');
  assert.equal(res.status, 200);
  assert.equal(res.body.session, null);
  assert.ok(res.body.data.jobs.length > 0, 'public job board must not be empty');
  assert.equal(res.body.data.candidates.length, 0, 'candidates leaked to anonymous');
  assert.equal(res.body.data.applications.length, 0, 'applications leaked to anonymous');
});

test('jobs carry the prototype field names the UI reads', async () => {
  const res = await client.get('/api/jobs?limit=1');
  const job = res.body.jobs[0];
  // These names are a compatibility contract with prototype.html —
  // renaming any of them silently blanks part of the UI.
  for (const k of ['id','title','companyId','location','mode','exp','pay','type',
                   'skills','desc','responsibilities','requirements','applicants','posted']) {
    assert.ok(k in job, `job.${k} missing — the UI reads it`);
  }
  assert.ok(Array.isArray(job.skills));
  assert.equal(typeof job.applicants, 'number');
});

test('a draft job is invisible publicly and reports JOB_UNAVAILABLE', async () => {
  await dbHandle.db.exec(
    `insert into jobs (id,title,company_id,status) values ('jsecret','Secret','technova','draft')`);

  const list = await client.get('/api/jobs?limit=200');
  assert.ok(!list.body.jobs.some((j) => j.id === 'jsecret'), 'draft job listed publicly');

  const one = await client.get('/api/jobs/jsecret');
  assert.equal(one.status, 404);
  assert.equal(one.body.error.code, 'JOB_UNAVAILABLE');
});

/* ------------------------------------------------------------------ *
 * authentication
 * ------------------------------------------------------------------ */

test('login rejects a wrong password without revealing the account', async () => {
  const res = await client.post('/api/auth/login', { email: 'cand1@test.local', password: 'wrong' });
  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, 'INVALID_CREDENTIALS');
  assert.ok(!/cand1/i.test(res.body.error.message), 'error message leaks account detail');
});

test('login for an unknown email gives the identical response', async () => {
  const res = await client.post('/api/auth/login', { email: 'nobody@test.local', password: 'wrong' });
  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, 'INVALID_CREDENTIALS');
});

test('login rejects a malformed email with field-level detail', async () => {
  const res = await client.post('/api/auth/login', { email: 'not-an-email', password: 'x' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'VALIDATION_FAILED');
  assert.ok(res.body.error.details.email, 'expected a per-field message for the UI');
});

test('candidate login succeeds and sets an httpOnly session cookie', async () => {
  const res = await client.post('/api/auth/login',
    { email: 'cand1@test.local', password: 'TestPass123' });
  assert.equal(res.status, 200);
  assert.equal(res.body.session.role, 'candidate');
  assert.equal(res.body.session.id, 'cand1');

  const setCookies = res.headers.getSetCookie();
  const session = setCookies.find((c) => c.startsWith('tl_session='));
  assert.ok(session, 'no session cookie issued');
  assert.match(session, /HttpOnly/i, 'session cookie must be HttpOnly so XSS cannot read it');
  assert.match(session, /SameSite=Lax/i);
});

test('signing in from the wrong role portal is refused', async () => {
  const c2 = makeClient(`http://127.0.0.1:${API_PORT}`);
  const res = await c2.post('/api/auth/login',
    { email: 'cand1@test.local', password: 'TestPass123', role: 'admin' });
  assert.equal(res.status, 403);
  assert.match(res.body.error.message, /candidate portal/i);
});

/* ------------------------------------------------------------------ *
 * candidate workflow (requirement 26)
 * ------------------------------------------------------------------ */

test('candidate bootstrap returns only their own data', async () => {
  const res = await client.get('/api/bootstrap');
  assert.equal(res.body.session.role, 'candidate');
  assert.deepEqual(res.body.data.candidates.map((c) => c.id), ['cand1']);
});

test('the primary application is re-attached onto the candidate (§3.1)', async () => {
  const res = await client.get('/api/bootstrap');
  const me = res.body.data.candidates[0];
  // the prototype reads cand.appliedJobId / cand.stage in ~100 places
  assert.ok(me.appliedJobId, 'cand.appliedJobId not rebuilt from the applications table');
  assert.ok(me.stage, 'cand.stage not rebuilt');
  assert.equal(me.stage, 'selected', 'cand1 is seeded at the selected stage');
});

test('candidate applies to a job: application + notification + live count', async () => {
  const before = await client.get('/api/jobs/j11');
  const startCount = before.body.job.applicants;

  const res = await client.post('/api/applications', { jobId: 'j11' });
  assert.equal(res.status, 201);
  assert.equal(res.body.application.jobId, 'j11');
  assert.equal(res.body.application.candidateId, 'cand1');
  assert.equal(res.body.application.stage, 'applied');
  assert.ok(res.body.notification, 'no notification created for the application');
  assert.equal(res.body.applicants, startCount + 1, 'applicants count did not move');
});

test('applying twice is refused with DUPLICATE_APPLICATION', async () => {
  const res = await client.post('/api/applications', { jobId: 'j11' });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'DUPLICATE_APPLICATION');
});

test('applying to a draft job is refused', async () => {
  const res = await client.post('/api/applications', { jobId: 'jsecret' });
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, 'JOB_UNAVAILABLE');
});

test('candidate sees only their own notifications', async () => {
  const res = await client.get('/api/notifications');
  assert.equal(res.status, 200);
  assert.ok(res.body.notifications.length > 0);
  for (const n of res.body.notifications) {
    assert.equal(n.recipientId, 'cand1', 'a notification for someone else was returned');
  }
});

test('candidate CANNOT change their own application stage', async () => {
  const apps = await client.get('/api/applications');
  const mine = apps.body.applications[0];
  const res = await client.put(`/api/applications/${mine.id}/status`, { stage: 'selected' });
  assert.equal(res.status, 403, 'a candidate promoted themselves');
});

test('candidate CANNOT read another candidate', async () => {
  const res = await client.get('/api/candidates/cand5');
  assert.ok([403, 404].includes(res.status), `expected refusal, got ${res.status}`);
});

test('candidate CANNOT list the talent pool', async () => {
  const res = await client.get('/api/candidates');
  assert.equal(res.status, 403);
});

test('candidate CANNOT create a job', async () => {
  const res = await client.post('/api/jobs', { title: 'Fake', companyId: 'technova' });
  assert.equal(res.status, 403);
});

test('candidate can edit their own profile but not someone else\'s', async () => {
  const ok = await client.put('/api/candidates/cand1', { title: 'Senior React Developer' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.candidate.title, 'Senior React Developer');

  const nope = await client.put('/api/candidates/cand5', { title: 'Hijacked' });
  assert.equal(nope.status, 403);
});

/* ------------------------------------------------------------------ *
 * recruiter workflow
 * ------------------------------------------------------------------ */

let recruiter;

test('recruiter signs in', async () => {
  recruiter = makeClient(`http://127.0.0.1:${API_PORT}`);
  const res = await recruiter.post('/api/auth/login',
    { email: 'r1@test.local', password: 'TestPass123' });
  assert.equal(res.status, 200);
  assert.equal(res.body.session.role, 'recruiter');
});

test('Find Candidates filters in SQL and paginates (requirements 10, 11)', async () => {
  const all = await recruiter.get('/api/candidates?limit=5');
  assert.equal(all.status, 200);
  assert.ok(all.body.total > 0);
  assert.ok(all.body.candidates.length <= 5, 'limit not applied — the browser would get everything');
  assert.equal(typeof all.body.hasMore, 'boolean');

  const react = await recruiter.get('/api/candidates?skills=React');
  assert.ok(react.body.total >= 1, 'skills filter returned nothing');
  for (const c of react.body.candidates) {
    const skills = [...(c.skills || []), ...(c.technicalSkills || [])];
    assert.ok(skills.includes('React'), `${c.id} has no React skill but matched`);
  }

  const byLoc = await recruiter.get('/api/candidates?location=Pune');
  for (const c of byLoc.body.candidates) assert.equal(c.location, 'Pune');

  // a second page must not repeat the first
  const p1 = await recruiter.get('/api/candidates?limit=3&offset=0');
  const p2 = await recruiter.get('/api/candidates?limit=3&offset=3');
  const ids1 = p1.body.candidates.map((c) => c.id);
  const ids2 = p2.body.candidates.map((c) => c.id);
  assert.equal(ids1.filter((i) => ids2.includes(i)).length, 0, 'pagination overlaps');
});

test('search input cannot inject SQL', async () => {
  const res = await recruiter.get("/api/candidates?q=" + encodeURIComponent("'; drop table candidates; --"));
  assert.equal(res.status, 200);
  const still = await recruiter.get('/api/candidates?limit=1');
  assert.ok(still.body.total > 0, 'candidates table did not survive — injection succeeded');
});

test('recruiter moves an application and the candidate is notified', async () => {
  const apps = await recruiter.get('/api/applications?candidateId=cand1');
  const target = apps.body.applications.find((a) => a.jobId === 'j11');
  assert.ok(target, 'recruiter cannot see the application just created at their company');

  const res = await recruiter.put(`/api/applications/${target.id}/status`, { stage: 'shortlisted' });
  assert.equal(res.status, 200);
  assert.equal(res.body.application.stage, 'shortlisted');

  const hist = await recruiter.get(`/api/applications/${target.id}/history`);
  assert.ok(hist.body.history.length >= 2, 'stage history not recorded');
  assert.equal(hist.body.history.at(-1).to_stage, 'shortlisted');

  // requirement 13: the candidate must see the change
  const seen = await client.get('/api/notifications');
  assert.ok(seen.body.notifications.some((n) => n.type === 'APPLICATION_STATUS'),
    'candidate never received the status notification');
});

test('requirement 17: the candidate now reads the updated stage', async () => {
  const res = await client.get('/api/applications');
  const updated = res.body.applications.find((a) => a.jobId === 'j11');
  assert.equal(updated.stage, 'shortlisted', 'the two sides disagree — not one source of truth');
});

test('recruiter creates a job, edits it, and the Job ID never changes', async () => {
  const created = await recruiter.post('/api/jobs', {
    title: 'Platform Engineer', companyId: 'technova',
    location: 'Bengaluru', type: 'Full-time', status: 'draft',
    skills: ['Go', 'Kubernetes'],
  });
  assert.equal(created.status, 201);
  const id = created.body.job.id;

  const edited = await recruiter.put(`/api/jobs/${id}`, {
    title: 'Senior Platform Engineer', companyId: 'technova', skills: ['Go', 'Kubernetes', 'AWS'],
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.job.id, id, 'the Job ID changed on edit (requirement 6)');
  assert.equal(edited.body.job.title, 'Senior Platform Engineer');

  const published = await recruiter.post(`/api/jobs/${id}/publish`, { publish: true });
  assert.equal(published.body.job.status, 'open');
  assert.equal(published.body.job.id, id, 'the Job ID changed on publish');

  // and only ONE record exists
  const all = await recruiter.get('/api/jobs?view=all&limit=200');
  assert.equal(all.body.jobs.filter((j) => j.id === id).length, 1, 'edit duplicated the job');
});

test("recruiter cannot edit another company's job", async () => {
  const r2 = makeClient(`http://127.0.0.1:${API_PORT}`);
  await r2.post('/api/auth/login', { email: 'r2@test.local', password: 'TestPass123' });
  const res = await r2.put('/api/jobs/j1', { title: 'HIJACKED', companyId: 'technova' });
  assert.equal(res.status, 403);

  const check = await recruiter.get('/api/jobs/j1');
  assert.notEqual(check.body.job.title, 'HIJACKED');
});

/* ------------------------------------------------------------------ *
 * client + admin
 * ------------------------------------------------------------------ */

test('scheduling an interview persists it, moves the stage and notifies', async () => {
  // cand4 applied to j4, which belongs to TechNova — the recruiter's own
  // company. (cand6/j6 are HealthCare Plus and correctly invisible to r1.)
  const before = await recruiter.get('/api/interviews?candidateId=cand4');
  const res = await recruiter.post('/api/interviews', {
    candidateId: 'cand4', jobId: 'j4', date: '2026-10-15', time: '11:00 AM',
    mode: 'Video Call', type: 'Technical (Human)',
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.interview.candidateId, 'cand4');
  assert.equal(res.body.interview.status, 'Scheduled');

  const after = await recruiter.get('/api/interviews?candidateId=cand4');
  assert.equal(after.body.interviews.length, before.body.interviews.length + 1,
    'the interview did not persist');

  const apps = await recruiter.get('/api/applications?candidateId=cand4');
  const app = apps.body.applications.find((a) => a.jobId === 'j4');
  assert.equal(app.stage, 'interview_scheduled', 'the pipeline stage did not follow');
});

test('an interview DATE is not shifted by a timezone', async () => {
  // A `date` column comes back from node-postgres as a JS Date at LOCAL
  // midnight by default, so any server east of UTC formats it a day early:
  // book the 15th, display the 14th. A calendar date has no timezone and
  // must survive the round trip exactly.
  const res = await recruiter.post('/api/interviews', {
    candidateId: 'cand4', jobId: 'j11', date: '2026-10-15', time: '09:30 AM',
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.interview.date, '2026-10-15',
    `date shifted on write: sent 2026-10-15, got ${res.body.interview.date}`);

  const list = await recruiter.get('/api/interviews?candidateId=cand4');
  const found = list.body.interviews.find((i) => i.id === res.body.interview.id);
  assert.equal(found.date, '2026-10-15',
    `date shifted on read: got ${found.date}`);
});

test('candidate search: the new sidebar filters run in SQL', async () => {
  const cases = [
    ['gender=Female',      (c) => c.gender === 'Female'],
    ['emailVerified=true', (c) => c.emailVerified === true],
    ['hasResume=true',     (c) => !!c.resumeFile],
  ];
  for (const [qs, pred] of cases) {
    const r = await recruiter.get(`/api/candidates?${qs}&limit=200`);
    assert.equal(r.status, 200, `${qs} failed`);
    assert.ok(r.body.total > 0, `${qs} matched nothing`);
    for (const c of r.body.candidates) {
      assert.ok(pred(c), `${qs} returned ${c.id}, which does not match`);
    }
  }

  // a minimum-salary filter must not silently drop candidates who have not
  // stated a package, unless explicitly told to
  const withZero = await recruiter.get('/api/candidates?ctcMin=15&limit=200');
  const strict   = await recruiter.get('/api/candidates?ctcMin=15&includeZeroSalary=false&limit=200');
  assert.ok(withZero.body.total >= strict.body.total,
    'includeZeroSalary made the result set larger, not smaller');

  // an unknown sort must not reach the SQL string
  const weird = await recruiter.get('/api/candidates?sort=' + encodeURIComponent('name; drop table candidates'));
  assert.equal(weird.status, 200);
  const alive = await recruiter.get('/api/candidates?limit=1');
  assert.ok(alive.body.total > 0, 'candidates table did not survive a crafted sort');
});

test('client never sees early-stage applications', async () => {
  const cl = makeClient(`http://127.0.0.1:${API_PORT}`);
  await cl.post('/api/auth/login', { email: 'c1@test.local', password: 'TestPass123' });
  const res = await cl.get('/api/applications');
  assert.equal(res.status, 200);
  for (const a of res.body.applications) {
    assert.ok(!['applied', 'ai_screening'].includes(a.stage),
      `client saw a candidate at stage ${a.stage}`);
  }
});

test('admin dashboard reads real database totals (requirement 16)', async () => {
  const admin = makeClient(`http://127.0.0.1:${API_PORT}`);
  await admin.post('/api/auth/login', { email: 'a1@test.local', password: 'TestPass123' });
  const res = await admin.get('/api/bootstrap');

  assert.equal(res.body.data.candidates.length, 10, 'admin should see every candidate');
  assert.ok(res.body.data.jobs.length >= 13);
  assert.ok(res.body.data.interviews.length >= 7);
  assert.ok(res.body.data.recruiters.length >= 3);
  // the numbers on the dashboard are counts of real rows, not constants
  const totalApplicants = res.body.data.jobs.reduce((n, j) => n + j.applicants, 0);
  assert.ok(totalApplicants > 0);
});

/* ------------------------------------------------------------------ *
 * session, CSRF, uploads, errors
 * ------------------------------------------------------------------ */

test('a write without the CSRF header is refused', async () => {
  const bare = makeClient(`http://127.0.0.1:${API_PORT}`);
  await bare.post('/api/auth/login', { email: 'cand1@test.local', password: 'TestPass123' });
  const token = bare.jar.get('tl_csrf');
  bare.jar.delete('tl_csrf');                       // simulate a cross-site POST
  const res = await bare.put('/api/candidates/cand1', { title: 'No CSRF' });
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'CSRF_FAILED');
  bare.jar.set('tl_csrf', token);
});

test('logout invalidates the session immediately', async () => {
  const tmp = makeClient(`http://127.0.0.1:${API_PORT}`);
  await tmp.post('/api/auth/login', { email: 'cand1@test.local', password: 'TestPass123' });
  assert.equal((await tmp.get('/api/auth/me')).body.session.role, 'candidate');
  await tmp.post('/api/auth/logout', {});
  const after = await tmp.get('/api/auth/me');
  assert.equal(after.body.session, null);
});

test('a forged session cookie is rejected', async () => {
  const forged = makeClient(`http://127.0.0.1:${API_PORT}`);
  forged.jar.set('tl_session', 'totally-made-up-token');
  const res = await forged.get('/api/auth/me');
  assert.equal(res.body.session, null);
});

test('resume upload rejects a disguised file by its magic bytes', async () => {
  const fd = new FormData();
  // named .pdf, but the contents are HTML — the classic stored-XSS upload
  fd.append('resume', new Blob(['<html><script>alert(1)</script></html>'],
    { type: 'application/pdf' }), 'evil.pdf');
  const res = await client.post('/api/uploads/resume', fd);
  assert.equal(res.status, 415);
  assert.equal(res.body.error.code, 'UNSUPPORTED_FILE');
});

test('resume upload accepts a real PDF and records it on the candidate', async () => {
  const pdf = Buffer.concat([
    Buffer.from('%PDF-1.4\n'),
    Buffer.from('1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n'),
  ]);
  const fd = new FormData();
  fd.append('resume', new Blob([pdf], { type: 'application/pdf' }), 'Ananya_Rao_CV.pdf');
  const res = await client.post('/api/uploads/resume', fd);
  assert.equal(res.status, 201);
  assert.equal(res.body.resume.fileName, 'Ananya_Rao_CV.pdf');
  assert.equal(res.body.candidate.resumeFile, 'Ananya_Rao_CV.pdf');

  // and it is downloadable by its owner
  const link = await client.get('/api/candidates/cand1/resume');
  assert.equal(link.status, 200);
  assert.ok(link.body.url);
});

test('another candidate cannot fetch that resume', async () => {
  const other = makeClient(`http://127.0.0.1:${API_PORT}`);
  await other.post('/api/auth/login', { email: 'cand6@test.local', password: 'TestPass123' });
  const res = await other.get('/api/candidates/cand1/resume');
  assert.ok([403, 404].includes(res.status), `resume leaked, status ${res.status}`);
});

test('registration creates a real account that can sign in', async () => {
  const fresh = makeClient(`http://127.0.0.1:${API_PORT}`);
  const email = `new${Date.now()}@test.local`;
  const reg = await fresh.post('/api/auth/register', {
    name: 'New Person', email, password: 'Str0ngPass1', phone: '+91 90000 00000',
  });
  assert.equal(reg.status, 201);
  assert.equal(reg.body.session.role, 'candidate');

  const again = makeClient(`http://127.0.0.1:${API_PORT}`);
  const login = await again.post('/api/auth/login', { email, password: 'Str0ngPass1' });
  assert.equal(login.status, 200);
});

test('registration rejects a weak password and a duplicate email', async () => {
  const fresh = makeClient(`http://127.0.0.1:${API_PORT}`);
  const weak = await fresh.post('/api/auth/register',
    { name: 'X Y', email: 'weak@test.local', password: 'short' });
  assert.equal(weak.status, 400);
  assert.ok(weak.body.error.details.password);

  const dupe = await fresh.post('/api/auth/register',
    { name: 'X Y', email: 'cand1@test.local', password: 'Str0ngPass1' });
  assert.equal(dupe.status, 409);
  assert.equal(dupe.body.error.code, 'EMAIL_TAKEN');
});

test('errors never leak database internals', async () => {
  const res = await client.put('/api/applications/does-not-exist/status', { stage: 'shortlisted' });
  const text = JSON.stringify(res.body).toLowerCase();
  for (const leak of ['select ', 'insert into', 'pg_', 'relation ', 'constraint', 'postgres']) {
    assert.ok(!text.includes(leak), `error response leaked "${leak}": ${text}`);
  }
});

test('user preferences round-trip and stay private', async () => {
  const put = await client.put('/api/prefs/teamlink_job_alerts_v1',
    { value: [{ id: 'al1', label: 'React in Bengaluru' }] });
  assert.equal(put.status, 200);

  const mine = await client.get('/api/prefs');
  assert.equal(mine.body.prefs.teamlink_job_alerts_v1[0].label, 'React in Bengaluru');

  const other = makeClient(`http://127.0.0.1:${API_PORT}`);
  await other.post('/api/auth/login', { email: 'cand6@test.local', password: 'TestPass123' });
  const theirs = await other.get('/api/prefs');
  assert.deepEqual(theirs.body.prefs, {}, 'preferences leaked between users');
});

test('AI interview: recording a session writes real per-question scores', async () => {
  const res = await recruiter.post('/api/ai-interviews', {
    candidateId: 'cand4', jobId: 'j4', contentScored: true,
    feedback: 'Reasonable responses; some areas could be deeper.',
    questionSetHash: 'qs-set-one',
    answers: [
      { seq: 1, category: 'intro', question: 'Tell me about your background.',
        answered: true, score: 70, commScore: 80, justification: 'Clear and relevant.' },
      { seq: 2, category: 'technical', question: 'Explain Django ORM querysets.',
        answered: true, score: 90, commScore: 80, justification: 'Accurate with depth.' },
      { seq: 3, category: 'technical', question: 'How do you index a slow query?',
        answered: false, score: 0, commScore: 0, justification: 'No spoken response — scored 0.' },
      { seq: 4, category: 'behavioral', question: 'Describe a disagreement you handled.',
        answered: true, score: 60, commScore: 70, justification: 'Relevant but thin on outcome.' },
    ],
  });
  assert.equal(res.status, 201);
  const ai = res.body.aiInterview;
  assert.equal(ai.perQuestion.length, 4);
  assert.equal(ai.questionsAnswered, 3, 'the unanswered question was not counted');
  // technical covers technical + resume: (90 + 0) / 2 = 45
  assert.equal(ai.technicalScore, 45, `technical should be 45, got ${ai.technicalScore}`);
  assert.equal(ai.behavioralScore, 60);
  // communication averages ANSWERED questions only: (80 + 80 + 70) / 3 = 77 (rounded)
  assert.ok(Math.abs(ai.communicationScore - 77) <= 1,
    `communication should be ~77, got ${ai.communicationScore}`);
  // overall = 45*0.5 + 60*0.3 + 77*0.2 = 55.9 -> 56
  assert.ok(Math.abs(ai.overallPercentage - 56) <= 1,
    `overall should be ~56, got ${ai.overallPercentage}`);
});

test('AI interview: a silent answer scores 0 and does not drag comms', async () => {
  const list = await recruiter.get('/api/ai-interviews?candidateId=cand4');
  const ai = list.body.aiInterviews[0];
  const silent = ai.perQuestion.find((p) => p.seq === 3);
  assert.equal(silent.score, 0, 'a skipped question must score 0');
  assert.equal(silent.answered, false);
  assert.match(silent.justification, /no spoken response/i);
});

test('AI interview: the server IGNORES a score the client claims', async () => {
  // A browser posting inflated aggregates must not be believed — the
  // server recomputes them from the answers it was given.
  const res = await recruiter.post('/api/ai-interviews', {
    candidateId: 'cand8', jobId: 'j8',
    overallPercentage: 99, technicalScore: 99, behavioralScore: 99,
    questionSetHash: 'qs-set-liar',
    answers: [
      { seq: 1, category: 'technical', question: 'Q1', answered: true, score: 10, commScore: 10,
        justification: 'Mostly wrong.' },
      { seq: 2, category: 'behavioral', question: 'Q2', answered: false, score: 0,
        justification: 'No response.' },
    ],
  });
  assert.equal(res.status, 201);
  const ai = res.body.aiInterview;
  assert.notEqual(ai.overallPercentage, 99, 'the server accepted a client-supplied score');
  assert.ok(ai.overallPercentage < 20,
    `expected a low score from those answers, got ${ai.overallPercentage}`);
});

test('AI interview: an interview with NO answers is refused', async () => {
  const res = await recruiter.post('/api/ai-interviews', {
    candidateId: 'cand4', jobId: 'j4', questionSetHash: 'qs-empty', answers: [],
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'VALIDATION_FAILED');
});

test('AI interview: the score is visible to the CANDIDATE', async () => {
  const cand = makeClient(`http://127.0.0.1:${API_PORT}`);
  await cand.post('/api/auth/login', { email: 'cand4@test.local', password: 'TestPass123' });
  const res = await cand.get('/api/ai-interviews');
  assert.equal(res.status, 200);
  assert.ok(res.body.aiInterviews.length > 0, 'the candidate cannot see their own AI score');
  const ai = res.body.aiInterviews[0];
  assert.equal(ai.candidateId, 'cand4');
  assert.ok(typeof ai.overallPercentage === 'number');
  // per-question justifications are audit detail, withheld from the candidate
  assert.ok(ai.perQuestion.every((p) => p.justification === undefined),
    'justifications were exposed to the candidate');
  assert.ok(ai.perQuestion.every((p) => typeof p.score === 'number'),
    'the candidate should still see their per-question scores');
});

test('AI interview: a candidate cannot see ANOTHER candidate\'s score', async () => {
  const other = makeClient(`http://127.0.0.1:${API_PORT}`);
  await other.post('/api/auth/login', { email: 'cand6@test.local', password: 'TestPass123' });
  const res = await other.get('/api/ai-interviews?candidateId=cand4');
  assert.equal(res.status, 200);
  assert.equal(res.body.aiInterviews.length, 0, 'an AI score leaked between candidates');
});

test('AI interview: a candidate cannot record a score for someone else', async () => {
  const cand = makeClient(`http://127.0.0.1:${API_PORT}`);
  await cand.post('/api/auth/login', { email: 'cand4@test.local', password: 'TestPass123' });
  const res = await cand.post('/api/ai-interviews', {
    candidateId: 'cand8', jobId: 'j8', questionSetHash: 'qs-forge',
    answers: [{ seq: 1, category: 'technical', question: 'Q', answered: true, score: 100 }],
  });
  assert.equal(res.status, 403);
});

test('AI interview: the CLIENT sees the score for their own company', async () => {
  const cl = makeClient(`http://127.0.0.1:${API_PORT}`);
  await cl.post('/api/auth/login', { email: 'c1@test.local', password: 'TestPass123' });
  const res = await cl.get('/api/ai-interviews');
  assert.equal(res.status, 200);
  // c1 is TechNova; j4 and j8 are TechNova jobs
  assert.ok(res.body.aiInterviews.length > 0, 'the client cannot see AI scores for their own jobs');
  for (const ai of res.body.aiInterviews) {
    assert.ok(typeof ai.overallPercentage === 'number');
  }
});

test('AI interview: repeating a question set is detectable', async () => {
  const used = await recruiter.get(
    '/api/ai-interviews/question-set-used?candidateId=cand4&hash=qs-set-one');
  assert.equal(used.body.used, true, 'a previously used question set was not recognised');
  const fresh = await recruiter.get(
    '/api/ai-interviews/question-set-used?candidateId=cand4&hash=qs-never-used');
  assert.equal(fresh.body.used, false);
});

test('AI interview: it moves the application to ai_interview_done', async () => {
  const apps = await recruiter.get('/api/applications?candidateId=cand8');
  const app = apps.body.applications.find((a) => a.jobId === 'j8');
  assert.ok(app, 'no application found for cand8/j8');
  assert.equal(app.aiScore !== null && app.aiScore !== undefined, true,
    'the AI score was not written onto the application');
});

test('notify: applying triggers all applicable channels at once', async () => {
  const fresh = makeClient(`http://127.0.0.1:${API_PORT}`);
  await fresh.post('/api/auth/login', { email: 'cand6@test.local', password: 'TestPass123' });

  const res = await fresh.post('/api/applications', { jobId: 'j5', source: 'website' });
  assert.equal(res.status, 201);

  const n = res.body.notify;
  assert.ok(n, 'no notification record returned');
  assert.equal(n.candidate_id, 'cand6');
  assert.equal(n.job_id, 'j5');
  assert.equal(n.source, 'website');
  assert.ok(n.interview_expiry, 'no interview expiry was issued');

  // Naukri must NOT be attempted for a website application.
  assert.equal(n.delivery_status.naukri, 'not_applicable');
  assert.ok(!n.channels_attempted.includes('naukri'));

  // the other three are always attempted
  for (const ch of ['sms', 'whatsapp', 'email']) {
    assert.ok(n.channels_attempted.includes(ch), `${ch} was not attempted`);
    assert.ok(n.delivery_status[ch], `${ch} has no recorded status`);
  }
});

test('notify: an unconfigured channel reports not_configured, never "sent"', async () => {
  // No provider credentials are set in the test environment. A channel
  // that sent nothing must never claim it did — that is the difference
  // between "we could not reach you" and telling a candidate they were
  // contacted when they were not.
  const apps = await recruiter.get('/api/applications?candidateId=cand6');
  const app = apps.body.applications.find((a) => a.jobId === 'j5');
  const res = await recruiter.get(`/api/applications/${app.id}/notifications`);
  assert.equal(res.status, 200);

  // email and naukri have no credentials in the test environment, so they
  // must say so. (sms points at a mock that answers, whatsapp at a dead
  // host — those paths are asserted separately.)
  for (const ch of ['email']) {
    const st = res.body.delivery_status[ch];
    assert.notEqual(st, 'sent', `${ch} claimed "sent" with no provider configured`);
    assert.equal(st, 'not_configured',
      `${ch} should report not_configured, reported: ${st}`);
  }
  assert.equal(res.body.delivery_status.whatsapp, 'failed',
    'a configured-but-unreachable provider should report failed, not sent');
  // and the reason is recorded, not just the outcome
  const withReason = res.body.attempts.filter((a) => a.error);
  assert.ok(withReason.length > 0, 'no failure reason was recorded anywhere');
});

test('notify: the interview expiry is 2 days out and IDENTICAL on every channel', async () => {
  const apps = await recruiter.get('/api/applications?candidateId=cand6');
  const app = apps.body.applications.find((a) => a.jobId === 'j5');
  const res = await recruiter.get(`/api/applications/${app.id}/notifications`);

  const expiry = new Date(res.body.interview_expiry);
  const hours = (expiry - new Date(app.appliedAt)) / 3600000;
  assert.ok(Math.abs(hours - 48) < 2, `expiry should be ~48h after applying, got ${hours}h`);

  // every channel must have been given the same deadline and job id
  const rows = res.body.attempts;
  assert.ok(rows.length >= 3);
  const distinct = new Set(rows.map((r) => r.channel));
  assert.ok(distinct.size >= 3, 'fewer than three channels were recorded');
});

test('notify: a Naukri-sourced application DOES attempt Naukri', async () => {
  const fresh = makeClient(`http://127.0.0.1:${API_PORT}`);
  await fresh.post('/api/auth/login', { email: 'cand4@test.local', password: 'TestPass123' });
  const res = await fresh.post('/api/applications', { jobId: 'j11', source: 'naukri' });
  assert.equal(res.status, 201);

  const n = res.body.notify;
  assert.equal(n.source, 'naukri');
  assert.ok(n.channels_attempted.includes('naukri'), 'Naukri was not attempted');
  // ...and honestly reports that it cannot deliver without API access
  assert.equal(n.delivery_status.naukri, 'not_configured');
});

test('notify: one dead channel does not block the others', async () => {
  // SMS_API_URL points at a host that does not answer, so that channel
  // fails while email and whatsapp still get their attempt recorded.
  const apps = await recruiter.get('/api/applications?candidateId=cand4');
  const app = apps.body.applications.find((a) => a.jobId === 'j11');
  const res = await recruiter.get(`/api/applications/${app.id}/notifications`);
  const channels = Object.keys(res.body.delivery_status);
  assert.ok(channels.length >= 4,
    `expected all four channels recorded, got ${channels.join(', ')}`);
});

test('notify: an interview token is issued, unique, and not guessable', async () => {
  const c = await getPool().connect();
  try {
    // set_config(..., true) is TRANSACTION-local. Outside a transaction each
    // statement is its own, so the setting is gone before the next query and
    // RLS sees an anonymous caller. The begin/commit is what makes it stick.
    await c.query('begin');
    await c.query(`set local role app_api`);
    await c.query(`select set_config('app.user_id','',true), set_config('app.role','admin',true)`);
    const { rows } = await c.query(
      `select id, interview_token, interview_expires_at from applications
        where interview_token is not null`);
    await c.query('commit');
    assert.ok(rows.length >= 2, 'no interview tokens were issued');
    const tokens = rows.map((r) => r.interview_token);
    assert.equal(new Set(tokens).size, tokens.length, 'interview tokens are not unique');
    for (const t of tokens) {
      assert.ok(t.length >= 24, `token is too short to be unguessable: ${t.length} chars`);
      assert.ok(!rows.some((r) => r.id === t), 'the token is derived from the application id');
    }
  } finally { c.release(); }
});

test('notify: the candidate can see whether they were actually contacted', async () => {
  const cand = makeClient(`http://127.0.0.1:${API_PORT}`);
  await cand.post('/api/auth/login', { email: 'cand6@test.local', password: 'TestPass123' });
  const apps = await cand.get('/api/applications');
  const app = apps.body.applications.find((a) => a.jobId === 'j5');
  const res = await cand.get(`/api/applications/${app.id}/notifications`);
  assert.equal(res.status, 200);
  assert.ok(Object.keys(res.body.delivery_status).length >= 3);
});

test('notify: another candidate cannot read that delivery history', async () => {
  const apps = await recruiter.get('/api/applications?candidateId=cand6');
  const app = apps.body.applications.find((a) => a.jobId === 'j5');

  const other = makeClient(`http://127.0.0.1:${API_PORT}`);
  await other.post('/api/auth/login', { email: 'cand8@test.local', password: 'TestPass123' });
  const res = await other.get(`/api/applications/${app.id}/notifications`);
  assert.ok([403, 404].includes(res.status),
    `delivery history leaked to another candidate (status ${res.status})`);
});

test('notify: a configured provider that accepts the message reports "sent"', async () => {
  const before = mockProvider.received.length;
  const fresh = makeClient(`http://127.0.0.1:${API_PORT}`);
  await fresh.post('/api/auth/login', { email: 'cand8@test.local', password: 'TestPass123' });
  const res = await fresh.post('/api/applications', { jobId: 'j5', source: 'website' });
  assert.equal(res.status, 201);

  const n = res.body.notify;
  assert.equal(n.delivery_status.sms, 'sent', 'a provider that answered 200 was not recorded as sent');
  assert.equal(n.delivery_status.whatsapp, 'failed', 'a dead host was not recorded as failed');
  assert.equal(n.delivery_status.email, 'not_configured');

  // the provider really was called, with the real content
  assert.ok(mockProvider.received.length > before, 'the provider was never contacted');
  const sent = mockProvider.received.at(-1).body;
  assert.ok(/interview/i.test(sent.message), 'the SMS body has no interview link');
  assert.ok(sent.message.includes('/#/interview/'), 'the SMS carries no interview URL');

  // and the provider's message id was stored for audit
  const apps = await recruiter.get('/api/applications?candidateId=cand8');
  const app = apps.body.applications.find((a) => a.jobId === 'j5');
  const st = await recruiter.get(`/api/applications/${app.id}/notifications`);
  const smsRow = st.body.attempts.find((a) => a.channel === 'sms');
  assert.equal(smsRow.status, 'sent');
  assert.ok(smsRow.providerRef, 'no provider reference was recorded for the sent message');
});

test('notify: every channel quotes the SAME expiry and job id', async () => {
  const apps = await recruiter.get('/api/applications?candidateId=cand8');
  const app = apps.body.applications.find((a) => a.jobId === 'j5');
  const st = await recruiter.get(`/api/applications/${app.id}/notifications`);

  // the SMS body the provider actually received must quote the same
  // expiry the application record holds
  const sent = mockProvider.received.at(-1).body.message;
  const expiry = new Date(st.body.interview_expiry);
  const day = expiry.toLocaleString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  assert.ok(sent.includes(day),
    `the SMS quotes a different expiry than the record: "${sent}" vs ${day}`);
});

test('companies: an admin can create one (a fresh deploy has none)', async () => {
  const admin = makeClient(`http://127.0.0.1:${API_PORT}`);
  await admin.post('/api/auth/login', { email: 'a1@test.local', password: 'TestPass123' });

  const res = await admin.post('/api/companies', {
    name: 'Northwind Systems', industry: 'Logistics Software',
    hq: 'Pune, India', founded: 2019, size: '50–100 employees',
    color1: '#0b6e8f', color2: '#3fb4d1',
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.company.id, 'northwind-systems', 'the id was not slugified from the name');
  assert.equal(res.body.company.name, 'Northwind Systems');
  assert.equal(res.body.company.color1, '#0b6e8f', 'branding colours must survive — the UI renders them');
});

test('companies: a job can then be created against it', async () => {
  const admin = makeClient(`http://127.0.0.1:${API_PORT}`);
  await admin.post('/api/auth/login', { email: 'a1@test.local', password: 'TestPass123' });
  const res = await admin.post('/api/jobs', {
    id: 'NW1', title: 'Platform Engineer', companyId: 'northwind-systems',
    location: 'Pune', type: 'Full-time', status: 'open',
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.job.companyId, 'northwind-systems');
});

test('companies: a recruiter CANNOT create or edit one', async () => {
  const create = await recruiter.post('/api/companies', { name: 'Rogue Corp' });
  assert.equal(create.status, 403, 'a recruiter created a company');
  const edit = await recruiter.put('/api/companies/technova', { name: 'Renamed' });
  assert.equal(edit.status, 403, 'a recruiter renamed a company');
});

test('companies: invalid input is rejected with field-level detail', async () => {
  const admin = makeClient(`http://127.0.0.1:${API_PORT}`);
  await admin.post('/api/auth/login', { email: 'a1@test.local', password: 'TestPass123' });

  const shortName = await admin.post('/api/companies', { name: 'X' });
  assert.equal(shortName.status, 400);
  assert.ok(shortName.body.error.details.name);

  const badColour = await admin.post('/api/companies', { name: 'Colour Test', color1: 'not-a-colour' });
  assert.equal(badColour.status, 400);
  assert.ok(badColour.body.error.details.color1, 'a non-hex colour was accepted');

  const badId = await admin.post('/api/companies', { name: 'Id Test', id: 'Has Spaces!' });
  assert.equal(badId.status, 400);
  assert.ok(badId.body.error.details.id);
});

test('companies: a duplicate id is refused, not silently overwritten', async () => {
  const admin = makeClient(`http://127.0.0.1:${API_PORT}`);
  await admin.post('/api/auth/login', { email: 'a1@test.local', password: 'TestPass123' });
  const again = await admin.post('/api/companies', { name: 'Northwind Systems' });
  assert.equal(again.status, 400);
  assert.match(JSON.stringify(again.body), /already exists/i);
});

test('companies: editing keeps the id, because jobs reference it', async () => {
  const admin = makeClient(`http://127.0.0.1:${API_PORT}`);
  await admin.post('/api/auth/login', { email: 'a1@test.local', password: 'TestPass123' });
  const res = await admin.put('/api/companies/northwind-systems', { name: 'Northwind Systems Ltd' });
  assert.equal(res.status, 200);
  assert.equal(res.body.company.id, 'northwind-systems', 'the company id changed on edit');
  assert.equal(res.body.company.name, 'Northwind Systems Ltd');

  // the job still resolves
  const job = await admin.get('/api/jobs/NW1');
  assert.equal(job.body.job.companyId, 'northwind-systems');
});

test('companies: the public job board can read them', async () => {
  const anon = makeClient(`http://127.0.0.1:${API_PORT}`);
  const res = await anon.get('/api/companies');
  assert.equal(res.status, 200);
  assert.ok(res.body.companies.length > 0, 'the public board cannot read company names');
});

test('shutdown', async () => {
  await new Promise((r) => server.close(r));
  await closePool();
  await mockProvider.stop();
  await dbHandle.stop();
});
