/**
 * The resume that came attached to the email.
 *
 * The intake screen has always shown a filename beside an imported
 * candidate and the file was nowhere: the MIME reader took the
 * attachment's NAME out of the headers and nothing ever read the bytes.
 * This checks the bytes, and checks them the hard way - by building real
 * email out of real files and comparing sha256 at the far end, because
 * "an attachment was found" and "the candidate's resume is the file the
 * candidate attached" are different claims.
 *
 *   node tools/verify-attachments.mjs
 *
 * The first half needs nothing. The second half needs the DATABASE FREE,
 * which means the dev server stopped - the embedded engine serves one
 * client at a time. It says so and skips rather than failing when the
 * server is running.
 */
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { attachmentsOf, bodyOf } from '../api/src/intake/mime.js';

const fail = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`); if (!ok) fail.push(what); };
const sha = (b) => createHash('sha256').update(b).digest('hex');

/*
 * The database FIRST, before anything under api/src is imported.
 *
 * config.js reads the environment once, at import. Loading .env or
 * pointing DATABASE_URL at the embedded engine afterwards changes
 * nothing - the connection string was already decided, and this half
 * spent its first version reporting that a database on port 5432 it
 * had never been asked to use was refusing connections.
 */
/* ------------------------------------------------------------------ *
 * end to end, when the database is free
 * ------------------------------------------------------------------ */
const envFile = resolve(process.cwd(), process.env.ENV_FILE || '.env');
if (existsSync(envFile) && typeof process.loadEnvFile === 'function') process.loadEnvFile(envFile);

/*
 * Bring the development database up ourselves.
 *
 * The embedded engine serves ONE client, and the dev server holds it
 * while it is running - so this half cannot simply connect. It starts
 * the same engine over the same directory instead, which works when
 * the server is stopped and says so plainly when it is not.
 */
let db = null;
let pgServer = null;
let pglite = null;
if (!process.env.DATABASE_URL) {
  try {
    const { PGlite } = await import('@electric-sql/pglite');
    const { PGLiteSocketServer } = await import('@electric-sql/pglite-socket');
    const dir = process.env.DEV_DB_DIR || 'var/dev-db';
    const port = Number(process.env.PG_PORT || 5434);

    pglite = await new PGlite(dir);
    await pglite.exec(`do $$ begin
      if exists (select 1 from pg_roles where rolname='app_api') then
        alter role app_api login password 'dev_only_password';
      end if; end $$;`);
    pgServer = new PGLiteSocketServer({ db: pglite, port, host: '127.0.0.1' });
    await pgServer.start();

    process.env.DATABASE_URL = `postgres://postgres:postgres@127.0.0.1:${port}/postgres`;
    process.env.DB_ROLE = 'app_api';
    process.env.DB_POOL_MAX = '1';
  } catch (err) {
    console.log(`\n--    the end-to-end half needs the database to itself.`);
    console.log(`--    Stop the dev server and run this again (${String(err.message).slice(0, 70)})`);
  }
}

if (process.env.DATABASE_URL) {
  try {
    const mod = await import('../api/src/db.js');
    await mod.withUser({ userId: '', role: 'admin', profileId: null },
      (c) => c.query('select 1'));
    db = mod;
  } catch (err) {
    const why = (err.errors || []).map((e) => e.message).join('; ') || err.message;
    console.log(`\n--    the database could not be reached (${String(why).slice(0, 90)})`);
  }
}

/* ------------------------------------------------------------------ *
 * real files, not fixtures of what a file might contain
 * ------------------------------------------------------------------ */
const DIR = 'var/test-resumes';
if (!existsSync(`${DIR}/Resume - Sravanthi.pdf`)) {
  execFileSync(process.execPath, ['tools/make-test-resumes.mjs', DIR], { stdio: 'inherit' });
}
const PDF = readFileSync(`${DIR}/Resume - Sravanthi.pdf`);
const DOCX = readFileSync(`${DIR}/Resume - Sravanthi.docx`);

const b64 = (buf) => buf.toString('base64').replace(/(.{76})/g, '$1\r\n');

/**
 * A message shaped like the ones that actually arrive.
 *
 * multipart/mixed wrapping a multipart/alternative - which is what
 * Naukri sends and what the first MIME reader could not see through -
 * plus an inline signature image, which must NOT be mistaken for a
 * document, and two attachments named three different legal ways.
 */
const CRLF = '\r\n';
const message = [
  'From: jobsapply@naukri.com',
  'To: teamlinkmed001@tmlink.in',
  'Subject: New application received for Java Developer',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="OUTER"',
  '',
  '--OUTER',
  'Content-Type: multipart/alternative; boundary="INNER"',
  '',
  '--INNER',
  'Content-Type: text/plain; charset=utf-8',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  'Candidate Name: Sravanthi M=C3=A1ngalapalli',
  'Candidate Email: sravanthi.attach@example.com',
  'Mobile: 9000012345',
  'Applied Role: Java Developer',
  '',
  '--INNER',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<p>Candidate Name: Sravanthi</p>',
  '',
  '--INNER--',
  '',
  '--OUTER',
  // RFC 2047, because Naukri encodes anything non-ASCII in a filename.
  'Content-Type: application/pdf; name="=?utf-8?B?UsOpc3Vtw6k=?=.pdf"',
  'Content-Disposition: attachment; filename="=?utf-8?B?UsOpc3Vtw6k=?=.pdf"',
  'Content-Transfer-Encoding: base64',
  '',
  b64(PDF),
  '',
  '--OUTER',
  // RFC 2231, which the other half of the world uses.
  'Content-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  "Content-Disposition: attachment; filename*=UTF-8''Resume%20-%20Sravanthi.docx",
  'Content-Transfer-Encoding: base64',
  '',
  b64(DOCX),
  '',
  '--OUTER',
  'Content-Type: image/png; name="signature.png"',
  'Content-Disposition: inline',
  'Content-ID: <sig>',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64'),
  '',
  '--OUTER--',
  '',
].join(CRLF);

/* ---- the files come back byte for byte ----------------------------- */
const files = attachmentsOf(message);
check(files.length === 2, `two attachments, not the signature image (${files.length})`);

const pdf = files.find((f) => /\.pdf$/i.test(f.filename));
const docx = files.find((f) => /\.docx$/i.test(f.filename));

check(!!pdf, 'the RFC 2047 encoded filename was decoded');
check(pdf && pdf.filename === 'Résumé.pdf', `the accented name survived (${pdf && pdf.filename})`);
check(!!docx, 'the RFC 2231 encoded filename was decoded');
check(docx && docx.filename === 'Resume - Sravanthi.docx',
  `the percent-encoded name survived (${docx && docx.filename})`);

check(pdf && sha(pdf.buffer) === sha(PDF),
  'the PDF is byte for byte the file that was attached');
check(docx && sha(docx.buffer) === sha(DOCX),
  'the DOCX is byte for byte the file that was attached');
check(!files.some((f) => /\.png$/i.test(f.filename)),
  'an inline signature image is not treated as a document');

/* ---- the body still reads, and now reads correctly ------------------ */
const body = bodyOf(message);
check(/Candidate Name: Sravanthi/.test(body.text),
  'the message text is still found through two levels of multipart');
check(/Mángalapalli/.test(body.text),
  `quoted-printable UTF-8 is read as UTF-8, not as bytes (${
    (/Name: ([^\r\n]*)/.exec(body.text) || [])[1]})`);

/* ---- the IMAP literal is sliced by BYTES ---------------------------- */
/*
 * The bug this guards: a FETCH literal announces its size in bytes and
 * the message is cut out of a string by that number. Under utf8 a
 * multi-byte character is one character, the count and the index stop
 * agreeing, and the cut lands in the wrong place - which on a message
 * with an attachment means a truncated base64 part and a corrupt file.
 */
const bytes = Buffer.byteLength(message, 'latin1');
const frame = `* 4 FETCH (BODY[] {${bytes}}\r\n${message})\r\na4 OK Fetch completed\r\n`;
const lit = /\{(\d+)\}\r?\n/.exec(frame);
const sliced = frame.slice(lit.index + lit[0].length, lit.index + lit[0].length + Number(lit[1]));
check(sliced === message, 'a byte count and a latin1 string agree, so the message is cut exactly');
check(attachmentsOf(sliced).length === 2 && sha(attachmentsOf(sliced)[0].buffer) === sha(PDF),
  'the attachment survives the IMAP framing intact');

/* ---- a disguised file is refused ------------------------------------ */
const { validateResume } = await import('../api/src/storage.js');
let refused = null;
try {
  validateResume(Buffer.from('<html><script>alert(1)</script></html>'), 'resume.pdf');
} catch (err) { refused = err.message; }
check(!!refused, `an HTML file named .pdf is refused, not stored (${refused || 'IT WAS ACCEPTED'})`);

let refusedExe = null;
try { validateResume(Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]), 'cv.pdf'); }
catch (err) { refusedExe = err.message; }
check(!!refusedExe, 'an executable named .pdf is refused');

if (db) {
  const { withUser } = db;
  const { storeAttachedResume } = await import('../api/src/intake/attachment.js');
  const { getStorage } = await import('../api/src/storage.js');
  const ENGINE = { userId: '', role: 'admin', profileId: null };

  const id = `cand_verify_${Date.now().toString(36)}`;
  await withUser(ENGINE, (c) => c.query(
    `insert into candidates (id, name, email) values ($1,$2,$3)`,
    [id, 'Attachment Verification', `${id}@example.invalid`]));

  try {
    const out = await storeAttachedResume({
      candidateId: id, applicationId: null, attachments: files,
    });
    check(out.status === 'stored', `the attached resume was stored (${out.status})`);

    const row = await withUser(ENGINE, async (c) => (await c.query(
      `select resume_file, resume_storage_path, resume_size, resume_chars,
              resume_fields_detected, skills, title
         from candidates where id=$1`, [id])).rows[0]);
    check(!!row.resume_storage_path, 'the candidate row points at a stored file');
    check(row.resume_size === PDF.length,
      `the stored size is the file's size (${row.resume_size} vs ${PDF.length})`);

    const back = await getStorage().get(row.resume_storage_path);
    check(sha(back) === sha(PDF),
      'the file read back out of storage is the file that was attached');
    check(Number(row.resume_chars) > 0,
      `the resume was read, not just filed (${row.resume_chars} characters)`);
    check((row.skills || []).length > 0 || !!row.title,
      `what the resume says reached the candidate (${(row.skills || []).length} skills)`);

    // A second email must not replace what is already on file.
    const again = await storeAttachedResume({
      candidateId: id, applicationId: null, attachments: files,
    });
    check(again.status === 'kept_existing',
      `a later email does not overwrite a resume already on file (${again.status})`);
  } finally {
    await withUser(ENGINE, (c) => c.query(`delete from candidates where id=$1`, [id]));
  }

  /* ---- the whole path, as the sync runs it ------------------------- *
   * Everything above proves the pieces. This proves the WIRING: an
   * email arrives, and the candidate it creates has the file that was
   * attached to it. The two are different claims, and the second is the
   * one the recruiter actually asked for.
   */
  const { processMessage } = await import('../api/src/intake/process.js');
  const stamp = Date.now().toString(36);
  const jobId = `job_verify_${stamp}`;
  const boxId = `mbx_verify_${stamp}`;
  const email = `sravanthi.attach.${stamp}@example.invalid`;

  await withUser(ENGINE, (c) => c.query(
    `insert into jobs (id, title, status, location)
     values ($1, $2, 'open', 'Hyderabad')`,
    [jobId, `Java Developer ${stamp}`]));
  /*
   * The mailbox is not written to the database, and deliberately.
   *
   * A mailbox row is owned by a recruiter and the policy says so, which
   * is correct - and it means a verifier has no business creating one.
   * processMessage reads the address, the id and the rules, so the
   * object is enough, and the candidate, the application and the resume
   * that come out of it are all real.
   */
  const mailbox = { id: boxId, address: `verify-${stamp}@example.invalid`,
                    provider: 'imap', rules: null, recruiter_id: null };

  const rowId = `msg_verify_${stamp}`;
  const arriving = message
    .replace('sravanthi.attach@example.com', email)
    .replace('Applied Role: Java Developer', `Applied Role: Java Developer ${stamp}`);

  let createdCandidate = null;
  let createdApplication = null;
  try {
    const out = await processMessage(ENGINE, {
      mailbox,
      // Exactly what the IMAP provider hands over, built by the same
      // reader from the same bytes.
      message: {
        messageId: `verify-${stamp}@teamlink`,
        from: 'jobsapply@naukri.com',
        to: mailbox.address,
        subject: 'New application received for Java Developer',
        text: bodyOf(arriving).text,
        raw: arriving,
        receivedAt: new Date(),
        attachments: attachmentsOf(arriving),
        attachmentName: 'Resume.pdf',
        hasAttachment: true,
      },
      rowId,
      provider: 'all',
    });

    createdCandidate = out.candidateId;
    createdApplication = out.applicationId;

    check(out.status === 'processed' || out.status === 'needs_review',
      `the email became an application (${out.status}: ${out.reason})`);
    check(!!out.candidateId, 'a candidate was created from the email');
    check(out.resume && out.resume.status === 'stored',
      `the attached resume was imported with it (${out.resume && out.resume.status})`);

    const cand = await withUser(ENGINE, async (c) => (await c.query(
      `select resume_file, resume_storage_path, resume_size from candidates where id=$1`,
      [out.candidateId])).rows[0]);
    check(cand && cand.resume_size === PDF.length,
      `the candidate's resume is the attached file (${cand && cand.resume_size} bytes)`);

    const events = await withUser(ENGINE, async (c) => (await c.query(
      `select type from application_events where application_id=$1`,
      [out.applicationId])).rows.map((r) => r.type));
    check(events.includes('resume.imported'),
      'the timeline records where the resume came from');
  } finally {
    /*
     * Leave nothing behind.
     *
     * This runs against the real development database, and a verifier
     * that leaves a job called "Java Developer" and a candidate nobody
     * applied for is exactly the demo data everybody was asked to
     * remove.
     */
    /*
     * Removed through the ENGINE, not the API role.
     *
     * app_api may not delete an application's events - correctly, since
     * a timeline nobody can erase is half of what makes it evidence. The
     * verifier owns this engine for the length of the run, so it cleans
     * up as the owner rather than asking for a permission the
     * application should never have.
     */
    const purge = pglite
      ? (sql, params) => pglite.query(sql, params)
      : (sql, params) => withUser(ENGINE, (c) => c.query(sql, params));

    if (createdApplication) {
      await purge(`delete from application_events where application_id=$1`, [createdApplication]);
      await purge(`delete from notification_deliveries where application_id=$1`, [createdApplication]);
      await purge(`delete from applications where id=$1`, [createdApplication]);
    }
    await purge(`delete from email_messages where id=$1`, [rowId]);
    if (createdCandidate) {
      // The portal account the import creates, found the way the
      // candidate points at it.
      await purge(
        `delete from users where id in (select user_id from candidates where id=$1)`,
        [createdCandidate]);
      await purge(`delete from candidates where id=$1`, [createdCandidate]);
    }
    await purge(`delete from jobs where id=$1`, [jobId]);

    const left = (await purge(
      `select (select count(*) from jobs where id=$1)
            + (select count(*) from candidates where id=$2)
            + (select count(*) from applications where id=$3) as n`,
      [jobId, createdCandidate || '', createdApplication || ''])).rows[0].n;
    check(Number(left) === 0, `the verification data was removed again (${left} rows left)`);
  }
}

// A clean close, so the embedded engine flushes what was written.
if (pgServer) { try { await pgServer.stop(); } catch { /* going anyway */ } }
if (pglite) { try { await pglite.close(); } catch { /* going anyway */ } }

console.log(fail.length ? `\n${fail.length} failed` : '\nall good');
process.exit(fail.length ? 1 : 0);
