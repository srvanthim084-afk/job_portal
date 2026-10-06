/**
 * Screening questions (0097), end to end against a real Postgres with RLS.
 *
 * Self-contained: makes its own companies, recruiters, client, jobs and
 * candidates. The client company has an unusual name on purpose, so a
 * grep for it across everything a candidate can see means something.
 *
 * Nothing leaves the machine: email and SMS go to the mock provider,
 * WhatsApp to a closed port.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb, applyTestEnv, makeClient, startMockProvider } from './harness.mjs';

const DB_PORT = 5467;
const API_PORT = 9987;
const MOCK_PORT = 9864;
const CLIENT_NAME = 'Zephyrine Quantum Foods';
const CLIENT_WORD = /zephyrine/i;

let dbh, server, mock, base, raw, svc, Q;
let recruiter, recruiter2, admin, client;
const sessions = {};

async function staff(email, role, table, id, company) {
  const { hashPassword } = await import('../src/auth.js');
  const hash = await hashPassword('Screen123pass');
  const u = (await raw(`insert into users (email,password_hash,role) values ($1,$2,$3) returning id`,
    [email, hash, role])).rows[0].id;
  if (table === 'recruiters' || table === 'client_users') {
    await raw(`insert into ${table} (id, user_id, name, email, company_id) values ($1,$2,$3,$4,$5)`,
      [id, u, `${role} ${id}`, email, company]);
  } else if (table === 'admins') {
    await raw(`insert into admins (id, user_id, name, email) values ($1,$2,$3,$4)`, [id, u, 'Admin Sq', email]);
  }
  const c = makeClient(base);
  await c.get('/api/health');
  const r = await c.post('/api/auth/login', { email, password: 'Screen123pass', role });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  sessions[id] = { userId: u, role, profileId: id };
  return c;
}

async function candidate(name, email, phone) {
  const c = makeClient(base);
  await c.get('/api/health');
  const r = await c.post('/api/auth/register', {
    name, email, password: 'Screen123cand', phone,
    preferredLocation: 'Hyderabad', expectedCtc: 7, noticePeriod: '30 days',
    preferredWorkModes: ['Work From Office'],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  c.id = r.body.candidateId;
  return c;
}

let jobSeq = 0;
async function job(fields = {}) {
  jobSeq += 1;
  const id = fields.id || `jsq${jobSeq}`;
  await raw(`insert into jobs (id, title, company_id, location, mode, exp_label, pay_label, salary_min, salary_max,
                               employment_type, status, skills, recruiter_id, published_at)
             values ($1,$2,$3,$4,'Onsite','2-5 yrs','₹6-9 LPA',6,$5,'Full-time','open',$6,$7, now())`,
    [id, fields.title || 'Java Developer', fields.company || 'co_zq', fields.location || 'Hyderabad',
     fields.salaryMax ?? 9, fields.skills || ['Java', 'Spring Boot', 'SQL'], fields.recruiter || 'r_sq1']);
  return id;
}

const qs = async (jobId) => (await raw(
  `select * from job_screening_questions where job_id=$1 order by position`, [jobId])).rows;

test('boot', async () => {
  dbh = await startTestDb(DB_PORT);
  mock = await startMockProvider(MOCK_PORT);
  applyTestEnv(dbh.url, {
    PUBLIC_ORIGIN: `http://127.0.0.1:${API_PORT}`,
    DISABLE_BACKGROUND_WORK: 'true',
    SMS_API_URL: `http://127.0.0.1:${MOCK_PORT}/sms`,
    EMAIL_API_KEY: 'test-key',
    EMAIL_FROM: 'screening@teamlink.example',
    EMAIL_API_URL: `http://127.0.0.1:${MOCK_PORT}/email`,
    EMAIL_SMTP_HOST: '', EMAIL_SMTP_USER: '', EMAIL_SMTP_PASS: '',
    EMAILJS_SERVICE_ID: '', EMAILJS_TEMPLATE_ID: '', EMAILJS_PUBLIC_KEY: '', EMAILJS_PRIVATE_KEY: '',
    OUTBOUND_ALLOWLIST: '',
    AI_API_KEY: '',
  });
  raw = (sql, params) => dbh.db.query(sql, params);
  await raw(`insert into companies (id, name) values ('co_zq', $1), ('co_other', 'Other Works')`, [CLIENT_NAME]);

  const { createApp } = await import('../src/app.js');
  svc = await import('../src/screening/service.js');
  Q = await import('../src/screening/questions.js');
  const app = createApp({ logger: { error() {}, log() {} } });
  await new Promise((r) => { server = app.listen(API_PORT, r); });
  base = `http://127.0.0.1:${API_PORT}`;

  recruiter = await staff('rec.sq@tl-sink.local', 'recruiter', 'recruiters', 'r_sq1', 'co_zq');
  recruiter2 = await staff('rec2.sq@tl-sink.local', 'recruiter', 'recruiters', 'r_sq2', 'co_other');
  admin = await staff('admin.sq@tl-sink.local', 'admin', 'admins', 'a_sq', null);
  client = await staff('client.sq@tl-sink.local', 'client', 'client_users', 'c_sq', 'co_zq');
});

/* ------------------------------------------------------------------ *
 * questions on a job
 * ------------------------------------------------------------------ */

test('every new job gets the six standard questions, with the job location filled in', async () => {
  const id = await job({ location: 'Nellore' });
  const rows = await qs(id);
  assert.equal(rows.length, 6);
  assert.deepEqual(rows.map((r) => r.std_key),
    ['notice_period', 'current_ctc', 'expected_ctc', 'current_location', 'relocate', 'other_consultancy']);
  assert.match(rows.find((r) => r.std_key === 'relocate').text, /Nellore/);
  assert.equal(rows.find((r) => r.std_key === 'other_consultancy').share_with_client, false);
  for (const r of rows) assert.doesNotMatch(r.text, CLIENT_WORD);
});

test('create and edit questions: six is the limit, enforced in SQL too', async () => {
  const id = await job();
  const set = (await recruiter.get(`/api/jobs/${id}/screening-questions`)).body;
  assert.equal(set.editable, true);
  assert.equal(set.questions.length, 6);

  // Swap two standard questions for job-specific ones, one of them a must-have.
  const next = set.questions.filter((q) => !['current_location', 'other_consultancy'].includes(q.stdKey));
  next.push({ text: 'Years of hands-on Java experience?', type: 'number', options: { min: 0, max: 40, unit: 'years' },
    isKnockout: true, knockoutRule: { min: 3 }, weight: 8 });
  next.push({ text: 'AWS certified?', type: 'yes_no', weight: 4 });
  const put = await recruiter.put(`/api/jobs/${id}/screening-questions`, { questions: next });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(put.body.questions.length, 6);

  const seven = [...next, { text: 'One too many?', type: 'yes_no' }];
  const over = await recruiter.put(`/api/jobs/${id}/screening-questions`, { questions: seven });
  assert.equal(over.status, 400);
  assert.match(over.body.error.message, /at most 6/);

  await assert.rejects(raw(
    `insert into job_screening_questions (id, job_id, text, type) values ('sq_x7', $1, 'Seventh?', 'yes_no')`, [id]),
    /screening_question_limit/);
});

test('a question naming the client, or the word "client", is refused; >2 must-haves warns', async () => {
  const id = await job();
  const named = await recruiter.put(`/api/jobs/${id}/screening-questions`, { questions: [
    { text: 'Why do you want to work at Zephyrine?', type: 'short_text' }] });
  assert.equal(named.status, 400);
  assert.match(JSON.stringify(named.body.error.details), /do not name the company/);

  const word = await recruiter.put(`/api/jobs/${id}/screening-questions`, { questions: [
    { text: 'Have you worked with this client before?', type: 'yes_no' }] });
  assert.equal(word.status, 400);

  const many = await recruiter.put(`/api/jobs/${id}/screening-questions`, { questions: [
    { text: 'A?', type: 'yes_no', isKnockout: true, knockoutRule: { equals: 'yes' } },
    { text: 'B?', type: 'yes_no', isKnockout: true, knockoutRule: { equals: 'yes' } },
    { text: 'C?', type: 'yes_no', isKnockout: true, knockoutRule: { equals: 'yes' } }] });
  assert.equal(many.status, 200);
  assert.ok(many.body.warnings.some((w) => /lowers applications/.test(w)));
});

test('another company\'s recruiter cannot read the rules or change the questions', async () => {
  const id = await job();
  const put = await recruiter2.put(`/api/jobs/${id}/screening-questions`, { questions: [] });
  assert.ok([403, 404].includes(put.status), String(put.status));
  const read = await recruiter2.get(`/api/jobs/${id}/screening-questions`);
  assert.ok([200, 404].includes(read.status), String(read.status)); /* 0117: a job outside the scope is not there at all */
  if (read.status === 200) assert.equal(read.body.questions.length, 0, 'no rules for a job that is not theirs');
  if (read.status === 200) assert.equal(read.body.editable, false);
  assert.equal((await qs(id)).length, 6, 'nothing changed');
});

test('a candidate reads the questions without the must-have rules, weights or the client name', async () => {
  const id = await job();
  const rows = await qs(id);
  await recruiter.put(`/api/jobs/${id}/screening-questions`, { questions: rows.map((r) => ({
    id: r.id, stdKey: r.std_key, text: r.text, type: r.type, options: r.options, weight: r.weight,
    isKnockout: r.std_key === 'expected_ctc', knockoutRule: r.std_key === 'expected_ctc' ? { max: 12 } : null,
    shareWithClient: r.share_with_client })) });
  const cand = await candidate('Reader Cand', 'reader.sq@tl-sink.local', '9100000001');
  const out = await cand.get(`/api/jobs/${id}/screening-questions`);
  assert.equal(out.status, 200);
  const text = JSON.stringify(out.body);
  assert.equal(out.body.questions.length, 6);
  assert.doesNotMatch(text, /knockout|isKnockout|weight|"max":12/i);
  assert.doesNotMatch(text, CLIENT_WORD);
  // Pre-filled from the profile: notice 30 days, expected CTC 7.
  const exp = out.body.questions.find((q) => q.stdKey === 'expected_ctc');
  assert.equal(out.body.prefill[exp.id].value, 7);
  const notice = out.body.questions.find((q) => q.stdKey === 'notice_period');
  assert.equal(out.body.prefill[notice.id].value, '30 days');
});

/* ------------------------------------------------------------------ *
 * rules, unit-level
 * ------------------------------------------------------------------ */

test('knock-out rules: <=, >=, equals, in, and notice in days', () => {
  const num = { type: 'number', isKnockout: true, options: {} };
  assert.equal(Q.evaluateKnockout({ ...num, knockoutRule: { max: 12 } }, { value: 12 }), false);
  assert.equal(Q.evaluateKnockout({ ...num, knockoutRule: { max: 12 } }, { value: 12.5 }), true);
  assert.equal(Q.evaluateKnockout({ ...num, knockoutRule: { min: 3 } }, { value: 3 }), false);
  assert.equal(Q.evaluateKnockout({ ...num, knockoutRule: { min: 3 } }, { value: 2 }), true);
  const yn = { type: 'yes_no', isKnockout: true, knockoutRule: { equals: 'yes' } };
  assert.equal(Q.evaluateKnockout(yn, { value: 'yes' }), false);
  assert.equal(Q.evaluateKnockout(yn, { value: 'no' }), true);
  const ch = { type: 'single_choice', isKnockout: true, knockoutRule: { in: ['Immediate', '15 days'] } };
  assert.equal(Q.evaluateKnockout(ch, { value: '15 days' }), false);
  assert.equal(Q.evaluateKnockout(ch, { value: '60 days' }), true);
  const notice = { type: 'single_choice', stdKey: 'notice_period', isKnockout: true, knockoutRule: { maxDays: 30 } };
  assert.equal(Q.evaluateKnockout(notice, { value: '30 days' }), false);
  assert.equal(Q.evaluateKnockout(notice, { value: '60 days' }), true);
  const now = Date.parse('2026-10-03T00:00:00Z');
  assert.equal(Q.evaluateKnockout(notice, { value: 'Serving notice', detail: '2026-10-20' }, now), false);
  assert.equal(Q.evaluateKnockout(notice, { value: 'Serving notice', detail: '2026-12-20' }, now), true);
  assert.equal(Q.combineScores(60, 100, 20), 68);
  assert.equal(Q.combineScores(60, null, 20), 60);
});

test('answers are validated per type, and a bad set creates no application (atomic)', async () => {
  const id = await job();
  const cand = await candidate('Valid Cand', 'valid.sq@tl-sink.local', '9100000002');
  const set = (await cand.get(`/api/jobs/${id}/screening-questions`)).body.questions;
  const by = (k) => set.find((q) => q.stdKey === k).id;
  const good = {
    [by('notice_period')]: { value: '30 days' }, [by('current_ctc')]: 5, [by('expected_ctc')]: 8,
    [by('current_location')]: 'Hyderabad', [by('relocate')]: 'yes', [by('other_consultancy')]: 'no',
  };
  const answers = (over) => Object.entries({ ...good, ...over }).map(([questionId, answer]) => ({ questionId, answer }));

  const cases = [
    [{ [by('relocate')]: 'maybe' }, /yes or no/],
    [{ [by('expected_ctc')]: -1 }, /0 or more/],
    [{ [by('expected_ctc')]: 'lots' }, /number/],
    [{ [by('notice_period')]: { value: 'Next year' } }, /options/],
    [{ [by('notice_period')]: { value: 'Serving notice' } }, /Last working day/],
    [{ [by('current_location')]: '' }, /required/],
  ];
  for (const [over, msg] of cases) {
    const r = await cand.post('/api/applications', { jobId: id, answers: answers(over) });
    assert.equal(r.status, 400, JSON.stringify(over));
    assert.match(JSON.stringify(r.body.error.details), msg);
  }
  const missing = await cand.post('/api/applications', { jobId: id, answers: answers({}).slice(1) });
  assert.equal(missing.status, 400);
  const n = (await raw(`select count(*)::int n from applications where job_id=$1`, [id])).rows[0].n;
  assert.equal(n, 0, 'a refused answer must not leave an application behind');

  const ok = await cand.post('/api/applications', { jobId: id, answers: answers({}), saveScreeningDefaults: true });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const app = (await raw(`select * from applications where id=$1`, [ok.body.application.id])).rows[0];
  assert.equal(app.screening_status, 'answered');
  const stored = (await raw(`select count(*)::int n from application_screening_answers where application_id=$1`, [app.id])).rows[0].n;
  assert.equal(stored, 6);
  const d = (await raw(`select * from candidate_screening_defaults where candidate_id=$1`, [cand.id])).rows[0];
  assert.equal(Number(d.expected_ctc), 8, 'consented defaults are saved');
});

/* ------------------------------------------------------------------ *
 * knock-outs and scoring
 * ------------------------------------------------------------------ */

let koJob, koApp, passApp, candKo, candPass;

test('a failed must-have: normal success for the candidate, red flag for the recruiter, never auto-shortlisted', async () => {
  koJob = await job({ title: 'Spring Engineer' });
  const rows = await qs(koJob);
  await recruiter.put(`/api/jobs/${koJob}/screening-questions`, { questions: rows.map((r) => ({
    id: r.id, stdKey: r.std_key, text: r.text, type: r.type, options: r.options, weight: r.weight,
    isKnockout: r.std_key === 'relocate', knockoutRule: r.std_key === 'relocate' ? { equals: 'yes' } : null,
    shareWithClient: r.std_key === 'other_consultancy' ? false : true })) });
  // Every score clears the bar, so only the knock-out can stop a shortlist.
  await raw(`update app_settings set value = value || '{"autoShortlistThreshold": 1}'::jsonb where key='ai'`);

  const set = async (c) => (await c.get(`/api/jobs/${koJob}/screening-questions`)).body.questions;
  const answer = (qsList, relocate) => qsList.map((q) => ({ questionId: q.id, answer:
    q.stdKey === 'notice_period' ? { value: 'Immediate' } : q.stdKey === 'current_ctc' ? 6
      : q.stdKey === 'expected_ctc' ? 8 : q.stdKey === 'current_location' ? 'Hyderabad'
        : q.stdKey === 'relocate' ? relocate : q.stdKey === 'other_consultancy' ? { value: 'yes', detail: 'Acme Corp' } : 'no' }));

  candKo = await candidate('Kiran Rao', 'ko.sq@tl-sink.local', '9100000003');
  const ko = await candKo.post('/api/applications', { jobId: koJob, answers: answer(await set(candKo), 'no') });
  assert.equal(ko.status, 201, JSON.stringify(ko.body));
  assert.doesNotMatch(JSON.stringify(ko.body), /knock|must-have|reject/i, 'the candidate is told nothing different');
  koApp = ko.body.application.id;

  candPass = await candidate('Pass Through', 'pass.sq@tl-sink.local', '9100000004');
  const pass = await candPass.post('/api/applications', { jobId: koJob, answers: answer(await set(candPass), 'yes') });
  assert.equal(pass.status, 201);
  passApp = pass.body.application.id;

  const rowKo = (await raw(`select * from applications where id=$1`, [koApp])).rows[0];
  const rowPass = (await raw(`select * from applications where id=$1`, [passApp])).rows[0];
  assert.equal(rowKo.screening_status, 'knocked_out');
  assert.notEqual(rowKo.stage, 'shortlisted', 'a knocked-out application is never shortlisted automatically');
  assert.notEqual(rowKo.stage, 'rejected', 'and never rejected automatically');
  assert.equal(rowPass.screening_status, 'answered');
  assert.equal(rowPass.stage, 'shortlisted');

  // The resume score is untouched; the combined score mixes in the answers at 20%.
  const { scoreApplication, loadAiSettings } = await import('../src/ai/screening.js');
  assert.ok(rowPass.ai_score != null && rowPass.screening_answer_score != null);
  assert.equal(rowPass.screening_combined_score,
    Math.round(Number(rowPass.ai_score) * 0.8 + rowPass.screening_answer_score * 0.2));
  assert.equal(typeof scoreApplication, 'function'); assert.ok(await loadAiSettings());

  const list = await recruiter.get(`/api/screening/applications?jobId=${koJob}`);
  const sKo = list.body.applications.find((a) => a.applicationId === koApp);
  const sPass = list.body.applications.find((a) => a.applicationId === passApp);
  assert.equal(sKo.status, 'knocked_out');
  assert.equal(sKo.mustHaveFailed.length, 1);
  assert.equal(sPass.expectedCtc, 8);
  assert.equal(sPass.noticeDays, 0);
  assert.equal(sPass.relocate, 'yes');

  await raw(`update app_settings set value = value || '{"autoShortlistThreshold": 80}'::jsonb where key='ai'`);
});

test('RLS: candidates, other recruiters and clients see only what they may', async () => {
  // Candidate B cannot read candidate A's answers.
  const theirs = await candPass.get(`/api/screening/applications/${koApp}`);
  assert.equal(theirs.status, 200);
  assert.equal(theirs.body.answers.length, 0);
  const mine = await candKo.get(`/api/screening/applications/${koApp}`);
  assert.equal(mine.body.answers.length, 6);
  assert.doesNotMatch(JSON.stringify(mine.body), /knocked|mustHave/i, 'the candidate never sees the flag');

  // Another company's recruiter: nothing.
  assert.equal((await recruiter2.get(`/api/screening/applications/${koApp}`)).status, 404);
  const { withUser } = await import('../src/db.js');
  const n = await withUser(sessions.r_sq2, async (c) =>
    (await c.query(`select count(*)::int n from application_screening_answers where application_id=$1`, [koApp])).rows[0].n);
  assert.equal(n, 0);

  // Client: nothing until the stage is client-visible; then no flag, no
  // weight, and no "another consultancy" answer (not shared).
  const before = await client.get(`/api/screening/applications/${koApp}`);   // still 'applied'
  assert.equal(before.body.answers.length, 0);
  const visible = (await raw(`select id from stages where client_visible order by sort_order limit 1`)).rows[0].id;
  await raw(`update applications set stage=$2 where id=$1`, [passApp, visible]);
  const after = await client.get(`/api/screening/applications/${passApp}`);
  assert.equal(after.body.answers.length, 5, JSON.stringify(after.body));
  const text = JSON.stringify(after.body);
  assert.doesNotMatch(text, /knocked|mustHave|weight/i);
  assert.doesNotMatch(text, /Acme Corp/, 'the other-consultancy answer is not shared');

  // Shared when the recruiter ticks it.
  await raw(`update application_screening_answers set share_with_client=true where application_id=$1 and std_key='other_consultancy'`, [passApp]);
  assert.match(JSON.stringify((await client.get(`/api/screening/applications/${passApp}`)).body), /Acme Corp/);
  await raw(`update application_screening_answers set share_with_client=false where application_id=$1 and std_key='other_consultancy'`, [passApp]);
});

test('client submission and Excel/CSV export carry the answers, without flags', async () => {
  const { withUser } = await import('../src/db.js');
  const { buildExport } = await import('../src/ats/push.js');
  const payload = await withUser(sessions.r_sq1, (c) => buildExport(c, candKo.id, koApp));
  assert.equal(payload.screening.noticePeriod, 'Immediate');
  assert.equal(payload.screening.expectedCtcLpa, 8);
  assert.equal(payload.screening.willingToRelocate, false);
  assert.doesNotMatch(JSON.stringify(payload.screening), /knock|weight|Acme Corp/i);

  const cols = (await recruiter.get('/api/recruiter/candidates/export-columns')).body.columns.map((c) => c.key);
  for (const k of ['screeningNotice', 'screeningExpectedCtc', 'screeningRelocate', 'screeningAnswers']) assert.ok(cols.includes(k), k);
  const csv = await fetch(`${base}/api/recruiter/candidates/export`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: [...recruiter.jar].map(([k, v]) => `${k}=${v}`).join('; '),
               'x-csrf-token': recruiter.jar.get('tl_csrf') },
    body: JSON.stringify({ ids: [candKo.id], format: 'csv',
      columns: ['name', 'appliedFor', 'screeningNotice', 'screeningExpectedCtc', 'screeningRelocate', 'screeningAnswers'] }),
  }).then((r) => r.text());
  assert.match(csv, /Notice \(screening\),Expected CTC \(screening\),Willing to Relocate/);
  assert.match(csv, /Kiran Rao,Spring Engineer,Immediate,8 LPA,No/);
  assert.doesNotMatch(csv, /Acme Corp|knock/i);
});

/* ------------------------------------------------------------------ *
 * applications that arrive without answers
 * ------------------------------------------------------------------ */

let pendingApp, token;

test('an application without answers is pending; the sweep sends a no-password link once', async () => {
  const id = await job({ title: 'Imported Role' });
  const cand = await candidate('Pending Person', 'pending.sq@tl-sink.local', '9100000005');
  // A recruiter adding a candidate to a role: no answers.
  const add = await recruiter.post('/api/applications', { jobId: id, candidateId: cand.id, source: 'naukri' });
  assert.equal(add.status, 201, JSON.stringify(add.body));
  pendingApp = add.body.application.id;
  assert.equal((await raw(`select screening_status from applications where id=$1`, [pendingApp])).rows[0].screening_status, 'pending');

  const seen = mock.received.length;
  const day = Date.UTC(2026, 9, 3, 6, 0, 0);            // 11:30 IST - not quiet hours
  const r1 = await svc.runScreeningSweep({ now: day });
  assert.ok(r1.links >= 1);
  const msgs = mock.received.slice(seen).filter((m) => JSON.stringify(m.body).includes('screening-answers'));
  assert.ok(msgs.length >= 1, 'the link went out');
  const body = JSON.stringify(msgs);
  assert.doesNotMatch(body, CLIENT_WORD, 'no client name in the message');
  token = /screening-answers\/([A-Za-z0-9_.-]+)/.exec(body)[1];

  const again = await svc.runScreeningSweep({ now: day + 60_000 });
  assert.equal(again.links, 0, 'the link is sent once');
  const dl = (await raw(`select channel, status from screening_link_deliveries where application_id=$1`, [pendingApp])).rows;
  assert.ok(dl.some((d) => d.channel === 'email' && d.status === 'sent'));
  assert.ok(dl.some((d) => d.channel === 'whatsapp' && d.status !== 'sent'), 'no WhatsApp template -> not sent');
});

test('one reminder after 48 hours, and only one', async () => {
  const sent = Date.parse((await raw(`select screening_link_sent_at s from applications where id=$1`, [pendingApp])).rows[0].s);
  const early = await svc.runScreeningSweep({ now: sent + 47 * 3600_000 });
  assert.equal(early.reminders, 0);
  const late = await svc.runScreeningSweep({ now: sent + 49 * 3600_000 });
  assert.equal(late.reminders, 1);
  const later = await svc.runScreeningSweep({ now: sent + 60 * 3600_000 });
  assert.equal(later.reminders, 0);
  const kinds = (await raw(`select distinct kind from screening_link_deliveries where application_id=$1`, [pendingApp])).rows.map((r) => r.kind);
  assert.deepEqual(kinds.sort(), ['link', 'reminder']);
});

test('the link works once, only for its application, and expires after 7 days', async () => {
  const anon = makeClient(base);
  const view = await anon.post('/api/screening/link/view', { token });
  assert.equal(view.status, 200, JSON.stringify(view.body));
  assert.doesNotMatch(JSON.stringify(view.body), CLIENT_WORD);
  assert.doesNotMatch(JSON.stringify(view.body), /knockout|weight/i);

  // Tampered: pointed at another application.
  const parts = token.split('.');
  const forged = [Buffer.from(koApp).toString('base64url'), ...parts.slice(1)].join('.');
  assert.equal((await anon.post('/api/screening/link/view', { token: forged })).status, 410);

  // Expired (signed correctly, but in the past).
  const row = (await raw(`select screening_link_nonce n from applications where id=$1`, [pendingApp])).rows[0];
  const old = svc.linkToken(pendingApp, row.n, new Date(Date.now() - 1000));
  assert.equal((await anon.post('/api/screening/link/view', { token: old })).body.error.code, 'SCREENING_LINK_EXPIRED');

  const answers = view.body.questions.map((q) => ({ questionId: q.id, answer:
    q.stdKey === 'notice_period' ? { value: '15 days' } : q.stdKey === 'current_ctc' ? 4
      : q.stdKey === 'expected_ctc' ? 6 : q.stdKey === 'current_location' ? 'Guntur' : 'yes' }));
  const before = (await raw(`select ai_screened_at from applications where id=$1`, [pendingApp])).rows[0].ai_screened_at;
  const sub = await anon.post('/api/screening/link/submit', { token, answers });
  assert.equal(sub.status, 200, JSON.stringify(sub.body));
  const app = (await raw(`select * from applications where id=$1`, [pendingApp])).rows[0];
  assert.equal(app.screening_status, 'answered');
  assert.ok(app.screening_combined_score != null, 'answers arriving re-run screening');
  assert.ok(new Date(app.ai_screened_at) >= new Date(before));
  const src = (await raw(`select distinct source from application_screening_answers where application_id=$1`, [pendingApp])).rows;
  assert.deepEqual(src.map((x) => x.source), ['link']);

  const twice = await anon.post('/api/screening/link/submit', { token, answers });
  assert.equal(twice.status, 409, 'a link works once');
  assert.equal(twice.body.error.code, 'SCREENING_LINK_USED');
});

test('re-open sends a fresh link and retires the old one; recruiter can answer on call', async () => {
  const re = await recruiter.post(`/api/screening/applications/${pendingApp}/reopen`, {});
  assert.equal(re.status, 200, JSON.stringify(re.body));
  assert.equal((await raw(`select screening_status from applications where id=$1`, [pendingApp])).rows[0].screening_status, 'pending');
  const anon = makeClient(base);
  const old = await anon.post('/api/screening/link/view', { token });
  assert.equal(old.body.error.code, 'SCREENING_LINK_REPLACED', 'old link no longer answers');

  const detail = (await recruiter.get(`/api/screening/applications/${pendingApp}`)).body;
  const answers = detail.questions.map((q) => ({ questionId: q.id, answer:
    q.stdKey === 'notice_period' ? { value: 'Immediate' } : q.type === 'number' ? 5
      : q.stdKey === 'current_location' ? 'Guntur' : 'no' }));
  const call = await recruiter.post(`/api/screening/applications/${pendingApp}/answers`, { answers });
  assert.equal(call.status, 200, JSON.stringify(call.body));
  const after = (await recruiter.get(`/api/screening/applications/${pendingApp}`)).body;
  assert.equal(after.answers[0].source, 'recruiter_call');
  assert.match(after.answers[0].answeredBy, /^Answered on call by /);

  // Another company's recruiter cannot do either.
  assert.equal((await recruiter2.post(`/api/screening/applications/${pendingApp}/reopen`, {})).status, 404);
  assert.equal((await recruiter2.post(`/api/screening/applications/${pendingApp}/answers`, { answers })).status, 404);
});

test('a candidate cannot change answers after submitting, even straight through SQL', async () => {
  const { withUser } = await import('../src/db.js');
  const s = { userId: (await raw(`select user_id from candidates where id=$1`, [candKo.id])).rows[0].user_id,
              role: 'candidate', profileId: candKo.id };
  await assert.rejects(withUser(s, (c) => c.query(
    `select screening_record_answers($1,'[]'::jsonb,'candidate',null,'answered',100)`, [koApp])), /screening_answers_locked/);
});

test('admin edits the standard questions and the answer weight', async () => {
  const cur = (await admin.get('/api/screening/settings')).body;
  assert.equal(cur.answerWeight, 20);
  const standard = cur.standard.map((q) => (q.key === 'other_consultancy' ? { ...q, enabled: false } : q));
  const put = await admin.put('/api/screening/settings', { standard, answerWeight: 30 });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(put.body.answerWeight, 30);
  const id = await job();
  assert.equal((await qs(id)).length, 5, 'a disabled standard question is not added to new jobs');
  assert.equal((await recruiter.put('/api/screening/settings', { answerWeight: 50 })).status, 403);
  await admin.put('/api/screening/settings', { standard: cur.standard, answerWeight: 20 });
});

test('suggestions come from the JD generator, typed', async () => {
  const r = await recruiter.post('/api/screening/suggestions', { title: 'Java Developer', skills: ['Java', 'AWS'], location: 'Pune' });
  assert.equal(r.status, 200);
  const java = r.body.suggestions.find((s) => /Java/.test(s.text) && s.type === 'number');
  assert.ok(java, JSON.stringify(r.body));
  assert.equal(java.options.unit, 'years');
});

test('shutdown', async () => {
  const { stopBackgroundWork } = await import('../src/app.js');
  const { closePool } = await import('../src/db.js');
  stopBackgroundWork();
  await new Promise((r) => server.close(r));
  await closePool();
  await mock.stop();
  await dbh.stop();
});
