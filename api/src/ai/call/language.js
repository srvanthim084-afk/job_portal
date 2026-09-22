/**
 * Which language is this person speaking?
 *
 * Indian recruitment calls are rarely in one language. "Haan boliye",
 * "Telugu lo matladandi", "actually English mein baat kar sakte hain" and
 * "I'm interested, notice period 30 days undi" are all normal, and a
 * system that picks a language once and sticks to it will spend half its
 * calls being misunderstood.
 *
 * Detection runs on every candidate turn, not once at the start, because
 * the person who answers "hello" in English may well continue in Telugu.
 *
 * Script is decisive when present: Devanagari is Hindi, Telugu script is
 * Telugu, and no amount of word-frequency guessing beats that. Romanised
 * speech - which is most of it, since speech-to-text usually returns
 * Latin text - is scored on function words, because those are what
 * actually differ between the two languages. "React developer" is the
 * same in all three and carries no signal at all.
 */

/** Function words. Content words are deliberately absent: they are shared. */
const HINDI = [
  'haan', 'han', 'ji', 'nahi', 'nahin', 'kya', 'hai', 'hain', 'kar', 'karta',
  'karte', 'raha', 'rahe', 'rahi', 'mein', 'main', 'mera', 'meri', 'aap',
  'aapka', 'tum', 'abhi', 'baad', 'thoda', 'bahut', 'accha', 'acha', 'theek',
  'thik', 'bolo', 'boliye', 'bataiye', 'batao', 'chahiye', 'sakta', 'sakte',
  'sakti', 'nahī', 'kitna', 'kaise', 'kahan', 'kaun', 'kab', 'lekin', 'aur',
  'phir', 'zyada', 'kam', 'paisa', 'naukri', 'mahina', 'din', 'samay', 'baat',
  'karenge', 'karunga', 'hoga', 'tha', 'thi', 'the', 'yeh', 'woh', 'kuch',
];

const TELUGU = [
  'avunu', 'kadu', 'ledu', 'ledhu', 'ela', 'emi', 'enti', 'ento', 'meeru',
  'nenu', 'naaku', 'naku', 'meeku', 'undi', 'unnanu', 'unnaru', 'cheppandi',
  'cheppu', 'chestunna', 'chestunnanu', 'cheyali', 'kavali', 'vaddu',
  'baagundi', 'bagundi', 'sare', 'sarey', 'ippudu', 'tarvata', 'tarwata',
  'konchem', 'chala', 'matladandi', 'matladu', 'telusu', 'teliyadu', 'anta',
  'antha', 'entha', 'jeetham', 'jeetam', 'rojulu', 'nelalu', 'vachindi',
  'vellali', 'kuda', 'kani', 'ayithe', 'aithe', 'mari', 'appudu', 'ikkada',
  'akkada', 'dhaniki', 'gurinchi', 'pani', 'udyogam',
];

const ENGLISH = [
  'yes', 'no', 'the', 'and', 'i', 'am', 'is', 'are', 'was', 'have', 'has',
  'can', 'could', 'would', 'will', 'please', 'thanks', 'thank', 'okay', 'ok',
  'sure', 'actually', 'currently', 'looking', 'interested', 'not', 'right',
  'now', 'about', 'what', 'when', 'where', 'how', 'my', 'your', 'me', 'you',
  'we', 'they', 'this', 'that', 'with', 'for', 'from', 'but', 'because',
  'so', 'just', 'only', 'also', 'very', 'then', 'even', 'still', 'again',
  'maybe', 'fine', 'good', 'sorry', 'hello',
];

/**
 * English words that say nothing about WHICH language is being spoken,
 * but everything about whether the speaker is code switching.
 *
 * "notice period", "salary", "location", "company" appear in Hindi and
 * Telugu sentences constantly - putting them in ENGLISH above made
 * "Haan main interested hoon but notice period 60 days hai" score as
 * English, which is exactly backwards. They belong here instead: counted
 * for MIXED, ignored when choosing the language.
 */
const ENGLISH_MIXED_IN = [
  'company', 'salary', 'package', 'location', 'notice', 'period', 'experience',
  'job', 'role', 'work', 'office', 'remote', 'hybrid', 'interview', 'profile',
  'project', 'team', 'client', 'offer', 'joining', 'immediate', 'days',
  'months', 'years', 'call', 'time', 'meeting', 'update', 'change', 'process',
];

const DEVANAGARI = /[ऀ-ॿ]/;
const TELUGU_SCRIPT = /[ఀ-౿]/;

/** Phrases that are a request, not a sample: "speak in Telugu". */
const REQUESTS = [
  { re: /\b(telugu|telagu)\b.*(lo|in|me|mein)?\s*(matlad|mataad|speak|baat|chat)?/i, lang: 'te' },
  { re: /\b(hindi)\b.*(mein|me|in)?\s*(baat|bol|speak)?/i, lang: 'hi' },
  { re: /\b(english|inglish)\b.*(mein|me|lo|in)?\s*(baat|bol|speak|matlad)?/i, lang: 'en' },
  { re: /\bteluguloo?\b/i, lang: 'te' },
  { re: /\bhindi\s*(mein|me)\b/i, lang: 'hi' },
  { re: /\benglish\s*(mein|me|lo)\b/i, lang: 'en' },
];

const words = (t) => String(t || '').toLowerCase().split(/[^a-zऀ-ॿఀ-౿]+/i).filter(Boolean);

/**
 * @param {string} text          what the candidate said
 * @param {object} [opts]
 * @param {string} [opts.current] the language in use, for stability
 * @returns {{language:string, confidence:number, mixed:boolean,
 *            requested:boolean, scores:object}}
 *
 * `language` is one of en | hi | te. `mixed` says the person is code
 * switching (Hinglish, Telugu-English), which changes HOW the agent
 * speaks rather than WHICH language it picks.
 */
export function detectLanguage(text, opts = {}) {
  const raw = String(text || '').trim();
  if (!raw) {
    return { language: opts.current || 'en', confidence: 0, mixed: false, requested: false, scores: {} };
  }

  // 1. An explicit request wins over everything. Somebody asking to be
  //    spoken to in English is not a sample of English.
  for (const r of REQUESTS) {
    if (r.re.test(raw)) {
      return { language: r.lang, confidence: 0.98, mixed: false, requested: true, scores: {} };
    }
  }

  // 2. Script is unambiguous.
  if (TELUGU_SCRIPT.test(raw)) {
    return { language: 'te', confidence: 0.99, mixed: /[a-z]{3,}/i.test(raw), requested: false, scores: {} };
  }
  if (DEVANAGARI.test(raw)) {
    return { language: 'hi', confidence: 0.99, mixed: /[a-z]{3,}/i.test(raw), requested: false, scores: {} };
  }

  // 3. Romanised: count function words.
  const w = words(raw);
  const scores = { en: 0, hi: 0, te: 0 };
  let englishBorrowings = 0;
  for (const token of w) {
    if (HINDI.includes(token)) scores.hi++;
    if (TELUGU.includes(token)) scores.te++;
    if (ENGLISH.includes(token)) scores.en++;
    else if (ENGLISH_MIXED_IN.includes(token)) englishBorrowings++;
  }

  const total = scores.en + scores.hi + scores.te;
  if (!total) {
    // Nothing but content words - "React, Node, five years". That is not
    // evidence of a language change, so whatever is in use stays.
    return {
      language: opts.current || 'en',
      confidence: 0.2, mixed: false, requested: false, scores,
    };
  }

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [top, topScore] = ranked[0];
  const [, second] = ranked[1];

  // Mixed when an Indian language and English both show up properly. That
  // is Hinglish or Telugu-English, and the reply should match it rather
  // than switching to formal Hindi nobody uses on the phone.
  // Code switching is judged on ALL the English in the sentence,
  // including the borrowed nouns every Indian language uses for work -
  // "notice period", "salary", "location". Somebody saying "interest undi
  // but location konchem far" is plainly speaking half English, and the
  // reply should match that rather than switching to formal Telugu.
  const indian = Math.max(scores.hi, scores.te);
  const english = scores.en + englishBorrowings;
  const mixed = indian > 0 && english > 0 &&
                Math.min(indian, english) / Math.max(indian, english) >= 0.3;

  let language = top;
  let confidence = topScore / total;

  // A near-tie against the language already in use is not a reason to
  // switch: switching on one ambiguous word is how an agent ends up
  // changing language every other sentence.
  if (opts.current && top !== opts.current && topScore - second <= 1 && confidence < 0.7) {
    language = opts.current;
    confidence = 0.4;
  }

  return { language, confidence: Math.round(confidence * 100) / 100, mixed, requested: false, scores };
}

/**
 * Did the candidate just ask to change language?
 * Separate from detection because it is an instruction, and must be
 * obeyed immediately even mid-sentence.
 */
export function languageRequest(text) {
  for (const r of REQUESTS) if (r.re.test(String(text || ''))) return r.lang;
  return null;
}

export const LANGUAGE_NAMES = { en: 'English', hi: 'Hindi', te: 'Telugu' };
