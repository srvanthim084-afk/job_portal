/**
 * Resume text extraction and field parsing.
 *
 * POST /api/resume/extract   multipart file  -> { text, fields, ... }
 * POST /api/resume/parse     { text }        -> { fields, ... }
 *
 * BOTH ARE OPEN TO SIGNED-OUT CALLERS, deliberately: the resume upload on
 * the registration screen happens before the candidate has an account.
 * That is also why they are rate-limited harder than the rest of the API
 * and why nothing here is stored. Extraction returns text; saving a file
 * to a candidate is a separate, authenticated call to /uploads/resume.
 */
import { Router } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { config } from '../config.js';
import { wrap, badRequest, ApiError, CODES } from '../errors.js';
import { extractResumeText, sanitize } from '../resume/extract.js';
import { extractFields } from '../resume/fields.js';
import { parseWithAi, aiStatus } from '../resume/ai.js';

// In memory. The bytes are inspected and discarded; nothing is written to
// disk on this path, so an unauthenticated caller cannot fill the volume.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes, files: 1, fields: 5 },
});

const limiter = rateLimit({
  windowMs: 60_000,
  max: Number(process.env.RESUME_RATE_LIMIT_MAX || 20),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, _res, next) => next(new ApiError(429, CODES.RATE_LIMITED,
    'Too many resume uploads. Please wait a minute and try again.')),
});

export default function resumeRoutes() {
  const r = Router();

  r.get('/resume/extractor', (_req, res) => {
    res.json({ formats: ['pdf', 'docx', 'doc', 'txt'], ai: aiStatus() });
  });

  r.post('/resume/extract', limiter,
    (req, res, next) => upload.single('resume')(req, res, (err) => {
      if (!err) return next();
      if (err.code === 'LIMIT_FILE_SIZE') {
        const mb = Math.round(config.maxUploadBytes / 1024 / 1024);
        return next(new ApiError(413, CODES.FILE_TOO_LARGE,
          `That file is too large. The limit is ${mb}MB.`));
      }
      return next(new ApiError(400, CODES.UPLOAD_FAILED,
        'That file could not be uploaded. Please try again.'));
    }),
    wrap(async (req, res) => {
      if (!req.file) throw badRequest('Please choose a resume file to upload.');

      // Throws with a code naming the actual failure - the wrong file type,
      // a PDF with no text layer, a DOCX that will not open. The UI shows a
      // different message for each.
      const doc = await extractResumeText(req.file.buffer, req.file.originalname);

      const result = await parseResume(doc.text);

      res.json({
        text: doc.text,
        kind: doc.kind,
        parser: doc.parser,
        pages: doc.pages,
        chars: doc.chars,
        fileName: req.file.originalname,
        ...result,
      });
    }));

  /** The paste-your-resume-text path, and a retry after a failed parse. */
  r.post('/resume/parse', limiter, wrap(async (req, res) => {
    const body = z.object({ text: z.string().min(1).max(200_000) }).safeParse(req.body || {});
    if (!body.success) throw badRequest('Please paste your resume text first.');

    const text = sanitize(body.data.text);
    if (text.length < 40) {
      throw new ApiError(422, 'RESUME_NO_TEXT',
        'That is too short to read as a resume. Please paste the full text.');
    }
    res.json({ text, chars: text.length, ...(await parseResume(text)) });
  }));

  return r;
}

/**
 * Fields, from the model when one is configured and from the deterministic
 * parser otherwise.
 *
 * `source` is reported to the caller and shown in the status line, because
 * "AI analysed your resume" when no model was involved is exactly the kind
 * of claim this codebase does not make.
 */
async function parseResume(text) {
  const local = extractFields(text);

  const ai = await parseWithAi(text).catch((err) => ({ error: err.message }));

  if (ai && ai.fields && Object.keys(ai.fields).length) {
    // The model's output is merged OVER the deterministic result, so a field
    // the parser found is kept when the model missed it.
    const merged = { ...local.fields, ...ai.fields };
    return {
      fields: merged,
      found: Object.keys(merged).length,
      source: 'ai',
      aiError: null,
    };
  }

  return {
    fields: local.fields,
    found: local.found,
    source: 'parser',
    // Surfaced rather than hidden: if a key IS configured and the call
    // failed, the candidate's fields still arrive, and the operator can see
    // why the model did not contribute.
    aiError: ai?.error || null,
  };
}
