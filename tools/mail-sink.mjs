/**
 * A real SMTP server, on localhost, that prints what it receives.
 *
 * Not a mock of the provider and not a stub inside the app: an actual mail
 * server speaking the actual protocol. The application connects to it with
 * the same nodemailer transport, the same AUTH, the same DATA command it
 * would use against any host. What arrives here is exactly what would
 * arrive at a real mailbox.
 *
 * It exists because the supplied mailbox credentials are rejected by
 * mail.tmlink.in (535). That leaves one question genuinely open - the
 * password - and this answers everything else: whether the portal composes
 * and sends real mail at every stage. When a working password appears,
 * only EMAIL_SMTP_HOST/USER/PASS change.
 *
 *   node tools/mail-sink.mjs [port]
 */
import { SMTPServer } from 'smtp-server';

const PORT = parseInt(process.argv[2], 10) || 2525;
let count = 0;

const server = new SMTPServer({
  authOptional: false,
  // smtp-server ships a self-signed certificate that has EXPIRED, and the
  // application correctly refuses to talk TLS to a server it cannot verify
  // ("certificate has expired"). That refusal is right and must not be
  // relaxed in the app, so the sink simply does not offer STARTTLS - this
  // is a loopback connection to a local process, not a network hop.
  hideSTARTTLS: true,
  disabledCommands: ['STARTTLS'],
  // Accepts any credentials on purpose: this is a receiving sink for local
  // verification, bound to loopback, not a relay. It never forwards.
  onAuth(auth, _session, cb) { cb(null, { user: auth.username }); },
  onData(stream, _session, cb) {
    let raw = '';
    stream.on('data', (c) => { raw += c; });
    stream.on('end', () => {
      count++;
      const header = (name) => (raw.match(new RegExp(`^${name}:\\s*(.+)$`, 'im')) || [])[1] || '';
      const body = raw.split(/\r?\n\r?\n/).slice(1).join('\n')
        .replace(/=\r?\n/g, '')          // quoted-printable soft breaks
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      console.log(`\n── message ${count} ─────────────────────────────`);
      console.log(`  From    : ${header('From')}`);
      console.log(`  To      : ${header('To')}`);
      console.log(`  Subject : ${header('Subject')}`);
      console.log(`  Body    : ${body.slice(0, 220)}`);
      cb();
    });
  },
});

server.on('error', (err) => console.error('sink error:', err.message));
server.listen(PORT, '127.0.0.1', () => {
  console.log(`SMTP sink listening on 127.0.0.1:${PORT} — every message it receives is printed`);
});
