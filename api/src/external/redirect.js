/**
 * Is this stored URL safe to send a candidate to?
 *
 * The apply redirect never takes a destination from the browser - it
 * reads the URL the sync stored against the job id. That closes the
 * classic open redirect. This is the second line: the stored value is
 * still data from somebody else's system, and it is checked before the
 * server puts it in a Location header.
 *
 * ALWAYS
 *   - http or https only (no javascript:, data:, file:, vbscript: ...)
 *   - no user:password@ in the URL
 *   - a real public host name: not localhost, not an IP address, not
 *     .local / .internal / .lan, and with a proper top-level domain
 *   - a sane length
 *
 * AND, for a source that always links to its own site, that site. An
 * aggregator (JSearch, SerpAPI) or a company board (Greenhouse) links to
 * the employer's own careers page, whose domain cannot be known in
 * advance, so for those the general rules are the check.
 */

const OWN_DOMAINS = {
  naukri: ['naukri.com'],
  linkedin: ['linkedin.com'],
  indeed: ['indeed.com', 'indeed.co.in'],
  shine: ['shine.com'],
  remotive: ['remotive.com', 'remotive.io'],
  lever: ['lever.co'],
  adzuna: ['adzuna.in', 'adzuna.com', 'adzuna.co.uk'],
  jooble: ['jooble.org'],
};

const PRIVATE_SUFFIX = /\.(local|localhost|internal|lan|intranet|home|corp|test|invalid|example)$/i;

/**
 * @param url        the stored application URL
 * @param connector  the source's connector id ('greenhouse', 'naukri', ...)
 * @returns {{ ok:true, url:string } | { ok:false, reason:string }}
 */
export function validateExternalUrl(url, connector) {
  const raw = String(url == null ? '' : url).trim();
  if (!raw) return { ok: false, reason: 'no application URL is stored for this job' };
  if (raw.length > 2048) return { ok: false, reason: 'the URL is too long' };
  if (/[\s<>"'\\]/.test(raw)) return { ok: false, reason: 'the URL contains characters a link cannot' };

  let u;
  try { u = new URL(raw); } catch { return { ok: false, reason: 'the URL is not a valid web address' }; }

  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    return { ok: false, reason: `the ${u.protocol.replace(':', '')} scheme is not allowed` };
  }
  if (u.username || u.password) return { ok: false, reason: 'the URL carries credentials' };

  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!host || host === 'localhost') return { ok: false, reason: 'the URL points at this machine' };
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':') || host.startsWith('[')) {
    return { ok: false, reason: 'the URL points at an IP address, not a site' };
  }
  if (PRIVATE_SUFFIX.test(host)) return { ok: false, reason: 'the URL points at a private network name' };
  if (!/\.[a-z]{2,}$/i.test(host) && !/\.xn--[a-z0-9-]+$/i.test(host)) {
    return { ok: false, reason: 'the URL has no proper domain' };
  }

  const own = OWN_DOMAINS[String(connector || '').toLowerCase()];
  if (own && !own.some((d) => host === d || host.endsWith(`.${d}`))) {
    return { ok: false, reason: `a ${connector} job must link to ${own.join(' or ')}` };
  }
  return { ok: true, url: u.toString() };
}
