#!/usr/bin/env node
/**
 * Copy the data of the local portal (the embedded database in var/dev-db)
 * into a real PostgreSQL server - the one the hosted portal will use.
 *
 *     node tools/copy-live-to-postgres.mjs --source <copy of var/dev-db> --target <admin postgres url> [--dry-run]
 *
 * BEFORE YOU RUN IT
 *   1. Take a COPY of the data folder (cp -r var/dev-db var/dev-db-export) - or stop the
 *      local server first. Never point --source at the folder a running server is using:
 *      a folder copied or read while it is being written can be inconsistent.
 *   2. Migrate the target first: ADMIN_DATABASE_URL=<url> node tools/migrate.mjs
 *      (the server's docker-compose does this in its `migrate` container). The two sides
 *      must have applied the SAME migrations (by file name) or nothing is copied.
 *   3. Use the target's ADMIN url (a superuser): the load switches triggers off for its own
 *      session so that copying a row does not fire "a new application was made" again
 *      (no reference numbers re-issued, no stage history re-written, no notification queued).
 *
 * WHAT IT DOES - in ONE transaction on the target; if anything fails, nothing is kept:
 *   - empties every table on the target except schema_migrations (the seed rows the
 *     migrations inserted are replaced by the live ones);
 *   - copies every row of every table, every column the two sides share, value by value as
 *     text cast back to the target column's own type (so arrays, json, timestamps and numerics
 *     arrive exactly as they were); generated columns are recomputed by the target;
 *   - moves every sequence to where it was;
 *   - counts the rows on both sides, table by table, and refuses to commit on any difference.
 *
 * WHAT IT DOES NOT COPY: uploaded files (resumes, documents, recordings). They are files, not
 * rows - copy the uploads folder (STORAGE_LOCAL_DIR, default var/uploads) to the server's
 * storage volume as well. See docs/WEBSITE-JOBS.md.
 */
import pg from 'pg';
import { resolve, join, dirname } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const SOURCE = arg('--source');
const TARGET = arg('--target') || process.env.ADMIN_DATABASE_URL;
const DRY = process.argv.includes('--dry-run');
const BATCH = Number(arg('--batch') || 300);

if (!SOURCE || !TARGET) {
  console.error('usage: node tools/copy-live-to-postgres.mjs --source <copy of var/dev-db> --target <admin postgres url> [--dry-run]');
  process.exit(2);
}
const src = resolve(SOURCE);
if (!existsSync(src)) { console.error(`no such folder: ${src}`); process.exit(2); }
if (/[\\/]var[\\/]dev-db[\\/]?$/.test(src)) {
  console.error('Refusing to read var/dev-db directly: point --source at a COPY (cp -r var/dev-db var/dev-db-export), or stop the local server and pass --source var/dev-db-export after copying.');
  process.exit(2);
}

const ident = (s) => '"' + String(s).replace(/"/g, '""') + '"';
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations');
const isSeed = (f) => /seed/.test(f);          // the same rule as tools/migrate.mjs: seed files are opt-in
/* the checksum tools/migrate.mjs computes ON THE SERVER, whose checkout has LF line endings */
const serverSha = (f) => createHash('sha256').update(readFileSync(join(MIGRATIONS, f), 'utf8').replace(/\r\n/g, '\n')).digest('hex');

const { PGlite } = await import('@electric-sql/pglite');
const source = new PGlite(src);
const sq = async (sql, p) => (await source.query(sql, p)).rows;
const target = new pg.Client({ connectionString: TARGET });
await target.connect();
const tq = async (sql, p) => (await target.query(sql, p)).rows;

const TABLES_SQL = `select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relname <> 'schema_migrations' order by 1`;
const COLS_SQL = `select a.attname as name, format_type(a.atttypid, a.atttypmod) as type, a.attgenerated as gen
  from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = $1 and a.attnum > 0 and not a.attisdropped order by a.attnum`;
const SEQ_SQL = `select sequencename as name, last_value, (last_value is not null) as called from pg_sequences where schemaname = 'public'`;

let exitCode = 0;
try {
  /* 1. the same schema on both sides */
  const migS = new Set((await sq(`select filename from schema_migrations`)).map((r) => r.filename));
  const migT = new Set((await tq(`select filename from schema_migrations`)).map((r) => r.filename));
  /* seed files are opt-in (tools/migrate.mjs skips them in production): the local database may
     have loaded one the server has not - its rows arrive with the data, and it is recorded below */
  const seedOnlyS = [...migS].filter((f) => !migT.has(f) && isSeed(f));
  const onlyS = [...migS].filter((f) => !migT.has(f) && !isSeed(f));
  const onlyT = [...migT].filter((f) => !migS.has(f) && !isSeed(f));
  if (onlyS.length || onlyT.length) {
    throw new Error(`the two databases are not on the same migrations.\n  only on the source: ${onlyS.join(', ') || '-'}\n  only on the target: ${onlyT.join(', ') || '-'}\n  Run tools/migrate.mjs against the target (and update the code) until they match.`);
  }
  console.log(`migrations: ${migS.size} on both sides`);

  const tablesS = (await sq(TABLES_SQL)).map((r) => r.name);
  const tablesT = new Set((await tq(TABLES_SQL)).map((r) => r.name));
  const missing = tablesS.filter((t) => !tablesT.has(t));
  if (missing.length) throw new Error(`tables missing on the target: ${missing.join(', ')}`);

  /* 2. one transaction; triggers and foreign-key triggers off for this session only */
  await tq('begin');
  await tq(`set local session_replication_role = replica`);
  await tq(`truncate ${tablesS.map(ident).join(', ')} restart identity cascade`);

  const report = [];
  for (const t of tablesS) {
    const colsS = await sq(COLS_SQL, [t]);
    const colsT = await tq(COLS_SQL, [t]);
    const typeT = new Map(colsT.filter((c) => !c.gen).map((c) => [c.name, c.type]));
    const cols = colsS.filter((c) => !c.gen && typeT.has(c.name)).map((c) => c.name);
    const skipped = colsS.filter((c) => !c.gen && !typeT.has(c.name)).map((c) => c.name);
    const n = Number((await sq(`select count(*)::int as n from ${ident(t)}`))[0].n);
    let copied = 0;
    if (n && cols.length) {
      const selectList = cols.map((c) => `${ident(c)}::text as ${ident(c)}`).join(', ');
      const insertCols = cols.map(ident).join(', ');
      for (let off = 0; off < n; off += BATCH) {
        const rows = await sq(`select ${selectList} from ${ident(t)} order by ctid limit ${BATCH} offset ${off}`);
        if (!rows.length) break;
        const params = [];
        const tuples = rows.map((r) => '(' + cols.map((c) => {
          params.push(r[c]);
          return `$${params.length}::${typeT.get(c)}`;
        }).join(', ') + ')');
        await tq(`insert into ${ident(t)} (${insertCols}) values ${tuples.join(', ')}`, params);
        copied += rows.length;
      }
    }
    const after = Number((await tq(`select count(*)::int as n from ${ident(t)}`))[0].n);
    report.push({ table: t, source: n, target: after, skipped: skipped.join(' ') });
    if (after !== n) throw new Error(`row count differs for ${t}: source ${n}, target ${after}`);
    if (skipped.length) console.warn(`  ${t}: columns only on the source, not copied: ${skipped.join(', ')}`);
  }

  /* 3. sequences where they were */
  const seqT = new Set((await tq(SEQ_SQL)).map((r) => r.name));
  for (const s of await sq(SEQ_SQL)) {
    if (!seqT.has(s.name) || s.last_value == null) continue;
    await tq(`select setval($1, $2, true)`, [`public.${ident(s.name)}`, s.last_value]);
  }

  /* the seed migrations the data came with, so a later `migrate --seed` does not load them twice */
  for (const f of seedOnlyS) {
    if (!existsSync(join(MIGRATIONS, f))) continue;
    await tq(`insert into schema_migrations (filename, checksum, duration_ms) values ($1, $2, 0) on conflict (filename) do nothing`, [f, serverSha(f)]);
    console.log(`  recorded seed migration ${f} on the target (its rows came with the data)`);
  }

  const total = report.reduce((a, r) => a + r.source, 0);
  console.table(report.filter((r) => r.source > 0));
  console.log(`${report.length} tables, ${total} rows - every count matches.`);
  if (DRY) { await tq('rollback'); console.log('--dry-run: everything checked, nothing kept (rolled back).'); }
  else { await tq('commit'); console.log('committed.'); }
} catch (err) {
  exitCode = 1;
  try { await tq('rollback'); } catch { /* not in a transaction */ }
  console.error('NOT COPIED - nothing on the target was changed:\n  ' + (err && err.message));
} finally {
  await target.end().catch(() => {});
  await source.close().catch(() => {});
}
process.exit(exitCode);
