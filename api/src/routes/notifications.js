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
import { wrap, notFound, ApiError } from '../errors.js';
import { requireAuth, requireRole } from '../auth.js';
import { dispatchEvent } from '../notify/events.js';
import { retryFailedDeliveries } from '../notify/retry.js';
import { providers, providerMissing, providerTransport } from '../notify/providers.js';

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
