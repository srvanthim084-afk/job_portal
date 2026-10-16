/**
 * Try a Gmail / IMAP mailbox login from THIS computer and print the mail server's own answer.
 *
 *   node tools/test-mailbox-login.mjs
 *
 * It asks for the mailbox address and the app password, tries the same login the portal's Connect button tries
 * (imap.gmail.com:993; nothing is saved, nothing is read), and shows exactly what the server said. The password is
 * typed here, in your own terminal: it is not stored, not logged and not sent anywhere except to the mail server.
 *
 * Use it when the portal says "Gmail refused the login": the server's reply says which of the usual causes it is.
 */
import readline from 'node:readline';
import { testImapLogin } from '../api/src/intake/mailbox.js';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
let hiding = false;
const writeOut = rl._writeToOutput;
rl._writeToOutput = function (str) {
  if (hiding) writeOut.call(rl, '*'.repeat(str.replace(/[\r\n]/g, '').length));
  else writeOut.call(rl, str);
};

/* a small line queue, so typed-in and piped-in answers both work */
const queue = [];
let waiter = null;
let ended = false;
rl.on('line', (l) => { if (waiter) { const w = waiter; waiter = null; w(l); } else queue.push(l); });
rl.on('close', () => { ended = true; if (waiter) { const w = waiter; waiter = null; w(''); } });
function ask(question, { hidden = false } = {}) {
  process.stdout.write(question);
  return new Promise((resolve) => {
    const done = (line) => { hiding = false; if (hidden) process.stdout.write('\n'); resolve(line); };
    hiding = hidden;
    if (queue.length) done(queue.shift());
    else if (ended) done('');
    else waiter = done;
  });
}

const HOSTS = { 'gmail.com': 'imap.gmail.com', 'googlemail.com': 'imap.gmail.com', 'outlook.com': 'outlook.office365.com', 'hotmail.com': 'outlook.office365.com' };

const address = (await ask('Mailbox email address: ')).trim();
const domain = (address.split('@')[1] || '').toLowerCase();
const host = process.argv[2] || HOSTS[domain] || (await ask(`IMAP server for ${domain || 'this address'} (for example imap.company.com): `)).trim();
const raw = await ask('App password (typed hidden): ', { hidden: true });
const password = HOSTS[domain] === 'imap.gmail.com' ? raw.replace(/\s+/g, '') : raw.trim();

console.log(`\nTrying ${address} on ${host}:993 ... (password length ${password.length}${password.length === 16 ? ', a normal Google app password length' : ''})`);
const r = await testImapLogin({ host, port: 993, user: address, password });
rl.close();
if (r.ok) {
  console.log('\nOK - the login WORKS. The portal should connect with these same details.');
  console.log('(If the portal still refuses, restart it so it has the latest fix, and leave the Username box empty.)');
  process.exit(0);
}

const msg = String(r.error || '');
console.log('\nREFUSED. The mail server said:\n  ' + msg + '\n');
if (/web login required|continue with the web login|unlock|captcha|https:\/\/accounts\.google\.com/i.test(msg)) {
  console.log('-> Google wants a browser sign-in first. Sign in to this Gmail in a browser, approve any "new sign-in" prompt, then try again.');
} else if (/application-specific password required|app password/i.test(msg)) {
  console.log('-> This account needs an APP password (2-Step Verification must be on). The normal password will never work.');
} else if (/IMAP access is disabled|IMAP is disabled|enable IMAP/i.test(msg)) {
  console.log('-> IMAP is switched off: Gmail -> Settings -> See all settings -> Forwarding and POP/IMAP -> Enable IMAP -> Save.');
} else if (/AUTHENTICATIONFAILED|invalid credentials|login failed|NO /i.test(msg) || r.authFailed) {
  console.log('-> The address and password do not match. Most often the app password was created under a DIFFERENT Google account,');
  console.log('   or has been deleted or replaced. Sign in as THIS address, open https://myaccount.google.com/apppasswords,');
  console.log('   delete the old one, create a new one, and run this again. On a company (Workspace) address the admin may have blocked app passwords.');
} else if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|did not answer|stopped responding/i.test(msg)) {
  console.log('-> This computer could not reach the mail server. Check the internet connection, a firewall or VPN, and the server name.');
}
process.exit(1);
