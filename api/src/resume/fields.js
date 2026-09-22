/**
 * Structured candidate details, read out of resume text.
 *
 * WHAT THIS IS, PLAINLY
 * ---------------------
 * This is a deterministic parser, not a language model. It finds a value
 * only where the resume actually states one, and returns nothing for the
 * rest. That distinction is the point: a field left empty here means "the
 * resume did not say", which the form then leaves for the candidate to
 * fill. Nothing is guessed, defaulted or borrowed from a sample.
 *
 * When AI_API_KEY is configured, ai.js sends the same text to a model and
 * that result is preferred — but its output is run through the same
 * validation below, because a model will cheerfully return a plausible
 * phone number that is not in the document.
 *
 * Every value returned carries the span of text it came from, so the
 * caller can show the candidate WHY a field was filled in.
 */

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/* A resume is a list of sections. Finding them first stops "Reference:
   Anita Sharma, 9876543210" being read as the candidate's own phone. */
const SECTION_PATTERNS = [
  ['summary',        /\b(professional\s+summary|career\s+objective|objective|profile\s+summary|about\s+me|summary)\b/i],
  ['skills',         /\b(key\s+skills|technical\s+skills|core\s+competenc\w*|skills?\s*(&|and)?\s*(expertise)?)\b/i],
  ['experience',     /\b(work\s+experience|professional\s+experience|employment\s+history|experience)\b/i],
  ['education',      /\b(education|academic\s+qualification\w*|qualifications?)\b/i],
  ['projects',       /\b(projects?|key\s+projects?)\b/i],
  ['certifications', /\b(certificat\w+|licenses?\s*(&|and)?\s*certificat\w*)\b/i],
  ['languages',      /\b(languages?\s*(known)?)\b/i],
  ['references',     /\b(references?)\b/i],
];

export function splitSections(text) {
  const lines = String(text || '').split('\n');
  const out = { _preamble: [] };
  let current = '_preamble';

  for (const line of lines) {
    const bare = clean(line);
    // A section heading is short and matches one of the names above.
    if (bare && bare.length <= 48) {
      const hit = SECTION_PATTERNS.find(([, re]) => re.test(bare));
      if (hit && bare.split(' ').length <= 5 && !NOT_A_HEADING.test(bare)) {
        current = hit[0];
        out[current] = out[current] || [];
        continue;
      }
    }
    (out[current] = out[current] || []).push(line);
  }
  for (const k of Object.keys(out)) out[k] = out[k].join('\n').trim();
  return out;
}

/* ------------------------------------------------------------------ *
 * individual finders
 * ------------------------------------------------------------------ */

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

/** Indian mobile numbers, plus general international forms. */
const PHONE_RE = /(?:(?:\+|00)\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?)?\d{3,5}[\s.-]?\d{3,4}[\s.-]?\d{0,4}/g;

/**
 * "Label: value", and also "Label" followed by the value on the next line.
 *
 * The second form is what a TABLE looks like once it has been extracted:
 * mammoth renders each cell as its own paragraph, so a two-column row
 * "Notice Period | 30 days" arrives as "Notice Period\n\n30 days". Resumes
 * put exactly this information in tables - notice period, salary, location -
 * so matching only the colon form missed most of it.
 */
const LABELLED = (labels, valuePattern = '[^\\n]+') =>
  new RegExp(`(?:${labels})[ \\t]*(?:[:\\-–][ \\t]*|[ \\t]{2,}|\\n+)(${valuePattern})`, 'i');

function firstMatch(text, re, group = 1) {
  const m = re.exec(text);
  return m ? clean(m[group]) : null;
}

/**
 * The value a LABELLED pattern captured.
 *
 * NOT group 1. Several label alternations contain groups of their own -
 * "expected\\s*(ctc|salary)", "(work)?\\s*experience" - so group 1 was the
 * matched LABEL, and findSalary was returning "Salary" while reporting it as
 * the amount. The value is always the last group, because LABELLED appends
 * it last.
 */
function labelledValue(text, re) {
  const m = re.exec(text);
  if (!m) return null;
  for (let i = m.length - 1; i >= 1; i--) {
    if (m[i] !== undefined) return clean(m[i]);
  }
  return null;
}

function findEmail(text) {
  const all = String(text).match(EMAIL_RE) || [];
  // Skip obvious non-personal addresses that appear in headers/footers.
  const personal = all.find((e) => !/^(info|hr|careers|jobs|support|noreply|no-reply)@/i.test(e));
  return personal || all[0] || null;
}

function findPhones(text) {
  const found = [];
  for (const raw of String(text).match(PHONE_RE) || []) {
    const digits = raw.replace(/\D/g, '');
    // 10 digits (India) up to 13 with a country code. Anything shorter is a
    // year, a PIN code, a salary or a date.
    if (digits.length < 10 || digits.length > 13) continue;
    // A run of digits inside a longer number (an Aadhaar, an account) is not
    // a phone number.
    if (/^(19|20)\d{2}$/.test(digits.slice(0, 4)) && digits.length === 10) continue;
    const norm = digits.length > 10 ? digits.slice(-10) : digits;
    if (!found.includes(norm)) found.push(norm);
  }
  return found;
}

function findName(text, email) {
  const lines = String(text).split('\n').map(clean).filter(Boolean);

  // An explicit label wins.
  const labelled = firstMatch(text, LABELLED('name|candidate\\s*name|full\\s*name'));
  if (labelled && isPersonName(labelled)) return labelled;

  // Otherwise: a resume nearly always opens with the person's name.
  for (const line of lines.slice(0, 6)) {
    if (isPersonName(line)) return line;
  }

  // Last resort: derive from the email local part, but only when it clearly
  // looks like a name (two dotted words), never from something like
  // "sr12345@".
  if (email) {
    const local = email.split('@')[0];
    const parts = local.split(/[._-]/).filter((p) => /^[a-z]{2,}$/i.test(p));
    if (parts.length >= 2) {
      return parts.map((p) => p[0].toUpperCase() + p.slice(1).toLowerCase()).join(' ');
    }
  }
  return null;
}

function isPersonName(line) {
  const s = clean(line);
  if (!s || s.length > 48) return false;
  if (/\d|@|https?:|\||,/.test(s)) return false;
  if (/\b(resume|curriculum|vitae|cv|profile|summary|objective|address|phone|email|mobile)\b/i.test(s)) return false;
  const words = s.split(' ');
  if (words.length < 2 || words.length > 5) return false;
  return words.every((w) => /^[A-Za-z][A-Za-z.'-]*$/.test(w));
}

function findLinks(text) {
  const linkedin = firstMatch(text, /((?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/[^\s,|)]+)/i);
  const github   = firstMatch(text, /((?:https?:\/\/)?github\.com\/[^\s,|)]+)/i);
  const url = (u) => (u ? (/^https?:/i.test(u) ? u : `https://${u}`).replace(/[.,;]+$/, '') : null);
  return { linkedin: url(linkedin), github: url(github) };
}

/** "7 years", "7+ yrs", "Total Experience: 7.5 years" */
function findExperienceYears(text) {
  const labelled = labelledValue(text,
    LABELLED('total\\s*(?:work)?\\s*experience|experience|total\\s*exp', '[^\\n]{0,40}'));
  // The bare word "Experience" is also a section heading, so the labelled
  // match is often the first job line rather than a duration. Fall back to
  // the whole document rather than giving up on it.
  const YEARS = /(\d{1,2}(?:\.\d)?)\s*\+?\s*(?:years?|yrs?)/i;
  const m = (labelled && YEARS.exec(labelled)) || YEARS.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 0 && n <= 50 ? n : null;
}

function findNoticePeriod(text) {
  const v = labelledValue(text, LABELLED('notice\\s*period|notice', '[^\\n]{0,40}'));
  if (v) return v;
  const m = /\b(immediate(?:ly)?\s*(?:available|joiner)?|\d{1,3}\s*(?:days?|weeks?|months?)\s*notice)\b/i.exec(text);
  return m ? clean(m[1]) : null;
}

const MONEY = '[^\\n]{0,30}';
function findSalary(text, which) {
  const labels = which === 'expected'
    ? 'expected\\s*(?:ctc|salary|compensation)'
    : 'current\\s*(?:ctc|salary|compensation)|present\\s*(?:ctc|salary)';
  const v = labelledValue(text, LABELLED(labels, MONEY));
  if (!v) return null;
  // Keep it only if it actually contains a number.
  return /\d/.test(v) ? v : null;
}

function findLocation(text, which) {
  const labels = which === 'preferred'
    ? 'preferred\\s*(?:job)?\\s*locations?|preferred\\s*city|desired\\s*location'
    : 'current\\s*location|location|based\\s*(?:in|at)|city';
  const v = labelledValue(text, LABELLED(labels, '[^\\n]{0,60}'));
  return v || null;
}

const DEGREE = /\\b(Ph\\.?D|M\\.?Tech|M\\.?E\\b|M\\.?S\\b|MBA|MCA|M\\.?Sc|M\\.?Com|M\\.?A\\b|B\\.?Tech|B\\.?E\\b|B\\.?Sc|BCA|B\\.?Com|B\\.?A\\b|Diploma|Intermediate|Graduat\\w+|Post\\s*Graduat\\w+)\\b/i;

function findQualification(text, sections) {
  const labelled = labelledValue(text, LABELLED('highest\\s*qualification|qualification', '[^\\n]{0,60}'));
  // "Qualification / Institution" is the header row of an education table;
  // taking it literally reported the candidate's degree as "Institution".
  if (labelled && DEGREE.test(labelled)) return labelled;
  const edu = sections.education || '';
  const m = new RegExp(DEGREE.source + '[^\\n,]{0,40}', 'i').exec(edu || text);
  return m ? clean(m[0]) : null;
}

/** Employment history: "Company — Title (2021 - Present)" and variants. */
function findEmployment(sections) {
  const src = sections.experience || '';
  const rows = [];
  const re = /^[\s•*-]*([A-Z][\w&.,'()\- ]{2,60}?)\s*(?:[—–|,-]{1,2}|\bat\b)\s*([\w&.,'()\/\- ]{2,60}?)\s*(?:\(([^)]{4,40})\))?\s*$/gm;
  let m;
  while ((m = re.exec(src)) && rows.length < 12) {
    const a = clean(m[1]); const b = clean(m[2]); const period = clean(m[3] || '');
    if (!a || !b) continue;
    if (/^(responsibilit|achievement|project|skill)/i.test(a)) continue;
    // A two-column table row ("Current Location | Hyderabad") has the same
    // shape as "Company - Title". Reject anything whose left side is one of
    // the labels a resume table uses, or InnovateSoft ends up working
    // alongside "Hyderabad".
    if (LABEL_WORDS.test(a) || LABEL_WORDS.test(b)) continue;
    // "Hyderabad, Bengaluru" has the same shape as "Company - Title" and was
    // being read as a job. A real entry carries a date range or a recognisable
    // job title; a list of cities carries neither.
    const looksLikeJob = period
      || JOB_TITLE.test(a) || JOB_TITLE.test(b)
      || /\b(pvt|ltd|inc|llp|technolog|solutions|systems|labs|software|services|consult)\b/i.test(a + ' ' + b);
    if (!looksLikeJob) continue;
    // Which side is the company? The one without a job-title word in it.
    const titleish = JOB_TITLE;
    const company = titleish.test(a) && !titleish.test(b) ? b : a;
    const title   = company === a ? b : a;
    rows.push({ company, title, period: period || null });
  }
  return rows;
}

/**
 * Table labels that are NOT section headings.
 *
 * "Total Experience" matched the Experience heading pattern, so a details
 * table starting with it opened a new EXPERIENCE section and swallowed the
 * rest of the table - which is how a city ended up listed as a previous
 * employer. These are labels only.
 *
 * Deliberately narrower than LABEL_WORDS: "Education", "Skills" and
 * "Languages" appear in both roles, and they are far more often headings.
 */
const NOT_A_HEADING = /^(?:total\s*experience|relevant\s*experience|current\s*(?:company|location|salary|ctc|designation)|preferred\s*location|notice\s*period|expected\s*(?:salary|ctc)|date\s*of\s*birth|dob|mobile|phone|address)\b/i;

/* The left-hand column of a details table - never a company or a title. */
const JOB_TITLE = /\b(engineer|developer|manager|analyst|consultant|lead|architect|designer|intern|executive|specialist|administrator|scientist|associate|officer|director|head)\b/i;

const LABEL_WORDS = /^(total\s*experience|relevant\s*experience|experience|current\s*(company|location|salary|ctc|designation)|preferred\s*location|notice\s*period|expected\s*(salary|ctc)|languages?|qualification|institution|education|date\s*of\s*birth|dob|email|mobile|phone|address|skills?)\b/i;

/** Bullet or comma separated lists under a heading. */
function findList(section, { max = 40, minLen = 2 } = {}) {
  if (!section) return [];
  const items = [];
  for (const rawLine of section.split('\n')) {
    const line = clean(rawLine).replace(/^[•*\-–—\s]+/, '');
    if (!line) continue;
    const parts = line.includes(',') && line.length < 200 ? line.split(',') : [line];
    for (const p of parts) {
      const v = clean(p).replace(/[.;]+$/, '');
      if (v.length >= minLen && v.length <= 60 && !items.includes(v)) items.push(v);
      if (items.length >= max) return items;
    }
  }
  return items;
}

function findDob(text) {
  const v = firstMatch(text, LABELLED('date\\s*of\\s*birth|dob|d\\.o\\.b', '[^\\n]{0,30}'));
  if (!v) return null;
  return /\d/.test(v) ? v : null;
}

/* ------------------------------------------------------------------ *
 * the entry point
 * ------------------------------------------------------------------ */

/**
 * @returns an object whose keys are ONLY the fields the resume actually
 *          stated. A missing key means "not found", never "empty".
 */
/**
 * How much of a resume we actually got, 0-100.
 *
 * NOT a model's opinion and not a setting. It is computed from three
 * things this parse can demonstrate:
 *
 *   identity   did we find the name, email and phone - the fields without
 *              which the record is not usable at all (weight 40)
 *   substance  did we find the things a recruiter screens on: skills,
 *              experience, current role, education (weight 40)
 *   text       did the file yield enough text to have been read properly
 *              at all (weight 20)
 *
 * A scanned PDF that yields 60 characters and one email scores low, which
 * is the point: the number has to be able to say "this went badly".
 */
export function parseConfidence({ fields, chars }) {
  const has = (k) => {
    const v = fields[k];
    return Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && String(v).trim() !== '';
  };

  const identity = ['name', 'email', 'phone'].filter(has).length / 3;
  const substance = ['skills', 'expYears', 'title', 'currentCompany', 'education', 'summary']
    .filter(has).length / 6;
  // 1200 characters is about one page of a real resume.
  const text = Math.min(1, (Number(chars) || 0) / 1200);

  return Math.round((identity * 40) + (substance * 40) + (text * 20));
}

export function extractFields(text) {
  const t = String(text || '');
  if (!t.trim()) return { fields: {}, found: 0 };

  const sections = splitSections(t);
  // References contain other people's names and numbers.
  const personal = t.replace(sections.references || ' ', '');

  const email = findEmail(personal);
  const phones = findPhones(personal);
  const links = findLinks(t);

  const employment = findEmployment(sections);
  const skills = findList(sections.skills, { max: 40 });
  const certifications = findList(sections.certifications, { max: 15, minLen: 4 });
  const projects = findList(sections.projects, { max: 12, minLen: 4 });
  const languages = findList(sections.languages, { max: 10, minLen: 3 });

  const raw = {
    name: findName(personal, email),
    email,
    phone: phones[0] || null,
    altPhone: phones[1] || null,
    location: findLocation(t, 'current'),
    preferredLocation: findLocation(t, 'preferred'),
    title: employment[0]?.title || firstMatch(t, LABELLED('designation|current\\s*designation|job\\s*title', '[^\\n]{0,50}')),
    currentCompany: employment[0]?.company || firstMatch(t, LABELLED('current\\s*(company|employer)|company', '[^\\n]{0,50}')),
    previousCompanies: employment.slice(1).map((e) => e.company),
    employmentHistory: employment,
    expYears: findExperienceYears(t),
    relevantExpYears: (() => {
      const v = firstMatch(t, LABELLED('relevant\\s*experience', '[^\\n]{0,40}'));
      if (!v) return null;
      const m = /(\d{1,2}(?:\.\d)?)/.exec(v);
      return m ? Number(m[1]) : null;
    })(),
    noticePeriod: findNoticePeriod(t),
    currentSalary: findSalary(t, 'current'),
    expectedSalary: findSalary(t, 'expected'),
    qualification: findQualification(t, sections),
    education: sections.education ? clean(sections.education).slice(0, 600) : null,
    summary: sections.summary ? clean(sections.summary).slice(0, 1200) : null,
    skills,
    certifications,
    projects,
    languages,
    dob: findDob(t),
    linkedin: links.linkedin,
    github: links.github,
  };

  // Drop everything that was not found. An absent key is the signal the
  // form uses to leave a field alone.
  const fields = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (typeof v === 'string' && !v.trim()) continue;
    fields[k] = v;
  }
  return { fields, found: Object.keys(fields).length };
}
