/**
 * The two-day AI interview window.
 *
 * Two halves, because they fail differently.
 *
 * 1. THE RULE, against a real Postgres (PGlite, the same engine the dev
 *    server runs). Time is the hard part of testing a deadline, and the
 *    only honest way to test "24 hours before" without waiting a day is
 *    to move the deadline, not to mock the clock. Every migration is
 *    applied to a clean database, fixtures are inserted, and the queue
 *    function is asked what it would send.
 *
 * 2. THE LIVE PATH, through HTTP against the running server: a real
 *    application must come back with a deadline two days out, and the
 *    interview it starts must inherit that deadline rather than granting
 *    itself a fresh two days.
 *
 *   node tools/verify-deadline.mjs      (needs npm run dev on :4323)
 */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { buildEventMessages } from '../api/src/notify/templates.js';

const BASE = process.env.TL_URL || 'http://localhost:4323/';

let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  PASS  ${name}`); }
  catch (e) { console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n')[0]}`); failed++; }
};
const must = (c, m) => { if (!c) throw new Error(m); };

/* ------------------------------------------------------------------ *
 * 1. the rule
 * ------------------------------------------------------------------ */
console.log('\nthe deadline rule, on a real Postgres');

const db = await new PGlite();
const DIR = 'supabase/migrations';
for (const f of readdirSync(DIR).filter((x) => x.endsWith('.sql') && !/seed/.test(x)).sort()) {
  await db.exec(readFileSync(join(DIR, f), 'utf8'));
}

const q = async (sql, params) => (await db.query(sql, params)).rows;

// The sweep reads as an administrator; RLS decides that from app.role.
await db.exec(`select set_config('app.role','admin',false)`);

await check('the schema carries the deadline, the marks and the queue', async () => {
  const cols = await q(
    `select column_name from information_schema.columns
      where table_name='applications' and column_name='ai_interview_due_at'`);
  must(cols.length === 1, 'applications has no ai_interview_due_at');

  const fns = await q(
    `select proname from pg_proc
      where proname in ('ai_interview_due_queue','ai_interview_reminder_sent',
                        'ai_interview_expire_overdue')`);
  must(fns.length === 3, `only ${fns.length} of the 3 deadline functions exist`);
});

/** A candidate who applied and has not taken the interview. */
async function fixture(id, dueSql) {
  await db.exec(`
    insert into companies (id, name) values ('co_${id}', 'Co ${id}') on conflict do nothing;
    insert into jobs (id, company_id, title, status)
      values ('job_${id}', 'co_${id}', 'Engineer ${id}', 'open') on conflict do nothing;
    insert into candidates (id, name, email)
      values ('cand_${id}', 'Cand ${id}', '${id}@example.test') on conflict do nothing;
    insert into applications (id, candidate_id, job_id, stage, applied_at, ai_interview_due_at)
      values ('app_${id}', 'cand_${id}', 'job_${id}', 'applied', now(), ${dueSql});
  `);
}

await check('nothing is owed while there is time left', async () => {
  await fixture('plenty', `now() + interval '40 hours'`);
  const owed = await q(`select * from ai_interview_due_queue() where application_id='app_plenty'`);
  must(owed.length === 0, `a message was owed 40 hours before the deadline: ${owed[0]?.kind}`);
});

await check('a reminder is owed 24 hours out', async () => {
  await fixture('day', `now() + interval '20 hours'`);
  const owed = await q(`select * from ai_interview_due_queue() where application_id='app_day'`);
  must(owed.length === 1 && owed[0].kind === 'reminder',
    `expected a reminder, got ${JSON.stringify(owed)}`);
});

await check('the final warning replaces the reminder in the last two hours', async () => {
  await fixture('last', `now() + interval '90 minutes'`);
  const owed = await q(`select * from ai_interview_due_queue() where application_id='app_last'`);
  must(owed.length === 1, `${owed.length} messages were owed at once`);
  must(owed[0].kind === 'final', `expected the final warning, got ${owed[0].kind}`);
});

await check('an expired window is owed an expiry notice', async () => {
  await fixture('gone', `now() - interval '1 hour'`);
  const owed = await q(`select * from ai_interview_due_queue() where application_id='app_gone'`);
  must(owed.length === 1 && owed[0].kind === 'expired',
    `expected an expiry notice, got ${JSON.stringify(owed)}`);
});

await check('a message already sent is never owed again', async () => {
  await q(`select ai_interview_reminder_sent('app_day','reminder')`);
  const owed = await q(`select * from ai_interview_due_queue() where application_id='app_day'`);
  must(owed.length === 0, 'the same reminder was owed twice');

  // and marking it twice is not an error
  await q(`select ai_interview_reminder_sent('app_day','reminder')`);
});

await check('a candidate who finished the interview is left alone', async () => {
  await fixture('done', `now() + interval '10 hours'`);
  await db.exec(`
    insert into ai_interviews (id, application_id, candidate_id, job_id, status, mode,
                               questions_asked, started_at, completed_at, overall_percentage)
    values ('aiv_done','app_done','cand_done','job_done','completed','voice',15,now(),now(),71);
    insert into ai_interview_answers (ai_interview_id, seq, category, question, answered, score)
    values ('aiv_done', 1, 'intro', 'Tell me about yourself.', true, 71);
  `);
  const owed = await q(`select * from ai_interview_due_queue() where application_id='app_done'`);
  must(owed.length === 0, 'a completed interview was reminded about');
});

await check('an interview inherits the application deadline, not a fresh two days', async () => {
  await fixture('inherit', `now() + interval '5 hours'`);
  await q(`select ai_interview_start('aiv_inherit','app_inherit','cand_inherit','job_inherit',
             'qs_test', $1::jsonb)`,
    [JSON.stringify([{ seq: 1, category: 'intro', section: 'intro', question: 'Hello?' }])]);
  const rows = await q(
    `select extract(epoch from (expires_at - now()))/3600 as hours
       from ai_interviews where id='aiv_inherit'`);
  must(Math.abs(Number(rows[0].hours) - 5) < 0.2,
    `the interview expires in ${Number(rows[0].hours).toFixed(1)}h, not the application's 5h`);
});

await check('an overdue interview is marked expired, not left in progress', async () => {
  await fixture('overdue', `now() - interval '3 hours'`);
  await db.exec(`
    insert into ai_interviews (id, application_id, candidate_id, job_id, status, mode,
                               questions_asked, started_at, expires_at)
    values ('aiv_overdue','app_overdue','cand_overdue','job_overdue','in_progress','voice',
            15, now() - interval '50 hours', now() - interval '2 hours');
  `);
  await q(`select ai_interview_expire_overdue()`);
  const rows = await q(`select status from ai_interviews where id='aiv_overdue'`);
  must(rows[0].status === 'expired', `an overdue interview is still "${rows[0].status}"`);
});

await db.close();

/* ------------------------------------------------------------------ *
 * 2. the live path
 * ------------------------------------------------------------------ */
console.log('\nthe deadline a real application gets');

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
await page.goto(BASE, { waitUntil: 'load' });
await page.waitForFunction(() => window.TL && window.TL.ready === true, { timeout: 25000 });

const api = (method, path, body) =>
  page.evaluate(([m, p, b]) => window.TL.api[m](p, b), [method, path, body]);

let applicationId, dueAt;

await check('a new application is given two days for the AI interview', async () => {
  await api('post', '/auth/register', {
    name: 'Deadline Tester',
    email: `deadline.${Date.now()}@example.test`,
    password: 'Deadline@2026',
  });
  await page.evaluate(() => window.TL.refresh());
  await page.waitForTimeout(500);

  const jobId = await page.evaluate(() => (DATA.jobs.find((j) => j.status === 'open') || {}).id);
  const app = await api('post', '/applications', { jobId, source: 'portal' });
  applicationId = app.application.id;

  const mine = await api('get', '/bootstrap').then((b) =>
    (b.data.applications || []).find((a) => a.id === applicationId));
  must(mine, 'the application is not readable');
  must(mine.aiInterviewDueAt, 'the application carries no AI interview deadline');
  dueAt = new Date(mine.aiInterviewDueAt);

  const hours = (dueAt - new Date()) / 3600000;
  must(Math.abs(hours - 48) < 1, `the deadline is ${hours.toFixed(1)} hours away, not 48`);
});

await check('the interview the candidate starts inherits that same deadline', async () => {
  const s = await api('post', '/ai-interviews/session', { applicationId });
  must(s.expiresAt, 'the session returned no deadline');
  const drift = Math.abs(new Date(s.expiresAt) - dueAt) / 60000;
  must(drift < 2, `the interview expires ${drift.toFixed(0)} minutes from the application deadline`);
});

/* ------------------------------------------------------------------ *
 * 3. what each message actually says
 *
 * A reminder that does not state the deadline is not a reminder. These
 * are rendered rather than described, on every channel, because the SMS
 * and the spoken call are built from the same body and drift silently.
 * ------------------------------------------------------------------ */
console.log('\nwhat the four deadline messages say');

const ctxFor = (event) => buildEventMessages(event, {
  candidateName: 'Asha Rao',
  jobTitle: 'Backend Engineer',
  company: 'Northwind',
  jobId: 'job_1',
  applicationId: 'app_1',
  portalUrl: 'http://localhost:4323/#/candidate/applications',
  dueAt: new Date(Date.now() + 36 * 3600 * 1000),
});

for (const [event, wants] of [
  ['AI_INTERVIEW_INVITED',  [/15 questions/i, /two days|48 hours/i]],
  ['AI_INTERVIEW_REMINDER', [/24 hours|closes/i]],
  ['AI_INTERVIEW_FINAL',    [/two hours|2 hours/i]],
  ['AI_INTERVIEW_EXPIRED',  [/closed/i, /reopen/i]],
]) {
  // eslint-disable-next-line no-loop-func
  await check(`${event.replace('AI_INTERVIEW_', '').toLowerCase().padEnd(9)} reaches every channel and states the deadline`, async () => {
    const m = ctxFor(event);
    must(m, `${event} has no template`);
    for (const ch of ['sms', 'ivr', 'whatsapp']) {
      must(m[ch] && m[ch].length > 20, `${event} has no ${ch} message`);
    }
    must(m.email && m.email.subject && m.email.html, `${event} has no email`);

    // The date, in words, in the long-form channels.
    const day = new Date(Date.now() + 36 * 3600 * 1000)
      .toLocaleString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
    must(m.email.text.includes(day) || m.email.subject.includes(day),
      `${event} does not state the deadline date`);

    for (const re of wants) {
      must(re.test(m.email.text), `${event} does not say ${re}`);
    }

    // Nothing spoken aloud should read out a URL or an id.
    must(!/http|Job ID/i.test(m.ivr), `${event} reads a link or an id aloud`);
  });
}

await browser.close();
console.log(failed === 0
  ? '\n  DEADLINE VERIFIED — two days from the invitation, reminded, and expired when it passes\n'
  : `\n  ${failed} check(s) FAILED\n`);
process.exit(failed ? 1 : 0);
