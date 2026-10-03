/**
 * Resume score + improvement tips (0094).
 *
 *   POST /api/candidate/resume/score           score now (Re-score), optional AI tips
 *   GET  /api/candidate/resume/score           the latest score and tips
 *   GET  /api/candidate/resume/score/history   every score, newest first
 *   GET  /api/resume-scores?ids=a,b            staff: badges for candidates they can see
 *
 * The score is recomputed when the profile or resume changes: triggers
 * put the candidate on a queue (0094), the GET scores a queued candidate
 * before answering, and a sweep works the queue for everybody else - so a
 * recruiter's badge is current without the candidate opening anything.
 *
 * It never decides eligibility and no matching code reads it.
 */
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { withUser } from '../db.js';
import { requireAuth, requireRole } from '../auth.js';
import { wrap, badRequest, ApiError, CODES } from '../errors.js';
import { computeAndStore, toScore, loadInputs } from '../resume/score.js';
import { aiResumeTips } from '../resume/score-ai.js';
import { aiConfigured } from '../ai/structured-call.js';

const ENGINE = { userId: '', role: 'admin', profileId: null };

const scoreLimiter = rateLimit({
  windowMs: 60_000,
  max: Number(process.env.RESUME_SCORE_RATE_MAX || 10),
  keyGenerator: (req) => (req.session && req.session.userId) || req.ip,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  handler: (_req, _res, next) => next(new ApiError(429, CODES.RATE_LIMITED,
    'You have re-scored a few times already. Please wait a minute and try again.')),
});

async function history(candidateId, limit = 50) {
  return withUser(ENGINE, async (c) => (await c.query(
    `select id, status, total_score, label, engine, scored_at from candidate_resume_scores
      where candidate_id = $1 order by scored_at desc, id desc limit $2`, [candidateId, limit])).rows);
}

/** "+12 since last week" and "improved from 62 to 78". */
function progress(rows) {
  const scored = rows.filter((r) => r.status === 'scored');
  const latest = scored[0];
  if (!latest) return { sinceLastWeek: null, previous: null };
  const weekAgo = Date.now() - 7 * 86400000;
  const base = scored.find((r) => new Date(r.scored_at).getTime() <= weekAgo);
  const prev = scored.find((r) => r.id !== latest.id && r.total_score !== latest.total_score) || null;
  return {
    sinceLastWeek: base ? latest.total_score - base.total_score : null,
    previous: prev ? { total: prev.total_score, label: prev.label, scoredAt: new Date(prev.scored_at).toISOString() } : null,
  };
}

async function queued(candidateId) {
  return withUser(ENGINE, async (c) => (await c.query(
    `select resume_score_is_queued($1) as q`, [candidateId])).rows[0].q === true);
}

export default function resumeScoreRoutes() {
  const r = Router();

  r.get('/candidate/resume/score', requireAuth(), requireRole('candidate'), wrap(async (req, res) => {
    const id = req.session.profileId;
    let rows = await history(id, 60);
    if (!rows.length || await queued(id)) {
      await computeAndStore(id);
      rows = await history(id, 60);
    }
    const latest = rows[0]
      ? await withUser(req.session, async (c) => (await c.query(
        `select * from candidate_resume_scores where id = $1`, [rows[0].id])).rows[0])
      : null;
    const p = progress(rows);
    res.json({ score: toScore(latest, { prev: p.previous }), sinceLastWeek: p.sinceLastWeek,
      ai: { configured: aiConfigured() } });
  }));

  r.post('/candidate/resume/score', requireAuth(), requireRole('candidate'), scoreLimiter,
    wrap(async (req, res) => {
      const body = z.object({
        lang: z.enum(['en', 'te', 'hi']).optional(),
        ai: z.boolean().optional(),
      }).strict().safeParse(req.body || {});
      if (!body.success) throw badRequest('That request could not be read.');
      const id = req.session.profileId;

      const before = (await history(id, 60)).find((x) => x.status === 'scored') || null;

      let aiTips = null; let aiInfo = { engine: 'rules', reason: aiConfigured() ? null : 'AI_API_KEY is not set' };
      if (aiConfigured() && body.data.ai !== false) {
        const d = await loadInputs(id);
        const readable = d && d.cand && d.cand.resume_text && !d.cand.resume_parse_error;
        if (readable) {
          const names = await withUser(ENGINE, async (c) => (await c.query(`select name from companies`)).rows.map((x) => x.name));
          aiInfo = await aiResumeTips({
            text: d.cand.resume_text,
            skills: [...(d.cand.skills || []), ...(d.cand.technical_skills || [])],
            role: d.cand.preferred_role || d.cand.title,
            lang: body.data.lang || 'en',
            companyNames: names,
          });
          if (aiInfo.tips.length) aiTips = aiInfo.tips;
        } else {
          aiInfo = { engine: 'rules', reason: 'no readable resume text' };
        }
      }

      const out = await computeAndStore(id, { aiTips, force: !!aiTips });
      if (!out) throw badRequest('Your profile could not be found.');
      const rows = await history(id, 60);
      const p = progress(rows);
      const now = out.row;
      const improvement = before && now.status === 'scored' && before.id !== now.id
        ? { from: before.total_score, to: now.total_score } : null;
      res.json({
        score: toScore(now, { prev: p.previous }),
        sinceLastWeek: p.sinceLastWeek,
        improvement,
        engine: aiTips ? 'ai' : 'rules',
        aiReason: aiTips ? null : aiInfo.reason || null,
      });
    }));

  r.get('/candidate/resume/score/history', requireAuth(), requireRole('candidate'), wrap(async (req, res) => {
    const rows = await withUser(req.session, async (c) => (await c.query(
      `select id, status, total_score, label, engine, scored_at from candidate_resume_scores
        where candidate_id = $1 order by scored_at desc, id desc limit 100`, [req.session.profileId])).rows);
    const p = progress(rows);
    res.json({
      history: rows.map((x) => ({ id: String(x.id), status: x.status, total: x.total_score, label: x.label,
        engine: x.engine, scoredAt: new Date(x.scored_at).toISOString() })),
      sinceLastWeek: p.sinceLastWeek,
    });
  }));

  /* Staff: the badge for each candidate on screen they may see. */
  r.get('/resume-scores', requireAuth(), requireRole('recruiter', 'bde', 'admin', 'client'),
    wrap(async (req, res) => {
      const ids = String(req.query.ids || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 200);
      if (!ids.length) return res.json({ scores: {} });
      const vis = await withUser(req.session, async (c) => {
        const visible = (await c.query(`select id from candidates where id = any($1)`, [ids])).rows.map((x) => x.id);
        const have = (await c.query(
          `select candidate_id, status, total_score, label from candidate_resume_score_visible_v
            where candidate_id = any($1)`, [visible])).rows;
        return { visible, have };
      });
      /* Not scored yet: score a handful now so the badge is not blank. */
      const missing = vis.visible.filter((id) => !vis.have.some((h) => h.candidate_id === id)).slice(0, 20);
      for (const id of missing) {
        try {
          const o = await computeAndStore(id);
          if (o && o.row) vis.have.push({ candidate_id: id, status: o.row.status, total_score: o.row.total_score, label: o.row.label });
        } catch { /* a badge is a convenience */ }
      }
      const scores = {};
      vis.have.forEach((h) => { scores[h.candidate_id] = { status: h.status, total: h.total_score, label: h.label }; });
      res.json({ scores });
    }));

  return r;
}
