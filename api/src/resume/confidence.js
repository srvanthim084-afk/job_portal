/**
 * How sure we are of each field read from a resume (0117).
 *
 * The parser and the model each read the resume; parseResume() in
 * routes/resume.js merges them and keeps one overall number. Registration
 * needs more than that: a field the reading is unsure of must not be put
 * on the profile silently - the candidate confirms it first - and a field
 * it is sure of must not be asked again.
 *
 * WHAT MAKES A FIELD CERTAIN. Not the model's own say-so (a model asked
 * how sure it is will say "very"), but evidence:
 *
 *   - both readers found it and agree                   0.95
 *   - the parser found it by a pattern that cannot misfire
 *     (an email, a URL, a phone number)                  0.9-0.95
 *   - one reader found it                               per field, below
 *   - the two readers disagree                          0.5
 *   - a GUESS (the name derived from an email address)  0.4
 *
 * Text read from a scanned page by the model (parser 'ai-ocr') is less
 * certain throughout: every value is scaled by 0.85.
 *
 * The threshold is REGISTRATION_CONFIDENCE_MIN (default 0.7). Below it a
 * field is listed in needsVerification and is NOT written to the profile
 * unless the candidate confirms or corrects it.
 */
import { extractFields, parseConfidence } from './fields.js';
import { parseWithAi } from './ai.js';

export const confidenceMin = () => {
  const v = Number(process.env.REGISTRATION_CONFIDENCE_MIN);
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : 0.7;
};

/* One reader only: how far a single reading of this field is trusted. */
const SINGLE = {
  email: 0.95, linkedin: 0.95, github: 0.95, portfolio: 0.9,
  phone: 0.9, altPhone: 0.85,
  name: 0.8, skills: 0.85, educationRecords: 0.8, education: 0.85, qualification: 0.85,
  certifications: 0.8, languages: 0.8, projects: 0.8, achievements: 0.75, internships: 0.75,
  employmentHistory: 0.8, previousCompanies: 0.75, expYears: 0.8, relevantExpYears: 0.75,
  title: 0.75, currentCompany: 0.75, summary: 0.85, highestEducation: 0.85,
  dob: 0.75,
  // read from prose by a pattern; the candidate states these at registration anyway
  location: 0.6, preferredLocation: 0.5, noticePeriod: 0.5,
  currentSalary: 0.55, expectedSalary: 0.5,
};

/*
 * The fields the candidate states at registration themselves. The resume's
 * version is offered as a starting value, never written on its own.
 */
export const CANDIDATE_STATES = ['location', 'preferredLocation', 'noticePeriod', 'expectedSalary'];

/* Asked about when unsure. Lists and long text are shown, not interrogated. */
export const VERIFY_KEYS = ['name', 'email', 'phone', 'altPhone', 'title', 'currentCompany',
  'expYears', 'relevantExpYears', 'qualification', 'dob', 'currentSalary'];

const norm = (v) => JSON.stringify(Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x.toLowerCase().trim() : x)).sort()
  : typeof v === 'string' ? v.toLowerCase().replace(/\s+/g, ' ').trim() : v);

const agree = (a, b) => {
  if (a === undefined || b === undefined) return false;
  if (typeof a === 'string' && typeof b === 'string') {
    const x = a.toLowerCase().replace(/[^a-z0-9@.+]/g, '');
    const y = b.toLowerCase().replace(/[^a-z0-9@.+]/g, '');
    if (/^\+?\d[\d\s-]{8,}$/.test(a) || /^\+?\d[\d\s-]{8,}$/.test(b)) {
      return a.replace(/\D/g, '').slice(-10) === b.replace(/\D/g, '').slice(-10);
    }
    return x === y || (x.length > 4 && (x.includes(y) || y.includes(x)));
  }
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
  if (Array.isArray(a) && Array.isArray(b)) {
    const A = new Set(a.map((s) => String(typeof s === 'object' ? JSON.stringify(s) : s).toLowerCase()));
    const overlap = b.filter((s) => A.has(String(typeof s === 'object' ? JSON.stringify(s) : s).toLowerCase())).length;
    return overlap >= Math.min(a.length, b.length) / 2;
  }
  return norm(a) === norm(b);
};

/**
 * Per-field confidence for the merged reading.
 * local / ai: the two readers' fields (ai may be null).
 */
export function fieldConfidence({ local = {}, ai = null, merged = {}, parser = '' }) {
  const conf = {};
  const scale = parser === 'ai-ocr' ? 0.85 : 1;
  for (const k of Object.keys(merged)) {
    if (k === 'nameSuggestion') continue;
    const inLocal = local[k] !== undefined;
    const inAi = !!ai && ai[k] !== undefined;
    let c;
    if (inLocal && inAi) c = agree(local[k], ai[k]) ? 0.95 : 0.5;
    else c = SINGLE[k] !== undefined ? SINGLE[k] : 0.75;
    conf[k] = Math.round(c * scale * 100) / 100;
  }
  // A name that is only a guess from the email address.
  if (merged.name === undefined && merged.nameSuggestion) conf.name = 0.4;
  return conf;
}

/**
 * Reads a resume's text with both readers and says how sure it is of
 * each field. Never throws for an AI failure: the parser's reading still
 * stands, and aiError says why the model did not contribute.
 */
export async function analyseResume(text, { parser = '', aiTimeoutMs } = {}) {
  const local = extractFields(text);
  let ai = null; let aiError = null;
  const limit = Number(aiTimeoutMs || process.env.REGISTRATION_AI_TIMEOUT_MS || 30000);
  try {
    const out = await Promise.race([
      parseWithAi(text),
      new Promise((_, reject) => setTimeout(() => reject(new Error('the model did not respond in time')), limit)),
    ]);
    ai = out && out.fields && Object.keys(out.fields).length ? out.fields : null;
  } catch (err) {
    aiError = err && err.message ? String(err.message).slice(0, 300) : 'the model failed';
  }

  const merged = ai ? { ...local.fields, ...ai } : { ...local.fields };
  if (merged.name && merged.nameSuggestion) delete merged.nameSuggestion;
  const confidence = fieldConfidence({ local: local.fields, ai, merged, parser });
  const min = confidenceMin();

  const needsVerification = VERIFY_KEYS.filter((k) =>
    (merged[k] !== undefined || (k === 'name' && merged.nameSuggestion)) && (confidence[k] ?? 1) < min);
  /* The dates could not say which job is the latest: the candidate is asked to check the role and the employer. */
  const notes = local.notes || {};
  if (notes.recentEmploymentUncertain) {
    for (const k of ['title', 'currentCompany']) if (merged[k] !== undefined && !needsVerification.includes(k)) needsVerification.push(k);
  }

  return {
    fields: merged,
    confidence,
    needsVerification,
    notes,
    source: ai ? 'ai' : 'parser',
    aiError,
    found: Object.keys(merged).length,
    overall: parseConfidence({ fields: merged, chars: String(text || '').length }),
  };
}

/**
 * What goes onto the profile: fields the reading is sure of, plus every
 * field the candidate confirmed or corrected. A correction of '' removes
 * the value - the candidate said the resume was wrong and gave nothing.
 */
export function acceptedFields(extraction, corrections = {}) {
  const fields = (extraction && extraction.fields) || {};
  const conf = (extraction && extraction.confidence) || {};
  const min = confidenceMin();
  const out = {}; const sources = {};
  for (const [k, v] of Object.entries(fields)) {
    if (k === 'nameSuggestion' || CANDIDATE_STATES.includes(k)) continue;
    if ((conf[k] ?? 1) >= min) { out[k] = v; sources[k] = 'EXTRACTED'; }
  }
  for (const [k, v] of Object.entries(corrections || {})) {
    if (CANDIDATE_STATES.includes(k)) continue;
    if (v === '' || v === null) { delete out[k]; delete sources[k]; continue; }
    const same = fields[k] !== undefined && agree(fields[k], v);
    out[k] = v;
    sources[k] = same ? 'EXTRACTED' : 'USER_PROVIDED';
  }
  return { fields: out, sources };
}
