/**
 * Role-based scoping: what the 0117 backfill could NOT map.
 *
 *   node tools/report-unmapped-scope.mjs            a readable report
 *   node tools/report-unmapped-scope.mjs --json     the same, as JSON
 *
 * READ-ONLY. It changes nothing: it opens one transaction READ ONLY and
 * lists the rows an administrator has to assign by hand, so nothing is
 * guessed silently and nothing is orphaned or deleted.
 *
 *   jobs with no owner               recruiter_id is NULL: visible to admins
 *                                    only until somebody is assigned
 *   jobs with an owner, no login     created_by is NULL (the recruiter has no
 *                                    users row) - still visible to the owner
 *   jobs with no department          department_id is NULL: their owner and
 *                                    admins see them, a team lead does NOT
 *   recruiters with no department    their own jobs only; cannot lead a team
 *   team leads with no department    cannot exist (the database refuses it)
 *   candidates with no owner         shared candidates, in nobody's pool
 *                                    (self-registered or created by an admin)
 *
 * Needs ADMIN_DATABASE_URL (or DATABASE_URL), the same connection the
 * migration runner uses; the connection is never written through.
 */
import pg from 'pg';

const json = process.argv.includes('--json');
const url = process.env.ADMIN_DATABASE_URL || process.env.DATABASE_URL;
if (!url) {
  console.error('ADMIN_DATABASE_URL (or DATABASE_URL) must be set.');
  process.exit(1);
}

const client = new pg.Client({
  connectionString: url,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
});

const q = async (sql) => (await client.query(sql)).rows;

try {
  await client.connect();
  await client.query('begin read only');

  const report = {
    generatedAt: new Date().toISOString(),
    departments: await q(`select id, name from departments order by sort_order`),
    jobsWithoutOwner: await q(
      `select j.id, j.title, j.company_id, j.status, j.department_id
         from jobs j where j.recruiter_id is null order by j.created_at`),
    jobsWithoutCreator: await q(
      `select j.id, j.title, j.recruiter_id, r.name as recruiter, j.status
         from jobs j left join recruiters r on r.id = j.recruiter_id
        where j.recruiter_id is not null and j.created_by is null order by j.created_at`),
    jobsWithoutDepartment: await q(
      `select j.id, j.title, j.recruiter_id, r.name as recruiter, j.company_id, j.department as department_text,
              j.status
         from jobs j left join recruiters r on r.id = j.recruiter_id
        where j.department_id is null order by j.created_at`),
    recruitersWithoutDepartment: await q(
      `select r.id, r.name, r.email, r.recruiter_role, r.department as department_text,
              (select count(*) from jobs j where j.recruiter_id = r.id)::int as jobs
         from recruiters r left join users u on u.id = r.user_id
        where u.department_id is null order by r.name`),
    recruitersWithoutLogin: await q(
      `select r.id, r.name, r.email from recruiters r where r.user_id is null order by r.name`),
    candidatesWithoutOwner: (await q(
      `select count(*)::int as n from candidates c
        where c.owner_recruiter_id is null
          and not exists (select 1 from talent_pool tp where tp.candidate_id = c.id)`))[0].n,
    counts: (await q(
      `select (select count(*) from jobs)::int as jobs,
              (select count(*) from jobs where department_id is not null)::int as jobs_mapped,
              (select count(*) from recruiters)::int as recruiters,
              (select count(*) from users where role = 'recruiter' and department_id is not null)::int as recruiters_mapped,
              (select count(*) from talent_pool)::int as talent_pool_rows,
              (select count(*) from candidates)::int as candidates`))[0],
  };
  await client.query('rollback');

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const c = report.counts;
    console.log(`Scope backfill report - ${report.generatedAt}`);
    console.log(`  jobs: ${c.jobs_mapped}/${c.jobs} have a department; recruiters: ${c.recruiters_mapped}/${c.recruiters} have one`);
    console.log(`  candidates: ${c.candidates}; talent_pool rows: ${c.talent_pool_rows}`);
    const section = (title, rows, fmt, hint) => {
      console.log(`\n${title}: ${rows.length}${hint ? `  (${hint})` : ''}`);
      rows.slice(0, 200).forEach((r) => console.log('  - ' + fmt(r)));
      if (rows.length > 200) console.log(`  ... and ${rows.length - 200} more (use --json)`);
    };
    section('Jobs with no owner', report.jobsWithoutOwner,
      (r) => `${r.id}  "${r.title}"  [${r.status}]`, 'admins only until assigned');
    section('Jobs with an owner but no creator login', report.jobsWithoutCreator,
      (r) => `${r.id}  "${r.title}"  owner ${r.recruiter || r.recruiter_id}`);
    section('Jobs with no department', report.jobsWithoutDepartment,
      (r) => `${r.id}  "${r.title}"  owner ${r.recruiter || r.recruiter_id || '-'}  text "${r.department_text || ''}"`,
      'a team lead cannot see these');
    section('Recruiters with no department', report.recruitersWithoutDepartment,
      (r) => `${r.id}  ${r.name} <${r.email}>  ${r.jobs} job(s)  text "${r.department_text || ''}"`,
      'set one under Admin > Recruiters');
    section('Recruiters with no login', report.recruitersWithoutLogin, (r) => `${r.id}  ${r.name} <${r.email}>`);
    console.log(`\nCandidates in nobody's talent pool: ${report.candidatesWithoutOwner} (shared; self-registered or admin-created)`);
  }
} catch (err) {
  console.error('report failed:', err.message);
  process.exitCode = 1;
} finally {
  try { await client.end(); } catch { /* already closed */ }
}
