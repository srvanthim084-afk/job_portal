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

/* The one list of Indian cities, shared with the external-jobs filter:
   two lists would be two lists that disagree. */
import { INDIAN_CITIES } from '../external/india.js';

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/* A resume is a list of sections. Finding them first stops "Reference:
   Anita Sharma, 9876543210" being read as the candidate's own phone. */
const SECTION_PATTERNS = [
  ['summary',        /\b(professional\s+summary|career\s+objective|objective|profile\s+summary|about\s+me|summary)\b/i],
  /* Internships and training are their own section, not employment: a
     fresher's "Internship Experience" opened the experience section and
     made the host company their current employer. Checked before
     experience and certifications for that reason. */
  ['internships',    /\b(internships?(\s+experience)?|industrial\s+training|summer\s+training|in-?plant\s+training|apprenticeships?|trainings?)\b/i],
  ['achievements',   /\b(achievements?|accomplishments?|awards?(\s*(&|and)\s*(achievements?|honou?rs|recognitions?))?|honou?rs|recognitions?)\b/i],
  ['skills',         /\b(key\s+skills|technical\s+skills|core\s+competenc\w*|skills?\s*(&|and)?\s*(expertise)?)\b/i],
  /* "Career History" and "Work History" are as common as "Experience" on a
     medical CV, and neither opened an experience section - so everything
     under them was read as preamble and no employer was ever found. */
  ['experience',     /\b(work\s+experience|professional\s+experience|employment\s+history|career\s+history|work\s+history|experience\s+details|clinical\s+experience|experience)\b/i],
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

  /*
   * A HEADING IS A HEADING, NOT "LABEL: VALUES".
   *
   * This is the line that emptied the skills of every resume written in
   * the commonest Indian format there is:
   *
   *     TECHNICAL SKILLS
   *     Languages: Python, SQL, HTML5, CSS
   *     Backend: Flask, REST APIs, Node.js
   *     Databases: PostgreSQL, MySQL, MongoDB
   *     Tools: Git, GitHub, VS Code
   *
   * "TECHNICAL SKILLS" correctly opened the skills section - and the very
   * next line closed it again. "Languages: Python, SQL, HTML5, CSS" is 34
   * characters and five words and matches the languages pattern, so it
   * was taken as the LANGUAGES heading; Python, SQL, HTML5 and CSS were
   * dropped with it, and Backend, Databases and Tools were filed as
   * languages the candidate speaks. The profile then showed no skills at
   * all beside a resume that lists twenty, which is exactly what a
   * recruiter searching on skills never finds.
   *
   * The distinction is simple and it is what a human eye uses: a heading
   * stands alone. A line with real content after a colon is a labelled
   * VALUE inside whatever section it is already in. "EDUCATION:" with
   * nothing after it is still a heading, so the colon alone is not the
   * test - what follows it is.
   */
  const labelledValue = (s) => {
    const m = /^[^:]{1,30}:\s*(.+)$/.exec(s);
    return !!(m && clean(m[1]).length >= 3);
  };

  for (const line of lines) {
    const bare = clean(line);
    // A section heading is short and matches one of the names above.
    if (bare && bare.length <= 48 && !labelledValue(bare)) {
      const hit = SECTION_PATTERNS.find(([, re]) => re.test(bare));
      if (hit && bare.split(' ').length <= 5 && !NOT_A_HEADING.test(bare)) {
        current = hit[0];
        out[current] = out[current] || [];
        continue;
      }

      /*
       * A HEADING WE DO NOT KNOW STILL ENDS THE ONE BEFORE IT.
       *
       * Resumes carry sections this list has never heard of - "INTERNSHIPS
       * & TRAINING", "ACHIEVEMENTS", "EXTRA-CURRICULAR", "AREAS OF
       * INTEREST". They were not headings, so everything under them was
       * appended to whatever section happened to be open, and the
       * certifications of the candidate in front of me came back as
       * ["INTERNSHIPS & TRAINING", "Collected", "organized", "cleaned",
       * "Collaborated with research teams..."] - sentences out of an
       * internship description, stored as certificates.
       *
       * Shouted and short is what a heading looks like when the words
       * are not ones we recognise: all capitals, few words, no sentence
       * punctuation. Those close the current section into a bucket
       * nothing reads, which is the right place for text we cannot name.
       */
      /*
       * ...but a BULLETED line is an item, never a heading, and one short
       * acronym on its own line ("AWS", "SQL", "HTML") is a skill in a
       * one-per-line list. "Key Skills / • Java / • React / • AWS" read
       * "• AWS" as an unknown heading and closed the skills section on it,
       * so the last skill of every bulleted DOCX list was dropped.
       */
      const bulleted = /^[•●▪◦▸►*–—-]\s*/.test(bare);
      const acronym = /^[A-Z0-9+#./]{2,4}$/.test(bare);
      const shouted = !bulleted && !acronym && bare === bare.toUpperCase() && /[A-Z]{3}/.test(bare)
        && bare.split(' ').length <= 5 && !/[.,;:]$/.test(bare);
      if (shouted) {
        current = '_unknown';
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
/*
 * A phone number, and NOT a run of digits inside a longer one.
 *
 * Without the guards at either end this matched thirteen digits out
 * of the middle of a longer number - an employee id, an Aadhaar, a
 * timestamp - and then took the last ten of THAT as somebody's
 * mobile. The number it invents looks exactly like a real one, and a
 * resume matched to a candidate by an invented number is attached to
 * the wrong person: the document that gets sent to a client.
 */
const PHONE_RE = /(?<![\d])(?:(?:\+|00)\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?)?\d{3,5}[\s.-]?\d{3,4}[\s.-]?\d{0,4}(?![\d])/g;

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

/*
 * A LABEL GLUED ONTO THE TLD.
 *
 * PDF extraction runs lines together. An address at the end of one line
 * and a "Phone:" label at the start of the next arrive as a single token,
 * "…@gmail.comPhone", and the TLD part of EMAIL_RE - [A-Za-z]{2,} -
 * swallows the label happily because "comPhone" is all letters.
 *
 * This is not cosmetic. The extracted address becomes the address the
 * candidate signs in with, so every one of these is an account its owner
 * cannot reach: they type the address they actually have, and the portal
 * correctly answers that no such account exists.
 *
 * NOTHING IS GUESSED. The label is cut only when what remains ends in a
 * real TLD; otherwise the original is kept untouched, because a wrong
 * address invented here is worse than a malformed one that shows up as
 * malformed.
 */
const GLUED_LABEL = /(phones?|mobile|e-?mail|contact|address|telephone|tel|cell|whatsapp|dob|linkedin|github|gender|nationality|languages?|skills?|objective|career|profile|summary)$/i;

const TLD_OK = /\.(com|in|org|net|edu|gov|io|co|me|info|biz|ac|uk|us|dev|app|tech|online|site|xyz)$/i;

function repairEmail(raw) {
  const original = String(raw || '').trim();
  if (TLD_OK.test(original)) return original;

  /* Up to three, because "…@gmail.comPhoneEmail" happens too. */
  let e = original;
  for (let i = 0; i < 3; i += 1) {
    const cut = e.replace(GLUED_LABEL, '');
    if (cut === e) break;
    e = cut;
    if (TLD_OK.test(e)) return e;
  }
  return original;
}

function findEmail(text) {
  const all = (String(text).match(EMAIL_RE) || []).map(repairEmail);
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
    /*
     * More than ten digits is only a phone number if it actually CARRIES
     * a country code. "1790228675118" is a timestamp; taking its last
     * ten digits produces 0228675118, which is not a mobile number in
     * any country and belongs to nobody.
     */
    if (digits.length > 10 && !/^(\+|00)/.test(raw.trim())) continue;
    // A run of digits inside a longer number (an Aadhaar, an account) is not
    // a phone number.
    if (/^(19|20)\d{2}$/.test(digits.slice(0, 4)) && digits.length === 10) continue;
    const norm = digits.length > 10 ? digits.slice(-10) : digits;
    if (!found.includes(norm)) found.push(norm);
  }
  return found;
}

/*
 * SECTION HEADINGS ARE NOT NAMES.
 *
 * Reported: a candidate uploaded a CV and the Full name box came back
 * "CORE SKILLS". Every check the old rule made, that heading passed -
 * two words, all letters, no digits, no @ - because the blocklist named
 * ten headings and "core skills" was not one of them. It then travelled
 * into the profile, the recruiter's table and the greeting on an email.
 *
 * So the list is now the full set of headings a CV actually uses, and it
 * is matched against the WHOLE line rather than searched for inside it,
 * because "Summary" must be refused while "Summayya Begum" must not.
 *
 * AND IT IS NOT "THE FIRST LINE" ANY MORE. A two-column PDF puts the
 * sidebar first, so the first line is as likely to be a heading as a
 * name. Fifteen lines are scanned and the first thing that looks like a
 * person is taken; if nothing does, the field is left EMPTY. An empty
 * box with "Enter your full name" in it is a question. A box containing
 * "CORE SKILLS" is a wrong answer the candidate may not read back.
 */
const NAME_BLOCKLIST = new Set([
  'core skills', 'skills', 'technical skills', 'key skills', 'soft skills',
  'summary', 'profile', 'profile summary', 'professional summary',
  'objective', 'career objective', 'career summary',
  'experience', 'work experience', 'professional experience',
  'employment history', 'education', 'educational qualification',
  'qualification', 'qualifications', 'projects', 'project', 'certifications',
  'certification', 'achievements', 'accomplishments', 'awards',
  'languages', 'languages known', 'interests', 'hobbies',
  'declaration', 'references', 'reference', 'contact', 'contact details',
  'personal details', 'personal information', 'personal profile',
  'curriculum vitae', 'resume', 'cv', 'about me', 'strengths',
  'areas of expertise', 'competencies', 'core competencies',
  'work history', 'training', 'internship', 'internships',
]);

/** Strip the decoration a heading is often wrapped in. */
function headingKey(line) {
  return String(line || '')
    .replace(/[\u2013\u2014_*#:|.\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** "PALLAVI U" -> "Pallavi U". Initials stay upper. */
function titleCaseName(v) {
  return String(v || '').trim().split(/\s+/).map((w) => {
    if (/^[A-Za-z]\.?$/.test(w)) return w.toUpperCase();      // an initial
    /* O'Brien, D'Souza, Rama-Krishna: every part after a separator is
       capitalised too, which a plain first-letter rule misses. */
    return w.toLowerCase().replace(/(^|[.'\u2019-])([a-z])/g,
      (_, sep, c) => sep + c.toUpperCase());
  }).join(' ');
}

function findName(text, email) {
  const lines = String(text).split('\n').map(clean).filter(Boolean);

  /*
   * AN EXPLICIT LABEL WINS - BUT ONLY THE CANDIDATE'S OWN.
   *
   * LABELLED does not anchor, so the bare word "name" matched the Name
   * inside "Father's Name: Mohammed Khatun" and the parser filed the
   * father as the candidate - on a resume whose own name was on line
   * one. Anchored to the start of a line, so a label with anything in
   * front of it belongs to somebody else.
   */
  const labelled = firstMatch(text,
    /(?:^|\n)[ \t]*(?:candidate\s*name|full\s*name|name)[ \t]*(?:[:\-\u2013][ \t]*|[ \t]{2,})([^\n]+)/i);
  if (labelled && isPersonName(labelled)) return titleCaseName(labelled);

  /* Twenty, not six: a two-column layout can put a whole sidebar ahead
     of the header, and the name is still in the top of the document.
     Two words or more wins over a lone one, for the reason in
     nameFrom(). */
  const top = lines.slice(0, 20).filter(isPersonName);
  const multi = top.find((l) => l.split(' ').length >= 2);
  if (multi) return titleCaseName(multi);
  if (top.length) return titleCaseName(top[0]);

  /* Nothing that is certainly a name. The field stays empty and the
     form asks for it; the email-derived guess travels separately as
     `nameSuggestion` so nothing writes it in by accident. */
  return null;
}

function isPersonName(line) {
  const s = clean(line);
  if (!s || s.length > 48) return false;

  /* A heading, whatever case it is written in. Checked first and
     against the whole line, so "Summary" is refused and "Summayya
     Begum" is not. */
  if (NAME_BLOCKLIST.has(headingKey(s))) return false;

  if (/\d|@|https?:|\||,|\//.test(s)) return false;
  /* The old inside-the-line check, kept for the phrases that appear
     WITH other words: "Resume of Priya", "Profile Summary Sheet". */
  if (/\b(resume|curriculum|vitae|cv|profile|summary|objective|address|phone|email|mobile|skills?|experience|education|projects?|declaration)\b/i.test(s)) return false;

  const words = s.split(' ');
  /*
   * ONE TO FOUR.
   *
   * Two was the floor, and it lost every candidate who goes by a single
   * name - which is common here, and there are several on file. A single
   * word is accepted but held to a higher bar in nameFrom() below: it is
   * only taken when nothing with two or more words was found, because
   * one word is also what a heading looks like.
   */
  if (words.length < 1 || words.length > 4) return false;
  /*
   * A FULL STOP ONLY AFTER A SINGLE LETTER.
   *
   * The old rule allowed a dot anywhere in a word, for initials - and
   * "Experienced professional." is two alphabetic words with a dot, so
   * a sentence sitting under a heading was read as a name. An initial
   * is one letter and a stop; anything longer ending in one is the end
   * of a sentence.
   */
  return words.every((w) => /^[A-Za-z]\.$/.test(w)
    || /^[A-Za-z][A-Za-z\u2019'-]*$/.test(w));
}

/**
 * The name, and - separately - a name we are only guessing at.
 *
 * Returns { name, suggestion }. `name` is filled only from evidence in
 * the document. `suggestion` is derived from the email and is NEVER
 * written into the field: the form offers it as a question the candidate
 * answers, because "upallavi271@" could be Pallavi, U Pallavi, or
 * neither, and a profile is read by recruiters who will not know it was
 * a guess.
 */
function nameFrom(text, email) {
  const lines = String(text).split('\n').map(clean).filter(Boolean);

  const labelled = firstMatch(text,
    /(?:^|\n)[ \t]*(?:candidate\s*name|full\s*name|name)[ \t]*(?:[:\-\u2013][ \t]*|[ \t]{2,})([^\n]+)/i);
  if (labelled && isPersonName(labelled)) {
    return { name: titleCaseName(labelled), suggestion: null };
  }

  /* Twenty lines, and a name of two or more words is preferred over a
     lone word anywhere above it - a sidebar heading the blocklist has
     not heard of is one word far more often than it is three. */
  const top = lines.slice(0, 20).filter(isPersonName);
  const multi = top.find((l) => l.split(' ').length >= 2);
  if (multi) return { name: titleCaseName(multi), suggestion: null };
  if (top.length) return { name: titleCaseName(top[0]), suggestion: null };

  /* Nothing in the document. Offer the email, as a question. */
  if (email) {
    const local = email.split('@')[0].replace(/\d+/g, ' ');
    const parts = local.split(/[._\-\s]+/).filter((x) => /^[a-z]{2,}$/i.test(x));
    if (parts.length && !NAME_BLOCKLIST.has(parts.join(' ').toLowerCase())) {
      return { name: null, suggestion: titleCaseName(parts.join(' ')) };
    }
  }
  return { name: null, suggestion: null };
}

function findLinks(text) {
  const linkedin = firstMatch(text, /((?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/[^\s,|)]+)/i);
  const github   = firstMatch(text, /((?:https?:\/\/)?github\.com\/[^\s,|)]+)/i);
  const url = (u) => (u ? (/^https?:/i.test(u) ? u : `https://${u}`).replace(/[.,;]+$/, '') : null);
  /* A personal site or portfolio: the first other web address on the
     page. Mail providers and the two above are not portfolios. */
  const others = String(text || '').match(/\b((?:https?:\/\/|www\.)[^\s,|)<>]+)/gi) || [];
  const portfolio = others.find((u) => !/linkedin\.com|github\.com|gmail\.|yahoo\.|outlook\.|hotmail\./i.test(u)) || null;
  return { linkedin: url(linkedin), github: url(github), portfolio: url(portfolio) };
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

/*
 * A CITY, OR NOTHING.
 *
 * Reported alongside the name fault: the City box came back
 * "HYDERNAGAR", which is a neighbourhood inside an address line -
 * "Plot 42, Hydernagar, Kukatpally, Hyderabad". The old rule took
 * whatever followed "Address" or "Location" for sixty characters, so the
 * first fragment won and the actual city three commas later was thrown
 * away.
 *
 * Now the labelled line is READ FOR A CITY rather than used as one: the
 * line is searched for a name on the known list - the same list the
 * external-jobs India filter uses, so there is one list and not two -
 * and the longest match wins, so "navi mumbai" beats "mumbai". A line
 * with no recognised city yields NOTHING, leaving the field empty for
 * the candidate rather than filling it with a suburb.
 *
 * The preferred-location field keeps the looser behaviour: "anywhere in
 * South India" is a real answer to that question and is not a city.
 */
function cityIn(line) {
  const hay = ' ' + String(line || '').toLowerCase().replace(/[^a-z\s]+/g, ' ')
    .replace(/\s+/g, ' ') + ' ';
  let best = null;
  for (const c of INDIAN_CITIES) {
    if (hay.includes(' ' + c + ' ') && (!best || c.length > best.length)) best = c;
  }
  return best ? best.replace(/(^|\s)([a-z])/g, (_, sp, ch) => sp + ch.toUpperCase()) : null;
}

function findLocation(text, which) {
  const preferred = which === 'preferred';
  const labels = preferred
    ? 'preferred\\s*(?:job)?\\s*locations?|preferred\\s*city|desired\\s*location'
    : 'current\\s*location|present\\s*address|permanent\\s*address|address|location|based\\s*(?:in|at)|city';
  const v = labelledValue(text, LABELLED(labels, '[^\\n]{0,120}'));

  if (v) {
    const city = cityIn(v);
    if (city) return city;
    if (preferred) return v;
  }

  /*
   * No usable labelled line. For the CURRENT city only, the top of the
   * document is searched - the header under the name carries it on most
   * CVs - and still only a recognised city is accepted.
   */
  if (!preferred) {
    const head = String(text).split('\n').slice(0, 12).join(' ');
    const city = cityIn(head);
    if (city) return city;

    /*
     * A SIX-DIGIT PIN IS AN ADDRESS, so the line it sits on is worth
     * reading even when nothing labelled it. Only the line - not the
     * document - because a PIN in a referee's address must not become
     * the candidate's city. And still only a recognised city name is
     * taken from it; the PIN itself is not mapped, because this repo
     * holds no PIN-to-city table and inventing one from the first two
     * digits would be a guess wearing a number.
     */
    const pinLine = String(text).split('\n')
      .find((l) => /(?:^|[^\d])\d{6}(?:[^\d]|$)/.test(l) && cityIn(l));
    if (pinLine) return cityIn(pinLine);
  }
  return null;
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

/*
 * EVERY EDUCATION RECORD, NOT ONLY THE HIGHEST (0117).
 *
 * `education` keeps the section as one line and `qualification` the top
 * degree; a resume listing B.Tech, Intermediate and SSC filled one field
 * and dropped the other two. Each line naming a level starts a record;
 * the lines under it until the next level add the institution, the year
 * and the score. Nothing is guessed: a value not on those lines is null.
 */
const EDU_LEVELS = [
  ['Doctorate', /\b(?:Ph\.?\s?D|Doctorate)\b/i],
  ['Post Graduation', /\b(?:M\.?\s?Tech|M\.E\b|MBA|MCA|M\.?\s?Sc|M\.?\s?Com|M\.A\b|M\.?\s?Pharm|PGDM|Post[\s-]*Graduat\w*|Master(?:'s|s)?\s+(?:of|in)\b)/i],
  ['Graduation', /\b(?:B\.?\s?Tech|B\.E\b|B\.?\s?Sc|BCA|BBA|B\.?\s?Com|B\.A\b|B\.?\s?Pharm|MBBS|BDS|Bachelor(?:'s|s)?\s+(?:of|in)\b|Graduation)/i],
  ['Diploma', /\b(?:Diploma|Polytechnic|ITI)\b/i],
  ['12th', /\b(?:12th|XII|Intermediate|Inter\b|HSC|Senior\s+Secondary|Higher\s+Secondary|PUC|\+2)\b/i],
  ['10th', /\b(?:10th|SSC|S\.S\.C|Matriculation|Secondary\s+School|High\s+School|CBSE\s+X\b|X\s+Standard)\b/i],
];
const EDU_INSTITUTION = /\b(?:University|College|Institute|Institution|School|Vidyalaya|Academy|IIT|NIT|IIIT|Polytechnic|Board)\b/i;

function levelOf(line) {
  for (const [level, re] of EDU_LEVELS) {
    const m = re.exec(line);
    if (m) return { level, degree: clean(m[0]) };
  }
  return null;
}

export function findEducationRecords(section) {
  const lines = String(section || '').split('\n')
    .map((l) => clean(l.replace(/^[\s•●▪*\-–—>]+/, '')))
    .filter((l) => l.length >= 2 && l.length <= 240);
  const records = [];
  let cur = null;

  const take = (rec, line) => {
    const years = line.match(/\b(19[6-9]\d|20[0-4]\d)\b/g);
    if (years && years.length) rec.passingYear = years[years.length - 1];
    const pct = /(\d{2}(?:\.\d{1,2})?)\s*%/.exec(line);
    const gpa = /\b(?:CGPA|GPA|CPI|SGPA)\s*[:\-–]?\s*(\d{1,2}(?:\.\d{1,2})?)(?:\s*\/\s*(?:10|4))?/i.exec(line)
      || /\b(\d\.\d{1,2})\s*\/\s*10\b/.exec(line)
      || /\b(\d{1,2}(?:\.\d{1,2})?)\s*(?:CGPA|GPA|CPI)\b/i.exec(line);
    if (!rec.score && pct) rec.score = pct[1] + '%';
    else if (!rec.score && gpa) rec.score = gpa[1] + ' CGPA';
    if (!rec.institution) {
      const parts = line.split(/\s*[|,;–—]\s*|\s+-\s+/).map((p) => clean(p)).filter(Boolean);
      const isDegreePart = (p, i) => i === 0 && !!levelOf(p) && levelOf(p).degree === rec.qualification;
      const leftover = parts.filter((p, i) => !isDegreePart(p, i)
        && !/^(?:\(?\s*(?:19|20)\d\d\s*\)?|[\d.]+\s*%|(?:CGPA|GPA|CPI)?\s*[:\-]?\s*\d{1,2}(?:\.\d{1,2})?(?:\s*\/\s*10)?(?:\s*CGPA)?)$/i.test(p)
        && /[A-Za-z]{3,}/.test(p));
      const part = leftover.find((p) => EDU_INSTITUTION.test(p))
        || (isLevelLine ? leftover.find((p) => !levelOf(p) || EDU_INSTITUTION.test(p)) : null);
      if (part) rec.institution = clean(part.replace(/\(?\b(19|20)\d\d\b.*$/, '')).slice(0, 160) || null;
    }
  };
  let isLevelLine = false;

  for (const line of lines) {
    const lv = levelOf(line);
    if (lv && records.length < 8) {
      cur = { level: lv.level, qualification: lv.degree, specialization: null,
              institution: null, passingYear: null, score: null };
      const spec = /\(([^)]{3,60})\)/.exec(line)
        || new RegExp(lv.degree.replace(/[.+*?^$()[\]{}|\\]/g, '\\$&') + '\\s*(?:in|-|–|:)\\s*([A-Za-z&. ]{3,60})', 'i').exec(line);
      if (spec && !/\d/.test(spec[1]) && !EDU_INSTITUTION.test(spec[1])) cur.specialization = clean(spec[1]);
      isLevelLine = true;
      take(cur, line.replace(/\([^)]*\)/, ''));
      records.push(cur);
    } else if (cur) {
      isLevelLine = false;
      take(cur, line);
    }
  }
  return records.map((r) => ({ ...r, educationType: r.level }));
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
/*
 * A LABELLED FACT IS NOT A SKILL.
 *
 * The skills section runs to the end of the document when nothing that
 * looks like a heading follows it, and most resumes close with exactly
 * the lines that do not look like headings:
 *
 *   Current CTC: 18 LPA
 *   Expected CTC: 26 LPA
 *   Notice Period: 60 days
 *   Date of Birth: 12/08/1997
 *
 * All four were imported as skills, and a candidate who registered saw
 * "Date of Birth: 12/08/1997" listed among the things they are good at.
 * Worse, a recruiter searching skills matched on them.
 *
 * Every one of those facts is read properly elsewhere in this file, so
 * dropping them here loses nothing. The test is the shape - a known
 * label followed by a colon - rather than the words, because the shape
 * is what makes it a field rather than a skill.
 */
const NOT_A_SKILL = new RegExp(
  '^(?:current|expected|present)?\\s*(?:ctc|salary|package|compensation'
  + '|notice\\s*period|date\\s*of\\s*birth|dob|d\\.o\\.b'
  + '|email|e-?mail|mobile|phone|contact|address|location|nationality'
  + '|gender|marital\\s*status|languages?\\s*known|passport'
  + "|father[’']?s?\\s*name|mother[’']?s?\\s*name|linked\\s*in|github"
  + '|total\\s*experience|experience|willing\\s*to\\s*relocate)\\b\\s*[:\\-]',
  'i');

/*
 * THE CLOSING BLOCK OF AN INDIAN RESUME, which is not a list of anything.
 *
 * Most CVs here end with:
 *
 *     Declaration
 *     I hereby declare that the above information is true...
 *     Place: Hyderabad
 *     Date: 30/6/2026
 *     (Navya Reddy)
 *
 * None of that is a heading this file knows, so it fell into whichever
 * section was last open - usually LANGUAGES, because that is the section
 * just before it. Fifteen candidates on file speak "Declaration",
 * "Place: Hyderabad" and "(Navya Reddy)". The list stops here instead.
 */
const END_OF_RESUME = new RegExp(
  '^(?:declaration|i\\s+hereby\\s+declare|place\\s*[:\\-]|date\\s*[:\\-]'
  + '|signature|yours\\s+(?:faithfully|sincerely)|thanking\\s+you'
  + '|\\(\\s*[A-Z][a-z]+(?:\\s+[A-Z][a-z]*)*\\s*\\)$)',
  'i');

function findList(section, { max = 40, minLen = 2 } = {}) {
  if (!section) return [];
  const items = [];
  for (const rawLine of section.split('\n')) {
    const line = clean(rawLine).replace(/^[•*\-–—\s]+/, '');
    if (!line) continue;
    /* The tail of the document, not more of the list. */
    if (NOT_A_SKILL.test(line)) break;
    if (END_OF_RESUME.test(line)) break;        // the declaration block
    /*
     * THE CATEGORY LABEL IS NOT PART OF THE FIRST SKILL.
     *
     * A skills block is almost always grouped:
     *
     *     Languages: Python, SQL, HTML5, CSS
     *     Databases: PostgreSQL, MySQL, MongoDB
     *
     * Splitting on commas alone put "Languages: Python" and "Databases:
     * PostgreSQL" into the list, so a recruiter searching for Python or
     * PostgreSQL matched neither - the stored skill was a different
     * string from the one they typed. The label is dropped and the
     * skills behind it are kept; a genuine skill does not carry a colon.
     */
    const grouped = /^([A-Za-z][\w&/ .+-]{0,24}):\s*(.+)$/.exec(line);
    const body = grouped ? grouped[2] : line;

    const parts = body.includes(',') && body.length < 200 ? body.split(',') : [body];
    for (const p of parts) {
      const v = clean(p).replace(/[.;]+$/, '');
      if (v.length >= minLen && v.length <= 60 && !items.includes(v)) items.push(v);
      if (items.length >= max) return items;
    }
  }
  return items;
}

/**
 * The line under the name.
 *
 * A resume puts the candidate's current designation directly beneath
 * their name, before any heading - "Rahul Kumar Sharma / Senior Java
 * Developer". Nothing read it, so every profile parsed from a CV arrived
 * with no designation at all, and the recruiter's list showed a blank
 * where the job title goes.
 *
 * Taken from the preamble only, and only when it reads like a job title
 * rather than an address or a phone number.
 */
const TITLE_WORDS = /\b(developer|engineer|manager|analyst|consultant|designer|architect|administrator|specialist|lead|executive|officer|associate|scientist|nurse|doctor|physician|surgeon|technician|accountant|recruiter|intern|trainee|tester|programmer|resident|registrar|radiographer|radiologist|technologist|pharmacist|therapist|physiotherapist|optometrist|dentist|midwife|paramedic|anaesthetist|anesthetist|pathologist|sonographer)\b/i;

/**
 * A SECTION HEADING IS NOT A VALUE.
 *
 * A two-column resume flattens to text with every heading first and every
 * value after it, so "Current Designation" was followed on the next line
 * by "Career Objective" rather than by the designation - and because
 * LABELLED accepts a newline as its separator, the heading became the
 * answer. One candidate's designation read "Career Objective".
 *
 * The same guard catches a heading picked up by the line-scan fallback.
 */
const SECTION_HEADING = new RegExp('^(?:career\\s*)?(?:objective|summary|profile|synopsis'
  + '|career\\s*(?:history|objective|summary|profile)|professional\\s*(?:summary|profile|experience)'
  + '|work\\s*experience|employment\\s*history|experience|education(?:al)?(?:\\s*qualification)?'
  + '|academic\\s*(?:qualification|details|record)s?|qualifications?|declaration|skills?'
  /* Compound headings are one heading: "Key competence and skills" was
     not recognised, so the walk past a run of headings stopped on it. */
  + '|technical\\s*skills?|key\\s*(?:skills?|competenc\\w*)(?:\\s*(?:and|&)\\s*(?:skills?|competenc\\w*|abilities))?'
  + '|soft\\s*skills?|projects?|achievements?'
  + '|awards?|publications?|paper\\s*presentations?|workshops?|conferences?|trainings?'
  + '|personal\\s*(?:details?|information|profile)|interests?|hobbies|strengths?|languages?'
  + '|certifications?|references?|current\\s*designation|designation|contact)\\s*:?\\s*$', 'i');

/**
 * Prose that happens to sit where a company name should.
 *
 * "...growth-oriented organization\nwhere I can utilize my knowledge of
 * Core Java..." - the bare word "organization" was in the company label
 * list, the newline was an accepted separator, and a fresher's career
 * objective was stored as her employer.
 */
const PROSE_NOT_A_VALUE = /\b(?:where|which|whom|seeking|utili[sz]e|to\s+(?:begin|seek|work|obtain)|i\s+(?:am|have|can|wish|would))\b/i;

/**
 * A qualification is not a job.
 *
 * "Certified in Ai Data Scientist" sat in a list of certifications and
 * became a designation, because it contains the word "scientist". The
 * lead-in is what distinguishes the two: "Certified in X" is something
 * they studied, while "Certified Nursing Assistant" and "Certified Public
 * Accountant" are real job titles - so only the "in" form is refused.
 */
const NOT_A_JOB = /^(?:certified\s+in|certificate|certification|diploma|course|trained\s+in|pursuing|completed|awarded|member\s+of|licen[cs]ed\s+in)\b/i;

/**
 * Is this a value, or something that only looks like one?
 *
 * Applied to every designation and employer before it is believed, so a
 * heading, a sentence, or a whole paragraph cannot reach a profile. A
 * real answer is short, and no company name is fifteen words long.
 */
export function plausibleValue(v, { maxWords = 8 } = {}) {
  const s = clean(v || '');
  if (!s || s.length < 2) return '';
  if (SECTION_HEADING.test(s)) return '';
  if (PROSE_NOT_A_VALUE.test(s)) return '';
  if (NOT_A_JOB.test(s)) return '';
  /* A dangling bracket means the value was cut out of the middle of
     something: "X-Ray) Hamidia Hospital" came from a training table. */
  if (/\)/.test(s) !== /\(/.test(s)) return '';
  /* A generic noun on its own names nobody. One doctor's employer was
     stored as "HOSPITALS". */
  if (/^(?:hospitals?|clinics?|healthcare|health\s*care|laborator(?:y|ies)|diagnostics?|cent(?:re|er)|company|organisation|organization|employer|institute)$/i.test(s)) return '';
  /*
   * A LABELLED LIST IS NOT A JOB TITLE OR AN EMPLOYER.
   *
   * "Developer Tools : Git/Github, Google Colab, VS Code," was stored as
   * somebody's designation: it is a line out of their skills block, and
   * it became a candidate value once labelled lines stopped being
   * mistaken for section headings. No designation and no employer
   * contains a colon, and none of them is a comma-separated list of
   * three or more things.
   */
  if (/:/.test(s)) return '';
  if ((s.match(/,/g) || []).length >= 2) return '';
  if (s.split(/\s+/).length > maxWords) return '';
  return s;
}

/**
 * The designation, without everything the résumé stacked beside it.
 *
 * A header line reads "RADIOLOGY TECHNICIAN | X-RAY • CT • MRI IMAGING
 * SPECIALIST" or "Software Developer | Computer Science Graduate". The
 * job title is the first segment; the rest is a tagline.
 */
function firstSegment(v) {
  const s = clean(v || '');
  if (!s) return '';
  const cut = s.split(/\s*(?:\||•|·|·|•|–{2,}|\/{2,})\s*/)[0];
  return clean(cut) || s;
}

function findTitle(text, sections, name) {
  /* Pipe-separated, NOT an array: an array stringifies with commas and
     builds "current designation,designation,job title" - a pattern that
     matches nothing, so this whole branch had been dead. */
  const LABEL_RE = LABELLED('current\\s*designation|designation|job\\s*title'
    + '|profile\\s*title|current\\s*role');
  const labelled = plausibleValue(labelledValue(text, LABEL_RE));
  if (labelled) return firstSegment(labelled).slice(0, 80);

  /*
   * THE FLATTENED TWO-COLUMN TABLE.
   *
   * A resume laid out as a two-column table extracts as every heading in
   * the left column followed by every value in the right one:
   *
   *     Current Designation
   *     Career Objective                 <- not the designation
   *     Senior Resident in Obstetrics    <- the designation
   *     To seek employment as a ...      <- the objective
   *
   * So when the label is followed by another heading, the value is the
   * first line past the run of headings. A job title is demanded of it,
   * which is what keeps the objective sentence out: the run is short, the
   * gate is narrow, and the alternative is a doctor with no designation.
   */
  const at = LABEL_RE.exec(text);
  if (at) {
    const after = String(text).slice(at.index + at[0].length - (at[1] || '').length)
      .split('\n').map(clean).filter(Boolean);
    for (const line of after.slice(0, 8)) {
      if (SECTION_HEADING.test(line)) continue;          // still inside the heading run
      if (line.length > 70 || /[@]|\d{6,}|https?:/i.test(line)) break;
      if (!TITLE_WORDS.test(line)) break;                // past the table; stop guessing
      const ok = plausibleValue(firstSegment(line), { maxWords: 9 });
      if (ok) return ok.slice(0, 80);
      break;
    }
  }

  /* The preamble is where the designation sits on most resumes - directly
     under the name - but a flattened two-column layout puts its headings
     there too, so the whole block is scanned rather than the first eight
     lines, and every candidate line has to survive plausibleValue. */
  const pre = String((sections && sections._preamble) || text || '').split('\n');
  for (const raw of pre.slice(0, 14)) {
    const line = clean(raw);
    if (!line || line.length > 70) continue;
    if (name && line.toLowerCase() === String(name).toLowerCase()) continue;
    if (/[@]|\d{6,}|https?:/i.test(line)) continue;      // contact lines
    if (!TITLE_WORDS.test(line)) continue;
    const ok = plausibleValue(firstSegment(line), { maxWords: 9 });
    if (!ok) continue;
    return ok;
  }
  return '';
}

/**
 * Where they work now.
 *
 * The employment section already yields a list of positions; the current
 * employer is the one with no end date, or failing that the first. A
 * summary line - "Currently working at Infosys Limited since March 2021"
 * - is read when the section gives nothing, because a one-page resume
 * often has the sentence and not the table.
 */
function findCurrentCompany(text, employment, experience) {
  const live = (employment || []).find((e) => e && /present|current|till date|now/i.test(String(e.period || e.end || '')));
  const pick = live || (employment || [])[0];
  if (pick && pick.company) return clean(pick.company).slice(0, 80);

  /* LABELLED interpolates its argument straight into the pattern, so the
     alternatives arrive pipe-separated. An array stringifies with commas
     and builds a regex that matches nothing.

     THE LABEL MUST START A LINE, and the bare words "organisation" and
     "organization" are not labels at all: "a growth-oriented organization
     where I can utilize my knowledge of Core Java" put a fresher's career
     objective in the employer column. Only a qualified form counts. */
  const labelled = plausibleValue(labelledValue(text, LABELLED(
    '(?:^|\\n)[ \\t]*(?:current|present|employed\\s*at)\\s*'
    + '(?:employer|company|organisation|organization)'
    + '|(?:^|\\n)[ \\t]*(?:employer|company\\s*name|organisation|organization)')),
    { maxWords: 6 });
  if (labelled) return labelled.slice(0, 80);

  /*
   * The lead-in accepts either case because a resume writes "Currently
   * working at Infosys" at the start of a sentence — but the CAPTURE
   * stays case-sensitive, because capitalisation is the only thing
   * marking where the company name ends. With /i on the whole pattern
   * it read "Infosys Limited since March".
   */
  const m = /[Cc]urrently\s+(?:working|employed)\s+(?:at|with|in)\s+([A-Z][\w&.,'-]*(?:\s+[A-Z][\w&.,'-]*){0,4})|[Pp]resently\s+(?:working\s+)?(?:at|with)\s+([A-Z][\w&.,'-]*(?:\s+[A-Z][\w&.,'-]*){0,4})/
    .exec(String(text || ''));
  if (m) return clean(m[1] || m[2] || '').replace(/\s+(since|from|as)$/i, '').slice(0, 80);

  return findHealthcareEmployer(text, experience);
}

/**
 * The employer on a medical CV, which is named and not tabulated.
 *
 * TeamLink recruits for hospitals, and a doctor's résumé says where they
 * work in prose, inside the experience section:
 *
 *     Senior Resident in Obstetrics and Gynecology, Golconda Area
 *       Hospital, Hyderabad    Jan 2015-16
 *     MEDICAL OFFICER KM MEDICAL CENTRE, BOOTHIPURAM, THENI
 *     worked as a Resident Medical Doctor in GOKUL VENKATESHWARA MULTI
 *       SPECIALITY HOSPITAL, Sangareddy. Since 10th May 2010
 *
 * None of that is a table, so the employment parser found nothing and
 * eleven experienced clinicians had a blank employer.
 *
 * TWO TRAPS make this narrower than it looks. An address names a hospital
 * without working there - "Near Hamidia Hospital, Bhopal" is where the
 * candidate LIVES - so a name introduced by a preposition of place is
 * refused. And a medical college is where a doctor trained, so "MEDICAL
 * COLLEGE" and "UNIVERSITY" are refused unless the name also says
 * hospital: an internship is education, not employment.
 *
 * The search is confined to the experience section, so a clinic in an
 * address block or an education section cannot reach it either.
 */
const HEALTH_ORG = /\b(?:hospital|hospitals|clinic|medical\s+cent(?:re|er)|health\s*cent(?:re|er)|healthcare|health\s*care|nursing\s+home|diagnostics?|scans?\s*cent(?:re|er)|laborator(?:y|ies)|institute\s+of\s+medical\s+sciences)\b/i;
const PLACE_LEAD = /\b(?:near|opposite|opp\.?|beside|behind|adjacent\s+to|next\s+to|in\s+front\s+of|road|street|lane)\s*$/i;
/* The same words swallowed INTO the name, because "Near" is capitalised
   too: "Near Hamidia Hospital" matched as one organisation. */
const PLACE_FIRST = /^(?:near|opposite|opp\.?|beside|behind|adjacent|next|at|in|from|to|the)\b/i;
const TRAINED_NOT_EMPLOYED = /\b(?:medical\s+college|dental\s+college|college\s+of|university|school\s+of)\b/i;
const TRAINING_NOT_WORK = /\b(?:training|internship|intern|apprentice\w*|observership|attachment|rotation|posting|house\s*surgeon|studied|student)\b/i;
/* A year on the line - "Jan 2015-16", "Since 10th May 2010", "2018-2021"
   - is what dates a post and separates it from a passing mention. */
const YEAR_ON_LINE = /\b(?:19|20)\d{2}\b/;

function findHealthcareEmployer(text, experience) {
  /* The experience section first, because a clinic named in an address
     block or an education section is not an employer. Whole-document
     search is the fallback for a CV with no headings at all. */
  /* The whole document is passed alongside, because the training check
     has to see the heading of the table the name sits in - and that
     heading is exactly what was consumed when the section opened. */
  return scanForHealthOrg(experience, text) || scanForHealthOrg(text, text);
}

/**
 * The organisation's name, and nothing that ran into it.
 *
 * A run of capitalised words is how the name is recognised, and on a CV
 * written in title case the run does not start where the name does:
 *
 *     Hospital Experience I.C.C.U Staff Nurse Yashoda Hospitals
 *
 * All of that matched. The name is the tail - so the words before the
 * healthcare word are kept only while they could belong to a name, and
 * the walk stops at the first job title, heading word or initialism.
 */
const NOT_PART_OF_A_NAME = /^(?:experience|history|worked|working|work|as|at|in|from|since|to|present|current|currently|and|with|department|dept|ward|unit|staff|duties|responsibilities)$/i;
const INITIALISM = /^[A-Za-z](?:\.[A-Za-z])+\.?$/;

function trimOrgName(name) {
  const words = clean(name).split(/\s+/);
  if (words.length < 2) return clean(name);

  /* "MEDICAL CENTRE" and "NURSING HOME" are two words; the rest are one. */
  const tailTwo = words.length >= 2
    && /^(?:medical|health|nursing)$/i.test(words[words.length - 2])
    && /^(?:cent(?:re|er)|home)$/i.test(words[words.length - 1]);
  const suffixStart = words.length - (tailTwo ? 2 : 1);

  let cut = suffixStart;
  while (cut > 0) {
    const w = words[cut - 1];
    if (NOT_PART_OF_A_NAME.test(w)) break;
    if (/[()[\]]/.test(w)) break;                // a bracket ends the name
    if (INITIALISM.test(w)) break;
    /* TITLE_WORDS, not JOB_TITLE: the narrower list is for software roles
       and has no "nurse" in it, so "Nurse Yashoda Hospitals" survived. */
    if (TITLE_WORDS.test(w) || JOB_TITLE.test(w)) break;
    if (HEALTH_ORG.test(w)) break;               // a second organisation word
    cut--;
  }
  return words.slice(cut).join(' ');
}

/**
 * Is this organisation ever named as somewhere they WORKED?
 *
 * The name is checked against every place the full document mentions it.
 * A hospital that only ever appears after "training", "internship" or a
 * preposition of place is not an employer, however many times it occurs -
 * one candidate's CV named the hospital next to his house in the address
 * block and the hospital he trained at in a training table, and nowhere
 * else.
 */
function namedAsEmployer(name, full) {
  const doc = String(full || '');
  if (!doc || !name) return true;                // nothing to check against
  let from = 0;
  let seen = false;
  for (;;) {
    const at = doc.indexOf(name, from);
    if (at < 0) break;
    seen = true;
    from = at + 1;
    const before = clean(doc.slice(Math.max(0, at - 140), at));
    if (TRAINING_NOT_WORK.test(before)) continue;
    if (PLACE_LEAD.test(before)) continue;
    return true;                                 // one clean mention is enough
  }
  return !seen;                                  // not in the document at all
}

/**
 * @param needEvidence  demand that the line naming the organisation also
 *   carries a job title or a year. Used when scanning the WHOLE document
 *   rather than the experience section, because a flattened two-column CV
 *   files its career history under whichever heading happens to follow -
 *   one doctor's post sat under "Key competence and skills":
 *
 *     Senior Resident in Obstetrics and Gynecology, Golconda Area
 *       Hospital, Hyderabad    Jan 2015-16
 *
 *   A job title and a date range on the same line are what distinguish
 *   that from a hospital mentioned in passing.
 */
function scanForHealthOrg(text, full, { needEvidence = false } = {}) {
  const src = String(text || '');
  if (!src.trim()) return '';

  /* A run of capitalised or ALL-CAPS words ending in a healthcare word. */
  const re = /([A-Z][A-Za-z&.'()-]*(?:\s+(?:of|and|the|&)?\s*[A-Z][A-Za-z&.'()-]*){0,5}\s+(?:HOSPITAL|Hospital|HOSPITALS|Hospitals|CLINIC|Clinic|MEDICAL\s+CENTRE|MEDICAL\s+CENTER|Medical\s+Centre|Medical\s+Center|HEALTHCARE|Healthcare|NURSING\s+HOME|Nursing\s+Home|DIAGNOSTICS|Diagnostics|LABORATORY|Laboratory))\b/g;

  let m;
  while ((m = re.exec(src))) {
    const name = trimOrgName(m[1]);
    if (!name || name.length < 6) continue;
    /* The name has to say WHICH hospital. Trimming an over-long match can
       leave the bare keyword behind, and "HOSPITALS" is not an employer. */
    if (!name.split(/\s+/).some((w) => !HEALTH_ORG.test(w) && !/^(?:of|and|the|&)$/i.test(w))) continue;
    if (PLACE_FIRST.test(name)) continue;                  // "Near Hamidia Hospital"
    if (TRAINED_NOT_EMPLOYED.test(name) && !/hospital/i.test(name)) continue;
    const before = src.slice(Math.max(0, m.index - 24), m.index);
    if (PLACE_LEAD.test(clean(before))) continue;          // an address, not an employer
    /*
     * TRAINING IS NOT EMPLOYMENT.
     *
     * "CLINICAL TRAINING EXPERIENCE | Duration | Type | Institution |
     *  9 Months | Radiology (X-Ray) | Hamidia Hospital, Bhopal"
     *
     * opens an experience section on the word "experience" and names a
     * hospital the candidate trained at, never worked for. A wider
     * lookback catches the heading of the table as well as the sentence
     * form ("my clinical training at Hamidia Hospital"), and a blank
     * employer is the right answer for both.
     */
    if (TRAINING_NOT_WORK.test(clean(src.slice(Math.max(0, m.index - 140), m.index)))) continue;
    if (!namedAsEmployer(name, full || src)) continue;
    if (needEvidence) {
      const from = src.lastIndexOf('\n', m.index) + 1;
      const to = src.indexOf('\n', m.index);
      const line = clean(src.slice(from, to < 0 ? src.length : to));
      if (!TITLE_WORDS.test(line) && !YEAR_ON_LINE.test(line)) continue;
    }
    if (!HEALTH_ORG.test(name)) continue;
    const ok = plausibleValue(name, { maxWords: 7 });
    if (ok) return ok.slice(0, 80);
  }
  return '';
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
  const personal = t.replace(sections.references || '\x00', '');

  const email = findEmail(personal);
  /* Read once: the name and, when there is none, the guess. */
  const nameRead = nameFrom(personal, email);
  /* 0117: digits inside an email address ("rahul.9876543210@...") are not
     a phone number. */
  const phones = findPhones(personal.replace(/[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}/gi, ' '));
  const links = findLinks(t);

  const employment = findEmployment(sections);

  /*
   * A FRESHER HAS NO EMPLOYER.
   *
   * Sixty-six of the hundred and seventy-three resumes on file state no
   * experience at all, and their pages are full of company names anyway -
   * a project done at Hero Moto Corp, a training at Apollo, a college's
   * industry visit. Read as a labelled "Organization:" line, any of those
   * becomes a current employer that the person does not have.
   *
   * So the weak signals - a labelled line, a sentence in the summary -
   * are only consulted for someone whose resume claims experience. A
   * dated entry in the employment section is evidence in itself and is
   * always believed.
   */
  const statedYears = findExperienceYears(t);
  const hasWorked = employment.length > 0 || Number(statedYears) > 0;

  const skills = findList(sections.skills, { max: 40 });
  const certifications = findList(sections.certifications, { max: 15, minLen: 4 });
  const projects = findList(sections.projects, { max: 12, minLen: 4 });
  /* One item per LINE, not per comma: "Winner, Smart India Hackathon
     2022" is one achievement, and "Data Science Intern, Acme Analytics"
     is one internship. */
  const lineItems = (sec, max) => String(sec || '').split('\n')
    .map((l) => l.replace(/^[\s\u2022\u25cf\u25aa\u2023\u2043*\-–—>]+/, '').replace(/^\d+[.)]\s+/, '').trim())
    .filter((l) => l.length >= 4 && l.length <= 300)
    .slice(0, max);
  /* 0117: a project is usually one line - "Name - what it did" - and longer
     than a skill. When the list reader keeps none, the lines are the list. */
  if (!projects.length) projects.push(...lineItems(sections.projects, 12));
  const internships = lineItems(sections.internships, 10);
  const achievements = lineItems(sections.achievements, 12);
  const languages = findList(sections.languages, { max: 10, minLen: 3 });

  const raw = {
    name: nameRead.name,
    /*
     * A GUESS, MARKED AS ONE.
     *
     * Only set when the document itself yielded no name. The form shows
     * it as a question - "Is your name Pallavi U?" - and writes nothing
     * until the candidate says yes. It must never be treated as an
     * extracted value: a recruiter reading the profile has no way to
     * tell a guess from a fact, so the guess never gets that far.
     */
    nameSuggestion: nameRead.suggestion,
    email,
    phone: phones[0] || null,
    altPhone: phones[1] || null,
    location: findLocation(t, 'current'),
    preferredLocation: findLocation(t, 'preferred'),
    /* The employment block first, then a labelled line, then the shape a
       resume actually uses - the designation under the name, and
       "currently working at X" in the summary. Without that last step
       both came back empty for any CV whose experience section is prose
       rather than a table, which is most of them. */
    /* Every branch goes through plausibleValue: a labelled line is only
       believed when what follows the label is actually a value, not the
       next heading of a flattened two-column table. */
    title: plausibleValue(firstSegment(employment[0]?.title), { maxWords: 9 })
      || plausibleValue(firstSegment(firstMatch(t,
          LABELLED('(?:^|\\n)[ \\t]*(?:designation|current\\s*designation|job\\s*title)',
                   '[^\\n]{0,50}'))), { maxWords: 9 })
      || findTitle(t, sections, nameRead.name),
    currentCompany: plausibleValue(employment[0]?.company, { maxWords: 6 })
      || (hasWorked
        ? plausibleValue(firstMatch(t,
            LABELLED('(?:^|\\n)[ \\t]*(?:current\\s*(?:company|employer)|company\\s*name)',
                     '[^\\n]{0,50}')), { maxWords: 6 })
        : '')
      /* NOT subject to the fresher gate. A hospital named inside the
         experience section is evidence of having worked there in itself,
         and a doctor's CV dates the post - "Senior Resident …, Golconda
         Area Hospital, Hyderabad Jan 2015-16" - without ever stating a
         number of years, so the gate was blanking clinicians who plainly
         have an employer. */
      || plausibleValue(scanForHealthOrg(sections.experience, t), { maxWords: 7 })
      || plausibleValue(scanForHealthOrg(t, t, { needEvidence: true }), { maxWords: 7 })
      || (hasWorked ? findCurrentCompany(t, employment, sections.experience) : ''),
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
    educationRecords: findEducationRecords(sections.education),
    summary: sections.summary ? clean(sections.summary).slice(0, 1200) : null,
    skills,
    certifications,
    projects,
    languages,
    dob: findDob(t),
    linkedin: links.linkedin,
    github: links.github,
    portfolio: links.portfolio,
    internships,
    achievements,
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
