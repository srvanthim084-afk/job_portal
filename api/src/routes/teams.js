/**
 * Teams (0118): who works for which Team Lead, what a TL sees of them,
 * and the one admin setting for the contact cooldown.
 *
 *   Admin
 *     GET   /api/admin/teams                        TLs with their recruiters (search + filters)
 *     POST  /api/admin/teams/assign                 recruiter -> TL (+ department); also reassigns
 *     POST  /api/admin/teams/unassign               remove the current assignment
 *     POST  /api/admin/recruiters/:id/team-lead     make / stop being a TL
 *     PATCH /api/admin/recruiters/:id               login email, department
 *     GET   /api/admin/recruiters/:id/assignments   the assignment history
 *     GET   /api/admin/contact-cooldown             Candidate Contact Cooldown (days)
 *     PUT   /api/admin/contact-cooldown
 *
 *   Team Lead (a recruiter with is_team_lead)
 *     GET   /api/team/summary?range=today|7d|30d|custom&from=&to=
 *     GET   /api/team/recruiters/:id?range=...      one recruiter: jobs, contact activity
 *     GET   /api/team/recruiters/:id/jobs/:jobId/applicants
 *
 * EVERY NUMBER IS A DATABASE AGGREGATE over rows the caller's own rights
 * can read (row level security) AND the caller's current team (explicit
 * app_team_recruiter_ids()), so a count cannot include what a list could
 * not show. Nothing here trusts an id from the browser: a recruiter who is
 * not on the caller's team is a 403, a recruiter that does not exist is a
 * 404.
 */
import { Router } from 'express';
import { z } from 'zod';
import { withUser } from '../db.js';
import { wrap, badRequest, notFound, forbidden, conflict, ApiError } from '../errors.js';
import { requireAuth, requireRole } from '../auth.js';

const parse = (schema, body) => {
  const out = schema.safeParse(body || {});
  if (out.success) return out.data;
  const details = {};
  for (const i of out.error.issues) details[i.path.join('.') || 'form'] = i.message;
  throw badRequest('Please check the highlighted fields and try again.', details);
};

const iso = (v) => (v ? new Date(v).toISOString() : null);
const num = (v) => Number(v || 0);
const statusOf = (s) => (s === 'active' ? 'active' : 'inactive');

/* The portal's display timezone for "today" (India). Stored times are UTC. */
const TZ_MIN = Number(process.env.DISPLAY_TZ_OFFSET_MINUTES || 330);
const DAY = 86400000;

/**
 * range=today | 7d | 30d | custom (from, to as YYYY-MM-DD, both inclusive).
 * Returns [fromInstant, toInstant) as ISO strings.
 */
export function rangeOf(q, now = new Date()) {
  const local = new Date(now.getTime() + TZ_MIN * 60000);
  const startOfToday = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - TZ_MIN * 60000;
  const kind = String(q.range || '7d');
  let from; let to = startOfToday + DAY;
  if (kind === 'today') from = startOfToday;
  else if (kind === '30d') from = startOfToday - 29 * DAY;
  else if (kind === 'custom') {
    const ok = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
    if (!ok(q.from) || !ok(q.to)) throw badRequest('Choose a start and an end date.');
    from = Date.parse(`${q.from}T00:00:00Z`) - TZ_MIN * 60000;
    to = Date.parse(`${q.to}T00:00:00Z`) - TZ_MIN * 60000 + DAY;
    if (to <= from) throw badRequest('The end date is before the start date.');
    if (to - from > 366 * DAY) throw badRequest('Choose a range of a year or less.');
  } else from = startOfToday - 6 * DAY;           // 7d
  return { kind, from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}

const shapePerson = (r) => ({
  id: r.id, name: r.name, email: r.email, phone: r.mobile || null,
  department: r.department || null, status: statusOf(r.user_status),
});

/** Turns the errors the admin functions raise into the API's own. */
function mapAdminError(err) {
  const c = err && err.code;
  if (c === '23505') return conflict('EMAIL_TAKEN', 'That email address already belongs to another account.');
  if (c === '22023') return badRequest(err.message);
  if (c === 'P0002') return notFound('That recruiter could not be found.');
  if (c === 'TLA01') return new ApiError(409, 'INACTIVE', err.message);
  if (c === 'TLA02') return badRequest(err.message, { department: err.message });
  if (c === 'TLA03' || c === 'TLA04') return new ApiError(409, 'TEAM_RULE', err.message);
  return null;
}
const adminCall = async (session, sql, params) => {
  try {
    return await withUser(session, async (c) => (await c.query(sql, params)).rows[0]);
  } catch (err) {
    const mapped = mapAdminError(err);
    if (mapped) throw mapped;
    throw err;
  }
};

export default function teamRoutes() {
  const r = Router();

  /* ================================================================ *
   * admin
   * ================================================================ */
  r.get('/admin/teams', requireAuth(), requireRole('admin'), wrap(async (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 80);
    const department = String(req.query.department || '').trim().slice(0, 80);
    const tlId = String(req.query.tlId || '').trim().slice(0, 64);
    const status = ['active', 'inactive'].includes(String(req.query.status)) ? String(req.query.status) : '';

    const rows = await withUser(req.session, async (c) => (await c.query(
      `select r.id, r.name, r.email, r.mobile, r.department, r.is_team_lead,
              u.status as user_status, h.tl_id, h.department as assigned_department, h.started_at
         from recruiters r
         left join users u on u.id = r.user_id
         left join recruiter_assignment_history h on h.recruiter_id = r.id and h.ended_at is null
        order by r.name`)).rows);

    const like = (s) => String(s || '').toLowerCase().includes(q.toLowerCase());
    const matchesQ = (p) => !q || like(p.name) || like(p.email) || like(p.mobile);
    const inDept = (p, d) => !department || String(d || '').toLowerCase() === department.toLowerCase();
    const matchesStatus = (p) => !status || statusOf(p.user_status) === status;

    const tls = rows.filter((x) => x.is_team_lead);
    const members = new Map();
    for (const m of rows.filter((x) => !x.is_team_lead && x.tl_id)) {
      if (!members.has(m.tl_id)) members.set(m.tl_id, []);
      members.get(m.tl_id).push(m);
    }

    const teamLeads = [];
    for (const t of tls) {
      if (tlId && t.id !== tlId) continue;
      const all = members.get(t.id) || [];
      const tlHit = matchesQ(t) && matchesStatus(t) && inDept(t, t.department);
      const kept = all.filter((m) => matchesQ(m) && matchesStatus(m) && inDept(m, m.assigned_department));
      /* A TL shows when it matches itself, or when one of its recruiters
         matches; with no filter at all every TL shows. */
      const filtering = q || department || status;
      if (filtering && !tlHit && !kept.length) continue;
      const shown = (q || department || status) && !tlHit ? kept : (department || status ? kept : all);
      teamLeads.push({
        ...shapePerson(t), isTeamLead: true, recruiterCount: all.length,
        recruiters: shown.map((m) => ({ ...shapePerson(m), department: m.assigned_department || m.department || null,
                                        tlId: t.id, assignedSince: iso(m.started_at) })),
      });
    }

    const unassigned = tlId ? [] : rows
      .filter((x) => !x.is_team_lead && !x.tl_id && matchesQ(x) && matchesStatus(x) && inDept(x, x.department))
      .map(shapePerson);

    const days = await withUser(req.session, async (c) => (await c.query(`select contact_cooldown_days() as d`)).rows[0].d);
    res.json({
      teamLeads, unassigned,
      allTeamLeads: tls.map((t) => ({ id: t.id, name: t.name, department: t.department || null,
                                      status: statusOf(t.user_status) })),
      departments: [...new Set(rows.map((x) => x.assigned_department || x.department).filter(Boolean))].sort(),
      cooldownDays: days,
    });
  }));

  r.post('/admin/teams/assign', requireAuth(), requireRole('admin'), wrap(async (req, res) => {
    const b = parse(z.object({
      recruiterId: z.string().trim().min(1).max(64),
      tlId: z.string().trim().min(1).max(64),
      department: z.string().trim().max(80).optional(),
    }), req.body);
    const out = await adminCall(req.session, `select staff_assign_recruiter($1,$2,$3) as r`,
      [b.recruiterId, b.tlId, b.department || null]);
    res.json(out.r);
  }));

  r.post('/admin/teams/unassign', requireAuth(), requireRole('admin'), wrap(async (req, res) => {
    const b = parse(z.object({ recruiterId: z.string().trim().min(1).max(64) }), req.body);
    const out = await adminCall(req.session, `select staff_unassign_recruiter($1) as r`, [b.recruiterId]);
    res.json(out.r);
  }));

  r.post('/admin/recruiters/:id/team-lead', requireAuth(), requireRole('admin'), wrap(async (req, res) => {
    const b = parse(z.object({ on: z.boolean() }), req.body);
    const out = await adminCall(req.session, `select staff_set_team_lead($1,$2) as r`, [req.params.id, b.on]);
    res.json(out.r);
  }));

  r.patch('/admin/recruiters/:id', requireAuth(), requireRole('admin'), wrap(async (req, res) => {
    const b = parse(z.object({
      email: z.string().trim().max(254).optional(),
      department: z.string().trim().max(80).optional(),
    }).refine((x) => x.email !== undefined || x.department !== undefined, 'Nothing to change.'), req.body);
    const done = {};
    if (b.email !== undefined) done.email = (await adminCall(req.session,
      `select staff_recruiter_email_change($1,$2) as r`, [req.params.id, b.email])).r;
    if (b.department !== undefined) {
      /* A team member's department moves with their assignment (a history
         row); anybody else's is a plain change. */
      const cur = await withUser(req.session, async (c) => (await c.query(
        `select tl_id from recruiter_assignment_history where recruiter_id=$1 and ended_at is null`,
        [req.params.id])).rows[0]);
      done.department = cur
        ? (await adminCall(req.session, `select staff_assign_recruiter($1,$2,$3) as r`,
            [req.params.id, cur.tl_id, b.department])).r
        : (await adminCall(req.session, `select staff_recruiter_set_department($1,$2) as r`,
            [req.params.id, b.department])).r;
    }
    res.json(done);
  }));

  r.get('/admin/recruiters/:id/assignments', requireAuth(), requireRole('admin'), wrap(async (req, res) => {
    const rows = await withUser(req.session, async (c) => (await c.query(
      `select h.id, h.tl_id, t.name as tl_name, h.department, h.started_at, h.ended_at, h.end_reason
         from recruiter_assignment_history h
         join recruiters t on t.id = h.tl_id
        where h.recruiter_id = $1
        order by h.started_at desc, h.id desc`, [req.params.id])).rows);
    res.json({ assignments: rows.map((x) => ({
      id: Number(x.id), tlId: x.tl_id, tlName: x.tl_name, department: x.department,
      startedAt: iso(x.started_at), endedAt: iso(x.ended_at), endReason: x.end_reason || null,
      current: !x.ended_at,
    })) });
  }));

  r.get('/admin/contact-cooldown', requireAuth(), requireRole('admin'), wrap(async (req, res) => {
    const days = await withUser(req.session, async (c) => (await c.query(`select contact_cooldown_days() as d`)).rows[0].d);
    res.json({ days, min: 1, max: 90 });
  }));

  r.put('/admin/contact-cooldown', requireAuth(), requireRole('admin'), wrap(async (req, res) => {
    const b = parse(z.object({ days: z.number().int().min(1).max(90) }), req.body);
    const out = await adminCall(req.session, `select staff_set_contact_cooldown($1) as r`, [b.days]);
    res.json(out.r);
  }));

  /* ================================================================ *
   * team lead
   * ================================================================ */
  const requireTl = (req, _res, next) => {
    if (!req.session) return next(new ApiError(401, 'UNAUTHENTICATED', 'Please sign in to continue.'));
    if (req.session.role !== 'recruiter' || !req.session.isTeamLead) return next(forbidden('This is for team leads.'));
    next();
  };

  /* One recruiter's figures in the range, for a list of recruiter ids. */
  const figures = (c, ids, range) => c.query(
    `select r.id, r.name, r.email, r.mobile, r.department, app_recruiter_status(r.id) as user_status,
            (select count(*) from jobs j
              where j.recruiter_id = r.id
                and coalesce(j.published_at, j.created_at) >= $2 and coalesce(j.published_at, j.created_at) < $3
            )::int as jobs_posted,
            (select count(*) from applications a join jobs j on j.id = a.job_id
              where j.recruiter_id = r.id and a.applied_at >= $2 and a.applied_at < $3
            )::int as total_applied,
            (select count(distinct h.candidate_id) from candidate_contact_history h
              where h.recruiter_id = r.id and h.direction = 'out' and cch_is_contact(h.source)
                and coalesce(h.outcome, '') <> 'failed'
                and h.created_at >= $2 and h.created_at < $3
            )::int as contacted,
            (select max(h.created_at) from candidate_contact_history h
              where h.recruiter_id = r.id and h.direction = 'out' and cch_is_contact(h.source)
                and coalesce(h.outcome, '') <> 'failed') as last_contacted
       from recruiters r
      where r.id = any($1)
      order by r.name`, [ids, range.from, range.to]);

  r.get('/team/summary', requireAuth(), requireTl, wrap(async (req, res) => {
    const range = rangeOf(req.query);
    const out = await withUser(req.session, async (c) => {
      const team = (await c.query(`select app_team_recruiter_ids() as id`)).rows.map((x) => x.id);
      const rows = team.length ? (await figures(c, team, range)).rows : [];
      /* The team's own totals: distinct candidates cannot be summed from
         the per-recruiter figures (two recruiters can contact one person). */
      const totals = team.length ? (await c.query(
        `select
           (select count(*) from jobs j where j.recruiter_id = any($1)
              and coalesce(j.published_at, j.created_at) >= $2 and coalesce(j.published_at, j.created_at) < $3)::int as jobs,
           (select count(*) from applications a join jobs j on j.id = a.job_id
              where j.recruiter_id = any($1) and a.applied_at >= $2 and a.applied_at < $3)::int as applied,
           (select count(distinct h.candidate_id) from candidate_contact_history h
              where h.recruiter_id = any($1) and h.direction = 'out' and cch_is_contact(h.source)
                and coalesce(h.outcome, '') <> 'failed' and h.created_at >= $2 and h.created_at < $3)::int as contacted`,
        [team, range.from, range.to])).rows[0] : { jobs: 0, applied: 0, contacted: 0 };
      return { team, rows, totals };
    });
    res.json({
      range,
      cards: { totalRecruiters: out.team.length, totalJobs: out.totals.jobs,
               totalApplied: out.totals.applied, totalCandidatesContacted: out.totals.contacted },
      recruiters: out.rows.map((x) => ({
        ...shapePerson(x), jobsPosted: x.jobs_posted, candidatesContacted: x.contacted,
        totalApplied: x.total_applied, lastContacted: iso(x.last_contacted),
      })),
    });
  }));

  /* A recruiter on my team, or a 403. Never a recruiter from anywhere else. */
  const teamMember = async (c, id) => {
    const ok = (await c.query(`select $1::text in (select app_team_recruiter_ids()) as ok`, [id])).rows[0].ok;
    if (ok) return true;
    const exists = (await c.query(`select app_row_exists('recruiter', $1) as e`, [id])).rows[0].e;
    throw exists ? forbidden('That recruiter is not on your team.') : notFound('That recruiter could not be found.');
  };

  r.get('/team/recruiters/:id', requireAuth(), requireTl, wrap(async (req, res) => {
    const range = rangeOf(req.query);
    const id = String(req.params.id).slice(0, 64);
    const out = await withUser(req.session, async (c) => {
      await teamMember(c, id);
      const me = (await figures(c, [id], range)).rows[0];
      const jobs = (await c.query(
        `select j.id, j.title, j.status, j.paused, j.archived,
                coalesce(j.published_at, j.created_at) as posted_at,
                (select count(*) from applications a where a.job_id = j.id)::int as applications
           from jobs j where j.recruiter_id = $1
          order by coalesce(j.published_at, j.created_at) desc limit 200`, [id])).rows;
      const contacts = (await c.query(
        `select h.id, h.candidate_id, c2.name as candidate_name, h.channel, h.outcome, h.source,
                h.created_at, h.override_used, h.override_reason, h.job_id
           from candidate_contact_history h
           left join candidates c2 on c2.id = h.candidate_id
          where h.recruiter_id = $1 and h.direction = 'out' and cch_is_contact(h.source)
          order by h.created_at desc limit 100`, [id])).rows;
      return { me, jobs, contacts };
    });
    res.json({
      range,
      recruiter: {
        ...shapePerson(out.me), jobsPosted: out.me.jobs_posted, candidatesContacted: out.me.contacted,
        totalApplied: out.me.total_applied, lastContacted: iso(out.me.last_contacted),
      },
      jobs: out.jobs.map((j) => ({
        id: j.id, title: j.title, postedAt: iso(j.posted_at), applications: j.applications,
        status: j.archived ? 'archived' : j.paused ? 'paused' : j.status,
      })),
      contactActivity: out.contacts.map((x) => ({
        id: Number(x.id), candidateId: x.candidate_id, candidateName: x.candidate_name || null,
        channel: x.channel, outcome: x.outcome || null, at: iso(x.created_at), jobId: x.job_id || null,
        overridden: !!x.override_used, overrideReason: x.override_used ? x.override_reason : null,
      })),
    });
  }));

  r.get('/team/recruiters/:id/jobs/:jobId/applicants', requireAuth(), requireTl, wrap(async (req, res) => {
    const id = String(req.params.id).slice(0, 64);
    const out = await withUser(req.session, async (c) => {
      await teamMember(c, id);
      const job = (await c.query(`select id, title from jobs where id=$1 and recruiter_id=$2`,
        [req.params.jobId, id])).rows[0];
      if (!job) throw notFound('That job could not be found for this recruiter.');
      const apps = (await c.query(
        `select a.id, a.reference, a.stage, a.applied_at, c.id as candidate_id, c.name, c.email, c.phone
           from applications a join candidates c on c.id = a.candidate_id
          where a.job_id = $1 order by a.applied_at desc limit 500`, [job.id])).rows;
      return { job, apps };
    });
    res.json({
      job: { id: out.job.id, title: out.job.title },
      applicants: out.apps.map((a) => ({
        applicationId: a.id, reference: a.reference || null, stage: a.stage, appliedAt: iso(a.applied_at),
        candidateId: a.candidate_id, name: a.name, email: a.email || null, phone: a.phone || null,
      })),
    });
  }));

  return r;
}
