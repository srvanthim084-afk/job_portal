/**
 * Company management.
 *
 * This route was missing, and it made a fresh deployment unusable: every
 * job requires a companyId, the RLS policy already granted admins write
 * access to `companies`, but no endpoint existed to create one. With a
 * seeded database nobody noticed — the three demo companies were always
 * there. On an empty production database an administrator could not create
 * a company, therefore could not create a job, therefore could not use the
 * portal at all.
 *
 * Found by rehearsing a deployment against an empty database
 * (tools/rehearse.mjs), which is the only place it shows up.
 */
import { Router } from 'express';
import { z } from 'zod';
import { withUser } from '../db.js';
import { wrap, badRequest, notFound, forbidden } from '../errors.js';
import { requireAuth, requireRole } from '../auth.js';
import { toCompany } from '../shapes.js';

const schema = z.object({
  // The id appears in the UI and in every job's company_id, so it is a
  // readable slug rather than a generated key — and it is never changed
  // afterwards, for the same reason Job IDs are not.
  id: z.string().trim().min(2).max(64)
    .regex(/^[a-z0-9][a-z0-9_-]*$/,
      'Use lowercase letters, numbers, hyphens or underscores (e.g. "technova").')
    .optional(),
  name: z.string().trim().min(2, 'A company name is required.').max(160),
  industry: z.string().trim().max(160).optional(),
  hq: z.string().trim().max(160).optional(),
  founded: z.number().int().min(1800).max(2100).optional().nullable(),
  size: z.string().trim().max(60).optional(),
  // The logo gradient. The UI renders these directly, so they are
  // validated as colours rather than accepted as arbitrary strings.
  color1: z.string().trim().regex(/^#[0-9a-fA-F]{3,8}$/, 'Use a hex colour, e.g. #0b6e8f.').optional(),
  color2: z.string().trim().regex(/^#[0-9a-fA-F]{3,8}$/, 'Use a hex colour, e.g. #3fb4d1.').optional(),
  about: z.string().max(8000).optional(),
});

const parse = (s, body) => {
  const out = s.safeParse(body || {});
  if (!out.success) {
    const details = {};
    for (const i of out.error.issues) details[i.path.join('.') || 'form'] = i.message;
    throw badRequest('Please check the highlighted fields and try again.', details);
  }
  return out.data;
};

/** "TechNova Solutions" -> "technova-solutions" */
const slugify = (name) => String(name).toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'company';

const COLS = {
  name: 'name', industry: 'industry', hq: 'hq', founded: 'founded',
  size: 'size_label', color1: 'color1', color2: 'color2', about: 'about',
};

export default function companyRoutes() {
  const r = Router();

  /** Public: the job board shows company names and branding. */
  r.get('/companies', wrap(async (req, res) => {
    const rows = await withUser(req.session, async (c) => {
      const { rows } = await c.query(`select * from companies order by name`);
      return rows;
    });
    res.json({ companies: rows.map(toCompany) });
  }));

  r.get('/companies/:id', wrap(async (req, res) => {
    const row = await withUser(req.session, async (c) => {
      const { rows } = await c.query(`select * from companies where id=$1`, [req.params.id]);
      return rows[0];
    });
    if (!row) throw notFound('That company could not be found.');
    res.json({ company: toCompany(row) });
  }));

  r.post('/companies', requireAuth(), requireRole('admin'), wrap(async (req, res) => {
    const b = parse(schema, req.body);
    const id = b.id || slugify(b.name);

    const row = await withUser(req.session, async (c) => {
      const clash = await c.query(`select 1 from companies where id=$1`, [id]);
      if (clash.rowCount) {
        throw badRequest(`A company with the id "${id}" already exists.`, { id: 'already in use' });
      }
      const cols = ['id'], vals = [id], ph = ['$1'];
      for (const [k, col] of Object.entries(COLS)) {
        if (b[k] !== undefined) { cols.push(col); vals.push(b[k]); ph.push(`$${vals.length}`); }
      }
      await c.query(`insert into companies (${cols.join(',')}) values (${ph.join(',')})`, vals);
      const { rows } = await c.query(`select * from companies where id=$1`, [id]);
      return rows[0];
    });

    res.status(201).json({ company: toCompany(row) });
  }));

  /** Edit in place. The id never changes — jobs reference it. */
  r.put('/companies/:id', requireAuth(), requireRole('admin'), wrap(async (req, res) => {
    const b = parse(schema.omit({ id: true }).partial().extend({
      name: z.string().trim().min(2).max(160).optional(),
    }), req.body);

    const row = await withUser(req.session, async (c) => {
      const sets = [], vals = [];
      for (const [k, col] of Object.entries(COLS)) {
        if (b[k] !== undefined) { vals.push(b[k]); sets.push(`${col}=$${vals.length}`); }
      }
      if (!sets.length) throw badRequest('Nothing to update.');
      vals.push(req.params.id);
      const upd = await c.query(
        `update companies set ${sets.join(',')} where id=$${vals.length} returning *`, vals);
      if (!upd.rowCount) {
        const seen = await c.query(`select 1 from companies where id=$1`, [req.params.id]);
        throw seen.rowCount ? forbidden('Only an administrator can change a company.')
                            : notFound('That company could not be found.');
      }
      return upd.rows[0];
    });

    res.json({ company: toCompany(row) });
  }));

  return r;
}
