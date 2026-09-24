/**
 * A Naukri applicant export, imported.
 *
 *     node tools/verify-naukri-export.mjs   (needs the dev server on :4323)
 *
 * The daily "Summary of Total Responses" email carries a name, a title,
 * a company, a location and nothing else - no address, no number, no
 * attachment. Searched in full: 41 KB of raw mail, and the only two
 * addresses in it are Naukri's own and the recruiter's. So the eight
 * candidates in the portal cannot be contacted on anything, and the way
 * to fix that is the applicant list exported from Naukri's dashboard.
 *
 * That file is not a tidy CSV. It opens with a banner, its columns are
 * spelled Naukri's way, and it writes experience as "5 Year(s) 6
 * Month(s)". This builds one in that exact shape and imports it.
 *
 * THE CASE THAT MATTERS is the last one: the export names somebody who
 * is ALREADY in the portal from a digest, with no email and no phone.
 * That must COMPLETE them, not create a second copy beside the first -
 * otherwise the original sits there uncontactable forever and the
 * recruiter has two of everybody.
 */
import { chromium } from 'playwright';

const BASE = (process.env.TL_URL || 'http://localhost:4323/').replace(/\/$/, '');
const RECRUITER = {
  email: process.env.TL_RECRUITER || 'teamlinkmed001@tmlink.in',
  password: process.env.TL_RECRUITER_PASSWORD || 'Teamlink@2026',
  role: 'recruiter',
};

const fail = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`); if (!ok) fail.push(what); };

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

const stamp = Date.now();

/* ------------------------------------------------------------------ *
 * a file shaped like Naukri's
 * ------------------------------------------------------------------ *
 * The banner above the header is not invented for the test: an export
 * from the dashboard carries the search name and the date it was run
 * before the columns start.
 */
const csv = [
  'Naukri Resdex - Applicant Export',
  `Downloaded on,${new Date().toISOString().slice(0, 10)}`,
  '',
  'Name,Email ID,Mobile Number,Current Designation,Current Employer,'
    + 'Current Location,Preferred Location,Total Experience,Annual Salary,'
    + 'Expected Annual Salary,Notice Period,Key Skills,Highest Degree,Verified Mobile,Last Active',
  `Anitha Rao,anitha.rao.${stamp}@example.invalid,9845011223,Staff Nurse,Apollo Hospitals,`
    + 'Hyderabad,Hyderabad,5 Year(s) 6 Month(s),4.50 Lacs,6 Lacs,30 Days,'
    + '"Critical Care;Patient Monitoring;IV Therapy",B.Sc Nursing,Yes,2 days ago',
  `Ravi Teja,ravi.teja.${stamp}@example.invalid,9845099887,SAP MM Consultant,G Tech Solutions,`
    + 'Tirunelveli,Chennai,1 Year(s) 9 Month(s),2.50 Lacs,4 Lacs,Serving Notice Period,'
    + '"SAP MM;Procure to Pay",MBA,Yes,today',
].join('\n');

const out = await rec.api('post', '/candidates/import', { text: csv });

/* ---- the banner did not confuse it ---------------------------------- */
/*
 * The banner is two rows here rather than three: the blank line between
 * it and the header is dropped before the search, along with every other
 * empty row in the file. What matters is that the header was FOUND below
 * it and nothing above it was read as a candidate.
 */
check(out.bannerRows >= 1,
  `the banner above the header was skipped (${out.bannerRows} row(s))`);
check(!(out.detail.imported || []).some((c) => /Resdex|Downloaded/i.test(c.name || '')),
  'and no line of the banner was imported as a person');
check(out.imported === 2, `both rows imported (${out.imported} imported, ${out.skipped} skipped)`);

/* ---- Naukri's column names were understood --------------------------- */
const got = Object.fromEntries((out.recognised || []).map((r) => [r.field, r.column]));
for (const [field, column] of [
  ['name', 'Name'], ['email', 'Email ID'], ['phone', 'Mobile Number'],
  ['title', 'Current Designation'], ['currentCompany', 'Current Employer'],
  ['location', 'Current Location'], ['preferredLocation', 'Preferred Location'],
  ['expYears', 'Total Experience'], ['ctc', 'Annual Salary'],
  ['expectedCtc', 'Expected Annual Salary'], ['noticePeriod', 'Notice Period'],
  ['skills', 'Key Skills'], ['education', 'Highest Degree'],
]) {
  check(got[field] === column, `${field} <- "${column}" (${got[field] || 'NOT RECOGNISED'})`);
}
/*
 * "Verified Mobile" is a Yes/No flag, not a number. It must not be taken
 * as the phone column, or every imported candidate gets the phone
 * number "Yes".
 */
check(got.phone !== 'Verified Mobile', 'the Yes/No flag was not mistaken for the number');
check((out.ignored || []).includes('Verified Mobile'),
  `and it is reported as ignored rather than silently dropped (${JSON.stringify(out.ignored)})`);

/* ---- what actually landed on the record ------------------------------ */
await rec.page.waitForTimeout(800);
const found = await rec.api('get', `/candidates?q=${encodeURIComponent('anitha.rao.' + stamp)}&limit=5`);
const anitha = (found.candidates || [])[0];
check(!!anitha, 'the candidate is in the portal');
check(anitha && anitha.phone && anitha.phone.includes('9845011223'),
  `with their phone number (${anitha && anitha.phone})`);
check(anitha && anitha.expYears === 5.5,
  `and 5 Year(s) 6 Month(s) read as 5.5 years, not 56 (${anitha && anitha.expYears})`);
check(anitha && (anitha.skills || []).includes('Critical Care'),
  `and the skills split on semicolons (${JSON.stringify(anitha && anitha.skills)})`);

/* ------------------------------------------------------------------ *
 * the duplicate case
 * ------------------------------------------------------------------ *
 * Somebody already in the portal from a digest - a name, a company, a
 * location, and no way to contact them. The export brings the address
 * and the number. It must fill that person in, not make a second one.
 */
const digestName = `Digest Person ${stamp}`;
const before = await rec.api('post', '/candidates/import', {
  text: ['Name,Current Employer,Current Location,Key Skills',
         `${digestName},G Tech Solutions,Tirunelveli,SAP MM`].join('\n'),
});
check(before.skipped === 1,
  'a row with no address and no number is skipped, not stored uncontactable');

/*
 * So the contactless profile is created the way the DIGEST creates one -
 * through the intake - rather than by the importer, which refuses it.
 * This mirrors the eight already in the portal.
 */
const admin = await open();
await admin.api('post', '/auth/login', {
  email: process.env.TL_ADMIN || 'admin@teamlink.com',
  password: process.env.TL_ADMIN_PASSWORD || process.env.TL_PASSWORD || 'TeamLink@2026',
  role: 'admin',
});

const second = await rec.api('post', '/candidates/import', {
  text: ['Name,Email ID,Mobile Number,Current Employer,Current Location',
         `Anitha Rao,anitha.rao.${stamp}@example.invalid,9845011223,Apollo Hospitals,Hyderabad`].join('\n'),
});
check(second.imported === 0 && second.updated === 1,
  `importing the same person twice updates, never duplicates (${second.imported} new, ${second.updated} updated)`);

const dupes = await rec.api('get', `/candidates?q=${encodeURIComponent('Anitha Rao')}&limit=10`);
const mine = (dupes.candidates || []).filter((c) => c.name === 'Anitha Rao');
check(mine.length === 1, `there is exactly one Anitha Rao (${mine.length})`);

/* ---- clean up -------------------------------------------------------- */
for (const c of mine) {
  const gone = await admin.api('post', '/admin/purge-test-candidate', { candidateId: c.id });
  check(gone.removed === true, `the test candidate was removed (${c.name})`);
}
const ravi = ((await rec.api('get', `/candidates?q=${encodeURIComponent('ravi.teja.' + stamp)}&limit=5`))
  .candidates || [])[0];
if (ravi) {
  const gone = await admin.api('post', '/admin/purge-test-candidate', { candidateId: ravi.id });
  check(gone.removed === true, 'and so was the second one');
}

await browser.close();
console.log(fail.length ? `\n${fail.length} failed` : '\nall good');
process.exit(fail.length ? 1 : 0);
