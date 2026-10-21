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
 *   GET    /api/whatsapp/conversations?numberId=       the contacts of one number they may use
 *   GET    /api/whatsapp/conversations/:numberId/:contact   one conversation (inbound, replies and sent messages of that number only)
 */
import { Router } from 'express';
import { z } from 'zod';
import crypto from 'node:crypto';
import { withUser } from '../db.js';
import { wrap, badRequest, forbidden, ApiError } from '../errors.js';
import { requireAuth, requireRole } from '../auth.js';
import { newId } from '../ai/interview-lifecycle.js';
import { secretKeyConfigured } from '../publishing/secrets.js';
import { whatsappProvider } from '../notify/providers.js';
import {
  listNumbers, assignableStaff, createNumber, updateNumber, setAccess, verifyNumber, setDefault, setActive, removeNumber, myNumbers, recordMessage,
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

  const allowed = async (session, numberId) => {
    const ok = await withUser(session, async (c) => (await c.query(`select whatsapp_number_allowed($1) as ok`, [numberId])).rows[0].ok);
    if (!ok) throw forbidden('You are not allowed to see that WhatsApp number.');
  };

  const WINDOW_MS = 24 * 3600 * 1000;

  /* the inbox: every conversation on the numbers this person may use (or on one number), newest first */
  r.get('/whatsapp/conversations', requireAuth(), requireRole(...STAFF), wrap(async (req, res) => {
    const numberId = String(req.query.numberId || '');
    if (numberId) await allowed(req.session, numberId);
    const rows = await withUser(req.session, async (c) => (await c.query(
      `with ev as (
         select number_id, contact, contact_name as name, candidate_id, created_at as at, body, direction, kind from whatsapp_messages
         union all
         select whatsapp_number_id, regexp_replace(coalesce(to_address,''), '\\D', '', 'g'), candidate_name, candidate_id, coalesce(sent_at, queued_at), body, 'out', 'template'
           from message_logs where channel = 'whatsapp' and whatsapp_number_id is not null and to_address is not null
       )
       select e.number_id, max(n.display_name) as number_name, max(n.display_phone) as number_phone, e.contact,
              (array_agg(e.name order by e.at desc) filter (where e.name is not null))[1] as name,
              (array_agg(e.candidate_id order by e.at desc) filter (where e.candidate_id is not null))[1] as candidate_id,
              max(e.at) as last_at, (array_agg(e.body order by e.at desc))[1] as last_body, (array_agg(e.direction order by e.at desc))[1] as last_direction,
              count(*) filter (where e.direction = 'in')::int as received, count(*) filter (where e.direction = 'out')::int as sent,
              max(e.at) filter (where e.direction = 'in') as last_in_at,
              max(e.at) filter (where e.direction = 'out' and e.kind <> 'agent_reply') as last_human_out_at
         from ev e join whatsapp_my_numbers() n on n.id = e.number_id
        where ($1::text = '' or e.number_id = $1) and e.contact <> ''
        group by e.number_id, e.contact order by max(e.at) desc limit 300`, [numberId])).rows);
    res.json({
      numberId: numberId || null,
      contacts: rows.map((x) => ({
        numberId: x.number_id, numberName: x.number_name, numberPhone: x.number_phone, contact: x.contact, name: x.name || null, candidateId: x.candidate_id || null,
        lastAt: x.last_at, lastText: String(x.last_body || '').slice(0, 140), lastDirection: x.last_direction, received: x.received, sent: x.sent,
        needsReply: !!x.last_in_at && (!x.last_human_out_at || new Date(x.last_in_at) > new Date(x.last_human_out_at)), windowOpen: !!x.last_in_at && Date.now() - new Date(x.last_in_at).getTime() < WINDOW_MS,
      })),
    });
  }));

  r.get('/whatsapp/conversations/:numberId/:contact', requireAuth(), requireRole(...STAFF), wrap(async (req, res) => {
    const { numberId } = req.params;
    const contact = String(req.params.contact || '').replace(/\D/g, '');
    if (!contact) throw badRequest('Choose a contact.');
    await allowed(req.session, numberId);
    const { inb, out, who } = await withUser(req.session, async (c) => ({
      inb: (await c.query(`select direction, kind, body, created_at as at, contact_name, sent_by_name from whatsapp_messages where number_id = $1 and contact = $2 order by created_at limit 500`, [numberId, contact])).rows,
      out: (await c.query(
        `select body, status, error, recruiter_name, template_name, coalesce(sent_at, queued_at) as at, delivered_at, read_at
           from message_logs where whatsapp_number_id = $1 and channel = 'whatsapp' and regexp_replace(coalesce(to_address,''), '\\D', '', 'g') = $2
          order by coalesce(sent_at, queued_at) limit 500`, [numberId, contact])).rows,
      who: (await c.query(
        `select id, name from candidates where length($1) >= 10 and right(regexp_replace(coalesce(phone, ''), '\\D', '', 'g'), 10) = right($1, 10) limit 1`, [contact])).rows[0] || null,
    }));
    const thread = [
      ...inb.map((m) => ({ direction: m.direction, kind: m.kind, text: m.body, at: m.at,
        by: m.direction === 'in' ? (m.contact_name || null) : (m.kind === 'reply' ? m.sent_by_name : 'TeamLink assistant') })),
      ...out.map((m) => ({ direction: 'out', kind: 'template', text: m.body, at: m.at, by: m.recruiter_name || null, template: m.template_name || null,
        status: m.read_at ? 'read' : m.status, error: m.error || null })),
    ].sort((a, b) => new Date(a.at) - new Date(b.at));
    const lastIn = inb.filter((m) => m.direction === 'in').map((m) => new Date(m.at).getTime()).sort((a, b) => b - a)[0];
    const open = !!lastIn && Date.now() - lastIn < WINDOW_MS;
    res.json({ numberId, contact, candidate: who ? { id: who.id, name: who.name } : null, thread,
      window: { open, endsAt: open ? new Date(lastIn + WINDOW_MS).toISOString() : null } });
  }));

  /* A recruiter's reply, in the portal. Free text is allowed only inside WhatsApp's 24-hour customer-service window (the candidate
     wrote to this number in the last 24 hours); outside it the only way to write first is an approved template. */
  r.post('/whatsapp/conversations/:numberId/:contact/reply', requireAuth(), requireRole(...STAFF), wrap(async (req, res) => {
    const { numberId } = req.params;
    const contact = String(req.params.contact || '').replace(/\D/g, '');
    const b = parse(z.object({ text: z.string().trim().min(1, 'Type a reply first.').max(4000) }), req.body);
    await allowed(req.session, numberId);
    const info = await withUser(req.session, async (c) => ({
      lastIn: (await c.query(`select max(created_at) as t, (array_agg(body order by created_at desc))[1] as last_body from whatsapp_messages where number_id = $1 and contact = $2 and direction = 'in'`, [numberId, contact])).rows[0],
      cand: (await c.query(`select id, name, do_not_contact from candidates where length($1) >= 10 and right(regexp_replace(coalesce(phone, ''), '\\D', '', 'g'), 10) = right($1, 10) limit 1`, [contact])).rows[0] || null,
      me: (await c.query(`select coalesce((select name from recruiters where user_id = app_user_id()), (select name from bde_users where user_id = app_user_id()), (select name from admins where user_id = app_user_id()), 'Staff') as n`)).rows[0].n,
    }));
    if (!info.lastIn.t || Date.now() - new Date(info.lastIn.t).getTime() >= WINDOW_MS) {
      throw new ApiError(409, 'WINDOW_CLOSED', 'This contact has not written to this number in the last 24 hours, so WhatsApp only allows an approved template now. Use Send WhatsApp with a template.');
    }
    if (info.cand && info.cand.do_not_contact) throw new ApiError(409, 'DO_NOT_CONTACT', 'This candidate asked not to be contacted.');
    if (/^\s*(stop|stop all|unsubscribe|opt ?out|cancel messages)\s*[.!]*$/i.test(String(info.lastIn.last_body || ''))) {
      throw new ApiError(409, 'OPTED_OUT', 'This contact asked to stop receiving messages.');
    }
    const out = await whatsappProvider.send({ to: contact, text: b.text, numberId, freeText: true });
    if (out.status !== 'sent') throw new ApiError(502, 'WHATSAPP_SEND_FAILED', out.error || 'WhatsApp did not accept the message.');
    await recordMessage({ numberId, direction: 'out', contact, body: b.text, waId: out.ref, kind: 'reply', by: info.me });
    res.status(201).json({ sent: true });
  }));

  return r;
}
