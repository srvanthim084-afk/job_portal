/**
 * Naukri's NVite response - one candidate, with their CV attached.
 *
 * This is the email that actually matters and it was being thrown away.
 * The daily summary is a teaser: three names, no contact details, no
 * attachment, and a link to the rest. NVite is the opposite - ONE
 * applicant, their skills, their education, their notice period, and
 * RESUME.pdf on the message. Sixteen of them sat in the mailbox marked
 * "No candidate name could be read from this email" while the recruiter
 * was told the sync was working.
 *
 * WHY THE EXISTING PARSER COULD NOT READ IT. Every other format writes
 * "Notice Period: 15 Days or less" on one line. NVite puts the label on
 * its own line and the value on the next:
 *
 *     Notice Period
 *     15 Days or less
 *     Education
 *     B.Tech / B.E. at Holy Mary Institute of Technology and Science
 *     Keyskills
 *     Excel,MS Office,HTML and CSS,Java,Python,DSA,SQL
 *
 * The labelled-block reader looks for a colon, finds none, and reports
 * that the email has no candidate in it - which is true of the SHAPE it
 * was looking for and false of the email.
 *
 * WHERE THE NAME COMES FROM. The body has it, between the posting date
 * and the experience line, but the From header carries it too -
 * "Roopika Domala <roopikayadav4.gmail@naukri.com>" - and a display name
 * is far harder to misread than a position in a list. The header is
 * preferred and the body is the fallback.
 *
 * WHAT IS NOT HERE: the email address and the phone number. Naukri puts
 * them behind a "View Contact Details" link now, as a privacy measure,
 * so the message genuinely does not contain them. THE RESUME DOES,
 * though, and the attachment is imported and read by the same extractor
 * everything else uses - so the contact details arrive from the CV
 * rather than from the mail. That is the whole reason this is worth
 * parsing.
 */

const clean = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();

/** "Roopika Domala <roopikayadav4.gmail@naukri.com>" -> the name. */
function nameFromHeader(from) {
  const s = String(from || '').trim();
  const m = /^\s*"?([^"<]+?)"?\s*</.exec(s);
  const name = clean(m ? m[1] : '');
  // An address on its own, or a mailbox name, is not a person's name.
  if (!name || name.includes('@')) return '';
  if (/^(naukri|info|noreply|no-reply|support|jobs)$/i.test(name)) return '';
  return name;
}

/**
 * Is this an NVite response?
 *
 * Two signals, and the subject alone is not enough: a forwarded one
 * keeps the subject and loses the sender, and somebody writing "NVite"
 * in a covering note is not an application.
 */
export function looksLikeNvite(message = {}) {
  const subject = String(message.subject || '');
  const text = String(message.text || message.raw || '');
  if (/^\s*NVite\b/i.test(subject)) return true;
  return /\bNVite\b/i.test(text) && /you have a new response/i.test(text);
}

/** The value on the line after a label that sits on its own line. */
function after(lines, label) {
  const want = String(label).toLowerCase();
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i].toLowerCase() !== want) continue;
    const v = clean(lines[i + 1]);
    if (!v) continue;
    // A label followed immediately by another label means the field was
    // empty; reading the next label as its value invents data.
    if (LABELS.has(v.toLowerCase())) return '';
    return v;
  }
  return '';
}

const LABELS = new Set([
  'job title', 'applicants', 'location', 'past experience', 'notice period',
  'education', 'keyskills', 'key skills', 'view contact details', 'view response',
  'contact us', 'nvite', 'you have a new response',
]);

/**
 * Read one NVite response.
 *
 * @returns {{ name, appliedRole, location, preferredLocation, experience,
 *             noticePeriod, education, skills[] }|null}
 */
export function parseNvite(message = {}) {
  const text = String(message.text || '');
  const lines = text.split('\n').map(clean).filter(Boolean);
  if (!lines.length) return null;

  const name = nameFromHeader(message.from) || bodyName(lines);
  if (!name) return null;

  /*
   * "Hyderabad (preferred location is Hyderabad/Secunderabad)" is two
   * facts on one line, and a recruiter filtering by city needs them
   * apart.
   */
  const rawLocation = after(lines, 'location');
  const pref = /\(preferred location is ([^)]+)\)/i.exec(rawLocation);
  const location = clean(rawLocation.replace(/\(preferred location is [^)]*\)/i, ''));

  const skills = after(lines, 'keyskills') || after(lines, 'key skills');

  const notMentioned = (v) => (/^not mentioned$/i.test(v) ? '' : v);

  return {
    name,
    appliedRole: after(lines, 'job title'),
    location: notMentioned(location),
    preferredLocation: pref ? clean(pref[1].replace(/\//g, ', ')) : '',
    experience: notMentioned(experienceOf(lines)),
    noticePeriod: notMentioned(after(lines, 'notice period')),
    education: notMentioned(after(lines, 'education')),
    skills: skills
      ? skills.split(/[,|]/).map(clean).filter(Boolean).slice(0, 40)
      : [],
  };
}

/**
 * The experience line, which has no label of its own.
 *
 * It sits directly under the name - "Roopika Domala / Not Mentioned /
 * Fresher" - and is recognised by its SHAPE rather than its position,
 * because a position is a guess that breaks the first time Naukri adds a
 * line.
 */
function experienceOf(lines) {
  for (const l of lines) {
    if (/^fresher$/i.test(l)) return 'Fresher';
    if (/^\d+\s*(years?|yrs?)(\s+(&|and)\s*\d+\s*months?)?$/i.test(l)) return l;
    if (/^\d+\s*(years?|yrs?)\s*\d+\s*months?$/i.test(l)) return l;
  }
  return '';
}

/** The name from the body, when the header has none. */
function bodyName(lines) {
  const at = lines.findIndex((l) => /^posted\b.*\bago$/i.test(l));
  if (at < 0 || at + 1 >= lines.length) return '';
  const candidate = clean(lines[at + 1]);
  if (!candidate || LABELS.has(candidate.toLowerCase())) return '';
  if (/^\d/.test(candidate)) return '';
  return candidate;
}
