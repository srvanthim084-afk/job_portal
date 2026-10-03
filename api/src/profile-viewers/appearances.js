/**
 * Search appearances: "your profile appeared in 42 recruiter searches".
 *
 * COUNTED FOR THE PAGE THE RECRUITER LOOKED AT, NOT THE MATCH SET. The
 * Find Candidates screen fetches a window of up to 200 matches and pages
 * through it in the browser, so counting every row the server returned
 * would credit candidates nobody ever saw. Instead:
 *
 *   1. GET /api/candidates, when it is a real search (some criterion was
 *      given), hands back an `appearanceToken`: an HMAC over the caller,
 *      the time, the ids it returned and a sample of the query (role and
 *      city only).
 *   2. The page reports which of those ids were on the page shown, with
 *      the token. The server credits only ids that are IN the token, only
 *      for the user it was issued to, only within two hours, and each id
 *      at most once per token.
 *
 * So the browser cannot invent an appearance - it can only say which of
 * the server's own results were displayed.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

const MAX_AGE_MS = 2 * 60 * 60 * 1000;
const MAX_IDS = 500;

const sign = (payload) => createHmac('sha256', config.authSecret || 'dev')
  .update(`search-appearance:${payload}`).digest('base64url');

/** Which query keys make a request a SEARCH rather than a plain list. */
const SEARCH_KEYS = ['q', 'skills', 'location', 'placeIds', 'expMin', 'expMax', 'education',
  'noticePeriod', 'industry', 'employment', 'ctcMin', 'ctcMax'];

export function isSearch(q = {}) {
  return SEARCH_KEYS.some((k) => q[k] !== undefined && String(q[k]).trim() !== '');
}

const clean = (v, n = 60) => String(v || '').replace(/[\u0000-\u001f<>]/g, ' ')
  .replace(/\s+/g, ' ').trim().slice(0, n);

/** Role and city only - never who searched, never a company. */
export function sampleFromQuery(q = {}) {
  const first = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean)[0] || '';
  const role = clean(q.q) || clean(first(q.skills));
  const city = clean(first(q.location));
  const out = {};
  if (role) out.role = role;
  if (city) out.city = city;
  return out;
}

/**
 * The token for one search response, or null when it was not a search.
 * @param session req.session
 * @param q       req.query
 * @param ids     the candidate ids returned
 */
export function appearanceToken(session, q, ids) {
  if (!session || !session.userId || !ids || !ids.length || !isSearch(q)) return null;
  if (!['recruiter', 'bde', 'admin', 'client'].includes(session.role)) return null;
  const body = Buffer.from(JSON.stringify({
    u: session.userId, t: Date.now(), ids: ids.slice(0, MAX_IDS), s: sampleFromQuery(q),
  })).toString('base64url');
  return `${body}.${sign(body)}`;
}

/** The token's contents when it is genuine, fresh and the caller's own; else null. */
export function readAppearanceToken(token, session, now = Date.now()) {
  const s = String(token || '');
  const dot = s.lastIndexOf('.');
  if (dot < 1 || !session || !session.userId) return null;
  const body = s.slice(0, dot);
  const given = Buffer.from(s.slice(dot + 1));
  const want = Buffer.from(sign(body));
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  let p;
  try { p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
  if (!p || p.u !== session.userId || !Array.isArray(p.ids)) return null;
  if (!(now - Number(p.t) >= 0 && now - Number(p.t) < MAX_AGE_MS)) return null;
  return { ids: new Set(p.ids.map(String)), sample: p.s || {}, issuedAt: Number(p.t), sig: s.slice(dot + 1) };
}

/* Each id once per token. In memory and bounded: a restart could at
   worst let one page be counted twice, which is not worth a table. */
const credited = new Map();   // sig -> { at, ids:Set }
export function claimOnce(sig, ids, now = Date.now()) {
  for (const [k, v] of credited) if (now - v.at > MAX_AGE_MS) credited.delete(k);
  while (credited.size > 5000) credited.delete(credited.keys().next().value);
  const seen = credited.get(sig) || { at: now, ids: new Set() };
  const fresh = ids.filter((id) => !seen.ids.has(id));
  fresh.forEach((id) => seen.ids.add(id));
  credited.set(sig, seen);
  return fresh;
}
