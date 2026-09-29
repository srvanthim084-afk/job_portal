/**
 * Remove what the old resume parser wrote into the wrong column.
 *
 *     node tools/clean-parser-garbage.mjs            # report only
 *     node tools/clean-parser-garbage.mjs --confirm  # clear it
 *
 * WHY. Two bugs in api/src/resume/fields.js put text into columns it did
 * not belong in, for every resume parsed before they were fixed:
 *
 *   1. A line like "Languages: Python, SQL, HTML5" inside a TECHNICAL
 *      SKILLS block was read as the LANGUAGES heading, so the candidate's
 *      skills were filed as languages they speak - and their skills came
 *      back empty.
 *   2. A heading this file did not recognise ("INTERNSHIPS & TRAINING",
 *      "Declaration") did not close the section before it, so internship
 *      sentences and the closing declaration block were appended to
 *      whichever section was open - usually certifications or languages.
 *
 * Both are fixed, but `applyExtractedFields` only ever fills EMPTY
 * columns - deliberately, so a correction the candidate made is never
 * clobbered. That rule means the wrong values already stored stay
 * exactly where they are and the corrected parse has nowhere to go.
 *
 * So the demonstrably-wrong entries are cleared, and nothing else is
 * touched. A re-parse afterwards fills the now-empty columns properly.
 *
 * WHAT COUNTS AS WRONG, and nothing looser:
 *   languages      an entry containing ":" (e.g. "Backend: Flask",
 *                  "Place: Hyderabad") or the declaration block
 *   certifications an entry of five or more words, or one starting with a
 *                  lowercase letter - a sentence fragment, not a
 *                  certificate name
 *
 * A real language is one word. A real certificate name is short and
 * capitalised. Anything that survives those tests is left alone.
 */
import { PGlite } from '@electric-sql/pglite';

const CONFIRM = process.argv.includes('--confirm');
const db = new PGlite('var/dev-db');

/*
 * THE SHARPEST TEST THERE IS: it is already in their SKILLS.
 *
 * "REST APIs", "Node.js", "MongoDB" and "Scikit-learn" carry no colon and
 * are one or two words, so the shape tests above let them through - and
 * they were sitting in `languages` on a profile whose skills list
 * contains every one of them. A thing cannot be both a language the
 * candidate speaks and a skill they listed; the skills column is the one
 * the current parser filled correctly, so it is the one believed.
 */
const inSkills = (skills) => {
  const set = new Set((skills || []).map((x) => String(x).trim().toLowerCase()));
  return (v) => set.has(String(v).trim().toLowerCase());
};
const REAL_LANGUAGE = /^(english|hindi|telugu|tamil|kannada|malayalam|marathi|gujarati|bengali|punjabi|urdu|odia|assamese|konkani|sanskrit|french|german|spanish|arabic|japanese|chinese|mandarin|russian)/i;

const badLanguage = (s, isSkill) => /:/.test(String(s))
  || /^(declaration|place|date|signature|\(.*\))$/i.test(String(s).trim())
  || isSkill(s)
  /* Anything that is not a language anybody speaks. Kept deliberately
     narrow: a name not on this list is left alone rather than guessed at. */
  || (!REAL_LANGUAGE.test(String(s).trim()) && /[.#+]|\d/.test(String(s)));
const badCertificate = (s, isSkill) => String(s).trim().split(/\s+/).length >= 5
  || /^[a-z]/.test(String(s).trim())
  || isSkill(s)
  /* A shouted section name that was swallowed, and one-word verbs out of
     a bullet list ("Collected", "Organised"). A certificate is a NAME. */
  || /^[A-Z][A-Z &]{4,}$/.test(String(s).trim())
  || /^(collected|organised|organized|cleaned|applied|strengthened|collaborated|assisted|developed|built|worked|handled)$/i.test(String(s).trim());

const rows = (await db.query(
  `select id, name, languages, certifications, skills from candidates
    where cardinality(languages) > 0 or cardinality(certifications) > 0`)).rows;

let langHits = 0;
let certHits = 0;
const fixes = [];

for (const r of rows) {
  const langs = r.languages || [];
  const certs = r.certifications || [];
  const isSkill = inSkills(r.skills);
  const keptLangs = langs.filter((x) => !badLanguage(x, isSkill));
  const keptCerts = certs.filter((x) => !badCertificate(x, isSkill));
  if (keptLangs.length === langs.length && keptCerts.length === certs.length) continue;

  if (keptLangs.length !== langs.length) langHits += 1;
  if (keptCerts.length !== certs.length) certHits += 1;
  fixes.push({ id: r.id, name: r.name, keptLangs, keptCerts,
    droppedL: langs.length - keptLangs.length,
    droppedC: certs.length - keptCerts.length });
}

console.log(`${rows.length} candidate(s) carry a language or certificate list`);
console.log(`   ${langHits} with skills or a declaration block filed as languages`);
console.log(`   ${certHits} with sentences filed as certificates`);
fixes.slice(0, 6).forEach((f) => {
  console.log(`   ${String(f.name).slice(0, 26).padEnd(28)}`
    + `-${f.droppedL} language(s), -${f.droppedC} certificate(s)`);
});

if (!fixes.length) { console.log('\nNothing to clear.'); await db.close(); process.exit(0); }
if (!CONFIRM) {
  console.log('\nNothing was changed. Run again with --confirm to clear it,');
  console.log('then re-parse so the corrected values are written back:');
  console.log('   node tools/reparse-resumes.mjs --confirm');
  await db.close();
  process.exit(0);
}

for (const f of fixes) {
  await db.query(`update candidates set languages = $1, certifications = $2 where id = $3`,
    [f.keptLangs, f.keptCerts, f.id]);
}
console.log(`\n${fixes.length} candidate(s) cleaned.`);
console.log('Now re-parse so the corrected parse fills them: '
  + 'node tools/reparse-resumes.mjs --confirm');
await db.close();
