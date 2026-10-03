/**
 * One message to one candidate, on the channels asked for, with the same
 * rules every TeamLink message follows:
 *
 *   - do-not-contact and channel opt-outs are respected;
 *   - SMS and WhatsApp are not sent from 21:00 to 08:00 IST (recorded as
 *     skipped_quiet_hours; email still goes) unless the caller says this
 *     message is the exception;
 *   - WhatsApp needs an approved template (Notification Settings ->
 *     WhatsApp template name); without one it is recorded not_configured
 *     and not attempted, because Meta rejects business-initiated messages
 *     without one;
 *   - a provider's own answer is what is recorded. Nothing is reported as
 *     sent that was not.
 *
 * Used by the screening-question links and the interview prep kit. The
 * caller records each result where it keeps its own delivery log.
 */
import { providers } from './providers.js';
import { channelSettings } from './channel-settings.js';

const IST_MS = 330 * 60 * 1000;

/** No SMS or WhatsApp from 21:00 to 08:00 IST. */
export function inQuietHours(now = Date.now()) {
  const h = new Date(now + IST_MS).getUTCHours();
  return h >= 21 || h < 8;
}

/**
 * @param cand      toCandidate() shape (name, email, phone, opt-ins, doNotContact)
 * @param messages  { email:{subject,text,html}, sms, whatsapp }
 * @param opts      { channels, now, ignoreQuietHours, templateId, vars }
 * @returns [{ channel, to, result:{status, provider, ref?, error?} }]
 */
export async function sendToCandidate(cand, messages, opts = {}) {
  const channels = opts.channels || ['email', 'sms', 'whatsapp'];
  const now = opts.now ?? Date.now();
  const quiet = !opts.ignoreQuietHours && inQuietHours(now);
  const waCfg = channels.includes('whatsapp') ? await channelSettings('whatsapp').catch(() => ({})) : {};
  const out = [];
  for (const channel of channels) {
    const to = channel === 'email' ? cand.email : cand.phone;
    let r;
    if (cand.doNotContact) r = { status: 'skipped_opted_out', provider: channel, error: 'do not contact' };
    else if (!to) r = { status: 'skipped_no_address', provider: channel };
    else if (channel === 'email' && cand.emailOptIn === false) r = { status: 'skipped_opted_out', provider: channel };
    else if (channel === 'sms' && cand.smsOptIn === false) r = { status: 'skipped_opted_out', provider: channel };
    else if (channel === 'whatsapp' && !cand.whatsappOptIn) r = { status: 'skipped_opted_out', provider: channel, error: 'not opted in' };
    else if (channel !== 'email' && quiet) r = { status: 'skipped_quiet_hours', provider: channel, error: '21:00-08:00 IST' };
    else if (channel === 'whatsapp' && !(waCfg && waCfg.templateName)) {
      r = { status: 'not_configured', provider: 'whatsapp',
            error: 'no approved WhatsApp template is set in Notification Settings' };
    } else if (!providers[channel]) {
      r = { status: 'not_configured', provider: channel };
    } else {
      try {
        r = await providers[channel].send({
          to,
          subject: messages.email.subject,
          html: messages.email.html,
          text: channel === 'sms' ? messages.sms
            : channel === 'whatsapp' ? messages.whatsapp : messages.email.text,
          templateId: channel === 'email' ? (opts.templateId || undefined) : undefined,
          vars: Object.assign({
            to_name: cand.name, candidate_name: cand.name,
            subject: messages.email.subject, message: messages.email.text,
          }, opts.vars || {}),
        });
      } catch (err) {
        r = { status: 'failed', provider: channel, error: err.message };
      }
    }
    out.push({ channel, to: to || null, result: r });
  }
  return out;
}
