/**
 * Every populated place in India, and what is near a point.
 *
 * WHY THIS IS ON THE SERVER. The location filter measured distances
 * against window.INDIA_COORDS, a hand-maintained list of 1,244 places -
 * district headquarters, the big cities, and the localities of two or
 * three metros. Ticking Chittoor and asking for everything within 25 km
 * returned one row, Chittoor itself, because the villages around it were
 * not in the file. The real figure is 549,026 places for India, villages
 * included, and twenty-one megabytes is not something to send to a
 * browser so it can filter it down to forty rows.
 *
 * So the index lives here and answers one question: what is within N
 * kilometres of this point. The client asks once per place a recruiter
 * ticks, caches the answer, and filters it locally as they move the
 * radius - which is why changing 25 KM to 50 KM stays instant and makes
 * no request at all.
 *
 * LOADED ONCE, LAZILY. Nothing reads the file until the first query, so
 * a deployment that never opens the location filter never pays for it.
 * After that it is resident: ~549k records in typed arrays plus their
 * names, which measures around 60 MB.
 *
 * THE INDEX IS A GRID, not a tree. Half a degree a cell, which is about
 * 55 km, so the widest radius the UI offers touches nine cells. A k-d
 * tree would be faster in theory and slower here: the whole point is to
 * avoid scanning half a million rows, and nine cells of a few thousand
 * does that with thirty lines instead of three hundred.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';

const FILE = process.env.PLACES_FILE
  || path.join(process.cwd(), 'var', 'places', 'india-places.tsv');

const CELL = 0.5;                       // degrees; ~55 km
const EARTH_KM = 6371;
const rad = (d) => (d * Math.PI) / 180;

let state = null;                       // { names, lats, lons, states, pops, grid }
let loading = null;

export function placesAvailable() {
  return existsSync(FILE);
}

export function placesStatus() {
  if (!existsSync(FILE)) {
    return { ready: false, reason: 'no place index on disk', file: FILE };
  }
  return {
    ready: !!state,
    loading: !!loading && !state,
    file: FILE,
    sizeMb: Math.round((statSync(FILE).size / 1024 / 1024) * 10) / 10,
    places: state ? state.names.length : null,
  };
}

const cellKey = (lat, lon) => `${Math.floor(lat / CELL)}:${Math.floor(lon / CELL)}`;

async function load() {
  if (state) return state;
  if (loading) return loading;

  loading = (async () => {
    if (!existsSync(FILE)) throw new Error(`place index not found at ${FILE}`);

    const names = [];
    const statesArr = [];
    const latsArr = [];
    const lonsArr = [];
    const popsArr = [];
    const kindsArr = [];
    /* name -> index, for every spelling an administrative area answers
       to. Built while the file is read so the lookup is a map hit rather
       than a scan of half a million rows. */
    const byName = new Map();
    /* The same index again, on consonant skeletons, for the last-resort
       lookup. Administrative areas only: two villages sharing a skeleton
       is common and meaningless, two districts sharing one is not. */
    const bySkel = new Map();
    const grid = new Map();

    const rl = createInterface({ input: createReadStream(FILE, { encoding: 'utf8' }) });
    let i = 0;
    for await (const line of rl) {
      if (!line) continue;
      const t1 = line.indexOf('\t');
      const t2 = line.indexOf('\t', t1 + 1);
      const t3 = line.indexOf('\t', t2 + 1);
      const t4 = line.indexOf('\t', t3 + 1);
      if (t1 < 0 || t2 < 0 || t3 < 0) continue;

      const lat = Number(line.slice(t1 + 1, t2));
      const lon = Number(line.slice(t2 + 1, t3));
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

      const t5 = t4 < 0 ? -1 : line.indexOf('\t', t4 + 1);

      names.push(line.slice(0, t1));
      latsArr.push(lat);
      lonsArr.push(lon);
      statesArr.push(t4 < 0 ? line.slice(t3 + 1) : line.slice(t3 + 1, t4));
      popsArr.push(t4 < 0 ? 0 : Number(line.slice(t4 + 1, t5 < 0 ? undefined : t5)) || 0);
      /* 'P' for a village or town, ADM1/ADM2/ADM3 for a state, district
         or mandal. Asked for a district by name, the district must win
         over a hamlet that happens to share it. */
      const t6 = t5 < 0 ? -1 : line.indexOf('\t', t5 + 1);
      const kind = t5 < 0 ? 'P'
        : (t6 < 0 ? line.slice(t5 + 1) : line.slice(t5 + 1, t6)).trim() || 'P';
      kindsArr.push(kind);

      /* Indexed under its own name, and - for a district or mandal -
         under every spelling GeoNames lists for it, so "Bellary" finds
         Ballari and "Mehsana" finds Mahesana without an alias table
         written from memory. */
      const put = (nm) => {
        const k = fold(nm);
        if (!k) return;
        const have = byName.get(k);
        if (have === undefined) byName.set(k, [i]);
        else have.push(i);
        if (kind !== 'P') {
          const sk = skeleton(nm);
          if (sk.length >= 4) {
            const h2 = bySkel.get(sk);
            if (h2 === undefined) bySkel.set(sk, [i]);
            else h2.push(i);
          }
        }
      };
      put(names[names.length - 1]);
      if (kind !== 'P' && t6 >= 0) {
        for (const a of line.slice(t6 + 1).split('|')) put(a);
      }

      const k = cellKey(lat, lon);
      let bucket = grid.get(k);
      if (!bucket) { bucket = []; grid.set(k, bucket); }
      bucket.push(i);
      i++;
    }

    state = {
      names,
      states: statesArr,
      kinds: kindsArr,
      byName,
      bySkel,
      lats: Float64Array.from(latsArr),
      lons: Float64Array.from(lonsArr),
      pops: Int32Array.from(popsArr),
      grid,
    };
    console.log(`[places] ${names.length.toLocaleString()} places indexed from ${FILE}`);
    return state;
  })();

  try { return await loading; } finally { loading = null; }
}

/** Great-circle distance in kilometres. */
function haversine(aLat, aLon, bLat, bLon) {
  const dLa = rad(bLat - aLat);
  const dLo = rad(bLon - aLon);
  const s = Math.sin(dLa / 2) ** 2
    + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLo / 2) ** 2;
  return EARTH_KM * 2 * Math.asin(Math.sqrt(s));
}

/**
 * Everything within `km` of a point, nearest first.
 *
 * @param limit  a ceiling on the RESPONSE, not on the search. A hundred
 *               kilometres around Hyderabad is ten thousand villages and
 *               nobody scrolls that, so the nearest are returned and
 *               `truncated` says plainly that there were more. The count
 *               is always the true total.
 */
export async function placesNear(lat, lon, km, { limit = 4000 } = {}) {
  const s = await load();

  /* The cells a circle of this radius can reach. One degree of latitude
     is ~111 km; longitude shrinks with the cosine, so the span is widened
     accordingly rather than assuming a square. */
  const dLat = km / 111;
  const dLon = km / Math.max(1, 111 * Math.cos(rad(lat)));
  const loLat = Math.floor((lat - dLat) / CELL);
  const hiLat = Math.floor((lat + dLat) / CELL);
  const loLon = Math.floor((lon - dLon) / CELL);
  const hiLon = Math.floor((lon + dLon) / CELL);

  const hits = [];
  for (let a = loLat; a <= hiLat; a++) {
    for (let b = loLon; b <= hiLon; b++) {
      const bucket = s.grid.get(`${a}:${b}`);
      if (!bucket) continue;
      for (const idx of bucket) {
        const d = haversine(lat, lon, s.lats[idx], s.lons[idx]);
        if (d <= km) hits.push({ i: idx, km: d });
      }
    }
  }

  hits.sort((x, y) => x.km - y.km);
  const total = hits.length;
  const out = hits.slice(0, limit).map((h) => ({
    name: s.names[h.i],
    state: s.states[h.i],
    km: Math.round(h.km * 10) / 10,
    population: s.pops[h.i] || undefined,
    /* 'ADM2' district, 'ADM3' mandal or taluk, 'P' a town or village.
       The panel groups on this: a recruiter ticking a district wants the
       mandals around it first, and the four hundred hamlets after. */
    kind: s.kinds[h.i] || 'P',
  }));
  return { total, truncated: total > out.length, places: out };
}

/** Find a place by name, so the client can anchor on one it only knows by name. */
/**
 * Fold a place name to something two spellings of it can agree on.
 *
 * GeoNames transliterates with macrons - "East Godāvari", "Rājahmundry",
 * "Vemulūru" - and the portal's own district list does not. Compared as
 * written, "East Godavari" matched nothing at all, which is why it
 * reported no coordinates for a district of five million people.
 *
 * NFD splits a letter from its accent; the range strips the accents and
 * leaves the letter.
 */
const fold = (v) => String(v || '')
  .normalize('NFD')
  .replace(/[̀-ͯ]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

/**
 * A name reduced to its consonants.
 *
 * Indian place names reach a gazetteer through transliteration, and the
 * vowels are where transliterations disagree:
 *
 *   Hanumakonda / Hanamkonda        a district, spelled two ways
 *   Vijayanagara / Vijayanagar      a trailing vowel
 *   Leparada / Lepa Rada            a space
 *   Komaram Bheem / Kumuram Bheem   o for u, and a suffix
 *
 * Every one of those pairs is the same place, and every one failed an
 * exact match. Dropping the vowels and the spaces leaves a skeleton the
 * two spellings agree on - hnmknd, vjyngr, lprd - which is the standard
 * way of handling this and is a rule rather than a list of pairs somebody
 * has to keep adding to.
 *
 * Used only after an exact match has failed, so it can never override a
 * name that matched properly.
 */
const skeleton = (v) => fold(v)
  .replace(/[aeiou]/g, '')
  .replace(/\s+/g, '');

export async function placeByName(name, hintState) {
  const s = await load();
  const want = fold(name);
  if (!want) return null;
  const hint = fold(hintState);

  /*
   * WHICH "CHITTOOR" DID THEY MEAN.
   *
   * The same name occurs as a district, as the town inside it, and as a
   * dozen hamlets elsewhere. The panel asks by the name it shows on a
   * district checkbox, so an ADMINISTRATIVE match is what it wants:
   * measuring from the district's centre is the question "what is near
   * this district", and measuring from a same-named hamlet in another
   * state is not.
   *
   * Order: the state the caller named, then a district or mandal, then
   * the most populous ordinary place. Before this the lookup knew only
   * about populated places, so a district with no town of its name -
   * East Godavari, Anjaw, and 688 others - resolved to nothing at all.
   */
  /*
   * WHICH POINT IS "NELLORE"?
   *
   * The gazetteer holds two: the town at 14.45, 79.99 where half a
   * million people live, and the DISTRICT's centroid at 14.75, 79.71.
   * They are 44.7 km apart, and picking the wrong one moves a 50 km
   * circle far enough to lose Gudur, Muthukur, Venkatachelam and
   * Indukurpet - every one of which a recruiter expects to see, and
   * every one of which the reference product shows.
   *
   * A recruiter who ticks a district name means the place people live
   * in. Where a district and a town share a name it is because the town
   * is the district's headquarters, so a REAL TOWN beats the centroid.
   *
   * The centroid still wins where there is no town of that name - East
   * Godavari, Anjaw, and the other administrative areas that are not
   * also settlements - which is what stopped 690 districts being
   * unlocatable in the first place.
   *
   * The threshold keeps a hamlet of two hundred people from outranking
   * a district's centre on a name they happen to share.
   */
  const TOWN_ENOUGH = 20000;
  const RANK = { ADM2: 4, ADM3: 3, ADM1: 2, P: 1 };
  const rankOf = (kind, pop) => (kind === 'P' && pop >= TOWN_ENOUGH ? 5 : (RANK[kind] || 1));

  let best = null;
  let bestScore = -1;
  /* The candidates for this spelling, rather than every row in India. */
  for (const i of (s.byName.get(want) || [])) {
    const kind = s.kinds[i] || 'P';
    const row = {
      name: s.names[i], state: s.states[i], kind,
      lat: s.lats[i], lon: s.lons[i], pop: s.pops[i],
    };
    const score = rankOf(kind, row.pop) * 1e12
      + (hint && fold(row.state) === hint ? 1e11 : 0)
      + Math.min(row.pop, 1e10);
    if (score > bestScore) { bestScore = score; best = row; }
  }
  if (best) return best;

  /*
   * NOTHING MATCHED EXACTLY. A district may have been renamed or split
   * since the gazetteer was cut - the portal offers "Dibang Valley" and
   * GeoNames carries "Lower Dibang Valley" - so an administrative area
   * whose name CONTAINS the whole phrase is tried before giving up.
   *
   * Administrative areas only, and whole words only: a hamlet called
   * "Anjaw Bazar" must not answer for the district of Anjaw, and a
   * substring match on villages would find something for almost any
   * input, which is worse than finding nothing.
   */
  const phrase = new RegExp(`(^| )${want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`);
  for (let i = 0; i < s.names.length; i++) {
    const kind = s.kinds[i] || 'P';
    if (kind === 'P') continue;
    if (!phrase.test(fold(s.names[i]))) continue;
    if (hint && fold(s.states[i]) !== hint) continue;
    return {
      name: s.names[i], state: s.states[i], kind,
      lat: s.lats[i], lon: s.lons[i], pop: s.pops[i], approx: true,
    };
  }

  /*
   * STILL NOTHING. India renames and subdivides districts faster than a
   * gazetteer is cut, and the new name is usually the old one with
   * something attached: YSR Kadapa, Jayashankar Bhupalpally, Devbhoomi
   * Dwarka, Shaheed Bhagat Singh Nagar. The gazetteer has Kadapa,
   * Bhupalpally and Dwarka.
   *
   * So each word of the name is tried on its own, longest first. This is
   * derived from the name the recruiter is looking at rather than from a
   * table of pairs written from memory, which is the difference between
   * a rule and a patch.
   *
   * Fenced in three ways, because a loose match here would put a
   * district's centre in the wrong state: words of four letters or more,
   * the same state as the district, and an administrative area preferred
   * over a village that shares the word. Marked `approx` so the caller
   * knows it is a near-enough answer.
   */
  /*
   * THE SKELETON, before falling back to single words. Exact on the
   * skeleton first - Hanumakonda finds Hanamkonda - then a skeleton that
   * STARTS WITH the one asked for, which is how "Komaram Bheem" finds
   * "Kumuram Bheem Asifabad" without matching anything shorter.
   */
  const skel = skeleton(name);
  if (skel.length >= 4) {
    for (const i of (s.bySkel.get(skel) || [])) {
      if (hint && fold(s.states[i]) !== hint) continue;
      return {
        name: s.names[i], state: s.states[i], kind: s.kinds[i] || 'P',
        lat: s.lats[i], lon: s.lons[i], pop: s.pops[i], approx: true, matchedOn: 'spelling',
      };
    }
    for (const [sk, list] of s.bySkel) {
      if (!sk.startsWith(skel)) continue;
      for (const i of list) {
        if (hint && fold(s.states[i]) !== hint) continue;
        return {
          name: s.names[i], state: s.states[i], kind: s.kinds[i] || 'P',
          lat: s.lats[i], lon: s.lons[i], pop: s.pops[i], approx: true, matchedOn: 'spelling',
        };
      }
    }
  }

  const words = want.split(' ').filter((w) => w.length >= 4).sort((a, b) => b.length - a.length);
  for (const w of words) {
    let pick = null;
    let pickScore = -1;
    for (const i of (s.byName.get(w) || [])) {
      if (hint && fold(s.states[i]) !== hint) continue;
      const kind = s.kinds[i] || 'P';
      const score = rankOf(kind, s.pops[i]) * 1e12 + Math.min(s.pops[i], 1e10);
      if (score > pickScore) {
        pickScore = score;
        pick = {
          name: s.names[i], state: s.states[i], kind,
          lat: s.lats[i], lon: s.lons[i], pop: s.pops[i], approx: true, matchedOn: w,
        };
      }
    }
    if (pick) return pick;
  }

  return null;
}
