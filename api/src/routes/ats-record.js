/**
 * The candidate's application tracker and dashboard, and the ATS
 * candidate record, timeline, matching, referrals, assessments, audit
 * log, portal analytics and the employee hand-off queue (0111).
 *
 * CANDIDATE (own data only - RLS on every table decides that)
 *   GET  /api/candidate/dashboard                 counts + tracker + widgets (spec 25/32)
 *   GET  /api/candidate/applications/history      paginated, searchable (spec 46/53)
 *   GET  /api/candidate/interviews/schedule       interviews + walk-in interviews (spec 26)
 *   GET  /api/candidate/referral                  their optional referral code and its status (38)
 *   POST /api/candidate/referral/claim            "I came through this code" (optional, once)
 *   GET  /api/candidate/assessments               read-only results (33)
 *
 * STAFF
 *   GET  /api/ats/candidates/:id/record           the ATS candidate record (35/36/37/48)
 *   POST /api/ats/candidates/:id/assessments      record a result from an external test (33)
 *   PUT  /api/ats/assessments/:id
 *   POST /api/ats/candidates/:id/referral         record who referred this candidate (38)
 *   PUT  /api/ats/referrals/:id                   status / optional reward
 *
 * ADMIN
 *   GET  /api/admin/audit-log                     (39)
 *   GET  /api/admin/portal-analytics              (43/44) aggregates only
 *   GET  /api/admin/employee-handoffs             (51) the queue, read-only
 *
 * PUBLIC
 *   POST /api/jobs/:id/view                       one anonymous view count (43)
 *
 * NOTHING HERE CHANGES A STAGE, A SCORE OR A DECISION. The candidate
 * endpoints read; the staff endpoints record assessments and referrals.
 * No AI score rejects anybody (the AI screen only ever shortlists - see
 * ai/screening.js - and the screening knock-out reject runs only on jobs
 * whose recruiter switched it on).
 */
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { withUser } from '../db.js';
import { requireAuth, requireRole } from '../auth.js';
import { wrap, badRequest, notFound, ApiError } from '../errors.js';
import { toJob, toCandidate } from '../shapes.js';
import { matchCandidate } from '../ai/match.js';
import { profileScore, profileScoresFor } from '../candidates/profile-score.js';
import { ACTIVITY } from '../audit/recruiter-activity.js';
import { istDate, istDay } from '../applied-date.js';

const ENGINE = { userId: '', role: 'admin', profileId: null };
const iso = (d) => (d ? new Date(d).toISOString() : null);
const day = (d) => (d == null ? null : (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)));
const STAFF = ['recruiter', 'bde', 'admin'];

/* ------------------------------------------------------------------ *
 * the tracker
 * ------------------------------------------------------------------ */
async function loadPhases(c) {
  const phases = (await c.query(`select id, label, timeline_label, sort_order, on_line from tracker_phases order by sort_order`)).rows;
  const stages = (await c.query(
    `select id, label, coalesce(tracker_phase, 'under_review') phase, stage_label(id, 'candidate') cand_label from stages`)).rows;
  return {
    phases,
    line: phases.filter((p) => p.on_line).map((p) => p.id),
    phaseOf: new Map(stages.map((s) => [s.id, s.phase])),
    candLabel: new Map(stages.map((s) => [s.id, s.cand_label])),
    intLabel: new Map(stages.map((s) => [s.id, s.label])),
    label: new Map(phases.map((p) => [p.id, p.label])),
    stepLabel: new Map(phases.map((p) => [p.id, p.timeline_label])),
  };
}

/** The rail for one application: Applied -> HR Review -> ... -> Hired. */
function trackerFor(P, stage, hist) {
  const phase = P.phaseOf.get(stage) || 'under_review';
  const reachedAt = {};
  for (const h of hist) {
    const ph = P.phaseOf.get(h.to_stage);
    if (ph && !reachedAt[ph]) reachedAt[ph] = iso(h.created_at);
  }
  let here = P.line.indexOf(phase);
  if (here < 0) {             // Rejected / On Hold: as far as it actually got
    here = 0;
    P.line.forEach((p, i) => { if (reachedAt[p]) here = i; });
  }
  const off = P.line.indexOf(phase) < 0;
  return {
    phase,
    status: P.label.get(phase) || phase,
    steps: P.line.map((p, i) => ({
      phase: p,
      label: P.stepLabel.get(p),
      /* Where it IS decides the rail: a step reached and then moved back
         from (a recruiter set it back) is not shown as done ahead of it. */
      state: (!off && i === here) ? 'current' : (i < here || (off && i === here)) ? 'done' : 'todo',
      at: reachedAt[p] || null,
    })),
    offLine: off ? { phase, label: P.label.get(phase), at: reachedAt[phase] || null } : null,
  };
}

/* An interview for the candidate: never the score, feedback or interviewer notes. */
function interviewRow(r, rescheduledJobs) {
  if (r.kind === 'walkin') {
    const past = r.date && r.date < new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
    const state = r.stage === 'no_show' ? 'Missed'
      : (['attended', 'interviewed', 'selected', 'rejected', 'joined'].includes(r.stage) || past) ? 'Completed'
      : (r.job_status !== 'open' || r.archived) ? 'Cancelled'
      : (rescheduledJobs.has(r.job_id) ? 'Rescheduled' : 'Scheduled');
    return {
      id: 'walkin:' + r.application_id, kind: 'walkin', applicationId: r.application_id, jobId: r.job_id,
      jobTitle: r.job_title, company: r.company_name, round: 'Walk-in interview',
      date: r.date, time: [r.wfrom, r.wto].filter(Boolean).join(' - ') || null,
      mode: 'Walk-in', venue: [r.venue, r.address].filter(Boolean).join(', ') || null,
      state, upcoming: state === 'Scheduled' || state === 'Rescheduled',
    };
  }
  const state = r.state;
  return {
    id: r.id, kind: 'interview', applicationId: r.application_id, jobId: r.job_id,
    jobTitle: r.job_title, company: r.company_name, round: r.type || 'Interview',
    date: day(r.scheduled_date), time: r.scheduled_time || null,
    mode: r.mode_label, venue: r.location_type === 'phone' ? null
      : (r.venue_address || (r.mode_label === 'Online' ? 'Online meeting' : null)),
    state, upcoming: (state === 'Scheduled' || state === 'Rescheduled')
      && (!r.scheduled_date || day(r.scheduled_date) >= new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10)),
  };
}

async function candidateInterviews(session) {
  const rows = await withUser(session, async (c) => {
    const iv = (await c.query(
      `select i.id, i.application_id, i.job_id, i.type, i.scheduled_date, i.scheduled_time, i.location_type,
              i.venue_address, interview_state(i.status, i.reschedule_count) state,
              interview_mode_label(i.location_type, i.mode, j.posting_kind) mode_label,
              j.title job_title, co.name company_name
         from interviews i join jobs j on j.id = i.job_id left join companies co on co.id = j.company_id
        where i.candidate_id = $1
        order by i.scheduled_date nulls last, i.scheduled_time`, [session.profileId])).rows;
    const wk = (await c.query(
      `select 'walkin' kind, a.id application_id, a.job_id, a.stage, j.title job_title, co.name company_name,
              j.walkin_date date, j.walkin_from wfrom, j.walkin_to wto, j.walkin_venue venue, j.walkin_address address,
              j.status job_status, j.archived
         from applications a join jobs j on j.id = a.job_id left join companies co on co.id = j.company_id
        where a.candidate_id = $1 and coalesce(a.posting_type, j.posting_kind) = 'walkin'
        order by j.walkin_date nulls last`, [session.profileId])).rows;
    return { iv, wk };
  });
  const jobIds = [...new Set(rows.wk.map((r) => r.job_id))];
  const resched = jobIds.length ? await withUser(ENGINE, async (c) => new Set((await c.query(
    `select distinct job_id from walkin_reschedules
      where job_id = any($1::text[]) and status <> 'cancelled'
        and changed_fields && array['walkin_date','walkin_from','walkin_to','walkin_venue','walkin_address']`,
    [jobIds])).rows.map((r) => r.job_id))) : new Set();
  return rows.iv.map((r) => interviewRow(r, resched)).concat(rows.wk.map((r) => interviewRow(r, resched)))
    .sort((a, b) => String(a.date || '9999').localeCompare(String(b.date || '9999')));
}

/** Every application of the signed-in candidate, with its tracker. */
async function candidateApplications(session) {
  return withUser(session, async (c) => {
    const P = await loadPhases(c);
    const apps = (await c.query(
      `select a.id, a.reference, a.job_id, a.stage, a.applied_at, a.updated_at,
              coalesce(a.posting_type, j.posting_kind, 'job') job_type, a.source_channel,
              j.title job_title, co.name company_name
         from applications a join jobs j on j.id = a.job_id left join companies co on co.id = j.company_id
        where a.candidate_id = $1
        order by a.applied_at desc`, [session.profileId])).rows;
    const hist = apps.length ? (await c.query(
      `select application_id, to_stage, created_at from application_stage_history
        where application_id = any($1::text[]) order by created_at, id`, [apps.map((a) => a.id)])).rows : [];
    const byApp = new Map();
    for (const h of hist) { if (!byApp.has(h.application_id)) byApp.set(h.application_id, []); byApp.get(h.application_id).push(h); }
    return {
      P,
      apps: apps.map((a) => {
        const h = byApp.get(a.id) || [];
        const last = h.length ? h[h.length - 1].created_at : null;
        return {
          applicationId: a.id, reference: a.reference || null, jobId: a.job_id,
          jobTitle: a.job_title, company: a.company_name || null,
          appliedAt: iso(a.applied_at), jobType: a.job_type === 'walkin' ? 'Walk-in' : (a.job_type === 'internship' ? 'Internship' : 'Regular'),
          stageLabel: P.candLabel.get(a.stage) || a.stage,
          lastUpdated: iso(last && new Date(last) > new Date(a.updated_at) ? last : a.updated_at),
          ...trackerFor(P, a.stage, h),
        };
      }),
    };
  });
}

const viewLimiter = rateLimit({
  windowMs: 60_000, max: Number(process.env.JOB_VIEW_RATE_MAX || 120),
  standardHeaders: true, legacyHeaders: false, validate: false,
  handler: (_q, res) => res.status(204).end(),   // a dropped count, never an error on the page
});

export const ACTIONS = {
  'candidate.created': 'Candidate Created', 'candidate.updated': 'Candidate Updated', 'candidate.deleted': 'Candidate Deleted',
  'resume.uploaded': 'Resume Uploaded', 'resume.changed': 'Resume Changed',
  'application.submitted': 'Application Submitted', 'application.updated': 'Application Updated',
  'status.changed': 'Status Changed',
  'interview.scheduled': 'Interview Scheduled', 'interview.rescheduled': 'Interview Rescheduled',
  'interview.status_changed': 'Interview Status Changed',
  'document.uploaded': 'Document Uploaded', 'document.updated': 'Document Updated', 'document.deleted': 'Document Deleted',
  'candidate.source_changed': 'Source Changed', 'candidate.source_seen': 'Source Noted',
  'staff.client_login_created': 'Client Login Created',
  /* 0118: teams, logins and the contact cooldown */
  RECRUITER_ASSIGNED: 'Recruiter Assigned to Team Lead', RECRUITER_REASSIGNED: 'Recruiter Reassigned',
  RECRUITER_UNASSIGNED: 'Recruiter Removed from Team', RECRUITER_DEPARTMENT_CHANGED: 'Department Changed',
  RECRUITER_EMAIL_CHANGED: 'Recruiter Email Changed', RECRUITER_STATUS_CHANGED: 'Recruiter Status Changed',
  TL_ROLE_CHANGED: 'Team Lead Role Changed', CONTACT_COOLDOWN_OVERRIDDEN: 'Contact Cooldown Overridden',
  CONTACT_COOLDOWN_CHANGED: 'Contact Cooldown Setting Changed', AUDIT_LOG_EXPORTED: 'Audit Log Exported',
  /* 0091 / 0119: who was allowed or refused contact with a candidate */
  'contact.contact_anyway': 'Contact Anyway', 'contact.blocked': 'Contact Blocked',
  'contact.duplicate_blocked': 'Duplicate Submission Blocked', 'contact.message_holder': 'Messaged the Holder',
  'contact.override_requested': 'Override Requested', 'contact.override_approved': 'Override Approved',
  'contact.override_denied': 'Override Denied', 'contact.override_used': 'Override Used',
};
/* 0125: sign-in, sign-out and job lifecycle rows, named the same here. */
for (const a of ACTIVITY) if (!ACTIONS[a.code]) ACTIONS[a.code] = a.label;
const ENTITIES = ['candidate', 'application', 'recruiter', 'setting', 'interview', 'document', 'job', 'session'];

/* The filters of the audit page, as SQL over admin_audit_events (alias e) and users (alias u). */
function auditFilters(q) {
  const where = []; const vals = [];
  const add = (sql, v) => { vals.push(v); where.push(sql.replace(/\$\$/g, `$${vals.length}`)); };
  const action = String(q.action || '').trim();
  if (action) add('e.action = $$', action);
  const entity = String(q.entity || '').trim();
  if (entity) add('e.entity = $$', entity);
  const entityId = String(q.entityId || '').trim();
  if (entityId) add('e.entity_id = $$', entityId);
  const role = String(q.actorRole || '').trim();
  if (role) add('e.actor_role = $$', role);
  /* Dates are India dates, both ends inclusive. */
  const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : '');
  const from = day(q.from); const to = day(q.to);
  if (from) add(`e.at >= ($$::date::timestamp at time zone 'Asia/Kolkata')`, from);
  if (to) add(`e.at < (($$::date + 1)::timestamp at time zone 'Asia/Kolkata')`, to);
  const text = String(q.q || '').trim().slice(0, 80);
  if (text) {
    vals.push(`%${text}%`);
    const n = vals.length;
    where.push(`(e.entity_id ilike $${n} or u.email ilike $${n} or e.action ilike $${n} or e.detail::text ilike $${n})`);
  }
  return { w: where.length ? 'where ' + where.join(' and ') : '', vals };
}
const AUDIT_FROM = `admin_audit_events e left join users u on u.id = e.actor_user_id`;

/* Names for the ids a row mentions, so the page can say who and what rather than ids. */
async function auditNames(c, rows) {
  const want = { recruiter: new Set(), candidate: new Set(), job: new Set() };
  const take = (kind, id) => { if (id && typeof id === 'string' && want[kind]) want[kind].add(id); };
  for (const x of rows) {
    take(x.entity, x.entity_id);
    const d = x.detail || {};
    ['recruiterId', 'oldTlId', 'newTlId', 'previousBy'].forEach((k) => take('recruiter', d[k]));
    take('candidate', d.candidateId); take('job', d.jobId);
  }
  const names = {};
  const grab = async (kind, sql) => {
    const ids = [...want[kind]].slice(0, 400);
    if (!ids.length) return;
    for (const r of (await c.query(sql, [ids])).rows) names[`${kind}:${r.id}`] = r.name;
  };
  await grab('recruiter', `select id, name from recruiters where id = any($1)`);
  await grab('candidate', `select id, name from candidates where id = any($1)`);
  await grab('job', `select id, title as name from jobs where id = any($1)`);
  /* the person who did it: a recruiter's or an admin's own name */
  const uids = [...new Set(rows.map((x) => x.actor_user_id).filter(Boolean))];
  if (uids.length) {
    for (const r of (await c.query(
      `select user_id as id, name from recruiters where user_id = any($1)
       union all select user_id, name from admins where user_id = any($1)`, [uids])).rows) names[`user:${r.id}`] = r.name;
  }
  return names;
}
const csvCell = (v) => {
  const t = v == null ? '' : String(v);
  return /^[=+\-@\t\r]/.test(t) ? `"'${t.replace(/"/g, '""')}"` : (/[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t);
};

const pageOf = (q, max = 100) => {
  const pageSize = Math.min(Math.max(parseInt(q.pageSize, 10) || 20, 1), max);
  const page = Math.max(parseInt(q.page, 10) || 1, 1);
  return { page, pageSize, offset: (page - 1) * pageSize };
};

export default function atsRecordRoutes() {
  const r = Router();

  /* ================= candidate ================= */

  r.get('/candidate/dashboard', requireAuth(), requireRole('candidate'), wrap(async (req, res) => {
    const s = req.session;
    const { P, apps } = await candidateApplications(s);
    const ivs = await candidateInterviews(s);
    const extra = await withUser(s, async (c) => ({
      saved: (await c.query(`select count(*)::int n from saved_jobs where candidate_id = $1`, [s.profileId])).rows[0].n,
      unread: (await c.query(
        `select count(*)::int n from notifications where recipient_role = 'candidate' and recipient_id = $1 and not read`,
        [s.profileId])).rows[0].n,
      latest: (await c.query(
        `select id, title, message, read, created_at from notifications
          where recipient_role = 'candidate' and recipient_id = $1 order by created_at desc limit 5`, [s.profileId])).rows,
      score: (await profileScoresFor(c, [s.profileId])).get(s.profileId) || profileScore(null),
    }));
    const byPhase = Object.fromEntries(P.phases.map((p) => [p.id, 0]));
    apps.forEach((a) => { byPhase[a.phase] = (byPhase[a.phase] || 0) + 1; });
    const SHORT = new Set(['shortlisted', 'interview', 'offer', 'hired']);
    const upcoming = ivs.filter((i) => i.upcoming);
    res.json({
      counts: {
        applications: apps.length,
        shortlisted: apps.filter((a) => SHORT.has(a.phase)).length,
        interviews: upcoming.length,
        savedJobs: extra.saved,
        profileStrength: extra.score.percent,
      },
      profile: extra.score,
      tracker: {
        phases: P.phases.map((p) => ({ id: p.id, label: p.label, step: p.timeline_label, onLine: p.on_line, count: byPhase[p.id] || 0 })),
      },
      recentApplications: apps.slice(0, 3),
      upcomingInterviews: upcoming.slice(0, 3),
      notifications: {
        unread: extra.unread,
        latest: extra.latest.map((n) => ({ id: n.id, title: n.title, message: n.message, read: !!n.read, at: iso(n.created_at) })),
      },
    });
  }));

  r.get('/candidate/applications/history', requireAuth(), requireRole('candidate'), wrap(async (req, res) => {
    const { page, pageSize, offset } = pageOf(req.query, 50);
    const q = String(req.query.q || '').trim().toLowerCase().slice(0, 80);
    const phase = String(req.query.phase || '').trim();
    const { apps } = await candidateApplications(req.session);
    const ivs = await candidateInterviews(req.session);
    const nextIv = new Map();
    for (const i of ivs) {
      if (!i.applicationId) continue;
      const cur = nextIv.get(i.applicationId);
      if (!cur || (i.upcoming && !cur.upcoming)) nextIv.set(i.applicationId, i);
    }
    let rows = apps;
    if (q) rows = rows.filter((a) => [a.jobTitle, a.company, a.reference, a.status, a.jobType].some((v) => String(v || '').toLowerCase().includes(q)));
    if (phase) rows = rows.filter((a) => a.phase === phase);
    /* 0130: Applied Date (India days, both ends inclusive) and the order:
       latest applied first unless asked for the oldest. */
    const from = istDay(req.query.from); const to = istDay(req.query.to);
    const indiaDay = (at) => new Date(new Date(at).getTime() + 330 * 60000).toISOString().slice(0, 10);
    if (from) rows = rows.filter((a) => a.appliedAt && indiaDay(a.appliedAt) >= from);
    if (to) rows = rows.filter((a) => a.appliedAt && indiaDay(a.appliedAt) <= to);
    if (req.query.sort === 'oldest') rows = rows.slice().reverse();
    res.json({
      total: rows.length, page, pageSize,
      rows: rows.slice(offset, offset + pageSize).map((a) => ({ ...a, interview: nextIv.get(a.applicationId) || null })),
    });
  }));

  r.get('/candidate/interviews/schedule', requireAuth(), requireRole('candidate'), wrap(async (req, res) => {
    const list = await candidateInterviews(req.session);
    res.json({ interviews: list, upcoming: list.filter((i) => i.upcoming).length });
  }));

  r.get('/candidate/referral', requireAuth(), requireRole('candidate'), wrap(async (req, res) => {
    const out = await withUser(req.session, async (c) => ({
      code: (await c.query(`select referral_code_for($1) code`, [req.session.profileId])).rows[0].code,
      made: (await c.query(
        `select id, referred_at, status from candidate_referrals where referrer_candidate_id = $1 order by referred_at desc limit 50`,
        [req.session.profileId])).rows,
    }));
    /* Who they referred is not shown back by name: the referrer reads that
       a referral exists and how far it got, nothing about the person. */
    res.json({
      code: out.code,
      referrals: out.made.map((x) => ({ id: String(x.id), referredAt: iso(x.referred_at), status: x.status })),
    });
  }));

  r.post('/candidate/referral/claim', requireAuth(), requireRole('candidate'), wrap(async (req, res) => {
    const b = z.object({ code: z.string().trim().min(3).max(20) }).strict().safeParse(req.body || {});
    if (!b.success) throw badRequest('That referral code could not be read.');
    const result = await withUser(req.session, async (c) =>
      (await c.query(`select referral_claim($1) r`, [b.data.code])).rows[0].r);
    res.json({ result });
  }));

  r.get('/candidate/assessments', requireAuth(), requireRole('candidate'), wrap(async (req, res) => {
    const rows = await withUser(req.session, async (c) => (await c.query(
      `select id, name, category, score, max_score, assessed_on, status from candidate_assessments
        where candidate_id = $1 order by assessed_on desc nulls last, id desc`, [req.session.profileId])).rows);
    res.json({ assessments: rows.map(assessmentOut) });
  }));

  /* ================= staff: the ATS candidate record ================= */

  r.get('/ats/candidates/:id/record', requireAuth(), requireRole(...STAFF), wrap(async (req, res) => {
    const id = String(req.params.id);
    const out = await withUser(req.session, async (c) => {
      const row = (await c.query(`select * from candidates where id = $1`, [id])).rows[0];
      if (!row) return null;
      const P = await loadPhases(c);
      const score = (await profileScoresFor(c, [id])).get(id);
      const resume = (await c.query(
        `select total_score, label, scored_at from candidate_resume_score_visible_v where candidate_id = $1`, [id])).rows[0] || null;
      const apps = (await c.query(
        `select a.*, j.title job_title, j.posting_kind, co.name company_name
           from applications a join jobs j on j.id = a.job_id left join companies co on co.id = j.company_id
          where a.candidate_id = $1 order by a.applied_at desc`, [id])).rows;
      const jobs = apps.length ? (await c.query(`select * from jobs where id = any($1::text[])`, [apps.map((a) => a.job_id)])).rows : [];
      const hist = apps.length ? (await c.query(
        `select h.application_id, h.from_stage, h.to_stage, h.created_at, h.reason, h.is_override
           from application_stage_history h where h.application_id = any($1::text[]) order by h.created_at, h.id`,
        [apps.map((a) => a.id)])).rows : [];
      const ivs = (await c.query(
        `select i.id, i.application_id, i.job_id, i.type, i.scheduled_date, i.scheduled_time, i.status,
                interview_state(i.status, i.reschedule_count) state, i.reschedule_count, i.rescheduled_at,
                i.completed_at, i.cancelled_at, i.created_at, i.interviewer, i.ai_score,
                interview_mode_label(i.location_type, i.mode, j.posting_kind) mode_label, i.venue_address, j.title job_title
           from interviews i join jobs j on j.id = i.job_id where i.candidate_id = $1
          order by i.scheduled_date desc nulls last`, [id])).rows;
      const offers = (await c.query(
        `select id, application_id, status, extended_at, responded_at from offers where candidate_id = $1`, [id])).rows;
      const assessments = (await c.query(
        `select * from candidate_assessments where candidate_id = $1 order by assessed_on desc nulls last, id desc`, [id])).rows;
      const referral = (await c.query(
        `select r.*, rc.name referrer_name, rc.candidate_code referrer_code
           from candidate_referrals r left join candidates rc on rc.id = r.referrer_candidate_id
          where r.referred_candidate_id = $1`, [id])).rows[0] || null;
      const referredOthers = (await c.query(
        `select count(*)::int n from candidate_referrals where referrer_candidate_id = $1`, [id])).rows[0].n;
      const handoffs = req.session.role === 'admin' ? (await c.query(
        `select application_id, status, trigger_stage, created_at from employee_handoffs where candidate_id = $1`, [id])).rows : [];
      return { row, P, score, resume, apps, jobs, hist, ivs, offers, assessments, referral, referredOthers, handoffs };
    });
    if (!out) throw notFound('That candidate could not be found.');

    /* Profile edits and resume uploads live in the audit log, which only an
       administrator can browse; the record shows this candidate's own rows
       to staff who can already see the candidate (checked just above). */
    const audit = await withUser(ENGINE, async (c) => (await c.query(
      `select action, detail, created_at from audit_log
        where entity = 'candidate' and entity_id = $1
          and action in ('candidate.updated','resume.uploaded','resume.changed','document.uploaded','document.updated')
        order by created_at desc limit 60`, [id])).rows);

    const { row, P } = out;
    const cand = toCandidate(row, { staff: true });
    const jobById = new Map(out.jobs.map((j) => [j.id, j]));
    const histBy = new Map();
    out.hist.forEach((h) => { if (!histBy.has(h.application_id)) histBy.set(h.application_id, []); histBy.get(h.application_id).push(h); });
    /* The current stage: the open application that moved most recently. */
    const byRecent = out.apps.slice().sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
    const currentApp = byRecent.find((a) => !['rejected', 'joined', 'no_show'].includes(a.stage)) || byRecent[0] || null;
    const ivApps = new Set(out.ivs.map((i) => i.application_id).filter(Boolean));
    const offerApps = new Set(out.offers.map((o) => o.application_id));

    const applications = out.apps.map((a) => {
      const j = jobById.get(a.job_id);
      let eligibility = { status: 'Eligible', reason: null };
      let liveMatch = null;
      if (a.screening_status === 'knocked_out') {
        eligibility = { status: 'Not eligible', reason: 'Did not meet a required screening answer' };
      } else if (j) {
        try {
          const m = matchCandidate(toJob(j), cand);
          liveMatch = Number.isFinite(m.score) ? Math.round(m.score) : null;
          const e = m.breakdown && m.breakdown.experience;
          if (e && e.fit === 'far') eligibility = { status: 'Check', reason: `Experience ${e.years} yrs against ${e.band.min}-${e.band.max} yrs` };
          else if (m.breakdown && m.breakdown.location && m.breakdown.location.score === 0) eligibility = { status: 'Check', reason: 'Location does not match and no relocation stated' };
        } catch { /* the stored match score still shows */ }
      }
      return {
        applicationId: a.id, reference: a.reference || null, jobId: a.job_id, jobTitle: a.job_title,
        company: a.company_name || null, jobType: (a.posting_type || a.posting_kind) === 'walkin' ? 'Walk-in' : 'Regular',
        stage: a.stage, stageLabel: P.intLabel.get(a.stage) || a.stage,
        phase: P.phaseOf.get(a.stage) || 'under_review', source: a.source_channel || a.source || null,
        appliedAt: iso(a.applied_at), lastUpdated: iso(a.updated_at), status: a.application_status || null,
        matching: {
          resumeScore: out.resume ? out.resume.total_score : null,
          profileScore: out.score ? out.score.percent : null,
          eligibility,
          matchScore: a.match_score == null ? liveMatch : Number(a.match_score),
          screeningScore: a.screening_combined_score == null ? null : Number(a.screening_combined_score),
          autoRejectConfigured: false,
        },
      };
    });

    /* ---- the timeline (spec 37), from real events only ---- */
    const ev = [];
    const push = (at, kind, label, extra = {}) => { if (at) ev.push({ at: iso(at), kind, label, ...extra }); };
    push(row.created_at, 'registered', row.user_id ? 'Registered' : 'Added to the talent pool');
    /* Edits within ten minutes of each other are one "Profile Updated". */
    let lastEdit = null;
    audit.slice().reverse().forEach((x) => {
      if (x.action === 'candidate.updated') {
        const fields = (x.detail && x.detail.fields) || [];
        if (lastEdit && new Date(x.created_at) - new Date(lastEdit.raw) < 600000) {
          lastEdit.raw = x.created_at; lastEdit.ev.at = iso(x.created_at);
          lastEdit.fields = [...new Set([...lastEdit.fields, ...fields])];
          lastEdit.ev.detail = lastEdit.fields.slice(0, 8).join(', ');
          return;
        }
        push(x.created_at, 'profile_updated', 'Profile Updated', { detail: fields.slice(0, 8).join(', ') });
        lastEdit = { raw: x.created_at, ev: ev[ev.length - 1], fields: fields.slice() };
        return;
      }
      else if (x.action === 'resume.uploaded') push(x.created_at, 'resume_uploaded', 'Resume Uploaded');
      else if (x.action === 'resume.changed') push(x.created_at, 'resume_uploaded', 'Resume Replaced');
      else push(x.created_at, 'document', x.action === 'document.uploaded' ? 'Document Uploaded' : 'Document Updated', { detail: x.detail && x.detail.kind });
    });
    if (row.resume_uploaded_at && !audit.some((x) => x.action === 'resume.uploaded')) push(row.resume_uploaded_at, 'resume_uploaded', 'Resume Uploaded');
    const STEP = { shortlisted: 'Shortlisted', offer_extended: 'Offer Released', selected: 'Selected', joined: 'Hired', rejected: 'Rejected', hold: 'On Hold', no_show: 'Did not attend', attended: 'Attended walk-in', interviewed: 'Interview Completed', interview_scheduled: 'Interview Scheduled', ai_interview_done: 'Interview Completed', client_interview: 'Interview Scheduled' };
    for (const a of out.apps) {
      /* 0130: the line reads "Applied for <job> on <date>" (IST); the label stays "Applied". */
      push(a.applied_at, 'applied', 'Applied', { job: a.job_title, applicationId: a.id,
        text: `Applied for ${a.job_title} on ${istDate(a.applied_at)}` });
      for (const h of histBy.get(a.id) || []) {
        if (!h.from_stage) continue;            // the insert is "Applied", above
        if (h.to_stage === 'interview_scheduled' && ivApps.has(a.id)) continue;   // the interview row says it, with its date
        if (h.to_stage === 'offer_extended' && offerApps.has(a.id)) continue;
        const label = STEP[h.to_stage] || ('Moved to ' + (P.intLabel.get(h.to_stage) || h.to_stage));
        push(h.created_at, h.to_stage === 'rejected' || h.to_stage === 'hold' ? h.to_stage : 'stage', label,
          { job: a.job_title, applicationId: a.id, detail: h.reason || null });
      }
    }
    for (const i of out.ivs) {
      push(i.created_at, 'interview_scheduled', 'Interview Scheduled', { job: i.job_title, detail: [day(i.scheduled_date), i.scheduled_time, i.mode_label].filter(Boolean).join(' · ') });
      if (i.rescheduled_at) push(i.rescheduled_at, 'interview_rescheduled', 'Interview Rescheduled', { job: i.job_title, detail: [day(i.scheduled_date), i.scheduled_time].filter(Boolean).join(' ') });
      if (i.completed_at) push(i.completed_at, 'interview_completed', 'Interview Completed', { job: i.job_title });
      if (i.cancelled_at) push(i.cancelled_at, 'interview_cancelled', 'Interview Cancelled', { job: i.job_title });
    }
    for (const o of out.offers) {
      const a = out.apps.find((x) => x.id === o.application_id);
      push(o.extended_at, 'offer', 'Offer Released', { job: a && a.job_title });
      if (o.responded_at) push(o.responded_at, 'offer', 'Offer ' + o.status[0].toUpperCase() + o.status.slice(1), { job: a && a.job_title });
    }
    ev.sort((x, y) => (x.at < y.at ? 1 : -1));

    const latestAt = [row.updated_at, ...out.apps.map((a) => a.updated_at)].filter(Boolean).map((d) => new Date(d)).sort((a, b) => b - a)[0];
    res.json({
      record: {
        candidateId: row.id,
        candidateCode: row.candidate_code || null,
        name: row.name, email: row.email || null, mobile: row.phone || null,
        profileScore: out.score ? out.score.percent : null,
        profileMissing: out.score ? out.score.missing : [],
        resumeScore: out.resume ? { total: out.resume.total_score, label: out.resume.label, scoredAt: iso(out.resume.scored_at) } : null,
        currentStage: currentApp ? { applicationId: currentApp.id, stage: currentApp.stage, label: P.intLabel.get(currentApp.stage) || currentApp.stage, phase: P.phaseOf.get(currentApp.stage) || null, job: currentApp.job_title } : null,
        source: { candidate: row.source || null, detail: row.source_details || null },
        lastUpdated: iso(latestAt),
        skills: [...new Set([...(row.skills || []), ...(row.technical_skills || [])])],
        experience: { label: row.exp || null, years: row.exp_years == null ? null : Number(row.exp_years), currentCompany: row.current_company || null, title: row.title || null },
        applications,
        interviews: out.ivs.map((i) => ({
          id: i.id, applicationId: i.application_id, jobTitle: i.job_title, round: i.type || 'Interview',
          date: day(i.scheduled_date), time: i.scheduled_time || null, mode: i.mode_label, venue: i.venue_address || null,
          state: i.state, reschedules: Number(i.reschedule_count || 0), interviewer: i.interviewer || null,
          score: i.ai_score == null ? null : Number(i.ai_score),
        })),
        assessments: out.assessments.map(assessmentOut),
        referral: out.referral ? {
          id: String(out.referral.id), referrerCandidateId: out.referral.referrer_candidate_id,
          referrerCode: out.referral.referrer_code || null, referrerName: out.referral.referrer_name || null,
          referredAt: iso(out.referral.referred_at), status: out.referral.status, via: out.referral.via,
          rewardAmount: out.referral.reward_amount == null ? null : Number(out.referral.reward_amount),
          rewardStatus: out.referral.reward_status,
        } : null,
        referredOthers: out.referredOthers,
        handoffs: out.handoffs.map((h) => ({ applicationId: h.application_id, status: h.status, stage: h.trigger_stage, at: iso(h.created_at) })),
        timeline: ev.slice(0, 200),
      },
    });
  }));

  const assessmentBody = z.object({
    name: z.string().trim().min(1).max(120),
    category: z.enum(['Java', 'Python', 'Aptitude', 'Communication', 'Technical', 'Other']).optional(),
    score: z.number().min(0).max(100000).nullable().optional(),
    maxScore: z.number().positive().max(100000).optional(),
    assessedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    status: z.enum(['assigned', 'in_progress', 'completed', 'expired', 'cancelled']).optional(),
    provider: z.string().trim().max(120).nullable().optional(),
    externalRef: z.string().trim().max(200).nullable().optional(),
    applicationId: z.string().trim().max(80).nullable().optional(),
  }).strict();

  r.post('/ats/candidates/:id/assessments', requireAuth(), requireRole('recruiter', 'admin'), wrap(async (req, res) => {
    const b = assessmentBody.safeParse(req.body || {});
    if (!b.success) throw badRequest('Please give the assessment a name and a score within its maximum.');
    const d = b.data;
    if (d.score != null && d.score > (d.maxScore || 100)) throw badRequest('The score is above the maximum score.');
    const row = await withUser(req.session, async (c) => {
      const ok = (await c.query(`select 1 from candidates where id = $1`, [req.params.id])).rowCount;
      if (!ok) throw notFound('That candidate could not be found.');
      return (await c.query(
        `insert into candidate_assessments (candidate_id, application_id, name, category, score, max_score, assessed_on, status, provider, external_ref, recorded_by)
         values ($1,$2,$3,coalesce($4,'Technical'),$5,coalesce($6,100),$7,coalesce($8,'completed'),$9,$10,nullif($11,'')::uuid) returning *`,
        [req.params.id, d.applicationId || null, d.name, d.category || null, d.score ?? null, d.maxScore || null,
         d.assessedOn || null, d.status || null, d.provider || null, d.externalRef || null, req.session.userId || ''])).rows[0];
    });
    res.status(201).json({ assessment: assessmentOut(row) });
  }));

  r.put('/ats/assessments/:id', requireAuth(), requireRole('recruiter', 'admin'), wrap(async (req, res) => {
    const b = assessmentBody.partial().safeParse(req.body || {});
    if (!b.success) throw badRequest('That assessment change could not be read.');
    const map = { name: 'name', category: 'category', score: 'score', maxScore: 'max_score', assessedOn: 'assessed_on', status: 'status', provider: 'provider', externalRef: 'external_ref' };
    const sets = []; const vals = [];
    for (const [k, col] of Object.entries(map)) if (b.data[k] !== undefined) { vals.push(b.data[k]); sets.push(`${col} = $${vals.length}`); }
    if (!sets.length) throw badRequest('Nothing to update.');
    vals.push(String(req.params.id));
    const row = await withUser(req.session, async (c) => (await c.query(
      `update candidate_assessments set ${sets.join(', ')}, updated_at = now() where id = $${vals.length}::bigint returning *`, vals)).rows[0]);
    if (!row) throw notFound('That assessment could not be found.');
    res.json({ assessment: assessmentOut(row) });
  }));

  r.post('/ats/candidates/:id/referral', requireAuth(), requireRole('recruiter', 'admin'), wrap(async (req, res) => {
    const b = z.object({
      referrerCandidateId: z.string().trim().min(1).max(80),
      jobId: z.string().trim().max(80).nullable().optional(),
      rewardAmount: z.number().min(0).max(10000000).nullable().optional(),
      notes: z.string().trim().max(500).nullable().optional(),
    }).strict().safeParse(req.body || {});
    if (!b.success) throw badRequest('Choose the candidate who referred them.');
    const id = String(req.params.id);
    if (b.data.referrerCandidateId === id) throw badRequest('A candidate cannot refer themselves.');
    const row = await withUser(req.session, async (c) => {
      const seen = (await c.query(`select id from candidates where id = any($1::text[])`, [[id, b.data.referrerCandidateId]])).rows;
      if (seen.length < 2) throw notFound('Both candidates must be in your talent pool.');
      const exists = (await c.query(`select 1 from candidate_referrals where referred_candidate_id = $1`, [id])).rowCount;
      if (exists) throw new ApiError(409, 'REFERRAL_EXISTS', 'A referral is already recorded for this candidate.');
      const applied = (await c.query(`select 1 from applications where candidate_id = $1 limit 1`, [id])).rowCount;
      return (await c.query(
        `insert into candidate_referrals (referrer_candidate_id, referred_candidate_id, job_id, status, reward_amount,
                                          reward_status, via, recorded_by, notes)
         values ($1,$2,$3,$4,$5,$6,'staff',nullif($7,'')::uuid,$8) returning *`,
        [b.data.referrerCandidateId, id, b.data.jobId || null, applied ? 'applied' : 'registered',
         b.data.rewardAmount ?? null, b.data.rewardAmount != null ? 'pending' : 'none', req.session.userId || '', b.data.notes || null])).rows[0];
    });
    res.status(201).json({ referral: { id: String(row.id), status: row.status, rewardStatus: row.reward_status } });
  }));

  r.put('/ats/referrals/:id', requireAuth(), requireRole('recruiter', 'admin'), wrap(async (req, res) => {
    const b = z.object({
      status: z.enum(['registered', 'applied', 'hired', 'not_hired', 'withdrawn']).optional(),
      rewardAmount: z.number().min(0).max(10000000).nullable().optional(),
      rewardStatus: z.enum(['none', 'pending', 'approved', 'paid', 'declined']).optional(),
      notes: z.string().trim().max(500).nullable().optional(),
    }).strict().safeParse(req.body || {});
    if (!b.success) throw badRequest('That referral change could not be read.');
    const map = { status: 'status', rewardAmount: 'reward_amount', rewardStatus: 'reward_status', notes: 'notes' };
    const sets = []; const vals = [];
    for (const [k, col] of Object.entries(map)) if (b.data[k] !== undefined) { vals.push(b.data[k]); sets.push(`${col} = $${vals.length}`); }
    if (!sets.length) throw badRequest('Nothing to update.');
    vals.push(String(req.params.id));
    const row = await withUser(req.session, async (c) => (await c.query(
      `update candidate_referrals set ${sets.join(', ')}, updated_at = now() where id = $${vals.length}::bigint returning *`, vals)).rows[0]);
    if (!row) throw notFound('That referral could not be found.');
    res.json({ referral: { id: String(row.id), status: row.status, rewardAmount: row.reward_amount == null ? null : Number(row.reward_amount), rewardStatus: row.reward_status } });
  }));

  /* ================= admin ================= */

  r.get('/admin/audit-log', requireAuth(), requireRole('admin'), wrap(async (req, res) => {
    const { page, pageSize, offset } = pageOf(req.query, 100);
    const { w, vals } = auditFilters(req.query);
    const out = await withUser(req.session, async (c) => {
      const total = (await c.query(`select count(*)::int n from ${AUDIT_FROM} ${w}`, vals)).rows[0].n;
      const rows = (await c.query(
        `select e.*, u.email actor_email from ${AUDIT_FROM} ${w}
          order by e.at desc, e.id desc limit ${pageSize} offset ${offset}`, vals)).rows;
      return { total, rows, names: await auditNames(c, rows) };
    });
    res.json({
      total: out.total, page, pageSize,
      actions: Object.entries(ACTIONS).map(([id, label]) => ({ id, label })),
      entities: ENTITIES,
      names: out.names,
      rows: out.rows.map((x) => ({
        id: x.id, at: iso(x.at), user: x.actor_email || (x.actor_role === 'anon' ? 'Self-registration' : (x.actor_role || 'system')),
        userName: out.names[`user:${x.actor_user_id}`] || null,
        role: x.actor_role || null, action: x.action, actionLabel: ACTIONS[x.action] || x.action,
        entity: x.entity, entityId: x.entity_id,
        entityName: out.names[`${x.entity}:${x.entity_id}`] || null, detail: x.detail || {},
      })),
    });
  }));

  /* The filtered log as a CSV (at most 5000 rows). The export is itself logged. */
  r.get('/admin/audit-log/export', requireAuth(), requireRole('admin'), wrap(async (req, res) => {
    const { w, vals } = auditFilters(req.query);
    const rows = await withUser(req.session, async (c) => {
      const got = (await c.query(
        `select e.*, u.email actor_email from ${AUDIT_FROM} ${w} order by e.at desc, e.id desc limit 5000`, vals)).rows;
      await c.query(`select audit_write('AUDIT_LOG_EXPORTED', 'setting', 'audit_log', $1::jsonb)`,
        [JSON.stringify({ rows: got.length, filters: Object.fromEntries(['action', 'entity', 'entityId', 'actorRole', 'from', 'to', 'q']
          .filter((k) => req.query[k]).map((k) => [k, String(req.query[k]).slice(0, 80)])) })]);
      return got;
    });
    const head = ['When (UTC)', 'Who', 'Role', 'Action', 'Record type', 'Record', 'Details'];
    const lines = [head.join(',')].concat(rows.map((x) => [
      new Date(x.at).toISOString(), x.actor_email || x.actor_role || 'system', x.actor_role || '',
      ACTIONS[x.action] || x.action, x.entity, x.entity_id, JSON.stringify(x.detail || {}),
    ].map(csvCell).join(',')));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send('\uFEFF' + lines.join('\r\n'));
  }));

  r.get('/admin/portal-analytics', requireAuth(), requireRole('admin'), wrap(async (req, res) => {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
    const out = await withUser(req.session, async (c) => {
      const one = async (sql, p = []) => (await c.query(sql, p)).rows[0];
      const since = `now() - make_interval(days => ${days})`;
      const cands = await one(`select count(*)::int total,
          count(*) filter (where user_id is not null and created_at >= ${since})::int registrations,
          count(*) filter (where user_id is null and created_at >= ${since})::int added_by_staff,
          count(*) filter (where resume_file is not null)::int with_resume from candidates`);
      const uploads = await one(`select count(*)::int n from audit_log where action in ('resume.uploaded','resume.changed') and created_at >= ${since}`);
      const ids = (await c.query(`select id from candidates`)).rows.map((x) => x.id);
      const scores = [...(await profileScoresFor(c, ids)).values()].map((s) => s.percent);
      const buckets = { incomplete: 0, fair: 0, good: 0, excellent: 0 };
      scores.forEach((p) => { if (p >= 90) buckets.excellent += 1; else if (p >= 70) buckets.good += 1; else if (p >= 40) buckets.fair += 1; else buckets.incomplete += 1; });
      const byType = (await c.query(`
        with j as (select id, case when posting_kind = 'walkin' then 'walkin' else 'regular' end t from jobs),
             v as (select job_id, sum(views)::int n from job_view_daily where day >= (now() at time zone 'Asia/Kolkata')::date - ${days} group by 1),
             a as (select job_id, count(*)::int n,
                          count(*) filter (where attended_at is not null or stage in ('attended','interviewed','selected','joined'))::int attended,
                          count(*) filter (where stage in ('selected','joined'))::int selected,
                          count(*) filter (where stage = 'no_show')::int no_show
                     from applications where applied_at >= ${since} group by 1)
        select j.t, count(distinct j.id)::int jobs, coalesce(sum(v.n),0)::int views, coalesce(sum(a.n),0)::int applications,
               coalesce(sum(a.n) filter (where coalesce(v.n,0) > 0),0)::int viewed_apps,
               coalesce(sum(a.attended),0)::int attended, coalesce(sum(a.selected),0)::int selected, coalesce(sum(a.no_show),0)::int no_show
          from j left join v on v.job_id = j.id left join a on a.job_id = j.id group by j.t`)).rows;
      const top = (await c.query(`
        select j.id, j.title, case when j.posting_kind = 'walkin' then 'Walk-in' else 'Regular' end job_type,
               coalesce(v.n,0)::int views, coalesce(a.n,0)::int applications
          from jobs j
          left join (select job_id, sum(views)::int n from job_view_daily where day >= (now() at time zone 'Asia/Kolkata')::date - ${days} group by 1) v on v.job_id = j.id
          left join (select job_id, count(*)::int n from applications where applied_at >= ${since} group by 1) a on a.job_id = j.id
         where coalesce(v.n,0) + coalesce(a.n,0) > 0
         order by coalesce(v.n,0) desc, coalesce(a.n,0) desc limit 10`)).rows;
      const sources = (await c.query(`select coalesce(source_channel,'Unknown') s, count(*)::int n from applications where applied_at >= ${since} group by 1 order by 2 desc`)).rows;
      const candSources = (await c.query(`select coalesce(source,'Unknown') s, count(*)::int n from candidates group by 1 order by 2 desc`)).rows;
      const apps = await one(`select count(*)::int total, count(*) filter (where applied_at >= ${since})::int recent from applications`);
      return { cands, uploads, scores, buckets, byType, top, sources, candSources, apps };
    });
    const t = (k) => out.byType.find((x) => x.t === k) || { jobs: 0, views: 0, applications: 0, viewed_apps: 0, attended: 0, selected: 0, no_show: 0 };
    const rate = (n, d) => (d ? Math.round((1000 * n) / d) / 10 : null);
    const kind = (k) => {
      const x = t(k);
      return { jobs: x.jobs, views: x.views, applications: x.applications, conversionRate: rate(x.viewed_apps, x.views), viewedApplications: x.viewed_apps,
        attended: x.attended, selections: x.selected, noShows: x.no_show, selectionRate: rate(x.selected, x.applications) };
    };
    const reg = kind('regular'); const wk = kind('walkin');
    res.json({
      days,
      candidates: {
        total: out.cands.total, registrations: out.cands.registrations, addedByStaff: out.cands.added_by_staff,
        withResume: out.cands.with_resume, resumeUploads: out.uploads.n,
        profileCompletion: {
          average: out.scores.length ? Math.round(out.scores.reduce((a, b) => a + b, 0) / out.scores.length) : null,
          buckets: out.buckets,
        },
        applications: out.apps.recent, applicationsAllTime: out.apps.total,
      },
      jobs: {
        views: reg.views + wk.views, applications: reg.applications + wk.applications,
        /* Conversion counts applications to jobs that were viewed, over
           those views - Apply from a card never opens the job page. */
        conversionRate: rate(reg.viewedApplications + wk.viewedApplications, reg.views + wk.views),
        byType: { regular: reg, walkin: wk },
        top: out.top.map((x) => ({ jobId: x.id, title: x.title, jobType: x.job_type, views: x.views, applications: x.applications, conversionRate: rate(x.applications, x.views) })),
      },
      /* Walk-in is a job type: these are the walk-in rows of the same numbers. */
      walkin: { views: wk.views, applications: wk.applications, interviewRegistrations: wk.applications, attendance: wk.attended, noShows: wk.noShows, selections: wk.selections, selectionRate: wk.selectionRate },
      sources: { applications: out.sources.map((x) => ({ source: x.s, count: x.n })), candidates: out.candSources.map((x) => ({ source: x.s, count: x.n })) },
    });
  }));

  r.get('/admin/employee-handoffs', requireAuth(), requireRole('admin'), wrap(async (req, res) => {
    const rows = await withUser(req.session, async (c) => (await c.query(
      `select * from employee_handoff_payload_v order by created_at desc limit 200`)).rows);
    res.json({
      hrmsConfigured: false,
      note: 'No HRMS is connected. Selected and Joined applications are queued here for when one is; nothing is sent.',
      handoffs: rows.map((x) => ({
        id: String(x.handoff_id), status: x.status, stage: x.trigger_stage, queuedAt: iso(x.created_at),
        applicationId: x.application_id, applicationReference: x.application_reference,
        candidateId: x.candidate_id, candidateCode: x.candidate_code, name: x.name, email: x.email, phone: x.phone,
        jobId: x.job_id, jobTitle: x.job_title, companyId: x.company_id, company: x.company_name,
        employmentType: x.employment_type, offerCtc: x.offer_ctc == null ? null : Number(x.offer_ctc),
        joiningDate: day(x.joining_date), offerStatus: x.offer_status || null,
      })),
    });
  }));

  /* ================= public ================= */

  r.post('/jobs/:id/view', viewLimiter, wrap(async (req, res) => {
    const id = String(req.params.id || '').slice(0, 80);
    const counted = await withUser(null, async (c) => (await c.query(`select job_view_record($1) ok`, [id])).rows[0].ok);
    res.json({ counted: !!counted });
  }));

  return r;
}

function assessmentOut(x) {
  return {
    id: String(x.id), name: x.name, category: x.category,
    score: x.score == null ? null : Number(x.score), maxScore: Number(x.max_score),
    percent: x.score == null ? null : Math.round((100 * Number(x.score)) / Number(x.max_score)),
    assessedOn: day(x.assessed_on), status: x.status,
    ...(x.provider !== undefined ? { provider: x.provider || null } : {}),
  };
}
