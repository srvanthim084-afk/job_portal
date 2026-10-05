/**
 * The recruiter ATS for every job, and the walk-in lifecycle (0107).
 *
 *   GET  /api/ats/stages                         stage sets + walk-in transition table
 *   GET  /api/ats/applicants                     server-side search / filter / pagination (23.3)
 *   GET  /api/jobs/:id/applicants                the same, for one job, with its dashboard counts (23.5)
 *   GET  /api/jobs/:id/ats-summary               the counts alone
 *   GET  /api/ats/applications/:id               the candidate details page (23.9)
 *   POST /api/ats/applications/:id/stage         one stage move (23.4, 23.8)
 *   POST /api/ats/applications/bulk-stage        up to 200 (23.7)
 *   GET  /api/jobs/:id/check-in?q=               check-in search (23.6)
 *   POST /api/ats/applications/:id/check-in      Check In / Mark Attended / both
 *   POST /api/jobs/:id/check-in/quick            by the Application ID on the confirmation / QR
 *   GET|POST /api/ats/applications/:id/notes, PUT|DELETE /api/ats/notes/:id   (23.11)
 *   PUT  /api/ats/applications/:id/rating        (23.12)
 *   GET  /api/ats/applications/:id/resume        authenticated, authorised, logged (23.10)
 *   GET  /api/ats/applications/:id/decision-template, POST .../decision-message   (23.18)
 *   POST /api/jobs/:id/applicants/export         CSV / Excel, 23.19 columns, notes only on request
 *   GET  /api/jobs/:id/update-history            (23.14) + reschedule notifications (23.15)
 *   POST /api/jobs/:id/reschedules/:rid/(retry|send-now)
 *   GET|PUT /api/jobs/:id/ats-settings           new-application alerts: auto | instant | digest | off
 *   GET|PUT /api/admin/walkin-ats/settings       No Show grace, busy-job threshold
 *   GET  /api/my/applications-status             the candidate's own, in their words (23.18)
 *
 * ACCESS (23.2) is decided by the database: every read runs as the
 * caller under RLS, and every write goes through a definer function that
 * checks ats_can_manage() / ats_job_is_mine() itself. A job outside the
 * caller's scope answers 404 whatever the route.
 */
import { Router } from 'express';
import { z } from 'zod';
import { withUser } from '../db.js';
import { wrap, badRequest, notFound, forbidden, ApiError } from '../errors.js';
import { requireAuth, requireRole } from '../auth.js';
import { getStorage } from '../storage.js';
import { writeSheet } from '../xlsx.js';
import { dispatchEvent } from '../notify/events.js';
import {
  kickWalkinAts, sendReschedule, sendDecision, decisionTemplate, stageCounts, jobDetails, whenText,
} from '../notify/walkin-ats.js';

const STAFF = ['recruiter', 'admin'];
const newId = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const iso = (v) => (v ? new Date(v).toISOString() : null);

const parse = (schema, body) => {
  const out = schema.safeParse(body || {});
  if (!out.success) {
    const details = {};
    for (const i of out.error.issues) details[i.path.join('.') || 'form'] = i.message;
    throw badRequest('Please check the highlighted fields and try again.', details);
  }
  return out.data;
};

/** Control characters out; the text is escaped wherever it is rendered. */
const cleanText = (s) => String(s || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();

const FIELD_LABELS = {
  walkin_date: 'Walk-in Date', walkin_from: 'Start Time', walkin_to: 'End Time',
  walkin_venue: 'Venue', walkin_address: 'Address', walkin_map_link: 'Map Link',
  walkin_contact: 'Contact Person', walkin_phone: 'Contact Number', walkin_capacity: 'Slot Capacity',
  status: 'Status', paused: 'Paused', archived: 'Archived', reschedule_notification: 'Applicants notified',
};

/* ------------------------------------------------------------------ *
 * shapes
 * ------------------------------------------------------------------ */

export function walkinStatus(j, now = Date.now()) {
  if (!j || j.posting_kind !== 'walkin') return null;
  const ends = j.ends_at ? new Date(j.ends_at).getTime() : null;
  if (j.status !== 'open' || j.paused || j.archived) return 'closed';
  if (ends != null && now > ends) return 'closed';
  return 'open';
}

function applicantRow(r) {
  const walkin = r.posting_kind === 'walkin';
  return {
    applicationId: r.id,
    reference: r.reference || r.id,
    candidateId: r.candidate_id,
    candidateName: r.name,
    mobile: r.phone || '',
    email: r.email || '',
    currentLocation: r.location || '',
    preferredLocation: r.preferred_location || '',
    qualification: r.qualification || r.education || '',
    specialization: r.specialization || '',
    experience: r.exp || (r.exp_years != null ? `${Number(r.exp_years)} yrs` : ''),
    currentSalary: r.ctc || '',
    expectedSalary: r.expected_ctc == null ? '' : `${Number(r.expected_ctc)} LPA`,
    noticePeriod: r.notice_period || '',
    hasResume: !!(r.has_resume || r.app_resume),
    resumeFile: r.resume_file || '',
    jobId: r.job_id,
    jobTitle: r.title,
    jobType: walkin ? 'Walk-in' : 'Regular',
    applicationDate: iso(r.applied_at),
    stage: r.stage,
    stageLabel: r.stage_label || r.stage,
    status: r.application_status,
    rating: r.rating_avg == null ? null : Number(r.rating_avg),
    ratingCount: Number(r.rating_n || 0),
    version: r.version,
    updatedAt: iso(r.updated_at),
    updatedBy: r.updated_by_name || null,
    checkedInAt: iso(r.checked_in_at),
    attendedAt: iso(r.attended_at),
    interviewedAt: iso(r.interviewed_at),
    source: walkin ? 'Walk-in' : 'Regular',
  };
}

/*
 * THE LIST IS READ IN TWO STEPS, ids first. Every filter is on
 * `applications` alone (candidate and job conditions are uncorrelated
 * ARRAY(...) subqueries, evaluated ONCE); only the page's ids are then
 * joined to candidates, through a materialised set. Joining the RLS-guarded
 * candidates table row by row made the planner rescan it per applicant -
 * 3.4 s for 160 applicants on a database without statistics (PGlite in
 * development never ANALYZEs). This shape does not depend on statistics.
 */
const APPLICANT_BODY = `
  select a.id, a.reference, a.candidate_id, a.job_id, a.stage, a.application_status, a.applied_at,
         a.version, a.updated_at, a.checked_in_at, a.attended_at, a.interviewed_at,
         (a.resume_path like 'candidates/' || a.candidate_id || '/%') as app_resume,
         ats_actor_name(a.updated_by) as updated_by_name,
         c.name, c.phone, c.email, c.location, c.preferred_location, c.education, c.exp, c.exp_years,
         c.ctc, c.expected_ctc, c.notice_period, c.resume_file,
         (c.resume_storage_path is not null) as has_resume,
         ed.qualification, ed.specialization,
         j.title, j.posting_kind,
         s.label as stage_label,
         (select round(avg(r.rating)::numeric, 1) from application_ratings r where r.application_id = a.id) as rating_avg,
         (select count(*) from application_ratings r where r.application_id = a.id) as rating_n
    from ap a
    join jobs j on j.id = a.job_id
    join cand c on c.id = a.candidate_id
    left join stages s on s.id = a.stage
    left join lateral (select e.qualification, e.specialization from candidate_education e
                        where e.candidate_id = c.id order by e.sort_order, e.id limit 1) ed on true`;

/** The full rows for these application ids (RLS still applies), newest first. */
async function applicantRows(c, ids, extraWhere = '') {
  if (!ids.length) return [];
  const { rows } = await c.query(
    `with ap as materialized (select * from applications where id = any($1::text[])),
          cand as materialized (select * from candidates where id = any(array(select candidate_id from ap)))
     ${APPLICANT_BODY} ${extraWhere} order by a.applied_at desc, a.id`, [ids]);
  return rows;
}

/**
 * The WHERE clause for the applicant list, on `applications a` only.
 * Every value is a bound parameter; the column names are fixed here.
 */
function applicantFilters(qs, params) {
  const where = [`(app_is_admin() or a.recruiter_id = app_recruiter_id()
     or a.job_id = any(array(select jj.id from jobs jj where jj.recruiter_id = app_recruiter_id())))`];
  const add = (sql, v) => { params.push(v); where.push(sql.replace(/\?/g, `$${params.length}`)); };
  if (qs.jobId) add('a.job_id = ?', String(qs.jobId));
  const q = String(qs.q || '').trim().slice(0, 120);
  if (q) {
    const digits = q.replace(/\D/g, '');
    params.push(`%${q.replace(/[%_\\]/g, (m) => '\\' + m)}%`);
    const p = `$${params.length}`;
    const cand = [`cc.name ilike ${p}`, `cc.email ilike ${p}`, `cc.id ilike ${p}`, `coalesce(cc.candidate_reference,'') ilike ${p}`];
    if (digits.length >= 4) {
      params.push(`%${digits.slice(-10)}%`);
      cand.push(`regexp_replace(coalesce(cc.phone,''), '\\D', '', 'g') like $${params.length}`);
    }
    where.push(`(a.id ilike ${p} or coalesce(a.reference,'') ilike ${p}
      or a.candidate_id = any(array(select cc.id from candidates cc where ${cand.join(' or ')})))`);
  }
  if (qs.jobType === 'walkin' || qs.jobType === 'Walk-in') where.push(`a.job_id = any(array(select jj.id from jobs jj where jj.posting_kind = 'walkin'))`);
  if (qs.jobType === 'regular' || qs.jobType === 'Regular') where.push(`not (a.job_id = any(array(select jj.id from jobs jj where jj.posting_kind = 'walkin')))`);
  if (qs.stage) add('a.stage = ?', String(qs.stage).slice(0, 40));
  if (qs.status) add('a.application_status = ?', String(qs.status).slice(0, 20));
  if (qs.from && /^\d{4}-\d{2}-\d{2}$/.test(qs.from)) add(`a.applied_at >= (?::date::timestamp at time zone 'Asia/Kolkata')`, qs.from);
  if (qs.to && /^\d{4}-\d{2}-\d{2}$/.test(qs.to)) add(`a.applied_at < ((?::date + 1)::timestamp at time zone 'Asia/Kolkata')`, qs.to);
  return where;
}

/** Matching ids (and the total), newest first. */
async function findApplicants(c, qs, { limit = null, offset = 0, job = null } = {}) {
  if (job) {
    // one job: its scope is decided once by ats_job_applicant_page (0107)
    const kind = job.posting_kind === 'walkin' ? 'walkin' : 'regular';
    const jt = qs.jobType === 'Walk-in' ? 'walkin' : qs.jobType === 'Regular' ? 'regular' : (qs.jobType || '');
    if (jt && jt !== kind) return { total: 0, ids: [] };
    const q = String(qs.q || '').trim().slice(0, 120);
    const digits = q.replace(/\D/g, '');
    const date = (v) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
    const r = (await c.query(`select ats_job_applicant_page($1,$2,$3,$4,$5,$6,$7,$8,$9) as r`, [
      job.id, q ? `%${q.replace(/[%_\\]/g, (m) => '\\' + m)}%` : null, digits.length >= 4 ? `%${digits.slice(-10)}%` : null,
      qs.stage ? String(qs.stage).slice(0, 40) : null, qs.status ? String(qs.status).slice(0, 20) : null,
      date(qs.from), date(qs.to), limit == null ? 100000 : Number(limit), Number(offset) || 0])).rows[0].r;
    return { total: r.total, ids: r.ids };
  }
  const params = [];
  const clause = `where ${applicantFilters(qs, params).join(' and ')}`;
  const total = (await c.query(`select count(*)::int n from applications a ${clause}`, params)).rows[0].n;
  const ids = (await c.query(
    `select a.id from applications a ${clause} order by a.applied_at desc, a.id
      ${limit != null ? `limit ${Number(limit)} offset ${Number(offset)}` : ''}`, params)).rows.map((x) => x.id);
  return { total, ids };
}
/** The job, if the caller manages it - otherwise 404 (23.2: deny a job outside scope). */
async function myJob(c, jobId) {
  const { rows } = await c.query(
    `select j.*, walkin_starts_at(j.walkin_date, j.walkin_from) as starts_at,
            walkin_ends_at(j.walkin_date, j.walkin_to) as ends_at
       from jobs j where j.id = $1 and ats_job_is_mine(j.id)`, [jobId]);
  if (!rows[0]) throw notFound('That job does not exist or is not one of yours.');
  return rows[0];
}

function jobSummary(j, counts) {
  const walkin = j.posting_kind === 'walkin';
  const by = counts.by;
  const sum = (ids) => ids.reduce((n, id) => n + (by[id] || 0), 0);
  const out = {
    id: j.id, title: j.title, jobType: walkin ? 'Walk-in' : 'Regular', status: j.status,
    totalApplications: counts.total,
    byStage: by,
  };
  if (walkin) {
    const cap = j.walkin_capacity == null ? null : Number(j.walkin_capacity);
    const known = ['registered', 'attended', 'interviewed', 'selected', 'rejected', 'no_show'];
    out.walkin = {
      date: j.walkin_date || '', startTime: j.walkin_from || '', endTime: j.walkin_to || '',
      venue: j.walkin_venue || '', address: j.walkin_address || '', mapLink: j.walkin_map_link || '',
      contactPerson: j.walkin_contact || '', contactNumber: j.walkin_phone || '',
      startsAt: iso(j.starts_at), endsAt: iso(j.ends_at), status: walkinStatus(j),
      checkInOpensAt: j.starts_at ? new Date(new Date(j.starts_at).getTime() - 3600000).toISOString() : null,
    };
    out.tiles = {
      totalRegistrations: counts.total,
      registered: by.registered || 0, attended: by.attended || 0, interviewed: by.interviewed || 0,
      selected: by.selected || 0, rejected: by.rejected || 0, noShow: by.no_show || 0,
      other: counts.total - sum(known),
      capacity: cap,
      remainingCapacity: cap == null ? null : Math.max(0, cap - counts.total),
    };
    // the regular tile names, mapped onto the walk-in stages (23.5)
    out.regularTiles = { total: counts.total, new: by.registered || 0, shortlisted: (by.attended || 0) + (by.interviewed || 0),
      rejected: (by.rejected || 0) + (by.no_show || 0), selected: by.selected || 0 };
  } else {
    const groups = {
      new: ['applied', 'ai_screening'],
      shortlisted: ['shortlisted', 'with_bde', 'hold'],
      selected: ['selected', 'offer_extended', 'joined'],
      rejected: ['rejected'],
    };
    const t = { total: counts.total };
    let used = 0;
    for (const [k, ids] of Object.entries(groups)) { t[k] = sum(ids); used += t[k]; }
    t.inProcess = counts.total - used;   // interviews, reviews: so the tiles add up to the total
    out.regularTiles = t;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * routes
 * ------------------------------------------------------------------ */

/*
 * Run the engine soon after an application or a job edit, so a
 * recruiter's new-application alert or a settled reschedule does not
 * wait for the minute timer. Observes; never changes the request.
 * Mounted before the job and application routes (app.js).
 */
export function walkinAtsKick() {
  return (req, res, next) => {
    if ((req.method === 'POST' && req.path === '/applications') || (req.method === 'PUT' && /^\/jobs\/[^/]+$/.test(req.path))) {
      res.on('finish', () => { if (res.statusCode < 300) kickWalkinAts(); });
    }
    next();
  };
}

export default function walkinAtsRoutes() {
  const r = Router();

  r.get('/ats/stages', requireAuth(), wrap(async (req, res) => {
    const out = await withUser(req.session, async (c) => ({
      stages: (await c.query(`select id, label, candidate_label, applies_to, sort_order from stages order by sort_order`)).rows,
      transitions: (await c.query(`select from_stage, to_stage, is_override from stage_transitions where job_kind='walkin'`)).rows,
    }));
    const pick = (k) => out.stages.filter((s) => s.applies_to === 'all' || s.applies_to === k)
      .map((s) => ({ id: s.id, label: s.label, candidateLabel: s.candidate_label || null }));
    const walkinOrder = ['registered', 'attended', 'interviewed', 'selected', 'rejected', 'no_show'];
    res.json({
      regular: pick('regular'),
      walkin: pick('walkin').sort((a, b) => walkinOrder.indexOf(a.id) - walkinOrder.indexOf(b.id)),
      transitions: out.transitions.map((t) => ({ from: t.from_stage, to: t.to_stage, override: t.is_override })),
    });
  }));

  /* ---------------- the applicant list ---------------- */

  async function listApplicants(req, jobId) {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 25, 1), 100);
    return withUser(req.session, async (c) => {
      const job = jobId ? await myJob(c, jobId) : (req.query.jobId ? await myJob(c, String(req.query.jobId)) : null);
      const found = await findApplicants(c, { ...req.query, jobId: jobId || req.query.jobId },
        { limit: pageSize, offset: (page - 1) * pageSize, job });
      const total = found.total;
      const rows = await applicantRows(c, found.ids);
      const summary = job ? jobSummary(job, await stageCounts(c, job.id)) : null;
      return { applicants: rows.map(applicantRow), total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)), job: summary };
    });
  }

  r.get('/ats/applicants', requireAuth(), requireRole(...STAFF), wrap(async (req, res) => {
    res.json(await listApplicants(req, null));
  }));

  r.get('/jobs/:id/applicants', requireAuth(), requireRole(...STAFF), wrap(async (req, res) => {
    res.json(await listApplicants(req, req.params.id));
  }));

  r.get('/jobs/:id/ats-summary', requireAuth(), requireRole(...STAFF), wrap(async (req, res) => {
    const out = await withUser(req.session, async (c) => {
      const job = await myJob(c, req.params.id);
      return jobSummary(job, await stageCounts(c, job.id));
    });
    res.json({ job: out });
  }));

  /* ---------------- the candidate details page ---------------- */

  async function loadApplication(c, id) {
    const ok = (await c.query(`select ats_can_manage($1) as ok`, [id])).rows[0].ok;
    const row = ok ? (await applicantRows(c, [id]))[0] : null;
    if (!row) throw notFound('That application does not exist or is not one you can open.');
    return row;
  }

  async function timeline(c, appId) {
    const { rows } = await c.query(
      `select h.id, h.from_stage, h.to_stage, h.created_at, h.note, h.reason, h.source, h.is_override, h.action,
              ats_actor_name(h.changed_by) as actor,
              sf.label as from_label, st.label as to_label
         from application_stage_history h
         left join stages sf on sf.id = h.from_stage
         left join stages st on st.id = h.to_stage
        where h.application_id = $1 order by h.created_at, h.id`, [appId]);
    return rows.map((h) => {
      const system = h.source === 'system' || (!h.actor && h.source !== 'candidate');
      let action;
      if (h.action === 'applied') action = `Applied → ${h.to_label || h.to_stage}`;
      else if (h.action === 'checked_in') action = 'Checked in';
      else if (h.action === 'message_sent') action = 'Message sent';
      else action = `${h.from_label || h.from_stage || ''} → ${h.to_label || h.to_stage}`;
      return {
        id: Number(h.id), at: iso(h.created_at), action, from: h.from_stage, to: h.to_stage, kind: h.action,
        actor: system ? 'System' : (h.actor || (h.source === 'candidate' ? 'Candidate' : 'Recruiter')),
        source: system ? 'System' : h.source === 'candidate' ? 'Candidate' : 'Recruiter',
        reason: h.reason || null, note: h.note || null, override: !!h.is_override,
      };
    });
  }

  async function notesAndRatings(c, appId, session) {
    const notes = (await c.query(
      `select n.id, n.note, n.created_by, n.created_at, n.updated_at, ats_actor_name(n.created_by) as author
         from application_notes n where n.application_id = $1 order by n.created_at, n.id`, [appId])).rows;
    const ratings = (await c.query(
      `select r.rated_by, r.rating, r.rated_at, ats_actor_name(r.rated_by) as who
         from application_ratings r where r.application_id = $1 order by r.rated_at`, [appId])).rows;
    const avg = ratings.length ? Math.round((ratings.reduce((n, x) => n + x.rating, 0) / ratings.length) * 10) / 10 : null;
    const mine = ratings.find((x) => x.rated_by === session.userId);
    return {
      notes: notes.map((n) => ({
        noteId: Number(n.id), note: n.note, createdBy: n.author || 'Recruiter', createdAt: iso(n.created_at),
        updatedAt: iso(n.updated_at), mine: n.created_by === session.userId,
        canEdit: n.created_by === session.userId, canDelete: n.created_by === session.userId || session.role === 'admin',
      })),
      rating: {
        average: avg, count: ratings.length, mine: mine ? mine.rating : null,
        all: ratings.map((x) => ({ ratedBy: x.who || 'Recruiter', rating: x.rating, ratedAt: iso(x.rated_at) })),
      },
    };
  }

  r.get('/ats/applications/:id', requireAuth(), requireRole(...STAFF), wrap(async (req, res) => {
    const out = await withUser(req.session, async (c) => {
      const row = await loadApplication(c, req.params.id);
      const job = (await c.query(
        `select j.*, walkin_starts_at(j.walkin_date, j.walkin_from) as starts_at,
                walkin_ends_at(j.walkin_date, j.walkin_to) as ends_at from jobs j where j.id = $1`, [row.job_id])).rows[0];
      const appRow = (await c.query(
        `select checked_in_by, attended_by, ats_actor_name(checked_in_by) as checked_in_name,
                ats_actor_name(attended_by) as attended_name from applications where id = $1`, [row.id])).rows[0];
      const others = (await c.query(
        `select a.id, a.reference, a.job_id, a.stage, a.application_status, a.applied_at, j.title, j.posting_kind, s.label
           from applications a join jobs j on j.id = a.job_id left join stages s on s.id = a.stage
          where a.candidate_id = $1 and a.id <> $2
          order by a.applied_at desc`, [row.candidate_id, row.id])).rows;
      const nr = await notesAndRatings(c, row.id, req.session);
      return { row, job, appRow, others, nr, timeline: await timeline(c, row.id) };
    });
    const a = applicantRow(out.row);
    const j = out.job;
    res.json({
      candidate: {
        candidateId: a.candidateId, name: a.candidateName, mobile: a.mobile, email: a.email,
        location: a.currentLocation, preferredLocation: a.preferredLocation, qualification: a.qualification,
        specialization: a.specialization, experience: a.experience, currentSalary: a.currentSalary,
        expectedSalary: a.expectedSalary, noticePeriod: a.noticePeriod, hasResume: a.hasResume, resumeFile: a.resumeFile,
      },
      job: { jobId: j.id, title: j.title, jobType: a.jobType, status: j.status },
      application: {
        applicationId: a.applicationId, reference: a.reference, applicationDate: a.applicationDate,
        stage: a.stage, stageLabel: a.stageLabel, status: a.status, version: a.version,
        updatedAt: a.updatedAt, updatedBy: a.updatedBy, rating: out.nr.rating,
      },
      walkin: j.posting_kind === 'walkin' ? {
        date: j.walkin_date || '', startTime: j.walkin_from || '', endTime: j.walkin_to || '',
        when: whenText(jobDetails(j)), venue: j.walkin_venue || '', address: j.walkin_address || '',
        mapLink: j.walkin_map_link || '', contactPerson: j.walkin_contact || '', contactNumber: j.walkin_phone || '',
        checkedInAt: a.checkedInAt, checkedInBy: out.appRow.checked_in_name || null,
        attendedAt: a.attendedAt, attendedBy: out.appRow.attended_name || null,
        interviewedAt: a.interviewedAt, status: walkinStatus(j),
      } : null,
      otherApplications: out.others.map((o) => ({
        applicationId: o.id, reference: o.reference || o.id, jobId: o.job_id, jobTitle: o.title,
        jobType: o.posting_kind === 'walkin' ? 'Walk-in' : 'Regular', stage: o.stage, stageLabel: o.label || o.stage,
        status: o.application_status, applicationDate: iso(o.applied_at),
      })),
      notes: out.nr.notes,
      timeline: out.timeline,
    });
  }));

  r.get('/ats/applications/:id/timeline', requireAuth(), requireRole(...STAFF), wrap(async (req, res) => {
    const t = await withUser(req.session, async (c) => {
      await loadApplication(c, req.params.id);
      return timeline(c, req.params.id);
    });
    res.json({ timeline: t });
  }));

  /* ---------------- stage moves ---------------- */

  /**
   * After a REGULAR job's application moves, the candidate is told exactly
   * as PUT /applications/:id/status tells them (same stage rules, same
   * wording). Walk-in moves never message anybody (23.18).
   */
  async function tellCandidate(session, moved) {
    for (const m of moved) {
      try {
        const info = await withUser(session, async (c) => (await c.query(
          `select a.id, a.candidate_id, a.job_id, a.stage, j.title, j.posting_kind, co.name as company,
                  s.label, s.candidate_label, s.notify_candidate
             from applications a join jobs j on j.id = a.job_id
             left join companies co on co.id = j.company_id
             left join stages s on s.id = a.stage where a.id = $1`, [m.id])).rows[0]);
        if (!info || info.posting_kind === 'walkin' || info.notify_candidate === false) continue;
        const candidateLabel = info.candidate_label || info.label;
        await withUser(session, (c) => c.query(
          `select notify_create($1,$2,'candidate','APPLICATION_STATUS',$3,$4,$5,$6,$7,null,$8)`,
          [newId('ntf'), info.candidate_id, `Application ${candidateLabel}`,
           `Your application for ${info.title || 'a role'} at ${info.company || 'the company'} is now ${candidateLabel}.`,
           info.job_id, info.id, info.candidate_id, JSON.stringify({ stage: info.stage, label: candidateLabel })]));
        await dispatchEvent(session, 'STAGE_CHANGED', { applicationId: info.id, stage: info.stage, stageLabel: candidateLabel, note: null });
      } catch (err) {
        console.error('[walkin-ats] candidate notification failed:', err.message);
      }
    }
  }

  r.post('/ats/applications/:id/stage', requireAuth(), requireRole(...STAFF), wrap(async (req, res) => {
    const b = parse(z.object({
      stage: z.string().trim().min(1).max(40),
      reason: z.string().trim().max(1000).optional(),
      expectedVersion: z.number().int().min(1).optional(),
    }), req.body);
    const out = await withUser(req.session, async (c) => (await c.query(
      `select ats_move_stage($1,$2,$3,$4,'recruiter') as r`,
      [req.params.id, b.stage, b.reason || null, b.expectedVersion ?? null])).rows[0].r);
    if (out.changed) await tellCandidate(req.session, [out]);
    res.json({ result: out });
  }));

  r.post('/ats/applications/bulk-stage', requireAuth(), requireRole(...STAFF), wrap(async (req, res) => {
    const b = parse(z.object({
      items: z.array(z.object({ id: z.string().trim().min(1).max(80), version: z.number().int().min(1).optional() }))
        .min(1, 'Select at least one applicant.').max(200, 'Up to 200 applicants can be updated at once.'),
      stage: z.string().trim().min(1).max(40),
      reason: z.string().trim().max(1000).optional(),
    }), req.body);
    const seen = new Set();
    const items = b.items.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true)));
    const out = await withUser(req.session, async (c) => (await c.query(
      `select ats_bulk_move($1::jsonb,$2,$3) as r`, [JSON.stringify(items), b.stage, b.reason || null])).rows[0].r);
    await tellCandidate(req.session, out.updated);
    const n = out.updated.length, m = out.skipped.length;
    res.json({
      updated: out.updated, skipped: out.skipped,
      summary: `${n} updated, ${m} skipped${m ? ' (' + [...new Set(out.skipped.map((s) => s.code === 'TLW01' ? 'invalid transition'
        : s.code === 'TLW03' ? 'updated by someone else' : s.code === 'TLW02' ? 'reason required'
          : s.code === 'SAME_STAGE' ? 'already at that stage' : s.code === 'TLW06' ? 'not accessible' : 'refused'))].join(', ') + ')' : ''}`,
    });
  }));

  /* ---------------- check-in (walk-in) ---------------- */

  r.get('/jobs/:id/check-in', requireAuth(), requireRole(...STAFF), wrap(async (req, res) => {
    const out = await withUser(req.session, async (c) => {
      const job = await myJob(c, req.params.id);
      if (job.posting_kind !== 'walkin') throw badRequest('Check-in is only for walk-in jobs.');
      const q = String(req.query.q || '').trim();
      let rows = [];
      if (q) {
        const found = await findApplicants(c, { q, jobId: job.id }, { limit: 25, job });
        rows = (await applicantRows(c, found.ids)).sort((x, y) => String(x.name).localeCompare(String(y.name)));
      }
      return { job: jobSummary(job, await stageCounts(c, job.id)), rows };
    });
    res.json({ job: out.job, results: out.rows.map(applicantRow) });
  }));

  const checkInSchema = z.object({
    action: z.enum(['check_in', 'attend', 'both']),
    reason: z.string().trim().max(500).optional(),
    expectedVersion: z.number().int().min(1).optional(),
  });

  async function doCheckIn(session, appId, b) {
    return withUser(session, async (c) => (await c.query(
      `select ats_check_in($1,$2,$3,$4,$5) as r`,
      [appId, b.action !== 'attend', b.action !== 'check_in', b.reason || null, b.expectedVersion ?? null])).rows[0].r);
  }

  r.post('/ats/applications/:id/check-in', requireAuth(), requireRole(...STAFF), wrap(async (req, res) => {
    const b = parse(checkInSchema, req.body);
    res.json({ result: await doCheckIn(req.session, req.params.id, b) });
  }));

  r.post('/jobs/:id/check-in/quick', requireAuth(), requireRole(...STAFF), wrap(async (req, res) => {
    const b = parse(checkInSchema.extend({ code: z.string().trim().min(3).max(80) }), req.body);
    const app = await withUser(req.session, async (c) => {
      const job = await myJob(c, req.params.id);
      const code = b.code.replace(/^.*[?&#]app(?:lication)?=/i, '').trim();
      const found = (await c.query(
        `select a.id from applications a where a.job_id = $1 and (a.id = $2 or upper(a.reference) = upper($2))`,
        [job.id, code])).rows[0];
      if (!found) throw notFound('No application with that ID on this walk-in.');
      return found;
    });
    res.json({ applicationId: app.id, result: await doCheckIn(req.session, app.id, b) });
  }));

  /* ---------------- notes (23.11) ---------------- */

  r.get('/ats/applications/:id/notes', requireAuth(), requireRole(...STAFF), wrap(async (req, res) => {
    const out = await withUser(req.session, async (c) => {
      await loadApplication(c, req.params.id);
      return notesAndRatings(c, req.params.id, req.session);
    });
    res.json({ notes: out.notes });
  }));

  r.post('/ats/applications/:id/notes', requireAuth(), requireRole(...STAFF), wrap(async (req, res) => {
    const b = parse(z.object({ note: z.string().max(4000) }), req.body);
    const note = cleanText(b.note);
    if (!note) throw badRequest('Write a note first.');
    const id = await withUser(req.session, async (c) => {
      const a = await loadApplication(c, req.params.id);
      return (await c.query(
        `insert into application_notes (application_id, candidate_id, job_id, note, created_by)
         values ($1,$2,$3,$4,$5) returning id`, [a.id, a.candidate_id, a.job_id, note, req.session.userId])).rows[0].id;
    });
    res.status(201).json({ noteId: Number(id) });
  }));

  r.put('/ats/notes/:id', requireAuth(), requireRole(...STAFF), wrap(async (req, res) => {
    const b = parse(z.object({ note: z.string().max(4000) }), req.body);
    const note = cleanText(b.note);
    if (!note) throw badRequest('A note cannot be empty.');
    await withUser(req.session, async (c) => {
      const upd = await c.query(`update application_notes set note=$1, updated_at=now() where id=$2 returning id`,
        [note, Number(req.params.id) || 0]);
      if (!upd.rowCount) {
        const seen = await c.query(`select 1 from application_notes where id=$1`, [Number(req.params.id) || 0]);
        throw seen.rowCount ? forbidden('Only the author can edit a note.') : notFound('That note does not exist.');
      }
    });
    res.json({ ok: true });
  }));

  r.delete('/ats/notes/:id', requireAuth(), requireRole(...STAFF), wrap(async (req, res) => {
    await withUser(req.session, async (c) => {
      const del = await c.query(`delete from application_notes where id=$1 returning id`, [Number(req.params.id) || 0]);
      if (!del.rowCount) {
        const seen = await c.query(`select 1 from application_notes where id=$1`, [Number(req.params.id) || 0]);
        throw seen.rowCount ? forbidden('Only the author or an administrator can delete a note.') : notFound('That note does not exist.');
      }
    });
    res.json({ ok: true });
  }));

  /* ---------------- rating (23.12) ---------------- */

  r.put('/ats/applications/:id/rating', requireAuth(), requireRole(...STAFF), wrap(async (req, res) => {
    const b = parse(z.object({ rating: z.number().int().min(1).max(5) }), req.body);
    const out = await withUser(req.session, async (c) => {
      await loadApplication(c, req.params.id);
      await c.query(
        `insert into application_ratings (application_id, rated_by, rating) values ($1,$2,$3)
         on conflict (application_id, rated_by) do update set rating = excluded.rating, rated_at = now()`,
        [req.params.id, req.session.userId, b.rating]);
      return (await notesAndRatings(c, req.params.id, req.session)).rating;
    });
    res.json({ rating: out });
  }));

  /* ---------------- resume (23.10) ---------------- */

  /**
   * The resume this application was made with, streamed to the candidate
   * themselves, a recruiter who manages the application, or an admin.
   * Nobody else - not another recruiter, not a BDE, not a signed-out
   * visitor - and every view and download is logged first.
   *
   * The application's snapshot path is used only when it is one of THIS
   * candidate's own files: the path arrives from the browser at apply
   * time, and trusting it would let somebody attach another person's CV.
   */
  r.get('/ats/applications/:id/resume', requireAuth(), wrap(async (req, res) => {
    const download = req.query.download === '1' || req.query.download === 'true';
    const file = await withUser(req.session, async (c) => {
      const row = (await c.query(
        `select a.id, a.candidate_id, a.resume_path, c.resume_storage_path, c.resume_file, c.resume_mime
           from applications a join candidates c on c.id = a.candidate_id
          where a.id = $1
            and ((app_role() = 'candidate' and a.candidate_id = app_candidate_id())
                 or (app_role() in ('recruiter', 'admin') and ats_can_manage(a.id)))`, [req.params.id])).rows[0];
      if (!row) return null;
      const own = row.resume_path && String(row.resume_path).startsWith(`candidates/${row.candidate_id}/`);
      const path = own ? row.resume_path : row.resume_storage_path;
      if (!path) return { none: true };
      await c.query(
        `insert into resume_access_log (application_id, candidate_id, accessed_by, actor_role, action, file_path, ip)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [row.id, row.candidate_id, req.session.userId, req.session.role, download ? 'download' : 'view', path, req.ip || null]);
      return { path, name: row.resume_file || 'resume', mime: own && path !== row.resume_storage_path ? null : row.resume_mime };
    });
    if (!file) throw notFound('That resume is not available to you.');
    if (file.none) throw notFound('No resume has been uploaded for this application.');
    const buf = await getStorage().get(file.path);
    const ext = (file.path.match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase();
    const mime = file.mime || ({ pdf: 'application/pdf', doc: 'application/msword', txt: 'text/plain; charset=utf-8',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', jpg: 'image/jpeg', png: 'image/png' }[ext]
      || 'application/octet-stream');
    const inline = !download && /^(application\/pdf|image\/(jpeg|png))$/.test(mime);
    const name = String(file.name).replace(/["\r\n]/g, '');
    res.setHeader('content-type', mime);
    res.setHeader('content-disposition', `${inline ? 'inline' : 'attachment'}; filename="${name}"`);
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('cache-control', 'private, no-store');
    // only PDFs and images are ever shown inline; nosniff stops anything
    // else being read as a page, and every other type is an attachment
    res.send(buf);
  }));

  /* ---------------- Selected / Rejected message (23.18) ---------------- */

  r.get('/ats/applications/:id/decision-template', requireAuth(), requireRole(...STAFF), wrap(async (req, res) => {
    const kind = req.query.kind === 'selected' ? 'selected' : 'rejected';
    const row = await withUser(req.session, (c) => loadApplication(c, req.params.id));
    res.json({ kind, ...decisionTemplate(kind, { name: row.name, jobTitle: row.title, jobId: row.job_id }) });
  }));

  r.post('/ats/applications/:id/decision-message', requireAuth(), requireRole(...STAFF), wrap(async (req, res) => {
    const b = parse(z.object({
      kind: z.enum(['selected', 'rejected']),
      subject: z.string().trim().min(3).max(200),
      body: z.string().trim().min(10).max(4000),
    }), req.body);
    const row = await withUser(req.session, (c) => loadApplication(c, req.params.id));
    if (row.stage !== b.kind) {
      throw new ApiError(409, 'STAGE_MISMATCH',
        `Move the applicant to ${b.kind === 'selected' ? 'Selected' : 'Rejected'} before sending this message.`);
    }
    const lower = `${b.subject} ${b.body}`.toLowerCase();
    if (/\bclient\b/.test(lower)) throw badRequest('Candidate messages never mention a client. Please reword it.');
    const out = await sendDecision(row.id, b.kind, { subject: cleanText(b.subject), body: cleanText(b.body), actorUserId: req.session.userId });
    res.json({ sent: true, channels: out ? out.channels : {} });
  }));

  /* ---------------- export (16 + 23.19) ---------------- */

  r.post('/jobs/:id/applicants/export', requireAuth(), requireRole(...STAFF), wrap(async (req, res) => {
    const b = parse(z.object({
      format: z.enum(['csv', 'xlsx']).default('csv'),
      includeNotes: z.boolean().default(false),
      filters: z.object({
        q: z.string().max(120).optional(), stage: z.string().max(40).optional(),
        status: z.string().max(20).optional(), from: z.string().max(10).optional(), to: z.string().max(10).optional(),
      }).partial().optional(),
    }), req.body);
    const out = await withUser(req.session, async (c) => {
      const job = await myJob(c, req.params.id);
      const found = await findApplicants(c, { ...(b.filters || {}), jobId: job.id }, { job });
      const rows = (await applicantRows(c, found.ids)).reverse();
      let notes = {};
      if (b.includeNotes && rows.length) {
        for (const n of (await c.query(
          `select application_id, note, ats_actor_name(created_by) as who, created_at from application_notes
            where application_id = any($1::text[]) order by created_at`, [rows.map((x) => x.id)])).rows) {
          (notes[n.application_id] = notes[n.application_id] || []).push(`${n.who || 'Recruiter'}: ${n.note}`);
        }
      }
      await c.query(`select export_audit_record($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [
        req.session.userId || null, req.session.role, req.session.email || null,
        b.format === 'xlsx' ? 'list_xlsx' : 'list_csv', 'filtered', rows.length, 0, 0,
        JSON.stringify({ jobId: job.id, applicants: true, includeNotes: b.includeNotes, ...(b.filters || {}) }),
        [], req.ip || null, req.get('user-agent') || null]);
      return { job, rows, notes };
    });
    const ist = (v) => (v ? new Date(new Date(v).getTime() + 330 * 60000).toISOString().replace('T', ' ').slice(0, 16) : '');
    const wStatus = walkinStatus(out.job);
    const header = ['Application ID', 'Candidate ID', 'Name', 'Mobile', 'Email', 'Job ID', 'Job Title', 'Job Type',
      'Application Date', 'Stage', 'Status', 'Attended', 'Rating', 'Checked-in time', 'Attended time',
      'Interviewed time', 'Walk-in status', 'Application Source'];
    if (b.includeNotes) header.push('Recruiter notes');
    const table = out.rows.map((r0) => {
      const a = applicantRow(r0);
      const walkin = a.jobType === 'Walk-in';
      const row = [a.reference, a.candidateId, a.candidateName, a.mobile, a.email, a.jobId, a.jobTitle, a.jobType,
        ist(a.applicationDate), a.stageLabel, a.status,
        walkin ? (a.attendedAt || ['attended', 'interviewed', 'selected'].includes(a.stage) ? 'Yes' : 'No') : '',
        a.rating == null ? '' : String(a.rating), ist(a.checkedInAt), ist(a.attendedAt), ist(a.interviewedAt),
        walkin ? (wStatus === 'open' ? 'Open' : 'Closed') : '', a.source];
      if (b.includeNotes) row.push((out.notes[a.applicationId] || []).join(' | '));
      return row;
    });
    const stamp = new Date().toISOString().slice(0, 10);
    const base = `teamlink-applicants-${out.job.id}-${stamp}`.replace(/[^A-Za-z0-9_.-]/g, '-');
    res.setHeader('x-content-type-options', 'nosniff');
    if (b.format === 'xlsx') {
      res.setHeader('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('content-disposition', `attachment; filename="${base}.xlsx"`);
      return res.send(writeSheet(header, table, 'Applicants'));
    }
    const cell = (v) => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="${base}.csv"`);
    return res.send('﻿' + [header, ...table].map((l) => l.map(cell).join(',')).join('\r\n'));
  }));

  /* ---------------- job update history + reschedules (23.14 / 23.15) ---------------- */

  r.get('/jobs/:id/update-history', requireAuth(), requireRole(...STAFF), wrap(async (req, res) => {
    const out = await withUser(req.session, async (c) => {
      await myJob(c, req.params.id);
      return {
        history: (await c.query(
          `select h.id, h.field, h.old_value, h.new_value, h.updated_at, ats_actor_name(h.updated_by) as who, h.updated_by
             from job_update_history h where h.job_id = $1 order by h.updated_at desc, h.id desc limit 300`, [req.params.id])).rows,
        reschedules: (await c.query(
          `select * from walkin_reschedules where job_id = $1 order by id desc limit 50`, [req.params.id])).rows,
      };
    });
    res.json({
      history: out.history.map((h) => ({
        id: Number(h.id), field: h.field, label: FIELD_LABELS[h.field] || h.field,
        oldValue: h.old_value, newValue: h.new_value, updatedAt: iso(h.updated_at),
        updatedBy: h.who || (h.updated_by ? 'Recruiter' : 'System'),
      })),
      reschedules: out.reschedules.map((x) => ({
        id: Number(x.id), status: x.status, changedFields: x.changed_fields, oldDetails: x.old_details,
        newDetails: x.new_details, firstChangeAt: iso(x.first_change_at), lastChangeAt: iso(x.last_change_at),
        sentAt: iso(x.sent_at), recipients: x.recipients, delivered: x.delivered, failed: x.failed, error: x.error,
        mergeWindowSeconds: Math.round(Number(process.env.WALKIN_RESCHEDULE_MERGE_MS || 120000) / 1000),
      })),
    });
  }));

  r.post('/jobs/:id/reschedules/:rid/:action(retry|send-now)', requireAuth(), requireRole(...STAFF), wrap(async (req, res) => {
    const rid = Number(req.params.rid) || 0;
    const state = await withUser(req.session, async (c) => {
      await myJob(c, req.params.id);
      const own = await c.query(`select 1 from walkin_reschedules where id=$1 and job_id=$2`, [rid, req.params.id]);
      if (!own.rowCount) throw notFound('That notification does not exist.');
      return (await c.query(`select walkin_reschedule_request($1,$2) as s`,
        [rid, req.params.action === 'retry' ? 'retry' : 'send_now'])).rows[0].s;
    });
    let result = null;
    if (state === 'queued' || state === 'retrying') {
      if (state === 'queued') {
        // brought forward: send it now rather than at the next tick
        await withUser({ userId: '', role: 'admin' }, (c) => c.query(
          `update walkin_reschedules set status='sending' where id=$1 and status='pending'`, [rid]));
      }
      result = await sendReschedule(rid);
    }
    res.json({ state, result });
  }));

  /* ---------------- settings ---------------- */

  r.get('/jobs/:id/ats-settings', requireAuth(), requireRole(...STAFF), wrap(async (req, res) => {
    const s = await withUser(req.session, async (c) => {
      await myJob(c, req.params.id);
      return (await c.query(`select new_application_alerts from job_ats_settings where job_id=$1`, [req.params.id])).rows[0];
    });
    res.json({ newApplicationAlerts: s ? s.new_application_alerts : 'auto' });
  }));

  r.put('/jobs/:id/ats-settings', requireAuth(), requireRole(...STAFF), wrap(async (req, res) => {
    const b = parse(z.object({ newApplicationAlerts: z.enum(['auto', 'instant', 'digest', 'off']) }), req.body);
    await withUser(req.session, async (c) => {
      await myJob(c, req.params.id);
      await c.query(
        `insert into job_ats_settings (job_id, new_application_alerts, updated_by) values ($1,$2,$3)
         on conflict (job_id) do update set new_application_alerts = excluded.new_application_alerts,
           updated_by = excluded.updated_by, updated_at = now()`, [req.params.id, b.newApplicationAlerts, req.session.userId]);
    });
    res.json({ newApplicationAlerts: b.newApplicationAlerts });
  }));

  r.get('/admin/walkin-ats/settings', requireAuth(), requireRole('admin'), wrap(async (req, res) => {
    const s = await withUser(req.session, async (c) => (await c.query(`select * from walkin_ats_settings where id=1`)).rows[0]);
    res.json({
      noShowGraceMinutes: process.env.WALKIN_NO_SHOW_GRACE_MINUTES ? Number(process.env.WALKIN_NO_SHOW_GRACE_MINUTES) : s.no_show_grace_minutes,
      fromEnvironment: !!process.env.WALKIN_NO_SHOW_GRACE_MINUTES,
      highVolumePerDay: s.high_volume_per_day, installedAt: iso(s.installed_at),
    });
  }));

  r.put('/admin/walkin-ats/settings', requireAuth(), requireRole('admin'), wrap(async (req, res) => {
    const b = parse(z.object({
      noShowGraceMinutes: z.number().int().min(0).max(1440).optional(),
      highVolumePerDay: z.number().int().min(1).max(10000).optional(),
    }), req.body);
    await withUser(req.session, (c) => c.query(
      `update walkin_ats_settings set no_show_grace_minutes = coalesce($1, no_show_grace_minutes),
              high_volume_per_day = coalesce($2, high_volume_per_day) where id = 1`,
      [b.noShowGraceMinutes ?? null, b.highVolumePerDay ?? null]));
    res.json({ ok: true });
  }));

  /* ---------------- the candidate's own applications (23.18) ---------------- */

  /**
   * In the candidate's words only: no notes, no ratings, no history, no
   * internal stage name (the `stage` id is not even sent), "Missed"
   * rather than No Show. The walk-in details while the drive is upcoming.
   */
  r.get('/my/applications-status', requireAuth(), requireRole('candidate'), wrap(async (req, res) => {
    const rows = await withUser(req.session, async (c) => (await c.query(
      `select a.id, a.reference, a.job_id, a.applied_at, a.stage, j.title, j.posting_kind,
              j.walkin_date, j.walkin_from, j.walkin_to, j.walkin_venue, j.walkin_address, j.walkin_map_link,
              j.walkin_contact, j.walkin_phone, j.walkin_documents, j.walkin_instructions,
              j.status as job_status, j.paused, j.archived,
              walkin_ends_at(j.walkin_date, j.walkin_to) as ends_at,
              candidate_status_label(a.stage, case when j.posting_kind = 'walkin' then 'walkin' else 'regular' end) as cstatus
         from applications a join jobs j on j.id = a.job_id
        where a.candidate_id = app_candidate_id()
        order by a.applied_at desc`)).rows);
    res.json({
      applications: rows.map((x) => {
        const walkin = x.posting_kind === 'walkin';
        const upcoming = walkin && x.ends_at && new Date(x.ends_at).getTime() > Date.now();
        return {
          applicationId: x.id, reference: x.reference || x.id, jobId: x.job_id, jobTitle: x.title,
          jobType: walkin ? 'Walk-in' : 'Regular', applicationDate: iso(x.applied_at), status: x.cstatus,
          walkin: upcoming && x.stage === 'registered' ? {
            date: x.walkin_date, startTime: x.walkin_from || '', endTime: x.walkin_to || '',
            when: whenText(jobDetails(x)), venue: x.walkin_venue || '', address: x.walkin_address || '',
            mapLink: x.walkin_map_link || '', contactPerson: x.walkin_contact || '', contactNumber: x.walkin_phone || '',
            documents: jobDetails(x).documents, instructions: x.walkin_instructions || '',
          } : null,
        };
      }),
    });
  }));

  return r;
}
