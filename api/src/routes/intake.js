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
import { SOURCES } from '../intake/source.js';
import { mailboxReadiness, verifyMailbox, SAMPLE_EMAILS } from '../intake/mailbox.js';
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
        /*
         * IMAP by default, NOT mock.
         *
         * The default was `mock`, so connecting a real company address
         * without naming a provider silently attached it to a generator
         * of sample Naukri emails - and the ATS filled with applications
         * from candidates who do not exist, indistinguishable from real
         * ones on the screen. A real address must never quietly become a
         * demo feed.
         */
        provider: z.enum(['mock', 'imap', 'gmail', 'outlook']).optional().default('imap'),
        displayName: z.string().trim().max(120).optional(),
        autoSync: z.boolean().optional().default(true),
        rules: z.record(z.any()).optional(),
      }), req.body);

      // The sample feed exists so the workflow can be exercised before
      // anybody hands over a password. It has no business on a live
      // deployment, where every row it creates is a fake candidate.
      if (b.provider === 'mock' && config.env === 'production') {
        throw badRequest('The sample mailbox is not available here. Connect a real '
          + 'mailbox with provider "imap", "gmail" or "outlook".');
      }

      const recruiterId = req.session.role === 'recruiter' ? req.session.profileId : null;
      const id = await withUser(req.session, async (c) => (await c.query(
        `select mailbox_upsert($1,$2,$3,$4,$5,$6,$7::jsonb,'{}'::jsonb) as id`,
        [newId('mbx'), b.address, b.provider, recruiterId, b.displayName || null,
         b.autoSync, JSON.stringify(b.rules || {})])).rows[0].id);

      const row = await withUser(req.session, async (c) => (await c.query(
        `select * from email_mailboxes where id=$1`, [id])).rows[0]);
      res.status(201).json({ mailbox: toMailbox(row) });
    }));

  /**
   * POST /api/intake/mailboxes/:id/test
   *
   * Open the mailbox for real: connect, LOGIN, SELECT INBOX, close.
   *
   * "Connected" used to mean only that the environment variables were
   * present, so a wrong password or a wrong host still read as connected
   * and the first sign of trouble was an empty queue hours later. This
   * answers the question the screen was already claiming to answer.
   *
   * Nothing is read and nothing is changed; the outcome is written to
   * the mailbox so the list stops disagreeing with reality.
   */
  /**
   * POST /api/intake/mailboxes/:id/rescan
   *
   * Forget what was read, so the next sync reads it again.
   *
   * Every message is recorded by its provider id, which is what stops
   * one email creating the same application twice. It also means an
   * email read by a FAULTY parser is never looked at again: the four
   * Naukri digests that failed while the MIME reader was broken stayed
   * failed after it was fixed, because the sync saw them as already
   * processed.
   *
   * This drops the RECORD of those emails, not the emails themselves -
   * they are still in the mailbox and are read again on the next sync.
   * Candidates and applications already created from them are untouched;
   * the importer finds them again and treats them as duplicates.
   */
  r.post('/intake/mailboxes/:id/rescan', requireAuth(), requireRole('recruiter', 'admin'),
    wrap(async (req, res) => {
      const b = parse(z.object({
        // By default only the ones that never produced anything, because
        // re-reading a successful import is pointless work.
        onlyUnresolved: z.boolean().optional(),
      }), req.body);

      const box = await withUser(req.session, async (c) => (await c.query(
        `select id from email_mailboxes where id=$1`, [req.params.id])).rows[0]);
      if (!box) throw notFound('That mailbox could not be found.');

      const cleared = await withUser(ENGINE, async (c) => (await c.query(
        `delete from email_messages
          where mailbox_id = $1
            and ($2::boolean is not true
                 or status in ('needs_review','failed','ignored','new'))
          returning id`, [req.params.id, b.onlyUnresolved !== false])).rowCount);

      res.json({ cleared, note: 'The next sync will read these emails again.' });
    }));

  r.post('/intake/mailboxes/:id/test', requireAuth(), requireRole('recruiter', 'bde', 'admin'),
    wrap(async (req, res) => {
      const box = await withUser(req.session, async (c) => (await c.query(
        `select * from email_mailboxes where id=$1`, [req.params.id])).rows[0]);
      if (!box) throw notFound('That mailbox could not be found.');

      const out = await verifyMailbox(box);

      await withUser(ENGINE, (c) => c.query(
        `update email_mailboxes
            set status = $2, last_error = $3, updated_at = now()
          where id = $1`,
        [box.id, out.ok ? 'connected' : 'disconnected', out.ok ? null : out.error]));

      res.json({
        ok: out.ok,
        // The server's own words. "Authentication failed" and "host not
        // found" are different problems and deserve different fixes.
        detail: out.detail || undefined,
        error: out.error || undefined,
      });
    }));

  r.post('/intake/mailboxes/:id/disconnect', requireAuth(), requireRole('recruiter', 'admin'),
    wrap(async (req, res) => {
      await withUser(ENGINE, (c) => c.query(
        `update email_mailboxes set status='disconnected', auto_sync=false, updated_at=now()
          where id=$1`, [req.params.id]));
      res.json({ ok: true });
    }));

  /**
   * DELETE /api/intake/mailboxes/:id
   *
   * Remove a mailbox and everything it brought in.
   *
   * Disconnecting only stops future syncs; it leaves every message the
   * mailbox ever produced in the queue. For a sample mailbox that is
   * exactly the wrong outcome - the demo applications stay, and a
   * recruiter cannot tell them from real ones.
   *
   * The email_messages rows go with it (on delete cascade). Candidates
   * and applications already created from them are NOT touched here:
   * deleting somebody's application because a mailbox was removed would
   * be a far worse surprise. `?purge=1` says what would go instead, and
   * tools/intake-cleanup.mjs does the removal deliberately.
   */
  r.delete('/intake/mailboxes/:id', requireAuth(), requireRole('recruiter', 'admin'),
    wrap(async (req, res) => {
      const out = await withUser(ENGINE, async (c) => {
        const box = (await c.query(
          `select * from email_mailboxes where id=$1`, [req.params.id])).rows[0];
        if (!box) return null;
        const n = (await c.query(
          `select count(*)::int n from email_messages where mailbox_id=$1`,
          [req.params.id])).rows[0].n;
        await c.query(`delete from email_mailboxes where id=$1`, [req.params.id]);
        return { address: box.address, provider: box.provider, messages: n };
      });
      if (!out) throw notFound('That mailbox could not be found.');
      res.json({ removed: out });
    }));

  /**
   * POST /api/intake/cleanup
   *
   * Take the sample mailboxes, and everything they invented, back out.
   *
   * The `mock` provider serves a fixed set of sample Naukri emails so
   * the workflow can be exercised before anybody hands over a password.
   * Everything downstream of it is real - that is the point, and also
   * the problem: a deployment that has run it holds applications from
   * candidates who do not exist, and nothing on the screen says which is
   * which.
   *
   * ADMIN ONLY, and it does nothing at all without `confirm: true`. The
   * same counts come back either way, so the decision is made on the
   * numbers rather than after them.
   *
   * A candidate is removed only when EVERY application they have came
   * from a sample mailbox. Somebody who arrived through the demo and has
   * since applied for a real role keeps their profile and their real
   * applications.
   */
  r.post('/intake/cleanup', requireAuth(), requireRole('admin'),
    wrap(async (req, res) => {
      const b = parse(z.object({ confirm: z.boolean().optional() }), req.body);

      /*
       * Through a definer function, not a query.
       *
       * Removing these needs DELETE on `candidates`, which app_api
       * deliberately does not have - the API must not be able to delete
       * people. intake_cleanup_mock() checks for an admin itself, so the
       * grant that exists for a good reason stays as it is.
       */
      const out = await withUser(req.session, async (c) => (await c.query(
        `select intake_cleanup_mock($1) as out`, [!!b.confirm])).rows[0].out);

      res.json(out);
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
        // Which job board to process. `all` is both, and the default,
        // because a recruiter pressing Sync means "get my candidates".
        board: z.enum(['all', 'naukri', 'shine']).optional(),
      }), req.body);

      const board = b.board || 'all';
      const out = b.mailboxId
        ? [await syncMailbox(req.session, b.mailboxId, { limit: b.limit, board })]
        : await syncAll(req.session, { onlyAuto: false, board });

      /*
       * What happened, counted per outcome.
       *
       * "Read" and "imported" are different numbers and were reported as
       * one: a sync that read forty emails and imported none looked
       * identical to one that read none at all.
       */
      const tally = (pick) => out.reduce((n, x) => n + (pick(x) || 0), 0);
      const results = out.flatMap((x) => x.results || []);
      const countStatus = (st) => results.filter((r) => r.status === st).length;

      /*
       * Which boards this reader has actually been proven against.
       *
       * Naukri's shapes were built from real emails out of a live
       * mailbox. Shine's were written from its documented format and no
       * Shine message has ever been seen, so a recruiter pressing Sync
       * Shine and getting nothing has two possible explanations - Shine
       * sent nothing, or the reader does not recognise what Shine sends
       * - and no way to tell them apart. Saying so is the difference
       * between a quiet afternoon and a silent failure.
       *
       * `unverified` is a NOTE, not a warning to dismiss: the path runs,
       * the parsing is the same labelled-block reader Naukri's
       * per-candidate mails already use, and the first real Shine email
       * either confirms it or says exactly what to change.
       */
      const boards = Object.values(SOURCES)
        .filter((src) => board === 'all' || src.id === board)
        .map((src) => ({ id: src.id, label: src.label, verified: src.verified }));
      const unverified = boards.filter((x) => !x.verified).map((x) => x.label);

      res.json({
        board,
        boards,
        note: unverified.length && !results.some((r) => unverified
          .some((l) => r.source === l.toLowerCase()))
          ? `No ${unverified.join(' or ')} email has been read here yet, so that `
            + 'format has not been confirmed against a real message. Forward one '
            + 'to this mailbox if a response is missing.'
          : undefined,
        synced: out,
        emailsRead: tally((x) => x.seen),
        naukri: results.filter((r) => r.source === 'naukri').length,
        shine: results.filter((r) => r.source === 'shine').length,
        imported: tally((x) => x.imported),
        updated: countStatus('updated'),
        duplicates: countStatus('duplicate') + countStatus('already_processed'),
        needsMapping: tally((x) => x.needsMapping),
        needsReview: tally((x) => x.needsReview),
        notAnApplication: countStatus('ignored'),
        skipped: countStatus('skipped'),
        errors: countStatus('failed'),
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
              vars: {
                to_name: ctx.name,
                candidate_name: ctx.name,
                job_title: ctx.job_title,
                company_name: ctx.company_name || '',
                application_id: ctx.reference,
                portal_link: `${config.publicOrigin.replace(/\/$/, '')}/#/login/candidate`,
              },
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
