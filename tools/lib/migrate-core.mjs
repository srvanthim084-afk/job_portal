/**
 * Applies pending migrations against anything that can run SQL.
 *
 * Shared by tools/migrate.mjs (production, over `pg`) and
 * tools/dev-server.mjs (local, over PGlite) so both use the same
 * `schema_migrations` bookkeeping. Without this the dev server would
 * re-apply every migration on each start, which is harmless against a
 * throwaway database and fatal against a persistent one.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = resolve(HERE, '..', '..', 'supabase', 'migrations');

const sha = (s) => createHash('sha256').update(s).digest('hex');
const isSeed = (f) => /seed/.test(f);

/**
 * Takes TWO primitives, because they are not interchangeable:
 *
 *   exec(sql)          runs a whole migration file. Migration files contain
 *                      many statements, and the extended query protocol
 *                      (prepared statements) rejects those outright with
 *                      "cannot insert multiple commands into a prepared
 *                      statement".
 *   query(sql, params) runs ONE statement with bind parameters.
 *
 * node-postgres blurs the distinction; PGlite does not, which is what
 * forced this apart.
 *
 * @param db   { exec, query }
 * @param opts { seed: boolean, log: fn }
 */
export async function applyPendingMigrations(db, { seed = false, log = () => {} } = {}) {
  const exec = db.exec;
  const query = db.query;

  await exec(`create table if not exists schema_migrations (
    filename    text primary key,
    checksum    text not null,
    applied_at  timestamptz not null default now(),
    duration_ms integer)`);

  const done = await query(`select filename, checksum from schema_migrations`);
  const applied = new Map((done.rows || []).map((r) => [r.filename, r.checksum]));

  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();

  // An applied migration that has since been edited means the database no
  // longer matches the files that produced it.
  const tampered = files.filter((f) =>
    applied.has(f) && applied.get(f) !== sha(readFileSync(join(MIGRATIONS_DIR, f), 'utf8')));
  if (tampered.length) {
    throw new Error(
      `These migrations were edited after being applied: ${tampered.join(', ')}. ` +
      `Write a new migration instead of editing an old one.`);
  }

  const pending = files.filter((f) => !applied.has(f) && (seed || !isSeed(f)));
  const applied_now = [];

  for (const f of pending) {
    const sql = readFileSync(join(MIGRATIONS_DIR, f), 'utf8');
    const started = Date.now();
    await exec(sql);
    await query(
      `insert into schema_migrations (filename, checksum, duration_ms) values ($1,$2,$3)`,
      [f, sha(sql), Date.now() - started]);
    applied_now.push(f);
    log(`  applied ${f} (${Date.now() - started}ms)`);
  }

  const skippedSeed = files.filter((f) => !applied.has(f) && !seed && isSeed(f));
  return { applied: applied_now, alreadyApplied: [...applied.keys()], skippedSeed };
}
