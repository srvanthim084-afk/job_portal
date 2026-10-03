/**
 * "Are you still looking for a job?" - so the availability status never
 * goes stale (migration 0092).
 *
 *   actively_looking, not confirmed for 30 days   -> asked
 *   open_to_offers,   not confirmed for 60 days   -> asked
 *   placed for 90 days                            -> not_looking, and asked
 *                                                    once whether they want
 *                                                    a new role
 *   asked, no answer in 14 days                   -> "Not confirmed"
 *
 * The message carries three links - Yes, actively / Open to offers / Not
 * now - that work WITHOUT signing in. Each is a random token with an HMAC
 * on it; only the SHA-256 of the whole token is stored, so the database
 * cannot be used to answer for anybody, and the database refuses a token
 * twice (single-use) and after 14 days.
 *
 * Rules the sweep keeps:
 *   - never between 21:00 and 08:00 IST: a run at night sends nothing and
 *     the next daytime run picks the same people up;
 *   - at most one message per candidate per 30 days (the due query);
 *   - one channel: WhatsApp when an approved template is configured and
 *     they opted in, else SMS, else email - the next is tried only when
 *     the one before did not send - plus an in-app notification always;
 *   - nothing to a do-not-contact candidate;
 *   - every attempt is recorded with the provider's own answer. "Sent"
 *     only ever comes from a provider.
 *
 * Candidate-facing: no client name and never the word "Client" - these
 * messages are about the candidate, not about any job.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { withUser } from '../db.js';
import { config } from '../config.js';
import { providers } from './providers.js';
import { channelSettings } from './channel-settings.js';
import { emailLayout } from './layout.js';
import { inQuietHours } from './saved-search-alerts.js';

const ENGINE = { userId: '', role: 'admin', profileId: null };

export const ANSWERS = {
  actively_looking: 'Yes, actively looking',
  open_to_offers: 'Open to offers',
  not_looking: 'Not looking now',
};

/* ------------------------------------------------------------------ *
 * tokens
 * ------------------------------------------------------------------ */
const sig = (rand) => createHmac('sha256', config.authSecret || 'unset')
  .update(`availability-reply:${rand}`).digest('base64url').slice(0, 22);

export function newToken() {
  const rand = randomBytes(24).toString('base64url');
  return `${rand}.${sig(rand)}`;
}

/** Is this a token we signed? (Before it is looked up at all.) */
export function tokenSigned(token) {
  const s = String(token || '');
  const dot = s.lastIndexOf('.');
  if (dot < 16 || s.length > 200) return false;
  const given = Buffer.from(s.slice(dot + 1));
  const want = Buffer.from(sig(s.slice(0, dot)));
  return given.length === want.length && timingSafeEqual(given, want);
}

export const tokenHash = (token) => createHash('sha256').update(String(token)).digest('hex');

const base = () => config.publicOrigin.replace(/\/$/, '');
export const replyUrl = (token, answer) =>
  `${base()}/api/availability/reply?t=${encodeURIComponent(token)}&a=${encodeURIComponent(answer)}`;

/* ------------------------------------------------------------------ *
 * the message
 * ------------------------------------------------------------------ */
export function buildAvailabilityMessages({ name, kind, token }) {
  const first = String(name || '').trim().split(/\s+/)[0] || '';
  const greeting = first ? `Hi ${first},` : 'Hi,';
  const links = Object.keys(ANSWERS).map((a) => ({ answer: a, label: ANSWERS[a], url: replyUrl(token, a) }));

  const lead = kind === 'placed_followup'
    ? 'It has been a few months since you started your new job through TeamLink. Looking for a new role? Tell us in one tap so recruiters know.'
    : 'Are you still looking for a job? Tell us in one tap so recruiters know whether to call you.';
  const subject = kind === 'placed_followup'
    ? 'Looking for a new role? Update your status'
    : 'Are you still looking for a job?';

  const lines = links.map((l) => `${l.label}: ${l.url}`).join('\n');
  const text = `${greeting}\n\n${lead}\n\n${lines}\n\nNo login needed. The links work once and expire in 14 days.\n\n— TeamLink`;

  const html = emailLayout({
    title: subject,
    preheader: lead,
    greeting,
    body: `${lead}\n\n${links.map((l) => `• ${l.label}: ${l.url}`).join('\n')}`,
    cta: { label: ANSWERS.actively_looking, url: links[0].url },
    note: 'No login needed. Each link works once and expires in 14 days. You can also change your status any time from your TeamLink profile.',
  });

  const sms = `TeamLink: ${greeting} ${kind === 'placed_followup' ? 'Looking for a new role?' : 'Still looking for a job?'}`
    + ` Yes: ${links[0].url} Open to offers: ${links[1].url} Not now: ${links[2].url}`;
  const whatsapp = `*TeamLink*\n\n${greeting}\n\n${lead}\n\n`
    + links.map((l) => `*${l.label}*\n${l.url}`).join('\n\n')
    + '\n\nNo login needed.';
  return { email: { subject, text, html }, sms, whatsapp, subject, lead };
}

/* ------------------------------------------------------------------ *
 * sending one
 * ------------------------------------------------------------------ */
async function deliver(cand, messages) {
  const delivery = {};
  const wa = await channelSettings('whatsapp').catch(() => ({}));
  const plan = [];
  if (cand.phone && cand.whatsapp_opt_in && wa && wa.templateName) plan.push('whatsapp');
  if (cand.phone && cand.sms_opt_in !== false) plan.push('sms');
  if (cand.email && cand.email_opt_in !== false) plan.push('email');

  for (const channel of plan) {
    const to = channel === 'email' ? cand.email : cand.phone;
    let r;
    try {
      r = await providers[channel].send({
        to,
        subject: messages.email.subject,
        html: messages.email.html,
        text: channel === 'sms' ? messages.sms : channel === 'whatsapp' ? messages.whatsapp : messages.email.text,
        vars: { to_name: cand.name, candidate_name: cand.name, subject: messages.email.subject,
                message: messages.email.text },
      });
    } catch (err) {
      r = { status: 'failed', provider: channel, error: err.message };
    }
    delivery[channel] = r.error ? `${r.status}: ${String(r.error).slice(0, 160)}` : r.status;
    if (r.status === 'sent' || r.status === 'delivered') return { channel, delivery };
  }
  if (!plan.length) delivery.none = 'no channel: no opted-in phone or email';
  return { channel: null, delivery };
}

async function ask(cand, kind, now) {
  const token = newToken();
  const messages = buildAvailabilityMessages({ name: cand.name, kind, token });
  const { channel, delivery } = await deliver(cand, messages);
  delivery.in_app = 'sent';

  const checkId = await withUser(ENGINE, async (c) => {
    const id = (await c.query(
      `select availability_engine_check_add($1,$2,$3,$4,$5,$6::jsonb,$7) as id`,
      [cand.id, kind, tokenHash(token), cand.status || null, channel || 'in_app',
       JSON.stringify(delivery), new Date(now)])).rows[0].id;
    /* In-app, always. No token in it: the candidate is signed in there,
       and the profile has the one-tap control. */
    await c.query(
      `select notify_create($1,$2,'candidate',$3,$4,$5,null,null,$2,null,$6::jsonb)`,
      [`ntf_av_${id}`, cand.id, kind === 'placed_followup' ? 'AVAILABILITY_PLACED' : 'AVAILABILITY_CHECK',
       messages.subject, `${messages.lead} Update it on your profile.`,
       JSON.stringify({ applicationId: `avc_${id}`, link: '#/candidate/profile' })]);
    return id;
  });
  return { checkId: Number(checkId), channel, delivery };
}

/* ------------------------------------------------------------------ *
 * the sweep
 * ------------------------------------------------------------------ */
export async function runAvailabilitySweep(opts = {}) {
  const now = opts.now ?? Date.now();
  const at = new Date(now);
  const out = { lapsed: 0, released: 0, asked: 0, sent: 0, skipped: null };

  // "Not confirmed" is bookkeeping, not a message: it runs at any hour.
  out.lapsed = (await withUser(ENGINE, (c) => c.query(
    `select availability_engine_lapse($1) as n`, [at]))).rows[0].n;

  if (inQuietHours(now)) { out.skipped = 'quiet hours (21:00-08:00 IST)'; return out; }

  const placed = (await withUser(ENGINE, (c) => c.query(
    `select * from availability_engine_placed_due($1)`, [at]))).rows;
  for (const p of placed) {
    const moved = (await withUser(ENGINE, (c) => c.query(
      `select availability_engine_release($1) as ok`, [p.id]))).rows[0].ok;
    if (!moved) continue;
    out.released += 1;
    const r = await ask({ ...p, status: 'placed' }, 'placed_followup', now);
    out.asked += 1;
    if (r.channel) out.sent += 1;
  }

  const due = (await withUser(ENGINE, (c) => c.query(
    `select * from availability_engine_due($1)`, [at]))).rows;
  for (const cand of due) {
    const r = await ask(cand, 'reconfirm', now);
    out.asked += 1;
    if (r.channel) out.sent += 1;
  }
  return out;
}

const EVERY_MS = Number(process.env.AVAILABILITY_SWEEP_MS || 60 * 60 * 1000);

/** Hourly; idempotent because the database decides who is due. */
export function startAvailabilitySweep() {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const r = await runAvailabilitySweep();
      if (r.asked || r.lapsed || r.released) {
        console.log(`[availability] asked ${r.asked} (${r.sent} delivered), ${r.lapsed} not confirmed, ${r.released} placed -> not looking`);
      }
    } catch (err) {
      console.error('[availability] the sweep failed:', err.message);
    } finally {
      running = false;
    }
  };
  const first = setTimeout(run, Number(process.env.AVAILABILITY_FIRST_MS || 120_000));
  const timer = setInterval(run, EVERY_MS);
  first.unref?.();
  timer.unref?.();
  return () => { clearTimeout(first); clearInterval(timer); };
}
