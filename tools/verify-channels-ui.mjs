/**
 * Every channel a candidate hears from us on, on the recruiter's screen.
 *
 * Two gaps this closes, and one claim it refuses to let the screen make.
 *
 * Email had a settings page; SMS, WhatsApp and voice did not. All four
 * already send at every stage from the same dispatch, but with no
 * credentials they record `not_configured` - which reads like a fault
 * rather than a setting nobody filled in. "She got no SMS" had no answer
 * anywhere a recruiter could reach.
 *
 * And the calling agent's configuration was admin-only, so the recruiter
 * placing the calls could not see what it would say or why no phone rang.
 *
 * What this holds to:
 *
 *   - the tab is added to the EXISTING Email / SMS / IVR screen; no new
 *     module, no new menu, and the prototype's own tabs still work
 *   - all four channels are listed, with what each one still needs
 *   - no API key, token or password field exists anywhere on it
 *   - the built-in driver is never reported as a live carrier
 *   - the screen is read-only, because /recruiter/* is unreachable for
 *     an admin: a Save button nobody can open is worse than none
 *   - the settings route still refuses anybody but an admin
 *
 *   node tools/verify-channels-ui.mjs      (needs npm run dev on :4323)
 */
import { chromium } from 'playwright';

const BASE = (process.env.TL_URL || 'http://localhost:4323/').replace(/\/$/, '');
const PASSWORD = process.env.TL_PASSWORD || 'TeamLink@2026';

let failed = 0;
// Set while a check deliberately provokes a refusal, so the browser
// console entry it produces is not counted as a fault.
let expectingRefusal = false;
const check = async (name, fn) => {
  try { await fn(); console.log(`  PASS  ${name}`); }
  catch (e) { console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n')[0]}`); failed++; }
};
const must = (c, m) => { if (!c) throw new Error(m); };

const browser = await chromium.launch();
const errors = [];

async function signIn(email, role) {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1100 } })).newPage();
  page.on('pageerror', (e) => errors.push(`${role}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (expectingRefusal && /40[13]/.test(m.text())) return;
    errors.push(`${role}: ${m.text()}`);
  });
  await page.goto(`${BASE}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.TL && window.TL.ready === true, { timeout: 25000 });

  const api = async (m, p, b) => {
    const r = await page.evaluate(([mm, pp, bb]) =>
      window.TL.api[mm](pp, bb).then((v) => ({ ok: 1, v }), (e) => ({ ok: 0, c: e.code, m: e.message })),
      [m, p, b]);
    if (!r.ok) { const err = new Error(`${r.c || 'FAILED'}: ${r.m || ''}`); err.code = r.c; throw err; }
    return r.v;
  };

  await api('post', '/auth/login', { email, password: PASSWORD, role });
  await page.evaluate(() => window.TL.refresh());
  await page.waitForTimeout(700);
  return { page, api };
}

const open = async (who, tab) => {
  await who.page.evaluate((t) => { location.hash = `#/recruiter/comm?tab=${t}`; }, tab);
  await who.page.waitForTimeout(tab === 'channels' ? 2000 : 900);
};

/* ------------------------------------------------------------------ *
 * 1. the tab, on the screen that already exists
 * ------------------------------------------------------------------ */
console.log('\nthe tab, on the screen that already exists');

const rec = await signIn('recruiter@teamlink.com', 'recruiter');

await check("the prototype's own tabs are all still there", async () => {
  await open(rec, 'ivr');
  const tabs = await rec.page.$$eval('.tws-tab', (ns) => ns.map((n) => n.textContent.trim()));
  for (const want of ['Email Templates', 'Emails Dashboard', 'SMS Templates',
                      'Verified SMS', 'IVR Templates']) {
    must(tabs.indexOf(want) >= 0, `"${want}" is gone — ${tabs.join(', ')}`);
  }
});

await check('one tab is added, and no new menu or module', async () => {
  const tabs = await rec.page.$$eval('.tws-tab', (ns) => ns.map((n) => n.textContent.trim()));
  must(tabs.length === 6, `${tabs.length} tabs: ${tabs.join(', ')}`);
  must(/SMS \/ WhatsApp \/ AI Calling/.test(tabs[5]), `the new tab reads "${tabs[5]}"`);
});

await check('the IVR template list is untouched behind it', async () => {
  const has = await rec.page.$$eval('table.data thead th', (ns) => ns.map((n) => n.textContent.trim()));
  must(has.length >= 3, `the IVR table is gone: ${has.join(', ')}`);
});

/* ------------------------------------------------------------------ *
 * 2. all four channels
 * ------------------------------------------------------------------ */
console.log('\nall four channels');

await check('the tab opens and names every channel', async () => {
  await open(rec, 'channels');
  const on = await rec.page.$$eval('.tws-tab.on', (ns) => ns.map((n) => n.textContent.trim()));
  must(on.length === 1 && /AI Calling/.test(on[0]), `active: ${on.join(', ') || 'none'}`);

  const text = await rec.page.$eval('#tlChannels', (n) => n.innerText);
  for (const want of ['Email', 'SMS', 'WhatsApp', 'Voice call']) {
    must(text.indexOf(want) >= 0, `${want} is not listed`);
  }
});

await check('an unconfigured channel names what it still needs', async () => {
  const text = await rec.page.$eval('#tlChannels', (n) => n.innerText);
  // Names, so somebody can act. Never values.
  must(/SMS_API_KEY/.test(text), 'the SMS channel does not say what is missing');
  must(/WHATSAPP_/.test(text), 'the WhatsApp channel does not say what is missing');
});

await check('it says these already send, rather than implying they are unbuilt', async () => {
  const text = await rec.page.$eval('#tlChannels', (n) => n.innerText);
  must(/already send at every stage/i.test(text),
    'nothing tells the recruiter the channels are wired and only need credentials');
});

/* ------------------------------------------------------------------ *
 * 3. no secret is ever on the page
 * ------------------------------------------------------------------ */
console.log('\nno secret is ever on the page');

await check('there is no API key, token or password field anywhere', async () => {
  const bad = await rec.page.$$eval('#tlChannels input, #tlChannels textarea', (ns) =>
    ns.filter((n) => /key|token|secret|password|auth/i.test(
      `${n.id} ${n.name} ${n.placeholder || ''}`)).map((n) => n.id || n.name));
  must(bad.length === 0, `credential fields on screen: ${bad.join(', ')}`);
});

await check('no credential VALUE appears in the markup', async () => {
  const html = await rec.page.$eval('#tlChannels', (n) => n.innerHTML);
  // The public key is the one secret-shaped value this deployment has.
  must(!/k7RyMZ/.test(html), 'a provider key is rendered into the page');
  must(!/accessToken|privateKey|apiKey"\s*:/.test(html), 'a credential field is rendered');
});

/* ------------------------------------------------------------------ *
 * 4. the claim the screen must not make
 * ------------------------------------------------------------------ */
console.log('\nwhat the screen may claim about calling');

await check('the built-in driver is not reported as a live carrier', async () => {
  const t = await rec.api('get', '/ai-calling/status');
  const tel = t.telephony || {};
  const text = await rec.page.$eval('#tlChannels', (n) => n.innerText);

  if (tel.simulated) {
    must(/Rehearsal only/i.test(text),
      'the simulator is on, but the screen does not say so');
    must(!/Calls are live/i.test(text),
      'the screen claims calls are live while nothing is dialled');
  } else if (tel.configured && tel.real) {
    must(/Calls are live/i.test(text), 'a live carrier is not reported as live');
  }
});

await check('the API itself separates "usable" from "a phone rings"', async () => {
  const tel = (await rec.api('get', '/ai-calling/status')).telephony || {};
  must(typeof tel.real === 'boolean', 'the status has no `real` flag');
  must(tel.simulated !== tel.real || tel.configured === false,
    'simulated and real disagree');
});

/* ------------------------------------------------------------------ *
 * 5. who may change it
 * ------------------------------------------------------------------ */
console.log('\nwho may change it');

await check('the screen is read-only, and says who can change it', async () => {
  // Not a permission check - a truthfulness one. The prototype sends
  // anybody who is not a recruiter from /recruiter/* to the recruiter
  // login, so an admin cannot open this screen at all. An edit control
  // here would be one nobody could ever use.
  const inputs = await rec.page.$$('#tlChannels input, #tlChannels textarea, #tlChannels select');
  must(inputs.length === 0, `${inputs.length} editable field(s) on a read-only screen`);
  const save = await rec.page.$$('#tlChannels button');
  must(save.length === 0, 'the screen offers a control it cannot honour');

  const text = await rec.page.$eval('#tlChannels', (n) => n.innerText);
  must(/administrator changes them/i.test(text), 'nothing says who can change these');
});

await check('an admin genuinely cannot reach this screen', async () => {
  const admin = await signIn('admin@teamlink.com', 'admin');
  await open(admin, 'channels');
  const hash = await admin.page.evaluate(() => location.hash);
  must(/login/.test(hash),
    `an admin reached ${hash} — the read-only screen should then offer editing`);
});

await check('the settings route refuses a recruiter', async () => {
  // Deliberate: the 403 below is the point, so the console it writes to
  // is not evidence of a fault.
  expectingRefusal = true;
  let code = null;
  try { await rec.api('patch', '/ai-calling/settings', { agentName: 'Nope' }); }
  catch (e) { code = e.code; }
  expectingRefusal = false;
  must(code === 'FORBIDDEN' || code === 'UNAUTHORIZED',
    `a recruiter got ${code || 'through'}`);
});

/* ------------------------------------------------------------------ *
 * 6. nothing broken on the way
 * ------------------------------------------------------------------ */
console.log('\nnothing broken on the way');

await check('no console error on any of it', async () => {
  const real = errors.filter((e) => !/favicon|ResizeObserver/i.test(e));
  must(real.length === 0, real.slice(0, 2).join(' | '));
});

await browser.close();
console.log(failed
  ? `\n  ${failed} FAILED\n`
  : '\n  CHANNELS VERIFIED — four channels on the recruiter\'s own screen, no secret on it\n');
process.exitCode = failed ? 1 : 0;
