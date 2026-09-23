/**
 * Empty the portal of everything that was never real.
 *
 *     node tools/purge-demo.mjs              # say what would go
 *     node tools/purge-demo.mjs --confirm    # actually remove it
 *
 * The database ships with a seed: companies, job postings, candidates,
 * applications and a set of staff logins that the login page advertised
 * as "sample accounts". Right for a prototype, wrong for a company about
 * to put its own candidates in - a recruiter cannot tell a seeded
 * application from one of theirs, and neither can a report.
 *
 * Two logins survive, named explicitly rather than guessed at, because a
 * purge that locks everybody out is not a purge, it is an outage:
 *
 *     admin@teamlink.com          the administrator
 *     teamlinkmed001@tmlink.in    the recruiter
 *
 * IRREVERSIBLE. Nothing happens without --confirm.
 */
import { chromium } from 'playwright';

const BASE = (process.env.TL_URL || 'http://localhost:4323/').replace(/\/$/, '');
const PASSWORD = process.env.TL_PASSWORD || 'TeamLink@2026';
const CONFIRM = process.argv.includes('--confirm');
const KEEP = ['admin@teamlink.com', 'teamlinkmed001@tmlink.in'];

const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
await page.goto(`${BASE}/`, { waitUntil: 'load' });
await page.waitForFunction(() => window.TL && window.TL.ready === true, { timeout: 25000 });

const api = async (m, p, b) => {
  const r = await page.evaluate(([mm, pp, bb]) => window.TL.api[mm](pp, bb)
    .then((v) => ({ ok: 1, v }), (e) => ({ ok: 0, c: e.code, m: e.message })), [m, p, b]);
  if (r.ok) return r.v;
  throw new Error(`${r.c || 'FAILED'}: ${r.m || ''}`);
};

try {
  await api('post', '/auth/login',
    { email: 'admin@teamlink.com', password: PASSWORD, role: 'admin' });

  const out = await api('post', '/admin/purge-demo', { confirm: CONFIRM, keep: KEEP });

  /*
   * Before, deleted, after - and `after` is the one that matters.
   *
   * The first version printed the counts it had taken BEFORE deleting,
   * so it reported "REMOVED 403 candidates" whether or not a row went.
   * Row-level security FILTERS a DELETE rather than refusing it: a
   * policy that does not match removes nothing and the statement still
   * succeeds. Only the count afterwards tells the two apart.
   */
  if (!CONFIRM) {
    console.log('\n  WOULD BE REMOVED');
    for (const [k, v] of Object.entries(out.before || {})) {
      console.log(`    ${String(v).padStart(5)}  ${k}`);
    }
    console.log(`\n  kept: ${KEEP.join(', ')}`);
    console.log('\n  Nothing has been deleted. To go ahead:');
    console.log('    node tools/purge-demo.mjs --confirm\n');
    process.exit(0);
  }

  const before = out.before || {};
  const after = out.after || {};
  const deleted = out.deleted || {};

  console.log('\n  table            before  deleted   after');
  let leftover = 0;
  for (const k of Object.keys(before)) {
    const remain = after[k] != null ? after[k] : '?';
    console.log(`    ${k.padEnd(14)} ${String(before[k]).padStart(6)}`
      + `  ${String(deleted[k] != null ? deleted[k] : '-').padStart(7)}`
      + `  ${String(remain).padStart(6)}`);
    if (['applications', 'candidates', 'jobs'].includes(k) && Number(remain) > 0) {
      leftover += Number(remain);
    }
  }
  console.log(`\n  kept: ${KEEP.join(', ')}`);

  if (leftover > 0) {
    console.log(`\n  ${leftover} row(s) SURVIVED. The deletes were filtered, not refused,`);
    console.log('  which is how row-level security declines a DELETE.');
    console.log('  The portal is NOT empty.\n');
    process.exitCode = 1;
  } else {
    console.log('\n  The portal is empty. Import your own data, and the two logins');
    console.log('  above still work.\n');
  }
} catch (err) {
  console.log(`\n  ${err.message}\n`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
