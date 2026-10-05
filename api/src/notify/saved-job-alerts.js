/**
 * "New job like one you saved" (0110).
 *
 * A candidate who saves a job has told us what kind of job they want.
 * When another job of that kind is published they get an entry in their
 * TeamLink inbox and an email that names the saved job it is like.
 *
 * RELATED means, against one of the candidate's saved jobs (see
 * relatedJob() below - built from the match engine's own title and skill
 * scorers in ai/match.js and the role key from 0091, not a new matcher):
 *
 *   same role       app_role_key() of the two titles is the same
 *                   ("Senior Java Developer" = "Java Developer")
 *   similar role    the distinctive title words overlap by half or more,
 *                   both ways ("ICU Nurse" ~ "Staff Nurse"), or one title
 *                   is wholly inside the other; sharing more than a level
 *                   or shift word ("Sales Manager" !~ "Store Manager");
 *                   and where both jobs list skills they share one
 *   shared skills   two or more skills in common covering 60% of the
 *                   shorter list, with some title overlap - or three or
 *                   more skills in common on their own
 *
 * WHEN. Instantly, chained after the publish hook (job-alerts.js runs the
 * profile match, then saved searches, then this), and from a ten-minute
 * sweep that processes any open job published in the last few days the
 * hook did not see (saved_job_alert_jobs records what was processed).
 * Only a LIVE job: open, not paused or archived, not past its last date.
 * A draft never alerts.
 *
 * NOT SENT:
 *   - the saved job itself, a job they also saved, applied to or hid,
 *     or a job like a saved job they have since hidden;
 *   - a job published before they saved the job it is like (it is not
 *     "new" to them);
 *   - anything to a do-not-contact candidate, or one who switched
 *     "Tell me about similar new jobs" off (or used the email's link);
 *   - email to a candidate who opted out of email (the inbox entry still
 *     goes);
 *   - a job somebody was ALREADY told about by another alert - profile
 *     match, saved search or urgent hiring - through the shared ledger
 *     candidate_new_job_notices (new-job-notice.js): one "new job for
 *     you" message per candidate per job, whichever system is first;
 *   - the same job twice: (candidate, job) is the primary key of
 *     candidate_saved_job_alerts.
 *
 * HOW MANY. At most SAVED_JOB_ALERT_DAILY_CAP (3) instant alerts per
 * candidate per IST day. The rest are queued and go out together in one
 * evening digest (SAVED_JOB_DIGEST_HOUR_IST, 19:00).
 *
 * COMPANY. Only the label the candidate already sees on the job's card,
 * through companyLabel(): never a hidden client name and never "Client".
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { withUser } from '../db.js';
import { config } from '../config.js';
import { providers } from './providers.js';
import { scoreRole, scoreSkills } from '../ai/match.js';
import { companyLabel } from '../portal/alerts.js';
import { releaseNewJobNotice } from './new-job-notice.js';
import {
  buildSavedJobAlertMessages, buildSavedJobDigestMessages, savedJobInboxLine,
} from './templates-saved-jobs.js';

const ENGINE = { userId: '', role: 'admin', profileId: null };
const IST_MS = 330 * 60 * 1000;

export const dailyCap = () => {
  const n = Number(process.env.SAVED_JOB_ALERT_DAILY_CAP);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 3;
};
const digestHour = () => {
  const n = Number(process.env.SAVED_JOB_DIGEST_HOUR_IST);
  return Number.isFinite(n) && n >= 0 && n <= 23 ? Math.floor(n) : 19;
};
const lookbackDays = () => Number(process.env.SAVED_JOB_ALERT_LOOKBACK_DAYS || 3);

const newId = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
export const istDay = (at) => new Date(Number(at) + IST_MS).toISOString().slice(0, 10);

/* ------------------------------------------------------------------ *
 * the unsubscribe link: works without signing in
 * ------------------------------------------------------------------ */

const sig = (id) => createHmac('sha256', config.authSecret)
  .update(`saved-job-stop:${id}`).digest('base64url');

export function stopToken(candidateId) { return `${candidateId}.${sig(candidateId)}`; }

/** The candidate id the token was issued for, or null. */
export function verifyStopToken(token) {
  const s = String(token || '');
  const dot = s.lastIndexOf('.');
  if (dot < 1) return null;
  const id = s.slice(0, dot);
  const given = Buffer.from(s.slice(dot + 1));
  const want = Buffer.from(sig(id));
  if (given.length !== want.length) return null;
  return timingSafeEqual(given, want) ? id : null;
}

const base = () => config.publicOrigin.replace(/\/$/, '');
const jobUrl = (id) => `${base()}/#/job/${encodeURIComponent(id)}`;
const savedUrl = () => `${base()}/#/candidate/saved`;
const stopUrl = (candidateId) =>
  `${base()}/api/saved-job-alerts/stop?token=${encodeURIComponent(stopToken(candidateId))}`;

/* ------------------------------------------------------------------ *
 * related or not
 * ------------------------------------------------------------------ */

const norm = (v) => String(v || '').toLowerCase().replace(/\s+/g, ' ').trim();

/*
 * Words that say what LEVEL or SHIFT a job is, not what it is: two titles
 * that share only these ("Sales Manager" / "Store Manager") are not the
 * same kind of job. The match engine's own STOP_TITLE already drops
 * "senior", "developer", "executive" and the like.
 */
const GENERIC = new Set([
  'manager', 'officer', 'assistant', 'operator', 'technician', 'worker', 'staff', 'head', 'helper',
  'supervisor', 'trainee', 'intern', 'internship', 'coordinator', 'incharge', 'member', 'team', 'boy', 'girl',
  'night', 'day', 'shift', 'remote', 'onsite', 'hybrid', 'full', 'part', 'time', 'walk', 'walkin', 'fresher',
  'freshers', 'iii', 'level', 'grade', 'new', 'job', 'jobs', 'vacancy', 'opening', 'openings', 'post',
]);

/**
 * How much of a's distinctive title words b's title shares (0..1), and
 * whether any shared word is more than a level or a shift - through the
 * match engine's role scorer (ai/match.js scoreRole).
 */
function titleShare(a, b) {
  const r = scoreRole({ title: a.title }, { title: b.title });
  if (r.weak) {
    const same = !!norm(a.title) && norm(a.title) === norm(b.title);
    return { ratio: same ? 1 : 0, real: same };
  }
  return { ratio: r.ratio || 0, real: (r.matched || []).some((w) => !GENERIC.has(w)) };
}

/** The skills of `a` that `b` also lists, in a's own spelling. */
function sharedSkills(a, b) {
  const list = Array.isArray(a.skills) ? a.skills : [];
  const other = Array.isArray(b.skills) ? b.skills : [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const m = scoreSkills({ skills: [raw] }, { skills: other }).matched;
    if (m.length && !seen.has(m[0])) { seen.add(m[0]); out.push(String(raw).trim()); }
  }
  return out;
}

const skillCount = (x) => scoreSkills({ skills: Array.isArray(x.skills) ? x.skills : [] }, { skills: [] }).missing.length;

/**
 * Is `job` like `saved`? Both: { title, department, skills, roleKey }
 * (roleKey = app_role_key(title, department), computed by the database).
 *
 * @returns {{related:boolean, reason?:string, why?:string, strength:number}}
 */
export function relatedJob(job, saved) {
  if (!job || !saved) return { related: false, strength: 0 };
  if (job.roleKey && saved.roleKey && job.roleKey === saved.roleKey) {
    return { related: true, reason: 'same role', why: 'it is the same role as the job you saved', strength: 100 };
  }
  const ab = titleShare(job, saved), ba = titleShare(saved, job);
  /* Half or more of each title's words in the other, or one title wholly
     inside the other ("Staff Nurse" in "ICU Staff Nurse (Night Shift)") -
     and in either case sharing a word that is more than a level. */
  const real = ab.real || ba.real;
  const t = real ? Math.max(Math.min(ab.ratio, ba.ratio), Math.max(ab.ratio, ba.ratio) === 1 ? 0.5 : 0) : 0;
  const nJob = skillCount(job), nSaved = skillCount(saved);
  const both = nJob > 0 && nSaved > 0;
  const shared = both ? sharedSkills(job, saved) : [];
  const cover = both ? shared.length / Math.min(nJob, nSaved) : 0;

  if (t >= 0.5 && (!both || shared.length >= 1)) {
    return { related: true, reason: 'similar role', why: 'it has a very similar job title',
             strength: Math.round(50 + 40 * t + 9 * cover) };
  }
  if (both && shared.length >= 2 && cover >= 0.6 && (t > 0 || shared.length >= 3)) {
    return { related: true, reason: 'shared skills',
             why: `it asks for the same skills (${shared.slice(0, 5).join(', ')})`,
             strength: Math.round(40 + 40 * cover + 10 * t) };
  }
  return { related: false, strength: 0 };
}

/* ------------------------------------------------------------------ *
 * the two channels
 * ------------------------------------------------------------------ */

async function sendInApp({ cand, type, title, message, jobId, metadata }) {
  const id = await withUser(ENGINE, async (c) => (await c.query(
    `select notify_create($1,$2,'candidate',$3,$4,$5,$6,null,$7,null,$8::jsonb) as id`,
    [newId('ntf'), cand.id, type, title, message, jobId, cand.id, JSON.stringify(metadata || {})])).rows[0].id);
  if (id) return { status: 'sent', ref: id };
  /* null: the inbox already holds this one (its dedupe index). */
  const existing = await withUser(ENGINE, async (c) => (await c.query(
    `select id from notifications where recipient_id=$1 and type=$2 and job_id=$3 limit 1`,
    [cand.id, type, jobId])).rows[0]);
  return existing ? { status: 'sent', ref: existing.id } : { status: 'failed', error: 'the inbox entry was not created' };
}

async function sendEmail({ cand, email, templateId }) {
  if (cand.email_opt_in === false) return { status: 'skipped_opted_out', error: 'opted out of email' };
  if (!cand.email) return { status: 'skipped_no_address' };
  const r = await providers.email.send({
    to: cand.email,
    subject: email.subject, html: email.html, text: email.text,
    templateId: templateId || undefined,
    vars: {
      to_name: cand.name, candidate_name: cand.name,
      subject: email.subject, message: email.text, portal_link: email.link || savedUrl(),
    },
  });
  return { status: r.status, ref: r.ref || null, error: r.error || r.reason || null, provider: r.provider };
}

export const defaultDeps = { sendInApp, sendEmail };

async function attempt(fn, args) {
  try { return await fn(args); } catch (err) { return { status: 'failed', error: err.message }; }
}

/* ------------------------------------------------------------------ *
 * reading
 * ------------------------------------------------------------------ */

const JOB_SQL = `
  select j.*, co.name as company_name, app_role_key(j.title, j.department) as role_key,
         case when j.posting_kind = 'walkin' then walkin_ends_at(j.walkin_date, j.walkin_to) end as walkin_ends
    from jobs j left join companies co on co.id = j.company_id`;

/* A walk-in whose day and end time have passed (IST, 0106) is over,
   whatever its status still says. */
const isLive = (j, now) => !!j && j.status === 'open' && !j.paused && !j.archived
  && (!j.expires_at || new Date(j.expires_at).getTime() > now)
  && (!j.walkin_ends || new Date(j.walkin_ends).getTime() > now);

/*
 * Every saved job of every candidate who could be told about `$1`: not
 * the job itself, saved BEFORE `$1` was published, and not for anybody
 * who saved, applied to or hid `$1`, hid the saved job, or was already
 * decided for.
 */
const ANCHOR_SQL = `
  select s.candidate_id, s.created_at as saved_at,
         j.id, j.title, j.department, j.skills, j.location, j.status,
         co.name as company_name, app_role_key(j.title, j.department) as role_key
    from saved_jobs s
    join jobs j on j.id = s.job_id
    left join companies co on co.id = j.company_id
   where s.job_id <> $1
     and s.created_at <= $2
     and not exists (select 1 from saved_jobs s2 where s2.candidate_id = s.candidate_id and s2.job_id = $1)
     and not exists (select 1 from applications a where a.candidate_id = s.candidate_id and a.job_id = $1)
     and not exists (select 1 from hidden_jobs h where h.candidate_id = s.candidate_id
                                                and h.job_id in ($1, s.job_id))
     and not exists (select 1 from candidate_saved_job_alerts x
                      where x.candidate_id = s.candidate_id and x.job_id = $1)`;

async function templateIds(c) {
  try {
    const { rows } = await c.query(
      `select event_key, template_id from notification_templates
        where event_key in ('saved_job_alert','saved_job_digest')`);
    return Object.fromEntries(rows.map((r) => [r.event_key, r.template_id]));
  } catch { return {}; }
}

const asJob = (r) => ({ title: r.title, department: r.department, skills: r.skills || [], roleKey: r.role_key });

/* ------------------------------------------------------------------ *
 * instant: the moment a job is published
 * ------------------------------------------------------------------ */

async function recordSkip(candId, jobId, savedId, reason, skip, now) {
  await withUser(ENGINE, (c) => c.query(
    `insert into candidate_saved_job_alerts
       (candidate_id, job_id, saved_job_id, reason, kind, status, skip_reason, day)
     values ($1,$2,$3,$4,'instant','skipped',$5,$6) on conflict do nothing`,
    [candId, jobId, savedId, reason, skip, istDay(now)]));
}

async function deliverInstant({ cand, job, saved, rel, tpl, deps }) {
  const company = companyLabel(job.company_name);
  const savedCompany = companyLabel(saved.company_name);
  const url = jobUrl(job.id);
  const email = buildSavedJobAlertMessages({
    candidateName: cand.name,
    job: { title: job.title, company, location: job.location, pay: job.pay_label, exp: job.exp_label, url },
    saved: { title: saved.title, company: savedCompany, location: saved.location },
    why: rel.why,
    stopUrl: stopUrl(cand.id),
    savedUrl: savedUrl(),
  }).email;
  email.link = url;

  const inApp = await attempt(deps.sendInApp, {
    cand, type: 'SAVED_JOB_SIMILAR', jobId: job.id,
    title: 'New job like one you saved',
    message: savedJobInboxLine(job),
    metadata: {
      event: 'saved_job_similar', jobTitle: job.title, company, location: job.location || null,
      savedJobId: saved.id, savedJobTitle: saved.title, reason: rel.reason,
      applyUrl: `#/job/${job.id}`, cta: 'View job',
    },
  });
  const mail = await attempt(deps.sendEmail, { cand, email, templateId: tpl.saved_job_alert });
  const ok = inApp.status === 'sent' || mail.status === 'sent';

  await withUser(ENGINE, (c) => c.query(
    `update candidate_saved_job_alerts
        set status = $3, notification_id = $4, email_status = $5, email_ref = $6, email_error = $7,
            sent_at = case when $3 = 'sent' then now() else sent_at end
      where candidate_id = $1 and job_id = $2`,
    [cand.id, job.id, ok ? 'sent' : 'failed', inApp.status === 'sent' ? inApp.ref : null,
     mail.status, mail.ref || null, mail.error ? String(mail.error).slice(0, 500) : null]));
  if (!ok) await releaseNewJobNotice(cand.id, job.id, 'saved_job');
  return { in_app: inApp.status, email: mail.status };
}

/**
 * Tell every candidate one of whose saved jobs this job is like.
 * @returns {{jobId, considered, related, instant, digest, told, skipped, sent, results}}
 */
export async function runSavedJobInstant(jobId, opts = {}) {
  const now = opts.now ?? Date.now();
  const deps = opts.deps || defaultDeps;
  const cap = opts.cap ?? dailyCap();

  const data = await withUser(ENGINE, async (c) => {
    const job = (await c.query(`${JOB_SQL} where j.id = $1`, [jobId])).rows[0];
    if (!job) return { skip: 'no such job' };
    if (!isLive(job, now)) return { job, skip: 'job is not open' };
    const publishedAt = job.published_at || job.created_at;
    const anchors = (await c.query(ANCHOR_SQL, [jobId, publishedAt])).rows;
    const ids = [...new Set(anchors.map((a) => a.candidate_id))];
    const cands = ids.length ? (await c.query(
      `select c.*, coalesce(s.enabled, true) as similar_alerts_on
         from candidates c left join candidate_saved_job_alert_settings s on s.candidate_id = c.id
        where c.id = any($1)`, [ids])).rows : [];
    return { job, anchors, cands, publishedAt, tpl: await templateIds(c) };
  });
  const out = { jobId, considered: 0, related: 0, instant: 0, digest: 0, told: 0, skipped: 0, sent: 0, results: [] };
  if (data.skip) return { ...out, skipped: 0, skip: data.skip };

  const { job } = data;
  const target = asJob(job);
  const byCand = new Map();
  for (const a of data.anchors) {
    const rel = relatedJob(target, asJob(a));
    const prev = byCand.get(a.candidate_id);
    if (!prev) out.considered += 1;
    if (!rel.related) { if (!prev) byCand.set(a.candidate_id, null); continue; }
    if (!prev || rel.strength > prev.rel.strength) byCand.set(a.candidate_id, { saved: a, rel });
  }
  const cands = new Map(data.cands.map((r) => [r.id, r]));

  for (const [candId, best] of byCand) {
    if (!best) continue;
    out.related += 1;
    const cand = cands.get(candId);
    if (!cand) continue;
    if (cand.do_not_contact) {
      await recordSkip(candId, job.id, best.saved.id, best.rel.reason, 'do not contact', now);
      out.skipped += 1; out.results.push({ candidateId: candId, outcome: 'do_not_contact' });
      continue;
    }
    if (!cand.similar_alerts_on) {
      await recordSkip(candId, job.id, best.saved.id, best.rel.reason, 'switched off by the candidate', now);
      out.skipped += 1; out.results.push({ candidateId: candId, outcome: 'switched_off' });
      continue;
    }
    const decision = await withUser(ENGINE, async (c) => (await c.query(
      `select saved_job_alert_claim($1,$2,$3,$4,$5::date,$6) as d`,
      [candId, job.id, best.saved.id, best.rel.reason, istDay(now), cap])).rows[0].d);
    if (!decision) continue;                               // decided before
    if (decision === 'told') { out.told += 1; out.results.push({ candidateId: candId, outcome: 'already_told' }); continue; }
    if (decision === 'digest') { out.digest += 1; out.results.push({ candidateId: candId, outcome: 'digest' }); continue; }
    out.instant += 1;
    const r = await deliverInstant({ cand, job, saved: best.saved, rel: best.rel, tpl: data.tpl, deps });
    if (r.in_app === 'sent' || r.email === 'sent') out.sent += 1;
    out.results.push({ candidateId: candId, outcome: 'instant', savedJobId: best.saved.id, reason: best.rel.reason, ...r });
  }

  await withUser(ENGINE, (c) => c.query(
    `insert into saved_job_alert_jobs (job_id, published_at, candidates) values ($1,$2,$3)
     on conflict (job_id) do update set published_at = excluded.published_at,
       processed_at = now(), candidates = saved_job_alert_jobs.candidates + excluded.candidates`,
    [job.id, data.publishedAt, out.instant + out.digest]));
  return out;
}

/* ------------------------------------------------------------------ *
 * the evening digest: everything over the day's cap
 * ------------------------------------------------------------------ */

/** The most recent digest time (DIGEST_HOUR IST) at or before `now`. */
export function digestSlot(now = Date.now()) {
  const d = new Date(now + IST_MS);
  const slot = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), digestHour(), 0, 0) - IST_MS;
  return now >= slot ? slot : slot - 86400000;
}

/**
 * One message per candidate with queued jobs from before the latest
 * slot. Rows are taken (queued -> sending) before anything is sent, so
 * two runs cannot send the same digest.
 */
export async function runSavedJobDigest(opts = {}) {
  const now = opts.now ?? Date.now();
  const deps = opts.deps || defaultDeps;
  const slot = new Date(digestSlot(now));

  const owners = await withUser(ENGINE, async (c) => (await c.query(
    `select distinct candidate_id from candidate_saved_job_alerts
      where status = 'queued' and created_at < $1`, [slot])).rows.map((r) => r.candidate_id));
  const out = { candidates: owners.length, messages: 0, sent: 0, jobs: 0, dropped: 0 };

  for (const candId of owners) {
    const ctx = await withUser(ENGINE, async (c) => {
      const rows = (await c.query(
        `update candidate_saved_job_alerts set status = 'sending'
          where candidate_id = $1 and status = 'queued' and created_at < $2
          returning job_id, saved_job_id`, [candId, slot])).rows;
      if (!rows.length) return null;
      const ids = rows.map((r) => r.job_id);
      const cand = (await c.query(
        `select c.*, coalesce(s.enabled, true) as similar_alerts_on
           from candidates c left join candidate_saved_job_alert_settings s on s.candidate_id = c.id
          where c.id = $1`, [candId])).rows[0];
      const jobs = (await c.query(`${JOB_SQL} where j.id = any($1)`, [ids])).rows;
      const saved = (await c.query(`select id, title from jobs where id = any($1)`,
        [rows.map((r) => r.saved_job_id).filter(Boolean)])).rows;
      const applied = new Set((await c.query(
        `select job_id from applications where candidate_id=$1 and job_id = any($2)`, [candId, ids])).rows.map((r) => r.job_id));
      const hidden = new Set((await c.query(
        `select job_id from hidden_jobs where candidate_id=$1 and job_id = any($2)`, [candId, ids])).rows.map((r) => r.job_id));
      return { rows, cand, jobs: new Map(jobs.map((j) => [j.id, j])), saved: new Map(saved.map((s) => [s.id, s.title])),
               applied, hidden, tpl: await templateIds(c) };
    });
    if (!ctx) continue;

    const drop = async (jobIds, why) => {
      if (!jobIds.length) return;
      await withUser(ENGINE, (c) => c.query(
        `update candidate_saved_job_alerts set status = 'skipped', skip_reason = $3
          where candidate_id = $1 and job_id = any($2)`, [candId, jobIds, why]));
      for (const id of jobIds) await releaseNewJobNotice(candId, id, 'saved_job');
      out.dropped += jobIds.length;
    };

    const all = ctx.rows.map((r) => r.job_id);
    if (!ctx.cand || ctx.cand.do_not_contact) { await drop(all, 'do not contact'); continue; }
    if (!ctx.cand.similar_alerts_on) { await drop(all, 'switched off by the candidate'); continue; }

    const live = [], gone = [], done = [];
    for (const r of ctx.rows) {
      const j = ctx.jobs.get(r.job_id);
      if (!isLive(j, now)) gone.push(r.job_id);
      else if (ctx.applied.has(r.job_id) || ctx.hidden.has(r.job_id)) done.push(r.job_id);
      else live.push({ row: r, job: j });
    }
    await drop(gone, 'no longer open when the digest went');
    await drop(done, 'applied or hid it before the digest went');
    if (!live.length) continue;

    live.sort((a, b) => new Date(b.job.published_at || 0) - new Date(a.job.published_at || 0));
    const list = live.map(({ row, job }) => ({
      id: job.id, title: job.title, company: companyLabel(job.company_name), location: job.location,
      pay: job.pay_label, url: jobUrl(job.id), savedTitle: ctx.saved.get(row.saved_job_id) || '',
    }));
    const email = buildSavedJobDigestMessages({
      candidateName: ctx.cand.name, jobs: list, total: list.length,
      stopUrl: stopUrl(candId), savedUrl: savedUrl(),
    }).email;
    email.link = list.length === 1 ? list[0].url : savedUrl();
    const n = list.length;
    const inApp = await attempt(deps.sendInApp, {
      cand: ctx.cand, type: 'SAVED_JOB_DIGEST', jobId: list[0].id,
      title: `${n} more new job${n === 1 ? '' : 's'} like ones you saved`,
      message: list.slice(0, 5).map((j) => `${j.title}${j.location ? ` · ${j.location}` : ''}`).join('; ')
        + (n > 5 ? `; and ${n - 5} more` : ''),
      metadata: {
        event: 'saved_job_digest', count: n,
        jobs: list.slice(0, 20).map((j) => ({ id: j.id, title: j.title, company: j.company,
                                              location: j.location || null, savedJobTitle: j.savedTitle || null })),
        applyUrl: '#/candidate/saved', cta: 'See jobs',
      },
    });
    const mail = await attempt(deps.sendEmail, { cand: ctx.cand, email, templateId: ctx.tpl.saved_job_digest });
    const ok = inApp.status === 'sent' || mail.status === 'sent';
    const ids = live.map((x) => x.row.job_id);
    await withUser(ENGINE, (c) => c.query(
      `update candidate_saved_job_alerts
          set status = $3, notification_id = $4, email_status = $5, email_ref = $6, email_error = $7,
              sent_at = case when $3 = 'sent' then now() else sent_at end
        where candidate_id = $1 and job_id = any($2)`,
      [candId, ids, ok ? 'sent' : 'failed', inApp.status === 'sent' ? inApp.ref : null,
       mail.status, mail.ref || null, mail.error ? String(mail.error).slice(0, 500) : null]));
    if (!ok) for (const id of ids) await releaseNewJobNotice(candId, id, 'saved_job');
    out.messages += 1;
    out.jobs += n;
    if (ok) out.sent += 1;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * the sweep: what the publish hook missed, then the digest
 * ------------------------------------------------------------------ */

export async function runSavedJobSweep(opts = {}) {
  const now = opts.now ?? Date.now();
  const since = new Date(now - lookbackDays() * 86400000);
  const ids = await withUser(ENGINE, async (c) => (await c.query(
    `select j.id from jobs j
       left join saved_job_alert_jobs p on p.job_id = j.id
      where j.status = 'open' and not coalesce(j.paused, false) and not coalesce(j.archived, false)
        and (j.expires_at is null or j.expires_at > $1)
        and (j.posting_kind is distinct from 'walkin'
             or walkin_ends_at(j.walkin_date, j.walkin_to) is null
             or walkin_ends_at(j.walkin_date, j.walkin_to) > $1)
        and coalesce(j.published_at, j.created_at) >= $2
        and (p.job_id is null or p.published_at is distinct from coalesce(j.published_at, j.created_at))
      order by coalesce(j.published_at, j.created_at)`, [new Date(now), since])).rows.map((r) => r.id));
  const out = { jobs: ids.length, instant: 0, digest: 0, sent: 0 };
  for (const id of ids) {
    const r = await runSavedJobInstant(id, opts);
    out.instant += r.instant || 0;
    out.digest += r.digest || 0;
    out.sent += r.sent || 0;
  }
  out.digests = await runSavedJobDigest(opts);
  return out;
}

const EVERY_MS = Number(process.env.SAVED_JOB_ALERT_SWEEP_MS || 10 * 60 * 1000);

/** Every ten minutes; every run is idempotent (see the primary keys above). */
export function startSavedJobAlerts() {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const r = await runSavedJobSweep();
      if (r.instant || r.digest || (r.digests && r.digests.messages)) {
        console.log(`[saved-job] sweep: ${r.instant} instant, ${r.digest} queued, `
          + `${r.digests ? r.digests.messages : 0} digest(s)`);
      }
    } catch (err) {
      console.error('[saved-job] the sweep failed:', err.message);
    } finally {
      running = false;
    }
  };
  const first = setTimeout(run, Number(process.env.SAVED_JOB_ALERT_FIRST_MS || 100_000));
  const timer = setInterval(run, EVERY_MS);
  first.unref?.();
  timer.unref?.();
  return () => { clearTimeout(first); clearInterval(timer); };
}
