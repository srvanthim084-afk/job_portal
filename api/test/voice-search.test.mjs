/**
 * Voice search: POST /api/search/voice-parse.
 *
 * The rules engine against the cases the brief lists, the limits, and the
 * AI engine against a LOCAL mock of the Messages API (never the real one),
 * including a timeout that must fall back to the rules.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestDb, applyTestEnv, makeClient } from './harness.mjs';

const DB_PORT = 5476;
const API_PORT = 9991;
const AI_PORT = 9973;
const HERE = dirname(fileURLToPath(import.meta.url));
const TREE = process.env.PLACE_TREE_FILE || resolve(HERE, '../../var/places/india-tree.tsv');
const HAVE_TREE = existsSync(TREE);

let dbh, server, base, client, config, aiServer;
const ai = { mode: 'ok', reply: null, requests: [] };

function startAiMock() {
  return new Promise((done) => {
    aiServer = createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        let parsed = null; try { parsed = JSON.parse(body); } catch { /* */ }
        ai.requests.push({ url: req.url, headers: req.headers, body: parsed });
        if (ai.mode === 'hang') return;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'msg_mock', type: 'message', role: 'assistant', model: 'claude-opus-5-5',
          content: [{ type: 'text', text: JSON.stringify(ai.reply) }],
          stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 5, output_tokens: 5 },
        }));
      });
    });
    aiServer.listen(AI_PORT, '127.0.0.1', done);
  });
}

const parse = (text, lang = 'en-IN') => client.post('/api/search/voice-parse', { text, lang });
const ALLOWED = {
  mode: ['Onsite', 'Remote', 'Hybrid'],
  jobType: ['Full-time', 'Part-time', 'Contract', 'Internship', 'Walk-in'],
  exp: ['', '0–1 yrs', '1–3 yrs', '2–4 yrs', '3–5 yrs', '3–6 yrs', '5–8 yrs'],
  salaryMin: ['', '3', '5', '8', '12', '18', '25'],
  posted: ['', '1', '3', '7', '15', '30'],
};
function onlyAllowed(f) {
  assert.deepEqual(Object.keys(f).sort(), ['education', 'exp', 'jobType', 'loc', 'mode', 'posted', 'q', 'salaryMin', 'skills', 'sort']);
  f.mode.forEach((m) => assert.ok(ALLOWED.mode.includes(m), m));
  f.jobType.forEach((t) => assert.ok(ALLOWED.jobType.includes(t), t));
  assert.ok(ALLOWED.exp.includes(f.exp), f.exp);
  assert.ok(ALLOWED.salaryMin.includes(f.salaryMin), f.salaryMin);
  assert.ok(ALLOWED.posted.includes(f.posted), f.posted);
}

test('boot', async () => {
  dbh = await startTestDb(DB_PORT);
  await startAiMock();
  applyTestEnv(dbh.url, {
    PUBLIC_ORIGIN: `http://127.0.0.1:${API_PORT}`,
    DISABLE_BACKGROUND_WORK: 'true',
    AI_API_KEY: '',
    AI_API_BASE_URL: `http://127.0.0.1:${AI_PORT}`,
    AI_VOICE_TIMEOUT_MS: '1000',
    PLACE_TREE_FILE: HAVE_TREE ? TREE : resolve(HERE, 'no-such-place-index.tsv'),
    VOICE_RATE_LIMIT_MAX: '40',     // 20 in production; room here for the cases above
  });
  const raw = (sql, params) => dbh.db.query(sql, params);
  await raw(`insert into companies (id, name) values ('co_vs', 'Voice Test Co')`);
  for (const [id, title, loc, mode, type] of [
    ['jvs1', 'Driver', 'Nellore', 'Onsite', 'Full-time'],
    ['jvs2', 'Telecaller', 'Hyderabad', 'Remote', 'Full-time'],
    ['jvs3', 'Data Entry Operator', 'Guntur', 'Onsite', 'Part-time'],
  ]) {
    await raw(`insert into jobs (id, title, company_id, location, mode, employment_type, status, skills, published_at)
               values ($1,$2,'co_vs',$3,$4,$5,'open','{}',now())`, [id, title, loc, mode, type]);
  }
  const { createApp } = await import('../src/app.js');
  ({ config } = await import('../src/config.js'));
  const app = createApp({ logger: { error() {}, log() {} } });
  await new Promise((r) => { server = app.listen(API_PORT, r); });
  base = `http://127.0.0.1:${API_PORT}`;
  client = makeClient(base);
});

test('rules: "Nellore lo driver job kavali" -> driver in Nellore', async () => {
  const r = await parse('Nellore lo driver job kavali', 'te-IN');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.engine, 'rules');
  assert.equal(r.body.filters.q, 'driver');
  assert.equal(r.body.filters.loc, 'Nellore');
  assert.deepEqual(r.body.understood, ['Driver', 'Nellore']);
  onlyAllowed(r.body.filters);
});

test('rules: "Hyderabad mein work from home telecaller" -> telecaller, Hyderabad, work from home', async () => {
  const r = await parse('Hyderabad mein work from home telecaller', 'hi-IN');
  assert.equal(r.body.filters.q, 'telecaller');
  assert.equal(r.body.filters.loc, 'Hyderabad');
  assert.deepEqual(r.body.filters.mode, ['Remote']);
  assert.deepEqual(r.body.portal.modes, ['Remote']);
  assert.ok(r.body.understood.includes('Work from home'));
  onlyAllowed(r.body.filters);
});

test('rules: "fresher data entry jobs near Guntur" -> data entry, Guntur, fresher', async () => {
  const r = await parse('fresher data entry jobs near Guntur');
  assert.equal(r.body.filters.q, 'data entry');
  assert.equal(r.body.filters.loc, 'Guntur');
  assert.equal(r.body.filters.exp, '0–1 yrs');
  assert.deepEqual(r.body.portal.exp, ['Fresher']);
  assert.ok(r.body.understood.includes('Fresher'));
  onlyAllowed(r.body.filters);
});

test('rules: "salary 15 thousand paina delivery boy" -> delivery boy, ₹15,000 a month', async () => {
  const r = await parse('salary 15 thousand paina delivery boy');
  assert.equal(r.body.filters.q, 'delivery boy');
  assert.ok(r.body.understood.includes('₹15,000+ a month'), r.body.understood.join('|'));
  // ₹15,000 a month = ₹1.8 LPA: the candidate screen takes it as is; the
  // public sidebar's lowest option is ₹3 LPA, so it is not invented there.
  assert.equal(r.body.portal.ctcMin, '1.8');
  assert.equal(r.body.filters.salaryMin, '');
  assert.ok(r.body.notes.length === 1);
  onlyAllowed(r.body.filters);
  // Same amount in Telugu and Hindi number words.
  for (const t of ['padihenu velu jeetham paina driver', 'pandrah hazaar se upar driver', 'fifteen thousand salary driver', '15k salary driver']) {
    const x = await parse(t);
    assert.equal(x.body.portal.ctcMin, '1.8', t);
    assert.equal(x.body.filters.q, 'driver', t);
  }
  // A monthly amount at or above an option maps to it.
  const y = await parse('telecaller 45000 salary');
  assert.equal(y.body.filters.salaryMin, '5');
  assert.equal(y.body.portal.ctcMin, '5.4');
});

test('empty, too long, or only filler words: 400 or empty filters, never a crash', async () => {
  assert.equal((await parse('')).status, 400);
  assert.equal((await parse('   ')).status, 400);
  assert.equal((await parse('x'.repeat(500))).status, 400);
  assert.equal((await client.post('/api/search/voice-parse', { text: 42 })).status, 400);
  assert.equal((await client.post('/api/search/voice-parse', { text: 'driver', lang: 'fr-FR' })).status, 400);
  const r = await parse('kavali job lo please chahiye');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.understood, []);
  assert.equal(r.body.filters.q, '');
  assert.equal(r.body.filters.loc, '');
  onlyAllowed(r.body.filters);
});

test('a place that is not on the board or in the index is not invented', async () => {
  const r = await parse('driver job in Qwertyville');
  assert.equal(r.body.filters.loc, '');
  assert.equal(r.body.filters.q, 'driver');
});

test('places come from the place index too (when it is installed)', { skip: !HAVE_TREE && 'place index not installed' }, async () => {
  // The route never waits for the index to load; it is warmed at start.
  const { treeWarm } = await import('../src/place-tree.js');
  await treeWarm();
  const r = await parse('Vijayawada lo nurse job kavali');
  assert.equal(r.body.filters.q, 'nurse');
  assert.match(r.body.filters.loc, /^Vijayawada$/i);
});

test('AI engine (mock): structured output, validated, place resolved, engine "ai"', async () => {
  config.aiApiKey = 'test-key-for-mock';
  ai.mode = 'ok'; ai.requests.length = 0;
  ai.reply = { title: 'driver', place: 'Nellore', salaryAmount: 30000, salaryPeriod: 'month', fresher: false,
    years: -1, workMode: '', jobType: 'Gig', posted: '' };
  const r = await parse('నెల్లూరు లో డ్రైవర్ జాబ్ కావాలి జీతం ముప్పై వేలు', 'te-IN');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.engine, 'ai');
  assert.equal(r.body.filters.q, 'driver');
  assert.equal(r.body.filters.loc, 'Nellore');
  assert.equal(r.body.filters.salaryMin, '3', '₹30,000 a month = 3.6 LPA -> the ₹3 LPA option');
  assert.deepEqual(r.body.filters.jobType, [], 'an invented job type is dropped');
  onlyAllowed(r.body.filters);
  const q = ai.requests[0];
  assert.match(q.url, /\/v1\/messages/);
  assert.match(String(q.headers['anthropic-beta']), /server-side-fallback-2026-07-01/);
  assert.equal(q.body.fallbacks, 'default');
  assert.equal(q.body.output_config.effort, 'low');
  assert.equal(q.body.output_config.format.type, 'json_schema');
  assert.equal(q.body.system[0].cache_control.type, 'ephemeral');
  assert.match(JSON.stringify(q.body.messages), /<spoken>/);
  assert.equal(q.body.thinking, undefined);

  ai.reply = { title: 'cook', place: 'Atlantis', salaryAmount: 0, salaryPeriod: '', fresher: true, years: -1, workMode: 'Remote', jobType: '', posted: '1' };
  const x = await parse('Atlantis lo cook');
  assert.equal(x.body.filters.loc, '', 'a place the index does not know is dropped');
  assert.equal(x.body.filters.exp, '0–1 yrs');
  assert.deepEqual(x.body.filters.mode, ['Remote']);
  assert.equal(x.body.filters.posted, '1');
});

test('AI timeout falls back to the rules engine and says so', async () => {
  ai.mode = 'hang';
  const t0 = Date.now();
  const r = await parse('Nellore lo driver job kavali');
  assert.equal(r.status, 200);
  assert.equal(r.body.engine, 'rules');
  assert.equal(r.body.filters.q, 'driver');
  assert.equal(r.body.filters.loc, 'Nellore');
  assert.ok(Date.now() - t0 < 4000, 'did not wait long');
  ai.mode = 'ok';
  config.aiApiKey = '';
});

test('rate limited per address (20 a minute in production)', async () => {
  let limited = 0;
  for (let i = 0; i < 45; i += 1) {
    const r = await parse('driver');
    if (r.status === 429) limited += 1;
  }
  assert.ok(limited > 0, 'the limit was reached');
});

test('shutdown', async () => {
  await new Promise((r) => server.close(r));
  const { closePool } = await import('../src/db.js');
  await closePool();
  await new Promise((r) => { aiServer.closeAllConnections?.(); aiServer.close(r); });
  await dbh.stop();
});
