/**
 * Express app factory.
 *
 * Kept separate from server.js so tests can mount the app without binding
 * a port.
 */
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';

import { config, originAllowed } from './config.js';
import { errorHandler, ApiError, CODES, wrap } from './errors.js';
import { attachSession, csrfProtection, issueCsrfToken } from './auth.js';

import bootstrapRoutes from './routes/bootstrap.js';
import authRoutes from './routes/auth.js';
import jobRoutes from './routes/jobs.js';
import companyRoutes from './routes/companies.js';
import resumeRoutes from './routes/resume.js';
import candidateRoutes from './routes/candidates.js';
import applicationRoutes from './routes/applications.js';
import miscRoutes from './routes/misc.js';
import uploadRoutes from './routes/uploads.js';
import aiInterviewRoutes from './routes/ai-interviews.js';

export function createApp({ serveStatic = null, logger = console } = {}) {
  const app = express();

  if (config.trustProxy) app.set('trust proxy', 1);
  app.disable('x-powered-by');
  // no ETag on API responses either — see the Cache-Control note below
  app.set('etag', false);

  /**
   * Content-Security-Policy.
   *
   * The prototype is one file with inline <style> and <script> blocks, so
   * 'unsafe-inline' is unavoidable without rewriting it — and rewriting it
   * is exactly what the requirements forbid. Everything else is locked
   * down: no objects, no frames, no base-uri hijacking, and forms can only
   * post back to this origin.
   *
   * This is a deliberate, documented trade-off rather than an oversight.
   * Moving the inline blocks to hashed external files would let us drop
   * 'unsafe-inline' later without touching a single line of the UI.
   */
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // The prototype loads exactly one external script — the EmailJS
        // browser SDK — and blocking it silently breaks email notifications.
        // Allowed explicitly rather than by opening up script-src.
        scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],

        // REQUIRED, and easy to miss.
        //
        // helmet defaults script-src-attr to 'none', which blocks inline
        // event-handler ATTRIBUTES (onclick=, onsubmit=, onchange=)
        // independently of script-src 'unsafe-inline'. The prototype has
        // 1,034 of them, so the default silently killed every button,
        // dropdown and form in the application while the pages still
        // rendered perfectly and logged no console error.
        //
        // Nothing detects this except actually clicking something — which
        // is why test/interaction.test.mjs exists.
        scriptSrcAttr: ["'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'", 'https://api.emailjs.com', ...config.extraOrigins],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  }));

  app.use(cors({
    // originAllowed() lives in config.js because the CSRF guard has to reach
    // the same verdict - see the note there.
    origin(origin, cb) {
      if (originAllowed(origin)) return cb(null, true);
      cb(new ApiError(403, CODES.FORBIDDEN, 'Origin not allowed.'));
    },
    credentials: true,               // the session cookie must travel
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'x-csrf-token'],
  }));

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  app.use(cookieParser());

  app.use('/api', rateLimit({
    windowMs: config.rateLimitWindowMs,
    max: config.rateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, _res, next) => next(new ApiError(
      429, CODES.RATE_LIMITED, 'Too many requests. Please slow down and try again shortly.')),
  }));

  /**
   * API responses are never cached.
   *
   * Express adds an ETag to every res.json() and sends no Cache-Control.
   * A browser applies HEURISTIC freshness to that combination and may
   * serve a stored copy without revalidating — so /api/bootstrap kept
   * returning yesterday's data after a refresh, and the application
   * looked as though it had stopped saving.
   *
   * This is application state, not a static asset. It is always fetched.
   */
  app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    next();
  });

  app.use(attachSession());
  app.use(csrfProtection());

  app.get('/api/health', wrap(async (_req, res) => {
    res.json({ ok: true, env: config.env, time: new Date().toISOString() });
  }));

  // lets a freshly-loaded page obtain a CSRF token before its first write
  app.get('/api/csrf', (req, res) => {
    issueCsrfToken(res);
    res.json({ ok: true });
  });

  app.use('/api', bootstrapRoutes());
  app.use('/api', authRoutes());
  app.use('/api', companyRoutes());
  app.use('/api', resumeRoutes());
  app.use('/api', jobRoutes());
  app.use('/api', candidateRoutes());
  app.use('/api', applicationRoutes());
  app.use('/api', miscRoutes());
  app.use('/api', uploadRoutes());
  app.use('/api', aiInterviewRoutes());

  app.use('/api', (_req, _res, next) =>
    next(new ApiError(404, CODES.NOT_FOUND, 'That endpoint does not exist.')));

  // The prototype is served as a plain static file — unchanged, exactly as
  // supplied. Nothing rewrites or templates it on the way out.
  if (serveStatic) {
    app.use(express.static(serveStatic, {
      index: 'index.html',
      etag: true,
      setHeaders: (res, path) => {
        if (path.endsWith('.html')) res.setHeader('cache-control', 'no-cache');
      },
    }));
  }

  app.use(errorHandler(logger));
  return app;
}
