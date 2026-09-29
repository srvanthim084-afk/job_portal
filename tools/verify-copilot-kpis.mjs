/**
 * The Copilot's KPI row: no number larger than the set it belongs to.
 *
 * WHAT THIS EXISTS FOR. "Needs attention" read 342 while "Active
 * pipeline" read 176 on the same screen. It was the SUM of the action
 * cards, and those cards count two different things - some count
 * candidates, some count applications - so the total was 166 people
 * plus 176 applications, with the same person represented twice and no
 * way for a reader to tell.
 *
 * Every case below is a shape that produced that, or one that must keep
 * working: an application in two cards, an unscored application, an
 * empty system.
 *
 *   node tools/verify-copilot-kpis.mjs
 */
import { readFileSync } from 'node:fs';

/* The selector as it ships, lifted out of the page rather than copied -
   a copy would pass while the page failed. */
const page = readFileSync('web/index.html', 'utf8');
const start = page.indexOf('window.tlCopilotKpis = function');
const end = page.indexOf('\n};', start) + 3;
if (start < 0 || end < 3) {
  console.error('tlCopilotKpis not found in web/index.html');
  process.exit(1);
}
const src = page.slice(start, end);
const window = {};
// eslint-disable-next-line no-new-func
new Function('window', src)(window);
const kpis = window.tlCopilotKpis;

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { pass += 1; console.log(`  ok    ${label}`); }
  else { fail += 1; console.log(`  FAIL  ${label}`); if (detail) console.log(`          ${detail}`); }
}

/* ------------------------------------------------------------------ *
 * an application in two cards is counted once
 * ------------------------------------------------------------------ */
{
  /* a1 is both "applied" and shortlisted in the sense that it appears in
     two card queries - modelled by two cards whose stage sets overlap on
     the same row is impossible here, so the equivalent test is that the
     same id never inflates the total. */
  const apps = [
    { id: 'a1', stage: 'applied', matchScore: 80 },
    { id: 'a1', stage: 'applied', matchScore: 80 },   // the same row twice
    { id: 'a2', stage: 'shortlisted', matchScore: 60 },
  ];
  const k = kpis(apps, []);
  check('an application appearing twice is counted once',
    k.applicationsNeedingAction === 2,
    `got ${k.applicationsNeedingAction}, expected 2`);
}

/* ------------------------------------------------------------------ *
 * the subset rules
 * ------------------------------------------------------------------ */
{
  const apps = [
    { id: 'a1', stage: 'applied', matchScore: 70 },
    { id: 'a2', stage: 'ai_screening', matchScore: 50 },
    { id: 'a3', stage: 'shortlisted', matchScore: 40 },
    { id: 'a4', stage: 'selected', matchScore: 90 },     // not active
    { id: 'a5', stage: 'rejected', matchScore: 10 },     // not active
  ];
  const cands = [
    { id: 'c1', qualified: false }, { id: 'c2', qualified: false },
    { id: 'c3', qualified: true },
  ];
  const k = kpis(apps, cands);

  check('applications needing action never exceeds active pipeline',
    k.applicationsNeedingAction <= k.activePipeline,
    `${k.applicationsNeedingAction} > ${k.activePipeline}`);
  check('candidates to qualify never exceeds total candidates',
    k.candidatesToQualify <= k.totalCandidates,
    `${k.candidatesToQualify} > ${k.totalCandidates}`);
  check('selected and rejected are out of the active pipeline',
    k.activePipeline === 3, `got ${k.activePipeline}, expected 3`);
  check('a finished application is never "needing action"',
    k.applicationsNeedingAction === 3,
    `got ${k.applicationsNeedingAction}, expected 3`);
}

/* ------------------------------------------------------------------ *
 * candidates and applications are never summed
 * ------------------------------------------------------------------ */
{
  const apps = Array.from({ length: 10 }, (_, i) =>
    ({ id: `a${i}`, stage: 'applied', matchScore: 50 }));
  const cands = Array.from({ length: 7 }, (_, i) => ({ id: `c${i}`, qualified: false }));
  const k = kpis(apps, cands);

  check('no KPI equals candidates + applications',
    k.applicationsNeedingAction !== 17 && k.candidatesToQualify !== 17,
    `needing=${k.applicationsNeedingAction} toQualify=${k.candidatesToQualify}`);
  check('the two are reported separately and correctly',
    k.applicationsNeedingAction === 10 && k.candidatesToQualify === 7,
    `needing=${k.applicationsNeedingAction} toQualify=${k.candidatesToQualify}`);
  check('the breakdown keeps its units',
    k.breakdown.some((b) => b.unit === 'candidates')
    && k.breakdown.some((b) => b.unit === 'applications'));
}

/* ------------------------------------------------------------------ *
 * the average
 * ------------------------------------------------------------------ */
{
  const apps = [
    { id: 'a1', stage: 'applied', matchScore: 80 },
    { id: 'a2', stage: 'applied', matchScore: 60 },
    { id: 'a3', stage: 'applied', matchScore: null },     // never scored
    { id: 'a4', stage: 'applied' },                        // no field at all
  ];
  const k = kpis(apps, []);
  check('the average ignores unscored applications',
    k.avgMatch === 70, `got ${k.avgMatch}, expected 70 (not 35)`);
  check('the scored count is reported',
    k.scoredCount === 2, `got ${k.scoredCount}, expected 2`);
  check('an unscored application never produces NaN',
    Number.isFinite(k.avgMatch), `got ${k.avgMatch}`);
}

/* ------------------------------------------------------------------ *
 * nothing at all
 * ------------------------------------------------------------------ */
{
  const k = kpis([], []);
  check('an empty system shows zeros, not blanks or NaN',
    k.applicationsNeedingAction === 0 && k.candidatesToQualify === 0
    && k.activePipeline === 0 && k.avgMatch === 0 && k.totalCandidates === 0,
    JSON.stringify(k));
  const k2 = kpis(undefined, undefined);
  check('undefined inputs do not throw',
    k2.activePipeline === 0 && Number.isFinite(k2.avgMatch));
}

/* ------------------------------------------------------------------ *
 * the reported figures
 * ------------------------------------------------------------------ */
{
  /* The live shape: 176 applications, 172 applied + 1 ai_screening +
     1 shortlisted + 2 ai_interview_done, and 166 unqualified candidates. */
  const apps = [];
  for (let i = 0; i < 172; i += 1) apps.push({ id: `p${i}`, stage: 'applied', matchScore: 30 });
  apps.push({ id: 's1', stage: 'ai_screening', matchScore: 30 });
  apps.push({ id: 'h1', stage: 'shortlisted', matchScore: 30 });
  apps.push({ id: 'd1', stage: 'ai_interview_done', matchScore: 30 });
  apps.push({ id: 'd2', stage: 'ai_interview_done', matchScore: 30 });
  const cands = Array.from({ length: 166 }, (_, i) => ({ id: `c${i}`, qualified: false }));

  const k = kpis(apps, cands);
  check('the live shape no longer produces 342',
    k.applicationsNeedingAction !== 342 && k.candidatesToQualify !== 342);
  check('active pipeline is 176', k.activePipeline === 176, `got ${k.activePipeline}`);
  check('applications needing action is 176 and not more',
    k.applicationsNeedingAction === 176, `got ${k.applicationsNeedingAction}`);
  check('candidates to qualify is 166', k.candidatesToQualify === 166,
    `got ${k.candidatesToQualify}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
