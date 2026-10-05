/**
 * Profile completion ("Profile Strength") on the server (0111).
 *
 * The SAME twelve sections, with the same tests, as the candidate's own
 * screen (web/teamlink-profile-sections.js, capSections/capCompletion), so
 * the percentage a recruiter sees on the ATS record, the number on the
 * candidate dashboard and the one in the analytics are one number. If a
 * section changes there, it changes here - the test file
 * api/test/ats-record.test.mjs pins the two together on the same input.
 *
 * Input is the camelCase candidate shape (shapes.js toCandidate) plus
 * educationRecords / experienceRecords arrays (only their length is read).
 */
import { toCandidate } from '../shapes.js';

const nonEmpty = (v) => v != null && String(v).trim() !== '';
const list = (v) => (Array.isArray(v) ? v : []);

export const SECTIONS = [
  ['basic', 'Basic details', (c) => nonEmpty(c.name) && nonEmpty(c.email) && nonEmpty(c.phone) && nonEmpty(c.location)],
  ['summary', 'Profile summary', (c) => String(c.summary || '').trim().length >= 20],
  ['education', 'Education', (c) => list(c.educationRecords).length > 0 || nonEmpty(c.education)],
  ['skills', 'Key skills', (c) => {
    const all = new Set();
    list(c.skills).concat(list(c.technicalSkills)).forEach((s) => { if (nonEmpty(s)) all.add(String(s).toLowerCase()); });
    return all.size >= 3;
  }],
  ['projects', 'Projects', (c) => list(c.projects).some((p) => p && nonEmpty(p.name))],
  ['employment', 'Internships / employment', (c) => list(c.experienceRecords).length > 0 || nonEmpty(c.currentCompany)
    || list(c.internships).some((x) => x && (nonEmpty(x.role) || nonEmpty(x.org)))],
  ['certifications', 'Certifications', (c) => list(c.certifications).length > 0],
  ['languages', 'Languages', (c) => list(c.languages).length > 0],
  ['career', 'Career preferences', (c) => nonEmpty(c.preferredRole || c.title) && nonEmpty(c.preferredLocation)
    && nonEmpty(c.noticePeriod) && Number(c.expectedCtc) > 0 && list(c.preferredWorkModes).length > 0],
  ['availability', 'Availability', (c) => (c.immediateJoiner === true || nonEmpty(c.availableFrom) || nonEmpty(c.preferredJoiningDate))
    && (c.willingToRelocate === true || c.willingToRelocate === false)],
  ['resume', 'Resume', (c) => nonEmpty(c.resumeFile)],
  ['links', 'Professional links', (c) => nonEmpty(c.linkedin) || nonEmpty(c.github) || nonEmpty(c.portfolio)
    || list(c.otherLinks).some((l) => l && nonEmpty(l.url))],
];

/** { percent, done, total, missing:[label] } - 100 only when all twelve are complete. */
export function profileScore(c) {
  if (!c) return { percent: 0, done: 0, total: SECTIONS.length, missing: SECTIONS.map((s) => s[1]) };
  const missing = SECTIONS.filter((s) => !s[2](c)).map((s) => s[1]);
  const done = SECTIONS.length - missing.length;
  const pct = Math.round((100 * done) / SECTIONS.length);
  return { percent: done < SECTIONS.length ? Math.min(pct, 99) : 100, done, total: SECTIONS.length, missing };
}

/**
 * Profile scores for many candidates in one go, inside an open
 * transaction (`c` is a client from withUser). RLS on `candidates`
 * decides which rows come back; ids that are not visible are absent.
 */
export async function profileScoresFor(c, ids) {
  const out = new Map();
  if (!ids || !ids.length) return out;
  const rows = (await c.query(`select * from candidates where id = any($1::text[])`, [ids])).rows;
  const edu = (await c.query(
    `select candidate_id, count(*)::int n from candidate_education where candidate_id = any($1::text[]) group by 1`, [ids])).rows;
  const exp = (await c.query(
    `select candidate_id, count(*)::int n from candidate_experience where candidate_id = any($1::text[]) group by 1`, [ids])).rows;
  const eduN = new Map(edu.map((r) => [r.candidate_id, r.n]));
  const expN = new Map(exp.map((r) => [r.candidate_id, r.n]));
  for (const r of rows) {
    const shape = toCandidate(r, { staff: true });
    shape.educationRecords = new Array(eduN.get(r.id) || 0).fill(1);
    shape.experienceRecords = new Array(expN.get(r.id) || 0).fill(1);
    out.set(r.id, profileScore(shape));
  }
  return out;
}
