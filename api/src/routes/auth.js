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
  startPasswordReset, finishPasswordReset, checkPasswordReset,
  setSessionCookie, clearSessionCookie, issueCsrfToken, requireAuth,
} from '../auth.js';
import { toCandidate, toPerson } from '../shapes.js';

/*
 * AN ADDRESS OR A MOBILE NUMBER.
 *
 * The field was validated as an email, which meant a candidate recorded
 * with a phone and no address - the ordinary case for somebody met at a
 * walk-in - was refused at the form before the server was even asked.
 *
 * The field is still called `email`: it is what the form posts and what
 * every existing caller sends, and renaming it would break them for no
 * gain. What changed is what counts as valid.
 */
const LOGIN_LOOKS_LIKE = (v) => {
  const s = String(v || '').trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return true;
  return s.replace(/\D/g, '').length >= 10;
};

const loginSchema = z.object({
  email: z.string().trim().min(3).max(254)
    .refine(LOGIN_LOOKS_LIKE, 'Enter your email address or mobile number.'),
  password: z.string().min(1, 'Please enter your password.').max(200),
  role: z.enum(['candidate', 'recruiter', 'client', 'admin', 'bde']).optional(),
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

  /*
   * THE FOUR PREFERENCES THE FORM MARKS WITH AN ASTERISK.
   *
   * Checked here as well as on the form, because the form's rules are a
   * convenience and these are the record's. A registration that reaches
   * this route without them is refused, so an account cannot exist
   * without the answers the matcher and the recruiter both read - and a
   * caller that is not the form gets the same treatment as one that is.
   *
   * Each message names its own field, and `parse` below returns them
   * keyed by field, so the form can put each one under the input it
   * belongs to instead of showing one sentence for all four.
   */
  preferredLocation: z.string({ required_error: 'Preferred Job Location is required' })
    .trim().min(1, 'Preferred Job Location is required').max(160),
  expectedCtc: z.coerce.number({
      required_error: 'Expected Salary is required',
      invalid_type_error: 'Expected Salary is required',
    })
    .positive('Expected Salary must be more than 0')
    .max(1000, 'Please enter the salary in lakh per annum'),
  noticePeriod: z.string({ required_error: 'Please select a notice period' })
    .trim().min(1, 'Please select a notice period').max(40),
  preferredWorkModes: z.array(z.string().trim().max(40),
      { required_error: 'Select at least one work mode',
        invalid_type_error: 'Select at least one work mode' })
    .min(1, 'Select at least one work mode').max(10),
  /* 0092: are you looking? Asked on the form; Actively looking when the
     form (or an older client) does not say. */
  availability: z.enum(['actively_looking', 'open_to_offers', 'not_looking']).optional(),
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

  /*
   * Brute-force protection on the credential endpoints specifically -
   * stricter than the global limit (requirement 19).
   *
   * COUNTED PER ACCOUNT, PER ORIGIN.
   *
   * It used to be counted per origin alone, and `skipSuccessfulRequests`
   * was said to mean "a user with a working password is never locked out
   * by someone else hammering the same address". It does not: skipping
   * successes stops a correct sign-in from CONSUMING the allowance, but
   * once the allowance is gone the request is refused before it can
   * succeed at all. Measured - ten wrong guesses from one origin, and
   * then the administrator with the right password was answered 429 from
   * that same origin.
   *
   * That is not a hypothetical. An office, a college or a mobile carrier
   * puts many people behind one address, so one person mistyping their
   * password ten times locked out everybody around them for the rest of
   * the window.
   *
   * Keying on the address being attacked AS WELL AS the origin makes the
   * limit mean what it was always described as meaning: you may guess at
   * one account ten times, and doing so costs nobody else anything.
   */
  const loginKey = (req) => {
    const who = String((req.body && req.body.email) || '').trim().toLowerCase();
    /* IPv6 addresses are handed out a whole prefix at a time, so the
       full address is not a stable identifier; the first four groups
       are. IPv4 is used as it stands. */
    const ip = String(req.ip || 'unknown');
    const origin = ip.includes(':') ? ip.split(':').slice(0, 4).join(':') : ip;
    return `${origin}|${who}`;
  };

  const loginLimiter = rateLimit({
    windowMs: config.rateLimitWindowMs,
    max: config.loginRateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: loginKey,
    /* A correct password does not spend the allowance. */
    skipSuccessfulRequests: true,
    /* The custom key already carries a normalised origin, so the
       library's own IP check has nothing left to warn about. */
    validate: { ip: false },
    handler: (_req, _res, next) => next(new ApiError(
      429, CODES.RATE_LIMITED,
      'Too many sign-in attempts. Please wait a few minutes and try again.')),
  });

  /*
   * And a looser ceiling on the ORIGIN, so the per-account key cannot be
   * sidestepped by walking through a list of addresses ten guesses at a
   * time.
   *
   * THIS ONE DOES CATCH EVERYBODY BEHIND THE CONNECTION, and that is
   * accepted rather than solved: once something has made two hundred
   * failed sign-in attempts in a quarter of an hour, throttling that
   * connection is the right answer even though a colleague is sharing
   * it. The number is set high enough that ordinary use - a busy office
   * where several people are having a bad morning - does not reach it,
   * and low enough that working through a dictionary is not practical.
   *
   * The everyday case, one person mistyping their own password, is
   * handled entirely by the per-account limiter above and costs nobody
   * else anything.
   */
  const loginOriginLimiter = rateLimit({
    windowMs: config.rateLimitWindowMs,
    max: Math.max(100, config.loginRateLimitMax * 20),
    standardHeaders: false,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    handler: (_req, _res, next) => next(new ApiError(
      429, CODES.RATE_LIMITED,
      'Too many sign-in attempts from this connection. Please wait a few minutes.')),
  });

  r.post('/auth/login', loginOriginLimiter, loginLimiter, wrap(async (req, res) => {
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

    // A candidate whose account was created by the importer signs in with
    // a password we generated. The screen has to know to ask them to
    // choose their own, so this is part of the session rather than
    // something the portal has to go and look up.
    const temp = await withUser(session, async (c) => (await c.query(
      `select must_change_password from users where id=$1`, [session.userId])).rows[0]);

    res.json({
      session: {
        role: session.role, id: session.profileId, email: session.email,
        mustChangePassword: !!(temp && temp.must_change_password),
      },
    });
  }));

  r.post('/auth/register', loginOriginLimiter, loginLimiter, wrap(async (req, res) => {
    const { name, email, password, phone,
            preferredLocation, expectedCtc, noticePeriod,
            preferredWorkModes, availability } = parse(registerSchema, req.body);

    // Human-readable ids, matching the prototype's 'cand1' style, so
    // anything that renders an id keeps looking the same.
    const candidateId = 'cand_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    await registerCandidate({ email, password, name, phone, candidateId });

    /*
     * The preferences, onto the record that now exists.
     *
     * The form also sends the rest of the profile in a PUT a moment
     * later, and that PUT may fail for its own reasons; these four were
     * required to get this far, so they are written here rather than
     * left to a second request that might not arrive.
     */
    await withUser(null, (c) => c.query(
      `select auth_register_preferences($1,$2,$3,$4,$5)`,
      [candidateId, preferredLocation, expectedCtc, noticePeriod,
       preferredWorkModes]));
    /* 0092: their availability, onto the same just-created record. */
    await withUser(null, (c) => c.query(`select availability_register($1,$2)`,
      [candidateId, availability || 'actively_looking']));

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
      const table = role === 'recruiter' ? 'recruiters'
                  : role === 'client'    ? 'client_users'
                  : role === 'bde'       ? 'bde_users'
                  : 'admins';
      const { rows } = await c.query(`select * from ${table} where id=$1`, [profileId]);
      return rows[0] ? toPerson(rows[0]) : null;
    });

    issueCsrfToken(res);
    /*
     * The flag travels with EVERY answer about who is signed in, not
     * just with the sign-in itself. A candidate given a temporary
     * password who refreshes the page mid-way must still be asked to
     * choose one; without this the requirement survived exactly until
     * somebody pressed F5.
     */
    const temp = await withUser(req.session, async (c) => (await c.query(
      `select must_change_password from users where id=$1`,
      [req.session.userId])).rows[0]);

    res.json({
      session: {
        role: req.session.role, id: req.session.profileId,
        mustChangePassword: !!(temp && temp.must_change_password),
      },
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

      /*
       * THROUGH THE DEFINER FUNCTION, because the direct UPDATE that
       * used to be here never did anything.
       *
       * `users` carries a SELECT policy and no UPDATE policy, and under
       * row level security an UPDATE matching no policy affects zero
       * rows without raising. So this endpoint answered {"ok":true} and
       * left the old password in place - measured: the new password was
       * then refused at sign-in and the old one still worked. See 0070.
       *
       * The function also ends the account's other sessions, keeping
       * this one, so changing a password does not sign you out of the
       * tab you changed it in.
       */
      const { rows: done } = await c.query(
        `select auth_set_password($1,$2,false,$3) as ok`,
        [req.session.userId, hash, req.session.tokenHash]);

      /* A write that matched nothing must not be reported as success -
         that was the whole defect. */
      if (!done[0] || done[0].ok !== true) {
        throw new ApiError(500, CODES.SERVER_ERROR,
          'The password could not be changed. Please try again.');
      }
    });

    res.json({ ok: true });
  }));

  /* ------------------------------------------------------------------ *
   * forgotten passwords
   *
   * Until now the whole of auth was login, register, logout, me, and a
   * password change that required you to be signed in already - so a
   * forgotten password was the end of the account. Nobody could help
   * either: there was no endpoint that issued a reset.
   * ------------------------------------------------------------------ */

  /*
   * FIVE PER HOUR, per address AND per origin address.
   *
   * Counted here rather than with express-rate-limit, for two reasons.
   *
   * The first is that this has to key on the EMAIL as well as the IP. A
   * limiter keyed only on IP lets one sender walk through a list of
   * addresses; keyed only on email it lets one address be attacked from
   * anywhere. The expensive, abusable thing is "a mail arrives in
   * somebody's inbox", and that is a fact about the pair.
   *
   * The second is that loginLimiter's ceiling is a DEVELOPMENT one on
   * this deployment - tools/dev-server.mjs raises LOGIN_RATE_LIMIT_MAX
   * to 1000 so the verification scripts can hammer sign-in - and a cap
   * on "how many emails may be sent to a stranger's inbox" should not
   * quietly inherit whatever number made the test suite convenient.
   * Five an hour is stated here and means five an hour.
   */
  const RESET_WINDOW_MS = 60 * 60 * 1000;
  const RESET_MAX = 5;
  const resetHits = new Map();

  const tooMany = (key) => {
    const now = Date.now();
    const fresh = (resetHits.get(key) || []).filter((t) => now - t < RESET_WINDOW_MS);
    fresh.push(now);
    resetHits.set(key, fresh);

    /* Bounded: a long-running process must not accumulate a key per
       address anybody ever typed. */
    if (resetHits.size > 5000) {
      for (const [k, v] of resetHits) {
        if (!v.length || now - v[v.length - 1] >= RESET_WINDOW_MS) resetHits.delete(k);
      }
    }
    return fresh.length > RESET_MAX;
  };

  /*
   * ALWAYS THE SAME ANSWER.
   *
   * Whether the address is known, unknown, or belongs to a suspended
   * account, this replies identically. Anything else turns the form into
   * a way of asking "does this person have an account here", which for a
   * recruitment database is a question about who is looking for work.
   */
  r.post('/auth/forgot', wrap(async (req, res) => {
    const { email } = parse(z.object({
      email: z.string().trim().min(3).max(254).email('Please enter a valid email address.'),
    }), req.body);

    const SAME_ANSWER = {
      ok: true,
      message: "If an account exists for this email, we've sent a password reset link.",
    };

    /* Both counters are spent on every attempt, so neither can be
       sidestepped by varying the other. */
    const byAddress = tooMany('em:' + email.toLowerCase());
    const byOrigin = tooMany('ip:' + (req.ip || 'unknown'));
    if (byAddress || byOrigin) {
      throw new ApiError(429, CODES.RATE_LIMITED,
        'Too many reset requests. Please wait an hour and try again.');
    }

    let issued = null;
    try {
      issued = await startPasswordReset({ email, ip: req.ip });
    } catch (err) {
      // A failure here must not tell the browser more than a success does.
      console.error('[auth] could not start a password reset:', err.message);
      return res.json(SAME_ANSWER);
    }
    if (!issued) return res.json(SAME_ANSWER);

    const base = String(config.publicOrigin || '').replace(/\/$/, '');
    const link = `${base}/reset-password?token=${encodeURIComponent(issued.token)}`;
    const greeting = issued.name ? `Hi ${issued.name},` : 'Hi,';
    const safe = (s) => String(s).replace(/[&<>"]/g,
      (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

    try {
      const { emailProvider } = await import('../notify/providers.js');
      const sent = await emailProvider.send({
        to: issued.email,
        subject: 'Reset your TeamLink password',
        text: [
          greeting,
          '',
          'We received a request to reset the password on your TeamLink account.',
          'Open this link to choose a new one:',
          '',
          link,
          '',
          `This link can be used once and expires in ${issued.minutes} minutes.`,
          '',
          "If you didn't request this, ignore this email - your password has",
          'not been changed.',
        ].join('\n'),
        html: [
          '<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:15px;color:#1f2933">',
          `<p>${safe(greeting)}</p>`,
          '<p>We received a request to reset the password on your TeamLink account.</p>',
          `<p style="margin:26px 0"><a href="${safe(link)}" `,
          'style="background:#2a4bc0;color:#ffffff;text-decoration:none;padding:12px 22px;',
          'border-radius:8px;display:inline-block;font-weight:600">Reset password</a></p>',
          `<p style="color:#52606d">This link can be used once and expires in ${issued.minutes} minutes.</p>`,
          '<p style="color:#52606d">If you didn&#39;t request this, ignore this email &mdash; ',
          'your password has not been changed.</p>',
          '</div>',
        ].join(''),
      });

      /*
       * The LINK is never logged, here or anywhere: it is a bearer
       * credential, and a log line is a place it outlives the inbox.
       * Only whether the send worked, and for which provider.
       */
      if (sent && sent.status && sent.status !== 'sent' && sent.status !== 'delivered') {
        console.error('[auth] reset mail not delivered:', sent.status, sent.error || '');
      }
    } catch (err) {
      console.error('[auth] reset mail failed:', err.message);
    }

    res.json(SAME_ANSWER);
  }));

  /*
   * Is this link still good?
   *
   * A POST, not a GET with the token in the path, because a token in a
   * URL lands in access logs, proxy logs and browser history - three
   * places a live credential should not outlive the inbox it came from.
   */
  r.post('/auth/reset/check', wrap(async (req, res) => {
    const { token } = parse(z.object({
      token: z.string().trim().min(10).max(400),
    }), req.body);
    res.json({ valid: await checkPasswordReset(token) });
  }));

  /*
   * Spending the token.
   *
   * The new password must clear the same bar as a registered one - eight
   * characters, a letter and a digit - because a reset is not a back door
   * to a weaker password than the sign-up form would have accepted.
   */
  r.post('/auth/reset', wrap(async (req, res) => {
    const { token, password } = parse(z.object({
      token: z.string().trim().min(10).max(400),
      password: z.string()
        .min(8, 'Password must be at least 8 characters.')
        .max(200)
        .refine((p) => /[A-Za-z]/.test(p) && /\d/.test(p),
          'Password must contain at least one letter and one number.'),
    }), req.body);

    const userId = await finishPasswordReset({ token, password });
    if (!userId) {
      throw new ApiError(400, CODES.VALIDATION_FAILED,
        'That reset link is no longer valid. Please request a new one.');
    }

    /*
     * NOT SIGNED IN AUTOMATICALLY. Every session was destroyed by the
     * reset - that is the point of it - and signing them in here would
     * quietly re-create one from a link that may have been forwarded.
     * They type the new password once, which also proves they have it.
     */
    res.json({ ok: true, message: 'Your password has been changed. Please sign in.' });
  }));

  return r;
}
