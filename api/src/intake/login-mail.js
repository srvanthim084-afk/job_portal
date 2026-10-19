/**
 * The registration message for ONE imported application: the candidate's portal login and the AI interview invitation.
 *
 * Used by the recruiter's "Resend" button and by the administrator's "send to everyone still waiting". A temporary password is
 * issued ONLY to a candidate account that has never been signed in to (must_change_password) - resetting the password of somebody
 * who chose their own would lock them out of an account they use - and NEVER to anyone who is not a candidate (staff logins are
 * never touched here). Whatever happens, the password is returned to nobody.
 */
import { withUser } from '../db.js';
import { config } from '../config.js';
import { hashPassword } from '../auth.js';
import { providers } from '../notify/providers.js';
import { buildEventMessages } from '../notify/templates.js';
import { temporaryPassword } from './process.js';
import { interviewInfoFor } from './interview-info.js';

const ENGINE = { userId: '', role: 'admin', profileId: null };

/**
 * @param applicationId
 * @param {object} opts  channels (default email, sms, whatsapp), actor (who is recorded as sending it)
 * @returns {Promise<{sent: object, newPasswordIssued: boolean, notFound?: boolean}>}
 */
export async function sendRegistrationMessage(applicationId, opts = {}) {
  const channels = opts.channels && opts.channels.length ? opts.channels : ['email', 'sms', 'whatsapp'];
  const ctx = await withUser(ENGINE, async (c) => (await c.query(
    `select a.id, a.reference, a.job_id, a.candidate_id,
            c.name, c.email, c.phone, c.user_id, c.do_not_contact,
            j.title as job_title, co.name as company_name,
            u.must_change_password, u.role as user_role
       from applications a
       join candidates c on c.id = a.candidate_id
       join jobs j on j.id = a.job_id
       left join companies co on co.id = j.company_id
       left join users u on u.id = c.user_id
      where a.id = $1`, [applicationId])).rows[0]);
  if (!ctx) return { sent: {}, newPasswordIssued: false, notFound: true };
  if (ctx.do_not_contact) return { sent: {}, newPasswordIssued: false, skipped: 'do not contact' };

  let credentials = null;
  /* a fresh password only for a CANDIDATE account nobody has signed in to yet */
  if (ctx.email && ctx.user_id && ctx.must_change_password && ctx.user_role === 'candidate') {
    const password = temporaryPassword();
    const hash = await hashPassword(password);
    /* through the definer function: a direct UPDATE matches no policy on `users` and changes nothing (see 0070) */
    const stored = await withUser(ENGINE, async (c) => (await c.query(
      `select auth_set_password($1,$2,true,null) as ok`, [ctx.user_id, hash])).rows[0]);
    if (stored && stored.ok === true) credentials = { email: ctx.email, password };
    else console.error('[intake] the temporary password was not stored for user', ctx.user_id);
  }

  const base = String(config.publicOrigin || '').replace(/\/$/, '');
  const portalUrl = `${base}/#/login/candidate`;
  const ai = await interviewInfoFor(ctx.id);
  const messages = buildEventMessages('APPLICATION_IMPORTED', {
    candidateName: ctx.name,
    jobTitle: ctx.job_title,
    company: ctx.company_name || 'TeamLink Consultants',
    jobId: ctx.job_id,
    applicationId: ctx.id,
    reference: ctx.reference,
    portalUrl,
    linkLabel: 'Open the candidate portal',
    loginEmail: ctx.email || null,
    tempPassword: credentials ? credentials.password : null,
    ...ai,
    smsLead: ai.aiInterview
      ? `Your application for ${ctx.job_title} is registered (Ref ${ctx.reference}). Your AI interview login is in your email:`
      : `Your application for ${ctx.job_title} is registered. Ref ${ctx.reference}. Log in:`,
  });

  const sent = {};
  for (const channel of channels) {
    const to = channel === 'email' ? ctx.email : ctx.phone;
    let result;
    if (!to) result = { status: 'skipped_no_address', provider: channel };
    else {
      try {
        result = await providers[channel].send({
          to,
          vars: {
            to_name: ctx.name, candidate_name: ctx.name, job_title: ctx.job_title, company_name: ctx.company_name || '',
            application_id: ctx.reference, portal_link: portalUrl,
          },
          subject: messages.email.subject,
          html: messages.email.html,
          text: channel === 'sms' ? messages.sms : channel === 'whatsapp' ? messages.whatsapp : messages.email.text,
        });
      } catch (err) {
        result = { status: 'failed', provider: channel, error: err.message };
      }
    }
    sent[channel] = result.status;
    await withUser(ENGINE, (c) => c.query(
      `select record_delivery($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),null)`,
      [ctx.id, ctx.candidate_id, ctx.job_id, channel, result.status, to || null,
       result.provider || null, result.ref || null, result.error || null])).catch(() => {});
  }

  if ((sent.email === 'sent' || sent.email === 'delivered') && ai.aiInterview) {
    await withUser(ENGINE, (c) => c.query(`select ai_interview_reminder_sent($1,'invited')`, [ctx.id])).catch(() => {});
  }
  await withUser(ENGINE, (c) => c.query(
    `select app_event($1,$2,'candidate.notified',$3,$4,$5::jsonb)`,
    [ctx.id, ctx.candidate_id,
     `Registration message ${opts.bulk ? 'sent (to everyone still waiting)' : 'resent'} - ${Object.entries(sent).map(([k, v]) => `${k}: ${v}`).join(', ')}`,
     opts.actor || 'system', JSON.stringify(sent)])).catch(() => {});

  return { sent, newPasswordIssued: !!credentials };
}
