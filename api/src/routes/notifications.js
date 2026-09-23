/**
 * Telling a candidate where they stand, on demand.
 *
 * Everything here already happens by itself — an application sends its
 * confirmation, a stage move sends its update, a failed message is swept
 * up and tried again. These two endpoints exist for the cases automation
 * cannot cover:
 *
 *   send   a recruiter who wants this one person told again, now,
 *          because they rang to say they heard nothing
 *   retry  after a provider outage is fixed, without waiting out the
 *          next quarter-hour sweep
 *
 * Neither invents a message. `send` dispatches the update for the stage
 * the application is ACTUALLY at, and `retry` runs the same queue the
 * background sweep runs. A recruiter cannot compose arbitrary mail to a
 * candidate through here, and no endpoint returns a password.
 */
import { Router } from 'express';
import { z } from 'zod';
import { withUser } from '../db.js';
import { wrap, badRequest, notFound, ApiError } from '../errors.js';
import { requireAuth, requireRole } from '../auth.js';
import { dispatchEvent } from '../notify/events.js';
import { retryFailedDeliveries } from '../notify/retry.js';
import { providers, providerMissing, providerTransport } from '../notify/providers.js';
import { config } from '../config.js';
import { emailLayout } from '../notify/layout.js';

function parse(schema, body) {
  const out = schema.safeParse(body || {});
  if (!out.success) {
    const details = {};
    for (const i of out.error.issues) details[i.path.join('.') || 'body'] = i.message;
    throw new ApiError(422, 'VALIDATION_FAILED', 'Please check the highlighted fields.', details);
  }
  return out.data;
}

/**
 * Which message belongs to an application at this stage.
 *
 * The same table the retry sweep uses, so a message a recruiter sends by
 * hand and one the system sends by itself can never disagree.
 */
export const EVENT_FOR_STAGE = {
  applied: 'AI_INTERVIEW_INVITED',
  ai_screening: 'AI_INTERVIEW_INVITED',
  ai_interview_done: 'AI_INTERVIEW_COMPLETED',
  offer_extended: 'OFFER_EXTENDED',
};

export function notificationRoutes() {
  const r = Router();

  /**
   * POST /api/notifications/applications/:id/send
   *
   * Send this candidate the update for where they stand right now.
   */
  r.post('/notifications/applications/:id/send', requireAuth(),
    requireRole('recruiter', 'bde', 'admin'), wrap(async (req, res) => {
      // One channel, or all of them. A recruiter pressing "WhatsApp" on a
      // row means WhatsApp - sending the same thing by email, SMS and a
      // phone call as well is not what the button said it would do.
      const b = parse(z.object({
        channels: z.array(z.enum(['email', 'sms', 'whatsapp', 'ivr'])).optional(),
      }), req.body);

      const app = await withUser(req.session, async (c) => (await c.query(
        `select a.id, a.candidate_id, a.job_id, a.stage, a.reference,
                c.name, c.email, c.do_not_contact,
                j.title as job_title, s.label as stage_label
           from applications a
           join candidates c on c.id = a.candidate_id
           join jobs j       on j.id = a.job_id
           left join stages s on s.id = a.stage
          where a.id = $1`, [req.params.id])).rows[0]);
      if (!app) throw notFound('That application could not be found.');

      // Somebody who asked not to be contacted is not contacted, however
      // the request arrives.
      if (app.do_not_contact) {
        throw new ApiError(409, 'DO_NOT_CONTACT',
          `${app.name} has asked not to be contacted.`);
      }

      const event = EVENT_FOR_STAGE[app.stage] || 'STAGE_CHANGED';
      const out = await dispatchEvent(req.session, event, {
        applicationId: app.id,
        candidateId: app.candidate_id,
        jobId: app.job_id,
        stage: app.stage,
        stageLabel: app.stage_label || app.stage,
        reference: app.reference,
        channels: b.channels,
      });

      res.json({
        event,
        stage: app.stage,
        stageLabel: app.stage_label || app.stage,
        jobTitle: app.job_title,
        reference: app.reference || undefined,
        // The address is echoed because a recruiter chasing "she got
        // nothing" needs to see WHERE it went, which is usually the
        // answer.
        to: app.email,
        delivery_status: out.delivery_status || {},
      });
    }));

  /**
   * GET /api/notifications/channels
   *
   * Every channel a candidate can hear from us on, whether it can send,
   * what it still needs, and what it has actually done.
   *
   * The screen this feeds used to exist for email only, so "she got no
   * SMS" had no answer anywhere a recruiter could reach - the delivery
   * log said `not_configured`, which reads like a fault rather than a
   * setting nobody has filled in yet.
   *
   * NO SECRET IS RETURNED. `missing` carries environment variable NAMES,
   * never values, and a configured channel returns an empty list.
   */
  r.get('/notifications/channels', requireAuth(),
    requireRole('recruiter', 'bde', 'admin'), wrap(async (req, res) => {
      const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();

      const counts = await withUser(req.session, async (c) => (await c.query(
        `select channel, status, count(*)::int n
           from notification_deliveries
          where created_at >= $1
          group by channel, status`, [since])).rows);

      const byChannel = {};
      for (const row of counts) {
        const c = byChannel[row.channel] || (byChannel[row.channel] = {});
        c[row.status] = row.n;
      }

      res.json({
        since,
        channels: ['email', 'sms', 'whatsapp', 'ivr'].map((name) => {
          const seen = byChannel[name] || {};
          return {
            channel: name,
            configured: providers[name].configured(),
            transport: providerTransport(name),
            missing: providerMissing(name),
            // Thirty days, because "it has never worked" and "it stopped
            // working on Tuesday" are different problems.
            sent: (seen.sent || 0) + (seen.delivered || 0),
            failed: seen.failed || 0,
            notConfigured: seen.not_configured || 0,
            noAddress: seen.skipped_no_address || 0,
          };
        }),
      });
    }));

  /**
   * GET /api/notifications/templates
   *
   * One row per notification event: our stable key, the label, and the
   * EmailJS template id if one has actually been created there.
   *
   * `status` is derived, never stored, so it cannot drift from the id it
   * describes - and an event with no id says `not_connected` rather than
   * showing a plausible-looking placeholder.
   */
  r.get('/notifications/templates', requireAuth(),
    requireRole('recruiter', 'bde', 'admin'), wrap(async (req, res) => {
      const rows = await withUser(req.session, async (c) => (await c.query(
        `select * from notification_templates order by event_key`)).rows);

      res.json({
        // The variables a template may use. Listed by the server so the
        // screen and the sender cannot disagree about what is available.
        variables: [
          'candidate_name', 'candidate_email', 'job_title', 'company_name',
          'application_id', 'interview_date', 'interview_time', 'interview_link',
          'login_email', 'temporary_password', 'ai_score', 'application_stage',
          'joining_date', 'portal_login_url',
        ],
        templates: rows.map((t) => ({
          eventKey: t.event_key,
          label: t.label,
          templateId: t.template_id || null,
          status: t.template_id ? 'connected' : 'not_connected',
          firesOn: t.fires_on || [],
          updatedAt: t.updated_at ? new Date(t.updated_at).toISOString() : undefined,
        })),
      });
    }));

  /**
   * PUT /api/notifications/templates/:eventKey
   *
   * Save the real EmailJS template id. Blank clears it, which is how an
   * event goes back to Not Connected rather than keeping a stale id.
   */
  r.put('/notifications/templates/:eventKey', requireAuth(),
    requireRole('recruiter', 'bde', 'admin'), wrap(async (req, res) => {
      const b = parse(z.object({
        templateId: z.string().trim().max(120).optional().nullable(),
      }), req.body);

      const value = String(b.templateId || '').trim();
      /*
       * The placeholder is the likeliest wrong answer, and it passes a
       * shape check: "template_xxxxxxx" is alphanumeric, so a pattern
       * alone accepted it and the screen said Connected about a template
       * that does not exist. It is refused by name.
       */
      if (value && /^template_x+$/i.test(value)) {
        throw badRequest(
          'That is the example, not your template id. Open the template in '
          + 'EmailJS and copy the id from its page.',
          { templateId: 'Replace the placeholder with the real id.' });
      }
      if (value && !/^template_[A-Za-z0-9_-]{3,}$/.test(value)) {
        throw badRequest(
          'That does not look like an EmailJS template id. They start with '
          + '"template_" — copy it from the template page in EmailJS.',
          { templateId: 'Expected something like template_abc123.' });
      }

      const out = await withUser(req.session, async (c) => (await c.query(
        `select notification_template_set($1,$2,$3) as out`,
        [req.params.eventKey, value, req.session.userId || 'staff'])).rows[0].out);

      res.json(out);
    }));

  /**
   * POST /api/notifications/templates/:eventKey/test
   *
   * Send one message through that event's own template, to a named
   * address, with every variable filled in so the wording can be read
   * rather than guessed at.
   */
  r.post('/notifications/templates/:eventKey/test', requireAuth(),
    requireRole('recruiter', 'bde', 'admin'), wrap(async (req, res) => {
      const b = parse(z.object({
        to: z.string().trim().email('Where should the test go?').max(160),
      }), req.body);

      const t = await withUser(req.session, async (c) => (await c.query(
        `select * from notification_templates where event_key = $1`,
        [req.params.eventKey])).rows[0]);
      if (!t) throw notFound('That notification event does not exist.');

      const { providers } = await import('../notify/providers.js');
      const base = String(config.publicOrigin || '').replace(/\/$/, '');

      const out = await providers.email.send({
        to: b.to,
        subject: `TeamLink test — ${t.label}`,
        // Whichever template this event is configured with. Null falls
        // back to the environment's, which is the honest behaviour when
        // nothing has been configured yet.
        templateId: t.template_id || undefined,
        vars: {
          candidate_name: 'Test Candidate',
          candidate_email: b.to,
          to_name: 'Test Candidate',
          job_title: 'Java Developer',
          company_name: config.emailFromName || 'TeamLink Consultants',
          application_id: 'TL-APP-2026-00000',
          interview_date: '25 Sep 2026',
          interview_time: '11:00 AM IST',
          interview_link: `${base}/#/candidate/interview`,
          login_email: b.to,
          temporary_password: '(not sent in a test)',
          ai_score: '86%',
          application_stage: t.label,
          joining_date: '01 Oct 2026',
          portal_login_url: `${base}/#/login/candidate`,
        },
        text: `This is a test of the "${t.label}" notification, sent from TeamLink.`
          + `

If you are reading this, notification email is working end to end.`,
        // The same shell every real message uses, so the test shows what
        // a candidate will actually receive rather than a bare line of
        // text that says nothing about the design.
        html: emailLayout({
          title: `${t.label} — test message`,
          preheader: `A test of the ${t.label} notification from TeamLink.`,
          greeting: 'Hello,',
          body: `This is a test of the "${t.label}" notification, sent from TeamLink.`
            + `

If you are reading this, notification email is working end to end.`,
          facts: [
            ['Notification', t.label],
            ['Template', t.template_id || 'the default from the server environment'],
            ['Sent to', b.to],
          ],
          cta: { label: 'Open the candidate portal', url: `${base}/#/login/candidate` },
        }),
      });

      res.json({
        eventKey: t.event_key,
        label: t.label,
        templateId: t.template_id || null,
        to: b.to,
        status: out.status,
        provider: out.provider,
        error: out.error || undefined,
      });
    }));

  /**
   * POST /api/notifications/joining-sweep
   *
   * Run the joining reminders now, rather than waiting for the timer.
   *
   * Admin only. It exists for the same reason the retry has one: after
   * a joining date is corrected, waiting six hours to find out whether
   * the reminder goes is not a workable way to check.
   */
  r.post('/notifications/joining-sweep', requireAuth(), requireRole('admin'),
    wrap(async (req, res) => {
      const { sendJoiningReminders } = await import('../notify/joining.js');
      res.json(await sendJoiningReminders());
    }));

  /**
   * POST /api/notifications/profile-nudge
   *
   * Run the profile reminders now. Admin only, and it answers with what
   * it did - including how many were CONSIDERED, which is the number
   * that says whether the rule is too tight or too loose.
   */
  r.post('/notifications/profile-nudge', requireAuth(), requireRole('admin'),
    wrap(async (req, res) => {
      const { sendProfileNudges } = await import('../notify/profile-nudge.js');
      res.json(await sendProfileNudges({ limit: 100 }));
    }));

  /**
   * POST /api/notifications/retry
   *
   * Go back for everyone a provider outage skipped.
   */
  r.post('/notifications/retry', requireAuth(), requireRole('admin'),
    wrap(async (req, res) => {
      const b = parse(z.object({
        channel: z.enum(['email', 'sms', 'whatsapp']).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      }), req.body);
      res.json(await retryFailedDeliveries({
        channel: b.channel || 'email',
        limit: b.limit || 50,
      }));
    }));

  return r;
}
