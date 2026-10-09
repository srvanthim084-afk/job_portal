/**
 * "Build your profile" - the post-registration wizard's server side (0124).
 *
 *   GET    /api/candidates/:id/onboarding           status, step, the draft, how many times "later"
 *   PUT    /api/candidates/:id/onboarding           save progress (status / step / draft); never "completed"
 *   POST   /api/candidates/:id/onboarding/resume    store a resume and READ it - writes nothing else
 *   DELETE /api/candidates/:id/onboarding/resume    remove the resume on file
 *   POST   /api/candidates/:id/onboarding/complete  the confirmed profile, saved in ONE transaction
 *
 * THE RULE THIS FILE EXISTS FOR: reading a resume and changing a profile are different acts. The old upload
 * route did both - the reading was written into every empty column the moment the file arrived - so a
 * candidate who uploaded a resume and then closed the box had a profile they had never seen. Here the file is
 * kept and READ, the reading is handed back for the candidate to review and edit, and the profile columns
 * change only when they confirm (/complete).
 *
 * /complete is idempotent: the lists it writes are REPLACED with what the candidate confirmed (the same
 * rule as PUT /candidates/:id), so a retry, a double click or two tabs produce the same profile, never a
 * second copy of a job or a qualification.
 *
 * A candidate may only touch their own. Staff do not use these routes.
 */
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { config } from '../config.js';
import { withUser } from '../db.js';
import { wrap, badRequest, notFound, forbidden, ApiError, CODES } from '../errors.js';
import { requireAuth } from '../auth.js';
import { storeResume, getStorage } from '../storage.js';
import { extractResumeText } from '../resume/extract.js';
import { analyseResume } from '../resume/confidence.js';
import { toCandidate, toEducationRecord, toExperienceRecord } from '../shapes.js';
import { screenApplication } from '../ai/screening.js';

const ENGINE_SESSION = { userId: '', role: 'admin', profileId: null };
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadBytes, files: 1, fields: 10 } });
const RESUME_EXT = /\.(pdf|docx?)$/i;
const DRAFT_MAX_CHARS = 150_000;

const str = (n) => z.string().max(n).optional().nullable();
const list = (n, each) => z.array(z.string().trim().min(1).max(each)).max(n).optional();

const completeSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  phone: str(32),
  location: str(120),
  summary: str(8000),
  title: str(160),
  currentCompany: str(160),
  expYears: z.number().min(0).max(60).optional().nullable(),
  skills: list(100, 120),
  certifications: list(60, 200),
  languages: list(30, 60),
  projects: z.array(z.object({ name: str(160), description: str(1000) })).max(30).optional(),
  noticePeriod: str(40),
  preferredLocation: str(160),
  preferredRole: str(160),
  expectedCtc: z.number().min(0).max(1000).optional().nullable(),
  preferredWorkModes: list(10, 40),
  educationRecords: z.array(z.object({
    qualification: str(160), specialization: str(160), institution: str(200),
    passingYear: z.union([z.string().max(8), z.number()]).optional().nullable(),
    score: str(40), educationType: str(40),
  })).max(20).optional(),
  experienceRecords: z.array(z.object({
    company: str(200), jobTitle: str(160), location: str(120), employmentType: str(40),
    responsibilities: str(4000),
  })).max(30).optional(),
});

const progressSchema = z.object({
  status: z.enum(['not_started', 'in_progress', 'skipped']).optional(),
  step: z.number().int().min(0).max(10).optional(),
  draft: z.record(z.any()).optional().nullable(),
  restart: z.boolean().optional(),
});

const distinct = (arr) => {
  const seen = new Set();
  return (arr || []).map((x) => String(x).trim()).filter((x) => {
    const k = x.toLowerCase();
    if (!x || seen.has(k)) return false;
    seen.add(k); return true;
  });
};
const blank = (v) => v === undefined || v === null || (Array.isArray(v) ? v.length === 0 : String(v).trim() === '');

export default function profileOnboardingRoutes() {
  const r = Router();

  const own = (req) => {
    if (req.session.role !== 'candidate' || req.session.profileId !== req.params.id) {
      throw forbidden('You can only build your own profile.');
    }
    return req.params.id;
  };

  async function state(session, id) {
    return withUser(session, async (c) => (await c.query(`select candidate_onboarding_get($1) as s`, [id])).rows[0].s);
  }

  async function rescreen(candidateId) {
    try {
      const apps = await withUser(ENGINE_SESSION, async (c) => (await c.query(
        `select id from applications where candidate_id=$1 and stage not in ('rejected','joined')`, [candidateId])).rows);
      for (const a of apps) {
        // eslint-disable-next-line no-await-in-loop
        await screenApplication(a.id, { actor: 'system', force: true });
      }
    } catch (err) {
      console.error('[onboarding] re-screening failed:', err.message);
    }
  }

  r.get('/candidates/:id/onboarding', requireAuth(), wrap(async (req, res) => {
    const id = own(req);
    const s = await state(req.session, id);
    if (!s) throw notFound('That candidate could not be found.');
    res.json(s);
  }));

  r.put('/candidates/:id/onboarding', requireAuth(), wrap(async (req, res) => {
    const id = own(req);
    const parsed = progressSchema.safeParse(req.body || {});
    if (!parsed.success) throw badRequest('That progress could not be saved.');
    const b = parsed.data;
    const draftJson = b.draft === undefined ? null : (b.draft === null ? null : JSON.stringify(b.draft));
    if (draftJson && draftJson.length > DRAFT_MAX_CHARS) throw badRequest('That is too much to keep as a draft.');
    const s = await withUser(req.session, async (c) => (await c.query(
      `select candidate_onboarding_save($1,$2,$3,$4::jsonb,$5,$6) as s`,
      [id, b.status || null, b.step === undefined ? null : b.step, draftJson, b.draft === null, !!b.restart])).rows[0].s);
    if (!s) throw notFound('That candidate could not be found.');
    res.json(s);
  }));

  /* ---- the resume: kept and read, nothing else written ------------------- */
  r.post('/candidates/:id/onboarding/resume', requireAuth(),
    (req, res, next) => upload.single('resume')(req, res, (err) => {
      if (!err) return next();
      if (err.code === 'LIMIT_FILE_SIZE') {
        const mb = Math.round(config.maxUploadBytes / 1024 / 1024);
        return next(new ApiError(413, CODES.FILE_TOO_LARGE, `That file is too large. The limit is ${mb}MB.`));
      }
      return next(new ApiError(400, CODES.UPLOAD_FAILED, 'That file could not be uploaded. Please try again.'));
    }),
    wrap(async (req, res) => {
      const id = own(req);
      if (!req.file || !req.file.buffer || !req.file.buffer.length) {
        throw badRequest('Please choose your resume file (PDF, DOC or DOCX).');
      }
      if (!RESUME_EXT.test(String(req.file.originalname || ''))) {
        throw new ApiError(415, CODES.UNSUPPORTED_FILE, 'Please upload your resume as a PDF, DOC or DOCX file.');
      }
      const stored = await storeResume({ candidateId: id, buffer: req.file.buffer, originalName: req.file.originalname });

      let parse;
      let resumeText = null;
      let parseErr = null;
      let ana = null;
      let doc = null;
      try {
        doc = await extractResumeText(req.file.buffer, req.file.originalname);
        resumeText = String(doc.text || '').slice(0, 200_000);
        ana = await analyseResume(doc.text, { parser: doc.parser });
        parse = { ok: true, parser: doc.parser, chars: doc.chars, found: ana.found || 0,
          fields: ana.fields || {}, confidence: ana.confidence || {}, needsVerification: ana.needsVerification || [] };
      } catch (err) {
        parseErr = String((err && err.message) || 'the resume could not be read').slice(0, 400);
        parse = { ok: false, error: 'We could not read that file. You can fill in the details yourself, or try another file.' };
      }

      const before = await withUser(req.session, async (c) => (await c.query(
        `select resume_storage_path from candidates where id=$1`, [id])).rows[0]);
      const row = await withUser(req.session, async (c) => {
        const upd = await c.query(
          `update candidates
              set resume_file=$1, resume_storage_path=$2, resume_mime=$3, resume_size=$4, resume_uploaded_at=now(),
                  resume_parsed_at=$6, resume_parser=$7, resume_chars=$8, resume_fields_detected=$9,
                  resume_parse_confidence=$10, resume_parse_error=$11, resume_text=$12
            where id=$5 returning *`,
          [stored.displayName, stored.path, stored.mime, stored.size, id,
           parse.ok ? new Date() : null, parse.ok ? parse.parser : null, parse.ok ? parse.chars : null,
           parse.ok ? parse.found : null, parse.ok ? (ana.overall ?? null) : null, parseErr, resumeText]);
        if (!upd.rowCount) throw forbidden('You cannot change this profile.');
        return upd.rows[0];
      });
      if (before && before.resume_storage_path && before.resume_storage_path !== stored.path) {
        getStorage().remove(before.resume_storage_path).catch(() => {});
      }
      rescreen(id);
      res.status(201).json({
        candidate: toCandidate(row),
        resume: { fileName: stored.displayName, size: stored.size, mime: stored.mime },
        parse,
      });
    }));

  /* Read the resume ALREADY ON FILE (from registration, or an earlier visit) without writing anything. */
  r.post('/candidates/:id/onboarding/read', requireAuth(), wrap(async (req, res) => {
    const id = own(req);
    const row = await withUser(req.session, async (c) => (await c.query(
      `select resume_file, resume_storage_path from candidates where id=$1`, [id])).rows[0]);
    if (!row) throw notFound('That candidate could not be found.');
    if (!row.resume_storage_path) throw badRequest('There is no resume on file to read.');
    try {
      const buf = await getStorage().get(row.resume_storage_path);
      const doc = await extractResumeText(buf, row.resume_file || 'resume');
      const ana = await analyseResume(doc.text, { parser: doc.parser });
      res.json({ parse: { ok: true, parser: doc.parser, chars: doc.chars, found: ana.found || 0,
        fields: ana.fields || {}, confidence: ana.confidence || {}, needsVerification: ana.needsVerification || [] } });
    } catch (err) {
      res.json({ parse: { ok: false, error: 'We could not read that file. You can fill in the details yourself, or upload another file.' } });
    }
  }));

  r.delete('/candidates/:id/onboarding/resume', requireAuth(), wrap(async (req, res) => {
    const id = own(req);
    const before = await withUser(req.session, async (c) => (await c.query(
      `select resume_storage_path from candidates where id=$1`, [id])).rows[0]);
    if (!before) throw notFound('That candidate could not be found.');
    const row = await withUser(req.session, async (c) => (await c.query(
      `update candidates
          set resume_file=null, resume_storage_path=null, resume_mime=null, resume_size=null,
              resume_uploaded_at=null, resume_parsed_at=null, resume_parser=null, resume_chars=null,
              resume_fields_detected=null, resume_parse_confidence=null, resume_parse_error=null, resume_text=null
        where id=$1 returning *`, [id])).rows[0]);
    if (!row) throw forbidden('You cannot change this profile.');
    if (before.resume_storage_path) getStorage().remove(before.resume_storage_path).catch(() => {});
    res.json({ candidate: toCandidate(row) });
  }));

  /* ---- finish: the confirmed profile, in one transaction ------------------ */
  r.post('/candidates/:id/onboarding/complete', requireAuth(), wrap(async (req, res) => {
    const id = own(req);
    const out = completeSchema.safeParse(req.body || {});
    if (!out.success) {
      const details = {};
      for (const i of out.error.issues) details[i.path.join('.') || 'form'] = i.message;
      throw badRequest('Please check the highlighted fields and try again.', details);
    }
    const b = out.data;

    const row = await withUser(req.session, async (c) => {
      const cur = (await c.query(`select * from candidates where id=$1`, [id])).rows[0];
      if (!cur) throw notFound('That candidate could not be found.');

      /* What the six additional details will be AFTER this save: what they send, else what the record has.
         A detail the candidate already gave (at registration, or earlier) is not asked again - and is not
         lost if the page leaves it out. */
      const val = (sent, have) => (sent === undefined ? have : sent);
      const location = val(b.location, cur.location);
      const preferredLocation = val(b.preferredLocation, cur.preferred_location);
      const noticePeriod = val(b.noticePeriod, cur.notice_period);
      const expectedCtc = val(b.expectedCtc, cur.expected_ctc);
      const preferredRole = val(b.preferredRole, cur.preferred_role);
      const modes = val(b.preferredWorkModes, cur.preferred_work_modes);
      const problems = {};
      if (blank(location)) problems.location = 'Current location is required';
      if (blank(preferredLocation)) problems.preferredLocation = 'Preferred location is required';
      if (blank(noticePeriod)) problems.noticePeriod = 'Notice period is required';
      if (expectedCtc === null || expectedCtc === undefined || !(Number(expectedCtc) > 0)) problems.expectedCtc = 'Expected salary is required';
      if (blank(preferredRole)) problems.preferredRole = 'Preferred role is required';
      if (blank(modes)) problems.preferredWorkModes = 'Select at least one work mode';
      if (Object.keys(problems).length) throw badRequest('Please check the highlighted fields and try again.', problems);

      /* the lists first, replaced with what was confirmed */
      if (b.educationRecords || b.experienceRecords) {
        const edu = b.educationRecords && b.educationRecords
          .filter((e) => e && (e.qualification || e.institution || e.specialization))
          .map((e) => ({ ...e, passingYear: /^\d{4}$/.test(String(e.passingYear ?? '')) ? String(e.passingYear) : '' }));
        const exp = b.experienceRecords && b.experienceRecords.filter((e) => e && (e.company || e.jobTitle));
        await c.query(`select candidate_records_replace($1,$2,$3)`,
          [id, edu ? JSON.stringify(edu) : null, exp ? JSON.stringify(exp) : null]);
      }

      const sets = []; const vals = [];
      const put = (col, v, cast) => { vals.push(v); sets.push(`${col}=$${vals.length}${cast || ''}`); };
      const t = (v) => String(v).trim();
      if (b.name !== undefined) put('name', t(b.name));
      if (b.phone !== undefined) put('phone', blank(b.phone) ? cur.phone : t(b.phone));
      if (b.location !== undefined) put('location', t(b.location));
      if (b.summary !== undefined) put('summary', t(b.summary || ''));
      if (b.title !== undefined) put('title', t(b.title || ''));
      if (b.currentCompany !== undefined) put('current_company', t(b.currentCompany || ''));
      if (b.expYears !== undefined && b.expYears !== null) { put('exp_years', b.expYears); put('exp', `${b.expYears} yrs`); }
      if (b.skills) put('skills', distinct(b.skills));
      if (b.certifications) put('certifications', distinct(b.certifications));
      if (b.languages) put('languages', distinct(b.languages));
      if (b.projects) {
        const seen = new Set();
        const items = b.projects.filter((p) => p && !blank(p.name)).filter((p) => {
          const k = t(p.name).toLowerCase();
          if (seen.has(k)) return false;
          seen.add(k); return true;
        }).map((p) => ({ name: t(p.name), desc: t(p.description || '') }));
        put('projects', JSON.stringify(items), '::jsonb');
      }
      if (b.noticePeriod !== undefined) put('notice_period', t(b.noticePeriod));
      if (b.preferredLocation !== undefined) put('preferred_location', t(b.preferredLocation));
      if (b.preferredRole !== undefined) put('preferred_role', t(b.preferredRole));
      if (b.expectedCtc !== undefined && b.expectedCtc !== null) put('expected_ctc', b.expectedCtc);
      if (b.preferredWorkModes) put('preferred_work_modes', distinct(b.preferredWorkModes));
      sets.push('profile_updated_days_ago = 0');
      vals.push(id);
      const upd = await c.query(`update candidates set ${sets.join(',')} where id=$${vals.length} returning *`, vals);
      if (!upd.rowCount) throw forbidden('You cannot edit this profile.');

      /* and the status, in the same transaction: a profile is "completed" only if it was saved */
      await c.query(`select candidate_onboarding_save($1,'completed',null,null,true,false)`, [id]);
      /* the rows as saved, in the shape the page already reads (bootstrap), so it shows them without a reload */
      const edu = await c.query(
        `select qualification, specialization, institution, passing_year, score, education_type
           from candidate_education where candidate_id=$1 order by sort_order, id`, [id]);
      const exp = await c.query(
        `select company, job_title, start_date, end_date, currently_working, location, employment_type,
                responsibilities, leaving_reason
           from candidate_experience where candidate_id=$1 order by sort_order, id`, [id]);
      return { row: upd.rows[0], edu: edu.rows, exp: exp.rows };
    });

    rescreen(id);
    const candidate = toCandidate({ ...row.row, onboarding_status: 'completed' });
    candidate.educationRecords = row.edu.map(toEducationRecord);
    candidate.experienceRecords = row.exp.map(toExperienceRecord);
    res.json({ candidate, status: 'completed' });
  }));

  return r;
}
