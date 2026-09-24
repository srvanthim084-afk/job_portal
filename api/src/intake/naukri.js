/**
 * Reading Naukri's response digest.
 *
 * Naukri does not email one message per applicant. It sends a daily
 * "Summary of Total Responses Received" carrying the top few candidates
 * for a job, and the old parser looked for one labelled candidate block,
 * found none, and marked the whole thing "no candidate name could be
 * read" - so 87 real applications sat in a queue saying nothing useful.
 *
 * The digest is rigidly laid out, which is what makes it readable. Once
 * the HTML is flattened, each candidate is exactly ten lines:
 *
 *     Kasem Bhuiya                                    name
 *     Paramedic at Interglobe Aviation from 2024 -    current role
 *     5y 6m                                           experience
 *     0.40 Lacs                                       current CTC
 *     15 Days or less                                 notice period
 *     Bengaluru                                       location
 *     Previously Staff Nurse at Omni Hospital ...     previous role
 *     Diploma, General Nursing from RR School, 2016-  education
 *     Preferred - Secunderabad, Bengaluru/Bangalore   preferred locations
 *     Medications administration | Acls | Bls | ...   skills
 *
 * The line beginning "Previously" is the anchor: every candidate has
 * exactly one, and the other nine sit at fixed offsets around it. That
 * survives a missing value, because Naukri writes "Not Mentioned" rather
 * than dropping the line.
 *
 * WHAT IS NOT IN HERE: an email address or a phone number. Naukri keeps
 * contact details behind the "View" link on their own site, so these
 * fields come back empty and the candidate is imported without them
 * rather than rejected for lacking them.
 */

/** Naukri's way of saying a field is empty. */
const NOT_GIVEN = /^(not mentioned|n\/?a|-+)$/i;
const clean = (s) => {
  const v = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return NOT_GIVEN.test(v) ? '' : v;
};

/** Is this the digest, rather than some other mail from Naukri? */
export function looksLikeDigest(text) {
  const t = String(text || '');
  return /top candidates who applied/i.test(t)
    || /candidates? applied to your job/i.test(t)
    || /responses? received/i.test(t);
}

/**
 * The requirement the digest is about.
 *
 * It sits on its own line between the count and the candidate list:
 *
 *     87 candidates applied to your job today
 *     Human Resource Recruiter          <- this
 *     Top candidates who applied on your job
 */
function jobTitleOf(lines) {
  const at = lines.findIndex((l) => /candidates? applied to your job/i.test(l));
  if (at >= 0 && lines[at + 1] && !/^top candidates/i.test(lines[at + 1])) {
    return clean(lines[at + 1]);
  }
  // Some digests put it in the subject instead, which the caller passes
  // in; nothing is invented here.
  return '';
}

/** "5y 6m" -> 5.5 · "1y 9m" -> 1.75 · "Fresher" -> 0 */
function yearsOf(raw) {
  const s = String(raw || '');
  if (/fresher/i.test(s)) return 0;
  const y = Number((/(\d+)\s*y/i.exec(s) || [])[1] || 0);
  const m = Number((/(\d+)\s*m/i.exec(s) || [])[1] || 0);
  if (!y && !m) return null;
  return Math.round((y + m / 12) * 100) / 100;
}

/** "SAP MM Functional Consultant at G Tech Solutions from 2024 - Present" */
function roleAndCompany(raw) {
  const s = clean(raw).replace(/^previously\s+/i, '');
  if (!s) return { title: '', company: '' };
  const m = /^(.*?)\s+at\s+(.*?)(?:\s+from\s+.*)?$/i.exec(s);
  if (m) return { title: clean(m[1]), company: clean(m[2]) };
  return { title: s.replace(/\s+from\s+.*$/i, '').trim(), company: '' };
}

/**
 * Every candidate in one digest.
 *
 * @param text   the flattened email body
 * @param opts   { subject } - used only when the body has no job title
 * @returns {{ jobTitle: string, candidates: object[] }}
 */
export function parseNaukriDigest(text, opts = {}) {
  const lines = String(text || '')
    .split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);

  const out = { jobTitle: jobTitleOf(lines), candidates: [] };

  /*
   * HOW MANY THERE REALLY ARE, and where the rest of them live.
   *
   * This email is a teaser and says so twice: "87 candidates applied to
   * your job today", then "Top candidates who applied on your job" above
   * three people, then "View all 426 responses" with a link. Three is
   * everything the message contains; the other 423 are on Naukri behind
   * that link.
   *
   * Reading those two numbers is what lets the screen say "3 of 426 are
   * here" instead of showing three candidates and leaving a recruiter to
   * assume that was all of them. The gap was invisible, which is the
   * worst thing a gap can be.
   */
  const applied = /(\d[\d,]*)\s+candidates?\s+applied/i.exec(text || '');
  if (applied) out.appliedCount = Number(applied[1].replace(/,/g, ''));

  const total = /view\s*all\s*(\d[\d,]*)\s*responses/i.exec(
    String(text || '').replace(/\s+/g, ' '));
  if (total) out.totalResponses = Number(total[1].replace(/,/g, ''));

  /*
   * The link to that list, unwrapped.
   *
   * Naukri routes it through an app-link shortener with the real address
   * in a `link=` parameter, so the useful one has to be pulled back out -
   * a recruiter clicking the wrapper on a desktop gets an app store.
   */
  if (opts.raw) {
    const flat = String(opts.raw).replace(/=\r?\n/g, '');
    const inner = /link=3?D?(https?%3A|https?:)[^&"'\s>]*applies[^&"'\s>]*/i.exec(flat);
    const direct = /https?:\/\/hiring\.naukri\.com\/[^\s"'<>]*applies[^\s"'<>]*/i.exec(flat);
    let url = direct ? direct[0] : (inner ? inner[0].replace(/^link=3?D?/i, '') : '');
    try { url = decodeURIComponent(url); } catch { /* keep it as it came */ }
    url = url.replace(/&amp;/g, '&').replace(/=3D/g, '=');
    if (/^https?:\/\/[^\s]*naukri\.com/i.test(url)) out.responsesUrl = url;
  }

  if (!out.jobTitle && opts.subject) {
    const m = /(?:response|application)s?\s+for\s+(.+?)\s*$/i.exec(String(opts.subject));
    if (m) out.jobTitle = clean(m[1]);
  }

  /*
   * Stop at the footer. "JOB PERFORMANCE SO FAR" is a block of counts -
   * "34 / Job applies" - and reading it as candidates would invent
   * people called "0 - 5 years experience".
   */
  const footer = lines.findIndex((l) => /^job performance so far/i.test(l));
  const body = footer > 0 ? lines.slice(0, footer) : lines;

  for (let p = 0; p < body.length; p++) {
    if (!/^previously\b/i.test(body[p])) continue;
    // Six lines of candidate must precede it, or this is not a block.
    if (p < 6) continue;

    const name = clean(body[p - 6]);
    if (!name || /^top candidates/i.test(name) || /applied to your job/i.test(name)) continue;

    const current = roleAndCompany(body[p - 5]);
    const previous = roleAndCompany(body[p]);
    const education = clean(body[p + 1]);
    const preferred = clean(body[p + 2]).replace(/^preferred\s*-\s*/i, '');
    const skillsLine = clean(body[p + 3]);

    // The skills line is pipe-separated; anything else on that line is
    // not skills, so it is left out rather than guessed at.
    const skills = /\|/.test(skillsLine)
      ? skillsLine.split('|').map((s) => s.trim()).filter(Boolean).slice(0, 40)
      : [];

    out.candidates.push({
      name,
      // Naukri's digest carries neither. Left blank deliberately - the
      // recruiter opens the profile on Naukri for contact details.
      email: '',
      phone: '',
      title: current.title,
      currentCompany: current.company,
      previousCompany: previous.company,
      experience: clean(body[p - 4]),
      expYears: yearsOf(body[p - 4]),
      currentCtc: clean(body[p - 3]),
      noticePeriod: clean(body[p - 2]),
      location: clean(body[p - 1]),
      preferredLocation: preferred.split(',')[0] ? preferred.split(',')[0].trim() : '',
      education,
      skills,
      source: 'Naukri',
    });
  }

  return out;
}
