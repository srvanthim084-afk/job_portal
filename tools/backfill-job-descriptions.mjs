/**
 * Give every posting a description a candidate can actually read.
 *
 *     node tools/backfill-job-descriptions.mjs            # report only
 *     node tools/backfill-job-descriptions.mjs --confirm  # write it
 *
 * WHY. Four requirements on the board had this in the description field:
 *
 *     "Created automatically because a candidate applied for this role
 *      and no requirement existed for it. Add the details and publish it
 *      when you are ready."
 *
 * That is a note to the recruiter, sitting in the field the candidate
 * reads - and because those jobs were also left as drafts, no candidate
 * could see them at all. The recruiter's Jobs screen showed eight jobs
 * and the candidate site showed four, which is what was reported as
 * "posted jobs are not appearing in the candidate portal".
 *
 * New postings no longer have this problem: the JD is written by
 * api/src/ai/jd.js for every way a job can be created. This fixes the
 * ones already in the database.
 *
 * NOTHING IS MAILED. It writes through PUT /jobs/:id, which updates the
 * record and sends nothing. POST /jobs/:id/publish is the route that
 * alerts every matching candidate, and it is deliberately not used here -
 * making four old requirements visible is not a reason to message
 * hundreds of people.
 *
 * A DESCRIPTION SOMEBODY WROTE IS NEVER TOUCHED. Only the ones that fail
 * isPlaceholderDescription - empty, a known stub, or under 80 characters.
 */
import { chromium } from 'playwright';
import { buildJobDescription, buildStructuredJd, isPlaceholderDescription, suggestSkills }
  from '../api/src/ai/jd.js';

/*
 * A DESCRIPTION THIS GENERATOR WROTE, recognised by how it opens.
 *
 * The specialty patterns in ai/jd.js were broken when these postings were
 * saved: stems like `cardiolog` sat inside a pattern whose closing word
 * boundary can never follow them, so "Cardiologist" and "Radiologist"
 * matched nothing and were given the generic duties — as were the
 * clinical-research roles, which had no family at all. The patterns are
 * fixed; these are the rows written before that.
 *
 * Only text with one of these openings is refreshed. Anything a recruiter
 * typed is left exactly as it is, because this cannot tell a good short
 * description from a bad one and must not try.
 */
const GENERATED_OPENER = [
  /^(?:we|[A-Z][\w&.,'-]*) (?:are|is) hiring /i,
  /^A walk-in is being held for /i,
  /^An internship is open for /i,
  /^\d+ \w+ internship for /i,
  /^Walk-in interviews for /i,
  /^[^.\n]{2,80} \([^)]{2,40}\), [^.\n]{2,60}\./,
];
const wasGenerated = (text) =>
  GENERATED_OPENER.some((re) => re.test(String(text || '').trim()));

const BASE = (process.env.TL_URL || 'http://localhost:4323/').replace(/\/$/, '');
const CONFIRM = process.argv.includes('--confirm');
/* Publishing a draft makes it visible. Off for anyone who would rather
   check each one first. */
const PUBLISH = !process.argv.includes('--no-publish');

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

try {
  await api('post', '/auth/login', {
    email: process.env.TL_ADMIN || 'admin@teamlink.com',
    password: process.env.TL_ADMIN_PASSWORD || 'TeamLink@2026',
    role: 'admin',
  });

  const jobs = (await api('get', '/bootstrap')).data.jobs || [];
  const stub = jobs.filter((j) => isPlaceholderDescription(j.desc ?? j.description));
  const hidden = jobs.filter((j) => j.status === 'draft');

  /*
   * Generated text whose duties belong to a different profession now.
   * The family is recomputed and the duties compared against what is
   * stored; identical means nothing changed and the row is left alone.
   */
  const stale = jobs.filter((j) => {
    const text = j.desc ?? j.description;
    if (isPlaceholderDescription(text) || !wasGenerated(text)) return false;
    const fresh = buildStructuredJd({
      title: j.title, department: j.department, location: j.location,
      skills: j.skills, exp: j.exp, qualification: j.education, openings: j.openings,
    });
    const stored = (j.responsibilities || []).join(' | ');
    return !!stored && fresh.responsibilities.join(' | ') !== stored;
  });

  console.log(`${jobs.length} job(s) on the board`);
  console.log(`   ${jobs.filter((j) => j.status === 'open').length} visible to candidates`);
  console.log(`   ${hidden.length} draft — invisible to candidates`);
  console.log(`   ${stub.length} with no real description`);
  console.log(`   ${stale.length} whose generated duties describe the wrong profession\n`);

  /* A posting can have a perfectly good description and still match
     nobody, so the skill-less ones are collected in their own right
     rather than only being caught when something else is wrong. */
  const skillless = jobs.filter((j) => !(j.skills || []).length
    && suggestSkills({ title: j.title, department: j.department }).length > 0);
  if (skillless.length) console.log(`   ${skillless.length} with no skills — matches nobody`);

  if (!stub.length && !hidden.length && !stale.length && !skillless.length) {
    console.log('Nothing to do.'); process.exit(0);
  }

  const todo = [...new Set([...stub, ...hidden, ...stale, ...skillless])];
  let fixed = 0;
  let refreshed = 0;
  let published = 0;
  let skilled = 0;

  for (const j of todo) {
    const needsJd = isPlaceholderDescription(j.desc ?? j.description);
    const needsRefresh = !needsJd && stale.indexOf(j) >= 0;
    const needsPublish = PUBLISH && j.status === 'draft';

    /*
     * SKILLS, because an empty skills list scores zero against everyone.
     *
     * A requirement created from an application arrived with
     * `skills = '{}'`, and skills are what the matcher scores on - so
     * "Radiologist" matched no radiologist, including the one whose
     * application created it. Filled from the title's family, and only
     * ever when the row has none: a list somebody typed is theirs.
     */
    const skills = (j.skills || []).length
      ? j.skills
      : suggestSkills({ title: j.title, department: j.department });
    const needsSkills = !(j.skills || []).length && skills.length > 0;

    if (!needsJd && !needsRefresh && !needsPublish && !needsSkills) continue;

    const generated = buildJobDescription({
      title: j.title, location: j.location, skills,
      exp: j.exp, education: j.education, openings: j.openings,
      postingKind: j.postingKind || j.type,
    });

    const change = {};
    if (needsRefresh) {
      /* The structured builder, because these are full postings rather
         than a one-line stub — and it is what wrote them in the first
         place, so only the parts that were wrong change. */
      const fresh = buildStructuredJd({
        title: j.title, department: j.department, location: j.location,
        skills, exp: j.exp, qualification: j.education, openings: j.openings,
      });
      change.desc = fresh.description;
      change.responsibilities = fresh.responsibilities;
      change.requirements = fresh.qualifications;
      console.log(`      duties now read as ${fresh.family}`);
    }
    if (needsJd) {
      /*
       * A SHORT GENERATED DESCRIPTION IS STILL A GENERATED ONE.
       *
       * "We are hiring a Radiologist. The work centres on Radiology, CT,
       * MRI and USG." is 76 characters, so it falls under the stub
       * threshold — but the duties stored beside it came from the same
       * broken generator and were plain wrong. Filling them only when
       * they are EMPTY left a radiologist owning "the day-to-day work of
       * the role".
       *
       * So when the text on the row was written by this generator, the
       * duties are replaced too. When it was not, they are a human's and
       * are only ever filled in where blank.
       */
      const mine = wasGenerated(j.desc ?? j.description);
      if (mine) {
        const fresh = buildStructuredJd({
          title: j.title, department: j.department, location: j.location,
          skills, exp: j.exp, qualification: j.education, openings: j.openings,
        });
        change.desc = fresh.description;
        change.responsibilities = fresh.responsibilities;
        change.requirements = fresh.qualifications;
      } else {
        change.desc = generated.description;
        if (!(j.responsibilities || []).length) change.responsibilities = generated.responsibilities;
        if (!(j.requirements || []).length) change.requirements = generated.requirements;
      }
    }
    if (needsPublish) change.status = 'open';
    if (needsSkills) change.skills = skills;

    console.log(`   ${String(j.title).slice(0, 26).padEnd(27)} `
      + `${needsJd ? 'new JD ' : needsRefresh ? 'refresh' : '       '}`
      + `  ${needsPublish ? 'publish' : '       '}`
      + `  ${needsSkills ? 'skills:' + skills.length : '        '}`);
    if (needsJd) console.log(`      ${generated.description.slice(0, 110)}`);

    if (!CONFIRM) continue;

    /* PUT carries the whole record, so the required fields go back
       unchanged alongside the ones being fixed. */
    await api('put', `/jobs/${encodeURIComponent(j.id)}`, {
      title: j.title,
      companyId: j.companyId,
      ...(j.location ? { location: j.location } : {}),
      ...(j.skills && j.skills.length ? { skills: j.skills } : {}),
      ...change,
    });
    if (needsJd) fixed++;
    if (needsRefresh) refreshed++;
    if (needsPublish) published++;
    if (needsSkills) skilled++;
  }

  /*
   * THE DEPARTMENT IS REPORTED, NEVER REWRITTEN.
   *
   * pushJob guessed it from the title, so ten medical postings are filed
   * under Engineering and Analytics. Any value written here would be
   * another guess, and this one belongs to whoever posted the job — so
   * the mismatch is named and left for them.
   */
  const misfiled = jobs.filter((j) => {
    const dept = String(j.department || '');
    if (!dept) return false;
    const fam = buildStructuredJd({ title: j.title, department: dept }).family;
    const clinical = ['doctor', 'nurse', 'allied', 'medical_records',
      'medical_sales', 'clinical_ops'].indexOf(fam) >= 0;
    return clinical && /^(engineering|analytics|design|product)$/i.test(dept);
  });
  if (misfiled.length) {
    console.log(`\n${misfiled.length} posting(s) are filed under a department that does not fit.`);
    console.log('Not changed — the department is yours to set, and a guess is what put');
    console.log('them here in the first place. Edit them in Manage Jobs:');
    misfiled.forEach((j) => console.log(`   ${String(j.title).slice(0, 40).padEnd(42)} ${j.department}`));
  }

  if (!CONFIRM) {
    console.log('\nNothing was written. Run again with --confirm to apply.');
    console.log('Add --no-publish to write the descriptions but leave drafts hidden.');
  } else {
    console.log(`\n${fixed} description(s) written, ${refreshed} refreshed, `
      + `${published} published, ${skilled} given a skills list`);
    console.log('No candidate was mailed — this writes the record and sends nothing.');
    const after = (await api('get', '/bootstrap')).data.jobs || [];
    console.log(`${after.filter((x) => x.status === 'open').length} of ${after.length} `
      + 'job(s) are now visible to candidates');
  }
} finally {
  await browser.close();
}
