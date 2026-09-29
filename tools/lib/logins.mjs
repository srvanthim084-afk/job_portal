/**
 * The accounts this deployment actually has.
 *
 * WHY THIS FILE EXISTS. Every verifier was written against the demo
 * accounts the prototype shipped with - recruiter@teamlink.com,
 * bde@teamlink.com, client@teamlink.com. Those were deleted deliberately
 * when the demo data went, and this portal now has exactly two logins.
 *
 * The verifiers did not know that, so they kept signing in as accounts
 * that no longer exist and reporting "could not sign in as recruiter" as
 * though the FEATURE were broken. A suite that cries wolf about
 * something nobody is going to fix stops being read, and then it stops
 * catching the things it was written to catch.
 *
 * So the accounts are named ONCE, here, and a role with no account
 * returns null rather than a credential that cannot work. A verifier
 * that gets null skips that check and says why, which is the honest
 * outcome: the thing was not tested, and the reason is that there is
 * nobody to test it as.
 *
 * Overridable by environment, so a deployment with different accounts -
 * or a future one that adds a BDE - does not need this file edited:
 *
 *     TL_RECRUITER_EMAIL / TL_RECRUITER_PASSWORD
 *     TL_ADMIN_EMAIL     / TL_ADMIN_PASSWORD
 *     TL_BDE_EMAIL       / TL_BDE_PASSWORD
 *     TL_CLIENT_EMAIL    / TL_CLIENT_PASSWORD
 *     TL_PASSWORD        the fallback for any of them
 */

const env = (k) => {
  const v = process.env[k];
  return v && String(v).trim() ? String(v).trim() : null;
};

const FALLBACK_PASSWORD = env('TL_PASSWORD');

/**
 * The two accounts that exist. Written out rather than discovered,
 * because a verifier that hunts for "some recruiter" will happily sign
 * in as a leftover test account and pass against the wrong desk.
 */
const ACCOUNTS = {
  recruiter: {
    email: env('TL_RECRUITER_EMAIL') || 'teamlinkmed001@tmlink.in',
    password: env('TL_RECRUITER_PASSWORD') || FALLBACK_PASSWORD || 'Teamlink@2026',
  },
  admin: {
    email: env('TL_ADMIN_EMAIL') || 'admin@teamlink.com',
    password: env('TL_ADMIN_PASSWORD') || FALLBACK_PASSWORD || 'TeamLink@2026',
  },
  /*
   * NO ACCOUNT, and that is the current state of this portal rather than
   * an omission here. Set TL_BDE_EMAIL / TL_CLIENT_EMAIL and the checks
   * that need them start running again with no other change.
   */
  bde: env('TL_BDE_EMAIL')
    ? { email: env('TL_BDE_EMAIL'),
        password: env('TL_BDE_PASSWORD') || FALLBACK_PASSWORD || 'TeamLink@2026' }
    : null,
  client: env('TL_CLIENT_EMAIL')
    ? { email: env('TL_CLIENT_EMAIL'),
        password: env('TL_CLIENT_PASSWORD') || FALLBACK_PASSWORD || 'TeamLink@2026' }
    : null,
};

/** Credentials for a role, or null when this deployment has nobody in it. */
export function login(role) {
  return ACCOUNTS[role] || null;
}

/** Credentials, or throw - for a role the suite cannot run without. */
export function requireLogin(role) {
  const a = ACCOUNTS[role];
  if (!a) {
    throw new Error(`This deployment has no ${role} account. `
      + `Set TL_${role.toUpperCase()}_EMAIL and TL_${role.toUpperCase()}_PASSWORD to test it.`);
  }
  return a;
}

/** The line a verifier prints when it skips a role for want of an account. */
export function noAccountNote(role) {
  return `no ${role} account exists in this deployment `
    + `(set TL_${role.toUpperCase()}_EMAIL to test it) - skipped`;
}

export const RECRUITER = ACCOUNTS.recruiter;
export const ADMIN = ACCOUNTS.admin;
