/**
 * getPushEnvironment() (web/teamlink-push.js) against the browsers it has
 * to tell apart. The file is loaded as it ships; only navigator and
 * window are mocked.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/* Run the shipped file in a sandbox with no window and no document - it
   exports its pure functions and stops before touching the page. */
const sandbox = { module: { exports: {} }, globalThis: {} };
vm.createContext(sandbox);
vm.runInContext(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../web/teamlink-push.js'), 'utf8'), sandbox);
const { getPushEnvironment, isInAppBrowser } = sandbox.module.exports;

const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  ipadDesktop: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
  ios160: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
  instagram: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 321.0.0.13.112',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  chrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};

/** A browser: what it says it is, and what it actually has. */
function browser({ ua, standalone = false, touch = 0, push = true, sw = true, displayStandalone = false }) {
  const navigator = { userAgent: ua, maxTouchPoints: touch };
  if (sw) navigator.serviceWorker = {};
  if (standalone) navigator.standalone = true;
  const window = { matchMedia: (q) => ({ matches: displayStandalone && /standalone/.test(q) }) };
  if (push) { window.PushManager = function PushManager() {}; window.Notification = function Notification() {}; }
  return { navigator, window };
}

test('iPhone Safari (a tab, not the Home Screen app)', () => {
  /* Safari tabs on iOS have no PushManager at all. */
  assert.equal(getPushEnvironment(browser({ ua: UA.iphone, touch: 5, push: false })), 'ios-browser');
});

test('iPhone, opened from the Home Screen', () => {
  assert.equal(getPushEnvironment(browser({ ua: UA.iphone, touch: 5, standalone: true })), 'ios-standalone');
  assert.equal(getPushEnvironment(browser({ ua: UA.iphone, touch: 5, displayStandalone: true })), 'ios-standalone',
    'display-mode: standalone counts too');
});

test('iPad in desktop mode (reports itself as a Mac, has a touch screen)', () => {
  assert.equal(getPushEnvironment(browser({ ua: UA.ipadDesktop, touch: 5, push: false })), 'ios-browser');
  assert.equal(getPushEnvironment(browser({ ua: UA.ipadDesktop, touch: 5, standalone: true })), 'ios-standalone');
});

test('iOS 16.0 - too old, even from the Home Screen', () => {
  assert.equal(getPushEnvironment(browser({ ua: UA.ios160, touch: 5, push: false })), 'ios-too-old');
  assert.equal(getPushEnvironment(browser({ ua: UA.ios160, touch: 5, standalone: true, push: false })), 'ios-too-old');
});

test('an iOS in-app browser (Instagram)', () => {
  const b = browser({ ua: UA.instagram, touch: 5, push: false });
  assert.equal(getPushEnvironment(b), 'ios-browser');
  assert.equal(isInAppBrowser(b.navigator), true, 'and it is told to open Safari first');
  assert.equal(isInAppBrowser(browser({ ua: UA.iphone }).navigator), false);
});

test('Android Chrome', () => {
  assert.equal(getPushEnvironment(browser({ ua: UA.android, touch: 5 })), 'android-or-desktop');
});

test('desktop Chrome, and a desktop browser with no push at all', () => {
  assert.equal(getPushEnvironment(browser({ ua: UA.chrome })), 'android-or-desktop');
  assert.equal(getPushEnvironment(browser({ ua: UA.chrome, push: false })), 'unsupported');
  assert.equal(getPushEnvironment(browser({ ua: UA.chrome, sw: false })), 'unsupported');
});

test('a real Mac (no touch screen) is a desktop, not an iPad', () => {
  assert.equal(getPushEnvironment(browser({ ua: UA.ipadDesktop, touch: 0 })), 'android-or-desktop');
});
