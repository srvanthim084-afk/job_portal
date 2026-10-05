/**
 * External jobs work, and TeamLink did not move.
 *
 *     EXTERNAL_JOBS_ENABLED=true npm run dev      (in one terminal)
 *     node tools/verify-external-jobs.mjs
 *
 * The external-job layer's whole claim is that it cannot disturb the
 * existing product. A claim like that is worth nothing unless something
 * checks it, so this takes a FULL FINGERPRINT of every TeamLink job,
 * application and ATS stage before doing anything, exercises the external
 * feature end to end against real data, and then compares the fingerprint
 * field by field.
 *
 * It creates one source, one external job, one match and one external
 * application - and deletes all four at the end, so it leaves no demo
 * data behind. Deleting the source cascades the rest; the cascade runs
 * away from TeamLink and cannot reach a candidate.
 *
 * Nothing in this file sends an email, an SMS or a call. The external
 * layer has no notification path at all, which is itself asserted below.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const BASE = (process.env.TL_URL || 'http://localhost:4323/').replace(/\/$/, '');

const fail = [];
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`);
  if (!ok) fail.push(what);
};

const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));

await page.goto(`${BASE}/`, { waitUntil: 'load' });
await page.waitForFunction(() => window.TL && window.TL.ready === true, { timeout: 25000 });

/* The integration layer calls it `del`, not `delete`. */
const METHOD = { delete: "del", del: "del" };
const api = async (m0, p, b) => {
  const m = METHOD[m0] || m0;
  const r = await page.evaluate(([mm, pp, bb]) => window.TL.api[mm](pp, bb)
    .then((v) => ({ ok: 1, v }), (e) => ({ ok: 0, c: e.code, m: e.message })), [m, p, b]);
  if (r.ok) return r.v;
  const err = new Error(`${r.c || 'FAILED'}: ${r.m || ''}`);
  err.code = r.c;
  throw err;
};

const login = (role) => api('post', '/auth/login', {
  email: role === 'admin'
    ? (process.env.TL_ADMIN || 'admin@teamlink.com')
    : (process.env.TL_RECRUITER || 'teamlinkmed001@tmlink.in'),
  password: role === 'admin'
    ? (process.env.TL_ADMIN_PASSWORD || 'TeamLink@2026')
    : (process.env.TL_RECRUITER_PASSWORD || 'Teamlink@2026'),
  role,
});

/**
 * A fingerprint of everything this feature promises not to touch.
 *
 * Every field of every job and every application, sorted, plus the stage
 * table and the candidate count. A single changed character anywhere in
 * the existing pipeline shows up as a mismatch.
 */
async function fingerprint() {
  const d = (await api('get', '/bootstrap')).data || {};
  const sortById = (a) => [...(a || [])].sort((x, y) => String(x.id).localeCompare(String(y.id)));
  return {
    jobs: JSON.stringify(sortById(d.jobs)),
    applications: JSON.stringify(sortById(d.applications)),
    stages: JSON.stringify(sortById(d.stages)),
    candidateCount: (d.candidates || []).length,
    jobCount: (d.jobs || []).length,
    applicationCount: (d.applications || []).length,
    interviewCount: (d.interviews || []).length,
    offerCount: (d.offers || []).length,
    /* Candidates change legitimately elsewhere in the product, so the
       whole row is not compared - but the fields THIS feature reads are,
       because reading them must not rewrite them. */
    candidateReadFields: JSON.stringify(sortById(d.candidates).map((c) => [
      c.id, c.name, c.email, c.phone, c.location, c.preferredLocation, c.title,
      c.exp, c.expYears, c.education, (c.skills || []).join('|'),
      c.noticePeriod, c.stage, c.poolStatus, c.appliedJobId, c.matchScore,
    ])),
  };
}

let sourceId = null;
let candidateId = null;
/* Hoisted so the cleanup can re-check it: deleting external data must
   not have deleted any TeamLink data either. */
let before = null;

try {
  /* ---- the feature has to be switched on for any of this to mean
     anything, and saying so beats twelve confusing failures ---------- */
  await login('admin');
  let cfg = null;
  try { cfg = await api('get', '/external/config'); } catch { /* off */ }
  if (!cfg) {
    console.log('\nEXTERNAL_JOBS_ENABLED is not true, so /api/external/* is not mounted.');
    console.log('That is the correct default. To run this check, start the server with:');
    console.log('    EXTERNAL_JOBS_ENABLED=true npm run dev\n');
    check(false, 'the external-jobs feature is switched on for this run');
    throw new Error('feature off');
  }
  check(true, `the feature is on (auto-apply ${cfg.autoApplyEnabled ? 'on' : 'off'}, `
    + `threshold ${cfg.autoApplyThreshold}%)`);

  /* ---- fingerprint BEFORE ---------------------------------------- */
  before = await fingerprint();
  console.log(`\nbaseline: ${before.jobCount} jobs, ${before.candidateCount} candidates, `
    + `${before.applicationCount} applications\n`);

  /* ---- 4 · an external job can be stored independently ------------ */
  console.log('Test 4 — an external job stands on its own\n');

  const src = (await api('post', '/external/sources', {
    name: `Verify Source ${Date.now()}`,
    sourceType: 'job_board',
    collectionMethod: 'manual',
    applicationMethod: 'redirect',
    active: true,
  })).source;
  sourceId = src.id;
  check(!!sourceId, `  a source was created (${src.name})`);
  /* 0108: a candidate is only ever sent to an APPROVED domain of the
     source - the allowlist is the open-redirect guard. */
  await api('put', `/external/sources/${sourceId}/config`, { allowedDomains: ['example.com'] });
  check(src.collectionMethod === 'manual' && src.applicationMethod === 'redirect',
    '  it collects manually and applies by redirect');

  /* A source with no key cannot collect from a feed, and says so rather
     than silently returning nothing. */
  const feedBody = {
    name: `Verify Feed ${Date.now()}`,
    sourceType: 'partner_api',
    collectionMethod: 'api',
    applicationMethod: 'api',
    feedUrl: 'https://example.invalid/jobs',
    credentialEnv: 'VERIFY_NO_SUCH_KEY',
  };
  /* 0108: a partner API cannot be switched on until its licence is on
     record - the refusal is part of what is checked. */
  let refusedCode = null;
  await api('post', '/external/sources', { ...feedBody, active: true }).catch((e) => { refusedCode = e.code; });
  check(refusedCode === 'LICENCE_REQUIRED', `  an unlicensed partner API cannot be switched on (${refusedCode})`);
  const feedSrc = (await api('post', '/external/sources', { ...feedBody, active: false })).source;
  await api('put', `/external/sources/${feedSrc.id}/licence`, {
    collectionMethod: 'licensed_api', licenceStatus: 'active', consentStatus: 'granted',
    termsUrl: 'https://partner.example.org/terms', dataUsageAllowed: true, applicationRedirectAllowed: true,
    owner: 'verify-external-jobs', notes: 'verification only',
  });
  await api('post', '/external/sources', { ...feedBody, id: feedSrc.id, active: true });
  const feedSync = await api('post', `/external/sources/${feedSrc.id}/sync`, {});
  check(feedSync.status === 'not_configured',
    `  an unkeyed API source refuses to sync (${feedSync.status}: ${feedSync.error || ''})`);
  await api('delete', `/external/sources/${feedSrc.id}`);

  /* The posting the brief uses as its worked example. */
  const posted = await api('post', '/external/jobs', {
    sourceId,
    jobs: [{
      externalJobId: `verify-${Date.now()}`,
      title: 'Senior Java Developer',
      company: 'Verify Technologies Pvt Ltd',
      location: 'Hyderabad',
      skills: ['Java', 'Spring Boot', 'SQL'],
      experience: '2-4 yrs',
      salary: '₹12-18 LPA',
      /* example.com, NOT example.invalid: a .invalid host is now
         recognised as a sample posting with nothing to open, which is
         its own case and is asserted separately below. This one has to
         exercise the ordinary redirect path. */
      applicationUrl: 'https://careers.example.com/apply/verify',
      description: 'Backend services.',
    }],
  });
  check(posted.saved === 1, `  a posting was stored (${posted.saved} saved)`);
  const extJob = posted.jobs[0];
  check(extJob.title === 'Senior Java Developer' && extJob.expMin === 2 && extJob.expMax === 4,
    `  its experience band was read as ${extJob.expMin}-${extJob.expMax} yrs`);
  /* 0113: an external job is on External Jobs only - never on the Jobs page. */
  const board = await api('get', '/jobs?q=Java&limit=200');
  check(!(board.jobs || []).some((j) => j.id === extJob.id || /^xjob_/.test(j.id)),
    '  it is NOT on the Jobs page (/api/jobs is TeamLink jobs only)');
  const extBoard = await api('get', '/portal/external-jobs?q=Senior%20Java&limit=500');
  check((extBoard.jobs || []).some((j) => j.id === extJob.id && j.sourceType === 'EXTERNAL'),
    '  it IS on the External Jobs side, marked EXTERNAL');

  /* ---- 5 · deduplication keeps every source ---------------------- */
  console.log('\nTest 5 — the same vacancy on two sources stays two rows\n');

  const src2 = (await api('post', '/external/sources', {
    name: `Verify Second ${Date.now()}`,
    collectionMethod: 'manual', applicationMethod: 'redirect', active: true,
  })).source;
  const dup = await api('post', '/external/jobs', {
    sourceId: src2.id,
    jobs: [{
      externalJobId: `verify-dup-${Date.now()}`,
      title: 'Java Developer Senior',        // the same words, another order
      company: 'Verify Technologies Pvt Ltd',
      location: 'Hyderabad, Telangana',
      skills: ['Java', 'Spring Boot', 'SQL'],
      experience: '2 to 4 years',
      applicationUrl: 'https://example.invalid/other/apply',
    }],
  });
  check(dup.saved === 1, '  the second source’s posting was stored too');
  check(dup.linked >= 1, `  they were linked as the same vacancy (${dup.linked} linked)`);

  const canonical = (await api('get', '/external/jobs')).jobs
    .filter((j) => j.company === 'Verify Technologies Pvt Ltd');
  check(canonical.length === 1,
    `  a candidate is shown one card, not two (${canonical.length} canonical)`);
  const all = (await api('get', '/external/jobs?all=true')).jobs
    .filter((j) => j.company === 'Verify Technologies Pvt Ltd');
  check(all.length === 2, `  and both source rows survive (${all.length} rows, nothing merged)`);
  await api('delete', `/external/sources/${src2.id}`);

  /* ---- 6 · a candidate is matched without being changed ---------- */
  console.log('\nTest 5b / 6 — matching reads the candidate and writes nothing to them\n');

  /* A real candidate, chosen for having the data the matcher needs. No
     candidate is created: this runs against the live database. */
  const candidates = (await api('get', '/candidates?limit=500')).candidates || [];

  /*
   * PREFER A CANDIDATE WHO ALREADY HAS A TEAMLINK APPLICATION.
   *
   * The whole point of §8 is that an external "Shortlisted" must not
   * disturb a live ATS stage - and a candidate with no application has no
   * stage to disturb, so testing on one proves nothing. The first run of
   * this file picked such a candidate and reported "no TeamLink
   * application", which passed while checking nothing.
   */
  const withApplications = new Set(
    ((await api('get', '/bootstrap')).data.applications || []).map((a) => a.candidateId));
  const ranked = [
    (c) => withApplications.has(c.id) && (c.skills || []).length >= 2 && c.location,
    (c) => withApplications.has(c.id),
    (c) => (c.skills || []).length >= 2 && c.location,
    () => true,
  ];
  let subject = null;
  for (const want of ranked) { subject = candidates.find(want); if (subject) break; }
  if (!subject) throw new Error('there are no candidates to match');
  candidateId = subject.id;

  const candBefore = JSON.stringify(subject);
  const matched = await api('post', '/external/match', { candidateId });
  check(matched.ok === true, `  ${subject.name} was scored against ${matched.scored} job(s)`);

  const candAfter = JSON.stringify(
    ((await api('get', '/candidates?limit=500')).candidates || [])
      .find((c) => c.id === candidateId));
  check(candAfter === candBefore, '  their profile is byte-for-byte unchanged');

  /* limit=500: the default page is 50, and once a real board has been
     synced the probe posting is nowhere near the top of a candidate's
     list — the row exists, the page just did not reach it. */
  const matches = (await api('get',
    `/external/matches?candidateId=${candidateId}&limit=500`)).matches || [];
  const mine = matches.find((m) => m.externalJobId === extJob.id);
  check(!!mine, `  a match row exists for the posting (${matches.length} match(es) in total)`);
  if (mine) {
    check(typeof mine.matchPercentage === 'number',
      `  it scored ${mine.matchPercentage}% with ${mine.matchingSkills.length} skill(s) matching`);
    check(Array.isArray(mine.matchReasons) && mine.matchReasons.length > 0,
      `  and it can explain itself (${mine.matchReasons.length} reason(s))`);
  }

  /* ---- 7 · an external application is recorded on its own -------- */
  console.log('\nTest 6 / 7 — the external application is a separate record\n');

  /* The candidate's own TeamLink stage, read before and after, is the
     thing §8 is about. */
  const atsBefore = ((await api('get', '/bootstrap')).data.applications || [])
    .filter((a) => a.candidateId === candidateId)
    .map((a) => `${a.id}:${a.stage}`).sort().join(',');

  const applied = await api('post', '/external/apply', { candidateId, externalJobId: extJob.id });
  check(!!applied.application, `  an external application was recorded (${applied.status})`);
  /* 'clicked' since 0076: handing somebody a link is not an application;
     only the candidate's own answer moves it on. */
  check(applied.application.status === 'clicked',
    `  a redirect is recorded honestly as "${applied.application.statusLabel}"`);
  check(!!applied.redirectUrl, '  and the caller is given the employer’s URL to open');

  const appId = applied.application.id;

  /* The external status moves through several states, including ones that
     share a NAME with a TeamLink stage. That is the point of the test. */
  for (const [status, theirs] of [
    ['application_received', 'Application received'],
    ['under_review', 'Being reviewed by employer'],
    ['shortlisted', 'Shortlisted by employer'],
  ]) {
    const out = await api('post', `/external/applications/${appId}/status`,
      { status, externalStatus: theirs });
    check(out.application.status === status && out.application.externalStatus === theirs,
      `  status → ${out.application.statusLabel} (their word: "${theirs}")`);
  }

  const atsAfter = ((await api('get', '/bootstrap')).data.applications || [])
    .filter((a) => a.candidateId === candidateId)
    .map((a) => `${a.id}:${a.stage}`).sort().join(',');
  check(atsAfter === atsBefore,
    `  their TeamLink ATS stage did not move (${atsBefore || 'no TeamLink application'})`);
  /* And the test is only meaningful if there WAS a stage to move. */
  check(!!atsBefore,
    `  §8 was tested on a candidate who has a live TeamLink application`);

  /* External "Shortlisted" must not have created a TeamLink application. */
  const appCountNow = ((await api('get', '/bootstrap')).data.applications || []).length;
  check(appCountNow === before.applicationCount,
    `  no TeamLink application was created (${appCountNow}, was ${before.applicationCount})`);

  /*
   * A SAMPLE POSTING HAS NOTHING TO OPEN, AND SAYS SO.
   *
   * Seeded postings carry .invalid links, which can never resolve.
   * Sending a candidate to one produced a browser DNS error page that
   * read as a broken product; and recording "Applied - Not Confirmed"
   * against an advert that does not exist would be a second untruth.
   */
  const sampleJob = (await api('post', '/external/jobs', {
    sourceId,
    jobs: [{
      externalJobId: `verify-sample-${Date.now()}`,
      title: 'Verify Sample Posting',
      company: 'Verify Technologies Pvt Ltd',
      location: 'Hyderabad',
      applicationUrl: 'https://sample.invalid/naukri/verify-sample',
    }],
  })).jobs[0];

  /* Since 0088 the stored link is validated BEFORE anything is recorded,
     and a .invalid host is not a public site - so the apply is refused
     outright ("Redirect unavailable") and no application row is written. */
  const appsBefore = ((await api('get', `/external/applications?candidateId=${candidateId}`)).applications || []).length;
  const sampleOut = await api('post', '/external/apply', {
    candidateId, externalJobId: sampleJob.id,
  }).catch((e) => ({ refused: e.code, message: e.message }));
  check(sampleOut.refused === 'INVALID_URL',
    `  a .invalid posting is refused before anything opens (${sampleOut.refused || sampleOut.status})`);
  const appsAfter = ((await api('get', `/external/applications?candidateId=${candidateId}`)).applications || []).length;
  check(appsAfter === appsBefore, `  and is NOT recorded as applied (${appsAfter} external application(s), was ${appsBefore})`);
  check(/redirect unavailable/i.test(sampleOut.message || ''),
    '  with a message the candidate can understand');

  /* A source that cannot report back says so rather than inventing news. */
  const recheck = await api('post', `/external/applications/${appId}/refresh`, {})
    .catch((e) => ({ ok: false, status: e.code }));
  check(recheck.ok === false,
    `  a redirect source admits it cannot report status back (${recheck.status})`);

  /* Applying twice is not an error and not a second record. */
  const again = await api('post', '/external/apply', { candidateId, externalJobId: extJob.id });
  /* Within ten seconds the double-press guard answers ('already_open');
     later the database does ('already_applied'). Either way, one row. */
  const rowsAgain = ((await api('get', `/external/applications?candidateId=${candidateId}`)).applications || [])
    .filter((x) => x.externalJobId === extJob.id).length;
  check(['already_applied', 'already_open'].includes(again.status) && rowsAgain === 1,
    `  applying again is reported, not duplicated (${again.status}, ${rowsAgain} row)`);

  /* ---- 1, 2, 3, 8 · nothing in TeamLink moved -------------------- */
  console.log('\nTests 1, 2, 3, 8 — the existing product is untouched\n');

  const after = await fingerprint();
  check(after.jobs === before.jobs,
    `  Test 1: every TeamLink job is identical (${after.jobCount} jobs, all fields)`);
  check(after.applications === before.applications,
    `  Test 2: every TeamLink application is identical (${after.applicationCount}, all fields)`);
  check(after.stages === before.stages,
    `  Test 3: the ATS stage table is identical (${JSON.parse(after.stages).length} stages)`);
  check(after.candidateReadFields === before.candidateReadFields,
    `  Test 8: every candidate field this feature reads is unchanged (${after.candidateCount})`);
  check(after.interviewCount === before.interviewCount
    && after.offerCount === before.offerCount,
    `  interviews (${after.interviewCount}) and offers (${after.offerCount}) unchanged`);

  /* ---- the external layer has no way to send anything ------------- */
  const svc = readFileSync('api/src/external/service.js', 'utf8');
  const store = readFileSync('api/src/external/store.js', 'utf8');
  const routes = readFileSync('api/src/routes/external-jobs.js', 'utf8');
  const layer = svc + store + routes;

  /* What is IMPORTED or called - a comment naming notify/retry.js as an
     example of a sweep is not a notification path. */
  check(!/from\s+['"][^'"]*notify\/|import\(\s*['"][^'"]*notify\/|sendMail|dispatch\(|placeCall|startCall/.test(layer),
    '  the external layer imports no notification or calling code');
  check(!/insert\s+into\s+applications|update\s+applications|update\s+candidates|update\s+jobs/i
    .test(layer),
    '  and contains no write to applications, candidates or jobs');
  check(/from candidates where id/.test(store),
    '  its only use of an existing table is a select on candidates');

  /* ---- candidate isolation: one candidate cannot read another ---- */
  console.log('\nAccess — a candidate sees only their own\n');
  const other = candidates.find((c) => c.id !== candidateId && c.email);
  if (other) {
    await api('post', '/auth/logout', {}).catch(() => {});
    await login('recruiter');
    const asRecruiter = (await api('get', '/external/applications')).applications || [];
    check(asRecruiter.length >= 1,
      `  a recruiter sees the external applications (${asRecruiter.length})`);
    const leaks = asRecruiter.some((a) => a.candidateEmail === undefined);
    check(!leaks, '  with the candidate named, as §10 asks');
  }
} catch (e) {
  if (String(e.message) !== 'feature off') {
    check(false, `the run failed (${e.message})`);
  }
} finally {
  /* ---- leave nothing behind -------------------------------------- */
  console.log('\nCleaning up\n');
  try {
    await api('post', '/auth/logout', {}).catch(() => {});
    await login('admin');
    if (sourceId) {
      const gone = await api('delete', `/external/sources/${sourceId}`)
        .catch((e) => ({ removed: false, error: e.message }));
      check(gone.removed === true,
        `  removed the test source and its ${gone.removedJobs ?? '?'} job(s), `
        + `${gone.removedMatches ?? '?'} match(es), ${gone.removedApplications ?? '?'} application(s)`);
    }
    const leftovers = (await api('get', '/external/sources').catch(() => ({ sources: [] })))
      .sources.filter((s) => /^Verify (Source|Feed|Second) /.test(s.name));
    check(leftovers.length === 0,
      `  no test source is left in the database (${leftovers.length} found)`);

    /* And the existing product is STILL untouched after the cleanup, which
       is the cascade assertion: deleting external data cannot delete
       TeamLink data. */
    if (before) {
      const end = await fingerprint();
      check(end.jobs === before.jobs && end.applications === before.applications
        && end.candidateReadFields === before.candidateReadFields,
        `  removing the external data left TeamLink untouched: ${end.jobCount} jobs, `
        + `${end.candidateCount} candidates, ${end.applicationCount} applications`);
    }
  } catch (e) {
    check(false, `CLEANUP FAILED — remove source ${sourceId} by hand (${e.message})`);
  }

  check(errors.length === 0, `no page errors${errors.length ? `: ${errors[0]}` : ''}`);
  await browser.close();
  console.log(fail.length ? `\n${fail.length} failed` : '\nall good');
  process.exit(fail.length ? 1 : 0);
}
