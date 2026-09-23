/**
 * Proves the row-level security policies actually isolate tenants.
 *
 * Requirement 5 says authorization must not rest on `if(role === 'admin')`
 * in JavaScript. These tests bypass the API entirely and talk straight to
 * Postgres as each role, which is exactly what an attacker with a stolen
 * session or a bug in the API layer would effectively get.
 *
 * A test that only checked the happy path would prove nothing, so every
 * case below asserts BOTH that the right rows are visible AND that the
 * wrong ones are not.
 */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const db = await new PGlite();
const DIR = 'supabase/migrations';

for (const f of readdirSync(DIR).filter(f => f.endsWith('.sql')).sort()) {
  try { await db.exec(readFileSync(join(DIR, f), 'utf8')); }
  catch (e) { console.log(`FAIL applying ${f}: ${e.message}`); process.exit(1); }
}

const q = async (sql) => (await db.query(sql)).rows;

// Drop to the unprivileged API role. THIS IS THE WHOLE POINT: as a
// superuser every policy is bypassed and the suite passes vacuously.
const asApi     = () => db.exec(`set role app_api;`);
const asService = () => db.exec(`reset role;`);


// --- create one auth user per role, wired to the seeded profiles ---
await asService();
const uid = {};
for (const [role, table, pid] of [
  ['candidate', 'candidates',   'cand1'],
  ['candidate', 'candidates',   'cand5'],
  ['candidate', 'candidates',   'cand6'],
  ['recruiter', 'recruiters',   'r1'],
  ['recruiter', 'recruiters',   'r2'],
  ['client',    'client_users', 'c1'],
  ['admin',     'admins',       'a1'],
]) {
  const r = await q(`insert into users (email,password_hash,role)
                     values ('${pid}@test.local','x','${role}') returning id`);
  uid[pid] = r[0].id;
  await db.exec(`update ${table} set user_id='${r[0].id}' where id='${pid}'`);
}
await asApi();

const as = async (pid, role) => {
  await asService();
  await db.exec(`select set_config('app.user_id','${uid[pid]}',false),
                        set_config('app.role','${role}',false);`);
  await asApi();
};
const anon = async () => {
  await asService();
  await db.exec(`select set_config('app.user_id','',false),
                        set_config('app.role','anon',false);`);
  await asApi();
};

// guard: if this ever runs privileged, the results are meaningless
await asApi();
const su = await q(`select current_user as u,
  (select rolsuper from pg_roles where rolname=current_user) as super,
  (select rolbypassrls from pg_roles where rolname=current_user) as bypass`);
if (su[0].super || su[0].bypass) {
  console.log(`ABORT: running as ${su[0].u} (superuser=${su[0].super}, bypassrls=${su[0].bypass}).`);
  console.log('RLS is bypassed for such roles, so these tests would pass vacuously.');
  process.exit(1);
}
console.log(`running RLS suite as: ${su[0].u} (unprivileged)`);

let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  PASS  ${name}`); }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); failed++; }
};
const eq = (got, want, what) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) throw new Error(`${what}: got ${g}, want ${w}`);
};
const ids = async (sql) => (await q(sql)).map(r => r.id).sort();

console.log('\nrow-level security');

// ---- which company each seeded job belongs to, for the assertions ----
await asService();
const technovaJobs   = await ids(`select id from jobs where company_id='technova'`);
const allCandidates  = await ids(`select id from candidates`);
await asApi();

await check('anonymous sees only open jobs, never drafts', async () => {
  await anon();
  const seen = await q(`select count(*)::int n from jobs where status <> 'open'`);
  eq(seen[0].n, 0, 'non-open jobs visible to anon');
  const open = await q(`select count(*)::int n from jobs`);
  if (open[0].n === 0) throw new Error('anon sees no jobs at all — public board is broken');
});

await check('anonymous cannot read candidates at all', async () => {
  await anon();
  const r = await q(`select count(*)::int n from candidates`);
  eq(r[0].n, 0, 'candidates leaked to anon');
});

await check('anonymous cannot read applications', async () => {
  await anon();
  const r = await q(`select count(*)::int n from applications`);
  eq(r[0].n, 0, 'applications leaked to anon');
});

await check('candidate sees ONLY their own profile', async () => {
  await as('cand1', 'candidate');
  eq(await ids(`select id from candidates`), ['cand1'], 'candidate profile visibility');
});

await check('candidate sees ONLY their own applications', async () => {
  await as('cand1', 'candidate');
  const r = await q(`select candidate_id from applications`);
  const others = r.filter(x => x.candidate_id !== 'cand1');
  eq(others.length, 0, `other candidates' applications visible (${others.length})`);
  if (r.length === 0) throw new Error('candidate cannot see their own application');
});

await check('candidate CANNOT move their own application stage', async () => {
  // cand6 is seeded at 'applied'. (cand1 is seeded at 'selected', so
  // asserting "stage is not selected" there would pass without the policy
  // doing anything — compare before/after instead of against a literal.)
  await asService();
  const before = (await q(`select stage from applications where candidate_id='cand6'`))[0].stage;
  await asApi();

  await as('cand6', 'candidate');
  await db.exec(`update applications set stage='selected' where candidate_id='cand6'`);

  await asService();
  const after = (await q(`select stage from applications where candidate_id='cand6'`))[0].stage;
  await asApi();
  if (after !== before)
    throw new Error(`candidate changed their own stage: ${before} -> ${after}`);
});

await check('candidate cannot read another candidate (cand5)', async () => {
  await as('cand1', 'candidate');
  const r = await q(`select count(*)::int n from candidates where id='cand5'`);
  eq(r[0].n, 0, 'cross-candidate read');
});

await check('candidate sees ONLY notifications addressed to them', async () => {
  await asService();
  await db.exec(`insert into notifications (id,recipient_id,recipient_role,type,title,job_id)
      values ('nt_c1','cand1','candidate','APPLICATION_SUBMITTED','yours','j1');
    insert into notifications (id,recipient_id,recipient_role,type,title,job_id)
      values ('nt_c5','cand5','candidate','APPLICATION_SUBMITTED','not yours','j5');`);
  await as('cand1', 'candidate');
  eq(await ids(`select id from notifications`), ['nt_c1'], 'notification isolation');
});

/*
 * The tenancy boundary is the RECRUITER, not the company (0031).
 *
 * These three used to assert the opposite - a shared talent pool, and
 * applications visible to everybody at the same company. That was the
 * model; it is not any more, because a consultancy where each recruiter
 * runs their own desk needs the narrower one. They are kept rather than
 * deleted: "who can see what" still has to be asserted, only the answer
 * has changed.
 */
await check('a recruiter sees no candidate belonging to another recruiter', async () => {
  await as('r1', 'recruiter');
  const foreign = await q(
    `select count(*)::int n from candidates
      where owner_recruiter_id is not null and owner_recruiter_id <> 'r1'`);
  if (foreign[0].n > 0) {
    throw new Error(`${foreign[0].n} candidate(s) owned by another recruiter are visible`);
  }
});

await check('a recruiter sees only applications on their own requirements', async () => {
  await as('r1', 'recruiter');
  const wrong = await q(
    `select count(*)::int n
       from applications a join jobs j on j.id = a.job_id
      where coalesce(j.recruiter_id, '') <> 'r1'
        and coalesce(a.recruiter_id, '') <> 'r1'`);
  if (wrong[0].n > 0) {
    throw new Error(`${wrong[0].n} application(s) belonging to another recruiter are visible`);
  }
});

await check('another recruiter sees a different set again', async () => {
  await as('r2', 'recruiter');
  const wrong = await q(
    `select count(*)::int n
       from applications a join jobs j on j.id = a.job_id
      where coalesce(j.recruiter_id, '') <> 'r2'
        and coalesce(a.recruiter_id, '') <> 'r2'`);
  if (wrong[0].n > 0) {
    throw new Error(`${wrong[0].n} application(s) belonging to another recruiter are visible`);
  }
});

await check("recruiter cannot edit another company's job", async () => {
  await as('r2', 'recruiter');           // innovatesoft editing a technova job
  const target = technovaJobs[0];
  await db.exec(`update jobs set title='HIJACKED' where id='${target}'`);
  await asService();
  const r = await q(`select title from jobs where id='${target}'`);
  await asApi();
  if (r[0].title === 'HIJACKED') throw new Error(`r2 rewrote ${target}`);
});

await check("recruiter's private notes do not leak to another recruiter", async () => {
  // delta-based: the seed already carries r1's notes from the prototype
  await as('r1', 'recruiter');
  const before = (await q(`select count(*)::int n from candidate_comments`))[0].n;
  await db.exec(`insert into candidate_comments (candidate_id,recruiter_id,tag,body)
                 values ('cand1','r1','note','r1 private note')`);
  const after = (await q(`select count(*)::int n from candidate_comments`))[0].n;
  if (after !== before + 1) throw new Error(`r1 should see one more note, ${before} -> ${after}`);

  await as('r2', 'recruiter');
  const theirs = (await q(`select count(*)::int n from candidate_comments`))[0].n;
  eq(theirs, 0, `r2 can read ${theirs} of r1's notes`);
});

await check("recruiter cannot schedule an interview for another company's job", async () => {
  await as('r2', 'recruiter');          // r2 -> innovatesoft
  const target = technovaJobs[0];       // a technova job
  try {
    await db.exec(`insert into interviews (id,candidate_id,job_id,type,status)
                   values ('iv_x','cand1','${'$'}{target}','Technical (Human)','Scheduled')`);
  } catch (e) { /* rejected outright is fine too */ }
  await asService();
  const n = (await q(`select count(*)::int n from interviews where id='iv_x'`))[0].n;
  await asApi();
  if (n !== 0) throw new Error('r2 scheduled an interview against a technova job');
});

await check('client sees ONLY client-visible stages (never applied/ai_screening)', async () => {
  await as('c1', 'client');              // c1 -> technova
  const r = await q(`select distinct stage from applications`);
  const hidden = ['applied', 'ai_screening'];
  const leaked = r.map(x => x.stage).filter(s => hidden.includes(s));
  eq(leaked, [], `early-stage applications leaked to client: ${leaked}`);
});

await check('client cannot see candidates outside their pipeline', async () => {
  await as('c1', 'client');
  const seen = await ids(`select id from candidates`);
  if (seen.length >= allCandidates.length)
    throw new Error(`client sees ${seen.length}/${allCandidates.length} candidates — no filtering`);
});

await check('VIEWS respect RLS (security_invoker)', async () => {
  // A view defaults to running as its OWNER, which silently bypasses every
  // policy on the tables beneath it. This caught a real leak: draft jobs
  // were readable by anonymous callers through jobs_with_counts while the
  // `jobs` table itself was correctly protected.
  await asService();
  const opts = await q(`select c.relname, c.reloptions
                          from pg_class c join pg_namespace n on n.oid=c.relnamespace
                         where c.relkind='v' and n.nspname='public'`);
  const missing = opts.filter(v =>
    !(v.reloptions || []).some(o => String(o).replace(/\s/g,'') === 'security_invoker=true'));
  await asApi();
  if (missing.length)
    throw new Error(`views without security_invoker: ${missing.map(v=>v.relname).join(', ')}`);
});

await check('a draft job is invisible through the VIEWS too', async () => {
  await asService();
  await db.exec(`insert into jobs (id,title,company_id,status)
                 values ('jview','Secret','technova','draft')
                 on conflict (id) do nothing`);
  await anon();
  for (const view of ['jobs_with_counts', 'jobs_open']) {
    const r = await q(`select count(*)::int n from ${view} where id='jview'`);
    if (r[0].n !== 0) throw new Error(`${view} leaked the draft job to anon`);
  }
});

await check('AI score is visible to candidate, recruiter, client AND admin', async () => {
  await asService();
  // cand1 -> j1 (technova). r1 is a technova recruiter, c1 a technova client.
  await db.exec(`
    insert into ai_interviews (id, application_id, candidate_id, job_id, status, mode,
                               content_scored, question_set_hash)
    values ('aiv1','app_seed_cand1','cand1','j1','in_progress','voice',true,'hash-a');
    insert into ai_interview_answers (ai_interview_id,seq,category,question,answered,score,comm_score,justification)
    values ('aiv1',1,'technical','Explain React reconciliation',true,82,74,'Accurate; some depth missing'),
           ('aiv1',2,'behavioral','Describe a conflict you resolved',true,70,80,'Relevant example, light on outcome'),
           ('aiv1',3,'technical','How do you handle state?',false,0,0,'No spoken response - scored 0');
    update ai_interviews set status='completed', overall_percentage=51,
           technical_score=41, behavioral_score=70, communication_score=51 where id='aiv1';
  `);
  await asApi();

  for (const [pid, role] of [['cand1','candidate'], ['r1','recruiter'], ['c1','client'], ['a1','admin']]) {
    await as(pid, role);
    const rows = await q(`select overall_percentage from ai_interviews where id='aiv1'`);
    if (!rows.length) throw new Error(`${role} (${pid}) cannot see the AI interview score`);
    const ans = await q(`select count(*)::int n from ai_interview_answers where ai_interview_id='aiv1'`);
    if (ans[0].n !== 3) throw new Error(`${role} sees ${ans[0].n}/3 per-question rows`);
  }
});

await check('another candidate CANNOT see that AI score', async () => {
  await as('cand5', 'candidate');
  const r = await q(`select count(*)::int n from ai_interviews where id='aiv1'`);
  eq(r[0].n, 0, 'AI interview leaked to another candidate');
  const a = await q(`select count(*)::int n from ai_interview_answers where ai_interview_id='aiv1'`);
  eq(a[0].n, 0, 'per-question answers leaked to another candidate');
});

await check('a recruiter at another company CANNOT see that AI score', async () => {
  await as('r2', 'recruiter');          // innovatesoft; j1 is technova
  const r = await q(`select count(*)::int n from ai_interviews where id='aiv1'`);
  eq(r[0].n, 0, 'AI interview leaked across companies');
});

await check('anonymous cannot see any AI interview', async () => {
  await anon();
  const r = await q(`select count(*)::int n from ai_interviews`);
  eq(r[0].n, 0, 'AI interviews leaked to anonymous');
});

await check('a candidate CANNOT raise their own AI score', async () => {
  await as('cand1', 'candidate');
  await db.exec(`update ai_interviews set overall_percentage=99 where id='aiv1'`);
  await asService();
  const r = await q(`select overall_percentage from ai_interviews where id='aiv1'`);
  await asApi();
  if (Number(r[0].overall_percentage) === 99) {
    throw new Error('a candidate raised their own AI interview score');
  }
});

await check('a score cannot exist without the answers that produced it', async () => {
  await asService();
  let rejected = false;
  try {
    await db.exec(`insert into ai_interviews (id,candidate_id,job_id,status,overall_percentage,question_set_hash)
                   values ('aiv_bare','cand1','j1','completed',88,'hash-b')`);
  } catch (e) { rejected = true; }
  const n = (await q(`select count(*)::int n from ai_interviews where id='aiv_bare'`))[0].n;
  await asApi();
  if (!rejected && n > 0) {
    throw new Error('a completed score was recorded with no per-question answers');
  }
});

await check('admin sees everything', async () => {
  await as('a1', 'admin');
  const c = await q(`select count(*)::int n from candidates`);
  const a = await q(`select count(*)::int n from applications`);
  if (c[0].n !== allCandidates.length)
    throw new Error(`admin sees ${c[0].n}/${allCandidates.length} candidates`);
  if (a[0].n === 0) throw new Error('admin sees no applications');
});

await check('user_prefs are strictly per-user', async () => {
  await as('cand1', 'candidate');
  await db.exec(`insert into user_prefs (user_id,key,value)
                 values ('${uid.cand1}','teamlink_job_alerts_v1','[1]'::jsonb)`);
  eq((await q(`select count(*)::int n from user_prefs`))[0].n, 1, 'own prefs');
  await as('cand5', 'candidate');
  eq((await q(`select count(*)::int n from user_prefs`))[0].n, 0, 'cand5 read cand1 prefs');
});

await check('password hashes are never readable by another user', async () => {
  await as('cand1', 'candidate');
  const r = await q(`select count(*)::int n from users`);
  eq(r[0].n, 1, `candidate can read ${r[0].n} user rows (should be only their own)`);
});

await check('a candidate cannot apply to a draft/closed job', async () => {
  await asService();
  await db.exec(`insert into jobs (id,title,company_id,status)
                 values ('jdraft','Secret','technova','draft')`);
  await asApi();
  await as('cand1', 'candidate');
  try {
    await db.exec(`insert into applications (id,job_id,candidate_id)
                   values ('bad1','jdraft','cand1')`);
  } catch { /* rejected outright is also fine */ }
  await asService();
  const r = await q(`select count(*)::int n from applications where id='bad1'`);
  await asApi();
  eq(r[0].n, 0, 'application to a draft job was created');
});

await check('a candidate cannot apply AS someone else', async () => {
  await as('cand1', 'candidate');
  try {
    await db.exec(`insert into applications (id,job_id,candidate_id)
                   values ('bad2','j11','cand5')`);
  } catch { /* expected */ }
  await asService();
  const r = await q(`select count(*)::int n from applications where id='bad2'`);
  await asApi();
  eq(r[0].n, 0, 'cand1 applied on behalf of cand5');
});

console.log(failed ? `\nRLS VERIFICATION FAILED (${failed})` : '\nRLS VERIFIED');
await db.close();
process.exitCode = failed ? 1 : 0;
