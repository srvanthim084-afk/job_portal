/**
 * The conversation.
 *
 * This is deliberately NOT a script with five numbered questions. It is a
 * state machine whose next move is a function of
 *
 *     current state + what the candidate just said + what the job needs
 *     + what we ALREADY KNOW about this person + the ATS status
 *
 * The last two matter most, and are what separates this from an IVR.
 * Candidate data already exists - name, company, designation, experience,
 * education, skills, location, notice period, CTC, often from Naukri or
 * from our own portal. Asking "what is your name" of somebody whose
 * resume we are looking at is the single fastest way to be hung up on. So
 * `plan()` works out what is genuinely MISSING or STALE and asks only
 * that, and everything else is either confirmed in one line or not
 * mentioned at all.
 *
 * Interruptions are handled by the same mechanism: whatever arrives is
 * classified, and an urgent intent (busy, angry, recruiter, do-not-call)
 * short-circuits the state machine at any point, from any state. That is
 * why there is no "step 3 of 7" - there is no step 3.
 *
 * The engine is pure: it takes a state and a transcript and returns the
 * next thing to say plus the changes to record. It performs no I/O, which
 * is what makes every branch testable without a telephone.
 */
import { detectLanguage, languageRequest } from './language.js';
import {
  detectIntent, objectionReason, parseMoney, parseNotice, parseYesNo,
} from './intent.js';
import { LINES, say } from './script.js';
import { normaliseAnswer, noticeDays } from '../../screening/questions.js';

export const STATES = [
  'call_init', 'identity_confirmation', 'language_detection', 'consent_to_speak',
  'opportunity_intro', 'interest_check', 'requirement_screening',
  'compensation_check', 'availability_check', 'location_check',
  'interview_interest', 'candidate_questions', 'final_confirmation',
  'call_closing', 'post_call',
];

/** Stage labels the agent may honestly use about somebody's status. */
const STAGE_WORDS = {
  applied: 'applied', ai_screening: 'under screening', shortlisted: 'shortlisted',
  interview_scheduled: 'interviewing', ai_interview_done: 'interviewing',
  client_review: 'with the client', offer_extended: 'at offer stage',
  selected: 'selected', joined: 'joined',
};

/* ------------------------------------------------------------------ *
 * 1. the plan: what this call is for, and what it must not ask
 * ------------------------------------------------------------------ */

/**
 * Work out the objective and the question list BEFORE dialling.
 *
 * @param {object} candidate  the existing candidate record
 * @param {object} job        the existing job record
 * @param {object} application the existing application, if any
 * @param {object} [opts]     { objective, recruiterNotes }
 */
export function plan({ candidate, job, application, opts = {} }) {
  const known = [];
  const needed = [];
  const c = candidate || {};
  const j = job || {};

  const have = (v) => v !== undefined && v !== null && String(v).trim() !== '' &&
                      !(Array.isArray(v) && v.length === 0);

  // ---- what we already know. Stated, never asked. -------------------
  if (have(c.name)) known.push(`name: ${c.name}`);
  if (have(c.title)) known.push(`current designation: ${c.title}`);
  if (have(c.currentCompany)) known.push(`current company: ${c.currentCompany}`);
  if (have(c.expYears)) known.push(`experience: ${c.expYears} years`);
  if (have(c.education)) known.push(`education: ${c.education}`);
  if (have(c.location)) known.push(`location: ${c.location}`);
  const skills = (c.technicalSkills?.length ? c.technicalSkills : c.skills) || [];
  if (skills.length) known.push(`skills: ${skills.slice(0, 8).join(', ')}`);
  if (have(c.resumeFile)) known.push('resume on file');

  // ---- what the call actually needs ---------------------------------
  //
  // Notice period and expected CTC go stale: a figure captured six months
  // ago is worth confirming, and one captured last week is not.
  const stale = (iso, days) => {
    if (!have(iso)) return true;
    const age = (Date.now() - new Date(iso).getTime()) / 86400000;
    return !Number.isFinite(age) || age > days;
  };
  const profileAge = c.updatedAt || c.profileUpdatedAt;

  if (!have(c.noticePeriod) || stale(profileAge, 45)) {
    needed.push('notice period / earliest joining date');
  } else {
    known.push(`notice period: ${c.noticePeriod}`);
  }

  if (!have(c.expectedCtc) || stale(profileAge, 45)) {
    needed.push('expected compensation');
  } else {
    known.push(`expected CTC: ${c.expectedCtc}`);
  }

  // Location is asked only when the job's city differs from theirs, and
  // never for a remote role.
  const remote = /remote|work from home|anywhere/i.test(j.mode || '');
  const sameCity = have(c.location) && have(j.location) &&
    String(j.location).toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 3)
      .some((w) => String(c.location).toLowerCase().includes(w));
  if (!remote && have(j.location) && !sameCity) needed.push(`willingness to work in ${j.location}`);

  if (have(j.mode) && !remote && !/full.?time|permanent/i.test(j.mode)) {
    needed.push(`acceptance of ${j.mode} working`);
  }

  // A required skill the profile does not evidence is worth one question.
  const blob = [skills.join(' '), c.summary, c.title].filter(Boolean).join(' ').toLowerCase();
  const gaps = (j.skills || []).filter((s) => !blob.includes(String(s).toLowerCase()));
  for (const g of gaps.slice(0, 2)) needed.push(`hands-on experience with ${g}`);

  // The application's pending screening questions (0097), when the admin
  // lets AI calls ask them. Who is called and when does not change: this
  // only adds to what a call that is already happening asks.
  const sq = Array.isArray(opts.screening && opts.screening.questions)
    ? opts.screening.questions.filter((q) => q && q.id && q.text && q.type)
    : [];
  for (const q of sq) needed.push(`screening question: ${q.text}`);

  needed.push('interest in this opportunity');

  const stage = application?.stage;
  const objective = opts.objective
    || (stage === 'shortlisted'
      ? 'Confirm interest and availability for a shortlisted candidate'
      : 'Confirm interest, screen against the requirement, and check availability');

  return {
    objective,
    known,
    needed,
    stage,
    stageWord: STAGE_WORDS[stage] || null,
    applied: !!application,
    gaps: gaps.slice(0, 2),
    askLocation: !remote && have(j.location) && !sameCity,
    askWorkMode: have(j.mode) && !remote && /hybrid|onsite|work from office/i.test(j.mode),
    askSalary: !have(c.expectedCtc) || stale(profileAge, 45),
    askNotice: !have(c.noticePeriod) || stale(profileAge, 45),
    screening: sq.length ? sq.map((q) => ({
      id: q.id, text: q.text, type: q.type, options: q.options || {}, stdKey: q.stdKey || null,
    })) : undefined,
    screeningPrefill: sq.length ? (opts.screening.prefill || {}) : undefined,
  };
}

/* ------------------------------------------------------------------ *
 * 2. the conversation
 * ------------------------------------------------------------------ */

/** A fresh conversation, ready for its first turn. */
export function startConversation({ candidate, job, application, settings, plan: p, language }) {
  return {
    state: 'call_init',
    language: language || candidate?.preferredLanguage || settings?.defaultLanguage || 'en',
    languageConfidence: language ? 1 : 0,
    mixed: false,
    languageSwitched: false,
    silenceCount: 0,
    unclearCount: 0,
    askedGaps: [],
    asked: {},
    data: {
      screening: {}, candidateQuestions: [], candidateConcerns: [],
      screeningAnswers: {},
    },
    sq: { done: {}, current: null, mode: null, tries: 0, introduced: false, pending: null },
    interest: null,
    outcome: null,
    ended: false,
    plan: p,
    vars: {
      name: (candidate?.name || '').split(' ')[0] || 'there',
      agent: settings?.agentName || 'Anu',
      company: settings?.companyName || 'TeamLink Consultants',
      role: job?.title || 'an opportunity',
      location: job?.location || '',
      mode: (job?.mode || '').toLowerCase(),
      atCompany: settings?.discloseClient && job?.companyName ? ` at ${job.companyName}` : '',
      inLocation: job?.location ? ` in ${job.location}` : '',
      min: job?.salaryMin ? Math.round(job.salaryMin / 100000) : null,
      max: job?.salaryMax ? Math.round(job.salaryMax / 100000) : null,
      title: candidate?.title || '',
      skill: '',
    },
  };
}

/** Compose one or more lines in the conversation's language. */
function speak(conv, ...lines) {
  return lines
    .filter(Boolean)
    .map((l) => say(l, conv.language, conv.mixed, conv.vars))
    .join(' ')
    .trim();
}

const end = (conv, outcome, text, extra = {}) => {
  conv.ended = true;
  conv.outcome = outcome;
  conv.state = 'call_closing';
  return { say: text, end: true, outcome, ...extra };
};

/**
 * The opening line. Nothing is asked yet: the call establishes who it is
 * speaking to and whether now is a reasonable time, which is what a
 * person would do.
 */
export function openingTurn(conv, settings) {
  conv.state = 'identity_confirmation';
  const parts = [LINES.askForCandidate];
  return { say: speak(conv, ...parts), end: false, expect: 'identity' };
}

/**
 * One candidate turn in, one agent turn out.
 *
 * @param {object} conv       mutable conversation state
 * @param {string} transcript what the candidate said ('' for silence)
 * @param {object} settings   the admin configuration
 * @returns {{say:string, end:boolean, outcome?:string, action?:object}}
 */
export function nextTurn(conv, transcript, settings = {}) {
  const text = String(transcript || '').trim();

  /* ---- language first: it changes everything that follows ---------- */
  const requested = languageRequest(text);
  const det = detectLanguage(text, { current: conv.language });
  if (requested && requested !== conv.language) {
    conv.language = requested;
    conv.languageSwitched = true;
    conv.languageConfidence = 0.98;
    conv.mixed = false;
  } else if (det.confidence >= 0.6 && det.language !== conv.language) {
    conv.language = det.language;
    conv.languageConfidence = det.confidence;
    conv.languageSwitched = true;
    conv.mixed = det.mixed;
  } else if (det.confidence > conv.languageConfidence) {
    conv.languageConfidence = det.confidence;
    conv.mixed = det.mixed;
  }

  const { intent } = detectIntent(text);
  conv.lastIntent = intent;

  /* ---- silence, from any state ------------------------------------ */
  if (intent === 'silence') {
    conv.silenceCount++;
    if (conv.silenceCount === 1) return { say: speak(conv, LINES.stillThere), end: false };
    if (conv.silenceCount === 2) return { say: speak(conv, LINES.takeYourTime), end: false };
    return end(conv, 'no_response', speak(conv, LINES.notAGoodTime, LINES.closingGeneric),
      { action: { callback: true, reason: 'no response on the call' } });
  }
  conv.silenceCount = 0;

  /* ---- the interrupts: urgent, and possible from ANY state --------- */
  switch (intent) {
    case 'wrong_number':
      return end(conv, 'wrong_number', speak(conv, LINES.wrongNumber),
        { action: { flagNumber: true } });

    case 'do_not_contact':
      conv.data.doNotContact = true;
      return end(conv, 'do_not_contact', speak(conv, LINES.doNotContact),
        { action: { doNotContact: true } });

    case 'abusive':
      // Not a negotiation. The call ends politely and the number is left
      // alone until a human decides otherwise.
      return end(conv, 'do_not_contact', speak(conv, LINES.apologise, LINES.closingGeneric),
        { action: { doNotContact: true, reason: 'call ended: abusive' } });

    case 'angry': {
      // Apologise once, offer to stop, and do NOT continue screening.
      conv.angry = (conv.angry || 0) + 1;
      if (conv.angry >= 2) {
        return end(conv, 'not_interested', speak(conv, LINES.apologise, LINES.noteNotInterested),
          { action: { interest: 'not_interested', reason: 'candidate was frustrated' } });
      }
      conv.state = 'interest_check';
      return { say: speak(conv, LINES.apologise, LINES.offerToStop), end: false };
    }

    case 'hold':
      return { say: speak(conv, LINES.hold), end: false, wait: true };

    case 'busy':
      conv.state = 'callback_requested';
      conv.awaitingCallbackTime = true;
      return { say: speak(conv, LINES.busyCallback), end: false };

    case 'recruiter':
      conv.data.recruiterCallbackRequired = true;
      return end(conv, 'recruiter_callback', speak(conv, LINES.recruiterWillCall, LINES.closingGeneric),
        { action: { recruiterCallback: true, question: conv.lastQuestion || null } });

    case 'already_joined':
      conv.interest = 'not_interested';
      return end(conv, 'already_joined',
        speak(conv, LINES.noteNotInterested, LINES.closingGeneric),
        { action: { interest: 'not_interested', reason: 'ALREADY_JOINED' } });

    case 'repeat':
      conv.unclearCount++;
      if (conv.unclearCount >= 3) {
        return end(conv, 'technical_failure', speak(conv, LINES.audioGivingUp),
          { action: { recruiterCallback: true, reason: 'audio quality' } });
      }
      return { say: speak(conv, LINES.audioTrouble, conv.lastLine), end: false };

    case 'goodbye':
      return end(conv, conv.interest === 'interested' ? 'call_completed' : 'no_response',
        speak(conv, LINES.closingGeneric));
    default:
      break;
  }

  /* ---- waiting for a callback time -------------------------------- */
  if (conv.awaitingCallbackTime) {
    conv.awaitingCallbackTime = false;
    const when = parseWhen(text);
    conv.data.callbackRequired = true;
    conv.data.callbackAt = when ? when.toISOString() : null;
    return end(conv, 'callback_requested', speak(conv, LINES.callbackNoted),
      { action: { callback: true, at: when ? when.toISOString() : null, raw: text } });
  }

  /* ---- a question, at any point ----------------------------------- */
  if (intent === 'question') {
    conv.lastQuestion = text;
    conv.data.candidateQuestions.push(text);
    const answer = answerQuestion(text, conv, settings);
    // Answering does not lose the thread: the pending question is asked
    // again straight after.
    return { say: [answer, conv.pendingAsk].filter(Boolean).join(' '), end: false };
  }

  /* ---- the state machine proper ------------------------------------ */
  return advance(conv, text, intent, settings);
}

/* ------------------------------------------------------------------ *
 * the states
 * ------------------------------------------------------------------ */

function advance(conv, text, intent, settings) {
  const p = conv.plan || {};

  switch (conv.state) {
    /* ---- "may I speak with X?" ------------------------------------ */
    case 'identity_confirmation': {
      const yes = parseYesNo(text);
      if (yes === false) {
        return end(conv, 'wrong_number', speak(conv, LINES.wrongNumber), { action: { flagNumber: true } });
      }
      conv.state = 'consent_to_speak';

      const parts = [LINES.introduce];
      if (settings.discloseAi) parts.push(LINES.aiDisclosure);
      if (settings.recordingEnabled) parts.push(LINES.recordingDisclosure);
      parts.push(p.applied ? LINES.reasonApplied : LINES.reasonSourced);
      parts.push(LINES.goodTime);

      conv.pendingAsk = speak(conv, LINES.goodTime);
      return {
        say: speak(conv, ...parts),
        end: false,
        action: {
          consent: [
            settings.discloseAi ? 'ai_disclosed' : null,
            settings.recordingEnabled ? 'recording_disclosed' : null,
          ].filter(Boolean),
        },
      };
    }

    /* ---- "is this a good time?" ----------------------------------- */
    case 'consent_to_speak': {
      const yes = parseYesNo(text);
      if (yes === false) {
        conv.state = 'callback_requested';
        conv.awaitingCallbackTime = true;
        return { say: speak(conv, LINES.busyCallback), end: false };
      }
      conv.state = 'interest_check';

      const lines = [];
      if (p.stage === 'shortlisted') lines.push(LINES.shortlisted);
      else lines.push(LINES.opportunity);
      lines.push(LINES.askInterest);
      conv.pendingAsk = speak(conv, LINES.askInterest);
      return { say: speak(conv, ...lines), end: false };
    }

    /* ---- "are you open to opportunities?" -------------------------- */
    case 'interest_check': {
      if (intent === 'not_interested' || parseYesNo(text) === false) {
        conv.interest = 'not_interested';
        conv.data.interestReason = objectionReason(text);
        conv.state = 'final_confirmation';
        conv.awaitingWhyNot = true;
        return { say: speak(conv, LINES.whyNotInterested), end: false };
      }
      conv.interest = 'interested';
      return askNext(conv, settings);
    }

    /* ---- the reason behind a no ------------------------------------ */
    case 'final_confirmation': {
      if (conv.awaitingWhyNot) {
        conv.awaitingWhyNot = false;
        const reason = objectionReason(text);
        conv.data.interestReason = reason;
        conv.data.candidateConcerns.push(text);
        const outcome = {
          SALARY: 'salary_mismatch', LOCATION: 'location_mismatch',
          NOTICE_PERIOD: 'notice_period_mismatch', ALREADY_JOINED: 'already_joined',
          NOT_LOOKING: 'not_looking',
        }[reason] || 'not_interested';
        return end(conv, outcome, speak(conv, LINES.noteNotInterested, LINES.closingGeneric),
          { action: { interest: 'not_interested', reason } });
      }
      // Asked whether to proceed.
      const yes = parseYesNo(text);
      conv.data.interviewInterest = yes !== false;
      conv.state = 'candidate_questions';
      conv.pendingAsk = speak(conv, LINES.anyQuestions);
      return { say: conv.pendingAsk, end: false };
    }

    /* ---- answers to the screening questions ------------------------ */
    case 'compensation_check': {
      // "30 days notice" contains a number, and parseMoney would read it
      // as 30 LPA. A figure that is plainly about time is not a salary,
      // and storing it would put nonsense in front of a recruiter.
      const aboutTime = /\b(day|days|din|roju|rojulu|month|months|mahina|nela|nelalu|week|weeks|notice|immediate)\b/i.test(text);
      const amount = aboutTime ? null : parseMoney(text);
      if (amount) conv.data.expectedCtc = amount;
      else if (aboutTime) {
        // They answered the next question early. Take it, and do not ask
        // it again.
        const n = parseNotice(text);
        if (n) {
          conv.data.noticePeriod = n.label;
          if (n.days != null) {
            conv.data.earliestJoiningDate =
              new Date(Date.now() + n.days * 86400000).toISOString().slice(0, 10);
          }
          conv.asked.notice = true;
        }
      } else conv.data.candidateConcerns.push(text);

      // Above the band is noted, never argued with and never promised.
      const max = conv.vars.max ? conv.vars.max * 100000 : null;
      if (amount && max && amount > max * 1.1) {
        conv.data.candidateConcerns.push(`expects ${Math.round(amount / 100000)} LPA against a band topping out at ${conv.vars.max} LPA`);
        conv.aboveBand = true;
      }
      return askNext(conv, settings, conv.aboveBand ? LINES.noteExpectation : null);
    }

    case 'availability_check': {
      const notice = parseNotice(text);
      if (notice) {
        conv.data.noticePeriod = notice.label;
        if (notice.days != null) {
          const d = new Date(Date.now() + notice.days * 86400000);
          conv.data.earliestJoiningDate = d.toISOString().slice(0, 10);
        }
      } else {
        conv.data.screening.availability = text;
      }
      return askNext(conv, settings);
    }

    case 'location_check': {
      const yes = parseYesNo(text);
      conv.data.locationAccepted = yes !== false;
      conv.data.locationYesNo = yes;            // null when it was not a clear answer
      if (yes === false) conv.data.candidateConcerns.push(`location: ${text}`);
      return askNext(conv, settings);
    }

    case 'work_mode_check': {
      const yes = parseYesNo(text);
      conv.data.workModeAccepted = yes !== false;
      if (yes === false) conv.data.candidateConcerns.push(`work mode: ${text}`);
      return askNext(conv, settings);
    }

    case 'requirement_screening': {
      const skill = conv.currentSkill;
      if (skill) conv.data.screening[skill] = text;
      return askNext(conv, settings);
    }

    case 'screening_question':
      return screeningReply(conv, text, settings);

    case 'interview_interest': {
      const yes = parseYesNo(text);
      conv.data.interviewInterest = yes !== false;
      conv.state = 'candidate_questions';
      conv.pendingAsk = speak(conv, LINES.anyQuestions);
      return { say: conv.pendingAsk, end: false };
    }

    /* ---- "any questions?" ------------------------------------------ */
    case 'candidate_questions': {
      const yes = parseYesNo(text);
      if (yes === false || intent === 'negative') {
        return closeCall(conv);
      }
      // Anything else is treated as a question and answered.
      conv.data.candidateQuestions.push(text);
      const answer = answerQuestion(text, conv, settings);
      return { say: `${answer} ${speak(conv, LINES.anyQuestions)}`, end: false };
    }

    default:
      return askNext(conv, settings);
  }
}

/**
 * Ask the next thing that is actually needed, and nothing else.
 *
 * This is where "do not ask what you already know" is enforced: each
 * branch is guarded by the plan, which was built from the candidate
 * record before the call was placed.
 */
function askNext(conv, settings, prefixLine) {
  const p = conv.plan || {};
  const prefix = prefixLine ? speak(conv, prefixLine) + ' ' : '';

  // 1. a required skill the resume does not evidence
  const gap = (p.gaps || []).find((g) => !conv.askedGaps.includes(g));
  if (gap) {
    conv.askedGaps.push(gap);
    conv.currentSkill = gap;
    conv.state = 'requirement_screening';
    conv.vars.skill = gap;
    conv.pendingAsk = speak(conv, LINES.askSkill);
    return { say: prefix + conv.pendingAsk, end: false };
  }

  // 2. location, only when it differs and the role is not remote
  if (p.askLocation && !conv.asked.location) {
    conv.asked.location = true;
    conv.state = 'location_check';
    conv.pendingAsk = speak(conv, p.relocation ? LINES.askRelocation : LINES.askLocation);
    return { say: prefix + conv.pendingAsk, end: false };
  }

  // 3. work mode, only when it is hybrid or onsite
  if (p.askWorkMode && !conv.asked.workMode) {
    conv.asked.workMode = true;
    conv.state = 'work_mode_check';
    conv.pendingAsk = speak(conv, LINES.askWorkMode);
    return { say: prefix + conv.pendingAsk, end: false };
  }

  // 4. compensation, only when unknown or stale, and only with a band
  //    we are allowed to quote
  if (p.askSalary && !conv.asked.salary) {
    conv.asked.salary = true;
    conv.state = 'compensation_check';
    const canQuote = settings.discloseSalary !== false && conv.vars.min && conv.vars.max;
    conv.pendingAsk = speak(conv, canQuote ? LINES.salaryBand : LINES.askExpected);
    return { say: prefix + conv.pendingAsk, end: false };
  }

  // 5. availability
  if (p.askNotice && !conv.asked.notice) {
    conv.asked.notice = true;
    conv.state = 'availability_check';
    conv.pendingAsk = speak(conv, LINES.askAvailability);
    return { say: prefix + conv.pendingAsk, end: false };
  }

  // 5b. the job's pending screening questions, when the admin allows it
  const sq = askScreening(conv, prefix);
  if (sq) return sq;

  // 6. shall we take this forward?
  if (!conv.asked.interview) {
    conv.asked.interview = true;
    conv.state = 'interview_interest';
    conv.pendingAsk = speak(conv, LINES.askInterviewInterest);
    return { say: prefix + conv.pendingAsk, end: false };
  }

  conv.state = 'candidate_questions';
  conv.pendingAsk = speak(conv, LINES.anyQuestions);
  return { say: prefix + conv.pendingAsk, end: false };
}

function closeCall(conv) {
  const interested = conv.interest === 'interested';
  return end(conv, interested ? 'interested' : 'call_completed',
    interested ? speak(conv, LINES.closingInterested) : speak(conv, LINES.closingGeneric));
}

/* ------------------------------------------------------------------ *
 * the job's own screening questions (0097)
 *
 * Asked after everything the call already asks, one at a time, and only
 * those still unanswered on the application. A question the call has
 * already settled (notice period, expected CTC, relocation) is filled from
 * what the candidate said rather than asked twice; one with a saved answer
 * or a profile value is confirmed in one line rather than asked cold.
 * Every answer goes through normaliseAnswer() - the validation the apply
 * form, the link page and "answered on call" use - and an answer that does
 * not pass is asked once more, then left for the no-password link.
 * ------------------------------------------------------------------ */

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WORD_NUM = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50,
};
const pad2 = (n) => String(n).padStart(2, '0');

/** "15 March", "March 15th 2027", "15/03/2027", "2027-03-15", "in 20 days" -> YYYY-MM-DD. */
export function parseSpokenDate(text, now = new Date()) {
  const t = String(text || '').toLowerCase();
  const mk = (y, mo, d) => {
    if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return null;
    const s = `${y}-${pad2(mo)}-${pad2(d)}`;
    const back = new Date(`${s}T00:00:00Z`);
    return Number.isFinite(back.getTime()) && back.toISOString().slice(0, 10) === s ? s : null;
  };
  let m = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/.exec(t);
  if (m) return mk(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b/.exec(t);
  if (m) return mk(m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]), Number(m[2]), Number(m[1]));
  m = /\bin\s+(\d{1,3})\s*(day|days|week|weeks)\b/.exec(t);
  if (m) {
    const days = Number(m[1]) * (/week/.test(m[2]) ? 7 : 1);
    return new Date(now.getTime() + days * 86400000).toISOString().slice(0, 10);
  }
  let day = null; let mon = null; let year = null;
  m = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]{3,9})\b(?:,?\s*(\d{4}))?/.exec(t);
  if (m && MONTHS.includes(m[2].slice(0, 3))) {
    day = Number(m[1]); mon = MONTHS.indexOf(m[2].slice(0, 3)) + 1; year = m[3];
  }
  if (day === null) {
    m = /\b([a-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s*(\d{4}))?/.exec(t);
    if (m && MONTHS.includes(m[1].slice(0, 3))) {
      day = Number(m[2]); mon = MONTHS.indexOf(m[1].slice(0, 3)) + 1; year = m[3];
    }
  }
  if (day === null) return null;
  const y = year ? Number(year) : now.getUTCFullYear();
  let out = mk(y, mon, day);
  // No year said, and that day has passed this year: they mean next year.
  if (out && !year && out < now.toISOString().slice(0, 10)) out = mk(y + 1, mon, day);
  return out;
}

function numberIn(text) {
  const t = String(text || '').toLowerCase().replace(/,/g, '');
  const m = /(-?\d+(?:\.\d+)?)/.exec(t);
  if (m) return Number(m[1]);
  for (const [w, n] of Object.entries(WORD_NUM)) if (new RegExp(`\\b${w}\\b`).test(t)) return n;
  return null;
}

/** A notice period the call heard -> one of the question's choices. */
function noticeChoice(choices, notice) {
  if (!notice) return null;
  if (/serving/i.test(notice.label || '')) return choices.find((c) => /serving/i.test(c)) || null;
  if (notice.days === null || notice.days === undefined) return null;
  return choices.find((c) => !/serving/i.test(c) && noticeDays(c) === notice.days) || null;
}

const isMoney = (q) => q.type === 'number'
  && (/lpa|lakh|ctc|inr|rs/i.test(String((q.options || {}).unit || '')) || /ctc/.test(q.stdKey || ''));

/** What the candidate just said, as a raw answer to `q` - or null. */
export function parseScreeningAnswer(q, text) {
  const t = String(text || '').trim();
  if (!t) return null;
  const o = q.options || {};
  switch (q.type) {
    case 'yes_no': {
      const yn = parseYesNo(t);
      return yn === null ? null : { value: yn ? 'yes' : 'no' };
    }
    case 'number': {
      if (isMoney(q)) {
        const r = parseMoney(t);
        return r ? { value: Math.round(r / 1000) / 100 } : null;
      }
      const n = numberIn(t);
      return n === null ? null : { value: n };
    }
    case 'single_choice': {
      const choices = o.choices || [];
      if (q.stdKey === 'notice_period' || choices.some((c) => /immediate|\bdays?\b/i.test(c))) {
        // A date ("15 March") is a last working day, not "15 days".
        const serving = choices.find((c) => /serving/i.test(c));
        const f = o.followUp;
        const date = serving && f && f.type === 'date'
          && String(f.when).toLowerCase() === serving.toLowerCase() ? parseSpokenDate(t) : null;
        if (date) return { value: serving, detail: date };
        const hit = noticeChoice(choices, parseNotice(t));
        if (hit) return { value: hit };
      }
      const low = t.toLowerCase();
      const hit = choices.filter((c) => low.includes(c.toLowerCase())).sort((a, b) => b.length - a.length)[0];
      return hit ? { value: hit } : null;
    }
    case 'multi_choice': {
      const low = t.toLowerCase();
      const hits = (o.choices || []).filter((c) => low.includes(c.toLowerCase()));
      return hits.length ? { value: hits } : null;
    }
    case 'short_text':
      return { value: t.slice(0, 200) };
    case 'date': {
      const d = parseSpokenDate(t);
      return d ? { value: d } : null;
    }
    default:
      return null;
  }
}

/** Already settled earlier on this call? Then it is not asked again. */
function fromThisCall(q, conv) {
  const d = conv.data || {};
  if (q.stdKey === 'notice_period' && d.noticePeriod) {
    const hit = noticeChoice((q.options || {}).choices || [], parseNotice(d.noticePeriod) || null);
    return hit && !/serving/i.test(hit) ? { value: hit } : null;
  }
  if (q.stdKey === 'expected_ctc' && d.expectedCtc) return { value: Math.round(d.expectedCtc / 1000) / 100 };
  if (q.stdKey === 'relocate' && typeof d.locationYesNo === 'boolean') {
    return { value: d.locationYesNo ? 'yes' : 'no' };
  }
  return null;
}

/** normaliseAnswer(), or null when the answer would be refused. */
function valid(q, raw) {
  if (!raw) return null;
  try { return normaliseAnswer(q, raw); } catch { return null; }
}

/** Does this value open the question's follow-up (e.g. "Serving notice" -> last working day)? */
function followUpFor(q, value) {
  const f = (q.options || {}).followUp;
  if (!f || value === undefined || value === null) return null;
  return String(value).toLowerCase() === String(f.when || '').toLowerCase() ? f : null;
}

function spokenAnswer(q, a) {
  if (!a) return '';
  const v = a.value;
  let s = Array.isArray(v) ? v.join(', ') : String(v);
  if (q.type === 'number' && (q.options || {}).unit) s += ` ${q.options.unit}`;
  if (a.detail) s += `, ${a.detail}`;
  return s;
}

function speakQuestion(conv, q, { intro = false, confirm = null } = {}) {
  const o = q.options || {};
  conv.vars.question = q.text;
  const lines = [];
  if (intro) lines.push(LINES.screeningIntro);
  if (confirm) {
    conv.vars.answer = spokenAnswer(q, confirm);
    lines.push(LINES.screeningConfirm);
  } else {
    lines.push(LINES.screeningAsk);
    if ((q.type === 'single_choice' || q.type === 'multi_choice') && (o.choices || []).length) {
      const c = o.choices;
      conv.vars.choices = c.length > 1 ? `${c.slice(0, -1).join(', ')} or ${c[c.length - 1]}` : c[0];
      lines.push(LINES.screeningChoices);
    }
    if (q.type === 'number' && o.unit) { conv.vars.unit = o.unit; lines.push(LINES.screeningUnit); }
  }
  return speak(conv, ...lines);
}

function sqState(conv) {
  if (!conv.sq) conv.sq = { done: {}, current: null, mode: null, tries: 0, introduced: false, pending: null };
  if (!conv.data.screeningAnswers) conv.data.screeningAnswers = {};
  return conv.sq;
}

function recordScreening(conv, q, answer) {
  const st = sqState(conv);
  conv.data.screeningAnswers[q.id] = answer;
  st.done[q.id] = 'answered';
  st.current = null; st.mode = null; st.pending = null; st.tries = 0;
}

/** The next screening question to ask, or null when there is none left. */
function askScreening(conv, prefix = '') {
  const p = conv.plan || {};
  const list = p.screening || [];
  if (!list.length) return null;
  const st = sqState(conv);
  for (const q of list) {
    if (st.done[q.id]) continue;
    const settled = valid(q, fromThisCall(q, conv));
    if (settled) { recordScreening(conv, q, settled); continue; }

    const confirm = valid(q, (p.screeningPrefill || {})[q.id]);
    st.current = q.id;
    st.mode = confirm ? 'confirm' : 'ask';
    st.tries = 0;
    st.pending = null;
    conv.state = 'screening_question';
    const intro = !st.introduced;
    st.introduced = true;
    conv.pendingAsk = speakQuestion(conv, q, { confirm });
    return { say: prefix + speakQuestion(conv, q, { intro, confirm }), end: false };
  }
  return null;
}

/** Leave this one for the no-password link, and move on. */
function giveUp(conv, settings) {
  const st = sqState(conv);
  if (st.current) st.done[st.current] = 'skipped';
  st.current = null; st.mode = null; st.pending = null; st.tries = 0;
  return askNext(conv, settings);
}

function retry(conv, settings, q) {
  const st = sqState(conv);
  st.tries += 1;
  if (st.tries >= 2) return giveUp(conv, settings);
  if (st.mode === 'detail') {
    conv.pendingAsk = speak(conv, LINES.screeningDetail);
    return { say: speak(conv, LINES.didNotUnderstand, LINES.screeningDetail), end: false };
  }
  st.mode = 'ask';
  conv.pendingAsk = speakQuestion(conv, q);
  return { say: `${speak(conv, LINES.didNotUnderstand)} ${conv.pendingAsk}`, end: false };
}

/** A raw answer to `q`: take it, or ask its follow-up first. */
function takeAnswer(conv, settings, q, raw) {
  const st = sqState(conv);
  const f = followUpFor(q, raw.value);
  if (f && raw.detail === undefined) {
    st.mode = 'detail';
    st.pending = raw;
    st.tries = 0;
    const label = String(f.label || 'Details').replace(/\?$/, '');
    conv.vars.label = label.charAt(0).toLowerCase() + label.slice(1);
    conv.pendingAsk = speak(conv, LINES.screeningDetail);
    return { say: conv.pendingAsk, end: false };
  }
  const ok = valid(q, raw);
  if (!ok) return retry(conv, settings, q);
  recordScreening(conv, q, ok);
  return askNext(conv, settings);
}

function screeningReply(conv, text, settings) {
  const st = sqState(conv);
  const q = ((conv.plan || {}).screening || []).find((x) => x.id === st.current);
  if (!q) return askNext(conv, settings);

  if (st.mode === 'confirm') {
    const pre = valid(q, ((conv.plan || {}).screeningPrefill || {})[q.id]);
    const yn = parseYesNo(text);
    if (yn === true && pre) { recordScreening(conv, q, pre); return askNext(conv, settings); }
    // "No, I'm in Pune now" - a value given straight away is taken. Free
    // text is only taken when it was not a plain yes or no.
    if (q.type !== 'yes_no' && !(q.type === 'short_text' && yn !== null)) {
      const raw = parseScreeningAnswer(q, text);
      if (raw) return takeAnswer(conv, settings, q, raw);
    }
    st.mode = 'ask';
    conv.pendingAsk = speakQuestion(conv, q);
    return { say: conv.pendingAsk, end: false };
  }

  if (st.mode === 'detail') {
    const f = followUpFor(q, st.pending && st.pending.value) || {};
    const raw = { ...(st.pending || {}) };
    if (f.type === 'date') {
      const d = parseSpokenDate(text);
      if (!d) return retry(conv, settings, q);
      raw.detail = d;
    } else {
      const t = String(text || '').trim();
      // "No" / "rather not say" leaves the optional detail empty.
      raw.detail = parseYesNo(t) === false && t.split(/\s+/).length <= 3 ? '' : t.slice(0, 120);
    }
    const ok = valid(q, raw);
    if (!ok) return retry(conv, settings, q);
    recordScreening(conv, q, ok);
    return askNext(conv, settings);
  }

  const raw = parseScreeningAnswer(q, text);
  if (!raw) return retry(conv, settings, q);
  return takeAnswer(conv, settings, q, raw);
}

/* ------------------------------------------------------------------ *
 * answering what the candidate asks
 * ------------------------------------------------------------------ */

/**
 * Answer from the job record, or say a recruiter will confirm.
 *
 * There is no third option. Inventing a client name, a salary or an
 * interview date is the one failure mode that damages the candidate and
 * the client at once, so anything not present in the data produces the
 * "I will have our recruiter confirm" line.
 */
function answerQuestion(text, conv, settings) {
  const t = String(text || '').toLowerCase();
  const j = conv.job || {};
  const v = conv.vars;

  if (/\b(salary|package|ctc|pay|budget|kitna|entha|jeetham)\b/.test(t)) {
    if (settings.discloseSalary !== false && v.min && v.max) {
      return speak(conv, LINES.salaryBand);
    }
    return speak(conv, LINES.dontKnow);
  }

  if (/\b(location|where|kahan|ekkada|office)\b/.test(t)) {
    return v.location ? speak(conv, LINES.askLocation) : speak(conv, LINES.dontKnow);
  }

  if (/\b(work from home|wfh|remote|hybrid|onsite|mode)\b/.test(t)) {
    return v.mode ? speak(conv, LINES.askWorkMode) : speak(conv, LINES.dontKnow);
  }

  if (/\b(company|client|kaun si|ee company|konni)\b/.test(t)) {
    // Client disclosure is a commercial decision, configured per
    // deployment, not something the agent decides on the phone.
    if (settings.discloseClient && j.companyName) {
      return speak(conv, LINES.opportunity);
    }
    return speak(conv, LINES.dontKnow);
  }

  if (/\b(role|profile|what is the job|responsib|kya kaam|enti pani)\b/.test(t)) {
    return speak(conv, LINES.opportunity);
  }

  return speak(conv, LINES.dontKnow);
}

/* ------------------------------------------------------------------ *
 * "call me at six", in three languages
 * ------------------------------------------------------------------ */

/** @returns {Date|null} */
export function parseWhen(text, now = new Date()) {
  const t = String(text || '').toLowerCase();
  const d = new Date(now);

  const tomorrow = /\b(tomorrow|kal|repu|rEpu)\b/.test(t);
  const evening = /\b(evening|shaam|sham|sanjya|sayantram|saayantram|saayantranam|night|raat|raatri|ratri)\b/.test(t);
  const morning = /\b(morning|subah|udayam)\b/.test(t);
  const afternoon = /\b(afternoon|dopahar|madhyahnam|lunch)\b/.test(t);

  const at = /\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|baje|ganta|gantalaki)?\b/.exec(t);

  if (tomorrow) d.setDate(d.getDate() + 1);

  let hour = null;
  if (at) {
    hour = Number(at[1]);
    const mins = at[2] ? Number(at[2]) : 0;
    const suffix = at[3] || '';
    if (/pm/.test(suffix) && hour < 12) hour += 12;
    if (/am/.test(suffix) && hour === 12) hour = 0;
    // "call me at 6" from a recruitment call means the evening.
    if (!suffix && hour <= 8 && !morning) hour += 12;
    if (evening && hour < 12) hour += 12;
    d.setHours(hour, mins, 0, 0);
  } else if (evening) d.setHours(18, 0, 0, 0);
  else if (morning) d.setHours(10, 0, 0, 0);
  else if (afternoon) d.setHours(14, 0, 0, 0);
  else if (tomorrow) d.setHours(11, 0, 0, 0);
  else return null;

  // A time that has already passed today means tomorrow.
  if (d <= now && !tomorrow) d.setDate(d.getDate() + 1);
  return d;
}

/* ------------------------------------------------------------------ *
 * the structured result
 * ------------------------------------------------------------------ */

/**
 * What the ATS receives. Only what was actually established: a field the
 * candidate never spoke about stays absent rather than being guessed.
 */
export function callResult(conv, { durationSeconds } = {}) {
  const d = conv.data || {};
  return {
    language: conv.language,
    languageConfidence: conv.languageConfidence,
    languageSwitched: !!conv.languageSwitched,
    interestStatus: conv.interest || 'unknown',
    interestReason: d.interestReason || null,
    currentCtc: d.currentCtc ?? null,
    expectedCtc: d.expectedCtc ?? null,
    noticePeriod: d.noticePeriod ?? null,
    earliestJoiningDate: d.earliestJoiningDate ?? null,
    locationAccepted: d.locationAccepted ?? null,
    workModeAccepted: d.workModeAccepted ?? null,
    interviewInterest: d.interviewInterest ?? null,
    screening: d.screening || {},
    candidateQuestions: d.candidateQuestions || [],
    candidateConcerns: d.candidateConcerns || [],
    callbackRequired: !!d.callbackRequired,
    callbackAt: d.callbackAt || null,
    recruiterCallbackRequired: !!d.recruiterCallbackRequired,
    doNotContact: !!d.doNotContact,
    durationSeconds: durationSeconds ?? null,
    ...(conv.plan && conv.plan.screening ? {
      screeningQuestions: conv.plan.screening.length,
      screeningAnswers: conv.plan.screening
        .filter((q) => d.screeningAnswers && d.screeningAnswers[q.id])
        .map((q) => ({ questionId: q.id, question: q.text, answer: d.screeningAnswers[q.id] })),
    } : {}),
  };
}

/**
 * The summary a recruiter reads instead of the transcript.
 *
 * Assembled from what was recorded, not written by a model: every
 * sentence here can be traced to a field, so it cannot claim the
 * candidate said something they did not.
 */
export function summarise(conv, { candidate, job }) {
  const d = conv.data || {};
  const name = candidate?.name || 'The candidate';
  const role = job?.title || 'the role';
  const out = [];

  if (conv.interest === 'interested') out.push(`${name} is interested in the ${role} opportunity.`);
  else if (conv.interest === 'not_interested') {
    out.push(`${name} is not interested${d.interestReason ? ` (${d.interestReason.toLowerCase().replace(/_/g, ' ')})` : ''}.`);
  } else out.push(`${name} did not confirm interest on this call.`);

  if (d.locationAccepted === true && job?.location) out.push(`Comfortable with the ${job.location} location.`);
  if (d.locationAccepted === false && job?.location) out.push(`Not comfortable with the ${job.location} location.`);
  if (d.workModeAccepted === false && job?.mode) out.push(`Not comfortable with ${job.mode} working.`);
  if (d.expectedCtc) out.push(`Expected compensation ${(d.expectedCtc / 100000).toFixed(1).replace(/\.0$/, '')} LPA.`);
  if (d.noticePeriod) out.push(`Notice period: ${d.noticePeriod}.`);
  if (d.earliestJoiningDate) out.push(`Earliest joining ${d.earliestJoiningDate}.`);

  for (const [skill, answer] of Object.entries(d.screening || {})) {
    if (skill === 'availability') continue;
    out.push(`On ${skill}: "${String(answer).slice(0, 120)}".`);
  }

  if (d.callbackRequired) {
    out.push(d.callbackAt
      ? `Asked to be called back on ${new Date(d.callbackAt).toLocaleString('en-GB')}.`
      : 'Asked to be called back.');
  }
  if (d.recruiterCallbackRequired) out.push('Asked to speak to a recruiter.');
  if (conv.plan && conv.plan.screening && conv.plan.screening.length) {
    const n = Object.keys(d.screeningAnswers || {}).length;
    const m = conv.plan.screening.length;
    out.push(`Answered ${n} of ${m} screening question${m === 1 ? '' : 's'} on the call.`);
  }
  if ((d.candidateQuestions || []).length) {
    out.push(`Asked: ${d.candidateQuestions.map((q) => `"${String(q).slice(0, 90)}"`).join('; ')}.`);
  }
  if (d.doNotContact) out.push('Asked not to be contacted again.');

  const langName = { en: 'English', hi: 'Hindi', te: 'Telugu' }[conv.language] || conv.language;
  out.push(`Call was conducted in ${langName}${conv.languageSwitched ? ' (the candidate switched language during the call)' : ''}.`);

  return out.join(' ');
}

/**
 * What the ATS should do next.
 *
 * Returns a STAGE from the existing `stages` table, or null to leave the
 * application where it is. The mapping is configuration, not judgement:
 * the agent never decides somebody is selected.
 */
export function atsAction(conv) {
  switch (conv.outcome) {
    case 'interested':
    case 'call_completed':
      return conv.interest === 'interested'
        ? { note: 'AI Screened - Interested', stage: null }
        : { note: 'AI Screened - No decision', stage: null };
    case 'not_interested':
    case 'not_looking':
    case 'salary_mismatch':
    case 'location_mismatch':
    case 'notice_period_mismatch':
      return { note: 'AI Screened - Not Interested', stage: 'rejected' };
    case 'already_joined':
      return { note: 'AI Screened - Already joined elsewhere', stage: 'rejected' };
    case 'callback_requested':
      return { note: 'AI Callback Pending', stage: null };
    case 'recruiter_callback':
      return { note: 'Recruiter Action Required', stage: null };
    case 'do_not_contact':
      return { note: 'Do Not Contact', stage: null };
    case 'wrong_number':
      return { note: 'AI Call - wrong number', stage: null };
    case 'technical_failure':
      return { note: 'AI Call - technical failure, recruiter to follow up', stage: null };
    default:
      return { note: 'AI Call attempted', stage: null };
  }
}
