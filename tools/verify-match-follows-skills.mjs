/**
 * The AI match score follows the skills, not the postcode.
 *
 *     node tools/verify-match-follows-skills.mjs
 *
 * WHAT WAS REPORTED. "ai match loo nakuu resume loo unna skills mana jd
 * kii match avuthey score evaliii" - the match score should come from how
 * much of the requirement's skills the resume actually has, and go up as
 * more of them match.
 *
 * WHAT IT WAS DOING INSTEAD. Skills were 40 of 100 and the other 60 -
 * experience, role, location, education, preferences - were dimensions
 * almost every applicant scores something on. So the floor was high and
 * the skills barely moved it:
 *
 *   a microbiologist against Human Resource Recruiter    58%
 *   a Java intern against Human Resource Recruiter       58%
 *   a radiologist against Radiologist                    43%
 *
 * Every one of those matched zero to two of the ten skills its
 * requirement named. Sorted by match score, the people who could not do
 * the job came out above the people who could.
 *
 * WHAT HOLDS NOW, and what this file checks:
 *
 *   more of the required skills always scores higher than fewer
 *   none of them caps the score low, whatever else lines up
 *   all of them scores high
 *   the screening score and the match score agree, because a recruiter
 *     sees both and they used to disagree by forty points
 *
 * Pure functions, no server: this is about the arithmetic. The end-to-end
 * behaviour is covered by tools/verify-screening.mjs.
 */
import { matchCandidate, WEIGHTS } from '../api/src/ai/match.js';
import { scoreApplication } from '../api/src/ai/screening.js';

const fail = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`); if (!ok) fail.push(what); };

const ROLE = {
  title: 'Radiologist',
  location: 'Hyderabad',
  exp: '3-8 years',
  skills: ['Radiology', 'CT', 'MRI', 'USG', 'X-Ray', 'Diagnostic Ultrasound',
    'Radiation Safety', 'Image Interpretation', 'MBBS', 'Patient Care'],
};

/** Everything except the skills held constant, so only skills can move. */
const person = (name, skills) => ({
  name,
  location: 'Hyderabad',        // same city as the role
  expYears: 5,                  // inside the band
  title: 'Doctor',
  education: 'MBBS',
  noticePeriod: 'Immediate',
  technicalSkills: skills,
  skills,
});

const of = (n) => ROLE.skills.slice(0, n);

/* ------------------------------------------------------------------ *
 * 1 · more skills, more score
 * ------------------------------------------------------------------ */

console.log('\nthe score rises with how much of the requirement is met\n');

const steps = [0, 1, 2, 3, 5, 7, 10].map((n) => {
  const m = matchCandidate(ROLE, person(`has ${n}`, of(n)));
  return { n, score: m.score, basis: m.basis };
});

for (const s of steps) {
  const b = s.basis;
  console.log(`  ${String(s.n).padStart(2)} of 10 skills -> ${String(s.score).padStart(3)}%   `
    + `(coverage ${Math.round((b.skillCoverage || 0) * 100)}%, `
    + `weighted ${b.weighted}, ceiling ${b.ceiling}${b.cappedBySkills ? ', capped' : ''})`);
}

for (let i = 1; i < steps.length; i++) {
  check(steps[i].score > steps[i - 1].score,
    `  ${steps[i].n} skills scores higher than ${steps[i - 1].n} `
    + `(${steps[i].score}% vs ${steps[i - 1].score}%)`);
}

/* ------------------------------------------------------------------ *
 * 2 · everything else right, none of the skills
 * ------------------------------------------------------------------ */

console.log('\nbeing a good fit on everything else is not a match\n');

/* These are the two real profiles from the reported case: people the
   job boards sent against a requirement they have nothing to do with. */
const WRONG = [
  ['a microbiologist', ['Culturing', 'Media Preparation', 'Industrial Microbiology',
    'Molecular Biology', 'Microbiology', 'Immunology', 'Cell Biology', 'Cell Culture']],
  ['a Java intern', ['Python', 'Java', 'SQL', 'GitHub', 'Power BI', 'Firebase',
    'Full Stack Web Development', 'Artificial Intelligence']],
];

for (const [who, skills] of WRONG) {
  const m = matchCandidate(ROLE, person(who, skills));
  console.log(`  ${who.padEnd(18)} -> ${m.score}%  (was 58% before the ceiling)`);
  check(m.score <= 25,
    `  ${who}, right city and right years, scores at most 25% (${m.score}%)`);
  check(m.basis.cappedBySkills === true,
    `  and the record says the skills capped it, not that they scored badly`);
}

/* A candidate who has everything the role asks for must NOT be capped -
   the ceiling is there to stop other dimensions standing in for skills,
   not to hold down somebody who has them. */
const ideal = matchCandidate(ROLE, person('a radiologist', ROLE.skills));
console.log(`\n  a radiologist      -> ${ideal.score}%`);
check(ideal.score >= 85, `  a full match scores high (${ideal.score}%)`);
check(ideal.basis.cappedBySkills === false, '  and is not capped');
check(ideal.score > matchCandidate(ROLE, person('m', WRONG[0][1])).score + 50,
  '  and is far above a profile with none of the skills');

/* ------------------------------------------------------------------ *
 * 3 · skills are the largest single thing
 * ------------------------------------------------------------------ */

console.log('\nskills outweigh any other single dimension\n');

check(WEIGHTS.skills >= 50,
  `  skills carry ${WEIGHTS.skills} of 100`);
const others = Object.entries(WEIGHTS).filter(([k]) => k !== 'skills');
for (const [k, w] of others) {
  check(WEIGHTS.skills > w, `  more than ${k} (${WEIGHTS.skills} vs ${w})`);
}

/* ------------------------------------------------------------------ *
 * 4 · a requirement with no skills is not scored as though it had them
 * ------------------------------------------------------------------ */

console.log('\na requirement that names no skills is a different question\n');

const vague = { title: 'Radiologist', location: 'Hyderabad', exp: '3-8 years', skills: [] };
const onVague = matchCandidate(vague, person('anyone', ['Radiology', 'CT']));
console.log(`  against a requirement with no skills -> ${onVague.score}%`);
check(onVague.basis.ceiling == null,
  '  no ceiling is applied, because there is nothing to measure coverage against');
check(onVague.basis.skipped.includes('skills'),
  '  and skills are left out of the average rather than scored as zero');
check(onVague.score > 25,
  `  so the candidate is not punished for how the requirement was written (${onVague.score}%)`);

/* ------------------------------------------------------------------ *
 * 5 · the two numbers a recruiter sees agree
 * ------------------------------------------------------------------ */

console.log('\nthe screening score and the match score tell the same story\n');

for (const [label, skills] of [
  ['none of them', []],
  ['half of them', of(5)],
  ['all of them', ROLE.skills],
]) {
  const who = person(label, skills);
  const m = matchCandidate(ROLE, who);
  const s = scoreApplication({ job: ROLE, candidate: who });
  console.log(`  ${label.padEnd(14)} match ${String(m.score).padStart(3)}%   screening ${String(s.score).padStart(3)}%`);
  /* They are computed with different weights on purpose - the admin sets
     the screening weights in AI Settings - so they are not required to be
     equal. They ARE required not to contradict each other in front of a
     recruiter, which forty points apart did. */
  check(Math.abs(m.score - s.score) <= 25,
    `  ${label}: the two scores are within 25 points (${m.score} vs ${s.score})`);
}

const noneScreen = scoreApplication({ job: ROLE, candidate: person('none', []) });
check(noneScreen.score <= 25,
  `  and a screening score is capped by the skills too (${noneScreen.score}%)`);
check(noneScreen.verdict !== 'shortlist',
  `  so nothing auto-shortlists on a zero-skill match (verdict: ${noneScreen.verdict})`);

console.log(fail.length ? `\n${fail.length} failed` : '\nall good');
process.exit(fail.length ? 1 : 0);
