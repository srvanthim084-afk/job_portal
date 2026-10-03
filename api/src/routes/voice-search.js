/**
 * POST /api/search/voice-parse   { text (1..300), lang }
 *
 * Public - a signed-out visitor can search by voice too - and limited to
 * 20 requests a minute per address. The browser turns the voice into text
 * (Web Speech API); only that text arrives here, and it is not logged.
 * What is kept is a count per engine and whether anything was understood.
 *
 * GET /api/search/voice-stats    administrator: those counts
 */
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { withUser } from '../db.js';
import { requireAuth, requireRole } from '../auth.js';
import { wrap, badRequest, ApiError, CODES } from '../errors.js';
import { parseVoice } from '../search/voice-parse.js';
import { treeAvailable, treeSearch, treeStatus, treeWarm } from '../place-tree.js';

let warming = null;

const stats = { since: new Date().toISOString(), requests: 0, rules: 0, ai: 0, aiFallbacks: 0, understood: 0, empty: 0 };

const limiter = rateLimit({
  windowMs: 60_000,
  max: Number(process.env.VOICE_RATE_LIMIT_MAX || 20),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, _res, next) => next(new ApiError(429, CODES.RATE_LIMITED,
    'Too many voice searches. Please wait a minute and try again.')),
});

const fold = (v) => String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/* The live board's locations, modes and types, for a minute at a time. */
let board = null;
let boardAt = 0;
async function boardFacts() {
  if (board && Date.now() - boardAt < 60_000) return board;
  const rows = await withUser(null, async (c) => (await c.query(
    `select location, mode, employment_type from jobs`)).rows);   // anon: the public board only
  const places = new Map();
  rows.forEach((r) => String(r.location || '').split(/[,/]/).map((x) => x.trim()).filter(Boolean)
    .forEach((p) => { if (!places.has(fold(p))) places.set(fold(p), p); }));
  board = {
    places,
    modes: [...new Set(rows.map((r) => r.mode).filter(Boolean))],
    types: [...new Set(rows.map((r) => r.employment_type).filter(Boolean))],
  };
  boardAt = Date.now();
  return board;
}

/**
 * A spoken place, resolved the way the location filter resolves places:
 * a town on the live board first, then the place index (state, district,
 * mandal, or a town of some size - so an ordinary word that happens to be
 * a hamlet's name is not taken for a place).
 */
async function resolver() {
  const b = await boardFacts();
  return async (name) => {
    const key = fold(name);
    if (key.length < 3) return null;
    if (b.places.has(key)) return { name: b.places.get(key) };
    if (!treeAvailable()) return null;
    /* The index takes several seconds to load the first time. A voice
       search does not wait for it: the load starts in the background and
       this request uses the board's own places. */
    if (!treeStatus().loaded) {
      if (!warming) warming = treeWarm().catch(() => null);
      return null;
    }
    try {
      const hits = await treeSearch(name, { limit: 8 });
      const exact = hits.filter((h) => fold(h.name) === key);
      const ok = exact.find((h) => h.type !== 'place' || Number(h.population || 0) >= 5000);
      return ok ? { name: ok.name } : null;
    } catch { return null; }
  };
}

export default function voiceSearchRoutes() {
  const r = Router();
  /* Warm the place index soon after start, off the request path. */
  if (process.env.NODE_ENV !== 'test' && treeAvailable()) {
    const t = setTimeout(() => { if (!warming) warming = treeWarm().catch(() => null); }, 20_000);
    t.unref?.();
  }

  r.post('/search/voice-parse', limiter, wrap(async (req, res) => {
    const body = z.object({
      text: z.string().max(300),
      lang: z.enum(['en-IN', 'te-IN', 'hi-IN', 'en', 'te', 'hi']).optional(),
    }).safeParse(req.body || {});
    if (!body.success) throw badRequest('Say up to 300 characters, then try again.');
    const text = body.data.text.replace(/[\u0000-\u001f]/g, ' ').trim();
    if (!text) throw badRequest('We did not hear anything. Please try again.');

    const b = await boardFacts();
    const out = await parseVoice(text, body.data.lang || 'en-IN', {
      resolvePlace: await resolver(), modes: b.modes, types: b.types,
    });

    stats.requests += 1;
    stats[out.engine] += 1;
    if (out.fallbackReason) stats.aiFallbacks += 1;
    if (out.understood.length) stats.understood += 1; else stats.empty += 1;

    res.json({
      filters: out.filters,
      portal: out.portal,
      understood: out.understood,
      chips: out.chips,
      notes: out.notes,
      engine: out.engine,
    });
  }));

  r.get('/search/voice-stats', requireAuth(), requireRole('admin'), (_req, res) => {
    res.json({ stats });
  });

  return r;
}
