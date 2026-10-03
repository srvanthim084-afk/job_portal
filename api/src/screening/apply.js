/**
 * The two calls POST /api/applications makes for screening questions,
 * kept here so the route only gains a few lines.
 *
 *   applyScreeningAnswers(jobId, answers)
 *       before the transaction: reads the job's questions, validates every
 *       answer against its type and options, and works out the must-have
 *       result and the answer score. Throws a 400 with per-question
 *       details on a bad submission, so nothing is created.
 *       Returns null when there is nothing to store (no answers sent, or
 *       the job asks nothing) - the application then starts 'pending' or
 *       'not_required' by itself (trigger in 0097) and a pending one is
 *       sent the no-password link by the sweep.
 *
 *   storeApplyScreening(c, applicationId, prepared, ...)
 *       inside the application's own transaction.
 *
 * A failed must-have is stored as screening_status='knocked_out' and the
 * candidate is told nothing different: the response is the normal
 * "Application submitted".
 */
import { badRequest } from '../errors.js';
import { jobQuestionsInternal, prepareAnswers, storeAnswers } from './service.js';

export async function applyScreeningAnswers(jobId, answers) {
  if (answers === undefined) return null;
  const set = await jobQuestionsInternal(jobId);
  if (!set.questions.length) return null;
  try {
    return prepareAnswers(set, answers);
  } catch (err) {
    throw badRequest(err.message || 'Please answer the screening questions.', err.details);
  }
}

export async function storeApplyScreening(c, applicationId, prepared, session, candidateId, saveDefaults) {
  const asCandidate = session && session.role === 'candidate';
  await storeAnswers(c, applicationId, prepared, {
    source: asCandidate ? 'candidate' : 'recruiter_call',
    by: asCandidate ? null : 'Entered by recruiter',
    // Only the candidate can consent to their answers being reused.
    saveDefaults: asCandidate && saveDefaults === true,
    candidateId,
  });
}
