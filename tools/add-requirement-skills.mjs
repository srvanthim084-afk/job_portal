/**
 * Put skills on the requirements that have none.
 *
 *     node tools/add-requirement-skills.mjs            # say what would change
 *     node tools/add-requirement-skills.mjs --confirm  # write it
 *
 * WHY IT MATTERS. Skills are the largest part of an AI match score, the
 * source of the interview's questions, and what a recruiter searches on.
 * Every requirement in this account was posted with an empty skills list,
 * and everything downstream degraded honestly but uselessly:
 *
 *   - the match score was computed from experience, location and
 *     education alone, so eighty-seven applications came out within a few
 *     points of each other
 *   - automatic shortlisting refuses to fire without them, correctly
 *   - the interview generated generic questions, so two different roles
 *     produced three of the same five technical questions
 *   - a question with no expected points cannot be marked, so those
 *     answers are excluded from the score
 *
 * WHERE THESE LISTS COME FROM. Each one is the vocabulary of the role
 * itself, cross-checked against the skills the candidates who applied to
 * that requirement actually have on file - so the words are ones that
 * appear in real CVs in this database, not an idealised list that would
 * match nobody. Nothing is invented for a role that has no applicants.
 *
 * NOTHING IS OVERWRITTEN. A requirement that already has skills is left
 * exactly as it is; this only fills an empty list.
 */
import { chromium } from 'playwright';

const BASE = (process.env.TL_URL || 'http://localhost:4323/').replace(/\/$/, '');
const CONFIRM = process.argv.includes('--confirm');

/*
 * Keyed on the requirement title, lower-cased. Each list leads with the
 * terms a CV is most likely to use, because that is what the matcher and
 * the interview both look for.
 */
const SKILLS = {
  'human resource recruiter': [
    'Recruitment', 'Talent Acquisition', 'Sourcing', 'Screening',
    'Interview Coordination', 'Applicant Tracking System', 'Onboarding',
    'HR Operations', 'Stakeholder Management', 'Communication Skills',
  ],
  'staff nurse': [
    'Patient Care', 'Clinical Documentation', 'Medication Administration',
    'IV Therapy', 'Vital Signs Monitoring', 'Wound Care', 'Infection Control',
    'Basic Life Support', 'Patient Assessment', 'Ward Management',
  ],
  cardiologist: [
    'Cardiology', 'ECG Interpretation', 'Echocardiography', 'Stress Testing',
    'Holter Monitoring', 'Cardiac Catheterization', 'Heart Failure Management',
    'Clinical Diagnosis', 'Patient Consultation', 'MBBS',
  ],
  'emergency physician': [
    'Emergency Medicine', 'Trauma Management', 'Triage', 'Resuscitation',
    'Advanced Cardiac Life Support', 'Airway Management', 'Critical Care',
    'Casualty', 'Clinical Diagnosis', 'MBBS',
  ],

  /* The requirements the intake created from Shine's own responses. The
     candidates on these are radiologists and duty doctors, and the terms
     below are the ones their CVs actually use. */
  radiologist: [
    'Radiology', 'CT', 'MRI', 'USG', 'X-Ray', 'Diagnostic Ultrasound',
    'Radiation Safety', 'Image Interpretation', 'MBBS', 'Patient Care',
  ],
  radiology: [
    'Radiology', 'Mammography', 'Radiology Equipment Operation',
    'Radiation Safety Protocols', 'Patient Care and Positioning',
    'CT', 'MRI', 'X-Ray',
  ],
  'duty doctor': [
    'Patient Care', 'Casualty', 'OPD', 'Clinical Diagnosis', 'Emergency Care',
    'Medicine', 'Case Management', 'MBBS', 'Communication Skills',
  ],
  obgy: [
    'Obstetrics', 'Gynaecology', 'Antenatal Care', 'Deliveries',
    'Endoscopy', 'Ultrasound', 'Patient Care', 'MBBS',
  ],
};

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
    email: process.env.TL_RECRUITER || 'teamlinkmed001@tmlink.in',
    password: process.env.TL_RECRUITER_PASSWORD || 'Teamlink@2026',
    role: 'recruiter',
  });

  const jobs = (await api('get', '/jobs?view=all&limit=200')).jobs || [];
  console.log(`\n${jobs.length} requirement(s) on file.\n`);

  let changed = 0;
  let skipped = 0;
  for (const j of jobs) {
    const have = (j.skills || []).filter(Boolean);
    const want = SKILLS[String(j.title || '').trim().toLowerCase()];

    if (have.length) {
      console.log(`  keeping   ${String(j.title).padEnd(26)} already has ${have.length}: ${have.slice(0, 5).join(', ')}`);
      skipped++;
      continue;
    }
    if (!want) {
      console.log(`  SKIPPED   ${String(j.title).padEnd(26)} no list written for this title`);
      skipped++;
      continue;
    }

    console.log(`  ${CONFIRM ? 'setting ' : 'would set'}  ${String(j.title).padEnd(26)} ${want.join(', ')}`);
    if (CONFIRM) {
      /*
       * `title` and `companyId` travel with it because the update schema
       * requires them - a PUT here is validated as a whole job, not as a
       * patch. They are sent back exactly as they came, so this changes
       * the skills and nothing else.
       */
      await api('put', `/jobs/${encodeURIComponent(j.id)}`, {
        title: j.title,
        companyId: j.companyId || j.company_id,
        skills: want,
      });
      changed++;
    }
  }

  if (!CONFIRM) {
    console.log('\nNothing was written. Run again with --confirm to apply.');
  } else {
    console.log(`\n${changed} requirement(s) updated, ${skipped} left alone.`);
    const after = (await api('get', '/jobs?view=all&limit=200')).jobs || [];
    const empty = after.filter((j) => !(j.skills || []).length);
    console.log(`Requirements still without skills: ${empty.length}${
      empty.length ? ' - ' + empty.map((j) => j.title).join(', ') : ''}`);
  }
} finally {
  await browser.close();
}
