/**
 * A real SMTP server on localhost, with an inbox you can open in a browser.
 *
 * mail-sink.mjs proves the portal sends real mail by printing what it
 * receives, which is fine for a verifier and useless for a person: you
 * cannot read an email in a terminal log, you cannot see whether the HTML
 * renders, and you cannot click the link in it.
 *
 * This is the same real SMTP server with a web inbox in front of it:
 *
 *     node tools/mail-inbox.mjs
 *     open http://localhost:2580
 *
 * Point the API at it and every message the portal sends — registration,
 * application confirmation, the AI interview invitation and its reminders,
 * a stage move, an offer, a job alert — arrives here, in full, with its
 * links live:
 *
 *     EMAIL_SMTP_HOST=127.0.0.1 EMAIL_SMTP_PORT=2525 EMAIL_SMTP_SECURE=false \
 *     EMAIL_SMTP_USER=local EMAIL_SMTP_PASS=local \
 *     EMAIL_FROM=jobs@teamlink.local node tools/dev-server.mjs 4323
 *
 * This answers "does the portal send mail, and what does it say" today,
 * without any provider account. It does NOT answer "does mail reach an
 * external inbox" — nothing leaves this machine. That question needs a
 * working mailbox credential and nothing else.
 */
import { SMTPServer } from 'smtp-server';
import { createServer } from 'node:http';

const SMTP_PORT = parseInt(process.env.SINK_SMTP_PORT, 10) || 2525;
const WEB_PORT  = parseInt(process.env.SINK_WEB_PORT, 10)  || 2580;
const KEEP      = 500;

/** @type {{id:number, at:Date, from:string, to:string, subject:string,
 *           text:string, html:string, raw:string}[]} */
const messages = [];
let count = 0;

/* ------------------------------------------------------------------ *
 * parsing enough of a message to show it honestly
 * ------------------------------------------------------------------ */

const header = (raw, name) =>
  (raw.match(new RegExp(`^${name}:\\s*(.+(?:\\r?\\n[ \\t].+)*)$`, 'im')) || [])[1]
    ?.replace(/\r?\n[ \t]+/g, ' ').trim() || '';

/**
 * Quoted-printable, decoded as BYTES and then read as UTF-8.
 *
 * Decoding each =XX straight to a character code treats the message as
 * Latin-1, so every em dash and rupee sign arrives as mojibake - the
 * classic "â€”". The bytes have to be collected first and decoded once.
 */
function decodeQP(s) {
  const src = String(s).replace(/=\r?\n/g, '');
  const bytes = [];
  for (let i = 0; i < src.length; i++) {
    const m = src[i] === '=' && /^[0-9A-F]{2}$/i.test(src.slice(i + 1, i + 3));
    if (m) { bytes.push(parseInt(src.slice(i + 1, i + 3), 16)); i += 2; }
    else bytes.push(src.charCodeAt(i) & 0xff);
  }
  return Buffer.from(bytes).toString('utf8');
}

function decodeBase64(s) {
  try { return Buffer.from(s.replace(/\s+/g, ''), 'base64').toString('utf8'); }
  catch { return s; }
}

/**
 * Split a multipart message into its text and HTML parts.
 *
 * Deliberately small: this is a local inbox for looking at what was sent,
 * not a mail client. Anything it cannot parse is shown as raw source
 * rather than hidden.
 */
function parse(raw) {
  const boundary = (header(raw, 'Content-Type').match(/boundary="?([^";]+)"?/) || [])[1];
  const out = { text: '', html: '' };

  const decodeBody = (partHeaders, body) => {
    const enc = (partHeaders.match(/^Content-Transfer-Encoding:\s*(.+)$/im) || [])[1] || '';
    if (/base64/i.test(enc)) return decodeBase64(body);
    if (/quoted-printable/i.test(enc)) return decodeQP(body);
    return body;
  };

  if (!boundary) {
    const [h, ...rest] = raw.split(/\r?\n\r?\n/);
    const body = decodeBody(h, rest.join('\n\n'));
    if (/text\/html/i.test(header(raw, 'Content-Type'))) out.html = body;
    else out.text = body;
    return out;
  }

  for (const part of raw.split(new RegExp(`--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))) {
    const idx = part.search(/\r?\n\r?\n/);
    if (idx < 0) continue;
    const h = part.slice(0, idx);
    const body = decodeBody(h, part.slice(idx).replace(/^\r?\n\r?\n/, ''));
    if (/text\/html/i.test(h)) out.html = body.trim();
    else if (/text\/plain/i.test(h)) out.text = body.trim();
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * the SMTP server
 * ------------------------------------------------------------------ */

const smtp = new SMTPServer({
  authOptional: false,
  // smtp-server's bundled certificate has expired, and the application is
  // right to refuse an unverifiable TLS peer. Rather than relax that in
  // the app, the sink does not offer STARTTLS at all - this is a loopback
  // connection to a local process, not a network hop.
  hideSTARTTLS: true,
  disabledCommands: ['STARTTLS'],
  // Any credentials are accepted on purpose: a receiving sink bound to
  // loopback, which never relays and never forwards.
  onAuth(auth, _s, cb) { cb(null, { user: auth.username }); },
  onData(stream, _s, cb) {
    let raw = '';
    stream.on('data', (c) => { raw += c; });
    stream.on('end', () => {
      count++;
      const parts = parse(raw);
      messages.unshift({
        id: count,
        at: new Date(),
        from: decodeMime(header(raw, 'From')),
        to: header(raw, 'To'),
        subject: decodeMime(header(raw, 'Subject')),
        text: parts.text,
        html: parts.html,
        raw,
      });
      if (messages.length > KEEP) messages.length = KEEP;
      console.log(`  ${count}. ${messages[0].subject}  ->  ${messages[0].to}`);
      cb();
    });
  },
});

/**
 * =?utf-8?B?...?= header words, as nodemailer writes them.
 *
 * A long subject is split into SEVERAL encoded words across folded lines.
 * RFC 2047 says the whitespace between two adjacent encoded words is not
 * part of the text - keep it and a subject reads "Java Devel oper",
 * because the split can fall mid-character.
 */
function decodeMime(v) {
  const s = String(v || '').replace(/(\?=)\s+(=\?)/g, '$1$2');
  return s.replace(/=\?[^?]+\?([BQ])\?([^?]*)\?=/gi, (_, enc, data) =>
    (enc.toUpperCase() === 'B' ? decodeBase64(data) : decodeQP(data.replace(/_/g, ' '))));
}

/* ------------------------------------------------------------------ *
 * the inbox
 * ------------------------------------------------------------------ */

const esc = (v) => String(v ?? '').replace(/[&<>"]/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const when = (d) => d.toLocaleString('en-GB', {
  day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

function page() {
  const rows = messages.map((m) => `
    <details ${m.id === count ? 'open' : ''}>
      <summary>
        <span class="n">#${m.id}</span>
        <span class="s">${esc(m.subject) || '(no subject)'}</span>
        <span class="t">${esc(m.to)}</span>
        <span class="d">${when(m.at)}</span>
      </summary>
      <div class="meta">from ${esc(m.from)}</div>
      ${m.html
        ? `<iframe sandbox srcdoc="${esc(m.html)}"></iframe>`
        : ''}
      <pre>${esc(m.text || m.raw.slice(0, 4000))}</pre>
    </details>`).join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>TeamLink local inbox</title>
<style>
  :root { color-scheme: light dark; --line:#d9dee7; --soft:#61708a; --bg:#f6f8fb; --card:#fff; }
  @media (prefers-color-scheme: dark) {
    :root { --line:#2a3242; --soft:#93a1b8; --bg:#10141c; --card:#171d28; }
  }
  * { box-sizing: border-box; }
  body { margin:0; padding:20px; background:var(--bg);
         font:14px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif; }
  h1 { font-size:17px; margin:0 0 4px; }
  p.sub { margin:0 0 18px; color:var(--soft); font-size:12.5px; }
  details { background:var(--card); border:1px solid var(--line); border-radius:10px;
            margin-bottom:10px; overflow:hidden; }
  summary { cursor:pointer; padding:11px 14px; display:grid; gap:10px; align-items:baseline;
            grid-template-columns:44px 1fr 220px 130px; }
  @media (max-width:760px) { summary { grid-template-columns:36px 1fr; } .t,.d { display:none; } }
  .n { color:var(--soft); font-variant-numeric:tabular-nums; }
  .s { font-weight:650; }
  .t,.d { color:var(--soft); font-size:12px; overflow:hidden; text-overflow:ellipsis;
          white-space:nowrap; }
  .meta { padding:0 14px 8px; color:var(--soft); font-size:12px; }
  iframe { width:100%; height:340px; border:0; border-top:1px solid var(--line); background:#fff; }
  pre { margin:0; padding:12px 14px; white-space:pre-wrap; word-break:break-word;
        border-top:1px solid var(--line); color:var(--soft); font-size:12.5px; }
  .empty { color:var(--soft); background:var(--card); border:1px dashed var(--line);
           border-radius:10px; padding:26px; text-align:center; }
</style></head>
<body>
  <h1>TeamLink local inbox &middot; ${count} message${count === 1 ? '' : 's'}</h1>
  <p class="sub">
    A real SMTP server on 127.0.0.1:${SMTP_PORT}. Everything the portal sends arrives here.
    Nothing leaves this machine &mdash; this shows WHAT is sent, not that it reaches an
    external mailbox. Refreshes every 3 seconds.
  </p>
  ${rows || '<div class="empty">Nothing yet. Register, apply, or publish a job in the portal.</div>'}
  <script>setTimeout(() => location.reload(), 3000);</script>
</body></html>`;
}

createServer((req, res) => {
  if (req.url === '/messages.json') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(messages.map(({ raw, ...m }) => m), null, 2));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(page());
}).listen(WEB_PORT, '127.0.0.1', () => {
  console.log(`\n  inbox   http://localhost:${WEB_PORT}`);
  console.log(`  smtp    127.0.0.1:${SMTP_PORT}\n`);
});

smtp.on('error', (err) => console.error('sink error:', err.message));
smtp.listen(SMTP_PORT, '127.0.0.1', () => {
  console.log(`SMTP listening on 127.0.0.1:${SMTP_PORT} — open the inbox to read what arrives`);
});
