/**
 * "Automatic" has to mean automatic.
 *
 * A Sync Now button is a demo. A recruiter's Naukri responses have to
 * arrive in the ATS without anybody pressing anything, which means the
 * server reads the connected mailboxes on a timer.
 *
 * Runs inside the API process rather than as a cron job, for the same
 * reason the interview-deadline sweep does: the deployment target is one
 * server, and a missed import is worse than a duplicated process. The
 * import is idempotent - `email_messages` has a unique (mailbox,
 * message_id) - so running it twice imports nothing twice.
 */
import { syncAll } from './process.js';

const EVERY_MS = Number(process.env.INTAKE_SYNC_MS || 5 * 60 * 1000);

/** Read-every-mailbox runs as the system, never as a logged-in recruiter. */
const SYSTEM = { userId: '', role: 'admin', profileId: null };

let running = false;

export async function tick() {
  // Never overlap: an IMAP round trip can outlast the interval on a slow
  // link, and two syncs racing would fight over the same messages.
  if (running) return { skipped: 'a sync is already running' };
  running = true;
  try {
    const out = await syncAll(SYSTEM, { onlyAuto: true });
    const imported = out.reduce((n, x) => n + (x.imported || 0), 0);
    const mapping = out.reduce((n, x) => n + (x.needsMapping || 0), 0);
    const failed = out.filter((x) => x.error);

    if (imported || mapping || failed.length) {
      console.log(`[intake] ${imported} imported, ${mapping} awaiting mapping`
        + (failed.length ? `, ${failed.length} mailbox(es) failed` : ''));
      for (const f of failed) {
        console.error(`[intake] ${f.mailbox || f.mailboxId}: ${f.message || f.error}`);
      }
    }
    return { imported, needsMapping: mapping, mailboxes: out.length };
  } finally {
    running = false;
  }
}

/**
 * Start the timer. Returns a stop function.
 *
 * The first run is delayed: a server that has just booted is usually
 * mid-deploy, and a burst of candidate registration emails is the last
 * thing a restart should cause.
 */
export function startIntakeSync() {
  let stopped = false;

  const run = async () => {
    if (stopped) return;
    try { await tick(); }
    catch (err) { console.error('[intake] the sync failed:', err.message); }
  };

  const first = setTimeout(run, Number(process.env.INTAKE_FIRST_MS || 45_000));
  const timer = setInterval(run, EVERY_MS);
  first.unref?.();
  timer.unref?.();

  return () => { stopped = true; clearTimeout(first); clearInterval(timer); };
}
