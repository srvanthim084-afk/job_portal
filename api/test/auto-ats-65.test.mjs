/**
 * Overall score 65% or more goes to the ATS (0144).
 *
 *   - the auto-shortlist threshold is 65 (an untouched 80 became 65; an admin's own value is left alone)
 *   - a well-matched application is shortlisted by the screening at 65+, with the score and threshold in its note
 *   - applications already at Applied with a score above the new threshold are screened ONCE more by the sweep:
 *     moved when the verdict is shortlist, left for a recruiter when it is not (no skills named) - and never
 *     picked again either way: no loop, no second move, no second recruiter alert
 *   - nobody further along is touched; nobody is messaged
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestDb, applyTestEnv, makeClient } from './harness.mjs';

const DB_PORT = 5611;
const API_PORT = 9969;
const base = `http://127.0.0.1:${API_PORT}`;
const PW = 'AutoAts65test';

let dbh, server, raw, screening;
let seq = 0;

async function candidate(profile = {}) {
  seq += 1;
  const c = makeClient(base);
  await c.get('/api/health');
  const r = await c.post('/api/auth/register', {
    name: `Auto Person ${seq}`, email: `auto.${seq}.${Date.now().toString(36)}@mailbox-teamlink-tests.in`,
    password: PW, phone: '93400' + String(10000 + seq).slice(-5), preferredLocation: 'Hyderabad', expectedCtc: 4,
    noticePeriod: 'Immediate', preferredWorkModes: ['Hybrid'],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  c.id = r.body.candidateId;
  /* a strong profile for the job below: its skills, in range, in town */
  await raw(`update candidates set skills = $2, technical_skills = $2, location = 'Hyderabad', preferred_location = 'Hyderabad',
             exp_years = 2, exp = '2 yrs', title = 'Recruiter', education = ARRAY['MBA'] where id = $1`, [c.id, profile.skills || ['Sourcing', 'ATS']]);
  return c;
}
const job = (id, skills) => raw(
  `insert into jobs (id, title, company_id, location, mode, exp_label, skills, status, recruiter_id, description, published_at)
   values ($1, $2, 'co_au', 'Hyderabad', 'Onsite', '1-3 yrs', $3, 'open', 'r_au', 'Recruit for the team.', now())`, [id, `Role ${id}`, skills]);
const events = async (appId) => (await raw(`select metadata from application_events where application_id = $1 and type = 'screening.completed' order by id`, [appId])).rows;
const stage = async (appId) => (await raw(`select stage from applications where id = $1`, [appId])).rows[0].stage;

/** an application at Applied with a stored score, screened (as the old rule recorded it) at threshold 80 */
async function oldApplication(c, jobId, score) {
  const id = `app_au_${++seq}`;
  await raw(`insert into applications (id, job_id, candidate_id, recruiter_id, stage, match_score, ai_score, ai_screened_at, source)
             values ($1, $2, $3, 'r_au', 'applied', $4, $4, now(), 'portal')`, [id, jobId, c.id, score]);
  await raw(`insert into application_events (application_id, candidate_id, type, detail, actor, metadata)
             values ($1, $2, 'screening.completed', 'AI screening (threshold 80)', 'system', $3::jsonb)`, [id, c.id, JSON.stringify({ score, verdict: 'review', threshold: 80 })]);
  return id;
}

test('boot', async () => {
  dbh = await startTestDb(DB_PORT);
  applyTestEnv(dbh.url, {
    PUBLIC_ORIGIN: base, DISABLE_BACKGROUND_WORK: 'true', AI_API_KEY: '',
    EMAIL_API_KEY: '', EMAIL_SMTP_HOST: '', EMAIL_SMTP_USER: '', EMAIL_SMTP_PASS: '',
    EMAILJS_SERVICE_ID: '', EMAILJS_TEMPLATE_ID: '', EMAILJS_PUBLIC_KEY: '', EMAILJS_PRIVATE_KEY: '',
    SMS_API_KEY: '', WHATSAPP_API_KEY: '',
  });
  raw = (sql, params) => dbh.db.query(sql, params);
  await raw(`insert into companies (id, name) values ('co_au', 'Auto Co')`);
  await raw(`insert into recruiters (id, name, email, company_id) values ('r_au', 'Auto Recruiter', 'rec.au@tl-sink.local', 'co_au')`);
  const { createApp } = await import('../src/app.js');
  screening = await import('../src/ai/screening.js');
  const app = createApp({ logger: { error() {}, log() {} } });
  await new Promise((r) => { server = app.listen(API_PORT, r); });
  await job('j_au', ['Sourcing', 'ATS']);
  await job('j_au_noskills', []);
});

test('the threshold is 65; an administrator\'s own value is kept', async () => {
  assert.equal(Number((await screening.loadAiSettings()).autoShortlistThreshold), 65);
  assert.equal(Number((await raw(`select value->>'autoShortlistThreshold' as t from app_settings where key = 'ai'`)).rows[0].t), 65);
  /* the migration's rule: only the untouched 80 changes */
  await raw(`update app_settings set value = jsonb_set(value, '{autoShortlistThreshold}', '72'::jsonb) where key = 'ai'`);
  await raw(`update app_settings set value = jsonb_set(value, '{autoShortlistThreshold}', '65'::jsonb)
              where key = 'ai' and (value->>'autoShortlistThreshold') ~ '^80(\\.0+)?$'`);
  assert.equal(Number((await raw(`select value->>'autoShortlistThreshold' as t from app_settings where key = 'ai'`)).rows[0].t), 72, 'a chosen value is not overwritten');
  await raw(`update app_settings set value = jsonb_set(value, '{autoShortlistThreshold}', '65'::jsonb) where key = 'ai'`);
});

test('a well-matched candidate is shortlisted at 65 or more, with the score and threshold on record', async () => {
  const c = await candidate();
  const r = await c.post('/api/applications', { jobId: 'j_au' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const id = r.body.application.id;
  let res = await screening.screenApplication(id, { force: true });
  const score = res ? res.score : (await raw(`select ai_score from applications where id = $1`, [id])).rows[0].ai_score;
  assert.ok(Number(score) >= 65, `a strong profile scores 65 or more (got ${score})`);
  assert.equal(await stage(id), 'shortlisted');
  const ev = (await events(id)).pop();
  assert.equal(Number(ev.metadata.threshold), 65);
  assert.equal(ev.metadata.verdict, 'shortlist');
  const h = (await raw(`select note from application_stage_history where application_id = $1 and to_stage = 'shortlisted'`, [id])).rows[0];
  assert.match(h.note, /AI screening \d+% .*threshold 65/);
  /* "Pushed to ATS": remembered, with how and with what score */
  const pushed = (await raw(`select ats_pushed_at, ats_pushed_via, ats_pushed_score from applications where id = $1`, [id])).rows[0];
  assert.ok(pushed.ats_pushed_at);
  assert.equal(pushed.ats_pushed_via, 'auto_screening');
  assert.ok(Number(pushed.ats_pushed_score) >= 65);
  const shown = (await c.get('/api/bootstrap')).body.data.applications.find((a) => a.id === id);
  assert.equal(shown.atsPushedVia, 'auto_screening', 'the screen is told');
  assert.equal((await raw(`select count(*)::int n from notifications where recipient_id = $1 and type = 'APPLICATION_STATUS'`, [c.id])).rows[0].n, 0, 'the candidate is not messaged by the screening');
});

test('already at Applied above 65: screened once more - moved, and never picked again', async () => {
  const c = await candidate();
  const id = await oldApplication(c, 'j_au', 70);
  const first = await screening.screenPending({ limit: 50 });
  assert.ok(first.screened >= 1, JSON.stringify(first));
  assert.equal(await stage(id), 'shortlisted', 'the new rule reaches an application that was already there');
  assert.equal((await raw(`select ats_pushed_via from applications where id = $1`, [id])).rows[0].ats_pushed_via, 'auto_screening', 'the catch-up is a push too');
  const evs = await events(id);
  assert.equal(Number(evs[evs.length - 1].metadata.threshold), 65);
  const n = evs.length;
  const alerts = (await raw(`select count(*)::int n from notifications where recipient_id = 'r_au' and application_id = $1`, [id])).rows[0].n;
  await screening.screenPending({ limit: 50 });
  await screening.screenPending({ limit: 50 });
  assert.equal((await events(id)).length, n, 'not screened again');
  assert.equal((await raw(`select count(*)::int n from notifications where recipient_id = 'r_au' and application_id = $1`, [id])).rows[0].n, alerts, 'the recruiter is not alerted again');
  assert.equal((await raw(`select count(*)::int n from application_stage_history where application_id = $1 and to_stage = 'shortlisted'`, [id])).rows[0].n, 1, 'moved once');
});

test('a requirement that names no skills is left for a recruiter - and is not re-screened every pass', async () => {
  const c = await candidate();
  const id = await oldApplication(c, 'j_au_noskills', 90);
  await screening.screenPending({ limit: 50 });
  assert.equal(await stage(id), 'applied', 'no skills were compared, so nothing moves it by itself');
  assert.equal((await raw(`select ats_pushed_at from applications where id = $1`, [id])).rows[0].ats_pushed_at, null, 'not pushed: no badge');
  const n = (await events(id)).length;
  assert.equal(Number((await events(id)).pop().metadata.threshold), 65);
  await screening.screenPending({ limit: 50 });
  await screening.screenPending({ limit: 50 });
  assert.equal((await events(id)).length, n, 'no loop');
});

test('further along is never touched; below the threshold stays put', async () => {
  const c1 = await candidate();
  const far = await oldApplication(c1, 'j_au', 95);
  await raw(`update applications set stage = 'interview_scheduled' where id = $1`, [far]);
  const c2 = await candidate();
  const low = await oldApplication(c2, 'j_au', 40);
  await screening.screenPending({ limit: 50 });
  assert.equal(await stage(far), 'interview_scheduled');
  assert.equal(await stage(low), 'applied');
  assert.equal((await events(low)).length, 1, 'a score below the threshold is not re-screened');
});

test('what is already on file is read back from the stage history; the first push stands', async () => {
  const fs = await import('node:fs');
  const sql = fs.readFileSync(new URL('../../supabase/migrations/0145_ats_pushed.sql', import.meta.url), 'utf8');
  const backfill = sql.slice(sql.indexOf('/* what is already on file'));
  const c = await candidate();
  const mk = async (note, ago) => {
    const id = `app_au_bf_${++seq}`;
    const cc = await candidate();
    await raw(`insert into applications (id, job_id, candidate_id, recruiter_id, stage, source) values ($1, 'j_au', $2, 'r_au', 'applied', 'portal')`, [id, cc.id]);
    await raw(`update applications set stage = 'shortlisted' where id = $1`, [id]);
    await raw(`update application_stage_history set note = $2, created_at = now() - $3::interval where application_id = $1 and to_stage = 'shortlisted'`, [id, note, ago]);
    return id;
  };
  const scr = await mk('AI screening 67% (threshold 65) - recommend shortlist: matches Sourcing', '3 days');
  const aiv = await mk('AI interview 72% - at or above the 65% pass mark: moved to Shortlisted (ATS)', '2 days');
  const btn = await mk('Sent to ATS from Applications', '1 day');
  const hand = await mk('moved by the recruiter', '1 day');
  await raw(backfill);
  const row = async (id) => (await raw(`select ats_pushed_via v, ats_pushed_score s, ats_pushed_at at from applications where id = $1`, [id])).rows[0];
  assert.deepEqual([(await row(scr)).v, Number((await row(scr)).s)], ['auto_screening', 67]);
  assert.deepEqual([(await row(aiv)).v, Number((await row(aiv)).s)], ['auto_ai_interview', 72]);
  assert.equal((await row(btn)).v, 'send_to_ats');
  assert.equal((await row(hand)).v, null, 'a hand-made move is not a push');
  const first = (await row(scr)).at;
  await raw(backfill);
  assert.equal(new Date((await row(scr)).at).getTime(), new Date(first).getTime(), 'run again: nothing is rewritten');
});

test('shutdown', async () => {
  await new Promise((r) => server.close(r));
  const { stopBackgroundWork } = await import('../src/app.js');
  stopBackgroundWork();
  const { closePool } = await import('../src/db.js');
  await closePool();
  await dbh.stop?.();
});
