/**
 * WhatsApp template sending from the Recruiter Portal (0158).
 *
 *   GET  /api/whatsapp/templates                 the templates a recruiter may send (admin: ?all=true for every one)
 *   GET  /api/whatsapp/templates/:id             one template, with the form values an administrator edits
 *   POST /api/whatsapp/templates                 create / update a WhatsApp Business template      (administrator)
 *   PUT  /api/whatsapp/templates/:id             edit it                                           (administrator)
 *   POST /api/whatsapp/templates/sync            pull the approved templates from WhatsApp Business (administrator)
 *   POST /api/whatsapp/preview                   each candidate's own message, and whether they can be sent to
 *   POST /api/whatsapp/send                      queue one personalised template message per candidate (idempotent per sendKey)
 *   GET  /api/whatsapp/batches/:batchId          how a send is getting on, per candidate
 *   POST /api/whatsapp/batches/:batchId/retry    re-queue ONLY the failed ones
 *   GET  /api/whatsapp/history                   recent sends (a recruiter's own; an administrator sees everyone's, by recruiter)
 *
 * NO NEW SENDING PATH. Messages go onto the same queue (`message_logs`, drained by notify/bulk.js) through the same WhatsApp provider
 * as every other message, so the contact-cooldown, "another recruiter holds this candidate", availability and do-not-contact rules, the
 * outbound allow-list and the "sent only when the provider says so" rule all apply unchanged. This file decides WHO may be sent WHAT,
 * and fills each template in per candidate; it holds no credentials and calls no provider itself.
 */
import { Router } from 'express';
import { z } from 'zod';
import crypto from 'node:crypto';
import { withUser } from '../db.js';
import { config } from '../config.js';
import { wrap, badRequest, notFound, forbidden, ApiError } from '../errors.js';
import { requireAuth, requireRole } from '../auth.js';
import { newId } from '../ai/interview-lifecycle.js';
import { canEngageMany, audit } from '../candidates/engagement.js';
import { beginContact, finishContact, canOverride } from '../contact/service.js';
import {
  WA_VARIABLES, cleanTemplate, shapeTemplate, unsendable, loadContext, loadTemplate, listTemplates,
  valuesFor, fill, buildPayload, normalizePhone, syncFromMeta,
} from '../whatsapp/templates.js';

const ENGINE = { userId: '', role: 'admin', profileId: null };
const STAFF = ['recruiter', 'bde', 'admin'];
const MAX_PEOPLE = 500;

const parse = (schema, body) => {
  const out = schema.safeParse(body || {});
  if (!out.success) {
    const details = {};
    for (const i of out.error.issues) details[i.path.join('.') || 'form'] = i.message;
    throw badRequest('Please check the highlighted fields and try again.', details);
  }
  return out.data;
};

function dbError(err) {
  const m = String((err && err.message) || '');
  if (err && err.code === '42501') return forbidden(m || 'You are not allowed to do that.');
  if (err && err.code === 'P0002') return notFound('That template could not be found.');
  if (err && err.code === '22023') return new ApiError(422, 'VALIDATION_FAILED', m.charAt(0).toUpperCase() + m.slice(1) + '.');
  if (err && err.code === '23505') return new ApiError(409, 'DUPLICATE', 'A WhatsApp template with that name and language already exists.');
  return err;
}

const waConnected = () => !!(config.whatsappApiKey && config.whatsappPhoneId);

/** The form values an administrator edits, from a stored row. */
function formOf(t) {
  const wa = t.wa || {};
  const h = wa.header || { type: 'none' };
  return {
    id: t.id, name: t.name, waName: t.wa_name, language: t.wa_language, waStatus: t.wa_status, category: wa.category || 'UTILITY',
    body: t.body, footer: wa.footer || '', headerType: h.type || 'none', headerText: h.text || '', headerParam: h.param && h.param !== '?' ? h.param : '',
    headerMediaUrl: h.mediaUrl || '', buttons: wa.buttons || [], fallbacks: wa.fallbacks || {}, department: t.department,
    usedIn: t.used_in || [], params: (wa.params || []).map((k) => k || ''),
    numbered: (t.body.match(/\{\{\s*\d+\s*\}\}/g) || []).length,
  };
}

/* ------------------------------------------------------------------ *
 * judging every candidate for one template - the preview and the send use THIS, so they cannot disagree
 * ------------------------------------------------------------------ */
async function evaluate(session, tpl, { candidateIds = [], applicationIds = [], jobId = null, includeNoOptIn = false } = {}) {
  const ctx = await loadContext(session, { candidateIds, applicationIds, jobId });
  const wanted = [...new Set([...candidateIds, ...ctx.keys()])];
  const verdicts = await canEngageMany(session, [...ctx.keys()], { jobId: jobId || null });
  const mayBypassOptIn = canOverride(session);

  const items = [];
  for (const id of wanted) {
    const x = ctx.get(id);
    if (!x) { items.push({ candidateId: id, name: '', blocked: [{ kind: 'unreachable', reason: 'not a candidate you can see' }], sendable: false }); continue; }
    const c = x.candidate;
    const phone = normalizePhone(c.phone);
    /* no template chosen yet: the list can still say who can be reached at all */
    const f = tpl ? fill(tpl, valuesFor(x)) : { header: null, body: '', footer: null, buttons: [], missing: [], bodyParams: [] };
    const blocked = [];
    if (!phone.ok) blocked.push({ kind: 'number', reason: phone.reason });
    if (c.do_not_contact) blocked.push({ kind: 'dnc', reason: 'asked not to be contacted' });
    if (c.availability_status === 'placed') blocked.push({ kind: 'placed', reason: 'placed - replacement period' });
    const optedIn = c.whatsapp_opt_in === true;
    if (!optedIn && !(includeNoOptIn && mayBypassOptIn)) {
      blocked.push({ kind: 'optin', reason: 'no WhatsApp opt-in on record', overridable: mayBypassOptIn });
    }
    if (f.missing.length) blocked.push({ kind: 'missing', reason: `no ${f.missing.join(', ')} on file` });
    const v = verdicts.get(id) || { decision: 'allowed' };
    if (v.decision === 'blocked') blocked.push({ kind: 'held', reason: v.message || 'another recruiter holds this candidate' });
    if (v.decision === 'warn') blocked.push({ kind: 'warned', reason: v.message || 'contacted by another recruiter', overridable: true });
    if (c.availability_status === 'not_looking') blocked.push({ kind: 'notlooking', reason: 'said they are not looking', overridable: true });

    items.push({
      candidateId: id, name: c.name, phone: c.phone || '', number: phone.ok ? phone.number : null,
      applicationId: x.applicationId, jobId: x.jobId, jobTitle: x.jobTitle || '', applicationStatus: x.statusLabel || '',
      optIn: optedIn, hold: v.decision, blocked,
      preview: { header: f.header, body: f.body, footer: f.footer, buttons: f.buttons },
      missing: f.missing, sendable: blocked.length === 0,
      _fill: f, _verdict: v,
    });
  }
  return items;
}

const publicItem = (it) => {
  const { _fill, _verdict, ...rest } = it;
  return rest;
};

/** Which "skip by default" reasons the recruiter has ticked past (the same switches the compose box has). */
function applyTicks(items, b, session) {
  for (const it of items) {
    it.blocked = it.blocked.filter((x) => {
      if (x.kind === 'warned' && b.includeWarned) return false;
      if (x.kind === 'notlooking' && b.includeNotLooking) return false;
      if (x.kind === 'optin' && b.includeNoOptIn && canOverride(session)) return false;
      return true;
    });
    it.sendable = it.blocked.length === 0;
  }
}

const idsSchema = {
  candidateIds: z.array(z.string().trim().min(1).max(64)).max(MAX_PEOPLE).optional(),
  applicationIds: z.array(z.string().trim().min(1).max(80)).max(MAX_PEOPLE).optional(),
  jobId: z.string().trim().max(64).optional(),
};

const who = async (session) => {
  if (session.role !== 'recruiter' && session.role !== 'admin') return session.role === 'bde' ? 'BDE' : 'TeamLink';
  return withUser(ENGINE, async (c) => (await c.query(
    `select coalesce((select name from recruiters where id = $1), (select name from admins where id = $1), 'Administrator') as n`,
    [session.profileId])).rows[0].n).catch(() => (session.role === 'admin' ? 'Administrator' : 'Recruiter'));
};

const batchIdFor = (session, key) =>
  'wab_' + crypto.createHash('sha1').update(`${session.userId}|${key}`).digest('hex').slice(0, 24);

/** A batch's rows, as the screen shows them. RLS decides which are visible. */
async function batchState(session, batchId) {
  const rows = await withUser(session, async (c) => (await c.query(
    `select id, candidate_id, candidate_name, to_address, status, error, provider_ref, template_name, recruiter_name, sent_by,
            attempts, queued_at, sent_at, delivered_at, read_at, credits, body, application_id
       from message_logs
      where batch_id = $1 and channel = 'whatsapp' order by candidate_name, id`, [batchId])).rows);
  const by = (s) => rows.filter((r) => r.status === s).length;
  const pending = rows.filter((r) => r.status === 'queued' || r.status === 'sending').length;
  const failed = rows.filter((r) => r.status === 'failed' || r.status === 'not_configured').length;
  return {
    batchId, total: rows.length,
    sent: by('sent'), delivered: by('delivered'), read: rows.filter((r) => r.read_at).length,
    failed, pending, skipped: by('skipped_no_contact'),
    finished: rows.length > 0 && pending === 0,
    templateName: rows[0] ? rows[0].template_name : null,
    recruiter: rows[0] ? rows[0].recruiter_name : null,
    rows: rows.map((r) => ({
      id: Number(r.id), candidateId: r.candidate_id, name: r.candidate_name, to: r.to_address,
      status: r.status === 'not_configured' ? 'failed' : r.status === 'queued' || r.status === 'sending' ? 'pending' : r.status,
      rawStatus: r.status, error: r.error || '', providerRef: r.provider_ref || null, attempts: r.attempts,
      queuedAt: r.queued_at, sentAt: r.sent_at, deliveredAt: r.delivered_at, readAt: r.read_at, credits: r.credits,
      message: r.body, applicationId: r.application_id,
    })),
  };
}

export default function whatsappSendRoutes() {
  const r = Router();

  /* ---------------------------------------------------------------- templates */
  r.get('/whatsapp/templates', requireAuth(), requireRole(...STAFF), wrap(async (req, res) => {
    const admin = req.session.role === 'admin';
    const rows = await listTemplates(req.session, { all: admin && String(req.query.all) === 'true' });
    const shaped = rows.map(shapeTemplate).filter((t) => (admin && String(req.query.all) === 'true') || t.sendable);
    res.json({
      templates: shaped, variables: WA_VARIABLES,
      canManage: admin, connected: waConnected(),
    });
  }));

  r.get('/whatsapp/templates/:id', requireAuth(), requireRole(...STAFF), wrap(async (req, res) => {
    const t = await loadTemplate(req.session, req.params.id);
    if (!t) throw notFound('That template could not be found.');
    const s = shapeTemplate(t);
    if (req.session.role !== 'admin' && !s.sendable) throw notFound('That template could not be found.');
    res.json({ template: s, ...(req.session.role === 'admin' ? { form: formOf(t) } : {}) });
  }));

  const upsert = async (req, res, id) => {
    const input = req.body || {};
    const t = cleanTemplate(input);
    const actor = await who(req.session);
    const row = await withUser(req.session, async (c) => (await c.query(
      `select * from comm_template_wa_upsert($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id || newId('tpl'), t.waName, t.language, t.name, t.body, JSON.stringify(t.wa), t.waStatus, t.department, t.usedIn || ['WhatsApp messages'],
       'portal', actor])).rows[0]).catch((e) => { throw dbError(e); });
    res.status(id ? 200 : 201).json({ template: shapeTemplate(row), form: formOf(row) });
  };
  r.post('/whatsapp/templates', requireAuth(), requireRole('admin'), wrap((req, res) => upsert(req, res, null)));
  r.put('/whatsapp/templates/:id', requireAuth(), requireRole('admin'), wrap(async (req, res) => {
    const existing = await loadTemplate(req.session, req.params.id);
    if (!existing) throw notFound('That template could not be found.');
    return upsert(req, res, req.params.id);
  }));

  r.post('/whatsapp/templates/sync', requireAuth(), requireRole('admin'), wrap(async (req, res) => {
    const stats = await syncFromMeta(req.session, await who(req.session));
    console.log(`[whatsapp] template sync: ${JSON.stringify(stats)}`);
    res.json({ sync: stats });
  }));

  /* ---------------------------------------------------------------- preview */
  const previewSchema = z.object({
    templateId: z.string().trim().min(1).max(80),
    ...idsSchema,
    includeNoOptIn: z.boolean().optional(),
    includeWarned: z.boolean().optional(),
    includeNotLooking: z.boolean().optional(),
  });

  r.post('/whatsapp/preview', requireAuth(), requireRole(...STAFF), wrap(async (req, res) => {
    const b = parse(previewSchema, req.body);
    if (!(b.candidateIds || []).length && !(b.applicationIds || []).length) throw badRequest('Choose at least one candidate.');
    const tpl = await loadTemplate(req.session, b.templateId);
    if (!tpl) throw notFound('That template could not be found.');
    const why = unsendable(tpl);
    const items = await evaluate(req.session, tpl, { candidateIds: b.candidateIds || [], applicationIds: b.applicationIds || [], jobId: b.jobId || null, includeNoOptIn: b.includeNoOptIn });
    applyTicks(items, b, req.session);
    const send = items.filter((i) => i.sendable).length;
    res.json({
      template: shapeTemplate(tpl),
      templateSendable: why.length === 0, notSendableBecause: why,
      candidates: items.map(publicItem),
      counts: { selected: items.length, ready: send, blocked: items.length - send },
      canBypassOptIn: canOverride(req.session),
    });
  }));

  /* who these people are and whether a WhatsApp message can reach them, before any template is chosen */
  r.post('/whatsapp/recipients', requireAuth(), requireRole(...STAFF), wrap(async (req, res) => {
    const b = parse(z.object({ ...idsSchema, includeNoOptIn: z.boolean().optional() }), req.body);
    if (!(b.candidateIds || []).length && !(b.applicationIds || []).length) return res.json({ candidates: [], canBypassOptIn: canOverride(req.session) });
    const items = await evaluate(req.session, null, { candidateIds: b.candidateIds || [], applicationIds: b.applicationIds || [], jobId: b.jobId || null });
    res.json({ candidates: items.map(publicItem), canBypassOptIn: canOverride(req.session) });
  }));

  /* ---------------------------------------------------------------- send */
  const sendSchema = previewSchema.extend({
    sendKey: z.string().trim().min(8).max(80),
    override: z.boolean().optional(),
    overrideReason: z.string().trim().max(500).optional(),
  });

  r.post('/whatsapp/send', requireAuth(), requireRole(...STAFF), wrap(async (req, res) => {
    const b = parse(sendSchema, req.body);
    if (!(b.candidateIds || []).length && !(b.applicationIds || []).length) throw badRequest('Choose at least one candidate.');
    if (b.override && !canOverride(req.session)) throw forbidden('Only an administrator or a team lead may override the contact cooldown.');
    if (b.override && String(b.overrideReason || '').trim().length < 5) {
      throw badRequest('A reason is required to override the cooldown.', { overrideReason: 'Say why these candidates are being contacted again.' });
    }
    if (b.includeNoOptIn && !canOverride(req.session)) throw forbidden('Only an administrator or a team lead may message candidates with no WhatsApp opt-in on record.');

    const batchId = batchIdFor(req.session, b.sendKey);

    /* The same click, or the same request retried by the network: the batch is already there, so say how it is going. */
    const again = await batchState(req.session, batchId);
    if (again.total > 0) return res.status(200).json({ ...again, duplicate: true, note: 'This send was already submitted; nothing was queued twice.' });

    const tpl = await loadTemplate(req.session, b.templateId);
    if (!tpl) throw notFound('That template could not be found.');
    const why = unsendable(tpl);
    if (why.length) throw new ApiError(409, 'TEMPLATE_NOT_SENDABLE', `This template cannot be sent: ${why.join('; ')}.`, { reasons: why });

    const items = await evaluate(req.session, tpl, { candidateIds: b.candidateIds || [], applicationIds: b.applicationIds || [], jobId: b.jobId || null, includeNoOptIn: b.includeNoOptIn });
    applyTicks(items, b, req.session);
    if (items.length > MAX_PEOPLE) throw badRequest(`At most ${MAX_PEOPLE} candidates in one send.`);

    const actor = await who(req.session);
    const queued = [], skipped = [], cooldown = [];
    for (const it of items) {
      if (!it.sendable) { skipped.push({ id: it.candidateId, name: it.name, reasons: it.blocked.map((x) => x.reason), kinds: it.blocked.map((x) => x.kind) }); continue; }

      let began;
      try {
        began = await beginContact(req.session, {
          candidateId: it.candidateId, channel: 'whatsapp', jobId: it.jobId || null, source: 'whatsapp_template',
          override: b.override === true, reason: b.overrideReason || null,
        });
      } catch (err) {
        if (err instanceof ApiError && err.code === 'CONTACT_COOLDOWN') {
          const hd = err.details && err.details.holder;
          cooldown.push({ id: it.candidateId, name: it.name, heldBy: hd && hd.name, contactedAt: hd && hd.contactedAt });
          skipped.push({ id: it.candidateId, name: it.name, reasons: [`already contacted${hd && hd.name ? ` by ${hd.name}` : ''}`], kinds: ['cooldown'] });
          continue;
        }
        throw err;
      }

      /* the message exactly as previewed, and exactly the parameters that go to WhatsApp, in Meta's order */
      const payload = buildPayload(tpl, it._fill);
      const text = [it._fill.header && it._fill.header.text, it._fill.body, it._fill.footer].filter(Boolean).join('\n\n');
      const row = await withUser(ENGINE, async (c) => (await c.query(
        `select * from message_log_queue_wa($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [batchId, it.candidateId, it.name, it.number, tpl.id, tpl.name, text, JSON.stringify(payload), it.applicationId || null,
         req.session.userId || null, req.session.role, actor])).rows[0]);
      if (row.status === 'skipped_no_contact') {
        skipped.push({ id: it.candidateId, name: it.name, reasons: ['no mobile number'], kinds: ['number'] });
        await finishContact(req.session, began.id, 'failed');
      } else {
        queued.push({ id: it.candidateId, name: it.name });
        await finishContact(req.session, began.id, 'queued', String(row.id));
        if (it._verdict.decision === 'warn') {
          await audit(req.session, { candidateId: it.candidateId, roleKey: it._verdict.roleKey, jobId: it.jobId || null,
            action: 'contact_anyway', detail: { action: 'whatsapp_template', batchId, holder: it._verdict.holder && it._verdict.holder.name } });
        }
      }
    }

    res.status(202).json({
      batchId, template: { id: tpl.id, name: tpl.name, waName: tpl.wa_name, language: tpl.wa_language },
      queued: queued.length, skipped, cooldownSkipped: cooldown.length,
      note: 'Queued. Each message shows as sent only when WhatsApp confirms it.',
    });
  }));

  /* ---------------------------------------------------------------- progress, retry, history */
  r.get('/whatsapp/batches/:batchId', requireAuth(), requireRole(...STAFF), wrap(async (req, res) => {
    const s = await batchState(req.session, req.params.batchId);
    if (!s.total) throw notFound('That send could not be found.');
    res.json(s);
  }));

  r.post('/whatsapp/batches/:batchId/retry', requireAuth(), requireRole(...STAFF), wrap(async (req, res) => {
    const before = await batchState(req.session, req.params.batchId);
    if (!before.total) throw notFound('That send could not be found.');
    const n = await withUser(req.session, async (c) => (await c.query(`select message_log_retry($1) as n`, [req.params.batchId])).rows[0].n);
    const after = await batchState(req.session, req.params.batchId);
    res.status(202).json({ ...after, retried: n,
      note: n ? `${n} failed message${n === 1 ? '' : 's'} queued again; the ones already sent are untouched.` : 'Nothing to retry: no failed messages in this send.' });
  }));

  r.get('/whatsapp/history', requireAuth(), requireRole(...STAFF), wrap(async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
    const admin = req.session.role === 'admin';
    const mineOnly = !admin || String(req.query.mine) === 'true';
    const batches = await withUser(req.session, async (c) => (await c.query(
      `select batch_id, max(template_name) as template_name, max(recruiter_name) as recruiter_name, min(queued_at) as at,
              count(*)::int as total,
              count(*) filter (where status in ('sent','delivered'))::int as sent,
              count(*) filter (where status = 'delivered')::int as delivered,
              count(*) filter (where read_at is not null)::int as read,
              count(*) filter (where status in ('failed','not_configured'))::int as failed,
              count(*) filter (where status in ('queued','sending'))::int as pending,
              coalesce(sum(credits), 0)::numeric as credits
         from message_logs
        where channel = 'whatsapp' and wa_payload is not null ${mineOnly ? 'and sent_by = $2' : ''}
        group by batch_id order by min(queued_at) desc limit $1`,
      mineOnly ? [limit, req.session.userId] : [limit])).rows);
    let byRecruiter = null;
    if (admin) {
      byRecruiter = (await withUser(req.session, async (c) => (await c.query(
        `select coalesce(recruiter_name, 'Unknown') as recruiter, count(*)::int as messages,
                count(*) filter (where status in ('sent','delivered'))::int as sent,
                count(*) filter (where status = 'delivered')::int as delivered,
                count(*) filter (where status in ('failed','not_configured'))::int as failed
           from message_logs where channel = 'whatsapp' and wa_payload is not null
          group by 1 order by 2 desc limit 100`)).rows));
    }
    res.json({
      batches: batches.map((x) => ({ batchId: x.batch_id, templateName: x.template_name, recruiter: x.recruiter_name, at: x.at,
        total: x.total, sent: x.sent, delivered: x.delivered, read: x.read, failed: x.failed, pending: x.pending, credits: Number(x.credits) || null })),
      ...(byRecruiter ? { byRecruiter } : {}),
    });
  }));

  return r;
}

