/**
 * Applies every migration in supabase/migrations to a real Postgres
 * (PGlite = Postgres compiled to WASM) and reports what was created.
 *
 * This is the check that the schema is actually valid SQL that runs —
 * not SQL that merely looks right.
 */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIR = 'supabase/migrations';
const db = await new PGlite();

// Structural invariants are checked on a CLEAN schema. The seed is
// verified separately (tools/verify-seed.mjs) because its rows would
// collide with the fixtures below — and a test whose fixtures fight the
// seed tells you nothing about either.
const files = readdirSync(DIR)
  .filter(f => f.endsWith('.sql') && !/seed/.test(f))
  .sort();
let failed = false;

for (const f of files) {
  const sql = readFileSync(join(DIR, f), 'utf8');
  try {
    await db.exec(sql);
    console.log(`  OK   ${f}`);
  } catch (e) {
    failed = true;
    console.log(`  FAIL ${f}\n       ${e.message}`);
    if (e.hint)   console.log(`       hint: ${e.hint}`);
    break;
  }
}

if (failed) process.exit(1);

const q = async (sql) => (await db.query(sql)).rows;

const tables  = await q(`select tablename from pg_tables where schemaname='public' order by 1`);
const views   = await q(`select viewname  from pg_views  where schemaname='public' order by 1`);
const idx     = await q(`select count(*)::int n from pg_indexes where schemaname='public'`);
const fks     = await q(`select count(*)::int n from pg_constraint where contype='f'`);
const trg     = await q(`select count(*)::int n from pg_trigger where not tgisinternal`);
const stages  = await q(`select id from stages order by sort_order`);

console.log(`\ntables (${tables.length}): ${tables.map(t => t.tablename).join(', ')}`);
console.log(`views  (${views.length}): ${views.map(v => v.viewname).join(', ')}`);
console.log(`indexes: ${idx[0].n} · foreign keys: ${fks[0].n} · triggers: ${trg[0].n}`);
console.log(`stages in order: ${stages.map(s => s.id).join(' → ')}`);

// --- behavioural checks: the three structural fixes must actually hold ---
console.log('\nbehavioural checks');

const check = async (name, fn) => {
  try { await fn(); console.log(`  PASS  ${name}`); }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); failed = true; }
};
const mustThrow = async (sql, label) => {
  try { await db.exec(sql); throw new Error(`expected rejection: ${label}`); }
  catch (e) { if (String(e.message).startsWith('expected rejection')) throw e; }
};

await db.exec(`
  insert into companies (id,name) values ('acme','Acme');
  insert into users (id,email,password_hash,role)
    values ('11111111-1111-1111-1111-111111111111','r@x.test','x','recruiter');
  insert into recruiters (id,user_id,name,email,company_id)
    values ('r1','11111111-1111-1111-1111-111111111111','R','r@x.test','acme');
  insert into jobs (id,title,company_id,status,published_at)
    values ('j1','React Dev','acme','open', now() - interval '3 days');
  insert into candidates (id,name,email) values ('cand1','A','a@x.test');
  insert into candidates (id,name,email) values ('cand2','B','b@x.test');
`);

await check('Job ID is text and survives an update (req. 6)', async () => {
  await db.exec(`update jobs set title='React Developer II', status='draft' where id='j1'`);
  const r = await q(`select id,title from jobs`);
  if (r.length !== 1 || r[0].id !== 'j1') throw new Error('job id changed or duplicated');
  await db.exec(`update jobs set status='open' where id='j1'`);
});

await check('duplicate application is rejected (req. 24)', async () => {
  await db.exec(`insert into applications (id,job_id,candidate_id,is_primary)
                 values ('app1','j1','cand1',true)`);
  await mustThrow(`insert into applications (id,job_id,candidate_id)
                   values ('app2','j1','cand1')`, 'duplicate application');
});

await check('only one primary application per candidate (§3.1)', async () => {
  await db.exec(`insert into applications (id,job_id,candidate_id,is_primary)
                 values ('app3','j1','cand2',true)`);
  await db.exec(`insert into jobs (id,title,company_id,status) values ('j2','Py','acme','open')`);
  await mustThrow(`insert into applications (id,job_id,candidate_id,is_primary)
                   values ('app4','j2','cand1',true)`, 'second primary');
});

await check('applicants is DERIVED, not a drifting counter (§3.2)', async () => {
  const r = await q(`select applicants, posted_days_ago from jobs_with_counts where id='j1'`);
  if (Number(r[0].applicants) !== 2)
    throw new Error(`expected 2 applicants, got ${r[0].applicants}`);
  if (Number(r[0].posted_days_ago) !== 3)
    throw new Error(`expected posted_days_ago 3, got ${r[0].posted_days_ago}`);
});

await check('jobs_open applies the exact DATA.openJobs() rule', async () => {
  await db.exec(`insert into jobs (id,title,company_id,status) values ('j3','Draft','acme','draft')`);
  await db.exec(`insert into jobs (id,title,company_id,status,paused)  values ('j4','P','acme','open',true)`);
  await db.exec(`insert into jobs (id,title,company_id,status,archived) values ('j5','A','acme','open',true)`);
  await db.exec(`insert into jobs (id,title,company_id,status,expires_at)
                 values ('j6','E','acme','open', now() - interval '1 day')`);
  const open = (await q(`select id from jobs_open order by id`)).map(r => r.id);
  if (open.join(',') !== 'j1,j2')
    throw new Error(`expected j1,j2 open; got ${open.join(',') || '(none)'}`);
});

await check('stage change is logged automatically (req. 13/17)', async () => {
  await db.exec(`update applications set stage='shortlisted' where id='app1'`);
  const h = await q(`select from_stage,to_stage from application_stage_history
                     where application_id='app1' order by id`);
  if (h.length !== 2) throw new Error(`expected 2 history rows, got ${h.length}`);
  if (h[1].from_stage !== 'applied' || h[1].to_stage !== 'shortlisted')
    throw new Error(`bad transition: ${JSON.stringify(h[1])}`);
});

await check('stage must be a real ATS stage', async () => {
  await mustThrow(`update applications set stage='nonsense' where id='app1'`, 'bad stage');
});

await check('notification dedupe rule matches the prototype (:17685)', async () => {
  await db.exec(`insert into notifications (id,recipient_id,type,job_id,application_id)
                 values ('n1','cand1','BEST_FIT_JOB','j1','app1')`);
  await mustThrow(`insert into notifications (id,recipient_id,type,job_id,application_id)
                   values ('n2','cand1','BEST_FIT_JOB','j1','app1')`, 'duplicate notification');
});

await check('updated_at moves on update', async () => {
  const before = (await q(`select updated_at from jobs where id='j1'`))[0].updated_at;
  await db.exec(`update jobs set title='Changed' where id='j1'`);
  const after = (await q(`select updated_at from jobs where id='j1'`))[0].updated_at;
  if (!(new Date(after) > new Date(before))) throw new Error('updated_at did not move');
});

await check('deleting a job cascades to its applications', async () => {
  await db.exec(`delete from jobs where id='j2'`);
  const n = (await q(`select count(*)::int n from applications where job_id='j2'`))[0].n;
  if (n !== 0) throw new Error(`expected cascade, ${n} rows left`);
});

console.log(failed ? '\nSCHEMA VERIFICATION FAILED' : '\nSCHEMA VERIFIED');
// Close before exiting: tearing down the WASM instance from under an open
// handle trips a libuv assertion on Windows and would mask the exit code.
await db.close();
process.exitCode = failed ? 1 : 0;
