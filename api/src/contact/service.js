/**
 * The one door every recruiter-to-candidate contact goes through (0118).
 *
 *   permission  ->  cooldown  ->  override  ->  log row  ->  (the send)
 *
 * The first four are one database transaction, behind a per-candidate
 * lock (contact_begin), so two recruiters pressing Send at the same
 * moment cannot both get through: the second waits, sees the first one's
 * row and is refused. The caller then performs the send and reports how
 * it went (finishContact). The cooldown is the admin setting
 * app_settings 'contact_cooldown' (days, default 7), judged against each
 * row's own timestamp.
 *
 * Channels are stored as: phone (a call), whatsapp, email, sms, ai_call.
 *
 * What this cannot do: a message the BROWSER sends (wa.me, the mail
 * client, the SMS app) leaves the system on the recruiter's own device,
 * so the server can refuse to log it and refuse the check, but cannot
 * stop the device. Everything the server sends (bulk messages, AI calls)
 * cannot leave without passing here.
 */
import { withUser } from '../db.js';
import { ApiError, forbidden } from '../errors.js';

export const CHANNELS = ['phone', 'whatsapp', 'email', 'sms', 'ai_call'];

/** The three ways a held candidate is described to a screen. */
export const holderOf = (h) => (h ? {
  name: h.name || 'Another recruiter',
  channel: h.channel,
  contactedAt: h.contactedAt,
  expiresAt: h.expiresAt,
} : null);

const canOverride = (session) =>
  session && (session.role === 'admin' || session.isTeamLead === true);

/**
 * Check and log one contact. Returns { id, overridden } or throws:
 *   403  the candidate or job is not one the caller may use
 *   409  CONTACT_COOLDOWN { holder, cooldownDays, canOverride }
 *   400  OVERRIDE_REASON_REQUIRED
 */
export async function beginContact(session, {
  candidateId, channel, jobId = null, source = null, override = false, reason = null, detail = null,
}) {
  const r = await withUser(session, async (c) => (await c.query(
    `select contact_begin($1,$2,$3,$4,$5,$6,$7) as r`,
    [candidateId, channel, jobId, source || channel, override === true, reason, detail])).rows[0].r);
  if (r.ok) return { id: Number(r.id), overridden: !!r.overridden };
  if (r.code === 'NOT_VISIBLE') throw forbidden('You do not have access to this candidate.');
  if (r.code === 'COOLDOWN') {
    throw new ApiError(409, 'CONTACT_COOLDOWN',
      `${r.holder.name} already contacted this candidate on ${new Date(r.holder.contactedAt).toISOString()}.`,
      { holder: r.holder, cooldownDays: r.cooldownDays, canOverride: canOverride(session) });
  }
  throw new ApiError(400, 'CONTACT_REFUSED', 'This contact could not be made.');
}

/**
 * Many at once; every candidate is judged alone. Returns
 *   { allowed: [{candidateId, id, overridden}], skipped: [{candidateId, holder, cooldownDays}],
 *     notVisible: [candidateId] }
 */
export async function beginContacts(session, candidateIds, {
  channel, jobId = null, source = 'bulk_message', override = false, reason = null,
}) {
  const rows = await withUser(session, async (c) => (await c.query(
    `select contact_begin_many($1::text[],$2,$3,$4,$5,$6) as r`,
    [candidateIds, channel, jobId, source, override === true, reason])).rows[0].r);
  const out = { allowed: [], skipped: [], notVisible: [] };
  for (const x of rows) {
    if (x.ok) out.allowed.push({ candidateId: x.candidateId, id: Number(x.id), overridden: !!x.overridden });
    else if (x.code === 'COOLDOWN') {
      out.skipped.push({ candidateId: x.candidateId, holder: x.holder, cooldownDays: x.cooldownDays });
    } else out.notVisible.push(x.candidateId);
  }
  return out;
}

/** How the send went. 'sent' | 'queued' | 'failed' | ... A failed contact stops holding anyone back. */
export async function finishContact(session, id, outcome, ref = null) {
  if (id == null) return;
  await withUser(session, (c) => c.query(`select contact_finish($1,$2,$3)`, [id, outcome, ref]));
}

/** Who holds each of these people right now (the list badge). Keyed by candidate id. */
export async function cooldownBadges(session, candidateIds) {
  const ids = [...new Set(candidateIds)].slice(0, 500);
  if (!ids.length) return {};
  const rows = await withUser(session, async (c) => (await c.query(
    `select * from contact_cooldown_badges($1::text[])`, [ids])).rows);
  const out = {};
  for (const x of rows) {
    out[x.candidate_id] = {
      name: x.holder_name, channel: x.channel,
      contactedAt: new Date(x.contacted_at).toISOString(),
      expiresAt: new Date(x.expires_at).toISOString(),
    };
  }
  return out;
}

export async function cooldownDays(session) {
  return withUser(session, async (c) => (await c.query(`select contact_cooldown_days() as d`)).rows[0].d);
}

export { canOverride };
