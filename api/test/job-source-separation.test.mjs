/**
 * Job source separation (owner, 2026-10-05; migration 0113).
 *
 *   JOBS PAGE          = TEAMLINK jobs only    EXTERNAL JOBS PAGE = EXTERNAL jobs only
 *
 * Every endpoint the Jobs page uses, asked for TeamLink Job A beside
 * External Job B (same skill, same city, B the better match): A comes back,
 * B never does - and the External Jobs endpoints are the mirror image.
 * The owner's acceptance tests 1-18 are named in the test titles. The
 * restriction is the SERVER's (the query is scoped), so nothing here goes
 * through a browser; tools/verify-job-source-separation.mjs repeats them
 * through the real UI.
 *
 * Self-contained: an in-memory database, external sources fed by hand
 * (licensed in this suite only), nothing leaves the machine.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb, applyTestEnv, makeClient } from './harness.mjs';

const DB_PORT = 5492;
const API_PORT = 9972;
const BASE = `http://127.0.0.1:${API_PORT}`;
let dbh, server, raw, admin, rec, cand, anon, candSession;
const T = {};          // TeamLink job ids
const X = {};          // external job ids
const today = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);

const isExt = (id) => /^xjob_/.test(String(id));
const idsOf = (list) => (list || []).map((j) => j.id || j.jobId || j.job_id);
/** Nothing external, and nothing the audit classified EXTERNAL, in a Jobs-page answer. */
function onlyTeamLink(ids, what) {
  for (const id of ids) {
    assert.ok(!isExt(id), `${what}: an external job (${id}) reached the Jobs page`);
    assert.notEqual(id, T.legacy, `${what}: the EXTERNAL-classified legacy row reached the Jobs page`);
  }
}

test('boot: TeamLink jobs A..., external jobs B...', async () => {
  dbh = await startTestDb(DB_PORT);
  applyTestEnv(dbh.url, {
    PUBLIC_ORIGIN: BASE, DISABLE_BACKGROUND_WORK: 'true', EXTERNAL_JOBS_ENABLED: 'true',
    EMAIL_SMTP_HOST: '', EMAIL_API_KEY: '', EMAILJS_SERVICE_ID: '', SMS_API_KEY: '', WHATSAPP_API_KEY: '',
    VOICE_RATE_LIMIT_MAX: '1000',
  });
  raw = (sql, p) => dbh.db.query(sql, p);
  await raw(`insert into companies (id, name) values ('co_s', 'Separation Client Co')`);

  const { hashPassword } = await import('../src/auth.js');
  const hash = await hashPassword('Separate123x');
  const au = (await raw(`insert into users (email,password_hash,role) values ('sep.admin@tl-sink.local',$1,'admin') returning id`, [hash])).rows[0].id;
  await raw(`insert into admins (id, name, email, user_id) values ('asep','Sep Admin','sep.admin@tl-sink.local',$1)`, [au]);
  const ru = (await raw(`insert into users (email,password_hash,role) values ('sep.rec@tl-sink.local',$1,'recruiter') returning id`, [hash])).rows[0].id;
  await raw(`insert into recruiters (id, name, email, company_id, user_id) values ('rsep','Sep Recruiter','sep.rec@tl-sink.local','co_s',$1)`, [ru]);

  const { createApp } = await import('../src/app.js');
  const app = createApp({ logger: { error() {}, log() {} } });
  await new Promise((r) => { server = app.listen(API_PORT, r); });

  admin = makeClient(BASE); await admin.get('/api/health');
  assert.equal((await admin.post('/api/auth/login', { email: 'sep.admin@tl-sink.local', password: 'Separate123x', role: 'admin' })).status, 200);
  rec = makeClient(BASE); await rec.get('/api/health');
  assert.equal((await rec.post('/api/auth/login', { email: 'sep.rec@tl-sink.local', password: 'Separate123x', role: 'recruiter' })).status, 200);
  anon = makeClient(BASE); await anon.get('/api/health');
  cand = makeClient(BASE); await cand.get('/api/health');
  const reg = await cand.post('/api/auth/register', {
    name: 'Sep Candidate', email: 'sep.cand@tl-sink.local', password: 'Separate123cand',
    preferredLocation: 'Hyderabad', expectedCtc: 5, noticePeriod: 'Immediate', preferredWorkModes: ['Hybrid'],
  });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  T.cand = reg.body.candidateId;
  await raw(`update candidates set skills = '{Python,Django}', technical_skills = '{Python,Django}', location = 'Hyderabad',
               title = 'Python Developer', preferred_role = 'Python Developer' where id = $1`, [T.cand]);
  const cu = (await raw(`select user_id from candidates where id = $1`, [T.cand])).rows[0].user_id;
  candSession = { userId: cu, role: 'candidate', profileId: T.cand };

  /* ---- TeamLink jobs, posted by the recruiter through the API ---- */
  const post = async (key, body) => {
    const r = await rec.post('/api/jobs', { companyId: 'co_s', status: 'open', type: 'Full-time', desc: `${body.title} - a TeamLink posting.`, ...body });
    assert.equal(r.status, 201, `${key}: ${JSON.stringify(r.body)}`);
    T[key] = r.body.job.id;
    return r.body.job;
  };
  /* Job A: same skill and city as B, a weaker match (one of three skills). */
  await post('A', { title: 'Python Engineer', location: 'Hyderabad', mode: 'Hybrid', exp: 'Fresher', skills: ['Python', 'Java', 'Spring'] });
  await post('wfh', { title: 'Python Support Analyst', location: 'Remote', mode: 'Remote', exp: '1-3 yrs', skills: ['Python'] });
  await post('urgent', { title: 'Python Data Engineer', location: 'Hyderabad', mode: 'Onsite', exp: '2-4 yrs', skills: ['Python', 'SQL'] });
  await post('java', { title: 'Java Developer', location: 'Bengaluru', mode: 'Onsite', exp: '3-5 yrs', skills: ['Java'] });
  await raw(`update jobs set urgent = true, urgent_until = now() + interval '3 days' where id = $1`, [T.urgent]);
  /* A walk-in, written the way the walk-in form's row ends up. */
  T.walkin = 'tl_walkin_sep';
  await raw(`insert into jobs (id, title, company_id, location, status, posting_kind, employment_type, walkin_date, walkin_from, walkin_to,
                               walkin_venue, skills, exp_label, published_at)
             values ($1, 'Python Walk-in Drive', 'co_s', 'Hyderabad', 'open', 'walkin', 'Walk-in', $2, '10:00', '23:59',
                     'TeamLink office', '{Python}', 'Fresher', now())`, [T.walkin, '2099-12-31']);

  /* A legacy row the 0113 audit would classify EXTERNAL (a `source` naming
     Naukri). Written as TeamLink (the trigger), then reclassified the one
     way the database allows. */
  T.legacy = 'legacy_naukri_sep';
  await raw(`insert into jobs (id, title, company_id, location, status, source, skills, exp_label, published_at)
             values ($1, 'Python Developer (legacy import)', 'co_s', 'Hyderabad', 'open', 'Naukri', '{Python,Django}', 'Fresher', now())`, [T.legacy]);
  assert.equal((await raw(`select job_source_reclassify($1, 'EXTERNAL', 'test: legacy Naukri row')`, [T.legacy])).rows[0].job_source_reclassify, 'EXTERNAL');

  /* ---- external jobs: a licensed Naukri feed, entered by hand ---- */
  const sid = 'naukri_sep';
  const src = { id: sid, name: 'Naukri', sourceType: 'partner_api', collectionMethod: 'manual', connector: 'naukri', applicationMethod: 'redirect' };
  assert.equal((await admin.post('/api/external/sources', { ...src, active: false })).status, 200);
  assert.equal((await admin.put(`/api/external/sources/${sid}/licence`, { collectionMethod: 'partner_feed',
    licenceStatus: 'active', consentStatus: 'granted', termsUrl: 'https://partner.example.org/naukri/terms',
    dataUsageAllowed: true, applicationRedirectAllowed: true, effectiveFrom: '2026-01-01', effectiveUntil: '2099-12-31',
    owner: 'TeamLink compliance', notes: 'test licence' })).status, 200);
  assert.equal((await admin.post('/api/external/sources', { ...src, active: true })).status, 200);
  const ext = [
    ['B', 'Python Developer', 'Hyderabad', ['Python', 'Django'], 'Fresher', 'Full-time'],
    ['Bwfh', 'Python Developer (Work from home)', 'Remote', ['Python', 'Django'], '1-3 yrs', 'Full-time'],
    ['Bwalk', 'Python Walk-in', 'Hyderabad', ['Python'], 'Fresher', 'Walk-in'],
    ['Burgent', 'Urgent Python Hiring', 'Hyderabad', ['Python'], '2-4 yrs', 'Full-time'],
  ];
  const j = await admin.post('/api/external/jobs', { sourceId: sid, jobs: ext.map(([k, title, location, skills, experience, employmentType]) => ({
    id: `NK-SEP-${k}`, title, company: 'Naukri Employer', location, skills, experience, employmentType,
    url: `https://www.naukri.com/job-listings-sep-${k.toLowerCase()}`, postedAt: new Date().toISOString(),
    description: `${title}: Python, Django. Immediate joining. Urgent hiring.` })) });
  assert.equal(j.body.saved, ext.length, JSON.stringify(j.body));
  j.body.jobs.forEach((x) => { X[x.sourceJobId.replace('NK-SEP-', '')] = x.id; });
  assert.ok(isExt(X.B));
});

test('schema: jobs carry source_type; new rows are TEAMLINK whatever the writer says; the audit is logged', async () => {
  const rows = (await raw(`select id, source_type from jobs order by id`)).rows;
  assert.ok(rows.length >= 6);
  for (const r of rows) assert.equal(r.source_type, r.id === T.legacy ? 'EXTERNAL' : 'TEAMLINK', r.id);
  /* The writer cannot set it, on insert or update. */
  await raw(`insert into jobs (id, title, status, source_type) values ('sep_try', 'Try', 'draft', 'EXTERNAL')`);
  assert.equal((await raw(`select source_type from jobs where id = 'sep_try'`)).rows[0].source_type, 'TEAMLINK');
  await raw(`update jobs set source_type = 'EXTERNAL' where id = $1`, [T.A]);
  assert.equal((await raw(`select source_type from jobs where id = $1`, [T.A])).rows[0].source_type, 'TEAMLINK');
  await raw(`delete from jobs where id = 'sep_try'`);
  /* The audit's name rule. */
  for (const s of ['Naukri', 'naukri.com', 'LinkedIn Jobs', 'Indeed', 'Shine', 'external feed']) {
    assert.equal((await raw(`select job_source_is_external_name($1) b`, [s])).rows[0].b, true, s);
  }
  for (const s of [null, '', 'intake', 'Manual', 'Bulk Import', 'Walk-in', 'Referral']) {
    assert.equal((await raw(`select job_source_is_external_name($1) b`, [s])).rows[0].b, false, String(s));
  }
  const log = (await raw(`select * from job_source_audit where job_id = $1`, [T.legacy])).rows;
  assert.ok(log.some((l) => l.source_type === 'EXTERNAL' && /legacy Naukri/.test(l.reason)));
  /* The administrator's audit. */
  const a = await admin.get('/api/admin/job-source-audit');
  assert.equal(a.status, 200, JSON.stringify(a.body));
  const tl = a.body.summary.find((x) => x.dataset === 'jobs' && x.sourceType === 'TEAMLINK');
  const xs = a.body.summary.find((x) => x.dataset === 'external_jobs');
  assert.ok(tl.total >= 5 && xs.sourceType === 'EXTERNAL' && xs.sourceName === 'Naukri' && xs.open === 4, JSON.stringify(a.body.summary));
  assert.equal((await cand.get('/api/admin/job-source-audit')).status, 403);
});

test('1. Jobs: A visible, B not - GET /api/jobs (visitor and candidate), GET /api/bootstrap', async () => {
  for (const [who, c] of [['visitor', anon], ['candidate', cand]]) {
    const r = await c.get('/api/jobs?limit=200');
    assert.equal(r.status, 200);
    const ids = idsOf(r.body.jobs);
    assert.ok(ids.includes(T.A), `${who}: A is listed`);
    onlyTeamLink(ids, `${who} GET /api/jobs`);
    assert.ok(r.body.jobs.every((x) => x.sourceType === 'TEAMLINK' && x.jobSourceType === 'TEAMLINK'));
    const b = await c.get('/api/bootstrap');
    onlyTeamLink(idsOf(b.body.data.jobs), `${who} bootstrap`);
    assert.ok(idsOf(b.body.data.jobs).includes(T.A));
  }
  /* The ATS keeps every row (staff), with the classification on it. */
  const all = await admin.get('/api/jobs?view=all&limit=200');
  const legacy = all.body.jobs.find((x) => x.id === T.legacy);
  assert.equal(legacy.sourceType, 'EXTERNAL');
  assert.equal(legacy.jobSourceType, 'NAUKRI');
  assert.equal(legacy.jobSourceName, 'Naukri');
  /* Explicitly TeamLink is fine; anything else is refused, never widened. */
  assert.equal((await anon.get('/api/jobs?sourceType=TEAMLINK')).status, 200);
  for (const bad of ['EXTERNAL', 'ALL', 'external']) {
    const r = await anon.get(`/api/jobs?sourceType=${bad}`);
    assert.equal(r.status, 400, bad);
    assert.equal(r.body.error.code, 'SOURCE_SCOPE');
  }
  assert.equal((await anon.get('/api/jobs?quick=fresher&sourceType=EXTERNAL')).status, 400);
});

test('2. External Jobs: B visible, A not - /api/portal/external-jobs, /external/recommended, /external/matches', async () => {
  const r = await anon.get('/api/portal/external-jobs?limit=500');
  const ids = idsOf(r.body.jobs);
  assert.ok(ids.includes(X.B));
  assert.ok(ids.every(isExt), 'only external ids');
  assert.ok(r.body.jobs.every((x) => x.sourceType === 'EXTERNAL' && x.jobSourceType === 'NAUKRI' && x.jobSourceName === 'Naukri'));
  assert.equal((await anon.get('/api/portal/external-jobs?sourceType=TEAMLINK')).status, 400);
  assert.equal((await anon.get(`/api/portal/external-jobs/${T.A}`)).status, 404, 'a TeamLink id is not an external job');

  assert.equal((await cand.post('/api/external/match', {})).status, 200);
  const rec2 = await cand.get('/api/external/recommended?pageSize=50');
  assert.equal(rec2.status, 200, JSON.stringify(rec2.body));
  const rids = rec2.body.jobs.map((m) => m.externalJobId);
  assert.ok(rids.includes(X.B), JSON.stringify(rids));
  assert.ok(rids.every(isExt));
  assert.ok(rec2.body.jobs.every((m) => !m.job || m.job.sourceType === 'EXTERNAL'));
  const m = await cand.get('/api/external/matches?limit=50');
  assert.ok(m.body.matches.every((x) => isExt(x.externalJobId)));
  assert.equal((await cand.get('/api/external/recommended?sourceType=TEAMLINK')).status, 400);
});

test('3 + 4. Search "Python", "Hyderabad Python": TeamLink jobs only', async () => {
  const py = await anon.get('/api/jobs?q=Python&limit=200');
  onlyTeamLink(idsOf(py.body.jobs), 'q=Python');
  assert.ok(idsOf(py.body.jobs).includes(T.A));
  assert.ok(!idsOf(py.body.jobs).includes(T.java));
  const hyd = await anon.get('/api/jobs?q=Python&location=Hyderabad&limit=200');
  const ids = idsOf(hyd.body.jobs);
  onlyTeamLink(ids, 'q=Python&location=Hyderabad');
  assert.ok(ids.includes(T.A) && ids.includes(T.urgent) && !ids.includes(T.wfh), JSON.stringify(ids));
  /* The same words on the external side find B there, and only there. */
  const xq = await anon.get('/api/portal/external-jobs?q=python&location=Hyderabad');
  assert.ok(idsOf(xq.body.jobs).includes(X.B) && idsOf(xq.body.jobs).every(isExt));
});

test('5. AI recommendations: B scores higher than A, and is still never recommended on Jobs (scoped before scoring)', async () => {
  const { matchJobs } = await import('../src/jobs/source-scope.js');
  const tl = await matchJobs({ session: candSession, candidateId: T.cand, sourceType: 'TEAMLINK' });
  const tlIds = tl.matches.map((x) => x.jobId);
  assert.ok(tlIds.includes(T.A));
  onlyTeamLink(tlIds, 'matchJobs(TEAMLINK)');
  assert.equal(tl.considered, tlIds.length, 'only TeamLink jobs were ever scored');
  const a = tl.matches.find((x) => x.jobId === T.A);

  const ex = await matchJobs({ session: candSession, candidateId: T.cand, sourceType: 'EXTERNAL' });
  assert.equal(ex.sourceType, 'EXTERNAL');
  const stored = (await raw(`select external_job_id, match_percentage from candidate_external_job_matches where candidate_id = $1`, [T.cand])).rows;
  const b = stored.find((x) => x.external_job_id === X.B);
  assert.ok(b, 'B is scored in the external scope');
  assert.ok(Number(b.match_percentage) > Number(a.score), `B (${b.match_percentage}) out-scores A (${a.score})`);
  assert.ok(stored.every((x) => isExt(x.external_job_id)), 'the external scope scores external jobs only');

  /* A matcher with no scope is refused, not defaulted. */
  await assert.rejects(() => matchJobs({ session: candSession, candidateId: T.cand }), /sourceType/);

  /* The Jobs page's match reasons: B and the legacy row are not scored. */
  const r = await cand.get(`/api/job-matches/explain?jobIds=${[T.A, X.B, T.legacy].join(',')}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.matches.map((x) => x.jobId), [T.A]);
  assert.deepEqual(r.body.missing.sort(), [X.B, T.legacy].sort());
  assert.equal((await cand.get(`/api/job-matches/explain?jobIds=${T.A}&sourceType=EXTERNAL`)).status, 400);
});

test('6-9. Chips Fresher, Work from home, Urgent hiring, Walk-in (and every other chip): TeamLink jobs only', async () => {
  const want = { fresher: T.A, wfh: T.wfh, urgent: T.urgent, walkin: T.walkin };
  for (const [chip, id] of Object.entries(want)) {
    const r = await anon.get(`/api/jobs?quick=${chip}&limit=200`);
    assert.equal(r.status, 200, chip);
    const ids = idsOf(r.body.jobs);
    assert.ok(ids.includes(id), `${chip}: ${JSON.stringify(ids)}`);
    onlyTeamLink(ids, `chip ${chip}`);
  }
  for (const chip of ['immediate', 'today', 'salary3', 'walkin_today', 'walkin_week', 'internship']) {
    const r = await anon.get(`/api/jobs?quick=${chip}&ids=1`);
    assert.equal(r.status, 200, chip);
    onlyTeamLink(r.body.ids, `chip ${chip}`);
  }
  const near = await cand.get('/api/jobs?quick=near_me&near=Hyderabad&ids=1');
  onlyTeamLink(near.body.ids, 'chip near_me');
});

test('10 + 11. Natural-language and voice search: parsed first, then TeamLink jobs only', async () => {
  for (const text of ['show me fresher Python jobs in Hyderabad', 'Python jobs in Hyderabad']) {
    for (const c of [anon, cand]) {
      const r = await c.post('/api/search/voice-parse', { text, lang: 'en-IN' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const ids = r.body.semantic.results.map((x) => x.jobId);
      assert.ok(ids.length > 0, `${text}: something found`);
      assert.ok(ids.includes(T.A), `${text}: ${JSON.stringify(ids)}`);
      onlyTeamLink(ids, `"${text}"`);
      const again = await c.post('/api/search/semantic', { search: r.body.search });
      onlyTeamLink(again.body.semantic.results.map((x) => x.jobId), 'semantic re-rank');
    }
  }
  assert.equal((await anon.post('/api/search/voice-parse', { text: 'Python jobs', sourceType: 'EXTERNAL' })).status, 400);
});

test('12 + 13. Pagination and infinite scroll: no external job on any page', async () => {
  const total = (await anon.get('/api/jobs?limit=1')).body.total;
  const seen = [];
  for (let off = 0; off < total + 2; off += 1) {
    const p = await anon.get(`/api/jobs?limit=1&offset=${off}`);
    seen.push(...idsOf(p.body.jobs));
  }
  assert.equal(seen.length, total);
  onlyTeamLink(seen, 'paged /api/jobs');
  /* "Load more" on a chip list, two at a time. */
  const chipTotal = (await anon.get('/api/jobs?quick=salary3,fresher&limit=2')).body.total;
  const more = [];
  for (let off = 0; off < Math.max(chipTotal, 1) + 2; off += 2) more.push(...idsOf((await anon.get(`/api/jobs?quick=fresher&limit=2&offset=${off}`)).body.jobs));
  onlyTeamLink(more, 'paged chips');
});

test('14 + 15. The recommended count and the filter counts are TeamLink jobs', async () => {
  const open = (await raw(`select count(*)::int n from jobs_open`)).rows[0].n;
  const tlOpen = (await raw(`select count(*)::int n from jobs where status='open' and not paused and not archived and source_type='TEAMLINK'`)).rows[0].n;
  assert.equal(open, tlOpen, 'jobs_open is TeamLink jobs only');
  const b = await cand.get('/api/bootstrap');
  const open2 = b.body.data.jobs.filter((x) => x.status === 'open');
  assert.equal(open2.length, tlOpen, 'the candidate recommendation pool = TeamLink open jobs');
  const hyd = (await anon.get('/api/jobs?location=Hyderabad&limit=200')).body;
  const tlHyd = (await raw(`select count(*)::int n from jobs_open where location ilike '%Hyderabad%'`)).rows[0].n;
  assert.equal(hyd.total, tlHyd, '"Hyderabad (n)" counts TeamLink jobs');
  const fresh = (await anon.get('/api/jobs?quick=fresher&ids=1')).body;
  assert.equal(fresh.total, fresh.ids.length);
  onlyTeamLink(fresh.ids, 'fresher count');
});

test('16. A saved search made on Jobs stores TEAMLINK, and stays TeamLink-only when run later', async () => {
  const s = await cand.post('/api/saved-searches', { filters: { q: 'Python', loc: 'Hyderabad' }, alert_frequency: 'daily' });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  assert.equal(s.body.savedSearch.sourceType, 'TEAMLINK');
  assert.equal((await raw(`select source_type from candidate_saved_searches where id = $1`, [s.body.savedSearch.id])).rows[0].source_type, 'TEAMLINK');
  /* The same filters saved for External Jobs are another search, kept EXTERNAL. */
  const e = await cand.post('/api/saved-searches', { filters: { q: 'Python', loc: 'Hyderabad' }, alert_frequency: 'off', sourceType: 'EXTERNAL', label: 'External Python' });
  assert.equal(e.status, 201, JSON.stringify(e.body));
  assert.equal(e.body.savedSearch.sourceType, 'EXTERNAL');
  /* Its page cannot be changed afterwards. */
  const ch = await cand.put(`/api/saved-searches/${s.body.savedSearch.id}`, { sourceType: 'EXTERNAL', label: 'x' });
  assert.equal(ch.status, 400);
  assert.equal(ch.body.error.code, 'SOURCE_SCOPE');

  /* Run later: new jobs on both sides; each search counts its own side only. */
  await raw(`update candidate_saved_searches set last_viewed_at = now() - interval '1 hour' where candidate_id = $1`, [T.cand]);
  const list = (await cand.get('/api/saved-searches')).body.savedSearches;
  const tl = list.find((x) => x.id === s.body.savedSearch.id);
  const ex = list.find((x) => x.id === e.body.savedSearch.id);
  const tlWant = (await raw(`select count(*)::int n from jobs_open where location ilike '%Hyderabad%'
                              and (title ilike '%python%' or 'Python' = any(skills)) and published_at > now() - interval '1 hour'`)).rows[0].n;
  assert.equal(tl.newCount, tlWant, `TeamLink saved search: ${tl.newCount} (TeamLink jobs only)`);
  assert.ok(ex.newCount >= 1, 'the External saved search counts external jobs');
  assert.ok(ex.newCount <= 3, 'and only those (3 external Python jobs in Hyderabad)');

  /* The alert engine: the TeamLink job reaches the TeamLink search, never the External one. */
  const { runSavedSearchInstant } = await import('../src/notify/saved-search-alerts.js');
  await runSavedSearchInstant(T.A);
  const hits = (await raw(`select saved_search_id, job_id from candidate_saved_search_hits`)).rows;
  assert.ok(hits.some((h) => h.saved_search_id === s.body.savedSearch.id && h.job_id === T.A));
  assert.ok(!hits.some((h) => h.saved_search_id === e.body.savedSearch.id), 'no TeamLink job for an External search');
  await runSavedSearchInstant(T.legacy);
  assert.ok(!(await raw(`select 1 from candidate_saved_search_hits where job_id = $1`, [T.legacy])).rows.length, 'the EXTERNAL-classified row alerts nobody');
});

test('17. A job a recruiter posts is TEAMLINK automatically and appears on Jobs', async () => {
  /* Even if the request claims otherwise: the recruiter never chooses. */
  const r = await rec.post('/api/jobs', { companyId: 'co_s', status: 'open', title: 'Python Trainee', location: 'Hyderabad',
    skills: ['Python'], source: 'Naukri', sourceType: 'EXTERNAL', desc: 'A new TeamLink posting.' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.job.sourceType, 'TEAMLINK');
  T.fresh = r.body.job.id;
  assert.equal((await raw(`select source_type from jobs where id = $1`, [T.fresh])).rows[0].source_type, 'TEAMLINK');
  assert.ok(idsOf((await anon.get('/api/jobs?q=Python&limit=200')).body.jobs).includes(T.fresh));
  assert.ok(!idsOf((await anon.get('/api/portal/external-jobs?q=trainee')).body.jobs).includes(T.fresh));
  /* An administrator's posting too. */
  const a = await admin.post('/api/jobs', { companyId: 'co_s', status: 'open', title: 'Admin Python Role', location: 'Hyderabad', skills: ['Python'] });
  assert.equal(a.status, 201);
  assert.equal(a.body.job.sourceType, 'TEAMLINK');
});

test('18. A new import is EXTERNAL automatically, keeps its source name, and appears ONLY on External Jobs', async () => {
  const j = await admin.post('/api/external/jobs', { sourceId: 'naukri_sep', jobs: [{ id: 'NK-SEP-NEW', title: 'Python Backend (import)',
    company: 'Naukri Employer', location: 'Hyderabad', skills: ['Python'], url: 'https://www.naukri.com/job-listings-sep-new',
    postedAt: new Date().toISOString() }] });
  assert.equal(j.body.saved, 1);
  const id = j.body.jobs[0].id;
  assert.ok(isExt(id));
  assert.equal((await raw(`select count(*)::int n from jobs where id = $1 or title = 'Python Backend (import)'`, [id])).rows[0].n, 0, 'nothing written to jobs');
  const d = await anon.get(`/api/portal/external-jobs/${id}`);
  assert.equal(d.status, 200);
  assert.equal(d.body.job.sourceType, 'EXTERNAL');
  assert.equal(d.body.job.jobSourceName, 'Naukri');
  assert.ok(idsOf((await anon.get('/api/portal/external-jobs?limit=500')).body.jobs).includes(id));
  onlyTeamLink(idsOf((await anon.get('/api/jobs?q=Python&limit=200')).body.jobs), 'after an import');
  onlyTeamLink(idsOf((await cand.get('/api/bootstrap')).body.data.jobs), 'bootstrap after an import');
});

test('11 (details). Job details stay in their dataset; applying stays in its flow', async () => {
  assert.equal((await anon.get(`/api/jobs/${T.A}`)).body.job.sourceType, 'TEAMLINK');
  assert.equal((await anon.get(`/api/jobs/${X.B}`)).status, 404, 'an external id is not a TeamLink job');
  assert.equal((await cand.get(`/api/jobs/${T.legacy}`)).status, 404, 'the EXTERNAL-classified row is not on Jobs');
  assert.equal((await admin.get(`/api/jobs/${T.legacy}`)).body.job.sourceType, 'EXTERNAL', 'the ATS still has it');
  const ap = await cand.post('/api/applications', { jobId: T.legacy });
  assert.equal(ap.status, 409, 'no TeamLink application to an EXTERNAL job');
  const ok = await cand.post('/api/applications', { jobId: T.A });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
});

test('the career assistant searches TeamLink jobs only', async () => {
  const { withUser } = await import('../src/db.js');
  const { reads } = await import('../src/ai/career-assistant-tools.js');
  const out = await withUser(candSession, (c) => reads.searchOpenJobs(c, { query: 'Python', limit: 10 }));
  const ids = out.jobs.map((x) => x.job_id);
  assert.ok(ids.length > 0);
  onlyTeamLink(ids, 'career assistant');
});

test('teardown', async () => {
  await new Promise((r) => server.close(r));
  const { closePool } = await import('../src/db.js');
  await closePool().catch(() => {});
  await dbh.stop();
});
