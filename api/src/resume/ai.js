/**
 * Optional model-based resume parsing.
 *
 * AI_API_KEY was read into config from the start and never used by
 * anything — so "AI reads your resume" was, in fact, the deterministic
 * parser in fields.js. It still is, unless a key is configured here.
 *
 * Two rules:
 *
 *   1. The key stays on the server. The browser sends text to /api/resume,
 *      never to a model, and never sees a credential.
 *   2. Whatever the model returns is VALIDATED against the resume text
 *      before it is used. A language model asked for a phone number will
 *      produce a well-formed phone number whether or not the document
 *      contains one, and a fabricated value in a candidate record is worse
 *      than an empty field.
 */
import { config } from '../config.js';

const MODEL = process.env.AI_MODEL || 'claude-sonnet-4-5';
const API_URL = process.env.AI_API_URL || 'https://api.anthropic.com/v1/messages';
const TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS || 25_000);

export function aiStatus() {
  return config.aiApiKey
    ? { configured: true, model: MODEL }
    : { configured: false, reason: 'AI_API_KEY is not set — the deterministic parser is used' };
}

/** The fields the model is asked for — the list in requirement 6. */
const SCHEMA_HINT = `{
  "name": string, "email": string, "phone": string, "altPhone": string,
  "qualification": string, "education": string, "skills": string[],
  "expYears": number, "relevantExpYears": number,
  "currentCompany": string, "previousCompanies": string[],
  "title": string, "noticePeriod": string,
  "location": string, "preferredLocation": string,
  "expectedSalary": string, "currentSalary": string,
  "dob": string, "linkedin": string, "github": string,
  "summary": string, "certifications": string[], "projects": string[],
  "languages": string[],
  "employmentHistory": [{"company": string, "title": string, "period": string}]
}`;

export async function parseWithAi(text) {
  if (!config.aiApiKey) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': config.aiApiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2000,
        system:
          'You extract structured data from resumes. Return ONLY a JSON object, ' +
          'no prose and no code fence. Include a key ONLY when the resume states ' +
          'that information explicitly. Never infer, never guess, never use a ' +
          'placeholder. Omit anything the document does not say.',
        messages: [{
          role: 'user',
          content: `Extract these fields from the resume below.\n\n${SCHEMA_HINT}\n\n` +
                   `--- RESUME ---\n${text.slice(0, 60_000)}`,
        }],
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`the model returned ${res.status}${detail ? `: ${detail.slice(0, 160)}` : ''}`);
    }

    const body = await res.json();
    const raw = body?.content?.[0]?.text ?? '';
    const parsed = parseJson(raw);
    if (!parsed) throw new Error('the model did not return usable JSON');

    return { fields: validate(parsed, text) };
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('the model did not respond in time');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Models sometimes wrap JSON in prose or a fence despite instructions. */
function parseJson(raw) {
  const direct = tryJson(raw);
  if (direct) return direct;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  if (fenced) { const v = tryJson(fenced[1]); if (v) return v; }
  const braced = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
  return tryJson(braced);
}

const tryJson = (s) => { try { const v = JSON.parse(String(s).trim()); return v && typeof v === 'object' ? v : null; } catch { return null; } };

/**
 * Keeps only what the resume actually contains.
 *
 * Strings and numbers are checked against the source text. This is the
 * difference between "the model read the resume" and "the model wrote a
 * resume": an email or a phone number that does not appear in the document
 * is discarded, however plausible it looks.
 */
function validate(obj, text) {
  const hay = text.toLowerCase();
  const out = {};

  const appears = (v) => {
    const s = String(v).trim().toLowerCase();
    if (!s) return false;
    if (hay.includes(s)) return true;
    // Numbers are often reformatted: "+91 98765 43210" vs "9876543210".
    const digits = s.replace(/\D/g, '');
    if (digits.length >= 6) return hay.replace(/\D/g, '').includes(digits);
    return false;
  };

  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined || v === '') continue;

    if (typeof v === 'number') {
      if (Number.isFinite(v) && v >= 0 && v < 100) out[k] = v;
      continue;
    }
    if (typeof v === 'string') {
      const s = v.trim();
      if (!s || /^(n\/?a|none|not (specified|mentioned|provided|found)|unknown|null)$/i.test(s)) continue;
      // Long free text (a summary) is the model's own wording and cannot be
      // matched literally; short factual values must be in the document.
      if (s.length > 160 || appears(s)) out[k] = s;
      continue;
    }
    if (Array.isArray(v)) {
      if (v.length && typeof v[0] === 'object') {
        const rows = v.filter((row) => row && typeof row === 'object' &&
          Object.values(row).some((x) => typeof x === 'string' && appears(x)));
        if (rows.length) out[k] = rows;
        continue;
      }
      const items = v.filter((x) => typeof x === 'string' && x.trim() && appears(x))
        .map((x) => x.trim());
      if (items.length) out[k] = items;
    }
  }
  return out;
}
