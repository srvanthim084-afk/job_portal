/**
 * How external jobs are collected, and how an application reaches the
 * outside world.
 *
 * WHAT IS DELIBERATELY ABSENT
 *
 * There is no scraper here, and no code path that logs into anybody's
 * site, solves a challenge, rotates a user agent or retries past a block.
 * Those are the only ways to reach a board that has not published a feed
 * and has not given us keys, and they are all off the table - so a source
 * that has not been authorised simply cannot be collected from, and this
 * module says so rather than trying.
 *
 * Every function follows the convention the notification providers
 * already use: a result object with a `status`, never an exception for the
 * ordinary case of "this is not set up". The statuses that mean nothing
 * happened are as important as the ones that mean something did, because
 * a sync that quietly returns zero jobs is indistinguishable from a
 * source with no vacancies.
 *
 *   not_configured   no feed URL, or the named credential is not in the
 *                    environment
 *   unsupported      this source does not offer this operation at all
 *   manual           there is nothing to fetch; a human enters these
 *   ok / submitted   it worked, and here is what came back
 *   failed           it was attempted and the other end refused
 *
 * AN HTTP 200 IS NOT AN APPLICATION. A submission is only recorded as
 * `applied` when the response actually identifies one. Anything else is
 * `applied_unconfirmed`, which is the truth: we sent something, and we do
 * not know what became of it.
 */
import { config } from '../config.js';

const TIMEOUT_MS = 20000;

/** The key for a source, from the environment, never from the database. */
function credentialFor(source) {
  const name = String(source.credential_env || '').trim();
  if (!name) return null;
  /* Only ever a name a configuration deliberately set. Reading an
     arbitrary variable named by a database row would let whoever can edit
     a source read the process environment. */
  if (!/^[A-Z][A-Z0-9_]{2,60}$/.test(name)) return null;
  const value = process.env[name];
  return value ? String(value) : null;
}

async function fetchJson(url, { token, timeout = TIMEOUT_MS } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    const body = await res.text();
    if (!res.ok) {
      return { ok: false, http: res.status, error: `${res.status} ${body.slice(0, 200)}` };
    }
    try { return { ok: true, http: res.status, json: JSON.parse(body) }; }
    catch { return { ok: false, http: res.status, error: 'the response was not JSON' }; }
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? 'timed out' : String(err.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ *
 * collecting jobs
 * ------------------------------------------------------------------ */

/**
 * Fetch whatever this source currently advertises.
 *
 * @returns { status, jobs, error, http }  `jobs` is raw provider output;
 *          normalising it is `normalise.js`'s job, not this one's.
 */
export async function collectJobs(source, opts = {}) {
  if (!source || source.active !== true) {
    return { status: 'not_configured', jobs: [], error: 'the source is not active' };
  }

  const method = String(source.job_collection_method || 'manual');

  /*
   * A NAMED BOARD, through its own adapter.
   *
   * Everything below speaks one dialect - a URL and an optional bearer
   * token - which is all a partner feed written to order needs and all
   * it can express. Adzuna wants its credentials as query parameters,
   * JSearch wants RapidAPI headers, Jooble wants a POST with the key in
   * the path, and Greenhouse and Lever want a board token per company.
   * Those live in connectors.js, one file's worth of knowledge each, and
   * this is where a source that names one is handed over.
   *
   * The three methods below are untouched: a source that has always been
   * `feed`, `api` or `manual` behaves exactly as it did.
   */
  if (method === 'connector') {
    const { collectViaConnector } = await import('./connectors.js');
    return collectViaConnector(source, opts);
  }

  if (method === 'manual') {
    /* Not a failure. These arrive through the recruiter endpoint, and a
       sync has genuinely nothing to do. */
    return { status: 'manual', jobs: [] };
  }

  if (method === 'feed' || method === 'api') {
    const url = String(source.feed_url || '').trim();
    if (!url) return { status: 'not_configured', jobs: [], error: 'no feed URL is set' };
    if (!/^https:\/\//i.test(url) && config.isProd) {
      return { status: 'not_configured', jobs: [], error: 'the feed URL must be https' };
    }

    /* An `api` source is one that requires a key; a `feed` may be open. */
    const token = credentialFor(source);
    if (method === 'api' && !token) {
      return {
        status: 'not_configured', jobs: [],
        error: source.credential_env
          ? `${source.credential_env} is not set in the environment`
          : 'no credential_env is named for this source',
      };
    }

    const out = await fetchJson(url, { token });
    if (!out.ok) return { status: 'failed', jobs: [], error: out.error, http: out.http };

    /* JSON ONLY, and said out loud. A great many boards publish XML, and
       parsing XML needs a dependency this project does not have - so an
       XML feed is refused with a reason rather than silently yielding
       nothing. */
    const body = out.json;
    const list = Array.isArray(body) ? body
      : Array.isArray(body?.jobs) ? body.jobs
      : Array.isArray(body?.data) ? body.data
      : Array.isArray(body?.results) ? body.results
      : null;
    if (!list) {
      return {
        status: 'failed', jobs: [], http: out.http,
        error: 'the feed did not contain a jobs array (JSON feeds only - XML is not supported)',
      };
    }
    return { status: 'ok', jobs: list.slice(0, config.externalJobs.syncJobLimit), http: out.http };
  }

  return { status: 'unsupported', jobs: [], error: `unknown collection method "${method}"` };
}

/* ------------------------------------------------------------------ *
 * submitting an application
 * ------------------------------------------------------------------ */

/**
 * Put a candidate forward for an external job.
 *
 * @returns { status, ourStatus, externalApplicationId, url, error }
 *   `ourStatus` is the `external_application_statuses` id the caller
 *   should record. It is returned rather than assumed so that the one
 *   decision about what may be called "Applied" lives here.
 */
export async function submitApplication({ source, job, candidate }) {
  const method = String(source?.application_method || 'none');

  if (method === 'none') {
    return {
      status: 'unsupported', ourStatus: 'ready',
      error: 'this source cannot be applied to through TeamLink',
    };
  }

  /*
   * REDIRECT - the honest default.
   *
   * TeamLink records that the candidate was put forward and hands them
   * the advertiser's own application URL. No request is made on their
   * behalf, nothing is automated, and the status says exactly that: we
   * cannot see whether they finished, so it is "Applied - Not Confirmed"
   * until the source tells us otherwise.
   */
  if (method === 'redirect') {
    const url = job?.application_url || null;
    if (!url) {
      return {
        status: 'failed', ourStatus: 'failed',
        error: 'the posting has no application URL to send the candidate to',
      };
    }

    /*
     * A SAMPLE POSTING HAS NOWHERE TO SEND ANYBODY.
     *
     * Seeded postings carry .invalid links - a domain RFC 2606 reserves
     * so that it can never resolve - precisely so nothing pretends to be
     * a real advert. Opening one gave the candidate a browser error page
     * ("DNS_PROBE_FINISHED_NXDOMAIN"), which looks like a broken product
     * rather than the sample data it is.
     *
     * So it is named instead, and the status stays 'ready': nothing was
     * applied for, and recording "Applied - Not Confirmed" against a
     * posting that does not exist would be the same lie in a different
     * place.
     */
    if (/\.invalid(?::\d+)?(?:\/|$)/i.test(url)) {
      return {
        status: 'sample_posting', ourStatus: 'ready', url,
        error: 'This is a sample posting, so there is no real advert to open. '
          + 'Applying will work normally once a real job source is added.',
      };
    }

    /*
     * 'clicked', NOT 'applied_unconfirmed'.
     *
     * Handing somebody a link is not an application. This used to record
     * "Applied on External Site" the moment the button was pressed,
     * which meant the portal asserted the candidate had applied before
     * the candidate had said anything at all - and if they opened the
     * advert and closed it, the record still said they applied.
     *
     * The only honest state here is "they opened it". The candidate's
     * own answer moves it on from there.
     */
    return { status: 'redirect', ourStatus: 'clicked', url };
  }

  /*
   * EMAIL - off unless switched on, because it sends a real message in a
   * real candidate's name. It is wired through the existing notification
   * providers so that it obeys the same allowlist and the same delivery
   * record as every other outbound message, rather than inventing a
   * second way to send mail.
   */
  if (method === 'email') {
    return {
      status: 'not_configured', ourStatus: 'ready',
      error: 'applying by email is not switched on for this deployment',
    };
  }

  /*
   * API - an authorised partner endpoint.
   *
   * There is no such partner configured today, so this returns
   * not_configured rather than pretending. The contract when one exists:
   * POST the candidate summary, and the response must identify the
   * application it created. A 200 with no identifier is NOT an
   * application, and is recorded as unconfirmed.
   */
  if (method === 'api') {
    const token = credentialFor(source);
    const url = String(source.feed_url || '').trim();
    if (!token || !url) {
      return {
        status: 'not_configured', ourStatus: 'ready',
        error: token ? 'no submission URL is set for this source'
          : `${source.credential_env || 'a credential'} is not set in the environment`,
      };
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: `Bearer ${token}`,
        },
        /* Only what an application needs. No password, no internal id, no
           pool status, nothing about TeamLink's own pipeline. */
        body: JSON.stringify({
          externalJobId: job.external_job_id,
          candidate: {
            name: candidate.name,
            email: candidate.email,
            phone: candidate.phone,
            location: candidate.location,
            title: candidate.title,
            experienceYears: candidate.exp_years,
            skills: candidate.skills,
            noticePeriod: candidate.notice_period,
          },
        }),
        signal: ctrl.signal,
      });
      const body = await res.text();
      if (!res.ok) {
        return {
          status: 'failed', ourStatus: 'failed',
          error: `${res.status} ${body.slice(0, 200)}`,
        };
      }
      let parsed = null;
      try { parsed = JSON.parse(body); } catch { /* not JSON */ }
      const id = parsed && (parsed.applicationId || parsed.id || parsed.reference);
      if (!id) {
        return {
          status: 'submitted', ourStatus: 'applied_unconfirmed',
          error: 'the source accepted the request but did not identify an application',
        };
      }
      return { status: 'submitted', ourStatus: 'applied', externalApplicationId: String(id) };
    } catch (err) {
      return {
        status: 'failed', ourStatus: 'failed',
        error: err.name === 'AbortError' ? 'timed out' : String(err.message || err),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return { status: 'unsupported', ourStatus: 'ready', error: `unknown application method "${method}"` };
}

/**
 * Ask a source what became of an application.
 *
 * Only a keyed partner API can answer this. For a redirect there is
 * nothing to ask, and guessing would be worse than admitting it - so the
 * status simply stays where it was and `checked` is false.
 */
export async function checkApplicationStatus({ source, application }) {
  if (String(source?.application_method) !== 'api') {
    return { checked: false, status: 'unsupported',
      error: 'this source does not report application status back' };
  }
  const token = credentialFor(source);
  const base = String(source.feed_url || '').trim();
  if (!token || !base || !application.external_application_id) {
    return { checked: false, status: 'not_configured' };
  }

  const url = `${base.replace(/\/$/, '')}/${encodeURIComponent(application.external_application_id)}`;
  const out = await fetchJson(url, { token });
  if (!out.ok) return { checked: false, status: 'failed', error: out.error };

  /* The source's own wording is kept verbatim and mapped only for
     display. An unrecognised state becomes 'unknown' rather than being
     forced into the nearest thing we have. */
  const theirs = String(out.json?.status || out.json?.state || '').trim();
  return { checked: true, status: 'ok', externalStatus: theirs || null, ourStatus: mapStatus(theirs) };
}

/**
 * Their vocabulary to ours.
 *
 * Anything unrecognised is 'unknown'. This mapping exists ONLY to choose
 * a label for the external-applications list; it never touches, and must
 * never be confused with, TeamLink's own `stages` table.
 */
export function mapStatus(theirs) {
  const s = String(theirs || '').toLowerCase().replace(/[^a-z ]+/g, ' ').trim();
  if (!s) return 'unknown';
  if (/\b(received|submitted|acknowledg)/.test(s)) return 'application_received';
  if (/\b(review|screening|in progress|processing)/.test(s)) return 'under_review';
  if (/\b(shortlist|selected for)/.test(s)) return 'shortlisted';
  if (/\b(interview)/.test(s)) return 'interview';
  if (/\b(reject|declin|not selected|unsuccessful)/.test(s)) return 'rejected';
  if (/\b(withdraw|cancell?ed)/.test(s)) return 'withdrawn';
  if (/\b(fail|error)/.test(s)) return 'failed';
  if (/\b(applied|application sent)/.test(s)) return 'applied';
  return 'unknown';
}
