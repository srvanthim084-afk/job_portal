/**
 * GET /api/bootstrap — the hydrate payload.
 *
 * THIS IS THE KEYSTONE OF THE WHOLE INTEGRATION.
 *
 * The prototype reads data synchronously, inline, inside template
 * literals — `DATA.jobById(id)` alone appears 163 times. Turning those
 * into awaits would mean rewriting all 19 page renderers and most of the
 * 691 functions, which is the rebuild the requirements forbid.
 *
 * So `DATA` stays a synchronous in-memory cache. This endpoint fills it
 * once, before the first render, and every existing call site keeps
 * working untouched. Mutations go out through the write endpoints and
 * update the same cache.
 *
 * What comes back is scoped by RLS, so the same URL returns a candidate's
 * own slice, a recruiter's company slice, or everything for an admin —
 * without the handler containing a single `if (role === ...)`.
 */
import { Router } from 'express';
import { withUser } from '../db.js';
import { wrap } from '../errors.js';
import {
  toCompany, toJob, toCandidate, toApplication,
  toInterview, toOffer, toNotification, toPerson, attachPrimary,
} from '../shapes.js';

export default function bootstrapRoutes() {
  const r = Router();

  r.get('/bootstrap', wrap(async (req, res) => {
    const session = req.session;

    const payload = await withUser(session, async (c) => {
      // One round trip per collection, all inside a single transaction so
      // the snapshot is internally consistent — a job and its application
      // count can never disagree.
      //
      // Sequential, NOT Promise.all. These share one connection, so
      // node-postgres queues them either way and there is no concurrency
      // to win. What Promise.all did add was a failure mode: it fires all
      // thirteen, and if one errors the transaction aborts, so the twelve
      // still queued come back "current transaction is aborted"
      // (SQLSTATE 25P02). Promise.all then rejects with whichever landed
      // first, which is usually one of the 25P02s — the original error is
      // lost and the whole payload 500s. Since /api/bootstrap is what
      // fills the entire UI, that reads to a user as the app being
      // broken, with nothing in the log naming the real cause.
      const empty = { rows: [] };
      const companies   = await c.query(`select * from companies order by name`);
      // jobs_with_counts supplies the DERIVED applicants count and
      // posted_days_ago, replacing the drifting counter (§3.2).
      const jobs        = await c.query(`select * from jobs_with_counts order by published_at desc nulls last, id`);
      const candidates  = await c.query(`select * from candidates order by id`);
      const applications= await c.query(`select * from applications order by applied_at desc`);
      const interviews  = await c.query(`select * from interviews order by scheduled_date desc nulls last`);
      const offers      = await c.query(`select * from offers order by extended_at desc`);
      const notifications = session
        ? await c.query(`select * from notifications order by created_at desc limit 200`)
        : empty;
      const recruiters  = await c.query(`select * from recruiters order by name`);
      const clients     = await c.query(`select * from client_users order by name`);
      const admins      = await c.query(`select * from admins limit 1`);
      const stages      = await c.query(`select id, label, kanban from stages order by sort_order`);
      const settings    = await c.query(`select value from app_settings where key='ai'`);
      // AI interview aggregates, scoped by RLS: a candidate gets their
      // own, a recruiter/client their company's, an admin everything.
      const aiInterviews = session
        ? await c.query(`select id, application_id, candidate_id, job_id, status,
                                technical_score, behavioral_score, communication_score,
                                overall_percentage, content_scored, feedback, completed_at
                           from ai_interviews order by completed_at desc limit 200`)
        : empty;

      const cands = candidates.rows.map(toCandidate);
      const apps  = applications.rows.map(toApplication);

      // Rebuild the prototype's two views of an application from the one
      // normalised table (§3.1): the primary lands back on the candidate,
      // the rest become DATA.applications.
      const extraApplications = attachPrimary(cands, apps);

      return {
        companies:   companies.rows.map(toCompany),
        jobs:        jobs.rows.map(toJob),
        candidates:  cands,
        applications: extraApplications,
        interviews:  interviews.rows.map(toInterview),
        offers:      offers.rows.map(toOffer),
        notifications: notifications.rows.map(toNotification),
        recruiters:  recruiters.rows.map(toPerson),
        clients:     clients.rows.map(toPerson),
        admin:       admins.rows[0] ? toPerson(admins.rows[0]) : null,
        stages:      stages.rows.map((s) => ({ id: s.id, label: s.label, kanban: s.kanban })),
        aiSettings:  settings.rows[0] ? settings.rows[0].value : {},
        aiInterviews: aiInterviews.rows.map((r) => ({
          id: r.id,
          applicationId: r.application_id,
          candidateId: r.candidate_id,
          jobId: r.job_id,
          status: r.status,
          technicalScore: r.technical_score == null ? null : Number(r.technical_score),
          behavioralScore: r.behavioral_score == null ? null : Number(r.behavioral_score),
          communicationScore: r.communication_score == null ? null : Number(r.communication_score),
          overallPercentage: r.overall_percentage == null ? null : Number(r.overall_percentage),
          contentScored: !!r.content_scored,
          feedback: r.feedback || undefined,
          completedAt: r.completed_at ? new Date(r.completed_at).toISOString() : undefined,
        })),
      };
    });

    res.json({
      session: session
        ? { role: session.role, id: session.profileId, userId: session.userId }
        : null,
      data: payload,
      serverTime: new Date().toISOString(),
    });
  }));

  /**
   * GET /api/login-hints — the "Quick demo login" panel on the login screen.
   *
   * The prototype built that panel from DATA directly, which meant an
   * anonymous visitor to #/login/candidate was shown four real candidates'
   * NAMES AND EMAIL ADDRESSES (demoAccountsFor, prototype.html:2199).
   *
   * Staff accounts are listed because the same page already prints the
   * sign-in address in its credentials box. Candidates are NEVER listed:
   * they are members of the public, and publishing their contact details
   * on an unauthenticated page is not something the redesign should carry
   * forward. That panel renders empty for candidates by design.
   *
   * Set SHOW_LOGIN_HINTS=false to switch the whole thing off for a real
   * production deployment.
   */
  r.get('/login-hints', wrap(async (req, res) => {
    if (process.env.SHOW_LOGIN_HINTS === 'false') {
      return res.json({ candidate: [], recruiter: [], client: [], admin: [] });
    }
    // RLS hides staff from anonymous callers, so this goes through the one
    // SECURITY DEFINER function written for it (0002_rls.sql). The policy
    // is not relaxed; the disclosure is explicit and auditable in one place.
    const rows = await withUser(null, async (c) => {
      const { rows } = await c.query(`select * from public_login_hints()`);
      return rows;
    });

    const pick = (role) => rows.filter((x) => x.role === role)
      .map((x) => ({ id: x.id, name: x.name, sub: x.sub }));

    res.json({
      candidate: [],                                   // deliberately empty — see above
      recruiter: pick('recruiter'),
      client:    pick('client'),
      admin:     pick('admin'),
    });
  }));

  return r;
}
