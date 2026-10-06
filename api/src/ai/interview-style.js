/**
 * How the AI interviewer is allowed to speak.
 *
 * The owner's rules (docs/AI-VIDEO-INTERVIEW.md, and the system prompt in
 * ./prompts/ai-interviewer-system.txt):
 *
 *   - never phrase a job skill as a gap: no "I could not find", "your
 *     resume does not show", "you did not mention", "I don't see", "it is
 *     not listed";
 *   - every question under 25 words;
 *   - never ask about age, religion, marital status, health, caste,
 *     nationality or any other protected personal information;
 *   - at most one follow-up per question, from four fixed templates, only
 *     when the answer is vague;
 *   - "no experience" is met with "Thank you for being open. How would you
 *     approach learning it?" and the interview moves on.
 *
 * A model can be TOLD these rules; it cannot be relied on to keep them. So
 * everything a model writes passes through enforceQuestion() before a
 * candidate hears it, and the rules-based planner (no AI key) is held to
 * the same filter - the post-filter is the guarantee, the prompt is only
 * the first line.
 *
 * Deterministic on purpose: the same question always gets the same
 * verdict, so a test can pin it down.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

let PROMPT = null;
/** The interviewer's system prompt, read once from the standalone text file. */
export function interviewerSystemPrompt() {
  if (PROMPT == null) {
    try {
      PROMPT = readFileSync(join(HERE, 'prompts', 'ai-interviewer-system.txt'), 'utf8').trim();
    } catch {
      // The file ships with the code; if a deployment lost it the rules
      // below still hold every question to the same standard.
      PROMPT = 'You are a professional, warm and respectful interviewer. Ask one open question at a time, '
        + 'under 25 words, about the skills the role needs. Never mention what is missing from a resume. '
        + 'Never ask about protected personal information.';
    }
  }
  return PROMPT;
}

/** "Under 25 words." */
export const MAX_QUESTION_WORDS = 24;

export const FOLLOW_UP_TEMPLATES = Object.freeze([
  'Could you share a specific example?',
  'What was the outcome?',
  'Which tools or methods did you use?',
  'What would you do differently next time?',
]);
export const FOLLOW_UP_KINDS = Object.freeze(['example', 'outcome', 'tools', 'reflection']);

export const NO_EXPERIENCE_REPLY = 'Thank you for being open. How would you approach learning it?';
export const REPHRASE_REPLY = 'Sorry, I did not quite catch that. Could you please rephrase your answer?';

/* ------------------------------------------------------------------ *
 * the three things a question must never do
 * ------------------------------------------------------------------ */

/** Phrasing that treats a skill as something the candidate lacks. */
const BANNED = [
  /\b(?:i|we)\s+(?:could\s*not|couldn'?t|can\s*not|cannot|can'?t|did\s*not|didn'?t)\s+(?:find|see|spot|locate)\b/i,
  /\b(?:i|we)\s+(?:do\s*not|don'?t)\s+see\b/i,
  /\b(?:your\s+)?(?:resume|résumé|cv|profile|application)\s+(?:does\s*not|doesn'?t|did\s*not|didn'?t|fails\s+to)\s+(?:show|mention|list|include|say|have|contain|demonstrate|reflect)\b/i,
  /\b(?:not|nothing)\s+(?:on|in)\s+(?:your\s+)?(?:resume|résumé|cv|profile)\b/i,
  /\byou\s+(?:did\s*not|didn'?t|have\s*not|haven'?t|never|do\s*not|don'?t)\s+(?:mention|list|include|show|use|used|work|worked|have|had|cite|state|say)\b/i,
  /\b(?:is|are|was|were|isn'?t|aren'?t|wasn'?t|weren'?t)\s+(?:not\s+)?(?:listed|mentioned|shown|found|included|evidenced|visible|present)\s+(?:on|in|anywhere)\b/i,
  /\b(?:it|this|that|which)\s+(?:is|was)\s+not\s+(?:listed|mentioned|shown|found|included|evidenced)\b/i,
  /\bnot\s+(?:found|evidenced|listed)\b/i,
  /\bno\s+(?:mention|evidence|sign|record|trace)\s+of\b/i,
  /\b(?:missing|absent|lacking)\b/i,
  /\byou\s+lack\b|\black\s+of\b/i,
  /\bgaps?\b/i,
  /\bwhy\s+not\b/i,
];

/**
 * Protected personal information. Matched on the PERSONAL framing where a
 * word is also an ordinary job topic ("health" is a nurse's work; "your
 * health" is not a question an interviewer may ask).
 */
const PROTECTED = [
  { topic: 'age', rx: /\bhow\s+old\b|\byour\s+age\b|\bage\s+are\s+you\b|\bdate\s+of\s+birth\b|\bwhen\s+were\s+you\s+born\b|\byear\s+of\s+birth\b|\bborn\s+in\s+(?:which|what)\b/i },
  { topic: 'religion', rx: /\breligio|\bwhich\s+god\b|\bdo\s+you\s+pray\b|\byour\s+faith\b|\bchurch\b|\btemple\b|\bmosque\b|\bgurdwara\b/i },
  { topic: 'caste', rx: /\bcastes?\b|\bsub-?castes?\b|\bjati\b|\bscheduled\s+(?:caste|tribe)\b|\bwhich\s+community\b|\byour\s+community\b/i },
  { topic: 'marital status', rx: /\bmarital\b|\bmarried\b|\bmarriage\b|\bspouse\b|\bhusband\b|\bwife\b|\bboyfriend\b|\bgirlfriend\b|\bpartner'?s?\s+job\b|\b(?:have|any|your)\s+(?:kids|children)\b|\bpregnan|\bplanning\s+(?:a\s+family|to\s+have)\b|\bfamily\s+plans?\b/i },
  { topic: 'health', rx: /\byour\s+(?:health|medical|disabilit|illness|condition|weight|height)\b|\b(?:any|a)\s+(?:medical\s+condition|disabilit|illness|chronic|health\s+(?:issue|problem|condition))|\bare\s+you\s+(?:healthy|disabled|sick|ill)\b|\bdisabilit|\bmedications?\s+(?:do|are)\s+you\b|\bblood\s+group\b/i },
  { topic: 'nationality', rx: /\bnationality\b|\bcitizenship\b|\bare\s+you\s+a\s+citizen\b|\bwhere\s+are\s+you\s+(?:originally\s+)?from\b|\bnative\s+(?:place|country|state)\b|\bethnic|\bwhat\s+race\b|\byour\s+race\b|\bskin\s+colou?r\b|\bmother\s+tongue\b/i },
  { topic: 'gender or sexuality', rx: /\bsexual\s+orientation\b|\byour\s+gender\b|\bare\s+you\s+(?:gay|straight|lesbian|transgender)\b/i },
  { topic: 'politics or union membership', rx: /\bpolitical\s+(?:party|views|affiliation|beliefs)\b|\bwho\s+did\s+you\s+vote\b|\bunion\s+member/i },
];

const words = (s) => String(s || '').trim().split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
export const wordCount = (s) => words(s).length;

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const escRx = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Remove the role's own vocabulary before testing, so a skill that happens
 * to contain a flagged word - "Gap analysis", "Occupational health",
 * "Community management" - is not mistaken for the thing the rule is about.
 */
function withoutAllowed(text, allowed) {
  let out = ` ${text} `;
  for (const term of allowed || []) {
    const t = clean(term);
    if (t.length < 3) continue;
    out = out.replace(new RegExp(`\\b${escRx(t)}\\b`, 'gi'), ' ');
  }
  return out;
}

export function bannedPhrase(text, allowed = []) {
  const t = withoutAllowed(text, allowed);
  const hit = BANNED.find((rx) => rx.test(t));
  return hit ? (t.match(hit) || [''])[0].trim() : null;
}

export function protectedTopic(text, allowed = []) {
  const t = withoutAllowed(text, allowed);
  const hit = PROTECTED.find((p) => p.rx.test(t));
  return hit ? hit.topic : null;
}

/* ------------------------------------------------------------------ *
 * the owner's question shape
 * ------------------------------------------------------------------ */

const upperFirst = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
/* Mid-sentence a skill keeps the casing it was given: "Excel", "SAP" and
   "Tally" are names, and lower-casing them reads (and is spoken) wrongly. */
const midSentence = (s) => String(s);

/**
 * [Why it matters for the role] + [an open invitation to share experience].
 * The first is the owner's own good example, word for word; the others
 * keep its structure so five skill questions in a row do not sound
 * scripted.
 */
const SKILL_TEMPLATES = [
  (s) => `${upperFirst(s)} is a key part of this role. Could you walk me through your experience with it?`,
  (s) => `${upperFirst(s)} matters a great deal in this role. Tell me about a time you used it.`,
  (s) => `This role relies on ${midSentence(s)}. How have you approached it in your work, projects or studies?`,
  (s) => `${upperFirst(s)} is central to this role. Which tools or methods have you used for it?`,
  (s) => `The team depends on ${midSentence(s)} every day. Could you tell me about your experience with it?`,
];

/** A skill, trimmed to something that can be spoken inside a 24-word question. */
export function skillPhrase(skill) {
  let s = clean(skill).replace(/[.;:!?]+$/, '');
  s = s.replace(/^(?:strong|proven|solid|excellent|good|hands[- ]on|demonstrated)\s+/i, '')
    .replace(/^(?:experience|knowledge|expertise|proficiency)\s+(?:with|in|of)\s+/i, '')
    .replace(/^\d+\+?\s*(?:years?|yrs?)\s*(?:of\s*)?/i, '')
    .replace(/^(?:with|in|of|on|using)\s+/i, '');
  const w = words(s);
  return w.length > 6 ? w.slice(0, 6).join(' ') : s;
}

export function skillQuestion(skill, i = 0) {
  const s = skillPhrase(skill);
  if (!s) return null;
  for (let k = 0; k < SKILL_TEMPLATES.length; k++) {
    const q = SKILL_TEMPLATES[(i + k) % SKILL_TEMPLATES.length](s);
    if (wordCount(q) <= MAX_QUESTION_WORDS) return q;
  }
  return null;
}

/**
 * The subject of a gap-phrased question, so it can be asked properly
 * instead: "The role asks for Sourcing, which I could not find..." ->
 * "Sourcing".
 */
const SUBJECT_RX = [
  /(?:asks?\s+for|requires?|calls?\s+for|needs?|requirement\s+for|experience\s+(?:with|in|of)|knowledge\s+of)\s+(?:an?\s+|the\s+)?([^,.;?!]{2,60}?)(?=\s*(?:,|\.|;|\?|!|\s+which\b|\s+but\b|\s+that\b|\s+on\s+your\b|\s+in\s+your\b|$))/i,
  /\b(?:see|find|spot)\s+(?:any\s+)?(?:mention\s+of\s+)?([^,.;?!]{2,40}?)\s+(?:listed|mentioned|shown|on\s+your|in\s+your|anywhere)\b/i,
  /\b(?:show|mention|list|include|contain)s?\s+(?:any\s+)?([^,.;?!]{2,40}?)(?=\s*(?:[,.;?!]|$))/i,
  /\b(?:used|use|worked\s+with)\s+(?:an?\s+|the\s+)?([^,.;?!]{2,40}?)(?=\s*(?:[,.;?!]|$))/i,
];
const PRONOUN = /^(?:it|this|that|them|these|those|one|any|anything|something)$/i;

function subjectOf(text) {
  const t = clean(text);
  for (const rx of SUBJECT_RX) {
    const m = rx.exec(t);
    const s = m ? clean(m[1]) : '';
    if (s && !PRONOUN.test(s) && !/^(?:your|my|our)\b/i.test(s)) return s;
  }
  return null;
}

/**
 * The deterministic post-filter.
 *
 * @param text      the question as generated
 * @param ctx.topic the skill or subject the question was planned around,
 *                  when known - used to rewrite rather than drop
 * @param ctx.allowed the role's own vocabulary (skills, title)
 * @param ctx.index which template to prefer when rewriting
 * @returns { question|null, action: 'kept'|'rewritten'|'blocked', reasons[] }
 */
export function enforceQuestion(text, ctx = {}) {
  const original = clean(text);
  const allowed = ctx.allowed || [];
  const reasons = [];
  if (!original) return { question: null, action: 'blocked', reasons: ['empty'] };

  const prot = protectedTopic(original, allowed);
  if (prot) {
    return { question: null, action: 'blocked', reasons: [`protected topic: ${prot}`] };
  }

  const banned = bannedPhrase(original, allowed);
  const long = wordCount(original) > MAX_QUESTION_WORDS;
  if (!banned && !long) {
    return { question: ensureEnding(original), action: 'kept', reasons };
  }
  if (banned) reasons.push(`gap phrasing: "${banned}"`);
  if (long) reasons.push(`${wordCount(original)} words (limit ${MAX_QUESTION_WORDS})`);

  // 1. Rewrite around the subject into the owner's template.
  const subject = ctx.topic || (banned ? subjectOf(original) : null);
  if (subject && !protectedTopic(subject, allowed) && !bannedPhrase(subject, allowed)) {
    const q = skillQuestion(subject, ctx.index || 0);
    if (q) return { question: q, action: 'rewritten', reasons };
  }

  // 2. Too long but otherwise fine: the closing question sentence on its
  //    own is often the whole question.
  if (!banned) {
    const sentences = original.match(/[^.!?]+[.!?]+/g) || [];
    const ask = sentences.map(clean).reverse()
      .find((s) => /\?$/.test(s) && wordCount(s) <= MAX_QUESTION_WORDS && wordCount(s) >= 5);
    if (ask) return { question: ask, action: 'rewritten', reasons };
  }

  return { question: null, action: 'blocked', reasons };
}

function ensureEnding(q) {
  const t = clean(q);
  return /[.?!]$/.test(t) ? t : `${t}?`;
}

/**
 * Filter a whole plan. Blocked questions are removed; the caller tops the
 * plan back up from questions that already pass.
 *
 * @returns { questions[], report: { kept, rewritten, blocked, details[] } }
 */
export function filterQuestions(list, { allowed = [] } = {}) {
  const report = { kept: 0, rewritten: 0, blocked: 0, details: [] };
  const out = [];
  (list || []).forEach((q, i) => {
    const r = enforceQuestion(q.question, { topic: q.topic, allowed, index: i });
    report[r.action] += 1;
    if (r.action !== 'kept') {
      report.details.push({ action: r.action, reasons: r.reasons, from: clean(q.question).slice(0, 200), to: r.question });
    }
    if (r.question) out.push({ ...q, question: r.question });
  });
  return { questions: out, report };
}

/* ------------------------------------------------------------------ *
 * reading an answer
 * ------------------------------------------------------------------ */

const NO_EXPERIENCE = [
  /\b(?:i\s+)?(?:have|has)(?:n'?t|\s+not)\s+(?:got\s+)?(?:any\s+)?(?:experience|exposure|worked|used|done|tried|had)\b/i,
  /\bi\s+(?:do\s*not|don'?t)\s+have\s+(?:any\s+)?(?:experience|exposure|knowledge|background)\b/i,
  /\b(?:i'?ve|i\s+have)\s+never\s+(?:used|worked|done|tried|had)\b/i,
  /\bnever\s+(?:used|worked\s+(?:with|on|in)|done)\s+(?:it|that|this)\b/i,
  /\bno\s+(?:prior\s+|real\s+|practical\s+|hands[- ]on\s+)?(?:experience|exposure|background)\b/i,
  /\b(?:i'?m|i\s+am)\s+not\s+(?:familiar|experienced)\s+with\b/i,
  /\bnot\s+(?:something\s+)?i'?ve\s+(?:used|done|worked\s+with)\b/i,
];

/** "I have no experience with it" - said plainly, not as a preamble to an example. */
export function isNoExperience(answer) {
  const t = clean(answer);
  if (!t) return false;
  const n = wordCount(t);
  if (n > 30) return false;
  if (NO_EXPERIENCE.some((rx) => rx.test(t))) return true;
  return n <= 8 && /\bi\s+(?:do\s*not|don'?t)\s+know\b/i.test(t);
}

const EXAMPLE_RX = /\b(?:for\s+example|for\s+instance|e\.g\.|such\s+as|one\s+time|a\s+time\s+(?:when|where)|when\s+i|once\s+i|last\s+(?:year|month|week|quarter)|in\s+(?:my|our)\s+(?:last|previous|current|first)|at\s+my\s+(?:last|previous|current)|project|case|situation|instance|recently|patient|client|customer|campaign|incident)\b/i;
const RESULT_RX = /\b(?:result(?:s|ed)?|outcome|achiev\w*|improv\w*|reduc\w*|increas\w*|sav(?:ed|ing)|deliver\w*|complet\w*|led\s+to|so\s+that|which\s+meant|percent|cut|grew|won|resolved|fixed|finished|shipped|launched|hired|closed|recovered)\b|\d+\s*%|\b\d+\b/i;
const TOOL_RX = /\b(?:using|used|tools?|software|system|platform|method|methods|process|framework|spreadsheet|excel|sql|python|java|crm|ats|jira|sap|tally|linkedin|naukri|dashboard|template|checklist|script)\b/i;

/** A capitalised word that does not start a sentence - a product, a tool, an employer. */
function namesSomething(answer) {
  const t = clean(answer);
  return /(?:^|[^.!?]\s)(?!I\b)[A-Z][A-Za-z0-9+#.-]{1,}/.test(t.replace(/^\S+/, ''));
}

/**
 * Is this answer vague enough to deserve the one follow-up, and which?
 *
 * @returns { vague: boolean, kind: 'example'|'outcome'|null, reason }
 */
export function vagueness(answer) {
  const t = clean(answer);
  const n = wordCount(t);
  if (!n) return { vague: false, kind: null, reason: 'silent' };
  if (n < 12) return { vague: true, kind: 'example', reason: 'short' };
  const example = EXAMPLE_RX.test(t);
  const result = RESULT_RX.test(t);
  const tool = TOOL_RX.test(t) || namesSomething(t);
  if (!example && !result && !tool) return { vague: true, kind: 'example', reason: 'no example, tool or result' };
  if (example && !result && !tool && n < 60) return { vague: true, kind: 'outcome', reason: 'no outcome' };
  return { vague: false, kind: null, reason: 'concrete' };
}

export const followUpText = (kind) => {
  if (kind === 'no_experience') return NO_EXPERIENCE_REPLY;
  if (kind === 'rephrase') return REPHRASE_REPLY;
  const i = FOLLOW_UP_KINDS.indexOf(kind);
  return i >= 0 ? FOLLOW_UP_TEMPLATES[i] : null;
};
