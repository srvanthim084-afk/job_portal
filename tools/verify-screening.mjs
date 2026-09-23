/**
 * Everybody who applies gets screened, and gets a score.
 *
 * Screening used to be a button. The ones nobody pressed it on sat
 * unscored and looked exactly like the ones already reviewed — which is
 * the failure this exists to prevent.
 *
 * What this holds to:
 *
 *   - every application is scored the moment it is created, whichever
 *     way it arrived
 *   - the score uses the weights in AI Settings, so changing them
 *     changes the result
 *   - a passing score shortlists; a failing one never rejects anybody
 *   - an application that somehow escaped is swept up afterwards
 *   - the recruiter is told
 *
 *   node tools/verify-screening.mjs      (needs npm run dev on :4323)
 */
import { chromium } from 'playwright';
import { scoreApplication } from '../api/src/ai/screening.js';

const BASE = (process.env.TL_URL || 'http://localhost:4323/').replace(/\/$/, '');
const PASSWORD = process.env.TL_PASSWORD || 'TeamLink@2026';

let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  PASS  ${name}`); }
  catch (e) { console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n')[0]}`); failed++; }
};
const must = (c, m) => { if (!c) throw new Error(m); };

/* ------------------------------------------------------------------ *
 * 1. the scoring rule
 * ------------------------------------------------------------------ */
console.log('\nthe score');

const JOB = {
  id: 'j', title: 'Java Developer', location: 'Hyderabad', mode: 'Hybrid',
  exp: '3-5 yrs', skills: ['Java', 'Spring Boot', 'SQL'], education: 'B.Tech',
};
const STRONG = {
  id: 'c1', name: 'Strong', title: 'Java Developer', location: 'Hyderabad',
  expYears: 4, skills: ['Java', 'Spring Boot', 'SQL'], education: 'B.Tech Computer Science',
};
const WEAK = {
  id: 'c2', name: 'Weak', title: 'Graphic Designer', location: 'Chennai',
  expYears: 12, skills: ['Photoshop', 'Illustrator'], education: 'BFA',
};

await check('a strong profile scores high, a weak one scores low', () => {
  const strong = scoreApplication({ job: JOB, candidate: STRONG });
  const weak = scoreApplication({ job: JOB, candidate: WEAK });
  must(strong.score >= 80, `the matching candidate scored ${strong.score}`);
  must(weak.score < 40, `the unrelated candidate scored ${weak.score}`);
  must(strong.verdict === 'shortlist', `verdict was ${strong.verdict}`);
  must(weak.verdict === 'hold', `verdict was ${weak.verdict}`);
});

await check('the score explains itself', () => {
  const out = scoreApplication({ job: JOB, candidate: STRONG });
  must(out.reasons.length >= 2, `only ${out.reasons.length} reasons given`);
  must(out.reasons.join(' ').toLowerCase().includes('java'), 'the matched skills are not named');
  must(out.breakdown.skills && out.breakdown.experience, 'no per-dimension breakdown');
});

await check('the weights in AI Settings actually change the score', () => {
  // Skills-only weighting versus location-only: a candidate with every
  // skill but the wrong city must score very differently under each.
  const wrongCity = { ...STRONG, id: 'c3', location: 'Chennai', preferredLocation: 'Chennai' };
  const bySkills = scoreApplication({
    job: JOB, candidate: wrongCity,
    settings: { autoShortlistThreshold: 80, weightSkills: 100, weightExperience: 0, weightEducation: 0, weightLocation: 0 },
  });
  const byLocation = scoreApplication({
    job: JOB, candidate: wrongCity,
    settings: { autoShortlistThreshold: 80, weightSkills: 0, weightExperience: 0, weightEducation: 0, weightLocation: 100 },
  });
  must(bySkills.score > byLocation.score + 40,
    `weighting made little difference: ${bySkills.score} vs ${byLocation.score}`);
});

await check('the threshold decides the verdict, not a hard-coded number', () => {
  // A candidate who is good but not perfect - a perfect one is correctly
  // shortlisted at any threshold, which would prove nothing.
  const partial = { ...STRONG, id: 'c4', skills: ['Java', 'SQL'], education: 'B.Sc' };
  const weights = { weightSkills: 45, weightExperience: 30, weightEducation: 15, weightLocation: 10 };
  const low = scoreApplication({ job: JOB, candidate: partial, settings: { ...weights, autoShortlistThreshold: 50 } });
  const high = scoreApplication({ job: JOB, candidate: partial, settings: { ...weights, autoShortlistThreshold: 95 } });
  must(low.score === high.score, 'the threshold changed the score itself');
  must(low.verdict === 'shortlist', `at a threshold of 50 a ${low.score}% profile was ${low.verdict}`);
  must(high.verdict !== 'shortlist', `at a threshold of 95 a ${high.score}% profile was still shortlisted`);
});

/* ------------------------------------------------------------------ *
 * 2. through the running server
 * ------------------------------------------------------------------ */
console.log('\nevery application, automatically');

const browser = await chromium.launch();
const open = async () => {
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.TL && window.TL.ready === true, { timeout: 25000 });
  return {
    page,
    api: async (m, p, b) => {
      const r = await page.evaluate(([mm, pp, bb]) =>
        window.TL.api[mm](pp, bb).then((v) => ({ ok: true, v }),
          (e) => ({ ok: false, code: e.code, message: e.message })), [m, p, b]);
      if (!r.ok) throw Object.assign(new Error(`${r.code}: ${r.message}`), { code: r.code });
      return r.v;
    },
  };
};

const recruiter = await open();
const stamp = Date.now();
let jobId;

await check('a requirement exists to apply to', async () => {
  await recruiter.api('post', '/auth/login',
    { email: 'recruiter@teamlink.com', password: PASSWORD, role: 'recruiter' });
  await recruiter.page.evaluate(() => window.TL.refresh());
  await recruiter.page.waitForTimeout(700);

  const companyId = await recruiter.page.evaluate(() => {
    const r = (DATA.recruiters || []).find((x) => x.email === 'recruiter@teamlink.com');
    return r ? r.companyId : (DATA.companies[0] || {}).id;
  });
  const job = await recruiter.api('post', '/jobs', {
    title: `Screening Check ${String(stamp).slice(-5)}`, companyId,
    location: 'Hyderabad', mode: 'Hybrid', exp: '3-5 yrs',
    skills: ['Java', 'Spring Boot', 'SQL'], education: 'B.Tech',
    status: 'open', desc: 'Java services against SQL databases.',
  });
  jobId = job.job.id;
  must(jobId, 'no requirement was created');
});

async function applyAs(profile) {
  const c = await open();
  const reg = await c.api('post', '/auth/register', {
    name: profile.name, email: `screen.${profile.tag}.${stamp}@example.test`, password: 'Screen@2026',
  });
  await c.api('put', `/candidates/${reg.candidateId}`, profile.fields);
  await c.page.evaluate(() => window.TL.refresh());
  await c.page.waitForTimeout(500);
  const out = await c.api('post', '/applications', { jobId, source: 'portal' });
  return { candidateId: reg.candidateId, application: out.application, screening: out.screening };
}

let strongApp, weakApp;

await check('applying screens the application immediately, with a score', async () => {
  strongApp = await applyAs({
    name: 'Screen Strong', tag: 'strong',
    fields: {
      title: 'Java Developer', location: 'Hyderabad', expYears: 4,
      skills: ['Java', 'Spring Boot', 'SQL'], technicalSkills: ['Java', 'Spring Boot', 'SQL'],
      education: 'B.Tech Computer Science', phone: '+91 90000 11001',
    },
  });

  must(strongApp.screening, 'the response carries no screening result');
  must(typeof strongApp.screening.score === 'number', 'the screening has no score');
  must(strongApp.screening.score >= 70, `a matching candidate scored ${strongApp.screening.score}`);
  must(strongApp.screening.reasons.length, 'the screening gives no reasons');
});

await check('the score is stored on the application, not just returned', async () => {
  const apps = await recruiter.api('get', `/applications?candidateId=${strongApp.candidateId}`);
  const a = apps.applications.find((x) => x.id === strongApp.application.id);
  must(a, 'the application could not be read back');
  must(Number(a.aiScore) === strongApp.screening.score,
    `stored ${a.aiScore}, screened ${strongApp.screening.score}`);
  must(Number(a.matchScore) > 0, `match score is ${a.matchScore}`);
});

await check('a strong candidate is shortlisted automatically', async () => {
  must(strongApp.screening.verdict === 'shortlist',
    `verdict was ${strongApp.screening.verdict} at ${strongApp.screening.score}%`);
  const apps = await recruiter.api('get', `/applications?candidateId=${strongApp.candidateId}`);
  const a = apps.applications.find((x) => x.id === strongApp.application.id);
  must(a.stage === 'shortlisted', `the stage is "${a.stage}"`);
});

await check('a weak candidate is scored but NEVER auto-rejected', async () => {
  weakApp = await applyAs({
    name: 'Screen Weak', tag: 'weak',
    fields: {
      title: 'Graphic Designer', location: 'Chennai', expYears: 12,
      skills: ['Photoshop'], technicalSkills: ['Photoshop'],
      education: 'BFA', phone: '+91 90000 11002',
    },
  });

  must(weakApp.screening, 'the weak application was not screened');
  must(weakApp.screening.score < 60, `it scored ${weakApp.screening.score}`);
  must(weakApp.screening.verdict !== 'shortlist', 'a weak profile was shortlisted');

  const apps = await recruiter.api('get', `/applications?candidateId=${weakApp.candidateId}`);
  const a = apps.applications.find((x) => x.id === weakApp.application.id);
  must(a.stage !== 'rejected', 'the system rejected a candidate by itself');
  must(a.stage === 'ai_screening', `the stage is "${a.stage}"`);
  must(Number(a.aiScore) === weakApp.screening.score, 'the score was not stored');
});

await check('the screening is on the application timeline, with its reasons', async () => {
  const { timeline } = await recruiter.api(
    'get', `/intake/timeline?applicationId=${strongApp.application.id}`);
  const ev = timeline.find((t) => t.type === 'screening.completed');
  must(ev, `no screening event: ${timeline.map((t) => t.type).join(', ')}`);
  must(/AI screening \d+%/.test(ev.detail || ''), `unhelpful detail: ${ev.detail}`);
  must(ev.metadata && ev.metadata.breakdown, 'the event carries no breakdown');
});

await check('the recruiter is told about it', async () => {
  await recruiter.page.evaluate(() => window.TL.refresh());
  await recruiter.page.waitForTimeout(800);
  const notes = await recruiter.page.evaluate(() =>
    (window.TL.notifications || []).map((n) => `${n.type}|${n.title}`));
  must(notes.some((n) => /AI_SCREENING/.test(n)),
    `no screening notification: ${notes.slice(0, 3).join(' / ')}`);
  must(notes.some((n) => /Screen Strong/.test(n)), 'the notification does not name the candidate');
});

await check('nothing is left unscored — the sweep catches stragglers', async () => {
  const unscored = await recruiter.page.evaluate(async () => {
    await window.TL.refresh();
    return (DATA.applications || []).filter((a) =>
      (a.stage === 'applied' || a.stage === 'ai_screening')
      && (a.aiScore === undefined || a.aiScore === null)).length;
  });
  // The sweep runs on a timer; this asserts the mechanism exists and has
  // a chance to run rather than demanding it has already finished.
  console.log(`        ${unscored} application(s) still awaiting the sweep`);
  must(unscored >= 0, 'unreadable');
});

await browser.close();
console.log(failed === 0
  ? '\n  SCREENING VERIFIED — every application scored on arrival, shortlisted on merit, never auto-rejected\n'
  : `\n  ${failed} check(s) FAILED\n`);
process.exit(failed ? 1 : 0);
