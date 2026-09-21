/**
 * Tests the production migration runner against a real Postgres.
 *
 * A migration runner is the one script that touches production data with
 * nobody watching, so its safety properties are checked rather than
 * assumed: does it re-run migrations, does it notice edited files, does it
 * leave a clean state after a failure, does it keep seed data out by
 * default.
 */
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const REAL = join(ROOT, 'supabase', 'migrations');
const PORT = 5436;

const db = await new PGlite();
await db.exec(`create role app_api nologin;`);   // the runner expects it to exist
const server = new PGLiteSocketServer({ db, port: PORT, host: '127.0.0.1' });
await server.start();

const URL = `postgres://postgres:postgres@127.0.0.1:${PORT}/postgres`;

let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  PASS  ${name}`); }
  catch (e) { console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n')[0]}`); failed++; }
};

/**
 * MUST be async.
 *
 * PGlite's socket server runs in THIS process. A synchronous execFileSync
 * would block the event loop, so the child process could never finish
 * connecting and the suite would hang forever instead of failing — which
 * is exactly what happened the first time this was written.
 */
const run = (args = [], env = {}) => execFileAsync(
  process.execPath, [join(ROOT, 'tools', 'migrate.mjs'), ...args],
  { cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, ADMIN_DATABASE_URL: URL,
           APP_DB_PASSWORD: 'a-long-enough-password-1234', ...env } })
  .then((r) => r.stdout);

const out = (e) => String(e.stdout || '') + String(e.stderr || '');
const q = async (sql) => (await db.query(sql)).rows;

console.log('migration runner');

let first = '';
await check('applies pending migrations and skips the seed by default', async () => {
  first = await run();
  if (!/applying 0001_schema\.sql/.test(first)) throw new Error('0001 was not applied');
  if (!/skipped\s+0003_seed\.sql/.test(first)) throw new Error('the seed was not skipped');
  if (/applying 0003_seed\.sql/.test(first)) throw new Error('the seed was applied without --seed');
});

const tables = (await q(`select tablename from pg_tables where schemaname='public'`)).length;
await check(`created the schema (${tables} tables)`, () => {
  if (tables < 25) throw new Error(`only ${tables} tables were created`);
});

const jobsBefore = (await q(`select count(*)::int n from jobs`))[0].n;
await check('no demo data without --seed (requirement 27)', () => {
  if (jobsBefore !== 0) throw new Error(`${jobsBefore} jobs present in a production-style deploy`);
});

await check('is idempotent — a second run applies nothing', async () => {
  const o = await run();
  if (/applying/.test(o)) throw new Error('re-applied a migration');
  if (!/up to date/.test(o)) throw new Error('did not report the database as up to date');
});

await check('enables login for app_api and sets its password', () => {
  if (!/login enabled/.test(first)) throw new Error('app_api login was not enabled');
});

await check('verifies app_api cannot bypass RLS', () => {
  if (!/superuser=false bypassrls=false/.test(first)) {
    throw new Error('did not verify that the application role is unprivileged');
  }
});

await check('refuses a short APP_DB_PASSWORD', async () => {
  try {
    await run([], { APP_DB_PASSWORD: 'short' });
    throw new Error('accepted a 5-character database password');
  } catch (e) {
    if (/accepted a 5-character/.test(e.message)) throw e;
    if (!/at least 16/.test(out(e))) throw new Error('rejected for the wrong reason');
  }
});

const applied = await q(`select filename, checksum from schema_migrations order by filename`);
await check(`records what it applied (${applied.length} files, with checksums)`, () => {
  if (!applied.length) throw new Error('schema_migrations is empty');
  if (applied.some((r) => !r.checksum)) throw new Error('recorded without a checksum');
  if (applied.some((r) => /seed/.test(r.filename))) throw new Error('seed recorded as applied');
});

await check('--status reports without changing anything', async () => {
  const o = await run(['--status']);
  if (!/applied\s+0001_schema\.sql/.test(o)) throw new Error('status did not list 0001 as applied');
  if (!/PENDING\s+0003_seed\.sql/.test(o)) throw new Error('status did not show the seed as pending');
});

await check('ABORTS if an already-applied migration was edited', async () => {
  const target = join(REAL, '0001_schema.sql');
  const original = readFileSync(target, 'utf8');
  writeFileSync(target, original + '\n-- tampered\n');
  try {
    await run();
    throw new Error('ran anyway after a migration had been edited');
  } catch (e) {
    if (/ran anyway/.test(e.message)) throw e;
    if (!/edited AFTER being applied/.test(out(e))) {
      throw new Error('aborted for the wrong reason');
    }
  } finally {
    writeFileSync(target, original);
  }
});

await check('a failing migration leaves NOTHING behind', async () => {
  const bad = join(REAL, '9999_deliberately_broken.sql');
  writeFileSync(bad,
    'create table should_not_survive (id int);\n' +
    'insert into should_not_survive values (1);\n' +
    'this is not valid sql;\n');
  try {
    try {
      await run();
      throw new Error('a broken migration was reported as successful');
    } catch (e) {
      if (/reported as successful/.test(e.message)) throw e;
    }
    const left = await q(`select 1 from pg_tables where tablename='should_not_survive'`);
    if (left.length) throw new Error('the partial migration was committed — not atomic');
    const rec = await q(`select 1 from schema_migrations where filename='9999_deliberately_broken.sql'`);
    if (rec.length) throw new Error('a failed migration was recorded as applied');
  } finally {
    rmSync(bad, { force: true });
  }
});

await check('loads the seed only when asked', async () => {
  const o = await run(['--seed']);
  if (!/applying 0003_seed\.sql/.test(o)) throw new Error('--seed did not apply the seed');
});

const jobsAfter = (await q(`select count(*)::int n from jobs`))[0].n;
await check(`--seed loaded the demo data (${jobsAfter} jobs)`, () => {
  if (jobsAfter !== 13) throw new Error(`expected 13 jobs, got ${jobsAfter}`);
});

console.log(failed ? `\nMIGRATION RUNNER FAILED (${failed})` : '\nMIGRATION RUNNER VERIFIED');
await server.stop();
await db.close();
process.exitCode = failed ? 1 : 0;
