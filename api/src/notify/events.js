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
              -- The deadline the database set when the interview was
              -- invited. Without it the invitation said "due undefined".
              a.ai_interview_due_at,
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
    dueAt: meta.ai_interview_due_at || undefined,
    portalUrl,
    ...ctx,
  });

  if (!messages) return { event, delivery_status: {}, skipped: 'no template' };

  /*
   * Normally every channel. A retry names ONE.
   *
   * The retry sweep goes channel by channel, and without this a pass for
   * SMS would also re-send the email that already arrived - four sweeps,
   * four copies of the same message to somebody whose only problem was
   * that their SMS gateway was down. The queue is per channel, so the
   * send must be too.
   */
  const wanted = Array.isArray(ctx.channels) && ctx.channels.length
    ? CHANNELS.filter((c) => ctx.channels.indexOf(c) >= 0)
    : CHANNELS;

  /*
   * Which EmailJS template this event is configured with.
   *
   * A stage change and an interview invitation used the same template,
   * because the sender only ever knew the one id in the environment.
   * Looked up once per dispatch rather than per channel - only email
   * uses it, and one query is enough.
   *
   * A stage change is looked up by its stage first, so "Shortlisted" and
   * "Rejection" can have their own wording, and falls back to the
   * generic STAGE_CHANGED row.
   */
  let templateId = null;
  try {
    const keys = event === 'STAGE_CHANGED' && meta.stage
      ? [`STAGE_${String(meta.stage).toUpperCase()}`, 'STAGE_CHANGED']
      : [event];
    for (const key of keys) {
      // eslint-disable-next-line no-await-in-loop
      templateId = await withUser(session, async (c) => (await c.query(
        `select notification_template_for($1) as id`, [key])).rows[0].id);
      if (templateId) break;
    }
  } catch (err) {
    // A missing configuration must never stop a candidate being told.
    templateId = null;
  }

  const attempts = await Promise.all(wanted.map(async (channel) => {
    const to = channel === 'email' ? meta.email : meta.phone;
    const provider = providers[channel];
    let result;
    try {
      result = await provider.send({
        to,
        // Only email has templates; the others ignore it.
        templateId: channel === 'email' ? templateId || undefined : undefined,
        // Named variables for a template that greets by name or quotes
        // the role; the composed body is sent regardless.
        vars: {
          to_name: meta.name,
          candidate_name: meta.name,
          job_title: meta.job_title,
          company_name: meta.company_name,
          application_id: ctx.reference || meta.application_id,
          portal_link: portalUrl,
          portal_login_url: `${config.publicOrigin.replace(/\/$/, '')}/#/login/candidate`,
          interview_link: ctx.interviewUrl || portalUrl,
          // The variables a template may use, filled from what this
          // event actually knows. Anything absent is left out by the
          // provider rather than sent as the word "undefined".
          candidate_email: meta.email,
          application_stage: ctx.stageLabel || meta.stage,
          interview_date: ctx.interviewDate,
          interview_time: ctx.interviewTime,
          ai_score: ctx.aiScore != null ? `${ctx.aiScore}%` : undefined,
          joining_date: ctx.joiningDate,
        },
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
        `select record_delivery($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [meta.application_id, meta.candidate_id, meta.job_id, a.channel,
         a.result.status, a.to || null, a.result.provider || null,
         a.result.ref || null, a.result.error || null, meta.applied_at, null,
         // Which message this was, so a retry knows what it is retrying.
         event]);
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
