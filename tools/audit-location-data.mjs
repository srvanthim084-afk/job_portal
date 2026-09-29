/**
 * What the location dataset cannot answer.
 *
 *     node tools/audit-location-data.mjs
 *
 * Two questions, both asked of the data rather than of the code, because
 * the radius panel has been blamed twice for faults that were neither in
 * its arithmetic nor in its rendering:
 *
 *   WHICH DISTRICTS HAVE NO COORDINATES. A district the page cannot
 *   place is a district the panel cannot measure from, and it says so -
 *   "we have no coordinates for anywhere near Anjaw" - which reads as a
 *   broken feature and is a missing row.
 *
 *   WHICH DISTRICTS HAVE ALMOST NOTHING NEAR THEM. A district whose
 *   50 km circle contains one town is either genuinely remote or missing
 *   its villages, and the difference matters: the first is a fact to
 *   report, the second is data to load.
 *
 * Run before and after a dataset change. The "before" is the argument
 * for doing it; the "after" is the evidence it worked.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const INDEX = process.env.PLACES_FILE
  || path.join(process.cwd(), 'var', 'places', 'india-places.tsv');

/* The districts the product offers, read from the page itself so the
   audit is about what a recruiter can actually tick. */
const html = readFileSync('web/index.html', 'utf8');

function extractObject(marker) {
  const at = html.indexOf(marker);
  if (at < 0) throw new Error(`${marker} not found in web/index.html`);
  const open = html.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (!depth) return html.slice(open, i + 1); }
  }
  throw new Error(`${marker} is not balanced`);
}

// eslint-disable-next-line no-eval
const GEO = eval(`(${extractObject('window.INDIA_GEO')})`);
// eslint-disable-next-line no-eval
const COORDS = eval(`(${extractObject('window.INDIA_COORDS')})`);

const norm = (v) => String(v || '').trim().toLowerCase();
const coordsOf = (name) => {
  if (COORDS[name]) return COORDS[name];
  const n = norm(name);
  for (const k of Object.keys(COORDS)) if (norm(k) === n) return COORDS[k];
  return null;
};

/* ------------------------------------------------------------------ *
 * a · districts with no coordinates
 * ------------------------------------------------------------------ */

const states = Object.keys(GEO);
let districts = 0;
const noCoords = [];
for (const st of states) {
  for (const d of GEO[st] || []) {
    districts++;
    if (!coordsOf(d)) noCoords.push(`${d} (${st})`);
  }
}

console.log('LOCATION DATA AUDIT');
console.log('===================\n');
console.log(`states and union territories : ${states.length}`);
console.log(`districts offered in the UI  : ${districts}`);
console.log(`places with coordinates      : ${Object.keys(COORDS).length}`);
console.log(`\na) DISTRICTS WITH NO COORDINATES: ${noCoords.length} of ${districts}`
  + ` (${Math.round((noCoords.length / districts) * 100)}%)`);
if (noCoords.length) {
  const byState = {};
  for (const row of noCoords) {
    const st = row.slice(row.indexOf('(') + 1, -1);
    (byState[st] = byState[st] || []).push(row.slice(0, row.indexOf(' (')));
  }
  const worst = Object.entries(byState).sort((a, b) => b[1].length - a[1].length);
  for (const [st, ds] of worst.slice(0, 12)) {
    console.log(`   ${String(ds.length).padStart(3)}  ${st.padEnd(28)} ${ds.slice(0, 4).join(', ')}`
      + (ds.length > 4 ? ` … +${ds.length - 4}` : ''));
  }
  if (worst.length > 12) console.log(`   … and ${worst.length - 12} more states`);
}

/* ------------------------------------------------------------------ *
 * b · districts with nothing near them
 * ------------------------------------------------------------------ */

const RAD = (d) => (d * Math.PI) / 180;
const km = (a, b) => {
  const dLa = RAD(b[0] - a[0]);
  const dLo = RAD(b[1] - a[1]);
  const s = Math.sin(dLa / 2) ** 2
    + Math.cos(RAD(a[0])) * Math.cos(RAD(b[0])) * Math.sin(dLo / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(s));
};

/* Measured against the served index when it exists, because that is what
   the panel actually queries; against the in-page list when it does not,
   which is the state this audit was written to describe. */
let pool = [];
let source = 'web/index.html (window.INDIA_COORDS)';
if (existsSync(INDEX)) {
  source = INDEX;
  for (const line of readFileSync(INDEX, 'utf8').split('\n')) {
    if (!line) continue;
    const f = line.split('\t');
    const la = Number(f[1]);
    const lo = Number(f[2]);
    if (Number.isFinite(la) && Number.isFinite(lo)) pool.push([la, lo]);
  }
} else {
  pool = Object.values(COORDS);
}

console.log(`\nb) HOW MUCH IS WITHIN 50 KM OF EACH DISTRICT`);
console.log(`   measured against: ${source}`);
console.log(`   ${pool.length.toLocaleString()} places in the pool\n`);

const counted = [];
for (const st of states) {
  for (const d of GEO[st] || []) {
    const c = coordsOf(d);
    if (!c) continue;
    let n = 0;
    for (const q of pool) if (km(c, q) <= 50) n++;
    counted.push({ d, st, n });
  }
}
counted.sort((a, b) => a.n - b.n);

const bands = [
  ['nothing at all (0)', (x) => x.n === 0],
  ['almost nothing (1-2)', (x) => x.n >= 1 && x.n <= 2],
  ['thin (3-9)', (x) => x.n >= 3 && x.n <= 9],
  ['usable (10-99)', (x) => x.n >= 10 && x.n <= 99],
  ['rich (100+)', (x) => x.n >= 100],
];
for (const [label, test] of bands) {
  const rows = counted.filter(test);
  console.log(`   ${String(rows.length).padStart(4)}  ${label}`);
}

console.log('\n   the twelve worst:');
for (const r of counted.slice(0, 12)) {
  console.log(`     ${String(r.n).padStart(5)}  ${r.d} (${r.st})`);
}

const median = counted.length ? counted[Math.floor(counted.length / 2)].n : 0;
console.log(`\n   median district has ${median} places within 50 km`);
console.log(`\ndistricts that cannot be measured from at all: ${noCoords.length}`);
