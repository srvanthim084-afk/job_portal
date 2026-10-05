/**
 * Source health and the alerts that go with it (master prompt §36, §37, §41).
 *
 * After every sync the outcome is folded into the source's health columns
 * (0108): last success, last attempt, success / failure counts, consecutive
 * failures, average duration, open-job count, and a status -
 *
 *   healthy     the last sync worked
 *   degraded    it failed, fewer than EXTERNAL_SOURCE_UNHEALTHY_AFTER times in a row
 *   unhealthy   it has failed that many times in a row
 *
 * ALERTS USE THE EXISTING ALERTING: an in-app notification to every
 * administrator (notify_create, the same path every system notification
 * takes) and a line in the audit trail. No monitoring platform, no email,
 * no third party. One alert per kind, per source, per day - a fault that
 * persists is reported daily, not on every run.
 *
 * NOTHING HERE MAY BREAK A SYNC. Every call is caught and logged: losing a
 * health update is a smaller harm than losing the jobs it describes.
 */
import { config } from '../config.js';
import * as cx from './compliance-store.js';

const day = () => new Date().toISOString().slice(0, 10);

export async function safe(what, fn) {
  try { return await fn(); }
  catch (err) { console.error(`[external] ${what} failed:`, err.message); return null; }
}

function classify(error) {
  const e = String(error || '');
  if (/no response within|timed out|AbortError/i.test(e)) return 'timeout';
  if (/HTTP 401|HTTP 403|not set|not_configured/i.test(e)) return 'credentials';
  if (/HTTP 429|quota/i.test(e)) return 'rate_limited';
  if (/HTTP 5\d\d/i.test(e)) return 'provider_error';
  if (/not JSON|did not contain/i.test(e)) return 'malformed_response';
  return e ? 'failed' : null;
}

/**
 * Record one sync's outcome and raise whatever alerts it calls for.
 *
 * @param outcome   'success' | 'failure' | 'empty'
 * @param stats     { fetched, saved, created, quarantined, linked, previousOpen,
 *                    durationMs, error, urlFailures }
 */
export async function afterSync(session, source, outcome, stats = {}) {
  const cfg = config.externalJobs;
  const h = await safe('health record', () => cx.recordHealth(session, source.id, {
    outcome, durationMs: stats.durationMs ?? null, threshold: cfg.unhealthyAfter,
    baseHours: cfg.backoffBaseHours, maxHours: cfg.backoffMaxHours,
  }));
  const alerts = [];
  const alert = async (type, title, message, metadata = {}) => {
    const n = await safe('admin alert', () => cx.alertAdmins(session, {
      key: `${source.id}|${type}|${day()}`, type, sourceId: source.id, title, message,
      metadata: { ...metadata, sourceName: source.name },
    }));
    if (n) alerts.push(type);
  };

  if (h && h.crossed) {
    await alert('EXTERNAL_SOURCE_UNHEALTHY', `${source.name} is unhealthy`,
      `${source.name} has failed ${h.consecutive_failures} syncs in a row (${classify(stats.error) || 'failed'}: `
      + `${String(stats.error || '').slice(0, 200)}). Its ${h.open_job_count} jobs are kept and it will be `
      + `retried with backoff.`, { kind: classify(stats.error), consecutiveFailures: h.consecutive_failures });
  }
  if (h && h.recovered) {
    await alert('EXTERNAL_SOURCE_RECOVERED', `${source.name} is syncing again`,
      `${source.name} synced successfully after being unhealthy.`);
  }
  if (outcome === 'empty') {
    await alert('EXTERNAL_SOURCE_EMPTY', `${source.name} returned no jobs`,
      `${source.name} answered with no postings while ${stats.previousOpen || 0} are held. `
      + 'Nothing was closed; the run is treated as a failure until the source answers normally.');
  }
  if (outcome === 'success') {
    const prev = Number(stats.previousOpen || 0);
    const got = Number(stats.saved || 0);
    if (prev >= 10 && got < prev * 0.5) {
      await alert('EXTERNAL_JOB_COUNT_DROP', `${source.name}: sudden drop in jobs`,
        `${source.name} returned ${got} postings where ${prev} were open. Postings not seen are closed only `
        + `after the grace period, so nothing has been removed yet.`, { previousOpen: prev, received: got });
    }
    const q = Number(stats.quarantined || 0);
    const fetched = Number(stats.fetched || 0);
    if (q >= 5 && fetched > 0 && q / fetched >= 0.2) {
      await alert('EXTERNAL_MALFORMED_JOBS', `${source.name}: ${q} postings failed validation`,
        `${q} of ${fetched} postings from ${source.name} failed validation and were quarantined. `
        + 'See Job Sources → Quarantine for the reasons.', { quarantined: q, fetched });
    }
    const dup = Number(stats.linked || 0);
    if (dup >= 10 && got > 0 && dup / got >= 0.5) {
      await alert('EXTERNAL_DUPLICATE_SPIKE', `${source.name}: many duplicates`,
        `${dup} postings from ${source.name} were folded into existing ones in one run.`, { duplicates: dup });
    }
    if (Number(stats.urlFailures || 0) > 0) {
      await alert('EXTERNAL_URL_VALIDATION', `${source.name}: links refused`,
        `${stats.urlFailures} postings from ${source.name} had application links that failed validation.`,
        { urlFailures: stats.urlFailures });
    }
  }
  return { health: h, alerts, errorKind: classify(stats.error) };
}

/** A redirect the server refused to make: one alert per source per day. */
export async function redirectRefused(session, target, reason) {
  return safe('redirect alert', () => cx.alertAdmins(session, {
    key: `${target.source_key}|redirect|${day()}`, type: 'EXTERNAL_REDIRECT_FAILURE',
    sourceId: target.source_key,
    title: `${target.source_name || 'A source'}: an unsafe link was refused`,
    message: `Apply Now for job ${target.id} was not redirected: ${reason}. Check the posting's stored URL.`,
    metadata: { jobId: target.id, reason },
  }));
}

export { classify };
