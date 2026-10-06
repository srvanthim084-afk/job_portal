/**
 * The recruiter dashboard's numbers, counted on the server, in the caller's
 * scope (migration 0117).
 *
 *   recruiter   their own jobs, the applications to them, their own pool
 *   team lead   the same across their department
 *   admin       everything
 *
 * Nothing here filters by an id the client sent: every query runs under the
 * caller's row-level security (jobs, applications, talent_pool, the
 * candidates they may read), so the answer for a Manufacturing team lead
 * contains no Healthcare row to count. The scope is applied before the
 * count, so a card and the list behind it cannot disagree.
 *
 * THE GLOBAL CANDIDATE TOTAL IS NOT HERE. "Total candidates" on the Home
 * dashboard is the people who applied to jobs in scope plus the caller's
 * own talent pool; the whole database belongs to Find Candidates.
 */
import { Router } from 'express';
import { withUser } from '../db.js';
import { wrap } from '../errors.js';
import { requireAuth, requireRole } from '../auth.js';
import { scopeOf, publicSession } from '../scope.js';

const n = (v) => Number(v || 0);

/** The numbers, as one object. `c` is an open client bound to the caller. */
export async function homeStatsOn(c, session) {
  const jobs = (await c.query(
    `select count(*)::int                                                      as total,
            count(*) filter (where status <> 'closed')::int                    as active,
            count(*) filter (where status = 'open' and not archived)::int      as open_jobs,
            count(*) filter (where status = 'open' and not archived and not paused
                               and (expires_at is null or expires_at > now()))::int as published,
            count(*) filter (where status = 'draft')::int                      as drafts,
            count(*) filter (where featured)::int                              as featured
       from jobs`)).rows[0];

  const apps = (await c.query(
    `select count(*)::int                                                      as total,
            count(*) filter (where stage = 'shortlisted')::int                 as shortlisted,
            count(*) filter (where stage in ('applied', 'ai_screening'))::int  as pending_screen,
            count(match_score)::int                                            as scored,
            avg(match_score)                                                   as avg_match,
            count(distinct candidate_id)::int                                  as applicants
       from applications`)).rows[0];

  /* People: who applied to a job in scope, plus the pool rows in scope. */
  const people = (await c.query(
    `with seen as (
       select a.candidate_id, a.applied_at as at, true as applied, false as pooled from applications a
       union all
       select tp.candidate_id, tp.added_at, false, true from talent_pool tp
     ), per as (
       select candidate_id, min(at) as first_at, bool_or(applied) as applied, bool_or(pooled) as pooled
         from seen group by candidate_id
     )
     select count(*)::int                                                       as total,
            count(*) filter (where p.first_at >= now() - interval '7 days')::int as fresh,
            count(*) filter (where p.applied)::int                              as applied,
            count(*) filter (where p.pooled)::int                               as pooled,
            count(*) filter (where c.notice_period ilike '%immediate%')::int    as immediate
       from per p join candidates c on c.id = p.candidate_id`)).rows[0];

  /* Per job: applicants, for "Applications per job post". */
  const perJob = (await c.query(
    `select j.id, count(distinct a.candidate_id)::int as applied
       from jobs j left join applications a on a.job_id = j.id
      group by j.id`)).rows;

  const outreach = (await c.query(`select recruiter_outreach_stats() as o`)).rows[0].o || {};
  const ch = (k) => ({ sent: n(outreach[k] && outreach[k].sent), failed: n(outreach[k] && outreach[k].failed),
                       reached: n(outreach[k] && outreach[k].reached) });
  const email = ch('email'), whatsapp = ch('whatsapp'), sms = ch('sms');
  const inapp = { sent: n(outreach.inapp && outreach.inapp.sent), read: n(outreach.inapp && outreach.inapp.read) };

  return {
    scope: publicSession(session),
    jobs: {
      total: n(jobs.total), activeRoles: n(jobs.active), openJobs: n(jobs.open_jobs),
      published: n(jobs.published), drafts: n(jobs.drafts), featured: n(jobs.featured),
    },
    applications: {
      total: n(apps.total), shortlisted: n(apps.shortlisted), pendingScreening: n(apps.pending_screen),
      scored: n(apps.scored),
      /* null, never NaN or a divide by zero, when nothing has been scored. */
      avgAiMatch: apps.avg_match == null ? null : Math.round(Number(apps.avg_match)),
      applicants: n(apps.applicants),
    },
    candidates: {
      total: n(people.total), newLast7Days: n(people.fresh), applied: n(people.applied),
      inTalentPool: n(people.pooled), immediateJoiners: n(people.immediate),
    },
    perJob: Object.fromEntries(perJob.map((r) => [r.id, n(r.applied)])),
    outreach: {
      email, whatsapp, sms, inapp,
      totalSent: email.sent + whatsapp.sent + sms.sent + inapp.sent,
      totalFailed: email.failed + whatsapp.failed + sms.failed,
      totalViewed: inapp.read,
      candidatesReached: n(outreach.candidatesReached),
    },
  };
}

export async function homeStats(session) {
  return withUser(session, (c) => homeStatsOn(c, session));
}

export default function dashboardRoutes() {
  const r = Router();

  /** GET /api/recruiter/home-stats - the Home and Jobs dashboard cards. */
  r.get('/recruiter/home-stats', requireAuth(), requireRole('recruiter', 'admin'),
    wrap(async (req, res) => {
      const scope = scopeOf(req.session);
      const stats = await homeStats(req.session);
      res.json({ scopeRole: scope.scopeRole, stats });
    }));

  return r;
}
