#!/usr/bin/env node
/**
 * Move the data of the local portal (the embedded database in var/dev-db) into a real
 * PostgreSQL server - the one the hosted portal uses.
 *
 * THREE WAYS TO RUN IT
 *
 *   A) straight across (this PC can reach the server's Postgres, e.g. through an SSH tunnel):
 *        node tools/copy-live-to-postgres.mjs --source <copy of var/dev-db> --target <admin postgres url> [--dry-run]
 *
 *   B) through a file - the server's administrator never needs access to this PC:
 *        on this PC:    node tools/copy-live-to-postgres.mjs --source <copy of var/dev-db> --to-file teamlink-data.ndjson.gz
 *        on the server: node copy-live-to-postgres.mjs --from-file teamlink-data.ndjson.gz [--target <admin url>] [--dry-run]
 *      (EXPORT-DATA-FOR-SERVER.bat makes the file; deploy/import-data.sh loads it.)
 *      The file holds only the rows (a few MB, gzipped) - not the 3 GB database folder.
 *
 * BEFORE YOU RUN IT
 *   1. --source is a COPY of the data folder (cp -r var/dev-db var/dev-db-export), or the folder of a
 *      stopped portal. Never the folder a running portal is using.
 *   2. The target is already migrated (tools/migrate.mjs - docker compose's `migrate` step), to the SAME
 *      migrations as the source (by file name; opt-in seed files aside). Otherwise nothing is copied.
 *   3. The target url is an ADMIN (superuser) url - defaults to $ADMIN_DATABASE_URL. The load switches
 *      triggers off for its own session so that copying a row does not fire "a new application was made"
 *      again (no references re-issued, no stage history re-written, no notification queued).
 *
 * WHAT IT DOES - in ONE transaction on the target; if anything fails, nothing is kept:
 *   - empties every table on the target except schema_migrations;
 *   - copies every row of every table, every column both sides share, each value as text cast back to
 *     the target column's own type (arrays, json, timestamps, numerics arrive exactly as they were);
 *     generated columns are recomputed by the target;
 *   - moves every sequence to where it was;
 *   - counts rows on both sides, table by table, and refuses to commit on any difference.
 *
 * NOT COPIED: uploaded files (resumes, documents, recordings) - copy the uploads folder too.
 */
import pg from 'pg';
import { resolve, join, dirname } from 'node:path';
import { existsSync, readFileSync, createReadStream, createWriteStream } from 'node:fs';
import { createGzip, createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const SOURCE = arg('--source');
const TO_FILE = arg('--to-file');
const FROM_FILE = arg('--from-file');
const TARGET = arg('--target') || process.env.ADMIN_DATABASE_URL;
const DRY = process.argv.includes('--dry-run');
const BATCH = Number(arg('--batch') || 300);
const FORMAT = 'teamlink-portal-data';

function usage(msg) {
  if (msg) console.error(msg);
  console.error(`usage:
  node tools/copy-live-to-postgres.mjs --source <copy of var/dev-db> --target <admin postgres url> [--dry-run]
  node tools/copy-live-to-postgres.mjs --source <copy of var/dev-db> --to-file <file.ndjson.gz>
  node tools/copy-live-to-postgres.mjs --from-file <file.ndjson.gz> [--target <admin postgres url>] [--dry-run]`);
  process.exit(2);
}
if (FROM_FILE ? (SOURCE || TO_FILE) : !SOURCE) usage();
if (!TO_FILE && !TARGET) usage('no target: pass --target or set ADMIN_DATABASE_URL');

const ident = (s) => '"' + String(s).replace(/"/g, '""') + '"';
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations');
const isSeed = (f) => /seed/.test(f);          // the same rule as tools/migrate.mjs: seed files are opt-in
/* the checksum tools/migrate.mjs computes ON THE SERVER, whose checkout has LF line endings */
const serverSha = (f) => createHash('sha256').update(readFileSync(join(MIGRATIONS, f), 'utf8').replace(/\r\n/g, '\n')).digest('hex');

const TABLES_SQL = `select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relname <> 'schema_migrations' order by 1`;
const COLS_SQL = `select a.attname as name, format_type(a.atttypid, a.atttypmod) as type, a.attgenerated as gen
  from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = $1 and a.attnum > 0 and not a.attisdropped order by a.attnum`;
const SEQ_SQL = `select sequencename as name, last_value from pg_sequences where schemaname = 'public'`;

/* ---------------------------------------------------------------- the source: a PGlite folder */
async function pgliteSource(dir) {
  const src = resolve(dir);
  if (!existsSync(src)) usage(`no such folder: ${src}`);
  if (/[\\/]var[\\/]dev-db[\\/]?$/.test(src)) {
    usage('Refusing to read var/dev-db directly: point --source at a COPY (cp -r var/dev-db var/dev-db-export), or at the folder of a stopped portal.');
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite(src);
  const q = async (sql, p) => (await db.query(sql, p)).rows;
  return {
    async migrations() { return (await q(`select filename from schema_migrations`)).map((r) => r.filename); },
    async tables() { return (await q(TABLES_SQL)).map((r) => r.name); },
    async cols(t) { return (await q(COLS_SQL, [t])).filter((c) => !c.gen).map((c) => c.name); },
    async count(t) { return Number((await q(`select count(*)::int as n from ${ident(t)}`))[0].n); },
    async *rows(t, cols) {
      const n = await this.count(t);
      const list = cols.map((c) => `${ident(c)}::text as ${ident(c)}`).join(', ');
      for (let off = 0; off < n; off += BATCH) {
        const rows = await q(`select ${list} from ${ident(t)} order by ctid limit ${BATCH} offset ${off}`);
        if (!rows.length) break;
        for (const r of rows) yield cols.map((c) => r[c]);
      }
    },
    async sequences() { return (await q(SEQ_SQL)).filter((s) => s.last_value != null).map((s) => ({ name: s.name, value: String(s.last_value) })); },
    async close() { await db.close().catch(() => {}); },
  };
}

/* ---------------------------------------------------------------- the source: a data file */
async function fileSource(file) {
  const path = resolve(file);
  if (!existsSync(path)) usage(`no such file: ${path}`);
  /* the whole file is read once into memory per table on demand would need random access; the rows
     are small (a portal's data is megabytes), so it is read once and kept */
  const rl = createInterface({ input: createReadStream(path).pipe(createGunzip()), crlfDelay: Infinity });
  let head = null;
  const data = new Map();
  for await (const line of rl) {
    if (!line) continue;
    const o = JSON.parse(line);
    if (!head) {
      if (o.format !== FORMAT || o.version !== 1) throw new Error('this is not a TeamLink portal data file (or a newer version of one)');
      head = o;
      continue;
    }
    if (o.t) { if (!data.has(o.t)) data.set(o.t, []); data.get(o.t).push(o.r); }
  }
  if (!head) throw new Error('the data file is empty');
  for (const t of Object.keys(head.tables)) {
    const got = (data.get(t) || []).length;
    if (got !== head.tables[t].count) throw new Error(`the data file is incomplete: ${t} has ${got} rows of ${head.tables[t].count}`);
  }
  console.log(`data file: exported ${head.exportedAt} from ${head.tables ? Object.keys(head.tables).length : 0} tables`);
  return {
    async migrations() { return head.migrations; },
    async tables() { return Object.keys(head.tables).sort(); },
    async cols(t) { return head.tables[t].cols; },
    async count(t) { return head.tables[t].count; },
    async *rows(t) { for (const r of data.get(t) || []) yield r; },
    async sequences() { return head.sequences; },
    async close() {},
  };
}

/* ---------------------------------------------------------------- PGlite folder -> data file */
async function exportToFile(source, file) {
  const out = resolve(file);
  const tables = await source.tables();
  const head = { format: FORMAT, version: 1, exportedAt: new Date().toISOString(), migrations: await source.migrations(), tables: {}, sequences: await source.sequences() };
  for (const t of tables) head.tables[t] = { cols: await source.cols(t), count: await source.count(t) };
  const gz = createGzip({ level: 9 });
  const ws = createWriteStream(out);
  gz.pipe(ws);
  const write = (o) => new Promise((ok) => { if (gz.write(JSON.stringify(o) + '\n')) ok(); else gz.once('drain', ok); });
  await write(head);
  let total = 0;
  for (const t of tables) {
    let n = 0;
    for await (const r of source.rows(t, head.tables[t].cols)) { await write({ t, r }); n++; }
    if (n !== head.tables[t].count) throw new Error(`row count changed while exporting ${t}: ${n} vs ${head.tables[t].count} - is the portal still running on this folder?`);
    total += n;
  }
  await new Promise((ok, bad) => { ws.on('finish', ok); ws.on('error', bad); gz.end(); });
  console.log(`exported ${tables.length} tables, ${total} rows, ${head.migrations.length} migrations -> ${out}`);
}

/* ---------------------------------------------------------------- source -> PostgreSQL */
async function load(source) {
  const target = new pg.Client({ connectionString: TARGET });
  await target.connect();
  const tq = async (sql, p) => (await target.query(sql, p)).rows;
  try {
    /* 1. the same schema on both sides */
    const migS = new Set(await source.migrations());
    const migT = new Set((await tq(`select filename from schema_migrations`)).map((r) => r.filename));
    const seedOnlyS = [...migS].filter((f) => !migT.has(f) && isSeed(f));
    const onlyS = [...migS].filter((f) => !migT.has(f) && !isSeed(f));
    const onlyT = [...migT].filter((f) => !migS.has(f) && !isSeed(f));
    if (onlyS.length || onlyT.length) {
      throw new Error(`the two databases are not on the same migrations.\n  only on the source: ${onlyS.join(', ') || '-'}\n  only on the target: ${onlyT.join(', ') || '-'}\n  Deploy the same code version to the server (git pull + migrate), or export again from an up-to-date PC.`);
    }
    console.log(`migrations: ${migS.size} on both sides`);

    const tablesS = await source.tables();
    const tablesT = new Set((await tq(TABLES_SQL)).map((r) => r.name));
    const missing = tablesS.filter((t) => !tablesT.has(t));
    if (missing.length) throw new Error(`tables missing on the target: ${missing.join(', ')}`);

    /* 2. one transaction; triggers and foreign-key triggers off for this session only */
    await tq('begin');
    await tq(`set local session_replication_role = replica`);
    await tq(`truncate ${tablesS.map(ident).join(', ')} restart identity cascade`);

    const report = [];
    for (const t of tablesS) {
      const colsS = await source.cols(t);
      const colsT = await tq(COLS_SQL, [t]);
      const typeT = new Map(colsT.filter((c) => !c.gen).map((c) => [c.name, c.type]));
      const keep = colsS.map((c, i) => [c, i]).filter(([c]) => typeT.has(c));
      const skipped = colsS.filter((c) => !typeT.has(c));
      const n = await source.count(t);
      if (n && keep.length) {
        const insertCols = keep.map(([c]) => ident(c)).join(', ');
        let batch = [];
        const flush = async () => {
          if (!batch.length) return;
          const params = [];
          const tuples = batch.map((r) => '(' + keep.map(([c, i]) => { params.push(r[i]); return `$${params.length}::${typeT.get(c)}`; }).join(', ') + ')');
          await tq(`insert into ${ident(t)} (${insertCols}) values ${tuples.join(', ')}`, params);
          batch = [];
        };
        for await (const r of source.rows(t, colsS)) { batch.push(r); if (batch.length >= BATCH) await flush(); }
        await flush();
      }
      const after = Number((await tq(`select count(*)::int as n from ${ident(t)}`))[0].n);
      report.push({ table: t, source: n, target: after });
      if (after !== n) throw new Error(`row count differs for ${t}: source ${n}, target ${after}`);
      if (skipped.length) console.warn(`  ${t}: columns only on the source, not copied: ${skipped.join(', ')}`);
    }

    /* 3. sequences where they were */
    const seqT = new Set((await tq(SEQ_SQL)).map((r) => r.name));
    for (const s of await source.sequences()) {
      if (!seqT.has(s.name)) continue;
      await tq(`select setval($1, $2::bigint, true)`, [`public.${ident(s.name)}`, s.value]);
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
    try { await tq('rollback'); } catch { /* not in a transaction */ }
    throw err;
  } finally {
    await target.end().catch(() => {});
  }
}

let source = null;
try {
  source = FROM_FILE ? await fileSource(FROM_FILE) : await pgliteSource(SOURCE);
  if (TO_FILE) await exportToFile(source, TO_FILE);
  else await load(source);
  await source.close();
  process.exit(0);
} catch (err) {
  console.error((TO_FILE ? 'NOT EXPORTED' : 'NOT COPIED - nothing on the target was changed') + ':\n  ' + (err && err.message));
  if (source) await source.close();
  process.exit(1);
}
