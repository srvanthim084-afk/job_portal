/**
 * The "nothing within X KM" message is a fallback, not the experience.
 *
 *     node tools/verify-nearby-fallback-is-rare.mjs
 *
 * The Near by panel tells the truth when a radius finds nothing, and
 * offers the distance that would reach the closest place. That is good
 * behaviour and stays. What made it a problem was how often it fired:
 * the coordinate list held 86 places, so it was the ordinary answer for
 * densely populated districts - Eluru, East Godavari - rather than the
 * exception for remote ones.
 *
 * This measures how often it would fire, across every district the
 * product offers, at the radius a recruiter is most likely to try.
 */
import { chromium } from 'playwright';

const BASE = (process.env.TL_URL || 'http://localhost:4323/').replace(/\/$/, '');
const KM = Number(process.env.KM || 25);

const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
await page.goto(`${BASE}/`, { waitUntil: 'load' });
await page.waitForFunction(() => window.TL && window.TL.ready === true, { timeout: 25000 });
await page.evaluate(() => window.TL.api.post('/auth/login', {
  email: 'teamlinkmed001@tmlink.in', password: 'Teamlink@2026', role: 'recruiter',
}));
const api = async (p) => {
  const r = await page.evaluate((pp) => window.TL.api.get(pp)
    .then((v) => ({ ok: 1, v }), (e) => ({ ok: 0, m: e.message })), p);
  if (!r.ok) throw new Error(r.m);
  return r.v;
};

const GEO = await page.evaluate(() => window.INDIA_GEO || {});
const rows = [];
for (const st of Object.keys(GEO)) {
  for (const d of GEO[st] || []) {
    let r;
    try {
      r = await api(`/places/near?km=${KM}&name=${encodeURIComponent(d)}&state=${encodeURIComponent(st)}`);
    } catch { rows.push({ d, st, n: -1 }); continue; }
    rows.push({ d, st, n: r.found ? r.total : -1 });
  }
}

const unlocatable = rows.filter((x) => x.n < 0);
/* The panel shows the fallback when the radius contains nothing but the
   anchor itself. */
const fallback = rows.filter((x) => x.n >= 0 && x.n <= 1);
const fine = rows.filter((x) => x.n > 1);
const pct = (n) => `${((n / rows.length) * 100).toFixed(1)}%`;

console.log(`districts                     : ${rows.length}`);
console.log(`at ${KM} KM, would show the fallback: ${fallback.length} (${pct(fallback.length)})`);
console.log(`cannot be located at all      : ${unlocatable.length} (${pct(unlocatable.length)})`);
console.log(`show a real list              : ${fine.length} (${pct(fine.length)})`);

const sorted = fine.slice().sort((a, b) => a.n - b.n);
console.log(`\nmedian district: ${sorted[Math.floor(sorted.length / 2)].n} places within ${KM} KM`);
console.log(`thinnest that still works:`);
sorted.slice(0, 6).forEach((x) => console.log(`   ${String(x.n).padStart(4)}  ${x.d} (${x.st})`));

if (fallback.length) {
  console.log(`\nthe fallback would appear for:`);
  fallback.forEach((x) => console.log(`   ${x.d} (${x.st})`));
}

await browser.close();
/* A fallback for one district in twenty is a fallback. For one in three
   it is the product. */
const tooOften = (fallback.length + unlocatable.length) / rows.length > 0.05;
console.log(tooOften
  ? `\nFAIL — it would appear for more than 5% of districts`
  : `\nok — the fallback is the exception, not the experience`);
process.exit(tooOften ? 1 : 0);
