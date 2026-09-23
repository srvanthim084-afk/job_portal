/**
 * Email intake: the recruiter's side.
 *
 * Connect a mailbox, sync it, see what arrived, map the ones the system
 * would not guess at, and resend a registration message that failed.
 *
 * No endpoint here ever returns a password, an IMAP credential or an
 * OAuth token - the temporary password exists for the length of one
 * function call and goes out in the candidate's email. The recruiter's
 * view shows whether it was sent, not what it was.
 */
import { Router } from 'express';
import { z } from 'zod';
import { withUser } from '../db.js';
import { wrap, badRequest, notFound, ApiError } from '../errors.js';
import { requireAuth, requireRole } from '../auth.js';
import { syncMailbox, syncAll, mapMessage, temporaryPassword } from '../intake/process.js';
import { mailboxReadiness, SAMPLE_EMAILS } from '../intake/mailbox.js';
import { hashPassword } from '../auth.js';
import { providers } from '../notify/providers.js';
import { buildEventMessages } from '../notify/templates.js';
import { config } from '../config.js';

const newId = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const ENGINE = { userId: '', role: 'admin', profileId: null };

function parse(schema, body) {
  const out = schema.safeParse(body || {});
  if (!out.success) {
    const details = {};
    for (const i of out.error.issues) details[i.path.join('.') || 'body'] = i.message;
    throw new ApiError(422, 'VALIDATION_FAILED', 'Please check the highlighted fields.', details);
  }
  return out.data;
}

const toMailbox = (r) => {
  const ready = mailboxReadiness(r);
  return {
    id: r.id,
    address: r.address,
    provider: r.provider,
    displayName: r.display_name || undefined,
    recruiterId: r.recruiter_id || undefined,
    recruiterName: r.recruiter_name || undefined,
    status: ready.ready ? r.status : 'disconnected',
    autoSync: r.auto_sync,
    lastSyncAt: r.last_sync_at ? new Date(r.last_sync_at).toISOString() : undefined,
    lastError: r.last_error || undefined,
    // What an administrator must set on the SERVER before this mailbox
    // can be read. Names only - never values.
    missingConfig: ready.missing,
    rules: r.rules || {},
  };
};

const toMessage = (r) => ({
  id: r.id,
  mailboxId: r.mailbox_id,
  from: r.from_address,
  subject: r.subject,
  receivedAt: r.received_at ? new Date(r.received_at).toISOString() : undefined,
  snippet: r.snippet ? String(r.snippet).slice(0, 400) : undefined,
  hasAttachment: r.has_attachment,
  attachmentName: r.attachment_name || undefined,
  status: r.status,
  reason: r.reason || undefined,
  parsed: r.parsed ? (r.parsed.candidate || r.parsed) : undefined,
  candidateId: r.candidate_id || undefined,
  candidateName: r.candidate_name || undefined,
  applicationId: r.application_id || undefined,
  reference: r.reference || undefined,
  processedAt: r.processed_at ? new Date(r.processed_at).toISOString() : undefined,
});

export default function intakeRoutes() {
  const r = Router();

  /* ---- mailboxes --------------------------------------------------- */

  r.get('/intake/mailboxes', requireAuth(), requireRole('recruiter', 'bde', 'admin'),
    wrap(async (req, res) => {
      const rows = await withUser(req.session, async (c) => (await c.query(
        `select b.*, r.name as recruiter_name
           from email_mailboxes b
           left join recruiters r on r.id = b.recruiter_id
          order by b.created_at`)).rows);
      res.json({ mailboxes: rows.map(toMailbox) });
    }));

  /**
   * POST /api/intake/mailboxes — connect one.
   *
   * Takes an address and a provider, never a password: the credential is
   * read from the server's environment, keyed on the address, so nothing
   * secret travels through the browser or lands in the database.
   */
  r.post('/intake/mailboxes', requireAuth(), requireRole('recruiter', 'admin'),
    wrap(async (req, res) => {
      const b = parse(z.object({
        address: z.string().trim().email('That is not a valid email address.').max(160),
        provider: z.enum(['mock', 'imap', 'gmail', 'outlook']).optional().default('mock'),
        displayName: z.string().trim().max(120).optional(),
        autoSync: z.boolean().optional().default(true),
        rules: z.record(z.any()).optional(),
      }), req.body);

      const recruiterId = req.session.role === 'recruiter' ? req.session.profileId : null;
      const id = await withUser(req.session, async (c) => (await c.query(
        `select mailbox_upsert($1,$2,$3,$4,$5,$6,$7::jsonb,'{}'::jsonb) as id`,
        [newId('mbx'), b.address, b.provider, recruiterId, b.displayName || null,
         b.autoSync, JSON.stringify(b.rules || {})])).rows[0].id);

      const row = await withUser(req.session, async (c) => (await c.query(
        `select * from email_mailboxes where id=$1`, [id])).rows[0]);
      res.status(201).json({ mailbox: toMailbox(row) });
    }));

  r.post('/intake/mailboxes/:id/disconnect', requireAuth(), requireRole('recruiter', 'admin'),
    wrap(async (req, res) => {
      await withUser(ENGINE, (c) => c.query(
        `update email_mailboxes set status='disconnected', auto_sync=false, updated_at=now()
          where id=$1`, [req.params.id]));
      res.json({ ok: true });
    }));

  r.patch('/intake/mailboxes/:id', requireAuth(), requireRole('recruiter', 'admin'),
    wrap(async (req, res) => {
      const b = parse(z.object({
        autoSync: z.boolean().optional(),
        rules: z.record(z.any()).optional(),
        displayName: z.string().trim().max(120).optional(),
      }), req.body);

      await withUser(ENGINE, (c) => c.query(
        `update email_mailboxes
            set auto_sync = coalesce($2, auto_sync),
                rules = coalesce($3::jsonb, rules),
                display_name = coalesce($4, display_name),
                updated_at = now()
          where id = $1`,
        [req.params.id, b.autoSync === undefined ? null : b.autoSync,
         b.rules ? JSON.stringify(b.rules) : null, b.displayName || null]));

      const row = await withUser(req.session, async (c) => (await c.query(
        `select * from email_mailboxes where id=$1`, [req.params.id])).rows[0]);
      if (!row) throw notFound('That mailbox is not connected.');
      res.json({ mailbox: toMailbox(row) });
    }));

  /* ---- sync -------------------------------------------------------- */

  /**
   * POST /api/intake/sync — read the mailbox now.
   *
   * Returns what happened to every message, not a count: "3 imported"
   * with no detail is useless when 9 arrived.
   */
  r.post('/intake/sync', requireAuth(), requireRole('recruiter', 'bde', 'admin'),
    wrap(async (req, res) => {
      const b = parse(z.object({
        mailboxId: z.string().trim().max(64).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      }), req.body);

      const out = b.mailboxId
        ? [await syncMailbox(req.session, b.mailboxId, { limit: b.limit })]
        : await syncAll(req.session, { onlyAuto: false });

      res.json({
        synced: out,
        imported: out.reduce((n, x) => n + (x.imported || 0), 0),
        needsMapping: out.reduce((n, x) => n + (x.needsMapping || 0), 0),
        needsReview: out.reduce((n, x) => n + (x.needsReview || 0), 0),
      });
    }));

  /* ---- what arrived ------------------------------------------------ */

  r.get('/intake/messages', requireAuth(), requireRole('recruiter', 'bde', 'admin'),
    wrap(async (req, res) => {
      const { status, mailboxId, limit } = req.query;
      const rows = await withUser(req.session, async (c) => {
        const where = [], vals = [];
        if (status) { vals.push(String(status).split(',')); where.push(`m.status = any($${vals.length})`); }
        if (mailboxId) { vals.push(mailboxId); where.push(`m.mailbox_id = $${vals.length}`); }
        const clause = where.length ? `where ${where.join(' and ')}` : '';
        return (await c.query(
          `select m.*, c.name as candidate_name, a.reference
             from email_messages m
             left join candidates c on c.id = m.candidate_id
             left join applications a on a.id = m.application_id
             ${clause}
            order by m.received_at desc nulls last
            limit ${Math.min(Number(limit) || 100, 500)}`, vals)).rows;
      });
      res.json({ messages: rows.map(toMessage) });
    }));

  /** The queue the spec calls "Unmapped Naukri Applications". */
  r.get('/intake/queue', requireAuth(), requireRole('recruiter', 'bde', 'admin'),
    wrap(async (req, res) => {
      const rows = await withUser(req.session, async (c) => (await c.query(
        `select m.*, c.name as candidate_name
           from email_messages m
           left join candidates c on c.id = m.candidate_id
          where m.status in ('needs_mapping','needs_review','failed')
          order by m.received_at desc nulls last limit 200`)).rows);

      const counts = await withUser(req.session, async (c) => (await c.query(
        `select status, count(*)::int as n from email_messages group by status`)).rows);

      res.json({
        queue: rows.map(toMessage),
        counts: Object.fromEntries(counts.map((x) => [x.status, x.n])),
      });
    }));

  /** POST /api/intake/messages/:id/map — "this one is for that requirement". */
  r.post('/intake/messages/:id/map', requireAuth(), requireRole('recruiter', 'bde', 'admin'),
    wrap(async (req, res) => {
      const b = parse(z.object({ jobId: z.string().trim().min(1).max(64) }), req.body);
      const out = await mapMessage(req.session, {
        messageId: req.params.id,
        jobId: b.jobId,
        actor: req.session.profileId || req.session.role,
      });
      res.json(out);
    }));

  /** POST /api/intake/messages/:id/ignore */
  r.post('/intake/messages/:id/ignore', requireAuth(), requireRole('recruiter', 'bde', 'admin'),
    wrap(async (req, res) => {
      await withUser(ENGINE, (c) => c.query(
        `select email_message_result($1,'ignored',$2,null,null,null)`,
        [req.params.id, 'Marked not an application by a recruiter']));
      res.json({ ok: true });
    }));

  /* ---- the timeline ------------------------------------------------- */

  r.get('/intake/timeline', requireAuth(), wrap(async (req, res) => {
    const { applicationId, candidateId } = req.query;
    if (!applicationId && !candidateId) throw badRequest('An application or a candidate is required.');

    const rows = await withUser(req.session, async (c) => {
      const vals = [];
      const where = [];
      if (applicationId) { vals.push(applicationId); where.push(`application_id = $${vals.length}`); }
      if (candidateId) { vals.push(candidateId); where.push(`candidate_id = $${vals.length}`); }
      return (await c.query(
        `select * from application_events where ${where.join(' or ')}
          order by at asc limit 500`, vals)).rows;
    });

    res.json({
      timeline: rows.map((e) => ({
        id: Number(e.id),
        applicationId: e.application_id || undefined,
        candidateId: e.candidate_id || undefined,
        type: e.type,
        detail: e.detail || undefined,
        actor: e.actor,
        metadata: e.metadata || undefined,
        at: new Date(e.at).toISOString(),
      })),
    });
  }));

  /* ---- resend ------------------------------------------------------- */

  /**
   * POST /api/intake/applications/:id/resend
   *
   * Sends the registration message again. A new temporary password is
   * issued only when the candidate has never signed in - resetting the
   * password of somebody who already chose their own would lock them out
   * of an account they are using.
   */
  r.post('/intake/applications/:id/resend', requireAuth(), requireRole('recruiter', 'bde', 'admin'),
    wrap(async (req, res) => {
      const b = parse(z.object({
        channels: z.array(z.enum(['email', 'sms', 'whatsapp'])).optional(),
      }), req.body);
      const channels = b.channels && b.channels.length ? b.channels : ['email', 'sms', 'whatsapp'];

      const ctx = await withUser(req.session, async (c) => (await c.query(
        `select a.id, a.reference, a.job_id, a.candidate_id,
                c.name, c.email, c.phone, c.user_id,
                j.title as job_title, co.name as company_name,
                u.must_change_password, u.password_set_at
           from applications a
           join candidates c on c.id = a.candidate_id
           join jobs j on j.id = a.job_id
           left join companies co on co.id = j.company_id
           left join users u on u.id = c.user_id
          where a.id = $1`, [req.params.id])).rows[0]);
      if (!ctx) throw notFound('That application could not be found.');

      let credentials = null;
      // A fresh password only for somebody who has never set their own.
      if (ctx.email && ctx.must_change_password) {
        const password = temporaryPassword();
        const hash = await hashPassword(password);
        await withUser(ENGINE, (c) => c.query(
          `update users set password_hash=$2, must_change_password=true, password_set_at=now()
            where id=$1`, [ctx.user_id, hash]));
        credentials = { email: ctx.email, password };
      }

      const messages = buildEventMessages('APPLICATION_IMPORTED', {
        candidateName: ctx.name,
        jobTitle: ctx.job_title,
        company: ctx.company_name || 'TeamLink Consultants',
        jobId: ctx.job_id,
        applicationId: ctx.id,
        reference: ctx.reference,
        portalUrl: `${config.publicOrigin.replace(/\/$/, '')}/#/login/candidate`,
        linkLabel: 'Open the candidate portal',
        loginEmail: ctx.email || null,
        tempPassword: credentials ? credentials.password : null,
        smsLead: `Your application for ${ctx.job_title} is registered. Ref ${ctx.reference}. Log in:`,
      });

      const status = {};
      for (const channel of channels) {
        const to = channel === 'email' ? ctx.email : ctx.phone;
        let result;
        if (!to) result = { status: 'skipped_no_address', provider: channel };
        else {
          try {
            result = await providers[channel].send({
              to,
              subject: messages.email.subject,
              html: messages.email.html,
              text: channel === 'sms' ? messages.sms
                  : channel === 'whatsapp' ? messages.whatsapp : messages.email.text,
            });
          } catch (err) {
            result = { status: 'failed', provider: channel, error: err.message };
          }
        }
        status[channel] = result.status;
        await withUser(ENGINE, (c) => c.query(
          `select record_delivery($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),null)`,
          [ctx.id, ctx.candidate_id, ctx.job_id, channel, result.status, to || null,
           result.provider || null, result.ref || null, result.error || null])).catch(() => {});
      }

      await withUser(ENGINE, (c) => c.query(
        `select app_event($1,$2,'candidate.notified',$3,$4,$5::jsonb)`,
        [ctx.id, ctx.candidate_id,
         `Registration message resent - ${Object.entries(status).map(([k, v]) => `${k}: ${v}`).join(', ')}`,
         req.session.profileId || req.session.role, JSON.stringify(status)]));

      res.json({ sent: status, newPasswordIssued: !!credentials });
    }));

  /** The delivery log for one application - the communication history. */
  r.get('/intake/applications/:id/communications', requireAuth(), wrap(async (req, res) => {
    const rows = await withUser(req.session, async (c) => (await c.query(
      `select * from notification_deliveries where application_id=$1
        order by created_at desc limit 200`, [req.params.id])).rows);
    res.json({
      communications: rows.map((d) => ({
        id: Number(d.id),
        channel: d.channel,
        status: d.status,
        to: d.to_address || undefined,
        provider: d.provider || undefined,
        error: d.error || undefined,
        attempt: d.attempt,
        at: new Date(d.created_at).toISOString(),
      })),
    });
  }));

  /** The sample emails the demo mailbox serves, so the screen can say what they are. */
  r.get('/intake/samples', requireAuth(), requireRole('recruiter', 'bde', 'admin'),
    wrap(async (req, res) => {
      res.json({
        samples: SAMPLE_EMAILS.map((m) => ({
          messageId: m.messageId, from: m.from, subject: m.subject,
          attachmentName: m.attachmentName || undefined,
        })),
      });
    }));

  return r;
}
