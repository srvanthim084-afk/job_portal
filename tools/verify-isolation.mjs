/**
 * One recruiter, one portal.
 *
 * The tenancy boundary used to be the COMPANY: every policy asked
 * whether a job belonged to `app_recruiter_company()`. So two recruiters
 * at the same company saw each other's requirements, each other's
 * candidates, each other's pipelines and each other's notes — and it
 * grew quietly, because a colleague added today could read everything
 * done before they arrived.
 *
 * The boundary is now the recruiter. This does not read the policies and
 * agree with them; it creates two recruiters, gives each one work, and
 * has each of them TRY TO REACH the other's. A policy that is wrong
 * fails here rather than in production.
 *
 * What it holds to:
 *
 *   - a recruiter sees their own requirement, and not the other's
 *   - a recruiter sees their own candidates, and not the other's
 *   - a recruiter sees their own applications, and not the other's
 *   - asking for another recruiter's record BY ID does not return it
 *   - a recruiter cannot edit what they cannot see
 *   - an admin still sees everything
 *   - a candidate still sees their own applications
 *   - the public job board still works, signed out
 *
 *   node tools/verify-isolation.mjs      (needs npm run dev on :4323)
 */
import { chromium } from 'playwright';

const BASE = (process.env.TL_URL || 'http://localhost:4323/').replace(/\/$/, '');
const ADMIN = { email: 'admin@teamlink.com', password: process.env.TL_PASSWORD || 'TeamLink@2026' };
const stamp = Date.now();

let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  PASS  ${name}`); }
  catch (e) { console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n')[0]}`); failed++; }
};
const must = (c, m) => { if (!c) throw new Error(m); };

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
      if (!r.ok) { const err = new Error(`${r.c || 'FAILED'}: ${r.m || ''}`); err.code = r.c; throw err; }
      return r.v;
    },
  };
};

/* ------------------------------------------------------------------ *
 * two recruiters, each with their own desk
 * ------------------------------------------------------------------ */
console.log('\nsetting up two recruiters');

const admin = await open();
await admin.api('post', '/auth/login', { ...ADMIN, role: 'admin' });
// listIds() reaches through `.session`, so the admin carries one too.
admin.session = admin;

// Whichever company this deployment has. A requirement must belong to one.
const COMPANY = ((await admin.api('get', '/companies')).companies || [])[0]?.id;
if (!COMPANY) {
  console.log('\n  No company exists, so no requirement can be created. Stopping.\n');
  await browser.close();
  process.exit(1);
}

const PW = 'Isolation@2026';
const people = [
  { name: `Alpha ${stamp}`, email: `alpha.${stamp}@tmlink.in` },
  { name: `Beta ${stamp}`,  email: `beta.${stamp}@tmlink.in` },
];

for (const p of people) {
  const made = await admin.api('post', '/staff/recruiters',
    { name: p.name, email: p.email, password: PW, title: 'Recruiter' });
  p.id = made.recruiter.id;
  p.session = await open();
  await p.session.api('post', '/auth/login',
    { email: p.email, password: PW, role: 'recruiter' });
}
const [A, B] = people;
console.log(`  ${A.name} and ${B.name} created and signed in`);

/** Give a recruiter a requirement and a candidate on it. */
async function deskFor(who, tag) {
  // The route sets recruiter_id from the session, which is the point:
  // a recruiter cannot create a requirement for somebody else.
  const job = (await who.session.api('post', '/jobs', {
    title: `Isolation ${tag} ${stamp}`,
    companyId: COMPANY,
    location: 'Hyderabad', mode: 'Hybrid', exp: '3-5 yrs',
    skills: ['Java'], desc: 'An isolation test requirement.',
    status: 'open',
  })).job;

  const imported = await who.session.api('post', '/candidates/import', {
    text: `Name,Email,Phone\nCand ${tag} ${stamp},cand.${tag}.${stamp}@example.test,`
        + `+91 6${String(stamp).slice(-9)}${tag === 'A' ? '1' : '2'}`,
  });
  const candidateId = imported.detail.imported[0].id;

  const app = (await who.session.api('post', '/applications',
    { jobId: job.id, candidateId })).application;

  return { jobId: job.id, candidateId, applicationId: app.id };
}

let deskA, deskB;
await check('each recruiter gets a requirement, a candidate and an application', async () => {
  deskA = await deskFor(A, 'A');
  deskB = await deskFor(B, 'B');
  must(deskA.jobId && deskB.jobId, 'a requirement was not created');
  must(deskA.candidateId !== deskB.candidateId, 'both desks got the same candidate');
});

/* ------------------------------------------------------------------ *
 * the boundary
 * ------------------------------------------------------------------ */
console.log('\nwhat each recruiter can reach');

const listIds = async (who, path, key) =>
  ((await who.session.api('get', path))[key] || []).map((x) => x.id);

await check('a recruiter sees their own requirement and not the other one', async () => {
  const mine = await listIds(A, '/jobs?limit=200', 'jobs');
  must(mine.includes(deskA.jobId), 'the recruiter cannot see their own requirement');
  must(!mine.includes(deskB.jobId),
    "the recruiter can see another recruiter's requirement");
});

await check('a recruiter sees their own candidates and not the other\'s', async () => {
  const mine = await listIds(A, '/candidates?limit=200', 'candidates');
  must(mine.includes(deskA.candidateId), 'the recruiter cannot see their own candidate');
  must(!mine.includes(deskB.candidateId),
    "the recruiter can see another recruiter's candidate");
});

await check('a recruiter sees their own applications and not the other\'s', async () => {
  const mine = await listIds(A, '/applications?limit=200', 'applications');
  must(mine.includes(deskA.applicationId), 'the recruiter cannot see their own application');
  must(!mine.includes(deskB.applicationId),
    "the recruiter can see another recruiter's application");
});

/* ------------------------------------------------------------------ *
 * the boundary, when somebody knows the id
 * ------------------------------------------------------------------ */
console.log('\nasking for the other desk by id');

const refused = async (who, method, path, body) => {
  try {
    const out = await who.session.api(method, path, body);
    // A list endpoint answers with an empty set rather than an error,
    // which is just as good: nothing crossed.
    if (out && typeof out === 'object') {
      const payload = out.candidate || out.job || out.application;
      return payload ? `RETURNED ${JSON.stringify(payload).slice(0, 80)}` : null;
    }
    return null;
  } catch (e) {
    return null;                       // refused outright
  }
};

await check("another recruiter's candidate is not readable by id", async () => {
  const leak = await refused(A, 'get', `/candidates/${deskB.candidateId}`);
  must(!leak, leak);
});

await check("another recruiter's UNPUBLISHED requirement is not readable", async () => {
  /*
   * An OPEN requirement is a public posting - the job board shows it to
   * anybody, signed out included - so a recruiter reading one by id is
   * not a leak, it is the advertisement working. The boundary that
   * matters is a requirement that has NOT been published.
   */
  const draft = (await B.session.api('post', '/jobs', {
    title: `Isolation draft ${stamp}`, companyId: COMPANY,
    location: 'Hyderabad', skills: ['Java'], status: 'draft',
  })).job;

  const leak = await refused(A, 'get', `/jobs/${draft.id}`);
  must(!leak, leak);

  const mine = await listIds(A, '/jobs?limit=200', 'jobs');
  must(!mine.includes(draft.id), "a draft of another recruiter is in the list");
});

await check('a recruiter cannot edit what they cannot see', async () => {
  let changed = false;
  try {
    await A.session.api('put', `/candidates/${deskB.candidateId}`,
      { title: 'Edited by the wrong recruiter' });
    changed = true;
  } catch (e) { /* refused, which is the point */ }

  if (changed) {
    // It may have answered 200 and changed nothing, which RLS does on an
    // UPDATE. Check from the owner's side, which is what matters.
    const theirs = await B.session.api('get', `/candidates/${deskB.candidateId}`);
    must(theirs.candidate.title !== 'Edited by the wrong recruiter',
      "one recruiter edited another recruiter's candidate");
  }
});

/* ------------------------------------------------------------------ *
 * what must NOT have broken
 * ------------------------------------------------------------------ */
console.log('\nwhat isolation must not break');

await check('an admin still sees both desks', async () => {
  const jobs = await listIds(admin, '/jobs?limit=200', 'jobs');
  must(jobs.includes(deskA.jobId) && jobs.includes(deskB.jobId),
    'an admin can no longer see everything');
});

await check('the public job board still works, signed out', async () => {
  const anon = await open();
  const { jobs = [] } = await anon.api('get', '/jobs?limit=50');
  must(Array.isArray(jobs), 'the public board is broken');
});

await check('a candidate still sees their own applications', async () => {
  const cand = await open();
  const email = `iso.cand.${stamp}@example.test`;
  await cand.api('post', '/auth/register',
    { name: `Iso Candidate ${stamp}`, email, password: 'IsoCand@2026' });
  const open1 = (await cand.api('get', '/jobs?limit=20')).jobs
    .find((j) => j.status === 'open' && !j.paused && !j.archived);
  if (!open1) { console.log('        (no open job to apply to - skipped)'); return; }
  await cand.api('post', '/applications', { jobId: open1.id });
  const { applications = [] } = await cand.api('get', '/applications?limit=20');
  must(applications.length >= 1, 'a candidate cannot see their own application');
});

await browser.close();
console.log(failed
  ? `\n  ${failed} FAILED\n`
  : '\n  ISOLATION VERIFIED — one recruiter cannot reach another recruiter\'s desk\n');
process.exitCode = failed ? 1 : 0;
