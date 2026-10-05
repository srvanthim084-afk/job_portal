/**
 * Save & Post - the publishing worker (0112).
 *
 * A recruiter's choice of destinations is stored as one job_publications
 * row per (job, destination) with `desired` = published | removed. This
 * module makes each row true:
 *
 *   job open + desired published   -> publish, or push an update when the
 *                                     job changed since it was last sent
 *   job closed / unticked          -> take it down where it went up
 *   partner not configured         -> "Integration Required"; NOTHING is sent
 *   failure                        -> "Failed", the error recorded, retried
 *                                     with exponential backoff
 *   feed listing                   -> "awaiting confirmation" until the
 *                                     platform confirms
 *
 * NEVER TWICE. A row is acted on only by the worker that claimed it (an
 * atomic UPDATE ... WHERE status <> 'posting'), every call carries an
 * idempotency key, a publish happens only while no external id is held,
 * and calls for one job are serialised in this process.
 *
 * NEVER INSIDE A TRANSACTION. Every network call runs between database
 * transactions, never inside one: PGlite has one session, and a held
 * transaction would also block the very page the portal check fetches.
 */
import { withUser } from '../db.js';
import { connectorFor, missingFor, PublishError } from './connectors.js';
import { jobContentHash } from './feed.js';
import { openSecrets, scrub } from './secrets.js';

export const ENGINE = { userId: '', role: 'admin', profileId: null };
export const OWN = ['TEAMLINK_PORTAL', 'TEAMLINK_WEBSITE'];
export const STATUS_LABEL = {
  pending: 'Pending', posting: 'Posting', posted: 'Posted', awaiting_confirmation: 'Listed in feed — awaiting confirmation',
  failed: 'Failed', integration_required: 'Integration Required', removed: 'Removed',
};

const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const MAX_ATTEMPTS = () => num(process.env.PUBLISH_MAX_ATTEMPTS, 6);
const BACKOFF_BASE = () => num(process.env.PUBLISH_BACKOFF_BASE_MS, 30000);
const STATUS_EVERY = () => num(process.env.PUBLISH_STATUS_CHECK_MS, 30 * 60000);
const STALE_CLAIM_MS = () => num(process.env.PUBLISH_STALE_CLAIM_MS, 5 * 60000);
/** 30 s, 1 min, 2 min, 4 min ... capped at 6 h. */
export const backoffMs = (attempts) => Math.min(BACKOFF_BASE() * 2 ** Math.max(0, attempts - 1), 6 * 3600000);

/* ------------------------------------------------------------------ *
 * configuration
 * ------------------------------------------------------------------ */
export function integrationOf(row) {
  if (!row) return null;
  return {
    destination: row.destination,
    enabled: !!row.enabled,
    connectionType: row.connection_type || null,
    endpointUrl: row.endpoint_url || '',
    authType: row.auth_type || null,
    tokenUrl: row.token_url || '',
    statusUrl: row.status_url || '',
    accountId: row.account_id || '',
    clientId: row.client_id || '',
    options: row.options || {},
    hasSealedSecrets: !!row.secrets_enc,
    secrets: openSecrets(row.secrets_enc),
  };
}

async function destinations(c) {
  return (await c.query(`select * from publishing_destinations where active order by sort_order, key`)).rows;
}
async function integrations(c) {
  const out = {};
  for (const r of (await c.query(`select * from publishing_integrations`)).rows) out[r.destination] = integrationOf(r);
  return out;
}

/** Can this destination take a job right now? '' when it can, else why not. */
export function blockerFor(dest, integ) {
  if (dest.kind === 'own') return '';
  return missingFor(integ);
}

/* ------------------------------------------------------------------ *
 * the audit trail
 * ------------------------------------------------------------------ */
async function event(c, pub, ev, { from = null, to = null, detail = null, actor = null } = {}) {
  await c.query(
    `insert into job_publication_events (publication_id, job_id, destination, event, from_status, to_status, detail, actor)
     values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [pub.id, pub.job_id, pub.destination, ev, from, to, detail ? String(detail).slice(0, 1000) : null, actor || null]);
}

/* ------------------------------------------------------------------ *
 * what the recruiter asked for
 * ------------------------------------------------------------------ */
/**
 * Records the destinations ticked for a job (Save & Post). Unticked
 * destinations that were asked for before become desired = removed.
 * TEAMLINK_PORTAL follows the job's own status and is always kept.
 * Runs as the worker; the CALLER has already checked the user may edit
 * this job.
 */
export async function setDestinations(jobId, keys, actorUserId) {
  return withUser(ENGINE, async (c) => {
    const all = await destinations(c);
    const known = new Set(all.map((d) => d.key));
    const want = new Set((keys || []).map((k) => String(k).toUpperCase()).filter((k) => known.has(k)));
    want.add('TEAMLINK_PORTAL');
    const existing = (await c.query(`select * from job_publications where job_id=$1`, [jobId])).rows;
    const byDest = Object.fromEntries(existing.map((p) => [p.destination, p]));
    for (const key of want) {
      const p = byDest[key];
      if (!p) {
        const row = (await c.query(
          `insert into job_publications (job_id, destination, desired, status, requested_by, posted_by, next_attempt_at)
           values ($1,$2,'published','pending',$3,$3,now())
           on conflict (job_id, destination) do update set desired='published', updated_at=now()
           returning *`, [jobId, key, actorUserId || null])).rows[0];
        await event(c, row, 'requested', { to: row.status, actor: actorUserId, detail: 'Ticked on Save & Post' });
      } else if (p.desired !== 'published') {
        const row = (await c.query(
          `update job_publications set desired='published', requested_by=$2, posted_by=$2, requested_at=now(),
                  status = case when status='posting' then status else 'pending' end,
                  attempts = 0, next_attempt_at=now(), updated_at=now()
            where id=$1 returning *`, [p.id, actorUserId || null])).rows[0];
        await event(c, row, 'requested', { from: p.status, to: row.status, actor: actorUserId, detail: 'Ticked again on Save & Post' });
      }
    }
    for (const p of existing) {
      if (!want.has(p.destination) && p.desired !== 'removed') {
        const row = (await c.query(`update job_publications set desired='removed', next_attempt_at=now(), updated_at=now() where id=$1 returning *`, [p.id])).rows[0];
        await event(c, row, 'unticked', { from: p.status, to: row.status, actor: actorUserId, detail: 'Unticked on Save & Post' });
      }
    }
  });
}

/**
 * "Publish now" / "Retry": a failed or waiting row is due immediately,
 * with a fresh run of attempts. Does nothing to a row already posted.
 */
export async function makeDue(jobId, destination = null, actorUserId = null) {
  await withUser(ENGINE, async (c) => {
    const rows = (await c.query(
      `update job_publications set next_attempt_at=now(), attempts=0, updated_at=now()
        where job_id=$1 and ($2::text is null or destination=$2)
          and status in ('failed','integration_required','pending','awaiting_confirmation')
        returning *`, [jobId, destination])).rows;
    for (const r of rows) await event(c, r, 'retry_requested', { from: r.status, to: r.status, actor: actorUserId });
  });
}

/* ------------------------------------------------------------------ *
 * reconciling one job
 * ------------------------------------------------------------------ */
const running = new Map();     // jobId -> promise: one reconcile per job at a time

/** Makes every publication of a job match what was asked. Returns the rows. */
export function reconcileJob(jobId, opts = {}) {
  const prev = running.get(jobId) || Promise.resolve();
  const next = prev.catch(() => {}).then(() => reconcileOnce(jobId, opts));
  running.set(jobId, next);
  next.finally(() => { if (running.get(jobId) === next) running.delete(jobId); }).catch(() => {});
  return next;
}

function decide(pub, job, open, dest, integ, now) {
  const live = pub.desired === 'published' && open;
  const due = !pub.next_attempt_at || new Date(pub.next_attempt_at).getTime() <= now;
  const stale = pub.status === 'posting' && (!pub.claimed_at || now - new Date(pub.claimed_at).getTime() > STALE_CLAIM_MS());
  if (pub.status === 'posting' && !stale) return null;
  const blocker = blockerFor(dest, integ);
  const wasUp = !!pub.external_job_id && pub.status !== 'removed'
    || ['posted', 'awaiting_confirmation'].includes(pub.status);
  if (live) {
    if (['posted', 'awaiting_confirmation'].includes(pub.status) || (stale && pub.external_job_id)) {
      if (blocker) return null;                              // still up there; nothing we can do now
      if (pub.pushed_hash !== jobContentHash(job)) return { op: 'update' };
      if (pub.status === 'awaiting_confirmation' && due) return { op: 'status' };
      return null;
    }
    if (blocker) {
      return pub.status === 'integration_required' && pub.last_error === blocker ? null
        : { op: 'flag', status: 'integration_required', error: blocker };
    }
    if (pub.status === 'failed' && (!due || pub.attempts >= MAX_ATTEMPTS())) return null;
    if (pub.status === 'pending' && !due) return null;
    return { op: pub.external_job_id && pub.status !== 'removed' ? 'update' : 'publish' };
  }
  // not live: the job is closed / paused / expired, or the destination was unticked
  if (pub.status === 'removed') return null;
  if (!wasUp) return { op: 'flag', status: 'removed', error: null };
  if (blocker && dest.kind !== 'own') {
    return pub.status === 'failed' && pub.last_error === `Cannot remove: ${blocker}` && !due ? null
      : { op: 'flag', status: 'failed', error: `Cannot remove: ${blocker}` };
  }
  if (pub.status === 'failed' && (!due || pub.attempts >= MAX_ATTEMPTS())) return null;
  return { op: 'unpublish' };
}

async function reconcileOnce(jobId, { force = false } = {}) {
  const now = Date.now();
  /* 1. decide and claim, in one short transaction */
  const plan = await withUser(ENGINE, async (c) => {
    const job = (await c.query(
      `select j.*, co.name as company_name from jobs j left join companies co on co.id = j.company_id where j.id=$1`, [jobId])).rows[0];
    const pubs = (await c.query(`select * from job_publications where job_id=$1 order by id`, [jobId])).rows;
    if (!pubs.length) return { job, work: [] };
    const open = job ? (await c.query(`select 1 from jobs_open where id=$1`, [jobId])).rowCount > 0 : false;
    const dests = Object.fromEntries((await destinations(c)).map((d) => [d.key, d]));
    const integ = await integrations(c);
    const work = [];
    for (const pub of pubs) {
      const dest = dests[pub.destination];
      if (!dest) continue;
      const p = force && pub.status === 'failed' ? { ...pub, next_attempt_at: null, attempts: 0 } : pub;
      const d = decide(p, job || {}, open && !!job, dest, integ[pub.destination], now);
      if (!d) {
        /* Looked at and nothing to do: noted, so the sweep's "edited since"
           test does not pick this job again for the same edit. */
        if (job && job.updated_at && new Date(job.updated_at) > new Date(pub.updated_at)
            && ['posted', 'awaiting_confirmation', 'integration_required'].includes(pub.status)) {
          await c.query(`update job_publications set updated_at=now() where id=$1 and status <> 'posting'`, [pub.id]);
        }
        continue;
      }
      if (d.op === 'flag') {
        const row = (await c.query(
          `update job_publications set status=$2, last_error=$3, claim_token=null, claimed_at=null,
                  removed_at = case when $2='removed' then now() else removed_at end,
                  next_attempt_at = case when $2='failed' then now() + interval '1 hour' else next_attempt_at end,
                  updated_at=now()
            where id=$1 and status <> 'posting' or (id=$1 and claimed_at < now() - ($4 || ' milliseconds')::interval)
            returning *`, [pub.id, d.status, d.error, String(STALE_CLAIM_MS())])).rows[0];
        if (row && (pub.status !== d.status || pub.last_error !== d.error)) {
          await event(c, row, d.status, { from: pub.status, to: d.status, detail: d.error });
        }
        continue;
      }
      const token = `${process.pid}-${now}-${Math.random().toString(36).slice(2, 8)}`;
      const claimed = (await c.query(
        `update job_publications
            set status='posting', claim_token=$2, claimed_at=now(), last_attempt_at=now(),
                attempts = attempts + 1, updated_at=now()
          where id=$1 and (status <> 'posting' or claimed_at < now() - ($3 || ' milliseconds')::interval)
          returning *`, [pub.id, token, String(STALE_CLAIM_MS())])).rows[0];
      if (!claimed) continue;
      await event(c, claimed, d.op === 'unpublish' ? 'removing' : d.op === 'status' ? 'checking' : d.op === 'update' ? 'updating' : 'posting',
        { from: pub.status, to: 'posting' });
      work.push({ pub: { ...claimed, status_before: pub.status }, op: d.op, dest: dests[pub.destination], integ: integ[pub.destination] });
    }
    return { job, work };
  });

  /* 2. talk to each destination, outside any transaction */
  const results = [];
  for (const w of plan.work) {
    const conn = connectorFor(w.pub.destination, w.integ, w.dest.label);
    const ctx = { integration: w.integ || {} };
    const forOp = w.op === 'publish' ? conn.publish : w.op === 'update' ? conn.update : w.op === 'status' ? conn.status : conn.unpublish;
    const pubForConnector = { ...w.pub, status: w.pub.status_before };
    try {
      const out = await forOp.call(conn, plan.job || { id: jobId }, pubForConnector, ctx);
      if (out.state === 'posted' && !out.externalJobId && !out.externalUrl) {
        throw new PublishError('No external id or URL came back - not marked Posted.');
      }
      results.push({ w, out });
    } catch (err) {
      const msg = scrub(err && err.message ? err.message : String(err), w.integ && w.integ.secrets);
      results.push({ w, err: msg || 'Unknown error' });
    }
  }

  /* 3. write what happened */
  if (results.length) {
    await withUser(ENGINE, async (c) => {
      for (const { w, out, err } of results) {
        const p = w.pub;
        if (err) {
          const next = p.attempts >= MAX_ATTEMPTS() ? null : new Date(Date.now() + backoffMs(p.attempts));
          const row = (await c.query(
            `update job_publications set status='failed', last_error=$3, next_attempt_at=$4, claim_token=null, claimed_at=null, updated_at=now()
              where id=$1 and claim_token=$2 returning *`, [p.id, p.claim_token, err, next])).rows[0];
          if (row) await event(c, row, 'failed', { from: 'posting', to: 'failed',
            detail: `${err}${next ? ` (retry ${p.attempts}/${MAX_ATTEMPTS()} at ${next.toISOString()})` : ' (no more automatic retries)'}` });
          await c.query(`update publishing_integrations set last_error=$2, last_error_at=now() where destination=$1`, [p.destination, err]);
          continue;
        }
        const posted = out.state === 'posted';
        const removed = out.state === 'removed';
        const row = (await c.query(
          `update job_publications
              set status=$3,
                  external_job_id = coalesce($4, external_job_id),
                  external_url    = coalesce($5, external_url),
                  pushed_hash     = case when $3 in ('posted','awaiting_confirmation') then $6 else pushed_hash end,
                  confirmed_at    = case when $3='posted' then coalesce(confirmed_at, now()) when $3='removed' then confirmed_at else confirmed_at end,
                  removed_at      = case when $3='removed' then now() else null end,
                  next_attempt_at = case when $3='awaiting_confirmation' then now() + ($7 || ' milliseconds')::interval else null end,
                  attempts = 0, last_error = null, claim_token=null, claimed_at=null, updated_at=now()
            where id=$1 and claim_token=$2 returning *`,
          [p.id, p.claim_token, out.state, out.externalJobId || null, out.externalUrl || null,
            jobContentHash(plan.job || {}), String(STATUS_EVERY())])).rows[0];
        if (row) {
          await event(c, row, w.op === 'update' && posted ? 'updated' : out.state, { from: 'posting', to: out.state,
            detail: [out.note, posted ? `${row.external_url || ''}${row.external_job_id ? ` (id ${row.external_job_id})` : ''}` : ''].filter(Boolean).join(' · ') || null });
        }
        if (!removed) await c.query(`update publishing_integrations set last_sync_at=now() where destination=$1`, [p.destination]);
      }
    });
  }
  return listForJob(jobId);
}

/* ------------------------------------------------------------------ *
 * a platform's confirmation (signed callback)
 * ------------------------------------------------------------------ */
export async function confirmFromPlatform(destination, { reference, externalJobId, externalUrl, status }) {
  const st = String(status || 'live').toLowerCase();
  return withUser(ENGINE, async (c) => {
    const pub = (await c.query(`select * from job_publications where job_id=$1 and destination=$2`, [reference, destination])).rows[0];
    if (!pub) return { ok: false, reason: 'unknown job' };
    let row;
    if (/^(rejected|failed|error|expired|closed|deleted|removed|inactive)$/.test(st)) {
      row = (await c.query(`update job_publications set status='failed', last_error=$2, updated_at=now() where id=$1 and status <> 'posting' returning *`,
        [pub.id, `The platform reports the job as "${st}".`])).rows[0];
    } else {
      if (!externalJobId && !externalUrl) return { ok: false, reason: 'a confirmation must carry an external id or URL' };
      if (pub.desired !== 'published' || pub.status === 'removed') return { ok: false, reason: 'the job is not listed' };
      row = (await c.query(
        `update job_publications set status='posted', external_job_id=coalesce($2, external_job_id), external_url=coalesce($3, external_url),
                confirmed_at=now(), last_error=null, next_attempt_at=null, updated_at=now()
          where id=$1 and status <> 'posting' returning *`, [pub.id, externalJobId || null, externalUrl || null])).rows[0];
    }
    if (!row) return { ok: false, reason: 'busy; send again' };
    await event(c, row, st.match(/^(rejected|failed|error|expired|closed|deleted|removed|inactive)$/) ? 'failed' : 'confirmed',
      { from: pub.status, to: row.status, detail: 'Confirmation from the platform (signed callback)' });
    await c.query(`update publishing_integrations set last_sync_at=now() where destination=$1`, [destination]);
    return { ok: true, status: row.status };
  });
}

/* ------------------------------------------------------------------ *
 * reading
 * ------------------------------------------------------------------ */
export function toPublication(r, dest) {
  return {
    destination: r.destination,
    label: (dest && dest.label) || r.destination,
    desired: r.desired,
    status: r.status,
    statusLabel: r.status === 'awaiting_confirmation' && dest
      ? `Listed in feed — awaiting ${dest.label} confirmation` : STATUS_LABEL[r.status] || r.status,
    externalJobId: r.external_job_id || null,
    externalUrl: r.external_url || null,
    attempts: r.attempts,
    lastError: r.last_error || null,
    lastAttemptAt: r.last_attempt_at || null,
    nextAttemptAt: r.next_attempt_at || null,
    confirmedAt: r.confirmed_at || null,
    removedAt: r.removed_at || null,
    requestedAt: r.requested_at,
    updatedAt: r.updated_at,
  };
}

export async function listForJob(jobId, session = ENGINE) {
  return withUser(session, async (c) => {
    const dests = Object.fromEntries((await c.query(`select * from publishing_destinations`)).rows.map((d) => [d.key, d]));
    const rows = (await c.query(
      `select p.* from job_publications p join publishing_destinations d on d.key = p.destination
        where p.job_id=$1 order by d.sort_order`, [jobId])).rows;
    return rows.map((r) => toPublication(r, dests[r.destination]));
  });
}

/* ------------------------------------------------------------------ *
 * the sweep
 * ------------------------------------------------------------------ */
/**
 * Every job with something to do: queued or due rows, waiting rows whose
 * integration is now configured, feed listings due a status check, stale
 * claims, jobs closed or edited since their rows were last written.
 */
export async function sweepOnce({ destination = null, limit = 50 } = {}) {
  const ids = await withUser(ENGINE, async (c) => {
    const dests = await destinations(c);
    const integ = await integrations(c);
    const ready = dests.filter((d) => !blockerFor(d, integ[d.key])).map((d) => d.key);
    return (await c.query(
      `select distinct p.job_id, min(p.updated_at) as at
         from job_publications p
         left join jobs j on j.id = p.job_id
        where ($1::text is null or p.destination = $1)
          and (
               p.status = 'pending'
            or (p.status = 'failed' and p.attempts < $3 and (p.next_attempt_at is null or p.next_attempt_at <= now()))
            or (p.status = 'integration_required' and p.destination = any($2::text[]))
            or (p.status = 'awaiting_confirmation' and p.next_attempt_at <= now())
            or (p.status = 'posting' and p.claimed_at < now() - ($4 || ' milliseconds')::interval)
            or (p.status in ('posted','awaiting_confirmation') and (p.desired = 'removed'
                 or not exists (select 1 from jobs_open o where o.id = p.job_id)
                 or j.updated_at > p.updated_at))
            or (p.status = 'integration_required' and (p.desired = 'removed' or not exists (select 1 from jobs_open o where o.id = p.job_id)))
          )
        group by p.job_id
        order by at
        limit $5`, [destination, ready, MAX_ATTEMPTS(), String(STALE_CLAIM_MS()), limit])).rows.map((r) => r.job_id);
  });
  let done = 0;
  for (const id of ids) {
    try { await reconcileJob(id); done += 1; } catch (err) { console.error('[publishing] job', id, 'could not be reconciled:', err.message); }
  }
  return { jobs: ids.length, done };
}

/** Resolves once every reconcile running in this process has finished. */
export async function settle() {
  for (let i = 0; i < 5 && (running.size || timers.size); i++) {
    await Promise.allSettled([...running.values()]);
    if (timers.size) await new Promise((r) => setTimeout(r, 250));
  }
}

/** Reconcile a job soon, without making the caller wait. */
const timers = new Map();
export function kickJob(jobId, delayMs = 200) {
  if (!jobId) return;
  clearTimeout(timers.get(jobId));
  timers.set(jobId, setTimeout(() => {
    timers.delete(jobId);
    reconcileJob(jobId).catch((err) => console.error('[publishing] job', jobId, 'reconcile failed:', err.message));
  }, delayMs));
}

export function startPublishingSweep() {
  const every = num(process.env.PUBLISH_SWEEP_MS, 60000);
  let busy = false;
  const t = setInterval(() => {
    if (busy) return;
    busy = true;
    sweepOnce().catch((err) => console.error('[publishing] sweep failed:', err.message)).finally(() => { busy = false; });
  }, every);
  if (t.unref) t.unref();
  return () => clearInterval(t);
}
