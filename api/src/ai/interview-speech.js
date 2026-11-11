/**
 * Server-side speech for the AI video interview - the plug-in points.
 *
 * By default the interview uses the BROWSER's own speech: the Web Speech
 * API's SpeechRecognition for live captions and speechSynthesis to read
 * each question aloud. Nothing here runs, and no audio leaves the
 * candidate's machine except the recording of their answer, which is
 * stored like any other upload.
 *
 * A deployment that wants server speech sets, in the API's environment
 * (never in the page):
 *
 *   INTERVIEW_STT_PROVIDER=http      transcribe each uploaded answer
 *   INTERVIEW_STT_URL=https://...    POST audio bytes, Content-Type = the
 *                                    recording's type; expects JSON
 *                                    { "text": "..." }
 *   INTERVIEW_STT_KEY=...            sent as "Authorization: Bearer"
 *
 *   INTERVIEW_TTS_PROVIDER=http      speak each question with a server voice
 *   INTERVIEW_TTS_URL=https://...    POST JSON { text, language, voice };
 *                                    expects audio bytes back (audio/mpeg,
 *                                    audio/ogg, audio/wav or audio/webm)
 *   INTERVIEW_TTS_KEY=...            sent as "Authorization: Bearer"
 *   INTERVIEW_TTS_VOICE=...          optional voice name
 *
 * Both default to off. The keys are read here and nowhere else; they are
 * never logged, and never part of a response.
 *
 * TEAMLINK'S CALLING VOICE (founder 2026-11-11: "ai calling lo yela matladthundho, interview lo kuda alaagey matladali"):
 *
 *   INTERVIEW_TTS_PROVIDER=teamlink  the question in the voice TeamLink's AI phone calls use (English, Telugu, Hindi), at full quality
 *   INTERVIEW_STT_PROVIDER=teamlink  each recorded answer heard by the calls' listeners: its words AND its language, so the interview can
 *                                    follow a candidate who answers in Telugu or Hindi
 *
 * Both go to TeamLink on this machine (TEAMLINK_API_URL, /api/voice-service) with the secret TeamLink and the portal already share
 * (JOB_PORTAL_SYNC_TOKEN). Interview questions are translated there too (the local model), unless this portal has its own AI model.
 */
const env = (k) => String(process.env[k] || '').trim();
const TIMEOUT_MS = () => Number(process.env.INTERVIEW_SPEECH_TIMEOUT_MS || 20_000);

export const sttProvider = () => (env('INTERVIEW_STT_PROVIDER').toLowerCase() || 'off');
export const ttsProvider = () => (env('INTERVIEW_TTS_PROVIDER').toLowerCase() || 'off');

const teamlinkBase = () => env('TEAMLINK_API_URL').replace(/\/+$/, '');
const teamlinkReady = () => !!teamlinkBase() && !!env('JOB_PORTAL_SYNC_TOKEN');
const teamlinkHeaders = () => ({ 'x-teamlink-token': env('JOB_PORTAL_SYNC_TOKEN') });

export const sttEnabled = () => (sttProvider() === 'http' && !!env('INTERVIEW_STT_URL')) || (sttProvider() === 'teamlink' && teamlinkReady());
export const ttsEnabled = () => (ttsProvider() === 'http' && !!env('INTERVIEW_TTS_URL')) || (ttsProvider() === 'teamlink' && teamlinkReady());
/** Questions can be put into Telugu / Hindi: by this portal's own model (interview.js), or by TeamLink's local one. */
export const translateEnabled = () => teamlinkReady();

/** The interview's languages: the code the screen and TeamLink use. */
export const INTERVIEW_LANGS = ['en', 'te', 'hi'];
export const langCode = (v) => { const c = String(v || '').toLowerCase().split(/[-_]/)[0]; return INTERVIEW_LANGS.includes(c) ? c : 'en'; };

/** What the interview screen is told: where speech happens, never how to reach it. */
export function speechModes() {
  return {
    stt: sttEnabled() ? 'server' : 'browser', tts: ttsEnabled() ? 'server' : 'browser',
    // the languages the interview can be held in: English always; Telugu and Hindi when the questions can be translated
    languages: translateEnabled() ? INTERVIEW_LANGS : ['en'],
  };
}

async function withTimeout(run, ms = null) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms || TIMEOUT_MS());
  try { return await run(ctl.signal); } finally { clearTimeout(t); }
}

const auth = (key) => (env(key) ? { authorization: `Bearer ${env(key)}` } : {});

/** @returns the transcript, or '' when the provider heard nothing. Throws on failure. */
export async function transcribe(buffer, mime) {
  return (await transcribeEx(buffer, mime)).text;
}

/** @returns { text, language } - language 'en' | 'te' | 'hi' when the provider says it (TeamLink does), else null. Throws on failure. */
export async function transcribeEx(buffer, mime, hint = '') {
  if (!sttEnabled()) throw new Error('server speech-to-text is not configured');
  if (sttProvider() === 'teamlink') {
    return withTimeout(async (signal) => {
      const res = await fetch(`${teamlinkBase()}/api/voice-service/transcribe${hint ? `?hint=${encodeURIComponent(langCode(hint))}` : ''}`, {
        method: 'POST', signal, headers: { 'content-type': mime || 'application/octet-stream', ...teamlinkHeaders() }, body: buffer,
      });
      if (!res.ok) throw new Error(`TeamLink speech-to-text returned ${res.status}`);
      const json = await res.json().catch(() => ({}));
      return { text: String(json.text || '').replace(/\s+/g, ' ').trim().slice(0, 20000), language: json.language ? langCode(json.language) : null };
    }, 90_000);
  }
  return { text: await transcribeHttp(buffer, mime), language: null };
}

async function transcribeHttp(buffer, mime) {
  return withTimeout(async (signal) => {
    const res = await fetch(env('INTERVIEW_STT_URL'), {
      method: 'POST', signal,
      headers: { 'content-type': mime || 'application/octet-stream', ...auth('INTERVIEW_STT_KEY') },
      body: buffer,
    });
    if (!res.ok) throw new Error(`speech-to-text returned ${res.status}`);
    const json = await res.json().catch(() => ({}));
    return String(json.text || '').replace(/\s+/g, ' ').trim().slice(0, 20000);
  });
}

const AUDIO = /^audio\/(?:mpeg|mp3|ogg|wav|x-wav|webm)\b/i;

/** @returns { buffer, mime }. Throws on failure or a non-audio answer. */
export async function synthesise(text, language = 'en-IN') {
  if (!ttsEnabled()) throw new Error('server text-to-speech is not configured');
  if (ttsProvider() === 'teamlink') {
    return withTimeout(async (signal) => {
      const res = await fetch(`${teamlinkBase()}/api/voice-service/speak`, {
        method: 'POST', signal, headers: { 'content-type': 'application/json', ...teamlinkHeaders() },
        body: JSON.stringify({ text: String(text).slice(0, 1200), language: langCode(language) }),
      });
      if (!res.ok) throw new Error(`TeamLink text-to-speech returned ${res.status}`);
      const mime = String(res.headers.get('content-type') || '').split(';')[0].trim();
      if (!AUDIO.test(mime)) throw new Error('TeamLink text-to-speech did not return audio');
      const buffer = Buffer.from(await res.arrayBuffer());
      if (!buffer.length || buffer.length > 8 * 1024 * 1024) throw new Error('TeamLink text-to-speech returned an unusable file');
      return { buffer, mime };
    }, 40_000);
  }
  return withTimeout(async (signal) => {
    const res = await fetch(env('INTERVIEW_TTS_URL'), {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', ...auth('INTERVIEW_TTS_KEY') },
      body: JSON.stringify({ text: String(text).slice(0, 600), language, voice: env('INTERVIEW_TTS_VOICE') || undefined }),
    });
    if (!res.ok) throw new Error(`text-to-speech returned ${res.status}`);
    const mime = String(res.headers.get('content-type') || '').split(';')[0].trim();
    if (!AUDIO.test(mime)) throw new Error('text-to-speech did not return audio');
    const buffer = Buffer.from(await res.arrayBuffer());
    if (!buffer.length || buffer.length > 5 * 1024 * 1024) throw new Error('text-to-speech returned an unusable file');
    return { buffer, mime };
  });
}

/** Lines into Telugu / Hindi by TeamLink's local model. @returns the lines, or null when it could not. */
export async function translateViaTeamlink(lines, lang) {
  if (!translateEnabled() || langCode(lang) === 'en') return null;
  try {
    return await withTimeout(async (signal) => {
      const res = await fetch(`${teamlinkBase()}/api/voice-service/translate`, {
        method: 'POST', signal, headers: { 'content-type': 'application/json', ...teamlinkHeaders() },
        body: JSON.stringify({ lines, to: langCode(lang) }),
      });
      if (!res.ok) throw new Error(`TeamLink translate returned ${res.status}`);
      const json = await res.json().catch(() => ({}));
      return Array.isArray(json.lines) && json.lines.length === lines.length ? json.lines.map((x) => String(x || '')) : null;
    }, 150_000);
  } catch (err) {
    console.error('[interview] translation failed:', err.message);
    return null;
  }
}
