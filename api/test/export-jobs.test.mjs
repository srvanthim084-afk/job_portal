/**
 * Resume exports above a hundred: built in the background, downloaded by
 * the person who asked, by nobody else, and audited like any export.
 *
 * Self-contained. The resumes are written straight into the test storage
 * folder, so nothing is parsed and no AI or mail provider is touched.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { startTestDb, applyTestEnv, makeClient } from './harness.mjs';

const DB_PORT = 5437;
const API_PORT = 9995;
const HERE = dirname(fileURLToPath(import.meta.url));
const UPLOADS = resolve(HERE, '../var/test-uploads');

let dbh, server, raw, owner, other;
const ids = [];

async function signIn(email) {
  const c = makeClient(`http://127.0.0.1:${API_PORT}`);
  await c.get('/api/health');
  const r = await c.post('/api/auth/login', { email, password: 'Export123job', role: 'admin' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return c;
}

/** Entries in a ZIP, from its end-of-central-directory record. */
function zipEntries(buf) {
  for (let i = buf.length - 22; i >= 0; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) return buf.readUInt16LE(i + 10);
  }
  return -1;
}

test('boot', async () => {
  dbh = await startTestDb(DB_PORT);
  applyTestEnv(dbh.url, {
    PUBLIC_ORIGIN: `http://127.0.0.1:${API_PORT}`,
    DISABLE_BACKGROUND_WORK: 'true',
    EXPORT_DIR: mkdtempSync(join(tmpdir(), 'tl-export-jobs-')),
    EMAIL_SMTP_HOST: '', EMAIL_API_KEY: '', EMAILJS_SERVICE_ID: '',
  });
  raw = (sql, p) => dbh.db.query(sql, p);

  const { hashPassword } = await import('../src/auth.js');
  const hash = await hashPassword('Export123job');
  for (const [id, email] of [['ax1', 'export.owner@tl-sink.local'], ['ax2', 'export.other@tl-sink.local']]) {
    const u = (await raw(`insert into users (email, password_hash, role) values ($1,$2,'admin') returning id`,
      [email, hash])).rows[0].id;
    await raw(`insert into admins (id, name, email, user_id) values ($1,$2,$3,$4)`, [id, id, email, u]);
  }

  mkdirSync(join(UPLOADS, 'export-jobs'), { recursive: true });
  for (let n = 1; n <= 125; n += 1) {
    const id = `cx${n}`;
    ids.push(id);
    const path = n <= 120 ? `export-jobs/${id}.pdf` : null;
    if (path) writeFileSync(join(UPLOADS, path), Buffer.from(`%PDF-1.4 resume ${n}`));
    await raw(`insert into candidates (id, name, email, resume_storage_path, resume_file)
               values ($1,$2,$3,$4,$5)`,
      [id, `Export Person ${n}`, `${id}@tl-sink.local`, path, path ? `${id}.pdf` : null]);
  }

  const { createApp } = await import('../src/app.js');
  const app = createApp({ logger: { error() {}, log() {} } });
  await new Promise((r) => { server = app.listen(API_PORT, r); });
  owner = await signIn('export.owner@tl-sink.local');
  other = await signIn('export.other@tl-sink.local');
});

test('the catalogue offers background exports above the direct limit', async () => {
  const r = await owner.get('/api/recruiter/candidates/export-columns');
  assert.equal(r.status, 200);
  assert.equal(r.body.zipLimit, 100);
  assert.equal(r.body.jobLimit, 1000);
});

test('125 resumes: the direct download refuses, a background job delivers', async () => {
  const direct = await owner.post('/api/recruiter/candidates/export-resumes', { ids, scope: 'selected' });
  assert.equal(direct.status, 400, 'more than 100 is not one download');

  const before = (await raw(`select count(*)::int n from export_audit`)).rows[0].n;
  const start = await owner.post('/api/recruiter/candidates/export-resumes/jobs', { ids, scope: 'selected' });
  assert.equal(start.status, 202, JSON.stringify(start.body));
  const id = start.body.job.id;
  assert.equal(start.body.job.total, 120);
  assert.ok(!('file' in start.body.job) && !('owner' in start.body.job), 'no path or owner leaves the server');
  assert.equal((await raw(`select count(*)::int n from export_audit`)).rows[0].n, before + 1, 'audited up front');

  let job = start.body.job;
  for (let i = 0; i < 100 && job.status === 'running'; i += 1) {
    await new Promise((r) => setTimeout(r, 100));
    job = (await owner.get(`/api/recruiter/candidates/export-resumes/jobs/${id}`)).body.job;
  }
  assert.equal(job.status, 'ready');
  assert.equal(job.included, 120);
  assert.equal(job.missing, 5);

  const res = await fetch(`http://127.0.0.1:${API_PORT}/api/recruiter/candidates/export-resumes/jobs/${id}/download`,
    { headers: { cookie: [...owner.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ') } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /zip/);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(zipEntries(buf), 121, '120 resumes and missing_resumes.txt');

  // Somebody else's session cannot see it or fetch it.
  assert.equal((await other.get(`/api/recruiter/candidates/export-resumes/jobs/${id}`)).status, 404);
  assert.equal((await other.get(`/api/recruiter/candidates/export-resumes/jobs/${id}/download`)).status, 404);
});

test('more than a thousand is refused', async () => {
  const many = Array.from({ length: 1001 }, (_, i) => `nobody${i}`);
  const r = await owner.post('/api/recruiter/candidates/export-resumes/jobs', { ids: many, scope: 'selected' });
  assert.equal(r.status, 400);
});

test('teardown', async () => {
  await new Promise((r) => server.close(r));
  const { closePool } = await import('../src/db.js');
  await closePool();
  await dbh.stop();
});
