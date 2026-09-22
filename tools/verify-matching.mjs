/**
 * Job alerts: the right people, and nobody else.
 *
 * The rule this exists to hold: ONE KEYWORD IS NOT A MATCH. A candidate
 * with "Java" on their profile must not be messaged about every Java job
 * — that is how an alert system teaches its audience to ignore it.
 *
 * Two halves:
 *
 *  1. THE ENGINE, called directly with profiles built to be one thing
 *     each: the perfect fit, the one-keyword impostor, the wrong city,
 *     the fresher, the over-qualified. A scoring rule is only testable
 *     against inputs designed to isolate it.
 *
 *  2. THE LIVE PATH, through HTTP: publish a real requirement, and check
 *     the database ends up with a scored row per candidate, messages on
 *     three channels for the matches, and a record of the click and the
 *     application that followed.
 *
 *   node tools/verify-matching.mjs      (needs npm run dev on :4323)
 */
import { chromium } from 'playwright';
import { matchCandidate, matchJob } from '../api/src/ai/match.js';

const BASE = (process.env.TL_URL || 'http://localhost:4323/').replace(/\/$/, '');
const PASSWORD = process.env.TL_PASSWORD || 'TeamLink@2026';

let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  PASS  ${name}`); }
  catch (e) { console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n')[0]}`); failed++; }
};
const must = (c, m) => { if (!c) throw new Error(m); };

/* ------------------------------------------------------------------ *
 * 1. the engine
 * ------------------------------------------------------------------ */
console.log('\nthe matching rule');

// The example from the specification, exactly as written.
const JOB = {
  id: 'j_test', title: 'Java Developer', location: 'Hyderabad', mode: 'Hybrid',
  exp: '3-5 yrs', skills: ['Java', 'Spring Boot', 'SQL'],
  education: '', salaryMax: 1800000,
};

const ARJUN = {
  id: 'c_arjun', name: 'Arjun', title: 'Java Developer', location: 'Hyderabad',
  expYears: 4, skills: ['Java', 'Spring Boot', 'SQL'], technicalSkills: [],
  preferredRole: 'Java Developer', expectedCtc: 1500000, noticePeriod: '30 days',
};

await check('the specification example is a match', () => {
  const m = matchCandidate(JOB, ARJUN);
  must(m.notify, `Arjun was not matched: ${m.reason}`);
  must(m.score >= 80, `Arjun scored only ${m.score}`);
  must(m.matchedSkills.length === 3, `matched ${JSON.stringify(m.matchedSkills)}`);
});

await check('ONE KEYWORD IS NOT A MATCH', () => {
  // A front-end developer who once touched Java. The word is there; the
  // job is not theirs.
  const m = matchCandidate(JOB, {
    id: 'c_ui', name: 'Front End', title: 'Frontend Developer', location: 'Hyderabad',
    expYears: 4, skills: ['Java', 'React', 'CSS', 'HTML', 'Figma'],
    preferredRole: 'UI Developer',
  });
  must(!m.notify, `a one-skill profile was alerted (score ${m.score})`);
  must(/1 of 3|skills/.test(m.reason), `unexpected reason: ${m.reason}`);
});

await check('the right skills in the wrong city is not a match', () => {
  const m = matchCandidate(JOB, {
    ...ARJUN, id: 'c_far', location: 'Chennai', preferredLocation: 'Chennai',
  });
  must(!m.notify, `a Chennai candidate was alerted for a Hyderabad role (score ${m.score})`);
});

await check('a remote role reaches candidates anywhere', () => {
  const m = matchCandidate({ ...JOB, mode: 'Remote' }, {
    ...ARJUN, id: 'c_remote', location: 'Chennai', preferredLocation: 'Chennai',
  });
  must(m.notify, `a remote role did not reach a remote candidate: ${m.reason}`);
});

await check('a fresher is not sent a 3-5 year role', () => {
  const m = matchCandidate(JOB, { ...ARJUN, id: 'c_new', expYears: 0.5 });
  must(!m.notify, `a fresher was alerted (score ${m.score})`);
});

await check('a year either side of the band still counts', () => {
  const near = matchCandidate(JOB, { ...ARJUN, id: 'c_near', expYears: 5.5 });
  must(near.notify, `a 5.5-year candidate was not alerted for a 3-5 year role: ${near.reason}`);
  const far = matchCandidate(JOB, { ...ARJUN, id: 'c_far2', expYears: 12 });
  must(!far.notify, '12 years was alerted for a 3-5 year role');
});

await check('a different kind of role is not a match on skills alone', () => {
  const m = matchCandidate(JOB, {
    id: 'c_ops', name: 'Ops', title: 'DevOps Engineer', preferredRole: 'Site Reliability Engineer',
    location: 'Hyderabad', expYears: 4,
    skills: ['Java', 'Spring Boot', 'SQL', 'Kubernetes', 'Terraform'],
  });
  must(!m.notify, `a DevOps engineer was alerted for a Java Developer role (score ${m.score})`);
});

await check('the same skill written differently still matches', () => {
  const m = matchCandidate(
    { ...JOB, skills: ['Java', 'SpringBoot', 'SQL'] },
    { ...ARJUN, id: 'c_alias', skills: ['java', 'Spring-Boot', 'sql'] });
  must(m.notify, `an aliased skill list did not match: ${m.reason}`);
});

await check('salary far above the band costs the candidate points, not the alert', () => {
  const rich = matchCandidate(JOB, { ...ARJUN, id: 'c_rich', expectedCtc: 4000000 });
  const fair = matchCandidate(JOB, { ...ARJUN, id: 'c_fair', expectedCtc: 1500000 });
  must(rich.score < fair.score, 'an unrealistic expectation scored the same as a realistic one');
});

await check('every decision carries its evidence', () => {
  const m = matchCandidate(JOB, ARJUN);
  for (const dim of ['skills', 'experience', 'role', 'location', 'education', 'preferences']) {
    must(m.breakdown[dim], `no breakdown for ${dim}`);
    must(typeof m.breakdown[dim].score === 'number', `${dim} has no score`);
  }
  must(m.breakdown.experience.band.min === 3 && m.breakdown.experience.band.max === 5,
    `the experience band was read as ${JSON.stringify(m.breakdown.experience.band)}`);
  must(m.reason && m.reason.length > 10, 'the match has no reason a human can read');
});

await check('a list is scored best first, and most people are not matched', () => {
  const people = [
    ARJUN,
    { ...ARJUN, id: 'c2', expYears: 4.5 },
    { id: 'c3', name: 'Tester', title: 'QA Engineer', location: 'Pune', expYears: 8,
      skills: ['Selenium', 'Java'] },
    { id: 'c4', name: 'Designer', title: 'UX Designer', location: 'Hyderabad', expYears: 3,
      skills: ['Figma', 'Sketch'] },
  ];
  const out = matchJob(JOB, people);
  must(out.considered === 4, `considered ${out.considered}`);
  must(out.notified === 2, `notified ${out.notified} of 4`);
  must(out.matches[0].score >= out.matches[3].score, 'the list is not sorted by score');
});

/* ------------------------------------------------------------------ *
 * 2. the live path
 * ------------------------------------------------------------------ */
console.log('\npublishing a real requirement');

const browser = await chromium.launch();

async function open() {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.TL && window.TL.ready === true, { timeout: 25000 });
  const api = (m, p, b) => page.evaluate(([mm, pp, bb]) => window.TL.api[mm](pp, bb), [m, p, b]);
  return { ctx, page, api };
}

/**
 * Wait for the background matching run to finish.
 *
 * Alerts are dispatched off the request on purpose, so "publish then
 * read" is a race — and one that gets worse, not better, when a real mail
 * server is configured and each message takes a moment. Polling until the
 * row count stops moving tests the same thing without inventing a delay
 * that will be wrong on somebody else's machine.
 */
async function settle(api, jobId, { timeout = 60000 } = {}) {
  const until = Date.now() + timeout;
  let last = -1, stable = 0;
  while (Date.now() < until) {
    const rows = await api('get', `/job-matches?jobId=${encodeURIComponent(jobId)}`);
    const n = rows.jobMatches.length;
    stable = (n === last && n > 0) ? stable + 1 : 0;
    last = n;
    if (stable >= 2) return rows.jobMatches;
    await new Promise((r) => setTimeout(r, 1200));
  }
  throw new Error(`the matching run for ${jobId} never settled (${last} rows)`);
}

const stamp = Date.now();
const recruiter = await open();
const candidate = await open();
const bystander = await open();

let jobId, matchId, candidateId, bystanderId;

await check('a candidate with a real profile exists to be matched', async () => {
  const reg = await candidate.api('post', '/auth/register', {
    name: 'Arjun Matcher', email: `match.${stamp}@example.test`, password: 'Matcher@2026',
  });
  candidateId = reg.candidateId;
  must(candidateId, 'registration returned no candidate');

  await candidate.api('put', `/candidates/${candidateId}`, {
    title: 'Java Developer', location: 'Hyderabad', expYears: 4, exp: '4 yrs',
    skills: ['Java', 'Spring Boot', 'SQL'],
    technicalSkills: ['Java', 'Spring Boot', 'SQL'],
    preferredRole: 'Java Developer', phone: '+91 90000 11111',
    noticePeriod: '30 days',
  });

  // ...and somebody who merely has the word Java on their profile.
  const other = await bystander.api('post', '/auth/register', {
    name: 'Meera Frontend', email: `bystander.${stamp}@example.test`, password: 'Bystand@2026',
  });
  bystanderId = other.candidateId;
  await bystander.api('put', `/candidates/${bystanderId}`, {
    title: 'Frontend Developer', location: 'Hyderabad', expYears: 4, exp: '4 yrs',
    skills: ['Java', 'React', 'CSS'], technicalSkills: ['React', 'CSS'],
    preferredRole: 'UI Developer', phone: '+91 90000 22222',
  });
});

await check('publishing a requirement matches the profiles already in the database', async () => {
  await recruiter.api('post', '/auth/login',
    { email: 'recruiter@teamlink.com', password: PASSWORD, role: 'recruiter' });
  // Read the recruiter's own company from the SERVER: before this the
  // page holds the public bootstrap, whose demo rows point at companies
  // this database may not have.
  await recruiter.page.evaluate(() => window.TL.refresh());
  await recruiter.page.waitForTimeout(800);

  const companyId = await recruiter.page.evaluate(() => {
    const rec = (DATA.recruiters || []).find((r) => r.email === 'recruiter@teamlink.com');
    return rec ? rec.companyId : (DATA.companies[0] || {}).id;
  });
  must(companyId, 'the recruiter has no company to post against');

  const created = await recruiter.api('post', '/jobs', {
    // The title and description carry the run's stamp so repeated runs do
    // not fill the database with identical postings - two jobs that ARE
    // identical should produce the same interview, and a test elsewhere
    // rightly asserts that two different jobs do not.
    title: `Java Developer ${stamp}`, companyId, location: 'Hyderabad', mode: 'Hybrid',
    exp: '3-5 yrs', pay: 'Rs 12-18 LPA', salaryMin: 1200000, salaryMax: 1800000,
    skills: ['Java', 'Spring Boot', 'SQL'],
    desc: `Building and maintaining Spring Boot services against SQL databases (${stamp}).`,
    status: 'open', type: 'Full-time',
  });
  jobId = created.job.id;
  must(jobId, 'no job was created');
  must(created.alerting, 'publishing did not start the alerts');

  const settled = await settle(recruiter.api, jobId);
  const mine = settled.find((m) => m.candidateId === candidateId);
  must(mine, 'the matching candidate has no match row');
  matchId = mine.id;

  must(mine.score >= 70, `the matching candidate scored only ${mine.score}`);
  must(mine.matchedSkills.length === 3,
    `matched skills were ${JSON.stringify(mine.matchedSkills)}`);

  // An ATTEMPT on every channel is the requirement. Whether a message
  // left the building depends on whether this deployment has providers,
  // and a test that demanded `sent` would only be testing the .env file.
  const tried = Object.values(mine.channels).filter(Boolean);
  must(tried.length === 3,
    `only ${tried.length} channels were attempted: ${JSON.stringify(mine.channels)}`);
});

await check('the one-keyword profile is scored and NOT notified', async () => {
  const rows = await recruiter.api('get', `/job-matches?jobId=${encodeURIComponent(jobId)}`);
  const them = rows.jobMatches.find((m) => m.candidateId === bystanderId);
  must(them, 'the non-matching candidate has no row at all — nothing can explain the decision');
  must(!them.notified, `a one-keyword profile was notified (score ${them.score})`);
  must(them.reason, 'no reason was recorded for not contacting them');
  must(!them.channels.email, `a message was sent anyway: ${JSON.stringify(them.channels)}`);
});

await check('every channel was attempted and its outcome recorded', async () => {
  const rows = await recruiter.api('get', `/job-matches?jobId=${encodeURIComponent(jobId)}`);
  const mine = rows.jobMatches.find((m) => m.candidateId === candidateId);
  const ok = ['sent', 'delivered', 'read', 'failed', 'not_configured', 'skipped_no_address'];
  const reached = ['sent', 'delivered', 'read'];
  for (const ch of ['email', 'sms', 'whatsapp']) {
    must(mine.channels[ch], `${ch} was never attempted`);
    must(ok.includes(mine.channels[ch]), `${ch} recorded "${mine.channels[ch]}"`);
  }

  // `notified` must mean "a message actually left", not "we tried". An
  // unconfigured channel that flipped this flag would make the ATS report
  // contacts that never happened - and would stop the alert being sent
  // for real once credentials were added.
  const anySent = Object.values(mine.channels).some((s) => reached.includes(s));
  must(mine.notified === anySent,
    `notified=${mine.notified} with channels ${JSON.stringify(mine.channels)}`);
  must(!!mine.notifiedAt === anySent,
    anySent ? 'no time was recorded for the notification'
            : 'a notification time was recorded although nothing was sent');
  if (!anySent) {
    console.log('        (no providers configured here - every channel recorded ' +
                'its outcome, which is the checkable part)');
  }
});

await check('the alert names the job, the location and the skills that matched', async () => {
  const { buildEventMessages } = await import('../api/src/notify/templates.js');
  const m = buildEventMessages('JOB_MATCH_ALERT', {
    candidateName: 'Arjun', jobTitle: 'Java Developer', company: 'TechNova',
    jobId: 'j1', location: 'Hyderabad', expLabel: '3-5 yrs',
    matchedSkills: ['java', 'spring boot', 'sql'],
    portalUrl: `${BASE}/?alert=jm_1#/job/j1`,
    smsLead: 'New job matching your profile: Java Developer - Hyderabad. View & apply:',
  });
  must(/Java Developer/.test(m.email.text), 'the email does not name the role');
  must(/Hyderabad/.test(m.email.text), 'the email does not name the location');
  must(/java/i.test(m.email.text) && /matched you on/i.test(m.email.text),
    'the email does not say why they were contacted');
  must(m.sms.length <= 320, `the SMS is ${m.sms.length} characters`);
  must(/Java Developer/.test(m.sms) && /alert=/.test(m.sms), `the SMS is wrong: ${m.sms}`);
  must(/Java Developer/.test(m.whatsapp) && /Hyderabad/.test(m.whatsapp),
    'the WhatsApp message is missing the role or location');
});

await check('opening the job from the alert is recorded', async () => {
  const visitor = await browser.newContext();
  const page = await visitor.newPage();
  try {
    await page.goto(`${BASE}/?alert=${encodeURIComponent(matchId)}#/job/${jobId}`,
      { waitUntil: 'load' });
    await page.waitForFunction(() => window.TL && window.TL.ready === true, { timeout: 25000 });
    await page.waitForTimeout(1500);

    const rows = await recruiter.api('get', `/job-matches?jobId=${encodeURIComponent(jobId)}`);
    const mine = rows.jobMatches.find((m) => m.candidateId === candidateId);
    must(mine.clicked, 'the click was not recorded');
    must(mine.clickedAt, 'no time was recorded for the click');
  } finally { await visitor.close(); }
});

await check('applying from the alert closes the loop, and keeps the source', async () => {
  await candidate.page.goto(`${BASE}/?alert=${encodeURIComponent(matchId)}#/job/${jobId}`,
    { waitUntil: 'load' });
  await candidate.page.waitForFunction(() => window.TL && window.TL.ready === true, { timeout: 25000 });
  await candidate.page.waitForTimeout(1200);

  await candidate.page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /apply/i.test(x.textContent));
    if (b) b.click();
  });
  await candidate.page.waitForTimeout(3000);

  const rows = await recruiter.api('get', `/job-matches?jobId=${encodeURIComponent(jobId)}`);
  const mine = rows.jobMatches.find((m) => m.candidateId === candidateId);
  must(mine.applied, 'the application was not recorded against the alert');
  must(mine.applicationId, 'the alert does not name the application it produced');

  const apps = await recruiter.api('get', `/applications?candidateId=${candidateId}`);
  const app = apps.applications.find((a) => a.jobId === jobId);
  must(app, 'no application exists');
  must(app.source === 'job_alert',
    `the application says it came from "${app.source}", not the alert`);
});

await check('re-publishing does not message the same candidate twice', async () => {
  const before = await settle(recruiter.api, jobId);
  const mine0 = before.find((m) => m.candidateId === candidateId);

  await recruiter.api('post', `/jobs/${jobId}/publish`, { publish: true });
  await recruiter.page.waitForTimeout(2000);
  const after = await settle(recruiter.api, jobId);

  const mine1 = after.find((m) => m.candidateId === candidateId);
  must(mine1.notifiedAt === mine0.notifiedAt,
    'the candidate was notified a second time about the same job');
  must(after.length === before.length,
    `${after.length - before.length} duplicate match rows were created`);
});

await check('a candidate can see why they were contacted; a stranger cannot', async () => {
  const mine = await candidate.api('get', `/job-matches?candidateId=${candidateId}`);
  must(mine.jobMatches.length >= 1, 'the candidate cannot see their own alert');
  must(mine.jobMatches.every((m) => m.candidateId === candidateId),
    'a candidate can see alerts belonging to somebody else');

  const theirs = await candidate.api('get', `/job-matches?candidateId=${bystanderId}`);
  must(theirs.jobMatches.length === 0, 'a candidate read another profile’s match rows');
});

await browser.close();
console.log(failed === 0
  ? '\n  JOB ALERTS VERIFIED — matched on six dimensions, never on one keyword, every message recorded\n'
  : `\n  ${failed} check(s) FAILED\n`);
process.exit(failed ? 1 : 0);
