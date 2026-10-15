/**
 * Deleting interview photos when their retention period ends (0149).
 *
 * Hourly: every photo whose retention_until has passed is removed from private storage, and only THEN is its
 * key cleared in the database (and an audit line written), so a failed delete is retried next hour instead of
 * leaving a file nobody points at. The verification record itself - when it was taken, confirmed, consented
 * to - stays; only the image goes.
 */
import { withUser } from '../db.js';
import { getStorage } from '../storage.js';

const ENGINE = { userId: '', role: 'admin', profileId: null };

export async function runVerificationRetention({ limit = 200 } = {}) {
  const due = await withUser(ENGINE, async (c) => (await c.query(
    `select id, image_path from ai_verification_images_due($1)`, [limit])).rows);
  let removed = 0, failed = 0;
  for (const row of due) {
    try {
      await getStorage().remove(row.image_path);
      await withUser(ENGINE, (c) => c.query(`select ai_verification_image_removed($1)`, [row.id]));
      removed += 1;
    } catch (err) {
      failed += 1;
      console.error('[verification] could not delete a photo past its retention:', err.message);
    }
  }
  return { due: due.length, removed, failed };
}

export function startVerificationRetentionSweep() {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const r = await runVerificationRetention();
      if (r.removed) console.log(`[verification] ${r.removed} interview photo(s) deleted (retention period ended)`);
    } catch (err) {
      console.error('[verification] the retention sweep failed:', err.message);
    } finally { running = false; }
  };
  const first = setTimeout(run, Number(process.env.VERIFICATION_RETENTION_FIRST_MS || 90_000));
  const timer = setInterval(run, Number(process.env.VERIFICATION_RETENTION_SWEEP_MS || 60 * 60 * 1000));
  first.unref?.(); timer.unref?.();
  return () => { clearTimeout(first); clearInterval(timer); };
}
