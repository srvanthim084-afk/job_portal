/**
 * Smart job matching.
 *
 * THE RULE THAT SHAPES ALL OF THIS: one keyword is not a match.
 *
 * A candidate with "Java" on their profile must not be messaged about
 * every job that mentions Java. That is how an alert system becomes spam,
 * and once candidates learn to ignore the alerts the whole feature is
 * worth less than nothing — it has trained the audience to delete us.
 *
 * So a match is scored across six dimensions, and two HARD GATES are
 * applied before the score is even consulted:
 *
 *   gate 1  at least half the job's named skills, and never fewer than
 *           two, must be on the candidate's profile
 *   gate 2  the candidate's experience must not be far outside the band
 *           the job asks for
 *
 * A profile that passes both is then scored out of 100:
 *
 *   skills        40   how much of what the job asks for they actually have
 *   experience    20   inside the band, or just outside it
 *   role          15   their title or preferred role against the job title
 *   location      15   their location or preferred location, remote counts
 *   education      5   the qualification the job asks for
 *   preferences    5   expected salary, notice period, work mode
 *
 * and only those above the configured threshold are notified.
 *
 * Every number the engine produces comes with the evidence for it, because
 * a recruiter looking at "78%" needs to see WHICH skills matched before
 * they trust it, and a candidate who asks why they were contacted deserves
 * an answer better than "the algorithm".
 */

/** The default bar. A job may set its own; the environment may move this. */
export const DEFAULT_THRESHOLD = Number(process.env.JOB_MATCH_THRESHOLD || 65);

const WEIGHTS = {
  skills: 40, experience: 20, role: 15, location: 15, education: 5, preferences: 5,
};

/* ------------------------------------------------------------------ *
 * text helpers
 * ------------------------------------------------------------------ */

const norm = (v) => String(v || '').toLowerCase().trim();

/** "Node.js" and "nodejs" and "node js" are the same skill to a person. */
const skillKey = (v) => norm(v).replace(/[.\-_/\\]/g, ' ').replace(/\s+/g, ' ').trim();

/** Common ways the same skill is written. Kept small and explicit. */
const ALIASES = new Map(Object.entries({
  js: 'javascript', ts: 'typescript', 'node js': 'nodejs', node: 'nodejs',
  'react js': 'react', reactjs: 'react', 'angular js': 'angular', angularjs: 'angular',
  'spring boot': 'springboot', springboot: 'springboot',
  postgres: 'postgresql', 'ms sql': 'sql server', mssql: 'sql server',
  'c sharp': 'c#', dotnet: '.net', 'asp net': 'asp.net',
  py: 'python', golang: 'go', k8s: 'kubernetes',
}));

const canonical = (v) => {
  const k = skillKey(v);
  return ALIASES.get(k) || k;
};

const words = (v) => norm(v).split(/[^a-z0-9+#.]+/).filter((w) => w.length > 2);

/** Title words that carry no signal on their own. */
const STOP_TITLE = new Set([
  'senior', 'junior', 'lead', 'principal', 'staff', 'associate', 'sr', 'jr',
  'developer', 'engineer', 'analyst', 'specialist', 'consultant', 'executive',
  'the', 'and', 'for', 'with', 'years', 'experience', 'hiring', 'urgent',
]);

/* ------------------------------------------------------------------ *
 * the dimensions
 * ------------------------------------------------------------------ */

/**
 * Skills — how much of what the job asks for the candidate actually has.
 *
 * Measured as coverage of the JOB's list, not of the candidate's: a
 * profile listing forty skills should not score highly on a job that
 * needs three of them it does not have.
 */
/*
 * Is this skill actually named in that text?
 *
 * On WORD BOUNDARIES, not as a substring. Across a whole CV a substring
 * test is worse than useless: "java" is inside "javascript", "r" is
 * inside everything, and "go" is inside "google". A recruiter reading
 * the same page would not count any of those, and neither does this.
 *
 * The separators are deliberately wide - a resume writes "Node.js",
 * "C++", "React/Redux" and "Spring Boot," and all of them should match
 * the skill they name.
 */
const SKILL_BOUNDARY = new RegExp('[a-z0-9+#.]', 'i');
function names(text, skill) {
  if (!text || !skill || skill.length < 2) return false;
  let from = 0;
  for (;;) {
    const at = text.indexOf(skill, from);
    if (at < 0) return false;
    const before = at > 0 ? text[at - 1] : '';
    const after = text[at + skill.length] || '';
    if (!SKILL_BOUNDARY.test(before) && !SKILL_BOUNDARY.test(after)) return true;
    from = at + 1;
  }
}

export function scoreSkills(job, cand) {
  const need = [...new Set((job.skills || []).map(canonical).filter(Boolean))];
  /*
   * How each needed skill might be SPELLED in prose.
   *
   * canonical() folds "Node.js" to "nodejs" so that two profiles writing
   * it differently still match - but a CV writes it with the dot, and
   * "nodejs" is not in "node.js". So the resume is searched for both the
   * folded form and the spaced one, against text folded the same way.
   * Without this a requirement for Node.js or Spring Boot found nothing
   * in a resume that named it on every page.
   */
  const spelling = new Map();
  for (const raw of (job.skills || [])) {
    const key = canonical(raw);
    if (!key) continue;
    const forms = spelling.get(key) || new Set();
    forms.add(key);
    forms.add(skillKey(raw));
    spelling.set(key, forms);
  }
  const have = new Set([
    ...(cand.technicalSkills || []), ...(cand.skills || []),
  ].map(canonical).filter(Boolean));

  if (!need.length) return { score: 0, coverage: 0, matched: [], missing: [], stated: false };

  const matched = need.filter((s) => have.has(s));

  /*
   * THE RESUME COUNTS AS EVIDENCE.
   *
   * It used to be the profile's own prose and nothing else, so a CV that
   * spent two pages on Spring Boot contributed nothing unless somebody
   * had also typed "Spring Boot" into a skills field. That is the
   * opposite of how a recruiter reads: they open the CV and look for
   * what the client asked for, and they find it in a project, under a
   * previous employer, in a line about what was built.
   *
   * Still corroboration rather than a claim - half weight, the same as
   * the summary - because prose saying a word is weaker than a profile
   * asserting a skill. What it is not any more is invisible.
   */
  // Folded the same way the skills are, so "Node.js" in a CV and
  // "nodejs" on a requirement are looking at each other.
  const blob = skillKey([cand.summary, cand.title, cand.currentCompany,
    JSON.stringify(cand.projects || []), cand.resumeText || ''].join(' '));
  const implied = need.filter((s) => !have.has(s)
    && [...(spelling.get(s) || [s])].some((form) => names(blob, form)));

  const coverage = (matched.length + implied.length * 0.5) / need.length;
  return {
    score: Math.round(Math.min(1, coverage) * WEIGHTS.skills),
    coverage,
    matched: need.filter((s) => have.has(s)),
    implied,
    missing: need.filter((s) => !have.has(s) && !implied.includes(s)),
    stated: true,
  };
}

/** "3-5 yrs", "3 to 5 years", "5+ years", "Fresher" -> {min, max}. */
export function experienceBand(job) {
  // toJob() calls it `exp`; the database column is exp_label.
  const raw = norm(job.exp || job.expLabel || job.exp_label || job.experience || '');
  if (!raw) return null;
  if (/fresher|entry|graduate/.test(raw)) return { min: 0, max: 1 };

  const nums = (raw.match(/\d+(?:\.\d+)?/g) || []).map(Number);
  if (!nums.length) return null;
  if (/\+|above|more than|minimum|min\b/.test(raw)) return { min: nums[0], max: nums[0] + 5 };
  if (nums.length === 1) return { min: nums[0], max: nums[0] + 1 };
  return { min: Math.min(...nums), max: Math.max(...nums) };
}

export function scoreExperience(job, cand) {
  const band = experienceBand(job);
  // The numeric column first, then the display string - "4 yrs" on a
  // profile is still four years, and refusing to read it means scoring
  // somebody as inexperienced because a column was never filled in.
  const fromLabel = /(\d+(?:\.\d+)?)/.exec(String(cand.exp || ''));
  const years = Number(
    cand.expYears ?? cand.exp_years ?? (fromLabel ? fromLabel[1] : NaN));

  if (!band) return { score: Math.round(WEIGHTS.experience * 0.5), band: null, years, fit: 'unstated' };
  if (!Number.isFinite(years)) {
    return { score: Math.round(WEIGHTS.experience * 0.3), band, years: null, fit: 'unknown' };
  }

  if (years >= band.min && years <= band.max) {
    return { score: WEIGHTS.experience, band, years, fit: 'inside' };
  }
  // A year either side is a judgement call a recruiter would make, not a
  // reason to stay silent.
  const gap = years < band.min ? band.min - years : years - band.max;
  if (gap <= 1) return { score: Math.round(WEIGHTS.experience * 0.7), band, years, fit: 'near' };
  if (gap <= 2) return { score: Math.round(WEIGHTS.experience * 0.35), band, years, fit: 'outside' };
  return { score: 0, band, years, fit: 'far' };
}

export function scoreRole(job, cand) {
  const jobWords = words(job.title).filter((w) => !STOP_TITLE.has(w));
  const mine = new Set([
    ...words(cand.title), ...words(cand.preferredRole || cand.preferred_role),
  ].filter((w) => !STOP_TITLE.has(w)));

  if (!jobWords.length) {
    // Nothing distinctive in the title ("Developer"): fall back to the
    // full strings so "Java Developer" still matches "Java Developer".
    const same = norm(job.title) && norm(job.title) === norm(cand.title);
    return { score: same ? WEIGHTS.role : Math.round(WEIGHTS.role * 0.5), matched: [], weak: true };
  }

  const matched = jobWords.filter((w) => mine.has(w));
  const ratio = matched.length / jobWords.length;
  return { score: Math.round(ratio * WEIGHTS.role), matched, ratio };
}

/** City names, loosely: "Hyderabad, India" matches "Hyderabad". */
function placeWords(v) {
  return new Set(norm(v).split(/[^a-z]+/).filter((w) => w.length > 3));
}

export function scoreLocation(job, cand) {
  const mode = norm(job.mode);
  if (/remote|anywhere|work from home/.test(mode)) {
    return { score: WEIGHTS.location, reason: 'remote', matched: true };
  }

  const jobPlace = placeWords(job.location);
  if (!jobPlace.size) return { score: Math.round(WEIGHTS.location * 0.5), reason: 'unstated', matched: false };

  const mine = new Set([
    ...placeWords(cand.location),
    ...placeWords(cand.preferredLocation || cand.preferred_location),
  ]);
  for (const p of jobPlace) {
    if (mine.has(p)) return { score: WEIGHTS.location, reason: 'same city', matched: true, city: p };
  }

  // Willing to work remotely, for a hybrid role, is a partial fit.
  const modes = (cand.preferredWorkModes || cand.preferred_work_modes || []).map(norm);
  if (modes.some((m) => /remote/.test(m)) && /hybrid/.test(mode)) {
    return { score: Math.round(WEIGHTS.location * 0.4), reason: 'open to remote', matched: false };
  }
  return { score: 0, reason: 'different city', matched: false };
}

export function scoreEducation(job, cand) {
  const need = norm(job.education);
  if (!need) return { score: WEIGHTS.education, reason: 'not specified' };
  const have = norm(cand.education) + ' ' + norm(cand.qualification);
  const needWords = words(need).filter((w) => !['any', 'degree', 'graduate'].includes(w));
  if (!needWords.length) return { score: WEIGHTS.education, reason: 'any degree' };
  const hit = needWords.some((w) => have.includes(w));
  return { score: hit ? WEIGHTS.education : 0, reason: hit ? 'qualification matches' : 'different qualification' };
}

/**
 * The candidate's own stated preferences.
 *
 * Small weight, large meaning: somebody expecting 30 LPA should not be
 * messaged about a 12 LPA role, whatever their skills say.
 */
export function scorePreferences(job, cand) {
  const notes = [];
  let earned = 0, possible = 0;

  const want = Number(cand.expectedCtc ?? cand.expected_ctc);
  const max = Number(job.salaryMax ?? job.salary_max);
  if (Number.isFinite(want) && Number.isFinite(max) && max > 0) {
    possible += 2;
    if (want <= max) { earned += 2; notes.push('salary expectation within the band'); }
    else if (want <= max * 1.15) { earned += 1; notes.push('salary expectation slightly above the band'); }
    else notes.push('salary expectation above the band');
  }

  const modes = (cand.preferredWorkModes || cand.preferred_work_modes || []).map(norm);
  if (modes.length && norm(job.mode)) {
    possible += 2;
    if (modes.some((m) => norm(job.mode).includes(m) || m.includes(norm(job.mode)))) {
      earned += 2; notes.push(`prefers ${job.mode.toLowerCase()} work`);
    }
  }

  const notice = norm(cand.noticePeriod || cand.notice_period);
  if (notice) {
    possible += 1;
    if (/immediate|15|serving/.test(notice)) { earned += 1; notes.push(`notice period: ${notice}`); }
  }

  if (!possible) return { score: Math.round(WEIGHTS.preferences * 0.6), notes: ['no preferences stated'] };
  return { score: Math.round((earned / possible) * WEIGHTS.preferences), notes };
}

/* ------------------------------------------------------------------ *
 * the gates, and the verdict
 * ------------------------------------------------------------------ */

/**
 * Score one candidate against one job.
 *
 * @returns {{score:number, notify:boolean, reason:string, matchedSkills:string[],
 *            breakdown:object}}
 */
export function matchCandidate(job, cand, { threshold = DEFAULT_THRESHOLD } = {}) {
  const skills = scoreSkills(job, cand);
  const experience = scoreExperience(job, cand);
  const role = scoreRole(job, cand);
  const location = scoreLocation(job, cand);
  const education = scoreEducation(job, cand);
  const preferences = scorePreferences(job, cand);

  const score = skills.score + experience.score + role.score
              + location.score + education.score + preferences.score;

  const breakdown = { skills, experience, role, location, education, preferences };
  const out = {
    score,
    threshold,
    matchedSkills: skills.matched,
    breakdown,
    notify: false,
    reason: '',
  };

  // ---- gate 1: enough of the job's OWN skills, not just one ----------
  //
  // This is the rule the whole feature turns on. Half of what the job
  // asks for, and never fewer than two - so a profile that merely
  // contains the word "Java" is not messaged about a Java job.
  if (skills.stated) {
    const need = skills.matched.length + skills.missing.length + (skills.implied || []).length;
    const required = Math.max(2, Math.ceil(need / 2));
    if (skills.matched.length < Math.min(required, need)) {
      out.reason = `only ${skills.matched.length} of ${need} required skills`;
      return out;
    }
  }

  // ---- gate 2: not far outside the experience band -------------------
  if (experience.fit === 'far') {
    out.reason = `${experience.years} years against a ${experience.band.min}-${experience.band.max} year role`;
    return out;
  }

  // ---- gate 3: a job in another city, for somebody who has not said
  //             they would move or work remotely ---------------------
  //
  // Skills and experience carry enough weight to clear the threshold on
  // their own, so without this a Chennai candidate is messaged about a
  // Hyderabad office job - the single most common complaint about every
  // job board there is.
  if (location.score === 0) {
    out.reason = `${cand.location || 'their location'} against a role in ${job.location}`;
    return out;
  }

  // ---- gate 4: the role has to be recognisable -----------------------
  //
  // A DevOps engineer with Java, SQL and the right city is not a Java
  // Developer, and telling them otherwise wastes everybody's time.
  if (role.score === 0 && !role.weak) {
    out.reason = 'a different kind of role';
    return out;
  }

  if (score < threshold) {
    out.reason = `scored ${score}, below the ${threshold} threshold`;
    return out;
  }

  out.notify = true;
  out.reason = `${skills.matched.length} of ` +
    `${skills.matched.length + skills.missing.length + (skills.implied || []).length} skills, ` +
    `${experience.fit} the experience band, ${location.reason}`;
  return out;
}

/**
 * Score a whole list, best first.
 *
 * @returns {{ matches: Array, considered: number, notified: number }}
 */
export function matchJob(job, candidates, opts = {}) {
  const matches = (candidates || [])
    .map((c) => ({ candidate: c, ...matchCandidate(job, c, opts) }))
    .sort((a, b) => b.score - a.score);

  return {
    matches,
    considered: matches.length,
    notified: matches.filter((m) => m.notify).length,
  };
}
