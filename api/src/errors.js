/**
 * Error handling (requirement 24).
 *
 * Two rules:
 *   1. The UI gets a stable `code` it can switch on, plus a sentence safe
 *      to show a user.
 *   2. Raw database errors NEVER reach the client. A Postgres error carries
 *      table names, column names, constraint names and sometimes the
 *      offending values — a free schema map for an attacker. Those are
 *      logged server-side and replaced with a generic message.
 */

/** Codes the frontend switches on. Each maps to one of the cases in requirement 24. */
export const CODES = {
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  VALIDATION_FAILED:   'VALIDATION_FAILED',
  UNAUTHENTICATED:     'UNAUTHENTICATED',
  SESSION_EXPIRED:     'SESSION_EXPIRED',
  FORBIDDEN:           'FORBIDDEN',
  NOT_FOUND:           'NOT_FOUND',
  DUPLICATE_APPLICATION: 'DUPLICATE_APPLICATION',
  JOB_UNAVAILABLE:     'JOB_UNAVAILABLE',
  EMAIL_TAKEN:         'EMAIL_TAKEN',
  UPLOAD_FAILED:       'UPLOAD_FAILED',
  FILE_TOO_LARGE:      'FILE_TOO_LARGE',
  UNSUPPORTED_FILE:    'UNSUPPORTED_FILE',
  RATE_LIMITED:        'RATE_LIMITED',
  CSRF_FAILED:         'CSRF_FAILED',
  DATABASE_ERROR:      'DATABASE_ERROR',
  SERVER_ERROR:        'SERVER_ERROR',
};

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.expose = true;
  }
}

export const badRequest   = (m, d) => new ApiError(400, CODES.VALIDATION_FAILED, m || 'Please check the highlighted fields and try again.', d);
export const unauthorized = (m)    => new ApiError(401, CODES.UNAUTHENTICATED, m || 'Please sign in to continue.');
export const sessionExpired = ()   => new ApiError(401, CODES.SESSION_EXPIRED, 'Your session has expired — please sign in again.');
export const forbidden    = (m)    => new ApiError(403, CODES.FORBIDDEN, m || 'You do not have access to this.');
export const notFound     = (m)    => new ApiError(404, CODES.NOT_FOUND, m || 'That record could not be found.');
export const conflict     = (code, m) => new ApiError(409, code, m);

/**
 * Turns a Postgres error into something safe and specific.
 *
 * Constraint names are matched deliberately — a unique violation on
 * `applications_candidate_id_job_id_key` means "you already applied", which
 * is a useful message, whereas the raw error would leak the schema.
 */
export function fromPgError(err) {
  const c = err && err.code;
  const constraint = (err && err.constraint) || '';

  // auth_register_candidate raises this WITH errcode unique_violation, so
  // it has to be matched before the generic 23505 handling below.
  if (err && /email_taken/.test(err.message || '')) {
    return conflict(CODES.EMAIL_TAKEN, 'An account with that email already exists.');
  }

  if (c === '23505') {
    if (constraint.includes('applications_candidate_id_job_id'))
      return conflict(CODES.DUPLICATE_APPLICATION, 'You have already applied to this role.');
    if (constraint.includes('applications_one_primary'))
      return conflict(CODES.DUPLICATE_APPLICATION, 'This candidate already has a primary application.');
    if (constraint.includes('users_email') || constraint.includes('email_lower'))
      return conflict(CODES.EMAIL_TAKEN, 'An account with that email already exists.');
    if (constraint.includes('notifications_dedupe'))
      return null; // a duplicate notification is not an error — caller ignores it
    return conflict(CODES.VALIDATION_FAILED, 'That record already exists.');
  }

  // 23503 foreign key, 23514 check constraint
  if (c === '23503') return badRequest('That refers to something which no longer exists.');
  if (c === '23514') return badRequest('That value is not allowed.');

  // 42501 insufficient privilege — RLS refused the write
  if (c === '42501') return forbidden('You do not have permission to change this.');

  return null;
}

/**
 * Express error handler. Must be registered last.
 */
export function errorHandler(logger = console) {
  // eslint-disable-next-line no-unused-vars -- Express needs the 4-arg shape
  return (err, req, res, _next) => {
    let e = err;

    if (!(e instanceof ApiError)) {
      const mapped = fromPgError(err);
      if (mapped) e = mapped;
    }

    if (e instanceof ApiError) {
      if (e.status >= 500) logger.error('[api]', req.method, req.path, e.code, err);
      return res.status(e.status).json({
        error: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) },
      });
    }

    // Anything unmapped is a bug or a database failure. Log the whole
    // thing, tell the user nothing beyond "it failed".
    const ref = Math.random().toString(36).slice(2, 10);
    logger.error(`[api] unhandled ${ref}`, req.method, req.path, err);
    const isDb = err && typeof err.code === 'string' && /^[0-9A-Z]{5}$/.test(err.code);
    return res.status(500).json({
      error: {
        code: isDb ? CODES.DATABASE_ERROR : CODES.SERVER_ERROR,
        message: 'Something went wrong on our side. Please try again.',
        ref,
      },
    });
  };
}

/** Wraps an async route so rejections reach the error handler. */
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
