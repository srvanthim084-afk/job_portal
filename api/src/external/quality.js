/**
 * Data-quality validation before a posting is stored (master prompt §17).
 *
 * `validateJob` looks at the NORMALISED posting (normalise.js) and the raw
 * one it came from, and returns every problem it finds, each with a code
 * an administrator can filter on and a sentence that says what is wrong.
 * An `error` keeps the posting out of the portal (it is quarantined with
 * the reasons); a `warning` is recorded but does not stop it.
 *
 * It never rewrites a field. A posting is stored as the source sent it or
 * not at all - "fixing" an employer's advert would be inventing content.
 *
 * Pure: no database, no network. The sync calls it; so do the contract
 * tests.
 */
import { createHash } from 'node:crypto';
import { checkLink } from './link.js';

const str = (v) => String(v == null ? '' : v);

/** Visible text of a description, for "is there anything to read". */
export function visibleText(html) {
  return str(html)
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&').replace(/&nbsp;/gi, ' ')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#?[a-z0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A stable key for a posting, even one that arrived without an id. */
export function fingerprintOf(raw, job) {
  const id = str(job?.externalJobId || raw?.externalJobId || raw?.external_job_id || raw?.id || raw?.jobId).trim();
  if (id) return id.slice(0, 200);
  const h = createHash('sha1')
    .update(`${str(raw?.title || raw?.jobTitle)}|${str(raw?.company)}|${str(raw?.applyUrl || raw?.applicationUrl || raw?.url)}`)
    .digest('hex').slice(0, 24);
  return `nohash:${h}`;
}

export const MIN_DESCRIPTION_CHARS = 20;

/**
 * @param job     normaliseExternalJob(raw, source), or null when it gave up
 * @param raw     what the provider sent
 * @param policy  sourcePolicy(source) - allowed domains and the URL rule key
 * @returns { ok, issues: [{ code, severity, field, message }] }
 */
export function validateJob(job, raw, policy = {}, { now = new Date() } = {}) {
  const issues = [];
  const err = (code, field, message) => issues.push({ code, severity: 'error', field, message });
  const warn = (code, field, message) => issues.push({ code, severity: 'warning', field, message });

  if (!job) {
    const hasId = !!str(raw?.externalJobId ?? raw?.external_job_id ?? raw?.id ?? raw?.jobId).trim();
    const hasTitle = !!str(raw?.title ?? raw?.jobTitle ?? raw?.designation).trim();
    if (!hasId) err('missing_source_job_id', 'sourceJobId', 'The source sent no id for this posting, so it cannot be kept up to date.');
    if (!hasTitle) err('missing_title', 'title', 'The posting has no title.');
    if (hasId && hasTitle) err('unusable', 'posting', 'The posting could not be read.');
    return { ok: false, issues };
  }

  if (!str(job.title).trim()) err('missing_title', 'title', 'The posting has no title.');
  if (!str(job.externalJobId).trim()) err('missing_source_job_id', 'sourceJobId', 'The source sent no id for this posting.');
  if (!str(job.company).trim()) err('missing_company', 'company', 'The posting does not name the employer.');
  if (!job.sourceId) err('invalid_source', 'source', 'The posting is not tied to a known source.');

  /* The URL a candidate will be sent to - the same rule the redirect uses,
     so nothing is stored that Apply Now would refuse. */
  const rawUrl = str(raw?.applicationUrl ?? raw?.application_url ?? raw?.url ?? raw?.applyUrl).trim();
  if (!job.applicationUrl) {
    err(rawUrl ? 'invalid_url' : 'missing_url', 'originalJobUrl', rawUrl
      ? 'The application link is not an http(s) web address.'
      : 'The posting has no link to the original advert, so there would be nowhere to apply.');
  } else {
    /* The same rule Apply Now uses, so nothing is stored that a candidate
       could not be sent to (link.js). */
    const v = checkLink(job.applicationUrl, { provider: policy.provider, connector: policy.urlRuleKey,
      allowedDomains: policy.allowedDomains });
    if (!v.ok) {
      err(v.code, 'originalJobUrl', v.code === 'invalid_url'
        ? `The application link is not safe to send a candidate to: ${v.reason}.`
        : `The application link cannot be used: ${v.reason}.`);
    } else if (!/^https:/i.test(job.applicationUrl)) {
      warn('insecure_url', 'originalJobUrl', 'The application link uses http, not https.');
    }
  }

  const text = visibleText(job.description);
  if (!text) err('missing_description', 'description', 'The posting has no description.');
  else if (text.length < MIN_DESCRIPTION_CHARS) {
    err('description_unusable', 'description', `The description is too short to be useful (${text.length} characters).`);
  }

  if (!str(job.location).trim()) warn('missing_location', 'location', 'The posting does not say where the job is.');
  else if (!/[a-z]/i.test(job.location)) err('invalid_location', 'location', 'The location is not readable.');

  const posted = job.postedAt instanceof Date ? job.postedAt : (job.postedAt ? new Date(job.postedAt) : null);
  const rawPosted = raw?.postedAt ?? raw?.posted_at ?? raw?.datePosted ?? raw?.createdAt;
  if (rawPosted && !posted) warn('invalid_posted_date', 'postedAt', 'The posting date could not be read.');
  if (posted && posted.getTime() > now.getTime() + 2 * 86400000) {
    err('posted_in_future', 'postedAt', 'The posting date is in the future.');
  }
  const rawExpiry = raw?.expiresAt ?? raw?.expires_at ?? raw?.validThrough ?? raw?.expiryDate;
  if (rawExpiry) {
    const ex = new Date(rawExpiry);
    if (Number.isNaN(ex.getTime())) warn('invalid_expiry_date', 'expiresAt', 'The closing date could not be read.');
    else if (posted && ex.getTime() < posted.getTime()) err('expires_before_posted', 'expiresAt', 'The closing date is before the posting date.');
    else if (ex.getTime() < now.getTime()) err('already_expired', 'expiresAt', 'The posting has already closed.');
  }

  return { ok: !issues.some((i) => i.severity === 'error'), issues };
}

/** The error codes only, for storage and counting. */
export const reasonCodes = (verdict) => verdict.issues.filter((i) => i.severity === 'error').map((i) => i.code);
