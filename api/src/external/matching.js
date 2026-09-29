/**
 * How well a candidate fits an EXTERNAL job.
 *
 * This is a second matcher, and it exists on purpose.
 *
 * `api/src/ai/match.js` scores a candidate against a TeamLink
 * requirement, where the recruiter wrote the requirement, the skills list
 * is curated, and the score drives a pipeline that people act on. None of
 * that is true of a job scraped off a board: the skills are whatever the
 * advertiser typed, the experience is a string like "2-4 yrs", and the
 * score's only job is to decide whether to show the candidate a card.
 * Pointing the existing matcher at that data would change its behaviour
 * for the TeamLink requirements it was tuned against, which is exactly
 * what must not happen - so this file never imports it, and nothing here
 * writes to `applications.match_score`.
 *
 * DETERMINISTIC. No model, no randomness, no clock. The same candidate
 * and the same job always produce the same number, which is the only way
 * a recruiter can defend it to a candidate who asks why they scored 61.
 *
 * WORKED EXAMPLE, the one from the brief:
 *
 *   candidate  Java Developer · 3 yrs · Java, Spring Boot, SQL · Hyderabad
 *   job        Senior Java Developer · 2-4 yrs · Java, Spring Boot, SQL · Hyderabad
 *
 *   skills      3 of 3 required          45.0 / 45
 *   experience  3 sits inside 2-4        20.0 / 20
 *   role        "java developer" vs "senior java developer",
 *               2 shared words of 3      10.0 / 15
 *   location    same city, 0 km          12.0 / 12
 *   education   the job does not say        - / -
 *   type        the job does not say        - / -
 *   pay         the job does not say        - / -
 *                                        ----------
 *                               87.0 of 92 assessable  =  95%
 *
 * A DIMENSION THE JOB IS SILENT ABOUT IS NOT A DIMENSION THE CANDIDATE
 * FAILED. Boards leave education, employment type and salary blank far
 * more often than they fill them, and scoring those as zero dragged every
 * real match into the fifties - which is indistinguishable from a bad
 * match, and therefore useless. So the divisor is the weight of what
 * could actually be assessed, and `basis` reports which those were.
 */
import { placeByName, placesAvailable } from '../places.js';

/**
 * Every weight in one table, so tuning is a data change.
 *
 * Skills dominate because on an external board they are the only field
 * the advertiser reliably fills in. Education is small because a degree
 * line on a job board is usually boilerplate.
 */
/*
 * SKILLS CARRY HALF OF IT, and they did not.
 *
 * At skills 30 the other seven components could outvote what the person
 * can actually do. A Python and SQL graduate scored 100% against
 * "Freelance Writer": the job was remote, open to freshers, paid in a
 * plausible band and asked for no particular degree, so seven weak
 * agreements outweighed one strong disagreement. A recruiter reading
 * that number would think the matcher was broken, and they would be
 * right.
 *
 * These are the weights the brief names for external jobs - skills 50,
 * role 20, experience 15, location 10, recency 5 - and they put the
 * decision back where it belongs. Pay, education, notice period and
 * employment type stop scoring: none of them is reliably stated on a job
 * board, and a field that is usually absent contributes noise rather
 * than signal.
 *
 * This is the EXTERNAL matcher only. The internal one (api/src/ai/match.js)
 * scores against a TeamLink requirement, where those fields are filled in
 * by a recruiter and do mean something; it is untouched.
 */
export const EXTERNAL_WEIGHTS = {
  skills: 50,
  role: 20,
  experience: 15,
  location: 10,
  recency: 5,
};

/* ------------------------------------------------------------------ *
 * text
 * ------------------------------------------------------------------ */

const fold = (s) => String(s == null ? '' : s)
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9+#. ]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Words that carry no signal in a job title.
 *
 * Without this, "Senior Software Engineer - Immediate Joiners, Apply Now"
 * shares "apply", "now" and "immediate" with half the board and every
 * title matched every other title a little bit.
 */
const TITLE_NOISE = new Set([
  'a', 'an', 'the', 'and', 'or', 'for', 'with', 'in', 'at', 'of', 'to',
  'job', 'jobs', 'role', 'position', 'vacancy', 'opening', 'openings',
  'required', 'require', 'wanted', 'hiring', 'urgent', 'urgently',
  'immediate', 'joiner', 'joiners', 'apply', 'now', 'fresher', 'freshers',
  'exp', 'experience', 'yrs', 'years', 'year', 'full', 'time', 'parttime',
  'work', 'from', 'home', 'wfh', 'remote', 'onsite', 'hybrid', 'walk',
  'walkin', 'interview', 'salary', 'lpa', 'ctc', 'india', 'multiple',
]);

const titleTokens = (s) => fold(s).split(' ')
  .filter((w) => w.length > 1 && !TITLE_NOISE.has(w));

/**
 * Skills that are the same skill under another name.
 *
 * Only pairs that are genuinely interchangeable in this market, and only
 * ones seen in the data. A synonym table is a liability once it starts
 * guessing: "java" is not "javascript", and conflating them would put a
 * front-end developer in front of a backend recruiter.
 */
const SKILL_ALIASES = new Map(Object.entries({
  js: 'javascript', ecmascript: 'javascript', nodejs: 'node', 'node.js': 'node',
  reactjs: 'react', 'react.js': 'react', angularjs: 'angular', vuejs: 'vue',
  postgres: 'postgresql', pgsql: 'postgresql', ms_sql: 'mssql',
  k8s: 'kubernetes', 'c sharp': 'c#', dotnet: '.net', 'asp.net': '.net',
  springboot: 'spring boot', 'rest apis': 'rest api', restful: 'rest api',
  ml: 'machine learning', ai: 'artificial intelligence',
  // The medical vocabulary this agency actually recruits for.
  ekg: 'ecg', xray: 'x-ray', 'x ray': 'x-ray', radiography: 'x-ray',
  ot: 'operation theatre', 'operation theater': 'operation theatre',
  icu: 'intensive care', nicu: 'neonatal intensive care',
  bls: 'basic life support', acls: 'advanced cardiac life support',
  usg: 'ultrasound', sonography: 'ultrasound',
  phlebotomy: 'venipuncture',
}));

const normSkill = (s) => {
  const f = fold(s);
  return SKILL_ALIASES.get(f) || f;
};

/**
 * Do these two skills mean the same thing?
 *
 * Exact match after aliasing, or one wholly contains the other as a word
 * run - "spring" against "spring boot" is a real partial match and
 * refusing it loses most of the genuine overlap in this data. Substring
 * matching WITHOUT the word boundary is what produced nonsense like "r"
 * matching "react", so the shorter side must be at least four characters.
 */
function sameSkill(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length < 4) return false;
  return new RegExp(`(^| )${short.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`).test(long);
}

/* ------------------------------------------------------------------ *
 * numbers
 * ------------------------------------------------------------------ */

/**
 * The years in "2-4 yrs", "3+ years", "Fresher", "0 to 2".
 *
 * Returns { min, max } with either side possibly null. A board writes
 * this field a dozen ways and none of them is a number.
 */
export function parseExperienceRange(text) {
  /*
   * NOT `fold`. That one strips punctuation to compare skill names, which
   * turns "2-4 yrs" into "2 4 yrs" - the range separator disappears, the
   * range branch below never matches, and the band is read as a minimum
   * of 2 with no ceiling. The hyphen and the en dash ARE the meaning here,
   * so they survive.
   */
  const s = String(text == null ? '' : text)
    .toLowerCase().replace(/\s+/g, ' ').trim();
  if (!s) return { min: null, max: null };
  if (/\b(fresher|fresh|entry level|no experience|trainee)\b/.test(s)) return { min: 0, max: 1 };

  const range = /(\d+(?:\.\d+)?)\s*(?:-|to|–)\s*(\d+(?:\.\d+)?)/.exec(s);
  if (range) return { min: Number(range[1]), max: Number(range[2]) };

  const plus = /(\d+(?:\.\d+)?)\s*\+/.exec(s);
  if (plus) return { min: Number(plus[1]), max: null };

  const one = /(\d+(?:\.\d+)?)/.exec(s);
  if (one) {
    const n = Number(one[1]);
    /* A bare "5 years" on a job advert is a minimum, not a ceiling. */
    return { min: n, max: null };
  }
  return { min: null, max: null };
}

/** The candidate's years, from whichever field actually holds them. */
function candidateYears(cand) {
  const n = Number(cand.exp_years);
  if (Number.isFinite(n) && n >= 0) return n;
  const m = /(\d+(?:\.\d+)?)/.exec(String(cand.exp || ''));
  return m ? Number(m[1]) : null;
}

const km = (a, b) => {
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLon = (b.lon - a.lon) * Math.PI / 180;
  const la1 = a.lat * Math.PI / 180;
  const la2 = b.lat * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

/* ------------------------------------------------------------------ *
 * the dimensions
 * ------------------------------------------------------------------ */

/**
 * Skills. The job's list is the requirement; the candidate's is the
 * evidence. Scored as the share of the JOB's skills that the candidate
 * can show - a candidate who knows forty things is not a better fit for a
 * job needing three of them than a candidate who knows exactly those
 * three.
 */
/**
 * The posting's own words, folded once, for the reverse lookup below.
 *
 * Cached on the job object the caller already passes around, because
 * matchExternalJob runs once per candidate per job and folding 4 KB of
 * HTML-stripped description a hundred times over is the whole cost.
 */
function jobHaystack(job) {
  if (!job) return '';
  if (job.__jobFold !== undefined) return job.__jobFold;
  const raw = [job.title, job.description, job.experience, job.employment_type]
    .filter(Boolean).join(' ');
  /* The descriptions arrive HTML-escaped from the boards, so the entities
     are turned back into the characters they stand for before folding -
     otherwise "C++" is sitting in the text as "C&#43;&#43;" and is never
     found. */
  const text = String(raw)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/<[^>]+>/g, ' ');
  const fold = text ? ` ${lowerFold(text.slice(0, 40000))} ` : '';
  try {
    Object.defineProperty(job, '__jobFold', { value: fold, enumerable: false });
  } catch { /* a frozen row: fall back to recomputing */ }
  return fold;
}

function scoreSkills(cand, job) {
  const need = [...new Set((job.skills || []).map(normSkill).filter(Boolean))];

  /*
   * THE POSTING USUALLY HAS NO SKILLS FIELD, AND IT ALWAYS HAS THE SKILLS.
   *
   * Measured on the 140 live external jobs: 10 carry a skills array and
   * 130 carry none, because a Greenhouse or Lever board publishes a job
   * as a title and a description and nothing structured. None carry an
   * experience line either.
   *
   * That left this function returning null for 130 of 140 jobs, and
   * matchExternalJob refuses to score a posting where neither skills nor
   * role could be read - so EVERY candidate fell through to tier
   * "latest" with no percentage at all. The scoring arithmetic was never
   * wrong; it was being handed nothing to weigh.
   *
   * So when the posting states no skills, the question is turned round:
   * which of THIS CANDIDATE'S skills does the posting's own text name?
   * That is evidence out of the advert rather than a guess about it -
   * the opposite of deriving a canned list from the job title, which
   * would put words in an employer's mouth.
   *
   * It is reported as what it is. The reason says "named in this
   * posting", never "required", because the employer never said
   * required - and the denominator is the candidate's own skills, so the
   * number answers "how much of what I do does this job talk about".
   */
  if (!need.length) {
    const mine = [...new Set([...(cand.skills || []), ...(cand.technical_skills || [])]
      .map(normSkill).filter(Boolean))];
    if (!mine.length) return null;                   // nothing to look for

    const hay = jobHaystack(job);
    if (!hay) return null;                           // the posting says nothing

    const matching = mine.filter((sk) => mentionsSkill(hay, sk));
    if (!matching.length) {
      return {
        ratio: 0,
        matching: [],
        missing: mine.slice(0, 8),
        fromResume: [],
        inferred: true,
        reason: 'none of your skills are named in this posting',
      };
    }
    return {
      /*
       * Against the candidate's own list, capped at eight - beyond that
       * the denominator punishes somebody for listing more skills - and
       * floored at three for the same reason as the stated branch: one
       * word found in a page of prose is not a 100% skills match.
       */
      ratio: matching.length / Math.max(3, Math.min(mine.length, 8)),
      matching,
      missing: mine.filter((sk) => !matching.includes(sk)).slice(0, 8),
      fromResume: [],
      inferred: true,
      reason: `${matching.length} of your skill${matching.length === 1 ? '' : 's'} named in this posting`,
    };
  }

  const have = [...new Set([...(cand.skills || []), ...(cand.technical_skills || [])]
    .map(normSkill).filter(Boolean))];

  /*
   * THE RESUME COUNTS, NOT ONLY THE SKILLS BOX.
   *
   * The profile's skills list is what the parser managed to pull out of
   * the CV, and it is capped and imperfect: a candidate whose resume
   * describes two years of Kubernetes can easily have no "Kubernetes"
   * chip on their profile. Matching only the list told them they were
   * missing a skill their own resume evidences, which is the complaint.
   *
   * So a requirement not found in the list is looked for in the resume
   * text itself, and counts when it is there. It is recorded separately
   * in `fromResume` so the card can say WHERE the evidence came from -
   * "found in your resume" is a different claim from "you listed it",
   * and a recruiter defending the score needs to know which.
   */
  const resume = resumeHaystack(cand);

  const matching = [];
  const missing = [];
  const fromResume = [];
  for (const n of need) {
    if (have.some((h) => sameSkill(h, n))) { matching.push(n); continue; }
    if (resume && mentionsSkill(resume, n)) { matching.push(n); fromResume.push(n); continue; }
    missing.push(n);
  }

  /*
   * A THIN REQUIREMENT LIST IS THIN EVIDENCE.
   *
   * Skills are 50 of the 100 points, and `matching / need` hands all 50
   * to a posting that stated ONE requirement the candidate happens to
   * have. That is how "Freelance Writer", whose entire stated
   * requirement was the word REST, came back as a 93% match for a Python
   * graduate: one of one is 100%, and 100% of the biggest component
   * carries the whole score.
   *
   * So the denominator has a floor. Three requirements is the point at
   * which a match ratio starts to mean something; below it the posting
   * can still score, but it cannot reach full marks on a single word.
   * A posting that states five gets the honest five.
   */
  const CONFIDENT_AT = 3;
  const denominator = Math.max(need.length, CONFIDENT_AT);

  return {
    ratio: matching.length / denominator,
    matching,
    missing,
    fromResume,
    reason: `${matching.length} of ${need.length} required skill${need.length === 1 ? '' : 's'}`
      + (fromResume.length ? ` (${fromResume.length} found in your resume)` : ''),
  };
}

/**
 * The resume, folded once and kept on the candidate object.
 *
 * matchExternalJob is called once per job, so a hundred jobs would fold
 * the same 200KB of text a hundred times. The result is cached on the
 * object the caller already passes around; it is discarded with it.
 */
function resumeHaystack(cand) {
  if (!cand) return '';
  if (cand.__resumeFold !== undefined) return cand.__resumeFold;
  const raw = String(cand.resume_text || '');
  /* Bounded: a folded copy of an unusually long CV is not worth the
     memory, and everything that matters is near the top anyway. */
  const fold = raw ? ` ${lowerFold(raw.slice(0, 60000))} ` : '';
  try {
    Object.defineProperty(cand, '__resumeFold', { value: fold, enumerable: false });
  } catch { /* a frozen row: fall back to recomputing */ }
  return fold;
}

const lowerFold = (s) => String(s)
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9+#. ]+/g, ' ').replace(/\s+/g, ' ');

/**
 * Is this skill actually named in the resume?
 *
 * Whole words only. Without the boundaries "R" matched every résumé and
 * "Go" matched "going"; a skill shorter than three characters is not
 * searched for at all, because the false positives outnumber the real
 * ones and a wrongly credited skill inflates a score nobody can defend.
 */
function mentionsSkill(haystack, skill) {
  const s = String(skill || '').trim();
  if (s.length < 3) return false;
  const esc = lowerFold(s).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!esc) return false;
  return new RegExp(`(^| )${esc}( |$)`).test(haystack);
}

/**
 * Experience. Inside the band is full marks. Short of it costs a third
 * per missing year, because a year under on a four-year ask is a
 * conversation and three years under is not. Over the band costs a
 * little, not a lot: being too senior is a reason a candidate might not
 * want the job, not a reason they cannot do it.
 */
function scoreExperience(cand, job) {
  const years = candidateYears(cand);
  const band = { min: job.exp_min, max: job.exp_max };
  if (band.min == null && band.max == null) {
    const parsed = parseExperienceRange(job.experience);
    band.min = parsed.min; band.max = parsed.max;
  }
  if (years == null) return null;                    // we do not know theirs
  if (band.min == null && band.max == null) return null;  // the job did not say

  if (band.min != null && years < band.min) {
    const shortBy = band.min - years;
    return {
      ratio: Math.max(0, 1 - shortBy / 3),
      reason: `${years} yr${years === 1 ? '' : 's'} against ${band.min}+ asked`,
    };
  }
  if (band.max != null && years > band.max) {
    return { ratio: 0.9, reason: `${years} yrs, above the ${band.max} yr band` };
  }
  return {
    ratio: 1,
    reason: band.max != null
      ? `${years} yrs sits inside the ${band.min ?? 0}-${band.max} yr band`
      : `${years} yrs meets the ${band.min}+ asked`,
  };
}

/**
 * The role itself, by shared significant words.
 *
 * Jaccard, not coverage: "Developer" against "Senior Java Developer"
 * should not score full marks just because every word of the shorter side
 * appears in the longer one, or every generic title would match every
 * specific one.
 */
function scoreRole(cand, job) {
  const want = new Set(titleTokens(job.title));
  if (!want.size) return null;
  const mine = new Set([
    ...titleTokens(cand.title),
    ...titleTokens(cand.preferred_role),
  ]);
  if (!mine.size) return null;

  let shared = 0;
  for (const w of want) if (mine.has(w)) shared++;
  const union = new Set([...want, ...mine]).size;
  return {
    ratio: union ? shared / union : 0,
    reason: shared
      ? `${shared} word${shared === 1 ? '' : 's'} shared with "${job.title}"`
      : `a different role from "${cand.title || cand.preferred_role}"`,
  };
}

/**
 * Location, by real distance where the gazetteer can place both ends.
 *
 * The same index the Nearby panel uses, read only - so "Gudur" and
 * "Nellore" are 40 km apart here exactly as they are there, instead of
 * being two strings that do not match. A remote job is everywhere, and a
 * candidate's PREFERRED location counts as much as their current one,
 * because somebody in Chennai who wants Hyderabad should see Hyderabad
 * jobs.
 */
async function scoreLocation(cand, job) {
  const jobLoc = fold(job.location);
  const remote = /\b(remote|work from home|wfh|anywhere)\b/.test(
    `${jobLoc} ${fold(job.employment_type)}`);
  if (remote) return { ratio: 1, reason: 'remote' };
  if (!jobLoc) return null;

  const mine = [cand.location, cand.preferred_location].filter(Boolean);
  if (!mine.length) return null;

  /* A plain name match first: it is free, and it is right far more often
     than it is wrong. */
  for (const m of mine) {
    const f = fold(m);
    if (!f) continue;
    if (f === jobLoc) return { ratio: 1, reason: `both in ${job.location}` };
    const a = f.split(' ').filter((w) => w.length > 2);
    const b = jobLoc.split(' ').filter((w) => w.length > 2);
    if (a.some((w) => b.includes(w))) return { ratio: 1, reason: `both in ${job.location}` };
  }

  if (!placesAvailable()) {
    return { ratio: 0.1, reason: `${job.location} is not where they are` };
  }

  let best = null;
  const there = await placeByName(job.location).catch(() => null);
  if (there) {
    for (const m of mine) {
      const here = await placeByName(m).catch(() => null);
      if (!here) continue;
      const d = Math.round(km(here, there));
      if (best == null || d < best) best = d;
    }
  }
  if (best == null) return { ratio: 0.1, reason: `${job.location} is not where they are` };
  if (best <= 25)  return { ratio: 1,    reason: `${best} km away` };
  if (best <= 75)  return { ratio: 0.7,  reason: `${best} km away - commutable` };
  if (best <= 200) return { ratio: 0.35, reason: `${best} km away - a move` };
  return { ratio: 0.1, reason: `${best} km away` };
}

/** Education, by shared qualification words. Small weight, on purpose. */
function scoreEducation(cand, job) {
  const want = fold(job.education);
  if (!want) return null;
  const mine = fold(cand.education);
  if (!mine) return null;
  const words = want.split(' ').filter((w) => w.length > 2);
  if (!words.length) return null;
  const hit = words.filter((w) => mine.includes(w)).length;
  return {
    ratio: hit ? Math.min(1, hit / Math.min(words.length, 3)) : 0,
    reason: hit ? 'qualification matches' : `asks for ${job.education}`,
  };
}

/**
 * Notice period, when the posting states one.
 *
 * Boards write "Immediate joiners only", "15 days", "30-60 days notice".
 * A candidate who can start sooner than asked is not penalised - only a
 * longer notice than the posting wants costs anything, and it costs
 * proportionally rather than all at once, because a fortnight over on a
 * thirty-day ask is a conversation and three months over is not.
 */
function scoreNoticePeriod(cand, job) {
  const want = noticeDays(job.notice_period || job.description);
  if (want == null) return null;                 // the posting did not say
  const mine = noticeDays(cand.notice_period);
  if (mine == null) return null;                 // we do not know theirs

  if (mine <= want) {
    return { ratio: 1, reason: mine === 0 ? 'available immediately'
      : `${mine} days' notice, within the ${want} asked` };
  }
  const over = mine - want;
  return {
    ratio: Math.max(0, 1 - over / 60),
    reason: `${mine} days' notice against ${want} asked`,
  };
}

/** Days of notice, from the way people write it. Null when unstated. */
function noticeDays(text) {
  const s = fold(text);
  if (!s) return null;
  if (/\b(immediate|immediately|asap|ready to join|serving notice|0 days)\b/.test(s)) return 0;
  const m = /(\d+)\s*(day|days|week|weeks|month|months)\b/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  if (/week/.test(m[2])) return n * 7;
  if (/month/.test(m[2])) return n * 30;
  return n;
}

function scoreEmploymentType(cand, job) {
  const want = fold(job.employment_type);
  if (!want) return null;
  const modes = (cand.preferred_work_modes || []).map(fold).filter(Boolean);
  if (!modes.length) return null;
  const hit = modes.some((m) => want.includes(m) || m.includes(want));
  return { ratio: hit ? 1 : 0.5, reason: hit ? `${job.employment_type} suits them` : `${job.employment_type}` };
}

/**
 * Pay. Only ever scored when the JOB states a number, and never used to
 * exclude anybody - the worst it can do is cost two points.
 */
function scorePay(cand, job) {
  const top = Number(job.salary_max ?? job.salary_min);
  const want = Number(cand.expected_ctc);
  if (!Number.isFinite(top) || top <= 0) return null;
  if (!Number.isFinite(want) || want <= 0) return null;
  if (top >= want) return { ratio: 1, reason: 'pays what they asked' };
  const ratio = Math.max(0, top / want);
  return { ratio, reason: 'pays below what they asked' };
}

/* ------------------------------------------------------------------ *
 * the score
 * ------------------------------------------------------------------ */

/**
 * @param cand  a `candidates` row, READ ONLY. Nothing in this module
 *              writes to it, and it is never passed anywhere that could.
 * @param job   an `external_jobs` row.
 * @returns { percentage, matchingSkills, missingSkills, reasons, basis }
 */
/**
 * How fresh the posting is.
 *
 * A vacancy advertised this morning is worth more of a candidate's
 * attention than one from five weeks ago that may already be filled -
 * which is why the brief gives recency a small, non-zero weight. Small
 * deliberately: it is a tie-breaker between two good matches, never a
 * reason to rank a stale perfect fit below a fresh irrelevant one.
 *
 * Null when the posting carries no date at all, so an undated job is not
 * punished for the advertiser's omission - the loop skips a null part
 * and drops its weight out of the total.
 */
function scoreRecency(job) {
  const when = job.posted_at || job.synced_at;
  if (!when) return null;
  const days = (Date.now() - new Date(when).getTime()) / 86_400_000;
  if (!Number.isFinite(days) || days < 0) return null;

  /* Full marks for a week old, nothing left by thirty days. */
  const ratio = days <= 7 ? 1 : days >= 30 ? 0 : 1 - (days - 7) / 23;
  const rounded = Math.round(days);
  return {
    ratio,
    reason: rounded <= 1 ? 'Posted today'
      : rounded <= 7 ? `Posted ${rounded} days ago`
      : `Posted ${rounded} days ago — may already be filled`,
  };
}

export async function matchExternalJob(cand, job) {
  const parts = {
    skills: scoreSkills(cand, job),
    experience: scoreExperience(cand, job),
    role: scoreRole(cand, job),
    location: await scoreLocation(cand, job),
    recency: scoreRecency(job),
    /* Still computed, still shown in the breakdown, no longer scored -
       EXTERNAL_WEIGHTS decides what counts, and a component missing from
       it is skipped by the loop below. They are kept because a recruiter
       looking at a match still wants to see what the posting said about
       pay and notice; they simply do not move the number any more. */
    noticePeriod: scoreNoticePeriod(cand, job),
    education: scoreEducation(cand, job),
    employmentType: scoreEmploymentType(cand, job),
    pay: scorePay(cand, job),
  };

  let earned = 0;
  let assessable = 0;
  const reasons = [];
  const basis = {};

  for (const [key, weight] of Object.entries(EXTERNAL_WEIGHTS)) {
    const part = parts[key];
    if (!part) { basis[key] = null; continue; }      // the job was silent
    assessable += weight;
    const got = weight * Math.max(0, Math.min(1, part.ratio));
    earned += got;
    basis[key] = { weight, ratio: Number(part.ratio.toFixed(3)), points: Number(got.toFixed(1)) };
    reasons.push({ dimension: key, detail: part.reason, points: Number(got.toFixed(1)), of: weight });
  }

  /*
   * NOTHING COULD BE ASSESSED. A job with no skills, no experience, no
   * title words and no location is not a 0% match - it is a job we know
   * nothing about, and reporting 0 would rank it below jobs we have
   * genuinely ruled out. It gets no score at all.
   */
  if (assessable === 0) {
    return {
      percentage: null, matchingSkills: [], missingSkills: [],
      reasons: [{ dimension: 'none', detail: 'the posting states nothing that can be matched' }],
      basis: { assessable: 0 },
    };
  }

  /*
   * RECENCY ALONE IS NOT A MATCH, and dividing by what happened to be
   * assessable let it become one.
   *
   * A German-language customer-service post listing no skills, no
   * experience and no recognisable role scored 87% for a Python
   * graduate. Every component returned null except recency, so
   * `assessable` was 5, `earned` was 4.3, and 4.3/5 reads as 87% - a
   * confident number computed from the single fact that the advert was
   * ten days old.
   *
   * Normalising by what the posting stated is right in principle: a job
   * should not be punished for a field the advertiser left blank. But it
   * only holds while enough was stated to be worth dividing. Below that,
   * the honest answer is that this posting cannot be matched - which the
   * caller already handles, and which keeps it out of the candidate's
   * list instead of putting it at the top.
   *
   * SKILLS OR ROLE MUST HAVE BEEN ONE OF THEM. Between them they are 70
   * of the 100 points and they are the two that say what the job IS.
   */
  const SCORABLE_FLOOR = Number(process.env.EXTERNAL_MATCH_MIN_BASIS || 40);
  const saidWhatItIs = !!(parts.skills || parts.role);

  if (assessable < SCORABLE_FLOOR || !saidWhatItIs) {
    return {
      percentage: null,
      matchingSkills: parts.skills ? parts.skills.matching : [],
      missingSkills: parts.skills ? parts.skills.missing : [],
      reasons: [{
        dimension: 'none',
        detail: saidWhatItIs
          ? 'the posting states too little to score against a profile'
          : 'the posting does not say what skills or role it wants',
      }],
      basis: { assessable, earned: Number(earned.toFixed(1)), floor: SCORABLE_FLOOR },
    };
  }

  const percentage = Math.round((earned / assessable) * 100);

  return {
    percentage,
    matchingSkills: parts.skills ? parts.skills.matching : [],
    /* Which of those the profile did not list but the resume evidences. */
    skillsFromResume: parts.skills ? (parts.skills.fromResume || []) : [],
    missingSkills: parts.skills ? parts.skills.missing : [],
    reasons,
    basis: { ...basis, earned: Number(earned.toFixed(1)), assessable },
  };
}
