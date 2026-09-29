/**
 * Remove one batch of queued messages.
 *
 *     node tools/purge-message-batch.mjs <batchId> [--confirm]
 *
 * WHY THIS EXISTS. `message_logs` is deliberately append-only through the
 * API: a recruiter must not be able to erase what was said to somebody,
 * and a candidate certainly must not. That is the right rule and it
 * leaves one gap - a batch queued while TESTING the feature sits in real
 * candidates' history for good.
 *
 * So this is a tool and not an endpoint, it names the batch explicitly,
 * and it REFUSES a batch where anything was actually delivered. A
 * message somebody received is a fact about their life; the record of it
 * is not ours to tidy away.
 */
import { PGlite } from '@electric-sql/pglite';

const [batchId, ...flags] = process.argv.slice(2);
const CONFIRM = flags.includes('--confirm');
if (!batchId) {
  console.error('Usage: node tools/purge-message-batch.mjs <batchId> [--confirm]');
  process.exit(1);
}

const db = new PGlite('var/dev-db');
const rows = (await db.query(
  `select status, count(*)::int as n from message_logs where batch_id = $1 group by status`,
  [batchId])).rows;

if (!rows.length) { console.log('No such batch.'); process.exit(0); }
console.log(`batch ${batchId}:`);
rows.forEach((r) => console.log(`   ${String(r.n).padStart(4)}  ${r.status}`));

const delivered = rows.filter((r) => r.status === 'sent' || r.status === 'delivered');
if (delivered.length) {
  console.error('\nRefusing: this batch actually reached somebody. A message that was '
    + 'delivered stays on the record.');
  process.exit(1);
}

if (!CONFIRM) {
  console.log('\nNothing was removed. Run again with --confirm.');
  process.exit(0);
}

const out = await db.query(`delete from message_logs where batch_id = $1`, [batchId]);
console.log(`\n${out.affectedRows ?? 0} row(s) removed.`);
await db.close();
