/**
 * Runs the whole application locally: database + API + the prototype.
 *
 *   node tools/dev-server.mjs [port]
 *
 * TWO DATABASE MODES, chosen by whether DATABASE_URL is set.
 *
 * ── A. DATABASE_URL set  → a REAL PostgreSQL server ───────────────────
 *
 *     DATABASE_URL=postgres://app_api:pw@host:5432/teamlink \
 *     ADMIN_DATABASE_URL=postgres://postgres:pw@host:5432/teamlink \
 *     node tools/dev-server.mjs 4323
 *
 *   This is the architecture to develop against. It is byte-for-byte the
 *   same stack production runs, and if the URL points at the database
 *   production will use, then local and live genuinely share one dataset —
 *   records entered here are the records the deployed site serves.
 *
 * ── B. No DATABASE_URL  → an embedded Postgres, ON DISK ───────────────
 *
 *   PGlite is real PostgreSQL compiled to WebAssembly, stored under
 *   var/dev-db. Nothing to install, and data SURVIVES restarts.
 *
 *   It is for working offline before a server exists. It is a single-user
 *   embedded engine, so it is not what production should run — but the
 *   schema and every migration are identical, and tools/export-data.mjs
 *   moves the contents into a real Postgres when you are ready.
 *
 * The previous version of this file used `new PGlite()` with no path: an
 * IN-MEMORY database that discarded everything on restart. That is fine
 * for a test run and catastrophic for real data entry, which is why the
 * mode is now explicit and printed at boot.
 */
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyPendingMigrations } from './lib/migrate-core.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const WEB  = join(ROOT, 'web');

const PORT     = parseInt(process.argv[2], 10) || 4323;
const PG_PORT  = parseInt(process.env.PG_PORT, 10) || 5434;
const DEV_DB   = process.env.DEV_DB_DIR || join(ROOT, 'var', 'dev-db');
const LOAD_SEED = process.env.LOAD_SEED === 'true';
const DEV_PASSWORD = process.env.DEV_PASSWORD || 'TeamLink@2026';

/* ------------------------------------------------------------------ *
 * Configuration defaults.
 *
 * These MUST be set before anything imports api/src/config.js, because
 * that module reads process.env once, at import time, and keeps what it
 * finds. This block used to sit further down, next to the createApp()
 * import - which was fine until the database needed seeding: that path
 * imports api/src/auth.js, which pulls in config.js, ON A FIRST RUN ONLY.
 *
 * So a fresh checkout came up with PUBLIC_ORIGIN still at its library
 * default (http://localhost:8080) instead of this port. The origin check
 * then rejected every POST from the browser with
 * 403 "Origin not allowed." - login, apply, everything - while the same
 * commands worked from curl, which sends no Origin header. Restarting the
 * server "fixed" it, because the second run skips seeding.
 * ------------------------------------------------------------------ */
process.env.NODE_ENV = process.env.NODE_ENV || 'development';
process.env.AUTH_SECRET = process.env.AUTH_SECRET
  || 'dev-secret-not-for-production-0000000000000000';
// localhost, not 127.0.0.1. They are the same machine but NOT the same
// site to a browser: a session cookie set on one is not sent to the
// other, so a page served from localhost talking to an API on the IP
// signs you in and then behaves as though you never did. Naming one of
// them everywhere is what keeps that from happening by accident.
process.env.PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || `http://localhost:${PORT}`;
process.env.STORAGE_DRIVER = process.env.STORAGE_DRIVER || 'local';
process.env.STORAGE_LOCAL_DIR = process.env.STORAGE_LOCAL_DIR || join(ROOT, 'var', 'uploads');
process.env.BCRYPT_ROUNDS = process.env.BCRYPT_ROUNDS || '10';
process.env.RATE_LIMIT_MAX = process.env.RATE_LIMIT_MAX || '100000';
process.env.LOGIN_RATE_LIMIT_MAX = process.env.LOGIN_RATE_LIMIT_MAX || '1000';

if (!existsSync(join(WEB, 'index.html'))) {
  console.error('web/index.html is missing — run `node web/build.mjs` first.');
  process.exit(1);
}

const REAL_DB = !!process.env.DATABASE_URL;
let stopDb = async () => {};
let describeDb = '';
let seedAccounts = [];

/* ------------------------------------------------------------------ *
 * A. real PostgreSQL
 * ------------------------------------------------------------------ */
if (REAL_DB) {
  const pg = (await import('pg')).default;
  const adminUrl = process.env.ADMIN_DATABASE_URL || process.env.DATABASE_URL;

  console.log('database: REAL PostgreSQL');
  const admin = new pg.Client({
    connectionString: adminUrl,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  });
  await admin.connect();
  try {
    const res = await applyPendingMigrations({
      // node-postgres runs multi-statement SQL through the simple protocol
      // when no parameters are supplied, so one method serves both roles.
      exec: (sql) => admin.query(sql),
      query: (sql, params) => admin.query(sql, params),
    }, { seed: LOAD_SEED, log: console.log });
    console.log(`  migrations: ${res.applied.length} applied, ${res.alreadyApplied.length} already present`);
    if (res.skippedSeed.length) {
      console.log(`  seed skipped (set LOAD_SEED=true to load demo content)`);
    }
    const who = await admin.query(`select current_database() db, current_user usr, version() v`);
    describeDb = `${who.rows[0].db} as ${who.rows[0].usr}`;
    console.log(`  ${who.rows[0].v.split(',')[0]}`);
  } finally {
    await admin.end();
  }

  // The API uses DATABASE_URL as given — no override, so what runs here is
  // exactly what runs in production.
  stopDb = async () => {};

/* ------------------------------------------------------------------ *
 * B. embedded Postgres, persisted to disk
 * ------------------------------------------------------------------ */
} else {
  const { PGlite } = await import('@electric-sql/pglite');
  const { PGLiteSocketServer } = await import('@electric-sql/pglite-socket');

  mkdirSync(DEV_DB, { recursive: true });
  const firstRun = !existsSync(join(DEV_DB, 'PG_VERSION'));

  console.log(`database: embedded PostgreSQL, persisted at ${DEV_DB}`);
  console.log(firstRun ? '  (new database — creating schema)' : '  (existing database — data preserved)');

  const db = await new PGlite(DEV_DB);

  const res = await applyPendingMigrations({
    exec: (sql) => db.exec(sql),
    query: (sql, params) => db.query(sql, params),
  }, { seed: LOAD_SEED, log: console.log });
  console.log(`  migrations: ${res.applied.length} applied, ${res.alreadyApplied.length} already present`);
  if (res.skippedSeed.length) {
    console.log('  seed skipped (set LOAD_SEED=true to load demo content)');
  }

  // app_api must be able to log in over the wire.
  await db.exec(`do $$ begin
    if exists (select 1 from pg_roles where rolname='app_api') then
      alter role app_api login password 'dev_only_password';
    end if; end $$;`);

  const pgServer = new PGLiteSocketServer({ db, port: PG_PORT, host: '127.0.0.1' });
  await pgServer.start();

  process.env.DATABASE_URL = `postgres://postgres:postgres@127.0.0.1:${PG_PORT}/postgres`;
  process.env.DB_ROLE = 'app_api';      // drop privileges so RLS applies
  process.env.DB_POOL_MAX = '1';        // pglite-socket serves one connection

  describeDb = `embedded (${DEV_DB})`;

  /**
   * Force a durable flush on a timer.
   *
   * PGlite buffers writes and only flushes them on a clean close(). Kill
   * the process instead — a crash, Task Manager, `kill -9` — and recent
   * writes are simply gone, even though the API reported success and the
   * UI showed the record. That is not theoretical: a job created through
   * the status page vanished when the process was killed a second later.
   *
   * CHECKPOINT forces the flush, bounding the exposure to whatever has
   * happened since the last one rather than the whole session.
   *
   * This is a MITIGATION, not crash safety. An embedded engine is for
   * development. Real business data belongs on a real PostgreSQL server —
   * set DATABASE_URL and this entire branch is skipped.
   */
  const CHECKPOINT_MS = parseInt(process.env.CHECKPOINT_MS, 10) || 5000;
  const ticker = setInterval(() => { db.exec('checkpoint').catch(() => {}); }, CHECKPOINT_MS);
  ticker.unref();

  stopDb = async () => {
    clearInterval(ticker);
    await db.exec('checkpoint').catch(() => {});
    await pgServer.stop().catch(() => {});
    await db.close().catch(() => {});
  };

  // Give the seeded profiles logins, but only the first time — never
  // overwrite credentials on an existing database.
  const need = await db.query(
    `select count(*)::int n from users`).catch(() => ({ rows: [{ n: 0 }] }));
  if (need.rows[0].n === 0) {
    const { hashPassword } = await import('../api/src/auth.js');
    const hash = await hashPassword(DEV_PASSWORD);

    // The seed comes from the prototype, which has no BDE - the role did not
    // exist there. One is created here so there is somebody to sign in as,
    // attached to a real company so the company-scoped policies have
    // something to act on. In production a BDE is created by an
    // administrator through POST /api/bdes, like any other staff account.
    const anyBde = await db.query(`select count(*)::int n from bde_users`)
      .catch(() => ({ rows: [{ n: 0 }] }));
    if (anyBde.rows[0].n === 0) {
      const co = await db.query(`select id from companies order by name limit 1`);
      await db.query(
        `insert into bde_users (id, name, email, company_id, title, initials)
         values ('bde1', 'Priya Nair', 'bde@teamlink.com', $1,
                 'Business Development Executive', 'PN')`,
        [co.rows[0] ? co.rows[0].id : null]);
    }

    for (const [table, role] of [
      ['admins', 'admin'], ['recruiters', 'recruiter'],
      ['client_users', 'client'], ['bde_users', 'bde'], ['candidates', 'candidate'],
    ]) {
      const { rows } = await db.query(
        `select id, email from ${table} where user_id is null order by id`);
      for (const p of rows) {
        if (!p.email) continue;
        const u = await db.query(
          `insert into users (email,password_hash,role) values ($1,$2,$3) returning id`,
          [p.email, hash, role]);
        await db.query(`update ${table} set user_id=$1 where id=$2`, [u.rows[0].id, p.id]);
        seedAccounts.push({ role, email: p.email });
      }
    }
    if (seedAccounts.length) console.log(`  created ${seedAccounts.length} login accounts`);
  }
}

/* ------------------------------------------------------------------ *
 * the application
 * ------------------------------------------------------------------ */
const { createApp } = await import('../api/src/app.js');
const { getPool, assertUnprivileged, closePool } = await import('../api/src/db.js');
const { providerStatus } = await import('../api/src/notify/providers.js');

const c = await getPool().connect();
let dbUser;
try { dbUser = await assertUnprivileged(c); } finally { c.release(); }

const app = createApp({ serveStatic: WEB });
const server = app.listen(PORT, () => {
  console.log(`\nTeamLink: http://localhost:${PORT}/`);
  console.log(`  database : ${describeDb}`);
  console.log(`  db role  : ${dbUser} (unprivileged — RLS enforced)`);
  console.log(`  storage  : ${process.env.STORAGE_LOCAL_DIR}`);
  console.log(`  providers: ${JSON.stringify(providerStatus())}`);
  console.log(REAL_DB
    ? '\n  PERSISTENT — a real PostgreSQL server.'
    : '\n  PERSISTENT — written to disk, checkpointed every '
      + ((parseInt(process.env.CHECKPOINT_MS, 10) || 5000) / 1000) + 's.'
      + '\n  NOTE: an embedded engine can lose the last few seconds of writes if'
      + '\n  the process is KILLED rather than stopped cleanly. For real business'
      + '\n  data, point DATABASE_URL at a real PostgreSQL server.');
  if (seedAccounts.length) {
    console.log(`\n  sign in with password: ${DEV_PASSWORD}`);
    for (const a of seedAccounts.filter((a) => a.role !== 'candidate').slice(0, 4)) {
      console.log(`    ${a.role.padEnd(10)} ${a.email}`);
    }
  }
  console.log('');
});

const stop = async () => {
  server.close();
  await closePool().catch(() => {});
  await stopDb();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
