/**
 * Take the sample mailboxes, and everything they invented, back out.
 *
 *     node tools/intake-cleanup.mjs              # say what would go
 *     node tools/intake-cleanup.mjs --confirm    # actually remove it
 *
 * The intake's `mock` provider serves a fixed set of sample Naukri
 * emails so the whole workflow - parsing, the candidate, the
 * application, the message that goes out - can be exercised before
 * anybody hands over a mailbox password. Everything downstream of it is
 * real, which is the point, and also the problem: once a live deployment
 * has run it, the ATS holds applications from candidates who do not
 * exist and nothing on the screen says which is which.
 *
 * This removes them. NOTHING IS DELETED WITHOUT --confirm, and the
 * report is printed either way, because "47 rows removed" after the fact
 * is not a decision anybody got to make.
 *
 * A candidate is only removed when EVERY application they have came from
 * a sample mailbox. Somebody who arrived through the demo and has since
 * applied for a real role is kept, with their real applications.
 *
 * Needs `npm run dev` on :4323.
 */
import { chromium } from 'playwright';

const BASE = (process.env.TL_URL || 'http://localhost:4323/').replace(/\/$/, '');
const PASSWORD = process.env.TL_PASSWORD || 'TeamLink@2026';
const CONFIRM = process.argv.includes('--confirm');

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

  const { mailboxes = [] } = await api('get', '/intake/mailboxes');
  const sample = mailboxes.filter((m) => m.provider === 'mock');
  const real = mailboxes.filter((m) => m.provider !== 'mock');

  console.log(`\n  ${mailboxes.length} mailbox(es) connected: `
    + `${sample.length} sample, ${real.length} real.`);

  if (real.length) {
    console.log('\n  kept, because they are not sample mailboxes:');
    for (const m of real) console.log(`    ${m.address}  (${m.provider})`);
  }

  if (!sample.length) {
    console.log('\n  Nothing to remove.\n');
    process.exit(0);
  }

  const preview = await api('post', '/intake/cleanup', { confirm: false });

  console.log(`\n  ${sample.length} sample mailbox(es) would go, and with them:`);
  console.log(`    ${preview.messages} email(s) in the intake queue`);
  console.log(`    ${preview.applications} application(s) created from them`);
  console.log(`    ${preview.candidates} candidate(s) who exist only because of them`);
  if (preview.keptCandidates) {
    console.log(`\n    ${preview.keptCandidates} candidate(s) KEPT — they also have real`);
    console.log('    applications, so only the demo ones are removed.');
  }

  if (!CONFIRM) {
    console.log('\n  Nothing has been deleted. To go ahead:');
    console.log('    node tools/intake-cleanup.mjs --confirm\n');
    process.exit(0);
  }

  const out = await api('post', '/intake/cleanup', { confirm: true });
  console.log('\n  REMOVED');
  console.log(`    ${out.mailboxes} mailbox(es)`);
  console.log(`    ${out.messages} email(s)`);
  console.log(`    ${out.applications} application(s)`);
  console.log(`    ${out.candidates} candidate(s)`);
  console.log('\n  Connect the real mailbox with provider "imap" and put its');
  console.log('  password in the server environment — never in the browser.\n');
} catch (err) {
  console.log(`\n  ${err.message}\n`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
