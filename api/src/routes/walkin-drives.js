/**
 * Walk-in drives (0099).
 *
 * Public (anyone; signed-out visitors included - 0103):
 *   GET    /api/public/walkin-drives          upcoming + ongoing, public-safe fields only
 *                                             ?city=&role=&date=YYYY-MM-DD&q=
 *   GET    /api/public/walkin-drives/:id      one upcoming/ongoing drive
 *
 * Candidate (signed in, role candidate):
 *   GET    /api/walkin-drives                 upcoming + ongoing, nearest first
 *                                             ?city=&role=&date=YYYY-MM-DD&q=
 *   GET    /api/walkin-drives/:id             one drive (and my registration)
 *   GET    /api/walkin-drives/:id/calendar.ics  "Add to Calendar"
 *   POST   /api/walkin-drives/:id/register    register (not twice, not full, not past)
 *   DELETE /api/walkin-drives/:id/register    cancel my registration
 *   GET    /api/my-walkin-registrations       upcoming and past
 *
 * Recruiter (their own drives) and admin (all):
 *   GET    /api/recruiter/walkin-drives       ?status=&city=&recruiterId=&from=&to=&q=
 *   POST   /api/recruiter/walkin-drives
 *   GET    /api/recruiter/walkin-drives/:id
 *   PUT    /api/recruiter/walkin-drives/:id
 *   DELETE /api/recruiter/walkin-drives/:id   cancel (the row stays; registered people are told)
 *   GET    /api/recruiter/walkin-drives/:id/registrations        ?q=&status=
 *   PATCH  /api/recruiter/walkin-drives/:id/registrations/:regId { status: ATTENDED|NO_SHOW|REGISTERED }
 *   GET    /api/recruiter/walkin-drives/:id/registrations/export ?format=csv|xlsx
 *
 * Row level security decides who sees which drive and registration; the
 * routes validate input and turn the database's refusals into sentences.
 */
import { Router } from 'express';
import { z } from 'zod';
import { withUser } from '../db.js';
import { wrap, badRequest, notFound, forbidden, ApiError, fromPgError } from '../errors.js';
import { requireAuth, requireRole } from '../auth.js';
import { toCandidate } from '../shapes.js';
import { matchCandidate } from '../ai/match.js';
import { writeSheet } from '../xlsx.js';
import {
  background, notifyRegistered, notifyDriveChange, istDate, driveInstant, dateLabel, time12,
} from '../notify/walkin.js';

const STATUSES = ['UPCOMING', 'ONGOING', 'COMPLETED', 'CANCELLED'];
const REG_STATUSES = ['REGISTERED', 'ATTENDED', 'NO_SHOW', 'CANCELLED'];

const newId = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const hm = (t) => (t == null ? null : String(t).slice(0, 5));
const iso = (v) => (v ? new Date(v).toISOString() : null);

/* ------------------------------------------------------------------ *
 * input
 * ------------------------------------------------------------------ */

const str = (max) => z.string().trim().max(max);
const optStr = (max) => z.union([z.string().trim().max(max), z.null()]).optional()
  .transform((v) => (v == null || v === '' ? null : v));
const list = (n, max) => z.array(z.string().trim().min(1).max(max)).max(n).optional()
  .transform((v) => (v ? [...new Set(v)] : v));

const driveBody = z.object({
  title: str(120).min(3, 'Give the drive a title of at least 3 characters.'),
  companyId: optStr(60),
  jobId: optStr(60),
  jobRole: str(120).min(2, 'Say which role this drive is hiring for.'),
  description: optStr(5000),
  driveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date picker (YYYY-MM-DD).'),
  startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Start time must be HH:MM.'),
  endTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'End time must be HH:MM.'),
  venueName: str(160).min(2, 'Name the venue.'),
  fullAddress: str(500).min(5, 'Give the full address.'),
  city: str(80).min(2, 'Give the city.'),
  mapLink: z.union([z.string().trim().max(500).regex(/^https:\/\/\S+$/i, 'The map link must start with https://'),
                    z.literal(''), z.null()]).optional().transform((v) => v || null),
  salaryRange: optStr(80),
  experienceRequired: optStr(80),
  qualification: optStr(160),
  skills: list(30, 60),
  documentsToCarry: list(20, 120),
  contactPersonName: optStr(80),
  contactPhone: z.union([z.string().trim().regex(/^[0-9+()\- ]{6,20}$/, 'Enter a valid phone number.'),
                         z.literal(''), z.null()]).optional().transform((v) => v || null),
  maxSeats: z.union([z.number().int('Seats must be a whole number.').min(1, 'Seats must be at least 1.').max(100000, 'Seats can be at most 100000.'), z.null()]).optional(),
}).strict();

function parse(schema, input) {
  const r = schema.safeParse(input || {});
  if (!r.success) {
    const details = {};
    for (const i of r.error.issues) details[i.path.join('.') || 'form'] = i.message;
    const first = r.error.issues[0];
    throw badRequest(first && first.message && !/^(Expected|Required|Invalid|Unrecognized|Number must|String must|Array must)/.test(first.message)
      ? first.message : 'Please check the highlighted fields and try again.', details);
  }
  return r.data;
}

function realDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function checkTimes(b, { creating }) {
  if (!realDate(b.driveDate)) throw badRequest('That date does not exist.', { driveDate: 'Not a real date.' });
  if (b.endTime <= b.startTime) {
    throw badRequest('The drive must end after it starts.', { endTime: 'End time is before the start time.' });
  }
  if (driveInstant(b.driveDate, b.endTime) <= Date.now()) {
    throw badRequest(creating ? 'A drive cannot be scheduled in the past.' : 'A drive cannot be moved into the past.',
      { driveDate: 'This date and end time have already passed.' });
  }
  const limit = new Date(Date.now() + 366 * 86400000).toISOString().slice(0, 10);
  if (b.driveDate > limit) throw badRequest('Schedule drives at most a year ahead.', { driveDate: 'Too far ahead.' });
}

/* ------------------------------------------------------------------ *
 * output
 * ------------------------------------------------------------------ */

function shapeDrive(r, extra = {}) {
  const status = r.live_status || r.status;
  const startsAt = driveInstant(r.drive_date, hm(r.start_time));
  const today = istDate();
  const daysLeft = Math.round((Date.UTC(...r.drive_date.split('-').map((n, i) => (i === 1 ? n - 1 : +n)))
    - Date.UTC(...today.split('-').map((n, i) => (i === 1 ? n - 1 : +n)))) / 86400000);
  return {
    id: r.id,
    title: r.title,
    companyId: r.company_id || null,
    companyName: r.company_name || '',
    jobId: r.job_id || null,
    jobRole: r.job_role,
    description: r.description || '',
    driveDate: r.drive_date,
    startTime: hm(r.start_time),
    endTime: hm(r.end_time),
    dateLabel: dateLabel(r.drive_date),
    timeLabel: `${time12(r.start_time)} - ${time12(r.end_time)}`,
    startsAt: new Date(startsAt).toISOString(),
    endsAt: new Date(driveInstant(r.drive_date, hm(r.end_time))).toISOString(),
    daysLeft,
    venueName: r.venue_name,
    fullAddress: r.full_address,
    city: r.city,
    mapLink: r.map_link || null,
    salaryRange: r.salary_range || '',
    experienceRequired: r.experience_required || '',
    qualification: r.qualification || '',
    skills: r.skills || [],
    documentsToCarry: r.documents_to_carry || [],
    contactPersonName: r.contact_person_name || '',
    contactPhone: r.contact_phone || '',
    maxSeats: r.max_seats == null ? null : Number(r.max_seats),
    seatsTaken: Number(r.seats_taken || 0),
    seatsLeft: r.max_seats == null ? null : Math.max(0, Number(r.max_seats) - Number(r.seats_taken || 0)),
    status,
    cancelReason: r.cancel_reason || '',
    version: r.version,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    ...extra,
  };
}

/**
 * What a signed-out visitor is shown (0103). Built field by field from the
 * public function's columns, never by spreading a drive row, so a column
 * added to walkin_drives later cannot reach the public page by accident.
 */
function shapePublicDrive(r) {
  const d = shapeDrive({ ...r, status: r.live_status });
  return {
    id: d.id,
    title: d.title,
    companyName: d.companyName,
    jobRole: d.jobRole,
    description: d.description,
    driveDate: d.driveDate,
    startTime: d.startTime,
    endTime: d.endTime,
    dateLabel: d.dateLabel,
    timeLabel: d.timeLabel,
    startsAt: d.startsAt,
    endsAt: d.endsAt,
    daysLeft: d.daysLeft,
    venueName: d.venueName,
    fullAddress: d.fullAddress,
    city: d.city,
    mapLink: d.mapLink,
    salaryRange: d.salaryRange,
    experienceRequired: d.experienceRequired,
    qualification: d.qualification,
    skills: d.skills,
    documentsToCarry: d.documentsToCarry,
    maxSeats: d.maxSeats,
    seatsTaken: d.seatsTaken,
    seatsLeft: d.seatsLeft,
    status: d.status,
  };
}

const listQuery = z.object({
  city: z.string().trim().max(80).optional(),
  role: z.string().trim().max(120).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('')),
  q: z.string().trim().max(120).optional(),
}).passthrough();

function shapeRegistration(r) {
  return {
    id: r.id,
    driveId: r.drive_id,
    candidateId: r.candidate_id,
    status: r.status,
    registeredAt: iso(r.registered_at),
    cancelledAt: iso(r.cancelled_at),
    attendanceMarkedAt: iso(r.attendance_marked_at),
  };
}

const SELECT = `
  select d.*, co.name as company_name,
         walkin_live_status(d.status, d.drive_date, d.start_time, d.end_time) as live_status,
         coalesce(s.taken, 0) as seats_taken
    from walkin_drives d
    left join companies co on co.id = d.company_id
    left join lateral (select taken from walkin_seats_taken(array[d.id])) s on true`;

/** AI match: the portal's own engine, against the drive as a job would read. */
function matchFor(drive, cand) {
  if (!cand) return null;
  const job = {
    title: drive.job_role || drive.title,
    skills: drive.skills || [],
    exp: drive.experience_required || '',
    location: drive.city,
    education: drive.qualification || '',
    mode: 'Onsite',
  };
  const m = matchCandidate(job, cand);
  const roleHit = (m.breakdown.role && m.breakdown.role.score > 0 && !m.breakdown.role.weak)
    || (m.matchedSkills || []).length > 0;
  // "Where the role matches the candidate's profile" - otherwise no number
  // at all, rather than a low one that reads as a verdict.
  if (!roleHit) return null;
  return { score: m.score, matchedSkills: m.matchedSkills || [], missingSkills: (m.breakdown.skills && m.breakdown.skills.missing) || [] };
}

/** The database's refusals, said plainly. */
function explain(err) {
  const msg = String(err && err.message || '');
  if (/walkin_not_found/.test(msg)) return notFound('That walk-in drive could not be found.');
  if (/walkin_closed/.test(msg)) {
    return new ApiError(409, 'WALKIN_CLOSED', /cancelled/.test(msg)
      ? 'This drive has been cancelled, so registration is closed.'
      : 'This drive has already taken place, so registration is closed.');
  }
  if (/walkin_full/.test(msg)) return new ApiError(409, 'WALKIN_FULL', 'Sorry, all seats for this drive are taken.');
  if (/walkin_duplicate/.test(msg)) return new ApiError(409, 'WALKIN_ALREADY_REGISTERED', 'You are already registered for this drive.');
  if (/walkin_not_registered/.test(msg)) return new ApiError(409, 'WALKIN_NOT_REGISTERED', 'You do not have an active registration for this drive.');
  if (/walkin_not_candidate/.test(msg)) return forbidden('Only a signed-in candidate can register for a walk-in drive.');
  return fromPgError(err) || err;
}

const csvCell = (v) => {
  let s = v == null ? '' : String(v);
  // a cell that starts like a formula is run by Excel - neutralise it
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const icsEsc = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const icsStamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** Prefill a drive from the walk-in job posting it is for (0083 columns). */
function fromJob(job) {
  const t = (v) => {
    const m = String(v || '').trim().match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/i);
    if (!m) return null;
    let h = Number(m[1]);
    if (m[3]) { const pm = /pm/i.test(m[3]); h = (h % 12) + (pm ? 12 : 0); }
    return h < 24 ? `${String(h).padStart(2, '0')}:${m[2]}` : null;
  };
  return {
    companyId: job.company_id || null,
    skills: job.skills || [],
    salaryRange: job.pay_label || null,
    experienceRequired: job.exp_label || null,
    qualification: job.education || null,
    driveDate: /^\d{4}-\d{2}-\d{2}$/.test(job.walkin_date || '') ? job.walkin_date : null,
    startTime: t(job.walkin_from),
    endTime: t(job.walkin_to),
    contactPersonName: job.walkin_contact || null,
    contactPhone: job.walkin_phone || null,
  };
}

/* ------------------------------------------------------------------ *
 * routes
 * ------------------------------------------------------------------ */

export default function walkinDriveRoutes() {
  const r = Router();
  const candidate = [requireAuth(), requireRole('candidate')];
  const staff = [requireAuth(), requireRole('recruiter', 'admin')];

  /* ---------------- public (anyone, signed in or not) ---------------- */

  // Everything a signed-out visitor sees comes from walkin_public_drives()
  // (0103), whose column list is the public-safe decision; the shape below
  // adds only labels computed from those columns.
  r.get('/public/walkin-drives', wrap(async (req, res) => {
    const q = parse(listQuery, req.query);
    const where = ['true'];
    const vals = [];
    const add = (sql, v) => { vals.push(v); where.push(sql.replace(/\$\?/g, `$${vals.length}`)); };
    if (q.city) add(`p.city ilike $?`, `%${q.city}%`);
    if (q.role) add(`(p.job_role ilike $? or p.title ilike $?)`, `%${q.role}%`);
    if (q.date) add(`p.drive_date = $?::date`, q.date);
    if (q.q) {
      add(`(p.title ilike $? or p.job_role ilike $? or p.city ilike $? or p.venue_name ilike $?
             or coalesce(p.description,'') ilike $? or coalesce(p.company_name,'') ilike $?
             or array_to_string(p.skills, ' ') ilike $?)`, `%${q.q}%`);
    }
    const out = await withUser(null, async (c) => ({
      rows: (await c.query(`select * from walkin_public_drives() p where ${where.join(' and ')}
        order by p.drive_date, p.start_time limit 200`, vals)).rows,
      cities: (await c.query(`select distinct city from walkin_public_drives() order by 1`)).rows.map((x) => x.city),
    }));
    res.setHeader('cache-control', 'no-store');
    res.json({ drives: out.rows.map(shapePublicDrive), cities: out.cities });
  }));

  r.get('/public/walkin-drives/:id', wrap(async (req, res) => {
    const d = await withUser(null, async (c) =>
      (await c.query(`select * from walkin_public_drives($1)`, [String(req.params.id).slice(0, 80)])).rows[0]);
    if (!d) throw notFound('That walk-in drive could not be found, or it is no longer open.');
    res.setHeader('cache-control', 'no-store');
    res.json({ drive: shapePublicDrive(d) });
  }));

  /* ---------------- candidate ---------------- */

  r.get('/walkin-drives', ...candidate, wrap(async (req, res) => {
    const q = parse(listQuery, req.query);

    const where = [`walkin_live_status(d.status, d.drive_date, d.start_time, d.end_time) in ('UPCOMING','ONGOING')`];
    const vals = [];
    // each clause uses one value; every "$?" in it is that value
    const add = (sql, v) => { vals.push(v); where.push(sql.replace(/\$\?/g, `$${vals.length}`)); };
    if (q.city) add(`d.city ilike $?`, `%${q.city}%`);
    if (q.role) add(`(d.job_role ilike $? or d.title ilike $?)`, `%${q.role}%`);
    if (q.date) add(`d.drive_date = $?::date`, q.date);
    if (q.q) {
      add(`(d.title ilike $? or d.job_role ilike $? or d.city ilike $? or d.venue_name ilike $?
             or coalesce(d.description,'') ilike $? or coalesce(co.name,'') ilike $?
             or array_to_string(d.skills, ' ') ilike $?)`, `%${q.q}%`);
    }

    const out = await withUser(req.session, async (c) => {
      const rows = (await c.query(`${SELECT} where ${where.join(' and ')}
        order by d.drive_date, d.start_time limit 200`, vals)).rows;
      const mine = new Map((await c.query(
        `select * from walkin_registrations where candidate_id = $1`, [req.session.profileId])).rows
        .map((x) => [x.drive_id, x]));
      const me = (await c.query(`select * from candidates where id = $1`, [req.session.profileId])).rows[0];
      const cand = me ? toCandidate(me) : null;
      const cities = (await c.query(
        `select distinct d.city from walkin_drives d
          where walkin_live_status(d.status, d.drive_date, d.start_time, d.end_time) in ('UPCOMING','ONGOING')
          order by 1`)).rows.map((x) => x.city);
      return {
        drives: rows.map((d) => shapeDrive(d, {
          myRegistration: mine.has(d.id) ? shapeRegistration(mine.get(d.id)) : null,
          match: matchFor(d, cand),
        })),
        cities,
        myCity: cand ? (cand.preferredLocation || cand.location || '') : '',
      };
    });
    res.json(out);
  }));

  r.get('/walkin-drives/:id', ...candidate, wrap(async (req, res) => {
    const out = await withUser(req.session, async (c) => {
      const d = (await c.query(`${SELECT} where d.id = $1`, [req.params.id])).rows[0];
      if (!d) return null;
      const reg = (await c.query(
        `select * from walkin_registrations where drive_id = $1 and candidate_id = $2`,
        [d.id, req.session.profileId])).rows[0];
      const me = (await c.query(`select * from candidates where id = $1`, [req.session.profileId])).rows[0];
      return shapeDrive(d, {
        myRegistration: reg ? shapeRegistration(reg) : null,
        match: matchFor(d, me ? toCandidate(me) : null),
      });
    });
    if (!out) throw notFound('That walk-in drive could not be found, or it is no longer open.');
    res.json({ drive: out });
  }));

  r.get('/walkin-drives/:id/calendar.ics', ...candidate, wrap(async (req, res) => {
    const d = await withUser(req.session, async (c) =>
      (await c.query(`${SELECT} where d.id = $1`, [req.params.id])).rows[0]);
    if (!d) throw notFound('That walk-in drive could not be found.');
    const start = driveInstant(d.drive_date, hm(d.start_time));
    const end = driveInstant(d.drive_date, hm(d.end_time));
    const desc = [
      `Walk-in drive: ${d.title}${d.company_name ? ` (${d.company_name})` : ''}`,
      `Role: ${d.job_role}`,
      (d.documents_to_carry || []).length ? `Documents to carry: ${d.documents_to_carry.join(', ')}` : '',
      d.contact_person_name || d.contact_phone ? `Contact: ${[d.contact_person_name, d.contact_phone].filter(Boolean).join(', ')}` : '',
      d.map_link ? `Map: ${d.map_link}` : '',
    ].filter(Boolean).join('\n');
    const ics = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//TeamLink//Walk-in Drives//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
      'BEGIN:VEVENT',
      `UID:${d.id}-v${d.version}@teamlink`,
      `DTSTAMP:${icsStamp(Date.now())}`,
      `DTSTART:${icsStamp(start)}`,
      `DTEND:${icsStamp(end)}`,
      `SUMMARY:${icsEsc(`Walk-in: ${d.title}`)}`,
      `LOCATION:${icsEsc([d.venue_name, d.full_address, d.city].filter(Boolean).join(', '))}`,
      `DESCRIPTION:${icsEsc(desc)}`,
      d.live_status === 'CANCELLED' ? 'STATUS:CANCELLED' : 'STATUS:CONFIRMED',
      'BEGIN:VALARM', 'TRIGGER:-PT2H', 'ACTION:DISPLAY', `DESCRIPTION:${icsEsc(d.title)}`, 'END:VALARM',
      'END:VEVENT', 'END:VCALENDAR', '',
    ].join('\r\n');
    res.setHeader('content-type', 'text/calendar; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="walkin-${d.id}.ics"`);
    res.setHeader('x-content-type-options', 'nosniff');
    res.send(ics);
  }));

  r.post('/walkin-drives/:id/register', ...candidate, wrap(async (req, res) => {
    const out = await withUser(req.session, async (c) => {
      const row = (await c.query(`select * from walkin_register($1, $2)`,
        [req.params.id, newId('wr')])).rows[0];
      const reg = (await c.query(`select * from walkin_registrations where id = $1`, [row.registration_id])).rows[0];
      const d = (await c.query(`${SELECT} where d.id = $1`, [req.params.id])).rows[0];
      return { reg, drive: d, reregistered: row.reregistered };
    }).catch((err) => { throw explain(err); });
    // After the commit, never inside the transaction: a slow SMS gateway
    // must not hold a lock on the drive. The sweep catches a send that a
    // crash interrupts (the claim table says what went).
    background(() => notifyRegistered(out.reg.id));
    res.status(201).json({
      registration: shapeRegistration(out.reg),
      drive: shapeDrive(out.drive, { myRegistration: shapeRegistration(out.reg) }),
      reregistered: !!out.reregistered,
    });
  }));

  r.delete('/walkin-drives/:id/register', ...candidate, wrap(async (req, res) => {
    const reg = await withUser(req.session, async (c) => {
      const id = (await c.query(`select walkin_cancel($1) as id`, [req.params.id])).rows[0].id;
      return (await c.query(`select * from walkin_registrations where id = $1`, [id])).rows[0];
    }).catch((err) => { throw explain(err); });
    res.json({ registration: shapeRegistration(reg) });
  }));

  r.get('/my-walkin-registrations', ...candidate, wrap(async (req, res) => {
    const rows = await withUser(req.session, async (c) => (await c.query(
      `select r.id as reg_id, r.status as reg_status, r.registered_at, r.cancelled_at, r.attendance_marked_at,
              r.drive_id, r.candidate_id, x.*
         from walkin_registrations r
         join (${SELECT}) x on x.id = r.drive_id
        where r.candidate_id = $1
        order by x.drive_date desc, x.start_time desc`, [req.session.profileId])).rows);
    const all = rows.map((x) => shapeDrive(x, {
      myRegistration: shapeRegistration({
        id: x.reg_id, drive_id: x.drive_id, candidate_id: x.candidate_id, status: x.reg_status,
        registered_at: x.registered_at, cancelled_at: x.cancelled_at, attendance_marked_at: x.attendance_marked_at,
      }),
    }));
    const upcoming = all.filter((d) => ['UPCOMING', 'ONGOING'].includes(d.status)
      && d.myRegistration.status !== 'CANCELLED').reverse();
    const past = all.filter((d) => !upcoming.includes(d));
    res.json({ upcoming, past });
  }));

  /* ---------------- recruiter / admin ---------------- */

  async function ownDrive(c, id) {
    const d = (await c.query(`${SELECT} where d.id = $1`, [id])).rows[0];
    if (!d) throw notFound('That walk-in drive could not be found.');
    return d;
  }

  /** A drive can only point at one of the recruiter's own postings. */
  async function ownJob(c, id) {
    const job = (await c.query(
      `select * from jobs where id = $1 and (app_is_admin() or recruiter_id = app_recruiter_id())`, [id])).rows[0];
    if (!job) throw badRequest('That job posting could not be found among your jobs.', { jobId: 'Unknown job.' });
    return job;
  }

  async function counts(c, ids) {
    if (!ids.length) return new Map();
    const { rows } = await c.query(
      `select drive_id, status, count(*)::int n from walkin_registrations
        where drive_id = any($1) group by 1, 2`, [ids]);
    const m = new Map();
    for (const x of rows) {
      const o = m.get(x.drive_id) || { REGISTERED: 0, ATTENDED: 0, NO_SHOW: 0, CANCELLED: 0 };
      o[x.status] = x.n;
      m.set(x.drive_id, o);
    }
    return m;
  }

  // Filters for the list (the admin screen uses all of them; a recruiter's
  // list is already only their own drives, which RLS decides, not these).
  const staffQuery = z.object({
    status: z.enum(STATUSES).optional().or(z.literal('')),
    city: z.string().trim().max(80).optional(),
    recruiterId: z.string().trim().max(60).optional(),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date picker (YYYY-MM-DD).').optional().or(z.literal('')),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date picker (YYYY-MM-DD).').optional().or(z.literal('')),
    q: z.string().trim().max(120).optional(),
  }).passthrough();

  r.get('/recruiter/walkin-drives', ...staff, wrap(async (req, res) => {
    const f = parse(staffQuery, req.query);
    const where = ['true'];
    const vals = [];
    const add = (sql, v) => { vals.push(v); where.push(sql.replace(/\$\?/g, `$${vals.length}`)); };
    if (f.status) add(`walkin_live_status(d.status, d.drive_date, d.start_time, d.end_time) = $?`, f.status);
    if (f.city) add(`d.city ilike $?`, `%${f.city}%`);
    if (f.recruiterId === 'none') where.push('d.created_by_recruiter_id is null');
    else if (f.recruiterId) add(`d.created_by_recruiter_id = $?`, f.recruiterId);
    if (f.from) add(`d.drive_date >= $?::date`, f.from);
    if (f.to) add(`d.drive_date <= $?::date`, f.to);
    if (f.q) {
      add(`(d.title ilike $? or d.job_role ilike $? or d.venue_name ilike $? or d.city ilike $?
             or coalesce(co.name,'') ilike $?)`, `%${f.q}%`);
    }
    const out = await withUser(req.session, async (c) => {
      const rows = (await c.query(`${SELECT} where ${where.join(' and ')}
        order by d.drive_date desc, d.start_time desc limit 500`, vals)).rows;
      const n = await counts(c, rows.map((x) => x.id));
      // Who runs each drive: the admin screen lists and filters by it.
      const isAdmin = req.session.role === 'admin';
      const recruiters = isAdmin
        ? (await c.query(`select id, name from recruiters order by name limit 1000`)).rows
        : [];
      const names = new Map(recruiters.map((x) => [x.id, x.name]));
      const cities = isAdmin
        ? (await c.query(`select distinct city from walkin_drives order by 1 limit 500`)).rows.map((x) => x.city)
        : [];
      const jobs = (await c.query(
        `select j.id, j.title, j.company_id, j.posting_kind from jobs j
          where j.status <> 'closed' and not coalesce(j.archived,false)
            and (app_is_admin() or j.recruiter_id = app_recruiter_id())
          order by (j.posting_kind = 'walkin') desc, j.created_at desc limit 300`)).rows;
      const companies = (await c.query(`select id, name from companies order by name limit 1000`)).rows;
      return {
        drives: rows.map((d) => shapeDrive(d, {
          counts: n.get(d.id) || { REGISTERED: 0, ATTENDED: 0, NO_SHOW: 0, CANCELLED: 0 },
          ...(isAdmin ? {
            recruiterId: d.created_by_recruiter_id || null,
            recruiterName: d.created_by_recruiter_id ? (names.get(d.created_by_recruiter_id) || '') : '',
          } : {}),
        })),
        jobs: jobs.map((j) => ({ id: j.id, title: j.title, companyId: j.company_id, walkin: j.posting_kind === 'walkin' })),
        companies,
        ...(isAdmin ? { recruiters, cities } : {}),
      };
    });
    res.json(out);
  }));

  r.get('/recruiter/walkin-drives/:id', ...staff, wrap(async (req, res) => {
    const out = await withUser(req.session, async (c) => {
      const d = await ownDrive(c, req.params.id);
      const n = await counts(c, [d.id]);
      return shapeDrive(d, { counts: n.get(d.id) || { REGISTERED: 0, ATTENDED: 0, NO_SHOW: 0, CANCELLED: 0 } });
    });
    res.json({ drive: out });
  }));

  r.post('/recruiter/walkin-drives', ...staff, wrap(async (req, res) => {
    const raw = { ...(req.body || {}) };
    const out = await withUser(req.session, async (c) => {
      // Prefill from the walk-in posting, for what the recruiter left blank.
      if (raw.jobId) {
        const job = await ownJob(c, raw.jobId);
        const pre = fromJob(job);
        for (const [k, v] of Object.entries(pre)) {
          const empty = raw[k] == null || raw[k] === '' || (Array.isArray(raw[k]) && !raw[k].length);
          if (empty && v != null && !(Array.isArray(v) && !v.length)) raw[k] = v;
        }
        if (!raw.jobRole) raw.jobRole = job.title;
        if (!raw.title) raw.title = `Walk-in drive: ${job.title}`;
      }
      const b = parse(driveBody, raw);
      checkTimes(b, { creating: true });
      if (b.companyId) {
        const co = (await c.query(`select 1 from companies where id = $1`, [b.companyId])).rows[0];
        if (!co) throw badRequest('That company could not be found.', { companyId: 'Unknown company.' });
      }
      const id = newId('wd');
      await c.query(
        `insert into walkin_drives (id, title, company_id, job_id, job_role, description, drive_date,
           start_time, end_time, venue_name, full_address, city, map_link, salary_range,
           experience_required, qualification, skills, documents_to_carry, contact_person_name,
           contact_phone, max_seats, created_by_recruiter_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
        [id, b.title, b.companyId, b.jobId, b.jobRole, b.description, b.driveDate, b.startTime, b.endTime,
         b.venueName, b.fullAddress, b.city, b.mapLink, b.salaryRange, b.experienceRequired,
         b.qualification, b.skills || [], b.documentsToCarry || [], b.contactPersonName, b.contactPhone,
         b.maxSeats ?? null, req.session.role === 'recruiter' ? req.session.profileId : null]);
      return ownDrive(c, id);
    }).catch((err) => { throw err instanceof ApiError ? err : (fromPgError(err) || err); });
    res.status(201).json({ drive: shapeDrive(out, { counts: { REGISTERED: 0, ATTENDED: 0, NO_SHOW: 0, CANCELLED: 0 } }) });
  }));

  // What a registered candidate relies on. Changing any of these is news.
  const MATERIAL = ['drive_date', 'start_time', 'end_time', 'venue_name', 'full_address', 'city',
    'map_link', 'documents_to_carry', 'contact_person_name', 'contact_phone', 'title', 'job_role'];

  r.put('/recruiter/walkin-drives/:id', ...staff, wrap(async (req, res) => {
    const b = parse(driveBody, req.body);
    checkTimes(b, { creating: false });
    const out = await withUser(req.session, async (c) => {
      const before = await ownDrive(c, req.params.id);
      if (['COMPLETED', 'CANCELLED'].includes(before.live_status)) {
        throw new ApiError(409, 'WALKIN_CLOSED', `This drive is ${before.live_status.toLowerCase()} and can no longer be edited.`);
      }
      if (b.jobId && b.jobId !== before.job_id) await ownJob(c, b.jobId);
      if (b.maxSeats != null && b.maxSeats < Number(before.seats_taken || 0)) {
        throw badRequest(`${before.seats_taken} people are already registered, so seats cannot go below that.`,
          { maxSeats: 'Fewer seats than registrations.' });
      }
      if (b.companyId) {
        const co = (await c.query(`select 1 from companies where id = $1`, [b.companyId])).rows[0];
        if (!co) throw badRequest('That company could not be found.', { companyId: 'Unknown company.' });
      }
      const next = {
        title: b.title, job_role: b.jobRole, drive_date: b.driveDate, start_time: b.startTime,
        end_time: b.endTime, venue_name: b.venueName, full_address: b.fullAddress, city: b.city,
        map_link: b.mapLink, documents_to_carry: b.documentsToCarry || [],
        contact_person_name: b.contactPersonName, contact_phone: b.contactPhone,
      };
      const norm = (k, v) => (k.endsWith('_time') ? hm(v) : Array.isArray(v) ? JSON.stringify(v) : (v ?? null));
      const changed = MATERIAL.some((k) => norm(k, before[k]) !== norm(k, next[k]));
      const upd = await c.query(
        `update walkin_drives set title=$2, company_id=$3, job_id=$4, job_role=$5, description=$6,
           drive_date=$7, start_time=$8, end_time=$9, venue_name=$10, full_address=$11, city=$12,
           map_link=$13, salary_range=$14, experience_required=$15, qualification=$16, skills=$17,
           documents_to_carry=$18, contact_person_name=$19, contact_phone=$20, max_seats=$21,
           version = version + $22::int,
           status = case when status in ('UPCOMING','ONGOING') then 'UPCOMING' else status end
         where id = $1`,
        [before.id, b.title, b.companyId, b.jobId, b.jobRole, b.description, b.driveDate, b.startTime,
         b.endTime, b.venueName, b.fullAddress, b.city, b.mapLink, b.salaryRange, b.experienceRequired,
         b.qualification, b.skills || [], b.documentsToCarry || [], b.contactPersonName, b.contactPhone,
         b.maxSeats ?? null, changed ? 1 : 0]);
      if (!upd.rowCount) throw forbidden('You can only edit the drives you created.');
      return { drive: await ownDrive(c, before.id), changed };
    }).catch((err) => { throw err instanceof ApiError ? err : (fromPgError(err) || err); });
    if (out.changed) background(() => notifyDriveChange(out.drive.id, 'updated'));
    res.json({ drive: shapeDrive(out.drive), notified: out.changed });
  }));

  r.delete('/recruiter/walkin-drives/:id', ...staff, wrap(async (req, res) => {
    const reason = String((req.body && req.body.reason) || req.query.reason || '').trim().slice(0, 500) || null;
    const out = await withUser(req.session, async (c) => {
      const before = await ownDrive(c, req.params.id);
      if (before.live_status === 'CANCELLED') return before;
      if (before.live_status === 'COMPLETED') {
        throw new ApiError(409, 'WALKIN_CLOSED', 'This drive has already taken place and cannot be cancelled.');
      }
      const upd = await c.query(
        `update walkin_drives set status='CANCELLED', cancel_reason=$2 where id=$1`, [before.id, reason]);
      if (!upd.rowCount) throw forbidden('You can only cancel the drives you created.');
      return ownDrive(c, before.id);
    });
    background(() => notifyDriveChange(out.id, 'cancelled'));
    res.json({ drive: shapeDrive(out) });
  }));

  async function registrations(req) {
    return withUser(req.session, async (c) => {
      const d = await ownDrive(c, req.params.id);
      const rows = (await c.query(`select * from walkin_drive_registrations($1)`, [d.id])).rows;
      // the admin screen says whose drive it is
      if (req.session.role === 'admin' && d.created_by_recruiter_id) {
        const who = (await c.query(`select name from recruiters where id = $1`, [d.created_by_recruiter_id])).rows[0];
        d.recruiter_name = who ? who.name : '';
      }
      return { drive: d, rows };
    });
  }

  function filterRegs(rows, q, status) {
    const k = String(q || '').trim().toLowerCase();
    return rows.filter((x) => (!status || x.status === status)
      && (!k || [x.name, x.email, x.phone, x.location, x.title, (x.skills || []).join(' ')]
        .join(' ').toLowerCase().includes(k)));
  }

  const shapeRegRow = (x) => ({
    ...shapeRegistration(x),
    name: x.name, email: x.email || '', phone: x.phone || '', location: x.location || '',
    title: x.title || '', exp: x.exp || '', education: x.education || '', skills: x.skills || [],
    hasResume: !!x.has_resume,
  });

  r.get('/recruiter/walkin-drives/:id/registrations', ...staff, wrap(async (req, res) => {
    const status = req.query.status && REG_STATUSES.includes(String(req.query.status)) ? String(req.query.status) : '';
    const { drive, rows } = await registrations(req);
    const list = filterRegs(rows, req.query.q, status).map(shapeRegRow);
    const totals = { REGISTERED: 0, ATTENDED: 0, NO_SHOW: 0, CANCELLED: 0 };
    rows.forEach((x) => { totals[x.status] += 1; });
    const extra = req.session.role === 'admin'
      ? { recruiterId: drive.created_by_recruiter_id || null, recruiterName: drive.recruiter_name || '' } : {};
    res.json({ drive: shapeDrive(drive, extra), registrations: list, totals });
  }));

  r.patch('/recruiter/walkin-drives/:id/registrations/:regId', ...staff, wrap(async (req, res) => {
    const b = parse(z.object({ status: z.enum(['ATTENDED', 'NO_SHOW', 'REGISTERED']) }).strict(), req.body);
    const out = await withUser(req.session, async (c) => {
      const d = await ownDrive(c, req.params.id);
      if (d.live_status === 'CANCELLED') throw new ApiError(409, 'WALKIN_CLOSED', 'This drive was cancelled.');
      if (d.live_status === 'UPCOMING') {
        throw new ApiError(409, 'WALKIN_NOT_STARTED', 'Attendance can be marked once the drive has started.');
      }
      const row = (await c.query(
        `update walkin_registrations set status = $3,
                attendance_marked_at = case when $3 = 'REGISTERED' then null else now() end
          where id = $1 and drive_id = $2 and status <> 'CANCELLED' returning *`,
        [req.params.regId, d.id, b.status])).rows[0];
      if (!row) throw notFound('That registration could not be found, or it was cancelled by the candidate.');
      return row;
    });
    res.json({ registration: shapeRegistration(out) });
  }));

  r.get('/recruiter/walkin-drives/:id/registrations/export', ...staff, wrap(async (req, res) => {
    const format = req.query.format === 'xlsx' ? 'xlsx' : 'csv';
    const status = req.query.status && REG_STATUSES.includes(String(req.query.status)) ? String(req.query.status) : '';
    const { drive, rows } = await registrations(req);
    const list = filterRegs(rows, req.query.q, status);
    const header = ['Name', 'Email', 'Phone', 'Location', 'Current title', 'Experience', 'Education',
      'Skills', 'Resume on file', 'Status', 'Registered at (IST)', 'Attendance marked (IST)'];
    const ist = (v) => (v ? new Date(new Date(v).getTime() + 330 * 60000).toISOString().slice(0, 16).replace('T', ' ') : '');
    const table = list.map((x) => [x.name, x.email || '', x.phone || '', x.location || '', x.title || '',
      x.exp || '', x.education || '', (x.skills || []).join(', '), x.has_resume ? 'Yes' : 'No',
      x.status, ist(x.registered_at), ist(x.attendance_marked_at)]);
    const slug = String(drive.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'drive';
    const name = `walkin-${slug}-${drive.drive_date}`;
    res.setHeader('x-content-type-options', 'nosniff');
    if (format === 'xlsx') {
      res.setHeader('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('content-disposition', `attachment; filename="${name}.xlsx"`);
      return res.send(writeSheet(header, table, 'Registrations'));
    }
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="${name}.csv"`);
    return res.send('\uFEFF' + [header, ...table].map((l) => l.map(csvCell).join(',')).join('\r\n'));
  }));

  return r;
}

export { STATUSES };
