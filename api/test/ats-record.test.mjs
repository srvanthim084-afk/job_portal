/**
 * 0111 end to end against a real Postgres with RLS on: the candidate's
 * tracker and dashboard counts, interviews (modes + states), source
 * tracking, referrals, the assessment extension point and its filter,
 * the ATS candidate record + timeline + matching, the admin audit log,
 * portal analytics, the employee hand-off queue, and the server's
 * profile score agreeing with the candidate's own screen.
 *
 * Self-contained: its own companies, recruiters, jobs and candidates.
 * No provider is configured, so nothing leaves the machine.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { startTestDb, applyTestEnv, makeClient } from './harness.mjs';

const DB_PORT = 5491;
const API_PORT = 9979;
const CLIENT_CO = 'Northwind Client Hospitals';    // must never reach a candidate

let dbh, server, base, raw, rec, rec2, admin;
let seq = 0;

async function staff(role, email, id, company) {
  const { hashPassword } = await import('../src/auth.js');
  const hash = await hashPassword('Staff123pass');
  const u = (await raw(`insert into users (email,password_hash,role) values ($1,$2,$3) returning id`, [email, hash, role])).rows[0].id;
  if (role === 'recruiter') await raw(`insert into recruiters (id,name,email,company_id,user_id) values ($1,$2,$3,$4,$5)`, [id, 'Rec ' + id, email, company, u]);
  if (role === 'admin') await raw(`insert into admins (id,name,email,user_id) values ($1,'Admin',$2,$3)`, [id, email, u]);
  const c = makeClient(base);
  await c.get('/api/health');
  const r = await c.post('/api/auth/login', { email, password: 'Staff123pass', role });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return c;
}
async function job(f = {}) {
  seq += 1;
  const id = f.id || `jy2_${seq}`;
  await raw(`insert into jobs (id,title,company_id,recruiter_id,location,mode,exp_label,employment_type,status,skills,
                               published_at,posting_kind,walkin_date,walkin_from,walkin_to,walkin_venue,walkin_address)
             values ($1,$2,$3,$4,'Hyderabad','Onsite','0-2 yrs','Full-time','open',$5,now(),$6,$7,$8,$9,$10,$11)`,
    [id, f.title || 'Java Developer', f.company || 'co_y2', f.recruiter || 'ry2a', f.skills || ['Java', 'SQL'],
     f.kind || 'job', f.walkinDate || null, f.walkinFrom || null, f.walkinTo || null, f.venue || null, f.address || null]);
  return id;
}
async function candidate(name) {
  const c = makeClient(base);
  await c.get('/api/health');
  seq += 1;
  const r = await c.post('/api/auth/register', {
    name, email: `${name.toLowerCase().replace(/\W+/g, '.')}.${seq}@tl-sink.local`, password: 'Track123ing',
    phone: '9' + String(100000000 + Math.floor(Math.random() * 899999999)),
    preferredLocation: 'Hyderabad', expectedCtc: 3, noticePeriod: 'Immediate', preferredWorkModes: ['Hybrid'],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  c.id = r.body.candidateId;
  return c;
}
const move = async (who, appId, stage, extra = {}) => {
  const r = await who.put(`/api/applications/${appId}/status`, { stage, ...extra });
  assert.equal(r.status, 200, `${stage}: ${JSON.stringify(r.body)}`);
};
const istToday = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
const plusDays = (n) => new Date(Date.now() + 5.5 * 3600e3 + n * 86400e3).toISOString().slice(0, 10);

let A, B, jobJava, jobWalk, appA;

test('boot', async () => {
  dbh = await startTestDb(DB_PORT);
  applyTestEnv(dbh.url, {
    PUBLIC_ORIGIN: `http://127.0.0.1:${API_PORT}`, DISABLE_BACKGROUND_WORK: 'true',
    SMS_API_KEY: '', WHATSAPP_API_KEY: '', EMAIL_API_KEY: '', EMAIL_SMTP_HOST: '', EMAIL_SMTP_USER: '', EMAIL_SMTP_PASS: '',
    EMAILJS_SERVICE_ID: '', EMAILJS_TEMPLATE_ID: '', EMAILJS_PUBLIC_KEY: '', EMAILJS_PRIVATE_KEY: '', AI_API_KEY: '',
    OUTBOUND_ALLOWLIST: '', AVAILABILITY_RECONFIRM_MESSAGES: 'false',
  });
  raw = (sql, params) => dbh.db.query(sql, params);
  const { createApp } = await import('../src/app.js');
  const app = createApp({ logger: { error() {}, log() {} } });
  await new Promise((r) => { server = app.listen(API_PORT, r); });
  base = `http://127.0.0.1:${API_PORT}`;
  await raw(`insert into companies (id,name) values ('co_y2','Y2 Staffing'),('co_y2b',$1)`, [CLIENT_CO]);
  rec = await staff('recruiter', 'ry2a@tl-sink.local', 'ry2a', 'co_y2');
  rec2 = await staff('recruiter', 'ry2b@tl-sink.local', 'ry2b', 'co_y2b');
  admin = await staff('admin', 'ay2@tl-sink.local', 'ay2', null);
  jobJava = await job({ title: 'Java Developer Y2' });
  jobWalk = await job({ title: 'Walk-in Support Y2', kind: 'walkin', walkinDate: plusDays(3), walkinFrom: '10:00', walkinTo: '14:00',
    venue: 'Hall B', address: 'Madhapur, Hyderabad' });
});

test('source: self-registration is Direct Registration; the application carries its own source', async () => {
  A = await candidate('Asha Tracker');
  const s = (await raw(`select source from candidates where id=$1`, [A.id])).rows[0].source;
  assert.equal(s, 'Direct Registration');
  const r = await A.post('/api/applications', { jobId: jobJava });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  appA = r.body.application.id;
  assert.equal((await raw(`select source_channel from applications where id=$1`, [appA])).rows[0].source_channel, 'TeamLink Website');
  const vocab = (await raw(`select candidate_source_values() v`)).rows[0].v;
  for (const v of ['Direct Registration', 'Referral', 'LinkedIn', 'Naukri', 'Indeed', 'Shine', 'External Jobs', 'TeamLink Website', 'Walk-in Application']) {
    assert.ok(vocab.includes(v), v);
  }
  assert.equal((await raw(`select candidate_source_canonical('naukri.com') v`)).rows[0].v, 'Naukri');
  assert.equal((await raw(`select candidate_source_canonical('Employee Referral') v`)).rows[0].v, 'Employee Referral', 'old values unchanged');
});

test('dashboard: counts from the server and the tracker follows the real stage', async () => {
  let d = (await A.get('/api/candidate/dashboard')).body;
  assert.equal(d.counts.applications, 1);
  assert.equal(d.counts.shortlisted, 0);
  assert.equal(d.counts.savedJobs, 0);
  assert.equal(typeof d.counts.profileStrength, 'number');
  assert.deepEqual(d.tracker.phases.filter((p) => p.onLine).map((p) => p.step), ['Applied', 'HR Review', 'Shortlisted', 'Interview', 'Offer', 'Hired']);
  assert.equal(d.recentApplications[0].status, 'Applied');

  await A.post(`/api/saved-jobs/${jobWalk}`);
  await move(rec, appA, 'ai_screening');
  d = (await A.get('/api/candidate/dashboard')).body;
  assert.equal(d.recentApplications[0].status, 'Under Review');
  assert.equal(d.counts.savedJobs, 1);

  await move(rec, appA, 'client_review');
  d = (await A.get('/api/candidate/dashboard')).body;
  assert.ok(!JSON.stringify(d).includes('Client'), 'the candidate never reads "Client"');
  assert.ok(!JSON.stringify(d).includes(CLIENT_CO));

  await move(rec, appA, 'shortlisted');
  d = (await A.get('/api/candidate/dashboard')).body;
  assert.equal(d.counts.shortlisted, 1);
  const app = d.recentApplications[0];
  assert.equal(app.status, 'Shortlisted');
  assert.deepEqual(app.steps.map((s) => s.state), ['done', 'done', 'current', 'todo', 'todo', 'todo']);
  assert.ok(app.steps[1].at, 'HR Review has the date it was reached');

  await move(rec, appA, 'hold');
  d = (await A.get('/api/candidate/dashboard')).body;
  assert.equal(d.recentApplications[0].status, 'On Hold');
  assert.equal(d.recentApplications[0].offLine.phase, 'hold');
  assert.equal(d.counts.shortlisted, 0, 'on hold is not counted as shortlisted');
  await move(rec, appA, 'shortlisted');
});

test('interviews: online, rescheduled, walk-in; never the score', async () => {
  const r = await rec.post('/api/interviews', { candidateId: A.id, jobId: jobJava, date: plusDays(2), time: '11:00 AM', mode: 'Video Call', type: 'Technical' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const ivId = r.body.interview.id;
  let s = (await A.get('/api/candidate/interviews/schedule')).body;
  let iv = s.interviews.find((x) => x.id === ivId);
  assert.equal(iv.mode, 'Online');
  assert.equal(iv.state, 'Scheduled');
  assert.equal(iv.company, 'Y2 Staffing');
  assert.equal(s.upcoming, 1);

  assert.equal((await rec.put(`/api/interviews/${ivId}`, { date: plusDays(4), aiScore: 77 })).status, 200);
  s = (await A.get('/api/candidate/interviews/schedule')).body;
  iv = s.interviews.find((x) => x.id === ivId);
  assert.equal(iv.state, 'Rescheduled');
  assert.ok(!('score' in iv) && !JSON.stringify(iv).includes('77'), 'the candidate is not handed the score');

  /* the candidate cannot change it */
  assert.equal((await A.put(`/api/interviews/${ivId}`, { status: 'Completed' })).status, 403);

  /* a walk-in application is an interview with mode Walk-in and the venue */
  await raw(`insert into applications (id, job_id, candidate_id) values ('app_y2_walk', $1, $2)`, [jobWalk, A.id]);
  assert.equal((await raw(`select source_channel, stage from applications where id='app_y2_walk'`)).rows[0].source_channel, 'Walk-in Application');
  s = (await A.get('/api/candidate/interviews/schedule')).body;
  const w = s.interviews.find((x) => x.kind === 'walkin');
  assert.equal(w.mode, 'Walk-in');
  assert.match(w.venue, /Hall B/);
  assert.equal(w.state, 'Scheduled');
  assert.equal(s.upcoming, 2);
  const d = (await A.get('/api/candidate/dashboard')).body;
  assert.equal(d.counts.interviews, 2);
  assert.equal(d.counts.applications, 2);
});

test('application history: paginated, searchable, with the interview and Application ID', async () => {
  const h = (await A.get('/api/candidate/applications/history?pageSize=1&page=1')).body;
  assert.equal(h.total, 2);
  assert.equal(h.rows.length, 1);
  const q = (await A.get('/api/candidate/applications/history?q=java')).body;
  assert.equal(q.total, 1);
  const row = q.rows[0];
  assert.match(row.reference, /^TL-APP-/);
  assert.equal(row.jobType, 'Regular');
  assert.equal(row.company, 'Y2 Staffing');
  assert.ok(row.lastUpdated && row.appliedAt);
  assert.equal(row.interview.mode, 'Online');
  const wk = (await A.get('/api/candidate/applications/history?q=walk')).body.rows[0];
  assert.equal(wk.jobType, 'Walk-in');
});

test('assessments: staff record, the candidate only reads, recruiters filter on it', async () => {
  assert.equal((await A.post(`/api/ats/candidates/${A.id}/assessments`, { name: 'Java', score: 90 })).status, 403);
  const r = await rec.post(`/api/ats/candidates/${A.id}/assessments`, { name: 'Java Core', category: 'Java', score: 41, maxScore: 50, assessedOn: istToday(), provider: 'External test' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.assessment.percent, 82);
  assert.equal((await rec.post(`/api/ats/candidates/${A.id}/assessments`, { name: 'X', score: 120 })).status, 400);
  const mine = (await A.get('/api/candidate/assessments')).body.assessments;
  assert.equal(mine.length, 1);
  assert.equal(mine[0].score, 41);
  const hit = (await rec.get('/api/candidates?assessment=java&assessmentMin=80&limit=50')).body;
  const ids = (hit.candidates || hit.rows || []).map((x) => x.id);
  assert.ok(ids.includes(A.id), 'filter finds 82%');
  const miss = (await rec.get('/api/candidates?assessment=java&assessmentMin=90&limit=50')).body;
  assert.ok(!(miss.candidates || miss.rows || []).map((x) => x.id).includes(A.id), 'filter drops it at 90%');
});

test('referrals: optional code, claimed once, follows the application, never names the person', async () => {
  const ref = (await A.get('/api/candidate/referral')).body;
  assert.match(ref.code, /^R[0-9A-F]{8}$/);
  assert.equal(ref.referrals.length, 0);
  assert.equal((await A.post('/api/candidate/referral/claim', { code: ref.code })).body.result, 'own');
  B = await candidate('Bala Referred');
  assert.equal((await B.post('/api/candidate/referral/claim', { code: 'RNOTACODE' })).body.result, 'invalid');
  assert.equal((await B.post('/api/candidate/referral/claim', { code: ref.code })).body.result, 'ok');
  assert.equal((await B.post('/api/candidate/referral/claim', { code: ref.code })).body.result, 'already');
  assert.equal((await raw(`select source from candidates where id=$1`, [B.id])).rows[0].source, 'Referral');
  let made = (await A.get('/api/candidate/referral')).body.referrals;
  assert.equal(made.length, 1);
  assert.equal(made[0].status, 'registered');
  assert.ok(!JSON.stringify(made).includes('Bala'));
  const ab = await B.post('/api/applications', { jobId: jobJava });
  assert.equal(ab.status, 201);
  assert.equal((await raw(`select source_channel from applications where id=$1`, [ab.body.application.id])).rows[0].source_channel, 'Referral');
  made = (await A.get('/api/candidate/referral')).body.referrals;
  assert.equal(made[0].status, 'applied');
  /* staff see it on the record and may add an optional reward */
  const recB = (await rec.get(`/api/ats/candidates/${B.id}/record`)).body.record;
  assert.equal(recB.referral.referrerCandidateId, A.id);
  const up = await rec.put(`/api/ats/referrals/${recB.referral.id}`, { rewardAmount: 2000, rewardStatus: 'pending' });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.equal(up.body.referral.rewardAmount, 2000);
  assert.equal((await B.put(`/api/ats/referrals/${recB.referral.id}`, { rewardStatus: 'paid' })).status, 403);
});

test('ATS record: every field, timeline from real events, matching, and only for staff who can see them', async () => {
  const r = await rec.get(`/api/ats/candidates/${A.id}/record`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const x = r.body.record;
  assert.equal(x.candidateId, A.id);
  assert.match(x.candidateCode, /^TL-CAN-\d{6}$/);
  assert.equal(x.name, 'Asha Tracker');
  assert.ok(x.email && x.mobile);
  assert.equal(typeof x.profileScore, 'number');
  assert.equal(x.source.candidate, 'Direct Registration');
  assert.ok(x.currentStage && x.lastUpdated);
  assert.equal(x.applications.length, 2);
  const java = x.applications.find((a) => a.jobId === jobJava);
  assert.equal(java.source, 'TeamLink Website');
  assert.ok(['Eligible', 'Check', 'Not eligible'].includes(java.matching.eligibility.status));
  assert.ok('resumeScore' in java.matching && 'profileScore' in java.matching && 'matchScore' in java.matching);
  assert.equal(x.interviews.length, 1);
  assert.equal(x.interviews[0].state, 'Rescheduled');
  assert.equal(x.assessments.length, 1);
  const kinds = x.timeline.map((e) => e.label);
  for (const k of ['Registered', 'Applied', 'Shortlisted', 'On Hold', 'Interview Scheduled', 'Interview Rescheduled']) assert.ok(kinds.includes(k), k + ' in ' + kinds.join(','));
  const times = x.timeline.map((e) => e.at);
  assert.deepEqual(times, [...times].sort().reverse(), 'newest first');

  /* Another company's recruiter: the shared pool rule (0031) - the profile
     is searchable, their applications, interviews and timeline are not. */
  const other = (await rec2.get(`/api/ats/candidates/${A.id}/record`)).body.record;
  assert.equal(other.applications.length, 0);
  assert.equal(other.interviews.length, 0);
  assert.ok(!other.timeline.some((e) => e.kind === 'applied'));
  await raw(`update candidates set is_private = true where id=$1`, [A.id]);
  assert.equal((await rec2.get(`/api/ats/candidates/${A.id}/record`)).status, 404, 'a private profile outside their pipeline');
  assert.equal((await rec.get(`/api/ats/candidates/${A.id}/record`)).status, 200, 'still in our own pipeline');
  await raw(`update candidates set is_private = false where id=$1`, [A.id]);
  assert.equal((await A.get(`/api/ats/candidates/${A.id}/record`)).status, 403);
});

test('offer -> selected queues a hand-off (no HRMS, nothing sent); rejected cancels it', async () => {
  await move(rec, appA, 'offer_extended');
  await move(rec, appA, 'selected');
  let h = (await admin.get('/api/admin/employee-handoffs')).body;
  assert.equal(h.hrmsConfigured, false);
  const mine = h.handoffs.find((x) => x.applicationId === appA);
  assert.equal(mine.status, 'pending');
  assert.equal(mine.stage, 'selected');
  assert.match(mine.candidateCode, /^TL-CAN-/);
  assert.equal((await rec.get('/api/admin/employee-handoffs')).status, 403);
  const d = (await A.get('/api/candidate/dashboard')).body;
  assert.equal(d.recentApplications.find((a) => a.applicationId === appA).status, 'Offer');
  await move(rec, appA, 'rejected');
  h = (await admin.get('/api/admin/employee-handoffs')).body;
  assert.equal(h.handoffs.find((x) => x.applicationId === appA).status, 'cancelled');
  assert.equal((await A.get('/api/candidate/dashboard')).body.recentApplications.find((a) => a.applicationId === appA).status, 'Rejected');
});

test('admin audit log: the listed events, with user, date, entity and id; admin only', async () => {
  await raw(`update candidates set resume_file='cv.pdf', resume_storage_path='x/cv.pdf' where id=$1`, [A.id]);
  await raw(`update candidates set resume_file='cv2.pdf', resume_storage_path='x/cv2.pdf' where id=$1`, [A.id]);
  await raw(`insert into candidate_documents (candidate_id, kind, file_name, storage_path) values ($1,'certificate','c.pdf','x/c.pdf')`, [A.id]);
  const tmp = await candidate('Delete Me');
  await raw(`delete from candidates where id=$1`, [tmp.id]);
  const r = await admin.get('/api/admin/audit-log?pageSize=100');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const acts = new Set(r.body.rows.map((x) => x.actionLabel));
  for (const a of ['Candidate Created', 'Resume Uploaded', 'Resume Changed', 'Application Submitted', 'Interview Scheduled',
    'Interview Rescheduled', 'Status Changed', 'Candidate Deleted', 'Document Uploaded']) assert.ok(acts.has(a), a);
  const st = r.body.rows.find((x) => x.action === 'status.changed');
  assert.equal(st.user, 'ry2a@tl-sink.local');
  assert.equal(st.entity, 'application');
  assert.ok(st.entityId && st.at);
  const one = (await admin.get(`/api/admin/audit-log?entity=candidate&entityId=${A.id}`)).body;
  assert.ok(one.rows.every((x) => x.entityId === A.id));
  assert.ok(!JSON.stringify(one.rows).includes('cv2.pdf'), 'names of fields, never values');
  assert.equal((await rec.get('/api/admin/audit-log')).status, 403);
});

test('analytics: views, applications, conversion and walk-in numbers by job type; no personal data', async () => {
  for (let i = 0; i < 4; i += 1) assert.equal((await makeClient(base).post(`/api/jobs/${jobJava}/view`, {})).status, 200);
  await makeClient(base).post(`/api/jobs/${jobWalk}/view`, {});
  await raw(`update applications set stage='attended' where id='app_y2_walk'`);
  const a = (await admin.get('/api/admin/portal-analytics?days=30')).body;
  assert.equal(a.jobs.byType.regular.views, 4);
  assert.equal(a.jobs.byType.regular.applications, 2);
  assert.equal(a.jobs.byType.regular.conversionRate, 50);
  assert.equal(a.walkin.views, 1);
  assert.equal(a.walkin.applications, 1);
  assert.equal(a.walkin.attendance, 1);
  assert.ok(a.candidates.registrations >= 2);
  assert.ok(a.candidates.profileCompletion.average != null);
  const txt = JSON.stringify(a);
  assert.ok(!txt.includes('@') && !txt.includes('Asha'), 'no emails or names');
  assert.equal((await rec.get('/api/admin/portal-analytics')).status, 403);
});

test('profile score: the server and the candidate screen give the same number', async () => {
  const { profileScore } = await import('../src/candidates/profile-score.js');
  const src = readFileSync(new URL('../../web/teamlink-profile-sections.js', import.meta.url), 'utf8');
  const sandbox = { window: {}, document: { addEventListener() {}, querySelectorAll() { return []; } }, setTimeout() {}, console };
  sandbox.window.window = sandbox.window;
  vm.createContext(sandbox);
  try { vm.runInContext(src, sandbox); } catch { /* DOM hooks at the end are not needed */ }
  const capCompletion = sandbox.window.capCompletion;
  assert.equal(typeof capCompletion, 'function');
  const samples = [
    {},
    { name: 'A', email: 'a@x', phone: '9', location: 'Hyd', skills: ['a', 'b', 'c'], resumeFile: 'cv.pdf' },
    { name: 'A', email: 'a@x', phone: '9', location: 'Hyd', summary: 'x'.repeat(30), education: 'B.Tech', skills: ['a', 'b', 'c'],
      projects: [{ name: 'p' }], currentCompany: 'Q', certifications: ['c'], languages: ['en'], preferredRole: 'dev',
      preferredLocation: 'Hyd', noticePeriod: '30', expectedCtc: 5, preferredWorkModes: ['Hybrid'], immediateJoiner: true,
      willingToRelocate: false, resumeFile: 'cv.pdf', linkedin: 'li' },
  ];
  for (const c of samples) assert.equal(profileScore(c).percent, capCompletion(c), JSON.stringify(c).slice(0, 80));
  assert.equal(profileScore(samples[2]).percent, 100);
});

test('teardown', async () => {
  await new Promise((r) => server.close(r));
  await dbh.stop();
});
