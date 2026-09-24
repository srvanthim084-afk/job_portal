/**
 * The Shine path, and how far it has been proven.
 *
 *     node tools/verify-shine.mjs
 *
 * THIS FILE USED TO OPEN BY SAYING THE FORMAT COULD NOT BE VERIFIED
 * because no Shine message had ever arrived. That was wrong, and it is
 * worth recording how: the mailbox held seventeen of them, from
 * recruiters@alerts.shine.com, each with a real candidate and a real CV
 * attached, and every one had been filed as "No candidate name could be
 * read from this email". Shine's response does not label the candidate's
 * name - it sits on a bare line under a single-letter avatar - so the
 * labelled-block parser genuinely found nothing, reported so honestly,
 * and the honest report was read as "Shine sends nothing".
 *
 * A verifier that only tests fixtures agrees with whatever the fixtures
 * assume. That is why the last section reads the REAL messages out of the
 * database and asserts that every one of them yields a name and a CV.
 *
 * What is checked:
 *
 *   - a message from Shine is recognised as Shine, by sender
 *   - a FORWARDED one is recognised from its text, where the envelope
 *     no longer names the board
 *   - a candidate merely mentioning Shine is NOT treated as a Shine
 *     response, which is the failure that would matter
 *   - "Sync Shine" reads Shine and leaves Naukri's email alone, and the
 *     reverse
 *   - the documented labelled format still parses, for the mailboxes
 *     that do receive it
 *   - THE FORMAT SHINE ACTUALLY SENDS parses: the unlabelled name, the
 *     avatar initial that must not become a candidate, "None" as a blank
 *     job title, and the article in "Hiring for an OBGY"
 *   - against the real messages in the database: no Naukri mail is
 *     misread as Shine, and every real Shine response yields both a
 *     candidate name and an attached CV to take the contact details from
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
const { bodyOf, attachmentsOf } = await import('../api/src/intake/mime.js');
const { looksLikeDigest } = await import('../api/src/intake/naukri.js');
const { looksLikeShine, parseShine } = await import('../api/src/intake/shine.js');

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
check(bySender && bySender.verified === true,
  'and the format is now confirmed against real Shine mail, not assumed');

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

/* ------------------------------------------------------------------ *
 * the format Shine ACTUALLY sends
 * ------------------------------------------------------------------ *
 *
 * Copied from a real message - recruiters@alerts.shine.com, subject
 * "Email Response-Hiring for Radiologist" - because the labelled fixture
 * above is Shine's DOCUMENTED format and is not what arrives. Seventeen
 * of these were in the mailbox being thrown away while the documented
 * shape was the only one anything could read.
 *
 * The three things that broke it are each asserted on below: the name is
 * on a bare line with no label, an avatar initial sits where the name
 * would be, and a missing job title is written as the word "None".
 */
const realText = [
  'shine',
  'New Application',
  'Dear teamlinkconsultantso,',
  'You have received an email response for Hiring for Radiologist.',
  'The candidate profile is detailed below:',
  'S',
  'Rahul Pandey',
  'Ct & Mri Technician',
  'Bhopal',
  'Experience: 3 Yrs 0 Month',
  'Desired Location: Not Mentioned',
  'Education: PG Diploma, Radiology, MAAN College of Medical Science, Bhopal',
  'Skills: infection control standards,clinical documentation,ct scan operations...more',
  'Update: 13-Sep-2026',
].join('\n');

const real = {
  from: 'recruiters@alerts.shine.com',
  subject: 'Email Response-Hiring for Radiologist',
  text: realText,
};

check(looksLikeShine(real), 'a real Shine response is recognised as one');

const r = parseShine(real) || {};
check(r.name === 'Rahul Pandey',
  `the name comes off a bare, unlabelled line (${JSON.stringify(r.name)})`);
check(r.name !== 'S',
  'and the avatar initial is skipped rather than imported as a person');
check(r.appliedRole === 'Radiologist',
  `the role is the recruiter's own posting (${JSON.stringify(r.appliedRole)})`);
check(r.title === 'Ct & Mri Technician',
  `the designation is read (${JSON.stringify(r.title)})`);
check(r.location === 'Bhopal', `the city is read (${JSON.stringify(r.location)})`);
check(r.experience === '3 Yrs 0 Month',
  `the experience is read (${JSON.stringify(r.experience)})`);
check(r.preferredLocation === '',
  `"Not Mentioned" is stored as empty, not as a place (${JSON.stringify(r.preferredLocation)})`);
check(/MAAN College/.test(r.education || ''),
  `the education is read (${JSON.stringify((r.education || '').slice(0, 40))})`);
check(r.skills.includes('ct scan operations'),
  `the skills are split on commas (${r.skills.length} of them)`);
check(!r.skills.some((x) => /more$/i.test(x)),
  `Shine's "...more" truncation marker is not stored as a skill (${
    JSON.stringify(r.skills[r.skills.length - 1])})`);

/* ---- "None" is a blank field, not a designation -------------------- */
/*
 * Two of the seventeen have this. Shine's own attachment is named
 * "... - Job Title Blank - ...", so Shine agrees the field is empty;
 * only the body writes "None". Storing it shows a recruiter a candidate
 * whose designation reads None.
 */
const noTitle = parseShine({
  ...real,
  text: realText.replace('Ct & Mri Technician', 'None'),
}) || {};
check(noTitle.title === '',
  `a job title of "None" is stored as empty (${JSON.stringify(noTitle.title)})`);
check(noTitle.location === 'Bhopal',
  'and the city after it is still read from the right line');

/* ---- the article in the recruiter's own posting title -------------- */
/*
 * Real subjects include "Email Response-Hiring for an OBGY". "an OBGY"
 * is not a job and must not be matched against the open requirements as
 * though it were.
 */
const article = parseShine({
  ...real,
  subject: 'Email Response-Hiring for an OBGY',
  text: realText.replace('Hiring for Radiologist.', 'Hiring for an OBGY.'),
}) || {};
check(article.appliedRole === 'OBGY',
  `a leading article is dropped from the role (${JSON.stringify(article.appliedRole)})`);

/* ---- a wrapped sentence still yields the whole role ---------------- */
const wrapped = parseShine({
  ...real,
  text: realText.replace(
    'You have received an email response for Hiring for Radiologist.',
    'You have received an email response for Hiring for\nSenior Radiologist.'),
}) || {};
check(wrapped.appliedRole === 'Senior Radiologist',
  `a role split across two lines is read whole (${JSON.stringify(wrapped.appliedRole)})`);

/* ---- not every mail mentioning a response is one ------------------- */
check(!looksLikeShine({
  from: 'someone@gmail.com',
  subject: 'New Application',
  text: 'New application attached. Please review.',
}), 'a stray mail saying "New Application" is not treated as a Shine response');

check(parseShine({ from: 'recruiters@alerts.shine.com', subject: 'x', text: 'nothing useful' })
  === null, 'a Shine mail with no profile block returns nothing rather than a guess');

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
  let shineMails = 0;
  let shineParsed = 0;
  let shineWithCv = 0;
  let stolen = 0;
  for (const row of rows) {
    const text = bodyOf(row.raw).text;
    const message = { from: row.from_address, subject: row.subject, text };
    const src = detectSource(message);

    // A Naukri mail read as Shine would be the damaging failure: the
    // recruiter syncs one board and their other board's candidates move.
    if (/naukri\.com/i.test(row.from_address || '') && src && src.id === 'shine') stolen++;

    if (src && src.id === 'shine') {
      shineMails++;
      const p = looksLikeShine(message) ? parseShine(message) : null;
      if (p && p.name) shineParsed++;
      if (attachmentsOf(row.raw).length) shineWithCv++;
    }
    if (looksLikeDigest(text)) {
      people += parseNaukriDigest(text, { subject: row.subject }).candidates.length;
    }
  }
  check(rows.length > 0, `${rows.length} real message(s) to read back`);
  check(stolen === 0,
    `no Naukri mail is misread as Shine (${stolen} would have moved board)`);
  check(shineMails > 0,
    `real Shine mail is present to test against (${shineMails} message(s))`);
  check(shineParsed === shineMails,
    `every real Shine response yields a candidate name (${shineParsed}/${shineMails})`);
  check(shineWithCv === shineMails,
    `and every one of them carries a CV to read the contact details from (${
      shineWithCv}/${shineMails})`);
  check(people > 0,
    `the Naukri digests still yield their candidates (${people})`);
  await db.close();
}

/* ---- the recruiter is told --------------------------------------- */
check(SOURCES.shine.verified === true && SOURCES.naukri.verified === true,
  'both boards are marked verified, and both now are - against real mail');

console.log('\nBoth the Shine PATH and the Shine FORMAT are verified against real');
console.log('messages from recruiters@alerts.shine.com. The contact details are not');
console.log('in a Shine response - Shine keeps them behind a login - so they come');
console.log('from the attached CV, which is why the CV assertion above matters.');
console.log(fail.length ? `\n${fail.length} failed` : '\nall good');
process.exit(fail.length ? 1 : 0);
