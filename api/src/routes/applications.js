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
import { toApplication, toNotification } from '../shapes.js';
import { dispatchInterviewNotifications } from '../notify/dispatch.js';

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
      source: z.string().trim().max(80).optional(),
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

      const ins = await c.query(
        `insert into applications
           (id, job_id, candidate_id, stage, match_score, source, posting_type, resume_path)
         values ($1,$2,$3,'applied',$4,$5,$6,$7)
         returning *`,
        [id, body.jobId, candidateId, body.matchScore ?? null,
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
    } catch (err) {
      // The application stands regardless. The failure is logged, and the
      // delivery rows (or their absence) are visible on the record.
      console.error('[notify] interview notification dispatch failed:', err.message);
      notify = { error: 'dispatch_failed' };
    }

    res.status(201).json({ ...out, notify });
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

        return toApplication(app);
      });

      res.json({ application: out });
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
