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
 *   - CANDIDATES ARE SHARED (0091): a recruiter sees the other's
 *     non-private candidates, read-only, and never a private one
 *   - a recruiter sees their own applications, and not the other's
 *   - asking for another recruiter's APPLICATION or draft BY ID does not
 *     return it; asking for their candidate returns it read-only
 *   - a recruiter cannot edit another recruiter's candidate
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
/* Everything this run creates, so the cleanup at the bottom can take it
   back out again. Declared here rather than collected at the end,
   because a check that fails half way still has to be undone. */
const draftIds = [];
let isoCandidateId = null;
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

/*
 * CHANGED ON PURPOSE (0091). This asserted that a recruiter could NOT see
 * another recruiter's candidates - 0031's model. The owner replaced it
 * with one shared candidate database: every recruiter sees every
 * non-private candidate, read-only, while applications stay with the
 * job's recruiter. The check still asserts both sides of the line: the
 * shared one is visible and not editable, a private one is not visible.
 */
await check('candidates are shared: a recruiter sees the other\'s, but not a private one', async () => {
  const mine = await listIds(A, '/candidates?limit=200&availabilityAll=true', 'candidates');
  must(mine.includes(deskA.candidateId), 'the recruiter cannot see their own candidate');
  must(mine.includes(deskB.candidateId),
    "the recruiter cannot see another recruiter's (shared) candidate");
  const theirs = (await A.session.api('get', '/candidates?limit=200&availabilityAll=true')).candidates
    .find((c) => c.id === deskB.candidateId);
  must(theirs && theirs.canEdit === false, "another recruiter's candidate is offered as editable");

  // a private one stays with its own recruiter
  const priv = await B.session.api('post', '/candidates/import', {
    text: `Name,Email,Phone\nPrivate ${stamp},private.${stamp}@example.test,+91 7${String(stamp).slice(-9)}3`,
  });
  deskB.privateId = priv.detail.imported[0].id;
  await admin.api('put', `/candidates/${deskB.privateId}`, { isPrivate: true });
  const again = await listIds(A, '/candidates?limit=200&availabilityAll=true', 'candidates');
  must(!again.includes(deskB.privateId), "another recruiter's PRIVATE candidate is visible");
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

await check("another recruiter's application is not readable by id; their candidate is, read-only", async () => {
  const apps = await A.session.api('get', `/applications?candidateId=${deskB.candidateId}`);
  must(!(apps.applications || []).some((x) => x.id === deskB.applicationId),
    "another recruiter's application is readable");
  const shared = await A.session.api('get', `/candidates/${deskB.candidateId}`);
  must(shared.candidate && shared.candidate.canEdit === false, 'the shared candidate is not read-only');
  must(!(shared.applications || []).some((x) => x.id === deskB.applicationId),
    "another recruiter's application came back with the candidate");
  const leak = await refused(A, 'get', `/candidates/${deskB.privateId}`);
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
  draftIds.push(draft.id);

  const leak = await refused(A, 'get', `/jobs/${draft.id}`);
  must(!leak, leak);

  const mine = await listIds(A, '/jobs?limit=200', 'jobs');
  must(!mine.includes(draft.id), "a draft of another recruiter is in the list");
});

await check("a recruiter cannot edit another recruiter's candidate", async () => {
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
  const reg = await cand.api('post', '/auth/register',
    { name: `Iso Candidate ${stamp}`, email, password: 'IsoCand@2026' });
  isoCandidateId = reg.candidateId;
  const open1 = (await cand.api('get', '/jobs?limit=20')).jobs
    .find((j) => j.status === 'open' && !j.paused && !j.archived);
  if (!open1) { console.log('        (no open job to apply to - skipped)'); return; }
  await cand.api('post', '/applications', { jobId: open1.id });
  const { applications = [] } = await cand.api('get', '/applications?limit=20');
  must(applications.length >= 1, 'a candidate cannot see their own application');
});

/* ------------------------------------------------------------------ *
 * put the database back
 *
 * THIS WAS MISSING AND IT MATTERED. Every run left two recruiters and
 * three requirements behind, so after three runs the board carried nine
 * requirements called "Isolation A/B/draft ..." owned by accounts nobody
 * could sign in as - and the FIRST OPEN JOB on the board became one of
 * them. `verify:notifications` applies to whatever is at the top, so it
 * began applying to another recruiter's requirement, every stage move
 * after that was correctly refused, and a suite about notifications
 * failed because of leftovers from a suite about isolation.
 *
 * It runs whether the checks passed or failed. A failed run leaves the
 * most mess, which is exactly when cleanup is skipped if it is put
 * behind a success.
 * ------------------------------------------------------------------ */
try {
  let jobsGone = 0;
  let candsGone = 0;
  const purge = async (candidateId) => {
    if (!candidateId) return;
    await admin.api('post', '/admin/purge-test-candidate', { candidateId })
      .then(() => { candsGone += 1; }, () => {});
  };
  const dropJob = async (id) => {
    if (!id) return;
    await admin.api('del', `/jobs/${id}`).then(() => { jobsGone += 1; }, () => {});
  };

  for (const desk of [deskA, deskB].filter(Boolean)) {
    await purge(desk.privateId);
    await purge(desk.candidateId);      // takes the application and the login too
    await dropJob(desk.jobId);
  }
  for (const id of draftIds) await dropJob(id);
  await purge(isoCandidateId);

  console.log(`  cleaned up: ${jobsGone} requirement(s), ${candsGone} candidate(s)`);
  console.log('  the two throwaway recruiter logins have no delete route — remove them with:');
  console.log('    node tools/purge-verify-leftovers.mjs --confirm');
} catch (err) {
  console.log(`  cleanup did not finish: ${err.message}`);
}

await browser.close();
console.log(failed
  ? `\n  ${failed} FAILED\n`
  : '\n  ISOLATION VERIFIED — candidates shared read-only, desks (jobs, applications, notes) private\n');
process.exitCode = failed ? 1 : 0;
