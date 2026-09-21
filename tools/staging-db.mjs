/**
 * A staging PostgreSQL server, for the deployment rehearsal.
 *
 * This exists so the PRODUCTION entry point (api/src/server.js) can be run
 * exactly as it will run on the server: NODE_ENV=production, real config
 * validation, migrations applied by tools/migrate.mjs, connecting as
 * app_api over a real Postgres wire connection.
 *
 * The dev server is deliberately NOT used here — it sets its own defaults
 * and would paper over precisely the misconfiguration a rehearsal is meant
 * to catch.
 *
 *   node tools/staging-db.mjs [port]
 */
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const DIR = process.env.STAGING_DB_DIR || join(ROOT, 'var', 'staging-db');
const PORT = parseInt(process.argv[2], 10) || 5440;

mkdirSync(DIR, { recursive: true });
const db = await new PGlite(DIR);

// The role has to exist and be able to log in before migrate.mjs runs, the
// same way a DBA would provision it on a real server.
await db.exec(`do $$ begin
  if not exists (select 1 from pg_roles where rolname='app_api') then
    create role app_api nologin;
  end if;
end $$;`);

const server = new PGLiteSocketServer({ db, port: PORT, host: '127.0.0.1' });
await server.start();

const ticker = setInterval(() => { db.exec('checkpoint').catch(() => {}); }, 5000);
ticker.unref();

console.log(`staging postgres listening on 127.0.0.1:${PORT}`);
console.log(`  data: ${DIR}`);

const stop = async () => {
  clearInterval(ticker);
  await db.exec('checkpoint').catch(() => {});
  await server.stop().catch(() => {});
  await db.close().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
