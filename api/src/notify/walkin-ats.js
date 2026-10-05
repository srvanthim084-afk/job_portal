/**
 * The walk-in ATS engine (0107): what happens on the clock.
 *
 *   No Show            after the end time + grace (IST), Registered with no
 *                      check-in / attendance -> No Show, as System (23.16).
 *                      No candidate message.
 *   reminders          to every application still Registered: the day
 *                      before (from 10:00 IST) and the morning of the drive
 *                      (from 07:00 IST, until it ends) (13.2).
 *   reschedules        one combined message per candidate per settled edit
 *                      of date / time / venue / address (23.15); quick
 *                      successive saves are merged by the database into one
 *                      pending row, sent once the edits have stopped for
 *                      WALKIN_RESCHEDULE_MERGE_MS (default 2 minutes).
 *   recruiter alerts   new application (instant, or a daily digest for a
 *                      busy job), capacity reached, walk-in tomorrow,
 *                      post-drive summary, reschedule saved (23.17).
 *   decision message   Selected / Not selected, recruiter-triggered with an
 *                      editable text (23.18) - sent from here so every
 *                      candidate message has one delivery path.
 *
 * NEVER TWICE: every message is CLAIMED (unique row) before it is sent;
 * a second run finds the claim. NEVER CLAIMED AS SENT: each channel
 * records the provider's own answer. NEVER BLOCKING: a failure is
 * recorded and reported; it never undoes a save.
 *
 * Candidate-facing text names the job title and Job ID only - no company
 * and never the word "Client" (0051).
 */
import { withUser } from '../db.js';
import { config } from '../config.js';
import { providers } from './providers.js';
import { channelSettings } from './channel-settings.js';
import { emailLayout } from './layout.js';
import { inQuietHours } from './saved-search-alerts.js';
import { toCandidate } from '../shapes.js';
import { istDate, istHour, addDays, time12, dateLabel, walkinInstant } from '../portal/walkin-jobs.js';

export const ENGINE = { userId: '', role: 'admin', profileId: null };
const EXTERNAL = ['email', 'sms', 'whatsapp'];

const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : Number(process.env[k]));
export const graceMinutes = () => env('WALKIN_NO_SHOW_GRACE_MINUTES', null);
const mergeMs = () => env('WALKIN_RESCHEDULE_MERGE_MS', 2 * 60 * 1000);
const tomorrowHour = () => env('WALKIN_TOMORROW_HOUR_IST', 18);
const digestHour = () => env('ATS_DIGEST_HOUR_IST', 19);
const RECENT_MS = 3 * 60 * 60 * 1000;   // a reminder right after applying is noise

const base = () => config.publicOrigin.replace(/\/$/, '');
const myAppsUrl = () => `${base()}/#/candidate/applications`;
const jobUrl = (id) => `${base()}/#/job/${encodeURIComponent(id)}`;
const staffUrl = (jobId, appId) => `${base()}/#/recruiter/manage-jobs?applicants=${encodeURIComponent(jobId)}`
  + (appId ? `&app=${encodeURIComponent(appId)}` : '');

const newId = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/* ------------------------------------------------------------------ *
 * words
 * ------------------------------------------------------------------ */

export function whenText(d) {
  if (!d || !d.date) return '';
  const t = [d.from ? time12(d.from) : '', d.to ? time12(d.to) : ''].filter(Boolean).join(' - ');
  return `${dateLabel(d.date)}${t ? `, ${t}` : ''}`;
}

/** The walk-in facts of a job row, as the candidate reads them. */
export function jobDetails(j) {
  return {
    date: j.walkin_date || '', from: j.walkin_from || '', to: j.walkin_to || '',
    venue: j.walkin_venue || '', address: j.walkin_address || '', mapLink: j.walkin_map_link || '',
    contact: j.walkin_contact || '', phone: j.walkin_phone || '',
    documents: String(j.walkin_documents || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean),
  };
}

function factsFor(d) {
  return [
    ['When', whenText(d)],
    ['Venue', d.venue],
    ['Address', d.address],
    ['Documents to carry', (d.documents || []).join(', ')],
    ['Contact', [d.contact, d.phone].filter(Boolean).join(', ')],
    ['Map', d.mapLink],
  ].filter((f) => f[1]);
}

const FIELD_LABEL = { date: 'Date', time: 'Time', venue: 'Venue', address: 'Address' };

/**
 * The reschedule message (23.15): Job Title, Job ID, old and new details,
 * contact person / number, the map link if there is one.
 */
export function rescheduleLines(oldD, newD) {
  const pairs = [];
  if ((oldD.date || '') !== (newD.date || '') || (oldD.from || '') !== (newD.from || '') || (oldD.to || '') !== (newD.to || '')) {
    if ((oldD.date || '') !== (newD.date || '')) pairs.push(['date', dateLabel(oldD.date), dateLabel(newD.date)]);
    const ot = [oldD.from && time12(oldD.from), oldD.to && time12(oldD.to)].filter(Boolean).join(' - ');
    const nt = [newD.from && time12(newD.from), newD.to && time12(newD.to)].filter(Boolean).join(' - ');
    if (ot !== nt) pairs.push(['time', ot, nt]);
  }
  if ((oldD.venue || '') !== (newD.venue || '')) pairs.push(['venue', oldD.venue, newD.venue]);
  if ((oldD.address || '') !== (newD.address || '')) pairs.push(['address', oldD.address, newD.address]);
  return pairs.map(([k, o, n]) => ({ field: FIELD_LABEL[k], old: o || '-', new: n || '-' }));
}

export function buildCandidateMessage(kind, c) {
  const { job, ref, name } = c;
  const d = c.details;
  const greeting = name ? `Hi ${name},` : 'Hi,';
  const what = `${job.title} (Job ID ${job.id})`;
  let title, lead, facts, smsText;

  if (kind === 'reminder_day_before' || kind === 'reminder_morning') {
    const tomorrow = kind === 'reminder_day_before';
    title = tomorrow ? 'Walk-in interview tomorrow' : 'Walk-in interview today';
    lead = `Reminder: your walk-in interview for ${what} is ${tomorrow ? 'tomorrow' : 'today'}.`;
    facts = [['Application ID', ref], ...factsFor(d)];
    smsText = `TeamLink: ${title} - ${job.title}, ${whenText(d)}${d.venue ? `, ${d.venue}` : ''}. App ID ${ref}.`;
  } else if (kind === 'reschedule') {
    const changes = c.changes || [];
    title = 'Walk-in interview details changed';
    lead = `The walk-in interview for ${what} has changed. Please note the new details.`;
    facts = [['Application ID', ref]];
    for (const ch of changes) {
      facts.push([`${ch.field} (old)`, ch.old]);
      facts.push([`${ch.field} (new)`, ch.new]);
    }
    facts.push(['Contact', [d.contact, d.phone].filter(Boolean).join(', ')]);
    if (d.mapLink) facts.push(['Map', d.mapLink]);
    smsText = `TeamLink: ${job.title} (Job ID ${job.id}) walk-in changed. `
      + changes.map((ch) => `${ch.field}: ${ch.new} (was ${ch.old})`).join('; ') + '.';
  } else if (kind === 'decision_selected' || kind === 'decision_rejected') {
    title = c.subject;
    lead = c.body;
    facts = [['Job', `${job.title} (Job ID ${job.id})`], ['Application ID', ref]];
    smsText = `TeamLink: ${c.body}`.slice(0, 300);
  } else {
    throw new Error(`unknown message kind ${kind}`);
  }
  facts = facts.filter((f) => f[1]);
  const lines = facts.map(([k, v]) => `${k}: ${v}`);
  const text = `${greeting}\n\n${lead}\n\n${lines.join('\n')}\n\nYour applications: ${myAppsUrl()}\n\n— TeamLink`;
  const html = emailLayout({
    title, preheader: lead, greeting, body: lead,
    facts: facts.filter((f) => f[0] !== 'Map'),
    cta: { label: 'View my applications', url: myAppsUrl() },
    note: 'You get this because you applied for this job on TeamLink.',
  });
  const portal = `${lead} ${kind === 'reschedule' ? lines.slice(1).join(' · ') : ''}`.trim();
  return {
    title, lead, lines, portal,
    email: { subject: `${title}: ${job.title}`, text, html },
    sms: `${smsText} ${myAppsUrl()}`.slice(0, 320),
    whatsapp: `*TeamLink*\n\n${greeting}\n\n${lead}\n\n${lines.join('\n')}\n\n${myAppsUrl()}`,
  };
}

/* ------------------------------------------------------------------ *
 * delivering to a candidate
 * ------------------------------------------------------------------ */

async function claim(c, kind, key, channel) {
  const r = await withUser(ENGINE, (q) => q.query(
    `insert into walkin_ats_messages (application_id, candidate_id, job_id, kind, dedupe_key, channel)
     values ($1,$2,$3,$4,$5,$6) on conflict do nothing returning id`,
    [c.app.id, c.cand.id, c.job.id, kind, key, channel]));
  return r.rows[0] ? r.rows[0].id : null;
}

async function settle(id, r, to) {
  await withUser(ENGINE, (q) => q.query(
    `update walkin_ats_messages set status=$2, to_address=$3, provider=$4, provider_ref=$5, error=$6, updated_at=now()
      where id=$1`,
    [id, r.status, to || null, r.provider || null, r.ref || null, r.error ? String(r.error).slice(0, 500) : null]));
}

async function sendChannel(channel, cand, msg, job, now, waCfg) {
  const to = channel === 'email' ? cand.email : cand.phone;
  if (cand.doNotContact) return [{ status: 'skipped_opted_out', provider: channel, error: 'do not contact' }, to];
  if (!to) return [{ status: 'skipped_no_address', provider: channel }, to];
  if (channel === 'email' && cand.emailOptIn === false) return [{ status: 'skipped_opted_out', provider: channel }, to];
  if (channel === 'sms' && cand.smsOptIn === false) return [{ status: 'skipped_opted_out', provider: channel }, to];
  if (channel === 'whatsapp' && !cand.whatsappOptIn) return [{ status: 'skipped_opted_out', provider: channel, error: 'not opted in' }, to];
  if (channel !== 'email' && inQuietHours(now)) return [{ status: 'skipped_quiet_hours', provider: channel, error: '21:00-08:00 IST' }, to];
  if (channel === 'whatsapp' && !(waCfg && waCfg.templateName)) {
    return [{ status: 'not_configured', provider: 'whatsapp', error: 'no approved WhatsApp template is set in Notification Settings' }, to];
  }
  try {
    const r = await providers[channel].send({
      to, subject: msg.email.subject, html: msg.email.html,
      text: channel === 'sms' ? msg.sms : channel === 'whatsapp' ? msg.whatsapp : msg.email.text,
      vars: { to_name: cand.name, candidate_name: cand.name, job_title: job.title, company_name: '',
              portal_link: myAppsUrl(), subject: msg.email.subject, message: msg.email.text },
    });
    return [r || { status: 'failed', provider: channel, error: 'no answer' }, to];
  } catch (err) {
    return [{ status: 'failed', provider: channel, error: err.message }, to];
  }
}

/**
 * Every channel for one application. `retry: true` re-sends the channels
 * of an existing claim that FAILED (and only those).
 * Returns { channel: status } for what was attempted now.
 */
export async function deliverToCandidate(ctx, kind, key, msg, { now = Date.now(), retry = false } = {}) {
  const out = {};
  const ids = {};
  if (retry) {
    const rows = await withUser(ENGINE, (q) => q.query(
      `select id, channel from walkin_ats_messages
        where application_id=$1 and kind=$2 and dedupe_key=$3 and status='failed'`, [ctx.app.id, kind, key]));
    for (const r of rows.rows) ids[r.channel] = r.id;
  } else {
    for (const ch of ['portal', ...EXTERNAL]) ids[ch] = await claim(ctx, kind, key, ch);
  }

  if (ids.portal) {
    try {
      const nid = newId('wan');
      await withUser(ENGINE, (q) => q.query(
        `select notify_create($1,$2,'candidate',$3,$4,$5,$6,$7,$8,null,$9::jsonb)`,
        [nid, ctx.cand.id, `WALKIN_${kind.toUpperCase()}#${ids.portal}`, msg.title, msg.portal,
         ctx.job.id, ctx.app.id, ctx.cand.id, JSON.stringify({ walkin: true, kind, applicationId: ctx.app.id })]));
      await settle(ids.portal, { status: 'sent', provider: 'portal', ref: nid }, null);
      out.portal = 'sent';
    } catch (err) {
      await settle(ids.portal, { status: 'failed', provider: 'portal', error: err.message }, null);
      out.portal = 'failed';
    }
  }
  const waCfg = await channelSettings('whatsapp').catch(() => ({}));
  for (const channel of EXTERNAL) {
    if (!ids[channel]) continue;
    const [r, to] = await sendChannel(channel, ctx.cand, msg, ctx.job, now, waCfg);
    await settle(ids[channel], r, to);
    out[channel] = r.status;
  }
  return out;
}

async function loadApps(q, where, params) {
  const { rows } = await q.query(
    `select row_to_json(a.*) as app, row_to_json(j.*) as job, row_to_json(c.*) as cand
       from applications a
       join jobs j on j.id = a.job_id
       join candidates c on c.id = a.candidate_id
      where ${where}`, params);
  return rows.map((x) => ({
    app: x.app, job: x.job, cand: toCandidate(x.cand), ref: x.app.reference || x.app.id,
    details: jobDetails(x.job),
  }));
}

/* ------------------------------------------------------------------ *
 * delivering to a recruiter (in-app + email)
 * ------------------------------------------------------------------ */

async function claimAlert(recruiterId, jobId, appId, kind, key, channel) {
  const r = await withUser(ENGINE, (q) => q.query(
    `insert into ats_recruiter_alerts (recruiter_id, job_id, application_id, kind, dedupe_key, channel)
     values ($1,$2,$3,$4,$5,$6) on conflict do nothing returning id`,
    [recruiterId, jobId, appId || null, kind, key, channel]));
  return r.rows[0] ? r.rows[0].id : null;
}

/**
 * @returns { portal, email } statuses for the channels claimed now, or {}
 *          when this alert was already sent.
 */
export async function alertRecruiter({ recruiterId, jobId, appId = null, kind, key, title, message, facts = [], url }) {
  if (!recruiterId) return {};
  const out = {};
  const pid = await claimAlert(recruiterId, jobId, appId, kind, key, 'portal');
  if (pid) {
    try {
      await withUser(ENGINE, (q) => q.query(
        `select notify_create($1,$2,'recruiter',$3,$4,$5,$6,$7,null,$2,$8::jsonb)`,
        [newId('ara'), recruiterId, `ATS_${kind.toUpperCase()}#${pid}`, title, message, jobId || null, appId || null,
         JSON.stringify({ ats: true, kind, jobId, applicationId: appId, url })]));
      await withUser(ENGINE, (q) => q.query(`update ats_recruiter_alerts set status='sent', provider='portal', updated_at=now() where id=$1`, [pid]));
      out.portal = 'sent';
    } catch (err) {
      await withUser(ENGINE, (q) => q.query(`update ats_recruiter_alerts set status='failed', error=$2, updated_at=now() where id=$1`, [pid, err.message]));
      out.portal = 'failed';
    }
  }
  const eid = await claimAlert(recruiterId, jobId, appId, kind, key, 'email');
  if (eid) {
    const rec = (await withUser(ENGINE, (q) => q.query(`select name, email from recruiters where id=$1`, [recruiterId]))).rows[0];
    let r;
    if (!rec || !rec.email) r = { status: 'skipped_no_address', provider: 'email' };
    else {
      const text = `Hi ${rec.name || ''},\n\n${message}\n\n${facts.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n${url || base()}\n\n— TeamLink`;
      try {
        r = await providers.email.send({
          to: rec.email, subject: title, text,
          html: emailLayout({ title, preheader: message, greeting: rec.name ? `Hi ${rec.name},` : 'Hi,',
            body: message, facts, cta: url ? { label: 'Open in TeamLink', url } : undefined,
            note: 'A recruiter alert from your TeamLink job.' }),
          vars: { to_name: rec.name, subject: title, message: text, portal_link: url || base() },
        });
      } catch (err) { r = { status: 'failed', provider: 'email', error: err.message }; }
    }
    await withUser(ENGINE, (q) => q.query(
      `update ats_recruiter_alerts set status=$2, to_address=$3, provider=$4, error=$5, updated_at=now() where id=$1`,
      [eid, r.status, rec ? rec.email : null, r.provider || 'email', r.error ? String(r.error).slice(0, 500) : null]));
    out.email = r.status;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * stage counts (shared with the routes)
 * ------------------------------------------------------------------ */

export async function stageCounts(q, jobId) {
  const by = (await q.query(`select ats_job_stage_counts($1) as c`, [jobId])).rows[0].c || {};
  const total = Object.values(by).reduce((n, x) => n + Number(x || 0), 0);
  return { by, total };
}

/* ------------------------------------------------------------------ *
 * 1. No Show (23.16)
 * ------------------------------------------------------------------ */

export async function runNoShows({ now = Date.now() } = {}) {
  const rows = await withUser(ENGINE, async (q) => (await q.query(
    `select * from walkin_mark_no_shows($1, $2)`, [graceMinutes(), new Date(now)])).rows);
  return rows.map((r) => r.application_id);
}

async function settings(q) {
  return (await q.query(`select * from walkin_ats_settings where id=1`)).rows[0]
    || { installed_at: new Date(0), no_show_grace_minutes: 60, high_volume_per_day: 20 };
}

/* ------------------------------------------------------------------ *
 * 2. post-drive summary + walk-in tomorrow (23.17.3 / .4)
 * ------------------------------------------------------------------ */

const COUNT_KEYS = [['registered', 'Registered'], ['attended', 'Attended'], ['interviewed', 'Interviewed'],
  ['selected', 'Selected'], ['rejected', 'Rejected'], ['no_show', 'No Show']];

export async function runDriveSummaries({ now = Date.now(), only = null } = {}) {
  const out = { postDrive: 0, tomorrow: 0 };
  const { jobs, set } = await withUser(ENGINE, async (q) => ({
    set: await settings(q),
    jobs: (await q.query(
      `select j.*, walkin_ends_at(j.walkin_date, j.walkin_to) as ends_at
         from jobs j
        where j.posting_kind = 'walkin' and j.recruiter_id is not null
          and walkin_ends_at(j.walkin_date, j.walkin_to) is not null
          and walkin_ends_at(j.walkin_date, j.walkin_to) > $1::timestamptz - interval '3 days'`, [new Date(now)])).rows,
  }));
  const grace = graceMinutes() ?? set.no_show_grace_minutes ?? 60;
  const tomorrow = addDays(istDate(now), 1);
  for (const j of jobs) {
    const d = jobDetails(j);
    const slot = `${j.walkin_date} ${j.walkin_from || ''}-${j.walkin_to || ''}`;
    const ends = new Date(j.ends_at).getTime();
    if (only !== 'tomorrow' && ends + grace * 60000 <= now && ends >= new Date(set.installed_at).getTime() && j.status !== 'draft') {
      const counts = await withUser(ENGINE, (q) => stageCounts(q, j.id));
      const facts = COUNT_KEYS.map(([k, l]) => [l, String(counts.by[k] || 0)]);
      const r = await alertRecruiter({
        recruiterId: j.recruiter_id, jobId: j.id, kind: 'post_drive', key: slot,
        title: `Walk-in summary: ${j.title}`,
        message: `The walk-in drive for ${j.title} (Job ID ${j.id}) on ${whenText(d)} has ended. `
          + `${counts.total} registration${counts.total === 1 ? '' : 's'}: `
          + facts.map(([l, n]) => `${l} ${n}`).join(', ') + '.',
        facts: [['Total registrations', String(counts.total)], ...facts], url: staffUrl(j.id),
      });
      if (Object.keys(r).length) out.postDrive += 1;
    }
    if (only !== 'post' && j.walkin_date === tomorrow && istHour(now) >= tomorrowHour() && j.status === 'open' && !j.archived) {
      const counts = await withUser(ENGINE, (q) => stageCounts(q, j.id));
      const cap = j.walkin_capacity == null ? null : Number(j.walkin_capacity);
      const remaining = cap == null ? null : Math.max(0, cap - counts.total);
      const r = await alertRecruiter({
        recruiterId: j.recruiter_id, jobId: j.id, kind: 'walkin_tomorrow', key: slot,
        title: `Walk-in tomorrow: ${j.title}`,
        message: `${j.title} (Job ID ${j.id}) is tomorrow, ${whenText(d)}${d.venue ? ` at ${d.venue}` : ''}. `
          + `${counts.by.registered || 0} registered${remaining == null ? '' : `, ${remaining} of ${cap} places left`}.`,
        facts: [['When', whenText(d)], ['Venue', [d.venue, d.address].filter(Boolean).join(', ')],
          ['Registered', String(counts.by.registered || 0)], ['Total registrations', String(counts.total)],
          ['Remaining capacity', remaining == null ? 'No limit' : String(remaining)]],
        url: staffUrl(j.id),
      });
      if (Object.keys(r).length) out.tomorrow += 1;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 3. candidate reminders (13.2)
 * ------------------------------------------------------------------ */

export async function runReminders({ now = Date.now() } = {}) {
  const out = { dayBefore: 0, morning: 0 };
  const today = istDate(now);
  const tomorrow = addDays(today, 1);
  const hour = istHour(now);
  const due = await withUser(ENGINE, (q) => loadApps(q,
    `j.posting_kind = 'walkin' and j.status = 'open' and not j.archived
     and a.stage = 'registered' and j.walkin_date in ($1, $2)`, [today, tomorrow]));
  for (const ctx of due) {
    const d = ctx.details;
    if (now >= walkinInstant(d.date, d.to || '23:59')) continue;
    if (now - new Date(ctx.app.applied_at).getTime() < RECENT_MS) continue;
    const key = `${d.date}@${d.from || ''}`;
    let kind = null;
    if (d.date === tomorrow && hour >= 10) kind = 'reminder_day_before';
    if (d.date === today && hour >= 7) kind = 'reminder_morning';
    if (!kind) continue;
    const msg = buildCandidateMessage(kind, { job: ctx.job, ref: ctx.ref, name: ctx.cand.name, details: d });
    const r = await deliverToCandidate(ctx, kind, key, msg, { now });
    if (Object.keys(r).length) out[kind === 'reminder_day_before' ? 'dayBefore' : 'morning'] += 1;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 4. reschedules (23.15)
 * ------------------------------------------------------------------ */

/**
 * Sends one reschedule row. Called by the sweep for rows that have
 * settled (pending, older than the merge window) and for rows a recruiter
 * asked to retry (status 'sending').
 */
export async function sendReschedule(id, { now = Date.now() } = {}) {
  const row = (await withUser(ENGINE, (q) => q.query(
    `update walkin_reschedules set status='sending' where id=$1 and status in ('pending','sending') returning *`, [id]))).rows[0];
  if (!row) return null;
  const retry = row.sent_at != null;
  const job = (await withUser(ENGINE, (q) => q.query(`select * from jobs where id=$1`, [row.job_id]))).rows[0];
  const newD = job ? jobDetails(job) : row.new_details;
  const changes = rescheduleLines(row.old_details || {}, newD);
  const finish = async (fields) => withUser(ENGINE, async (q) => {
    const sets = Object.keys(fields).map((k, i) => `${k}=$${i + 2}`).join(', ');
    await q.query(`update walkin_reschedules set ${sets} where id=$1`, [id, ...Object.values(fields)]);
  });
  if (!job || !changes.length) {
    await finish({ status: 'cancelled', sent_at: new Date(now), error: job ? 'the details were changed back' : 'the job no longer exists' });
    return { id, status: 'cancelled', recipients: 0 };
  }

  const list = await withUser(ENGINE, (q) => loadApps(q, `a.job_id = $1 and a.stage = 'registered'`, [row.job_id]));
  const key = `r${row.id}`;
  let delivered = 0, failed = 0;
  for (const ctx of list) {
    const msg = buildCandidateMessage('reschedule', { job: ctx.job, ref: ctx.ref, name: ctx.cand.name, details: newD, changes });
    const r = await deliverToCandidate(ctx, 'reschedule', key, msg, { now, retry });
    const st = Object.values(r);
    if (st.includes('failed')) failed += 1;
    else if (st.length) delivered += 1;
  }
  if (retry) {
    // what is still failed after this attempt, across everybody
    const left = (await withUser(ENGINE, (q) => q.query(
      `select count(distinct application_id)::int n from walkin_ats_messages
        where job_id=$1 and kind='reschedule' and dedupe_key=$2 and status='failed'`, [row.job_id, key]))).rows[0].n;
    failed = left;
    delivered = Math.max(0, list.length - left);
  }
  const status = !list.length ? 'no_recipients' : failed === 0 ? 'sent' : (failed === list.length ? 'failed' : 'partial');
  await finish({ status, sent_at: new Date(now), recipients: list.length, delivered, failed, error: null });

  const summary = !list.length
    ? 'No registered applicants to notify'
    : `Notified ${list.length} registered applicant${list.length === 1 ? '' : 's'}`
      + (failed ? ` - sending failed for ${failed}` : '');
  await withUser(ENGINE, (q) => q.query(
    `insert into job_update_history (job_id, field, old_value, new_value, updated_by)
     values ($1, 'reschedule_notification', $2, $3, $4)`,
    [row.job_id, changes.map((c) => `${c.field}: ${c.old}`).join('; '),
     `${changes.map((c) => `${c.field}: ${c.new}`).join('; ')} | ${summary}`, row.created_by]));

  if (job.recruiter_id && list.length) {
    await alertRecruiter({
      recruiterId: job.recruiter_id, jobId: job.id, kind: 'reschedule_saved', key: `${key}:${retry ? 'retry' + Date.now() : 'first'}`,
      title: failed ? `Reschedule: sending failed for ${failed} - ${job.title}` : `Reschedule sent: ${job.title}`,
      message: `${job.title} (Job ID ${job.id}): ${changes.map((c) => `${c.field} ${c.old} → ${c.new}`).join('; ')}. ${summary}.`
        + (failed ? ' Open the job\'s update history to retry.' : ''),
      url: staffUrl(job.id),
    });
  }
  return { id, status, recipients: list.length, delivered, failed };
}

export async function runReschedules({ now = Date.now() } = {}) {
  const rows = (await withUser(ENGINE, (q) => q.query(
    `select id from walkin_reschedules
      where status = 'sending' or (status = 'pending' and last_change_at <= $1)
      order by id`, [new Date(now - mergeMs())]))).rows;
  const out = [];
  for (const r of rows) {
    try { out.push(await sendReschedule(r.id, { now })); }
    catch (err) { console.error(`[walkin-ats] reschedule ${r.id} failed:`, err.message); }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 5. new applications, capacity (23.17.1 / .2)
 * ------------------------------------------------------------------ */

export async function runApplicationAlerts({ now = Date.now() } = {}) {
  const out = { instant: 0, digest: 0, capacity: 0 };
  const { rows, set, perJob } = await withUser(ENGINE, async (q) => {
    const set = await settings(q);
    const rows = (await q.query(
      `select a.id, a.reference, a.job_id, a.applied_at, j.title, j.recruiter_id, j.posting_kind,
              j.walkin_capacity, c.name as cand_name,
              coalesce(s.new_application_alerts, 'auto') as mode
         from applications a
         join jobs j on j.id = a.job_id
         join candidates c on c.id = a.candidate_id
         left join job_ats_settings s on s.job_id = j.id
        where j.recruiter_id is not null
          and a.applied_at >= $1 and a.applied_at > $2::timestamptz - interval '2 days'
          and not exists (select 1 from ats_recruiter_alerts x
                           where x.kind = 'new_application' and x.dedupe_key = a.id and x.channel = 'portal')
        order by a.applied_at`, [set.installed_at, new Date(now)])).rows;
    const perJob = {};
    for (const r of (await q.query(
      `select job_id, count(*)::int n from applications
        where applied_at > $1::timestamptz - interval '1 day' group by job_id`, [new Date(now)])).rows) perJob[r.job_id] = r.n;
    return { rows, set, perJob };
  });

  const busy = (jobId) => (perJob[jobId] || 0) >= Number(set.high_volume_per_day || 20);
  const capacityJobs = new Set();
  for (const a of rows) {
    if (a.posting_kind === 'walkin' && a.walkin_capacity) capacityJobs.add(a.job_id);
    const instant = a.mode === 'instant' || (a.mode === 'auto' && !busy(a.job_id));
    if (!instant) continue;
    const r = await alertRecruiter({
      recruiterId: a.recruiter_id, jobId: a.job_id, appId: a.id, kind: 'new_application', key: a.id,
      title: `New application: ${a.title}`,
      message: `${a.cand_name} applied for ${a.title} (Job ID ${a.job_id}). Application ID ${a.reference || a.id}.`,
      url: staffUrl(a.job_id, a.id),
    });
    if (Object.keys(r).length) out.instant += 1;
  }

  // capacity: every walk-in with a capacity that is full, once per capacity value
  const full = await withUser(ENGINE, async (q) => (await q.query(
    `select j.id, j.title, j.recruiter_id, j.walkin_capacity,
            (select count(*)::int from applications a where a.job_id = j.id) as n
       from jobs j
      where j.posting_kind = 'walkin' and j.walkin_capacity is not null and j.recruiter_id is not null
        and (j.id = any($1::text[]) or j.status = 'open')
        and (select count(*) from applications a where a.job_id = j.id) >= j.walkin_capacity`, [[...capacityJobs]])).rows);
  for (const j of full) {
    const r = await alertRecruiter({
      recruiterId: j.recruiter_id, jobId: j.id, kind: 'capacity_full', key: `${j.id}@${j.walkin_capacity}`,
      title: `Registrations full: ${j.title}`,
      message: `${j.title} (Job ID ${j.id}) has reached its slot capacity: ${j.n} of ${j.walkin_capacity} registrations. Remaining capacity is 0.`,
      url: staffUrl(j.id),
    });
    if (Object.keys(r).length) out.capacity += 1;
  }

  // the daily digest, for jobs on digest (or busy jobs on auto)
  if (istHour(now) >= digestHour()) {
    const day = istDate(now);
    const jobs = await withUser(ENGINE, async (q) => (await q.query(
      `select j.id, j.title, j.recruiter_id, coalesce(s.new_application_alerts, 'auto') as mode,
              count(a.id)::int as n
         from jobs j
         join applications a on a.job_id = j.id and a.applied_at > $1::timestamptz - interval '1 day'
                            and a.applied_at >= $2
         left join job_ats_settings s on s.job_id = j.id
        where j.recruiter_id is not null
        group by j.id, j.title, j.recruiter_id, s.new_application_alerts`, [new Date(now), set.installed_at])).rows);
    for (const j of jobs) {
      if (!(j.mode === 'digest' || (j.mode === 'auto' && busy(j.id)))) continue;
      const r = await alertRecruiter({
        recruiterId: j.recruiter_id, jobId: j.id, kind: 'digest', key: `${j.id}@${day}`,
        title: `${j.n} new application${j.n === 1 ? '' : 's'}: ${j.title}`,
        message: `${j.title} (Job ID ${j.id}) received ${j.n} application${j.n === 1 ? '' : 's'} in the last 24 hours.`,
        url: staffUrl(j.id),
      });
      if (Object.keys(r).length) out.digest += 1;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * the decision message (23.18) - recruiter-triggered
 * ------------------------------------------------------------------ */

export function decisionTemplate(kind, { name, jobTitle, jobId }) {
  if (kind === 'selected') {
    return {
      subject: `Congratulations - you have been selected for ${jobTitle}`,
      body: `Dear ${name || 'Candidate'},\n\nWe are pleased to tell you that you have been selected for ${jobTitle} (Job ID ${jobId}). `
        + 'Our team will contact you shortly with the next steps.\n\nRegards,\nTeamLink',
    };
  }
  return {
    subject: `Update on your application for ${jobTitle}`,
    body: `Dear ${name || 'Candidate'},\n\nThank you for attending the interview for ${jobTitle} (Job ID ${jobId}). `
      + 'After careful consideration we will not be moving forward with your application this time. '
      + 'We wish you the very best and encourage you to apply for other roles on TeamLink.\n\nRegards,\nTeamLink',
  };
}

export async function sendDecision(appId, kind, { subject, body, actorUserId, now = Date.now() }) {
  const [ctx] = await withUser(ENGINE, (q) => loadApps(q, 'a.id = $1', [appId]));
  if (!ctx) return null;
  const k = `decision_${kind}`;
  const key = `m${Date.now().toString(36)}`;
  const msg = buildCandidateMessage(k, { job: ctx.job, ref: ctx.ref, name: ctx.cand.name, details: ctx.details, subject, body });
  const channels = await deliverToCandidate(ctx, k, key, msg, { now });
  await withUser(ENGINE, (q) => q.query(
    `insert into application_stage_history
       (application_id, from_stage, to_stage, changed_by, note, reason, source, is_override, action)
     values ($1, $2, $2, $3, null, $4, 'recruiter', false, 'message_sent')`,
    [appId, ctx.app.stage, actorUserId || null,
     `${kind === 'selected' ? 'Selected' : 'Not selected'} message: ${subject} (${Object.entries(channels).map(([c, s]) => `${c} ${s}`).join(', ')})`]));
  return { channels, key };
}

/* ------------------------------------------------------------------ *
 * the sweep
 * ------------------------------------------------------------------ */

export async function runWalkinAtsSweep({ now = Date.now() } = {}) {
  const out = {};
  const step = async (name, fn) => {
    try { out[name] = await fn(); }
    catch (err) { out[name] = { error: err.message }; console.error(`[walkin-ats] ${name} failed:`, err.message); }
  };
  await step('noShows', () => runNoShows({ now }));
  await step('summaries', () => runDriveSummaries({ now }));
  await step('reminders', () => runReminders({ now }));
  await step('reschedules', () => runReschedules({ now }));
  await step('alerts', () => runApplicationAlerts({ now }));
  return out;
}

let kickTimer = null;
let running = false;
async function runOnce() {
  if (running) return;
  running = true;
  try {
    const r = await runWalkinAtsSweep();
    const n = (r.noShows || []).length;
    if (n || (r.reschedules || []).length) {
      console.log(`[walkin-ats] no-shows ${n}, reschedules ${(r.reschedules || []).length}`);
    }
  } catch (err) {
    console.error('[walkin-ats] the sweep failed:', err.message);
  } finally {
    running = false;
  }
}

/** Run soon (after an application or a job edit), without waiting for the timer. */
export function kickWalkinAts(delayMs = 1500) {
  if (process.env.DISABLE_BACKGROUND_WORK === 'true') return;
  if (kickTimer) return;
  kickTimer = setTimeout(() => { kickTimer = null; runOnce(); }, delayMs);
  kickTimer.unref?.();
}

const EVERY_MS = Number(process.env.WALKIN_ATS_SWEEP_MS || 60 * 1000);

/** Every minute; every step is idempotent (claims / stage guards). */
export function startWalkinAtsSweep() {
  const first = setTimeout(runOnce, Number(process.env.WALKIN_ATS_FIRST_MS || 30_000));
  const timer = setInterval(runOnce, EVERY_MS);
  first.unref?.();
  timer.unref?.();
  return () => { clearTimeout(first); clearInterval(timer); };
}
