/**
 * The application form (0106) - Apply Now on every TeamLink job.
 *
 *   POST /api/applications/form     submit the form (signed-in candidate)
 *
 * The form is a front door, not a second way of applying: after its own
 * checks it hands the request to the ordinary POST /api/applications
 * (as one-click apply does), so the last-date guard, the hourly limit,
 * the duplicate check, the walk-in capacity lock, the screening answers,
 * the notifications and the AI screening all happen exactly once, in
 * the one place they already live.
 *
 * Its own checks, all on the server:
 *   - every required field, a 10-digit Indian mobile, a real email;
 *   - a resume on file (the form uploads it first, PDF/DOC/DOCX, 5 MB);
 *   - a honeypot field no person fills in, and a per-IP and a
 *     per-mobile/email rate limit;
 *   - the typed mobile and email: when both point at ANOTHER account the
 *     candidate is asked to sign in with it; when they point at different
 *     people, the application is saved against the signed-in candidate
 *     and a recruiter review is opened - never merged automatically.
 *
 * After the application exists: what was typed is stored with it
 * (application_form_details), and the profile is updated with the
 * non-empty values only - an empty box never wipes a saved value.
 */
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { withUser } from '../db.js';
import { requireAuth, requireRole } from '../auth.js';
import { wrap, badRequest, notFound, ApiError, CODES } from '../errors.js';
import { toCandidate } from '../shapes.js';
import { isMobile, tenDigits } from '../portal/walkin-jobs.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const tooMany = (msg) => (_req, _res, next) => next(new ApiError(429, CODES.RATE_LIMITED, msg));

/* Per IP: generous for a shared office connection, useless to a script. */
const ipLimiter = rateLimit({
  windowMs: 10 * 60_000,
  max: () => Number(process.env.APPLY_FORM_IP_PER_10MIN || 40),
  standardHeaders: true,
  legacyHeaders: false,
  handler: tooMany('Too many applications from this connection. Please wait a few minutes and try again.'),
});

/* Per typed mobile / email, across accounts: the same number cannot be
   used to flood applications from many sign-ups. In memory, per process -
   the per-candidate hourly limit (0095) is the durable one. */
const contactHits = new Map();
function contactLimited(keys, now = Date.now()) {
  const max = Number(process.env.APPLY_FORM_CONTACT_PER_HOUR || 20);
  const windowMs = 60 * 60_000;
  let limited = false;
  for (const k of keys) {
    if (!k) continue;
    const list = (contactHits.get(k) || []).filter((t) => now - t < windowMs);
    if (list.length >= max) limited = true;
    contactHits.set(k, list);
  }
  if (!limited) for (const k of keys) if (k) contactHits.get(k).push(now);
  if (contactHits.size > 5000) {
    for (const [k, list] of contactHits) if (!list.some((t) => now - t < windowMs)) contactHits.delete(k);
  }
  return limited;
}

const text = (max) => z.string().trim().max(max).optional().or(z.literal(''));

const formSchema = z.object({
  jobId: z.string().trim().min(1).max(64),
  name: z.string().trim().min(2, 'Please enter your full name.').max(120),
  mobile: z.string().trim().max(20),
  email: z.string().trim().max(160),
  currentLocation: z.string().trim().min(2, 'Please enter your current location.').max(160),
  preferredLocation: text(160),
  qualification: z.string().trim().min(2, 'Please choose your highest qualification.').max(160),
  specialization: text(160),
  experienceYears: z.union([z.coerce.number().min(0).max(60), z.literal('')])
    .refine((v) => v !== '', 'Please enter your years of experience (0 for a fresher).'),
  currentSalary: text(40),
  expectedSalary: z.union([z.coerce.number().min(0).max(1000), z.literal(''), z.null()]).optional(),
  noticePeriod: z.string().trim().min(1, 'Please choose your notice period.').max(40),
  source: z.string().trim().max(80).optional(),
  answers: z.array(z.object({ questionId: z.string().trim().min(1).max(64), answer: z.any() })).max(12).optional(),
  saveScreeningDefaults: z.boolean().optional(),
  /* The honeypot. Hidden from people; a form-filling bot fills it. */
  website: z.string().max(400).optional(),
});

function parse(body) {
  const out = formSchema.safeParse(body || {});
  const details = {};
  if (!out.success) {
    for (const i of out.error.issues) details[i.path.join('.') || 'form'] = i.message;
  }
  const b = body || {};
  if (!details.mobile && !isMobile(b.mobile)) details.mobile = 'Enter a valid 10-digit mobile number.';
  if (!details.email && !EMAIL_RE.test(String(b.email || '').trim())) details.email = 'Enter a valid email address.';
  if (Object.keys(details).length) {
    throw badRequest(Object.values(details)[0], details);
  }
  return out.data;
}

const expLabel = (y) => {
  const n = Number(y);
  if (!Number.isFinite(n)) return null;
  if (n === 0) return 'Fresher';
  return `${n % 1 ? n : Math.round(n)} yr${n === 1 ? '' : 's'}`;
};

export default function applyFormRoutes() {
  const r = Router();

  r.post('/applications/form', requireAuth(), requireRole('candidate'), ipLimiter, wrap(async (req, res, next) => {
    // A filled honeypot is not a person. Refused like any bad form,
    // without saying why, and nothing is written.
    if (req.body && typeof req.body.website === 'string' && req.body.website.trim() !== '') {
      throw badRequest('Your application could not be submitted. Please reload the page and try again.', { form: 'rejected' });
    }
    const f = parse(req.body);
    const mobile = tenDigits(f.mobile);
    const email = f.email.trim().toLowerCase();
    if (contactLimited([`m:${mobile}`, `e:${email}`])) {
      throw new ApiError(429, CODES.RATE_LIMITED,
        'Too many applications with this mobile number or email. Please try again later.');
    }

    const pre = await withUser(req.session, async (c) => ({
      cand: (await c.query(`select * from candidates where id=$1`, [req.session.profileId])).rows[0],
      job: (await c.query(`select id, title, posting_kind from jobs where id=$1`, [f.jobId])).rows[0],
      who: (await c.query(`select * from apply_identity_check($1,$2)`, [mobile, email])).rows[0],
    }));
    if (!pre.cand) throw notFound('Your profile could not be found.');
    if (!pre.job) throw new ApiError(404, CODES.JOB_UNAVAILABLE, 'This role is no longer available.');
    if (!pre.cand.resume_file) {
      throw badRequest('Please upload your resume (PDF, DOC or DOCX, up to 5 MB).', { resume: 'Please upload your resume.' });
    }

    /* Whose details are these? */
    const w = pre.who || {};
    const others = Number(w.phone_other_accounts || 0) + Number(w.email_other_accounts || 0)
      + Number(w.phone_other_records || 0) + Number(w.email_other_records || 0);
    if (w.one_other_account && !w.phone_self && !w.email_self) {
      /* Both (or the only matched) detail belong to one other account:
         that is this person's account. Sign in with it rather than make a
         second record of the same person. */
      throw new ApiError(409, 'IDENTITY_OTHER_ACCOUNT',
        'This mobile number or email is already registered with another TeamLink account. '
        + 'Please log in with that account to apply, or enter your own details.',
        { mobile: Number(w.phone_other_accounts) > 0, email: Number(w.email_other_accounts) > 0 });
    }
    const reviewReason = others > 0
      ? (Number(w.phone_other_accounts || 0) + Number(w.phone_other_records || 0) > 0
          && (w.email_self || Number(w.email_other_accounts || 0) + Number(w.email_other_records || 0) > 0)
          ? 'mobile and email match different candidate records'
          : Number(w.phone_other_accounts || 0) + Number(w.phone_other_records || 0) > 0
            ? 'mobile matches another candidate record'
            : 'email matches another candidate record')
      : null;
    const phoneIsOthers = Number(w.phone_other_accounts || 0) + Number(w.phone_other_records || 0) > 0;
    const emailIsOthers = Number(w.email_other_accounts || 0) + Number(w.email_other_records || 0) > 0;
    const jobType = pre.job.posting_kind === 'walkin' ? 'walk-in' : 'regular';

    /* After the application exists (2xx from POST /applications): the
       form, the review, the profile. A failure here is logged and does
       not undo an application that was made. */
    const json = res.json.bind(res);
    res.json = (out) => {
      if (res.statusCode < 200 || res.statusCode >= 300 || !out || !out.application) return json(out);
      const appId = out.application.id;
      const form = {
        name: f.name, mobile, email, currentLocation: f.currentLocation,
        preferredLocation: f.preferredLocation || '', qualification: f.qualification,
        specialization: f.specialization || '', experienceYears: f.experienceYears,
        currentSalary: f.currentSalary || '', expectedSalary: f.expectedSalary == null ? '' : f.expectedSalary,
        noticePeriod: f.noticePeriod, resumeFile: pre.cand.resume_file || '',
      };
      (async () => {
        let review = false;
        let updated = [];
        let candidate = null;
        try {
          review = !!(await withUser(req.session, (c) => c.query(
            `select application_form_save($1,$2,$3::jsonb,$4) as review`,
            [appId, jobType, JSON.stringify(form), reviewReason]))).rows[0].review;
        } catch (err) {
          console.error('[apply-form] could not store the form:', err.message);
        }
        try {
          const cur = pre.cand;
          const set = {};
          const differs = (col, v) => v != null && String(v).trim() !== '' && String(cur[col] ?? '').trim() !== String(v).trim();
          if (differs('name', f.name)) set.name = f.name;
          if (!phoneIsOthers && tenDigits(cur.phone) !== mobile) set.phone = mobile;
          if (!emailIsOthers && !String(cur.email || '').trim()) set.email = email;
          if (differs('location', f.currentLocation)) set.location = f.currentLocation;
          if (differs('preferred_location', f.preferredLocation)) set.preferred_location = f.preferredLocation;
          if (differs('education', f.qualification)) set.education = f.qualification;
          if (f.experienceYears !== '' && f.experienceYears != null
              && Number(cur.exp_years) !== Number(f.experienceYears)) {
            set.exp_years = Number(f.experienceYears);
            set.exp = expLabel(f.experienceYears);
          }
          if (differs('ctc', f.currentSalary)) set.ctc = f.currentSalary;
          if (f.expectedSalary != null && f.expectedSalary !== ''
              && Number(cur.expected_ctc) !== Number(f.expectedSalary)) set.expected_ctc = Number(f.expectedSalary);
          if (differs('notice_period', f.noticePeriod)) set.notice_period = f.noticePeriod;
          updated = Object.keys(set);
          candidate = await withUser(req.session, async (c) => {
            if (updated.length) {
              const cols = updated.map((k, i) => `${k}=$${i + 2}`);
              await c.query(`update candidates set ${cols.join(',')}, updated_at=now() where id=$1`,
                [req.session.profileId, ...updated.map((k) => set[k])]);
            }
            return (await c.query(`select * from candidates where id=$1`, [req.session.profileId])).rows[0];
          });
        } catch (err) {
          console.error('[apply-form] could not update the profile:', err.message);
          updated = [];
        }
        return json({
          ...out,
          form: { jobType, identityReview: review, profileUpdated: updated },
          candidate: candidate ? toCandidate(candidate) : undefined,
        });
      })().catch((err) => {
        console.error('[apply-form] after-apply step failed:', err.message);
        json(out);
      });
      return res;
    };

    req.body = {
      jobId: f.jobId,
      source: f.source || 'teamlink',
      ...(f.answers ? { answers: f.answers } : {}),
      ...(f.saveScreeningDefaults !== undefined ? { saveScreeningDefaults: f.saveScreeningDefaults } : {}),
    };
    req.applyForm = true;
    req.url = '/applications';
    next();
  }));

  /**
   * GET /api/candidate-identity-reviews?applicationId=&status=open
   *
   * The possible duplicates the form found (mobile and email pointing at
   * different candidate records), for the recruiter who can see the
   * application and for admins. RLS decides which rows come back.
   */
  r.get('/candidate-identity-reviews', requireAuth(), requireRole('recruiter', 'admin'), wrap(async (req, res) => {
    const where = [], vals = [];
    if (req.query.applicationId) { vals.push(String(req.query.applicationId)); where.push(`application_id = $${vals.length}`); }
    if (req.query.status === 'open' || req.query.status === 'resolved') { vals.push(req.query.status); where.push(`status = $${vals.length}`); }
    const rows = await withUser(req.session, async (c) => (await c.query(
      `select * from candidate_identity_reviews ${where.length ? `where ${where.join(' and ')}` : ''}
        order by created_at desc limit 200`, vals)).rows);
    res.json({
      reviews: rows.map((x) => ({
        id: Number(x.id), applicationId: x.application_id, candidateId: x.candidate_id,
        typedMobile: x.typed_mobile, typedEmail: x.typed_email,
        mobileCandidateIds: x.mobile_candidate_ids || [], emailCandidateIds: x.email_candidate_ids || [],
        reason: x.reason, status: x.status, createdAt: x.created_at,
      })),
    });
  }));

  return r;
}
