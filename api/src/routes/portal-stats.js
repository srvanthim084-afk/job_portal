/**
 * GET /api/public/candidate-stats - the candidate portal's headline
 * numbers (0125), for anybody, signed in or not:
 *
 *   { registeredCandidates, newThisWeek, activeJobs }
 *
 * NUMBERS ONLY. public_candidate_stats() counts inside the database and
 * returns three integers; no row, name, id or address leaves it, so this
 * cannot become a way to list or probe candidates.
 *
 * "Registered" is a candidate with an active portal account - somebody
 * who finished signing up. A profile a recruiter added, or a sign-up
 * still at the draft stage, is not counted. "This week" starts Monday,
 * India time. "Active jobs" is what the Jobs page lists (jobs_open).
 */
import { Router } from 'express';
import { withUser } from '../db.js';
import { wrap } from '../errors.js';

export async function candidateStats() {
  const r = await withUser(null, async (c) => (await c.query(`select * from public_candidate_stats()`)).rows[0]);
  return {
    registeredCandidates: Number(r.registered_candidates) || 0,
    newThisWeek: Number(r.new_this_week) || 0,
    activeJobs: Number(r.active_jobs) || 0,
  };
}

export default function portalStatsRoutes() {
  const r = Router();
  r.get('/public/candidate-stats', wrap(async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await candidateStats());
  }));
  return r;
}
