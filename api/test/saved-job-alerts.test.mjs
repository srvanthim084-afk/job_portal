/**
 * "New job like one you saved" (0110), end to end against a real Postgres
 * with RLS on.
 *
 * Self-contained: makes its own company, recruiter, jobs and candidates.
 * Nothing leaves the machine - email goes to the mock provider through
 * EMAIL_API_URL (SMTP, EmailJS, SMS and WhatsApp are all unset), and the
 * mock records what it was handed, which is what the assertions read.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb, applyTestEnv, makeClient, startMockProvider } from './harness.mjs';

const DB_PORT = 5469;
const API_PORT = 9989;
const MOCK_PORT = 9865;
const SECRET_CLIENT = 'Client Partner Hospitals';   // a name that must never reach a candidate

let dbh, server, mock, base, raw, sja, ssa, jobAlerts, portal, recruiter;

let seq = 0;
async function job(f = {}) {
  seq += 1;
  const id = f.id || `jsa${seq}`;
  await raw(`insert into jobs (id, title, company_id, recruiter_id, department, location, mode, exp_label, pay_label,
                               employment_type, status, skills, published_at, expires_at, posting_kind, paused)
             values ($1,$2,$3,'rsj1',$4,$5,'Onsite',$6,$7,'Full-time',$8,$9,$10,$11,$12,$13)`,
    [id, f.title || 'Staff Nurse', f.company || 'co_sj', f.department || null, f.location || 'Nellore',
     f.exp || '1-3 yrs', f.pay || '₹3-4 LPA', f.status || 'open', f.skills || [],
     f.status === 'draft' ? null : (f.publishedAt || new Date()), f.expiresAt || null, f.kind || 'job', !!f.paused]);
  return id;
}

async function candidate(name, extra = {}) {
  const c = makeClient(base);
  await c.get('/api/health');
  const email = `${name.toLowerCase().replace(/\W+/g, '.')}.${(seq += 1)}@tl-sink.local`;
  const r = await c.post('/api/auth/register', {
    name, email, password: 'Saved123jobs', phone: '9' + String(100000000 + Math.floor(Math.random() * 899999999)),
    preferredLocation: 'Nellore', expectedCtc: 3, noticePeriod: 'Immediate', preferredWorkModes: ['Work From Office'],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  c.id = r.body.candidateId;
  c.email = email;
  /* A thin profile: the profile-match alert never fires for it unless a test says so. */
  await raw(`update candidates set skills='{}', technical_skills='{}', title=null where id=$1`, [c.id]);
  if (extra.sql) await raw(extra.sql, [c.id]);
  return c;
}

const save = async (c, jobId) => {
  const r = await c.post(`/api/saved-jobs/${jobId}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
};
const inbox = (candId, type = 'SAVED_JOB_SIMILAR') => raw(
  `select id, title, message, job_id, metadata from notifications where recipient_id=$1 and type=$2 order by created_at`,
  [candId, type]).then((r) => r.rows);
/* 0109: registering sends the welcome email (Candidate ID); it is not a job alert. */
const allMailsTo = (email) => mock.received.filter((m) => m.url === '/email' && (m.body.to || []).includes(email)
  && !/^Welcome to TeamLink!/.test(String(m.body.subject || '')));
/* this feature's emails only - an application confirmation is not one of them */
const mailsTo = (email) => allMailsTo(email).filter((m) => /like (one|ones) you saved/.test(String(m.body.subject || '')));
const row = (candId, jobId) => raw(
  `select * from candidate_saved_job_alerts where candidate_id=$1 and job_id=$2`, [candId, jobId]).then((r) => r.rows[0]);
const notice = (candId, jobId) => raw(
  `select source from candidate_new_job_notices where candidate_id=$1 and job_id=$2`, [candId, jobId]).then((r) => r.rows[0]);

test('boot', async () => {
  dbh = await startTestDb(DB_PORT);
  mock = await startMockProvider(MOCK_PORT);
  applyTestEnv(dbh.url, {
    PUBLIC_ORIGIN: `http://127.0.0.1:${API_PORT}`,
    DISABLE_BACKGROUND_WORK: 'true',
    SMS_API_KEY: '', WHATSAPP_API_KEY: '',
    EMAIL_API_KEY: 'test-key',
    EMAIL_FROM: 'jobs@teamlink.example',
    EMAIL_API_URL: `http://127.0.0.1:${MOCK_PORT}/email`,
    EMAIL_SMTP_HOST: '', EMAIL_SMTP_USER: '', EMAIL_SMTP_PASS: '',
    EMAILJS_SERVICE_ID: '', EMAILJS_TEMPLATE_ID: '', EMAILJS_PUBLIC_KEY: '', EMAILJS_PRIVATE_KEY: '',
    OUTBOUND_ALLOWLIST: '',
    SAVED_JOB_ALERT_DAILY_CAP: '3',
    SAVED_JOB_DIGEST_HOUR_IST: '19',
    NOTIFY_MATCH_THRESHOLD: '60',
  });
  raw = (sql, params) => dbh.db.query(sql, params);

  const { hashPassword } = await import('../src/auth.js');
  const hash = await hashPassword('Staff123pass');
  await raw(`insert into companies (id, name) values ('co_sj', 'Sunrise Hospitals'), ('co_cl', $1)`, [SECRET_CLIENT]);
  const ru = (await raw(`insert into users (email,password_hash,role) values ('rsj@tl-sink.local',$1,'recruiter') returning id`, [hash])).rows[0].id;
  await raw(`insert into recruiters (id, name, email, company_id, user_id) values ('rsj1','Rec SJ','rsj@tl-sink.local','co_sj',$1)`, [ru]);

  const { createApp } = await import('../src/app.js');
  sja = await import('../src/notify/saved-job-alerts.js');
  ssa = await import('../src/notify/saved-search-alerts.js');
  jobAlerts = await import('../src/notify/job-alerts.js');
  portal = await import('../src/portal/alerts.js');
  const app = createApp({ logger: { error() {}, log() {} } });
  await new Promise((r) => { server = app.listen(API_PORT, r); });
  base = `http://127.0.0.1:${API_PORT}`;

  recruiter = makeClient(base);
  await recruiter.get('/api/health');
  assert.equal((await recruiter.post('/api/auth/login', { email: 'rsj@tl-sink.local', password: 'Staff123pass', role: 'recruiter' })).status, 200);
});

/* ------------------------------------------------------------------ *
 * related or not
 * ------------------------------------------------------------------ */

test('related: same role, similar title, shared skills - and not the rest', () => {
  const R = (title, skills = [], roleKey) => ({ title, skills, roleKey });
  assert.equal(sja.relatedJob(R('Senior Java Developer', [], 'java developer'), R('Java Developer', [], 'java developer')).reason, 'same role');
  assert.equal(sja.relatedJob(R('ICU Nurse'), R('Staff Nurse')).reason, 'similar role');
  const skills = sja.relatedJob(R('Backend Engineer', ['Java', 'Spring Boot', 'SQL', 'Kafka']), R('Java Developer', ['java', 'springboot', 'SQL']));
  assert.equal(skills.reason, 'shared skills');
  assert.match(skills.why, /Java, Spring Boot, SQL/);

  assert.equal(sja.relatedJob(R('Python Developer', ['Python', 'SQL']), R('Java Developer', ['Java', 'SQL'])).related, false, 'one shared skill is not enough');
  assert.equal(sja.relatedJob(R('Cardiologist'), R('Emergency Physician')).related, false);
  assert.equal(sja.relatedJob(R('Delivery Executive'), R('Sales Executive')).related, false, '"executive" carries no signal');
  assert.equal(sja.relatedJob(R('Store Manager'), R('Sales Manager')).related, false, 'sharing only "manager" is not the same job');
  assert.equal(sja.relatedJob(R('ICU Staff Nurse (Night Shift)'), R('Staff Nurse')).reason, 'similar role',
    'the saved title inside a longer one');
  assert.equal(sja.relatedJob(R('Java Developer', ['Java', 'Spring']), R('Java Developer (Android)', ['Kotlin', 'Android'])).related, false,
    'a similar title with no skill in common, where both list skills');
});

/* ------------------------------------------------------------------ *
 * the instant alert
 * ------------------------------------------------------------------ */

let A, savedA;

test('a related job: one inbox entry and one email naming the saved job; an unrelated job: nothing', async () => {
  A = await candidate('Anitha Rao');
  savedA = await job({ title: 'Staff Nurse', location: 'Nellore' });
  await save(A, savedA);

  const before = mock.received.length;
  const rel = await job({ title: 'ICU Staff Nurse', location: 'Nellore', pay: '₹3.5-4.5 LPA' });
  const r = await sja.runSavedJobInstant(rel);
  assert.equal(r.instant, 1, JSON.stringify(r));
  assert.equal(r.sent, 1);

  const n = await inbox(A.id);
  assert.equal(n.length, 1);
  assert.equal(n[0].title, 'New job like one you saved');
  /* the full job-opportunity message (owner, 2026-10-06); the owner's one-line wording is its summary */
  assert.equal(n[0].metadata.summary, 'New job like one you saved: ICU Staff Nurse · Nellore');
  assert.equal(n[0].metadata.format, 'job_opportunity');
  assert.match(n[0].message, /^\*🚀 NEW JOB OPPORTUNITY – Nellore\*\n\nHi! 👋 You saved "Staff Nurse" \(Sunrise Hospitals · Nellore\) on TeamLink\./);
  for (const l of ['🏥 *ICU Staff Nurse*', '🏢 *Sunrise Hospitals*', '💰 Salary: *₹3.5-4.5 LPA*', '📍 Location: *Nellore*',
    '🏠 Work From Home: Not Available', `🔗 ${process.env.PUBLIC_ORIGIN.replace(/\/$/, '')}/#/job/${rel}`]) {
    assert.ok(n[0].message.split('\n').includes(l), `inbox message is missing "${l}":\n${n[0].message}`);
  }
  assert.equal(n[0].job_id, rel);
  assert.equal(n[0].metadata.applyUrl, `#/job/${rel}`);
  assert.equal(n[0].metadata.savedJobId, savedA);
  /* the candidate reads it through the API */
  const mine = (await A.get('/api/notifications')).body.notifications;
  assert.ok(mine.some((x) => x.type === 'SAVED_JOB_SIMILAR' && x.jobId === rel));

  const mail = mailsTo(A.email);
  assert.equal(mail.length, 1);
  assert.equal(mail[0].body.subject, 'New job like one you saved: ICU Staff Nurse · Nellore');
  assert.match(mail[0].body.text, /You saved "Staff Nurse" \(Sunrise Hospitals · Nellore\)/);
  assert.match(mail[0].body.html, /Like the job you saved/);
  assert.match(mail[0].body.html, /View job &amp; apply/);
  assert.match(mail[0].body.text, new RegExp(`#/job/${rel}`));
  assert.match(mail[0].body.text, /saved-job-alerts\/stop\?token=/);
  assert.equal(mock.received.slice(before).every((m) => m.url === '/email'), true, 'the mock provider and nothing else');

  const rec = await row(A.id, rel);
  assert.equal(rec.status, 'sent');
  assert.equal(rec.kind, 'instant');
  assert.equal(rec.email_status, 'sent');
  assert.equal(rec.saved_job_id, savedA);
  assert.equal((await notice(A.id, rel)).source, 'saved_job');

  /* unrelated: a different role, nothing at all */
  const other = await job({ title: 'Electrician', skills: ['Wiring', 'Panel Boards'] });
  const u = await sja.runSavedJobInstant(other);
  assert.equal(u.related, 0);
  assert.equal(u.instant, 0);
  assert.equal(await row(A.id, other), undefined);
  assert.equal(mailsTo(A.email).length, 1);
  assert.equal((await inbox(A.id)).length, 1);
});

test('never the same job twice: again, through the sweep, and after a republish', async () => {
  const rel = (await raw(`select job_id from candidate_saved_job_alerts where candidate_id=$1`, [A.id])).rows[0].job_id;
  await sja.runSavedJobInstant(rel);
  await sja.runSavedJobSweep();
  await raw(`update jobs set status='draft' where id=$1`, [rel]);
  await raw(`update jobs set status='open' where id=$1`, [rel]);
  await sja.runSavedJobInstant(rel);
  assert.equal((await inbox(A.id)).length, 1);
  assert.equal(mailsTo(A.email).length, 1);
});

test('no client name and never the word "Client": only the label the card shows', async () => {
  const C = await candidate('Chandra Sekhar');
  const saved = await job({ title: 'Lab Technician', company: 'co_cl' });
  await save(C, saved);
  const rel = await job({ title: 'Senior Lab Technician', company: 'co_cl' });
  const r = await sja.runSavedJobInstant(rel);
  assert.equal(r.instant, 1, JSON.stringify(r));
  const [m] = mailsTo(C.email);
  const [n] = await inbox(C.id);
  const all = [m.body.subject, m.body.text, m.body.html, n.title, n.message, JSON.stringify(n.metadata)].join('\n');
  assert.equal(all.includes(SECRET_CLIENT), false, 'the client name reached the candidate');
  assert.equal(/\bclients?\b/i.test(all), false, 'the word Client reached the candidate');
  assert.match(m.body.text, /TeamLink/);
});

/* ------------------------------------------------------------------ *
 * exclusions
 * ------------------------------------------------------------------ */

test('exclusions: the saved job itself, applied, hidden, closed/expired/draft/paused, do-not-contact, saved before', async () => {
  const E = await candidate('Esther Paul');
  const saved = await job({ title: 'Pharmacist' });
  await save(E, saved);

  /* the saved job itself, republished */
  assert.equal((await sja.runSavedJobInstant(saved)).instant, 0);
  assert.equal(await row(E.id, saved), undefined);

  /* a related job they already applied to */
  const applied = await job({ title: 'Hospital Pharmacist' });
  assert.equal((await E.post('/api/applications', { jobId: applied })).status, 201);
  assert.equal((await sja.runSavedJobInstant(applied)).instant, 0);

  /* a related job they hid */
  const hidden = await job({ title: 'Retail Pharmacist' });
  assert.equal((await E.post(`/api/hidden-jobs/${hidden}`)).status, 200);
  assert.equal((await sja.runSavedJobInstant(hidden)).instant, 0);

  /* a related job they also saved */
  const both = await job({ title: 'Clinical Pharmacist' });
  await save(E, both);
  assert.equal((await sja.runSavedJobInstant(both)).instant, 0);
  await E.del(`/api/saved-jobs/${both}`);

  /* closed, expired, draft and paused jobs never alert */
  const closed = await job({ title: 'Senior Pharmacist', status: 'closed' });
  const expired = await job({ title: 'Junior Pharmacist', expiresAt: new Date(Date.now() - 60000) });
  const draft = await job({ title: 'Pharmacist Trainee', status: 'draft' });
  const paused = await job({ title: 'Pharmacist II', paused: true });
  for (const id of [closed, expired, draft, paused]) {
    const r = await sja.runSavedJobInstant(id);
    assert.equal(r.skip, 'job is not open', id);
  }
  /* a walk-in whose day is over */
  const pastWalkin = await job({ title: 'Pharmacist Walk-in', kind: 'walkin' });
  await raw(`update jobs set walkin_date = to_char(now() - interval '2 days', 'YYYY-MM-DD'), walkin_to = '17:00' where id=$1`, [pastWalkin]);
  assert.equal((await sja.runSavedJobInstant(pastWalkin)).skip, 'job is not open');

  /* published BEFORE they saved the job it is like: not new to them */
  const old = await job({ title: 'Staff Pharmacist', publishedAt: new Date(Date.now() - 2 * 3600000) });
  assert.equal((await sja.runSavedJobInstant(old)).instant, 0);

  assert.deepEqual((await inbox(E.id)).map((x) => x.message), []);
  assert.equal(mailsTo(E.email).length, 0);

  /* a related job whose saved job they have since hidden */
  const H = await candidate('Hari Babu');
  const hs = await job({ title: 'Ward Boy' });
  await save(H, hs);
  await H.post(`/api/hidden-jobs/${hs}`);
  assert.equal((await sja.runSavedJobInstant(await job({ title: 'Ward Boy (Night)' }))).instant, 0);

  /* do-not-contact: nothing on any channel, and the decision is recorded */
  const D = await candidate('Dinesh DNC');
  const ds = await job({ title: 'Physiotherapist' });
  await save(D, ds);
  await raw(`update candidates set do_not_contact = true where id=$1`, [D.id]);
  const dj = await job({ title: 'Senior Physiotherapist' });
  await sja.runSavedJobInstant(dj);
  assert.equal((await inbox(D.id)).length, 0);
  assert.equal(mailsTo(D.email).length, 0);
  assert.equal((await row(D.id, dj)).skip_reason, 'do not contact');
});

test('opted out of email: the inbox entry still goes, the email does not', async () => {
  const O = await candidate('Omkar Optout');
  const s = await job({ title: 'Radiographer' });
  await save(O, s);
  await raw(`update candidates set email_opt_in = false where id=$1`, [O.id]);
  const rel = await job({ title: 'X-Ray Radiographer' });
  const r = await sja.runSavedJobInstant(rel);
  assert.equal(r.instant, 1);
  assert.equal((await inbox(O.id)).length, 1);
  assert.equal(mailsTo(O.email).length, 0);
  const rec = await row(O.id, rel);
  assert.equal(rec.status, 'sent');
  assert.equal(rec.email_status, 'skipped_opted_out');
});

/* ------------------------------------------------------------------ *
 * one "new job for you" message across the alert systems
 * ------------------------------------------------------------------ */

test('dedupe with saved-search alerts: whichever comes first is the only message', async () => {
  const S = await candidate('Sita Search');
  const s = await job({ title: 'Dialysis Technician' });
  await save(S, s);
  const search = (await S.post('/api/saved-searches', {
    filters: { q: 'Dialysis' }, alert_frequency: 'instant', channels: ['email'],
  })).body.savedSearch;

  /* the saved search first (as on publish: it runs before this) */
  const j1 = await job({ title: 'Senior Dialysis Technician' });
  const ss = await ssa.runSavedSearchInstant(j1);
  assert.equal(ss.sent, 1);
  const r1 = await sja.runSavedJobInstant(j1);
  assert.equal(r1.told, 1);
  assert.equal((await row(S.id, j1)).skip_reason, 'already told by saved_search');
  assert.equal((await inbox(S.id)).length, 0);
  assert.equal(allMailsTo(S.email).length, 1, 'one email for one job');

  /* the other way round: the saved-job alert first, the search stays quiet */
  const j2 = await job({ title: 'Dialysis Technician (Night Shift)' });
  assert.equal((await sja.runSavedJobInstant(j2)).instant, 1);
  await ssa.runSavedSearchInstant(j2);
  await ssa.runSavedSearchSweep({ kinds: ['instant'] });
  const d = (await raw(`select job_ids from candidate_saved_search_deliveries where saved_search_id=$1`, [search.id])).rows;
  assert.equal(d.some((x) => x.job_ids.includes(j2)), false, 'the saved search did not announce it again');
  assert.equal(allMailsTo(S.email).length, 2);
});

test('dedupe with the profile-match job alert and urgent hiring', async () => {
  /* a profile that the match engine notifies about Java jobs in Nellore */
  const P = await candidate('Prasad Profile', {
    sql: `update candidates set skills = array['Java','Spring','SQL','AWS'], title = 'Java Developer',
                 location = 'Nellore', exp = '3 yrs', exp_years = 3 where id = $1`,
  });
  const s = await job({ title: 'Java Developer', skills: ['Java', 'Spring', 'SQL', 'AWS'], exp: '2-4 yrs' });
  await save(P, s);
  const j = await job({ title: 'Senior Java Developer', skills: ['Java', 'Spring', 'SQL', 'AWS'], exp: '2-4 yrs' });

  const pm = await jobAlerts.runJobAlerts(j);
  assert.ok(pm.matches.some((m) => m.candidateId === P.id), 'the profile match fires for this candidate');
  assert.equal((await notice(P.id, j)).source, 'profile_match');
  const r = await sja.runSavedJobInstant(j);
  assert.equal(r.told, 1);
  assert.equal((await inbox(P.id)).length, 0);

  /* urgent hiring switched on later: not a second "new job" message either */
  await raw(`update jobs set urgent = true, urgent_alerted_at = null where id=$1`, [j]);
  const runs = await portal.runPendingUrgent({ jobId: j });
  assert.equal(runs.length, 1);
  assert.ok(runs[0].skippedTold >= 1, JSON.stringify(runs[0]));
  assert.equal((await raw(`select count(*)::int n from notifications where recipient_id=$1 and type='URGENT_HIRING'`, [P.id])).rows[0].n, 0);
  const emails = allMailsTo(P.email);
  assert.equal(emails.length, 1, 'one email for this job, from the profile match: ' + emails.map((m) => m.body.subject).join(' | '));
  /* the profile-match alert is in the job-opportunity format (owner, 2026-10-06) */
  const pmMail = emails[0].body;
  assert.equal(pmMail.subject, 'A Senior Java Developer role matching your profile');
  assert.match(pmMail.text, /^🚀 NEW JOB OPPORTUNITY – Nellore\n\nHi! 👋 We found a job opportunity that could be a great match for your profile!/);
  for (const l of ['🏥 Senior Java Developer', '🏢 Sunrise Hospitals', '💼 Experience: 2-4 yrs', '🏠 Work From Home: Not Available']) {
    assert.ok(pmMail.text.split('\n').includes(l), `profile-match email is missing "${l}":\n${pmMail.text}`);
  }
  assert.match(pmMail.text, new RegExp(`🔗 http://127\\.0\\.0\\.1:\\d+/\\?alert=jm_[a-z0-9]+#/job/${j}`));
  assert.match(pmMail.text, /we matched you on: /);
  assert.match(pmMail.html, />View job &amp; apply</);
  /* SMS and WhatsApp have no provider here: nothing went out on them */
  assert.equal(mock.received.some((m) => m.url !== '/email'), false);
  const pmSt = (await raw(`select email_status, sms_status, whatsapp_status from job_matches where job_id=$1 and candidate_id=$2`,
    [j, P.id])).rows[0];
  assert.deepEqual(pmSt, { email_status: 'sent', sms_status: 'not_configured', whatsapp_status: 'skipped_no_address' });

  /* and urgent first: the saved-job alert then stays quiet */
  const j2 = await job({ title: 'Java Developer II', skills: ['Java', 'Spring', 'SQL', 'AWS'], exp: '2-4 yrs', });
  await raw(`update jobs set urgent = true where id=$1`, [j2]);
  await portal.runPendingUrgent({ jobId: j2 });
  assert.equal((await notice(P.id, j2)).source, 'urgent_hiring');
  assert.equal((await sja.runSavedJobInstant(j2)).told, 1);
  assert.equal((await inbox(P.id)).length, 0);
});

/* ------------------------------------------------------------------ *
 * the daily cap and the digest
 * ------------------------------------------------------------------ */

test('three a day, the rest in ONE evening digest, sent once', async () => {
  const G = await candidate('Gowri Digest');
  const s = await job({ title: 'Medical Coder' });
  await save(G, s);
  const ids = [];
  for (const t of ['Medical Coder I', 'Medical Coder II', 'Senior Medical Coder', 'Medical Coder (Remote)', 'Medical Coder Trainee', 'Medical Coder III']) {
    ids.push(await job({ title: t }));
    await sja.runSavedJobInstant(ids[ids.length - 1]);
  }
  assert.equal((await inbox(G.id)).length, 3, 'the cap is three instant alerts');
  assert.equal(mailsTo(G.email).length, 3);
  const queued = (await raw(`select job_id from candidate_saved_job_alerts where candidate_id=$1 and status='queued'`, [G.id])).rows;
  assert.equal(queued.length, 3);
  /* their claims are held, so no other alert announces them meanwhile */
  for (const q of queued) assert.equal((await notice(G.id, q.job_id)).source, 'saved_job');

  /* one of them closes before the evening */
  await raw(`update jobs set status='closed' where id=$1`, [queued[0].job_id]);

  /* before the slot: nothing */
  const early = await sja.runSavedJobDigest({ now: sja.digestSlot(Date.now()) - 1000 });
  assert.equal(early.messages, 0);

  const evening = sja.digestSlot(Date.now()) + 86400000 + 60000;   // the next 19:00 IST, plus a minute
  const d = await sja.runSavedJobDigest({ now: evening });
  assert.ok(d.messages >= 1);
  const dig = await inbox(G.id, 'SAVED_JOB_DIGEST');
  assert.equal(dig.length, 1);
  assert.equal(dig[0].metadata.count, 2);
  assert.equal(dig[0].title, '2 more new jobs like ones you saved');
  const mail = mailsTo(G.email);
  assert.equal(mail.length, 4, 'three instant + one digest');
  assert.equal(mail[3].body.subject, '2 more new jobs like ones you saved');
  assert.match(mail[3].body.text, /like "Medical Coder"/);
  const closedRow = await row(G.id, queued[0].job_id);
  assert.equal(closedRow.status, 'skipped');
  assert.match(closedRow.skip_reason, /no longer open/);

  /* again: nothing more */
  await sja.runSavedJobDigest({ now: evening + 3600000 });
  assert.equal(mailsTo(G.email).length, 4);
  assert.equal((await inbox(G.id, 'SAVED_JOB_DIGEST')).length, 1);

  /* the next day the cap starts again */
  const next = await job({ title: 'Medical Coder Lead' });
  const r = await sja.runSavedJobInstant(next, { now: Date.now() + 86400000 });
  assert.equal(r.instant, 1);
});

/* ------------------------------------------------------------------ *
 * the candidate's control
 * ------------------------------------------------------------------ */

test('the Saved Jobs toggle: on by default, off stops everything, server-side', async () => {
  const T = await candidate('Tara Toggle');
  let g = await T.get('/api/saved-job-alerts/settings');
  assert.equal(g.status, 200);
  assert.equal(g.body.settings.enabled, true);
  assert.equal(g.body.settings.dailyCap, 3);

  assert.equal((await T.put('/api/saved-job-alerts/settings', { enabled: 'nope' })).status, 400);
  assert.equal((await recruiter.put('/api/saved-job-alerts/settings', { enabled: false })).status, 403);
  assert.equal((await makeClient(base).get('/api/saved-job-alerts/settings')).status, 401);

  const off = await T.put('/api/saved-job-alerts/settings', { enabled: false });
  assert.equal(off.status, 200);
  assert.equal(off.body.settings.enabled, false);
  g = await T.get('/api/saved-job-alerts/settings');
  assert.equal(g.body.settings.enabled, false);
  assert.equal(g.body.settings.changedVia, 'page');

  const s = await job({ title: 'Optometrist' });
  await save(T, s);
  const j = await job({ title: 'Senior Optometrist' });
  await sja.runSavedJobInstant(j);
  assert.equal((await inbox(T.id)).length, 0);
  assert.equal(mailsTo(T.email).length, 0);
  assert.equal((await row(T.id, j)).skip_reason, 'switched off by the candidate');

  /* back on: the next job is announced */
  assert.equal((await T.put('/api/saved-job-alerts/settings', { enabled: true })).body.settings.enabled, true);
  const j2 = await job({ title: 'Optometrist (Eye Hospital)' });   // the saved title, inside a longer one
  assert.equal((await sja.runSavedJobInstant(j2)).instant, 1);

  /* one candidate's switch is not another's */
  const other = await candidate('Other Person');
  assert.equal((await other.get('/api/saved-job-alerts/settings')).body.settings.enabled, true);
});

test('the email\'s unsubscribe link works signed out, is signed, and only for that candidate', async () => {
  const [mail] = mailsTo(A.email);
  const link = /(http:\/\/\S+\/api\/saved-job-alerts\/stop\?token=\S+)/.exec(mail.body.text)[1];
  const stranger = makeClient(base);
  const path = link.replace(base, '');
  const ok = await stranger.get(path);
  assert.equal(ok.status, 200);
  assert.match(ok.body.raw, /Similar-job emails stopped/);
  const set = (await raw(`select enabled, changed_via from candidate_saved_job_alert_settings where candidate_id=$1`, [A.id])).rows[0];
  assert.deepEqual(set, { enabled: false, changed_via: 'email_link' });

  const token = sja.stopToken(A.id);
  const forged = await stranger.get(`/api/saved-job-alerts/stop?token=${encodeURIComponent(`cand_someone_else.${token.split('.').pop()}`)}`);
  assert.equal(forged.status, 400, 'a token for one candidate does not stop another');
  assert.equal((await stranger.get('/api/saved-job-alerts/stop?token=garbage')).status, 400);

  const rel = await job({ title: 'Staff Nurse (ICU)' });
  await sja.runSavedJobInstant(rel);
  assert.equal(mailsTo(A.email).length, 1, 'no email after unsubscribing');
});

/* ------------------------------------------------------------------ *
 * how it is triggered
 * ------------------------------------------------------------------ */

test('the sweep catches a job the publish hook never saw, once', async () => {
  const W = await candidate('Waseem Sweep');
  const s = await job({ title: 'Lab Assistant' });
  await save(W, s);
  /* opened by a path that runs no hook */
  const j = await job({ title: 'Lab Assistant (Pathology)', status: 'draft' });
  await raw(`update jobs set status='open', published_at = now() where id=$1`, [j]);
  const r = await sja.runSavedJobSweep();
  assert.ok(r.jobs >= 1);
  assert.equal((await inbox(W.id)).length, 1);
  const again = await sja.runSavedJobSweep();
  assert.equal(again.jobs, 0, 'a processed publication is not looked at again');
  assert.equal((await inbox(W.id)).length, 1);
});

test('publishing a draft through the API tells the candidate (the publish hook chain)', async () => {
  const K = await candidate('Kavya Hook');
  const s = await job({ title: 'Operation Theatre Technician' });
  await save(K, s);
  const draft = await job({ title: 'OT Technician', status: 'draft' });
  await raw(`update jobs set title = 'Senior Operation Theatre Technician' where id=$1`, [draft]);
  const pub = await recruiter.post(`/api/jobs/${draft}/publish`, {});
  assert.equal(pub.status, 200, JSON.stringify(pub.body));
  let n = [];
  for (let i = 0; i < 300 && !n.length; i += 1) {
    await new Promise((r) => setTimeout(r, 100));
    n = await inbox(K.id);
  }
  assert.equal(n.length, 1, 'the bell entry arrived from the publish hook: '
    + JSON.stringify((await raw(`select * from candidate_saved_job_alerts where job_id=$1`, [draft])).rows));
  assert.equal(n[0].job_id, draft);
  /* the inbox entry is written first and the email follows: wait for it rather than race it */
  for (let i = 0; i < 100 && !mailsTo(K.email).length; i += 1) await new Promise((r) => setTimeout(r, 100));
  assert.equal(mailsTo(K.email).length, 1);
});

test('saving through the API: candidate only, own rows, listed back', async () => {
  const L = await candidate('Lakshmi List');
  const j = await job({ title: 'Receptionist' });
  assert.equal((await L.post(`/api/saved-jobs/${j}`)).status, 200);
  assert.deepEqual((await L.get('/api/saved-jobs')).body.saved, [j]);
  assert.equal((await recruiter.post(`/api/saved-jobs/${j}`)).status, 403);
  const M = await candidate('Mani Other');
  assert.deepEqual((await M.get('/api/saved-jobs')).body.saved, []);
  assert.equal((await L.del(`/api/saved-jobs/${j}`)).status, 200);
  assert.deepEqual((await L.get('/api/saved-jobs')).body.saved, []);
});

test('the shared ledger is the engine\'s alone', async () => {
  const { withUser } = await import('../src/db.js');
  const admin = (await raw(`insert into users (email,password_hash,role) values ('ops-sj@tl-sink.local','x','admin') returning id`)).rows[0].id;
  const staff = { userId: admin, role: 'admin', profileId: null };
  await assert.rejects(withUser(staff, (c) => c.query(`select new_job_notice_claim('x','y','saved_job')`)), /alert engine only/);
  const n = await withUser(staff, async (c) => (await c.query(`select count(*)::int n from candidate_saved_job_alerts`)).rows[0].n);
  assert.equal(n, 0, 'staff read none of them');
  /* a candidate reads only their own */
  const mine = await withUser({ userId: (await raw(`select user_id from candidates where id=$1`, [A.id])).rows[0].user_id, role: 'candidate' },
    async (c) => (await c.query(`select distinct candidate_id from candidate_saved_job_alerts`)).rows);
  assert.deepEqual(mine.map((x) => x.candidate_id), [A.id]);
});

test('Notification Settings lists the two templates', async () => {
  const rows = (await raw(`select event_key, label from notification_templates where event_key like 'saved_job%' order by event_key`)).rows;
  assert.deepEqual(rows, [
    { event_key: 'saved_job_alert', label: 'Saved Job — Similar New Job' },
    { event_key: 'saved_job_digest', label: 'Saved Job — Daily Digest' },
  ]);
});

test('teardown', async () => {
  await new Promise((r) => server.close(r));
  const { closePool } = await import('../src/db.js');
  await closePool();
  await mock.stop();
  await dbh.stop();
});
