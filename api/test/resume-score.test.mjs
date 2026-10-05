/**
 * Resume score + improvement tips (0094), end to end against a real
 * Postgres with RLS on. The AI tips run against a LOCAL mock of the
 * Messages API - never the real one - including its failure modes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startTestDb, applyTestEnv, makeClient } from './harness.mjs';

const DB_PORT = 5464;
const API_PORT = 9984;
const AI_PORT = 9972;
const CLIENT_CO = 'Quorvane Biologics';

let dbh, server, base, raw, config, hashPassword, aiServer;
const ai = { mode: 'ok', requests: [] };

function startAiMock() {
  return new Promise((resolve) => {
    aiServer = createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        let parsed = null; try { parsed = JSON.parse(body); } catch { /* */ }
        ai.requests.push({ url: req.url, headers: req.headers, body: parsed });
        if (ai.mode === 'hang') return;                         // never answers
        if (ai.mode === 'error') { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"type":"error","error":{"type":"api_error","message":"boom"}}'); return; }
        const tips = ai.mode === 'garbage' ? '{not json' : JSON.stringify({ tips: [
          { section: 'experience', priority: 'High', issue: 'Your last job lists duties, not results: "responsible for billing".', fix: 'Rewrite it as a result, e.g. "billed 150 customers a day with no errors".', gain: 6 },
          { section: 'summary', priority: 'Medium', issue: `Your summary mentions ${CLIENT_CO}.`, fix: 'Remove it.', gain: 3 },
          { section: 'nonsense', priority: 'High', issue: 'x'.repeat(20), fix: 'y'.repeat(20), gain: 5 },
          { section: 'skills', priority: 'Low', issue: 'Skills are listed without levels.', fix: 'Add how well you know each tool, e.g. "Excel (advanced)".', gain: 2 },
        ] });
        res.writeHead(200, { 'content-type': 'application/json', 'request-id': 'req_mock' });
        res.end(JSON.stringify({
          id: 'msg_mock', type: 'message', role: 'assistant', model: 'claude-opus-5-5',
          content: ai.mode === 'refusal' ? [] : [{ type: 'text', text: tips }],
          stop_reason: ai.mode === 'refusal' ? 'refusal' : 'end_turn', stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 10 },
        }));
      });
    });
    aiServer.listen(AI_PORT, '127.0.0.1', resolve);
  });
}

async function candidate(name, email) {
  const c = makeClient(base);
  await c.get('/api/health');
  const r = await c.post('/api/auth/register', {
    name, email, password: 'Scores123x', phone: '9' + String(Math.floor(1e8 + Math.random() * 9e8)),
    preferredLocation: 'Hyderabad', expectedCtc: 4, noticePeriod: 'Immediate', preferredWorkModes: ['Hybrid'],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  c.id = r.body.candidateId;
  return c;
}

const RESUME = `Ravi Kumar
ravi.kumar@mail.com  +91 98765 43210  Hyderabad
SUMMARY
Accounts executive with 4 years in retail billing and GST filing. Handled 150 invoices a day and cut month-end closing by 2 days.
EXPERIENCE
Accounts Executive, Retail Mart, Jan 2021 - Mar 2024
- Managed daily billing for 3 stores and 150 invoices a day
- Reduced payment delays by 20% by following up with 40 vendors
- Prepared GST returns and maintained ledgers in Tally ERP
Accounts Assistant, City Traders, Jun 2019 - Dec 2020
- Processed vendor payments and resolved billing queries
EDUCATION
B.Com, Osmania University, 2019
SKILLS
Tally ERP, GST, Excel, Accounts Payable, Bank Reconciliation, Invoicing, MS Excel pivot tables, TDS
CERTIFICATIONS
Tally Prime certification; GST Practitioner course
PROJECTS
Inventory reconciliation for 3 stores - matched stock to ledgers every month
` + 'Additional details about responsibilities and tools used in each role. '.repeat(12);

let A, B, R;

test('boot', async () => {
  dbh = await startTestDb(DB_PORT);
  await startAiMock();
  applyTestEnv(dbh.url, {
    PUBLIC_ORIGIN: `http://127.0.0.1:${API_PORT}`,
    DISABLE_BACKGROUND_WORK: 'true',
    AI_API_KEY: '',
    AI_API_BASE_URL: `http://127.0.0.1:${AI_PORT}`,
    AI_TIPS_TIMEOUT_MS: '1500',
    RESUME_SCORE_RATE_MAX: '1000',
  });
  raw = (sql, params) => dbh.db.query(sql, params);
  const { createApp } = await import('../src/app.js');
  ({ config } = await import('../src/config.js'));
  ({ hashPassword } = await import('../src/auth.js'));
  const app = createApp({ logger: { error() {}, log() {} } });
  await new Promise((r) => { server = app.listen(API_PORT, r); });
  base = `http://127.0.0.1:${API_PORT}`;

  await raw(`insert into companies (id, name) values ('co_rs', $1)`, [CLIENT_CO]);
  const hash = await hashPassword('Staff12345');
  const u = (await raw(`insert into users (email,password_hash,role) values ('rs.rec@tl-sink.local',$1,'recruiter') returning id`, [hash])).rows[0].id;
  await raw(`insert into recruiters (id,user_id,name,email,company_id) values ('r_rs',$1,'Rita Rec','rs.rec@tl-sink.local','co_rs')`, [u]);
  R = makeClient(base); await R.get('/api/health');
  assert.equal((await R.post('/api/auth/login', { email: 'rs.rec@tl-sink.local', password: 'Staff12345' })).status, 200);

  for (const [id, title, skills] of [
    ['jrs1', 'Java Developer', ['Java', 'Spring Boot', 'SQL', 'AWS']],
    ['jrs2', 'Senior Java Developer', ['Java', 'Microservices', 'SQL', 'Kafka']],
    ['jrs3', 'Accountant', ['Tally ERP', 'GST', 'Excel']],
  ]) {
    await raw(`insert into jobs (id, title, company_id, recruiter_id, location, status, skills, published_at)
               values ($1,$2,'co_rs','r_rs','Hyderabad','open',$3,now())`, [id, title, skills]);
  }
  A = await candidate('Asha Score', 'asha.score@tl-sink.local');
  B = await candidate('Bala Score', 'bala.score@tl-sink.local');
});

test('a new profile is scored out of 100 in eight sections, with at most five tips', async () => {
  const r = await A.get('/api/candidate/resume/score');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const s = r.body.score;
  assert.equal(s.status, 'scored');
  assert.ok(Number.isInteger(s.total) && s.total >= 0 && s.total <= 100);
  assert.ok(['Needs Work', 'Good', 'Strong', 'Excellent'].includes(s.label));
  assert.deepEqual(s.sections.map((x) => x.key),
    ['contact', 'summary', 'experience', 'skills', 'education', 'projects', 'formatting', 'keywords']);
  assert.deepEqual(s.sections.map((x) => x.max), [10, 10, 25, 15, 10, 10, 10, 10]);
  assert.equal(s.total, s.sections.reduce((a, x) => a + x.score, 0));
  assert.ok(s.tips.length > 0 && s.tips.length <= 5);
  const order = { High: 0, Medium: 1, Low: 2 };
  for (let i = 1; i < s.tips.length; i += 1) assert.ok(order[s.tips[i - 1].priority] <= order[s.tips[i].priority]);
  for (const t of s.tips) {
    for (const k of ['section', 'priority', 'issue', 'fix', 'gain', 'field']) assert.ok(t[k] !== undefined && t[k] !== '', `tip.${k}`);
    assert.equal(t.source, 'rules');
  }
  assert.equal(s.label, 'Needs Work');
});

test('tips are specific: the role\'s missing skills are named', async () => {
  const p = await A.put(`/api/candidates/${A.id}`, { preferredRole: 'Java Developer', skills: ['Java'] });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  const s = (await A.get('/api/candidate/resume/score')).body.score;
  const all = JSON.stringify(s.tips);
  assert.match(all, /common for Java Developer: (SQL|Spring Boot|AWS|Microservices|Kafka)/);
});

test('the score is recalculated when the profile changes, and history shows the climb', async () => {
  const before = (await A.get('/api/candidate/resume/score')).body.score;
  const p = await A.put(`/api/candidates/${A.id}`, {
    location: 'Hyderabad',
    summary: 'Java developer with 3 years building Spring Boot services and SQL reporting. Cut API response time by 30% for an order system used by 2,000 stores.',
    skills: ['Java', 'Spring Boot', 'SQL', 'AWS', 'Hibernate', 'REST APIs', 'Git', 'JUnit'],
    certifications: ['Oracle Java SE 11', 'AWS Cloud Practitioner'],
    education: 'B.Tech Computer Science, JNTU, 2020',
  });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  const queued = (await raw(`select count(*)::int n from candidate_resume_score_queue where candidate_id = $1`, [A.id])).rows[0].n;
  assert.equal(queued, 1, 'the change queued a re-score');

  const post = await A.post('/api/candidate/resume/score', {});
  assert.equal(post.status, 200, JSON.stringify(post.body));
  assert.ok(post.body.score.total > before.total, `${post.body.score.total} > ${before.total}`);
  assert.deepEqual(post.body.improvement, { from: before.total, to: post.body.score.total });
  assert.equal(post.body.engine, 'rules');

  const h = await A.get('/api/candidate/resume/score/history');
  assert.equal(h.status, 200);
  assert.ok(h.body.history.length >= 3);
  assert.equal(h.body.history[0].total, post.body.score.total);

  // Nothing changed: no new row.
  const n1 = h.body.history.length;
  await A.get('/api/candidate/resume/score');
  assert.equal((await A.get('/api/candidate/resume/score/history')).body.history.length, n1);
});

test('"+N since last week" compares with the score a week ago', async () => {
  await raw(`update candidate_resume_scores set scored_at = now() - interval '8 days'
              where id = (select min(id) from candidate_resume_scores where candidate_id = $1)`, [A.id]);
  const first = (await raw(`select total_score from candidate_resume_scores where candidate_id = $1 order by id limit 1`, [A.id])).rows[0].total_score;
  const r = await A.get('/api/candidate/resume/score');
  assert.equal(r.body.sinceLastWeek, r.body.score.total - first);
  assert.ok(r.body.sinceLastWeek > 0);
});

test('an unreadable resume says so and is never scored 0', async () => {
  await raw(`update candidates set resume_file = 'scan.pdf', resume_text = null,
                    resume_parse_error = 'This PDF has no text layer' where id = $1`, [B.id]);
  const r = await B.get('/api/candidate/resume/score');
  assert.equal(r.status, 200);
  assert.equal(r.body.score.status, 'unreadable');
  assert.equal(r.body.score.total, null);
  assert.equal(r.body.score.message, 'We could not read your resume. Try a PDF or DOCX');
  assert.equal(r.body.score.tips.length, 0);
});

test('a readable resume is read: formatting, results and keywords count', async () => {
  await raw(`update candidates set resume_file = 'ravi.pdf', resume_text = $2, resume_parse_error = null,
                    preferred_role = 'Accountant', skills = '{Tally ERP,GST,Excel,Accounts Payable,Bank Reconciliation,Invoicing,TDS,MS Excel}',
                    summary = 'Accounts executive with 4 years in retail billing and GST filing. Handled 150 invoices a day and cut month-end closing by 2 days.',
                    education = 'B.Com, Osmania University, 2019', certifications = '{Tally Prime,GST Practitioner}',
                    projects = '[{"name":"Inventory reconciliation","desc":"Matched stock to ledgers for 3 stores every month"}]'::jsonb,
                    location = 'Hyderabad', exp_years = 4, current_company = 'Retail Mart', title = 'Accounts Executive'
              where id = $1`, [B.id, RESUME]);
  await raw(`insert into candidate_experience (candidate_id, company, job_title, start_date, end_date, responsibilities, sort_order)
             values ($1,'Retail Mart','Accounts Executive','2021-01-01','2024-03-01','Managed billing for 3 stores, 150 invoices a day; reduced delays by 20%',0),
                    ($1,'City Traders','Accounts Assistant','2019-06-01','2020-12-01','Processed vendor payments',1)`, [B.id]);
  const r = await B.get('/api/candidate/resume/score');
  const s = r.body.score;
  assert.equal(s.status, 'scored');
  const sec = Object.fromEntries(s.sections.map((x) => [x.key, x.score]));
  assert.ok(sec.formatting >= 8, `formatting ${sec.formatting}`);
  assert.ok(sec.experience >= 20, `experience ${sec.experience}`);
  assert.ok(sec.keywords >= 8, `keywords ${sec.keywords}`);
  assert.ok(s.total >= 75, `total ${s.total}`);
  assert.ok(['Strong', 'Excellent'].includes(s.label));
});

test('AI tips: validated, labelled AI, contact details never sent, fallback flags on', async () => {
  config.aiApiKey = 'test-key-for-mock';
  ai.mode = 'ok'; ai.requests.length = 0;
  const r = await B.post('/api/candidate/resume/score', { lang: 'te' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.engine, 'ai');
  const tips = r.body.score.aiTips;
  assert.equal(tips.length, 2, 'the company tip and the bad section were dropped');
  tips.forEach((t) => { assert.equal(t.source, 'ai'); assert.ok(t.field); });
  assert.ok(!JSON.stringify(r.body).includes(CLIENT_CO));

  assert.equal(ai.requests.length, 1);
  const q = ai.requests[0];
  assert.match(q.url, /\/v1\/messages/);
  assert.match(String(q.headers['anthropic-beta'] || ''), /server-side-fallback-2026-07-01/);
  assert.equal(q.body.fallbacks, 'default');
  assert.equal(q.body.model, 'claude-opus-5-5');
  assert.equal(q.body.output_config.effort, 'low');
  assert.equal(q.body.output_config.format.type, 'json_schema');
  assert.equal(q.body.system[0].cache_control.type, 'ephemeral');
  const sent = JSON.stringify(q.body.messages);
  assert.ok(!sent.includes('ravi.kumar@mail.com'), 'email was sent to the model');
  assert.ok(!sent.includes('98765 43210'), 'phone was sent to the model');
  assert.match(sent, /Telugu/);
});

test('AI failure, timeout, garbage or refusal falls back to rule tips', async () => {
  for (const mode of ['error', 'garbage', 'refusal', 'hang']) {
    ai.mode = mode;
    const r = await B.post('/api/candidate/resume/score', {});
    assert.equal(r.status, 200, `${mode}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.engine, 'rules', mode);
    assert.ok(r.body.aiReason, mode);
    assert.equal(r.body.score.status, 'scored');
    assert.ok(r.body.score.tips.length >= 0);
  }
  ai.mode = 'ok';
  config.aiApiKey = '';
  const r = await B.post('/api/candidate/resume/score', {});
  assert.equal(r.body.engine, 'rules');
  assert.equal(r.body.aiReason, 'AI_API_KEY is not set');
});

test('recruiter: badges for candidates they can see, and the 70+ filter', async () => {
  for (const c of [A, B]) {
    const r = await c.post('/api/applications', { jobId: 'jrs3' });
    assert.ok([200, 201].includes(r.status), JSON.stringify(r.body));
  }
  const b = await R.get(`/api/resume-scores?ids=${A.id},${B.id},nobody`);
  assert.equal(b.status, 200, JSON.stringify(b.body));
  assert.ok(b.body.scores[A.id] && b.body.scores[B.id]);
  assert.ok(!b.body.scores.nobody);

  const all = await R.get('/api/candidates?q=Score&limit=50');
  assert.equal(all.body.candidates.length, 2);
  const high = await R.get('/api/candidates?q=Score&limit=50&resumeScoreMin=70');
  const highIds = high.body.candidates.map((c) => c.id);
  const want = [A, B].filter((c) => b.body.scores[c.id].total >= 70).map((c) => c.id);
  assert.deepEqual(highIds.sort(), want.sort());
  assert.ok(highIds.includes(B.id));
});

test('a candidate reads only their own scores; only the engine writes them', async () => {
  const { withUser } = await import('../src/db.js');
  const aUser = (await raw(`select user_id from candidates where id = $1`, [A.id])).rows[0].user_id;
  const as = { userId: aUser, role: 'candidate', profileId: A.id };
  const theirs = await withUser(as, async (c) => (await c.query(
    `select count(*)::int n from candidate_resume_scores where candidate_id = $1`, [B.id])).rows[0].n);
  assert.equal(theirs, 0);
  await assert.rejects(withUser(as, (c) => c.query(
    `select resume_score_record($1,null,'scored',99,'Excellent','{}','[]','[]','rules',null)`, [A.id])), /scoring engine only/);
  assert.equal((await A.get('/api/resume-scores?ids=' + B.id)).status, 403);
});

test('0111: a candidate with education and experience rows can still be deleted', async () => {
  /* The rows' own re-score trigger used to queue the candidate being
     deleted, and the queue's foreign key rolled the delete back. */
  const D = await candidate('Delete Me', `rs.delete.${Date.now()}@tl-sink.local`);
  await raw(`insert into candidate_education (candidate_id, qualification) values ($1, 'B.Com')`, [D.id]);
  await raw(`insert into candidate_experience (candidate_id, company) values ($1, 'Acme')`, [D.id]);
  await raw(`delete from candidates where id = $1`, [D.id]);
  assert.equal((await raw(`select count(*)::int n from candidates where id = $1`, [D.id])).rows[0].n, 0);
  assert.equal((await raw(`select count(*)::int n from candidate_resume_score_queue where candidate_id = $1`, [D.id])).rows[0].n, 0);
  /* ...and a row removed on its own still queues a re-score. */
  await raw(`insert into candidate_education (candidate_id, qualification) values ($1, 'M.Com')`, [A.id]);
  await raw(`delete from candidate_resume_score_queue where candidate_id = $1`, [A.id]);
  await raw(`delete from candidate_education where candidate_id = $1`, [A.id]);
  assert.equal((await raw(`select count(*)::int n from candidate_resume_score_queue where candidate_id = $1`, [A.id])).rows[0].n, 1);
});

test('shutdown', async () => {
  await new Promise((r) => server.close(r));
  const { closePool } = await import('../src/db.js');
  await closePool();
  await new Promise((r) => { aiServer.closeAllConnections?.(); aiServer.close(r); });
  await dbh.stop();
});
