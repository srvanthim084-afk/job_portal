/**
 * Resumes added separately, matched to the candidates they belong to.
 *
 *     node tools/verify-resume-match.mjs   (needs the dev server on :4323)
 *
 * A job board's summary email carries a name, a title, a company and a
 * location - no CV. The CVs arrive separately, and without this somebody
 * opens each one, works out who it is, finds them in the portal and
 * attaches it. For eighty-seven candidates that is a day's work.
 *
 * THE ORDER OF THE MATCH IS THE WHOLE DESIGN, because a CV attached to
 * the wrong person is the document that gets sent to a client. Address,
 * then number, then name WITH the company or the city and only against
 * somebody the portal cannot otherwise identify. Never name alone.
 *
 * So the refusals are tested as hard as the matches.
 */
import { chromium } from 'playwright';

const BASE = (process.env.TL_URL || 'http://localhost:4323/').replace(/\/$/, '');
const fail = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`); if (!ok) fail.push(what); };

const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
await page.goto(`${BASE}/`, { waitUntil: 'load' });
await page.waitForFunction(() => window.TL && window.TL.ready === true, { timeout: 25000 });
await page.evaluate((l) => window.TL.api.post('/auth/login', l), {
  email: process.env.TL_RECRUITER || 'teamlinkmed001@tmlink.in',
  password: process.env.TL_RECRUITER_PASSWORD || 'Teamlink@2026',
  role: 'recruiter',
});
const api = async (m, p, b) => {
  const r = await page.evaluate(([mm, pp, bb]) => window.TL.api[mm](pp, bb)
    .then((v) => ({ ok: 1, v }), (e) => ({ ok: 0, m: e.message })), [m, p, b]);
  if (!r.ok) throw new Error(r.m);
  return r.v;
};

const stamp = Date.now();
const admin = await (await browser.newContext()).newPage();
await admin.goto(`${BASE}/`, { waitUntil: 'load' });
await admin.waitForFunction(() => window.TL && window.TL.ready === true, { timeout: 25000 });
await admin.evaluate((l) => window.TL.api.post('/auth/login', l), {
  email: process.env.TL_ADMIN || 'admin@teamlink.com',
  password: process.env.TL_ADMIN_PASSWORD || process.env.TL_PASSWORD || 'TeamLink@2026',
  role: 'admin',
});

/* Candidates to match against, created the way the import creates them. */
const withEmail = `byemail.${stamp}@example.invalid`;
const csv = [
  'Name,Email ID,Mobile Number,Current Employer,Current Location',
  `Anita Byemail ${stamp},${withEmail},9845012345,Apollo Hospitals,Hyderabad`,
  `Ravi Byphone ${stamp},byphone.${stamp}@example.invalid,9845099999,G Tech,Chennai`,
].join('\n');
await api('post', '/candidates/import', { text: csv });
await page.waitForTimeout(600);

const send = async (files) => page.evaluate(async (list) => {
  const fd = new FormData();
  for (const f of list) {
    const bin = atob(f.b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    fd.append('resumes', new File([bytes], f.name, { type: 'text/plain' }));
  }
  return window.TL.api.post('/candidates/resumes/match', fd)
    .then((v) => v, (e) => ({ error: e.message }));
}, files);

const cv = (lines) => Buffer.from(lines.join('\n'), 'utf8').toString('base64');

const out = await send([
  { name: 'anita.txt', b64: cv([
    `Anita Byemail ${stamp}`, 'Senior Staff Nurse', `Email: ${withEmail}`,
    'Mobile: 9845012345', 'KEY SKILLS', 'Critical Care, Patient Monitoring',
    'EXPERIENCE', 'Apollo Hospitals - Senior Staff Nurse (2019 - Present)',
    'Total Experience: 6 years', 'Current Location: Hyderabad']) },
  { name: 'ravi.txt', b64: cv([
    `Ravi Byphone ${stamp}`, 'SAP MM Consultant', 'Mobile: +91 98450 99999',
    'KEY SKILLS', 'SAP MM, Procure to Pay', 'Current Location: Chennai']) },
  { name: 'stranger.txt', b64: cv([
    'Someone Entirely Unknown', 'Data Analyst', 'Email: nobody.here@example.invalid',
    'KEY SKILLS', 'SQL, Power BI']) },
  { name: 'unreadable.txt', b64: Buffer.from('', 'utf8').toString('base64') },
]);

check(!out.error, `the batch was accepted (${out.error || 'ok'})`);
check(out.files === 4, `all four files were read (${out.files})`);
check(out.matched === 2, `two matched (${out.matched})`);
if (out.matched !== 2) {
  console.log('      unmatched detail:', JSON.stringify(out.detail.unmatched));
  console.log('      refused detail  :', JSON.stringify(out.detail.refused));
  const all = await api('get', `/candidates?q=${encodeURIComponent('Byphone')}&limit=5`);
  console.log('      candidate row   :', JSON.stringify((all.candidates||[]).map(c => ({n:c.name, e:c.email, p:c.phone}))));
}

const byFile = Object.fromEntries((out.detail.matched || []).map((m) => [m.file, m]));
check(byFile['anita.txt'] && byFile['anita.txt'].matchedBy === 'email address',
  `the address matched Anita (${byFile['anita.txt'] && byFile['anita.txt'].matchedBy})`);
check(byFile['ravi.txt'] && byFile['ravi.txt'].matchedBy === 'phone number',
  `"+91 98450 99999" matched Ravi on the number (${byFile['ravi.txt'] && byFile['ravi.txt'].matchedBy})`);
check(byFile['anita.txt'] && byFile['anita.txt'].rescreened !== undefined,
  'and the score was worked out again now there is a CV');

const stranger = (out.detail.unmatched || []).find((u) => u.file === 'stranger.txt');
check(!!stranger, 'a resume for nobody in the portal is NOT attached to a guess');
check(stranger && stranger.read && /Unknown/i.test(String(stranger.read.name || '')),
  `and it reports what it read, so a person can place it (${stranger && stranger.read && stranger.read.name})`);

check(out.refused + out.unmatched === 2,
  `the empty file was refused or unmatched, never attached (${out.refused} refused, ${out.unmatched} unmatched)`);

/* The resume really is on the candidate, not merely reported. */
const found = await api('get', `/candidates?q=${encodeURIComponent(withEmail)}&limit=5`);
const anita = (found.candidates || [])[0];
check(anita && anita.resumeFile, `the CV is on the candidate's record (${anita && anita.resumeFile})`);
check(anita && (anita.skills || []).includes('Critical Care'),
  `and what it says reached the profile (${JSON.stringify(anita && anita.skills)})`);

/* ---- clean up -------------------------------------------------------- */
for (const q of [withEmail, `byphone.${stamp}@example.invalid`]) {
  const c = ((await api('get', `/candidates?q=${encodeURIComponent(q)}&limit=5`)).candidates || [])[0];
  if (!c) continue;
  const gone = await admin.evaluate((id) => window.TL.api.post('/admin/purge-test-candidate',
    { candidateId: id }).then((v) => v, (e) => ({ error: e.message })), c.id);
  check(gone.removed === true, `the test candidate was removed (${c.name})`);
}

await browser.close();
console.log(fail.length ? `\n${fail.length} failed` : '\nall good');
process.exit(fail.length ? 1 : 0);
