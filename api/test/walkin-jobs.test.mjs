/**
 * Walk-in is a job type (0106) and the one application form, end to end
 * against a real Postgres with RLS on.
 *
 * Self-contained: its own company, recruiter, admin, jobs and candidates.
 * Nothing leaves the machine: email and SMS go to the mock provider, the
 * mock records what it was handed, and the assertions read that.
 *
 * Acceptance tests (specs/Walkin-Job-Type-Task.md §21) covered here at the
 * API level: 1, 2, 3, 5, 6, 7, 11, 13, 15, 16, 17, 19, 22 (server side),
 * 23, plus the confirmation (13.1), the cancellation notice (13.4), the
 * drive -> job migration and the removed routes. (Share, §15, is the lead's.)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb, applyTestEnv, makeClient, startMockProvider } from './harness.mjs';

const DB_PORT = 5461;
const API_PORT = 9981;
const MOCK_PORT = 9861;

let dbh, server, mock, base, raw, notices, recruiter, admin;
const IST = 330 * 60 * 1000;
const istDay = (plus = 0) => new Date(Date.now() + IST + plus * 86400000).toISOString().slice(0, 10);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
let phoneSeq = 0;
const phone = () => `98765${String(43210 + (++phoneSeq)).padStart(5, '0')}`;

const WALKIN = (over = {}) => ({
  title: 'Software Engineer Walk-in', companyId: 'co_wk', location: 'Hyderabad', mode: 'Onsite',
  exp: '2+ yrs', pay: '₹4–6 LPA', type: 'Walk-in', postingKind: 'walkin', status: 'open', skills: ['Java'],
  gender: 'Female', walkinDate: istDay(5), walkinFrom: '10:00', walkinTo: '16:00',
  walkinVenue: 'TeamLink Office, 3rd floor', walkinAddress: 'Road No. 1, Banjara Hills, Hyderabad 500034',
  walkinMapLink: 'https://maps.google.com/?q=TeamLink', walkinContact: 'Ravi Kumar', walkinPhone: '9876500011',
  walkinDocuments: 'Updated resume\nPhoto ID', walkinInstructions: 'Report 15 minutes early.',
  ...over,
});

async function candidate(name) {
  const c = makeClient(base);
  await c.get('/api/health');
  c.email = `${name.toLowerCase().replace(/\W+/g, '.')}.${Date.now().toString(36)}@tl-sink.local`;
  c.phone = phone();
  const r = await c.post('/api/auth/register', {
    name, email: c.email, password: 'Walkin123jobs', phone: c.phone,
    preferredLocation: 'Hyderabad', expectedCtc: 4, noticePeriod: 'Immediate', preferredWorkModes: ['Work From Office'],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  c.id = r.body.candidateId;
  c.name = name;
  return c;
}
async function uploadResume(c, name = 'resume.pdf', buf = PDF) {
  const fd = new FormData();
  fd.append('purpose', 'apply');
  fd.append('resume', new Blob([buf]), name);
  return c.post('/api/uploads/resume', fd);
}
const form = (c, jobId, over = {}) => ({
  jobId, name: c.name, mobile: c.phone, email: c.email, currentLocation: 'Hyderabad', preferredLocation: '',
  qualification: 'B.Tech/B.E', specialization: 'Computer Science', experienceYears: 2, currentSalary: '3 LPA',
  expectedSalary: 5, noticePeriod: '30 days', ...over,
});

test('boot', async () => {
  dbh = await startTestDb(DB_PORT);
  mock = await startMockProvider(MOCK_PORT);
  applyTestEnv(dbh.url, {
    PUBLIC_ORIGIN: `http://127.0.0.1:${API_PORT}`,
    DISABLE_BACKGROUND_WORK: 'true',
    SMS_API_URL: `http://127.0.0.1:${MOCK_PORT}/sms`,
    WHATSAPP_API_KEY: '',
    EMAIL_API_KEY: 'test-key',
    EMAIL_FROM: 'jobs@teamlink.example',
    EMAIL_API_URL: `http://127.0.0.1:${MOCK_PORT}/email`,
    EMAIL_SMTP_HOST: '', EMAIL_SMTP_USER: '', EMAIL_SMTP_PASS: '',
    EMAILJS_SERVICE_ID: '', EMAILJS_TEMPLATE_ID: '', EMAILJS_PUBLIC_KEY: '', EMAILJS_PRIVATE_KEY: '',
    OUTBOUND_ALLOWLIST: '',
    APPLY_RATE_PER_HOUR: '500',
  });
  raw = (sql, params) => dbh.db.query(sql, params);
  const { hashPassword } = await import('../src/auth.js');
  const hash = await hashPassword('Staff123pass');
  await raw(`insert into companies (id, name) values ('co_wk', 'Walkin Works Pvt Ltd')`);
  const ru = (await raw(`insert into users (email,password_hash,role) values ('rwk@tl-sink.local',$1,'recruiter') returning id`, [hash])).rows[0].id;
  await raw(`insert into recruiters (id, name, email, company_id, user_id) values ('rwk1','Rec WK','rwk@tl-sink.local','co_wk',$1)`, [ru]);
  const au = (await raw(`insert into users (email,password_hash,role) values ('awk@tl-sink.local',$1,'admin') returning id`, [hash])).rows[0].id;
  await raw(`insert into admins (id, name, email, user_id) values ('awk1','Admin WK','awk@tl-sink.local',$1)`, [au]);

  const { createApp } = await import('../src/app.js');
  notices = await import('../src/notify/walkin-jobs.js');
  const app = createApp({ logger: { error() {}, log() {} } });
  await new Promise((r) => { server = app.listen(API_PORT, r); });
  base = `http://127.0.0.1:${API_PORT}`;
  recruiter = makeClient(base);
  await recruiter.get('/api/health');
  assert.equal((await recruiter.post('/api/auth/login', { email: 'rwk@tl-sink.local', password: 'Staff123pass', role: 'recruiter' })).status, 200);
  admin = makeClient(base);
  await admin.get('/api/health');
  assert.equal((await admin.post('/api/auth/login', { email: 'awk@tl-sink.local', password: 'Staff123pass', role: 'admin' })).status, 200);
});

let REG, WJ, WJ2;

test('1 / 23: a regular job and a job saved before job types existed both read as Regular', async () => {
  const r = await recruiter.post('/api/jobs', { title: 'Store Associate', companyId: 'co_wk', location: 'Hyderabad', exp: '1-3 yrs', type: 'Full-time', status: 'open', gender: 'Male' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  REG = r.body.job.id;
  assert.equal(r.body.job.jobType, 'regular');
  assert.equal(r.body.job.walkinStatus, undefined, 'a regular job carries no walk-in keys');
  await raw(`insert into jobs (id, title, company_id, status, published_at) values ('j_legacy', 'Legacy Role', 'co_wk', 'open', now())`);
  const legacy = await makeClient(base).get('/api/jobs/j_legacy');
  assert.equal(legacy.status, 200);
  assert.equal(legacy.body.job.jobType, 'regular');
});

test('4: walk-in fields are checked on the server', async () => {
  const bad = async (over, field) => {
    const r = await recruiter.post('/api/jobs', WALKIN(over));
    assert.equal(r.status, 400, `${field}: ${JSON.stringify(r.body)}`);
    assert.ok(r.body.error.details[field], `${field}: ${JSON.stringify(r.body.error.details)}`);
  };
  await bad({ walkinDate: istDay(-1) }, 'walkinDate');
  await bad({ walkinDate: '05 Oct 2026' }, 'walkinDate');
  await bad({ walkinFrom: '16:00', walkinTo: '10:00' }, 'walkinTo');
  await bad({ walkinPhone: '12345' }, 'walkinPhone');
  await bad({ walkinAddress: '' }, 'walkinAddress');
  await bad({ walkinVenue: '' }, 'walkinVenue');
  await bad({ walkinMapLink: 'javascript:alert(1)' }, 'walkinMapLink');
  const draft = await recruiter.post('/api/jobs', WALKIN({ status: 'draft', walkinDate: istDay(-3), walkinAddress: '' }));
  assert.equal(draft.status, 201, 'a draft (a clone, say) may keep an old date until it is published');
  const pub = await recruiter.post(`/api/jobs/${draft.body.job.id}/publish`, {});
  assert.equal(pub.status, 200);
});

test('2 / 3: a walk-in job is a job, with its own date, times and venue', async () => {
  const r = await recruiter.post('/api/jobs', WALKIN());
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const j = r.body.job;
  WJ = j.id;
  assert.equal(j.jobType, 'walk-in');
  assert.equal(j.walkinStatus, 'open');
  assert.equal(j.walkinDate, istDay(5));
  assert.equal(j.walkinStartTime, '10:00');
  assert.equal(j.walkinEndTime, '16:00');
  assert.equal(j.walkinVenue, 'TeamLink Office, 3rd floor');
  assert.equal(j.walkinAddress, 'Road No. 1, Banjara Hills, Hyderabad 500034');
  assert.equal(j.walkinContactPerson, 'Ravi Kumar');
  assert.equal(j.walkinContactNumber, '9876500011');
  assert.equal(j.walkinDocumentsToCarry, 'Updated resume\nPhoto ID');
  assert.equal(j.walkinFrom, '10:00', 'the 0083 names stay for older readers');
  const board = await makeClient(base).get('/api/jobs');
  assert.ok(board.body.jobs.some((x) => x.id === WJ), 'on the ordinary job board');
});

test('11: the ordinary search finds a walk-in job', async () => {
  const r = await makeClient(base).get('/api/jobs?q=Software%20Engineer');
  assert.ok(r.body.jobs.some((x) => x.id === WJ));
  const chip = await makeClient(base).get('/api/jobs?quick=walkin&ids=1');
  assert.ok(chip.body.ids.includes(WJ));
  assert.equal(chip.body.ids.includes(REG), false);
  const week = await makeClient(base).get('/api/jobs?quick=walkin_week&ids=1');
  assert.equal(week.status, 200);
  const today = await recruiter.post('/api/jobs', WALKIN({ title: 'Today Walk-in', walkinDate: istDay(0), walkinFrom: '00:00', walkinTo: '23:59' }));
  assert.equal(today.status, 201, JSON.stringify(today.body));
  const t = await makeClient(base).get('/api/jobs?quick=walkin_today&ids=1');
  assert.deepEqual(t.body.ids, [today.body.job.id]);
});

let A, B;

test('16: the form refuses bad input and saves nothing', async () => {
  A = await candidate('Asha Rao');
  B = await candidate('Bala Krishna');
  let r = await A.post('/api/applications/form', form(A, WJ));
  assert.equal(r.status, 400, 'no resume yet');
  assert.ok(r.body.error.details.resume);
  r = await uploadResume(A, 'cv.txt', Buffer.from('plain text resume'));
  assert.equal(r.status, 415, 'the form takes PDF, DOC or DOCX only');
  r = await uploadResume(A, 'cv.exe', Buffer.from('MZ\x90\x00binary'));
  assert.ok(r.status === 415 || r.status === 400, 'an executable is refused: ' + r.status);
  r = await uploadResume(A, 'big.pdf', Buffer.concat([PDF, Buffer.alloc(6 * 1024 * 1024, 32)]));
  assert.equal(r.status, 413, 'over 5 MB');
  r = await uploadResume(A);
  assert.equal(r.status, 201, JSON.stringify(r.body));

  r = await A.post('/api/applications/form', form(A, WJ, { mobile: '12345' }));
  assert.equal(r.status, 400);
  assert.ok(r.body.error.details.mobile);
  r = await A.post('/api/applications/form', form(A, WJ, { email: 'not-an-email' }));
  assert.equal(r.status, 400);
  assert.ok(r.body.error.details.email);
  r = await A.post('/api/applications/form', form(A, WJ, { name: '' }));
  assert.equal(r.status, 400);
  r = await A.post('/api/applications/form', form(A, WJ, { website: 'http://spam.example' }));
  assert.equal(r.status, 400, 'the honeypot');
  const n = (await raw(`select count(*)::int n from applications where candidate_id=$1`, [A.id])).rows[0].n;
  assert.equal(n, 0, 'nothing was saved');
});

let APP_A;

test('5 / 6 / 13.1: submit -> an application against the right job, with an Application ID and the walk-in confirmation', async () => {
  const sent = mock.received.length;
  const r = await A.post('/api/applications/form', form(A, WJ, { currentLocation: 'Secunderabad' }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const a = r.body.application;
  APP_A = a;
  assert.equal(a.jobId, WJ);
  assert.equal(a.candidateId, A.id);
  assert.equal(a.postingType, 'walkin');
  assert.match(a.reference, /^TL-APP-\d{4}-\d{5}$/);
  assert.ok(['registered', 'applied'].includes(a.stage), `initial stage ${a.stage} (registered once 0107's walk-in stages exist)`);
  assert.equal(r.body.form.jobType, 'walk-in');
  assert.ok(r.body.form.profileUpdated.includes('location'));
  const row = (await raw(`select * from application_form_details where application_id=$1`, [a.id])).rows[0];
  assert.equal(row.job_type, 'walk-in');
  assert.equal(row.current_location, 'Secunderabad');
  assert.equal(row.specialization, 'Computer Science');
  const cand = (await raw(`select location, preferred_location, notice_period, exp_years from candidates where id=$1`, [A.id])).rows[0];
  assert.equal(cand.location, 'Secunderabad', 'a newer value is saved');
  assert.equal(cand.preferred_location, 'Hyderabad', 'an empty box never wipes a saved value');
  assert.equal(cand.notice_period, '30 days');
  assert.equal(Number(cand.exp_years), 2);

  // the recruiter's view of the job's applicants
  const list = await recruiter.get(`/api/applications?jobId=${WJ}`);
  assert.ok(list.body.applications.some((x) => x.id === a.id), 'the recruiter sees it');
  // the candidate's confirmation carries the Application ID and the walk-in details
  const out = mock.received.slice(sent).map((m) => JSON.stringify(m.body)).join('\n');
  assert.ok(out.includes(a.reference), 'the Application ID is in the confirmation');
  assert.ok(out.includes('TeamLink Office, 3rd floor'), 'the venue is in the confirmation');
  assert.ok(out.includes('Banjara Hills'), 'the address is in the confirmation');
  assert.ok(out.includes('Ravi Kumar'), 'the contact person is in the confirmation');
  assert.ok(/Walk-in/i.test(out));
});

test('7: applying again is refused with the existing Application ID', async () => {
  const r = await A.post('/api/applications/form', form(A, WJ));
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'DUPLICATE_APPLICATION');
  assert.equal(r.body.error.message, 'You have already applied for this position.');
  assert.equal(r.body.error.details.applicationId, APP_A.reference);
  const n = (await raw(`select count(*)::int n from applications where candidate_id=$1 and job_id=$2`, [A.id, WJ])).rows[0].n;
  assert.equal(n, 1);
});

test('15: the same person on two jobs is one candidate with two applications', async () => {
  const r = await A.post('/api/applications/form', form(A, REG));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.application.candidateId, A.id);
  assert.equal(r.body.application.postingType, 'job');
  assert.equal(r.body.form.jobType, 'regular');
  const rows = (await raw(`select job_id from applications where candidate_id=$1 order by job_id`, [A.id])).rows;
  assert.equal(rows.length, 2);
  assert.equal((await raw(`select count(*)::int n from candidates where id=$1`, [A.id])).rows[0].n, 1);
});

test('17: two submissions at once make one application', async () => {
  await uploadResume(B);
  const [x, y] = await Promise.all([
    B.post('/api/applications/form', form(B, WJ)),
    B.post('/api/applications/form', form(B, WJ)),
  ]);
  const st = [x.status, y.status].sort();
  assert.deepEqual(st, [201, 409], JSON.stringify([x.body, y.body]));
  const n = (await raw(`select count(*)::int n from applications where candidate_id=$1 and job_id=$2`, [B.id, WJ])).rows[0].n;
  assert.equal(n, 1);
});

test('19: slot capacity is decided at save time - "Registrations full", never overbooked', async () => {
  const r = await recruiter.post('/api/jobs', WALKIN({ title: 'Capacity Walk-in', walkinCapacity: 2 }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  WJ2 = r.body.job.id;
  assert.equal(r.body.job.walkinSlotCapacity, 2);
  const people = [A, B, await candidate('Chitra Devi'), await candidate('Dinesh Rao')];
  for (const p of people.slice(2)) await uploadResume(p);
  const res = await Promise.all(people.map((p) => p.post('/api/applications/form', form(p, WJ2))));
  const ok = res.filter((x) => x.status === 201).length;
  const full = res.filter((x) => x.status === 409 && x.body.error.code === 'WALKIN_FULL');
  assert.equal(ok, 2, JSON.stringify(res.map((x) => [x.status, x.body.error && x.body.error.code])));
  assert.equal(full.length, 2);
  assert.match(full[0].body.error.message, /Registrations full/);
  const n = (await raw(`select count(*)::int n from applications where job_id=$1`, [WJ2])).rows[0].n;
  assert.equal(n, 2, 'never more than the capacity');
  const job = await people[3].get(`/api/jobs/${WJ2}`);
  assert.equal(job.body.job.walkinFull, true);
  assert.equal(job.body.job.walkinSlotsLeft, 0);
  // and the capacity cannot be cut below the people already registered
  const cut = await recruiter.put(`/api/jobs/${WJ2}`, { ...WALKIN({ title: 'Capacity Walk-in' }), walkinCapacity: 1 });
  assert.equal(cut.status, 400);
  assert.ok(cut.body.error.details.walkinCapacity);
});

test('13 / 14: a walk-in whose date has passed is Closed; editing the date reopens it', async () => {
  await raw(`insert into jobs (id, title, company_id, recruiter_id, status, posting_kind, employment_type, walkin_date,
                               walkin_from, walkin_to, walkin_venue, published_at)
             values ('j_wk_past', 'Past Walk-in', 'co_wk', 'rwk1', 'open', 'walkin', 'Walk-in', $1, '10:00', '16:00', 'Old Venue', now())`,
    [istDay(-2)]);
  const C = await candidate('Esha Past');
  await uploadResume(C);
  let j = await C.get('/api/jobs/j_wk_past');
  assert.equal(j.status, 200, 'the job page still opens');
  assert.equal(j.body.job.walkinStatus, 'closed');
  const board = await C.get('/api/jobs');
  assert.equal(board.body.jobs.some((x) => x.id === 'j_wk_past'), false, 'not in the default listing');
  const r = await C.post('/api/applications/form', form(C, 'j_wk_past'));
  assert.equal(r.status, 409);
  assert.equal(r.body.error.details.reason, 'walkin_closed');
  const staff = await recruiter.get('/api/jobs?view=all');
  assert.ok(staff.body.jobs.some((x) => x.id === 'j_wk_past'), 'the recruiter still sees it');
  const moved = await recruiter.put('/api/jobs/j_wk_past', {
    title: 'Past Walk-in', companyId: 'co_wk', postingKind: 'walkin', status: 'open', walkinDate: istDay(3),
    walkinFrom: '10:00', walkinTo: '16:00', walkinVenue: 'New Venue', walkinAddress: '12 Main Road, Hyderabad',
    walkinContact: 'Ravi', walkinPhone: '9876500011',
  });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.job.walkinStatus, 'open');
  j = await C.get('/api/jobs/j_wk_past');
  assert.equal(j.body.job.walkinVenue, 'New Venue', 'the info updates');
  const back = await recruiter.put('/api/jobs/j_wk_past', { title: 'Past Walk-in', companyId: 'co_wk', walkinDate: istDay(-1) });
  assert.equal(back.status, 400, 'a date cannot be moved into the past');
});

test('10 (server): a mobile + email of another account -> sign in with it; split details -> a recruiter review', async () => {
  const D = await candidate('Farah Other');
  const E = await candidate('Gopal Split');
  await uploadResume(E);
  let r = await E.post('/api/applications/form', form(E, REG, { mobile: D.phone, email: D.email }));
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'IDENTITY_OTHER_ACCOUNT');
  assert.equal(JSON.stringify(r.body).includes(D.id), false, 'the other account is not named');
  assert.equal((await raw(`select count(*)::int n from applications where candidate_id=$1`, [E.id])).rows[0].n, 0);

  r = await E.post('/api/applications/form', form(E, REG, { mobile: D.phone }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.application.candidateId, E.id, 'saved against the signed-in candidate, never merged');
  assert.equal(r.body.form.identityReview, true);
  const phoneNow = (await raw(`select phone from candidates where id=$1`, [E.id])).rows[0].phone;
  assert.equal(phoneNow, E.phone, 'another person\'s number is not copied onto this profile');
  const rev = await recruiter.get(`/api/candidate-identity-reviews?applicationId=${r.body.application.id}`);
  assert.equal(rev.status, 200);
  assert.equal(rev.body.reviews.length, 1);
  assert.deepEqual(rev.body.reviews[0].mobileCandidateIds, [D.id]);
  assert.deepEqual(rev.body.reviews[0].emailCandidateIds, [E.id]);
  assert.equal((await E.get('/api/candidate-identity-reviews')).status, 403, 'a candidate never reads reviews');
});

test('13.4: closing a walk-in before its date tells its applicants, once', async () => {
  const before = mock.received.length;
  const r = await recruiter.put(`/api/jobs/${WJ}`, { title: 'Software Engineer Walk-in', companyId: 'co_wk', status: 'closed' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await notices.settleWalkinNotices();
  await notices.runWalkinNotices({ now: Date.UTC(2026, 9, 5, 6, 0) });   // 11:30 IST, not quiet hours
  const rows = (await raw(`select application_id, channel, status from walkin_job_notices order by id`)).rows;
  const apps = new Set(rows.map((x) => x.application_id));
  assert.ok(apps.has(APP_A.id));
  assert.ok(rows.some((x) => x.channel === 'portal' && x.status === 'sent'));
  const out = mock.received.slice(before).map((m) => JSON.stringify(m.body)).join('\n');
  assert.match(out, /cancelled/i);
  const portal = (await raw(`select count(*)::int n from notifications where candidate_id=$1 and type like 'WALKIN_CANCELLED%'`, [A.id])).rows[0].n;
  assert.equal(portal, 1);
  const again = await notices.runWalkinNotices({ now: Date.UTC(2026, 9, 5, 6, 0) });
  assert.equal(again.length, 0, 'never twice');
  assert.equal((await raw(`select count(*)::int n from walkin_job_notices`)).rows[0].n, rows.length);
});

test('20 (server): the old walk-in drives become walk-in jobs, registrations become applications', async () => {
  const P = await candidate('Hari Drive');
  const Q = await candidate('Indu Drive');
  await raw(`insert into walkin_drives (id, title, company_id, job_role, drive_date, start_time, end_time, venue_name,
                                        full_address, city, contact_person_name, contact_phone, max_seats,
                                        documents_to_carry, created_by_recruiter_id)
             values ('wd1', 'Old Drive', 'co_wk', 'Telecaller', $1, '10:00', '15:00', 'Hall A', '1 Ring Road, Nellore', 'Nellore',
                     'Sita', '9876511111', 50, '{"Resume","Aadhaar"}', 'rwk1')`, [istDay(4)]);
  await raw(`insert into walkin_registrations (id, drive_id, candidate_id, status) values ('wr1','wd1',$1,'REGISTERED'), ('wr2','wd1',$2,'CANCELLED')`, [P.id, Q.id]);
  const first = await notices.migrateWalkinDrives();
  assert.deepEqual(first, { drives: 1, applications: 1 });
  const job = (await raw(`select * from jobs where id='j_wk_wd1'`)).rows[0];
  assert.equal(job.posting_kind, 'walkin');
  assert.equal(job.walkin_date, istDay(4));
  assert.equal(job.walkin_from, '10:00');
  assert.equal(job.walkin_address, '1 Ring Road, Nellore');
  assert.equal(job.walkin_documents, 'Resume\nAadhaar');
  assert.equal(job.walkin_capacity, 50);
  const app = (await raw(`select * from applications where id='app_wk_wr1'`)).rows[0];
  assert.equal(app.candidate_id, P.id);
  assert.equal(app.posting_type, 'walkin');
  assert.equal((await raw(`select count(*)::int n from applications where candidate_id=$1`, [Q.id])).rows[0].n, 0, 'a cancelled registration is not an application');
  assert.deepEqual(await notices.migrateWalkinDrives(), { drives: 0, applications: 0 }, 'once');
  assert.equal((await raw(`select count(*)::int n from walkin_drives`)).rows[0].n, 1, 'the old rows are kept');
});

test('12 (server): the Walk-in Drives routes are gone', async () => {
  for (const p of ['/api/public/walkin-drives', '/api/walkin-drives', '/api/recruiter/walkin-drives']) {
    const r = await recruiter.get(p);
    assert.equal(r.status, 404, p);
  }
});

test('the per-mobile limit stops a flood with one number', async () => {
  process.env.APPLY_FORM_CONTACT_PER_HOUR = '2';
  try {
    const F = await candidate('Jaya Limit');
    await uploadResume(F);
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await F.post('/api/applications/form', form(F, 'nope_' + i, { mobile: '9123400000' }))).status);
    assert.equal(statuses[2], 429, statuses.join(','));
  } finally { delete process.env.APPLY_FORM_CONTACT_PER_HOUR; }
});

test('shutdown', async () => {
  await notices.settleWalkinNotices();
  await new Promise((r) => server.close(r));
  await mock.stop();
  await dbh.stop();
});
