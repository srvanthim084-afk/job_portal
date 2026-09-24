/**
 * The six acceptance tests for the Location filter, run as written.
 *
 *     node tools/verify-location-acceptance.mjs   (dev server on :4323)
 *
 *   1  open the filter        states AND districts already visible
 *   2  search "Hyderabad"     found by the existing autocomplete
 *   3  select Hyderabad       the SAME list fills in - and there is no
 *                             "Near Hyderabad" section anywhere
 *   4  choose 25 KM           every location within 25 KM, real distances
 *   5  change to 50 KM        the list expands
 *   6  select a location      the candidate search still receives it
 *
 * ONE LIST. The earlier attempt prepended a "Near <place>" group above
 * the list, which with no distance chosen read "NEAR POONCH / Poonch -
 * 0 KM / Choose a distance above to list the places around it" - a
 * heading whose only content was an instruction. Test 3 and test 3b now
 * fail if any "Near ..." heading exists at all.
 *
 * The radius is a GEOGRAPHIC question, not an administrative one: a
 * locality in one district that falls within range of a city in another
 * belongs in the answer, and every level the dataset holds - district,
 * city, town, locality, suburb - is considered.
 *
 * Every distance is recomputed here from the coordinates with a separate
 * haversine, so replacing the calculation with a table of numbers fails.
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
const setKm = async (km) => {
  await page.evaluate((k) => { window.tlLocState(k).km = ''; }, KEY);
  await page.evaluate(([k, v]) => window.tlTreeKm(k, v), [KEY, km]);
  await page.waitForTimeout(500);
};
/*
 * THE ROWS ARE READ OUT OF THE ONE LIST, by looking for a distance.
 *
 * This used to read '.tl-nbgrp .tl-row2' - the rows of a separate "Near
 * <place>" group that was prepended above the list. There is no such
 * group any more, and a selector that only matches one would pass this
 * suite while the list itself showed nothing.
 *
 * A row is "in range" exactly when the list drew a distance on it, which
 * is the same condition the filter uses, so this cannot agree with a
 * filter that is not running.
 */
const nearRows = () => page.evaluate((k) =>
  [...document.querySelectorAll('#tlTree_' + k + ' .tl-row2')]
    .filter((r) => r.querySelector('.tl-km'))
    .map((r) => ({
      name: r.querySelector('.nm').textContent.trim(),
      km: Number(String(r.querySelector('.tl-km').textContent || '').replace(/[^\d]/g, '')),
    }))
    .sort((a, b) => a.km - b.km), KEY);

/* Anything that would be a second section, or a "Near ..." heading. */
const sections = () => page.evaluate((k) => {
  const root = document.getElementById('tlTree_' + k);
  if (!root) return { near: [], groups: [], nbgrp: 0, nb: 0 };
  const text = (n) => n.textContent.replace(/\s+/g, ' ').trim();
  return {
    /*
     * "Near <a place>", which must not exist - and NOT "Near by", which
     * is the existing label on the distance buttons and has to stay. The
     * first version of this check matched both and failed on the thing it
     * was protecting.
     *
     * Both shapes the removed section used are caught: "Near Poonch" and
     * "54 near Poonch".
     */
    near: [...root.querySelectorAll('b')].map(text)
      .filter((t) => /(^|\s)near\s+(?!by\b)\S/i.test(t)),
    groups: [...root.querySelectorAll('.grp > b')].map(text),
    nbgrp: root.querySelectorAll('.tl-nbgrp').length,
    nb: root.querySelectorAll('.tl-nb').length,
  };
}, KEY);

/* ================= TEST 1 - open it, districts already there ========= */
console.log('\nTEST 1 - open the filter');
await page.evaluate((k) => window.tlLocOpen(k), KEY);
await page.waitForTimeout(600);

const first = await page.evaluate(() => {
  const heads = [...document.querySelectorAll('#tlTree_recAdv .tl-sthead')]
    .map((n) => n.textContent.replace(/[▾▸]/g, '').trim().replace(/\s+\d+$/, ''));
  const open = document.querySelectorAll('#tlTree_recAdv .tl-dists').length;
  const rows = [...document.querySelectorAll('#tlTree_recAdv .tl-dists .tl-row2 .nm')]
    .map((n) => n.textContent.trim());
  return { heads, open, rows };
});
check(first.heads.length >= 36, `every state is listed (${first.heads.length})`);
check(first.open >= 36,
  `and every state is ALREADY OPEN - no click needed (${first.open} showing their districts)`);
for (const d of ['Hyderabad', 'Rangareddy', 'Medchal-Malkajgiri', 'Sangareddy', 'Warangal',
                 'Karimnagar', 'Nalgonda', 'Khammam', 'Nizamabad']) {
  check(first.rows.includes(d), `  Telangana > ${d} is visible without clicking`);
}
for (const d of ['Guntur', 'Krishna', 'NTR', 'Visakhapatnam', 'Tirupati']) {
  check(first.rows.includes(d), `  Andhra Pradesh > ${d} is visible without clicking`);
}

/* ================= TEST 2 - search finds Hyderabad =================== */
console.log('\nTEST 2 - search "Hyderabad"');
const sug = await page.evaluate(() => TL_LOC.suggest('Hyderabad', 6).map((s) => s.label));
check(sug.includes('Hyderabad'),
  `the existing autocomplete finds it (${sug.slice(0, 3).join(' | ')})`);

/* ================= TEST 3 - select it ================================ */
console.log('\nTEST 3 - select Hyderabad');
await page.evaluate((k) => window.tlTreeClear(k), KEY);
await page.evaluate((k) => window.tlLocOpen(k), KEY);
await page.evaluate((k) => window.tlTreePick(k, 'Hyderabad', true), KEY);
await setKm('25');

const at25 = await nearRows();
check(at25.length > 1, `the SAME list now shows the places around it (${at25.length})`);
check(at25.some((r) => r.name === 'Hyderabad' && r.km === 0),
  'Hyderabad itself is in the list at 0 KM');

/*
 * NO SECOND SECTION. This is the requirement the previous attempt got
 * wrong: picking a place produced a "NEAR POONCH" group above the list,
 * and with no distance chosen its only content was "Choose a distance
 * above to list the places around it".
 */
const sec = await sections();
check(sec.near.length === 0,
  `there is no "Near ..." heading anywhere (${JSON.stringify(sec.near)})`);
check(sec.nbgrp === 0 && sec.nb === 0,
  `and no nearby block is injected into the panel (${sec.nbgrp} + ${sec.nb})`);
check(sec.groups.some((g) => /Country/.test(g)) && sec.groups.some((g) => /Near by/.test(g)),
  `the existing groups are the ones that are there (${sec.groups.join(' | ')})`);

/*
 * A place picked and no distance chosen: the list must be the ordinary
 * list, not a heading telling the recruiter to choose a distance.
 */
console.log('\nTEST 3b - a place picked, Exact city');
await page.evaluate((k) => { window.tlLocState(k).km = ''; }, KEY);
await page.evaluate((k) => window.tlLocRefresh(k), KEY);
await page.waitForTimeout(400);
const exact = await sections();
const exactRows = await nearRows();
check(exact.near.length === 0,
  `still no "Near ..." heading with Exact city (${JSON.stringify(exact.near)})`);
check(exactRows.length === 0,
  `Exact city shows no nearby places at all (${exactRows.length})`);
const exactStates = await page.evaluate((k) =>
  document.querySelectorAll('#tlTree_' + k + ' .tl-sthead').length, KEY);
check(exactStates >= 36,
  `and the full states-and-districts list is back (${exactStates} states)`);
await setKm('25');

/* ================= TEST 4 - 25 KM, real distances ==================== */
console.log('\nTEST 4 - 25 KM');
for (const name of ['Madhapur', 'Hitech City', 'Gachibowli', 'Kondapur', 'Kukatpally',
                    'Uppal', 'Secunderabad', 'LB Nagar', 'Manikonda', 'Shamshabad']) {
  check(at25.some((r) => r.name === name), `  ${name} is within 25 KM`);
}

/*
 * Not restricted to one district. Shamshabad is in Rangareddy and
 * Kukatpally in Medchal-Malkajgiri; both fall inside 25 km of Hyderabad
 * and both belong in a geographic answer.
 */
const across = await page.evaluate(() => {
  const d = window.INDIA_AREA_DISTRICT || {};
  return { shamshabad: d.Shamshabad, kukatpally: d.Kukatpally };
});
check(across.shamshabad === 'Rangareddy' && across.kukatpally === 'Medchal-Malkajgiri',
  `the radius crosses district lines (Shamshabad=${across.shamshabad}, Kukatpally=${across.kukatpally})`);

const coords = await page.evaluate(() => window.INDIA_COORDS || {});
let recomputed = 0;
for (const r of at25) {
  if (r.km === 0) continue;
  const c = coords[r.name];
  if (!c) { check(false, `${r.name} is shown with no coordinates`); continue; }
  const mine = haversine(coords.Hyderabad, c);
  if (Math.abs(Math.round(mine) - r.km) > 1) {
    check(false, `${r.name}: shown ${r.km}, haversine ${mine.toFixed(1)}`);
  }
  check(mine <= 25.6, `  ${r.name}: ${Math.round(mine * 10) / 10} KM, inside the radius`);
  recomputed++;
}
check(recomputed >= 12, `every distance recomputed independently (${recomputed})`);

/* ================= TEST 5 - widen to 50 KM =========================== */
console.log('\nTEST 5 - change to 50 KM');
await setKm('10');
const at10 = await nearRows();
await setKm('50');
const at50 = await nearRows();
await setKm('100');
const at100 = await nearRows();
await setKm('any');
await page.waitForTimeout(600);
const anyKm = await nearRows();

check(at10.length < at25.length && at25.length < at50.length && at50.length < at100.length,
  `the list grows with the radius (10:${at10.length} < 25:${at25.length} < 50:${at50.length} < 100:${at100.length})`);
check(at10.every((r) => r.km <= 10), `nothing beyond 10 KM at 10 (max ${Math.max(...at10.map((r) => r.km))})`);
check(at50.every((r) => r.km <= 50), `nothing beyond 50 KM at 50 (max ${Math.max(...at50.map((r) => r.km))})`);
check(anyKm.length > at100.length, `Any Distance shows everything we can locate (${anyKm.length})`);

/* ================= TEST 6 - selection still feeds the search ========= */
console.log('\nTEST 6 - select a location');
await setKm('25');
await page.evaluate((k) => window.tlTreePick(k, 'Madhapur', true), KEY);
await page.evaluate((k) => window.tlTreePick(k, 'Gachibowli', true), KEY);
await page.waitForTimeout(400);
const tags = await page.evaluate((k) => window.tlLocState(k).tags, KEY);
check(tags.includes('Hyderabad') && tags.includes('Madhapur') && tags.includes('Gachibowli'),
  `the selection reaches the search unchanged (${JSON.stringify(tags)})`);

/* ================= the UI is the UI ================================== */
/*
 * With Exact city, so the whole list is on screen. Counting checkboxes
 * while a 25 KM filter is applied counts the filtered list and would
 * fail for the right reason at the wrong moment.
 */
console.log('\nthe existing UI');
await page.evaluate((k) => { window.tlLocState(k).km = ''; }, KEY);
await page.evaluate((k) => window.tlLocRefresh(k), KEY);
await page.waitForTimeout(400);
const ui = await page.evaluate(() => ({
  panels: document.querySelectorAll('#tlTree_recAdv').length,
  pills: [...document.querySelectorAll('#tlTree_recAdv .tl-kmp')].map((n) => n.textContent.trim()),
  foot: [...document.querySelectorAll('#tlTree_recAdv .foot button')].map((n) => n.textContent.trim()),
  boxes: document.querySelectorAll('#tlTree_recAdv input[type="checkbox"]').length,
}));
check(ui.panels === 1, `one panel, not a second one (${ui.panels})`);
check(JSON.stringify(ui.pills) === JSON.stringify(
  ['Exact city', '5 KM', '10 KM', '15 KM', '25 KM', '50 KM', '100 KM', 'Any Distance']),
  `the distance buttons are unchanged (${ui.pills.join(' | ')})`);
check(ui.foot.includes('Clear') && ui.foot.includes('Done')
  && ui.foot.some((f) => /Collapse|Expand/.test(f)),
  `Collapse all, Clear and Done are unchanged (${ui.foot.join(', ')})`);
check(ui.boxes > 100, `everything is still a checkbox in the same list (${ui.boxes})`);

check(errors.length === 0, `no page errors${errors.length ? `: ${errors[0]}` : ''}`);
await browser.close();
console.log(fail.length ? `\n${fail.length} failed` : '\nall good');
process.exit(fail.length ? 1 : 0);
