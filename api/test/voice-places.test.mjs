/**
 * Voice search: places spoken in Telugu or Devanagari script, without the
 * AI key (the rules engine).
 *
 *   - transliteration of both scripts (vowel signs, virama, anusvara,
 *     nukta, Hindi's silent inherent "a")
 *   - the sound match: spelling-tolerant, never a place the index or the
 *     board does not hold, ordinary words never become places
 *   - POST /api/search/voice-parse end to end, with the place index when
 *     it is installed (PLACE_TREE_FILE) and the live board's towns always
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestDb, applyTestEnv, makeClient } from './harness.mjs';
import { transliterate, placeKey, skeleton, vowelDistance, hasIndicScript } from '../src/search/indic-translit.js';
import { buildSoundIndex, soundMatch } from '../src/search/place-sound.js';

const DB_PORT = 5467;
const API_PORT = 9987;
const HERE = dirname(fileURLToPath(import.meta.url));
const TREE = process.env.PLACE_TREE_FILE || resolve(HERE, '../../var/places/india-tree.tsv');
const HAVE_TREE = existsSync(TREE);

let dbh, server, client;
const parse = (text, lang = 'te-IN') => client.post('/api/search/voice-parse', { text, lang });

/* ------------------------------------------------------------------ *
 * transliteration
 * ------------------------------------------------------------------ */

test('Telugu script -> Latin: vowel signs, virama, anusvara', () => {
  assert.equal(transliterate('నెల్లూరు'), 'nelluuru');           // ల్ల: virama joins the two l's
  assert.equal(transliterate('విజయవాడ'), 'vijayavaada');
  assert.equal(transliterate('గుంటూరు'), 'guntuuru');            // ం before ట: n
  assert.equal(transliterate('విశాఖపట్నం'), 'vishaakhapatnam');   // final ం: m
  assert.equal(transliterate('కరీంనగర్'), 'kariimnagar');        // ం before న: m (Karimnagar)
  assert.equal(transliterate('హైదరాబాద్'), 'haidaraabaad');       // final virama: no vowel
  assert.equal(transliterate('మహబూబ్‌నగర్'), 'mahabuubnagar');   // zero-width non-joiner inside a word
  assert.equal(transliterate('ఏలూరు'), 'eluuru');
  assert.equal(transliterate('నెల్లూరు లో 2'), 'nelluuru lo 2');
});

test('Devanagari -> Latin: silent inherent a, nukta, anusvara', () => {
  assert.equal(transliterate('हैदराबाद'), 'haidraabaad');
  assert.equal(transliterate('पटना'), 'patnaa');
  assert.equal(transliterate('कानपुर'), 'kaanpur');
  assert.equal(transliterate('मुंबई'), 'mumbaii');                // ं before ब: m
  assert.equal(transliterate('दिल्ली'), 'dillii');
  assert.equal(transliterate('गुड़गांव'), 'gurgaanv');             // ड़ = r
  assert.equal(transliterate('विजयवाड़ा', { flap: 'd' }), 'vijayvaadaa');
  assert.equal(transliterate('घर'), 'ghar');
  assert.equal(transliterate('क'), 'ka');                           // one syllable keeps its a
  assert.ok(hasIndicScript('ड्राइवर नेल्लोर'));
  assert.ok(!hasIndicScript('Nellore driver'));
});

test('sound keys: the spellings of one place agree', () => {
  const same = [['Nellore', 'nellooru', 0.5], ['Hyderabad', 'haidaraabaad', 1], ['Vijayawada', 'vijayavaada', 0],
    ['Guntur', 'guntooru', 0], ['Visakhapatnam', 'vishaakhapatnam', 0], ['Kurnool', 'karnuulu', 0.5],
    ['Vizianagaram', 'vijayanagaram', 0.5]];
  for (const [a, b, max] of same) {
    const ka = placeKey(a);
    const kb = placeKey(b);
    assert.equal(skeleton(ka), skeleton(kb), `${a} / ${b}`);
    assert.ok(vowelDistance(ka, kb) <= max, `${a} / ${b}: ${vowelDistance(ka, kb)}`);
  }
});

/* ------------------------------------------------------------------ *
 * the sound match on its own (a small index, no file needed)
 * ------------------------------------------------------------------ */

const SMALL = buildSoundIndex([
  { name: 'Nellore', type: 'district', population: 2963557, aliases: ['NEL'] },
  { name: 'Hyderabad', type: 'district', population: 3943323, aliases: ['Haidarabad'] },
  { name: 'Vijayawada', type: 'place', population: 1143232, aliases: [] },
  { name: 'Guntur', type: 'district', population: 4889230, aliases: [] },
  { name: 'Visākhapatnam', type: 'district', population: 4290589, aliases: [] },
  { name: 'Kota', type: 'district', population: 1951014, aliases: [] },
  { name: 'Chennai', type: 'district', population: 4646732, aliases: [] },
  { name: 'Ongole', type: 'place', population: 208344, aliases: [] },
  { name: 'Angul District', type: 'district', population: 1273821, aliases: [] },
  { name: 'Smallpur', type: 'place', population: 4000, aliases: [] },
  { name: 'Rajahmundry Urban', type: 'mandal', population: 341831, aliases: [] },
]);

test('sound match: native script and romanised spellings, never anything else', () => {
  const m = (t) => (soundMatch(t, [SMALL]) || {}).name || '';
  assert.equal(m('నెల్లూరు'), 'Nellore');
  assert.equal(m('నెల్లూరులో'), 'Nellore', 'a joined "lo" (in) is taken off');
  assert.equal(m('nellooru'), 'Nellore');
  assert.equal(m('हैदराबाद'), 'Hyderabad');
  assert.equal(m('haidaraabaad'), 'Hyderabad');
  assert.equal(m('vijayavaada'), 'Vijayawada');
  assert.equal(m('विजयवाड़ा'), 'Vijayawada', 'ड़ read as d too');
  assert.equal(m('guntooru'), 'Guntur');
  assert.equal(m('vishaakhapatnam'), 'Visakhapatnam', 'macron off in the answer');
  assert.equal(m('విశాఖ'), 'Visakhapatnam', 'a known short name');
  assert.equal(m('vizag'), 'Visakhapatnam');
  assert.equal(m('ఒంగోలు'), 'Ongole', 'not Angul: the first sound differs');
  assert.equal(m('రాజమండ్రి'), 'Rajahmundry', '"Rajahmundry Urban" answers as Rajahmundry');
  // never invented, never an ordinary word
  assert.equal(m('బెజవాడ'), 'Vijayawada', 'Bezawada is Vijayawada');
  assert.equal(m('Smallpur'), '', 'a small town is not in the sound index');
  assert.equal(m('కొత్త'), '', '"new" is not Kota');
  assert.equal(m('చిన్న'), '', '"small" is not Chennai');
  assert.equal(m('manager'), '');
  assert.equal(m('good'), '');
  assert.equal(m('క్వెర్టీపురం'), '');
  assert.equal(m('bombay'), '', 'a rename is used only when the index holds the target');
  assert.equal(soundMatch('నెల్లూరు', []), null);
});

/* ------------------------------------------------------------------ *
 * the route, end to end
 * ------------------------------------------------------------------ */

test('boot', async () => {
  dbh = await startTestDb(DB_PORT);
  applyTestEnv(dbh.url, {
    PUBLIC_ORIGIN: `http://127.0.0.1:${API_PORT}`,
    DISABLE_BACKGROUND_WORK: 'true',
    AI_API_KEY: '',
    PLACE_TREE_FILE: HAVE_TREE ? TREE : resolve(HERE, 'no-such-place-index.tsv'),
    VOICE_RATE_LIMIT_MAX: '500',
  });
  const raw = (sql, params) => dbh.db.query(sql, params);
  await raw(`insert into companies (id, name) values ('co_vp', 'Voice Places Co')`);
  for (const [id, title, loc] of [
    ['jvp1', 'Driver', 'Nellore'],
    ['jvp2', 'Telecaller', 'Hyderabad'],
    ['jvp3', 'Data Entry Operator', 'Guntur'],
  ]) {
    await raw(`insert into jobs (id, title, company_id, location, mode, employment_type, status, skills, published_at)
               values ($1,$2,'co_vp',$3,'Onsite','Full-time','open','{}',now())`, [id, title, loc]);
  }
  const { createApp } = await import('../src/app.js');
  const app = createApp({ logger: { error() {}, log() {} } });
  await new Promise((r) => { server = app.listen(API_PORT, r); });
  client = makeClient(`http://127.0.0.1:${API_PORT}`);
});

test('the board\'s own towns are matched by sound with no place index at all', async () => {
  const r = await parse('నెల్లూరు లో డ్రైవర్ జాబ్');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.engine, 'rules');
  assert.equal(r.body.filters.q, 'driver');
  assert.equal(r.body.filters.loc, 'Nellore');
  assert.deepEqual(r.body.understood, ['Driver', 'Nellore']);
  const h = await parse('हैदराबाद में टेलीकॉलर', 'hi-IN');
  assert.equal(h.body.filters.q, 'telecaller');
  assert.equal(h.body.filters.loc, 'Hyderabad');
  assert.deepEqual(h.body.portal.locTags, ['Hyderabad']);
  const g = await parse('guntooru lo data entry');
  assert.equal(g.body.filters.loc, 'Guntur');
});

/* [spoken, place, job] - Andhra Pradesh, Telangana and the big cities. */
const PHRASES = [
  ['నెల్లూరు లో డ్రైవర్ జాబ్', 'Nellore', 'driver'],
  ['హైదరాబాద్ లో టెలికాలర్ జాబ్స్', 'Hyderabad', 'telecaller'],
  ['విజయవాడ లో నర్స్ ఉద్యోగం కావాలి', 'Vijayawada', 'nurse'],
  ['గుంటూరు డేటా ఎంట్రీ', 'Guntur', 'data entry'],
  ['విశాఖపట్నం సేల్స్ జాబ్', 'Visakhapatnam', 'sales'],
  ['తిరుపతి లో డ్రైవర్', 'Tirupati', 'driver'],
  ['కర్నూలు లో సెక్యూరిటీ గార్డ్', 'Kurnool', 'security guard'],
  ['కాకినాడ డెలివరీ బాయ్', 'Kakinada', 'delivery boy'],
  ['వరంగల్ లో టీచర్ పోస్ట్', 'Warangal', 'teacher'],
  ['కరీంనగర్ లో అకౌంటెంట్', 'Karimnagar', 'accountant'],
  ['ఖమ్మం జిల్లాలో డ్రైవర్', 'Khammam', 'driver'],
  ['రాజమండ్రి లో హెల్పర్', 'Rajahmundry', 'helper'],
  ['అనంతపురం లో కుక్', 'Anantapur', 'cook'],
  ['నెల్లూరులో డ్రైవర్ జాబ్', 'Nellore', 'driver'],
  ['हैदराबाद में टेलीकॉलर', 'Hyderabad', 'telecaller'],
  ['दिल्ली में ड्राइवर की नौकरी', 'Delhi', 'driver'],
  ['मुंबई में डिलीवरी बॉय', 'Mumbai', 'delivery boy'],
  ['पुणे में नर्स', 'Pune', 'nurse'],
  ['पटना में सिक्योरिटी गार्ड', 'Patna', 'security guard'],
  ['लखनऊ में अकाउंटेंट', 'Lucknow', 'accountant'],
  ['जयपुर में कुक', 'Jaipur', 'cook'],
  ['कानपुर में हेल्पर', 'Kanpur', 'helper'],
  ['चेन्नई में टीचर', 'Chennai', 'teacher'],
  ['विजयवाड़ा में ड्राइवर', 'Vijayawada', 'driver'],
  ['गुड़गांव में डाटा एंट्री', 'Gurugram', 'data entry'],
];

test(`${PHRASES.length} native-script phrases resolve to the place in the index`, { skip: !HAVE_TREE && 'place index not installed' }, async () => {
  const { treeWarm } = await import('../src/place-tree.js');
  await treeWarm();
  const wrong = [];
  for (const [text, place, job] of PHRASES) {
    // eslint-disable-next-line no-await-in-loop
    const r = await parse(text, /[\u0900-\u097f]/.test(text) ? 'hi-IN' : 'te-IN');
    assert.equal(r.status, 200, text);
    assert.equal(r.body.engine, 'rules', text);
    if (r.body.filters.loc !== place || r.body.filters.q !== job) wrong.push(`${text} -> ${r.body.filters.q} / ${r.body.filters.loc}`);
  }
  assert.deepEqual(wrong, []);
});

test('ordinary words never become places', { skip: !HAVE_TREE && 'place index not installed' }, async () => {
  const NOT = [
    'కొత్త డ్రైవర్ జాబ్స్', 'చిన్న కంపెనీ లో డేటా ఎంట్రీ', 'మంచి జీతం టెలికాలర్', 'హాస్పిటల్ లో నర్స్', 'ఆఫీసు లో హెల్పర్',
    'ప్రైవేట్ స్కూల్ టీచర్', 'నైట్ షిఫ్ట్ సెక్యూరిటీ', 'ఇంటి నుంచి పని', 'అమ్మాయిలకు డేటా ఎంట్రీ', 'పల్లె లో పని',
    'अच्छी सैलरी वाली नौकरी', 'सरकारी नौकरी चाहिए', 'प्राइवेट कंपनी में ड्राइवर', 'रात की शिफ्ट में गार्ड', 'लड़की के लिए टेलीकॉलर',
    'घर से काम', 'दुकान में हेल्पर', 'होटल में कुक', 'बड़ी कंपनी में सेल्स', 'नई नौकरी',
    'good salary driver', 'manager job', 'office boy urgent',
  ];
  const leaked = [];
  for (const text of NOT) {
    // eslint-disable-next-line no-await-in-loop
    const r = await parse(text, /[\u0900-\u097f]/.test(text) ? 'hi-IN' : 'te-IN');
    if (r.body.filters.loc) leaked.push(`${text} -> ${r.body.filters.loc}`);
  }
  assert.deepEqual(leaked, []);
  // a made-up place in either script stays out
  for (const text of ['క్వెర్టీపురం లో డ్రైవర్', 'क्वर्टीनगर में ड्राइवर']) {
    const r = await parse(text);
    assert.equal(r.body.filters.loc, '', text);
    assert.equal(r.body.filters.q, 'driver', text);
  }
});

test('shutdown', async () => {
  await new Promise((r) => server.close(r));
  const { closePool } = await import('../src/db.js');
  await closePool();
  await dbh.stop();
});
