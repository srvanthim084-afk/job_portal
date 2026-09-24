/**
 * Reading a recruiter's inbox.
 *
 * Four providers behind one interface, chosen per mailbox:
 *
 *   mock     a local inbox of sample Naukri emails. Everything downstream
 *            is the real thing - the parsing, the candidate, the
 *            application, the email that goes out - so the whole workflow
 *            runs and is testable before anybody hands over a password.
 *   imap     what most company mailboxes actually are, including the
 *            TeamLink one. A minimal client: LOGIN, SELECT, SEARCH,
 *            FETCH, STORE. No dependency, because the alternative is a
 *            large tree for five commands.
 *   gmail    the REST API with an OAuth access token.
 *   outlook  Microsoft Graph, same shape.
 *
 * Credentials NEVER come from the database or the browser. They are read
 * from the environment, per mailbox address, so a compromised recruiter
 * session cannot exfiltrate them and the UI has no field to leak.
 */
import { connect as tlsConnect } from 'node:tls';
import { randomUUID } from 'node:crypto';
import { bodyOf, attachmentsOf } from './mime.js';

/* ------------------------------------------------------------------ *
 * where a mailbox's secret comes from
 * ------------------------------------------------------------------ */

/**
 * Per-address environment lookup.
 *
 *   MAILBOX_KIRAN_AT_TEAMLINK_COM_PASSWORD
 *   MAILBOX_KIRAN_AT_TEAMLINK_COM_HOST
 *
 * so several recruiters' inboxes can be configured on one server without
 * any of it touching the database.
 */
function envKey(address, suffix) {
  const slug = String(address || '').toUpperCase()
    .replace(/@/g, '_AT_').replace(/[^A-Z0-9]+/g, '_');
  return `MAILBOX_${slug}_${suffix}`;
}

/**
 * Where the big providers actually keep their IMAP server.
 *
 * The default was `mail.<domain>`, which is right for a company mailbox
 * - mail.tmlink.in is exactly where the TeamLink one lives - and wrong
 * for every consumer provider on earth. Connecting a gmail.com address
 * produced `mail.gmail.com`, a host that does not exist, so the mailbox
 * failed to connect AFTER somebody had gone and set the password,
 * with an error that pointed at the network rather than at the name.
 *
 * Small and explicit: these are the ones a recruiter is actually likely
 * to connect. An address on anything else still gets mail.<domain>, and
 * an explicit HOST always wins over both.
 */
const IMAP_HOSTS = {
  'gmail.com': 'imap.gmail.com',
  'googlemail.com': 'imap.gmail.com',
  'outlook.com': 'outlook.office365.com',
  'hotmail.com': 'outlook.office365.com',
  'live.com': 'outlook.office365.com',
  'msn.com': 'outlook.office365.com',
  'yahoo.com': 'imap.mail.yahoo.com',
  'yahoo.in': 'imap.mail.yahoo.com',
  'yahoo.co.in': 'imap.mail.yahoo.com',
  'zoho.com': 'imap.zoho.com',
  'zohomail.com': 'imap.zoho.com',
  'icloud.com': 'imap.mail.me.com',
  'me.com': 'imap.mail.me.com',
  'rediffmail.com': 'imap.rediffmail.com',
};

/**
 * What a recruiter has to know BEFORE the password will work.
 *
 * Gmail and Yahoo refuse an account password outright once two-factor is
 * on, which it is by default - what they want is an app password, and
 * being told that in advance is the difference between five minutes and
 * an afternoon.
 */
const IMAP_NOTES = {
  'imap.gmail.com':
    'Gmail needs an APP PASSWORD, not the account password: Google Account '
    + '→ Security → 2-Step Verification → App passwords. IMAP must also be '
    + 'on in Gmail Settings → Forwarding and POP/IMAP.',
  'imap.mail.yahoo.com':
    'Yahoo needs an app password: Account Security → Generate app password.',
  'outlook.office365.com':
    'A Microsoft account with two-factor on needs an app password rather '
    + 'than the account password.',
};

export function mailboxSecrets(address) {
  const pick = (suffix, fallback) =>
    process.env[envKey(address, suffix)] || process.env[`MAILBOX_${suffix}`] || fallback || '';

  const domain = String(address || '').split('@')[1] || '';
  const token = pick('TOKEN');

  return {
    /*
     * The host defaults to mail.<domain>, which is where a company
     * mailbox almost always is. One variable fewer to set, and an
     * explicit HOST still wins when it is somewhere else.
     */
    host: pick('HOST', domain ? (IMAP_HOSTS[domain.toLowerCase()] || `mail.${domain}`) : ''),
    port: Number(pick('PORT', '993')),
    user: pick('USER', address),
    /*
     * PASSWORD or TOKEN - whichever is set.
     *
     * TOKEN was originally the Gmail/Outlook OAuth access token and
     * nothing else, so an IMAP mailbox configured with it reported
     * itself unconfigured while a perfectly good credential sat in the
     * environment. They are the same thing from this code's point of
     * view: the secret that opens this mailbox. Accepting either means
     * whichever variable somebody has already set simply works.
     */
    password: pick('PASSWORD') || token,
    token,
  };
}

/** What is missing before this mailbox can be read. */
export function mailboxReadiness(mailbox) {
  const s = mailboxSecrets(mailbox.address);
  if (mailbox.provider === 'mock') return { ready: true, missing: [] };
  if (mailbox.provider === 'imap') {
    // Only the credential is ever genuinely missing now: the host has a
    // sensible default, and either variable name supplies the secret.
    const missing = [];
    if (!s.host) missing.push(envKey(mailbox.address, 'HOST'));
    if (!s.password) {
      missing.push(`${envKey(mailbox.address, 'PASSWORD')} (or ${envKey(mailbox.address, 'TOKEN')})`);
    }
    /*
     * The HOST it will use, and what the provider wants, are returned
     * alongside. "Not configured" on its own tells somebody to go and
     * set a variable; it does not tell them that Gmail will refuse
     * their account password when they do, which is the next hour of
     * their afternoon.
     */
    return {
      ready: missing.length === 0,
      missing,
      host: s.host,
      port: s.port || 993,
      note: IMAP_NOTES[s.host] || undefined,
    };
  }
  if (mailbox.provider === 'gmail' || mailbox.provider === 'outlook') {
    return s.token
      ? { ready: true, missing: [] }
      : { ready: false, missing: [envKey(mailbox.address, 'TOKEN')] };
  }
  return { ready: false, missing: ['a supported provider'] };
}

/* ------------------------------------------------------------------ *
 * a minimal IMAP client
 * ------------------------------------------------------------------ */

/**
 * Enough IMAP to read new mail, and nothing else.
 *
 * Deliberately small: it logs in, selects INBOX, asks for messages that
 * have arrived since a date, fetches their headers and text, and stops.
 * It never deletes, never moves, and only marks messages seen when asked
 * to - a recruiter's inbox is theirs, and an importer that reorganises it
 * will be switched off within a day.
 */
class Imap {
  constructor({ host, port, user, password, timeout = 20000 }) {
    Object.assign(this, { host, port, user, password, timeout });
    this.tag = 0;
    this.buffer = '';
    this.pending = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const socket = tlsConnect({
        host: this.host, port: this.port, servername: this.host,
        rejectUnauthorized: process.env.MAILBOX_TLS_INSECURE !== 'true',
      });
      const fail = (err) => { cleanup(); reject(err); };
      const timer = setTimeout(() => fail(new Error('the mail server did not answer')), this.timeout);
      const cleanup = () => { clearTimeout(timer); socket.removeListener('error', fail); };

      socket.once('error', fail);
      /*
       * latin1, not utf8, and it matters for attachments.
       *
       * A FETCH literal announces its size in BYTES - {41993} - and the
       * message is sliced out of a STRING by that number. Under utf8 a
       * multi-byte sequence becomes one character, so the count and the
       * index stop agreeing and the slice runs past the message into the
       * IMAP trailer, or short of the last MIME boundary.
       *
       * latin1 maps one byte to one character, so the count is exact and
       * every byte survives intact - which is what lets a base64 resume
       * be decoded back to the same file the candidate attached. Text
       * parts are turned back into UTF-8 where they declare it, in
       * mime.js.
       */
      socket.setEncoding('latin1');
      socket.on('data', (chunk) => this.onData(chunk));
      socket.once('data', () => { cleanup(); this.socket = socket; resolve(socket); });
    });
  }

  onData(chunk) {
    this.buffer += chunk;
    if (!this.pending) return;
    const { tag, resolve, reject } = this.pending;
    // A command is finished when its own tag comes back.
    const done = new RegExp(`^${tag} (OK|NO|BAD)([^\\r\\n]*)`, 'm').exec(this.buffer);
    if (!done) return;
    const payload = this.buffer;
    this.buffer = '';
    this.pending = null;
    if (done[1] === 'OK') resolve(payload);
    else reject(new Error(`the mail server refused: ${done[1]}${done[2] || ''}`));
  }

  send(command) {
    const tag = `a${++this.tag}`;
    return new Promise((resolve, reject) => {
      this.pending = { tag, resolve, reject };
      const timer = setTimeout(() => {
        if (this.pending && this.pending.tag === tag) {
          this.pending = null;
          reject(new Error('the mail server stopped responding'));
        }
      }, this.timeout);
      const wrap = (fn) => (v) => { clearTimeout(timer); fn(v); };
      this.pending.resolve = wrap(resolve);
      this.pending.reject = wrap(reject);
      this.socket.write(`${tag} ${command}\r\n`);
    });
  }

  async login() {
    // Literal syntax, so a password containing a space or a quote is sent
    // intact rather than breaking the command.
    const pw = this.password;
    await this.send(`LOGIN "${this.user.replace(/(["\\])/g, '\\$1')}" "${pw.replace(/(["\\])/g, '\\$1')}"`);
  }

  async selectInbox() { await this.send('SELECT INBOX'); }

  /** Message numbers for mail that arrived on or after `since`. */
  async search(since) {
    const d = since instanceof Date ? since : new Date(Date.now() - 7 * 86400000);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const stamp = `${d.getDate()}-${months[d.getMonth()]}-${d.getFullYear()}`;
    const out = await this.send(`SEARCH SINCE ${stamp}`);
    const line = /^\* SEARCH([^\r\n]*)/m.exec(out);
    if (!line) return [];
    return line[1].trim().split(/\s+/).filter(Boolean).map(Number).filter(Number.isFinite);
  }

  /** Headers and the first part of the body, for one message. */
  async fetch(seq) {
    const out = await this.send(`FETCH ${seq} (BODY.PEEK[])`);

    /*
     * The message, not the conversation about it.
     *
     * A FETCH response wraps the message in IMAP framing:
     *
     *     * 4 FETCH (BODY[] {41993}
     *     <the RFC822 message>
     *     )
     *     a4 OK Fetch completed
     *
     * Returning all of that as `raw` meant the MIME parser was handed a
     * document whose first line is IMAP protocol, so it found no
     * content-type, treated the lot as plain text, and extracted the
     * trailer - "a4 OK Fetch completed" - as the body of the email.
     *
     * The literal's byte count is in braces, so the message is exactly
     * that many bytes after the line it sits on. Taken by LENGTH rather
     * than by looking for the closing bracket, because a message
     * containing ")" on its own line is ordinary and would truncate.
     */
    const lit = /\{(\d+)\}\r?\n/.exec(out);
    if (!lit) return out;

    const from = lit.index + lit[0].length;
    return out.slice(from, from + Number(lit[1]));
  }

  async logout() {
    try { await this.send('LOGOUT'); } catch { /* closing anyway */ }
    try { this.socket.end(); } catch { /* already gone */ }
  }
}

/** Header value out of a raw RFC822 message, unfolded. */
function header(raw, name) {
  const re = new RegExp(`^${name}\\s*:\\s*([^\\r\\n]*(?:\\r?\\n[ \\t][^\\r\\n]*)*)`, 'im');
  const m = re.exec(raw);
  return m ? m[1].replace(/\r?\n[ \t]+/g, ' ').trim() : '';
}

/** =?utf-8?B?...?= subject lines. */
function decodeMime(v) {
  return String(v || '').replace(/(\?=)\s+(=\?)/g, '$1$2')
    .replace(/=\?[^?]+\?([BQ])\?([^?]*)\?=/gi, (_, enc, data) => {
      try {
        if (enc.toUpperCase() === 'B') return Buffer.from(data, 'base64').toString('utf8');
        return Buffer.from(data.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi,
          (__, h) => String.fromCharCode(parseInt(h, 16))), 'binary').toString('utf8');
      } catch { return data; }
    });
}

/** The readable body: text/plain if there is one, else the HTML stripped. */
/* ------------------------------------------------------------------ *
 * providers
 * ------------------------------------------------------------------ */

/**
 * The demo inbox.
 *
 * Realistic Naukri emails, in the shapes the parser has to cope with:
 * a clean labelled block, an HTML one, one missing the role, one missing
 * the email address, and one that is not an application at all.
 */
export const SAMPLE_EMAILS = [
  {
    messageId: 'naukri-sample-1',
    from: 'jobsapply@naukri.com',
    subject: 'New application received for Java Developer',
    text: [
      'Source: Naukri',
      '',
      'Candidate Name: Rahul Kumar',
      'Candidate Email: rahul.kumar.demo@example.com',
      'Mobile: 9000090001',
      'Applied Role: Java Developer',
      'Total Experience: 4 years',
      'Current Company: Infotech Solutions',
      'Current Designation: Software Engineer',
      'Current Location: Hyderabad',
      'Preferred Location: Hyderabad',
      'Current CTC: 8 LPA',
      'Expected CTC: 12 LPA',
      'Notice Period: 30 days',
      'Key Skills: Java, Spring Boot, SQL, Microservices',
      'Education: B.Tech Computer Science',
      'Resume: Rahul_Kumar.pdf',
    ].join('\n'),
    attachmentName: 'Rahul_Kumar.pdf',
  },
  {
    messageId: 'naukri-sample-2',
    from: 'noreply@naukri.com',
    subject: 'Naukri: Candidate applied for React Developer',
    text: '<html><body><p><b>Candidate Name:</b> Sneha Reddy</p>'
      + '<p><b>Email ID:</b> sneha.reddy.demo@example.com</p>'
      + '<p><b>Mobile Number:</b> +91 90000 90002</p>'
      + '<p><b>Applied For:</b> React Developer</p>'
      + '<p><b>Experience:</b> 3.5 years</p>'
      + '<p><b>Current Company:</b> Zylotech Systems</p>'
      + '<p><b>Location:</b> Bengaluru</p>'
      + '<p><b>Skills:</b> React, TypeScript, Redux</p>'
      + '<p><b>Notice Period:</b> Immediate</p></body></html>',
    attachmentName: 'Sneha_Reddy_Resume.docx',
  },
  {
    messageId: 'naukri-sample-3',
    from: 'jobsapply@naukri.com',
    subject: 'Application received',
    text: [
      'Source: Naukri',
      'Candidate Name: Arun Prakash',
      'Candidate Email: arun.prakash.demo@example.com',
      'Mobile: 9000090003',
      'Total Experience: 6 years',
      'Key Skills: Python, Django, PostgreSQL',
      // No role: this one has to land in the mapping queue rather than
      // being guessed at.
    ].join('\n'),
  },
  {
    messageId: 'naukri-sample-4',
    from: 'jobsapply@naukri.com',
    subject: 'Naukri application - Java Developer',
    text: [
      'Source: Naukri',
      'Candidate Name: Meena Iyer',
      'Mobile: 9000090004',
      'Applied Role: Java Developer',
      'Total Experience: 5 years',
      // No email address: no portal account can be created, and the
      // recruiter has to be told rather than the import failing quietly.
    ].join('\n'),
  },
  {
    messageId: 'not-an-application-1',
    from: 'billing@vendor.example.com',
    subject: 'Invoice INV-2291 is due',
    text: 'Dear customer, your invoice for September is attached. Unsubscribe here.',
  },
];

/**
 * Make the demo candidates belong to the mailbox that received them.
 *
 * Two recruiters both trying the demo would otherwise be sent the same
 * four people, and the second one would see nothing but "this candidate
 * already exists" - which demonstrates the duplicate check rather than
 * the import. A plus-tag on the address and the last digits of the
 * mailbox make each demo inbox its own set of applicants, using the
 * ordinary addressing every mail system supports.
 */
export function personalise(text, tag) {
  if (!tag) return text;
  const four = tag.replace(/\D/g, '').slice(-4).padStart(4, '0');
  return String(text)
    .replace(/([a-z0-9.]+)@example\.com/gi, (_, local) => `${local}+${tag}@example.com`)
    // The mailbox tag goes in the MIDDLE and the sample's own last digits
    // stay - otherwise all four demo candidates end up on one number and
    // the duplicate check quite correctly merges them into one person.
    .replace(/(?<![\d+])9\d{9}(?!\d)/g, (n) => `9${four}${n.slice(-5)}`)
    .replace(/\+91 90000 900(\d\d)/g, (_, last) => `+91 9${four}900${last}`);
}

/** A stable, short tag from the mailbox address: kiran.4821@x -> 4821 */
function mailboxTag(address) {
  const local = String(address || '').split('@')[0] || '';
  const m = /[.+_-]([a-z0-9]{3,})$/i.exec(local);
  return m ? m[1].slice(-6) : '';
}

const mockProvider = {
  name: 'mock',
  async fetchNew(mailbox, { since } = {}) {
    // Every message, every time: `email_messages` is what stops a
    // re-import, not the provider pretending to have a read pointer.
    const tag = mailboxTag(mailbox.address);
    return SAMPLE_EMAILS.map((m) => ({
      messageId: tag ? `${m.messageId}-${tag}` : m.messageId,
      from: m.from,
      to: mailbox.address,
      subject: m.subject,
      text: personalise(m.text, tag),
      raw: personalise(m.text, tag),
      receivedAt: new Date(),
      attachmentName: m.attachmentName || null,
      hasAttachment: !!m.attachmentName,
    }));
  },
};

/**
 * Does this mailbox actually open?
 *
 * "Connected" used to mean only that the environment variables were
 * present - so a wrong password, a wrong host or a mailbox that does not
 * exist all read as connected on screen, and the first sign of trouble
 * was an empty queue hours later. Having the key is not the same as the
 * door opening.
 *
 * This opens it: connect, LOGIN, SELECT INBOX, disconnect. Nothing is
 * read and nothing is changed.
 */
export async function verifyMailbox(mailbox) {
  const s = mailboxSecrets(mailbox.address);

  if (mailbox.provider === 'mock') return { ok: true, detail: 'sample inbox' };

  if (mailbox.provider === 'imap') {
    if (!s.host || !s.password) {
      return { ok: false, error: 'No IMAP host or password is configured on the server.' };
    }
    const client = new Imap({
      host: s.host, port: s.port || 993, user: s.user, password: s.password,
    });
    try {
      await client.connect();
      await client.login();
      await client.selectInbox();
      return { ok: true, detail: `${s.host}:${s.port || 993} as ${s.user}` };
    } catch (err) {
      // The server's own words. "Authentication failed" and "getaddrinfo
      // ENOTFOUND" are different problems and deserve different fixes.
      return { ok: false, error: String(err.message || err).slice(0, 300) };
    } finally {
      try { await client.logout(); } catch { /* already gone */ }
    }
  }

  if (mailbox.provider === 'gmail' || mailbox.provider === 'outlook') {
    return s.token
      ? { ok: true, detail: 'an OAuth token is configured' }
      : { ok: false, error: 'No OAuth token is configured on the server.' };
  }

  return { ok: false, error: `Unknown provider "${mailbox.provider}".` };
}

const imapProvider = {
  name: 'imap',
  async fetchNew(mailbox, { since, limit = 50 } = {}) {
    const s = mailboxSecrets(mailbox.address);
    if (!s.host || !s.password) {
      const err = new Error(`No IMAP credentials are configured for ${mailbox.address}.`);
      err.code = 'NOT_CONFIGURED';
      throw err;
    }

    const client = new Imap({ host: s.host, port: s.port || 993, user: s.user, password: s.password });
    await client.connect();
    try {
      await client.login();
      await client.selectInbox();
      const numbers = await client.search(since);
      const wanted = numbers.slice(-limit);

      const out = [];
      for (const n of wanted) {
        let raw;
        try { raw = await client.fetch(n); } catch { continue; }
        const body = bodyOf(raw);
        /*
         * Read the files BEFORE `raw` is truncated below.
         *
         * `raw` is clipped to 200 KB for the stored record, which is
         * ample for reading an email and nowhere near a PDF: a resume
         * survives base64 at roughly four thirds of its size, so a 300 KB
         * CV is 400 KB of the very thing being thrown away. Extracting
         * afterwards would have found a truncated part every time.
         */
        const attachments = attachmentsOf(raw);
        const messageId = header(raw, 'Message-ID') || `imap-${mailbox.id}-${n}`;
        out.push({
          attachments,
          messageId,
          from: header(raw, 'From'),
          to: header(raw, 'To') || mailbox.address,
          subject: decodeMime(header(raw, 'Subject')),
          text: typeof body === 'string' ? body : body.text,
          raw: raw.slice(0, 200000),
          receivedAt: new Date(header(raw, 'Date') || Date.now()),
          attachmentName: (attachments[0] && attachments[0].filename)
            || (typeof body === 'string' ? null : (body.attachment || null)),
          hasAttachment: attachments.length > 0
            || (typeof body === 'string' ? false : !!body.attachment),
        });
      }
      return out;
    } finally {
      await client.logout();
    }
  },
};

/** Gmail and Outlook: the same shape, different URLs. */
function httpProvider(name) {
  return {
    name,
    async fetchNew(mailbox, { since, limit = 50 } = {}) {
      const s = mailboxSecrets(mailbox.address);
      if (!s.token) {
        const err = new Error(`No ${name} access token is configured for ${mailbox.address}.`);
        err.code = 'NOT_CONFIGURED';
        throw err;
      }
      const auth = { authorization: `Bearer ${s.token}` };
      const sinceDate = since instanceof Date ? since : new Date(Date.now() - 7 * 86400000);

      if (name === 'gmail') {
        const q = `after:${Math.floor(sinceDate.getTime() / 1000)}`;
        const list = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${limit}&q=${encodeURIComponent(q)}`,
          { headers: auth });
        if (!list.ok) throw new Error(`Gmail refused the request (${list.status})`);
        const { messages = [] } = await list.json();

        const out = [];
        for (const m of messages) {
          const full = await fetch(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=raw`,
            { headers: auth });
          if (!full.ok) continue;
          const { raw } = await full.json();
          // latin1 for the same reason the IMAP socket uses it: every
          // byte of an attachment has to survive the round trip.
          const text = Buffer.from(String(raw || ''), 'base64url').toString('latin1');
          const body = bodyOf(text);
          const attachments = attachmentsOf(text);
          out.push({
            attachments,
            messageId: header(text, 'Message-ID') || m.id,
            from: header(text, 'From'),
            to: header(text, 'To') || mailbox.address,
            subject: decodeMime(header(text, 'Subject')),
            text: typeof body === 'string' ? body : body.text,
            raw: text.slice(0, 200000),
            receivedAt: new Date(header(text, 'Date') || Date.now()),
            attachmentName: (attachments[0] && attachments[0].filename)
              || (typeof body === 'string' ? null : (body.attachment || null)),
            hasAttachment: attachments.length > 0
              || (typeof body === 'string' ? false : !!body.attachment),
          });
        }
        return out;
      }

      // Microsoft Graph
      const url = 'https://graph.microsoft.com/v1.0/me/messages'
        + `?$top=${limit}&$filter=receivedDateTime ge ${sinceDate.toISOString()}`
        + '&$select=id,internetMessageId,from,toRecipients,subject,receivedDateTime,body,hasAttachments';
      const res = await fetch(url, { headers: auth });
      if (!res.ok) throw new Error(`Outlook refused the request (${res.status})`);
      const { value = [] } = await res.json();

      /*
       * Graph does not hand the files over with the message.
       *
       * $select can say `hasAttachments` and nothing more, so a second
       * request per message is the only way to get the bytes - which is
       * why this asks ONLY for the messages that say they have one,
       * rather than a call per message on every sync.
       */
      const out = [];
      for (const m of value) {
        let attachments = [];
        if (m.hasAttachments) {
          try {
            const a = await fetch(
              `https://graph.microsoft.com/v1.0/me/messages/${m.id}/attachments`,
              { headers: auth });
            if (a.ok) {
              const { value: files = [] } = await a.json();
              attachments = files
                .filter((f) => f.contentBytes && !f.isInline)
                .slice(0, 8)
                .map((f) => ({
                  filename: f.name || 'attachment',
                  contentType: String(f.contentType || '').toLowerCase(),
                  buffer: Buffer.from(f.contentBytes, 'base64'),
                  size: Number(f.size) || 0,
                }));
            }
          } catch { /* the message is still worth importing without it */ }
        }

        out.push({
          messageId: m.internetMessageId || m.id,
          from: m.from?.emailAddress?.address || '',
          to: (m.toRecipients || [])[0]?.emailAddress?.address || mailbox.address,
          subject: m.subject || '',
          text: String(m.body?.content || '').replace(/<[^>]+>/g, ' '),
          raw: String(m.body?.content || '').slice(0, 200000),
          receivedAt: new Date(m.receivedDateTime || Date.now()),
          attachments,
          attachmentName: (attachments[0] && attachments[0].filename) || null,
          hasAttachment: !!m.hasAttachments,
        });
      }
      return out;
    },
  };
}

const PROVIDERS = {
  mock: mockProvider,
  imap: imapProvider,
  gmail: httpProvider('gmail'),
  outlook: httpProvider('outlook'),
};

export function mailboxProvider(name) {
  return PROVIDERS[String(name || 'mock').toLowerCase()] || mockProvider;
}

export const newMessageId = () => `msg_${Date.now().toString(36)}${randomUUID().slice(0, 6)}`;
