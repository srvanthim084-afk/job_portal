/**
 * Single sign-on from TeamLink HRMS (TeamLink.Enterprise) - the portal side.
 *
 * A recruiter or admin signed in to HRMS clicks "Job Portal" there. The HRMS
 * backend signs a short token and sends the browser to
 *
 *     <portal>/hrms-sso.html#token=<jwt>&next=<#/recruiter/...>
 *
 * The fragment never reaches a server or a Referer header. That page strips it
 * with history.replaceState at once and POSTs the token to /api/auth/hrms-sso,
 * which is verifyLaunchToken() below:
 *
 *   alg   HS256 only (the header is checked, "none" and RS* are refused)
 *   key   HRMS_SSO_SECRET - the same value on both servers, never in a URL,
 *         never logged, never committed
 *   iss   "teamlink-hrms"        aud "teamlink-job-portal"
 *   exp   at most 60 s after iat (plus 30 s clock skew), and not expired
 *   jti   single use: recorded in hrms_sso_tokens, a replay is refused
 *   sub, email, name, role (the HRMS role code), sid (the HRMS session id)
 *
 * The HRMS role is mapped to a portal role (ROLE_MAP). The portal account is
 * the one with the SAME EMAIL and that role; nothing is created - see
 * docs/HRMS-SSO.md for why.
 *
 * ONE SESSION, TWO APPS. The portal session carries the HRMS session id
 * (sessions.hrms_sid). hrmsSessionGate() runs on every request after
 * attachSession(): at most once a minute (and always once the local clock
 * says the session is idle) it asks HRMS, server to server, whether that
 * session is still alive and tells it when the user was last active here.
 * HRMS answers from the one shared 30-minute inactivity timer; a "no" ends
 * the portal session. HRMS logging out calls /api/auth/hrms-sso/logout here
 * (endBySid) and the portal logging out calls HRMS the same way
 * (notifyHrmsLogout), so either logout ends both.
 *
 * RECRUITER TIME IN PORTAL (0125, when present): the login goes through
 * portal_session_start(token, 'hrms', 'auth.login_hrms') - that writes the
 * one "Login (via HRMS)" row and opens the portal session - and an HRMS
 * session that ends here closes it (hrms_sso_end_sid / hrms_sso_expire).
 * Without 0125 the route writes 'auth.login_hrms' itself.
 *
 * Polling must not count as activity: the browser sends `x-tl-idle-ms`
 * (milliseconds since the user last touched the page) on its API calls, and
 * activity is "now - idle", not "now". A request without it counts as
 * activity, which is what it used to be.
 */
import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { withUser } from '../db.js';

export const ISS = 'teamlink-hrms';
export const AUD = 'teamlink-job-portal';
export const AUD_BACKCHANNEL_IN = 'teamlink-job-portal-backchannel';  // HRMS -> portal
export const AUD_BACKCHANNEL_OUT = 'teamlink-hrms-backchannel';       // portal -> HRMS
const MAX_LIFETIME_S = 60;
const SKEW_S = 30;

/** HRMS role code -> portal role. Anything else has no Job Portal access. */
export const ROLE_MAP = Object.freeze({
  SUPER_ADMIN: 'admin',
  ADMIN: 'admin',
  RECRUITER: 'recruiter',
});

const trimSlash = (s) => String(s || '').trim().replace(/\/+$/, '');
const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v || '').trim());

export function ssoConfig() {
  const secret = process.env.HRMS_SSO_SECRET || '';
  return {
    secret,
    // A short secret is as good as none: refuse to run on one.
    enabled: secret.length >= 32,
    // Where the browser goes back to (the HRMS web app).
    hrmsUrl: trimSlash(process.env.HRMS_URL || ''),
    // Where this server reaches the HRMS API. In the embedded set-up the
    // host already sets TEAMLINK_API_URL to the HRMS backend.
    hrmsApiUrl: trimSlash(process.env.HRMS_API_URL || process.env.TEAMLINK_API_URL || ''),
    idleMs: Math.max(1, parseInt(process.env.HRMS_SSO_IDLE_MINUTES, 10) || 30) * 60_000,
    checkMs: Math.max(5, parseInt(process.env.HRMS_SSO_CHECK_SECONDS, 10) || 60) * 1000,
    // A signed-out visit to a recruiter/admin page goes to the HRMS login.
    staffRedirect: process.env.HRMS_SSO_STAFF_REDIRECT === undefined
      ? true : truthy(process.env.HRMS_SSO_STAFF_REDIRECT),
  };
}

/* ------------------------------------------------------------------ *
 * HS256, by hand: the portal has no JWT library and needs only this.
 * ------------------------------------------------------------------ */

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const hmac = (secret, data) => createHmac('sha256', secret).update(data).digest();

export function signHs256(payload, secret) {
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  return `${head}.${body}.${b64url(hmac(secret, `${head}.${body}`))}`;
}

export class SsoError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/**
 * Verifies signature, algorithm, issuer, audience and time. Returns the
 * claims. Throws SsoError('TOKEN_INVALID' | 'TOKEN_EXPIRED').
 */
export function verifyHs256(token, secret, { aud, iss = ISS, maxLifetimeS = MAX_LIFETIME_S, now = Date.now() } = {}) {
  const bad = (m) => new SsoError('TOKEN_INVALID', m);
  if (!secret) throw bad('not configured');
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) throw bad('malformed');
  let head; let claims;
  try {
    head = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch { throw bad('malformed'); }
  if (!head || head.alg !== 'HS256') throw bad('algorithm');
  const want = hmac(secret, `${parts[0]}.${parts[1]}`);
  const got = Buffer.from(parts[2], 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) throw bad('signature');
  if (!claims || typeof claims !== 'object') throw bad('claims');
  if (claims.iss !== iss) throw bad('issuer');
  const audOk = Array.isArray(claims.aud) ? claims.aud.includes(aud) : claims.aud === aud;
  if (!audOk) throw bad('audience');
  const t = Math.floor(now / 1000);
  if (!Number.isFinite(claims.exp) || !Number.isFinite(claims.iat)) throw bad('times');
  if (claims.iat > t + SKEW_S) throw bad('issued in the future');
  if (claims.exp - claims.iat > maxLifetimeS) throw bad('lifetime');
  if (claims.exp + SKEW_S <= t) throw new SsoError('TOKEN_EXPIRED', 'expired');
  return claims;
}

/** The launch token from HRMS, checked and shaped. jti is NOT consumed here. */
export function verifyLaunchToken(token, cfg = ssoConfig(), now = Date.now()) {
  const c = verifyHs256(token, cfg.secret, { aud: AUD, now });
  const str = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : '');
  const out = {
    jti: str(c.jti, 128),
    sid: str(c.sid, 128),
    hrmsUserId: str(String(c.sub == null ? '' : c.sub), 128),
    email: str(c.email, 254).toLowerCase(),
    name: str(c.name, 160),
    hrmsRole: str(c.role, 40).toUpperCase(),
    exp: c.exp,
  };
  if (!out.jti || !out.sid || !out.email || !out.hrmsRole) throw new SsoError('TOKEN_INVALID', 'missing claims');
  return out;
}

/* ------------------------------------------------------------------ *
 * Server to server (back channel)
 * ------------------------------------------------------------------ */

function backchannelToken(cfg, claims) {
  const iat = Math.floor(Date.now() / 1000);
  return signHs256({
    iss: 'teamlink-job-portal', aud: AUD_BACKCHANNEL_OUT, iat, exp: iat + 60, jti: randomUUID(), ...claims,
  }, cfg.secret);
}

/** Verifies a call FROM HRMS (logout). */
export function verifyBackchannel(token, cfg = ssoConfig()) {
  return verifyHs256(token, cfg.secret, { aud: AUD_BACKCHANNEL_IN });
}

async function callHrms(cfg, path, claims, timeoutMs = 3000) {
  if (!cfg.enabled || !cfg.hrmsApiUrl) return { reachable: false };
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`${cfg.hrmsApiUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: backchannelToken(cfg, claims) }),
      signal: ctl.signal,
    });
    if (!r.ok) return { reachable: r.status < 500, status: r.status, body: null };
    return { reachable: true, status: r.status, body: await r.json().catch(() => null) };
  } catch {
    return { reachable: false };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Asks HRMS whether its session is alive, passing the last activity seen
 * here. { active: true, lastSeenAt } | { active: false } | { reachable: false }
 */
export async function checkHrmsSession(sid, lastActiveAt, cfg = ssoConfig()) {
  const r = await callHrms(cfg, '/api/sso/job-portal/session',
    { sid, lastActiveAt: lastActiveAt ? new Date(lastActiveAt).toISOString() : null });
  if (!r.reachable) return { reachable: false };
  if (!r.body || r.status >= 400) return { reachable: true, active: false };
  return { reachable: true, active: r.body.active === true, lastSeenAt: r.body.lastSeenAt || null };
}

/** The portal logged out: end the HRMS session too. Never throws. */
export async function notifyHrmsLogout(sid, cfg = ssoConfig()) {
  try { return (await callHrms(cfg, '/api/sso/job-portal/logout', { sid })).reachable; } catch { return false; }
}

/** HRMS logged out: end every portal session opened from that HRMS session. */
export async function endBySid(sid) {
  return withUser(null, async (c) =>
    (await c.query(`select hrms_sso_end_sid($1) as n`, [sid])).rows[0].n);
}

/* ------------------------------------------------------------------ *
 * The session gate
 * ------------------------------------------------------------------ */

/* Sessions known NOT to come from HRMS. A session never changes kind, so a
   hash seen once as a password session needs no second look. Bounded. */
const nonSso = new Set();
function rememberNonSso(hash) {
  if (nonSso.size > 20_000) nonSso.clear();
  nonSso.add(hash);
}
export function _resetGateCache() { nonSso.clear(); }

/** When the user last touched the page, from the x-tl-idle-ms header. */
export function activityAt(req, now = Date.now()) {
  const raw = req.get ? req.get('x-tl-idle-ms') : null;
  if (raw == null || raw === '') return now;
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms < 0) return now;
  return now - Math.min(ms, 7 * 86_400_000);
}

/**
 * Runs after attachSession(). For a session opened from HRMS, enforces the
 * shared inactivity timeout and HRMS logout; leaves every other session
 * alone. On expiry req.session becomes null, so requireAuth() answers
 * SESSION_EXPIRED exactly as for an expired cookie.
 */
export function hrmsSessionGate() {
  return async (req, _res, next) => {
    try {
      const s = req.session;
      // API calls only: the page's own files say nothing about activity.
      if (!String(req.path || '').startsWith('/api/')) return next();
      if (!s || !s.tokenHash || nonSso.has(s.tokenHash)) return next();
      const row = await withUser(null, async (c) =>
        (await c.query(`select * from hrms_sso_session_state($1)`, [s.tokenHash])).rows[0]);
      if (!row) { rememberNonSso(s.tokenHash); return next(); }

      const cfg = ssoConfig();
      const now = Date.now();
      const stored = row.hrms_active_at ? new Date(row.hrms_active_at).getTime() : 0;
      let seen = stored;
      const checked = row.hrms_checked_at ? new Date(row.hrms_checked_at).getTime() : 0;
      let didCheck = false;

      // Ask HRMS once a minute, and always before calling a session idle:
      // the user may have been busy in HRMS the whole time.
      if (now - checked >= cfg.checkMs || now - seen > cfg.idleMs) {
        const h = await checkHrmsSession(row.hrms_sid, seen || null, cfg);
        if (h.reachable && !h.active) return expire(req, s, next, seen);
        if (h.reachable && h.active) {
          didCheck = true;
          const hs = h.lastSeenAt ? new Date(h.lastSeenAt).getTime() : 0;
          if (hs > seen) seen = Math.min(hs, now);
        }
        // HRMS unreachable: fall back on this server's own clock.
      }
      if (now - seen > cfg.idleMs) return expire(req, s, next, seen);

      const act = activityAt(req, now);
      const newSeen = Math.max(seen, act);
      if (didCheck || newSeen - stored > 15_000) {
        await withUser(null, (c) => c.query(`select hrms_sso_touch($1,$2,$3)`,
          [s.tokenHash, new Date(newSeen), didCheck]));
      }
      s.hrmsSid = row.hrms_sid;
      return next();
    } catch (err) { return next(err); }
  };
}

async function expire(req, s, next, lastActive) {
  // Dated at the last real activity, so 0125's time in portal is right.
  await withUser(null, (c) => c.query(`select hrms_sso_expire($1,$2)`,
    [s.tokenHash, lastActive ? new Date(lastActive) : null]));
  req.session = null;
  req.hrmsSessionEnded = true;
  return next();
}
