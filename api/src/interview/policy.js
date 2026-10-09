/**
 * Interview suspension and retake: the numbers and the words, in one place.
 *
 * Nothing here is a hard-coded policy a deployment cannot change:
 *
 *   INTERVIEW_RETAKE_DELAY_MINUTES   how long after a suspension the retake opens   (default 120)
 *   INTERVIEW_MAX_ATTEMPTS           attempts per application, retake included       (default 2)
 *   AI_INTERVIEW_DEADLINE_HOURS      how long an attempt may take once open          (default 48)
 *   INTERVIEW_QUESTION_TIME_SECONDS  time per question; never below 120, clamped up   (default 120)
 *   TEAMLINK_TIMEZONE                the timezone times are SHOWN in; the database
 *                                    and every comparison stay in UTC                (default Asia/Kolkata)
 *   SUPPORT_EMAIL                    the address the suspension email points to      (default EMAIL_FROM)
 *
 * The reason codes are the ones the database accepts (migration 0120) and
 * every one of them is a deliberate, named condition. The MESSAGE for a
 * code is written once, here or in the database function that suspends, and
 * is the same sentence on the candidate's screen, in the recruiter's page
 * and in the email.
 */
import { config } from '../config.js';

const num = (v, dflt, min = 0) => {
  if (v === undefined || v === null || String(v).trim() === '') return dflt;
  const n = Number(v);
  return Number.isFinite(n) && n >= min ? n : dflt;
};

export function retakePolicy() {
  return {
    delayMinutes: num(process.env.INTERVIEW_RETAKE_DELAY_MINUTES, 120, 0),
    maxAttempts: Math.max(1, Math.floor(num(process.env.INTERVIEW_MAX_ATTEMPTS, 2, 1))),
    deadlineHours: Math.max(1, num(process.env.AI_INTERVIEW_DEADLINE_HOURS, 48, 1)),
  };
}

/** Every question gets at least two minutes, whatever is configured. */
export const MIN_QUESTION_SECONDS = 120;
export function questionSeconds() {
  return Math.max(MIN_QUESTION_SECONDS, Math.round(num(process.env.INTERVIEW_QUESTION_TIME_SECONDS, MIN_QUESTION_SECONDS, 0)));
}

export const SUSPENSION_CODES = Object.freeze([
  'additional_person', 'additional_voice', 'camera_off', 'left_interview', 'background_noise', 'repeated_violations',
]);

/**
 * What the PAGE may report as a stop (the two-strike person/voice rule is
 * reported through the integrity route, not through here). The browser
 * names the condition it saw; the server turns it into a code and the one
 * sentence everybody reads.
 */
export const PAGE_STOPS = Object.freeze({
  left_interview: 'left_interview',
  background_noise: 'background_noise',
  camera_lost: 'camera_off',
  camera_off: 'camera_off',
});

export function stopMessage(code, questionNo) {
  const q = Number.isInteger(questionNo) && questionNo > 0 ? ` Question ${questionNo}` : '';
  switch (code) {
    case 'left_interview':
      return q ? `The interview window was not in front during your answer to${q}.`
               : 'The interview window was not in front during the interview.';
    case 'background_noise':
      return q ? `Continuous background noise was detected during${q}.`
               : 'Continuous background noise was detected during the interview.';
    case 'camera_off':
      return q ? `Your camera was off for too long during${q}.`
               : 'Your camera was off for too long during the interview.';
    case 'additional_person':
      return q ? `Another person was detected during your answer to${q}.` : 'Another person was detected during the interview.';
    case 'additional_voice':
      return q ? `Another voice was detected during your answer to${q}.` : 'Another voice was detected during the interview.';
    default:
      return 'The interview was suspended after repeated violations of the interview rules.';
  }
}

/** The timezone times are shown in. Never used for a comparison. */
export function displayZone() {
  const tz = String(process.env.TEAMLINK_TIMEZONE || 'Asia/Kolkata').trim();
  try { new Intl.DateTimeFormat('en-IN', { timeZone: tz }); return tz; } catch { return 'Asia/Kolkata'; }
}

/** "10 Oct 2026, 2:30 pm IST" - for people. */
export function formatWhen(d) {
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: displayZone(), day: 'numeric', month: 'short', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short',
  }).format(date);
}

export function supportEmail() {
  return String(process.env.SUPPORT_EMAIL || config.emailFrom || '').trim();
}
