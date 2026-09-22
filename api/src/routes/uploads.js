/**
 * Resume upload and download (requirements 8, 9, 19).
 *
 * The prototype's Upload Resume -> AI Extraction -> Review flow keeps its
 * UI exactly as it is. What changes underneath: the bytes now go to object
 * storage instead of a base64 string in localStorage, and the candidate
 * record keeps a reference.
 *
 * Requirement 9 matters here — if extraction cannot fill a field, the
 * candidate is still saved with whatever was parsed and the field stays
 * editable. Nothing is discarded because a parse was incomplete.
 */
import { Router } from 'express';
import multer from 'multer';
import { config } from '../config.js';
import { withUser } from '../db.js';
import { wrap, badRequest, notFound, forbidden, ApiError, CODES } from '../errors.js';
import { requireAuth, requireRole } from '../auth.js';
import { storeResume, getStorage, ALLOWED_EXT } from '../storage.js';
import { extractResumeText } from '../resume/extract.js';
import { extractFields, parseConfidence } from '../resume/fields.js';
import { toCandidate } from '../shapes.js';

// Memory storage so the buffer can be inspected BEFORE anything touches
// disk — a file is never written until its magic bytes check out.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes, files: 1, fields: 20 },
});

/**
 * Writes what the parser found onto the candidate - into EMPTY columns only.
 *
 * "Do not make the candidate type in what the resume already says" and
 * "do not overwrite what the candidate told us" are both true, and the
 * only rule that satisfies both is: fill the blanks, never clobber. A
 * candidate who corrected their notice period keeps that correction when
 * they upload a new CV; a candidate who has told us nothing gets the
 * resume's version.
 *
 * Arrays count as empty when they have no entries, which is why a fresh
 * account ends up with its skills rather than "0 skills detected" beside a
 * resume that plainly lists them.
 */
/**
 * "28 LPA" -> 2800000, "12,00,000" -> 1200000, "₹18L" -> 1800000.
 *
 * Returns null when there is no number in it, so a line like
 * "Negotiable" stores nothing rather than a zero that would then be
 * filtered on as if the candidate had asked for it.
 */
function toRupees(raw) {
  const text = String(raw || '').toLowerCase().replace(/[,\s₹]/g, '');
  const m = /(\d+(?:\.\d+)?)/.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (/lpa|lakh|lac|\dl|l$/.test(text)) return Math.round(n * 100000);
  if (/cr|crore/.test(text)) return Math.round(n * 10000000);
  // A bare small number in a salary field means lakhs in this market.
  if (n < 1000) return Math.round(n * 100000);
  return Math.round(n);
}

async function applyExtractedFields(c, candidateId, fields) {
  if (!fields || !Object.keys(fields).length) return 0;

  // extracted key -> column, and how to coerce it
  const MAP = [
    ['title', 'title', 'text'],
    ['currentCompany', 'current_company', 'text'],
    ['previousCompanies', 'previous_companies', 'array'],
    ['location', 'location', 'text'],
    ['preferredLocation', 'preferred_location', 'text'],
    ['noticePeriod', 'notice_period', 'text'],
    ['education', 'education', 'text'],
    ['summary', 'summary', 'text'],
    ['skills', 'skills', 'array'],
    ['certifications', 'certifications', 'array'],
    ['languages', 'languages', 'array'],
    ['linkedin', 'linkedin', 'text'],
    ['github', 'github', 'text'],
    ['expYears', 'exp_years', 'number'],
    ['phone', 'phone', 'text'],
    // Resumes write salary as "28 LPA" or "12,00,000"; the columns are
    // numeric, so the words have to become rupees or nothing is stored.
    ['expectedSalary', 'expected_ctc', 'money'],
    ['currentSalary', 'ctc', 'money'],
  ];

  const current = (await c.query(
    `select ${MAP.map(([, col]) => col).join(', ')}, exp from candidates where id=$1`,
    [candidateId])).rows[0];
  if (!current) return 0;

  const sets = [];
  const vals = [];
  const isEmpty = (v) => v === null || v === undefined ||
    (Array.isArray(v) ? v.length === 0 : String(v).trim() === '');

  for (const [key, col, kind] of MAP) {
    if (fields[key] === undefined) continue;
    if (!isEmpty(current[col])) continue;              // the candidate's own value wins

    let v = fields[key];
    if (kind === 'array') { v = Array.isArray(v) ? v : [v]; if (!v.length) continue; }
    else if (kind === 'number') { v = Number(v); if (!Number.isFinite(v)) continue; }
    else if (kind === 'money') { v = toRupees(v); if (v === null) continue; }
    else { v = String(v).trim(); if (!v) continue; }

    vals.push(v);
    sets.push(`${col}=$${vals.length}`);
  }

  // The display string the prototype reads in a hundred places.
  if (isEmpty(current.exp) && Number.isFinite(Number(fields.expYears))) {
    vals.push(`${Number(fields.expYears)} yrs`);
    sets.push(`exp=$${vals.length}`);
  }

  if (!sets.length) return 0;
  vals.push(candidateId);
  await c.query(`update candidates set ${sets.join(', ')} where id=$${vals.length}`, vals);
  return sets.length;
}

export default function uploadRoutes() {
  const r = Router();

  r.post('/uploads/resume', requireAuth(),
    (req, res, next) => upload.single('resume')(req, res, (err) => {
      if (!err) return next();
      if (err.code === 'LIMIT_FILE_SIZE') {
        const mb = Math.round(config.maxUploadBytes / 1024 / 1024);
        return next(new ApiError(413, CODES.FILE_TOO_LARGE,
          `That file is too large. The limit is ${mb}MB.`));
      }
      return next(new ApiError(400, CODES.UPLOAD_FAILED, 'That file could not be uploaded.'));
    }),
    wrap(async (req, res) => {
      if (!req.file) {
        throw badRequest(`Please choose a file to upload (${ALLOWED_EXT.join(', ').toUpperCase()}).`);
      }

      let candidateId = req.body?.candidateId;
      if (req.session.role === 'candidate') candidateId = req.session.profileId;
      else if (!['recruiter', 'admin'].includes(req.session.role)) {
        throw forbidden('You cannot upload a resume for someone else.');
      }
      if (!candidateId) throw badRequest('No candidate specified.');

      // validates magic bytes, size and extension consistency
      const stored = await storeResume({
        candidateId,
        buffer: req.file.buffer,
        originalName: req.file.originalname,
      });

      /* ---------------------------------------------------------------- *
       * Read the file while we have it.
       *
       * Storing the bytes and leaving the record empty is how a resume
       * ends up on file with "0 skills detected" beside it. The same
       * extractor the registration form uses runs here, so a resume
       * uploaded by any route - the profile page, a recruiter acting for
       * a candidate - produces the same parsed detail.
       *
       * A parse failure does NOT fail the upload: the file is the source
       * document and is worth keeping even when it cannot be read. The
       * reason is recorded against the candidate instead.
       * ---------------------------------------------------------------- */
      let parsed = null;
      let parseError = null;
      try {
        const doc = await extractResumeText(req.file.buffer, req.file.originalname);
        const out = extractFields(doc.text);
        parsed = {
          parser: doc.parser,
          chars: doc.chars,
          fields: out.fields,
          found: out.found,
          confidence: parseConfidence({ fields: out.fields, chars: doc.chars }),
        };
      } catch (err) {
        parseError = err && err.message ? String(err.message).slice(0, 400) : 'could not be read';
      }

      const cand = await withUser(req.session, async (c) => {
        const upd = await c.query(
          `update candidates
              set resume_file=$1, resume_storage_path=$2, resume_mime=$3,
                  resume_size=$4, resume_uploaded_at=now(),
                  resume_parsed_at=$6, resume_parser=$7, resume_chars=$8,
                  resume_fields_detected=$9, resume_parse_confidence=$10,
                  resume_parse_error=$11
            where id=$5 returning *`,
          [stored.displayName, stored.path, stored.mime, stored.size, candidateId,
           parsed ? new Date() : null,
           parsed ? parsed.parser : null,
           parsed ? parsed.chars : null,
           parsed ? parsed.found : null,
           parsed ? parsed.confidence : null,
           parseError]);

        if (parsed) await applyExtractedFields(c, candidateId, parsed.fields);
        if (!upd.rowCount) {
          // the row exists but RLS refused the write, or it is simply gone
          const seen = await c.query(`select 1 from candidates where id=$1`, [candidateId]);
          throw seen.rowCount ? forbidden('You cannot change this profile.')
                              : notFound('That candidate could not be found.');
        }
        const fresh = await c.query(`select * from candidates where id=$1`, [candidateId]);
        return fresh.rows[0] || upd.rows[0];
      });

      res.status(201).json({
        candidate: toCandidate(cand),
        resume: {
          fileName: stored.displayName,
          size: stored.size,
          mime: stored.mime,
          // the UI shows the name; the path stays server-side
        },
        // What the parser managed, so the page can report it rather than
        // asserting a number nothing measured.
        parse: parsed
          ? { ok: true, parser: parsed.parser, chars: parsed.chars,
              fieldsDetected: parsed.found, confidence: parsed.confidence,
              fields: parsed.fields }
          : { ok: false, error: parseError },
      });
    }));

  /**
   * POST /api/candidates/:id/resume/reparse
   *
   * Reads the file ALREADY ON RECORD again.
   *
   * The prototype's "Re-parse with AI" button called reparseResume(),
   * which re-ran its simulated extraction over the profile that was
   * already on screen - so it could never discover anything the profile
   * did not already say. This fetches the stored bytes and runs the real
   * extractor over them, which is what the button claims to do.
   *
   * Useful after the extractor improves, and after a parse that failed.
   */
  r.post('/candidates/:id/resume/reparse', requireAuth(), wrap(async (req, res) => {
    const candidateId = req.session.role === 'candidate'
      ? req.session.profileId
      : req.params.id;
    if (req.session.role === 'candidate' && req.params.id !== req.session.profileId) {
      throw forbidden('You can only re-parse your own resume.');
    }
    if (!['candidate', 'recruiter', 'admin'].includes(req.session.role)) {
      throw forbidden('You cannot re-parse this resume.');
    }

    const row = await withUser(req.session, async (c) => {
      const { rows } = await c.query(
        `select id, resume_file, resume_storage_path from candidates where id=$1`,
        [candidateId]);
      return rows[0];
    });
    if (!row) throw notFound('That candidate could not be found.');
    if (!row.resume_storage_path) throw badRequest('There is no resume on file to re-parse.');

    const buffer = await getStorage().get(row.resume_storage_path);

    let parsed = null;
    let parseError = null;
    try {
      const doc = await extractResumeText(buffer, row.resume_file || '');
      const out = extractFields(doc.text);
      parsed = {
        parser: doc.parser, chars: doc.chars, fields: out.fields, found: out.found,
        confidence: parseConfidence({ fields: out.fields, chars: doc.chars }),
      };
    } catch (err) {
      parseError = err && err.message ? String(err.message).slice(0, 400) : 'could not be read';
    }

    const cand = await withUser(req.session, async (c) => {
      const upd = await c.query(
        `update candidates
            set resume_parsed_at=$1, resume_parser=$2, resume_chars=$3,
                resume_fields_detected=$4, resume_parse_confidence=$5,
                resume_parse_error=$6
          where id=$7 returning *`,
        [parsed ? new Date() : null,
         parsed ? parsed.parser : null,
         parsed ? parsed.chars : null,
         parsed ? parsed.found : null,
         parsed ? parsed.confidence : null,
         parseError, candidateId]);
      if (parsed) await applyExtractedFields(c, candidateId, parsed.fields);
      const again = await c.query(`select * from candidates where id=$1`, [candidateId]);
      return again.rows[0] || upd.rows[0];
    });

    res.json({
      candidate: toCandidate(cand),
      parse: parsed
        ? { ok: true, parser: parsed.parser, chars: parsed.chars,
            fieldsDetected: parsed.found, confidence: parsed.confidence, fields: parsed.fields }
        : { ok: false, error: parseError },
    });
  }));

  /**
   * Issues a short-lived link to a resume, after re-checking access.
   *
   * The permission question is answered by asking the DATABASE for the
   * candidate row: if RLS returns nothing, the caller is not entitled to
   * the file either. That keeps file access and record access from ever
   * drifting apart.
   */
  r.get('/candidates/:id/resume', requireAuth(), wrap(async (req, res) => {
    const row = await withUser(req.session, async (c) => {
      const { rows } = await c.query(
        `select id, resume_file, resume_storage_path, resume_mime
           from candidates where id=$1`, [req.params.id]);
      return rows[0];
    });

    if (!row) throw notFound('That candidate could not be found.');
    if (!row.resume_storage_path) {
      throw notFound('No resume has been uploaded for this candidate.');
    }

    const url = await getStorage().signedUrl(row.resume_storage_path, 120);
    res.json({ url, fileName: row.resume_file, mime: row.resume_mime, expiresInSeconds: 120 });
  }));

  /**
   * Local-driver download route. The signed URL above points here when
   * STORAGE_DRIVER=local; permissions are re-checked, because a URL alone
   * must never be enough to read someone's resume.
   */
  r.get('/files/:key(*)', requireAuth(), wrap(async (req, res) => {
    const key = req.params.key;

    const allowed = await withUser(req.session, async (c) => {
      const { rows } = await c.query(
        `select resume_file, resume_mime from candidates where resume_storage_path=$1`, [key]);
      return rows[0] || null;
    });
    if (!allowed) throw notFound('That file is no longer available.');

    const buf = await getStorage().get(key);
    res.setHeader('content-type', allowed.resume_mime || 'application/octet-stream');
    // `attachment` stops a crafted file rendering inline in the origin
    res.setHeader('content-disposition',
      `attachment; filename="${String(allowed.resume_file || 'resume').replace(/"/g, '')}"`);
    res.setHeader('x-content-type-options', 'nosniff');
    res.send(buf);
  }));

  return r;
}
