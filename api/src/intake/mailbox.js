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

export function mailboxSecrets(address) {
  const pick = (suffix, fallback) =>
    process.env[envKey(address, suffix)] || process.env[`MAILBOX_${suffix}`] || fallback || '';
  return {
    host: pick('HOST'),
    port: Number(pick('PORT', '993')),
    user: pick('USER', address),
    password: pick('PASSWORD'),
    token: pick('TOKEN'),          // gmail / outlook OAuth access token
  };
}

/** What is missing before this mailbox can be read. */
export function mailboxReadiness(mailbox) {
  const s = mailboxSecrets(mailbox.address);
  if (mailbox.provider === 'mock') return { ready: true, missing: [] };
  if (mailbox.provider === 'imap') {
    const missing = [];
    if (!s.host) missing.push(envKey(mailbox.address, 'HOST'));
    if (!s.password) missing.push(envKey(mailbox.address, 'PASSWORD'));
    return { ready: missing.length === 0, missing };
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
      socket.setEncoding('utf8');
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
    return out;
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
function bodyOf(raw) {
  const boundary = (/boundary="?([^";\r\n]+)"?/i.exec(raw) || [])[1];
  const decodePart = (headers, body) => {
    if (/quoted-printable/i.test(headers)) {
      return body.replace(/=\r?\n/g, '')
        .replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
    }
    if (/base64/i.test(headers)) {
      try { return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8'); }
      catch { return body; }
    }
    return body;
  };

  if (!boundary) {
    const idx = raw.search(/\r?\n\r?\n/);
    return idx < 0 ? raw : decodePart(raw.slice(0, idx), raw.slice(idx).replace(/^\r?\n\r?\n/, ''));
  }

  let plain = '';
  let html = '';
  let attachment = '';
  for (const part of raw.split(new RegExp(`--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))) {
    const idx = part.search(/\r?\n\r?\n/);
    if (idx < 0) continue;
    const h = part.slice(0, idx);
    const b = part.slice(idx).replace(/^\r?\n\r?\n/, '');
    const filename = (/filename="?([^"\r\n;]+)"?/i.exec(h) || [])[1];
    if (filename) { attachment = attachment || filename; continue; }
    if (/text\/plain/i.test(h)) plain = plain || decodePart(h, b);
    else if (/text\/html/i.test(h)) html = html || decodePart(h, b);
  }

  const text = plain || html.replace(/<[^>]+>/g, ' ');
  return { text, attachment };
}

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
        const messageId = header(raw, 'Message-ID') || `imap-${mailbox.id}-${n}`;
        out.push({
          messageId,
          from: header(raw, 'From'),
          to: header(raw, 'To') || mailbox.address,
          subject: decodeMime(header(raw, 'Subject')),
          text: typeof body === 'string' ? body : body.text,
          raw: raw.slice(0, 200000),
          receivedAt: new Date(header(raw, 'Date') || Date.now()),
          attachmentName: typeof body === 'string' ? null : (body.attachment || null),
          hasAttachment: typeof body === 'string' ? false : !!body.attachment,
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
          const text = Buffer.from(String(raw || ''), 'base64url').toString('utf8');
          const body = bodyOf(text);
          out.push({
            messageId: header(text, 'Message-ID') || m.id,
            from: header(text, 'From'),
            to: header(text, 'To') || mailbox.address,
            subject: decodeMime(header(text, 'Subject')),
            text: typeof body === 'string' ? body : body.text,
            raw: text.slice(0, 200000),
            receivedAt: new Date(header(text, 'Date') || Date.now()),
            attachmentName: typeof body === 'string' ? null : (body.attachment || null),
            hasAttachment: typeof body === 'string' ? false : !!body.attachment,
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
      return value.map((m) => ({
        messageId: m.internetMessageId || m.id,
        from: m.from?.emailAddress?.address || '',
        to: (m.toRecipients || [])[0]?.emailAddress?.address || mailbox.address,
        subject: m.subject || '',
        text: String(m.body?.content || '').replace(/<[^>]+>/g, ' '),
        raw: String(m.body?.content || '').slice(0, 200000),
        receivedAt: new Date(m.receivedDateTime || Date.now()),
        attachmentName: null,
        hasAttachment: !!m.hasAttachments,
      }));
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
