/**
 * The nearby places are listed ONCE, never twice.
 *
 *     node tools/verify-nearby-once.mjs      (needs the dev server on :4323)
 *
 * Two different parts of the location filter drew the same list: the
 * picker panel drew it in a NEARBY PLACES section, and a strip under the
 * field drew the same towns again as another row of things to tick. So
 * "19 near Tirupati" appeared twice on screen, one above the other, same
 * towns, same distances, both selectable.
 *
 * THERE IS NO SEPARATE NEARBY SECTION AT ALL NOW. The radius filters the
 * one location list and draws each distance on the row it belongs to, so
 * counting "how many nearby lists are visible" no longer asks anything -
 * the answer is zero however broken the screen is.
 *
 * What this asks instead is the question the complaint was actually
 * about: does any PLACE appear more than once in the panel? That holds
 * whatever the list is made of, and it fails the moment anything starts
 * drawing the same town twice again.
 */
import { chromium } from 'playwright';

const BASE = (process.env.TL_URL || 'http://localhost:4323/').replace(/\/$/, '');
const fail = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`); if (!ok) fail.push(what); };

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
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
await page.waitForTimeout(2000);

const key = await page.evaluate(() => {
  const h = document.querySelector('[id^="tlLoc_"]');
  return h ? h.id.replace('tlLoc_', '') : null;
});
check(!!key, `the location filter is on the page (${key})`);

/* A real place with real neighbours, chosen the way a person does. */
await page.evaluate((k) => {
  window.tlLocOpen(k);
  window.tlTreePick(k, 'Tirupati', true);
}, key);
await page.waitForTimeout(700);

/** How many times each place name appears in the panel. */
const nameCounts = () => page.evaluate((k) => {
  const root = document.getElementById('tlTree_' + k);
  if (!root || !root.classList.contains('on')) return {};
  const n = {};
  root.querySelectorAll('.tl-row2 .nm').forEach((el) => {
    const t = (el.textContent || '').trim();
    if (!t || /^All\b/.test(t)) return;        /* "All - Telangana" is a heading row */
    n[t] = (n[t] || 0) + 1;
  });
  return n;
}, key);

/** Anything that would be a second nearby section. */
const sections = () => page.evaluate((k) => {
  const root = document.getElementById('tlTree_' + k);
  if (!root) return { blocks: 0, near: [] };
  return {
    blocks: root.querySelectorAll('.tl-nb, .tl-nbin, .tl-nbgrp').length,
    near: [...root.querySelectorAll('b')]
      .map((n) => n.textContent.replace(/\s+/g, ' ').trim())
      .filter((t) => /(^|\s)near\s+(?!by\b)\S/i.test(t)),
  };
}, key);

/* A radius, so the places around Tirupati are actually drawn. */
await page.evaluate((k) => window.tlTreeKm(k, '50'), key);
await page.waitForTimeout(700);

const openCounts = await nameCounts();
const dupes = Object.entries(openCounts).filter(([, v]) => v > 1);
const shown = Object.keys(openCounts).length;
check(shown > 1, `with the panel open, the places around Tirupati are listed (${shown})`);
check(dupes.length === 0,
  `and not one of them appears twice (${dupes.map(([n, v]) => n + ' x' + v).join(', ') || 'none does'})`);
check(openCounts.Tirupati === 1,
  `Tirupati itself appears exactly once (${openCounts.Tirupati})`);

const sec = await sections();
check(sec.blocks === 0, `there is no separate nearby block (${sec.blocks})`);
check(sec.near.length === 0, `and no "Near <place>" heading (${JSON.stringify(sec.near)})`);

/* The old shape of this test, kept as the thing it was protecting: no
   second copy of the list anywhere on the PAGE, not just in the panel. */
const lists = () => page.evaluate(() => {
  const seen = [];
  document.querySelectorAll('.tl-nb, .tl-nbin, .tl-nbgrp').forEach((el) => {
    if (el.hidden || !el.offsetParent) return;
    seen.push((el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60));
  });
  return seen;
});
const whileOpen = await lists();
check(whileOpen.length === 0,
  `no nearby list is drawn beside the panel (${whileOpen.join(' || ') || 'none'})`);

await page.evaluate((k) => window.tlTreeDone(k), key);
await page.waitForTimeout(700);

const whileClosed = await lists();
check(whileClosed.length === 0,
  `with the panel closed, nothing is left under the field (${
    whileClosed.length}): ${whileClosed.join(' || ') || 'none'}`);

/* The pick itself survives - closing the panel must not undo it. */
const chip = await page.evaluate((k) => (window.tlLocState(k).tags || []).join(', '), key);
check(/tirupati/i.test(chip), `the place that was picked is still selected (${chip})`);

await page.evaluate((k) => window.tlLocOpen(k), key);
await page.waitForTimeout(700);
const reopenedCounts = await nameCounts();
const reopenedDupes = Object.entries(reopenedCounts).filter(([, v]) => v > 1);
check(Object.keys(reopenedCounts).length > 1,
  `reopening the panel lists them again (${Object.keys(reopenedCounts).length})`);
check(reopenedDupes.length === 0,
  `still none of them twice (${reopenedDupes.map(([n, v]) => n + ' x' + v).join(', ') || 'none'})`);
check(reopenedCounts.Tirupati === 1,
  'and it is still the list measured from the place that was picked');

/* Back to Exact city, so the state/district checks below see the whole
   list rather than the 50 KM slice of it. */
await page.evaluate((k) => { window.tlLocState(k).km = ''; window.tlLocRefresh(k); }, key);
await page.waitForTimeout(500);

/* ---- the states, and what a click does now ------------------------- */
/*
 * EVERY STATE IS OPEN WHEN THE FILTER OPENS. A recruiter should not have
 * to click Telangana to find out which districts are in it, so the
 * districts are there from the start and the chevron is for putting one
 * out of the way rather than for revealing it.
 *
 * Which also means it is not an accordion: with everything open,
 * closing the others on a click would hide most of the list the moment
 * somebody touched it.
 */
const openStates = () => page.evaluate((k) =>
  document.querySelectorAll('#tlTree_' + k + ' .tl-dists').length, key);

const atStart = await openStates();
check(atStart >= 36, `every state shows its districts from the start (${atStart})`);

await page.evaluate((k) => window.tlTreeExpand(k, 'Delhi'), key);
await page.waitForTimeout(400);
const afterOne = await openStates();
check(afterOne === atStart - 1,
  `clicking Delhi folds that one away (${atStart} -> ${afterOne})`);

await page.evaluate((k) => window.tlTreeExpand(k, 'Kerala'), key);
await page.waitForTimeout(400);
check(await openStates() === atStart - 2,
  'and clicking Kerala folds that one too, leaving the rest alone');

await page.evaluate((k) => window.tlTreeExpand(k, 'Delhi'), key);
await page.waitForTimeout(400);
check(await openStates() === atStart - 1, 'clicking a folded one opens it again');

await page.evaluate((k) => window.tlTreeAll(k, false), key);
await page.waitForTimeout(400);
check(await openStates() === 0, 'Collapse all folds every one of them');

await page.evaluate((k) => window.tlTreeAll(k, true), key);
await page.waitForTimeout(400);
check(await openStates() >= 36, 'and Expand all brings them back');

check(errors.length === 0, `no page errors${errors.length ? `: ${errors[0]}` : ''}`);
await browser.close();
console.log(fail.length ? `\n${fail.length} failed` : '\nall good');
process.exit(fail.length ? 1 : 0);
