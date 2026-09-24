/**
 * Shine's "Email Response" - one candidate, with their CV attached.
 *
 * This is the format that had never been seen. The shapes in source.js
 * were written from Shine's documentation and marked `verified: false`
 * for months because no Shine message had ever arrived in the mailbox.
 * Seventeen of them had, in fact, been arriving all along - from
 * recruiters@alerts.shine.com, with subjects like "Email Response-Hiring
 * for Radiologist" - and every one was recorded as "No candidate name
 * could be read from this email".
 *
 * WHAT THE EMAIL ACTUALLY LOOKS LIKE:
 *
 *     You have received an email response for Hiring for Radiologist.
 *     The candidate profile is detailed below:
 *     S                              <- an avatar initial, not a name
 *     Rahul Pandey
 *     Ct & Mri Technician
 *     Bhopal
 *     Experience: 3 Yrs 0 Month
 *     Desired Location: Not Mentioned
 *     Education: PG Diploma, Radiology, MAAN College...
 *     Skills: ct scan operations,mri safety screening,...more
 *
 * Three bare lines - name, title, city - with no labels at all, then
 * four labelled ones. The labelled-block reader finds the last four and
 * no name, because the name is not labelled anywhere in the message.
 *
 * THE INITIAL IS THE TRAP. "S" sits where a name would be, and taking
 * the first line after the heading would have imported a candidate
 * called S. It is skipped by length rather than by position, because a
 * position breaks the first time Shine changes the layout.
 *
 * The contact details are not in the message - Shine keeps them behind a
 * login, as Naukri does - but the ATTACHED CV has them, and it is read
 * before the candidate is created.
 */

const clean = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();

/**
 * Shine's several ways of writing "this field is empty".
 *
 * "Not Mentioned" for a location and the literal word "None" for a job
 * title - and the second one is worth naming, because two of the real
 * responses have it. Shine's own attachment is named "Amit arvind sonar -
 * Job Title Blank - 0 Yr 0 Month.pdf", so Shine agrees the field is
 * blank; only the body says "None". Storing that puts a candidate whose
 * designation reads None in front of a recruiter.
 */
const blank = (v) => (/^(not mentioned|none|n\/?a|-+)$/i.test(clean(v)) ? '' : clean(v));

/**
 * Is this a Shine response?
 *
 * The sender is the strongest signal and the hardest to fake. A
 * forwarded one keeps the wording, so the body is the fallback - both
 * sentences, not one, because "new application" alone appears in plenty
 * of mail that is not this.
 */
export function looksLikeShine(message = {}) {
  const from = String(message.from || '').toLowerCase();
  const text = String(message.text || message.raw || '');
  if (/@(alerts\.)?shine\.com|@my\.shine\.com/i.test(from)) return true;
  return /you have received an email response/i.test(text)
    && /candidate profile is detailed below/i.test(text);
}

/** "Label: value" on one line. */
function labelled(lines, label) {
  const re = new RegExp(`^${label}\\s*:\\s*(.+)$`, 'i');
  for (const l of lines) {
    const m = re.exec(l);
    if (m) return clean(m[1]);
  }
  return '';
}

/**
 * Read one Shine response.
 *
 * @returns {{ name, title, location, appliedRole, experience,
 *             preferredLocation, education, skills[] }|null}
 */
export function parseShine(message = {}) {
  const lines = String(message.text || '')
    .split('\n').map(clean).filter(Boolean);
  if (!lines.length) return null;

  /*
   * The role, from the sentence that states it.
   *
   * READ ACROSS THE LINE BREAKS, not line by line. "You have received an
   * email response for Hiring for an OBGY Consultant." arrives wrapped,
   * and reading one line at a time returned the role as "an OBGY" -
   * which is not a job, and would have been matched against the open
   * requirements as though it were.
   *
   * It is bounded by the sentence that follows rather than by a full
   * stop: plenty of these titles contain one ("M.D Radio-Diagnosis"),
   * and stopping at the first period truncates them.
   */
  const flat = lines.join(' ');
  let appliedRole = '';
  const said = /you have received an email response for\s+(?:hiring for\s+)?([\s\S]*?)\s*\.?\s*(?:the candidate profile|$)/i
    .exec(flat);
  if (said) appliedRole = clean(said[1]);

  /*
   * The subject is the fallback - "Email Response-Hiring for Radiologist"
   * - for a forward whose body was trimmed.
   */
  if (!appliedRole) {
    const m = /email\s*response\s*-\s*(?:hiring for\s+)?(.+)$/i.exec(String(message.subject || ''));
    if (m) appliedRole = clean(m[1]);
  }
  // A leading article is Shine's phrasing, not part of the job title.
  appliedRole = appliedRole.replace(/^(an?|the)\s+/i, '');

  const at = lines.findIndex((l) => /candidate profile is detailed below/i.test(l));
  if (at < 0) return null;

  /*
   * The three unlabelled lines after the heading, skipping the avatar
   * initial and stopping at the first labelled line.
   */
  const bare = [];
  for (let i = at + 1; i < lines.length && bare.length < 3; i++) {
    const l = lines[i];
    if (/^[A-Za-z]{1,2}$/.test(l)) continue;             // the avatar
    if (/^[a-z ]+:\s/i.test(l)) break;                   // a labelled line
    if (/^(experience|education|skills|desired location|update)\b/i.test(l)) break;
    bare.push(l);
  }
  const name = bare[0] || '';
  if (!name || name.length < 2) return null;

  const skills = labelled(lines, 'skills')
    .replace(/\.\.\.\s*more$/i, '')                      // Shine truncates the list
    .split(/[,|]/).map(clean).filter(Boolean).slice(0, 40);

  return {
    name,
    title: blank(bare[1] || ''),
    location: blank(bare[2] || ''),
    appliedRole,
    experience: blank(labelled(lines, 'experience')),
    preferredLocation: blank(labelled(lines, 'desired location')),
    education: blank(labelled(lines, 'education')),
    skills,
  };
}
