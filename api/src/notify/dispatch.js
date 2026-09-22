/**
 * Multi-channel interview notification dispatch.
 *
 * Fires once, when an application is confirmed. Every applicable channel
 * is attempted INDEPENDENTLY and in parallel: one failing provider must
 * not stop the others, which is the difference between a candidate who
 * misses an SMS and a candidate who hears nothing at all.
 *
 * Every channel quotes the SAME job id, application timestamp and expiry —
 * they come from one `issue_interview_invite()` call before any message is
 * composed, not from each provider reading the clock.
 */
import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { withUser } from '../db.js';
import { providers } from './providers.js';
import { buildMessages } from './templates.js';

const INVITE_HOURS = 48;   // "expiry (2 days from application)"

/**
 * @returns the per-application record the specification defines.
 */
export async function dispatchInterviewNotifications(session, {
  applicationId, candidateId, jobId,
}) {
  // ---- 1. one invite, one expiry, shared by every channel --------------
  const ctx = await withUser(session, async (c) => {
    const token = randomBytes(24).toString('base64url');
    const inv = await c.query(
      `select * from issue_interview_invite($1, $2, $3)`,
      [applicationId, token, INVITE_HOURS]);

    const row = inv.rows[0];

    const meta = await c.query(
      `select cand.name, cand.email, cand.phone,
              cand.email_verified, cand.mobile_verified, cand.whatsapp_opt_in,
              j.title as job_title, co.name as company_name,
              a.source
         from applications a
         join candidates cand on cand.id = a.candidate_id
         join jobs j          on j.id    = a.job_id
         left join companies co on co.id = j.company_id
        where a.id = $1`, [applicationId]);

    return { invite: row, meta: meta.rows[0] };
  });

  if (!ctx.meta) {
    throw new Error(`application ${applicationId} not found`);
  }

  const { invite, meta } = ctx;
  const source = (meta.source || 'website').toLowerCase();
  const expiry = invite.expires_at;
  const appliedAt = invite.applied_at;

  const interviewUrl =
    `${config.publicOrigin.replace(/\/$/, '')}/#/interview/${invite.token}`;

  const messages = buildMessages({
    candidateName: meta.name,
    jobTitle: meta.job_title,
    company: meta.company_name || 'the company',
    jobId,
    interviewUrl,
    expiry,
    appliedAt,
  });

  // ---- 2. decide which channels apply ---------------------------------
  //
  // Naukri only when the application actually came from Naukri — pushing a
  // status update to a platform the candidate never used is noise at best.
  const plan = [
    { channel: 'naukri',   applicable: source === 'naukri' },
    { channel: 'sms',      applicable: true },
    { channel: 'whatsapp', applicable: true },
    // An automated call as well, so a candidate who reads nothing still
    // hears that their application landed.
    { channel: 'ivr',      applicable: true },
    { channel: 'email',    applicable: true },
  ];

  // ---- 3. attempt every applicable channel, independently -------------
  const attempts = await Promise.all(plan.map(async (p) => {
    if (!p.applicable) {
      return { channel: p.channel, result: { status: 'not_applicable', provider: null },
               to: null };
    }
    const provider = providers[p.channel];
    const to = p.channel === 'email' ? meta.email
             : p.channel === 'naukri' ? null
             : meta.phone;

    let result;
    try {
      result = await provider.send({
        to,
        subject: messages.email.subject,
        html: messages.email.html,
        text: p.channel === 'sms' ? messages.sms
            : p.channel === 'whatsapp' ? messages.whatsapp
            : p.channel === 'ivr' ? (messages.ivr || messages.sms)
            : messages.email.text,
        payload: {
          // The documented Naukri payload. Same identifiers as every other
          // channel, so nothing can disagree.
          event: 'INTERVIEW_INVITE',
          candidate: { name: meta.name, email: meta.email, phone: meta.phone },
          job: { id: jobId, title: meta.job_title, company: meta.company_name },
          application: { id: applicationId, applied_at: appliedAt, source },
          interview: { url: interviewUrl, expires_at: expiry },
          message: messages.naukri,
        },
      });
    } catch (err) {
      // A provider that throws must not take the others down with it.
      result = { status: 'failed', provider: p.channel, error: err.message };
    }
    return { channel: p.channel, result, to };
  }));

  // ---- 4. record every outcome ----------------------------------------
  await withUser(session, async (c) => {
    for (const a of attempts) {
      await c.query(
        `select record_delivery($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [applicationId, candidateId, jobId, a.channel, a.result.status,
         a.to || null, a.result.provider || null, a.result.ref || null,
         a.result.error || null, appliedAt, expiry]);
    }
  }).catch((err) => {
    // Logging the outcome must never fail the application itself.
    console.error('[notify] could not record delivery outcomes:', err.message);
  });

  const deliveryStatus = {};
  for (const a of attempts) deliveryStatus[a.channel] = a.result.status;

  return {
    candidate_id: candidateId,
    job_id: jobId,
    source,
    channels_attempted: attempts
      .filter((a) => a.result.status !== 'not_applicable')
      .map((a) => a.channel),
    delivery_status: deliveryStatus,
    interview_expiry: expiry instanceof Date ? expiry.toISOString() : expiry,
    interview_url: interviewUrl,
  };
}
