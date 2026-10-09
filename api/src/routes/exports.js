/* =====================================================================
   TEAMLINK — exporting candidates out of the recruiter portal
   =====================================================================

   Three things leave through here: a CSV, an .xlsx, and a ZIP of the
   actual resume files. All three are the same selection of people seen
   three ways, so they share one selection step, one permission check and
   one audit line.

   THE SELECTION IS ALWAYS A LIST OF IDS.

   The screen offers "selected", "everything matching the current
   filters" and "this page", and it resolves all three to ids BEFORE it
   calls this route - by asking the list endpoint, which already owns
   every filter the sidebar can set. Re-implementing that WHERE clause
   here would be a second copy of forty filters, and the two would
   disagree the first time one of them changed. The scope word still
   travels with the request, because the audit line should say which of
   the three the recruiter chose.

   WHAT STOPS A RECRUITER EXPORTING SOMEBODY ELSE'S POOL.

   Nothing in this file. The read runs through `withUser(req.session)`
   like every other read, so row-level security answers it: a recruiter
   sees their company's candidates and an administrator sees all of them.
   An id that is not theirs comes back as no row, and the export simply
   does not contain that person - it is not an error, because a request
   for forty ids of which one is not visible is a stale page, not an
   attack. The count in the audit line is what was actually read.

   EVERY EXPORT IS LOGGED BEFORE THE FILE IS BUILT (0084). A log written
   afterwards misses precisely the exports that went wrong.

   NOTHING IS STREAMED FROM MEMORY IT DOES NOT NEED TO BE. The list
   formats are small. The ZIP reads resumes one at a time and appends
   them to the archive rather than loading the pool first, and the
   hundred-file ceiling below keeps the worst case bounded.
   ===================================================================== */
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { withUser } from '../db.js';
import { wrap, badRequest, forbidden, ApiError } from '../errors.js';
import { requireAuth, requireRole } from '../auth.js';
import { writeSheet, makeZip } from '../xlsx.js';
import { getStorage } from '../storage.js';
import { SCREENING_COLUMNS, presentScreening } from '../screening/export.js';
import { istDateTime } from '../applied-date.js';

/* ------------------------------------------------------------------ *
 * what a column is
 *
 * The screen offers a chooser, so the set has to be named somewhere
 * both sides agree on. Here, because the server is what must refuse an
 * unknown one: a column name from a request is otherwise a free choice
 * of SQL identifier.
 * ------------------------------------------------------------------ */
const COLUMNS = {
  name:              { label: 'Name',               col: 'c.name' },
  email:             { label: 'Email',              col: 'c.email' },
  phone:             { label: 'Phone',              col: 'c.phone' },
  appliedFor:        { label: 'Applied For',        col: 'ap.job_title' },
  /* 0130: the application's own timestamp, written out in IST. */
  appliedOn:         { label: 'Applied On',         col: 'ap.applied_at' },
  stage:             { label: 'Stage',              col: 'ap.stage' },
  matchPercent:      { label: 'AI Match %',         col: 'ap.match_score' },
  cameFrom:          { label: 'Came From',          col: 'c.source' },
  skills:            { label: 'Key Skills',         col: 'c.skills' },
  currentCompany:    { label: 'Current Company',    col: 'c.current_company' },
  experience:        { label: 'Experience',         col: 'c.exp' },
  noticePeriod:      { label: 'Notice Period',      col: 'c.notice_period' },
  currentLocation:   { label: 'Current Location',   col: 'c.location' },
  preferredLocation: { label: 'Preferred Location', col: 'c.preferred_location' },
  expectedSalary:    { label: 'Expected Salary',    col: 'c.expected_ctc' },
  resumeLink:        { label: 'Resume Link',        col: 'c.resume_file' },
  /* Screening answers on the latest application (0097). */
  ...SCREENING_COLUMNS,
};

const DEFAULT_COLUMNS = Object.keys(COLUMNS);

/*
 * More than this in one ZIP becomes a job somebody waits on rather than
 * a download, and the screen says so. It is a ceiling on ONE request,
 * not on how many a recruiter may export in total.
 */
const ZIP_LIMIT = 100;

/*
 * ABOVE THAT, A JOB. A selection of more than a hundred is built in the
 * background and downloaded when it is ready, rather than refused. A
 * thousand is the ceiling for one job: the archive is assembled in
 * memory, and a thousand resumes is already a few hundred megabytes.
 */
const JOB_LIMIT = 1000;
const JOB_TTL_MS = 24 * 60 * 60 * 1000;
const JOB_DIR = process.env.EXPORT_DIR || join(process.cwd(), 'var', 'exports');

/** id -> { id, owner, status, total, done, included, missing, file, error, createdAt } */
const jobs = new Map();

/** Archives older than a day go, with their records. */
function sweepJobs() {
  const now = Date.now();
  for (const [id, j] of jobs) {
    if (now - j.createdAt > JOB_TTL_MS) {
      try { if (j.file) unlinkSync(j.file); } catch { /* already gone */ }
      jobs.delete(id);
    }
  }
  try {
    if (!existsSync(JOB_DIR)) return;
    for (const f of readdirSync(JOB_DIR)) {
      const full = join(JOB_DIR, f);
      if (now - statSync(full).mtimeMs > JOB_TTL_MS) unlinkSync(full);
    }
  } catch { /* nothing to sweep */ }
}
setInterval(sweepJobs, 60 * 60 * 1000).unref?.();

const selectionSchema = z.object({
  ids: z.array(z.string().max(80)).min(1, 'Select at least one candidate.').max(5000),
  scope: z.enum(['selected', 'filtered', 'page']).default('selected'),
  /* What the sidebar had set, for the audit line only. Never used to
     build a query - the ids are the query. */
  filters: z.record(z.any()).optional(),
});

const jobSchema = selectionSchema.extend({
  ids: z.array(z.string().max(80)).min(1, 'Select at least one candidate.')
    .max(JOB_LIMIT, `One export holds up to ${JOB_LIMIT} resumes.`),
});

const listSchema = selectionSchema.extend({
  format: z.enum(['csv', 'xlsx']).default('csv'),
  /* 0130: the Applications screen exports the applications it is
     showing - one row each, exactly the filtered ones - rather than each
     candidate's latest. Optional: every other caller is unchanged. */
  applicationIds: z.array(z.string().max(80)).min(1).max(5000).optional(),
  columns: z.array(z.string().max(40)).min(1).max(40).optional(),
});

function parse(schema, body) {
  const out = schema.safeParse(body || {});
  if (!out.success) {
    const details = {};
    for (const i of out.error.issues) details[i.path.join('.') || 'form'] = i.message;
    throw badRequest('That export could not be prepared.', details);
  }
  return out.data;
}

/* ------------------------------------------------------------------ *
 * shaping
 * ------------------------------------------------------------------ */

const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** A value as a person reads it, not as the column stores it. */
function present(key, row) {
  const v = row[keyToAlias(key)];
  const screening = presentScreening(key, v);
  if (screening !== undefined) return screening;
  if (v == null || v === '') return '';
  if (Array.isArray(v)) return v.join(', ');
  if (key === 'expectedSalary') return `${v} LPA`;
  if (key === 'matchPercent') return `${v}%`;
  if (key === 'appliedOn') return istDateTime(v) || String(v).slice(0, 10);
  if (key === 'resumeLink') {
    /* The FILE NAME, and whether there is one. Not a URL: a link in a
       spreadsheet that anybody who opens the file can follow is a way
       for a resume to leave the company inside an email attachment.
       The ZIP is how you get the files. */
    return String(v);
  }
  return String(v);
}

const keyToAlias = (k) => `x_${k}`;

/* ------------------------------------------------------------------ *
 * reading
 * ------------------------------------------------------------------ */

/**
 * The chosen people, with the chosen columns, in the order the screen
 * asked for them.
 *
 * `ap` is the candidate's most recent application, which is where
 * "Applied For", "Stage" and the match score live. LEFT JOINed, because
 * a talent-pool candidate who has never applied is still exportable and
 * those three cells are simply empty for them.
 */
async function readRows(session, ids, columns, applicationIds) {
  const select = columns
    /* Quoted: an unquoted alias is folded to lower case by Postgres, so
       x_appliedFor came back as x_appliedfor and every camelCase column
       exported blank. The keys are whitelisted above, so quoting is safe. */
    .map((k) => `${COLUMNS[k].col} as "${keyToAlias(k)}"`)
    .join(',\n           ');

  return withUser(session, async (c) => {
    if (applicationIds && applicationIds.length) {
      /* RLS on applications decides which of these this person may see. */
      const { rows } = await c.query(
        `with ap as (
           select a.candidate_id, a.stage, a.match_score, a.applied_on, a.applied_at, a.id as app_id,
                  j.title as job_title
             from applications a
             left join jobs j on j.id = a.job_id
            where a.id = any($1::text[])
         )
         select c.id as x_id,
                c.resume_storage_path as x_path,
                c.resume_file as x_file,
                c.resume_mime as x_mime,
                c.name as x_name,
                ${select}
           from ap
           join candidates c on c.id = ap.candidate_id
          order by ap.applied_at desc, ap.app_id`,
        [applicationIds]);
      return rows;
    }
    const { rows } = await c.query(
      `with latest as (
         select distinct on (a.candidate_id)
                a.candidate_id, a.stage, a.match_score, a.applied_on, a.applied_at, a.id as app_id,
                j.title as job_title
           from applications a
           left join jobs j on j.id = a.job_id
          where a.candidate_id = any($1::text[])
          order by a.candidate_id, a.applied_at desc nulls last
       )
       select c.id as x_id,
              c.resume_storage_path as x_path,
              c.resume_file as x_file,
              c.resume_mime as x_mime,
              c.name as x_name,
              ${select}
         from candidates c
         left join latest ap on ap.candidate_id = c.id
        where c.id = any($1::text[])
        /* The order the recruiter is looking at, as close as this can
           get to it without being handed the whole sort. */
        order by c.name asc, c.id asc`,
      [ids]);
    return rows;
  });
}

/** One audit line. Written before anything is sent. */
async function audit(req, fields) {
  try {
    await withUser(req.session, (c) => c.query(
      `select export_audit_record($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        req.session.userId || null,
        req.session.role,
        req.session.email || null,
        fields.kind,
        fields.scope,
        fields.candidates || 0,
        fields.resumes || 0,
        fields.missing || 0,
        JSON.stringify(fields.filters || {}),
        fields.columns || [],
        req.ip || null,
        req.get('user-agent') || null,
      ]));
  } catch (err) {
    /* An export that cannot be logged does not happen. The log is the
       reason this feature is allowed to exist. */
    throw forbidden('This export could not be recorded, so it was not run. '
      + 'Tell an administrator: ' + err.message);
  }
}

/* ------------------------------------------------------------------ *
 * names
 * ------------------------------------------------------------------ */

/**
 * "Name_Role_Reference.ext", safe on every filesystem.
 *
 * A candidate's name can contain a slash, a colon, a newline pasted out
 * of a CV, or nothing at all. Anything outside a conservative set is
 * replaced rather than stripped, so two different names cannot collapse
 * into the same file.
 */
function zipName(row, used) {
  const clean = (v, max) => String(v == null ? '' : v)
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .replace(/[. ]+$/, '');

  const ext = (String(row.x_file || '').match(/\.([A-Za-z0-9]{1,6})$/) || [, 'pdf'])[1].toLowerCase();
  const base = [clean(row.x_name, 60) || 'Candidate',
                clean(row.x_job_title || row.x_appliedFor || '', 40),
                clean(row.x_id, 24)]
    .filter(Boolean).join('_');

  let name = `${base}.${ext}`;
  /* Two people with the same name and the same role would otherwise
     overwrite each other inside the archive. */
  let n = 2;
  while (used.has(name.toLowerCase())) name = `${base}_${n++}.${ext}`;
  used.add(name.toLowerCase());
  return name;
}

/* ------------------------------------------------------------------ *
 * routes
 * ------------------------------------------------------------------ */

/**
 * The archive itself: every resume on file, plus missing_resumes.txt
 * naming anybody whose file is absent or unreadable.
 *
 * @param onProgress (done, total) after each file - the background job
 *                   reports it; the direct download ignores it.
 */
async function buildArchive(rows, withFile, without, onProgress) {
  const store = getStorage();
  const used = new Set();
  const members = [];
  const failed = [];

  let done = 0;
  for (const row of withFile) {
    try {
      const buf = await store.get(row.x_path);
      members.push({ name: zipName(row, used), data: buf });
    } catch (err) {
      /* One unreadable file must not lose the other ninety-nine. It is
         reported in the same place as a missing one, with the reason. */
      failed.push(`${row.x_name || row.x_id} — file could not be read (${err.message})`);
    }
    done += 1;
    if (onProgress) onProgress(done, withFile.length);
  }

  const notes = [];
  if (without.length) {
    notes.push('No resume on file:');
    without.forEach((x) => notes.push(`  ${x.x_name || x.x_id}`));
  }
  if (failed.length) {
    if (notes.length) notes.push('');
    notes.push('On file but unreadable:');
    failed.forEach((line) => notes.push(`  ${line}`));
  }
  if (notes.length) {
    notes.unshift(`TeamLink resume export — ${new Date().toISOString().slice(0, 10)}`,
      `${rows.length} selected, ${members.length} included.`, '');
    members.push({
      name: 'missing_resumes.txt',
      data: Buffer.from(notes.join('\r\n'), 'utf8'),
    });
  }

  return { zip: makeZip(members), members, failed };
}

function publicJob(j) {
  return { id: j.id, status: j.status, total: j.total, done: j.done,
           included: j.included, missing: j.missing, error: j.error,
           expiresAt: new Date(j.createdAt + JOB_TTL_MS).toISOString() };
}

export default function exportRoutes() {
  const r = Router();

  /*
   * An export is expensive and carries personal data, so it is limited
   * per signed-in person rather than per address - two recruiters behind
   * one office NAT must not spend each other's budget.
   */
  const limiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: Number(process.env.EXPORT_RATE_LIMIT_MAX || 30),
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => String(req.session?.userId || req.ip),
    message: { error: { code: 'RATE_LIMITED',
      message: 'That is a lot of exports in a short time. Try again in a few minutes.' } },
  });

  const staff = [requireAuth(), requireRole('recruiter', 'bde', 'admin'), limiter];

  /** What the chooser offers, so the screen does not hardcode the list. */
  r.get('/recruiter/candidates/export-columns', requireAuth(),
    requireRole('recruiter', 'bde', 'admin'), wrap(async (_req, res) => {
      res.json({
        columns: Object.entries(COLUMNS).map(([key, v]) => ({ key, label: v.label })),
        defaults: DEFAULT_COLUMNS,
        zipLimit: ZIP_LIMIT,
        jobLimit: JOB_LIMIT,
      });
    }));

  /**
   * POST /api/recruiter/candidates/export
   *
   * The list, as CSV or .xlsx.
   */
  r.post('/recruiter/candidates/export', ...staff, wrap(async (req, res) => {
    const body = parse(listSchema, req.body);

    const columns = (body.columns || DEFAULT_COLUMNS).filter((k) => COLUMNS[k]);
    if (!columns.length) throw badRequest('Choose at least one column to export.');

    const rows = await readRows(req.session, body.ids, columns, body.applicationIds);

    await audit(req, {
      kind: body.format === 'xlsx' ? 'list_xlsx' : 'list_csv',
      scope: body.scope,
      candidates: rows.length,
      filters: body.filters,
      columns,
    });

    const header = columns.map((k) => COLUMNS[k].label);
    const table = rows.map((row) => columns.map((k) => present(k, row)));
    const stamp = new Date().toISOString().slice(0, 10);

    if (body.format === 'xlsx') {
      const buf = writeSheet(header, table, 'Candidates');
      res.setHeader('content-type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('content-disposition',
        `attachment; filename="teamlink-candidates-${stamp}.xlsx"`);
      res.setHeader('x-content-type-options', 'nosniff');
      return res.send(buf);
    }

    /* A BOM, because Excel on Windows reads a CSV without one as the
       system codepage and turns every accented name into mojibake. */
    const csv = '﻿' + [header, ...table]
      .map((line) => line.map(csvCell).join(',')).join('\r\n');

    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition',
      `attachment; filename="teamlink-candidates-${stamp}.csv"`);
    res.setHeader('x-content-type-options', 'nosniff');
    return res.send(csv);
  }));

  /**
   * POST /api/recruiter/candidates/export-resumes
   *
   * The actual files, as a ZIP.
   *
   * A candidate with no resume on file is not an error and not a silent
   * omission: they are listed inside the archive in missing_resumes.txt,
   * so the recruiter knows who to chase rather than counting the files.
   */
  r.post('/recruiter/candidates/export-resumes', ...staff, wrap(async (req, res) => {
    const body = parse(selectionSchema, req.body);

    if (body.ids.length > ZIP_LIMIT) {
      throw badRequest(
        `A single archive holds ${ZIP_LIMIT} resumes. You asked for ${body.ids.length}. `
        + 'Narrow the selection, or export them in batches.',
        { ids: `Select ${ZIP_LIMIT} or fewer.` });
    }

    const rows = await readRows(req.session, body.ids, ['name', 'appliedFor']);

    const withFile = rows.filter((x) => x.x_path);
    const without = rows.filter((x) => !x.x_path);

    await audit(req, {
      kind: 'resumes_zip',
      scope: body.scope,
      candidates: rows.length,
      resumes: withFile.length,
      missing: without.length,
      filters: body.filters,
    });

    if (!withFile.length) {
      throw badRequest('None of the selected candidates has a resume on file.');
    }

    const { zip, members, failed } = await buildArchive(rows, withFile, without);
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('content-type', 'application/zip');
    res.setHeader('content-disposition',
      `attachment; filename="teamlink-resumes-${stamp}.zip"`);
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-teamlink-included', String(members.length));
    res.setHeader('x-teamlink-missing', String(without.length + failed.length));
    return res.send(zip);
  }));

  /*
   * MORE THAN A HUNDRED: A BACKGROUND JOB.
   *
   *   POST /api/recruiter/candidates/export-resumes/jobs        start it
   *   GET  /api/recruiter/candidates/export-resumes/jobs/:id    how far
   *   GET  /api/recruiter/candidates/export-resumes/jobs/:id/download
   *
   * The selection is read and audited in the request, as the direct
   * download is, so what can be exported is decided by the same row-level
   * rules and the audit line is written before any file is touched. Only
   * the archive is built afterwards. The archive belongs to the person who
   * asked for it - nobody else's session can see or download it - and it
   * is deleted after a day.
   */
  r.post('/recruiter/candidates/export-resumes/jobs', ...staff, wrap(async (req, res) => {
    const body = parse(jobSchema, req.body);
    const rows = await readRows(req.session, body.ids, ['name', 'appliedFor']);
    const withFile = rows.filter((x) => x.x_path);
    const without = rows.filter((x) => !x.x_path);

    await audit(req, {
      kind: 'resumes_zip',
      scope: body.scope,
      candidates: rows.length,
      resumes: withFile.length,
      missing: without.length,
      filters: body.filters,
    });
    if (!withFile.length) throw badRequest('None of the selected candidates has a resume on file.');

    sweepJobs();
    const id = `xj_${randomBytes(12).toString('hex')}`;
    const job = {
      id, owner: String(req.session.userId), status: 'running',
      total: withFile.length, done: 0, included: 0, missing: without.length,
      file: null, error: null, createdAt: Date.now(),
    };
    jobs.set(id, job);

    setImmediate(async () => {
      try {
        const out = await buildArchive(rows, withFile, without, (d) => { job.done = d; });
        mkdirSync(JOB_DIR, { recursive: true });
        const file = join(JOB_DIR, `${id}.zip`);
        writeFileSync(file, out.zip);
        job.file = file;
        job.included = withFile.length - out.failed.length;
        job.missing = without.length + out.failed.length;
        job.status = 'ready';
      } catch (err) {
        job.status = 'failed';
        job.error = 'The archive could not be built. Try a smaller selection.';
        console.error('[export] job failed:', err.message);
      }
    });

    res.status(202).json({ job: publicJob(job) });
  }));

  const mine = (req) => {
    const job = jobs.get(String(req.params.id));
    if (!job || job.owner !== String(req.session.userId)) {
      throw new ApiError(404, 'NOT_FOUND', 'That export is not available. It may have expired.');
    }
    return job;
  };

  r.get('/recruiter/candidates/export-resumes/jobs/:id', requireAuth(),
    requireRole('recruiter', 'bde', 'admin'), wrap(async (req, res) => {
      res.json({ job: publicJob(mine(req)) });
    }));

  r.get('/recruiter/candidates/export-resumes/jobs/:id/download', requireAuth(),
    requireRole('recruiter', 'bde', 'admin'), wrap(async (req, res) => {
      const job = mine(req);
      if (job.status !== 'ready' || !job.file || !existsSync(job.file)) {
        throw new ApiError(409, 'NOT_READY', 'That export is not ready yet.');
      }
      const stamp = new Date(job.createdAt).toISOString().slice(0, 10);
      res.setHeader('content-type', 'application/zip');
      res.setHeader('x-content-type-options', 'nosniff');
      res.setHeader('x-teamlink-included', String(job.included));
      res.setHeader('x-teamlink-missing', String(job.missing));
      res.download(job.file, `teamlink-resumes-${stamp}.zip`);
    }));

  /** The log, for an administrator. */
  r.get('/admin/export-audit', requireAuth(), requireRole('admin'),
    wrap(async (req, res) => {
      const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
      const rows = await withUser(req.session, async (c) => (await c.query(
        `select id, actor_role, actor_email, kind, scope, candidate_count,
                resume_count, missing_count, columns, created_at
           from export_audit order by created_at desc limit $1`, [limit])).rows);
      res.json({ exports: rows });
    }));

  return r;
}
