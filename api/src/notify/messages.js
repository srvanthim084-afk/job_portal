/**
 * What each candidate email actually says.
 *
 * The wording lived inside the template builder, one ad-hoc paragraph
 * per event, and every message read slightly differently - "Hi" in one,
 * "Hello" in another, a details block in some and not in others. A
 * candidate receiving four of them across a hiring process could not
 * tell they came from the same company.
 *
 * This is the house format, in one place:
 *
 *     Dear <name>,
 *     <the message>
 *     <details block>
 *     <what to do next>
 *     [ one button ]
 *     If you have any questions, please contact our recruitment team.
 *     Regards,
 *     TeamLink Consultants - Recruitment Team
 *
 * Each entry gives the subject, the opening, the facts worth listing and
 * the action. The shell around it is notify/layout.js; the plain-text
 * alternative is composed from the same pieces, so the two cannot drift
 * apart the way separately-written copies do.
 *
 * A FACT WITH NO VALUE IS DROPPED, never printed as a label with a blank
 * or the word "undefined" beside it - an email that says
 * "Location:" and nothing else reads as broken software.
 */

const SIGN_OFF = 'Regards,\nTeamLink Consultants\nRecruitment Team';
const HELP = 'If you have any questions, please contact our recruitment team.';

/** The details every job-related message carries, in one order. */
const jobFacts = (c) => [
  ['Position', c.jobTitle],
  ['Company', c.company && c.company !== 'the company' ? c.company : ''],
  ['Location', c.location],
  ['Department', c.department],
];

/**
 * @typedef {{ subject:(c)=>string, body:(c)=>string, facts?:(c)=>Array,
 *             instruction?:(c)=>string, cta?:(c)=>({label,url}) }} Message
 * @type {Record<string, Message>}
 */
export const MESSAGES = {
  INTERVIEW_SCHEDULED: {
    subject: (c) => `Interview Scheduled – ${c.jobTitle} | TeamLink Consultants`,
    body: (c) => 'We are pleased to inform you that your interview has been scheduled '
      + `for the ${c.jobTitle} position.`,
    facts: (c) => [
      ['Position', c.jobTitle],
      ['Company', c.company && c.company !== 'the company' ? c.company : ''],
      ['Date', c.interviewDate],
      ['Time', c.interviewTime],
      ['Interview Type', c.interviewType || c.mode],
      ['Location / Meeting Link', c.interviewLocation || c.interviewUrl],
    ],
    instruction: () => 'Please be available at least 10 minutes before the scheduled '
      + 'time and ensure that you have a stable internet connection if the interview '
      + 'is online.\n\nPlease log in to your TeamLink Candidate Portal to view the '
      + 'complete interview details.',
    cta: (c) => ({ label: c.interviewUrl ? 'Join Interview' : 'Open Candidate Portal',
                   url: c.interviewUrl || c.portalUrl }),
  },

  AI_INTERVIEW_REMINDER: {
    subject: (c) => `Interview Reminder – ${c.jobTitle}`
      + (c.interviewDate ? ` | ${c.interviewDate}` : ''),
    body: (c) => `This is a reminder that your interview for the ${c.jobTitle} `
      + 'position is scheduled.',
    facts: (c) => [
      ['Date', c.interviewDate],
      ['Time', c.interviewTime],
      ['Interview Type', c.interviewType || 'Online'],
    ],
    instruction: () => 'Please be ready before the scheduled time.\n\nYou can also view '
      + 'the complete details in your TeamLink Candidate Portal.',
    cta: (c) => ({ label: 'Join Interview', url: c.interviewUrl || c.portalUrl }),
  },

  INTERVIEW_RESCHEDULED: {
    subject: (c) => `Interview Rescheduled – ${c.jobTitle}`,
    body: (c) => `Your interview for the ${c.jobTitle} position has been rescheduled.`,
    facts: (c) => [
      ['Date', c.interviewDate],
      ['Time', c.interviewTime],
      ['Interview Type', c.interviewType || c.mode],
    ],
    instruction: () => 'Please consider the above details as the latest interview schedule.',
    cta: (c) => ({ label: 'View Interview Details', url: c.portalUrl }),
  },

  INTERVIEW_CANCELLED: {
    subject: (c) => `Interview Cancelled – ${c.jobTitle}`,
    body: (c) => 'We would like to inform you that your scheduled interview for the '
      + `${c.jobTitle} position has been cancelled.`,
    facts: (c) => [
      ['Previous Interview Date', c.interviewDate],
      ['Previous Interview Time', c.interviewTime],
    ],
    instruction: () => 'If a new interview schedule is arranged, you will receive a '
      + 'separate notification.',
    cta: (c) => ({ label: 'Open Candidate Portal', url: c.portalUrl }),
  },

  APPLICATION_RECEIVED: {
    subject: (c) => `Application Received – ${c.jobTitle}`,
    body: (c) => `Thank you for applying for the ${c.jobTitle} position through `
      + 'TeamLink Consultants.\n\nWe have successfully received your application and '
      + 'our recruitment team will review your profile.',
    facts: (c) => [...jobFacts(c), ['Application Date', c.applicationDate]],
    instruction: () => 'You can track your application status through your TeamLink '
      + 'Candidate Portal.',
    cta: (c) => ({ label: 'Open Candidate Portal', url: c.portalUrl }),
  },

  STAGE_SHORTLISTED: {
    subject: (c) => `You Have Been Shortlisted – ${c.jobTitle}`,
    body: (c) => `Congratulations!\n\nYour profile has been shortlisted for the `
      + `${c.jobTitle} position.`,
    facts: jobFacts,
    instruction: () => 'Our recruitment team will contact you with the next steps.\n\n'
      + 'Please keep your phone and email available for further communication.',
    cta: (c) => ({ label: 'View Application Status', url: c.portalUrl }),
  },

  STAGE_SELECTED: {
    subject: (c) => `Selection Update – ${c.jobTitle} | TeamLink Consultants`,
    body: (c) => 'We are pleased to inform you that you have been selected for the '
      + `${c.jobTitle} position.`,
    facts: (c) => [...jobFacts(c), ['Selection Date', c.selectionDate]],
    instruction: () => 'Our recruitment team will share the next steps and joining '
      + 'formalities with you.\n\nCongratulations, and we wish you all the best!',
    cta: (c) => ({ label: 'View Candidate Portal', url: c.portalUrl }),
  },

  STAGE_REJECTED: {
    subject: (c) => `Application Update – ${c.jobTitle}`,
    /*
     * The one message nobody wants to receive, so it says the thing
     * plainly and does not pad it. No details block: listing the role
     * they did not get, item by item, is unkind and serves nobody.
     */
    body: (c) => `Thank you for your interest in the ${c.jobTitle} position and for `
      + 'taking the time to participate in our recruitment process.\n\n'
      + 'After reviewing your application, we will not be proceeding with your '
      + 'candidature for this particular position.',
    instruction: () => 'We appreciate your time and encourage you to continue exploring '
      + 'other suitable opportunities through TeamLink.',
    cta: (c) => ({ label: 'Explore Available Jobs', url: c.jobsUrl || c.portalUrl }),
  },

  OFFER_EXTENDED: {
    subject: (c) => `Offer Letter Available – ${c.jobTitle}`,
    body: (c) => 'Congratulations!\n\nYour offer letter for the '
      + `${c.jobTitle} position is now available in your TeamLink Candidate Portal.`,
    facts: (c) => [...jobFacts(c), ['Joining Date', c.joiningDate], ['Offered CTC', c.ctc]],
    instruction: () => 'Please log in to your candidate portal to review the offer '
      + 'details and complete the required action.',
    cta: (c) => ({ label: 'View Offer Letter', url: c.portalUrl }),
  },

  JOINING_REMINDER: {
    subject: (c) => `Joining Reminder – ${c.company}`,
    body: (c) => 'This is a reminder regarding your upcoming joining with '
      + `${c.company}.`,
    facts: (c) => [
      ['Position', c.jobTitle],
      ['Joining Date', c.joiningDate],
      ['Joining Time', c.joiningTime],
      ['Location', c.joiningLocation || c.location],
    ],
    instruction: () => 'Please ensure that you complete all required joining formalities '
      + 'before your joining date.',
    cta: (c) => ({ label: 'View Joining Details', url: c.portalUrl }),
  },

  CANDIDATE_INVITED: {
    subject: () => 'Welcome to TeamLink Candidate Portal',
    body: () => 'Your TeamLink Candidate Portal account has been successfully created.\n\n'
      + 'You can use the portal to manage your profile, upload and update your resume, '
      + 'apply for jobs, track applications, view interview schedules, attend online '
      + 'interviews and receive recruitment notifications.',
    facts: (c) => [
      ['Login Email', c.loginEmail],
      // The password is a fact of this message and of no other. It is
      // never stored, logged or returned by any API.
      ['Temporary Password', c.tempPassword],
    ],
    instruction: (c) => c.tempPassword
      ? 'You will be asked to choose your own password the first time you sign in.'
      : 'Sign in with your existing password.',
    cta: (c) => ({ label: 'Open Candidate Portal', url: c.portalUrl }),
  },

  PROFILE_INCOMPLETE: {
    subject: () => 'Complete Your TeamLink Profile',
    body: () => 'Your TeamLink profile is currently incomplete.\n\nCompleting your '
      + 'profile and uploading your latest resume will help our recruitment team '
      + 'identify suitable opportunities for you.',
    cta: (c) => ({ label: 'Complete My Profile', url: c.portalUrl }),
  },

  APPLICATION_SUBMITTED: {
    subject: (c) => `Application Submitted – ${c.jobTitle}`,
    body: (c) => `Your application for the ${c.jobTitle} position has been successfully `
      + 'submitted using your registered TeamLink resume.',
    facts: (c) => [...jobFacts(c), ['Applied On', c.applicationDate]],
    instruction: () => 'You can track your application status from your candidate portal.',
    cta: (c) => ({ label: 'Track Application', url: c.portalUrl }),
  },
};

/**
 * The pieces of one message, or null when this event has no house
 * format yet - in which case the caller keeps its existing wording
 * rather than being handed a half-filled shell.
 */
export function houseMessage(event, c) {
  const m = MESSAGES[event];
  if (!m) return null;

  const facts = (m.facts ? m.facts(c) : [])
    .filter((f) => f && f[1] != null && String(f[1]).trim() !== '');

  return {
    subject: m.subject(c),
    greeting: c.candidateName ? `Dear ${c.candidateName},` : 'Dear Candidate,',
    body: m.body(c),
    facts,
    instruction: m.instruction ? m.instruction(c) : '',
    cta: m.cta ? m.cta(c) : null,
    help: HELP,
    signOff: SIGN_OFF,
  };
}

/** The same message as plain text, for a client that shows no HTML. */
export function houseText(h) {
  return [
    h.greeting,
    '',
    h.body,
    h.facts.length ? '' : null,
    ...h.facts.map(([k, v]) => `${k}: ${v}`),
    h.instruction ? '' : null,
    h.instruction,
    h.cta && h.cta.url ? `\n${h.cta.label}: ${h.cta.url}` : null,
    '',
    h.help,
    '',
    h.signOff,
  ].filter((x) => x !== null).join('\n');
}
