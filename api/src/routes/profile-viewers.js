/**
 * Who viewed my profile (0093).
 *
 *   POST /api/candidates/:id/viewed            staff opened a profile / resume
 *   POST /api/candidates/search-appearances    the page of search results shown
 *   GET  /api/candidate/profile-viewers        the candidate's page
 *   PUT  /api/candidate/profile-viewers/prefs  digest by email / WhatsApp
 *   GET  /api/admin/profile-viewer-settings    names on/off, digest on/off
 *   PUT  /api/admin/profile-viewer-settings
 *
 * THE VIEWER IS THE SESSION. Nothing in a request body can say who viewed
 * or in what role; the definer function reads both from the transaction's
 * identity. A candidate looking at themselves, an administrator's Login As
 * session and the background engines record nothing.
 *
 * WHAT A CANDIDATE GETS BACK is the display name, "recruiter" or
 * "hiring_team", the role title when that job is visible to them, when,
 * and how - never an id, an email, a phone number, a company or a client.
 */
import { Router } from 'express';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { withUser } from '../db.js';
import { requireAuth, requireRole } from '../auth.js';
import { wrap, badRequest, notFound } from '../errors.js';
import { readAppearanceToken, claimOnce } from '../profile-viewers/appearances.js';

const sha256 = (s) => createHash('sha256').update(String(s || '')).digest('hex');
const STAFF = ['recruiter', 'bde', 'client', 'admin'];
const SOURCES = ['profile', 'resume', 'search_card', 'application'];
const PAGE = 20;

/** Called by the Login As route, so views from that session do not count. */
export async function markImpersonatedSession(adminSession, token) {
  try {
    await withUser(adminSession, (c) => c.query(`select session_mark_impersonated($1)`, [sha256(token)]));
  } catch (err) {
    console.error('[profile-viewers] could not mark an impersonated session:', err.message);
  }
}

async function settings(c) {
  const row = (await c.query(`select value from app_settings where key = 'profile_viewers'`)).rows[0];
  const v = (row && row.value) || {};
  return {
    showRecruiterNames: v.showRecruiterNames !== false,
    dailyDigest: v.dailyDigest !== false,
  };
}

const pct = (now, prev) => (prev > 0 ? Math.round(((now - prev) / prev) * 100) : null);

export default function profileViewerRoutes() {
  const r = Router();

  /* ---------------------------------------------------------------- *
   * recording a view
   * ---------------------------------------------------------------- */
  r.post('/candidates/:id/viewed', requireAuth(), wrap(async (req, res) => {
    const body = z.object({
      jobId: z.string().trim().max(80).optional().nullable(),
      source: z.enum(SOURCES).optional(),
    }).safeParse(req.body || {});
    if (!body.success) throw badRequest('That view could not be recorded.');

    if (!STAFF.includes(req.session.role)) {
      return res.json({ recorded: false, reason: req.session.role === 'candidate' ? 'self' : 'not_staff' });
    }

    const out = await withUser(req.session, async (c) => {
      // Under the caller's own rights: a profile they cannot open is a
      // profile they cannot be recorded as having viewed.
      const seen = await c.query(`select 1 from candidates where id = $1`, [req.params.id]);
      if (!seen.rowCount) return null;
      let jobId = body.data.jobId || null;
      if (jobId) {
        const j = await c.query(`select 1 from jobs where id = $1`, [jobId]);
        if (!j.rowCount) jobId = null;       // not theirs to name
      }
      const r2 = await c.query(`select profile_view_record($1,$2,$3,$4) as r`,
        [req.params.id, jobId, body.data.source || 'profile', req.session.tokenHash || '']);
      return r2.rows[0].r;
    });
    if (out === null) throw notFound('That candidate could not be found.');
    res.json({ recorded: out === 'recorded' || out === 'repeat', reason: out });
  }));

  /* ---------------------------------------------------------------- *
   * search appearances - only the ids the server returned, only the
   * ones the page showed
   * ---------------------------------------------------------------- */
  r.post('/candidates/search-appearances', requireAuth(), requireRole(...STAFF),
    wrap(async (req, res) => {
      const body = z.object({
        token: z.string().min(10).max(40_000),
        ids: z.array(z.string().max(80)).max(200),
      }).safeParse(req.body || {});
      if (!body.success) throw badRequest('That search could not be recorded.');

      const tok = readAppearanceToken(body.data.token, req.session);
      if (!tok) return res.json({ credited: 0, reason: 'token' });
      const shown = [...new Set(body.data.ids.map(String))].filter((id) => tok.ids.has(id));
      const fresh = claimOnce(tok.sig, shown);
      if (!fresh.length) return res.json({ credited: 0 });

      const credited = await withUser(req.session, async (c) => {
        const visible = (await c.query(`select id from candidates where id = any($1)`, [fresh]))
          .rows.map((x) => x.id);
        if (!visible.length) return 0;
        /* The sample is role + city. Anything that names a company is
           dropped: a candidate is never told which client searched. */
        const names = (await c.query(`select lower(name) n from companies where length(btrim(name)) >= 3`))
          .rows.map((x) => x.n);
        const words = new Set(names.flatMap((n) => n.split(/[^\p{L}\p{N}]+/u)).filter((w) => w.length >= 4));
        const namesCompany = (v) => {
          const l = v.toLowerCase();
          return names.some((n) => l.includes(n) || n.includes(l))
            || l.split(/[^\p{L}\p{N}]+/u).some((w) => words.has(w));
        };
        const sample = {};
        for (const k of ['role', 'city']) {
          const v = String(tok.sample[k] || '');
          if (v && !namesCompany(v) && !/client/i.test(v)) sample[k] = v;
        }
        return (await c.query(`select profile_search_appearances_add($1,$2,$3) as n`,
          [visible, JSON.stringify(sample), req.session.tokenHash || ''])).rows[0].n;
      });
      res.json({ credited });
    }));

  /* ---------------------------------------------------------------- *
   * the candidate's page
   * ---------------------------------------------------------------- */
  r.get('/candidate/profile-viewers', requireAuth(), requireRole('candidate'), wrap(async (req, res) => {
    const page = Math.max(1, Math.min(parseInt(req.query.page, 10) || 1, 500));
    const out = await withUser(req.session, async (c) => {
      const summary = (await c.query(`select profile_viewer_summary() as s`)).rows[0].s;
      const total = (await c.query(`select count(*)::int n from candidate_profile_viewers_v`)).rows[0].n;
      const rows = (await c.query(
        `select display_name, viewer_kind, role_title, viewed_at, source, view_count
           from candidate_profile_viewers_v
          order by viewed_at desc, row_id desc
          limit $1 offset $2`, [PAGE, (page - 1) * PAGE])).rows;
      const prefs = (await c.query(`select digest_email, digest_whatsapp from candidate_profile_view_prefs
                                     where candidate_id = $1`, [req.session.profileId])).rows[0] || null;
      const cand = (await c.query(`select email, phone, whatsapp_opt_in from candidates where id = $1`,
        [req.session.profileId])).rows[0] || {};
      let score = null;
      try {
        score = (await c.query(
          `select status, total_score, label, tips from candidate_resume_scores
            where candidate_id = $1 order by scored_at desc, id desc limit 1`, [req.session.profileId])).rows[0] || null;
      } catch { score = null; }
      const s = await settings(c);
      return { summary, total, rows, prefs, cand, score, s };
    });

    const sm = out.summary || {};
    /* "Few views": point at the resume score and its best tip. */
    let tip = null;
    if ((sm.views30 || 0) < 3) {
      const best = out.score && out.score.status === 'scored' && Array.isArray(out.score.tips) && out.score.tips[0];
      tip = {
        resumeScore: out.score && out.score.status === 'scored' ? out.score.total_score : null,
        text: out.score && out.score.status === 'scored'
          ? `Profile score ${out.score.total_score}. ${best ? best.fix : 'Keep your profile up to date'} to get more views.`
          : 'Check your resume score and add the missing details to get more views.',
        link: '#/candidate/resume-score',
      };
    }

    res.json({
      summary: {
        views30: sm.views30 || 0, viewsPrev30: sm.viewsPrev30 || 0, viewsChangePct: pct(sm.views30 || 0, sm.viewsPrev30 || 0),
        viewsToday: sm.viewsToday || 0, viewsTotal: sm.viewsTotal || 0,
        appear30: sm.appear30 || 0, appearPrev30: sm.appearPrev30 || 0, appear90: sm.appear90 || 0,
        shortlisted30: sm.shortlisted30 || 0, shortlistedPrev30: sm.shortlistedPrev30 || 0,
        weeks: sm.weeks || [],
        searches: (sm.searches || []).map((x) => ({ day: x.day, count: x.count, role: x.role || null, city: x.city || null })),
      },
      viewers: out.rows.map((x) => ({
        displayName: x.display_name,
        viewerKind: x.viewer_kind,
        roleTitle: x.role_title || null,
        viewedAt: x.viewed_at ? new Date(x.viewed_at).toISOString() : null,
        source: x.source,
        viewCount: x.view_count,
      })),
      page, pageSize: PAGE, total: out.total,
      prefs: {
        digestEmail: !!(out.prefs && out.prefs.digest_email),
        digestWhatsapp: !!(out.prefs && out.prefs.digest_whatsapp),
        canEmail: !!out.cand.email, canWhatsapp: !!out.cand.phone,
      },
      dailyDigest: out.s.dailyDigest,
      tip,
    });
  }));

  r.put('/candidate/profile-viewers/prefs', requireAuth(), requireRole('candidate'), wrap(async (req, res) => {
    const body = z.object({
      digestEmail: z.boolean().optional(),
      digestWhatsapp: z.boolean().optional(),
    }).strict().safeParse(req.body || {});
    if (!body.success) throw badRequest('Please choose on or off.');
    const row = await withUser(req.session, async (c) => (await c.query(
      `insert into candidate_profile_view_prefs (candidate_id, digest_email, digest_whatsapp)
       values ($1, coalesce($2, false), coalesce($3, false))
       on conflict (candidate_id) do update
         set digest_email = coalesce($2, candidate_profile_view_prefs.digest_email),
             digest_whatsapp = coalesce($3, candidate_profile_view_prefs.digest_whatsapp),
             updated_at = now()
       returning digest_email, digest_whatsapp`,
      [req.session.profileId, body.data.digestEmail ?? null, body.data.digestWhatsapp ?? null])).rows[0]);
    res.json({ prefs: { digestEmail: row.digest_email, digestWhatsapp: row.digest_whatsapp } });
  }));

  /* ---------------------------------------------------------------- *
   * administrator settings
   * ---------------------------------------------------------------- */
  r.get('/admin/profile-viewer-settings', requireAuth(), requireRole('admin'), wrap(async (req, res) => {
    res.json({ settings: await withUser(req.session, settings) });
  }));

  r.put('/admin/profile-viewer-settings', requireAuth(), requireRole('admin'), wrap(async (req, res) => {
    const body = z.object({
      showRecruiterNames: z.boolean().optional(),
      dailyDigest: z.boolean().optional(),
    }).strict().safeParse(req.body || {});
    if (!body.success) throw badRequest('Please choose on or off.');
    const out = await withUser(req.session, async (c) => {
      const cur = await settings(c);
      const next = { ...cur, ...body.data };
      await c.query(
        `insert into app_settings (key, value) values ('profile_viewers', $1::jsonb)
         on conflict (key) do update set value = excluded.value, updated_at = now()`,
        [JSON.stringify(next)]);
      return settings(c);
    });
    res.json({ settings: out });
  }));

  return r;
}
