/**
 * GREENHOUSE IS UNCHANGED — proved, not asserted.
 *
 * The owner's standing rule is "DO NOT CHANGE GREENHOUSE". The external-jobs
 * compliance work (migration 0108) touches files Greenhouse jobs pass through
 * on their way to the portal - the sync loop, the portal listing, the redirect
 * - so "we did not edit connectors.js" is not enough. This test records what
 * the Greenhouse integration PRODUCES, end to end, and compares it to a
 * snapshot that was written from the code as it was BEFORE that work began
 * (main at 9f2cd98):
 *
 *   1. the connector itself - fetchJobs() and collectViaConnector() - and the
 *      normaliser's output for every posting;
 *   2. a real sync through the API into a real (PGlite) database: every stored
 *      column of every row, the sync response, the sync-run rows and the
 *      source's last-sync fields;
 *   3. a re-sync of the same board (idempotent), a re-sync where the board
 *      changed (a title, a URL, a posting taken down), and the stale-posting
 *      sweep;
 *   4. what the portal shows: the listing, each details page, and where Apply
 *      Now sends a visitor (302 Location, or the refusal status).
 *
 * NOTHING LEAVES THE MACHINE. Greenhouse's public board API is answered by a
 * local mock HTTP server from a fixture in Greenhouse's documented shape; the
 * test's fetch refuses every other non-local destination outright.
 *
 * To re-record (only ever from unchanged Greenhouse code):
 *     UPDATE_GREENHOUSE_SNAPSHOT=1 node --test test/external-greenhouse-snapshot.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { startTestDb, applyTestEnv, makeClient } from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(readFileSync(join(HERE, 'fixtures/greenhouse-board.json'), 'utf8'));
const SNAPSHOT = join(HERE, 'fixtures/greenhouse-snapshot.json');
const UPDATE = process.env.UPDATE_GREENHOUSE_SNAPSHOT === '1';

const DB_PORT = 5466;
const API_PORT = 9986;
const MOCK_PORT = 9863;
const BASE = `http://127.0.0.1:${API_PORT}`;
const GH = 'https://boards-api.greenhouse.io';

let dbh, server, mock, raw, admin;
let round = 'round1';
const calls = [];
const shot = {};

/* ---- the mock Greenhouse board API ------------------------------------ */
async function startMock() {
  const srv = createServer((req, res) => {
    calls.push(req.url);
    const m = /^\/v1\/boards\/([^/]+)\/jobs\?content=true$/.exec(req.url);
    const board = m ? FIXTURE[round][decodeURIComponent(m[1])] : null;
    if (!board) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"status":404,"error":"Job not found"}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(board));
  });
  await new Promise((r) => srv.listen(MOCK_PORT, '127.0.0.1', r));
  return srv;
}

/* ---- no real provider is ever called ---------------------------------- */
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : (input && input.url) || String(input);
  if (url.startsWith(GH)) return realFetch(`http://127.0.0.1:${MOCK_PORT}${url.slice(GH.length)}`, init);
  if (/^http:\/\/127\.0\.0\.1[:/]/.test(url)) return realFetch(input, init);
  return Promise.reject(new Error(`test refused an outbound call to ${url}`));
};

const iso = (v) => (v == null ? null : new Date(v).toISOString());
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o == null ? undefined : o[k]]));
/* The keys the portal returned before 0108. New keys may be added beside
   them; these must not change. */
const PORTAL_KEYS = ['jobType', 'title', 'company', 'location', 'experience', 'salary', 'salaryMin',
  'salaryMax', 'skills', 'description', 'employmentType', 'education', 'postedAt', 'status',
  'source', 'sourceName', 'publisher'];
const SYNC_KEYS = ['ok', 'status', 'saved', 'skipped', 'linked', 'error'];

async function capture() {
  const rows = (await raw(`
    select j.*, d.external_job_id as dup_of
      from external_jobs j left join external_jobs d on d.id = j.duplicate_of
     order by j.external_job_id`)).rows;
  const jobs = rows.map((r) => ({
    external_job_id: r.external_job_id, title: r.title, company: r.company, location: r.location,
    description: r.description, skills: r.skills, experience: r.experience,
    exp_min: r.exp_min, exp_max: r.exp_max, salary: r.salary, salary_min: r.salary_min,
    salary_max: r.salary_max, employment_type: r.employment_type, industry: r.industry,
    education: r.education, application_url: r.application_url, apply_email: r.apply_email,
    posted_at: iso(r.posted_at), status: r.status, dedupe_key: r.dedupe_key, raw: r.raw,
    original_publisher: r.original_publisher, city: r.city, state: r.state, country: r.country,
    duplicate_of: r.dup_of || null,
  }));
  const source = (await raw(`select active, last_sync_status, last_sync_error, last_sync_job_count
                               from job_sources where id = 'gh_src'`)).rows[0];
  const runs = (await raw(`select kind, status, fetched, created, updated, closed, duplicates, skipped, error
                             from external_sync_runs order by id`)).rows;
  const listing = await realFetch(`${BASE}/api/portal/external-jobs?limit=500`).then((r) => r.json());
  const portal = { total: listing.total, jobs: listing.jobs.map((j) => pick(j, PORTAL_KEYS)) };
  const pages = {};
  const applyNow = {};
  for (const r of rows) {
    const d = await realFetch(`${BASE}/api/portal/external-jobs/${r.id}`);
    const body = await d.json();
    pages[r.external_job_id] = { http: d.status, job: body.job ? pick(body.job, PORTAL_KEYS) : null };
    const a = await realFetch(`${BASE}/api/portal/external-jobs/${r.id}/apply`, { redirect: 'manual' });
    applyNow[r.external_job_id] = { http: a.status, location: a.headers.get('location') };
  }
  return JSON.parse(JSON.stringify({ jobs, source, runs, portal, pages, applyNow }));
}

test('boot', async () => {
  mock = await startMock();
  dbh = await startTestDb(DB_PORT);
  applyTestEnv(dbh.url, {
    PUBLIC_ORIGIN: BASE, DISABLE_BACKGROUND_WORK: 'true', EXTERNAL_JOBS_ENABLED: 'true',
    EMAIL_SMTP_HOST: '', EMAIL_API_KEY: '', EMAILJS_SERVICE_ID: '',
  });
  raw = (sql, p) => dbh.db.query(sql, p);

  const { hashPassword } = await import('../src/auth.js');
  const hash = await hashPassword('Greenhouse123snap');
  const u = (await raw(`insert into users (email,password_hash,role) values ('gh.admin@tl-sink.local',$1,'admin') returning id`, [hash])).rows[0].id;
  await raw(`insert into admins (id, name, email, user_id) values ('aghs','GH Admin','gh.admin@tl-sink.local',$1)`, [u]);

  const { createApp } = await import('../src/app.js');
  const app = createApp({ logger: { error() {}, log() {} } });
  await new Promise((r) => { server = app.listen(API_PORT, r); });
  admin = makeClient(BASE); await admin.get('/api/health');
  assert.equal((await admin.post('/api/auth/login', { email: 'gh.admin@tl-sink.local', password: 'Greenhouse123snap', role: 'admin' })).status, 200);

  /* Two candidates, so the sync asks with more than one search term - the
     path a live deployment takes. */
  for (const [n, title, skills] of [['One', 'Backend Engineer', ['Java', 'Kotlin']], ['Two', 'Data Analyst', ['SQL']]]) {
    const c = makeClient(BASE); await c.get('/api/health');
    const reg = await c.post('/api/auth/register', {
      name: `GH Candidate ${n}`, email: `gh.cand.${n.toLowerCase()}@tl-sink.local`, password: 'Greenhouse123cand',
      preferredLocation: 'Hyderabad', expectedCtc: 5, noticePeriod: 'Immediate', preferredWorkModes: ['Hybrid'],
    });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    await raw(`update candidates set title = $2, skills = $3 where id = $1`, [reg.body.candidateId, title, skills]);
  }
});

test('the Greenhouse connector and the normaliser', async () => {
  const { connectorFor, collectViaConnector } = await import('../src/external/connectors.js');
  const { normaliseExternalJob } = await import('../src/external/normalise.js');
  const boards = [
    { platform: 'greenhouse', board_token: 'acme', active: true },
    { platform: 'greenhouse', board_token: 'globex', active: true },
    { platform: 'greenhouse', board_token: 'missingco', active: true },
    { platform: 'greenhouse', board_token: 'switched-off', active: false },
    { platform: 'lever', board_token: 'not-greenhouse', active: true },
  ];
  const c = connectorFor('greenhouse');
  const fetched = await c.fetchJobs({ boards });
  const collected = await collectViaConnector({ connector: 'greenhouse', active: true }, { boards });
  const normalised = collected.jobs.map((j) => normaliseExternalJob(j, { id: 'gh_src' }));
  const empty = await c.fetchJobs({ boards: [], source: { feed_url: '' } });
  const legacy = await c.fetchJobs({ boards: [], source: { feed_url: 'globex, missingco' } });
  shot.connector = JSON.parse(JSON.stringify({
    meta: { id: c.id, label: c.label, envKeys: c.envKeys, configured: c.configured(), note: c.note },
    fetched, collected, normalised, empty, legacy,
  }));
  assert.equal(calls.some((u) => /switched-off|not-greenhouse/.test(u)), false, 'inactive and Lever boards are not asked');
});

test('a sync through the API, a repeat, a changed board, and the stale sweep', async () => {
  const s = await admin.post('/api/external/sources', { id: 'gh_src', name: 'Greenhouse', sourceType: 'company_site',
    collectionMethod: 'connector', connector: 'greenhouse', applicationMethod: 'redirect', active: true });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  shot.sourceSaved = pick(s.body.source, ['id', 'name', 'sourceType', 'collectionMethod', 'applicationMethod',
    'autoApplySupported', 'active', 'feedUrl', 'connector', 'credentialConfigured', 'lastSyncAt',
    'lastSyncStatus', 'lastSyncError', 'lastSyncJobCount']);

  const boardsSaved = [];
  for (const [name, token, skip] of [['Acme', 'acme', false], ['Globex', 'globex', false], ['Missing Co', 'missingco', false], ['Missing Co', 'missingco', true]]) {
    const b = await admin.post('/api/external/career-boards', { name, platform: 'greenhouse', boardToken: token, skipVerify: skip });
    boardsSaved.push({ http: b.status, board: b.body.board ? pick(b.body.board, ['name', 'platform', 'boardToken', 'active']) : null,
      error: b.body.error ? b.body.error.message : null });
  }
  shot.boards = boardsSaved;

  const sync1 = await admin.post('/api/external/sources/gh_src/sync');
  shot.sync1 = { http: sync1.status, body: pick(sync1.body, SYNC_KEYS), state: await capture() };

  const sync2 = await admin.post('/api/external/sources/gh_src/sync');
  shot.sync2 = { http: sync2.status, body: pick(sync2.body, SYNC_KEYS), state: await capture() };

  round = 'round2';
  const sync3 = await admin.post('/api/external/sources/gh_src/sync');
  shot.sync3 = { http: sync3.status, body: pick(sync3.body, SYNC_KEYS), state: await capture() };

  /* Postings round 2 no longer returned, made a fortnight stale. */
  await raw(`update external_jobs set synced_at = now() - interval '15 days'
              where external_job_id in ('acme:4002', 'globex:77')`);
  const { closeStalePostings, closeJobsOutsideCountry } = await import('../src/external/service.js');
  const ENGINE = { userId: '', role: 'admin', profileId: null };
  const closed = await closeStalePostings(ENGINE);
  const outside = await closeJobsOutsideCountry(ENGINE);
  shot.sweep = { closed, outside, state: await capture() };
});

test('Greenhouse behaviour matches the snapshot taken before 0108', () => {
  const actual = JSON.parse(JSON.stringify(shot));
  if (UPDATE || !existsSync(SNAPSHOT)) {
    writeFileSync(SNAPSHOT, JSON.stringify(actual, null, 2) + '\n');
    console.log(`snapshot written: ${SNAPSHOT}`);
    return;
  }
  const expected = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
  for (const part of Object.keys(expected)) {
    assert.deepEqual(actual[part], expected[part], `Greenhouse output changed in: ${part}`);
  }
});

test('teardown', async () => {
  await new Promise((r) => server.close(r));
  const { closePool } = await import('../src/db.js');
  await closePool();
  await dbh.stop();
  await new Promise((r) => mock.close(r));
});
