/**
 * Phone notifications in a real browser, iPhone included.
 *
 *   iPhone Safari (a tab)  -> tick "Phone notifications" in Save this
 *                             search -> the "Add TeamLink to your Home
 *                             Screen" sheet appears, and the permission
 *                             prompt is NEVER called
 *   iPhone Home Screen app -> "Turn on notifications" on Job Alerts ->
 *                             tap -> a push_subscriptions row exists
 *
 * Nothing real is called. The browser's push service is stubbed to hand
 * back a subscription whose endpoint is a local mock, which the instance
 * must accept: start it with PUSH_EXTRA_HOSTS=127.0.0.1:<MOCK_PORT> (and
 * VAPID keys), isolated as in the project notes. Refuses :4323.
 *
 *   TL_URL=http://127.0.0.1:4415/ MOCK_PORT=9870 node tools/verify-push.mjs
 */
import { chromium, devices } from 'playwright';

const BASE = (process.env.TL_URL || 'http://127.0.0.1:4415/').replace(/\/?$/, '/');
const MOCK_PORT = Number(process.env.MOCK_PORT || 9870);
const url = new URL(BASE);
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.port === '4323') {
  console.error(`Refusing to run against ${BASE}: this creates accounts. Use an isolated instance.`);
  process.exit(2);
}

let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  PASS  ${name}`); }
  catch (e) { console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n')[0]}`); failed += 1; }
};
const must = (c, m) => { if (!c) throw new Error(m); };
const stamp = Date.now().toString(36);
/* Playwright's iPhone profile says iOS 15, which is too old for web push;
   the size and touch screen are kept, the browser is a current one. */
const iphone = { ...devices['iPhone 13'], userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1' };

const browser = await chromium.launch();

async function signedInPage(ctx, who) {
  const page = await ctx.newPage();
  await page.goto(BASE + '#/');
  await page.waitForFunction(() => window.TL && TL.ready === true, null, { timeout: 30000 });
  const r = await page.evaluate(async (b) => {
    try { await TL.api.post('/auth/register', b); return 'ok'; } catch (e) { return e.message; }
  }, { name: `Push ${who}`, email: `push.${who}.${stamp}@tl-verify.test`, password: `Push${stamp}9`,
       preferredLocation: 'Hyderabad', expectedCtc: 4, noticePeriod: 'Immediate', preferredWorkModes: ['Hybrid'] });
  must(r === 'ok', `register: ${r}`);
  return page;
}
const wizardAway = (page) => page.evaluate(() => { const b = document.querySelector('.tlpo-ov .tlpo-btn.ghost'); if (b) b.click(); });

console.log(`\nphone notifications  (${BASE})`);

/* ---------------- iPhone Safari, not the Home Screen app ---------------- */
const safari = await browser.newContext({ ...iphone });
await safari.addInitScript(() => {
  window.__permissionCalls = 0;
  /* A Safari tab on iPhone has no PushManager at all. */
  try { delete window.PushManager; } catch (e) {}
  if (window.Notification) {
    const real = Notification.requestPermission;
    Notification.requestPermission = function () { window.__permissionCalls += 1; return real.apply(this, arguments); };
  }
});
const p1 = await signedInPage(safari, 'safari');

await check('iPhone Safari is recognised as a browser tab, not the app', async () => {
  must(await p1.evaluate(() => TLPush.env()) === 'ios-browser', 'environment');
});

await check('ticking Phone notifications shows the Home Screen sheet, and no permission prompt', async () => {
  await p1.goto(BASE + '?v=' + stamp + '#/candidate/search');
  await p1.waitForFunction(() => window.TL && TL.ready === true, null, { timeout: 30000 });
  await p1.waitForTimeout(1500);
  await wizardAway(p1);
  await p1.evaluate(() => { STATE.rj.q = 'nurse'; render(); });
  await p1.waitForTimeout(500);
  await p1.evaluate(() => tlssSaveCurrent());
  await p1.waitForSelector('input[name="tlssCh"][value="push"]', { timeout: 5000 });
  await p1.check('input[name="tlssCh"][value="push"]');
  await p1.click('#tlssSave');
  await p1.waitForTimeout(1500);
  const sheet = await p1.evaluate(() => {
    const h = Array.from(document.querySelectorAll('h3')).find((x) => /Home Screen/.test(x.textContent) && x.offsetParent);
    if (!h) return { title: '', steps: 0 };
    const box = h.closest('.fcr-jd-head').parentElement;
    return { title: h.textContent, steps: box.querySelectorAll('svg').length };
  });
  const title = sheet.title, steps = sheet.steps;
  must(/Add TeamLink to your Home Screen/.test(title), `the sheet reads "${title}"`);
  must(steps === 3, `three drawn step icons, got ${steps}`);
  must(await p1.evaluate(() => window.__permissionCalls) === 0, 'requestPermission was called');
  const saved = await p1.evaluate(() => TL.api.get('/saved-searches').then((o) => o.savedSearches[0]));
  must(saved && saved.channels.includes('push'), 'the search was saved with phone notifications');
});

await check('Job Alerts says it needs the Home Screen install, with a reminder', async () => {
  await p1.evaluate(() => { if (typeof fcrCloseModal === 'function') fcrCloseModal(); location.hash = '#/candidate/alerts'; });
  await p1.waitForTimeout(1500);
  const card = await p1.evaluate(() => (document.getElementById('tlPushCard') || {}).innerText || '');
  must(/Needs Home Screen install/.test(card), card.replace(/\s+/g, ' ').slice(0, 120));
  must(/Add to Home Screen to finish/.test(card), 'the reminder chip');
});
await safari.close();

/* ---------------- iPhone, opened from the Home Screen ---------------- */
const app = await browser.newContext({ ...iphone });
await app.grantPermissions(['notifications'], { origin: url.origin });
await app.addInitScript((mockPort) => {
  Object.defineProperty(Navigator.prototype, 'standalone', { get: () => true, configurable: true });
  /* Headless Chromium reports notifications as blocked whatever is
     granted; here the prompt is answered "Allow", as a person would. */
  let perm = 'default';
  window.__permissionCalls = 0;
  Object.defineProperty(Notification, 'permission', { get: () => perm, configurable: true });
  Notification.requestPermission = function () { window.__permissionCalls += 1; perm = 'granted'; return Promise.resolve(perm); };
  /* The browser's push service, stubbed: a subscription whose endpoint is
     the local mock, with real P-256 keys made here. */
  if (window.PushManager) {
    let made = null;
    PushManager.prototype.getSubscription = function () { return Promise.resolve(made); };
    PushManager.prototype.subscribe = async function () {
      const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
      const rawKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
      const b64u = (a) => btoa(String.fromCharCode.apply(null, Array.from(a))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const json = { endpoint: `http://127.0.0.1:${mockPort}/apple/${Math.random().toString(36).slice(2)}`,
        keys: { p256dh: b64u(rawKey), auth: b64u(crypto.getRandomValues(new Uint8Array(16))) } };
      made = { endpoint: json.endpoint, toJSON: () => json };
      return made;
    };
  }
}, MOCK_PORT);
const p2 = await signedInPage(app, 'app');

await check('opened from the Home Screen it is the app', async () => {
  must(await p2.evaluate(() => TLPush.env()) === 'ios-standalone', 'environment');
});

await check('"Turn on notifications" is on Job Alerts, and the tap creates a subscription', async () => {
  await p2.goto(BASE + '?v=' + stamp + '#/candidate/alerts');
  await p2.waitForFunction(() => window.TL && TL.ready === true, null, { timeout: 30000 });
  await p2.waitForTimeout(1800);
  await wizardAway(p2);
  await p2.evaluate(() => render());
  await p2.waitForTimeout(800);
  const btn = p2.locator('#tlPushCard button', { hasText: 'Turn on notifications' });
  must(await btn.count() === 1, 'the button is not there: ' + (await p2.evaluate(() => { const c = document.getElementById('tlPushCard'); return c ? c.innerText.split(String.fromCharCode(10)).join(' | ').slice(0, 160) : 'no card; hash ' + location.hash; })));
  await btn.click();
  await p2.waitForTimeout(2500);
  const subs = await p2.evaluate(() => TL.api.get('/push/subscriptions').then((o) => o.subscriptions));
  must(await p2.evaluate(() => window.__permissionCalls) === 1, 'the permission prompt is asked once, from the tap');
  must(subs.length === 1, `expected one device, got ${subs.length}`);
  must(subs[0].platform === 'ios' && subs[0].device === 'iPhone', JSON.stringify(subs[0]));
  const card = await p2.evaluate(() => document.getElementById('tlPushCard').innerText);
  must(/Status: On/.test(card), 'status shows On: ' + card.split(String.fromCharCode(10)).join(' | ').slice(0, 160));
});
await app.close();

await browser.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
