/**
 * Screening questions: the rules, in one place.
 *
 *   validateQuestionSet()   what a recruiter may save on a job
 *   validateAnswers()       what a candidate (or a recruiter on a call) may
 *                           submit, checked against each question's type
 *                           and options - the browser is never trusted
 *   evaluateKnockout()      did this answer fail a must-have rule?
 *   scoreAnswers()          0-100 from the weighted answers
 *   combineScores()         resume score + answer score, by the admin weight
 *   suggestQuestions()      typed suggestions built from the AI JD
 *                           Generator's own questions (api/src/ai/jd.js)
 *
 * Nothing here talks to the database, so every rule can be tested
 * directly and the routes stay thin.
 *
 * THE CANDIDATE NEVER SEES A RULE. A must-have such as "expected CTC
 * <= 12 LPA" is the job's budget; publicQuestion() strips it, and a
 * knocked-out answer is recorded for the recruiter only.
 */
import { buildWalkinPack, buildInternshipPack } from '../ai/jd.js';

export const TYPES = ['yes_no', 'number', 'single_choice', 'multi_choice', 'short_text', 'date'];
export const STD_KEYS = ['notice_period', 'current_ctc', 'expected_ctc', 'current_location',
  'relocate', 'other_consultancy'];
export const MAX_QUESTIONS = 6;
export const KNOCKOUT_WARN = 2;
export const DEFAULT_ANSWER_WEIGHT = 20;

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (v == null ? '' : String(v)).trim();

/* ------------------------------------------------------------------ *
 * notice period, in days
 * ------------------------------------------------------------------ */

/**
 * "Immediate" -> 0, "30 days" -> 30, "Serving notice" + last working day
 * -> the days until that day (0 when it has passed). null when unknown.
 */
export function noticeDays(answer, now = Date.now()) {
  const value = str(answer && typeof answer === 'object' ? answer.value : answer);
  if (!value) return null;
  if (/^immediate/i.test(value)) return 0;
  if (/serving/i.test(value)) {
    const d = answer && answer.detail ? Date.parse(`${answer.detail}T00:00:00Z`) : NaN;
    if (!Number.isFinite(d)) return null;
    return Math.max(0, Math.ceil((d - now) / 86400000));
  }
  const m = /(\d+)\s*(day|week|month)?/i.exec(value);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] || 'day').toLowerCase();
  return unit.startsWith('month') ? n * 30 : unit.startsWith('week') ? n * 7 : n;
}

/* ------------------------------------------------------------------ *
 * the question set a recruiter saves
 * ------------------------------------------------------------------ */

function cleanOptions(type, options) {
  const o = isObj(options) ? options : {};
  const out = {};
  if (type === 'number') {
    for (const k of ['min', 'max']) {
      if (o[k] !== undefined && o[k] !== null && o[k] !== '') {
        const n = Number(o[k]);
        if (!Number.isFinite(n)) throw new Error(`"${k}" must be a number`);
        out[k] = n;
      }
    }
    if (out.min !== undefined && out.max !== undefined && out.min > out.max) {
      throw new Error('the minimum is above the maximum');
    }
    if (o.unit) out.unit = str(o.unit).slice(0, 20);
  }
  if (type === 'single_choice' || type === 'multi_choice') {
    const choices = (Array.isArray(o.choices) ? o.choices : [])
      .map((c) => str(c).slice(0, 60)).filter(Boolean);
    const uniq = [...new Set(choices)];
    if (uniq.length < 2) throw new Error('a choice question needs at least two choices');
    if (uniq.length > 12) throw new Error('a choice question can have at most 12 choices');
    out.choices = uniq;
  }
  if (type === 'short_text' && o.places) out.places = true;
  if (isObj(o.followUp)) {
    const f = o.followUp;
    const fType = f.type === 'date' ? 'date' : 'short_text';
    out.followUp = { when: str(f.when).slice(0, 60), type: fType, label: str(f.label).slice(0, 60) || 'Details' };
  }
  return out;
}

function cleanRule(type, rule) {
  if (!isObj(rule)) return null;
  const out = {};
  if (rule.equals !== undefined) out.equals = typeof rule.equals === 'string' ? rule.equals.toLowerCase() : rule.equals;
  if (rule.notEquals !== undefined) out.notEquals = typeof rule.notEquals === 'string' ? rule.notEquals.toLowerCase() : rule.notEquals;
  for (const k of ['min', 'max', 'maxDays']) {
    if (rule[k] !== undefined && rule[k] !== null && rule[k] !== '') {
      const n = Number(rule[k]);
      if (!Number.isFinite(n)) throw new Error(`the must-have rule "${k}" must be a number`);
      out[k] = n;
    }
  }
  if (Array.isArray(rule.in)) out.in = rule.in.map((v) => str(v)).filter(Boolean).slice(0, 12);
  if (!Object.keys(out).length) return null;
  if (type === 'yes_no' && out.equals !== undefined && !['yes', 'no'].includes(out.equals)) {
    throw new Error('a yes/no must-have is "yes" or "no"');
  }
  return out;
}

/**
 * Words that would tell a candidate who the client is. The company's
 * name, and its significant single words ("Zephyrine Quantum Foods" ->
 * "Zephyrine", "Quantum"), so a question cannot leak it by halves.
 */
export function companyTokens(companyName) {
  const name = str(companyName);
  if (!name) return [];
  const STOP = new Set(['the', 'and', 'pvt', 'ltd', 'private', 'limited', 'llp', 'inc', 'co', 'company',
    'india', 'solutions', 'services', 'technologies', 'technology', 'tech', 'group', 'global',
    'consultants', 'consulting', 'systems', 'software', 'labs', 'foods', 'industries', 'enterprises',
    'international', 'corporation', 'corp', 'hospital', 'hospitals', 'bank', 'finance', 'healthcare',
    'health', 'care', 'logistics', 'infotech', 'info', 'digital', 'network', 'networks', 'teamlink']);
  const words = name.toLowerCase().split(/[^a-z0-9]+/i).filter((w) => w.length >= 4 && !STOP.has(w));
  return [name.toLowerCase(), ...new Set(words)];
}

export function mentionsCompany(text, companyName) {
  const t = str(text).toLowerCase();
  if (!t) return false;
  return companyTokens(companyName).some((w) => {
    if (w.includes(' ')) return t.includes(w);
    return new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i').test(t);
  });
}

/**
 * @param list         [{id?, stdKey?, text, type, options, isKnockout, knockoutRule, weight, source, shareWithClient}]
 * @param companyName  the client's name: a question that contains it is refused
 * @returns {{ questions, warnings }}  throws Error(message, {details}) on a bad set
 */
export function validateQuestionSet(list, { companyName = '' } = {}) {
  if (!Array.isArray(list)) throw Object.assign(new Error('Send a list of questions.'), { details: {} });
  const details = {};
  if (list.length > MAX_QUESTIONS) {
    throw Object.assign(new Error(`A job can have at most ${MAX_QUESTIONS} screening questions. `
      + 'Too many questions lowers applications.'), { details: { questions: `Keep ${MAX_QUESTIONS} or fewer.` } });
  }
  const seenStd = new Set();
  const out = list.map((raw, i) => {
    const q = isObj(raw) ? raw : {};
    const at = `questions.${i}`;
    try {
      const text = str(q.text);
      if (!text) throw new Error('the question text is empty');
      if (text.length > 200) throw new Error('keep the question under 200 characters');
      if (mentionsCompany(text, companyName)) {
        throw new Error('candidates see this question: do not name the company (say "the company" or "this role")');
      }
      if (/\bclient\b/i.test(text)) throw new Error('candidates see this question: do not use the word "client"');
      const type = str(q.type);
      if (!TYPES.includes(type)) throw new Error(`"${type}" is not a question type`);
      const stdKey = q.stdKey ? str(q.stdKey) : null;
      if (stdKey && !STD_KEYS.includes(stdKey)) throw new Error(`"${stdKey}" is not a standard question`);
      if (stdKey) {
        if (seenStd.has(stdKey)) throw new Error('that standard question is already in the list');
        seenStd.add(stdKey);
      }
      const options = cleanOptions(type, q.options);
      const isKnockout = !!q.isKnockout;
      const knockoutRule = isKnockout ? cleanRule(type, q.knockoutRule) : null;
      if (isKnockout && !knockoutRule) throw new Error('a must-have question needs a rule');
      const weight = q.weight === undefined || q.weight === null || q.weight === '' ? 5 : Number(q.weight);
      if (!Number.isInteger(weight) || weight < 0 || weight > 10) throw new Error('the weight is a whole number from 0 to 10');
      const source = ['standard', 'ai', 'recruiter'].includes(q.source) ? q.source : (stdKey ? 'standard' : 'recruiter');
      return {
        id: q.id ? str(q.id).slice(0, 64) : null,
        stdKey, text, type, options, isKnockout, knockoutRule, weight, source,
        shareWithClient: q.shareWithClient === undefined ? stdKey !== 'other_consultancy' : !!q.shareWithClient,
        position: i,
      };
    } catch (err) {
      details[at] = err.message;
      return null;
    }
  });
  if (Object.keys(details).length) {
    throw Object.assign(new Error('Please check the screening questions.'), { details });
  }
  const warnings = [];
  const ko = out.filter((q) => q.isKnockout).length;
  if (ko > KNOCKOUT_WARN) warnings.push(`${ko} must-have questions: more than ${KNOCKOUT_WARN} knock-outs lowers applications.`);
  if (out.length === MAX_QUESTIONS) warnings.push('This job has the maximum of 6 questions. Too many questions lowers applications.');
  return { questions: out, warnings };
}

/* ------------------------------------------------------------------ *
 * answers
 * ------------------------------------------------------------------ */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s) => DATE_RE.test(s) && Number.isFinite(Date.parse(`${s}T00:00:00Z`))
  && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

/** One answer, normalised to {value, detail?}; throws a sentence on a bad one. */
export function normaliseAnswer(q, raw) {
  const given = isObj(raw) && 'value' in raw ? raw : { value: raw };
  let value = given.value;
  const o = q.options || {};
  switch (q.type) {
    case 'yes_no': {
      if (value === true) value = 'yes';
      if (value === false) value = 'no';
      value = str(value).toLowerCase();
      if (!['yes', 'no'].includes(value)) throw new Error('answer yes or no');
      break;
    }
    case 'number': {
      if (value === '' || value === null || value === undefined) throw new Error('enter a number');
      const n = Number(String(value).replace(/,/g, ''));
      if (!Number.isFinite(n)) throw new Error('enter a number');
      if (o.min !== undefined && n < o.min) throw new Error(`enter ${o.min} or more`);
      if (o.max !== undefined && n > o.max) throw new Error(`enter ${o.max} or less`);
      value = Math.round(n * 100) / 100;
      break;
    }
    case 'single_choice': {
      value = str(value);
      const hit = (o.choices || []).find((c) => c.toLowerCase() === value.toLowerCase());
      if (!hit) throw new Error('choose one of the options');
      value = hit;
      break;
    }
    case 'multi_choice': {
      const arr = Array.isArray(value) ? value : (value == null || value === '' ? [] : [value]);
      const picked = [];
      for (const v of arr) {
        const hit = (o.choices || []).find((c) => c.toLowerCase() === str(v).toLowerCase());
        if (!hit) throw new Error('choose from the options');
        if (!picked.includes(hit)) picked.push(hit);
      }
      if (!picked.length) throw new Error('choose at least one option');
      value = picked;
      break;
    }
    case 'short_text': {
      value = str(value);
      if (!value) throw new Error('this answer is required');
      if (value.length > 200) throw new Error('keep it under 200 characters');
      break;
    }
    case 'date': {
      value = str(value);
      if (!validDate(value)) throw new Error('enter a date');
      break;
    }
    default:
      throw new Error('unknown question type');
  }
  const out = { value };
  const f = o.followUp;
  if (f && str(value).toLowerCase() === str(f.when).toLowerCase()) {
    const d = str(given.detail);
    if (f.type === 'date') {
      if (!validDate(d)) throw new Error(`${f.label || 'the date'} is required`);
      out.detail = d;
    } else if (d) {
      if (d.length > 120) throw new Error(`keep "${f.label}" under 120 characters`);
      out.detail = d;
    }
  }
  return out;
}

/**
 * Check a whole submission against a job's questions. Every question must
 * be answered; an answer to a question the job does not have is refused
 * (a stale page), so nothing half-matching is stored.
 *
 * @returns [{question, answer}] in question order
 */
export function validateAnswers(questions, answers) {
  const details = {};
  const byId = new Map();
  for (const a of Array.isArray(answers) ? answers : []) {
    if (!a || !a.questionId) continue;
    byId.set(String(a.questionId), a.answer);
  }
  for (const id of byId.keys()) {
    if (!questions.some((q) => q.id === id)) {
      details[`answers.${id}`] = 'This question is no longer asked. Refresh and try again.';
    }
  }
  const out = [];
  for (const q of questions) {
    if (!byId.has(q.id)) { details[`answers.${q.id}`] = 'This answer is required.'; continue; }
    try { out.push({ question: q, answer: normaliseAnswer(q, byId.get(q.id)) }); }
    catch (err) { details[`answers.${q.id}`] = err.message.charAt(0).toUpperCase() + err.message.slice(1) + '.'; }
  }
  if (Object.keys(details).length) {
    throw Object.assign(new Error('Please answer the screening questions.'), { details });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * must-have rules
 * ------------------------------------------------------------------ */

/** true when the answer FAILS the question's must-have rule. */
export function evaluateKnockout(q, answer, now = Date.now()) {
  if (!q.isKnockout || !q.knockoutRule) return false;
  const r = q.knockoutRule;
  const v = answer ? answer.value : undefined;
  const low = (x) => (typeof x === 'string' ? x.toLowerCase() : x);

  // A notice period is compared in days, however it was asked.
  if (q.stdKey === 'notice_period' || r.maxDays !== undefined) {
    const limit = r.maxDays !== undefined ? r.maxDays : r.max;
    if (limit !== undefined) {
      const days = noticeDays(answer, now);
      if (days === null || days > limit) return true;
    }
  }
  if (r.equals !== undefined && low(v) !== low(r.equals)) return true;
  if (r.notEquals !== undefined && low(v) === low(r.notEquals)) return true;
  if (q.type === 'number') {
    const n = Number(v);
    if (r.min !== undefined && !(n >= r.min)) return true;
    if (r.max !== undefined && !(n <= r.max)) return true;
  }
  if (Array.isArray(r.in) && r.in.length) {
    const allowed = r.in.map((x) => String(x).toLowerCase());
    if (Array.isArray(v)) {
      if (!v.some((x) => allowed.includes(String(x).toLowerCase()))) return true;
    } else if (!allowed.includes(String(v).toLowerCase())) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * scoring
 * ------------------------------------------------------------------ */

/**
 * How well one answer fits, 0..1, or null when the answer cannot be
 * judged (a current CTC, a location, free text) - those are left out of
 * the average rather than counted as a zero or a pass.
 */
export function answerFit(q, answer, job = {}, now = Date.now()) {
  if (q.isKnockout && q.knockoutRule) return evaluateKnockout(q, answer, now) ? 0 : 1;
  const v = answer ? answer.value : undefined;
  switch (q.stdKey) {
    case 'notice_period': {
      const d = noticeDays(answer, now);
      if (d === null) return null;
      return d === 0 ? 1 : d <= 15 ? 0.9 : d <= 30 ? 0.75 : d <= 60 ? 0.45 : d <= 90 ? 0.25 : 0.1;
    }
    case 'expected_ctc': {
      const max = Number(job.salaryMax ?? job.salary_max);
      const n = Number(v);
      if (!Number.isFinite(max) || max <= 0 || !Number.isFinite(n)) return null;
      return n <= max ? 1 : n <= max * 1.15 ? 0.6 : 0.2;
    }
    case 'relocate': return v === 'yes' ? 1 : 0;
    case 'current_ctc':
    case 'current_location':
    case 'other_consultancy':
      return null;
    default:
      if (q.type === 'yes_no') return v === 'yes' ? 1 : 0;
      return null;
  }
}

/**
 * @param items [{question, answer}]
 * @returns {{ score:number|null, knockedOut:boolean, failed:[questionText] }}
 */
export function scoreAnswers(items, job = {}, now = Date.now()) {
  let total = 0; let weight = 0;
  const failed = [];
  for (const { question: q, answer } of items) {
    if (evaluateKnockout(q, answer, now)) failed.push(q.text);
    const fit = answerFit(q, answer, job, now);
    const w = Number(q.weight) || 0;
    if (fit === null || w <= 0) continue;
    total += fit * w; weight += w;
  }
  return {
    score: weight ? Math.round((total / weight) * 100) : null,
    knockedOut: failed.length > 0,
    failed,
  };
}

/**
 * Resume score and answer score, by the admin's "screening answers"
 * weight (default 20): the existing weights scale to fill the rest, which
 * is the same thing as scaling the resume score.
 */
export function combineScores(resumeScore, answerScore, weight = DEFAULT_ANSWER_WEIGHT) {
  const r = Number(resumeScore);
  if (!Number.isFinite(r)) return null;
  if (answerScore === null || answerScore === undefined || !Number.isFinite(Number(answerScore))) return Math.round(r);
  const w = Math.max(0, Math.min(100, Number(weight)));
  return Math.round(r * (100 - w) / 100 + Number(answerScore) * w / 100);
}

/* ------------------------------------------------------------------ *
 * shapes
 * ------------------------------------------------------------------ */

export function fromRow(r) {
  return {
    id: r.id,
    jobId: r.job_id,
    position: r.position,
    stdKey: r.std_key || null,
    text: r.text,
    type: r.type,
    options: r.options || {},
    isKnockout: !!r.is_knockout,
    knockoutRule: r.knockout_rule || null,
    weight: r.weight == null ? 5 : Number(r.weight),
    source: r.source,
    shareWithClient: r.share_with_client !== false,
  };
}

/** What a candidate may see of a question: no rule, no weight. */
export function publicQuestion(q) {
  return {
    id: q.id, position: q.position, stdKey: q.stdKey || q.std_key || null,
    text: q.text, type: q.type, options: q.options || {},
  };
}

/** An answer as a person reads it. */
export function answerText(answer, type) {
  if (!answer) return '';
  const v = answer.value;
  let s = Array.isArray(v) ? v.join(', ') : v === 'yes' ? 'Yes' : v === 'no' ? 'No' : String(v ?? '');
  if (answer.detail) s += ` (${answer.detail})`;
  if (type === 'number' && answer.unit) s += ` ${answer.unit}`;
  return s;
}

/* ------------------------------------------------------------------ *
 * pre-fill
 * ------------------------------------------------------------------ */

const NOTICE_CHOICES = ['Immediate', '15 days', '30 days', '60 days', '90 days'];

/** Profile notice text -> one of the standard choices, when it maps cleanly. */
function noticeChoice(text) {
  const t = str(text);
  if (!t) return null;
  if (/immediate|^0\b/i.test(t)) return 'Immediate';
  if (/serving/i.test(t)) return 'Serving notice';
  const d = noticeDays(t);
  if (d === null) return null;
  const hit = NOTICE_CHOICES.find((c) => noticeDays(c) === d);
  return hit || null;
}

/**
 * What to fill in before the candidate starts: their saved answers from
 * last time (only saved with their consent), else their profile.
 */
export function prefillFor(questions, { defaults = null, candidate = null } = {}) {
  const d = defaults || {};
  const c = candidate || {};
  const out = {};
  for (const q of questions) {
    const k = q.stdKey;
    let a;
    if (k === 'notice_period') {
      const v = d.notice_period || noticeChoice(c.noticePeriod);
      if (v && (q.options.choices || []).includes(v)) {
        a = { value: v };
        if (v === 'Serving notice' && d.last_working_day) a.detail = String(d.last_working_day).slice(0, 10);
      }
    } else if (k === 'current_ctc') {
      const n = d.current_ctc != null ? Number(d.current_ctc) : Number(String(c.ctc || '').replace(/[^\d.]/g, ''));
      if (Number.isFinite(n) && n > 0) a = { value: n };
    } else if (k === 'expected_ctc') {
      const n = d.expected_ctc != null ? Number(d.expected_ctc) : Number(c.expectedCtc);
      if (Number.isFinite(n) && n > 0) a = { value: n };
    } else if (k === 'current_location') {
      const v = d.current_location || c.location;
      if (v) a = { value: String(v) };
    } else if (k === 'relocate') {
      if (d.willing_to_relocate === true) a = { value: 'yes' };
      else if (d.willing_to_relocate === false) a = { value: 'no' };
    }
    if (a) out[q.id] = a;
  }
  return out;
}

/** The standard answers, back into candidate_screening_defaults' shape. */
export function defaultsFromAnswers(items) {
  const out = {};
  for (const { question: q, answer } of items) {
    if (q.stdKey === 'notice_period') {
      out.notice_period = answer.value;
      out.last_working_day = answer.detail || null;
    }
    if (q.stdKey === 'current_ctc') out.current_ctc = answer.value;
    if (q.stdKey === 'expected_ctc') out.expected_ctc = answer.value;
    if (q.stdKey === 'current_location') out.current_location = answer.value;
    if (q.stdKey === 'relocate') out.willing_to_relocate = answer.value === 'yes';
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * suggestions, from the AI JD Generator
 * ------------------------------------------------------------------ */

/**
 * The JD generator already drafts screening questions - as plain text
 * inside the description, where nobody answers them. These are the same
 * questions, typed so a candidate can answer them and a recruiter can set
 * a rule on them. Questions the standard set already asks (notice period,
 * "can you work in <city>") are left out.
 */
export function suggestQuestions(job = {}) {
  const skills = (Array.isArray(job.skills) ? job.skills : String(job.skills || '').split(','))
    .map((s) => str(s)).filter(Boolean);
  const kind = String(job.postingKind || job.kind || job.type || '').toLowerCase();
  let texts;
  if (kind.includes('intern')) {
    texts = buildInternshipPack({ title: job.title, location: job.location, duration: job.duration, skills }).questions;
  } else {
    // The walk-in pack is the generator's general-purpose question writer;
    // for a vacancy it asks the same things about hands-on experience.
    texts = buildWalkinPack({ title: job.title, location: job.location, skills }).questions;
  }
  const out = [];
  for (const t of texts || []) {
    let m;
    if (/notice period|when can you join/i.test(t) || /able to work in/i.test(t)) continue;
    if ((m = /hands-on experience do you have with (.+)\?$/i.exec(t))) {
      out.push({ text: `Years of hands-on ${m[1]} experience?`, type: 'number',
        options: { min: 0, max: 50, unit: 'years' }, weight: 5, source: 'ai' });
    } else if (/available for the full/i.test(t)) {
      out.push({ text: t, type: 'yes_no', options: {}, weight: 5, source: 'ai' });
    } else if (/when can you start/i.test(t)) {
      out.push({ text: 'Earliest date you can start?', type: 'date', options: {}, weight: 0, source: 'ai' });
    } else {
      out.push({ text: t.slice(0, 200), type: 'short_text', options: {}, weight: 0, source: 'ai' });
    }
  }
  // Certifications are a common yes/no a recruiter adds by hand.
  if (skills.length) {
    out.push({ text: `Do you hold a certification in ${skills[0]}?`, type: 'yes_no', options: {}, weight: 3, source: 'ai' });
  }
  return out.slice(0, 6);
}
