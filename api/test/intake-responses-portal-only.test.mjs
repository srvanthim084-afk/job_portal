/**
 * Naukri & Shine responses live in the TeamLink portal and nowhere else (0162).
 *
 * Against a real TLS IMAP server running in this process (a Naukri mailbox and a Shine mailbox, each connected by Admin and owned
 * by one recruiter), so the responses are really read, stored and alerted on:
 *
 *   - one response in each mailbox is imported, stored with its provider, mailbox, message id, thread, candidate and application,
 *     and shown to the recruiter who owns the mailbox (and only that recruiter)
 *   - nothing about them is emailed to a recruiter: no forward, no copy, no "new application" mail, no "needs a requirement" mail -
 *     the recruiter is told in the portal; every email that leaves goes to a candidate; no message carries a cc or a bcc
 *   - a refused mailbox login is an error shown in the portal, and nothing is sent anywhere (no fallback mailbox, no email)
 *   - a retry (reading the same mail again, running the alerts again) repeats nothing
 *   - the unrelated emails are untouched: an application that did NOT come from an import still emails its recruiter, and the
 *     administrator's explicit switch (INTAKE_RECRUITER_EMAILS=true) is the only way an imported one does
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:tls';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestDb, applyTestEnv, makeClient } from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DB_PORT = 5708;
const API_PORT = 9982;
const IMAP_PORT = 9664;
const base = `http://127.0.0.1:${API_PORT}`;
const PW = 'Staff123portalonly';
const NAUKRI_BOX = 'naukri.only@tl-mailbox-test.in';
const SHINE_BOX = 'shine.only@tl-mailbox-test.in';
const NAUKRI_PW = 'naukri-app-pass-1';
const SHINE_PW = 'shine-app-pass-2';
const REC_A_MAIL = 'rec.a.personal@tl-sink.local';
const REC_B_MAIL = 'rec.b.personal@tl-sink.local';

let dbh, server, raw, imap, admin, recA, recB, alerts, providers;
const outbound = [];          // every message handed to any channel
const accounts = new Map();   // mailbox user -> { password, messages }
const logins = [];            // every user the IMAP server was asked to log in as
const fetches = [];           // every FETCH command line
const tag = Date.now().toString(36);
const mailA = `amar.${tag}@cand-mailbox-test.in`;
const mailS = `deepak.${tag}@cand-mailbox-test.in`;
const mailS2 = `esha.${tag}@cand-mailbox-test.in`;
const mailNoRole = `farhan.${tag}@cand-mailbox-test.in`;
let naukriId, shineId;

function startImap(port) {
  const srv = createServer({
    key: readFileSync(resolve(HERE, 'fixtures/fake-imap-key.pem')),
    cert: readFileSync(resolve(HERE, 'fixtures/fake-imap-cert.pem')),
  }, (sock) => {
    sock.setEncoding('latin1');
    let buf = '', who = null;
    sock.write('* OK fake IMAP ready\r\n');
    sock.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        const [tagId, cmd] = [line.split(' ')[0], (line.split(' ')[1] || '').toUpperCase()];
        if (cmd === 'LOGIN') {
          const args = [...line.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\(.)/g, '$1'));
          logins.push(args[0]);
          const acc = accounts.get(args[0]);
          if (acc && acc.password === args[1]) { who = acc; sock.write(`${tagId} OK LOGIN completed\r\n`); }
          else sock.write(`${tagId} NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)\r\n`);
        } else if (cmd === 'SELECT') {
          sock.write(`* ${who.messages.length} EXISTS\r\n${tagId} OK [READ-WRITE] SELECT completed\r\n`);
        } else if (cmd === 'SEARCH') {
          sock.write(`* SEARCH ${who.messages.map((_, n) => n + 1).join(' ')}\r\n${tagId} OK SEARCH completed\r\n`);
        } else if (cmd === 'FETCH') {
          const n = Number(line.split(' ')[2]);
          fetches.push(line);
          const msg = who.messages[n - 1];
          sock.write(`* ${n} FETCH (BODY[] {${Buffer.byteLength(msg, 'latin1')}}\r\n${msg})\r\n${tagId} OK FETCH completed\r\n`);
        } else if (cmd === 'LOGOUT') {
          sock.write(`* BYE\r\n${tagId} OK LOGOUT completed\r\n`); sock.end();
        } else sock.write(`${tagId} BAD unknown command\r\n`);
      }
    });
    sock.on('error', () => {});
  });
  return new Promise((r) => srv.listen(port, '127.0.0.1', () => r(srv)));
}

let mseq = 0;
const mid = (n) => `<m${n}.${tag}@mailer.test>`;
function email({ from, subject, body, extra = [] }) {
  mseq += 1;
  return [`Message-ID: ${mid(mseq)}`, `From: ${from}`, 'To: inbox@tl-mailbox-test.in', `Subject: ${subject}`, `Date: ${new Date().toUTCString()}`,
    ...extra, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', body, ''].join('\r\n');
}
const naukri = (name, mail, role = 'Java Developer') => email({
  from: 'Naukri <jobsapply@naukri.com>', subject: `New application received for ${role}`,
  body: ['Source: Naukri', '', `Candidate Name: ${name}`, `Candidate Email: ${mail}`, 'Mobile: 9' + String(100000000 + mseq).slice(-9),
    `Applied Role: ${role}`, 'Total Experience: 4 years', 'Key Skills: Java, Spring Boot, SQL', 'Current Location: Hyderabad'].join('\r\n'),
});
const shine = (name, mail, role = 'Java Developer', extra = []) => email({
  from: 'Shine <recruiters@alerts.shine.com>', subject: `Email Response-Hiring for ${role}`, extra,
  body: [`You have received an email response for Hiring for ${role}.`, 'The candidate profile is detailed below:',
    `Candidate Name: ${name}`, `Email: ${mail}`, 'Mobile: 9' + String(300000000 + mseq).slice(-9), `Applied Role: ${role}`,
    'Experience: 3 Yrs 0 Month', 'Skills: java, spring, sql'].join('\r\n'),
});
const shineNoRole = (name, mail) => email({
  from: 'Shine <recruiters@alerts.shine.com>', subject: 'Email Response-',
  body: ['You have received an email response.', `Candidate Name: ${name}`, `Email: ${mail}`, 'Mobile: 9' + String(400000000 + mseq).slice(-9),
    'Experience: 2 Yrs 0 Month', 'Skills: python'].join('\r\n'),
});

async function staff(role, mail, id) {
  const { hashPassword } = await import('../src/auth.js');
  const u = (await raw(`insert into users (email,password_hash,role) values ($1,$2,$3) returning id`, [mail, await hashPassword(PW), role])).rows[0].id;
  if (role === 'recruiter') await raw(`insert into recruiters (id,name,email,company_id,user_id) values ($1,$2,$3,'co_po',$4)`, [id, `Recruiter ${id}`, mail, u]);
  else await raw(`insert into admins (id,name,email,user_id) values ($1,'Admin',$2,$3)`, [id, mail, u]);
  const c = makeClient(base); await c.get('/api/health');
  assert.equal((await c.post('/api/auth/login', { email: mail, password: PW, role })).status, 200);
  return c;
}
async function waitIdle(id) {
  for (let i = 0; i < 100; i += 1) {
    const r = await admin.get('/api/intake/source-connections');
    const conn = (r.body.connections || []).find((x) => x.id === id);
    if (conn && conn.statusLabel !== 'Processing') return conn;
    await new Promise((r2) => setTimeout(r2, 150));
  }
  throw new Error('the sync did not finish');
}
const settle = () => new Promise((r) => setTimeout(r, 500));
const personal = (m) => [REC_A_MAIL, REC_B_MAIL].includes(String(m.to || '').toLowerCase());
const msg = async (subjectPart) => (await raw(`select * from email_messages where subject like $1 order by created_at desc limit 1`, [`%${subjectPart}%`])).rows[0];

test('boot', async () => {
  dbh = await startTestDb(DB_PORT);
  imap = await startImap(IMAP_PORT);
  applyTestEnv(dbh.url, {
    PUBLIC_ORIGIN: base, DISABLE_BACKGROUND_WORK: 'true', AI_API_KEY: '', MAILBOX_TLS_INSECURE: 'true',
    INTAKE_NOTIFY_CANDIDATES: 'true',                         // candidates still get their own login email: that is not about recruiters
    INTEGRATION_SECRET_KEY: 'test-integration-key-0162-long-enough',
    EMAIL_SMTP_HOST: '', EMAIL_SMTP_USER: '', EMAIL_SMTP_PASS: '', EMAILJS_SERVICE_ID: '', EMAILJS_TEMPLATE_ID: '', EMAILJS_PUBLIC_KEY: '',
    SMS_API_KEY: '', WHATSAPP_API_KEY: '', OUTBOUND_ALLOWLIST: '',
  });
  delete process.env.INTAKE_RECRUITER_EMAILS;
  raw = (sql, params) => dbh.db.query(sql, params);
  await raw(`insert into companies (id, name) values ('co_po', 'Portal Only Co')`);
  ({ providers } = await import('../src/notify/providers.js'));
  for (const ch of ['email', 'sms', 'whatsapp']) providers[ch].send = async (m) => { outbound.push({ channel: ch, ...m }); return { status: 'sent', provider: 'test' }; };
  alerts = await import('../src/notify/walkin-ats.js');
  const { createApp } = await import('../src/app.js');
  const app = createApp({ logger: { error() {}, log() {} } });
  await new Promise((r) => { server = app.listen(API_PORT, r); });
  admin = await staff('admin', 'admin.po@tl-sink.local', 'a_po');
  recA = await staff('recruiter', REC_A_MAIL, 'r_poA');
  recB = await staff('recruiter', REC_B_MAIL, 'r_poB');
  await raw(`insert into jobs (id,title,company_id,recruiter_id,location,mode,exp_label,status,skills,description,published_at)
             values ('j_po_java','Java Developer','co_po','r_poA','Hyderabad','Onsite','2-5 yrs','open',$1,'Build services.',now())`, [['Java', 'Spring Boot', 'SQL']]);
  accounts.set(NAUKRI_BOX, { password: NAUKRI_PW, messages: [naukri('Amar Kumar', mailA)] });
  accounts.set(SHINE_BOX, { password: SHINE_PW, messages: [shine('Deepak Shine', mailS, 'Java Developer', [`References: ${mid(9001)} ${mid(9002)}`]), shineNoRole('Farhan Review', mailNoRole)] });
});

test('one response in the Naukri mailbox and one in the Shine mailbox are imported to the right recruiters', async () => {
  const n = await admin.post('/api/intake/source-connections', { source: 'naukri', recruiterId: 'r_poA', address: NAUKRI_BOX, provider: 'other', appPassword: NAUKRI_PW, host: '127.0.0.1', port: IMAP_PORT });
  assert.equal(n.status, 201, JSON.stringify(n.body)); naukriId = n.body.connection.id;
  const s = await admin.post('/api/intake/source-connections', { source: 'shine', recruiterId: 'r_poB', address: SHINE_BOX, provider: 'other', appPassword: SHINE_PW, host: '127.0.0.1', port: IMAP_PORT });
  assert.equal(s.status, 201, JSON.stringify(s.body)); shineId = s.body.connection.id;
  assert.equal((await waitIdle(naukriId)).statusLabel, 'Connected');
  assert.equal((await waitIdle(shineId)).statusLabel, 'Connected');
  await settle();
  const apps = (await raw(`select c.email, a.recruiter_id, a.source, a.import_method from applications a join candidates c on c.id = a.candidate_id
                            where c.email in ($1,$2) order by c.email`, [mailA, mailS])).rows;
  assert.deepEqual(apps.map((a) => [a.email, a.recruiter_id, a.source, a.import_method]),
    [[mailA, 'r_poA', 'naukri', 'recruiter_email'], [mailS, 'r_poB', 'shine', 'recruiter_email']]);
});

test('each response is stored with its provider, mailbox, message id, thread, candidate and application', async () => {
  const a = await msg('New application received for Java Developer');
  assert.equal(a.status, 'processed');
  assert.equal(a.source, 'naukri');
  assert.equal(a.mailbox_id, naukriId);
  assert.match(a.message_id, /@mailer\.test/);
  assert.match(a.thread_id, /^<m\d+\.[a-z0-9]+@mailer\.test>$/, 'a message with no references is its own thread');
  assert.ok(a.candidate_id && a.application_id);
  const b = await msg('Email Response-Hiring for Java Developer');
  assert.equal(b.status, 'processed');
  assert.equal(b.source, 'shine');
  assert.equal(b.mailbox_id, shineId);
  assert.equal(b.thread_id, mid(9001), 'the thread is the first message in References');
  assert.ok(b.candidate_id && b.application_id);
});

test('the right recruiter sees the response in the portal; the other does not', async () => {
  const la = (await recA.get('/api/intake/messages?status=processed')).body.messages;
  const lb = (await recB.get('/api/intake/messages?status=processed')).body.messages;
  assert.deepEqual(la.map((m) => m.source), ['naukri']);
  assert.deepEqual(lb.map((m) => m.source), ['shine']);
  assert.equal(la[0].mailbox, NAUKRI_BOX);
  assert.equal(la[0].recruiterId, 'r_poA');
  assert.equal(lb[0].recruiterId, 'r_poB');
  assert.ok(la[0].threadId && la[0].messageId && la[0].applicationId && la[0].candidateId);
  assert.equal(lb[0].threadId, mid(9001));
  const al = (await recA.get('/api/applications')).body;
  const rows = al.applications || al.items || [];
  assert.ok(rows.some((x) => x.candidateId === la[0].candidateId), 'the Naukri application is in recruiter A\'s Applications');
  assert.ok((await admin.get('/api/intake/messages?status=processed')).body.messages.length >= 2, 'the administrator sees both');
});

test('the one that has no role is waiting in the portal, and the recruiter is told in the portal, not by email', async () => {
  const w = await msg('Email Response-');
  assert.equal(w.status, 'needs_mapping');
  const q = (await recB.get('/api/intake/queue')).body.queue;
  assert.ok(q.some((m) => m.id === w.id && m.source === 'shine' && m.recruiterId === 'r_poB'));
  const n = (await raw(`select recipient_id, title from notifications where type = $1`, [`IMPORT_NEEDS_REQUIREMENT#${w.id}`])).rows;
  assert.deepEqual(n.map((x) => x.recipient_id), ['r_poB']);
  assert.match(n[0].title, /^Action needed:/);
  assert.equal(outbound.filter((m) => /^Action needed:/.test(m.subject || '')).length, 0);
});

test('no email about a response reaches a recruiter - alerts are portal-only, and a retry repeats nothing', async () => {
  const out = await alerts.runApplicationAlerts();
  assert.ok(out.instant >= 2, JSON.stringify(out));
  const rows = (await raw(`select channel, status, recruiter_id from ats_recruiter_alerts where kind = 'new_application' order by id`)).rows;
  assert.ok(rows.length >= 1 && rows.every((r) => r.channel === 'portal'), JSON.stringify(rows));
  const inPortal = async () => (await raw(`select count(*)::int n from notifications where type like 'ATS_NEW_APPLICATION#%'`)).rows[0].n;
  const n1 = await inPortal();
  assert.ok(n1 >= 1, 'the recruiter was told in the portal');
  await alerts.runApplicationAlerts();
  assert.equal(await inPortal(), n1, 'a second run adds nothing');
  assert.deepEqual(outbound.filter(personal), [], 'nothing was sent to a recruiter\'s own address');
});

test('everything that did leave went to a candidate, with no cc or bcc, and nothing went to the recruiters\' addresses', async () => {
  const to = outbound.map((m) => String(m.to || '').toLowerCase());
  assert.ok(to.includes(mailA) && to.includes(mailS), `the candidates got their own login: ${to.join(', ')}`);
  for (const m of outbound) {
    if (m.channel === 'email') assert.ok(/cand-mailbox-test\.in$/.test(String(m.to)), `unexpected recipient ${m.to} (${m.subject})`);
    else assert.match(String(m.to), /^\+?[\d ]{10,}$/, `a ${m.channel} to something that is not a candidate's number: ${m.to}`);
    for (const k of ['cc', 'bcc', 'Cc', 'Bcc']) assert.equal(m[k], undefined, `a ${k} on "${m.subject}"`);
  }
});

test('a refused mailbox login is an error in the portal; nothing is sent and no other mailbox is tried', async () => {
  accounts.get(SHINE_BOX).password = 'changed-on-the-server';
  logins.length = 0; const before = outbound.length;
  await admin.post(`/api/intake/source-connections/${shineId}/sync`, {});
  const conn = await waitIdle(shineId);
  assert.notEqual(conn.statusLabel, 'Connected', JSON.stringify(conn));
  assert.ok(conn.lastError, 'the error is shown');
  assert.deepEqual([...new Set(logins)], [SHINE_BOX], 'only the configured mailbox was tried');
  assert.equal(outbound.length, before, 'no email, SMS or WhatsApp because of the failure');
  const row = (await raw(`select status, last_error from email_mailboxes where id = $1`, [shineId])).rows[0];
  assert.ok(row.last_error);
  accounts.get(SHINE_BOX).password = SHINE_PW;
});

test('reading the same mail again creates and sends nothing', async () => {
  const before = outbound.length;
  const apps = (await raw(`select count(*)::int n from applications`)).rows[0].n;
  fetches.length = 0;
  await admin.post(`/api/intake/source-connections/${naukriId}/sync`, {}); await waitIdle(naukriId);
  await admin.post(`/api/intake/source-connections/${shineId}/sync`, {}); await waitIdle(shineId);
  await settle();
  assert.equal((await raw(`select count(*)::int n from applications`)).rows[0].n, apps);
  assert.equal(outbound.length, before);
  /* and mail already read is not downloaded again: only its Message-ID header is asked for */
  assert.ok(fetches.length >= 2, 'the mailboxes were read');
  assert.ok(fetches.every((l) => /HEADER\.FIELDS \(MESSAGE-ID\)/i.test(l)), `a full message was fetched again: ${fetches.find((l) => !/HEADER/.test(l))}`);
});

test('unrelated recruiter email is unchanged: an application that did not come from an import still emails its recruiter', async () => {
  await raw(`insert into candidates (id, name, email, phone) values ('c_po_walk', 'Walk Direct', $1, '9000000001')`, [`walk.${tag}@cand-mailbox-test.in`]);
  await raw(`insert into applications (id, job_id, candidate_id, recruiter_id, stage, source) values ('app_po_direct', 'j_po_java', 'c_po_walk', 'r_poA', 'applied', 'portal')`);
  await alerts.runApplicationAlerts();
  const mails = outbound.filter((m) => personal(m));
  assert.equal(mails.length, 1, JSON.stringify(mails.map((m) => [m.to, m.subject])));
  assert.equal(mails[0].to, REC_A_MAIL);
  assert.match(mails[0].subject, /^New application: Java Developer/);
});

test('the administrator\'s explicit switch is the only way an imported response is emailed to the recruiter', async () => {
  process.env.INTAKE_RECRUITER_EMAILS = 'true';
  try {
    accounts.get(SHINE_BOX).messages.push(shine('Esha Optin', mailS2));
    await admin.post(`/api/intake/source-connections/${shineId}/sync`, {}); await waitIdle(shineId);
    await settle();
    const before = outbound.filter((m) => personal(m)).length;
    await alerts.runApplicationAlerts();
    const mails = outbound.filter((m) => personal(m));
    assert.ok(mails.length > before, 'with the switch on, the recruiter is emailed');
    assert.equal(mails[mails.length - 1].to, REC_A_MAIL, 'the alert goes to the recruiter who owns the job');
  } finally { delete process.env.INTAKE_RECRUITER_EMAILS; }
});

test('shutdown', async () => {
  await new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
  imap.close();
  await dbh.stop();
});
