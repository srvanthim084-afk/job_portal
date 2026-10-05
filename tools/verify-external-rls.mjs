/**
 * The external-job tables cannot be used to reach TeamLink's data.
 *
 *     node tools/verify-external-rls.mjs
 *
 * `verify-external-jobs.mjs` drives the feature through the HTTP API, and
 * that is worth having - but the development server connects to Postgres
 * as a superuser, and a superuser BYPASSES every row-level security
 * policy. So those tests prove the endpoints behave; they prove nothing at
 * all about the policies underneath them.
 *
 * This file talks straight to Postgres as the unprivileged `app_api` role,
 * exactly as production does, and asserts the two things the feature
 * promises:
 *
 *   1. ISOLATION. A candidate can read their own external matches and
 *      applications and nobody else's. No role can write to any external
 *      table directly; every write has to go through the definer
 *      functions, which is what makes the write paths auditable.
 *
 *   2. THE CASCADE RUNS ONE WAY. Deleting external data - a source, a
 *      posting, everything - cannot delete a candidate, a job, an
 *      application or an ATS stage. This is asserted by counting the
 *      existing tables before and after a delete that removes every
 *      external row in the database.
 *
 * Built the same way as tools/verify-rls.mjs, including its reason for
 * skipping the data-only migration: a policy can only be tested against
 * rows, and 0033 deletes the fixtures that 0003 creates.
 */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIR = 'supabase/migrations';
const DATA_ONLY = new Set(['0033_empty_the_demo_portal.sql']);

const db = await new PGlite();
for (const f of readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort()) {
  if (DATA_ONLY.has(f)) continue;
  try { await db.exec(readFileSync(join(DIR, f), 'utf8')); }
  catch (e) { console.log(`FAIL applying ${f}: ${e.message}`); process.exit(1); }
}

const q = async (sql) => (await db.query(sql)).rows;
const asApi = () => db.exec('set role app_api;');
const asService = () => db.exec('reset role;');

const fail = [];
const check = (ok, what) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}`);
  if (!ok) fail.push(what);
};

/**
 * Was that write actually prevented?
 *
 * TWO DIFFERENT REFUSALS, and only one of them raises. An INSERT that a
 * policy forbids errors with "new row violates row-level security
 * policy". An UPDATE or DELETE does not: the policy filters the row out
 * before the write is considered, so the statement SUCCEEDS having changed
 * nothing. Treating "no exception" as "it was allowed" reported four
 * security holes that were not there, and would have gone on doing so
 * forever - the first version of this file did exactly that.
 *
 * So prevention means: it threw, OR it touched no row AND the value is
 * still what it was. The last clause is the one that matters, because it
 * is the only one that checks the outcome rather than the mechanism.
 *
 * @param probe  SQL returning one row, one column, read privileged
 */
async function preventedWrite(sql, what, probe) {
  await asService();
  const was = probe ? JSON.stringify((await q(probe))[0]) : null;
  await asApi();

  let threw = null;
  let affected = null;
  try {
    const res = await db.query(sql);
    affected = res.affectedRows ?? 0;
  } catch (e) {
    threw = String(e.message).split('\n')[0];
  }

  await asService();
  const now = probe ? JSON.stringify((await q(probe))[0]) : null;
  await asApi();

  const unchanged = was === now;
  const ok = threw !== null || (affected === 0 && unchanged);
  const how = threw ? `refused: ${threw.slice(0, 54)}`
    : affected === 0 ? 'no row was visible to write to'
    : `${affected} row(s) CHANGED`;
  check(ok && unchanged, `${what} (${how})`);
}

await asService();
const uid = {};
for (const [role, table, pid] of [
  ['candidate', 'candidates', 'cand1'],
  ['candidate', 'candidates', 'cand5'],
  ['recruiter', 'recruiters', 'r1'],
  ['admin', 'admins', 'a1'],
]) {
  const r = await q(`insert into users (email,password_hash,role)
                     values ('${pid}@ext.local','x','${role}') returning id`);
  uid[pid] = r[0].id;
  await db.exec(`update ${table} set user_id='${r[0].id}' where id='${pid}'`);
}

const as = async (pid, role) => {
  await asService();
  await db.exec(`select set_config('app.user_id','${uid[pid]}',false),
                        set_config('app.role','${role}',false);`);
  await asApi();
};

/* If this runs privileged, everything below passes for the wrong reason. */
await asApi();
const su = await q(`select current_user as u,
  (select rolsuper from pg_roles where rolname=current_user) as super,
  (select rolbypassrls from pg_roles where rolname=current_user) as bypass`);
if (su[0].super || su[0].bypass) {
  console.log(`ABORT: running as ${su[0].u} — RLS is bypassed, so nothing here would mean anything.`);
  process.exit(1);
}

/* ---- fixtures, created as the service role ------------------------ */
await asService();
await db.exec(`
  select external_source_save('xsrc_t1','Test Board','job_board','manual','redirect',
                              false,true,null,null);
  select external_job_save('xjob_t1','xsrc_t1','ext-1','Senior Java Developer',
    'Test Co','Hyderabad','desc', array['Java','Spring Boot','SQL'], '2-4 yrs', 2, 4,
    null, null, null, 'Full-time', null, null, 'https://example.invalid/a', null,
    now(), 'open', 'developer-java-senior|test co|hyderabad', '{}'::jsonb);
  select external_match_save('xmatch_t1','cand1','xjob_t1',88,
    array['Java'], array['SQL'], '[]'::jsonb, false);
  select external_match_save('xmatch_t2','cand5','xjob_t1',41,
    array['Java'], array['SQL'], '[]'::jsonb, false);
  select external_application_open('xapp_t1','cand1','xjob_t1','xsrc_t1',88,'redirect',
    'https://example.invalid/a');
  select external_application_status('xapp_t1','shortlisted','Shortlisted by employer',null,null);
`);

/* What TeamLink holds, before anything external is touched. */
const baseline = (await q(`
  select (select count(*) from candidates)                as candidates,
         (select count(*) from jobs)                       as jobs,
         (select count(*) from applications)               as applications,
         (select count(*) from stages)                     as stages,
         (select count(*) from application_stage_history)  as history,
         (select string_agg(id || ':' || stage, ',' order by id) from applications) as ats
`))[0];

console.log(`\nbaseline: ${baseline.candidates} candidates, ${baseline.jobs} jobs, `
  + `${baseline.applications} applications, ${baseline.stages} stages\n`);

/* ---- 1 · a candidate sees their own and only their own ------------ */
console.log('A candidate reads their own external rows, and no one else’s\n');

await as('cand1', 'candidate');
let r = await q(`select count(*)::int n from candidate_external_job_matches`);
check(r[0].n === 1, `cand1 sees exactly their own match (${r[0].n})`);
r = await q(`select count(*)::int n from external_applications`);
check(r[0].n === 1, `and their own external application (${r[0].n})`);
r = await q(`select count(*)::int n from external_jobs`);
check(r[0].n === 1, `external jobs are readable — they are public adverts (${r[0].n})`);
/*
 * A CANDIDATE CAN READ A SOURCE, AND THAT IS DELIBERATE (0055).
 *
 * Every query that returns an external job joins job_sources - for the
 * "via Naukri" line and for the application method - so while this table
 * was staff-only the join matched nothing and a signed-in candidate saw
 * no external jobs at all. What matters is not that the row is hidden but
 * that it holds nothing worth hiding: the credential column stores the
 * NAME of an environment variable, never a key.
 */
r = await q(`select count(*)::int n from job_sources`);
check(r[0].n === 1, `a candidate can read the source, so the job join works (${r[0].n})`);
r = await q(`select credential_env from job_sources where id='xsrc_t1'`);
check(r[0].credential_env === null,
  'and the source carries no credential value — only ever a variable name');

await as('cand5', 'candidate');
r = await q(`select count(*)::int n from candidate_external_job_matches where candidate_id='cand1'`);
check(r[0].n === 0, `cand5 cannot see cand1's match (${r[0].n})`);
r = await q(`select count(*)::int n from external_applications where candidate_id='cand1'`);
check(r[0].n === 0, `cand5 cannot see cand1's external application (${r[0].n})`);

await as('r1', 'recruiter');
/*
 * THE RULE, NOT A NUMBER.
 *
 * A recruiter sees external applications for the candidates they can
 * already see - the same nested test migration 0048 uses - so this
 * feature widens nobody's view by a single row. In these fixtures a
 * seeded recruiter can see no candidates at all, so zero is the CORRECT
 * answer, and asserting "1" made a working policy look broken.
 */
const visibleCandidates = (await q(`select count(*)::int n from candidates`))[0].n;
const visibleExternal = (await q(`select count(*)::int n from external_applications`))[0].n;
check(visibleExternal === (visibleCandidates > 0 ? 1 : 0),
  `a recruiter sees external applications only for candidates they can see `
  + `(${visibleCandidates} candidate(s) visible, ${visibleExternal} external application(s))`);
r = await q(`select count(*)::int n from job_sources`);
check(r[0].n === 1, `and the sources are visible to them (${r[0].n})`);

/* ---- 2 · nothing is writable directly ----------------------------- */
console.log('\nEvery write must go through a definer function\n');

await as('cand1', 'candidate');
await preventedWrite(
  `insert into external_applications (id,candidate_id,external_job_id,source_id)
   values ('xapp_bad','cand1','xjob_t1','xsrc_t1')`,
  'a candidate cannot insert an external application',
  `select count(*)::int n from external_applications`);
await preventedWrite(
  `update external_applications set status='applied' where id='xapp_t1'`,
  'a candidate cannot promote their own external status',
  `select status from external_applications where id='xapp_t1'`);
await preventedWrite(
  `update candidate_external_job_matches set match_percentage=100 where id='xmatch_t1'`,
  'a candidate cannot raise their own external match score',
  `select match_percentage from candidate_external_job_matches where id='xmatch_t1'`);
await preventedWrite(
  `insert into external_jobs (id,source_id,external_job_id,title)
   values ('xjob_bad','xsrc_t1','x','x')`,
  'a candidate cannot invent an external job',
  `select count(*)::int n from external_jobs`);

await as('r1', 'recruiter');
await preventedWrite(
  `update job_sources set active=false where id='xsrc_t1'`,
  'a recruiter cannot edit a source row directly',
  `select active from job_sources where id='xsrc_t1'`);

/* ---- 3 · the external layer cannot write to TeamLink -------------- */
console.log('\nThe external tables give no route into TeamLink’s own data\n');

await as('cand1', 'candidate');
await preventedWrite(`update applications set stage='applied' where candidate_id='cand1'`,
  'a candidate still cannot move their own ATS stage',
  `select string_agg(stage, ',' order by id) s from applications where candidate_id='cand1'`);
/*
 * ANOTHER candidate, deliberately. cand1 editing their OWN title is
 * existing, intended behaviour - the product has a profile editor, and
 * tools/verify-rls.mjs already proves that boundary. What matters here is
 * that the external feature opened no route to anybody ELSE's row.
 */
await preventedWrite(`update candidates set title='Director' where id='cand5'`,
  'and the external feature opened no route to another candidate’s profile',
  `select title from candidates where id='cand5'`);

/* An external status of "shortlisted" sits beside a TeamLink stage that
   is something else entirely. Read both, as the candidate. */
const both = await q(`
  select (select status from external_applications where id='xapp_t1') as external_status,
         (select stage  from applications where candidate_id='cand1' limit 1) as ats_stage`);
check(both[0].external_status === 'shortlisted',
  `the external application says "${both[0].external_status}"`);
check(both[0].ats_stage !== 'shortlisted' || both[0].ats_stage == null
  || both[0].ats_stage !== both[0].external_status,
  `while the TeamLink stage says "${both[0].ats_stage}" — they are separate columns `
  + 'in separate tables');

/* ---- 4 · the cascade runs away from TeamLink, never into it ------- */
console.log('\nDeleting every external row leaves TeamLink untouched\n');

await asService();
const removed = (await q(`select * from external_source_delete('xsrc_t1')`))[0];
check(Number(removed.removed_jobs) === 1 && Number(removed.removed_matches) === 2
  && Number(removed.removed_applications) === 1,
  `removing the source took ${removed.removed_jobs} job(s), ${removed.removed_matches} `
  + `match(es) and ${removed.removed_applications} application(s) with it`);

const empty = (await q(`
  select (select count(*) from external_jobs)                   as jobs,
         (select count(*) from candidate_external_job_matches)  as matches,
         (select count(*) from external_applications)           as applications`))[0];
check(Number(empty.jobs) === 0 && Number(empty.matches) === 0
  && Number(empty.applications) === 0,
  'no external row is left anywhere');

const after = (await q(`
  select (select count(*) from candidates)                as candidates,
         (select count(*) from jobs)                       as jobs,
         (select count(*) from applications)               as applications,
         (select count(*) from stages)                     as stages,
         (select count(*) from application_stage_history)  as history,
         (select string_agg(id || ':' || stage, ',' order by id) from applications) as ats
`))[0];

check(String(after.candidates) === String(baseline.candidates),
  `candidates: ${after.candidates} (was ${baseline.candidates})`);
check(String(after.jobs) === String(baseline.jobs),
  `jobs: ${after.jobs} (was ${baseline.jobs})`);
check(String(after.applications) === String(baseline.applications),
  `applications: ${after.applications} (was ${baseline.applications})`);
check(String(after.stages) === String(baseline.stages),
  `stages: ${after.stages} (was ${baseline.stages})`);
check(String(after.history) === String(baseline.history),
  `stage history: ${after.history} (was ${baseline.history})`);
check(after.ats === baseline.ats, 'every ATS stage is the same string it was');

/* ---- 5 · no external table references anything of TeamLink's
       except candidates, and only by a read-direction key ----------- */
console.log('\nThe only link back to TeamLink is a read-direction foreign key\n');

await asService();
const fks = await q(`
  select tc.table_name as child, ccu.table_name as parent
    from information_schema.table_constraints tc
    join information_schema.constraint_column_usage ccu
      on ccu.constraint_name = tc.constraint_name
   where tc.constraint_type = 'FOREIGN KEY'
     and tc.table_name in ('job_sources','external_jobs',
                           'candidate_external_job_matches','external_applications')
   order by 1, 2`);
const parents = [...new Set(fks.map((f) => f.parent))].sort();
const intoTeamLink = parents.filter((p) => !p.startsWith('external_') && p !== 'job_sources');
check(intoTeamLink.length === 1 && intoTeamLink[0] === 'candidates',
  `external tables reference only: ${parents.join(', ')}`);

/* And nothing in TeamLink references an external table, which is what
   makes the feature removable without touching the existing schema.

   The external layer is every table named external_* or job_source*,
   plus career_boards and search_query_cache (0067) - tables of the layer
   pointing at each other are not "TeamLink pointing in". This check used
   to list only the first four tables, so 0067/0076/0088's own tables were
   counted as intruders and it failed before 0108 was written. */
const EXT_LAYER = `(%s like 'external\\_%%' or %s like 'job\\_source%%' or %s in ('career_boards','search_query_cache','candidate_external_job_matches'))`;
const layer = (col) => EXT_LAYER.replace(/%s/g, col).replace(/%%/g, '%');
const inbound = await q(`
  select tc.table_name as child, ccu.table_name as parent
    from information_schema.table_constraints tc
    join information_schema.constraint_column_usage ccu
      on ccu.constraint_name = tc.constraint_name
   where tc.constraint_type = 'FOREIGN KEY'
     and ${layer('ccu.table_name')}
     and not ${layer('tc.table_name')}`);
check(inbound.length === 0,
  `no existing table points at an external one (${inbound.length} found${inbound.length ? ': ' + inbound.map((r) => r.child).join(', ') : ''})`);

/* 0108's tables reference only the external layer and candidates. */
const fks108 = await q(`
  select distinct tc.table_name as child, ccu.table_name as parent
    from information_schema.table_constraints tc
    join information_schema.constraint_column_usage ccu
      on ccu.constraint_name = tc.constraint_name
   where tc.constraint_type = 'FOREIGN KEY'
     and tc.table_name in ('external_source_licences','external_job_url_changes','external_job_quarantine',
                           'external_job_events','external_saved_jobs','external_audit_log')`);
const out108 = fks108.filter((f) => !(new RegExp('^(external_|job_source)').test(f.parent)) && f.parent !== 'candidates');
check(out108.length === 0, `0108's tables point only into the external layer and at candidates (${fks108.map((f) => f.child + '->' + f.parent).join(', ')})`);

/* ---- 6 · 0108: who may read and write the new tables ---------------- */
console.log('\n0108 — licences, audit, quarantine, events, saved jobs\n');
await asService();
await db.exec(`
  select external_source_save('xsrc_t2','Second Board','job_board','manual','redirect',false,true,null,null);
  select external_job_save('xjob_t2','xsrc_t2','ext-2','QA Engineer','Test Co','Pune','A real description',
    array['Selenium'], null, null, null, null, null, null, 'Full-time', null, null, 'https://example.org/qa', null,
    now(), 'open', null, '{}'::jsonb);
  select external_source_save('xsrc_t3','Third Board','job_board','manual','redirect',false,false,null,null);
  insert into external_source_licences (source_id, licence_status) values ('xsrc_t2', 'active');
  select external_quarantine_put('xsrc_t2','fp1','e9','Bad posting','Co',null,array['missing_url'],'quarantined','{}'::jsonb);
  select external_job_event_add('xjob_t2','external_job_view','');`);
check((await q(`select (select count(*) from external_source_licences)::int l, (select count(*) from external_job_quarantine)::int q,
                       (select count(*) from external_job_events)::int e`))
  .every((r) => r.l === 1 && r.q === 1 && r.e === 1), 'fixtures: one licence, one quarantined posting, one event');
for (const [t, role, pid] of [['external_audit_log', 'recruiter', 'r1'], ['external_source_licences', 'candidate', 'cand1'],
  ['external_job_quarantine', 'candidate', 'cand1'], ['external_job_events', 'candidate', 'cand1']]) {
  await as(pid, role);
  const n = (await q(`select count(*)::int n from ${t}`))[0].n;
  check(n === 0, `${role} reads nothing from ${t} (${n})`);
}
await as('a1', 'admin');
check((await q(`select count(*)::int n from external_audit_log`))[0].n > 0, 'an administrator reads the audit trail');
let auditWrite = 'allowed';
try { await db.exec(`insert into external_audit_log (action, entity) values ('forged', 'x')`); }
catch (e) { auditWrite = 'refused'; }
check(auditWrite === 'refused', `nobody, not even an administrator, can write the audit trail directly (${auditWrite})`);
let licWrite = 'allowed';
try { await db.exec(`insert into external_source_licences (source_id) values ('xsrc_t3')`); }
catch (e) { licWrite = 'refused'; }
check(licWrite === 'refused', `a licence is written only through its definer function (${licWrite})`);

/* A candidate saves for themselves only, through the function. */
await as('cand1', 'candidate');
await q(`select external_saved_set('xjob_t2', true)`);
check((await q(`select count(*)::int n from external_saved_jobs`))[0].n === 1, 'cand1 saved a job and sees it');
let savedWrite = 'allowed';
try { await db.exec(`insert into external_saved_jobs (candidate_id, external_job_id) values ('cand5','xjob_t2')`); }
catch (e) { savedWrite = 'refused'; }
check(savedWrite === 'refused', `nobody saves for somebody else (${savedWrite})`);
await as('cand5', 'candidate');
check((await q(`select count(*)::int n from external_saved_jobs`))[0].n === 0, 'cand5 does not see cand1\'s saved job');
let licFn = 'allowed';
try { await q(`select external_source_licence_save('xsrc_t2','manual_entry','active','granted','https://x.org',true,true,null,null,'me',null)`); }
catch (e) { licFn = 'refused'; }
check(licFn === 'refused', `a candidate cannot record a licence even through the function (${licFn})`);
await asService();
await q(`select external_source_delete('xsrc_t2')`);
await q(`select external_source_delete('xsrc_t3')`);

console.log(fail.length
  ? `\nEXTERNAL RLS VERIFICATION FAILED (${fail.length})`
  : '\nEXTERNAL RLS VERIFIED');
process.exit(fail.length ? 1 : 0);
