/**
 * Telephony, speech-to-text and text-to-speech, behind three interfaces.
 *
 * The application must not know which vendor is on the other side. That
 * is not architectural taste: telephony contracts get renegotiated,
 * providers get blocked by carriers, and an Indian deployment often ends
 * up on Exotel or Knowlarity where a US one is on Twilio. Any of those
 * changes should be an environment variable, not a rewrite.
 *
 *   TelephonyProvider   place a call, speak, listen, hang up, transfer
 *   SpeechToTextProvider   audio -> text (usually the telephony vendor's)
 *   TextToSpeechProvider   text -> audio (usually the telephony vendor's)
 *
 * Every provider is selected by env, and every secret comes from env.
 * Nothing here contains a key, and no key is ever sent to the browser.
 *
 * THE LOCAL DRIVER
 *
 * `local` is not a mock of the conversation - the conversation engine,
 * the database writes, the ATS update and the notifications are all the
 * real ones. It only replaces the part that needs a carrier: the audio.
 * Turns arrive over HTTP instead of over a phone line, which makes the
 * whole flow runnable and testable today, and means adding credentials
 * changes exactly one thing.
 */
import { config } from '../config.js';

/**
 * @typedef {Object} TelephonyProvider
 * @property {string} name
 * @property {() => boolean} configured
 * @property {(opts:{to:string, sessionId:string, webhookUrl:string,
 *            callerId?:string, record?:boolean}) => Promise<{callId:string, status:string}>} placeCall
 * @property {(opts:{callId:string, text:string, language:string,
 *            expectReply:boolean}) => Promise<any>} speak
 * @property {(opts:{callId:string}) => Promise<any>} hangup
 * @property {(opts:{callId:string, to:string}) => Promise<any>} [transfer]
 * @property {(req:import('express').Request) => boolean} [verifyWebhook]
 */

const nowId = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/* ------------------------------------------------------------------ *
 * local — a real run of everything except the carrier
 * ------------------------------------------------------------------ */

const localCalls = new Map();

/** @type {TelephonyProvider} */
const localProvider = {
  name: 'local',
  configured: () => true,
  async placeCall({ to, sessionId }) {
    const callId = nowId('local');
    localCalls.set(callId, { sessionId, to, said: [], status: 'in_progress' });
    return { callId, status: 'in_progress' };
  },
  async speak({ callId, text, language, expectReply }) {
    const c = localCalls.get(callId);
    if (c) c.said.push({ text, language, at: new Date().toISOString() });
    return { ok: true, spoken: text, expectReply };
  },
  async hangup({ callId }) {
    const c = localCalls.get(callId);
    if (c) c.status = 'completed';
    return { ok: true };
  },
  /** What the agent has said on this call — used by the local console. */
  transcriptOf(callId) {
    return localCalls.get(callId)?.said || [];
  },
};

/* ------------------------------------------------------------------ *
 * twilio
 * ------------------------------------------------------------------ */

/**
 * Twilio drives the call by fetching TwiML from us at every turn, so
 * `speak` returns the document rather than pushing audio: the webhook
 * route renders it. `placeCall` is the only outbound HTTP call.
 */
const twilioProvider = {
  name: 'twilio',
  configured: () => !!(config.telephony.accountSid && config.telephony.authToken
                       && config.telephony.fromNumber),

  async placeCall({ to, sessionId, webhookUrl, record }) {
    const sid = config.telephony.accountSid;
    const body = new URLSearchParams({
      To: to,
      From: config.telephony.fromNumber,
      Url: `${webhookUrl}?session=${encodeURIComponent(sessionId)}`,
      StatusCallback: `${webhookUrl}/status?session=${encodeURIComponent(sessionId)}`,
      StatusCallbackEvent: 'initiated ringing answered completed',
      Timeout: String(config.telephony.ringTimeout || 30),
      MachineDetection: 'Enable',
    });
    if (record) body.set('Record', 'true');

    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json`, {
      method: 'POST',
      headers: {
        authorization: 'Basic ' + Buffer.from(`${sid}:${config.telephony.authToken}`).toString('base64'),
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(json.message || `Twilio refused the call (${res.status})`);
    }
    return { callId: json.sid, status: json.status || 'queued' };
  },

  /**
   * One turn as TwiML: say the line, then listen.
   *
   * `speechTimeout: auto` is what makes barge-in and natural turn-taking
   * work — Twilio stops listening when the person stops talking rather
   * than after a fixed number of seconds.
   */
  async speak({ text, language, expectReply, webhookUrl, sessionId, silenceSeconds }) {
    const voice = { en: 'en-IN', hi: 'hi-IN', te: 'te-IN' }[language] || 'en-IN';
    const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
    const gather = expectReply
      ? `<Gather input="speech" language="${voice}" speechTimeout="auto" `
        + `timeout="${silenceSeconds || 6}" bargeIn="true" `
        + `action="${esc(webhookUrl)}?session=${encodeURIComponent(sessionId)}" method="POST">`
        + `<Say language="${voice}">${esc(text)}</Say></Gather>`
        + `<Redirect method="POST">${esc(webhookUrl)}?session=${encodeURIComponent(sessionId)}&amp;silence=1</Redirect>`
      : `<Say language="${voice}">${esc(text)}</Say><Hangup/>`;
    return { twiml: `<?xml version="1.0" encoding="UTF-8"?><Response>${gather}</Response>` };
  },

  async hangup({ callId }) {
    const sid = config.telephony.accountSid;
    await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls/${callId}.json`, {
      method: 'POST',
      headers: {
        authorization: 'Basic ' + Buffer.from(`${sid}:${config.telephony.authToken}`).toString('base64'),
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ Status: 'completed' }),
    }).catch(() => {});
    return { ok: true };
  },

  async transfer({ text, to, language }) {
    const voice = { en: 'en-IN', hi: 'hi-IN', te: 'te-IN' }[language] || 'en-IN';
    return {
      twiml: `<?xml version="1.0" encoding="UTF-8"?><Response>`
        + `<Say language="${voice}">${String(text).replace(/[<>&]/g, '')}</Say>`
        + `<Dial>${to}</Dial></Response>`,
    };
  },

  /**
   * Twilio signs every webhook with the auth token over the full URL and
   * the sorted POST body. An unverified webhook endpoint is an open door
   * to anybody who learns the URL, so this is not optional in production.
   */
  verifyWebhook(req) {
    const signature = req.get('x-twilio-signature');
    if (!signature) return false;
    const token = config.telephony.authToken;
    if (!token) return false;

    const url = config.telephony.publicWebhookBase
      ? `${config.telephony.publicWebhookBase}${req.originalUrl}`
      : `${req.protocol}://${req.get('host')}${req.originalUrl}`;

    const body = req.body || {};
    const data = Object.keys(body).sort().reduce((acc, k) => acc + k + body[k], url);

    // eslint-disable-next-line global-require
    const { createHmac, timingSafeEqual } = require('node:crypto');
    const expected = createHmac('sha1', token).update(Buffer.from(data, 'utf8')).digest('base64');
    try {
      return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
    } catch { return false; }
  },
};

/* ------------------------------------------------------------------ *
 * exotel — the common Indian carrier path
 * ------------------------------------------------------------------ */

const exotelProvider = {
  name: 'exotel',
  configured: () => !!(config.telephony.exotelSid && config.telephony.exotelToken
                       && config.telephony.fromNumber),

  async placeCall({ to, sessionId, webhookUrl }) {
    const sid = config.telephony.exotelSid;
    const url = `https://${config.telephony.exotelKey}:${config.telephony.exotelToken}`
      + `@api.exotel.com/v1/Accounts/${sid}/Calls/connect.json`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        From: to,
        CallerId: config.telephony.fromNumber,
        Url: `${webhookUrl}?session=${encodeURIComponent(sessionId)}`,
        StatusCallback: `${webhookUrl}/status?session=${encodeURIComponent(sessionId)}`,
      }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.message || `Exotel refused the call (${res.status})`);
    return { callId: json?.Call?.Sid || nowId('exo'), status: json?.Call?.Status || 'queued' };
  },

  async speak({ text }) { return { text }; },
  async hangup() { return { ok: true }; },

  verifyWebhook(req) {
    // Exotel does not sign callbacks; a shared secret in the URL is the
    // documented approach, so that is what is checked.
    const secret = config.telephony.webhookSecret;
    if (!secret) return false;
    return req.query.token === secret || req.get('x-webhook-token') === secret;
  },
};

/* ------------------------------------------------------------------ *
 * speech
 * ------------------------------------------------------------------ */

/**
 * Speech-to-text.
 *
 * With Twilio and Exotel the carrier transcribes and posts text to the
 * webhook, so there is nothing to do here — `fromWebhook` simply reads
 * the field. A deployment using raw audio (a SIP trunk, or a provider
 * without built-in ASR) configures an external STT endpoint instead, and
 * only this function changes.
 */
export const speechToText = {
  name: () => (config.stt.apiUrl ? 'external' : 'provider-builtin'),
  configured: () => true,

  fromWebhook(body = {}) {
    const text = body.SpeechResult || body.speech_result || body.transcript
              || body.Digits || body.text || '';
    const confidence = Number(body.Confidence ?? body.confidence ?? 0.8);
    return { text: String(text).trim(), confidence };
  },

  async transcribe(audioUrl, language) {
    if (!config.stt.apiUrl) {
      throw new Error('No external speech-to-text endpoint is configured (STT_API_URL).');
    }
    const res = await fetch(config.stt.apiUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.stt.apiKey ? { authorization: `Bearer ${config.stt.apiKey}` } : {}),
      },
      body: JSON.stringify({ audioUrl, language }),
    });
    if (!res.ok) throw new Error(`Speech-to-text failed (${res.status})`);
    const json = await res.json();
    return { text: String(json.text || '').trim(), confidence: Number(json.confidence || 0.8) };
  },
};

/**
 * Text-to-speech.
 *
 * Same shape: the carrier's own <Say> is used unless a voice endpoint is
 * configured, in which case audio is synthesised and played by URL.
 */
export const textToSpeech = {
  name: () => (config.tts.apiUrl ? 'external' : 'provider-builtin'),
  configured: () => true,
  usesProviderVoice: () => !config.tts.apiUrl,

  async synthesise(text, language, voice) {
    if (!config.tts.apiUrl) return null;          // the carrier will speak it
    const res = await fetch(config.tts.apiUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.tts.apiKey ? { authorization: `Bearer ${config.tts.apiKey}` } : {}),
      },
      body: JSON.stringify({ text, language, voice: voice || config.tts.voice }),
    });
    if (!res.ok) throw new Error(`Text-to-speech failed (${res.status})`);
    const json = await res.json();
    return json.audioUrl || null;
  },
};

/* ------------------------------------------------------------------ *
 * selection
 * ------------------------------------------------------------------ */

const PROVIDERS = {
  local: localProvider,
  twilio: twilioProvider,
  exotel: exotelProvider,
};

/**
 * The configured provider, or the local driver.
 *
 * Falling back to `local` rather than throwing is deliberate: a
 * deployment without carrier credentials must still be able to run the
 * whole flow, and the session records `provider: 'local'` so nobody can
 * mistake it for a real call.
 */
export function telephony() {
  const want = (config.telephony.provider || 'local').toLowerCase();
  const p = PROVIDERS[want];
  if (!p) return localProvider;
  if (!p.configured()) return localProvider;
  return p;
}

export function telephonyStatus() {
  const want = (config.telephony.provider || 'local').toLowerCase();
  const p = PROVIDERS[want];
  const active = telephony().name;
  return {
    requested: want,
    active,
    configured: !!p && p.configured(),
    /*
     * Whether a phone would actually ring.
     *
     * The local driver answers `configured: true` because it is always
     * usable - it is what lets the conversation be rehearsed on screen
     * with no carrier account. But it dials nothing, and a status screen
     * reading "Connected / calls are live" off that flag tells a
     * recruiter something untrue about a candidate who was never
     * called. The two questions are different and now have different
     * answers.
     */
    real: active !== 'local',
    simulated: active === 'local',
    stt: speechToText.name(),
    tts: textToSpeech.name(),
    missing: !p ? [`unknown provider "${want}"`]
      : p.configured() ? []
      : missingFor(want),
  };
}

function missingFor(name) {
  if (name === 'twilio') {
    return ['TELEPHONY_ACCOUNT_SID', 'TELEPHONY_AUTH_TOKEN', 'TELEPHONY_FROM_NUMBER']
      .filter((k) => !process.env[k]);
  }
  if (name === 'exotel') {
    return ['EXOTEL_SID', 'EXOTEL_API_KEY', 'EXOTEL_API_TOKEN', 'TELEPHONY_FROM_NUMBER']
      .filter((k) => !process.env[k]);
  }
  return [];
}

export { localProvider };
