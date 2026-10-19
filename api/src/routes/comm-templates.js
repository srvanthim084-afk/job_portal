/**
 * Templates & Campaigns (0157) - the registry behind the Recruiter Portal's header button.
 *
 *   GET  /api/comm/templates                filters: channel, department, approval, q, archived=true
 *   GET  /api/comm/templates/:id            one template with its saved versions
 *   POST /api/comm/templates                create (an administrator's is approved at once, anybody else's waits)
 *   PUT  /api/comm/templates/:id            edit your own: a new version, back to waiting
 *   POST /api/comm/templates/:id/review     { decision: approved | changes_needed, note }  administrator / team lead (not the author)
 *   POST /api/comm/templates/:id/duplicate  an editable copy (the way to change a built-in one)
 *   POST /api/comm/templates/:id/archive    { archived }
 *   GET  /api/comm/campaigns                the AI calling campaigns the caller may see
 *
 * Every write is a database function that checks who is asking; this file validates input, shapes rows for the screen and says
 * for each row what THIS caller may do with it - the buttons on the screen follow that, the database enforces it.
 */
import { Router } from 'express';
import { z } from 'zod';
import { withUser } from '../db.js';
import { wrap, badRequest, notFound, forbidden, ApiError } from '../errors.js';
import { requireAuth, requireRole } from '../auth.js';
import { newId } from '../ai/interview-lifecycle.js';
import { TEMPLATES } from '../notify/bulk.js';

const ENGINE = { userId: '', role: 'admin', profileId: null };
const STAFF = ['recruiter', 'bde', 'admin'];
const CHANNELS = ['call', 'email', 'sms', 'whatsapp'];

const parse = (schema, body) => {
  const out = schema.safeParse(body || {});
  if (!out.success) {
    const details = {};
    for (const i of out.error.issues) details[i.path.join('.') || 'form'] = i.message;
    throw badRequest('Please check the highlighted fields and try again.', details);
  }
  return out.data;
};

/** A database refusal, said the way the screen should say it. */
function dbError(err) {
  const m = String((err && err.message) || '');
  if (err && err.code === '42501') return forbidden(m || 'You are not allowed to do that.');
  if (err && err.code === 'P0002') return notFound('That template could not be found.');
  if (err && err.code === '22023') return new ApiError(422, 'VALIDATION_FAILED', m.charAt(0).toUpperCase() + m.slice(1) + '.');
  return err;
}

const shape = (t, who) => {
  const mine = !!who.id && t.created_by === who.id;
  const portal = t.source === 'portal';
  return {
    id: t.id, name: t.name, channel: t.kind, subject: t.subject || '', body: t.body || '',
    department: t.department, usedIn: t.used_in || [],
    approval: t.approval_state, approvalNote: t.approval_note || null,
    version: t.version, source: t.source, archived: !!t.archived,
    createdBy: t.created_by_name || null, updatedAt: t.updated_at, approvedAt: t.approved_at || null,
    /* 0158: a WhatsApp Business template (sent through the WhatsApp API); edited in its own form by an administrator */
    wa: t.wa_name ? { waName: t.wa_name, language: t.wa_language, status: t.wa_status } : null,
    /* what THIS person may do with it (the database checks again) */
    canEdit: t.wa_name ? who.role === 'admin' : portal && (who.role === 'admin' || (who.role === 'recruiter' && mine)),
    canArchive: portal && (who.role === 'admin' || (who.role === 'recruiter' && mine)),
    canReview: portal && t.approval_state !== 'approved' && (who.role === 'admin' || (who.teamLead && !mine)),
    canDuplicate: who.role === 'admin' || who.role === 'recruiter',
  };
};

async function whoIs(session) {
  const out = { role: session.role, id: session.profileId || null, teamLead: false };
  if (session.role === 'recruiter' && session.profileId) {
    const r = await withUser(ENGINE, async (c) => (await c.query(
      `select is_team_lead from recruiters where id = $1`, [session.profileId])).rows[0]);
    out.teamLead = !!(r && r.is_team_lead);
  }
  return out;
}

/** The compose box's built-in wording becomes visible rows, once (idempotent). */
let seeded = false;
async function ensureBuiltins() {
  if (seeded) return;
  for (const t of TEMPLATES) {
    if (t.id === 'blank') continue;
    for (const channel of t.channels) {
      await withUser(ENGINE, (c) => c.query(
        `select comm_template_seed_builtin($1,$2,$3,$4,$5,$6)`,
        [`sys_msg_${t.id}_${channel}`, t.name, channel, channel === 'email' ? t.subject : '', t.body,
         ['Compose message', 'Bulk message']]));
    }
  }
  seeded = true;
}

const templateSchema = z.object({
  name: z.string().trim().min(1, 'Give the template a name.').max(120),
  channel: z.enum(CHANNELS),
  subject: z.string().trim().max(200).optional(),
  body: z.string().trim().min(1, 'The template needs some text.').max(8000),
  department: z.string().trim().max(80).optional(),
  usedIn: z.array(z.string().trim().min(1).max(80)).max(12).optional(),
});

export default function commTemplateRoutes() {
  const r = Router();

  r.get('/comm/templates', requireAuth(), requireRole(...STAFF), wrap(async (req, res) => {
    await ensureBuiltins();
    const who = await whoIs(req.session);
    const q = req.query;
    const rows = await withUser(req.session, async (c) => {
      const where = [], params = [];
      if (String(q.archived) !== 'true') where.push('not archived');
      if (CHANNELS.includes(String(q.channel || ''))) { params.push(q.channel); where.push(`kind = $${params.length}`); }
      if (q.department) { params.push(String(q.department)); where.push(`department = $${params.length}`); }
      if (['approved', 'waiting', 'changes_needed'].includes(String(q.approval || ''))) { params.push(q.approval); where.push(`approval_state = $${params.length}`); }
      if (q.q) {
        params.push(`%${String(q.q).trim()}%`);
        where.push(`(name ilike $${params.length} or coalesce(subject,'') ilike $${params.length} or body ilike $${params.length}
                     or exists (select 1 from unnest(used_in) u where u ilike $${params.length}))`);
      }
      return (await c.query(
        `select * from comm_templates ${where.length ? 'where ' + where.join(' and ') : ''}
          order by (source = 'system'), updated_at desc, name limit 500`, params)).rows;
    });
    const departments = await withUser(req.session, async (c) => (await c.query(
      `select distinct department d from comm_templates where department is not null
        union select distinct department from recruiters where department is not null and btrim(department) <> ''
        order by 1`)).rows.map((x) => x.d));
    res.json({
      templates: rows.map((t) => shape(t, who)),
      departments,
      permissions: { role: who.role, canCreate: who.role === 'admin' || who.role === 'recruiter', canReview: who.role === 'admin' || who.teamLead },
    });
  }));

  r.get('/comm/templates/:id', requireAuth(), requireRole(...STAFF), wrap(async (req, res) => {
    const who = await whoIs(req.session);
    const t = await withUser(req.session, async (c) => (await c.query(`select * from comm_templates where id = $1`, [req.params.id])).rows[0]);
    if (!t) throw notFound('That template could not be found.');
    const versions = await withUser(req.session, async (c) => (await c.query(
      `select version, name, subject, body, department, saved_by, saved_at from comm_template_versions
        where template_id = $1 order by version desc`, [req.params.id])).rows);
    res.json({
      template: shape(t, who),
      versions: versions.map((v) => ({ version: v.version, name: v.name, subject: v.subject || '', body: v.body, department: v.department, savedBy: v.saved_by, savedAt: v.saved_at })),
    });
  }));

  r.post('/comm/templates', requireAuth(), requireRole('recruiter', 'admin'), wrap(async (req, res) => {
    const b = parse(templateSchema, req.body);
    const who = await whoIs(req.session);
    const name = await withUser(ENGINE, async (c) => (await c.query(
      `select coalesce((select name from recruiters where id = $1), (select name from admins where id = $1), 'Administrator') as n`, [who.id])).rows[0].n)
      .catch(() => 'Recruiter');
    const t = await withUser(req.session, async (c) => (await c.query(
      `select * from comm_template_create($1,$2,$3,$4,$5,$6,$7,$8)`,
      [newId('tpl'), b.name, b.channel, b.subject || null, b.body, b.department || null, b.usedIn || [], name])).rows[0])
      .catch((e) => { throw dbError(e); });
    res.status(201).json({ template: shape(t, who) });
  }));

  r.put('/comm/templates/:id', requireAuth(), requireRole('recruiter', 'admin'), wrap(async (req, res) => {
    const b = parse(templateSchema.omit({ channel: true }), req.body);
    const who = await whoIs(req.session);
    const cur = await withUser(req.session, async (c) => (await c.query(`select wa_name from comm_templates where id = $1`, [req.params.id])).rows[0]);
    if (cur && cur.wa_name) throw new ApiError(422, 'VALIDATION_FAILED', 'A WhatsApp Business template is edited in its own form (administrators only).');
    const t = await withUser(req.session, async (c) => (await c.query(
      `select * from comm_template_update($1,$2,$3,$4,$5,$6)`,
      [req.params.id, b.name, b.subject || null, b.body, b.department || null, b.usedIn || []])).rows[0])
      .catch((e) => { throw dbError(e); });
    res.json({ template: shape(t, who) });
  }));

  r.post('/comm/templates/:id/review', requireAuth(), requireRole('recruiter', 'admin'), wrap(async (req, res) => {
    const b = parse(z.object({ decision: z.enum(['approved', 'changes_needed']), note: z.string().trim().max(500).optional() }), req.body);
    const who = await whoIs(req.session);
    const t = await withUser(req.session, async (c) => (await c.query(
      `select * from comm_template_review($1,$2,$3)`, [req.params.id, b.decision, b.note || null])).rows[0])
      .catch((e) => { throw dbError(e); });
    res.json({ template: shape(t, who) });
  }));

  r.post('/comm/templates/:id/archive', requireAuth(), requireRole('recruiter', 'admin'), wrap(async (req, res) => {
    const b = parse(z.object({ archived: z.boolean().optional() }), req.body);
    const who = await whoIs(req.session);
    const t = await withUser(req.session, async (c) => (await c.query(
      `select * from comm_template_archive($1,$2)`, [req.params.id, b.archived !== false])).rows[0])
      .catch((e) => { throw dbError(e); });
    res.json({ template: shape(t, who) });
  }));

  r.post('/comm/templates/:id/duplicate', requireAuth(), requireRole('recruiter', 'admin'), wrap(async (req, res) => {
    const who = await whoIs(req.session);
    const src = await withUser(req.session, async (c) => (await c.query(`select * from comm_templates where id = $1`, [req.params.id])).rows[0]);
    if (!src) throw notFound('That template could not be found.');
    const name = await withUser(ENGINE, async (c) => (await c.query(
      `select coalesce((select name from recruiters where id = $1), (select name from admins where id = $1), 'Administrator') as n`, [who.id])).rows[0].n)
      .catch(() => 'Recruiter');
    const t = await withUser(req.session, async (c) => (await c.query(
      `select * from comm_template_create($1,$2,$3,$4,$5,$6,$7,$8)`,
      [newId('tpl'), `${src.name} (copy)`.slice(0, 120), src.kind, src.subject, src.body || ' ', src.department, src.used_in || [], name])).rows[0])
      .catch((e) => { throw dbError(e); });
    res.status(201).json({ template: shape(t, who) });
  }));

  /* the campaigns the caller may see: the AI calling campaigns (row-level security decides which) */
  r.get('/comm/campaigns', requireAuth(), requireRole(...STAFF), wrap(async (req, res) => {
    const q = req.query;
    const rows = await withUser(req.session, async (c) => {
      const where = [], params = [];
      if (q.department) { params.push(String(q.department)); where.push(`coalesce(r.department, 'All departments') = $${params.length}`); }
      if (q.q) { params.push(`%${String(q.q).trim()}%`); where.push(`(c.name ilike $${params.length} or j.title ilike $${params.length})`); }
      return (await c.query(
        `select c.id, c.name, c.status, c.objective, c.language_mode, c.max_calls, c.created_at, c.scheduled_at,
                j.title as job_title, r.name as recruiter_name, r.department,
                (select count(*)::int from ai_call_sessions s where s.campaign_id = c.id) as calls
           from ai_call_campaigns c
           join jobs j on j.id = c.job_id
           left join recruiters r on r.id = c.recruiter_id
          ${where.length ? 'where ' + where.join(' and ') : ''}
          order by c.created_at desc limit 300`, params)).rows;
    });
    const channelOk = !q.channel || q.channel === 'call';
    res.json({
      campaigns: channelOk ? rows.map((x) => ({
        id: x.id, name: x.name, channel: 'call', usedIn: [x.job_title], department: x.department || 'All departments',
        status: x.status, objective: x.objective, language: x.language_mode, maxCalls: x.max_calls, calls: x.calls,
        owner: x.recruiter_name || null, createdAt: x.created_at, scheduledAt: x.scheduled_at || null,
      })) : [],
    });
  }));

  return r;
}
