/**
 * POST /api/search/voice-parse   { text (1..300), lang }
 *
 * Public - a signed-out visitor can search by voice too - and limited to
 * 20 requests a minute per address. The browser turns the voice into text
 * (Web Speech API); only that text arrives here, and it is not logged.
 * What is kept is a count per engine and whether anything was understood.
 *
 * POST /api/search/semantic     { search }: rank the open jobs for a normalized
 *                                search object (voice-semantic.js)
 * GET /api/search/voice-stats    administrator: those counts
 */
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { withUser } from '../db.js';
import { requireAuth, requireRole } from '../auth.js';
import { wrap, badRequest, ApiError, CODES } from '../errors.js';
import { parseVoice } from '../search/voice-parse.js';
import { treeAvailable, treeSearch, treeStatus, treeWarm, treeSoundRows } from '../place-tree.js';
import { buildSoundIndex, soundMatch, SOUND_MIN_POPULATION } from '../search/place-sound.js';
import { hasIndicScript } from '../search/indic-translit.js';
import { boardWordIndex, rankJobs, cleanSearch } from '../search/voice-semantic.js';
import { locationTierFunction, nameOnlyTier } from '../search/saved-match.js';
import { jobsPageScope, teamlinkOnly } from '../jobs/source-scope.js';
import { aiMatch } from '../ai/ai-match.js';

let warming = null;

/*
 * VOICE_DEBUG=true prints how one request was understood. OFF by default:
 * production logs never carry what somebody said.
 */
function debugLog(text, out, semantic) {
  if (process.env.VOICE_DEBUG !== 'true') return;
  const s = out.search || {};
  const line = (k, v) => console.log(`[VOICE ${k}]`, typeof v === 'string' ? v : JSON.stringify(v));
  line('RAW', text); line('LANGUAGE', s.language); line('NORMALIZED', s.normalizedQuery); line('ROLE', s.role);
  line('SKILLS', s.skills); line('TECHNOLOGIES', s.technologies); line('LOCATION', s.location); line('EXPERIENCE', s.experience);
  line('REMOTE', !!s.remote); line('SEMANTIC TERMS', s.semanticTerms); line('FALLBACK', `${semantic.level} ${semantic.levelName}`);
  line('RESULT COUNT', semantic.total);
}

/**
 * The open jobs the VIEWER may see, ranked for a search object.
 * Signed in as a candidate, the candidate's own profile (ai/match.js) is
 * one input to relevance - 5 points of 100, and the L6 "recommended" level.
 */
async function rankFor(session, search) {
  const data = await withUser(session || null, async (c) => ({
    jobs: (await c.query(
      `select j.*, co.name as company_name, co.industry as industry
         from jobs_open j left join companies co on co.id = j.company_id
        /* 0113: TeamLink jobs only - the words' filters rank THIS set */
        where ${teamlinkOnly('j')}
        order by j.published_at desc nulls last, j.id limit 3000`)).rows,
    cand: session && session.role === 'candidate' && session.profileId
      ? (await c.query(`select * from candidates where id=$1`, [session.profileId])).rows[0] || null
      : null,
  }));
  /* the place tree's hierarchy when it is in memory (Hyderabad -> Secunderabad, Gachibowli ...); the name rule until then */
  const tier = treeStatus().loaded ? await locationTierFunction() : nameOnlyTier;
  const memo = new Map();
  const profile = data.cand ? (job) => {
    if (!memo.has(job.id)) {
      let s = 0;
      /* the candidate's AI Match (skills vs the JD), the number on the card */
      try { s = Number(aiMatch(job, data.cand).score) || 0; } catch { s = 0; }
      memo.set(job.id, s);
    }
    return memo.get(job.id);
  } : null;
  /* A job in Hyderabad that may also be done from home is still a Hyderabad
     job: the place decides, "remote" only when the place does not match. */
  const where = (loc, mode, tags) => {
    const t = tier(loc, mode, tags, 0);
    if (t !== 'remote') return t;
    const byPlace = tier(loc, '', tags, 0);
    return byPlace === 'other' ? 'remote' : byPlace;
  };
  return rankJobs(search, data.jobs, { tier: where, profile });
}

/* The place index by sound (place-sound.js), built once the index is in. */
let treeSound = null;
let treeSoundBuilding = null;
async function treeSoundIndex() {
  if (treeSound) return treeSound;
  if (!treeStatus().loaded) return null;
  if (!treeSoundBuilding) {
    treeSoundBuilding = treeSoundRows({ minPopulation: SOUND_MIN_POPULATION })
      .then((rows) => { treeSound = buildSoundIndex(rows, { source: 'tree' }); return treeSound; })
      .catch(() => { treeSoundBuilding = null; return null; });
  }
  return treeSoundBuilding;
}

const stats = { since: new Date().toISOString(), requests: 0, rules: 0, ai: 0, aiFallbacks: 0, understood: 0, empty: 0 };

const limiter = rateLimit({
  windowMs: 60_000,
  max: Number(process.env.VOICE_RATE_LIMIT_MAX || 20),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, _res, next) => next(new ApiError(429, CODES.RATE_LIMITED,
    'Too many voice searches. Please wait a minute and try again.')),
});

/* Latin diacritics off for comparing place names ("Visākhapatnam"). Text in
   another script is only NFC-normalised: decomposing Telugu / Devanagari
   would split its vowel signs, and nothing in it is a Latin diacritic. */
const fold = (v) => {
  const s = String(v || '');
  if (hasIndicScript(s)) return s.normalize('NFC').toLowerCase().trim();
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
};

/* The live board's locations, modes and types, for a minute at a time. */
let board = null;
let boardAt = 0;
async function boardFacts() {
  if (board && Date.now() - boardAt < 60_000) return board;
  const rows = await withUser(null, async (c) => (await c.query(
    `select title, skills, location, mode, employment_type from jobs where ${teamlinkOnly()}`)).rows);   // anon: the public board only
  const places = new Map();
  rows.forEach((r) => String(r.location || '').split(/[,/]/).map((x) => x.trim()).filter(Boolean)
    .forEach((p) => { if (!places.has(fold(p))) places.set(fold(p), p); }));
  board = {
    places,
    sound: buildSoundIndex([...places.values()].map((name) => ({ name, type: 'place' })), { source: 'board' }),
    modes: [...new Set(rows.map((r) => r.mode).filter(Boolean))],
    types: [...new Set(rows.map((r) => r.employment_type).filter(Boolean))],
    /* the board's own job words, so a loanword for any job on it is understood */
    words: boardWordIndex(rows),
  };
  boardAt = Date.now();
  return board;
}

/**
 * A spoken place, resolved the way the location filter resolves places:
 * a town on the live board first, then the place index (state, district,
 * mandal, or a town of some size - so an ordinary word that happens to be
 * a hamlet's name is not taken for a place).
 *
 * Then BY SOUND (place-sound.js): Telugu / Devanagari script is
 * transliterated and matched with spelling tolerance against the board's
 * towns and the index's states, districts and cities - "నెల్లూరు" and
 * "nellooru" are Nellore, "हैदराबाद" is Hyderabad. Still only names the
 * board or the index holds.
 */
async function resolver() {
  const b = await boardFacts();
  return async (name) => {
    const key = fold(name);
    if (key.length < 3) return null;
    if (b.places.has(key)) return { name: b.places.get(key) };
    const bySound = (tree) => {
      const hit = soundMatch(name, [b.sound, tree]);
      return hit ? { name: hit.name, via: hit.via } : null;
    };
    if (!treeAvailable()) return bySound(null);
    /* The index takes several seconds to load the first time. A voice
       search does not wait for it: the load starts in the background and
       this request uses the board's own places. */
    if (!treeStatus().loaded) {
      if (!warming) warming = treeWarm().catch(() => null);
      return bySound(null);
    }
    try {
      if (!hasIndicScript(name)) {
        const hits = await treeSearch(name, { limit: 8 });
        const exact = hits.filter((h) => fold(h.name) === key);
        const ok = exact.find((h) => h.type !== 'place' || Number(h.population || 0) >= 5000);
        if (ok) return { name: ok.name };
      }
      return bySound(await treeSoundIndex());
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
    jobsPageScope(req);                 // 0113: the Jobs page's search - TeamLink jobs only, or 400
    const body = z.object({
      text: z.string().max(300),
      lang: z.enum(['en-IN', 'te-IN', 'hi-IN', 'en', 'te', 'hi']).optional(),
    }).safeParse(req.body || {});
    if (!body.success) throw badRequest('Say up to 300 characters, then try again.');
    const text = body.data.text.replace(/[\u0000-\u001f]/g, ' ').trim();
    if (!text) throw badRequest('We did not hear anything. Please try again.');

    const b = await boardFacts();
    const out = await parseVoice(text, body.data.lang || 'en-IN', {
      resolvePlace: await resolver(), modes: b.modes, types: b.types, boardWords: b.words,
    });
    const semantic = await rankFor(req.session, out.search);
    debugLog(text, out, semantic);

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
      /* the normalized search (never the words said) and the jobs it finds, ranked */
      search: out.search,
      semantic,
    });
  }));

  /**
   * POST /api/search/semantic { search }
   * The same ranking for a search object the browser already holds: after
   * a chip is removed, or when a saved voice search is run again.
   */
  r.post('/search/semantic', limiter, wrap(async (req, res) => {
    jobsPageScope(req);
    const body = z.object({ search: z.record(z.unknown()) }).safeParse(req.body || {});
    if (!body.success) throw badRequest('Give the search to run.');
    const search = cleanSearch(body.data.search);
    res.json({ search, semantic: await rankFor(req.session, search) });
  }));

  r.get('/search/voice-stats', requireAuth(), requireRole('admin'), (_req, res) => {
    res.json({ stats });
  });

  return r;
}
