/**
 * Walk-in AI eligibility and the HR notices (0138), against a real Postgres with RLS on.
 *
 *   - the HR email goes when a walk-in application is SAVED - before any AI interview -
 *     to INTERNAL_HR_EMAIL, whether or not a recruiter is assigned; never for a regular job
 *   - eligibility = the FINAL AI interview score >= 50 (49 no; 50, 51, 75, 100 yes),
 *     decided by the database; an invalid score is never eligible; the latest attempt counts
 *   - the "eligible" email goes once per application, only at 50% or more
 *   - nobody can write the score or the eligibility (the database refuses)
 *   - a failed email keeps the application and is retried; a duplicate apply sends nothing
 *   - one candidate confirmation per application
 *   - the walk-in map link must be a Google Maps link (it is what the QR code opens)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb, applyTestEnv, makeClient } from './harness.mjs';

const DB_PORT = 5609;
const API_PORT = 9911;
const HR = 'internal.hr@tl-sink.local';

let dbh, server, base, raw, providers, notices, wj, recruiter;
const sent = [];
const IST = 330 * 60 * 1000;
const istDay = (plus = 0) => new Date(Date.now() + IST + plus * 86400000).toISOString().slice(0, 10);
const tick = (ms = 200) => new Promise((r) => setTimeout(r, ms));
const one = async (sql, p) => (await raw(sql, p)).rows[0];
let seq = 0;

async function candidate(name) {
  const c = makeClient(base);
  await c.get('/api/health');
  c.email = `${name.toLowerCase().replace(/\W+/g, '.')}.${Date.now().toString(36)}${++seq}@tl-sink.local`;
  const r = await c.post('/api/auth/register', {
    name, email: c.email, password: 'Walkin123jobs', phone: `98765${String(40000 + seq).padStart(5, '0')}`,
    preferredLocation: 'Hyderabad', expectedCtc: 4, noticePeriod: 'Immediate', preferredWorkModes: ['Work From Office'],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  c.id = r.body.candidateId;
  c.name = name;
  return c;
}
async function apply(c, jobId) {
  const r = await c.post('/api/applications', { jobId });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.application.id;
}
/** An AI interview finishing, the way ai_interview_finish leaves the row. */
async function interview(appId, overall, { scored = true, attempt = 1 } = {}) {
  const a = await one(`select candidate_id, job_id from applications where id=$1`, [appId]);
  const id = `aiv_${appId}_${attempt}`;
  await raw(`insert into ai_interviews (id, application_id, candidate_id, job_id, status, attempt_number)
             values ($1,$2,$3,$4,'in_progress',$5)`, [id, appId, a.candidate_id, a.job_id, attempt]);
  /* a score is never stored without the answers that produced it (0005's guard) */
  await raw(`insert into ai_interview_answers (ai_interview_id, seq, category, question, answered, answer_summary, score)
             values ($1, 1, 'technical', 'Tell us about handling an angry customer.', $2, $3, $4)`,
    [id, scored, scored ? 'I listen first, then fix the issue and follow up.' : null, scored ? overall : 0]);
  await raw(`update ai_interviews set status='completed', completed_at=now(), overall_percentage=$2, content_scored=$3 where id=$1`,
    [id, overall, scored]);
  return id;
}
const elig = async (appId) => one(`select walkin_ai_score::float8 s, walkin_ai_eligibility e from applications where id=$1`, [appId]);
const hrMail = (re) => sent.filter((m) => m.to === HR && re.test(m.subject));

test('boot', async () => {
  dbh = await startTestDb(DB_PORT);
  applyTestEnv(dbh.url, {
    PUBLIC_ORIGIN: `http://127.0.0.1:${API_PORT}`,
    DISABLE_BACKGROUND_WORK: 'true', AI_API_KEY: '', INTERNAL_HR_EMAIL: HR,
    EMAIL_API_KEY: '', EMAIL_SMTP_HOST: '', EMAIL_SMTP_USER: '', EMAIL_SMTP_PASS: '',
    EMAILJS_SERVICE_ID: '', EMAILJS_TEMPLATE_ID: '', EMAILJS_PUBLIC_KEY: '', EMAILJS_PRIVATE_KEY: '',
    SMS_API_KEY: '', WHATSAPP_API_KEY: '', APPLY_RATE_PER_HOUR: '500',
  });
  raw = (sql, params) => dbh.db.query(sql, params);
  const { hashPassword } = await import('../src/auth.js');
  await raw(`insert into companies (id, name) values ('co_el', 'Eligible Works Pvt Ltd')`);
  const ru = (await raw(`insert into users (email,password_hash,role) values ('rel@tl-sink.local',$1,'recruiter') returning id`,
    [await hashPassword('Staff123pass')])).rows[0].id;
  await raw(`insert into recruiters (id, name, email, company_id, user_id) values ('rel1','Rec EL','rel@tl-sink.local','co_el',$1)`, [ru]);
  wj = 'j_el_walkin';
  await raw(`insert into jobs (id, title, company_id, location, mode, status, posting_kind, employment_type,
                               walkin_date, walkin_from, walkin_to, walkin_venue, walkin_address, walkin_map_link,
                               walkin_contact, walkin_contact_designation, walkin_phone, recruiter_id, published_at)
             values ($1, 'Customer Support Walk-in', 'co_el', 'Hyderabad', 'Onsite', 'open', 'walkin', 'Walk-in',
                     $2, '10:00', '16:00', 'TeamLink Office', 'Road No. 1, Banjara Hills, Hyderabad 500034',
                     'https://maps.app.goo.gl/AbCdEf123', 'Ravi Kumar', 'HR Manager', '9876500011', 'rel1', now())`, [wj, istDay(5)]);
  await raw(`insert into jobs (id, title, company_id, location, status, published_at) values ('j_el_regular', 'Regular Role', 'co_el', 'Pune', 'open', now())`);

  const { createApp } = await import('../src/app.js');
  ({ providers } = await import('../src/notify/providers.js'));
  notices = await import('../src/notify/application-notices.js');
  providers.email.send = async (m) => { sent.push(m); return { status: 'sent', provider: 'test' }; };
  const app = createApp({ logger: { error() {}, log() {} } });
  await new Promise((r) => { server = app.listen(API_PORT, r); });
  base = `http://127.0.0.1:${API_PORT}`;
  recruiter = makeClient(base);
  await recruiter.get('/api/health');
  assert.equal((await recruiter.post('/api/auth/login', { email: 'rel@tl-sink.local', password: 'Staff123pass', role: 'recruiter' })).status, 200);
});

let first, asha;
test('a walk-in application tells HR at once - before any interview - with the walk-in details', async () => {
  const c = await candidate('Asha Walkin');
  asha = c;
  first = await apply(c, wj);
  await notices.kickApplicationNotices();
  const mails = hrMail(/^New Walk-In Application - Asha Walkin - Customer Support Walk-in$/);
  assert.equal(mails.length, 1, JSON.stringify(sent.map((m) => [m.to, m.subject])));
  const t = mails[0].text;
  for (const want of ['Application ID: TL-APP-', 'Job ID: j_el_walkin', 'Client / Company: Eligible Works Pvt Ltd', c.email,
    'Venue: TeamLink Office', 'Google Maps: https://maps.app.goo.gl/AbCdEf123', 'Contact person: Ravi Kumar',
    'Designation: HR Manager', 'Contact phone: 9876500011', 'AI interview: Pending', '/#/recruiter/manage-jobs?applicants=j_el_walkin&app=']) {
    assert.ok(t.includes(want), `HR email has "${want}"`);
  }
  assert.equal((await one(`select count(*)::int n from ai_interviews where application_id=$1`, [first])).n, 0, 'no interview yet');
  const row = await one(`select status, recipient, attempts from application_notices where application_id=$1 and event='WALKIN_APPLICATION_SUBMITTED_HR'`, [first]);
  assert.deepEqual(row, { status: 'sent', recipient: HR, attempts: 1 });
  // the candidate's confirmation: one claim, recorded
  const conf = await one(`select count(*)::int n from application_notices where application_id=$1 and event='APPLICATION_SUBMITTED_CANDIDATE'`, [first]);
  assert.equal(conf.n, 1);
});

test('a duplicate apply and a second sweep send nothing more; a regular job never tells HR', async () => {
  const before = sent.length;
  const dupe = await asha.post('/api/applications', { jobId: wj });
  assert.equal(dupe.status, 409, 'the same walk-in twice is refused');
  await notices.kickApplicationNotices();
  await notices.runApplicationNoticeSweep();
  assert.equal(sent.length, before, 'no second HR email, no second confirmation');
  assert.equal((await one(`select count(*)::int n from applications where job_id=$1`, [wj])).n, 1);
  const c = await candidate('Ravi Regular');
  await apply(c, 'j_el_regular');
  await notices.kickApplicationNotices();
  assert.equal(sent.filter((m) => m.to === HR).length, hrMail(/./).length);
  assert.equal(hrMail(/Ravi Regular/).length, 0, 'no HR email for a regular job');
  const again = await c.post('/api/applications', { jobId: 'j_el_regular' });
  assert.equal(again.status, 409, 'the same job twice is refused');
});

const apps = {};
test('eligibility = the final AI interview score >= 50: 49 no; 50, 51, 75, 100 yes', async () => {
  for (const s of [49, 50, 51, 75, 100]) {
    const c = await candidate(`Score ${s}`);
    apps[s] = await apply(c, wj);
    await interview(apps[s], s);
  }
  for (const s of [49, 50, 51, 75, 100]) {
    const e = await elig(apps[s]);
    assert.equal(e.s, s, `score ${s} stored`);
    assert.equal(e.e, s >= 50 ? 'eligible' : 'not_eligible', `score ${s}`);
  }
  const att = await one(`select attended_at, stage from applications where id=$1`, [apps[100]]);
  assert.equal(att.attended_at, null, 'eligible is not attended');
  assert.equal(att.stage, 'registered');
  await notices.kickApplicationNotices();
  for (const s of [50, 51, 75, 100]) assert.equal(hrMail(new RegExp(`^Walk-In Candidate Eligible - Score ${s} -`)).length, 1, `eligible email for ${s}`);
  assert.equal(hrMail(/^Walk-In Candidate Eligible - Score 49 -/).length, 0, 'no eligible email for 49');
  const m = hrMail(/^Walk-In Candidate Eligible - Score 75 -/)[0];
  assert.ok(m.text.includes('Final AI interview score: 75%') && m.text.includes('Eligibility: Eligible'), m.text);
});

test('a re-scored or reprocessed interview sends no second eligible email', async () => {
  await raw(`update ai_interviews set overall_percentage = 76 where application_id=$1`, [apps[75]]);
  await raw(`select walkin_ai_settle($1, true)`, [apps[75]]);
  await notices.kickApplicationNotices();
  assert.equal((await elig(apps[75])).s, 76);
  assert.equal(hrMail(/^Walk-In Candidate Eligible - Score 75 -/).length, 1, 'still one');
});

test('an invalid or missing score is never eligible; the LATEST attempt is the final score', async () => {
  const c = await candidate('Silent Walkin');
  const app = await apply(c, wj);
  await interview(app, 80, { scored: false });              // nothing said could be assessed
  assert.deepEqual(await elig(app), { s: null, e: 'score_invalid' });
  const c2 = await candidate('Retake Walkin');
  const app2 = await apply(c2, wj);
  await interview(app2, 40, { attempt: 1 });
  assert.equal((await elig(app2)).e, 'not_eligible');
  await interview(app2, 62, { attempt: 2 });
  assert.deepEqual(await elig(app2), { s: 62, e: 'eligible' });
  await notices.kickApplicationNotices();
  assert.equal(hrMail(/^Walk-In Candidate Eligible - Silent Walkin/).length, 0);
  assert.equal(hrMail(/^Walk-In Candidate Eligible - Retake Walkin/).length, 1);
});

test('nobody writes the score or the eligibility but the database itself', async () => {
  await assert.rejects(raw(`update applications set walkin_ai_eligibility='eligible', walkin_ai_score=99 where id=$1`, [apps[49]]),
    /set by the system only/);
  assert.equal((await elig(apps[49])).e, 'not_eligible');
});

test('a failed HR email keeps the application and is retried', async () => {
  providers.email.send = async () => ({ status: 'failed', provider: 'test', error: 'smtp down' });
  const c = await candidate('Fail Then Send');
  const app = await apply(c, wj);
  await notices.kickApplicationNotices();
  let row = await one(`select status, last_error from application_notices where application_id=$1 and event='WALKIN_APPLICATION_SUBMITTED_HR'`, [app]);
  assert.equal(row.status, 'failed');
  assert.match(row.last_error, /smtp down/);
  assert.equal((await one(`select count(*)::int n from applications where id=$1`, [app])).n, 1, 'the application stands');
  providers.email.send = async (m) => { sent.push(m); return { status: 'sent', provider: 'test' }; };
  await raw(`update application_notices set claimed_at = now() - interval '1 hour' where application_id=$1`, [app]);
  await notices.runApplicationNoticeSweep();
  row = await one(`select status, attempts from application_notices where application_id=$1 and event='WALKIN_APPLICATION_SUBMITTED_HR'`, [app]);
  assert.deepEqual(row, { status: 'sent', attempts: 2 });
  assert.equal(hrMail(/Fail Then Send/).length, 1);
});

test('the recruiter and the candidate see the score and the eligibility; the map link must be Google Maps', async () => {
  const d = await recruiter.get(`/api/ats/applications/${apps[51]}`);
  assert.equal(d.status, 200, JSON.stringify(d.body));
  assert.equal(d.body.aiInterview.eligibility, 'eligible');
  assert.equal(d.body.aiInterview.score, 51);
  assert.equal(d.body.walkin.mapLink, 'https://maps.app.goo.gl/AbCdEf123');
  assert.equal(d.body.walkin.contactDesignation, 'HR Manager');

  const { isGoogleMapsUrl } = await import('../src/portal/walkin-jobs.js');
  for (const ok of ['https://maps.app.goo.gl/AbCdEf123', 'https://www.google.com/maps/place/Lulu+Mall', 'https://maps.google.com/?q=KPHB',
    'https://goo.gl/maps/xyz', 'https://www.google.co.in/maps/@17.4,78.4,15z']) assert.ok(isGoogleMapsUrl(ok), ok);
  for (const bad of ['http://maps.google.com/?q=x', 'https://example.com/maps', 'https://www.google.com/search?q=x', 'KPHB', '',
    'https://maps.google.com.evil.example/x', 'https://maps-google.com/x']) assert.ok(!isGoogleMapsUrl(bad), bad);

  const r = await recruiter.post('/api/jobs', {
    title: 'Bad Map Walk-in', companyId: 'co_el', location: 'Hyderabad', type: 'Walk-in', postingKind: 'walkin', status: 'open',
    walkinDate: istDay(6), walkinFrom: '10:00', walkinTo: '16:00', walkinVenue: 'Office', walkinAddress: '12 Main Road, Hyderabad',
    walkinMapLink: 'https://example.com/where', walkinContact: 'Ravi', walkinPhone: '9876500011',
  });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.ok(r.body.error.details.walkinMapLink);
  const ok = await recruiter.post('/api/jobs', {
    title: 'Good Map Walk-in', companyId: 'co_el', location: 'Hyderabad', type: 'Walk-in', postingKind: 'walkin', status: 'open',
    walkinDate: istDay(6), walkinFrom: '10:00', walkinTo: '16:00', walkinVenue: 'Office', walkinAddress: '12 Main Road, Hyderabad',
    walkinMapLink: 'https://maps.app.goo.gl/AbCdEf123', walkinContact: 'Ravi', walkinContactDesignation: 'Talent Lead',
    walkinPhone: '9876500011', walkinAiThreshold: 60, walkinAiRequired: true,
  });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.job.walkinContactDesignation, 'Talent Lead');
  assert.equal(ok.body.job.walkinAiThreshold, 60);
});

test('a walk-in without the AI interview sends no invitation and opens no session', async () => {
  await raw(`insert into jobs (id, title, company_id, location, mode, status, posting_kind, employment_type,
                               walkin_date, walkin_from, walkin_to, walkin_venue, walkin_address, walkin_contact, walkin_phone,
                               walkin_ai_required, recruiter_id, published_at)
             values ('j_el_noai', 'Warehouse Walk-in', 'co_el', 'Hyderabad', 'Onsite', 'open', 'walkin', 'Walk-in',
                     $1, '10:00', '16:00', 'Depot', 'Plot 4, Medchal, Hyderabad', 'Sita', '9876500012', false, 'rel1', now())`, [istDay(4)]);
  const c = await candidate('No Interview Walkin');
  const app = await apply(c, 'j_el_noai');
  const inv = await one(`select count(*)::int n from notification_deliveries where application_id=$1 and event='AI_INTERVIEW_INVITED'`, [app]);
  assert.equal(inv.n, 0, 'no AI interview invitation');
  const s = await c.post('/api/ai-interviews/session', { applicationId: app });
  assert.equal(s.status, 410, JSON.stringify(s.body));
  assert.equal(s.body.error.details.reason, 'not_required');
  assert.match(s.body.error.message, /does not include an AI interview/);
  await notices.kickApplicationNotices();
  assert.equal(hrMail(/^New Walk-In Application - No Interview Walkin/).length, 1, 'HR still hears about the application');
  assert.ok(hrMail(/^New Walk-In Application - No Interview Walkin/)[0].text.includes('AI interview: Not required for this walk-in'));
});

test('shutdown', async () => {
  await new Promise((r) => server.close(r));
  const { stopBackgroundWork } = await import('../src/app.js');
  stopBackgroundWork?.();
  const { closePool } = await import('../src/db.js');
  await closePool();
  await dbh.stop?.();
});
