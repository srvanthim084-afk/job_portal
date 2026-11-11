/**
 * THE INTERVIEW IN THE CANDIDATE'S LANGUAGE (founder 2026-11-11: "ai calling lo yela matladthundho, interview lo kuda alaagey matladali" -
 * English, Telugu and Hindi, and switching when the candidate does).
 *
 * The questions are planned in English (interview.js). A question in Telugu or Hindi is a translation, made ONCE and kept here:
 *   - by this portal's own model when AI_API_KEY is set (seconds, the whole interview at once), else
 *   - by TeamLink's local model (/api/voice-service/translate; about half a minute a question on a CPU).
 * So the questions are translated AHEAD: the next ones while the candidate answers the current one (prefetch). A translation that is
 * not ready in time leaves the question in English - the interview never stops for it.
 */
import { translateWithModel } from './interview.js';
import { translateViaTeamlink, langCode } from './interview-speech.js';

const done = new Map();     // `${lang}|${english}` -> translated text
const running = new Map();  // `${lang}|${english}` -> Promise<string|null>
const key = (text, lang) => `${lang}|${text}`;
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

function remember(text, lang, out) {
  if (out && clean(out)) done.set(key(text, lang), clean(out));
  while (done.size > 5000) done.delete(done.keys().next().value);
}

/** Many lines at once (the model does them in one go); each line is then ready on its own. */
async function translateMany(texts, lang) {
  const todo = [...new Set(texts.map(clean).filter((t) => t && !done.has(key(t, lang))))];
  if (!todo.length) return;
  const viaModel = await translateWithModel(todo, lang);
  if (viaModel) { todo.forEach((t, i) => remember(t, lang, viaModel[i])); return; }
  // TeamLink's local model: one at a time, in order, so the first question is ready first
  for (const t of todo) {
    if (done.has(key(t, lang))) continue; // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    await one(t, lang);
  }
}

function one(text, lang) {
  const k = key(text, lang);
  if (done.has(k)) return Promise.resolve(done.get(k));
  if (running.has(k)) return running.get(k);
  const p = (async () => {
    const viaModel = await translateWithModel([text], lang);
    const out = viaModel ? viaModel[0] : (await translateViaTeamlink([text], lang) || [])[0];
    remember(text, lang, out);
    return done.get(k) || null;
  })().finally(() => running.delete(k));
  running.set(k, p);
  return p;
}

/** The text already translated, or null. */
export function translatedNow(text, lang) {
  const l = langCode(lang);
  if (l === 'en') return clean(text);
  return done.get(key(clean(text), l)) || null;
}

/** The text in that language, waiting up to waitMs; null when it is not ready by then (the caller keeps the English). */
export async function textIn(text, lang, waitMs = 45_000) {
  const l = langCode(lang); const t = clean(text);
  if (l === 'en' || !t) return t;
  if (done.has(key(t, l))) return done.get(key(t, l));
  const timer = new Promise((resolve) => { setTimeout(() => resolve(null), waitMs); });
  return Promise.race([one(t, l), timer]);
}

/** The next questions, in the background, in order. */
export function prefetch(texts, lang) {
  const l = langCode(lang);
  if (l === 'en') return;
  translateMany(texts, l).catch((err) => console.error('[interview] prefetch failed:', err.message));
}

export const _test = { done, running };
