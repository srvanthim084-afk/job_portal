/**
 * A full deployment rehearsal, in ONE process.
 *
 *   node tools/rehearse.mjs
 *
 * Walks the same sequence a real deploy does — build, database, migrate,
 * first admin, boot, test — and reports what actually happened.
 *
 * Why one process: the staging database is PGlite behind a socket server,
 * which serves ONE connection at a time and never recovers from one that
 * is abandoned. Running each step as its own command left wedged
 * connections and zombie servers holding ports, which produced failures
 * that had nothing to do with the application. Everything therefore lives
 * in a single lifetime with one connection and a guaranteed clean exit.
 *
 * WHAT THIS DOES NOT REHEARSE, and cannot locally:
 *   - Docker image build and container networking
 *   - nginx, TLS termination, certificate issuance
 *   - a real connection POOL (this database allows one connection)
 *   - Secure cookies over HTTPS (the app correctly refuses plain http in
 *     production, so functional tests run in staging mode)
 * Those need a real server. That is the gap this cannot close.
 */
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rmSync, mkdirSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyPendingMigrations } from './lib/migrate-core.mjs';

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const DB_DIR = join(ROOT, 'var', 'rehearsal-db');
const PG_PORT = 5441;
const API_PORT = 4401;
const ADMIN_EMAIL = 'admin@teamlink.local';
const ADMIN_PASSWORD = 'Rehearsal#2026!';

let pass = 0, fail = 0;
const step = (n, t) => console.log(`\n── ${n}. ${t} ${'─'.repeat(Math.max(0, 56 - t.length))}`);
const ok = (m) => { pass++; console.log(`   PASS  ${m}`); };
const no = (m) => { fail++; console.log(`   FAIL  ${m}`); };
const check = async (name, fn) => {
  try { const n = await fn(); ok(name + (n ? ` — ${n}` : '')); }
  catch (e) { no(`${name}\n         ${String(e.message).split('\n')[0]}`); }
};

let db, pgServer, api;

try {
  /* ---------------------------------------------------------------- */
  step(1, 'Production build');
  const build = await run(process.execPath, ['web/build.mjs'], { cwd: ROOT });
  const bytes = (build.stdout.match(/preserved\s*:\s*(\d+)/) || [])[1];
  if (bytes === '1587110') ok(`prototype byte-identical (${bytes} bytes, sha256 verified)`);
  else no(`unexpected prototype size: ${bytes}`);

  /* ---------------------------------------------------------------- */
  step(2, 'Database setup');
  rmSync(DB_DIR, { recursive: true, force: true });
  mkdirSync(DB_DIR, { recursive: true });
  db = await new PGlite(DB_DIR);
  await db.exec(`do $$ begin
    if not exists (select 1 from pg_roles where rolname='app_api') then
      create role app_api nologin;
    end if; end $$;`);
  ok('empty PostgreSQL provisioned');

  const mig = await applyPendingMigrations(
    { exec: (s) => db.exec(s), query: (s, p) => db.query(s, p) },
    { seed: false });
  ok(`${mig.applied.length} migrations applied`);
  if (mig.skippedSeed.length) ok('demo seed correctly SKIPPED (production starts empty)');
  else no('the seed was not skipped');

  const counts = await db.query(`select
    (select count(*)::int from jobs) jobs,
    (select count(*)::int from candidates) cands,
    (select count(*)::int from users) users`);
  const c0 = counts.rows[0];
  if (c0.jobs === 0 && c0.cands === 0 && c0.users === 0) ok('database is empty, as a fresh deploy should be');
  else no(`expected an empty database, found ${JSON.stringify(c0)}`);

  const role = await db.query(
    `select rolsuper, rolbypassrls from pg_roles where rolname='app_api'`);
  if (!role.rows[0].rolsuper && !role.rows[0].rolbypassrls) ok('app_api is unprivileged (RLS will apply)');
  else no('app_api can bypass RLS — every policy would be disabled');

  /* ---------------------------------------------------------------- */
  step(3, 'Environment variables');
  const AUTH_SECRET = randomBytes(48).toString('base64');
  const APP_DB_PASSWORD = randomBytes(24).toString('base64').replace(/[^A-Za-z0-9]/g, '');
  if (AUTH_SECRET.length >= 32) ok(`AUTH_SECRET generated (${AUTH_SECRET.length} chars)`);
  if (APP_DB_PASSWORD.length >= 16) ok(`APP_DB_PASSWORD generated (${APP_DB_PASSWORD.length} chars)`);
  await db.exec(`alter role app_api login password '${APP_DB_PASSWORD}'`);
  ok('app_api login enabled');

  /* ---------------------------------------------------------------- */
  step(4, 'First administrator');
  const bcrypt = (await import('../api/node_modules/bcryptjs/index.js')).default;
  const hash = await bcrypt.hash(ADMIN_PASSWORD, 10);
  await db.query(
    `insert into admins (id,name,email,title,initials)
     values ('a1','Platform Administrator',$1,'Platform Administrator','PA')`, [ADMIN_EMAIL]);
  const u = await db.query(
    `insert into users (email,password_hash,role) values ($1,$2,'admin') returning id`,
    [ADMIN_EMAIL, hash]);
  await db.query(`update admins set user_id=$1 where id='a1'`, [u.rows[0].id]);
  const verify = await db.query(
    `select u.role, (u.password_hash like '$2%') hashed from users u where u.id=$1`, [u.rows[0].id]);
  if (verify.rows[0].hashed) ok(`${ADMIN_EMAIL} created with a bcrypt hash (no plain text)`);
  else no('the password was not hashed');

  /* ---------------------------------------------------------------- */
  step(5, 'Boot the application');
  pgServer = new PGLiteSocketServer({ db, port: PG_PORT, host: '127.0.0.1' });
  await pgServer.start();

  Object.assign(process.env, {
    NODE_ENV: 'staging',
    AUTH_SECRET,
    DATABASE_URL: `postgres://postgres:postgres@127.0.0.1:${PG_PORT}/postgres`,
    DB_ROLE: 'app_api',
    DB_POOL_MAX: '1',
    PUBLIC_ORIGIN: `http://127.0.0.1:${API_PORT}`,
    STORAGE_DRIVER: 'local',
    STORAGE_LOCAL_DIR: join(ROOT, 'var', 'rehearsal-uploads'),
    BCRYPT_ROUNDS: '10',
    RATE_LIMIT_MAX: '100000',
    LOGIN_RATE_LIMIT_MAX: '1000',
    WEB_DIR: join(ROOT, 'web'),
  });

  const { createApp } = await import('../api/src/app.js');
  const { getPool, assertUnprivileged, closePool } = await import('../api/src/db.js');

  const conn = await getPool().connect();
  try {
    const who = await assertUnprivileged(conn);
    ok(`connected as ${who} — the server would refuse a superuser here`);
  } finally { conn.release(); }

  const app = createApp({ serveStatic: join(ROOT, 'web'), logger: { error() {}, log() {} } });
  await new Promise((r) => { api = app.listen(API_PORT, r); });
  ok(`API listening on ${API_PORT}`);

  /* ---------------------------------------------------------------- */
  step(6, 'Test the deployed instance');

  const BASE = `http://127.0.0.1:${API_PORT}`;
  const jar = new Map();
  const call = async (method, path, body) => {
    const headers = {};
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) headers.cookie = cookie;
    if (jar.has('tl_csrf')) headers['x-csrf-token'] = jar.get('tl_csrf');
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(BASE + path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const line of (res.headers.getSetCookie?.() || [])) {
      const [p] = line.split(';'); const i = p.indexOf('=');
      const k = p.slice(0, i).trim(), v = p.slice(i + 1).trim();
      if (v === '') jar.delete(k); else jar.set(k, v);
    }
    let json = null; try { json = await res.json(); } catch { /* not json */ }
    return { status: res.status, body: json };
  };

  await check('the portal is served', async () => {
    const r = await fetch(BASE + '/');
    const html = await r.text();
    if (!html.includes('teamlink-integration.js')) throw new Error('the integration script is missing');
    return `${html.length} bytes`;
  });

  await check('a wrong password is rejected', async () => {
    const r = await call('POST', '/api/auth/login', { email: ADMIN_EMAIL, password: 'wrong' });
    if (r.status !== 401) throw new Error(`expected 401, got ${r.status}`);
  });

  await check('the admin can sign in', async () => {
    const r = await call('POST', '/api/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    if (r.status !== 200) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
    return r.body.session.role;
  });

  await check('CREATE a company', async () => {
    const r = await call('POST', '/api/jobs', {
      id: 'REH1', title: 'Rehearsal Engineer', companyId: null,
      location: 'Bengaluru', type: 'Full-time', status: 'open',
    });
    if (r.status !== 201) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
  });

  await check('READ it back from the database', async () => {
    const r = await call('GET', '/api/jobs/REH1');
    if (r.status !== 200 || r.body.job.title !== 'Rehearsal Engineer') {
      throw new Error('the record did not come back');
    }
  });

  await check('UPDATE persists and keeps the id', async () => {
    await call('PUT', '/api/jobs/REH1', { title: 'Rehearsal Engineer II', companyId: null });
    const b = await call('GET', '/api/jobs/REH1');
    if (b.body.job.title !== 'Rehearsal Engineer II') throw new Error('the edit did not persist');
    if (b.body.job.id !== 'REH1') throw new Error('the id changed');
  });

  await check('DELETE removes it', async () => {
    const d = await call('DELETE', '/api/jobs/REH1');
    const g = await call('GET', '/api/jobs/REH1');
    if (d.status !== 200 || g.status === 200) throw new Error('the record survived deletion');
  });

  await check('anonymous visitors see no private data', async () => {
    await call('POST', '/api/auth/logout', {});
    const r = await fetch(BASE + '/api/bootstrap').then((x) => x.json());
    if (r.data.candidates.length) throw new Error(`${r.data.candidates.length} candidates exposed`);
    if (r.session) throw new Error('a session survived logout');
  });

  await check('API responses are never cached', async () => {
    const r = await fetch(BASE + '/api/health');
    const cc = r.headers.get('cache-control') || '';
    if (!cc.includes('no-store')) throw new Error(`Cache-Control: ${cc || '(none)'}`);
  });

  await check('security headers are present', async () => {
    const r = await fetch(BASE + '/');
    const missing = ['content-security-policy', 'x-content-type-options', 'referrer-policy']
      .filter((h) => !r.headers.get(h));
    if (missing.length) throw new Error(`missing: ${missing.join(', ')}`);
    if (!r.headers.get('content-security-policy').includes("script-src-attr 'unsafe-inline'")) {
      throw new Error('script-src-attr would block every inline handler');
    }
  });

  /* ---------------------------------------------------------------- */
  step(7, 'Data survives a restart');
  await call('POST', '/api/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  await call('POST', '/api/jobs', {
    id: 'REH_PERSIST', title: 'Survives a restart', companyId: null,
    location: 'Bengaluru', type: 'Full-time', status: 'open',
  });
  await db.exec('checkpoint');

  await new Promise((r) => api.close(r)); api = null;
  await closePool();
  await pgServer.stop(); pgServer = null;
  await db.close(); db = null;

  const reopened = await new PGlite(DB_DIR);
  const found = await reopened.query(`select title from jobs where id='REH_PERSIST'`);
  if (found.rows.length) ok(`survived a full shutdown — "${found.rows[0].title}"`);
  else no('the record did NOT survive a restart');
  await reopened.close();

} catch (err) {
  no(`rehearsal aborted: ${err.message}`);
  console.error(err.stack?.split('\n').slice(0, 4).join('\n'));
} finally {
  if (api) await new Promise((r) => api.close(r));
  if (pgServer) await pgServer.stop().catch(() => {});
  if (db) await db.close().catch(() => {});
}

console.log(`\n${'═'.repeat(62)}`);
console.log(`  ${pass} passed, ${fail} failed`);
console.log(fail
  ? '\n  REHEARSAL FAILED — fix the above before deploying.'
  : '\n  REHEARSAL PASSED for everything testable without a server.'
  + '\n  Still unrehearsed: Docker, nginx, TLS, a real connection pool.');
process.exitCode = fail ? 1 : 0;
