/**
 * Voice search, the meaning layer: a spoken query (Telugu, Hindi, English
 * or a mix) -> a normalized SEARCH OBJECT -> open jobs ranked by relevance.
 *
 * WHY. A candidate said "కన్సల్టెంట్ టెక్నాలజీకి సంబంధించిన ఉద్యోగాలు
 * కావాలి, ప్రస్తుతం హైదరాబాద్‌లో ఉన్నాను" and the board was searched for
 * that Telugu sentence - "No jobs for <Telugu text>". The words that were
 * said are kept (originalQuery) but are NEVER the search key. What is
 * searched is what they mean: { role: consultant, industry: technology,
 * location: Hyderabad }.
 *
 *   detectLanguage()   TELUGU / HINDI / ENGLISH / MIXED / OTHER
 *   extractConcepts()  the dictionary's concepts (job-vocabulary.js) out of
 *                      the words: English words directly, English loanwords
 *                      written in Telugu / Devanagari by sound (కన్సల్టెంట్
 *                      -> consultant, టెక్నాలజీకి -> technology), pure Telugu /
 *                      Hindi words through the dictionary; filler dropped
 *   buildSearch()      the search object (role[], skills[], technologies[],
 *                      location[], ..., normalizedQuery, searchMode)
 *   rankJobs()         every open job scored 0-100 (title, skills,
 *                      description, location, experience, profile), with
 *                      progressive relaxation L1 .. L6 so a valid intent
 *                      never jumps straight to "No jobs"
 *   voiceMatches()     the same rules for a saved voice search's alerts
 *
 * Deterministic; the AI engine (voice-parse.js) only feeds the same
 * concept extraction with its English reading of the sentence.
 */
import { transliterate, hasIndicScript, placeKey, skeleton, vowelDistance } from './indic-translit.js';
import { CONCEPTS, CONCEPT_BY_ID, NATIVE_FILLER, LATIN_FILLER } from './job-vocabulary.js';
import { FILLER } from './voice-words.js';

const NFC = (v) => String(v || '').normalize('NFC');

/* ------------------------------------------------------------------ *
 * language
 * ------------------------------------------------------------------ */

const ROMANISED = /\b(kavalii|unna|kavali|kaavali|kavalandi|lo|unnaya|unnayi|unnanu|undi|ki|ku|kosam|naaku|naku|chahiye|chaahiye|mein|mujhe|naukri|hai|hain|ka|ke|ko)\b/i;

/** TELUGU / HINDI / ENGLISH / MIXED / OTHER. Romanised Telugu or Hindi mixed with English is MIXED. */
export function detectLanguage(text) {
  const s = NFC(text);
  const te = (s.match(/[\u0c00-\u0c7f]/g) || []).length;
  const hi = (s.match(/[\u0900-\u097f]/g) || []).length;
  const la = (s.match(/[a-z]/gi) || []).length;
  if (!te && !hi) {
    if (!la) return 'OTHER';
    return ROMANISED.test(s) ? 'MIXED' : 'ENGLISH';
  }
  if (la >= 2 || (te && hi)) return 'MIXED';
  return te >= hi ? 'TELUGU' : 'HINDI';
}

/* ------------------------------------------------------------------ *
 * the vocabulary, indexed
 * ------------------------------------------------------------------ */

/** Lower case, words only ("react.js" -> "react js", "C#" -> "c#"). */
export const normText = (v) => ` ${NFC(v).toLowerCase().replace(/[^a-z0-9+#\u0900-\u097f\u0c00-\u0c7f\u200c\u200d]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
const hasPhrase = (hay, p) => hay.includes(` ${p} `);

/* "technology" and టెక్నాలజీ: a soft g is a j to the ear, and the ch of
   "tech" / "technology" / "chrome" is a k. */
const soundKey = (latin) => placeKey(String(latin || '').toLowerCase()
  .replace(/ch(?=[nrlst])/g, 'k').replace(/ch$/, 'k').replace(/g(?=[eiy])/g, 'j'));

let VOCAB = null;
function vocab() {
  if (VOCAB) return VOCAB;
  const phrase = new Map();          // normalized phrase -> [{ id, strength }]
  const native = new Map();          // native-script word / phrase -> id
  const bySkel = new Map();          // sound skeleton -> [{ key, id }]
  const add = (p, id, strength) => {
    const k = normText(p).trim();
    if (!k) return;
    const l = phrase.get(k) || [];
    if (!l.some((x) => x.id === id)) l.push({ id, strength });
    phrase.set(k, l);
  };
  for (const c of CONCEPTS) {
    c.terms.forEach((t) => add(t, c.id, 1));
    c.expand.forEach((t) => add(t, c.id, 0.8));
    c.native.forEach((w) => native.set(NFC(w).toLowerCase(), c.id));
    /* single English words of the concept itself, for loanwords said in another script */
    for (const t of c.terms) {
      if (/\s/.test(t) || t.length < 3) continue;
      const key = soundKey(t);
      if (key.length < 3) continue;
      const sk = skeleton(key);
      if (sk.length < 2) continue;
      const l = bySkel.get(sk) || [];
      l.push({ key, id: c.id, skel: sk });
      bySkel.set(sk, l);
    }
  }
  /* best strength first, terms before expansions */
  for (const l of phrase.values()) l.sort((a, b) => b.strength - a.strength);
  VOCAB = { phrase, native, bySkel, longest: Math.max(...[...phrase.keys()].map((k) => k.split(' ').length)) };
  return VOCAB;
}

const FILLER_SET = new Set([...FILLER, ...NATIVE_FILLER, ...LATIN_FILLER].map((w) => NFC(w).toLowerCase()));

/* Telugu case endings joined to a word: హైదరాబాద్‌లో, టెక్నాలజీకి, కంపెనీలో. */
const NATIVE_SUFFIXES = ['లోని', 'లోనే', 'లో', 'కి', 'కు', 'ని', 'ను', 'తో', 'గా', 'కోసం', 'నుంచి', 'నుండి', 'లకు', 'లు', 'వాళ్ళకి'];
const LATIN_SUFFIXES = ['loni', 'lone', 'lo', 'ki', 'ku', 'ni', 'nu', 'to', 'tho', 'ga', 'kosam', 'nunchi', 'nundi', 'laku', 'lu'];

/** The stems a native-script word could be, the word itself first. */
export function nativeStems(word) {
  const w = NFC(word).replace(/[\u200c\u200d]+$/, '');
  const out = [w];
  for (const s of NATIVE_SUFFIXES) {
    if (w.endsWith(s) && w.length - s.length >= 2) out.push(w.slice(0, -s.length).replace(/[\u200c\u200d]+$/, ''));
  }
  return [...new Set(out)];
}

/* The vocabulary is a few hundred words, all needing the same consonants
   in the same order, so a long loanword may differ more in its vowels
   than a place name may ("devalpar" / developer). */
function tolerance(len, sk) {
  if (sk.length <= 2 || len <= 4) return 0;
  if (len <= 6) return 1;
  return 1.5;
}

/**
 * A word said in Telugu / Devanagari script, matched by sound to an
 * English word: the dictionary's own words first, then the words that
 * appear in the open jobs' titles and skills (boardWords: a sound index
 * built by boardWordIndex). Returns { id } | { keyword } | null.
 */
function soundConcept(word, boardWords) {
  const v = vocab();
  const stems = nativeStems(word);
  let best = null;
  stems.forEach((stem, n) => {
    for (const latin of [transliterate(stem), transliterate(stem, { flap: 'd' })]) {
      const k = soundKey(latin);
      if (k.length < 3) continue;
      const sk = skeleton(k);
      const cost = n === 0 ? 0 : 0.25;
      const consider = (list, make) => {
        for (const e of list || []) {
          let d = cost + (k === e.key ? 0 : vowelDistance(k, e.key));
          if (k[0] !== e.key[0]) d += 0.5;
          if (d <= tolerance(Math.min(k.length, e.key.length), sk) && (!best || d < best.d)) best = { d, ...make(e) };
        }
      };
      consider(v.bySkel.get(sk), (e) => ({ id: e.id }));
      if (boardWords) consider(boardWords.get(sk), (e) => ({ keyword: e.word }));
    }
  });
  return best;
}

/** The words of the open jobs' titles and skills, by sound - so a loanword for any job on the board is understood. */
export function boardWordIndex(jobs) {
  const bySkel = new Map();
  const seen = new Set();
  for (const j of jobs || []) {
    const words = normText([j.title, ...(Array.isArray(j.skills) ? j.skills : [])].join(' ')).trim().split(' ');
    for (const w of words) {
      if (w.length < 4 || seen.has(w) || FILLER_SET.has(w) || /\d/.test(w)) continue;
      seen.add(w);
      const key = soundKey(w);
      const sk = skeleton(key);
      if (key.length < 3 || sk.length < 2) continue;
      const l = bySkel.get(sk) || [];
      l.push({ key, word: w });
      bySkel.set(sk, l);
    }
  }
  return bySkel;
}

/**
 * The concepts in a list of words (what the dictionary pass left over).
 *
 * @returns { ids[], keywords[], rest[] (for the place lookup), ignored[] (native words not understood) }
 */
export function extractConcepts(tokens, { boardWords } = {}) {
  const v = vocab();
  const words = (tokens || []).map((t) => NFC(t).toLowerCase()).filter(Boolean);
  const used = new Array(words.length).fill(false);
  const ids = [];
  const keywords = [];
  const addId = (id) => { if (id && !ids.includes(id)) ids.push(id); };

  /* English phrases, longest first ("machine learning", "spring boot") */
  for (let n = Math.min(v.longest, 4); n >= 1; n -= 1) {
    for (let i = 0; i + n <= words.length; i += 1) {
      if (used.slice(i, i + n).some(Boolean)) continue;
      const slice = words.slice(i, i + n);
      if (slice.some((w) => hasIndicScript(w))) continue;
      const p = slice.join(' ');
      let hit = v.phrase.get(p) || (p.endsWith('s') && p.length > 3 ? v.phrase.get(p.slice(0, -1)) : null);
      /* a phrase of several words only as a concept's own term: "python
         developer" is Python AND Developer, not one of Python's synonyms */
      if (hit && n > 1) hit = hit.filter((x) => x.strength === 1);
      if (hit && hit.length) {
        addId(hit[0].id);
        for (let k = i; k < i + n; k += 1) used[k] = true;
      }
    }
  }
  /* native-script phrases of two words ("మెషిన్ లెర్నింగ్", "पदो तरगति") */
  for (let i = 0; i + 2 <= words.length; i += 1) {
    if (used[i] || used[i + 1]) continue;
    const id = v.native.get(`${words[i]} ${words[i + 1]}`);
    if (id) { addId(id); used[i] = true; used[i + 1] = true; }
  }

  const rest = [];
  const ignored = [];
  words.forEach((w, i) => {
    if (used[i]) return;
    if (FILLER_SET.has(w)) return;
    if (hasIndicScript(w)) {
      const stems = nativeStems(w);
      if (stems.some((s) => FILLER_SET.has(s))) return;
      const nat = stems.map((s) => v.native.get(s)).find(Boolean);
      if (nat) { addId(nat); return; }
      const snd = soundConcept(w, boardWords);
      if (snd && snd.id) { addId(snd.id); return; }
      if (snd && snd.keyword) { if (!keywords.includes(snd.keyword)) keywords.push(snd.keyword); return; }
      rest.push({ word: tokens[i], native: true });
      return;
    }
    /* a romanised case ending: "hyderabadlo", "pythonki" */
    for (const s of LATIN_SUFFIXES) {
      if (w.endsWith(s) && w.length - s.length >= 4) {
        const hit = v.phrase.get(w.slice(0, -s.length));
        if (hit) { addId(hit[0].id); return; }
      }
    }
    rest.push({ word: tokens[i], native: false });
  });
  return { ids, keywords, rest, ignored };
}

/* ------------------------------------------------------------------ *
 * the search object
 * ------------------------------------------------------------------ */

const KIND_FIELD = { role: 'role', tech: 'technologies', skill: 'skills', industry: 'industry', qualification: 'qualification' };
const cap = (v) => String(v || '').replace(/(^|\s)\S/g, (m) => m.toUpperCase());

/** "Python Developer", "Technology Consultant", "AI": industry, technology / skill, role. */
export function queryLabel(ids, keywords = []) {
  const cs = ids.map((id) => CONCEPT_BY_ID.get(id)).filter(Boolean);
  const order = { industry: 0, tech: 1, skill: 1, qualification: 3, role: 2 };
  const parts = cs.filter((c) => c.kind !== 'qualification').sort((a, b) => order[a.kind] - order[b.kind]).map((c) => c.label);
  if (!parts.length && keywords.length) return keywords.map(cap).join(' ');
  return parts.join(' ');
}

/**
 * @param o.originalQuery  what was said (kept, never searched)
 * @param o.language       detectLanguage()
 * @param o.ids/keywords   extractConcepts()
 * @param o.location       resolved place name or ''
 * @param o.intent         the rules / AI intent (years, fresher, modes, types, amount)
 * @param o.result         intentToResult() output (chips, portal)
 */
export function buildSearch({ originalQuery, language, ids, keywords, location, intent = {}, result = {} }) {
  const out = {
    originalQuery: String(originalQuery || '').slice(0, 300),
    language,
    intent: 'job_search',
    normalizedQuery: '',
    role: [], skills: [], technologies: [], location: location ? [location] : [], experience: [], qualification: [],
    salary: [], jobType: [], industry: [], noticePeriod: [], synonyms: [], semanticTerms: [],
    searchMode: 'semantic',
    concepts: ids.slice(0, 12),
    keywords: keywords.slice(0, 8),
  };
  for (const id of out.concepts) {
    const c = CONCEPT_BY_ID.get(id);
    if (!c) continue;
    out[KIND_FIELD[c.kind]].push(c.label);
    c.expand.forEach((t) => { if (!out.synonyms.includes(t)) out.synonyms.push(t); });
    c.terms.forEach((t) => { if (!out.semanticTerms.includes(t)) out.semanticTerms.push(t); });
  }
  out.keywords.forEach((k) => { if (!out.semanticTerms.includes(k)) out.semanticTerms.push(k); });
  out.synonyms = out.synonyms.slice(0, 40);
  out.semanticTerms = out.semanticTerms.slice(0, 40);
  const portal = result.portal || {};
  if (portal.exp && portal.exp.length) out.experience = portal.exp.slice();
  if (intent.years != null && !out.experience.length) out.experience = [`${intent.years} years`];
  const salaryChip = (result.chips || []).find((c) => c.id === 'salary');
  if (salaryChip) out.salary = [salaryChip.label];
  out.jobType = [...(intent.types || []), ...(intent.modes || []).map((m) => ({ Remote: 'Remote', Onsite: 'Onsite', Hybrid: 'Hybrid' }[m] || m))];
  if (/\b(immediate|immediately|immediate joining|join immediately|వెంటనే|तुरंत)\b/i.test(NFC(originalQuery))) out.noticePeriod = ['Immediate'];
  out.years = intent.years != null ? Number(intent.years) : null;
  out.fresher = !!intent.fresher;
  /* "remote" / "work from home": only jobs whose own mode / type / location says so */
  out.remote = (intent.modes || []).includes('Remote');

  const what = queryLabel(out.concepts, out.keywords);
  out.normalizedQuery = [what ? `${what.toLowerCase()} jobs` : (location ? 'jobs' : ''), location ? `in ${location}` : '']
    .filter(Boolean).join(' ').trim();
  out.label = what;
  return out;
}

/** The search object as it may be stored or sent back (validated, bounded). */
export function cleanSearch(s) {
  const strs = (v, n = 12, len = 60) => (Array.isArray(v) ? v : []).map((x) => String(x || '').replace(/[<>{}]/g, '').trim().slice(0, len))
    .filter(Boolean).slice(0, n);
  const ids = strs(s && s.concepts, 12, 40).filter((id) => CONCEPT_BY_ID.has(id));
  const keywords = strs(s && s.keywords, 8, 40).map((k) => k.toLowerCase()).filter((k) => !hasIndicScript(k));
  const location = strs(s && s.location, 3, 80).filter((k) => !hasIndicScript(k));
  const lang = ['TELUGU', 'HINDI', 'ENGLISH', 'MIXED', 'OTHER'].includes(s && s.language) ? s.language : 'OTHER';
  const years = s && Number.isFinite(Number(s.years)) && s.years !== null && s.years !== '' ? Math.max(0, Math.min(40, Number(s.years))) : null;
  const TYPES = ['Full-time', 'Part-time', 'Contract', 'Internship', 'Walk-in'];
  const types = strs(s && s.jobType, 6, 20).filter((t) => TYPES.includes(t));
  const remote = !!(s && (s.remote === true || (Array.isArray(s.jobType) && s.jobType.includes('Remote'))));
  const out = buildSearch({
    originalQuery: s && s.originalQuery, language: lang, ids, keywords, location: location[0] || '',
    intent: { years, fresher: !!(s && s.fresher), types, modes: remote ? ['Remote'] : [] },
  });
  /* the experience band as the screen named it, if it was one of the screen's own */
  const bands = strs(s && s.experience, 4, 20).filter((e) => /^(Fresher|\d+[–-]\d+ Years|8\+ Years|\d+ years)$/.test(e));
  if (bands.length) out.experience = bands;
  return out;
}

/* ------------------------------------------------------------------ *
 * ranking
 * ------------------------------------------------------------------ */

/** The searchable text of a job, from a database row or the API shape. */
export function jobText(j) {
  const arr = (v) => (Array.isArray(v) ? v : (v ? [v] : []));
  return {
    title: normText(j.title),
    skills: normText([...arr(j.skills), ...arr(j.required_skills), ...arr(j.preferred_skills), j.department || ''].join(' , ')),
    desc: normText([j.description || j.desc || '', ...arr(j.responsibilities), ...arr(j.requirements),
      j.education || '', j.industry || '', j.company_name || j.companyName || ''].join(' , ')),
  };
}

/** How strongly one concept (or keyword) shows in a job: { title, skills, desc, related } in 0..1. */
function groupHit(g, t) {
  const best = { title: 0, skills: 0, desc: 0, related: 0 };
  const try1 = (terms, strength, isRelated) => {
    for (const term of terms) {
      const p = normText(term).trim();
      if (!p) continue;
      const narrow = g.narrow.includes(term);
      if (isRelated) {
        if (hasPhrase(t.title, p) || hasPhrase(t.skills, p) || (!narrow && hasPhrase(t.desc, p))) best.related = Math.max(best.related, strength);
        continue;
      }
      if (hasPhrase(t.title, p)) best.title = Math.max(best.title, strength);
      if (hasPhrase(t.skills, p)) best.skills = Math.max(best.skills, strength);
      if (!narrow && hasPhrase(t.desc, p)) best.desc = Math.max(best.desc, strength);
    }
  };
  try1(g.terms, 1, false);
  try1(g.expand, 0.8, false);
  const rel = [];
  for (const r of g.related) { const c = CONCEPT_BY_ID.get(r); rel.push(...(c ? c.terms : [r])); }
  try1(rel, 0.5, true);
  return best;
}

const groupsOf = (search) => [
  ...search.concepts.map((id) => CONCEPT_BY_ID.get(id)).filter(Boolean),
  ...search.keywords.map((k) => ({ id: `kw:${k}`, kind: 'keyword', label: cap(k), terms: [k], expand: [], related: [], narrow: [] })),
];

/** Per-field weight of a hit: a word in the title says more than one in the description. */
const FIELD = { title: 1, skills: 0.85, desc: 0.7 };
const strengthOf = (h) => Math.max(h.title * FIELD.title, h.skills * FIELD.skills, h.desc * FIELD.desc);

export const LABELS = [[90, 'Excellent'], [75, 'Strong'], [60, 'Relevant'], [40, 'Related'], [0, 'Related']];
const labelOf = (s) => LABELS.find(([min]) => s >= min)[1];

function expFits(jobExp, years) {
  const n = (String(jobExp || '').match(/\d+/g) || []).map(Number);
  if (!n.length) return null;
  const lo = n[0];
  const hi = n[1] != null ? n[1] : lo;
  return years >= lo - 1 && years <= hi + 1;
}

/**
 * Score one job.
 * @param ctx.tier        (jobLocation, jobMode, tags) -> exact|nearby|remote|other
 * @param ctx.profile     (job) -> 0..100 from the candidate's own profile (ai/match.js), or null
 */
export function scoreJob(search, job, groups, ctx = {}) {
  const t = jobText(job);
  const hits = groups.map((g) => ({ g, h: groupHit(g, t) }));
  const kindOf = (g) => (g.kind === 'role' ? 'role' : 'skill');
  const found = (x) => strengthOf(x.h) > 0;
  const parts = {};
  let got = 0;
  let max = 0;

  if (groups.length) {
    const avg = (fn) => hits.reduce((s, x) => s + fn(x), 0) / hits.length;
    /* shown for transparency; the score uses the best place each concept was found */
    parts.title = Math.round(30 * avg((x) => x.h.title));
    parts.skills = Math.round(25 * avg((x) => x.h.skills));
    parts.description = Math.round(20 * avg((x) => x.h.desc));
    /* a neighbouring role / technology earns a little, so related jobs rank above the rest */
    got += 75 * avg((x) => Math.max(strengthOf(x.h), x.h.related * 0.4));
    max += 75;
  }
  let tier = null;
  if (search.location.length) {
    tier = ctx.tier ? ctx.tier(job.location, job.mode, search.location) : 'other';
    parts.location = tier === 'exact' ? 15 : tier === 'nearby' ? 11 : tier === 'remote' ? 6 : 0;
    got += parts.location;
    max += 15;
  }
  if (search.years != null || search.fresher) {
    const fit = search.fresher ? expFits(job.exp_label || job.exp, 0) : expFits(job.exp_label || job.exp, search.years);
    parts.experience = fit === false ? 0 : 5;
    got += parts.experience;
    max += 5;
  }
  if (ctx.profile) {
    const p = Math.max(0, Math.min(100, Number(ctx.profile(job)) || 0));
    parts.profile = Math.round((p / 100) * 5);
    got += parts.profile;
    max += 5;
  }
  const score = max ? Math.round((got / max) * 100) : 0;
  const locOk = !search.location.length || tier === 'exact' || tier === 'nearby';
  const all = (kind) => hits.filter((x) => !kind || kindOf(x.g) === kind).every(found);
  const hasKind = (kind) => hits.some((x) => kindOf(x.g) === kind);
  return {
    score, parts, tier, locOk,
    allGroups: groups.length > 0 && all(),
    allSkills: hasKind('skill') && all('skill'),
    allRoles: hasKind('role') && all('role'),
    anyGroup: hits.some(found),
    related: hits.some((x) => x.h.related > 0),
  };
}

/*
 * THE FALLBACK ORDER (the owner's): role+skill+location, skill+location,
 * role+location, skill/role anywhere, semantic+location, semantic
 * anywhere, related - and a location on its own ONLY when no role, skill
 * or other term was said. "Java developer in Hyderabad" with no Java job
 * there shows the Java Developer jobs elsewhere and says so; it never
 * shows random Hyderabad jobs.
 *
 * role+location is used only when no technology / skill was said: with
 * one, the technology is what the person asked for ("Java developer" is a
 * Java job), and a Python Developer in Hyderabad is not a closer answer
 * than a Java Developer in Bengaluru.
 */
const LEVELS = [
  { level: 1, name: 'role+skill+location', test: (s) => s.allGroups && s.locOk, min: 40 },
  { level: 2, name: 'skill+location', test: (s) => s.allSkills && s.locOk, min: 40, needs: 'skill+place' },
  { level: 3, name: 'role+location', test: (s) => s.allRoles && s.locOk, min: 40, needs: 'role-only+place' },
  { level: 4, name: 'skill/role, other locations', test: (s) => s.allGroups, min: 40, needs: 'place' },
  { level: 5, name: 'semantic+location', test: (s) => s.anyGroup && s.locOk, min: 20, needs: 'place' },
  { level: 6, name: 'semantic anywhere', test: (s) => s.anyGroup, min: 20 },
  { level: 7, name: 'related / recommended', test: (s, x) => s.related || (x.profile >= 60), min: 15 },
];

/** Remote means the job's own data says so: its mode, type or location. */
export const isRemoteJob = (j) => /\b(remote|work from home|wfh|home based)\b/i
  .test([j.mode, j.employment_type || j.type, j.location].filter(Boolean).join(' '));

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * Rank open jobs for a search object.
 * @param jobs   rows from jobs_open (+ company_name) - only what the viewer may see
 * @param ctx    { tier, profile, limit }
 * @returns { level, levelName, total, results:[{ jobId, score, label, parts }], message, related, empty, passthrough? }
 */
export function rankJobs(search, jobs, ctx = {}) {
  const groups = groupsOf(search);
  const place = search.location.length ? search.location[0] : '';
  const where = place ? ` in ${place}` : '';
  const what = search.label || queryLabel(search.concepts, search.keywords);
  const limit = ctx.limit || 200;
  if (!groups.length && !place) {
    /* Nothing to rank by (only a salary, a mode, a job type ...): the
       screen's own filters do it; this layer does not run an empty search. */
    return { level: 0, levelName: 'filters only', total: 0, results: [], related: false, empty: false, passthrough: true, message: null };
  }
  const pool = search.remote ? (jobs || []).filter(isRemoteJob) : (jobs || []);
  const scored = pool.map((j) => {
    const s = scoreJob(search, j, groups, ctx);
    const profile = ctx.profile ? Number(ctx.profile(j)) || 0 : 0;
    return { j, s, profile };
  });
  const byScore = (a, b) => b.s.score - a.s.score || b.profile - a.profile;

  if (!groups.length) {
    /* a place and nothing else: the jobs there */
    const here = scored.filter((x) => x.s.locOk).sort(byScore);
    if (here.length) return finish(1, 'location only', here, false, null);
    return { level: 0, levelName: 'none', total: 0, results: [], related: false, empty: true,
      message: `No matching jobs found${where}.` };
  }

  const hasSkill = groups.some((g) => g.kind !== 'role');
  const hasRole = groups.some((g) => g.kind === 'role');
  for (const L of LEVELS) {
    if (L.needs === 'skill+place' && (!hasSkill || !place)) continue;
    if (L.needs === 'role-only+place' && (!hasRole || hasSkill || !place)) continue;
    if (L.needs === 'place' && !place) continue;
    const list = scored.filter((x) => L.test(x.s, x) && x.s.score >= L.min);
    if (!list.length) continue;
    list.sort(byScore);
    const related = L.level >= 5;
    let message = null;
    if (related) message = `${plural(list.length, 'related job', 'related jobs')} found. Showing the closest matches.`;
    else if (L.level === 4) message = `No ${what} jobs found${where}. Showing ${what} jobs in other locations.`;
    else if (L.level > 1) message = `No exact ${what} jobs${where}. Showing ${plural(list.length, 'closest match', 'closest matches')}.`;
    return finish(L.level, L.name, list, related, message);
  }
  return { level: 0, levelName: 'none', total: 0, results: [], related: false, empty: true,
    message: what ? `No matching ${what} jobs found${where}.` : `No matching jobs found${where}.` };

  function finish(level, levelName, list, related, message) {
    return {
      level, levelName, related, empty: false, message,
      total: list.length,
      results: list.slice(0, limit).map((x) => ({ jobId: x.j.id, score: x.s.score, label: labelOf(x.s.score), parts: x.s.parts })),
    };
  }
}

/**
 * Does a job match a SAVED voice search? (alerts, the saved-search count)
 * The concepts must all be there - title, skills or description, the
 * concept's synonyms included; the location is the saved search's own
 * location rule (locTags), applied by the caller.
 */
export function voiceMatches(job, saved) {
  const search = cleanSearch(saved);
  if (search.remote && !isRemoteJob(job)) return false;
  const groups = groupsOf(search);
  if (!groups.length) return true;
  const t = jobText(job);
  return groups.every((g) => strengthOf(groupHit(g, t)) > 0);
}
