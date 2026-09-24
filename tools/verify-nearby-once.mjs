/**
 * The nearby places are listed ONCE, never twice.
 *
 *     node tools/verify-nearby-once.mjs      (needs the dev server on :4323)
 *
 * Two different parts of the location filter draw the same list: the
 * picker panel draws it inside itself, and a strip under the field draws
 * it for when the panel is closed - picking a place closes the picker,
 * and without the strip the towns around your choice vanished the moment
 * you chose one.
 *
 * Both were drawing at the same time, so "19 near Tirupati" appeared
 * twice on screen, one above the other, same towns, same distances. This
 * asserts the count of visible nearby lists is exactly one in each
 * state, which is the thing that was wrong - not that either one renders.
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
check(whileClosed.length === 1,
  `with the panel closed, they are still listed once (${whileClosed.length}): ${
    whileClosed.join(' || ') || 'none'}`);
check(/tirupati/i.test(whileClosed.join(' ')),
  'and it is still the list for the place that was picked');

await page.evaluate((k) => window.tlLocOpen(k), key);
await page.waitForTimeout(700);
const reopened = await lists();
check(reopened.length === 1,
  `reopening the panel does not bring the second one back (${reopened.length})`);

check(errors.length === 0, `no page errors${errors.length ? `: ${errors[0]}` : ''}`);
await browser.close();
console.log(fail.length ? `\n${fail.length} failed` : '\nall good');
process.exit(fail.length ? 1 : 0);
