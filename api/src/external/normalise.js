/**
 * Turning whatever a source sent into an `external_jobs` row.
 *
 * Every board describes a vacancy differently and most of them describe
 * it badly: experience as "2-4 yrs", pay as "₹12-18 LPA", skills as one
 * comma-separated string, location as "Hyderabad / Secunderabad, Telangana
 * (Hybrid)". The row has to be uniform or the matcher cannot read it, and
 * the original has to survive or a wrong parse can never be diagnosed -
 * so the parsed fields go in columns and the payload goes in `raw`.
 *
 * Nothing here talks to the database, so it is testable on its own and
 * cannot accidentally write anywhere.
 */
import { toRupees } from '../money.js';
import { parseExperienceRange } from './matching.js';

/**
 * The id convention already in use for candidates
 * (`api/src/routes/auth.js`), kept identical so nothing in the system has
 * to learn a second shape.
 */
export function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

const text = (v, max = 4000) => {
  const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
};

const fold = (s) => String(s == null ? '' : s)
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9+#. ]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Skills, from whichever shape arrived.
 *
 * A feed sends an array; a scraped card sends "Java, Spring Boot | SQL";
 * a careers page sends one sentence. Splitting on commas, pipes, slashes
 * and semicolons - but NOT on spaces, or "Spring Boot" becomes two
 * skills and neither of them matches anything.
 */
export function toSkillList(value, { max = 40 } = {}) {
  const raw = Array.isArray(value) ? value : String(value == null ? '' : value).split(/[,|;/\n•]+/);
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const s = String(item == null ? '' : item).replace(/\s+/g, ' ').trim();
    if (!s || s.length < 2 || s.length > 60) continue;
    const key = fold(s);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * The salary band in rupees per year.
 *
 * `toRupees` is reused rather than reimplemented - it already knows that
 * "18" means eighteen lakh and "1800000" does not - and it is only ever
 * called, never changed.
 */
export function toSalaryBand(value) {
  const s = String(value == null ? '' : value);
  if (!s.trim()) return { min: null, max: null };
  if (/\b(negotiable|not disclosed|as per|best in|unpaid|open)\b/i.test(s)
      && !/\d/.test(s)) return { min: null, max: null };

  const range = /(\d[\d,.]*)\s*(?:-|to|–)\s*(\d[\d,.]*)/.exec(s);
  if (range) {
    /* The unit is usually written once, after the second number, so both
       halves have to be read in the context of the whole string. */
    const unit = /lakh|lac|lpa/i.test(s) ? ' LPA' : /\bk\b|thousand/i.test(s) ? '000' : '';
    return { min: toRupees(range[1] + unit), max: toRupees(range[2] + unit) };
  }
  const one = toRupees(s);
  return { min: one, max: one };
}

/**
 * Two postings that are the same vacancy.
 *
 * The key is the significant words of the title, SORTED, plus the company
 * and the city - so "Senior Java Developer" and "Java Developer Senior"
 * at the same employer in the same city collapse together, while the same
 * title at a different company does not.
 *
 * Sorting is what makes it work across boards, because each one rewrites
 * the title in its own order. The company is mandatory: without it every
 * "Staff Nurse" in Hyderabad would be one vacancy, which is the opposite
 * of useful.
 *
 * Returns null when there is not enough to be confident, and a null key
 * never joins a group - a guess that merges two real vacancies hides one
 * of them from every candidate, which is worse than showing a duplicate.
 */
export function dedupeKey({ title, company, location }) {
  const NOISE = new Set(['a', 'an', 'the', 'and', 'or', 'for', 'with', 'in', 'at', 'of', 'to',
    'job', 'jobs', 'role', 'position', 'vacancy', 'opening', 'openings', 'required',
    'urgent', 'urgently', 'immediate', 'joiners', 'apply', 'now', 'hiring', 'walkin',
    'multiple', 'india', 'exp', 'yrs', 'years']);

  const words = fold(title).split(' ').filter((w) => w.length > 1 && !NOISE.has(w));
  const co = fold(company);
  if (words.length < 1 || !co) return null;

  /* The city, not the full address: "Hyderabad, Telangana (Hybrid)" and
     "Hyderabad" are one place. */
  const city = fold(String(location || '').split(/[,(/]/)[0]);

  return `${words.slice().sort().join('-')}|${co}|${city}`;
}

/**
 * One raw posting from a source, as the columns of `external_jobs`.
 *
 * @param raw     whatever the provider produced, already a plain object
 * @param source  the `job_sources` row it came from
 * @returns null when the posting is unusable - no id or no title - because
 *          a row with neither cannot be matched, shown, or applied to.
 */
export function normaliseExternalJob(raw, source) {
  const externalId = text(raw.externalJobId ?? raw.external_job_id ?? raw.id ?? raw.jobId, 200);
  const title = text(raw.title ?? raw.jobTitle ?? raw.designation, 300);
  if (!externalId || !title) return null;

  const experience = text(raw.experience ?? raw.exp ?? raw.experienceRange, 80);
  const expBand = parseExperienceRange(experience);
  const salary = text(raw.salary ?? raw.ctc ?? raw.pay ?? raw.compensation, 120);
  const payBand = toSalaryBand(salary);

  const posted = raw.postedAt ?? raw.posted_at ?? raw.datePosted ?? raw.createdAt;
  const postedAt = posted ? new Date(posted) : null;

  return {
    sourceId: source.id,
    externalJobId: externalId,
    title,
    company: text(raw.company ?? raw.companyName ?? raw.employer, 200),
    location: text(raw.location ?? raw.city ?? raw.jobLocation, 200),
    description: text(raw.description ?? raw.jobDescription ?? raw.summary, 20000),
    skills: toSkillList(raw.skills ?? raw.keySkills ?? raw.tags),
    experience,
    expMin: Number.isFinite(Number(raw.expMin)) ? Number(raw.expMin) : expBand.min,
    expMax: Number.isFinite(Number(raw.expMax)) ? Number(raw.expMax) : expBand.max,
    salary,
    salaryMin: payBand.min,
    salaryMax: payBand.max,
    employmentType: text(raw.employmentType ?? raw.employment_type ?? raw.jobType, 60),
    industry: text(raw.industry ?? raw.sector, 120),
    education: text(raw.education ?? raw.qualification, 200),
    applicationUrl: httpUrl(raw.applicationUrl ?? raw.application_url ?? raw.url ?? raw.applyUrl),
    applyEmail: emailOrNull(raw.applyEmail ?? raw.apply_email ?? raw.contactEmail),
    postedAt: postedAt && !Number.isNaN(postedAt.getTime()) ? postedAt : null,
    status: ['open', 'closed', 'expired', 'removed'].includes(String(raw.status))
      ? String(raw.status) : 'open',
    dedupeKey: dedupeKey({
      title,
      company: raw.company ?? raw.companyName ?? raw.employer,
      location: raw.location ?? raw.city ?? raw.jobLocation,
    }),
    /* 0067's columns, carried through at last (0078). The board the
       advert actually lives on is not the source we found it through,
       and a candidate about to click Apply is entitled to know which
       site they are about to land on. */
    originalPublisher: text(raw.originalPublisher ?? raw.original_publisher
      ?? raw.publisher ?? raw.via, 120),
    city: text(raw.city, 120),
    state: text(raw.state ?? raw.region, 120),
    country: text(raw.country, 80),
    raw,
  };
}

/**
 * Only http(s), and only as a string.
 *
 * A posting is untrusted input that ends up in an href, so a
 * `javascript:` or `data:` URL arriving from a feed must not survive to
 * reach a candidate's browser.
 */
function httpUrl(v) {
  const s = text(v, 2000);
  if (!s) return null;
  try {
    const u = new URL(s);
    return (u.protocol === 'http:' || u.protocol === 'https:') ? u.toString() : null;
  } catch { return null; }
}

function emailOrNull(v) {
  const s = text(v, 200);
  if (!s) return null;
  return /^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(s) ? s : null;
}
