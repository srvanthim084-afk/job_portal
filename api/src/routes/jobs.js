/**
 * Job routes (requirement 6).
 *
 * The rule that shapes this file: editing a job must UPDATE the existing
 * record and keep the same Job ID. The prototype prints job ids in the UI
 * and every application references one, so a regenerated id on edit would
 * orphan the pipeline. `PUT /jobs/:id` therefore never inserts, and the
 * id column is never in the SET clause.
 */
import { Router } from 'express';
import { z } from 'zod';
import { withUser } from '../db.js';
import { wrap, badRequest, notFound, forbidden, ApiError, CODES } from '../errors.js';
import { requireAuth, requireRole } from '../auth.js';
import { toJob, toJobMatch, toStaffJob, JOB_RECORD_COLS } from '../shapes.js';
import { runJobAlertsInBackground } from '../notify/job-alerts.js';
import { normaliseWalkinBody, checkWalkin } from '../portal/walkin-jobs.js';
import { kickWalkinNotices } from '../notify/walkin-jobs.js';
import { jobsPageScope, teamlinkOnly } from '../jobs/source-scope.js';

/* Who reads the ATS rather than the Jobs page. */
const isStaff = (s) => !!s && ['recruiter', 'admin', 'bde', 'client'].includes(s.role);

const strArr = z.array(z.string().trim().max(200)).max(60).optional();

const jobSchema = z.object({
  title: z.string().trim().min(2, 'A job title is required.').max(160),
  companyId: z.string().trim().min(1).max(64),
  location: z.string().trim().max(120).optional(),
  mode: z.string().trim().max(40).optional(),
  exp: z.string().trim().max(40).optional(),
  pay: z.string().trim().max(60).optional(),
  salaryMin: z.number().nonnegative().optional().nullable(),
  salaryMax: z.number().nonnegative().optional().nullable(),
  type: z.string().trim().max(40).optional(),
  hiringType: z.string().trim().max(40).optional(),
  /*
   * Who the role is open to, and whether the employer houses them.
   *
   * `gender` is OPTIONAL rather than required, deliberately: twenty-five
   * jobs predate this field and an update to any one of them - closing
   * it, changing the pay - would otherwise be refused for not answering
   * a question nobody asked when it was posted. The form requires it for
   * anything new; the API refuses a value that is neither.
   */
  gender: z.union([z.enum(['Female', 'Male']), z.literal(''), z.null()]).optional()
    .transform((v) => (v === '' || v === null ? null : v)),
  accommodation: z.union([z.boolean(), z.string().max(8)]).optional()
    .transform((v) => (v === undefined ? undefined
      : v === true || v === 'true' || v === 'on' || v === '1' || v === 'Yes' || v === 'yes')),
  /* BULK POSTING HAS ALWAYS SENT A FOURTH VALUE. The Manage Jobs screen,
     the saved-search list and the posting-type badge all read
     postingKind === 'bulkHiring', but it was missing from this enum - so
     every bulk-posted job failed validation, the browser kept it in
     memory, and it vanished on the next reload. The recruiter saw the
     jobs until they refreshed and candidates never saw them at all.
     The column itself has no constraint; this was the only thing
     rejecting them. */
  postingKind: z.enum(['job', 'walkin', 'internship', 'bulkHiring']).optional(),
  openings: z.number().int().min(1).max(9999).optional(),

  /* 0083. What makes a walk-in a walk-in and an internship an
     internship. Optional on every posting, because a full-time role
     has none of them - the posting type decides which are asked for,
     and the form does that. */
  walkinDate:    z.string().trim().max(60).optional().or(z.literal('')),
  walkinFrom:    z.string().trim().max(40).optional().or(z.literal('')),
  walkinTo:      z.string().trim().max(40).optional().or(z.literal('')),
  walkinVenue:   z.string().trim().max(400).optional().or(z.literal('')),
  walkinContact: z.string().trim().max(120).optional().or(z.literal('')),
  walkinPhone:   z.string().trim().max(32).optional().or(z.literal('')),
  /* 0106. The rest of a walk-in: where exactly, a map, what to bring,
     anything else to know, and how many seats. */
  walkinAddress:      z.string().trim().max(600).optional().or(z.literal('')),
  walkinMapLink:      z.string().trim().max(600).optional().or(z.literal('')),
  walkinDocuments:    z.string().trim().max(2000).optional().or(z.literal('')),
  walkinInstructions: z.string().trim().max(2000).optional().or(z.literal('')),
  walkinCapacity:     z.union([z.coerce.number().int().min(1).max(100000), z.literal(''), z.null()]).optional()
    .transform((v) => (v === '' ? null : v)),
  /* 0139: the contact's designation; whether the AI interview is part of this walk-in, and the
     final score that makes an applicant eligible (50 unless the job says otherwise) */
  walkinContactDesignation: z.string().trim().max(120).optional().or(z.literal('')),
  walkinAiRequired:  z.boolean().optional(),
  walkinAiThreshold: z.coerce.number().min(0, 'The eligibility threshold is a percentage (0-100).')
    .max(100, 'The eligibility threshold is a percentage (0-100).').optional(),

  internshipDuration: z.string().trim().max(40).optional().or(z.literal('')),
  internshipType:     z.enum(['Paid', 'Unpaid']).optional().or(z.literal('')),
  stipend:            z.coerce.number().min(0).max(100000000).optional(),
  source: z.string().trim().max(80).optional(),
  department: z.string().trim().max(80).optional(),
  education: z.string().trim().max(120).optional(),
  easyApply: z.boolean().optional(),
  featured: z.boolean().optional(),
  skills: strArr,
  desc: z.string().max(20000).optional(),
  responsibilities: strArr,
  requirements: strArr,
  status: z.enum(['open', 'closed', 'draft']).optional(),
}).refine(
  (v) => v.salaryMin == null || v.salaryMax == null || v.salaryMax >= v.salaryMin,
  { message: 'Maximum salary cannot be less than the minimum.', path: ['salaryMax'] }
);

function parse(schema, body) {
  const out = schema.safeParse(body || {});
  if (!out.success) {
    const details = {};
    for (const i of out.error.issues) details[i.path.join('.') || 'form'] = i.message;
    throw badRequest('Please check the highlighted fields and try again.', details);
  }
  return out.data;
}

/** Same shape as the prototype's generated ids, so nothing on screen changes. */
const newJobId = () => 'j_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

import {
  buildJobDescription, buildStructuredJd, buildWalkinPack, buildInternshipPack,
  suggestSkills, isKnownStub,
} from '../ai/jd.js';
import { hiddenError } from '../scope.js';

const COLS = {
  title: 'title', companyId: 'company_id', location: 'location', mode: 'mode',
  exp: 'exp_label', pay: 'pay_label', salaryMin: 'salary_min', salaryMax: 'salary_max',
  type: 'employment_type', hiringType: 'hiring_type', postingKind: 'posting_kind',
  openings: 'openings', source: 'source', department: 'department', education: 'education',
  easyApply: 'easy_apply', featured: 'featured', skills: 'skills', desc: 'description',
  responsibilities: 'responsibilities', requirements: 'requirements', status: 'status',
  /* 0072. Both go through the same map as everything else, so create and
     update persist them without either route knowing they exist. */
  gender: 'gender', accommodation: 'accommodation',
  /* 0083. Same route in: create and update persist them without
     either one knowing they exist. */
  walkinDate: 'walkin_date', walkinFrom: 'walkin_from', walkinTo: 'walkin_to',
  walkinVenue: 'walkin_venue', walkinContact: 'walkin_contact',
  walkinPhone: 'walkin_phone',
  walkinAddress: 'walkin_address', walkinMapLink: 'walkin_map_link',
  walkinDocuments: 'walkin_documents', walkinInstructions: 'walkin_instructions',
  walkinCapacity: 'walkin_capacity',
  walkinContactDesignation: 'walkin_contact_designation',
  walkinAiRequired: 'walkin_ai_required', walkinAiThreshold: 'walkin_ai_threshold',
  internshipDuration: 'internship_duration', internshipType: 'internship_type',
  stipend: 'stipend',
};

export default function jobRoutes() {
  const r = Router();

  /** Public board. Anonymous callers see only open roles — enforced by RLS. */
  r.get('/jobs', wrap(async (req, res) => {
    const limit  = Math.min(parseInt(req.query.limit, 10) || 100, 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const q      = (req.query.q || '').trim();
    const loc    = (req.query.location || '').trim();
    const view   = req.query.view === 'all' ? 'jobs_with_counts' : 'jobs_open';
    /* 0113: the Jobs page is TeamLink jobs only - refused, not widened,
       for any other ?sourceType=. Staff reading their whole desk
       (?view=all) still see every row they are allowed by RLS. */
    jobsPageScope(req);
    const staffAll = view === 'jobs_with_counts' && isStaff(req.session);

    const out = await withUser(req.session, async (c) => {
      const where = [];
      const params = [];
      if (!staffAll) where.push(teamlinkOnly());
      if (q) {
        params.push(`%${q}%`);
        where.push(`(title ilike $${params.length} or $${params.length} = any(skills))`);
      }
      if (loc) { params.push(`%${loc}%`); where.push(`location ilike $${params.length}`); }

      /*
       * A recruiter's list is their own desk.
       *
       * An OPEN requirement is a public posting - the job board shows it
       * to anybody, signed in or not - so row-level security cannot hide
       * it, and should not: hiding an advertisement from a colleague
       * while showing it to the world is incoherent. But the recruiter's
       * own Jobs screen is not the job board, and it was listing every
       * open requirement in the company as if each one were theirs.
       *
       * `?mine=all` opts back in, for a screen that genuinely wants the
       * whole board.
       */
      if (req.session && req.session.role === 'recruiter'
          && req.query.mine !== 'all' && req.session.profileId) {
        params.push(req.session.profileId);
        where.push(`recruiter_id = $${params.length}`);
      }

      const clause = where.length ? `where ${where.join(' and ')}` : '';

      const total = await c.query(`select count(*)::int n from ${view} ${clause}`, params);
      params.push(limit, offset);
      const rows = await c.query(
        `select *, ${JOB_RECORD_COLS} from ${view} ${clause}
         order by published_at desc nulls last, id
         limit $${params.length - 1} offset $${params.length}`, params);
      return { total: total.rows[0].n, rows: rows.rows };
    });

    res.json({ jobs: out.rows.map(isStaff(req.session) ? toStaffJob : toJob), total: out.total, limit, offset });
  }));

  r.get('/jobs/:id', wrap(async (req, res) => {
    const row = await withUser(req.session, async (c) => {
      /* 0113: a candidate or visitor opens TeamLink jobs here; an
         external job's details are /api/portal/external-jobs/:id. */
      const { rows } = await c.query(
        `select *, ${JOB_RECORD_COLS} from jobs_with_counts where id=$1 ${isStaff(req.session) ? '' : `and ${teamlinkOnly()}`}`,
        [req.params.id]);
      return rows[0];
    });
    // RLS hides an unpublished job from the public, which surfaces here as
    // "not found" — the same answer requirement 24 calls "Job unavailable".
    // For staff, a job that exists but is another recruiter's is a 403 (0118).
    if (!row) {
      throw await hiddenError(req.session, 'job', req.params.id,
        new ApiError(404, CODES.JOB_UNAVAILABLE, 'This role is no longer available.'));
    }
    res.json({ job: isStaff(req.session) ? toStaffJob(row) : toJob(row) });
  }));

  r.post('/jobs', requireAuth(), requireRole('recruiter', 'admin'), wrap(async (req, res) => {
    const body = parse(jobSchema, normaliseWalkinBody(req.body));
    // 0106: a walk-in is checked here, whichever screen sent it.
    checkWalkin(body, null);
    const id = (req.body && req.body.id) || newJobId();

    /*
     * THE DESCRIPTION IS WRITTEN HERE, FOR EVERY WAY IN.
     *
     * Five screens create jobs - the post form, bulk paste, walk-in,
     * internship, and the requirement raised automatically when somebody
     * applies for a role nobody posted - and each supplied a different
     * description or none at all. Bulk sent "Opening for Staff Nurse at
     * our team."; the automatic one sent a note addressed to the
     * recruiter, sitting in the field a candidate reads. Doing it here
     * means one JD for all of them, and a sixth screen added later gets
     * it without knowing this exists.
     *
     * A DESCRIPTION SOMEBODY ACTUALLY WROTE IS LEFT ALONE. Past
     * WRITTEN_JD_CHARS it is treated as the recruiter's own words and not
     * touched. Below that it is treated as a stub or a logistics line -
     * a walk-in's venue and date, an internship's duration - and is kept
     * VERBATIM as the closing note of the generated JD, so nothing a
     * screen supplied is ever lost.
     */
    const WRITTEN_JD_CHARS = 400;
    const original = String(body.desc || '').trim();
    if (original.length < WRITTEN_JD_CHARS) {
      const generated = buildJobDescription({
        title: body.title, location: body.location, skills: body.skills,
        exp: body.exp, education: body.education, openings: body.openings,
        postingKind: body.postingKind || body.type,
        /* Kept unless it is one of OUR stubs. A short note is not a job
           description, but it is often the only place a walk-in venue or an
           internship stipend is recorded - discarding it on LENGTH threw
           both away. */
        note: isKnownStub(original) ? '' : original,
      });
      body.desc = generated.description;
      if (!Array.isArray(body.responsibilities) || body.responsibilities.length < 2) {
        body.responsibilities = generated.responsibilities;
      }
      if (!Array.isArray(body.requirements) || body.requirements.length < 2) {
        body.requirements = generated.requirements;
      }
    }

    const job = await withUser(req.session, async (c) => {
      const cols = ['id'], vals = [id], ph = ['$1'];
      for (const [k, col] of Object.entries(COLS)) {
        if (body[k] !== undefined) { cols.push(col); vals.push(body[k]); ph.push(`$${vals.length}`); }
      }
      if (req.session.role === 'recruiter') {
        cols.push('recruiter_id'); vals.push(req.session.profileId); ph.push(`$${vals.length}`);
      }
      if (body.status === 'open') {
        cols.push('published_at'); vals.push(new Date()); ph.push(`$${vals.length}`);
      }
      await c.query(`insert into jobs (${cols.join(',')}) values (${ph.join(',')})`, vals);
      const { rows } = await c.query(`select *, ${JOB_RECORD_COLS} from jobs_with_counts where id=$1`, [id]);
      return rows[0];
    });

    // A published requirement is matched against every candidate profile
    // and the ones that clear the bar are alerted. In the background: the
    // recruiter asked to save a job, not to wait on five thousand
    // profiles and three messages each.
    const alerts = job.status === 'open' && !job.paused && !job.archived;
    if (alerts) runJobAlertsInBackground(id);

    res.status(201).json({ job: toStaffJob(job), alerting: alerts });
  }));

  /**
   * POST /api/jobs/describe — write a JD without creating anything.
   *
   * Bulk posting shows the recruiter what will be published BEFORE it is,
   * so the description has to exist before the job does. Nothing is
   * written by this route; it is the same generator the create route
   * uses, exposed so the preview and the stored record cannot disagree.
   *
   * Takes one posting or a list, and answers in the same shape.
   */
  r.post('/jobs/describe', requireAuth(), requireRole('recruiter', 'bde', 'admin'),
    wrap(async (req, res) => {
      const list = Array.isArray(req.body?.jobs) ? req.body.jobs
        : req.body?.job ? [req.body.job]
        : req.body?.title ? [req.body] : null;
      if (!list || !list.length) throw badRequest('Send a job, or a list of jobs.');
      if (list.length > 200) throw badRequest('Send at most 200 jobs in one request.');

      const out = list.map((j) => {
        /* A walk-in answers different questions - where, when, what to
           carry - so it gets its own sections rather than a vacancy JD
           with the venue buried in a paragraph. */
        if (String(j.kind || j.postingKind || '').toLowerCase().includes('walk')) {
          const w = buildWalkinPack({
            title: j.title, department: j.department, location: j.location,
            date: j.date, startTime: j.startTime, endTime: j.endTime, venue: j.venue,
            exp: j.exp, qualification: j.qualification || j.education,
            pay: j.pay, skills: j.skills,
          });
          return { title: j.title || '', kind: 'walkin', ...w };
        }
        /* An internship answers "what will I learn and what happens
           next", which a vacancy JD has no section for. */
        if (String(j.kind || j.postingKind || '').toLowerCase().includes('intern')) {
          const p = buildInternshipPack({
            title: j.title, department: j.department, location: j.location,
            duration: j.duration, stipend: j.stipend, workMode: j.workMode,
            internshipType: j.internshipType,
            qualification: j.qualification || j.education,
            openings: j.openings, skills: j.skills,
          });
          return { title: j.title || '', kind: 'internship', ...p };
        }
        const jd = buildStructuredJd({
          title: j.title, department: j.department, location: j.location,
          skills: j.skills, exp: j.exp, expMin: j.expMin, expMax: j.expMax,
          qualification: j.qualification || j.education,
          openings: j.openings, postingKind: j.postingKind || j.type,
        });
        return {
          title: j.title || '',
          summary: jd.summary,
          about: jd.about,
          responsibilities: jd.responsibilities,
          qualifications: jd.qualifications,
          skills: jd.skills,
          preferredSkills: jd.preferredSkills,
          description: jd.description,
          /* Offered only when the caller asked; an empty list is the
             honest answer for a role we have no vocabulary for. */
          suggestedSkills: j.suggestSkills ? suggestSkills(j) : [],
          family: jd.family,
        };
      });

      res.json({ jobs: out });
    }));

  /** Edit. Updates in place — never inserts, never changes the id. */
  r.put('/jobs/:id', requireAuth(), requireRole('recruiter', 'admin'), wrap(async (req, res) => {
    const body = parse(jobSchema, normaliseWalkinBody(req.body));
    const id = req.params.id;

    const job = await withUser(req.session, async (c) => {
      // 0106: what the walk-in was before this edit, so only a CHANGE is
      // held to today's rules (a date may not move into the past; a full
      // address is needed once the details are edited).
      const before = (await c.query(
        `select posting_kind, status, walkin_date, walkin_from, walkin_to, walkin_venue,
                walkin_address, walkin_map_link, walkin_documents, walkin_instructions,
                walkin_contact, walkin_phone, walkin_capacity,
                walkin_registered_count(id) as registered
           from jobs where id=$1`, [id])).rows[0];
      if (before) checkWalkin(body, before);
      const sets = [], vals = [];
      for (const [k, col] of Object.entries(COLS)) {
        if (body[k] !== undefined) { vals.push(body[k]); sets.push(`${col}=$${vals.length}`); }
      }
      if (!sets.length) throw badRequest('Nothing to update.');
      vals.push(id);
      const upd = await c.query(
        `update jobs set ${sets.join(',')} where id=$${vals.length} returning id`, vals);
      // Zero rows means RLS refused it — another company's job.
      if (!upd.rowCount) {
        const seen = await c.query(`select app_row_exists('job',$1) as e`, [id]);
        throw seen.rows[0].e ? forbidden('You cannot edit a job that is not yours.')
                             : notFound('That job no longer exists.');
      }
      const { rows } = await c.query(`select *, ${JOB_RECORD_COLS} from jobs_with_counts where id=$1`, [id]);
      return rows[0];
    });

    // A walk-in closed before its date tells its applicants (0106).
    kickWalkinNotices();
    res.json({ job: toStaffJob(job) });
  }));

  /** Publish / unpublish — the candidate portal reads the database state. */
  r.post('/jobs/:id/publish', requireAuth(), requireRole('recruiter', 'admin'), wrap(async (req, res) => {
    const publish = req.body?.publish !== false;
    const job = await withUser(req.session, async (c) => {
      const upd = await c.query(
        `update jobs
            set status = $1,
                paused = false,
                published_at = case when $1='open' and published_at is null then now()
                                    else published_at end
          where id = $2 returning id`,
        [publish ? 'open' : 'draft', req.params.id]);
      if (!upd.rowCount) {
        const seen = await c.query(`select app_row_exists('job',$1) as e`, [req.params.id]);
        throw seen.rows[0].e ? forbidden('You cannot publish a job that is not yours.')
                             : notFound('That job no longer exists.');
      }
      const { rows } = await c.query(`select *, ${JOB_RECORD_COLS} from jobs_with_counts where id=$1`, [req.params.id]);
      return rows[0];
    });

    // Publishing is the moment the job becomes real to candidates, so it
    // is the moment the alerts go out. Unpublishing sends nothing, and a
    // second publish re-runs the matching but will not message anybody
    // who was already told about this job.
    if (publish) runJobAlertsInBackground(req.params.id);
    else kickWalkinNotices();

    res.json({ job: toStaffJob(job), alerting: publish });
  }));

  /**
   * GET /api/job-matches?jobId=&candidateId=
   *
   * The ATS record the alerts produce: who was matched, what they scored,
   * which skills matched, what was sent on each channel, whether they
   * clicked and whether they applied. RLS decides who may read a row.
   */
  r.get('/job-matches', requireAuth(), wrap(async (req, res) => {
    const { jobId, candidateId, notifiedOnly } = req.query;

    const rows = await withUser(req.session, async (c) => {
      const where = [], vals = [];
      if (jobId)       { vals.push(jobId);       where.push(`m.job_id=$${vals.length}`); }
      if (candidateId) { vals.push(candidateId); where.push(`m.candidate_id=$${vals.length}`); }
      if (notifiedOnly === 'true') where.push('m.notified');
      const clause = where.length ? `where ${where.join(' and ')}` : '';

      return (await c.query(
        `select m.*, c.name as candidate_name, c.email as candidate_email,
                c.phone as candidate_phone, j.title as job_title
           from job_matches m
           join candidates c on c.id = m.candidate_id
           join jobs j       on j.id = m.job_id
           ${clause}
          order by m.score desc, m.matched_at desc
          limit 500`, vals)).rows;
    });

    res.json({ jobMatches: rows.map(toJobMatch) });
  }));

  /**
   * POST /api/job-matches/:id/clicked
   *
   * The candidate opened the job from the alert. Unauthenticated on
   * purpose: the click happens when they follow the link from their
   * email, which is before they log in, and the id is the only thing it
   * can act on - it records a timestamp and reveals nothing.
   */
  r.post('/job-matches/:id/clicked', wrap(async (req, res) => {
    await withUser({ userId: '', role: 'anon' },
      (c) => c.query(`select job_match_clicked($1)`, [req.params.id]))
      .catch((err) => { console.error('[alerts] click not recorded:', err.message); });
    res.json({ ok: true });
  }));

  /**
   * GET /api/admin/job-source-audit - how every job is classified (0113):
   * per dataset, source type and source name, open and in total, and the
   * classification log (the first audit and any reclassification).
   */
  r.get('/admin/job-source-audit', requireAuth(), requireRole('admin'), wrap(async (req, res) => {
    const out = await withUser(req.session, async (c) => ({
      summary: (await c.query(`select * from job_source_summary()`)).rows.map((x) => ({
        dataset: x.dataset, sourceType: x.source_type, sourceName: x.source_name,
        open: Number(x.open_jobs), total: Number(x.all_jobs),
      })),
      log: (await c.query(
        `select job_id, source_type, source_name, reason, audited_at from job_source_audit
          order by audited_at desc, id desc limit 500`)).rows.map((x) => ({
        jobId: x.job_id, sourceType: x.source_type, sourceName: x.source_name, reason: x.reason,
        at: new Date(x.audited_at).toISOString(),
      })),
    }));
    res.json(out);
  }));

  /**
   * POST /api/jobs/:id/archive  { archived: true | false }
   *
   * Archive (out of every list a candidate sees, kept with its applications and history) or restore.
   * The same rule as publishing: a recruiter their own jobs (row level security), an admin any. The 0125
   * trigger records it in the audit log as the person who did it.
   */
  r.post('/jobs/:id/archive', requireAuth(), requireRole('recruiter', 'admin'), wrap(async (req, res) => {
    const archived = req.body?.archived !== false;
    const job = await withUser(req.session, async (c) => {
      const upd = await c.query(`update jobs set archived = $1 where id = $2 returning id`, [archived, req.params.id]);
      if (!upd.rowCount) {
        const seen = await c.query(`select app_row_exists('job',$1) as e`, [req.params.id]);
        throw seen.rows[0].e ? forbidden('You cannot archive a job that is not yours.')
                             : notFound('That job no longer exists.');
      }
      const { rows } = await c.query(`select *, ${JOB_RECORD_COLS} from jobs_with_counts where id=$1`, [req.params.id]);
      return rows[0];
    });
    res.json({ job: toStaffJob(job) });
  }));

  r.delete('/jobs/:id', requireAuth(), requireRole('admin'), wrap(async (req, res) => {
    await withUser(req.session, (c) => c.query(`delete from jobs where id=$1`, [req.params.id]));
    res.json({ ok: true });
  }));

  return r;
}
