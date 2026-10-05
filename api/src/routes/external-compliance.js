/**
 * External jobs: licences, configuration, health, quarantine, URL changes,
 * the audit trail, admin bulk actions, analytics and saved jobs (0108).
 *
 * Mounted beside external-jobs.js and ONLY when EXTERNAL_JOBS_ENABLED is
 * true - with the flag off none of these paths exist.
 *
 * WHO MAY DO WHAT (the server decides; the screen only hides buttons)
 *
 *   read sources, health, quarantine, URL changes, providers, jobs, analytics
 *                                     recruiter, bde, admin
 *   licences, source configuration, disable, bulk actions, the audit trail
 *                                     admin
 *   saved external jobs               the candidate, for themselves only
 *
 * The definer functions behind the writes check app_is_admin() / the
 * candidate themselves too, so a route mistake cannot widen any of this.
 */
import { Router } from 'express';
import { z } from 'zod';
import { wrap, badRequest, forbidden, notFound, conflict } from '../errors.js';
import { requireAuth } from '../auth.js';
import { config } from '../config.js';
import * as store from '../external/store.js';
import * as cx from '../external/compliance-store.js';
import { bump, cached } from '../external/cache.js';
import { validateExternalUrl } from '../external/redirect.js';
import {
  sourcePolicy, hostAllowed, cleanDomains, providerCatalogue, PROVIDER_IDS,
} from '../external/source-config.js';
import { toSource, toLicence, toPortalJobV2, licenceRequirement } from '../external/shapes.js';
import { syncSource } from '../external/service.js';

const STAFF = ['recruiter', 'bde', 'admin'];
const iso = (v) => (v ? new Date(v).toISOString() : null);

function requireStaff(req) {
  if (!STAFF.includes(req.session.role)) throw forbidden('You do not have access to this.');
}
function requireAdmin(req, what = 'do this') {
  if (req.session.role !== 'admin') throw forbidden(`Only an administrator can ${what}.`);
}
function requireCandidate(req) {
  if (req.session.role !== 'candidate' || !req.session.profileId) {
    throw forbidden('Only a signed-in candidate can save jobs.');
  }
}
const parse = (schema, body) => {
  const out = schema.safeParse(body || {});
  if (out.success) return out.data;
  const details = {};
  for (const i of out.error.issues) details[i.path.join('.') || 'form'] = i.message;
  throw badRequest('Please check the highlighted fields and try again.', details);
};
const licenceError = (err) => {
  const m = /licence_required:\s*(.*)$/s.exec(String((err && err.message) || ''));
  return m ? conflict('LICENCE_REQUIRED', m[1]) : null;
};

/* Where a posting's company lives on its own board, when the board says. */
function sourceCompanyUrl(r) {
  const board = r.board || null;
  if (!board) return null;
  if (r.provider === 'greenhouse' || r.connector === 'greenhouse') return `https://boards.greenhouse.io/${encodeURIComponent(board)}`;
  if (r.provider === 'lever' || r.connector === 'lever') return `https://jobs.lever.co/${encodeURIComponent(board)}`;
  return null;
}

const toAdminJob = (r) => ({
  id: r.id,
  jobType: 'EXTERNAL',
  origin: 'EXTERNAL',
  source: String(r.provider || 'other').toUpperCase(),
  sourceId: r.source_id,
  sourceName: r.source_name,
  sourceJobId: r.external_job_id,
  title: r.title,
  company: r.company || null,
  location: r.location || null,
  originalJobUrl: r.application_url || null,
  sourceCompanyUrl: sourceCompanyUrl(r),
  postedAt: iso(r.posted_at),
  lastSyncedAt: iso(r.synced_at),
  lastSeenAt: iso(r.last_seen_at),
  syncStatus: r.source_active ? (r.last_sync_status || 'never synced') : 'source disabled',
  sourceHealth: r.health_status || 'unknown',
  status: r.status,
  active: r.status === 'open' && r.source_active === true && !r.duplicate_of,
  heldBy: r.admin_hold ? 'administrator' : null,
  duplicateOf: r.duplicate_of || null,
  contentHash: r.content_hash || null,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

export default function externalComplianceRoutes() {
  const r = Router();

  /* ---- providers: what exists, how it is collected, what it needs ----- */
  r.get('/external/providers', requireAuth(), wrap(async (req, res) => {
    requireStaff(req);
    const { value } = await cached('providers', 'static', async () => providerCatalogue());
    res.json({
      providers: value,
      note: 'Naukri, Indeed, Shine and LinkedIn publish no API for third parties to pull listings. '
        + 'They can only be switched on through a licensed partner or employer feed with a complete '
        + 'licence record. TeamLink never scrapes any site.',
    });
  }));

  /* ---- licences ------------------------------------------------------- */
  r.get('/external/sources/:id/licence', requireAuth(), wrap(async (req, res) => {
    requireStaff(req);
    const source = await store.getSource(req.session, req.params.id);
    if (!source) throw notFound('That source could not be found.');
    const p = sourcePolicy(source);
    res.json({
      licence: toLicence(await cx.getLicence(req.session, source.id)),
      licenceGap: await cx.licenceGap(req.session, source.id),
      requirement: licenceRequirement(p, source.job_collection_method),
      provider: { id: p.provider, label: p.label, kind: p.kind, mechanism: p.mechanism, termsUrl: p.termsUrl },
    });
  }));

  const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.').nullable().optional();
  const licenceSchema = z.object({
    collectionMethod: z.enum(['public_api', 'licensed_api', 'partner_feed', 'employer_feed', 'manual_entry']),
    licenceStatus: z.enum(['not_required', 'pending', 'active', 'expired', 'revoked']),
    consentStatus: z.enum(['not_required', 'pending', 'granted', 'withdrawn']),
    termsUrl: z.string().trim().max(500).regex(/^https?:\/\/\S+$/i, 'A terms URL starts with https://').nullable().optional()
      .or(z.literal('')),
    dataUsageAllowed: z.boolean(),
    applicationRedirectAllowed: z.boolean(),
    effectiveFrom: date,
    effectiveUntil: date,
    owner: z.string().trim().max(120).nullable().optional(),
    notes: z.string().trim().max(1000).nullable().optional(),
  }).refine((l) => !l.effectiveFrom || !l.effectiveUntil || l.effectiveUntil >= l.effectiveFrom,
    { message: 'The end date is before the start date.', path: ['effectiveUntil'] });

  r.put('/external/sources/:id/licence', requireAuth(), wrap(async (req, res) => {
    requireAdmin(req, 'record a licence');
    const l = parse(licenceSchema, req.body);
    const source = await store.getSource(req.session, req.params.id);
    if (!source) throw notFound('That source could not be found.');
    const saved = await cx.saveLicence(req.session, source.id, l);
    bump();
    res.json({ licence: toLicence(saved), licenceGap: await cx.licenceGap(req.session, source.id) });
  }));

  /* ---- per-source configuration ---------------------------------------- */
  r.put('/external/sources/:id/config', requireAuth(), wrap(async (req, res) => {
    requireAdmin(req, 'change a source');
    const b = parse(z.object({
      provider: z.string().trim().toLowerCase().refine((v) => PROVIDER_IDS.includes(v), 'Unknown provider.').optional(),
      allowedDomains: z.union([z.array(z.string().max(253)).max(30), z.string().max(2000)]).nullable().optional(),
      syncIntervalHours: z.number().int().min(1).max(720).nullable().optional(),
      rateLimitPerMinute: z.number().int().min(1).max(600).nullable().optional(),
      closeGraceDays: z.number().int().min(1).max(365).nullable().optional(),
      monthlyQuota: z.number().int().min(1).max(10_000_000).nullable().optional(),
    }), req.body);
    const source = await store.getSource(req.session, req.params.id);
    if (!source) throw notFound('That source could not be found.');
    let domains;
    try { domains = cleanDomains(b.allowedDomains); } catch (e) { throw badRequest(e.message); }
    let saved;
    try {
      saved = await cx.saveSourceConfig(req.session, source.id, {
        provider: b.provider || null,
        allowedDomains: b.allowedDomains === undefined ? source.allowed_domains : domains,
        syncIntervalHours: b.syncIntervalHours === undefined ? source.sync_interval_hours : b.syncIntervalHours,
        rateLimitPerMinute: b.rateLimitPerMinute === undefined ? source.rate_limit_per_minute : b.rateLimitPerMinute,
        closeGraceDays: b.closeGraceDays === undefined ? source.close_grace_days : b.closeGraceDays,
        monthlyQuota: b.monthlyQuota === undefined ? source.monthly_quota : b.monthlyQuota,
      });
    } catch (err) { throw licenceError(err) || err; }
    bump();
    res.json({ source: toSource(saved) });
  }));

  r.post('/external/sources/:id/disable', requireAuth(), wrap(async (req, res) => {
    requireAdmin(req, 'switch a source off');
    const b = parse(z.object({ reason: z.string().trim().min(3).max(300) }), req.body);
    const source = await store.getSource(req.session, req.params.id);
    if (!source) throw notFound('That source could not be found.');
    const changed = await cx.disableSource(req.session, source.id, b.reason);
    bump();
    res.json({ disabled: true, changed, source: toSource(await store.getSource(req.session, source.id)),
      note: 'Switched off. Its jobs and history are kept; they are no longer shown in the portal.' });
  }));

  /* ---- health ---------------------------------------------------------- */
  r.get('/external/health', requireAuth(), wrap(async (req, res) => {
    requireStaff(req);
    const rows = await store.listSources(req.session);
    const out = [];
    for (const row of rows) {
      const s = toSource(row);
      out.push({
        id: s.id, name: s.name, provider: s.provider, active: s.active, disabledReason: s.disabledReason,
        lastSyncStatus: s.lastSyncStatus, lastSyncError: s.lastSyncError, ...s.health,
        licenceGap: await cx.licenceGap(req.session, row.id),
      });
    }
    res.json({
      unhealthyAfter: config.externalJobs.unhealthyAfter,
      backoffBaseHours: config.externalJobs.backoffBaseHours,
      backoffMaxHours: config.externalJobs.backoffMaxHours,
      syncEveryHours: config.externalJobs.syncEveryHours,
      closeGraceDays: config.externalJobs.closeGraceDays,
      sources: out,
    });
  }));

  /* ---- quarantine and URL changes --------------------------------------- */
  r.get('/external/quarantine', requireAuth(), wrap(async (req, res) => {
    requireStaff(req);
    const rows = await cx.listQuarantine(req.session, {
      sourceId: String(req.query.sourceId || '').trim() || null,
      includeResolved: String(req.query.all || '') === 'true',
      limit: req.query.limit,
    });
    res.json({
      items: rows.map((q) => ({
        id: Number(q.id), sourceId: q.source_id, sourceName: q.source_name, sourceJobId: q.external_job_id,
        title: q.title, company: q.company, originalJobUrl: q.application_url, reasons: q.reasons,
        action: q.action, firstSeenAt: iso(q.first_seen_at), lastSeenAt: iso(q.last_seen_at),
        timesSeen: q.times_seen, resolvedAt: iso(q.resolved_at),
      })),
    });
  }));

  r.get('/external/url-changes', requireAuth(), wrap(async (req, res) => {
    requireStaff(req);
    const rows = await cx.listUrlChanges(req.session, {
      jobId: String(req.query.jobId || '').trim() || null, limit: req.query.limit,
    });
    res.json({
      changes: rows.map((u) => ({
        id: Number(u.id), jobId: u.external_job_id, sourceId: u.source_id, sourceName: u.source_name,
        sourceJobId: u.source_job_id, title: u.title, oldUrl: u.old_url, newUrl: u.new_url,
        detectedAt: iso(u.detected_at), newUrlValid: u.new_url_valid, validationReason: u.validation_reason,
        applied: u.applied,
      })),
    });
  }));

  /* ---- the audit trail -------------------------------------------------- */
  r.get('/external/audit', requireAuth(), wrap(async (req, res) => {
    requireAdmin(req, 'read the audit trail');
    const rows = await cx.listAudit(req.session, {
      entity: String(req.query.entity || '').trim() || null,
      entityId: String(req.query.entityId || '').trim() || null,
      action: String(req.query.action || '').trim() || null,
      before: req.query.before ? Number(req.query.before) : null,
      limit: req.query.limit,
    });
    res.json({
      entries: rows.map((a) => ({
        id: Number(a.id), at: iso(a.at), actor: a.actor_id || null, actorRole: a.actor_role,
        action: a.action, entity: a.entity, entityId: a.entity_id,
        oldValue: a.old_value, newValue: a.new_value, reason: a.reason,
      })),
    });
  }));

  /* ---- admin visibility of every external job --------------------------- */
  r.get('/external/admin/jobs', requireAuth(), wrap(async (req, res) => {
    requireStaff(req);
    const status = String(req.query.status || 'all');
    if (!['all', 'open', 'closed', 'expired', 'removed', 'archived'].includes(status)) {
      throw badRequest('Unknown status.');
    }
    const out = await cx.adminJobs(req.session, {
      status, sourceId: String(req.query.sourceId || '').trim() || null,
      q: String(req.query.q || '').trim().slice(0, 120),
      limit: req.query.limit, offset: req.query.offset,
    });
    res.json({ jobs: out.rows.map(toAdminJob), total: out.total });
  }));

  /*
   * POST /api/external/admin/jobs/bulk
   *
   * { action, ids, reason?, confirm: true }
   *
   *   activate    reopen - only if its source is on and licensed and its
   *               stored link passes the redirect check
   *   deactivate  hide it (status removed), reversible
   *   close       the posting has closed
   *   archive     out of every list, kept for the record
   *   refresh     re-sync the sources these postings came from (≤ 5)
   *
   * An administrator's close / deactivate / archive HOLDS: a later sync
   * cannot reopen it (0108's admin_hold). Every row's own change is in the
   * audit trail, plus one line for the bulk action with its counts.
   */
  const ACTIONS = { activate: 'open', deactivate: 'removed', close: 'closed', archive: 'archived', refresh: null };
  r.post('/external/admin/jobs/bulk', requireAuth(), wrap(async (req, res) => {
    requireAdmin(req, 'change external jobs in bulk');
    const b = parse(z.object({
      action: z.enum(Object.keys(ACTIONS)),
      ids: z.array(z.string().trim().min(1).max(80)).min(1).max(500),
      reason: z.string().trim().max(300).optional(),
      confirm: z.literal(true, { errorMap: () => ({ message: 'Confirm the bulk action.' }) }),
    }), req.body);
    const ids = [...new Set(b.ids)];
    const rows = new Map((await cx.jobsByIds(req.session, ids)).map((j) => [j.id, j]));
    const results = [];
    const fail = (id, reason) => results.push({ id, ok: false, reason });

    if (b.action === 'refresh') {
      const bySource = new Map();
      for (const id of ids) {
        const j = rows.get(id);
        if (!j) { fail(id, 'not found'); continue; }
        if (!bySource.has(j.source_id)) bySource.set(j.source_id, []);
        bySource.get(j.source_id).push(id);
      }
      if (bySource.size > 5) throw badRequest('Refresh at most 5 sources at once.');
      for (const [sourceId, list] of bySource) {
        const out = await syncSource(req.session, sourceId);
        for (const id of list) {
          if (out.ok) results.push({ id, ok: true, status: out.status });
          else fail(id, `sync ${out.status}: ${out.error || ''}`.trim());
        }
      }
    } else {
      const target = ACTIONS[b.action];
      const gaps = new Map();
      for (const id of ids) {
        const j = rows.get(id);
        if (!j) { fail(id, 'not found'); continue; }
        if (b.action === 'activate') {
          if (!j.source_active) { fail(id, 'its source is switched off'); continue; }
          if (!gaps.has(j.source_id)) gaps.set(j.source_id, await cx.licenceGap(req.session, j.source_id));
          if (gaps.get(j.source_id)) { fail(id, gaps.get(j.source_id)); continue; }
          const v = validateExternalUrl(j.application_url, j.connector || j.source_id);
          if (!v.ok) { fail(id, `its link cannot be followed: ${v.reason}`); continue; }
          const p = sourcePolicy({ provider: j.provider, connector: j.connector, allowed_domains: j.allowed_domains });
          if (!hostAllowed(v.url, p.allowedDomains)) { fail(id, 'its link is not on an allowed domain'); continue; }
          if (j.status === 'open' && !j.admin_hold) { results.push({ id, ok: true, status: 'open', unchanged: true }); continue; }
          await cx.setJobStatus(req.session, id, { status: 'open', hold: null });
          results.push({ id, ok: true, status: 'open' });
        } else {
          if (j.status === target && j.admin_hold === target) {
            results.push({ id, ok: true, status: target, unchanged: true }); continue;
          }
          const done = await cx.setJobStatus(req.session, id, { status: target, hold: target });
          if (done) results.push({ id, ok: true, status: done.status });
          else fail(id, 'not changed');
        }
      }
    }

    const succeeded = results.filter((x) => x.ok).length;
    const failed = results.length - succeeded;
    await cx.audit(req.session, {
      action: `bulk.${b.action}`, entity: 'external_job', entityId: null,
      newValue: { requested: ids.length, succeeded, failed, ids: ids.slice(0, 100) },
      reason: b.reason || null,
    });
    bump();
    res.json({ action: b.action, requested: ids.length, succeeded, failed, results });
  }));

  /* ---- analytics: the four external events, never an application -------- */
  r.get('/external/analytics', requireAuth(), wrap(async (req, res) => {
    requireStaff(req);
    const rows = await cx.analytics(req.session, { days: req.query.days });
    const totals = { external_job_view: 0, external_apply_click: 0, external_redirect_success: 0, external_redirect_failure: 0 };
    for (const x of rows) totals[x.event] += x.n;
    res.json({
      days: Math.min(Math.max(Number(req.query.days) || 30, 1), 365),
      totals,
      rows: rows.map((x) => ({ event: x.event, sourceId: x.source_id, sourceName: x.source_name,
        reason: x.reason || null, count: x.n })),
      note: 'Counts only - no candidate is identified. An external click is never a TeamLink application.',
    });
  }));

  /* ---- a candidate's saved external jobs --------------------------------- */
  r.get('/external/saved', requireAuth(), wrap(async (req, res) => {
    requireCandidate(req);
    const rows = await cx.listSaved(req.session);
    res.json({
      saved: rows.map((x) => ({
        savedAt: iso(x.saved_at),
        /* A closed posting stays in the list and says so - it is never
           silently dropped. */
        available: x.status === 'open',
        job: toPortalJobV2(x, config.externalJobs.activeDays),
      })),
    });
  }));

  r.put('/external/saved/:id', requireAuth(), wrap(async (req, res) => {
    requireCandidate(req);
    const ok = await cx.setSaved(req.session, String(req.params.id).slice(0, 80), true);
    if (!ok) throw notFound('This job is no longer available.');
    res.json({ saved: true });
  }));

  r.delete('/external/saved/:id', requireAuth(), wrap(async (req, res) => {
    requireCandidate(req);
    await cx.setSaved(req.session, String(req.params.id).slice(0, 80), false);
    res.json({ saved: false });
  }));

  return r;
}
