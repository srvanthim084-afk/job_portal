/**
 * "3 recruiters viewed your profile today" - once a day, at 7 PM IST.
 *
 * No message per view. One digest per candidate per day, and only on a
 * day that had views. In-app always; email and WhatsApp only when the
 * candidate opted in on the Who viewed my profile page (and has not
 * opted out of that channel altogether, or asked not to be contacted).
 * WhatsApp needs an approved template (Notification Settings) - without
 * one it is recorded not_configured, never attempted.
 *
 * Idempotent: candidate_profile_view_digests is keyed (candidate, day)
 * and claimed BEFORE anything is sent, so a restart or two sweeps close
 * together cannot send twice. The in-app row is deduplicated by the
 * notifications index as well (metadata.stage = views:<day>).
 *
 * The same sweep deletes view rows older than 180 days.
 *
 * Nothing here names a viewer, a company or a client: the message is a
 * count and a link.
 */
import { withUser } from '../db.js';
import { config } from '../config.js';
import { providers } from './providers.js';
import { channelSettings } from './channel-settings.js';
import { emailLayout } from './layout.js';
import { inQuietHours } from './saved-search-alerts.js';

const ENGINE = { userId: '', role: 'admin', profileId: null };
const IST_MS = 330 * 60 * 1000;
const DIGEST_HOUR = 19;

/** The calendar day in India, 'YYYY-MM-DD'. */
export function istDay(now = Date.now()) {
  return new Date(now + IST_MS).toISOString().slice(0, 10);
}
export function istHour(now = Date.now()) {
  return new Date(now + IST_MS).getUTCHours();
}

export function digestText({ viewers, staff, hiringTeams }) {
  const n = Number(viewers) || 0;
  if (hiringTeams && !staff) {
    return `${n} hiring team${n === 1 ? '' : 's'} reviewed your profile today`;
  }
  if (hiringTeams && staff) return `${n} recruiters and hiring teams viewed your profile today`;
  return `${n} recruiter${n === 1 ? '' : 's'} viewed your profile today`;
}

const pageUrl = () => `${config.publicOrigin.replace(/\/$/, '')}/#/candidate/viewers`;

async function digestEnabled() {
  try {
    const row = await withUser(ENGINE, async (c) => (await c.query(
      `select value from app_settings where key = 'profile_viewers'`)).rows[0]);
    return !(row && row.value && row.value.dailyDigest === false);
  } catch { return true; }
}

/**
 * @param opts.now    clock, for tests
 * @param opts.force  run even before 19:00 IST (tests)
 * @returns { day, due, sent:{in_app,email,whatsapp}, skipped }
 */
export async function runProfileViewDigest(opts = {}) {
  const now = opts.now ?? Date.now();
  const day = istDay(now);
  const out = { day, due: 0, inApp: 0, email: 0, whatsapp: 0 };
  if (!opts.force && istHour(now) < DIGEST_HOUR) return { ...out, skipped: 'before 7 PM IST' };
  if (!(await digestEnabled())) return { ...out, skipped: 'turned off in settings' };

  const due = await withUser(ENGINE, async (c) => {
    const rows = (await c.query(`select * from profile_view_digest_due($1::date)`, [day])).rows;
    if (!rows.length) return [];
    const ids = rows.map((r) => r.candidate_id);
    const prefs = new Map((await c.query(`select * from profile_view_digest_prefs($1)`, [ids]))
      .rows.map((r) => [r.candidate_id, r]));
    const cands = new Map((await c.query(
      `select id, name, email, phone, email_opt_in, whatsapp_opt_in, do_not_contact
         from candidates where id = any($1)`, [ids])).rows.map((r) => [r.id, r]));
    return rows.map((r) => ({ ...r, pref: prefs.get(r.candidate_id) || {}, cand: cands.get(r.candidate_id) }));
  });
  out.due = due.length;

  const waCfg = await channelSettings('whatsapp').catch(() => ({}));
  const quiet = inQuietHours(now);

  for (const d of due) {
    if (!d.cand) continue;
    const claimed = await withUser(ENGINE, async (c) => (await c.query(
      `select profile_view_digest_claim($1,$2::date,$3) as ok`, [d.candidate_id, day, d.viewers])).rows[0].ok);
    if (!claimed) continue;

    const text = digestText({ viewers: d.viewers, staff: d.staff, hiringTeams: d.hiring_teams });
    const record = (channel, status) => withUser(ENGINE, (c) => c.query(
      `select profile_view_digest_result($1,$2::date,$3,$4)`, [d.candidate_id, day, channel, status]))
      .catch((err) => console.error('[profile-views] could not record a digest result:', err.message));

    /* in-app, always */
    try {
      const id = `pvd_${d.candidate_id}_${day}`.slice(0, 120);
      const made = await withUser(ENGINE, async (c) => (await c.query(
        `select notify_create($1,$2,'candidate','PROFILE_VIEWS_DIGEST',$3,$4,null,null,$2,null,$5::jsonb) as id`,
        [id, d.candidate_id, 'Who viewed your profile', `${text}. See who viewed your profile.`,
         JSON.stringify({ stage: `views:${day}`, link: '#/candidate/viewers', viewers: d.viewers })])).rows[0].id);
      await record('in_app', made ? 'sent' : 'duplicate');
      if (made) out.inApp += 1;
    } catch (err) {
      await record('in_app', 'failed');
      console.error('[profile-views] in-app digest failed:', err.message);
    }

    const cand = d.cand;
    /* email, only if they asked for it */
    if (d.pref.digest_email) {
      let r;
      if (cand.do_not_contact) r = { status: 'skipped_opted_out' };
      else if (cand.email_opt_in === false) r = { status: 'skipped_opted_out' };
      else if (!cand.email) r = { status: 'skipped_no_address' };
      else {
        const greeting = cand.name ? `Hi ${String(cand.name).split(' ')[0]},` : 'Hi,';
        const html = emailLayout({
          title: 'Who viewed your profile today',
          preheader: text,
          greeting,
          body: `${text}.\n\nOpen TeamLink to see who looked and for which role.`,
          cta: { label: 'See who viewed your profile', url: pageUrl() },
          note: 'You get this because you turned on the daily profile-views email on TeamLink. You can turn it off on the same page.',
        });
        try {
          r = await providers.email.send({
            to: cand.email, subject: `${text} - TeamLink`, html,
            text: `${greeting}\n\n${text}.\n\nSee who viewed your profile: ${pageUrl()}\n\n- TeamLink`,
            vars: { to_name: cand.name, candidate_name: cand.name, subject: text, message: text, portal_link: pageUrl() },
          });
        } catch (err) { r = { status: 'failed', error: err.message }; }
      }
      await record('email', r.status);
      if (r.status === 'sent') out.email += 1;
    }

    /* WhatsApp, only if they asked for it - and there is an approved template */
    if (d.pref.digest_whatsapp) {
      let r;
      if (cand.do_not_contact) r = { status: 'skipped_opted_out' };
      else if (!cand.whatsapp_opt_in) r = { status: 'skipped_opted_out' };
      else if (!cand.phone) r = { status: 'skipped_no_address' };
      else if (quiet) r = { status: 'skipped_quiet_hours' };
      else if (!(waCfg && waCfg.templateName)) r = { status: 'not_configured' };
      else {
        try {
          r = await providers.whatsapp.send({ to: cand.phone,
            text: `*TeamLink*\n\n${text}.\n\nSee who viewed your profile: ${pageUrl()}` });
        } catch (err) { r = { status: 'failed', error: err.message }; }
      }
      await record('whatsapp', r.status);
      if (r.status === 'sent') out.whatsapp += 1;
    }
  }
  return out;
}

export async function runProfileViewCleanup() {
  return withUser(ENGINE, async (c) => (await c.query(`select profile_views_cleanup() as r`)).rows[0].r);
}

const EVERY_MS = Number(process.env.PROFILE_VIEW_SWEEP_MS || 10 * 60 * 1000);

/** Every ten minutes; the digest fires once 19:00 IST has passed. */
export function startProfileViewDigest() {
  let running = false;
  let cleanedOn = null;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const r = await runProfileViewDigest();
      if (r.inApp || r.email || r.whatsapp) {
        console.log(`[profile-views] digest ${r.day}: ${r.inApp} in-app, ${r.email} email, ${r.whatsapp} WhatsApp`);
      }
      const today = istDay();
      if (cleanedOn !== today) {
        const c = await runProfileViewCleanup();
        cleanedOn = today;
        if (c && (c.views || c.appearances)) console.log(`[profile-views] removed ${c.views} view(s) and ${c.appearances} appearance day(s) older than 180 days`);
      }
    } catch (err) {
      console.error('[profile-views] the sweep failed:', err.message);
    } finally {
      running = false;
    }
  };
  const first = setTimeout(run, Number(process.env.PROFILE_VIEW_FIRST_MS || 120_000));
  const timer = setInterval(run, EVERY_MS);
  first.unref?.();
  timer.unref?.();
  return () => { clearTimeout(first); clearInterval(timer); };
}
