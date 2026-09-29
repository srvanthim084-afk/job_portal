/**
 * Every place in India, and how they contain one another.
 *
 * WHAT WAS MISSING. places.js already holds 549,026 populated places and
 * answers "what is within N kilometres of this point" quickly. It also
 * holds the 763 districts and 6,891 mandals - and NOT the link between
 * them, because the builder kept the state column and dropped the two
 * that say which district and which mandal a row belongs to.
 *
 * So the browse tree listed states and districts out of a hand-written
 * map in the page and then stopped. There was nothing below a district
 * to walk to, and a recruiter could not pick a mandal, a town or a
 * village at all.
 *
 * This loads the same dump rebuilt WITH those links (tools/build-place-
 * tree.mjs) and answers the three questions the selector needs:
 *
 *     children of a node          the browse tree, one level at a time
 *     search across every level   the typeahead, with a full path
 *     everything under a node     so ticking a district matches the
 *                                 candidates living in its villages
 *
 * LOADED ONCE, LAZILY, AND HELD. Nothing reads the file until the first
 * question. After that it is resident: five typed arrays and the names,
 * which measures around 70 MB for 556,716 rows. No query afterwards
 * touches the disk and none of them calls anything over the network -
 * expansion, search and distance are all local, which is what makes
 * dragging the radius instant.
 *
 * PARENTS ARE INDICES, NOT IDS. A string id per row would be another
 * half a million strings and a map lookup on every hop; an Int32 is the
 * row number and the hop is an array read.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

const FILE = process.env.PLACE_TREE_FILE
  || join(process.cwd(), 'var', 'places', 'india-tree.tsv');

/*
 * Diacritics off, case off. GeoNames writes "Visākhapatnam" and
 * "Meghālaya"; nobody types the macron, and a filter that only matches
 * what it printed is a filter that finds nothing.
 */
function foldName(v) {
  return String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

const TYPES = ['state', 'district', 'mandal', 'place'];
const TYPE_ID = { state: 0, district: 1, mandal: 2, place: 3 };

const CELL = 0.5;                       // degrees; ~55 km, as places.js
const EARTH_KM = 6371;
const rad = (d) => (d * Math.PI) / 180;

let idx = null;
let loading = null;

export function treeAvailable() { return existsSync(FILE); }

export function treeStatus() {
  if (!existsSync(FILE)) {
    return { available: false, reason: `no place tree at ${FILE}` };
  }
  const size = statSync(FILE).size;
  return {
    available: true,
    file: FILE,
    megabytes: Number((size / 1e6).toFixed(1)),
    loaded: !!idx,
    counts: idx ? idx.counts : null,
  };
}

/* ------------------------------------------------------------------ *
 * loading
 * ------------------------------------------------------------------ */

function cellKey(lat, lon) {
  return `${Math.floor(lat / CELL)}:${Math.floor(lon / CELL)}`;
}

async function load() {
  if (idx) return idx;
  if (loading) return loading;

  loading = (async () => {
    if (!existsSync(FILE)) {
      throw new Error(`place tree not found at ${FILE} — run tools/build-place-tree.mjs`);
    }

    const names = [];
    const aliases = [];
    const ids = [];
    const rows = [];                      // parsed parent ids, resolved below

    const lat = [];
    const lon = [];
    const pop = [];
    const type = [];

    const byId = new Map();               // geonames id -> row index

    const rl = createInterface({
      input: createReadStream(FILE, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });

    let i = 0;
    for await (const line of rl) {
      if (!line) continue;
      const f = line.split('\t');
      if (f.length < 7) continue;
      const la = Number(f[4]);
      const lo = Number(f[5]);
      if (!Number.isFinite(la) || !Number.isFinite(lo)) continue;

      ids.push(f[0]);
      names.push(f[1]);
      type.push(TYPE_ID[f[2]] ?? 3);
      rows.push(f[3] || '');
      lat.push(la);
      lon.push(lo);
      pop.push(Number(f[6]) || 0);
      aliases.push(f[7] || '');
      byId.set(f[0], i);
      i += 1;
    }

    const n = i;
    const parent = new Int32Array(n).fill(-1);
    for (let k = 0; k < n; k += 1) {
      const p = rows[k];
      if (p) {
        const at = byId.get(p);
        if (at !== undefined) parent[k] = at;
      }
    }

    /*
     * CHILDREN, COUNTED ONCE.
     *
     * The tree shows a count on every row and expands lazily, so both
     * answers have to be instant. Built as one flat Int32Array with an
     * offset per parent - half a million small arrays would be half a
     * million objects.
     */
    const childCount = new Int32Array(n);
    for (let k = 0; k < n; k += 1) if (parent[k] >= 0) childCount[parent[k]] += 1;

    const childStart = new Int32Array(n + 1);
    for (let k = 0; k < n; k += 1) childStart[k + 1] = childStart[k] + childCount[k];
    const childAt = new Int32Array(childStart[n]);
    const cursor = Int32Array.from(childStart.subarray(0, n));
    for (let k = 0; k < n; k += 1) {
      const p = parent[k];
      if (p >= 0) { childAt[cursor[p]] = k; cursor[p] += 1; }
    }

    /* The geographic grid, for "everything within N km of here". */
    const grid = new Map();
    for (let k = 0; k < n; k += 1) {
      const key = cellKey(lat[k], lon[k]);
      let cell = grid.get(key);
      if (!cell) { cell = []; grid.set(key, cell); }
      cell.push(k);
    }

    /* A lowercase name index for the typeahead. Aliases are folded in so
       "Bangalore" finds Bengaluru, which is how people type. */
    const byName = new Map();
    const put = (key, at) => {
      if (!key) return;
      let list = byName.get(key);
      if (!list) { list = []; byName.set(key, list); }
      if (list.length < 400) list.push(at);
    };
    for (let k = 0; k < n; k += 1) {
      put(names[k].toLowerCase(), k);
      if (aliases[k]) {
        for (const a of aliases[k].split('|')) put(a.trim().toLowerCase(), k);
      }
    }

    /*
     * A PREFIX BUCKET PER THREE LETTERS.
     *
     * Measured without it: 127-152 ms per keystroke, because "contains"
     * had to look at all 556,716 names. That is fine for one lookup and
     * unusable for a typeahead, where it happens on every letter.
     *
     * Three characters is the sweet spot here - "den" holds a few
     * thousand rows rather than the tens of thousands "de" would - and
     * the fold below strips diacritics, so typing "visakhapatnam" reaches
     * "Visākhapatnam" without the user knowing there is a macron in it.
     */
    const byPrefix = new Map();
    const bucket = (key, at) => {
      if (key.length < 3) return;
      const k = key.slice(0, 3);
      let list = byPrefix.get(k);
      if (!list) { list = []; byPrefix.set(k, list); }
      list.push(at);
    };
    for (let k = 0; k < n; k += 1) {
      bucket(foldName(names[k]), k);
      if (aliases[k]) {
        for (const a of aliases[k].split('|')) bucket(foldName(a), k);
      }
    }

    const counts = { state: 0, district: 0, mandal: 0, place: 0 };
    for (let k = 0; k < n; k += 1) counts[TYPES[type[k]]] += 1;

    /* The folded name once per row, so search never folds in a loop. */
    const folded = names.map(foldName);

    idx = {
      n, ids, names, aliases, lat, lon, pop, type, parent,
      childStart, childAt, childCount, grid, byName, byPrefix, folded, counts,
    };
    return idx;
  })();

  return loading;
}

/* ------------------------------------------------------------------ *
 * shaping
 * ------------------------------------------------------------------ */

/*
 * THE COUNT A RECRUITER READS.
 *
 * Andhra Pradesh has 26 districts, and 392 places whose row in the dump
 * names no district at all - the half a percent with a gap. Reporting
 * 418 beside the state would be true and useless: the number next to a
 * state is how many districts it has, which is what the screen has
 * always shown and what somebody checks it against.
 *
 * Below the state the two are the same thing, so only a state needs the
 * distinction. `childCount` is the number shown; `totalChildren` is what
 * expanding will actually list, so nothing has to guess.
 */
function shownCount(x, at) {
  if (x.type[at] !== 0) return x.childCount[at];
  let n = 0;
  for (let c = x.childStart[at]; c < x.childStart[at + 1]; c += 1) {
    if (x.type[x.childAt[c]] === 1) n += 1;
  }
  return n;
}

function node(x, at) {
  return {
    id: x.ids[at],
    name: x.names[at],
    type: TYPES[x.type[at]],
    parentId: x.parent[at] >= 0 ? x.ids[x.parent[at]] : null,
    childCount: shownCount(x, at),
    totalChildren: x.childCount[at],
    lat: x.lat[at],
    lng: x.lon[at],
    population: x.pop[at] || undefined,
  };
}

/** "Denduluru · Mandal · Eluru · Andhra Pradesh" — the whole chain. */
function pathOf(x, at) {
  const out = [];
  let p = x.parent[at];
  let guard = 0;
  while (p >= 0 && guard < 8) { out.push(x.names[p]); p = x.parent[p]; guard += 1; }
  return out;
}

/* ------------------------------------------------------------------ *
 * the three questions
 * ------------------------------------------------------------------ */

/**
 * The children of a node, or the states when nothing is named.
 *
 * NOT CAPPED. A district with four hundred villages returns four
 * hundred; the caller decides how to draw them. Capping here would mean
 * a recruiter could not reach a village whose name begins with S.
 */
export async function treeChildren(parentId) {
  const x = await load();

  if (!parentId) {
    const states = [];
    for (let k = 0; k < x.n; k += 1) if (x.type[k] === 0) states.push(node(x, k));
    states.sort((a, b) => a.name.localeCompare(b.name));
    return { parent: null, children: states };
  }

  const at = x.ids.indexOf ? findId(x, parentId) : -1;
  if (at < 0) return { parent: null, children: [] };

  const from = x.childStart[at];
  const to = x.childStart[at + 1];
  const out = [];
  for (let k = from; k < to; k += 1) out.push(node(x, x.childAt[k]));

  /* Administrative areas first, then by name - a district's own mandal
     of the same name is what somebody expanding it is looking for. */
  out.sort((a, b) => (TYPE_ID[a.type] - TYPE_ID[b.type]) || a.name.localeCompare(b.name));
  return { parent: node(x, at), path: pathOf(x, at), children: out };
}

let idPos = null;
function findId(x, id) {
  if (!idPos) {
    idPos = new Map();
    for (let k = 0; k < x.n; k += 1) idPos.set(x.ids[k], k);
  }
  const at = idPos.get(String(id));
  return at === undefined ? -1 : at;
}

/**
 * Search every level at once.
 *
 * RANKING, as the brief sets it: exact, then prefix, then contains; and
 * within a rank the higher level first, so "Eluru" offers the district
 * before the mandal before the village. Population breaks the last tie,
 * because between two villages of the same name the larger one is the
 * one somebody meant more often.
 */
export async function treeSearch(q, { limit = 30 } = {}) {
  const x = await load();
  const term = String(q || '').trim().toLowerCase();
  if (term.length < 2) return [];

  const seen = new Set();
  const hits = [];
  const add = (at, rank) => {
    if (seen.has(at)) return;
    seen.add(at);
    hits.push({ at, rank });
  };

  const folded = foldName(term);

  /* Exact, straight off the map - both as written and as folded. */
  for (const at of x.byName.get(term) || []) add(at, 0);
  for (const at of x.byPrefix.get(folded.slice(0, 3)) || []) {
    if (x.folded[at] === folded) add(at, 0);
  }

  /*
   * Prefix, out of the three-letter bucket rather than a scan. A term
   * shorter than three characters has no bucket, and the list is short
   * enough then that the scan below is cheap.
   */
  if (folded.length >= 3) {
    for (const at of x.byPrefix.get(folded.slice(0, 3)) || []) {
      if (x.folded[at].startsWith(folded)) add(at, 1);
    }
  }

  /*
   * Contains is the one that still costs a scan, so it runs only when
   * the better ranks have not already filled the list, and stops as soon
   * as it has enough.
   */
  const WANT = limit * 4;
  if (hits.length < WANT) {
    let cont = 0;
    for (let k = 0; k < x.n && cont < WANT; k += 1) {
      if (x.folded[k].includes(folded) && !seen.has(k)) { add(k, 2); cont += 1; }
    }
  }

  hits.sort((a, b) =>
    (a.rank - b.rank)
    || (x.type[a.at] - x.type[b.at])
    || (x.pop[b.at] - x.pop[a.at])
    || x.names[a.at].localeCompare(x.names[b.at]));

  return hits.slice(0, limit).map(({ at }) => {
    const out = node(x, at);
    out.path = pathOf(x, at);
    /* "Denduluru · Mandal · Eluru · Andhra Pradesh" */
    out.label = [out.name, out.type[0].toUpperCase() + out.type.slice(1), ...out.path].join(' · ');
    return out;
  });
}

/**
 * Every name under a node, for matching candidates.
 *
 * A recruiter ticking a district means the people in its villages, and
 * the candidates table stores a free-text location, not a place id - so
 * what the query needs is the set of names to match against.
 *
 * BOUNDED, because a state has thirty thousand villages under it and no
 * SQL query wants that list. A state or a district is matched by its own
 * name and its children's; only a mandal is expanded all the way down,
 * where the count is tens rather than thousands.
 */
export async function treeDescendantNames(id, { max = 4000 } = {}) {
  const x = await load();
  const at = findId(x, id);
  if (at < 0) return [];

  const out = [];
  const push = (k) => { if (out.length < max) out.push(x.names[k]); };
  push(at);

  const walk = (k, depth) => {
    if (depth < 0 || out.length >= max) return;
    for (let c = x.childStart[k]; c < x.childStart[k + 1]; c += 1) {
      const child = x.childAt[c];
      push(child);
      walk(child, depth - 1);
    }
  };

  /* A state: its districts and their mandals, not every village.
     A district: its mandals and their villages.
     A mandal: its villages. */
  const depth = x.type[at] === 0 ? 1 : x.type[at] === 1 ? 1 : 0;
  walk(at, depth);

  return [...new Set(out)];
}

function haversine(aLat, aLon, bLat, bLon) {
  const dLat = rad(bLat - aLat);
  const dLon = rad(bLon - aLon);
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.sqrt(s));
}

/**
 * Everything within N kilometres of a node, at every level.
 *
 * Works from a state, a district, a mandal or a village - whichever the
 * recruiter ticked - because they all carry coordinates.
 */
export async function treeNear(id, km, { limit = 4000 } = {}) {
  const x = await load();
  const at = findId(x, id);
  if (at < 0) return { centre: null, within: [], nearest: null };

  const cLat = x.lat[at];
  const cLon = x.lon[at];
  const reach = Math.max(1, Number(km) || 25);

  const span = Math.ceil(reach / 55) + 1;
  const bLat = Math.floor(cLat / CELL);
  const bLon = Math.floor(cLon / CELL);

  const within = [];
  let nearest = null;

  for (let a = bLat - span; a <= bLat + span; a += 1) {
    for (let b = bLon - span; b <= bLon + span; b += 1) {
      const cell = x.grid.get(`${a}:${b}`);
      if (!cell) continue;
      for (const k of cell) {
        if (k === at) continue;
        const d = haversine(cLat, cLon, x.lat[k], x.lon[k]);
        if (!nearest || d < nearest.km) nearest = { ...node(x, k), km: Number(d.toFixed(1)) };
        if (d <= reach && within.length < limit) {
          const nd = node(x, k);
          nd.km = Number(d.toFixed(1));
          nd.path = pathOf(x, k);
          within.push(nd);
        }
      }
    }
  }

  within.sort((p, q) => p.km - q.km);
  return { centre: node(x, at), within, nearest };
}

/** Warm the index without asking it anything. */
export async function treeWarm() { await load(); return treeStatus(); }
