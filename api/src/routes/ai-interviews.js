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
import { planInterview, followUp, evaluate, interviewEngine } from '../ai/interview.js';
import { toJob, toCandidate } from '../shapes.js';

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
  /**
   * GET /api/ai-interviews/engine
   *
   * Says plainly whether a model is behind the interview or not, so the
   * screen can stop claiming one when there is none.
   */
  r.get('/ai-interviews/engine', (_req, res) => res.json(interviewEngine()));

  /* ------------------------------------------------------------------ *
   * conducting the interview
   *
   * The browser speaks and listens - that part must be in the page. What
   * to ask, what to ask NEXT, and what the answers were worth are decided
   * here, because a candidate should not be able to choose their own
   * questions or compute their own score.
   * ------------------------------------------------------------------ */

  /**
   * POST /api/ai-interviews/session — begin, and get the questions.
   *
   * The questions are planned from THIS job's description, so two roles
   * produce two different interviews (api/src/ai/interview.js). The plan is
   * stored against the interview row, which is what makes the follow-ups
   * and the grading afterwards possible.
   */
  r.post('/ai-interviews/session', requireAuth(), wrap(async (req, res) => {
    const b = parse(z.object({
      applicationId: z.string().trim().min(1).max(64).optional(),
      jobId: z.string().trim().min(1).max(64).optional(),
      count: z.number().int().min(4).max(15).optional(),
    }), req.body);

    if (req.session.role !== 'candidate') {
      throw forbidden('Only a candidate can sit an interview.');
    }

    const out = await withUser(req.session, async (c) => {
      // The interview belongs to an APPLICATION. Without one there is
      // nothing for a score to attach to, and the requirement is explicit
      // that interview, candidate, application and job stay linked.
      const app = b.applicationId
        ? (await c.query(`select * from applications where id=$1 and candidate_id=$2`,
            [b.applicationId, req.session.profileId])).rows[0]
        : (await c.query(
            `select * from applications where candidate_id=$1 ${b.jobId ? 'and job_id=$2' : ''}
              order by applied_at desc limit 1`,
            b.jobId ? [req.session.profileId, b.jobId] : [req.session.profileId])).rows[0];

      if (!app) throw badRequest('You have no application to interview for.');

      const job = (await c.query(`select * from jobs where id=$1`, [app.job_id])).rows[0];
      if (!job) throw notFound('That job no longer exists.');
      const cand = (await c.query(`select * from candidates where id=$1`,
        [req.session.profileId])).rows[0];

      const questions = await planInterview({
        job: toJob(job),
        candidate: cand ? toCandidate(cand) : null,
        count: b.count || 8,
      });

      const id = newId('aiv');

      // Through the definer function, not a direct insert: a candidate has
      // no write access to ai_interviews, and should not - that is where
      // the scores live. The function checks the application is theirs.
      await c.query(
        `select ai_interview_start($1,$2,$3,$4,$5,$6::jsonb)`,
        [id, app.id, req.session.profileId, app.job_id, hashOf(questions),
         JSON.stringify(questions.map((q) => ({
           seq: q.seq, category: q.category, question: q.question,
           meta: JSON.stringify({ expects: q.expects || [], source: q.source || null }),
         })))]);

      return { id, app, job, questions };
    });

    res.status(201).json({
      interviewId: out.id,
      applicationId: out.app.id,
      jobId: out.job.id,
      jobTitle: out.job.title,
      engine: interviewEngine(),
      questions: out.questions,
    });
  }));

  /**
   * POST /api/ai-interviews/:id/answer — record one answer, get what comes next.
   *
   * The follow-up is generated from what the candidate actually said. A
   * thorough answer gets none, which is the point: it is a reaction, not a
   * scripted extra question.
   */
  r.post('/ai-interviews/:id/answer', requireAuth(), wrap(async (req, res) => {
    const b = parse(z.object({
      seq: z.number().int().min(1).max(50),
      transcript: z.string().max(20_000).optional().default(''),
      answered: z.boolean().optional(),
      voicedMs: z.number().int().min(0).max(3_600_000).optional(),
    }), req.body);

    const out = await withUser(req.session, async (c) => {
      const iv = (await c.query(
        `select * from ai_interviews where id=$1 and candidate_id=$2`,
        [req.params.id, req.session.profileId])).rows[0];
      if (!iv) throw notFound('That interview could not be found.');
      if (iv.status !== 'in_progress') throw badRequest('That interview is already finished.');

      const row = (await c.query(
        `select * from ai_interview_answers where ai_interview_id=$1 and seq=$2`,
        [req.params.id, b.seq])).rows[0];
      if (!row) throw notFound('That question is not part of this interview.');

      const said = String(b.transcript || '').trim();
      const answered = b.answered !== undefined ? !!b.answered : !!said;

      // Only the transcript is stored. The SCORE is computed at the end,
      // over the whole interview, so one answer cannot be graded out of
      // context and a client cannot post a score of its own.
      await c.query(`select ai_interview_answer($1,$2,$3,$4,$5)`,
        [req.params.id, req.session.profileId, b.seq, answered,
         said.slice(0, 4000) || null]);

      const job = (await c.query(`select * from jobs where id=$1`, [iv.job_id])).rows[0];
      const meta = metaOf(row);
      const next = (await c.query(
        `select seq, category, question from ai_interview_answers
          where ai_interview_id=$1 and seq > $2 order by seq limit 1`,
        [req.params.id, b.seq])).rows[0] || null;

      return { iv, job, meta, next, said, answered, row };
    });

    // Outside the transaction: this may call a model, and an open
    // transaction must never wait on a third party.
    let follow = null;
    if (out.answered && out.said) {
      follow = await followUp({
        question: { question: out.row.question, expects: out.meta.expects },
        answer: out.said,
        job: toJob(out.job),
      }).catch(() => null);
    }

    res.json({
      recorded: { seq: req.body.seq, answered: out.answered, chars: out.said.length },
      followUp: follow,
      next: out.next ? { seq: out.next.seq, category: out.next.category, question: out.next.question } : null,
      remaining: out.next ? 1 : 0,
    });
  }));

  /**
   * POST /api/ai-interviews/:id/finish — grade what was actually said.
   *
   * Called only when the candidate has been through the questions. The
   * scores come from the stored transcripts, not from anything the browser
   * sends, and the aggregates are recomputed from the per-question rows.
   */
  r.post('/ai-interviews/:id/finish', requireAuth(), wrap(async (req, res) => {
    const loaded = await withUser(req.session, async (c) => {
      const iv = (await c.query(
        `select * from ai_interviews where id=$1 and candidate_id=$2`,
        [req.params.id, req.session.profileId])).rows[0];
      if (!iv) throw notFound('That interview could not be found.');

      const rows = (await c.query(
        `select * from ai_interview_answers where ai_interview_id=$1 order by seq`,
        [req.params.id])).rows;
      const job = (await c.query(`select * from jobs where id=$1`, [iv.job_id])).rows[0];
      return { iv, rows, job };
    });

    if (loaded.iv.status === 'completed') {
      return res.json({ alreadyFinished: true, aiInterviewId: loaded.iv.id });
    }

    const graded = await evaluate({
      job: toJob(loaded.job),
      answers: loaded.rows.map((r) => ({
        seq: r.seq, category: r.category, question: r.question,
        answered: r.answered, transcript: r.answer_summary || '',
        expects: metaOf(r).expects,
      })),
    });

    const saved = await withUser(req.session, async (c) => {
      // Every number here was computed by evaluate() from the stored
      // transcripts. Nothing the browser sent reaches this call.
      await c.query(
        `select ai_interview_finish($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
        [loaded.iv.id, req.session.profileId,
         graded.technical, graded.behavioral, graded.communication, graded.overall,
         graded.contentScored, graded.feedback,
         loaded.rows.map((r) => `Q: ${r.question}\nA: ${r.answer_summary || '[no response]'}`).join('\n\n'),
         JSON.stringify(graded.perQuestion.map((p) => ({
           seq: p.seq, score: p.score,
           commScore: p.commScore == null ? '' : p.commScore,
           justification: p.justification || null,
         })))]);

      const row = (await c.query(`select * from ai_interviews where id=$1`, [loaded.iv.id])).rows[0];
      return row;
    });

    res.json({
      aiInterview: toAi(saved),
      engine: graded.engine,
      perQuestion: graded.perQuestion,
    });
  }));

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

/** Per-question planning data rides in `justification` until grading fills it. */
function metaOf(row) {
  try {
    const v = JSON.parse(row.justification || '{}');
    return v && typeof v === 'object' && Array.isArray(v.expects)
      ? { expects: v.expects, source: v.source || null }
      : { expects: [], source: null };
  } catch { return { expects: [], source: null }; }
}

/** Stable fingerprint, so the same set is never put to the same candidate twice. */
function hashOf(questions) {
  const s = questions.map((q) => q.question).join('|');
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return `qs${h.toString(36)}-${questions.length}`;
}
