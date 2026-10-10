/**
 * A walk-in whose date was TYPED ("6 and 7 october 2026") ends too (0137).
 *
 * The live portal had such a walk-in still taking applications three days after
 * the drive: walkin_ends_at() understood 2026-10-07 only. Checked here against a
 * real Postgres with RLS on:
 *   - walkin_last_date() reads the formats people type, and closes nothing on a guess
 *   - a time that is not a time ("end 4:00") never breaks a 2026-10-07 date
 *   - the Jobs list (jobs_open) drops an ended typed walk-in and keeps one still to come
 *   - every apply path refuses it with WALKIN_COMPLETED and the walk-in's date
 *   - the job's JSON says walkinStatus 'closed', so the page shows "Walk-in completed"
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb, applyTestEnv, makeClient } from './harness.mjs';

const DB_PORT = 5607;
const API_PORT = 9909;

let dbh, server, base, raw, cand;
const IST = 330 * 60 * 1000;
const year = new Date(Date.now() + IST).getUTCFullYear();
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
/** "6 and 7 <month> <year>" for a day `plus` days from today (IST), typed the way the live job was. */
const typed = (plus) => {
  const d = new Date(Date.now() + IST + plus * 86400000);
  const prev = new Date(d.getTime() - 86400000);
  return `${prev.getUTCDate()} and ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};
const one = async (sql, p) => (await raw(sql, p)).rows[0];

test('boot', async () => {
  dbh = await startTestDb(DB_PORT);
  applyTestEnv(dbh.url, {
    PUBLIC_ORIGIN: `http://127.0.0.1:${API_PORT}`,
    DISABLE_BACKGROUND_WORK: 'true', AI_API_KEY: '',
    EMAIL_API_KEY: '', EMAIL_SMTP_HOST: '', EMAIL_SMTP_USER: '', EMAIL_SMTP_PASS: '',
    EMAILJS_SERVICE_ID: '', EMAILJS_TEMPLATE_ID: '', EMAILJS_PUBLIC_KEY: '', EMAILJS_PRIVATE_KEY: '',
    SMS_API_KEY: '', WHATSAPP_API_KEY: '', APPLY_RATE_PER_HOUR: '500',
  });
  raw = (sql, params) => dbh.db.query(sql, params);
  await raw(`insert into companies (id, name) values ('co_td', 'Typed Dates Co')`);
  const job = (id, date, from, to) => raw(
    `insert into jobs (id, title, company_id, location, mode, status, posting_kind, employment_type,
                       walkin_date, walkin_from, walkin_to, walkin_venue, walkin_address, walkin_contact, walkin_phone, published_at)
     values ($1, 'HR Recruiter Walk-in', 'co_td', 'KPHB', 'Onsite', 'open', 'walkin', 'Walk-in',
             $2, $3, $4, 'KPHB beside Lulu mall', 'Manjeera Trinity, KPHB', 'Ravi', '9876500011', now())`,
    [id, date, from, to]);
  await job('j_td_over', typed(-3), 'starts 9:30', 'end 4:00');   // as on the live portal
  await job('j_td_soon', typed(4), 'starts 9:30', 'end 4:00');
  await job('j_td_iso_over', new Date(Date.now() + IST - 2 * 86400000).toISOString().slice(0, 10), '10:00', 'end 4:00');

  const { createApp } = await import('../src/app.js');
  const app = createApp({ logger: { error() {}, log() {} } });
  await new Promise((r) => { server = app.listen(API_PORT, r); });
  base = `http://127.0.0.1:${API_PORT}`;

  cand = makeClient(base);
  await cand.get('/api/health');
  const r = await cand.post('/api/auth/register', {
    name: 'Typed Date Candidate', email: `typed.${Date.now().toString(36)}@tl-sink.local`, password: 'Walkin123jobs', phone: '9876543299',
    preferredLocation: 'Hyderabad', expectedCtc: 4, noticePeriod: 'Immediate', preferredWorkModes: ['Work From Office'],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
});

test('walkin_last_date reads what people type; nothing is closed on a guess', async () => {
  const cases = [
    [`6 and 7 october ${year}`, `${year}-10-07`],
    [`6th & 7th Oct ${year}`, `${year}-10-07`],
    [`October 6-7, ${year}`, `${year}-10-07`],
    [`30 september ${year} to 2 october ${year}`, `${year}-10-02`],
    [`october 30 - november 2, ${year}`, `${year}-11-02`],
    [`07/10/${year}`, `${year}-10-07`],
    [`7.10.${year}`, `${year}-10-07`],
    [`${year}-10-07`, `${year}-10-07`],
    [`Sat, 10 Oct ${year}`, `${year}-10-10`],
    ['6 and 7 october', null],          // no year: not a date anyone can close on
    ['next monday', null],
    ['', null],
    [`31 february ${year}`, null],      // not a calendar day
  ];
  for (const [text, want] of cases) {
    const got = (await one(`select walkin_last_date($1)::text d`, [text])).d;
    assert.equal(got, want, `walkin_last_date(${JSON.stringify(text)})`);
  }
});

test('walkin_ends_at: typed dates end that day at 23:59 IST; a bad time never breaks an ISO date', async () => {
  const at = async (d, t) => (await one(`select to_char(walkin_ends_at($1,$2) at time zone 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') v`, [d, t])).v;
  assert.equal(await at(`6 and 7 october ${year}`, 'end 4:00'), `${year}-10-07 23:59`);
  assert.equal(await at(`${year}-10-07`, 'end 4:00'), `${year}-10-07 23:59`, 'not an error, and not four in the morning');
  assert.equal(await at(`${year}-10-07`, '16:00'), `${year}-10-07 16:00`);
  assert.equal(await at(`${year}-10-07`, '4:00 pm'), `${year}-10-07 16:00`);
  assert.equal(await at(`${year}-10-07`, ''), `${year}-10-07 23:59`);
  assert.equal(await at('6 and 7 october', 'end 4:00'), null);
});

test('the Jobs list drops the ended typed walk-in and keeps the one still to come', async () => {
  const ids = (await raw(`select id from jobs_open where id like 'j_td_%'`)).rows.map((r) => r.id).sort();
  assert.deepEqual(ids, ['j_td_soon']);
  assert.equal((await one(`select walkin_apply_check('j_td_over') v`)).v, 'closed');
  assert.equal((await one(`select walkin_apply_check('j_td_soon') v`)).v, 'ok');
  assert.equal((await one(`select walkin_completed('j_td_over') d`)).d, typed(-3));
  assert.equal((await one(`select walkin_completed('j_td_soon') d`)).d, null);
});

test('the job says it is closed, so the page shows "Walk-in completed"', async () => {
  const over = await cand.get('/api/jobs/j_td_over');
  assert.equal(over.status, 200, JSON.stringify(over.body));
  assert.equal(over.body.job.walkinStatus, 'closed');
  assert.ok(over.body.job.walkinEndsAt, 'the end time is given');
  const soon = await cand.get('/api/jobs/j_td_soon');
  assert.equal(soon.body.job.walkinStatus, 'open');
});

test('every apply path refuses it with WALKIN_COMPLETED and the date', async () => {
  for (const [path, body] of [
    ['/api/applications', { jobId: 'j_td_over' }],
    ['/api/applications/one-click', { jobId: 'j_td_over' }],
    ['/api/applications', { jobId: 'j_td_iso_over' }],
  ]) {
    const r = await cand.post(path, body);
    assert.equal(r.status, 409, `${path} ${body.jobId}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error.code, 'WALKIN_COMPLETED');
    assert.equal(r.body.error.details.reason, 'walkin_closed', 'the existing reason stays');
    assert.match(r.body.error.message, /dates are completed, so applications are closed/);
  }
  const typedMsg = (await cand.post('/api/applications', { jobId: 'j_td_over' })).body.error.message;
  assert.ok(typedMsg.includes(typed(-3)), typedMsg);
  assert.equal((await one(`select count(*)::int n from applications where job_id like 'j_td_%over'`)).n, 0, 'nothing was saved');
  // the walk-in still to come takes the application
  const ok = await cand.post('/api/applications', { jobId: 'j_td_soon' });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
});

test('shutdown', async () => {
  await new Promise((r) => server.close(r));
  const { stopBackgroundWork } = await import('../src/app.js');
  stopBackgroundWork?.();
  const { closePool } = await import('../src/db.js');
  await closePool();
  await dbh.stop?.();
});
