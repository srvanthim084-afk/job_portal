/**
 * State -> district -> area, inside the list that was already there.
 *
 *     node tools/verify-location-hierarchy.mjs   (dev server on :4323)
 *
 * The filter already had two levels: 36 states and the 776 districts
 * under them. What it did not have was the level a recruiter actually
 * hires at - Madhapur, Gachibowli, Kukatpally - so "Telangana >
 * Hyderabad" was as deep as it went.
 *
 * THE DISTRICT OF AN AREA IS AN ADMINISTRATIVE FACT, not something a
 * distance can decide. Shamshabad is nearer the centre of Hyderabad
 * district than the centre of Rangareddy, and it is in Rangareddy. A
 * nearest-centroid rule would have filed it under the wrong one and a
 * recruiter filtering by district would have got the wrong answer with
 * nothing on screen to say why. So the areas carry their real district,
 * and anything with no district on file falls back to the nearest
 * centroid and is MARKED as an approximation rather than presented as
 * certain.
 *
 * Every distance is haversine over real coordinates, recomputed here
 * with a separate implementation.
 */
import { chromium } from 'playwright';

const BASE = (process.env.TL_URL || 'http://localhost:4323/').replace(/\/$/, '');
const fail = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`); if (!ok) fail.push(what); };

const haversine = (a, b) => {
  const R = 6371;
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b[0] - a[0]);
  const dLon = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));

await page.goto(`${BASE}/`, { waitUntil: 'load' });
await page.waitForFunction(() => window.TL && window.TL.ready === true, { timeout: 25000 });
await page.evaluate((l) => window.TL.api.post('/auth/login', l), {
  email: process.env.TL_RECRUITER || 'teamlinkmed001@tmlink.in',
  password: process.env.TL_RECRUITER_PASSWORD || 'Teamlink@2026',
  role: 'recruiter',
});
await page.evaluate(() => window.TL.refresh());
await page.waitForTimeout(900);
await page.evaluate(() => { location.hash = '#/recruiter/find-candidates'; });
await page.waitForTimeout(2200);

const KEY = 'recAdv';

/* ---- the levels that were already there are still there -------------- */
const data = await page.evaluate(() => ({
  states: Object.keys(window.INDIA_GEO || {}).length,
  districts: Object.values(window.INDIA_GEO || {}).reduce((n, d) => n + d.length, 0),
  coords: Object.keys(window.INDIA_COORDS || {}).length,
  telangana: (window.INDIA_GEO || {}).Telangana || [],
}));
check(data.states >= 36, `every state is still listed (${data.states})`);
check(data.districts >= 700, `and every district (${data.districts})`);
for (const d of ['Hyderabad', 'Rangareddy', 'Medchal-Malkajgiri', 'Sangareddy',
                 'Warangal', 'Nalgonda', 'Karimnagar', 'Khammam', 'Nizamabad']) {
  check(data.telangana.includes(d), `Telangana still lists ${d}`);
}

/* ---- the third level: areas inside a district ------------------------ */
const areasOf = (state, district) => page.evaluate(
  ([s, d]) => (window.tlAreasOfDistrict(s, d) || [])
    .map((a) => ({ name: a.name, km: a.km, approx: !!a.approx })), [state, district]);

const hyd = await areasOf('Telangana', 'Hyderabad');
check(hyd.length > 5, `Hyderabad has areas inside it (${hyd.length})`);
for (const name of ['Madhapur', 'Secunderabad', 'Jubilee Hills', 'Dilsukhnagar']) {
  check(hyd.some((a) => a.name === name), `  ${name} is under Hyderabad`);
}

/*
 * The case that decides whether this is real. Shamshabad is CLOSER to
 * Hyderabad's centre but belongs to Rangareddy.
 */
const rr = await areasOf('Telangana', 'Rangareddy');
check(rr.some((a) => a.name === 'Shamshabad'),
  `Shamshabad is under Rangareddy, its real district (${rr.map((a) => a.name).join(', ')})`);
check(!hyd.some((a) => a.name === 'Shamshabad'),
  'and NOT under Hyderabad, which is merely nearer');

const mm = await areasOf('Telangana', 'Medchal-Malkajgiri');
check(mm.some((a) => a.name === 'Kukatpally') && mm.some((a) => a.name === 'Uppal'),
  `Kukatpally and Uppal are under Medchal-Malkajgiri (${mm.length} areas)`);

/* It is not a Telangana feature. */
for (const [state, district, expect] of [
  ['Karnataka', 'Bangalore', 'Koramangala'],
  ['Tamil Nadu', 'Chennai', 'Velachery'],
  ['Maharashtra', 'Pune', 'Hinjewadi'],
  ['Maharashtra', 'Mumbai Suburban', 'Andheri'],
  ['Gujarat', 'Ahmedabad', 'Satellite'],
]) {
  const list = await areasOf(state, district);
  check(list.some((a) => a.name === expect),
    `${state} > ${district} > ${expect} (${list.length} areas)`);
}

/* A district with nothing on file says nothing rather than pretending. */
const empty = await areasOf('Telangana', 'Jogulamba Gadwal');
check(Array.isArray(empty), `a district with no areas returns a list, not an error (${empty.length})`);

/* ---- the distances are computed, not stored -------------------------- */
const coords = await page.evaluate(() => window.INDIA_COORDS || {});
let recomputed = 0;
for (const a of hyd) {
  const mine = haversine(coords.Hyderabad, coords[a.name]);
  check(Math.abs(mine - a.km) < 0.5,
    `  ${a.name}: shown ${Math.round(a.km)} KM, haversine says ${mine.toFixed(1)} KM`);
  recomputed++;
}
check(recomputed >= 8, `every distance was recomputed independently (${recomputed})`);

/* ---- the search still spans all four levels -------------------------- */
const sug = await page.evaluate(() => ({
  state: TL_LOC.suggest('Telangana', 12).map((x) => x.label),
  district: TL_LOC.suggest('Rangareddy', 6).map((x) => x.label),
  city: TL_LOC.suggest('Hyderabad', 6).map((x) => x.label),
  area: TL_LOC.suggest('Madhapur', 6).map((x) => x.label),
}));
check(sug.state.includes('Telangana') && sug.state.length > 3,
  `searching a STATE finds it and its districts (${sug.state.slice(0, 4).join(' | ')})`);
check(sug.district.some((s) => /Rangareddy/.test(s)), 'searching a DISTRICT finds it');
check(sug.city.some((s) => /Hyderabad/.test(s)), 'searching a CITY finds it');
check(sug.area.some((s) => /Madhapur/.test(s)), 'searching an AREA finds it');

/* ---- the UI: same list, same rows, nothing new ----------------------- */
/*
 * No tlTreeExpand here any more. Every state is OPEN when the filter
 * opens - a recruiter should not have to click Telangana to see its
 * districts - so calling expand would toggle it CLOSED and the areas
 * inside it could not be reached.
 */
await page.evaluate((k) => window.tlLocOpen(k), KEY);
await page.waitForTimeout(600);

const shape = await page.evaluate(() => ({
  panels: document.querySelectorAll('#tlTree_recAdv').length,
  states: document.querySelectorAll('#tlTree_recAdv .tl-sthead').length,
  openStates: document.querySelectorAll('#tlTree_recAdv .tl-dists').length,
  expanders: document.querySelectorAll('#tlTree_recAdv .tl-dcar').length,
  pills: [...document.querySelectorAll('#tlTree_recAdv .tl-kmp')].map((n) => n.textContent.trim()),
  foot: [...document.querySelectorAll('#tlTree_recAdv .foot button')].map((n) => n.textContent.trim()),
}));
check(shape.panels === 1, `one panel, not a second one (${shape.panels})`);
check(shape.states >= 36, `every state is a row in the list (${shape.states})`);
check(shape.openStates >= 36,
  `every state shows its districts without a click (${shape.openStates})`);
check(shape.expanders > 10,
  `districts with areas gained an expander (${shape.expanders} of them)`);
check(JSON.stringify(shape.pills) === JSON.stringify(
  ['Exact city', '5 KM', '10 KM', '15 KM', '25 KM', '50 KM', '100 KM', 'Any Distance']),
  `the distance buttons are unchanged (${shape.pills.join(' | ')})`);
check(shape.foot.includes('Clear') && shape.foot.includes('Done'),
  `Clear and Done are unchanged (${shape.foot.join(', ')})`);

await page.evaluate((k) => window.tlTreeArea(k, 'Telangana', 'Hyderabad'), KEY);
await page.waitForTimeout(600);
const opened = await page.evaluate(() =>
  [...document.querySelectorAll('#tlTree_recAdv .tl-areas .tl-row2')].map((r) => ({
    name: r.querySelector('.nm').textContent.trim(),
    km: r.querySelector('.tl-km') ? r.querySelector('.tl-km').textContent.trim() : null,
    checkbox: !!r.querySelector('input[type="checkbox"]'),
  })));
check(opened.length > 5, `opening Hyderabad shows its areas in the same list (${opened.length})`);
check(opened.every((r) => r.checkbox && r.km),
  'each is a checkbox row with its distance, like every other row');
check(await page.evaluate(() => document.querySelectorAll('#tlTree_recAdv .tl-dists').length) >= 36,
  'and every other state stayed open around it');

/* ---- selecting an area still feeds the candidate search -------------- */
await page.evaluate((k) => window.tlTreePick(k, 'Madhapur', true), KEY);
await page.evaluate((k) => window.tlTreePick(k, 'Hyderabad', true), KEY);
await page.waitForTimeout(400);
const tags = await page.evaluate((k) => window.tlLocState(k).tags, KEY);
check(tags.includes('Madhapur') && tags.includes('Hyderabad'),
  `an area and a district both reach the search (${JSON.stringify(tags)})`);

check(errors.length === 0, `no page errors${errors.length ? `: ${errors[0]}` : ''}`);
await browser.close();
console.log(fail.length ? `\n${fail.length} failed` : '\nall good');
process.exit(fail.length ? 1 : 0);
