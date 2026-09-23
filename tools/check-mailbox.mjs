/**
 * Exactly what the IMAP sync is using, and whether it opens.
 *
 *     node tools/check-mailbox.mjs teamlinkmed001@tmlink.in
 *
 * Reports the host, port, encryption, username and authentication
 * method actually in play, then tries to open the mailbox and answers
 * with one of three words:
 *
 *     SUCCESS               logged in and selected INBOX
 *     AUTHENTICATION FAILED reached the server; it rejected the login
 *     CONNECTION FAILED     never got as far as a login
 *
 * THE SECRET IS NEVER PRINTED. What is printed about it is its length
 * and whether it still carries quote characters - which is the one
 * property that matters and cannot be guessed at, because `.env` quoting
 * mistakes are invisible everywhere else and look exactly like a wrong
 * password.
 */
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

const envFile = resolve(process.cwd(), process.env.ENV_FILE || '.env');
if (existsSync(envFile) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(envFile);
}

const address = (process.argv[2] || 'teamlinkmed001@tmlink.in').trim();
const { mailboxSecrets, verifyMailbox } = await import('../api/src/intake/mailbox.js');

const key = (suffix) =>
  `MAILBOX_${address.toUpperCase().replace(/@/g, '_AT_').replace(/[^A-Z0-9]+/g, '_')}_${suffix}`;

const s = mailboxSecrets(address);

console.log(`\n  mailbox        ${address}`);
console.log(`  IMAP host      ${s.host || '(none)'}`);
console.log(`  IMAP port      ${s.port}`);
console.log(`  encryption     ${s.port === 993 ? 'implicit TLS (SSL on connect)'
  : s.port === 143 ? 'plain 143 - this client does NOT do STARTTLS' : 'unknown for this port'}`);
console.log(`  username       ${s.user || '(none)'}`);
console.log(`  auth method    IMAP LOGIN (RFC 3501), sent inside the TLS session`);

/* ---- the secret, described but never shown ------------------------- */
const raw = process.env[key('PASSWORD')] !== undefined
  ? { name: key('PASSWORD'), value: process.env[key('PASSWORD')] }
  : process.env[key('TOKEN')] !== undefined
    ? { name: key('TOKEN'), value: process.env[key('TOKEN')] }
    : null;

if (!raw || !raw.value) {
  console.log(`  credential     NOT SET (looked for ${key('PASSWORD')} and ${key('TOKEN')})`);
} else {
  console.log(`  credential     ${raw.name}`);
  console.log(`                 ${raw.value.length} characters`);

  /*
   * The two mistakes that look identical to a wrong password.
   *
   * Quotes that were meant to protect the value but ended up INSIDE it,
   * and whitespace picked up from the end of the line. Both make the
   * server answer "authentication failed" with nothing anywhere to
   * suggest the file is at fault.
   */
  if (/^["'].*["']$/.test(raw.value)) {
    console.log('                 WARNING: it still begins and ends with a quote,');
    console.log('                 so the quotes are part of the password being sent.');
  }
  if (raw.value !== raw.value.trim()) {
    console.log('                 WARNING: it has leading or trailing whitespace.');
  }
  if (/[#]/.test(raw.value)) {
    console.log('                 note: contains #, which .env truncates when unquoted.');
  }
}

/* ---- does it open? ------------------------------------------------- */
const out = await verifyMailbox({ address, provider: 'imap' });

if (out.ok) {
  console.log('\n  SUCCESS\n');
  process.exitCode = 0;
} else if (/AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed|auth/i.test(String(out.error))) {
  console.log('\n  AUTHENTICATION FAILED');
  console.log('  The server answered, so the host, port and TLS are right.');
  console.log('  It rejected the username or the credential.\n');
  process.exitCode = 1;
} else {
  console.log('\n  CONNECTION FAILED');
  console.log(`  ${String(out.error).slice(0, 200)}\n`);
  process.exitCode = 1;
}
