/**
 * Profile completeness (0117).
 *
 * ONE DEFINITION. The candidate profile already scores itself from twelve
 * sections (web/teamlink-profile-sections.js, `SECTIONS` / capCompletion):
 * 100% only when every section is complete, and never rounded up to 100
 * while one is missing. This is the same twelve sections, the same rule
 * for each, and the same arithmetic - on the server, so registration can
 * say how complete the new profile is, and the number the candidate sees
 * there is the number the profile page shows. A change to a section's
 * rule is made in both places, in the same commit.
 *
 * Underneath the sections, every field has a status:
 *
 *   EXTRACTED       read from the resume at registration
 *   USER_PROVIDED   typed by the candidate (or entered for them)
 *   MISSING         empty
 *
 * (candidates.profile_field_sources, written at registration). A missing
 * field is what "complete your profile" asks for - and only that.
 */

const nonEmpty = (v) => v !== null && v !== undefined && String(v).trim() !== '';
const list = (v) => (Array.isArray(v) ? v : []);
const objs = (v) => list(v).filter((x) => x && typeof x === 'object');

/* key, label, the fields behind it, and the rule - as in SECTIONS (web) */
export const SECTIONS = [
  { key: 'basic', label: 'Basic details', fields: ['name', 'email', 'phone', 'location'],
    done: (r) => nonEmpty(r.name) && nonEmpty(r.email) && nonEmpty(r.phone) && nonEmpty(r.location) },
  { key: 'summary', label: 'Profile summary', fields: ['summary'],
    done: (r) => String(r.summary || '').trim().length >= 20 },
  { key: 'education', label: 'Education', fields: ['education'],
    done: (r, x) => x.educationRows > 0 || nonEmpty(r.education) },
  { key: 'skills', label: 'Key skills', fields: ['skills'],
    done: (r) => {
      const all = new Set();
      list(r.skills).concat(list(r.technical_skills)).forEach((s) => { if (nonEmpty(s)) all.add(String(s).toLowerCase()); });
      return all.size >= 3;
    } },
  { key: 'projects', label: 'Projects', fields: ['projects'],
    done: (r) => objs(r.projects).some((p) => nonEmpty(p.name)) },
  { key: 'employment', label: 'Internships / employment', fields: ['experience', 'currentCompany'],
    done: (r, x) => x.experienceRows > 0 || nonEmpty(r.current_company)
      || objs(r.internships).some((i) => nonEmpty(i.role) || nonEmpty(i.org)) },
  { key: 'certifications', label: 'Certifications', fields: ['certifications'],
    done: (r) => list(r.certifications).length > 0 },
  { key: 'languages', label: 'Languages', fields: ['languages'],
    done: (r) => list(r.languages).length > 0 },
  { key: 'career', label: 'Career preferences',
    fields: ['preferredRole', 'preferredLocation', 'noticePeriod', 'expectedSalary', 'workMode'],
    done: (r) => nonEmpty(r.preferred_role || r.title) && nonEmpty(r.preferred_location)
      && nonEmpty(r.notice_period) && Number(r.expected_ctc) > 0 && list(r.preferred_work_modes).length > 0 },
  { key: 'availability', label: 'Availability', fields: ['joining', 'relocation'],
    done: (r) => (r.immediate_joiner === true || nonEmpty(r.available_from) || nonEmpty(r.preferred_joining_date))
      && (r.willing_to_relocate === true || r.willing_to_relocate === false) },
  { key: 'resume', label: 'Resume', fields: ['resume'],
    done: (r) => nonEmpty(r.resume_file) },
  { key: 'links', label: 'Professional links', fields: ['linkedin'],
    done: (r) => nonEmpty(r.linkedin) || nonEmpty(r.github) || nonEmpty(r.portfolio)
      || objs(r.other_links).some((l) => nonEmpty(l.url)) },
];

/* field -> label and the value behind it */
const FIELDS = {
  name: ['Full name', (r) => r.name],
  email: ['Email', (r) => r.email],
  phone: ['Mobile number', (r) => r.phone],
  location: ['Current location', (r) => r.location],
  summary: ['Profile summary', (r) => r.summary],
  education: ['Education', (r, x) => (x.educationRows > 0 ? 'rows' : r.education)],
  skills: ['Key skills', (r) => list(r.skills).concat(list(r.technical_skills))],
  projects: ['Projects', (r) => objs(r.projects)],
  experience: ['Work experience', (r, x) => (x.experienceRows > 0 ? 'rows' : null)],
  currentCompany: ['Current company', (r) => r.current_company],
  certifications: ['Certifications', (r) => r.certifications],
  languages: ['Languages', (r) => r.languages],
  preferredRole: ['Preferred role', (r) => r.preferred_role || r.title],
  preferredLocation: ['Preferred location', (r) => r.preferred_location],
  noticePeriod: ['Notice period', (r) => r.notice_period],
  expectedSalary: ['Expected salary', (r) => (Number(r.expected_ctc) > 0 ? r.expected_ctc : null)],
  workMode: ['Work mode', (r) => r.preferred_work_modes],
  joining: ['Joining date / immediate joiner',
    (r) => (r.immediate_joiner === true || nonEmpty(r.available_from) || nonEmpty(r.preferred_joining_date) ? 'yes' : null)],
  relocation: ['Willing to relocate', (r) => (r.willing_to_relocate === true || r.willing_to_relocate === false ? 'yes' : null)],
  resume: ['Resume', (r) => r.resume_file],
  linkedin: ['LinkedIn or other professional link',
    (r) => r.linkedin || r.github || r.portfolio || (objs(r.other_links).some((l) => nonEmpty(l.url)) ? 'yes' : null)],
};

/* resume-reading key -> the profile field it fills */
export const EXTRACTION_TO_FIELD = {
  name: 'name', email: 'email', phone: 'phone',
  skills: 'skills', education: 'education', qualification: 'education', educationRecords: 'education',
  employmentHistory: 'experience', currentCompany: 'currentCompany', title: 'preferredRole',
  summary: 'summary', projects: 'projects', certifications: 'certifications',
  linkedin: 'linkedin', github: 'linkedin', portfolio: 'linkedin', languages: 'languages',
};

const present = (v) => (Array.isArray(v) ? v.length > 0 : nonEmpty(v));

/** Pure: a candidates row (+ record counts) in, the completeness out. */
export function completenessOf(row, { educationRows = 0, experienceRows = 0 } = {}) {
  const r = row || {};
  const x = { educationRows, experienceRows };
  const sources = (r.profile_field_sources && typeof r.profile_field_sources === 'object')
    ? r.profile_field_sources : {};

  const fields = Object.entries(FIELDS).map(([key, [label, get]]) => {
    const has = present(get(r, x));
    return { key, label, status: !has ? 'MISSING' : (sources[key] === 'EXTRACTED' ? 'EXTRACTED' : 'USER_PROVIDED') };
  });
  const byKey = Object.fromEntries(fields.map((f) => [f.key, f]));

  const sections = SECTIONS.map((s) => ({
    key: s.key, label: s.label, done: !!s.done(r, x),
    missingFields: s.done(r, x) ? [] : s.fields.filter((f) => byKey[f] && byKey[f].status === 'MISSING')
      .map((f) => ({ key: f, label: byKey[f].label })),
  }));
  const done = sections.filter((s) => s.done).length;
  /* Rounding must never turn "eleven of twelve" into 100 (same as the page). */
  const pct = Math.round((100 * done) / sections.length);
  const percent = done < sections.length ? Math.min(pct, 99) : 100;
  const missing = sections.filter((s) => !s.done).map((s) => ({
    key: s.key, label: s.label,
    fields: s.missingFields.length ? s.missingFields : undefined,
  }));
  return { percent, complete: done === sections.length, sections, fields, missing };
}

/** Reads the candidate (under the caller's rights) and works it out. */
export async function completenessFor(c, candidateId) {
  const row = (await c.query(`select * from candidates where id=$1`, [candidateId])).rows[0];
  if (!row) return null;
  const { rows } = await c.query(
    `select (select count(*)::int from candidate_education where candidate_id=$1) as edu,
            (select count(*)::int from candidate_experience where candidate_id=$1) as exp`, [candidateId]);
  return completenessOf(row, { educationRows: rows[0].edu, experienceRows: rows[0].exp });
}
