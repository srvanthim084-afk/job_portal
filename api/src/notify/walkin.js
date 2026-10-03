/**
 * Walk-in drive messages (0099).
 *
 *   registered            the moment a candidate registers: venue, date,
 *                         time, documents to carry
 *   reminder_day_before   from 10:00 IST on the day before the drive
 *   reminder_morning      from 07:00 IST on the day, until the drive ends
 *   updated               the recruiter changed the date, time, venue,
 *                         documents or contact - to everyone registered
 *   cancelled             the recruiter cancelled the drive - likewise
 *
 * ONE WORDING. Every channel is built from the same lines by one
 * function, so the portal, the email, the SMS and the WhatsApp message
 * cannot disagree about where to go or when.
 *
 * NEVER TWICE. Each (registration, kind, key, channel) is CLAIMED by an
 * insert into walkin_notifications before anything is sent; a second run
 * finds the claim and moves on. The key is what makes a message new:
 * the registration time (re-registering after a cancel is a new
 * confirmation), the drive's date and start (a reminder for a moved
 * drive is a new reminder), the drive's version (each edit is announced
 * once).
 *
 * OPT-IN. Email unless the candidate opted out; SMS unless opted out;
 * WhatsApp only when opted in AND an approved template is configured;
 * nothing outside the portal for somebody marked do-not-contact; no SMS
 * or WhatsApp between 21:00 and 08:00 IST. Every outcome is recorded with
 * the provider's own answer - nothing is reported as sent that was not.
 *
 * Everything here runs as the ENGINE (role admin, no user id), which
 * is the only identity the walkin_notifications write policy admits.
 */
import { withUser } from '../db.js';
import { config } from '../config.js';
import { providers } from './providers.js';
import { channelSettings } from './channel-settings.js';
import { emailLayout } from './layout.js';
import { inQuietHours } from './saved-search-alerts.js';
import { toCandidate } from '../shapes.js';

export const ENGINE = { userId: '', role: 'admin', profileId: null };

const IST_MS = 330 * 60 * 1000;
const EXTERNAL = ['email', 'sms', 'whatsapp'];

/* ------------------------------------------------------------------ *
 * dates, in India
 * ------------------------------------------------------------------ */

/** 'YYYY-MM-DD' of the IST calendar day containing `now`. */
export function istDate(now = Date.now()) {
  return new Date(now + IST_MS).toISOString().slice(0, 10);
}
/** The IST wall-clock hour (0-23) at `now`. */
export function istHour(now = Date.now()) {
  return new Date(now + IST_MS).getUTCHours();
}
/** The instant a drive's date + 'HH:MM' happens, in ms. */
export function driveInstant(date, hhmm) {
  const [y, m, d] = String(date).split('-').map(Number);
  const [hh, mm] = String(hhmm || '00:00').split(':').map(Number);
  return Date.UTC(y, m - 1, d, hh || 0, mm || 0) - IST_MS;
}
export function addDays(date, n) {
  const [y, m, d] = String(date).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

const hm = (t) => String(t || '').slice(0, 5);

/** '10:00 AM' from '10:00' / '10:00:00'. */
export function time12(t) {
  const [h, m] = hm(t).split(':').map(Number);
  if (!Number.isFinite(h)) return '';
  const ap = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${String(m || 0).padStart(2, '0')} ${ap}`;
}

/** 'Sat, 12 Oct 2026' from 'YYYY-MM-DD' - no time zone involved. */
export function dateLabel(date) {
  const [y, m, d] = String(date).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${days[dt.getUTCDay()]}, ${d} ${months[m - 1]} ${y}`;
}

const base = () => config.publicOrigin.replace(/\/$/, '');
export const driveUrl = (id) => `${base()}/#/candidate/walkins?id=${encodeURIComponent(id)}`;

/* ------------------------------------------------------------------ *
 * the words
 * ------------------------------------------------------------------ */

/**
 * @param kind  registered | reminder_day_before | reminder_morning | updated | cancelled
 * @param c     { candidateName, drive: <row>, company, url }
 * @returns { title, lines, portal, email:{subject,text,html}, sms, whatsapp }
 */
export function buildWalkinMessages(kind, c) {
  const d = c.drive;
  const when = `${dateLabel(d.drive_date)}, ${time12(d.start_time)} - ${time12(d.end_time)}`;
  const where = [d.venue_name, d.full_address, d.city].filter(Boolean).join(', ');
  const what = d.title + (c.company ? ` (${c.company})` : '');
  const docs = (d.documents_to_carry || []).filter(Boolean);
  const contact = [d.contact_person_name, d.contact_phone].filter(Boolean).join(', ');

  const lead = {
    registered: `You are registered for the walk-in drive "${what}".`,
    reminder_day_before: `Reminder: the walk-in drive "${what}" is tomorrow.`,
    reminder_morning: `Reminder: the walk-in drive "${what}" is today.`,
    updated: `The details of the walk-in drive "${what}" have changed. Please check the new details below.`,
    cancelled: `The walk-in drive "${what}" has been cancelled.`
      + (d.cancel_reason ? ` Reason: ${d.cancel_reason}` : '')
      + ' You do not need to go to the venue.',
  }[kind];

  const title = {
    registered: 'Walk-in registration confirmed',
    reminder_day_before: 'Walk-in drive tomorrow',
    reminder_morning: 'Walk-in drive today',
    updated: 'Walk-in drive details changed',
    cancelled: 'Walk-in drive cancelled',
  }[kind];

  const facts = kind === 'cancelled'
    ? [['Drive', what], ['Was on', when]]
    : [
        ['Drive', what],
        ['Role', d.job_role],
        ['When', when],
        ['Venue', where],
        ['Documents to carry', docs.join(', ')],
        ['Contact', contact],
        ['Map', d.map_link || ''],
      ];

  const lines = facts.filter((f) => f[1]).map(([k, v]) => `${k}: ${v}`);
  const greeting = c.candidateName ? `Hi ${c.candidateName},` : 'Hi,';
  const text = `${greeting}\n\n${lead}\n\n${lines.join('\n')}\n\nDetails: ${c.url}\n\n— TeamLink`;

  const html = emailLayout({
    title,
    preheader: lead,
    greeting,
    body: lead,
    facts: facts.filter((f) => f[1] && f[0] !== 'Map'),
    cta: { label: kind === 'cancelled' ? 'See other walk-in drives' : 'View drive details', url: c.url },
    note: 'You get this because you registered for this walk-in drive on TeamLink.'
      + (kind === 'cancelled' ? '' : ' You can cancel your registration from the drive page.'),
  });

  // Short on purpose: an SMS carries the essentials and the link.
  const sms = kind === 'cancelled'
    ? `TeamLink: Walk-in drive "${d.title}" on ${dateLabel(d.drive_date)} is cancelled. ${c.url}`
    : `TeamLink: ${title} - ${d.title}, ${when}, ${d.venue_name}, ${d.city}.`
      + (docs.length ? ` Bring: ${docs.slice(0, 3).join(', ')}.` : '') + ` ${c.url}`;

  const whatsapp = `*TeamLink*\n\n${greeting}\n\n${lead}\n\n${lines.join('\n')}\n\n${c.url}`;
  const portal = `${lead} ${kind === 'cancelled' ? '' : `${when} at ${where}.`}`.trim();

  return { title, lines, portal, email: { subject: `${title}: ${d.title}`, text, html }, sms: sms.slice(0, 320), whatsapp };
}

/* ------------------------------------------------------------------ *
 * sending one message to one registration
 * ------------------------------------------------------------------ */

const inflight = new Set();
/** Wait for every message started in the background (tests; shutdown). */
export async function settleWalkinNotifications() {
  while (inflight.size) await Promise.allSettled([...inflight]);
}
/** Run `fn` in the background without losing track of it. */
export function background(fn) {
  const p = Promise.resolve().then(fn)
    .catch((err) => console.error('[walkin] notification failed:', err.message))
    .finally(() => inflight.delete(p));
  inflight.add(p);
  return p;
}

async function claim(reg, kind, key, channel) {
  const r = await withUser(ENGINE, (c) => c.query(
    `insert into walkin_notifications (registration_id, drive_id, candidate_id, kind, dedupe_key, channel)
     values ($1,$2,$3,$4,$5,$6) on conflict do nothing returning id`,
    [reg.id, reg.drive_id, reg.candidate_id, kind, key, channel]));
  return r.rows[0] ? r.rows[0].id : null;
}

async function settle(id, r, to) {
  await withUser(ENGINE, (c) => c.query(
    `update walkin_notifications set status=$2, to_address=$3, provider=$4, provider_ref=$5, error=$6
      where id=$1`,
    [id, r.status, to || null, r.provider || null, r.ref || null,
     r.error ? String(r.error).slice(0, 500) : null]));
}

/**
 * Every channel for one registration. Returns { channel: status } for
 * the channels that were attempted now (already-claimed ones are left out).
 */
export async function deliverWalkin({ reg, drive, cand, company, kind, key, now = Date.now() }) {
  const msg = buildWalkinMessages(kind, {
    candidateName: cand.name, drive, company, url: driveUrl(drive.id),
  });
  const out = {};

  // portal (the bell) - always, it is not "contacting" anybody
  const pid = await claim(reg, kind, key, 'portal');
  if (pid) {
    try {
      const nid = `wkn_${pid}_${Date.now().toString(36)}`;
      await withUser(ENGINE, (c) => c.query(
        `select notify_create($1,$2,'candidate',$3,$4,$5,null,null,$6,null,$7::jsonb)`,
        [nid, cand.id, `WALKIN_${kind.toUpperCase()}#${pid}`, msg.title, msg.portal, cand.id,
         JSON.stringify({ walkin: true, kind, driveId: drive.id, registrationId: reg.id })]));
      await settle(pid, { status: 'sent', provider: 'portal', ref: nid }, null);
      out.portal = 'sent';
    } catch (err) {
      await settle(pid, { status: 'failed', provider: 'portal', error: err.message }, null);
      out.portal = 'failed';
    }
  }

  const waCfg = await channelSettings('whatsapp').catch(() => ({}));
  const quiet = inQuietHours(now);
  for (const channel of EXTERNAL) {
    const id = await claim(reg, kind, key, channel);
    if (!id) continue;
    const to = channel === 'email' ? cand.email : cand.phone;
    let r;
    if (cand.doNotContact) r = { status: 'skipped_opted_out', provider: channel, error: 'do not contact' };
    else if (!to) r = { status: 'skipped_no_address', provider: channel };
    else if (channel === 'email' && cand.emailOptIn === false) r = { status: 'skipped_opted_out', provider: channel };
    else if (channel === 'sms' && cand.smsOptIn === false) r = { status: 'skipped_opted_out', provider: channel };
    else if (channel === 'whatsapp' && !cand.whatsappOptIn) r = { status: 'skipped_opted_out', provider: channel, error: 'not opted in' };
    else if (channel !== 'email' && quiet) r = { status: 'skipped_quiet_hours', provider: channel, error: '21:00-08:00 IST' };
    else if (channel === 'whatsapp' && !(waCfg && waCfg.templateName)) {
      r = { status: 'not_configured', provider: 'whatsapp',
            error: 'no approved WhatsApp template is set in Notification Settings' };
    } else {
      try {
        r = await providers[channel].send({
          to,
          subject: msg.email.subject,
          html: msg.email.html,
          text: channel === 'sms' ? msg.sms : channel === 'whatsapp' ? msg.whatsapp : msg.email.text,
          vars: {
            to_name: cand.name, candidate_name: cand.name, job_title: drive.title,
            company_name: company || '', portal_link: driveUrl(drive.id),
            subject: msg.email.subject, message: msg.email.text,
          },
        });
      } catch (err) {
        r = { status: 'failed', provider: channel, error: err.message };
      }
    }
    await settle(id, r || { status: 'failed', provider: channel, error: 'no answer' }, to);
    out[channel] = r ? r.status : 'failed';
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * reading what to send
 * ------------------------------------------------------------------ */

async function loadContext(c, where, params) {
  const { rows } = await c.query(
    `select r.*, row_to_json(d.*) as drive, co.name as company_name, row_to_json(cand.*) as cand
       from walkin_registrations r
       join walkin_drives d on d.id = r.drive_id
       join candidates cand on cand.id = r.candidate_id
       left join companies co on co.id = d.company_id
      where ${where}`, params);
  return rows.map((x) => {
    const drive = x.drive;
    drive.start_time = hm(drive.start_time);
    drive.end_time = hm(drive.end_time);
    return { reg: x, drive, company: x.company_name || '', cand: toCandidate(x.cand) };
  });
}

/** The confirmation, for one registration. */
export async function notifyRegistered(registrationId, { now = Date.now() } = {}) {
  const [ctx] = await withUser(ENGINE, (c) => loadContext(c, 'r.id = $1 and r.status = \'REGISTERED\'', [registrationId]));
  if (!ctx) return null;
  const key = new Date(ctx.reg.registered_at).toISOString();
  return deliverWalkin({ ...ctx, kind: 'registered', key, now });
}

/** "Details changed" or "cancelled", to everyone still registered. */
export async function notifyDriveChange(driveId, kind, { now = Date.now() } = {}) {
  const list = await withUser(ENGINE, (c) =>
    loadContext(c, 'r.drive_id = $1 and r.status = \'REGISTERED\'', [driveId]));
  const out = [];
  for (const ctx of list) {
    const key = kind === 'cancelled' ? 'cancelled' : `v${ctx.drive.version}`;
    out.push(await deliverWalkin({ ...ctx, kind, key, now }));
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * the sweep: statuses, reminders, confirmations a crash missed
 * ------------------------------------------------------------------ */

const RECENT_MS = 3 * 60 * 60 * 1000;   // a reminder right after registering is noise

export async function runWalkinSweep({ now = Date.now() } = {}) {
  const out = { statusChanged: 0, confirmations: 0, dayBefore: 0, morning: 0 };
  out.statusChanged = await withUser(ENGINE, async (c) =>
    (await c.query(`select walkin_refresh_statuses() as n`)).rows[0].n);

  const today = istDate(now);
  const tomorrow = addDays(today, 1);
  const hour = istHour(now);

  const due = await withUser(ENGINE, (c) => loadContext(c,
    `r.status = 'REGISTERED' and d.status in ('UPCOMING','ONGOING') and d.drive_date between $1::date and $2::date`,
    [today, tomorrow]));

  for (const ctx of due) {
    const { reg, drive } = ctx;
    if (now >= driveInstant(drive.drive_date, drive.end_time)) continue;
    const regAt = new Date(reg.registered_at).getTime();

    // a confirmation that never went (the process died between the
    // commit and the send): the claim table says so
    const confKey = new Date(reg.registered_at).toISOString();
    const r1 = await deliverWalkin({ ...ctx, kind: 'registered', key: confKey, now });
    if (Object.keys(r1).length) out.confirmations += 1;

    const slotKey = `${drive.drive_date}@${drive.start_time}`;
    if (drive.drive_date === tomorrow && hour >= 10 && now - regAt > RECENT_MS) {
      const r = await deliverWalkin({ ...ctx, kind: 'reminder_day_before', key: slotKey, now });
      if (Object.keys(r).length) out.dayBefore += 1;
    }
    if (drive.drive_date === today && hour >= 7 && now - regAt > RECENT_MS) {
      const r = await deliverWalkin({ ...ctx, kind: 'reminder_morning', key: slotKey, now });
      if (Object.keys(r).length) out.morning += 1;
    }
  }
  return out;
}

const EVERY_MS = Number(process.env.WALKIN_SWEEP_MS || 10 * 60 * 1000);

/** Every ten minutes; every run is idempotent (see the claim above). */
export function startWalkinSweep() {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const r = await runWalkinSweep();
      if (r.statusChanged || r.dayBefore || r.morning || r.confirmations) {
        console.log(`[walkin] statuses ${r.statusChanged}, reminders ${r.dayBefore}+${r.morning}, confirmations ${r.confirmations}`);
      }
    } catch (err) {
      console.error('[walkin] the sweep failed:', err.message);
    } finally {
      running = false;
    }
  };
  const first = setTimeout(run, Number(process.env.WALKIN_FIRST_MS || 60_000));
  const timer = setInterval(run, EVERY_MS);
  first.unref?.();
  timer.unref?.();
  return () => { clearTimeout(first); clearInterval(timer); };
}
