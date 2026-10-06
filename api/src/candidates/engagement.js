/**
 * Who is working this candidate, and may I?
 *
 * The rules live in the database (migration 0091): can_engage() decides,
 * triggers on applications and ai_call_sessions enforce it for adding to
 * a requirement, submitting to the client and AI calls. This module is
 * the API's side of the same thing, for the actions the database cannot
 * see on its own - a WhatsApp message, an email, a logged phone call:
 *
 *   recordContact()   one row in the contact history, on the caller's behalf
 *   canEngage()       'allowed' | 'warn' | 'blocked' for one candidate
 *   canEngageMany()   the same for a list, for bulk messages
 *   requireEngage()   throws the 409 the screen shows, or returns the verdict
 *
 * Every route that contacts a candidate calls one of these BEFORE it
 * contacts them. The screen asks too, to show the warning early; the
 * server asking again is the rule.
 */
import { withUser } from '../db.js';
import { ApiError } from '../errors.js';

/** Who a recruiter is to the database: no person behind the engine. */
export const ENGAGEMENT_CODES = {
  BLOCKED: 'ENGAGEMENT_BLOCKED',
  WARN: 'ENGAGEMENT_WARN',
  DUPLICATE: 'DUPLICATE_SUBMISSION',
};

const iso = (v) => (v ? new Date(v).toISOString() : null);

/** The verdict, in the shape every route and the screen use. */
export function toVerdict(r, holderVisible = false) {
  if (!r) return { decision: 'allowed', reason: null };
  /*
   * 0117: THE RULE STAYS, THE IDENTITY DOES NOT.
   *
   * Two recruiters still may not work the same person for the same role,
   * so a hold is still reported. But who holds it, for which job and how
   * far along is another recruiter's pipeline: unless the holder is in the
   * caller's scope (themselves, a team lead's department, an admin's
   * everyone) the verdict carries "Another recruiter", the hold's end
   * date, and nothing else. recruiterId 'holder' is a handle the
   * message-holder route resolves on the server.
   */
  if (r.holder_recruiter_id && !holderVisible) {
    return {
      decision: r.decision,
      reason: r.reason || null,
      roleKey: null,
      anonymous: true,
      holder: {
        recruiterId: 'holder', name: 'Another recruiter', level: r.level || null,
        jobTitle: null, status: null, statusLabel: null, lastActivity: null,
        holdExpiresAt: iso(r.hold_expires_at), lastChannel: null, lastOutcome: null,
      },
      overrideId: r.override_id != null ? Number(r.override_id) : null,
    };
  }
  return {
    decision: r.decision,
    reason: r.reason || null,
    roleKey: r.role_key || null,
    holder: r.holder_recruiter_id ? {
      recruiterId: r.holder_recruiter_id,
      name: r.holder_name || 'Another recruiter',
      level: r.level || null,
      jobTitle: r.job_title || null,
      status: r.status || null,
      statusLabel: r.status_label || null,
      lastActivity: iso(r.last_activity),
      holdExpiresAt: iso(r.hold_expires_at),
      lastChannel: r.last_channel || null,
      lastOutcome: r.last_outcome || null,
    } : null,
    overrideId: r.override_id != null ? Number(r.override_id) : null,
  };
}

const fmtDate = (v) => (v ? new Date(v).toLocaleDateString('en-IN',
  { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : '');

const daysAgo = (v) => {
  if (!v) return '';
  const d = Math.max(0, Math.floor((Date.now() - new Date(v).getTime()) / 86400000));
  return d === 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`;
};

const roleName = (h, roleKey) => (h && h.jobTitle)
  || String(roleKey || 'this role').replace(/\b\w/g, (c) => c.toUpperCase());

/** The sentence a person reads. Same wording on every screen. */
export function verdictMessage(v) {
  const h = v.holder;
  if (v.decision === 'allowed' || !h) return '';
  if (v.reason === 'joined') {
    return `${h.name} placed this candidate (joined through TeamLink). They are held for every role `
      + `until ${fmtDate(h.holdExpiresAt)} (replacement period).`;
  }
  if (v.reason === 'placed_other_role') {
    return 'This candidate joined through TeamLink recently. Contact for another role is blocked until '
      + `${fmtDate(h.holdExpiresAt)} (replacement period).`;
  }
  if (v.anonymous) {
    return v.decision === 'blocked'
      ? `Another recruiter is already working on this candidate. Hold ends ${fmtDate(h.holdExpiresAt)} if no activity.`
      : 'Another recruiter contacted this candidate recently. Contact anyway?';
  }
  if (v.decision === 'blocked') {
    return `${h.name} is processing this candidate for ${roleName(h, v.roleKey)}`
      + `${h.statusLabel ? ` (${h.statusLabel})` : ''}. Hold ends ${fmtDate(h.holdExpiresAt)} if no activity.`;
  }
  const outcome = h.lastOutcome && !['sent', 'queued'].includes(h.lastOutcome)
    ? ` (${String(h.lastOutcome).replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())})` : '';
  return `${h.name} contacted this candidate for ${roleName(h, v.roleKey)} ${daysAgo(h.lastActivity)}`
    + `${outcome}. Contact anyway?`;
}

/** can_engage() for one candidate, as the caller. */
export async function canEngage(session, candidateId, { jobId = null, roleKey = null } = {}) {
  if (!session || !['recruiter', 'bde', 'admin'].includes(session.role)) {
    return { decision: 'allowed', reason: null, holder: null };
  }
  const { row, visible } = await withUser(session, async (c) => {
    const row = (await c.query(
      `select * from can_engage($1, $2, $3)`, [candidateId, jobId || null, roleKey || null])).rows[0];
    const visible = row && row.holder_recruiter_id
      ? (await c.query(`select app_recruiter_in_scope($1) as v`, [row.holder_recruiter_id])).rows[0].v
      : false;
    return { row, visible };
  });
  const v = toVerdict(row, visible);
  v.message = verdictMessage(v);
  return v;
}

/** The same for a list - one transaction, one round trip per candidate. */
export async function canEngageMany(session, candidateIds, { jobId = null, roleKey = null } = {}) {
  const out = new Map();
  if (!session || !['recruiter', 'bde', 'admin'].includes(session.role) || !candidateIds.length) {
    candidateIds.forEach((id) => out.set(id, { decision: 'allowed', reason: null, holder: null, message: '' }));
    return out;
  }
  await withUser(session, async (c) => {
    for (const id of candidateIds) {
      const row = (await c.query(`select * from can_engage($1, $2, $3)`,
        [id, jobId || null, roleKey || null])).rows[0];
      const visible = row && row.holder_recruiter_id
        ? (await c.query(`select app_recruiter_in_scope($1) as v`, [row.holder_recruiter_id])).rows[0].v
        : false;
      const v = toVerdict(row, visible);
      v.message = verdictMessage(v);
      out.set(id, v);
    }
  });
  return out;
}

/**
 * Write one contact to the history, as the caller. Never throws: the
 * contact has happened (or is about to), and losing the record must not
 * undo it - the failure is logged instead.
 */
export async function recordContact(session, {
  candidateId, jobId = null, roleKey = null, channel = null, source,
  outcome = null, detail = null, ref = null,
}) {
  if (!session || !['recruiter', 'bde', 'admin'].includes(session.role)) return null;
  try {
    return await withUser(session, async (c) => (await c.query(
      `select engagement_record($1,$2,$3,$4,$5,$6,$7,$8) as id`,
      [candidateId, jobId || null, roleKey || null, channel || source, source,
       outcome || null, detail ? String(detail).slice(0, 500) : null, ref || null])).rows[0].id);
  } catch (err) {
    console.error('[engagement] a contact was not recorded:', err.message);
    return null;
  }
}

/** One line in engagement_audit (contact_anyway / blocked / ...). Never throws. */
export async function audit(session, { candidateId, roleKey = null, jobId = null, action, detail = {} }) {
  if (!session || !['recruiter', 'bde', 'admin'].includes(session.role)) return null;
  try {
    return await withUser(session, async (c) => (await c.query(
      `select engagement_audit_add($1,$2,$3,$4,$5::jsonb) as id`,
      [candidateId, roleKey, jobId, action, JSON.stringify(detail || {})])).rows[0].id);
  } catch (err) {
    console.error('[engagement] audit not written:', err.message);
    return null;
  }
}

/**
 * The gate a route puts in front of a contact.
 *
 *   blocked                      -> 409 ENGAGEMENT_BLOCKED (logged)
 *   warn, not acknowledged       -> 409 ENGAGEMENT_WARN
 *   warn, acknowledged           -> allowed, and "contact anyway" is logged
 *   allowed                      -> allowed
 */
export async function requireEngage(session, candidateId, {
  jobId = null, roleKey = null, action = 'contact', acknowledge = false,
} = {}) {
  const v = await canEngage(session, candidateId, { jobId, roleKey });
  if (v.decision === 'blocked') {
    await audit(session, { candidateId, roleKey: v.roleKey, jobId, action: 'blocked',
      detail: { action, reason: v.reason, holder: v.holder && v.holder.name } });
    throw new ApiError(409, ENGAGEMENT_CODES.BLOCKED, v.message || 'Another recruiter holds this candidate.',
      { engagement: v });
  }
  if (v.decision === 'warn' && !acknowledge) {
    throw new ApiError(409, ENGAGEMENT_CODES.WARN, v.message || 'Another recruiter contacted this candidate recently.',
      { engagement: v });
  }
  if (v.decision === 'warn') {
    await audit(session, { candidateId, roleKey: v.roleKey, jobId, action: 'contact_anyway',
      detail: { action, holder: v.holder && v.holder.name, level: v.holder && v.holder.level } });
  }
  return v;
}

/**
 * Staff fields a recruiter who may not EDIT this candidate does not get.
 *
 * The profile is shared; what the owning recruiter wrote about the
 * person on the add form is that recruiter's note, and private notes stay
 * private. A recruiter who can edit the record (owner, the requirement
 * they applied to, admin) sees it as before.
 */
export function forViewer(cand, editable) {
  if (editable) return { ...cand, canEdit: true };
  const out = { ...cand, canEdit: false };
  /* 0117: the notes on the shape are the viewer's OWN talent_pool row
     (or absent) - nothing on the shared row - so they are not stripped
     here; the shared profile drops them in basicProfile(). */
  delete out.interviewPrefs;
  return out;
}

/** Which of these candidates may the caller edit? */
export async function editableSet(session, ids) {
  if (!ids.length) return new Set();
  if (session && session.role === 'admin') return new Set(ids);
  if (!session || session.role !== 'recruiter') return new Set();
  const rows = await withUser(session, async (c) => (await c.query(
    `select id from unnest($1::text[]) as id where app_candidate_editable(id)`, [ids])).rows);
  return new Set(rows.map((r) => r.id));
}
