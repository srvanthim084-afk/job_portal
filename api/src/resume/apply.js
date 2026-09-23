/**
 * Writing what a parser found onto a candidate, from wherever it came.
 *
 * This lived inside the upload route, which was fine while a resume only
 * ever arrived through the upload button. A resume attached to a Naukri
 * email has to land on the candidate the same way - same columns, same
 * rule about what may be overwritten - and two copies of a rule this
 * particular would have drifted within a month.
 */
import { toRupees } from '../money.js';

/**
 * Writes what the parser found onto the candidate - into EMPTY columns only.
 *
 * "Do not make the candidate type in what the resume already says" and
 * "do not overwrite what the candidate told us" are both true, and the
 * only rule that satisfies both is: fill the blanks, never clobber. A
 * candidate who corrected their notice period keeps that correction when
 * they upload a new CV; a candidate who has told us nothing gets the
 * resume's version.
 *
 * Arrays count as empty when they have no entries, which is why a fresh
 * account ends up with its skills rather than "0 skills detected" beside a
 * resume that plainly lists them.
 */
export async function applyExtractedFields(c, candidateId, fields) {
  if (!fields || !Object.keys(fields).length) return 0;

  // extracted key -> column, and how to coerce it
  const MAP = [
    ['title', 'title', 'text'],
    ['currentCompany', 'current_company', 'text'],
    ['previousCompanies', 'previous_companies', 'array'],
    ['location', 'location', 'text'],
    ['preferredLocation', 'preferred_location', 'text'],
    ['noticePeriod', 'notice_period', 'text'],
    ['education', 'education', 'text'],
    ['summary', 'summary', 'text'],
    ['skills', 'skills', 'array'],
    ['certifications', 'certifications', 'array'],
    ['languages', 'languages', 'array'],
    ['linkedin', 'linkedin', 'text'],
    ['github', 'github', 'text'],
    ['expYears', 'exp_years', 'number'],
    ['phone', 'phone', 'text'],
    // Resumes write salary as "28 LPA" or "12,00,000"; the columns are
    // numeric, so the words have to become rupees or nothing is stored.
    ['expectedSalary', 'expected_ctc', 'money'],
    ['currentSalary', 'ctc', 'money'],
  ];

  const current = (await c.query(
    `select ${MAP.map(([, col]) => col).join(', ')}, exp from candidates where id=$1`,
    [candidateId])).rows[0];
  if (!current) return 0;

  const sets = [];
  const vals = [];
  const isEmpty = (v) => v === null || v === undefined ||
    (Array.isArray(v) ? v.length === 0 : String(v).trim() === '');

  for (const [key, col, kind] of MAP) {
    if (fields[key] === undefined) continue;
    if (!isEmpty(current[col])) continue;              // the candidate's own value wins

    let v = fields[key];
    if (kind === 'array') { v = Array.isArray(v) ? v : [v]; if (!v.length) continue; }
    else if (kind === 'number') { v = Number(v); if (!Number.isFinite(v)) continue; }
    else if (kind === 'money') { v = toRupees(v); if (v === null) continue; }
    else { v = String(v).trim(); if (!v) continue; }

    vals.push(v);
    sets.push(`${col}=$${vals.length}`);
  }

  // The display string the prototype reads in a hundred places.
  if (isEmpty(current.exp) && Number.isFinite(Number(fields.expYears))) {
    vals.push(`${Number(fields.expYears)} yrs`);
    sets.push(`exp=$${vals.length}`);
  }

  if (!sets.length) return 0;
  vals.push(candidateId);
  await c.query(`update candidates set ${sets.join(', ')} where id=$${vals.length}`, vals);
  return sets.length;
}
