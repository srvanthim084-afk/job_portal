/**
 * Publishing connectors (0112) - one contract for every destination:
 *
 *   validateCredentials(ctx)          -> { ok, message }
 *   publish(job, pub, ctx)            -> Outcome
 *   update(job, pub, ctx)             -> Outcome
 *   unpublish(job, pub, ctx)          -> Outcome
 *   status(job, pub, ctx)             -> Outcome
 *
 *   Outcome = { state: 'posted' | 'awaiting_confirmation' | 'removed',
 *               externalJobId?, externalUrl?, note? }
 *
 * Anything that is not a confirmed success THROWS a PublishError; the
 * service records it as Failed and retries with backoff. No connector
 * ever returns 'posted' without an external id or URL to show for it.
 *
 * WHO IS CONTACTED. TeamLink's own two destinations touch only this
 * server. A partner connector calls ONLY the endpoint the administrator
 * configured under Administration -> Integrations - nothing is hardcoded,
 * there is no default host, and an unconfigured connector is never asked
 * to do anything (the service stops at "Integration Required"). There is
 * no scraping, no browser automation, no login form and no CAPTCHA
 * anywhere in here: an integration is an authorized API or feed, or it
 * is not available.
 *
 * ADDING A DESTINATION: a row in publishing_destinations, a mapper below
 * (the payload that platform's partner specification asks for), and -
 * only if it speaks something other than JSON-over-HTTPS or a pulled XML
 * feed - a connector of its own.
 */
import { withUser } from '../db.js';
import { config } from '../config.js';
import { feedRows, publicJob, jobPageUrl, websiteEntryUrl, websiteJobUrl, probeBase } from './feed.js';
import { scrub } from './secrets.js';

export class PublishError extends Error {
  constructor(message, { status = null, retryable = true } = {}) {
    super(message);
    this.httpStatus = status;
    this.retryable = retryable;
  }
}

const ENGINE = { userId: '', role: 'admin', profileId: null };
const timeoutMs = (ctx) => Number((ctx && ctx.timeoutMs) || process.env.PUBLISH_HTTP_TIMEOUT_MS || 15000);

async function http(url, { method = 'GET', headers = {}, body, form, timeout = 15000, secrets = {} } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const init = { method, headers: { accept: 'application/json', ...headers }, signal: ctrl.signal, redirect: 'manual' };
    if (form) {
      init.headers['content-type'] = 'application/x-www-form-urlencoded';
      init.body = new URLSearchParams(form).toString();
    } else if (body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await fetch(url, init);
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    return { status: res.status, ok: res.ok, json, text };
  } catch (err) {
    if (err && err.name === 'AbortError') throw new PublishError(`No answer from ${hostOf(url)} within ${Math.round(timeout / 1000)} s (timed out).`);
    throw new PublishError(`Could not reach ${hostOf(url)}: ${scrub((err && err.cause && err.cause.code) || (err && err.message) || 'network error', secrets)}`);
  } finally {
    clearTimeout(timer);
  }
}
const hostOf = (u) => { try { return new URL(u).host; } catch { return 'the endpoint'; } };

/* ================================================================== *
 * TeamLink's own systems - these work now
 * ================================================================== */

/** Is the job readable by an anonymous visitor (RLS, jobs_open)? */
async function publiclyOpen(jobId) {
  const { rows } = await withUser(null, (c) => c.query(`select id from jobs_open where id = $1`, [jobId]));
  return rows.length > 0;
}

/** GET a URL on this server the way a visitor would: no cookies. */
async function probe(path, ctx) {
  return http(`${probeBase()}${path}`, {
    /* identity: the page is the whole application, and compressing it
       for a check that reads one meta tag is wasted work */
    headers: { accept: 'text/html,application/json', 'accept-encoding': 'identity' },
    timeout: Number(process.env.PUBLISH_PROBE_TIMEOUT_MS || 10000),
  });
}

export const portalConnector = {
  key: 'TEAMLINK_PORTAL',
  async validateCredentials() { return { ok: true, message: 'TeamLink Job Portal is part of this system; nothing to configure.' }; },
  /*
   * Posted = the job's public page answers for an anonymous visitor AND
   * names this job. The page is the URL stored on the row.
   */
  async publish(job, _pub, ctx) {
    if (!(await publiclyOpen(job.id))) {
      throw new PublishError('The job is not visible to the public yet (it is not Active, or it is paused, expired or past its walk-in date).');
    }
    const r = await probe(`/job/${encodeURIComponent(job.id)}`, ctx);
    if (r.status !== 200 || !r.text.includes(`name="teamlink:job" content="${job.id}"`)) {
      throw new PublishError(`The public job page answered ${r.status} without this job - not marked Posted.`, { status: r.status });
    }
    return { state: 'posted', externalJobId: job.id, externalUrl: jobPageUrl(job.id) };
  },
  async update(job, pub, ctx) { return this.publish(job, pub, ctx); },
  async unpublish(job) {
    if (await publiclyOpen(job.id)) throw new PublishError('The job is still open to the public.');
    return { state: 'removed', note: 'No longer shown on the portal.' };
  },
  async status(job, pub, ctx) { return this.publish(job, pub, ctx); },
};

export const websiteConnector = {
  key: 'TEAMLINK_WEBSITE',
  async validateCredentials() { return { ok: true, message: 'The TeamLink website feed is served by this system; nothing to configure.' }; },
  /*
   * Posted = the job is in the public website feed, its own feed entry
   * answers to an anonymous request, and - when the company website's own
   * job page is configured (TEAMLINK_WEBSITE_JOB_URL) - that page answers
   * too. The URL stored is the page a visitor opens.
   */
  async publish(job, _pub, ctx) {
    const listed = await withUser(ENGINE, (c) => feedRows(c, 'TEAMLINK_WEBSITE', { jobId: job.id }));
    if (!listed.length) throw new PublishError('The job is not in the website feed (it is not open to the public).');
    const r = await probe(`/feeds/jobs/${encodeURIComponent(job.id)}.json`, ctx);
    if (r.status !== 200 || !r.json || r.json.id !== job.id) {
      throw new PublishError(`The public feed entry answered ${r.status} - not marked Posted.`, { status: r.status });
    }
    const page = websiteJobUrl(job.id);
    if (page) {
      const w = await http(page, { headers: { accept: 'text/html' }, timeout: timeoutMs(ctx) });
      if (w.status !== 200) throw new PublishError(`The website's job page answered ${w.status} - not marked Posted.`, { status: w.status });
      return { state: 'posted', externalJobId: job.id, externalUrl: page };
    }
    return { state: 'posted', externalJobId: job.id, externalUrl: websiteEntryUrl(job.id) };
  },
  async update(job, pub, ctx) { return this.publish(job, pub, ctx); },
  async unpublish(job, _pub, ctx) {
    const r = await probe(`/feeds/jobs/${encodeURIComponent(job.id)}.json`, ctx);
    if (r.status === 200) throw new PublishError('The job is still in the public website feed.');
    return { state: 'removed', note: 'Dropped from the website feed.' };
  },
  async status(job, pub, ctx) { return this.publish(job, pub, ctx); },
};

/* ================================================================== *
 * Partner platforms
 * ================================================================== */

/**
 * The payload each platform's partner API is sent. The field names follow
 * what each platform's employer/partner documentation describes for a job
 * posting; the exact specification is issued by the platform with the
 * integration agreement, and THIS is the one place it is aligned to it.
 */
const MAPPERS = {
  NAUKRI: (j, i) => ({
    referenceCode: j.id,
    accountId: i.accountId || undefined,
    title: j.title,
    jobDescription: [j.description, j.responsibilities.join('\n'), j.requirements.join('\n')].filter(Boolean).join('\n\n'),
    keySkills: j.skills,
    locations: [j.location].filter(Boolean),
    experience: j.experience,
    salary: { label: j.salary, minLakhs: j.salaryMin, maxLakhs: j.salaryMax, currency: 'INR' },
    vacancies: j.openings,
    education: j.education,
    employmentType: j.employmentType,
    workMode: j.workMode,
    walkIn: j.walkin,
    companyName: j.company,
    applyUrl: j.applyUrl,
  }),
  SHINE: (j, i) => ({
    reference_id: j.id,
    employer_id: i.accountId || undefined,
    job_title: j.title,
    description: [j.description, j.responsibilities.join('\n'), j.requirements.join('\n')].filter(Boolean).join('\n\n'),
    skills: j.skills,
    city: j.city, state: j.state, country: j.country,
    experience: j.experience,
    salary: j.salary, salary_min_lpa: j.salaryMin, salary_max_lpa: j.salaryMax,
    openings: j.openings,
    qualification: j.education,
    job_type: j.employmentType,
    walk_in: j.walkin,
    company_name: j.company,
    apply_url: j.applyUrl,
  }),
  INDEED: (j, i) => ({
    referenceNumber: j.id,
    employerId: i.accountId || undefined,
    title: j.title,
    description: [j.description, j.responsibilities.join('\n'), j.requirements.join('\n')].filter(Boolean).join('\n\n'),
    location: { city: j.city, state: j.state, country: j.country, remote: j.remote },
    salary: j.salary,
    jobType: j.employmentType,
    company: j.company,
    url: j.applyUrl,
  }),
};
const genericMapper = (j, i) => ({ ...j, accountId: i.accountId || undefined });

const DEFAULT_PATHS = { validate: '/account', publish: '/jobs', job: '/jobs/{id}' };
const pathOf = (i, k) => String((i.options && i.options.paths && i.options.paths[k]) || DEFAULT_PATHS[k]);
const join = (base, path) => String(base).replace(/\/+$/, '') + '/' + String(path).replace(/^\/+/, '');

/** What is missing before this integration may be used, or '' when nothing is. */
export function missingFor(i) {
  if (!i) return 'Not configured.';
  if (!i.enabled) return 'Switched off in Administration → Integrations.';
  if (!i.connectionType) return 'No connection type chosen.';
  const s = i.secrets;
  if (i.hasSealedSecrets && !s) return 'The stored credentials cannot be read (INTEGRATION_SECRET_KEY is missing or changed).';
  if (i.connectionType === 'api') {
    if (!i.endpointUrl) return 'No authorized API endpoint URL.';
    const need = {
      bearer: ['apiKey'], api_key_header: ['apiKey'], basic: ['clientSecret'],
      oauth2_client_credentials: ['clientSecret'],
    }[i.authType];
    if (!need) return 'No authentication type chosen.';
    if ((i.authType === 'basic' || i.authType === 'oauth2_client_credentials') && !i.clientId) return 'No client ID.';
    if (i.authType === 'oauth2_client_credentials' && !i.tokenUrl) return 'No OAuth token URL.';
    const gap = need.filter((k) => !(s && s[k]));
    if (gap.length) return `Missing credential: ${gap.join(', ')}.`;
    return '';
  }
  if (!(s && s.feedToken)) return 'No feed token - the platform cannot be given a signed feed URL.';
  return '';
}

const tokenCache = new Map();
async function authHeaders(i, ctx) {
  const s = i.secrets || {};
  const h = {};
  if (i.accountId) h['x-account-id'] = i.accountId;
  if (i.authType === 'bearer') h.authorization = `Bearer ${s.apiKey}`;
  else if (i.authType === 'api_key_header') h[String((i.options && i.options.apiKeyHeader) || 'x-api-key').toLowerCase()] = s.apiKey;
  else if (i.authType === 'basic') h.authorization = 'Basic ' + Buffer.from(`${i.clientId}:${s.clientSecret}`).toString('base64');
  else if (i.authType === 'oauth2_client_credentials') {
    const k = `${i.destination}|${i.tokenUrl}|${i.clientId}`;
    const hit = tokenCache.get(k);
    if (hit && hit.until > Date.now() + 30000) h.authorization = `Bearer ${hit.token}`;
    else {
      const r = await http(i.tokenUrl, { method: 'POST', form: { grant_type: 'client_credentials', client_id: i.clientId, client_secret: s.clientSecret },
        timeout: timeoutMs(ctx), secrets: s });
      const tok = r.json && (r.json.access_token || r.json.accessToken);
      if (!r.ok || !tok) throw new PublishError(`The token endpoint refused the client credentials (HTTP ${r.status}).`, { status: r.status });
      tokenCache.set(k, { token: tok, until: Date.now() + 1000 * Number((r.json && r.json.expires_in) || 300) });
      h.authorization = `Bearer ${tok}`;
    }
  }
  return h;
}

const pick = (o, keys) => { for (const k of keys) { const v = k.split('.').reduce((x, p) => (x == null ? x : x[p]), o); if (v != null && v !== '') return String(v); } return null; };
const ID_KEYS = ['externalJobId', 'jobId', 'job_id', 'id', 'data.id', 'data.jobId', 'job.id', 'result.id'];
const URL_KEYS = ['externalUrl', 'jobUrl', 'job_url', 'url', 'data.url', 'job.url', 'result.url'];
const PENDING = /^(pending|queued|processing|under[_ ]?review|in[_ ]?review|submitted|awaiting.*)$/i;
const LIVE = /^(live|active|published|posted|open|approved|ok|success)$/i;
const DEAD = /^(rejected|failed|error|expired|closed|deleted|removed|inactive)$/i;

function describeRefusal(r, s) {
  const msg = pick(r.json || {}, ['error.message', 'message', 'error', 'detail', 'errors.0.message']) || (r.text || '').slice(0, 200);
  const head = r.status === 401 || r.status === 403 ? 'The platform rejected the credentials' : `The platform answered HTTP ${r.status}`;
  return scrub(`${head}${msg ? `: ${msg}` : ''}`, s);
}

/** Reads a success body into an Outcome, refusing one that confirms nothing. */
function outcomeOf(r, i, { allowPending = true } = {}) {
  const j = r.json || {};
  const id = pick(j, ID_KEYS);
  const url = pick(j, URL_KEYS);
  const st = pick(j, ['status', 'state', 'data.status', 'job.status']);
  if (st && DEAD.test(st)) throw new PublishError(scrub(`The platform reports the job as "${st}"${pick(j, ['reason', 'message']) ? ': ' + pick(j, ['reason', 'message']) : ''}.`, i.secrets));
  if (!id && !url) {
    throw new PublishError(`The platform answered HTTP ${r.status} but returned no job id or URL - not marked Posted.`, { status: r.status });
  }
  if (allowPending && st && PENDING.test(st)) return { state: 'awaiting_confirmation', externalJobId: id, externalUrl: url, note: `Platform status: ${st}` };
  return { state: 'posted', externalJobId: id, externalUrl: url };
}

export function partnerApiConnector(destination) {
  const mapper = MAPPERS[destination] || genericMapper;
  const call = async (i, ctx, method, path, body, extra = {}) => {
    const headers = { ...(await authHeaders(i, ctx)), ...extra };
    return http(join(i.endpointUrl, path), { method, headers, body, timeout: timeoutMs(ctx), secrets: i.secrets });
  };
  const jobPath = (i, id) => pathOf(i, 'job').split('{id}').join(encodeURIComponent(id));
  return {
    key: destination,
    async validateCredentials(ctx) {
      const i = ctx.integration;
      const gap = missingFor({ ...i, enabled: true });
      if (gap) return { ok: false, message: gap };
      try {
        const r = await call(i, ctx, 'GET', pathOf(i, 'validate'));
        if (r.ok) return { ok: true, message: `Connected: ${hostOf(i.endpointUrl)} accepted the credentials (HTTP ${r.status}).` };
        return { ok: false, message: describeRefusal(r, i.secrets) };
      } catch (err) {
        return { ok: false, message: scrub(err.message, i.secrets) };
      }
    },
    async publish(job, pub, ctx) {
      const i = ctx.integration;
      /* The same key on every attempt for this (job, destination): a retry
         after a timeout cannot create a second posting on a platform that
         honours idempotency keys. */
      const r = await call(i, ctx, 'POST', pathOf(i, 'publish'), mapper(publicJob(job), i),
        { 'idempotency-key': `teamlink-${job.id}-${destination}` });
      if (!r.ok) throw new PublishError(describeRefusal(r, i.secrets), { status: r.status });
      return outcomeOf(r, i);
    },
    async update(job, pub, ctx) {
      const i = ctx.integration;
      if (!pub.external_job_id) return this.publish(job, pub, ctx);
      const r = await call(i, ctx, 'PUT', jobPath(i, pub.external_job_id), mapper(publicJob(job), i));
      if (!r.ok) throw new PublishError(describeRefusal(r, i.secrets), { status: r.status });
      const o = r.json && (pick(r.json, ID_KEYS) || pick(r.json, URL_KEYS)) ? outcomeOf(r, i) : null;
      /* A 2xx with an empty body to an update of a CONFIRMED posting keeps
         the id and URL the platform already gave. */
      return o || { state: pub.status === 'awaiting_confirmation' ? 'awaiting_confirmation' : 'posted',
        externalJobId: pub.external_job_id, externalUrl: pub.external_url };
    },
    async unpublish(job, pub, ctx) {
      const i = ctx.integration;
      if (!pub.external_job_id) return { state: 'removed', note: 'Was never accepted by the platform.' };
      const r = await call(i, ctx, 'DELETE', jobPath(i, pub.external_job_id));
      if (r.ok || r.status === 404 || r.status === 410) return { state: 'removed', note: r.ok ? 'Removed by the platform.' : 'Already gone on the platform.' };
      throw new PublishError(describeRefusal(r, i.secrets), { status: r.status });
    },
    async status(job, pub, ctx) {
      const i = ctx.integration;
      if (!pub.external_job_id) return this.publish(job, pub, ctx);
      const r = await call(i, ctx, 'GET', jobPath(i, pub.external_job_id));
      if (!r.ok) throw new PublishError(describeRefusal(r, i.secrets), { status: r.status });
      const st = pick(r.json || {}, ['status', 'state', 'data.status', 'job.status']);
      if (st && PENDING.test(st)) return { state: 'awaiting_confirmation', externalJobId: pub.external_job_id, externalUrl: pick(r.json || {}, URL_KEYS) || pub.external_url };
      const o = outcomeOf({ ...r, json: { id: pub.external_job_id, ...(r.json || {}) } }, i, { allowPending: false });
      if (st && !LIVE.test(st)) return { ...o, state: 'awaiting_confirmation', note: `Platform status: ${st}` };
      return o;
    },
  };
}

/**
 * A feed the platform PULLS (Indeed's XML feed; a partner-feed
 * programme). TeamLink lists the job in the signed feed; the platform
 * crawls it on its own schedule. Listing is not posting: the row reads
 * "Listed in feed - awaiting <platform> confirmation" until the platform
 * confirms, through the signed callback or the configured status check.
 */
export function feedConnector(destination, label) {
  const listed = (jobId) => withUser(ENGINE, (c) => feedRows(c, destination, { jobId })).then((r) => r.length > 0);
  const awaiting = (pub) => ({ state: 'awaiting_confirmation', externalJobId: pub.external_job_id || null, externalUrl: pub.external_url || null,
    note: `Listed in feed — awaiting ${label} confirmation` });
  const self = {
    key: destination,
    async validateCredentials(ctx) {
      const i = ctx.integration;
      const gap = missingFor({ ...i, enabled: true });
      if (gap) return { ok: false, message: gap };
      if (!i.statusUrl) {
        return { ok: true, message: `Feed ready at ${config.publicOrigin.replace(/\/$/, '')}/feeds/${destination.toLowerCase()}.xml?token=•••• - give this URL to ${label}. `
          + 'No status endpoint is configured, so confirmation can only arrive through the signed callback.' };
      }
      try {
        const r = await http(i.statusUrl, { headers: await statusHeaders(i), timeout: timeoutMs(ctx), secrets: i.secrets });
        if (r.ok) return { ok: true, message: `Feed ready; the status endpoint ${hostOf(i.statusUrl)} answered HTTP ${r.status}.` };
        return { ok: false, message: describeRefusal(r, i.secrets) };
      } catch (err) { return { ok: false, message: scrub(err.message, i.secrets) }; }
    },
    async publish(job, pub) {
      if (!(await listed(job.id))) throw new PublishError('The job is not in the feed (it is not open to the public).');
      if (pub.status === 'posted' && pub.confirmed_at) return { state: 'posted', externalJobId: pub.external_job_id, externalUrl: pub.external_url };
      return awaiting(pub);
    },
    async update(job, pub, ctx) { return self.publish(job, pub, ctx); },
    async unpublish(job) {
      if (await listed(job.id)) throw new PublishError('The job is still listed in the feed.');
      return { state: 'removed', note: `Dropped from the feed; ${label} removes it on its next crawl.` };
    },
    async status(job, pub, ctx) {
      const i = ctx.integration;
      if (!(await listed(job.id))) throw new PublishError('The job is not in the feed.');
      if (!i.statusUrl) return awaiting(pub);
      const u = new URL(i.statusUrl);
      u.searchParams.set('reference', job.id);
      const r = await http(u.toString(), { headers: await statusHeaders(i), timeout: timeoutMs(ctx), secrets: i.secrets });
      if (r.status === 404) return awaiting(pub);
      if (!r.ok) throw new PublishError(describeRefusal(r, i.secrets), { status: r.status });
      const st = pick(r.json || {}, ['status', 'state']);
      const id = pick(r.json || {}, ID_KEYS);
      const url = pick(r.json || {}, URL_KEYS);
      if (st && DEAD.test(st)) throw new PublishError(`${label} reports the job as "${st}".`);
      if (st && LIVE.test(st) && (id || url)) return { state: 'posted', externalJobId: id, externalUrl: url };
      return awaiting(pub);
    },
  };
  async function statusHeaders(i) {
    const s = i.secrets || {};
    return s.apiKey ? { authorization: `Bearer ${s.apiKey}` } : {};
  }
  return self;
}

/** The connector for a destination and its configuration. */
export function connectorFor(destination, integration, label) {
  if (destination === 'TEAMLINK_PORTAL') return portalConnector;
  if (destination === 'TEAMLINK_WEBSITE') return websiteConnector;
  const t = integration && integration.connectionType;
  if (t === 'xml_feed' || t === 'partner_feed') return feedConnector(destination, label || destination);
  return partnerApiConnector(destination);
}
