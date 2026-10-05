/**
 * A spoken place, matched by how it sounds.
 *
 * "నెల్లూరు", "nellooru" and "Nellore" are one town; "हैदराबाद" and
 * "Hyderabad", "విజయవాడ" and "Vijayawada", "vishaakhapatnam" and
 * "Visakhapatnam" too. The rules engine used to find a place only when
 * the words were spelt exactly as the index spells them - in Latin
 * letters - so a Telugu or Hindi speaker lost the place unless the AI
 * engine was configured.
 *
 * HOW. Native script is transliterated (indic-translit.js), then every
 * name is reduced to a sound key ("nelur") and its consonant skeleton
 * ("nlr"). A spoken name matches an index name only when
 *
 *   - the skeletons are IDENTICAL (every consonant, in order), and
 *   - the vowels differ by little (vowelDistance; a different first
 *     letter costs more), and the shorter the name, the closer, and
 *   - the index row is a state, a district, or a city: a town of
 *     100,000 people or more (or a town on the live job board). A mandal
 *     or a village is never reached by sound - an ordinary word too often
 *     sounds like one. Those still match when spelt exactly (the route's
 *     exact lookup runs first).
 *
 * NEVER INVENTED. The answer is always a name the index (or the live
 * board) already holds; no match is null. Known renames and nicknames
 * (Vizag, Bezawada, Bombay, दिल्ली ...) are listed in voice-words.js and
 * are used only when the name they point at is in the index. Ordinary
 * words that sound like a city (కొత్త "new" ~ Kota, चिन्न ~ Chennai, फोन
 * ~ Pune) are listed there too and are never places.
 */
import { transliterate, hasIndicScript, placeKey, skeleton, vowelDistance } from './indic-translit.js';
import { PLACE_VARIANTS, NOT_PLACES } from './voice-words.js';

const TYPE_RANK = { state: 0, district: 1, mandal: 2, place: 3 };

/** A town has to be this big to be matched by sound (exact spellings reach any size). */
export const SOUND_MIN_POPULATION = 100000;

/** Case endings a Telugu speaker joins to the name: "నెల్లూరులో" = "in Nellore". */
const JOINED_SUFFIXES = ['nunchi', 'nundi', 'daggara', 'loni', 'lone', 'lo', 'ki', 'ku', 'ni', 'nu'];
/* Telugu ends many town names in -am (అనంతపురం, విజయనగరం) that English drops. */
const TELUGU_ENDINGS = ['am'];

const push = (map, k, v) => { const l = map.get(k); if (l) l.push(v); else map.set(k, [v]); };

/* "Visākhapatnam" -> "Visakhapatnam": the index's own name, macrons off,
   which is how a job's location is written. */
const plain = (v) => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').normalize('NFC');

/**
 * @param rows   [{ name, type: state|district|mandal|place, population, aliases[] }]
 * @param source 'board' (towns on the live job board) or 'tree' (the place index)
 */
export function buildSoundIndex(rows, { source = 'tree' } = {}) {
  const bySkel = new Map();
  const byKey = new Map();
  const seen = new Set();
  let size = 0;

  /* display: the name answered - the base name for "Lucknow District" and its aliases */
  function addRow(r, display = r.name) {
    const names = [[r.name, true], ...(r.aliases || []).map((a) => [a, false])];
    for (const [raw, isOwn] of names) {
      const a = String(raw || '').trim();
      /* codes ("NEL", "AP") and anything with digits are not names */
      if (!a || /\d/.test(a) || /^[A-Z]{1,4}$/.test(a) || !/[a-z]/i.test(a)) continue;
      const key = placeKey(a);
      if (key.length < 3) continue;
      const sk = skeleton(key);
      if (sk.length < 2) continue;
      const dedupe = `${key}\u0000${display}\u0000${r.type}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      const e = { key, skel: sk, name: plain(display), type: r.type || 'place',
        population: Number(r.population) || 0, source, own: isOwn };
      push(bySkel, sk, e);
      push(byKey, key, e);
      size += 1;
    }
  }

  for (const row of rows || []) {
    const type = row.type || 'place';
    /* "Rajahmundry Urban" (a mandal) is the city of Rajahmundry; "Warangal
       Rural", "Pune Division", "Lucknow District" are named after theirs.
       The base name is the one people say. */
    const base = /^(.+?)\s+(urban|rural|district|division|city|\(urban\)|\(rural\))$/i.exec(String(row.name || ''));
    if (base && (type === 'district' || (type === 'mandal' && /urban/i.test(base[2])))) {
      addRow({ ...row, name: base[1], type, aliases: [] });
    }
    if (source === 'tree') {
      if (type === 'mandal') continue;
      if (type === 'place' && (Number(row.population) || 0) < SOUND_MIN_POPULATION) continue;
    }
    addRow(row, base && type === 'district' ? base[1] : row.name);
  }
  return { bySkel, byKey, size, source };
}

/** How far apart two keys may be. */
function tolerance(spoken, e) {
  const len = Math.min(spoken.length, e.key.length);
  /* "dl", "pn", "cn": two consonants say little - only exact. */
  if (e.skel.length <= 2) return e.source === 'board' || e.type === 'state' || e.type === 'district' || e.population >= 300000 ? 0 : -1;
  if (len <= 4) return 0;
  /* another language's name for the place (the index's aliases): close only */
  if (!e.own) return 0.5;
  if (len <= 8) return 1;
  return 1.5;
}

/**
 * The sound keys a spoken name could stand for: as heard, with ड़ as d
 * as well as r, and with a joined Telugu case ending taken off.
 */
export function spokenKeys(text) {
  const native = hasIndicScript(text);
  const spellings = native
    ? [...new Set([transliterate(text), transliterate(text, { flap: 'd' })])]
    : [String(text || '')];
  const keys = [];
  /* cost: a key that needed an ending taken off is a weaker reading than the word as said */
  const add = (k, cost = 0) => { if (k && k.length >= 3 && !keys.some((x) => x.k === k)) keys.push({ k, cost }); };
  spellings.forEach((latin, n) => {
    /* n = 1: ड़ read as d - the second reading */
    const base = n === 0 ? 0 : 0.25;
    add(placeKey(latin), base);
    if (native) {
      const word = latin.trim().toLowerCase();
      const stems = [word];
      for (const suf of JOINED_SUFFIXES) {
        if (word.endsWith(suf) && word.length - suf.length >= 4) stems.push(word.slice(0, -suf.length));
      }
      for (const stem of stems) {
        add(placeKey(stem), base + (stem === word ? 0 : 0.25));
        for (const end of TELUGU_ENDINGS) {
          if (stem.endsWith(end) && stem.length - end.length >= 5) add(placeKey(stem.slice(0, -end.length)), base + (stem === word ? 0.75 : 1));
        }
      }
    }
  });
  return { latin: spellings[0].trim(), keys, native };
}

let variantKeys = null;
let notPlaceKeys = null;
function lists() {
  if (variantKeys) return;
  const keyOf = (v) => placeKey(hasIndicScript(v) ? transliterate(v) : v);
  variantKeys = new Map();
  for (const [target, spoken] of Object.entries(PLACE_VARIANTS)) {
    for (const v of spoken) {
      const k = keyOf(v);
      if (k.length >= 2 && !variantKeys.has(k)) variantKeys.set(k, target);
    }
  }
  notPlaceKeys = new Set(NOT_PLACES.map((w) => String(w).normalize('NFC').toLowerCase()));
  /* the variants as written too: "Hyd" is too short to have a sound key */
  variantRaw = new Map();
  for (const [target, spoken] of Object.entries(PLACE_VARIANTS)) {
    for (const v of spoken) variantRaw.set(String(v).normalize('NFC').toLowerCase(), target);
  }
}
let variantRaw = null;

const rank = (a, b) => ((a.source === 'board' ? 0 : 1) - (b.source === 'board' ? 0 : 1))
  || ((a.own ? 0 : 1) - (b.own ? 0 : 1))
  || ((TYPE_RANK[a.type] ?? 3) - (TYPE_RANK[b.type] ?? 3))
  || (b.population - a.population);

/**
 * @param text     what was said: one to three words, any script
 * @param indexes  sound indexes to search (the live board's, the place index's)
 * @returns { name, type, distance, via: 'variant'|'sound', heard } or null
 */
export function soundMatch(text, indexes) {
  const list = (indexes || []).filter(Boolean);
  if (!list.length) return null;
  lists();
  const said = String(text || '').normalize('NFC').toLowerCase().trim();
  if (!said || notPlaceKeys.has(said)) return null;
  /* A Latin word is only matched loosely when it is spelt the way an
     Indian name is romanised ("nellooru", "haidaraabaad"); an English
     word ("manager", "good") is matched exactly or not at all. */
  const { latin, keys, native } = spokenKeys(text);
  const loose = native || /aa|ee|ii|oo|uu/.test(said);
  /* a variant exactly as written ("Hyd", "Hyderbad") */
  const exact = variantRaw.get(said);
  if (exact) {
    const tk = placeKey(exact);
    const hits = list.flatMap((ix) => (ix.byKey.get(tk) || []).filter((e) => e.own));
    if (hits.length) {
      const e = hits.sort(rank)[0];
      return { name: e.name, type: e.type, distance: 0, via: 'variant', heard: latin };
    }
  }
  if (!keys.length) return null;

  /* A known rename, resolved through the index - never on its own word. */
  for (const { k } of keys) {
    const target = variantKeys.get(k);
    if (!target) continue;
    const tk = placeKey(target);
    const hits = list.flatMap((ix) => (ix.byKey.get(tk) || []).filter((e) => e.own));
    if (hits.length) {
      const e = hits.sort(rank)[0];
      return { name: e.name, type: e.type, distance: 0, via: 'variant', heard: latin };
    }
  }

  const found = [];
  for (const { k, cost } of keys) {
    const sk = skeleton(k);
    if (sk.length < 2) continue;
    for (const ix of list) {
      for (const e of ix.bySkel.get(sk) || []) {
        let d = cost + (k === e.key ? 0 : vowelDistance(k, e.key));
        if (k[0] !== e.key[0]) d += 0.5;                 // Ongole is not Angul
        if (d > 0 && !loose) continue;                   // cost is 0 for a Latin word
        if (d <= tolerance(k, e)) found.push({ e, d });
      }
    }
  }
  if (!found.length) return null;
  found.sort((a, b) => (a.d - b.d) || rank(a.e, b.e));
  const { e, d } = found[0];
  return { name: e.name, type: e.type, distance: d, via: 'sound', heard: latin };
}
