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
 */
const env = (k) => String(process.env[k] || '').trim();
const TIMEOUT_MS = () => Number(process.env.INTERVIEW_SPEECH_TIMEOUT_MS || 20_000);

export const sttProvider = () => (env('INTERVIEW_STT_PROVIDER').toLowerCase() || 'off');
export const ttsProvider = () => (env('INTERVIEW_TTS_PROVIDER').toLowerCase() || 'off');

export const sttEnabled = () => sttProvider() === 'http' && !!env('INTERVIEW_STT_URL');
export const ttsEnabled = () => ttsProvider() === 'http' && !!env('INTERVIEW_TTS_URL');

/** What the interview screen is told: where speech happens, never how to reach it. */
export function speechModes() {
  return { stt: sttEnabled() ? 'server' : 'browser', tts: ttsEnabled() ? 'server' : 'browser' };
}

async function withTimeout(run) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS());
  try { return await run(ctl.signal); } finally { clearTimeout(t); }
}

const auth = (key) => (env(key) ? { authorization: `Bearer ${env(key)}` } : {});

/** @returns the transcript, or '' when the provider heard nothing. Throws on failure. */
export async function transcribe(buffer, mime) {
  if (!sttEnabled()) throw new Error('server speech-to-text is not configured');
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
