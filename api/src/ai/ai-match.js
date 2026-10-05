/**
 * THE AI MATCH SCORE - the one number a candidate sees (owner, 2026-10-05).
 *
 *     AI Match % = matched JD-required skills / unique JD-required skills x 100
 *
 * Candidate skills + the job's required skills -> normalise -> match ->
 * matched / required -> ONE score. Nothing else moves it: location,
 * distance, experience, salary, education, notice period, job type, work
 * mode, resume score, profile completeness and application history are
 * all out. They may be EXPLAINED next to the number (the "Why this
 * match?" reasons), never added to it.
 *
 * Every candidate-facing surface reads this function, through
 * explainMatch() in portal/core.js and GET /job-matches/explain:
 *   - the job card's "🎯 XX% AI Match";
 *   - "Why this match?" (the same score, the same matched/missing lists);
 *   - the candidate job-match APIs (explain, the career assistant);
 *   - the AI-ranked search (voice search) and the alerts that use a match
 *     threshold (urgent / last-date alerts, the profile-match alert).
 *
 * Recruiter-side screening (ai/screening.js, ai/match.js matchCandidate)
 * keeps its multi-factor score: it ranks and shortlists applicants for a
 * recruiter and is never shown to a candidate as their AI Match. It uses
 * the same skill normalisation (canonicalSkill below), so "Node.js" and
 * "nodejs" are one skill everywhere.
 *
 * A JD that lists no skills has NO score - `score: null` - not 0%. Zero
 * would read as "you match nothing"; the truth is "this job did not say
 * what it needs", and the card then shows no percentage at all.
 */

/* ------------------------------------------------------------------ *
 * normalisation
 * ------------------------------------------------------------------ */

/*
 * Equivalent names, as groups. The first entry is the canonical id; every
 * entry is a way people write it. Kept explicit and small: an alias that
 * is merely RELATED (Java / JavaScript, Spring / Spring Boot, SQL / MySQL,
 * React / React Native) is a different skill and is not listed here.
 */
const GROUPS = [
  ['javascript', 'js', 'java script', 'ecmascript', 'es6'],
  ['typescript', 'ts'],
  ['nodejs', 'node', 'node.js', 'node js'],
  ['react', 'reactjs', 'react.js', 'react js'],
  ['angular', 'angularjs', 'angular.js', 'angular js'],
  ['vue', 'vuejs', 'vue.js', 'vue js'],
  ['nextjs', 'next.js', 'next js'],
  ['expressjs', 'express', 'express.js', 'express js'],
  ['postgresql', 'postgres', 'postgre sql', 'postgre'],
  ['mongodb', 'mongo', 'mongo db'],
  ['sqlserver', 'sql server', 'mssql', 'ms sql', 'microsoft sql server', 'ms sql server'],
  ['machinelearning', 'machine learning', 'ml'],
  ['artificialintelligence', 'artificial intelligence', 'ai'],
  ['deeplearning', 'deep learning', 'dl'],
  ['nlp', 'natural language processing'],
  ['kubernetes', 'k8s'],
  ['go', 'golang'],
  ['python', 'py'],
  ['c#', 'c sharp', 'csharp'],
  ['c++', 'cpp'],
  ['.net', 'dotnet', 'dot net'],
  ['asp.net', 'asp net', 'aspnet'],
  ['springboot', 'spring boot', 'spring-boot'],
  ['aws', 'amazon web services'],
  ['gcp', 'google cloud', 'google cloud platform'],
  ['azure', 'microsoft azure'],
  ['html', 'html5'],
  ['css', 'css3'],
  ['restapi', 'rest api', 'rest apis', 'restful api', 'restful apis', 'rest', 'restful'],
  ['cicd', 'ci/cd', 'ci cd'],
  ['powerbi', 'power bi'],
  ['excel', 'ms excel', 'microsoft excel', 'advanced excel'],
  ['uiux', 'ui/ux', 'ui ux', 'ux/ui'],
];

/** Lower case, separators dropped: "Node.js", "node js", "NodeJS" -> "nodejs". */
function compact(v) {
  return String(v == null ? '' : v).toLowerCase().trim()
    .replace(/^\.(?=net$)/, '.')                  // ".net" keeps its dot
    .replace(/(?!^\.)[\s._\-/\\]+/g, '');
}

const ALIAS = new Map();          // compact spelling -> canonical id
const FORMS = new Map();          // canonical id -> every human spelling
for (const g of GROUPS) {
  const id = g[0];
  FORMS.set(id, new Set(g));
  for (const f of g) ALIAS.set(compact(f), id);
}

/** The canonical id of one skill name, or '' for nothing. */
export function canonicalSkill(raw) {
  const k = compact(raw);
  if (!k) return '';
  return ALIAS.get(k) || k;
}

/** True when the two names are the same skill. */
export function sameSkill(a, b) {
  const x = canonicalSkill(a);
  return !!x && x === canonicalSkill(b);
}

/** "Java, Spring; SQL" typed into one field is three skills. */
function splitList(list) {
  const out = [];
  for (const v of Array.isArray(list) ? list : (list ? [list] : [])) {
    for (const s of String(v == null ? '' : v).split(/[,;|\n]+/)) {
      const t = s.trim();
      if (t) out.push(t);
    }
  }
  return out;
}

/* Spellings that are ordinary English words in a sentence ("the rest of
   the team", "excel at", "express interest", "a network node"): a skills
   field may say them, prose is not evidence of them. */
const PROSE_SKIP = new Set(['rest', 'restful', 'node', 'express', 'excel', 'go', 'spring']);

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/*
 * Is this skill NAMED in the candidate's own prose (resume, summary,
 * projects)? On word boundaries, never as a substring: "java" is inside
 * "javascript" and that is not Java. Spellings shorter than three letters
 * ("js", "ml", "go", "r") are not looked for in prose at all - they occur
 * inside ordinary words and sentences far too often to be evidence.
 */
function proseHas(text, id, jdSpellings) {
  if (!text) return false;
  const forms = new Set([...(FORMS.get(id) || []), id, ...jdSpellings]);
  for (const f0 of forms) {
    const f = String(f0).toLowerCase().trim();
    if (PROSE_SKIP.has(f)) continue;
    if (f.replace(/[^a-z0-9+#]/g, '').length < 3 && !/[+#]/.test(f)) continue;
    const body = f.split(/[\s._\-/]+/).filter(Boolean).map(esc).join('[\\s._\\-/]?');
    const lead = f.startsWith('.') ? '\\.' : '';
    const re = new RegExp(`(?<![a-z0-9+#.])${lead}${body}(?![a-z0-9+#])`, 'i');
    if (re.test(text)) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * the score
 * ------------------------------------------------------------------ */

/**
 * The candidate's AI Match against one job.
 *
 * @param job   a job: `{ skills: [...] }` (toJob() shape or a raw row), or
 *              just the array of required skills
 * @param cand  a candidate: skills / technicalSkills (or technical_skills),
 *              plus the prose that counts as evidence of a skill - the
 *              resume text (resumeText / resume_text), summary, projects
 * @returns {{
 *   score: number|null,  matched JD skills / required x 100, rounded; null
 *                        when the JD lists no skills
 *   required: number,    unique JD-required skills
 *   matchedCount: number,
 *   matched: string[],   JD skills the candidate has, as the JD writes them
 *   missing: string[],   JD skills the candidate does not have
 *   fromResume: string[] the matched ones found only in the resume/prose
 *   stated: boolean      whether the JD listed any skills at all
 * }}
 */
export function aiMatch(job, cand) {
  const jdList = Array.isArray(job) ? job : ((job && job.skills) || []);
  /* the JD's own skills, de-duplicated by canonical id, first spelling kept */
  const need = new Map();         // id -> { show, spellings }
  for (const raw of splitList(jdList)) {
    const id = canonicalSkill(raw);
    if (!id) continue;
    if (!need.has(id)) need.set(id, { show: raw, spellings: new Set() });
    need.get(id).spellings.add(raw);
  }

  const c = cand || {};
  const have = new Set(splitList([
    ...(Array.isArray(c.skills) ? c.skills : splitList(c.skills)),
    ...(Array.isArray(c.technicalSkills) ? c.technicalSkills : []),
    ...(Array.isArray(c.technical_skills) ? c.technical_skills : []),
  ]).map(canonicalSkill).filter(Boolean));

  const prose = [
    c.resumeText ?? c.resume_text ?? '',
    c.summary || '',
    c.projects ? (typeof c.projects === 'string' ? c.projects : JSON.stringify(c.projects)) : '',
  ].join('\n').toLowerCase();

  const matched = [], missing = [], fromResume = [];
  for (const [id, { show, spellings }] of need) {
    if (have.has(id)) matched.push(show);
    else if (proseHas(prose, id, spellings)) { matched.push(show); fromResume.push(show); }
    else missing.push(show);
  }

  const required = need.size;
  return {
    score: required ? Math.round((matched.length / required) * 100) : null,
    required,
    matchedCount: matched.length,
    matched,
    missing,
    fromResume,
    stated: required > 0,
  };
}
