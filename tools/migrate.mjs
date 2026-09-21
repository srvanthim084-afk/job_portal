/**
 * Production migration runner.
 *
 *   node tools/migrate.mjs            apply pending schema migrations
 *   node tools/migrate.mjs --seed     also load the demo seed data
 *   node tools/migrate.mjs --status   show what is applied, change nothing
 *
 * Properties that matter in production:
 *
 *   - Idempotent. Applied migrations are recorded in `schema_migrations`
 *     and never run twice.
 *   - Tamper-evident. Each file's SHA-256 is stored. If an already-applied
 *     migration is edited afterwards, the run ABORTS rather than leaving
 *     the database in a state nobody can reproduce.
 *   - Atomic per file. Each migration runs in its own transaction, so a
 *     failure leaves no half-applied schema.
 *   - Seed is OPT-IN. Requirement 27 says no demo data may be required in
 *     production, so `0003_seed.sql` is skipped unless you ask for it.
 *
 * This connects as an ADMIN role (it creates roles and tables). The
 * application itself must NOT use this connection string — see
 * ADMIN_DATABASE_URL vs DATABASE_URL in .env.example.
 */
import pg from 'pg';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR  = resolve(HERE, '..', 'supabase', 'migrations');

const args    = process.argv.slice(2);
const doSeed  = args.includes('--seed');
const status  = args.includes('--status');

const url = process.env.ADMIN_DATABASE_URL || process.env.DATABASE_URL;
if (!url) {
  console.error('ADMIN_DATABASE_URL (or DATABASE_URL) must be set.');
  // Safe to exit outright here: no connection has been opened yet.
  process.exit(1);
}

const sha = (s) => createHash('sha256').update(s).digest('hex');
const isSeed = (f) => /seed/.test(f);

const client = new pg.Client({
  connectionString: url,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
});

await client.connect();

/**
 * Every exit path returns rather than calling process.exit().
 *
 * process.exit() terminates immediately and skips the pending
 * `await client.end()` in the finally block below, abandoning the
 * connection. Against a real Postgres the server eventually reaps it;
 * against a single-connection server it wedges the next run entirely.
 */
async function main() {
  await client.query(`
    create table if not exists schema_migrations (
      filename    text primary key,
      checksum    text not null,
      applied_at  timestamptz not null default now(),
      duration_ms integer
    )`);

  const applied = new Map(
    (await client.query(`select filename, checksum, applied_at from schema_migrations`))
      .rows.map((r) => [r.filename, r]));

  const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();

  if (status) {
    console.log(`migrations in ${DIR}\n`);
    for (const f of files) {
      const a = applied.get(f);
      const tag = isSeed(f) ? ' (seed, opt-in)' : '';
      if (!a) console.log(`  PENDING  ${f}${tag}`);
      else if (a.checksum !== sha(readFileSync(join(DIR, f), 'utf8')))
        console.log(`  CHANGED  ${f}  applied ${a.applied_at.toISOString()} — FILE HAS BEEN EDITED`);
      else console.log(`  applied  ${f}  ${a.applied_at.toISOString()}${tag}`);
    }
    process.exitCode = 0;
    return;
  }

  // Refuse to continue if anything already applied has since been edited.
  const tampered = [];
  for (const f of files) {
    const a = applied.get(f);
    if (a && a.checksum !== sha(readFileSync(join(DIR, f), 'utf8'))) tampered.push(f);
  }
  if (tampered.length) {
    console.error('\nThese migrations were edited AFTER being applied:\n');
    for (const f of tampered) console.error(`  ${f}`);
    console.error('\nThe database no longer matches the files that produced it. Write a NEW');
    console.error('migration instead of editing an old one, then run this again.\n');
    process.exitCode = 1;
    return;
  }

  const pending = files.filter((f) => !applied.has(f) && (doSeed || !isSeed(f)));
  const skipped = files.filter((f) => !applied.has(f) && !doSeed && isSeed(f));

  if (!pending.length) {
    console.log('database is up to date' + (skipped.length ? ` (${skipped.length} seed file(s) skipped)` : ''));
  }

  for (const f of pending) {
    const sql = readFileSync(join(DIR, f), 'utf8');
    const started = Date.now();
    process.stdout.write(`  applying ${f} … `);
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query(
        `insert into schema_migrations (filename, checksum, duration_ms) values ($1,$2,$3)`,
        [f, sha(sql), Date.now() - started]);
      await client.query('commit');
      console.log(`ok (${Date.now() - started}ms)`);
    } catch (err) {
      await client.query('rollback').catch(() => {});
      console.log('FAILED');
      console.error(`\n${f}: ${err.message}`);
      if (err.hint) console.error(`hint: ${err.hint}`);
      if (err.position) console.error(`at character ${err.position}`);
      console.error('\nNothing from this file was applied. Fix it and run again.\n');
      process.exitCode = 1;
      return;
    }
  }

  for (const f of skipped) {
    console.log(`  skipped  ${f} (seed — pass --seed to load it)`);
  }

  // The application role needs a password to log in. It is set here, from
  // the environment, so no credential is ever written into a migration.
  const appPassword = process.env.APP_DB_PASSWORD;
  if (appPassword) {
    if (appPassword.length < 16) {
      console.error('\nAPP_DB_PASSWORD must be at least 16 characters.');
      process.exitCode = 1;
      return;
    }
    // ALTER ROLE cannot take a bind parameter, and a $1 inside a DO block is
    // not one either — it is just text in a dollar-quoted string, which is
    // why the obvious version fails with "bind message supplies 1
    // parameters, but prepared statement requires 0".
    //
    // So the literal is built here instead. The password is restricted to
    // printable ASCII with no quotes or backslashes, which leaves nothing
    // that can terminate the literal early.
    if (!/^[!-~]+$/.test(appPassword) || /['"\\]/.test(appPassword)) {
      console.error('\nAPP_DB_PASSWORD must be printable ASCII with no spaces,');
      console.error('quotes or backslashes.\n');
      process.exitCode = 1;
      return;
    }
    const exists = await client.query(`select 1 from pg_roles where rolname = 'app_api'`);
    if (exists.rowCount) {
      await client.query(`alter role app_api login password '${appPassword}'`);
      console.log('  app_api role: login enabled, password set from APP_DB_PASSWORD');
    } else {
      console.log('  app_api role: not present yet (it is created by 0004_roles.sql)');
    }
  } else {
    console.log('  app_api role: APP_DB_PASSWORD not set — the API will not be able to connect');
  }

  // Final guard: prove the application role cannot bypass RLS.
  const check = await client.query(`
    select rolsuper, rolbypassrls, rolcanlogin
      from pg_roles where rolname = 'app_api'`);
  if (check.rowCount) {
    const r = check.rows[0];
    if (r.rolsuper || r.rolbypassrls) {
      console.error('\napp_api has SUPERUSER or BYPASSRLS. Every access policy would be');
      console.error('silently disabled. Revoke those attributes before serving traffic.\n');
      process.exitCode = 1;
      return;
    }
    console.log(`  app_api verified: superuser=false bypassrls=false login=${r.rolcanlogin}`);
  }

  console.log('\nmigrations complete');
}

try {
  await main();
} finally {
  await client.end();
}
