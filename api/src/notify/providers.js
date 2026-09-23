/**
 * Delivery providers — one per channel.
 *
 * Every provider returns the same shape:
 *
 *   { status, provider, ref?, error? }
 *
 * where status is 'sent' | 'failed' | 'not_configured'.
 *
 * THE RULE THAT MATTERS: a provider never reports 'sent' unless a real
 * external service accepted the message. With no credentials configured
 * the answer is 'not_configured' — not 'sent', and not 'failed' either,
 * because nothing was attempted. Reporting a delivery that did not happen
 * is worse than reporting none: it is the difference between "we could not
 * reach you" and a candidate who is told they were contacted when they
 * were not.
 *
 * Credentials come from the environment (requirement 21). None of these
 * keys can reach the browser — the prototype kept the WhatsApp and SMS
 * keys in localStorage, where any visitor could read them.
 */
import { config } from '../config.js';
import { channelSettings } from './channel-settings.js';

const NOT_CONFIGURED = (provider, hint) => ({
  status: 'not_configured', provider, error: hint,
});

/** Times out rather than holding the whole dispatch open on a dead host. */
async function postJson(url, { headers = {}, body, timeoutMs = 8000 }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* keep the text */ }
    return { ok: res.ok, status: res.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ *
 * Email
 * ------------------------------------------------------------------ */
/**
 * SMTP, lazily.
 *
 * nodemailer is only loaded when SMTP is actually configured, so an
 * installation using the HTTP path (or none at all) does not pay for it.
 * The transport is reused across sends - opening a TLS connection per
 * message is slow and some hosts rate-limit it.
 */
let smtpTransport = null;
async function getSmtp() {
  if (smtpTransport) return smtpTransport;
  const { default: nodemailer } = await import('nodemailer');
  smtpTransport = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    auth: config.smtpUser ? { user: config.smtpUser, pass: config.smtpPass } : undefined,
    // A hung mail server must not hold a request open.
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return smtpTransport;
}

/**
 * SMTP is set up - all four parts of it, not just a host name.
 *
 * `configured()` already required all four; the send path branched on the
 * HOST alone, and the two disagreeing is a real hazard during a
 * switchover: a host written into .env before the password arrives sends
 * every message down the SMTP branch with no credentials, where it fails,
 * while a perfectly working EmailJS is skipped because a host is set.
 * Half a setting is not a preference.
 */
export function smtpReady() {
  return !!(config.emailFrom && config.smtpHost && config.smtpUser && config.smtpPass);
}

/** Exposed so a "send test email" action can prove the settings before use. */
export async function verifySmtp() {
  if (!config.smtpHost) return { ok: false, error: 'EMAIL_SMTP_HOST is not set' };
  try {
    const t = await getSmtp();
    await t.verify();
    return { ok: true, host: config.smtpHost, port: config.smtpPort, secure: config.smtpSecure };
  } catch (err) {
    smtpTransport = null;          // a failed transport must not be cached
    return { ok: false, error: err.message };
  }
}

/**
 * The From header, with a display name when one is configured.
 *
 * Quoted, because a name containing a comma or a full stop is otherwise
 * parsed as a second address and the message is rejected by the server
 * rather than delivered oddly.
 */
function fromHeader() {
  const addr = config.emailFrom;
  if (!config.emailFromName) return addr;
  const name = String(config.emailFromName).replace(/["\\]/g, '');
  return `"${name}" <${addr}>`;
}

/** Is EmailJS set up well enough to send? */
export function emailjsReady() {
  const e = config.emailjs;
  const missing = [];
  if (!e.serviceId) missing.push('EMAILJS_SERVICE_ID');
  if (!e.templateId) missing.push('EMAILJS_TEMPLATE_ID');
  if (!e.publicKey) missing.push('EMAILJS_PUBLIC_KEY');
  return { ready: missing.length === 0, missing };
}

/**
 * Send one message through EmailJS.
 *
 * The template on the EmailJS side owns the layout, so what travels is
 * the CONTENT: who it is for, the subject, and both the HTML and plain
 * bodies. Several common variable names are sent for each value because
 * every EmailJS template names them differently and a template that
 * silently renders an empty email is the worst outcome here.
 */
async function sendViaEmailJS({ to, subject, html, text, vars = {}, templateId }) {
  const e = config.emailjs;
  const body = {
    service_id: e.serviceId,
    /*
     * The template this EVENT is configured with, if one is.
     *
     * Every message used the single EMAILJS_TEMPLATE_ID from the
     * environment, so an interview invitation and a rejection went out
     * through the same template however many were configured. The
     * environment one stays as the fallback, which is what a deployment
     * that has configured nothing should still use.
     */
    template_id: templateId || e.templateId,
    user_id: e.publicKey,
    template_params: {
      to_email: to,
      to_name: to,
      email: to,
      reply_to: config.emailFrom || to,
      from_name: config.emailFromName || 'TeamLink',
      subject,
      title: subject,
      message: text || '',
      message_html: html || '',
      content: text || '',
      // EmailJS's stock templates use {{name}} and {{time}}. Sending them
      // as well means a template left partly as it came still renders -
      // an email with a blank sender name looks like a system fault to
      // the person receiving it.
      name: config.emailFromName || 'TeamLink',
      time: new Date().toLocaleString('en-GB'),

      // Whatever the caller knows about this particular message, so a
      // template can greet somebody by name and quote the role rather
      // than only printing the composed body. Sent last so a caller can
      // override a default above.
      ...Object.fromEntries(
        Object.entries(vars).filter(([, v]) => v !== undefined && v !== null && v !== '')),
    },
  };
  // Only needed when the account has "API calls" in strict mode; sending
  // it when it is not set would fail the request outright.
  if (e.privateKey) body.accessToken = e.privateKey;

  const res = await postJson(e.apiUrl, { body });
  if (!res.ok) {
    // EmailJS answers with plain text, and its messages are precise -
    // "The template ID not found", "API calls are disabled for non-browser
    // applications" - so they are passed through rather than flattened.
    return {
      status: 'failed',
      provider: 'emailjs',
      error: `HTTP ${res.status}: ${String(res.text || '').slice(0, 300)}`,
    };
  }
  return { status: 'sent', provider: 'emailjs', ref: null };
}

export const emailProvider = {
  channel: 'email',
  // Any transport counts as configured. SMTP first, then EmailJS, then a
  // generic HTTP API - a deployment only has to set up one of them.
  configured: () => !!(
    smtpReady()
    || emailjsReady().ready
    || (config.emailFrom && config.emailApiKey)),

  async send({ to, subject, html, text, vars, templateId }) {
    if (!this.configured()) {
      const ejs = emailjsReady();
      return NOT_CONFIGURED('email',
        config.smtpHost
          ? 'EMAIL_SMTP_USER / EMAIL_SMTP_PASS are not set'
          : ejs.missing.length && ejs.missing.length < 3
            ? `EmailJS is partly configured - still missing ${ejs.missing.join(', ')}`
            : 'EMAIL_SMTP_HOST, EMAILJS_* or EMAIL_API_KEY is not set');
    }
    if (!to) return { status: 'failed', provider: 'email', error: 'no email address' };

    // EmailJS before the generic HTTP API, because a deployment that has
    // set it up has said which one it means.
    if (!smtpReady() && emailjsReady().ready) {
      try {
        return await sendViaEmailJS({ to, subject, html, text, vars, templateId });
      } catch (err) {
        return { status: 'failed', provider: 'emailjs', error: err.message };
      }
    }

    if (smtpReady()) {
      try {
        const t = await getSmtp();
        const info = await t.sendMail({
          from: fromHeader(), to, subject, html, text,
        });
        // `accepted` is the server's own list. An empty one means the
        // message was handed over but not accepted for this recipient,
        // which is a failure however encouraging the absence of an error is.
        if (!info.accepted || !info.accepted.length) {
          return { status: 'failed', provider: 'email',
                   error: `the server did not accept ${to}` };
        }
        return { status: 'sent', provider: 'email', ref: info.messageId || null };
      } catch (err) {
        smtpTransport = null;
        return { status: 'failed', provider: 'email', error: err.message };
      }
    }

    try {
      // Resend-compatible; EMAIL_API_URL retargets it at any provider with
      // the same shape without a code change.
      const res = await postJson(config.emailApiUrl, {
        headers: { authorization: `Bearer ${config.emailApiKey}` },
        body: { from: fromHeader(), to: [to], subject, html, text },
      });
      if (!res.ok) {
        return { status: 'failed', provider: 'email',
                 error: `HTTP ${res.status}: ${String(res.text).slice(0, 300)}` };
      }
      return { status: 'sent', provider: 'email', ref: res.json?.id || null };
    } catch (err) {
      return { status: 'failed', provider: 'email', error: err.message };
    }
  },
};

/* ------------------------------------------------------------------ *
 * SMS
 * ------------------------------------------------------------------ */
/**
 * The body posted to the aggregator, as a function of the settings.
 *
 * Separated from the send so the branch can be tested without a network
 * or a database: "the field saved" and "the field changes the message"
 * are different claims, and only the second one decides whether a
 * candidate hears anything.
 *
 * Each field appears only when it has a value, so an aggregator that
 * does not use DLT is not handed keys it will reject.
 */
export function smsBody(to, text, cfg = {}) {
  const sender = cfg.senderId || config.smsSenderId || undefined;
  return {
    to,
    sender,
    message: text,
    ...(cfg.dltEntityId ? { entityId: cfg.dltEntityId } : {}),
    ...(cfg.dltTemplateId ? { templateId: cfg.dltTemplateId } : {}),
  };
}

export const smsProvider = {
  channel: 'sms',
  configured: () => !!(config.smsApiKey && config.smsApiUrl),
  async send({ to, text }) {
    if (!this.configured()) {
      return NOT_CONFIGURED('sms', 'SMS_API_KEY / SMS_API_URL are not set');
    }
    if (!to) return { status: 'skipped_no_address', provider: 'sms', error: 'no phone number' };

    /*
     * The settings an Indian operator actually checks.
     *
     * A correct API key still produces a dropped message when the header
     * is not a registered DLT sender and the body does not match a
     * registered DLT template - and several aggregators report that as a
     * success-shaped response, so it looks sent and never arrives. The
     * values are entered on the channels screen; the key stays in the
     * environment.
     *
     * Each field is sent only when it has a value, so an aggregator that
     * does not use DLT is not handed keys it will reject.
     */
    const cfg = await channelSettings('sms');

    try {
      const res = await postJson(config.smsApiUrl, {
        headers: { authorization: `Bearer ${config.smsApiKey}` },
        body: smsBody(to, text, cfg),
      });
      if (!res.ok) {
        return { status: 'failed', provider: 'sms',
                 error: `HTTP ${res.status}: ${String(res.text).slice(0, 300)}` };
      }
      return { status: 'sent', provider: 'sms',
               ref: res.json?.messageId || res.json?.id || null };
    } catch (err) {
      return { status: 'failed', provider: 'sms', error: err.message };
    }
  },
};

/* ------------------------------------------------------------------ *
 * IVR — an automated call
 *
 * An automated call, placed at every stage alongside the written
 * channels, because a candidate who does not read email still answers
 * their phone.
 *
 * The text sent here is SPOKEN, so it is the short form - the same string
 * the SMS carries. Nothing is abbreviated for a screen, and no link is
 * read out, because neither survives being said aloud.
 *
 * Providers differ in how they take the message (some want TwiML, some
 * want plain text and a voice id). This posts the generic shape and the
 * mapping to a specific vendor belongs in one place: here.
 * ------------------------------------------------------------------ */
export const ivrProvider = {
  channel: 'ivr',
  configured: () => !!(config.ivrApiKey && config.ivrApiUrl),
  async send({ to, text }) {
    if (!this.configured()) {
      return NOT_CONFIGURED('ivr', 'IVR_API_KEY / IVR_API_URL are not set');
    }
    if (!to) return { status: 'skipped_no_address', provider: 'ivr', error: 'no phone number' };

    try {
      const res = await postJson(config.ivrApiUrl, {
        headers: { authorization: `Bearer ${config.ivrApiKey}` },
        body: {
          to,
          from: config.ivrFrom || undefined,
          language: config.ivrLanguage,
          // Spoken, not displayed.
          message: speakable(text),
        },
      });
      if (!res.ok) {
        return { status: 'failed', provider: 'ivr',
                 error: `HTTP ${res.status}: ${String(res.text).slice(0, 300)}` };
      }
      return { status: 'sent', provider: 'ivr',
               ref: res.json?.callId || res.json?.id || null };
    } catch (err) {
      return { status: 'failed', provider: 'ivr', error: err.message };
    }
  },
};

/**
 * A URL read aloud is noise, and an id read aloud is worse. Strip what
 * cannot be spoken and leave the sentence.
 */
function speakable(text) {
  return String(text || '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/* ------------------------------------------------------------------ *
 * WhatsApp
 * ------------------------------------------------------------------ */
/**
 * Template or free text, and the choice is Meta's, not ours.
 *
 * Separated from the send for the same reason as smsBody: this branch
 * is the difference between a message WhatsApp accepts and one it
 * rejects, so it is tested directly rather than inferred from a
 * successful HTTP call.
 */
export function whatsappBody(text, cfg = {}) {
  if (!cfg.templateName) {
    return { type: 'text', text: { preview_url: true, body: text } };
  }
  return {
    type: 'template',
    template: {
      name: cfg.templateName,
      language: { code: cfg.templateLanguage || 'en' },
      // Exactly one body variable, holding the whole composed message,
      // so the wording stays the same across every channel instead of
      // drifting into a second copy kept in WhatsApp Manager.
      components: [{ type: 'body', parameters: [{ type: 'text', text }] }],
    },
  };
}

export const whatsappProvider = {
  channel: 'whatsapp',
  configured: () => !!(config.whatsappApiKey && config.whatsappPhoneId),
  async send({ to, text }) {
    if (!this.configured()) {
      return NOT_CONFIGURED('whatsapp', 'WHATSAPP_API_KEY / WHATSAPP_PHONE_ID are not set');
    }
    if (!to) return { status: 'skipped_no_address', provider: 'whatsapp', error: 'no phone number' };

    /*
     * Template or free text, and the choice is Meta's, not ours.
     *
     * WhatsApp allows free-form text only inside the 24-hour window that
     * opens when the candidate messages US. A stage update is
     * business-initiated, so outside that window it is rejected unless
     * it is sent as a template Meta has approved.
     *
     * The template is expected to carry exactly ONE body variable, and
     * the whole composed message goes into it - which keeps one wording
     * across every channel instead of a second copy that drifts. With no
     * template name configured this still sends text, because inside the
     * window that is correct and it is what a reply needs.
     */
    const cfg = await channelSettings('whatsapp');

    try {
      // WhatsApp Cloud API shape.
      const url = `${config.whatsappApiUrl.replace(/\/$/, '')}/${config.whatsappPhoneId}/messages`;
      const res = await postJson(url, {
        headers: { authorization: `Bearer ${config.whatsappApiKey}` },
        body: {
          messaging_product: 'whatsapp',
          to: String(to).replace(/[^\d+]/g, ''),
          ...whatsappBody(text, cfg),
        },
      });
      if (!res.ok) {
        return { status: 'failed', provider: 'whatsapp',
                 error: `HTTP ${res.status}: ${String(res.text).slice(0, 300)}` };
      }
      return { status: 'sent', provider: 'whatsapp',
               ref: res.json?.messages?.[0]?.id || null };
    } catch (err) {
      return { status: 'failed', provider: 'whatsapp', error: err.message };
    }
  },
};

/* ------------------------------------------------------------------ *
 * Naukri
 *
 * READ THIS BEFORE ASSUMING THIS WORKS.
 *
 * Naukri has no open employer API for pushing a message into a
 * candidate's Applications or Messages view. Access is partner-gated and
 * granted per employer account, and the endpoint, auth scheme and payload
 * differ by agreement. Nothing here can be verified without that access.
 *
 * So this is written as a configurable HTTP integration rather than a
 * guess at their protocol: give it a URL and a token and it posts the
 * documented payload. Until then it reports `not_configured`, and it will
 * never report `sent` for a message Naukri did not accept.
 *
 * The prototype's "Naukri" switch was a boolean in localStorage whose own
 * label read "Simulated". This at least fails honestly.
 * ------------------------------------------------------------------ */
export const naukriProvider = {
  channel: 'naukri',
  configured: () => !!(config.naukriApiUrl && config.naukriApiKey),
  async send({ payload }) {
    if (!this.configured()) {
      return NOT_CONFIGURED('naukri',
        'NAUKRI_API_URL / NAUKRI_API_KEY are not set — Naukri employer API access is ' +
        'granted per account and must be configured before this channel can deliver');
    }
    try {
      const res = await postJson(config.naukriApiUrl, {
        headers: {
          authorization: `Bearer ${config.naukriApiKey}`,
          ...(config.naukriEmployerId ? { 'x-employer-id': config.naukriEmployerId } : {}),
        },
        body: payload,
        timeoutMs: 12000,
      });
      if (!res.ok) {
        return { status: 'failed', provider: 'naukri',
                 error: `HTTP ${res.status}: ${String(res.text).slice(0, 300)}` };
      }
      return { status: 'sent', provider: 'naukri',
               ref: res.json?.id || res.json?.referenceId || null };
    } catch (err) {
      return { status: 'failed', provider: 'naukri', error: err.message };
    }
  },
};

export const providers = {
  naukri: naukriProvider,
  sms: smsProvider,
  whatsapp: whatsappProvider,
  ivr: ivrProvider,
  email: emailProvider,
};

/**
 * What each channel still needs, by NAME.
 *
 * Names only, never values. A recruiter looking at "nothing reached this
 * candidate on WhatsApp" needs to know the reason is a missing
 * credential rather than a wrong number, and that is answerable without
 * showing anybody a secret.
 *
 * Email is the awkward one because it has three possible transports; the
 * answer is whichever one the deployment has started setting up, so the
 * advice matches what somebody has already decided to use.
 */
export function providerMissing(channel) {
  if (channel === 'sms') {
    return [
      !config.smsApiKey && 'SMS_API_KEY',
      !config.smsApiUrl && 'SMS_API_URL',
    ].filter(Boolean);
  }
  if (channel === 'whatsapp') {
    return [
      !config.whatsappApiKey && 'WHATSAPP_API_KEY',
      !config.whatsappPhoneId && 'WHATSAPP_PHONE_ID',
    ].filter(Boolean);
  }
  if (channel === 'ivr') {
    return [
      !config.ivrApiKey && 'IVR_API_KEY',
      !config.ivrApiUrl && 'IVR_API_URL',
    ].filter(Boolean);
  }
  if (channel === 'email') {
    if (emailProvider.configured()) return [];
    // Partly set up counts as chosen: finish the one already started
    // rather than being told about three alternatives.
    if (config.smtpHost || config.smtpUser || config.smtpPass) {
      return [
        !config.smtpHost && 'EMAIL_SMTP_HOST',
        !config.smtpUser && 'EMAIL_SMTP_USER',
        !config.smtpPass && 'EMAIL_SMTP_PASS',
        !config.emailFrom && 'EMAIL_FROM',
      ].filter(Boolean);
    }
    const ejs = emailjsReady();
    if (ejs.missing && ejs.missing.length && ejs.missing.length < 4) {
      return ejs.missing.slice();
    }
    return ['EMAIL_SMTP_HOST (or the EMAILJS_* settings)'];
  }
  return [];
}

/** Which transport a configured channel is actually using. */
export function providerTransport(channel) {
  if (channel !== 'email') return channel;
  if (smtpReady()) return `SMTP (${config.smtpHost})`;
  if (emailjsReady().ready) return 'EmailJS';
  if (config.emailApiKey) return 'HTTP API';
  return 'none';
}

/** What an operator sees on the admin screen / at boot. */
export function providerStatus() {
  const out = {};
  for (const [name, p] of Object.entries(providers)) {
    out[name] = p.configured() ? 'configured' : 'not_configured';
  }
  return out;
}
