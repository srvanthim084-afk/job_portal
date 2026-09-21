/**
 * Authentication routes.
 *
 * These are wired to the prototype's EXISTING login form. `submitLogin()`
 * keeps its signature and its markup; only its body changes, from a
 * comparison against the hardcoded ROLE_CREDENTIALS object to a call here.
 */
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { config } from '../config.js';
import { withUser } from '../db.js';
import { wrap, badRequest, ApiError, CODES } from '../errors.js';
import {
  login, logout, registerCandidate,
  setSessionCookie, clearSessionCookie, issueCsrfToken, requireAuth,
} from '../auth.js';
import { toCandidate, toPerson } from '../shapes.js';

const loginSchema = z.object({
  email: z.string().trim().min(3).max(254).email('Please enter a valid email address.'),
  password: z.string().min(1, 'Please enter your password.').max(200),
  role: z.enum(['candidate', 'recruiter', 'client', 'admin']).optional(),
});

const registerSchema = z.object({
  name: z.string().trim().min(2, 'Please enter your name.').max(120),
  email: z.string().trim().max(254).email('Please enter a valid email address.'),
  password: z.string()
    .min(8, 'Password must be at least 8 characters.')
    .max(200)
    .refine((p) => /[A-Za-z]/.test(p) && /\d/.test(p),
      'Password must contain at least one letter and one number.'),
  phone: z.string().trim().max(32).optional().or(z.literal('')),
});

const parse = (schema, body) => {
  const out = schema.safeParse(body || {});
  if (!out.success) {
    const details = {};
    for (const i of out.error.issues) details[i.path.join('.') || 'form'] = i.message;
    throw badRequest('Please check the highlighted fields and try again.', details);
  }
  return out.data;
};

export default function authRoutes() {
  const r = Router();

  // Brute-force protection on the credential endpoints specifically —
  // stricter than the global limit (requirement 19).
  const loginLimiter = rateLimit({
    windowMs: config.rateLimitWindowMs,
    max: config.loginRateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
    // Counting only failures means a user with a working password is never
    // locked out by someone else hammering the same address.
    skipSuccessfulRequests: true,
    handler: (_req, _res, next) => next(new ApiError(
      429, CODES.RATE_LIMITED,
      'Too many sign-in attempts. Please wait a few minutes and try again.')),
  });

  r.post('/auth/login', loginLimiter, wrap(async (req, res) => {
    const { email, password, role } = parse(loginSchema, req.body);

    const { token, expires, session } = await login({
      email, password,
      userAgent: req.get('user-agent'),
      ip: req.ip,
    });

    // The prototype has a separate login screen per role. If someone signs
    // in from the recruiter screen with candidate credentials, say so
    // plainly rather than dropping them somewhere unexpected.
    if (role && session.role !== role) {
      await logout(token);
      throw new ApiError(403, CODES.FORBIDDEN,
        `Those credentials are for the ${session.role} portal.`);
    }

    setSessionCookie(res, token, expires);
    issueCsrfToken(res);

    res.json({ session: { role: session.role, id: session.profileId, email: session.email } });
  }));

  r.post('/auth/register', loginLimiter, wrap(async (req, res) => {
    const { name, email, password, phone } = parse(registerSchema, req.body);

    // Human-readable ids, matching the prototype's 'cand1' style, so
    // anything that renders an id keeps looking the same.
    const candidateId = 'cand_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    await registerCandidate({ email, password, name, phone, candidateId });

    const { token, expires, session } = await login({
      email, password, userAgent: req.get('user-agent'), ip: req.ip,
    });
    setSessionCookie(res, token, expires);
    issueCsrfToken(res);

    res.status(201).json({
      session: { role: session.role, id: session.profileId, email: session.email },
      candidateId,
    });
  }));

  r.post('/auth/logout', wrap(async (req, res) => {
    await logout(req.sessionToken);
    clearSessionCookie(res);
    res.json({ ok: true });
  }));

  /** Who am I — used on boot to restore a session across a refresh. */
  r.get('/auth/me', wrap(async (req, res) => {
    if (!req.session) return res.json({ session: null });

    const profile = await withUser(req.session, async (c) => {
      const { role, profileId } = req.session;
      if (!profileId) return null;
      if (role === 'candidate') {
        const { rows } = await c.query(`select * from candidates where id=$1`, [profileId]);
        return rows[0] ? toCandidate(rows[0]) : null;
      }
      const table = role === 'recruiter' ? 'recruiters' : role === 'client' ? 'client_users' : 'admins';
      const { rows } = await c.query(`select * from ${table} where id=$1`, [profileId]);
      return rows[0] ? toPerson(rows[0]) : null;
    });

    issueCsrfToken(res);
    res.json({
      session: { role: req.session.role, id: req.session.profileId },
      profile,
    });
  }));

  /** Lets a signed-in user change their own password (recruiter settings screen). */
  r.post('/auth/password', requireAuth(), wrap(async (req, res) => {
    const schema = z.object({
      current: z.string().min(1, 'Please enter your current password.'),
      next: z.string().min(8, 'New password must be at least 8 characters.').max(200),
    });
    const { current, next } = parse(schema, req.body);

    const bcrypt = (await import('bcryptjs')).default;
    await withUser(req.session, async (c) => {
      const { rows } = await c.query(`select password_hash from users where id=$1`, [req.session.userId]);
      if (!rows.length) throw new ApiError(401, CODES.UNAUTHENTICATED, 'Please sign in again.');
      const ok = await bcrypt.compare(current, rows[0].password_hash);
      if (!ok) throw new ApiError(400, CODES.VALIDATION_FAILED, 'Current password is incorrect.');
      const hash = await bcrypt.hash(next, config.bcryptRounds);
      await c.query(`update users set password_hash=$1 where id=$2`, [hash, req.session.userId]);
      // every other session for this user is invalidated
      await c.query(`delete from sessions where user_id=$1 and token_hash <> $2`,
        [req.session.userId, req.session.tokenHash]);
    });

    res.json({ ok: true });
  }));

  return r;
}
