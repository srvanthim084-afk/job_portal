/**
 * The resume comes FIRST on the registration form.
 *
 *     node tools/verify-register-resume-first.mjs    (dev server on :4323)
 *
 * WHY THIS IS WORTH A TEST. The Resume panel used to be section 3, below
 * Personal Information and Professional Information - below, that is, the
 * two panels its own text promises to fill in: "AI reads your resume the
 * moment you upload it and fills the form above automatically". A
 * candidate reads top to bottom. They typed their name, mobile, email,
 * location, experience, skills and education by hand, and only then
 * scrolled far enough to find the button that would have done all of it.
 *
 * So this checks the ORDER on the page, not just that the panel exists,
 * and it checks that uploading still fills the fields that are now below
 * it - because moving a panel is exactly the kind of change that leaves
 * the markup right and the wiring broken.
 */
import { chromium } from 'playwright';

const BASE = (process.env.TL_URL || 'http://localhost:4323/').replace(/\/$/, '');
const fail = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`); if (!ok) fail.push(what); };

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 1000 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));

await page.goto(`${BASE}/`, { waitUntil: 'load' });
await page.waitForFunction(() => window.TL && window.TL.ready === true, { timeout: 25000 });
await page.evaluate(() => { location.hash = '#/register/candidate'; });
await page.evaluate(() => { if (window.TLResumeFirst) window.TLResumeFirst.manual(); }); /* 0117: the seven-step form is the manual path */
await page.waitForTimeout(1200);

/* ---- the steps, and the resume at the very top of the first ------- *
 * 0109 (intentional change): the form is the owner's seven steps -
 * Basic, Education, Experience, Preferences, Resume, Account, Review -
 * and stays resume-first: the upload is the first thing in step 1,
 * above the fields it fills. Step 5 is where the resume is checked,
 * replaced, removed or downloaded.
 */
const steps = await page.evaluate(() =>
  [...document.querySelectorAll('#registerForm .tlr-step .tlr-step-head h2')].map((h) => ({
    num: (h.querySelector('.reg-section-num') || {}).textContent || '',
    title: h.textContent.replace(/^\d+/, '').trim(),
  })));
check(steps.length === 7, `the seven steps are all there (${steps.length})`);
check(JSON.stringify(steps.map((s) => s.num)) === JSON.stringify(['1', '2', '3', '4', '5', '6', '7']),
  `the numbering runs 1-7 with no repeat or gap (${steps.map((s) => s.num).join(',')})`);
const order = await page.evaluate(() => {
  const s1 = document.getElementById('tlrStep1');
  const panels = [...s1.querySelectorAll(':scope > .panel')];
  const top = (el) => el.getBoundingClientRect().top + window.scrollY;
  const personal = panels.find((p) => /Personal/i.test(p.textContent));
  return { first: panels[0] && panels[0].classList.contains('ai-panel'),
    above: panels[0] && personal && top(panels[0]) < top(personal),
    nameBelow: top(panels[0]) < top(document.getElementById('regName')) };
});
check(order.first, 'the resume upload is the FIRST panel of step 1');
check(order.above, 'the upload is physically above Personal Information on the page');
check(order.nameBelow, 'and above the fields it fills');

/* ---- the promise it makes now matches where it is ----------------- */
const copy = await page.evaluate(() => {
  const box = document.querySelector('#registerForm .resume-upload-box');
  return box ? box.textContent.replace(/\s+/g, ' ').trim() : '';
});
check(!/fills the form above/i.test(copy),
  'it no longer says it fills the form "above" it, which it is now on top of');
check(/fills the rest of this form/i.test(copy),
  `it says what it actually does (${copy.slice(0, 90)}…)`);

/* ---- the controls still exist and are still wired ----------------- */
const wired = await page.evaluate(() => ({
  upload: !!document.querySelector('[onclick*="triggerRegisterResumeUpload"]'),
  paste: !!document.getElementById('regResumeText'),
  analyze: !!document.querySelector('[onclick*="analyzeRegisterResumeText"]'),
  status: !!document.getElementById('regResumeStatus'),
  fileName: !!document.getElementById('regFileName'),
  fnUpload: typeof window.triggerRegisterResumeUpload === 'function',
  fnAnalyze: typeof window.analyzeRegisterResumeText === 'function',
}));
for (const [k, v] of Object.entries(wired)) check(v, `  ${k}`);

/* ---- the fields it fills are still below it, and still fillable --- */
const fields = await page.evaluate(() =>
  ['regName', 'regEmail', 'regMobile', 'regLocation', 'regPassword']
    .map((id) => ({ id, there: !!document.getElementById(id) })));
for (const f of fields) check(f.there, `  the field it fills is still there: ${f.id}`);

/*
 * Pasting a resume and pressing Analyze must fill the fields BELOW the
 * panel. This is the wiring that a move can silently break.
 */
await page.evaluate(() => {
  document.getElementById('regResumeText').value = [
    'Meghana Rao',
    'meghana.rao.test@example.com',
    '+91 98111 22334',
    'Hyderabad, Telangana',
    'Senior Staff Nurse with 6 years of experience.',
    'Skills: Critical Care, Patient Monitoring, IV Therapy',
  ].join('\n');
});
await page.evaluate(() => window.analyzeRegisterResumeText());
await page.waitForTimeout(2500);

const filled = await page.evaluate(() => ({
  name: document.getElementById('regName').value,
  email: document.getElementById('regEmail').value,
  mobile: document.getElementById('regMobile').value,
  location: document.getElementById('regLocation').value,
}));
check(/Meghana/i.test(filled.name),
  `analysing from the top still fills the name below it (${JSON.stringify(filled.name)})`);
check(/meghana\.rao\.test@example\.com/i.test(filled.email),
  `and the email (${JSON.stringify(filled.email)})`);
check(/98111/.test(String(filled.mobile).replace(/\s/g, '')),
  `and the mobile (${JSON.stringify(filled.mobile)})`);

check(errors.length === 0, `no page errors${errors.length ? `: ${errors[0]}` : ''}`);
await browser.close();
console.log(fail.length ? `\n${fail.length} failed` : '\nall good');
process.exit(fail.length ? 1 : 0);
