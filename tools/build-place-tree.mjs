/**
 * The place index, WITH ITS PARENTS.
 *
 *     node tools/build-place-tree.mjs var/places/src/IN.txt
 *
 * WHY A SECOND BUILDER. build-place-index.mjs already turns the GeoNames
 * dump into something the distance filter can answer questions about, and
 * it keeps districts (ADM2) and mandals (ADM3) alongside the villages -
 * but it throws away the two columns that say WHICH district and WHICH
 * mandal each row belongs to. So the file has every level in it and no
 * way to walk from one to the next: the browse tree could list states and
 * districts (from a hand-written map in the page) and then stopped,
 * because below that there was nothing to walk to.
 *
 * This keeps the chain. Columns 12 and 13 of the dump are the admin2 and
 * admin3 codes; every ADM2 row declares its own admin2 code and every
 * ADM3 row its admin3, so the codes join the levels exactly rather than
 * by guessing from distance. Measured on the current dump:
 *
 *     36 states, 763 districts, 6,891 mandals, 549,026 places
 *     99.5% of places carry a district code, 99.3% a mandal code
 *
 * The half a percent that carry neither are parented to their state,
 * which is where they genuinely sit as far as this file knows. Nothing is
 * invented and nothing is dropped for being incomplete.
 *
 * OUTPUT: one record per line, tab separated, in the order
 *
 *     id  name  type  parentId  lat  lng  population  alias
 *
 * type is state | district | mandal | place. Coordinates keep four
 * decimals - about eleven metres, far finer than a filter whose smallest
 * step is five kilometres - and that rounding is most of the size saving.
 *
 * Written beside the existing index rather than over it, so the running
 * server keeps working until the reader is switched across.
 */
import { createReadStream, createWriteStream, mkdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname } from 'node:path';

const SRC = process.argv[2] || 'var/places/src/IN.txt';
const OUT = process.argv[3] || 'var/places/india-tree.tsv';

/*
 * THE CODES COME FROM THE DUMP, NOT FROM A LIST IN THIS FILE.
 *
 * The previous builder carried a hard-coded admin1 map, and it does not
 * match this dump: it says 03 is Arunachal Pradesh and the dump's own
 * ADM1 row for 03 is Assam; 13 is Himachal here and Kerala there; 25 is
 * Punjab here and Tamil Nadu there. Every place in the existing index
 * therefore carries the wrong state for a good number of codes, which is
 * invisible until somebody filters by state.
 *
 * A dump that ships its own ADM1 rows does not need to be told what they
 * are. Pass one reads them; nothing here can drift from the file again.
 *
 * SPELLING is the one thing preferred from outside: where the dump says
 * "Chhattīsgarh" and the rest of this product says "Chhattisgarh", the
 * product's spelling wins so a state filter and a candidate's stored
 * location are the same string. Matched by folded name, never by code.
 */
const APP_SPELLING = [
  'Andaman and Nicobar', 'Andhra Pradesh', 'Arunachal Pradesh', 'Assam',
  'Bihar', 'Chandigarh', 'Chhattisgarh', 'Dadra and Nagar Haveli and Daman and Diu',
  'Delhi', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jammu and Kashmir',
  'Jharkhand', 'Karnataka', 'Kerala', 'Ladakh', 'Lakshadweep', 'Madhya Pradesh',
  'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha',
  'Puducherry', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana',
  'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
];

const clean = (s) => String(s || '').replace(/[\t\n\r]+/g, ' ').trim();

/*
 * ONE ROW PER STATE, WHATEVER THE DUMP SAYS.
 *
 * GeoNames carries more than one ADM1 row for several states - a current
 * one and a historical one under an older admin1 code - so the first
 * build produced "Telangana" AND "State of Telangāna", "Uttarakhand" AND
 * "State of Uttarākhand", and Ladakh twice. A recruiter opening the
 * browse tree would see the same state listed twice with its districts
 * split between them.
 *
 * So a state is keyed by its CANONICAL NAME, not by the dump's code:
 * diacritics stripped, the words "State of" and "Union Territory of"
 * dropped. The first row wins and later ones are merged onto it, which
 * keeps every district attached to one state rather than orphaning any.
 */
const canonState = (v) => String(v || '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/^\s*(State|Union Territory|UT|National Capital Territory|NCT)\s+of\s+/i, '')
  .replace(/\s+islands?$/i, '')
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase();

/*
 * TWO PASSES, because a village can appear in the file before the mandal
 * it belongs to. The first pass learns where every administrative area
 * is; the second writes the rows with their parents already known.
 */
const districts = new Map();   // "admin1|admin2" -> row
const mandals = new Map();     // "admin1|admin2|admin3" -> row
const SPELLING = new Map(APP_SPELLING.map((v) => [canonState(v), v]));
const states = new Map();      // admin1 code -> row (several codes may share one)
const stateByName = new Map(); // canonical name -> row, so a state appears once

async function pass(fn) {
  const rl = createInterface({
    input: createReadStream(SRC, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line) continue;
    const f = line.split('\t');
    if (f.length < 15) continue;
    fn(f);
  }
}

/* ---- pass one: the administrative skeleton ----------------------- */
await pass((f) => {
  const cls = f[6], code = f[7];
  if (cls !== 'A') return;
  const a1 = f[10], a2 = f[11], a3 = f[12];
  const lat = Number(f[4]), lon = Number(f[5]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

  const row = {
    id: f[0], name: clean(f[1]), lat, lon,
    pop: Number(f[14]) || 0,
    /* The names an administrative area is also known by - "Bangalore
       Rural", "Distretto di Yavatmal". Six is ample; the alternate-name
       column alone is a third of the file. */
    alias: clean(f[3]).split(',').filter(Boolean).slice(0, 6).join('|'),
    state: '',
  };

  if (code === 'ADM1') {
    /* The dump's own name, with the administrative prefix dropped. */
    const bare = clean(f[1]).replace(/^\s*(State|Union Territory|UT)\s+of\s+/i, '');
    const key = canonState(bare);
    const already = stateByName.get(key);
    if (already) {
      /* A second row for a state we already have - GeoNames carries a
         current and a historical code for several. Both codes now point
         at the one row, so its districts are not split in two. */
      states.set(a1, already);
      return;
    }
    row.label = SPELLING.get(key) || bare;
    stateByName.set(key, row);
    states.set(a1, row);
  }
  else if (code === 'ADM2' && a2) districts.set(`${a1}|${a2}`, row);
  else if (code === 'ADM3' && a3) mandals.set(`${a1}|${a2}|${a3}`, row);
});

console.log(`states ${states.size}  districts ${districts.size}  mandals ${mandals.size}`);

/* ---- write ------------------------------------------------------- */
mkdirSync(dirname(OUT), { recursive: true });
const out = createWriteStream(OUT, { encoding: 'utf8' });
const emit = (id, name, type, parent, lat, lon, pop, alias) =>
  out.write(`${id}\t${name}\t${type}\t${parent}\t${lat.toFixed(4)}\t${lon.toFixed(4)}\t${pop}\t${alias}\n`);

let nState = 0, nDist = 0, nMandal = 0, nPlace = 0, orphanDistrict = 0, orphanMandal = 0;

for (const r of stateByName.values()) {
  const alias = [r.name, r.alias].filter(Boolean).join('|');
  emit(r.id, r.label, 'state', '', r.lat, r.lon, r.pop, alias);
  nState += 1;
}
for (const [key, r] of districts) {
  const a1 = key.split('|')[0];
  const parent = states.get(a1);
  if (!parent) orphanDistrict += 1;
  emit(r.id, r.name, 'district', parent ? parent.id : '', r.lat, r.lon, r.pop, r.alias);
  nDist += 1;
}
for (const [key, r] of mandals) {
  const [a1, a2] = key.split('|');
  const parent = districts.get(`${a1}|${a2}`) || states.get(a1);
  if (!districts.get(`${a1}|${a2}`)) orphanMandal += 1;
  emit(r.id, r.name, 'mandal', parent ? parent.id : '', r.lat, r.lon, r.pop, r.alias);
  nMandal += 1;
}

/* ---- pass two: the places themselves ------------------------------ */
await pass((f) => {
  const cls = f[6], code = f[7];
  if (cls !== 'P' || code === 'PPLQ') return;      // not an abandoned village
  const lat = Number(f[4]), lon = Number(f[5]);
  const name = clean(f[1]);
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) return;

  const a1 = f[10], a2 = f[11], a3 = f[12];
  /* The most specific parent this row actually declares. Nothing is
     guessed from distance: a village whose file says nothing below the
     state is parented to the state and says so. */
  const parent = (a3 && mandals.get(`${a1}|${a2}|${a3}`))
    || (a2 && districts.get(`${a1}|${a2}`))
    || states.get(a1);

  /* A village's alternate names are mostly transliterations into
     alphabets nobody types into a recruitment filter, so only the ASCII
     name is kept when it differs from the display name. */
  const ascii = clean(f[2]);
  const alias = ascii && ascii !== name ? ascii : '';

  emit(f[0], name, 'place', parent ? parent.id : '', lat, lon,
    Number(f[14]) || 0, alias);
  nPlace += 1;
});

out.end();
await new Promise((r) => out.on('close', r));

const mb = (statSync(OUT).size / 1e6).toFixed(1);
console.log(`\n${OUT}  ${mb} MB`);
console.log(`  states    ${nState}`);
console.log(`  districts ${nDist}${orphanDistrict ? `  (${orphanDistrict} with no state)` : ''}`);
console.log(`  mandals   ${nMandal}${orphanMandal ? `  (${orphanMandal} parented to their state)` : ''}`);
console.log(`  places    ${nPlace}`);
