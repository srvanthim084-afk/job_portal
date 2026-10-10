/**
 * Talent Pool -> "Send to ATS": candidates into a job's hiring pipeline, at Shortlisted.
 *
 *   POST /api/ats/send-to-pipeline   { jobId, candidateIds: [..], notify?: boolean }
 *
 * For each candidate (one job, up to 100 candidates):
 *   - no application for this job yet  -> one is created (source 'rediscovery' - brought back from
 *                                          the pool), scored like any other, and moved to Shortlisted
 *   - an application at Applied / AI Screening -> moved up to Shortlisted
 *   - already further along (Shortlisted, Interview, Offer ...) or closed -> left exactly where it is
 * The move is the ordinary stage change: the database writes the stage history row (with the note
 * "Sent to ATS from the Talent Pool"), so it counts as a recorded move into the ATS - Admin ->
 * Availability -> "Moved to ATS" included.
 *
 * Only open TeamLink regular jobs: a walk-in has its own registration flow and stages, an external
 * job is applied to on its own site, a closed job takes nobody. Row-level security decides which
 * jobs and candidates the recruiter can reach - a job they cannot see is "not found".
 *
 * Messages: NONE by default. Creating an application from the pool does not send the
 * "application received" / AI-interview messages a candidate's own application sends - the
 * candidate did not apply. With notify: true each candidate moved gets ONE message, the ordinary
 * "your application is now Shortlisted" in their own wording, on their channels.
 */
import { Router } from 'express';
import { z } from 'zod';
import { withUser } from '../db.js';
import { wrap, notFound, ApiError, CODES } from '../errors.js';
import { requireAuth, requireRole } from '../auth.js';
import { toJob, toCandidate } from '../shapes.js';
import { dispatchEvent } from '../notify/events.js';
import { matchCandidate } from '../ai/match.js';

const newId = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const MOVABLE = ['applied', 'ai_screening'];
const NOTE = 'Sent to ATS from the Talent Pool';

const body = z.object({
  jobId: z.string().trim().min(1).max(64),
  candidateIds: z.array(z.string().trim().min(1).max(64)).min(1).max(100),
  notify: z.boolean().optional(),
});

export default function sendToAtsRoutes() {
  const r = Router();

  r.post('/ats/send-to-pipeline', requireAuth(), requireRole('recruiter', 'admin'), wrap(async (req, res) => {
    const p = body.safeParse(req.body || {});
    if (!p.success) throw new ApiError(422, 'VALIDATION_FAILED', 'Choose a job and at least one candidate (at most 100 at a time).');
    const { jobId, notify } = p.data;
    const ids = [...new Set(p.data.candidateIds)];

    const out = await withUser(req.session, async (c) => {
      const j = (await c.query(`select * from jobs where id = $1`, [jobId])).rows[0];
      if (!j) throw notFound('That job could not be found.');
      if (j.source_type === 'EXTERNAL') throw new ApiError(409, CODES.JOB_UNAVAILABLE, 'That is an external job - candidates apply to it on its own website.');
      if (j.posting_kind === 'walkin' || j.employment_type === 'Walk-in') {
        throw new ApiError(409, CODES.JOB_UNAVAILABLE, 'That is a walk-in - candidates register for a walk-in themselves. Choose a regular job.');
      }
      if (j.status !== 'open' || j.paused || j.archived) throw new ApiError(409, CODES.JOB_UNAVAILABLE, 'That job is not open, so nobody can be added to it.');
      const shortlisted = (await c.query(`select label, candidate_label, notify_candidate from stages where id = 'shortlisted'`)).rows[0] || {};
      const job = toJob(j);
      const postingType = j.employment_type === 'Internship' ? 'internship' : (j.posting_kind || 'job');

      const results = [];
      for (const candidateId of ids) {
        await c.query('savepoint one');
        try {
          const cand = (await c.query(`select * from candidates where id = $1`, [candidateId])).rows[0];
          if (!cand) { results.push({ candidateId, outcome: 'refused', reason: 'not found, or not in your pool' }); await c.query('release savepoint one'); continue; }
          let app = (await c.query(`select * from applications where candidate_id = $1 and job_id = $2`, [candidateId, jobId])).rows[0];
          let outcome;
          if (!app) {
            let score = null;
            try { score = matchCandidate(job, toCandidate(cand)).score; } catch { /* the column shows a dash */ }
            app = (await c.query(
              `insert into applications (id, job_id, candidate_id, stage, match_score, source, posting_type)
               values ($1, $2, $3, 'applied', $4, 'rediscovery', $5) returning *`,
              [newId('app'), jobId, candidateId, score, postingType])).rows[0];
            outcome = 'added';
          } else if (MOVABLE.includes(app.stage)) {
            outcome = 'moved';
          } else {
            results.push({ candidateId, name: cand.name, applicationId: app.id, reference: app.reference || null, outcome: 'already', stage: app.stage });
            await c.query('release savepoint one');
            continue;
          }
          await c.query(`select set_config('app.stage_note', $1, true)`, [NOTE]);
          app = (await c.query(`update applications set stage = 'shortlisted' where id = $1 returning *`, [app.id])).rows[0];
          await c.query(`select app_event($1, $2, 'ats.sent', $3, 'recruiter', $4::jsonb)`,
            [app.id, candidateId, NOTE, JSON.stringify({ outcome, jobId, by: req.session.userId || null })]).catch(() => {});
          if (notify && shortlisted.notify_candidate !== false) {
            const label = shortlisted.candidate_label || shortlisted.label || 'Shortlisted';
            await c.query(`select notify_create($1,$2,'candidate','APPLICATION_STATUS',$3,$4,$5,$6,$7,null,$8)`,
              [newId('ntf'), candidateId, `Application ${label}`, `Your application for ${j.title} is now ${label}.`,
               jobId, app.id, candidateId, JSON.stringify({ stage: 'shortlisted', label })]);
          }
          results.push({ candidateId, name: cand.name, applicationId: app.id, reference: app.reference || null, outcome, stage: 'shortlisted' });
          await c.query('release savepoint one');
        } catch (err) {
          await c.query('rollback to savepoint one');
          results.push({ candidateId, outcome: 'refused', reason: err.code === '23505' ? 'already linked to this job' : 'could not be added' });
        }
      }
      return { job: { id: j.id, title: j.title }, results, label: shortlisted.candidate_label || shortlisted.label || 'Shortlisted', tell: shortlisted.notify_candidate !== false };
    });

    /* one message per candidate moved, only when asked; after the commit - a gateway never rolls a move back */
    let notified = 0;
    if (notify && out.tell) {
      for (const x of out.results) {
        if (x.outcome !== 'added' && x.outcome !== 'moved') continue;
        await dispatchEvent(req.session, 'STAGE_CHANGED', { applicationId: x.applicationId, stage: 'shortlisted', stageLabel: out.label, note: null })
          .then(() => { notified += 1; }).catch(() => {});
      }
    }

    const count = (k) => out.results.filter((x) => x.outcome === k).length;
    res.json({
      job: out.job,
      added: count('added'), moved: count('moved'), already: count('already'), refused: count('refused'),
      notified,
      results: out.results,
    });
  }));

  return r;
}
