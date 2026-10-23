/**
 * Naukri / Shine responses are shown in the portal and nowhere else (0162).
 *
 * An imported response (and every notice about one) stays inside TeamLink: it is read from the source mailbox, stored, assigned to
 * the mailbox's recruiter and shown in Applications / Import from Mail, with a notification in the portal. Nothing about it is
 * emailed to a recruiter's own address - no forward, no copy, no "new application" or "needs a requirement" email - unless the
 * administrator switches that on deliberately with INTAKE_RECRUITER_EMAILS=true. It is off unless the value is exactly "true".
 *
 * This is only about responses that came in by import. Every other email (password resets, account mail, the candidate's login,
 * HR notices for walk-ins, walk-in alerts) is untouched.
 */
export function recruiterResponseEmails() {
  return String(process.env.INTAKE_RECRUITER_EMAILS || '').trim().toLowerCase() === 'true';
}

/** applications.import_method of a response read from a source mailbox */
export const IMPORTED = 'recruiter_email';
