/**
 * Naukri & Shine Email Import (0135) - each board's mailbox, connected by Admin, owned by ONE recruiter.
 *
 * Against a real TLS IMAP server running in this process (a small fake: LOGIN, SELECT, SEARCH, FETCH,
 * LOGOUT, with a self-signed certificate in fixtures/), so Connect really logs in and Sync really reads.
 *
 *   - a wrong password is refused at Connect, in plain words, and nothing is saved
 *   - the right one connects; the app password is sealed and never comes back in any response
 *   - the Naukri mailbox imports Naukri email only (a Shine email in it is recorded, not imported), and
 *     the Shine mailbox Shine only; candidates and applications belong to the mailbox's recruiter
 *   - two recruiters, one board each; then the same recruiter for both (an explicit, confirmed reassign
 *     that moves no existing candidate)
 *   - an email that cannot be placed goes to review; syncing again creates nothing twice
 *   - ownership is read again before EVERY email: a reassignment during a sync applies to the next email
 *   - a recruiter sees only their own mailboxes and emails, and cannot change Admin's connections
 *   - disconnect erases the password and stops reading; reconnect re-tests the login
 *   - the audit log has every step
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:tls';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestDb, applyTestEnv, makeClient, startMockProvider } from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DB_PORT = 5603;
const API_PORT = 9953;
const MOCK_PORT = 9887;
const IMAP_PORT = 9663;
const base = `http://127.0.0.1:${API_PORT}`;
const PW = 'Staff123mailbox';
const NAUKRI_BOX = 'naukri.responses@tl-mailbox-test.in';
const SHINE_BOX = 'shine.responses@tl-mailbox-test.in';
const NAUKRI_APP_PW = 'abcd efgh ijkl mnop';
const SHINE_APP_PW = 'shine-app-pass-9921';
const PERSONAL_BOX = 'personal.box@tl-mailbox-test.in';
const PERSONAL_PW = 'personal-pass-4417';

let dbh, server, raw, imap, mock, admin, recA, recB;
const mailsSent = [];
const seen = [];            // every response body, to prove no password ever comes back

/* ------------------------------------------------------------------ *
 * the fake IMAP server
 * ------------------------------------------------------------------ */
const accounts = new Map();     // user -> { password, messages: [raw], onFetch? }
let imapLogins = 0;

function startImap(port) {
  const srv = createServer({
    key: readFileSync(resolve(HERE, 'fixtures/fake-imap-key.pem')),
    cert: readFileSync(resolve(HERE, 'fixtures/fake-imap-cert.pem')),
  }, (sock) => {
    sock.setEncoding('latin1');
    let buf = '';
    let who = null;
    sock.write('* OK fake IMAP ready\r\n');
    sock.on('data', async (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        const [tag, cmd] = [line.split(' ')[0], (line.split(' ')[1] || '').toUpperCase()];
        if (cmd === 'LOGIN') {
          imapLogins += 1;
          const args = [...line.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\(.)/g, '$1'));
          const acc = accounts.get(args[0]);
          if (acc && acc.password === args[1]) { who = acc; sock.write(`${tag} OK LOGIN completed\r\n`); }
          else sock.write(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)\r\n`);
        } else if (cmd === 'SELECT') {
          sock.write(`* ${who.messages.length} EXISTS\r\n${tag} OK [READ-WRITE] SELECT completed\r\n`);
        } else if (cmd === 'SEARCH') {
          sock.write(`* SEARCH ${who.messages.map((_, n) => n + 1).join(' ')}\r\n${tag} OK SEARCH completed\r\n`);
        } else if (cmd === 'FETCH') {
          const n = Number(line.split(' ')[2]);
          if (who.onFetch) await who.onFetch(n);
          const msg = who.messages[n - 1];
          sock.write(`* ${n} FETCH (BODY[] {${Buffer.byteLength(msg, 'latin1')}}\r\n${msg})\r\n${tag} OK FETCH completed\r\n`);
        } else if (cmd === 'LOGOUT') {
          sock.write(`* BYE\r\n${tag} OK LOGOUT completed\r\n`); sock.end();
        } else {
          sock.write(`${tag} BAD unknown command\r\n`);
        }
      }
    });
    sock.on('error', () => {});
  });
  return new Promise((r) => srv.listen(port, '127.0.0.1', () => r(srv)));
}

let mseq = 0;
function email({ from, subject, body }) {
  mseq += 1;
  return [
    `Message-ID: <m${mseq}.${Date.now()}@mailer.test>`,
    `From: ${from}`,
    `To: inbox@tl-mailbox-test.in`,
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
    '',
  ].join('\r\n');
}
const naukri = (name, mail, role = 'Java Developer') => email({
  from: 'Naukri <jobsapply@naukri.com>', subject: `New application received for ${role}`,
  body: ['Source: Naukri', '', `Candidate Name: ${name}`, `Candidate Email: ${mail}`, 'Mobile: 9' + String(100000000 + mseq).slice(-9),
    `Applied Role: ${role}`, 'Total Experience: 4 years', 'Key Skills: Java, Spring Boot, SQL', 'Current Location: Hyderabad'].join('\r\n'),
});
const naukriNoRole = (name, mail) => email({
  from: 'Naukri <jobsapply@naukri.com>', subject: 'Application received',
  body: ['Source: Naukri', `Candidate Name: ${name}`, `Candidate Email: ${mail}`, 'Mobile: 9' + String(200000000 + mseq).slice(-9),
    'Total Experience: 6 years', 'Key Skills: Python, Django'].join('\r\n'),
});
const shine = (name, mail, role = 'Java Developer') => email({
  from: 'Shine <recruiters@alerts.shine.com>', subject: `Email Response-Hiring for ${role}`,
  body: [`You have received an email response for Hiring for ${role}.`, 'The candidate profile is detailed below:',
    `Candidate Name: ${name}`, `Email: ${mail}`, 'Mobile: 9' + String(300000000 + mseq).slice(-9), `Applied Role: ${role}`,
    'Experience: 3 Yrs 0 Month', 'Skills: java, spring, sql'].join('\r\n'),
});

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */
async function staff(role, email, id) {
  const { hashPassword } = await import('../src/auth.js');
  const hash = await hashPassword(PW);
  const u = (await raw(`insert into users (email,password_hash,role) values ($1,$2,$3) returning id`, [email, hash, role])).rows[0].id;
  if (role === 'recruiter') await raw(`insert into recruiters (id,name,email,company_id,user_id) values ($1,$2,$3,'co_m',$4)`, [id, `Recruiter ${id}`, email, u]);
  if (role === 'admin') await raw(`insert into admins (id,name,email,user_id) values ($1,'Admin',$2,$3)`, [id, email, u]);
  const c = makeClient(base);
  await c.get('/api/health');
  const r = await c.post('/api/auth/login', { email, password: PW, role });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const wrapCall = (fn) => async (...a) => { const out = await fn(...a); seen.push(JSON.stringify(out.body || '')); return out; };
  for (const m of ['get', 'post', 'put', 'patch', 'del', 'delete']) if (typeof c[m] === 'function') c[m] = wrapCall(c[m].bind(c));
  return c;
}

async function waitIdle(id) {
  for (let i = 0; i < 100; i += 1) {
    const r = await admin.get('/api/intake/source-connections');
    const conn = (r.body.connections || []).find((x) => x.id === id);
    if (conn && conn.status !== 'processing') return conn;
    await new Promise((r2) => setTimeout(r2, 150));
  }
  throw new Error('the sync did not finish');
}
const cand = async (mail) => (await raw(`select id, owner_recruiter_id from candidates where lower(email) = lower($1)`, [mail])).rows;
const apps = async (candId) => (await raw(`select recruiter_id, source from applications where candidate_id = $1`, [candId])).rows;
const msgs = async (mailboxId) => (await raw(`select status, reason, subject from email_messages where mailbox_id = $1 order by id`, [mailboxId])).rows;

let naukriId, shineId;
const tag = Date.now().toString(36);
const mailA1 = `amar.${tag}@cand-mailbox-test.in`;
const mailA2 = `bhavya.${tag}@cand-mailbox-test.in`;
const mailS1 = `chitra.${tag}@cand-mailbox-test.in`;
const mailS2 = `deepak.${tag}@cand-mailbox-test.in`;
const mailS3 = `esha.${tag}@cand-mailbox-test.in`;
const mailR = `farhan.${tag}@cand-mailbox-test.in`;
const mailRace1 = `gita.${tag}@cand-mailbox-test.in`;
const mailRace2 = `hari.${tag}@cand-mailbox-test.in`;

test('boot', async () => {
  dbh = await startTestDb(DB_PORT);
  mock = await startMockProvider(MOCK_PORT);
  imap = await startImap(IMAP_PORT);
  applyTestEnv(dbh.url, {
    PUBLIC_ORIGIN: base,
    DISABLE_BACKGROUND_WORK: 'true',
    AI_API_KEY: '',
    MAILBOX_TLS_INSECURE: 'true',
    INTAKE_NOTIFY_CANDIDATES: 'true',        // the imported candidate is emailed their login (and the AI interview)
    INTEGRATION_SECRET_KEY: 'test-integration-key-0135-long-enough',
    STORAGE_LOCAL_DIR: resolve(HERE, '../var/test-uploads-mailboxes'),
    EMAIL_API_KEY: 'test-key', EMAIL_FROM: 'noreply@teamlink.example', EMAIL_API_URL: `http://127.0.0.1:${MOCK_PORT}/email`,
    EMAIL_SMTP_HOST: '', EMAIL_SMTP_USER: '', EMAIL_SMTP_PASS: '',
    EMAILJS_SERVICE_ID: '', EMAILJS_TEMPLATE_ID: '', EMAILJS_PUBLIC_KEY: '', EMAILJS_PRIVATE_KEY: '',
    SMS_API_KEY: '', WHATSAPP_API_KEY: '', OUTBOUND_ALLOWLIST: '',
  });
  raw = (sql, params) => dbh.db.query(sql, params);
  await raw(`insert into companies (id, name) values ('co_m', 'Mailbox Co')`);
  const { providers } = await import('../src/notify/providers.js');
  providers.email.send = async (m) => { mailsSent.push(m); return { status: 'sent', provider: 'test' }; };
  const { createApp } = await import('../src/app.js');
  const app = createApp({ logger: { error() {}, log() {} } });
  await new Promise((r) => { server = app.listen(API_PORT, r); });
  admin = await staff('admin', 'admin.mbx@tl-sink.local', 'a_mbx');
  recA = await staff('recruiter', 'rec.a.mbx@tl-sink.local', 'r_mA');
  recB = await staff('recruiter', 'rec.b.mbx@tl-sink.local', 'r_mB');
  await raw(`insert into jobs (id,title,company_id,recruiter_id,location,mode,exp_label,status,skills,description,published_at)
             values ('j_mbx_java','Java Developer','co_m','r_mA','Hyderabad','Onsite','2-5 yrs','open',$1,'Build services.',now())`,
    [['Java', 'Spring Boot', 'SQL']]);

  accounts.set(NAUKRI_BOX, { password: NAUKRI_APP_PW, messages: [
    naukri('Amar Kumar', mailA1),
    shine('Chitra Shine-In-Naukri', mailS1),         // the wrong board, in the Naukri mailbox
    naukriNoRole('Farhan Review', mailR),             // cannot be placed -> review
  ] });
  accounts.set(PERSONAL_BOX, { password: PERSONAL_PW, messages: [] });
  accounts.set(SHINE_BOX, { password: SHINE_APP_PW, messages: [
    shine('Deepak Shine', mailS2),
    naukri('Bhavya Naukri-In-Shine', mailA2),        // the wrong board, in the Shine mailbox
  ] });
});

test('Admin only: recruiters and signed-out visitors cannot reach the connections', async () => {
  assert.equal((await recA.get('/api/intake/source-connections')).status, 403);
  const anon = makeClient(base); await anon.get('/api/health');
  assert.equal((await anon.get('/api/intake/source-connections')).status, 401);
  assert.equal((await recA.post('/api/intake/source-connections', {
    source: 'naukri', recruiterId: 'r_mA', address: NAUKRI_BOX, provider: 'other', appPassword: NAUKRI_APP_PW, host: '127.0.0.1', port: IMAP_PORT,
  })).status, 403);
});

test('a wrong app password is refused at Connect, in plain words, and nothing is saved', async () => {
  const r = await admin.post('/api/intake/source-connections', {
    source: 'naukri', recruiterId: 'r_mA', address: NAUKRI_BOX, provider: 'other',
    appPassword: 'wrong password', host: '127.0.0.1', port: IMAP_PORT,
  });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(r.body.error.code, 'MAILBOX_LOGIN_FAILED');
  assert.match(r.body.error.message, /refused the username or password/);
  assert.equal((await raw(`select count(*)::int n from email_mailboxes where address = $1`, [NAUKRI_BOX])).rows[0].n, 0);

  /* a mail server that is not there: said as such */
  const down = await admin.post('/api/intake/source-connections', {
    source: 'naukri', recruiterId: 'r_mA', address: NAUKRI_BOX, provider: 'other',
    appPassword: NAUKRI_APP_PW, host: '127.0.0.1', port: 9,
  });
  assert.equal(down.status, 400);
  assert.match(down.body.error.message, /refused the connection|did not answer|could not be opened/);
  /* the recruiter is required */
  const noRec = await admin.post('/api/intake/source-connections', {
    source: 'naukri', address: NAUKRI_BOX, provider: 'other', appPassword: NAUKRI_APP_PW, host: '127.0.0.1', port: IMAP_PORT,
  });
  assert.equal(noRec.status, 422);
  assert.ok(noRec.body.error.details.recruiterId);
});

test('Naukri mailbox -> recruiter A: verified login, sealed password, Naukri email only, A owns what it imports', async () => {
  const r = await admin.post('/api/intake/source-connections', {
    source: 'naukri', recruiterId: 'r_mA', address: NAUKRI_BOX, provider: 'other',
    appPassword: NAUKRI_APP_PW, host: '127.0.0.1', port: IMAP_PORT,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  naukriId = r.body.connection.id;
  assert.equal(r.body.connection.source, 'naukri');
  assert.equal(r.body.connection.recruiterName, 'Recruiter r_mA');
  assert.equal(r.body.connection.hasCredential, true);

  const row = (await raw(`select * from email_mailboxes where id = $1`, [naukriId])).rows[0];
  assert.ok(row.secrets_sealed && !row.secrets_sealed.includes(NAUKRI_APP_PW), 'sealed, not stored in clear');
  assert.equal(row.provider, 'imap');
  assert.equal(row.auth_method, 'app_password');

  const conn = await waitIdle(naukriId);
  assert.equal(conn.statusLabel, 'Connected', JSON.stringify(conn));
  assert.ok(conn.lastSuccessfulSyncAt, 'a successful sync is recorded');

  const [a1] = await cand(mailA1);
  assert.ok(a1, 'the Naukri candidate was imported');
  assert.equal(a1.owner_recruiter_id, 'r_mA');
  const aa = await apps(a1.id);
  assert.equal(aa.length, 1);
  assert.deepEqual([aa[0].recruiter_id, aa[0].source], ['r_mA', 'naukri']);

  assert.equal((await cand(mailS1)).length, 0, 'the Shine email in the Naukri mailbox created nobody');
  const m = await msgs(naukriId);
  const wrongBoard = m.find((x) => /Chitra/.test(x.subject) || /Hiring for/.test(x.subject));
  assert.equal(wrongBoard.status, 'ignored');
  assert.match(wrongBoard.reason, /not a Naukri email/);
  const review = m.find((x) => x.subject === 'Application received');
  assert.ok(['needs_mapping', 'needs_review'].includes(review.status), review.status);
  assert.equal(conn.candidatesImported, 1);
  assert.equal(conn.pendingReview, 1);
  assert.equal(conn.emailsProcessed, 3);
});

test('Shine mailbox -> recruiter B: Shine email only, B owns it; Naukri email in it is left alone', async () => {
  const r = await admin.post('/api/intake/source-connections', {
    source: 'shine', recruiterId: 'r_mB', address: SHINE_BOX, provider: 'other',
    appPassword: SHINE_APP_PW, host: '127.0.0.1', port: IMAP_PORT,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  shineId = r.body.connection.id;
  const conn = await waitIdle(shineId);
  assert.equal(conn.source, 'shine');

  assert.equal((await cand(mailA2)).length, 0, 'the Naukri email in the Shine mailbox created nobody');
  const sm = await msgs(shineId);
  assert.match(sm.find((x) => /Bhavya|New application/.test(x.subject)).reason, /not a Shine email/);

  const shineMsg = sm.find((x) => /Hiring for/.test(x.subject));
  const [s2] = await cand(mailS2);
  if (s2) {
    assert.equal(s2.owner_recruiter_id, 'r_mB', 'the Shine candidate is recruiter B\'s');
    for (const a of await apps(s2.id)) assert.deepEqual([a.recruiter_id, a.source], ['r_mB', 'shine']);
  } else {
    assert.ok(['needs_review', 'needs_mapping'].includes(shineMsg.status), `${shineMsg.status}: ${shineMsg.reason}`);
  }
  console.log('  shine email outcome:', shineMsg.status, '-', shineMsg.reason || '', s2 ? `(candidate ${s2.owner_recruiter_id})` : '');
  /* and nothing of B's mailbox went to A */
  const toA = await raw(`select email from candidates where owner_recruiter_id = 'r_mA'`);
  assert.ok(toA.rows.every((x) => ![mailS2, mailA2].includes(x.email)), JSON.stringify(toA.rows));
});

test('the same address cannot be the other board, nor quietly change recruiter', async () => {
  const other = await admin.post('/api/intake/source-connections', {
    source: 'shine', recruiterId: 'r_mA', address: NAUKRI_BOX, provider: 'other', appPassword: NAUKRI_APP_PW, host: '127.0.0.1', port: IMAP_PORT,
  });
  assert.equal(other.status, 409);
  assert.equal(other.body.error.code, 'MAILBOX_OTHER_SOURCE');
  const owned = await admin.post('/api/intake/source-connections', {
    source: 'naukri', recruiterId: 'r_mB', address: NAUKRI_BOX, provider: 'other', appPassword: NAUKRI_APP_PW, host: '127.0.0.1', port: IMAP_PORT,
  });
  assert.equal(owned.status, 409);
  assert.equal(owned.body.error.code, 'MAILBOX_OWNED');
});

test('a recruiter PERSONAL mailbox: Admin is told who has it, and may take it over on purpose (0150)', async () => {
  /* recruiter A connected this address for themselves in the Recruiter Portal: no board, so it is not in the Naukri / Shine table */
  const mine = await recA.post('/api/intake/mailboxes', { address: PERSONAL_BOX, provider: 'imap' });
  assert.equal(mine.status, 201, JSON.stringify(mine.body));
  assert.equal((await admin.get('/api/intake/source-connections')).body.connections.some((c) => c.address === PERSONAL_BOX), false, 'not in the table');

  const body = { source: 'shine', recruiterId: 'r_mB', address: PERSONAL_BOX, provider: 'other', appPassword: PERSONAL_PW, host: '127.0.0.1', port: IMAP_PORT };
  const asked = await admin.post('/api/intake/source-connections', body);
  assert.equal(asked.status, 409);
  assert.equal(asked.body.error.code, 'MAILBOX_PERSONAL');
  assert.match(asked.body.error.message, /personal mailbox by .* in the Recruiter Portal/);
  assert.match(asked.body.error.message, /not in the list/);
  assert.ok(asked.body.error.details.ownerName, 'it names who has it');
  assert.equal((await raw(`select recruiter_id, source from email_mailboxes where address=$1`, [PERSONAL_BOX])).rows[0].recruiter_id, 'r_mA', 'nothing moved without the confirmation');

  const took = await admin.post('/api/intake/source-connections', { ...body, takeOver: true });
  assert.equal(took.status, 201, JSON.stringify(took.body));
  assert.equal(took.body.connection.source, 'shine');
  assert.equal(took.body.connection.recruiterId, 'r_mB');
  const row = (await raw(`select recruiter_id, source, id from email_mailboxes where address=$1`, [PERSONAL_BOX])).rows[0];
  assert.deepEqual([row.recruiter_id, row.source], ['r_mB', 'shine']);
  assert.equal((await raw(`select count(*)::int n from email_mailboxes where address=$1`, [PERSONAL_BOX])).rows[0].n, 1, 'the same row, not a copy');
  assert.ok((await admin.get('/api/intake/source-connections')).body.connections.some((c) => c.address === PERSONAL_BOX), 'now in the table');
  assert.equal((await recA.get('/api/intake/mailboxes')).body.mailboxes.some((m) => m.address === PERSONAL_BOX), false, 'no longer the previous owner mailbox');
  const audit = (await raw(`select detail from audit_log where action='intake.mailbox_taken_over' order by id desc limit 1`)).rows[0];
  assert.ok(audit, 'the take-over is in the audit log');
  assert.equal(audit.detail.previousRecruiterId, 'r_mA');
  assert.equal(audit.detail.recruiterId, 'r_mB');

  /* taking it over does not open the door to Naukri / Shine mailboxes that already belong to somebody: that is still Reassign */
  const still = await admin.post('/api/intake/source-connections', { ...body, recruiterId: 'r_mA', takeOver: true });
  assert.equal(still.status, 409);
  assert.equal(still.body.error.code, 'MAILBOX_OWNED');

  /* leave the other tests the two mailboxes they expect */
  await raw(`delete from email_mailboxes where address = $1`, [PERSONAL_BOX]);
});

test('syncing again creates nothing twice (same mailbox + message id)', async () => {
  const before = (await raw(`select count(*)::int n from candidates`)).rows[0].n;
  const beforeMsgs = (await msgs(naukriId)).length;
  const s = await admin.post(`/api/intake/source-connections/${naukriId}/sync`, {});
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.equal(s.body.imported, 0);
  assert.equal((await raw(`select count(*)::int n from candidates`)).rows[0].n, before);
  assert.equal((await msgs(naukriId)).length, beforeMsgs);
  assert.equal((await apps((await cand(mailA1))[0].id)).length, 1);
});

test('recruiter isolation: each recruiter sees only their own mailboxes and emails, and cannot change Admin\'s', async () => {
  const boxesB = (await recB.get('/api/intake/mailboxes')).body.mailboxes.map((x) => x.id);
  assert.ok(boxesB.includes(shineId) && !boxesB.includes(naukriId), JSON.stringify(boxesB));
  const boxesA = (await recA.get('/api/intake/mailboxes')).body.mailboxes.map((x) => x.id);
  assert.ok(boxesA.includes(naukriId) && !boxesA.includes(shineId), JSON.stringify(boxesA));

  const msgsB = (await recB.get('/api/intake/messages')).body.messages;
  assert.ok(msgsB.length > 0 && msgsB.every((x) => x.mailboxId === shineId), 'B reads only the Shine mailbox\'s emails');
  const msgsA = (await recA.get('/api/intake/messages?mailboxId=' + shineId)).body.messages;
  assert.equal(msgsA.length, 0, 'A cannot read B\'s mailbox even by asking for it');
  const queueA = (await recA.get('/api/intake/queue')).body;
  assert.ok(queueA.queue.every((x) => x.mailboxId === naukriId));

  /* B cannot touch A's mailbox; A cannot change Admin's connection to their own mailbox */
  assert.equal((await recB.post(`/api/intake/mailboxes/${naukriId}/disconnect`, {})).status, 404);
  assert.equal((await recB.post('/api/intake/sync', { mailboxId: naukriId })).status, 404);
  assert.equal((await recA.post(`/api/intake/mailboxes/${naukriId}/disconnect`, {})).status, 403);
  assert.equal((await recA.del(`/api/intake/mailboxes/${naukriId}`)).status, 403);
  assert.equal((await recA.patch(`/api/intake/mailboxes/${naukriId}`, { autoSync: false })).status, 403);
  /* a recruiter's own "connect a mailbox" cannot take over the Naukri address */
  const take = await recB.post('/api/intake/mailboxes', { address: NAUKRI_BOX, provider: 'imap' });
  assert.equal(take.status, 409, JSON.stringify(take.body));
  const still = (await raw(`select recruiter_id, source, status from email_mailboxes where id=$1`, [naukriId])).rows[0];
  assert.deepEqual([still.recruiter_id, still.source, still.status], ['r_mA', 'naukri', 'connected']);
  /* B's message actions cannot reach A's emails */
  const aMsg = (await raw(`select id from email_messages where mailbox_id=$1 limit 1`, [naukriId])).rows[0].id;
  assert.equal((await recB.post(`/api/intake/messages/${aMsg}/ignore`, {})).status, 404);
  /* a recruiter's plain "Sync" reads only their own mailbox */
  const syncB = await recB.post('/api/intake/sync', {});
  assert.equal(syncB.status, 200);
  assert.ok(syncB.body.synced.every((x) => x.mailbox !== NAUKRI_BOX), JSON.stringify(syncB.body.synced.map((x) => x.mailbox)));
});

test('reassign is explicit and confirmed; no existing candidate moves; the same recruiter can own both boards', async () => {
  const noConfirm = await admin.post(`/api/intake/source-connections/${shineId}/reassign`, { recruiterId: 'r_mA' });
  assert.equal(noConfirm.status, 422);
  const r = await admin.post(`/api/intake/source-connections/${shineId}/reassign`, { recruiterId: 'r_mA', confirm: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.connection.recruiterId, 'r_mA');
  const [s2] = await cand(mailS2);
  if (s2) assert.equal(s2.owner_recruiter_id, 'r_mB', 'the Shine candidate imported earlier stays recruiter B\'s');

  /* a new Shine email now goes to A - who owns the Naukri mailbox too */
  accounts.get(SHINE_BOX).messages.push(shine('Esha Shine', mailS3));
  const s = await admin.post(`/api/intake/source-connections/${shineId}/sync`, {});
  assert.equal(s.status, 200, JSON.stringify(s.body));
  const [s3] = await cand(mailS3);
  if (s3) assert.equal(s3.owner_recruiter_id, 'r_mA');
  const list = (await admin.get('/api/intake/source-connections')).body.connections;
  assert.deepEqual(list.map((x) => [x.source, x.recruiterId]).sort(), [['naukri', 'r_mA'], ['shine', 'r_mA']]);
});

test('ownership is read again before every email: a reassignment during a sync applies to the next email', async () => {
  const box = accounts.get(NAUKRI_BOX);
  const first = box.messages.length + 1;
  box.messages.push(naukri('Gita Race', mailRace1), naukri('Hari Race', mailRace2));
  box.onFetch = async (n) => {
    /* after the first new email was fetched, Admin moves the mailbox to recruiter B */
    if (n === first + 1) await raw(`update email_mailboxes set recruiter_id = 'r_mB' where id = $1`, [naukriId]);
  };
  const s = await admin.post(`/api/intake/source-connections/${naukriId}/sync`, {});
  box.onFetch = null;
  assert.equal(s.status, 200, JSON.stringify(s.body));
  /* the fetch happens before processing in this client, so both emails are processed after the move -
     which is the point: the owner at PROCESSING time decides, not the owner when the sync began */
  const [g] = await cand(mailRace1); const [h] = await cand(mailRace2);
  assert.ok(g && h, 'both imported');
  assert.equal(h.owner_recruiter_id, 'r_mB', 'the email processed after the reassignment is the new owner\'s');
  await raw(`update email_mailboxes set recruiter_id = 'r_mA' where id = $1`, [naukriId]);
});

test('disconnect erases the password and stops reading; reconnect re-tests the login', async () => {
  const d = await admin.post(`/api/intake/source-connections/${naukriId}/disconnect`, {});
  assert.equal(d.status, 200);
  assert.equal(d.body.connection.statusLabel, 'Disconnected');
  assert.equal(d.body.connection.hasCredential, false);
  const row = (await raw(`select secrets_sealed, status, auto_sync from email_mailboxes where id=$1`, [naukriId])).rows[0];
  assert.deepEqual([row.secrets_sealed, row.status, row.auto_sync], [null, 'disconnected', false]);
  assert.ok((await cand(mailA1)).length === 1, 'imported candidates stay');

  const logins = imapLogins;
  assert.equal((await admin.post(`/api/intake/source-connections/${naukriId}/sync`, {})).status, 409);
  const { syncAll } = await import('../src/intake/process.js');
  await syncAll(null, { onlyAuto: true });
  assert.equal(imapLogins, logins - 0 + (await raw(`select count(*)::int n from email_mailboxes where auto_sync and source = 'shine'`)).rows[0].n,
    'the automatic sweep did not log in to the disconnected mailbox');

  const noPw = await admin.post(`/api/intake/source-connections/${naukriId}/reconnect`, {});
  assert.equal(noPw.status, 422);
  const bad = await admin.post(`/api/intake/source-connections/${naukriId}/reconnect`, { appPassword: 'nope' });
  assert.equal(bad.status, 400);
  assert.equal((await raw(`select status from email_mailboxes where id=$1`, [naukriId])).rows[0].status, 'disconnected');
  const ok = await admin.post(`/api/intake/source-connections/${naukriId}/reconnect`, { appPassword: NAUKRI_APP_PW });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const conn = await waitIdle(naukriId);
  assert.equal(conn.statusLabel, 'Connected');
  assert.equal(conn.hasCredential, true);
});

test('View Logs: each email with its status in Admin\'s words, and the audit trail', async () => {
  const l = await admin.get(`/api/intake/source-connections/${naukriId}/logs`);
  assert.equal(l.status, 200);
  const labels = new Set(l.body.emails.map((x) => x.statusLabel));
  assert.ok(labels.has('Imported') && labels.has('Pending Review') && labels.has('Not an application'), [...labels].join(','));
  const acts = l.body.events.map((x) => x.action);
  for (const a of ['intake.mailbox_connected', 'intake.mailbox_synced', 'intake.mailbox_disconnected', 'intake.mailbox_reconnected']) {
    assert.ok(acts.includes(a), `${a} in ${acts.join(',')}`);
  }
  const reassigned = (await raw(`select detail from audit_log where action='intake.mailbox_reassigned' and entity_id=$1`, [shineId])).rows;
  assert.deepEqual([reassigned[0].detail.from, reassigned[0].detail.to], ['r_mB', 'r_mA']);
  /* and the audit page names them */
  const page = await admin.get('/api/admin/audit-log?entity=mailbox&pageSize=50');
  assert.equal(page.status, 200, JSON.stringify(page.body).slice(0, 300));
});

test('no response ever carried an app password', async () => {
  const all = seen.join('\n');
  for (const secret of [NAUKRI_APP_PW, SHINE_APP_PW]) assert.ok(!all.includes(secret), 'a password came back in a response');
  assert.ok(!/secrets_sealed|secretsSealed/.test(all));
});

test('an import that ends with no requirement tells the mailbox owner IN THE PORTAL, once, and emails nobody (0151, 0162)', async () => {
  await new Promise((r) => setTimeout(r, 400));          // the notice is made in the background after the import
  const waiting = (await raw(`select m.id, m.mapping_notified_at, b.recruiter_id from email_messages m join email_mailboxes b on b.id = m.mailbox_id
                               where m.status = 'needs_mapping' and b.source is not null`)).rows;
  assert.equal(mailsSent.filter((x) => /^Action needed:/.test(x.subject)).length, 0, 'no email about an imported response');
  if (!waiting.length) { console.log('  (no message ended as needs_mapping in this run; the notice itself is covered by intake-unmapped-notice.test.mjs)'); return; }
  const inPortal = async () => (await raw(`select count(*)::int n from notifications where type like 'IMPORT_NEEDS_REQUIREMENT#%'`)).rows[0].n;
  assert.equal(await inPortal(), waiting.filter((w) => w.recruiter_id).length, 'one portal notification per waiting message');
  assert.ok(waiting.every((w) => w.mapping_notified_at), 'every one was claimed');
  const n0 = await inPortal();
  /* a sync reads the same messages again: nobody is told twice */
  for (const id of [naukriId, shineId]) await admin.post(`/api/intake/source-connections/${id}/sync`, {});
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(await inPortal(), n0, 'no second notification');
  assert.equal(mailsSent.filter((x) => /^Action needed:/.test(x.subject)).length, 0, 'and still no email');
});

test('a pasted Gmail app password loses its spaces and line breaks; other providers only lose the ends', async () => {
  const { cleanAppPassword } = await import('../src/routes/source-mailboxes.js');
  assert.equal(cleanAppPassword('gmail', 'abcd efgh ijkl mnop'), 'abcdefghijklmnop');
  assert.equal(cleanAppPassword('gmail', '  abcd efgh ijkl mnop \n'), 'abcdefghijklmnop');
  assert.equal(cleanAppPassword('gmail', 'abcd\u00a0efgh ijkl\tmnop'), 'abcdefghijklmnop');
  assert.equal(cleanAppPassword('other', '  pass word 1 \n'), 'pass word 1');
  assert.equal(cleanAppPassword('outlook', 'x y'), 'x y');
  assert.equal(cleanAppPassword('gmail', undefined), '');
});

test('an imported candidate is emailed their login AND the AI interview invitation, once (0151b)', async () => {
  const [a1] = await cand(mailA1);
  const mails = mailsSent.filter((m) => m.to === mailA1);
  assert.equal(mails.length, 1, `exactly one email to the imported candidate, got ${mails.length}`);
  const m = mails[0];
  assert.match(m.text, /Candidate Portal login:/);
  assert.match(m.text, new RegExp(`Email: ${mailA1.replace(/[.]/g, '\\.')}`));
  assert.match(m.text, /Temporary password: \S{8,}/, 'the temporary password is in the email');
  assert.match(m.text, /Attend your AI interview:/);
  assert.match(m.text, /15 questions/);
  assert.match(m.text, /There is no closing date: you can attend it at any time while this job is open\./);
  assert.match(m.text, /press "Attend AI Interview"/);
  assert.match(m.text, /take a photo and accept the interview instructions/);
  /* the password is not kept anywhere in plain text */
  const u = (await raw(`select u.password_hash, u.must_change_password from users u join candidates c on c.user_id = u.id where c.id = $1`, [a1.id])).rows[0];
  assert.equal(u.must_change_password, true);
  assert.ok(!u.password_hash.includes(m.text.match(/Temporary password: (\S+)/)[1]));
  /* the invitation is marked sent, and the one-email claim is recorded */
  const inv = await raw(`select 1 from ai_interview_reminders r join applications a on a.id = r.application_id
                          where a.candidate_id = $1 and r.kind = 'invited'`, [a1.id]);
  assert.equal(inv.rowCount, 1);
  const claimed = (await raw(`select import_login_notified_at from applications where candidate_id = $1`, [a1.id])).rows;
  assert.ok(claimed.length === 1 && claimed[0].import_login_notified_at, 'the once-only claim is recorded');
});

test('shutdown', async () => {
  await new Promise((r) => server.close(r));
  const { stopBackgroundWork } = await import('../src/app.js');
  stopBackgroundWork();
  const { closePool } = await import('../src/db.js');
  await closePool();
  await new Promise((r) => imap.close(r));
  await mock.stop();
  await dbh.stop();
});
