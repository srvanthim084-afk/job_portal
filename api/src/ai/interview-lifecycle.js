/**
 * An AI interview before anybody takes it.
 *
 * The existing engine (ai/interview.js) plans questions and scores
 * answers; the existing route records a session that has already
 * happened. Neither of them knows about an interview that has been
 * CREATED and not yet taken - scheduled for Thursday, invitation sent,
 * link not opened, expiring on Friday. That is what this file adds.
 *
 * Everything here goes through the `security definer` functions in
 * migration 0056, so a candidate can never reach a score, an evaluation,
 * a flag or a recruiter's note - and every state change writes a line to
 * the audit log without the caller having to remember to.
 */
import { randomBytes } from 'node:crypto';
import { withUser } from '../db.js';
import { badRequest, forbidden, notFound } from '../errors.js';

/** The id convention already used across this codebase. */
export function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * A session token for one interview, used once.
 *
 * 32 random bytes rather than anything derived from the candidate or the
 * interview: a link that can be guessed from an id somebody already has
 * is not a secure link. It is issued once - ai_interview_schedule keeps
 * the first value with coalesce - so a reschedule does not hand out a
 * second way in while the first is still live.
 */
export function newSessionId() {
  return randomBytes(32).toString('base64url');
}

/** How long an invitation is good for, unless the recruiter says otherwise. */
export const DEFAULT_EXPIRY_DAYS = 7;

export function defaultExpiry(from = new Date()) {
  const d = new Date(from);
  d.setDate(d.getDate() + DEFAULT_EXPIRY_DAYS);
  return d;
}

/* ------------------------------------------------------------------ *
 * the job as it was
 * ------------------------------------------------------------------ */

/**
 * Freeze what the questions were generated from.
 *
 * A report has to stay reproducible: if the job description is rewritten
 * next month, a completed interview must still show the skills it was
 * actually built against. Taken once, when the interview is created, and
 * never written again.
 */
export function jdSnapshot(job, config) {
  if (!job) return null;
  return {
    takenAt: new Date().toISOString(),
    job: {
      id: job.id,
      title: job.title,
      department: job.department || null,
      location: job.location || null,
      employmentType: job.employment_type || job.type || null,
      experience: job.exp_label || job.exp || null,
      education: job.education || null,
      skills: job.skills || [],
      description: job.description || job.desc || null,
      responsibilities: job.responsibilities || [],
      requirements: job.requirements || [],
    },
    config: {
      interviewType: config.interviewType,
      durationMinutes: config.durationMinutes,
      questionCount: config.questionCount,
      difficulty: config.difficulty,
      language: 'en',
    },
  };
}

/* ------------------------------------------------------------------ *
 * reads
 * ------------------------------------------------------------------ */

export async function getInterview(session, id) {
  return withUser(session, async (c) => {
    const { rows } = await c.query(
      `select i.*, cand.name as candidate_name, cand.email as candidate_email,
              j.title as job_title
         from ai_interviews i
         join candidates cand on cand.id = i.candidate_id
         join jobs j         on j.id    = i.job_id
        where i.id = $1`, [id]);
    return rows[0] || null;
  });
}

/**
 * The whole record: questions, answers, the latest evaluation, flags.
 *
 * `forCandidate` drops the parts that are the recruiter's: flags are a
 * note to review, not something to show the person they are about, and a
 * candidate who can read them learns how to avoid raising one.
 */
export async function getFullRecord(session, id, { forCandidate = false } = {}) {
  return withUser(session, async (c) => {
    const head = (await c.query(
      `select i.*, cand.name as candidate_name, j.title as job_title
         from ai_interviews i
         join candidates cand on cand.id = i.candidate_id
         join jobs j         on j.id    = i.job_id
        where i.id = $1`, [id])).rows[0];
    if (!head) return null;

    const questions = (await c.query(
      `select * from ai_interview_questions where interview_id=$1 order by question_number`,
      [id])).rows;
    const answers = (await c.query(
      `select * from ai_interview_answers where ai_interview_id=$1 order by seq`, [id])).rows;
    const evaluation = (await c.query(
      `select * from ai_interview_evaluations where interview_id=$1
        order by generated_at desc limit 1`, [id])).rows[0] || null;
    const flags = forCandidate ? [] : (await c.query(
      `select * from ai_interview_flags where interview_id=$1 order by occurred_at`, [id])).rows;
    const coding = (await c.query(
      `select * from ai_interview_coding where interview_id=$1 order by submitted_at`, [id])).rows;

    return { head, questions, answers, evaluation, flags, coding };
  });
}

/**
 * Open an interview by its session link.
 *
 * THE LINK IS CHECKED ON THE SERVER, not by the page that holds it. An
 * expired, cancelled or already-completed session is refused here with a
 * reason the candidate can act on, and the attempt is logged either way -
 * somebody trying an old link is exactly what an audit trail is for.
 */
export async function openSession(session, sessionId) {
  const row = await withUser(session, async (c) => {
    const { rows } = await c.query(
      `select i.*, j.title as job_title, cand.name as candidate_name
         from ai_interviews i
         join jobs j on j.id = i.job_id
         join candidates cand on cand.id = i.candidate_id
        where i.session_id = $1`, [sessionId]);
    return rows[0] || null;
  });

  if (!row) throw notFound('That interview link is not valid.');

  /* The link belongs to one candidate. */
  if (session.role === 'candidate' && session.profileId !== row.candidate_id) {
    throw forbidden('That interview link belongs to somebody else.');
  }

  const now = Date.now();
  const reason =
    row.status === 'cancelled' ? 'This interview was cancelled.'
    : row.status === 'completed' || row.status === 'evaluated'
      ? 'This interview has already been completed.'
    : row.expires_at && new Date(row.expires_at).getTime() < now
      ? 'This interview link has expired. Ask your recruiter to send a new one.'
      : null;

  await log(session, row.id, row.candidate_id,
    reason ? 'session_refused' : 'session_opened', { reason: reason || undefined });

  if (reason) throw badRequest(reason);
  return row;
}

/* ------------------------------------------------------------------ *
 * writes — every one of them through a definer function
 * ------------------------------------------------------------------ */

export async function log(session, interviewId, candidateId, action, detail = {}) {
  return withUser(session, async (c) => {
    await c.query(`select ai_interview_log($1,$2,$3,$4::jsonb,$5,$6)`,
      [interviewId, candidateId, action, JSON.stringify(detail),
       session?.userId || null, session?.role || null]);
  });
}

export async function schedule(session, id, { scheduledAt, expiresAt, status }) {
  return withUser(session, async (c) => {
    const { rows } = await c.query(
      `select (ai_interview_schedule($1,$2,$3,$4,$5,$6,$7)).*`,
      [id, scheduledAt || null, expiresAt || null, newSessionId(),
       status || null, session?.userId || null, session?.role || null]);
    return rows[0];
  });
}

export async function cancel(session, id, reason) {
  return withUser(session, async (c) => {
    const { rows } = await c.query(`select (ai_interview_cancel($1,$2,$3,$4)).*`,
      [id, reason || null, session?.userId || null, session?.role || null]);
    return rows[0];
  });
}

export async function saveQuestion(session, interviewId, q) {
  return withUser(session, async (c) => {
    const { rows } = await c.query(
      `select (ai_interview_question_save($1,$2,$3,$4,$5,$6)).*`,
      [interviewId, q.number, q.question, q.type || 'general',
       q.generatedFrom || null, q.difficulty || null]);
    return rows[0];
  });
}

export async function raiseFlag(session, interviewId, candidateId, flag) {
  return withUser(session, async (c) => {
    const { rows } = await c.query(
      `select (ai_interview_flag_raise($1,$2,$3,$4,$5::jsonb,$6)).*`,
      [interviewId, candidateId, flag.type, flag.description || null,
       JSON.stringify(flag.evidence || {}), flag.severity || 'info']);
    return rows[0];
  });
}

export async function saveEvaluation(session, interviewId, ev) {
  return withUser(session, async (c) => {
    const { rows } = await c.query(
      `select (ai_interview_evaluation_save($1,$2::jsonb,$3,$4,$5,$6::jsonb,$7::jsonb,
                                            $8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12)).*`,
      [interviewId, JSON.stringify(ev.scores || {}), ev.confidence || 'medium',
       ev.confidenceReason || null, ev.summary || null,
       JSON.stringify(ev.strengths || []), JSON.stringify(ev.areasToClarify || []),
       JSON.stringify(ev.skillsDemonstrated || []), JSON.stringify(ev.skillsNotShown || []),
       JSON.stringify(ev.inconsistencies || []), JSON.stringify(ev.recruiterFollowup || []),
       ev.engine || null]);
    return rows[0];
  });
}

/* ------------------------------------------------------------------ *
 * shapes
 * ------------------------------------------------------------------ */

const iso = (v) => (v ? new Date(v).toISOString() : null);
const num = (v) => (v == null ? null : Number(v));

/**
 * What the browser sees.
 *
 * THE SESSION TOKEN IS NOT IN HERE. It is handed to the recruiter once,
 * in the response to scheduling, as part of the invitation link - a
 * listing that carried it would put a working key to every live interview
 * into any screen that shows a table.
 */
export function toInterview(r, { withSession = false } = {}) {
  if (!r) return null;
  return {
    id: r.id,
    candidateId: r.candidate_id,
    candidateName: r.candidate_name || null,
    jobId: r.job_id,
    jobTitle: r.job_title || null,
    applicationId: r.application_id,
    recruiterId: r.recruiter_id || null,
    interviewType: r.interview_type,
    durationMinutes: r.duration_minutes,
    questionCount: r.question_count,
    difficulty: r.difficulty,
    language: r.language,
    status: r.status,
    mode: r.mode,
    fallbackUsed: r.fallback_used === true,
    scheduledAt: iso(r.scheduled_at),
    expiresAt: iso(r.expires_at),
    invitationSentAt: iso(r.invitation_sent_at),
    startedAt: iso(r.started_at),
    completedAt: iso(r.completed_at),
    cancelledAt: iso(r.cancelled_at),
    cancelReason: r.cancel_reason || null,
    overallPercentage: num(r.overall_percentage),
    confidence: r.confidence || null,
    confidenceReason: r.confidence_reason || null,
    contentScored: r.content_scored === true,
    questionsAsked: r.questions_asked,
    questionsAnswered: r.questions_answered,
    ...(withSession && r.session_id ? { sessionId: r.session_id } : {}),
  };
}

export function toEvaluation(r) {
  if (!r) return null;
  return {
    scores: {
      technical: num(r.technical_score),
      problemSolving: num(r.problem_solving_score),
      communication: num(r.communication_score),
      roleFit: num(r.role_fit_score),
      skillsCoverage: num(r.skills_coverage_score),
      resumeAlignment: num(r.resume_alignment_score),
      overall: num(r.overall_score),
    },
    confidence: r.confidence,
    confidenceReason: r.confidence_reason || null,
    summary: r.summary || null,
    strengths: r.strengths || [],
    areasToClarify: r.areas_to_clarify || [],
    skillsDemonstrated: r.skills_demonstrated || [],
    skillsNotShown: r.skills_not_shown || [],
    inconsistencies: r.inconsistencies || [],
    recruiterFollowup: r.recruiter_followup || [],
    engine: r.engine || null,
    generatedAt: iso(r.generated_at),
  };
}

export function toFlag(r) {
  if (!r) return null;
  return {
    id: Number(r.id),
    type: r.flag_type,
    description: r.description || null,
    evidence: r.evidence || {},
    severity: r.severity,
    reviewStatus: r.review_status,
    occurredAt: iso(r.occurred_at),
  };
}
