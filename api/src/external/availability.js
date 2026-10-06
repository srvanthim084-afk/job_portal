/**
 * Is an external posting still there? (0115)
 *
 * THE BUG THIS ANSWERS. Apply Now on a Databricks posting opened
 * Databricks' own "this page has been removed": Greenhouse had dropped the
 * job, and TeamLink still listed it as open. Until now a posting was only
 * ever closed by being "unseen by a sync for 14 days" - which needs the
 * sync to have run, and cannot tell "removed" from "past the
 * EXTERNAL_SYNC_JOB_LIMIT cap" on a board bigger than the cap.
 *
 * So the posting's own source is asked, about that one posting:
 *
 *   Greenhouse   GET boards-api.greenhouse.io/v1/boards/{board}/jobs/{id}
 *   Lever        GET api.lever.co/v0/postings/{company}/{id}
 *                (both public, documented, read-only job endpoints;
 *                 404 = the job is gone)
 *   anything     a bounded HEAD (GET when HEAD is refused) of the URL the
 *   else         job itself points at - https only, on the source's
 *                approved domains (link.js), redirects followed only while
 *                they stay on them, a few seconds at most, no cookies, a
 *                TeamLink user agent. 404/410 = gone.
 *
 * NO SCRAPING: nothing reads a page's content, and nothing is fetched
 * except the job's own public endpoint or its own URL.
 *
 * NEVER PUNISH THE JOB FOR OUR NETWORK. A timeout, a DNS failure, a 5xx, a
 * 403 from a bot wall, a 429 - all "unknown": the posting is untouched and
 * Apply Now opens the original URL exactly as before. Only a confirmed
 * removal closes it (external_job_link_check_record, 0115: closed - never
 * deleted - with an audit row; a later sync that sees it again reopens it).
 *
 * Answers are cached briefly per job (EXTERNAL_LINK_CHECK_CACHE_SECONDS,
 * default 600; "unknown" for a minute), and concurrent checks of the same
 * job share one request, so the check is quick and providers are not
 * hammered.
 *
 * Switches:
 *   EXTERNAL_LINK_CHECK_ENABLED     default on (off under NODE_ENV=test,
 *                                   so no test ever reaches a real site)
 *   EXTERNAL_LINK_CHECK_TIMEOUT_MS  default 4000
 *   EXTERNAL_LINK_CHECK_VIA         TEST ONLY: send every check to this
 *                                   loopback mock instead (refused in
 *                                   production and for any other host)
 *   EXTERNAL_LINK_SWEEP_MINUTES / _BATCH / EXTERNAL_LINK_RECHECK_HOURS
 *                                   the background sweep (below)
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { config } from '../config.js';
import { withUser } from '../db.js';
import { checkLink } from './link.js';
import { sourcePolicy } from './source-config.js';
import * as cx from './compliance-store.js';
import { relinkDuplicates } from './store.js';
import { bump } from './cache.js';
import { safe } from './health.js';

const num = (v, d) => (v === undefined || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function linkCheckEnabled() {
  const v = process.env.EXTERNAL_LINK_CHECK_ENABLED;
  if (v == null || String(v).trim() === '') return process.env.NODE_ENV !== 'test';
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}
const timeoutMs = () => clamp(num(process.env.EXTERNAL_LINK_CHECK_TIMEOUT_MS, 4000), 300, 15000);
const cacheMs = () => clamp(num(process.env.EXTERNAL_LINK_CHECK_CACHE_SECONDS, 600), 0, 86400) * 1000;
const UNKNOWN_CACHE_MS = 60 * 1000;
const MAX_HOPS = 5;
const userAgent = () => `TeamLinkLinkCheck/1.0 (+${config.publicOrigin}; checks that a job posting is still open)`;

/* ---- the test-only mock route --------------------------------------- */
const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;
function viaBase() {
  const v = String(process.env.EXTERNAL_LINK_CHECK_VIA || '').trim().replace(/\/+$/, '');
  if (!v) return null;
  if (config.isProd || process.env.NODE_ENV === 'production' || !LOOPBACK.test(v)) {
    if (!viaBase.warned) { viaBase.warned = true; console.warn('[external] EXTERNAL_LINK_CHECK_VIA ignored: loopback only, never in production'); }
    return null;
  }
  return v;
}
/* https://host/path?q -> {VIA}/https/host/path?q. The logical URL (what the
   allowlist and redirects are judged on) never changes. */
function wire(url) {
  const via = viaBase();
  if (!via) return url;
  const u = new URL(url);
  return `${via}/${u.protocol.replace(':', '')}/${u.host}${u.pathname}${u.search}`;
}

/* ---- no request to a private address -------------------------------- */
const PRIVATE_V4 = [/^0\./, /^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, /^198\.1[89]\./, /^2(2[4-9]|[3-5]\d)\./];
function privateAddress(a) {
  if (isIP(a) === 4) return PRIVATE_V4.some((r) => r.test(a));
  const s = a.toLowerCase();
  if (s.startsWith('::ffff:')) return privateAddress(s.slice(7));
  return s === '::' || s === '::1' || /^f[cd]/.test(s) || /^fe[89ab]/.test(s);
}
async function publicHost(host) {
  if (viaBase()) return true;                 // the mock is loopback by design
  try {
    const all = await lookup(host, { all: true, verbatim: true });
    return all.length > 0 && !all.some((x) => privateAddress(x.address));
  } catch { return false; }
}

/* ---- one bounded request -------------------------------------------- */
async function ask(url, method, deadline, accept = 'text/html,*/*;q=0.8') {
  const ctl = new AbortController();
  const left = Math.max(50, deadline - Date.now());
  const timer = setTimeout(() => ctl.abort(), left);
  try {
    const res = await fetch(wire(url), {
      method, redirect: 'manual', signal: ctl.signal,
      /* No cookies (fetch sends none), no referrer, no credentials. */
      credentials: 'omit', referrerPolicy: 'no-referrer',
      headers: { 'user-agent': userAgent(), accept },
    });
    try { await res.body?.cancel(); } catch { /* nothing to read */ }
    return { http: res.status, location: res.headers.get('location') };
  } catch (err) {
    return { error: err.name === 'AbortError' ? `no answer within ${Math.round(timeoutMs() / 1000)}s` : (err.cause?.code || err.message) };
  } finally {
    clearTimeout(timer);
  }
}

const GONE = new Set([404, 410]);
const verdict = (http) => (http >= 200 && http < 300 ? 'available' : GONE.has(http) ? 'removed' : 'unknown');

/* The provider's own public job endpoint, when the posting came from one. */
export function providerEndpoint(t) {
  const p = String(t.provider || t.connector || '').toLowerCase();
  const id = String(t.source_job_id || '');
  if (p === 'greenhouse') {
    const m = /^([A-Za-z0-9][A-Za-z0-9_.-]{0,99}):(\d{1,20})$/.exec(id);
    if (m) return { method: 'greenhouse_api', url: `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(m[1])}/jobs/${m[2]}` };
  }
  if (p === 'lever') {
    const m = /^([A-Za-z0-9][A-Za-z0-9_.-]{0,99}):([0-9a-f-]{8,64})$/i.exec(id);
    if (m) return { method: 'lever_api', url: `https://api.lever.co/v0/postings/${encodeURIComponent(m[1])}/${m[2]}` };
  }
  return null;
}

/** Ask the source. Never throws. */
export async function probe(t) {
  const deadline = Date.now() + timeoutMs();
  const api = providerEndpoint(t);
  if (api) {
    const host = new URL(api.url).hostname;
    if (!(await publicHost(host))) return { state: 'unknown', method: api.method, detail: `${host} did not resolve to a public address` };
    const r = await ask(api.url, 'GET', deadline, 'application/json');
    if (r.error) return { state: 'unknown', method: api.method, detail: r.error };
    return { state: verdict(r.http), method: api.method, http: r.http,
      detail: GONE.has(r.http) ? `the ${api.method === 'lever_api' ? 'Lever' : 'Greenhouse'} job endpoint answered ${r.http}` : `HTTP ${r.http}` };
  }

  /* The job's own URL, under the one link rule at every hop. */
  const src = { provider: t.provider, connector: t.connector, sourceId: t.source_key, allowedDomains: t.allowed_domains };
  const first = checkLink(t.application_url, src);
  if (!first.ok) return { state: 'unknown', method: 'url', detail: `not checked: ${first.reason}` };
  let url = first.url;
  for (let hop = 0; hop <= MAX_HOPS; hop += 1) {
    if (!/^https:\/\//i.test(url)) return { state: 'unknown', method: 'url', detail: 'not checked: not https' };
    const host = new URL(url).hostname;
    if (!(await publicHost(host))) return { state: 'unknown', method: 'url', detail: `${host} did not resolve to a public address` };
    let r = await ask(url, 'HEAD', deadline);
    if (!r.error && (r.http === 405 || r.http === 501)) r = await ask(url, 'GET', deadline);
    if (r.error) return { state: 'unknown', method: 'url', detail: r.error };
    if (r.http >= 300 && r.http < 400 && r.location) {
      let next;
      try { next = new URL(r.location, url).toString(); } catch { return { state: 'unknown', method: 'url', http: r.http, detail: 'a redirect to an unreadable address' }; }
      const ok = checkLink(next, src);
      if (!ok.ok) return { state: 'unknown', method: 'url', http: r.http, detail: `redirect not followed: ${ok.reason}` };
      url = ok.url;
      continue;
    }
    return { state: verdict(r.http), method: 'url', http: r.http, detail: `HTTP ${r.http}${hop ? ` after ${hop} redirect(s)` : ''}` };
  }
  return { state: 'unknown', method: 'url', detail: 'too many redirects' };
}

/* ---- the cache ------------------------------------------------------- */
const CACHE = new Map();
const INFLIGHT = new Map();
const MAX_ENTRIES = 5000;
export function clearAvailabilityCache() { CACHE.clear(); INFLIGHT.clear(); }
export const availabilityCacheSize = () => CACHE.size;

export async function linkTarget(session, id) {
  return withUser(session, async (c) => (await c.query(
    `select * from external_job_link_target($1)`, [id])).rows[0] || null);
}
async function record(session, id, r) {
  return withUser(session, async (c) => (await c.query(
    `select * from external_job_link_check_record($1,$2,$3,$4,$5)`,
    [id, r.state, r.http ?? null, r.method || null, r.detail || null])).rows[0] || { closed: false });
}

/**
 * The answer Apply Now acts on.
 *
 * @returns { state, url?, http?, method?, detail?, cached, closed, target }
 *   state   'available' | 'unknown'      -> open the original URL
 *           'removed'                    -> "Job no longer available" (just closed)
 *           'closed' | 'not_found'       -> "Job no longer available" (already)
 *           'link_unavailable'           -> "Application link unavailable"
 *           'disabled'                   -> the check is switched off: as before
 */
export async function checkAvailability(session, id, { force = false } = {}) {
  const t = await linkTarget(session, id);
  if (!t) return { state: 'not_found', cached: false, closed: false, target: null };
  if (t.status !== 'open') return { state: 'closed', cached: false, closed: false, target: t };
  const link = checkLink(t.application_url, { provider: t.provider, connector: t.connector,
    sourceId: t.source_key, allowedDomains: t.allowed_domains });
  if (!link.ok) return { state: 'link_unavailable', reason: link.reason, cached: false, closed: false, target: t };
  if (!linkCheckEnabled()) return { state: 'disabled', url: link.url, cached: false, closed: false, target: t };

  const key = `${t.id}|${t.application_url}`;
  const hit = CACHE.get(key);
  const now = Date.now();
  /* A cached "removed" for a posting that is open again (a later sync saw
     it) is stale by definition: ask again. */
  if (!force && hit && hit.r.state !== 'removed'
      && now - hit.at < (hit.r.state === 'unknown' ? Math.min(UNKNOWN_CACHE_MS, cacheMs()) : cacheMs())) {
    return { ...hit.r, url: hit.r.state === 'removed' ? undefined : link.url, cached: true, closed: false, target: t };
  }
  let p = INFLIGHT.get(key);
  if (!p) {
    p = (async () => {
      const r = await probe(t);
      let out = { closed: false };
      try { out = await record(session, t.id, r); }
      catch (e) { console.error('[external] link check not recorded:', e.message); }
      if (out.closed) {
        bump();                                       // the portal cache drops the posting now
        console.log(`[external] ${t.id} (${t.source_job_id}) closed: ${r.detail}`);
        await safe('release duplicates', () => relinkDuplicates(session));
      }
      if (cacheMs() > 0) {
        CACHE.set(key, { at: Date.now(), r });
        while (CACHE.size > MAX_ENTRIES) CACHE.delete(CACHE.keys().next().value);
      }
      return { r, closed: !!out.closed };
    })().finally(() => INFLIGHT.delete(key));
    INFLIGHT.set(key, p);
  }
  const { r, closed } = await p;
  return { ...r, url: r.state === 'removed' ? undefined : link.url, cached: false, closed, target: t };
}

/** The words the candidate sees, for each answer. */
export function availabilityAnswer(a) {
  if (['removed', 'closed', 'not_found'].includes(a.state)) {
    return { available: false, applyLink: 'job_unavailable', status: 'JOB_UNAVAILABLE', message: 'Job no longer available' };
  }
  if (a.state === 'link_unavailable') {
    return { available: false, applyLink: 'link_unavailable', status: 'LINK_UNAVAILABLE', message: 'Application link unavailable' };
  }
  return { available: true, applyLink: 'available', status: 'AVAILABLE', url: a.url,
    /* "unknown" is said, not hidden: the check could not reach the source,
       so the original URL is opened as before. */
    checked: a.state === 'available' ? 'confirmed' : (a.state === 'disabled' ? 'not_checked' : 'unconfirmed') };
}

/* ------------------------------------------------------------------ *
 * the background link-health sweep
 *
 * Re-checks open postings in small batches, oldest answer first - and,
 * before those, the ones the latest successful sync did NOT return (the
 * ones most likely to have been taken down, or to sit past the
 * EXTERNAL_SYNC_JOB_LIMIT cap). It respects X's 0108 settings: a source in
 * backoff is left alone, its rate limit spaces the calls (one a second
 * where it sets none), and a source with a monthly quota pays for each
 * check from it. It closes only confirmed removals; a network error is
 * recorded as "unknown" and asked again later.
 * ------------------------------------------------------------------ */
const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref(); });

export async function sweepCandidates(session, { limit = 30, recheckHours = 24, unknownHours = 2 } = {}) {
  return withUser(session, async (c) => (await c.query(
    `select j.id, j.source_id, s.provider, s.connector, s.allowed_domains, s.rate_limit_per_minute,
            s.monthly_quota, s.next_sync_after
       from external_jobs j
       join job_sources s on s.id = j.source_id
       left join external_job_link_checks k on k.external_job_id = j.id
      where j.status = 'open' and j.admin_hold is null and s.active
        and (s.next_sync_after is null or s.next_sync_after <= now())
        and (k.checked_at is null
             or k.checked_at < now() - make_interval(hours => case when k.outcome = 'unknown' then $3::int else $2::int end))
      order by (s.last_success_started_at is not null and j.synced_at < s.last_success_started_at) desc,
               k.checked_at asc nulls first, j.synced_at asc, j.id
      limit $1`, [limit, recheckHours, unknownHours])).rows);
}

export async function runLinkSweep(session, opts = {}) {
  const out = { checked: 0, available: 0, removed: 0, unknown: 0, closed: 0, skipped: 0 };
  if (!linkCheckEnabled()) return { ...out, disabled: true };
  const limit = clamp(num(opts.limit ?? process.env.EXTERNAL_LINK_SWEEP_BATCH, 30), 1, 500);
  const rows = await sweepCandidates(session, {
    limit,
    recheckHours: clamp(num(opts.recheckHours ?? process.env.EXTERNAL_LINK_RECHECK_HOURS, 24), 0, 24 * 30),
    unknownHours: clamp(num(opts.unknownHours, 2), 0, 24 * 30),
  });
  const lastCall = new Map();
  const outOfQuota = new Set();
  for (const row of rows) {
    if (opts.stopped && opts.stopped()) break;
    if (outOfQuota.has(row.source_id)) { out.skipped += 1; continue; }
    const policy = sourcePolicy(row);
    const gap = policy.rateLimitPerMinute ? Math.ceil(60000 / policy.rateLimitPerMinute) : num(opts.defaultGapMs, 1000);
    const wait = (lastCall.get(row.source_id) || 0) + gap - Date.now();
    if (wait > 0) await sleep(wait);
    if (row.monthly_quota != null) {
      const left = await safe('link-check quota', () => cx.spendQuota(session, row.source_id, 1));
      if (left != null && left < 0) { outOfQuota.add(row.source_id); out.skipped += 1; continue; }
    }
    lastCall.set(row.source_id, Date.now());
    const a = await checkAvailability(session, row.id, { force: true }).catch((e) => ({ state: 'error', detail: e.message }));
    out.checked += 1;
    if (a.state === 'available') out.available += 1;
    else if (a.state === 'removed') out.removed += 1;
    else out.unknown += 1;
    if (a.closed) out.closed += 1;
  }
  return out;
}

export function startExternalLinkSweep() {
  if (!config.externalJobs.enabled || !linkCheckEnabled()) return () => {};
  const minutes = clamp(num(process.env.EXTERNAL_LINK_SWEEP_MINUTES, 15), 1, 24 * 60);
  const ENGINE = { userId: '', role: 'admin', profileId: null };
  let stopped = false;
  let running = false;
  const run = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const r = await runLinkSweep(ENGINE, { stopped: () => stopped });
      if (r.checked) {
        console.log(`[external] link sweep: ${r.checked} checked, ${r.available} open, `
          + `${r.removed} removed (${r.closed} closed), ${r.unknown} could not be confirmed`);
      }
    } catch (err) {
      console.error('[external] link sweep failed:', err.message);
    } finally {
      running = false;
    }
  };
  /* The first batch a few minutes after boot, then on the interval. */
  const first = setTimeout(run, Math.min(minutes, 5) * 60 * 1000);
  if (first.unref) first.unref();
  const timer = setInterval(run, minutes * 60 * 1000);
  if (timer.unref) timer.unref();
  return () => { stopped = true; clearTimeout(first); clearInterval(timer); };
}
