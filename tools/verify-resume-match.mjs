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
/*
 * A DIFFERENT NUMBER EVERY RUN.
 *
 * The importer matches an existing person on the last ten digits of
 * their phone, which is correct and is exactly why a fixed test
 * number is wrong: one run's row merged into the previous run's
 * leftover, kept the old address, and the lookup by the new address
 * then found nobody. The failure looked like the matcher and was the
 * fixture.
 */
const tail = String(stamp).slice(-6);
const phoneA = `98${tail}01`;
const phoneB = `98${tail}02`;
const csv = [
  'Name,Email ID,Mobile Number,Current Employer,Current Location',
  `Anita Byemail ${stamp},${withEmail},${phoneA},Apollo Hospitals,Hyderabad`,
  `Ravi Byphone ${stamp},byphone.${stamp}@example.invalid,${phoneB},G Tech,Chennai`,
].join('\n');
await api('post', '/candidates/import', { text: csv });
await page.waitForTimeout(600);

/*
 * Looked up as the ADMIN. A recruiter cannot see every candidate - a
 * self-registered one who has applied to nothing belongs to nobody -
 * and asking with the wrong eyes reports "not there" about somebody
 * who is.
 */
const lookup = async (email) => admin.evaluate((e) => window.TL.api
  .get('/candidates?q=' + encodeURIComponent(e) + '&limit=5')
  .then((v) => v, () => ({ candidates: [] })), email);

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
    `Mobile: ${phoneA}`, 'KEY SKILLS', 'Critical Care, Patient Monitoring',
    'EXPERIENCE', 'Apollo Hospitals - Senior Staff Nurse (2019 - Present)',
    'Total Experience: 6 years', 'Current Location: Hyderabad']) },
  { name: 'ravi.txt', b64: cv([
    `Ravi Byphone ${stamp}`, 'SAP MM Consultant', `Mobile: +91 ${phoneB}`,
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
  `a country-coded number matched Ravi (${byFile['ravi.txt'] && byFile['ravi.txt'].matchedBy})`);
check(byFile['anita.txt'] && byFile['anita.txt'].rescreened !== undefined,
  'and the score was worked out again now there is a CV');

const stranger = (out.detail.unmatched || []).find((u) => u.file === 'stranger.txt');
check(!!stranger, 'a resume for nobody in the portal is NOT attached to a guess');
check(stranger && stranger.read && /Unknown/i.test(String(stranger.read.name || '')),
  `and it reports what it read, so a person can place it (${stranger && stranger.read && stranger.read.name})`);

check(out.refused + out.unmatched === 2,
  `the empty file was refused or unmatched, never attached (${out.refused} refused, ${out.unmatched} unmatched)`);

/* The resume really is on the candidate, not merely reported. */
const found = await lookup(withEmail);
const anita = (found.candidates || [])[0];
check(anita && anita.resumeFile, `the CV is on the candidate's record (${anita && anita.resumeFile})`);
check(anita && (anita.skills || []).includes('Critical Care'),
  `and what it says reached the profile (${JSON.stringify(anita && anita.skills)})`);

/* ------------------------------------------------------------------ *
 * the candidate's OWN upload, in the portal
 * ------------------------------------------------------------------ *
 * The other half of the same question. A recruiter adds the CVs that
 * arrive in a batch; the candidate can also sign in and upload their
 * own, and that has to land on the same record and keep landing - a
 * newer one REPLACES the older, because the newest is the one they want
 * sent to a client.
 */
const self = await browser.newPage();
await self.goto(`${BASE}/`, { waitUntil: 'load' });
await self.waitForFunction(() => window.TL && window.TL.ready === true, { timeout: 25000 });
const selfEmail = `selfupload.${stamp}@example.invalid`;
const reg = await self.evaluate((e) => window.TL.api.post('/auth/register',
  { name: 'Self Upload ' + e.split('.')[1], email: e, password: 'Upload@2026' })
  .then((v) => v, (x) => ({ error: x.message })), selfEmail);
check(!reg.error, `a candidate can register (${reg.error || 'ok'})`);

const upload = (lines, name) => self.evaluate(async ([text, fname]) => {
  const fd = new FormData();
  fd.append('resume', new File([new TextEncoder().encode(text)], fname, { type: 'text/plain' }));
  return window.TL.api.post('/uploads/resume', fd)
    .then((v) => ({ file: v.resume && v.resume.fileName, parsed: v.parse && v.parse.ok,
                    rescreened: v.rescreened }),
          (e) => ({ error: e.message }));
}, [lines.join('\n'), name]);

const first = await upload([
  'Self Upload', 'Java Developer', `Email: ${selfEmail}`,
  'KEY SKILLS', 'Java, Spring Boot', 'Total Experience: 4 years'], 'mine-v1.txt');
check(!first.error && first.parsed,
  `the candidate's own upload is taken and read (${first.error || first.file})`);

/*
 * Looked up as the ADMIN, not the recruiter.
 *
 * A candidate who signed up and has not applied to anything belongs to
 * no recruiter, and recruiter isolation correctly hides them - which is
 * the right behaviour and the wrong lens for this question. What is
 * being checked here is whether the upload reached the record.
 */
const after1 = await lookup(selfEmail);
const rec1 = (after1.candidates || [])[0];
check(rec1 && rec1.resumeFile === 'mine-v1.txt',
  `and it is on their record (${rec1 && rec1.resumeFile})`);
check(rec1 && (rec1.skills || []).includes('Java'),
  `with what it says (${JSON.stringify(rec1 && rec1.skills)})`);

/* A second one REPLACES the first - it keeps updating. */
const second = await upload([
  'Self Upload', 'Senior Java Developer', `Email: ${selfEmail}`,
  'KEY SKILLS', 'Java, Spring Boot, Kubernetes, Kafka', 'Total Experience: 6 years'], 'mine-v2.txt');
check(!second.error, `a second upload is accepted (${second.error || second.file})`);

const after2 = await lookup(selfEmail);
const rec2 = (after2.candidates || [])[0];
check(rec2 && rec2.resumeFile === 'mine-v2.txt',
  `the newer resume replaced the older one (${rec2 && rec2.resumeFile})`);
check(rec2 && rec2.id === rec1.id,
  'on the SAME candidate - a second upload never forks the profile');

/*
 * And a recruiter cannot reach them at all, which is the isolation
 * working: somebody who signed up and has not applied to this
 * recruiter's requirement is not theirs to see, so a batch resume
 * naming them finds nobody rather than attaching to a stranger's
 * profile.
 */
const over = await send([{ name: 'recruiter-copy.txt', b64: cv([
  'Self Upload', 'Java Developer', `Email: ${selfEmail}`, 'KEY SKILLS', 'Java']) }]);
check((over.detail.matched || []).length === 0,
  'a recruiter cannot place a resume onto a candidate outside their pipeline');
check((over.detail.unmatched || []).length === 1,
  'it is reported as unmatched rather than attached to somebody else');

const stillMine = await lookup(selfEmail);
check((stillMine.candidates || [])[0].resumeFile === 'mine-v2.txt',
  `and the candidate's own upload is untouched by that (${
    (stillMine.candidates || [])[0].resumeFile})`);

const mine = ((await lookup(selfEmail)).candidates || [])[0];
if (mine) {
  const gone = await admin.evaluate((id) => window.TL.api.post('/admin/purge-test-candidate',
    { candidateId: id }).then((v) => v, (e) => ({ error: e.message })), mine.id);
  check(gone.removed === true, 'the self-upload test candidate was removed');
}

/* ---- clean up -------------------------------------------------------- */
for (const q of [withEmail, `byphone.${stamp}@example.invalid`]) {
  // As the ADMIN: a cleanup that looks with the wrong eyes silently
  // leaves people behind, which is how the leftovers accumulated.
  const c = ((await lookup(q)).candidates || [])[0];
  if (!c) continue;
  const gone = await admin.evaluate((id) => window.TL.api.post('/admin/purge-test-candidate',
    { candidateId: id }).then((v) => v, (e) => ({ error: e.message })), c.id);
  check(gone.removed === true, `the test candidate was removed (${c.name})`);
}

await browser.close();
console.log(fail.length ? `\n${fail.length} failed` : '\nall good');
process.exit(fail.length ? 1 : 0);
