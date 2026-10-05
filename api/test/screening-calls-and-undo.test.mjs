/**
 * Round 2 (0104): three things, end to end against a real Postgres with RLS.
 *
 *   1. One-click apply holds the candidate's messages through the Undo
 *      window: undone -> nothing reaches the provider; not undone -> each
 *      message exactly once after the window; a restart in between (the
 *      timer lost, the hold row kept) -> the sweep sends it, once.
 *   2. An AI call that is already being made asks the application's
 *      pending screening questions - only when the admin switch is on - and
 *      stores the answers with source 'ai_call' through the same validation.
 *   3. The no-password page's place suggestions, gated by the link token.
 *
 * Nothing leaves the machine: email and SMS go to a local mock, WhatsApp
 * and IVR are not configured, and the telephony provider is the LOCAL
 * driver (turns arrive over HTTP; no carrier is ever contacted). The
 * outbound allowlist names only this file's own test numbers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { startTestDb, applyTestEnv, makeClient, startMockProvider } from './harness.mjs';

const DB_PORT = 5466;
const API_PORT = 9986;
const MOCK_PORT = 9974;
const CLIENT_NAME = 'Quillfeather Biologics';
const PLACE_TREE = 'C:/Users/user/Desktop/job portal/var/places/india-tree.tsv';

let dbh, server, mock, base, raw, hold, svc;
let recruiter, admin;

/* Fixed numbers, so the outbound allowlist can name every one of them. */
const PHONES = Array.from({ length: 24 }, (_, i) => `98765${String(43000 + i).padStart(5, '0')}`);
let phoneAt = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const msgsFor = (c) => mock.received.filter((m) => {
  const j = JSON.stringify(m.body);
  return j.includes(c.email) || j.includes(c.phone);
});
const emailsFor = (c) => msgsFor(c).filter((m) => m.url.startsWith('/email'));
const smsFor = (c) => msgsFor(c).filter((m) => m.url.startsWith('/sms'));
/* Which messages, by kind: the job title and the due time are each application's own. */
const subjects = (list) => list.map((m) => String(m.body.subject)
  .replace(/Java Developer \d+/g, 'JOB').replace(/ — due .*/, ' — due …')).sort();

async function candidate(name, profile = {}) {
  const c = makeClient(base);
  await c.get('/api/health');
  c.email = `${name.toLowerCase().replace(/\W+/g, '.')}.${Date.now().toString(36)}@tl-sink.local`;
  c.phone = PHONES[phoneAt++];
  const r = await c.post('/api/auth/register', {
    name, email: c.email, password: 'Round2pass1', phone: c.phone,
    preferredLocation: 'Hyderabad', expectedCtc: 8, noticePeriod: '30 days', preferredWorkModes: ['Work From Office'],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  c.id = r.body.candidateId;
  const p = { location: 'Hyderabad', exp: '3 yrs', exp_years: 3, skills: ['Java', 'Spring'], resume_file: 'cv.pdf', ...profile };
  await raw(`update candidates set location=$2, exp=$3, exp_years=$4, skills=$5, resume_file=$6 where id=$1`,
    [c.id, p.location, p.exp, p.exp_years, p.skills, p.resume_file]);
  return c;
}

let seq = 0;
async function job(f = {}) {
  seq += 1;
  const id = `jr2_${seq}`;
  await raw(`insert into jobs (id, title, company_id, recruiter_id, location, mode, exp_label, pay_label,
                               salary_min, salary_max, employment_type, status, skills, description, published_at)
             values ($1,$2,'co_r2','r_r2',$3,'Onsite','2-4 yrs','₹6-9 LPA',6,9,'Full-time','open',$4,'A role.', now())`,
    [id, f.title || `Java Developer ${seq}`, f.location || 'Hyderabad', f.skills || ['Java', 'Spring']]);
  if (f.noQuestions) await raw(`delete from job_screening_questions where job_id=$1`, [id]);
  return id;
}
const holdRow = async (appId) => (await raw(
  `select * from application_outbound_holds where application_id=$1`, [appId])).rows[0];

test('boot', async () => {
  dbh = await startTestDb(DB_PORT);
  mock = await startMockProvider(MOCK_PORT);
  applyTestEnv(dbh.url, {
    PUBLIC_ORIGIN: `http://127.0.0.1:${API_PORT}`,
    DISABLE_BACKGROUND_WORK: 'true',
    SMS_API_KEY: 'test-key',
    SMS_API_URL: `http://127.0.0.1:${MOCK_PORT}/sms`,
    WHATSAPP_API_KEY: '',
    EMAIL_API_KEY: 'test-key',
    EMAIL_FROM: 'jobs@teamlink.example',
    EMAIL_API_URL: `http://127.0.0.1:${MOCK_PORT}/email`,
    EMAIL_SMTP_HOST: '', EMAIL_SMTP_USER: '', EMAIL_SMTP_PASS: '',
    EMAILJS_SERVICE_ID: '', EMAILJS_TEMPLATE_ID: '', EMAILJS_PUBLIC_KEY: '', EMAILJS_PRIVATE_KEY: '',
    IVR_API_KEY: '',
    AI_API_KEY: '',
    OUTBOUND_ALLOWLIST: PHONES.join(','),
    TELEPHONY_PROVIDER: 'local',
    TELEPHONY_ACCOUNT_SID: '', TELEPHONY_AUTH_TOKEN: '', TELEPHONY_FROM_NUMBER: '',
    OUTBOUND_CALLS_ENABLED: 'true',
    ONE_CLICK_HOLD_MARGIN_SECONDS: '1',
    PLACE_TREE_FILE: PLACE_TREE,
  });
  raw = (sql, params) => dbh.db.query(sql, params);

  const { hashPassword } = await import('../src/auth.js');
  const hash = await hashPassword('Staff123pass');
  await raw(`insert into companies (id, name) values ('co_r2', $1)`, [CLIENT_NAME]);
  const ru = (await raw(`insert into users (email,password_hash,role) values ('rec.r2@tl-sink.local',$1,'recruiter') returning id`, [hash])).rows[0].id;
  await raw(`insert into recruiters (id, name, email, company_id, user_id) values ('r_r2','Rec Rtwo','rec.r2@tl-sink.local','co_r2',$1)`, [ru]);
  const au = (await raw(`insert into users (email,password_hash,role) values ('admin.r2@tl-sink.local',$1,'admin') returning id`, [hash])).rows[0].id;
  await raw(`insert into admins (id, name, email, user_id) values ('a_r2','Admin Rtwo','admin.r2@tl-sink.local',$1)`, [au]);

  const { createApp } = await import('../src/app.js');
  hold = await import('../src/notify/apply-hold.js');
  svc = await import('../src/screening/service.js');
  const app = createApp({ logger: { error() {}, log() {} } });
  await new Promise((r) => { server = app.listen(API_PORT, r); });
  base = `http://127.0.0.1:${API_PORT}`;

  recruiter = makeClient(base);
  await recruiter.get('/api/health');
  assert.equal((await recruiter.post('/api/auth/login', { email: 'rec.r2@tl-sink.local', password: 'Staff123pass', role: 'recruiter' })).status, 200);
  admin = makeClient(base);
  await admin.get('/api/health');
  assert.equal((await admin.post('/api/auth/login', { email: 'admin.r2@tl-sink.local', password: 'Staff123pass', role: 'admin' })).status, 200);
});

/* ================================================================== *
 * 1. one-click apply: messages wait for the Undo window
 * ================================================================== */

let baseline;   // what an ordinary apply sends a candidate, straight away

test('an ordinary apply still sends at once, holds nothing, and a body flag cannot ask for a hold', async () => {
  const c = await candidate('Plain Applier');
  const j = await job({ noQuestions: true });
  const r = await c.post('/api/applications', { jobId: j, oneClick: true });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.notify.held, undefined);
  assert.equal(await holdRow(r.body.application.id), undefined, 'no hold for an ordinary apply');
  baseline = { emails: subjects(emailsFor(c)), sms: smsFor(c).length };
  assert.ok(baseline.emails.length >= 1, 'an email went out');
  assert.ok(baseline.sms >= 1, 'an SMS went out');
});

test('one-click: undone -> nothing at the provider; not undone -> each message once; a restart in between -> sent once by the sweep', async () => {
  const jB = await job({ noQuestions: true }), jC = await job({ noQuestions: true }), jA = await job({ noQuestions: true });
  const kept = await candidate('Kept Applier');
  const restart = await candidate('Restart Applier');
  const undone = await candidate('Undo Applier');

  const b = await kept.post('/api/applications/one-click', { jobId: jB });
  assert.equal(b.status, 201, JSON.stringify(b.body));
  assert.equal(b.body.notify.held, true);
  assert.equal(b.body.aiInterview.held, true);
  const due = Date.parse(b.body.notify.sendsAt) - Date.parse(b.body.application.appliedAt);
  assert.ok(due >= 11000 && due <= 11500, `held for the 10 s Undo window + the margin (${due} ms)`);

  const cRes = await restart.post('/api/applications/one-click', { jobId: jC });
  assert.equal(cRes.status, 201);
  const a = await undone.post('/api/applications/one-click', { jobId: jA });
  assert.equal(a.status, 201);

  /* The in-app notification appears at once (not held). */
  assert.ok(a.body.notification, 'the in-app notification is returned with the application');
  assert.equal((await raw(`select count(*)::int n from notifications where application_id=$1 and recipient_id=$2`,
    [a.body.application.id, undone.id])).rows[0].n, 1, 'and stored');

  /* "Restart": this process forgets C's timer; its hold row stays. */
  hold.forgetScheduledHolds(cRes.body.application.id);
  assert.ok(await holdRow(cRes.body.application.id));

  /* Undo within the window: the hold goes with the application. */
  const u = await undone.del(`/api/applications/${a.body.application.id}`);
  assert.equal(u.status, 200, JSON.stringify(u.body));
  assert.equal(await holdRow(a.body.application.id), undefined);

  for (const x of [kept, restart, undone]) assert.equal(msgsFor(x).length, 0, 'nothing sent inside the Undo window');

  await sleep(12500);
  assert.deepEqual(subjects(emailsFor(kept)), baseline.emails, 'kept: the same emails as an ordinary apply');
  assert.equal(smsFor(kept).length, baseline.sms, 'kept: the same SMS as an ordinary apply');
  assert.ok((await holdRow(b.body.application.id)).sent_at, 'the hold is marked sent');
  assert.equal(msgsFor(undone).length, 0, 'undone: no email, no SMS');
  assert.equal(msgsFor(restart).length, 0, 'restart: its timer was lost, nothing yet');

  /* The new process's sweep: sends C once; never A; never B again. */
  const [r1, r2] = await Promise.all([hold.runOutboundHolds(), hold.runOutboundHolds()]);
  assert.equal(r1.sent + r2.sent, 1, 'two sweeps racing send it once');
  await hold.runOutboundHolds({ now: Date.now() + 3600e3 });
  assert.deepEqual(subjects(emailsFor(restart)), baseline.emails, 'restart: sent once after all');
  assert.equal(smsFor(restart).length, baseline.sms);
  assert.deepEqual(subjects(emailsFor(kept)), baseline.emails, 'kept: still exactly once');
  assert.equal(smsFor(kept).length, baseline.sms);
  assert.equal(msgsFor(undone).length, 0, 'undone: still nothing');

  /* Delivery rows are on the application, as for any apply. */
  const rows = (await raw(`select channel, status from notification_deliveries where application_id=$1`,
    [cRes.body.application.id])).rows;
  assert.ok(rows.some((r) => r.channel === 'email' && r.status === 'sent'));

  /* Undo after the window is refused as before. */
  const late = await kept.del(`/api/applications/${b.body.application.id}`);
  assert.equal(late.status, 409);
});

test('only the engine can claim or list holds; a candidate cannot hold someone else\'s application', async () => {
  const c = await candidate('Nosy Applier');
  const j = await job({ noQuestions: true });
  const mine = await c.post('/api/applications/one-click', { jobId: j });
  hold.forgetScheduledHolds(mine.body.application.id);
  const { withUser } = await import('../src/db.js');
  const s = { userId: (await raw(`select user_id from candidates where id=$1`, [c.id])).rows[0].user_id, role: 'candidate' };
  await assert.rejects(withUser(s, (cx) => cx.query(`select application_outbound_due(now())`)), /engine only/);
  await assert.rejects(withUser({ userId: (await raw(`select id from users where email='admin.r2@tl-sink.local'`)).rows[0].id, role: 'admin' },
    (cx) => cx.query(`select * from application_outbound_claim($1, now())`, [mine.body.application.id])), /engine only/);
  const other = await candidate('Other Applier');
  const os = { userId: (await raw(`select user_id from candidates where id=$1`, [other.id])).rows[0].user_id, role: 'candidate' };
  await assert.rejects(withUser(os, (cx) => cx.query(`select application_outbound_hold($1, 15)`, [mine.body.application.id])), /only the applicant/);
  await hold.runOutboundHolds({ now: Date.now() + 60e3 });
});

/* ================================================================== *
 * 2. screening questions on an AI call
 * ================================================================== */

/** Answer whatever the agent asks; `over` replaces an answer by question. */
function answerFor(say, over = {}) {
  for (const [re, ans] of Object.entries(over)) if (new RegExp(re, 'i').test(say)) return ans;
  if (/may I speak/i.test(say)) return 'yes speaking';
  if (/good time/i.test(say)) return 'yes go ahead';
  if (/open to new opportunities/i.test(say)) return 'yes I am open';
  if (/is that still right/i.test(say)) return 'yes';
  if (/notice period\?/i.test(say)) return '30 days';
  if (/current CTC/i.test(say)) return '6 lakhs';
  if (/expected CTC/i.test(say)) return '8 lakhs';
  if (/currently located/i.test(say)) return 'Hyderabad';
  if (/willing to work at/i.test(say)) return 'yes';
  if (/another consultancy/i.test(say)) return 'no';
  if (/which company/i.test(say)) return 'none';
  if (/range|LPA, depending/i.test(say)) return '8 lakhs';
  if (/How soon/i.test(say)) return '30 days';
  if (/hands-on experience/i.test(say)) return '3 years';
  if (/Would .* work for you|arrangement work/i.test(say)) return 'yes';
  if (/take this forward/i.test(say)) return 'yes';
  if (/any questions/i.test(say)) return 'no';
  return 'yes';
}

async function runCall(candidateId, jobId, over = {}, { beforeEnd } = {}) {
  const started = await recruiter.post('/api/ai-calling/call', { candidateId, jobId });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const id = started.body.call.id;
  const said = [started.body.say];
  let say = started.body.say;
  for (let i = 0; i < 40; i += 1) {
    if (beforeEnd && /take this forward/i.test(say)) await beforeEnd();
    const r = await recruiter.post(`/api/ai-calling/calls/${id}/say`, { text: answerFor(say, over) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    say = r.body.say; said.push(say);
    if (r.body.end) break;
  }
  return { id, said, plan: started.body.plan };
}

test('the switch is off by default: the call asks nothing from the job\'s questions, the application stays pending', async () => {
  const s = await admin.get('/api/screening/settings');
  assert.equal(s.body.askOnAiCalls, false);
  const c = await candidate('Call Off');
  const j = await job();
  const app = await recruiter.post('/api/applications', { jobId: j, candidateId: c.id });
  assert.equal(app.status, 201, JSON.stringify(app.body));
  const plan = await recruiter.get(`/api/ai-calling/plan?candidateId=${c.id}&jobId=${j}`);
  assert.equal(plan.body.plan.screening, undefined);
  const call = await runCall(c.id, j);
  assert.ok(!call.said.some((x) => /questions from the recruiter/i.test(x)));
  const a = (await raw(`select screening_status from applications where id=$1`, [app.body.application.id])).rows[0];
  assert.equal(a.screening_status, 'pending');
});

test('only an admin turns it on; saving the standard questions keeps it; turning it on calls nobody', async () => {
  assert.equal((await recruiter.put('/api/screening/settings', { askOnAiCalls: true })).status, 403);
  const calls = (await raw(`select count(*)::int n from ai_call_sessions`)).rows[0].n;
  const on = await admin.put('/api/screening/settings', { askOnAiCalls: true });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  assert.equal(on.body.askOnAiCalls, true);
  const std = (await admin.get('/api/screening/settings')).body.standard;
  const again = await admin.put('/api/screening/settings', { standard: std, answerWeight: 20 });
  assert.equal(again.body.askOnAiCalls, true, 'the switch survives a save of the questions');
  assert.equal((await raw(`select count(*)::int n from ai_call_sessions`)).rows[0].n, calls, 'no call was queued');
});

test('on: the call asks the pending questions and stores them as "ai_call" through the same validation', async () => {
  const c = await candidate('Call On');
  const j = await job();
  const app = await recruiter.post('/api/applications', { jobId: j, candidateId: c.id });
  const appId = app.body.application.id;

  const plan = await recruiter.get(`/api/ai-calling/plan?candidateId=${c.id}&jobId=${j}`);
  assert.equal(plan.body.plan.screening.length, 6);
  for (const q of plan.body.plan.screening) {
    assert.equal(q.isKnockout, undefined, 'the agent never gets a must-have rule');
    assert.equal(q.weight, undefined);
  }

  const call = await runCall(c.id, j);
  assert.ok(call.said.some((x) => /questions from the recruiter/i.test(x)), 'the questions were introduced');
  assert.ok(!call.said.some((x) => new RegExp(CLIENT_NAME, 'i').test(x)), 'no client name spoken');

  const a = (await raw(`select screening_status, screening_answer_score from applications where id=$1`, [appId])).rows[0];
  assert.ok(['answered', 'knocked_out'].includes(a.screening_status), a.screening_status);
  const ans = (await raw(`select std_key, answer, source, answered_by from application_screening_answers
                           where application_id=$1 order by position`, [appId])).rows;
  assert.equal(ans.length, 6);
  for (const x of ans) {
    assert.equal(x.source, 'ai_call');
    assert.equal(x.answered_by, 'Answered on an AI call');
  }
  const by = Object.fromEntries(ans.map((x) => [x.std_key, x.answer]));
  assert.equal(by.notice_period.value, '30 days', 'settled earlier on the call, not asked twice');
  assert.equal(by.current_ctc.value, 6);
  assert.equal(by.current_ctc.unit, 'LPA');
  assert.equal(by.expected_ctc.value, 8);
  assert.equal(by.current_location.value, 'Hyderabad');
  assert.equal(by.relocate.value, 'yes');
  assert.equal(by.other_consultancy.value, 'no');
  const asked = call.said.filter((x) => /What is your notice period\?/.test(x));
  assert.equal(asked.length, 0, 'the notice period was not asked a second time');

  const ev = (await raw(`select payload from ai_call_events where session_id=$1 and type='screening.answers'`, [call.id])).rows[0];
  assert.equal(ev.payload.stored, true);
  const panel = await recruiter.get(`/api/screening/applications/${appId}`);
  assert.equal(panel.body.answers[0].source, 'ai_call');
});

test('a refused answer is asked again, then left for the link: nothing half-stored', async () => {
  const c = await candidate('Call Bad');
  const j = await job();
  const app = await recruiter.post('/api/applications', { jobId: j, candidateId: c.id });
  const call = await runCall(c.id, j, { 'current CTC': 'about 900 lakhs' });
  const ctcAsks = call.said.filter((x) => /current CTC/i.test(x));
  assert.equal(ctcAsks.length, 2, 'asked, then asked once more');
  const a = (await raw(`select screening_status from applications where id=$1`, [app.body.application.id])).rows[0];
  assert.equal(a.screening_status, 'pending', 'still pending: the link carries on');
  assert.equal((await raw(`select count(*)::int n from application_screening_answers where application_id=$1`,
    [app.body.application.id])).rows[0].n, 0);
  const ev = (await raw(`select payload from ai_call_events where session_id=$1 and type='screening.answers'`, [call.id])).rows[0];
  assert.equal(ev.payload.stored, false);
  assert.equal(ev.payload.answered, 5);
});

test('answers that arrive by the link during the call are never overwritten; an answered application is not asked', async () => {
  const c = await candidate('Call Race');
  const j = await job();
  const app = await recruiter.post('/api/applications', { jobId: j, candidateId: c.id });
  const appId = app.body.application.id;
  await runCall(c.id, j, {}, {
    beforeEnd: async () => {
      const set = await svc.jobQuestionsInternal(j);
      const prepared = svc.prepareAnswers(set, set.questions.map((q) => ({
        questionId: q.id,
        answer: q.type === 'yes_no' ? 'no' : q.type === 'number' ? 5 : q.type === 'single_choice' ? q.options.choices[0] : 'Pune',
      })));
      const { withUser } = await import('../src/db.js');
      await withUser(svc.ENGINE, (cx) => svc.storeAnswers(cx, appId, prepared, { source: 'link' }));
    },
  });
  const src = (await raw(`select distinct source from application_screening_answers where application_id=$1`, [appId])).rows;
  assert.deepEqual(src.map((x) => x.source), ['link']);

  const again = await recruiter.get(`/api/ai-calling/plan?candidateId=${c.id}&jobId=${j}`);
  assert.equal(again.body.plan.screening, undefined, 'nothing pending, nothing asked');
});

/* ================================================================== *
 * 3. place suggestions on the no-password page
 * ================================================================== */

test('the link page gets place suggestions by its token, and nothing without one', async () => {
  const c = await candidate('Place Finder');
  const j = await job();
  const app = await recruiter.post('/api/applications', { jobId: j, candidateId: c.id });
  const out = await svc.sendLink(app.body.application.id);
  assert.ok(out.token);
  const anon = makeClient(base);
  await anon.get('/api/health');
  assert.equal((await anon.post('/api/screening/link/places', { token: 'nope', q: 'Nellore' })).status, 410);
  const r = await anon.post('/api/screening/link/places', { token: out.token, q: 'Nellore' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  if (existsSync(PLACE_TREE)) {
    assert.ok(r.body.results.length >= 1);
    assert.ok(r.body.results.some((x) => x.name === 'Nellore'), JSON.stringify(r.body.results.slice(0, 3)));
    const signedIn = await c.get('/api/places/search?limit=8&q=Nellore');
    assert.deepEqual(r.body.results.map((x) => x.id).slice(0, 3), signedIn.body.results.map((x) => x.id).slice(0, 3),
      'the same index as GET /api/places/search');
  } else {
    assert.deepEqual(r.body.results, []);
  }
  /* Used once, the link stops searching too. */
  const set = await svc.jobQuestionsInternal(j);
  const sub = await anon.post('/api/screening/link/submit', { token: out.token, answers: set.questions.map((q) => ({
    questionId: q.id,
    answer: q.type === 'yes_no' ? 'no' : q.type === 'number' ? 5 : q.type === 'single_choice' ? q.options.choices[0] : 'Nellore, Andhra Pradesh',
  })) });
  assert.equal(sub.status, 200, JSON.stringify(sub.body));
  assert.equal((await anon.post('/api/screening/link/places', { token: out.token, q: 'Nellore' })).status, 409);
});

/* ================================================================== *
 * the screening link waits for the Undo window too
 * ================================================================== */

test('the no-password link is not sent to a one-click application inside its Undo window', async () => {
  const c = await candidate('Held Link');
  const j = await job();
  const r = await c.post('/api/applications/one-click', { jobId: j });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const id = r.body.application.id;
  hold.forgetScheduledHolds(id);
  assert.equal((await raw(`select screening_status from applications where id=$1`, [id])).rows[0].screening_status, 'pending');
  await svc.runScreeningSweep();
  assert.equal((await raw(`select screening_link_sent_at from applications where id=$1`, [id])).rows[0].screening_link_sent_at, null);
  await hold.runOutboundHolds({ now: Date.now() + 60e3 });
  await svc.runScreeningSweep();
  assert.ok((await raw(`select screening_link_sent_at from applications where id=$1`, [id])).rows[0].screening_link_sent_at);
});

test('shutdown', async () => {
  hold.forgetScheduledHolds();
  const { stopBackgroundWork } = await import('../src/app.js');
  const { closePool } = await import('../src/db.js');
  stopBackgroundWork();
  await new Promise((r) => server.close(r));
  await closePool();
  await mock.stop();
  await dbh.stop();
});
