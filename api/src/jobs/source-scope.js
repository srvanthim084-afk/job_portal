/**
 * Job source separation (owner, 2026-10-05; migration 0113).
 *
 *   JOBS PAGE          = TEAMLINK jobs only    (table `jobs`, source_type 'TEAMLINK')
 *   EXTERNAL JOBS PAGE = EXTERNAL jobs only    (table `external_jobs`)
 *
 * The one place the two scopes are named. Every Jobs-page endpoint calls
 * `jobsPageScope(req)`: no parameter, or `sourceType=TEAMLINK`, is the
 * Jobs page; anything else is refused (400 SOURCE_SCOPE) rather than
 * quietly widened, so no caller can ask the Jobs page for "all" and hide
 * the external ones afterwards. Every External Jobs endpoint calls
 * `externalPageScope(req)`, the mirror image.
 *
 * `matchJobs({ session, candidateId, sourceType })` is the central
 * matcher with the scope as a parameter (owner §19). It picks the eligible
 * dataset FIRST - TeamLink's open jobs, or the external ones - and only then
 * scores it with that dataset's existing scorer. HOW a job is scored is not
 * this file's business; WHICH jobs are scored is.
 */
import { ApiError } from '../errors.js';

export const TEAMLINK = 'TEAMLINK';
export const EXTERNAL = 'EXTERNAL';
export const SOURCE_TYPES = [TEAMLINK, EXTERNAL];

/** 'teamlink' | 'TEAMLINK' -> 'TEAMLINK'; '' / undefined -> null; else the raw text. */
export function normaliseSourceType(v) {
  if (v === undefined || v === null) return null;
  const s = String(Array.isArray(v) ? v[0] : v).trim().toUpperCase();
  return s || null;
}

function refuse(page, asked) {
  return new ApiError(400, 'SOURCE_SCOPE',
    page === TEAMLINK
      ? 'The Jobs page lists TeamLink jobs only. External jobs are on the External Jobs page.'
      : 'The External Jobs page lists external jobs only. TeamLink jobs are on the Jobs page.',
    { sourceType: asked, allowed: page });
}

/** The scope a request may have, given the page it serves. Throws on anything else. */
export function requireScope(asked, page) {
  const s = normaliseSourceType(asked);
  if (s === null || s === page) return page;
  throw refuse(page, s);
}

/** Jobs page: `?sourceType=` or body.sourceType, default TEAMLINK, never anything else. */
export const jobsPageScope = (req) =>
  requireScope((req.query && req.query.sourceType) ?? (req.body && req.body.sourceType), TEAMLINK);

/** External Jobs page: default EXTERNAL, never anything else. */
export const externalPageScope = (req) =>
  requireScope((req.query && req.query.sourceType) ?? (req.body && req.body.sourceType), EXTERNAL);

/** The SQL condition for "a TeamLink job", on a `jobs` row or a jobs view. */
export const teamlinkOnly = (alias = '') => `${alias ? `${alias}.` : ''}source_type = '${TEAMLINK}'`;

/** A jobs row (or its toJob shape) that belongs on the Jobs page. */
export function isTeamLinkJob(j) {
  if (!j) return false;
  if (/^xjob_/.test(String(j.id || ''))) return false;
  const t = j.source_type ?? j.sourceType;
  return t === undefined || t === null ? true : t === TEAMLINK;
}

/**
 * The eligible dataset for one scope, BEFORE any scoring.
 *   TEAMLINK: open TeamLink jobs (jobs_open, + company name), optionally only `jobIds`
 *   EXTERNAL: open external jobs (external_jobs, + source name)
 */
export async function eligibleJobs(c, sourceType, { jobIds = null, limit = 3000 } = {}) {
  const scope = normaliseSourceType(sourceType);
  if (!SOURCE_TYPES.includes(scope)) throw new ApiError(400, 'SOURCE_SCOPE', 'sourceType must be TEAMLINK or EXTERNAL.');
  const ids = Array.isArray(jobIds) ? jobIds : null;
  if (scope === TEAMLINK) {
    return (await c.query(
      `select j.*, co.name as company_name
         from jobs_open j left join companies co on co.id = j.company_id
        where ${teamlinkOnly('j')} ${ids ? 'and j.id = any($2)' : ''}
        order by j.published_at desc nulls last, j.id limit $1`, ids ? [limit, ids] : [limit])).rows;
  }
  return (await c.query(
    `select x.*, s.name as source_name
       from external_jobs x left join job_sources s on s.id = x.source_id
      where x.status = 'open' ${ids ? 'and x.id = any($2)' : ''}
      order by x.posted_at desc nulls last, x.id limit $1`, ids ? [limit, ids] : [limit])).rows;
}

/**
 * The central matcher. `sourceType` is REQUIRED - there is no default
 * dataset, so a caller cannot forget to scope it.
 *
 *   TEAMLINK -> [{ jobId, sourceType, score, ...explainMatch }] over eligibleJobs(TEAMLINK)
 *   EXTERNAL -> the external pipeline's own matcher (external/service.js),
 *               which reads external_jobs only
 */
export async function matchJobs({ session, candidateId, sourceType, jobIds = null, settings = null, opts = {} }) {
  const scope = normaliseSourceType(sourceType);
  if (!SOURCE_TYPES.includes(scope)) {
    throw new ApiError(400, 'SOURCE_SCOPE', 'Say which jobs to match: sourceType TEAMLINK or EXTERNAL.');
  }
  if (scope === EXTERNAL) {
    const { matchCandidate } = await import('../external/service.js');
    return { sourceType: EXTERNAL, ...(await matchCandidate(session, candidateId, opts)) };
  }
  const { withUser } = await import('../db.js');
  const { explainMatch, loadAiSettings } = await import('../portal/core.js');
  /* One transaction for the data; the settings are read after it closes
     (they open their own - PGlite has a single session). */
  const data = await withUser(session, async (c) => ({
    cand: (await c.query(`select * from candidates where id = $1`, [candidateId])).rows[0],
    rows: await eligibleJobs(c, TEAMLINK, { jobIds }),
  }));
  if (!data.cand) return { sourceType: TEAMLINK, status: 'not_found', matches: [] };
  const { cand, rows } = data;
  const s = settings || await loadAiSettings();
  return {
    sourceType: TEAMLINK,
    considered: rows.length,
    matches: rows.map((r) => ({ sourceType: TEAMLINK, ...explainMatch(r, cand, s) })),
  };
}
