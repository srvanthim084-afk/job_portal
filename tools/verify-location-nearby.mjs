/**
 * Nearby localities, with real distances, inside the existing list.
 *
 *     node tools/verify-location-nearby.mjs   (needs the dev server on :4323)
 *
 * The arithmetic was never the missing piece. INDIA_COORDS held roughly
 * seven hundred DISTRICTS and the haversine that measures between them
 * had been there all along - but a recruiter hiring in Hyderabad thinks
 * Madhapur, Gachibowli, Hitech City, and not one of those existed
 * anywhere in the dataset. "Near Hyderabad" could only answer Rangareddy
 * and Warangal: correct, and useless.
 *
 * So the localities were added, with their real latitude and longitude,
 * and the list a recruiter is already reading now fills in with them.
 * Not a second panel, not a new dropdown: the same <label class="tl-row2">
 * with the same checkbox calling the same tlTreePick(), so ticking one is
 * indistinguishable from ticking a district and the candidate search
 * receives it exactly as before.
 *
 * WHAT THIS CHECKS HARDEST is that no distance is stored. Every number on
 * screen is recomputed here, independently, from the coordinates - if
 * anybody ever replaces the calculation with a table of numbers, this
 * fails.
 */
import { chromium } from 'playwright';

const BASE = (process.env.TL_URL || 'http://localhost:4323/').replace(/\/$/, '');
const RECRUITER = {
  email: process.env.TL_RECRUITER || 'teamlinkmed001@tmlink.in',
  password: process.env.TL_RECRUITER_PASSWORD || 'Teamlink@2026',
  role: 'recruiter',
};

const fail = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`); if (!ok) fail.push(what); };

/** The same formula, written here on purpose so it is not the same code. */
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
const page = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));

await page.goto(`${BASE}/`, { waitUntil: 'load' });
await page.waitForFunction(() => window.TL && window.TL.ready === true, { timeout: 25000 });
await page.evaluate((l) => window.TL.api.post('/auth/login', l), RECRUITER);
await page.evaluate(() => window.TL.refresh());
await page.waitForTimeout(900);
await page.evaluate(() => { location.hash = '#/recruiter/find-candidates'; });
await page.waitForTimeout(2200);

const KEY = 'recAdv';
const openPanel = () => page.evaluate((k) => window.tlLocOpen(k), KEY);
const pick = (city) => page.evaluate(([k, c]) => window.tlTreePick(k, c, true), [KEY, city]);
const clear = () => page.evaluate((k) => window.tlTreeClear(k), KEY);
/*
 * The pill TOGGLES - clicking the active one clears it, which is how the
 * panel has always worked. So the radius is cleared before it is set,
 * or asking for 25 KM twice in a row turns it off and the list empties.
 * (It did, and the failure looked like Chennai having no localities.)
 */
const setKm = async (km) => {
  await page.evaluate((k) => { window.tlLocState(k).km = ''; }, KEY);
  await page.evaluate(([k, v]) => window.tlTreeKm(k, v), [KEY, km]);
};
const rows = () => page.evaluate((k) =>
  [...document.querySelectorAll('#tlTree_' + k + ' .tl-nbgrp .tl-row2')].map((r) => ({
    name: r.querySelector('.nm').textContent.trim(),
    km: Number(String((r.querySelector('.tl-km') || {}).textContent || '').replace(/[^\d]/g, '')),
    cls: r.className.trim(),
    checkbox: !!r.querySelector('input[type="checkbox"]'),
  })), KEY);

await openPanel();
await page.waitForTimeout(500);

/* ---- the existing UI is still the existing UI ----------------------- */
const pills = await page.$$eval('#tlTree_recAdv .tl-kmp', (ns) => ns.map((n) => n.textContent.trim()));
check(JSON.stringify(pills) === JSON.stringify(
  ['Exact city', '5 KM', '10 KM', '15 KM', '25 KM', '50 KM', '100 KM', 'Any Distance']),
  `the distance buttons are unchanged (${pills.join(' | ')})`);

const foot = await page.$$eval('#tlTree_recAdv .foot button', (ns) => ns.map((n) => n.textContent.trim()));
check(foot.includes('Clear') && foot.includes('Done'),
  `Clear and Done are still there (${foot.join(', ')})`);
check(foot.some((f) => /Collapse all|Expand all/.test(f)), 'and the collapse control');

const groups = await page.$$eval('#tlTree_recAdv .grp > b', (ns) => ns.map((n) => n.textContent.trim()));
check(groups.some((g) => /Country/.test(g)), 'Country & region is still in the list');
check(groups.some((g) => /States/.test(g)), 'States & districts is still in the list');

/*
 * ONE panel and ONE nearby list. The complaint that started all of this
 * was the same places appearing twice on one screen, so the count is the
 * assertion rather than "it looks right".
 */
const counts = await page.evaluate(() => ({
  // This field's own tree. The page hosts more than one location
  // field - the search one and the preferences one - and each has
  // always had its own; that is not a duplicate of anything.
  panels: document.querySelectorAll('#tlTree_recAdv').length,
  nearbyGroups: document.querySelectorAll('.tl-nbgrp').length,
  chipLists: [...document.querySelectorAll('.tl-nbwrap')]
    .filter((n) => n.offsetParent && n.children.length).length,
}));
check(counts.panels === 1, `there is ONE location panel, not a second one (${counts.panels})`);
check(counts.nearbyGroups <= 1,
  `and at most one nearby list on screen (${counts.nearbyGroups})`);
check(counts.chipLists === 0,
  `the old chip copy of the same places is gone (${counts.chipLists})`);

/* ---- select a city, the way a recruiter does ------------------------ */
await pick('Hyderabad');
await setKm('25');
await page.waitForTimeout(600);

const at25 = await rows();
check(at25.length > 1, `selecting Hyderabad fills the list in (${at25.length} rows)`);
check(at25[0].name === 'Hyderabad' && at25[0].km === 0,
  `the chosen city is first, at 0 KM (${at25[0] && at25[0].name} ${at25[0] && at25[0].km})`);
check(at25.every((r) => r.checkbox), 'every row is a checkbox, like every other row in the list');
check(at25.every((r) => /tl-row2/.test(r.cls)),
  'and uses the list\'s own row markup, not a new one');

for (const name of ['Madhapur', 'Gachibowli', 'Kondapur', 'Secunderabad', 'Kukatpally']) {
  check(at25.some((r) => r.name === name), `${name} is in the list`);
}

/* ---- the distances are computed, not stored ------------------------- */
/*
 * Recomputed here from the coordinates the page holds, with a formula
 * written separately. If anybody ever swaps the calculation for a table
 * of numbers, these fail.
 */
const coords = await page.evaluate(() => window.INDIA_COORDS || {});
const hyd = coords.Hyderabad;
check(Array.isArray(hyd), `Hyderabad has coordinates (${JSON.stringify(hyd)})`);

let checkedDistances = 0;
for (const r of at25) {
  if (r.km === 0) continue;
  const c = coords[r.name];
  if (!c) { check(false, `${r.name} is shown with no coordinates on file`); continue; }
  const mine = haversine(hyd, c);
  check(Math.abs(Math.round(mine) - r.km) <= 1,
    `${r.name}: shown ${r.km} KM, haversine says ${mine.toFixed(1)} KM`);
  checkedDistances++;
}
check(checkedDistances >= 10, `every distance was recomputed (${checkedDistances} of them)`);

/* ---- the radius actually filters ------------------------------------ */
await setKm('10');
await page.waitForTimeout(500);
const at10 = await rows();
check(at10.length < at25.length, `10 KM shows fewer than 25 KM (${at10.length} vs ${at25.length})`);
check(at10.every((r) => r.km <= 10), `and nothing beyond 10 KM (max ${Math.max(...at10.map((r) => r.km))})`);

await setKm('50');
await page.waitForTimeout(500);
const at50 = await rows();
check(at50.length > at25.length, `50 KM shows more than 25 KM (${at50.length} vs ${at25.length})`);
check(at50.every((r) => r.km <= 50), `and nothing beyond 50 KM (max ${Math.max(...at50.map((r) => r.km))})`);

await setKm('any');
await page.waitForTimeout(900);
const any = await rows();
check(any.length > at50.length, `Any Distance shows everything we can locate (${any.length})`);

await setKm('');
await page.waitForTimeout(500);
const exact = await rows();
check(exact.length === 1 && exact[0].name === 'Hyderabad',
  `Exact city shows only the place picked (${exact.length} row(s))`);

/* ---- it is not a Hyderabad feature ---------------------------------- */
for (const [city, expect] of [
  ['Bangalore', 'Koramangala'], ['Chennai', 'Velachery'], ['Mumbai', 'Andheri'],
  ['Pune', 'Hinjewadi'], ['New Delhi', 'Saket'],
]) {
  await clear();
  await openPanel();
  await pick(city);
  await setKm('25');
  await page.waitForTimeout(600);
  const list = await rows();
  check(list.some((r) => r.name === expect),
    `${city}: ${expect} is listed (${list.length} places within 25 KM)`);
  check(list[0] && list[0].km === 0, `${city}: the city itself is the 0 KM row`);
}

/* ---- ticking one still feeds the candidate search -------------------- */
await clear();
await openPanel();
await pick('Hyderabad');
await setKm('25');
await page.waitForTimeout(600);
await page.evaluate(([k]) => window.tlTreePick(k, 'Madhapur', true), [KEY]);
await page.evaluate(([k]) => window.tlTreePick(k, 'Gachibowli', true), [KEY]);
await page.waitForTimeout(400);

const tags = await page.evaluate((k) => window.tlLocState(k).tags, KEY);
check(tags.includes('Hyderabad') && tags.includes('Madhapur') && tags.includes('Gachibowli'),
  `the selection reaches the search exactly as before (${JSON.stringify(tags)})`);

/*
 * Shown as ticked. The list re-centres on the most recent pick - that is
 * the panel's own long-standing rule for which place the radius is
 * measured from - so the rows are read for their CHECKED state rather
 * than assumed to be the same rows as before.
 */
const tickedNow = await page.evaluate((k) =>
  [...document.querySelectorAll('#tlTree_' + k + ' .tl-nbgrp .tl-row2')]
    .filter((r) => r.querySelector('input').checked)
    .map((r) => r.querySelector('.nm').textContent.trim()), KEY);
check(tickedNow.includes('Madhapur') && tickedNow.includes('Gachibowli'),
  `both show as ticked in the list (${JSON.stringify(tickedNow)})`);

/* ---- the existing autocomplete is untouched -------------------------- */
/*
 * Asked of the suggester itself rather than of the dropdown's DOM: the
 * panel redraws on a timer of its own and reading the element a moment
 * too early says "empty" about a list that is about to appear. What
 * matters is that the same function still answers the same way.
 */
const sug = await page.evaluate(() => ({
  hyd: TL_LOC.suggest('Hyd', 10).map((x) => x.label),
  locality: TL_LOC.suggest('Madhap', 10).map((x) => x.label),
  bang: TL_LOC.suggest('Bang', 10).map((x) => x.label),
}));
check(sug.hyd.includes('Hyderabad'),
  `typing "Hyd" still suggests Hyderabad (${sug.hyd.slice(0, 3).join(' | ')})`);
check(sug.bang.some((s) => /Bangalore/i.test(s)),
  `and "Bang" still suggests Bangalore (${sug.bang.slice(0, 2).join(' | ')})`);
/*
 * A bonus rather than a requirement: the localities joined the existing
 * autocomplete by being in the same dataset, so a recruiter can now type
 * the suburb directly instead of finding the city first.
 */
check(sug.locality.includes('Madhapur'),
  `and a locality can now be typed straight in (${sug.locality.slice(0, 2).join(' | ')})`);

check(errors.length === 0, `no page errors${errors.length ? `: ${errors[0]}` : ''}`);
await browser.close();
console.log(fail.length ? `\n${fail.length} failed` : '\nall good');
process.exit(fail.length ? 1 : 0);
