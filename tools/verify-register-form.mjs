/**
 * The registration form works while real candidates are loaded.
 *
 *     node tools/verify-register-form.mjs      (dev server on :4323)
 *
 * WHY THE SESSION MATTERS, and why this is the whole point of the test:
 * the bug it guards against only appears when the browser is holding
 * candidates that have NO EMAIL ADDRESS. On a signed-out page the list is
 * empty, so every check passes and nothing is proved.
 *
 * A candidate with no email is normal. Naukri's daily digest names the
 * people who applied and carries no contact details at all - that is the
 * reason the attached CV is read - so every candidate imported from one
 * has email null. `candidateEmailTaken()` read `.toLowerCase()` straight
 * off that and threw, and because validateRegisterForm() calls it on
 * EVERY keystroke, the entire form stopped responding: nothing typed
 * anywhere got past validation, the Submit button never enabled, and
 * uploading a CV reported "Cannot read properties of null (reading
 * 'toLowerCase')" instead of filling the fields in.
 *
 * So: sign in first, confirm there really are emailless candidates
 * loaded, and only then type.
 */
import { chromium } from 'playwright';

const BASE = (process.env.TL_URL || 'http://localhost:4323/').replace(/\/$/, '');
const fail = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`); if (!ok) fail.push(what); };

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1300, height: 1000 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));

await page.goto(`${BASE}/`, { waitUntil: 'load' });
await page.waitForFunction(() => window.TL && window.TL.ready === true, { timeout: 25000 });
await page.evaluate((l) => window.TL.api.post('/auth/login', l), {
  email: process.env.TL_RECRUITER || 'teamlinkmed001@tmlink.in',
  password: process.env.TL_RECRUITER_PASSWORD || 'Teamlink@2026',
  role: 'recruiter',
});
await page.evaluate(() => window.TL.refresh());
await page.waitForTimeout(2000);
await page.evaluate(() => { location.hash = '#/register/candidate'; });
await page.waitForTimeout(1600);

/* ---- the condition that makes this test mean anything -------------- */
const loaded = await page.evaluate(() => {
  const cs = window.DATA.candidates || [];
  return { total: cs.length, noEmail: cs.filter((c) => !c || !c.email).length };
});
check(loaded.total > 0, `candidates are loaded (${loaded.total})`);
check(loaded.noEmail > 0,
  `and ${loaded.noEmail} of them have NO email address - which is what used to break this`);

/* ---- the two functions that threw --------------------------------- */
const threw = await page.evaluate(() => {
  const out = {};
  try { window.candidateEmailTaken('nobody@example.com'); out.taken = null; }
  catch (e) { out.taken = e.message; }
  try { window.validateRegisterForm(); out.validate = null; }
  catch (e) { out.validate = e.message; }
  return out;
});
check(!threw.taken, `candidateEmailTaken survives an emailless candidate (${threw.taken || 'no throw'})`);
check(!threw.validate, `validateRegisterForm survives it too (${threw.validate || 'no throw'})`);

/* It must still SAY yes for an address that really is registered. */
const known = await page.evaluate(() => {
  const c = (window.DATA.candidates || []).find((x) => x && x.email);
  if (!c) return null;
  return {
    email: c.email,
    taken: window.candidateEmailTaken(c.email),
    upper: window.candidateEmailTaken(String(c.email).toUpperCase()),
    unknown: window.candidateEmailTaken('definitely-not-registered@example.com'),
  };
});
check(known && known.taken === true,
  `an address that IS registered still comes back as taken (${known && known.email})`);
check(known && known.upper === true, '  and the check is case-insensitive');
check(known && known.unknown === false, '  while an unknown address is free');

/* ---- typing ------------------------------------------------------- */
for (const [id, text] of [['regName', 'Meghana Rao'], ['regEmail', 'meghana@example.com'],
                          ['regLocation', 'Hyderabad'], ['regPassword', 'Str0ngPass']]) {
  await page.click(`#${id}`);
  await page.type(`#${id}`, text, { delay: 15 });
  const got = await page.evaluate((i) => document.getElementById(i).value, id);
  check(got === text, `  typing into ${id} works (${JSON.stringify(got)})`);
}

/*
 * The mobile field rewrites its own value on every keystroke to keep the
 * "+91 90000 00000" shape, so it is cleared first and asserted on digits
 * - anything else is testing the formatter's intermediate states rather
 * than whether the key reached the field.
 */
await page.evaluate(() => {
  const el = document.getElementById('regMobile');
  el.value = ''; delete el.dataset.userSet;
});
/*
 * One digit at a time with the caret sent to the end first. Assigning
 * `el.value` puts a real browser's caret at the end, but the automation
 * driver keeps its own offset and would otherwise insert each digit into
 * the middle of the "+91 " prefix the formatter has just written - which
 * fails on the formatter's behaviour rather than on the keyboard.
 */
await page.click('#regMobile');
for (const d of '9876543210') {
  await page.keyboard.press('End');
  await page.keyboard.type(d, { delay: 15 });
}
const mob = await page.evaluate(() => document.getElementById('regMobile').value);
check(mob.replace(/\D/g, '').endsWith('9876543210'), `  and into regMobile (${mob})`);

/* ---- uploading a CV still fills the form -------------------------- */
await page.evaluate(() => {
  ['regName', 'regEmail', 'regLocation'].forEach((i) => {
    const el = document.getElementById(i);
    if (el) { el.value = ''; delete el.dataset.userSet; }
  });
});
await page.evaluate(() => window.triggerRegisterResumeUpload());
await page.waitForTimeout(300);
await page.setInputFiles('#regResumeFileInput',
  process.env.TL_TEST_RESUME
    || 'var/uploads/candidates/cand_muc9k2ivzjfe/00105ef4-5a68-49a0-8c95-2d86a947dff5.pdf');
await page.waitForTimeout(7000);

const status = await page.evaluate(() =>
  (document.getElementById('regResumeStatus') || {}).textContent || '');
check(!/cannot read|null|undefined/i.test(status),
  `uploading a CV reports no internal error (${status.slice(0, 80)})`);
check(/analyzed successfully/i.test(status), '  and it says what it found');

check(errors.length === 0, `no page errors${errors.length ? `: ${errors[0]}` : ''}`);
await browser.close();
console.log(fail.length ? `\n${fail.length} failed` : '\nall good');
process.exit(fail.length ? 1 : 0);
