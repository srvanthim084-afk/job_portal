/**
 * ExternalJobProvider - one interface over every provider (master prompt
 * §11, §12, §54).
 *
 *   fetchJobs(opts)              raw postings: { status, jobs, error }
 *                                never throws - a failure is a status
 *   normalizeJob(raw, source)    the external_jobs row (normalise.js)
 *   validateJob(job, raw, source) { ok, issues } (quality.js)
 *   getSourceMetadata()          kind, collection mechanism, terms, allowed
 *                                domains, credentials by NAME, status
 *
 * THIN BY DESIGN. The adapters already exist - connectors.js (one per
 * board, Greenhouse's untouched), providers.js (authorized feeds and keyed
 * partner APIs), normalise.js - and this wraps them rather than replacing
 * them, so the sync keeps calling exactly the code it called before.
 *
 * HOW EACH IS AUTHORIZED
 *   greenhouse, lever, remotive      their public, documented board APIs
 *   adzuna, jooble, jsearch, serpapi their APIs, keyed from the environment,
 *                                    under their terms (licence record)
 *   naukri, indeed, shine, linkedin  NO public API: only a licensed partner/
 *                                    employer feed (a 'feed'/'api' source
 *                                    with a complete licence record). Their
 *                                    connector fetches nothing, ever.
 *   other                            an authorized feed/API or hand entry
 */
import { connectorFor } from './connectors.js';
import { collectJobs } from './providers.js';
import { normaliseExternalJob } from './normalise.js';
import { validateJob as check } from './quality.js';
import { PROVIDERS, PROVIDER_IDS, sourcePolicy, providerCatalogue } from './source-config.js';

export function providerFor(id) {
  const key = PROVIDERS[id] ? id : 'other';
  const conn = connectorFor(key);
  return {
    id: key,
    async fetchJobs(opts = {}) {
      try {
        const source = opts.source || null;
        const method = String(source?.job_collection_method || (conn ? 'connector' : 'manual'));
        /* An authorized feed or partner API - the only route for the
           boards with no public API. */
        if (source && (method === 'feed' || method === 'api')) return await collectJobs(source, opts);
        if (method === 'manual') return { status: 'manual', jobs: [] };
        if (!conn) return { status: 'not_configured', jobs: [], error: 'no collection mechanism is configured' };
        if (!conn.configured()) {
          const missing = conn.envKeys.filter((k) => !(process.env[k] && String(process.env[k]).trim()));
          return { status: 'not_configured', jobs: [],
            error: missing.length ? `${missing.join(' and ')} not set in the environment` : (conn.note || 'not configured') };
        }
        return await conn.fetchJobs(opts);
      } catch (err) {
        return { status: 'failed', jobs: [], error: String((err && err.message) || err) };
      }
    },
    normalizeJob(raw, source) {
      return normaliseExternalJob(raw || {}, source || { id: null });
    },
    validateJob(job, raw, source) {
      return check(job, raw || {}, sourcePolicy({ provider: key, ...(source || {}) }));
    },
    getSourceMetadata() {
      return providerCatalogue().find((p) => p.id === key);
    },
  };
}

export const ALL_PROVIDERS = () => PROVIDER_IDS.map(providerFor);
