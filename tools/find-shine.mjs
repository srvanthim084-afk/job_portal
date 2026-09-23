/**
 * Has a Shine email actually arrived?
 *
 * The Shine shapes in intake/source.js are marked `verified: false`
 * because they were written from Shine's documented format and never
 * from a message anybody received. That flag is only worth anything if
 * something occasionally checks it against the real mailbox, so this
 * asks the question directly:
 *
 *     node tools/find-shine.mjs [address]
 *
 * It searches the connected mailbox for anything sent by Shine and, for
 * whatever it finds, prints the sender, the subject and the LABELS in
 * the body - the facts needed to confirm or correct the format.
 *
 * READ ONLY. BODY.PEEK, so nothing is marked seen, nothing is moved and
 * nothing is deleted: a recruiter's inbox is theirs. The password is
 * never printed, and neither is any candidate's personal data - the
 * labels are the format, the values beside them are somebody's life.
 */
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { connect } from 'node:tls';

const envFile = resolve(process.cwd(), process.env.ENV_FILE || '.env');
if (existsSync(envFile) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(envFile);
}

const { mailboxSecrets } = await import('../api/src/intake/mailbox.js');
const { bodyOf, attachmentsOf } = await import('../api/src/intake/mime.js');
const { SOURCES, detectSource } = await import('../api/src/intake/source.js');

const address = process.argv[2] || 'teamlinkmed001@tmlink.in';
const DAYS = Number(process.env.SHINE_DAYS || 120);

const s = mailboxSecrets(address);
if (!s.host || !s.password) {
  console.log(`No IMAP credentials are configured for ${address}.`);
  process.exit(1);
}

const quote = (v) => String(v).replace(/(["\\])/g, '\\$1');

const sock = await new Promise((ok, no) => {
  const c = connect({ host: s.host, port: s.port || 993, servername: s.host }, () => ok(c));
  // latin1 so a byte count and a string index agree - the same reason
  // the sync itself reads this way.
  c.setEncoding('latin1');
  c.once('error', no);
});

let buf = '';
sock.on('data', (d) => { buf += d; });

let tag = 0;
const send = (cmd) => new Promise((ok, no) => {
  const t = `q${++tag}`;
  buf = '';
  sock.write(`${t} ${cmd}\r\n`);
  const done = new RegExp(`^${t} (OK|NO|BAD)([^\r\n]*)`, 'm');
  const timer = setInterval(() => {
    const m = done.exec(buf);
    if (!m) return;
    clearInterval(timer);
    clearTimeout(bail);
    if (m[1] === 'OK') ok(buf); else no(new Error(m[1] + m[2]));
  }, 60);
  const bail = setTimeout(() => {
    clearInterval(timer);
    no(new Error('the mail server did not answer'));
  }, 30000);
});

await new Promise((r) => setTimeout(r, 400));            // the greeting
await send(`LOGIN "${quote(s.user)}" "${quote(s.password)}"`);
await send('SELECT INBOX');

const since = new Date(Date.now() - DAYS * 86400000);
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
             'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const stamp = `${since.getDate()}-${MON[since.getMonth()]}-${since.getFullYear()}`;

/*
 * Searched by SENDER, one domain at a time.
 *
 * The server does the work, so a mailbox holding thousands of messages
 * does not have to cross the network to answer a question about five.
 */
const found = new Set();
for (const domain of SOURCES.shine.domains) {
  let out;
  try { out = await send(`SEARCH SINCE ${stamp} FROM "${domain}"`); }
  catch { continue; }
  const line = /^\* SEARCH([^\r\n]*)/m.exec(out);
  for (const n of (line ? line[1].trim().split(/\s+/) : [])) {
    if (n) found.add(Number(n));
  }
}

console.log(`mailbox : ${address}`);
console.log(`searched: the last ${DAYS} days, for ${SOURCES.shine.domains.join(', ')}`);
console.log(`found   : ${found.size} message(s) from Shine\n`);

const header = (msg, name) => {
  const re = new RegExp(`^${name}\\s*:\\s*([^\\r\\n]*(?:\\r?\\n[ \\t][^\\r\\n]*)*)`, 'im');
  const m = re.exec(msg);
  return m ? m[1].replace(/\r?\n[ \t]+/g, ' ').trim() : '';
};

for (const n of [...found].slice(-10)) {
  let raw;
  try { raw = await send(`FETCH ${n} (BODY.PEEK[])`); } catch { continue; }
  const lit = /\{(\d+)\}\r?\n/.exec(raw);
  const msg = lit
    ? raw.slice(lit.index + lit[0].length, lit.index + lit[0].length + Number(lit[1]))
    : raw;

  const text = bodyOf(msg).text;
  const source = detectSource({ from: header(msg, 'From'), subject: header(msg, 'Subject'), text });

  console.log('-'.repeat(70));
  console.log(`from    : ${header(msg, 'From')}`);
  console.log(`subject : ${header(msg, 'Subject')}`);
  console.log(`date    : ${header(msg, 'Date')}`);
  console.log(`detected: ${source ? `${source.label} - ${source.why}` : 'NOT DETECTED'}`);
  console.log(`files   : ${attachmentsOf(msg).map((a) => a.filename).join(', ') || 'none'}`);

  const labels = [...new Set((text.match(/^[ \t]*[A-Za-z][A-Za-z /&.'-]{2,34}[ \t]*:/gm) || [])
    .map((l) => l.replace(/:$/, '').trim()))];
  console.log(`labels  : ${labels.slice(0, 30).join(' | ') || '(none found)'}`);
}

try { await send('LOGOUT'); } catch { /* closing anyway */ }
sock.end();

if (!found.size) {
  console.log('No Shine message has arrived, so the Shine format stays unverified.');
  console.log('Forward one to this mailbox and run this again - the labels it');
  console.log('prints are what intake/source.js needs to be corrected against.');
}
