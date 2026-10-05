/**
 * The AI Match score (owner, 2026-10-05): JD-required skills matched /
 * unique JD-required skills x 100, and nothing else.
 *
 * Pure - no database. The owner's three examples exactly, the
 * normalisation (case, abbreviations, equivalent names, duplicates), the
 * non-matches, a JD with no skills, and proof that location, experience,
 * salary and the rest cannot move the number - through aiMatch() itself
 * and through explainMatch(), which is what the card, "Why this match?"
 * and the alerts read.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { aiMatch, canonicalSkill, sameSkill } from '../src/ai/ai-match.js';
import { matchCandidate } from '../src/ai/match.js';
import { explainMatch } from '../src/portal/core.js';

const score = (jd, skills, extra = {}) => aiMatch({ skills: jd }, { skills, ...extra });

test('owner example 1: 3 of 5 JD skills is 60%', () => {
  const m = score(['Java', 'Python', 'SQL', 'Spring Boot', 'AWS'], ['Java', 'Python', 'SQL', 'React', 'HTML', 'CSS']);
  assert.equal(m.score, 60);
  assert.deepEqual(m.matched, ['Java', 'Python', 'SQL']);
  assert.deepEqual(m.missing, ['Spring Boot', 'AWS']);
  assert.equal(m.required, 5);
});

test('owner example 2: 3 of 3 is 100% - extra candidate skills do not count', () => {
  const m = score(['Java', 'Python', 'SQL'], ['Java', 'Python', 'SQL', 'React', 'Angular', 'Node.js', 'MongoDB']);
  assert.equal(m.score, 100);
  assert.deepEqual(m.missing, []);
});

test('owner example 3: 2 of 5 is 40%', () => {
  const m = score(['Java', 'Python', 'SQL', 'AWS', 'Docker'], ['Java', 'Python']);
  assert.equal(m.score, 40);
  assert.deepEqual(m.missing, ['SQL', 'AWS', 'Docker']);
});

test('abbreviations and equivalent names are one skill', () => {
  for (const [a, b] of [
    ['JS', 'JavaScript'], ['ReactJS', 'React'], ['React.js', 'react'], ['Node', 'Node.js'], ['NodeJS', 'node js'],
    ['Postgres', 'PostgreSQL'], ['ML', 'Machine Learning'], ['TS', 'TypeScript'], ['K8s', 'Kubernetes'],
    ['Spring Boot', 'springboot'], ['dotnet', '.NET'], ['C Sharp', 'C#'], ['Golang', 'Go'], ['MS SQL', 'SQL Server'],
  ]) {
    assert.ok(sameSkill(a, b), `${a} = ${b}`);
    assert.equal(score([b], [a]).score, 100, `${a} on the profile matches ${b} in the JD`);
  }
  const m = score(['JavaScript', 'React', 'Node.js', 'PostgreSQL', 'Machine Learning'], ['js', 'ReactJS', 'node', 'Postgres', 'ML']);
  assert.equal(m.score, 100);
  assert.deepEqual(m.matched, ['JavaScript', 'React', 'Node.js', 'PostgreSQL', 'Machine Learning'], 'shown as the JD writes them');
});

test('case and duplicates: the JD counts each skill once', () => {
  const m = score(['Java', 'JAVA', 'java ', 'SQL', 'sql'], ['jAvA']);
  assert.equal(m.required, 2);
  assert.equal(m.score, 50);
  assert.deepEqual(m.matched, ['Java']);
  /* "Java, SQL" typed into one field is two skills */
  assert.equal(score(['Java', 'SQL'], ['Java, SQL']).score, 100);
});

test('unrelated skills never match', () => {
  for (const [jd, have] of [
    ['Java', 'JavaScript'], ['JavaScript', 'Java'], ['Spring Boot', 'Spring'], ['SQL', 'MySQL'],
    ['React Native', 'React'], ['C', 'C++'], ['C++', 'C#'], ['.NET', 'ASP.NET'], ['Go', 'Google Ads'],
  ]) {
    assert.equal(sameSkill(jd, have), false, `${jd} != ${have}`);
    assert.equal(score([jd], [have]).score, 0, `${have} does not satisfy ${jd}`);
  }
});

test('the resume counts as evidence, on word boundaries only', () => {
  const m = score(['Java', 'AWS', 'Docker'], [], { resumeText: 'I write JavaScript daily and hold an Amazon Web Services cert.' });
  assert.deepEqual(m.matched, ['AWS']);
  assert.deepEqual(m.fromResume, ['AWS']);
  assert.deepEqual(m.missing, ['Java', 'Docker'], 'javascript is not java');
  /* everyday words are not skills in prose */
  assert.equal(score(['REST', 'Excel', 'Go'], [], { resumeText: 'The rest of the team - I excel at it, go getter' }).score, 0);
});

test('a JD with no skills has no AI Match: null, not 0', () => {
  for (const jd of [[], null, undefined, ['', '  ']]) {
    const m = aiMatch({ skills: jd }, { skills: ['Java'] });
    assert.equal(m.score, null);
    assert.equal(m.stated, false);
    assert.equal(m.required, 0);
  }
});

test('location, experience, salary, education, mode and the rest do not move the number', () => {
  const job = { id: 'j1', title: 'Java Developer', skills: ['Java', 'Python', 'SQL', 'Spring Boot', 'AWS'],
    location: 'Hyderabad', mode: 'Onsite', exp_label: '2-4 yrs', salary_max: 5, education: 'B.Tech' };
  const base = { id: 'c1', skills: ['Java', 'Python', 'SQL'], location: 'Hyderabad', preferred_location: 'Hyderabad',
    exp: '3 yrs', exp_years: 3, expected_ctc: 4, education: 'B.Tech', preferred_work_modes: ['Onsite'], notice_period: 'Immediate' };
  const variants = [
    {}, { location: 'Chennai', preferred_location: 'Chennai' }, { exp: '15 yrs', exp_years: 15 }, { exp: null, exp_years: null },
    { expected_ctc: 60 }, { education: 'Diploma' }, { preferred_work_modes: ['Remote'] }, { notice_period: '90 days' },
    { title: 'Nurse', preferred_role: 'Nurse' }, { resume_file: null, summary: null },
  ];
  for (const v of variants) {
    const e = explainMatch(job, { ...base, ...v });
    assert.equal(e.score, 60, `changed ${JSON.stringify(v)}`);
  }
  /* the job's own non-skill fields either */
  for (const v of [{ location: 'Delhi' }, { exp_label: '10-15 yrs' }, { salary_max: 1 }, { mode: 'Remote' }, { education: 'PhD' }]) {
    assert.equal(explainMatch({ ...job, ...v }, base).score, 60, `job changed ${JSON.stringify(v)}`);
  }
});

test('the recruiter screening matcher shares the normaliser and carries the AI Match', () => {
  assert.equal(canonicalSkill('Node.js'), canonicalSkill('nodejs'));
  const m = matchCandidate({ title: 'JS Dev', skills: ['JavaScript', 'React'] }, { skills: ['JS', 'ReactJS'], title: 'JS Dev' });
  assert.equal(m.aiMatch.score, 100);
  assert.deepEqual(m.breakdown.skills.missing, [], 'screening reads JS as JavaScript too');
});

test('explain: the same lists as the score, reasons with no second number', () => {
  const e = explainMatch({ id: 'j', skills: ['Java', 'AWS'], location: 'Pune', exp_label: '1-3 yrs' },
    { id: 'c', skills: ['java'], exp: '2 yrs', exp_years: 2, preferred_location: 'Pune', location: 'Pune' });
  assert.equal(e.score, 50);
  assert.deepEqual(e.matchedSkills, ['Java']);
  assert.deepEqual(e.missingSkills, ['AWS']);
  assert.ok(e.reasons.length >= 2);
  for (const r of e.reasons) assert.equal(/\d+%/.test(r.text), false, r.text);
  assert.equal(/\d+%/.test(e.recommendation), false);
});
