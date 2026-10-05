/**
 * Screening questions against the database: reading a job's questions,
 * storing answers (from the apply step, the no-password link, or a
 * recruiter's phone call), the answer link itself, and the sweep that
 * sends links, the one 48-hour reminder and - only when a job asks for
 * it - the delayed polite rejection of a knocked-out application.
 *
 * Writes that cross users go through the definer functions in 0097; the
 * engine identity below is the API acting with nobody signed in.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { withUser } from '../db.js';
import { config } from '../config.js';
import { toCandidate } from '../shapes.js';
import { sendToCandidate } from '../notify/direct-send.js';
import { buildScreeningLinkMessages } from '../notify/templates-screening.js';
import { dispatchEvent } from '../notify/events.js';
import {
  fromRow, validateAnswers, scoreAnswers, evaluateKnockout, defaultsFromAnswers, noticeDays,
  answerText, DEFAULT_ANSWER_WEIGHT,
} from './questions.js';

export const ENGINE = { userId: '', role: 'admin', profileId: null };
const LINK_DAYS = 7;
const DAY = 86400000;

/* ------------------------------------------------------------------ *
 * settings
 * ------------------------------------------------------------------ */

export async function loadScreeningSettings() {
  try {
    return await withUser(ENGINE, async (c) => {
      const rows = (await c.query(`select key, value from app_settings where key in ('screening','ai')`)).rows;
      const by = Object.fromEntries(rows.map((r) => [r.key, r.value || {}]));
      const w = Number((by.ai || {}).weightScreeningAnswers);
      return {
        standard: Array.isArray((by.screening || {}).standard) ? by.screening.standard : [],
        answerWeight: Number.isFinite(w) ? Math.max(0, Math.min(100, w)) : DEFAULT_ANSWER_WEIGHT,
        // An AI call that is already being made may also ask an application's
        // pending questions (api/src/ai/call). Off unless an admin turns it on.
        askOnAiCalls: (by.screening || {}).askOnAiCalls === true,
      };
    });
  } catch {
    return { standard: [], answerWeight: DEFAULT_ANSWER_WEIGHT, askOnAiCalls: false };
  }
}

/* ------------------------------------------------------------------ *
 * reading
 * ------------------------------------------------------------------ */

/** A job's questions WITH their rules, read by the engine. */
export async function jobQuestionsInternal(jobId, c = null) {
  const run = async (cx) => {
    const rows = (await cx.query(
      `select * from job_screening_questions where job_id=$1 order by position, created_at`, [jobId])).rows;
    const job = (await cx.query(
      `select j.id, j.title, j.salary_max, j.location, j.mode, co.name as company_name
         from jobs j left join companies co on co.id = j.company_id where j.id=$1`, [jobId])).rows[0] || null;
    return { questions: rows.map(fromRow), job };
  };
  return c ? run(c) : withUser(ENGINE, run);
}

/* ------------------------------------------------------------------ *
 * answering
 * ------------------------------------------------------------------ */

/**
 * Validate a submission and work out its knock-outs and score. Throws an
 * Error with `details` on a bad answer, BEFORE anything is written, so a
 * refused answer never leaves a half-made application behind.
 */
export function prepareAnswers({ questions, job }, answers, now = Date.now()) {
  if (!questions.length) return null;
  const items = validateAnswers(questions, answers);
  const scored = scoreAnswers(items, { salaryMax: job && job.salary_max }, now);
  return {
    items,
    status: scored.knockedOut ? 'knocked_out' : 'answered',
    score: scored.score,
    failed: scored.failed,
    payload: items.map(({ question: q, answer }, i) => ({
      questionId: q.id, position: i, text: q.text, type: q.type, stdKey: q.stdKey,
      share: q.shareWithClient,
      answer: q.type === 'number' && q.options && q.options.unit ? { ...answer, unit: q.options.unit } : answer,
      knockedOut: evaluateKnockout(q, answer, now),
    })),
  };
}

/**
 * Store prepared answers on `c` - the caller's own transaction, so an
 * application and its answers are created together or not at all.
 */
export async function storeAnswers(c, applicationId, prepared, { source, by, saveDefaults = false, candidateId = null } = {}) {
  await c.query(`select screening_record_answers($1,$2::jsonb,$3,$4,$5,$6)`,
    [applicationId, JSON.stringify(prepared.payload), source, by || null, prepared.status, prepared.score]);
  if (saveDefaults && candidateId) {
    const d = defaultsFromAnswers(prepared.items);
    if (Object.keys(d).length) {
      await c.query(
        `insert into candidate_screening_defaults
           (candidate_id, notice_period, last_working_day, current_ctc, expected_ctc,
            current_location, willing_to_relocate, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7, now())
         on conflict (candidate_id) do update set
           notice_period = coalesce(excluded.notice_period, candidate_screening_defaults.notice_period),
           last_working_day = excluded.last_working_day,
           current_ctc = coalesce(excluded.current_ctc, candidate_screening_defaults.current_ctc),
           expected_ctc = coalesce(excluded.expected_ctc, candidate_screening_defaults.expected_ctc),
           current_location = coalesce(excluded.current_location, candidate_screening_defaults.current_location),
           willing_to_relocate = coalesce(excluded.willing_to_relocate, candidate_screening_defaults.willing_to_relocate),
           updated_at = now()`,
        [candidateId, d.notice_period || null, d.last_working_day || null,
         d.current_ctc ?? null, d.expected_ctc ?? null, d.current_location || null,
         d.willing_to_relocate ?? null]);
    }
  }
}

/** After answers arrive by link or phone: score the application again. */
export async function rescreen(applicationId, actor = 'system') {
  try {
    const { screenApplication } = await import('../ai/screening.js');
    return await screenApplication(applicationId, { actor, force: true });
  } catch (err) {
    console.error('[screening] re-screen after answers failed:', err.message);
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * the no-password link
 * ------------------------------------------------------------------ */

const sig = (app, nonce, exp) => createHmac('sha256', config.authSecret)
  .update(`screening-link:${app}:${nonce}:${exp}`).digest('base64url');

export function linkToken(applicationId, nonce, expiresAt) {
  const exp = new Date(expiresAt).getTime();
  return `${Buffer.from(applicationId).toString('base64url')}.${nonce}.${exp.toString(36)}.${sig(applicationId, nonce, exp)}`;
}

/** {applicationId, nonce, exp} when the signature is good, else null. Expiry and use are checked by the caller. */
export function parseLinkToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 4) return null;
  let app;
  try { app = Buffer.from(parts[0], 'base64url').toString('utf8'); } catch { return null; }
  const nonce = parts[1];
  const exp = parseInt(parts[2], 36);
  if (!app || !/^[\w-]{1,80}$/.test(app) || !/^[\w-]{8,64}$/.test(nonce) || !Number.isFinite(exp)) return null;
  const given = Buffer.from(parts[3]);
  const want = Buffer.from(sig(app, nonce, exp));
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  return { applicationId: app, nonce, exp };
}

export const linkUrl = (token) => `${config.publicOrigin.replace(/\/$/, '')}/#/screening-answers/${token}`;

/**
 * The application a link may answer, or a reason it may not. The token is
 * bound to one application, its nonce changes when a recruiter re-opens
 * the answers, it is cleared the moment answers are stored (so a link
 * works once), and it expires after 7 days.
 */
export async function resolveLink(token, now = Date.now()) {
  const t = parseLinkToken(token);
  if (!t) return { error: 'invalid' };
  if (t.exp <= now) return { error: 'expired' };
  const row = await withUser(ENGINE, async (c) => (await c.query(
    `select a.id, a.job_id, a.candidate_id, a.screening_status, a.screening_link_nonce,
            a.screening_link_expires_at, j.title as job_title, j.location as job_location,
            cand.name as candidate_name
       from applications a join jobs j on j.id = a.job_id
       join candidates cand on cand.id = a.candidate_id
      where a.id = $1`, [t.applicationId])).rows[0]);
  if (!row) return { error: 'invalid' };
  if (row.screening_status !== 'pending' || !row.screening_link_nonce) return { error: 'used' };
  if (row.screening_link_nonce !== t.nonce) return { error: 'replaced' };
  if (row.screening_link_expires_at && new Date(row.screening_link_expires_at).getTime() <= now) {
    return { error: 'expired' };
  }
  return { app: row };
}

async function recordDeliveries(applicationId, kind, attempts) {
  await withUser(ENGINE, async (c) => {
    for (const a of attempts) {
      await c.query(`select screening_delivery_add($1,$2,$3,$4,$5,$6,$7,$8)`,
        [applicationId, kind, a.channel, a.result.status, a.to, a.result.provider || null,
         a.result.ref || null, a.result.error || null]);
    }
  }).catch((err) => console.error('[screening] could not record deliveries:', err.message));
}

async function templateId(key) {
  try {
    return await withUser(ENGINE, async (c) => (await c.query(
      `select template_id from notification_templates where event_key=$1`, [key])).rows[0]?.template_id || null);
  } catch { return null; }
}

/**
 * Issue a fresh link for one application and send it.
 * @returns { token?, delivery_status, skipped? }
 */
export async function sendLink(applicationId, { now = Date.now(), reminder = false } = {}) {
  const ctx = await withUser(ENGINE, async (c) => {
    const a = (await c.query(
      `select a.*, j.title as job_title from applications a join jobs j on j.id = a.job_id where a.id=$1`,
      [applicationId])).rows[0];
    if (!a) return null;
    const cand = (await c.query(`select * from candidates where id=$1`, [a.candidate_id])).rows[0];
    const n = (await c.query(`select count(*)::int n from job_screening_questions where job_id=$1`, [a.job_id])).rows[0].n;
    return { a, cand, n };
  });
  if (!ctx || !ctx.cand) return { skipped: 'not found', delivery_status: {} };
  if (!ctx.n) return { skipped: 'this job has no screening questions', delivery_status: {} };

  let nonce = ctx.a.screening_link_nonce;
  let expires = ctx.a.screening_link_expires_at;
  if (!reminder) {
    nonce = randomBytes(12).toString('base64url');
    expires = new Date(now + LINK_DAYS * DAY);
    await withUser(ENGINE, (c) => c.query(`select screening_link_issue($1,$2,$3)`, [applicationId, nonce, expires]));
  }
  if (!nonce) return { skipped: 'no live link', delivery_status: {} };

  const token = linkToken(applicationId, nonce, expires);
  const messages = buildScreeningLinkMessages({
    candidateName: ctx.cand.name, jobTitle: ctx.a.job_title, url: linkUrl(token),
    expiresAt: expires, count: ctx.n, reminder,
  });
  const cand = toCandidate(ctx.cand);
  const attempts = await sendToCandidate(cand, messages, {
    now, templateId: await templateId(reminder ? 'screening_reminder' : 'screening_link'),
    vars: { job_title: ctx.a.job_title, portal_link: linkUrl(token) },
  });
  await recordDeliveries(applicationId, reminder ? 'reminder' : 'link', attempts);
  const delivery_status = {};
  attempts.forEach((x) => { delivery_status[x.channel] = x.result.status; });
  return { token, delivery_status };
}

/* ------------------------------------------------------------------ *
 * what a recruiter sees
 * ------------------------------------------------------------------ */

/** The numbers and badges for a list of applications (read as the caller). */
export function summarise(app, answers) {
  const by = (k) => answers.find((x) => x.std_key === k);
  const notice = by('notice_period');
  const exp = by('expected_ctc');
  const cur = by('current_ctc');
  const rel = by('relocate');
  const loc = by('current_location');
  return {
    applicationId: app.id,
    status: app.screening_status,
    answerScore: app.screening_answer_score,
    combinedScore: app.screening_combined_score,
    aiScore: app.ai_score == null ? null : Number(app.ai_score),
    answeredAt: app.screening_answered_at,
    linkSentAt: app.screening_link_sent_at,
    linkExpiresAt: app.screening_link_expires_at,
    reminderSentAt: app.screening_reminder_sent_at,
    notice: notice ? answerText(notice.answer) : null,
    noticeDays: notice ? noticeDays(notice.answer) : null,
    expectedCtc: exp ? Number(exp.answer.value) : null,
    currentCtc: cur ? Number(cur.answer.value) : null,
    relocate: rel ? rel.answer.value : null,
    location: loc ? String(loc.answer.value) : null,
    mustHaveFailed: answers.filter((x) => x.knocked_out).map((x) => x.question_text),
    answeredBy: answers[0] ? answers[0].answered_by : null,
    source: answers[0] ? answers[0].source : null,
  };
}

/* ------------------------------------------------------------------ *
 * the sweep
 * ------------------------------------------------------------------ */

/**
 * @param opts { now }
 *  1. a pending application with no link yet gets one (only applications
 *     from the last 14 days - an old row is not woken up);
 *  2. one reminder, 48 hours after the link, while it is still pending;
 *  3. a knocked-out application on a job set to "auto-reject knock-outs"
 *     is moved to Rejected after 24 hours, which sends the existing polite
 *     rejection. Off by default; never instant.
 */
export async function runScreeningSweep(opts = {}) {
  const now = opts.now ?? Date.now();
  const at = new Date(now);
  const out = { links: 0, reminders: 0, autoRejected: 0 };

  const plan = await withUser(ENGINE, async (c) => ({
    fresh: (await c.query(
      `select id from applications
        where screening_status = 'pending' and screening_link_sent_at is null
          and applied_at > $1::timestamptz - interval '14 days'
          and stage not in ('rejected','withdrawn','selected','joined')
          -- a one-click application inside its Undo window: not yet (0104)
          and not exists (select 1 from application_outbound_holds h
                           where h.application_id = applications.id and h.sent_at is null)
        order by applied_at limit 200`, [at])).rows,
    due: (await c.query(
      `select id from applications
        where screening_status = 'pending' and screening_reminder_sent_at is null
          and screening_link_nonce is not null
          and screening_link_sent_at <= $1::timestamptz - interval '48 hours'
          and screening_link_expires_at > $1::timestamptz
        limit 200`, [at])).rows,
    reject: (await c.query(
      `select a.id from applications a
         join job_screening_settings s on s.job_id = a.job_id and s.auto_reject_knockouts
        where a.screening_status = 'knocked_out' and a.screening_auto_rejected_at is null
          and a.screening_answered_at <= $1::timestamptz - interval '24 hours'
          and a.stage in ('applied','ai_screening','shortlisted')
        limit 200`, [at])).rows,
  }));

  for (const r of plan.fresh) {
    try { await sendLink(r.id, { now }); out.links += 1; }
    catch (err) { console.error(`[screening] link for ${r.id} failed:`, err.message); }
  }
  for (const r of plan.due) {
    try {
      const claimed = await withUser(ENGINE, async (c) => (await c.query(
        `select screening_reminder_claim($1,$2) as ok`, [r.id, at])).rows[0].ok);
      if (!claimed) continue;
      await sendLink(r.id, { now, reminder: true });
      out.reminders += 1;
    } catch (err) { console.error(`[screening] reminder for ${r.id} failed:`, err.message); }
  }
  for (const r of plan.reject) {
    try {
      const moved = await withUser(ENGINE, async (c) => {
        await c.query(`select set_config('app.stage_note', $1, true)`,
          // Stage history is readable by the candidate: no word about a
          // failed must-have, which they are never told.
          ['Closed after screening review']);
        const upd = await c.query(
          `update applications set stage='rejected', screening_auto_rejected_at=$2
            where id=$1 and screening_auto_rejected_at is null and screening_status='knocked_out'
            returning id`, [r.id, at]);
        if (!upd.rowCount) return null;
        const label = (await c.query(`select coalesce(candidate_label, label) l from stages where id='rejected'`)).rows[0];
        return label ? label.l : null;
      });
      if (moved === null) continue;
      await dispatchEvent(ENGINE, 'STAGE_CHANGED', { applicationId: r.id, stage: 'rejected', stageLabel: moved || undefined });
      out.autoRejected += 1;
    } catch (err) { console.error(`[screening] auto-reject for ${r.id} failed:`, err.message); }
  }
  return out;
}

export function startScreeningQuestionSweep() {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const r = await runScreeningSweep();
      if (r.links || r.reminders || r.autoRejected) {
        console.log(`[screening] ${r.links} link(s), ${r.reminders} reminder(s), ${r.autoRejected} auto-rejected`);
      }
    } catch (err) {
      console.error('[screening] the sweep failed:', err.message);
    } finally { running = false; }
  };
  const first = setTimeout(run, Number(process.env.SCREENING_Q_FIRST_MS || 60_000));
  const timer = setInterval(run, Number(process.env.SCREENING_Q_SWEEP_MS || 5 * 60 * 1000));
  first.unref?.(); timer.unref?.();
  return () => { clearTimeout(first); clearInterval(timer); };
}
