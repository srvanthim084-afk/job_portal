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

export const emailProvider = {
  channel: 'email',
  // Either transport counts as configured; SMTP takes precedence.
  configured: () => !!(config.emailFrom &&
    ((config.smtpHost && config.smtpUser && config.smtpPass) || config.emailApiKey)),

  async send({ to, subject, html, text }) {
    if (!this.configured()) {
      return NOT_CONFIGURED('email',
        config.smtpHost
          ? 'EMAIL_SMTP_USER / EMAIL_SMTP_PASS are not set'
          : 'EMAIL_SMTP_HOST or EMAIL_API_KEY is not set');
    }
    if (!to) return { status: 'failed', provider: 'email', error: 'no email address' };

    if (config.smtpHost) {
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
export const smsProvider = {
  channel: 'sms',
  configured: () => !!(config.smsApiKey && config.smsApiUrl),
  async send({ to, text }) {
    if (!this.configured()) {
      return NOT_CONFIGURED('sms', 'SMS_API_KEY / SMS_API_URL are not set');
    }
    if (!to) return { status: 'skipped_no_address', provider: 'sms', error: 'no phone number' };

    try {
      const res = await postJson(config.smsApiUrl, {
        headers: { authorization: `Bearer ${config.smsApiKey}` },
        body: { to, sender: config.smsSenderId || undefined, message: text },
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
export const whatsappProvider = {
  channel: 'whatsapp',
  configured: () => !!(config.whatsappApiKey && config.whatsappPhoneId),
  async send({ to, text }) {
    if (!this.configured()) {
      return NOT_CONFIGURED('whatsapp', 'WHATSAPP_API_KEY / WHATSAPP_PHONE_ID are not set');
    }
    if (!to) return { status: 'skipped_no_address', provider: 'whatsapp', error: 'no phone number' };

    try {
      // WhatsApp Cloud API shape.
      const url = `${config.whatsappApiUrl.replace(/\/$/, '')}/${config.whatsappPhoneId}/messages`;
      const res = await postJson(url, {
        headers: { authorization: `Bearer ${config.whatsappApiKey}` },
        body: {
          messaging_product: 'whatsapp',
          to: String(to).replace(/[^\d+]/g, ''),
          type: 'text',
          text: { preview_url: true, body: text },
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

/** What an operator sees on the admin screen / at boot. */
export function providerStatus() {
  const out = {};
  for (const [name, p] of Object.entries(providers)) {
    out[name] = p.configured() ? 'configured' : 'not_configured';
  }
  return out;
}
