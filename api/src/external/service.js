/**
 * The external-job workflow: collect, match, put forward, follow up.
 *
 * Four operations, each of which stops on its own terms and says why.
 * None of them writes to a TeamLink table - see `store.js`, where every
 * statement lives.
 */
import { config } from '../config.js';
import { inIndia } from './india.js';
import { normaliseExternalJob } from './normalise.js';
import { collectJobs, submitApplication, checkApplicationStatus } from './providers.js';
import { matchExternalJob } from './matching.js';
import * as store from './store.js';
import { withUser } from '../db.js';
/* 0108 */
import * as cx from './compliance-store.js';
import { sourcePolicy, PRESERVED } from './source-config.js';
import { validateJob, fingerprintOf, reasonCodes } from './quality.js';
import { validateExternalUrl } from './redirect.js';
import { afterSync, safe } from './health.js';

/**
 * What this desk's candidates are actually looking for.
 *
 * The distinct job titles and the commonest skills across the profiles
 * on file, most frequent first. A connector is asked for those rather
 * than for a list of keywords written into this file - which would
 * collect jobs for somebody else's market and would need editing every
 * time the desk changed direction.
 *
 * Capped, because each term is one HTTP call to a board that is probably
 * rate-limited, and the first handful covers most of the pool.
 */
async function searchTermsFromCandidates(session) {
  const max = Number(process.env.EXTERNAL_SEARCH_TERMS || 8);
  try {
    const rows = await withUser(session, async (c) => (await c.query(
      `with titles as (
         select lower(btrim(title)) as term, count(*) as n
           from candidates
          where coalesce(btrim(title), '') <> ''
          group by 1
       ),
       skills as (
         select lower(btrim(s)) as term, count(*) as n
           from candidates, unnest(skills) as s
          where coalesce(btrim(s), '') <> ''
          group by 1
       )
       select term, sum(n) as n from (
         select * from titles union all select * from skills
       ) both_of_them
        where length(term) between 3 and 40
        group by term order by sum(n) desc limit $1`, [max])).rows);

    const terms = rows.map((r) => r.term).filter(Boolean);
    /* No candidates yet, or none with a title or a skill. One unfiltered
       pass is better than none, and better than inventing a keyword. */
    return terms.length ? terms : [null];
  } catch {
    return [null];
  }
}

/* ------------------------------------------------------------------ *
 * 1 · collect
 * ------------------------------------------------------------------ */

/**
 * Pull one source's current vacancies in.
 *
 * Idempotent: a posting already held is updated in place, so running this
 * every hour does not multiply anything. What a run reports is what it
 * actually did - `skipped` counts postings with no id or no title, which
 * is a real and common state in feed data, and hiding it would make a
 * broken feed look like an empty one.
 */
export async function syncSource(session, sourceId, opts = {}) {
  const startedAt = new Date();
  const source = await store.getSource(session, sourceId);
  if (!source) return { ok: false, status: 'not_found', error: 'no such source' };

  /*
   * TWO PIPELINES, ONE RULE (0108).
   *
   * A source whose provider is marked `preserve` (Greenhouse - the owner's
   * standing "do not change Greenhouse") runs EXACTLY the code below that
   * existed before 0108; the new checks only observe it (health, the
   * quarantine list with action 'kept', URL-change validity), and every
   * observation is caught so it can never alter or stop that sync.
   * api/test/external-greenhouse-snapshot.test.mjs proves the output is
   * byte-for-byte what it was.
   *
   * Every other source goes through the checked pipeline: licence gate,
   * one sync per source at a time, a concurrency limit, backoff for the
   * scheduler, quota and rate limit per call, a time budget, validation
   * with quarantine, URL-change control, and empty-sync protection.
   */
  const policy = sourcePolicy(source);
  if (!policy.preserve) return syncChecked(session, source, policy, startedAt, opts);
  return syncPreserved(session, source, policy, startedAt);
}

/** The pre-0108 sync, unchanged, plus observation that cannot interfere. */
async function syncPreserved(session, source, policy, startedAt) {
  const sourceId = source.id;
  /*
   * WHAT TO SEARCH FOR COMES FROM THE CANDIDATES, not from a list
   * somebody typed here.
   *
   * A connector needs a query - "python", "staff nurse" - and hard-coding
   * one would collect jobs for a market this desk may not work in. The
   * titles and skills already on file are the honest answer to "what are
   * these candidates actually looking for", and they change as the pool
   * changes without anybody editing code.
   *
   * Only for connector sources: a feed returns whatever it returns.
   */
  const terms = String(source.job_collection_method) === 'connector'
    ? await searchTermsFromCandidates(session)
    : [null];

  /* The company boards this run may read, loaded once and handed to
     whichever connector wants them. */
  const boards = await store.listCareerBoards(session).catch(() => []);

  let collected = { status: 'ok', jobs: [] };
  if (terms.length <= 1) {
    collected = await collectJobs(source, { query: terms[0] || undefined, boards });
  } else {
    /* One call per term, merged. A board that fails on one term may
       answer another, so a failure only counts when every term failed. */
    const all = [];
    const errors = [];
    let anyOk = false;
    for (const term of terms) {
      const out = await collectJobs(source, { query: term, boards });
      if (out.status === 'ok') { anyOk = true; all.push(...(out.jobs || [])); }
      else errors.push(`${term}: ${out.error || out.status}`);
      if (all.length >= 1000) break;              // enough for one pass
    }
    collected = anyOk
      ? { status: 'ok', jobs: all, error: errors.length ? errors.join(' | ').slice(0, 300) : null }
      : { status: 'failed', jobs: [], error: errors.join(' | ').slice(0, 300) };
  }

  if (collected.status !== 'ok') {
    await store.recordSyncResult(session, sourceId, {
      status: collected.status, error: collected.error, jobCount: 0,
    });
    /* A failed fetch changes nothing in the table: the jobs already
       synced stay, and only the run says it failed. */
    const failedRun = await store.recordSyncRun(session, {
      sourceId, startedAt, status: collected.status, error: collected.error || null,
    });
    /* 0108, observe only. */
    if (collected.status !== 'manual') {
      await safe('health (preserved)', () => afterSync(session, source, 'failure', {
        durationMs: Date.now() - startedAt.getTime(), error: collected.error }));
    }
    await safe('run extend (preserved)', () => cx.extendRun(session, runIdOf(failedRun), {
      provider: policy.provider, durationMs: Date.now() - startedAt.getTime(),
      errorSummary: collected.error || collected.status }));
    return {
      ok: collected.status === 'manual',
      status: collected.status,
      error: collected.error || null,
      saved: 0, skipped: 0, linked: 0,
    };
  }

  /* 0108, observe only: what each posting looked like before this run. */
  const known = (await safe('known jobs (preserved)', () => cx.knownJobs(session, sourceId))) || new Map();
  const observed = new Map();

  let saved = 0;
  let skipped = 0;
  let created = 0;
  const problems = [];
  for (const raw of collected.jobs) {
    const job = normaliseExternalJob(raw, source);
    observeQuality(observed, job, raw, policy, known);
    if (!job) { skipped++; continue; }
    try {
      const row = await store.saveJob(session, job);
      if (row && row.created) created++;
      saved++;
    } catch (err) {
      skipped++;
      if (problems.length < 5) problems.push(String(err.message || err).slice(0, 160));
    }
  }

  const linked = await store.relinkDuplicates(session);

  await store.recordSyncResult(session, sourceId, {
    status: problems.length ? 'partial' : 'ok',
    error: problems.length ? problems.join('; ') : null,
    jobCount: saved,
  });
  const run = await store.recordSyncRun(session, {
    sourceId, startedAt, status: problems.length ? 'partial' : 'ok',
    fetched: collected.jobs.length, created, updated: saved - created,
    duplicates: linked, skipped, error: problems.length ? problems.join('; ') : null,
  });

  /* 0108, observe only - after the sync has done everything it did before. */
  const obs = await safe('quality (preserved)', () => recordObserved(session, sourceId, observed));
  await safe('run extend (preserved)', () => cx.extendRun(session, runIdOf(run), {
    provider: policy.provider, failed: problems.length, quarantined: 0,
    urlChanges: obs ? obs.urlChanges : 0, durationMs: Date.now() - startedAt.getTime(),
    errorSummary: problems.length ? problems.join('; ') : (obs && obs.kept ? `${obs.kept} posting(s) failed validation (kept unchanged)` : null) }));
  await safe('health (preserved)', () => afterSync(session, source, 'success', {
    durationMs: Date.now() - startedAt.getTime(),
    saved: new Set(collected.jobs.map((j) => String(j.externalJobId || ''))).size,
    previousOpen: [...known.values()].filter((k) => k.status === 'open').length,
    fetched: collected.jobs.length, linked, quarantined: 0 }));

  return {
    ok: true,
    status: problems.length ? 'partial' : 'ok',
    saved,
    skipped,
    linked,
    error: problems.length ? problems.join('; ') : null,
  };
}

/* ------------------------------------------------------------------ *
 * 0108 helpers
 * ------------------------------------------------------------------ */

const runIdOf = (res) => {
  const v = res && res.rows && res.rows[0] && res.rows[0].external_sync_run_record;
  return v == null ? null : Number(v);
};

/** Observe-only validation for a preserved source: nothing is refused. */
function observeQuality(observed, job, raw, policy, known) {
  try {
    const fp = fingerprintOf(raw, job);
    if (observed.has(fp)) return;
    const verdict = validateJob(job, raw, policy);
    const prev = job ? known.get(job.externalJobId) : null;
    observed.set(fp, {
      fp, job, raw, verdict,
      urlChange: prev && job && prev.url !== job.applicationUrl ? { jobId: prev.id, oldUrl: prev.url, newUrl: job.applicationUrl } : null,
    });
  } catch (err) {
    console.error('[external] observe failed:', err.message);
  }
}

async function recordObserved(session, sourceId, observed) {
  let kept = 0;
  let urlChanges = 0;
  const fine = [];
  for (const o of observed.values()) {
    if (!o.verdict.ok) {
      kept += 1;
      await cx.quarantine(session, sourceId, {
        fingerprint: o.fp, externalJobId: o.job?.externalJobId || null, title: o.job?.title || o.raw?.title,
        company: o.job?.company || o.raw?.company, url: o.job?.applicationUrl || o.raw?.applyUrl || null,
        reasons: reasonCodes(o.verdict), action: 'kept', raw: o.raw,
      });
    } else fine.push(o.fp);
    if (o.urlChange && o.job) {
      urlChanges += 1;
      const v = validateExternalUrl(o.urlChange.newUrl, null);
      await cx.noteUrlChange(session, { ...o.urlChange, valid: v.ok, reason: v.ok ? null : v.reason, applied: true });
    }
  }
  await cx.resolveQuarantine(session, sourceId, fine);
  return { kept, urlChanges };
}

/* In-process: one sync per source at a time, and a ceiling overall. */
const RUNNING = new Set();
const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref(); });

/**
 * The checked pipeline: every source except the preserved ones.
 *
 * @param opts.scheduled  true from the sweep - honours backoff; a person
 *                        pressing "Sync now" does not wait for it
 */
async function syncChecked(session, source, policy, startedAt, opts = {}) {
  const sourceId = source.id;
  const cfg = config.externalJobs;
  const method = String(source.job_collection_method || 'manual');
  const ms = () => Date.now() - startedAt.getTime();

  /* Nothing to fetch for a manual source - not a failure, not a licence question. */
  if (method === 'manual') {
    await store.recordSyncResult(session, sourceId, { status: 'manual', error: null, jobCount: 0 });
    await store.recordSyncRun(session, { sourceId, startedAt, status: 'manual' });
    return { ok: true, status: 'manual', error: null, saved: 0, skipped: 0, linked: 0 };
  }

  /* Licence: a source without a complete, current licence record is never
     collected from, whether it is switched on or not. */
  const gap = await cx.licenceGap(session, sourceId);
  if (gap) {
    const run = await store.recordSyncRun(session, { sourceId, startedAt, status: 'licence_required', error: gap });
    await safe('run extend', () => cx.extendRun(session, runIdOf(run), {
      provider: policy.provider, durationMs: ms(), errorSummary: `Sync refused: ${gap}` }));
    return { ok: false, status: 'licence_required', error: gap, saved: 0, skipped: 0, linked: 0 };
  }

  if (opts.scheduled && source.next_sync_after && new Date(source.next_sync_after) > new Date()) {
    return { ok: false, status: 'backoff', error: `retrying after ${new Date(source.next_sync_after).toISOString()}`,
      saved: 0, skipped: 0, linked: 0 };
  }
  if (RUNNING.has(sourceId)) {
    return { ok: false, status: 'already_running', error: 'this source is already syncing', saved: 0, skipped: 0, linked: 0 };
  }
  if (RUNNING.size >= Math.max(1, cfg.maxConcurrentSyncs)) {
    return { ok: false, status: 'busy', error: 'too many sources are syncing right now - try again shortly',
      saved: 0, skipped: 0, linked: 0 };
  }
  RUNNING.add(sourceId);
  try {
    return await runChecked(session, source, policy, startedAt);
  } finally {
    RUNNING.delete(sourceId);
  }
}

async function runChecked(session, source, policy, startedAt) {
  const sourceId = source.id;
  const cfg = config.externalJobs;
  const ms = () => Date.now() - startedAt.getTime();
  const deadline = startedAt.getTime() + Math.max(5000, cfg.syncTimeoutMs);
  const gapMs = policy.rateLimitPerMinute ? Math.ceil(60000 / policy.rateLimitPerMinute) : 0;

  const terms = String(source.job_collection_method) === 'connector'
    ? await searchTermsFromCandidates(session)
    : [null];
  const boards = await store.listCareerBoards(session).catch(() => []);

  /* One call per term, each one paid for, spaced by the rate limit, and
     stopped by the time budget. A failure only counts when every call
     failed. */
  const all = [];
  const errors = [];
  let anyOk = false;
  let calls = 0;
  let stopped = null;
  const statuses = new Set();
  for (const term of terms) {
    if (Date.now() > deadline) { stopped = `stopped after ${Math.round(cfg.syncTimeoutMs / 1000)}s`; break; }
    const left = await safe('quota', () => cx.spendQuota(session, sourceId, 1));
    if (left != null && left < 0) { stopped = 'the monthly call quota is used up'; break; }
    if (calls > 0 && gapMs) await sleep(Math.min(gapMs, Math.max(0, deadline - Date.now())));
    calls += 1;
    const out = await collectJobs(source, { query: term || undefined, boards });
    statuses.add(out.status);
    if (out.status === 'ok') { anyOk = true; all.push(...(out.jobs || [])); }
    else if (terms.length <= 1) errors.push(out.error || out.status);
    else errors.push(`${term || 'all'}: ${out.error || out.status}`);
    if (all.length >= 1000) break;
  }
  if (stopped) errors.push(stopped);

  const errorText = errors.length ? errors.join(' | ').slice(0, 300) : null;
  if (!anyOk) {
    /* The provider's own word when every call said the same thing
       ("not_configured" is a set-up problem, not an outage). */
    const status = stopped && !calls ? 'quota_exhausted'
      : (statuses.size === 1 ? [...statuses][0] : 'failed');
    const error = errorText || 'the source could not be read';
    await store.recordSyncResult(session, sourceId, { status, error, jobCount: 0 });
    const run = await store.recordSyncRun(session, { sourceId, startedAt, status, error });
    const h = ['not_configured', 'unsupported'].includes(status)
      ? { health: null, errorKind: 'configuration' }
      : await afterSync(session, source, 'failure', { durationMs: ms(), error });
    await safe('run extend', () => cx.extendRun(session, runIdOf(run), {
      provider: policy.provider, durationMs: ms(), errorSummary: `Sync failed (${h.errorKind || 'failed'}): ${error}` }));
    return { ok: false, status, error, saved: 0, skipped: 0, linked: 0, health: shapeHealth(h.health) };
  }

  const known = await cx.knownJobs(session, sourceId);
  const previousOpen = [...known.values()].filter((k) => k.status === 'open').length;

  /* EMPTY IS NOT "NOTHING LEFT". A source that answers with no postings
     while we hold some is far more likely broken than empty; nothing is
     closed because of it, and it counts against its health. */
  if (!all.length && previousOpen > 0) {
    const error = `the source returned no jobs; the ${previousOpen} already held are kept`;
    await store.recordSyncResult(session, sourceId, { status: 'empty', error, jobCount: 0 });
    const run = await store.recordSyncRun(session, { sourceId, startedAt, status: 'empty', fetched: 0, error });
    const h = await afterSync(session, source, 'empty', { durationMs: ms(), previousOpen, error });
    await safe('run extend', () => cx.extendRun(session, runIdOf(run), {
      provider: policy.provider, durationMs: ms(), errorSummary: error }));
    return { ok: false, status: 'empty', error, saved: 0, skipped: 0, linked: 0, health: shapeHealth(h.health) };
  }

  let saved = 0;
  let created = 0;
  let failed = 0;
  let quarantined = 0;
  let urlChanges = 0;
  let urlFailures = 0;
  const problems = [];
  const accepted = [];
  const seen = new Set();
  for (const raw of all) {
    const job = normaliseExternalJob(raw, source);
    const fp = fingerprintOf(raw, job);
    if (seen.has(fp)) continue;            // the same posting from another search term
    seen.add(fp);

    const verdict = validateJob(job, raw, policy);
    const prev = job ? known.get(job.externalJobId) : null;
    if (!verdict.ok) {
      quarantined += 1;
      const codes = reasonCodes(verdict);
      if (codes.some((c) => /url|domain/.test(c))) urlFailures += 1;
      await safe('quarantine', () => cx.quarantine(session, sourceId, {
        fingerprint: fp, externalJobId: job?.externalJobId || null, title: job?.title || raw?.title,
        company: job?.company || raw?.company, url: job?.applicationUrl || raw?.applyUrl || null,
        reasons: codes, action: 'quarantined', raw }));
      /* A changed link that fails validation is NOT applied: the posting
         keeps the link it had, and the refusal is on record. */
      if (prev && job && prev.url !== job.applicationUrl) {
        urlChanges += 1;
        const bad = verdict.issues.find((i) => /url|domain/.test(i.code));
        await safe('url change', () => cx.noteUrlChange(session, { jobId: prev.id, oldUrl: prev.url,
          newUrl: job.applicationUrl || raw?.applyUrl || null, valid: false,
          reason: bad ? bad.message : 'the posting failed validation', applied: false }));
      }
      continue;
    }
    try {
      const row = await store.saveJob(session, job);
      if (row && row.created) created++;
      saved++;
      accepted.push(fp);
      if (prev && prev.url !== job.applicationUrl) {
        urlChanges += 1;
        await safe('url change', () => cx.noteUrlChange(session, { jobId: prev.id, oldUrl: prev.url,
          newUrl: job.applicationUrl, valid: true, reason: null, applied: true }));
      }
    } catch (err) {
      failed++;
      if (problems.length < 5) problems.push(String(err.message || err).slice(0, 160));
    }
  }

  const linked = await store.relinkDuplicates(session);
  await safe('quarantine resolve', () => cx.resolveQuarantine(session, sourceId, accepted));

  const status = problems.length || stopped ? 'partial' : 'ok';
  const error = [problems.join('; '), errorText].filter(Boolean).join(' | ') || null;
  await store.recordSyncResult(session, sourceId, { status, error, jobCount: saved });
  const run = await store.recordSyncRun(session, {
    sourceId, startedAt, status, fetched: all.length, created, updated: saved - created,
    duplicates: linked, skipped: quarantined, error,
  });
  const h = await afterSync(session, source, 'success', {
    durationMs: ms(), saved, created, quarantined, linked, previousOpen, fetched: seen.size, urlFailures,
  });
  await safe('run extend', () => cx.extendRun(session, runIdOf(run), {
    provider: policy.provider, failed, quarantined, urlChanges, durationMs: ms(),
    errorSummary: [quarantined ? `${quarantined} posting(s) quarantined` : '', failed ? `${failed} failed to save` : '', error || '']
      .filter(Boolean).join('; ') || null }));

  return {
    ok: true, status, saved, skipped: quarantined, linked, error,
    fetched: all.length, created, updated: saved - created, failed, quarantined, urlChanges,
    health: shapeHealth(h.health),
  };
}

const shapeHealth = (h) => (h ? {
  status: h.health_status, consecutiveFailures: h.consecutive_failures,
  nextSyncAfter: h.next_sync_after ? new Date(h.next_sync_after).toISOString() : null,
  openJobs: h.open_job_count,
} : null);

/* ------------------------------------------------------------------ *
 * 2 · match
 * ------------------------------------------------------------------ */

/**
 * Score one candidate against the open external jobs.
 *
 * READS the candidate and writes only `candidate_external_job_matches`.
 * Jobs that score nothing assessable are not stored at all - a row saying
 * "we know nothing about this posting" is not a match and would only
 * clutter the candidate's list.
 */
export async function matchCandidate(session, candidateId, { jobLimit = 200, minStore = 1 } = {}) {
  const cand = await store.readCandidate(session, candidateId);
  if (!cand) return { ok: false, status: 'not_found', error: 'no such candidate' };

  const jobs = await store.listJobs(session, { limit: jobLimit, canonicalOnly: true });
  const threshold = config.externalJobs.autoApplyThreshold;

  let scored = 0;
  let stored = 0;
  let unscorable = 0;
  let best = null;

  for (const job of jobs) {
    const m = await matchExternalJob(cand, job);
    scored++;
    /*
     * A SCORE THAT CAN NO LONGER BE DEFENDED IS REMOVED, not left behind.
     *
     * `continue` alone left the PREVIOUS row in place, so a match scored
     * under an older, looser rule stayed at the top of a candidate's
     * list for ever - a German customer-service post still reading 87%
     * for a Python graduate after the matcher had decided it could not
     * be scored at all. Re-running the matching has to be able to take
     * something away as well as add it.
     */
    if (m.percentage == null) {
      unscorable++;
      /* NOT swallowed. A delete that silently does nothing is how a
         score nobody can defend stays on screen; if this fails, the log
         says so and the count below will not add up. */
      await store.dropMatch(session, cand.id, job.id)
        .catch((e) => console.error('[external] stale match not removed:', e.message));
      continue;
    }
    if (m.percentage < minStore) {
      await store.dropMatch(session, cand.id, job.id)
        .catch((e) => console.error('[external] stale match not removed:', e.message));
      continue;
    }

    /*
     * ELIGIBLE IS NOT THE SAME AS WILL HAPPEN. This records that a
     * posting clears the bar and its source permits automated
     * submission; whether anything is actually sent is decided at apply
     * time, by a separate switch that is off by default.
     */
    const eligible = m.percentage >= threshold
      && job.auto_apply_supported === true
      && job.application_method !== 'none';

    await store.saveMatch(session, {
      candidateId,
      externalJobId: job.id,
      percentage: m.percentage,
      matchingSkills: m.matchingSkills,
      missingSkills: m.missingSkills,
      reasons: m.reasons,
      autoApplyEligible: eligible,
    });
    stored++;
    if (!best || m.percentage > best.percentage) {
      best = { percentage: m.percentage, title: job.title, company: job.company };
    }
  }

  return { ok: true, candidateId, scored, stored, unscorable, best };
}

/* ------------------------------------------------------------------ *
 * 3 · apply
 * ------------------------------------------------------------------ */

/**
 * What an external application cannot go out without - which depends
 * entirely on what "going out" means for this source.
 *
 * A REDIRECT TRANSMITS NOTHING. TeamLink records that the candidate was
 * put forward and opens the advertiser's own form, which the candidate
 * fills in themselves from whatever they have to hand. Demanding a stored
 * resume before allowing that would stop somebody applying for a public
 * vacancy because WE do not hold a copy of their CV, which is not a
 * defensible reason to stop them.
 *
 * A SUBMISSION DOES transmit their details, so it needs all of them: a
 * partial application sent in somebody's name is worse than none.
 */
function missingEssentials(cand, method, auto) {
  const missing = [];
  if (!cand.name) missing.push('name');
  if (method === 'redirect' && !auto) return missing;

  if (!cand.email) missing.push('email');
  if (!cand.phone) missing.push('phone number');
  if (!cand.resume_storage_path) missing.push('resume');
  return missing;
}

/**
 * Put a candidate forward for one external job.
 *
 * @param auto  true when this is TeamLink deciding rather than a person
 *              clicking. An automatic submission has to clear three extra
 *              gates: the deployment-wide switch, the source's own
 *              permission, and the score threshold. A human clicking
 *              Apply on their own profile clears none of them, because
 *              they are allowed to apply for a job they are a poor match
 *              for - that is their business, not ours.
 */
export async function applyExternally(session, { candidateId, externalJobId, auto = false } = {}) {
  const cand = await store.readCandidate(session, candidateId);
  if (!cand) return { ok: false, status: 'not_found', error: 'no such candidate' };

  const job = await store.getJob(session, externalJobId);
  if (!job) return { ok: false, status: 'not_found', error: 'no such external job' };
  if (job.status !== 'open') {
    return { ok: false, status: 'closed', error: 'that posting is no longer open' };
  }
  if (job.active !== true) {
    return { ok: false, status: 'source_inactive', error: `${job.source_name} is not active` };
  }
  if (job.application_method === 'none') {
    return { ok: false, status: 'unsupported',
      error: `${job.source_name} cannot be applied to through TeamLink` };
  }

  const missing = missingEssentials(cand, job.application_method, auto);
  if (missing.length) {
    return { ok: false, status: 'incomplete_profile',
      error: `their profile has no ${missing.join(', ')}` };
  }

  /* The score as it stands now, used for the threshold and copied onto
     the application so later re-matching cannot rewrite history. */
  const scored = await matchExternalJob(cand, job);

  if (auto) {
    if (!config.externalJobs.autoApplyEnabled) {
      return { ok: false, status: 'auto_apply_disabled',
        error: 'automatic applications are switched off (EXTERNAL_AUTO_APPLY_ENABLED)' };
    }
    if (job.auto_apply_supported !== true) {
      return { ok: false, status: 'auto_apply_not_permitted',
        error: `${job.source_name} does not permit automated applications` };
    }
    const threshold = config.externalJobs.autoApplyThreshold;
    if (scored.percentage == null || scored.percentage < threshold) {
      return { ok: false, status: 'below_threshold',
        error: `${scored.percentage ?? 'no'}% is below the ${threshold}% threshold` };
    }
  }

  /* The row exists before anything is sent, so a submission that fails
     halfway leaves a record saying so rather than nothing at all. */
  const opened = await store.openApplication(session, {
    candidateId,
    externalJobId: job.id,
    sourceId: job.source_id,
    matchPercentage: scored.percentage,
    applicationType: auto ? 'auto' : (job.application_method || 'manual'),
    applicationUrl: job.application_url,
  });

  if (opened.status !== 'ready') {
    /* Already applied. Not an error - the candidate is simply told. */
    return { ok: true, status: 'already_applied', application: opened };
  }

  await store.setApplicationStatus(session, opened.id, { status: 'applying' });

  const source = await store.getSource(session, job.source_id);
  const out = await submitApplication({ source, job, candidate: cand });

  const application = await store.setApplicationStatus(session, opened.id, {
    status: out.ourStatus || 'unknown',
    externalApplicationId: out.externalApplicationId || null,
    failureReason: out.status === 'failed' || out.status === 'not_configured' ? out.error : null,
  });

  return {
    ok: out.status !== 'failed',
    status: out.status,
    /* For a redirect this is the URL the candidate must open themselves.
       The caller has to surface it, or nothing has actually been applied
       for - which is why it is returned rather than only stored. */
    redirectUrl: out.url || job.application_url || null,
    note: out.error || null,
    match: { percentage: scored.percentage, reasons: scored.reasons },
    application,
  };
}

/* ------------------------------------------------------------------ *
 * 4 · follow up
 * ------------------------------------------------------------------ */

/**
 * Ask the source what happened.
 *
 * When it cannot answer - which is every source that is not a keyed
 * partner API - the status is left exactly where it was. `last_status_check_at`
 * is not touched either, because recording a check that could not happen
 * would make a stale row look fresh.
 */
export async function refreshApplicationStatus(session, applicationId) {
  const application = await store.getApplication(session, applicationId);
  if (!application) return { ok: false, status: 'not_found' };

  const source = await store.getSource(session, application.source_id);
  const out = await checkApplicationStatus({ source, application });

  if (!out.checked) {
    return { ok: false, status: out.status, error: out.error || null, application };
  }

  const updated = await store.setApplicationStatus(session, applicationId, {
    status: out.ourStatus || 'unknown',
    externalStatus: out.externalStatus,
  });
  return { ok: true, status: 'ok', application: updated };
}

/* ------------------------------------------------------------------ *
 * the scheduled sync
 * ------------------------------------------------------------------ */

/**
 * Every six hours, and a "Sync now" button for the impatient.
 *
 * WHY NOT node-cron. This codebase already runs five background sweeps
 * on plain setInterval (notify/retry.js, notify/joining.js and the rest),
 * started from the same place and stopped the same way. One more of the
 * same needs no dependency, and a second scheduling mechanism beside the
 * first is a second thing to reason about when something does not run.
 *
 * A SOURCE THAT FAILS DOES NOT STOP THE OTHERS. Each is awaited in turn
 * and its outcome recorded on its own row; a board that is down shows as
 * down on the admin screen while the rest of the sync completes.
 *
 * NOTHING RUNS WHEN THE FEATURE IS OFF. `EXTERNAL_JOBS_ENABLED` is the
 * switch, and with it off this returns a no-op stopper rather than
 * quietly polling job boards nobody asked it to.
 */
export function startExternalSyncSweep() {
  if (!config.externalJobs.enabled) return () => {};

  const hours = Math.max(1, Number(config.externalJobs.syncEveryHours) || 6);
  const every = hours * 60 * 60 * 1000;
  /* The engine's own identity: a scheduled sync belongs to the system,
     not to whichever recruiter happened to be signed in last. */
  const ENGINE = { userId: '', role: 'admin', profileId: null };

  let stopped = false;
  let running = false;

  const run = async () => {
    if (stopped || running) return;
    running = true;
    try {
      /* 0108: a source whose licence has expired, been revoked or had its
         consent withdrawn is switched off first, with the reason on record
         and the administrators told. */
      const disabled = (await safe('licence enforcement', () => cx.enforceLicences(ENGINE))) || [];
      for (const d of disabled) {
        console.log(`[external] ${d.source_id} switched off: ${d.reason}`);
        await safe('licence alert', () => cx.alertAdmins(ENGINE, {
          key: `${d.source_id}|licence|${new Date().toISOString().slice(0, 10)}`,
          type: 'EXTERNAL_SOURCE_LICENCE', sourceId: d.source_id,
          title: 'A job source was switched off', message: `Its licence is no longer valid: ${d.reason}`,
        }));
      }

      const sources = await store.listSources(ENGINE);
      const live = sources.filter((s) => s.active === true);
      if (!live.length) return;

      for (const s of live) {
        if (stopped) break;
        /* 0108: a checked source syncs on its own interval and waits out its
           backoff. A preserved one (Greenhouse) keeps the old cadence. */
        const policy = sourcePolicy(s);
        if (!policy.preserve) {
          if (s.next_sync_after && new Date(s.next_sync_after) > new Date()) {
            console.log(`[external] ${s.name}: backing off until ${new Date(s.next_sync_after).toISOString()}`);
            continue;
          }
          const dueAt = s.last_attempt_at
            ? new Date(s.last_attempt_at).getTime() + policy.syncIntervalHours * 3600000 - 10 * 60000 : 0;
          if (dueAt > Date.now()) continue;
        }
        try {
          const out = await syncSource(ENGINE, s.id, { scheduled: true });
          console.log(`[external] ${s.name}: ${out.status}`
            + (out.saved ? `, ${out.saved} saved` : '')
            + (out.skipped ? `, ${out.skipped} skipped` : '')
            + (out.error ? ` - ${String(out.error).slice(0, 120)}` : ''));
        } catch (err) {
          console.error(`[external] ${s.name} failed:`, err.message);
        }
      }

      /* A posting that has stopped appearing in its feed has been taken
         down. Closed rather than deleted: a candidate who applied to it
         still has an application pointing at it. */
      const expiryStart = new Date();
      const closed = await closeStalePostings(ENGINE);
      if (closed) {
        await store.recordSyncRun(ENGINE, { kind: 'expire', startedAt: expiryStart, status: 'ok', closed });
      }
      if (closed) console.log(`[external] ${closed} posting(s) closed after `
        + `${config.externalJobs.activeDays} days unseen`);

      /* And anything the country rule would refuse, for a pool built
         before the rule existed. */
      const outside = await closeJobsOutsideCountry(ENGINE);
      if (outside.closed) {
        console.log(`[external] ${outside.closed} posting(s) closed as outside `
          + config.externalJobs.countryFilter);
      }
    } catch (err) {
      console.error('[external] sweep failed:', err.message);
    } finally {
      running = false;
    }
  };

  /* Not on boot: a restart should not hammer every board. The first run
     is one interval away, and "Sync now" covers the impatient case. */
  const timer = setInterval(run, every);
  if (timer.unref) timer.unref();
  return () => { stopped = true; clearInterval(timer); };
}

/**
 * Mark postings nobody has seen for the grace period as closed.
 *
 * CLOSED, NEVER DELETED, and (0108) never because the SOURCE was down. A
 * posting is closed only when its source has had a successful sync since
 * the posting was last seen - so a feed that fails, or answers empty, for
 * a month keeps every job it had, and only the run and the health say it
 * is broken. The grace period is per source (close_grace_days), defaulting
 * to EXTERNAL_JOBS_CLOSE_GRACE_DAYS, which defaults to the old 14 days.
 *
 * Preserved providers (Greenhouse) keep the pre-0108 rule exactly:
 * unseen for the period, closed.
 */
export async function closeStalePostings(session) {
  const days = Math.max(1, Number(config.externalJobs.closeGraceDays)
    || Number(config.externalJobs.activeDays) || 14);
  return withUser(session, async (c) => {
    const { rowCount } = await c.query(
      `update external_jobs j
          set status = 'closed'
         from job_sources s
        where s.id = j.source_id
          and j.status = 'open'
          and j.synced_at < now() - (coalesce(s.close_grace_days, $1::int) || ' days')::interval
          and (s.provider = any($2::text[])
               or (s.last_success_at is not null and j.synced_at < s.last_success_at))`,
      [days, PRESERVED]);
    return rowCount;
  });
}

/**
 * Close the postings already stored that the country rule would refuse.
 *
 * The India filter runs at ingestion, which protects everything
 * collected from now on and does nothing about what is already there.
 * A pool built before the rule existed keeps showing American and
 * European roles to candidates in Nellore until somebody clears it.
 *
 * CLOSED, NOT DELETED. A candidate may have applied to one of these, and
 * their application points at the row; deleting it would take their own
 * history away to tidy a list. `status = 'closed'` removes it from every
 * candidate-facing query and leaves the record intact.
 *
 * @returns { checked, closed, kept }
 */
export async function closeJobsOutsideCountry(session) {
  if (!config.externalJobs.countryFilter) return { checked: 0, closed: 0, kept: 0 };

  const rows = await withUser(session, async (c) => (await c.query(
    `select id, location, city, state, country from external_jobs where status = 'open'`)).rows);

  const doomed = [];
  for (const r of rows) {
    if (!inIndia(r).keep) doomed.push(r.id);
  }

  if (doomed.length) {
    await withUser(session, (c) => c.query(
      `update external_jobs set status = 'closed' where id = any($1)`, [doomed]));
  }
  return { checked: rows.length, closed: doomed.length, kept: rows.length - doomed.length };
}
