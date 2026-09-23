/**
 * Connect a real mailbox to the intake, and say what it still needs.
 *
 *     node tools/connect-mailbox.mjs hr@tmlink.in mail.tmlink.in
 *
 * Takes an address and an IMAP host. NEVER a password: the credential is
 * read from the server's environment, keyed on the address, so nothing
 * secret travels through a browser, a chat window or the database, and
 * a compromised recruiter session cannot exfiltrate it.
 *
 * It prints the exact environment variable names to set, and refuses to
 * pretend the mailbox is working until they are.
 *
 * Needs `npm run dev` on :4323.
 */
import { chromium } from 'playwright';

const BASE = (process.env.TL_URL || 'http://localhost:4323/').replace(/\/$/, '');
const PASSWORD = process.env.TL_PASSWORD || 'TeamLink@2026';

const address = (process.argv[2] || '').trim();
const host = (process.argv[3] || '').trim();

if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) {
  console.log('\n  usage: node tools/connect-mailbox.mjs <address> [imap host]\n');
  process.exit(1);
}

const envKey = (suffix) =>
  `MAILBOX_${address.toUpperCase().replace(/@/g, '_AT_').replace(/[^A-Z0-9]+/g, '_')}_${suffix}`;

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
    { email: 'recruiter@teamlink.com', password: PASSWORD, role: 'recruiter' });

  const existing = (await api('get', '/intake/mailboxes')).mailboxes || [];
  const already = existing.find((m) => m.address.toLowerCase() === address.toLowerCase());

  const box = already || (await api('post', '/intake/mailboxes', {
    address, provider: 'imap', displayName: address, autoSync: true,
  })).mailbox;

  console.log(`\n  mailbox   ${box.address}`);
  console.log(`  provider  ${box.provider}`);
  console.log(`  auto-sync ${box.autoSync === false ? 'off' : 'on'}`);
  if (already) console.log('  note      it was already connected');

  const fresh = ((await api('get', '/intake/mailboxes')).mailboxes || [])
    .find((m) => m.id === box.id) || box;

  /*
   * The shape reports what is MISSING, not a boolean - names only, never
   * values, so a screen can say what to set without ever holding a
   * secret. An earlier version of this tool read a `ready` field that
   * does not exist, so a correctly configured mailbox reported itself
   * unconfigured and printed instructions that had already been followed.
   */
  const missing = fresh.missingConfig || [];
  if (!missing.length) {
    console.log('\n  READY. Syncing now…');
    const out = await api('post', '/intake/sync', { mailboxId: box.id });
    const first = (out.synced || [])[0] || {};
    console.log(`    read        ${first.read != null ? first.read : '-'} message(s)`);
    console.log(`    imported    ${out.imported || 0}`);
    console.log(`    needs a job ${out.needsMapping || 0}`);
    console.log(`    ignored     ${first.ignored != null ? first.ignored : '-'}`);
    if (first.error) console.log(`    error       ${first.error}`);
    console.log('\n  It will also sync by itself from now on.\n');
  } else {
    console.log(`\n  NOT READY — the server is missing ${missing.join(', ')}.`);
    console.log('\n  Put these in .env (the file, not the browser) and restart:\n');
    console.log(`    ${envKey('HOST')}=${host || 'mail.example.com'}`);
    console.log(`    ${envKey('PORT')}=993`);
    console.log(`    ${envKey('USER')}=${address}`);
    console.log(`    ${envKey('PASSWORD')}="the mailbox password, in double quotes"`);
    console.log('\n  The quotes matter: .env cuts an unquoted value at the first #.');
    console.log('  Nothing is stored in the database and no screen ever shows it.');
    console.log('\n  Then: node tools/connect-mailbox.mjs ' + address + '\n');
    process.exitCode = 1;
  }
} catch (err) {
  console.log(`\n  ${err.message}\n`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
