/**
 * External jobs compliance (migration 0108, master prompt points 14-62).
 *
 * Licences and the activation guard, the quality gate and quarantine, URL
 * changes, closure and the grace period, health / backoff / alerts, empty
 * and failed syncs, concurrency and quota, the provider contract (every
 * adapter against a local mock), ranked search with filters and pagination,
 * the cache, the four analytics events, admin visibility and bulk actions
 * with audit, saved external jobs, roles, and the feature flag.
 *
 * NOTHING LEAVES THE MACHINE. Every provider host is answered by a local
 * mock HTTP server on a free port; the test's fetch refuses any other
 * non-local destination, and the redirect is read from the Location header,
 * never followed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { startTestDb, applyTestEnv, makeClient } from './harness.mjs';

const DB_PORT = 5465;
const API_PORT = 9985;
const BASE = `http://127.0.0.1:${API_PORT}`;
const ENGINE = { userId: '', role: 'admin', profileId: null };

let dbh, server, mock, mockPort, raw, admin, recruiter, cand, cand2, anon;
let svc, cx, contract, quality, cfgMod;
const calls = [];
const refused = [];
const mode = {};               // host -> 'ok' | 'error500' | 'badjson' | 'slow' | 'empty'
const feed = { naukri: [] };
const ids = {};

const day = 86400000;
const ago = (d) => new Date(Date.now() - d * day).toISOString();
const count = async (sql, p) => Number((await raw(sql, p)).rows[0].n);
const go = (id, qs = '') => fetch(`${BASE}/api/portal/external-jobs/${id}/apply${qs}`, { redirect: 'manual' });
const list = (qs) => realFetch(`${BASE}/api/portal/external-jobs?${qs}`).then(async (r) => ({ ...(await r.json()), cache: r.headers.get('x-cache') }));
const events = async () => Object.fromEntries((await raw(
  `select event, sum(n)::int n from external_job_events group by 1`)).rows.map((r) => [r.event, r.n]));

/* ---- every provider, answered locally ---------------------------------- */
const PAYLOAD = {
  'remotive.com': () => ({ jobs: [{ id: 101, title: 'Python Developer', company_name: 'Acme Remote',
    candidate_required_location: 'India', description: '<p>Build APIs in Python and Django for clients.</p>',
    job_type: 'full_time', publication_date: '2026-10-01T00:00:00', url: 'https://remotive.com/remote-jobs/software-dev/python-developer-101',
    tags: ['python'] }] }),
  'api.adzuna.com': () => ({ results: [{ id: 'a1', title: 'Data Analyst', company: { display_name: 'Adz Co' },
    location: { display_name: 'Pune, Maharashtra' }, description: 'Analyse sales data with SQL and Excel dashboards.',
    salary_min: 400000, salary_max: 600000, contract_time: 'full_time', created: '2026-10-02T00:00:00Z',
    redirect_url: 'https://www.adzuna.in/land/ad/1' }] }),
  'jooble.org': () => ({ jobs: [{ id: 'j1', title: 'Staff Nurse', company: 'Care Hospital', location: 'Hyderabad',
    snippet: 'ICU nursing role with rotating shifts and benefits.', salary: '₹3-4 LPA', type: 'Full-time',
    updated: '2026-10-03T00:00:00', link: 'https://jooble.org/desc/1', source: 'jooble' }] }),
  'jsearch.p.rapidapi.com': () => ({ data: [{ job_id: 'js1', job_title: 'Java Developer', employer_name: 'JS Corp',
    job_city: 'Bengaluru', job_state: 'Karnataka', job_country: 'IN', job_description: 'Spring Boot microservices development work.',
    job_employment_type: 'FULLTIME', job_posted_at_datetime_utc: '2026-10-03T00:00:00Z',
    job_apply_link: 'https://careers.jscorp-testing.in/java', job_publisher: 'LinkedIn' }] }),
  'serpapi.com': () => ({ jobs_results: [{ job_id: 'sp1', title: 'Accountant', company_name: 'Ledger Ltd',
    location: 'Chennai, Tamil Nadu', description: 'Tally, GST filing and month-end close for clients.', via: 'via Naukri.com',
    detected_extensions: { schedule_type: 'Full-time' }, apply_options: [{ link: 'https://www.naukri.com/job-listings-accountant-1' }] }] }),
  'api.lever.co': () => ([{ id: 'lv1', text: 'QA Engineer', categories: { location: 'Pune', commitment: 'Full-time', team: 'QA' },
    descriptionPlain: 'Test automation with Playwright and continuous integration.', createdAt: 1759300000000,
    hostedUrl: 'https://jobs.lever.co/levco/lv1' }]),
  'boards-api.greenhouse.io': () => ({ jobs: [{ id: 9, title: 'Site Engineer', location: { name: 'Hyderabad, India' },
    content: '&lt;p&gt;Run the Hyderabad site build.&lt;/p&gt;', updated_at: '2026-10-01T00:00:00Z',
    absolute_url: 'https://boards.greenhouse.io/ghco/jobs/9' }] }),
};

async function startMock() {
  const srv = createServer((req, res) => {
    calls.push(req.url);
    const send = (code, body, type = 'application/json') => { res.writeHead(code, { 'content-type': type }); res.end(body); };
    let m = /^\/__ext\/([^/]+)(\/.*)?$/.exec(req.url);
    if (req.url.startsWith('/feed/')) m = [null, 'feed', req.url];
    if (!m) return send(404, '{}');
    const host = m[1];
    const how = mode[host] || 'ok';
    const answer = () => {
      if (how === 'error500') return send(500, '{"error":"upstream down"}');
      if (how === 'badjson') return send(200, '<html>not json</html>', 'text/html');
      if (how === 'empty') return send(200, host === 'feed' ? '{"jobs":[]}' : '{}');
      if (host === 'feed') return send(200, JSON.stringify({ jobs: feed.naukri }));
      const p = PAYLOAD[host];
      return p ? send(200, JSON.stringify(p())) : send(404, '{}');
    };
    if (how === 'slow') setTimeout(answer, 2500); else answer();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return srv;
}

const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : (input && input.url) || String(input);
  if (/^http:\/\/127\.0\.0\.1[:/]/.test(url)) return realFetch(input, init);
  const m = /^https:\/\/([^/]+)(\/.*)?$/.exec(url);
  if (m && PAYLOAD[m[1]]) return realFetch(`http://127.0.0.1:${mockPort}/__ext/${m[1]}${m[2] || ''}`, init);
  refused.push(url);
  return Promise.reject(new Error(`test refused an outbound call to ${url}`));
};

/* A Naukri partner-feed posting. */
const nk = (n, extra = {}) => ({
  id: `NK-${n}`, title: `Role ${n}`, company: `Employer ${n}`, location: 'Hyderabad',
  description: `A real description for role ${n}, long enough to be useful.`,
  skills: ['Java'], employmentType: 'Full-time', postedAt: ago(1),
  applicationUrl: `https://www.naukri.com/job-listings-role-${n}`, ...extra,
});

const FULL_LICENCE = {
  collectionMethod: 'partner_feed', licenceStatus: 'active', consentStatus: 'granted',
  termsUrl: 'https://partner.example.org/terms', dataUsageAllowed: true, applicationRedirectAllowed: true,
  effectiveFrom: '2026-01-01', effectiveUntil: '2099-12-31', owner: 'TeamLink compliance', notes: 'test',
};

async function user(role, table, id, email, extra = '') {
  const { hashPassword } = await import('../src/auth.js');
  const u = (await raw(`insert into users (email,password_hash,role) values ($1,$2,$3) returning id`,
    [email, await hashPassword('Compliance123x'), role])).rows[0].id;
  if (table === 'admins') await raw(`insert into admins (id, name, email, user_id) values ($1,'Comp Admin',$2,$3)`, [id, email, u]);
  if (table === 'recruiters') await raw(`insert into recruiters (id, user_id, name, email, company_id) values ($1,$2,'Comp Rec',$3,'co_c')`, [id, u, email]);
  const c = makeClient(BASE); await c.get('/api/health');
  const r = await c.post('/api/auth/login', { email, password: 'Compliance123x', role });
  assert.equal(r.status, 200, `${role} login ${JSON.stringify(r.body)}${extra}`);
  return c;
}

test('boot', async () => {
  mock = await startMock();
  mockPort = mock.address().port;
  dbh = await startTestDb(DB_PORT);
  applyTestEnv(dbh.url, {
    PUBLIC_ORIGIN: BASE, DISABLE_BACKGROUND_WORK: 'true', EXTERNAL_JOBS_ENABLED: 'true',
    EMAIL_SMTP_HOST: '', EMAIL_API_KEY: '', EMAILJS_SERVICE_ID: '',
    EXTERNAL_FETCH_TIMEOUT_MS: '1000', EXTERNAL_FETCH_RETRIES: '0',
    EXTERNAL_SOURCE_UNHEALTHY_AFTER: '2', EXTERNAL_PORTAL_CACHE_SECONDS: '60',
    /* Test values for the keyed connectors - they only ever reach the mock. */
    ADZUNA_APP_ID: 'test-id', ADZUNA_APP_KEY: 'test-key', JOOBLE_API_KEY: 'test-key',
    JSEARCH_RAPIDAPI_KEY: 'test-key', SERPAPI_KEY: 'test-key',
  });
  raw = (sql, p) => dbh.db.query(sql, p);
  await raw(`insert into companies (id, name) values ('co_c', 'Compliance Client')`);

  const { createApp } = await import('../src/app.js');
  const app = createApp({ logger: { error() {}, log() {} } });
  await new Promise((r) => { server = app.listen(API_PORT, r); });

  svc = await import('../src/external/service.js');
  cx = await import('../src/external/compliance-store.js');
  contract = await import('../src/external/provider-contract.js');
  quality = await import('../src/external/quality.js');
  cfgMod = await import('../src/config.js');

  admin = await user('admin', 'admins', 'acx', 'comp.admin@tl-sink.local');
  recruiter = await user('recruiter', 'recruiters', 'rcx', 'comp.rec@tl-sink.local');
  anon = makeClient(BASE); await anon.get('/api/health');
  for (const [k, email] of [['cand', 'comp.cand@tl-sink.local'], ['cand2', 'comp.cand2@tl-sink.local']]) {
    const c = makeClient(BASE); await c.get('/api/health');
    const reg = await c.post('/api/auth/register', { name: `Comp ${k}`, email, password: 'Compliance123c',
      preferredLocation: 'Hyderabad', expectedCtc: 5, noticePeriod: 'Immediate', preferredWorkModes: ['Hybrid'] });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    c.id = reg.body.candidateId;
    if (k === 'cand') cand = c; else cand2 = c;
  }
});

/* ======================================================================= */
test('database: tables, constraints, indexes', async () => {
  for (const t of ['external_source_licences', 'external_audit_log', 'external_job_url_changes',
    'external_job_quarantine', 'external_job_events', 'external_saved_jobs']) {
    assert.equal(await count(`select count(*) n from information_schema.tables where table_name = $1`, [t]), 1, t);
  }
  for (const i of ['external_jobs_updated_idx', 'external_jobs_source_status_idx', 'xaudit_at_idx', 'xquar_open_idx']) {
    assert.equal(await count(`select count(*) n from pg_indexes where indexname = $1`, [i]), 1, i);
  }
  await assert.rejects(raw(`insert into job_sources (id, name, provider) values ('bad_p', 'Bad', 'scraper')`), /check/i);
  await raw(`insert into job_sources (id, name) values ('db_s', 'DB Source')`);
  await raw(`insert into external_jobs (id, source_id, external_job_id, title) values ('xjob_db1','db_s','E1','T')`);
  await assert.rejects(raw(`insert into external_jobs (id, source_id, external_job_id, title) values ('xjob_db2','db_s','E1','T')`),
    /unique|duplicate/i, 'one row per source job id');
  await raw(`update external_jobs set status = 'archived' where id = 'xjob_db1'`);
  await assert.rejects(raw(`update external_jobs set status = 'bogus' where id = 'xjob_db1'`), /check/i);
  const h = (await raw(`select content_hash from external_jobs where id = 'xjob_db1'`)).rows[0].content_hash;
  assert.match(h, /^[0-9a-f]{32}$/, 'content hash maintained');
  assert.equal((await raw(`select provider from job_sources where id = 'db_s'`)).rows[0].provider, 'other');
  await raw(`delete from job_sources where id = 'db_s'`);
});

/* ======================================================================= */
test('licences: a partner source cannot be switched on without one', async () => {
  const body = { id: 'nk_feed', name: 'Naukri partner feed', sourceType: 'partner_api', collectionMethod: 'feed',
    applicationMethod: 'redirect', feedUrl: `http://127.0.0.1:${mockPort}/feed/naukri`, active: true };
  const refusedOn = await admin.post('/api/external/sources', body);
  assert.equal(refusedOn.status, 409);
  assert.equal(refusedOn.body.error.code, 'LICENCE_REQUIRED');
  assert.match(refusedOn.body.error.message, /licence record/);

  const off = await admin.post('/api/external/sources', { ...body, active: false });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.equal(off.body.source.provider, 'naukri', 'the name says Naukri, so it IS Naukri');

  /* Only an administrator records a licence. */
  assert.equal((await recruiter.put('/api/external/sources/nk_feed/licence', FULL_LICENCE)).status, 403);
  assert.equal((await cand.put('/api/external/sources/nk_feed/licence', FULL_LICENCE)).status, 403);
  assert.equal((await anon.put('/api/external/sources/nk_feed/licence', FULL_LICENCE)).status, 401);

  const partial = await admin.put('/api/external/sources/nk_feed/licence', { ...FULL_LICENCE, licenceStatus: 'pending', owner: '' });
  assert.equal(partial.status, 200, JSON.stringify(partial.body));
  assert.match(partial.body.licenceGap, /licence status "active".*owner/);
  assert.equal((await admin.post('/api/external/sources', body)).status, 409, 'an incomplete licence still refuses');

  const full = await admin.put('/api/external/sources/nk_feed/licence', FULL_LICENCE);
  assert.equal(full.body.licenceGap, null);
  const on = await admin.post('/api/external/sources', body);
  assert.equal(on.status, 200, JSON.stringify(on.body));
  assert.equal(on.body.source.active, true);

  /* The Naukri CONNECTOR is never an authorized mechanism, licence or not. */
  await admin.post('/api/external/sources', { id: 'nk_conn2', name: 'Naukri connector', collectionMethod: 'connector',
    connector: 'naukri', applicationMethod: 'redirect', active: false });
  await admin.put('/api/external/sources/nk_conn2/licence', FULL_LICENCE);
  const conn = await admin.post('/api/external/sources', { id: 'nk_conn2', name: 'Naukri connector',
    collectionMethod: 'connector', connector: 'naukri', applicationMethod: 'redirect', active: true });
  assert.equal(conn.status, 409);
  assert.match(conn.body.error.message, /no authorized API/);

  /* Keyed APIs need their terms on record; public boards need nothing. */
  const adz = await admin.post('/api/external/sources', { id: 'adz', name: 'Adzuna', collectionMethod: 'connector',
    connector: 'adzuna', applicationMethod: 'redirect', active: true });
  assert.equal(adz.status, 409);
  for (const [id, c] of [['rem', 'remotive'], ['lev', 'lever'], ['ghs', 'greenhouse']]) {
    const s = await admin.post('/api/external/sources', { id, name: `Public ${c}`, collectionMethod: 'connector',
      connector: c, applicationMethod: 'redirect', active: true });
    assert.equal(s.status, 200, `${c}: ${JSON.stringify(s.body)}`);
  }

  /* The audit trail has all of it. */
  const a = await admin.get('/api/external/audit?entityId=nk_feed');
  const acts = a.body.entries.map((e) => e.action);
  for (const want of ['source.create', 'licence.create', 'licence.change', 'source.activate']) {
    assert.ok(acts.includes(want), `${want} audited (${acts.join(', ')})`);
  }
  assert.equal((await recruiter.get('/api/external/audit')).status, 403, 'the audit trail is admin only');
  const listed = await admin.get('/api/external/sources');
  const row = listed.body.sources.find((s) => s.id === 'nk_feed');
  assert.equal(row.licence.licenceStatus, 'active');
  assert.equal(row.policy.kind, 'partner_feed');
  assert.deepEqual(row.policy.allowedDomains, ['naukri.com']);
  assert.equal(JSON.stringify(listed.body).includes('credential_env'), false);
});

/* ======================================================================= */
test('sync: validation, quarantine, dedupe, health', async () => {
  feed.naukri = [
    nk(1), nk(2), nk(3), nk(4), nk(5),
    nk(1),                                                            // the same posting twice
    nk(6, { applicationUrl: 'javascript:alert(1)' }),
    nk(7, { applicationUrl: 'https://not-naukri.example-jobs.in/7' }), // wrong domain for Naukri
    nk(8, { company: '' }),
    nk(9, { description: 'Short.' }),
    nk(10, { postedAt: new Date(Date.now() + 30 * day).toISOString() }),
    { title: 'No id at all', company: 'X', applicationUrl: 'https://www.naukri.com/x', description: 'A description long enough.' },
  ];
  const out = await admin.post('/api/external/sources/nk_feed/sync');
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.status, 'ok');
  /* The posting with no id is keyed by its canonical URL - stored, not refused. */
  assert.equal(out.body.created, 6);
  assert.equal(out.body.quarantined, 5);
  assert.equal(out.body.health.status, 'healthy');
  assert.equal(await count(`select count(*) n from external_jobs where source_id = 'nk_feed'`), 6);
  const urlKeyed = (await raw(`select external_job_id, canonical_url from external_jobs where title = 'No id at all'`)).rows;
  assert.equal(urlKeyed.length, 1);
  assert.match(urlKeyed[0].external_job_id, /^url:[0-9a-f]{32}$/);
  assert.equal(urlKeyed[0].canonical_url, 'https://naukri.com/x');
  const again = await admin.post('/api/external/sources/nk_feed/sync');
  assert.equal(again.body.created, 0, 'a repeat sync creates nothing');
  assert.equal(await count(`select count(*) n from external_jobs where source_id = 'nk_feed'`), 6, 'and no duplicate');

  const q = (await recruiter.get('/api/external/quarantine?sourceId=nk_feed')).body.items;
  const reasons = Object.fromEntries(q.map((x) => [x.sourceJobId || x.title, x.reasons]));
  assert.deepEqual(reasons['NK-6'], ['invalid_url']);
  assert.deepEqual(reasons['NK-7'], ['domain_not_allowed']);
  assert.deepEqual(reasons['NK-8'], ['missing_company']);
  assert.deepEqual(reasons['NK-9'], ['description_unusable']);
  assert.deepEqual(reasons['NK-10'], ['posted_in_future']);
  assert.ok(q.every((x) => x.action === 'quarantined'));

  const run = (await raw(`select * from external_sync_runs where source_id = 'nk_feed' order by id desc limit 1`)).rows[0];
  assert.equal(run.provider, 'naukri');
  assert.equal(run.quarantined, 5);
  assert.equal(run.created, 0, 'the latest run is the repeat');
  assert.ok(run.duration_ms >= 0);
  assert.match(run.error_summary, /5 posting\(s\) quarantined/);

  ids.nk = Object.fromEntries((await raw(`select external_job_id, id from external_jobs where source_id='nk_feed'`)).rows
    .map((r) => [r.external_job_id, r.id]));
  const audit = (await admin.get(`/api/external/audit?entityId=${ids.nk['NK-1']}`)).body.entries;
  assert.ok(audit.some((e) => e.action === 'job.create'));
});

test('sync: an update, a URL change (valid and invalid), a fixed posting, closure after the grace period', async () => {
  feed.naukri = [
    nk(1, { applicationUrl: 'https://www.naukri.com/job-listings-role-1-moved' }),   // valid change
    nk(2, { applicationUrl: 'https://evil.example-phish.in/role-2' }),              // invalid change
    nk(3, { title: 'Role 3 (Senior)' }),
    nk(5),
    nk(8),                                                                           // now has a company
  ];
  const out = await admin.post('/api/external/sources/nk_feed/sync');
  assert.equal(out.body.status, 'ok', JSON.stringify(out.body));
  assert.equal(out.body.urlChanges, 2);

  const changes = (await recruiter.get('/api/external/url-changes')).body.changes;
  const c1 = changes.find((c) => c.jobId === ids.nk['NK-1']);
  assert.equal(c1.applied, true);
  assert.equal(c1.newUrlValid, true);
  assert.equal(c1.oldUrl, 'https://www.naukri.com/job-listings-role-1');
  const c2 = changes.find((c) => c.jobId === ids.nk['NK-2']);
  assert.equal(c2.applied, false, 'an invalid new link is not applied');
  assert.equal(c2.newUrlValid, false);
  assert.equal((await go(ids.nk['NK-2'])).headers.get('location'), 'https://www.naukri.com/job-listings-role-2', 'the old link stays');
  assert.equal((await go(ids.nk['NK-1'])).headers.get('location'), 'https://www.naukri.com/job-listings-role-1-moved');

  const acts = (await admin.get('/api/external/audit?entity=external_job&limit=200')).body.entries;
  assert.ok(acts.some((e) => e.action === 'job.url_change' && e.entityId === ids.nk['NK-1']));
  assert.ok(acts.some((e) => e.action === 'job.url_change_refused' && e.entityId === ids.nk['NK-2']));
  assert.ok(acts.some((e) => e.action === 'job.update' && e.entityId === ids.nk['NK-3']
    && e.newValue.fields.includes('title')));

  const q8 = (await recruiter.get('/api/external/quarantine?sourceId=nk_feed&all=true')).body.items.find((x) => x.sourceJobId === 'NK-8');
  assert.ok(q8.resolvedAt, 'a posting that now passes leaves quarantine');
  assert.equal(await count(`select count(*) n from external_jobs where source_id='nk_feed' and external_job_id='NK-8'`), 1);

  /* NK-4 was not in this run. Unseen for longer than the grace period
     AND the source has succeeded since -> closed, never deleted. NK-2 was
     not saved this run either (its new link was refused), so it ages the
     same way. NK-5 was seen. */
  await raw(`update external_jobs set synced_at = now() - interval '20 days'
              where source_id = 'nk_feed' and external_job_id in ('NK-4', 'NK-2')`);
  const closed = await svc.closeStalePostings(ENGINE);
  assert.equal(closed, 2);
  const st = Object.fromEntries((await raw(`select external_job_id, status from external_jobs where source_id='nk_feed'`)).rows
    .map((r) => [r.external_job_id, r.status]));
  assert.equal(st['NK-4'], 'closed');
  assert.equal(st['NK-5'], 'open');
  const page = await realFetch(`${BASE}/api/portal/external-jobs/${ids.nk['NK-4']}`).then((r) => r.json());
  assert.equal(page.job.status, 'CLOSED', 'a closed job still has a page that says so');
  assert.equal((await go(ids.nk['NK-4'])).status, 410);
  const a = (await admin.get(`/api/external/audit?entityId=${ids.nk['NK-4']}`)).body.entries;
  assert.ok(a.some((e) => e.action === 'job.close'));
});

test('a failed or empty sync never wipes jobs; health, backoff and one alert', async () => {
  const before = await count(`select count(*) n from external_jobs where source_id='nk_feed' and status='open'`);
  mode.feed = 'error500';
  const f1 = await admin.post('/api/external/sources/nk_feed/sync');
  assert.equal(f1.body.status, 'failed');
  assert.equal(f1.body.health.status, 'degraded');
  assert.ok(f1.body.health.nextSyncAfter, 'backoff set');
  const f2 = await admin.post('/api/external/sources/nk_feed/sync');
  assert.equal(f2.body.health.status, 'unhealthy');
  await admin.post('/api/external/sources/nk_feed/sync');
  const alerts = await count(`select count(*) n from notifications where recipient_id='acx' and type='EXTERNAL_SOURCE_UNHEALTHY'`);
  assert.equal(alerts, 1, 'one alert, not one per failure');
  assert.equal(await count(`select count(*) n from external_jobs where source_id='nk_feed' and status='open'`), before);

  /* Long outage: every job unseen for weeks, but no success since - none closed. */
  await raw(`update job_sources set last_success_started_at = now() - interval '40 days' where id = 'nk_feed'`);
  await raw(`update external_jobs set synced_at = now() - interval '30 days' where source_id = 'nk_feed' and status = 'open'`);
  assert.equal(await svc.closeStalePostings(ENGINE), 0, 'a source that is down keeps its jobs');

  /* The scheduler waits out the backoff; a person pressing Sync does not. */
  const sched = await svc.syncSource(ENGINE, 'nk_feed', { scheduled: true });
  assert.equal(sched.status, 'backoff');

  mode.feed = 'empty';
  const e = await admin.post('/api/external/sources/nk_feed/sync');
  assert.equal(e.body.status, 'empty');
  assert.equal(await count(`select count(*) n from external_jobs where source_id='nk_feed' and status='open'`), before);
  assert.equal(await svc.closeStalePostings(ENGINE), 0, 'an empty answer is not a success');

  mode.feed = 'ok';
  feed.naukri = [nk(1, { applicationUrl: 'https://www.naukri.com/job-listings-role-1-moved' }), nk(3, { title: 'Role 3 (Senior)' }), nk(5), nk(8)];
  const ok = await admin.post('/api/external/sources/nk_feed/sync');
  assert.equal(ok.body.status, 'ok');
  assert.equal(ok.body.health.status, 'healthy');
  assert.equal(await count(`select count(*) n from notifications where recipient_id='acx' and type='EXTERNAL_SOURCE_RECOVERED'`), 1);
  const h = (await recruiter.get('/api/external/health')).body.sources.find((s) => s.id === 'nk_feed');
  assert.equal(h.consecutiveFailures, 0);
  assert.ok(h.successCount >= 3 && h.failureCount >= 4, JSON.stringify(h));
  assert.ok(h.lastSuccessfulSync && h.averageSyncDurationMs != null && h.jobCount >= 4);
});

test('one sync per source at a time, a timeout, and the monthly quota', async () => {
  mode.feed = 'slow';
  const [a, b] = await Promise.all([admin.post('/api/external/sources/nk_feed/sync'), admin.post('/api/external/sources/nk_feed/sync')]);
  assert.deepEqual([a.body.status, b.body.status].sort(), ['already_running', 'ok']);
  mode.feed = 'ok';

  /* Remotive through its connector, answering too slowly. */
  mode['remotive.com'] = 'slow';
  const t = await admin.post('/api/external/sources/rem/sync');
  assert.equal(t.body.status, 'failed');
  assert.match(t.body.error, /no response within/);
  const run = (await raw(`select error_summary from external_sync_runs where source_id='rem' order by id desc limit 1`)).rows[0];
  assert.match(run.error_summary, /timeout/);
  mode['remotive.com'] = 'ok';

  const cfg = await admin.put('/api/external/sources/nk_feed/config', { monthlyQuota: 1 });
  assert.equal(cfg.status, 200, JSON.stringify(cfg.body));
  await raw(`update job_sources set monthly_used = 1, quota_reset_at = now() + interval '10 days' where id = 'nk_feed'`);
  const q = await admin.post('/api/external/sources/nk_feed/sync');
  assert.equal(q.body.status, 'quota_exhausted');
  await admin.put('/api/external/sources/nk_feed/config', { monthlyQuota: null });
});

test('a licence that expires switches its source off, keeping the history', async () => {
  const jobs = await count(`select count(*) n from external_jobs where source_id='nk_feed'`);
  await raw(`update external_source_licences set effective_until = current_date - 1 where source_id = 'nk_feed'`);
  const off = await cx.enforceLicences(ENGINE);
  assert.deepEqual(off.map((x) => x.source_id), ['nk_feed']);
  const s = (await raw(`select active, disabled_reason from job_sources where id='nk_feed'`)).rows[0];
  assert.equal(s.active, false);
  assert.match(s.disabled_reason, /licence.*expired/);
  assert.equal(await count(`select count(*) n from external_jobs where source_id='nk_feed'`), jobs, 'history kept');
  const listed = await list('source=nk_feed');
  assert.equal(listed.total, 0, 'a switched-off source is not shown');
  const sync = await admin.post('/api/external/sources/nk_feed/sync');
  assert.equal(sync.body.status, 'licence_required');
  const a = (await admin.get('/api/external/audit?entityId=nk_feed&action=source.deactivate')).body.entries;
  assert.equal(a.length, 1);
  /* Renewed: back on. */
  await admin.put('/api/external/sources/nk_feed/licence', FULL_LICENCE);
  assert.equal((await admin.post('/api/external/sources', { id: 'nk_feed', name: 'Naukri partner feed', sourceType: 'partner_api',
    collectionMethod: 'feed', applicationMethod: 'redirect', feedUrl: `http://127.0.0.1:${mockPort}/feed/naukri`, active: true })).status, 200);
});

/* ======================================================================= */
test('provider contract: every adapter, against the mock', async () => {
  const before = calls.length;
  for (const p of contract.ALL_PROVIDERS()) {
    for (const fn of ['fetchJobs', 'normalizeJob', 'validateJob', 'getSourceMetadata']) {
      assert.equal(typeof p[fn], 'function', `${p.id}.${fn}`);
    }
    const meta = p.getSourceMetadata();
    assert.equal(meta.id, p.id);
    assert.ok(meta.mechanism && meta.kind && meta.status, `${p.id} metadata`);
    assert.equal(JSON.stringify(meta).includes('test-key'), false, `${p.id}: no secret in metadata`);
  }

  /* The boards with no public API fetch nothing and say what they need. */
  for (const id of ['naukri', 'indeed', 'shine', 'linkedin']) {
    const p = contract.providerFor(id);
    assert.equal(p.getSourceMetadata().status, 'needs_authorized_feed_and_licence');
    const out = await p.fetchJobs({ query: 'java' });
    assert.equal(out.status, 'not_configured');
    assert.deepEqual(out.jobs, []);
  }
  assert.equal(calls.length, before, 'no network call for a partner-only board');
  assert.equal(refused.length, 0);

  /* Each connector: fetch -> normalise -> validate. */
  const want = { remotive: 'Python Developer', adzuna: 'Data Analyst', jooble: 'Staff Nurse', jsearch: 'Java Developer',
    serpapi: 'Accountant', lever: 'QA Engineer', greenhouse: 'Site Engineer' };
  for (const [id, title] of Object.entries(want)) {
    const p = contract.providerFor(id);
    const out = await p.fetchJobs({ query: 'x', boards: [{ platform: id, board_token: id === 'lever' ? 'levco' : 'ghco', active: true }] });
    assert.equal(out.status, 'ok', `${id}: ${out.error}`);
    assert.equal(out.jobs[0].title, title, id);
    const job = p.normalizeJob(out.jobs[0], { id: `src_${id}` });
    assert.equal(job.title, title);
    assert.ok(job.applicationUrl, `${id} keeps its original URL`);
    /* JSearch and SerpApi link to employers' own sites: their links are
       usable only once an administrator approves the domains. */
    const domains = { jsearch: ['jscorp-testing.in'], serpapi: ['naukri.com'] }[id];
    const v = p.validateJob(job, out.jobs[0], { id: `src_${id}`, connector: id, ...(domains ? { allowed_domains: domains } : {}) });
    if (domains) {
      const bare = p.validateJob(job, out.jobs[0], { id: `src_${id}`, connector: id });
      assert.deepEqual(quality.reasonCodes(bare), ['domain_not_allowed'], `${id} without approved domains`);
    }
    assert.equal(v.ok, true, `${id}: ${JSON.stringify(v.issues)}`);
  }
  /* serpapi's posting is published on Naukri - attributed, not claimed. */
  const sp = await contract.providerFor('serpapi').fetchJobs({ query: 'x' });
  assert.equal(sp.jobs[0].originalPublisher, 'Naukri.com');

  /* Errors are statuses, never exceptions; one failing leaves the rest. */
  mode['api.adzuna.com'] = 'error500';
  mode['jooble.org'] = 'badjson';
  const a = await contract.providerFor('adzuna').fetchJobs({ query: 'x' });
  const j = await contract.providerFor('jooble').fetchJobs({ query: 'x' });
  const r = await contract.providerFor('remotive').fetchJobs({ query: 'x' });
  assert.equal(a.status, 'failed'); assert.match(a.error, /HTTP 500/);
  assert.equal(j.status, 'failed'); assert.match(j.error, /not JSON/);
  assert.equal(r.status, 'ok', 'the others still work');
  delete mode['api.adzuna.com']; delete mode['jooble.org'];

  /* An authorized feed is the Naukri mechanism. */
  const viaFeed = await contract.providerFor('naukri').fetchJobs({ source: { active: true, job_collection_method: 'feed',
    feed_url: `http://127.0.0.1:${mockPort}/feed/naukri` } });
  assert.equal(viaFeed.status, 'ok');

  /* URL handling. */
  const nkP = contract.providerFor('naukri');
  const base = nkP.normalizeJob(nk(1), { id: 's' });
  const code = (url) => quality.reasonCodes(nkP.validateJob({ ...base, applicationUrl: url }, nk(1, { applicationUrl: url }), { id: 's' }));
  assert.deepEqual(code('https://www.naukri.com/x'), []);
  assert.deepEqual(code('https://naukri.com.evil.in/x'), ['domain_not_allowed']);
  assert.deepEqual(code('http://10.1.2.3/x'), ['invalid_url']);
  assert.deepEqual(code('http://www.naukri.com/x'), ['not_https'], 'https only');
  assert.deepEqual(code(null), ['missing_url']);
  assert.equal(refused.length, 0, 'nothing tried to reach the internet');

  const provs = await recruiter.get('/api/external/providers');
  assert.equal(provs.status, 200);
  assert.equal(provs.body.providers.find((x) => x.id === 'greenhouse').preserveBehaviour, true);
  assert.equal((await cand.get('/api/external/providers')).status, 403);
});

/* ======================================================================= */
test('search: ranking, filters, pagination, freshness - and TeamLink search untouched', async () => {
  const s = await admin.post('/api/external/sources', { id: 'rank', name: 'Ranking Board', collectionMethod: 'manual',
    applicationMethod: 'redirect', active: true });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  /* No approved domain yet: the jobs list, but their links are unavailable. */
  assert.equal((await admin.put('/api/external/sources/rank/config', { allowedDomains: ['rankingboard-testing.in'] })).status, 200);
  const u = (n) => `https://careers.rankingboard-testing.in/jobs/${n}`;
  const jobs = [
    { id: 'r1', title: 'Java Developer', company: 'Rank One', location: 'Hyderabad', skills: ['Java', 'SQL'],
      experience: '2-5 yrs', salary: '₹6-9 LPA', employmentType: 'Full-time', postedAt: ago(1), url: u(1), description: 'Backend work.' },
    { id: 'r2', title: 'Senior Java Developer', company: 'Rank Two', location: 'Pune', skills: ['Java', 'Spring'],
      experience: '5-8 yrs', salary: '₹15-20 LPA', employmentType: 'Full-time', postedAt: ago(10), url: u(2), description: 'Lead a team.' },
    { id: 'r3', title: 'Backend Engineer', company: 'Rank Three', location: 'Bengaluru', skills: ['Java', 'Kotlin'],
      experience: '3-6 yrs', employmentType: 'Contract', postedAt: ago(2), url: u(3), description: 'Services.' },
    { id: 'r4', title: 'Data Analyst', company: 'Rank Four', location: 'Pune', skills: ['SQL', 'Python'],
      experience: '1-3 yrs', salary: '₹4-6 LPA', employmentType: 'Part-time', postedAt: ago(40), url: u(4),
      description: 'Some Java scripting is a plus.' },
    { id: 'r5', title: 'Python Developer', company: 'Rank Five', location: 'Remote - India', skills: ['Python', 'Django'],
      experience: '2-4 yrs', salary: '₹8-12 LPA', employmentType: 'Full-time', postedAt: ago(5), url: u(5), description: 'APIs.' },
  ];
  const saved = await admin.post('/api/external/jobs', { sourceId: 'rank', jobs });
  assert.equal(saved.body.saved, 5);
  ids.rank = Object.fromEntries(saved.body.jobs.map((j) => [j.sourceJobId, j.id]));
  const titles = (o) => o.jobs.map((j) => j.title);

  const java = await list('source=rank&q=java');
  assert.deepEqual(titles(java), ['Java Developer', 'Senior Java Developer', 'Backend Engineer', 'Data Analyst']);
  assert.ok(java.jobs.every((j, i, a) => i === 0 || a[i - 1].rank >= j.rank), 'ranks never increase');
  assert.deepEqual(titles(await list('source=rank&q=java')), titles(java), 'deterministic');
  assert.equal((await list('source=rank&q=Java%20Developer')).jobs[0].title, 'Java Developer', 'an exact title first');

  const set = (o) => titles(o).sort();
  assert.deepEqual(set(await list('source=rank&location=Pune')), ['Data Analyst', 'Python Developer', 'Senior Java Developer']);
  assert.deepEqual(set(await list('source=rank&employmentType=full%20time')), ['Java Developer', 'Python Developer', 'Senior Java Developer']);
  assert.deepEqual(set(await list('source=rank&experience=3')), ['Backend Engineer', 'Data Analyst', 'Java Developer', 'Python Developer']);
  assert.deepEqual(set(await list('source=rank&salaryMin=1000000')), ['Python Developer', 'Senior Java Developer']);
  assert.deepEqual(set(await list('source=rank&skills=python')), ['Data Analyst', 'Python Developer']);
  assert.deepEqual(set(await list('source=rank&postedWithinDays=7')), ['Backend Engineer', 'Java Developer', 'Python Developer']);
  assert.equal((await list('provider=other&source=rank')).total, 5);
  assert.equal((await list('provider=naukri&source=rank')).total, 0);

  /* Pagination walks one stable order (newest first) without overlap. */
  const pages = [];
  for (const off of [0, 2, 4]) pages.push(await list(`source=rank&limit=2&offset=${off}`));
  assert.deepEqual(pages.map((p) => p.jobs.length), [2, 2, 1]);
  assert.ok(pages.every((p) => p.total === 5));
  assert.deepEqual(pages.flatMap(titles), ['Java Developer', 'Backend Engineer', 'Python Developer', 'Senior Java Developer', 'Data Analyst']);

  /* Freshness, origin and provider on every row. */
  const one = (await list('source=rank&q=Java%20Developer')).jobs[0];
  assert.equal(one.origin, 'EXTERNAL');
  assert.equal(one.provider, 'OTHER');
  assert.equal(one.freshness.postedDaysAgo, 1);
  assert.equal(one.freshness.stale, false);

  /* Too-old postings, when the deployment sets a limit. */
  cfgMod.config.externalJobs.maxAgeDays = 30;
  assert.equal((await list('source=rank')).total, 4);
  cfgMod.config.externalJobs.maxAgeDays = null;

  /* TeamLink search is its own, and the two never mix. */
  await raw(`insert into jobs (id, title, company_id, location, status, published_at, skills) values ('tl_java','Java Lead','co_c','Hyderabad','open',now(), '{Java}')`);
  const tl = await realFetch(`${BASE}/api/jobs?q=Java`).then((r) => r.json());
  const tlIds = (tl.jobs || []).map((j) => j.id);
  assert.ok(tlIds.includes('tl_java'), JSON.stringify(tl).slice(0, 200));
  assert.equal(tlIds.some((x) => /^xjob_/.test(x)), false, 'no external job in the TeamLink list');
  assert.equal((await list('q=java&limit=500')).jobs.some((j) => j.id === 'tl_java'), false, 'no TeamLink job in the external list');
});

test('cache: a repeat is served from it, any change invalidates it', async () => {
  const a = await list('source=rank&limit=50');
  const b = await list('source=rank&limit=50');
  assert.equal(b.cache, 'hit');
  assert.deepEqual(b.jobs.map((j) => j.id), a.jobs.map((j) => j.id));
  await raw(`update external_jobs set status = 'closed' where id = $1`, [ids.rank.r5]);
  const c = await list('source=rank&limit=50');
  assert.equal(c.cache, 'miss');
  assert.equal(c.jobs.some((j) => j.id === ids.rank.r5), false, 'gone on the next request');
  await raw(`update external_jobs set status = 'open' where id = $1`, [ids.rank.r5]);
});

/* ======================================================================= */
test('apply: backend-controlled redirect, four analytics events, no application', async () => {
  const apps = await count(`select count(*) n from applications`);
  const e0 = await events();
  const r1 = ids.rank.r1;
  await realFetch(`${BASE}/api/portal/external-jobs/${r1}`);                     // a view
  const res = await go(r1, '?url=https://evil.example.com/steal');
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), 'https://careers.rankingboard-testing.in/jobs/1', '?url= is ignored');
  const e1 = await events();
  const d = (k) => (e1[k] || 0) - (e0[k] || 0);
  assert.equal(d('external_job_view'), 1);
  assert.equal(d('external_apply_click'), 1);
  assert.equal(d('external_redirect_success'), 1);

  /* Allowed domains, set on the source, are enforced at the redirect. */
  assert.equal((await admin.put('/api/external/sources/rank/config', { allowedDomains: ['other-site-testing.in'] })).status, 200);
  const bad = await go(r1);
  assert.equal(bad.status, 422);
  assert.equal(bad.headers.get('location'), null);
  assert.equal((await raw(`select count(*)::int n from external_job_events where event='external_redirect_failure' and reason='domain_not_allowed'`)).rows[0].n, 1);
  assert.equal(await count(`select count(*) n from notifications where recipient_id='acx' and type='EXTERNAL_REDIRECT_FAILURE'`), 1);
  const badCand = await cand.post('/api/external/apply', { externalJobId: r1 });
  assert.equal(badCand.status, 422);
  assert.equal((await admin.put('/api/external/sources/rank/config', { allowedDomains: ['rankingboard-testing.in'] })).status, 200);

  /* The listing hands the browser the validated original URL to open
     directly - or nothing, with the reason as a state. */
  const listed = (await list('source=rank&limit=50')).jobs.find((j) => j.id === r1);
  assert.equal(listed.originalJobUrl, 'https://careers.rankingboard-testing.in/jobs/1');
  assert.equal(listed.applyLink, 'available');
  assert.equal(listed.jobSourceType, 'OTHER_EXTERNAL');
  assert.equal(listed.jobSourceName, 'Ranking Board');
  assert.equal(listed.externalJobId, 'r1');
  assert.equal(listed.externalStatus, 'Active');
  for (const k of ['canonicalJobUrl', 'sourcePostedDate', 'collectedAt', 'lastExternalSyncAt', 'lastExternalUpdateAt']) assert.ok(listed[k], k);
  await raw(`update external_jobs set application_url = 'http://careers.rankingboard-testing.in/jobs/1' where id = $1`, [r1]);
  const insecure = (await list('source=rank&limit=50')).jobs.find((j) => j.id === r1);
  assert.equal(insecure.originalJobUrl, null, 'an http link is never handed out');
  assert.equal(insecure.applyLink, 'link_unavailable');
  await raw(`update external_jobs set application_url = 'https://careers.rankingboard-testing.in/jobs/1' where id = $1`, [r1]);

  /* A visitor's click: counted, nobody identified, no application. */
  const before = await count(`select coalesce(sum(n),0) n from external_job_events where event = 'external_apply_click'`);
  const click = await realFetch(`${BASE}/api/portal/external-jobs/${r1}/click`, { method: 'POST' }).then((x) => x.json());
  assert.equal(click.status, 'Apply Clicked');
  assert.ok(await count(`select coalesce(sum(n),0) n from external_job_events where event = 'external_apply_click'`) > before);

  /* The signed-in flow: a click record, never a TeamLink application. */
  const ok = await cand.post('/api/external/apply', { externalJobId: r1 });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.application.status, 'clicked');
  assert.equal(ok.body.application.statusLabel, 'Apply Clicked', 'a click is "Apply Clicked", never "Applied"');
  assert.equal(ok.body.applyUrl, 'https://careers.rankingboard-testing.in/jobs/1');
  assert.equal(await count(`select count(*) n from applications`), apps, 'no TeamLink application');
  assert.equal(await count(`select count(*) n from external_applications where external_job_id = $1`, [r1]), 1);

  const an = await recruiter.get('/api/external/analytics?days=7');
  assert.equal(an.status, 200);
  assert.deepEqual(Object.keys(an.body.totals).sort(),
    ['external_apply_click', 'external_job_view', 'external_redirect_failure', 'external_redirect_success']);
  assert.ok(an.body.totals.external_redirect_success >= 2);
  assert.equal(JSON.stringify(an.body).includes('application_submitted'), false);
  assert.equal(await count(`select count(*) n from notifications where type ilike '%application_submitted%'`), 0);
  assert.equal(await count(`select count(*) n from external_job_events where event not like 'external_%'`), 0);
  assert.equal(JSON.stringify((await raw(`select * from external_job_events`)).rows).includes(cand.id), false, 'no candidate in the events');
  assert.equal((await cand.get('/api/external/analytics')).status, 403);
});

/* ======================================================================= */
test('admin: every field, and bulk actions with confirmation, counts and audit', async () => {
  const all = await recruiter.get('/api/external/admin/jobs?sourceId=rank&limit=50');
  assert.equal(all.status, 200);
  assert.equal(all.body.total, 5);
  for (const k of ['id', 'jobType', 'source', 'sourceJobId', 'originalJobUrl', 'sourceCompanyUrl', 'lastSyncedAt',
    'lastSeenAt', 'syncStatus', 'status', 'active']) {
    assert.ok(k in all.body.jobs[0], k);
  }
  assert.equal((await cand.get('/api/external/admin/jobs')).status, 403);
  const ghJob = (await recruiter.get('/api/external/admin/jobs?sourceId=ghs')).body;
  assert.equal(ghJob.total, 0);

  const target = [ids.rank.r2, ids.rank.r3];
  const body = { action: 'close', ids: [...target, 'xjob_nope'], reason: 'filled' };
  assert.equal((await recruiter.post('/api/external/admin/jobs/bulk', { ...body, confirm: true })).status, 403);
  assert.equal((await admin.post('/api/external/admin/jobs/bulk', body)).status, 400, 'confirmation required');
  const closed = await admin.post('/api/external/admin/jobs/bulk', { ...body, confirm: true });
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  assert.deepEqual([closed.body.requested, closed.body.succeeded, closed.body.failed], [3, 2, 1]);
  assert.equal(closed.body.results.find((r) => r.id === 'xjob_nope').reason, 'not found');
  assert.equal((await list('source=rank')).total, 3);

  /* Re-sending the posting (a re-sync) cannot reopen what an admin closed. */
  await admin.post('/api/external/jobs', { sourceId: 'rank', jobs: [{ id: 'r2', title: 'Senior Java Developer', company: 'Rank Two',
    location: 'Pune', url: 'https://careers.rankingboard-testing.in/jobs/2', description: 'Lead a team.' }] });
  assert.equal((await raw(`select status from external_jobs where id=$1`, [ids.rank.r2])).rows[0].status, 'closed');

  const audit = (await admin.get('/api/external/audit?action=bulk.')).body.entries;
  assert.ok(audit.some((e) => e.action === 'bulk.close' && e.newValue.succeeded === 2 && e.reason === 'filled'));

  /* Activate: refused for a posting whose link cannot be followed. */
  await raw(`update external_jobs set application_url = 'http://192.168.0.9/x' where id = $1`, [ids.rank.r3]);
  const act = await admin.post('/api/external/admin/jobs/bulk', { action: 'activate', ids: target, confirm: true });
  assert.deepEqual([act.body.succeeded, act.body.failed], [1, 1]);
  assert.match(act.body.results.find((r) => r.id === ids.rank.r3).reason, /cannot be followed/);
  assert.equal((await raw(`select status, admin_hold from external_jobs where id=$1`, [ids.rank.r2])).rows[0].status, 'open');

  for (const [action, status] of [['deactivate', 'removed'], ['archive', 'archived']]) {
    const o = await admin.post('/api/external/admin/jobs/bulk', { action, ids: [ids.rank.r4], confirm: true });
    assert.equal(o.body.succeeded, 1);
    assert.equal((await raw(`select status from external_jobs where id=$1`, [ids.rank.r4])).rows[0].status, status);
  }
  const ref = await admin.post('/api/external/admin/jobs/bulk', { action: 'refresh', ids: [ids.nk['NK-1']], confirm: true });
  assert.equal(ref.status, 200);
  assert.equal(ref.body.succeeded, 1, JSON.stringify(ref.body));
});

/* ======================================================================= */
test('saved external jobs: kept, a closed one says so, never silently removed', async () => {
  const id = ids.rank.r1;
  assert.equal((await cand.put(`/api/external/saved/${id}`)).status, 200);
  assert.equal((await cand.put(`/api/external/saved/xjob_nope`)).status, 404);
  assert.equal((await recruiter.put(`/api/external/saved/${id}`)).status, 403);
  let s = (await cand.get('/api/external/saved')).body.saved;
  assert.equal(s.length, 1);
  assert.equal(s[0].available, true);
  assert.equal(s[0].job.title, 'Java Developer');

  await admin.post('/api/external/admin/jobs/bulk', { action: 'close', ids: [id], confirm: true });
  s = (await cand.get('/api/external/saved')).body.saved;
  assert.equal(s.length, 1, 'still saved');
  assert.equal(s[0].available, false);
  assert.equal(s[0].job.status, 'CLOSED');
  assert.equal((await cand2.get('/api/external/saved')).body.saved.length, 0, 'nobody else sees it');

  assert.equal((await cand.del(`/api/external/saved/${id}`)).status, 200);
  assert.equal((await cand.get('/api/external/saved')).body.saved.length, 0);
});

/* ======================================================================= */
test('the feature flag: off means none of it exists', async () => {
  const hook = process.execArgv.filter((a) => a.startsWith('--import'));
  const code = `
    process.env.EXTERNAL_JOBS_ENABLED = 'false';
    const { createApp } = await import(${JSON.stringify(new URL('../src/app.js', import.meta.url).href)});
    const app = createApp({ logger: { error() {}, log() {} } });
    const srv = app.listen(0, '127.0.0.1', async () => {
      const port = srv.address().port;
      const out = [];
      for (const p of ['/api/portal/external-jobs', '/api/external/providers', '/api/external/saved']) {
        out.push((await fetch('http://127.0.0.1:' + port + p)).status);
      }
      console.log(JSON.stringify(out));
      srv.close(); process.exit(0);
    });`;
  const out = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...hook, '--input-type=module', '-e', code], {
      env: { ...process.env, EXTERNAL_JOBS_ENABLED: 'false', DISABLE_BACKGROUND_WORK: 'true' } });
    let txt = '';
    child.stdout.on('data', (d) => { txt += d; });
    child.stderr.on('data', () => {});
    child.on('exit', () => resolve(txt));
    child.on('error', reject);
  });
  assert.deepEqual(JSON.parse(out.trim().split('\n').pop()), [404, 404, 404]);
});

test('teardown', async () => {
  assert.equal(refused.length, 0, `outbound calls refused: ${refused.join(', ')}`);
  await new Promise((r) => server.close(r));
  const { closePool } = await import('../src/db.js');
  await closePool();
  await dbh.stop();
  await new Promise((r) => mock.close(r));
});
