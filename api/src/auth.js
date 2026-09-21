/**
 * Authentication.
 *
 * Replaces the prototype's two defects (DATA-MAPPING §6):
 *   - ROLE_CREDENTIALS held Recruiter@123 / Client@123 / Admin@123 in
 *     shipped JavaScript
 *   - submitLogin() signed anyone in as cand1 with no password at all
 *
 * Design notes:
 *   - Passwords: bcrypt, cost from BCRYPT_ROUNDS (default 12).
 *   - Sessions: a 256-bit random token in an httpOnly cookie. Only the
 *     SHA-256 of the token is stored, so a database leak does not hand
 *     anyone a set of usable sessions.
 *   - Login is constant-work: an unknown email still runs a bcrypt compare
 *     against a dummy hash, so response timing does not reveal which
 *     addresses are registered.
 */
import bcrypt from 'bcryptjs';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { config, originAllowed } from './config.js';
import { withUser } from './db.js';
import { unauthorized, sessionExpired, forbidden, CODES, ApiError } from './errors.js';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// Compared against when no user matches, purely to equalise timing.
const DUMMY_HASH = '$2a$12$0000000000000000000000000000000000000000000000000000';

export const hashPassword = (plain) => bcrypt.hash(plain, config.bcryptRounds);

export function newSessionToken() {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: sha256(token) };
}

/**
 * Verifies credentials and issues a session.
 * Runs unauthenticated (session = null) — the SECURITY DEFINER functions
 * are what let it reach `users` at all.
 */
export async function login({ email, password, userAgent, ip }) {
  return withUser(null, async (c) => {
    const { rows } = await c.query(
      `select * from auth_find_user($1)`, [String(email || '').trim()]
    );
    const user = rows[0];

    // Always spend the bcrypt time, even for an unknown address.
    const ok = await bcrypt.compare(
      String(password || ''),
      user ? user.password_hash : DUMMY_HASH
    );

    if (!user || !ok) {
      throw new ApiError(401, CODES.INVALID_CREDENTIALS, 'Incorrect email or password.');
    }
    if (user.status !== 'active') {
      throw forbidden('This account is not active. Please contact an administrator.');
    }

    const { token, hash } = newSessionToken();
    const expires = new Date(Date.now() + config.sessionDays * 86_400_000);
    await c.query(`select auth_create_session($1,$2,$3,$4,$5)`,
      [user.id, hash, expires, userAgent || null, ip || null]);

    const who = await c.query(`select * from auth_resolve_session($1)`, [hash]);
    const profile = who.rows[0];

    return {
      token,
      expires,
      session: {
        userId: user.id,
        role: user.role,
        profileId: profile ? profile.profile_id : null,
        email: user.email,
      },
    };
  });
}

export async function registerCandidate({ email, password, name, phone, candidateId }) {
  const hash = await hashPassword(password);
  return withUser(null, async (c) => {
    const { rows } = await c.query(
      `select auth_register_candidate($1,$2,$3,$4,$5) as id`,
      [String(email).trim(), hash, candidateId, name, phone || null]
    );
    return rows[0].id;
  });
}

export async function resolveSession(token) {
  if (!token) return null;
  const hash = sha256(token);
  return withUser(null, async (c) => {
    const { rows } = await c.query(`select * from auth_resolve_session($1)`, [hash]);
    if (!rows.length) return null;
    const r = rows[0];
    return { userId: r.user_id, role: r.role, profileId: r.profile_id, tokenHash: hash };
  });
}

export async function logout(token) {
  if (!token) return;
  await withUser(null, (c) => c.query(`select auth_destroy_session($1)`, [sha256(token)]));
}

export function setSessionCookie(res, token, expires) {
  res.cookie(config.sessionCookie, token, {
    httpOnly: true,                 // unreadable from JavaScript → XSS cannot steal it
    secure: config.isProd,
    sameSite: 'lax',                // blocks cross-site POSTs while keeping normal links working
    domain: config.cookieDomain,
    expires,
    path: '/',
  });
}

export function clearSessionCookie(res) {
  res.clearCookie(config.sessionCookie, {
    httpOnly: true, secure: config.isProd, sameSite: 'lax',
    domain: config.cookieDomain, path: '/',
  });
}

/* ------------------------------------------------------------------ *
 * Middleware
 * ------------------------------------------------------------------ */

/** Attaches req.session when a valid cookie is present. Never rejects. */
export function attachSession() {
  return async (req, _res, next) => {
    try {
      const token = req.cookies ? req.cookies[config.sessionCookie] : null;
      req.sessionToken = token || null;
      req.session = token ? await resolveSession(token) : null;
      next();
    } catch (err) { next(err); }
  };
}

/** Requires any signed-in user. */
export function requireAuth() {
  return (req, _res, next) => {
    if (!req.session) {
      // Distinguishing these two lets the UI show "session expired" rather
      // than a generic failure, which is what requirement 24 asks for.
      return next(req.sessionToken ? sessionExpired() : unauthorized());
    }
    next();
  };
}

/**
 * Requires one of `roles`.
 *
 * This is a fast rejection, NOT the security boundary — the policies in
 * 0002_rls.sql are. If this check were deleted the data would still be
 * safe; it exists to return a clean 403 instead of an empty result set.
 */
export function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.session) return next(unauthorized());
    if (!roles.includes(req.session.role)) return next(forbidden());
    next();
  };
}

/* ------------------------------------------------------------------ *
 * CSRF
 * ------------------------------------------------------------------ */

/**
 * Double-submit CSRF protection for cookie-authenticated writes.
 *
 * SameSite=Lax already blocks the common cross-site POST, but it is a
 * single point of failure and older browsers ignore it. The client reads
 * the non-httpOnly `tl_csrf` cookie and echoes it in `X-CSRF-Token`; an
 * attacker's page can cause the cookie to be SENT but cannot READ it to
 * populate the header.
 */
export const CSRF_COOKIE = 'tl_csrf';
export const CSRF_HEADER = 'x-csrf-token';

export function issueCsrfToken(res) {
  const token = randomBytes(24).toString('base64url');
  res.cookie(CSRF_COOKIE, token, {
    httpOnly: false,                // the client must be able to read it
    secure: config.isProd,
    sameSite: 'lax',
    domain: config.cookieDomain,
    path: '/',
  });
  return token;
}

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

export function csrfProtection() {
  return (req, _res, next) => {
    if (SAFE.has(req.method)) return next();
    if (!req.session) return next();   // nothing to ride on without a session

    const cookie = req.cookies ? req.cookies[CSRF_COOKIE] : null;
    const header = req.get(CSRF_HEADER);
    if (!cookie || !header || cookie.length !== header.length) {
      return next(new ApiError(403, CODES.CSRF_FAILED, 'Your session could not be verified. Please refresh and try again.'));
    }
    let same = false;
    try { same = timingSafeEqual(Buffer.from(cookie), Buffer.from(header)); } catch { same = false; }
    if (!same) {
      return next(new ApiError(403, CODES.CSRF_FAILED, 'Your session could not be verified. Please refresh and try again.'));
    }

    // Belt and braces: reject an unexpected Origin outright. Same verdict as
    // the CORS layer, from the same function, so the two cannot disagree.
    if (!originAllowed(req.get('origin'))) {
      return next(new ApiError(403, CODES.CSRF_FAILED, 'Request blocked: unrecognised origin.'));
    }
    next();
  };
}
