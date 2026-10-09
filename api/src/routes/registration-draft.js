/**
 * Resume-first registration: the draft (0117).
 *
 *   POST  /registration/drafts                 upload the resume: the file is
 *                                              stored, a draft is created and
 *                                              the resume is read at once
 *   GET   /registration/drafts/:id             the draft as it stands (after a refresh)
 *   POST  /registration/drafts/:id/retry       read the stored resume again
 *   PATCH /registration/drafts/:id             the candidate confirms / corrects
 *                                              fields the reading was unsure of
 *   POST  /registration/drafts/:id/email-code  send a 6-digit code to the address
 *   POST  /registration/drafts/:id/verify-email
 *   POST  /registration/drafts/:id/phone-otp   send a 6-digit code by SMS to the mobile number (0123)
 *   POST  /registration/drafts/:id/verify-phone
 *   GET   /me/profile-completeness             what is filled in, what is missing
 *
 * The account itself is still created by POST /auth/register - the same
 * route, the same rules, the same duplicate checks - which converts the
 * draft when it is given `draftId` + `draftToken` (finishDraft below).
 *
 * WHO MAY TOUCH A DRAFT. Whoever holds its token: the browser that
 * uploaded the resume. The token travels in the `x-draft-token` header,
 * only its hash is stored, and every read and write goes through a
 * function that checks it. There is no list of drafts and no way to read
 * one without its token.
 */
import { Router } from 'express';
import multer from 'multer';
import { randomBytes, randomInt, createHash } from 'node:crypto';
import { z } from 'zod';
import { config } from '../config.js';
import { withUser } from '../db.js';
import { wrap, badRequest, notFound, ApiError, CODES } from '../errors.js';
import { requireAuth, requireRole } from '../auth.js';
import { storeResume, getStorage } from '../storage.js';
import { extractResumeText } from '../resume/extract.js';
import { analyseResume, acceptedFields, confidenceMin, VERIFY_KEYS } from '../resume/confidence.js';
import { applyExtractedFields } from '../resume/apply.js';
import { completenessFor, EXTRACTION_TO_FIELD } from '../profile/completeness.js';
import { providers, isReservedTestAddress } from '../notify/providers.js';
import { windowCounter, originOf, validIndianMobile } from '../registration/settings.js';

export const EXTRACT_FAILED_MESSAGE =
  "We couldn't extract your resume automatically. Please review or enter the missing information manually.";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes, files: 1, fields: 4 },
});

const hashToken = (t) => createHash('sha256').update(String(t || '')).digest('hex');
const codeHash = (draftId, code) => createHash('sha256').update(`${draftId}:${code}`).digest('hex');
const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isProd = () => process.env.NODE_ENV === 'production';
const draftLimit = () => {
  const n = parseInt(process.env.REGISTRATION_DRAFT_MAX, 10);
  return Number.isFinite(n) && n > 0 ? n : (isProd() ? 20 : 1000);
};
const drafts = windowCounter(60 * 60 * 1000);

function tokenOf(req) {
  const t = String(req.get('x-draft-token') || (req.body && req.body.draftToken) || '').trim();
  if (!/^[a-f0-9]{48}$/.test(t)) throw new ApiError(401, 'DRAFT_TOKEN', 'Your registration session has expired. Please upload your resume again.');
  return t;
}

async function readDraft(id, token) {
  const d = await withUser(null, async (c) =>
    (await c.query(`select registration_draft_read($1,$2) as d`, [id, hashToken(token)])).rows[0].d);
  if (!d) throw notFound('Your registration session has expired. Please upload your resume again.');
  return d;
}

async function saveDraft(id, token, data) {
  const d = await withUser(null, async (c) =>
    (await c.query(`select registration_draft_save($1,$2,$3::jsonb) as d`,
      [id, hashToken(token), JSON.stringify(data)])).rows[0].d);
  if (!d) throw notFound('Your registration session has expired. Please upload your resume again.');
  return d;
}

/* Is this address / number already an account? Booleans only. */
async function taken(email, phone) {
  return withUser(null, async (c) => {
    const { rows } = await c.query(`select * from auth_registration_taken($1,$2)`, [email || '', phone || '']);
    return { email: !!(rows[0] && rows[0].email_taken), phone: !!(rows[0] && rows[0].phone_taken) };
  });
}

const valueFor = (d, k) => {
  const corr = d.corrections || {};
  if (Object.prototype.hasOwnProperty.call(corr, k)) return corr[k];
  return ((d.extraction || {}).fields || {})[k];
};

/**
 * What the page needs, and nothing it does not: no resume text, no token.
 * `ask` names the identity fields the candidate has to type because the
 * resume did not give them (or gave them unsurely and they are not yet
 * confirmed).
 */
async function view(d) {
  const ex = d.extraction || {};
  const fields = { ...(ex.fields || {}) };
  const conf = ex.confidence || {};
  const corr = d.corrections || {};
  const min = confidenceMin();
  const unsure = (k) => (conf[k] ?? 1) < min && !Object.prototype.hasOwnProperty.call(corr, k);
  const missing = (k) => {
    const v = valueFor(d, k);
    return v === undefined || v === null || String(v).trim() === '';
  };
  const ask = {
    name: missing('name') || unsure('name'),
    email: !d.email_verified_at && (missing('email') || unsure('email')),
    phone: missing('phone') || unsure('phone')
      || !validIndianMobile(String(valueFor(d, 'phone') || '')),
  };
  const email = d.email || valueFor(d, 'email') || null;
  const phone = valueFor(d, 'phone') || null;
  const existing = await taken(email, phone);
  return {
    draftId: d.id,
    status: d.status,
    resume: d.resume_file ? { fileName: d.resume_file, size: d.resume_size, mime: d.resume_mime } : null,
    fields,
    corrections: corr,
    confidence: conf,
    threshold: min,
    needsVerification: (ex.needsVerification || []).filter((k) => !Object.prototype.hasOwnProperty.call(corr, k)),
    nameSuggestion: fields.name ? null : (fields.nameSuggestion || null),
    ask,
    email,
    emailVerified: !!d.email_verified_at,
    phone: d.phone || null,
    phoneVerified: !!d.phone_verified_at,
    existing,
    source: ex.source || null,
    parser: ex.parser || null,
    found: ex.found || 0,
    attempts: d.attempts || 0,
    error: d.status === 'failed'
      ? { code: d.extraction_code || 'RESUME_UNREADABLE', message: EXTRACT_FAILED_MESSAGE,
          reason: d.extraction_error || null }
      : null,
  };
}

/**
 * Reads the stored resume. Never throws: a failure is recorded on the
 * draft (status 'failed') and the resume stays where it is, so the
 * candidate can retry or carry on by hand.
 */
async function runExtraction(id, token, buffer, fileName) {
  const limit = Number(process.env.REGISTRATION_EXTRACT_TIMEOUT_MS || 60000);
  try {
    const result = await Promise.race([
      (async () => {
        const doc = await extractResumeText(buffer, fileName);
        const ana = await analyseResume(doc.text, { parser: doc.parser });
        return { doc, ana };
      })(),
      new Promise((_, reject) => setTimeout(() => reject(Object.assign(
        new Error('reading the resume took too long'), { code: 'EXTRACTION_TIMEOUT' })), limit)),
    ]);
    const { doc, ana } = result;
    return await saveDraft(id, token, {
      status: 'extracted',
      attempt: 1,
      resume_text: String(doc.text || '').slice(0, 200_000),
      extraction: { ...ana, parser: doc.parser, chars: doc.chars },
      extraction_code: null,
      extraction_error: ana.aiError ? `AI: ${ana.aiError}` : null,
    });
  } catch (err) {
    return saveDraft(id, token, {
      status: 'failed',
      attempt: 1,
      extraction_code: (err && err.code) || 'RESUME_UNREADABLE',
      extraction_error: String((err && err.message) || 'the resume could not be read').slice(0, 400),
    });
  }
}

/* Old drafts go, and their files with them. Now and then, not every time. */
async function purgeSometimes() {
  if (Math.random() > 0.05) return;
  try {
    const paths = await withUser(null, async (c) =>
      (await c.query(`select registration_drafts_purge() as p`)).rows.map((r) => r.p).filter(Boolean));
    for (const p of paths) await getStorage().remove(p).catch(() => {});
  } catch { /* housekeeping must never fail a registration */ }
}

const CORRECTABLE = new Set([...VERIFY_KEYS, 'name', 'phone', 'skills', 'title', 'currentCompany',
  'expYears', 'qualification', 'institution', 'passingYear', 'linkedin', 'github', 'portfolio', 'summary']);

const correctionsSchema = z.object({
  corrections: z.record(z.union([
    z.string().trim().max(600),
    z.number().min(0).max(60),
    z.array(z.string().trim().min(1).max(80)).max(60),
    z.null(),
  ])),
});

export default function registrationDraftRoutes() {
  const r = Router();

  r.post('/registration/drafts',
    (req, res, next) => upload.single('resume')(req, res, (err) => {
      if (!err) return next();
      if (err.code === 'LIMIT_FILE_SIZE') {
        const mb = Math.round(config.maxUploadBytes / 1024 / 1024);
        return next(new ApiError(413, CODES.FILE_TOO_LARGE, `That file is too large. The limit is ${mb}MB.`));
      }
      return next(new ApiError(400, CODES.UPLOAD_FAILED, 'That file could not be uploaded. Please try again.'));
    }),
    wrap(async (req, res) => {
      if (!req.file || !req.file.buffer || !req.file.buffer.length) {
        throw badRequest('Please choose your resume file (PDF, DOC, DOCX or TXT).');
      }
      if (drafts.hit(originOf(req)) > draftLimit()) {
        throw new ApiError(429, CODES.RATE_LIMITED, 'Too many uploads from this connection. Please try again later.');
      }
      const id = 'rd_' + randomBytes(9).toString('hex');
      const token = randomBytes(24).toString('hex');

      /* The file first: whatever happens to the reading, the resume is kept.
         storeResume checks the bytes are the type the name claims. */
      const stored = await storeResume({ candidateId: `draft-${id}`, buffer: req.file.buffer, originalName: req.file.originalname });
      await saveDraft(id, token, {
        status: 'pending',
        resume_file: stored.displayName, resume_storage_path: stored.path,
        resume_mime: stored.mime, resume_size: stored.size, resume_sha256: stored.sha256,
      });
      const d = await runExtraction(id, token, req.file.buffer, req.file.originalname);
      purgeSometimes();
      res.status(201).json({ ...(await view(d)), draftToken: token });
    }));

  r.get('/registration/drafts/:id', wrap(async (req, res) => {
    res.json(await view(await readDraft(req.params.id, tokenOf(req))));
  }));

  r.post('/registration/drafts/:id/retry', wrap(async (req, res) => {
    const token = tokenOf(req);
    const d = await readDraft(req.params.id, token);
    if ((d.attempts || 0) >= 6) {
      throw new ApiError(429, CODES.RATE_LIMITED, 'Please enter the missing information manually.');
    }
    if (!d.resume_storage_path) throw badRequest('Please upload your resume again.');
    const buf = await getStorage().get(d.resume_storage_path);
    res.json(await view(await runExtraction(d.id, token, buf, d.resume_file || 'resume')));
  }));

  r.patch('/registration/drafts/:id', wrap(async (req, res) => {
    const token = tokenOf(req);
    const body = correctionsSchema.safeParse(req.body || {});
    if (!body.success) throw badRequest('Please check the highlighted fields and try again.');
    const problems = {};
    const out = {};
    for (const [k, v] of Object.entries(body.data.corrections)) {
      if (!CORRECTABLE.has(k)) continue;
      if (k === 'name' && v !== null && String(v).trim().length < 2) problems.name = 'Please enter your name.';
      if (k === 'phone' && v && !validIndianMobile(String(v))) problems.phone = 'Please enter a valid 10-digit mobile number.';
      if (k === 'expYears' && v !== null && v !== '' && !Number.isFinite(Number(v))) problems.expYears = 'Enter years as a number.';
      out[k] = k === 'expYears' && v !== null && v !== '' ? Number(v) : v;
    }
    if (Object.keys(problems).length) throw badRequest('Please check the highlighted fields and try again.', problems);
    await readDraft(req.params.id, token);
    res.json(await view(await saveDraft(req.params.id, token, { corrections: out })));
  }));

  r.post('/registration/drafts/:id/email-code', wrap(async (req, res) => {
    const token = tokenOf(req);
    const email = String((req.body && req.body.email) || '').trim();
    if (!EMAIL_RX.test(email) || email.length > 254) {
      throw badRequest('Please enter a valid email address.', { email: 'Please enter a valid email address.' });
    }
    await readDraft(req.params.id, token);
    if ((await taken(email, null)).email) {
      throw new ApiError(409, CODES.EMAIL_TAKEN, 'An account with this email already exists. Please Login.',
        { email: 'An account with this email already exists. Please Login.' });
    }

    const code = String(randomInt(100000, 1000000));
    const n = await withUser(null, async (c) => (await c.query(
      `select registration_email_code_issue($1,$2,$3,$4,10) as n`,
      [req.params.id, hashToken(token), email, codeHash(req.params.id, code)])).rows[0].n);
    if (n === -2) throw notFound('Your registration session has expired. Please upload your resume again.');
    if (n === -1) throw new ApiError(429, CODES.RATE_LIMITED, 'Too many codes requested. Please wait an hour and try again.');

    const text = `Your TeamLink verification code is ${code}. It is valid for 10 minutes. ` +
      'If you did not try to register on TeamLink, you can ignore this email.';
    const sent = await providers.email.send({
      to: email,
      subject: `TeamLink verification code: ${code}`,
      text,
      html: `<p>Your TeamLink verification code is</p><p style="font-size:24px;font-weight:700;letter-spacing:4px">${code}</p>` +
        '<p>It is valid for 10 minutes. If you did not try to register on TeamLink, you can ignore this email.</p>',
    }).catch((err) => ({ status: 'failed', error: err.message }));

    if (sent.status === 'sent') return res.json({ sent: true, email });
    /* Not delivered. Outside production the code is shown on screen, said
       to be a development code, so the flow can be used without a mail
       server. In production the candidate is told plainly. */
    if (!isProd()) {
      return res.json({ sent: false, email, devCode: code,
        note: 'Email is not being sent from this server (development). Use this code.' });
    }
    if (sent.status === 'not_configured' || isReservedTestAddress(email)) {
      throw new ApiError(503, 'EMAIL_UNAVAILABLE', 'We cannot send email right now. Please try again later.');
    }
    throw new ApiError(502, 'EMAIL_FAILED', 'We could not send the code to this address. Please check it and try again.',
      { email: 'We could not send the code to this address.' });
  }));

  r.post('/registration/drafts/:id/verify-email', wrap(async (req, res) => {
    const token = tokenOf(req);
    const email = String((req.body && req.body.email) || '').trim();
    const code = String((req.body && req.body.code) || '').replace(/\D/g, '');
    if (!EMAIL_RX.test(email) || code.length !== 6) {
      throw badRequest('Enter the 6-digit code from the email.', { code: 'Enter the 6-digit code from the email.' });
    }
    const out = await withUser(null, async (c) => (await c.query(
      `select registration_email_code_check($1,$2,$3,$4) as r`,
      [req.params.id, hashToken(token), email, codeHash(req.params.id, code)])).rows[0].r);
    const msg = {
      wrong: 'That code is not right. Please check the email and try again.',
      expired: 'That code has expired. Please request a new one.',
      locked: 'Too many wrong codes. Please request a new one.',
      none: 'Please request a code first.',
    };
    if (out !== 'ok') throw badRequest(msg[out] || msg.none, { code: msg[out] || msg.none });
    res.json(await view(await readDraft(req.params.id, token)));
  }));

  /* ---- the mobile number: a code by SMS (0123) ---------------------------------------- */
  r.post('/registration/drafts/:id/phone-otp', wrap(async (req, res) => {
    const token = tokenOf(req);
    const phone = String((req.body && req.body.phone) || '').trim();
    if (!validIndianMobile(phone)) {
      throw badRequest('Enter a valid 10-digit mobile number.', { phone: 'Enter a valid 10-digit mobile number.' });
    }
    await readDraft(req.params.id, token);
    if ((await taken(null, phone)).phone) {
      throw new ApiError(409, 'PHONE_TAKEN', 'An account with this mobile number already exists. Please Login.',
        { phone: 'An account with this mobile number already exists. Please Login.' });
    }

    const code = String(randomInt(100000, 1000000));
    const n = await withUser(null, async (c) => (await c.query(
      `select registration_phone_otp_issue($1,$2,$3,$4,10) as n`,
      [req.params.id, hashToken(token), phone, codeHash(req.params.id, code)])).rows[0].n);
    if (n === -2) throw notFound('Your registration session has expired. Please upload your resume again.');
    if (n === -3) throw new ApiError(429, CODES.RATE_LIMITED, 'Please wait 30 seconds before asking for another OTP.', { phone: 'Please wait 30 seconds before asking for another OTP.' });
    if (n === -1) throw new ApiError(429, CODES.RATE_LIMITED, 'Too many OTPs requested. Please wait an hour and try again.', { phone: 'Too many OTPs requested. Please try again in an hour.' });

    const text = `${code} is your TeamLink verification code. It is valid for 10 minutes. Do not share it with anyone.`;
    const sent = await providers.sms.send({ to: phone, text, purpose: 'otp', vars: [code, '10'] })
      .catch((err) => ({ status: 'failed', error: err.message }));

    if (sent.status === 'sent') return res.json({ sent: true, phone: registrationPhone10(phone) });
    /* Not delivered. Outside production the code is shown on screen, said to be a development code, so the flow
       can be used without an SMS gateway. In production the candidate is told plainly. */
    if (!isProd()) {
      return res.json({ sent: false, phone: registrationPhone10(phone), devCode: code,
        note: 'SMS is not being sent from this server (development). Use this code.' });
    }
    if (sent.status === 'not_configured') {
      throw new ApiError(503, 'SMS_UNAVAILABLE', 'We cannot send an OTP right now. Please try again later.');
    }
    throw new ApiError(502, 'SMS_FAILED', 'We could not send the OTP to this number. Please check it and try again.',
      { phone: 'We could not send the OTP to this number.' });
  }));

  r.post('/registration/drafts/:id/verify-phone', wrap(async (req, res) => {
    const token = tokenOf(req);
    const phone = String((req.body && req.body.phone) || '').trim();
    const code = String((req.body && req.body.code) || '').replace(/\D/g, '');
    if (!validIndianMobile(phone)) {
      throw badRequest('Enter a valid 10-digit mobile number.', { phone: 'Enter a valid 10-digit mobile number.' });
    }
    if (code.length !== 6) throw badRequest('Enter the 6-digit OTP', { code: 'Enter the 6-digit OTP' });
    const out = await withUser(null, async (c) => (await c.query(
      `select registration_phone_otp_check($1,$2,$3,$4) as r`,
      [req.params.id, hashToken(token), phone, codeHash(req.params.id, code)])).rows[0].r);
    const msg = {
      wrong: 'Invalid OTP', expired: 'That OTP has expired. Please request a new one.',
      locked: 'Too many wrong attempts. Please request a new OTP.', none: 'Please request an OTP first.',
    };
    if (out !== 'ok') throw badRequest(msg[out] || msg.none, { code: msg[out] || msg.none });
    res.json(await view(await readDraft(req.params.id, token)));
  }));

  r.get('/me/profile-completeness', requireAuth(), requireRole('candidate'), wrap(async (req, res) => {
    const out = await withUser(req.session, (c) => completenessFor(c, req.session.profileId));
    if (!out) throw notFound('Profile not found.');
    res.json(out);
  }));

  return r;
}

/* ------------------------------------------------------------------ *
 * the draft, at registration
 * ------------------------------------------------------------------ */

/**
 * Called by POST /auth/register BEFORE the account is created: the draft
 * must exist, be this browser's, and its email must have answered a code.
 * Returns the draft.
 */
export async function draftForRegistration({ draftId, draftToken, phone }) {
  if (!/^[a-f0-9]{48}$/.test(String(draftToken || ''))) {
    throw new ApiError(401, 'DRAFT_TOKEN', 'Your registration session has expired. Please upload your resume again.');
  }
  const d = await readDraft(draftId, draftToken);
  /* THE MOBILE OTP CANNOT BE SKIPPED. The draft must remember that THIS number answered a code
     (phone_verified_at). Checked here, on the server, before anything is written - so calling the
     API directly, or changing the number after verifying, is refused. */
  if (!d.resume_file) {
    throw badRequest('Please upload your resume to register.', { resume: 'Please upload your resume to register.' });
  }
  if (!d.phone_verified_at || registrationPhone10(d.phone) !== registrationPhone10(phone)) {
    throw badRequest('Please verify your mobile number with the OTP first.', { phone: 'Please verify your mobile number with the OTP first.' });
  }
  return d;
}

const registrationPhone10 = (v) => String(v || '').replace(/\D/g, '').slice(-10);

/** Whether an account may ONLY be created through a resume draft with a verified mobile number. */
export function otpRequired() {
  const v = String(process.env.REGISTRATION_OTP_REQUIRED || '').trim();
  if (/^(1|true|yes|on)$/i.test(v)) return true;
  if (/^(0|false|no|off)$/i.test(v)) return false;
  return isProd();
}

const isoDate = (v) => {
  const s = String(v || '').trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return s;
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (m) {
    const [, dd, mm, yy] = m;
    const d = new Date(Date.UTC(+yy, +mm - 1, +dd));
    if (d.getUTCMonth() === +mm - 1 && +yy > 1940 && +yy < new Date().getUTCFullYear() - 14) {
      return `${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
    }
  }
  return null;
};

/**
 * After the account exists: the draft becomes the profile. The resume
 * file and its reading move onto the candidate, the fields the reading
 * was sure of (and those the candidate confirmed) fill the EMPTY columns
 * - applyExtractedFields never overwrites - every education record is
 * kept as its own row, and each field remembers where it came from.
 * Returns the completeness.
 */
export async function finishDraft({ draftId, draftToken, draft, candidateId, session, provided }) {
  const { fields, sources } = acceptedFields(draft.extraction, draft.corrections);
  for (const k of ['name', 'email', 'phone']) delete fields[k];
  /* What the candidate typed on the one-screen form wins over what the reading found: their highest
     qualification, institute and year are the first education record. */
  const typed = draft.corrections || {};
  if (typed.qualification || typed.institution || typed.passingYear) {
    const recs = Array.isArray(fields.educationRecords) ? fields.educationRecords.map((x) => ({ ...x })) : [];
    recs[0] = { ...(recs[0] || {}),
      ...(typed.qualification ? { qualification: String(typed.qualification) } : {}),
      ...(typed.institution ? { institution: String(typed.institution) } : {}),
      ...(typed.passingYear ? { passingYear: String(typed.passingYear) } : {}) };
    fields.educationRecords = recs;
    if (typed.qualification) fields.education = String(typed.qualification);
  }

  const fieldSources = {};
  for (const [k, s] of Object.entries(sources)) {
    const f = EXTRACTION_TO_FIELD[k];
    if (f && fieldSources[f] !== 'USER_PROVIDED') fieldSources[f] = s;
  }
  const ex = (draft.extraction && draft.extraction.fields) || {};
  const same = (a, b) => String(a || '').toLowerCase().replace(/\D/g, '').slice(-10) === String(b || '').toLowerCase().replace(/\D/g, '').slice(-10);
  fieldSources.name = provided.name && ex.name && provided.name.trim().toLowerCase() === String(ex.name).trim().toLowerCase()
    ? 'EXTRACTED' : 'USER_PROVIDED';
  fieldSources.email = ex.email && String(ex.email).toLowerCase() === String(provided.email).toLowerCase()
    ? 'EXTRACTED' : 'USER_PROVIDED';
  fieldSources.phone = provided.phone && ex.phone && same(provided.phone, ex.phone) ? 'EXTRACTED' : 'USER_PROVIDED';
  for (const k of ['location', 'preferredLocation', 'noticePeriod', 'workMode', 'expectedSalary']) {
    fieldSources[k] = 'USER_PROVIDED';
  }
  if (draft.resume_storage_path) fieldSources.resume = 'EXTRACTED';

  const converted = await withUser(null, async (c) => (await c.query(
    `select registration_draft_convert($1,$2,$3,$4::jsonb) as d`,
    [draftId, hashToken(draftToken), candidateId, JSON.stringify(fieldSources)])).rows[0].d);
  if (!converted) throw new Error('the registration draft could not be linked to the new account');

  return withUser(session, async (c) => {
    await applyExtractedFields(c, candidateId, fields);
    const records = Array.isArray(fields.educationRecords) ? fields.educationRecords
      .filter((e) => e && (e.qualification || e.institution)).slice(0, 10) : [];
    if (records.length) {
      const has = (await c.query(`select 1 from candidate_education where candidate_id=$1 limit 1`, [candidateId])).rowCount;
      if (!has) {
        await c.query(`select candidate_records_replace($1, $2::jsonb, null)`, [candidateId, JSON.stringify(records.map((e) => ({
          qualification: e.qualification || e.level || '', specialization: e.specialization || '',
          institution: e.institution || '', passingYear: String(e.passingYear || ''), score: e.score || '',
          educationType: e.educationType || e.level || '',
        })))]);
      }
    }
    const dob = isoDate(fields.dob);
    if (dob) await c.query(`update candidates set date_of_birth = $2 where id = $1 and date_of_birth is null`, [candidateId, dob]);
    return completenessFor(c, candidateId);
  });
}
