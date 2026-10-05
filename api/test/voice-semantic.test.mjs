/**
 * Voice search by MEANING: a Telugu / mixed / English spoken query becomes
 * a normalized search object, and the open jobs are ranked by relevance
 * with progressive relaxation - never searched as the Telugu text.
 *
 * The owner's ten acceptance tests (T1-T10), against seeded jobs: one
 * whose skill appears only in its description, Hyderabad-area jobs,
 * Java / Python / AI / React jobs, and a query nothing matches. Plus the
 * search object's shape, the AI engine's output going through the same
 * concepts, saved voice searches (stored criteria, matched by meaning),
 * and the typed search / saved-search rules unchanged.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestDb, applyTestEnv, makeClient } from './harness.mjs';
import { detectLanguage, extractConcepts, rankJobs, cleanSearch, voiceMatches } from '../src/search/voice-semantic.js';
import { normalizeFilters, jobMatchesFilters } from '../src/search/saved-match.js';

const DB_PORT = 5468;
const API_PORT = 9988;
const AI_PORT = 9975;
const HERE = dirname(fileURLToPath(import.meta.url));
const TREE = process.env.PLACE_TREE_FILE || resolve(HERE, '../../var/places/india-tree.tsv');
const HAVE_TREE = existsSync(TREE);

let dbh, server, client, config, aiServer;
const ai = { reply: null };
const NATIVE = /[\u0900-\u097f\u0c00-\u0c7f]/;

const say = (text, lang = 'te-IN', c = client) => c.post('/api/search/voice-parse', { text, lang });
const ids = (r) => r.body.semantic.results.map((x) => x.jobId);

const JOBS = [
  // id, title, location, mode, skills, description
  ['vs_py', 'Python Developer', 'Hyderabad', 'Onsite', ['Python', 'Django', 'REST APIs'], 'Build web services.'],
  ['vs_be', 'Backend Engineer', 'Hyderabad', 'Onsite', ['APIs', 'PostgreSQL'], 'We build our services in Python with FastAPI and Celery.'],
  ['vs_jv', 'Java Developer', 'Hyderabad', 'Onsite', ['Java', 'Spring Boot', 'Hibernate'], 'Enterprise applications.'],
  ['vs_jvb', 'Java Developer', 'Bengaluru', 'Onsite', ['Java', 'Microservices'], 'Payments platform.'],
  ['vs_ml', 'Machine Learning Engineer', 'Hyderabad', 'Onsite', ['PyTorch', 'NLP'], 'Train and ship models.'],
  ['vs_gen', 'GenAI Specialist', 'Pune', 'Hybrid', ['Prompting'], 'Build LLM applications for customers.'],
  ['vs_fe', 'Frontend Developer', 'Remote', 'Remote', ['React', 'CSS'], 'Our product UI.'],
  ['vs_tc', 'Technology Consultant', 'Hyderabad', 'Onsite', ['SAP', 'Client handling'], 'Advise customers on IT systems.'],
  ['vs_and', 'Android Developer', 'Pune', 'Onsite', ['Kotlin'], 'Build our mobile app for shops.'],
  ['vs_dr', 'Driver', 'Nellore', 'Onsite', ['Driving licence'], 'Drive the company car.'],
  ['vs_acc', 'Accounts Assistant', 'Hyderabad', 'Onsite', ['Tally', 'GST'], 'Billing and ledgers.'],
  ['vs_sec', 'Data Analyst', 'Secunderabad', 'Onsite', ['SQL', 'Excel'], 'Reports for the sales team.'],
];

function startAiMock() {
  return new Promise((done) => {
    aiServer = createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
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

test('boot', async () => {
  dbh = await startTestDb(DB_PORT);
  await startAiMock();
  applyTestEnv(dbh.url, {
    PUBLIC_ORIGIN: `http://127.0.0.1:${API_PORT}`,
    DISABLE_BACKGROUND_WORK: 'true',
    AI_API_KEY: '',
    AI_API_BASE_URL: `http://127.0.0.1:${AI_PORT}`,
    PLACE_TREE_FILE: HAVE_TREE ? TREE : resolve(HERE, 'no-such-place-index.tsv'),
    VOICE_RATE_LIMIT_MAX: '500',
  });
  const raw = (sql, params) => dbh.db.query(sql, params);
  await raw(`insert into companies (id, name, industry) values ('co_sem', 'Semantic Test Co', 'Recruitment')`);
  for (const [id, title, loc, mode, skills, desc] of JOBS) {
    await raw(`insert into jobs (id, title, company_id, location, mode, employment_type, status, skills, description, exp_label, published_at)
               values ($1,$2,'co_sem',$3,$4,'Full-time','open',$5,$6,'1-3 yrs',now())`, [id, title, loc, mode, skills, desc]);
  }
  const { createApp } = await import('../src/app.js');
  ({ config } = await import('../src/config.js'));
  const app = createApp({ logger: { error() {}, log() {} } });
  await new Promise((r) => { server = app.listen(API_PORT, r); });
  client = makeClient(`http://127.0.0.1:${API_PORT}`);
});

/* ------------------------------------------------------------------ *
 * the ten acceptance tests
 * ------------------------------------------------------------------ */

test('T1 "నాకు హైదరాబాద్‌లో Python jobs కావాలి" -> Python jobs in Hyderabad (one only says Python in its description)', async () => {
  const r = await say('నాకు హైదరాబాద్‌లో Python jobs కావాలి');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.search.language, 'MIXED');
  assert.deepEqual(r.body.search.technologies, ['Python']);
  assert.deepEqual(r.body.search.location, ['Hyderabad']);
  assert.equal(r.body.filters.q, 'python');
  assert.equal(r.body.semantic.level, 1);
  const got = ids(r);
  assert.equal(got[0], 'vs_py', 'the Python Developer title ranks first');
  assert.ok(got.includes('vs_be'), 'the Backend Engineer whose description says Python is found');
  assert.ok(!got.includes('vs_gen') && !got.includes('vs_jvb') && !got.includes('vs_dr'), got.join(','));
  const top = r.body.semantic.results[0];
  assert.ok(top.score >= 90 && top.label === 'Excellent', JSON.stringify(top));
});

test('T2 "నాకు AI related jobs కావాలి" -> AI / ML / GenAI / LLM / NLP jobs by relevance', async () => {
  const r = await say('నాకు AI related jobs కావాలి');
  assert.deepEqual(r.body.search.technologies, ['AI']);
  const got = ids(r);
  assert.ok(got.includes('vs_ml') && got.includes('vs_gen'), got.join(','));
  assert.ok(!got.includes('vs_dr') && !got.includes('vs_acc') && !got.includes('vs_jv'), got.join(','));
  const scores = r.body.semantic.results.map((x) => x.score);
  assert.deepEqual(scores, scores.slice().sort((a, b) => b - a), 'sorted by relevance');
});

test('T3 "నాకు Java developer jobs Hyderabad లో కావాలి" -> Java Developer jobs in Hyderabad', async () => {
  const r = await say('నాకు Java developer jobs Hyderabad లో కావాలి');
  assert.deepEqual(r.body.search.technologies, ['Java']);
  assert.deepEqual(r.body.search.role, ['Developer']);
  assert.equal(r.body.filters.q, 'java developer');
  assert.equal(r.body.semantic.level, 1);
  const got = ids(r);
  assert.equal(got[0], 'vs_jv');
  assert.ok(!got.includes('vs_jvb'), 'the Bengaluru Java job is not in the Hyderabad results');
});

test('T4 a Telugu-only sentence (consultant / technology / currently in Hyderabad) is understood and jobs are shown', async () => {
  const text = 'కన్సల్టెంట్ టెక్నాలజీకి సంబంధించిన ఉద్యోగాలు కావాలి, ప్రస్తుతం హైదరాబాద్‌లో ఉన్నాను';
  const r = await say(text);
  const s = r.body.search;
  assert.equal(s.language, 'TELUGU');
  assert.equal(s.originalQuery, text, 'the words said are kept');
  assert.deepEqual(s.role, ['Consultant']);
  assert.deepEqual(s.industry, ['Technology']);
  assert.deepEqual(s.location, ['Hyderabad']);
  assert.equal(s.intent, 'job_search');
  assert.equal(s.searchMode, 'semantic');
  assert.equal(s.normalizedQuery, 'technology consultant jobs in Hyderabad');
  assert.ok(!NATIVE.test(r.body.filters.q) && !NATIVE.test(r.body.portal.q), 'the search key is never Telugu');
  assert.ok(r.body.understood.every((u) => !NATIVE.test(u)), r.body.understood.join('|'));
  assert.equal(ids(r)[0], 'vs_tc');
  for (const k of ['originalQuery', 'language', 'intent', 'normalizedQuery', 'role', 'skills', 'technologies', 'location',
    'experience', 'qualification', 'salary', 'jobType', 'industry', 'noticePeriod', 'synonyms', 'semanticTerms', 'searchMode']) {
    assert.ok(k in s, `search.${k}`);
  }
});

test('T5 mixed speech -> English keywords extracted', async () => {
  const cases = [
    ['నాకు Python developer jobs కావాలి Hyderabad లో', { technologies: ['Python'], role: ['Developer'], location: ['Hyderabad'] }],
    ['Hyderabad lo software jobs kavali', { industry: ['Software'], location: ['Hyderabad'] }],
    ['నాకు remote frontend jobs కావాలి', { technologies: ['Frontend'], jobType: ['Remote'] }],
    ['Java jobs kavali', { technologies: ['Java'] }],
    ['AI related jobs Hyderabad lo unnaya?', { technologies: ['AI'], location: ['Hyderabad'] }],
    ['सॉफ्टवेयर डेवलपर की नौकरी चाहिए', { industry: ['Software'], role: ['Developer'] }],
  ];
  for (const [text, want] of cases) {
    // eslint-disable-next-line no-await-in-loop
    const r = await say(text);
    for (const [k, v] of Object.entries(want)) assert.deepEqual(r.body.search[k], v, `${text}: ${k}`);
    assert.ok(!NATIVE.test(r.body.search.normalizedQuery), r.body.search.normalizedQuery);
    assert.ok(['MIXED', 'HINDI', 'ENGLISH'].includes(r.body.search.language), r.body.search.language);
    assert.ok(r.body.semantic.total > 0, `${text}: jobs shown`);
  }
  const fe = await say('నాకు remote frontend jobs కావాలి');
  assert.ok(ids(fe).includes('vs_fe'));
  assert.deepEqual(fe.body.filters.mode, ['Remote']);
});

test('T6 a skill alone -> jobs with it in the title, the skills OR the description', async () => {
  const r = await say('పైథాన్ జాబ్స్ కావాలి');                    // "Python jobs", Python in Telugu script
  assert.deepEqual(r.body.search.technologies, ['Python']);
  const got = ids(r);
  assert.ok(got.includes('vs_py'), 'title / skills');
  assert.ok(got.includes('vs_be'), 'description only');
  const be = r.body.semantic.results.find((x) => x.jobId === 'vs_be');
  assert.ok(be.parts.description > 0 && be.parts.title === 0 && be.parts.skills === 0, JSON.stringify(be.parts));
});

test('T7 a place alone -> the jobs in that place', async () => {
  const r = await say('హైదరాబాదులో జాబ్స్');
  assert.deepEqual(r.body.search.location, ['Hyderabad']);
  assert.equal(r.body.search.normalizedQuery, 'jobs in Hyderabad');
  const got = ids(r);
  for (const id of ['vs_py', 'vs_be', 'vs_jv', 'vs_ml', 'vs_tc', 'vs_acc']) assert.ok(got.includes(id), id);
  assert.ok(!got.includes('vs_dr') && !got.includes('vs_jvb') && !got.includes('vs_gen'), got.join(','));
});

test('T8 a concept that is not a job title ("technology") -> semantically related jobs', async () => {
  const r = await say('నాకు టెక్నాలజీ ఉద్యోగాలు కావాలి');
  assert.deepEqual(r.body.search.industry, ['Technology']);
  const got = ids(r);
  assert.ok(got.includes('vs_tc') && got.includes('vs_py') && got.includes('vs_jv'), got.join(','));
  assert.ok(!got.includes('vs_dr') && !got.includes('vs_acc'), got.join(','));
});

test('T9 no exact match but related jobs exist -> the related jobs, not "No jobs"', async () => {
  const r = await say('నాకు Flutter jobs Pune లో కావాలి');
  assert.deepEqual(r.body.search.technologies, ['Flutter']);
  assert.equal(r.body.semantic.empty, false);
  assert.ok(r.body.semantic.level >= 2, 'relaxed');
  assert.ok(ids(r).includes('vs_and'), 'the Android mobile-app job');
  assert.match(r.body.semantic.message, /^\d+ related jobs? found\. Showing the closest matches\.$/);
  // role + place with nothing at that place: the role elsewhere, said so
  const j = await say('Java developer jobs Nellore lo');
  assert.ok(j.body.semantic.level > 1 && !j.body.semantic.empty);
  assert.ok(ids(j).includes('vs_jv') && ids(j).includes('vs_jvb'));
  assert.equal(j.body.semantic.message, 'No Java Developer jobs found in Nellore. Showing Java Developer jobs in other locations.');
  assert.ok(!ids(j).includes('vs_dr'), 'never a random job in Nellore');
});

test('T10 nothing relevant anywhere -> "No matching ... jobs found" from the normalized intent', async () => {
  const r = await say('నెల్లూరు లో వెల్డర్ ఉద్యోగాలు కావాలి');      // welder, Nellore - no welder job anywhere
  assert.equal(r.body.semantic.empty, true);
  assert.equal(r.body.semantic.total, 0);
  assert.equal(r.body.semantic.message, 'No matching Welder jobs found in Nellore.');
  assert.ok(!NATIVE.test(r.body.semantic.message));
  const p = await say('pilot jobs in Hyderabad');
  assert.equal(p.body.semantic.message, 'No matching Pilot jobs found in Hyderabad.');
});

/* ------------------------------------------------------------------ *
 * the master task's additions
 * ------------------------------------------------------------------ */

test('master: romanised Telugu, "Hyd" / "Hyderbad", software in Telugu, remote from the real mode data', async () => {
  const cases = [
    ['Naaku Hyderabad lo Python jobs kavali', { technologies: ['Python'], location: ['Hyderabad'] }, 'vs_py'],
    ['Naaku Hyderabad lo Java developer jobs kavali', { technologies: ['Java'], role: ['Developer'], location: ['Hyderabad'] }, 'vs_jv'],
    ['Hyd lo Java developer jobs kavali', { technologies: ['Java'], location: ['Hyderabad'] }, 'vs_jv'],
    ['Hyderbad lo python jobs', { technologies: ['Python'], location: ['Hyderabad'] }, 'vs_py'],
    ['నాకు హైదరాబాద్‌లో సాఫ్ట్‌వేర్ ఉద్యోగాలు కావాలి', { industry: ['Software'], location: ['Hyderabad'] }, null],
    ['హైదరాబాద్‌లో jobs కావాలి', { location: ['Hyderabad'], role: [], technologies: [] }, null],
    ['Python jobs', { technologies: ['Python'], location: [] }, 'vs_py'],
  ];
  for (const [text, want, top] of cases) {
    // eslint-disable-next-line no-await-in-loop
    const r = await say(text);
    for (const [k, v] of Object.entries(want)) assert.deepEqual(r.body.search[k], v, `${text}: ${k}`);
    if (top) assert.equal(ids(r)[0], top, text);
    assert.ok(r.body.semantic.total > 0, `${text}: jobs`);
  }
  assert.equal((await say('Naaku Hyderabad lo Python jobs kavali')).body.search.language, 'MIXED');
  /* remote: only jobs whose own mode says so */
  const rm = await say('నాకు remote frontend jobs కావాలి');
  assert.equal(rm.body.search.remote, true);
  assert.deepEqual(ids(rm), ['vs_fe']);
  /* nothing to rank by (only "remote"): the screen's own filters do it, no empty search */
  const only = await say('remote jobs kavali');
  assert.equal(only.body.semantic.passthrough, true);
  assert.deepEqual(only.body.filters.mode, ['Remote']);
});

test('master: the cleanup keeps Telugu / Devanagari intact (vowel signs, virama, ZWNJ)', async () => {
  const { intentToResult } = await import('../src/search/voice-parse.js');
  for (const w of ['హైదరాబాద్‌లో', 'నాకు', 'सॉफ्टवेयर', 'విశాఖపట్నం']) {
    // eslint-disable-next-line no-await-in-loop
    const out = await intentToResult({ query: w, titles: [] }, {});
    assert.equal(out.filters.q, w.normalize('NFC'), w);
  }
  /* and the whole route never hands back broken Telugu: chips and the search object are English, the original is exact */
  const text = 'నాకు హైదరాబాద్‌లో Python jobs కావాలి';
  const r = await say(text);
  assert.equal(r.body.search.originalQuery, text.normalize('NFC'));
  assert.ok(r.body.understood.every((u) => !NATIVE.test(u)));
});

/* ------------------------------------------------------------------ *
 * around the ten
 * ------------------------------------------------------------------ */

test('Hyderabad covers its area (Secunderabad) where the place index knows it', { skip: !HAVE_TREE && 'place index not installed' }, async () => {
  const { treeWarm } = await import('../src/place-tree.js');
  await treeWarm();
  const r = await say('నాకు హైదరాబాద్‌లో SQL jobs కావాలి');
  assert.ok(ids(r).includes('vs_sec'), JSON.stringify(r.body.semantic).slice(0, 300));
});

test('POST /search/semantic re-ranks a search object; native script never becomes a keyword', async () => {
  const r = await client.post('/api/search/semantic', { search: { concepts: ['python', 'nope'], keywords: ['నెల్లూరు', 'django'], location: ['Hyderabad'], language: 'MIXED' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.search.concepts, ['python'], 'an unknown concept is dropped');
  assert.deepEqual(r.body.search.keywords, ['django']);
  assert.ok(ids(r).includes('vs_py'));
  assert.equal((await client.post('/api/search/semantic', {})).status, 400);
});

test('the AI engine (mock) gives the same search shape through the same concepts', async () => {
  config.aiApiKey = 'test-key-for-mock';
  ai.reply = { title: 'python developer', skills: ['django'], place: 'Hyderabad', salaryAmount: 0, salaryPeriod: '', fresher: false,
    years: -1, workMode: '', jobType: '', posted: '' };
  try {
    const r = await say('నాకు హైదరాబాద్‌లో పైథాన్ డెవలపర్ ఉద్యోగాలు కావాలి');
    assert.equal(r.body.engine, 'ai');
    assert.deepEqual(r.body.search.technologies, ['Python']);
    assert.deepEqual(r.body.search.role, ['Developer']);
    assert.deepEqual(r.body.search.location, ['Hyderabad']);
    assert.equal(ids(r)[0], 'vs_py');
  } finally { config.aiApiKey = ''; }
});

test('a signed-in candidate\'s profile is one input to relevance', async () => {
  const c = makeClient(`http://127.0.0.1:${API_PORT}`);
  await c.get('/api/health');
  const reg = await c.post('/api/auth/register', { name: 'Semantic Seeker', email: 'semantic.seeker@tl-test.local',
    password: 'Semantic123x', phone: '9876501234', preferredLocation: 'Hyderabad', expectedCtc: 4, noticePeriod: 'Immediate',
    preferredWorkModes: ['Work From Office'] });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  await c.put(`/api/candidates/${reg.body.candidateId}`, { skills: ['Java', 'Spring Boot', 'Hibernate'], location: 'Hyderabad' });
  const r = await say('Java jobs kavali', 'en-IN', c);
  const jv = r.body.semantic.results.find((x) => x.jobId === 'vs_jv');
  assert.ok(jv && jv.parts.profile != null, JSON.stringify(jv));
  c.candidateId = reg.body.candidateId;
  client.cand = c;
});

test('saving a voice search stores the normalized criteria; alerts match by meaning', async () => {
  const c = client.cand;
  const r = await say('నాకు హైదరాబాద్‌లో Python jobs కావాలి', 'te-IN', c);
  const s = r.body.search;
  const made = await c.post('/api/saved-searches', { filters: { q: 'python', locTags: ['Hyderabad'], voice: s }, alert_frequency: 'daily' });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const v = made.body.savedSearch.filters.voice;
  assert.equal(v.language, 'MIXED');
  assert.equal(v.originalQuery, 'నాకు హైదరాబాద్‌లో Python jobs కావాలి');
  assert.equal(v.normalizedQuery, 'python jobs in Hyderabad');
  assert.deepEqual(v.concepts, ['python']);
  assert.deepEqual(v.technologies, ['Python']);
  assert.deepEqual(v.location, ['Hyderabad']);
  /* the alert rule: the description-only Python job matches the saved voice search, the Java one does not */
  const f = made.body.savedSearch.filters;
  const be = { title: 'Backend Engineer', skills: ['APIs'], desc: 'We build our services in Python with FastAPI.', location: 'Hyderabad', mode: 'Onsite' };
  const jv = { title: 'Java Developer', skills: ['Java'], desc: '', location: 'Hyderabad', mode: 'Onsite' };
  assert.equal(jobMatchesFilters(be, f), true);
  assert.equal(jobMatchesFilters(jv, f), false);
  /* the same q without the voice criteria is the typed rule, unchanged: a substring of title / skills / company */
  const typed = normalizeFilters({ q: 'python', locTags: ['Hyderabad'] }).filters;
  assert.equal(jobMatchesFilters(be, typed), false);
  assert.equal(jobMatchesFilters({ ...be, skills: ['Python'] }, typed), true);
});

test('units: language, concepts, relaxation order, saved-voice matching', () => {
  assert.equal(detectLanguage('నాకు జాబ్ కావాలి'), 'TELUGU');
  assert.equal(detectLanguage('मुझे नौकरी चाहिए'), 'HINDI');
  assert.equal(detectLanguage('python jobs'), 'ENGLISH');
  assert.equal(detectLanguage('Java jobs kavali'), 'MIXED');
  assert.equal(detectLanguage('నాకు Python jobs'), 'MIXED');
  assert.equal(detectLanguage('12345'), 'OTHER');
  const e = extractConcepts(['కన్సల్టెంట్', 'టెక్నాలజీకి', 'సంబంధించిన', 'ఉన్నాను', 'జావా', 'డెవలపర్', 'సాఫ్ట్\u200cవేర్']);
  assert.deepEqual(e.ids.sort(), ['consultant', 'developer', 'java', 'software', 'technology']);
  assert.deepEqual(e.rest, []);
  const s = cleanSearch({ concepts: ['react'], location: ['Pune'] });
  const out = rankJobs(s, [
    { id: 'a', title: 'React Developer', skills: ['React'], location: 'Hyderabad' },
    { id: 'b', title: 'Driver', skills: [], location: 'Pune' },
  ], { tier: (loc, _m, tags) => (tags.includes(loc) ? 'exact' : 'other') });
  assert.equal(out.level, 4, 'skill+role without the place');
  assert.deepEqual(out.results.map((x) => x.jobId), ['a']);
  assert.equal(voiceMatches({ title: 'x', skills: [], desc: 'uses ReactJS daily' }, { concepts: ['react'] }), true);
  assert.equal(voiceMatches({ title: 'x', skills: [], desc: 'no' }, { concepts: ['react'] }), false);
});

test('loanwords with the "yoo" glide: న్యూరాలజిస్ట్ = neurologist, కంప్యూటర్ = computer (from the board); ordinary words stay out', async () => {
  const { boardWordIndex } = await import('../src/search/voice-semantic.js');
  const board = boardWordIndex([{ title: 'Neurologist', skills: ['Neurology'] }, { title: 'Computer Operator', skills: ['MS Office'] }]);
  assert.deepEqual(extractConcepts(['న్యూరాలజిస్ట్'], { boardWords: board }).keywords, ['neurologist']);
  assert.deepEqual(extractConcepts(['कंप्यूटर'], { boardWords: board }).keywords, ['computer']);
  assert.deepEqual(extractConcepts(['కంప్యూటర్'], { boardWords: board }).keywords, ['computer']);
  const news = extractConcepts(['న్యూస్'], { boardWords: board });
  assert.equal(news.keywords.length + news.ids.length, 0, '"news" is not a job word on this board');
});

test('shutdown', async () => {
  await new Promise((r) => server.close(r));
  const { closePool } = await import('../src/db.js');
  await closePool();
  await new Promise((r) => { aiServer.closeAllConnections?.(); aiServer.close(r); });
  await dbh.stop();
});
