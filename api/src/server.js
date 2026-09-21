/**
 * Entry point.
 *
 * Two checks run before the server accepts a request, both of which fail
 * loudly rather than degrading quietly:
 *
 *   1. assertConfig()      — no missing or placeholder secrets
 *   2. assertUnprivileged() — the database role is NOT a superuser
 *
 * The second matters most. RLS does not apply to superusers, so connecting
 * as `postgres` would disable every access policy while the application
 * carried on looking completely normal. Refusing to boot is the only way
 * that failure gets noticed.
 */
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { config, assertConfig } from './config.js';
import { createApp } from './app.js';
import { getPool, assertUnprivileged, closePool } from './db.js';

async function main() {
  assertConfig();

  const client = await getPool().connect();
  let dbUser;
  try {
    dbUser = await assertUnprivileged(client);
    await client.query('select 1');
  } finally {
    client.release();
  }

  // serve the prototype from ../../web if it has been staged there
  const webDir = resolve(process.cwd(), process.env.WEB_DIR || '../web');
  const serveStatic = existsSync(webDir) ? webDir : null;

  const app = createApp({ serveStatic });

  const server = app.listen(config.port, () => {
    console.log(`TeamLink API listening on :${config.port}`);
    console.log(`  env      ${config.env}`);
    console.log(`  db user  ${dbUser} (unprivileged — RLS enforced)`);
    console.log(`  storage  ${config.storageDriver}`);
    console.log(`  static   ${serveStatic || '(none — API only)'}`);
  });

  const shutdown = async (signal) => {
    console.log(`\n${signal} received, shutting down`);
    server.close(async () => { await closePool(); process.exit(0); });
    // don't hang forever on a stuck connection
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('\nFailed to start:\n');
  console.error(err.message);
  process.exit(1);
});
