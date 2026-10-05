/**
 * Registration, documents and privacy (0109).
 *
 *   GET    /registration/settings              consent version, policy links, file limits
 *   POST   /auth/register/check                is this email / mobile already an account?
 *
 *   POST   /candidates/:id/documents           upload (cover letter, certificate,
 *                                              marksheet, experience letter, photo)
 *   PUT    /candidates/:id/documents/:docId    replace the file, keep the document
 *   GET    /candidates/:id/documents/:docId/download
 *   DELETE /candidates/:id/documents/:docId
 *   DELETE /candidates/:id/resume              the candidate (or an admin) removes the resume
 *
 *   GET    /me/privacy                         consents, policy, open deletion request
 *   POST   /me/consents                        withdraw / give communication consent
 *   GET    /me/data-export                     everything about ME, as JSON
 *   POST   /me/deletion-request                ask for the account to be deleted
 *   POST   /me/deletion-request/cancel
 *   GET    /admin/deletion-requests            admin: the requests
 *   POST   /admin/deletion-requests/:id        admin: in_review / completed / rejected (+ deactivate)
 *
 * WHO MAY TOUCH A DOCUMENT is decided by the database, not here: every
 * read and write runs under the caller's own rights, so a document is
 * visible exactly when its candidate is (the candidate, a recruiter who
 * may see that candidate, an admin) and writable under 0091's rules.
 */
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { config } from '../config.js';
import { withUser } from '../db.js';
import { wrap, badRequest, notFound, forbidden, ApiError, CODES } from '../errors.js';
import { requireAuth, requireRole } from '../auth.js';
import { storeResume, getStorage, validateResume } from '../storage.js';
import {
  registrationSettings, windowCounter, originOf, mobileDigits, validIndianMobile,
} from '../registration/settings.js';

/* What a candidate may file, and in which formats. TXT is not offered:
   a certificate or a letter is a scan or a document. */
export const DOCUMENT_KINDS = {
  cover_letter:      { label: 'Cover Letter',      ext: ['pdf', 'doc', 'docx'], max: 5 },
  certificate:       { label: 'Certificates',      ext: ['pdf', 'jpg', 'png', 'doc', 'docx'], max: 20 },
  marksheet:         { label: 'Marksheets',        ext: ['pdf', 'jpg', 'png'], max: 20 },
  experience_letter: { label: 'Experience Letters', ext: ['pdf', 'jpg', 'png', 'doc', 'docx'], max: 20 },
  photo:             { label: 'Profile Photo',     ext: ['jpg', 'png'], max: 1 },
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Math.max(config.maxUploadBytes, 5 * 1024 * 1024), files: 1, fields: 10 },
});

function takeFile(req, res, next) {
  upload.single('document')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      const mb = Math.round(registrationSettings().documentMaxBytes / 1024 / 1024);
      return next(new ApiError(413, CODES.FILE_TOO_LARGE, `That file is too large. The limit is ${mb}MB.`));
    }
    return next(new ApiError(400, CODES.UPLOAD_FAILED, 'That file could not be uploaded.'));
  });
}

/** The kind's own rules, on the bytes - not the browser's word for them. */
function checkFile(kind, file) {
  const rule = DOCUMENT_KINDS[kind];
  if (!rule) throw badRequest('Choose what kind of document this is.', { kind: 'Unknown document type.' });
  if (!file || !file.buffer || !file.buffer.length) throw badRequest('Please choose a file to upload.');
  const s = registrationSettings();
  const limit = kind === 'photo' ? s.photoMaxBytes : s.documentMaxBytes;
  if (file.buffer.length > limit) {
    throw new ApiError(413, CODES.FILE_TOO_LARGE,
      `That file is too large. The limit is ${Math.round(limit / 1024 / 1024 * 10) / 10}MB.`);
  }
  const found = validateResume(file.buffer, file.originalname);   // magic bytes + extension consistency
  if (!rule.ext.includes(found.ext)) {
    throw new ApiError(415, CODES.UNSUPPORTED_FILE,
      `${rule.label}: please upload ${rule.ext.map((e) => e.toUpperCase()).join(', ')}.`);
  }
  return found;
}

const docOut = (d) => ({
  id: Number(d.id), kind: d.kind, fileName: d.file_name, mime: d.mime,
  size: Number(d.size), uploadedAt: d.created_at, updatedAt: d.updated_at || undefined,
});

/** Owner or staff; the database decides which staff. */
function mayAct(req) {
  const s = req.session;
  if (s.role === 'candidate' && s.profileId !== req.params.id) {
    throw forbidden('You can only manage your own documents.');
  }
  if (!['candidate', 'recruiter', 'bde', 'admin'].includes(s.role)) throw forbidden();
}

export default function registrationRoutes() {
  const r = Router();

  /* ---------------------------------------------------------------- */
  r.get('/registration/settings', (_req, res) => {
    const s = registrationSettings();
    res.json({
      consentVersion: s.consentVersion,
      privacyPolicyUrl: s.privacyPolicyUrl || null,
      privacyPolicyVersion: s.privacyPolicyVersion,
      termsUrl: s.termsUrl || null,
      consentRequired: s.consentRequired,
      documentMaxBytes: s.documentMaxBytes,
      photoMaxBytes: s.photoMaxBytes,
      resumeMaxBytes: config.maxUploadBytes,
      documentKinds: Object.fromEntries(Object.entries(DOCUMENT_KINDS)
        .map(([k, v]) => [k, { label: v.label, ext: v.ext, max: v.max }])),
    });
  });

  /*
   * IS THIS ALREADY AN ACCOUNT? The form asks so it can say so under the
   * field before the candidate has filled seven steps. It answers only
   * yes/no, and it is limited per origin (REGISTER_CHECK_MAX per 15
   * minutes) - the registration itself would say the same thing, so this
   * discloses nothing new, but it must not be a fast way to test a list.
   */
  const checks = windowCounter(15 * 60 * 1000);
  r.post('/auth/register/check', wrap(async (req, res) => {
    const s = registrationSettings();
    if (checks.hit(originOf(req)) > s.checkMax) {
      throw new ApiError(429, CODES.RATE_LIMITED, 'Too many checks. Please wait a few minutes and try again.');
    }
    const b = z.object({
      email: z.string().trim().max(254).optional(),
      phone: z.string().trim().max(32).optional(),
    }).safeParse(req.body || {});
    if (!b.success) throw badRequest('Please check the highlighted fields and try again.');
    const email = b.data.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.data.email) ? b.data.email : '';
    const phone = b.data.phone && validIndianMobile(b.data.phone) ? mobileDigits(b.data.phone) : '';
    if (!email && !phone) return res.json({ emailTaken: false, phoneTaken: false });
    const row = await withUser(null, async (c) => (await c.query(
      `select * from auth_registration_taken($1,$2)`, [email || null, phone || null])).rows[0]);
    res.json({
      emailTaken: !!(row && row.email_taken),
      phoneTaken: !!(row && row.phone_taken),
      messages: {
        email: row && row.email_taken ? 'An account with this email already exists. Please Login.' : undefined,
        phone: row && row.phone_taken ? 'An account with this mobile number already exists.' : undefined,
      },
    });
  }));

  /* ---------------------------------------------------------------- *
   * documents (§34)
   * ---------------------------------------------------------------- */
  r.post('/candidates/:id/documents', requireAuth(), takeFile, wrap(async (req, res) => {
    mayAct(req);
    const kind = String((req.body && req.body.kind) || '').trim();
    checkFile(kind, req.file);
    const candidateId = req.params.id;

    const row = await withUser(req.session, async (c) => {
      const seen = await c.query(`select 1 from candidates where id = $1`, [candidateId]);
      if (!seen.rowCount) throw notFound('That candidate could not be found.');
      const n = await c.query(
        `select count(*)::int as n from candidate_documents where candidate_id = $1 and kind = $2`,
        [candidateId, kind]);
      if (n.rows[0].n >= DOCUMENT_KINDS[kind].max) {
        throw badRequest(kind === 'photo'
          ? 'You already have a profile photo. Replace it instead.'
          : `You can keep up to ${DOCUMENT_KINDS[kind].max} ${DOCUMENT_KINDS[kind].label.toLowerCase()}. Delete one first.`);
      }
      const stored = await storeResume({
        candidateId, buffer: req.file.buffer, originalName: req.file.originalname,
      });
      let ins;
      try {
        ins = await c.query(
          `insert into candidate_documents
             (candidate_id, kind, file_name, storage_path, mime, size, uploaded_by)
           values ($1,$2,$3,$4,$5,$6,$7) returning *`,
          [candidateId, kind, stored.displayName, stored.path, stored.mime, stored.size,
           req.session.userId || null]);
      } catch (err) {
        /* Refused (RLS) or failed: the bytes must not stay behind. */
        await getStorage().remove(stored.path);
        throw err;
      }
      if (!ins.rowCount) throw forbidden('You cannot add documents to this profile.');
      if (kind === 'photo') {
        await c.query(`update candidates set photo_file=$1, photo_storage_path=$2, photo_mime=$3 where id=$4`,
          [stored.displayName, stored.path, stored.mime, candidateId]);
      }
      return ins.rows[0];
    });
    res.status(201).json({ document: docOut(row) });
  }));

  r.put('/candidates/:id/documents/:docId', requireAuth(), takeFile, wrap(async (req, res) => {
    mayAct(req);
    const candidateId = req.params.id;
    const docId = Number(req.params.docId);
    if (!Number.isInteger(docId) || docId <= 0) throw notFound('That document could not be found.');

    const { row, oldPath } = await withUser(req.session, async (c) => {
      const cur = await c.query(
        `select * from candidate_documents where id = $1 and candidate_id = $2`, [docId, candidateId]);
      if (!cur.rowCount) throw notFound('That document could not be found.');
      const kind = cur.rows[0].kind;
      checkFile(DOCUMENT_KINDS[kind] ? kind : 'certificate', req.file);
      const stored = await storeResume({
        candidateId, buffer: req.file.buffer, originalName: req.file.originalname,
      });
      const upd = await c.query(
        `update candidate_documents
            set file_name=$1, storage_path=$2, mime=$3, size=$4, uploaded_by=$5, updated_at=now()
          where id=$6 and candidate_id=$7 returning *`,
        [stored.displayName, stored.path, stored.mime, stored.size, req.session.userId || null,
         docId, candidateId]);
      if (!upd.rowCount) {
        await getStorage().remove(stored.path);
        throw forbidden('You cannot change documents on this profile.');
      }
      if (kind === 'photo') {
        await c.query(`update candidates set photo_file=$1, photo_storage_path=$2, photo_mime=$3 where id=$4`,
          [stored.displayName, stored.path, stored.mime, candidateId]);
      }
      return { row: upd.rows[0], oldPath: cur.rows[0].storage_path };
    });
    if (oldPath && oldPath !== row.storage_path) await getStorage().remove(oldPath);
    res.json({ document: docOut(row) });
  }));

  r.get('/candidates/:id/documents/:docId/download', requireAuth(), wrap(async (req, res) => {
    mayAct(req);
    const docId = Number(req.params.docId);
    const row = await withUser(req.session, async (c) => (await c.query(
      `select * from candidate_documents where id = $1 and candidate_id = $2`,
      [Number.isInteger(docId) ? docId : -1, req.params.id])).rows[0]);
    /* Invisible and missing are one answer: RLS hid it, or it is gone. */
    if (!row) throw notFound('That document could not be found.');
    const buf = await getStorage().get(row.storage_path);
    res.setHeader('content-type', row.mime || 'application/octet-stream');
    res.setHeader('content-disposition',
      `attachment; filename="${String(row.file_name || 'document').replace(/["\r\n]/g, '')}"`);
    res.setHeader('x-content-type-options', 'nosniff');
    res.send(buf);
  }));

  r.delete('/candidates/:id/documents/:docId', requireAuth(), wrap(async (req, res) => {
    mayAct(req);
    const docId = Number(req.params.docId);
    const gone = await withUser(req.session, async (c) => {
      const del = await c.query(
        `delete from candidate_documents where id = $1 and candidate_id = $2 returning *`,
        [Number.isInteger(docId) ? docId : -1, req.params.id]);
      if (!del.rowCount) {
        const seen = await c.query(`select 1 from candidate_documents where id = $1`, [docId]);
        throw seen.rowCount ? forbidden('You cannot delete documents on this profile.')
                            : notFound('That document could not be found.');
      }
      const d = del.rows[0];
      if (d.kind === 'photo') {
        await c.query(`update candidates set photo_file=null, photo_storage_path=null, photo_mime=null
                        where id=$1 and photo_storage_path=$2`, [req.params.id, d.storage_path]);
      }
      return d;
    });
    await getStorage().remove(gone.storage_path);
    res.json({ ok: true, deleted: Number(gone.id) });
  }));

  /*
   * Removing the resume. The candidate's own decision (or an admin's);
   * a recruiter does not delete somebody's CV. The FILE stays on disk
   * when an application was made with it, because that application's
   * snapshot (applications.resume_path) still points at it.
   */
  r.delete('/candidates/:id/resume', requireAuth(), wrap(async (req, res) => {
    const s = req.session;
    if (!(s.role === 'admin' || (s.role === 'candidate' && s.profileId === req.params.id))) {
      throw forbidden('Only the candidate can remove their resume.');
    }
    const out = await withUser(s, async (c) => {
      const cur = await c.query(`select resume_storage_path from candidates where id = $1`, [req.params.id]);
      if (!cur.rowCount) throw notFound('That candidate could not be found.');
      const path = cur.rows[0].resume_storage_path;
      if (!path) throw notFound('There is no resume on this profile.');
      const upd = await c.query(
        `update candidates set resume_file=null, resume_storage_path=null, resume_mime=null,
                resume_size=null, resume_uploaded_at=null, resume_text=null,
                resume_parsed_at=null, resume_parse_error=null
          where id = $1 returning id`, [req.params.id]);
      if (!upd.rowCount) throw forbidden('You cannot change this profile.');
      const used = await c.query(`select 1 from applications where resume_path = $1 limit 1`, [path]);
      return { path, keep: used.rowCount > 0 };
    });
    if (!out.keep) await getStorage().remove(out.path);
    res.json({ ok: true });
  }));

  /* ---------------------------------------------------------------- *
   * privacy (§40) - the candidate's own data only
   * ---------------------------------------------------------------- */
  const candidateOnly = [requireAuth(), requireRole('candidate')];

  r.get('/me/privacy', ...candidateOnly, wrap(async (req, res) => {
    const s = registrationSettings();
    const data = await withUser(req.session, async (c) => {
      const cons = await c.query(
        `select kind, status, version, created_at from candidate_consent_current
          where candidate_id = app_candidate_id() order by kind`);
      const reqs = await c.query(
        `select id, status, requested_at, updated_at, admin_note from account_deletion_requests
          where candidate_id = app_candidate_id() order by requested_at desc limit 5`);
      return { cons: cons.rows, reqs: reqs.rows };
    });
    res.json({
      policy: { url: s.privacyPolicyUrl || null, version: s.privacyPolicyVersion, termsUrl: s.termsUrl || null },
      consentVersion: s.consentVersion,
      consents: data.cons.map((x) => ({ kind: x.kind, status: x.status, version: x.version, at: x.created_at })),
      deletionRequests: data.reqs.map((x) => ({
        id: Number(x.id), status: x.status, requestedAt: x.requested_at, updatedAt: x.updated_at,
        note: x.admin_note || undefined,
      })),
    });
  }));

  r.post('/me/consents', ...candidateOnly, wrap(async (req, res) => {
    const b = z.object({
      kind: z.enum(['communication']),
      status: z.enum(['granted', 'withdrawn']),
    }).safeParse(req.body || {});
    if (!b.success) throw badRequest('Only communication consent can be changed here.');
    const ok = await withUser(req.session, async (c) => (await c.query(
      `select candidate_consent_set($1,$2,$3) as ok`,
      [b.data.kind, b.data.status, registrationSettings().consentVersion])).rows[0].ok);
    if (!ok) throw forbidden();
    res.json({ ok: true });
  }));

  /*
   * DOWNLOAD MY DATA.
   *
   * An explicit list of what is the candidate's own, read under their own
   * rights - never `select *`, so a column added later is not exported by
   * accident. Left out on purpose, and said so in the file: recruiter
   * notes and comments, internal remarks, match / screening / AI scores,
   * call recordings and transcripts, and anything about other people
   * (including which recruiters or employers viewed the profile).
   */
  r.get('/me/data-export', ...candidateOnly, wrap(async (req, res) => {
    const out = await withUser(req.session, async (c) => {
      /* Each section on its own savepoint: a section that cannot be read
         is left empty rather than aborting the whole export. */
      let sp = 0;
      const one = async (sql, params = []) => {
        const name = `exp${++sp}`;
        await c.query(`savepoint ${name}`);
        try {
          const rows = (await c.query(sql, params)).rows;
          await c.query(`release savepoint ${name}`);
          return rows;
        } catch {
          await c.query(`rollback to savepoint ${name}`);
          return [];
        }
      };
      const prof = (await one(
        `select id, candidate_code, name, first_name, middle_name, last_name, email, alt_email,
                phone, whatsapp_number, date_of_birth, gender, location, city, state, country,
                title, current_company, previous_companies, exp, exp_years, relevant_exp_years,
                candidate_type, skills, technical_skills, soft_skills, education, summary,
                certifications, languages, projects, internships, achievements, other_links,
                linkedin, github, portfolio, ctc, expected_ctc, notice_period, preferred_role,
                preferred_location, preferred_work_modes, preferred_employment_types,
                willing_to_relocate, available_from, immediate_joiner, availability,
                preferred_language, email_opt_in, sms_opt_in, whatsapp_opt_in,
                preferred_contact_method, do_not_contact, resume_file, resume_uploaded_at,
                photo_file, source, created_at, updated_at
           from candidates where id = app_candidate_id()`))[0] || null;
      return {
        profile: prof,
        education: await one(
          `select qualification, specialization, institution, passing_year, score, education_type
             from candidate_education where candidate_id = app_candidate_id() order by sort_order, id`),
        experience: await one(
          `select company, job_title, start_date, end_date, currently_working, location,
                  employment_type, responsibilities
             from candidate_experience where candidate_id = app_candidate_id() order by sort_order, id`),
        documents: await one(
          `select kind, file_name, mime, size, created_at, updated_at
             from candidate_documents where candidate_id = app_candidate_id() order by created_at`),
        applications: await one(
          `select a.reference, j.title as job_title, j.location as job_location,
                  stage_label(a.stage, 'candidate') as status, a.applied_at, a.updated_at
             from applications a join jobs j on j.id = a.job_id
            where a.candidate_id = app_candidate_id() order by a.applied_at desc`),
        interviews: await one(
          `select i.type, i.scheduled_date, i.scheduled_time, i.mode, i.status, j.title as job_title
             from interviews i left join jobs j on j.id = i.job_id
            where i.candidate_id = app_candidate_id() order by i.scheduled_date desc nulls last`),
        savedJobs: await one(
          `select j.title as job_title, s.created_at from saved_jobs s join jobs j on j.id = s.job_id
            where s.candidate_id = app_candidate_id() order by s.created_at desc`),
        savedSearches: await one(
          `select label, filters, alert_frequency, channels, created_at
             from candidate_saved_searches where candidate_id = app_candidate_id() order by created_at`),
        jobAlerts: await one(
          `select label, query, location, frequency, paused, created_at
             from job_alerts where candidate_id = app_candidate_id() order by created_at`),
        consents: await one(
          `select kind, status, version, policy_url, source, created_at
             from candidate_consents where candidate_id = app_candidate_id() order by created_at, id`),
        messagesSentToYou: await one(
          `select type, title, message, created_at from notifications
            where recipient_id = app_candidate_id() and recipient_role = 'candidate'
            order by created_at desc limit 500`),
        registrationEmails: await one(
          `select kind, status, created_at, updated_at from candidate_registration_messages
            where candidate_id = app_candidate_id() order by created_at`),
        deletionRequests: await one(
          `select status, reason, requested_at, updated_at from account_deletion_requests
            where candidate_id = app_candidate_id() order by requested_at`),
      };
    });
    if (!out.profile) throw notFound('Your profile could not be found.');
    const body = {
      exportedAt: new Date().toISOString(),
      about: 'Your TeamLink candidate data. Files themselves (resume, documents) are listed by name; '
        + 'download them from your profile.',
      notIncluded: [
        'Notes, comments and internal remarks written by TeamLink staff',
        'Match, screening and AI interview scores used internally',
        'Call recordings and transcripts',
        'Information about other people, including who viewed your profile',
      ],
      ...out,
    };
    const name = `teamlink-my-data-${(out.profile.candidate_code || 'candidate').replace(/[^A-Za-z0-9-]/g, '')}.json`;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="${name}"`);
    res.setHeader('x-content-type-options', 'nosniff');
    res.send(JSON.stringify(body, null, 2));
  }));

  r.post('/me/deletion-request', ...candidateOnly, wrap(async (req, res) => {
    const reason = String((req.body && req.body.reason) || '').trim().slice(0, 1000) || null;
    const row = await withUser(req.session, async (c) => {
      const open = await c.query(
        `select id from account_deletion_requests
          where candidate_id = app_candidate_id() and status in ('pending','in_review')`);
      if (open.rowCount) {
        throw new ApiError(409, 'DELETION_ALREADY_REQUESTED',
          'You already have an open deletion request. An administrator will respond to it.');
      }
      const ins = await c.query(
        `insert into account_deletion_requests (candidate_id, reason)
         values (app_candidate_id(), $1) returning *`, [reason]);
      return ins.rows[0];
    });
    res.status(201).json({
      request: { id: Number(row.id), status: row.status, requestedAt: row.requested_at },
      message: 'Your request has been recorded. An administrator will review it; '
        + 'your account stays as it is until then.',
    });
  }));

  r.post('/me/deletion-request/cancel', ...candidateOnly, wrap(async (req, res) => {
    const n = await withUser(req.session, async (c) => (await c.query(
      `update account_deletion_requests set status = 'cancelled', updated_at = now()
        where candidate_id = app_candidate_id() and status = 'pending' returning id`)).rowCount);
    if (!n) throw notFound('There is no pending request to cancel.');
    res.json({ ok: true });
  }));

  r.get('/admin/deletion-requests', requireAuth(), requireRole('admin'), wrap(async (req, res) => {
    const status = String(req.query.status || '').trim();
    const rows = await withUser(req.session, async (c) => (await c.query(
      `select r.*, c.name, c.email, c.candidate_code
         from account_deletion_requests r join candidates c on c.id = r.candidate_id
        where ($1 = '' or r.status = $1)
        order by (r.status in ('pending','in_review')) desc, r.requested_at desc limit 200`,
      [status])).rows);
    res.json({
      requests: rows.map((x) => ({
        id: Number(x.id), candidateId: x.candidate_id, candidateCode: x.candidate_code,
        name: x.name, email: x.email, reason: x.reason || '', status: x.status,
        requestedAt: x.requested_at, updatedAt: x.updated_at, processedAt: x.processed_at,
        note: x.admin_note || '', deactivated: !!x.deactivated,
      })),
    });
  }));

  r.post('/admin/deletion-requests/:id', requireAuth(), requireRole('admin'), wrap(async (req, res) => {
    const b = z.object({
      status: z.enum(['in_review', 'completed', 'rejected']),
      note: z.string().max(1000).optional(),
      deactivate: z.boolean().optional(),
    }).safeParse(req.body || {});
    if (!b.success) throw badRequest('Choose in review, completed or rejected.');
    const id = Number(req.params.id);
    const row = await withUser(req.session, async (c) => {
      const upd = await c.query(
        `update account_deletion_requests
            set status = $1, admin_note = coalesce($2, admin_note), updated_at = now(),
                processed_at = case when $1 in ('completed','rejected') then now() else processed_at end,
                processed_by = case when $1 in ('completed','rejected') then app_user_id() else processed_by end
          where id = $3 and status in ('pending','in_review') returning *`,
        [b.data.status, b.data.note || null, Number.isInteger(id) ? id : -1]);
      if (!upd.rowCount) throw notFound('That request is not open.');
      if (b.data.deactivate && b.data.status === 'completed') {
        await c.query(`select deletion_request_deactivate($1)`, [id]);
      }
      return (await c.query(`select * from account_deletion_requests where id = $1`, [id])).rows[0];
    });
    res.json({ request: { id: Number(row.id), status: row.status, deactivated: !!row.deactivated } });
  }));

  return r;
}
