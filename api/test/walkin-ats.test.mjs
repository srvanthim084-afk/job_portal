/**
 * The walk-in ATS (0107) - owner's Section 23, end to end against a real
 * Postgres with RLS on. Each acceptance test of 23.20 that the API can
 * prove is a `test()` named "23.20 #N ...". Nothing leaves the machine:
 * email and SMS go to the mock provider, WhatsApp is not configured.
 *
 * Walk-in jobs and applications are created through the API directly
 * (POST /api/jobs with postingKind 'walkin', POST /api/applications), the
 * columns of the shared 0106/0107 contract (address, capacity, map link)
 * by SQL - the job form that writes them is built in parallel (W1).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb, applyTestEnv, makeClient, startMockProvider } from './harness.mjs';

const DB_PORT = Number(process.env.WALKIN_ATS_TEST_DB_PORT) || 5463;
const API_PORT = Number(process.env.WALKIN_ATS_TEST_API_PORT) || 9983;
const MOCK_PORT = Number(process.env.WALKIN_ATS_TEST_MOCK_PORT) || 9862;
const IST = 330 * 60000;

let dbh, server, mock, base, raw, ats;

const istDay = (plus = 0, from = Date.now()) => new Date(from + IST + plus * 86400000).toISOString().slice(0, 10);
const at = (date, hh, mm = 0) => {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d, hh, mm) - IST;
};
const hhmm = (ms) => new Date(ms + IST).toISOString().slice(11, 16);
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n')]);

async function candidate(name, email, phone, extra = {}) {
  const c = makeClient(base);
  await c.get('/api/health');
  const r = await c.post('/api/auth/register', {
    name, email, password: 'Walkin123ats', phone,
    preferredLocation: 'Hyderabad', expectedCtc: 4, noticePeriod: 'Immediate',
    preferredWorkModes: ['Work From Office'], ...extra,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  c.id = r.body.candidateId;
  c.name = name; c.email = email; c.phone = phone;
  return c;
}

async function staff(id, email, role = 'recruiter', company = 'co_a') {
  const { hashPassword } = await import('../src/auth.js');
  const hash = await hashPassword('Staff123pass');
  const u = await raw(`insert into users (email, password_hash, role) values ($1,$2,$3) returning id`, [email, hash, role]);
  if (role === 'recruiter') {
    await raw(`insert into recruiters (id, user_id, name, email, company_id) values ($1,$2,$3,$4,$5)`,
      [id, u.rows[0].id, `Recruiter ${id}`, email, company]);
  } else {
    await raw(`insert into admins (id, user_id, name, email) values ($1,$2,$3,$4)`, [id, u.rows[0].id, `Admin ${id}`, email]);
  }
  const c = makeClient(base);
  await c.get('/api/health');
  const r = await c.post('/api/auth/login', { email, password: 'Staff123pass' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  c.userId = u.rows[0].id;
  return c;
}

async function job(client, over = {}, extra = {}) {
  const r = await client.post('/api/jobs', {
    title: 'Customer Support Executive', companyId: over.companyId || 'co_a', location: 'Hyderabad',
    mode: 'Onsite', exp: '0-2 yrs', pay: '₹3 LPA', type: 'Full-time', status: 'open',
    skills: ['Communication'], desc: 'Verification job.', ...over,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const id = r.body.job.id;
  const q = await client.put(`/api/jobs/${id}/screening-questions`, { questions: [] });
  assert.equal(q.status, 200, JSON.stringify(q.body));
  const sets = Object.entries(extra);
  if (sets.length) {
    await raw(`update jobs set ${sets.map(([k], i) => `${k}=$${i + 2}`).join(', ')} where id=$1`, [id, ...sets.map(([, v]) => v)]);
    // setting the 0106 columns here is setup, not a recruiter's edit
    await raw(`delete from walkin_reschedules where job_id=$1`, [id]);
    await raw(`delete from job_update_history where job_id=$1`, [id]);
  }
  return id;
}

const walkinJob = (client, { date, from = '10:00', to = '16:00', title = 'Walk-in: Support Executive', venue = 'Hotel Grand', companyId } = {}, extra = {}) =>
  job(client, {
    title, postingKind: 'walkin', type: 'Walk-in', walkinDate: date, walkinFrom: from, walkinTo: to,
    walkinVenue: venue, walkinAddress: '12 Trunk Road, Ameerpet', walkinContact: 'Ravi', walkinPhone: '9000011111', ...(companyId ? { companyId } : {}),
  }, { walkin_address: '12 Trunk Road, Ameerpet', walkin_map_link: 'https://maps.google.com/?q=Hotel+Grand', ...extra });

async function apply(cand, jobId) {
  const r = await cand.post('/api/applications', { jobId });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.application;
}

const history = async (appId) => (await raw(
  `select from_stage, to_stage, source, reason, is_override, action, changed_by from application_stage_history
    where application_id=$1 order by id`, [appId])).rows;

test('boot', async () => {
  dbh = await startTestDb(DB_PORT);
  mock = await startMockProvider(MOCK_PORT);
  applyTestEnv(dbh.url, {
    PUBLIC_ORIGIN: `http://127.0.0.1:${API_PORT}`,
    DISABLE_BACKGROUND_WORK: 'true',
    SMS_API_URL: `http://127.0.0.1:${MOCK_PORT}/sms`,
    EMAIL_API_KEY: 'test-key',
    EMAIL_FROM: 'ats@teamlink.example',
    EMAIL_API_URL: `http://127.0.0.1:${MOCK_PORT}/email`,
    EMAIL_SMTP_HOST: '', EMAIL_SMTP_USER: '', EMAIL_SMTP_PASS: '',
    EMAILJS_SERVICE_ID: '', EMAILJS_TEMPLATE_ID: '', EMAILJS_PUBLIC_KEY: '', EMAILJS_PRIVATE_KEY: '',
    OUTBOUND_ALLOWLIST: '',
    AI_API_KEY: '',
    WALKIN_NO_SHOW_GRACE_MINUTES: '60',
    WALKIN_RESCHEDULE_MERGE_MS: '120000',
  });
  raw = (sql, params) => dbh.db.query(sql, params);
  await raw(`insert into companies (id, name) values ('co_a', 'Alpha Services Pvt Ltd'), ('co_b', 'Beta Retail Pvt Ltd')`);
  const { createApp } = await import('../src/app.js');
  ats = await import('../src/notify/walkin-ats.js');
  const app = createApp({ logger: { error() {}, log() {} } });
  await new Promise((r) => { server = app.listen(API_PORT, r); });
  base = `http://127.0.0.1:${API_PORT}`;
});

let RA, RB, ADMIN, C1, C2, C3, C4;
let REG, WALK, WALKB, LATER;          // job ids
let aReg, aW1, aW2, aW3, aW4;         // applications

test('setup: two recruiters, an admin, candidates, a regular and a walk-in job', async () => {
  RA = await staff('ra', 'ra@tl-sink.local', 'recruiter', 'co_a');
  RB = await staff('rb', 'rb@tl-sink.local', 'recruiter', 'co_b');
  ADMIN = await staff('adm', 'adm@tl-sink.local', 'admin');
  C1 = await candidate('Asha Rao', 'asha.ats@tl-sink.local', '9000000201');
  C2 = await candidate('Bala Krishna', 'bala.ats@tl-sink.local', '9000000202');
  C3 = await candidate('Chitra Devi', 'chitra.ats@tl-sink.local', '9000000203');
  C4 = await candidate('Dinesh Kumar', 'dinesh.ats@tl-sink.local', '9000000204');

  REG = await job(RA, { title: 'Regular Accounts Assistant' });
  // today, check-in window open now (1 h before start .. end)
  const now = Date.now();
  const from = hhmm(now - 30 * 60000) > hhmm(now) ? '00:00' : hhmm(now - 30 * 60000);
  const to = hhmm(now + 3 * 3600000) < hhmm(now) ? '23:59' : hhmm(now + 3 * 3600000);
  WALK = await walkinJob(RA, { date: istDay(0), from, to }, { walkin_capacity: 4 });
  WALKB = await walkinJob(RB, { date: istDay(2), title: 'Walk-in: Store Staff', companyId: 'co_b' });
  LATER = await walkinJob(RA, { date: istDay(3), title: 'Walk-in: Telecaller' });
});

test('23.20 #1 a regular application appears at once in the job\'s applicant list with every 23.3 field', async () => {
  await raw(`update candidates set location='Hyderabad', education='B.Com', exp='1 yr', ctc='2.4 LPA', notice_period='15 days' where id=$1`, [C1.id]);
  await raw(`insert into candidate_education (candidate_id, qualification, specialization) values ($1,'B.Com','Accounts')`, [C1.id]);
  aReg = await apply(C1, REG);
  assert.equal(aReg.stage, 'applied', 'a regular job keeps its existing initial stage');
  const r = await RA.get(`/api/jobs/${REG}/applicants`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.total, 1);
  const a = r.body.applicants[0];
  for (const k of ['applicationId', 'candidateId', 'candidateName', 'mobile', 'email', 'currentLocation', 'preferredLocation',
    'qualification', 'specialization', 'experience', 'currentSalary', 'expectedSalary', 'noticePeriod', 'hasResume',
    'jobId', 'jobTitle', 'jobType', 'applicationDate', 'stage', 'status', 'rating']) {
    assert.ok(k in a, `missing ${k}`);
  }
  assert.equal(a.candidateName, 'Asha Rao');
  assert.equal(a.mobile, '9000000201');
  assert.equal(a.qualification, 'B.Com');
  assert.equal(a.specialization, 'Accounts');
  assert.equal(a.preferredLocation, 'Hyderabad');
  assert.equal(a.jobType, 'Regular');
  assert.equal(a.status, 'Active');
  assert.match(a.reference, /^TL-APP-\d{4}-\d{5}$/, 'the existing Application ID scheme');
  assert.equal(r.body.job.regularTiles.new, 1);
});

test('23.20 #2 a walk-in application appears at once with stage Registered (set by the database)', async () => {
  aW1 = await apply(C1, WALK);
  aW2 = await apply(C2, WALK);
  aW3 = await apply(C3, WALK);
  assert.equal(aW1.stage, 'registered');
  const r = await RA.get(`/api/jobs/${WALK}/applicants`);
  assert.equal(r.body.total, 3);
  assert.ok(r.body.applicants.every((a) => a.stage === 'registered' && a.jobType === 'Walk-in' && a.source === 'Walk-in'));
  // whoever inserts it: a recruiter adding somebody gets Registered too
  const viaRecruiter = await RA.post('/api/applications', { jobId: LATER, candidateId: C4.id });
  assert.equal(viaRecruiter.status, 201, JSON.stringify(viaRecruiter.body));
  assert.equal(viaRecruiter.body.application.stage, 'registered');
  aW4 = viaRecruiter.body.application;
  const h = await history(aW1.id);
  assert.equal(h[0].action, 'applied');
  assert.equal(h[0].to_stage, 'registered');
  assert.equal(h[0].source, 'candidate');
});

test('23.20 #3 recruiter B cannot open recruiter A\'s applicants, details, notes, ratings, exports or history - by direct ID', async () => {
  assert.equal((await RB.get(`/api/jobs/${WALK}/applicants`)).status, 404);
  assert.equal((await RB.get(`/api/jobs/${WALK}/ats-summary`)).status, 404);
  assert.equal((await RB.get(`/api/ats/applications/${aW1.id}`)).status, 404);
  assert.equal((await RB.get(`/api/ats/applications/${aW1.id}/notes`)).status, 404);
  assert.equal((await RB.post(`/api/ats/applications/${aW1.id}/notes`, { note: 'sneaky' })).status, 404);
  assert.equal((await RB.put(`/api/ats/applications/${aW1.id}/rating`, { rating: 1 })).status, 404);
  assert.equal((await RB.post(`/api/ats/applications/${aW1.id}/stage`, { stage: 'attended' })).status, 404);
  assert.equal((await RB.post(`/api/ats/applications/${aW1.id}/check-in`, { action: 'both' })).status, 404);
  assert.equal((await RB.post(`/api/jobs/${WALK}/applicants/export`, { format: 'csv' })).status, 404);
  assert.equal((await RB.get(`/api/jobs/${WALK}/update-history`)).status, 404);
  assert.equal((await RB.get(`/api/jobs/${WALK}/check-in?q=Asha`)).status, 404);
  const list = await RB.get(`/api/ats/applicants?q=Asha`);
  assert.equal(list.body.total, 0, 'the cross-job list never shows another recruiter\'s applicants');
  const bulk = await RB.post('/api/ats/applications/bulk-stage', { items: [{ id: aW1.id }], stage: 'attended' });
  assert.equal(bulk.body.updated.length, 0);
  assert.equal(bulk.body.skipped[0].name, null, 'not even the name of somebody else\'s applicant');
  assert.equal((await raw(`select stage from applications where id=$1`, [aW1.id])).rows[0].stage, 'registered');
  // a candidate gets nothing from the staff routes
  assert.equal((await C1.get(`/api/jobs/${WALK}/applicants`)).status, 403);
  assert.equal((await C1.get(`/api/ats/applications/${aW1.id}`)).status, 403);
});

test('23.20 #4 resume: logged out / other candidate / other recruiter refused; candidate owner and recruiter A served; every access logged', async () => {
  const fd = new FormData();
  fd.append('resume', new Blob([PDF], { type: 'application/pdf' }), 'Asha_Rao_CV.pdf');
  const up = await C1.post('/api/uploads/resume', fd);
  assert.equal(up.status, 201, JSON.stringify(up.body));
  const path = `/api/ats/applications/${aW1.id}/resume`;

  const anon = makeClient(base);
  await anon.get('/api/health');
  assert.equal((await anon.get(path)).status, 401);
  assert.equal((await C2.get(path)).status, 404);
  assert.equal((await RB.get(path)).status, 404);

  const mine = await C1.get(path);
  assert.equal(mine.status, 200);
  assert.match(mine.headers.get('content-type'), /application\/pdf/);
  const ra = await RA.get(path + '?download=1');
  assert.equal(ra.status, 200);
  assert.match(ra.headers.get('content-disposition'), /^attachment/);
  assert.match(ra.headers.get('cache-control'), /no-store/);
  const adm = await ADMIN.get(path);
  assert.equal(adm.status, 200);

  const log = (await raw(`select action, actor_role from resume_access_log where application_id=$1 order by id`, [aW1.id])).rows;
  assert.deepEqual(log.map((x) => `${x.actor_role}:${x.action}`), ['candidate:view', 'recruiter:download', 'admin:view']);
  // refused attempts leave nothing behind
  assert.equal(log.length, 3);
  // the profile resume route (shared candidates, 0091) is logged too
  const link = await RA.get(`/api/candidates/${C1.id}/resume`);
  assert.equal(link.status, 200, JSON.stringify(link.body));
  assert.equal((await RA.get(link.body.url)).status, 200);
  assert.equal((await anon.get(link.body.url)).status, 401, 'the "signed" link alone is not enough');
  const prof = (await raw(`select actor_role, action, application_id from resume_access_log order by id desc limit 1`)).rows[0];
  assert.deepEqual([prof.actor_role, prof.action, prof.application_id], ['recruiter', 'download', null]);
});

test('23.20 #5 search by name, email, mobile, Candidate ID and Application ID', async () => {
  const s = async (q) => (await RA.get(`/api/jobs/${WALK}/applicants?q=${encodeURIComponent(q)}`)).body.applicants.map((a) => a.candidateName);
  assert.deepEqual(await s('chitra'), ['Chitra Devi']);
  assert.deepEqual(await s('bala.ats@'), ['Bala Krishna']);
  assert.deepEqual(await s('90000 00203'), ['Chitra Devi'], 'mobile, whatever the spacing');
  assert.deepEqual(await s(C2.id), ['Bala Krishna']);
  const ref = (await raw(`select reference from applications where id=$1`, [aW3.id])).rows[0].reference;
  assert.deepEqual(await s(ref), ['Chitra Devi']);
  assert.deepEqual(await s(aW1.id), ['Asha Rao']);
});

test('23.20 #6 filters: Job Type, Stage, Status, Date Applied (server side)', async () => {
  const all = (q) => RA.get(`/api/ats/applicants?${q}`).then((r) => r.body);
  assert.equal((await all('jobType=walkin')).total, 4);
  assert.equal((await all('jobType=regular')).total, 1);
  assert.equal((await all('stage=registered')).total, 4);
  assert.equal((await all('status=Active')).total, 5);
  assert.equal((await all('status=Closed')).total, 0);
  assert.equal((await all(`from=${istDay(0)}&to=${istDay(0)}`)).total, 5);
  assert.equal((await all(`from=${istDay(1)}`)).total, 0);
  assert.equal((await all(`jobId=${WALK}&stage=registered&q=asha`)).total, 1);
});

test('23.20 #8 an invalid walk-in transition is rejected with a clear message (both endpoints)', async () => {
  const r = await RA.post(`/api/ats/applications/${aW1.id}/stage`, { stage: 'selected' });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'INVALID_TRANSITION');
  assert.match(r.body.error.message, /cannot move from Registered to Selected.*Attended, .*No Show/);
  const old = await RA.put(`/api/applications/${aW1.id}/status`, { stage: 'selected' });
  assert.equal(old.status, 409, 'the existing status route enforces it too');
  const reg = await RA.put(`/api/applications/${aW1.id}/status`, { stage: 'shortlisted' });
  assert.equal(reg.status, 400);
  assert.equal(reg.body.error.code, 'STAGE_NOT_FOR_JOB_TYPE');
  const wrongKind = await RA.post(`/api/ats/applications/${aReg.id}/stage`, { stage: 'attended' });
  assert.equal(wrongKind.status, 400, 'walk-in stages are refused on a regular job');
  assert.equal((await raw(`select stage from applications where id=$1`, [aW1.id])).rows[0].stage, 'registered');
});

test('regular jobs keep their free movement and candidate notifications exactly as before', async () => {
  for (const st of ['interview_scheduled', 'shortlisted', 'client_review']) {
    const r = await RA.put(`/api/applications/${aReg.id}/status`, { stage: st });
    assert.equal(r.status, 200, `${st}: ${JSON.stringify(r.body)}`);
  }
  const n = (await raw(`select count(*)::int n from notifications where application_id=$1 and type='APPLICATION_STATUS'`, [aReg.id])).rows[0].n;
  assert.ok(n >= 1, 'the candidate is still told about a regular move');
});

test('23.20 #9 single and bulk updates; bulk skips invalid ones, says "N updated, M skipped", one audit row each', async () => {
  const one = await RA.post(`/api/ats/applications/${aW1.id}/stage`, { stage: 'attended', expectedVersion: 1 });
  assert.equal(one.status, 200, JSON.stringify(one.body));
  assert.equal(one.body.result.stage, 'attended');
  assert.equal(one.body.result.version, 2);
  const row = (await raw(`select attended_at, attended_by, updated_by, version, application_status from applications where id=$1`, [aW1.id])).rows[0];
  assert.ok(row.attended_at && row.attended_by === RA.userId && row.updated_by === RA.userId);

  // aW1 attended -> interviewed fine; aW2 registered -> interviewed invalid
  const before = (await raw(`select count(*)::int n from application_stage_history`)).rows[0].n;
  const bulk = await RA.post('/api/ats/applications/bulk-stage', { items: [{ id: aW1.id }, { id: aW2.id }], stage: 'interviewed' });
  assert.equal(bulk.status, 200, JSON.stringify(bulk.body));
  assert.equal(bulk.body.summary, '1 updated, 1 skipped (invalid transition)');
  assert.equal(bulk.body.skipped[0].name, 'Bala Krishna');
  assert.match(bulk.body.skipped[0].reference, /^TL-APP-/);
  const after = (await raw(`select count(*)::int n from application_stage_history`)).rows[0].n;
  assert.equal(after - before, 1, 'one audit row for the one that moved, none for the skipped one');

  const C8 = await candidate('Hari Prasad', 'hari.ats@tl-sink.local', '9000000208');
  const C9 = await candidate('Indu Reddy', 'indu.ats@tl-sink.local', '9000000209');
  const b8 = await apply(C8, LATER);
  const b9 = await apply(C9, LATER);
  const bulk2 = await RA.post('/api/ats/applications/bulk-stage', { items: [{ id: b8.id, version: 1 }, { id: b9.id, version: 1 }], stage: 'attended' });
  assert.equal(bulk2.body.summary, '2 updated, 0 skipped');
  assert.equal((await raw(`select count(*)::int n from application_stage_history where action='stage' and to_stage='attended' and application_id = any($1)`, [[b8.id, b9.id]])).rows[0].n, 2);
  // a stale version in a bulk is skipped by name, not saved
  const stale = await RA.post('/api/ats/applications/bulk-stage', { items: [{ id: b8.id, version: 1 }], stage: 'interviewed' });
  assert.equal(stale.body.summary, '0 updated, 1 skipped (updated by someone else)');

  const tooMany = await RA.post('/api/ats/applications/bulk-stage', { items: Array.from({ length: 201 }, (_, i) => ({ id: 'x' + i })), stage: 'attended' });
  assert.equal(tooMany.status, 400);
});

test('23.20 #10 / #11 check-in by name, mobile, Candidate ID, Application ID; twice = no duplicate; outside the window needs a reason', async () => {
  const find = async (q) => (await RA.get(`/api/jobs/${WALK}/check-in?q=${encodeURIComponent(q)}`)).body.results.map((x) => x.candidateName);
  assert.deepEqual(await find('Bala'), ['Bala Krishna']);
  assert.deepEqual(await find('9000000203'), ['Chitra Devi']);
  assert.deepEqual(await find(C2.id), ['Bala Krishna']);
  const ref2 = (await raw(`select reference from applications where id=$1`, [aW2.id])).rows[0].reference;
  assert.deepEqual(await find(ref2), ['Bala Krishna']);

  const r1 = await RA.post(`/api/ats/applications/${aW2.id}/check-in`, { action: 'check_in' });
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.equal(r1.body.result.checkedIn, true);
  assert.equal(r1.body.result.stage, 'registered', 'Check In alone does not mark attendance');
  const again = await RA.post(`/api/ats/applications/${aW2.id}/check-in`, { action: 'check_in' });
  assert.equal(again.body.result.already, true, '"Already checked in"');
  assert.equal((await raw(`select count(*)::int n from application_stage_history where application_id=$1 and action='checked_in'`, [aW2.id])).rows[0].n, 1);

  // quick check-in with the Application ID from the confirmation / QR
  const ref3 = (await raw(`select reference from applications where id=$1`, [aW3.id])).rows[0].reference;
  const q = await RA.post(`/api/jobs/${WALK}/check-in/quick`, { code: ref3.toLowerCase(), action: 'both' });
  assert.equal(q.status, 200, JSON.stringify(q.body));
  assert.equal(q.body.result.stage, 'attended');
  const twice = await RA.post(`/api/jobs/${WALK}/check-in/quick`, { code: ref3, action: 'both' });
  assert.equal(twice.body.result.already, true);
  const row = (await raw(`select checked_in_at, checked_in_by, attended_at, attended_by from applications where id=$1`, [aW3.id])).rows[0];
  assert.ok(row.checked_in_at && row.checked_in_by === RA.userId && row.attended_at && row.attended_by === RA.userId);

  // outside the window (a drive in three days): refused without a reason, allowed and logged with one
  const out = await RA.post(`/api/ats/applications/${aW4.id}/check-in`, { action: 'check_in' });
  assert.equal(out.status, 409);
  assert.equal(out.body.error.code, 'OUTSIDE_DRIVE_WINDOW');
  assert.match(out.body.error.message, /1 hour before/);
  const ok = await RA.post(`/api/ats/applications/${aW4.id}/check-in`, { action: 'check_in', reason: 'Came a day early, travelling' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.result.outsideWindow, true);
  const h = (await history(aW4.id)).find((x) => x.action === 'checked_in');
  assert.equal(h.reason, 'Came a day early, travelling');
  assert.equal(h.is_override, true);
  // check-in is a walk-in thing only
  assert.equal((await RA.post(`/api/ats/applications/${aReg.id}/check-in`, { action: 'check_in' })).status, 400);
});

test('23.20 #12 two recruiters update the same applicant: the second gets the conflict and nothing is overwritten', async () => {
  const cur = (await raw(`select version from applications where id=$1`, [aW2.id])).rows[0].version;
  const first = await RA.post(`/api/ats/applications/${aW2.id}/stage`, { stage: 'attended', expectedVersion: cur });
  assert.equal(first.status, 200);
  const second = await ADMIN.post(`/api/ats/applications/${aW2.id}/stage`, { stage: 'rejected', expectedVersion: cur });
  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, 'STALE_VERSION');
  assert.equal(second.body.error.message, 'This applicant was updated by someone else. Refresh to see the latest.');
  assert.equal((await raw(`select stage from applications where id=$1`, [aW2.id])).rows[0].stage, 'attended');
  const viaStatus = await ADMIN.put(`/api/applications/${aW2.id}/status`, { stage: 'rejected', expectedVersion: cur });
  assert.equal(viaStatus.status, 409, 'the existing status route honours the version too');
  const check = await ADMIN.post(`/api/ats/applications/${aW2.id}/check-in`, { action: 'attend', expectedVersion: cur });
  assert.equal(check.status, 409);
});

test('23.20 #13 every stage change is in the audit trail and the timeline: timestamp, actor, action', async () => {
  const d = await RA.get(`/api/ats/applications/${aW1.id}`);
  assert.equal(d.status, 200, JSON.stringify(d.body));
  const t = d.body.timeline;
  assert.deepEqual(t.map((x) => x.action), ['Applied → Registered', 'Registered → Attended', 'Attended → Interviewed']);
  assert.ok(t.every((x) => x.at && x.actor));
  assert.equal(t[0].actor, 'Asha Rao');
  assert.equal(t[1].actor, 'Recruiter ra');
  assert.equal(t[1].source, 'Recruiter');
  // append-only: no signed-in identity may rewrite a history row
  await dbh.db.exec('set role app_api');
  try {
    const r = await raw(`update application_stage_history set note = 'x' where application_id = $1`, [aW1.id])
      .then((x) => x.affectedRows || 0, (e) => { assert.match(e.message, /append-only|permission denied/); return 0; });
    assert.equal(r, 0, 'no history row can be rewritten by the API role');
  } finally { await dbh.db.exec('reset role'); }
  assert.equal((await raw(`select count(*)::int n from application_stage_history where note = 'x'`)).rows[0].n, 0);
});

test('23.20 #14 notes: never to candidates; only the author edits / deletes; an admin deletes', async () => {
  const n1 = await RA.post(`/api/ats/applications/${aW1.id}/notes`, { note: 'Strong communication <script>alert(1)</script>' });
  assert.equal(n1.status, 201, JSON.stringify(n1.body));
  const n2 = await RA.post(`/api/ats/applications/${aW1.id}/notes`, { note: 'Second note' });
  const list = (await RA.get(`/api/ats/applications/${aW1.id}/notes`)).body.notes;
  assert.equal(list.length, 2);
  assert.equal(list[0].createdBy, 'Recruiter ra');
  assert.ok(list[0].canEdit && list[0].canDelete);
  // the admin can read and delete but not edit someone else's note
  const adminView = (await ADMIN.get(`/api/ats/applications/${aW1.id}/notes`)).body.notes;
  assert.equal(adminView.length, 2);
  assert.equal(adminView[0].canEdit, false);
  assert.equal((await ADMIN.put(`/api/ats/notes/${n1.body.noteId}`, { note: 'edited by admin' })).status, 403);
  assert.equal((await RA.put(`/api/ats/notes/${n1.body.noteId}`, { note: 'Edited by author' })).status, 200);
  assert.equal((await ADMIN.del(`/api/ats/notes/${n2.body.noteId}`)).status, 200);
  assert.equal((await RB.del(`/api/ats/notes/${n1.body.noteId}`)).status, 404);

  // the candidate: no route, nothing in bootstrap, applications or history
  const boot = JSON.stringify((await C1.get('/api/bootstrap')).body);
  assert.ok(!boot.includes('Edited by author') && !boot.includes('Strong communication'));
  const apps = JSON.stringify((await C1.get('/api/applications')).body);
  assert.ok(!apps.includes('Edited by author'));
  const hist = JSON.stringify((await C1.get(`/api/applications/${aW1.id}/history`)).body);
  assert.ok(!hist.includes('Edited by author'));
  const mine = JSON.stringify((await C1.get('/api/my/applications-status')).body);
  assert.ok(!mine.includes('Edited by author'));
  assert.equal((await C1.get(`/api/ats/applications/${aW1.id}/notes`)).status, 403);
  // the policy itself admits only recruiters and admins who manage the application
  const pol = (await raw(`select qual from pg_policies where tablename='application_notes' and policyname='application_notes_read'`)).rows[0].qual;
  assert.match(pol, /recruiter.*admin/);
  assert.match(pol, /ats_can_manage/);
});

test('23.20 #15 rating saves, averages across recruiters, never reaches the candidate', async () => {
  const r = await RA.put(`/api/ats/applications/${aW1.id}/rating`, { rating: 4 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.rating.average, r.body.rating.mine], [4, 4]);
  const a = await ADMIN.put(`/api/ats/applications/${aW1.id}/rating`, { rating: 5 });
  assert.equal(a.body.rating.average, 4.5);
  const change = await RA.put(`/api/ats/applications/${aW1.id}/rating`, { rating: 2 });
  assert.equal(change.body.rating.average, 3.5);
  assert.equal((await RA.put(`/api/ats/applications/${aW1.id}/rating`, { rating: 6 })).status, 400);
  const row = (await RA.get(`/api/jobs/${WALK}/applicants?q=asha`)).body.applicants[0];
  assert.equal(row.rating, 3.5);
  const mine = (await C1.get('/api/my/applications-status')).body;
  assert.ok(!JSON.stringify(mine).includes('rating'));
  assert.ok(!JSON.stringify((await C1.get('/api/bootstrap')).body).includes('"rating"'));
});

test('23.20 #7 dashboard counts: stage tiles add up to Total Registrations; Remaining = Capacity - Total', async () => {
  const s = (await RA.get(`/api/jobs/${WALK}/ats-summary`)).body.job.tiles;
  const sum = s.registered + s.attended + s.interviewed + s.selected + s.rejected + s.noShow + s.other;
  assert.equal(sum, s.totalRegistrations);
  assert.equal(s.totalRegistrations, 3);
  assert.equal(s.capacity, 4);
  assert.equal(s.remainingCapacity, 1);
  const none = (await RA.get(`/api/jobs/${LATER}/ats-summary`)).body.job.tiles;
  assert.equal(none.capacity, null);
  assert.equal(none.remainingCapacity, null);
  const reg = (await RA.get(`/api/jobs/${REG}/ats-summary`)).body.job.regularTiles;
  assert.equal(reg.new + reg.shortlisted + reg.inProcess + reg.selected + reg.rejected, reg.total);
});

test('23.20 #20 recruiter notifications: new application, capacity reached, walk-in tomorrow, post-drive summary', async () => {
  const before = mock.received.length;
  const out = await ats.runApplicationAlerts();
  assert.ok(out.instant >= 5, JSON.stringify(out));
  const alerts = (await raw(`select kind, channel, status, recruiter_id from ats_recruiter_alerts where kind='new_application' order by id`)).rows;
  assert.ok(alerts.filter((x) => x.recruiter_id === 'ra' && x.channel === 'portal' && x.status === 'sent').length >= 5);
  assert.ok(alerts.some((x) => x.channel === 'email' && x.status === 'sent'));
  assert.ok(mock.received.slice(before).some((m) => JSON.stringify(m.body).includes('New application')));
  const again = await ats.runApplicationAlerts();
  assert.equal(again.instant, 0, 'never twice');

  // capacity: one more registration fills WALK (capacity 4)
  await apply(C4, WALK);
  const cap = await ats.runApplicationAlerts();
  assert.equal(cap.capacity, 1);
  assert.equal((await ats.runApplicationAlerts()).capacity, 0);
  const bell = (await raw(`select title from notifications where recipient_id='ra' and title like 'Registrations full%'`)).rows;
  assert.equal(bell.length, 1);

  // walk-in tomorrow: the evening before LATER-1? use a job dated tomorrow
  const TOM = await walkinJob(RA, { date: istDay(1), title: 'Walk-in: Tomorrow Drive' }, { walkin_capacity: 10 });
  await apply(C2, TOM);
  const evening = at(istDay(0), 19);
  assert.equal((await ats.runDriveSummaries({ now: at(istDay(0), 12), only: 'tomorrow' })).tomorrow, 0, 'not before the evening');
  const sum = await ats.runDriveSummaries({ now: evening, only: 'tomorrow' });
  assert.equal(sum.tomorrow, 1, JSON.stringify(sum));
  const tm = (await raw(`select message from notifications where recipient_id='ra' and title like 'Walk-in tomorrow%'`)).rows[0];
  assert.match(tm.message, /1 registered, 9 of 10 places left/);
  assert.equal((await ats.runDriveSummaries({ now: evening, only: 'tomorrow' })).tomorrow, 0);
});

test('23.20 #17 / #18 / post-drive: No Show after end + grace, Attended untouched, twice = no duplicate; override back to Attended needs a reason', async () => {
  const ends = (await raw(`select walkin_ends_at(walkin_date, walkin_to) e from jobs where id=$1`, [WALK])).rows[0].e;
  const tooEarly = await ats.runNoShows({ now: new Date(ends).getTime() + 30 * 60000 });
  assert.equal(tooEarly.length, 0, 'inside the 60-minute grace nobody is marked');
  const later = new Date(ends).getTime() + 61 * 60000;
  const marked = await ats.runNoShows({ now: later });
  // registered and never checked in: C4's WALK application only (aW2 attended, aW3 attended, aW1 interviewed)
  const c4app = (await raw(`select id from applications where job_id=$1 and candidate_id=$2`, [WALK, C4.id])).rows[0].id;
  assert.deepEqual(marked, [c4app]);
  const h = (await history(c4app)).filter((x) => x.to_stage === 'no_show');
  assert.equal(h.length, 1);
  assert.equal(h[0].source, 'system');
  assert.equal(h[0].changed_by, null);
  assert.match(h[0].reason, /60 minutes/);
  for (const id of [aW1.id, aW2.id, aW3.id]) {
    assert.notEqual((await raw(`select stage from applications where id=$1`, [id])).rows[0].stage, 'no_show');
  }
  const twice = await ats.runNoShows({ now: later + 3600000 });
  assert.equal(twice.length, 0);
  assert.equal((await history(c4app)).filter((x) => x.to_stage === 'no_show').length, 1, 'no duplicate history');
  // no candidate message for a No Show
  assert.equal((await raw(`select count(*)::int n from notifications where application_id=$1 and recipient_role='candidate' and created_at > now() - interval '1 minute' and title ilike '%show%'`, [c4app])).rows[0].n, 0);

  // #18: override No Show -> Attended
  const noReason = await RA.post(`/api/ats/applications/${c4app}/stage`, { stage: 'attended' });
  assert.equal(noReason.status, 400);
  assert.equal(noReason.body.error.code, 'REASON_REQUIRED');
  const ok = await RA.post(`/api/ats/applications/${c4app}/stage`, { stage: 'attended', reason: 'Arrived late, interviewed at 5 pm' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.result.override, true);
  const o = (await history(c4app)).pop();
  assert.deepEqual([o.from_stage, o.to_stage, o.is_override, o.reason], ['no_show', 'attended', true, 'Arrived late, interviewed at 5 pm']);

  // post-drive summary, once
  const s1 = await ats.runDriveSummaries({ now: later, only: 'post' });
  assert.equal(s1.postDrive, 1, JSON.stringify(s1));
  assert.equal((await ats.runDriveSummaries({ now: later + 60000, only: 'post' })).postDrive, 0);
  const pd = (await raw(`select message from notifications where recipient_id='ra' and title like 'Walk-in summary%'`)).rows[0];
  assert.match(pd.message, /Registered \d+, Attended \d+, Interviewed \d+, Selected \d+, Rejected \d+, No Show \d+/);
});

test('23.20 #16 / #19 reschedule: history keeps old/new, one combined message per registered applicant, later date = no No Show', async () => {
  const C5 = await candidate('Esha Patel', 'esha.ats@tl-sink.local', '9000000205');
  const C6 = await candidate('Farhan Ali', 'farhan.ats@tl-sink.local', '9000000206');
  const RS = await walkinJob(RA, { date: istDay(2), title: 'Walk-in: Reschedule Me' });
  await apply(C5, RS);
  await apply(C6, RS);
  const put = (over) => RA.put(`/api/jobs/${RS}`, { title: 'Walk-in: Reschedule Me', companyId: 'co_a', postingKind: 'walkin', type: 'Walk-in', ...over });
  const e1 = await put({ walkinDate: istDay(4), walkinFrom: '10:00', walkinTo: '16:00' });
  assert.equal(e1.status, 200, JSON.stringify(e1.body));
  const e2 = await put({ walkinVenue: 'Hotel Grand Annexe, Hall B' });
  assert.equal(e2.status, 200);

  const hist = (await RA.get(`/api/jobs/${RS}/update-history`)).body;
  const byField = Object.fromEntries(hist.history.map((h) => [h.field, h]));
  assert.equal(byField.walkin_date.oldValue, istDay(2));
  assert.equal(byField.walkin_date.newValue, istDay(4));
  assert.equal(byField.walkin_venue.oldValue, 'Hotel Grand');
  assert.equal(byField.walkin_venue.newValue, 'Hotel Grand Annexe, Hall B');
  assert.equal(byField.walkin_date.updatedBy, 'Recruiter ra');
  assert.equal(hist.reschedules.length, 1, 'two quick saves = one pending notification');
  assert.equal(hist.reschedules[0].status, 'pending');

  // not yet: the merge window has not passed
  assert.equal((await ats.runReschedules()).length, 0);
  const before = mock.received.length;
  const sent = (await ats.runReschedules({ now: Date.now() + 5 * 60000 })).filter(Boolean);
  assert.equal(sent.length, 1, JSON.stringify(sent));
  assert.equal(sent[0].status, 'sent', JSON.stringify(sent));
  assert.equal(sent[0].recipients, 2);
  const msgs = (await raw(`select candidate_id, channel, status from walkin_ats_messages where job_id=$1 and kind='reschedule'`, [RS])).rows;
  assert.equal(msgs.filter((m) => m.channel === 'portal').length, 2, 'one combined message per candidate');
  assert.equal(msgs.filter((m) => m.channel === 'email' && m.status === 'sent').length, 2);
  const emails = mock.received.slice(before).filter((m) => m.url === '/email'
    && JSON.stringify(m.body).includes('Walk-in interview details changed'));
  assert.equal(emails.length, 2);
  const body = JSON.stringify(emails[0].body);
  assert.ok(body.includes('Hotel Grand Annexe, Hall B') && body.includes('Venue (old): Hotel Grand'), 'old and new venue');
  assert.ok(body.includes(`Job ID ${RS}`));
  assert.ok(body.includes('Ravi, 9000011111'), 'contact person and number');
  assert.ok(body.includes('maps.google.com'), 'the map link');
  assert.ok(!body.includes('Alpha Services'), 'no company name in the message');
  const built = ats.buildCandidateMessage('reschedule', { job: { id: RS, title: 'T' }, ref: 'TL-APP-1', name: 'X',
    details: { date: istDay(4), venue: 'V' }, changes: [{ field: 'Venue', old: 'A', new: 'B' }] });
  assert.ok(!/client/i.test(built.email.text + built.email.html + built.sms + built.whatsapp), 'never the word Client');
  const portal = (await raw(`select message from notifications where job_id=$1 and recipient_role='candidate' and title='Walk-in interview details changed'`, [RS])).rows;
  assert.equal(portal.length, 2);
  // the history records the notification; the recruiter is told
  const h2 = (await RA.get(`/api/jobs/${RS}/update-history`)).body;
  assert.ok(h2.history.some((h) => h.field === 'reschedule_notification' && /Notified 2 registered applicants/.test(h.newValue)));
  assert.equal(h2.reschedules[0].status, 'sent');
  assert.ok((await raw(`select 1 from notifications where recipient_id='ra' and title like 'Reschedule sent%'`)).rowCount);
  assert.equal((await ats.runReschedules({ now: Date.now() + 10 * 60000 })).length, 0, 'sent once');

  // a failure is shown and can be retried
  await raw(`update walkin_ats_messages set status='failed', error='mock outage' where job_id=$1 and kind='reschedule' and channel='email'`, [RS]);
  await raw(`update walkin_reschedules set status='partial', failed=2 where job_id=$1`, [RS]);
  const rid = h2.reschedules[0].id;
  const retry = await RA.post(`/api/jobs/${RS}/reschedules/${rid}/retry`, {});
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.result.status, 'sent');
  assert.equal((await raw(`select count(*)::int n from walkin_ats_messages where job_id=$1 and kind='reschedule' and channel='email' and status='sent'`, [RS])).rows[0].n, 2);

  // past dates are not a reschedule
  const past = await put({ walkinDate: istDay(-1) });
  assert.equal(past.status, 400, 'refused by the form rules (0106) and, underneath, by the database (0107)');
  assert.match(past.body.error.message, /past/);
  // the database guard on its own, whatever route edits the job
  await assert.rejects(() => raw(`with s as (select set_config('app.role', 'recruiter', true) x) update jobs set walkin_date = $2 from s where id = $1`, [RS, istDay(-1)]), /cannot be moved into the past/);
  // #19: hours after the ORIGINAL end time (day 2, 16:00) the drive is now on day 4 - nobody is a No Show
  await ats.runNoShows({ now: at(istDay(2), 19) });
  const rsApps = (await raw(`select stage from applications where job_id=$1`, [RS])).rows;
  assert.equal(rsApps.length, 2);
  assert.ok(rsApps.every((x) => x.stage === 'registered'), JSON.stringify(rsApps));
  // ...and after the NEW end time + grace they are
  const moved = await ats.runNoShows({ now: at(istDay(4), 17, 5) });
  assert.ok(moved.length >= 2);
  assert.ok((await raw(`select stage from applications where job_id=$1`, [RS])).rows.every((x) => x.stage === 'no_show'));
});

test('13.2 reminders: the day before and the morning of, Registered only, once each', async () => {
  const C7 = await candidate('Gita Sharma', 'gita.ats@tl-sink.local', '9000000207');
  const D = istDay(2);
  const RJ = await walkinJob(RA, { date: D, title: 'Walk-in: Reminder Drive' }, { walkin_documents: 'Resume copy\nPhoto ID' });
  const app7 = await apply(C7, RJ);
  const app8 = await apply(C3, RJ);
  await RA.post(`/api/ats/applications/${app8.id}/stage`, { stage: 'rejected' });
  const dayBefore = at(istDay(1), 11);
  const r1 = await ats.runReminders({ now: dayBefore });
  assert.equal(r1.dayBefore, 1, JSON.stringify(r1));
  assert.equal((await ats.runReminders({ now: dayBefore + 60000 })).dayBefore, 0);
  const r2 = await ats.runReminders({ now: at(D, 8) });
  assert.equal(r2.morning, 1);
  const rows = (await raw(`select kind, channel, status from walkin_ats_messages where application_id=$1 and channel='email'`, [app7.id])).rows;
  assert.deepEqual(rows.map((x) => x.kind).sort(), ['reminder_day_before', 'reminder_morning']);
  assert.equal((await raw(`select count(*)::int n from walkin_ats_messages where application_id=$1`, [app8.id])).rows[0].n, 0, 'rejected applicants get no reminder');
});

test('23.18 decision messages are recruiter-triggered, templated, logged in the timeline; walk-in moves send nothing by themselves', async () => {
  const before = (await raw(`select count(*)::int n from notifications where application_id=$1 and recipient_role='candidate'`, [aW1.id])).rows[0].n;
  const sel = await RA.post(`/api/ats/applications/${aW1.id}/stage`, { stage: 'selected' });
  assert.equal(sel.status, 200, JSON.stringify(sel.body));
  assert.equal((await raw(`select count(*)::int n from notifications where application_id=$1 and recipient_role='candidate'`, [aW1.id])).rows[0].n, before,
    'no automatic message on a walk-in move');
  const tpl = (await RA.get(`/api/ats/applications/${aW1.id}/decision-template?kind=selected`)).body;
  assert.match(tpl.subject, /selected/i);
  assert.ok(!/client/i.test(tpl.body));
  const wrong = await RA.post(`/api/ats/applications/${aW1.id}/decision-message`, { kind: 'rejected', subject: 'x'.repeat(5), body: 'y'.repeat(20) });
  assert.equal(wrong.status, 409);
  const send = await RA.post(`/api/ats/applications/${aW1.id}/decision-message`, { kind: 'selected', subject: tpl.subject, body: tpl.body + '\nPlease bring your ID.' });
  assert.equal(send.status, 200, JSON.stringify(send.body));
  assert.equal(send.body.channels.email, 'sent');
  const t = (await RA.get(`/api/ats/applications/${aW1.id}`)).body.timeline;
  assert.equal(t[t.length - 1].action, 'Message sent');
  assert.equal(t[t.length - 1].actor, 'Recruiter ra');
  const clientWord = await RA.post(`/api/ats/applications/${aW1.id}/decision-message`, { kind: 'selected', subject: 'Selected by our client', body: 'The client liked you very much.' });
  assert.equal(clientWord.status, 400);
});

test('23.20 #21 My Applications: status and walk-in details, no notes, ratings, history or internal stage names', async () => {
  const r = await C4.get('/api/my/applications-status');
  assert.equal(r.status, 200);
  const later = r.body.applications.find((a) => a.jobId === LATER);
  assert.equal(later.status, 'Registered');
  assert.equal(later.walkin.venue, 'Hotel Grand');
  assert.equal(later.walkin.address, '12 Trunk Road, Ameerpet');
  assert.match(later.reference, /^TL-APP-/);
  const walk = r.body.applications.find((a) => a.jobId === WALK);
  assert.equal(walk.status, 'Attended');
  assert.equal(walk.walkin, null, 'walk-in details only while the drive is upcoming and they are registered');
  const text = JSON.stringify(r.body);
  for (const bad of ['no_show', 'No Show', 'stage', 'rating', 'note', 'Arrived late']) assert.ok(!text.includes(bad), bad);
  // a No Show reads "Missed" (the reschedule test's candidates were swept to No Show)
  const esha = await makeClient(base);
  await esha.get('/api/health');
  assert.equal((await esha.post('/api/auth/login', { email: 'esha.ats@tl-sink.local', password: 'Walkin123ats' })).status, 200);
  const m = (await esha.get('/api/my/applications-status')).body.applications[0];
  assert.equal(m.status, 'Missed');
  assert.ok(!JSON.stringify(m).includes('No Show'));
  const st = (await C4.get('/api/bootstrap')).body.data.stages.map((s) => s.id);
  assert.ok(!st.includes('no_show') && !st.includes('registered'), 'walk-in stages never enter the regular pipeline lists');
  const asaR = (await C1.get('/api/my/applications-status')).body.applications.find((a) => a.jobId === REG);
  assert.equal(asaR.status, 'Under review');
});

test('23.20 #22 one candidate, two applications: one Candidate ID, both on the details page', async () => {
  const d = (await RA.get(`/api/ats/applications/${aW1.id}`)).body;
  assert.equal(d.candidate.candidateId, C1.id);
  const jobs = d.otherApplications.map((o) => o.jobId);
  assert.ok(jobs.includes(REG));
  assert.equal(d.walkin.venue, 'Hotel Grand');
  assert.ok(d.walkin.attendedAt);
  assert.equal(d.application.rating.average, 3.5);
  assert.equal((await raw(`select count(*)::int n from candidates where email=$1`, [C1.email])).rows[0].n, 1);
});

test('23.20 #23 export: the 23.19 columns, notes only when asked, role scope', async () => {
  const csv = await RA.post(`/api/jobs/${WALK}/applicants/export`, { format: 'csv' });
  assert.equal(csv.status, 200);
  const text = csv.body.raw || '';
  const header = text.replace(/^﻿/, '').split('\r\n')[0];
  assert.equal(header, 'Application ID,Candidate ID,Name,Mobile,Email,Job ID,Job Title,Job Type,Application Date,Stage,Status,Attended,Rating,Checked-in time,Attended time,Interviewed time,Walk-in status,Application Source');
  assert.ok(!text.includes('Edited by author'), 'no notes in a general export');
  assert.ok(text.includes('Walk-in'));
  const withNotes = await RA.post(`/api/jobs/${WALK}/applicants/export`, { format: 'csv', includeNotes: true });
  assert.ok((withNotes.body.raw || '').includes('Recruiter notes') && withNotes.body.raw.includes('Edited by author'));
  const x = await RA.post(`/api/jobs/${WALK}/applicants/export`, { format: 'xlsx' });
  assert.equal(x.status, 200);
  assert.match(x.headers.get('content-type'), /spreadsheetml/);
  assert.equal((await RB.post(`/api/jobs/${WALK}/applicants/export`, { format: 'csv' })).status, 404);
  const audit = (await raw(`select kind, scope, candidate_count, filters from export_audit order by id desc limit 1`)).rows[0];
  assert.equal(audit.kind, 'list_xlsx');
  assert.equal(audit.filters.jobId, WALK);
});

test('23.20 #24 a job with 160 applicants: paginated, searched, fast', async () => {
  const BIG = await walkinJob(RA, { date: istDay(5), title: 'Walk-in: Mega Drive' });
  await raw(`insert into candidates (id, name, email, phone)
             select 'bulkc' || g, 'Bulk Person ' || g, 'bulk' || g || '@tl-sink.local', '98' || lpad(g::text, 8, '0')
               from generate_series(1, 160) g`);
  await raw(`insert into applications (id, job_id, candidate_id) select 'bulka' || g, $1, 'bulkc' || g from generate_series(1, 160) g`, [BIG]);
  const t0 = Date.now();
  const p1 = await RA.get(`/api/jobs/${BIG}/applicants?page=1&pageSize=25`);
  const ms = Date.now() - t0;
  assert.equal(p1.status, 200);
  assert.equal(p1.body.total, 160);
  assert.equal(p1.body.applicants.length, 25);
  assert.equal(p1.body.pages, 7);
  assert.ok(ms < 3000, `first page took ${ms} ms`);
  const p7 = await RA.get(`/api/jobs/${BIG}/applicants?page=7&pageSize=25`);
  assert.equal(p7.body.applicants.length, 10);
  const one = await RA.get(`/api/jobs/${BIG}/applicants?q=Bulk%20Person%20137`);
  assert.equal(one.body.total, 1);
  assert.equal(p1.body.job.tiles.registered, 160, 'inserted directly, still Registered by the trigger');
  // Section 14: a closed walk-in keeps every applicant visible to its recruiter
  assert.equal((await RA.put(`/api/jobs/${BIG}`, { title: 'Walk-in: Mega Drive', companyId: 'co_a', status: 'closed' })).status, 200);
  assert.equal((await RA.get(`/api/jobs/${BIG}/applicants`)).body.total, 160);
  console.log(`      160 applicants: first page in ${ms} ms`);
});

test('the existing interview scheduling does not break on a walk-in application', async () => {
  const stageOf = async () => (await RA.get(`/api/ats/applications/${aW4.id}`)).body.application.stage;
  const st = await stageOf();
  const r = await RA.post('/api/interviews', { candidateId: C4.id, jobId: LATER, date: istDay(3), time: '11:00', mode: 'In Person' });
  assert.ok(r.status < 300, JSON.stringify(r.body));
  assert.equal(await stageOf(), st,
    'a regular-pipeline move nobody asked for does not apply to a walk-in');
});

test('per-job alert mode and admin settings', async () => {
  assert.equal((await RA.get(`/api/jobs/${REG}/ats-settings`)).body.newApplicationAlerts, 'auto');
  assert.equal((await RA.put(`/api/jobs/${REG}/ats-settings`, { newApplicationAlerts: 'digest' })).status, 200);
  assert.equal((await RB.put(`/api/jobs/${REG}/ats-settings`, { newApplicationAlerts: 'off' })).status, 404);
  assert.equal((await RA.get('/api/admin/walkin-ats/settings')).status, 403);
  const s = await ADMIN.get('/api/admin/walkin-ats/settings');
  assert.equal(s.body.noShowGraceMinutes, 60);
  const stages = (await RA.get('/api/ats/stages')).body;
  assert.deepEqual(stages.walkin.map((x) => x.id), ['registered', 'attended', 'interviewed', 'selected', 'rejected', 'no_show']);
  assert.equal(stages.transitions.length, 11);
});

test('shutdown', async () => {
  await new Promise((r) => server.close(r));
  await mock.stop();
  const { closePool } = await import('../src/db.js');
  await closePool();
  await dbh.stop();
});
