/**
 * Email (SMTP), SMS Gateway and WhatsApp Business - configured by the administrator (0122).
 *
 *   one row per channel in integration_channels: settings (JSON, nothing secret), ONE sealed
 *   secret blob (AES-256-GCM, INTEGRATION_SECRET_KEY, see publishing/secrets.js), a status and the
 *   last test; every save / connect / disconnect / test is a row in integration_channel_events
 *   (field NAMES, never a value).
 *
 * WHAT READS IT. The senders (notify/providers.js) read `config.*`, which comes from the
 * environment. While a channel is CONNECTED here its values are laid over those fields
 * (`loadChannelOverlay`), so every module that sends - candidate messages, offer letters, invoices,
 * payslips, signing OTPs - uses what the administrator entered, with nothing hard-coded. Disconnect
 * takes the overlay off and the environment's own values (if any) apply again. Test uses the SAVED
 * settings directly, so a channel can be proven before it is connected.
 *
 * SECRETS never come back: a page is told "saved" and at most the last four characters of a long
 * one. Blank keeps the stored value, "-" clears it.
 */
import { withUser } from '../db.js';
import { config } from '../config.js';
import { badRequest, ApiError } from '../errors.js';
import { sealSecrets, openSecrets, hintFor, secretKeyConfigured, SecretKeyMissing } from '../publishing/secrets.js';
import { sendViaGateway, SMS_PROVIDERS } from './sms-gateways.js';
import { resetSmtp, blockedByAllowlist } from './providers.js';

const ENGINE = { userId: '', role: 'admin', profileId: null };

const email = (v) => /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(v);

/** What each channel holds. `secret` is the one secret field of the channel. */
export const DEFS = {
  email: {
    label: 'Email (SMTP)', secret: 'password', secretLabel: 'Password / App Key',
    fields: {
      host:        { required: 'SMTP Host is required', max: 253 },
      port:        { required: 'Port is required', int: [1, 65535], bad: 'Port must be a number from 1 to 65535' },
      fromAddress: { required: 'From Address is required', email: true, max: 254, bad: 'Enter a valid email address' },
      username:    { required: 'Username is required', max: 254 },
      encryption:  { oneOf: ['SSL', 'STARTTLS', 'None'], dflt: 'SSL' },
      fromName:    { max: 120 },
    },
  },
  sms: {
    label: 'SMS Gateway', secret: 'apiKey', secretLabel: 'API Key / Auth Token',
    fields: {
      provider:    { required: 'Choose a provider', oneOf: SMS_PROVIDERS },
      senderId:    { required: 'Sender ID is required', max: 30 },
      twilioSid:   { max: 80 },
      dltAgreement:{ max: 80 },
      dltOtp:      { max: 80 },
      dltBulk:     { max: 80 },
    },
  },
  whatsapp: {
    label: 'WhatsApp Business', secret: 'accessToken', secretLabel: 'Permanent Access Token',
    fields: {
      businessPhone:     { max: 30 },
      phoneNumberId:     { required: 'Phone Number ID is required', max: 60 },
      businessId:        { required: 'WhatsApp Business ID is required', max: 60 },
      namespace:         { max: 80 },
      language:          { max: 12, dflt: 'en' },
      templateAgreement: { max: 120 },
      templateOtp:       { max: 120 },
      templateBulk:      { max: 120 },
    },
  },
};

export const channelKey = (v) => {
  const k = String(v || '').toLowerCase();
  if (!DEFS[k]) throw new ApiError(404, 'NOT_FOUND', 'No such channel.');
  return k;
};

/* ---- the environment's own values, remembered so Disconnect can give them back ---- */
const OVERLAY_KEYS = ['smtpHost', 'smtpPort', 'smtpSecure', 'smtpUser', 'smtpPass', 'emailFrom', 'emailFromName',
  'smsApiKey', 'smsSenderId', 'whatsappApiKey', 'whatsappPhoneId'];
const EXTRA_KEYS = ['smtpEncryption', 'smsGateway', 'smsGatewaySid', 'smsTemplates', 'waTemplates', 'waLanguage', 'waNamespace', 'waBusinessId'];
const BASELINE = Object.fromEntries(OVERLAY_KEYS.map((k) => [k, config[k]]));

const envConfigured = () => ({
  email: !!(BASELINE.smtpHost && BASELINE.smtpUser && BASELINE.smtpPass && BASELINE.emailFrom),
  sms: !!BASELINE.smsApiKey,
  whatsapp: !!(BASELINE.whatsappApiKey && BASELINE.whatsappPhoneId),
});

/* ---- reading and cleaning what the page sends ---- */
function clean(channel, input) {
  const def = DEFS[channel];
  const out = {};
  const src = input && typeof input === 'object' ? input : {};
  for (const [k, spec] of Object.entries(def.fields)) {
    let v = src[k];
    v = v == null ? '' : String(v).trim();
    if (!v && spec.dflt) v = spec.dflt;
    out[k] = v;
  }
  return out;
}

/** Inline errors keyed by field. Empty when the settings are complete. */
export function validate(channel, cfg, secretPresent) {
  const def = DEFS[channel];
  const err = {};
  for (const [k, spec] of Object.entries(def.fields)) {
    const v = cfg[k];
    if (spec.required && !v) { err[k] = spec.required; continue; }
    if (!v) continue;
    if (spec.int) {
      const n = Number(v);
      if (!Number.isInteger(n) || n < spec.int[0] || n > spec.int[1]) err[k] = spec.bad;
    }
    if (spec.email && !email(v)) err[k] = spec.bad;
    if (spec.oneOf && !spec.oneOf.includes(v)) err[k] = `Choose one of: ${spec.oneOf.join(', ')}`;
    if (spec.max && v.length > spec.max) err[k] = `Too long (at most ${spec.max} characters)`;
  }
  if (channel === 'sms' && cfg.provider === 'Twilio' && !cfg.twilioSid) err.twilioSid = 'Twilio Account SID is required';
  if (channel === 'sms' && cfg.provider && cfg.provider !== 'Twilio' && cfg.senderId && !/^[A-Za-z0-9]{6}$/.test(cfg.senderId)) {
    err.senderId = 'Sender ID must be exactly 6 letters or digits';
  }
  if (!secretPresent) err[def.secret] = `${def.secretLabel} is required`;
  return err;
}

const throwErrors = (err) => { throw badRequest('Please fix the highlighted fields.', err); };

/* ---- what a page may see ---- */
function summaryOf(channel, cfg) {
  if (channel === 'email') return cfg.host ? `${cfg.host}:${cfg.port || ''}`.replace(/:$/, '') : '';
  if (channel === 'sms') return [cfg.provider, cfg.senderId].filter(Boolean).join(' · ');
  return cfg.businessPhone || (cfg.phoneNumberId ? `Phone number ID ${cfg.phoneNumberId}` : '');
}

export function viewOf(channel, row) {
  const def = DEFS[channel];
  const cfg = clean(channel, row && row.config);
  const hints = (row && row.secret_hints) || {};
  const saved = !!(row && row.secrets_enc);
  const readable = !saved || !!openSecrets(row.secrets_enc);
  const connected = !!(row && row.status === 'connected');
  return {
    channel, label: def.label, secretField: def.secret, secretLabel: def.secretLabel,
    connected, status: connected ? 'Connected' : 'Not Connected',
    /* Live: the channel contacts the real provider with what was entered. Demo: it does not (nothing connected here). */
    mode: connected ? 'Live' : 'Demo',
    summary: summaryOf(channel, cfg),
    config: cfg,
    secrets: { [def.secret]: { saved, hint: hints[def.secret] == null ? null : hints[def.secret] } },
    secretsReadable: readable,
    usingEnvironment: !connected && envConfigured()[channel],
    lastTest: row && row.last_tested_at
      ? { at: row.last_tested_at, ok: !!row.last_test_ok, message: row.last_test_message || '' } : null,
    updatedAt: row ? row.updated_at : null,
  };
}

export async function listChannels(session) {
  const rows = await withUser(session, async (c) => (await c.query(`select * from integration_channels`)).rows);
  const by = Object.fromEntries(rows.map((r) => [r.channel, r]));
  return { secretKeyConfigured: secretKeyConfigured(), channels: Object.keys(DEFS).map((k) => viewOf(k, by[k] || null)) };
}

async function logEvent(c, channel, event, detail, actor) {
  await c.query(`insert into integration_channel_events (channel, event, detail, actor) values ($1,$2,$3,$4)`,
    [channel, event, detail || null, actor || null]);
}

export async function eventsOf(session, channel) {
  const rows = await withUser(session, async (c) => (await c.query(
    `select event, detail, actor, created_at from integration_channel_events where channel=$1 order by id desc limit 100`, [channel])).rows);
  return rows.map((e) => ({ event: e.event, detail: e.detail, byUser: !!e.actor, at: e.created_at }));
}

/**
 * Save the settings, and connect.
 * body: { config: {...}, secrets: { <secret>: 'value' | '' (keep) | '-' (clear) }, connect?: boolean (default true) }
 */
export async function saveChannel(session, channel, body) {
  const def = DEFS[channel];
  const incoming = clean(channel, body && body.config);
  const raw = body && body.secrets && body.secrets[def.secret];
  const given = raw == null ? '' : String(raw);
  if (given.length > 4000) throw badRequest('The secret is too long.', { [def.secret]: 'Too long' });
  const wantsConnect = !(body && body.connect === false);

  const out = await withUser(session, async (c) => {
    const cur = (await c.query(`select * from integration_channels where channel=$1`, [channel])).rows[0] || null;
    const existing = (cur && openSecrets(cur.secrets_enc)) || {};
    let secrets = { ...existing };
    let clearedSecret = false; let replacedSecret = false;
    if (given.trim() === '-') { delete secrets[def.secret]; clearedSecret = true; }
    else if (given.trim() !== '') { secrets[def.secret] = given.trim(); replacedSecret = true; }

    const errors = validate(channel, incoming, !!secrets[def.secret]);
    if (wantsConnect && Object.keys(errors).length) throwErrors(errors);
    /* a draft save (connect: false) only insists on well-formed values */
    if (!wantsConnect) {
      for (const k of Object.keys(errors)) {
        if (!/is required$/.test(errors[k])) throwErrors({ [k]: errors[k] });
      }
    }

    let sealed = cur ? cur.secrets_enc : null;
    let hints = (cur && cur.secret_hints) || {};
    if (replacedSecret || clearedSecret) {
      if (replacedSecret && !secretKeyConfigured()) {
        throw new ApiError(409, 'INTEGRATION_SECRET_KEY_MISSING', new SecretKeyMissing().message);
      }
      hints = {};
      for (const [k, v] of Object.entries(secrets)) hints[k] = hintFor(v);
      sealed = Object.keys(secrets).length ? sealSecrets(secrets) : null;
    }
    const status = wantsConnect ? 'connected' : (cur ? cur.status : 'not_connected');

    await c.query(
      `insert into integration_channels (channel, config, secrets_enc, secret_hints, status, updated_by, updated_at)
       values ($1,$2,$3,$4,$5,$6,now())
       on conflict (channel) do update set config=excluded.config, secrets_enc=excluded.secrets_enc,
         secret_hints=excluded.secret_hints, status=excluded.status, updated_by=excluded.updated_by, updated_at=now()`,
      [channel, JSON.stringify(incoming), sealed, JSON.stringify(hints), status, session.userId || null]);

    /* the history names the fields that changed - never a value */
    const was = clean(channel, cur && cur.config);
    const changed = Object.keys(incoming).filter((k) => (was[k] || '') !== (incoming[k] || ''));
    const actor = session.userId || null;
    if (changed.length) await logEvent(c, channel, 'config_saved', `Changed: ${changed.join(', ')}`, actor);
    if (replacedSecret) await logEvent(c, channel, 'secret_saved', `Saved: ${def.secret}`, actor);
    if (clearedSecret) await logEvent(c, channel, 'secret_cleared', `Cleared: ${def.secret}`, actor);
    if (wantsConnect && (!cur || cur.status !== 'connected')) await logEvent(c, channel, 'connected', null, actor);
    else if (wantsConnect) await logEvent(c, channel, 'saved_and_reconnected', null, actor);
    const row = (await c.query(`select * from integration_channels where channel=$1`, [channel])).rows[0];
    return viewOf(channel, row);
  });
  await loadChannelOverlay();
  return out;
}

export async function connectChannel(session, channel) {
  const def = DEFS[channel];
  const out = await withUser(session, async (c) => {
    const cur = (await c.query(`select * from integration_channels where channel=$1`, [channel])).rows[0];
    if (!cur) throwErrors({ [Object.keys(def.fields)[0]]: 'Nothing is configured yet - open Configure and fill it in.' });
    const secrets = openSecrets(cur.secrets_enc) || {};
    const errors = validate(channel, clean(channel, cur.config), !!secrets[def.secret]);
    if (Object.keys(errors).length) throwErrors(errors);
    await c.query(`update integration_channels set status='connected', updated_by=$2, updated_at=now() where channel=$1`,
      [channel, session.userId || null]);
    await logEvent(c, channel, cur.status === 'connected' ? 'reconnected' : 'connected', null, session.userId || null);
    return viewOf(channel, (await c.query(`select * from integration_channels where channel=$1`, [channel])).rows[0]);
  });
  await loadChannelOverlay();
  return out;
}

export async function disconnectChannel(session, channel) {
  const out = await withUser(session, async (c) => {
    const cur = (await c.query(`select * from integration_channels where channel=$1`, [channel])).rows[0];
    if (!cur) return viewOf(channel, null);
    await c.query(`update integration_channels set status='not_connected', updated_by=$2, updated_at=now() where channel=$1`,
      [channel, session.userId || null]);
    await logEvent(c, channel, 'disconnected', null, session.userId || null);
    return viewOf(channel, (await c.query(`select * from integration_channels where channel=$1`, [channel])).rows[0]);
  });
  await loadChannelOverlay();
  return out;
}

/* ================================================================== *
 * Test - the REAL provider, with the saved settings
 * ================================================================== */
const scrub = (msg, secrets) => {
  let s = String(msg || '');
  for (const v of Object.values(secrets || {})) if (v && String(v).length >= 4) s = s.split(String(v)).join('••••');
  return s.slice(0, 400);
};

async function testEmail(cfg, secrets, to) {
  const { default: nodemailer } = await import('nodemailer');
  const enc = cfg.encryption || 'SSL';
  const t = nodemailer.createTransport({
    host: cfg.host, port: Number(cfg.port), secure: enc === 'SSL', requireTLS: enc === 'STARTTLS', ignoreTLS: enc === 'None',
    auth: cfg.username ? { user: cfg.username, pass: secrets.password } : undefined,
    connectionTimeout: 15_000, greetingTimeout: 10_000, socketTimeout: 20_000,
  });
  try {
    await t.verify();
    const from = cfg.fromName ? `"${cfg.fromName.replace(/["\\]/g, '')}" <${cfg.fromAddress}>` : cfg.fromAddress;
    await t.sendMail({ from, to, subject: 'TeamLink test email',
      text: 'This is a test message from TeamLink. Your SMTP settings work.\n\nIf you received it, the Email channel is connected.' });
    return { ok: true, message: `Test email sent to ${to} through ${cfg.host}:${cfg.port}.` };
  } finally {
    try { t.close(); } catch { /* closed */ }
  }
}

async function testSms(cfg, secrets, to) {
  const r = await sendViaGateway({ provider: cfg.provider, apiKey: secrets.apiKey, senderId: cfg.senderId, twilioSid: cfg.twilioSid,
    templates: { agreement: cfg.dltAgreement, otp: cfg.dltOtp, bulk: cfg.dltBulk }, purpose: 'bulk', to,
    text: 'TeamLink test message: your SMS gateway is connected.' });
  return r.status === 'sent'
    ? { ok: true, message: `${cfg.provider} accepted the test SMS to ${to}${r.ref ? ` (ref ${r.ref})` : ''}.` }
    : { ok: false, message: r.error || 'The provider did not accept the message.' };
}

async function testWhatsapp(cfg, secrets, to) {
  const base = String(process.env.WHATSAPP_API_URL || config.whatsappApiUrl || 'https://graph.facebook.com/v21.0').replace(/\/$/, '');
  const text = 'TeamLink test message: your WhatsApp Business channel is connected.';
  const body = cfg.templateBulk
    ? { type: 'template', template: { name: cfg.templateBulk, language: { code: cfg.language || 'en' },
        components: [{ type: 'body', parameters: [{ type: 'text', text }] }] } }
    : { type: 'text', text: { preview_url: false, body: text } };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12_000);
  try {
    const res = await fetch(`${base}/${encodeURIComponent(cfg.phoneNumberId)}/messages`, {
      method: 'POST', signal: ctl.signal,
      headers: { authorization: `Bearer ${secrets.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: String(to).replace(/[^\d]/g, ''), ...body }) });
    const raw = await res.text();
    let json = null; try { json = JSON.parse(raw); } catch { /* not JSON */ }
    if (!res.ok) {
      const hint = !cfg.templateBulk && /24|window|template|131047|131026/i.test(raw)
        ? ' (Plain text only works inside a 24-hour customer session - set a Bulk / General template name.)' : '';
      return { ok: false, message: `WhatsApp ${res.status}: ${String(json?.error?.message || raw).slice(0, 250)}${hint}` };
    }
    return { ok: true, message: `WhatsApp accepted the test message to ${to}${json?.messages?.[0]?.id ? ` (id ${json.messages[0].id})` : ''}.` };
  } catch (err) {
    return { ok: false, message: err.name === 'AbortError' ? 'WhatsApp did not answer in time.' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

export async function testChannel(session, channel, to) {
  const def = DEFS[channel];
  const row = await withUser(session, async (c) => (await c.query(`select * from integration_channels where channel=$1`, [channel])).rows[0]);
  const cfg = clean(channel, row && row.config);
  const secrets = (row && openSecrets(row.secrets_enc)) || {};
  const errors = row ? validate(channel, cfg, !!secrets[def.secret]) : { [Object.keys(def.fields)[0]]: 'Nothing is configured yet.' };
  if (Object.keys(errors).length) {
    return { ok: false, message: row && row.secrets_enc && !openSecrets(row.secrets_enc)
      ? 'The saved credentials cannot be read on this server (INTEGRATION_SECRET_KEY missing or changed). Enter them again.'
      : `Fix the settings first: ${Object.values(errors)[0]}`, view: viewOf(channel, row || null) };
  }
  /* The same guard as every other send: while OUTBOUND_ALLOWLIST lists numbers, nobody else is messaged - not even by a test. */
  if (channel !== 'email') {
    const blocked = blockedByAllowlist(channel, to);
    if (blocked) return { ok: false, message: `Not sent: ${blocked.error}.`, view: viewOf(channel, row) };
  }
  let result;
  try {
    result = channel === 'email' ? await testEmail(cfg, secrets, to)
      : channel === 'sms' ? await testSms(cfg, secrets, to) : await testWhatsapp(cfg, secrets, to);
  } catch (err) {
    result = { ok: false, message: err.message };
  }
  const message = scrub(result.message, secrets);
  const view = await withUser(session, async (c) => {
    await c.query(`update integration_channels set last_tested_at=now(), last_test_ok=$2, last_test_message=$3 where channel=$1`,
      [channel, !!result.ok, message]);
    await logEvent(c, channel, result.ok ? 'test_ok' : 'test_failed', message, session.userId || null);
    return viewOf(channel, (await c.query(`select * from integration_channels where channel=$1`, [channel])).rows[0]);
  });
  return { ok: !!result.ok, message, view };
}

/* ================================================================== *
 * The overlay: what the senders read
 * ================================================================== */
export async function loadChannelOverlay() {
  let rows = [];
  try {
    rows = await withUser(ENGINE, async (c) => (await c.query(`select * from integration_channels where status='connected'`)).rows);
  } catch (err) {
    console.error('[channels] the connected channels could not be read:', err.message);
    return false;
  }
  /* back to the environment's own values, then lay each connected channel over them */
  Object.assign(config, BASELINE);
  for (const k of EXTRA_KEYS) delete config[k];

  for (const row of rows) {
    const channel = row.channel;
    if (!DEFS[channel]) continue;
    const cfg = clean(channel, row.config);
    const secrets = openSecrets(row.secrets_enc);
    if (!secrets || !secrets[DEFS[channel].secret]) continue;       // unreadable: stay on the environment
    if (channel === 'email') {
      Object.assign(config, {
        smtpHost: cfg.host, smtpPort: Number(cfg.port), smtpSecure: (cfg.encryption || 'SSL') === 'SSL',
        smtpEncryption: cfg.encryption || 'SSL', smtpUser: cfg.username, smtpPass: secrets.password,
        emailFrom: cfg.fromAddress, emailFromName: cfg.fromName || '',
      });
    } else if (channel === 'sms') {
      Object.assign(config, {
        smsGateway: cfg.provider.toLowerCase(), smsApiKey: secrets.apiKey, smsSenderId: cfg.senderId, smsGatewaySid: cfg.twilioSid,
        smsTemplates: { agreement: cfg.dltAgreement, otp: cfg.dltOtp, bulk: cfg.dltBulk },
      });
    } else if (channel === 'whatsapp') {
      Object.assign(config, {
        whatsappApiKey: secrets.accessToken, whatsappPhoneId: cfg.phoneNumberId, waBusinessId: cfg.businessId,
        waNamespace: cfg.namespace, waLanguage: cfg.language || 'en',
        waTemplates: { agreement: cfg.templateAgreement, otp: cfg.templateOtp, bulk: cfg.templateBulk },
      });
    }
  }
  resetSmtp();
  return true;
}
