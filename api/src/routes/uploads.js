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
import { toCandidate } from '../shapes.js';

// Memory storage so the buffer can be inspected BEFORE anything touches
// disk — a file is never written until its magic bytes check out.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes, files: 1, fields: 20 },
});

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

      const cand = await withUser(req.session, async (c) => {
        const upd = await c.query(
          `update candidates
              set resume_file=$1, resume_storage_path=$2, resume_mime=$3,
                  resume_size=$4, resume_uploaded_at=now()
            where id=$5 returning *`,
          [stored.displayName, stored.path, stored.mime, stored.size, candidateId]);
        if (!upd.rowCount) {
          // the row exists but RLS refused the write, or it is simply gone
          const seen = await c.query(`select 1 from candidates where id=$1`, [candidateId]);
          throw seen.rowCount ? forbidden('You cannot change this profile.')
                              : notFound('That candidate could not be found.');
        }
        return upd.rows[0];
      });

      res.status(201).json({
        candidate: toCandidate(cand),
        resume: {
          fileName: stored.displayName,
          size: stored.size,
          mime: stored.mime,
          // the UI shows the name; the path stays server-side
        },
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
