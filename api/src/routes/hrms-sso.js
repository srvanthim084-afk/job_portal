/**
 * Single sign-on from TeamLink HRMS - the routes (api/src/sso/hrms.js has
 * the token rules, docs/HRMS-SSO.md the contract).
 *
 *   GET  /api/auth/hrms-sso/status   what the browser needs: is SSO on, the
 *                                    HRMS address, is THIS session from HRMS
 *   POST /api/auth/hrms-sso          { token } -> a portal session (cookie)
 *   POST /api/auth/hrms-sso/logout   HRMS -> portal, server to server:
 *                                    { token } signed for the back channel,
 *                                    ends every portal session of that HRMS
 *                                    session
 *   POST /api/auth/logout            (a hook in front of the existing route)
 *                                    a session from HRMS logs HRMS out too,
 *                                    then the ordinary logout runs
 *
 * The token is never logged, never put in a URL by this server, and never
 * echoed back. Every refusal of the token itself has the same wording, so a
 * caller learns nothing about which check failed.
 */
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { withUser } from '../db.js';
import { wrap, ApiError } from '../errors.js';
import {
  newSessionToken, setSessionCookie, issueCsrfToken, resolveSession, logout as destroySession,
} from '../auth.js';
import {
  ssoConfig, verifyLaunchToken, verifyBackchannel, ROLE_MAP, SsoError, endBySid, notifyHrmsLogout,
} from '../sso/hrms.js';

export const EXPIRED_MESSAGE = 'Session expired. Please open the Job Portal from HRMS again.';
const SESSION_HOURS = 8;   // the absolute cap; the shared 30-minute idle rule ends it sooner

const HOME = { recruiter: '#/recruiter/home', admin: '#/admin/users' };

/** Only a page of the portal this role may open; anything else is home. */
export function safeNext(next, role) {
  const s = String(next || '').trim();
  const ok = /^#\/(recruiter|admin)(\/[A-Za-z0-9_\-/]*)?(\?[A-Za-z0-9_\-=&%.+]*)?$/.test(s);
  if (!ok || s.split('/')[1] !== role) return HOME[role] || '#/';
  return s;
}

const denied = (message) => new ApiError(403, 'SSO_ACCESS_DENIED', message);
const tokenRefused = (code) => new ApiError(401, code, EXPIRED_MESSAGE);

export default function hrmsSsoRoutes() {
  const r = Router();

  const limiter = rateLimit({
    windowMs: 60_000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, _res, next) => next(new ApiError(429, 'RATE_LIMITED', 'Too many attempts. Please wait a minute.')),
  });

  r.get('/auth/hrms-sso/status', (req, res) => {
    const cfg = ssoConfig();
    res.set('cache-control', 'no-store');
    res.json({
      enabled: cfg.enabled && !!cfg.hrmsUrl,
      hrmsUrl: cfg.enabled ? cfg.hrmsUrl || null : null,
      staffRedirect: cfg.enabled && !!cfg.hrmsUrl && cfg.staffRedirect,
      idleMinutes: Math.round(cfg.idleMs / 60_000),
      viaHrms: !!(req.session && req.session.hrmsSid),
      ended: !!req.hrmsSessionEnded,
    });
  });

  r.post('/auth/hrms-sso', limiter, wrap(async (req, res) => {
    const cfg = ssoConfig();
    if (!cfg.enabled) throw new ApiError(503, 'SSO_DISABLED', 'Opening the Job Portal from HRMS is not set up on this server.');

    let t;
    try {
      t = verifyLaunchToken(req.body && req.body.token, cfg);
    } catch (err) {
      if (err instanceof SsoError) throw tokenRefused(err.code === 'TOKEN_EXPIRED' ? 'SSO_TOKEN_EXPIRED' : 'SSO_TOKEN_INVALID');
      throw err;
    }

    // Single use, before anything else is decided: a replayed token is
    // refused even if the first use was itself refused for access.
    const fresh = await withUser(null, async (c) => (await c.query(
      `select hrms_sso_consume_jti($1,$2) as ok`, [t.jti, new Date(t.exp * 1000)])).rows[0].ok);
    if (!fresh) throw tokenRefused('SSO_TOKEN_INVALID');

    const role = ROLE_MAP[t.hrmsRole];
    if (!role) throw denied('Your HRMS role does not include access to the Job Portal.');

    const account = await withUser(null, async (c) => (await c.query(
      `select * from hrms_sso_find_account($1)`, [t.email])).rows[0]);
    if (!account) {
      throw denied('There is no Job Portal account for your email address yet. Ask a Job Portal administrator to create one.');
    }
    // Never more than the account already is: an HRMS admin whose email is a
    // recruiter login here signs in as that recruiter only if HRMS says
    // recruiter, and an email that belongs to a candidate is not staff at all.
    if (account.role !== role) {
      throw denied(`Your Job Portal account is not a ${role} account, so it cannot be opened from HRMS.`);
    }
    if (account.status !== 'active') throw denied('Your Job Portal account is not active. Please contact an administrator.');

    const next = safeNext(req.body && req.body.next, role);

    // Already signed in here as the same person, from the same HRMS session:
    // keep that session. No second session, no second audit row.
    if (req.session && req.session.userId === account.user_id && req.session.hrmsSid === t.sid) {
      return res.json({ ok: true, role, next, reused: true });
    }
    // Signed in here as somebody else (or with a password): that session ends.
    if (req.sessionToken) await destroySession(req.sessionToken);

    const { token, hash } = newSessionToken();
    const expires = new Date(Date.now() + SESSION_HOURS * 3_600_000);
    await withUser(null, async (c) => {
      await c.query(`select auth_create_session($1,$2,$3,$4,$5)`,
        [account.user_id, hash, expires, req.get('user-agent') || null, req.ip || null]);
      await c.query(`select hrms_sso_mark_session($1,$2)`, [hash, t.sid]);
    });

    const session = await resolveSession(token);
    if (!session) throw denied('Your Job Portal account could not be opened. Please contact an administrator.');

    // "Login (via HRMS)" once per HRMS session, written AS the user so the
    // audit log's User column is them.
    await withUser(session, async (c) => {
      const first = (await c.query(`select hrms_sso_first_login($1,$2) as f`, [t.sid, account.user_id])).rows[0].f;
      if (first) {
        await c.query(`select audit_write('LOGIN_VIA_HRMS','user',$1,$2::jsonb)`, [account.user_id,
          JSON.stringify({ via: 'hrms', role, hrmsRole: t.hrmsRole, name: t.name || null })]);
      }
    });

    setSessionCookie(res, token, expires);
    issueCsrfToken(res, expires);
    return res.json({ ok: true, role, next });
  }));

  /* HRMS logged out (or its session timed out). Server to server. */
  r.post('/auth/hrms-sso/logout', limiter, wrap(async (req, res) => {
    let claims;
    try { claims = verifyBackchannel(req.body && req.body.token); } catch {
      throw new ApiError(401, 'SSO_TOKEN_INVALID', 'Not a valid HRMS request.');
    }
    const sid = typeof claims.sid === 'string' ? claims.sid.slice(0, 128) : '';
    if (!sid) throw new ApiError(400, 'VALIDATION_FAILED', 'No session given.');
    const ended = await endBySid(sid);
    res.json({ ok: true, ended });
  }));

  /* In front of the existing POST /auth/logout: ends the HRMS side first. */
  r.post('/auth/logout', wrap(async (req, _res, next) => {
    if (req.session && req.session.hrmsSid) await notifyHrmsLogout(req.session.hrmsSid);
    next();
  }));

  return r;
}
