/**
 * Push whatever has changed to git, in one command.
 *
 *   npm run sync                 auto-generated message
 *   npm run sync "what I did"    your own message
 *
 * Use this when you want to push deliberately. `npm run watch:push` does
 * the same thing automatically on a timer while you work.
 *
 * .gitignore keeps var/dev-db out, so your data is never pushed.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const git = async (...a) => (await run('git', a, { cwd: ROOT })).stdout.trim();

const dirty = await git('status', '--porcelain');
if (!dirty) { console.log('nothing to push — working tree is clean'); process.exit(0); }

const files = dirty.split('\n').filter(Boolean);
console.log(`${files.length} change(s):`);
for (const f of files.slice(0, 12)) console.log('  ' + f);
if (files.length > 12) console.log(`  …and ${files.length - 12} more`);

const msg = process.argv.slice(2).join(' ')
  || `Update ${files.slice(0, 3).map((l) => l.slice(3).split('/').pop()).join(', ')}`
     + (files.length > 3 ? ` +${files.length - 3} more` : '');

await git('add', '-A');
await git('-c', 'core.safecrlf=false', 'commit', '-m',
  `${msg}\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>`);
await git('push', 'origin', 'HEAD');

console.log(`\npushed: ${await git('log', '--oneline', '-1')}`);
