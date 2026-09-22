/**
 * BDE management, and the export a BDE exists to perform.
 *
 * A BDE (Business Development Executive) sources candidates and pushes
 * those records into the agency's ATS. THAT ATS IS A SEPARATE PRODUCT and
 * is not part of this system, so nothing here writes to it directly.
 * What this provides is:
 *
 *   * admin CRUD for BDE accounts (there is no self-registration; a BDE is
 *     staff, created by an administrator, same as a recruiter)
 *   * the export payload - one candidate, assembled from the live database
 *     with their application, AI interview scores and resume reference
 *   * a record of every export, written BEFORE it leaves
 *
 * The push itself goes through a destination. 'download' always works and
 * needs no credentials; a named provider is attempted only when it is
 * configured, and reports `not_configured` rather than pretending.
 */
import { Router } from 'express';
import { z } from 'zod';
import { withUser } from '../db.js';
import { wrap, badRequest, notFound, forbidden } from '../errors.js';
import { requireAuth, requireRole, hashPassword } from '../auth.js';
import { toPerson, toCandidate } from '../shapes.js';
import { buildExport, pushToAts, atsDestinations } from '../ats/push.js';

const newId = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

const profileSchema = z.object({
  id: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]*$/i).max(40).optional(),
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(160),
  companyId: z.string().trim().max(64).optional().nullable(),
  title: z.string().trim().max(120).optional(),
  password: z.string().min(10).max(200).optional(),
});

const parse = (schema, body) => {
  const out = schema.safeParse(body || {});
  if (!out.success) {
    const details = {};
    for (const i of out.error.issues) details[i.path.join('.') || 'form'] = i.message;
    throw badRequest('Please check the highlighted fields and try again.', details);
  }
  return out.data;
};

const initialsOf = (name) => String(name).split(/\s+/).filter(Boolean)
  .slice(0, 2).map((w) => w[0].toUpperCase()).join('') || 'BD';

export default function bdeRoutes() {
  const r = Router();

  /* ---------------------------------------------------------------- *
   * accounts
   * ---------------------------------------------------------------- */

  r.get('/bdes', requireAuth(), requireRole('admin'), wrap(async (req, res) => {
    const rows = await withUser(req.session, async (c) => {
      const { rows } = await c.query(`select * from bde_users order by name`);
      return rows;
    });
    res.json({ bdes: rows.map(toPerson) });
  }));

  r.post('/bdes', requireAuth(), requireRole('admin'), wrap(async (req, res) => {
    const b = parse(profileSchema, req.body);
    const id = b.id || newId('bde');

    const row = await withUser(req.session, async (c) => {
      const clash = await c.query(
        `select 1 from bde_users where id=$1 or lower(email)=lower($2)`, [id, b.email]);
      if (clash.rowCount) throw badRequest('A BDE with that id or email already exists.');

      // The login is optional at creation: an admin can set the password
      // later, exactly as with the other staff roles.
      let userId = null;
      if (b.password) {
        const hash = await hashPassword(b.password);
        // auth_create_user returns the uuid itself, not a row set.
        const u = await c.query(
          `select auth_create_user($1,$2,'bde') as id`, [b.email, hash]);
        userId = u.rows[0]?.id || null;
      }

      await c.query(
        `insert into bde_users (id, user_id, name, email, company_id, title, initials)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [id, userId, b.name, b.email, b.companyId || null, b.title || 'Business Development Executive',
         initialsOf(b.name)]);

      const { rows } = await c.query(`select * from bde_users where id=$1`, [id]);
      return rows[0];
    });

    res.status(201).json({ bde: toPerson(row) });
  }));

  r.put('/bdes/:id', requireAuth(), requireRole('admin'), wrap(async (req, res) => {
    const b = parse(profileSchema.partial().omit({ id: true }), req.body);

    const row = await withUser(req.session, async (c) => {
      const sets = [], vals = [];
      const cols = { name: 'name', email: 'email', companyId: 'company_id', title: 'title' };
      for (const [k, col] of Object.entries(cols)) {
        if (b[k] !== undefined) { vals.push(b[k]); sets.push(`${col}=$${vals.length}`); }
      }
      if (!sets.length) throw badRequest('Nothing to update.');
      vals.push(req.params.id);
      const upd = await c.query(
        `update bde_users set ${sets.join(',')} where id=$${vals.length} returning *`, vals);
      if (!upd.rowCount) throw notFound('That BDE could not be found.');
      return upd.rows[0];
    });

    res.json({ bde: toPerson(row) });
  }));

  /* ---------------------------------------------------------------- *
   * the export
   * ---------------------------------------------------------------- */

  r.get('/ats/destinations', requireAuth(), requireRole('bde', 'admin'), (_req, res) => {
    res.json({ destinations: atsDestinations() });
  });

  /**
   * Everything about one candidate, as it would be handed to an ATS.
   *
   * Read-only, and governed entirely by RLS: a BDE sees this for a
   * candidate they are allowed to see, and gets an empty result otherwise.
   * No push is recorded - this is the preview.
   */
  r.get('/ats/payload/:candidateId', requireAuth(), requireRole('bde', 'admin'),
    wrap(async (req, res) => {
      const payload = await withUser(req.session, (c) =>
        buildExport(c, req.params.candidateId, req.query.applicationId || null));
      if (!payload) throw notFound('That candidate could not be found, or you do not have access to them.');
      res.json({ payload });
    }));

  /**
   * Push a candidate to a destination, and record that it happened.
   *
   * The audit row is written FIRST, as 'pending', then updated with the
   * outcome. An export that vanished halfway must still leave a trace -
   * "did we send this person's details out" is not a question to answer
   * from memory.
   */
  r.post('/ats/push', requireAuth(), requireRole('bde'), wrap(async (req, res) => {
    const b = parse(z.object({
      candidateId: z.string().trim().min(1).max(64),
      applicationId: z.string().trim().max(64).optional().nullable(),
      destination: z.string().trim().max(40).default('download'),
    }), req.body);

    const out = await withUser(req.session, async (c) => {
      const payload = await buildExport(c, b.candidateId, b.applicationId || null);
      if (!payload) throw notFound('That candidate could not be found, or you do not have access to them.');

      const bde = await c.query(`select id from bde_users where user_id=$1`, [req.session.userId]);
      const id = newId('exp');

      await c.query(
        `insert into ats_exports
           (id, candidate_id, application_id, job_id, exported_by, bde_id,
            destination, status, payload)
         values ($1,$2,$3,$4,$5,$6,$7,'pending',$8)`,
        [id, payload.candidate.id, payload.application?.id || null, payload.job?.id || null,
         req.session.userId, bde.rows[0]?.id || null, b.destination, JSON.stringify(payload)]);

      const result = await pushToAts(b.destination, payload);

      await c.query(`update ats_exports set status=$1, detail=$2 where id=$3`,
        [result.status, result.detail || null, id]);

      return { exportId: id, ...result, payload };
    });

    res.status(201).json(out);
  }));

  /** What this BDE has already sent, newest first. */
  r.get('/ats/exports', requireAuth(), requireRole('bde', 'admin'), wrap(async (req, res) => {
    const rows = await withUser(req.session, async (c) => {
      const { rows } = await c.query(
        `select e.id, e.candidate_id, e.application_id, e.job_id, e.destination,
                e.status, e.detail, e.created_at, c.name as candidate_name
           from ats_exports e
           left join candidates c on c.id = e.candidate_id
          order by e.created_at desc limit 200`);
      return rows;
    });
    res.json({
      exports: rows.map((e) => ({
        id: e.id,
        candidateId: e.candidate_id,
        candidateName: e.candidate_name,
        applicationId: e.application_id,
        jobId: e.job_id,
        destination: e.destination,
        status: e.status,
        detail: e.detail,
        createdAt: e.created_at,
      })),
    });
  }));

  return r;
}
