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
import { walkinCompletedError } from '../portal/walkin-jobs.js';
import { requireAuth, requireRole } from '../auth.js';
import { toApplication, toNotification, toJob, toCandidate } from '../shapes.js';
import { dispatchEvent } from '../notify/events.js';
import { sendApplyMessages } from '../notify/apply-messages.js';
import { kickApplicationNotices } from '../notify/application-notices.js';
import { holdSeconds, scheduleHold } from '../notify/apply-hold.js';
import { matchCandidate } from '../ai/match.js';
import { screenApplication } from '../ai/screening.js';
import { applyScreeningAnswers, storeApplyScreening } from '../screening/apply.js';
import { hiddenError } from '../scope.js';
import { istDateTime, appliedRangeSql, sourceLabel } from '../applied-date.js';

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
    // 0130: "Applied Date" - India days, both ends inclusive - and the order.
    const order = req.query.sort === 'applied_asc' ? 'applied_at asc, id' : 'applied_at desc, id desc';

    const out = await withUser(req.session, async (c) => {
      const where = [], params = [];
      if (jobId)       { params.push(jobId);       where.push(`job_id=$${params.length}`); }
      if (candidateId) { params.push(candidateId); where.push(`candidate_id=$${params.length}`); }
      if (stage)       { params.push(stage);       where.push(`stage=$${params.length}`); }
      where.push(...appliedRangeSql('applied_at', req.query.from, req.query.to,
        (v) => { params.push(v); return `$${params.length}`; }));
      const clause = where.length ? `where ${where.join(' and ')}` : '';
      const total = await c.query(`select count(*)::int n from applications ${clause}`, params);
      params.push(limit, offset);
      const rows = await c.query(
        `select * from applications ${clause}
         order by ${order} limit $${params.length - 1} offset $${params.length}`, params);
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
      // Screening questions (0097): [{questionId, answer}], checked against the job's questions.
      answers: z.array(z.object({ questionId: z.string().trim().min(1).max(64), answer: z.any() })).max(12).optional(),
      saveScreeningDefaults: z.boolean().optional(),
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

    // Validated BEFORE anything is written: a refused answer leaves no application behind.
    const screeningAnswers = await applyScreeningAnswers(body.jobId, body.answers);

    const out = await withUser(req.session, async (c) => {
      const job = await c.query(
        `select id, title, company_id, employment_type, posting_kind, status, paused, archived, source_type, recruiter_id
           from jobs where id=$1`, [body.jobId]);
      if (!job.rowCount) throw new ApiError(404, CODES.JOB_UNAVAILABLE, 'This role is no longer available.');
      const j = job.rows[0];
      /* 0113: the TeamLink application flow is for TeamLink jobs. */
      if (req.session.role === 'candidate' && j.source_type === 'EXTERNAL') {
        throw new ApiError(409, CODES.JOB_UNAVAILABLE, 'This is an external job: apply on its original website.');
      }
      if (j.status !== 'open' || j.paused || j.archived) {
        throw new ApiError(409, CODES.JOB_UNAVAILABLE, 'This role is no longer accepting applications.');
      }

      const dupe = await c.query(
        `select id, reference from applications where candidate_id=$1 and job_id=$2`, [candidateId, body.jobId]);
      if (dupe.rowCount) {
        // 0106: the existing Application ID, so the candidate can quote it.
        throw new ApiError(409, CODES.DUPLICATE_APPLICATION, 'You have already applied for this position.',
          { applicationId: dupe.rows[0].reference || dupe.rows[0].id, jobId: body.jobId });
      }

      // 0106: a walk-in that has ended, or whose seats are taken, is decided
      // here - at save time, under a lock on the job row - so two people
      // pressing Submit for the last seat cannot both get it.
      const walkin = (await c.query(`select walkin_apply_check($1) as v`, [body.jobId])).rows[0].v;
      if (walkin === 'closed') {
        /* 0137: said as what it is - the walk-in's dates are over - with the date as posted */
        const when = (await c.query(`select walkin_completed($1) as d`, [body.jobId])).rows[0].d;
        throw walkinCompletedError(when);
      }
      if (walkin === 'full') {
        throw new ApiError(409, 'WALKIN_FULL', 'Registrations full - every seat for this walk-in is taken.', { reason: 'walkin_full' });
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
       * The recruiter's screening score (matchCandidate, multi-factor). It
       * is not the candidate's AI Match (ai/ai-match.js, skills only),
       * which is what candidates and the alerts see.
       */
      let matchScore = null;
      let candName = '';
      try {
        const cand = (await c.query(`select * from candidates where id=$1`, [candidateId])).rows[0];
        candName = (cand && cand.name) || '';
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

      // Same transaction: the application and its answers exist together or not at all.
      if (screeningAnswers) {
        await storeApplyScreening(c, id, screeningAnswers, req.session, candidateId, body.saveScreeningDefaults);
      }

      // One-click apply can be undone for 10 s: its candidate messages are
      // held (0104) until that has passed, written in this same transaction
      // so a restart cannot lose them. Set by the one-click route, never by
      // the request body.
      let heldUntil = null;
      if (req.oneClickApply === true && req.session.role === 'candidate') {
        heldUntil = (await c.query(`select application_outbound_hold($1,$2) as due`,
          [id, holdSeconds()])).rows[0].due;
      }

      // Same transaction — see the header note.
      const company = await c.query(`select name from companies where id=$1`, [j.company_id]);
      const coName = company.rows[0]?.name || 'the company';
      // 0130: both notices carry the applied date and time (IST), from
      // the row's own applied_at - the one value every screen shows.
      const appliedAt = ins.rows[0].applied_at;
      const appliedText = istDateTime(appliedAt);
      const notif = await c.query(
        `select notify_create($1,$2,'candidate','APPLICATION_SUBMITTED',$3,$4,$5,$6,$7,null,$8) as id`,
        [newId('ntf'), candidateId,
         `You applied for ${j.title}`,
         `Your application for ${j.title} at ${coName} has been submitted successfully. Applied on ${appliedText}.`,
         j.id, id, candidateId,
         JSON.stringify({ jobTitle: j.title, company: coName, appliedAt: new Date(appliedAt).toISOString() })]);

      // The recruiter who owns the job (or the application's own
      // recruiter) hears about it at once: "<candidate> applied for <job>".
      // Same transaction, so an Undo takes it away with the application.
      const owner = ins.rows[0].recruiter_id || j.recruiter_id;
      if (owner) {
        const src = sourceLabel(ins.rows[0].source);
        await c.query(
          `select notify_create($1,$2,'recruiter','APPLICATION_RECEIVED',$3,$4,$5,$6,$7,$2,$8)`,
          [newId('ntf'), owner,
           `${candName || 'A candidate'} applied for ${j.title}`,
           `${candName || 'A candidate'} applied for ${j.title}. Applied on ${appliedText}. `
             + `Came from: ${src}.` + (matchScore != null ? ` AI Match ${Math.round(matchScore)}%.` : ''),
           j.id, id, candidateId,
           JSON.stringify({ jobTitle: j.title, candidateName: candName, source: src,
             matchScore, reference: ins.rows[0].reference || null,
             appliedAt: new Date(appliedAt).toISOString() })]);
      }

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
        heldUntil,
      };
    });
    const heldUntil = out.heldUntil;
    delete out.heldUntil;

    // ---- the candidate's messages -----------------------------------
    //
    // The interview invitation / confirmation and the AI interview
    // invitation (notify/apply-messages.js). Sent now, after the commit,
    // unless this is a one-click application inside its Undo window: then
    // they go when the hold falls due, and only if it was not undone.
    /* 0138: HR hears about a walk-in application now - not after the AI interview, and not only
       when a recruiter is assigned. The notice row was made with the application; this sends it. */
    kickApplicationNotices();

    let messages = null;
    if (heldUntil) {
      scheduleHold(out.application.id, heldUntil);
      const held = { held: true, sendsAt: new Date(heldUntil).toISOString(), reason: 'undo_window' };
      messages = { notify: held, aiInterview: held };
    } else {
      messages = await sendApplyMessages(req.session, {
        applicationId: out.application.id,
        candidateId: out.application.candidateId,
        jobId: out.application.jobId,
      });
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

    res.status(201).json({ ...out, notify: messages.notify, aiInterview: messages.aiInterview, screening });
  }));

  /**
   * Move a candidate through the pipeline (requirement 13).
   * Status change -> database -> notification -> candidate sees it.
   */
  r.put('/applications/:id/status', requireAuth(),
    requireRole('recruiter', 'client', 'admin'), wrap(async (req, res) => {
      const { stage, note, reason, expectedVersion } = parse(z.object({
        stage: z.string().trim().min(1).max(40),
        note: z.string().trim().max(2000).optional(),
        /* 0107: an override's reason (walk-in jobs) and the version the
           screen was showing, so a second recruiter cannot overwrite the
           first one's move unseen (23.8). Both optional: every existing
           caller keeps working exactly as before. */
        reason: z.string().trim().max(1000).optional(),
        expectedVersion: z.number().int().min(1).optional(),
      }), req.body);

      const out = await withUser(req.session, async (c) => {
        const valid = await c.query(
          `select id, label, candidate_label, notify_candidate from stages where id=$1`, [stage]);
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
        // 0107: a recruiter's explicit move - walk-in jobs check it against their transition table
        await c.query(`select set_config('app.stage_explicit', '1', true), set_config('app.stage_reason', $1, true)`,
          [reason || '']);
        if (expectedVersion != null) {
          const cur = await c.query(`select version from applications where id=$1 for update`, [req.params.id]);
          if (cur.rowCount && cur.rows[0].version !== expectedVersion) {
            throw new ApiError(409, 'STALE_VERSION',
              'This applicant was updated by someone else. Refresh to see the latest.',
              { currentVersion: cur.rows[0].version });
          }
        }

        const upd = await c.query(
          `update applications set stage=$1 where id=$2 returning *`, [stage, req.params.id]);
        if (!upd.rowCount) {
          const seen = await c.query(`select app_row_exists('application',$1) as e`, [req.params.id]);
          throw seen.rows[0].e
            ? forbidden('You do not have access to this application.')
            : notFound('That application no longer exists.');
        }
        const app = upd.rows[0];
        // 0107: a walk-in move never messages the candidate by itself (23.18)
        const tellThem = valid.rows[0].notify_candidate !== false && app.posting_type !== 'walkin';

        const job = await c.query(
          `select j.title, co.name as company from jobs j
             left join companies co on co.id=j.company_id where j.id=$1`, [app.job_id]);
        const label = valid.rows[0].label;
        /*
         * WHAT THE CANDIDATE IS TOLD IT IS CALLED.
         *
         * The notification below, and the email and SMS that follow it,
         * quoted the INTERNAL label - so a move to client_review sent the
         * candidate "Your application is now Client Review". That is the
         * one word they must never see: it tells them we are an agency
         * placing them elsewhere and invites the question we cannot
         * answer. The stages table carries their wording (0051), and it
         * is used for everything they read. The recruiter's own screens
         * still use `label`.
         */
        const candidateLabel = valid.rows[0].candidate_label || label;

        /*
         * Some stages are ours, not the candidate's.
         *
         * "Your application has moved to With BDE" means nothing to the
         * person receiving it and describes how we work internally; "you
         * are on Hold" is worse, because it is the kind of sentence that
         * loses somebody who was only ever waiting a week. The stage row
         * says which, so the decision is visible in the pipeline rather
         * than buried in a condition here.
         */
        if (tellThem) {
          await c.query(
            `select notify_create($1,$2,'candidate','APPLICATION_STATUS',$3,$4,$5,$6,$7,null,$8)`,
            [newId('ntf'), app.candidate_id,
             `Application ${candidateLabel}`,
             `Your application for ${job.rows[0]?.title || 'a role'} at ${job.rows[0]?.company || 'the company'} is now ${candidateLabel}.`,
             app.job_id, app.id, app.candidate_id,
             JSON.stringify({ stage, label: candidateLabel })]);
        }

        return { application: toApplication(app), label, candidateLabel, tellThem };
      });

      // The stage move now reaches the candidate on every channel they
      // have, not only in the portal. Out of band and after the commit: a
      // stage change is a database fact, and an SMS gateway has no
      // business rolling it back.
      const notify = out.tellThem
        ? await dispatchEvent(req.session, 'STAGE_CHANGED', {
            applicationId: req.params.id,
            stage: out.application.stage,
            // Their wording, not ours — this reaches email and SMS.
            stageLabel: out.candidateLabel,
            note: note || null,
          })
        // Said plainly rather than left as an empty result, so a
        // recruiter asking "did they get told?" has an answer.
        : { event: 'STAGE_CHANGED', skipped: 'internal stage', delivery_status: {} };

      res.json({ application: out.application, notify, notified: out.tellThem });
    }));

  /**
   * GET /api/applications/:id/notifications
   *
   * The per-application record the specification defines: which channels
   * were attempted, what happened on each, and the shared expiry. Built
   * from a view so the summary cannot drift from the rows it derives from.
   */
  /**
   * POST /applications/:id/screen — screen this one again, now.
   *
   * SCREENING IS AUTOMATIC and this is not how it normally happens: every
   * application is scored when it is created, when its resume arrives,
   * and by a sweep every ten minutes. This is the manual retry for the
   * ones that could not be done - an unreadable CV, or a failure while
   * the scorer was down - and for a requirement whose skills have since
   * been filled in.
   *
   * IT EXISTS BECAUSE THE BUTTON HAD NOTHING TO CALL. "Run AI Screening"
   * ran a setTimeout in the browser that moved the application to
   * Shortlisted using the score already on the row, and announced "AI
   * screening passed (34% match)". Nothing was screened and no score was
   * recomputed; it was the prototype's stand-in, still wired up.
   *
   * `force` because the point of pressing it is to redo work.
   */
  r.post('/applications/:id/screen', requireAuth(),
    requireRole('recruiter', 'bde', 'admin'), wrap(async (req, res) => {
      // RLS decides whether this application is theirs to touch; asking
      // for it as the caller is what enforces that.
      const mine = await withUser(req.session, async (c) => (await c.query(
        `select id from applications where id=$1`, [req.params.id])).rows[0]);
      if (!mine) throw await hiddenError(req.session, 'application', req.params.id, notFound('That application does not exist.'));

      const out = await screenApplication(req.params.id,
        { actor: req.session.userId || 'recruiter', force: true });
      if (!out) throw badRequest('That application could not be screened.');
      res.json(out);
    }));

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

    if (!out) throw await hiddenError(req.session, 'application', req.params.id, notFound('That application could not be found.'));

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
    if (!rows.length) {
      /* Nothing came back: either no history, or not theirs to read (0118). */
      const denied = await hiddenError(req.session, 'application', req.params.id, null);
      if (denied) throw denied;
    }
    res.json({ history: rows });
  }));

  return r;
}
