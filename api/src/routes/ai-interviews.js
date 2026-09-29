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
import { planInterview, followUp, evaluate, interviewEngine, BLUEPRINT_TOTAL }
  from '../ai/interview.js';
import { toJob, toCandidate } from '../shapes.js';
import { dispatchEvent } from '../notify/events.js';

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
       * A SUSPENDED INTERVIEW CANNOT BE WALKED AROUND BY STARTING A NEW ONE.
       *
       * Suspending the session and then letting the same candidate press
       * "Start interview" again would make the whole rule cosmetic. The
       * suspension stands until a recruiter reopens it, which issues a
       * fresh interview row and a fresh link (migration 0059).
       */
      const stopped = (await c.query(
        `select id from ai_interviews
          where application_id=$1 and candidate_id=$2 and status='suspended'
          order by suspended_at desc limit 1`,
        [app.id, req.session.profileId])).rows[0];
      if (stopped) {
        throw new ApiError(423, 'INTERVIEW_SUSPENDED',
          'Your interview for this role was suspended and the recruitment team is '
          + 'reviewing the session. You cannot start it again until a recruiter reopens it.');
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
      blueprint: { intro: 2, jd: 5, resume: 5, behavioral: 3, total: out.questions.length },
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
         loaded.rows.map((r) => `Q: ${r.question}\nA: ${r.answer_summary || '[no response]'}`).join('\n\n'),
         JSON.stringify(graded.perQuestion.map((p) => ({
           seq: p.seq, score: p.score,
           commScore: p.commScore == null ? '' : p.commScore,
           justification: p.justification || null,
           detail: p.detail || null,
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
      type: z.enum(['additional_person', 'additional_voice']),
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
      questionSeq: Number.isFinite(Number(ev.questionSeq)) ? Number(ev.questionSeq) : undefined,
      note: ev.note ? String(ev.note).slice(0, 300) : undefined,
    };

    const out = await withUser(ENGINE_SESSION, async (c) => (await c.query(
      `select * from interview_integrity_report($1,$2,$3,$4::jsonb)`,
      [iv.id, b.type, b.confidence, JSON.stringify(evidence)])).rows[0]);

    res.json({
      strike: Number(out.strike_no),
      of: 2,
      action: out.action,                 // 'warn' | 'suspend' | 'suspended'
      message: out.message,
      interviewStatus: out.interview_status,
      integrityStatus: out.integrity_status,
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
  r.get('/ai-interviews/integrity', requireAuth(),
    requireRole('recruiter', 'bde', 'admin'), wrap(async (req, res) => {
      const rows = await withUser(req.session, async (c) => (await c.query(
        `select i.id, i.candidate_id, i.application_id, i.job_id, i.status,
                i.integrity_status, i.integrity_strikes, i.suspended_at,
                i.suspend_reason, i.reopened_at,
                c.name as candidate_name, j.title as job_title,
                (select count(*) from ai_interview_flags f
                  where f.interview_id = i.id and f.review_status = 'open'
                    and f.strike_no is not null) as open_flags
           from ai_interviews i
           join candidates c on c.id = i.candidate_id
           left join jobs j on j.id = i.job_id
          where i.integrity_strikes > 0
          order by coalesce(i.suspended_at, i.started_at, i.created_at) desc
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
          reopenedAt: x.reopened_at,
          openFlags: Number(x.open_flags || 0),
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
                application_id, job_id
           from ai_interviews where id=$1`, [req.params.id])).rows[0];
      if (!iv) return null;
      const flags = (await c.query(
        `select id, flag_type, description, severity, strike_no, confidence,
                confidence_band, detector, warning_message, status_after,
                review_status, recruiter_notes, reviewed_at, occurred_at, evidence
           from ai_interview_flags
          where interview_id=$1 and strike_no is not null
          order by strike_no, occurred_at`, [req.params.id])).rows;
      return { iv, flags };
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
      violations: out.flags.map((f) => ({
        id: Number(f.id),
        no: f.strike_no,
        type: f.flag_type === 'additional_person' ? 'Additional Person' : 'Additional Voice',
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
