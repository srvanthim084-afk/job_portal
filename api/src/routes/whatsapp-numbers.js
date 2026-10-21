/**
 * Several WhatsApp Business numbers (0160).
 *
 * ADMINISTRATOR (the one `admin` role; also enforced by row-level security and by the database functions)
 *   GET    /api/admin/whatsapp-numbers                 every number: status, departments, people, message counts (never a credential)
 *   GET    /api/admin/whatsapp-numbers/assignable      the staff and departments a number can be given to
 *   POST   /api/admin/whatsapp-numbers                 add a number (verified with WhatsApp straight away)
 *   PUT    /api/admin/whatsapp-numbers/:id             edit name / ids / token (blank token keeps the saved one)
 *   PUT    /api/admin/whatsapp-numbers/:id/access      { departments[], userIds[], openToAll }
 *   POST   /api/admin/whatsapp-numbers/:id/verify      Verify / Reconnect ({ accessToken? } to reconnect with a new token)
 *   POST   /api/admin/whatsapp-numbers/:id/default     make it the default
 *   POST   /api/admin/whatsapp-numbers/:id/active      { active } activate / deactivate
 *   DELETE /api/admin/whatsapp-numbers/:id             remove (its messages keep their history)
 *
 * STAFF (recruiters, team leaders, BDEs; an administrator sees every number)
 *   GET    /api/whatsapp/my-numbers                    the numbers THIS person may send from
 *   (the conversations themselves are the WhatsApp Inbox: routes/whatsapp-inbox.js)
 */
import { Router } from 'express';
import { z } from 'zod';
import crypto from 'node:crypto';
import { withUser } from '../db.js';
import { wrap, badRequest, forbidden, ApiError } from '../errors.js';
import { requireAuth, requireRole } from '../auth.js';
import { newId } from '../ai/interview-lifecycle.js';
import { secretKeyConfigured } from '../publishing/secrets.js';
import {
  listNumbers, assignableStaff, createNumber, updateNumber, setAccess, verifyNumber, setDefault, setActive, removeNumber, myNumbers,
} from '../whatsapp/numbers.js';

const admin = [requireAuth(), requireRole('admin')];
const STAFF = ['recruiter', 'bde', 'admin'];
const verifyToken = () => 'tlwh_' + crypto.randomBytes(18).toString('hex');

const parse = (schema, body) => {
  const out = schema.safeParse(body || {});
  if (!out.success) {
    const details = {};
    for (const i of out.error.issues) details[i.path.join('.') || 'form'] = i.message;
    throw badRequest('Please check the highlighted fields and try again.', details);
  }
  return out.data;
};

const dbError = (err) => {
  if (err && err.code === '42501') return forbidden(err.message);
  if (err && err.code === 'P0002') return new ApiError(404, 'NOT_FOUND', 'That WhatsApp number could not be found.');
  return err;
};

const bodySchema = z.object({
  displayName: z.string().trim().max(80).optional(),
  displayPhone: z.string().trim().max(30).optional(),
  phoneNumberId: z.string().trim().max(30).optional(),
  businessAccountId: z.string().trim().max(30).optional(),
  accessToken: z.string().trim().max(1000).optional(),
  appSecret: z.string().trim().max(200).optional(),
});

export default function whatsappNumberRoutes() {
  const r = Router();

  const view = async (req, id) => (await listNumbers(req.session)).find((n) => n.id === id);

  r.get('/admin/whatsapp-numbers', ...admin, wrap(async (req, res) => {
    res.json({
      numbers: await listNumbers(req.session),
      secretKeyConfigured: secretKeyConfigured(),
      webhook: { path: '/api/whatsapp-agent/webhook', note: 'One callback URL for the Meta app serves every number: each event says which number it is for.' },
    });
  }));

  r.get('/admin/whatsapp-numbers/assignable', ...admin, wrap(async (req, res) => { res.json(await assignableStaff(req.session)); }));

  r.post('/admin/whatsapp-numbers', ...admin, wrap(async (req, res) => {
    const b = parse(bodySchema, req.body);
    const id = await createNumber(req.session, b, newId, verifyToken);
    const n = await view(req, id);
    /* a duplicate or a bad token never leaves a half-made number behind: the number is saved, flagged and shown with the reason */
    res.status(201).json({ number: n });
  }));

  r.put('/admin/whatsapp-numbers/:id', ...admin, wrap(async (req, res) => {
    const b = parse(bodySchema, req.body);
    await updateNumber(req.session, req.params.id, b);
    res.json({ number: await view(req, req.params.id) });
  }));

  r.put('/admin/whatsapp-numbers/:id/access', ...admin, wrap(async (req, res) => {
    const b = parse(z.object({
      departments: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
      userIds: z.array(z.string().uuid()).max(500).optional(),
      openToAll: z.boolean().optional(),
    }), req.body);
    await setAccess(req.session, req.params.id, { departments: b.departments || [], userIds: b.userIds || [], openToAll: !!b.openToAll }).catch((e) => { throw dbError(e); });
    res.json({ number: await view(req, req.params.id) });
  }));

  r.post('/admin/whatsapp-numbers/:id/verify', ...admin, wrap(async (req, res) => {
    const b = parse(z.object({ accessToken: z.string().trim().max(1000).optional() }), req.body);
    await verifyNumber(req.session, req.params.id, b.accessToken || null);
    res.json({ number: await view(req, req.params.id) });
  }));

  r.post('/admin/whatsapp-numbers/:id/default', ...admin, wrap(async (req, res) => {
    await setDefault(req.session, req.params.id).catch((e) => { throw dbError(e); });
    res.json({ number: await view(req, req.params.id) });
  }));

  r.post('/admin/whatsapp-numbers/:id/active', ...admin, wrap(async (req, res) => {
    const b = parse(z.object({ active: z.boolean() }), req.body);
    await setActive(req.session, req.params.id, b.active);
    res.json({ number: await view(req, req.params.id) });
  }));

  r.delete('/admin/whatsapp-numbers/:id', ...admin, wrap(async (req, res) => {
    await removeNumber(req.session, req.params.id);
    res.json({ removed: true });
  }));

  /* ---------------------------------------------------------------- staff */
  r.get('/whatsapp/my-numbers', requireAuth(), requireRole(...STAFF), wrap(async (req, res) => {
    res.json({ numbers: await myNumbers(req.session) });
  }));

  return r;
}
