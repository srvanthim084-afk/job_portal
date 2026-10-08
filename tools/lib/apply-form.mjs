/**
 * The application form behind Apply Now (web/teamlink-walkin-jobs.js,
 * 0106), for verify scripts that only need to get an application in.
 *
 * completeApplyForm(page): waits for the form, fills whatever required
 * field is still empty (the profile prefills the rest), attaches a small
 * PDF when there is no resume on file, submits, and returns
 * { state: 'done' | 'duplicate' | 'error' | 'none', ref, message }.
 *
 * Since 0118 Apply Now is one click for a signed-in candidate
 * (web/teamlink-one-click-apply.js): no form; a toast "Applied successfully
 * to <job>" (#tl1cDone) counts as 'done', "You have already applied"
 * (#tl1cAlready) as 'duplicate'. A candidate with no resume gets the
 * "Please complete your profile to apply" prompt (#tl1cProfile): this helper
 * puts a resume on file and applies again, so callers still get an
 * application. The form is still handled for anything that opens it.
 */
export const TINY_PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');

export async function applyFormOpen(page, timeout = 6000) {
  return page.waitForSelector('#tlafForm, #tlafDup', { timeout }).then(() => true, () => false);
}

/** The one-click result: 'done' | 'duplicate' | null when not on screen. */
export async function oneClickResult(page) {
  return page.evaluate(() => (document.getElementById('tl1cDone')
    ? { state: 'done', ref: (document.getElementById('tl1cRef') || {}).textContent || '' }
    : document.getElementById('tl1cAlready')
      ? { state: 'duplicate', ref: (document.querySelector('#tl1cAlready small') || {}).textContent || '' }
      : null));
}

export async function completeApplyForm(page, opts = {}) {
  const seen = await page.waitForSelector('#tlafForm, #tlafDup, #tl1cDone, #tl1cAlready, #tl1cProfile, #tl1cFail', { timeout: opts.timeout || 6000 })
    .then(() => true, () => false);
  if (!seen) return { state: 'none' };
  if (await page.$('#tl1cFail')) return { state: 'error', message: await page.evaluate(() => (document.getElementById('tl1cMsg') || {}).textContent || '') };
  if (await page.$('#tl1cProfile')) {
    const jobId = await page.evaluate(() => (document.getElementById('tl1cProfile') || {}).dataset.job);
    await page.evaluate(() => { const c = document.getElementById('tl1cPpCancel'); if (c) c.click(); });
    await page.evaluate(async () => {
      const f = new File([new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52, 10, 37, 37, 69, 79, 70, 10])], 'resume.pdf', { type: 'application/pdf' });
      await TL.uploadResume(f); await TL.refresh();
    });
    await page.evaluate((id) => window.applyToJob(id), jobId);
    await page.waitForSelector('#tl1cDone, #tl1cAlready, #tl1cFail', { timeout: opts.submitTimeout || 30000 }).catch(() => {});
  }
  const quick = await oneClickResult(page);
  if (quick) return quick;
  if (await page.$('#tlafDup')) return { state: 'duplicate', ref: await page.evaluate(() => (document.querySelector('#tlafDup .ref') || {}).textContent || '') };
  await page.evaluate(() => { const b = document.getElementById('tlafEditAll'); if (b) b.click(); });
  const fill = async (sel, v) => {
    const cur = await page.$eval(sel, (e) => e.value).catch(() => null);
    if (cur === null || String(cur).trim()) return;
    await page.fill(sel, v);
  };
  await fill('#tlafName', opts.name || 'Verify Candidate');
  await fill('#tlafMobile', opts.mobile || ('9' + String(Math.floor(1e8 + Math.random() * 9e8))));
  await fill('#tlafEmail', opts.email || `verify.${Date.now().toString(36)}@tl-verify.test`);
  await fill('#tlafLoc', 'Hyderabad');
  await fill('#tlafExp', '1');
  await page.evaluate(() => {
    for (const id of ['tlafQual', 'tlafNotice']) {
      const s = document.getElementById(id);
      if (s && !s.value) { const o = Array.from(s.options).find((x) => x.value); if (o) { s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); } }
    }
  });
  const needsFile = await page.evaluate(() => !document.getElementById('tlafResumeOnFile'));
  if (needsFile) await page.setInputFiles('#tlafResume', { name: 'resume.pdf', mimeType: 'application/pdf', buffer: TINY_PDF });
  /* Screening questions, when the job has them: the first choice / a number. */
  await page.evaluate(() => {
    document.querySelectorAll('#tlafQs .tlsq-q').forEach((q) => {
      const chip = q.querySelector('.tlsq-chip:not(.on)');
      if (chip && !q.querySelector('.tlsq-chip.on')) { chip.click(); return; }
      const inp = q.querySelector('input');
      if (inp && !inp.value) {
        inp.value = inp.type === 'number' ? '1' : inp.type === 'date' ? new Date(Date.now() + 86400000 * 7).toISOString().slice(0, 10) : 'Hyderabad';
        inp.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
  });
  await page.click('#tlafSubmit');
  const out = await page.waitForSelector('#tlafDone, #tlafDup, #tlafMsg:not(:empty)', { timeout: opts.submitTimeout || 30000 }).catch(() => null);
  if (!out) return { state: 'error', message: 'no result' };
  if (await page.$('#tlafDone')) return { state: 'done', ref: await page.evaluate(() => (document.getElementById('tlafRef') || {}).textContent || '') };
  if (await page.$('#tlafDup')) return { state: 'duplicate', ref: await page.evaluate(() => (document.querySelector('#tlafDup .ref') || {}).textContent || '') };
  return { state: 'error', message: await page.evaluate(() => (document.getElementById('tlafMsg') || {}).innerText || '') };
}

/** Close the result (the toast, or the form / prompt). */
export async function closeApplyForm(page) {
  await page.evaluate(() => {
    const h = document.getElementById('tl1cToastHost'); if (h) h.innerHTML = '';
    if (typeof window.fcrCloseModal === 'function') window.fcrCloseModal();
  });
}
