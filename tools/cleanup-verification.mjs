/**
 * Take the verifiers' candidates back out.
 *
 *     node tools/cleanup-verification.mjs            what it would remove
 *     node tools/cleanup-verification.mjs --confirm  remove it
 *
 * The acceptance tests create a real candidate and a real application,
 * because a test that stubs those proves nothing. They remove the
 * REQUIREMENT they raised, and they cannot remove the PERSON: there is
 * no route that deletes an applicant, and there should not be - an ATS
 * where a recruiter can erase somebody is an ATS with no audit trail.
 *
 * So the people accumulate, one per run, in among the real ones. This is
 * the one place that clears them, run deliberately, by hand.
 *
 * WHAT IT WILL TOUCH, and it is deliberately narrow: candidates whose
 * address is on a domain RFC 2606 and RFC 6761 RESERVE for testing -
 * .invalid, .test, example.com, example.org, example.net. Those can
 * never belong to a real person, because they can never receive mail.
 * Anything else is left exactly where it is, however much it looks like
 * a fixture.
 */
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

const envFile = resolve(process.cwd(), process.env.ENV_FILE || '.env');
if (existsSync(envFile) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(envFile);
}

const CONFIRM = process.argv.includes('--confirm');

/*
 * The addresses that cannot be anybody.
 *
 * Matched on the address alone - never on the NAME. "Test" and "Demo"
 * are real surnames, and a rule that reads them as fixtures deletes a
 * real candidate on the day one applies.
 */
const RESERVED = `
  lower(email) like '%@%.invalid'
  or lower(email) like '%@%.test'
  or lower(email) like '%@example.com'
  or lower(email) like '%@example.org'
  or lower(email) like '%@example.net'
`;

let db = null;
let pgServer = null;

if (!process.env.DATABASE_URL) {
  const { PGlite } = await import('@electric-sql/pglite');
  const { PGLiteSocketServer } = await import('@electric-sql/pglite-socket');
  db = await new PGlite(process.env.DEV_DB_DIR || 'var/dev-db');
  pgServer = new PGLiteSocketServer({ db, port: Number(process.env.PG_PORT || 5434), host: '127.0.0.1' });
  await pgServer.start().catch(() => { pgServer = null; });
} else {
  console.log('DATABASE_URL is set; run this against the development database only.');
  process.exit(1);
}

const q = async (sql, params) => (await db.query(sql, params)).rows;

const doomed = await q(`select id, name, email from candidates where ${RESERVED} order by created_at`);

if (!doomed.length) {
  console.log('Nothing to remove - no candidate is on a reserved test domain.');
} else {
  console.log(`${doomed.length} verification candidate(s):\n`);
  for (const c of doomed) console.log(`  ${c.name.padEnd(34)} ${c.email}`);

  const apps = await q(
    `select count(*)::int n from applications where candidate_id = any($1::text[])`,
    [doomed.map((c) => c.id)]);
  console.log(`\n  and ${apps[0].n} application(s) belonging to them`);

  if (!CONFIRM) {
    console.log('\nNothing was removed. Run again with --confirm.');
  } else {
    const ids = doomed.map((c) => c.id);
    await q(`delete from application_events where application_id in
               (select id from applications where candidate_id = any($1::text[]))`, [ids]);
    await q(`delete from notification_deliveries where application_id in
               (select id from applications where candidate_id = any($1::text[]))`, [ids]);
    await q(`delete from applications where candidate_id = any($1::text[])`, [ids]);
    // The portal account each of them signs in with, found the way the
    // candidate points at it rather than by matching an address.
    await q(`delete from users where id in
               (select user_id from candidates where id = any($1::text[])
                 and user_id is not null)`, [ids]);
    await q(`delete from candidates where id = any($1::text[])`, [ids]);

    const left = await q(`select count(*)::int n from candidates where ${RESERVED}`);
    console.log(`\nRemoved. ${left[0].n} left on a reserved domain.`);
  }
}

const rest = await q(`select count(*)::int n from candidates`);
console.log(`\n${rest[0].n} candidate(s) remain.`);

if (pgServer) await pgServer.stop().catch(() => {});
await db.close();
