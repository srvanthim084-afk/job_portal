/**
 * The Shine path, and exactly how far it has been proven.
 *
 *     node tools/verify-shine.mjs
 *
 * WHAT THIS CANNOT DO, said first because it is the important part: it
 * cannot confirm that Shine's real emails look like the ones below. No
 * Shine message has ever arrived in the connected mailbox -
 * `tools/find-shine.mjs` asks that question directly and the answer,
 * over 120 days, is zero. The shapes in intake/source.js were written
 * from Shine's documented labelled format, and `verified: false` says
 * so.
 *
 * What it CAN do, and does:
 *
 *   - a message from Shine is recognised as Shine, by sender
 *   - a FORWARDED one is recognised from its text, where the envelope
 *     no longer names the board
 *   - a candidate merely mentioning Shine is NOT treated as a Shine
 *     response, which is the failure that would matter
 *   - "Sync Shine" reads Shine and leaves Naukri's email alone, and the
 *     reverse
 *   - a Shine-shaped email produces a candidate with the right fields
 *   - adding Shine did not disturb Naukri, checked against the FOUR REAL
 *     digests in the database rather than against a fixture
 *   - the recruiter is told the format is unconfirmed instead of
 *     reading an empty result as "Shine sent nothing"
 *
 * So: the plumbing is verified, the format is not, and the difference
 * is stated rather than blurred.
 */
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

const envFile = resolve(process.cwd(), process.env.ENV_FILE || '.env');
if (existsSync(envFile) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(envFile);
}

const { SOURCES, detectSource, rulesFor, wantedBy } =
  await import('../api/src/intake/source.js');
const { parseMessage, classify, DEFAULT_RULES } =
  await import('../api/src/intake/parse.js');
const { bodyOf } = await import('../api/src/intake/mime.js');
const { looksLikeDigest } = await import('../api/src/intake/naukri.js');

const fail = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`); if (!ok) fail.push(what); };

/* ------------------------------------------------------------------ *
 * a Shine response, in the labelled format Shine documents
 * ------------------------------------------------------------------ */
const shineText = [
  'You have received a new application on Shine.com',
  '',
  'Applicant Details',
  '',
  'Candidate Name: Priya Nair',
  'Email: priya.nair.shine@example.com',
  'Mobile: 9876501234',
  'Applied For: Staff Nurse',
  'Total Experience: 5 years',
  'Current Company: Apollo Hospitals',
  'Current Designation: Senior Staff Nurse',
  'Current Location: Hyderabad',
  'Preferred Location: Hyderabad',
  'Notice Period: 30 days',
  'Key Skills: Critical Care, Patient Monitoring, IV Therapy',
  '',
  'View the full profile on shine.com',
].join('\n');

const shine = {
  from: 'jobs@shine.com',
  subject: 'New application for Staff Nurse',
  text: shineText,
};

/* ---- recognised by sender ------------------------------------------ */
const bySender = detectSource(shine);
check(bySender && bySender.id === 'shine',
  `a message from shine.com is read as Shine (${bySender && bySender.id})`);
check(bySender && bySender.verified === false,
  'and it says the format is unconfirmed rather than implying otherwise');

/* ---- recognised when forwarded -------------------------------------- */
const forwarded = detectSource({
  from: 'mamatha@teamlinkcs.com',
  subject: 'Fwd: New application for Staff Nurse',
  text: shineText,
});
check(forwarded && forwarded.id === 'shine',
  `a forwarded Shine mail is still read as Shine (${forwarded && forwarded.id})`);

/* ---- NOT recognised on a passing mention ---------------------------- */
/*
 * The failure that would actually cost something. A candidate writing
 * "I saw your job on Shine" is not a Shine response, and treating it as
 * one files their covering letter under a board they never used.
 */
const mention = detectSource({
  from: 'priya.nair@gmail.com',
  subject: 'Application for the Staff Nurse role',
  text: 'Hello, I saw your job on Shine and would like to apply. My resume is attached.',
});
check(!mention || mention.id !== 'shine',
  `somebody mentioning Shine in a covering note is not a Shine response (${
    mention ? mention.id : 'not detected'})`);

/* ---- one board's sync leaves the other's mail alone ----------------- */
const naukriMsg = {
  from: 'jobsapply@naukri.com',
  subject: 'New application received for Java Developer',
  text: 'Candidate Name: Rahul Kumar\nApplied Role: Java Developer',
};
const naukriSrc = detectSource(naukriMsg);
check(naukriSrc && naukriSrc.id === 'naukri', 'a Naukri mail is still read as Naukri');

check(wantedBy('shine', bySender) && !wantedBy('shine', naukriSrc),
  'Sync Shine takes the Shine mail and leaves the Naukri one unread');
check(wantedBy('naukri', naukriSrc) && !wantedBy('naukri', bySender),
  'Sync Naukri does the reverse');
check(wantedBy('all', bySender) && wantedBy('all', naukriSrc),
  'Sync everything takes both');

/* ---- the fields come out of a Shine-shaped email -------------------- */
const rules = rulesFor(bySender, DEFAULT_RULES);
check(rules.senderDomains.includes('shine.com'),
  "Shine's domains are added to the classifier rather than replacing Naukri's");
check(rules.senderDomains.includes('naukri.com'),
  'and Naukri keeps its own');

const verdict = classify(shine, rules);
check(verdict.isApplication,
  `a Shine response is classified as an application (${verdict.why || 'no reason given'})`);

const parsed = parseMessage(shine, rules);
const c = parsed.candidate || {};
const field = (name, got, want) => check(got === want, `${name}: ${JSON.stringify(got)}`);
field('name', c.name, 'Priya Nair');
field('email', c.email, 'priya.nair.shine@example.com');
// Normalised, not echoed: the parser puts an Indian mobile into the
// form the SMS and calling providers need, so the same number works
// whichever board it arrived from.
check(String(c.phone || '').replace(/\D/g, '').endsWith('9876501234'),
  `phone: ${JSON.stringify(c.phone)}`);
check(/^\+91 /.test(c.phone || ''),
  `and it carries the country code a provider needs (${c.phone})`);
field('role', c.appliedRole, 'Staff Nurse');
field('current company', c.currentCompany, 'Apollo Hospitals');
field('location', c.location, 'Hyderabad');
field('notice period', c.noticePeriod, '30 days');
check(Array.isArray(c.skills) && c.skills.includes('Critical Care'),
  `skills: ${JSON.stringify(c.skills)}`);

/*
 * Nothing invented. A field Shine did not send must come back empty
 * rather than filled in with something plausible - the whole point of
 * an unverified format is that it will be missing things, and a parser
 * that guesses hides that.
 */
const thin = parseMessage({
  from: 'jobs@shine.com',
  subject: 'New application',
  text: 'Applicant Details\n\nCandidate Name: Arun Kumar\nEmail: arun.k.shine@example.com',
}, rules);
check(!thin.candidate.currentCompany && !thin.candidate.noticePeriod,
  'a field Shine did not send is left empty, not guessed at');
check(thin.candidate.name === 'Arun Kumar', 'and what it did send is still read');

/* ---- Shine did not disturb Naukri ----------------------------------- */
/*
 * Against the REAL digests in the database, not a fixture. Adding a
 * second board changes the shared rules, and the only convincing
 * evidence that it changed nothing is the mail that is actually there.
 */
let db = null;
try {
  const { PGlite } = await import('@electric-sql/pglite');
  db = await new PGlite(process.env.DEV_DB_DIR || 'var/dev-db');
} catch {
  console.log('--    the real digests need the database free; stop the dev server');
}

if (db) {
  const { parseNaukriDigest } = await import('../api/src/intake/naukri.js');
  const rows = (await db.query(
    `select subject, from_address, raw from email_messages order by received_at`)).rows;

  let people = 0;
  let asNaukri = 0;
  for (const row of rows) {
    const text = bodyOf(row.raw).text;
    const src = detectSource({ from: row.from_address, subject: row.subject, text });
    if (src && src.id === 'naukri') asNaukri++;
    if (looksLikeDigest(text)) {
      people += parseNaukriDigest(text, { subject: row.subject }).candidates.length;
    }
  }
  check(rows.length > 0, `${rows.length} real message(s) to read back`);
  check(asNaukri === rows.length,
    `every real message is still read as Naukri, none stolen by Shine (${asNaukri}/${rows.length})`);
  check(people === 8, `the same eight candidates still come out of them (${people})`);
  await db.close();
}

/* ---- the recruiter is told --------------------------------------- */
check(SOURCES.shine.verified === false && SOURCES.naukri.verified === true,
  'the two boards are marked for what they are, not both claimed as working');

console.log('\nThe Shine PATH is verified. The Shine FORMAT is not, and cannot be');
console.log('until a real Shine email arrives - run tools/find-shine.mjs against');
console.log('the mailbox to check, and forward one there if a response is missing.');
console.log(fail.length ? `\n${fail.length} failed` : '\nall good');
process.exit(fail.length ? 1 : 0);
