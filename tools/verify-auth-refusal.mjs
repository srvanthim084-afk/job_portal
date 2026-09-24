/**
 * A refused password is not sent again and again.
 *
 *     node tools/verify-auth-refusal.mjs   (needs the dev server on :4323)
 *
 * The intake sweep runs on a timer over every auto-sync mailbox. A
 * mailbox connected with the wrong password therefore attempted a login
 * every few minutes, for as long as it stayed connected. That is not a
 * harmless no-op: repeated failed logins are how Google locks an
 * account, and the account belongs to the recruiter.
 *
 * It cannot stop forever either, or fixing the password would do nothing
 * until somebody knew to press something. So the FINGERPRINT of the
 * refused credential is remembered - a sha256, never the secret - and
 * the sweep skips the mailbox only while the credential still hashes to
 * that. Change it and the next sweep tries again by itself.
 */
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

/*
 * The credentials, as the server has them.
 *
 * Without this there is no credential to fingerprint, the comparison
 * finds nothing to compare, and the sweep attempts a login with an
 * empty password - which the server refuses, making the test look like
 * the safeguard had failed when it had simply never been given one.
 */
const envFile = resolve(process.cwd(), process.env.ENV_FILE || '.env');
if (existsSync(envFile) && typeof process.loadEnvFile === 'function') process.loadEnvFile(envFile);

const BASE = (process.env.TL_URL || 'http://localhost:4323/').replace(/\/$/, '');
const fail = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`); if (!ok) fail.push(what); };

const { credentialFingerprint, isAuthFailure } = await import('../api/src/intake/mailbox.js');

/* ---- the fingerprint is a fingerprint, not the secret --------------- */
const fp = credentialFingerprint('a@b.com', 'hunter2');
check(typeof fp === 'string' && fp.length === 32, `it is a short hash (${fp})`);
check(!fp.includes('hunter2'), 'and the secret is not in it');
check(credentialFingerprint('a@b.com', 'hunter2') === fp, 'the same credential marks the same');
check(credentialFingerprint('a@b.com', 'hunter3') !== fp,
  'a changed credential marks differently, so a fix resumes by itself');
check(credentialFingerprint('other@b.com', 'hunter2') !== fp,
  'and the same password on another mailbox is a different mark');
check(credentialFingerprint('a@b.com', '') === null, 'no credential, no mark');

/* ---- only a REFUSAL counts, not a network failure -------------------- */
check(isAuthFailure(new Error('the mail server refused: NO [AUTHENTICATIONFAILED] Invalid credentials')),
  'a refusal is recognised');
check(isAuthFailure(new Error('LOGIN failed')), 'and so is a plainer one');
check(!isAuthFailure(new Error('the mail server did not answer')),
  'a server that did not answer is NOT a refusal - retrying that is right');
check(!isAuthFailure(new Error('getaddrinfo ENOTFOUND imap.example.com')),
  'and neither is a name that does not resolve');

/* ---- the sweep, which is the thing on a timer ----------------------- *
 * NOT through the HTTP route: "Sync every mailbox now" passes
 * onlyAuto:false on purpose, because a person pressing a button is
 * asking deliberately and one attempt locks nothing. The thing that had
 * to stop is the SCHEDULER, which passes onlyAuto:true - so that is what
 * is called here, in this process, with the database to itself.
 */
let db = null;
try {
  const { PGlite } = await import('@electric-sql/pglite');
  const { PGLiteSocketServer } = await import('@electric-sql/pglite-socket');
  const dir = process.env.DEV_DB_DIR || 'var/dev-db';
  const port = Number(process.env.PG_PORT || 5434);
  db = await new PGlite(dir);
  await db.exec(`do $$ begin
    if exists (select 1 from pg_roles where rolname='app_api') then
      alter role app_api login password 'dev_only_password';
    end if; end $$;`);
  const srv = new PGLiteSocketServer({ db, port, host: '127.0.0.1' });
  await srv.start();
  process.env.DATABASE_URL = `postgres://postgres:postgres@127.0.0.1:${port}/postgres`;
  process.env.DB_ROLE = 'app_api';
  process.env.DB_POOL_MAX = '1';
  db.__server = srv;
} catch (err) {
  console.log(`--    the sweep check needs the database free; stop the dev server`);
  console.log(`--    (${String(err.message).slice(0, 70)})`);
  db = null;
}

if (db) {
  const { syncAll } = await import('../api/src/intake/process.js');
  const ENGINE = { userId: '', role: 'admin', profileId: null };

  const KEY = 'MAILBOX_MTEAMLINK_AT_GMAIL_COM_PASSWORD';
  const original = process.env[KEY];

  const rows = (await db.query(`select id, address from email_mailboxes`)).rows;
  const gmail = rows.find((r) => /gmail/i.test(r.address));

  if (!gmail || !original) {
    console.log('--    no Gmail mailbox with a credential; the sweep check is skipped');
  } else {
    /*
     * Recorded by this run rather than inherited from the last one. A
     * fingerprint left behind by a previous test is exactly the state
     * that made this look broken when it was not.
     */
    await db.query(`select mailbox_auth_accepted($1)`, [gmail.id]);

    const { syncAll } = await import('../api/src/intake/process.js');
    const ENGINE = { userId: '', role: 'admin', profileId: null };

    const first = await syncAll(ENGINE, { onlyAuto: true });
    const attempt = first.find((o) => o.mailbox === gmail.address) || {};
    check(/auth/i.test(String(attempt.message || '')),
      `the first sweep tries, and is refused (${String(attempt.message || '').slice(0, 52)})`);

    const marked = (await db.query(
      `select auth_refused_fingerprint from email_mailboxes where id=$1`, [gmail.id])).rows[0];
    check(!!marked.auth_refused_fingerprint,
      `the refusal is remembered as a fingerprint (${marked.auth_refused_fingerprint})`);
    check(!String(marked.auth_refused_fingerprint).includes(original),
      'and the password itself is not in it');

    const second = await syncAll(ENGINE, { onlyAuto: true });
    const skipped = second.find((o) => o.mailbox === gmail.address) || {};
    check(skipped.error === 'auth_refused',
      `the NEXT sweep skips it rather than sending the password again (${skipped.error})`);
    check(/will not be sent again/i.test(String(skipped.message || '')),
      `and says why (${String(skipped.message || '').slice(0, 56)})`);

    const other = second.find((o) => o.mailbox && !/gmail/i.test(o.mailbox));
    check(!!other && other.error !== 'auth_refused',
      `one refused mailbox does not stop the rest (${other && other.mailbox}: read ${other && other.seen})`);

    /* Change it, and it tries again by itself - no button to press. */
    process.env[KEY] = 'a-different-credential';
    const third = await syncAll(ENGINE, { onlyAuto: true });
    const retried = third.find((o) => o.mailbox === gmail.address) || {};
    check(retried.error !== 'auth_refused',
      `changing the credential makes it try again by itself (${retried.error || 'attempted'})`);

    /* Put the environment and the mark back as they were found. */
    process.env[KEY] = original;
    await db.query(`select mailbox_auth_accepted($1)`, [gmail.id]);
    const cleared = (await db.query(
      `select auth_refused_fingerprint from email_mailboxes where id=$1`, [gmail.id])).rows[0];
    check(!cleared.auth_refused_fingerprint, 'the mark was cleared again afterwards');
  }

  try { await db.__server.stop(); } catch { /* going anyway */ }
  await db.close();
}

console.log(fail.length ? `\n${fail.length} failed` : '\nall good');
process.exit(fail.length ? 1 : 0);
