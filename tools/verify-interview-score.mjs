/**
 * The interview score is earned, and it reaches the recruiter's screen.
 *
 *     node tools/verify-interview-score.mjs      (dev server on :4323)
 *
 * WHY THIS IS SEPARATE from verify-interview-end-to-end.mjs. That one
 * drives the real screen, which is the right way to prove the RESULT
 * travels - but a headless browser has no speech recognition, so every
 * question is skipped and the honest score is zero. Zero proves the
 * plumbing and says nothing about the scoring.
 *
 * This one sends real transcripts through the same endpoints the browser
 * uses, and asks the only question that matters about a score: does it
 * depend on what was actually said?
 *
 * So it runs TWO candidates through the same requirement:
 *
 *   one who answers each question using the words that question is
 *   looking for, and
 *   one who answers every question with the same irrelevant paragraph
 *
 * and asserts the first scores materially higher than the second. A
 * scorer that returns a constant, or that rewards talking at length,
 * fails here - and both of those were real behaviours in this file's
 * history: an untranscribed answer used to earn up to 72 out of 100 for
 * the length of the noise, and an off-topic one up to 24 for using
 * enough words.
 *
 * Both candidates are on a domain reserved for testing, so nothing is
 * emailed, and both are removed at the end.
 */
import { chromium } from 'playwright';

const BASE = (process.env.TL_URL || 'http://localhost:4323/').replace(/\/$/, '');
const fail = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`); if (!ok) fail.push(what); };

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));

await page.goto(`${BASE}/`, { waitUntil: 'load' });
await page.waitForFunction(() => window.TL && window.TL.ready === true, { timeout: 25000 });

const api = async (m, p, b) => {
  const r = await page.evaluate(([mm, pp, bb]) => window.TL.api[mm](pp, bb)
    .then((v) => ({ ok: 1, v }), (e) => ({ ok: 0, c: e.code, m: e.message })), [m, p, b]);
  if (r.ok) return r.v;
  throw new Error(`${r.c || 'FAILED'}: ${r.m || ''}`);
};

const stamp = Date.now();
const made = [];

/**
 * Run one interview, answering every question a given way.
 *
 * `answerFor(question)` receives the question the server asked, with the
 * terms it is looking for, and returns what this candidate says.
 */
async function interview(tag, name, answerFor) {
  const email = `score.${tag}.${stamp}@example.test`;
  const reg = await api('post', '/auth/register', {
    name, email, password: 'Str0ngPass123',
    phone: '+91 90000 0' + String(made.length).padStart(4, '0'),
    location: 'Hyderabad', role: 'candidate', preferredLocation: 'Hyderabad', expectedCtc: 4, noticePeriod: 'Immediate', preferredWorkModes: ['Hybrid'],
  });
  const candidateId = (reg.candidate && reg.candidate.id) || reg.candidateId;
  made.push({ candidateId, email, name });

  await api('post', '/auth/login', { email, password: 'Str0ngPass123', role: 'candidate' });
  const jobs = (await api('get', '/jobs?limit=3')).jobs || [];
  const applied = await api('post', '/applications', { jobId: jobs[0].id, candidateId });
  const applicationId = (applied.application || {}).id || applied.id;

  const ses = await api('post', '/ai-interviews/session', { applicationId });
  const questions = ses.questions || [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    await api('post', `/ai-interviews/${encodeURIComponent(ses.interviewId)}/answer`, {
      seq: q.seq || (i + 1),
      transcript: answerFor(q),
      answered: true,
      voicedMs: 12000,
    });
  }
  const done = await api('post', `/ai-interviews/${encodeURIComponent(ses.interviewId)}/finish`, {});
  return {
    candidateId, applicationId, name,
    questions,
    overall: Math.round(Number((done.aiInterview || {}).overallPercentage)),
    perQuestion: done.perQuestion || [],
  };
}

/* The words each question is actually looking for. The server sends them
   with the question, which is how a good answer can be composed without
   this test having to know the subject. */
const wanted = (q) => []
  .concat(q.expects || [], q.topic || [], q.keywords || [])
  .map((x) => String(x)).filter(Boolean);

const OFF_TOPIC = 'I enjoy gardening at the weekend and I recently repainted my kitchen. '
  + 'The weather has been changeable and I have been reading a novel about sailing. '
  + 'My neighbour has a dog that barks at the postman every single morning without fail.';

try {
  const good = await interview('good', 'Answers The Question', (q) => {
    const terms = wanted(q);
    const lead = terms.length
      ? `In my last role I worked directly on ${terms.slice(0, 4).join(', ')}. `
      : 'In my last role I did this work directly. ';
    return lead
      + `I was responsible for it day to day, I planned the work against what the `
      + `requirement asked for, checked each step, and reviewed the outcome with my team. `
      + `${terms.slice(0, 6).map((t) => `I used ${t} regularly.`).join(' ')} `
      + `Where something went wrong I traced it back to the cause and changed the process `
      + `so it could not happen the same way again.`;
  });

  const poor = await interview('poor', 'Talks About Something Else', () => OFF_TOPIC);

  console.log('');
  check(good.questions.length > 0, `the interview asked real questions (${good.questions.length})`);
  const q0 = good.questions[0] || {};
  console.log(`\n  a question it asked: ${
    String(q0.question || q0.q || q0.text || JSON.stringify(q0)).slice(0, 110)}`);
  console.log(`  what it looks for  : ${JSON.stringify(wanted(q0).slice(0, 6))}`);

  console.log('\n  scores:');
  console.log(`    answering the question   ${good.overall}%   (${good.name})`);
  console.log(`    answering something else ${poor.overall}%   (${poor.name})`);

  /* ---- the score depends on what was said -------------------------- */
  check(Number.isFinite(good.overall) && Number.isFinite(poor.overall),
    'both interviews produced a number');
  check(good.overall > 0,
    `answering the question scores above zero (${good.overall}%)`);
  check(good.overall > poor.overall,
    `and scores higher than answering something else (${good.overall}% vs ${poor.overall}%)`);
  check(good.overall - poor.overall >= 15,
    `by a margin that means something, not a rounding difference (${good.overall - poor.overall} points)`);

  /* An off-topic answer is worth nothing, however much of it there is.
     The paragraph above is longer than most real answers. */
  const offTopicPer = poor.perQuestion.filter((x) => Number(x.score) > 0);
  check(offTopicPer.length === 0,
    `no off-topic answer earned marks for its length (${offTopicPer.length} did)`);

  /* ---- and the recruiter can see it -------------------------------- */
  await api('post', '/auth/logout', {});
  await api('post', '/auth/login', {
    email: process.env.TL_RECRUITER || 'teamlinkmed001@tmlink.in',
    password: process.env.TL_RECRUITER_PASSWORD || 'Teamlink@2026',
    role: 'recruiter',
  });
  await page.evaluate(() => window.TL.refresh());
  await page.waitForTimeout(2500);
  await page.evaluate(() => { location.hash = '#/recruiter/applications'; });
  await page.waitForTimeout(2500);

  for (const who of [good, poor]) {
    const seen = await page.evaluate((n) => {
      const row = [...document.querySelectorAll('tr')].find((tr) => tr.textContent.includes(n));
      if (!row) return { found: false };
      const tag = row.querySelector('.tl-ivscore');
      return { found: true, text: tag ? tag.textContent.trim() : null };
    }, who.name);
    check(seen.found, `  "${who.name}" is on the recruiter's Applications screen`);
    check(seen.found && seen.text && seen.text.includes(`${who.overall}%`),
      `  showing ${who.overall}% (${seen.text || 'no interview tag'})`);
  }

  /* The database's number and the screen's number are the same number. */
  const cands = (await api('get', '/candidates?limit=500')).candidates || [];
  for (const who of [good, poor]) {
    const c = cands.find((x) => x.id === who.candidateId);
    check(c && Math.round(Number(c.aiInterviewScore)) === who.overall,
      `  and the candidate record agrees (${c && c.aiInterviewScore} vs ${who.overall})`);
  }
} catch (e) {
  check(false, `the run failed (${e.message})`);
} finally {
  try { await api('post', '/auth/logout', {}); } catch { /* already out */ }
  try {
    await api('post', '/auth/login', {
      email: process.env.TL_ADMIN || 'admin@teamlink.com',
      password: process.env.TL_ADMIN_PASSWORD || process.env.TL_PASSWORD || 'TeamLink@2026',
      role: 'admin',
    });
    for (const m of made) {
      const gone = await api('post', '/admin/purge-test-candidate', { candidateId: m.candidateId })
        .catch((e) => ({ removed: false, error: e.message }));
      check(gone && gone.removed === true, `  removed ${m.name} (${JSON.stringify(gone)})`);
    }
  } catch (e) {
    check(false, `CLEANUP FAILED - remove ${made.map((m) => m.email).join(', ')} by hand (${e.message})`);
  }
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors[0]}` : ''}`);
  await browser.close();
  console.log(fail.length ? `\n${fail.length} failed` : '\nall good');
  process.exit(fail.length ? 1 : 0);
}
