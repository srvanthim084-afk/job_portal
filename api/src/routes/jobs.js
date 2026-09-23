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
import { toJob, toJobMatch } from '../shapes.js';
import { runJobAlertsInBackground } from '../notify/job-alerts.js';

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
  postingKind: z.enum(['job', 'walkin', 'internship']).optional(),
  openings: z.number().int().min(1).max(9999).optional(),
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

const COLS = {
  title: 'title', companyId: 'company_id', location: 'location', mode: 'mode',
  exp: 'exp_label', pay: 'pay_label', salaryMin: 'salary_min', salaryMax: 'salary_max',
  type: 'employment_type', hiringType: 'hiring_type', postingKind: 'posting_kind',
  openings: 'openings', source: 'source', department: 'department', education: 'education',
  easyApply: 'easy_apply', featured: 'featured', skills: 'skills', desc: 'description',
  responsibilities: 'responsibilities', requirements: 'requirements', status: 'status',
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

    const out = await withUser(req.session, async (c) => {
      const where = [];
      const params = [];
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
        `select * from ${view} ${clause}
         order by published_at desc nulls last, id
         limit $${params.length - 1} offset $${params.length}`, params);
      return { total: total.rows[0].n, rows: rows.rows };
    });

    res.json({ jobs: out.rows.map(toJob), total: out.total, limit, offset });
  }));

  r.get('/jobs/:id', wrap(async (req, res) => {
    const row = await withUser(req.session, async (c) => {
      const { rows } = await c.query(`select * from jobs_with_counts where id=$1`, [req.params.id]);
      return rows[0];
    });
    // RLS hides an unpublished job from the public, which surfaces here as
    // "not found" — the same answer requirement 24 calls "Job unavailable".
    if (!row) throw new ApiError(404, CODES.JOB_UNAVAILABLE, 'This role is no longer available.');
    res.json({ job: toJob(row) });
  }));

  r.post('/jobs', requireAuth(), requireRole('recruiter', 'admin'), wrap(async (req, res) => {
    const body = parse(jobSchema, req.body);
    const id = (req.body && req.body.id) || newJobId();

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
      const { rows } = await c.query(`select * from jobs_with_counts where id=$1`, [id]);
      return rows[0];
    });

    // A published requirement is matched against every candidate profile
    // and the ones that clear the bar are alerted. In the background: the
    // recruiter asked to save a job, not to wait on five thousand
    // profiles and three messages each.
    const alerts = job.status === 'open' && !job.paused && !job.archived;
    if (alerts) runJobAlertsInBackground(id);

    res.status(201).json({ job: toJob(job), alerting: alerts });
  }));

  /** Edit. Updates in place — never inserts, never changes the id. */
  r.put('/jobs/:id', requireAuth(), requireRole('recruiter', 'admin'), wrap(async (req, res) => {
    const body = parse(jobSchema, req.body);
    const id = req.params.id;

    const job = await withUser(req.session, async (c) => {
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
        const seen = await c.query(`select 1 from jobs where id=$1`, [id]);
        throw seen.rowCount ? forbidden('You cannot edit a job belonging to another company.')
                            : notFound('That job no longer exists.');
      }
      const { rows } = await c.query(`select * from jobs_with_counts where id=$1`, [id]);
      return rows[0];
    });

    res.json({ job: toJob(job) });
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
        const seen = await c.query(`select 1 from jobs where id=$1`, [req.params.id]);
        throw seen.rowCount ? forbidden('You cannot publish a job belonging to another company.')
                            : notFound('That job no longer exists.');
      }
      const { rows } = await c.query(`select * from jobs_with_counts where id=$1`, [req.params.id]);
      return rows[0];
    });

    // Publishing is the moment the job becomes real to candidates, so it
    // is the moment the alerts go out. Unpublishing sends nothing, and a
    // second publish re-runs the matching but will not message anybody
    // who was already told about this job.
    if (publish) runJobAlertsInBackground(req.params.id);

    res.json({ job: toJob(job), alerting: publish });
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

  r.delete('/jobs/:id', requireAuth(), requireRole('admin'), wrap(async (req, res) => {
    await withUser(req.session, (c) => c.query(`delete from jobs where id=$1`, [req.params.id]));
    res.json({ ok: true });
  }));

  return r;
}
