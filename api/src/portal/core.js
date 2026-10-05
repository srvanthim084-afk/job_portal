/**
 * Job portal upgrades - the shared rules (0095).
 *
 * Everything that decides something lives here, once, so the API, the
 * background sweeps and the tests read the same definition:
 *
 *   quick filter chips   what "Fresher" or "Walk-in" MEANS, as SQL
 *   match reasons        the screening score and its evidence
 *   one-click apply      which profile fields it needs
 *   last date            "end of that day in India", and days left
 *   sharing              the share code, the share text, the preview
 *
 * THE MATCH IS THE SCREENING MATCH. explainMatch() builds its inputs the
 * way screenApplication() does (toJob + company, toCandidate + resume
 * text) and scores them with scoreApplication() and the admin's AI
 * settings - so the percentage on a card is the one the application gets
 * when it is screened, and the one an alert quotes.
 */
import { randomBytes } from 'node:crypto';
import { toJob, toCandidate } from '../shapes.js';
import { matchCandidate, scoreSkills } from '../ai/match.js';
import { scoreApplication, loadAiSettings } from '../ai/screening.js';

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

/** How the job wrote a skill, for a canonical key the matcher returns. */
function skillDisplay(jobSkills) {
  const out = new Map();
  for (const raw of jobSkills || []) {
    const k = scoreSkills({ skills: [raw] }, { skills: [raw] }).matched[0];
    if (k && !out.has(k)) out.set(k, raw);
  }
  return (k) => out.get(k) || k;
}

/**
 * The score and the reasons behind it, for one candidate and one job.
 * `settings` is loadAiSettings(); pass it in when scoring many.
 */
export function explainMatch(jobRow, candRow, settings) {
  const { job, candidate } = screeningInputs(jobRow, candRow);
  const scored = scoreApplication({ job, candidate, settings });
  const m = matchCandidate(job, candidate, { threshold: settings.autoShortlistThreshold });
  const b = m.breakdown;
  const show = skillDisplay(job.skills);

  const matched = (b.skills.matched || []).map(show);
  const implied = (b.skills.implied || []).map(show);
  const missing = (b.skills.missing || []).map(show);

  const e = b.experience;
  const yrs = Number.isFinite(e.years) ? e.years : null;
  const experience = {
    fit: e.fit,                                   // inside | near | outside | far | unknown | unstated
    ok: e.fit === 'inside' || e.fit === 'near',
    years: yrs,
    band: e.band,
    required: job.exp || null,
  };

  const location = {
    ok: !!b.location.matched,
    reason: b.location.reason,
    jobLocation: job.location || null,
  };

  const want = Number(candidate.expectedCtc);
  const max = Number(job.salaryMax);
  let salary = { fit: 'unknown', ok: null, expected: Number.isFinite(want) ? want : null, offered: job.pay || null };
  if (Number.isFinite(want) && Number.isFinite(max) && max > 0) {
    salary = want <= max ? { ...salary, fit: 'within', ok: true }
      : want <= max * 1.15 ? { ...salary, fit: 'slightly_above', ok: false }
      : { ...salary, fit: 'above', ok: false };
  }

  /* The one line on a card: "✓ Java, Spring · ✓ 3 yrs · ✗ AWS". */
  const line = [];
  if (matched.length) line.push({ ok: true, text: matched.slice(0, 3).join(', ') });
  if (experience.fit !== 'unstated' && yrs != null) {
    line.push({ ok: experience.ok, text: `${yrs} yr${yrs === 1 ? '' : 's'}` });
  } else if (experience.fit === 'unknown') {
    line.push({ ok: false, text: 'experience not on profile' });
  }
  if (missing.length) line.push({ ok: false, text: missing.slice(0, 2).join(', ') });

  return {
    jobId: job.id,
    score: scored.score,
    verdict: scored.verdict,
    matchedSkills: matched,
    impliedSkills: implied,
    missingSkills: missing,
    skillsStated: b.skills.stated !== false,
    experience,
    location,
    salary,
    education: { ok: b.education.score > 0, reason: b.education.reason },
    line,
    breakdown: scored.breakdown,
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

/** A field worth printing: never "undefined", "null" or "[object Object]". */
export const cleanField = (v) => {
  if (v === undefined || v === null) return '';
  const s = String(v).trim();
  return s && !['undefined', 'null', '[object Object]'].includes(s) ? s : '';
};

/*
 * Sharing a job, candidate to candidate.
 *
 * The message reads as one person passing an opportunity to another -
 * "👋 Hi! I found this job opportunity and thought it might be suitable for
 * you." - followed by THAT job's own public details. Every line comes from
 * the job record and is left out when the job has no value for it; nothing
 * about the person sharing (no name, phone, email, candidate ID) and
 * nothing internal (stages, scores, recruiter, client or database ids) is
 * ever read. The walk-in block appears only for a walk-in job.
 *
 * The company is the name the job's own card shows to candidates (passed in
 * as `company`); a name containing "client" is never printed (0051).
 */
const WALKIN_CARRY_DEFAULT = ['Updated Resume – Hard Copy', 'A copy of this Job Post'];
const WALKIN_GATE_NOTE = 'The job post copy must be shown at the main gate entrance.';

const pick = (job, keys) => {
  for (const k of keys) { const v = cleanField(job && job[k]); if (v) return v; }
  return '';
};
const listOf = (v) => (Array.isArray(v) ? v : String(v || '').split(/\r?\n|;/))
  .map((x) => cleanField(String(x).replace(/^[\s•\-*]+/, ''))).filter(Boolean);

/** "09:00" -> "9:00 AM"; anything else as written. */
function clock(t) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t || '').trim());
  if (!m) return cleanField(t);
  let hh = Number(m[1]); const ap = hh >= 12 ? 'PM' : 'AM';
  hh = hh % 12 || 12;
  return `${hh}:${m[2]} ${ap}`;
}
/** "2026-10-10" -> "10 October 2026"; anything else as written. */
function longDate(d) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d || '').trim());
  if (!m) return cleanField(d);
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${Number(m[3])} ${months[Number(m[2]) - 1]} ${m[1]}`;
}
export const isWalkinJob = (job) => !!job && (job.postingKind === 'walkin' || job.jobType === 'walk-in'
  || /^walk.?in$/i.test(String(job.type || '')));
const freshersWelcome = (exp) => /fresher|^\s*0\s*(?:[-–—+]|to\b|$)/i.test(String(exp || ''));
function homeWork(mode) {
  const m = String(mode || '').toLowerCase();
  if (!m) return '';
  if (/remote|home|wfh/.test(m)) return 'Available';
  if (/hybrid/.test(m)) return 'Hybrid';
  return 'Not Available';
}
const safeCompany = (c) => { const v = cleanField(c); return v && !/\bclient\b/i.test(v) ? v : ''; };
const mapLink = (u) => {
  const v = cleanField(u);
  return /^https:\/\/(www\.)?(google\.[a-z.]+\/maps|maps\.google\.[a-z.]+|maps\.app\.goo\.gl|goo\.gl\/maps)/i.test(v) ? v : '';
};

/** The message without its closing link - the phone's own share sheet adds the URL itself. */
export function shareLines(job, { company = '' } = {}) {
  const j = job || {};
  const title = cleanField(j.title) || 'Job Opportunity';
  const out = ['👋 Hi! I found this job opportunity and thought it might be suitable for you.', ''];
  out.push(`📢 ${j.urgent ? 'Urgent Hiring – ' : ''}${title}`);
  const co = safeCompany(company);
  if (co) out.push(`🏢 ${co}`);
  const edu = pick(j, ['education', 'qualification']);
  if (edu) out.push(`🎓 Qualification: ${edu}`);
  const exp = pick(j, ['exp', 'experience']);
  if (exp) out.push(`💼 Experience: ${exp}`);
  if (freshersWelcome(exp)) out.push('🌟 Freshers Can Apply');
  const pay = pick(j, ['pay', 'salary']) || (Number(j.stipend) > 0 ? `₹${j.stipend} stipend` : '');
  if (pay) out.push(`💰 Salary: ${pay}`);
  const loc = pick(j, ['location']);
  if (loc) out.push(`📍 Location: ${loc}`);
  const walk = isWalkinJob(j);
  const type = pick(j, ['type', 'employmentType']);
  if (type && !/^walk.?in$/i.test(type)) out.push(`💼 Job Type: ${type}`);
  const wfh = homeWork(j.mode);
  if (wfh) out.push(`🏢 Work From Home: ${wfh}`);
  const reqs = listOf(j.requirements).slice(0, 6);
  if (reqs.length) out.push('', '✅ Requirements', ...reqs.map((r) => `• ${r}`));

  if (walk) {
    out.push('', '🚶 Walk-In Interview');
    const date = longDate(pick(j, ['walkinDate']));
    if (date) out.push(`📅 Walk-In Date: ${date}`);
    const from = clock(pick(j, ['walkinStartTime', 'walkinFrom']));
    const to = clock(pick(j, ['walkinEndTime', 'walkinTo']));
    if (from || to) out.push(`⏰ Interview Time: ${[from, to].filter(Boolean).join(' – ')}`);
    const carry = listOf(j.walkinDocumentsToCarry || j.walkinDocuments);
    out.push('📄 Please carry:', ...(carry.length ? carry : WALKIN_CARRY_DEFAULT).map((d) => `• ${d}`));
    out.push(`⚠️ Important: ${WALKIN_GATE_NOTE}`);
    const notes = cleanField(j.walkinInstructions);
    if (notes) out.push(`ℹ️ ${notes}`);
    const venue = pick(j, ['walkinVenue']);
    const address = pick(j, ['walkinAddress']);
    if (venue || address) {
      out.push('', '📍 Venue:');
      if (venue) out.push(venue);
      if (address && address !== venue) out.push(...String(address).split(/\r?\n/).map((x) => x.trim()).filter(Boolean));
    }
    const maps = mapLink(j.walkinMapLink);
    if (maps) out.push(`📍 Get Directions: ${maps}`);
    const phone = pick(j, ['walkinContactNumber', 'walkinPhone']);
    const person = pick(j, ['walkinContactPerson', 'walkinContact']);
    if (phone || person) out.push(`📞 Contact: ${[person, phone].filter(Boolean).join(' – ')}`);
  }
  return out;
}

/** The whole message, the job's link last. */
export function shareText(job, link, opts = {}) {
  const lines = shareLines(job, opts);
  lines.push('', `👉 View Job & Apply: ${link}`);
  return lines.join('\n');
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
