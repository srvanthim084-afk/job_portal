/**
 * May a candidate be sent to this stored URL? - the ONE rule.
 *
 * External jobs are applied for on the ORIGINAL site: Apply Now opens the
 * stored URL in a new tab. So the URL the browser is handed must already
 * have passed this check, and the same check guards the server redirect,
 * the tracked click, the sync's quality gate and an admin's "activate":
 *
 *   1. redirect.js's general rules - http(s) only, no credentials, a real
 *      public host (no IP, localhost, private or reserved names)
 *   2. https only
 *   3. the host is one of the source's APPROVED domains (provider defaults
 *      in source-config.js, or the domains an administrator configured for
 *      the source). This allowlist is also the open-redirect guard: a source
 *      with no approved domain has no link a candidate may follow.
 *
 * Greenhouse (a preserved provider) keeps exactly the rule it had before
 * 0108 - (1), and (3) only if an administrator configures domains - because
 * its postings link to each company's own careers site and the owner's rule
 * is that Greenhouse does not change.
 */
import { validateExternalUrl } from './redirect.js';
import { sourcePolicy, hostAllowed } from './source-config.js';

/**
 * @param url    the stored application URL
 * @param src    { provider, connector, sourceId, allowedDomains }
 * @returns { ok:true, url } | { ok:false, code, reason }
 */
export function checkLink(url, src = {}) {
  const v = validateExternalUrl(url, src.connector || src.sourceId);
  if (!v.ok) return { ok: false, code: 'invalid_url', reason: v.reason };
  const policy = sourcePolicy({ provider: src.provider, connector: src.connector, id: src.sourceId,
    allowed_domains: src.allowedDomains });
  if (!policy.preserve) {
    if (!/^https:\/\//i.test(v.url)) return { ok: false, code: 'not_https', reason: 'the link is not https' };
    if (!policy.allowedDomains || !policy.allowedDomains.length) {
      return { ok: false, code: 'domain_not_allowed', reason: 'no approved domain is configured for this source' };
    }
  }
  if (!hostAllowed(v.url, policy.allowedDomains)) {
    return { ok: false, code: 'domain_not_allowed',
      reason: `the link is not on an approved domain for this source (${policy.allowedDomains.join(', ')})` };
  }
  return { ok: true, url: v.url, policy };
}
