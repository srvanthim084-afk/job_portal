/**
 * The candidate's preferred language (0102), end to end against a real
 * Postgres with RLS:
 *
 *   1  the column, the profile PUT, registration and the RLS rule
 *   2  the interview prep kit in Telugu / Hindi: tips, bring-list and
 *      headings translated, questions English, never the company or the
 *      word "client"; the recruiter's preview matches; the .ics and the
 *      messages stay English and company-free
 *   3  the career assistant's Basic mode in Telugu, Hindi and romanized
 *      Telugu / Hindi - answered from the same real data
 *   4  the Home page's suggestion card: the same engine, nothing written
 *      into the chat; with AI, one cached model call
 *
 * One local HTTP server stands in for the email/SMS providers and the
 * Anthropic API. Nothing leaves the machine.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startTestDb, applyTestEnv, makeClient } from './harness.mjs';

const DB_PORT = 5461;
const API_PORT = 9981;
const MOCK_PORT = 9861;
const COMPANY = 'Zephyrine Orchards';
const LEAK = /zephyrine|orchards/i;

const TELUGU = /[ఀ-౿]/;
const DEVANAGARI = /[ऀ-ॿ]/;

let dbh, server, mock, base, raw, config, i18n, prepKit;
let recruiter, A, B, H, E;
let ivA, ivH;
const received = [];
const model = { requests: [], reply: 'Learn **Tally** and **GST** next.', status: 200 };

async function startMock() {
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      if (req.url.startsWith('/v1/messages')) {
        let json = {};
        try { json = JSON.parse(body || '{}'); } catch { /* keep {} */ }
        model.requests.push(json);
        if (model.status !== 200) { res.writeHead(model.status, { 'content-type': 'application/json' }); res.end('{"type":"error","error":{"type":"api_error","message":"down"}}'); return; }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'msg_mock', type: 'message', role: 'assistant', model: 'claude-opus-5-5',
          content: [{ type: 'text', text: model.reply }], stop_reason: 'end_turn', stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 10 } }));
        return;
      }
      try { received.push({ url: req.url, body: JSON.parse(body || '{}') }); } catch { received.push({ url: req.url, body }); }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'mock_' + received.length }));
    });
  });
  await new Promise((r) => srv.listen(MOCK_PORT, '127.0.0.1', r));
  return srv;
}

async function staff(email, id, company) {
  const { hashPassword } = await import('../src/auth.js');
  const u = (await raw(`insert into users (email,password_hash,role) values ($1,$2,'recruiter') returning id`,
    [email, await hashPassword('Language123pass')])).rows[0].id;
  await raw(`insert into recruiters (id, user_id, name, email, company_id) values ($1,$2,'Rec Lang',$3,$4)`, [id, u, email, company]);
  const c = makeClient(base);
  await c.get('/api/health');
  assert.equal((await c.post('/api/auth/login', { email, password: 'Language123pass', role: 'recruiter' })).status, 200);
  return c;
}

async function candidate(name, email, phone, extra = {}) {
  const c = makeClient(base);
  await c.get('/api/health');
  const r = await c.post('/api/auth/register', {
    name, email, password: 'Language123cand', phone, preferredLocation: 'Nellore', expectedCtc: 3,
    noticePeriod: 'Immediate', preferredWorkModes: ['Work From Office'], ...extra,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  c.id = r.body.candidateId;
  return c;
}

const lang = async (id) => (await raw(`select preferred_language from candidates where id=$1`, [id])).rows[0].preferred_language;
const say = (c, text) => c.post('/api/career-assistant/messages', { text });

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
    AI_API_KEY: '', AI_API_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
    AI_PREP_TIMEOUT_MS: '1000', AI_ASSISTANT_TIMEOUT_MS: '1500', AI_ASSISTANT_MAX_RETRIES: '0',
  });
  raw = (sql, params) => dbh.db.query(sql, params);
  await raw(`insert into companies (id, name) values ('co_zo', $1)`, [COMPANY]);
  await raw(`insert into jobs (id, title, company_id, location, mode, exp_label, pay_label, salary_min, salary_max,
               employment_type, status, skills, recruiter_id, description, published_at)
             values ('jl1', 'Accounts Assistant', 'co_zo', 'Nellore', 'Onsite', '0-2 yrs', '₹2.5-3.5 LPA', 2.5, 3.5,
                     'Full-time', 'open', '{Tally,GST,MS Excel}', null, $1, now()),
                    ('jl2', 'Customer Support Executive', 'co_zo', 'Nellore', 'Onsite', '0-2 yrs', '₹2-3 LPA', 2, 3,
                     'Full-time', 'open', '{Communication,Telugu,MS Excel}', null, 'Support role.', now() - interval '1 day'),
                    ('jl_draft', 'Secret Draft Role', 'co_zo', 'Nellore', 'Onsite', '0-2 yrs', '₹9 LPA', 9, 9,
                     'Full-time', 'draft', '{}', null, '', null)`, [`${COMPANY} is hiring accounts staff.`]);
  ({ config } = await import('../src/config.js'));
  i18n = await import('../src/interview/prep-kit-i18n.js');
  prepKit = await import('../src/interview/prep-kit.js');
  const { createApp } = await import('../src/app.js');
  const app = createApp({ logger: { error() {}, log() {} } });
  await new Promise((r) => { server = app.listen(API_PORT, r); });
  base = `http://127.0.0.1:${API_PORT}`;
  recruiter = await staff('rec.lang@tl-sink.local', 'r_lang', 'co_zo');
  await raw(`update jobs set recruiter_id='r_lang' where company_id='co_zo'`);
});

/* ------------------------------------------------------------------ *
 * 1. the preference itself
 * ------------------------------------------------------------------ */

test('preferred language: never chosen = NULL (English), set at registration, saved by the profile PUT, checked by the database', async () => {
  A = await candidate('Anitha Reddy', 'anitha.lang@tl-sink.local', '9300000001', { preferredLanguage: 'te' });
  B = await candidate('Babu Rao', 'babu.lang@tl-sink.local', '9300000002');
  H = await candidate('Harish Verma', 'harish.lang@tl-sink.local', '9300000003', { preferredLanguage: 'hi' });
  E = await candidate('Esha Nair', 'esha.lang@tl-sink.local', '9300000004');
  assert.equal(await lang(A.id), 'te', 'registration stores the choice');
  assert.equal(await lang(B.id), null, 'never chosen: NULL (English in the portal, the admin default on calls)');
  assert.equal(await lang(H.id), 'hi');

  const bad = await B.post('/api/auth/register', {
    name: 'X Y', email: 'xy.lang@tl-sink.local', password: 'Language123cand', preferredLocation: 'Nellore', expectedCtc: 3,
    noticePeriod: 'Immediate', preferredWorkModes: ['Work From Office'], preferredLanguage: 'fr' });
  assert.equal(bad.status, 400, 'an unknown language is refused at registration');

  let r = await B.put(`/api/candidates/${B.id}`, { preferredLanguage: 'hi', languages: ['Telugu', 'English'] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.candidate.preferredLanguage, 'hi');
  assert.deepEqual(r.body.candidate.languages, ['Telugu', 'English'], '`languages` (spoken) is a different field');
  r = await B.put(`/api/candidates/${B.id}`, { preferredLanguage: 'en' });
  assert.equal(r.body.candidate.preferredLanguage, 'en');
  assert.deepEqual(r.body.candidate.languages, ['Telugu', 'English'], 'changing the preference leaves spoken languages alone');
  assert.equal((await B.put(`/api/candidates/${B.id}`, { preferredLanguage: 'fr' })).status, 400);
  assert.equal((await B.put(`/api/candidates/${A.id}`, { preferredLanguage: 'en' })).status, 403, 'not someone else\'s');
  assert.equal(await lang(A.id), 'te');

  await assert.rejects(raw(`update candidates set preferred_language='fr' where id=$1`, [B.id]), /preferred_language/);

  const self = await A.get(`/api/candidates/${A.id}`);
  assert.equal(self.status, 200);
  assert.equal(self.body.candidate.preferredLanguage, 'te', 'toCandidate carries it');
});

/* ------------------------------------------------------------------ *
 * 2. the prep kit
 * ------------------------------------------------------------------ */

test('every rules-engine tip and bring-list item has a Telugu and a Hindi translation, in their own scripts', () => {
  const seen = new Set(); const bring = new Set();
  for (const type of ['Technical (Human)', 'Client Round', 'HR Round', 'AI Interview']) {
    for (const mode of ['In Person', 'Video Call', 'Phone', 'TeamLink AI']) {
      const kit = prepKit.rulesKit({ type, mode }, { title: 'Clerk', skills: ['Tally'], exp: '0-2 yrs' });
      kit.tips.forEach((t) => seen.add(t));
      kit.bringList.forEach((b) => bring.add(b.text));
    }
  }
  assert.ok(seen.size >= 18 && bring.size >= 20, `${seen.size} tips, ${bring.size} items`);
  for (const t of seen) {
    assert.match(i18n.tipIn(t, 'te'), TELUGU, `Telugu for "${t}"`);
    assert.match(i18n.tipIn(t, 'hi'), DEVANAGARI, `Hindi for "${t}"`);
    assert.equal(i18n.tipIn(t, 'en'), t);
  }
  for (const t of bring) {
    assert.match(i18n.bringIn(t, 'te'), TELUGU, `Telugu for "${t}"`);
    assert.match(i18n.bringIn(t, 'hi'), DEVANAGARI, `Hindi for "${t}"`);
  }
  for (const l of ['te', 'hi']) {
    const labels = i18n.KIT_LABELS[l];
    assert.deepEqual(Object.keys(labels).sort(), Object.keys(i18n.KIT_LABELS.en).sort(), `${l} has every heading`);
    for (const [k, v] of Object.entries(labels)) {
      if (['ready', 'hour', 'hours', 'minutes'].includes(k)) assert.match(v, /\{(n|done)\}/);
      assert.match(v, l === 'te' ? TELUGU : DEVANAGARI, `${l}.${k} is in ${l === 'te' ? 'Telugu' : 'Hindi'} script`);
      assert.doesNotMatch(v, /\bclient\b/i);
    }
  }
  assert.equal(i18n.tipIn('A tip a recruiter wrote.', 'te'), 'A tip a recruiter wrote.', 'free text is shown as written');
  assert.equal(i18n.roundLabel('Client Round', 'en'), 'Company Round');
  assert.equal(i18n.roundLabel('Client Round', 'te'), 'కంపెనీ రౌండ్');
  assert.equal(i18n.roundLabel('HR Round', 'hi'), 'HR राउंड');
});

test('the prep kit in Telugu and Hindi: tips, checklist and headings translated, questions English, no company, no "client"', async () => {
  const appA = (await A.post('/api/applications', { jobId: 'jl1' })).body.application.id;
  const appH = (await H.post('/api/applications', { jobId: 'jl1' })).body.application.id;
  assert.ok(appA && appH);
  const seen = received.length;
  let r = await recruiter.post('/api/interviews', {
    candidateId: A.id, jobId: 'jl1', type: 'Client Round', date: '2026-11-20', time: '11:00 AM', mode: 'In Person',
    locationType: 'in_person', venueAddress: 'Plot 4, Industrial Estate, Nellore', durationMinutes: 60,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  ivA = r.body.interview.id;
  r = await recruiter.post('/api/interviews', {
    candidateId: H.id, jobId: 'jl1', type: 'HR Round', date: '2026-11-21', time: '3:00 PM', mode: 'Video Call',
    locationType: 'video', durationMinutes: 30,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  ivH = r.body.interview.id;

  const stored = (await raw(`select * from interview_prep_kits where interview_id=$1`, [ivA])).rows[0];

  const te = (await A.get(`/api/candidate/interviews/${ivA}/prep-kit`)).body.kit;
  assert.equal(te.language, 'te');
  assert.deepEqual(te.questions, stored.questions, 'questions stay English');
  assert.ok(te.tips.length && te.tips.every((t) => TELUGU.test(t)), 'every rules tip is in Telugu');
  assert.ok(te.bringList.length && te.bringList.every((b) => TELUGU.test(b.text)), 'every checklist item is in Telugu');
  assert.deepEqual(te.bringList.map((b) => b.key), stored.bring_list.map((b) => b.key), 'same keys, so ticks still work');
  assert.equal(te.labels.questions, 'అడిగే అవకాశం ఉన్న ప్రశ్నలు');
  assert.equal(te.labels.tips, 'సూచనలు');
  assert.equal(te.mode, 'నేరుగా హాజరు');
  assert.equal(te.round, 'కంపెనీ రౌండ్');
  assert.equal(te.status, 'షెడ్యూల్ అయింది');
  assert.equal(te.statusCode, 'Scheduled');
  assert.match(te.when, TELUGU, 'the date in Telugu');
  assert.equal(te.role, 'Accounts Assistant');
  assert.doesNotMatch(JSON.stringify(te), LEAK);
  assert.doesNotMatch(JSON.stringify(te), /\bclient\b/i);

  const hi = (await H.get(`/api/candidate/interviews/${ivH}/prep-kit`)).body.kit;
  assert.equal(hi.language, 'hi');
  assert.ok(hi.tips.every((t) => DEVANAGARI.test(t)));
  assert.ok(hi.bringList.every((b) => DEVANAGARI.test(b.text)));
  assert.equal(hi.labels.bring, 'क्या-क्या तैयार रखें');
  assert.equal(hi.mode, 'वीडियो कॉल');
  assert.equal(hi.round, 'HR राउंड');
  assert.ok(hi.questions.every((q) => !DEVANAGARI.test(q.q)), 'questions stay English');
  assert.doesNotMatch(JSON.stringify(hi), LEAK);

  // the checklist works on the translated list
  const tick = await A.put(`/api/candidate/interviews/${ivA}/prep-kit/checklist`, { itemKey: te.bringList[0].key, done: true });
  assert.equal(tick.status, 200);
  assert.equal(tick.body.kit.checklist.done, 1);
  assert.equal(tick.body.kit.language, 'te');

  // the recruiter's preview is what the candidate sees
  const staffView = (await recruiter.get(`/api/interviews/${ivA}/prep-kit`)).body;
  assert.equal(staffView.preview.language, 'te');
  assert.deepEqual(staffView.preview.tips, te.tips);
  assert.match(staffView.kit.tips[0], /^[\x20-\x7E]+$/, 'the recruiter edits the English source');

  // a recruiter's own words are shown as written; the template ones translated
  const ed = await recruiter.put(`/api/interviews/${ivA}/prep-kit`, {
    questions: stored.questions, tips: ['Carry a pen.', 'Wear formal clothes.'],
    bringList: [{ key: 'photo_id', text: 'A government photo ID' }, { key: 'pen', text: 'A blue pen' }],
  });
  assert.equal(ed.status, 200, JSON.stringify(ed.body));
  const te2 = (await A.get(`/api/candidate/interviews/${ivA}/prep-kit`)).body.kit;
  assert.deepEqual(te2.tips, ['Carry a pen.', 'ఫార్మల్ దుస్తులు వేసుకోండి.']);
  assert.deepEqual(te2.bringList.map((b) => b.text), ['ప్రభుత్వం ఇచ్చిన ఫోటో గుర్తింపు కార్డు', 'A blue pen']);

  // the switch follows the candidate's profile
  await A.put(`/api/candidates/${A.id}`, { preferredLanguage: 'en' });
  const en = (await A.get(`/api/candidate/interviews/${ivA}/prep-kit`)).body.kit;
  assert.equal(en.language, 'en');
  assert.deepEqual(en.tips, ['Carry a pen.', 'Wear formal clothes.']);
  assert.equal(en.round, 'Company Round', 'never "Client Round" to a candidate');
  assert.equal(en.labels.questions, 'Likely questions');
  await A.put(`/api/candidates/${A.id}`, { preferredLanguage: 'te' });

  // the calendar file and the messages: English, no company, no "Client"
  const ics = await A.get(`/api/candidate/interviews/${ivA}/prep-kit.ics`);
  const icsText = typeof ics.body === 'string' ? ics.body : JSON.stringify(ics.body);
  assert.doesNotMatch(icsText, LEAK);
  assert.doesNotMatch(icsText, /client/i);
  assert.match(icsText, /Company Round/);
  const msgs = received.slice(seen);
  assert.ok(msgs.length >= 2, `messages were sent through the mock (${msgs.length})`);
  for (const m of msgs) {
    assert.doesNotMatch(JSON.stringify(m.body), LEAK, 'a message names the company');
    assert.doesNotMatch(JSON.stringify(m.body), /\bclient round\b/i, 'a message says "Client Round"');
  }
});

/* ------------------------------------------------------------------ *
 * 3. the assistant's Basic mode
 * ------------------------------------------------------------------ */

test('Basic mode answers in the language and script of the message, from real data', async () => {
  // E: preferred English, no interview, skills that leave gaps
  await raw(`update candidates set title='Accounts Assistant', skills='{MS Excel}', education='B.Com', exp_years=1 where id=$1`, [E.id]);

  let r = await say(E, 'naaku job kavali');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.engine, 'rules');
  assert.equal(r.body.language, 'te-Latn');
  assert.match(r.body.reply, /saripoye jobs/);
  assert.match(r.body.reply, /\[Accounts Assistant\]\(#\/job\/jl1\)/, 'a real open job');
  assert.match(r.body.reply, /\d+% match/);
  assert.doesNotMatch(r.body.reply, TELUGU, 'romanized in, romanized out');
  assert.ok(!r.body.reply.includes('Secret Draft Role'));

  r = await say(E, 'mujhe naukri chahiye');
  assert.equal(r.body.language, 'hi-Latn');
  assert.match(r.body.reply, /Abhi aapke liye sabse achhi jobs/);
  assert.match(r.body.reply, /#\/job\/jl1/);

  r = await say(E, 'నాకు ఉద్యోగం కావాలి');
  assert.equal(r.body.language, 'te');
  assert.match(r.body.reply, /ప్రస్తుతం మీకు బాగా సరిపోయే ఉద్యోగాలు/);
  assert.match(r.body.reply, /\d+% మ్యాచ్/);
  assert.match(r.body.reply, /#\/job\/jl1/);

  r = await say(E, 'मुझे नौकरी चाहिए');
  assert.equal(r.body.language, 'hi');
  assert.match(r.body.reply, /\d+% मैच/);

  r = await say(E, 'What jobs match me?');
  assert.equal(r.body.language, 'en');
  assert.match(r.body.reply, /Your best matches right now/);

  r = await say(E, 'ఉద్యోగం కోసం ఫీజు కట్టాలా?');
  assert.match(r.body.reply, /TeamLink ఉద్యోగాల కోసం అభ్యర్థుల నుంచి ఎలాంటి డబ్బు తీసుకోదు/);

  r = await say(E, 'naukri ke liye fees dena padega kya');
  assert.equal(r.body.language, 'hi-Latn');
  assert.match(r.body.reply, /koi paisa nahi leta/);

  r = await say(E, 'इंटरव्यू की तैयारी कैसे करूँ');
  assert.match(r.body.reply, /अभी आपका कोई इंटरव्यू तय नहीं हुआ है/);

  r = await say(E, 'naaku e skills nerchukovali');
  assert.equal(r.body.language, 'te-Latn');
  assert.match(r.body.reply, /\*\*(tally|gst)\*\*/i, 'the real gaps');
  assert.match(r.body.reply, /inka add cheyyani skills/);

  // profile gaps: field names translated
  r = await say(E, 'నా ప్రొఫైల్ ఎలా మెరుగుపరచాలి');
  assert.match(r.body.reply, /రెజ్యూమ్/);
  assert.doesNotMatch(r.body.reply.split('](')[0], /\bresume\b/i, 'the field names are Telugu (links keep their #/candidate/resume path)');

  // a message that does not say: the stored preference decides
  await E.put(`/api/candidates/${E.id}`, { preferredLanguage: 'hi' });
  r = await say(E, 'jobs');
  assert.equal(r.body.language, 'hi');
  assert.match(r.body.reply, DEVANAGARI);
  r = await say(E, 'Should I apply?');
  assert.equal(r.body.language, 'en', 'a clearly English message is answered in English');
  await E.put(`/api/candidates/${E.id}`, { preferredLanguage: 'en' });

  // A (Telugu) has an interview: the round is never "Client"
  r = await say(A, 'ఇంటర్వ్యూకి ఎలా సిద్ధం కావాలి');
  assert.equal(r.body.language, 'te');
  assert.match(r.body.reply, /మీ తదుపరి ఇంటర్వ్యూ: Accounts Assistant కోసం \*\*కంపెనీ రౌండ్\*\*/);
  assert.doesNotMatch(r.body.reply, LEAK);
  r = await say(A, 'interview ki ela prepare avvali');
  assert.equal(r.body.language, 'te-Latn');
  assert.match(r.body.reply, /Company Round/);
  assert.doesNotMatch(r.body.reply, /client/i);

  assert.equal(model.requests.length, 0, 'no model was asked');
});

/* ------------------------------------------------------------------ *
 * 4. the Home page's suggestion card
 * ------------------------------------------------------------------ */

test('suggestion card: same engine, in the preferred language, nothing written into the chat', async () => {
  const anon = makeClient(base);
  await anon.get('/api/health');
  assert.equal((await anon.get('/api/career-assistant/suggestion')).status, 401);
  assert.equal((await recruiter.get('/api/career-assistant/suggestion')).status, 403);

  const before = (await raw(`select (select count(*) from career_assistant_messages where candidate_id=$1)::int m,
                                    (select count(*) from career_assistant_usage where candidate_id=$1)::int u`, [A.id])).rows[0];
  let r = await A.get('/api/career-assistant/suggestion');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.engine, 'rules');
  assert.equal(r.body.language, 'te');
  assert.match(r.body.reply, TELUGU);
  assert.match(r.body.reply, /స్కిల్స్/);
  assert.equal(await lang(E.id), 'en');
  await raw(`update candidates set preferred_language = null where id=$1`, [E.id]);
  r = await E.get('/api/career-assistant/suggestion');
  assert.equal(r.body.language, 'en', 'never chosen reads as English');
  assert.match(r.body.reply, /\*\*(tally|gst)\*\*/i, 'from E\'s real gaps');
  const after = (await raw(`select (select count(*) from career_assistant_messages where candidate_id=$1)::int m,
                                   (select count(*) from career_assistant_usage where candidate_id=$1)::int u`, [A.id])).rows[0];
  assert.deepEqual(after, before, 'no chat message and no usage for a rules suggestion');
  assert.equal(model.requests.length, 0);
});

test('suggestion card with AI: the question goes in the preferred language, one call cached, failures are not papered over', async () => {
  config.aiApiKey = 'test-key-not-real';
  try {
    model.requests.length = 0;
    let r = await H.get('/api/career-assistant/suggestion');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.engine, 'ai');
    assert.equal(r.body.reply, model.reply);
    assert.equal(model.requests.length, 1);
    const sent = model.requests[0].messages.at(-1).content;
    assert.equal(JSON.stringify(sent).includes('मुझे कौन-सी स्किल्स सीखनी चाहिए?'), true, 'asked in Hindi');
    r = await H.get('/api/career-assistant/suggestion');
    assert.equal(r.body.cached, true);
    assert.equal(model.requests.length, 1, 'served from the cache');
    assert.equal((await raw(`select count(*)::int n from career_assistant_usage where candidate_id=$1 and engine='ai'`, [H.id])).rows[0].n, 1);
    assert.equal((await raw(`select count(*)::int n from career_assistant_messages where candidate_id=$1`, [H.id])).rows[0].n, 0);

    model.status = 500;
    r = await B.get('/api/career-assistant/suggestion');
    assert.equal(r.status, 503);
    assert.equal(r.body.error.code, 'ASSISTANT_UNAVAILABLE');
  } finally {
    model.status = 200;
    config.aiApiKey = '';
  }
});

test('shutdown', async () => {
  const { closePool } = await import('../src/db.js');
  await new Promise((r) => server.close(r));
  await closePool();
  await new Promise((r) => { mock.closeAllConnections?.(); mock.close(r); });
  await dbh.stop();
});
