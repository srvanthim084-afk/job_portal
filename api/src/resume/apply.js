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
    ['portfolio', 'portfolio', 'text'],
    /* The profile sections (0087 and projects). The parser finds lines;
       the profile keeps small objects, so each line becomes one. */
    ['projects', 'projects', 'jsonb', (line) => {
      const m = /^(.{2,120}?)\s+[-–—:|]\s+(.+)$/.exec(line);
      return m ? { name: m[1].trim(), desc: m[2].trim() } : { name: line, desc: '' };
    }],
    ['internships', 'internships', 'jsonb', (line) => ({ role: line })],
    ['achievements', 'achievements', 'jsonb', (line) => ({ title: line })],
    ['expYears', 'exp_years', 'number'],
    /* 0117: what the reading already had and nothing kept. */
    ['relevantExpYears', 'relevant_exp_years', 'number'],
    ['altPhone', 'alt_phone', 'text'],
    ['phone', 'phone', 'text'],
    // Resumes write salary as "28 LPA" or "12,00,000"; the columns are
    // numeric, so the words have to become rupees or nothing is stored.
    ['expectedSalary', 'expected_ctc', 'money'],
    ['currentSalary', 'ctc', 'money'],
  ];

  const current = (await c.query(
    `select ${MAP.map(([, col]) => col).join(', ')}, exp from candidates where id=$1`,
    [candidateId])).rows[0];
  if (!current) return { count: 0, filled: [], suggestions: {} };

  const sets = [];
  const vals = [];
  const isEmpty = (v) => v === null || v === undefined ||
    (Array.isArray(v) ? v.length === 0 : String(v).trim() === '');

  const filled = [];
  const suggestions = {};
  const same = (a, b) => JSON.stringify(a).toLowerCase() === JSON.stringify(b).toLowerCase();

  for (const [key, col, kind, toItem] of MAP) {
    if (fields[key] === undefined) continue;
    if (!isEmpty(current[col])) {
      /* The candidate's own value wins - but when the resume says
         something different, the page offers it for review instead of
         either overwriting or saying nothing. Text and lists only. */
      if (kind === 'text' || kind === 'array') {
        const mine = kind === 'array' ? [].concat(current[col] || []) : String(current[col]).trim();
        const theirs = kind === 'array' ? [].concat(fields[key]) : String(fields[key]).trim();
        if (theirs && (kind !== 'array' || theirs.length) && !same(mine, theirs)) suggestions[key] = theirs;
      }
      continue;
    }

    let v = fields[key];
    if (kind === 'jsonb') {
      const items = [].concat(v).filter(Boolean).map((x) => (typeof x === 'string' ? toItem(x) : x));
      if (!items.length) continue;
      vals.push(JSON.stringify(items));
      sets.push(`${col}=$${vals.length}::jsonb`);
      filled.push(key);
      continue;
    }
    if (kind === 'array') { v = Array.isArray(v) ? v : [v]; if (!v.length) continue; }
    else if (kind === 'number') { v = Number(v); if (!Number.isFinite(v)) continue; }
    else if (kind === 'money') { v = toRupees(v); if (v === null) continue; }
    else { v = String(v).trim(); if (!v) continue; }

    vals.push(v);
    sets.push(`${col}=$${vals.length}`);
    filled.push(key);
  }

  // The display string the prototype reads in a hundred places.
  if (isEmpty(current.exp) && Number.isFinite(Number(fields.expYears))) {
    vals.push(`${Number(fields.expYears)} yrs`);
    sets.push(`exp=$${vals.length}`);
  }

  /*
   * EMPLOYMENT, as rows, when the profile has none. The page's Employment
   * card reads candidate_experience; a resume that lists three jobs left
   * it empty. Only when there are no rows at all - the candidate's own
   * list is never replaced by the parser's reading of a PDF.
   */
  const history = Array.isArray(fields.employmentHistory) ? fields.employmentHistory : [];
  if (history.length) {
    const has = (await c.query(
      `select 1 from candidate_experience where candidate_id=$1 limit 1`, [candidateId])).rowCount;
    if (!has) {
      const rows = history.slice(0, 15)
        .filter((e) => e && (e.company || e.title))
        .map((e) => ({ company: e.company || '', jobTitle: e.title || '', responsibilities: e.period || '' }));
      if (rows.length) {
        await c.query(`select candidate_records_replace($1, null, $2::jsonb)`,
          [candidateId, JSON.stringify(rows)]);
        filled.push('employment');
      }
    }
  }

  if (!sets.length) return { count: filled.length, filled, suggestions };
  vals.push(candidateId);
  await c.query(`update candidates set ${sets.join(', ')} where id=$${vals.length}`, vals);
  return { count: filled.length, filled, suggestions };
}
