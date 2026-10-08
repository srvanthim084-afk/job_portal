/**
 * Shared candidates and "already contacted" (migration 0091).
 *
 *   GET  /api/candidates/:id/engagements?jobId=   the TeamLink activity panel:
 *                                                 every recruiter's engagement
 *                                                 (summary only), who holds the
 *                                                 candidate and until when
 *   POST /api/engagement/badges                   one badge per candidate, for a list
 *   POST /api/engagement/check                    may I contact them? (dryRun to ask,
 *                                                 otherwise enforced + logged)
 *   POST /api/engagement/record                   a contact sent from the browser
 *                                                 (Find Candidates email/WhatsApp/SMS)
 *   POST /api/candidates/:id/call-log             "Log call": outcome, optional job,
 *                                                 note -> a comment
 *   POST /api/engagement/message-holder           an internal message to the holder
 *   POST /api/engagement/overrides                ask an administrator to lift a block
 *   GET  /api/engagement/overrides                mine (recruiter) / all (admin)
 *   POST /api/engagement/overrides/:id/decide     admin: approve or deny, with a reason
 *   GET  /api/engagement/conflicts                admin: 2+ recruiters on one role,
 *                                                 "contact anyway", overrides
 *
 * The decisions are the database's (can_engage). These routes ask it,
 * enforce the answer, and write down what was done.
 */
import { Router } from 'express';
import { z } from 'zod';
import { withUser } from '../db.js';
import { wrap, badRequest, notFound, forbidden, ApiError } from '../errors.js';
import { requireAuth, requireRole } from '../auth.js';
import {
  canEngage, requireEngage, recordContact, audit, toVerdict, verdictMessage,
} from '../candidates/engagement.js';
import { availabilityOf } from './availability.js';
import { beginContact, finishContact, cooldownBadges, cooldownDays, canOverride } from '../contact/service.js';

const newId = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const iso = (v) => (v ? new Date(v).toISOString() : null);

const parse = (schema, body) => {
  const out = schema.safeParse(body || {});
  if (out.success) return out.data;
  const details = {};
  for (const i of out.error.issues) details[i.path.join('.') || 'form'] = i.message;
  throw badRequest('Please check the highlighted fields and try again.', details);
};

/* What a "Log call" may say happened. */
export const CALL_OUTCOMES = {
  interested: 'Interested',
  not_interested: 'Not interested',
  no_answer: 'No answer',
  call_back: 'Call back',
  wrong_number: 'Wrong number',
};

/* The action a screen is about to take -> the contact-history source. */
/* The action a screen is about to take -> the channel the cooldown is on (0118). */
const CHANNEL_OF = { call: 'phone', whatsapp: 'whatsapp', sms: 'sms', email: 'email', ai_call: 'ai_call' };

const ACTION_SOURCE = {
  call: 'phone', whatsapp: 'whatsapp', sms: 'sms', email: 'email',
  ai_call: 'ai_call', add_to_job: null, submission: null, contact: null,
};

const STAFF = ['recruiter', 'bde', 'admin'];

function shapeEngagement(r) {
  return {
    recruiterId: r.recruiter_id,
    recruiterName: r.recruiter_name || 'A recruiter',
    isMe: !!r.is_me,
    jobTitle: r.job_title || null,
    roleKey: r.role_key || null,
    sameJob: !!r.same_job,
    sameRole: !!r.same_role,
    lastContactAt: iso(r.last_contact_at),
    lastChannel: r.last_channel || null,
    lastOutcome: r.last_outcome || null,
    level: r.level,
    status: r.status || null,
    statusLabel: r.status_label || null,
    isHolder: !!r.is_holder,
    isActive: !!r.is_active,
    holdExpiresAt: iso(r.hold_expires_at),
  };
}

function shapeOverride(o) {
  return {
    id: Number(o.id),
    candidateId: o.candidate_id,
    candidateName: o.candidate_name || undefined,
    roleKey: o.role_key || null,
    jobId: o.job_id || null,
    jobTitle: o.job_title || null,
    kind: o.kind,
    reason: o.reason,
    status: o.status,
    requesterRecruiterId: o.requester_recruiter_id || null,
    requesterName: o.requester_name || undefined,
    decidedAt: iso(o.decided_at),
    decisionReason: o.decision_reason || null,
    expiresAt: iso(o.expires_at),
    usedAt: iso(o.used_at),
    createdAt: iso(o.created_at),
  };
}

/** Admin profile ids, to address an in-app notification to each. */
async function adminIds() {
  return withUser({ userId: '', role: 'admin' }, async (c) =>
    (await c.query(`select id from admins`)).rows.map((x) => x.id));
}

async function notify(c, { recipientId, role, type, title, message, candidateId, ref, meta = {} }) {
  /* notifications_dedupe keys on recipient, type, job, application and
     metadata.applicationId (0079). These messages are about none of
     those, so a unique reference goes in that slot - otherwise the second
     message to the same person would be silently dropped as a repeat. */
  await c.query(
    `select notify_create($1,$2,$3::user_role,$4,$5,$6,null,null,$7,null,$8::jsonb)`,
    [newId('ntf'), recipientId, role, type, title, message, candidateId,
     JSON.stringify({ ...meta, applicationId: ref })]);
}

export default function sharedCandidateRoutes() {
  const r = Router();

  /* ------------------------------------------------------------------ *
   * the TeamLink activity panel
   * ------------------------------------------------------------------ */
  r.get('/candidates/:id/engagements', requireAuth(), requireRole(...STAFF),
    wrap(async (req, res) => {
      const jobId = req.query.jobId ? String(req.query.jobId).slice(0, 64) : null;
      const out = await withUser(req.session, async (c) => {
        const cand = (await c.query(
          `select id, availability_status, availability_updated_at, availability_confirmed_at,
                  availability_source, availability_stale_at, availability_placed_at,
                  can_join_in, preferred_roles, preferred_cities,
                  app_candidate_editable(id) as editable
             from candidates where id = $1`, [req.params.id])).rows[0];
        if (!cand) return null;
        const rows = (await c.query(`select * from candidate_engagements($1, $2)`,
          [req.params.id, jobId])).rows;
        const verdict = (await c.query(`select * from can_engage($1, $2, null)`,
          [req.params.id, jobId])).rows[0];
        return { cand, rows, verdict };
      });
      if (!out) throw notFound('That candidate could not be found.');

      const v = toVerdict(out.verdict);
      v.message = verdictMessage(v);
      const holder = out.rows.find((x) => x.is_holder && x.is_active && !x.is_me);
      res.json({
        candidateId: req.params.id,
        canEdit: !!out.cand.editable,
        engagements: out.rows.map(shapeEngagement),
        holder: holder ? shapeEngagement(holder) : null,
        verdict: v,
        availability: availabilityOf(out.cand),
        callOutcomes: CALL_OUTCOMES,
      });
    }));

  /* ------------------------------------------------------------------ *
   * one badge per candidate
   * ------------------------------------------------------------------ */
  r.post('/engagement/badges', requireAuth(), requireRole(...STAFF), wrap(async (req, res) => {
    const b = parse(z.object({
      candidateIds: z.array(z.string().trim().min(1).max(64)).max(500),
      jobId: z.string().trim().max(64).optional(),
    }), req.body);
    const ids = [...new Set(b.candidateIds)];
    if (!ids.length) return res.json({ badges: {} });
    const rows = await withUser(req.session, async (c) => (await c.query(
      `select b.*, c.availability_status, c.availability_updated_at, c.availability_confirmed_at,
              c.availability_source, c.availability_stale_at, c.availability_placed_at,
              c.can_join_in, c.preferred_roles, c.preferred_cities
         from engagement_badges($1::text[], $2) b
         join candidates c on c.id = b.candidate_id`, [ids, b.jobId || null])).rows);
    const badges = {};
    /* 0118: who contacted them inside the cooldown (any channel, any job). */
    const cool = await cooldownBadges(req.session, ids);
    for (const x of rows) {
      badges[x.candidate_id] = {
        kind: x.kind || null,
        roleKey: x.role_key || null,
        jobTitle: x.job_title || null,
        recruiterName: x.recruiter_name || null,
        statusLabel: x.status_label || null,
        lastAt: iso(x.last_at),
        holdExpiresAt: iso(x.hold_expires_at),
        others: Array.isArray(x.others) ? x.others.slice(0, 20) : [],
        availability: availabilityOf(x),
        cooldown: cool[x.candidate_id] || null,
      };
    }
    for (const id of Object.keys(cool)) {
      if (!badges[id]) badges[id] = { kind: null, others: [], cooldown: cool[id] };
    }
    res.json({ badges, canOverride: canOverride(req.session), cooldownDays: await cooldownDays(req.session) });
  }));

  /* ------------------------------------------------------------------ *
   * may I contact them?
   * ------------------------------------------------------------------ */
  r.post('/engagement/check', requireAuth(), requireRole(...STAFF), wrap(async (req, res) => {
    const b = parse(z.object({
      candidateId: z.string().trim().min(1).max(64),
      jobId: z.string().trim().max(64).optional(),
      roleKey: z.string().trim().max(160).optional(),
      action: z.enum(['call', 'whatsapp', 'sms', 'email', 'ai_call', 'add_to_job', 'submission', 'contact'])
        .default('contact'),
      acknowledge: z.boolean().optional(),
      /* Only asking: nothing is recorded or enforced. */
      dryRun: z.boolean().optional(),
      /* A contact that leaves the system from the browser (wa.me): record
         it now, because nothing else will. */
      record: z.boolean().optional(),
      /* 0118: an admin or a team lead going past the cooldown, with a reason. */
      override: z.boolean().optional(),
      overrideReason: z.string().trim().max(500).optional(),
    }), req.body);

    const seen = await withUser(req.session, async (c) => (await c.query(
      `select id, availability_status, availability_updated_at, availability_confirmed_at,
              availability_source, availability_stale_at, availability_placed_at,
              can_join_in, preferred_roles, preferred_cities, do_not_contact
         from candidates where id = $1`, [b.candidateId])).rows[0]);
    if (!seen) throw notFound('That candidate could not be found.');
    const availability = availabilityOf(seen);

    const channel = CHANNEL_OF[b.action] || null;
    if (b.dryRun) {
      const v = await canEngage(req.session, b.candidateId, { jobId: b.jobId, roleKey: b.roleKey });
      const hold = channel ? (await cooldownBadges(req.session, [b.candidateId]))[b.candidateId] || null : null;
      return res.json({
        verdict: v, availability, doNotContact: !!seen.do_not_contact,
        cooldown: hold ? { holder: hold, days: await cooldownDays(req.session), canOverride: canOverride(req.session) } : null,
      });
    }

    if (seen.do_not_contact && b.action !== 'add_to_job') {
      throw new ApiError(409, 'DO_NOT_CONTACT', 'This candidate has asked not to be contacted.');
    }
    const v = await requireEngage(req.session, b.candidateId, {
      jobId: b.jobId, roleKey: b.roleKey, action: b.action, acknowledge: b.acknowledge === true,
    });

    /* 0118: the cooldown. Recording (or an override) is the gate and the log
       row in one transaction; merely asking is a read, refused the same way. */
    let contactId = null;
    const source = ACTION_SOURCE[b.action];
    if (channel && (b.record || b.override)) {
      const began = await beginContact(req.session, {
        candidateId: b.candidateId, channel, jobId: b.jobId || null, source: channel,
        override: b.override === true, reason: b.overrideReason || null,
      });
      contactId = began.id;
    } else if (channel) {
      const hold = (await cooldownBadges(req.session, [b.candidateId]))[b.candidateId];
      if (hold) {
        throw new ApiError(409, 'CONTACT_COOLDOWN', `${hold.name} already contacted this candidate.`,
          { holder: hold, cooldownDays: await cooldownDays(req.session), canOverride: canOverride(req.session) });
      }
    } else if (b.record && source) {
      contactId = await recordContact(req.session, {
        candidateId: b.candidateId, jobId: b.jobId, roleKey: b.roleKey,
        channel: source, source, outcome: 'opened',
      });
    }
    res.json({ verdict: v, availability, contactId });
  }));

  /* ------------------------------------------------------------------ *
   * a contact that left from the browser (the Find Candidates email /
   * WhatsApp / SMS buttons, wa.me): write it down. A held candidate is
   * refused here as everywhere else; "contact anyway" was already
   * recorded when the recruiter chose to include them.
   * ------------------------------------------------------------------ */
  r.post('/engagement/record', requireAuth(), requireRole(...STAFF), wrap(async (req, res) => {
    const b = parse(z.object({
      candidateId: z.string().trim().min(1).max(64),
      jobId: z.string().trim().max(64).optional(),
      channel: z.enum(['whatsapp', 'sms', 'email', 'phone']),
      outcome: z.enum(['sent', 'opened', 'failed']).default('sent'),
      /* 0118: the row the check wrote for this very send. */
      contactId: z.number().int().positive().optional(),
    }), req.body);
    if (b.contactId) {
      await finishContact(req.session, b.contactId, b.outcome);
      return res.status(200).json({ contactId: b.contactId });
    }
    const v = await canEngage(req.session, b.candidateId, { jobId: b.jobId });
    if (v.decision === 'blocked') {
      await audit(req.session, { candidateId: b.candidateId, roleKey: v.roleKey, jobId: b.jobId || null,
        action: 'blocked', detail: { action: b.channel, reason: v.reason } });
      throw new ApiError(409, 'ENGAGEMENT_BLOCKED', v.message || 'Another recruiter holds this candidate.',
        { engagement: v });
    }
    /* No row from a check: this is a contact being written down now, so it
       goes through the cooldown like any other. */
    const began = await beginContact(req.session, {
      candidateId: b.candidateId, channel: b.channel, jobId: b.jobId || null, source: b.channel,
    });
    await finishContact(req.session, began.id, b.outcome);
    res.status(201).json({ contactId: began.id });
  }));

  /* ------------------------------------------------------------------ *
   * Log call
   * ------------------------------------------------------------------ */
  r.post('/candidates/:id/call-log', requireAuth(), requireRole('recruiter', 'admin'),
    wrap(async (req, res) => {
      const b = parse(z.object({
        outcome: z.enum(Object.keys(CALL_OUTCOMES)),
        jobId: z.string().trim().max(64).optional(),
        note: z.string().trim().max(4000).optional(),
        noteVisibility: z.enum(['private', 'team']).optional(),
        acknowledge: z.boolean().optional(),
      }), req.body);

      const cand = await withUser(req.session, async (c) => (await c.query(
        `select id from candidates where id = $1`, [req.params.id])).rows[0]);
      if (!cand) throw notFound('That candidate could not be found.');
      if (b.jobId) {
        const job = await withUser(req.session, async (c) => (await c.query(
          `select id from jobs where id = $1`, [b.jobId])).rows[0]);
        if (!job) throw notFound('That requirement could not be found.');
      }

      const v = await requireEngage(req.session, req.params.id, {
        jobId: b.jobId, action: 'call', acknowledge: b.acknowledge === true,
      });

      const contactId = await withUser(req.session, async (c) => (await c.query(
        `select engagement_record($1,$2,null,'phone','phone',$3,null,null) as id`,
        [req.params.id, b.jobId || null, b.outcome])).rows[0].id);

      /* The note is a comment, never the history's detail: the history is
         summarised for other recruiters and a note must not travel there. */
      let comment = null;
      if (b.note && req.session.role === 'recruiter') {
        comment = await withUser(req.session, async (c) => (await c.query(
          `insert into candidate_comments (candidate_id, recruiter_id, tag, body, visibility)
           values ($1,$2,$3,$4,$5) returning id, tag, body, visibility, created_at`,
          [req.params.id, req.session.profileId, `Call: ${CALL_OUTCOMES[b.outcome]}`,
           b.note, b.noteVisibility || 'private'])).rows[0]);
      }
      res.status(201).json({ contactId: contactId != null ? Number(contactId) : null,
                             outcome: b.outcome, verdict: v, comment });
    }));

  /* ------------------------------------------------------------------ *
   * Message <holder>
   * ------------------------------------------------------------------ */
  r.post('/engagement/message-holder', requireAuth(), requireRole('recruiter', 'admin'),
    wrap(async (req, res) => {
      const b = parse(z.object({
        candidateId: z.string().trim().min(1).max(64),
        recruiterId: z.string().trim().min(1).max(64),
        jobId: z.string().trim().max(64).optional(),
        message: z.string().trim().min(2, 'Write a short message.').max(1000),
      }), req.body);
      if (req.session.role === 'recruiter' && b.recruiterId === req.session.profileId) {
        throw badRequest('That is you.');
      }
      const out = await withUser(req.session, async (c) => {
        const cand = (await c.query(`select id, name from candidates where id = $1`, [b.candidateId])).rows[0];
        if (!cand) return null;
        /* Only to somebody who actually has an engagement with this
           person - not a way to message any recruiter about anybody. */
        const eng = (await c.query(`select recruiter_name, role_key, job_title from candidate_engagements($1, $2)
                                      where recruiter_id = $3 limit 1`,
          [b.candidateId, b.jobId || null, b.recruiterId])).rows[0];
        if (!eng) return { cand, eng: null };
        const me = req.session.role === 'recruiter'
          ? (await c.query(`select name from recruiters where id = $1`, [req.session.profileId])).rows[0]
          : null;
        const sender = (me && me.name) || 'An administrator';
        const ref = newId('msg');
        await notify(c, {
          recipientId: b.recruiterId, role: 'recruiter', type: 'ENGAGEMENT_MESSAGE',
          title: `${sender} about ${cand.name}`,
          message: b.message, candidateId: b.candidateId, ref,
          meta: { from: req.session.profileId || null, fromName: sender,
                  roleKey: eng.role_key, jobTitle: eng.job_title },
        });
        return { cand, eng, ref };
      });
      if (!out) throw notFound('That candidate could not be found.');
      if (!out.eng) throw badRequest('That recruiter is not working with this candidate.');
      await audit(req.session, { candidateId: b.candidateId, roleKey: out.eng.role_key, jobId: b.jobId || null,
        action: 'message_holder', detail: { to: b.recruiterId } });
      res.status(201).json({ sent: true, inApp: true, to: out.eng.recruiter_name });
    }));

  /* ------------------------------------------------------------------ *
   * overrides
   * ------------------------------------------------------------------ */
  r.post('/engagement/overrides', requireAuth(), requireRole('recruiter', 'admin'),
    wrap(async (req, res) => {
      const b = parse(z.object({
        candidateId: z.string().trim().min(1).max(64),
        jobId: z.string().trim().max(64).optional(),
        roleKey: z.string().trim().max(160).optional(),
        kind: z.enum(['hold', 'placed', 'duplicate_submission']).default('hold'),
        reason: z.string().trim().min(3, 'Say why - the administrator decides on this.').max(1000),
      }), req.body);
      if (b.kind === 'duplicate_submission' && req.session.role !== 'admin') {
        throw forbidden('A second submission to the same client needs an administrator.');
      }

      /* Read before the transaction below opens: a second connection
         inside it waits for the first on the embedded database (one
         session at a time) until the statement timeout. */
      const admins = req.session.role === 'admin' ? [] : await adminIds();
      const out = await withUser(req.session, async (c) => {
        const cand = (await c.query(`select id, name from candidates where id = $1`, [b.candidateId])).rows[0];
        if (!cand) return null;
        const id = (await c.query(`select engagement_override_request($1,$2,$3,$4,$5) as id`,
          [b.candidateId, b.jobId || null, b.roleKey || null, b.kind, b.reason])).rows[0].id;
        /* An administrator's own override is the decision: approved, with
           the same reason, logged twice (asked, approved). */
        if (req.session.role === 'admin') {
          await c.query(`select * from engagement_override_decide($1, true, $2)`, [id, b.reason]);
        } else {
          const me = (await c.query(`select name from recruiters where id = $1`, [req.session.profileId])).rows[0];
          for (const adminId of admins) {
            await notify(c, {
              recipientId: adminId, role: 'admin', type: 'ENGAGEMENT_OVERRIDE_REQUEST',
              title: `Override requested: ${cand.name}`,
              message: `${(me && me.name) || 'A recruiter'} asks to work ${cand.name}: ${b.reason}`,
              candidateId: b.candidateId, ref: `ovr_${id}`, meta: { overrideId: Number(id) },
            });
          }
        }
        return (await c.query(
          `select o.*, c.name as candidate_name from engagement_overrides o
             left join candidates c on c.id = o.candidate_id where o.id = $1`, [id])).rows[0];
      });
      if (!out) throw notFound('That candidate could not be found.');
      res.status(201).json({ override: shapeOverride(out) });
    }));

  r.get('/engagement/overrides', requireAuth(), requireRole('recruiter', 'admin'),
    wrap(async (req, res) => {
      const status = ['pending', 'approved', 'denied'].includes(req.query.status) ? req.query.status : null;
      const rows = await withUser(req.session, async (c) => (await c.query(
        `select o.*, c.name as candidate_name, j.title as job_title, r.name as requester_name
           from engagement_overrides o
           left join candidates c on c.id = o.candidate_id
           left join jobs j on j.id = o.job_id
           left join recruiters r on r.id = o.requester_recruiter_id
          where ($1::text is null or o.status = $1)
          order by (o.status = 'pending') desc, o.created_at desc
          limit 200`, [status])).rows);
      res.json({ overrides: rows.map(shapeOverride) });
    }));

  r.post('/engagement/overrides/:id/decide', requireAuth(), requireRole('admin'),
    wrap(async (req, res) => {
      const b = parse(z.object({
        approve: z.boolean(),
        reason: z.string().trim().min(3, 'A decision needs a reason.').max(1000),
        days: z.number().int().min(1).max(90).optional(),
      }), req.body);
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id < 1) throw notFound('That request could not be found.');

      const out = await withUser(req.session, async (c) => {
        const d = (await c.query(`select * from engagement_override_decide($1,$2,$3,$4)`,
          [id, b.approve, b.reason, b.days || 30])).rows[0];
        if (!d || d.id == null) return null;
        const cand = (await c.query(`select name from candidates where id = $1`, [d.candidate_id])).rows[0];
        if (d.requester_recruiter_id) {
          await notify(c, {
            recipientId: d.requester_recruiter_id, role: 'recruiter', type: 'ENGAGEMENT_OVERRIDE_DECIDED',
            title: `Override ${b.approve ? 'approved' : 'denied'}: ${cand ? cand.name : 'candidate'}`,
            message: b.reason, candidateId: d.candidate_id, ref: `ovrd_${d.id}`,
            meta: { overrideId: Number(d.id), approved: b.approve },
          });
        }
        return d;
      });
      if (!out) throw new ApiError(409, 'ALREADY_DECIDED', 'That request was already decided, or does not exist.');
      res.json({ override: shapeOverride(out) });
    }));

  r.get('/engagement/conflicts', requireAuth(), requireRole('admin'), wrap(async (req, res) => {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 90, 1), 365);
    const rows = await withUser(req.session, async (c) => (await c.query(
      `select * from engagement_conflicts($1)`, [days])).rows);
    res.json({
      days,
      conflicts: rows.map((x) => ({
        candidateId: x.candidate_id,
        candidateName: x.candidate_name,
        roleKey: x.role_key,
        jobTitles: x.job_titles || [],
        recruiters: x.recruiters || [],
        recruiterCount: x.recruiter_count,
        lastAt: iso(x.last_at),
        contactAnyway: x.contact_anyway,
        overrides: x.overrides,
      })),
    });
  }));

  return r;
}

/**
 * Records 'blocked' / 'duplicate_blocked' for a refusal the DATABASE
 * made (a trigger on applications or ai_call_sessions). The refusal
 * rolled back its own transaction, audit row included, so it is written
 * here, in a fresh one. Mounted just before the error handler.
 */
export function engagementRefusalAudit() {
  return (err, req, _res, next) => {
    try {
      const code = err && (err.code === 'TLB01' || err.code === 'TLD01') ? err.code : null;
      if (code && req.session && STAFF.includes(req.session.role)) {
        let d = {};
        try { d = JSON.parse(err.detail || '{}'); } catch { d = {}; }
        const candidateId = (req.body && req.body.candidateId) || null;
        if (candidateId || d.candidateId) {
          audit(req.session, {
            candidateId: candidateId || d.candidateId, roleKey: d.roleKey || null,
            jobId: (req.body && req.body.jobId) || null,
            action: code === 'TLB01' ? 'blocked' : 'duplicate_blocked',
            detail: { path: req.path, reason: d.reason || null, holder: d.holderName || d.firstRecruiter || null },
          }).catch(() => {});
        }
      }
    } catch { /* never in the way of the response */ }
    next(err);
  };
}
