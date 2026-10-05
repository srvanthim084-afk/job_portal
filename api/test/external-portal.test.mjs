/**
 * External jobs in the portal: listed on the External Jobs side only
 * (/api/portal/external-jobs - never in the Jobs page's /api/jobs, 0113),
 * applied for on the original website, and never turned into a TeamLink
 * application. Self-contained; nothing leaves the machine (sources are
 * manual feeds, the redirect is read from the Location header and not
 * followed).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb, applyTestEnv, makeClient } from './harness.mjs';
import { validateExternalUrl } from '../src/external/redirect.js';

const DB_PORT = 5438;
const API_PORT = 9994;
const BASE = `http://127.0.0.1:${API_PORT}`;
let dbh, server, raw, admin, cand;
const ids = {};

const count = async (sql, p) => Number((await raw(sql, p)).rows[0].n);
const go = (id) => fetch(`${BASE}/api/portal/external-jobs/${id}/apply`, { redirect: 'manual' });

test('boot', async () => {
  dbh = await startTestDb(DB_PORT);
  applyTestEnv(dbh.url, {
    PUBLIC_ORIGIN: BASE, DISABLE_BACKGROUND_WORK: 'true', EXTERNAL_JOBS_ENABLED: 'true',
    EMAIL_SMTP_HOST: '', EMAIL_API_KEY: '', EMAILJS_SERVICE_ID: '',
  });
  raw = (sql, p) => dbh.db.query(sql, p);
  await raw(`insert into companies (id, name) values ('co_x', 'TeamLink Client')`);

  const { hashPassword } = await import('../src/auth.js');
  const hash = await hashPassword('Portal123ext');
  const u = (await raw(`insert into users (email,password_hash,role) values ('portal.admin@tl-sink.local',$1,'admin') returning id`, [hash])).rows[0].id;
  await raw(`insert into admins (id, name, email, user_id) values ('apx','Portal Admin','portal.admin@tl-sink.local',$1)`, [u]);

  const { createApp } = await import('../src/app.js');
  const app = createApp({ logger: { error() {}, log() {} } });
  await new Promise((r) => { server = app.listen(API_PORT, r); });

  admin = makeClient(BASE); await admin.get('/api/health');
  assert.equal((await admin.post('/api/auth/login', { email: 'portal.admin@tl-sink.local', password: 'Portal123ext', role: 'admin' })).status, 200);
  cand = makeClient(BASE); await cand.get('/api/health');
  const reg = await cand.post('/api/auth/register', {
    name: 'Portal Candidate', email: 'portal.cand@tl-sink.local', password: 'Portal123cand',
    preferredLocation: 'Hyderabad', expectedCtc: 5, noticePeriod: 'Immediate', preferredWorkModes: ['Hybrid'],
  });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));

  const sources = [
    ['naukri_feed', 'Naukri', 'naukri', 'NK-1', 'Java Developer', 'https://www.naukri.com/job-listings-java-developer-1'],
    ['indeed_feed', 'Indeed', 'indeed', 'IN-1', 'Data Analyst', 'https://in.indeed.com/viewjob?jk=abc123'],
    ['shine_feed', 'Shine', 'shine', 'SH-1', 'Accountant', 'https://www.shine.com/jobs/accountant/1'],
    ['linkedin_feed', 'LinkedIn', 'linkedin', 'LI-1', 'Product Manager', 'https://www.linkedin.com/jobs/view/1'],
    ['gh_feed', 'Greenhouse', 'greenhouse', 'GH-1', 'Senior Java Engineer', 'https://boards.greenhouse.io/stripe/jobs/1'],
  ];
  for (const [id, name, connector, ext, title, url] of sources) {
    /* 0108: Naukri, Indeed, Shine and LinkedIn have no public API, so they
       can only be switched on with a complete licence record (this suite
       stands in for an authorized partner feed). Greenhouse needs none. */
    const partner = connector !== 'greenhouse';
    const s = await admin.post('/api/external/sources', { id, name, sourceType: 'partner_api',
      collectionMethod: 'manual', connector, applicationMethod: 'redirect', active: !partner });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    if (partner) {
      const refused = await admin.post('/api/external/sources', { id, name, sourceType: 'partner_api',
        collectionMethod: 'manual', connector, applicationMethod: 'redirect', active: true });
      assert.equal(refused.status, 409, `${name} cannot be switched on without a licence`);
      assert.equal(refused.body.error.code, 'LICENCE_REQUIRED');
      const lic = await admin.put(`/api/external/sources/${id}/licence`, { collectionMethod: 'partner_feed',
        licenceStatus: 'active', consentStatus: 'granted', termsUrl: `https://partner.example.org/${connector}/terms`,
        dataUsageAllowed: true, applicationRedirectAllowed: true, effectiveFrom: '2026-01-01',
        effectiveUntil: '2099-12-31', owner: 'TeamLink compliance', notes: 'test licence' });
      assert.equal(lic.status, 200, JSON.stringify(lic.body));
      assert.equal(lic.body.licenceGap, null);
      const on = await admin.post('/api/external/sources', { id, name, sourceType: 'partner_api',
        collectionMethod: 'manual', connector, applicationMethod: 'redirect', active: true });
      assert.equal(on.status, 200, JSON.stringify(on.body));
    }
    const j = await admin.post('/api/external/jobs', { sourceId: id, jobs: [{ id: ext, title, company: `${name} Employer`,
      location: 'Hyderabad', skills: /Java/.test(title) ? ['Java'] : ['Excel'], url, postedAt: new Date().toISOString() }] });
    assert.equal(j.body.saved, 1);
    ids[connector] = j.body.jobs[0].id;
    ids[`${connector}Url`] = url;
  }
});

test('TeamLink jobs: Apply Now is still the TeamLink application flow', async () => {
  await raw(`insert into jobs (id, title, company_id, location, status, published_at) values ('tlj1','Java Lead','co_x','Hyderabad','open',now())`);
  const before = await count(`select count(*) n from applications`);
  const r = await cand.post('/api/applications', { jobId: 'tlj1' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(await count(`select count(*) n from applications`), before + 1);
});

test('every source: Apply Now goes to the original page, and creates no application', async () => {
  for (const c of ['naukri', 'indeed', 'shine', 'linkedin', 'greenhouse']) {
    const before = await count(`select count(*) n from applications`);
    const res = await go(ids[c]);
    assert.equal(res.status, 302, `${c}: ${res.status}`);
    assert.equal(res.headers.get('location'), new URL(ids[`${c}Url`]).toString(), `${c} goes to its own page`);
    assert.equal(await count(`select count(*) n from applications`), before, `${c}: no TeamLink application`);
    assert.equal(await count(`select count(*) n from external_applications`), 0, 'an anonymous redirect records nothing');
  }
});

test('Greenhouse: the URL is passed through exactly as Greenhouse gave it', async () => {
  const res = await go(ids.greenhouse);
  assert.equal(res.headers.get('location'), 'https://boards.greenhouse.io/stripe/jobs/1');
});

test('the listing: public, candidate fields only, searchable, filterable by source', async () => {
  const anon = await fetch(`${BASE}/api/portal/external-jobs`).then((r) => r.json());
  assert.equal(anon.total, 5);
  const j = anon.jobs[0];
  assert.equal(j.jobType, 'EXTERNAL');
  for (const hidden of ['application_url', 'applicationUrl', 'raw', 'external_job_id', 'dedupe_key']) {
    assert.equal(hidden in j, false, `${hidden} is not exposed`);
  }
  const java = await fetch(`${BASE}/api/portal/external-jobs?q=java`).then((r) => r.json());
  assert.deepEqual(java.jobs.map((x) => x.title).sort(), ['Java Developer', 'Senior Java Engineer']);
  const nk = await fetch(`${BASE}/api/portal/external-jobs?source=naukri_feed`).then((r) => r.json());
  assert.deepEqual(nk.jobs.map((x) => x.sourceName), ['Naukri']);
});

test('0113: the Jobs page never lists them - /api/jobs is TeamLink jobs only', async () => {
  const jobs = await fetch(`${BASE}/api/jobs?limit=200`).then((r) => r.json());
  assert.ok(jobs.jobs.some((x) => x.id === 'tlj1'), 'the TeamLink job is there');
  assert.equal(jobs.jobs.some((x) => /^xjob_/.test(x.id)), false, 'no external job on the Jobs page');
  assert.ok(jobs.jobs.every((x) => x.sourceType === 'TEAMLINK'));
  const ext = await fetch(`${BASE}/api/portal/external-jobs`).then((r) => r.json());
  assert.ok(ext.jobs.every((x) => x.sourceType === 'EXTERNAL' && /^xjob_/.test(x.id)), 'External Jobs: external only');
});

test('the same job synced twice is one row', async () => {
  await admin.post('/api/external/jobs', { sourceId: 'naukri_feed', jobs: [{ id: 'NK-1', title: 'Java Developer (updated)',
    company: 'Naukri Employer', location: 'Hyderabad', url: ids.naukriUrl }] });
  assert.equal(await count(`select count(*) n from external_jobs where external_job_id = 'NK-1'`), 1);
  const d = await fetch(`${BASE}/api/portal/external-jobs/${ids.naukri}`).then((r) => r.json());
  assert.equal(d.job.title, 'Java Developer (updated)', 'updated in place');
});

test('an expired job: not listed, its page says so, and Apply does not redirect', async () => {
  await raw(`update external_jobs set status = 'expired' where id = $1`, [ids.shine]);
  const list = await fetch(`${BASE}/api/portal/external-jobs`).then((r) => r.json());
  assert.equal(list.jobs.some((x) => x.id === ids.shine), false);
  const d = await fetch(`${BASE}/api/portal/external-jobs/${ids.shine}`).then((r) => r.json());
  assert.equal(d.job.status, 'EXPIRED');
  const res = await go(ids.shine);
  assert.equal(res.status, 410);
  assert.equal(res.headers.get('location'), null);
});

test('an unsafe stored URL is never followed', async () => {
  const bad = ['javascript:alert(1)', 'http://10.0.0.5/admin', 'https://evil.example.com/naukri', 'https://user:pw@www.naukri.com/x',
    'https://not-naukri.com/job'];
  for (const url of bad) {
    await raw(`update external_jobs set application_url = $1 where id = $2`, [url, ids.naukri]);
    const res = await go(ids.naukri);
    assert.equal(res.status, 422, `${url} -> ${res.status}`);
    assert.equal(res.headers.get('location'), null);
  }
  /* The signed-in, tracked flow refuses it too, before recording a click. */
  const r = await cand.post('/api/external/apply', { externalJobId: ids.naukri });
  assert.equal(r.status, 422);
  assert.equal(await count(`select count(*) n from external_applications`), 0);
  await raw(`update external_jobs set application_url = $1 where id = $2`, [ids.naukriUrl, ids.naukri]);
});

test('a signed-in candidate: the click is tracked as a click, not an application', async () => {
  const before = await count(`select count(*) n from applications`);
  const r = await cand.post('/api/external/apply', { externalJobId: ids.linkedin });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.applyUrl, ids.linkedinUrl);
  assert.equal(await count(`select count(*) n from applications`), before, 'still no TeamLink application');
  assert.equal(await count(`select count(*) n from external_applications`), 1, 'one Clicked record');
});

test('a source that fails to sync keeps its jobs, and the run is recorded', async () => {
  /* 0108: the Naukri connector is not an authorized mechanism, so it can
     never be switched on - not even with a licence. */
  const on = await admin.post('/api/external/sources', { id: 'nk_conn', name: 'Naukri partner', sourceType: 'partner_api',
    collectionMethod: 'connector', connector: 'naukri', applicationMethod: 'redirect', active: true });
  assert.equal(on.status, 409);
  assert.match(on.body.error.message, /no authorized API/);
  const s = await admin.post('/api/external/sources', { id: 'nk_conn', name: 'Naukri partner', sourceType: 'partner_api',
    collectionMethod: 'connector', connector: 'naukri', applicationMethod: 'redirect', active: false });
  assert.equal(s.status, 200);
  await admin.post('/api/external/jobs', { sourceId: 'nk_conn', jobs: [{ id: 'NKP-1', title: 'Kept Job', url: 'https://www.naukri.com/kept' }] });
  const before = await count(`select count(*) n from external_jobs where source_id = 'nk_conn' and status = 'open'`);
  const sync = await admin.post('/api/external/sources/nk_conn/sync');
  assert.notEqual(sync.body.status, 'ok', 'a partner-only source with no feed cannot sync');
  assert.equal(await count(`select count(*) n from external_jobs where source_id = 'nk_conn' and status = 'open'`), before);
  const runs = await admin.get('/api/external/sync-runs');
  assert.ok(runs.body.runs.some((x) => x.source === 'nk_conn' && x.status !== 'ok'), 'the failed run is on record');
});

test('a source switched off: its jobs leave the portal', async () => {
  await raw(`update job_sources set active = false where id = 'indeed_feed'`);
  const list = await fetch(`${BASE}/api/portal/external-jobs`).then((r) => r.json());
  assert.equal(list.jobs.some((x) => x.sourceName === 'Indeed'), false);
  assert.equal((await go(ids.indeed)).status, 410);
});

test('the URL validator', () => {
  assert.equal(validateExternalUrl('https://www.naukri.com/x', 'naukri').ok, true);
  assert.equal(validateExternalUrl('https://naukri.com.evil.io/x', 'naukri').ok, false);
  assert.equal(validateExternalUrl('https://careers.stripe.com/jobs/1', 'greenhouse').ok, true, 'a company careers page');
  assert.equal(validateExternalUrl('data:text/html,hi', 'greenhouse').ok, false);
  assert.equal(validateExternalUrl('https://localhost/x', 'greenhouse').ok, false);
  assert.equal(validateExternalUrl('https://intranet.local/x', 'greenhouse').ok, false);
  assert.equal(validateExternalUrl('', 'greenhouse').ok, false);
});

test('teardown', async () => {
  await new Promise((r) => server.close(r));
  const { closePool } = await import('../src/db.js');
  await closePool();
  await dbh.stop();
});
