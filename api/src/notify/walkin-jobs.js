/**
 * Walk-in jobs (0106) - the messages that belong to the job itself.
 *
 *   cancelled   a walk-in job closed (status closed / draft, or archived)
 *               BEFORE its date and end time: everybody who applied and
 *               was not turned down is told, on the portal, by email, SMS
 *               and WhatsApp (opt-in), with the role, the date and the
 *               venue that is no longer happening.
 *
 * (The confirmation with the walk-in details is the ordinary application
 * confirmation - notify/templates.js and notify/messages.js carry the
 * walk-in lines. Reminders and reschedule messages are 0107's.)
 *
 * NEVER TWICE. The database trigger writes one outbox row per closing
 * (0106 walkin_job_close_watch); every (outbox row, application,
 * channel) is CLAIMED before anything is sent, so a restart, a second
 * API process or a second kick sends nothing again. SMS and WhatsApp
 * wait for the end of quiet hours (21:00-08:00 IST) instead of being
 * dropped; the row is finished once every channel has been claimed.
 *
 * Also here: the one-time move of the old walk-in drives (0099) into
 * walk-in jobs, run at boot after every migration.
 *
 * Everything runs as the ENGINE (role admin, no user id).
 */
import { withUser } from '../db.js';
import { config } from '../config.js';
import { providers } from './providers.js';
import { channelSettings } from './channel-settings.js';
import { emailLayout } from './layout.js';
import { inQuietHours } from './saved-search-alerts.js';
import { walkinFacts } from '../portal/walkin-jobs.js';

export const ENGINE = { userId: '', role: 'admin', profileId: null };
const EXTERNAL = ['email', 'sms', 'whatsapp'];
const base = () => config.publicOrigin.replace(/\/$/, '');

/** The words, one source for every channel. Never the company. */
export function buildCancelledMessages({ candidateName, reference, detail, url }) {
  const d = detail || {};
  const title = d.title || 'the walk-in interview';
  const facts = [
    ['Position', title],
    ...(reference ? [['Application ID', reference]] : []),
    ...walkinFacts({ date: d.date, from: d.from, to: d.to, venue: d.venue }),
  ];
  const lead = `The walk-in interview for ${title} has been cancelled. Please do not travel to the venue.`;
  const after = 'We are sorry for the change. Other openings are on the TeamLink jobs page.';
  const greeting = candidateName ? `Dear ${candidateName},` : 'Dear Candidate,';
  const factText = facts.map((f) => `${f[0]}: ${f[1]}`).join('\n');
  const subject = `Walk-in cancelled – ${title}`;
  const text = `${greeting}\n\n${lead}\n\n${factText}\n\n${after}\n\n${url}\n\nRegards,\nTeamLink Consultants`;
  const html = emailLayout({
    title: subject, preheader: lead, greeting, body: `${lead}\n\n${after}`, facts,
    cta: { label: 'See other jobs', url }, note: 'You get this because you applied for this walk-in on TeamLink.',
  });
  const sms = `TeamLink: The walk-in for ${title}${d.date ? ` on ${facts.find((f) => f[0] === 'Walk-in Date')?.[1] || d.date}` : ''} is cancelled. Please do not travel. ${url}`.slice(0, 320);
  const whatsapp = `*TeamLink*\n\n${greeting}\n\n${lead}\n\n${factText}\n\n${after}\n${url}`;
  return { title: subject, portal: lead, email: { subject, text, html }, sms, whatsapp };
}

/* ------------------------------------------------------------------ *
 * the sweep
 * ------------------------------------------------------------------ */
let running = null;
let again = false;

/** Process every pending outbox row. Safe to call any time, any number of times. */
export async function runWalkinNotices({ now = Date.now() } = {}) {
  const pending = (await withUser(ENGINE, (c) => c.query(`select * from walkin_outbox_pending()`))).rows;
  const out = [];
  const waCfg = await channelSettings('whatsapp').catch(() => ({}));
  const quiet = inQuietHours(now);
  for (const o of pending) {
    const recipients = (await withUser(ENGINE, (c) =>
      c.query(`select * from walkin_outbox_recipients($1)`, [o.id]))).rows;
    const url = `${base()}/#/jobs`;
    for (const r of recipients) {
      const msg = buildCancelledMessages({ candidateName: r.name, reference: r.reference, detail: o.detail, url });
      const claim = (channel) => withUser(ENGINE, (c) => c.query(
        `select walkin_notice_claim($1,$2,$3,$4) as id`, [o.id, r.application_id, r.candidate_id, channel]))
        .then((x) => x.rows[0].id);
      const settle = (id, res, to) => withUser(ENGINE, (c) => c.query(
        `select walkin_notice_settle($1,$2,$3,$4,$5,$6)`,
        [id, res.status, to || null, res.provider || null, res.ref || null, res.error ? String(res.error) : null]));
      const sent = {};

      const pid = await claim('portal');
      if (pid) {
        try {
          const nid = `wkc_${pid}_${Date.now().toString(36)}`;
          await withUser(ENGINE, (c) => c.query(
            `select notify_create($1,$2,'candidate',$3,$4,$5,$6,$7,$8,null,$9::jsonb)`,
            [nid, r.candidate_id, `WALKIN_CANCELLED#${o.id}`, msg.title, msg.portal, o.job_id, r.application_id,
             r.candidate_id, JSON.stringify({ walkin: true, kind: 'cancelled', jobTitle: (o.detail || {}).title || '' })]));
          await settle(pid, { status: 'sent', provider: 'portal', ref: nid }, null);
          sent.portal = 'sent';
        } catch (err) {
          await settle(pid, { status: 'failed', provider: 'portal', error: err.message }, null);
          sent.portal = 'failed';
        }
      }
      for (const channel of EXTERNAL) {
        if (channel !== 'email' && quiet && !r.do_not_contact) continue;   // later, not never
        const id = await claim(channel);
        if (!id) continue;
        const to = channel === 'email' ? r.email : r.phone;
        let res;
        if (r.do_not_contact) res = { status: 'skipped_opted_out', provider: channel, error: 'do not contact' };
        else if (!to) res = { status: 'skipped_no_address', provider: channel };
        else if (channel === 'email' && r.email_opt_in === false) res = { status: 'skipped_opted_out', provider: channel };
        else if (channel === 'sms' && r.sms_opt_in === false) res = { status: 'skipped_opted_out', provider: channel };
        else if (channel === 'whatsapp' && !r.whatsapp_opt_in) res = { status: 'skipped_opted_out', provider: channel, error: 'not opted in' };
        else if (channel === 'whatsapp' && !(waCfg && waCfg.templateName)) {
          res = { status: 'not_configured', provider: 'whatsapp', error: 'no approved WhatsApp template is set in Notification Settings' };
        } else {
          try {
            res = await providers[channel].send({
              to, subject: msg.email.subject, html: msg.email.html,
              text: channel === 'sms' ? msg.sms : channel === 'whatsapp' ? msg.whatsapp : msg.email.text,
              vars: {
                to_name: r.name, candidate_name: r.name, job_title: (o.detail || {}).title || '',
                portal_link: url, subject: msg.email.subject, message: msg.email.text,
              },
            });
          } catch (err) {
            res = { status: 'failed', provider: channel, error: err.message };
          }
        }
        await settle(id, res || { status: 'failed', provider: channel, error: 'no answer' }, to);
        sent[channel] = res ? res.status : 'failed';
      }
      out.push({ outboxId: o.id, applicationId: r.application_id, sent });
    }
    /* Finished once nothing is left to claim: in quiet hours the SMS and
       WhatsApp claims are still to come. */
    if (!quiet) await withUser(ENGINE, (c) => c.query(`select walkin_outbox_done($1)`, [o.id]));
  }
  return out;
}

/** Run the sweep soon, once; a kick during a run queues one more run. */
export function kickWalkinNotices() {
  if (running) { again = true; return running; }
  running = Promise.resolve()
    .then(() => runWalkinNotices())
    .catch((err) => console.error('[walkin-jobs] notices failed:', err.message))
    .finally(() => {
      running = null;
      if (again) { again = false; kickWalkinNotices(); }
    });
  return running;
}
/** Wait for a run in progress (tests). */
export async function settleWalkinNotices() {
  while (running) await running;
}

/* ------------------------------------------------------------------ *
 * the old drives, once
 * ------------------------------------------------------------------ */
export async function migrateWalkinDrives() {
  const row = (await withUser(ENGINE, (c) => c.query(`select * from walkin_drives_migrate()`))).rows[0];
  const drives = Number((row && row.drives) || 0), apps = Number((row && row.applications) || 0);
  if (drives || apps) {
    console.log(`[walkin-jobs] moved ${drives} walk-in drive(s) into Jobs and ${apps} registration(s) into applications`);
  }
  return { drives, applications: apps };
}

/** Started by the server: the drive move once, then the notice sweep every minute. */
export function startWalkinJobs({ everyMs = 60 * 1000 } = {}) {
  migrateWalkinDrives().catch((err) => console.error('[walkin-jobs] drive migration failed:', err.message));
  const t = setInterval(() => { kickWalkinNotices(); }, everyMs);
  if (t.unref) t.unref();
  setTimeout(() => kickWalkinNotices(), 5000).unref?.();
  return () => clearInterval(t);
}
