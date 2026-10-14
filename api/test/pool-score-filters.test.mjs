/**
 * The Overall score dropdown (and the Resume score one beside it) - EVERY option, on the real filter
 * GET /api/candidates?overallScoreMin=&resumeScoreMin=.
 *
 *   - the options are read from the pages themselves (Talent Pool and the Find Candidates sidebar), so a new
 *     option cannot be added without a test: Any, 90, 80, 70, 65 (ATS), 50 - each is "this much or more"
 *   - for each option: only candidates whose Overall score is at or above it, the boundary included, the one
 *     just below left out; never-applied, no-interview (null) and sample rows never appear for a number
 *   - the filter runs in SQL before the paging: every page, the count and a changed order stay inside it,
 *     and nobody appears twice (a candidate with two applications counts once, by the better one)
 *   - combined with the resume score, source, a name search and the ATS filter, every condition holds
 *   - each row says its Overall score, and it satisfies the option; switching options replaces the condition
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startTestDb, applyTestEnv, makeClient } from './harness.mjs';

const DB_PORT = 5615;
const API_PORT = 9971;
const base = `http://127.0.0.1:${API_PORT}`;
const PW = 'PoolScore123test';
const web = (f) => readFileSync(new URL(`../../web/${f}`, import.meta.url), 'utf8');

let dbh, server, raw, rec;
const C = {};
let seq = 0;

async function candidate(name, source = null) {
  seq += 1;
  const c = makeClient(base);
  await c.get('/api/health');
  const r = await c.post('/api/auth/register', {
    name, email: `pool.score.${seq}.${Date.now().toString(36)}@mailbox-teamlink-tests.in`,
    password: PW, phone: '93500' + String(10000 + seq).slice(-5), preferredLocation: 'Hyderabad', expectedCtc: 4,
    noticePeriod: 'Immediate', preferredWorkModes: ['Hybrid'],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  c.id = r.body.candidateId;
  if (source) await raw(`update candidates set source = $2 where id = $1`, [c.id, source]);
  return c;
}
let appSeq = 0;
const app = async (c, overall, extra = {}, jobId = 'j_ps') => {
  const id = `a_ps_${++appSeq}`;
  await raw(`insert into applications (id, job_id, candidate_id, recruiter_id, stage, source, is_demo, overall_score)
             values ($1, $5, $2, 'r_ps', 'applied', 'portal', $3, $4)`, [id, c.id, !!extra.demo, overall, jobId]);
  return id;
};
const get = async (qs) => (await rec.get(`/api/candidates?q=Scorer&${qs}`)).body;
const nameSet = async (qs) => {
  /* every page, 4 at a time, in two different orders: the union is the answer, with no repeats */
  const seen = [];
  for (let off = 0; off < 200; off += 4) {
    const b = await get(`limit=4&offset=${off}&${qs}`);
    for (const x of b.candidates) seen.push(x.name);
    if (b.candidates.length < 4) break;
  }
  assert.equal(new Set(seen).size, seen.length, `no candidate twice (${qs})`);
  return seen.sort();
};
const SCORES = { 49: 49, 50: 50, 64: 64, 65: 65, 69: 69, 70: 70, 79: 79, 80: 80, 89: 89, 90: 90, 100: 100 };
const nameOf = (n) => `Scorer S${n}`;

test('the options on both pages are the ones tested here', () => {
  const pick = (src, anchor) => {
    const i = src.indexOf(anchor); assert.ok(i > 0, anchor);
    const block = src.slice(i, i + 400);
    return [...block.matchAll(/\['(\d*)',\s*'([^']*)'\]/g)].map((m) => m[1]).slice(0, 6);
  };
  const tp = pick(web('index.html'), "fld('overallScore','Overall score'");
  const fc = pick(web('teamlink-resume-score.js'), "'tlrsOverall', 'Overall score'");
  assert.deepEqual(tp, ['', '90', '80', '70', '65', '50']);
  assert.deepEqual(fc, tp, 'Find Candidates offers the same options');
});

test('boot', async () => {
  dbh = await startTestDb(DB_PORT);
  applyTestEnv(dbh.url, {
    PUBLIC_ORIGIN: base, DISABLE_BACKGROUND_WORK: 'true', AI_API_KEY: '',
    EMAIL_API_KEY: '', EMAIL_SMTP_HOST: '', EMAIL_SMTP_USER: '', EMAIL_SMTP_PASS: '',
    EMAILJS_SERVICE_ID: '', EMAILJS_TEMPLATE_ID: '', EMAILJS_PUBLIC_KEY: '', EMAILJS_PRIVATE_KEY: '',
    SMS_API_KEY: '', WHATSAPP_API_KEY: '',
  });
  raw = (sql, params) => dbh.db.query(sql, params);
  await raw(`insert into companies (id, name) values ('co_ps', 'Score Co')`);
  const { hashPassword } = await import('../src/auth.js');
  const u = (await raw(`insert into users (email,password_hash,role) values ('rec.ps@tl-sink.local',$1,'recruiter') returning id`, [await hashPassword(PW)])).rows[0].id;
  await raw(`insert into recruiters (id, user_id, name, email, company_id) values ('r_ps',$1,'Rec PS','rec.ps@tl-sink.local','co_ps')`, [u]);
  await raw(`insert into jobs (id, title, company_id, location, mode, exp_label, skills, status, recruiter_id, description, published_at)
             values ('j_ps', 'Scoring Role', 'co_ps', 'Hyderabad', 'Onsite', '1-3 yrs', ARRAY['Sourcing'], 'open', 'r_ps', 'Role.', now())`);
  await raw(`insert into jobs (id, title, company_id, location, mode, exp_label, skills, status, recruiter_id, description, published_at)
             values ('j_ps2', 'Second Role', 'co_ps', 'Hyderabad', 'Onsite', '1-3 yrs', ARRAY['Sourcing'], 'open', 'r_ps', 'Role.', now())`);
  const { createApp } = await import('../src/app.js');
  const a = createApp({ logger: { error() {}, log() {} } });
  await new Promise((r) => { server = a.listen(API_PORT, r); });
  rec = makeClient(base); await rec.get('/api/health');
  assert.equal((await rec.post('/api/auth/login', { email: 'rec.ps@tl-sink.local', password: PW, role: 'recruiter' })).status, 200);

  /* just below, exactly at and above every threshold; two sources */
  for (const n of Object.keys(SCORES)) {
    const c = await candidate(nameOf(n), Number(n) % 2 ? 'Naukri' : 'Shine');
    C[n] = c; await app(c, SCORES[n]);
  }
  /* the others: never applied, applied but no interview (null), a sample row at 99, two applications (40 and 85) */
  C.never = await candidate('Scorer Never');
  C.null = await candidate('Scorer Null'); await app(C.null, null);
  C.demo = await candidate('Scorer Demo'); await app(C.demo, 99, { demo: true });
  C.two = await candidate('Scorer Two', 'Naukri'); await app(C.two, 40); await app(C.two, 85, {}, 'j_ps2');
  /* a different name, to prove the name search is part of the condition */
  C.other = await candidate('Other Person'); await app(C.other, 95);
  /* resume scores for the combination test */
  const rs = (c, total) => raw(`insert into candidate_resume_scores (candidate_id, status, total_score, label) values ($1, 'scored', $2, 'Good')`, [c.id, total]);
  await rs(C[90], 95); await rs(C[65], 55); await rs(C[80], 85); await rs(C.never, 99);
});

const OPTIONS = [['', 'Any'], ['90', '90% or more'], ['80', '80% or more'], ['70', '70% or more'], ['65', '65% or more (ATS)'], ['50', '50% or more']];
const expectedFor = (min) => {
  const names = Object.keys(SCORES).filter((n) => !min || SCORES[n] >= Number(min)).map(nameOf);
  if (!min) return [...names, 'Scorer Never', 'Scorer Null', 'Scorer Demo', 'Scorer Two'].sort();
  if (85 >= Number(min)) names.push('Scorer Two');           // two applications: the better one (85) counts
  return names.sort();
};

for (const [min, label] of OPTIONS) {
  test(`option "${label}": exactly the candidates at or above ${min || 'nothing (Any)'}, on every page`, async () => {
    const got = await nameSet(min ? `overallScoreMin=${min}` : '');
    assert.deepEqual(got, expectedFor(min));
    if (min) {
      const b = await get(`limit=50&overallScoreMin=${min}`);
      assert.equal(b.total, expectedFor(min).length, 'the count is the filtered count');
      for (const x of b.candidates) {
        assert.ok(Number.isFinite(x.overallScore) && x.overallScore >= Number(min), `${x.name} shows ${x.overallScore}, which is not ${label}`);
      }
      /* the sample row, the empty one and the never-applied one are not classified into any range */
      for (const n of ['Scorer Demo', 'Scorer Null', 'Scorer Never']) assert.ok(!got.includes(n), `${n} is not in ${label}`);
    }
  });
}

test('each threshold: the score just below is out, the score at it is in', async () => {
  for (const [min, below, at] of [[90, 89, 90], [80, 79, 80], [70, 69, 70], [65, 64, 65], [50, 49, 50]]) {
    const got = await nameSet(`overallScoreMin=${min}`);
    assert.ok(got.includes(nameOf(at)), `${at} is in ${min}`);
    assert.ok(!got.includes(nameOf(below)), `${below} is not in ${min}`);
  }
});

test('the order and the page size never let a stranger in', async () => {
  for (const sort of ['name', 'added', 'added-asc', 'source', 'Relevance']) {
    for (const limit of [1, 3, 25]) {
      const b = await get(`limit=${limit}&overallScoreMin=65&sort=${sort}`);
      assert.equal(b.total, expectedFor('65').length, `${sort}/${limit}: the count`);
      for (const x of b.candidates) assert.ok(x.overallScore >= 65, `${sort}/${limit}: ${x.name}`);
    }
  }
  /* a page beyond the end is empty, not the unfiltered list */
  assert.equal((await get('limit=25&offset=500&overallScoreMin=65')).candidates.length, 0);
});

test('switching options replaces the condition; nothing is left over from the one before', async () => {
  const seq = ['90', '50', '', '80', '65', '', '70'];
  for (const min of seq) {
    assert.deepEqual(await nameSet(min ? `overallScoreMin=${min}` : ''), expectedFor(min), `after switching to "${min || 'Any'}"`);
  }
});

test('combined with the resume score, the source, a name search and the ATS filter: every condition holds', async () => {
  /* resume 80+ AND overall 65+ */
  assert.deepEqual(await nameSet('overallScoreMin=65&resumeScoreMin=80'), [nameOf(80), nameOf(90)].sort());
  /* resume 50+ AND overall 80+: S65 has resume 55 but overall 65 - out */
  assert.deepEqual(await nameSet('overallScoreMin=80&resumeScoreMin=50'), [nameOf(80), nameOf(90)].sort());
  /* source Naukri AND overall 65+ (odd scores are Naukri, plus Scorer Two) */
  const naukri = await nameSet('overallScoreMin=65&source=Naukri');
  assert.deepEqual(naukri, [nameOf(65), nameOf(69), nameOf(79), nameOf(89), 'Scorer Two'].sort());
  assert.deepEqual(await nameSet('overallScoreMin=65&source=Shine'), [nameOf(70), nameOf(80), nameOf(90), nameOf(100)].sort());
  /* the name search is part of it: "Other Person" has 95 but is not a Scorer */
  const other = await rec.get('/api/candidates?q=Other&overallScoreMin=90');
  assert.deepEqual(other.body.candidates.map((x) => x.name), ['Other Person']);
  assert.equal((await rec.get('/api/candidates?q=Other&overallScoreMin=99')).body.candidates.length, 0);
  /* ATS: nobody here was pushed; the score condition still holds alongside it */
  await raw(`update applications set stage = 'shortlisted', ats_pushed_at = now(), ats_pushed_via = 'auto_overall'
              where candidate_id = $1 and overall_score = 65`, [C[65].id]);
  assert.deepEqual(await nameSet('overallScoreMin=65&ats=auto'), [nameOf(65)]);
  assert.deepEqual(await nameSet('overallScoreMin=70&ats=auto'), [], 'a pushed candidate below the option is not shown');
});

test('the Source chips count under the other filters, so they agree with the total at the top', async () => {
  const counts = (b) => Object.fromEntries(b.sourceCounts.map((x) => [x.source, x.n]));
  const sum = (b) => b.sourceCounts.reduce((a, x) => a + x.n, 0);
  /* no filter: every Scorer, by source (nobody here has a source set except the Naukri / Shine ones) */
  const none = await get('limit=5&withSourceCounts=1');
  assert.equal(sum(none), none.total);
  /* Overall 65+: the chips add up to the total shown, and the ones that dropped out are not counted */
  const o65 = await get('limit=5&overallScoreMin=65&withSourceCounts=1');
  assert.equal(sum(o65), o65.total); assert.equal(o65.total, expectedFor('65').length);
  assert.equal(counts(o65).Naukri, 5, 'S65, S69, S79, S89 and Scorer Two'); assert.equal(counts(o65).Shine, 4);
  /* a source picked: the total narrows, the chips still show every source under the OTHER filters */
  const picked = await get('limit=5&overallScoreMin=65&source=Shine&withSourceCounts=1');
  assert.equal(picked.total, 4); assert.deepEqual(counts(picked), counts(o65));
  /* without the flag nothing changes */
  assert.equal((await get('limit=5&overallScoreMin=65')).sourceCounts, undefined);
});

test('a value that is not a number is ignored, like an empty one', async () => {
  const all = (await nameSet('')).length;
  assert.equal((await nameSet('overallScoreMin=banana')).length, all);
  assert.equal((await nameSet('overallScoreMin=')).length, all);
  assert.equal((await nameSet('resumeScoreMin=&overallScoreMin=')).length, all);
});

test('shutdown', async () => {
  await new Promise((r) => server.close(r));
  const { stopBackgroundWork } = await import('../src/app.js'); stopBackgroundWork();
  const { closePool } = await import('../src/db.js'); await closePool();
  await dbh.stop?.();
});
