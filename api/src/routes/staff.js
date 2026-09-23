/**
 * Recruiter Management: the administrator's side of a recruiting desk.
 *
 * A recruiter existed as a login and almost nothing else. There was no
 * way to add one without editing the database, no way to see what any of
 * them were doing, and no way to turn a login off when somebody left -
 * so "deactivate Kiran" meant deleting rows, which takes their
 * candidates with them.
 *
 * ONE ACCOUNT, NOT TWO. The login this creates is the same `users` row
 * the Recruiter Portal authenticates against. There is no separate
 * admin-side recruiter account, no shadow credential store, and nothing
 * here bypasses the ordinary login: the password is hashed the same way
 * and checked the same way. An administrator creating kiran@... with a
 * password means kiran signs in at the Recruiter Portal with exactly
 * that, and lands in their own portal because the session carries their
 * profile.
 *
 * NO PASSWORD IS EVER RETURNED. Not on create, not on reset, not in the
 * list. What comes back is whether a login exists and whether it is
 * active.
 */
import { Router } from 'express';
import { z } from 'zod';
import { withUser } from '../db.js';
import { wrap, badRequest, notFound, forbidden, ApiError } from '../errors.js';
import {
  requireAuth, requireRole, hashPassword, impersonate, setSessionCookie, issueCsrfToken,
} from '../auth.js';

function parse(schema, body) {
  const out = schema.safeParse(body || {});
  if (!out.success) {
    const details = {};
    for (const i of out.error.issues) details[i.path.join('.') || 'form'] = i.message;
    throw new ApiError(422, 'VALIDATION_FAILED', 'Please check the highlighted fields.', details);
  }
  return out.data;
}

/**
 * The stages the admin table reports, in pipeline order.
 *
 * These are the stages that actually exist (0001_schema). "With BDE",
 * "Hold" and "Joined" were asked for and are NOT here, because the
 * pipeline has no such stage - a column that is always zero looks like
 * nobody is at that step rather than like the step not existing.
 * "Shared with Client" is `client_review`, which is the same thing under
 * the name the schema uses.
 */
const STAGE_COLUMNS = [
  'applied', 'ai_screening', 'shortlisted', 'interview_scheduled',
  'ai_interview_done', 'client_review', 'offer_extended',
  'selected', 'rejected',
];

const toRecruiter = (r) => ({
  id: r.id,
  name: r.name,
  email: r.email,
  employeeId: r.employee_id || undefined,
  mobile: r.mobile || undefined,
  department: r.department || undefined,
  designation: r.designation || r.title || undefined,
  recruiterRole: r.recruiter_role || undefined,
  team: r.team || undefined,
  companyId: r.company_id || undefined,
  // Whether they can sign in, and nothing about how.
  hasLogin: !!r.user_id,
  loginStatus: r.user_id ? (r.user_status === 'active' ? 'active' : 'inactive') : 'none',
  lastLoginAt: r.last_login_at ? new Date(r.last_login_at).toISOString() : undefined,
  lastActivityAt: r.last_activity_at ? new Date(r.last_activity_at).toISOString() : undefined,
  assignedRequirements: Number(r.jobs || 0),
  totalCandidates: Number(r.candidates || 0),
  stages: STAGE_COLUMNS.reduce((acc, s) => {
    acc[s] = Number(r['stage_' + s] || 0);
    return acc;
  }, {}),
});

export default function staffRoutes() {
  const r = Router();

  /**
   * GET /api/staff/recruiters
   *
   * Every recruiter with their desk summarised: how many requirements
   * they own, how many candidates, and how those candidates are spread
   * across the pipeline.
   *
   * Counted in SQL rather than by loading every application and tallying
   * in JavaScript, so the numbers cannot drift from the rows they came
   * from and a hundred recruiters is one query.
   */
  r.get('/staff/recruiters', requireAuth(), requireRole('admin'), wrap(async (req, res) => {
    const stageCounts = STAGE_COLUMNS.map((s) =>
      `count(*) filter (where a.stage = '${s}')::int as stage_${s}`).join(',\n           ');

    const rows = await withUser(req.session, async (c) => (await c.query(
      `select rec.*, u.status as user_status, u.last_login_at,
              (select count(*)::int from jobs j where j.recruiter_id = rec.id) as jobs,
              count(distinct a.candidate_id)::int as candidates,
              ${stageCounts}
         from recruiters rec
         left join users u on u.id = rec.user_id
         left join jobs j2 on j2.recruiter_id = rec.id
         left join applications a
                on a.job_id = j2.id or a.recruiter_id = rec.id
        group by rec.id, u.status, u.last_login_at
        order by rec.name`)).rows);

    res.json({ recruiters: rows.map(toRecruiter) });
  }));

  /**
   * POST /api/staff/recruiters — the employee, the profile and the login.
   *
   * All three in one call, because creating them separately is how a
   * person ends up with a profile nobody can sign in to, or a login
   * attached to nothing.
   */
  r.post('/staff/recruiters', requireAuth(), requireRole('admin'), wrap(async (req, res) => {
    const b = parse(z.object({
      name: z.string().trim().min(2, 'A name is required.').max(120),
      email: z.string().trim().email('That is not a valid email address.').max(160),
      password: z.string().min(8, 'At least 8 characters.').max(200),
      confirmPassword: z.string().optional(),
      employeeId: z.string().trim().max(40).optional(),
      mobile: z.string().trim().max(32).optional(),
      department: z.string().trim().max(80).optional(),
      designation: z.string().trim().max(120).optional(),
      recruiterRole: z.string().trim().max(80).optional(),
      team: z.string().trim().max(80).optional(),
      companyId: z.string().trim().max(64).optional(),
      loginStatus: z.enum(['active', 'inactive']).optional(),
    }), req.body);

    // Checked here as well as in the browser: a form is a convenience,
    // not a guarantee.
    if (b.confirmPassword != null && b.confirmPassword !== b.password) {
      throw badRequest('The two passwords do not match.',
        { confirmPassword: 'This does not match the password.' });
    }

    const email = b.email.toLowerCase();
    const made = await withUser(req.session, async (c) => {
      const clash = await c.query(`select 1 from users where lower(email) = $1`, [email]);
      if (clash.rowCount) {
        throw new ApiError(409, 'EMAIL_TAKEN',
          'That address already signs in. Use another, or reset the existing account.');
      }
      return (await c.query(
        `select staff_recruiter_create($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) as out`,
        [b.name, email, await hashPassword(b.password),
         b.designation || 'Recruiter', b.companyId || null,
         b.employeeId || null, b.mobile || null, b.department || null,
         b.recruiterRole || null, b.team || null,
         b.loginStatus || 'active'])).rows[0].out;
    });

    res.status(201).json({ recruiter: made });
  }));

  /** PATCH /api/staff/recruiters/:id — edit the employee details. */
  r.patch('/staff/recruiters/:id', requireAuth(), requireRole('admin'), wrap(async (req, res) => {
    const b = parse(z.object({
      name: z.string().trim().min(2).max(120).optional(),
      employeeId: z.string().trim().max(40).optional(),
      mobile: z.string().trim().max(32).optional(),
      department: z.string().trim().max(80).optional(),
      designation: z.string().trim().max(120).optional(),
      recruiterRole: z.string().trim().max(80).optional(),
      team: z.string().trim().max(80).optional(),
    }), req.body);

    // The email is NOT editable here. It is the login, and changing it
    // quietly would lock somebody out of an account they still use.
    const COLS = {
      name: 'name', employeeId: 'employee_id', mobile: 'mobile',
      department: 'department', designation: 'designation',
      recruiterRole: 'recruiter_role', team: 'team',
    };

    const out = await withUser(req.session, async (c) => {
      const sets = [];
      const vals = [];
      for (const [k, col] of Object.entries(COLS)) {
        if (b[k] === undefined) continue;
        vals.push(b[k] === '' ? null : b[k]);
        sets.push(`${col} = $${vals.length}`);
      }
      if (!sets.length) throw badRequest('Nothing to update.');
      vals.push(req.params.id);
      const upd = await c.query(
        `update recruiters set ${sets.join(', ')}, updated_at = now()
          where id = $${vals.length} returning *`, vals);
      if (!upd.rowCount) throw notFound('That recruiter could not be found.');
      return upd.rows[0];
    });

    res.json({ recruiter: toRecruiter(out) });
  }));

  /**
   * POST /api/staff/recruiters/:id/status
   *
   * Turn a login on or off. The person, their candidates and their
   * history are untouched - a deactivated recruiter simply cannot sign
   * in, and login() already refuses a suspended account, so this is
   * enforced where it matters rather than by hiding a button.
   */
  r.post('/staff/recruiters/:id/status', requireAuth(), requireRole('admin'),
    wrap(async (req, res) => {
      const b = parse(z.object({ active: z.boolean() }), req.body);
      const out = await withUser(req.session, async (c) => (await c.query(
        `select staff_recruiter_status($1,$2) as out`,
        [req.params.id, b.active])).rows[0].out);
      res.json(out);
    }));

  /**
   * POST /api/staff/recruiters/:id/password
   *
   * A new password, chosen by the administrator. The recruiter is asked
   * to change it on first use, so an address the administrator knows
   * does not stay one they can sign in as.
   */
  r.post('/staff/recruiters/:id/password', requireAuth(), requireRole('admin'),
    wrap(async (req, res) => {
      const b = parse(z.object({
        password: z.string().min(8, 'At least 8 characters.').max(200),
        confirmPassword: z.string().optional(),
      }), req.body);
      if (b.confirmPassword != null && b.confirmPassword !== b.password) {
        throw badRequest('The two passwords do not match.');
      }
      const ok = await withUser(req.session, async (c) => (await c.query(
        `select staff_recruiter_password($1,$2) as ok`,
        [req.params.id, await hashPassword(b.password)])).rows[0].ok);
      if (!ok) throw notFound('That recruiter has no login account.');
      // Says it happened. Never what it is.
      res.json({ ok: true, mustChangePassword: true });
    }));

  /**
   * POST /api/staff/recruiters/:id/login-as
   *
   * Open that recruiter's portal, as them.
   *
   * The administrator's own session is REPLACED, deliberately: two
   * sessions in one browser is how somebody acts as the wrong person
   * without noticing. They sign out and back in to return to their own.
   *
   * Only a recruiter can be entered, never another administrator, and
   * never a deactivated login - so turning a login off closes this door
   * too rather than leaving it ajar.
   */
  r.post('/staff/recruiters/:id/login-as', requireAuth(), requireRole('admin'),
    wrap(async (req, res) => {
      const rec = await withUser(req.session, async (c) => (await c.query(
        `select id, name, email, user_id from recruiters where id = $1`,
        [req.params.id])).rows[0]);
      if (!rec) throw notFound('That recruiter could not be found.');
      if (!rec.user_id) throw badRequest('That recruiter has no login account yet.');

      const { token, expires, session } = await impersonate(rec.user_id, {
        userAgent: req.get('user-agent'), ip: req.ip,
      });

      setSessionCookie(res, token, expires);
      issueCsrfToken(res);

      res.json({
        session: { role: session.role, id: session.profileId, email: session.email },
        recruiter: { id: rec.id, name: rec.name, email: rec.email },
      });
    }));

  /**
   * GET /api/staff/recruiters/:id/activity
   *
   * What this recruiter is actually doing: their candidates, which
   * requirement each is against, where they are in the pipeline and
   * what happened to them last.
   *
   * Read from the EXISTING applications and events. Nothing is copied
   * into a reporting table, so the administrator and the recruiter are
   * looking at the same rows and cannot disagree.
   */
  r.get('/staff/recruiters/:id/activity', requireAuth(), requireRole('admin'),
    wrap(async (req, res) => {
      const rec = await withUser(req.session, async (c) => (await c.query(
        `select * from recruiters where id = $1`, [req.params.id])).rows[0]);
      if (!rec) throw notFound('That recruiter could not be found.');

      const rows = await withUser(req.session, async (c) => (await c.query(
        `select a.id, a.stage, a.applied_at, a.reference, a.ai_score, a.source,
                cand.id as candidate_id, cand.name as candidate_name,
                cand.email as candidate_email, cand.phone as candidate_phone,
                j.title as job_title, co.name as client_name,
                s.label as stage_label,
                (select e.detail from application_events e
                  where e.application_id = a.id
                  order by e.at desc limit 1) as last_action,
                (select e.at from application_events e
                  where e.application_id = a.id
                  order by e.at desc limit 1) as last_action_at
           from applications a
           join candidates cand on cand.id = a.candidate_id
           join jobs j on j.id = a.job_id
           left join companies co on co.id = j.company_id
           left join stages s on s.id = a.stage
          where j.recruiter_id = $1 or a.recruiter_id = $1
          order by coalesce(a.applied_at, now()) desc
          limit 500`, [req.params.id])).rows);

      res.json({
        recruiter: toRecruiter({ ...rec, user_status: null }),
        activity: rows.map((x) => ({
          applicationId: x.id,
          reference: x.reference || undefined,
          candidateId: x.candidate_id,
          candidate: x.candidate_name,
          email: x.candidate_email || undefined,
          phone: x.candidate_phone || undefined,
          requirement: x.job_title,
          client: x.client_name || undefined,
          stage: x.stage,
          stageLabel: x.stage_label || x.stage,
          score: x.ai_score == null ? undefined : Number(x.ai_score),
          source: x.source || undefined,
          appliedAt: x.applied_at ? new Date(x.applied_at).toISOString() : undefined,
          lastAction: x.last_action || undefined,
          lastActionAt: x.last_action_at ? new Date(x.last_action_at).toISOString() : undefined,
        })),
      });
    }));

  return r;
}
