/**
 * The nearby places are listed ONCE, never twice.
 *
 *     node tools/verify-nearby-once.mjs      (needs the dev server on :4323)
 *
 * Two different parts of the location filter drew the same list: the
 * picker panel draws it inside its NEARBY PLACES section, and a strip
 * under the field drew the same towns again as another row of things to
 * tick. So "19 near Tirupati" appeared twice on screen, one above the
 * other, same towns, same distances, both selectable.
 *
 * The panel is where somebody looks for them, so that is the only place
 * they appear now. This counts the VISIBLE nearby lists, because the
 * fault was never that either list was wrong.
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

/** Every visible "N near X / within ... tap to add" list on the page. */
const lists = () => page.evaluate(() => {
  const seen = [];
  document.querySelectorAll('.tl-nb, .tl-nbin').forEach((el) => {
    if (el.hidden || !el.offsetParent) return;
    const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (/tap to add|within/i.test(t)) seen.push(t.slice(0, 60));
  });
  return seen;
});

const whileOpen = await lists();
check(whileOpen.length === 1,
  `with the panel open, the nearby places are listed once (${whileOpen.length}): ${
    whileOpen.join(' || ') || 'none'}`);

await page.evaluate((k) => window.tlTreeDone(k), key);
await page.waitForTimeout(700);

const whileClosed = await lists();
check(whileClosed.length === 0,
  `with the panel closed, no second list is left under the field (${
    whileClosed.length}): ${whileClosed.join(' || ') || 'none'}`);

/* The pick itself survives - closing the panel must not undo it. */
const chip = await page.evaluate((k) => (window.tlLocState(k).tags || []).join(', '), key);
check(/tirupati/i.test(chip), `the place that was picked is still selected (${chip})`);

await page.evaluate((k) => window.tlLocOpen(k), key);
await page.waitForTimeout(700);
const reopened = await lists();
check(reopened.length === 1,
  `reopening the panel shows them once, in the panel (${reopened.length})`);
check(/tirupati/i.test(reopened.join(' ')),
  'and it is the list for the place that was picked');

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
