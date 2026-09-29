/**
 * Remove what the verification suite left behind.
 *
 *     node tools/purge-verify-leftovers.mjs            # report only
 *     node tools/purge-verify-leftovers.mjs --confirm  # remove it
 *
 * WHY. `verify:isolation` creates two throwaway recruiters and three
 * requirements per run and never removed any of them. After three runs
 * the portal held six recruiters called "Alpha ..." and "Beta ..." and
 * nine requirements called "Isolation A/B/draft ...", all owned by
 * accounts nobody can sign in as.
 *
 * That is not only untidy. The first open job on the board became
 * "Isolation B 1790575635106", so `verify:notifications` - which applies
 * to whatever is at the top - applied to a requirement belonging to a
 * recruiter it was not signed in as, and every stage move afterwards was
 * correctly refused by row-level security and reported as a broken
 * notification. Two suites were failing because of this data.
 *
 * WHAT IT WILL TOUCH, and nothing else:
 *
 *   recruiters   email matching alpha.<digits>@ or beta.<digits>@
 *   jobs         title matching "Isolation A|B|draft <digits>"
 *   candidates   email matching cand.A.<digits>@example.test,
 *                cand.B.<digits>@example.test or iso.cand.<digits>@example.test
 *
 * Every pattern includes the run's timestamp, so nothing a person named
 * can match by accident. It prints what it found and changes nothing
 * without --confirm.
 */
import { PGlite } from '@electric-sql/pglite';

const CONFIRM = process.argv.includes('--confirm');
const db = new PGlite('var/dev-db');

const RECRUITERS = `email ~ '^(alpha|beta)\.[0-9]{10,}@'`;
const JOBS       = `title ~ '^Isolation (A|B|draft) [0-9]{10,}$'`;
const CANDIDATES = `email ~ '^(cand\.(A|B)|iso\.cand)\.[0-9]{10,}@example\.test$'`;

const recs  = (await db.query(`select id, name, email from recruiters where ${RECRUITERS}`)).rows;
const jobs  = (await db.query(`select id, title from jobs where ${JOBS}`)).rows;
const cands = (await db.query(`select id, name, email from candidates where ${CANDIDATES}`)).rows;

console.log(`${recs.length} throwaway recruiter(s)`);
recs.forEach((r) => console.log(`   ${r.email.padEnd(34)} ${r.name}`));
console.log(`${jobs.length} throwaway requirement(s)`);
jobs.forEach((j) => console.log(`   ${j.id.padEnd(20)} ${j.title}`));
console.log(`${cands.length} throwaway candidate(s)`);
cands.forEach((c) => console.log(`   ${c.email}`));

if (!recs.length && !jobs.length && !cands.length) {
  console.log('\nNothing to remove.');
  await db.close();
  process.exit(0);
}

if (!CONFIRM) {
  console.log('\nNothing was removed. Run again with --confirm to apply.');
  await db.close();
  process.exit(0);
}

/*
 * Applications first, then the rows they point at. The foreign keys
 * cascade from candidates and jobs anyway, but deleting in this order
 * means a failure half way cannot leave an application pointing at a job
 * that is gone.
 */
await db.query('begin');
try {
  const jobIds  = jobs.map((j) => j.id);
  const candIds = cands.map((c) => c.id);
  const recIds  = recs.map((r) => r.id);

  if (jobIds.length || candIds.length) {
    await db.query(`delete from applications where job_id = any($1) or candidate_id = any($2)`,
      [jobIds, candIds]);
  }
  if (candIds.length) {
    /* The login rows go with them; a user with no candidate is an account
       nobody can use and nobody can see. */
    await db.query(`delete from users where id in
      (select user_id from candidates where id = any($1) and user_id is not null)`, [candIds]);
    await db.query(`delete from candidates where id = any($1)`, [candIds]);
  }
  if (jobIds.length) await db.query(`delete from jobs where id = any($1)`, [jobIds]);
  if (recIds.length) {
    /*
     * The audit rows these accounts wrote have to let go of them first.
     * `candidate_imports.imported_by` points at the user, so deleting the
     * user outright is refused - correctly, because an import record that
     * cannot say who ran it is a worse record. The import ROWS are
     * throwaway too (they created the cand.A/cand.B candidates removed
     * above), so they go rather than being orphaned.
     */
    const userIds = (await db.query(
      `select user_id from recruiters where id = any($1) and user_id is not null`,
      [recIds])).rows.map((x) => x.user_id);

    if (userIds.length) {
      await db.query(`delete from candidate_imports where imported_by = any($1)`, [userIds]);
    }
    await db.query(`delete from recruiters where id = any($1)`, [recIds]);
    if (userIds.length) await db.query(`delete from users where id = any($1)`, [userIds]);
  }
  await db.query('commit');
  console.log(`\nRemoved ${recs.length} recruiter(s), ${jobs.length} requirement(s), `
    + `${cands.length} candidate(s).`);
} catch (err) {
  await db.query('rollback');
  console.error('\nNothing was removed:', err.message);
  process.exitCode = 1;
}
await db.close();
