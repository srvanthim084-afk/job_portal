/**
 * AI voice interview results.
 *
 * The scoring itself happens in the browser during the session (the AIIV
 * module in the prototype speaks the questions, transcribes the answers
 * and scores them on content). This is where the result becomes ATS data.
 *
 * Two things the server does NOT trust the browser for:
 *
 *   1. The aggregates. `ai_interview_record()` recomputes technical,
 *      behavioral, communication and overall from the per-question rows.
 *      A client that posts "overall: 95" with three failed answers gets
 *      the average of those three answers.
 *   2. The existence of a score at all. A completed interview with no
 *      per-question answers is rejected by the database, because that is
 *      precisely "a score disconnected from what the candidate said".
 */
import { Router } from 'express';
import { z } from 'zod';
import { withUser } from '../db.js';
import { wrap, badRequest, notFound, forbidden } from '../errors.js';
import { requireAuth } from '../auth.js';

const newId = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

const answerSchema = z.object({
  seq: z.number().int().min(1).max(50),
  category: z.enum(['intro', 'resume', 'technical', 'behavioral']),
  question: z.string().trim().min(1).max(2000),
  answered: z.boolean().optional(),
  answerSummary: z.string().max(4000).optional(),
  score: z.number().min(0).max(100),
  commScore: z.number().min(0).max(100).optional(),
  justification: z.string().max(2000).optional(),
});

const recordSchema = z.object({
  candidateId: z.string().trim().min(1).max(64),
  jobId: z.string().trim().min(1).max(64),
  applicationId: z.string().trim().max(64).optional(),
  mode: z.string().trim().max(20).optional(),
  contentScored: z.boolean().optional(),
  transcript: z.string().max(200000).optional(),
  feedback: z.string().max(4000).optional(),
  questionSetHash: z.string().trim().max(128).optional(),
  startedAt: z.string().datetime().optional(),
  answers: z.array(answerSchema).min(1, 'An AI interview cannot be recorded without answers.'),
});

const parse = (schema, body) => {
  const out = schema.safeParse(body || {});
  if (!out.success) {
    const details = {};
    for (const i of out.error.issues) details[i.path.join('.') || 'form'] = i.message;
    throw badRequest('The interview result could not be recorded.', details);
  }
  return out.data;
};

const toAi = (r) => ({
  id: r.id,
  applicationId: r.application_id,
  candidateId: r.candidate_id,
  jobId: r.job_id,
  status: r.status,
  mode: r.mode,
  technicalScore: r.technical_score == null ? null : Number(r.technical_score),
  behavioralScore: r.behavioral_score == null ? null : Number(r.behavioral_score),
  communicationScore: r.communication_score == null ? null : Number(r.communication_score),
  overallPercentage: r.overall_percentage == null ? null : Number(r.overall_percentage),
  questionsAsked: r.questions_asked,
  questionsAnswered: r.questions_answered,
  // Surfaced deliberately: when the browser could not transcribe, the score
  // is an estimate from response length, and the UI must be able to say so
  // rather than present it as a content-based result.
  contentScored: !!r.content_scored,
  feedback: r.feedback || undefined,
  completedAt: r.completed_at ? new Date(r.completed_at).toISOString() : undefined,
});

export default function aiInterviewRoutes() {
  const r = Router();

  /**
   * GET /api/ai-interviews
   *
   * Visible to the candidate (their own), the recruiter and client for
   * that company, and an admin. RLS decides; there is no role check here
   * to get wrong.
   */
  r.get('/ai-interviews', requireAuth(), wrap(async (req, res) => {
    const { candidateId, jobId, applicationId } = req.query;

    const out = await withUser(req.session, async (c) => {
      const where = [], params = [];
      if (candidateId)   { params.push(candidateId);   where.push(`candidate_id=$${params.length}`); }
      if (jobId)         { params.push(jobId);         where.push(`job_id=$${params.length}`); }
      if (applicationId) { params.push(applicationId); where.push(`application_id=$${params.length}`); }
      const clause = where.length ? `where ${where.join(' and ')}` : '';

      const rows = await c.query(
        `select * from ai_interviews ${clause} order by completed_at desc limit 100`, params);
      const ids = rows.rows.map((x) => x.id);
      const answers = ids.length
        ? await c.query(
            `select * from ai_interview_answers where ai_interview_id = any($1) order by seq`, [ids])
        : { rows: [] };
      return { rows: rows.rows, answers: answers.rows };
    });

    // The spec keeps per-question justifications "for audit, not
    // necessarily shown to the candidate". The candidate sees their own
    // questions and scores; the reasoning text stays with the hiring side.
    const isCandidate = req.session.role === 'candidate';

    const byInterview = new Map();
    for (const a of out.answers) {
      if (!byInterview.has(a.ai_interview_id)) byInterview.set(a.ai_interview_id, []);
      byInterview.get(a.ai_interview_id).push({
        seq: a.seq,
        category: a.category,
        question: a.question,
        answered: a.answered,
        answerSummary: a.answer_summary || undefined,
        score: Number(a.score),
        commScore: a.comm_score == null ? null : Number(a.comm_score),
        ...(isCandidate ? {} : { justification: a.justification || undefined }),
      });
    }

    res.json({
      aiInterviews: out.rows.map((row) => ({
        ...toAi(row),
        perQuestion: byInterview.get(row.id) || [],
      })),
    });
  }));

  /**
   * POST /api/ai-interviews — record a completed session.
   *
   * Goes through the SECURITY DEFINER function because the person taking
   * the interview is the candidate, and a candidate must not hold write
   * permission on a scoring table.
   */
  r.post('/ai-interviews', requireAuth(), wrap(async (req, res) => {
    const b = parse(recordSchema, req.body);

    // A candidate may only record their own session.
    if (req.session.role === 'candidate' && req.session.profileId !== b.candidateId) {
      throw forbidden('You can only submit your own interview.');
    }
    if (!['candidate', 'recruiter', 'admin'].includes(req.session.role)) {
      throw forbidden('Only a candidate or recruiter can record an interview result.');
    }

    const id = newId('aiv');

    const out = await withUser(req.session, async (c) => {
      // The candidate must actually have an application to this job.
      const app = await c.query(
        `select id from applications where candidate_id=$1 and job_id=$2 limit 1`,
        [b.candidateId, b.jobId]);
      if (!app.rowCount && !b.applicationId) {
        throw badRequest('No application exists for that candidate and job.');
      }

      const answers = b.answers.map((a) => ({
        seq: a.seq,
        category: a.category,
        question: a.question,
        answered: !!a.answered,
        answer_summary: a.answerSummary || null,
        score: a.score,
        comm_score: a.commScore ?? null,
        justification: a.justification || null,
      }));

      await c.query(
        `select ai_interview_record($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
        [id, b.candidateId, b.jobId, b.applicationId || app.rows[0].id,
         b.mode || 'voice', !!b.contentScored, b.transcript || null,
         b.feedback || null, b.questionSetHash || null,
         b.startedAt || null, JSON.stringify(answers)]);

      const saved = await c.query(`select * from ai_interviews where id=$1`, [id]);
      const rows = await c.query(
        `select * from ai_interview_answers where ai_interview_id=$1 order by seq`, [id]);
      return { row: saved.rows[0], answers: rows.rows };
    });

    if (!out.row) throw notFound('The interview could not be recorded.');

    res.status(201).json({
      aiInterview: {
        ...toAi(out.row),
        perQuestion: out.answers.map((a) => ({
          seq: a.seq, category: a.category, question: a.question,
          answered: a.answered, score: Number(a.score),
          commScore: a.comm_score == null ? null : Number(a.comm_score),
          justification: a.justification || undefined,
        })),
      },
    });
  }));

  /**
   * GET /api/ai-interviews/question-set-used?candidateId=&hash=
   *
   * Lets the browser check, before starting, whether it is about to put
   * the same question set to this candidate again. The prototype only
   * remembered the LAST set, in localStorage — so clearing storage or
   * moving machine silently allowed a repeat, which the spec forbids.
   * The server remembers every set this candidate has ever been asked.
   */
  r.get('/ai-interviews/question-set-used', requireAuth(), wrap(async (req, res) => {
    const { candidateId, hash } = req.query;
    if (!candidateId || !hash) throw badRequest('candidateId and hash are required.');
    const used = await withUser(req.session, async (c) => {
      const { rows } = await c.query(`select ai_question_set_used($1,$2) as used`,
        [String(candidateId), String(hash)]);
      return rows[0].used;
    });
    res.json({ used: !!used });
  }));

  return r;
}
