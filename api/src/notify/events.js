/**
 * Every other moment a candidate should hear from us.
 *
 * dispatch.js handles one event — the interview invitation sent when an
 * application is confirmed — and it was the ONLY thing that ever reached
 * email, SMS or WhatsApp. A stage move, a scheduled interview, a completed
 * AI interview, a score, an offer: all of those created an in-app
 * notification and stopped there, so a candidate who never opened the
 * portal again heard nothing after the first message.
 *
 * This sends the rest, through the same providers, with the same
 * per-channel delivery recording, and the same rule: a channel that is not
 * configured records `not_configured` rather than claiming it sent.
 *
 * Failures never propagate. A stage move is a database fact; whether an
 * SMS gateway answered has no business rolling it back.
 */
import { config } from '../config.js';
import { withUser } from '../db.js';
import { providers } from './providers.js';
import { buildEventMessages } from './templates.js';

/** Which channels an event goes to. In-app always happens elsewhere. */
const CHANNELS = ['email', 'sms', 'whatsapp', 'ivr'];

/**
 * @param session   the acting user's session (RLS applies to the reads)
 * @param event     STAGE_CHANGED | INTERVIEW_SCHEDULED | AI_INTERVIEW_COMPLETED
 *                  | AI_SCORE_AVAILABLE | OFFER_EXTENDED
 * @param ctx       { applicationId, candidateId, jobId, ...event detail }
 * @returns { event, delivery_status } — never throws
 */
export async function dispatchEvent(session, event, ctx) {
  try {
    return await send(session, event, ctx);
  } catch (err) {
    console.error(`[notify] ${event} dispatch failed:`, err.message);
    return { event, error: 'dispatch_failed', delivery_status: {} };
  }
}

async function send(session, event, ctx) {
  const meta = await withUser(session, async (c) => {
    const { rows } = await c.query(
      `select cand.id as candidate_id, cand.name, cand.email, cand.phone,
              cand.whatsapp_opt_in,
              a.id as application_id, a.applied_at, a.stage,
              j.id as job_id, j.title as job_title,
              co.name as company_name
         from applications a
         join candidates cand on cand.id = a.candidate_id
         join jobs j          on j.id    = a.job_id
         left join companies co on co.id = j.company_id
        where a.id = $1`, [ctx.applicationId]);
    return rows[0];
  });

  if (!meta) throw new Error(`application ${ctx.applicationId} not found`);

  const portalUrl = `${config.publicOrigin.replace(/\/$/, '')}/#/candidate/applications`;
  const messages = buildEventMessages(event, {
    candidateName: meta.name,
    jobTitle: meta.job_title,
    company: meta.company_name || 'the company',
    jobId: meta.job_id,
    applicationId: meta.application_id,
    appliedAt: meta.applied_at,
    portalUrl,
    ...ctx,
  });

  if (!messages) return { event, delivery_status: {}, skipped: 'no template' };

  const attempts = await Promise.all(CHANNELS.map(async (channel) => {
    const to = channel === 'email' ? meta.email : meta.phone;
    const provider = providers[channel];
    let result;
    try {
      result = await provider.send({
        to,
        subject: messages.email.subject,
        html: messages.email.html,
        // A call gets the spoken line; the others get their own form.
        text: channel === 'sms' ? messages.sms
            : channel === 'whatsapp' ? messages.whatsapp
            : channel === 'ivr' ? messages.ivr
            : messages.email.text,
      });
    } catch (err) {
      result = { status: 'failed', provider: channel, error: err.message };
    }
    return { channel, result, to };
  }));

  // The same audit trail the invitation writes, so "what did we send this
  // person, and did it arrive" has one answer across every event.
  await withUser(session, async (c) => {
    for (const a of attempts) {
      await c.query(
        `select record_delivery($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [meta.application_id, meta.candidate_id, meta.job_id, a.channel,
         a.result.status, a.to || null, a.result.provider || null,
         a.result.ref || null, a.result.error || null, meta.applied_at, null]);
    }
  }).catch((err) => {
    console.error('[notify] could not record delivery outcomes:', err.message);
  });

  const delivery_status = {};
  for (const a of attempts) delivery_status[a.channel] = a.result.status;

  return {
    event,
    candidate_id: meta.candidate_id,
    application_id: meta.application_id,
    job_id: meta.job_id,
    channels_attempted: CHANNELS,
    delivery_status,
  };
}
