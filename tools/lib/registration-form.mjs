/**
 * The candidate registration form (web/teamlink-registration.js, 0109), for
 * verify scripts that only need to get through sign-up.
 *
 * Since 0109 the form is seven steps - Basic, Education, Experience,
 * Preferences, Resume, Account, Review - with the owner's required fields
 * (branch, total experience, preferred role, a resume, confirm password and
 * the three consents). Every input keeps the id it had on the old single
 * page; it simply lives on a step, so each field is revealed where it is
 * (TLRegistration.reveal) before it is filled.
 *
 * fillRegistration(page, opts) fills every required field, uploads the
 * resume when the page has none yet, goes to Review, ticks the consents and
 * validates. It does NOT press Create Account - the caller does, so it can
 * check what it needs to first. Returns TLRegistration.problems() (empty
 * when the form is ready).
 *
 *   opts: name, email, password, phone, location, qualification,
 *         specialization, expBand, skills, prefRole, prefLocation,
 *         expSalary, notice, resume (a path; TL_TEST_RESUME by default),
 *         skip (ids to leave as they are),
 *         resumeFirst (upload the resume before typing, as a candidate who
 *           lets the parser fill the form does) and onlyEmpty (then type
 *           only into fields the parser left empty)
 */
export const TEST_RESUME = process.env.TL_TEST_RESUME || 'var/test-resumes/Resume - Sravanthi.pdf';

export async function fillRegistration(page, opts = {}) {
  /* 0117: registration opens resume-first; this helper fills the seven-step
     form, which is the "Enter my details manually" path. */
  await page.evaluate(() => { if (window.TLResumeFirst) window.TLResumeFirst.manual(); });
  await page.waitForFunction(() => window.TLRegistration && document.getElementById('regName'), null, { timeout: 15000 });
  const skip = new Set(opts.skip || []);
  const reveal = (id) => page.evaluate((i) => window.TLRegistration.reveal(i), id);
  const filled = (id) => page.evaluate((i) => !!String((document.getElementById(i) || {}).value || '').trim(), id);
  const put = async (id, v) => {
    if (skip.has(id) || v === undefined || v === null) return;
    if (opts.onlyEmpty && !/^reg(Email|Password|ConfirmPassword)$/.test(id) && await filled(id)) return;
    await reveal(id);
    await page.fill('#' + id, String(v));
  };
  const pick = async (id, v) => {
    if (skip.has(id)) return;
    if (opts.onlyEmpty && await filled(id)) return;
    await reveal(id);
    await page.evaluate(({ i, want }) => {
      const s = document.getElementById(i);
      const o = Array.from(s.options).find((x) => x.value && (!want || x.value === want || x.textContent.trim() === want))
        || Array.from(s.options).find((x) => x.value);
      s.value = o.value;
      s.dispatchEvent(new Event('change', { bubbles: true }));
    }, { i: id, want: v || '' });
  };

  const upload = async () => {
    if (await page.evaluate(() => !!(window.TL && TL.pendingResume))) return;
    await reveal('regPassword');
    await page.evaluate(() => window.triggerRegisterResumeUpload());
    await page.setInputFiles('#regResumeFileInput', opts.resume || TEST_RESUME);
    await page.waitForFunction(() => /analyzed|could|couldn/i.test((document.getElementById('regResumeStatus') || {}).textContent || ''),
      null, { timeout: 30000 });
  };
  if (opts.resumeFirst) await upload();

  /* 1 Basic */
  await put('regName', opts.name || 'Verify Candidate');
  await put('regMobile', opts.phone || ('9' + String(Math.floor(1e8 + Math.random() * 9e8))));
  await put('regLocation', opts.location || 'Hyderabad');
  await put('regEmail', opts.email);
  /* 2 Education */
  await pick('regQualification', opts.qualification || 'B.Tech');
  await put('regSpecialization', opts.specialization || 'Commerce');
  /* 3 Experience & Skills */
  await pick('regExpBand', opts.expBand || 'fresher');
  await put('regSkills', opts.skills || 'Excel, Communication');
  /* 4 Preferences */
  await put('regPrefRole', opts.prefRole || 'Store Associate');
  await put('regPrefLocation', opts.prefLocation || 'Hyderabad');
  await put('regExpSalary', opts.expSalary || '4');
  await pick('regNotice', opts.notice || 'Immediate');
  await page.evaluate(() => {
    const m = document.querySelector('#regWorkModeGroup input[type="checkbox"]');
    if (m && !document.querySelector('#regWorkModeGroup input[type="checkbox"]:checked')) m.click();
  });
  /* 5 Resume */
  await upload();
  /* 6 Account */
  const pw = opts.password || ('Verify' + Date.now().toString(36) + '7');
  await put('regPassword', pw);
  await put('regConfirmPassword', pw);
  /* 7 Review: the consents, then the form's own validation */
  return page.evaluate(() => {
    window.TLRegistration.go(7);
    ['regConsentComms', 'regConsentTerms', 'regConsentResume'].forEach((id) => {
      const c = document.getElementById(id); if (c && !c.checked) c.click();
    });
    if (typeof validateRegisterForm === 'function') validateRegisterForm();
    return window.TLRegistration.problems();
  });
}

/** fillRegistration, then Create Account, then wait for the candidate session. */
export async function registerThroughForm(page, opts = {}) {
  const left = await fillRegistration(page, opts);
  if (left.length) throw new Error('the registration form did not validate: ' + JSON.stringify(left));
  await page.click('#regSubmitBtn');
  await page.waitForFunction(() => typeof STATE !== 'undefined' && STATE.session && STATE.session.role === 'candidate', null,
    { timeout: opts.timeout || 20000 });
}
