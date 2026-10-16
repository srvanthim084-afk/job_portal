/**
 * Shrink the old database backups in var/ WITHOUT losing any of them.
 *
 *   node tools/compress-old-backups.mjs [keep=3]
 *
 * Every `var/dev-db-backup-<time>` folder is a full copy of the database (about 3.9 GB each) and they pile up, one per
 * live restart, until the disk is full - and a full disk is what makes the server stop. This packs each OLD one into
 * `var/dev-db-backup-<time>.tar.gz` (a database folder compresses to a fraction of its size), checks the archive reads back
 * with the same number of files, and only THEN removes the original folder. The newest `keep` backups are left untouched.
 *
 * Nothing is deleted unless its archive has been verified; a half-written archive is thrown away and the folder stays.
 * To restore one:   tar -xzf var/dev-db-backup-<time>.tar.gz -C var      (then copy the folder over var/dev-db when the server is stopped)
 */
import { readdirSync, statSync, existsSync, rmSync, renameSync, statfsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const VAR = process.env.BACKUP_VAR_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', 'var');
const TAR = process.env.SystemRoot ? join(process.env.SystemRoot, 'System32', 'tar.exe') : 'tar';   // the Windows tar, not a Git-bash one that reads C: as a host
const KEEP = Math.max(1, parseInt(process.argv[2], 10) || 3);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const freeGB = () => { const s = statfsSync(VAR); return (s.bavail * s.bsize) / 1024 ** 3; };
const countFiles = (dir) => {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) n += e.isDirectory() ? countFiles(join(dir, e.name)) : 1;
  return n;
};
const FLOOR_GB = Number(process.env.BACKUP_FREE_FLOOR_GB || 0.35);   // never let packing take the disk below this: the live server writes to it
const run = (cmd, args, { capture = false, guard = false } = {}) => new Promise((resolve) => {
  const p = spawn(cmd, args, { stdio: ['ignore', capture ? 'pipe' : 'ignore', 'ignore'], windowsHide: true });
  let out = '';
  let watch = null, starved = false;
  if (guard) watch = setInterval(() => { if (freeGB() < FLOOR_GB) { starved = true; try { p.kill(); } catch { /* gone */ } } }, 1000);
  if (capture) p.stdout.on('data', (d) => { out += d; });
  p.on('error', () => { if (watch) clearInterval(watch); resolve({ code: -1, out }); });
  p.on('close', (code) => { if (watch) clearInterval(watch); resolve({ code: starved ? -2 : code, out, starved }); });
});

const dirs = readdirSync(VAR, { withFileTypes: true })
  .filter((e) => e.isDirectory() && /^dev-db-backup-/.test(e.name))
  .map((e) => e.name).sort();                       // oldest first (the names are timestamps)
const old = dirs.slice(0, Math.max(0, dirs.length - KEEP));
log(`${dirs.length} backup folders; keeping the newest ${KEEP}; packing ${old.length}. Free now: ${freeGB().toFixed(1)} GB`);

let packed = 0, failed = 0;
for (const name of old) {
  const dir = join(VAR, name);
  const archive = join(VAR, `${name}.tar.gz`);
  const part = `${archive}.part`;
  if (existsSync(part)) rmSync(part, { force: true });
  if (freeGB() < FLOOR_GB + 0.4) { log(`stopping: only ${freeGB().toFixed(2)} GB free, not enough room to pack safely`); break; }

  const started = Date.now();
  const made = await run(TAR, ['-czf', part, '-C', VAR, name], { guard: true });
  if (made.starved) { log(`${name}: the archive was growing past the free space (${FLOOR_GB} GB must stay free) - abandoned, folder kept`); rmSync(part, { force: true }); failed += 1; break; }
  if (made.code !== 0 || !existsSync(part)) { log(`FAILED to pack ${name} (tar exit ${made.code}) - folder kept`); rmSync(part, { force: true }); failed += 1; break; }

  /* the archive must read back and hold every file the folder holds */
  const listed = await run(TAR, ['-tzf', part], { capture: true });
  const entries = listed.out.split(/\r?\n/).filter((l) => l && !l.endsWith('/')).length;
  const files = countFiles(dir);
  if (listed.code !== 0 || entries !== files) {
    log(`VERIFY FAILED for ${name}: archive lists ${entries} files, folder has ${files} - archive discarded, folder kept`);
    rmSync(part, { force: true }); failed += 1; break;
  }
  renameSync(part, archive);
  rmSync(dir, { recursive: true, force: true });
  packed += 1;
  log(`packed ${name}: ${(statSync(archive).size / 1024 ** 3).toFixed(2)} GB (${files} files, ${Math.round((Date.now() - started) / 1000)} s). Free now: ${freeGB().toFixed(1)} GB`);
}
log(`done: ${packed} packed, ${failed} failed. Free: ${freeGB().toFixed(1)} GB`);
