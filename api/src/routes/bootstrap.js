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
import { config } from '../config.js';
import {
  toCompany, toJob, toCandidate, toApplication,
  toEducationRecord, toExperienceRecord,
  toInterview, toOffer, toNotification, toPerson, attachPrimary,
} from '../shapes.js';
import { teamlinkOnly } from '../jobs/source-scope.js';
import { homeStatsOn } from './dashboard.js';
import { publicSession } from '../scope.js';

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
      /* 0113: a candidate or a visitor is handed TeamLink jobs - the Jobs
         page's dataset - plus, for a candidate, any job they already
         applied to (so their own applications still have a title). Staff
         keep every row RLS lets them read: that is the ATS, not the Jobs page. */
      const staff = !!session && ['recruiter', 'admin', 'bde', 'client'].includes(session.role);
      const jobs        = await c.query(`select * from jobs_with_counts
        ${staff ? '' : `where ${teamlinkOnly()} or id in (select job_id from applications)`}
        order by published_at desc nulls last, id`);
      /*
       * 0117: A RECRUITER'S BROWSER IS NOT HANDED THE WHOLE DATABASE.
       *
       * It used to receive every readable candidate (the shared pool: tens
       * of thousands of people, each with the fields a colleague recorded).
       * Now a recruiter or team lead receives the candidates in a talent
       * pool they may read plus the applicants to jobs they may read - their
       * own desk, their department's for a team lead. Everyone else on the
       * database is reached through Find Candidates, which asks the server
       * and returns the shared basic profile. Admins and every other role
       * are unchanged.
       */
      const scopedCandidates = session && session.role === 'recruiter';
      const candidates  = await c.query(scopedCandidates
        ? `select c.* from candidates c
            where exists (select 1 from talent_pool tp where tp.candidate_id = c.id)
               or exists (select 1 from applications a where a.candidate_id = c.id)
               or app_recruiter_in_scope(c.owner_recruiter_id)
            order by c.id`
        : `select * from candidates order by id`);
      const applications= await c.query(`select * from applications order by applied_at desc`);
      const interviews  = await c.query(`select * from interviews order by scheduled_date desc nulls last`);
      const offers      = await c.query(`select * from offers order by extended_at desc`);
      const notifications = session
        ? await c.query(`select * from notifications order by created_at desc limit 200`)
        : empty;
      /* 0117: a recruiter is told about themselves (and a team lead about
         their department's recruiters), not the whole firm's staff list. */
      const recruiters  = await c.query(session && session.role === 'recruiter'
        ? `select * from recruiters where app_recruiter_in_scope(id) order by name`
        : `select * from recruiters order by name`);
      const clients     = await c.query(`select * from client_users order by name`);
      // A BDE reads the pool and pushes records out to the agency's ATS; the
      // pipeline screens they reuse look their profile up by id, the same way
      // they do for a recruiter.
      const bdes        = await c.query(`select * from bde_users order by name`);
      const admins      = await c.query(`select * from admins limit 1`);
      const stages      = await c.query(
        `select id, label, kanban, candidate_label, owner, next_stage
           from stages
          /* 0107: the walk-in-only stages stay out of every regular
             pipeline list; web/teamlink-walkin-ats.js resolves them. */
          where coalesce(applies_to, 'regular') <> 'walkin'
          order by sort_order`);
      const settings    = await c.query(`select value from app_settings where key='ai'`);
      // AI interview aggregates, scoped by RLS: a candidate gets their
      // own, a recruiter/client their company's, an admin everything.
      const aiInterviews = session
        ? await c.query(`select id, application_id, candidate_id, job_id, status,
                                technical_score, behavioral_score, communication_score,
                                overall_percentage, content_scored, feedback, completed_at
                           from ai_interviews order by completed_at desc limit 200`)
        : empty;

      /* 0117: a recruiter's own talent_pool row supplies the notes and tags on the shape. */
      const poolRows = scopedCandidates
        ? (await c.query(`select distinct on (candidate_id) tp.*, (tp.recruiter_id = app_recruiter_id()) as mine
             from talent_pool tp order by tp.candidate_id, (tp.recruiter_id = app_recruiter_id()) desc, tp.added_at desc`)).rows
        : [];
      const poolBy = new Map(poolRows.map((p) => [p.candidate_id, p]));
      const cands = candidates.rows.map((x) => (scopedCandidates
        ? toCandidate(x, { staff: true, pool: poolBy.get(x.id) })
        : toCandidate(x)));

      /*
       * THE SIGNED-IN CANDIDATE'S OWN EDUCATION AND WORK HISTORY.
       *
       * The portal renders the profile page from this payload, not from
       * the single-candidate GET, so rows that existed in the database
       * were shown as "Add your degree and college" - the candidate had
       * typed them into the onboarding wizard a moment earlier.
       *
       * Their own row only. Staff read these through the detail route,
       * where one candidate is being looked at; attaching every
       * candidate's full work history to a bootstrap that already
       * carries the whole pool would grow it for no reader.
       */
      if (session && session.role === 'candidate' && session.profileId) {
        const mine = cands.find((x) => x.id === session.profileId);
        if (mine) {
          const edu = await c.query(
            `select qualification, specialization, institution, passing_year, score,
                    education_type
               from candidate_education where candidate_id=$1 order by sort_order, id`,
            [session.profileId]);
          const exp = await c.query(
            `select company, job_title, start_date, end_date, currently_working,
                    location, employment_type, responsibilities, leaving_reason
               from candidate_experience where candidate_id=$1 order by sort_order, id`,
            [session.profileId]);
          mine.educationRecords  = edu.rows.map(toEducationRecord);
          mine.experienceRecords = exp.rows.map(toExperienceRecord);
        }
      }
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
        bdes:        bdes.rows.map(toPerson),
        admin:       admins.rows[0] ? toPerson(admins.rows[0]) : null,
        /* candidateLabel: what a CANDIDATE is shown, when that must differ
           from the internal wording (0051). Null for almost every stage. */
        stages:      stages.rows.map((s) => ({
          id: s.id, label: s.label, kanban: s.kanban,
          candidateLabel: s.candidate_label || null,
          /* Who holds the file here, and where the handover button sends
             it. The chain is data (0052), not a rule written into a
             screen that will disagree with the next one. */
          owner: s.owner || null,
          nextStage: s.next_stage || null,
        })),
        aiSettings:  settings.rows[0] ? settings.rows[0].value : {},
        /* 0117: the four departments (admin's role + department selector). */
        departments: (await c.query(`select id, name from departments order by sort_order`)).rows,
        /* 0117: the Home and Jobs dashboard numbers, counted in scope on the server. */
        homeStats:   session && session.role === 'recruiter' ? await homeStatsOn(c, session) : null,
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

    /* Carried here too, so a refresh does not lose the fact that this
       person is still on a password somebody else generated. */
    const temp = session && session.userId
      ? await withUser(session, async (c) => (await c.query(
          `select must_change_password from users where id=$1`, [session.userId])).rows[0])
      : null;

    res.json({
      session: session
        ? {
            role: session.role, id: session.profileId, userId: session.userId,
            ...publicSession(session),
            mustChangePassword: !!(temp && temp.must_change_password),
          }
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
  /**
   * GET /api/notification-settings
   *
   * The EmailJS service id, template id and public key - client-safe by
   * EmailJS's own design, and exactly what the Notification Settings
   * screen asks every recruiter to type in by hand and then keeps in
   * their own browser. Served from the server's configuration so there
   * is one answer for everybody.
   *
   * The private key is NOT here and never goes to a browser.
   */
  r.get('/notification-settings', wrap(async (req, res) => {
    res.json({
      emailjs: {
        serviceId: config.emailjs.serviceId || '',
        templateId: config.emailjs.templateId || '',
        publicKey: config.emailjs.publicKey || '',
        configured: !!(config.emailjs.serviceId && config.emailjs.templateId
                       && config.emailjs.publicKey),
      },
      serverEmail: {
        transport: config.smtpHost ? 'smtp'
          : (config.emailjs.serviceId ? 'emailjs'
            : (config.emailApiKey ? 'api' : 'none')),
        from: config.emailFrom || '',
        fromName: config.emailFromName || '',
      },
    });
  }));

  r.get('/login-hints', wrap(async (req, res) => {
    if (process.env.SHOW_LOGIN_HINTS === 'false') {
      return res.json({ candidate: [], recruiter: [], client: [], bde: [], admin: [] });
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
      bde:       pick('bde'),
      admin:     pick('admin'),
    });
  }));

  return r;
}
