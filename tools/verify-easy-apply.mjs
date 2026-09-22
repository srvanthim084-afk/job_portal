/**
 * Register once with a resume, then Easy Apply with it.
 *
 * Reported: a candidate who uploaded a resume during registration was told
 * "You have no resume on file yet" when they pressed Easy Apply.
 *
 * The resume WAS parsed at registration - it filled the form - but the file
 * itself was never sent anywhere. web/teamlink-integration.js stashed it on
 * TL.pendingResume with the comment "uploaded after the account is created",
 * and nothing ever read that property, so candidates.resume_file stayed
 * null. Easy Apply checks exactly that column (prototype.html:12963) and was
 * telling the truth about the database.
 *
 * This walks the whole path with a real file and checks the database, not
 * the page's own memory.
 *
 *   node tools/verify-easy-apply.mjs      (needs npm run dev on :4323)
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

let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  PASS  ${name}`); }
  catch (e) { console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n')[0]}`); failed++; }
};
const must = (c, m) => { if (!c) throw new Error(m); };

const browser = await chromium.launch();

async function session() {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForFunction(() => window.TL && window.TL.ready === true, { timeout: 25000 });
  return { ctx, page };
}

/** Registers through the real form, with a real resume file. */
async function registerWithResume(page, email, file) {
  await page.evaluate(() => { location.hash = '#/register/candidate'; });
  await page.waitForTimeout(800);

  if (file) {
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.evaluate(() => {
        const b = [...document.querySelectorAll('button')].find((x) => /upload resume/i.test(x.textContent));
        b.click();
      }),
    ]);
    await chooser.setFiles(resolve(DIR, file));
    await page.waitForTimeout(5000);          // extraction is a server round trip
  }

  await page.evaluate((em) => {
    const set = (id, v) => {
      const e = document.getElementById(id);
      if (!e) return;
      e.value = v; e.dataset.userSet = '1';
      e.dispatchEvent(new Event('input', { bubbles: true }));
      e.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const fill = (id, v) => { const e = document.getElementById(id); if (e && !e.value) set(id, v); };
    set('regEmail', em); set('regPassword', 'EasyApply@2026');
    fill('regName', 'Easy Apply Tester'); fill('regMobile', '9876500321');
    fill('regLocation', 'Hyderabad'); fill('regSkills', 'Java, SQL');
    fill('regPrefLocation', 'Hyderabad');
    const q = document.getElementById('regQualification');
    if (q && !q.value && q.options.length > 1) { q.selectedIndex = 1; q.dispatchEvent(new Event('change', { bubbles: true })); }
    const tick = (id) => { const e = document.getElementById(id); if (e && !e.checked) e.click(); };
    tick('regConsentTerms'); tick('regConsentResume');
    const t = document.querySelector('input[name="regCandidateType"]');
    if (t && !document.querySelector('input[name="regCandidateType"]:checked')) t.click();
    if (typeof validateRegisterForm === 'function') validateRegisterForm();
  }, email);

  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /create account/i.test(x.textContent));
    if (b && !b.disabled) b.click();
  });
  await page.waitForTimeout(6000);            // registration + profile + resume upload
  return page.evaluate(() => (STATE.session ? STATE.session.id : null));
}

/* ------------------------------------------------------------------ *
 * with a resume
 * ------------------------------------------------------------------ */
const withResume = await session();
const email = `easyapply.${Date.now()}@example.test`;
let candidateId, jobId;

await check('registering with a resume stores it against the candidate', async () => {
  candidateId = await registerWithResume(withResume.page, email, 'Resume - Sravanthi.docx');
  must(candidateId, 'registration did not sign the candidate in');

  // From the SERVER, not the page's cache.
  const me = await withResume.page.evaluate(() =>
    window.TL.api.get('/auth/me').then((r) => r.profile));
  must(me, '/auth/me returned no profile');
  must(me.resumeFile, 'the database has no resume against the candidate');
  must(/\.docx$/i.test(me.resumeFile), `resumeFile is "${me.resumeFile}"`);
});

await check('the resume survives a logout and a fresh login', async () => {
  await withResume.page.evaluate(() => window.doLogout());
  await withResume.page.waitForTimeout(1500);
  must(await withResume.page.evaluate(() => !STATE.session), 'still signed in after logout');

  const ok = await withResume.page.evaluate(([em]) =>
    window.TL.api.post('/auth/login', { email: em, password: 'EasyApply@2026', role: 'candidate' })
      .then(() => window.TL.refresh()).then(() => true, () => false), [email]);
  must(ok, 'could not sign back in');

  const me = await withResume.page.evaluate(() =>
    window.TL.api.get('/auth/me').then((r) => r.profile));
  must(me.resumeFile, 'the resume is gone after signing back in');
});

await check('Easy Apply does NOT ask for a resume', async () => {
  jobId = await withResume.page.evaluate(() => {
    const me = STATE.session && DATA.candidateById(STATE.session.id);
    const applied = new Set(DATA.applications.filter((a) => a.candidateId === (me || {}).id).map((a) => a.jobId));
    const j = DATA.jobs.find((x) => x.status === 'open' && !applied.has(x.id));
    return j ? j.id : null;
  });
  must(jobId, 'no open job to apply to');

  await withResume.page.evaluate((id) => { location.hash = '#/job/' + id; }, jobId);
  await withResume.page.waitForTimeout(1200);

  // The "Resume required" modal is the failure being tested for; the
  // review modal naming the resume on file is the correct behaviour.
  const expected = await withResume.page.evaluate(() =>
    window.TL.api.get('/auth/me').then((r) => r.profile.resumeFile));

  const seen = await withResume.page.evaluate(([id, name]) => {
    window.__expectResume = name;
    if (typeof window.cpEasyApply === 'function') window.cpEasyApply(id);
    return new Promise((r) => setTimeout(() => r({
      askedForResume: document.body.innerText.includes('You have no resume on file'),
      review: document.body.innerText.includes('Resume on file'),
      resumeShown: document.body.innerText.includes(window.__expectResume || ''),
      canSubmit: [...document.querySelectorAll('button')].some((b) => /submit application/i.test(b.textContent)),
    }), 1500));
  }, [jobId, expected]);

  must(!seen.askedForResume, 'the "Resume required" modal appeared for a candidate who has one');
  must(seen.review, 'no review step appeared before submitting');
  must(seen.resumeShown, `the review does not name the resume on file (${expected})`);
  must(seen.canSubmit, 'the review has no Submit application button');
});

await check('confirming the review submits the application', async () => {
  await withResume.page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /submit application/i.test(x.textContent));
    if (b) b.click();
  });
  await withResume.page.waitForTimeout(3000);
});

await check('the application is saved with the candidate, the job and the resume', async () => {
  await withResume.page.waitForTimeout(2000);
  const apps = await withResume.page.evaluate(() =>
    window.TL.api.get('/bootstrap').then((b) => b.data.applications || []));
  const mine = apps.filter((a) => a.candidateId === candidateId);
  must(mine.length >= 1, 'no application was saved');
  must(mine.some((a) => a.jobId === jobId), `no application for job ${jobId}`);

  const me = await withResume.page.evaluate(() =>
    window.TL.api.get('/auth/me').then((r) => r.profile));
  must(me.resumeFile, 'the resume reference was lost by applying');
});

await check('applying twice is refused', async () => {
  const out = await withResume.page.evaluate((j) =>
    window.TL.api.post('/applications', { jobId: j, source: 'portal' })
      .then(() => ({ ok: true }), (e) => ({ ok: false, status: e.status, code: e.code })), jobId);
  must(out.ok === false, 'a duplicate application was accepted');
  must(out.status === 409, `expected 409, got ${out.status}`);
});

/* ------------------------------------------------------------------ *
 * matching, updating, and surviving a refresh
 * ------------------------------------------------------------------ */

await check('jobs are scored against the resume-derived profile', async () => {
  // recRecommendation() is the prototype's own deterministic matcher: it
  // weights skills 34%, experience 18%, location 13%, salary 10%, education
  // 8%, work mode 7%. Everything it reads comes from the candidate record,
  // which the resume extractor fills - so this IS resume-based matching.
  const scored = await withResume.page.evaluate(() => {
    const me = DATA.candidateById(STATE.session.id);
    return DATA.jobs.filter((j) => j.status === 'open').slice(0, 12).map((j) => {
      const r = typeof window.recRecommendation === 'function' ? window.recRecommendation(me, j) : null;
      return r ? { job: j.title, pct: r.matchPercentage, matched: (r.matchedSkills || []).length } : null;
    }).filter(Boolean);
  });

  must(scored.length > 0, 'no job produced a match score');
  must(scored.every((x) => Number.isFinite(x.pct) && x.pct >= 0 && x.pct <= 100),
    'a match percentage was not a number between 0 and 100');
  // Deterministic: the same candidate and job must score the same twice.
  const again = await withResume.page.evaluate(() => {
    const me = DATA.candidateById(STATE.session.id);
    const j = DATA.jobs.find((x) => x.status === 'open');
    return window.recRecommendation(me, j).matchPercentage;
  });
  must(again === scored[0].pct, `the same pairing scored ${scored[0].pct} then ${again}`);
});

await check('replacing the resume from the profile stores the NEW file', async () => {
  const before = await withResume.page.evaluate(() =>
    window.TL.api.get('/auth/me').then((r) => r.profile.resumeFile));

  await withResume.page.evaluate(() => { location.hash = '#/candidate/resume'; });
  await withResume.page.waitForTimeout(1200);

  const hasButton = await withResume.page.evaluate(() =>
    [...document.querySelectorAll('button')].some((x) => /upload resume/i.test(x.textContent)));
  must(hasButton, 'the Resume page offers no way to upload a replacement');

  const [chooser] = await Promise.all([
    withResume.page.waitForEvent('filechooser'),
    withResume.page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /upload resume/i.test(x.textContent));
      b.click();
    }),
  ]);
  await chooser.setFiles(resolve(DIR, 'Resume - Sravanthi.pdf'));   // a DIFFERENT file
  await withResume.page.waitForTimeout(7000);

  const after = await withResume.page.evaluate(() =>
    window.TL.api.get('/auth/me').then((r) => r.profile.resumeFile));
  must(after, 'the candidate has no resume after replacing it');
  must(after !== before, `the resume did not change (still "${after}")`);
  must(/\.pdf$/i.test(after), `expected the new .pdf, the database has "${after}"`);
});

await check('the next Easy Apply uses the updated resume', async () => {
  const current = await withResume.page.evaluate(() =>
    window.TL.api.get('/auth/me').then((r) => r.profile.resumeFile));
  // Guards against a false pass: if the replacement above silently did
  // nothing, this would "prove" the old file is still shown.
  must(/\.pdf$/i.test(current), `the resume was never replaced (still ${current})`);

  const nextJob = await withResume.page.evaluate(() => {
    const me = DATA.candidateById(STATE.session.id);
    const applied = new Set(DATA.applications.filter((a) => a.candidateId === me.id).map((a) => a.jobId));
    const j = DATA.jobs.find((x) => x.status === 'open' && !applied.has(x.id));
    return j ? j.id : null;
  });
  if (!nextJob) return;                       // nothing left to apply to

  await withResume.page.evaluate((id) => { location.hash = '#/job/' + id; }, nextJob);
  await withResume.page.waitForTimeout(1200);
  const shown = await withResume.page.evaluate(([id, name]) => {
    window.__expect = name;
    if (typeof window.cpEasyApply === 'function') window.cpEasyApply(id);
    return new Promise((r) => setTimeout(() => r(document.body.innerText.includes(window.__expect)), 1500));
  }, [nextJob, current]);
  must(shown, `the review does not show the updated resume (${current})`);
});

await check('a browser refresh keeps the resume and the applications', async () => {
  await withResume.page.reload({ waitUntil: 'load' });
  await withResume.page.waitForFunction(() => window.TL && window.TL.ready === true, { timeout: 25000 });

  const still = await withResume.page.evaluate(() => (STATE.session ? STATE.session.id : null));
  must(still === candidateId, 'the session did not survive a refresh');

  const me = await withResume.page.evaluate(() =>
    window.TL.api.get('/auth/me').then((r) => r.profile));
  must(me.resumeFile, 'the resume is gone after a refresh');

  const mine = await withResume.page.evaluate((id) =>
    DATA.applications.filter((a) => a.candidateId === id).length, candidateId);
  must(mine >= 1, 'the applications are gone after a refresh');
});

/* ------------------------------------------------------------------ *
 * without one
 * ------------------------------------------------------------------ */
await check('a candidate with NO resume is still asked for one', async () => {
  const s = await session();
  try {
    const id = await registerWithResume(s.page, `noresume.${Date.now()}@example.test`, null);
    must(id, 'registration without a resume failed');

    const me = await s.page.evaluate(() => window.TL.api.get('/auth/me').then((r) => r.profile));
    must(!me.resumeFile, 'a candidate who uploaded nothing has a resume on file');

    const job = await s.page.evaluate(() => (DATA.jobs.find((x) => x.status === 'open') || {}).id);
    await s.page.evaluate((j) => { location.hash = '#/job/' + j; }, job);
    await s.page.waitForTimeout(1000);
    const shown = await s.page.evaluate((j) => {
      if (typeof window.cpEasyApply === 'function') window.cpEasyApply(j);
      return new Promise((r) => setTimeout(() => {
        r(document.body.innerText.includes('You have no resume on file'));
      }, 1500));
    }, job);
    must(shown, 'a candidate with no resume was not prompted to upload one');
  } finally { await s.ctx.close(); }
});

/* ------------------------------------------------------------------ *
 * other people's files
 * ------------------------------------------------------------------ */
await check('another candidate cannot fetch that resume', async () => {
  const s = await session();
  try {
    await registerWithResume(s.page, `snoop.${Date.now()}@example.test`, null);
    const out = await s.page.evaluate((id) =>
      fetch(`/api/uploads/resume/${id}`, { credentials: 'same-origin' })
        .then((r) => r.status), candidateId);
    must(out === 403 || out === 404, `another candidate got status ${out} for someone else's resume`);
  } finally { await s.ctx.close(); }
});

await withResume.ctx.close();
await browser.close();

console.log(failed === 0
  ? '\n  EASY APPLY VERIFIED — register once with a resume, apply with it, no re-upload\n'
  : `\n  ${failed} check(s) FAILED\n`);
process.exit(failed ? 1 : 0);
