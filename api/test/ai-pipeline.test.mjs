/**
 * The AI Hiring Demo's pipeline against a real Postgres with RLS on: every
 * number comes from the product's own functions, and nobody sees an
 * application they may not.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb, applyTestEnv, makeClient } from './harness.mjs';

const DB_PORT = 5519;
const API_PORT = 9919;
let dbh; let server; let base; let raw;

const RESUME = `Ravi Kumar
ravi.kumar@example.com | +91 98765 43210 | Hyderabad
SUMMARY
Recruiter with 3 years of experience in talent acquisition and sourcing.
SKILLS
Recruitment, Sourcing, Screening, ATS, Communication
EXPERIENCE
Talent Acquisition Executive, ABC Staffing  Jan 2022 - Present
EDUCATION
MBA (HR), Osmania University 2021`;

async function candidate(name, email) {
  const c = makeClient(base);
  await c.get('/api/health');
  const r = await c.post('/api/auth/register', {
    name, email, password: 'Pipe123line9', phone: '9' + String(Math.floor(1e8 + Math.random() * 9e8)),
    preferredLocation: 'Hyderabad', expectedCtc: 4, noticePeriod: 'Immediate', preferredWorkModes: ['Work From Office'],
    consent: { terms: true, communication: true, resumeProcessing: true },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  c.id = r.body.candidateId;
  return c;
}
async function recruiter() {
  const { hashPassword } = await import('../src/auth.js');
  const u = await raw(`insert into users (email, password_hash, role) values ('rpl@tl-sink.local', $1, 'recruiter') returning id`,
    [await hashPassword('Staff123pass')]);
  await raw(`insert into recruiters (id, user_id, name, email, company_id) values ('rpl', $1, 'R PL', 'rpl@tl-sink.local', 'co_pl')`, [u.rows[0].id]);
  const c = makeClient(base);
  await c.get('/api/health');
  assert.equal((await c.post('/api/auth/login', { email: 'rpl@tl-sink.local', password: 'Staff123pass' })).status, 200);
  return c;
}
const run = (c, b) => c.post('/api/ai-pipeline/run', b);

test('boot', async () => {
  dbh = await startTestDb(DB_PORT);
  applyTestEnv(dbh.url, { PUBLIC_ORIGIN: `http://127.0.0.1:${API_PORT}`, DISABLE_BACKGROUND_WORK: 'true', AI_API_KEY: '' });
  raw = (sql, params) => dbh.db.query(sql, params);
  await raw(`insert into companies (id, name) values ('co_pl', 'Hyderabad Staffing')`);
  await raw(`insert into jobs (id, title, company_id, location, mode, exp_label, pay_label, salary_min, salary_max,
               employment_type, status, skills, published_at, description)
             values ('jpl1', 'Talent Acquisition Executive', 'co_pl', 'Hyderabad', 'Onsite', '2-4 yrs', '₹4-6 LPA', 4, 6,
                     'Full-time', 'open', '{Recruitment,Sourcing,Screening,ATS,Onboarding}', now(), 'Hire for client roles.'),
                    ('jpl_draft', 'Secret Draft', 'co_pl', 'Hyderabad', 'Onsite', '0-2 yrs', '₹9 LPA', 9, 9,
                     'Full-time', 'draft', '{}', null, 'x')`);
  const { createApp } = await import('../src/app.js');
  const app = createApp({ logger: { error() {}, log() {} } });
  await new Promise((r) => { server = app.listen(API_PORT, r); });
  base = `http://127.0.0.1:${API_PORT}`;
});

let A; let B; let R;

test('a visitor pastes a real resume: every step answers from the product\'s own functions', async () => {
  const anon = makeClient(base);
  await anon.get('/api/health');
  const r = await run(anon, { jobId: 'jpl1', text: RESUME });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const b = r.body;
  assert.equal(b.mode, 'resume');
  assert.equal(b.engine, 'rules');
  assert.equal(b.job.title, 'Talent Acquisition Executive');
  // parsing: read from the pasted text
  assert.equal(b.parse.name, 'Ravi Kumar');
  assert.equal(b.parse.location, 'Hyderabad');
  assert.deepEqual(b.parse.skills.slice(0, 4), ['Recruitment', 'Sourcing', 'Screening', 'ATS']);
  // matching: 4 of the 5 JD skills, as the job card would say
  assert.equal(b.match.score, 80);
  assert.equal(b.match.required, 5);
  assert.equal(b.match.matchedCount, 4);
  assert.deepEqual(b.match.missing, ['Onboarding']);
  // screening: the admin-weighted screening with a verdict and the threshold it used
  assert.ok(['shortlist', 'review', 'hold'].includes(b.screening.verdict));
  assert.equal(typeof b.screening.score, 'number');
  assert.equal(typeof b.screening.threshold, 'number');
  assert.deepEqual(Object.keys(b.screening.dimensions), ['skills', 'experience', 'education', 'location']);
  assert.ok(b.screening.dimensions.skills.of > 0 && b.screening.dimensions.skills.percent >= 0);
  // ranking compares real applicants: not part of a try-out
  assert.equal(b.ranking.available, false);
  // the interview: the real planner's first questions, not a canned list
  assert.equal(b.interview.questions.length, 5);
  assert.ok(b.interview.questions.every((q) => q.length > 10 && q.split(' ').length <= 25));
  assert.equal(b.interview.existing, null);
  assert.equal(b.recommendation.humanDecides, true);
  assert.match(b.notice, /never auto-rejects/i);
  // a different resume gives a different answer: nothing is hard-coded
  const r2 = await run(anon, { jobId: 'jpl1', text: RESUME.replace(/Recruitment, Sourcing, Screening, ATS, Communication/, 'Driving, Cooking, Gardening') });
  assert.notEqual(r2.body.match.score, 80);
  /* the summary still says "sourcing", and a skill named in the resume's own words counts - as on the job card */
  assert.equal(r2.body.match.score, 20);
  assert.deepEqual(r2.body.match.matched, ['Sourcing']);
});

test('validation: nothing to read, an unknown or unpublished job, unknown fields', async () => {
  const anon = makeClient(base);
  await anon.get('/api/health');
  assert.equal((await run(anon, { jobId: 'jpl1' })).status, 400, 'a visitor with no resume text');
  assert.equal((await run(anon, { jobId: 'jpl1', text: 'too short' })).status, 400);
  assert.equal((await run(anon, { text: RESUME })).status, 400, 'no job');
  assert.equal((await run(anon, { jobId: 'jpl_draft', text: RESUME })).status, 404, 'an unpublished job is not offered');
  assert.equal((await run(anon, { jobId: 'nope', text: RESUME })).status, 404);
  assert.equal((await run(anon, { jobId: 'jpl1', text: RESUME, role: 'admin' })).status, 400);
  assert.equal((await run(anon, { jobId: 'jpl1', applicationId: 'x' })).status, 401, 'an application needs a signed-in viewer');
});

test('a signed-in candidate with no text: their own saved profile', async () => {
  A = await candidate('Asha Rao', 'asha.pl@tl-sink.local');
  B = await candidate('Bala Krishna', 'bala.pl@tl-sink.local');
  await raw(`update candidates set title = 'Recruiter', skills = '{Recruitment,Screening}', education = 'MBA', exp_years = 2, location = 'Hyderabad' where id = $1`, [A.id]);
  const r = await run(A, { jobId: 'jpl1' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.mode, 'profile');
  assert.equal(r.body.match.score, 40, '2 of the 5 JD skills');
  assert.equal(r.body.parse.name, 'Asha Rao');
});

test('a real application: the candidate sees their own, a recruiter sees ranking and verdict, an outsider sees nothing', async () => {
  await raw(`insert into applications (id, candidate_id, job_id, stage, applied_at, match_score) values ('app_pl1', $1, 'jpl1', 'applied', now(), 61)`, [A.id]);
  await raw(`insert into applications (id, candidate_id, job_id, stage, applied_at, match_score) values ('app_pl2', $1, 'jpl1', 'applied', now(), 80)`, [B.id]);
  R = await recruiter();
  await raw(`update jobs set recruiter_id = 'rpl' where id = 'jpl1'`);   // the recruiter owns this job

  // the candidate: their match, never a verdict, a score ranking or a decision about themselves
  let r = await run(A, { jobId: 'jpl1', applicationId: 'app_pl1' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.mode, 'application');
  assert.equal(r.body.application.id, 'app_pl1');
  assert.equal(r.body.screening, null);
  assert.equal(r.body.ranking.available, false);
  assert.equal(r.body.recommendation.level, 'info');
  assert.equal(r.body.match.score, 40);

  // the recruiter of that job: the screening verdict and the real rank among the job's applicants
  r = await run(R, { jobId: 'jpl1', applicationId: 'app_pl1' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.screening && ['shortlist', 'review', 'hold'].includes(r.body.screening.verdict), JSON.stringify(r.body.screening));
  assert.deepEqual(r.body.ranking, { available: true, rank: 2, of: 2 }, 'app_pl2 (80) is ahead of app_pl1 (61)');
  assert.equal(r.body.recommendation.humanDecides, true);

  // another candidate cannot run it on A's application
  r = await run(B, { jobId: 'jpl1', applicationId: 'app_pl1' });
  assert.equal(r.status, 404);

  // the picker lists exactly what the viewer may see
  const mine = await A.get('/api/ai-pipeline/applications');
  assert.deepEqual(mine.body.applications.map((x) => x.id), ['app_pl1']);
  assert.equal(mine.body.applications[0].candidateName, undefined, 'a candidate is not given names');
  const staff = await R.get('/api/ai-pipeline/applications');
  assert.deepEqual(staff.body.applications.map((x) => x.id).sort(), ['app_pl1', 'app_pl2']);
  assert.ok(staff.body.applications.every((x) => x.candidateName));
  const anon = makeClient(base);
  await anon.get('/api/health');
  assert.equal((await anon.get('/api/ai-pipeline/applications')).status, 401);
});

test('the AI interview score is shown to the recruiter and never to the candidate', async () => {
  await raw(`insert into ai_interviews (id, application_id, candidate_id, job_id, status, overall_percentage, questions_asked, questions_answered)
             values ('aiv_pl1', 'app_pl1', $1, 'jpl1', 'in_progress', 72, 5, 3)`, [A.id]);   // the database refuses a completed one without its answers
  const rec = await run(R, { jobId: 'jpl1', applicationId: 'app_pl1' });
  assert.equal(rec.body.interview.existing.status, 'in_progress');
  assert.equal(rec.body.interview.existing.score, 72);
  const mine = await run(A, { jobId: 'jpl1', applicationId: 'app_pl1' });
  assert.equal(mine.body.interview.existing.status, 'in_progress');
  assert.equal(mine.body.interview.existing.score, undefined, 'a candidate is never shown their interview score');
});

test('shutdown', async () => {
  await new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
  await dbh.stop();
});
