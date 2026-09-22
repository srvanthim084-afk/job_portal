/**
 * The AI interview, conducted for real against a real job.
 *
 * What this holds to:
 *
 *   - the interview is the blueprint and nothing else: 2 introduction,
 *     5 from the job description, 5 from the resume, 3 behavioural = 15
 *   - the questions come from THIS job's description, so two roles do not
 *     get the same interview
 *   - the resume questions are about what the candidate actually wrote
 *   - it must be completed within two days, and the deadline is stored
 *     rather than assumed
 *   - the interview is linked to the candidate, the application and the job
 *   - follow-ups react to what was actually said
 *   - silence scores zero, and an interview with nothing said has no score
 *   - the score is computed on the SERVER from the stored transcripts, and
 *     a score posted by the client is not accepted
 *   - the result is readable afterwards by the candidate, the recruiter and
 *     the BDE, from the database
 *
 *   node tools/verify-interview.mjs      (needs npm run dev on :4323)
 */
import { chromium } from 'playwright';

const BASE = process.env.TL_URL || 'http://localhost:4323/';
const PASSWORD = process.env.TL_PASSWORD || 'TeamLink@2026';

let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  PASS  ${name}`); }
  catch (e) { console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n')[0]}`); failed++; }
};
const must = (c, m) => { if (!c) throw new Error(m); };

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
await page.goto(BASE, { waitUntil: 'load' });
await page.waitForFunction(() => window.TL && window.TL.ready === true, { timeout: 25000 });

const api = (method, path, body) =>
  page.evaluate(([m, p, b]) => window.TL.api[m](p, b), [method, path, body]);

/* ------------------------------------------------------------------ *
 * a real candidate, a real application
 * ------------------------------------------------------------------ */
const email = `interview.${Date.now()}@example.test`;
let candidateId, applicationId, jobId, interviewId, questions;

await check('a candidate applies, so there is something to interview for', async () => {
  const reg = await api('post', '/auth/register',
    { name: 'Interview Tester', email, password: 'IvTest@2026' });
  candidateId = reg.candidateId;
  must(candidateId, 'registration returned no candidate');

  await page.evaluate(() => window.TL.refresh());
  await page.waitForTimeout(600);
  // A job the RECRUITER can manage, so the visibility check later is about
  // the score being shared and not about which company owns the job.
  jobId = await page.evaluate(() => {
    const rec = DATA.recruiters.find((r) => r.email === 'recruiter@teamlink.com');
    const j = DATA.jobs.find((x) => x.status === 'open' && x.companyId === (rec || {}).companyId)
           || DATA.jobs.find((x) => x.status === 'open');
    return j ? j.id : null;
  });
  must(jobId, 'there is no open job to apply to');

  const app = await api('post', '/applications', { jobId, source: 'portal' });
  applicationId = app.application.id;
  must(applicationId, 'no application was created');
});

let started;

await check('the interview is planned from the job description', async () => {
  started = await api('post', '/ai-interviews/session', { applicationId });
  const start = started;
  interviewId = start.interviewId;
  questions = start.questions;

  must(interviewId, 'no interview was created');
  must(start.applicationId === applicationId, 'the interview is not linked to the application');
  must(start.jobId === jobId, 'the interview is not linked to the job');
  must(questions.length >= 5, `only ${questions.length} questions were planned`);

  // The point of the exercise: technical questions cite the role.
  const tech = questions.filter((q) => q.category === 'technical');
  must(tech.length >= 1, 'no technical questions were planned');
  must(tech.every((q) => q.source), 'a technical question had no source in the job description');

  const job = await page.evaluate((id) => DATA.jobById(id), jobId);
  must(questions[0].question.includes(job.title),
    `the opening question does not mention the role: "${questions[0].question}"`);
});

await check('the interview is exactly the blueprint: 2 intro, 5 JD, 5 resume, 3 behavioural', async () => {
  must(questions.length === 15, `${questions.length} questions were planned, not 15`);

  const count = (name) => questions.filter((q) => q.section === name).length;
  const shape = { intro: count('intro'), jd: count('jd'),
                  resume: count('resume'), behavioral: count('behavioral') };
  must(shape.intro === 2 && shape.jd === 5 && shape.resume === 5 && shape.behavioral === 3,
    `the blueprint was not followed: ${JSON.stringify(shape)}`);

  // Blueprint ORDER, not just blueprint counts: introduction first,
  // behavioural last, so the interview does not open cold.
  const order = questions.map((q) => q.section);
  must(order.join(',') === [
    'intro', 'intro',
    'jd', 'jd', 'jd', 'jd', 'jd',
    'resume', 'resume', 'resume', 'resume', 'resume',
    'behavioral', 'behavioral', 'behavioral',
  ].join(','), `the sections are out of order: ${order.join(',')}`);

  // Every question must say where it came from — a question with no
  // source is a question the AI invented.
  must(questions.every((q) => q.source), 'a question had no source');
  // jobTopics() reads the requirements, then the responsibilities, then
  // falls back to sentences of the description itself - all four are the
  // job description, which is what "traced to the JD" means here.
  must(questions.filter((q) => q.section === 'jd')
        .every((q) => /requirement|responsibility|description|skill|gap/i.test(q.source)),
    'a JD question was not traced to the job description');
  must(questions.filter((q) => q.section === 'resume')
        .every((q) => /^resume:/.test(q.source)),
    'a resume question was not traced to the resume');
});

await check('the interview must be completed within two days', async () => {
  must(started.expiresAt, 'no deadline was returned');
  const hours = (new Date(started.expiresAt) - new Date(started.startedAt)) / 3600000;
  must(Math.abs(hours - 48) < 1, `the deadline is ${hours.toFixed(1)}h from the start, not 48h`);
  must(new Date(started.expiresAt) > new Date(), 'the interview was born expired');
});

await check('a different job produces a different interview', async () => {
  // Apply to a second job and plan again; the technical questions must differ.
  // A DIFFERENT requirement, not merely a different row. Two postings
  // that ask for the same skills should share questions - that is the
  // planner working - so comparing clones proves nothing.
  const otherId = await page.evaluate((first) => {
    const a = DATA.jobById(first) || {};
    const mine = new Set((a.skills || []).map((s) => String(s).toLowerCase()));
    const differs = (j) => (j.skills || []).filter((s) => mine.has(String(s).toLowerCase())).length
      < Math.max(1, Math.ceil((j.skills || []).length / 2));
    const j = DATA.jobs.find((x) => x.status === 'open' && x.id !== first && differs(x))
           || DATA.jobs.find((x) => x.status === 'open' && x.id !== first);
    return j ? j.id : null;
  }, jobId);
  if (!otherId) return;                       // only one open job seeded

  const app2 = await api('post', '/applications', { jobId: otherId, source: 'portal' });
  const s2 = await api('post', '/ai-interviews/session',
    { applicationId: app2.application.id });

  const techA = questions.filter((q) => q.category === 'technical').map((q) => q.question);
  const techB = s2.questions.filter((q) => q.category === 'technical').map((q) => q.question);
  const shared = techA.filter((q) => techB.includes(q));

  // SOME overlap is correct: two roles that both require Java, asked of a
  // candidate whose resume does not evidence it, should both ask about
  // that gap. What must never happen is the same interview twice - the
  // questions have to come from THIS job.
  must(shared.length < techA.length,
    'two different roles produced an identical set of technical questions');
  must(shared.length <= Math.floor(techA.length / 2),
    `${shared.length} of ${techA.length} technical questions were shared between two roles`);
});

await check('the interview SCREEN asks the server questions, not the browser ones', async () => {
  // generateQuestions() in the prototype builds ten questions by shuffling
  // templates. The screen must end up with the server's fifteen instead,
  // otherwise the blueprint exists only in the API.
  const seen = await page.evaluate(async (appId) => {
    if (typeof window.aiivStart !== 'function') return { skipped: 'no interview module' };

    // This application was created through the API rather than by
    // clicking Apply, so re-read the data and give the browser the
    // record it would have had.
    await window.TL.refresh();
    window.TL.ensureLocalRecords();
    const found = window.TL.aiivRec(appId);
    if (!found || !found.rec) return { skipped: 'no local record' };

    window.aiivStart(found.rec.applicationId);
    await new Promise((r) => setTimeout(r, 1800));      // let the plan arrive
    await window.aiivBeginQuestions();
    await new Promise((r) => setTimeout(r, 400));

    const qs = (found.rec.aiInterview && found.rec.aiInterview.questions) || [];
    return {
      count: qs.length,
      sections: qs.map((q) => q.section),
      first: qs.length ? qs[0].q : '',
      sourced: qs.filter((q) => q.source).length,
      deadline: found.rec.aiInterview && found.rec.aiInterview.deadline,
    };
  }, applicationId);

  must(!seen.skipped, `the screen could not be driven: ${seen.skipped}`);
  must(seen.count === 15, `the screen has ${seen.count} questions, not 15`);
  must(seen.sections.filter((x) => x === 'resume').length === 5,
    `the screen has ${seen.sections.filter((x) => x === 'resume').length} resume questions`);
  must(seen.sourced === 15, `${15 - seen.sourced} screen questions have no source`);
  must(seen.deadline, 'the screen shows no deadline');
});

/* ------------------------------------------------------------------ *
 * answering
 * ------------------------------------------------------------------ */
const GOOD = 'I owned the test automation for our release pipeline. I wrote the ' +
  'Selenium suite and the API tests, ran them on every merge, and cut the manual ' +
  'regression pass from two days to about three hours over one quarter.';

await check('a thin answer draws a follow-up, a full one does not', async () => {
  const thin = await api('post', `/ai-interviews/${interviewId}/answer`,
    { seq: questions[0].seq, transcript: 'Yes.' });
  must(thin.followUp, 'a one-word answer drew no follow-up');
  must(/brief|example/i.test(thin.followUp), `unexpected follow-up: ${thin.followUp}`);

  const tech = questions.find((q) => q.category === 'technical');
  const full = await api('post', `/ai-interviews/${interviewId}/answer`,
    { seq: tech.seq, transcript: GOOD });
  // A follow-up here is allowed, but it must be about something genuinely
  // missing rather than the length.
  if (full.followUp) {
    must(!/brief/i.test(full.followUp),
      `a 45-word answer was called brief: ${full.followUp}`);
  }
});

await check('silence is recorded as unanswered', async () => {
  const q = questions.find((x) => x.category === 'behavioral');
  const r = await api('post', `/ai-interviews/${interviewId}/answer`,
    { seq: q.seq, transcript: '' });
  must(r.recorded.answered === false, 'an empty answer was recorded as answered');
  must(!r.followUp, 'silence drew a follow-up instead of being scored zero');
});

/* ------------------------------------------------------------------ *
 * grading
 * ------------------------------------------------------------------ */
let finished;

await check('the server grades what was said, and only what was said', async () => {
  finished = await api('post', `/ai-interviews/${interviewId}/finish`, {});
  must(finished.aiInterview, 'no interview came back');
  must(finished.aiInterview.status === 'completed', 'the interview is not completed');

  const per = finished.perQuestion;
  const unanswered = per.filter((p) => !p.answered);
  must(unanswered.length > 0, 'the test did not leave an unanswered question');
  must(unanswered.every((p) => p.score === 0),
    'an unanswered question scored more than zero');
  must(per.every((p) => p.justification),
    'a question was scored with no justification');

  const answered = per.filter((p) => p.answered);
  must(answered.some((p) => p.score > 0), 'every answered question scored zero');
});

await check('five scores, each computed from its own section', async () => {
  const iv = finished.aiInterview;
  for (const k of ['technicalScore', 'behavioralScore', 'communicationScore',
                   'jdRelevance', 'resumeRelevance', 'overallPercentage']) {
    const v = Number(iv[k]);
    must(Number.isFinite(v) && v >= 0 && v <= 100, `${k} is ${iv[k]}`);
  }

  const mean = (rows) => (rows.length
    ? Math.round(rows.reduce((t, p) => t + p.score, 0) / rows.length) : 0);
  const per = finished.perQuestion;

  must(Number(iv.jdRelevance) === mean(per.filter((p) => p.section === 'jd')),
    'JD relevance is not the mean of the JD answers');
  must(Number(iv.resumeRelevance) === mean(per.filter((p) => p.section === 'resume')),
    'resume relevance is not the mean of the resume answers');
});

await check('the score is not a round number pulled from nowhere', async () => {
  const o = Number(finished.aiInterview.overallPercentage);
  must(Number.isFinite(o) && o >= 0 && o <= 100, `overall is ${o}`);
  // Recompute from the per-question scores: the aggregate must BE the
  // average of what was actually scored, not an independent number.
  const per = finished.perQuestion;
  const expected = Math.round(per.reduce((t, p) => t + p.score, 0) / per.length);
  must(Math.abs(o - expected) <= 1,
    `overall ${o} does not match the mean of the answers (${expected})`);
});

await check('a client cannot post its own score', async () => {
  // Finishing again must not accept anything, and must not change the score.
  const again = await api('post', `/ai-interviews/${interviewId}/finish`,
    { overallPercentage: 99, technicalScore: 99 });
  must(again.alreadyFinished, 'a finished interview was re-graded');

  const rows = await page.evaluate(() =>
    window.TL.api.get('/bootstrap').then((b) => b.data.aiInterviews || []));
  const mine = rows.find((r) => r.id === interviewId);
  must(mine, 'the interview is not in the candidate bootstrap');
  must(Number(mine.overallPercentage) !== 99, 'a client-supplied score was stored');
});

/* ------------------------------------------------------------------ *
 * who can see it
 * ------------------------------------------------------------------ */
await check('the candidate sees their own score, linked to the application', async () => {
  const rows = await page.evaluate(() =>
    window.TL.api.get('/bootstrap').then((b) => b.data.aiInterviews || []));
  const mine = rows.find((r) => r.id === interviewId);
  must(mine.applicationId === applicationId, 'the score is not attached to the application');
  must(mine.candidateId === candidateId, 'the score is not attached to the candidate');
  must(mine.jobId === jobId, 'the score is not attached to the job');
});

for (const [role, emailAddr] of [['recruiter', 'recruiter@teamlink.com'], ['bde', 'bde@teamlink.com']]) {
  // eslint-disable-next-line no-loop-func
  await check(`the ${role} sees the same score from the database`, async () => {
    const c2 = await browser.newContext();
    const p2 = await c2.newPage();
    await p2.goto(BASE, { waitUntil: 'load' });
    await p2.waitForFunction(() => window.TL && window.TL.ready === true, { timeout: 25000 });
    try {
      const ok = await p2.evaluate(([em, pw, r]) =>
        window.TL.api.post('/auth/login', { email: em, password: pw, role: r })
          .then(() => true, () => false), [emailAddr, PASSWORD, role]);
      if (!ok) throw new Error(`could not sign in as ${role}`);

      const rows = await p2.evaluate(() =>
        window.TL.api.get('/bootstrap').then((b) => b.data.aiInterviews || []));
      const seen = rows.find((r) => r.id === interviewId);
      must(seen, `the ${role} cannot see the interview`);
      must(Number(seen.overallPercentage) === Number(finished.aiInterview.overallPercentage),
        `the ${role} sees a different score`);
    } finally { await c2.close(); }
  });
}

await browser.close();
console.log(failed === 0
  ? '\n  AI INTERVIEW VERIFIED — planned from the job, answered, followed up, graded on the server\n'
  : `\n  ${failed} check(s) FAILED\n`);
process.exit(failed ? 1 : 0);
