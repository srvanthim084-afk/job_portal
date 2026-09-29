/**
 * Build the village-level place index from GeoNames.
 *
 *     node tools/build-place-index.mjs <path-to-IN.txt>
 *
 * WHY THIS EXISTS. The location filter measured distances against
 * window.INDIA_COORDS, which holds 1,244 places for the whole of India -
 * district headquarters, big cities, and the localities of two or three
 * metros somebody had filled in by hand. A recruiter ticking Chittoor and
 * asking for everything within 25 km got one row: Chittoor. Not because
 * the arithmetic was wrong, but because the four hundred villages that
 * are actually within 25 km of Chittoor were not in the file.
 *
 * GeoNames publishes 557,995 populated places for India under a Creative
 * Commons licence, villages included. This turns that into something a
 * server can answer questions about.
 *
 * WHAT IS KEPT, and what is dropped:
 *
 *   feature class P   populated places only. The dump's other 100,000
 *                     rows are rivers, ridges, temples and wells, none of
 *                     which a candidate lives in.
 *   not PPLQ          an abandoned village is not somewhere to recruit
 *                     from. 8,969 of them.
 *   name, lat, lon,   everything the panel needs and nothing else. The
 *   state             alternate-name column alone is a third of the file.
 *
 * Coordinates are rounded to four decimals - about eleven metres, which
 * is far finer than a filter whose smallest step is five kilometres - and
 * that rounding is most of the size saving.
 *
 * The output is written as NDJSON-ish packed text rather than JSON: one
 * record per line, tab separated, because 550,000 objects of JSON syntax
 * is thirty megabytes of braces and quotes for eleven megabytes of data.
 */
import { createReadStream, createWriteStream, statSync } from 'node:fs';
import { createInterface } from 'node:readline';

const SRC = process.argv[2];
if (!SRC) {
  console.error('usage: node tools/build-place-index.mjs <path-to-IN.txt>');
  process.exit(1);
}

/* GeoNames admin1 codes for India, from admin1CodesASCII.txt. */
const STATES = {
  '01': 'Andaman and Nicobar', '02': 'Andhra Pradesh', '03': 'Assam',
  '05': 'Chandigarh', '07': 'Delhi', '09': 'Gujarat', '10': 'Haryana',
  '11': 'Himachal Pradesh', '12': 'Jammu and Kashmir', '13': 'Kerala',
  '14': 'Lakshadweep', '16': 'Maharashtra', '17': 'Manipur', '18': 'Meghalaya',
  '19': 'Karnataka', '20': 'Nagaland', '21': 'Odisha', '22': 'Puducherry',
  '23': 'Punjab', '24': 'Rajasthan', '25': 'Tamil Nadu', '26': 'Tripura',
  '28': 'West Bengal', '29': 'Sikkim', '30': 'Arunachal Pradesh',
  '31': 'Mizoram', '33': 'Goa', '34': 'Bihar', '35': 'Madhya Pradesh',
  '36': 'Uttar Pradesh', '37': 'Chhattisgarh', '38': 'Jharkhand',
  '39': 'Uttarakhand', '40': 'Telangana', '41': 'Ladakh',
  '52': 'Dadra and Nagar Haveli and Daman and Diu',
};

const OUT = 'var/places/india-places.tsv';
try { statSync('var/places'); } catch { (await import('node:fs')).mkdirSync('var/places', { recursive: true }); }

const out = createWriteStream(OUT, { encoding: 'utf8' });
const rl = createInterface({ input: createReadStream(SRC, { encoding: 'utf8' }) });

let read = 0;
let kept = 0;
const perState = {};

for await (const line of rl) {
  read++;
  const f = line.split('\t');

  /*
   * POPULATED PLACES *AND* ADMINISTRATIVE AREAS.
   *
   * Class P alone was the first cut, and it left the panel unable to
   * measure from the thing recruiters actually tick. A DISTRICT is not a
   * populated place: "East Godavari" and "Anjaw" are administrative
   * areas, and 690 of the 776 districts the UI offers had no coordinates
   * anywhere in the product because of it - eighty-nine per cent. The
   * panel reported that honestly ("no coordinates for anywhere near
   * Anjaw") and it read as a broken feature.
   *
   *   ADM1  states and union territories      36
   *   ADM2  districts                        763
   *   ADM3  sub-districts, mandals, taluks  6,891
   *
   * They are kept alongside the villages, so a district can be both the
   * anchor a search measures from and a row in somebody else's results.
   */
  const cls = f[6];
  const code = f[7];
  const isPlace = cls === 'P' && code !== 'PPLQ';          // not abandoned
  const isAdmin = cls === 'A' && (code === 'ADM1' || code === 'ADM2' || code === 'ADM3');
  if (!isPlace && !isAdmin) continue;

  const name = (f[1] || '').trim();
  const lat = Number(f[4]);
  const lon = Number(f[5]);
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
  const state = STATES[f[10]] || '';
  const pop = Number(f[14]) || 0;

  /* The kind matters to the lookup: asked for "Chittoor", the answer
     should be the district rather than a hamlet that shares its name. */
  const kind = isAdmin ? code : 'P';

  /*
   * THE NAMES A DISTRICT IS ALSO KNOWN BY — for administrative areas
   * only, and only up to a point.
   *
   * A portal that says "Bellary" and a gazetteer that says "Ballari" are
   * talking about the same district, and so are Mehsana/Mahesana,
   * Ahmednagar/Ahmadnagar and thirty-odd others. Writing an alias table
   * by hand would be guessing at which pairs exist; GeoNames already
   * ships the answer in its alternatenames column, which is the
   * authoritative list rather than my recollection of Indian spelling.
   *
   * Villages do not get this: 549,000 rows of alternate names is most of
   * the file, and nobody types a village's Cyrillic exonym into a
   * recruitment filter. Six per admin row is ample and keeps the index
   * a megabyte larger rather than twenty.
   */
  let alt = '';
  if (isAdmin) {
    alt = String(f[3] || '')
      .split(',')
      .map((x) => x.trim())
      .filter((x) => x && /^[\x20-\x7EÀ-ɏ]+$/.test(x) && x.toLowerCase() !== name.toLowerCase())
      .slice(0, 6)
      .join('|');
  }

  out.write(`${name}\t${lat.toFixed(4)}\t${lon.toFixed(4)}\t${state}\t${pop}\t${kind}\t${alt}\n`);
  kept++;
  perState[state || '(unknown)'] = (perState[state || '(unknown)'] || 0) + 1;
}

out.end();
await new Promise((r) => out.on('finish', r));

const size = statSync(OUT).size;
console.log(`read ${read.toLocaleString()} rows, kept ${kept.toLocaleString()} populated places`);
console.log(`written to ${OUT} (${(size / 1024 / 1024).toFixed(1)} MB)`);
console.log('\nthe states this portal recruits in:');
for (const s of ['Andhra Pradesh', 'Telangana', 'Karnataka', 'Tamil Nadu', 'Maharashtra']) {
  console.log(`  ${s.padEnd(18)} ${(perState[s] || 0).toLocaleString()}`);
}
