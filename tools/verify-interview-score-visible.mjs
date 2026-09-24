/**
 * An interview score reaches the recruiter, the BDE and the client.
 *
 *     node tools/verify-interview-score-visible.mjs   (dev server on :4323)
 *
 * A candidate takes a real interview here - planned, answered and graded
 * by the server - and each role is then asked what it can see. The score
 * has to arrive on the CANDIDATE, because that is the record every
 * pipeline screen reads; a number that exists only inside ai_interviews
 * is a number nobody meets.
 *
 * It also checks the opposite, which is the part that was wrong: a
 * candidate who has NOT been interviewed must show no interview score at
 * all. Two places used to invent one - a card that fell back to
 * "match score minus six", and a button that wrote
 * matchScore + random() and announced "AI Interview complete" - so a
 * recruiter, a BDE and a client could all read a result for an interview
 * that never happened.
 */
import { chromium } from 'playwright';

const BASE = (process.env.TL_URL || 'http://localhost:4323/').replace(/\/$/, '');
const fail = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`); if (!ok) fail.push(what); };

const stamp = Date.now();
const EMAIL = `score.visible.${stamp}@example.com`;
const PASSWORD = 'Str0ngPass123';

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
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

let candidateId = null;
let overall = null;

try {
  /* ---- nothing invents a score before the interview --------------- */
  const noFake = await page.evaluate(() => {
    const src = document.documentElement.innerHTML
      .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
    return {
      randomScore: /aiInterviewScore\s*=\s*Math\.max\(55[^)]*Math\.random/.test(src),
      fallbackScore: /aiInterviewScore\s*\|\|[^;]*Math\.max\(55,\s*c\.matchScore\s*-\s*6\)/.test(src),
      seeded: /candidateById\('cand\d'\)\.aiInterviewScore\s*=/.test(src),
    };
  });
  check(!noFake.randomScore, 'no interview score is generated from Math.random()');
  check(!noFake.fallbackScore, 'and none is inferred from the match score when there is no interview');
  check(!noFake.seeded, 'and none is seeded onto demo candidates');

  /* ---- a real interview ------------------------------------------- */
  const reg = await api('post', '/auth/register', {
    name: 'Score Visible Test', email: EMAIL, password: PASSWORD,
    phone: '+91 90000 00005', location: 'Hyderabad', role: 'candidate',
  });
  candidateId = (reg.candidate && reg.candidate.id) || reg.candidateId || null;
  await api('post', '/auth/login', { email: EMAIL, password: PASSWORD, role: 'candidate' });

  /* Before the interview, there must be no score. */
  const before = await api('get', `/candidates/${encodeURIComponent(candidateId)}`)
    .then((r) => r.candidate || r);
  check(before.aiInterviewScore == null,
    `before any interview the candidate has no interview score (${before.aiInterviewScore})`);

  const jobs = (await api('get', '/jobs?limit=3')).jobs || [];
  const applied = await api('post', '/applications', { jobId: jobs[0].id, candidateId });
  const applicationId = (applied.application || {}).id || applied.id;

  const ses = await api('post', '/ai-interviews/session', { applicationId });
  for (let i = 0; i < (ses.questions || []).length; i++) {
    const q = ses.questions[i];
    await api('post', `/ai-interviews/${encodeURIComponent(ses.interviewId)}/answer`, {
      seq: q.seq || (i + 1), answered: true, voicedMs: 9000,
      transcript: 'I have done exactly this work before. I would plan it against the '
        + 'requirement, check each step, and review the outcome with the team.',
    });
  }
  const done = await api('post', `/ai-interviews/${encodeURIComponent(ses.interviewId)}/finish`, {});
  overall = done.aiInterview && Math.round(Number(done.aiInterview.overallPercentage));
  check(overall != null && !Number.isNaN(overall), `the interview was graded (${overall}%)`);

  /* ---- each role is asked what it can see -------------------------- */
  const roles = [
    ['recruiter', process.env.TL_RECRUITER || 'teamlinkmed001@tmlink.in',
      process.env.TL_RECRUITER_PASSWORD || 'Teamlink@2026'],
    ['admin', process.env.TL_ADMIN || 'admin@teamlink.com',
      process.env.TL_ADMIN_PASSWORD || process.env.TL_PASSWORD || 'TeamLink@2026'],
  ];
  /* A BDE or client sign-in is only attempted when one is configured -
     this deployment has two accounts, and inventing more to make a test
     pass would defeat the point of the test. */
  if (process.env.TL_BDE && process.env.TL_BDE_PASSWORD) {
    roles.push(['bde', process.env.TL_BDE, process.env.TL_BDE_PASSWORD]);
  }
  if (process.env.TL_CLIENT && process.env.TL_CLIENT_PASSWORD) {
    roles.push(['client', process.env.TL_CLIENT, process.env.TL_CLIENT_PASSWORD]);
  }

  for (const [role, email, password] of roles) {
    try { await api('post', '/auth/logout', {}); } catch { /* fine */ }
    await api('post', '/auth/login', { email, password, role });
    const c = await api('get', `/candidates/${encodeURIComponent(candidateId)}`)
      .then((r) => r.candidate || r).catch((e) => ({ error: e.message }));
    const seen = c && c.aiInterviewScore;
    check(seen != null && Math.round(Number(seen)) === overall,
      `  ${role}: sees the interview score (${seen == null ? 'nothing' : seen + '%'}, expected ${overall}%)`);

    /* And on the list a pipeline screen actually reads. */
    const list = await api('get', '/candidates?limit=400').catch(() => ({ candidates: [] }));
    const row = (list.candidates || []).find((x) => x.id === candidateId);
    check(row && row.aiInterviewScore != null,
      `  ${role}: and on the candidate list too (${row ? row.aiInterviewScore : 'row not visible'})`);
  }

  console.log('\n  BDE and client are checked when TL_BDE / TL_CLIENT are set;');
  console.log('  their read access is granted by the policies in migrations 0005 and 0010.');
} catch (e) {
  check(false, `the run failed (${e.message})`);
} finally {
  try { await api('post', '/auth/logout', {}); } catch { /* fine */ }
  if (candidateId) {
    try {
      await api('post', '/auth/login', {
        email: process.env.TL_ADMIN || 'admin@teamlink.com',
        password: process.env.TL_ADMIN_PASSWORD || process.env.TL_PASSWORD || 'TeamLink@2026',
        role: 'admin',
      });
      const gone = await api('post', '/admin/purge-test-candidate', { candidateId });
      check(gone && gone.removed === true, `the test candidate was removed (${JSON.stringify(gone)})`);
    } catch (e) {
      check(false, `CLEANUP FAILED - remove ${EMAIL} by hand (${e.message})`);
    }
  }
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors[0]}` : ''}`);
  await browser.close();
  console.log(fail.length ? `\n${fail.length} failed` : '\nall good');
  process.exit(fail.length ? 1 : 0);
}
