/**
 * Candidate alerts for urgent hiring and the last date to apply (0095),
 * and the housekeeping that goes with a deadline.
 *
 *   A  urgent_hiring    a job is published or updated with Urgent hiring on
 *   B  deadline_2d      the last date is two days away     (daily, 09:00 IST)
 *   C  deadline_today   the last date is today              (daily, 09:00 IST)
 *
 * WHO. Every candidate whose AI Match with the job - explainMatch() in
 * core.js: JD skills matched / JD skills required, nothing else - is ABOVE
 * NOTIFY_MATCH_THRESHOLD (60 unless configured): 60 exactly gets nothing,
 * 60.01 does. A job that lists no skills has no AI Match and alerts
 * nobody. Anybody who already applied is skipped. For B and C the match is worked out again on the
 * day, because a profile edited since the job was posted is the profile
 * that counts.
 *
 * HOW. Both channels, always: an entry in their TeamLink inbox and an
 * email. Each is attempted on its own - an email outage does not stop the
 * inbox entry - and a failure is retried by the sweep. Every attempt is a
 * row in notification_log (candidate, job, event, channel, match %), and
 * a unique index on those four makes "once per candidate, per job, per
 * event" a property of the database rather than of this file.
 *
 * WHAT IT WILL NOT DO. Email somebody marked do-not-contact or opted out
 * of email (recorded as skipped). Name a client: the company in the
 * message is the label the candidate already sees on that job's card,
 * and never the word "Client".
 *
 * Housekeeping in the same sweep: urgent hiring switches itself off after
 * its fourteen days, a job past its last date is closed and its recruiter
 * told, and the recruiter is reminded two days before ("extend or close?").
 */
import { withUser } from '../db.js';
import { config } from '../config.js';
import { providers } from '../notify/providers.js';
import { emailLayout } from '../notify/layout.js';
import { claimNewJobNotice, releaseNewJobNotice } from '../notify/new-job-notice.js';
import {
  explainMatch, aboveThreshold, notifyThreshold, daysLeft, istDay,
} from './core.js';

const ENGINE = { userId: '', role: 'admin', profileId: null };
const CHANNELS = ['in_app', 'email'];
const MAX_ATTEMPTS = Number(process.env.PORTAL_ALERT_MAX_ATTEMPTS || 5);
const MAX_PER_RUN = Number(process.env.PORTAL_ALERT_MAX || 500);
const RETRY_BASE_MS = Number(process.env.PORTAL_ALERT_RETRY_MS || 15 * 60 * 1000);

const newId = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const base = () => config.publicOrigin.replace(/\/$/, '');
export const applyUrl = (jobId) => `${base()}/#/job/${encodeURIComponent(jobId)}`;

/* ------------------------------------------------------------------ *
 * what the candidate is told
 * ------------------------------------------------------------------ */

/**
 * The company exactly as the job's card shows it (companies.name, which
 * the card prints beside the title) - and if that label would put the
 * word "Client" in front of a candidate, TeamLink instead.
 */
export function companyLabel(name) {
  const n = String(name || '').trim();
  if (!n || /\bclients?\b/i.test(n)) return 'TeamLink';
  return n;
}

const fmtDate = (at) => {
  try {
    return new Date(at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
  } catch { return istDay(at); }
};

export function alertContent(event, { job, company, score, candidateName }) {
  const deadline = job.expires_at ? fmtDate(job.expires_at) : null;
  const match = `${Math.round(Number(score))}% match`;
  const url = applyUrl(job.id);
  const title = event === 'urgent_hiring' ? 'Urgent hiring'
    : event === 'deadline_2d' ? 'Last date to apply is approaching'
    : 'Last day to apply';
  const line = event === 'urgent_hiring'
    ? `${company} is hiring urgently for ${job.title}${job.location ? ` in ${job.location}` : ''}.`
    : event === 'deadline_2d'
      ? `Applications for ${job.title} close on ${deadline}. You have not applied yet.`
      : `Today is the last day to apply for ${job.title}.`;
  const subject = event === 'urgent_hiring'
    ? `Urgent hiring: ${job.title} at ${company}`
    : `Last date to apply: ${job.title} – ${deadline}`;

  const summary = [job.location, job.pay_label, job.exp_label, job.mode].filter(Boolean).join(' · ');
  const body = `${line}\n\nYour profile is a ${match} for this role.`
    + (summary ? `\n\n${job.title} · ${summary}` : '')
    + (deadline ? `\n\nLast date to apply: ${deadline}.` : '');

  const html = emailLayout({
    title: subject,
    preheader: `${match} · ${line}`,
    greeting: candidateName ? `Hi ${candidateName},` : 'Hi,',
    body,
    facts: [
      ['Role', job.title], ['Company', company], ['Location', job.location],
      ['Pay', job.pay_label], ['Experience', job.exp_label], ['Your match', match],
      ['Last date to apply', deadline],
    ],
    cta: { label: 'Apply now', url },
    note: `You are receiving this because your TeamLink profile is a strong match (${match}) for this role.`,
  });
  const text = `${candidateName ? `Hi ${candidateName},` : 'Hi,'}\n\n${body}\n\nApply now: ${url}\n\n— TeamLink`;

  return {
    inApp: {
      title,
      message: `${job.title} · ${company} · ${match} — ${line}`,
      metadata: {
        event, jobTitle: job.title, company, matchPercent: Math.round(Number(score)),
        line, deadline: job.expires_at ? new Date(job.expires_at).toISOString() : null,
        applyUrl: `#/job/${job.id}`, cta: 'Apply now',
      },
    },
    email: { subject, html, text },
  };
}

/* ------------------------------------------------------------------ *
 * the two channels
 * ------------------------------------------------------------------ */

const TYPE = { urgent_hiring: 'URGENT_HIRING', deadline_2d: 'DEADLINE_SOON', deadline_today: 'DEADLINE_TODAY' };

async function sendInApp({ event, cand, job, content }) {
  const id = await withUser(ENGINE, async (c) => (await c.query(
    `select notify_create($1,$2,'candidate',$3,$4,$5,$6,null,$7,null,$8::jsonb) as id`,
    [newId('ntf'), cand.id, TYPE[event], content.inApp.title, content.inApp.message,
     job.id, cand.id, JSON.stringify(content.inApp.metadata)])).rows[0].id);
  /* null: the inbox already holds this one (the dedupe index) - which is
     the outcome wanted, not a failure. */
  if (id) return { status: 'sent', ref: id };
  const existing = await withUser(ENGINE, async (c) => (await c.query(
    `select id from notifications where recipient_id=$1 and type=$2 and job_id=$3 limit 1`,
    [cand.id, TYPE[event], job.id])).rows[0]);
  return existing ? { status: 'sent', ref: existing.id } : { status: 'failed', error: 'the inbox entry was not created' };
}

async function sendEmail({ cand, content }) {
  if (cand.do_not_contact) return { status: 'skipped', error: 'do not contact' };
  if (cand.email_opt_in === false) return { status: 'skipped', error: 'opted out of email' };
  if (!cand.email) return { status: 'skipped', error: 'no email address' };
  const r = await providers.email.send({
    to: cand.email,
    subject: content.email.subject,
    html: content.email.html,
    text: content.email.text,
    vars: {
      to_name: cand.name, candidate_name: cand.name,
      subject: content.email.subject, message: content.email.text,
    },
  });
  if (r.status === 'sent' || r.status === 'delivered') return { status: 'sent', ref: r.ref || null, provider: r.provider };
  if (r.status === 'not_configured') return { status: 'not_configured', error: r.error, provider: r.provider };
  if (r.status === 'failed') return { status: 'failed', error: r.error, provider: r.provider };
  return { status: 'skipped', error: r.reason || r.error || r.status, provider: r.provider };
}

export const defaultDeps = { sendInApp, sendEmail };

async function attempt(channel, args, deps) {
  try {
    return channel === 'in_app' ? await deps.sendInApp(args) : await deps.sendEmail(args);
  } catch (err) {
    return { status: 'failed', error: err.message };
  }
}

async function recordResult(logId, r, attempts, now) {
  const retry = (r.status === 'failed' || r.status === 'not_configured') && attempts < MAX_ATTEMPTS
    ? new Date(now + RETRY_BASE_MS * attempts) : null;
  await withUser(ENGINE, (c) => c.query(
    `update notification_log
        set status=$2, provider_ref=$3, error=$4, attempts=$5, last_attempt_at=now(),
            sent_at = case when $2 = 'sent' then coalesce(sent_at, now()) else sent_at end,
            next_retry_at=$6
      where id=$1`,
    [logId, r.status, r.ref || null, r.error ? String(r.error).slice(0, 500) : null, attempts, retry]));
}

/**
 * One candidate, one job, one event: both channels, each on its own.
 * @returns {{in_app:string, email:string}} what happened on each
 */
export async function deliverAlert({ event, job, cand, score, now = Date.now(), deps = defaultDeps }) {
  const company = companyLabel(job.company_name);
  const content = alertContent(event, { job, company, score, candidateName: cand.name });
  const out = {};
  for (const channel of CHANNELS) {
    /* Claim the (candidate, job, event, channel) row first. If it is
       already there, this channel was handled - by a previous run, or by
       one running now - and nothing is sent twice. */
    const claimed = await withUser(ENGINE, async (c) => (await c.query(
      `insert into notification_log
         (channel, recipient_id, to_address, template, subject, body, status,
          candidate_id, job_id, event_type, match_percent)
       values ($1,$2,$3,$4,$5,$6,'queued',$2,$7,$8,$9)
       on conflict (candidate_id, job_id, event_type, channel) where event_type is not null
       do nothing returning id`,
      [channel, cand.id, channel === 'email' ? (cand.email || null) : null, event,
       channel === 'email' ? content.email.subject : content.inApp.title,
       channel === 'email' ? content.email.text.slice(0, 4000) : content.inApp.message,
       job.id, event, score])).rows[0]);
    if (!claimed) { out[channel] = 'already'; continue; }
    const r = await attempt(channel, { event, cand, job, content }, deps);
    await recordResult(claimed.id, r, 1, now);
    out[channel] = r.status;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * who
 * ------------------------------------------------------------------ */

async function jobRow(c, jobId) {
  return (await c.query(
    `select j.*, co.name as company_name from jobs j
       left join companies co on co.id = j.company_id where j.id = $1`, [jobId])).rows[0] || null;
}

const isLive = (j, now) => j && j.status === 'open' && !j.paused && !j.archived
  && (j.source_type || 'TEAMLINK') === 'TEAMLINK'          // 0113: TeamLink jobs only
  && (!j.expires_at || new Date(j.expires_at).getTime() > now);

/**
 * Score every candidate against the job, now, and alert those above the
 * threshold who have not applied.
 */
export async function alertJob(jobId, event, { now = Date.now(), deps = defaultDeps, threshold = notifyThreshold() } = {}) {
  const data = await withUser(ENGINE, async (c) => {
    const job = await jobRow(c, jobId);
    if (!isLive(job, now)) return { job, skip: 'job is not open' };
    const candidates = (await c.query(
      `select * from candidates order by updated_at desc nulls last limit 5000`)).rows;
    const applied = new Set((await c.query(
      `select candidate_id from applications where job_id=$1`, [jobId])).rows.map((r) => r.candidate_id));
    return { job, candidates, applied };
  });
  if (!data.job) return { jobId, event, skipped: 'no such job', considered: 0, eligible: 0, delivered: 0 };
  if (data.skip) return { jobId, event, skipped: data.skip, considered: 0, eligible: 0, delivered: 0 };

  const out = { jobId, event, threshold, considered: 0, eligible: 0, delivered: 0, skippedApplied: 0, results: [] };
  for (const cand of data.candidates) {
    out.considered += 1;
    let score;
    try { score = explainMatch(data.job, cand).score; } catch { continue; }
    if (!aboveThreshold(score, threshold)) continue;
    if (data.applied.has(cand.id)) { out.skippedApplied += 1; continue; }
    out.eligible += 1;
    if (out.eligible > MAX_PER_RUN) break;
    /* Urgent hiring announces a job, so it is one of the "new job for you"
       messages (0110): a candidate already told about this job by the
       profile match, a saved search or a saved-job alert is not told
       again. The last-date alerts are reminders and are not affected. */
    const announces = event === 'urgent_hiring';
    if (announces && !(await claimNewJobNotice(cand.id, data.job.id, 'urgent_hiring'))) {
      out.skippedTold = (out.skippedTold || 0) + 1;
      continue;
    }
    const r = await deliverAlert({ event, job: data.job, cand, score, now, deps });
    if (announces && !['sent', 'already'].includes(r.in_app) && !['sent', 'already'].includes(r.email)) {
      await releaseNewJobNotice(cand.id, data.job.id, 'urgent_hiring');
    }
    out.results.push({ candidateId: cand.id, score, ...r });
    if (r.in_app === 'sent' || r.email === 'sent') out.delivered += 1;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * A: urgent hiring
 * ------------------------------------------------------------------ */

/** Urgent jobs whose announcement is due (urgent_alerted_at is NULL). */
export async function runPendingUrgent({ now = Date.now(), deps = defaultDeps, jobId = null } = {}) {
  const ids = await withUser(ENGINE, async (c) => (await c.query(
    `select id from jobs
      where urgent and urgent_until > $1 and urgent_alerted_at is null
        and status = 'open' and not paused and not archived
        and (expires_at is null or expires_at > $1)
        and ($2::text is null or id = $2)`, [new Date(now), jobId])).rows.map((r) => r.id));
  const runs = [];
  for (const id of ids) {
    const r = await alertJob(id, 'urgent_hiring', { now, deps });
    await withUser(ENGINE, (c) => c.query(`update jobs set urgent_alerted_at = now() where id=$1`, [id]));
    runs.push(r);
  }
  return runs;
}

/** For the request that just saved a job: in the background, never failing it. */
export function kickUrgent(jobId) {
  if (process.env.DISABLE_BACKGROUND_WORK === 'true' && process.env.PORTAL_KICK !== 'true') return;
  setTimeout(() => {
    runPendingUrgent({ jobId }).then((runs) => {
      for (const r of runs) {
        if (r.eligible) console.log(`[portal] urgent ${r.jobId}: ${r.eligible} candidate(s) above ${r.threshold}%, ${r.delivered} reached`);
      }
    }).catch((err) => console.error(`[portal] urgent alert ${jobId} failed:`, err.message));
  }, 50).unref?.();
}

/* ------------------------------------------------------------------ *
 * B and C: the last date, once a day
 * ------------------------------------------------------------------ */

export async function runDeadlineAlerts({ now = Date.now(), deps = defaultDeps } = {}) {
  const jobs = await withUser(ENGINE, async (c) => (await c.query(
    `select id, expires_at from jobs
      where status = 'open' and not paused and not archived
        and expires_at is not null and expires_at > $1`, [new Date(now)])).rows);
  const runs = [];
  for (const j of jobs) {
    const left = daysLeft(j.expires_at, now);
    const event = left === 2 ? 'deadline_2d' : left === 0 ? 'deadline_today' : null;
    if (event) runs.push(await alertJob(j.id, event, { now, deps }));
  }
  return runs;
}

/* ------------------------------------------------------------------ *
 * housekeeping: urgent auto-off, closing, the recruiter's reminder
 * ------------------------------------------------------------------ */

export async function expireUrgent({ now = Date.now() } = {}) {
  return withUser(ENGINE, async (c) => (await c.query(
    `update jobs set urgent = false where urgent and urgent_until <= $1 returning id`,
    [new Date(now)])).rows.map((r) => r.id));
}

/** Past its last date: closed, and the recruiter told. */
export async function closeExpiredJobs({ now = Date.now() } = {}) {
  return withUser(ENGINE, async (c) => {
    const rows = (await c.query(
      `update jobs set status = 'closed', updated_at = now()
        where status = 'open' and expires_at is not null and expires_at <= $1
        returning id, title, recruiter_id, expires_at`, [new Date(now)])).rows;
    for (const j of rows) {
      if (!j.recruiter_id) continue;
      await c.query(
        `select notify_create($1,$2,'recruiter','JOB_CLOSED_EXPIRED',$3,$4,$5,null,null,$2,$6::jsonb)`,
        [newId('ntf'), j.recruiter_id, `Closed: ${j.title}`,
         `"${j.title}" reached its last date to apply (${fmtDate(j.expires_at)}) and was closed automatically. `
         + 'Republish it with a new last date to take more applications.',
         j.id, JSON.stringify({ stage: istDay(j.expires_at), lastDate: new Date(j.expires_at).toISOString() })]);
    }
    return rows.map((r) => r.id);
  });
}

/** Two days before the last date: "extend or close?". Once per deadline. */
export async function remindRecruiters({ now = Date.now() } = {}) {
  return withUser(ENGINE, async (c) => {
    const rows = (await c.query(
      `select id, title, recruiter_id, expires_at from jobs
        where status = 'open' and not archived and expires_at is not null and expires_at > $1
          and deadline_reminded_for is distinct from expires_at`, [new Date(now)])).rows
      .filter((j) => daysLeft(j.expires_at, now) === 2);
    const done = [];
    for (const j of rows) {
      if (j.recruiter_id) {
        await c.query(
          `select notify_create($1,$2,'recruiter','JOB_DEADLINE_REMINDER',$3,$4,$5,null,null,$2,$6::jsonb)`,
          [newId('ntf'), j.recruiter_id, `2 days left: ${j.title}`,
           `Applications for "${j.title}" close on ${fmtDate(j.expires_at)}. Extend the last date or let it close?`,
           j.id, JSON.stringify({ stage: istDay(j.expires_at), lastDate: new Date(j.expires_at).toISOString() })]);
      }
      await c.query(`update jobs set deadline_reminded_for = expires_at where id=$1`, [j.id]);
      done.push(j.id);
    }
    return done;
  });
}

/* ------------------------------------------------------------------ *
 * retrying a channel that failed
 * ------------------------------------------------------------------ */

/**
 * Every alert channel that failed (or had no provider, once one exists)
 * and is due again. The message is rebuilt from the job and the candidate
 * as they are now, with the match recorded when it was first sent; one
 * that no longer applies - the job closed, or they applied meanwhile - is
 * marked skipped rather than sent late.
 */
export async function retryAlerts({ now = Date.now(), deps = defaultDeps, limit = 100 } = {}) {
  const emailReady = providers.email.configured();
  const rows = await withUser(ENGINE, async (c) => (await c.query(
    `select * from notification_log
      where event_type is not null and attempts < $1
        and (status = 'failed' or (status = 'not_configured' and $2))
        and (next_retry_at is null or next_retry_at <= $3)
      order by id limit $4`, [MAX_ATTEMPTS, emailReady, new Date(now), limit])).rows);
  const out = { considered: rows.length, sent: 0, failed: 0, skipped: 0 };
  for (const row of rows) {
    const ctx = await withUser(ENGINE, async (c) => ({
      job: await jobRow(c, row.job_id),
      cand: (await c.query(`select * from candidates where id=$1`, [row.candidate_id])).rows[0],
      applied: (await c.query(`select 1 from applications where job_id=$1 and candidate_id=$2`,
        [row.job_id, row.candidate_id])).rowCount > 0,
    }));
    let r;
    if (!ctx.cand || !isLive(ctx.job, now)) r = { status: 'skipped', error: 'the job is no longer open' };
    else if (ctx.applied) r = { status: 'skipped', error: 'the candidate has applied since' };
    else {
      const content = alertContent(row.event_type, {
        job: ctx.job, company: companyLabel(ctx.job.company_name),
        score: row.match_percent, candidateName: ctx.cand.name,
      });
      r = await attempt(row.channel, { event: row.event_type, cand: ctx.cand, job: ctx.job, content }, deps);
    }
    await recordResult(row.id, r, Number(row.attempts || 0) + 1, now);
    if (r.status === 'sent') out.sent += 1;
    else if (r.status === 'skipped') out.skipped += 1;
    else out.failed += 1;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * the sweep
 * ------------------------------------------------------------------ */

const DAILY_HOUR_IST = Number(process.env.PORTAL_DAILY_HOUR_IST || 9);

/** The once-a-day pass, if it is due and has not run for this IST day. */
export async function runDailyIfDue({ now = Date.now(), deps = defaultDeps, force = false } = {}) {
  const hour = new Date(now + 330 * 60 * 1000).getUTCHours();
  if (!force && hour < DAILY_HOUR_IST) return null;
  const day = istDay(now);
  const done = await withUser(ENGINE, async (c) => (await c.query(
    `select 1 from portal_daily_runs where kind='deadlines' and day=$1`, [day])).rowCount > 0);
  if (done && !force) return null;
  const reminded = await remindRecruiters({ now });
  const runs = await runDeadlineAlerts({ now, deps });
  await withUser(ENGINE, (c) => c.query(
    `insert into portal_daily_runs (kind, day, detail) values ('deadlines', $1, $2::jsonb)
     on conflict (kind, day) do update set ran_at = now(), detail = excluded.detail`,
    [day, JSON.stringify({ reminded: reminded.length, jobs: runs.length,
      eligible: runs.reduce((n, r) => n + (r.eligible || 0), 0) })]));
  return { day, reminded, runs };
}

/** One tick: everything above, each part on its own. */
export async function portalTick({ now = Date.now(), deps = defaultDeps } = {}) {
  const out = {};
  const step = async (name, fn) => {
    try { out[name] = await fn(); } catch (err) { out[name] = { error: err.message }; console.error(`[portal] ${name} failed:`, err.message); }
  };
  await step('urgentOff', () => expireUrgent({ now }));
  await step('closed', () => closeExpiredJobs({ now }));
  await step('urgent', () => runPendingUrgent({ now, deps }));
  await step('daily', () => runDailyIfDue({ now, deps }));
  await step('retry', () => retryAlerts({ now, deps }));
  return out;
}

export function startPortalSweep() {
  const every = Number(process.env.PORTAL_SWEEP_MS || 5 * 60 * 1000);
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const r = await portalTick();
      const closed = Array.isArray(r.closed) ? r.closed.length : 0;
      if (closed) console.log(`[portal] ${closed} job(s) closed after their last date`);
    } catch (err) {
      console.error('[portal] the sweep failed:', err.message);
    } finally { running = false; }
  };
  const first = setTimeout(run, Number(process.env.PORTAL_SWEEP_FIRST_MS || 45_000));
  const timer = setInterval(run, every);
  first.unref?.();
  timer.unref?.();
  return () => { clearTimeout(first); clearInterval(timer); };
}
