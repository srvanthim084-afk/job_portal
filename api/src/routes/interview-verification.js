/**
 * The photo verification before an AI interview (0149).
 *
 *   POST /api/ai-interviews/verification/start               begin (or carry on with) the verification for an application
 *   POST /api/ai-interviews/verification/photo               multipart: the photo (replaces an unconfirmed one)
 *   GET  /api/ai-interviews/verification/:id/photo           the photo: the candidate's own, or an authorised recruiter / admin
 *   POST /api/ai-interviews/verification/:id/confirm         "this photo is fine"
 *   POST /api/ai-interviews/verification/:id/consent         instructions understood + consent to the stated processing
 *   POST /api/ai-interviews/verification/:id/camera-help     "my camera does not work": tells the recruiter, shows the support contact
 *   POST /api/ai-interviews/verification/waive               recruiter / admin: waive the photo for one application
 *   GET  /api/ai-interviews/verification/by-application/:id  the verification record(s) of an application
 *
 * Every state change is made by a SECURITY DEFINER function that checks the row is the caller's; the
 * route only validates input and translates. Nothing here starts an interview: POST /ai-interviews/session
 * is the one place that does, and it will not without a READY verification (see that route).
 */
import { Router } from 'express';
import { z } from 'zod';
import multer from 'multer';
import { withUser } from '../db.js';
import { wrap, badRequest, notFound, forbidden, ApiError, CODES } from '../errors.js';
import { requireAuth, requireRole } from '../auth.js';
import { newId } from '../ai/interview-lifecycle.js';
import { BLUEPRINT_TOTAL } from '../ai/interview.js';
import { questionSeconds, formatWhen } from '../interview/policy.js';
import {
  verificationEnabled, verificationNotice, verificationInstructions, CAMERA_REQUIREMENTS, NOTICE_VERSION,
  photoMaxBytes, imageRetentionDays, verificationMinutes, storeVerificationPhoto, readVerificationPhoto,
} from '../interview/verification.js';
import { getStorage } from '../storage.js';

const ENGINE_SESSION = { userId: '', role: 'admin', profileId: null };

const PHOTO_ROLES = ['candidate', 'recruiter', 'admin'];      // who may OPEN a photo (RLS narrows it further)

const photoUpload = () => multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: photoMaxBytes(), files: 1, fields: 6 },
});

const parse = (schema, body) => {
  const out = schema.safeParse(body || {});
  if (!out.success) {
    const details = {};
    for (const i of out.error.issues) details[i.path.join('.') || 'form'] = i.message;
    throw badRequest('That request could not be understood.', details);
  }
  return out.data;
};

/** A database function refusing a step becomes a plain 409, never a stack trace. */
function refused(err) {
  const m = String((err && err.message) || '');
  const known = [
    /that application is not yours/, /no such verification/, /this verification is closed/, /the photo was waived/,
    /capture a photo first/, /the instructions must be acknowledged/, /confirm your photo first/, /the consent is required/,
    /a reason is required/, /no such application/,
  ];
  if (known.some((re) => re.test(m))) {
    if (/no such verification|not yours|no such application/.test(m)) return notFound('That verification could not be found.');
    return new ApiError(409, 'VERIFICATION_STEP_REFUSED', m.charAt(0).toUpperCase() + m.slice(1) + '.');
  }
  return err;
}

const stepOf = (v) => {
  if (v.status === 'ready' || v.status === 'used') return 'ready';
  if (v.method === 'staff_waiver') return 'instructions';
  if (v.status === 'photo_confirmed') return 'instructions';
  if (v.status === 'photo_captured') return 'review';
  return 'capture';
};

/** What the screen needs about a verification. Never the storage key. */
function shape(v, { role = 'candidate' } = {}) {
  const hasPhoto = !!v.image_path;
  return {
    id: v.id, applicationId: v.application_id, interviewId: v.interview_id || null,
    method: v.method, status: v.status, step: stepOf(v),
    hasPhoto, photoDeleted: !!v.image_deleted_at,
    photoUrl: hasPhoto && PHOTO_ROLES.includes(role) ? `/api/ai-interviews/verification/${encodeURIComponent(v.id)}/photo` : null,
    capturedAt: v.captured_at || null, photoConfirmedAt: v.image_confirmed_at || null,
    instructionsAcknowledgedAt: v.instructions_ack_at || null,
    consentGiven: !!v.consent_given, consentAt: v.consent_at || null, noticeVersion: v.notice_version || null,
    verifiedAt: v.verified_at || null, sessionStartedAt: v.session_started_at || null,
    retentionUntil: hasPhoto ? v.retention_until || null : null,
    cameraHelpRequestedAt: v.camera_help_at || null,
    waivedAt: v.waived_at || null, waiveReason: v.waive_reason || null,
    createdAt: v.created_at,
  };
}

function candidateOnly(req) {
  if (req.session.role !== 'candidate') throw forbidden('Only a candidate can verify before an interview.');
}

export default function interviewVerificationRoutes() {
  const r = Router();

  /**
   * POST /api/ai-interviews/verification/start { applicationId }
   *
   * Begins the verification for this application, or carries on with the unfinished one. Also the
   * screen's source of truth: the job, the interview's length, the notice and the instructions - all
   * from the server, so the text a candidate consents to is the text stored under NOTICE_VERSION.
   * It refuses what the interview itself would refuse (finished, with a recruiter, too soon after a
   * suspension, closed) so nobody takes a photo for an interview they cannot start.
   */
  r.post('/ai-interviews/verification/start', requireAuth(), wrap(async (req, res) => {
    candidateOnly(req);
    const b = parse(z.object({ applicationId: z.string().trim().min(1).max(64) }), req.body);
    if (!verificationEnabled()) return res.json({ required: false, disabled: true });

    const out = await withUser(req.session, async (c) => {
      const app = (await c.query(`select id, job_id from applications where id=$1 and candidate_id=$2`,
        [b.applicationId, req.session.profileId])).rows[0];
      if (!app) throw badRequest('You have no such application to interview for.');

      await c.query(`select ai_interview_expire_overdue()`);
      const last = (await c.query(
        `select id, status, attempt_number, retake_available_at, retake_blocked,
                (retake_available_at is not null and now() >= retake_available_at) as retake_open
           from ai_interviews where application_id=$1 and candidate_id=$2 order by attempt_number desc limit 1`,
        [app.id, req.session.profileId])).rows[0];
      if (last && ['completed', 'evaluating', 'evaluated'].includes(last.status)) {
        throw new ApiError(409, 'INTERVIEW_ALREADY_COMPLETED', 'You have already completed this interview. Thank you.');
      }
      if (last && ['in_progress', 'warning_issued'].includes(last.status)) {
        return { resume: true };                       // an interview under way carries on; nothing to verify
      }
      if (last && last.status === 'suspended') {
        if (last.retake_blocked || !last.retake_available_at) {
          throw new ApiError(423, 'INTERVIEW_UNDER_REVIEW', 'Your interview is under recruiter review. You will be informed of the next steps.');
        }
        if (!last.retake_open) {
          throw new ApiError(423, 'INTERVIEW_RETAKE_WAIT',
            `You can retake this interview after ${formatWhen(new Date(last.retake_available_at))}.`,
            { retakeAvailableAt: new Date(last.retake_available_at).toISOString() });
        }
      }
      const win = (await c.query(`select * from ai_interview_window($1)`, [app.id])).rows[0];
      if (win && !win.open) {
        throw new ApiError(410, 'INTERVIEW_CLOSED', 'This interview is no longer open.', { reason: win.reason });
      }

      const v = (await c.query(`select * from ai_verification_begin($1,$2,$3,$4)`,
        [newId('aivf'), req.session.profileId, app.id, verificationMinutes()])).rows[0];
      const job = (await c.query(`select title from jobs where id=$1`, [app.job_id])).rows[0];
      const cand = (await c.query(`select name from candidates where id=$1`, [req.session.profileId])).rows[0];
      return { v, job, cand };
    }).catch((e) => { throw refused(e); });

    if (out.resume) return res.json({ required: false, resume: true });

    const qs = questionSeconds();
    res.json({
      required: true,
      verification: shape(out.v),
      job: { title: out.job ? out.job.title : '' },
      candidate: { name: out.cand ? out.cand.name : '' },
      interview: {
        questions: BLUEPRINT_TOTAL, questionSeconds: qs,
        approxMinutes: Math.max(5, Math.round(BLUEPRINT_TOTAL * (qs + 25) / 60)),
      },
      cameraRequirements: CAMERA_REQUIREMENTS,
      instructions: verificationInstructions(),
      notice: verificationNotice(),
      photo: { maxBytes: photoMaxBytes(), retentionDays: imageRetentionDays() },
    });
  }));

  /** POST /api/ai-interviews/verification/photo — multipart: verificationId, photo */
  r.post('/ai-interviews/verification/photo', requireAuth(),
    (req, res, next) => {
      if (req.session.role !== 'candidate') return next(forbidden('Only a candidate can verify before an interview.'));
      return photoUpload().single('photo')(req, res, (err) => {
        if (!err) return next();
        if (err.code === 'LIMIT_FILE_SIZE') {
          return next(new ApiError(413, CODES.FILE_TOO_LARGE,
            `That photo is too large. The limit is ${Math.round(photoMaxBytes() / 1024 / 1024 * 10) / 10}MB.`));
        }
        return next(new ApiError(400, CODES.UPLOAD_FAILED, 'That photo could not be uploaded.'));
      });
    },
    wrap(async (req, res) => {
      if (!verificationEnabled()) throw badRequest('Photo verification is not switched on.');
      if (!req.file) throw badRequest('No photo was attached.');
      const id = String(req.body?.verificationId || '').trim();
      if (!id) throw badRequest('Which verification is this photo for?');

      // Whose verification, and is it still open - under the caller's own rights, BEFORE a byte is stored.
      const v = await withUser(req.session, async (c) => (await c.query(
        `select id, status, method from ai_interview_verifications where id=$1 and candidate_id=$2`,
        [id, req.session.profileId])).rows[0]);
      if (!v) throw notFound('That verification could not be found.');
      if (!['pending', 'photo_captured', 'photo_confirmed', 'ready'].includes(v.status)) {
        throw new ApiError(409, 'VERIFICATION_STEP_REFUSED', 'This verification is closed. Please start again.');
      }

      const stored = await storeVerificationPhoto({
        candidateId: req.session.profileId, verificationId: v.id, buffer: req.file.buffer });
      let old = null;
      try {
        old = await withUser(req.session, async (c) => (await c.query(
          `select ai_verification_photo($1,$2,$3,$4,$5,$6,$7) as old`,
          [v.id, req.session.profileId, stored.path, stored.mime, stored.size, stored.sha256, imageRetentionDays()])).rows[0].old);
      } catch (err) {
        await getStorage().remove(stored.path).catch(() => {});        // never leave an orphan
        throw refused(err);
      }
      if (old && old !== stored.path) await getStorage().remove(old).catch(() => {});

      const row = await withUser(req.session, async (c) => (await c.query(
        `select * from ai_interview_verifications where id=$1`, [v.id])).rows[0]);
      res.status(201).json({ verification: shape(row) });
    }));

  /** POST /api/ai-interviews/verification/:id/confirm */
  r.post('/ai-interviews/verification/:id/confirm', requireAuth(), wrap(async (req, res) => {
    candidateOnly(req);
    const v = await withUser(req.session, async (c) => (await c.query(
      `select * from ai_verification_confirm($1,$2)`, [req.params.id, req.session.profileId])).rows[0])
      .catch((e) => { throw refused(e); });
    res.json({ verification: shape(v) });
  }));

  /** POST /api/ai-interviews/verification/:id/consent { instructionsAcknowledged, consent, noticeVersion } */
  r.post('/ai-interviews/verification/:id/consent', requireAuth(), wrap(async (req, res) => {
    candidateOnly(req);
    const b = parse(z.object({
      instructionsAcknowledged: z.boolean(),
      consent: z.boolean(),
      noticeVersion: z.string().trim().min(1).max(40),
    }), req.body);
    if (b.noticeVersion !== NOTICE_VERSION) {
      throw new ApiError(409, 'NOTICE_CHANGED', 'The privacy notice was updated. Please read it again before you continue.');
    }
    const v = await withUser(req.session, async (c) => (await c.query(
      `select * from ai_verification_consent($1,$2,$3,$4,$5)`,
      [req.params.id, req.session.profileId, b.noticeVersion, b.instructionsAcknowledged, b.consent])).rows[0])
      .catch((e) => { throw refused(e); });
    res.json({ verification: shape(v) });
  }));

  /**
   * POST /api/ai-interviews/verification/:id/camera-help { note }
   * The candidate cannot use a camera. The recruiter who owns the application is told, and the screen
   * shows the support contact. The recruiter (or an admin) can then waive the photo.
   */
  r.post('/ai-interviews/verification/:id/camera-help', requireAuth(), wrap(async (req, res) => {
    candidateOnly(req);
    const b = parse(z.object({ note: z.string().trim().max(300).optional() }), req.body);
    const info = await withUser(req.session, async (c) => {
      await c.query(`select ai_verification_camera_help($1,$2,$3)`, [req.params.id, req.session.profileId, b.note || null]);
      return (await c.query(
        `select v.application_id, v.job_id, v.candidate_id, a.recruiter_id as app_recruiter, j.recruiter_id as job_recruiter,
                j.title, c.name
           from ai_interview_verifications v
           join applications a on a.id = v.application_id
           left join jobs j on j.id = v.job_id
           left join candidates c on c.id = v.candidate_id
          where v.id = $1`, [req.params.id])).rows[0];
    }).catch((e) => { throw refused(e); });

    const recruiterId = info && (info.app_recruiter || info.job_recruiter);
    if (recruiterId) {
      await withUser(ENGINE_SESSION, (c) => c.query(
        `select notify_create($1,$2,'recruiter','INTERVIEW_CAMERA_HELP',$3,$4,$5,$6,$7,$8,$9::jsonb)`,
        [`ntf_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, recruiterId,
         `${info.name} cannot use a camera for the AI interview`,
         `${info.name} asked for help with the camera before the AI interview for ${info.title}.`
           + (b.note ? ` They wrote: ${b.note}` : '') + ' You can waive the photo for this application if you are satisfied.',
         info.job_id, info.application_id, info.candidate_id, recruiterId,
         JSON.stringify({ verificationId: req.params.id })])).catch(() => {});
    }
    const notice = verificationNotice();
    res.json({ received: true, supportEmail: notice.supportEmail, contact: notice.contact });
  }));

  /**
   * POST /api/ai-interviews/verification/waive { applicationId, reason }
   * A recruiter or admin who can see the application waives the photo (camera unavailable). Audited with
   * the person and the reason; the candidate still acknowledges the instructions.
   */
  r.post('/ai-interviews/verification/waive', requireAuth(), requireRole('recruiter', 'admin'), wrap(async (req, res) => {
    const b = parse(z.object({
      applicationId: z.string().trim().min(1).max(64),
      reason: z.string().trim().min(3).max(300),
    }), req.body);
    const seen = await withUser(req.session, async (c) => (await c.query(
      `select id from applications where id=$1`, [b.applicationId])).rows[0]);
    if (!seen) throw notFound('That application could not be found.');
    const v = await withUser(ENGINE_SESSION, async (c) => (await c.query(
      `select * from ai_verification_waive($1,$2,$3,$4,$5,$6)`,
      [newId('aivf'), b.applicationId, req.session.userId || null, req.session.role, b.reason, verificationMinutes()])).rows[0])
      .catch((e) => { throw refused(e); });
    res.status(201).json({ verification: shape(v, { role: req.session.role }) });
  }));

  /** GET /api/ai-interviews/verification/by-interview/:interviewId — the record the interview was started from */
  r.get('/ai-interviews/verification/by-interview/:interviewId', requireAuth(), wrap(async (req, res) => {
    const rows = await withUser(req.session, async (c) => (await c.query(
      `select * from ai_interview_verifications where interview_id=$1 order by created_at desc limit 5`,
      [req.params.interviewId])).rows);
    res.json({ verifications: rows.map((v) => shape(v, { role: req.session.role })) });
  }));

  /**
   * GET /api/ai-interviews/verification/help-requests — candidates who said they cannot use a camera and
   * are still waiting (recruiter / admin; only their own applications, by RLS)
   */
  r.get('/ai-interviews/verification/help-requests', requireAuth(), requireRole('recruiter', 'admin'), wrap(async (req, res) => {
    const rows = await withUser(req.session, async (c) => (await c.query(
      `select v.id, v.application_id, v.camera_help_at, v.camera_help_note, c.name as candidate_name, j.title as job_title
         from ai_interview_verifications v
         join applications a on a.id = v.application_id
         left join candidates c on c.id = v.candidate_id
         left join jobs j on j.id = v.job_id
        where v.camera_help_at is not null and v.method = 'photo'
          and v.status in ('pending', 'photo_captured', 'photo_confirmed', 'ready')
          and not exists (select 1 from ai_interview_verifications w
                           where w.application_id = v.application_id and w.method = 'staff_waiver'
                             and w.status in ('pending', 'ready', 'used'))
        order by v.camera_help_at desc limit 50`)).rows);
    res.json({ requests: rows.map((x) => ({
      verificationId: x.id, applicationId: x.application_id, candidateName: x.candidate_name, jobTitle: x.job_title,
      requestedAt: x.camera_help_at, note: x.camera_help_note || null,
    })) });
  }));

  /** GET /api/ai-interviews/verification/by-application/:applicationId — the record(s), newest first */
  r.get('/ai-interviews/verification/by-application/:applicationId', requireAuth(), wrap(async (req, res) => {
    const rows = await withUser(req.session, async (c) => (await c.query(
      `select * from ai_interview_verifications where application_id=$1 order by created_at desc limit 20`,
      [req.params.applicationId])).rows);
    res.json({ verifications: rows.map((v) => shape(v, { role: req.session.role })) });
  }));

  /**
   * GET /api/ai-interviews/verification/:id/photo
   *
   * The candidate's own photo, or an authorised recruiter / admin (RLS decides whose). Never a public
   * link: it needs the session, is not cached, and every STAFF view is written to the audit log.
   */
  r.get('/ai-interviews/verification/:id/photo', requireAuth(), wrap(async (req, res) => {
    if (!PHOTO_ROLES.includes(req.session.role)) throw forbidden('You do not have access to interview photos.');
    const v = await withUser(req.session, async (c) => (await c.query(
      `select id, candidate_id, interview_id, image_path, image_mime, image_deleted_at
         from ai_interview_verifications where id=$1`, [req.params.id])).rows[0]);
    if (!v) throw notFound('That photo could not be found.');
    if (!v.image_path) {
      throw new ApiError(410, 'PHOTO_DELETED', v.image_deleted_at
        ? 'This photo was deleted when its retention period ended.' : 'There is no photo for this verification.');
    }
    const bytes = await readVerificationPhoto(v.image_path);
    if (!bytes) throw new ApiError(502, CODES.UPLOAD_FAILED, 'The photo could not be read.');
    if (req.session.role !== 'candidate') {
      await withUser(ENGINE_SESSION, (c) => c.query(
        `select ai_verification_audit($1,$2,'verification.photo_viewed',$3::jsonb,$4,$5)`,
        [v.candidate_id, v.interview_id, JSON.stringify({ verificationId: v.id }),
         req.session.userId || null, req.session.role])).catch(() => {});
    }
    res.setHeader('content-type', v.image_mime || 'image/jpeg');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('cache-control', 'private, no-store');
    res.setHeader('content-disposition', 'inline; filename="interview-photo"');
    res.send(bytes);
  }));

  return r;
}
