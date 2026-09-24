/**
 * The screening reads the resume, and a finished interview reaches the
 * recruiter.
 *
 *     node tools/verify-screening-resume.mjs   (needs the dev server on :4323)
 *
 * Two things a recruiter asked for, and both were the same shape of
 * problem: the work was being done and nobody was being told.
 *
 *   THE RESUME. "AI screening" scored a candidate from the fields on
 *   their record. The CV was stored, parsed once into whatever empty
 *   columns it could fill, and never read again - so a resume that
 *   spends two pages on Spring Boot contributed nothing unless somebody
 *   had also typed "Spring Boot" into a skills box. And the score was
 *   computed when the application was created, which is almost always
 *   BEFORE the CV is attached, so uploading one changed nothing at all.
 *
 *   THE INTERVIEW. A candidate sat it, answered every question and was
 *   scored. Two notifications went out, both to the candidate. The
 *   application stayed at "Interview Scheduled" the morning after the
 *   interview happened and the recruiter was told nothing.
 *
 * Everything below is driven through the running server, and the
 * fixtures are removed again at the end.
 */
import { chromium } from 'playwright';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const BASE = (process.env.TL_URL || 'http://localhost:4323/').replace(/\/$/, '');
const RECRUITER = {
  email: process.env.TL_RECRUITER || 'teamlinkmed001@tmlink.in',
  password: process.env.TL_RECRUITER_PASSWORD || 'Teamlink@2026',
  role: 'recruiter',
};

const fail = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`); if (!ok) fail.push(what); };

/* A real resume file, built the way the real ones are. */
const DIR = 'var/test-resumes';
if (!existsSync(`${DIR}/Resume - Sravanthi.txt`)) {
  execFileSync(process.execPath, ['tools/make-test-resumes.mjs', DIR], { stdio: 'inherit' });
}
const RESUME = readFileSync(`${DIR}/Resume - Sravanthi.txt`);
const RESUME_TEXT = RESUME.toString('utf8');

const browser = await chromium.launch();
const open = async () => {
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.TL && window.TL.ready === true, { timeout: 25000 });
  return {
    page,
    api: async (m, p, b) => {
      const r = await page.evaluate(([mm, pp, bb]) => window.TL.api[mm](pp, bb)
        .then((v) => ({ ok: 1, v }), (e) => ({ ok: 0, c: e.code, m: e.message })), [m, p, b]);
      if (!r.ok) throw Object.assign(new Error(`${r.c || 'FAILED'}: ${r.m || ''}`), { code: r.c });
      return r.v;
    },
  };
};

const rec = await open();
await rec.api('post', '/auth/login', RECRUITER);

/*
 * A requirement asking for exactly what the resume proves.
 *
 * The skills are taken FROM the resume text, so the test is not "does a
 * match happen" but "is the CV what produced it" - the candidate's
 * profile will carry none of them.
 */
// Taken from the resume the fixture builds, so a match can only have
// come from the CV - the candidate's profile lists none of them.
const SKILLS = ['Java', 'Spring Boot', 'PostgreSQL'];
for (const s of SKILLS) {
  check(new RegExp(`\\b${s}\\b`, 'i').test(RESUME_TEXT), `the resume names ${s}`);
}

const stamp = Date.now();
const companies = (await rec.api('get', '/companies')).companies || [];
const job = (await rec.api('post', '/jobs', {
  title: `Screening Test ${stamp}`, companyId: (companies[0] || {}).id,
  location: 'Hyderabad', department: 'Engineering', skills: SKILLS,
  exp: '2-6 yrs', status: 'open', desc: 'Raised by verify-screening-resume.',
})).job;

/* ---- a candidate with NO skills on their profile -------------------- */
const cand = await open();
const email = `screen.${stamp}@example.invalid`;
await cand.api('post', '/auth/register',
  { name: `Screening Candidate ${stamp}`, email, password: 'Screen@2026' });
const applied = await cand.api('post', '/applications', { jobId: job.id });
const appId = applied.application.id;
const candidateId = applied.application.candidateId || applied.application.candidate_id;

const appRow = async () => {
  const r = await rec.api('get', `/applications?jobId=${job.id}&limit=20`);
  return (r.applications || []).find((a) => a.id === appId) || {};
};

/* The first score, with no resume behind it. */
await rec.page.waitForTimeout(1200);
const before = await appRow();
check(before.aiScore != null, `the application was screened on arrival (${before.aiScore}%)`);

/* ---- upload the resume, which is the whole point -------------------- */
const uploaded = await cand.page.evaluate(async ([b64, name]) => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const fd = new FormData();
  fd.append('resume', new File([bytes], name, { type: 'text/plain' }));
  return window.TL.api.post('/uploads/resume', fd)
    .then((v) => ({ ok: 1, rescreened: v.rescreened, parse: v.parse }),
          (e) => ({ ok: 0, m: e.message }));
}, [RESUME.toString('base64'), 'Resume - Sravanthi.txt']);

check(uploaded.ok === 1, `the resume uploads (${uploaded.m || 'ok'})`);
check(uploaded.parse && uploaded.parse.ok, 'and it was read');
check(Array.isArray(uploaded.rescreened) && uploaded.rescreened.length > 0,
  `uploading it re-ran the screening (${JSON.stringify(uploaded.rescreened)})`);

await rec.page.waitForTimeout(1200);
const after = await appRow();
check(after.aiScore > before.aiScore,
  `the score went UP once the CV was read (${before.aiScore}% -> ${after.aiScore}%)`);

/*
 * And it is the RESUME that did it, not something typed in. The skills
 * the job asks for must appear in the screening's evidence while the
 * candidate's own profile still lists none of them.
 */
const events = await rec.api('get', `/intake/timeline?applicationId=${appId}`);
const screening = (events.timeline || []).filter((e) => e.type === 'screening.completed').pop();
check(!!screening, 'the screening is on the timeline');
const evidence = JSON.stringify(screening && screening.metadata || {});
check(SKILLS.some((s) => evidence.toLowerCase().includes(s.toLowerCase())),
  `the requirement's skills are named in the evidence (${evidence.slice(0, 120)})`);

/* ---- a word-boundary check, because a CV is long -------------------- */
/*
 * The reason this is not a substring search: "java" is inside
 * "javascript", and a CV is long enough that a substring test finds
 * almost anything. This asserts the distinction directly.
 */
const { scoreSkills } = await import('../api/src/ai/match.js');
const jsOnly = scoreSkills({ skills: ['Java'] },
  { skills: [], resumeText: 'Built the front end in JavaScript and TypeScript.' });
check(jsOnly.implied.length === 0 && jsOnly.matched.length === 0,
  `a CV that says JavaScript is not evidence of Java (${JSON.stringify(jsOnly.implied)})`);
const realJava = scoreSkills({ skills: ['Java'] },
  { skills: [], resumeText: 'Five years of Java and Spring Boot.' });
check(realJava.implied.includes('java'),
  `a CV that says Java is (${JSON.stringify(realJava.implied)})`);
/*
 * Punctuation, both ways. canonical() folds "Node.js" to "nodejs" so two
 * profiles spelling it differently still match - but a CV writes the
 * dot, and "nodejs" is not inside "node.js". Both spellings are searched
 * for, or a requirement naming Node.js or Spring Boot finds nothing in a
 * resume that says it on every page.
 */
const dotted = scoreSkills({ skills: ['Node.js'] },
  { skills: [], resumeText: 'Services written in Node.js, deployed on AWS.' });
check(dotted.implied.length === 1, `"Node.js" matches with its dot (${JSON.stringify(dotted.implied)})`);
const spaced = scoreSkills({ skills: ['Spring Boot'] },
  { skills: [], resumeText: 'Five years of Java and Spring Boot microservices.' });
check(spaced.implied.length === 1, `and "Spring Boot" with its space (${JSON.stringify(spaced.implied)})`);
const absent = scoreSkills({ skills: ['Python'] },
  { skills: [], resumeText: 'Java, Spring Boot, PostgreSQL, React, AWS' });
check(absent.implied.length === 0 && absent.missing.length === 1,
  'a skill the CV does not mention stays missing, not guessed at');

/* ------------------------------------------------------------------ *
 * the interview reaches the recruiter
 * ------------------------------------------------------------------ *
 * The candidate sits it and is scored. Before this, that produced two
 * notifications, both to the candidate: the application stayed at
 * whatever stage it was on, the score lived only inside ai_interviews
 * where no pipeline screen reads it, and the recruiter was told nothing.
 */
const stageOf = async () => (await appRow()).stage;
const stageBefore = await stageOf();

const session = await cand.api('post', '/ai-interviews/session', { applicationId: appId });
check(!!session.interviewId, `an interview is planned (${(session.questions || []).length} questions)`);

const ANSWER = 'I led the migration of a monolith to Spring Boot services backed by '
  + 'PostgreSQL, owning schema design and query performance. I cut the p95 latency '
  + 'from 900ms to 180ms by adding covering indexes and moving report generation '
  + 'onto an async worker, and I wrote the runbook the on-call team still uses.';

for (const q of (session.questions || [])) {
  // eslint-disable-next-line no-await-in-loop
  await cand.api('post', `/ai-interviews/${session.interviewId}/answer`,
    { seq: q.seq, transcript: ANSWER });
}

const finished = await cand.api('post', `/ai-interviews/${session.interviewId}/finish`, {});
check(finished.aiInterview && finished.aiInterview.status === 'completed',
  'the interview completes and is graded');

const overall = Math.round(Number((finished.aiInterview || {}).overallPercentage
  || (finished.aiInterview || {}).overall_percentage || 0));
check(overall > 0, `it produced a score (${overall}%)`);

/* The three things the recruiter needed and did not have. */
check(finished.recruiter && finished.recruiter.recorded === true,
  `the result was recorded against the application (${JSON.stringify(finished.recruiter)})`);

await rec.page.waitForTimeout(900);
const stageAfter = await stageOf();
check(stageAfter === 'ai_interview_done',
  `the application moved to AI Interview Done (${stageBefore} -> ${stageAfter})`);

const tl = await rec.api('get', `/intake/timeline?applicationId=${appId}`);
const done = (tl.timeline || []).find((e) => e.type === 'interview.completed');
check(!!done, "the completed interview is on the recruiter's timeline");
check(!!done && String(done.detail || '').includes(String(overall)),
  `and the timeline carries the score (${done && done.detail})`);

const notes = await rec.api('get', '/notifications?limit=30');
const mine = (notes.notifications || []).find((n) =>
  n.type === 'AI_INTERVIEW_COMPLETED' && n.applicationId === appId);
check(!!mine, 'the recruiter has a notification about it');
check(!!mine && /\d+%/.test(mine.message || ''),
  `and the notification names the score (${mine && mine.message})`);

const profile = await rec.api('get', `/candidates/${candidateId}`);
const iv = (profile.candidate || {}).aiInterviewScore;
check(Number(iv) === overall,
  `the score is on the candidate, where every screen already looks (${iv})`);

/* ---- clean up -------------------------------------------------------- */
try {
  const admin = await open();
  await admin.api('post', '/auth/login', {
    email: process.env.TL_ADMIN || 'admin@teamlink.com',
    password: process.env.TL_ADMIN_PASSWORD || process.env.TL_PASSWORD || 'TeamLink@2026',
    role: 'admin',
  });
  await admin.api('del', `/jobs/${job.id}`);
  const left = ((await admin.api('get',
    `/jobs?q=${encodeURIComponent(`Screening Test ${stamp}`)}`)).jobs || [])
    .filter((j) => j.title === `Screening Test ${stamp}`);
  check(left.length === 0, 'the test requirement was removed again');

  /*
   * And the CANDIDATE, which is the part that used to be impossible.
   *
   * There is no route that deletes an applicant and there should not be
   * - an ATS where a recruiter can erase somebody has no audit trail -
   * so every run used to leave one person behind, sitting in the
   * recruiter's portal looking exactly like a real application. The
   * database now allows exactly this: an admin removing a candidate
   * whose address is on a domain reserved for testing, and nothing else.
   */
  if (candidateId) {
    const gone = await admin.api('post', '/admin/purge-test-candidate',
      { candidateId: candidateId });
    check(gone && gone.removed === true,
      `the test candidate was removed too (${JSON.stringify(gone)})`);
  }

} catch (e) {
  console.log(`  NOTE: the test requirement was left behind (${e.message})`);
}

await browser.close();
console.log(fail.length ? `\n${fail.length} failed` : '\nall good');
process.exit(fail.length ? 1 : 0);
