/**
 * The WhatsApp Inbox (0161): every conversation a recruiter is allowed to see, in one place, kept live.
 *
 *   GET  /api/whatsapp/inbox/summary                          unread total and "waiting for a reply" count (the header badge)
 *   GET  /api/whatsapp/inbox/filters                          campaigns, recruiters, departments and numbers to filter by (+ staff for an administrator)
 *   GET  /api/whatsapp/inbox/conversations                    the list: q, numberId, campaign, assignee, department, from, to, unread=1, reply=needs|replied
 *   GET  /api/whatsapp/inbox/conversations/:id                one conversation with its messages, status ticks, campaign context, window
 *   POST /api/whatsapp/inbox/conversations/:id/read           opening it marks it read - for that person only
 *   POST /api/whatsapp/inbox/conversations/:id/messages       { text, clientKey } a reply (inside the 24-hour window)
 *   POST /api/whatsapp/inbox/conversations/:id/media          the file as the request body (Content-Type = its type), ?filename=&caption=
 *   PUT  /api/whatsapp/inbox/conversations/:id/assign         { userId | null }   administrator only; the history stays
 *   GET  /api/whatsapp/inbox/media/:messageId                 a photo / document a contact sent, fetched from WhatsApp for those who may see it
 *   GET  /api/whatsapp/inbox/stream                           server-sent events: "something changed" (no message text)
 *
 * WHO SEES WHAT is decided by the database (row-level security on whatsapp_conversations / whatsapp_messages): an administrator sees all; anyone else
 * sees the conversations on numbers they may use that are unassigned or assigned to them. Nothing here widens that, and an event carries no text.
 * REPLIES go out through the number of the conversation, using the existing WhatsApp provider; free text only inside WhatsApp's 24-hour window.
 */
import { Router } from 'express';
import express from 'express';
import { z } from 'zod';
import { withUser } from '../db.js';
import { wrap, badRequest, forbidden, notFound, ApiError } from '../errors.js';
import { requireAuth, requireRole } from '../auth.js';
import { whatsappProvider } from '../notify/providers.js';
import { recordMessage, sendMedia, fetchMedia, mediaRuleFor } from '../whatsapp/numbers.js';
import { subscribe, publish } from '../whatsapp/events.js';

const STAFF = ['recruiter', 'bde', 'admin'];
const WINDOW_MS = 24 * 3600 * 1000;
const auth = [requireAuth(), requireRole(...STAFF)];

const parse = (schema, body) => {
  const out = schema.safeParse(body || {});
  if (!out.success) {
    const details = {};
    for (const i of out.error.issues) details[i.path.join('.') || 'form'] = i.message;
    throw badRequest(out.error.issues[0].message || 'Please check the form and try again.', details);
  }
  return out.data;
};

/* The list: one query, run as the signed-in person, so row-level security decides which rows exist for them. */
const LIST_SQL = `
  select c.*, n.display_name as number_name, n.display_phone as number_phone, cd.name as candidate_name,
         (select count(*)::int from whatsapp_messages m
           where m.conversation_id = c.id and m.direction = 'in'
             and m.created_at > coalesce((select r.read_at from whatsapp_conversation_reads r where r.conversation_id = c.id and r.user_id = app_user_id()), 'epoch'::timestamptz)) as unread,
         si.name as assignee_name, si.department as assignee_department
    from whatsapp_conversations c
    left join whatsapp_my_numbers() n on n.id = c.number_id
    left join candidates cd on cd.id = c.candidate_id
    left join lateral whatsapp_staff_info(c.assigned_to) si on true`;

const needsReply = (c) => !!c.last_inbound_at && (!c.last_human_out_at || new Date(c.last_inbound_at) > new Date(c.last_human_out_at));

const shapeConv = (c) => ({
  id: c.id, numberId: c.number_id, numberName: c.number_name || null, numberPhone: c.number_phone || null,
  contact: c.contact, name: c.candidate_name || c.contact_name || null, candidateId: c.candidate_id || null,
  lastText: c.last_message_text || '', lastDirection: c.last_direction, lastStatus: c.last_status || null, lastAt: c.last_message_at,
  unread: c.unread || 0, needsReply: needsReply(c),
  windowOpen: !!c.last_inbound_at && Date.now() - new Date(c.last_inbound_at).getTime() < WINDOW_MS,
  assignee: c.assigned_to ? { id: c.assigned_to, name: c.assignee_name || null, department: c.assignee_department || null } : null,
  campaign: c.campaign_batch_id ? { batchId: c.campaign_batch_id, name: c.campaign_name || null, match: c.campaign_match || null } : null,
});

const recent = new Map();                       // clientKey -> { at, result }: the same reply sent twice (a double click, a retried request) is one reply
const remember = (k, result) => { recent.set(k, { at: Date.now(), result }); for (const [key, v] of recent) if (Date.now() - v.at > 120000) recent.delete(key); };

export default function whatsappInboxRoutes() {
  const r = Router();

  const one = async (session, id) => {
    const rows = await withUser(session, async (c) => (await c.query(`${LIST_SQL} where c.id = $1`, [id])).rows);
    if (!rows.length) throw notFound('That conversation could not be found.');
    return rows[0];
  };

  r.get('/whatsapp/inbox/stream', ...auth, (req, res) => subscribe(req, res));

  r.get('/whatsapp/inbox/summary', ...auth, wrap(async (req, res) => {
    const rows = await withUser(req.session, async (c) => (await c.query(`${LIST_SQL} limit 1000`)).rows);
    res.json({ unread: rows.reduce((t, x) => t + (x.unread || 0), 0), unreadConversations: rows.filter((x) => x.unread > 0).length, waiting: rows.filter(needsReply).length });
  }));

  r.get('/whatsapp/inbox/filters', ...auth, wrap(async (req, res) => {
    const out = await withUser(req.session, async (c) => ({
      campaigns: (await c.query(
        `select campaign_batch_id as id, max(campaign_name) as name, count(distinct conversation_id)::int as conversations,
                count(*) filter (where direction = 'in' and campaign_match is not null)::int as replies
           from whatsapp_messages where campaign_batch_id is not null group by 1 order by max(created_at) desc limit 200`)).rows,
      assignees: (await c.query(
        `select distinct c.assigned_to as id, si.name, si.department from whatsapp_conversations c, lateral whatsapp_staff_info(c.assigned_to) si
          where c.assigned_to is not null order by si.name`)).rows,
      numbers: (await c.query(`select id, display_name, display_phone from whatsapp_my_numbers()`)).rows,
    }));
    const admin = req.session.role === 'admin';
    let staff = [];
    if (admin) {
      staff = (await withUser(req.session, async (c) => (await c.query(
        `select u.id as user_id, si.name, si.department, u.role from users u, lateral whatsapp_staff_info(u.id) si
          where u.role in ('recruiter', 'bde', 'admin') order by lower(si.name)`)).rows)).map((u) => ({ userId: u.user_id, name: u.name, department: u.department, role: u.role }));
    }
    const depts = [...new Set([...out.assignees.map((a) => a.department), ...staff.map((s) => s.department)].filter(Boolean))].sort((a, b) => a.localeCompare(b));
    res.json({
      campaigns: out.campaigns.map((x) => ({ id: x.id, name: x.name, conversations: x.conversations, replies: x.replies })),
      assignees: out.assignees.map((a) => ({ id: a.id, name: a.name, department: a.department })),
      departments: depts, numbers: out.numbers.map((n) => ({ id: n.id, name: n.display_name, phone: n.display_phone })),
      canAssign: admin, staff,
    });
  }));

  r.get('/whatsapp/inbox/conversations', ...auth, wrap(async (req, res) => {
    const q = req.query;
    const where = [], params = [];
    const add = (sql, v) => { params.push(v); where.push(sql.split('$#').join(`$${params.length}`)); };
    if (q.q) add(`(coalesce(cd.name, c.contact_name, '') ilike $# or c.contact like $# or coalesce(c.last_message_text, '') ilike $# or coalesce(c.campaign_name, '') ilike $#)`, `%${String(q.q).trim().replace(/[%_]/g, '')}%`);
    if (q.numberId) add('c.number_id = $#', String(q.numberId));
    if (q.campaign) add('c.campaign_batch_id = $#', String(q.campaign));
    if (q.assignee === 'none') where.push('c.assigned_to is null');
    else if (q.assignee) {
      if (!/^[0-9a-f-]{36}$/i.test(String(q.assignee))) throw badRequest('Choose a recruiter from the list.');
      add('c.assigned_to = $#::uuid', String(q.assignee));
    }
    if (q.department) add(`(lower(coalesce(si.department, '')) = lower($#) or exists (select 1 from whatsapp_number_departments d where d.number_id = c.number_id and lower(d.department) = lower($#)))`, String(q.department));
    if (q.from) add('c.last_message_at >= $#::date', String(q.from).slice(0, 10));
    if (q.to) add(`c.last_message_at < ($#::date + interval '1 day')`, String(q.to).slice(0, 10));
    if (q.reply === 'needs') where.push('(c.last_inbound_at is not null and (c.last_human_out_at is null or c.last_inbound_at > c.last_human_out_at))');
    if (q.reply === 'replied') where.push('(c.last_human_out_at is not null and (c.last_inbound_at is null or c.last_human_out_at >= c.last_inbound_at))');
    const unreadOnly = String(q.unread) === '1' || String(q.unread) === 'true';
    const rows = await withUser(req.session, async (c) => (await c.query(
      `select * from (${LIST_SQL} ${where.length ? 'where ' + where.join(' and ') : ''}) x ${unreadOnly ? 'where x.unread > 0' : ''}
        order by x.last_message_at desc limit 300`, params)).rows);
    res.json({ conversations: rows.map(shapeConv) });
  }));

  r.get('/whatsapp/inbox/conversations/:id', ...auth, wrap(async (req, res) => {
    const c = await one(req.session, req.params.id);
    const msgs = await withUser(req.session, async (db) => (await db.query(
      `select m.id, m.direction, m.kind, m.body, m.created_at, m.status, m.error, m.media, m.sent_by_name, m.contact_name, m.campaign_batch_id, m.campaign_name,
              m.campaign_match, m.wa_message_id, q.body as quoted_body, q.direction as quoted_direction, q.created_at as quoted_at, q.sent_by_name as quoted_by
         from whatsapp_messages m
         left join whatsapp_messages q on q.number_id = m.number_id and q.wa_message_id = m.context_wamid
        where m.conversation_id = $1 order by m.created_at, m.id limit 600`, [req.params.id])).rows);
    const original = c.campaign_batch_id ? await withUser(req.session, async (db) => (await db.query(
      `select body, created_at from whatsapp_messages where conversation_id = $1 and campaign_batch_id = $2 and direction = 'out' order by created_at limit 1`,
      [req.params.id, c.campaign_batch_id])).rows[0]) : null;
    const open = !!c.last_inbound_at && Date.now() - new Date(c.last_inbound_at).getTime() < WINDOW_MS;
    res.json({
      conversation: shapeConv(c),
      messages: msgs.map((m) => ({
        id: m.id, direction: m.direction, kind: m.kind, text: m.body, at: m.created_at, status: m.direction === 'out' ? (m.status || 'sent') : null, error: m.error || null,
        media: m.media ? { type: m.media.type, mime: m.media.mime || null, filename: m.media.filename || null, caption: m.media.caption || null } : null,
        by: m.direction === 'in' ? (m.contact_name || null) : (m.sent_by_name || (m.kind === 'agent_reply' ? 'TeamLink assistant' : null)),
        campaign: m.campaign_batch_id ? { batchId: m.campaign_batch_id, name: m.campaign_name, match: m.campaign_match } : null,
        replyTo: m.quoted_body ? { text: m.quoted_body, direction: m.quoted_direction, at: m.quoted_at, by: m.quoted_by || null } : null,
      })),
      campaignContext: c.campaign_batch_id ? { batchId: c.campaign_batch_id, name: c.campaign_name, match: c.campaign_match, originalMessage: original ? original.body : null, sentAt: original ? original.created_at : null } : null,
      window: { open, endsAt: open ? new Date(new Date(c.last_inbound_at).getTime() + WINDOW_MS).toISOString() : null },
      canAssign: req.session.role === 'admin',
    });
  }));

  r.post('/whatsapp/inbox/conversations/:id/read', ...auth, wrap(async (req, res) => {
    await withUser(req.session, (c) => c.query(`select whatsapp_conversation_mark_read($1)`, [req.params.id]))
      .catch((e) => { throw e && e.code === '42501' ? forbidden('You cannot open that conversation.') : e; });
    publish({ type: 'read', conversationId: req.params.id });
    res.json({ read: true });
  }));

  /* the checks every reply passes, then the conversation it goes to */
  async function replyContext(session, id) {
    const c = await one(session, id);
    const info = await withUser(session, async (db) => ({
      last: (await db.query(`select body from whatsapp_messages where conversation_id = $1 and direction = 'in' order by created_at desc limit 1`, [id])).rows[0],
      cand: c.candidate_id ? (await db.query(`select do_not_contact from candidates where id = $1`, [c.candidate_id])).rows[0] : null,
      me: (await db.query(`select name from whatsapp_staff_info(app_user_id())`)).rows[0],
      allowed: (await db.query(`select whatsapp_number_allowed($1) as ok`, [c.number_id])).rows[0].ok,
    }));
    if (!info.allowed) throw forbidden('That WhatsApp number is not available to you.');
    if (!c.last_inbound_at || Date.now() - new Date(c.last_inbound_at).getTime() >= WINDOW_MS) {
      throw new ApiError(409, 'WINDOW_CLOSED', 'This contact has not written to this number in the last 24 hours, so WhatsApp only allows an approved template now. Use Send WhatsApp with a template.');
    }
    if (info.cand && info.cand.do_not_contact) throw new ApiError(409, 'DO_NOT_CONTACT', 'This candidate asked not to be contacted.');
    if (/^\s*(stop|stop all|unsubscribe|opt ?out|cancel messages)\s*[.!]*$/i.test(String((info.last && info.last.body) || ''))) {
      throw new ApiError(409, 'OPTED_OUT', 'This contact asked to stop receiving messages.');
    }
    return { c, me: (info.me && info.me.name) || 'Staff' };
  }

  r.post('/whatsapp/inbox/conversations/:id/messages', ...auth, wrap(async (req, res) => {
    const b = parse(z.object({ text: z.string().trim().min(1, 'Type a reply first.').max(4000), clientKey: z.string().trim().max(80).optional() }), req.body);
    const key = b.clientKey ? `${req.session.userId}:${b.clientKey}` : null;
    if (key && recent.has(key)) return res.status(200).json({ ...recent.get(key).result, duplicate: true });
    const { c, me } = await replyContext(req.session, req.params.id);
    const out = await whatsappProvider.send({ to: c.contact, text: b.text, numberId: c.number_id, freeText: true });
    const rec = await recordMessage({ numberId: c.number_id, direction: 'out', contact: c.contact, body: b.text, waId: out.ref, kind: 'reply', by: me, userId: req.session.userId,
      status: out.status === 'sent' ? 'sent' : 'failed', error: out.status === 'sent' ? null : out.error });
    if (out.status !== 'sent') throw new ApiError(502, 'WHATSAPP_SEND_FAILED', out.error || 'WhatsApp did not accept the message.');
    const result = { sent: true, messageId: rec && rec.id };
    if (key) remember(key, result);
    res.status(201).json(result);
  }));

  r.post('/whatsapp/inbox/conversations/:id/media', ...auth, express.raw({ type: () => true, limit: '12mb' }), wrap(async (req, res) => {
    const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const rule = mediaRuleFor(mime);
    if (!rule) throw badRequest('That file type cannot be sent on WhatsApp (photos JPG / PNG, PDF, Word, Excel, PowerPoint, text, MP4 video, common audio).');
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!buf.length) throw badRequest('Choose a file to send.');
    if (buf.length > rule.max) throw badRequest(`That ${rule.type} is too large for WhatsApp (the limit is ${Math.round(rule.max / 1048576)} MB).`);
    const filename = String(req.query.filename || 'file').replace(/[^\w.\- ]+/g, '_').slice(0, 100);
    const caption = String(req.query.caption || '').slice(0, 1000);
    const key = req.query.clientKey ? `${req.session.userId}:${String(req.query.clientKey).slice(0, 80)}` : null;
    if (key && recent.has(key)) return res.status(200).json({ ...recent.get(key).result, duplicate: true });
    const { c, me } = await replyContext(req.session, req.params.id);
    const out = await sendMedia({ numberId: c.number_id, to: c.contact, mime, filename, buffer: buf, caption });
    const media = { type: rule.type, mime, filename, caption: caption || null, id: out.mediaId || null };
    const rec = await recordMessage({ numberId: c.number_id, direction: 'out', contact: c.contact, body: caption || (rule.type === 'document' ? `Document: ${filename}` : `${rule.type[0].toUpperCase()}${rule.type.slice(1)}`),
      waId: out.ref, kind: 'reply', by: me, userId: req.session.userId, media, status: out.status === 'sent' ? 'sent' : 'failed', error: out.status === 'sent' ? null : out.error });
    if (out.status !== 'sent') throw new ApiError(502, 'WHATSAPP_SEND_FAILED', out.error || 'WhatsApp did not accept the file.');
    const result = { sent: true, messageId: rec && rec.id };
    if (key) remember(key, result);
    res.status(201).json(result);
  }));

  r.put('/whatsapp/inbox/conversations/:id/assign', requireAuth(), requireRole('admin'), wrap(async (req, res) => {
    const b = parse(z.object({ userId: z.string().uuid().nullable() }), req.body);
    await withUser(req.session, (c) => c.query(`select whatsapp_conversation_assign($1,$2)`, [req.params.id, b.userId]))
      .catch((e) => { throw e && e.code === 'P0002' ? notFound('That conversation could not be found.') : e && e.code === '22023' ? new ApiError(422, 'VALIDATION_FAILED', 'That person cannot be assigned a conversation.') : e; });
    publish({ type: 'assign', conversationId: req.params.id });
    res.json({ conversation: shapeConv(await one(req.session, req.params.id)) });
  }));

  r.get('/whatsapp/inbox/media/:messageId', ...auth, wrap(async (req, res) => {
    const m = await withUser(req.session, async (c) => (await c.query(
      `select number_id, media from whatsapp_messages where id = $1 and media is not null`, [Number(req.params.messageId) || 0])).rows[0]);
    if (!m || !m.media || !m.media.id) throw notFound('That file could not be found.');
    const f = await fetchMedia(m.number_id, m.media.id);
    const inline = /^(image\/|application\/pdf|video\/|audio\/)/.test(f.mime);
    res.set({ 'content-type': f.mime, 'cache-control': 'private, max-age=3600',
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${String(m.media.filename || `file`).replace(/"/g, '')}"` });
    res.end(f.buffer);
  }));

  return r;
}
