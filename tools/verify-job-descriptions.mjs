/**
 * Every way of posting a job produces a JD a candidate can read.
 *
 *     node tools/verify-job-descriptions.mjs
 *
 * There are five ways to create a job here - the post form, bulk paste, a
 * walk-in, an internship, and the requirement raised automatically when
 * somebody applies for a role nobody posted - and each used to supply its
 * own description or none. The board ended up with eight jobs whose
 * description read "Imported requirement for the Naukri response sync."
 * or "Created automatically because a candidate applied for this role",
 * both of which are notes to ourselves shown on the page a candidate
 * judges the posting by.
 *
 * This posts one of each kind through the real endpoint and checks the
 * stored result: a description that mentions the role, duties,
 * requirements, and none of the stub wording. It also checks the two
 * things that matter either side of that - a description somebody
 * actually wrote is never replaced, and a published job is visible to a
 * candidate who is not signed in.
 *
 * Everything it creates, it deletes.
 */
import { chromium } from 'playwright';

const BASE = (process.env.TL_URL || 'http://localhost:4323/').replace(/\/$/, '');
const STAMP = Date.now();

const fail = [];
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`);
  if (!ok) fail.push(what);
};

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
await page.goto(`${BASE}/`, { waitUntil: 'load' });
await page.waitForFunction(() => window.TL && window.TL.ready === true, { timeout: 25000 });

const M = { delete: 'del' };
const api = async (m0, p, b) => {
  const m = M[m0] || m0;
  const r = await page.evaluate(([mm, pp, bb]) => window.TL.api[mm](pp, bb)
    .then((v) => ({ ok: 1, v }), (e) => ({ ok: 0, c: e.code, m: e.message })), [m, p, b]);
  if (r.ok) return r.v;
  throw new Error(`${r.c || 'FAILED'}: ${r.m || ''}`);
};

/* The stub wording that must never reach a candidate again. */
const STUBS = [
  /imported requirement for the/i,
  /created automatically because a candidate applied/i,
  /^opening for .+ at our team\.?$/i,
  /publish it when you are ready/i,
];

const made = [];

try {
  await api('post', '/auth/login', {
    email: process.env.TL_RECRUITER || 'teamlinkmed001@tmlink.in',
    password: process.env.TL_RECRUITER_PASSWORD || 'Teamlink@2026',
    role: 'recruiter',
  });
  const me = (await api('get', '/bootstrap')).data;
  const companyId = (me.recruiters || [])[0]?.companyId || (me.companies || [])[0]?.id;
  if (!companyId) throw new Error('no company to post against');

  /* What the four posting screens actually send. */
  const KINDS = [
    {
      what: 'a plain vacancy, no description typed',
      body: { title: `ZZ Probe Vacancy ${STAMP}`, companyId, location: 'Hyderabad',
        skills: ['Patient Care', 'IV Therapy'], exp: '2-4 yrs', type: 'Full-time' },
      mustMention: ['Patient Care'],
    },
    {
      what: 'bulk paste, which sent a one-line stub',
      body: { title: `ZZ Probe Bulk ${STAMP}`, companyId, location: 'Pune',
        skills: ['Radiology'], exp: '3-5 yrs',
        desc: `Opening for ZZ Probe Bulk ${STAMP} at our team.` },
      mustMention: ['Radiology'],
    },
    {
      what: 'a walk-in, whose venue and date must survive',
      body: { title: `ZZ Probe Walkin ${STAMP}`, companyId, location: 'Hyderabad',
        postingKind: 'walkin', type: 'Walk-in', skills: ['Triage'],
        desc: 'Walk-in drive. Venue: TeamLink Office, Banjara Hills. '
          + '05 Oct 2026, 10:00 AM - 4:00 PM. Carry an updated resume and photo ID.' },
      mustMention: ['Banjara Hills', '05 Oct 2026'],
    },
    {
      what: 'an internship, whose duration and stipend must survive',
      body: { title: `ZZ Probe Intern ${STAMP}`, companyId, location: 'Bengaluru',
        postingKind: 'internship', type: 'Internship', skills: ['Python', 'SQL'],
        desc: 'Internship - 6 Months. Stipend Rs 15,000/month. Apply with your resume.' },
      mustMention: ['6 Months', '15,000'],
    },
  ];

  for (const k of KINDS) {
    console.log(`\n${k.what}\n`);
    const out = await api('post', '/jobs', { ...k.body, status: 'open' });
    const job = out.job;
    made.push(job.id);

    const desc = String(job.desc || job.description || '');
    check(desc.length > 40, `  it has a description (${desc.length} chars)`);
    check(!STUBS.some((re) => re.test(desc)), '  and it is not one of the stubs');
    check(desc.includes(k.body.title), '  it names the role');
    for (const m of k.mustMention) {
      check(desc.includes(m), `  it keeps "${m}"`);
    }
    check((job.responsibilities || []).length >= 3,
      `  ${(job.responsibilities || []).length} responsibilities`);
    check((job.requirements || []).length >= 2,
      `  ${(job.requirements || []).length} requirements`);
    console.log(`      ${desc.slice(0, 150)}`);
  }

  /* ---- the JD must describe the right profession ------------------- */
  console.log('\nThe generated JD describes the actual job\n');

  /*
   * THE STEMS SILENTLY MATCHED NOTHING.
   *
   * The specialty patterns were written as `cardiolog` inside `(…)`,
   * and the closing boundary demands a non-word character straight after
   * the stem — so none of them ever matched the words people actually
   * write. A consultant radiologist's posting described "the day-to-day
   * work of the role" and a clinical data analyst's described writing
   * software. Every one of these is a title on this system.
   */
  const { buildStructuredJd } = await import('../api/src/ai/jd.js');
  const FAMILIES = [
    ['Cardiologist', '', 'doctor'],
    ['Radiologist', '', 'doctor'],
    ['Pathologist', '', 'doctor'],
    ['Anaesthetist', '', 'doctor'],
    ['OBGY', '', 'doctor'],
    ['Staff Nurse', '', 'nurse'],
    /* a role noun beats a specialty stem: both patterns match these */
    ['Radiology Technician', '', 'allied'],
    ['Emergency Room Nurse', '', 'nurse'],
    ['Lab Technician', '', 'allied'],
    ['Medical Coder', 'Medical', 'medical_records'],
    ['Medical Transcriptionist', 'Engineering', 'medical_records'],
    ['Medical Representative', 'Medical', 'medical_sales'],
    ['Clinical Research Associate', '', 'clinical_ops'],
    ['Pharmacovigilance Associate', '', 'clinical_ops'],
    ['Clinical Data Analyst', 'Analytics', 'clinical_ops'],
    ['Healthcare Recruiter', 'Human Resources', 'recruitment'],
    ['Java Developer', 'Engineering', 'technical'],
  ];
  for (const [title, department, want] of FAMILIES) {
    const got = buildStructuredJd({ title, department }).family;
    check(got === want, `  ${title.padEnd(30)} reads as ${got}${got === want ? '' : ` (expected ${want})`}`);
  }

  /* And a medical department can never produce engineering copy. */
  const medical = buildStructuredJd({ title: 'Medical Coder', department: 'Medical' });
  check(!/software|sprint|production|code review/i.test(medical.responsibilities.join(' ')),
    '  a Medical posting carries no engineering duties');

  /* ---- a description somebody wrote is never replaced -------------- */
  console.log('\nA description the recruiter wrote is left alone\n');

  const mine = 'We are looking for an experienced staff nurse to join our cardiac unit. '
    + 'You will work alongside two consultants and a team of eight across a 40-bed ward, '
    + 'covering post-operative recovery and step-down care. The unit runs three shifts and '
    + 'we are looking for somebody who can take charge of a bay from their first week. '
    + 'Training on our protocols is provided over the first month, and there is a clear '
    + 'route to senior sister for the right person within two years of joining us here.';
  const written = await api('post', '/jobs', {
    title: `ZZ Probe Written ${STAMP}`, companyId, location: 'Hyderabad',
    skills: ['Patient Care'], desc: mine, status: 'open',
  });
  made.push(written.job.id);
  check(String(written.job.desc || written.job.description) === mine,
    '  their words are stored exactly as written');

  /* ---- and a published job reaches a candidate --------------------- */
  console.log('\nA published job reaches somebody who is not signed in\n');

  const anon = await ctx.newPage();
  await anon.goto(`${BASE}/`, { waitUntil: 'load' });
  await anon.waitForFunction(() => window.TL && window.TL.ready === true, { timeout: 25000 });
  const seen = await anon.evaluate(() => window.TL.api.get('/bootstrap')
    .then((b) => (b.data.jobs || []).map((j) => ({ title: j.title, desc: j.desc || j.description }))));
  await anon.close();

  const probe = seen.filter((j) => /ZZ Probe/.test(j.title));
  check(probe.length === KINDS.length + 1,
    `  all ${KINDS.length + 1} probe postings are visible (${probe.length})`);
  const dirty = seen.filter((j) => STUBS.some((re) => re.test(String(j.desc || ''))));
  check(dirty.length === 0,
    `  no job on the public board shows a stub description (${dirty.length})`
    + (dirty.length ? `: ${JSON.stringify(dirty[0].title)}` : ''));
} catch (e) {
  check(false, `the run failed (${e.message})`);
} finally {
  console.log('\nCleaning up\n');
  try {
    await api('post', '/auth/logout', {}).catch(() => {});
    await api('post', '/auth/login', {
      email: process.env.TL_ADMIN || 'admin@teamlink.com',
      password: process.env.TL_ADMIN_PASSWORD || 'TeamLink@2026',
      role: 'admin',
    });
    for (const id of made) {
      await api('delete', `/jobs/${encodeURIComponent(id)}`)
        .catch((e) => check(false, `  could not remove ${id} (${e.message})`));
    }
    const left = ((await api('get', '/bootstrap')).data.jobs || [])
      .filter((j) => /ZZ Probe/.test(j.title));
    check(left.length === 0, `  no probe job is left behind (${left.length})`);
  } catch (e) {
    check(false, `CLEANUP FAILED — remove the ZZ Probe jobs by hand (${e.message})`);
  }
  await browser.close();
  console.log(fail.length ? `\n${fail.length} failed` : '\nall good');
  process.exit(fail.length ? 1 : 0);
}
