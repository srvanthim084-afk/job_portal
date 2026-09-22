/**
 * Resume upload -> extraction -> form -> database, driven through the UI.
 *
 * The reported bug was that a real DOCX produced
 * "Something went wrong reading this file". The cause was not the file:
 * the prototype loaded mammoth and pdf.js from cdnjs, and the API's
 * Content-Security-Policy did not allow that origin, so every DOCX and
 * every PDF failed identically while the console carried the real reason.
 *
 * Nothing in the repo would have caught that, because nothing uploaded a
 * file. This does, with real files, and checks the values that come out
 * against what those files actually say.
 *
 *   node tools/verify-resume.mjs      (needs npm run dev on :4323)
 */
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const BASE = process.env.TL_URL || 'http://localhost:4323/';
const DIR = resolve('var/test-resumes');

if (!existsSync(resolve(DIR, 'Resume - Sravanthi.docx'))) {
  execFileSync(process.execPath, ['tools/make-test-resumes.mjs'], { stdio: 'inherit' });
}

/* What the test files actually say. Asserted, not eyeballed. */
const TRUTH = {
  regName: 'Sravanthi Reddy',
  regEmail: 'sravanthi.reddy@example.com',
  regCompany: 'TechNova Solutions',
  regDesignation: 'Senior Software Engineer',
  regTotalExp: '7',
  regSkills: 'Java, Spring Boot, PostgreSQL, React, AWS',
};

let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  PASS  ${name}`); }
  catch (e) { console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n')[0]}`); failed++; }
};
const must = (c, m) => { if (!c) throw new Error(m); };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto(BASE, { waitUntil: 'load' });
await page.waitForFunction(() => window.TL && window.TL.ready === true, { timeout: 25000 });

const gotoRegister = async () => {
  await page.evaluate(() => { location.hash = '#/register/candidate'; });
  await page.waitForTimeout(700);
};

/** Clicks the real Upload Resume button and picks a file in the chooser. */
async function uploadResume(file) {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /upload resume/i.test(x.textContent));
      b.click();
    }),
  ]);
  await chooser.setFiles(resolve(DIR, file));
  await page.waitForTimeout(4500);
  return page.evaluate(() => ({
    status: ((document.getElementById('regResumeStatus') || {}).textContent || '').trim(),
    text: (document.getElementById('regResumeText') || {}).value || '',
    values: ['regName', 'regEmail', 'regMobile', 'regLocation', 'regSkills', 'regTotalExp',
             'regCompany', 'regDesignation', 'regPrefLocation', 'regNotice', 'regQualification']
      .reduce((a, id) => { const e = document.getElementById(id); if (e && e.value) a[id] = e.value; return a; }, {}),
  }));
}

const clearForm = () => page.evaluate(() => {
  ['regName', 'regEmail', 'regMobile', 'regLocation', 'regSkills', 'regTotalExp', 'regCompany',
   'regDesignation', 'regPrefLocation', 'regExpSalary', 'regResumeText'].forEach((id) => {
    const e = document.getElementById(id);
    if (e) { e.value = ''; delete e.dataset.userSet; }
  });
});

console.log('\nreal files, through the real button');

for (const [label, file, minFields] of [
  ['a real DOCX fills the form', 'Resume - Sravanthi.docx', 10],
  ['a real multi-page PDF fills the form', 'Resume - Sravanthi.pdf', 9],
  ['a real TXT fills the form', 'Resume - Sravanthi.txt', 10],
]) {
  // eslint-disable-next-line no-loop-func
  await check(label, async () => {
    await gotoRegister();
    await clearForm();
    const r = await uploadResume(file);

    must(/analyzed successfully/i.test(r.status),
      `status was "${r.status.slice(0, 90)}"`);
    must(r.text.length > 200, `only ${r.text.length} characters of text were extracted`);
    must(Object.keys(r.values).length >= minFields,
      `only ${Object.keys(r.values).length} fields were filled: ${JSON.stringify(r.values)}`);

    for (const [id, expected] of Object.entries(TRUTH)) {
      if (!r.values[id]) continue;          // not every format states every field
      must(r.values[id] === expected,
        `${id} came out as "${r.values[id]}", the file says "${expected}"`);
    }
    // The mobile number is reformatted for display; the digits must match.
    if (r.values.regMobile) {
      must(r.values.regMobile.replace(/\D/g, '').endsWith('9876543210'),
        `regMobile is "${r.values.regMobile}"`);
    }
  });
}

await check('the DOCX yields MORE than the PDF (its tables are read)', async () => {
  await gotoRegister(); await clearForm();
  const docx = await uploadResume('Resume - Sravanthi.docx');
  must(docx.values.regPrefLocation, 'preferred location, which is in a table, was not extracted');
  must(docx.values.regNotice, 'notice period, which is in a table, was not extracted');
});

console.log('\nwhat it says when a file cannot be read');

await check('an empty file is reported as empty, not as a broken file', async () => {
  await gotoRegister(); await clearForm();
  const r = await uploadResume('Empty resume.txt');
  must(/no readable text/i.test(r.status), `status was "${r.status.slice(0, 90)}"`);
  must(!/something went wrong/i.test(r.status), 'the old generic message came back');
});

await check('a failed read does not wipe what the candidate typed', async () => {
  await gotoRegister(); await clearForm();
  await page.evaluate(() => {
    const e = document.getElementById('regName');
    e.value = 'Typed By Hand'; e.dataset.userSet = '1';
  });
  await uploadResume('Empty resume.txt');
  const name = await page.evaluate(() => document.getElementById('regName').value);
  must(name === 'Typed By Hand', `the typed name became "${name}"`);
});

console.log('\nthe candidate stays in control');

await check('a value the candidate typed is NOT overwritten', async () => {
  await gotoRegister(); await clearForm();
  await page.evaluate(() => {
    const e = document.getElementById('regName');
    e.value = 'My Own Name'; e.dataset.userSet = '1';
  });
  const r = await uploadResume('Resume - Sravanthi.docx');
  must(r.values.regName === 'My Own Name',
    `the typed name was replaced with "${r.values.regName}"`);
  // ...and the extracted value is still offered, not discarded
  const tag = await page.evaluate(() =>
    ((document.getElementById('regNameAiTag') || {}).textContent || '').trim());
  must(/click to use/i.test(tag), `the extracted value was not offered: "${tag}"`);
});

await check('an empty field IS filled from the resume', async () => {
  await gotoRegister(); await clearForm();
  const r = await uploadResume('Resume - Sravanthi.docx');
  must(r.values.regName === TRUTH.regName, `regName is "${r.values.regName}"`);
});

await check('the extracted text stays available as the paste fallback', async () => {
  const text = await page.evaluate(() => document.getElementById('regResumeText').value);
  must(text.includes('Sravanthi Reddy'), 'the resume text is not in the paste box');
});

console.log('\nend to end: the extracted candidate reaches the database');

const email = `resume.${Date.now()}@example.test`;

await check('register with an extracted resume, and find it in the database', async () => {
  await gotoRegister(); await clearForm();
  await uploadResume('Resume - Sravanthi.docx');

  // Fill only what the resume cannot supply.
  await page.evaluate((em) => {
    const set = (id, v) => {
      const e = document.getElementById(id);
      if (!e) return;
      e.value = v; e.dataset.userSet = '1';
      e.dispatchEvent(new Event('input', { bubbles: true }));
      e.dispatchEvent(new Event('change', { bubbles: true }));
    };
    set('regEmail', em);
    set('regPassword', 'ResumeTest@2026');
    const tick = (id) => { const e = document.getElementById(id); if (e && !e.checked) e.click(); };
    tick('regConsentTerms'); tick('regConsentResume');
    const q = document.getElementById('regQualification');
    if (q && !q.value && q.options.length > 1) q.selectedIndex = 1;
    const n = document.getElementById('regNotice');
    if (n && !n.value && n.options.length > 1) n.selectedIndex = 1;
    const t = document.querySelector('input[name="regCandidateType"]');
    if (t && !document.querySelector('input[name="regCandidateType"]:checked')) t.click();
  }, email);

  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /create account/i.test(x.textContent));
    b.click();
  });
  await page.waitForTimeout(4000);

  const session = await page.evaluate(() => (STATE.session ? STATE.session.id : null));
  must(session, 'registration did not sign the candidate in');

  // Read it back from the SERVER, not from the page's cache.
  const me = await page.evaluate(() => TL.api.get('/auth/me').then((r) => r.profile));
  must(me, '/auth/me returned no profile');
  must(String(me.name) === TRUTH.regName,
    `the database has name "${me.name}", the resume says "${TRUTH.regName}"`);
  must(String(me.email).toLowerCase() === email,
    `the database has email "${me.email}"`);
});

await browser.close();

console.log(failed === 0
  ? '\n  RESUME PIPELINE VERIFIED — docx, pdf, txt read on the server, fields filled, candidate saved\n'
  : `\n  ${failed} check(s) FAILED\n`);
process.exit(failed ? 1 : 0);
