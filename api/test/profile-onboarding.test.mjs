/**
 * "Build your profile" (0124), against a real Postgres with RLS on.
 *
 *   - the state is on the server: not_started -> in_progress (step + draft) -> completed, per candidate
 *   - only the candidate themself reads or moves it; "completed" cannot be set by a progress save and a
 *     stale tab cannot move a finished profile back
 *   - a resume is kept and READ; reading it changes no profile column (nothing is saved before Confirm)
 *   - replacing a resume replaces it (one file), removing it removes it
 *   - Finish saves everything the candidate confirmed in ONE transaction, validates the six additional
 *     details (keeping the ones already given), and a retry never duplicates a job, qualification or project
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb, applyTestEnv, makeClient } from './harness.mjs';
import { makeDocx } from '../../tools/lib/docx.mjs';

const DB_PORT = 5483;
const API_PORT = 9983;

let dbh, server, base, raw;
let seq = 0;
const uniq = () => `${Date.now().toString(36)}${++seq}`;
const mobile = () => '9' + String(100000000 + Math.floor(Math.random() * 899999999));
const SIMPLE = { password: 'Onboard3ing9pass', confirmPassword: 'Onboard3ing9pass', consent: { terms: true, communication: false, resumeProcessing: true } };

async function client() {
  const c = makeClient(base);
  await c.get('/api/health');
  return c;
}

/* a candidate as the simplified registration makes one: no location, preferences or notice period */
async function newCandidate({ prefs = false } = {}) {
  const c = await client();
  const email = `onb.${uniq()}@mailbox-teamlink-tests.in`;
  const d = await c.post('/api/registration/drafts', { noResume: true });
  assert.equal(d.status, 201, JSON.stringify(d.body));
  const h = { headers: { 'x-draft-token': d.body.draftToken } };
  const s = await c.post(`/api/registration/drafts/${d.body.draftId}/email-code`, { email }, h);
  assert.equal(s.status, 200, JSON.stringify(s.body));
  const v = await c.post(`/api/registration/drafts/${d.body.draftId}/verify-email`, { email, code: s.body.devCode }, h);
  assert.equal(v.status, 200, JSON.stringify(v.body));
  /* the registration page requires preferred location, notice period and salary */
  const reg = await c.post('/api/auth/register', { name: 'Onboard Person', email, phone: mobile(), ...SIMPLE,
    preferredLocation: 'Pune', expectedCtc: 7, noticePeriod: '30 days', preferredWorkModes: ['Hybrid'],
    draftId: d.body.draftId, draftToken: d.body.draftToken });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  c.id = reg.body.candidateId;
  /* without prefs: a candidate as the Talent Pool adds one (a recruiter, a CV import) - none of the details given */
  if (!prefs) {
    await raw(`update candidates set location = null, preferred_location = null, notice_period = null, expected_ctc = null,
                 preferred_work_modes = '{}', preferred_role = null where id = $1`, [c.id]);
  }
  c.email = email;
  return c;
}

const docxForm = (lines, name = 'resume.docx') => {
  const fd = new FormData();
  fd.append('resume', new Blob([makeDocx(lines)]), name);
  return fd;
};

const RESUME_LINES = [
  'PRIYA SHARMA', 'priya.sharma.dev@gmail.com | +91 98765 43210', 'Hyderabad', '',
  'EDUCATION', 'B.Sc (Statistics), Osmania University, 2021, 78%', 'Intermediate (MPC), Narayana College, 2018', '',
  'WORK EXPERIENCE',
  'ABC Technologies Pvt Ltd - Data Analyst (Jul 2022 - Present)', '• Built dashboards in Power BI.', '• Automated Excel reports.',
  'Infotech Systems - Associate Analyst (Jun 2021 - Jun 2022)', '• Cleaned SQL data.', '',
  'PROJECTS', '- Student Management System', '- Personal Portfolio Website', '',
  'SKILLS', 'SQL, Excel, Python, sql',
];

const DETAILS = { location: 'Hyderabad', preferredLocation: 'Hyderabad, Pune', noticePeriod: '30 days', expectedCtc: 8.5,
  preferredRole: 'Data Analyst', preferredWorkModes: ['Hybrid', 'Remote'] };

test('boot', async () => {
  dbh = await startTestDb(DB_PORT);
  applyTestEnv(dbh.url, {
    PUBLIC_ORIGIN: `http://127.0.0.1:${API_PORT}`,
    DISABLE_BACKGROUND_WORK: 'true',
    EMAIL_API_KEY: '', EMAIL_SMTP_HOST: '', EMAIL_SMTP_USER: '', EMAIL_SMTP_PASS: '',
    EMAILJS_SERVICE_ID: '', EMAILJS_TEMPLATE_ID: '', EMAILJS_PUBLIC_KEY: '', EMAILJS_PRIVATE_KEY: '',
    OUTBOUND_ALLOWLIST: '', REGISTRATION_CONSENT_REQUIRED: '', AI_API_KEY: '',
    REGISTRATION_PHONE_VERIFY: 'false', SMS_API_KEY: '',
  });
  raw = (sql, params) => dbh.db.query(sql, params);
  const { createApp } = await import('../src/app.js');
  const app = createApp({ logger: { error() {}, log() {} } });
  await new Promise((r) => { server = app.listen(API_PORT, r); });
  base = `http://127.0.0.1:${API_PORT}`;
});

test('a new candidate has not started; progress and the draft are kept on the server', async () => {
  const c = await newCandidate();
  const s0 = await c.get(`/api/candidates/${c.id}/onboarding`);
  assert.equal(s0.status, 200, JSON.stringify(s0.body));
  assert.deepEqual([s0.body.status, s0.body.step, s0.body.draft], ['not_started', 0, null]);

  const put = await c.put(`/api/candidates/${c.id}/onboarding`, { status: 'in_progress', step: 2, draft: { form: { skills: ['SQL'] }, note: 'x' } });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(put.body.status, 'in_progress');

  /* "after a refresh or a sign-in on another device": a brand new client signs in and reads it */
  const again = await makeClient(base);
  await again.get('/api/health');
  const login = await again.post('/api/auth/login', { email: c.email, password: SIMPLE.password, role: 'candidate' });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  const s1 = await again.get(`/api/candidates/${c.id}/onboarding`);
  assert.deepEqual([s1.body.status, s1.body.step, s1.body.draft.form.skills], ['in_progress', 2, ['SQL']]);

  /* the status also rides on the candidate record the pages already read */
  const row = (await raw(`select onboarding_status, onboarding_step from candidates where id=$1`, [c.id])).rows[0];
  assert.deepEqual(row, { onboarding_status: 'in_progress', onboarding_step: 2 });
});

test('"Later" is remembered as skipped, and a progress save cannot say completed', async () => {
  const c = await newCandidate();
  const later = await c.put(`/api/candidates/${c.id}/onboarding`, { status: 'skipped' });
  assert.equal(later.body.status, 'skipped');
  const bad = await c.put(`/api/candidates/${c.id}/onboarding`, { status: 'completed' });
  assert.equal(bad.status, 400);
  assert.equal((await c.get(`/api/candidates/${c.id}/onboarding`)).body.status, 'skipped');
});

test('only the candidate themself reads or moves it', async () => {
  const a = await newCandidate();
  const b = await newCandidate();
  assert.equal((await b.get(`/api/candidates/${a.id}/onboarding`)).status, 403);
  assert.equal((await b.put(`/api/candidates/${a.id}/onboarding`, { status: 'skipped' })).status, 403);
  assert.equal((await b.post(`/api/candidates/${a.id}/onboarding/complete`, DETAILS)).status, 403);
  const anon = await client();
  assert.equal((await anon.get(`/api/candidates/${a.id}/onboarding`)).status, 401);
});

test('a resume is kept and read - and reading it changes nothing on the profile', async () => {
  const c = await newCandidate();
  const up = await c.post(`/api/candidates/${c.id}/onboarding/resume`, docxForm(RESUME_LINES, 'priya.docx'));
  assert.equal(up.status, 201, JSON.stringify(up.body));
  assert.equal(up.body.resume.fileName, 'priya.docx');
  assert.equal(up.body.parse.ok, true);
  const f = up.body.parse.fields;
  assert.equal(f.name, 'Priya Sharma');
  assert.deepEqual(f.skills, ['SQL', 'Excel', 'Python']);
  assert.equal(f.projects.length, 2, 'two projects are two');
  assert.equal(f.employmentHistory.length, 2, 'bullets are not jobs');
  assert.match(f.employmentHistory[0].details, /dashboards.*Excel reports/);
  assert.ok(Array.isArray(up.body.parse.needsVerification));

  const row = (await raw(`select resume_file, resume_storage_path, skills, title, current_company, name from candidates where id=$1`, [c.id])).rows[0];
  assert.equal(row.resume_file, 'priya.docx');
  assert.ok(row.resume_storage_path);
  assert.deepEqual(row.skills, [], 'nothing read from the resume was written to the profile');
  assert.equal(row.title, null);
  assert.equal(row.name, 'Onboard Person', 'their own name is not overwritten');
  assert.equal((await raw(`select count(*)::int as n from candidate_experience where candidate_id=$1`, [c.id])).rows[0].n, 0);
  assert.equal((await raw(`select count(*)::int as n from candidate_education where candidate_id=$1`, [c.id])).rows[0].n, 0);
});

test('the resume already on file can be read again without writing anything', async () => {
  const c = await newCandidate();
  const none = await c.post(`/api/candidates/${c.id}/onboarding/read`, {});
  assert.equal(none.status, 400, 'nothing on file to read');
  await c.post(`/api/candidates/${c.id}/onboarding/resume`, docxForm(RESUME_LINES, 'priya.docx'));
  await raw(`update candidates set skills='{}' where id=$1`, [c.id]);
  const read = await c.post(`/api/candidates/${c.id}/onboarding/read`, {});
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.deepEqual(read.body.parse.fields.skills, ['SQL', 'Excel', 'Python']);
  assert.deepEqual((await raw(`select skills from candidates where id=$1`, [c.id])).rows[0].skills, []);
});

test('replace keeps one resume; remove removes it; other file types are refused', async () => {
  const c = await newCandidate();
  await c.post(`/api/candidates/${c.id}/onboarding/resume`, docxForm(RESUME_LINES, 'first.docx'));
  const second = await c.post(`/api/candidates/${c.id}/onboarding/resume`, docxForm(['MEERA IYER', 'SKILLS', 'MATLAB'], 'second.docx'));
  assert.equal(second.status, 201);
  assert.equal((await raw(`select resume_file from candidates where id=$1`, [c.id])).rows[0].resume_file, 'second.docx');

  const fd = new FormData();
  fd.append('resume', new Blob(['plain text resume']), 'resume.txt');
  const txt = await c.post(`/api/candidates/${c.id}/onboarding/resume`, fd);
  assert.equal(txt.status, 415);
  assert.equal((await raw(`select resume_file from candidates where id=$1`, [c.id])).rows[0].resume_file, 'second.docx', 'a refused file changes nothing');

  const gone = await c.del(`/api/candidates/${c.id}/onboarding/resume`);
  assert.equal(gone.status, 200, JSON.stringify(gone.body));
  const row = (await raw(`select resume_file, resume_storage_path from candidates where id=$1`, [c.id])).rows[0];
  assert.deepEqual(row, { resume_file: null, resume_storage_path: null });
});

test('Finish: the six details are required unless already given; everything is saved once, and a retry makes no duplicates', async () => {
  const c = await newCandidate();
  const form = {
    name: 'Priya Sharma', title: 'Data Analyst', currentCompany: 'ABC Technologies Pvt Ltd', expYears: 3,
    summary: 'Analyst who likes clean data.',
    skills: ['SQL', 'Excel', 'sql', 'Python'], certifications: ['Power BI'], languages: ['English'],
    projects: [{ name: 'Student Management System', description: 'Attendance and marks' }, { name: 'student management system', description: '' }],
    educationRecords: [{ qualification: 'B.Sc', specialization: 'Statistics', institution: 'Osmania University', passingYear: '2021', score: '78%' }],
    experienceRecords: [{ company: 'ABC Technologies Pvt Ltd', jobTitle: 'Data Analyst', employmentType: 'Jul 2022 - Present', responsibilities: 'Dashboards' },
      { company: 'Infotech Systems', jobTitle: 'Associate Analyst', employmentType: 'Jun 2021 - Jun 2022', responsibilities: '' }],
  };
  /* without the additional details: refused, field by field, and nothing is written */
  const short = await c.post(`/api/candidates/${c.id}/onboarding/complete`, form);
  assert.equal(short.status, 400, JSON.stringify(short.body));
  for (const k of ['location', 'preferredLocation', 'noticePeriod', 'expectedCtc', 'preferredRole', 'preferredWorkModes']) {
    assert.ok(short.body.error.details[k], k);
  }
  assert.equal((await raw(`select count(*)::int as n from candidate_experience where candidate_id=$1`, [c.id])).rows[0].n, 0);
  assert.notEqual((await c.get(`/api/candidates/${c.id}/onboarding`)).body.status, 'completed');

  const full = { ...form, ...DETAILS };
  const ok = await c.post(`/api/candidates/${c.id}/onboarding/complete`, full);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.status, 'completed');
  const again = await c.post(`/api/candidates/${c.id}/onboarding/complete`, full);
  assert.equal(again.status, 200, 'a retry is fine');

  const row = (await raw(`select * from candidates where id=$1`, [c.id])).rows[0];
  assert.equal(row.name, 'Priya Sharma');
  assert.equal(row.title, 'Data Analyst');
  assert.equal(row.current_company, 'ABC Technologies Pvt Ltd');
  assert.deepEqual(row.skills, ['SQL', 'Excel', 'Python'], 'case-insensitive duplicates collapse');
  assert.equal(row.location, 'Hyderabad');
  assert.equal(row.preferred_location, 'Hyderabad, Pune');
  assert.equal(row.notice_period, '30 days');
  assert.equal(Number(row.expected_ctc), 8.5);
  assert.equal(row.preferred_role, 'Data Analyst');
  assert.deepEqual(row.preferred_work_modes, ['Hybrid', 'Remote']);
  assert.equal(row.projects.length, 1, 'the same project twice is one');
  assert.equal(row.onboarding_status, 'completed');
  assert.equal(row.onboarding_draft, null, 'the draft goes once the profile is saved');
  assert.ok(row.onboarding_completed_at);
  assert.equal((await raw(`select count(*)::int as n from candidate_experience where candidate_id=$1`, [c.id])).rows[0].n, 2);
  assert.equal((await raw(`select count(*)::int as n from candidate_education where candidate_id=$1`, [c.id])).rows[0].n, 1);

  /* a stale tab cannot reopen a finished profile */
  const stale = await c.put(`/api/candidates/${c.id}/onboarding`, { status: 'in_progress', step: 1 });
  assert.equal(stale.body.status, 'completed');
});

test('details already given at registration are not asked again, and not lost', async () => {
  const c = await newCandidate({ prefs: true });
  const ok = await c.post(`/api/candidates/${c.id}/onboarding/complete`, { location: 'Pune', preferredRole: 'Accountant', skills: ['Tally'] });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const row = (await raw(`select preferred_location, notice_period, expected_ctc, preferred_work_modes, skills from candidates where id=$1`, [c.id])).rows[0];
  assert.equal(row.preferred_location, 'Pune');
  assert.equal(row.notice_period, '30 days');
  assert.equal(Number(row.expected_ctc), 7);
  assert.deepEqual(row.preferred_work_modes, ['Hybrid']);
  assert.deepEqual(row.skills, ['Tally']);
});

test('an out-of-range salary is refused', async () => {
  const c = await newCandidate();
  const bad = await c.post(`/api/candidates/${c.id}/onboarding/complete`, { ...DETAILS, expectedCtc: 5000 });
  assert.equal(bad.status, 400);
  const zero = await c.post(`/api/candidates/${c.id}/onboarding/complete`, { ...DETAILS, expectedCtc: 0 });
  assert.equal(zero.status, 400);
});

test('teardown', async () => {
  await new Promise((r) => server.close(r));
  const { stopBackgroundWork } = await import('../src/app.js');
  stopBackgroundWork();
  const { closePool } = await import('../src/db.js');
  await closePool();
  await dbh.stop();
});
