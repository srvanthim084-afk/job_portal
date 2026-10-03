/**
 * The AI Career Assistant, end to end against a real Postgres with RLS on.
 *
 * The Anthropic API is NEVER called: AI_API_BASE_URL points the official
 * SDK at a local mock HTTP server that answers the Messages API shape and
 * records every request, so the assertions can read exactly what the
 * model would have been sent - and what it would not.
 *
 * Two modes in one run:
 *   rules  AI_API_KEY empty (the default here) - "Basic mode"
 *   ai     the key is switched on for the later tests, and the mock plays
 *          the model: tool loop, refusal, timeout, an upstream 500, and a
 *          model that never stops calling tools.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { startTestDb, applyTestEnv, makeClient } from './harness.mjs';

const DB_PORT = 5470;
const API_PORT = 9990;
const MODEL_PORT = 9978;

let dbh, server, base, raw, config, model;

/* ------------------------------------------------------------------ *
 * the mock model
 * ------------------------------------------------------------------ */

function startMockModel(port) {
  const requests = [];
  let script = [];
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', async () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch { /* keep {} */ }
      requests.push({ url: req.url, headers: req.headers, body: json });
      const step = script.length > 1 ? script.shift() : script[0];
      const out = typeof step === 'function' ? step(json, requests.length) : step;
      if (!out) { res.writeHead(500); res.end('{}'); return; }
      if (out.delayMs) await new Promise((r) => setTimeout(r, out.delayMs));
      if (res.destroyed) return;
      res.writeHead(out.status || 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.body || out));
    });
  });
  return new Promise((r) => srv.listen(port, '127.0.0.1', () => r({
    requests,
    play(...steps) { script = steps; requests.length = 0; },
    stop: () => new Promise((x) => { srv.closeAllConnections?.(); srv.close(x); }),
  })));
}

const msg = (content, stop = 'end_turn', usage = { input_tokens: 120, output_tokens: 30 }) => ({
  id: 'msg_' + Math.random().toString(36).slice(2), type: 'message', role: 'assistant',
  model: 'claude-opus-5-5', content, stop_reason: stop, stop_sequence: null, usage,
});
const text = (t) => msg([{ type: 'text', text: t }]);
const toolUse = (calls) => msg(calls.map(([name, input], i) => ({
  type: 'tool_use', id: `toolu_${i}_${Math.random().toString(36).slice(2, 8)}`, name, input,
})), 'tool_use');

/* ------------------------------------------------------------------ *
 * people
 * ------------------------------------------------------------------ */

async function candidate(name, email) {
  const c = makeClient(base);
  await c.get('/api/health');
  const r = await c.post('/api/auth/register', {
    name, email, password: 'Career123chat', phone: '9' + String(Date.now()).slice(-9),
    preferredLocation: 'Nellore', expectedCtc: 4, noticePeriod: 'Immediate',
    preferredWorkModes: ['Work From Office'],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  c.id = r.body.candidateId;
  c.userId = (await raw(`select user_id from candidates where id = $1`, [c.id])).rows[0].user_id;
  return c;
}

async function recruiter() {
  const { hashPassword } = await import('../src/auth.js');
  const u = await raw(`insert into users (email, password_hash, role) values ('rca@tl-sink.local', $1, 'recruiter') returning id`,
    [await hashPassword('Staff123pass')]);
  await raw(`insert into recruiters (id, user_id, name, email, company_id) values ('rca', $1, 'R CA', 'rca@tl-sink.local', 'co_ca')`, [u.rows[0].id]);
  const c = makeClient(base);
  await c.get('/api/health');
  assert.equal((await c.post('/api/auth/login', { email: 'rca@tl-sink.local', password: 'Staff123pass' })).status, 200);
  return c;
}

const send = (c, body) => c.post('/api/career-assistant/messages', body);

test('boot', async () => {
  dbh = await startTestDb(DB_PORT);
  model = await startMockModel(MODEL_PORT);
  applyTestEnv(dbh.url, {
    PUBLIC_ORIGIN: `http://127.0.0.1:${API_PORT}`,
    DISABLE_BACKGROUND_WORK: 'true',
    AI_API_KEY: '',
    AI_API_BASE_URL: `http://127.0.0.1:${MODEL_PORT}`,
    AI_ASSISTANT_TIMEOUT_MS: '1500',
    AI_ASSISTANT_MAX_RETRIES: '0',
  });
  raw = (sql, params) => dbh.db.query(sql, params);
  await raw(`insert into companies (id, name) values ('co_ca', 'Coastal Foods')`);
  await raw(`insert into jobs (id, title, company_id, location, mode, exp_label, pay_label, salary_min, salary_max,
               employment_type, status, skills, published_at)
             values ('jca1', 'Customer Support Executive', 'co_ca', 'Nellore', 'Onsite', '0-2 yrs', 'â‚¹2-3 LPA', 2, 3,
                     'Full-time', 'open', '{Communication,Telugu,MS Excel}', now()),
                    ('jca2', 'Accounts Assistant', 'co_ca', 'Nellore', 'Onsite', '0-2 yrs', 'â‚¹2.5-3.5 LPA', 2.5, 3.5,
                     'Full-time', 'open', '{Tally,GST,MS Excel}', now() - interval '1 day'),
                    ('jca_draft', 'Secret Draft Role', 'co_ca', 'Nellore', 'Onsite', '0-2 yrs', 'â‚¹9 LPA', 9, 9,
                     'Full-time', 'draft', '{}', null)`);
  ({ config } = await import('../src/config.js'));
  const { createApp } = await import('../src/app.js');
  const app = createApp({ logger: { error() {}, log() {} } });
  await new Promise((r) => { server = app.listen(API_PORT, r); });
  base = `http://127.0.0.1:${API_PORT}`;
});

let A, B, R, convA;

test('candidate only: anonymous 401, recruiter 403, validation', async () => {
  A = await candidate('Asha Rao', 'asha.ca@tl-sink.local');
  B = await candidate('Bala Krishna', 'bala.ca@tl-sink.local');
  R = await recruiter();
  await raw(`update candidates set title = 'Customer Support Executive', skills = '{Communication,Telugu}',
               education = 'B.Com', exp_years = 1 where id = $1`, [A.id]);

  const anon = makeClient(base);
  await anon.get('/api/health');
  assert.equal((await send(anon, { text: 'hi' })).status, 401);
  assert.equal((await send(R, { text: 'hi' })).status, 403);
  assert.equal((await R.get('/api/career-assistant/conversations')).status, 403);
  assert.equal((await send(A, { text: '' })).status, 400);
  assert.equal((await send(A, { text: 'x'.repeat(2001) })).status, 400);
  assert.equal((await send(A, { text: 'hi', extra: 1 })).status, 400);
});

test('no AI key: the rules engine answers from real data and says so (engine "rules")', async () => {
  let r = await send(A, { text: 'Improve my profile' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.engine, 'rules');
  assert.match(r.body.reply, /resume/i, 'A has no resume on file - the reply says to add one');
  convA = r.body.conversationId;
  assert.ok(convA);

  r = await send(A, { conversationId: convA, text: 'What jobs match me?' });
  assert.equal(r.body.engine, 'rules');
  assert.match(r.body.reply, /\[Customer Support Executive\]\(#\/job\/jca1\)/);
  assert.match(r.body.reply, /\d+% match/);
  assert.ok(!r.body.reply.includes('Secret Draft Role'), 'a draft job is never offered');

  r = await send(A, { conversationId: convA, text: 'Do I need to pay a registration fee for this job?' });
  assert.match(r.body.reply, /does not charge/);

  r = await send(A, { conversationId: convA, text: 'Interview prep' });
  assert.match(r.body.reply, /don't have an upcoming interview/);

  assert.equal(model.requests.length, 0, 'nothing was sent to a model');

  const hist = await A.get(`/api/career-assistant/conversations/${convA}`);
  assert.equal(hist.status, 200);
  assert.equal(hist.body.messages.length, 8);
  assert.deepEqual(hist.body.messages.slice(0, 2).map((m) => m.role), ['user', 'assistant']);
  assert.equal(hist.body.messages[1].engine, 'rules');
  const list = await A.get('/api/career-assistant/conversations');
  assert.equal(list.body.conversations[0].id, convA);
  assert.equal(list.body.engine, 'rules');
});

test('conversations are private: another candidate, staff and the database all agree', async () => {
  assert.equal((await B.get(`/api/career-assistant/conversations/${convA}`)).status, 404);
  assert.equal((await B.del(`/api/career-assistant/conversations/${convA}`)).status, 404);
  assert.equal((await send(B, { conversationId: convA, text: 'hello' })).status, 404, 'cannot write into it');
  assert.equal((await B.get('/api/career-assistant/conversations')).body.conversations.length, 0);

  const { withUser } = await import('../src/db.js');
  const asB = await withUser({ userId: B.userId, role: 'candidate' },
    async (c) => (await c.query(`select count(*)::int n from career_assistant_messages`)).rows[0].n);
  assert.equal(asB, 0);
  const adminUid = (await raw(`insert into users (email, password_hash, role) values ('aca@tl-sink.local','x','admin') returning id`)).rows[0].id;
  const asAdmin = await withUser({ userId: adminUid, role: 'admin' },
    async (c) => (await c.query(`select count(*)::int n from career_assistant_messages`)).rows[0].n);
  assert.equal(asAdmin, 0, 'staff cannot read a candidate\'s chat');
  const asRecruiter = await withUser({ userId: adminUid, role: 'recruiter' },
    async (c) => (await c.query(`select count(*)::int n from career_assistant_conversations`)).rows[0].n);
  assert.equal(asRecruiter, 0);
  // and a message cannot be planted into somebody else's conversation
  await assert.rejects(withUser({ userId: B.userId, role: 'candidate' }, (c) => c.query(
    `insert into career_assistant_messages (conversation_id, candidate_id, role, text)
     values ($1, app_candidate_id(), 'user', 'planted')`, [convA])));
});

test('ai: the tool loop - strict tools, one user message with every result, failures marked, RLS-scoped data', async () => {
  config.aiApiKey = 'test-key-not-real';
  let seenRound2 = null;
  model.play(
    toolUse([['get_my_profile', {}], ['search_open_jobs', { query: 'support', limit: 3 }],
             ['get_job', { job_id: 'jca_draft' }], ['match_me_to_job', { job_id: 'jca1' }]]),
    (body) => { seenRound2 = body; return text('Your best fit is **[Customer Support Executive](#/job/jca1)** in Nellore.'); },
  );
  const r = await send(A, { conversationId: convA, text: 'Which job should I apply for?' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.engine, 'ai');
  assert.match(r.body.reply, /Customer Support Executive/);
  assert.deepEqual(r.body.usedTools.sort(), ['get_job', 'get_my_profile', 'match_me_to_job', 'search_open_jobs']);
  assert.equal(model.requests.length, 2);

  const first = model.requests[0];
  assert.match(first.url, /^\/v1\/messages/);
  assert.match(String(first.headers['anthropic-beta'] || ''), /server-side-fallback-2026-07-01/);
  assert.equal(first.body.model, 'claude-opus-5-5');
  assert.equal(first.body.fallbacks, 'default');
  assert.deepEqual(first.body.output_config, { effort: 'low' });
  assert.equal(first.body.max_tokens, 16000);
  assert.ok(!('thinking' in first.body), 'no thinking parameter on this model');
  assert.deepEqual(first.body.system[0].cache_control, { type: 'ephemeral' });
  const { CAREER_ASSISTANT_PROMPT } = await import('../src/ai/career-assistant-prompt.js');
  assert.equal(first.body.system[0].text, CAREER_ASSISTANT_PROMPT);
  for (const t of first.body.tools) {
    assert.equal(t.strict, true, t.name);
    assert.equal(t.input_schema.additionalProperties, false, t.name);
  }
  // the history went as plain text turns, the last message is the new one
  const msgs = first.body.messages;
  assert.equal(msgs[0].role, 'user');
  assert.equal(msgs.at(-1).content[0].text, 'Which job should I apply for?');
  assert.ok(msgs.length <= 21, 'at most 20 turns of history');
  assert.ok(!JSON.stringify(first.body).includes('asha.ca@tl-sink.local'), 'no email in the request');

  // round 2: assistant tool_use turn echoed, then ONE user message with all four results
  const m2 = seenRound2.messages;
  assert.equal(m2.at(-2).role, 'assistant');
  const results = m2.at(-1).content;
  assert.equal(m2.at(-1).role, 'user');
  assert.equal(results.length, 4);
  assert.ok(results.every((x) => x.type === 'tool_result'));
  const byId = Object.fromEntries(results.map((x) => [x.tool_use_id, x]));
  const calls = m2.at(-2).content;
  const res = (name) => byId[calls.find((c) => c.name === name).id];
  assert.equal(res('get_job').is_error, true, 'a draft job is not readable by a candidate');
  assert.ok(!res('get_my_profile').is_error);
  const profile = JSON.parse(res('get_my_profile').content);
  assert.equal(profile.first_name, 'Asha');
  assert.ok(!('email' in profile) && !('phone' in profile));
  assert.ok(!res('get_my_profile').content.includes('Bala'), 'never another candidate');
  const search = JSON.parse(res('search_open_jobs').content);
  assert.deepEqual(search.jobs.map((j) => j.job_id), ['jca1']);
  const match = JSON.parse(res('match_me_to_job').content);
  assert.ok(match.score > 0 && match.matched_skills.length === 2);

  const stored = (await raw(`select engine, tools_used, input_tokens, output_tokens from career_assistant_messages
                              where conversation_id = $1 and role = 'assistant' order by id desc limit 1`, [convA])).rows[0];
  assert.equal(stored.engine, 'ai');
  assert.equal(stored.input_tokens, 240);
  assert.ok(!JSON.stringify(stored).includes('first_name'), 'raw tool payloads are not stored');
});

test('ai: the system prompt is byte-stable between requests', async () => {
  model.play(text('Sure.'));
  await send(A, { conversationId: convA, text: 'Thanks' });
  await send(B, { text: 'Hello' });
  assert.equal(model.requests.length, 2);
  const [x, y] = model.requests.map((q) => JSON.stringify(q.body.system) + JSON.stringify(q.body.tools));
  assert.equal(x, y, 'system + tools identical for two different candidates');
  const { CAREER_ASSISTANT_PROMPT } = await import('../src/ai/career-assistant-prompt.js');
  assert.equal(createHash('sha256').update(CAREER_ASSISTANT_PROMPT).digest('hex').slice(0, 16),
    '7911e33809ef422a', 'the Part B prompt changed - update this hash only on purpose');
});

test('ai: interview context from the prep kit reaches the model, but only the candidate\'s own interview', async () => {
  await raw(`insert into interviews (id, candidate_id, job_id, type, scheduled_date, scheduled_time, mode, status)
             values ('ivA', $1, 'jca1', 'Client Round', current_date + 3, '11:00 AM', 'Video Call', 'Scheduled'),
                    ('ivB', $2, 'jca1', 'HR Round', current_date + 3, '12:00 PM', 'Video Call', 'Scheduled')`, [A.id, B.id]);
  model.play(text('Let us practise.'));
  await send(A, { text: 'Help me prepare for my interview', context: { interviewId: 'ivA' } });
  const content = model.requests[0].body.messages.at(-1).content;
  assert.equal(content.length, 2);
  assert.match(content[1].text, /ivA/);
  assert.ok(!/client/i.test(content[1].text), 'the word Client is not passed on');

  model.play(text('ok'));
  await send(A, { text: 'Help me prepare', context: { interviewId: 'ivB' } });
  assert.equal(model.requests[0].body.messages.at(-1).content.length, 1, 'B\'s interview is ignored');
});

test('ai: a refusal is answered politely, from stop_reason, not from content', async () => {
  model.play(msg([], 'refusal'));
  const r = await send(A, { text: 'something the model declines' });
  assert.equal(r.status, 200);
  assert.equal(r.body.engine, 'ai');
  assert.match(r.body.reply, /can't help with that/);
});

test('ai: a timeout or an upstream error says "unavailable" and stores nothing', async () => {
  const before = (await raw(`select count(*)::int n from career_assistant_messages`)).rows[0].n;
  model.play({ delayMs: 3000, body: text('too late') });
  let r = await send(A, { text: 'Are you there?' });
  assert.equal(r.status, 503);
  assert.equal(r.body.error.code, 'ASSISTANT_UNAVAILABLE');
  assert.equal(r.body.error.message, 'Assistant is unavailable right now, please try again.');

  model.play({ status: 500, body: { type: 'error', error: { type: 'api_error', message: 'boom' } } });
  r = await send(A, { text: 'Are you there now?' });
  assert.equal(r.status, 503);
  model.play({ status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'bad key' } } });
  r = await send(A, { text: 'And now?' });
  assert.equal(r.status, 503);
  assert.ok(!JSON.stringify(r.body).includes('test-key'), 'the key never appears in a response');
  assert.equal((await raw(`select count(*)::int n from career_assistant_messages`)).rows[0].n, before);
});

test('ai: a model that keeps calling tools is stopped after 5 rounds and made to answer', async () => {
  model.play((body) => (body.tool_choice && body.tool_choice.type === 'none'
    ? text('Here is what I found so far.')
    : toolUse([['get_my_applications', {}]])));
  const r = await send(A, { text: 'Status of my applications?' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(model.requests.length, 6);
  assert.deepEqual(model.requests[5].body.tool_choice, { type: 'none' });
  assert.equal(r.body.reply, 'Here is what I found so far.');
});

test('30 messages an hour: the 31st is a clear 429, and Clear chat does not reset it', async () => {
  config.aiApiKey = '';
  const C = await candidate('Chitra Devi', 'chitra.ca@tl-sink.local');
  let conv;
  for (let i = 0; i < 30; i += 1) {
    const r = await send(C, { conversationId: conv, text: `question ${i}` });
    assert.equal(r.status, 200, `message ${i}: ${JSON.stringify(r.body)}`);
    conv = r.body.conversationId;
  }
  const del = await C.del(`/api/career-assistant/conversations/${conv}`);
  assert.equal(del.status, 200);
  assert.equal((await C.get(`/api/career-assistant/conversations/${conv}`)).status, 404, 'cleared');
  const r = await send(C, { text: 'one more' });
  assert.equal(r.status, 429);
  assert.equal(r.body.error.code, 'ASSISTANT_RATE_LIMITED');
  assert.match(r.body.error.message, /30 messages .* last hour/);
  assert.ok(Number(r.headers.get('retry-after')) > 0);
  assert.equal((await send(A, { text: 'hi' })).status, 200, 'another candidate is not affected');
});

test('shutdown', async () => {
  const { closePool } = await import('../src/db.js');
  await new Promise((r) => server.close(r));
  await closePool();
  await model.stop();
  await dbh.stop();
});
