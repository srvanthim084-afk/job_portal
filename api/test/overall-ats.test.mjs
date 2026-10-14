/**
 * The OVERALL score (resume + AI interview) decides the move to the ATS (0147).
 *
 *   - overall = the resume score and the AI interview score, equally weighted (resume 80 + interview 70 = 75)
 *   - overall 65 or more moves the application to Shortlisted - "Pushed to ATS", automatically, with the
 *     overall, both parts and the mark on record; 64 does not; exactly 65 does
 *   - nobody moves on the resume / screening score alone: the screening verdict no longer shortlists
 *   - no scored resume yet: the interview alone is the overall; walk-ins and applications further along
 *     are not moved; nobody is moved back
 *   - the Talent Pool lists who was moved (ats=pushed | auto | manual)
 *   - the migration's clean-up fills the numbers in for interviews already on file, moving nobody
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb, applyTestEnv, makeClient } from './harness.mjs';

const DB_PORT = 5611;
const API_PORT = 9969;
const base = `http://127.0.0.1:${API_PORT}`;
const PW = 'OverallAts65test';

let dbh, server, raw, screening, rec;
let seq = 0;

async function candidate(resumeScore) {
  seq += 1;
  const c = makeClient(base);
  await c.get('/api/health');
  const r = await c.post('/api/auth/register', {
    name: `Overall Person ${seq}`, email: `overall.${seq}.${Date.now().toString(36)}@mailbox-teamlink-tests.in`,
    password: PW, phone: '93400' + String(10000 + seq).slice(-5), preferredLocation: 'Hyderabad', expectedCtc: 4,
    noticePeriod: 'Immediate', preferredWorkModes: ['Hybrid'],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  c.id = r.body.candidateId;
  await raw(`update candidates set skills = $2, technical_skills = $2, location = 'Hyderabad', preferred_location = 'Hyderabad',
             exp_years = 2, exp = '2 yrs', title = 'Recruiter', education = ARRAY['MBA'] where id = $1`, [c.id, ['Sourcing', 'ATS']]);
  if (resumeScore != null) {
    await raw(`insert into candidate_resume_scores (candidate_id, status, total_score, label) values ($1, 'scored', $2, 'Good')`, [c.id, resumeScore]);
  }
  return c;
}
const job = (id, extra = {}) => raw(
  `insert into jobs (id, title, company_id, location, mode, exp_label, skills, status, recruiter_id, description, published_at, posting_kind, walkin_date, walkin_from, walkin_to)
   values ($1, $2, 'co_ov', 'Hyderabad', 'Onsite', '1-3 yrs', $3, 'open', 'r_ov', 'Recruit for the team.', now(), $4, $5, $6, $7)`,
  [id, `Role ${id}`, ['Sourcing', 'ATS'], extra.kind || 'job', extra.walkinDate || null, extra.walkinDate ? '10:00' : null, extra.walkinDate ? '16:00' : null]);
async function application(resumeScore, jobId = 'j_ov', stage = 'applied') {
  const c = await candidate(resumeScore);
  const id = `app_ov_${++seq}`;
  await raw(`insert into applications (id, job_id, candidate_id, recruiter_id, stage, source) values ($1, $2, $3, 'r_ov', 'applied', 'portal')`, [id, jobId, c.id]);
  if (stage !== 'applied') await raw(`update applications set stage = $2 where id = $1`, [id, stage]);
  return { id, c };
}
const record = async (appId, score) => (await raw(`select ai_interview_recorded($1, $2) as out`, [appId, score])).rows[0].out;
const row = async (appId) => (await raw(`select stage, overall_score o, overall_resume_score r, overall_interview_score i, ats_pushed_via v, ats_pushed_score s, ats_pushed_at at from applications where id = $1`, [appId])).rows[0];

test('boot', async () => {
  dbh = await startTestDb(DB_PORT);
  applyTestEnv(dbh.url, {
    PUBLIC_ORIGIN: base, DISABLE_BACKGROUND_WORK: 'true', AI_API_KEY: '',
    EMAIL_API_KEY: '', EMAIL_SMTP_HOST: '', EMAIL_SMTP_USER: '', EMAIL_SMTP_PASS: '',
    EMAILJS_SERVICE_ID: '', EMAILJS_TEMPLATE_ID: '', EMAILJS_PUBLIC_KEY: '', EMAILJS_PRIVATE_KEY: '',
    SMS_API_KEY: '', WHATSAPP_API_KEY: '',
  });
  raw = (sql, params) => dbh.db.query(sql, params);
  await raw(`insert into companies (id, name) values ('co_ov', 'Overall Co')`);
  const { hashPassword } = await import('../src/auth.js');
  const u = (await raw(`insert into users (email,password_hash,role) values ('rec.ov@tl-sink.local',$1,'recruiter') returning id`, [await hashPassword(PW)])).rows[0].id;
  await raw(`insert into recruiters (id, user_id, name, email, company_id) values ('r_ov',$1,'Overall Recruiter','rec.ov@tl-sink.local','co_ov')`, [u]);
  const { createApp } = await import('../src/app.js');
  screening = await import('../src/ai/screening.js');
  const app = createApp({ logger: { error() {}, log() {} } });
  await new Promise((r) => { server = app.listen(API_PORT, r); });
  await job('j_ov');
  await job('j_ov_walk', { kind: 'walkin', walkinDate: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10) });
  rec = makeClient(base); await rec.get('/api/health');
  assert.equal((await rec.post('/api/auth/login', { email: 'rec.ov@tl-sink.local', password: PW, role: 'recruiter' })).status, 200);
});

test('resume 80 + interview 70 = overall 75: moved to the ATS, pushed automatically, all of it on record', async () => {
  const { id, c } = await application(80);
  const out = await record(id, 70);
  assert.equal(out.overall, 75); assert.equal(out.resume, 80); assert.equal(out.interview, 70);
  assert.equal(out.moved, true);
  const r = await row(id);
  assert.equal(r.stage, 'shortlisted');
  assert.deepEqual([r.o, r.r, r.i], [75, 80, 70]);
  assert.equal(r.v, 'auto_overall'); assert.equal(Number(r.s), 75); assert.ok(r.at);
  const h = (await raw(`select note from application_stage_history where application_id = $1 and to_stage = 'shortlisted'`, [id])).rows[0];
  assert.match(h.note, /Overall 75% \(resume 80% \+ AI interview 70%\) - at or above the 65% mark: moved to Shortlisted \(ATS\)/);
  const n = (await raw(`select message from notifications where application_id = $1 and type = 'AI_INTERVIEW_COMPLETED'`, [id])).rows[0];
  assert.match(n.message, /Overall 75%.*moved to Shortlisted/);
  const shown = (await c.get('/api/bootstrap')).body.data.applications.find((a) => a.id === id);
  assert.equal(shown.atsPushedVia, 'auto_overall'); assert.equal(shown.overallScore, 75);
});

test('65 is the mark itself; 64 is not enough; a strong interview cannot carry a very weak resume past it', async () => {
  const at65 = await application(40); await record(at65.id, 90);              // (40+90)/2 = 65
  assert.equal((await row(at65.id)).stage, 'shortlisted', 'exactly 65 moves');
  const at64 = await application(60); await record(at64.id, 68);              // 64
  const r64 = await row(at64.id);
  assert.equal(r64.o, 64); assert.equal(r64.stage, 'ai_interview_done', 'below the mark: for recruiter review');
  assert.equal(r64.at, null, 'not pushed');
  const weak = await application(20); await record(weak.id, 100);             // 60
  assert.equal((await row(weak.id)).stage, 'ai_interview_done');
  const n = (await raw(`select message from notifications where application_id = $1 and type = 'AI_INTERVIEW_COMPLETED'`, [at64.id])).rows[0];
  assert.match(n.message, /Overall 64%.*Below the 65% mark/);
});

test('no scored resume yet: the interview alone is the overall', async () => {
  const hi = await application(null); const out = await record(hi.id, 70);
  assert.equal(out.resume, null); assert.equal(out.overall, 70);
  assert.equal((await row(hi.id)).stage, 'shortlisted');
  const lo = await application(null); await record(lo.id, 60);
  assert.equal((await row(lo.id)).stage, 'ai_interview_done');
  /* an unreadable resume is "no score", not a zero */
  const un = await application(null);
  await raw(`insert into candidate_resume_scores (candidate_id, status) values ($1, 'unreadable')`, [un.c.id]);
  assert.equal((await record(un.id, 66)).overall, 66);
});

test('the screening score alone no longer moves anybody', async () => {
  const { id } = await application(90);
  await screening.screenApplication(id, { force: true });
  const score = Number((await raw(`select ai_score from applications where id = $1`, [id])).rows[0].ai_score);
  assert.ok(score >= 65, `a strong profile screens at 65 or more (got ${score})`);
  const r = await row(id);
  assert.equal(r.stage, 'applied', 'recommended, not moved: the interview comes first');
  assert.equal(r.at, null);
  const swept = await screening.screenPending({ limit: 50 });
  assert.equal((await row(id)).stage, 'applied', 'nor does the sweep: ' + JSON.stringify(swept));
});

test('walk-ins, later stages and a second result: not moved, not pulled back, the first push stands', async () => {
  const walk = await application(95, 'j_ov_walk', 'registered');
  assert.equal((await record(walk.id, 95)).passed, false);
  assert.equal((await row(walk.id)).stage, 'registered');
  const offer = await application(95, 'j_ov', 'offer_extended');
  await record(offer.id, 95);
  assert.equal((await row(offer.id)).stage, 'offer_extended');
  const twice = await application(80); await record(twice.id, 70);
  const first = (await row(twice.id)).at;
  await raw(`update candidate_resume_scores set total_score = 50 where candidate_id = $1`, [twice.c.id]);
  const again = await record(twice.id, 60);                                   // 55 now: below, but already Shortlisted
  assert.equal(again.moved, false);
  const r = await row(twice.id);
  assert.equal(r.stage, 'shortlisted', 'never moved back');
  assert.equal(new Date(r.at).getTime(), new Date(first).getTime()); assert.equal(Number(r.s), 75, 'the first push stands');
});

test('Talent Pool: who was moved to the ATS (ats=pushed | auto | manual)', async () => {
  const names = async (qs) => (await rec.get(`/api/candidates?limit=100&q=Overall&${qs}`)).body.candidates.map((x) => x.name).sort();
  const pushed = await names('ats=pushed');
  const auto = await names('ats=auto');
  assert.ok(pushed.length >= 4); assert.deepEqual(auto, pushed); assert.deepEqual(await names('ats=manual'), []);
  const m = await application(70);
  await raw(`update applications set stage = 'shortlisted', ats_pushed_at = now(), ats_pushed_via = 'send_to_ats' where id = $1`, [m.id]);
  assert.deepEqual(await names('ats=manual'), [(await raw(`select name from candidates where id = $1`, [m.c.id])).rows[0].name]);
  assert.equal((await names('ats=pushed')).length, pushed.length + 1);
  assert.equal((await names('ats=auto')).length, auto.length, 'a recruiter\'s button is not an automatic push');
  assert.ok((await names('ats=bogus')).length > pushed.length, 'an unknown value filters nothing');
});

test('what is already on file: the overall is filled in from finished interviews, moving nobody', async () => {
  const fs = await import('node:fs');
  const sql = fs.readFileSync(new URL('../../supabase/migrations/0147_overall_score_moves_to_ats.sql', import.meta.url), 'utf8');
  const backfill = sql.slice(sql.indexOf('/* what is already on file'));
  const { id, c } = await application(80);
  /* a finished interview on file from before: inserted past the answers check, as old rows are */
  await raw(`set session_replication_role = replica`);
  await raw(`insert into ai_interviews (id, application_id, candidate_id, job_id, status, overall_percentage) values ('aiv_ov_1', $1, $2, 'j_ov', 'completed', 70)`, [id, c.id]);
  await raw(`set session_replication_role = origin`);
  assert.equal((await row(id)).o, null);
  await raw(backfill.slice(0, backfill.indexOf('do $$')));
  const r = await row(id);
  assert.deepEqual([r.o, r.r, r.i], [75, 80, 70]);
  assert.equal(r.stage, 'applied', 'nobody is moved by the clean-up');
  assert.equal(r.at, null);
});

test('the 0145 clean-up still reads the history; the first push stands', async () => {
  const fs = await import('node:fs');
  const sql = fs.readFileSync(new URL('../../supabase/migrations/0145_ats_pushed.sql', import.meta.url), 'utf8');
  const backfill = sql.slice(sql.indexOf('/* what is already on file'));
  const scr = await application(null);
  await raw(`update applications set stage = 'shortlisted' where id = $1`, [scr.id]);
  await raw(`update application_stage_history set note = 'AI screening 67% (threshold 65) - recommend shortlist', created_at = now() - interval '3 days' where application_id = $1 and to_stage = 'shortlisted'`, [scr.id]);
  await raw(backfill);
  const r = (await raw(`select ats_pushed_via v, ats_pushed_score s from applications where id = $1`, [scr.id])).rows[0];
  assert.deepEqual([r.v, Number(r.s)], ['auto_screening', 67]);
});

test('shutdown', async () => {
  await new Promise((r) => server.close(r));
  const { stopBackgroundWork } = await import('../src/app.js');
  stopBackgroundWork();
  const { closePool } = await import('../src/db.js');
  await closePool();
  await dbh.stop?.();
});
