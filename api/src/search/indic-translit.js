/**
 * Telugu and Devanagari script -> Latin letters, and a sound key for
 * matching a spoken place name against the place index.
 *
 * WHY. With the language set to te-IN or hi-IN the browser writes what it
 * heard in the native script: "నెల్లూరు లో డ్రైవర్ జాబ్", "हैदराबाद में
 * टेलीकॉलर". The place index is in English spelling, so without the AI
 * engine the place was lost. This is deterministic - no model, no network:
 *
 *   transliterate()   "నెల్లూరు" -> "nelluuru",  "हैदराबाद" -> "haidaraabaad"
 *   placeKey()        a spelling-tolerant key: "nelluuru", "nellooru" and
 *                     "Nellore" all become "nelur" / "nelor"
 *   skeleton()        the key's consonants only: "nlr"
 *   vowelDistance()   how far two keys with the same skeleton are apart
 *
 * The scheme is the usual one for Indic scripts: a consonant carries an
 * inherent "a" unless a vowel sign replaces it or a virama (్ / ्) kills
 * it; independent vowels stand alone; anusvara (ం / ं) is "m" before
 * p/b/m and at the end of a Telugu word, otherwise "n"; nukta (़) turns
 * ज into z, फ into f, ड into r. Hindi drops the inherent "a" at the end of
 * a word (हैदराबाद is "haidaraabaad", not "haidaraabaada"); Telugu words
 * end in a vowel anyway.
 */

/* ------------------------------------------------------------------ *
 * the two scripts
 * ------------------------------------------------------------------ */

const TE = {
  base: 0x0c00,
  vowels: {
    0x05: 'a', 0x06: 'aa', 0x07: 'i', 0x08: 'ii', 0x09: 'u', 0x0a: 'uu', 0x0b: 'ru', 0x0c: 'lu',
    0x0e: 'e', 0x0f: 'e', 0x10: 'ai', 0x12: 'o', 0x13: 'o', 0x14: 'au', 0x60: 'ruu', 0x61: 'luu',
  },
  consonants: {
    0x15: 'k', 0x16: 'kh', 0x17: 'g', 0x18: 'gh', 0x19: 'ng',
    0x1a: 'ch', 0x1b: 'chh', 0x1c: 'j', 0x1d: 'jh', 0x1e: 'ny',
    0x1f: 't', 0x20: 'th', 0x21: 'd', 0x22: 'dh', 0x23: 'n',
    0x24: 't', 0x25: 'th', 0x26: 'd', 0x27: 'dh', 0x28: 'n', 0x29: 'n',
    0x2a: 'p', 0x2b: 'ph', 0x2c: 'b', 0x2d: 'bh', 0x2e: 'm',
    0x2f: 'y', 0x30: 'r', 0x31: 'r', 0x32: 'l', 0x33: 'l', 0x34: 'l', 0x35: 'v',
    0x36: 'sh', 0x37: 'sh', 0x38: 's', 0x39: 'h', 0x58: 'ts', 0x59: 'dz', 0x5a: 'r',
  },
  signs: {
    0x3e: 'aa', 0x3f: 'i', 0x40: 'ii', 0x41: 'u', 0x42: 'uu', 0x43: 'ru', 0x44: 'ruu',
    0x46: 'e', 0x47: 'e', 0x48: 'ai', 0x4a: 'o', 0x4b: 'o', 0x4c: 'au', 0x62: 'lu', 0x63: 'luu',
  },
  virama: 0x4d, anusvara: 0x02, visarga: 0x03, candrabindu: 0x01, nukta: 0x3c,
  digits: 0x66, finalSchwa: false, finalAnusvara: 'm',
};

const HI = {
  base: 0x0900,
  vowels: {
    0x04: 'a', 0x05: 'a', 0x06: 'aa', 0x07: 'i', 0x08: 'ii', 0x09: 'u', 0x0a: 'uu', 0x0b: 'ri', 0x0c: 'li',
    0x0d: 'e', 0x0e: 'e', 0x0f: 'e', 0x10: 'ai', 0x11: 'o', 0x12: 'o', 0x13: 'o', 0x14: 'au',
    0x60: 'rii', 0x61: 'lii', 0x72: 'a', 0x73: 'o', 0x74: 'au', 0x75: 'aa', 0x76: 'ue', 0x77: 'uue',
  },
  consonants: {
    0x15: 'k', 0x16: 'kh', 0x17: 'g', 0x18: 'gh', 0x19: 'ng',
    0x1a: 'ch', 0x1b: 'chh', 0x1c: 'j', 0x1d: 'jh', 0x1e: 'ny',
    0x1f: 't', 0x20: 'th', 0x21: 'd', 0x22: 'dh', 0x23: 'n',
    0x24: 't', 0x25: 'th', 0x26: 'd', 0x27: 'dh', 0x28: 'n', 0x29: 'n',
    0x2a: 'p', 0x2b: 'ph', 0x2c: 'b', 0x2d: 'bh', 0x2e: 'm',
    0x2f: 'y', 0x30: 'r', 0x31: 'r', 0x32: 'l', 0x33: 'l', 0x34: 'l', 0x35: 'v',
    0x36: 'sh', 0x37: 'sh', 0x38: 's', 0x39: 'h',
    // precomposed nukta letters (NFC keeps them decomposed, but be safe)
    0x58: 'q', 0x59: 'kh', 0x5a: 'g', 0x5b: 'z', 0x5c: 'r', 0x5d: 'rh', 0x5e: 'f', 0x5f: 'y',
  },
  signs: {
    0x3e: 'aa', 0x3f: 'i', 0x40: 'ii', 0x41: 'u', 0x42: 'uu', 0x43: 'ri', 0x44: 'rii',
    0x45: 'e', 0x46: 'e', 0x47: 'e', 0x48: 'ai', 0x49: 'o', 0x4a: 'o', 0x4b: 'o', 0x4c: 'au',
    0x4e: 'e', 0x4f: 'aw', 0x55: 'e', 0x56: 'ue', 0x57: 'uue', 0x62: 'li', 0x63: 'lii',
  },
  virama: 0x4d, anusvara: 0x02, visarga: 0x03, candrabindu: 0x01, nukta: 0x3c,
  digits: 0x66, finalSchwa: true, finalAnusvara: 'n',
};

/** A consonant with a nukta under it. */
const NUKTA = { k: 'q', kh: 'kh', g: 'g', j: 'z', d: 'r', dh: 'rh', ph: 'f', y: 'y' };

const scriptOf = (cp) => {
  if (cp >= 0x0c00 && cp <= 0x0c7f) return TE;
  if (cp >= 0x0900 && cp <= 0x097f) return HI;
  return null;
};

/** Does the text contain Telugu or Devanagari letters? */
export function hasIndicScript(text) {
  return /[ऀ-ॿఀ-౿]/.test(String(text || ''));
}

/* m before p/b/m - and before n in Telugu spelling: కరీంనగర్ is Karimnagar. */
const LABIAL = /^[pbmn]/;
const FLAP = '\u0001';        // ड़ / ढ़ until we know how the caller wants it spelt

/**
 * One word (or a whole sentence) of Telugu / Devanagari to plain Latin.
 * Anything else (Latin letters, digits, spaces) passes through unchanged.
 *
 * @param opts.flap  how ड़ / ढ़ are written: 'r' (default - गुड़गांव is
 *                   Gurgaon) or 'd' (विजयवाड़ा is Vijayawada). The place
 *                   matcher tries both.
 */
export function transliterate(text, opts = {}) {
  const flap = opts.flap === 'd' ? 'd' : 'r';
  const cps = Array.from(String(text || '').normalize('NFC')).map((ch) => ch.codePointAt(0));
  const words = [];           // [{ pieces, script }] and plain strings between them
  let word = null;
  let pending = null;         // a consonant still waiting for its vowel

  const flush = (vowel) => {
    if (pending == null) return;
    word.pieces.push({ kind: 'C', c: pending, v: vowel, inherent: vowel === 'a' });
    pending = null;
  };
  const endWord = () => {
    if (!word) return;
    flush('a');
    words.push(word);
    word = null;
  };

  for (let i = 0; i < cps.length; i += 1) {
    const cp = cps[i];
    if (cp === 0x200c || cp === 0x200d) continue;      // zero-width (non-)joiner: inside a word
    const sc = scriptOf(cp);
    if (!sc) {
      endWord();
      words.push(String.fromCodePoint(cp));
      continue;
    }
    if (!word || word.script !== sc) { endWord(); word = { pieces: [], script: sc }; }
    const off = cp - sc.base;
    if (sc.consonants[off] != null) {
      flush('a');
      pending = sc.consonants[off];
      if (sc === HI && (off === 0x5c || off === 0x5d)) pending = off === 0x5c ? FLAP : `${FLAP}h`;
      continue;
    }
    if (off === sc.nukta) {
      if (pending === 'd') pending = FLAP;
      else if (pending === 'dh') pending = `${FLAP}h`;
      else if (pending != null) pending = NUKTA[pending] || pending;
      continue;
    }
    if (off === sc.virama) {
      if (pending != null) { word.pieces.push({ kind: 'C', c: pending, v: '', inherent: false }); pending = null; }
      continue;
    }
    if (sc.signs[off] != null) {
      if (pending != null) flush(sc.signs[off]);
      else word.pieces.push({ kind: 'V', v: sc.signs[off] });
      continue;
    }
    if (sc.vowels[off] != null) {
      flush('a');
      word.pieces.push({ kind: 'V', v: sc.vowels[off] });
      continue;
    }
    if (off === sc.anusvara || off === sc.candrabindu) {
      flush('a');
      if (off === sc.candrabindu && sc === TE) continue;      // the Telugu half-nasal is barely said
      /* "m" before p/b/m; at the end of a Telugu word ("పట్నం"); else "n". */
      const nx = i + 1 < cps.length ? cps[i + 1] : null;
      const next = nx != null && scriptOf(nx) === sc ? sc.consonants[nx - sc.base] : null;
      word.pieces.push({ kind: 'N', t: next ? (LABIAL.test(next) ? 'm' : 'n') : sc.finalAnusvara });
      continue;
    }
    if (off === sc.visarga) { flush('a'); word.pieces.push({ kind: 'N', t: 'h' }); continue; }
    if (off >= sc.digits && off <= sc.digits + 9) { endWord(); words.push(String(off - sc.digits)); continue; }
    if (sc === HI && (off === 0x64 || off === 0x65)) { endWord(); words.push(' '); continue; }   // danda
    if (sc === HI && off === 0x50) { endWord(); words.push('om'); continue; }
    /* length marks and the like: nothing */
  }
  endWord();

  return words.map((w) => {
    if (typeof w === 'string') return w;
    if (w.script.finalSchwa) dropSchwa(w.pieces);
    return w.pieces.map((p) => (p.kind === 'C' ? p.c + p.v : p.kind === 'V' ? p.v : p.t)).join('');
  }).join('').split(FLAP).join(flap);
}

/**
 * Hindi does not say every inherent "a": not at the end of a word
 * (हैदराबाद "haidaraabaad"), and not between two syllables that keep
 * their vowels (पटना "patnaa", कानपुर "kaanpur", लखनऊ "lakhnauu").
 * Right to left, as the rule is usually stated.
 */
function dropSchwa(pieces) {
  const voiced = (p) => p && ((p.kind === 'C' && p.v !== '') || p.kind === 'V');
  const syllables = pieces.filter(voiced).length;
  const last = pieces[pieces.length - 1];
  if (syllables > 1 && last && last.kind === 'C' && last.inherent) { last.v = ''; last.inherent = false; }
  for (let i = pieces.length - 2; i >= 1; i -= 1) {
    const p = pieces[i];
    if (p.kind !== 'C' || !p.inherent) continue;
    const left = pieces[i - 1];
    const right = pieces[i + 1];
    if (voiced(left) && right && right.kind === 'C' && right.v !== '') { p.v = ''; p.inherent = false; }
  }
}

/* ------------------------------------------------------------------ *
 * the sound key
 * ------------------------------------------------------------------ */

const VOWEL = /[aeiou]/;

/**
 * A spelling-tolerant key for a place name in Latin letters (transliterate
 * native script first). Everything that varies between the ways one name
 * is written in English, and between the English and the native spelling,
 * is folded away:
 *
 *   diacritics, case, spaces, hyphens         "Visākhapatnam" = "visakhapatnam"
 *   aspiration and sibilants                  kh/k, th/t, dh/d, bh/b, sh/s, ph/f/p
 *   c / k / q, w / v, z / j, x = ks
 *   every h (Hyderabad / haidaraabaad, Rajahmundry / raajamandri)
 *   y before a consonant is the "ai" sound    Hyderabad -> "ederabad" = haidaraabaad
 *   long vowels and doubled letters           nelluuru = neluru, ll = l
 *   the last vowel                            Nellore = nelluuru, Guntur = guntooru
 */
export function placeKey(text) {
  let s = String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z]/g, '');
  s = s
    .replace(/x/g, 'ks')
    .replace(/chh|ch/g, 'C')
    .replace(/ck/g, 'k')
    .replace(/c/g, 'k')
    .replace(/C/g, 'c')
    .replace(/q/g, 'k')
    .replace(/([kgcjtdpbsz])h/g, '$1')
    .replace(/ph|f/g, 'p')
    .replace(/ow(?![aeiou])/g, 'o')
    .replace(/nv$/, 'n')                 // गांव "gaanv" = "gaon"
    .replace(/w/g, 'v')
    .replace(/z/g, 'j')
    .replace(/h/g, '')
    .replace(/([aeiou])y(?=[aeiou])/g, '$1')   // a glide: Vizianagaram = vijayanagaram, Jaipur = jayapur
    .replace(/y(?=[^aeiou])/g, 'e')            // Hyderabad, Mysore: the "ai" sound, as ai below
    .replace(/y$/, 'i')                        // Rajahmundry, Trichy
    .replace(/ee|ii/g, 'i')
    .replace(/oo|uu/g, 'u')
    .replace(/ai|ay(?![aeiou])/g, 'e')
    .replace(/au|ou/g, 'o')
    .replace(/(.)\1+/g, '$1')
    .replace(/[aeiou]$/, '');
  return s;
}

/** The consonants of a key, in order. */
export function skeleton(key) {
  return String(key || '').replace(/[aeiou]/g, '');
}

/**
 * Edit distance between two keys where vowels are cheap: changing,
 * adding or dropping a vowel costs 0.5, anything else 1. Two keys with
 * the same skeleton differ only in vowels, so this measures how far
 * "nelur" is from "nelor" (0.5) and "kurnul" from "karnul" (0.5).
 */
export function vowelDistance(a, b) {
  const m = a.length;
  const n = b.length;
  const cost = (ch) => (VOWEL.test(ch) ? 0.5 : 1);
  let prev = new Array(n + 1);
  prev[0] = 0;
  for (let j = 1; j <= n; j += 1) prev[j] = prev[j - 1] + cost(b[j - 1]);
  for (let i = 1; i <= m; i += 1) {
    const cur = new Array(n + 1);
    cur[0] = prev[0] + cost(a[i - 1]);
    for (let j = 1; j <= n; j += 1) {
      const x = a[i - 1];
      const y = b[j - 1];
      const sub = x === y ? 0 : (VOWEL.test(x) && VOWEL.test(y) ? 0.5 : 1);
      cur[j] = Math.min(prev[j - 1] + sub, prev[j] + cost(x), cur[j - 1] + cost(y));
    }
    prev = cur;
  }
  return prev[n];
}
