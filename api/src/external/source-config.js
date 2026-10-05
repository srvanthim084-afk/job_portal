/**
 * The centralised source configuration (master prompt §43, §11-14, §59).
 *
 * ONE place that says, for every provider TeamLink knows about:
 *
 *   kind           public_api    a documented, public endpoint - no key,
 *                                 no licence record needed to switch it on
 *                  keyed_api     a commercial API used under its terms with
 *                                 a key held in the environment
 *                  partner_feed  no public API exists; only a licensed
 *                                 partner or employer feed is acceptable
 *                  other         a feed or API somebody arranged
 *   mechanism      how the data is collected, in words an auditor can check
 *   termsUrl       where that provider's terms for this use are published
 *   allowedDomains where Apply Now may send a candidate for this provider
 *                  (null = the employer's own careers site, which cannot be
 *                  known in advance, so the general URL rules apply)
 *   rateLimit      the most collection calls per minute this sync makes
 *   preserve       the integration's behaviour is kept EXACTLY as it was
 *                  before 0108 (Greenhouse - the owner's standing rule):
 *                  the new checks run in observe-only mode for it
 *
 * Per-source overrides live on the job_sources row (allowed_domains,
 * sync_interval_hours, rate_limit_per_minute, close_grace_days,
 * monthly_quota) and are edited on the Job Sources screen. Credentials are
 * NEVER here and never on the row: a source names the environment variable
 * (credentialsReference), and only whether it is set is ever reported.
 *
 * Naukri, Indeed, Shine and LinkedIn publish no API that permits a third
 * party to pull their listings. They are declared so the screen can say so;
 * they are switched on only through a licensed feed with a complete licence
 * record, and the database refuses anything else (0108's activation guard).
 */
import { config } from '../config.js';
import { connectorFor } from './connectors.js';

/* The same lists redirect.js's OWN_DOMAINS holds for these ids, so the
   redirect check gives the same answer for every existing source. */
export const PROVIDERS = {
  greenhouse: {
    label: 'Greenhouse', kind: 'public_api', preserve: true,
    mechanism: 'Greenhouse Job Board API - public, documented, read-only (GET /v1/boards/{token}/jobs)',
    termsUrl: 'https://developers.greenhouse.io/job-board.html',
    allowedDomains: null, rateLimitPerMinute: null,
  },
  lever: {
    label: 'Lever', kind: 'public_api',
    mechanism: 'Lever Postings API - public, documented, read-only (GET /v0/postings/{company})',
    termsUrl: 'https://github.com/lever/postings-api',
    allowedDomains: ['lever.co'], rateLimitPerMinute: 30,
  },
  remotive: {
    label: 'Remotive', kind: 'public_api',
    mechanism: 'Remotive public jobs API - no key; attribution and link-back required by its terms',
    termsUrl: 'https://github.com/remotive-com/remote-jobs-api',
    allowedDomains: ['remotive.com', 'remotive.io'], rateLimitPerMinute: 2,
  },
  adzuna: {
    label: 'Adzuna', kind: 'keyed_api',
    mechanism: 'Adzuna Search API - app_id + app_key from the environment, used under Adzuna\'s API terms',
    termsUrl: 'https://developer.adzuna.com/',
    allowedDomains: ['adzuna.in', 'adzuna.com', 'adzuna.co.uk'], rateLimitPerMinute: 20,
  },
  jooble: {
    label: 'Jooble', kind: 'keyed_api',
    mechanism: 'Jooble REST API - key from the environment, used under Jooble\'s API terms',
    termsUrl: 'https://jooble.org/api/about',
    allowedDomains: ['jooble.org'], rateLimitPerMinute: 20,
  },
  jsearch: {
    label: 'JSearch', kind: 'keyed_api',
    mechanism: 'JSearch on RapidAPI - key from the environment, used under the RapidAPI/OpenWeb Ninja terms',
    termsUrl: 'https://rapidapi.com/letscrape-6bRBa3QguO5/api/jsearch',
    allowedDomains: null, rateLimitPerMinute: 10,
  },
  serpapi: {
    label: 'Google Jobs (SerpApi)', kind: 'keyed_api',
    mechanism: 'SerpApi Google Jobs API - key from the environment, used under SerpApi\'s terms',
    termsUrl: 'https://serpapi.com/google-jobs-api',
    allowedDomains: null, rateLimitPerMinute: 10,
  },
  naukri: {
    label: 'Naukri', kind: 'partner_feed',
    mechanism: 'Licensed partner / employer feed only. Naukri publishes no API for third parties to pull listings; TeamLink does not scrape it.',
    termsUrl: null,          /* the partner agreement's own terms go on the licence record */
    allowedDomains: ['naukri.com'], rateLimitPerMinute: 10,
  },
  indeed: {
    label: 'Indeed', kind: 'partner_feed',
    mechanism: 'Licensed partner / employer feed only. Indeed publishes no API for third parties to pull listings; TeamLink does not scrape it.',
    termsUrl: null,
    allowedDomains: ['indeed.com', 'indeed.co.in'], rateLimitPerMinute: 10,
  },
  shine: {
    label: 'Shine', kind: 'partner_feed',
    mechanism: 'Licensed partner / employer feed only. Shine publishes no API for third parties to pull listings; TeamLink does not scrape it.',
    termsUrl: null,
    allowedDomains: ['shine.com'], rateLimitPerMinute: 10,
  },
  linkedin: {
    label: 'LinkedIn', kind: 'partner_feed',
    mechanism: 'Licensed partner feed only (LinkedIn Talent Solutions partner programme). LinkedIn publishes no API for third parties to pull listings; TeamLink does not scrape it.',
    termsUrl: null,
    allowedDomains: ['linkedin.com'], rateLimitPerMinute: 10,
  },
  other: {
    label: 'Other', kind: 'other',
    mechanism: 'An authorized JSON feed or API (licence record required), or vacancies entered by hand',
    termsUrl: null, allowedDomains: null, rateLimitPerMinute: null,
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS);
export const PARTNER_ONLY = ['naukri', 'indeed', 'shine', 'linkedin'];

/** The providers whose behaviour 0108 must not change. */
export const PRESERVED = PROVIDER_IDS.filter((p) => PROVIDERS[p].preserve);

const DOMAIN_RE = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

/** Clean an admin-entered domain list; throws on anything that is not one. */
export function cleanDomains(list) {
  if (list == null) return null;
  const out = [];
  for (const raw of Array.isArray(list) ? list : String(list).split(/[\s,]+/)) {
    const d = String(raw || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
      .replace(/^\*\./, '').replace(/\.$/, '');
    if (!d) continue;
    if (!DOMAIN_RE.test(d)) throw new Error(`"${raw}" is not a domain name`);
    if (!out.includes(d)) out.push(d);
  }
  return out.length ? out.slice(0, 30) : null;
}

/** Is `host` one of `domains` or a sub-domain of one? */
export function hostAllowed(url, domains) {
  if (!domains || !domains.length) return true;
  let host = '';
  try { host = new URL(String(url)).hostname.toLowerCase().replace(/\.$/, ''); } catch { return false; }
  return domains.some((d) => host === d || host.endsWith(`.${d}`));
}

/**
 * Everything the system needs to know about one source, with the row's
 * overrides applied to the provider's defaults. Contains no secret.
 */
export function sourcePolicy(row) {
  const provider = PROVIDERS[row?.provider] ? row.provider : (PROVIDERS[row?.connector] ? row.connector : 'other');
  const p = PROVIDERS[provider];
  const conn = row?.connector ? connectorFor(row.connector) : null;
  /* A connector's variable NAMES are already public to staff (GET
     /external/connectors). A feed source's credential_env is not - shapes.js
     keeps it on the server - so it is checked here and never listed. */
  const envKeys = conn ? conn.envKeys : [];
  const checkKeys = conn ? conn.envKeys : (row?.credential_env ? [row.credential_env] : []);
  const rowDomains = Array.isArray(row?.allowed_domains) && row.allowed_domains.length ? row.allowed_domains : null;
  return {
    provider,
    label: p.label,
    kind: p.kind,
    mechanism: p.mechanism,
    termsUrl: p.termsUrl,
    preserve: p.preserve === true,
    /* Where Apply Now may land. */
    allowedDomains: rowDomains || p.allowedDomains || null,
    allowedDomainsSource: rowDomains ? 'source' : (p.allowedDomains ? 'provider' : 'any public site'),
    syncIntervalHours: row?.sync_interval_hours || Math.max(1, Number(config.externalJobs.syncEveryHours) || 6),
    rateLimitPerMinute: row?.rate_limit_per_minute || p.rateLimitPerMinute || null,
    closeGraceDays: row?.close_grace_days || Math.max(1, Number(config.externalJobs.closeGraceDays) || 14),
    monthlyQuota: row?.monthly_quota ?? null,
    /* The NAMES of the variables holding credentials, never the values. */
    credentialsReference: envKeys,
    credentialsConfigured: checkKeys.every((k) => /^[A-Z][A-Z0-9_]{2,60}$/.test(k)
      && !!(process.env[k] && String(process.env[k]).trim())),
    enabledFeatures: {
      sync: String(row?.job_collection_method || 'manual') !== 'manual',
      redirectApply: String(row?.application_method || 'redirect') === 'redirect',
      autoApply: row?.auto_apply_supported === true && config.externalJobs.autoApplyEnabled === true,
    },
    /* The connector id redirect.js's own-domain rule keys on. */
    urlRuleKey: row?.connector || row?.id || null,
  };
}

/** The provider list for the admin screen and the contract tests. */
export function providerCatalogue() {
  return PROVIDER_IDS.map((id) => {
    const p = PROVIDERS[id];
    const conn = connectorFor(id);
    const configured = conn ? conn.configured() : false;
    let status;
    if (p.kind === 'partner_feed') status = 'needs_authorized_feed_and_licence';
    else if (id === 'other') status = 'needs_authorized_feed_and_licence';
    else if (!configured) status = 'needs_credentials';
    else if (p.kind === 'keyed_api') status = 'needs_licence_record';
    else status = 'available';
    return {
      id, label: p.label, kind: p.kind, mechanism: p.mechanism, termsUrl: p.termsUrl,
      allowedDomains: p.allowedDomains, rateLimitPerMinute: p.rateLimitPerMinute,
      preserveBehaviour: p.preserve === true,
      connector: conn ? conn.id : null,
      credentialsReference: conn ? conn.envKeys : [],
      credentialsMissing: conn ? conn.envKeys.filter((k) => !(process.env[k] && String(process.env[k]).trim())) : [],
      configured,
      authorized: p.kind === 'public_api' && configured,
      status,
    };
  });
}
