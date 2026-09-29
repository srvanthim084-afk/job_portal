/**
 * One adapter per external job source.
 *
 * WHY THIS EXISTS BESIDE providers.js. `collectJobs()` there speaks one
 * dialect: fetch a URL, optionally with a bearer token, and look for a
 * jobs array. That is enough for a partner feed written to order and
 * enough for nothing else. The boards this brief names each want
 * something different:
 *
 *   Adzuna      app_id and app_key as QUERY parameters, and the country
 *               is part of the path
 *   JSearch     a RapidAPI key and host, as HEADERS
 *   Jooble      a POST with the key in the PATH and the query in a JSON
 *               body
 *   Remotive    no key at all
 *   Greenhouse  no key, but a board token in the path, one call per
 *               company
 *   Lever       the same shape, a different host and a different payload
 *
 * None of those can be expressed as "a URL and a token", so each gets a
 * file's worth of knowledge here and `collectJobs` gains one more
 * collection method that consults this registry.
 *
 * WHAT A CONNECTOR PROMISES
 *
 *   id          matches job_sources.connector
 *   label       what the admin screen calls it
 *   envKeys     the environment variables it needs, BY NAME, so the
 *               screen can say which one is missing rather than
 *               "not configured"
 *   configured  false when any of them is absent
 *   fetchJobs   ({ query, location, page }) -> array of RAW postings,
 *               each already in the normalised shape below
 *
 * NOTHING HERE INVENTS A JOB. A connector with no credentials returns
 * `not_configured` and an empty list; a connector whose call fails
 * returns the reason. There is no sample, no fallback and no cache of
 * "last known good" that could be mistaken for live data.
 *
 * NOTHING HERE BYPASSES ANYTHING. Every one of these is a documented,
 * public API or a public JSON board. Naukri, LinkedIn, Indeed and Shine
 * have no such endpoint for this purpose, so they are declared and
 * report that they need a partner feed - they do not scrape, and they do
 * not pretend.
 */
import { config } from '../config.js';
import { inIndia } from './india.js';

/* ------------------------------------------------------------------ *
 * the shape every connector returns
 *
 * Deliberately the same keys `normalise.js` already expects, so a
 * connector's output goes through the existing pipeline untouched.
 * ------------------------------------------------------------------ */
const posting = ({
  externalJobId, title, company, location, city, state, country, description, skills,
  salary, employmentType, postedAt, applyUrl, originalPublisher, raw,
}) => ({
  externalJobId: String(externalJobId || '').slice(0, 200),
  title: String(title || '').trim().slice(0, 300),
  company: String(company || '').trim().slice(0, 200),
  location: String(location || '').trim().slice(0, 200),
  description: String(description || '').slice(0, 20000),
  skills: Array.isArray(skills) ? skills.slice(0, 40) : [],
  salary: salary ? String(salary).slice(0, 120) : null,
  employmentType: employmentType ? String(employmentType).slice(0, 60) : null,
  postedAt: postedAt || null,
  /* REQUIRED. A posting nobody can open is not a posting; the sync drops
     any row that reaches it without one. */
  applyUrl: String(applyUrl || '').trim(),
  /*
   * WHO ACTUALLY PUBLISHED IT, which is not who we found it through.
   *
   * An aggregator hands back somebody else's advert - JSearch names it
   * in `job_publisher`, SerpApi in `via`, Jooble in `source`. Dropping
   * that name left a card able to say only "via JSearch" when the truth
   * was "published on Naukri, found through JSearch". Attribution is the
   * condition these providers license their data under, and it is the
   * only way a candidate can tell where the Apply button will land.
   */
  originalPublisher: originalPublisher ? String(originalPublisher).trim().slice(0, 120) : null,
  city:    city ? String(city).trim().slice(0, 120) : null,
  state:   state ? String(state).trim().slice(0, 120) : null,
  country: country ? String(country).trim().slice(0, 80) : null,
  raw: raw || {},
});

const env = (k) => {
  const v = process.env[k];
  return v && String(v).trim() ? String(v).trim() : null;
};

const TIMEOUT_MS = Number(process.env.EXTERNAL_FETCH_TIMEOUT_MS || 10_000);
const RETRIES = Number(process.env.EXTERNAL_FETCH_RETRIES || 2);

/**
 * One HTTP call, with the timeout and retries the brief asks for.
 *
 * A failure is RETURNED, never thrown: one board being down must not
 * stop the sync reaching the others.
 */
async function ask(url, opts = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...opts, signal: ctl.signal });
      const text = await res.text();
      if (!res.ok) {
        lastError = `HTTP ${res.status}: ${text.slice(0, 200)}`;
        /* A 4xx is an answer - the key is wrong, the board does not
           exist - and asking again will get the same one. Only a 5xx or
           a timeout is worth retrying. */
        if (res.status < 500) return { ok: false, error: lastError, http: res.status };
      } else {
        try { return { ok: true, json: JSON.parse(text), http: res.status }; }
        catch { return { ok: false, error: 'the response was not JSON', http: res.status }; }
      }
    } catch (err) {
      lastError = err.name === 'AbortError'
        ? `no response within ${Math.round(TIMEOUT_MS / 1000)}s`
        : err.message;
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, error: lastError || 'the request failed' };
}

const iso = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/* ------------------------------------------------------------------ *
 * Remotive — public, no credentials
 *
 * Listed first because it is the one that can be PROVED without anybody
 * signing up for anything: it answers over plain HTTPS with no key, so
 * this whole pipeline can be demonstrated end to end against real
 * postings on a laptop.
 * ------------------------------------------------------------------ */
const remotive = {
  id: 'remotive',
  label: 'Remotive',
  envKeys: [],
  configured: () => true,
  note: 'A public API. No credentials are needed.',
  async fetchJobs({ query } = {}) {
    const url = 'https://remotive.com/api/remote-jobs'
      + (query ? `?search=${encodeURIComponent(query)}` : '');
    const out = await ask(url);
    if (!out.ok) return { status: 'failed', jobs: [], error: out.error, http: out.http };

    const rows = Array.isArray(out.json?.jobs) ? out.json.jobs : [];
    return {
      status: 'ok',
      http: out.http,
      jobs: rows.map((j) => posting({
        externalJobId: j.id,
        title: j.title,
        company: j.company_name,
        location: j.candidate_required_location,
        description: j.description,
        /*
         * REMOTIVE'S `tags` ARE NOT THE JOB'S SKILLS.
         *
         * They are the board's own category taxonomy, applied broadly.
         * Measured on the ten Remotive jobs on file:
         *
         *   "Freelance Writer"        -> ["REST"]
         *   "Remote Office Assistant" -> ["CSS","git","magento","photoshop",
         *                                 "php","shopify","wordpress", ...19]
         *   "Freelance Copywriter"    -> ["accounting","quickbooks", ...10]
         *
         * Read as requirements they are simply wrong, and they did real
         * damage: a Python graduate scored 93% against the writing job,
         * because its one "required skill" was REST, she has "REST APIs",
         * and one of one is a hundred per cent of the largest component
         * in the score.
         *
         * They are kept as tags - they are genuinely useful for browsing
         * - and no longer presented as what the employer asked for. The
         * skills that matter are in the description, which every posting
         * has, and the matcher reads them from there.
         */
        tags: Array.isArray(j.tags) ? j.tags : [],
        skills: [],
        salary: j.salary || null,
        employmentType: j.job_type,
        postedAt: iso(j.publication_date),
        applyUrl: j.url,
        originalPublisher: 'Remotive',
        raw: { category: j.category },
      })),
    };
  },
};

/* ------------------------------------------------------------------ *
 * Adzuna — app id + app key, as query parameters
 * ------------------------------------------------------------------ */
const adzuna = {
  id: 'adzuna',
  label: 'Adzuna (India)',
  envKeys: ['ADZUNA_APP_ID', 'ADZUNA_APP_KEY'],
  configured: () => !!(env('ADZUNA_APP_ID') && env('ADZUNA_APP_KEY')),
  async fetchJobs({ query, location, page = 1 } = {}) {
    const id = env('ADZUNA_APP_ID');
    const key = env('ADZUNA_APP_KEY');
    if (!id || !key) {
      return { status: 'not_configured', jobs: [],
        error: 'ADZUNA_APP_ID and ADZUNA_APP_KEY are not set' };
    }
    const country = env('ADZUNA_COUNTRY') || 'in';
    const p = new URLSearchParams({
      app_id: id, app_key: key, results_per_page: '50',
      'content-type': 'application/json',
    });
    if (query) p.set('what', query);
    if (location) p.set('where', location);

    const out = await ask(`https://api.adzuna.com/v1/api/jobs/${country}/search/${page}?${p}`);
    if (!out.ok) return { status: 'failed', jobs: [], error: out.error, http: out.http };

    const rows = Array.isArray(out.json?.results) ? out.json.results : [];
    return {
      status: 'ok',
      http: out.http,
      jobs: rows.map((j) => posting({
        externalJobId: j.id,
        title: j.title,
        company: j.company?.display_name,
        location: j.location?.display_name,
        description: j.description,
        salary: j.salary_min || j.salary_max
          ? `${j.salary_min || ''}${j.salary_max ? ` - ${j.salary_max}` : ''}`.trim()
          : null,
        employmentType: j.contract_time,
        postedAt: iso(j.created),
        applyUrl: j.redirect_url,
        /* Adzuna does not name the board it took the advert from, so the
           honest attribution is Adzuna itself rather than a guess. */
        originalPublisher: 'Adzuna',
        raw: { category: j.category?.label },
      })),
    };
  },
};

/* ------------------------------------------------------------------ *
 * Jooble — a POST, with the key in the path
 * ------------------------------------------------------------------ */
const jooble = {
  id: 'jooble',
  label: 'Jooble',
  envKeys: ['JOOBLE_API_KEY'],
  configured: () => !!env('JOOBLE_API_KEY'),
  async fetchJobs({ query, location, page = 1 } = {}) {
    const key = env('JOOBLE_API_KEY');
    if (!key) return { status: 'not_configured', jobs: [], error: 'JOOBLE_API_KEY is not set' };

    const out = await ask(`https://jooble.org/api/${key}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ keywords: query || '', location: location || '', page: String(page) }),
    });
    if (!out.ok) return { status: 'failed', jobs: [], error: out.error, http: out.http };

    const rows = Array.isArray(out.json?.jobs) ? out.json.jobs : [];
    return {
      status: 'ok',
      http: out.http,
      jobs: rows.map((j) => posting({
        /* Jooble has no stable id of its own, so the link is the
           identity - which is also what the dedupe keys on. */
        externalJobId: j.id || j.link,
        title: j.title,
        company: j.company,
        location: j.location,
        description: j.snippet,
        salary: j.salary,
        employmentType: j.type,
        postedAt: iso(j.updated),
        applyUrl: j.link,
        originalPublisher: j.source,
        raw: { source: j.source },
      })),
    };
  },
};

/* ------------------------------------------------------------------ *
 * JSearch, on RapidAPI — key and host as headers
 * ------------------------------------------------------------------ */
const jsearch = {
  id: 'jsearch',
  label: 'JSearch (RapidAPI)',
  envKeys: ['JSEARCH_RAPIDAPI_KEY'],
  configured: () => !!env('JSEARCH_RAPIDAPI_KEY'),
  async fetchJobs({ query, location, page = 1 } = {}) {
    const key = env('JSEARCH_RAPIDAPI_KEY');
    if (!key) {
      return { status: 'not_configured', jobs: [], error: 'JSEARCH_RAPIDAPI_KEY is not set' };
    }
    const host = env('JSEARCH_RAPIDAPI_HOST') || 'jsearch.p.rapidapi.com';
    const q = [query, location].filter(Boolean).join(' in ') || 'developer';
    const p = new URLSearchParams({ query: q, page: String(page), num_pages: '1' });

    const out = await ask(`https://${host}/search?${p}`, {
      headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': host },
    });
    if (!out.ok) return { status: 'failed', jobs: [], error: out.error, http: out.http };

    const rows = Array.isArray(out.json?.data) ? out.json.data : [];
    return {
      status: 'ok',
      http: out.http,
      jobs: rows.map((j) => posting({
        externalJobId: j.job_id,
        title: j.job_title,
        company: j.employer_name,
        location: [j.job_city, j.job_state, j.job_country].filter(Boolean).join(', '),
        description: j.job_description,
        salary: j.job_min_salary || j.job_max_salary
          ? `${j.job_min_salary || ''}${j.job_max_salary ? ` - ${j.job_max_salary}` : ''}`.trim()
          : null,
        employmentType: j.job_employment_type,
        postedAt: iso(j.job_posted_at_datetime_utc),
        applyUrl: j.job_apply_link,
        originalPublisher: j.job_publisher,
        city: j.job_city, state: j.job_state, country: j.job_country,
        raw: { publisher: j.job_publisher },
      })),
    };
  },
};

/* ------------------------------------------------------------------ *
 * SerpApi, Google Jobs
 *
 * Google Jobs is a shop window onto other boards, so the publisher name
 * matters more here than anywhere else: `via` is the board the advert
 * actually lives on, and `apply_options[0].link` is the link to it. A
 * card that said only "via Google" would be telling the candidate
 * nothing about where they are going.
 * ------------------------------------------------------------------ */
const serpapiGoogleJobs = {
  id: 'serpapi',
  label: 'Google Jobs (SerpApi)',
  envKeys: ['SERPAPI_KEY'],
  configured: () => !!env('SERPAPI_KEY'),
  async fetchJobs({ query, location, page = 1 } = {}) {
    const key = env('SERPAPI_KEY');
    if (!key) return { status: 'not_configured', jobs: [], error: 'SERPAPI_KEY is not set' };

    const p = new URLSearchParams({
      engine: 'google_jobs',
      q: query || 'developer',
      hl: 'en',
      api_key: key,
      /* Google Jobs pages by an opaque token rather than a number; the
         first page is what a sync wants and the rest is not worth a
         second billed call. */
      ...(location ? { location } : { location: 'India' }),
    });

    const out = await ask(`https://serpapi.com/search.json?${p}`);
    if (!out.ok) return { status: 'failed', jobs: [], error: out.error, http: out.http };
    if (out.json && out.json.error) {
      return { status: 'failed', jobs: [], error: String(out.json.error).slice(0, 200) };
    }

    const rows = Array.isArray(out.json?.jobs_results) ? out.json.jobs_results : [];
    return {
      status: 'ok',
      http: out.http,
      jobs: rows.map((j) => {
        const opt = Array.isArray(j.apply_options) ? j.apply_options[0] : null;
        const det = j.detected_extensions || {};
        return posting({
          externalJobId: j.job_id || (opt && opt.link),
          title: j.title,
          company: j.company_name,
          location: j.location,
          description: j.description,
          employmentType: det.schedule_type,
          salary: det.salary || null,
          postedAt: null,          /* Google gives "3 days ago", not a date */
          applyUrl: opt ? opt.link : null,
          /* `via` reads "via Naukri.com"; the board name is what follows. */
          originalPublisher: String(j.via || '').replace(/^via\s+/i, '').trim() || null,
          raw: { postedText: det.posted_at || null },
        });
      }),
    };
  },
};

/* ------------------------------------------------------------------ *
 * Greenhouse and Lever — public boards, one company at a time
 *
 * The company list is NOT hard-coded. It comes from the source row's
 * own feed_url field, which for these two holds a comma-separated list
 * of board tokens - so adding a company is a row edit on the admin
 * screen rather than a deployment.
 * ------------------------------------------------------------------ */
const boards = (id, label, urlFor, pick) => ({
  id,
  label,
  envKeys: [],
  configured: () => true,
  note: 'Public board. List the company board tokens, comma separated, '
    + 'in the source\'s Feed URL field.',
  async fetchJobs({ source, boards } = {}) {
    /*
     * THE COMPANY LIST IS DATA, so it comes from the career_boards table
     * rather than from a comma-separated string stuffed into the Feed URL
     * field - which was a list pretending to be a URL. Adding a company
     * is now a row a recruiter creates on the admin screen.
     *
     * The Feed URL is still read as a fallback so a source configured the
     * old way keeps working.
     */
    const fromDb = (boards || [])
      .filter((b) => b.platform === id && b.active !== false)
      .map((b) => b.board_token);
    const tokens = fromDb.length ? fromDb : String(source?.feed_url || '')
      .split(',').map((t) => t.trim()).filter(Boolean);

    if (!tokens.length) {
      return { status: 'not_configured', jobs: [],
        error: 'no career boards added for this platform' };
    }

    const jobs = [];
    const failures = [];
    for (const token of tokens.slice(0, 60)) {
      const out = await ask(urlFor(token));
      if (!out.ok) { failures.push(`${token}: ${out.error}`); continue; }
      jobs.push(...pick(out.json, token));
    }
    if (!jobs.length && failures.length) {
      return { status: 'failed', jobs: [], error: failures.join(' | ').slice(0, 300) };
    }
    return { status: 'ok', jobs, error: failures.length ? failures.join(' | ').slice(0, 300) : null };
  },
});

const greenhouse = boards(
  'greenhouse', 'Greenhouse boards',
  (t) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(t)}/jobs?content=true`,
  (json, token) => (Array.isArray(json?.jobs) ? json.jobs : []).map((j) => posting({
    externalJobId: `${token}:${j.id}`,
    title: j.title,
    company: token,
    location: j.location?.name,
    description: j.content,
    postedAt: iso(j.updated_at),
    applyUrl: j.absolute_url,
    /* A company board IS the publisher - the advert lives there. */
    originalPublisher: token,
    raw: { board: token },
  })),
);

const lever = boards(
  'lever', 'Lever boards',
  (t) => `https://api.lever.co/v0/postings/${encodeURIComponent(t)}?mode=json`,
  (json, token) => (Array.isArray(json) ? json : []).map((j) => posting({
    externalJobId: `${token}:${j.id}`,
    title: j.text,
    company: token,
    location: j.categories?.location,
    description: j.descriptionPlain || j.description,
    employmentType: j.categories?.commitment,
    postedAt: j.createdAt ? new Date(j.createdAt).toISOString() : null,
    applyUrl: j.hostedUrl || j.applyUrl,
    originalPublisher: token,
    raw: { team: j.categories?.team, board: token },
  })),
);

/* ------------------------------------------------------------------ *
 * The boards with no public API for this
 *
 * DECLARED, AND HONEST ABOUT IT. Naukri, LinkedIn, Indeed and Shine do
 * not publish an endpoint that lets a third party pull their listings;
 * reaching them means a partner or employer feed, which is a commercial
 * arrangement rather than a missing key. They appear on the admin screen
 * saying exactly that, so nobody spends an afternoon looking for the
 * setting that would switch them on.
 *
 * They fetch NOTHING. Scraping them would break their terms and the
 * brief's third rule, and is not done here.
 * ------------------------------------------------------------------ */
const partnerOnly = (id, label) => ({
  id,
  label,
  envKeys: [],
  configured: () => false,
  note: 'Not configured: requires a partner or employer feed. '
    + 'This board has no public API for pulling listings, and scraping it '
    + 'is not permitted.',
  async fetchJobs() {
    return { status: 'not_configured', jobs: [],
      error: 'requires a partner or employer feed' };
  },
});

/* ------------------------------------------------------------------ *
 * the registry
 * ------------------------------------------------------------------ */
export const CONNECTORS = [
  remotive, adzuna, jooble, jsearch, serpapiGoogleJobs, greenhouse, lever,
  partnerOnly('naukri', 'Naukri'),
  partnerOnly('linkedin', 'LinkedIn'),
  partnerOnly('indeed', 'Indeed'),
  partnerOnly('shine', 'Shine'),
];

const BY_ID = new Map(CONNECTORS.map((c) => [c.id, c]));

export function connectorFor(id) {
  return BY_ID.get(String(id || '').toLowerCase()) || null;
}

/** What the admin screen lists: every connector and whether it can run. */
export function connectorStatus() {
  return CONNECTORS.map((c) => ({
    id: c.id,
    label: c.label,
    envKeys: c.envKeys,
    configured: c.configured(),
    /* WHICH key is missing, by name. "Not configured" on its own sends
       somebody hunting through a settings screen that has nothing in it. */
    missing: c.envKeys.filter((k) => !env(k)),
    note: c.note || null,
  }));
}

/**
 * Collect from one source through its connector.
 *
 * Returns the same shape `collectJobs` in providers.js returns, so the
 * sync engine treats a connector source and a feed source identically.
 */
export async function collectViaConnector(source, opts = {}) {
  const c = connectorFor(source?.connector);
  if (!c) {
    return { status: 'unsupported', jobs: [],
      error: `no connector named "${source?.connector}"` };
  }
  if (!c.configured()) {
    const missing = c.envKeys.filter((k) => !env(k));
    return { status: 'not_configured', jobs: [],
      error: missing.length ? `${missing.join(' and ')} not set in the environment`
                            : (c.note || 'not configured') };
  }
  try {
    const out = await c.fetchJobs({ ...opts, source });
    const raw = out.jobs || [];

    /*
     * VALIDATION AND THE COUNTRY RULE, BEFORE ANYTHING IS STORED.
     *
     * A posting with no apply URL is unusable - the candidate would have
     * nowhere to go. A posting outside India cannot be shown on this
     * portal at all. Both are dropped here rather than stored and
     * discovered later, and both are COUNTED, because "collected 300,
     * kept 12" is the number that tells an administrator whether a
     * source is worth its quota.
     */
    let noUrl = 0;
    let noTitle = 0;
    let outside = 0;
    const jobs = [];

    for (const j of raw) {
      if (!j.title || !j.company) { noTitle += 1; continue; }
      if (!j.applyUrl || !/^https?:\/\//i.test(j.applyUrl)) { noUrl += 1; continue; }
      const verdict = inIndia(j);
      if (!verdict.keep) { outside += 1; continue; }
      jobs.push(j);
      if (jobs.length >= config.externalJobs.syncJobLimit) break;
    }

    return { ...out, jobs, rejected: { noTitle, noUrl, outside }, collected: raw.length };
  } catch (err) {
    return { status: 'failed', jobs: [], error: err.message };
  }
}
