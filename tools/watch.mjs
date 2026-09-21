/**
 * Keeps localhost in step with your edits, and optionally git too.
 *
 *   node tools/watch.mjs                 rebuild + restart on every change
 *   node tools/watch.mjs --push          ...and commit + push to git as well
 *   node tools/watch.mjs --push --every 300   push at most once every 5 min
 *
 * What it watches: api/, tools/, web/build.mjs, web/teamlink-integration.js,
 * web/status.html and supabase/migrations/.
 *
 * On a change it rebuilds web/index.html and restarts the server. The
 * database is NOT touched — it lives in var/dev-db and survives every
 * restart, so your data stays put while the code reloads.
 *
 * ── On --push ─────────────────────────────────────────────────────────
 *
 * Pushing is OFF by default, deliberately. Auto-committing every keystroke
 * to a public repository produces a history nobody can read and, sooner or
 * later, publishes something half-finished. With --push, changes are
 * batched and pushed at most once per interval (default 120s), never
 * mid-edit.
 *
 * Files matching .gitignore are never committed, so var/dev-db — your
 * actual data — is never pushed.
 */
import { watch } from 'node:fs';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const args = process.argv.slice(2);
const DO_PUSH = args.includes('--push');
const PORT = (() => {
  const i = args.indexOf('--port');
  return i >= 0 ? args[i + 1] : '4323';
})();
const PUSH_EVERY = (() => {
  const i = args.indexOf('--every');
  return (i >= 0 ? parseInt(args[i + 1], 10) : 120) * 1000;
})();

const WATCH = [
  'api/src', 'tools', 'supabase/migrations',
  'web/build.mjs', 'web/teamlink-integration.js', 'web/status.html',
].map((p) => join(ROOT, p)).filter(existsSync);

/**
 * "?? path", " M path", "R  old -> new" -> just the file name.
 *
 * A fixed slice(3) looks right and is not: it mangles renames, and a path
 * containing a space comes back quoted.
 */
const fileName = (line) => String(line)
  .replace(/^..\s+/, '')        // drop the two status characters
  .split(' -> ').pop()          // renames report "old -> new"
  .replace(/^"|"$/g, '')        // git quotes paths containing spaces
  .split('/').pop();

const stamp = () => new Date().toLocaleTimeString('en-GB', { hour12: false });
const log = (msg) => console.log(`[${stamp()}] ${msg}`);

/* ------------------------------------------------------------------ *
 * the server
 * ------------------------------------------------------------------ */
let child = null;

function startServer() {
  child = spawn(process.execPath, [join(ROOT, 'tools', 'dev-server.mjs'), PORT], {
    cwd: ROOT, stdio: 'inherit', env: process.env,
  });
  child.on('exit', (code, signal) => {
    if (!restarting && code !== 0 && !signal) {
      log(`server exited with code ${code} — fix the error and save again`);
    }
  });
}

let restarting = false;
async function restart(reason) {
  if (restarting) return;
  restarting = true;
  log(`change in ${reason} — rebuilding`);

  try {
    // web/index.html is generated from the untouched prototype; rebuilding
    // also re-verifies its SHA-256, so a corrupted baseline is caught here
    // rather than in the browser.
    const { stdout } = await execFileAsync(process.execPath, ['web/build.mjs'], { cwd: ROOT });
    const bytes = (stdout.match(/preserved\s*:\s*(\d+)/) || [])[1];
    if (bytes) log(`prototype verified (${bytes} bytes preserved)`);
  } catch (err) {
    log('BUILD FAILED — not restarting:');
    console.error(String(err.stdout || '') + String(err.stderr || err.message));
    restarting = false;
    return;
  }

  if (child) {
    // A clean SIGTERM matters: the dev server checkpoints the database on
    // the way out, so nothing written in the last few seconds is lost.
    await new Promise((done) => {
      child.once('exit', done);
      child.kill('SIGTERM');
      setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} done(); }, 6000);
    });
  }
  startServer();
  restarting = false;
}

/* ------------------------------------------------------------------ *
 * git
 * ------------------------------------------------------------------ */
let pendingPush = false;
let pushTimer = null;

async function git(...a) {
  const { stdout } = await execFileAsync('git', a, { cwd: ROOT });
  return stdout.trim();
}

async function pushNow() {
  pendingPush = false;
  try {
    const dirty = await git('status', '--porcelain');
    if (!dirty) return;

    const files = dirty.split('\n').filter(Boolean);
    const names = files.slice(0, 3).map(fileName).join(', ');
    const more = files.length > 3 ? ` +${files.length - 3} more` : '';

    await git('add', '-A');
    await git('-c', 'core.safecrlf=false', 'commit', '-m',
      `Update ${names}${more}\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>`);
    await git('push', 'origin', 'HEAD');
    log(`pushed to git: ${files.length} file(s) — ${names}${more}`);
  } catch (err) {
    const msg = String(err.stderr || err.message).split('\n')[0];
    log(`git push failed: ${msg}`);
  }
}

function schedulePush() {
  if (!DO_PUSH || pendingPush) return;
  pendingPush = true;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(pushNow, PUSH_EVERY);
}

/* ------------------------------------------------------------------ *
 * watching
 * ------------------------------------------------------------------ */
let debounce = null;
const seen = new Set();

for (const target of WATCH) {
  const isDir = statSync(target).isDirectory();
  watch(target, { recursive: isDir }, (_event, filename) => {
    if (!filename) return;
    const f = String(filename);
    if (f.includes('node_modules') || f.endsWith('~') || f.startsWith('.')) return;
    seen.add(f);
    clearTimeout(debounce);
    // Editors write in bursts; wait for the burst to finish.
    debounce = setTimeout(() => {
      const what = [...seen].slice(0, 2).join(', ') + (seen.size > 2 ? ` +${seen.size - 2}` : '');
      seen.clear();
      restart(what).then(schedulePush);
    }, 400);
  });
}

console.log('');
log(`watching ${WATCH.length} path(s) — edit anything and localhost reloads`);
log(DO_PUSH
  ? `git push: ON, batched every ${PUSH_EVERY / 1000}s`
  : 'git push: off (add --push to sync to git as well)');
console.log('');

startServer();

const bye = async () => {
  if (DO_PUSH && pendingPush) { log('pushing before exit'); await pushNow(); }
  if (child) child.kill('SIGTERM');
  setTimeout(() => process.exit(0), 1500);
};
process.on('SIGINT', bye);
process.on('SIGTERM', bye);
