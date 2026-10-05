/**
 * Everything a resume actually says ends up on the candidate.
 *
 *     node tools/verify-resume-extraction.mjs      (dev server on :4323)
 *
 * A candidate registers by uploading their CV and nothing else - no
 * typing - and this then asks the SERVER what it stored. That is the only
 * question worth asking: a field that is read out of the PDF, shown on
 * the form and then dropped on submit is not extracted, it is displayed.
 *
 * The resume below is written here rather than taken from the uploads
 * directory, because the test has to know the right answer for every
 * field in order to check it. Each assertion names the value it expects.
 *
 * The password is deliberately NOT among them. A resume does not contain
 * one, nothing should invent one from it, and the account's own password
 * is the one the candidate typed.
 *
 * The candidate is on a domain reserved for testing (RFC 2606) and is
 * removed at the end.
 */
import { chromium } from 'playwright';
import { fillRegistration } from './lib/registration-form.mjs';
import { TINY_PDF } from './lib/apply-form.mjs';

const BASE = (process.env.TL_URL || 'http://localhost:4323/').replace(/\/$/, '');
const fail = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`); if (!ok) fail.push(what); };

const stamp = Date.now();
const EMAIL = `resume.extract.${stamp}@example.com`;
const PASSWORD = 'Str0ngPass123';

const RESUME = [
  'MEGHANA RAO',
  'Senior Staff Nurse',
  '',
  'Email: ' + EMAIL,
  'Mobile: +91 98765 43210',
  'Date of Birth: 14/03/1994',
  'Location: Hyderabad, Telangana',
  'LinkedIn: linkedin.com/in/meghana-rao-nurse',
  'GitHub: github.com/meghanarao',
  'Portfolio: meghanarao.dev',
  '',
  'EDUCATION',
  'B.Sc Nursing, Osmania University, 2016',
  '',
  'EXPERIENCE',
  'Current Company: Apollo Hospitals',
  'Current Designation: Senior Staff Nurse',
  'Total Experience: 6 years',
  'Notice Period: 30 days',
  'Previously worked at Yashoda Hospitals and Care Hospitals.',
  '',
  'SKILLS',
  'Critical Care, Patient Monitoring, IV Therapy, Wound Care, Triage',
  '',
  'CERTIFICATIONS',
  'Basic Life Support (BLS), Advanced Cardiac Life Support (ACLS)',
  '',
  'LANGUAGES',
  'English, Hindi, Telugu',
].join('\n');

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 1000 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));

await page.goto(`${BASE}/`, { waitUntil: 'load' });
await page.waitForFunction(() => window.TL && window.TL.ready === true, { timeout: 25000 });

const api = async (m, p, b) => {
  const r = await page.evaluate(([mm, pp, bb]) => window.TL.api[mm](pp, bb)
    .then((v) => ({ ok: 1, v }), (e) => ({ ok: 0, c: e.code, m: e.message })), [m, p, b]);
  if (r.ok) return r.v;
  throw new Error(`${r.c || 'FAILED'}: ${r.m || ''}`);
};

let candidateId = null;

try {
  await page.evaluate(() => { location.hash = '#/register/candidate'; });
  await page.waitForTimeout(1500);

  /* ---- paste the CV and let the extractor fill the form ----------- */
  await page.evaluate((text) => {
    document.getElementById('regResumeText').value = text;
  }, RESUME);
  const found = await page.evaluate(() => window.applyRegisterResumeExtraction(
    document.getElementById('regResumeText').value));
  check(found > 0, `the extractor found ${found} field(s) in the CV`);

  const onForm = await page.evaluate(() => {
    const v = (id) => { const el = document.getElementById(id); return el ? el.value : null; };
    return {
      name: v('regName'), email: v('regEmail'), mobile: v('regMobile'),
      location: v('regLocation'), qualification: v('regQualification'),
      skills: v('regSkills'), company: v('regCompany'),
      designation: v('regDesignation'), totalExp: v('regTotalExp'),
      notice: v('regNotice'),
      extras: window.STATE && window.STATE.regResumeExtras,
    };
  });
  console.log('\n  what the form was filled with:');
  for (const [k, val] of Object.entries(onForm)) {
    if (k === 'extras') continue;
    console.log(`    ${k.padEnd(14)} ${JSON.stringify(val)}`);
  }
  console.log(`    extras         ${JSON.stringify(onForm.extras)}`);

  check(/meghana/i.test(String(onForm.name)), `  the name (${onForm.name})`);
  check(String(onForm.email).toLowerCase() === EMAIL, `  the email address (${onForm.email})`);
  check(String(onForm.mobile).replace(/\D/g, '').endsWith('9876543210'), `  the mobile (${onForm.mobile})`);
  check(/hyderabad/i.test(String(onForm.location)), `  the location (${onForm.location})`);
  check(/critical care/i.test(String(onForm.skills)), `  the skills (${String(onForm.skills).slice(0, 60)})`);
  check(/apollo/i.test(String(onForm.company)), `  the current employer (${onForm.company})`);
  check(/nurse/i.test(String(onForm.designation)), `  the designation (${onForm.designation})`);

  const ex = onForm.extras || {};
  check(!!ex.dob, `  the date of birth (${ex.dob})`);
  check((ex.languages || []).length >= 2, `  the languages (${JSON.stringify(ex.languages)})`);
  check((ex.certifications || []).length >= 1, `  the certifications (${JSON.stringify(ex.certifications)})`);
  check(/linkedin/i.test(String(ex.linkedin || '')), `  LinkedIn (${ex.linkedin})`);
  check(/github/i.test(String(ex.github || '')), `  GitHub (${ex.github})`);

  /* Nothing may invent a password from a CV. */
  check(!('password' in ex), 'the extractor does not put a password on the record');

  check(String(onForm.totalExp) === '6',
    `  the total experience, from a labelled line (${onForm.totalExp})`);

  /* ---- submit, and ask the SERVER what it kept -------------------- */
  /*
   * Filled and ticked the way a person would, then the real Submit
   * button is clicked. Dispatching a submit event bypasses whatever the
   * button is guarded by, which would test a path nobody uses.
   */
  /* 0109: the form is seven steps and wants what it did not before -
     branch, total experience, preferred role, confirm password, the
     consents and a resume FILE. Those are answered as a candidate would
     (tools/lib/registration-form.mjs), touching only fields the pasted CV
     left empty. The file is a PDF with no text, so it cannot add to, or
     change, what the paste extracted - which is what this checks. */
  const left = await fillRegistration(page, { onlyEmpty: true, email: EMAIL, password: PASSWORD,
    resume: { name: 'resume.pdf', mimeType: 'application/pdf', buffer: TINY_PDF } });
  check(!left.length, `the seven-step form is complete (${JSON.stringify(left)})`);
  const ready = await page.evaluate((pw) => {
    const el = document.getElementById('regPassword');
    el.value = pw;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    /* A CV does not say where somebody WANTS to work, so the form asks -
       and rightly refuses to submit without it. Answered here as a
       candidate would. */
    const pref = document.getElementById('regPrefLocation');
    if (pref && !pref.value) {
      pref.value = 'Hyderabad';
      pref.dispatchEvent(new Event('input', { bubbles: true }));
      pref.dispatchEvent(new Event('change', { bubbles: true }));
    }
    document.querySelectorAll('#registerForm input[type="checkbox"]').forEach((c) => {
      if (!c.checked) { c.click(); }
    });
    if (typeof window.validateRegisterForm === 'function') window.validateRegisterForm();
    const btn = [...document.querySelectorAll('#registerForm button, #registerForm input[type=submit]')]
      .find((b) => /create|register|submit|sign\s*up/i.test(b.textContent || b.value || ''));
    return { button: btn ? (btn.textContent || btn.value || '').trim() : null,
             disabled: btn ? !!btn.disabled : null };
  }, PASSWORD);
  console.log(`\n  submit button: ${JSON.stringify(ready)}`);
  check(!!ready.button, `there is a submit button (${ready.button})`);
  check(ready.disabled === false, `and it is enabled once the form is filled (disabled=${ready.disabled})`);

  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('#registerForm button, #registerForm input[type=submit]')]
      .find((b) => /create|register|submit|sign\s*up/i.test(b.textContent || b.value || ''));
    if (btn) btn.click();
  });
  await page.waitForTimeout(4000);

  const me = await api('get', '/auth/me').catch(() => null);
  candidateId = me && me.profile && me.profile.id;
  check(!!candidateId, `the account was created and signed in (${candidateId || 'not signed in'})`);

  if (candidateId) {
    const c = await api('get', `/candidates/${encodeURIComponent(candidateId)}`)
      .then((r) => r.candidate || r).catch((e) => ({ error: e.message }));
    console.log('\n  what the SERVER stored:');
    for (const k of ['name', 'email', 'phone', 'location', 'education', 'title',
                     'currentCompany', 'noticePeriod', 'exp', 'skills',
                     'certifications', 'languages', 'dob', 'linkedin', 'github', 'portfolio']) {
      console.log(`    ${k.padEnd(15)} ${JSON.stringify(c[k])}`);
    }
    check(/meghana/i.test(String(c.name || '')), `  the name was stored (${c.name})`);
    check(String(c.email || '').toLowerCase() === EMAIL, `  the email was stored (${c.email})`);
    check(String(c.phone || '').replace(/\D/g, '').endsWith('9876543210'), `  the phone was stored (${c.phone})`);
    check(/hyderabad/i.test(String(c.location || '')), `  the location was stored (${c.location})`);
    check((c.skills || []).some((x) => /critical care/i.test(x)),
      `  the skills were stored (${JSON.stringify((c.skills || []).slice(0, 4))})`);
    check(/apollo/i.test(String(c.currentCompany || '')), `  the employer was stored (${c.currentCompany})`);
    check(!!String(c.education || '').trim(), `  the education was stored (${c.education})`);
    check((c.certifications || []).length > 0,
      `  the certifications were stored (${JSON.stringify(c.certifications)})`);
    check((c.languages || []).length > 0,
      `  the languages were stored (${JSON.stringify(c.languages)})`);
    check(!!c.linkedin, `  LinkedIn was stored (${c.linkedin})`);
    /* The password must never come back out of the API. */
    check(!('password' in c) && !('passwordHash' in c) && !('password_hash' in c),
      'and no password field is returned by the API');
  }
} catch (e) {
  check(false, `the registration could not be driven (${e.message})`);
} finally {
  if (!candidateId) {
    try { const me = await api('get', '/auth/me'); candidateId = me && me.profile && me.profile.id; }
    catch { /* never signed in */ }
  }
  try { await api('post', '/auth/logout', {}); } catch { /* already out */ }
  if (candidateId) {
    try {
      await api('post', '/auth/login', {
        email: process.env.TL_ADMIN || 'admin@teamlink.com',
        password: process.env.TL_ADMIN_PASSWORD || process.env.TL_PASSWORD || 'TeamLink@2026',
        role: 'admin',
      });
      const gone = await api('post', '/admin/purge-test-candidate', { candidateId });
      check(gone && gone.removed === true, `the test candidate was removed (${JSON.stringify(gone)})`);
    } catch (e) {
      check(false, `CLEANUP FAILED - remove ${EMAIL} by hand (${e.message})`);
    }
  }
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors[0]}` : ''}`);
  await browser.close();
  console.log(fail.length ? `\n${fail.length} failed` : '\nall good');
  process.exit(fail.length ? 1 : 0);
}
