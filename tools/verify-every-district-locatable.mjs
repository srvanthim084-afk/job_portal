/**
 * Every district the UI offers can be measured from.
 *
 *     node tools/verify-every-district-locatable.mjs
 *
 * The location panel's one hard requirement: a recruiter who ticks a
 * district gets the places around it. That failed for 690 of 776
 * districts - eighty-nine per cent - because the coordinate list in the
 * page held 86 places and none of them were districts. The panel said so
 * honestly ("no coordinates for anywhere near Anjaw") and it read as a
 * broken feature.
 *
 * This asks the gazetteer for every district in the product, and fails
 * if any cannot be located or has nothing around it.
 */
import { chromium } from 'playwright';

const BASE = (process.env.TL_URL || 'http://localhost:4323/').replace(/\/$/, '');
const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
await page.goto(`${BASE}/`, { waitUntil: 'load' });
await page.waitForFunction(() => window.TL && window.TL.ready === true, { timeout: 25000 });

const api = async (p) => {
  const r = await page.evaluate((pp) => window.TL.api.get(pp)
    .then((v) => ({ ok: 1, v }), (e) => ({ ok: 0, m: e.message })), p);
  if (!r.ok) throw new Error(r.m);
  return r.v;
};

await page.evaluate(() => window.TL.api.post('/auth/login', {
  email: 'teamlinkmed001@tmlink.in', password: 'Teamlink@2026', role: 'recruiter',
}));

const GEO = await page.evaluate(() => window.INDIA_GEO || {});
const states = Object.keys(GEO);

const unlocatable = [];
const empty = [];
let checked = 0;
let totalNear = 0;

for (const st of states) {
  for (const d of GEO[st] || []) {
    checked++;
    let r;
    try {
      r = await api(`/places/near?km=50&name=${encodeURIComponent(d)}&state=${encodeURIComponent(st)}`);
    } catch (e) { unlocatable.push(`${d} (${st}) — ${e.message}`); continue; }
    if (!r.found) { unlocatable.push(`${d} (${st})`); continue; }
    if (!r.total) { empty.push(`${d} (${st})`); continue; }
    totalNear += r.total;
  }
}

console.log(`districts checked            : ${checked}`);
console.log(`could NOT be located         : ${unlocatable.length}`);
console.log(`located but nothing within 50: ${empty.length}`);
console.log(`average places within 50 km  : ${Math.round(totalNear / Math.max(1, checked - unlocatable.length))}`);
if (unlocatable.length) {
  console.log('\nunlocatable:');
  unlocatable.slice(0, 25).forEach((x) => console.log('   ' + x));
  if (unlocatable.length > 25) console.log(`   … and ${unlocatable.length - 25} more`);
}
if (empty.length) {
  console.log('\nlocated but empty at 50 km:');
  empty.slice(0, 15).forEach((x) => console.log('   ' + x));
}
await browser.close();
const bad = unlocatable.length + empty.length;
console.log(bad ? `\n${bad} district(s) FAILED` : '\nevery district in the product can be measured from');
process.exit(bad ? 1 : 0);
