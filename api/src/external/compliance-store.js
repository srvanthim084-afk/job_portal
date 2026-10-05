/**
 * Every database statement 0108's compliance layer makes.
 *
 * Kept apart from store.js on purpose: store.js is the path every
 * Greenhouse posting already travels, and nothing in it changes. Like
 * store.js, the only TeamLink table named here is `candidates` - and only
 * through app_candidate_id() inside a definer function - and every write
 * goes through a definer function in 0108.
 */
import { withUser } from '../db.js';

/* ---- licences -------------------------------------------------------- */

export async function licenceGap(session, sourceId) {
  return withUser(session, async (c) => (await c.query(
    `select external_source_licence_gap($1) as gap`, [sourceId])).rows[0]?.gap || null);
}

export async function getLicence(session, sourceId) {
  return withUser(session, async (c) => (await c.query(
    `select * from external_source_licences where source_id = $1`, [sourceId])).rows[0] || null);
}

export async function listLicences(session) {
  return withUser(session, async (c) => (await c.query(`select * from external_source_licences`)).rows);
}

export async function saveLicence(session, sourceId, l) {
  return withUser(session, async (c) => (await c.query(
    `select (external_source_licence_save($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)).*`,
    [sourceId, l.collectionMethod, l.licenceStatus, l.consentStatus, l.termsUrl || null,
     l.dataUsageAllowed === true, l.applicationRedirectAllowed === true,
     l.effectiveFrom || null, l.effectiveUntil || null, l.owner || null, l.notes || null])).rows[0]);
}

export async function saveSourceConfig(session, sourceId, cfg) {
  return withUser(session, async (c) => (await c.query(
    `select (external_source_config_save($1,$2,$3,$4,$5,$6,$7)).*`,
    [sourceId, cfg.provider || null, cfg.allowedDomains || null, cfg.syncIntervalHours ?? null,
     cfg.rateLimitPerMinute ?? null, cfg.closeGraceDays ?? null, cfg.monthlyQuota ?? null])).rows[0]);
}

export async function disableSource(session, sourceId, reason) {
  return withUser(session, async (c) => (await c.query(
    `select external_source_disable($1,$2) as ok`, [sourceId, reason])).rows[0]?.ok === true);
}

export async function enforceLicences(session) {
  return withUser(session, async (c) => (await c.query(
    `select * from external_sources_enforce_licences()`)).rows);
}

/* ---- the sync -------------------------------------------------------- */

/** external_job_id -> { id, url, status } for one source. */
export async function knownJobs(session, sourceId) {
  const rows = await withUser(session, async (c) => (await c.query(
    `select * from external_jobs_known($1)`, [sourceId])).rows);
  return new Map(rows.map((r) => [r.external_job_id, { id: r.id, url: r.application_url, status: r.status }]));
}

export async function openJobCount(session, sourceId) {
  return withUser(session, async (c) => Number((await c.query(
    `select count(*)::int as n from external_jobs where source_id = $1 and status = 'open'`,
    [sourceId])).rows[0]?.n || 0));
}

export async function quarantine(session, sourceId, item) {
  return withUser(session, (c) => c.query(
    `select external_quarantine_put($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
    [sourceId, item.fingerprint, item.externalJobId || null, item.title || null, item.company || null,
     item.url || null, item.reasons || [], item.action || 'quarantined',
     JSON.stringify(trimRaw(item.raw))]));
}

export async function resolveQuarantine(session, sourceId, fingerprints) {
  if (!fingerprints.length) return 0;
  return withUser(session, async (c) => Number((await c.query(
    `select external_quarantine_resolve($1,$2) as n`, [sourceId, fingerprints])).rows[0]?.n || 0));
}

export async function noteUrlChange(session, { jobId, oldUrl, newUrl, valid, reason, applied }) {
  return withUser(session, (c) => c.query(
    `select external_job_url_change_note($1,$2,$3,$4,$5,$6)`,
    [jobId, newUrl || null, valid, reason || null, applied === true, oldUrl || null]));
}

export async function extendRun(session, runId, x) {
  if (!runId) return;
  return withUser(session, (c) => c.query(
    `select external_sync_run_extend($1,$2,$3,$4,$5,$6,$7)`,
    [runId, x.provider || null, x.failed || 0, x.quarantined || 0, x.urlChanges || 0,
     x.durationMs ?? null, x.errorSummary || null]));
}

export async function spendQuota(session, sourceId, calls = 1) {
  return withUser(session, async (c) => Number((await c.query(
    `select job_source_spend($1,$2) as remaining`, [sourceId, calls])).rows[0]?.remaining ?? -1));
}

export async function recordHealth(session, sourceId, { outcome, durationMs, threshold, baseHours, maxHours, startedAt }) {
  return withUser(session, async (c) => (await c.query(
    `select * from external_source_health_record($1,$2,$3,$4,$5,$6,$7)`,
    [sourceId, outcome, durationMs ?? null, threshold, baseHours, maxHours, startedAt || null])).rows[0] || null);
}

export async function alertAdmins(session, { key, type, sourceId, title, message, metadata = {} }) {
  return withUser(session, async (c) => Number((await c.query(
    `select external_admin_alert($1,$2,$3,$4,$5,$6::jsonb) as n`,
    [key, type, sourceId || null, title, message, JSON.stringify(metadata)])).rows[0]?.n || 0));
}

export async function audit(session, { action, entity, entityId, oldValue = null, newValue = null, reason = null }) {
  return withUser(session, (c) => c.query(
    `select external_audit_add($1,$2,$3,$4::jsonb,$5::jsonb,$6)`,
    [action, entity, entityId || null, oldValue == null ? null : JSON.stringify(oldValue),
     newValue == null ? null : JSON.stringify(newValue), reason]));
}

/* ---- the portal ------------------------------------------------------ */

export async function portalVersion(session) {
  return withUser(session, async (c) => (await c.query(`select external_portal_version() as v`)).rows[0]?.v || '');
}

export async function portalSearch(session, f) {
  return withUser(session, async (c) => (await c.query(
    `select * from external_portal_search($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [f.q || '', f.source || '', f.provider || '', f.location || '', f.employmentType || '',
     f.experience ?? null, f.salaryMin ?? null, f.skills && f.skills.length ? f.skills : null,
     f.postedDays ?? null, f.maxAgeDays ?? null, f.sort || '', f.limit, f.offset])).rows);
}

export async function portalJob(session, id) {
  return withUser(session, async (c) => (await c.query(
    `select * from external_portal_job_v2($1)`, [id])).rows[0] || null);
}

export async function applyTarget(session, id) {
  return withUser(session, async (c) => (await c.query(
    `select * from external_portal_apply_target_v2($1)`, [id])).rows[0] || null);
}

export async function recordEvent(session, jobId, event, reason = '') {
  return withUser(session, (c) => c.query(
    `select external_job_event_add($1,$2,$3)`, [jobId || '', event, reason || '']));
}

/* ---- saved external jobs (candidate) ---------------------------------- */

export async function setSaved(session, jobId, saved) {
  return withUser(session, async (c) => (await c.query(
    `select external_saved_set($1,$2) as ok`, [jobId, saved === true])).rows[0]?.ok === true);
}

export async function listSaved(session) {
  return withUser(session, async (c) => (await c.query(
    `select x.external_job_id, x.created_at as saved_at, v.*
       from external_saved_jobs x
       cross join lateral external_portal_job_v2(x.external_job_id) v
      order by x.created_at desc`)).rows);
}

/* ---- the admin screens ----------------------------------------------- */

export async function listQuarantine(session, { sourceId = null, includeResolved = false, limit = 100 } = {}) {
  return withUser(session, async (c) => (await c.query(
    `select q.*, s.name as source_name from external_job_quarantine q
       join job_sources s on s.id = q.source_id
      where ($1::text is null or q.source_id = $1)
        and ($2 or q.resolved_at is null)
      order by q.last_seen_at desc, q.id desc limit $3`,
    [sourceId, includeResolved === true, Math.min(Number(limit) || 100, 500)])).rows);
}

export async function listUrlChanges(session, { jobId = null, limit = 100 } = {}) {
  return withUser(session, async (c) => (await c.query(
    `select u.*, j.title, j.external_job_id as source_job_id, s.name as source_name
       from external_job_url_changes u
       join external_jobs j on j.id = u.external_job_id
       join job_sources s on s.id = u.source_id
      where ($1::text is null or u.external_job_id = $1)
      order by u.detected_at desc, u.id desc limit $2`,
    [jobId, Math.min(Number(limit) || 100, 500)])).rows);
}

export async function listAudit(session, { entity = null, entityId = null, action = null, limit = 100, before = null } = {}) {
  return withUser(session, async (c) => (await c.query(
    `select * from external_audit_log
      where ($1::text is null or entity = $1)
        and ($2::text is null or entity_id = $2)
        and ($3::text is null or action like $3 || '%')
        and ($4::bigint is null or id < $4)
      order by id desc limit $5`,
    [entity, entityId, action, before, Math.min(Number(limit) || 100, 500)])).rows);
}

export async function adminJobs(session, { status = 'all', sourceId = null, q = '', limit = 50, offset = 0 } = {}) {
  return withUser(session, async (c) => {
    const params = [status === 'all' ? null : status, sourceId, q ? `%${String(q).toLowerCase()}%` : null,
      Math.min(Math.max(Number(limit) || 50, 1), 200), Math.max(Number(offset) || 0, 0)];
    const rows = (await c.query(
      `select j.id, j.source_id, j.external_job_id, j.title, j.company, j.location, j.application_url,
              j.status, j.admin_hold, j.synced_at, j.last_seen_at, j.posted_at, j.created_at, j.updated_at,
              j.duplicate_of, j.raw->>'board' as board, j.content_hash,
              s.name as source_name, s.provider, s.connector, s.active as source_active,
              s.last_sync_status, s.last_sync_at, s.health_status,
              count(*) over () as total
         from external_jobs j join job_sources s on s.id = j.source_id
        where ($1::text is null or j.status = $1)
          and ($2::text is null or j.source_id = $2)
          and ($3::text is null or lower(j.title) like $3 or lower(coalesce(j.company,'')) like $3
               or lower(j.external_job_id) like $3 or j.id = $3)
        order by j.updated_at desc, j.id
        limit $4 offset $5`, params)).rows;
    return { rows, total: rows.length ? Number(rows[0].total) : 0 };
  });
}

export async function jobsByIds(session, ids) {
  return withUser(session, async (c) => (await c.query(
    `select j.id, j.source_id, j.status, j.admin_hold, j.application_url, j.title,
            s.connector, s.provider, s.allowed_domains, s.active as source_active
       from external_jobs j join job_sources s on s.id = j.source_id
      where j.id = any($1)`, [ids])).rows);
}

/** One status change on one posting, as an administrator. */
export async function setJobStatus(session, id, { status, hold }) {
  return withUser(session, async (c) => (await c.query(
    `update external_jobs set status = $2, admin_hold = $3 where id = $1 returning id, status`,
    [id, status, hold])).rows[0] || null);
}

export async function analytics(session, { days = 30 } = {}) {
  return withUser(session, async (c) => (await c.query(
    `select e.event, e.source_id, s.name as source_name, e.reason, sum(e.n)::int as n
       from external_job_events e left join job_sources s on s.id = e.source_id
      where e.day >= current_date - $1::int
      group by 1, 2, 3, 4 order by 1, 3 nulls last, 4`,
    [Math.min(Math.max(Number(days) || 30, 1), 365)])).rows);
}

/** Raw provider payloads can be large; the quarantine keeps enough to diagnose. */
function trimRaw(raw) {
  try {
    const s = JSON.stringify(raw ?? {});
    if (s.length <= 8000) return raw ?? {};
    const o = {};
    for (const [k, v] of Object.entries(raw || {})) {
      o[k] = typeof v === 'string' ? v.slice(0, 600) : v;
    }
    const t = JSON.stringify(o);
    return t.length <= 8000 ? o : { truncated: true, keys: Object.keys(raw || {}).slice(0, 40) };
  } catch { return {}; }
}
