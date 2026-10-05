/**
 * Does this job match that saved search?
 *
 * ONE ANSWER, TWO PLACES. The candidate sees a saved search's results on
 * the Jobs screen, where the browser filters with `passes()` in
 * web/index.html (the Recommended Jobs page). The server decides what to
 * ALERT about. If the two disagreed, an email would announce "a new job
 * for Driver · Nellore" and Run search would not show it - or the badge
 * would say "3 new" over a list of two. So this is a line-for-line port
 * of `passes()`, and api/test/saved-match-parity.test.mjs runs both over
 * the same jobs and fails on any difference.
 *
 * The filter object IS the screen's own (`STATE.rj.f` plus the search
 * box), not a translation of it, so a saved search loads back into the
 * screen with nothing lost and nothing reinterpreted.
 *
 * LOCATION is the one rule the browser runs through a second function:
 * a location tag keeps the jobs IN that place, the jobs NEAR it (80 km,
 * or the radius the candidate picked if wider) and remote jobs, and drops
 * everything else - the same three bands the results page draws. Here it
 * is answered from the place tree (api/src/place-tree.js), so a search
 * for a district matches the towns in it.
 */
import { z } from 'zod';
import { cleanSearch, voiceMatches } from './voice-semantic.js';

/* The screen's own option lists (web/index.html, filter rail). */
export const EXP_BANDS = ['Fresher', '0–2 Years', '2–5 Years', '5–8 Years', '8+ Years'];
export const WORK_MODES = ['Work From Office', 'Hybrid', 'Remote'];
export const JOB_TYPES = ['Full-time', 'Part-time', 'Contract', 'Internship'];
export const EDUCATION = ['B.Tech', 'M.Tech', 'MCA', 'MBA', 'Any'];
export const POSTED = ['1', '3', '7', '15', '30'];

const norm = (v) => String(v || '').trim().toLowerCase();
const text = (max) => z.string().trim().max(max);
const list = (item, max) => z.array(item).max(max);

/*
 * Only these keys, only these values. A saved search is stored and later
 * replayed into the page, so anything accepted here comes back as page
 * state - an unknown key is refused rather than carried along.
 */
const schema = z.object({
  q: text(120).optional(),
  loc: text(80).optional(),
  locations: list(text(80), 10).optional(),
  locTags: list(text(80), 10).optional(),
  locKm: z.coerce.number().int().min(0).max(500).optional().or(z.literal('')),
  exp: list(z.enum(EXP_BANDS), EXP_BANDS.length).optional(),
  ctcMin: z.coerce.number().min(0).max(1000).optional().or(z.literal('')),
  ctcMax: z.coerce.number().min(0).max(1000).optional().or(z.literal('')),
  modes: list(z.enum(WORK_MODES), WORK_MODES.length).optional(),
  types: list(z.enum(JOB_TYPES), JOB_TYPES.length).optional(),
  skills: text(200).optional(),
  edu: z.enum(EDUCATION).optional().or(z.literal('')),
  posted: z.enum(POSTED).optional().or(z.literal('')),
  company: text(120).optional(),
  /* A saved VOICE search: the normalized criteria (voice-semantic.js
     cleanSearch), matched by meaning instead of the q substring rule. */
  voice: z.record(z.unknown()).optional(),
}).strict();

/** The stored form of a voice search's criteria: only what matching needs, bounded. */
function compactVoice(v) {
  const s = cleanSearch(v);
  if (!s.concepts.length && !s.keywords.length) return null;
  const out = {
    language: s.language, originalQuery: s.originalQuery, normalizedQuery: s.normalizedQuery,
    concepts: s.concepts, keywords: s.keywords, location: s.location,
    role: s.role, skills: s.skills, technologies: s.technologies, industry: s.industry, qualification: s.qualification,
  };
  if (s.experience.length) out.experience = s.experience;
  if (s.jobType.length) out.jobType = s.jobType;
  if (s.years != null) out.years = s.years;
  if (s.fresher) out.fresher = true;
  if (s.remote) out.remote = true;
  return out;
}

/**
 * Validate and put into canonical form: empty values dropped, lists
 * de-duplicated and sorted, whitespace collapsed. Two searches for the
 * same thing then serialise identically, which is what the database's
 * duplicate check (filters_key) compares.
 *
 * @returns {{ ok:true, filters } | { ok:false, details }}
 */
export function normalizeFilters(input) {
  const parsed = schema.safeParse(input && typeof input === 'object' ? input : {});
  if (!parsed.success) {
    const details = {};
    for (const i of parsed.error.issues) {
      const key = i.path.length ? `filters.${i.path.join('.')}` : 'filters';
      details[key] = i.code === 'unrecognized_keys'
        ? `Unknown filter: ${i.keys.join(', ')}`
        : i.message;
    }
    return { ok: false, details };
  }
  const f = parsed.data;
  const out = {};
  const s = (v) => String(v).replace(/\s+/g, ' ').trim();
  for (const k of ['q', 'loc', 'skills', 'company', 'edu', 'posted']) {
    if (f[k] != null && s(f[k]) !== '') out[k] = s(f[k]);
  }
  if (out.loc && /^any location$/i.test(out.loc)) delete out.loc;
  if (out.edu === 'Any') delete out.edu;
  for (const k of ['locations', 'locTags', 'exp', 'modes', 'types']) {
    if (!Array.isArray(f[k])) continue;
    const seen = new Map();
    for (const v of f[k]) {
      const t = s(v);
      if (t && !seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t);
    }
    if (seen.size) out[k] = [...seen.values()].sort((a, b) => a.localeCompare(b));
  }
  for (const k of ['ctcMin', 'ctcMax']) {
    if (f[k] !== '' && f[k] != null && Number.isFinite(Number(f[k]))) out[k] = Number(f[k]);
  }
  if (out.locTags && f.locKm !== '' && Number(f.locKm) > 0) out.locKm = Number(f.locKm);
  if (f.voice) {
    const v = compactVoice(f.voice);
    if (v) out.voice = v;
  }
  return { ok: true, filters: out };
}

/** True when the search would show every open job. */
export function isEmptySearch(filters) {
  return !filters || Object.keys(filters).length === 0;
}

/* ------------------------------------------------------------------ *
 * the label a person reads: "Driver · Nellore · ₹3L+ · Full-time"
 * ------------------------------------------------------------------ */
export function labelFor(f = {}) {
  const parts = [];
  const cap = (v) => String(v).replace(/\b\w/g, (m) => m.toUpperCase());
  parts.push(f.q ? cap(f.q.split(',')[0].trim()) : 'All jobs');
  const places = [...(f.locTags || []), ...(f.locations || []), ...(f.loc ? [f.loc] : [])];
  if (places.length) parts.push(places[0] + (places.length > 1 ? ` +${places.length - 1}` : ''));
  if (f.ctcMin != null) parts.push(`₹${f.ctcMin}L+`);
  if (f.types && f.types.length) parts.push(f.types[0]);
  else if (f.modes && f.modes.length) parts.push(f.modes[0]);
  else if (f.exp && f.exp.length) parts.push(f.exp[0]);
  else if (f.company) parts.push(f.company);
  return parts.join(' · ').slice(0, 80);
}

/* ------------------------------------------------------------------ *
 * the rules - a port of passes() in web/index.html
 * ------------------------------------------------------------------ */

/** Whole days since publication, as the screen counts them. */
export function daysAgoOf(job, now = Date.now()) {
  if (job.publishedAt) {
    const d = Math.floor((now - Date.parse(job.publishedAt)) / 86400000);
    if (!Number.isNaN(d)) return d;
  }
  return Number(job.postedDaysAgo != null ? job.postedDaysAgo : 99);
}

const MODE_MAP = { 'Work From Office': 'onsite', Hybrid: 'hybrid', Remote: 'remote' };

/**
 * @param job    the API job shape (toJob) plus `companyName`
 * @param f      normalised filters
 * @param ctx    { now, locationTier(jobLocation, jobMode, tags, km) -> tier }
 */
export function jobMatchesFilters(job, f = {}, ctx = {}) {
  const j = job || {};
  const companyName = j.companyName || '';

  const q = norm(f.q);
  if (f.voice) {
    /* a voice search matches by meaning: every concept in the title, the
       skills or the description, synonyms included - "python" finds a
       Django job whose advert never says Python in the title */
    if (!voiceMatches(j, f.voice)) return false;
  } else if (q) {
    const hay = norm([j.title, companyName, (j.skills || []).join(' '), j.department].join(' '));
    if (!q.split(',').map((x) => x.trim()).filter(Boolean).some((t) => hay.includes(t))) return false;
  }
  if (f.loc && f.loc !== 'Any Location') {
    if (f.loc === 'Remote') { if (norm(j.mode) !== 'remote') return false; }
    else if (norm(j.location) !== norm(f.loc)) return false;
  }
  const locs = f.locations || [];
  if (locs.length && !locs.includes('Any Location')) {
    const ok = locs.some((l) => (l === 'Remote' ? norm(j.mode) === 'remote' : norm(j.location) === norm(l)));
    if (!ok) return false;
  }
  const exp = f.exp || [];
  if (exp.length) {
    const e = String(j.exp || '');
    const n = (e.match(/\d+/g) || []).map(Number);
    const lo = n[0] != null ? n[0] : 0;
    const hi = n[1] != null ? n[1] : lo;
    const ok = exp.some((b) => {
      if (b === 'Fresher') return lo === 0;
      if (b === '0–2 Years') return lo <= 2;
      if (b === '2–5 Years') return hi >= 2 && lo <= 5;
      if (b === '5–8 Years') return hi >= 5 && lo <= 8;
      return hi >= 8;
    });
    if (!ok) return false;
  }
  if (f.ctcMin != null && f.ctcMin !== '' && Number(j.salaryMax || 0) < Number(f.ctcMin)) return false;
  if (f.ctcMax != null && f.ctcMax !== '' && Number(j.salaryMin || 0) > Number(f.ctcMax)) return false;
  const modes = f.modes || [];
  if (modes.length && !modes.some((m) => norm(j.mode) === MODE_MAP[m])) return false;
  const types = f.types || [];
  if (types.length && !types.some((t) => norm(j.type) === norm(t))) return false;
  if (f.skills) {
    const want = f.skills.split(',').map((x) => norm(x)).filter(Boolean);
    const have = (j.skills || []).map(norm);
    if (!want.every((w) => have.some((s) => s.includes(w)))) return false;
  }
  if (f.edu && f.edu !== 'Any') {
    if (!norm(j.education).includes(norm(f.edu === 'B.Tech' ? 'bachelor' : f.edu))
        && !norm(j.education).includes(norm(f.edu))) return false;
  }
  if (f.posted) { if (daysAgoOf(j, ctx.now) > Number(f.posted)) return false; }
  if (f.company && norm(companyName).indexOf(norm(f.company)) < 0) return false;

  const tags = f.locTags || [];
  if (tags.length) {
    const tierOf = ctx.locationTier || nameOnlyTier;
    if (tierOf(j.location, j.mode, tags, f.locKm || 0) === 'other') return false;
  }
  return true;
}

/* ------------------------------------------------------------------ *
 * location bands
 * ------------------------------------------------------------------ */

const REMOTE = /^(remote|work from home|wfh|anywhere)$/i;
const fold = (v) => String(v || '').split(',')[0].normalize('NFD')
  .replace(/[̀-ͯ]/g, '').trim().toLowerCase();

/*
 * The spellings people use for the same city. The place tree knows most
 * of these as aliases; this covers the case where it is not loaded.
 */
const SAME = [
  ['bangalore', 'bengaluru'], ['gurgaon', 'gurugram'], ['bombay', 'mumbai'],
  ['madras', 'chennai'], ['calcutta', 'kolkata'], ['mysore', 'mysuru'],
  ['vizag', 'visakhapatnam'], ['trivandrum', 'thiruvananthapuram'],
  ['mangalore', 'mangaluru'], ['hubli', 'hubballi'], ['poona', 'pune'],
];
const canon = (v) => {
  const f = fold(v);
  for (const pair of SAME) if (pair.includes(f)) return pair[1];
  return f;
};

/** Without the place tree: the same name, or remote. Nothing is guessed. */
export function nameOnlyTier(jobLoc, jobMode, tags) {
  if (REMOTE.test(String(jobMode || '')) || REMOTE.test(String(jobLoc || ''))) return 'remote';
  return (tags || []).some((t) => canon(t) === canon(jobLoc)) ? 'exact' : 'other';
}

const RANK = { exact: 0, nearby: 1, remote: 2, other: 3 };

/**
 * The tiering the results page draws, answered from the place tree.
 *
 * @param resolve  from treeResolver(): name -> place | null
 * @param distance (a, b) -> km | null
 */
export function makeLocationTier(resolve, distance) {
  return function tier(jobLoc, jobMode, tags, km) {
    if (REMOTE.test(String(jobMode || '')) || REMOTE.test(String(jobLoc || ''))) return 'remote';
    const reach = Math.max(80, Number(km) || 0);
    const j = resolve(jobLoc);
    let best = 'other';
    for (const tag of tags || []) {
      let t = 'other';
      const p = resolve(tag);
      if (canon(tag) === canon(jobLoc)) t = 'exact';
      else if (p && j) {
        const inside = j.ancestors.has(p.id)
          || [...p.sameName].some((id) => id === j.id || j.ancestors.has(id));
        if (inside) t = 'exact';
        else if (p.type === 'state') t = j.state && j.state === p.name ? 'exact' : 'other';
        else {
          const d = distance(p, j);
          if (d != null) t = d <= reach ? 'nearby' : 'other';
          else if (j.state && j.state === p.state) t = 'nearby';
        }
      } else if (p && p.type === 'state') {
        /* "Nellore, Andhra Pradesh" with the town unknown to the tree. */
        t = norm(jobLoc).includes(norm(p.name)) ? 'exact' : 'other';
      }
      if (RANK[t] < RANK[best]) best = t;
    }
    return best;
  };
}

/** The tree-backed tier when the tree is installed, the name rule when not. */
export async function locationTierFunction() {
  try {
    const { treeAvailable, treeResolver, treeDistanceKm } = await import('../place-tree.js');
    if (!treeAvailable()) return nameOnlyTier;
    return makeLocationTier(await treeResolver(), treeDistanceKm);
  } catch {
    return nameOnlyTier;
  }
}
