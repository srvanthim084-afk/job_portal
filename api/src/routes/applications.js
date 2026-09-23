/**
 * Application routes (requirements 7 and 13).
 *
 * The apply flow the requirements describe:
 *   Candidate -> Select Job -> Apply -> Create Application -> Link
 *   Candidate + Job -> Store Resume -> Store Status -> Create Notification
 *
 * All of it happens in ONE transaction. If the notification insert fails
 * the application is rolled back too, so a candidate can never end up
 * applied-but-unnotified, or counted against a job that has no record of
 * them.
 */
import { Router } from 'express';
import { z } from 'zod';
import { withUser } from '../db.js';
import { wrap, badRequest, notFound, forbidden, ApiError, CODES } from '../errors.js';
import { requireAuth, requireRole } from '../auth.js';
import { toApplication, toNotification, toJob, toCandidate } from '../shapes.js';
import { dispatchInterviewNotifications } from '../notify/dispatch.js';
import { dispatchEvent } from '../notify/events.js';
import { matchCandidate } from '../ai/match.js';
import { screenApplication } from '../ai/screening.js';

const newId = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

const parse = (schema, body) => {
  const out = schema.safeParse(body || {});
  if (!out.success) {
    const details = {};
    for (const i of out.error.issues) details[i.path.join('.') || 'form'] = i.message;
    throw badRequest('Please check the highlighted fields and try again.', details);
  }
  return out.data;
};

/** The source names the ATS reports on; anything else is kept, tidied. */
const SOURCE_ALIASES = {
  naukri: 'naukri', linkedin: 'linkedin', indeed: 'indeed', shine: 'shine',
  monster: 'monster', glassdoor: 'glassdoor', instahyre: 'instahyre',
  referral: 'referral', recruiter: 'recruiter',
  teamlink: 'teamlink', portal: 'teamlink', direct: 'teamlink', website: 'teamlink',
  // An alert we sent is its own source. Folding it into "teamlink" would
  // make it impossible to say whether the alerts produce applications,
  // which is the only measure of whether they are worth sending.
  job_alert: 'job_alert', 'job alert': 'job_alert', alert: 'job_alert',
};

function normaliseSource(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (!v) return 'teamlink';
  if (SOURCE_ALIASES[v]) return SOURCE_ALIASES[v];
  // "naukri.com", "LinkedIn Jobs", "in.indeed.com" all mean one board.
  for (const key of Object.keys(SOURCE_ALIASES)) {
    if (v.includes(key)) return SOURCE_ALIASES[key];
  }
  return v.replace(/[^a-z0-9_-]+/g, '-').slice(0, 40) || 'teamlink';
}

export default function applicationRoutes() {
  const r = Router();

  r.get('/applications', requireAuth(), wrap(async (req, res) => {
    const limit  = Math.min(parseInt(req.query.limit, 10) || 200, 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const { jobId, candidateId, stage } = req.query;

    const out = await withUser(req.session, async (c) => {
      const where = [], params = [];
      if (jobId)       { params.push(jobId);       where.push(`job_id=$${params.length}`); }
      if (candidateId) { params.push(candidateId); where.push(`candidate_id=$${params.length}`); }
      if (stage)       { params.push(stage);       where.push(`stage=$${params.length}`); }
      const clause = where.length ? `where ${where.join(' and ')}` : '';
      const total = await c.query(`select count(*)::int n from applications ${clause}`, params);
      params.push(limit, offset);
      const rows = await c.query(
        `select * from applications ${clause}
         order by applied_at desc limit $${params.length - 1} offset $${params.length}`, params);
      return { total: total.rows[0].n, rows: rows.rows };
    });

    res.json({ applications: out.rows.map(toApplication), total: out.total, limit, offset });
  }));

  /**
   * Apply. Mirrors applyToJob() at prototype.html:1996, including its
   * guards ("already applied", "no longer accepting applications"), but
   * enforced server-side where they cannot be bypassed.
   */
  r.post('/applications', requireAuth(), wrap(async (req, res) => {
    const body = parse(z.object({
      jobId: z.string().trim().min(1).max(64),
      candidateId: z.string().trim().max(64).optional(),
      // Normalised, because it is reported on. The browser is untrusted:
      // without this, "Naukri.com", "naukri" and "NAUKRI" become three
      // rows in a source-wise report of the same board.
      source: z.string().trim().max(80).optional()
        .transform((v) => (v === undefined ? undefined : normaliseSource(v))),
      resumePath: z.string().trim().max(400).optional(),
      matchScore: z.number().min(0).max(100).optional(),
    }), req.body);

    // A candidate may only apply as themselves. A recruiter may add a
    // candidate to a role (the AI Rediscovery invite flow at :4204).
    let candidateId = body.candidateId;
    if (req.session.role === 'candidate') {
      candidateId = req.session.profileId;
    } else if (!['recruiter', 'admin'].includes(req.session.role)) {
      throw forbidden('Only candidates can apply to roles.');
    }
    if (!candidateId) throw badRequest('No candidate specified.');

    const out = await withUser(req.session, async (c) => {
      const job = await c.query(
        `select id, title, company_id, employment_type, posting_kind, status, paused, archived
           from jobs where id=$1`, [body.jobId]);
      if (!job.rowCount) throw new ApiError(404, CODES.JOB_UNAVAILABLE, 'This role is no longer available.');
      const j = job.rows[0];
      if (j.status !== 'open' || j.paused || j.archived) {
        throw new ApiError(409, CODES.JOB_UNAVAILABLE, 'This role is no longer accepting applications.');
      }

      const dupe = await c.query(
        `select id from applications where candidate_id=$1 and job_id=$2`, [candidateId, body.jobId]);
      if (dupe.rowCount) {
        throw new ApiError(409, CODES.DUPLICATE_APPLICATION, 'You have already applied to this role.');
      }

      const id = newId('app');
      const postingType = j.employment_type === 'Walk-in' ? 'walkin'
        : j.employment_type === 'Internship' ? 'internship'
        : (j.posting_kind || 'job');

      /*
       * Score the application here rather than accepting one from the
       * client.
       *
       * The pipeline shows an "AI Match" percentage for every row, and a
       * client-supplied number is not a match score - it is whatever the
       * browser felt like sending. Without one the column rendered
       * `undefined%` for every candidate who applied through the portal,
       * which is worse than a wrong number because it looks broken.
       *
       * Same engine as the job alerts, so the percentage a recruiter sees
       * on an application means the same thing as the one on an alert.
       */
      let matchScore = null;
      try {
        const cand = (await c.query(`select * from candidates where id=$1`, [candidateId])).rows[0];
        if (cand) matchScore = matchCandidate(toJob(j), toCandidate(cand)).score;
      } catch (err) {
        console.error('[applications] could not score the match:', err.message);
      }

      const ins = await c.query(
        `insert into applications
           (id, job_id, candidate_id, stage, match_score, source, posting_type, resume_path)
         values ($1,$2,$3,'applied',$4,$5,$6,$7)
         returning *`,
        [id, body.jobId, candidateId, matchScore,
         body.source || 'portal', postingType, body.resumePath || null]);

      // Same transaction — see the header note.
      const company = await c.query(`select name from companies where id=$1`, [j.company_id]);
      const coName = company.rows[0]?.name || 'the company';
      const notif = await c.query(
        `select notify_create($1,$2,'candidate','APPLICATION_SUBMITTED',$3,$4,$5,$6,$7,null,$8) as id`,
        [newId('ntf'), candidateId,
         'Application Submitted',
         `Your application for ${j.title} at ${coName} has been submitted successfully.`,
         j.id, id, candidateId,
         JSON.stringify({ jobTitle: j.title, company: coName })]);

      let notification = null;
      if (notif.rows[0]?.id) {
        const n = await c.query(`select * from notifications where id=$1`, [notif.rows[0].id]);
        notification = n.rows[0] ? toNotification(n.rows[0]) : null;
      }

      // The fresh applicants count, so the UI does not have to guess.
      const counts = await c.query(`select applicants from jobs_with_counts where id=$1`, [j.id]);

      return {
        application: toApplication(ins.rows[0]),
        notification,
        applicants: Number(counts.rows[0]?.applicants || 0),
      };
    });

    // ---- multi-channel interview notification -------------------------
    //
    // Fired here because "application confirmed" is the trigger. It runs
    // AFTER the application transaction has committed, deliberately: an
    // SMS gateway being down must never roll back a candidate's
    // application. Every channel is attempted independently inside.
    let notify = null;
    try {
      notify = await dispatchInterviewNotifications(req.session, {
        applicationId: out.application.id,
        candidateId: out.application.candidateId,
        jobId: out.application.jobId,
      });

      /*
       * Confirm the application itself, when nothing else already has.
       *
       * The interview invitation above doubles as a confirmation - it
       * names the role and says what happens next - so sending
       * "Application Received" beside it is two emails saying the same
       * thing a second apart. It goes out only when the invitation did
       * not, which is the case for a requirement with no AI interview.
       */
      const sent = Object.values((notify && notify.delivery_status) || {})
        .some((st) => st === 'sent' || st === 'delivered');
      if (!sent) {
        await dispatchEvent(req.session, 'APPLICATION_SUBMITTED', {
          applicationId: out.application.id,
          candidateId: out.application.candidateId,
          jobId: out.application.jobId,
        }).catch(() => null);
      }
    } catch (err) {
      // The application stands regardless. The failure is logged, and the
      // delivery rows (or their absence) are visible on the record.
      console.error('[notify] interview notification dispatch failed:', err.message);
      notify = { error: 'dispatch_failed' };
    }

    // ---- AI screening, for everybody, straight away -----------------
    //
    // Screening used to be a button a recruiter pressed per application,
    // so the ones nobody pressed it on sat unscored and looked identical
    // to the ones already reviewed. Every application is screened the
    // moment it exists; what the recruiter decides is what to do with the
    // score.
    let screening = null;
    try {
      screening = await screenApplication(out.application.id, { actor: 'system' });
    } catch (err) {
      console.error('[applications] screening failed:', err.message);
    }

    // ---- close the loop on the alert that brought them --------------
    //
    // Keyed on job and candidate rather than on the alert id, so an
    // application still counts even if they came back through search a
    // week later: the question "did the alert produce applications" is
    // about the candidate, not about the click.
    try {
      await withUser(req.session, (c) => c.query(
        `select job_match_applied($1,$2,$3)`,
        [out.application.jobId, out.application.candidateId, out.application.id]));
    } catch (err) {
      console.error('[alerts] could not mark the match applied:', err.message);
    }

    // ---- the AI interview and its two-day window ----------------------
    //
    // The clock starts here, not when the candidate happens to open the
    // interview screen, so this message is the one that states the
    // deadline. It is marked sent so the sweep never repeats it.
    let aiInvite = null;
    try {
      const due = await withUser(req.session, async (c) => {
        const row = (await c.query(
          `select ai_interview_due_at from applications where id=$1`, [out.application.id])).rows[0];
        return row ? row.ai_interview_due_at : null;
      });
      aiInvite = await dispatchEvent(req.session, 'AI_INTERVIEW_INVITED', {
        applicationId: out.application.id,
        candidateId: out.application.candidateId,
        jobId: out.application.jobId,
        dueAt: due,
      });
      await withUser(req.session, (c) =>
        c.query(`select ai_interview_reminder_sent($1,'invited')`, [out.application.id]));
    } catch (err) {
      console.error('[notify] the AI interview invitation failed:', err.message);
      aiInvite = { error: 'dispatch_failed' };
    }

    res.status(201).json({ ...out, notify, aiInterview: aiInvite, screening });
  }));

  /**
   * Move a candidate through the pipeline (requirement 13).
   * Status change -> database -> notification -> candidate sees it.
   */
  r.put('/applications/:id/status', requireAuth(),
    requireRole('recruiter', 'client', 'admin'), wrap(async (req, res) => {
      const { stage, note } = parse(z.object({
        stage: z.string().trim().min(1).max(40),
        note: z.string().trim().max(2000).optional(),
      }), req.body);

      const out = await withUser(req.session, async (c) => {
        const valid = await c.query(`select id, label from stages where id=$1`, [stage]);
        if (!valid.rowCount) throw badRequest(`"${stage}" is not a valid pipeline stage.`);

        // The note travels with the move, not after it. The trigger on
        // `applications` writes the history row; it reads this setting and
        // stores the note on that same INSERT (migration 0008).
        //
        // The previous version updated the history row afterwards with a
        // statement PostgreSQL does not accept (UPDATE ... ORDER BY ...
        // LIMIT). That aborted the transaction, so every query after it
        // failed with 25P02 and the move itself 500'd - and the
        // `.catch(() => {})` around it hid the cause.
        await c.query(`select set_config('app.stage_note', $1, true)`, [note || '']);

        const upd = await c.query(
          `update applications set stage=$1 where id=$2 returning *`, [stage, req.params.id]);
        if (!upd.rowCount) {
          const seen = await c.query(`select 1 from applications where id=$1`, [req.params.id]);
          throw seen.rowCount
            ? forbidden('You do not have access to this application.')
            : notFound('That application no longer exists.');
        }
        const app = upd.rows[0];

        const job = await c.query(
          `select j.title, co.name as company from jobs j
             left join companies co on co.id=j.company_id where j.id=$1`, [app.job_id]);
        const label = valid.rows[0].label;

        await c.query(
          `select notify_create($1,$2,'candidate','APPLICATION_STATUS',$3,$4,$5,$6,$7,null,$8)`,
          [newId('ntf'), app.candidate_id,
           `Application ${label}`,
           `Your application for ${job.rows[0]?.title || 'a role'} at ${job.rows[0]?.company || 'the company'} is now ${label}.`,
           app.job_id, app.id, app.candidate_id,
           JSON.stringify({ stage, label })]);

        return { application: toApplication(app), label };
      });

      // The stage move now reaches the candidate on every channel they
      // have, not only in the portal. Out of band and after the commit: a
      // stage change is a database fact, and an SMS gateway has no
      // business rolling it back.
      const notify = await dispatchEvent(req.session, 'STAGE_CHANGED', {
        applicationId: req.params.id,
        stage: out.application.stage,
        stageLabel: out.label,
        note: note || null,
      });

      res.json({ application: out.application, notify });
    }));

  /**
   * GET /api/applications/:id/notifications
   *
   * The per-application record the specification defines: which channels
   * were attempted, what happened on each, and the shared expiry. Built
   * from a view so the summary cannot drift from the rows it derives from.
   */
  r.get('/applications/:id/notifications', requireAuth(), wrap(async (req, res) => {
    const out = await withUser(req.session, async (c) => {
      const s = await c.query(
        `select * from application_notification_status where application_id=$1`,
        [req.params.id]);
      if (!s.rowCount) return null;
      const rows = await c.query(
        `select channel, status, to_address, provider, provider_ref, error, attempt, created_at
           from notification_deliveries
          where application_id=$1 order by created_at, channel`, [req.params.id]);
      return { summary: s.rows[0], rows: rows.rows };
    });

    if (!out) throw notFound('That application could not be found.');

    const sum = out.summary;
    res.json({
      candidate_id: sum.candidate_id,
      job_id: sum.job_id,
      source: sum.source,
      channels_attempted: sum.channels_attempted || [],
      delivery_status: sum.delivery_status || {},
      interview_expiry: sum.interview_expiry
        ? new Date(sum.interview_expiry).toISOString() : null,
      // The full attempt log, including the reason a channel failed. The
      // summary alone cannot answer "why did this candidate hear nothing".
      attempts: out.rows.map((r) => ({
        channel: r.channel,
        status: r.status,
        to: r.to_address || undefined,
        provider: r.provider || undefined,
        providerRef: r.provider_ref || undefined,
        error: r.error || undefined,
        attempt: r.attempt,
        at: r.created_at ? new Date(r.created_at).toISOString() : undefined,
      })),
    });
  }));

  r.get('/applications/:id/history', requireAuth(), wrap(async (req, res) => {
    const rows = await withUser(req.session, async (c) => {
      const { rows } = await c.query(
        `select h.from_stage, h.to_stage, h.note, h.created_at
           from application_stage_history h
           join applications a on a.id = h.application_id
          where h.application_id=$1 order by h.id`, [req.params.id]);
      return rows;
    });
    res.json({ history: rows });
  }));

  return r;
}
