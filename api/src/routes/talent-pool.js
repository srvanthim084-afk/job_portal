/**
 * The talent pool (migration 0117): the recruiter-specific layer beside the
 * shared candidates table.
 *
 *   GET    /api/talent-pool/count            how many people are in MY pool
 *   GET    /api/talent-pool/:candidateId     my entry (notes, tags, how I got them)
 *   POST   /api/talent-pool                  save people from Find Candidates
 *   PUT    /api/talent-pool/:candidateId     my notes and tags for one person
 *   DELETE /api/talent-pool/:candidateId     take someone out of MY pool
 *
 * "My" is the session's recruiter profile, taken from the server - there is
 * no recruiter id in any body or query string here. A team lead READS the
 * entries of their department's recruiters (row-level security), an admin
 * reads all; writing is always the caller's own row. An entry the caller may
 * not read is a 404, the same answer as one that does not exist.
 *
 * The LIST of the pool is GET /api/candidates?scope=pool (it shares the
 * search, the filters and the paging with Find Candidates).
 */
import { Router } from 'express';
import { z } from 'zod';
import { withUser } from '../db.js';
import { wrap, badRequest, notFound, forbidden } from '../errors.js';
import { requireAuth, requireRole } from '../auth.js';
import { requirePoolEntry } from '../scope.js';

const parse = (schema, body) => {
  const out = schema.safeParse(body || {});
  if (out.success) return out.data;
  const details = {};
  for (const i of out.error.issues) details[i.path.join('.') || 'form'] = i.message;
  throw badRequest('Please check the highlighted fields and try again.', details);
};

const shape = (e) => ({
  candidateId: e.candidate_id,
  notes: e.notes || '',
  internalRemarks: e.internal_remarks || '',
  candidateNotes: e.candidate_notes || '',
  tags: e.tags || [],
  origin: e.origin,
  addedAt: e.added_at ? new Date(e.added_at).toISOString() : null,
  updatedAt: e.updated_at ? new Date(e.updated_at).toISOString() : null,
  mine: !!e.mine,
});

export default function talentPoolRoutes() {
  const r = Router();
  const staff = [requireAuth(), requireRole('recruiter', 'admin')];

  r.get('/talent-pool/count', ...staff, wrap(async (req, res) => {
    const n = await withUser(req.session, async (c) => (await c.query(
      `select count(distinct candidate_id)::int as n from talent_pool`)).rows[0].n);
    res.json({ count: n });
  }));

  r.post('/talent-pool', ...staff, wrap(async (req, res) => {
    const b = parse(z.object({
      candidateIds: z.array(z.string().trim().min(1).max(64)).min(1).max(5000),
    }), req.body);
    if (req.session.role !== 'recruiter') {
      throw badRequest('Only a recruiter has a talent pool of their own.');
    }
    const saved = await withUser(req.session, async (c) => (await c.query(
      `select talent_pool_link_many($1::text[], 'saved') as n`, [[...new Set(b.candidateIds)]])).rows[0].n);
    res.status(201).json({ saved: Number(saved) });
  }));

  r.get('/talent-pool/:candidateId', ...staff, wrap(async (req, res) => {
    const entry = await withUser(req.session, async (c) => {
      const row = await requirePoolEntry(c, req.params.candidateId);
      row.mine = row.recruiter_id === (req.session.profileId || null);
      return row;
    });
    res.json({ entry: shape(entry) });
  }));

  r.put('/talent-pool/:candidateId', ...staff, wrap(async (req, res) => {
    const b = parse(z.object({
      notes: z.string().max(8000).optional(),
      internalRemarks: z.string().max(8000).optional(),
      candidateNotes: z.string().max(8000).optional(),
      tags: z.array(z.string().trim().min(1).max(60)).max(40).optional(),
    }), req.body);
    if (req.session.role !== 'recruiter') throw forbidden('Only a recruiter can edit their own pool entry.');
    const entry = await withUser(req.session, async (c) => {
      const upd = await c.query(
        `update talent_pool
            set notes = coalesce($2, notes), internal_remarks = coalesce($3, internal_remarks),
                candidate_notes = coalesce($4, candidate_notes), tags = coalesce($5::text[], tags),
                updated_at = now()
          where candidate_id = $1 and recruiter_id = app_recruiter_id()
          returning *, true as mine`,
        [req.params.candidateId, b.notes ?? null, b.internalRemarks ?? null,
         b.candidateNotes ?? null, b.tags ?? null]);
      if (!upd.rowCount) throw notFound('That candidate is not in your talent pool.');
      return upd.rows[0];
    });
    res.json({ entry: shape(entry) });
  }));

  r.delete('/talent-pool/:candidateId', ...staff, wrap(async (req, res) => {
    if (req.session.role !== 'recruiter') throw forbidden('Only a recruiter can edit their own pool.');
    const gone = await withUser(req.session, async (c) => (await c.query(
      `delete from talent_pool where candidate_id = $1 and recruiter_id = app_recruiter_id()`,
      [req.params.candidateId])).rowCount);
    if (!gone) throw notFound('That candidate is not in your talent pool.');
    res.json({ removed: true });
  }));

  return r;
}
