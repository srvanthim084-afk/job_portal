/**
 * Recruiter activity: the action codes the Audit Log page shows, the
 * sign-in methods that open a portal session, and the idle rule (0125).
 *
 * ONE LIST, STABLE CODES. Every row in the log carries a code from here
 * ('auth.login', 'job.published', ...). The code is what is stored and
 * filtered on and never changes; the label is only what the page prints.
 *
 * ADDING A SIGN-IN METHOD (for example single sign-on from the HRMS):
 *   1. add it to LOGIN_METHODS:   hrms: 'auth.login_hrms'
 *   2. add the code to ACTIVITY:  { code: 'auth.login_hrms', label: 'Login (via HRMS)', group: 'session' }
 *   3. after the session cookie is issued, call
 *        startPortalSession(token, 'hrms')            (api/src/auth.js)
 * Logout, the 30-minute idle rule and the time-in-portal figures then
 * apply to it with no other change.
 */

/** Minutes without a request before a recruiter is signed out. */
export const IDLE_MINUTES = Math.max(1, Number(process.env.RECRUITER_IDLE_MINUTES) || 30);

/** Sign-in method -> the action code of its audit row. */
export const LOGIN_METHODS = {
  password: 'auth.login',
  /* 0127: signed in from TeamLink HRMS (single sign-on) */
  hrms: 'auth.login_hrms',
};

export const ACTIVITY = [
  { code: 'auth.login', label: 'Login', group: 'session' },
  { code: 'auth.login_hrms', label: 'Login (via HRMS)', group: 'session' },
  { code: 'auth.session_resumed', label: 'Login (session carried over)', group: 'session' },
  { code: 'auth.logout', label: 'Logout', group: 'session' },
  { code: 'auth.auto_logout', label: 'Auto logged out', group: 'session' },
  { code: 'job.created', label: 'Job created', group: 'job' },
  { code: 'job.published', label: 'Job published', group: 'job' },
  { code: 'job.unpublished', label: 'Job unpublished', group: 'job' },
  { code: 'job.closed', label: 'Job closed', group: 'job' },
  { code: 'job.draft_saved', label: 'Draft saved', group: 'job' },
  { code: 'job.updated', label: 'Job updated', group: 'job' },
  { code: 'candidate.shortlisted', label: 'Candidate shortlisted', group: 'candidate' },
  { code: 'status.changed', label: 'Candidate stage changed', group: 'candidate' },
];

export const SESSION_CODES = ACTIVITY.filter((a) => a.group === 'session').map((a) => a.code);
export const LOGIN_CODES = ['auth.session_resumed', ...Object.values(LOGIN_METHODS)];
export const LOGOUT_CODES = ['auth.logout', 'auth.auto_logout'];

export function loginActionFor(method) {
  const code = LOGIN_METHODS[method];
  if (!code) throw new Error(`unknown sign-in method: ${method}`);
  return code;
}

/** Module name for the Job / Module column, by the audit row's entity. */
export const MODULES = {
  session: 'Portal', job: 'Jobs', candidate: 'Candidates', application: 'Applications',
  interview: 'Interviews', document: 'Documents', setting: 'Settings', recruiter: 'Team',
};

/** "2h 05m", "14m", "0m". */
export function formatDuration(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}
