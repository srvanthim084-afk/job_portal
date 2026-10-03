/**
 * Express app factory.
 *
 * Kept separate from server.js so tests can mount the app without binding
 * a port.
 */
import express from 'express';
import { gzipSync } from 'node:zlib';
import { statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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
import bdeRoutes from './routes/bdes.js';
import candidateRoutes from './routes/candidates.js';
import exportRoutes from './routes/exports.js';
import applicationRoutes from './routes/applications.js';
import miscRoutes from './routes/misc.js';
import uploadRoutes from './routes/uploads.js';
import aiInterviewRoutes from './routes/ai-interviews.js';
import aiCallingRoutes from './routes/ai-calling.js';
import spreadsheetRoutes from './routes/spreadsheet.js';
import placesRoutes from './routes/places.js';
import intakeRoutes from './routes/intake.js';
import { notificationRoutes } from './routes/notifications.js';
import staffRoutes from './routes/staff.js';
import externalJobRoutes from './routes/external-jobs.js';
import savedSearchRoutes from './routes/saved-searches.js';
import pushRoutes from './routes/push.js';
import { startDeadlineSweep } from './notify/interview-deadline.js';
import { startIntakeSync } from './intake/scheduler.js';
import { startScreeningSweep } from './ai/screening.js';
import { startRetrySweep } from './notify/retry.js';
import { startJoiningSweep } from './notify/joining.js';
import { startProfileNudgeSweep } from './notify/profile-nudge.js';
import { startBulkMessageSweep } from './notify/bulk.js';
import { startExternalSyncSweep } from './external/service.js';
import { startApplyReminderSweep } from './external/reminder.js';
import { startSavedSearchAlerts } from './notify/saved-search-alerts.js';

/*
 * The background work belongs to the APPLICATION, not to one entry point.
 *
 * Both schedulers were started in server.js, which the development server
 * does not use - it builds the app itself. So in development the AI
 * interview reminders and the Naukri mailbox sync never ran at all, and
 * "it syncs automatically" was true only in production. Starting them
 * here means every way of running the app gets them.
 *
 * Guarded, because the test suite creates several apps in one process and
 * three mailbox syncs racing each other is not a test of anything.
 */
let backgroundStarted = false;
const backgroundStops = [];

export function stopBackgroundWork() {
  while (backgroundStops.length) {
    const stop = backgroundStops.pop();
    try { stop(); } catch { /* already stopped */ }
  }
  backgroundStarted = false;
}

function startBackgroundWork(logger) {
  if (backgroundStarted) return;
  if (process.env.DISABLE_BACKGROUND_WORK === 'true') {
    logger.log?.('[background] disabled by DISABLE_BACKGROUND_WORK');
    return;
  }
  backgroundStarted = true;
  try {
    backgroundStops.push(startDeadlineSweep());
    backgroundStops.push(startIntakeSync());
    backgroundStops.push(startScreeningSweep());
    backgroundStops.push(startRetrySweep());
    backgroundStops.push(startJoiningSweep());
    backgroundStops.push(startProfileNudgeSweep());
    backgroundStops.push(startBulkMessageSweep());
    backgroundStops.push(startExternalSyncSweep());
    /* One reminder per unanswered external application, ever. The claim
       that makes that true is in the database (0077), not here. */
    backgroundStops.push(startApplyReminderSweep());
    /* Saved-search alerts: instant ones the publish hook missed, and the
       08:00 IST daily / Monday weekly digests. Idempotent per slot. */
    backgroundStops.push(startSavedSearchAlerts());
  } catch (err) {
    console.error('[background] could not start:', err.message);
  }
}

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
    // PATCH is a partial update, which the settings routes take so a
    // screen showing six of thirty fields cannot blank the other
    // twenty-four. Its absence here made those routes unreachable from
    // a browser while answering perfectly to curl.
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'x-csrf-token'],
  }));

  /*
   * COMPRESSION, WHICH WAS NOT HAPPENING AT ALL.
   *
   * Measured before this: index.html went out at 1,937,316 bytes and
   * /api/bootstrap at 467 kB, on every single page load, uncompressed.
   * Both are text that gzips to a fraction of that, and on anything
   * slower than an office line it was the largest cost in the product -
   * larger than every query added together, which measured 22-164ms.
   *
   * NODE'S OWN ZLIB, NOT A PACKAGE. `compression` is small and everybody
   * uses it, and this is thirty lines that cannot be a supply-chain
   * surprise - the same reasoning the xlsx reader in this repo is
   * written out by hand.
   *
   * WHAT IS NOT COMPRESSED: anything already compressed (a .zip of
   * resumes, a .xlsx, a PDF, an image), anything below a kilobyte where
   * the header costs more than it saves, and any response that already
   * set an encoding. Streams are left alone: only res.send() and
   * res.json() are intercepted, which is every route in this app.
   */
  app.use((req, res, next) => {
    const accepts = String(req.headers['accept-encoding'] || '');
    const gzipOk = /\bgzip\b/.test(accepts);
    if (!gzipOk) return next();

    const send = res.send.bind(res);
    res.send = (body) => {
      try {
        if (res.headersSent || res.getHeader('content-encoding')) return send(body);

        const type = String(res.getHeader('content-type') || '');
        /* Text, JSON, JavaScript, CSS, SVG - and nothing that is already
           a compressed container. */
        if (!/^(text\/|application\/(json|javascript|xml)|image\/svg)/i.test(type)) {
          return send(body);
        }

        const buf = Buffer.isBuffer(body) ? body
          : typeof body === 'string' ? Buffer.from(body, 'utf8')
          : null;
        if (!buf || buf.length < 1024) return send(body);

        const out = gzipSync(buf, { level: 6 });
        /* Only if it actually helped. */
        if (out.length >= buf.length) return send(body);

        res.setHeader('content-encoding', 'gzip');
        res.setHeader('content-length', String(out.length));
        /* A cache keyed without this would hand a gzipped body to a
           client that cannot read one. */
        res.setHeader('vary', 'accept-encoding');
        return send(out);
      } catch (err) {
        /* A response that cannot be compressed is still a response. */
        return send(body);
      }
    };
    next();
  });

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
    // `providers` says which notification channels have credentials - the
    // same line the server prints at boot, and no credential appears in it.
    // Without it there is no way to check, from outside, whether a channel
    // reporting "sent" could possibly have sent anything.
    const { providerStatus } = await import('./notify/providers.js');
    res.json({
      ok: true,
      env: config.env,
      time: new Date().toISOString(),
      providers: providerStatus(),
    });
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
  app.use('/api', bdeRoutes());
  app.use('/api', jobRoutes());
  // Before candidateRoutes: /candidates/export must not be read as
  // /candidates/:id, which answers "that candidate could not be found".
  app.use('/api', spreadsheetRoutes());
  app.use('/api', placesRoutes());
  /* Exporting candidates out of the recruiter portal (0084). Ahead of
     candidateRoutes so its literal paths are reached: a parameterised
     route of the same shape registered first would swallow them. */
  app.use('/api', exportRoutes());
  app.use('/api', savedSearchRoutes());
  app.use('/api', pushRoutes());
  app.use('/api', candidateRoutes());
  app.use('/api', applicationRoutes());
  app.use('/api', miscRoutes());
  app.use('/api', uploadRoutes());
  app.use('/api', aiInterviewRoutes());
  app.use('/api', aiCallingRoutes());
  app.use('/api', intakeRoutes());
  app.use('/api', notificationRoutes());
  app.use('/api', staffRoutes());

  /*
   * External jobs — vacancies that belong to somebody else.
   *
   * MOUNTED ONLY WHEN SWITCHED ON. This is the isolation mechanism for
   * the whole feature: with EXTERNAL_JOBS_ENABLED unset, the factory is
   * never called, none of the /api/external/* paths exist, and the route
   * table above is the only route table there is. Nothing else in this
   * file changes, and no existing route is touched by it either way.
   */
  if (config.externalJobs.enabled) {
    app.use('/api', externalJobRoutes());
  }

  // Reminders for interviews running out of time, and the recruiter
  // mailboxes read on a timer.
  startBackgroundWork(logger);

  app.use('/api', (_req, _res, next) =>
    next(new ApiError(404, CODES.NOT_FOUND, 'That endpoint does not exist.')));

  // The prototype is served as a plain static file — unchanged, exactly as
  // supplied. Nothing rewrites or templates it on the way out.
  if (serveStatic) {
    /*
     * THE PAGE ITSELF, GZIPPED.
     *
     * express.static streams the file, so it never reaches res.send()
     * and the compression above did not touch it: index.html went out at
     * 1,937,316 bytes on every load. Measured, not assumed - the API was
     * compressing (478,797 -> 61,993) while the largest thing in the
     * product was not.
     *
     * COMPRESSED ONCE, NOT PER REQUEST. Gzipping two megabytes on every
     * hit would trade bandwidth for CPU. The result is held in memory
     * against the file's size and modified time, so an edit invalidates
     * it and a deploy costs exactly one compression.
     *
     * Only the three text types, and only when the client asked. Anything
     * else - an image, a PDF, a font - falls through to express.static
     * untouched, which is what should happen to a file that is already
     * compressed.
     */
    const gzCache = new Map();
    app.use((req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      if (!/\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) return next();

      let rel = decodeURIComponent(String(req.path || '/'));
      if (rel === '/' || rel.endsWith('/')) rel += 'index.html';
      if (!/\.(html|js|css|svg|json)$/i.test(rel)) return next();
      /* A path that climbs out of the folder is not served from it. */
      if (rel.includes('..')) return next();

      const file = join(serveStatic, rel.replace(/^\/+/, ''));
      let stat;
      try { stat = statSync(file); } catch (e) { return next(); }
      if (!stat.isFile()) return next();

      const key = file + ':' + stat.size + ':' + Number(stat.mtimeMs);
      let hit = gzCache.get(key);
      if (!hit) {
        try {
          hit = gzipSync(readFileSync(file), { level: 6 });
        } catch (e) { return next(); }
        /* One entry per file, so an edited file does not accumulate. */
        for (const k of gzCache.keys()) if (k.startsWith(file + ':')) gzCache.delete(k);
        gzCache.set(key, hit);
      }

      const type = /\.html$/i.test(rel) ? 'text/html; charset=utf-8'
        : /\.js$/i.test(rel) ? 'text/javascript; charset=utf-8'
        : /\.css$/i.test(rel) ? 'text/css; charset=utf-8'
        : /\.svg$/i.test(rel) ? 'image/svg+xml'
        : 'application/json; charset=utf-8';

      res.setHeader('content-type', type);
      res.setHeader('content-encoding', 'gzip');
      res.setHeader('vary', 'accept-encoding');
      res.setHeader('cache-control', 'no-cache');
      /* Weak, because the body is the gzipped form of the file rather
         than the file: a strong tag would claim byte equality with
         whatever an uncompressed request returns. */
      res.setHeader('etag', 'W/"' + stat.size.toString(16) + '-'
        + Math.floor(stat.mtimeMs).toString(16) + '"');

      if (req.headers['if-none-match'] === res.getHeader('etag')) {
        res.status(304).end();
        return undefined;
      }
      res.setHeader('content-length', String(hit.length));
      if (req.method === 'HEAD') { res.end(); return undefined; }
      res.end(hit);
      return undefined;
    });

    app.use(express.static(serveStatic, {
      index: 'index.html',
      etag: true,
      setHeaders: (res, path) => {
        /*
         * THE SCRIPTS BESIDE THE PAGE NEED REVALIDATING TOO.
         *
         * Only .html carried `no-cache`, so index.html was re-fetched on
         * every visit and teamlink-*.js was not: the browser held whatever
         * copy it had. A fix shipped in one of those add-on files could
         * therefore be live on the server and invisible in the browser,
         * and the only way anybody found out was being told to press
         * Ctrl+Shift+R - which is not a deployment strategy.
         *
         * `no-cache` does NOT mean "do not cache". It means "ask first":
         * the browser still keeps the file and still gets a 304 when
         * nothing changed, so this costs one conditional request per file
         * and removes a whole class of "I already fixed that".
         */
        if (/\.(html|js|css)$/i.test(path)) res.setHeader('cache-control', 'no-cache');
      },
    }));

    /*
     * ONE REAL PATH, for the password reset link.
     *
     * The application is hash-routed, so every screen normally lives
     * after a '#'. A reset link cannot be: it is pasted into mail
     * clients, chat windows and phone keyboards, several of which mangle
     * or truncate a fragment, and the fragment is invisible to the
     * server so a mistyped one 404s as the bare origin instead of saying
     * anything useful.
     *
     * So /reset-password is served the application itself and the token
     * is read from the query string on the client.
     *
     * DELIBERATELY NOT A CATCH-ALL. A blanket "serve index.html for
     * anything unmatched" turns every typo and every dead asset into a
     * 200 with an HTML body, which hides missing files from exactly the
     * people who need to see them.
     */
    app.get('/reset-password', (_req, res) => {
      res.setHeader('cache-control', 'no-cache');
      /*
       * The token is in the query string, so this page must never be
       * indexed or its URL passed on in a Referer header.
       */
      res.setHeader('referrer-policy', 'no-referrer');
      res.setHeader('x-robots-tag', 'noindex, nofollow');
      res.sendFile('index.html', { root: serveStatic });
    });
  }

  app.use(errorHandler(logger));
  return app;
}
