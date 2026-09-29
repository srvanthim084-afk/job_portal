/**
 * Read the resumes already on file again, and make the stored profile
 * agree with them.
 *
 *     node tools/reparse-resumes.mjs            # report what would change
 *     node tools/reparse-resumes.mjs --confirm  # do it
 *
 * WHY. The resume parser had faults that left a designation and an
 * employer empty on most prose CVs, and on a few profiles wrote something
 * worse than nothing: a section heading as the designation ("Career
 * Objective"), a sentence from a career objective as the employer ("where
 * I can utilize my knowledge of Core Java..."), a project's client as a
 * fresher's current employer.
 *
 * The resumes are still in storage, so nobody has to upload anything
 * again. This asks the server to read each one with the fixed parser and
 * reports, per candidate, what changed.
 *
 * WHAT IT WILL AND WILL NOT TOUCH.
 *
 * The re-parse itself fills blanks only - api/src/resume/apply.js never
 * overwrites a value that is already there, so a field a human corrected
 * stays as the human left it. That is what makes this safe to run over
 * real candidates.
 *
 * On top of that, this tool corrects a stored designation or employer in
 * exactly three cases, each printed before it is written:
 *
 *   1. the value is one the parser now refuses outright - a heading, a
 *      sentence, or a paragraph;
 *   2. the value carries a tagline the résumé stacked beside the job
 *      title ("Software Developer | Computer Science Graduate");
 *   3. an employer is stored for someone whose résumé states no
 *      experience and lists no employment at all - a fresher has no
 *      current employer, and what was read was a project or a training.
 *
 * Nothing else is overwritten, and nothing is deleted.
 */
import { chromium } from 'playwright';
import { plausibleValue } from '../api/src/resume/fields.js';

const BASE = (process.env.TL_URL || 'http://localhost:4323/').replace(/\/$/, '');
const CONFIRM = process.argv.includes('--confirm');

/* A job title with a tagline bolted on. The title is the first segment. */
const TAGLINE = /\s(?:\||•|·|•)\s/;

const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
await page.goto(`${BASE}/`, { waitUntil: 'load' });
await page.waitForFunction(() => window.TL && window.TL.ready === true, { timeout: 25000 });

const api = async (m, p, b) => {
  const r = await page.evaluate(([mm, pp, bb]) => window.TL.api[mm](pp, bb)
    .then((v) => ({ ok: 1, v }), (e) => ({ ok: 0, c: e.code, m: e.message })), [m, p, b]);
  if (r.ok) return r.v;
  throw new Error(`${r.c || 'FAILED'}: ${r.m || ''}`);
};

const short = (s, n = 29) => String(s == null ? '' : s).slice(0, n - 1).padEnd(n);

try {
  await api('post', '/auth/login', {
    email: process.env.TL_RECRUITER || 'teamlinkmed001@tmlink.in',
    password: process.env.TL_RECRUITER_PASSWORD || 'Teamlink@2026',
    role: 'recruiter',
  });

  const all = (await api('get', '/candidates?limit=500')).candidates || [];
  const onFile = all.filter((c) => c.resumeFile);

  console.log(`${all.length} candidates, ${onFile.length} with a resume on file`);

  /*
   * REPORT MODE WRITES NOTHING - not even the harmless gap-fill.
   *
   * Re-reading a résumé is itself a write, because the server fills the
   * blank fields as it reads. So without --confirm this does not ask the
   * server to read anything: it judges the values already stored, which
   * is enough for the first two corrections. The third needs the résumé's
   * own answer and is only checked during the real run.
   */
  if (!CONFIRM) {
    const missing = onFile.filter((c) => !c.title || !c.currentCompany || !(c.skills || []).length);
    const suspect = onFile.filter((c) =>
      (c.title && (!plausibleValue(c.title, { maxWords: 9 }) || TAGLINE.test(c.title)))
      || (c.currentCompany && !plausibleValue(c.currentCompany, { maxWords: 6 })));

    console.log(`${missing.length} are missing a designation, an employer or skills`);
    missing.slice(0, 12).forEach((c) => {
      const gaps = [!c.title && 'designation', !c.currentCompany && 'employer',
        !(c.skills || []).length && 'skills'].filter(Boolean);
      console.log(`   ${short(c.name)} missing ${gaps.join(', ')}`);
    });
    if (missing.length > 12) console.log(`   … and ${missing.length - 12} more`);

    console.log(`\n${suspect.length} hold a designation or employer that is wrong:`);
    suspect.forEach((c) => {
      const bad = [];
      if (c.title && !plausibleValue(c.title, { maxWords: 9 })) bad.push(`designation ${JSON.stringify(c.title)} is not a job title`);
      else if (c.title && TAGLINE.test(c.title)) bad.push(`designation ${JSON.stringify(c.title)} carries a tagline`);
      if (c.currentCompany && !plausibleValue(c.currentCompany, { maxWords: 6 })) bad.push(`employer ${JSON.stringify(c.currentCompany.slice(0, 60))} is not a company name`);
      console.log(`   ${short(c.name)} ${bad.join('; ')}`);
    });

    console.log('\nNothing was read and nothing was written.');
    console.log('Run again with --confirm to re-read every résumé and apply these.');
    process.exit(0);
  }

  console.log('reading each one again…\n');

  let readFailed = 0;
  const filled = [];      // gained a value it did not have
  const corrected = [];   // had a value that was wrong

  for (const c of onFile) {
    let after; let fields;
    try {
      const out = await api('post', `/candidates/${encodeURIComponent(c.id)}/resume/reparse`, {});
      after = out.candidate || out;
      fields = (out.parse && out.parse.fields) || {};
    } catch (e) {
      readFailed++;
      console.log(`   could not read  ${short(c.name)} ${String(e.message).slice(0, 60)}`);
      continue;
    }

    /* What the re-parse filled in, purely by having been blank. */
    const gained = [];
    if (!c.title && after.title) gained.push(`designation "${after.title}"`);
    if (!c.currentCompany && after.currentCompany) gained.push(`employer "${after.currentCompany}"`);
    if (!(c.skills || []).length && (after.skills || []).length) {
      gained.push(`${after.skills.length} skills`);
    }
    if (gained.length) {
      filled.push(c.id);
      console.log(`   ${short(c.name)} + ${gained.join(', ')}`);
    }

    /* Now the three corrections. `after` is the state on the profile; the
       parser's own answer for this résumé is in `fields`. */
    const fix = {};
    const why = [];

    const title = after.title || '';
    if (title) {
      if (!plausibleValue(title, { maxWords: 9 })) {
        fix.title = plausibleValue(fields.title || '', { maxWords: 9 }) || '';
        why.push(`designation ${JSON.stringify(title)} is not a job title`);
      } else if (TAGLINE.test(title)) {
        fix.title = String(title).split(TAGLINE)[0].trim();
        why.push(`designation ${JSON.stringify(title)} carries a tagline`);
      }
    }

    const co = after.currentCompany || '';
    if (co) {
      const statedYears = Number(fields.expYears);
      const noHistory = !(fields.employmentHistory || []).length;
      const fresher = noHistory && (!Number.isFinite(statedYears) || statedYears === 0);
      if (!plausibleValue(co, { maxWords: 6 })) {
        fix.currentCompany = plausibleValue(fields.currentCompany || '', { maxWords: 6 }) || '';
        why.push(`employer ${JSON.stringify(co.slice(0, 60))} is not a company name`);
      } else if (fresher && !fields.currentCompany) {
        fix.currentCompany = '';
        why.push(`employer ${JSON.stringify(co)} but the résumé states no experience`);
      }
    }

    if (!Object.keys(fix).length) continue;

    corrected.push(c.id);
    console.log(`   ${short(c.name)} ! ${why.join('; ')}`);
    for (const [k, v] of Object.entries(fix)) {
      console.log(`      ${k} -> ${v ? JSON.stringify(v) : '(cleared)'}`);
    }
    if (CONFIRM) await api('put', `/candidates/${encodeURIComponent(c.id)}`, fix);
  }

  console.log(`\n${filled.length} profile(s) gained a value that was missing`);
  console.log(`${corrected.length} profile(s) held a value that was wrong`);
  if (readFailed) console.log(`${readFailed} resume(s) could not be read`);
  if (!CONFIRM) console.log('\nNothing was written. Run again with --confirm to apply.');
} finally {
  await browser.close();
}
