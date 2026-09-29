/**
 * The interview score reflects what the candidate said, in their words.
 *
 *     node tools/verify-interview-scoring-is-real.mjs
 *
 * Runs against the scorer directly - no server, no browser - because the
 * question here is not whether the number travels but whether it MEANS
 * anything. verify-interview-score.mjs proves the plumbing end to end;
 * this proves the marking.
 *
 * WHAT WENT WRONG, AND WHY IT NEEDS A TEST OF ITS OWN. A tester reported
 * "giving fake score": 10% overall, 7% technical, 0% behavioural, on an
 * interview they had answered properly. Three separate faults stacked up:
 *
 *   EVERY REQUIREMENT'S DESCRIPTION WAS A PROVENANCE NOTE - "Imported
 *   requirement for the Naukri response sync." - and the question
 *   generator mined the description before the skills list. So a
 *   cardiologist was asked about "imported requirement for the Naukri
 *   response sync" and marked against the words "imported", "naukri" and
 *   "sync".
 *
 *   AN EXPECTATION WAS CHECKED AS A LITERAL SUBSTRING. "ECG
 *   Interpretation" was only ever satisfied by a candidate who said those
 *   two words in that order. "I interpreted ECGs every morning" matched
 *   nothing.
 *
 *   NOT MATCHING MEANT OFF TOPIC, AND OFF TOPIC IS ZERO. Correctly, for a
 *   genuine digression - but every real answer was landing there, so
 *   almost every question scored zero and the mean was near zero
 *   regardless of the interview.
 *
 * So the assertions below are all of the form "an answer a competent
 * person would actually give scores like a competent answer", using
 * synonyms and word forms rather than the exact expected terms, next to
 * an off-topic answer that must still score zero. A scorer that returns a
 * constant fails; one that only rewards parroting fails; one that gives
 * partial credit for length fails.
 */
import { evaluate, jobTopics, planFromJob } from '../api/src/ai/interview.js';

const fail = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`); if (!ok) fail.push(what); };

const CARDIO = {
  title: 'Cardiologist',
  desc: 'Imported requirement for the Naukri response sync.',
  skills: ['Cardiology', 'ECG Interpretation', 'Echocardiography', 'Stress Testing',
    'Holter Monitoring', 'Cardiac Catheterization'],
};
const NURSE = {
  title: 'Staff Nurse',
  desc: 'Created automatically because a candidate applied for this role and no '
      + 'requirement existed for it. Add the details and publish it when you are ready.',
  skills: ['Patient Care', 'Clinical Documentation', 'Medication Administration',
    'IV Therapy', 'Vital Signs Monitoring'],
};

/** Score one answer to one question. */
async function mark(job, question, transcript) {
  const r = await evaluate({
    job,
    answers: [{ ...question, seq: 1, answered: true, transcript }],
  });
  return r.perQuestion[0];
}

/* ------------------------------------------------------------------ *
 * 1 · a note about the record is not a topic
 * ------------------------------------------------------------------ */

console.log('\nthe description is read for the job, not for the paperwork\n');

for (const job of [CARDIO, NURSE]) {
  const topics = jobTopics(job);
  check(topics.length === 0,
    `  ${job.title}: the provenance note produced no topics (${JSON.stringify(topics.map((t) => t.text.slice(0, 40)))})`);

  const plan = planFromJob({ job, candidate: {}, count: 15 });
  const junk = plan.filter((q) => /naukri|imported requirement|created automatically|publish it when/i.test(q.question));
  check(junk.length === 0,
    `  ${job.title}: no question asks about the paperwork (${junk.length} did)`);

  const jd = plan.filter((q) => q.section === 'jd');
  const onSkill = jd.filter((q) => (job.skills || [])
    .some((sk) => q.question.toLowerCase().includes(String(sk).toLowerCase())));
  check(jd.length > 0 && onSkill.length === jd.length,
    `  ${job.title}: all ${jd.length} role questions name a skill the role lists (${onSkill.length})`);
}

/* ------------------------------------------------------------------ *
 * 2 · a real answer scores like a real answer
 * ------------------------------------------------------------------ */

console.log('\nan answer in the candidate\'s own words is marked as an answer\n');

const cardioPlan = planFromJob({ job: CARDIO, candidate: {}, count: 15 });
const nursePlan = planFromJob({ job: NURSE, candidate: {}, count: 15 });

/*
 * Every answer below deliberately AVOIDS the expected phrasing. Not one
 * says "ECG interpretation", "medication administration" or "I have
 * experience". They are written the way a person speaks, which is exactly
 * what the old substring test could not see.
 */
const REAL = [
  [CARDIO, cardioPlan, /ecg/i,
    'I read ECGs every morning on the ward round, forty or so a day, and I '
    + 'pick out the arrhythmias and the ST changes myself before the consultant '
    + 'sees them. I have done that daily for six years, since my residency, and '
    + 'last month I caught a silent infarct in a diabetic patient that way.'],
  [CARDIO, cardioPlan, /echocardiograph/i,
    'I scan the heart myself rather than sending it out. Transthoracic mostly, '
    + 'measuring ejection fraction and valve gradients, around fifteen a week in '
    + 'my clinic. I was trained on it during my fellowship and I have been doing '
    + 'it routinely ever since.'],
  [NURSE, nursePlan, /medication/i,
    'I give out the drugs on the chart twice a shift, checking the wristband and '
    + 'the dose against the prescription with a second nurse for anything '
    + 'controlled. That has been my daily routine on a twenty bed ward for four '
    + 'years and I was signed off on it in my first year.'],
  [NURSE, nursePlan, /documentation/i,
    'I write up every patient at the end of the shift, the notes and the '
    + 'observation chart, and I record anything I escalated so the next nurse '
    + 'picks it up. I do it as I go rather than at the end, which I was taught '
    + 'on my ward induction.'],
];

const scores = [];
for (const [job, plan, wanted, transcript] of REAL) {
  const q = plan.find((x) => wanted.test(x.question));
  if (!q) { check(false, `  no question matching ${wanted} was generated`); continue; }
  const p = await mark(job, q, transcript);
  scores.push(p.score);
  console.log(`  Q: ${q.question.slice(0, 82)}`);
  console.log(`     scored ${p.score}%  -  ${String(p.justification || '').slice(0, 88)}`);
  check(Number(p.score) >= 45,
    `     a competent answer in its own words scores like one (${p.score}%, needs 45+)`);
  check(!p.offTopic, '     and is not ruled off topic');
  check(!/\|/.test(String(p.justification || '')),
    '     the justification reads as English, not as a match pattern');
}

/* The behavioural section was the worst of it: 0% on every interview,
   because its three questions were marked against four literal words each
   - "problem", "approach", "solved", "result" and so on. Nobody answering
   a question about a difficult shift says the word "result". */
const BEHAVIOURAL = [
  [/difficult problem/i,
    'We had a patient come in at three in the morning with chest pain and the '
    + 'old notes were not on the system, so I could not see what had been done '
    + 'before. I went about it by ringing the referring hospital myself rather '
    + 'than waiting for the paperwork, got the previous angiogram read over the '
    + 'phone, and we took him straight to the cath lab. He was stented by six '
    + 'and walked out four days later.'],
  [/approach was different from yours/i,
    'A registrar wanted to discharge a patient I was not happy about. I asked '
    + 'him to talk me through his reasoning rather than overruling him, and he '
    + 'had spotted something in the bloods I had not. We settled on keeping her '
    + 'in overnight with a repeat troponin, which was the middle ground, and it '
    + 'came back raised. Since then we run borderline cases past each other.'],
  [/learn something new quickly/i,
    'When we brought in a new echo machine I had three days before my clinic '
    + 'list. I read the manual through, sat with the applications engineer for a '
    + 'morning and practised on volunteers after hours. By the Monday I was '
    + 'scanning on it unsupervised and I have been confident with it since.'],
];

for (const [wanted, transcript] of BEHAVIOURAL) {
  const q = cardioPlan.find((x) => wanted.test(x.question));
  if (!q) { check(false, `  no behavioural question matching ${wanted}`); continue; }
  const p = await mark(CARDIO, q, transcript);
  console.log(`\n  Q: ${q.question.slice(0, 82)}`);
  console.log(`     scored ${p.score}%  -  ${String(p.justification || '').slice(0, 88)}`);
  check(Number(p.score) >= 55,
    `     a proper behavioural answer scores well (${p.score}%, needs 55+)`);
  scores.push(p.score);
}

/* ------------------------------------------------------------------ *
 * 3 · and a non-answer still scores nothing
 * ------------------------------------------------------------------ */

console.log('\na non-answer is still worth nothing\n');

const OFF_TOPIC = 'I enjoy gardening at the weekend and I recently repainted my '
  + 'kitchen. The weather has been changeable and I have been reading a novel '
  + 'about sailing. My neighbour has a dog that barks at the postman every '
  + 'single morning without fail, and the council will not do anything about it.';

const q0 = cardioPlan.find((x) => /ecg/i.test(x.question));
for (const [label, transcript, ceiling] of [
  ['a long answer about something else', OFF_TOPIC, 0],
  ['one word', 'Yes.', 0],
  ['a padded non-answer', 'Yeah, so, I mean, it depends really, you know how it '
    + 'is, various things, that sort of thing, it varies quite a lot day to day '
    + 'honestly, hard to say, all sorts.', 20],
]) {
  const p = await mark(CARDIO, q0, transcript);
  console.log(`  ${label}: ${p.score}%`);
  check(Number(p.score) <= ceiling,
    `  ${label} scores no more than ${ceiling}% (${p.score}%)`);
}

const silent = await evaluate({
  job: CARDIO,
  answers: cardioPlan.map((q) => ({ ...q, answered: false, transcript: '' })),
});
check(silent.overall === 0 && silent.contentScored === false,
  `  an interview with nothing said scores 0 and is marked unscored (${silent.overall}%, contentScored=${silent.contentScored})`);

/* ------------------------------------------------------------------ *
 * 4 · the whole interview, not one question at a time
 * ------------------------------------------------------------------ */

console.log('\nend to end, across a whole interview\n');

/** Answer every question the way a good candidate would, without parroting. */
const competent = (q) => {
  const subject = (String(q.question).match(/asks for ([^,]+?),|use ([A-Za-z ]+?) in this role/) || [])
    .slice(1).find(Boolean) || 'this';
  return `On the ward I do ${subject} myself every day rather than referring it on. `
    + 'I was taught it during my residency and it has been part of my daily work '
    + 'for six years since, so I am confident with it unsupervised. '
    + 'The hardest case I can think of was a patient whose old notes were '
    + 'missing, which was a real difficulty: I went about it by ringing the '
    + 'referring hospital myself, I sorted it within the hour and the outcome '
    + 'was that he was treated the same morning. '
    + 'When a colleague reads something differently I ask them to talk me '
    + 'through their reasoning rather than overruling them, we usually settle on '
    + 'a middle course, and that has worked well for the team. '
    + 'When I have had to pick something up quickly I read up on it, practised '
    + 'after hours and applied it the following week.';
};

const wholeGood = await evaluate({
  job: CARDIO,
  answers: cardioPlan.map((q) => ({ ...q, answered: true, transcript: competent(q) })),
});
const wholePoor = await evaluate({
  job: CARDIO,
  answers: cardioPlan.map((q) => ({ ...q, answered: true, transcript: OFF_TOPIC })),
});

console.log(`  answering properly    overall ${wholeGood.overall}%  `
  + `technical ${wholeGood.technical}%  behavioural ${wholeGood.behavioral}%  `
  + `communication ${wholeGood.communication}%`);
console.log(`  answering elsewhere   overall ${wholePoor.overall}%  `
  + `technical ${wholePoor.technical}%  behavioural ${wholePoor.behavioral}%`);

check(wholeGood.overall >= 55,
  `  a good interview scores like a good interview (${wholeGood.overall}%, needs 55+)`);
check(wholeGood.technical >= 50,
  `  including the technical mark (${wholeGood.technical}%, needs 50+)`);
check(wholeGood.behavioral >= 50,
  `  and the behavioural mark, which used to be 0 every time (${wholeGood.behavioral}%, needs 50+)`);
check(wholePoor.overall === 0,
  `  an interview spent off topic scores 0 (${wholePoor.overall}%)`);
check(wholeGood.overall - wholePoor.overall >= 40,
  `  the gap between them is decisive (${wholeGood.overall - wholePoor.overall} points, needs 40+)`);
check(wholeGood.scoredQuestions === wholeGood.askedQuestions,
  `  every question asked could be marked (${wholeGood.scoredQuestions}/${wholeGood.askedQuestions})`);

/* The one thing a keyword scorer must never do: reward volume. */
const padded = await evaluate({
  job: CARDIO,
  answers: cardioPlan.map((q) => ({ ...q, answered: true, transcript: OFF_TOPIC.repeat(4) })),
});
check(padded.overall === 0,
  `  and saying four times as much of it changes nothing (${padded.overall}%)`);

console.log(fail.length ? `\n${fail.length} failed` : '\nall good');
process.exit(fail.length ? 1 : 0);
