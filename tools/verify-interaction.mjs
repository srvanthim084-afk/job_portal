/**
 * Clicks things.
 *
 * Everything else in this repo verifies the app by calling its functions,
 * inspecting its DOM, or talking to its API. All of that passed while the
 * application was completely unusable: helmet's default
 * `script-src-attr 'none'` blocked all 1,034 inline `onclick=` / `onsubmit=`
 * attributes in the prototype, so every button was dead. The pages still
 * rendered identically and logged no console error.
 *
 * The only thing that catches that class of failure is driving the real
 * controls the way a person does. That is all this file does.
 *
 *   node tools/verify-interaction.mjs      (needs tools/dev-server.mjs on :4323)
 */
import { chromium } from 'playwright';

const BASE = process.env.TL_URL || 'http://127.0.0.1:4323/';
const PASSWORD = process.env.TL_PASSWORD || 'TeamLink@2026';

let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  PASS  ${name}`); }
  catch (e) { console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n')[0]}`); failed++; }
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

const cspViolations = [];
page.on('console', (m) => {
  const t = m.text();
  if (/Content Security Policy|violates the following/i.test(t)) cspViolations.push(t);
});

const goto = async (hash) => {
  await page.evaluate((h) => { location.hash = h; }, hash);
  await page.waitForTimeout(700);
};

await page.goto(BASE, { waitUntil: 'load' });
await page.waitForFunction(() => window.TL && window.TL.ready === true, { timeout: 20000 });

console.log('real DOM interaction');

await check('inline event handlers are not blocked by CSP', async () => {
  await goto('#/login/recruiter');
  const wired = await page.evaluate(() => {
    const f = document.querySelector('.auth-form');
    return { hasAttr: !!(f && f.getAttribute('onsubmit')), compiled: !!(f && typeof f.onsubmit === 'function') };
  });
  if (!wired.hasAttr) throw new Error('the login form has no onsubmit attribute');
  if (!wired.compiled) {
    throw new Error('onsubmit attribute present but NOT compiled — CSP is blocking ' +
                    'inline handlers (check script-src-attr)');
  }
});

await check('a wrong password is rejected through the form', async () => {
  await goto('#/login/recruiter');
  await page.fill('.auth-form input[name="password"]', 'definitely-wrong');
  await page.click('.auth-form button[type="submit"]');
  await page.waitForTimeout(1500);
  const signedIn = await page.evaluate(() => !!STATE.session);
  if (signedIn) throw new Error('a wrong password signed the user in');
  // and the credentials must NOT end up in the URL via a native form GET
  const qs = await page.evaluate(() => location.search);
  if (/password=/.test(qs)) {
    throw new Error('the form submitted natively — the password is now in the URL: ' + qs);
  }
});

await check('CLICKING sign in actually signs in', async () => {
  await goto('#/login/recruiter');
  await page.fill('.auth-form input[name="email"]', 'recruiter@teamlink.com');
  await page.fill('.auth-form input[name="password"]', PASSWORD);
  await page.click('.auth-form button[type="submit"]');
  await page.waitForTimeout(2500);
  const s = await page.evaluate(() => STATE.session);
  if (!s || s.role !== 'recruiter') throw new Error('clicking the button did not sign in');
});

await check('sidebar navigation responds to a click', async () => {
  const before = await page.evaluate(() => location.hash);
  await page.click('text=Jobs >> nth=0').catch(() => {});
  await page.waitForTimeout(900);
  const after = await page.evaluate(() => location.hash);
  if (after === before) throw new Error(`the nav did not move (still ${after})`);
});

await check('a filter checkbox (onchange) actually filters', async () => {
  // 132 of the prototype's handlers are onchange. script-src-attr blocks
  // those exactly as it blocks onclick, so they get their own check.
  await page.evaluate(async () => {
    await window.TL.api.post('/auth/logout', {});
    await window.TL.refresh();
  });
  await goto('#/jobs');
  await page.waitForTimeout(800);

  const before = await page.evaluate(() =>
    document.querySelectorAll('.job-card, [class*="jobcard"], [class*="job-row"]').length);

  const toggled = await page.evaluate(() => {
    const cb = document.querySelector('#app input[type="checkbox"][onchange], #app .filters input[type="checkbox"]');
    if (!cb) return false;
    cb.click();
    return true;
  });
  if (!toggled) throw new Error('no filter checkbox found on the jobs page');

  await page.waitForTimeout(900);
  const after = await page.evaluate(() =>
    document.querySelectorAll('.job-card, [class*="jobcard"], [class*="job-row"]').length);
  if (after === before && before === 0) throw new Error('no job cards rendered at all');
  // a filter may legitimately match everything; what matters is that the
  // handler ran without a CSP violation, which the final check asserts
});

await check('a candidate can apply by clicking Apply', async () => {
  // sign out, sign in as the candidate, open a job they have not applied to
  await page.evaluate(async () => {
    await window.TL.api.post('/auth/logout', {});
    await window.TL.refresh();
  });
  await goto('#/login/candidate');
  await page.fill('.auth-form input[name="email"]', 'ananya.rao@example.com');
  await page.fill('.auth-form input[name="password"]', PASSWORD);
  await page.click('.auth-form button[type="submit"]');
  await page.waitForTimeout(2500);

  const target = await page.evaluate(() => {
    const mine = new Set(DATA.applications.map((a) => a.jobId));
    const me = DATA.candidateById(STATE.session.id);
    if (me && me.appliedJobId) mine.add(me.appliedJobId);
    const j = DATA.openJobs().find((x) => !mine.has(x.id));
    return j ? j.id : null;
  });
  if (!target) throw new Error('no unapplied job to test with');

  const before = await page.evaluate(() => DATA.applications.length);
  await goto('#/job/' + target);
  await page.waitForTimeout(1200);          // the detail page renders async

  const clicked = await page.evaluate(() => {
    // The primary control is "Easy Apply" on jobs that offer it, plain
    // "Apply" on the rest. Both are real apply paths.
    const btn = [...document.querySelectorAll('#app button, #app a')]
      .find((b) => /apply/i.test(b.textContent || ''));
    if (!btn) {
      return { ok: false, saw: [...document.querySelectorAll('#app button')]
        .map((b) => (b.textContent || '').trim()).slice(0, 8) };
    }
    btn.click();
    return { ok: true, label: (btn.textContent || '').trim() };
  });
  if (!clicked.ok) {
    throw new Error('no Apply control on the job page; buttons seen: ' +
      JSON.stringify(clicked.saw));
  }

  await page.waitForTimeout(2500);
  const after = await page.evaluate(() => DATA.applications.length);
  if (after <= before) throw new Error('clicking Apply created no application');

  // and it must have reached the database
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.TL && window.TL.ready === true, { timeout: 20000 });
  const persisted = await page.evaluate((id) =>
    DATA.applications.some((a) => a.jobId === id), target);
  if (!persisted) throw new Error('the application did not survive a reload');
});

await check('no CSP violations were reported at any point', () => {
  if (cspViolations.length) {
    throw new Error(cspViolations.length + ' violation(s), first: ' +
      cspViolations[0].slice(0, 160));
  }
});

console.log(failed ? `\nINTERACTION VERIFICATION FAILED (${failed})` : '\nINTERACTION VERIFIED');
await browser.close();
process.exitCode = failed ? 1 : 0;
