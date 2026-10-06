/**
 * The external-job endpoints.
 *
 * MOUNTED ONLY WHEN `EXTERNAL_JOBS_ENABLED` IS TRUE. With the flag off,
 * `app.js` never calls this factory, so none of these paths exist and the
 * API surface is exactly what it was before the feature was written. That
 * is the isolation: not a check inside each handler, but an absence.
 *
 * Everything here is additive. No existing route is redefined, no
 * existing path is shadowed - every one of them sits under `/external/`.
 *
 * WHO MAY DO WHAT
 *
 *   sources        recruiter, bde, admin can read; admin can change
 *   jobs           any signed-in user can read; recruiter/admin can add
 *   matching       a candidate may match themselves; recruiter/admin anyone
 *   applying       a candidate may apply for themselves; recruiter/admin
 *                  may put a candidate forward
 *   applications   a candidate sees their own; recruiter/bde/admin see all
 *
 * The RLS policies in 0049 are the real boundary; these checks exist to
 * return a clean 403 rather than an empty list.
 */
import { Router } from 'express';
import { z } from 'zod';
import { wrap, badRequest, forbidden, notFound, conflict } from '../errors.js';
import { requireAuth } from '../auth.js';
import { config } from '../config.js';
import { withUser } from '../db.js';
import { validateExternalUrl } from '../external/redirect.js';
import * as store from '../external/store.js';
import { toSource, toExternalJob, toMatch, toExternalApplication } from '../external/shapes.js';
import { normaliseExternalJob } from '../external/normalise.js';
import { syncSource, applyExternally, refreshApplicationStatus }
  from '../external/service.js';
/* 0108 */
import * as cx from '../external/compliance-store.js';
import { cached, bump } from '../external/cache.js';
import { sourcePolicy, hostAllowed, PROVIDER_IDS } from '../external/source-config.js';
import { redirectRefused } from '../external/health.js';
import { checkLink } from '../external/link.js';
import { withUrlKey } from '../external/service.js';
import { toLicence, licenceRequirement, toPortalJob, toPortalJobV2 } from '../external/shapes.js';
/* 0113: the External Jobs page's endpoints are EXTERNAL only (external_jobs). */
import { externalPageScope, matchJobs, EXTERNAL } from '../jobs/source-scope.js';
/* 0115: is the posting still there? */
import { checkAvailability, availabilityAnswer } from '../external/availability.js';

const STAFF = ['recruiter', 'bde', 'admin'];

/** Whose records is this request about, and may it be? */
function subjectCandidate(req, bodyOrQueryId) {
  const { role, profileId } = req.session;
  if (role === 'candidate') {
    /* A candidate may only ever act on themselves, whatever they ask for. */
    if (bodyOrQueryId && bodyOrQueryId !== profileId) {
      throw forbidden('You can only do this for your own profile.');
    }
    return profileId;
  }
  if (!STAFF.includes(role)) throw forbidden('You do not have access to this.');
  if (!bodyOrQueryId) return null;                 // staff, all candidates
  return bodyOrQueryId;
}

const parse = (schema, body) => {
  const out = schema.safeParse(body || {});
  if (out.success) return out.data;
  const details = {};
  for (const i of out.error.issues) details[i.path.join('.') || 'form'] = i.message;
  throw badRequest('Please check the highlighted fields and try again.', details);
};

function requireStaff(req) {
  if (!STAFF.includes(req.session.role)) throw forbidden('You do not have access to this.');
}

function requireAdmin(req) {
  if (req.session.role !== 'admin') {
    throw forbidden('Only an administrator can change a job source.');
  }
}

export default function externalJobRoutes() {
  const r = Router();

  /**
   * GET /api/external/config
   *
   * What the browser layer asks before it adds anything to the interface.
   * Reports the switches, never a credential.
   */
  /* ================================================================ *
   * THE JOB PORTAL'S VIEW OF EXTERNAL JOBS
   *
   * External jobs appear in the ordinary TeamLink job portal - the
   * candidate search and the public job board - next to TeamLink's own.
   * These three routes are what the portal reads. No sign-in is needed:
   * the public job board is where candidates look first.
   *
   * Applying is NOT a TeamLink application. The apply route sends the
   * candidate to the original job page and records nothing in
   * `applications`; a signed-in candidate's click is tracked separately
   * (POST /external/apply -> external_applications, status "Clicked"),
   * which is a different record with a different meaning.
   * ================================================================ */
  const PORTAL = { userId: '', role: 'anon', profileId: null };
  /* The portal shapes live in external/shapes.js (toPortalJob, unchanged
     since 0088, and toPortalJobV2, which adds 0108's keys beside it). */
  const portalJob = toPortalJob;
  const portalJobV2 = (row) => toPortalJobV2(row, config.externalJobs.activeDays);
  const event = (id, name, reason) => cx.recordEvent(PORTAL, id, name, reason)
    .catch((e) => console.error('[external] event not recorded:', e.message));

  /*
   * GET /api/portal/external-jobs
   *
   * Search, filters and pagination, all in the database (0108's
   * external_portal_search) - never a call to a provider. With no filter
   * and no sort the order is exactly what it always was (newest first);
   * `sort=relevance` (the default when there is a query) ranks by the
   * deterministic score documented in 0108.
   *
   *   q             comma-separated terms: title, company, location,
   *                 skills, description
   *   source        a source id          provider   naukri, greenhouse, …
   *   location      a place (remote postings match every place)
   *   employmentType, experience (years), salaryMin (₹/yr), skills (a,b),
   *   postedWithinDays, sort (relevance|posted), limit (≤500), offset
   */
  const num = (v) => (v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  r.get('/portal/external-jobs', wrap(async (req, res) => {
    externalPageScope(req);
    const q = String(req.query.q || '').slice(0, 120);
    const f = {
      q,
      source: String(req.query.source || '').slice(0, 60),
      provider: String(req.query.provider || '').slice(0, 20).toLowerCase(),
      location: String(req.query.location || '').slice(0, 80),
      employmentType: String(req.query.employmentType || '').slice(0, 40),
      experience: num(req.query.experience),
      salaryMin: num(req.query.salaryMin),
      skills: String(req.query.skills || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 10),
      postedDays: num(req.query.postedWithinDays) == null ? null : Math.max(1, Math.min(365, num(req.query.postedWithinDays))),
      maxAgeDays: config.externalJobs.maxAgeDays,
      sort: req.query.sort === 'posted' ? '' : (req.query.sort === 'relevance' || q.trim() ? 'relevance' : ''),
      limit: Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500),
      offset: Math.max(parseInt(req.query.offset, 10) || 0, 0),
    };
    const version = await cx.portalVersion(PORTAL);
    const { value: rows, hit } = await cached(`list:${JSON.stringify(f)}`, version, () => cx.portalSearch(PORTAL, f));
    res.set('X-Cache', hit ? 'hit' : 'miss');
    res.json({
      jobs: rows.map(portalJobV2),
      total: rows.length ? Number(rows[0].total) : 0,
      limit: f.limit,
      offset: f.offset,
      sort: f.sort || 'posted',
    });
  }));

  r.get('/portal/external-jobs/:id', wrap(async (req, res) => {
    externalPageScope(req);
    const id = String(req.params.id).slice(0, 80);
    const version = await cx.portalVersion(PORTAL);
    const { value: row } = await cached(`job:${id}`, version, () => cx.portalJob(PORTAL, id));
    if (!row) throw notFound('This job is no longer available.');
    /* external_job_view: a count per job per day, nothing about who. */
    await event(id, 'external_job_view');
    res.json({ job: portalJobV2(row) });
  }));

  /** A small page for when there is nowhere to send the candidate. */
  const sorry = (res, code, title, line) => res.status(code).type('html').send(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · TeamLink</title>
<style>body{margin:0;background:#f4f7fb;font:15px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#16202c}
main{max-width:480px;margin:12vh auto;padding:28px 26px;background:#fff;border:1px solid #e6ebf2;border-radius:14px}
h1{font-size:19px;margin:0 0 8px}p{margin:0 0 14px;color:#42505f}a{color:#1d6ff2;font-weight:700}</style></head>
<body><main><h1>${title}</h1><p>${line}</p><p><a href="/#/jobs">Back to TeamLink jobs</a></p></main></body></html>`);

  /*
   * GET /api/portal/external-jobs/:id/apply
   *
   * The destination comes from the database by job id - never from the
   * request - and is validated before it goes in a Location header.
   */
  /*
   * The one decision about whether a stored URL may be followed, shared by
   * the public redirect and the signed-in tracked flow: the general rules
   * (redirect.js, unchanged) and then the source's allowed domains
   * (source-config.js; null for Greenhouse and other employer-site boards,
   * so their behaviour is unchanged).
   */
  const destination = (t) => checkLink(t.application_url, { provider: t.provider, connector: t.connector,
    sourceId: t.source_key, allowedDomains: t.allowed_domains });

  /*
   * POST /api/portal/external-jobs/:id/click
   *
   * Apply Now on an external job opens the stored original URL straight
   * from the page (no TeamLink URL in between). This only COUNTS it - an
   * "Apply Clicked" per job per day, nobody identified - for a visitor who
   * is not signed in. A signed-in candidate's click goes to POST
   * /external/apply, which records it against them as "Apply Clicked".
   * Neither ever creates an application.
   */
  r.post('/portal/external-jobs/:id/click', wrap(async (req, res) => {
    const id = String(req.params.id).slice(0, 80);
    const t = await cx.applyTarget(PORTAL, id);
    await event(id, 'external_apply_click');
    if (!t || t.status !== 'open') {
      await event(id, 'external_redirect_failure', t ? 'closed' : 'not_found');
      return res.json({ recorded: true, status: 'Apply Clicked', applyLink: 'job_unavailable' });
    }
    const d = destination(t);
    if (!d.ok) {
      await event(id, 'external_redirect_failure', d.code);
      return res.json({ recorded: true, status: 'Apply Clicked', applyLink: 'link_unavailable' });
    }
    /* 0115: a posting its source has taken down is not "available". The
       answer is cached, so the page's own availability check a moment ago
       makes this free. */
    const a = await checkAvailability(PORTAL, id);
    if (a.state === 'removed' || a.state === 'closed') {
      await event(id, 'external_redirect_failure', 'removed_at_source');
      return res.json({ recorded: true, status: 'Apply Clicked', applyLink: 'job_unavailable' });
    }
    await event(id, 'external_redirect_success');
    res.json({ recorded: true, status: 'Apply Clicked', applyLink: 'available' });
  }));

  /*
   * GET /api/portal/external-jobs/:id/availability   (0115)
   *
   * What Apply Now asks BEFORE it sends anybody anywhere: is the posting
   * still there at its source? The answer is the stored original URL
   * (already through the one link rule), or "Job no longer available" -
   * in which case the posting has just been closed, on the source's own
   * word, and no URL is handed out. A check that cannot reach the source
   * says so (checked: 'unconfirmed') and still hands out the URL: our
   * network is never held against the job.
   *
   * Records nothing about the visitor and counts nothing: the click is
   * counted by /click or /external/apply, as before.
   */
  r.get('/portal/external-jobs/:id/availability', wrap(async (req, res) => {
    const id = String(req.params.id).slice(0, 80);
    const a = await checkAvailability(PORTAL, id);
    if (a.state === 'link_unavailable' && a.target) {
      console.warn(`[external] availability: link refused for ${id} (${a.target.source_key}): ${a.reason}`);
    }
    res.set('Cache-Control', 'no-store');
    res.status(a.state === 'not_found' ? 404 : 200).json({ id, ...availabilityAnswer(a) });
  }));

  r.get('/portal/external-jobs/:id/apply', wrap(async (req, res) => {
    const id = String(req.params.id).slice(0, 80);
    /* The destination is the stored URL, ALWAYS. A ?url= (or anything
       else) in the request is never read. */
    await event(id, 'external_apply_click');
    const t = await cx.applyTarget(PORTAL, id);
    if (!t) {
      await event(id, 'external_redirect_failure', 'not_found');
      return sorry(res, 404, 'This job is no longer available', 'We could not find that job.');
    }
    if (t.source_active === false) {
      await event(id, 'external_redirect_failure', 'source_unavailable');
      return sorry(res, 410, 'Source unavailable',
        `${t.source_name || 'The website this job came from'} is not available through TeamLink at the moment, so there is nowhere to apply. This job is no longer available here.`);
    }
    if (t.status !== 'open') {
      await event(id, 'external_redirect_failure', 'closed');
      return sorry(res, 410, 'This job is no longer available',
        `The original posting on ${t.source_name || 'its website'} has closed, so there is nowhere to apply.`);
    }
    const d = destination(t);
    if (!d.ok) {
      console.warn(`[external] redirect refused for ${id} (${t.source_key}): ${d.reason}`);
      await event(id, 'external_redirect_failure', d.code);
      await redirectRefused(PORTAL, t, d.reason);
      return sorry(res, 422, 'Redirect unavailable',
        'The link we have for it does not look safe to follow, so we have not sent you there. The job has been reported.');
    }
    /* 0115: confirmed removed at its source -> no redirect to a dead page. */
    const a = await checkAvailability(PORTAL, id);
    if (a.state === 'removed' || a.state === 'closed') {
      await event(id, 'external_redirect_failure', 'removed_at_source');
      return sorry(res, 410, 'This job is no longer available',
        `The original posting on ${t.source_name || 'its website'} has been taken down, so there is nowhere to apply.`);
    }
    await event(id, 'external_redirect_success');
    res.set('Referrer-Policy', 'no-referrer');
    return res.redirect(302, d.url);
  }));

  /* The Job Sources screen: what each sync did. */
  r.get('/external/sync-runs', requireAuth(), wrap(async (req, res) => {
    if (!STAFF.includes(req.session.role)) throw forbidden();
    const rows = await withUser(req.session, async (c) => (await c.query(
      `select r.*, s.name as source_name from external_sync_runs r
         left join job_sources s on s.id = r.source_id
        order by r.started_at desc limit 50`)).rows);
    res.json({ runs: rows.map((x) => ({
      id: Number(x.id), source: x.source_id, sourceName: x.source_name || (x.kind === 'expire' ? 'All sources' : ''),
      kind: x.kind, status: x.status,
      startedAt: x.started_at, completedAt: x.completed_at,
      fetched: x.fetched, created: x.created, updated: x.updated, closed: x.closed,
      duplicates: x.duplicates, skipped: x.skipped, error: x.error || null,
    })) });
  }));

  r.get('/external/config', requireAuth(), wrap(async (_req, res) => {
    res.json({
      enabled: true,                                // it is mounted, so it is
      autoApplyEnabled: config.externalJobs.autoApplyEnabled,
      autoApplyThreshold: config.externalJobs.autoApplyThreshold,
    });
  }));

  r.get('/external/statuses', requireAuth(), wrap(async (req, res) => {
    res.json({ statuses: await store.listStatuses(req.session) });
  }));

  r.get('/external/summary', requireAuth(), wrap(async (req, res) => {
    requireStaff(req);
    const c = await store.counts(req.session);
    res.json({
      sources: Number(c.sources), activeSources: Number(c.active_sources),
      openJobs: Number(c.open_jobs), duplicates: Number(c.duplicates),
      matches: Number(c.matches), applications: Number(c.applications),
    });
  }));

  /* ---- sources --------------------------------------------------- */

  r.get('/external/sources', requireAuth(), wrap(async (req, res) => {
    requireStaff(req);
    const rows = await store.listSources(req.session);
    /* 0108: each source with its licence, whether it may be switched on,
       and the configuration it is judged by (no secret in any of it). */
    const licences = new Map((await cx.listLicences(req.session)).map((l) => [l.source_id, l]));
    const out = [];
    for (const row of rows) {
      const gap = await cx.licenceGap(req.session, row.id);
      const p = sourcePolicy(row);
      out.push({
        ...toSource(row),
        licence: toLicence(licences.get(row.id)),
        licenceGap: gap,
        licenceRequired: licenceRequirement(p, row.job_collection_method),
        policy: {
          provider: p.provider, label: p.label, kind: p.kind, mechanism: p.mechanism, termsUrl: p.termsUrl,
          preserveBehaviour: p.preserve, allowedDomains: p.allowedDomains, allowedDomainsSource: p.allowedDomainsSource,
          syncIntervalHours: p.syncIntervalHours, rateLimitPerMinute: p.rateLimitPerMinute,
          closeGraceDays: p.closeGraceDays, monthlyQuota: p.monthlyQuota,
          credentialsReference: p.credentialsReference, credentialsConfigured: p.credentialsConfigured,
          enabledFeatures: p.enabledFeatures,
        },
      });
    }
    res.json({ sources: out });
  }));

  const sourceSchema = z.object({
    id: z.string().trim().max(64).optional(),
    name: z.string().trim().min(2).max(120),
    sourceType: z.enum(['job_board', 'company_site', 'partner_api', 'referral', 'manual'])
      .optional(),
    collectionMethod: z.enum(['manual', 'feed', 'api', 'connector']).optional(),
    /* Which adapter in external/connectors.js collects for this source.
       Checked against the registry below, so a typo is refused here
       rather than failing silently on the first sync. */
    connector: z.string().trim().max(40).optional(),
    applicationMethod: z.enum(['none', 'redirect', 'email', 'api']).optional(),
    autoApplySupported: z.boolean().optional(),
    active: z.boolean().optional(),
    feedUrl: z.string().trim().max(2000).optional(),
    /* The NAME of an environment variable, never a key. A value that
       looks like a secret is refused outright, because the most likely
       reason somebody pastes one here is that they think this is where it
       goes. */
    credentialEnv: z.string().trim().regex(/^[A-Z][A-Z0-9_]{2,60}$/,
      'Give the NAME of the environment variable holding the key, not the key itself.')
      .optional(),
    /* 0108: which board this source IS (naukri, greenhouse, …, other).
       Inferred from the connector, feed URL or name when not given. */
    provider: z.string().trim().toLowerCase().refine((v) => PROVIDER_IDS.includes(v),
      'Unknown provider.').optional(),
  });

  /* The database's activation guard (0108) speaks in one exception. */
  const licenceError = (err) => {
    const m = /licence_required:\s*(.*)$/s.exec(String(err && err.message || ''));
    if (!m) return null;
    return conflict('LICENCE_REQUIRED', m[1]);
  };

  /**
   * GET /api/external/connectors
   *
   * What the admin screen offers when adding a source, and why each one
   * is or is not usable.
   *
   * IT NAMES THE MISSING KEY. "Not configured" on its own sends somebody
   * hunting through a settings screen that has nothing in it; saying
   * "ADZUNA_APP_ID and ADZUNA_APP_KEY are not set" tells them exactly
   * what to put in the environment. The VALUES are never read or
   * returned - only whether each name has something behind it.
   */
  /* ---- career boards --------------------------------------------- *
   *
   * Which companies' public Greenhouse and Lever boards to read. This is
   * the answer to "how do we get real jobs with no API keys": those two
   * publish every company's board openly, so a recruiter naming real
   * companies is the whole configuration.
   *
   * NOTHING IS SEEDED. There is no starter list in the code; a board
   * exists because somebody added it, and can be removed the same way.
   * ---------------------------------------------------------------- */

  r.get('/external/career-boards', requireAuth(), wrap(async (req, res) => {
    requireStaff(req);
    const rows = await store.listCareerBoards(req.session, { activeOnly: false });
    res.json({
      boards: rows.map((b) => ({
        id: b.id, name: b.name, platform: b.platform,
        boardToken: b.board_token, active: b.active === true,
      })),
    });
  }));

  /**
   * POST /api/external/career-boards
   *
   * THE TOKEN IS CHECKED BEFORE IT IS SAVED. A board token that does not
   * exist produces a source that fails silently on every sync, and the
   * admin screen fills up with red rows nobody can explain. One call to
   * the public endpoint answers it now, while the person who typed it is
   * still looking at the screen.
   */
  r.post('/external/career-boards', requireAuth(), wrap(async (req, res) => {
    requireAdmin(req);
    const b = parse(z.object({
      id: z.string().trim().max(64).optional(),
      name: z.string().trim().min(1).max(120),
      platform: z.enum(['greenhouse', 'lever']),
      boardToken: z.string().trim().min(1).max(120),
      active: z.boolean().optional(),
      /* Skipping the check is allowed but must be asked for, so the
         default is the safe one. */
      skipVerify: z.boolean().optional(),
    }), req.body);

    if (b.skipVerify !== true) {
      const { connectorFor } = await import('../external/connectors.js');
      const c = connectorFor(b.platform);
      const probe = await c.fetchJobs({
        boards: [{ platform: b.platform, board_token: b.boardToken, active: true }],
      });
      if (probe.status !== 'ok') {
        throw badRequest(`That board could not be read: ${probe.error || probe.status}. `
          + 'Check the token on the company’s careers page.');
      }
    }

    const saved = await store.saveCareerBoard(req.session, b);
    res.json({
      board: {
        id: saved.id, name: saved.name, platform: saved.platform,
        boardToken: saved.board_token, active: saved.active === true,
      },
    });
  }));

  r.delete('/external/career-boards/:id', requireAuth(), wrap(async (req, res) => {
    requireAdmin(req);
    res.json({ removed: await store.removeCareerBoard(req.session, req.params.id) });
  }));

  /**
   * POST /api/external/cleanup-country
   *
   * Close the postings already stored that the country rule would now
   * refuse. The filter runs at ingestion, so it protects what arrives
   * from now on and does nothing about a pool collected before it
   * existed. Closed, never deleted - a candidate may have applied to one.
   */
  r.post('/external/cleanup-country', requireAuth(), wrap(async (req, res) => {
    requireAdmin(req);
    const { closeJobsOutsideCountry } = await import('../external/service.js');
    const out = await closeJobsOutsideCountry(req.session);
    res.json({ ...out, country: config.externalJobs.countryFilter });
  }));

  r.get('/external/connectors', requireAuth(), wrap(async (req, res) => {
    requireStaff(req);
    const { connectorStatus } = await import('../external/connectors.js');
    res.json({ connectors: connectorStatus() });
  }));

  r.post('/external/sources', requireAuth(), wrap(async (req, res) => {
    requireAdmin(req);
    const out = sourceSchema.safeParse(req.body || {});
    if (!out.success) {
      throw badRequest('Please check the source details.', {
        fields: out.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const input = out.data;
    /*
     * A connector source's Feed URL is not a URL.
     *
     * For Greenhouse and Lever the field holds a comma-separated list of
     * company board tokens, which is what makes adding a company a row
     * edit rather than a deployment. So the http:// check applies to the
     * methods where the field really is a URL.
     */
    if (input.collectionMethod !== 'connector'
        && input.feedUrl && !/^https?:\/\//i.test(input.feedUrl)) {
      throw badRequest('A feed URL must start with http:// or https://');
    }
    if (input.collectionMethod === 'connector') {
      if (!input.connector) {
        throw badRequest('Say which connector collects for this source.');
      }
      const { connectorFor } = await import('../external/connectors.js');
      if (!connectorFor(input.connector)) {
        throw badRequest(`There is no connector named "${input.connector}".`);
      }
    }
    /*
     * AUTO-APPLY IS A CLAIM ABOUT PERMISSION, not a capability toggle.
     * Refusing it for a source that cannot submit anything keeps the flag
     * from meaning "try harder".
     */
    if (input.autoApplySupported
        && !['api', 'email'].includes(input.applicationMethod || 'redirect')) {
      throw badRequest(
        'Automatic applications need an application method of "api" or "email". '
        + 'A redirect is completed by the candidate, so it cannot be automated.');
    }
    let saved;
    try {
      saved = await store.saveSource(req.session, input);
      /* The provider is set apart from 0063's signature; the guard reads
         it on the same row, so an explicit provider is written first when
         the source is being created inactive or already exists. */
      if (input.provider && saved && saved.provider !== input.provider) {
        saved = await cx.saveSourceConfig(req.session, saved.id, {
          provider: input.provider, allowedDomains: saved.allowed_domains,
          syncIntervalHours: saved.sync_interval_hours, rateLimitPerMinute: saved.rate_limit_per_minute,
          closeGraceDays: saved.close_grace_days, monthlyQuota: saved.monthly_quota,
        });
      }
    } catch (err) {
      throw licenceError(err) || err;
    }
    bump();
    res.json({ source: toSource(saved), licenceGap: await cx.licenceGap(req.session, saved.id) });
  }));

  /**
   * DELETE /api/external/sources/:id
   *
   * Removes the source and everything collected through it. Reports what
   * went, because a recruiter about to do this should be told how much
   * external history it takes with it.
   */
  r.delete('/external/sources/:id', requireAuth(), wrap(async (req, res) => {
    requireAdmin(req);
    const source = await store.getSource(req.session, req.params.id);
    if (!source) throw notFound('That source could not be found.');
    const removed = await store.deleteSource(req.session, req.params.id);
    res.json({ removed: true, source: source.name, ...removed });
  }));

  r.delete('/external/jobs/:id', requireAuth(), wrap(async (req, res) => {
    requireStaff(req);
    const gone = await store.deleteJob(req.session, req.params.id);
    if (!gone) throw notFound('That external job could not be found.');
    res.json({ removed: true });
  }));

  r.post('/external/sources/:id/sync', requireAuth(), wrap(async (req, res) => {
    requireStaff(req);
    const out = await syncSource(req.session, req.params.id);
    if (out.status === 'not_found') throw notFound('That source could not be found.');
    res.json(out);
  }));

  /* ---- jobs ------------------------------------------------------ */

  r.get('/external/jobs', requireAuth(), wrap(async (req, res) => {
    const rows = await store.listJobs(req.session, {
      limit: req.query.limit, offset: req.query.offset,
      sourceId: req.query.sourceId || null,
      search: req.query.q || '',
      /* A recruiter auditing coverage can ask for the duplicates too. */
      canonicalOnly: String(req.query.all || '') !== 'true',
    });
    res.json({ jobs: rows.map(toExternalJob) });
  }));

  r.get('/external/jobs/:id', requireAuth(), wrap(async (req, res) => {
    const row = await store.getJob(req.session, req.params.id);
    if (!row) throw notFound('That external job could not be found.');
    res.json({ job: toExternalJob(row) });
  }));

  /**
   * POST /api/external/jobs
   *
   * For a `manual` source: a recruiter entering or pasting in vacancies
   * they were sent. Accepts one posting or a list, because the realistic
   * case is a spreadsheet's worth at once.
   */
  r.post('/external/jobs', requireAuth(), wrap(async (req, res) => {
    requireStaff(req);
    const sourceId = String(req.body?.sourceId || '').trim();
    if (!sourceId) throw badRequest('Say which source these jobs came from.');
    const source = await store.getSource(req.session, sourceId);
    if (!source) throw notFound('That source could not be found.');

    const list = Array.isArray(req.body?.jobs) ? req.body.jobs
      : req.body?.job ? [req.body.job] : null;
    if (!list || !list.length) throw badRequest('Send a job, or a list of jobs.');
    if (list.length > 500) throw badRequest('Send at most 500 jobs in one request.');

    const saved = [];
    const rejected = [];
    for (const raw of list) {
      /* No id: keyed by canonical URL, then company + title + location. */
      const job = normaliseExternalJob(withUrlKey(raw || {}), source);
      if (!job) {
        rejected.push({ raw: String(raw?.title || raw?.id || '(unnamed)').slice(0, 80),
          reason: 'a posting needs both an id and a title' });
        continue;
      }
      saved.push(toExternalJob(await store.saveJob(req.session, job)));
    }
    const linked = await store.relinkDuplicates(req.session);
    res.json({ saved: saved.length, rejected, linked, jobs: saved });
  }));

  /* ---- matching -------------------------------------------------- */

  /**
   * POST /api/external/match
   *
   * Scores a candidate against the open external jobs and stores the
   * result. Reads the candidate; writes only the match table.
   */
  r.post('/external/match', requireAuth(), wrap(async (req, res) => {
    const asked = String(req.body?.candidateId || '').trim() || null;
    const candidateId = subjectCandidate(req, asked);
    if (!candidateId) throw badRequest('Say which candidate to match.');

    /* The central matcher, scoped: external jobs only (0113). */
    externalPageScope(req);
    const out = await matchJobs({ session: req.session, candidateId, sourceType: EXTERNAL,
      opts: { jobLimit: Math.min(Number(req.body?.jobLimit) || 200, 500) } });
    if (out.status === 'not_found') throw notFound('That candidate could not be found.');
    res.json(out);
  }));

  r.get('/external/matches', requireAuth(), wrap(async (req, res) => {
    externalPageScope(req);
    const asked = String(req.query.candidateId || '').trim() || null;
    const candidateId = subjectCandidate(req, asked);
    if (!candidateId) {
      throw badRequest('Say which candidate’s matches you want (candidateId).');
    }
    const rows = await store.listMatches(req.session, candidateId, {
      minPercentage: req.query.min || 0,
      limit: req.query.limit || 50,
    });
    res.json({ matches: rows.map(toMatch) });
  }));

  /**
   * GET /api/external/recommended
   *
   * What the candidate portal's External Jobs page reads: the top
   * `EXTERNAL_JOBS_MAX_PER_CANDIDATE` matches for one candidate, filtered
   * and paginated inside that set.
   *
   * THE CAP IS NOT A PAGE SIZE. It is applied before the page is cut, so
   * page 3 of a 87-match list is the same 87 matches whichever page is
   * asked for first. `total` therefore never exceeds the cap, which is
   * what the counter on the page reports.
   *
   * Named `/external/recommended` rather than `/external-jobs/recommended`
   * because every other route in this family is `/external/*` and the
   * candidate portal already calls them that way. Renaming the family to
   * match a spec would break the page it is meant to serve.
   */
  r.get('/external/recommended', requireAuth(), wrap(async (req, res) => {
    externalPageScope(req);
    const asked = String(req.query.candidateId || '').trim() || null;
    const candidateId = subjectCandidate(req, asked);
    if (!candidateId) throw badRequest('Say which candidate’s matches you want.');

    const cfg = config.externalJobs;

    /*
     * A BLANK PROFILE CHANGES THE ORDER, NOT WHETHER THERE IS A LIST.
     *
     * This used to return an empty list and a "complete your profile"
     * panel, while a hundred real India jobs sat in the table unshown.
     * Matching needs skills or a title, so without them there is nothing
     * to rank BY - but there is still everything to show. The newest
     * live jobs are returned instead, with no score and no invented
     * reasons, and the page puts the "complete your profile for better
     * matches" banner ABOVE that list rather than in place of it.
     *
     * Empty now means one thing only: there are no jobs.
     */
    const cand = await store.readCandidate(req.session, candidateId);
    if (!cand) throw notFound('That candidate could not be found.');
    const hasProfile = (cand.skills || []).length > 0
      || (cand.technical_skills || []).length > 0
      || String(cand.title || '').trim() !== ''
      || String(cand.preferred_role || '').trim() !== '';

    if (!hasProfile) {
      const latest = await store.listLatest(req.session, candidateId, {
        cap: cfg.maxPerCandidate,
        activeDays: cfg.activeDays,
        page: req.query.page,
        pageSize: req.query.pageSize,
        source: String(req.query.source || '').trim() || null,
        location: String(req.query.location || '').trim() || null,
        jobType: String(req.query.jobType || '').trim() || null,
        search: String(req.query.q || '').trim(),
      });

      let lstate = 'ok';
      if (!latest.total) {
        const counts = await store.counts(req.session);
        lstate = Number(counts.sources) === 0 ? 'no_sources'
          : Number(counts.open_jobs) === 0 ? 'no_jobs_synced' : 'no_matches';
      }

      return res.json({
        total: latest.total,
        page: latest.page,
        pageSize: latest.pageSize,
        cap: cfg.maxPerCandidate,
        minMatch: cfg.minMatch,
        state: lstate,
        /* The banner the page shows above the list. It is a prompt, not
           an empty state, and the jobs below it are real. */
        tier: 'latest',
        profileIncomplete: true,
        message: 'Latest jobs in India — not matched to your profile. '
          + 'Add your skills and the role you are looking for to see better matches.',
        jobs: latest.rows.map(toMatch),
      });
    }

    const out = await store.listRecommended(req.session, candidateId, {
      cap: cfg.maxPerCandidate,
      minMatch: req.query.minMatch !== undefined ? Number(req.query.minMatch) : cfg.minMatch,
      activeDays: cfg.activeDays,
      page: req.query.page,
      pageSize: req.query.pageSize,
      source: String(req.query.source || '').trim() || null,
      location: String(req.query.location || '').trim() || null,
      jobType: String(req.query.jobType || '').trim() || null,
      search: String(req.query.q || '').trim(),
      sort: req.query.sort === 'posted' ? 'posted' : 'match',
    });

    /* The three "nothing here" cases are different problems with
       different answers, so they are distinguished rather than all
       reported as an empty list. */
    let state = 'ok';
    if (!out.total) {
      const counts = await store.counts(req.session);
      state = Number(counts.sources) === 0 ? 'no_sources'
        : Number(counts.open_jobs) === 0 ? 'no_jobs_synced'
        : 'no_matches';

      /*
       * NOTHING SCORED IS NOT NOTHING TO SHOW.
       *
       * A candidate whose skills are on file but whose best match falls
       * under the bar was shown an empty page while live India jobs sat
       * in the table - the same fault as the blank profile above, one
       * step further along. They get the newest jobs instead, unscored
       * and SAID to be unscored.
       *
       * Only when jobs exist. "No sources" and "nothing synced yet" are
       * still reported as themselves, because those are true.
       */
      if (state === 'no_matches') {
        const latest = await store.listLatest(req.session, candidateId, {
          cap: cfg.maxPerCandidate,
          activeDays: cfg.activeDays,
          page: req.query.page,
          pageSize: req.query.pageSize,
          source: String(req.query.source || '').trim() || null,
          location: String(req.query.location || '').trim() || null,
          jobType: String(req.query.jobType || '').trim() || null,
          search: String(req.query.q || '').trim(),
        });
        if (latest.total) {
          return res.json({
            total: latest.total,
            page: latest.page,
            pageSize: latest.pageSize,
            cap: cfg.maxPerCandidate,
            minMatch: cfg.minMatch,
            state: 'ok',
            tier: 'latest',
            profileIncomplete: true,
            message: 'Latest jobs in India — none reached the '
              + cfg.minMatch + '% match mark, so these are not matched to your '
              + 'profile. Adding more skills widens what can be matched.',
            jobs: latest.rows.map(toMatch),
          });
        }
      }
    }

    res.json({
      total: out.total,                 // never more than the cap
      page: out.page,
      pageSize: out.pageSize,
      cap: cfg.maxPerCandidate,
      minMatch: cfg.minMatch,
      state,
      jobs: out.rows.map(toMatch),
    });
  }));

  /**
   * POST /api/external/matches/:externalJobId/dismiss — "not interested".
   */
  r.post('/external/matches/:externalJobId/dismiss', requireAuth(),
    wrap(async (req, res) => {
      const asked = String(req.body?.candidateId || '').trim() || null;
      const candidateId = subjectCandidate(req, asked);
      if (!candidateId) throw badRequest('Say which candidate.');
      const gone = await store.dismissMatch(req.session, candidateId, req.params.externalJobId);
      res.json({ dismissed: gone });
    }));

  /* ---- applying -------------------------------------------------- */

  /**
   * POST /api/external/apply
   *
   * The response always says what actually happened. For a redirect
   * source it carries `redirectUrl`, and the caller MUST open it - the
   * application is not complete until the candidate finishes it on the
   * advertiser's own site, which is why the stored status is
   * "Applied - Not Confirmed" and not "Applied".
   */
  r.post('/external/apply', requireAuth(), wrap(async (req, res) => {
    const asked = String(req.body?.candidateId || '').trim() || null;
    /* A candidate gets their own id whatever they asked for; staff must
       name one, because "apply for everybody" is not an operation. */
    const candidateId = subjectCandidate(req, asked);
    if (!candidateId) throw badRequest('Say which candidate is applying.');

    const externalJobId = String(req.body?.externalJobId || '').trim();
    if (!externalJobId) throw badRequest('Say which external job.');

    /* Only staff may trigger an automatic submission, and only when the
       deployment allows it at all. */
    const auto = req.body?.auto === true;
    if (auto && !STAFF.includes(req.session.role)) {
      throw forbidden('Only a recruiter can send an application automatically.');
    }

    /*
     * A SECOND PRESS IN THE SAME SECOND IS THE SAME PRESS.
     *
     * Answered from the row that already exists rather than refused:
     * the candidate did nothing wrong, and an error on a double-click
     * is a worse experience than an instant, correct answer.
     */
    if (tooSoon(recentApply, candidateId + '|' + externalJobId, 10_000)) {
      const existing = await store.findApplication(req.session, candidateId, externalJobId);
      if (existing) {
        const shapedExisting = toExternalApplication(existing);
        return res.json({
          ok: true, status: 'already_open',
          applicationId: shapedExisting.id,
          applyUrl: shapedExisting.applicationUrl,
          application: shapedExisting,
        });
      }
    }

    /* The stored link is checked BEFORE the click is recorded: a job
       whose link is unsafe is reported, and the candidate is not sent. */
    /* external_apply_click - the same counter the public redirect keeps.
       Nothing about the candidate goes into it. */
    await event(externalJobId, 'external_apply_click');
    const target = await cx.applyTarget(req.session, externalJobId);
    if (target && target.status === 'open' && target.application_url) {
      const d = destination(target);
      if (!d.ok) {
        console.warn(`[external] apply refused for ${externalJobId} (${target.source_key}): ${d.reason}`);
        await event(externalJobId, 'external_redirect_failure', d.code);
        await redirectRefused(PORTAL, target, d.reason);
        return res.status(422).json({ ok: false, status: 'invalid_url',
          error: { code: 'INVALID_URL', message: 'Redirect unavailable: this job’s link does not look safe to follow, so we have not opened it.' } });
      }
      /* 0115: a posting its source has taken down is closed here, on the
         source's own word, and applyExternally below then answers
         "closed" - no URL handed out, no application row (and the
         failure is counted once, below, as 'closed'). */
      await checkAvailability(PORTAL, externalJobId);
    }

    const out = await applyExternally(req.session, { candidateId, externalJobId, auto });
    if (out.status === 'not_found') {
      await event(externalJobId, 'external_redirect_failure', 'not_found');
      throw notFound(out.error || 'Not found.');
    }
    /* Handed a validated destination = redirect success; refused = failure
       with the reason; "you already told us" sends nobody anywhere. */
    const refusedAs = out.ok === false || ['sample_posting', 'unsupported'].includes(out.status) ? out.status : null;
    if (refusedAs) await event(externalJobId, 'external_redirect_failure', refusedAs);
    else if (out.redirectUrl && out.status !== 'already_applied') await event(externalJobId, 'external_redirect_success');

    /*
     * ANOTHER VISIT, NOT ANOTHER APPLICATION.
     *
     * Pressing Apply twice, or "Open job again" a week later, is one
     * application that has been opened twice - the unique key on
     * (candidate, job) guarantees that. Counting the opens is what lets
     * the screen tell "they looked once and said nothing" apart from
     * "they have been back four times".
     */
    if (out.application && out.application.id) {
      const opens = await store.recordOpen(req.session, out.application.id);
      /* The first open is the start of this application's life, and it
         is not a transition - the row did not exist a moment ago - so it
         has to be written to the trail explicitly or the history begins
         halfway through. */
      if (opens === 1) {
        await store.logApplication(req.session, out.application.id, {
          to: out.application.status,
          actor: req.session.role === 'candidate' ? 'candidate' : 'recruiter',
          actorId: req.session.userId || null,
          note: 'opened the employer link',
        });
      }
    }

    const fresh = out.application
      ? await store.getApplication(req.session, out.application.id)
      : null;
    const shaped = fresh ? toExternalApplication(fresh) : null;

    res.json({
      ...out,
      /* Named as the brief names them, because this is the pair the
         browser needs: which application to ask about, and where to
         send the candidate. */
      applicationId: shaped ? shaped.id : null,
      applyUrl: out.redirectUrl || (shaped ? shaped.applicationUrl : null),
      application: shaped,
    });
  }));

  /* ------------------------------------------------------------------ *
   * not twice in the same breath
   *
   * A double-click, a double-tap, or a script fires /apply several times
   * in a second. None of them is an error and none of them should reach
   * the database: the answer to the second one is the answer to the
   * first, so it is returned rather than refused. The candidate sees a
   * normal response and one row exists.
   *
   * Keyed per candidate AND per job, so being quick on one advert never
   * blocks another.
   */
  var recentApply = new Map();
  var recentWrite = new Map();

  function tooSoon(store, key, ms) {
    var now = Date.now();
    var last = store.get(key) || 0;
    if (now - last < ms) return true;
    store.set(key, now);
    /* Bounded: a long-running process must not keep a key per candidate
       per job for ever. */
    if (store.size > 5000) {
      for (var entry of store) {
        if (now - entry[1] > 60000) store.delete(entry[0]);
      }
    }
    return false;
  }

  /* ---- external applications ------------------------------------- */

  r.get('/external/applications', requireAuth(), wrap(async (req, res) => {
    const asked = String(req.query.candidateId || '').trim() || null;
    const candidateId = subjectCandidate(req, asked);
    const rows = await store.listApplications(req.session, {
      candidateId, limit: req.query.limit || 200,
    });
    res.json({ applications: rows.map(toExternalApplication) });
  }));

  /**
   * GET /api/external/applications/pending
   *
   * The ones still waiting for an answer, older than a few minutes.
   *
   * THIS IS WHAT MAKES THE QUESTION SURVIVE. The in-page prompt only
   * works in the tab the candidate clicked in: close it, sign out, pick
   * up a phone instead, and the question is gone and the status is wrong
   * for ever. This is asked on every page load, from any device.
   *
   * Registered BEFORE '/external/applications/:id', because Express
   * matches in order and "pending" would otherwise be read as an id.
   */
  r.get('/external/applications/pending', requireAuth(), wrap(async (req, res) => {
    const candidateId = subjectCandidate(req, String(req.query.candidateId || '').trim() || null);
    if (!candidateId) throw badRequest('Say which candidate.');

    /*
     * ZERO IS A NUMBER SOMEBODY MEANT.
     *
     * `Number(x) || 5` turns 0 into 5, because zero is falsy - so
     * "?minutes=0", which means "everything, including what I clicked a
     * moment ago", quietly became "only things older than five minutes"
     * and the answer was always empty.
     */
    const asked = Number(req.query.minutes);
    const minutes = Number.isFinite(asked)
      ? Math.max(0, Math.min(asked, 1440))
      : 5;
    const rows = await store.listPending(req.session, candidateId, { minutes });
    res.json({
      pending: rows.map(toExternalApplication),
      /* Said in the response as well as on the screen, so an integration
         reading this cannot present it as anything else. */
      note: 'TeamLink cannot see what happens on external sites. These are '
          + 'jobs you opened; only you can say whether you applied.',
    });
  }));

  /**
   * POST /api/external/applications/:id/prompt-shown
   *
   * The question has been put. Recorded so the same click cannot produce
   * the dialog a second time - on this tab, another tab, or tomorrow.
   */
  r.post('/external/applications/:id/prompt-shown', requireAuth(), wrap(async (req, res) => {
    const before = await store.getApplication(req.session, req.params.id);
    if (!before) throw notFound('That application could not be found.');
    if (req.session.role === 'candidate' && before.candidate_id !== req.session.profileId) {
      throw forbidden('That is not your application.');
    }
    if (tooSoon(recentWrite, 'p:' + req.params.id, 2000)) {
      return res.json({ ok: true, first: false });
    }
    const first = await store.markPromptShown(req.session, req.params.id);
    /* `first` false means somebody got there already. Not an error - the
       second tab simply does not ask. */
    res.json({ ok: true, first });
  }));

  /**
   * PATCH /api/external/applications/:id
   *
   * The candidate's answer, and their own note against it.
   *
   * ONLY THE FOUR STATUSES THIS FLOW USES. Anything else is refused
   * here rather than written and interpreted later.
   */
  r.patch('/external/applications/:id', requireAuth(), wrap(async (req, res) => {
    const b = z.object({
      status: z.enum(['clicked', 'applied_unconfirmed', 'not_applied', 'dismissed']).optional(),
      notes: z.string().max(500).optional(),
      reopen: z.boolean().optional(),
    }).safeParse(req.body || {});
    if (!b.success) throw badRequest('That is not a status this flow uses.');

    const before = await store.getApplication(req.session, req.params.id);
    if (!before) throw notFound('That application could not be found.');
    if (req.session.role === 'candidate' && before.candidate_id !== req.session.profileId) {
      throw forbidden('That is not your application.');
    }

    if (tooSoon(recentWrite, 'w:' + req.params.id, 1000)) {
      /* The state as it stands, not an error. Two tabs answering at once
         is not a failure for either of them. */
      const now = await store.getApplication(req.session, req.params.id);
      return res.json({ application: toExternalApplication(now) });
    }

    if (b.data.status) {
      await store.markApplication(req.session, req.params.id, {
        status: b.data.status,
        actor: req.session.role === 'candidate' ? 'candidate' : 'recruiter',
        actorId: req.session.userId || null,
        note: b.data.notes,
        reopen: b.data.reopen === true,
      });
    }
    if (typeof b.data.notes === 'string') {
      await store.setApplicationNotes(req.session, req.params.id, b.data.notes);
    }

    const after = await store.getApplication(req.session, req.params.id);
    res.json({ application: toExternalApplication(after) });
  }));

  /**
   * GET /api/external/applications/:id/log
   *
   * The lifecycle of one application, for support. Staff only, and
   * explicitly NOT evidence that anything was verified - it is a record
   * of what this system was told and by whom.
   */
  r.get('/external/applications/:id/log', requireAuth(), wrap(async (req, res) => {
    requireStaff(req);
    const rows = await store.applicationLog(req.session, req.params.id);
    res.json({
      log: rows.map((x) => ({
        from: x.from_status, to: x.to_status, actor: x.actor,
        actorId: x.actor_id || undefined, note: x.note || undefined,
        at: new Date(x.created_at).toISOString(),
      })),
    });
  }));

  /**
   * GET /api/external/applications/conversion
   *
   * Which of the places we collect jobs from actually lead anywhere.
   *
   * A source that returns four hundred adverts nobody applies to is
   * worse than one that returns twenty they do, and until now the only
   * number anyone had was how many jobs came back. This counts what
   * happened after the click, by publisher.
   *
   * READ ONLY, and out of the tables that already exist. No tracking
   * pixel, no third party, and no candidate named - an administrator
   * sees totals, which is less than they can already see elsewhere.
   */
  r.get('/external/applications/conversion', requireAuth(), wrap(async (req, res) => {
    requireStaff(req);
    const rows = await store.conversionBySource(req.session);
    res.json({
      bySource: rows,
      note: 'Every "applied" here is the candidate’s own confirmation. '
          + 'TeamLink cannot verify an application made on another site.',
    });
  }));

  r.post('/external/applications/:id/refresh', requireAuth(), wrap(async (req, res) => {
    requireStaff(req);
    const out = await refreshApplicationStatus(req.session, req.params.id);
    if (out.status === 'not_found') throw notFound('That external application could not be found.');
    res.json({
      ...out,
      application: out.application ? toExternalApplication(out.application) : null,
    });
  }));

  /**
   * POST /api/external/applications/:id/status
   *
   * A recruiter recording what a board told them out of band - an email,
   * a phone call, a status on a portal TeamLink cannot read. The source's
   * own wording is kept in `externalStatus` exactly as given.
   *
   * This cannot touch a TeamLink ATS stage, and nothing downstream of it
   * reads `applications`.
   */
  /**
   * POST /api/external/applications/:id/confirm
   *
   * The candidate's own answer to "Did you apply?".
   *
   * SEPARATE FROM /status ON PURPOSE. That route is staff-only: it
   * records what a job board told a recruiter out of band, and it
   * accepts any status in the vocabulary. A candidate answering a
   * yes/no question needs neither of those powers - so this takes the
   * two answers and nothing else, and only for an application that is
   * theirs.
   *
   * WHY IT IS ASKED AT ALL. A redirect application finishes on somebody
   * else's website. TeamLink handed over the link and cannot see what
   * happened next; the only honest source for that fact is the person
   * who was there.
   */
  r.post('/external/applications/:id/confirm', requireAuth(), wrap(async (req, res) => {
    const b = z.object({ applied: z.boolean() }).safeParse(req.body || {});
    if (!b.success) throw badRequest('Say whether you applied.');

    const before = await store.getApplication(req.session, req.params.id);
    if (!before) throw notFound('That application could not be found.');

    /* Their own, or a recruiter acting on the record. RLS already
       narrows what getApplication can see; this is the explicit check
       that a candidate cannot answer for somebody else. */
    if (req.session.role === 'candidate' && before.candidate_id !== req.session.profileId) {
      throw forbidden('You can only answer for your own application.');
    }

    /*
     * 'applied_unconfirmed', NOT 'applied'.
     *
     * 'applied' reads as a fact this system established. It did not: the
     * candidate opened somebody else's website and came back and told
     * us. The status whose label is "Applied on External Site" is the
     * only one that can be shown without implying TeamLink checked.
     *
     * Through external_application_mark so the change is audited and the
     * recommendation moves with it, rather than the two drifting apart.
     */
    await store.markApplication(req.session, req.params.id, {
      status: b.data.applied ? 'applied_unconfirmed' : 'not_applied',
      actor: req.session.role === 'candidate' ? 'candidate' : 'recruiter',
      actorId: req.session.userId || null,
    });
    const updated = await store.getApplication(req.session, req.params.id);
    res.json({
      application: toExternalApplication(updated),
      /* Said plainly, because the candidate's next screen depends on it:
         saying no puts the job back in their recommended list. */
      note: b.data.applied
        ? 'Recorded as applied.'
        : 'Put back in your list — you can apply later.',
    });
  }));

  r.post('/external/applications/:id/status', requireAuth(), wrap(async (req, res) => {
    requireStaff(req);
    const schema = z.object({
      status: z.string().trim().min(2).max(40),
      externalStatus: z.string().trim().max(120).optional(),
      externalApplicationId: z.string().trim().max(200).optional(),
      failureReason: z.string().trim().max(400).optional(),
    });
    const out = schema.safeParse(req.body || {});
    if (!out.success) throw badRequest('Please check the status details.');

    const before = await store.getApplication(req.session, req.params.id);
    if (!before) throw notFound('That external application could not be found.');

    const updated = await store.setApplicationStatus(req.session, req.params.id, out.data);
    res.json({ application: toExternalApplication(updated) });
  }));

  return r;
}
