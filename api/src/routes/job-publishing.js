/**
 * Save & Post - the API (0112).
 *
 * Recruiter / admin (their own jobs; an admin any job):
 *   GET  /api/publishing/destinations            what each destination can do right now
 *   GET  /api/jobs/:id/publications              per-destination status of one job
 *   GET  /api/job-publications?jobIds=a,b        the same for many (Manage Jobs badges)
 *   PUT  /api/jobs/:id/publications              Save & Post: { destinations: [...] }
 *   POST /api/jobs/:id/publications/publish-now  { destination? } - retry / publish now
 *   GET  /api/jobs/:id/publications/events       the audit trail
 *
 * Administrators only (Administration -> Integrations):
 *   GET  /api/admin/integrations                 every destination, secrets as "•••• saved"
 *   PUT  /api/admin/integrations/:dest           save configuration / credentials
 *   POST /api/admin/integrations/:dest/test      Test Connection (validateCredentials)
 *   POST /api/admin/integrations/:dest/publish-pending   publish everything waiting for it
 *   GET  /api/admin/integrations/:dest/events    the configuration audit trail
 *
 * Public, outside /api (mounted ahead of CORS and CSRF by app.js):
 *   GET  /feeds/jobs.json  /feeds/jobs.xml       the TeamLink website feed
 *   GET  /feeds/jobs/:id.json                    one job's website entry
 *   GET  /feeds/:dest.xml?token=                 a platform's signed pull feed (Indeed)
 *   POST /hooks/publishing/:dest                 a platform's signed confirmation
 *
 * SECRETS NEVER COME BACK. No response here carries a credential: an
 * administrator sees "saved" and at most the last 4 characters. Request
 * bodies of the integration routes are never logged.
 */
import express, { Router } from 'express';
import { z } from 'zod';
import { withUser } from '../db.js';
import { config } from '../config.js';
import { wrap, badRequest, notFound, forbidden, ApiError } from '../errors.js';
import { requireAuth, requireRole } from '../auth.js';
import {
  ENGINE, OWN, setDestinations, ensureDefaultDestinations, reconcileJob, kickJob, makeDue, listForJob, sweepOnce, integrationOf,
  blockerFor, toPublication, confirmFromPlatform, settle,
} from '../publishing/service.js';
import { connectorFor } from '../publishing/connectors.js';
import { SECRET_FIELDS, sealSecrets, openSecrets, hintFor, secretKeyConfigured, SecretKeyMissing, safeEqual, hmacHex, scrub } from '../publishing/secrets.js';
import { feedRows, jsonFeed, rssFeed, partnerXmlFeed, publicJob, jobPostingJsonLd, publicBase } from '../publishing/feed.js';
import { hiddenError } from '../scope.js';

const DEST_RE = /^[A-Z][A-Z0-9_]{1,39}$/;
const destParam = (v) => {
  const d = String(v || '').toUpperCase();
  if (!DEST_RE.test(d)) throw notFound('No such destination.');
  return d;
};

function afterJson(res, fn) {
  const json = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      Promise.resolve().then(() => fn(body)).catch((err) => console.error('[publishing] after-response step failed:', err.message));
    }
    return json(body);
  };
}

/** The caller may change this job: an admin, or the recruiter who owns it. */
async function assertMayPublish(session, jobId) {
  const row = await withUser(session, async (c) =>
    (await c.query(`select id, recruiter_id from jobs where id=$1`, [jobId])).rows[0]);
  if (!row) throw await hiddenError(session, 'job', jobId, notFound('That job no longer exists.'));
  if (session.role === 'admin') return row;
  if (session.role === 'recruiter' && row.recruiter_id && row.recruiter_id === session.profileId) return row;
  throw forbidden('You can publish only your own jobs.');
}

async function destinationStates() {
  return withUser(ENGINE, async (c) => {
    const dests = (await c.query(`select * from publishing_destinations where active order by sort_order, key`)).rows;
    const integ = {};
    for (const r of (await c.query(`select * from publishing_integrations`)).rows) integ[r.destination] = integrationOf(r);
    return dests.map((d) => {
      const blocker = blockerFor(d, integ[d.key]);
      const i = integ[d.key];
      return {
        key: d.key, label: d.label, kind: d.kind, defaultSelected: d.default_selected,
        ready: !blocker,
        state: !blocker ? 'ready' : 'integration_required',
        stateLabel: !blocker ? (d.kind === 'own' ? 'Works now' : 'Connected') : 'Integration Required',
        connectionType: (i && i.connectionType) || null,
        locked: d.key === 'TEAMLINK_PORTAL',
      };
    });
  });
}

/* ================================================================== *
 * hooks on the existing job routes - mounted AHEAD of jobRoutes
 * ================================================================== */
export function publishingJobHooks() {
  const r = Router();
  r.use((req, res, next) => {
    /* An edit, a publish / unpublish, a deadline change: the job's rows
       are reconciled (update pushed, or taken down when it closed). */
    if (req.method === 'PUT' || req.method === 'POST') {
      /* A NEW job: if nobody chose its destinations, TeamLink's defaults (the portal and the
         TeamLink Website feed) - a little later, after the job form has had its chance to send
         its own ticks, which always win. */
      if (req.method === 'POST' && /^\/jobs\/?$/.test(req.path)) {
        afterJson(res, (body) => {
          const id = body && body.job && body.job.id;
          if (!id) return;
          const t = setTimeout(() => {
            ensureDefaultDestinations(id).then((rows) => { if (rows.length) kickJob(id); })
              .catch((err) => console.error('[publishing] default destinations for', id, 'failed:', err.message));
          }, Number(process.env.PUBLISH_DEFAULTS_DELAY_MS || 8000));
          if (t.unref) t.unref();
        });
        return next();
      }
      const m = /^\/jobs\/([^/]+)(?:\/(publish|deadline|archive))?\/?$/.exec(req.path);
      if (m && m[1] !== 'describe' && (req.method === 'PUT' || m[2])) {
        const id = decodeURIComponent(m[1]);
        afterJson(res, () => ensureDefaultDestinations(id).catch(() => []).then(() => kickJob(id)));
      }
      return next();
    }
    /* Deleting a job (admin): it is taken off the partner platforms first. */
    if (req.method === 'DELETE') {
      const m = /^\/jobs\/([^/]+)\/?$/.exec(req.path);
      if (!m || !req.session || req.session.role !== 'admin') return next();
      const id = decodeURIComponent(m[1]);
      withUser(ENGINE, (c) => c.query(
        `update job_publications set desired='removed', next_attempt_at=now(), updated_at=now()
          where job_id=$1 and destination <> all($2::text[]) and status in ('posted','awaiting_confirmation','failed')`, [id, OWN]))
        .then(() => reconcileJob(id))
        .catch((err) => console.error('[publishing] could not take job', id, 'down before delete:', err.message))
        .finally(() => next());
      return undefined;
    }
    return next();
  });
  return r;
}

/* ================================================================== *
 * recruiter / admin
 * ================================================================== */
const saveSchema = z.object({
  destinations: z.array(z.string().trim().max(40)).max(20),
  wait: z.boolean().optional(),
});

export default function jobPublishingRoutes() {
  const r = Router();
  const staff = [requireAuth(), requireRole('recruiter', 'admin')];
  const admin = [requireAuth(), requireRole('admin')];

  r.get('/publishing/destinations', ...staff, wrap(async (_req, res) => {
    res.json({ destinations: await destinationStates(), isAdmin: _req.session.role === 'admin' });
  }));

  r.get('/jobs/:id/publications', ...staff, wrap(async (req, res) => {
    await assertMayPublish(req.session, req.params.id);
    res.json({ jobId: req.params.id, publications: await listForJob(req.params.id) });
  }));

  r.get('/jobs/:id/publications/events', ...staff, wrap(async (req, res) => {
    await assertMayPublish(req.session, req.params.id);
    const rows = await withUser(req.session, async (c) => (await c.query(
      `select destination, event, from_status, to_status, detail, actor, created_at from job_publication_events
        where job_id=$1 order by id desc limit 200`, [req.params.id])).rows);
    res.json({ events: rows.map((e) => ({ destination: e.destination, event: e.event, from: e.from_status, to: e.to_status,
      detail: e.detail, byUser: !!e.actor, at: e.created_at })) });
  }));

  /* Many jobs at once, for the badges. RLS decides which rows come back. */
  r.get('/job-publications', ...staff, wrap(async (req, res) => {
    const ids = String(req.query.jobIds || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 200);
    if (!ids.length) return res.json({ publications: {} });
    const out = await withUser(req.session, async (c) => {
      const dests = Object.fromEntries((await c.query(`select * from publishing_destinations`)).rows.map((d) => [d.key, d]));
      const rows = (await c.query(
        `select p.* from job_publications p join publishing_destinations d on d.key = p.destination
          where p.job_id = any($1::text[]) order by p.job_id, d.sort_order`, [ids])).rows;
      const by = {};
      for (const row of rows) (by[row.job_id] = by[row.job_id] || []).push(toPublication(row, dests[row.destination]));
      return by;
    });
    res.json({ publications: out });
  }));

  /**
   * Save & Post. The job itself is saved by the job routes; this records
   * where it goes and starts the publishing. TeamLink's own destinations
   * are usually confirmed before this answers; the rest are queued and
   * report back through GET /jobs/:id/publications.
   */
  r.put('/jobs/:id/publications', ...staff, wrap(async (req, res) => {
    const p = saveSchema.safeParse(req.body || {});
    if (!p.success) throw badRequest('Choose the destinations as a list.');
    await assertMayPublish(req.session, req.params.id);
    await setDestinations(req.params.id, p.data.destinations, req.session.userId);
    const work = reconcileJob(req.params.id);
    /* Wait a little for the quick ones; never hold the recruiter hostage
       to a slow partner API. */
    const waitMs = Number(process.env.PUBLISH_WAIT_MS || 6000);
    await Promise.race([work.catch(() => null), new Promise((r2) => setTimeout(r2, waitMs))]);
    res.json({ jobId: req.params.id, publications: await listForJob(req.params.id), destinations: await destinationStates() });
  }));

  r.post('/jobs/:id/publications/publish-now', ...staff, wrap(async (req, res) => {
    await assertMayPublish(req.session, req.params.id);
    const dest = req.body && req.body.destination ? destParam(req.body.destination) : null;
    await makeDue(req.params.id, dest, req.session.userId);
    const publications = await reconcileJob(req.params.id, { force: true });
    res.json({ jobId: req.params.id, publications });
  }));

  /* ================================================================ *
   * Administration -> Integrations
   * ================================================================ */
  r.get('/admin/integrations', ...admin, wrap(async (_req, res) => {
    res.json({ secretKeyConfigured: secretKeyConfigured(), integrations: await adminView() });
  }));

  r.get('/admin/integrations/:dest/events', ...admin, wrap(async (req, res) => {
    const d = destParam(req.params.dest);
    const rows = await withUser(req.session, async (c) => (await c.query(
      `select event, detail, actor, created_at from publishing_integration_events where destination=$1 order by id desc limit 100`, [d])).rows);
    res.json({ events: rows.map((e) => ({ event: e.event, detail: e.detail, byUser: !!e.actor, at: e.created_at })) });
  }));

  r.put('/admin/integrations/:dest', ...admin, wrap(async (req, res) => {
    const d = destParam(req.params.dest);
    const body = req.body || {};
    const changed = await withUser(req.session, async (c) => {
      const dest = (await c.query(`select * from publishing_destinations where key=$1`, [d])).rows[0];
      if (!dest) throw notFound('No such destination.');
      if (dest.kind !== 'partner') throw badRequest(`${dest.label} is part of TeamLink and needs no configuration.`);
      const cur = (await c.query(`select * from publishing_integrations where destination=$1`, [d])).rows[0] || null;
      const v = validateConfig(body, dest, cur);

      /* secrets: blank keeps, a value replaces, clearSecrets removes */
      const incoming = {};
      for (const k of SECRET_FIELDS) {
        const val = body.secrets && body.secrets[k];
        if (val != null && String(val).trim() !== '') {
          if (String(val).length > 4000) throw badRequest(`${k} is too long.`);
          incoming[k] = String(val).trim();
        }
      }
      const clear = Array.isArray(body.clearSecrets) ? body.clearSecrets.filter((k) => SECRET_FIELDS.includes(k)) : [];
      let sealed = cur ? cur.secrets_enc : null;
      let hints = (cur && cur.secret_hints) || {};
      const secretChange = Object.keys(incoming).length || clear.length;
      if (secretChange) {
        if (!secretKeyConfigured()) throw new ApiError(409, 'INTEGRATION_SECRET_KEY_MISSING', new SecretKeyMissing().message);
        const existing = (cur && openSecrets(cur.secrets_enc)) || {};
        const next = { ...existing, ...incoming };
        for (const k of clear) delete next[k];
        hints = {};
        for (const [k, val] of Object.entries(next)) hints[k] = hintFor(val);
        sealed = Object.keys(next).length ? sealSecrets(next) : null;
      }

      await c.query(
        `insert into publishing_integrations (destination, enabled, connection_type, endpoint_url, auth_type, token_url, status_url,
                                              account_id, client_id, options, secrets_enc, secret_hints, updated_by, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now())
         on conflict (destination) do update set
           enabled=excluded.enabled, connection_type=excluded.connection_type, endpoint_url=excluded.endpoint_url,
           auth_type=excluded.auth_type, token_url=excluded.token_url, status_url=excluded.status_url,
           account_id=excluded.account_id, client_id=excluded.client_id, options=excluded.options,
           secrets_enc=excluded.secrets_enc, secret_hints=excluded.secret_hints, updated_by=excluded.updated_by, updated_at=now()`,
        [d, v.enabled, v.connectionType, v.endpointUrl, v.authType, v.tokenUrl, v.statusUrl, v.accountId, v.clientId,
          JSON.stringify(v.options), sealed, JSON.stringify(hints), req.session.userId || null]);

      /* The audit names the fields that changed, never a value. */
      const fields = [];
      const was = cur ? integrationOf({ ...cur, secrets_enc: null }) : {};
      for (const [k, now] of Object.entries({ connectionType: v.connectionType, endpointUrl: v.endpointUrl, authType: v.authType,
        tokenUrl: v.tokenUrl, statusUrl: v.statusUrl, accountId: v.accountId, clientId: v.clientId })) {
        if ((was[k] || null) !== (now || null)) fields.push(k);
      }
      if (JSON.stringify((cur && cur.options) || {}) !== JSON.stringify(v.options)) fields.push('options');
      const log = (event, detail) => c.query(`insert into publishing_integration_events (destination, event, detail, actor) values ($1,$2,$3,$4)`,
        [d, event, detail, req.session.userId || null]);
      if (fields.length) await log('config_saved', `Changed: ${fields.join(', ')}`);
      if (Object.keys(incoming).length) await log('secret_saved', `Saved: ${Object.keys(incoming).join(', ')}`);
      if (clear.length) await log('secret_cleared', `Cleared: ${clear.join(', ')}`);
      if (!cur || !!cur.enabled !== v.enabled) await log(v.enabled ? 'enabled' : 'disabled', null);
      return v.enabled;
    });
    /* Newly connected (or the credentials fixed): whatever was waiting for
       it, or failed with the old settings, goes out now. */
    if (changed) {
      withUser(ENGINE, (c) => c.query(
        `update job_publications set next_attempt_at=now(), attempts=0, updated_at=now()
          where destination=$1 and desired='published' and status in ('failed','integration_required')`, [d]))
        .then(() => sweepOnce({ destination: d }))
        .catch((err) => console.error('[publishing] sweep after save failed:', err.message));
    }
    res.json({ secretKeyConfigured: secretKeyConfigured(), integration: (await adminView(d))[0] });
  }));

  r.post('/admin/integrations/:dest/test', ...admin, wrap(async (req, res) => {
    const d = destParam(req.params.dest);
    const { dest, integ } = await withUser(req.session, async (c) => ({
      dest: (await c.query(`select * from publishing_destinations where key=$1`, [d])).rows[0],
      integ: integrationOf((await c.query(`select * from publishing_integrations where destination=$1`, [d])).rows[0]),
    }));
    if (!dest) throw notFound('No such destination.');
    let result;
    if (dest.kind === 'own') result = await connectorFor(d, null, dest.label).validateCredentials({});
    else if (!integ) result = { ok: false, message: 'Nothing is configured yet - fill in the connection and save first.' };
    else result = await connectorFor(d, integ, dest.label).validateCredentials({ integration: integ });
    const message = scrub(result.message, integ && integ.secrets);
    await withUser(req.session, async (c) => {
      if (dest.kind === 'partner') {
        await c.query(`update publishing_integrations set last_test_at=now(), last_test_ok=$2, last_test_message=$3 where destination=$1`,
          [d, !!result.ok, message]);
      }
      await c.query(`insert into publishing_integration_events (destination, event, detail, actor) values ($1,$2,$3,$4)`,
        [d, result.ok ? 'test_ok' : 'test_failed', message, req.session.userId || null]);
    });
    res.json({ ok: !!result.ok, message, integration: dest.kind === 'partner' ? (await adminView(d))[0] : null });
  }));

  r.post('/admin/integrations/:dest/publish-pending', ...admin, wrap(async (req, res) => {
    const d = destParam(req.params.dest);
    /* whatever is already in flight finishes first, so it is not skipped */
    await settle();
    const n = await withUser(ENGINE, async (c) => (await c.query(
      `update job_publications set next_attempt_at=now(), attempts=0, updated_at=now()
        where destination=$1 and desired='published' and status in ('failed','integration_required','pending','awaiting_confirmation')
        returning id`, [d])).rowCount);
    await withUser(req.session, (c) => c.query(
      `insert into publishing_integration_events (destination, event, detail, actor) values ($1,'publish_pending',$2,$3)`,
      [d, `${n} waiting job(s) queued`, req.session.userId || null]));
    const out = await sweepOnce({ destination: d, limit: 200 });
    await settle();
    res.json({ queued: n, jobs: out.jobs, integration: (await adminView(d))[0] || null });
  }));

  return r;
}

/* ------------------------------------------------------------------ *
 * the administrator's view - never a secret
 * ------------------------------------------------------------------ */
async function adminView(only = null) {
  return withUser(ENGINE, async (c) => {
    const dests = (await c.query(`select * from publishing_destinations where active and ($1::text is null or key=$1) order by sort_order`, [only])).rows;
    const rows = Object.fromEntries((await c.query(`select * from publishing_integrations`)).rows.map((x) => [x.destination, x]));
    const counts = {};
    for (const x of (await c.query(`select destination, status, count(*)::int n from job_publications where desired='published' group by 1, 2`)).rows) {
      (counts[x.destination] = counts[x.destination] || {})[x.status] = x.n;
    }
    const base = publicBase();
    return dests.map((d) => {
      const row = rows[d.key];
      const integ = integrationOf(row);
      const blocker = blockerFor(d, integ);
      const hints = (row && row.secret_hints) || {};
      const secrets = {};
      for (const k of SECRET_FIELDS) secrets[k] = { saved: Object.prototype.hasOwnProperty.call(hints, k), hint: hints[k] || null };
      const feed = integ && ['xml_feed', 'partner_feed'].includes(integ.connectionType);
      return {
        destination: d.key, label: d.label, kind: d.kind, connectionTypes: d.connection_types,
        ready: !blocker, blocker: blocker || null,
        enabled: d.kind === 'own' ? true : !!(row && row.enabled),
        connectionType: (row && row.connection_type) || null,
        endpointUrl: (row && row.endpoint_url) || '',
        authType: (row && row.auth_type) || null,
        tokenUrl: (row && row.token_url) || '',
        statusUrl: (row && row.status_url) || '',
        accountId: (row && row.account_id) || '',
        clientId: (row && row.client_id) || '',
        options: (row && row.options) || {},
        secrets,
        secretsReadable: !row || !row.secrets_enc || !!integ.secrets,
        lastTestAt: (row && row.last_test_at) || null,
        lastTestOk: row ? row.last_test_ok : null,
        lastTestMessage: (row && row.last_test_message) || null,
        lastSyncAt: (row && row.last_sync_at) || null,
        lastError: (row && row.last_error) || null,
        lastErrorAt: (row && row.last_error_at) || null,
        updatedAt: (row && row.updated_at) || null,
        counts: counts[d.key] || {},
        /* Without the token: the administrator typed it, and it is never sent back. */
        feedUrl: d.key === 'TEAMLINK_WEBSITE' ? `${base}/feeds/jobs.json`
          : feed ? `${base}/feeds/${d.key.toLowerCase()}.xml?token=••••${hints.feedToken ? hints.feedToken : ''}` : null,
        rssUrl: d.key === 'TEAMLINK_WEBSITE' ? `${base}/feeds/jobs.xml` : null,
        callbackUrl: d.kind === 'partner' ? `${base}/hooks/publishing/${d.key.toLowerCase()}` : null,
      };
    });
  });
}

const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])$/i;
function checkUrl(v, label, { required = false } = {}) {
  const s = String(v == null ? '' : v).trim();
  if (!s) { if (required) throw badRequest(`${label} is required.`, { [label]: 'Required' }); return null; }
  if (s.length > 600) throw badRequest(`${label} is too long.`);
  let u;
  try { u = new URL(s); } catch { throw badRequest(`${label} must be a full URL (https://…).`, { [label]: 'Not a URL' }); }
  const local = LOOPBACK.test(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local && !config.isProd)) {
    throw badRequest(`${label} must use https:// (the platform's authorized endpoint).`, { [label]: 'https only' });
  }
  if (u.username || u.password) throw badRequest(`${label} must not contain credentials - use the credential fields.`);
  return u.toString().replace(/\/$/, '');
}

function validateConfig(body, dest, cur) {
  const enabled = body.enabled === undefined ? !!(cur && cur.enabled) : body.enabled === true;
  const connectionType = body.connectionType == null || body.connectionType === '' ? null : String(body.connectionType);
  if (connectionType && !dest.connection_types.includes(connectionType)) {
    throw badRequest(`${dest.label} supports: ${dest.connection_types.join(', ')}.`, { connectionType: 'Not supported' });
  }
  const authType = body.authType == null || body.authType === '' ? null : String(body.authType);
  if (authType && !['bearer', 'api_key_header', 'basic', 'oauth2_client_credentials'].includes(authType)) {
    throw badRequest('Unknown authentication type.', { authType: 'Unknown' });
  }
  const short = (v, label, max = 200) => {
    const s = String(v == null ? '' : v).trim();
    if (s.length > max) throw badRequest(`${label} is too long.`);
    return s || null;
  };
  const options = {};
  const o = body.options || {};
  if (o.paths && typeof o.paths === 'object') {
    const paths = {};
    for (const k of ['validate', 'publish', 'job']) {
      const p = String(o.paths[k] || '').trim();
      if (!p) continue;
      if (!/^\/[\w\-./{}%]*$/.test(p) || p.length > 200) throw badRequest(`Path "${k}" must start with / and contain only URL path characters.`);
      paths[k] = p;
    }
    if (Object.keys(paths).length) options.paths = paths;
  }
  if (o.apiKeyHeader) {
    const hname = String(o.apiKeyHeader).trim();
    if (!/^[A-Za-z0-9-]{1,60}$/.test(hname)) throw badRequest('API key header must be a header name such as X-Api-Key.');
    options.apiKeyHeader = hname;
  }
  const v = {
    enabled, connectionType, authType,
    endpointUrl: checkUrl(body.endpointUrl, 'Endpoint URL', { required: enabled && connectionType === 'api' }),
    tokenUrl: checkUrl(body.tokenUrl, 'Token URL', { required: enabled && authType === 'oauth2_client_credentials' }),
    statusUrl: checkUrl(body.statusUrl, 'Status URL'),
    accountId: short(body.accountId, 'Account / employer ID'),
    clientId: short(body.clientId, 'Client ID'),
    options,
  };
  if (enabled && !connectionType) throw badRequest('Choose a connection type before switching it on.', { connectionType: 'Required' });
  if (enabled && connectionType === 'api' && !authType) throw badRequest('Choose how the API authenticates.', { authType: 'Required' });
  return v;
}

/* ================================================================== *
 * public: feeds and the confirmation callback (outside /api)
 * ================================================================== */
export function publishingPublicRoutes() {
  const r = Router();
  const publicHeaders = (res) => {
    res.set('cache-control', 'public, max-age=300');
    res.set('access-control-allow-origin', '*');
    res.set('cross-origin-resource-policy', 'cross-origin');
    res.set('x-robots-tag', 'noindex');
  };
  const websiteRows = () => withUser(ENGINE, (c) => feedRows(c, 'TEAMLINK_WEBSITE'));

  r.get('/feeds/jobs.json', wrap(async (_req, res) => {
    publicHeaders(res);
    res.json(jsonFeed(await websiteRows()));
  }));
  r.get('/feeds/jobs.xml', wrap(async (_req, res) => {
    publicHeaders(res);
    res.type('application/rss+xml; charset=utf-8').send(rssFeed(await websiteRows()));
  }));
  r.get('/feeds/jobs/:id.json', wrap(async (req, res) => {
    const rows = await withUser(ENGINE, (c) => feedRows(c, 'TEAMLINK_WEBSITE', { jobId: String(req.params.id).slice(0, 64) }));
    publicHeaders(res);
    if (!rows.length) { res.set('cache-control', 'no-cache'); return res.status(404).json({ error: 'This job is not on the website.' }); }
    return res.json({ ...publicJob(rows[0]), jsonLd: jobPostingJsonLd(rows[0]) });
  }));

  /* A platform's pull feed. Unknown, switched off, or the wrong token:
     the same 404, so the URL reveals nothing to a guesser. */
  r.get('/feeds/:dest.xml', wrap(async (req, res) => {
    const d = String(req.params.dest || '').toUpperCase();
    if (!DEST_RE.test(d) || OWN.includes(d)) return res.status(404).type('text/plain').send('Not found');
    const integ = await withUser(ENGINE, async (c) =>
      integrationOf((await c.query(`select * from publishing_integrations where destination=$1`, [d])).rows[0]));
    const ok = integ && integ.enabled && ['xml_feed', 'partner_feed'].includes(integ.connectionType)
      && integ.secrets && integ.secrets.feedToken && safeEqual(String(req.query.token || ''), integ.secrets.feedToken);
    if (!ok) return res.status(404).type('text/plain').send('Not found');
    const rows = await withUser(ENGINE, (c) => feedRows(c, d));
    res.set('cache-control', 'private, max-age=60');
    res.set('x-robots-tag', 'noindex');
    return res.type('application/xml; charset=utf-8').send(partnerXmlFeed(rows));
  }));

  /*
   * A platform confirms a posting: HMAC-SHA256 of the raw body with the
   * callback secret the administrator saved, in X-TeamLink-Signature
   * ("sha256=<hex>"). Without a configured secret there is no callback.
   */
  r.post('/hooks/publishing/:dest', express.raw({ type: '*/*', limit: '64kb' }), wrap(async (req, res) => {
    const d = String(req.params.dest || '').toUpperCase();
    if (!DEST_RE.test(d) || OWN.includes(d)) return res.status(404).json({ ok: false });
    const integ = await withUser(ENGINE, async (c) =>
      integrationOf((await c.query(`select * from publishing_integrations where destination=$1`, [d])).rows[0]));
    const secret = integ && integ.enabled && integ.secrets && integ.secrets.callbackSecret;
    if (!secret) return res.status(404).json({ ok: false });
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    const sig = String(req.get('x-teamlink-signature') || '').replace(/^sha256=/i, '');
    if (!safeEqual(sig, hmacHex(secret, raw))) return res.status(401).json({ ok: false, error: 'bad signature' });
    let b;
    try { b = JSON.parse(raw.toString('utf8') || '{}'); } catch { return res.status(400).json({ ok: false, error: 'not JSON' }); }
    const reference = String(b.reference || b.referencenumber || b.referenceNumber || b.jobId || '').slice(0, 64);
    if (!reference) return res.status(400).json({ ok: false, error: 'reference required' });
    const out = await confirmFromPlatform(d, {
      reference,
      externalJobId: b.externalJobId || b.jobKey || b.id || null,
      externalUrl: typeof (b.externalUrl || b.url) === 'string' && /^https?:\/\//i.test(b.externalUrl || b.url) ? (b.externalUrl || b.url) : null,
      status: b.status,
    });
    await withUser(ENGINE, (c) => c.query(
      `insert into publishing_integration_events (destination, event, detail) values ($1,'callback',$2)`,
      [d, `job ${reference}: ${out.ok ? out.status : out.reason}`]));
    return res.status(out.ok ? 200 : 409).json(out);
  }));

  return r;
}
