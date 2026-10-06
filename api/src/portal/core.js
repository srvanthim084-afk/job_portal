/**
 * Job portal upgrades - the shared rules (0095).
 *
 * Everything that decides something lives here, once, so the API, the
 * background sweeps and the tests read the same definition:
 *
 *   quick filter chips   what "Fresher" or "Walk-in" MEANS, as SQL
 *   match reasons        the AI Match score (skills only) and its reasons
 *   one-click apply      which profile fields it needs
 *   last date            "end of that day in India", and days left
 *   sharing              the share code, the share text, the preview
 *
 * THE MATCH IS THE AI MATCH (owner, 2026-10-05). explainMatch() builds its
 * inputs the way screening does (toJob + company, toCandidate + resume
 * text) and scores them with aiMatch() - JD skills matched / JD skills
 * required, nothing else - so the percentage on a card is the one in
 * "Why this match?" and the one an alert quotes. Recruiter screening
 * (scoreApplication) is a separate, recruiter-only number.
 */
import { randomBytes } from 'node:crypto';
import { toJob, toCandidate } from '../shapes.js';
import { scoreExperience, scoreLocation, scoreEducation } from '../ai/match.js';
import { aiMatch } from '../ai/ai-match.js';
import { loadAiSettings } from '../ai/screening.js';
import { jobOpportunityMessages, cleanField, isWalkinJob, safeCompany } from '../notify/job-opportunity.js';

/* ------------------------------------------------------------------ *
 * time in India
 * ------------------------------------------------------------------ */

const IST_MS = 330 * 60 * 1000;

/** 'YYYY-MM-DD' of the IST calendar day `at` falls on. */
export function istDay(at = Date.now()) {
  return new Date(new Date(at).getTime() + IST_MS).toISOString().slice(0, 10);
}

/** The last instant of an IST calendar day, as a Date. */
export function endOfIstDay(ymd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ymd || ''))) return null;
  const d = new Date(`${ymd}T23:59:59.999+05:30`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Whole IST calendar days from `now` to the deadline: 0 = last day today. */
export function daysLeft(expiresAt, now = Date.now()) {
  if (!expiresAt) return null;
  const a = Date.parse(`${istDay(now)}T00:00:00Z`);
  const b = Date.parse(`${istDay(expiresAt)}T00:00:00Z`);
  return Math.round((b - a) / 86400000);
}

/* ------------------------------------------------------------------ *
 * 1. quick filter chips
 * ------------------------------------------------------------------ */

export const QUICK_CHIPS = [
  { key: 'fresher', label: 'Fresher' },
  { key: 'wfh', label: 'Work from home' },
  { key: 'immediate', label: 'Immediate joining' },
  { key: 'near_me', label: 'Near me' },
  { key: 'today', label: 'Posted today' },
  { key: 'urgent', label: 'Urgent hiring' },
  { key: 'salary3', label: 'Salary 3 LPA+' },
  { key: 'walkin', label: 'Walk-in' },
  /* 0106: walk-in dates, in India - today, and today to Sunday. */
  { key: 'walkin_today', label: 'Walk-in today' },
  { key: 'walkin_week', label: 'Walk-in this week' },
  { key: 'internship', label: 'Internship' },
];
export const CHIP_KEYS = new Set(QUICK_CHIPS.map((c) => c.key));

/**
 * The SQL each chip adds, against jobs_open / jobs_with_counts columns.
 * near_me is not here: it needs the place tree and is applied after the
 * query (nearMeFilter below).
 */
export const CHIP_SQL = {
  /* The band starts at nothing: "Fresher", "Entry level", "0-2 yrs". */
  fresher: `(coalesce(exp_label,'') ~* '(fresher|entry)' or coalesce(exp_label,'') ~ '^[^0-9]*0([^0-9.]|$)')`,
  wfh: `(coalesce(mode,'') ~* '(remote|work from home|wfh)' or coalesce(location,'') ~* '^(remote|work from home|wfh|anywhere)$')`,
  /* There is no column for it: the advert has to say so. */
  immediate: `((coalesce(title,'') || ' ' || coalesce(description,'') || ' ' || coalesce(array_to_string(requirements,' '),''))
               ~* 'immediate(ly)?[ -]*(join|start)')`,
  today: `(published_at >= ((date_trunc('day', now() at time zone 'Asia/Kolkata')) at time zone 'Asia/Kolkata'))`,
  urgent: `(urgent and urgent_until > now())`,
  salary3: `(coalesce(salary_max, salary_min, 0) >= 3)`,
  walkin: `(coalesce(employment_type,'') ~* '^walk' or posting_kind = 'walkin' or walkin_date is not null)`,
  internship: `(posting_kind = 'internship' or coalesce(employment_type,'') ~* 'intern')`,
  walkin_today: `(posting_kind = 'walkin' and walkin_date = to_char(now() at time zone 'Asia/Kolkata', 'YYYY-MM-DD'))`,
  walkin_week: `(posting_kind = 'walkin' and length(coalesce(walkin_date,'')) = 10
                 and walkin_date >= to_char(now() at time zone 'Asia/Kolkata', 'YYYY-MM-DD')
                 and walkin_date <= to_char(date_trunc('week', now() at time zone 'Asia/Kolkata') + interval '6 days', 'YYYY-MM-DD'))`,
};

/** "fresher,urgent" -> ['fresher','urgent'], unknown keys dropped. */
export function parseChips(raw) {
  const list = Array.isArray(raw) ? raw : String(raw || '').split(',');
  return [...new Set(list.map((s) => String(s).trim().toLowerCase()).filter((k) => CHIP_KEYS.has(k)))];
}

/** The admin's chip list, in their order, with anything unknown removed. */
export function normaliseChipSettings(value) {
  const given = Array.isArray(value && value.chips) ? value.chips : [];
  const seen = new Set();
  const out = [];
  for (const c of given) {
    const key = String((c && c.key) || '').trim();
    if (!CHIP_KEYS.has(key) || seen.has(key)) continue;
    seen.add(key);
    const def = QUICK_CHIPS.find((x) => x.key === key);
    const label = String((c && c.label) || def.label).trim().slice(0, 40) || def.label;
    out.push({ key, label, enabled: c.enabled !== false });
  }
  /* A chip the admin's list does not mention is kept, switched off, so the
     editor can always offer all eight. */
  for (const def of QUICK_CHIPS) {
    if (!seen.has(def.key)) out.push({ key: def.key, label: def.label, enabled: false });
  }
  return out;
}

/**
 * Near me: jobs at, inside, or within `km` of the place. `place` is a
 * name ("Nellore") or {lat, lon}. Remote jobs are not "near" anybody -
 * Work from home is its own chip.
 */
export async function nearMeFilter(rows, place, km = 50) {
  if (!place) return [];
  const { locationTierFunction } = await import('../search/saved-match.js');
  if (typeof place === 'object' && Number.isFinite(place.lat) && Number.isFinite(place.lon)) {
    try {
      const { treeAvailable, treeResolver, treeDistanceKm } = await import('../place-tree.js');
      if (!treeAvailable()) return [];
      const resolve = await treeResolver();
      return rows.filter((r) => {
        const j = resolve(r.location);
        const d = j ? treeDistanceKm({ lat: place.lat, lon: place.lon }, j) : null;
        return d != null && d <= km;
      });
    } catch { return []; }
  }
  const tier = await locationTierFunction();
  return rows.filter((r) => {
    const t = tier(r.location, r.mode, [String(place)], km);
    return t === 'exact' || t === 'nearby';
  });
}

/* ------------------------------------------------------------------ *
 * 2. match reasons
 * ------------------------------------------------------------------ */

/** The candidate and job exactly as screening sees them. */
export function screeningInputs(jobRow, candRow) {
  return {
    job: { ...toJob(jobRow), companyName: jobRow.company_name },
    candidate: { ...toCandidate(candRow), resumeText: candRow.resume_text || '' },
  };
}

/** "Java, Python and SQL". */
const listWords = (a) => (a.length < 2 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);

function recommendationFor(ai, experience) {
  const few = (a, n) => listWords(a.slice(0, n));
  let out;
  if (!ai.stated) {
    out = 'This job does not list the skills it needs, so there is no AI Match yet - read the job description to judge the fit.';
  } else if (!ai.missing.length) {
    out = `You have all ${ai.required} skill${ai.required === 1 ? '' : 's'} this job lists`
      + (experience.ok ? ', and your experience fits what it asks for' : '') + ' - a strong job to apply for.';
  } else if (ai.matched.length * 2 >= ai.required) {
    out = `You have ${ai.matched.length} of the ${ai.required} skills this job lists. If you also know ${few(ai.missing, 2)}, `
      + `add ${Math.min(2, ai.missing.length) > 1 ? 'them' : 'it'} to your profile - that raises your AI Match.`;
  } else if (ai.matched.length) {
    out = `This job needs skills that are not on your profile yet, such as ${few(ai.missing, 3)}. `
      + `Your ${few(ai.matched, 2)} ${ai.matched.length === 1 ? 'is' : 'are'} a start - build the rest, or add them if you already have them.`;
  } else {
    out = `None of the ${ai.required} skills this job lists (${few(ai.missing, 3)}) are on your profile yet. `
      + 'Add them if you have them; otherwise this role is a target for later.';
  }
  if (experience.fit === 'unknown') out += ' Add your experience to your profile so recruiters can see it.';
  else if (experience.fit === 'far' || experience.fit === 'outside') {
    out += ` The job asks for ${experience.required}; your profile shows ${experience.profile || 'less'}.`;
  }
  return out;
}

/**
 * The candidate's AI Match for one job, and the reasons behind it.
 *
 * `score` is aiMatch() - JD skills matched / JD skills required - and
 * nothing else: it is the number on the card, in "Why this match?", in
 * the career assistant and in every alert that uses a match threshold.
 * null when the JD lists no skills (no percentage is shown, not 0%).
 *
 * Experience, location, salary, education and work mode are returned as
 * QUALITATIVE facts and reasons only. They never move the score.
 *
 * `_settings` is accepted for older callers and ignored: the AI Match has
 * no admin weights to read.
 */
export function explainMatch(jobRow, candRow, _settings) {
  const { job, candidate } = screeningInputs(jobRow, candRow);
  const ai = aiMatch(job, candidate);

  const e = scoreExperience(job, candidate);
  const yrs = Number.isFinite(e.years) ? e.years : null;
  const experience = {
    fit: e.fit,                                   // inside | near | outside | far | unknown | unstated
    ok: e.fit === 'inside' || e.fit === 'near',
    years: yrs,
    band: e.band,
    required: job.exp || null,
    profile: candidate.exp || (yrs != null ? `${yrs} yrs` : null),
  };

  const loc = scoreLocation(job, candidate);
  const location = {
    ok: !!loc.matched, reason: loc.reason, jobLocation: job.location || null,
    preferred: candidate.preferredLocation || candidate.location || null,
  };

  const want = Number(candidate.expectedCtc);
  const max = Number(job.salaryMax);
  let salary = { fit: 'unknown', ok: null, expected: Number.isFinite(want) ? want : null, offered: job.pay || null };
  if (Number.isFinite(want) && Number.isFinite(max) && max > 0) {
    salary = want <= max ? { ...salary, fit: 'within', ok: true }
      : want <= max * 1.15 ? { ...salary, fit: 'slightly_above', ok: false }
      : { ...salary, fit: 'above', ok: false };
  }

  const edu = scoreEducation(job, candidate);
  const education = { ok: edu.score > 0, reason: edu.reason };

  const modes = (candidate.preferredWorkModes || []).map((m) => String(m).toLowerCase());
  const jm = String(job.mode || '').toLowerCase();
  const modeOk = !!jm && modes.some((m) => m && (jm.includes(m) || m.includes(jm)));

  /* "Why this match?" - one row per reason that holds, built from THIS
     job and THIS profile. Skill gaps are not reasons (the card lists the
     missing skills separately), and none of these rows feeds the score. */
  const reasons = [];
  if (ai.matched.length) {
    reasons.push({ key: 'skills', text: `${ai.matched.length} of the ${ai.required} skills this job asks for `
      + `${ai.matched.length === 1 ? 'is' : 'are'} on your ${ai.fromResume.length ? 'profile or resume' : 'profile'}: ${listWords(ai.matched)}` });
  }
  if (experience.ok && yrs != null && job.exp) {
    reasons.push({ key: 'experience', text: `Your ${yrs} yr${yrs === 1 ? '' : 's'} of experience fits the ${job.exp} this job asks for` });
  }
  if (loc.matched && loc.reason === 'remote') {
    reasons.push({ key: 'location', text: `The job is ${job.mode || 'remote'}, so your location does not limit you` });
  } else if (loc.matched && job.location) {
    const city = String(loc.city || '').toLowerCase();
    const pref = !!city && String(candidate.preferredLocation || '').toLowerCase().includes(city);
    reasons.push({ key: 'location', text: `The job is in ${job.location}, which matches your ${pref ? 'preferred' : 'current'} location` });
  } else if (loc.reason === 'open to remote') {
    reasons.push({ key: 'location', text: `The job is ${job.mode}, and you are open to remote work` });
  }
  if (salary.ok === true) {
    reasons.push({ key: 'salary', text: `Offered ${job.pay || `up to ₹${max} LPA`} covers your expected ₹${want} LPA` });
  }
  if (edu.reason === 'qualification matches') {
    reasons.push({ key: 'education', text: `Your education${candidate.education ? ` (${candidate.education})` : ''} matches the requirement (${job.education})` });
  }
  if (modeOk) reasons.push({ key: 'mode', text: `${job.mode} matches your preferred work mode` });

  /* The AI Recommendation line: a sentence from THIS job and THIS profile.
     It explains the AI Match; it never adds a second number. */
  const recommendation = recommendationFor(ai, experience);

  /* The card's one-line summary, "✓ Java, Spring · ✓ 3 yrs · ✗ AWS" - words,
     never a percentage (the AI Match at the top is the card's only number). */
  const line = [];
  if (ai.matched.length) line.push({ ok: true, text: ai.matched.slice(0, 3).join(', ') });
  if (experience.fit !== 'unstated' && yrs != null) {
    line.push({ ok: experience.ok, text: `${yrs} yr${yrs === 1 ? '' : 's'}` });
  } else if (experience.fit === 'unknown') {
    line.push({ ok: false, text: 'experience not on profile' });
  }
  if (ai.missing.length) line.push({ ok: false, text: ai.missing.slice(0, 2).join(', ') });

  return {
    jobId: job.id,
    score: ai.score,
    basis: 'skills',
    required: ai.required,
    matchedCount: ai.matchedCount,
    matchedSkills: ai.matched,
    missingSkills: ai.missing,
    resumeSkills: ai.fromResume,
    skillsStated: ai.stated,
    experience,
    location,
    salary,
    education,
    reasons,
    recommendation,
    line,
  };
}

export { loadAiSettings };

/** Strictly above: 60 gets nothing, 60.01 does. */
export function aboveThreshold(score, threshold) {
  const s = Number(score), t = Number(threshold);
  return Number.isFinite(s) && Number.isFinite(t) && s > t;
}

/** NOTIFY_MATCH_THRESHOLD, read when it is used so it can change without code. */
export function notifyThreshold() {
  const v = Number(process.env.NOTIFY_MATCH_THRESHOLD);
  return Number.isFinite(v) && process.env.NOTIFY_MATCH_THRESHOLD !== '' ? v : 60;
}

/* ------------------------------------------------------------------ *
 * 4. one-click apply
 * ------------------------------------------------------------------ */

export const ONE_CLICK_FIELDS = ['name', 'phone', 'location', 'experience', 'skills', 'resume'];

/** What a candidate row still lacks for one-click apply, in a fixed order. */
export function missingForOneClick(r) {
  const has = (v) => v != null && String(v).trim() !== '';
  const out = [];
  if (!has(r.name)) out.push('name');
  if (!has(r.phone)) out.push('phone');
  if (!has(r.location) && !has(r.preferred_location)) out.push('location');
  if (!has(r.exp) && r.exp_years == null) out.push('experience');
  const skills = [...(r.skills || []), ...(r.technical_skills || [])].filter(has);
  if (!skills.length) out.push('skills');
  if (!has(r.resume_file)) out.push('resume');
  return out;
}

/* ------------------------------------------------------------------ *
 * 3. sharing
 * ------------------------------------------------------------------ */

export const SHARE_CHANNELS = ['native', 'whatsapp', 'copy', 'email', 'linkedin', 'other'];

export function newShareCode() {
  return randomBytes(6).toString('base64url');
}

/*
 * Sharing a job, candidate to candidate (owner, 2026-10-06: "when we share
 * the job description it should be like this only").
 *
 * The share message IS the job-alert message: notify/job-opportunity.js,
 * the same function every job alert uses, with the share link
 * (/job/<id>?ref=<code>, on PUBLIC_SHARE_URL) as its apply URL. Every line
 * comes from the job record and is left out when the job has no value for
 * it; nothing about the person sharing (no name, phone, email, candidate
 * ID) and nothing internal (stages, scores, recruiter, client or database
 * ids) is ever read. A walk-in job keeps its walk-in block, before the
 * apply CTA.
 *
 * The company is the name the job's own card shows to candidates (passed in
 * as `company`); a name containing "client" is never printed (0051).
 */
export { cleanField, isWalkinJob };
const freshersWelcome = (exp) => /fresher|^\s*0\s*(?:[-–—+]|to\b|$)/i.test(String(exp || ''));

const shareMessages = (job, link, { company = '' } = {}) =>
  jobOpportunityMessages(job || {}, { kind: 'share', applyUrl: link || '', company });

/** The message without its "🔗 <link>" line - the phone's own share sheet adds the URL itself. */
export function shareLines(job, opts = {}) {
  return shareMessages(job, '', opts).body.split('\n');
}

/** The whole message, WhatsApp *bold* and all, with the job's link in its CTA. */
export function shareText(job, link, opts = {}) {
  return shareMessages(job, link, opts).whatsapp;
}

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]', '::1'];
export const isLocalUrl = (u) => {
  try { return LOCAL_HOSTS.includes(new URL(u).hostname); } catch { return false; }
};

/**
 * The same link on the address the PUBLIC can open. Only the origin is
 * swapped - the path, the job id and ?ref= (share tracking) stay - and
 * only when a public base is configured and the link is local or on a
 * different origin.
 */
export function toPublicUrl(existingUrl, publicBase) {
  const base = cleanField(publicBase);
  let u;
  try { u = new URL(existingUrl); } catch { return existingUrl; }
  if (!base) return u.toString();
  let b;
  try { b = new URL(base); } catch { return u.toString(); }
  if (isLocalUrl(u.toString()) || u.origin !== b.origin) {
    u.protocol = b.protocol; u.hostname = b.hostname; u.port = b.port;
  }
  return u.toString();
}

const escHtml = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** The Open Graph block for a job's link preview. No company. */
/* "HR Recruiter – TeamLink Consultants" / "Urgent Hiring | Any Degree | Freshers
   Can Apply | KPHB, Hyderabad | ₹3 LPA": the job's own public facts. */
export function ogTags(job, { url, image, company = '' }) {
  const co = safeCompany(company);
  const title = [cleanField(job.title), co].filter(Boolean).join(' – ') || 'Job on TeamLink';
  const desc = [job.urgent ? 'Urgent Hiring' : '', isWalkinJob(job) ? 'Walk-in Interview' : '', cleanField(job.education),
    freshersWelcome(job.exp) ? 'Freshers Can Apply' : cleanField(job.exp), cleanField(job.location), cleanField(job.pay)]
    .filter(Boolean).join(' | ') || 'Apply on TeamLink';
  return [
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="TeamLink">`,
    `<meta property="og:title" content="${escHtml(title)}">`,
    `<meta property="og:description" content="${escHtml(desc)}">`,
    `<meta property="og:url" content="${escHtml(url)}">`,
    `<meta property="og:image" content="${escHtml(image)}">`,
    `<meta name="twitter:card" content="summary">`,
    `<meta name="twitter:title" content="${escHtml(title)}">`,
    `<meta name="twitter:description" content="${escHtml(desc)}">`,
    `<meta name="description" content="${escHtml(desc)}">`,
  ].join('\n');
}

export { escHtml };
