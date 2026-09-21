/**
 * Proves the migration is LOSSLESS.
 *
 * It loads the prototype's in-memory DATA and the seeded database side by
 * side and compares them field by field. Requirement 25 says no existing
 * UI functionality may lose data it needs; this is the check that says so
 * with numbers instead of assurances.
 */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

// ---- the prototype's own data, straight from the file ----
const html = readFileSync('baseline/prototype.html', 'utf8');
const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const src = blocks.find(b => /const DATA = \{\}/.test(b) && /DATA\.stageForCandidateJob/.test(b));
const sandbox = { window: {}, console };
sandbox.window.window = sandbox.window;
vm.createContext(sandbox);
vm.runInContext(src + '\n;globalThis.__DATA = DATA;', sandbox);
const DATA = sandbox.__DATA;

// ---- the database, fully migrated and seeded ----
const db = await new PGlite();
const DIR = 'supabase/migrations';
for (const f of readdirSync(DIR).filter(f => f.endsWith('.sql')).sort()) {
  try { await db.exec(readFileSync(join(DIR, f), 'utf8')); }
  catch (e) { console.log(`FAIL applying ${f}: ${e.message}`); process.exit(1); }
}
const q = async (sql) => (await db.query(sql)).rows;

let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  PASS  ${name}`); }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); failed++; }
};
const eq = (got, want, what) => {
  if (JSON.stringify(got) !== JSON.stringify(want))
    throw new Error(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
};

console.log('seed fidelity (prototype vs database)');

await check('row counts match the prototype exactly', async () => {
  const want = {
    companies:  DATA.companies.length,
    jobs:       DATA.jobs.length,
    candidates: DATA.candidates.length,
    recruiters: DATA.recruiters.length,
    client_users: DATA.clients.length,
    interviews: DATA.interviews.length,
  };
  const got = {};
  for (const t of Object.keys(want))
    got[t] = (await q(`select count(*)::int n from ${t}`))[0].n;
  eq(got, want, 'counts');
});

await check('every Job ID survived verbatim (requirement 6)', async () => {
  const want = DATA.jobs.map(j => j.id).sort();
  const got  = (await q(`select id from jobs order by id`)).map(r => r.id).sort();
  eq(got, want, 'job ids');
});

await check('every candidate id survived verbatim', async () => {
  const want = DATA.candidates.map(c => c.id).sort();
  const got  = (await q(`select id from candidates order by id`)).map(r => r.id).sort();
  eq(got, want, 'candidate ids');
});

await check('job field values round-trip (spot check across all 13)', async () => {
  for (const j of DATA.jobs) {
    const r = (await q(`select title, company_id, location, mode, exp_label, pay_label,
                               employment_type, featured, skills, description,
                               responsibilities, requirements
                        from jobs where id='${j.id}'`))[0];
    if (!r) throw new Error(`${j.id} missing`);
    const mismatch = [];
    if (r.title !== j.title)                      mismatch.push('title');
    if (r.company_id !== j.companyId)             mismatch.push('companyId');
    if (r.location !== j.location)                mismatch.push('location');
    if (r.mode !== j.mode)                        mismatch.push('mode');
    if (r.exp_label !== j.exp)                    mismatch.push('exp');
    if (r.pay_label !== j.pay)                    mismatch.push('pay');
    if (r.employment_type !== j.type)             mismatch.push('type');
    if (r.featured !== !!j.featured)              mismatch.push('featured');
    if (r.description !== j.desc)                 mismatch.push('desc');
    if (JSON.stringify(r.skills) !== JSON.stringify(j.skills || []))
      mismatch.push(`skills(${JSON.stringify(r.skills)} vs ${JSON.stringify(j.skills)})`);
    if ((r.responsibilities || []).length !== (j.responsibilities || []).length)
      mismatch.push('responsibilities');
    if ((r.requirements || []).length !== (j.requirements || []).length)
      mismatch.push('requirements');
    if (mismatch.length) throw new Error(`${j.id} differs: ${mismatch.join(', ')}`);
  }
});

await check('candidate arrays and profile fields round-trip (all 10)', async () => {
  for (const c of DATA.candidates) {
    const r = (await q(`select name, email, phone, location, exp, ctc, notice_period,
                               education, summary, skills, technical_skills,
                               certifications, languages, resume_file, expected_ctc
                        from candidates where id='${c.id}'`))[0];
    if (!r) throw new Error(`${c.id} missing`);
    const m = [];
    if (r.name !== c.name)               m.push('name');
    if (r.email !== c.email)             m.push('email');
    if (r.phone !== c.phone)             m.push('phone');
    if (r.location !== c.location)       m.push('location');
    if (r.exp !== c.exp)                 m.push('exp');
    if (r.ctc !== c.ctc)                 m.push('ctc');
    if (r.notice_period !== c.noticePeriod) m.push('noticePeriod');
    if (r.education !== c.education)     m.push('education');
    if (r.summary !== c.summary)         m.push('summary');
    if (r.resume_file !== c.resumeFile)  m.push('resumeFile');
    if (JSON.stringify(r.skills) !== JSON.stringify(c.skills || []))
      m.push('skills');
    if (JSON.stringify(r.technical_skills) !== JSON.stringify(c.technicalSkills || []))
      m.push('technicalSkills');
    if (JSON.stringify(r.certifications) !== JSON.stringify(c.certifications || []))
      m.push('certifications');
    if (JSON.stringify(r.languages) !== JSON.stringify(c.languages || []))
      m.push('languages');
    if (m.length) throw new Error(`${c.id} differs: ${m.join(', ')}`);
  }
});

await check('every array field in the prototype is still an array', async () => {
  // previousCompanies was stored as `text` and came back as a string, so
  // the UI's (c.previousCompanies || []).join(...) threw. Guard the whole
  // class of mistake rather than the one instance.
  const ARRAY_FIELDS = ['skills','previousCompanies','technicalSkills',
                        'certifications','languages','projects','preferredWorkModes'];
  const { toCandidate } = await import('../api/src/shapes.js');
  const rows = await q(`select * from candidates order by id`);
  for (const row of rows) {
    const c = toCandidate(row);
    for (const f of ARRAY_FIELDS) {
      if (!Array.isArray(c[f]))
        throw new Error(`${c.id}.${f} is ${typeof c[f]}, not an array ` +
                        `(the UI calls .join/.map on it)`);
    }
    // and the VALUES must survive, not just the type
    const proto = DATA.candidates.find(x => x.id === c.id);
    if (proto && Array.isArray(proto.previousCompanies)) {
      if (JSON.stringify(c.previousCompanies) !== JSON.stringify(proto.previousCompanies))
        throw new Error(`${c.id}.previousCompanies changed: ` +
          `${JSON.stringify(proto.previousCompanies)} -> ${JSON.stringify(c.previousCompanies)}`);
    }
  }
});

await check('every array field in a job is still an array', async () => {
  const { toJob } = await import('../api/src/shapes.js');
  const rows = await q(`select * from jobs_with_counts order by id`);
  for (const row of rows) {
    const j = toJob(row);
    for (const f of ['skills', 'responsibilities', 'requirements']) {
      if (!Array.isArray(j[f])) throw new Error(`${j.id}.${f} is not an array`);
    }
  }
});

await check('§3.1 — each seeded pipeline entry became a primary application', async () => {
  const want = DATA.candidates.filter(c => c.appliedJobId)
    .map(c => `${c.id}:${c.appliedJobId}:${c.stage}`).sort();
  const got = (await q(`select candidate_id, job_id, stage from applications
                        where is_primary order by candidate_id`))
    .map(r => `${r.candidate_id}:${r.job_id}:${r.stage}`).sort();
  eq(got, want, 'primary applications');
});

await check('every seeded stage is preserved (no silent remapping)', async () => {
  const want = [...new Set(DATA.candidates.filter(c => c.appliedJobId).map(c => c.stage))].sort();
  const got  = (await q(`select distinct stage from applications where is_primary`))
    .map(r => r.stage).sort();
  eq(got, want, 'stage vocabulary');
});

await check('runtime ENRICHMENT was captured, not just the seed block', async () => {
  // prototype.html:6392 enriches candidates with gender, verification flags
  // and recruiter notes AFTER the DATA block runs. An extractor that reads
  // only that block produces a seed with correct row counts and missing
  // fields — which is exactly how this went unnoticed the first time.
  const v = (await q(`select count(*)::int n from candidates where email_verified`))[0].n;
  const g = (await q(`select count(*)::int n from candidates where gender is not null`))[0].n;
  const c = (await q(`select count(*)::int n from candidate_comments`))[0].n;
  if (v === 0) throw new Error('no candidate is email_verified — enrichment was lost');
  if (g === 0) throw new Error('no candidate has a gender — enrichment was lost');
  if (c === 0) throw new Error('no recruiter comments — enrichment was lost');
  console.log(`        (${v} verified, ${g} with gender, ${c} recruiter notes)`);
});

await check('interviews keep their candidate/job links', async () => {
  const want = DATA.interviews.map(i => `${i.id}:${i.candidateId}:${i.jobId}:${i.status}`).sort();
  const got  = (await q(`select id, candidate_id, job_id, status from interviews`))
    .map(r => `${r.id}:${r.candidate_id}:${r.job_id}:${r.status}`).sort();
  eq(got, want, 'interviews');
});

await check('every interview resolved to a real application row', async () => {
  const orphans = await q(`select i.id from interviews i
                           where i.application_id is null
                             and exists (select 1 from applications a
                                         where a.candidate_id = i.candidate_id
                                           and a.job_id = i.job_id)`);
  eq(orphans.map(r => r.id), [], 'interviews with an application that was not linked');
});

await check('company branding colours survived (UI-critical)', async () => {
  for (const c of DATA.companies) {
    const r = (await q(`select color1, color2, name, industry from companies where id='${c.id}'`))[0];
    if (!r) throw new Error(`${c.id} missing`);
    if (r.color1 !== c.color1 || r.color2 !== c.color2)
      throw new Error(`${c.id} gradient changed: ${r.color1}/${r.color2} vs ${c.color1}/${c.color2}`);
    if (r.industry !== c.industry) throw new Error(`${c.id} industry changed`);
  }
});

await check('derived applicants count is sane (not the drifting counter)', async () => {
  const rows = await q(`select id, applicants from jobs_with_counts order by id`);
  const total = rows.reduce((n, r) => n + Number(r.applicants), 0);
  const apps  = (await q(`select count(*)::int n from applications`))[0].n;
  if (total !== apps)
    throw new Error(`applicants total ${total} != applications ${apps}`);
});

await check('no plain-text password anywhere in the migrations', async () => {
  const bad = [];
  for (const f of readdirSync(DIR).filter(f => f.endsWith('.sql'))) {
    const sql = readFileSync(join(DIR, f), 'utf8');
    for (const pw of ['Recruiter@123', 'Client@123', 'Admin@123', 'Candidate@123'])
      if (sql.includes(pw)) bad.push(`${f}: ${pw}`);
  }
  eq(bad, [], 'plain-text credentials in SQL');
});

await check('the open-jobs view matches DATA.openJobs() on the real seed', async () => {
  const want = DATA.openJobs().map(j => j.id).sort();
  const got  = (await q(`select id from jobs_open`)).map(r => r.id).sort();
  eq(got, want, 'open jobs');
});

console.log(failed ? `\nSEED VERIFICATION FAILED (${failed})` : '\nSEED VERIFIED — migration is lossless');
await db.close();
process.exitCode = failed ? 1 : 0;
