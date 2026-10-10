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
import { wrap, badRequest, notFound, forbidden, ApiError } from '../errors.js';
import { requireAuth, requireRole } from '../auth.js';
import multer from 'multer';
import { planInterview, decideFollowUp, evaluate, interviewEngine, BLUEPRINT_TOTAL }
  from '../ai/interview.js';
import { toJob, toCandidate } from '../shapes.js';
import { dispatchEvent } from '../notify/events.js';
import { CODES } from '../errors.js';
import { storeRecording, getStorage, RECORDING_MAX_BYTES } from '../storage.js';
import { speechModes, sttEnabled, ttsEnabled, transcribe, synthesise } from '../ai/interview-speech.js';
import { retakePolicy, questionSeconds, PAGE_STOPS, formatWhen } from '../interview/policy.js';
import { afterSuspension } from '../notify/interview-suspension.js';

/* Recordings are inspected in memory before anything is written, exactly
   like a resume (routes/uploads.js). */
const recordingUpload = () => multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: RECORDING_MAX_BYTES(), files: 1, fields: 10 },
});

/** Every candidate-side writer: the interview must be theirs and running. */
function assertRunning(iv) {
  if (!iv) throw notFound('That interview could not be found.');
  if (iv.status === 'suspended') {
    throw new ApiError(423, 'INTERVIEW_SUSPENDED',
      'This interview has been suspended and the recruitment team will review '
      + 'the session. It cannot be continued until a recruiter reopens it.');
  }
  if (iv.status !== 'in_progress' && iv.status !== 'warning_issued') {
    throw badRequest('That interview is already finished.');
  }
}

const newId = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/*
 * The identity the integrity routes use for the two `security definer`
 * functions in migration 0059, and for writing the audit trail.
 *
 * WHOSE INTERVIEW IT IS is decided BEFORE this is used, by loading the
 * row under the caller's own session - so this widens what can be
 * written, never what can be reached.
 */
const ENGINE_SESSION = { userId: '', role: 'admin', profileId: null };

/**
 * An AI interview must be completed within two days of being scheduled.
 * Configurable, because a client with a slower process will ask.
 */
const DEADLINE_HOURS = Number(process.env.AI_INTERVIEW_DEADLINE_HOURS || 48);

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
  // Scored separately: knowing the job's stack and being able to speak to
  // your own resume are different things, and a recruiter wants both.
  jdRelevance: r.jd_relevance == null ? null : Number(r.jd_relevance),
  resumeRelevance: r.resume_relevance == null ? null : Number(r.resume_relevance),
  startedAt: r.started_at ? new Date(r.started_at).toISOString() : undefined,
  expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : undefined,
  durationSeconds: r.duration_seconds == null ? null : Number(r.duration_seconds),
  questionsAsked: r.questions_asked,
  questionsAnswered: r.questions_answered,
  // Surfaced deliberately: when the browser could not transcribe, the score
  // is an estimate from response length, and the UI must be able to say so
  // rather than present it as a content-based result.
  contentScored: !!r.content_scored,
  feedback: r.feedback || undefined,
  completedAt: r.completed_at ? new Date(r.completed_at).toISOString() : undefined,
});

/* 0133: what a candidate is told when the job (or the interview's date) is over */
export const INTERVIEW_CLOSED_MESSAGE = 'You applied for this job, but the date is over, so you cannot attend the interview now.';

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
        section: a.section || undefined,
        question: a.question,
        answered: a.answered,
        answerSummary: a.answer_summary || undefined,
        score: Number(a.score),
        commScore: a.comm_score == null ? null : Number(a.comm_score),
        detail: a.detail || undefined,
        ...(isCandidate ? {} : {
          justification: a.justification || undefined,
          relevanceClass: a.relevance_class || undefined,
          maxScore: a.max_score == null ? 100 : Number(a.max_score),
          needsReview: !!a.needs_review,
          reviewReason: a.review_reason || undefined,
          lowTranscriptConfidence: a.transcription_confidence != null && Number(a.transcription_confidence) < 0.6,
        }),
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
      count: z.number().int().min(4).max(30).optional(),
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

      /*
       * A SUSPENDED INTERVIEW CANNOT BE WALKED AROUND, BUT IT IS NOT THE END.
       *
       * The suspension stands until its retake time. After that the SAME
       * application may start one new attempt - decided HERE, from the
       * stored retake_available_at and the database's clock (UTC), never
       * from the browser: a candidate who calls this early, or edits the
       * page, is refused. One retake by default (INTERVIEW_MAX_ATTEMPTS);
       * a recruiter's block overrides it; a recruiter can grant more. A
       * second application for the same role is not a way round it - the
       * attempts belong to the application.
       */
      const policy = retakePolicy();
      await c.query(`select ai_interview_expire_overdue()`);
      const attempts = (await c.query(
        `select id, status, attempt_number, suspended_at, suspension_message, retake_available_at, retake_blocked,
                started_at, expires_at,
                (retake_available_at is not null and now() >= retake_available_at) as retake_open
           from ai_interviews
          where application_id=$1 and candidate_id=$2
          order by attempt_number desc`,
        [app.id, req.session.profileId])).rows;
      let last = attempts[0];

      /*
       * AN INTERVIEW THAT IS DONE IS NOT STARTED AGAIN.
       *
       * This route used to make a brand-new interview every time it was called,
       * whatever state the last one was in: a candidate who had COMPLETED the
       * interview could open it again and be welcomed afresh ("Thanks for
       * joining...") from Question 1, and one in progress got a duplicate. Now:
       *   completed / being marked   -> refused, with a plain message
       *   expired                    -> refused (only a recruiter reopens it)
       *   in progress                -> the SAME interview is handed back to carry on from
       * Only a suspended interview whose retake is open (below), or a first
       * interview, creates a new attempt.
       */
      if (last && ['completed', 'evaluating', 'evaluated'].includes(last.status)) {
        throw new ApiError(409, 'INTERVIEW_ALREADY_COMPLETED',
          'You have already completed this interview. Thank you — the recruitment team will review it and contact you about the next step.',
          { attemptNumber: last.attempt_number });
      }
      if (last && last.status === 'expired') {
        /* 0138: an attempt that ran out of ITS OWN time is reopened where the candidate left it while the
           job's window is still open ("No deadline - Attend any time" means exactly that). Only a closed
           window - the job closed, its date or the walk-in day passed - keeps it shut. */
        const back = (await c.query(`select ai_interview_resume_expired($1,$2,$3) as ok`,
          [last.id, req.session.profileId, DEADLINE_HOURS])).rows[0].ok;
        if (back) {
          const now = (await c.query(`select status, started_at, expires_at from ai_interviews where id=$1`, [last.id])).rows[0];
          last = { ...last, ...now };
        } else {
          const w = (await c.query(`select * from ai_interview_window($1)`, [app.id])).rows[0];
          if (w && !w.open) throw new ApiError(410, 'INTERVIEW_CLOSED', INTERVIEW_CLOSED_MESSAGE, { reason: w.reason });
          throw new ApiError(410, 'INTERVIEW_EXPIRED',
            'This interview has passed its deadline and can no longer be started. Please contact the recruiter if you need it reopened.');
        }
      }
      if (last && (last.status === 'in_progress' || last.status === 'warning_issued')) {
        const rows = (await c.query(
          `select seq, category, section, question, justification from ai_interview_answers
            where ai_interview_id=$1 order by seq`, [last.id])).rows;
        const parts = (await c.query(
          `select seq, part, question, kind, submitted_at from ai_interview_answer_parts where interview_id=$1`,
          [last.id])).rows;
        const questions = rows.map((r) => {
          const meta = metaOf(r);
          return { seq: r.seq, category: r.category, section: r.section || undefined, question: r.question,
            expects: meta.expects, source: meta.source };
        });
        const pend = questions.find((q) => {
          const main = parts.find((p) => p.seq === q.seq && p.part === 'main' && p.submitted_at);
          const fu = parts.find((p) => p.seq === q.seq && p.part === 'followup');
          return !main || (fu && !fu.submitted_at);
        });
        let resumeAt = null;
        if (pend) {
          const main = parts.find((p) => p.seq === pend.seq && p.part === 'main' && p.submitted_at);
          const fu = parts.find((p) => p.seq === pend.seq && p.part === 'followup');
          resumeAt = { seq: pend.seq, part: main ? 'followup' : 'main',
            followUp: main && fu ? fu.question : null, kind: main && fu ? fu.kind : null };
        }
        const job = (await c.query(`select * from jobs where id=$1`, [app.job_id])).rows[0];
        return { resumed: { id: last.id, app, job, questions, resumeAt, row: { started_at: last.started_at, expires_at: last.expires_at } } };
      }

      if (last && last.status === 'suspended') {
        const suspendedCount = attempts.filter((a) => a.status === 'suspended').length;
        const allowed = policy.maxAttempts + Number(app.extra_interview_attempts || 0);
        const info = {
          attemptNumber: last.attempt_number,
          suspendedAt: last.suspended_at ? new Date(last.suspended_at).toISOString() : null,
          reason: last.suspension_message || null,
        };
        if (last.retake_blocked || !last.retake_available_at || suspendedCount >= allowed) {
          throw new ApiError(423, 'INTERVIEW_UNDER_REVIEW',
            'Your interview is under recruiter review. You will be informed of the next steps.', info);
        }
        if (!last.retake_open) {
          const at = new Date(last.retake_available_at);
          throw new ApiError(423, 'INTERVIEW_RETAKE_WAIT',
            `You can retake this interview after ${formatWhen(at)}.`,
            { ...info, retakeAvailableAt: at.toISOString() });
        }
        /* open: fall through and create the next attempt (numbered by the database) */
      }

      /* 0133: OPEN ONLY WHILE THE JOB IS. Closed, its last date passed, a walk-in whose day is over, or the
         interview's own date passed: refused before any question is written (and again inside
         ai_interview_start, so the API cannot be used to skip it). A job with no date stays open.
         Asked BEFORE reading the job: a candidate cannot read a closed or expired job at all, which used
         to come out as "That job no longer exists". */
      const win = (await c.query(`select * from ai_interview_window($1)`, [app.id])).rows[0];
      if (win && !win.open) {
        throw new ApiError(410, 'INTERVIEW_CLOSED', INTERVIEW_CLOSED_MESSAGE, { reason: win.reason });
      }

      const job = (await c.query(`select * from jobs where id=$1`, [app.job_id])).rows[0];
      if (!job) throw notFound('That job no longer exists.');

      const cand = (await c.query(`select * from candidates where id=$1`,
        [req.session.profileId])).rows[0];

      const questions = await planInterview({
        job: toJob(job),
        candidate: cand ? toCandidate(cand) : null,
        // The blueprint: 2 introduction, 5 from the job description,
        // 5 from the resume, 3 behavioural.
        count: b.count || BLUEPRINT_TOTAL,
      });

      const id = newId('aiv');

      // Through the definer function, not a direct insert: a candidate has
      // no write access to ai_interviews, and should not - that is where
      // the scores live. The function checks the application is theirs.
      await c.query(
        `select ai_interview_start($1,$2,$3,$4,$5,$6::jsonb,$7)`,
        [id, app.id, req.session.profileId, app.job_id, hashOf(questions),
         JSON.stringify(questions.map((q) => ({
           seq: q.seq, category: q.category, section: q.section || null,
           question: q.question,
           meta: JSON.stringify({ expects: q.expects || [], source: q.source || null }),
         }))),
         DEADLINE_HOURS]);

      const row = (await c.query(
        `select expires_at, started_at from ai_interviews where id=$1`, [id])).rows[0];
      return { id, app, job, questions, row };
    });

    if (out.resumed) {
      const x = out.resumed;
      return res.status(200).json({
        interviewId: x.id, applicationId: x.app.id, jobId: x.app.job_id, jobTitle: x.job ? x.job.title : '',
        engine: interviewEngine(),
        startedAt: x.row.started_at, expiresAt: x.row.expires_at, deadlineHours: DEADLINE_HOURS,
        questionSeconds: questionSeconds(), speech: speechModes(),
        blueprint: { intro: 2, jd: 5, resume: 5, behavioral: 3, total: x.questions.length },
        questions: x.questions, resumed: true, resumeAt: x.resumeAt,
      });
    }

    res.status(201).json({
      interviewId: out.id,
      applicationId: out.app.id,
      jobId: out.job.id,
      jobTitle: out.job.title,
      engine: interviewEngine(),
      // The candidate has two days. Both ends are sent so the screen can
      // show a deadline rather than a countdown it invented.
      startedAt: out.row ? out.row.started_at : null,
      expiresAt: out.row ? out.row.expires_at : null,
      deadlineHours: DEADLINE_HOURS,
      // Seconds each question gets (never under 120). The server keeps the clock.
      questionSeconds: questionSeconds(),
      // Where speech is processed - the browser unless a server provider
      // is configured. Modes only; no endpoint or key ever goes out.
      speech: speechModes(),
      blueprint: { intro: 2, jd: 5, resume: 5, behavioral: 3, total: out.questions.length },
      questions: out.questions,
    });
  }));

  /**
   * POST /api/ai-interviews/:id/question-start
   *
   * The page calls this when the interviewer has FINISHED asking, so the
   * candidate always gets the whole time. The first call fixes the deadline
   * (server clock, UTC); every later call - a refresh, a retry after a
   * dropped connection, a client with a wrong clock - gets the SAME deadline
   * and the time that is really left.
   */
  r.post('/ai-interviews/:id/question-start', requireAuth(), wrap(async (req, res) => {
    const b = parse(z.object({
      seq: z.number().int().min(1).max(50),
      part: z.enum(['main', 'followup']).optional().default('main'),
    }), req.body);
    if (req.session.role !== 'candidate') throw forbidden('Only the candidate can run their interview.');
    const t = await withUser(req.session, async (c) => {
      const iv = (await c.query(`select id from ai_interviews where id=$1 and candidate_id=$2`,
        [req.params.id, req.session.profileId])).rows[0];
      if (!iv) throw notFound('That interview could not be found.');
      return (await c.query(`select * from ai_interview_question_start($1,$2,$3,$4,$5)`,
        [iv.id, req.session.profileId, b.seq, b.part, questionSeconds()])).rows[0];
    }).catch((err) => {
      if (err && /not part of this interview|no follow-up/.test(String(err.message))) throw notFound('That question is not part of this interview.');
      if (err && /not running|already finished|suspended/i.test(String(err.message))) throw new ApiError(423, 'INTERVIEW_NOT_RUNNING', 'This interview is not running.');
      throw err;
    });
    res.json({
      seq: b.seq, part: b.part, seconds: t.seconds,
      startedAt: new Date(t.started_at).toISOString(),
      deadlineAt: new Date(t.deadline_at).toISOString(),
      remainingMs: Number(t.remaining_ms),
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
    /* No score, justification or decision field exists in this schema, so
       nothing a candidate adds to the body can reach one (zod drops
       unknown keys). */
    const b = parse(z.object({
      seq: z.number().int().min(1).max(50),
      transcript: z.string().max(20_000).optional().default(''),
      answered: z.boolean().optional(),
      voicedMs: z.number().int().min(0).max(3_600_000).optional(),
      // 'followup' answers the one follow-up this question was given.
      part: z.enum(['main', 'followup']).optional().default('main'),
      // The question's time ran out: whatever was said so far is saved, an
      // empty one as "unanswered". Never a violation.
      autoSubmitted: z.boolean().optional().default(false),
      // How sure the speech recogniser was, 0..1 (average over the answer).
      confidence: z.number().min(0).max(1).optional(),
    }), req.body);

    const out = await withUser(req.session, async (c) => {
      const iv = (await c.query(
        `select * from ai_interviews where id=$1 and candidate_id=$2`,
        [req.params.id, req.session.profileId])).rows[0];
      if (!iv) throw notFound('That interview could not be found.');
      // Two days, and the database is the clock. An interview left open
      // past its deadline is expired, not merely late.
      if (iv.status === 'in_progress' && iv.expires_at && new Date(iv.expires_at) < new Date()) {
        await c.query(`select ai_interview_expire_overdue()`);
        throw new ApiError(410, 'INTERVIEW_EXPIRED',
          'This interview has passed its deadline and can no longer be completed. ' +
          'Please contact the recruiter if you need it reopened.');
      }
      /*
       * SUSPENDED IS NOT FINISHED, and it does not say so.
       *
       * A first integrity warning moves the status to `warning_issued`
       * and the candidate carries on answering - that is the whole point
       * of a two-strike rule, and refusing their next answer as "already
       * finished" would make strike one behave like strike two. A
       * SUSPENDED interview is refused, in its own words, because
       * "finished" would tell them the opposite of what happened.
       */
      if (iv.status === 'suspended') {
        throw new ApiError(423, 'INTERVIEW_SUSPENDED',
          'This interview has been suspended and the recruitment team will review '
          + 'the session. It cannot be continued until a recruiter reopens it.');
      }
      if (iv.status !== 'in_progress' && iv.status !== 'warning_issued') {
        throw badRequest('That interview is already finished.');
      }

      const row = (await c.query(
        `select * from ai_interview_answers where ai_interview_id=$1 and seq=$2`,
        [req.params.id, b.seq])).rows[0];
      if (!row) throw notFound('That question is not part of this interview.');

      const said = String(b.transcript || '').trim();
      const answered = b.answered !== undefined ? !!b.answered : !!said;

      const parts = (await c.query(
        `select part, question, kind, submitted_at from ai_interview_answer_parts
          where interview_id=$1 and seq=$2`, [req.params.id, b.seq])).rows;
      const offered = parts.find((p) => p.part === 'followup') || null;
      if (b.part === 'followup' && !offered) {
        throw badRequest('No follow-up was asked for that question.');
      }

      /* Only the transcript is stored. The SCORE is computed at the end,
         over the whole interview, so one answer cannot be graded out of
         context and a client cannot post a score of its own.

         Idempotent: the same part posted again - a retry after a dropped
         connection - replaces itself (0116). */
      await c.query(`select ai_interview_part_save($1,$2,$3,$4,$5,$6,$7,$8)`,
        [req.params.id, req.session.profileId, b.seq, b.part, answered, said || null,
         b.autoSubmitted, b.confidence == null ? null : b.confidence]);

      const job = (await c.query(`select * from jobs where id=$1`, [iv.job_id])).rows[0];
      const meta = metaOf(row);
      const next = (await c.query(
        `select seq, category, question from ai_interview_answers
          where ai_interview_id=$1 and seq > $2 order by seq limit 1`,
        [req.params.id, b.seq])).rows[0] || null;

      return { iv, job, meta, next, said, answered, row, offered };
    });

    /* THE ONE FOLLOW-UP. Proposed outside the transaction - it may call a
       model, and an open transaction must never wait on a third party -
       and then offered through the database, which keeps at most one per
       question. A retried main answer is handed the follow-up already on
       file rather than a second one. An answer TO a follow-up never gets
       another. */
    let follow = null;
    let kind = null;
    if (b.part === 'main') {
      if (out.offered) {
        follow = out.offered.question;
        kind = out.offered.kind;
      } else if (out.answered && out.said && !b.autoSubmitted) {   // out of time: no follow-up
        const d = await decideFollowUp({
          question: { question: out.row.question, expects: out.meta.expects },
          answer: out.said,
          job: toJob(out.job),
        }).catch(() => null);
        if (d && d.text) {
          follow = await withUser(req.session, async (c) => (await c.query(
            `select ai_interview_followup_offer($1,$2,$3,$4,$5) as q`,
            [req.params.id, req.session.profileId, b.seq, d.text, d.kind])).rows[0].q)
            .catch(() => null);
          kind = follow ? d.kind : null;
        }
      }
    }

    res.json({
      recorded: { seq: b.seq, part: b.part, answered: out.answered, chars: out.said.length },
      followUp: follow,
      followUpKind: kind,
      // After a "no experience" reply the interview moves on whatever
      // the candidate says next.
      next: out.next ? { seq: out.next.seq, category: out.next.category, question: out.next.question } : null,
      remaining: out.next ? 1 : 0,
    });
  }));

  /**
   * GET /api/ai-interviews/:id/progress — where this interview has got to.
   *
   * What the screen needs to carry on after a dropped connection or a
   * reload: the questions, which have been answered (and whether their
   * follow-up was), and which recordings arrived. The SERVER is the
   * record; the page's sessionStorage copy is only a convenience. No
   * score, justification or decision is in this response.
   */
  r.get('/ai-interviews/:id/progress', requireAuth(), wrap(async (req, res) => {
    if (req.session.role !== 'candidate') throw forbidden('Only the candidate can resume their interview.');
    const out = await withUser(req.session, async (c) => {
      const iv = (await c.query(
        `select id, status, application_id, job_id, expires_at, started_at
           from ai_interviews where id=$1 and candidate_id=$2`,
        [req.params.id, req.session.profileId])).rows[0];
      if (!iv) return null;
      /* A question whose time ran out while the candidate was away is saved as
         "unanswered, ran out of time" and the interview moves on. Not a
         violation, not a suspension. */
      if (iv.status === 'in_progress' || iv.status === 'warning_issued') {
        await c.query(`select ai_interview_expire_questions($1,$2)`, [iv.id, req.session.profileId]);
      }
      const timers = (await c.query(`select * from ai_interview_clocks($1,$2)`, [iv.id, req.session.profileId])).rows;
      const rows = (await c.query(
        `select seq, category, section, question, justification
           from ai_interview_answers where ai_interview_id=$1 order by seq`, [iv.id])).rows;
      const parts = (await c.query(
        `select seq, part, question, kind, answered, submitted_at
           from ai_interview_answer_parts where interview_id=$1`, [iv.id])).rows;
      const recs = (await c.query(
        `select seq, part, size_bytes from ai_interview_recordings where interview_id=$1`, [iv.id])).rows;
      return { iv, rows, parts, recs, timers };
    });
    if (!out) throw notFound('That interview could not be found.');

    const running = out.iv.status === 'in_progress' || out.iv.status === 'warning_issued';
    const expired = !!(out.iv.expires_at && new Date(out.iv.expires_at) < new Date());
    const questions = out.rows.map((r) => {
      const meta = running ? metaOf(r) : { expects: [], source: null };
      const main = out.parts.find((p) => p.seq === r.seq && p.part === 'main' && p.submitted_at);
      const fu = out.parts.find((p) => p.seq === r.seq && p.part === 'followup');
      return {
        seq: r.seq, category: r.category, section: r.section || undefined, question: r.question,
        // the same planning fields the session handed out
        expects: meta.expects, source: meta.source,
        submitted: !!main,
        followUp: fu ? { question: fu.question, kind: fu.kind, submitted: !!fu.submitted_at } : null,
        recordings: out.recs.filter((x) => x.seq === r.seq).map((x) => x.part),
      };
    });
    const pending = questions.find((q) => !q.submitted || (q.followUp && !q.followUp.submitted));
    const pendingPart = pending ? (pending.submitted ? 'followup' : 'main') : null;
    const clock = pending ? out.timers.find((t) => t.seq === pending.seq && t.part === pendingPart) : null;

    res.json({
      interviewId: out.iv.id,
      applicationId: out.iv.application_id,
      jobId: out.iv.job_id,
      status: expired && running ? 'expired' : out.iv.status,
      resumable: running && !expired,
      expiresAt: out.iv.expires_at,
      startedAt: out.iv.started_at,
      speech: speechModes(),
      questions,
      // The question to carry on from, and whether it is its follow-up.
      resumeAt: pending ? { seq: pending.seq, part: pendingPart } : null,
      questionSeconds: questionSeconds(),
      // The running question's clock, from the server: a refresh cannot add time.
      clock: clock ? {
        seq: clock.seq, part: clock.part, seconds: clock.seconds,
        deadlineAt: new Date(clock.deadline_at).toISOString(),
        remainingMs: Math.max(0, new Date(clock.deadline_at) - new Date(clock.server_now)),
      } : null,
    });
  }));

  /**
   * POST /api/ai-interviews/:id/recordings — one answer's recording.
   *
   * Multipart, field `recording`, with `seq` and `part`. The same checks as
   * a resume upload: signed-in, the candidate's own interview, a size
   * limit, and the file identified by its bytes (WebM / MP4 / Ogg / WAV)
   * rather than by what the browser called it. Stored through the same
   * storage driver under a random key; nothing public is ever made.
   */
  r.post('/ai-interviews/:id/recordings', requireAuth(),
    (req, res, next) => {
      if (req.session.role !== 'candidate') return next(forbidden('Only the candidate can upload their own interview recording.'));
      return recordingUpload().single('recording')(req, res, (err) => {
        if (!err) return next();
        if (err.code === 'LIMIT_FILE_SIZE') {
          return next(new ApiError(413, CODES.FILE_TOO_LARGE,
            `That recording is too large. The limit is ${Math.round(RECORDING_MAX_BYTES() / 1024 / 1024)}MB.`));
        }
        return next(new ApiError(400, CODES.UPLOAD_FAILED, 'That recording could not be uploaded.'));
      });
    },
    wrap(async (req, res) => {
      if (!req.file) throw badRequest('No recording was attached.');
      const seq = Number(req.body?.seq);
      const part = String(req.body?.part || 'main');
      const durationMs = Number(req.body?.durationMs);
      if (!Number.isInteger(seq) || seq < 1 || seq > 50) throw badRequest('That question number is not valid.');
      if (!['main', 'followup'].includes(part)) throw badRequest('That answer part is not valid.');

      // Whose interview, and is it still accepting answers - under the
      // caller's own rights, BEFORE a byte is stored.
      const iv = await withUser(req.session, async (c) => (await c.query(
        `select id, status, completed_at, candidate_id from ai_interviews where id=$1 and candidate_id=$2`,
        [req.params.id, req.session.profileId])).rows[0]);
      if (!iv) throw notFound('That interview could not be found.');
      const lateOk = iv.status === 'completed' && iv.completed_at
        && Date.now() - new Date(iv.completed_at).getTime() < 2 * 3600 * 1000;
      if (!lateOk) assertRunning(iv);

      const stored = await storeRecording({
        candidateId: req.session.profileId, interviewId: iv.id,
        buffer: req.file.buffer, claimedMime: req.file.mimetype,
      });
      let replaced = null;
      try {
        replaced = await withUser(req.session, async (c) => (await c.query(
          `select ai_interview_recording_add($1,$2,$3,$4,$5,$6,$7,$8,$9) as old`,
          [iv.id, req.session.profileId, seq, part, stored.path, stored.mime, stored.size,
           Number.isFinite(durationMs) && durationMs >= 0 ? Math.min(Math.round(durationMs), 3_600_000) : null,
           stored.sha256])).rows[0].old);
      } catch (err) {
        await getStorage().remove(stored.path);     // never leave an orphan
        if (/not part of this interview/.test(String(err.message))) throw notFound('That question is not part of this interview.');
        if (/already finished|suspended/.test(String(err.message))) throw badRequest('That interview is no longer accepting answers.');
        throw err;
      }
      if (replaced && replaced !== stored.path) await getStorage().remove(replaced);

      /* Server speech-to-text, when configured: fills in an answer the
         browser could not caption. Never overwrites words the candidate
         already has on file, and a provider failure loses nothing - the
         recording is stored either way. */
      let transcribed = false;
      if (sttEnabled() && !lateOk) {
        try {
          const have = await withUser(req.session, async (c) => (await c.query(
            `select transcript, submitted_at from ai_interview_answer_parts
              where interview_id=$1 and seq=$2 and part=$3`, [iv.id, seq, part])).rows[0]);
          if (have && have.submitted_at && !String(have.transcript || '').trim()) {
            const text = await transcribe(req.file.buffer, stored.mime);
            if (text) {
              await withUser(req.session, (c) => c.query(
                `select ai_interview_part_save($1,$2,$3,$4,$5,$6)`,
                [iv.id, req.session.profileId, seq, part, true, text]));
              transcribed = true;
            }
          }
        } catch (err) {
          console.error('[interview] server speech-to-text failed:', err.message);
        }
      }

      res.status(201).json({
        recording: { seq, part, mime: stored.mime, size: stored.size },
        transcribed,
      });
    }));

  /**
   * GET /api/ai-interviews/:id/recordings — what was recorded.
   *
   * Read under the caller's own RLS (0116 inherits the interview's
   * visibility): the candidate, the recruiter and client for that
   * company, a BDE, an admin. Another candidate, or a recruiter at
   * another company, sees an empty list.
   */
  r.get('/ai-interviews/:id/recordings', requireAuth(), wrap(async (req, res) => {
    const rows = await withUser(req.session, async (c) => (await c.query(
      `select id, interview_id, candidate_id, job_id, application_id, seq, part, mime,
              size_bytes, duration_ms, created_at
         from ai_interview_recordings where interview_id=$1 order by seq, part`,
      [req.params.id])).rows);
    res.json({
      recordings: rows.map((x) => ({
        id: Number(x.id), interviewId: x.interview_id, candidateId: x.candidate_id,
        jobId: x.job_id, applicationId: x.application_id, seq: x.seq, part: x.part,
        mime: x.mime, size: Number(x.size_bytes),
        durationMs: x.duration_ms == null ? null : Number(x.duration_ms),
        createdAt: x.created_at,
        // Same-origin, permission-checked on every request. Not a public URL.
        url: `/api/ai-interviews/${encodeURIComponent(x.interview_id)}/recordings/${Number(x.id)}/file`,
      })),
    });
  }));

  /** The bytes, for a viewer RLS lets see the row. Logged for staff, like a resume. */
  r.get('/ai-interviews/:id/recordings/:rid/file', requireAuth(), wrap(async (req, res) => {
    const row = await withUser(req.session, async (c) => (await c.query(
      `select id, interview_id, candidate_id, storage_path, mime from ai_interview_recordings
        where id=$1 and interview_id=$2`, [Number(req.params.rid) || 0, req.params.id])).rows[0]);
    if (!row) throw notFound('That recording could not be found.');
    if (req.session.role !== 'candidate') {
      await withUser(ENGINE_SESSION, (c) => c.query(
        `insert into ai_interview_audit (interview_id, candidate_id, action, detail, actor_id, actor_role)
         values ($1,$2,'recording.viewed',$3::jsonb,$4,$5)`,
        [row.interview_id, row.candidate_id, JSON.stringify({ recordingId: Number(row.id) }),
         req.session.userId || null, req.session.role])).catch(() => {});
    }
    const buf = await getStorage().get(row.storage_path);
    res.setHeader('content-type', row.mime);
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('cache-control', 'private, no-store');
    res.setHeader('content-disposition', `inline; filename="interview-${Number(row.id)}"`);
    res.send(buf);
  }));

  /**
   * GET /api/ai-interviews/:id/speech?seq=N&part=main — the question in a
   * server voice. Only when INTERVIEW_TTS_PROVIDER is configured; the
   * screen otherwise uses the browser's speechSynthesis and never calls
   * this. The text spoken is the server's own question, never the
   * caller's.
   */
  r.get('/ai-interviews/:id/speech', requireAuth(), wrap(async (req, res) => {
    if (!ttsEnabled()) throw new ApiError(404, 'TTS_NOT_CONFIGURED', 'Server text-to-speech is not configured.');
    const seq = Number(req.query.seq);
    const part = String(req.query.part || 'main');
    const text = await withUser(req.session, async (c) => {
      const iv = (await c.query(`select id, status from ai_interviews where id=$1 and candidate_id=$2`,
        [req.params.id, req.session.profileId])).rows[0];
      assertRunning(iv);
      if (part === 'followup') {
        return (await c.query(`select question from ai_interview_answer_parts
          where interview_id=$1 and seq=$2 and part='followup'`, [iv.id, seq])).rows[0]?.question;
      }
      return (await c.query(`select question from ai_interview_answers where ai_interview_id=$1 and seq=$2`,
        [iv.id, seq])).rows[0]?.question;
    });
    if (!text) throw notFound('That question could not be found.');
    const audio = await synthesise(text).catch((err) => {
      console.error('[interview] server text-to-speech failed:', err.message);
      throw new ApiError(502, 'TTS_FAILED', 'The interviewer voice is unavailable; the question is on screen.');
    });
    res.setHeader('content-type', audio.mime);
    res.setHeader('cache-control', 'private, no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    res.send(audio.buffer);
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
      const parts = (await c.query(
        `select seq, part, question, transcript from ai_interview_answer_parts
          where interview_id=$1 and part='followup'`, [req.params.id])).rows;
      return { iv, rows, job, parts };
    });

    if (loaded.iv.status === 'completed') {
      return res.json({ alreadyFinished: true, aiInterviewId: loaded.iv.id });
    }
    /* A suspended session is not submitted for scoring. The answers up
       to the suspension are kept and a recruiter reviews them; turning
       them into a score would be this system deciding an integrity
       question it is explicitly not allowed to decide. */
    if (loaded.iv.status === 'suspended') {
      throw new ApiError(423, 'INTERVIEW_SUSPENDED',
        'This interview was suspended and cannot be submitted. The recruitment team '
        + 'will review the session.');
    }
    if (loaded.iv.status === 'expired' ||
        (loaded.iv.expires_at && new Date(loaded.iv.expires_at) < new Date())) {
      await withUser(req.session, (c) => c.query(`select ai_interview_expire_overdue()`));
      throw new ApiError(410, 'INTERVIEW_EXPIRED',
        'This interview has passed its deadline and can no longer be submitted.');
    }

    const graded = await evaluate({
      job: toJob(loaded.job),
      answers: loaded.rows.map((r) => ({
        seq: r.seq, category: r.category, section: r.section, question: r.question,
        answered: r.answered, transcript: r.answer_summary || '',
        confidence: r.transcription_confidence == null ? null : Number(r.transcription_confidence),
        expects: metaOf(r).expects,
      })),
    });

    const saved = await withUser(req.session, async (c) => {
      // Every number here was computed by evaluate() from the stored
      // transcripts. Nothing the browser sent reaches this call.
      await c.query(
        `select ai_interview_finish($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)`,
        [loaded.iv.id, req.session.profileId,
         graded.technical, graded.behavioral, graded.communication, graded.overall,
         graded.contentScored, graded.feedback,
         loaded.rows.map((r) => {
           /* The follow-up is part of the record: what was asked, and what
              was said to it. answer_summary already holds both answers'
              words for grading. */
           const fu = loaded.parts.find((p) => p.seq === r.seq);
           return `Q: ${r.question}\nA: ${r.answer_summary || '[no response]'}`
             + (fu ? `\nFollow-up: ${fu.question}\nA (follow-up): ${String(fu.transcript || '').trim() || '[no response]'}` : '');
         }).join('\n\n'),
         JSON.stringify(graded.perQuestion.map((p) => ({
           seq: p.seq, score: p.score,
           commScore: p.commScore == null ? '' : p.commScore,
           justification: p.justification || null,
           detail: p.detail || null,
           relevanceClass: p.relevanceClass || null,
           maxScore: p.maxScore == null ? 100 : p.maxScore,
           needsReview: !!p.needsReview,
           reviewReason: p.reviewReason || null,
         }))),
         graded.jdRelevance == null ? null : graded.jdRelevance,
         graded.resumeRelevance == null ? null : graded.resumeRelevance]);

      // In-app too. The portal's notification feed is where a candidate
      // looks first, and an interview that finishes silently there reads
      // as one that did not go through.
      const job = await c.query(`select title from jobs where id=$1`, [loaded.iv.job_id]);
      const title = job.rows[0]?.title || 'your application';
      await c.query(
        `select notify_create($1,$2,'candidate','AI_INTERVIEW_COMPLETED',$3,$4,$5,$6,$7,null,$8)`,
        [newId('ntf'), req.session.profileId, 'AI Interview Completed',
         `Your AI interview for ${title} has been completed and submitted for review.`,
         loaded.iv.job_id, loaded.iv.application_id, req.session.profileId,
         JSON.stringify({ aiInterviewId: loaded.iv.id })]);
      await c.query(
        `select notify_create($1,$2,'candidate','AI_SCORE_AVAILABLE',$3,$4,$5,$6,$7,null,$8)`,
        [newId('ntf'), req.session.profileId, 'AI Interview Result',
         `Your AI interview for ${title} scored ${graded.overall}% overall.`,
         loaded.iv.job_id, loaded.iv.application_id, req.session.profileId,
         JSON.stringify({ aiInterviewId: loaded.iv.id, overall: graded.overall })]);

      const row = (await c.query(`select * from ai_interviews where id=$1`, [loaded.iv.id])).rows[0];
      return row;
    });

    /* ------------------------------------------------------------------ *
     * And the RECRUITER hears about it.
     *
     * Everything above tells the candidate. Until now that was the whole
     * of it: the application stayed at "Interview Scheduled" the morning
     * after the interview happened, the score lived only inside
     * ai_interviews where no pipeline screen reads it, and the only way
     * for a recruiter to find out was to open each candidate and look.
     *
     * Through a definer function, because the person who just finished
     * the interview is the CANDIDATE, and a candidate must not be able to
     * write their own stage or their recruiter's notifications.
     * ------------------------------------------------------------------ */
    let recorded = null;
    if (saved.application_id) {
      try {
        recorded = await withUser(req.session, async (c) => (await c.query(
          `select ai_interview_recorded($1,$2) as out`,
          [saved.application_id, saved.overall_percentage])).rows[0].out);
      } catch (err) {
        // The interview itself is saved and scored either way; failing
        // to announce it must not lose it.
        console.error('[interview] the result could not be recorded:', err.message);
      }
    }

    // Two events, because they answer different questions for the
    // candidate: "did my interview go through" and "what did I get". The
    // interview finishing was previously silent on every channel including
    // the portal, so a candidate who completed one heard nothing at all.
    const completed = await dispatchEvent(req.session, 'AI_INTERVIEW_COMPLETED', {
      applicationId: saved.application_id,
      questionsAsked: saved.questions_asked,
      questionsAnswered: saved.questions_answered,
    });
    const scored = await dispatchEvent(req.session, 'AI_SCORE_AVAILABLE', {
      applicationId: saved.application_id,
      overall: Math.round(Number(saved.overall_percentage || 0)),
      technical: Math.round(Number(saved.technical_score || 0)),
      communication: Math.round(Number(saved.communication_score || 0)),
    });

    res.json({
      aiInterview: toAi(saved),
      engine: graded.engine,
      perQuestion: graded.perQuestion,
      // What the recruiter's side of this now says, so the caller can
      // report it rather than assume it happened.
      recruiter: recorded,
      notify: { completed, scored },
    });
  }));

  r.post('/ai-interviews', requireAuth(), wrap(async (req, res) => {
    const b = parse(recordSchema, req.body);

    /* A CANDIDATE NEVER WRITES A SCORE.
       This route takes per-question scores from the caller, which is
       right for a recruiter keying in an interview held elsewhere and
       wrong for the person being scored: the browser's own arithmetic
       used to come through here when the server session could not be
       planned. The candidate's interview is graded by /finish, from the
       transcripts the server holds. */
    if (req.session.role === 'candidate') {
      throw forbidden(req.session.profileId !== b.candidateId
        ? 'You can only submit your own interview.'
        : 'Interview scores are calculated by TeamLink, not submitted by the candidate.');
    }
    if (!['recruiter', 'admin'].includes(req.session.role)) {
      throw forbidden('Only a recruiter can record an interview result.');
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

  /* ================================================================== *
   * Interview integrity — the two-strike rule
   *
   * The browser watches; the SERVER counts. A strike counter that lives
   * in the page is a strike counter a reload clears, so the browser's
   * only job is to say "I am confident I saw a second person", and this
   * decides whether that is a warning or the end of the session.
   *
   * WHAT THE BROWSER IS TRUSTED FOR. That it saw something, and how
   * confident it was. It is not trusted for the count, the status, the
   * message shown, or whether the interview may continue - all four come
   * back from the database, in one locked statement.
   * ================================================================== */

  /**
   * POST /api/ai-interviews/:id/integrity
   *
   * One CONFIRMED detection. The page is expected to have applied its
   * own confidence threshold and confirmation window before calling
   * this (§5); a detector that fires on every uncertain frame produces
   * warnings that mean nothing, and the brief is explicit that reliable
   * detection matters more than aggressive warning.
   */
  r.post('/ai-interviews/:id/integrity', requireAuth(), wrap(async (req, res) => {
    const b = parse(z.object({
      type: z.enum(['additional_person', 'additional_voice', 'left_interview', 'background_noise', 'camera_off']),
      confidence: z.number().min(0).max(1),
      evidence: z.record(z.any()).optional(),
    }), req.body);

    /* WHOSE INTERVIEW IS IT. Loaded under the caller's own rights, with
       the candidate id checked explicitly, because the function below is
       `security definer` and cannot answer that question itself. */
    const iv = await withUser(req.session, async (c) => (await c.query(
      `select id, status, integrity_status, integrity_strikes
         from ai_interviews where id=$1 and candidate_id=$2`,
      [req.params.id, req.session.profileId])).rows[0]);
    if (!iv) throw notFound('That interview could not be found.');

    /* Evidence, minus anything that could carry a picture of a room or a
       recording of a voice into a jsonb column. What is kept is what a
       recruiter can act on: which detector, how many faces, how long it
       persisted, how many samples agreed. */
    const ev = b.evidence || {};
    const evidence = {
      detector: String(ev.detector || 'browser').slice(0, 60),
      faces: Number.isFinite(Number(ev.faces)) ? Number(ev.faces) : undefined,
      sustainedMs: Number.isFinite(Number(ev.sustainedMs)) ? Number(ev.sustainedMs) : undefined,
      samples: Number.isFinite(Number(ev.samples)) ? Number(ev.samples) : undefined,
      agreeing: Number.isFinite(Number(ev.agreeing)) ? Number(ev.agreeing) : undefined,
      pitchHz: Number.isFinite(Number(ev.pitchHz)) ? Math.round(Number(ev.pitchHz)) : undefined,
      baselineHz: Number.isFinite(Number(ev.baselineHz)) ? Math.round(Number(ev.baselineHz)) : undefined,
      questionSeq: Number.isInteger(Number(ev.questionSeq)) && Number(ev.questionSeq) > 0 && Number(ev.questionSeq) < 100
        ? Number(ev.questionSeq) : undefined,
      note: ev.note ? String(ev.note).slice(0, 300) : undefined,
    };

    const policy = retakePolicy();
    const out = await withUser(ENGINE_SESSION, async (c) => (await c.query(
      `select * from interview_integrity_report($1,$2,$3,$4::jsonb,$5,$6,$7)`,
      [iv.id, b.type, b.confidence, JSON.stringify(evidence),
       policy.delayMinutes, policy.maxAttempts, policy.deadlineHours])).rows[0]);

    /* The email goes only AFTER the suspension is saved, once (the claim
       is the database's), and never holds up or undoes this answer. */
    if (out.action === 'suspend') afterSuspension(iv.id);

    res.json({
      strike: Number(out.strike_no),
      of: 2,
      action: out.action,                 // 'warn' | 'suspend' | 'suspended' | 'ignored'
      message: out.message,
      interviewStatus: out.interview_status,
      integrityStatus: out.integrity_status,
      retakeAvailableAt: out.retake_at ? new Date(out.retake_at).toISOString() : null,
      mayContinue: out.action === 'warn',
    });
  }));

  /**
   * GET /api/ai-interviews/integrity
   *
   * Every interview with something to look at, for the recruiter's
   * Interview Integrity list. RLS narrows it to their own desk.
   *
   * Declared BEFORE `/ai-interviews/:id/integrity` because Express
   * matches in order and `integrity` would otherwise be read as an id.
   */
  /**
   * POST /api/ai-interviews/:id/stop
   *
   * The page's OWN detections - the tab left, the camera gone, continuous
   * background noise. They used to end the interview on screen and tell the
   * server nothing. They now report here and go through the same
   * two-strike rule as a second person / voice: the FIRST warns and the
   * interview continues, the second suspends - through the one shared
   * suspend function, with a reason, a question number, an email and a
   * retake time. A failed or missing report never suspends anything.
   *
   * The browser names what it saw; the server turns that into a code and
   * the one sentence everybody reads. Only the candidate whose interview
   * it is can do this, and only to a running one.
   */
  r.post('/ai-interviews/:id/stop', requireAuth(), wrap(async (req, res) => {
    const b = parse(z.object({
      kind: z.enum(['left_interview', 'background_noise', 'camera_lost', 'camera_off']),
      questionSeq: z.number().int().min(1).max(99).optional(),
      note: z.string().max(200).optional(),
    }), req.body);
    if (req.session.role !== 'candidate') throw forbidden('Only the candidate sitting an interview can stop it.');

    const iv = await withUser(req.session, async (c) => (await c.query(
      `select id, status, questions_answered from ai_interviews where id=$1 and candidate_id=$2`,
      [req.params.id, req.session.profileId])).rows[0]);
    if (!iv) throw notFound('That interview could not be found.');

    const code = PAGE_STOPS[b.kind];
    const q = b.questionSeq || (Number(iv.questions_answered || 0) + 1);
    const policy = retakePolicy();
    /* The same two-strike rule as a second person / a second voice: the first
       occurrence WARNS and the interview carries on; a second one suspends. */
    const out = await withUser(ENGINE_SESSION, async (c) => (await c.query(
      `select * from interview_integrity_report($1,$2,$3,$4::jsonb,$5,$6,$7)`,
      [iv.id, code, 1, JSON.stringify({ detector: 'browser', questionSeq: q, note: b.note || undefined }),
       policy.delayMinutes, policy.maxAttempts, policy.deadlineHours])).rows[0]);
    if (out.action === 'suspend') afterSuspension(iv.id);
    res.json({
      action: out.action,                  // 'warn' | 'suspend' | 'suspended' | 'ignored'
      strike: Number(out.strike_no), of: 2,
      suspended: out.action === 'suspend' || out.action === 'suspended',
      firstTime: out.action === 'suspend',
      mayContinue: out.action === 'warn',
      message: out.message,
      interviewStatus: out.interview_status,
      retakeAvailableAt: out.retake_at ? new Date(out.retake_at).toISOString() : null,
    });
  }));

  /**
   * GET /api/ai-interviews/:id/suspension
   *
   * What the candidate's screen shows after a suspension: the one stored
   * sentence and when the retake opens. Their own interview only.
   */
  r.get('/ai-interviews/:id/suspension', requireAuth(), wrap(async (req, res) => {
    if (req.session.role !== 'candidate') throw forbidden('Only the candidate sitting an interview can read this.');
    const row = await withUser(req.session, async (c) => (await c.query(
      `select status, suspension_message, retake_available_at, retake_blocked, attempt_number
         from ai_interviews where id=$1 and candidate_id=$2`, [req.params.id, req.session.profileId])).rows[0]);
    if (!row) throw notFound('That interview could not be found.');
    res.json({
      suspended: row.status === 'suspended',
      message: row.suspension_message || null,
      retakeAvailableAt: row.retake_available_at && !row.retake_blocked ? new Date(row.retake_available_at).toISOString() : null,
      attemptNumber: row.attempt_number,
    });
  }));

  /**
   * POST /api/ai-interviews/:id/retake
   *
   * The recruiter's control over the retake: block it, lift the block, or
   * grant one more attempt. Recruiter or admin only, only on an interview
   * their row-level access reaches, with a reason, and written to the
   * interview's audit trail (who, when, why). A block overrides the
   * automatic retake even after the wait.
   */
  r.post('/ai-interviews/:id/retake', requireAuth(), requireRole('recruiter', 'admin'), wrap(async (req, res) => {
    const b = parse(z.object({
      action: z.enum(['block', 'unblock', 'extra_attempt']),
      reason: z.string().trim().min(3, 'Please give a reason.').max(1000),
    }), req.body);
    const seen = await withUser(req.session, async (c) => (await c.query(
      `select id from ai_interviews where id=$1`, [req.params.id])).rows[0]);
    if (!seen) throw notFound('That interview could not be found.');
    const iv = await withUser(ENGINE_SESSION, async (c) => (await c.query(
      `select * from interview_retake_control($1,$2,$3,$4)`,
      [req.params.id, b.action, b.reason, req.session.userId || null])).rows[0]);
    res.json({
      interview: {
        id: iv.id, status: iv.status, attemptNumber: iv.attempt_number, retakeBlocked: iv.retake_blocked,
        retakeAvailableAt: iv.retake_available_at ? new Date(iv.retake_available_at).toISOString() : null,
      },
    });
  }));

  r.get('/ai-interviews/integrity', requireAuth(),
    requireRole('recruiter', 'bde', 'admin'), wrap(async (req, res) => {
      const rows = await withUser(req.session, async (c) => (await c.query(
        `select i.id, i.candidate_id, i.application_id, i.job_id, i.status,
                i.integrity_status, i.integrity_strikes, i.suspended_at,
                i.suspend_reason, i.reopened_at,
                i.suspension_code, i.suspension_message, i.suspension_question_no, i.detection_count,
                i.last_detection_at, i.attempt_number, i.retake_available_at, i.retake_blocked,
                i.completed_at, i.overall_percentage,
                (select count(*) from ai_interview_answers q where q.ai_interview_id = i.id and q.needs_review) as review_answers,
                c.name as candidate_name, j.title as job_title,
                (select count(*) from ai_interview_flags f
                  where f.interview_id = i.id and f.review_status = 'open'
                    and f.strike_no is not null) as open_flags
           from ai_interviews i
           join candidates c on c.id = i.candidate_id
           left join jobs j on j.id = i.job_id
          where i.integrity_strikes > 0 or i.status = 'suspended' or i.suspension_code is not null or i.status = 'completed'
          order by coalesce(i.completed_at, i.suspended_at, i.started_at, i.created_at) desc
          limit 100`)).rows);

      res.json({
        interviews: rows.map((x) => ({
          id: x.id,
          candidateId: x.candidate_id,
          candidateName: x.candidate_name,
          applicationId: x.application_id,
          jobId: x.job_id,
          jobTitle: x.job_title || '',
          status: x.status,
          integrityStatus: x.integrity_status,
          strikes: Number(x.integrity_strikes || 0),
          suspendedAt: x.suspended_at,
          suspendReason: x.suspend_reason,
          suspensionCode: x.suspension_code,
          suspensionMessage: x.suspension_message,
          suspensionQuestionNo: x.suspension_question_no,
          detectionCount: Number(x.detection_count || 0),
          lastDetectionAt: x.last_detection_at,
          attemptNumber: x.attempt_number,
          retakeAvailableAt: x.retake_available_at,
          retakeBlocked: !!x.retake_blocked,
          /* a suspended interview is under review, never rejected */
          display: x.status === 'suspended' ? 'Under Recruiter Review' : null,
          reopenedAt: x.reopened_at,
          openFlags: Number(x.open_flags || 0),
          completedAt: x.completed_at,
          overallPercentage: x.overall_percentage == null ? null : Number(x.overall_percentage),
          answersToReview: Number(x.review_answers || 0),
        })),
      });
    }));

  /**
   * GET /api/ai-interviews/:id/integrity
   *
   * The recruiter's Interview Integrity section (§7), and the candidate's
   * own read of what they were shown. RLS decides which of the two this
   * is; a candidate gets the same flags without the recruiter's notes.
   */
  r.get('/ai-interviews/:id/integrity', requireAuth(), wrap(async (req, res) => {
    const staff = ['recruiter', 'bde', 'admin'].includes(req.session.role);

    const out = await withUser(req.session, async (c) => {
      const iv = (await c.query(
        `select id, status, integrity_status, integrity_strikes, suspended_at,
                suspend_reason, reopened_at, reopen_reason, candidate_id,
                application_id, job_id,
                suspension_code, suspension_message, suspension_question_no, detection_count,
                last_detection_at, attempt_number, retake_available_at, retake_blocked,
                retake_block_reason, suspension_email_sent_at,
                (retake_available_at is not null and now() >= retake_available_at) as retake_open
           from ai_interviews where id=$1`, [req.params.id])).rows[0];
      if (!iv) return null;
      const answers = (await c.query(
        `select a.seq, a.question, a.answered, a.answer_summary, a.score, a.max_score, a.comm_score, a.justification,
                a.relevance_class, a.needs_review, a.review_reason, a.transcription_confidence,
                coalesce((select bool_or(p.auto_submitted) from ai_interview_answer_parts p
                           where p.interview_id = a.ai_interview_id and p.seq = a.seq and p.part = 'main'), false) as auto_submitted
           from ai_interview_answers a where a.ai_interview_id = $1 order by a.seq`, [iv.id])).rows;
      const attempts = iv.application_id ? (await c.query(
        `select id, attempt_number, status, started_at, suspended_at, suspension_code, suspension_message,
                suspension_question_no, completed_at, overall_percentage
           from ai_interviews where application_id=$1 order by attempt_number`, [iv.application_id])).rows : [];
      const flags = (await c.query(
        `select id, flag_type, description, severity, strike_no, confidence,
                confidence_band, detector, warning_message, status_after,
                review_status, recruiter_notes, reviewed_at, occurred_at, evidence
           from ai_interview_flags
          where interview_id=$1 and strike_no is not null
          order by strike_no, occurred_at`, [req.params.id])).rows;
      return { iv, flags, attempts, answers };
    });
    if (!out) throw notFound('That interview could not be found.');

    /* Reading an integrity record is itself an event worth having on
       file - §35 of the interview brief asks for it, and a privacy
       review asks who looked. */
    if (staff) {
      await withUser(ENGINE_SESSION, (c) => c.query(
        `insert into ai_interview_audit (interview_id, candidate_id, action, detail, actor_id, actor_role)
         values ($1,$2,'integrity.viewed','{}'::jsonb,$3,$4)`,
        [out.iv.id, out.iv.candidate_id, req.session.userId || null, req.session.role]))
        .catch(() => { /* a failed audit write must not hide the record */ });
    }

    res.json({
      interviewId: out.iv.id,
      status: out.iv.status,
      integrityStatus: out.iv.integrity_status,
      strikes: Number(out.iv.integrity_strikes || 0),
      suspendedAt: out.iv.suspended_at,
      suspendReason: out.iv.suspend_reason,
      reopenedAt: out.iv.reopened_at,
      reopenReason: out.iv.reopen_reason,
      suspensionCode: out.iv.suspension_code,
      suspensionMessage: out.iv.suspension_message,
      suspensionQuestionNo: out.iv.suspension_question_no,
      detectionCount: Number(out.iv.detection_count || 0),
      lastDetectionAt: out.iv.last_detection_at,
      attemptNumber: out.iv.attempt_number,
      retakeAvailableAt: out.iv.retake_available_at,
      retakeOpen: !!out.iv.retake_open && !out.iv.retake_blocked,
      retakeBlocked: !!out.iv.retake_blocked,
      ...(staff ? { retakeBlockReason: out.iv.retake_block_reason, suspensionEmailSentAt: out.iv.suspension_email_sent_at } : {}),
      /* a suspended interview is under review - never "rejected" or "failed" */
      display: out.iv.status === 'suspended' ? 'Under Recruiter Review' : null,
      /* Every attempt, kept: a retake never overwrites the one before it. The recruiter
         sees ONE current score - the latest COMPLETED attempt's. A suspended attempt has none. */
      ...(staff ? {
        attempts: out.attempts.map((a) => ({
          id: a.id, attemptNumber: a.attempt_number, status: a.status, startedAt: a.started_at,
          suspendedAt: a.suspended_at, suspensionMessage: a.suspension_message,
          suspensionQuestionNo: a.suspension_question_no,
          score: (a.status === 'completed' || a.status === 'evaluated') && a.overall_percentage != null ? Number(a.overall_percentage) : null,
        })),
        currentScore: (() => {
          const done = out.attempts.filter((a) => (a.status === 'completed' || a.status === 'evaluated') && a.overall_percentage != null);
          return done.length ? Number(done[done.length - 1].overall_percentage) : null;
        })(),
      } : {}),
      /* Per question, for the hiring side only: what was asked, what was said, how
         relevant it was and why it scored what it did. No prompts, models or raw numbers. */
      ...(staff ? {
        questions: out.answers.map((a) => ({
          seq: a.seq, question: a.question, transcript: a.answer_summary || '',
          answered: !!a.answered, timedOut: !!a.auto_submitted,
          relevanceClass: a.relevance_class || null,
          score: out.iv.status === 'completed' || out.iv.status === 'evaluated' ? Number(a.score) : null,
          maxScore: a.max_score == null ? 100 : Number(a.max_score),
          communication: a.comm_score == null ? null : Number(a.comm_score),
          reason: a.justification && !String(a.justification).startsWith('{') ? a.justification : null,
          needsReview: !!a.needs_review, reviewReason: a.review_reason || null,
          lowTranscriptConfidence: a.transcription_confidence != null && Number(a.transcription_confidence) < 0.6,
        })),
      } : {}),
      violations: out.flags.map((f) => ({
        id: Number(f.id),
        no: f.strike_no,
        type: ({ additional_person: 'Additional Person', additional_voice: 'Additional Voice',
                 left_interview: 'Left the interview window', background_noise: 'Continuous background noise',
                 camera_off: 'Camera off' })[f.flag_type] || 'Integrity flag',
        at: f.occurred_at,
        /* The word, and the number behind it. A recruiter reads "High";
           an argument about whether the threshold is right needs 0.91. */
        confidence: f.confidence_band || 'low',
        confidenceValue: f.confidence == null ? null : Number(f.confidence),
        outcome: f.status_after === 'suspended' ? 'Interview Suspended' : 'Warning',
        warningShown: f.warning_message,
        detector: f.detector,
        evidence: staff ? f.evidence : undefined,
        reviewStatus: f.review_status,
        recruiterNotes: staff ? f.recruiter_notes : undefined,
        reviewedAt: f.reviewed_at,
      })),
    });
  }));

  /**
   * POST /api/ai-interviews/:id/integrity/:flagId/review
   *
   * A recruiter's note and verdict on one violation. The flag itself -
   * what was detected, when, how confident - is never editable; this
   * writes only what a person concluded about it.
   */
  r.post('/ai-interviews/:id/integrity/:flagId/review', requireAuth(),
    requireRole('recruiter', 'bde', 'admin'), wrap(async (req, res) => {
      const b = parse(z.object({
        reviewStatus: z.enum(['open', 'reviewed', 'dismissed', 'upheld']).optional(),
        notes: z.string().max(4000).optional(),
      }), req.body);

      const row = await withUser(req.session, async (c) => (await c.query(
        `update ai_interview_flags
            set review_status  = coalesce($3, review_status),
                recruiter_notes = coalesce($4, recruiter_notes),
                reviewed_by = $5, reviewed_at = now()
          where id = $1 and interview_id = $2
          returning id, review_status, recruiter_notes, reviewed_at`,
        [Number(req.params.flagId), req.params.id,
         b.reviewStatus || null, b.notes === undefined ? null : b.notes,
         req.session.userId || null])).rows[0]);
      if (!row) throw notFound('That violation could not be found.');

      await withUser(ENGINE_SESSION, (c) => c.query(
        `insert into ai_interview_audit (interview_id, action, detail, actor_id, actor_role)
         values ($1,'integrity.reviewed',$2::jsonb,$3,$4)`,
        [req.params.id,
         JSON.stringify({ flagId: Number(req.params.flagId), reviewStatus: b.reviewStatus }),
         req.session.userId || null, req.session.role])).catch(() => {});

      res.json({
        violation: {
          id: Number(row.id), reviewStatus: row.review_status,
          recruiterNotes: row.recruiter_notes, reviewedAt: row.reviewed_at,
        },
      });
    }));

  /**
   * POST /api/ai-interviews/:id/reopen
   *
   * §2 and §7: a suspended interview stays suspended until an authorised
   * person says otherwise. Reopening issues a NEW session id, so the link
   * the candidate already has cannot be used to walk back into the
   * session that was stopped.
   */
  r.post('/ai-interviews/:id/reopen', requireAuth(),
    requireRole('recruiter', 'admin'), wrap(async (req, res) => {
      const b = parse(z.object({
        reason: z.string().trim().min(1).max(1000),
        rescheduleAt: z.string().trim().max(40).optional(),
      }), req.body);

      /* Under the recruiter's own rights first: RLS decides whether this
         interview is theirs to reopen. */
      const seen = await withUser(req.session, async (c) => (await c.query(
        `select id, status from ai_interviews where id=$1`, [req.params.id])).rows[0]);
      if (!seen) throw notFound('That interview could not be found.');

      const when = b.rescheduleAt ? new Date(b.rescheduleAt) : null;
      if (when && Number.isNaN(when.getTime())) {
        throw badRequest('Please check the highlighted fields and try again.',
          { rescheduleAt: 'That is not a valid date and time.' });
      }

      const iv = await withUser(ENGINE_SESSION, async (c) => (await c.query(
        `select * from interview_integrity_reopen($1,$2,$3,$4)`,
        [req.params.id, b.reason, req.session.userId || null, when])).rows[0]);

      res.json({
        interview: {
          id: iv.id, status: iv.status, integrityStatus: iv.integrity_status,
          scheduledAt: iv.scheduled_at, reopenedAt: iv.reopened_at,
        },
        note: when
          ? 'The interview was rescheduled and a new link was issued.'
          : 'The interview was reopened and a new link was issued.',
      });
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
