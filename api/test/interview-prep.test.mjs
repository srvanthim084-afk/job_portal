/**
 * Interview prep kit (0098), end to end against a real Postgres with RLS.
 *
 * The client company has an unusual name, and every output a candidate
 * can see - the kit, the messages, the calendar file, the AI prompt - is
 * searched for it.
 *
 * One local HTTP server stands in for everything outside: the email/SMS
 * providers and the Anthropic API (AI_API_BASE_URL points at it). Nothing
 * leaves the machine.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startTestDb, applyTestEnv, makeClient } from './harness.mjs';

const DB_PORT = 5468;
const API_PORT = 9988;
const MOCK_PORT = 9976;
const CLIENT_NAME = 'Quillfeather Biolabs';
const LEAK = /quillfeather|biolabs/i;
const VENUE = 'Quillfeather Biolabs, Tower B, Hinjewadi Phase 2, Pune';

let dbh, server, mock, base, raw, kitSvc, reminders, prepKit;
let recruiter, recruiter2, client, candA, candB;
let jobId, appA, appB;
const received = [];
const aiRequests = [];
let aiMode = 'ok';            // ok | slow | leak

function aiAnswer() {
  const questions = [
    ['Walk me through a Kotlin project you built.', 'They check hands-on depth.'],
    ['How do you structure a REST API?', 'Design judgement matters here.'],
    ['Explain coroutines to a junior developer.', 'They test clarity of explanation.'],
    ['Describe a production bug you fixed.', 'Problem solving under pressure.'],
    ['How do you test your code?', 'Quality habits.'],
    ['Why this role?', 'Motivation and fit.'],
  ].map(([q, why]) => ({ q, why, topic: 'Kotlin' }));
  if (aiMode === 'leak') questions[5].q = `Why do you want to work at ${CLIENT_NAME}?`;
  return { questions, tips: ['Revise the Kotlin standard library.', 'Prepare two project stories.'] };
}

async function startMock() {
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      if (req.url.startsWith('/v1/messages')) {
        aiRequests.push(body);
        const reply = () => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 'msg_mock', type: 'message', role: 'assistant', model: 'claude-opus-5-5',
            content: [{ type: 'text', text: JSON.stringify(aiAnswer()) }], stop_reason: 'end_turn',
            stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } }));
        };
        if (aiMode === 'slow') setTimeout(reply, 2500); else reply();
        return;
      }
      try { received.push({ url: req.url, body: JSON.parse(body || '{}') }); } catch { received.push({ url: req.url, body }); }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'mock_' + received.length }));
    });
  });
  await new Promise((r) => srv.listen(MOCK_PORT, '127.0.0.1', r));
  return { stop: () => new Promise((r) => srv.close(r)) };
}

async function staff(email, role, table, id, company) {
  const { hashPassword } = await import('../src/auth.js');
  const hash = await hashPassword('Prepkit123pass');
  const u = (await raw(`insert into users (email,password_hash,role) values ($1,$2,$3) returning id`, [email, hash, role])).rows[0].id;
  await raw(`insert into ${table} (id, user_id, name, email, company_id) values ($1,$2,$3,$4,$5)`, [id, u, `${role} ${id}`, email, company]);
  const c = makeClient(base);
  await c.get('/api/health');
  const r = await c.post('/api/auth/login', { email, password: 'Prepkit123pass', role });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return c;
}

async function candidate(name, email, phone) {
  const c = makeClient(base);
  await c.get('/api/health');
  const r = await c.post('/api/auth/register', {
    name, email, password: 'Prepkit123cand', phone, preferredLocation: 'Pune', expectedCtc: 9,
    noticePeriod: 'Immediate', preferredWorkModes: ['Hybrid'],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  c.id = r.body.candidateId;
  return c;
}

const leakCheck = (label, value) => assert.doesNotMatch(
  typeof value === 'string' ? value : JSON.stringify(value), LEAK, `${label} names the client`);

test('boot', async () => {
  dbh = await startTestDb(DB_PORT);
  mock = await startMock();
  applyTestEnv(dbh.url, {
    PUBLIC_ORIGIN: `http://127.0.0.1:${API_PORT}`,
    DISABLE_BACKGROUND_WORK: 'true',
    SMS_API_URL: `http://127.0.0.1:${MOCK_PORT}/sms`,
    EMAIL_API_KEY: 'test-key', EMAIL_FROM: 'interviews@teamlink.example',
    EMAIL_API_URL: `http://127.0.0.1:${MOCK_PORT}/email`,
    EMAIL_SMTP_HOST: '', EMAIL_SMTP_USER: '', EMAIL_SMTP_PASS: '',
    EMAILJS_SERVICE_ID: '', EMAILJS_TEMPLATE_ID: '', EMAILJS_PUBLIC_KEY: '', EMAILJS_PRIVATE_KEY: '',
    OUTBOUND_ALLOWLIST: '',
    AI_API_KEY: '', AI_API_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`, AI_PREP_TIMEOUT_MS: '1000',
  });
  raw = (sql, params) => dbh.db.query(sql, params);
  await raw(`insert into companies (id, name) values ('co_qf', $1), ('co_ot', 'Other Place')`, [CLIENT_NAME]);

  const { createApp } = await import('../src/app.js');
  kitSvc = await import('../src/interview/kit-service.js');
  reminders = await import('../src/interview/reminders.js');
  prepKit = await import('../src/interview/prep-kit.js');
  const app = createApp({ logger: { error() {}, log() {} } });
  await new Promise((r) => { server = app.listen(API_PORT, r); });
  base = `http://127.0.0.1:${API_PORT}`;

  recruiter = await staff('rec.pk@tl-sink.local', 'recruiter', 'recruiters', 'r_pk1', 'co_qf');
  recruiter2 = await staff('rec2.pk@tl-sink.local', 'recruiter', 'recruiters', 'r_pk2', 'co_ot');
  client = await staff('client.pk@tl-sink.local', 'client', 'client_users', 'c_pk', 'co_qf');

  jobId = 'j_pk1';
  await raw(`insert into jobs (id, title, company_id, location, mode, exp_label, skills, status, recruiter_id, description, published_at)
             values ($1, 'Kotlin Developer', 'co_qf', 'Pune', 'Hybrid', '3-6 yrs', $2, 'open', 'r_pk1', $3, now())`,
    [jobId, ['Kotlin', 'Spring Boot', 'PostgreSQL'],
     `${CLIENT_NAME} is hiring. Join Quillfeather's platform team. Write to hr@quillfeather.example or call 9876543210. https://quillfeather.example/careers`]);
  candA = await candidate('Asha Kumar', 'asha.pk@tl-sink.local', '9200000001');
  candB = await candidate('Bharat Rao', 'bharat.pk@tl-sink.local', '9200000002');
  appA = (await candA.post('/api/applications', { jobId })).body.application.id;
  appB = (await candB.post('/api/applications', { jobId })).body.application.id;
});

let ivA;

test('scheduling makes the kit and sends "Interview scheduled ... your prep kit" without the client name', async () => {
  const seen = received.length;
  const r = await recruiter.post('/api/interviews', {
    candidateId: candA.id, jobId, type: 'Technical (Human)', date: '2026-10-20', time: '11:00 AM', mode: 'In Person',
    locationType: 'in_person', venueAddress: VENUE,
    durationMinutes: 45, candidateInstructions: 'Ask for the TeamLink desk at reception.',
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  ivA = r.body.interview.id;
  assert.equal(r.body.notify.event, 'INTERVIEW_SCHEDULED');

  const kit = (await raw(`select * from interview_prep_kits where interview_id=$1`, [ivA])).rows[0];
  assert.ok(kit, 'a kit exists');
  assert.equal(kit.generated_by, 'rules');
  assert.ok(kit.questions.length >= 6 && kit.questions.length <= 10);
  assert.ok(kit.sent_at, 'sent with the scheduled message');
  leakCheck('the stored kit', kit);
  assert.ok(kit.questions.some((q) => /Kotlin/.test(q.q)), 'questions come from the job skills');
  assert.ok(kit.bring_list.some((b) => /resume/i.test(b.text)), 'in-person bring list');

  const msgs = received.slice(seen);
  assert.ok(msgs.length >= 2, 'email and SMS went to the mock');
  leakCheck('the scheduled messages', msgs);
  assert.match(JSON.stringify(msgs), /interview-prep\//, 'the kit link is in the message');
  assert.doesNotMatch(JSON.stringify(msgs), /Hinjewadi/, 'the venue is not sent before it is released');
  const rows = (await raw(`select kind, channel, status from interview_prep_messages where interview_id=$1`, [ivA])).rows;
  assert.ok(rows.some((x) => x.kind === 'scheduled' && x.channel === 'email' && x.status === 'sent'));
});

test('the candidate sees the kit: no company anywhere; venue hidden until released', async () => {
  const r = await candA.get(`/api/candidate/interviews/${ivA}/prep-kit`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  leakCheck('the candidate kit', r.body);
  assert.equal(r.body.kit.role, 'Kotlin Developer');
  assert.equal(r.body.kit.venue, null);
  assert.equal(r.body.kit.mapsUrl, null);
  assert.equal(r.body.kit.detailsReleased, false);
  assert.equal(r.body.kit.instructions, 'Ask for the TeamLink desk at reception.');
  assert.equal(r.body.kit.durationMinutes, 45);
  assert.equal(r.body.kit.joinOpensAt, new Date(Date.parse(r.body.kit.startsAt) - 15 * 60000).toISOString());

  const ics = await fetch(`${base}/api/candidate/interviews/${ivA}/prep-kit.ics`, {
    headers: { cookie: [...candA.jar].map(([k, v]) => `${k}=${v}`).join('; ') } }).then((x) => x.text());
  assert.match(ics, /BEGIN:VCALENDAR/);
  assert.match(ics, /DTSTART:20261020T053000Z/, '11:00 IST is 05:30 UTC');
  assert.match(ics, /SUMMARY:Interview: Kotlin Developer/);
  leakCheck('the .ics', ics);
  assert.doesNotMatch(ics, /LOCATION/, 'no location before release');

  // Viewed, then two ticks.
  assert.equal((await candA.post(`/api/candidate/interviews/${ivA}/prep-kit/viewed`, {})).status, 200);
  const keys = r.body.kit.bringList.map((b) => b.key);
  await candA.put(`/api/candidate/interviews/${ivA}/prep-kit/checklist`, { itemKey: keys[0], done: true });
  const t2 = await candA.put(`/api/candidate/interviews/${ivA}/prep-kit/checklist`, { itemKey: keys[1], done: true });
  assert.equal(t2.body.kit.checklist.done, 2);
  assert.equal((await candA.put(`/api/candidate/interviews/${ivA}/prep-kit/checklist`, { itemKey: 'nope', done: true })).status, 400);

  const st = (await recruiter.get(`/api/interviews/prep-status?ids=${ivA}`)).body.statuses[0];
  assert.deepEqual({ sent: st.sent, viewed: st.viewed, done: st.done, total: st.total },
    { sent: true, viewed: true, done: 2, total: 6 });
});

test('release: the candidate sees the venue, a Maps link and the contact', async () => {
  const rel = await recruiter.put(`/api/interviews/${ivA}/prep`, { releaseDetails: true, contactPhone: '9000011111' });
  assert.equal(rel.status, 200, JSON.stringify(rel.body));
  const r = await candA.get(`/api/candidate/interviews/${ivA}/prep-kit`);
  assert.match(r.body.kit.venue, /Hinjewadi/);
  assert.match(r.body.kit.mapsUrl, /^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=/);
  assert.equal(r.body.kit.contact.phone, '9000011111');
});

test('RLS: candidate B cannot read A\'s kit; a client and another company\'s recruiter cannot read kits', async () => {
  assert.equal((await candB.get(`/api/candidate/interviews/${ivA}/prep-kit`)).status, 404);
  assert.equal((await candB.put(`/api/candidate/interviews/${ivA}/prep-kit/checklist`, { itemKey: 'photo_id', done: true })).status, 404);
  assert.equal((await client.get(`/api/interviews/${ivA}/prep-kit`)).status, 403);
  assert.equal((await recruiter2.get(`/api/interviews/${ivA}/prep-kit`)).status, 404);
  const { withUser } = await import('../src/db.js');
  const cu = (await raw(`select user_id from client_users where id='c_pk'`)).rows[0].user_id;
  const n = await withUser({ userId: cu, role: 'client', profileId: 'c_pk' }, async (c) =>
    (await c.query(`select count(*)::int n from interview_prep_kits`)).rows[0].n);
  assert.equal(n, 0, 'the client role reads no kits');
  const vn = await withUser({ userId: cu, role: 'client', profileId: 'c_pk' }, async (c) =>
    (await c.query(`select count(*)::int n from candidate_interview_prep_v`)).rows[0].n);
  assert.equal(vn, 0);
});

test('recruiter edits are kept when the interview is rescheduled; reminders follow the new time', async () => {
  const cur = (await recruiter.get(`/api/interviews/${ivA}/prep-kit`)).body;
  const questions = [...cur.kit.questions.slice(0, 5), { q: 'Tell us about your Kotlin Multiplatform work.', why: 'Recruiter added.', topic: 'Kotlin' }];
  const ed = await recruiter.put(`/api/interviews/${ivA}/prep-kit`, { questions, tips: cur.kit.tips });
  assert.equal(ed.status, 200, JSON.stringify(ed.body));
  assert.equal(ed.body.kit.recruiterEdited, true);

  const bad = await recruiter.put(`/api/interviews/${ivA}/prep-kit`, { questions: [{ q: `Why join ${CLIENT_NAME}?` }], tips: [] });
  assert.equal(bad.status, 400, 'an edit naming the client is refused');

  const seen = received.length;
  const mv = await recruiter.put(`/api/interviews/${ivA}`, { date: '2026-10-22', time: '09:00 AM' });
  assert.equal(mv.status, 200);
  assert.equal(mv.body.delivery.event, 'INTERVIEW_RESCHEDULED');
  // The venue was RELEASED above - the one place the company may appear,
  // because the recruiter typed it and chose to release it. Everything
  // else in the message must still be clean.
  leakCheck('the rescheduled message', JSON.stringify(received.slice(seen)).split(VENUE).join('[venue]'));
  assert.match(JSON.stringify(received.slice(seen)), /Hinjewadi/, 'the released venue is included');
  const kit = (await recruiter.get(`/api/interviews/${ivA}/prep-kit`)).body.kit;
  assert.ok(kit.questions.some((q) => /Multiplatform/.test(q.q)), 'the recruiter\'s question survived');

  // Reminders for the new slot: 22 Oct 09:00 IST = 03:30 UTC.
  const start = Date.UTC(2026, 9, 22, 3, 30);
  const atSix = Date.UTC(2026, 9, 21, 12, 30);              // 18:00 IST the day before
  let r = await reminders.runInterviewReminders({ now: atSix - 60_000 });
  assert.equal(r.dayBefore, 0, 'not before 18:00');
  r = await reminders.runInterviewReminders({ now: atSix + 60_000 });
  assert.equal(r.dayBefore, 1);
  r = await reminders.runInterviewReminders({ now: atSix + 120_000 });
  assert.equal(r.dayBefore, 0, 'sent once');
  r = await reminders.runInterviewReminders({ now: start - 2 * 3600_000 + 60_000 });    // 07:01 IST - quiet hours
  assert.equal(r.twoHours, 1);
  const two = (await raw(`select channel, status from interview_prep_messages where interview_id=$1 and kind='two_hours' and channel <> 'in_app'`, [ivA])).rows;
  assert.ok(two.find((x) => x.channel === 'sms').status === 'sent',
    'a 9 AM interview\'s 2-hour reminder reaches the phone despite quiet hours');
  const day = (await raw(`select channel, status from interview_prep_messages where interview_id=$1 and kind='day_before' and channel='sms'`, [ivA])).rows[0];
  assert.equal(day.status, 'sent');

  // After the end, still Scheduled: the recruiter is nudged once.
  r = await reminders.runInterviewReminders({ now: start + 3 * 3600_000 });
  assert.equal(r.nudges, 1);
  r = await reminders.runInterviewReminders({ now: start + 4 * 3600_000 });
  assert.equal(r.nudges, 0);
  const note = (await raw(`select * from notifications where type='INTERVIEW_STATUS_DUE' and recipient_id='r_pk1'`)).rows;
  assert.equal(note.length, 1);
});

test('cancelled: a message at once, and no reminders afterwards', async () => {
  const r = await recruiter.post('/api/interviews', {
    candidateId: candB.id, jobId, type: 'HR Round', date: '2026-10-25', time: '3:00 PM', mode: 'Phone' });
  assert.equal(r.status, 201);
  const ivB = r.body.interview.id;
  const kit = (await raw(`select * from interview_prep_kits where interview_id=$1`, [ivB])).rows[0];
  assert.ok(kit.questions.some((q) => /notice period/i.test(q.q)), 'HR round questions');
  assert.ok(kit.bring_list.some((b) => /charged/i.test(b.text)), 'phone bring list');
  const c = await recruiter.put(`/api/interviews/${ivB}`, { status: 'Cancelled' });
  assert.equal(c.body.delivery.event, 'INTERVIEW_CANCELLED');
  const start = Date.UTC(2026, 9, 25, 9, 30);
  const out = await reminders.runInterviewReminders({ now: start - 3600_000 });
  assert.equal(out.twoHours, 0);
  assert.equal((await raw(`select count(*)::int n from interview_prep_messages where interview_id=$1 and kind='two_hours'`, [ivB])).rows[0].n, 0);
});

test('AI engine: only scrubbed job facts go out; a good answer is used; a slow one falls back to rules', async () => {
  process.env.AI_API_KEY = 'test-ai-key';
  try {
    aiMode = 'ok';
    const r = await recruiter.post('/api/interviews', {
      candidateId: candB.id, jobId, type: 'Client Round', date: '2026-10-27', time: '10:00 AM', mode: 'Video Call' });
    const iv = r.body.interview.id;
    await new Promise((res) => setTimeout(res, 500));     // the background upgrade from scheduling
    await kitSvc.ensureKit(iv, { regenerate: true, background: false });
    let kit = (await raw(`select * from interview_prep_kits where interview_id=$1`, [iv])).rows[0];
    assert.equal(kit.generated_by, 'ai', kit.engine_note);
    assert.ok(aiRequests.length >= 1);
    const sent = aiRequests.join('\n');
    leakCheck('the AI prompt', sent);
    assert.doesNotMatch(sent, /9876543210|hr@|Asha|Bharat|bharat\.pk|9200000002|cand_|app_|j_pk1/i,
      'no contact details or ids in the AI prompt');
    const body = JSON.parse(aiRequests[aiRequests.length - 1]);
    assert.equal(body.model, 'claude-opus-5-5');
    assert.equal(body.output_config.effort, 'low');
    assert.equal(body.output_config.format.type, 'json_schema');
    assert.equal(body.fallbacks, 'default');
    assert.equal(body.system[0].cache_control.type, 'ephemeral');

    aiMode = 'leak';
    await kitSvc.ensureKit(iv, { regenerate: true, background: false });
    kit = (await raw(`select * from interview_prep_kits where interview_id=$1`, [iv])).rows[0];
    assert.equal(kit.generated_by, 'rules', 'an answer naming the client is thrown away');
    assert.match(kit.engine_note, /names the company/);
    leakCheck('the fallback kit', kit);

    aiMode = 'slow';
    const t0 = Date.now();
    await kitSvc.ensureKit(iv, { regenerate: true, background: false });
    kit = (await raw(`select * from interview_prep_kits where interview_id=$1`, [iv])).rows[0];
    assert.equal(kit.generated_by, 'rules');
    assert.match(kit.engine_note, /AI engine not used/);
    assert.ok(Date.now() - t0 < 2400, 'gave up at the timeout');
  } finally {
    process.env.AI_API_KEY = '';
    aiMode = 'ok';
  }
});

test('rules engine: experience level and interview type shape the questions', () => {
  const fresher = prepKit.rulesKit({ type: 'Technical (Human)', mode: 'Video Call' }, { title: 'Trainee', skills: ['Java'], exp: '0-1 yrs' });
  assert.match(fresher.questions.map((q) => q.q).join(' '), /basics of Java/);
  const senior = prepKit.rulesKit({ type: 'Client Round', mode: 'Video Call' }, { title: 'Lead', skills: ['Java'], exp: '8-12 yrs' });
  assert.match(senior.questions.map((q) => q.q).join(' '), /trade-offs/);
  const ai = prepKit.rulesKit({ type: 'AI Interview', mode: 'TeamLink AI' }, { title: 'Dev', skills: ['Go'] });
  assert.match(JSON.stringify(ai), /single tab/);
  for (const k of [fresher, senior, ai]) {
    assert.ok(k.questions.length >= 6 && k.questions.length <= 10);
    assert.ok(k.questions.every((q) => q.why));
  }
  assert.equal(prepKit.scrubDescription(`Join ${CLIENT_NAME} today, mail hr@x.com`, CLIENT_NAME).match(LEAK), null);
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
