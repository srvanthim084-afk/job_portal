/**
 * Job portal upgrades - the API (0095).
 *
 *   GET  /api/quick-filters                 the chip list (public)
 *   PUT  /api/admin/quick-filters           reorder / rename / hide (admin)
 *   GET  /api/jobs?quick=fresher,urgent     the job board with chips, in SQL
 *   GET  /api/job-matches/explain?jobIds=   score + reasons (candidate, max 50)
 *   POST /api/jobs/:id/share                a share code, link and text
 *   GET  /api/jobs/:id/share-stats          "Shared 23 times · 9 applies"
 *   GET  /api/applications/one-click/check  what one-click still needs
 *   POST /api/applications/one-click        apply in one tap (idempotent)
 *   DELETE /api/applications/:id            Undo, within 10 s, owner only
 *   PUT  /api/jobs/:id/deadline             last date + urgent hiring
 *   GET  /job/:id                           the job page with Open Graph tags
 *
 * MOUNTED AHEAD OF the job and application routes, because three things
 * here are middleware on their paths rather than routes of their own:
 *
 *   - POST /api/applications (every way of applying) is refused after the
 *     last date with "Applications closed", limited to 30 an hour per
 *     candidate, and credited to the share link the candidate arrived by;
 *   - GET /api/jobs with ?quick= is answered here, with the chips in SQL;
 *   - saving or publishing a job that is urgent announces it (event A).
 *
 * None of them changes what those routes do otherwise.
 */
import { Router } from 'express';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { withUser } from '../db.js';
import { config } from '../config.js';
import { wrap, badRequest, notFound, forbidden, ApiError, CODES } from '../errors.js';
import { requireAuth, requireRole } from '../auth.js';
import { toJob, toApplication } from '../shapes.js';
import {
  CHIP_SQL, parseChips, normaliseChipSettings, nearMeFilter, explainMatch,
  missingForOneClick, newShareCode, shareText, shareLines, toPublicUrl, isLocalUrl, ogTags, SHARE_CHANNELS, endOfIstDay, escHtml,
} from '../portal/core.js';
import { kickUrgent } from '../portal/alerts.js';
import { feedRows, jsonLdScript } from '../publishing/feed.js';

const PUBLISHING_ENGINE = { userId: '', role: 'admin', profileId: null };
import { jobsPageScope, teamlinkOnly } from '../jobs/source-scope.js';

const APPLY_PER_HOUR = () => Number(process.env.APPLY_RATE_PER_HOUR || 30);
const SHARE_COOKIE = 'tl_share_ref';
const base = () => config.publicOrigin.replace(/\/$/, '');

/*
 * Where a shared link points. PUBLIC_SHARE_URL is the address people
 * outside this computer open (the portal's public https address); a
 * WhatsApp recipient cannot open localhost. Without it: PUBLIC_ORIGIN when
 * that is a real address, else the address this request came in on, so
 * the link at least works where it was made.
 */
function shareBase(req) {
  const pub = String(process.env.PUBLIC_SHARE_URL || '').trim().replace(/\/$/, '');
  if (pub) return pub;
  const cfg = base();
  if (!isLocalUrl(cfg)) return cfg;
  const host = req && req.get ? req.get('host') : '';
  return host ? `${req.protocol}://${host}` : cfg;
}
/*
 * The job as a share needs it: the public shape, plus the walk-in details a
 * walk-in job carries (address, map link, documents, instructions - read
 * from the row as a whole so a column that does not exist yet is simply
 * absent), plus the company name its card shows.
 */
async function shareableJob(c, id) {
  const row = (await c.query(`select * from jobs_open where id=$1`, [id])).rows[0];
  if (!row) return null;
  const all = (await c.query(`select to_jsonb(j) as r from jobs j where j.id=$1`, [id])).rows[0];
  const raw = (all && all.r) || {};
  const co = row.company_id
    ? (await c.query(`select name from companies where id=$1`, [row.company_id])).rows[0] : null;
  const job = toJob(row);
  return {
    job: {
      ...job,
      walkinAddress: job.walkinAddress || raw.walkin_address || null,
      walkinMapLink: job.walkinMapLink || raw.walkin_map_link || null,
      walkinDocumentsToCarry: job.walkinDocumentsToCarry || raw.walkin_documents || null,
      walkinInstructions: job.walkinInstructions || raw.walkin_instructions || null,
      stipend: job.stipend != null ? job.stipend : raw.stipend,
    },
    company: (co && co.name) || '',
  };
}

const shareLink = (req, path) => toPublicUrl(`${shareBase(req)}${path}`, process.env.PUBLIC_SHARE_URL);

const parse = (schema, body) => {
  const out = schema.safeParse(body || {});
  if (!out.success) {
    const details = {};
    for (const i of out.error.issues) details[i.path.join('.') || 'form'] = i.message;
    throw badRequest('Please check the highlighted fields and try again.', details);
  }
  return out.data;
};

const closedMessage = (at) => {
  let d = '';
  try {
    d = new Date(at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
  } catch { /* no date */ }
  return `Applications closed${d ? ` on ${d}` : ''}.`;
};

/** The share code this browser arrived by for this job, if any. */
function shareRefFor(req, jobId) {
  const given = req.body && typeof req.body.ref === 'string' ? req.body.ref.trim() : '';
  if (/^[A-Za-z0-9_-]{6,32}$/.test(given)) return given;
  const raw = req.cookies ? String(req.cookies[SHARE_COOKIE] || '') : '';
  const [job, code] = raw.split(':');
  return job === jobId && /^[A-Za-z0-9_-]{6,32}$/.test(code || '') ? code : null;
}

/** After a 2xx JSON response, with its body. */
function afterJson(res, fn) {
  const json = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      Promise.resolve().then(() => fn(body)).catch((err) =>
        console.error('[portal] after-response step failed:', err.message));
    }
    return json(body);
  };
}

export default function portalUpgradeRoutes() {
  const r = Router();

  /* ================================================================ *
   * 1. quick filter chips
   * ================================================================ */

  async function chipSettings(session) {
    const row = await withUser(session || null, async (c) =>
      (await c.query(`select value from app_settings where key='quick_filters'`)).rows[0]);
    return normaliseChipSettings(row ? row.value : null);
  }

  r.get('/quick-filters', wrap(async (req, res) => {
    const chips = await chipSettings(req.session);
    res.json({ chips: chips.filter((c) => c.enabled), all: req.session && req.session.role === 'admin' ? chips : undefined });
  }));

  r.put('/admin/quick-filters', requireAuth(), requireRole('admin'), wrap(async (req, res) => {
    const body = parse(z.object({
      chips: z.array(z.object({
        key: z.string().trim().max(20),
        label: z.string().trim().min(1).max(40).optional(),
        enabled: z.boolean().optional(),
      })).min(1).max(20),
    }), req.body);
    const chips = normaliseChipSettings(body);
    await withUser(req.session, (c) => c.query(
      `insert into app_settings (key, value, updated_at) values ('quick_filters', $1::jsonb, now())
       on conflict (key) do update set value = excluded.value, updated_at = now()`,
      [JSON.stringify({ chips })]));
    res.json({ chips });
  }));

  /**
   * GET /api/jobs?quick=... - the public job board with chips applied in
   * SQL. Same answer shape as the plain board; without ?quick= the
   * request goes on to it untouched.
   *
   * near_me needs a place: ?near=<city> or ?lat=&lon=, or, for a signed-in
   * candidate, their own location.
   */
  r.get('/jobs', wrap(async (req, res, next) => {
    if (req.query.quick === undefined) return next();
    jobsPageScope(req);                 // 0113: TeamLink jobs only, or 400
    const chips = parseChips(req.query.quick);
    const idsOnly = req.query.ids === '1' || req.query.ids === 'true';
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, idsOnly ? 2000 : 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const q = String(req.query.q || '').trim();
    const loc = String(req.query.location || '').trim();
    const km = Math.min(Math.max(Number(req.query.km) || 50, 5), 300);

    const out = await withUser(req.session, async (c) => {
      const where = [teamlinkOnly()], params = [];
      if (q) { params.push(`%${q}%`); where.push(`(title ilike $${params.length} or $${params.length} = any(skills))`); }
      if (loc) { params.push(`%${loc}%`); where.push(`location ilike $${params.length}`); }
      for (const k of chips) if (CHIP_SQL[k]) where.push(CHIP_SQL[k]);
      const clause = where.length ? `where ${where.join(' and ')}` : '';
      let rows = (await c.query(
        `select * from jobs_open ${clause} order by published_at desc nulls last, id limit 5000`, params)).rows;

      if (chips.includes('near_me')) {
        let place = null;
        const lat = Number(req.query.lat), lon = Number(req.query.lon);
        if (Number.isFinite(lat) && Number.isFinite(lon)) place = { lat, lon };
        else if (req.query.near) place = String(req.query.near).slice(0, 120);
        else if (req.session && req.session.role === 'candidate') {
          const me = (await c.query(`select location, preferred_location from candidates where id=$1`,
            [req.session.profileId])).rows[0];
          place = me && (me.location || me.preferred_location) || null;
        }
        rows = place ? await nearMeFilter(rows, place, km) : [];
      }
      return rows;
    });

    if (idsOnly) {
      res.json({ ids: out.slice(0, limit).map((x) => x.id), total: out.length, chips });
      return;
    }
    res.json({ jobs: out.slice(offset, offset + limit).map(toJob), total: out.length, limit, offset, chips });
  }));

  /* ================================================================ *
   * 2. match reasons
   * ================================================================ */

  r.get('/job-matches/explain', requireAuth(), requireRole('candidate'), wrap(async (req, res) => {
    jobsPageScope(req);
    const ids = [...new Set(String(req.query.jobIds || '').split(',').map((s) => s.trim()).filter(Boolean))];
    if (!ids.length) throw badRequest('Give jobIds, comma-separated.');
    if (ids.length > 50) throw badRequest('At most 50 jobs at a time.');
    if (ids.some((id) => id.length > 64)) throw badRequest('That is not a job id.');

    const data = await withUser(req.session, async (c) => ({
      cand: (await c.query(`select * from candidates where id=$1`, [req.session.profileId])).rows[0],
      jobs: (await c.query(
        `select j.*, co.name as company_name from jobs j
           left join companies co on co.id = j.company_id
          where j.id = any($1) and ${teamlinkOnly('j')}`, [ids])).rows,   // 0113: TeamLink jobs only are scored
    }));
    if (!data.cand) throw notFound('Your profile could not be found.');
    const byId = new Map(data.jobs.map((j) => [j.id, j]));
    res.json({
      matches: ids.filter((id) => byId.has(id)).map((id) => explainMatch(byId.get(id), data.cand)),
      missing: ids.filter((id) => !byId.has(id)),
    });
  }));

  /* ================================================================ *
   * 3. sharing
   * ================================================================ */

  r.post('/jobs/:id/share', wrap(async (req, res) => {
    const body = parse(z.object({ channel: z.enum(SHARE_CHANNELS).optional() }), req.body);
    const out = await withUser(req.session, async (c) => {
      const code = newShareCode();
      const made = (await c.query(`select job_share_create($1,$2,$3) as code`,
        [req.params.id, body.channel || 'other', code])).rows[0].code;
      if (!made) return null;
      const sj = await shareableJob(c, req.params.id);
      return sj ? { code: made, ...sj } : null;
    });
    if (!out || !out.job) throw new ApiError(404, CODES.JOB_UNAVAILABLE, 'This job is not open, so it cannot be shared.');
    const job = out.job;
    /* ?ref= is an anonymous share code - nothing about who shared it. */
    const url = shareLink(req, `/job/${encodeURIComponent(job.id)}?ref=${encodeURIComponent(out.code)}`);
    const text = shareText(job, url, { company: out.company });
    res.status(201).json({
      /* publicLink false: the link only opens on this computer (no
         PUBLIC_SHARE_URL yet) - the sheet can say so. `body` is the
         message without its link, for the phone's own share sheet, which
         adds the URL itself. */
      code: out.code, url, text, body: shareLines(job, { company: out.company }).join('\n'),
      publicLink: !isLocalUrl(url),
      links: {
        whatsapp: `https://wa.me/?text=${encodeURIComponent(text)}`,
        email: `mailto:?subject=${encodeURIComponent(`Job: ${job.title}`)}&body=${encodeURIComponent(text)}`,
        linkedin: `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}`,
      },
    });
  }));

  r.get('/jobs/:id/share-stats', requireAuth(), requireRole('recruiter', 'admin'), wrap(async (req, res) => {
    const row = await withUser(req.session, async (c) =>
      (await c.query(`select * from job_share_stats($1)`, [req.params.id])).rows[0])
      .catch((err) => { if (err.code === '42501') throw forbidden('That is not your job.'); throw err; });
    res.json({ jobId: req.params.id, shares: Number(row.shares), clicks: Number(row.clicks), applies: Number(row.applies) });
  }));

  /* ================================================================ *
   * 4 + 5. applying: the rules every application now passes
   * ================================================================ */

  async function applyGuards(req, jobId) {
    const state = await withUser(req.session, async (c) => ({
      job: (await c.query(`select * from portal_job_apply_state($1)`, [jobId])).rows[0],
      lastHour: req.session.role === 'candidate'
        ? (await c.query(`select count(*)::int n from applications
                            where candidate_id = $1 and applied_at > now() - interval '1 hour'`,
            [req.session.profileId])).rows[0].n
        : 0,
    }));
    const j = state.job;
    if (j && j.expires_at && new Date(j.expires_at) <= new Date()) {
      throw new ApiError(409, CODES.JOB_UNAVAILABLE, closedMessage(j.expires_at), { reason: 'expired' });
    }
    if (req.session.role === 'candidate' && state.lastHour >= APPLY_PER_HOUR()) {
      throw new ApiError(429, CODES.RATE_LIMITED,
        `You can apply to ${APPLY_PER_HOUR()} jobs an hour. Please try again a little later.`);
    }
  }

  function creditShare(req, jobId, body) {
    const code = shareRefFor(req, jobId);
    const appId = body && body.application && body.application.id;
    if (!code || !appId || req.session.role !== 'candidate') return;
    return withUser(req.session, (c) => c.query(`select job_share_applied($1,$2)`, [code, appId]));
  }

  /** Every application, however it is made. */
  r.post('/applications', requireAuth(), wrap(async (req, res, next) => {
    const jobId = req.body && typeof req.body.jobId === 'string' ? req.body.jobId.trim() : '';
    if (jobId) {
      await applyGuards(req, jobId);
      afterJson(res, (body) => creditShare(req, jobId, body));
    }
    next();
  }));

  /** What one-click apply still needs from this candidate. */
  r.get('/applications/one-click/check', requireAuth(), requireRole('candidate'), wrap(async (req, res) => {
    const row = await withUser(req.session, async (c) =>
      (await c.query(`select * from candidates where id=$1`, [req.session.profileId])).rows[0]);
    if (!row) throw notFound('Your profile could not be found.');
    const missing = missingForOneClick(row);
    res.json({ ready: !missing.length, missing });
  }));

  /**
   * POST /api/applications/one-click { jobId, answers?, ref? }
   *
   * Apply in one tap, on any open job, with the profile and resume on
   * file. Refused with the list of what is missing when the profile is
   * not complete. IDEMPOTENT: an application that already exists is
   * returned as it is (200, existing:true), never duplicated or refused.
   *
   * The application itself is made by the ordinary POST /applications -
   * the request is handed on to it, so screening, notifications and the
   * AI interview follow exactly as for any other apply - except that the
   * candidate's email/SMS/WhatsApp/IVR messages wait until the 10-second
   * Undo window has passed (notify/apply-hold.js, 0104).
   */
  r.post('/applications/one-click', requireAuth(), requireRole('candidate'), wrap(async (req, res, next) => {
    const body = parse(z.object({
      jobId: z.string().trim().min(1).max(64),
      ref: z.string().trim().max(40).optional(),
      source: z.string().trim().max(80).optional(),
      answers: z.any().optional(),
    }), req.body);

    const existing = () => withUser(req.session, async (c) => (await c.query(
      `select * from applications where candidate_id=$1 and job_id=$2`,
      [req.session.profileId, body.jobId])).rows[0]);
    const pre = await withUser(req.session, async (c) => ({
      cand: (await c.query(`select * from candidates where id=$1`, [req.session.profileId])).rows[0],
    }));
    if (!pre.cand) throw notFound('Your profile could not be found.');
    const had = await existing();
    if (had) {
      res.json({ application: toApplication(had), existing: true });
      return;
    }
    const missing = missingForOneClick(pre.cand);
    if (missing.length) {
      throw new ApiError(422, CODES.VALIDATION_FAILED,
        `Fill ${missing.length} thing${missing.length === 1 ? '' : 's'} to apply.`, { missing });
    }
    await applyGuards(req, body.jobId);
    afterJson(res, (out) => creditShare(req, body.jobId, out));

    /* Two taps racing each other: the loser's 409 is answered with the
       winner's application, so the same job never fails "already applied"
       on a one-click apply. */
    const json = res.json.bind(res);
    res.json = (out) => {
      if (res.statusCode === 409 && out && out.error && out.error.code === CODES.DUPLICATE_APPLICATION) {
        existing().then((row) => {
          if (!row) return json(out);
          res.status(200);
          return json({ application: toApplication(row), existing: true });
        }, () => json(out));
        return res;
      }
      return json(out);
    };

    req.body = { ...req.body, jobId: body.jobId, source: body.source || 'teamlink', oneClick: true };
    /* Read by POST /applications: hold the candidate's messages until the
       Undo window has passed (0104). On the request, not the body, so an
       ordinary apply cannot ask for it. */
    req.oneClickApply = true;
    req.url = '/applications';
    next();
  }));

  /** Undo: the applicant, within ten seconds of applying. */
  r.delete('/applications/:id', requireAuth(), requireRole('candidate'), wrap(async (req, res) => {
    const verdict = await withUser(req.session, async (c) =>
      (await c.query(`select application_undo($1, 10) as v`, [req.params.id])).rows[0].v);
    if (verdict === 'not_found') throw notFound('That application no longer exists.');
    if (verdict === 'forbidden') throw forbidden('You can only undo your own application.');
    if (verdict === 'too_late') {
      throw new ApiError(409, 'UNDO_EXPIRED', 'Undo is only possible within 10 seconds of applying.');
    }
    res.json({ ok: true, undone: req.params.id });
  }));

  /* ================================================================ *
   * 5. last date + urgent hiring
   * ================================================================ */

  r.put('/jobs/:id/deadline', requireAuth(), requireRole('recruiter', 'admin'), wrap(async (req, res) => {
    const body = parse(z.object({
      lastDate: z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-10-31.'), z.literal(''), z.null()]).optional(),
      urgent: z.boolean().optional(),
    }), req.body);
    const sets = [], vals = [];
    if (body.lastDate !== undefined) {
      const at = body.lastDate ? endOfIstDay(body.lastDate) : null;
      if (body.lastDate && !at) throw badRequest('That is not a date.', { lastDate: 'Not a date.' });
      vals.push(at); sets.push(`expires_at = $${vals.length}`);
    }
    if (body.urgent !== undefined) {
      vals.push(body.urgent); sets.push(`urgent = $${vals.length}`);
      /* Switching it on (again) is what announces it. */
      if (body.urgent) sets.push('urgent_alerted_at = null');
    }
    if (!sets.length) throw badRequest('Nothing to change.');
    vals.push(req.params.id);
    const row = await withUser(req.session, async (c) => {
      const upd = await c.query(`update jobs set ${sets.join(', ')} where id = $${vals.length} returning id`, vals);
      if (!upd.rowCount) {
        const seen = await c.query(`select 1 from jobs where id=$1`, [req.params.id]);
        throw seen.rowCount ? forbidden('You cannot change a job belonging to someone else.')
          : notFound('That job no longer exists.');
      }
      return (await c.query(`select * from jobs_with_counts where id=$1`, [req.params.id])).rows[0];
    });
    if (row.urgent && row.status === 'open') kickUrgent(row.id);
    res.json({ job: toJob(row) });
  }));

  /* Saving or publishing a job that is urgent announces it (event A). */
  r.use((req, res, next) => {
    if (!['POST', 'PUT'].includes(req.method)) return next();
    const m = /^\/jobs(?:\/([^/]+)(?:\/publish)?)?\/?$/.exec(req.path);
    if (!m || m[1] === 'describe') return next();
    afterJson(res, (body) => {
      const job = body && body.job;
      if (job && job.urgent && job.status === 'open') kickUrgent(job.id);
    });
    next();
  });

  return r;
}

/* ================================================================ *
 * GET /job/:id - the page a shared link opens
 * ================================================================ */

const BOT = /(bot|crawl|spider|preview|facebookexternalhit|whatsapp|slack|telegram|linkedin|twitter|discord|skype)/i;

/**
 * The application itself, with the job's Open Graph tags in its head, so a
 * link pasted into WhatsApp shows a title, place and pay - and no client
 * name, because no company is read. A tiny script at the very top of the
 * head turns /job/<id>?ref=<code> into /?ref=<code>#/job/<id> before
 * anything else loads, so every relative URL in the page resolves as it
 * always has and the hash route opens the job.
 *
 * A real browser following a ?ref= link counts as a click; link-preview
 * robots do not. The code is kept in a cookie for this job, so an
 * application made after signing up is still credited to the share.
 */
export function mountPublicJobPage(app, staticDir) {
  let cache = null;
  const page = () => {
    const file = join(staticDir, 'index.html');
    const st = statSync(file);
    if (!cache || cache.mtime !== st.mtimeMs) cache = { mtime: st.mtimeMs, html: readFileSync(file, 'utf8') };
    return cache.html;
  };

  app.get('/job/:id', async (req, res, next) => {
    try {
      const id = String(req.params.id || '').slice(0, 64);
      const ref = /^[A-Za-z0-9_-]{6,32}$/.test(String(req.query.ref || '')) ? String(req.query.ref) : null;
      const sj = await withUser(null, (c) => shareableJob(c, id));
      const row = sj && sj.job;

      if (ref && !BOT.test(String(req.headers['user-agent'] || ''))) {
        await withUser(null, (c) => c.query(`select job_share_click($1)`, [ref])).catch(() => {});
        res.cookie(SHARE_COOKIE, `${id}:${ref}`, {
          httpOnly: true, sameSite: 'lax', secure: config.isProd, maxAge: 7 * 86400000, path: '/',
        });
      }

      const url = shareLink(req, `/job/${encodeURIComponent(id)}`);
      const target = `/${ref ? `?ref=${encodeURIComponent(ref)}` : ''}#/job/${encodeURIComponent(id)}`;
      /* 0112: the job's own id when it is public (what Save & Post checks
         before it calls the portal posting "Posted"), and schema.org
         JobPosting when it is published to the TeamLink website. */
      let ld = '';
      if (row) {
        const listed = await withUser(PUBLISHING_ENGINE, (c) => feedRows(c, 'TEAMLINK_WEBSITE', { jobId: id })).catch(() => []);
        if (listed.length) ld = '\n' + jsonLdScript(listed[0]);
      }
      const head = (row
        ? ogTags(row, { url, image: shareLink(req, '/icons/icon-512.png'), company: sj.company })
          + `\n<meta name="teamlink:job" content="${escHtml(id)}">` + ld
        : `<meta property="og:title" content="TeamLink - jobs"><meta property="og:url" content="${escHtml(url)}">`)
        + `\n<script>try{history.replaceState(null,'',${JSON.stringify(target)});}catch(e){location.replace(${JSON.stringify(target)});}</script>`;

      let html = page();
      const at = html.indexOf('<meta charset="UTF-8">');
      if (at < 0) return next();
      const cut = at + '<meta charset="UTF-8">'.length;
      html = html.slice(0, cut) + '\n' + head + html.slice(cut);
      res.setHeader('cache-control', 'no-cache');
      res.type('html').send(html);
    } catch (err) { next(err); }
  });
}
