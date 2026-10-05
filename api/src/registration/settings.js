/**
 * Settings for the candidate registration flow (0109).
 *
 * Read from the environment AT CALL TIME rather than once at import, so a
 * deployment changes them with a restart and the test suite can exercise
 * each value inside one process. Nothing here is a secret.
 *
 *   CONSENT_VERSION              the version of the Terms / Privacy wording
 *                                stored with every consent (default 2026-10)
 *   PRIVACY_POLICY_URL           where "Privacy Policy" links to
 *   TERMS_URL                    where "Terms & Conditions" links to
 *   PRIVACY_POLICY_VERSION       shown beside the policy link (defaults to
 *                                CONSENT_VERSION)
 *   REGISTRATION_CONSENT_REQUIRED  refuse a registration that does not carry
 *                                the two required consents. Default: on in
 *                                production, off elsewhere, because many
 *                                existing scripts and tests create accounts
 *                                through the API without a form.
 *   REGISTER_RATE_LIMIT_MAX      registration attempts per origin per hour
 *   REGISTER_FAILURE_MAX         refused registrations per origin per hour
 *                                before that origin is made to wait
 *   REGISTER_CHECK_MAX           "is this email/mobile taken?" lookups per
 *                                origin per 15 minutes
 *   LOGIN_ACCOUNT_LOCK_MAX       wrong passwords for ONE account, from any
 *                                origin, in LOGIN_ACCOUNT_LOCK_MINUTES, before
 *                                that account is locked for the same period
 *   REGISTRATION_REMINDER_HOURS  how long after registering the one profile
 *                                reminder may go (default 48)
 *   DOCUMENT_MAX_BYTES / PHOTO_MAX_BYTES   per-file limits for §34 documents
 */
const int = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : d;
};
const isProd = () => process.env.NODE_ENV === 'production';

export function registrationSettings() {
  const prod = isProd();
  const version = String(process.env.CONSENT_VERSION || '2026-10').trim().slice(0, 40) || '2026-10';
  const required = process.env.REGISTRATION_CONSENT_REQUIRED;
  return {
    consentVersion: version,
    privacyPolicyUrl: String(process.env.PRIVACY_POLICY_URL || '').trim().slice(0, 300),
    termsUrl: String(process.env.TERMS_URL || '').trim().slice(0, 300),
    privacyPolicyVersion: String(process.env.PRIVACY_POLICY_VERSION || version).trim().slice(0, 40),
    consentRequired: required === undefined || required === ''
      ? prod : /^(1|true|yes|on)$/i.test(String(required)),
    registerMax: int(process.env.REGISTER_RATE_LIMIT_MAX, prod ? 20 : 1000),
    registerFailureMax: int(process.env.REGISTER_FAILURE_MAX, prod ? 10 : 300),
    checkMax: int(process.env.REGISTER_CHECK_MAX, prod ? 40 : 2000),
    loginLockMax: int(process.env.LOGIN_ACCOUNT_LOCK_MAX, prod ? 20 : 200),
    loginLockMinutes: Math.max(1, int(process.env.LOGIN_ACCOUNT_LOCK_MINUTES, 15)),
    reminderHours: Math.max(1, int(process.env.REGISTRATION_REMINDER_HOURS, 48)),
    documentMaxBytes: Math.max(1024, int(process.env.DOCUMENT_MAX_BYTES, 5 * 1024 * 1024)),
    photoMaxBytes: Math.max(1024, int(process.env.PHOTO_MAX_BYTES, 2 * 1024 * 1024)),
  };
}

/* ------------------------------------------------------------------ *
 * small in-memory counters
 *
 * Per process, bounded, sliding window. A single-box deployment (which
 * this is) gets exactly the stated limits; behind several processes each
 * one counts for itself, which is weaker but never stricter than stated.
 * ------------------------------------------------------------------ */
export function windowCounter(windowMs) {
  const hits = new Map();
  const prune = (now) => {
    if (hits.size <= 5000) return;
    for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] >= windowMs) hits.delete(k);
  };
  return {
    /** Records one hit and returns the count inside the window. */
    hit(key) {
      const now = Date.now();
      const fresh = (hits.get(key) || []).filter((t) => now - t < windowMs);
      fresh.push(now);
      hits.set(key, fresh);
      prune(now);
      return fresh.length;
    },
    /** The count inside the window, without recording. */
    count(key) {
      const now = Date.now();
      const fresh = (hits.get(key) || []).filter((t) => now - t < windowMs);
      if (fresh.length) hits.set(key, fresh); else hits.delete(key);
      return fresh.length;
    },
    clear(key) { hits.delete(key); },
    reset() { hits.clear(); },
  };
}

/** The origin a request came from, IPv6 folded to its /64 as auth.js does. */
export function originOf(req) {
  const ip = String((req && req.ip) || 'unknown');
  return ip.includes(':') ? ip.split(':').slice(0, 4).join(':') : ip;
}

/** Last ten digits: "+91 98765 43210" and "09876543210" are one phone. */
export function mobileDigits(v) {
  let d = String(v || '').replace(/\D/g, '');
  if (d.length > 10 && d.startsWith('91')) d = d.slice(2);
  if (d.length > 10 && d.startsWith('0')) d = d.slice(1);
  return d.slice(-10);
}

/** An Indian mobile: ten digits starting 6-9 once the prefix is gone. */
export function validIndianMobile(v) {
  const raw = String(v || '').replace(/\D/g, '');
  const d = mobileDigits(v);
  return d.length === 10 && /^[6-9]/.test(d) && raw.length <= 13;
}
