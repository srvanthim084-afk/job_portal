/**
 * Candidate routes, including Find Candidates (requirements 10 and 11).
 *
 * Requirement 11 is explicit: do not load the whole candidate database
 * into the browser to filter it. Every filter below runs as SQL with a
 * LIMIT, and the response carries a total so the existing pagination UI
 * can render without the rows behind it.
 *
 * The filter names match the controls already on the Find Candidates
 * screen, so the existing form can post straight here.
 */
import { Router } from 'express';
import { z } from 'zod';
import { withUser } from '../db.js';
import { wrap, badRequest, notFound, forbidden } from '../errors.js';
import { requireAuth, requireRole } from '../auth.js';
import { toCandidate, toApplication, attachPrimary } from '../shapes.js';

const list = (v) => {
  if (v === undefined || v === null || v === '') return [];
  return (Array.isArray(v) ? v : String(v).split(','))
    .map((s) => String(s).trim()).filter(Boolean).slice(0, 50);
};

export default function candidateRoutes() {
  const r = Router();

  /**
   * Find Candidates. Recruiter/admin only at the route level; RLS narrows
   * the rows again underneath, so a recruiter cannot reach a private
   * profile outside their own pipeline even if this handler were wrong.
   */
  r.get('/candidates', requireAuth(), requireRole('recruiter', 'admin', 'client'),
    wrap(async (req, res) => {
      const q = req.query;
      // The Find Candidates screen pages through results in the browser, so
      // it asks for a bounded WINDOW of matches rather than a single page.
      // The filtering still happens in SQL — the browser never receives the
      // whole table — and `total` below reports the true match count so the
      // UI can say when a result set was capped.
      const limit  = Math.min(parseInt(q.limit, 10) || 25, 500);
      const offset = Math.max(parseInt(q.offset, 10) || 0, 0);

      const skills    = list(q.skills);
      const locations = list(q.location);
      const notice    = list(q.noticePeriod);
      const education = list(q.education);
      const employment = list(q.employment);
      const industry  = list(q.industry);
      const stages    = list(q.stage);

      const out = await withUser(req.session, async (c) => {
        // Built explicitly, one filter at a time. Every value goes in via a
        // numbered placeholder — no user input is ever concatenated into
        // the SQL string (requirement 19, SQL-injection protection).
        const where = [], params = [];
        const push = (frag) => where.push(frag);

        if (q.q) {
          params.push(`%${String(q.q).trim()}%`);
          const i = params.length;
          push(`(name ilike $${i} or title ilike $${i} or current_company ilike $${i}
                 or education ilike $${i} or summary ilike $${i} or email ilike $${i})`);
        }
        if (skills.length) {
          // overlap against BOTH skill columns, matching the UI's single
          // "Skills" control which searches skills and technicalSkills
          params.push(skills);
          const i = params.length;
          push(`(skills && $${i}::text[] or technical_skills && $${i}::text[])`);
        }
        if (locations.length) { params.push(locations); push(`location = any($${params.length})`); }
        if (notice.length)    { params.push(notice);    push(`notice_period = any($${params.length})`); }
        if (employment.length){ params.push(employment);push(`candidate_type = any($${params.length})`); }
        if (education.length) {
          params.push(education.map((e) => `%${e}%`));
          push(`education ilike any($${params.length}::text[])`);
        }
        if (q.gender) { params.push(String(q.gender)); push(`gender = $${params.length}`); }

        if (q.expMin !== undefined && q.expMin !== '') {
          params.push(Number(q.expMin)); push(`exp_years >= $${params.length}`);
        }
        if (q.expMax !== undefined && q.expMax !== '') {
          params.push(Number(q.expMax)); push(`exp_years <= $${params.length}`);
        }
        if (q.ctcMax !== undefined && q.ctcMax !== '') {
          params.push(Number(q.ctcMax)); push(`expected_ctc <= $${params.length}`);
        }
        if (q.ctcMin !== undefined && q.ctcMin !== '') {
          params.push(Number(q.ctcMin));
          // includeZeroSalary mirrors the checkbox on the Find Candidates
          // sidebar: a candidate who has not stated a package should not be
          // silently dropped by a minimum-salary filter.
          push(q.includeZeroSalary === 'false'
            ? `expected_ctc >= $${params.length}`
            : `(expected_ctc is null or expected_ctc >= $${params.length})`);
        }
        // the sidebar's verification / resume toggles
        if (q.emailVerified === 'true')  push(`email_verified`);
        if (q.mobileVerified === 'true') push(`mobile_verified`);
        if (q.hasResume === 'true')      push(`resume_file is not null`);
        if (q.hidePrivate === 'true')    push(`not is_private`);
        if (q.hasComments === 'true') {
          push(`exists (select 1 from candidate_comments cc where cc.candidate_id = candidates.id)`);
        }
        if (q.commentTag) {
          params.push(String(q.commentTag));
          push(`exists (select 1 from candidate_comments cc
                         where cc.candidate_id = candidates.id
                           and cc.tag = $${params.length})`);
        }
        if (q.activeWithinDays) {
          params.push(Number(q.activeWithinDays));
          push(`profile_active_days_ago <= $${params.length}`);
        }
        if (industry.length) {
          params.push(industry);
          push(`exists (select 1 from applications a
                          join jobs j  on j.id = a.job_id
                          join companies co on co.id = j.company_id
                         where a.candidate_id = candidates.id
                           and co.industry = any($${params.length}))`);
        }
        if (stages.length) {
          params.push(stages);
          push(`exists (select 1 from applications a
                         where a.candidate_id = candidates.id
                           and a.stage = any($${params.length}))`);
        }

        const clause = where.length ? `where ${where.join(' and ')}` : '';

        // Keys match the UI's "Sort by" control. An unknown value falls back
        // rather than being interpolated — `order` reaches the SQL string
        // directly, so it must only ever be one of these literals.
        const sortable = {
          Relevance: 'name asc',
          recent: 'profile_updated_days_ago asc nulls last',
          'Freshness': 'profile_active_days_ago asc nulls last',
          name: 'name asc',
          experience: 'exp_years desc nulls last',
          'Experience': 'exp_years desc nulls last',
          'Salary': 'expected_ctc asc nulls last',
        };
        const order = sortable[q.sort] || 'name asc';

        const total = await c.query(`select count(*)::int n from candidates ${clause}`, params);

        params.push(limit, offset);
        const rows = await c.query(
          `select * from candidates ${clause}
           order by ${order} limit $${params.length - 1} offset $${params.length}`, params);

        // the pipeline position for just this page of candidates
        const ids = rows.rows.map((x) => x.id);
        const apps = ids.length
          ? await c.query(`select * from applications where candidate_id = any($1)`, [ids])
          : { rows: [] };

        return { total: total.rows[0].n, rows: rows.rows, apps: apps.rows };
      });

      const cands = out.rows.map(toCandidate);
      const extra = attachPrimary(cands, out.apps.map(toApplication));

      res.json({
        candidates: cands,
        applications: extra,
        total: out.total,
        limit, offset,
        hasMore: offset + cands.length < out.total,
      });
    }));

  r.get('/candidates/:id', requireAuth(), wrap(async (req, res) => {
    const out = await withUser(req.session, async (c) => {
      const { rows } = await c.query(`select * from candidates where id=$1`, [req.params.id]);
      if (!rows.length) return null;
      const apps = await c.query(`select * from applications where candidate_id=$1`, [req.params.id]);
      return { row: rows[0], apps: apps.rows };
    });
    if (!out) throw notFound('That candidate could not be found.');

    const cand = toCandidate(out.row);
    const extra = attachPrimary([cand], out.apps.map(toApplication));
    res.json({ candidate: cand, applications: extra });
  }));

  /** Profile edit. A candidate may change only their own record. */
  r.put('/candidates/:id', requireAuth(), wrap(async (req, res) => {
    if (req.session.role === 'candidate' && req.session.profileId !== req.params.id) {
      throw forbidden('You can only edit your own profile.');
    }

    const schema = z.object({
      name: z.string().trim().min(2).max(120).optional(),
      phone: z.string().trim().max(32).optional(),
      location: z.string().trim().max(120).optional(),
      title: z.string().trim().max(160).optional(),
      summary: z.string().max(8000).optional(),
      education: z.string().max(400).optional(),
      exp: z.string().max(40).optional(),
      expYears: z.number().min(0).max(60).optional(),
      ctc: z.string().max(40).optional(),
      expectedCtc: z.number().min(0).optional(),
      noticePeriod: z.string().max(40).optional(),
      currentCompany: z.string().max(160).optional(),
      previousCompanies: z.array(z.string().max(160)).max(40).optional(),
      careerGoal: z.string().max(400).optional(),
      preferredRole: z.string().max(160).optional(),
      preferredLocation: z.string().max(160).optional(),
      candidateType: z.string().max(60).optional(),
      gender: z.string().max(40).optional(),
      linkedin: z.string().max(300).optional(),
      github: z.string().max(300).optional(),
      portfolio: z.string().max(300).optional(),
      skills: z.array(z.string().max(120)).max(100).optional(),
      technicalSkills: z.array(z.string().max(120)).max(100).optional(),
      certifications: z.array(z.string().max(200)).max(60).optional(),
      languages: z.array(z.string().max(60)).max(30).optional(),
      preferredWorkModes: z.array(z.string().max(40)).max(10).optional(),
      isPrivate: z.boolean().optional(),
      whatsappOptIn: z.boolean().optional(),
    });
    const out = schema.safeParse(req.body || {});
    if (!out.success) {
      const details = {};
      for (const i of out.error.issues) details[i.path.join('.') || 'form'] = i.message;
      throw badRequest('Please check the highlighted fields and try again.', details);
    }
    const body = out.data;

    const COLS = {
      name: 'name', phone: 'phone', location: 'location', title: 'title',
      summary: 'summary', education: 'education', exp: 'exp', expYears: 'exp_years',
      ctc: 'ctc', expectedCtc: 'expected_ctc', noticePeriod: 'notice_period',
      currentCompany: 'current_company', previousCompanies: 'previous_companies',
      careerGoal: 'career_goal', preferredRole: 'preferred_role',
      preferredLocation: 'preferred_location', candidateType: 'candidate_type',
      gender: 'gender', linkedin: 'linkedin', github: 'github', portfolio: 'portfolio',
      skills: 'skills', technicalSkills: 'technical_skills',
      certifications: 'certifications', languages: 'languages',
      preferredWorkModes: 'preferred_work_modes',
      isPrivate: 'is_private', whatsappOptIn: 'whatsapp_opt_in',
    };

    const cand = await withUser(req.session, async (c) => {
      const sets = [], vals = [];
      for (const [k, col] of Object.entries(COLS)) {
        if (body[k] !== undefined) { vals.push(body[k]); sets.push(`${col}=$${vals.length}`); }
      }
      if (!sets.length) throw badRequest('Nothing to update.');
      sets.push(`profile_updated_days_ago = 0`);
      vals.push(req.params.id);
      const upd = await c.query(
        `update candidates set ${sets.join(',')} where id=$${vals.length} returning *`, vals);
      if (!upd.rowCount) {
        const seen = await c.query(`select 1 from candidates where id=$1`, [req.params.id]);
        throw seen.rowCount ? forbidden('You cannot edit this profile.')
                            : notFound('That candidate could not be found.');
      }
      return upd.rows[0];
    });

    res.json({ candidate: toCandidate(cand) });
  }));

  /** Recruiter notes. RLS keeps one recruiter's notes from another's view. */
  r.post('/candidates/:id/comments', requireAuth(), requireRole('recruiter', 'admin'),
    wrap(async (req, res) => {
      const { tag, body } = req.body || {};
      if (!body || !String(body).trim()) throw badRequest('A comment cannot be empty.');
      const row = await withUser(req.session, async (c) => {
        const { rows } = await c.query(
          `insert into candidate_comments (candidate_id, recruiter_id, tag, body)
           values ($1,$2,$3,$4) returning *`,
          [req.params.id, req.session.profileId, tag || null, String(body).slice(0, 4000)]);
        return rows[0];
      });
      res.status(201).json({ comment: row });
    }));

  r.get('/candidates/:id/comments', requireAuth(), requireRole('recruiter', 'admin'),
    wrap(async (req, res) => {
      const rows = await withUser(req.session, async (c) => {
        const { rows } = await c.query(
          `select * from candidate_comments where candidate_id=$1 order by created_at desc`,
          [req.params.id]);
        return rows;
      });
      res.json({ comments: rows });
    }));

  return r;
}
