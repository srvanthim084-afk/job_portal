/**
 * Admin -> Availability: the four cards and the lists behind them.
 *
 *   Total Candidates     every candidate, once
 *   Attended Interviews  attendance RECORDED (interview Completed, AI interview finished,
 *                        walk-in attended) - a scheduled interview is not attendance
 *   Moved to ATS         a recorded move into the pipeline (application_stage_history);
 *                        Applied / Rejected are not; sample (is_demo) rows are not
 *   Not Looking          availability_status = 'not_looking'
 *
 * Counts are checked as differences from the database's own starting point, so the
 * seed rows do not matter; every candidate counts once however many records they have.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb, applyTestEnv, makeClient } from './harness.mjs';

const DB_PORT = 5603;
const API_PORT = 9873;
const base = `http://127.0.0.1:${API_PORT}`;
const PW = 'Cards123available';

let dbh, server, raw, admin, rec, cand;
let before;

async function staff(role, email, id) {
  const { hashPassword } = await import('../src/auth.js');
  const hash = await hashPassword(PW);
  const u = (await raw(`insert into users (email,password_hash,role) values ($1,$2,$3) returning id`, [email, hash, role])).rows[0].id;
  if (role === 'recruiter') await raw(`insert into recruiters (id,name,email,company_id,user_id) values ($1,$2,$3,'co_av',$4)`, [id, 'Rec ' + id, email, u]);
  if (role === 'admin') await raw(`insert into admins (id,name,email,user_id) values ($1,'Admin',$2,$3)`, [id, email, u]);
  const c = makeClient(base);
  await c.get('/api/health');
  const r = await c.post('/api/auth/login', { email, password: PW, role });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return c;
}
const person = (id, name, extra = {}) => raw(
  `insert into candidates (id, name, email, phone, owner_recruiter_id, availability_status) values ($1,$2,$3,$4,$5,$6)`,
  [id, name, `${id}@avcards.test`, '98' + String(Math.abs(hashCode(id))).padStart(8, '0').slice(0, 8), extra.owner || null, extra.availability || 'unknown']);
function hashCode(s) { let x = 0; for (const ch of s) x = (x * 31 + ch.charCodeAt(0)) | 0; return x; }
const app = (id, cid, job, stage, extra = '') => raw(
  `insert into applications (id, candidate_id, job_id, stage, applied_at, match_score${extra ? ', is_demo' : ''}) values ($1,$2,$3,$4,now(),70${extra ? ', true' : ''})`,
  [id, cid, job, stage]);
const summary = async (c = admin) => (await c.get('/api/admin/availability/summary'));
const list = async (q, c = admin) => (await c.get('/api/admin/availability/candidates?' + q));

test('boot', async () => {
  dbh = await startTestDb(DB_PORT);
  applyTestEnv(dbh.url, { PUBLIC_ORIGIN: base, DISABLE_BACKGROUND_WORK: 'true', AI_API_KEY: '', OUTBOUND_ALLOWLIST: '' });
  raw = (sql, params) => dbh.db.query(sql, params);
  await raw(`insert into companies (id, name) values ('co_av', 'Cards Co')`);
  const { createApp } = await import('../src/app.js');
  const appx = createApp({ logger: { error() {}, log() {} } });
  await new Promise((r) => { server = appx.listen(API_PORT, r); });
  admin = await staff('admin', 'admin.cards@tl-sink.local', 'adm_av');
  rec = await staff('recruiter', 'rec.cards@tl-sink.local', 'r_av1');
  await staff('recruiter', 'rec2.cards@tl-sink.local', 'r_av2');

  const s = await summary();
  assert.equal(s.status, 200, JSON.stringify(s.body));
  before = s.body.summary;
  for (const k of ['totalCandidates', 'attendedInterviews', 'movedToAts', 'notLooking']) assert.equal(typeof before[k], 'number', k);

  for (const j of ['jav1', 'jav2']) {
    await raw(`insert into jobs (id,title,company_id,recruiter_id,location,mode,exp_label,status,skills,description,published_at)
               values ($1,$2,'co_av','r_av1','Hyderabad','Onsite','1-3 yrs','open',$3,'A role.',now())`, [j, 'Avcard Role ' + j, ['Excel']]);
  }

  /* A: two applications, one moved to Shortlisted -> Moved to ATS, once */
  await person('avA', 'Avcard Asha', { owner: 'r_av1', availability: 'actively_looking' });
  await app('apA1', 'avA', 'jav1', 'applied');
  await raw(`update applications set stage='shortlisted' where id='apA1'`);
  await app('apA2', 'avA', 'jav2', 'applied');
  /* B: an interview SCHEDULED only -> not attended */
  await person('avB', 'Avcard Bala', { owner: 'r_av2' });
  await app('apB', 'avB', 'jav1', 'applied');
  await raw(`insert into interviews (id, candidate_id, job_id, application_id, type, scheduled_date, status) values ('ivB','avB','jav1','apB','HR Round', current_date + 2, 'Scheduled')`);
  /* C: an interview marked Completed -> attended */
  await person('avC', 'Avcard Chitra');
  await app('apC', 'avC', 'jav1', 'applied');
  await raw(`insert into interviews (id, candidate_id, job_id, application_id, type, scheduled_date, status) values ('ivC','avC','jav1','apC','HR Round', current_date - 1, 'Scheduled')`);
  await raw(`update interviews set status='Completed' where id='ivC'`);
  /* D: an AI interview finished -> attended */
  await person('avD', 'Avcard Deepa');
  await app('apD', 'avD', 'jav2', 'applied');
  await raw(`insert into ai_interviews (id, application_id, candidate_id, job_id, status, questions_asked, questions_answered)
             values ('aiD','apD','avD','jav2','completed', 5, 5)`);
  /* D2: an AI interview only started -> not attended */
  await person('avD2', 'Avcard Dinesh');
  await app('apD2', 'avD2', 'jav2', 'applied');
  await raw(`insert into ai_interviews (id, application_id, candidate_id, job_id, status, questions_asked, questions_answered)
             values ('aiD2','apD2','avD2','jav2','in_progress', 1, 0)`);
  /* E: walk-in attendance recorded on the application -> attended */
  await person('avE', 'Avcard Esha');
  await app('apE', 'avE', 'jav1', 'applied');
  await raw(`update applications set attended_at = now() where id='apE'`);
  /* F: applied, then rejected -> NOT moved to ATS */
  await person('avF', 'Avcard Farhan');
  await app('apF', 'avF', 'jav1', 'applied');
  await raw(`update applications set stage='rejected' where id='apF'`);
  /* G: not looking */
  await person('avG', 'Avcard Gita', { availability: 'not_looking' });
  /* H: a Completed interview AND a finished AI interview -> attended ONCE */
  await person('avH', 'Avcard Hari', { owner: 'r_av1' });
  await app('apH', 'avH', 'jav2', 'applied');
  await raw(`insert into interviews (id, candidate_id, job_id, application_id, type, scheduled_date, status) values ('ivH','avH','jav2','apH','Technical', current_date - 3, 'Completed')`);
  await raw(`insert into ai_interviews (id, application_id, candidate_id, job_id, status, questions_asked, questions_answered)
             values ('aiH','apH','avH','jav2','evaluated', 5, 5)`);
  /* I: a SAMPLE application moved to Shortlisted -> not evidence */
  await person('avI', 'Avcard Indu');
  await app('apI', 'avI', 'jav1', 'applied', 'demo');
  await raw(`update applications set stage='shortlisted' where id='apI'`);
});

test('the four counts are the database, each candidate once', async () => {
  const s = (await summary()).body.summary;
  assert.equal(s.totalCandidates - before.totalCandidates, 10, 'ten new candidates');
  assert.equal(s.attendedInterviews - before.attendedInterviews, 4, 'C, D, E, H - not B (scheduled), not D2 (in progress)');
  assert.equal(s.movedToAts - before.movedToAts, 1, 'A only - not F (rejected), not I (sample)');
  assert.equal(s.notLooking - before.notLooking, 1, 'G');
  /* the cards agree with the database, counted independently */
  const total = (await raw(`select count(*)::int n from candidates`)).rows[0].n;
  const notLooking = (await raw(`select count(*)::int n from candidates where availability_status='not_looking'`)).rows[0].n;
  assert.equal(s.totalCandidates, total);
  assert.equal(s.notLooking, notLooking);
});

test('each card lists exactly its candidates', async () => {
  const names = async (metric) => {
    const r = await list(`metric=${metric}&q=Avcard&pageSize=100`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.rows.map((x) => x.name).sort();
  };
  assert.deepEqual(await names('attended'), ['Avcard Chitra', 'Avcard Deepa', 'Avcard Esha', 'Avcard Hari']);
  assert.deepEqual(await names('ats'), ['Avcard Asha']);
  assert.deepEqual(await names('not_looking'), ['Avcard Gita']);
  assert.equal((await names('total')).length, 10);

  /* the totals of the lists equal the cards */
  const s = (await summary()).body.summary;
  assert.equal((await list('metric=attended')).body.total, s.attendedInterviews);
  assert.equal((await list('metric=ats')).body.total, s.movedToAts);
  assert.equal((await list('metric=not_looking')).body.total, s.notLooking);
  assert.equal((await list('metric=total')).body.total, s.totalCandidates);
});

test('the row details', async () => {
  const rows = (await list('metric=total&q=Avcard&pageSize=100')).body.rows;
  const by = Object.fromEntries(rows.map((x) => [x.name, x]));
  assert.equal(by['Avcard Bala'].interview.status, 'Scheduled');
  assert.equal(by['Avcard Bala'].interview.attended, false);
  assert.equal(by['Avcard Chitra'].interview.status, 'Interview completed');
  assert.equal(by['Avcard Chitra'].interview.attended, true);
  assert.equal(by['Avcard Deepa'].interview.status, 'AI interview completed');
  assert.equal(by['Avcard Esha'].interview.status, 'Walk-in attended');
  assert.ok(by['Avcard Asha'].ats && by['Avcard Asha'].ats.movedAt, 'moved date');
  assert.equal(by['Avcard Asha'].recruiterName, 'Rec r_av1');
  assert.ok(by['Avcard Asha'].job.startsWith('Avcard Role'));
  assert.equal(by['Avcard Farhan'].ats, null);
  assert.equal(by['Avcard Gita'].availability.label, 'Not looking');
  assert.equal(by['Avcard Gita'].job, null);
  assert.ok(by['Avcard Asha'].email && by['Avcard Asha'].phone);
});

test('search, filters and pages', async () => {
  assert.deepEqual((await list('metric=total&q=Chitra')).body.rows.map((x) => x.id), ['avC']);
  assert.deepEqual((await list('metric=total&q=avE@avcards')).body.rows.map((x) => x.id), ['avE']);
  const r1 = (await list('metric=total&q=Avcard&recruiterId=r_av1&pageSize=100')).body.rows.map((x) => x.id).sort();
  assert.ok(r1.includes('avA') && r1.includes('avH') && !r1.includes('avB'), 'owner first: B belongs to r_av2');
  assert.deepEqual((await list('metric=total&q=Avcard&recruiterId=r_av2')).body.rows.map((x) => x.id), ['avB']);
  assert.deepEqual((await list('metric=total&q=Avcard&availability=not_looking')).body.rows.map((x) => x.id), ['avG']);
  assert.deepEqual((await list('metric=total&q=Avcard&stage=rejected')).body.rows.map((x) => x.id), ['avF']);
  const p1 = (await list('metric=total&q=Avcard&pageSize=5&page=1')).body;
  const p2 = (await list('metric=total&q=Avcard&pageSize=5&page=2')).body;
  assert.equal(p1.total, 10); assert.equal(p1.rows.length, 5); assert.equal(p2.rows.length, 5);
  assert.equal(new Set([...p1.rows, ...p2.rows].map((x) => x.id)).size, 10, 'no row twice across pages');
  const f = p1.filters;
  assert.ok(f.recruiters.some((x) => x.id === 'r_av1') && f.availability.some((x) => x.id === 'not_looking') && f.stages.some((x) => x.id === 'shortlisted'));
  /* a search with SQL wildcards is text */
  assert.equal((await list('metric=total&q=%25')).body.total, 0);
});

test('Admin only', async () => {
  assert.equal((await summary(rec)).status, 403);
  assert.equal((await list('metric=total', rec)).status, 403);
  cand = makeClient(base);
  await cand.get('/api/health');
  const reg = await cand.post('/api/auth/register', { name: 'Avcard Self', email: `self.${Date.now().toString(36)}@mailbox-teamlink-tests.in`,
    password: PW, phone: '9300077123', preferredLocation: 'Hyderabad', expectedCtc: 4, noticePeriod: 'Immediate', preferredWorkModes: ['Hybrid'] });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  assert.equal((await summary(cand)).status, 403);
  assert.equal((await list('metric=total', cand)).status, 403);
  const anon = makeClient(base);
  await anon.get('/api/health');
  assert.equal((await summary(anon)).status, 401);
});

test('the candidate record opens for Admin', async () => {
  const r = await admin.get('/api/ats/candidates/avA/record');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.record.name, 'Avcard Asha');
  assert.equal(r.body.record.applications.length, 2);
});

test('teardown', async () => {
  await new Promise((r) => server.close(r));
  const { stopBackgroundWork } = await import('../src/app.js');
  stopBackgroundWork();
  const { closePool } = await import('../src/db.js');
  await closePool();
  await dbh.stop();
});
