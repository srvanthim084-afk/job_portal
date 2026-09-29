/**
 * The Nellore list, against the reference.
 *
 *     node tools/verify-nellore-nearby.mjs
 *
 * A recruiter named the places Naukri's Resdex shows within 50 km of
 * Nellore. That is a specific, checkable claim about the dataset -
 * either those mandals and towns are in it with the right coordinates,
 * or they are not - so it is a better test than "returns lots of rows".
 */
import { chromium } from 'playwright';

const BASE = (process.env.TL_URL || 'http://localhost:4323/').replace(/\/$/, '');

/* Exactly as the reference lists them. */
const WANT = ['Nawabpet', 'Kovur', 'Indukurpet', 'Thotapalligudur', 'Penuballi',
  'Kodavalur', 'Vidavalur', 'Venkatachelam', 'Koduru', 'Buchireddypalem',
  'Muthukur', 'Dagadarthi', 'Allur', 'Podalakur', 'Manubolu', 'Bogole',
  'Gudur', 'Chilakur', 'Sydapuram', 'Anumasamudrampeta', 'Chejerla', 'Jaladanki'];

const fold = (v) => String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '');

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

const r = await api('/places/near?km=50&name=Nellore&state=Andhra%20Pradesh');
const have = new Map();
for (const p of r.places || []) if (!have.has(fold(p.name))) have.set(fold(p.name), p);

console.log(`within 50 KM of Nellore: ${r.total} places`
  + ` (${(r.places || []).filter((x) => x.kind === 'ADM3').length} mandals)\n`);

let found = 0;
for (const w of WANT) {
  const hit = have.get(fold(w));
  if (hit) { found++; console.log(`  ok    ${w.padEnd(22)} ${hit.km} KM  [${hit.kind}]`); }
  else console.log(`  MISS  ${w}`);
}
console.log(`\n${found} of ${WANT.length} reference locations present`);

await browser.close();
/* Two absences out of twenty-two would be spelling; a third of them
   missing would mean the dataset is not what it claims to be. */
const ok = found >= WANT.length - 3;
console.log(ok ? 'ok — the dataset matches the reference' : 'FAIL — too many are missing');
process.exit(ok ? 0 : 1);
