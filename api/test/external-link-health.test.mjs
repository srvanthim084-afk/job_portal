/**
 * 0115 - is an external posting still there?
 *
 * The owner's bug: Apply Now on a Databricks Greenhouse posting opened
 * Databricks' "this page has been removed", because Greenhouse had dropped
 * the job and TeamLink still listed it. This suite proves, against a local
 * mock of every provider (NOTHING LEAVES THE MACHINE: the test's fetch
 * refuses every non-loopback destination, and the checks are routed to the
 * mock with EXTERNAL_LINK_CHECK_VIA):
 *
 *   - a removed job (404 from the provider's job endpoint) is closed, says
 *     "Job no longer available", and no URL is handed out - by the
 *     availability check, the click, the redirect and the signed-in apply;
 *   - a live job hands out its stored URL;
 *   - a network error or a timeout hands the URL out and leaves the job alone;
 *   - the cache answers a repeat without asking the provider again;
 *   - the URL check (non-Greenhouse): 404/410, HEAD refused -> GET,
 *     redirects only on the approved domains, 5xx/403 never punish;
 *   - the background sweep closes only confirmed removals;
 *   - a truncated sync (EXTERNAL_SYNC_JOB_LIMIT) closes nothing by itself,
 *     and the stale sweep no longer closes postings their source confirmed;
 *   - the dedupe question: near-identical titles at two cities are two
 *     postings (two gh_jids), the same title and city is one card, and
 *     closing the visible one shows the other;
 *   - the scheduled sync runs after boot when it is overdue, and not when
 *     it is not.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startTestDb, applyTestEnv, makeClient } from './harness.mjs';

const DB_PORT = 5517;
const API_PORT = 9947;
const MOCK_PORT = 9847;
const BASE = `http://127.0.0.1:${API_PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const GH = 'https://boards-api.greenhouse.io';
const ENGINE = { userId: '', role: 'admin', profileId: null };

let dbh, server, mock, raw, admin, cand, av, svc, config;
const hits = [];

/* ---- the mock providers --------------------------------------------- */
const DBX = (id, title, loc) => ({ id, title, location: { name: loc }, content: '&lt;p&gt;Build AI systems with customers.&lt;/p&gt;',
  updated_at: '2026-09-28T05:00:00-04:00',
  absolute_url: `https://www.databricks.com/company/careers/professional-services-operations/x-${id}?gh_jid=${id}` });
const BOARD = {
  databricks: [
    DBX(8015848002, 'AI Engineer - FDE (Forward Deployed Engineer)', 'Bengaluru, India'),
    DBX(8015848003, 'AI Engineer, FDE (Forward Deployed Engineer)', 'Mumbai, India'),
    DBX(9100000001, 'Data Engineer', 'Bengaluru, India'),
    DBX(9100000002, 'Data Engineer', 'Bengaluru, India'),
    DBX(9100000003, 'Solutions Architect', 'Pune, India'),
    DBX(9100000004, 'Platform Engineer', 'Hyderabad, India'),
    DBX(9100000005, 'Support Engineer', 'Chennai, India'),
  ],
};
/* Which job ids the job endpoint still knows. Changed by the tests. */
const LIVE = new Set(BOARD.databricks.map((j) => String(j.id)));

function startMock() {
  const srv = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    const url = req.url;
    /* the board listing, for the sync (rewritten by the fetch guard) */
    let m = /^\/gh\/v1\/boards\/([^/]+)\/jobs\?content=true$/.exec(url);
    if (m) {
      const jobs = (BOARD[m[1]] || []).filter((j) => LIVE.has(String(j.id)));
      res.writeHead(BOARD[m[1]] ? 200 : 404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ jobs, meta: { total: jobs.length } }));
    }
    /* the Greenhouse job endpoint, through EXTERNAL_LINK_CHECK_VIA */
    m = /^\/https\/boards-api\.greenhouse\.io\/v1\/boards\/([^/]+)\/jobs\/(\d+)$/.exec(url);
    if (m) {
      if (req.headers['user-agent'] && !/^TeamLinkLinkCheck\//.test(req.headers['user-agent'])) {
        res.writeHead(400); return res.end('no user agent');
      }
      if (req.headers.cookie) { res.writeHead(400); return res.end('cookies sent'); }
      if (LIVE.has(m[2])) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ id: Number(m[2]), title: 'live' }));
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end('{"status":404,"error":"Job not found"}');
    }
    /* the job's own URL, for every other provider */
    m = /^\/https\/www\.naukri\.com\/(.*)$/.exec(url);
    if (m) {
      const p = m[1];
      if (p.startsWith('slow')) return;                                         // never answers
      if (p.startsWith('head405')) { res.writeHead(req.method === 'HEAD' ? 405 : 200); return res.end(); }
      if (p.startsWith('gone')) { res.writeHead(404); return res.end(); }
      if (p.startsWith('expired')) { res.writeHead(410); return res.end(); }
      if (p.startsWith('down')) { res.writeHead(503); return res.end(); }
      if (p.startsWith('walled')) { res.writeHead(403); return res.end(); }
      if (p.startsWith('moved-on')) { res.writeHead(301, { location: '/gone-after-move' }); return res.end(); }
      if (p.startsWith('moved-off')) { res.writeHead(302, { location: 'https://evil-redirect.example.org/x' }); return res.end(); }
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<!doctype html><title>job</title>');
    }
    res.writeHead(599); res.end();
  });
  return new Promise((r) => srv.listen(MOCK_PORT, '127.0.0.1', () => r(srv)));
}

/* ---- no real site is ever contacted ----------------------------------- */
const realFetch = globalThis.fetch;
const refused = [];
globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : (input && input.url) || String(input);
  if (url.startsWith(GH)) return realFetch(`${MOCK}/gh${url.slice(GH.length)}`, init);
  if (/^http:\/\/127\.0\.0\.1[:/]/.test(url)) return realFetch(input, init);
  refused.push(url);
  return Promise.reject(new Error(`test refused an outbound call to ${url}`));
};

const count = async (sql, p) => Number((await raw(sql, p)).rows[0].n);
const idOf = async (ext) => (await raw(`select id from external_jobs where external_job_id = $1`, [ext])).rows[0].id;
const statusOf = async (id) => (await raw(`select status from external_jobs where id = $1`, [id])).rows[0].status;
const avail = (id) => realFetch(`${BASE}/api/portal/external-jobs/${id}/availability`).then(async (r) => ({ http: r.status, ...(await r.json()) }));
const jobHits = (gid) => hits.filter((h) => h.includes(`/jobs/${gid}`) && h.includes('/https/')).length;

test('boot', async () => {
  mock = await startMock();
  dbh = await startTestDb(DB_PORT);
  applyTestEnv(dbh.url, {
    PUBLIC_ORIGIN: BASE, DISABLE_BACKGROUND_WORK: 'true', EXTERNAL_JOBS_ENABLED: 'true',
    EMAIL_SMTP_HOST: '', EMAIL_API_KEY: '', EMAILJS_SERVICE_ID: '',
    EXTERNAL_LINK_CHECK_ENABLED: 'true', EXTERNAL_LINK_CHECK_VIA: MOCK,
    EXTERNAL_LINK_CHECK_TIMEOUT_MS: '800', EXTERNAL_PORTAL_CACHE_SECONDS: '0',
  });
  raw = (sql, p) => dbh.db.query(sql, p);

  const { hashPassword } = await import('../src/auth.js');
  const hash = await hashPassword('LinkHealth123admin');
  const u = (await raw(`insert into users (email,password_hash,role) values ('lh.admin@tl-sink.local',$1,'admin') returning id`, [hash])).rows[0].id;
  await raw(`insert into admins (id, name, email, user_id) values ('alh','LH Admin','lh.admin@tl-sink.local',$1)`, [u]);

  const { createApp } = await import('../src/app.js');
  const app = createApp({ logger: { error() {}, log() {} } });
  await new Promise((r) => { server = app.listen(API_PORT, r); });
  av = await import('../src/external/availability.js');
  svc = await import('../src/external/service.js');
  ({ config } = await import('../src/config.js'));

  admin = makeClient(BASE); await admin.get('/api/health');
  assert.equal((await admin.post('/api/auth/login', { email: 'lh.admin@tl-sink.local', password: 'LinkHealth123admin', role: 'admin' })).status, 200);

  /* Greenhouse, exactly as live: a connector source and one career board. */
  let r = await admin.post('/api/external/sources', { id: 'gh_src', name: 'Greenhouse', sourceType: 'company_site',
    collectionMethod: 'connector', connector: 'greenhouse', applicationMethod: 'redirect', active: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await admin.post('/api/external/career-boards', { name: 'Databricks', platform: 'greenhouse', boardToken: 'databricks' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await admin.post('/api/external/sources/gh_src/sync');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.saved, 7, JSON.stringify(r.body));

  /* A licensed Naukri feed (manual), for the URL check. */
  const body = { id: 'nk_src', name: 'Naukri', sourceType: 'partner_api', collectionMethod: 'manual', connector: 'naukri', applicationMethod: 'redirect' };
  assert.equal((await admin.post('/api/external/sources', { ...body, active: false })).status, 200);
  r = await admin.put('/api/external/sources/nk_src/licence', { collectionMethod: 'partner_feed', licenceStatus: 'active',
    consentStatus: 'granted', termsUrl: 'https://partner.example.org/naukri/terms', dataUsageAllowed: true,
    applicationRedirectAllowed: true, effectiveFrom: '2026-01-01', effectiveUntil: '2099-12-31', owner: 'test', notes: 'test licence' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await admin.post('/api/external/sources', { ...body, active: true })).status, 200);
  const paths = ['live-1', 'gone-1', 'expired-1', 'head405-1', 'moved-on-1', 'moved-off-1', 'down-1', 'walled-1', 'slow-1',
    'sweep-live', 'sweep-gone', 'sweep-down'];
  r = await admin.post('/api/external/jobs', { sourceId: 'nk_src', jobs: paths.map((p, i) => ({ id: `NK-${p}`,
    title: `Accountant ${i}`, company: `Employer ${i}`, location: 'Hyderabad', skills: ['Tally'],
    url: `https://www.naukri.com/${p}`, postedAt: new Date().toISOString() })) });
  assert.equal(r.body.saved, paths.length, JSON.stringify(r.body));

  cand = makeClient(BASE); await cand.get('/api/health');
  const reg = await cand.post('/api/auth/register', { name: 'Link Candidate', email: 'lh.cand@tl-sink.local', password: 'LinkHealth123cand',
    preferredLocation: 'Hyderabad', expectedCtc: 5, noticePeriod: 'Immediate', preferredWorkModes: ['Hybrid'] });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
});

test('the reported job: removed at Greenhouse -> closed, "Job no longer available", no URL anywhere', async () => {
  LIVE.delete('8015848002');                              // Databricks took it down
  const id = await idOf('databricks:8015848002');
  assert.equal(await statusOf(id), 'open', 'listed as open, as on live');
  const listed = await realFetch(`${BASE}/api/portal/external-jobs?limit=500`).then((r) => r.json());
  assert.ok(listed.jobs.some((j) => j.id === id && j.originalJobUrl), 'Apply Now offered before the check');

  const a = await avail(id);
  assert.equal(a.http, 200);
  assert.equal(a.available, false);
  assert.equal(a.applyLink, 'job_unavailable');
  assert.equal(a.message, 'Job no longer available');
  assert.equal('url' in a, false, 'no URL handed out');
  assert.equal(jobHits(8015848002), 1, 'asked the Greenhouse job endpoint once');
  assert.ok(hits.includes('GET /https/boards-api.greenhouse.io/v1/boards/databricks/jobs/8015848002'));

  assert.equal(await statusOf(id), 'closed', 'marked closed (never deleted)');
  const chk = (await raw(`select outcome, http_status, method from external_job_link_checks where external_job_id = $1`, [id])).rows[0];
  assert.deepEqual(chk, { outcome: 'removed', http_status: 404, method: 'greenhouse_api' });
  const audit = (await raw(`select action, reason from external_audit_log where entity_id = $1 and action in ('job.link_removed','job.close') order by id`, [id])).rows;
  assert.deepEqual(audit.map((x) => x.action), ['job.close', 'job.link_removed']);
  assert.match(audit[1].reason, /Greenhouse job endpoint answered 404/);
  assert.equal((await raw(`select admin_hold from external_jobs where id = $1`, [id])).rows[0].admin_hold, null,
    'no admin hold: a later sync that sees it again reopens it');

  /* Every other way in says the same. */
  const click = await realFetch(`${BASE}/api/portal/external-jobs/${id}/click`, { method: 'POST' }).then((r) => r.json());
  assert.equal(click.applyLink, 'job_unavailable');
  assert.equal(click.status, 'Apply Clicked', 'the click is still counted');
  const go = await realFetch(`${BASE}/api/portal/external-jobs/${id}/apply`, { redirect: 'manual' });
  assert.equal(go.status, 410);
  assert.equal(go.headers.get('location'), null);
  const detail = await realFetch(`${BASE}/api/portal/external-jobs/${id}`).then((r) => r.json());
  assert.equal(detail.job.status, 'CLOSED');
  assert.equal(detail.job.applyLink, 'job_unavailable');
  assert.equal(detail.job.originalJobUrl, null);
  const after = await realFetch(`${BASE}/api/portal/external-jobs?limit=500`).then((r) => r.json());
  assert.equal(after.jobs.some((j) => j.id === id), false, 'gone from the External Jobs list');
  const ap = await cand.post('/api/external/apply', { externalJobId: id });
  assert.equal(ap.body.status, 'closed');
  assert.equal(ap.body.applyUrl ?? null, null, 'the signed-in apply hands out no URL');
  assert.equal(await count(`select count(*) n from external_applications where external_job_id = $1`, [id]), 0);
});

test('a live job: its stored original URL', async () => {
  av.clearAvailabilityCache();
  const id = await idOf('databricks:9100000003');
  const a = await avail(id);
  assert.equal(a.available, true);
  assert.equal(a.checked, 'confirmed');
  assert.equal(a.url, 'https://www.databricks.com/company/careers/professional-services-operations/x-9100000003?gh_jid=9100000003');
  assert.equal(await statusOf(id), 'open');
  const go = await realFetch(`${BASE}/api/portal/external-jobs/${id}/apply`, { redirect: 'manual' });
  assert.equal(go.status, 302);
  assert.equal(go.headers.get('location'), a.url);
  const ap = await cand.post('/api/external/apply', { externalJobId: id });
  assert.equal(ap.body.applyUrl, a.url, 'the signed-in apply hands out the URL');
  assert.equal(ap.body.application.status, 'clicked', '"Apply Clicked"');
});

test('a network error or a timeout: the URL is still handed out and the job is left alone', async () => {
  av.clearAvailabilityCache();
  const id = await idOf('databricks:9100000004');
  process.env.EXTERNAL_LINK_CHECK_VIA = 'http://127.0.0.1:9';        // nothing listens there
  try {
    const a = await avail(id);
    assert.equal(a.available, true);
    assert.equal(a.checked, 'unconfirmed');
    assert.match(a.url, /x-9100000004/);
  } finally { process.env.EXTERNAL_LINK_CHECK_VIA = MOCK; }
  assert.equal(await statusOf(id), 'open');
  assert.equal((await raw(`select outcome from external_job_link_checks where external_job_id = $1`, [id])).rows[0].outcome, 'unknown');

  const slow = await idOf('NK-slow-1');
  const t0 = Date.now();
  const s = await avail(slow);
  assert.ok(Date.now() - t0 < 3000, 'bounded by the timeout');
  assert.equal(s.available, true);
  assert.equal(s.url, 'https://www.naukri.com/slow-1');
  assert.equal(await statusOf(slow), 'open');
});

test('the cache: a repeat is answered without asking the provider again', async () => {
  av.clearAvailabilityCache();
  const id = await idOf('databricks:9100000005');
  const before = jobHits(9100000005);
  const a1 = await avail(id);
  const a2 = await avail(id);
  await realFetch(`${BASE}/api/portal/external-jobs/${id}/click`, { method: 'POST' });
  await Promise.all([1, 2, 3].map(() => avail(id)));
  assert.equal(a1.url, a2.url);
  assert.equal(jobHits(9100000005) - before, 1, 'one provider request for six questions');
  const direct = await av.checkAvailability(ENGINE, id);
  assert.equal(direct.cached, true);
  /* A forced check (the sweep) asks again, and a removal is seen at once. */
  LIVE.delete('9100000005');
  const forced = await av.checkAvailability(ENGINE, id, { force: true });
  assert.equal(forced.state, 'removed');
  assert.equal(jobHits(9100000005) - before, 2);
  LIVE.add('9100000005');
  await raw(`update external_jobs set status = 'open' where id = $1`, [id]);   // put it back for later tests
  av.clearAvailabilityCache();
});

test('the URL check (any other provider): only 404/410 close; redirects stay on approved domains', async () => {
  av.clearAvailabilityCache();
  const cases = [
    ['NK-live-1', true, 'open', 'confirmed'],
    ['NK-gone-1', false, 'closed'],
    ['NK-expired-1', false, 'closed'],
    ['NK-head405-1', true, 'open', 'confirmed'],          // HEAD refused -> GET 200
    ['NK-moved-on-1', false, 'closed'],                   // naukri.com -> naukri.com/gone-after-move (404)
    ['NK-moved-off-1', true, 'open', 'unconfirmed'],      // a redirect off naukri.com is not followed
    ['NK-down-1', true, 'open', 'unconfirmed'],           // 503
    ['NK-walled-1', true, 'open', 'unconfirmed'],         // 403: never held against the job
  ];
  for (const [ext, ok, status, checked] of cases) {
    const id = await idOf(ext);
    const a = await avail(id);
    assert.equal(a.available, ok, `${ext}: ${JSON.stringify(a)}`);
    if (ok) { assert.equal(a.checked, checked, ext); assert.match(a.url, /^https:\/\/www\.naukri\.com\//); }
    else { assert.equal(a.message, 'Job no longer available', ext); assert.equal('url' in a, false); }
    assert.equal(await statusOf(id), status, ext);
  }
  assert.ok(hits.includes('HEAD /https/www.naukri.com/head405-1') && hits.includes('GET /https/www.naukri.com/head405-1'));
  assert.ok(hits.includes('HEAD /https/www.naukri.com/gone-after-move'), 'the on-domain redirect was followed');
  assert.equal(hits.some((h) => h.includes('evil-redirect')), false, 'the off-domain redirect was not');
  assert.deepEqual(refused, [], 'no request ever tried to leave the machine');
});

test('the background sweep closes only confirmed removals', async () => {
  const ids = { live: await idOf('NK-sweep-live'), gone: await idOf('NK-sweep-gone'), down: await idOf('NK-sweep-down') };
  /* Only the three sweep postings are due: everything else was just checked. */
  await raw(`insert into external_job_link_checks (external_job_id, outcome)
             select id, 'available' from external_jobs where status = 'open' and not (id = any($1))
             on conflict (external_job_id) do update set checked_at = now()`, [[ids.live, ids.gone, ids.down]]);
  await raw(`update external_jobs set application_url = replace(application_url, 'sweep-', '') where id = any($1)`,
    [[ids.live, ids.gone, ids.down]]);   // sweep-live -> live, sweep-gone -> gone, sweep-down -> down
  /* X's per-source rate limit spaces the calls: 120 a minute = one per 0.5 s. */
  await raw(`update job_sources set rate_limit_per_minute = 120 where id = 'nk_src'`);
  av.clearAvailabilityCache();
  const t0 = Date.now();
  const r = await av.runLinkSweep(ENGINE, { defaultGapMs: 0 });
  assert.ok(Date.now() - t0 >= 900, `three calls to one source were spaced by its rate limit (${Date.now() - t0} ms)`);
  assert.equal(r.checked, 3, JSON.stringify(r));
  assert.deepEqual({ available: r.available, removed: r.removed, unknown: r.unknown, closed: r.closed },
    { available: 1, removed: 1, unknown: 1, closed: 1 });
  assert.equal(await statusOf(ids.live), 'open');
  assert.equal(await statusOf(ids.gone), 'closed');
  assert.equal(await statusOf(ids.down), 'open', 'a 503 never closes a job');
  const again = await av.runLinkSweep(ENGINE, { defaultGapMs: 0 });
  assert.equal(again.checked, 0, 'nothing is re-asked inside the recheck interval');
  /* "unknown" comes back sooner than "available". */
  await raw(`update external_job_link_checks set checked_at = now() - interval '3 hours' where external_job_id = any($1)`, [[ids.live, ids.down]]);
  const third = await av.runLinkSweep(ENGINE, { defaultGapMs: 0 });
  assert.equal(third.checked, 1, 'only the unconfirmed one is asked again');
});

test('a truncated sync (EXTERNAL_SYNC_JOB_LIMIT) closes nothing, and the stale sweep spares confirmed postings', async () => {
  const limit = config.externalJobs.syncJobLimit;
  const openGh = () => count(`select count(*) n from external_jobs where source_id = 'gh_src' and status = 'open'`);
  const before = await openGh();
  config.externalJobs.syncJobLimit = 2;
  try {
    const r = await admin.post('/api/external/sources/gh_src/sync');
    assert.equal(r.body.saved, 2, JSON.stringify(r.body));
  } finally { config.externalJobs.syncJobLimit = limit; }
  assert.equal(await openGh(), before, 'the truncated sync closed nothing');

  /* A fortnight later the cap still hides the same postings. One of them has
     really been taken down; the others are live. */
  const seen = (await raw(`select id from external_jobs where source_id = 'gh_src' and status = 'open'
                            order by synced_at desc limit 2`)).rows.map((x) => x.id);
  await raw(`update external_jobs set synced_at = now() - interval '15 days'
              where source_id = 'gh_src' and status = 'open' and not (id = any($1))`, [seen]);
  const hidden = (await raw(`select id, external_job_id from external_jobs where source_id = 'gh_src' and status = 'open'
                              and not (id = any($1)) order by external_job_id`, [seen])).rows;
  assert.ok(hidden.length >= 3, `hidden by the cap: ${hidden.length}`);
  const doomed = hidden.find((h) => h.external_job_id === 'databricks:9100000004');
  assert.ok(doomed, 'the last posting on the board is past the cap');
  LIVE.delete(doomed.external_job_id.split(':')[1]);

  await raw(`update external_job_link_checks set checked_at = now() - interval '2 days' where external_job_id = any($1)`, [hidden.map((h) => h.id)]);
  av.clearAvailabilityCache();
  const sweep = await av.runLinkSweep(ENGINE, { defaultGapMs: 0, limit: 50 });
  assert.ok(sweep.closed >= 1, JSON.stringify(sweep));
  assert.equal(await statusOf(doomed.id), 'closed', 'the removed one is closed by its own source\'s 404');

  const closedByStale = await svc.closeStalePostings(ENGINE);
  assert.equal(closedByStale, 0, 'the live postings past the cap are not closed for being "unseen"');
  for (const h of hidden.filter((x) => x !== doomed)) assert.equal(await statusOf(h.id), 'open', h.external_job_id);

  /* Put back on the board: the next sync reopens it (no admin hold), and a
     cached "removed" is not trusted for a posting that is open again. */
  LIVE.add(doomed.external_job_id.split(':')[1]);
  const resync = await admin.post('/api/external/sources/gh_src/sync');
  assert.equal(resync.status, 200, JSON.stringify(resync.body));
  assert.equal(await statusOf(doomed.id), 'open', 'seen again by a sync: reopened');
  const back = await avail(doomed.id);
  assert.equal(back.available, true, JSON.stringify(back));
});

test('the duplicate rows: two gh_jids, not a dedupe miss; one card per vacancy; a closed card shows its twin', async () => {
  const rows = (await raw(`select id, external_job_id, title, location, dedupe_key, duplicate_of from external_jobs
                            where source_id = 'gh_src' and external_job_id in ('databricks:8015848002','databricks:8015848003',
                                  'databricks:9100000001','databricks:9100000002') order by external_job_id`)).rows;
  const [fde1, fde2, de1, de2] = rows;
  /* The live pair: near-identical titles, different gh_jids, different cities. */
  assert.notEqual(fde1.external_job_id, fde2.external_job_id);
  assert.equal(fde1.dedupe_key.split('|')[0], fde2.dedupe_key.split('|')[0], 'the titles fold to the same words');
  assert.notEqual(fde1.dedupe_key, fde2.dedupe_key, 'but the cities differ, so they are two vacancies');
  /* The same posting synced again is still one row. */
  assert.equal(await count(`select count(*) n from external_jobs where external_job_id = 'databricks:8015848003'`), 1);
  /* Same title, same city, two gh_jids: one card. */
  assert.equal(de1.dedupe_key, de2.dedupe_key);
  const shown = (r) => r.jobs.filter((j) => j.title === 'Data Engineer').map((j) => j.id);
  let list = await realFetch(`${BASE}/api/portal/external-jobs?limit=500`).then((r) => r.json());
  assert.equal(shown(list).length, 1, 'one card for the two');
  const visible = shown(list)[0];
  const twin = visible === de1.id ? de2 : de1;
  assert.equal(twin.duplicate_of, visible);

  /* The visible one is taken down at the source: its twin appears. */
  LIVE.delete((visible === de1.id ? de1 : de2).external_job_id.split(':')[1]);
  av.clearAvailabilityCache();
  const a = await avail(visible);
  assert.equal(a.available, false);
  list = await realFetch(`${BASE}/api/portal/external-jobs?limit=500`).then((r) => r.json());
  assert.deepEqual(shown(list), [twin.id], 'the live twin is listed again');
});

test('the scheduled sync runs after boot when overdue, and not when it is not', async () => {
  assert.ok(svc.sourceDueAt({ last_attempt_at: null, last_sync_at: null }, 6) <= Date.now());
  assert.ok(svc.sourceDueAt({ last_attempt_at: new Date(Date.now() - 7 * 3600000) }, 6) <= Date.now());
  assert.ok(svc.sourceDueAt({ last_attempt_at: new Date(Date.now() - 1 * 3600000) }, 6) > Date.now());

  const runs = () => count(`select count(*) n from external_sync_runs where source_id = 'gh_src' and kind = 'sync'`);
  const wait = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };
  process.env.EXTERNAL_SYNC_BOOT_DELAY_SECONDS = '0';
  try {
    /* Down overnight: the last attempt was ten hours ago. */
    await raw(`update job_sources set last_attempt_at = now() - interval '10 hours', last_sync_at = now() - interval '10 hours'`);
    let n = await runs();
    let stop = svc.startExternalSyncSweep();
    assert.ok(await wait(async () => (await runs()) > n), 'an overdue source synced right after boot');
    stop();
    await new Promise((r) => setTimeout(r, 300));

    /* Restarted again an hour later: nothing is due, nothing is fetched. */
    await raw(`update job_sources set last_attempt_at = now() - interval '1 hour'`);
    n = await runs();
    stop = svc.startExternalSyncSweep();
    await new Promise((r) => setTimeout(r, 1500));
    stop();
    assert.equal(await runs(), n, 'a restart inside the interval does not sync');
  } finally { delete process.env.EXTERNAL_SYNC_BOOT_DELAY_SECONDS; }
});

test('switched off (and under NODE_ENV=test by default) nothing is asked: behaviour as before', async () => {
  av.clearAvailabilityCache();
  const id = await idOf('NK-live-1');
  const n = hits.length;
  process.env.EXTERNAL_LINK_CHECK_ENABLED = '';
  try {
    assert.equal(av.linkCheckEnabled(), false);
    const a = await avail(id);
    assert.equal(a.available, true);
    assert.equal(a.checked, 'not_checked');
    assert.equal(hits.length, n, 'no request');
  } finally { process.env.EXTERNAL_LINK_CHECK_ENABLED = 'true'; }
});

test('teardown', async () => {
  await new Promise((r) => server.close(r));
  const { closePool } = await import('../src/db.js');
  await closePool();
  await dbh.stop();
  mock.closeAllConnections?.();
  await new Promise((r) => mock.close(r));
});
