/**
 * A candidate's saved searches - which are also their job alerts.
 *
 *   GET    /api/saved-searches              list, each with newCount
 *   POST   /api/saved-searches              save one
 *   PUT    /api/saved-searches/:id          rename / frequency / channels / filters
 *   DELETE /api/saved-searches/:id
 *   POST   /api/saved-searches/:id/viewed   "I have seen these" - clears newCount
 *   GET    /api/saved-searches/stop?token=  the email's "Stop this alert",
 *                                           no sign-in needed
 *
 * Candidate only, CSRF-protected like every other write, and under the
 * API's rate limit. Row level security (0086) is what keeps one
 * candidate's searches from another; the routes do not re-implement it.
 */
import { Router } from 'express';
import { z } from 'zod';
import { withUser } from '../db.js';
import { wrap, badRequest, notFound, conflict, ApiError, fromPgError } from '../errors.js';
import { requireAuth, requireRole } from '../auth.js';
import { toCandidate } from '../shapes.js';
import {
  normalizeFilters, labelFor, isEmptySearch, jobMatchesFilters, locationTierFunction,
} from '../search/saved-match.js';
import { verifyStopToken, asMatchable, asMatchableExternal } from '../notify/saved-search-alerts.js';
import { SOURCE_TYPES, TEAMLINK, EXTERNAL, teamlinkOnly } from '../jobs/source-scope.js';

const ENGINE = { userId: '', role: 'admin', profileId: null };
const FREQ = ['off', 'instant', 'daily', 'weekly'];
const CH = ['email', 'sms', 'whatsapp', 'push'];
const MAX = 20;

const newId = () => `ss_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

const body = z.object({
  label: z.string().trim().max(80).optional(),
  filters: z.unknown().optional(),
  alert_frequency: z.enum(FREQ).optional(),
  channels: z.array(z.enum(CH)).max(4).optional(),
  /* 0113: the page the search was made on. Stored, and always kept: the
     Jobs page's searches are TEAMLINK, the External Jobs page's EXTERNAL. */
  sourceType: z.enum(SOURCE_TYPES).optional(),
}).strict();

function parse(input, { requireFilters }) {
  const b = body.safeParse(input || {});
  if (!b.success) {
    const details = {};
    for (const i of b.error.issues) details[i.path.join('.') || 'form'] = i.message;
    throw badRequest('Please check the saved search and try again.', details);
  }
  const out = { ...b.data };
  if (requireFilters || out.filters !== undefined) {
    const f = normalizeFilters(out.filters);
    if (!f.ok) throw badRequest('That search has a filter we do not recognise.', f.details);
    if (isEmptySearch(f.filters)) {
      throw badRequest('Add a keyword, a location or a filter before saving this search.',
        { filters: 'An empty search would match every job.' });
    }
    out.filters = f.filters;
  }
  if (out.channels) out.channels = [...new Set(out.channels)];
  return out;
}

function shape(r, newCount) {
  return {
    id: r.id,
    label: r.label,
    filters: r.filters || {},
    sourceType: r.source_type === EXTERNAL ? EXTERNAL : TEAMLINK,
    alertFrequency: r.alert_frequency,
    channels: r.channels || [],
    newCount: newCount ?? 0,
    lastViewedAt: r.last_viewed_at ? new Date(r.last_viewed_at).toISOString() : null,
    lastAlertedAt: r.last_alerted_at ? new Date(r.last_alerted_at).toISOString() : null,
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
    updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
  };
}

/** Channels the candidate can actually be reached on, as the default. */
function reachable(cand) {
  const out = [];
  if (cand.email && cand.emailOptIn !== false) out.push('email');
  if (cand.phone && cand.smsOptIn !== false) out.push('sms');
  if (cand.phone && cand.whatsappOptIn) out.push('whatsapp');
  return out.length ? out : ['email'];
}

/** Map the database's refusals onto messages a person can act on. */
function explain(err) {
  const msg = String(err && err.message || '');
  if (/saved_search_limit/.test(msg)) {
    return new ApiError(409, 'SAVED_SEARCH_LIMIT',
      `You can keep up to ${MAX} saved searches. Delete one to save another.`);
  }
  if (err && err.code === '23505' && /label/.test(err.constraint || '')) {
    return conflict('DUPLICATE_LABEL', 'You already have a saved search with that name.');
  }
  return fromPgError(err) || err;
}

/** newCount for each search: open jobs published since it was last viewed -
    in the dataset the search was saved on, and only that one (0113). */
/*
 * `tier` is worked out BEFORE the transaction and handed in. The first
 * call loads the place index (tens of MB, several seconds); awaited in
 * here it held the database connection - on the embedded engine the ONLY
 * connection - for all of that time, so every other request, a page
 * reload included, queued behind it and timed out ("timeout exceeded
 * when trying to connect"). The alert engine already did it this way.
 */
async function withNewCounts(c, rows, tier) {
  if (!rows.length) return [];
  const pool = { [TEAMLINK]: null, [EXTERNAL]: null };
  if (rows.some((r) => r.source_type !== EXTERNAL)) {
    pool[TEAMLINK] = (await c.query(
      `select j.*, co.name as company_name
         from jobs j left join companies co on co.id = j.company_id
        where j.status = 'open' and not coalesce(j.paused,false) and not coalesce(j.archived,false)
          and ${teamlinkOnly('j')}`)).rows
      .map(asMatchable);
  }
  if (rows.some((r) => r.source_type === EXTERNAL)) {
    pool[EXTERNAL] = (await c.query(
      `select x.*, s.name as source_name
         from external_jobs x left join job_sources s on s.id = x.source_id
        where x.status = 'open'`)).rows.map(asMatchableExternal);
  }
  const hidden = new Set((await c.query(`select job_id from hidden_jobs`)).rows.map((r) => r.job_id));
  const now = Date.now();
  return rows.map((r) => {
    const since = new Date(r.last_viewed_at).getTime();
    const jobs = pool[r.source_type === EXTERNAL ? EXTERNAL : TEAMLINK] || [];
    const n = jobs.filter((j) => !hidden.has(j.id) && j.publishedAt && Date.parse(j.publishedAt) > since
      && jobMatchesFilters(j, r.filters, { now, locationTier: tier })).length;
    return shape(r, n);
  });
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (m) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m]);

function stopPage(title, line) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · TeamLink</title>
<style>body{margin:0;background:#f4f7fb;font:15px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#16202c}
main{max-width:480px;margin:12vh auto;padding:28px 26px;background:#fff;border:1px solid #e6ebf2;border-radius:14px}
h1{font-size:19px;margin:0 0 8px}p{margin:0 0 14px;color:#42505f}a{color:#1d6ff2;font-weight:700}</style></head>
<body><main><h1>${esc(title)}</h1><p>${line}</p><p><a href="/#/candidate/alerts">Open your job alerts</a></p></main></body></html>`;
}

export default function savedSearchRoutes() {
  const r = Router();

  /* The email link. Declared before /:id so "stop" is never read as an id. */
  r.get('/saved-searches/stop', wrap(async (req, res) => {
    res.set('Content-Type', 'text/html; charset=utf-8');
    const id = verifyStopToken(req.query.token);
    if (!id) {
      return res.status(400).send(stopPage('That link is not valid',
        'It may have been cut short by your email app. You can turn the alert off from Job Alerts instead.'));
    }
    const label = await withUser(ENGINE, async (c) =>
      (await c.query(`select saved_search_stop($1) as label`, [id])).rows[0].label);
    if (!label) {
      return res.status(404).send(stopPage('Nothing to stop',
        'That saved search no longer exists, so there are no alerts left for it.'));
    }
    return res.send(stopPage('Alert stopped',
      `You will not get any more messages for <b>${esc(label)}</b>. The search itself is still saved, `
      + 'and you can turn its alerts back on whenever you like.'));
  }));

  r.get('/saved-searches', requireAuth(), requireRole('candidate'), wrap(async (req, res) => {
    const tier = await locationTierFunction();
    const list = await withUser(req.session, async (c) => {
      const rows = (await c.query(
        `select * from candidate_saved_searches order by created_at desc`)).rows;
      return withNewCounts(c, rows, tier);
    });
    res.json({ savedSearches: list, limit: MAX });
  }));

  r.post('/saved-searches', requireAuth(), requireRole('candidate'), wrap(async (req, res) => {
    const b = parse(req.body, { requireFilters: true });
    const out = await withUser(req.session, async (c) => {
      const me = (await c.query(`select * from candidates where id = $1`, [req.session.profileId])).rows[0];
      if (!me) throw notFound('Your profile could not be found.');

      // The same search saved again (on the same page) is the one already there.
      const same = (await c.query(
        `select * from candidate_saved_searches where filters_key = md5($1::jsonb::text) and source_type = $2`,
        [JSON.stringify(b.filters), b.sourceType || TEAMLINK])).rows[0];
      if (same) return { duplicate: same };

      const label = b.label || labelFor(b.filters);
      let finalLabel = label;
      if (!b.label) {
        // A generated name that is already taken gets a number, rather
        // than refusing a search the candidate did not name.
        const taken = new Set((await c.query(`select lower(label) l from candidate_saved_searches`)).rows.map((x) => x.l));
        for (let n = 2; taken.has(finalLabel.toLowerCase()) && n < 50; n += 1) {
          finalLabel = `${label.slice(0, 74)} (${n})`;
        }
      }
      const row = (await c.query(
        `insert into candidate_saved_searches (id, candidate_id, label, filters, alert_frequency, channels, source_type)
         values ($1,$2,$3,$4::jsonb,$5,$6,$7) returning *`,
        [newId(), req.session.profileId, finalLabel, JSON.stringify(b.filters),
         b.alert_frequency || 'daily', b.channels || reachable(toCandidate(me)), b.sourceType || TEAMLINK])).rows[0];
      return { row };
    }).catch((err) => { throw explain(err); });

    if (out.duplicate) {
      return res.status(409).json({
        error: { code: 'DUPLICATE_SEARCH', message: 'You have already saved this search.',
                 details: { id: out.duplicate.id } },
        savedSearch: shape(out.duplicate, 0),
        id: out.duplicate.id,
      });
    }
    res.status(201).json({ savedSearch: shape(out.row, 0) });
  }));

  r.put('/saved-searches/:id', requireAuth(), requireRole('candidate'), wrap(async (req, res) => {
    const b = parse(req.body, { requireFilters: false });
    const sets = []; const vals = [];
    const put = (col, v, cast = '') => { vals.push(v); sets.push(`${col} = $${vals.length}${cast}`); };
    if (b.label !== undefined) {
      if (!b.label) throw badRequest('Give the search a name.', { label: 'A name is required.' });
      put('label', b.label);
    }
    if (b.filters !== undefined) put('filters', JSON.stringify(b.filters), '::jsonb');
    if (b.alert_frequency !== undefined) put('alert_frequency', b.alert_frequency);
    if (b.channels !== undefined) put('channels', b.channels);
    if (!sets.length) throw badRequest('Nothing to change.');
    vals.push(req.params.id);

    const row = await withUser(req.session, async (c) => {
      /* 0113: the dataset a search runs on is fixed when it is saved. */
      if (b.sourceType !== undefined) {
        const cur = (await c.query(`select source_type from candidate_saved_searches where id = $1`, [req.params.id])).rows[0];
        if (cur && cur.source_type !== b.sourceType) {
          throw new ApiError(400, 'SOURCE_SCOPE', 'A saved search stays on the page it was saved from.',
            { sourceType: cur.source_type });
        }
      }
      return (await c.query(`update candidate_saved_searches set ${sets.join(', ')} where id = $${vals.length} returning *`,
        vals)).rows[0];
    })
      .catch((err) => {
        if (err && err.code === '23505' && /filters/.test(err.constraint || '')) {
          throw conflict('DUPLICATE_SEARCH', 'You already have another saved search with exactly these filters.');
        }
        throw explain(err);
      });
    if (!row) throw notFound('That saved search no longer exists.');
    res.json({ savedSearch: shape(row, 0) });
  }));

  r.delete('/saved-searches/:id', requireAuth(), requireRole('candidate'), wrap(async (req, res) => {
    const n = await withUser(req.session, async (c) =>
      (await c.query(`delete from candidate_saved_searches where id = $1`, [req.params.id])).rowCount);
    if (!n) throw notFound('That saved search no longer exists.');
    res.json({ ok: true });
  }));

  r.post('/saved-searches/:id/viewed', requireAuth(), requireRole('candidate'), wrap(async (req, res) => {
    const row = await withUser(req.session, async (c) =>
      (await c.query(`update candidate_saved_searches set last_viewed_at = now() where id = $1 returning *`,
        [req.params.id])).rows[0]);
    if (!row) throw notFound('That saved search no longer exists.');
    res.json({ savedSearch: shape(row, 0) });
  }));

  return r;
}
