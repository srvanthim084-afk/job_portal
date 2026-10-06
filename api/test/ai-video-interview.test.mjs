/**
 * AI video interview (0116), against a real Postgres with RLS.
 *
 *   - the questions follow the owner's style rules (no gap phrasing,
 *     under 25 words, no protected topics) with no AI key configured
 *   - at most ONE follow-up per question, from the owner's templates, and
 *     only for a vague answer; "no experience" gets the owner's reply
 *   - transcripts and per-question recordings are saved against the
 *     interview, the question, the candidate and the job, and only the
 *     people who can see the interview can read them
 *   - an interview resumes after a dropped connection from what the
 *     server holds, and a retried answer is not counted twice
 *   - a candidate cannot write a score
 *
 * The model-backed path (a deliberately bad AI answer caught by the
 * post-filter) is in ai-video-interview-model.test.mjs, because the AI key
 * is read once at import.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestDb, applyTestEnv, makeClient } from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DB_PORT = 5587;
const API_PORT = 9941;
const base = `http://127.0.0.1:${API_PORT}`;

let dbh, server, raw, style, interview;
let recA, recB, candA, candB;
let jobId, appA;
let session;                      // candidate A's interview
const PW = 'Video123interview';

async function staff(email, role, table, id, company) {
  const { hashPassword } = await import('../src/auth.js');
  const hash = await hashPassword(PW);
  const u = (await raw(`insert into users (email,password_hash,role) values ($1,$2,$3) returning id`,
    [email, hash, role])).rows[0].id;
  await raw(`insert into ${table} (id, user_id, name, email, company_id) values ($1,$2,$3,$4,$5)`,
    [id, u, `${role} ${id}`, email, company]);
  const c = makeClient(base);
  await c.get('/api/health');
  const r = await c.post('/api/auth/login', { email, password: PW, role });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return c;
}

async function candidate(name, email, phone) {
  const c = makeClient(base);
  await c.get('/api/health');
  const r = await c.post('/api/auth/register', {
    name, email, password: PW, phone, preferredLocation: 'Hyderabad', expectedCtc: 4,
    noticePeriod: 'Immediate', preferredWorkModes: ['Hybrid'],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  c.id = r.body.candidateId;
  return c;
}

/** A tiny but genuine WebM: the EBML magic bytes, then padding. */
const webm = (n = 2048, fill = 7) => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(n, fill)]);

function recordingForm(buf, { seq, part = 'main', type = 'video/webm', name = 'answer.webm', durationMs = 4000 }) {
  const fd = new FormData();
  fd.append('seq', String(seq));
  fd.append('part', part);
  fd.append('durationMs', String(durationMs));
  fd.append('recording', new Blob([buf], { type }), name);
  return fd;
}

test('boot', async () => {
  dbh = await startTestDb(DB_PORT);
  applyTestEnv(dbh.url, {
    PUBLIC_ORIGIN: base,
    DISABLE_BACKGROUND_WORK: 'true',
    AI_API_KEY: '',
    STORAGE_LOCAL_DIR: resolve(HERE, '../var/test-uploads-video'),
    EMAIL_API_KEY: '', EMAIL_SMTP_HOST: '', EMAIL_SMTP_USER: '', EMAIL_SMTP_PASS: '',
    EMAILJS_SERVICE_ID: '', EMAILJS_TEMPLATE_ID: '', EMAILJS_PUBLIC_KEY: '', EMAILJS_PRIVATE_KEY: '',
    SMS_API_KEY: '', WHATSAPP_API_KEY: '',
    INTERVIEW_STT_PROVIDER: '', INTERVIEW_TTS_PROVIDER: '',
  });
  raw = (sql, params) => dbh.db.query(sql, params);
  await raw(`insert into companies (id, name) values ('co_vi', 'Video Co'), ('co_vo', 'Other Co')`);

  const { createApp } = await import('../src/app.js');
  style = await import('../src/ai/interview-style.js');
  interview = await import('../src/ai/interview.js');
  const app = createApp({ logger: { error() {}, log() {} } });
  await new Promise((r) => { server = app.listen(API_PORT, r); });

  recA = await staff('rec.vi@tl-sink.local', 'recruiter', 'recruiters', 'r_vi1', 'co_vi');
  recB = await staff('rec.vo@tl-sink.local', 'recruiter', 'recruiters', 'r_vi2', 'co_vo');

  jobId = 'j_vi1';
  await raw(`insert into jobs (id, title, company_id, location, mode, exp_label, skills, status, recruiter_id, description, published_at)
             values ($1, 'HR Recruiter', 'co_vi', 'Hyderabad', 'Onsite', '1-3 yrs', $2, 'open', 'r_vi1', $3, now())`,
    [jobId, ['Sourcing', 'ATS', 'Excel', 'Stakeholder management'],
     'Own end-to-end hiring for client roles. Screen candidates and schedule interviews.']);
  candA = await candidate('Asha Video', 'asha.vi@tl-sink.local', '9300000001');
  candB = await candidate('Bharat Video', 'bharat.vi@tl-sink.local', '9300000002');
  appA = (await candA.post('/api/applications', { jobId })).body.application.id;
  await candB.post('/api/applications', { jobId });
});

/* ------------------------------------------------------------------ *
 * question style
 * ------------------------------------------------------------------ */

test('style: the owner\'s bad examples are rewritten into the good ones', () => {
  const a = style.enforceQuestion(
    'The role asks for Sourcing, which I could not find on your resume. What is your experience with it?');
  assert.equal(a.action, 'rewritten');
  assert.equal(a.question, 'Sourcing is a key part of this role. Could you walk me through your experience with it?');

  for (const bad of [
    "You haven't used an ATS. Why not?",
    'Your resume does not show Excel. Tell me about it.',
    "I don't see Python listed. Have you used it?",
    'You did not mention stakeholder management. How did that come into it?',
    'It is not listed on your CV, but have you done payroll?',
  ]) {
    const r = style.enforceQuestion(bad);
    assert.notEqual(r.action, 'kept', `kept: ${bad}`);
    if (r.question) {
      assert.equal(style.bannedPhrase(r.question), null, `still gap-phrased: ${r.question}`);
      assert.ok(style.wordCount(r.question) <= style.MAX_QUESTION_WORDS);
    }
  }
});

test('style: questions over 25 words are shortened or dropped', () => {
  const long = 'Could you please describe in a great deal of detail every single project you have ever worked on, '
    + 'including the tools, the team, the outcomes, the challenges and the lessons?';
  assert.ok(style.wordCount(long) > 25);
  const r = style.enforceQuestion(long);
  assert.ok(r.action === 'blocked' || style.wordCount(r.question) <= style.MAX_QUESTION_WORDS, JSON.stringify(r));
  const withTopic = style.enforceQuestion(long, { topic: 'Sourcing' });
  assert.equal(withTopic.action, 'rewritten');
  assert.ok(style.wordCount(withTopic.question) < 25);
  assert.equal(style.enforceQuestion('Excel is central to this role. Which tools or methods have you used for it?').action, 'kept');
});

test('style: protected personal topics are blocked, the role\'s own words are not', () => {
  for (const q of ['How old are you?', 'Are you married, and do you have children?', 'What is your religion?',
    'Which caste do you belong to?', 'Do you have any medical condition we should know about?',
    'What is your nationality?', 'Where are you originally from?', 'What is your date of birth?']) {
    const r = style.enforceQuestion(q);
    assert.equal(r.action, 'blocked', q);
    assert.match(r.reasons[0], /protected topic/);
  }
  // A nurse's work and a business analyst's skill are job topics.
  assert.equal(style.enforceQuestion('Patient health monitoring is a key part of this role. Could you walk me through it?',
    { allowed: ['Patient health monitoring'] }).action, 'kept');
  assert.equal(style.enforceQuestion('Gap analysis is a key part of this role. Could you walk me through it?',
    { allowed: ['Gap analysis'] }).action, 'kept');
});

test('style: with NO AI key the server\'s own plan follows the same rules', async () => {
  assert.equal(interview.aiConfigured(), false);
  const r = await candA.post('/api/ai-interviews/session', { applicationId: appA });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  session = r.body;
  assert.equal(session.questions.length, 15, 'the blueprint still adds up');
  assert.deepEqual(session.speech, { stt: 'browser', tts: 'browser' }, 'server speech is off by default');
  for (const q of session.questions) {
    assert.ok(style.wordCount(q.question) <= style.MAX_QUESTION_WORDS, `${style.wordCount(q.question)} words: ${q.question}`);
    assert.equal(style.bannedPhrase(q.question), null, `gap phrasing: ${q.question}`);
    assert.equal(style.protectedTopic(q.question), null, `protected topic: ${q.question}`);
  }
  const jd = session.questions.filter((q) => q.section === 'jd').map((q) => q.question);
  assert.ok(jd.includes('Sourcing is a key part of this role. Could you walk me through your experience with it?'),
    `the owner's template is used: ${jd.join(' | ')}`);
  assert.doesNotMatch(JSON.stringify(session), /sk-ant|x-api-key|bearer/i, 'no key material in the response');
  // A thin resume, a long title and no skills at all still give 15 clean questions.
  const plan = interview.planFromJob({
    job: { title: 'Senior Staff Nurse Night Shift Intensive Care Unit', skills: [], requirements: [],
      responsibilities: ['Monitor and record patient vital signs and report changes to the duty doctor promptly every hour'],
      desc: '' },
    candidate: { skills: [], projects: ['A very long project title that goes on and on for many many words indeed'] },
  });
  assert.equal(plan.length, 15);
  for (const q of plan) {
    assert.ok(style.wordCount(q.question) <= style.MAX_QUESTION_WORDS, q.question);
    assert.equal(style.bannedPhrase(q.question), null, q.question);
  }
});

/* ------------------------------------------------------------------ *
 * follow-ups
 * ------------------------------------------------------------------ */

const answer = (body) => candA.post(`/api/ai-interviews/${session.interviewId}/answer`, body);

test('follow-up: a vague answer gets ONE follow-up from the templates, and a retry gets the same one', async () => {
  const seq = session.questions[0].seq;
  const a = await answer({ seq, transcript: 'Yes, I can do that.' });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.ok(style.FOLLOW_UP_TEMPLATES.includes(a.body.followUp), a.body.followUp);
  assert.equal(a.body.followUp, 'Could you share a specific example?');

  // The connection dropped and the browser sent the same answer again.
  const again = await answer({ seq, transcript: 'Yes, I can do that.' });
  assert.equal(again.body.followUp, a.body.followUp, 'the retry is offered the same follow-up');
  const rows = (await raw(`select part from ai_interview_answer_parts where interview_id=$1 and seq=$2`,
    [session.interviewId, seq])).rows;
  assert.equal(rows.filter((x) => x.part === 'followup').length, 1, 'still exactly one follow-up');

  // The follow-up's own answer never draws another, however vague.
  const fu = await answer({ seq, part: 'followup', transcript: 'Not really sure.' });
  assert.equal(fu.status, 200, JSON.stringify(fu.body));
  assert.equal(fu.body.followUp, null, 'a second follow-up was asked');
  assert.ok(fu.body.next, 'and the interview moves on');

  // The database itself refuses a second follow-up row.
  await assert.rejects(raw(`insert into ai_interview_answer_parts (interview_id, seq, part, question)
                            values ($1,$2,'followup','Another?')`, [session.interviewId, seq]));

  // Both answers are what the grading will read.
  const row = (await raw(`select answer_summary, answered from ai_interview_answers where ai_interview_id=$1 and seq=$2`,
    [session.interviewId, seq])).rows[0];
  assert.equal(row.answer_summary, 'Yes, I can do that. Not really sure.');
  assert.equal(row.answered, true);
});

test('follow-up: a concrete answer gets none; a follow-up answer without a follow-up is refused', async () => {
  const seq = session.questions[1].seq;
  const a = await answer({ seq, transcript: 'At my last job I sourced 40 candidates on LinkedIn for a client project '
    + 'and we closed 6 hires within a month, which cut the time to hire by a third.' });
  assert.equal(a.body.followUp, null, a.body.followUp);
  const stray = await answer({ seq, part: 'followup', transcript: 'extra' });
  assert.equal(stray.status, 400);
});

test('follow-up: the deterministic rules pick the owner\'s templates', async () => {
  const d = (t) => interview.decideFollowUp({ question: { question: 'q' }, answer: t, job: { title: 'HR Recruiter' } });
  assert.equal((await d('Fine.')).text, 'Could you share a specific example?');
  assert.equal((await d('I usually work hard and try my best with whatever I am given, and I communicate well with people.')).kind, 'example');
  assert.equal((await d('In my previous project I handled the hiring drive for the warehouse team and coordinated with managers every day.')).text,
    'What was the outcome?');
  assert.equal(await d(''), null, 'silence is scored, not probed');
  assert.equal(await d('At my last role I used Excel and our ATS to track 120 candidates, and we improved offer acceptance to 80 percent.'), null);
});

test('no experience: "Thank you for being open. How would you approach learning it?" then on to the next question', async () => {
  const seq = session.questions[2].seq;
  const a = await answer({ seq, transcript: 'Honestly I have no experience with that.' });
  assert.equal(a.body.followUp, 'Thank you for being open. How would you approach learning it?');
  assert.equal(a.body.followUpKind, 'no_experience');
  const b = await answer({ seq, part: 'followup', transcript: 'I would take a short course and practise on real requisitions.' });
  assert.equal(b.body.followUp, null);
  assert.equal(b.body.next.seq, session.questions[3].seq, 'moves to the next question');
});

/* ------------------------------------------------------------------ *
 * recordings
 * ------------------------------------------------------------------ */

let recId;

test('recordings: saved per question, linked to the interview, question, candidate and job', async () => {
  const seq = session.questions[0].seq;
  const up = await candA.post(`/api/ai-interviews/${session.interviewId}/recordings`, recordingForm(webm(), { seq }));
  assert.equal(up.status, 201, JSON.stringify(up.body));
  assert.equal(up.body.recording.mime, 'video/webm');
  const fu = await candA.post(`/api/ai-interviews/${session.interviewId}/recordings`,
    recordingForm(webm(1024, 9), { seq, part: 'followup' }));
  assert.equal(fu.status, 201, JSON.stringify(fu.body));

  const row = (await raw(`select * from ai_interview_recordings where interview_id=$1 and seq=$2 and part='main'`,
    [session.interviewId, seq])).rows[0];
  assert.equal(row.candidate_id, candA.id);
  assert.equal(row.job_id, jobId);
  assert.equal(row.application_id, appA);
  assert.match(row.storage_path, new RegExp(`^interviews/${candA.id}/${session.interviewId}/`));

  const list = await candA.get(`/api/ai-interviews/${session.interviewId}/recordings`);
  assert.equal(list.body.recordings.length, 2);
  recId = list.body.recordings.find((x) => x.part === 'main').id;
  const file = await fetch(`${base}/api/ai-interviews/${session.interviewId}/recordings/${recId}/file`, {
    headers: { cookie: [...candA.jar].map(([k, v]) => `${k}=${v}`).join('; ') } });
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'video/webm');
  assert.equal(file.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(Buffer.from(await file.arrayBuffer()).equals(webm()));

  // A retried upload replaces itself rather than adding a second file.
  const again = await candA.post(`/api/ai-interviews/${session.interviewId}/recordings`, recordingForm(webm(4096), { seq }));
  assert.equal(again.status, 201);
  const n = (await raw(`select count(*)::int n from ai_interview_recordings where interview_id=$1 and seq=$2 and part='main'`,
    [session.interviewId, seq])).rows[0].n;
  assert.equal(n, 1);
});

test('recordings: the same type and size checks as a resume', async () => {
  const seq = session.questions[1].seq;
  const fake = await candA.post(`/api/ai-interviews/${session.interviewId}/recordings`,
    recordingForm(Buffer.from('<html><script>alert(1)</script></html>'), { seq, type: 'video/webm' }));
  assert.equal(fake.status, 415, 'an HTML file named .webm was accepted');
  const empty = await candA.post(`/api/ai-interviews/${session.interviewId}/recordings`, recordingForm(Buffer.alloc(0), { seq }));
  assert.ok([400, 415].includes(empty.status));
  const notMine = await candB.post(`/api/ai-interviews/${session.interviewId}/recordings`, recordingForm(webm(), { seq }));
  assert.equal(notMine.status, 404, 'another candidate uploaded into this interview');
  const staffUp = await recA.post(`/api/ai-interviews/${session.interviewId}/recordings`, recordingForm(webm(), { seq }));
  assert.equal(staffUp.status, 403);
  const noSuchQ = await candA.post(`/api/ai-interviews/${session.interviewId}/recordings`, recordingForm(webm(), { seq: 49 }));
  assert.equal(noSuchQ.status, 404);
});

test('recordings and transcripts: another candidate and a recruiter outside scope see nothing', async () => {
  const path = `/api/ai-interviews/${session.interviewId}/recordings`;
  assert.deepEqual((await candB.get(path)).body.recordings, [], 'another candidate listed the recordings');
  assert.equal((await candB.get(`${path}/${recId}/file`)).status, 404, 'another candidate read a recording');
  assert.deepEqual((await recB.get(path)).body.recordings, [], 'a recruiter at another company listed them');
  assert.equal((await recB.get(`${path}/${recId}/file`)).status, 404, 'a recruiter at another company read one');
  assert.equal((await candB.get(`/api/ai-interviews/${session.interviewId}/progress`)).status, 404);
  assert.equal((await recB.get(`/api/ai-interviews?candidateId=${candA.id}`)).body.aiInterviews.length, 0);

  // The recruiter who owns the job sees them, and the view is audited.
  const mine = await recA.get(path);
  assert.equal(mine.body.recordings.length, 2);
  assert.equal((await recA.get(`${path}/${recId}/file`)).status, 200);
  const audit = (await raw(`select count(*)::int n from ai_interview_audit where interview_id=$1 and action='recording.viewed'`,
    [session.interviewId])).rows[0].n;
  assert.ok(audit >= 1, 'the recruiter viewing a recording was not audited');

  // No public URL: the storage key is not servable through the resume route.
  const key = (await raw(`select storage_path from ai_interview_recordings where id=$1`, [recId])).rows[0].storage_path;
  assert.equal((await recA.get(`/api/files/${encodeURIComponent(key)}`)).status, 404);
  assert.equal((await fetch(`${base}${path}/${recId}/file`)).status, 401, 'readable without signing in');
});

/* ------------------------------------------------------------------ *
 * resume after a drop
 * ------------------------------------------------------------------ */

test('resume: progress says where to carry on, and a retried answer is not counted twice', async () => {
  let p = await candA.get(`/api/ai-interviews/${session.interviewId}/progress`);
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal(p.body.resumable, true);
  assert.deepEqual(p.body.resumeAt, { seq: session.questions[3].seq, part: 'main' });
  assert.equal(p.body.questions.length, 15);
  assert.deepEqual(p.body.questions[0].recordings.sort(), ['followup', 'main']);
  assert.doesNotMatch(JSON.stringify(p.body), /"score"|justification|overall/i, 'progress exposes a score');

  // Question 4 answered vaguely: the follow-up is pending.
  const seq = session.questions[3].seq;
  const a = await answer({ seq, transcript: 'Yes.' });
  assert.ok(a.body.followUp);
  p = await candA.get(`/api/ai-interviews/${session.interviewId}/progress`);
  assert.deepEqual(p.body.resumeAt, { seq, part: 'followup' }, 'resumes on the same question\'s follow-up');

  // The connection dropped mid-request and the page sent everything again.
  await answer({ seq, transcript: 'Yes.' });
  await answer({ seq, part: 'followup', transcript: 'I screened 30 CVs a day using our ATS.' });
  await answer({ seq, part: 'followup', transcript: 'I screened 30 CVs a day using our ATS.' });
  const answered = (await raw(`select questions_answered from ai_interviews where id=$1`, [session.interviewId])).rows[0];
  assert.equal(answered.questions_answered, 4, 'a retried answer was counted twice');
  p = await candA.get(`/api/ai-interviews/${session.interviewId}/progress`);
  assert.deepEqual(p.body.resumeAt, { seq: session.questions[4].seq, part: 'main' });

  assert.equal((await recA.get(`/api/ai-interviews/${session.interviewId}/progress`)).status, 403);
});

/* ------------------------------------------------------------------ *
 * the candidate cannot write a score
 * ------------------------------------------------------------------ */

test('a candidate cannot write a score, an evaluation or a decision', async () => {
  // The old "record a result" route took per-question scores from the caller.
  const forged = await candA.post('/api/ai-interviews', {
    candidateId: candA.id, jobId, applicationId: appA, questionSetHash: 'qs-forged', contentScored: true,
    answers: [{ seq: 1, category: 'technical', question: 'Q', answered: true, score: 100, commScore: 100 }],
  });
  assert.equal(forged.status, 403, JSON.stringify(forged.body));

  // Score fields on an answer are ignored, not stored.
  const seq = session.questions[4].seq;
  await answer({ seq, transcript: 'I built the weekly hiring dashboard in Excel and it reduced reporting time.',
    score: 100, commScore: 100, justification: 'Perfect', overallPercentage: 99 });
  const row = (await raw(`select score, comm_score from ai_interview_answers where ai_interview_id=$1 and seq=$2`,
    [session.interviewId, seq])).rows[0];
  assert.equal(Number(row.score), 0);
  assert.equal(row.comm_score, null);

  // Integrity review and reopening are staff-only.
  assert.equal((await candA.post(`/api/ai-interviews/${session.interviewId}/integrity/1/review`,
    { reviewStatus: 'dismissed', notes: 'mine' })).status, 403);
  assert.equal((await candA.post(`/api/ai-interviews/${session.interviewId}/reopen`, { reason: 'please' })).status, 403);

  // The pipeline decision is not the candidate's either.
  const stage = await candA.put(`/api/applications/${appA}/status`, { stage: 'selected' });
  assert.ok([401, 403, 404].includes(stage.status), `candidate moved their own stage (${stage.status})`);
});

test('finish: the server grades, the transcript carries the follow-ups, a late upload is still accepted', async () => {
  const f = await candA.post(`/api/ai-interviews/${session.interviewId}/finish`, {});
  assert.equal(f.status, 200, JSON.stringify(f.body));
  assert.equal(f.body.aiInterview.status, 'completed');
  const iv = (await raw(`select transcript, questions_answered from ai_interviews where id=$1`, [session.interviewId])).rows[0];
  assert.match(iv.transcript, /Follow-up: Could you share a specific example\?\nA \(follow-up\): Not really sure\./);
  assert.match(iv.transcript, /Follow-up: Thank you for being open\. How would you approach learning it\?/);
  assert.equal(iv.questions_answered, 5);

  // The last answer's upload may land just after the interview finished.
  const late = await candA.post(`/api/ai-interviews/${session.interviewId}/recordings`,
    recordingForm(webm(), { seq: session.questions[4].seq }));
  assert.equal(late.status, 201, JSON.stringify(late.body));
  // But no more answers.
  assert.equal((await answer({ seq: session.questions[5].seq, transcript: 'late' })).status, 400);
});

test('shutdown', async () => {
  const { stopBackgroundWork } = await import('../src/app.js');
  const { closePool } = await import('../src/db.js');
  stopBackgroundWork();
  await new Promise((r) => server.close(r));
  await closePool();
  await dbh.stop();
});
