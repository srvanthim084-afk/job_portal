/*
 * TeamLink — phone notifications (Web Push), iPhone included.
 *
 * WHERE PUSH WORKS
 *   Android / desktop   any modern browser: ask, subscribe, done.
 *   iPhone / iPad       ONLY a site added to the Home Screen (iOS/iPadOS
 *                       16.4+), opened from that icon, and only when the
 *                       permission is asked from a direct tap. A Safari tab
 *                       cannot receive push at all - so there the candidate
 *                       is shown how to add TeamLink to the Home Screen,
 *                       and until then alerts go by SMS / WhatsApp / email
 *                       (the server falls back on its own).
 *
 * getPushEnvironment() decides which of those this is:
 *   'ios-browser' | 'ios-standalone' | 'ios-too-old' |
 *   'android-or-desktop' | 'unsupported'
 *
 * Nothing here asks for permission on its own: Notification.requestPermission
 * is only ever called inside a click handler.
 */
(function (root) {
  'use strict';

  /* ------------------------------------------------------------------ *
   * environment
   * ------------------------------------------------------------------ */
  function iosVersion(ua) {
    var m = /OS (\d+)[_.](\d+)/.exec(ua) || /Version\/(\d+)\.(\d+)/.exec(ua);
    return m ? [Number(m[1]), Number(m[2])] : null;
  }
  function isIOS(nav) {
    var ua = String((nav && nav.userAgent) || '');
    /* iPadOS reports itself as a Mac; the touch screen gives it away. */
    return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && Number(nav.maxTouchPoints || 0) > 1);
  }
  /** Instagram, Facebook, WhatsApp and similar built-in browsers. */
  function isInAppBrowser(nav) {
    var ua = String((nav && nav.userAgent) || '');
    return /FBAN|FBAV|FB_IAB|Instagram|WhatsApp|Line\/|LinkedInApp|Snapchat|Twitter/i.test(ua);
  }

  function getPushEnvironment(ctx) {
    ctx = ctx || {};
    var nav = ctx.navigator || (typeof navigator !== 'undefined' ? navigator : {});
    var win = ctx.window || (typeof window !== 'undefined' ? window : {});
    var hasSW = !!nav && 'serviceWorker' in nav;
    var hasPM = !!win.PushManager;
    var hasN = !!win.Notification;
    var ua = String(nav.userAgent || '');

    if (isIOS(nav)) {
      var v = iosVersion(ua);
      if (v && (v[0] < 16 || (v[0] === 16 && v[1] < 4))) return 'ios-too-old';
      var standalone = nav.standalone === true
        || !!(win.matchMedia && win.matchMedia('(display-mode: standalone)').matches);
      if (!standalone) return 'ios-browser';
      /* Opened from the Home Screen but no push support: an old iOS. */
      if (!hasSW || !hasPM || !hasN) return 'ios-too-old';
      return 'ios-standalone';
    }
    if (!hasSW || !hasPM || !hasN) return 'unsupported';
    return 'android-or-desktop';
  }

  var api = { getPushEnvironment: getPushEnvironment, isInAppBrowser: isInAppBrowser, isIOS: isIOS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.TLPush = api;
  if (typeof document === 'undefined') return;      // loaded by a test, not a page

  /* ------------------------------------------------------------------ *
   * the page
   * ------------------------------------------------------------------ */
  var P = { config: null, devices: null, here: null, busy: false, deferredInstall: null, msg: '' };
  var FLAG = 'tlpush_a2hs_shown_v1';
  var h = function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  };
  var say = function (m, i) { if (typeof window.toast === 'function') toast(m, i || '🔔'); };
  var rerender = function () { if (typeof window.render === 'function') render(); };
  var isCand = function () { return !!(window.STATE && STATE.session && STATE.session.role === 'candidate'); };
  var env = function () { return getPushEnvironment(); };
  var flagGet = function () { try { return localStorage.getItem(FLAG) === '1'; } catch (e) { return false; } };
  var flagSet = function () { try { localStorage.setItem(FLAG, '1'); } catch (e) {} };
  var permission = function () { try { return window.Notification ? Notification.permission : 'default'; } catch (e) { return 'default'; } };

  function getJSON(path, opts) {
    return fetch(path, Object.assign({ credentials: 'same-origin', cache: 'no-store' }, opts || {}))
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error((j && j.error && j.error.message) || 'Request failed'); return j; }); });
  }
  function config() {
    if (P.config) return Promise.resolve(P.config);
    return getJSON('/api/push/config').then(function (c) { P.config = c; return c; })
      .catch(function () { P.config = { configured: false, error: 'the server did not answer' }; return P.config; });
  }
  function loadDevices() {
    if (!isCand() || !window.TL || !TL.api) return Promise.resolve([]);
    return TL.api.get('/push/subscriptions').then(function (out) {
      P.devices = out.subscriptions || [];
      rerender();
      return P.devices;
    }).catch(function () { P.devices = []; return []; });
  }
  function registration() {
    return navigator.serviceWorker.register('/teamlink-sw.js').then(function () { return navigator.serviceWorker.ready; });
  }
  function keyBytes(b64) {
    var pad = '='.repeat((4 - b64.length % 4) % 4);
    var raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  /** Is THIS browser one of the candidate's devices? */
  function checkHere() {
    if (env() === 'unsupported' || env() === 'ios-browser' || env() === 'ios-too-old') return Promise.resolve(false);
    return navigator.serviceWorker.getRegistration('/').then(function (reg) {
      return reg ? reg.pushManager.getSubscription() : null;
    }).then(function (sub) { P.here = !!sub; return P.here; }).catch(function () { return false; });
  }

  /**
   * Turn phone notifications on for this device.
   *
   * MUST be called from a click handler: the permission request is the
   * first thing it does, while the tap still counts as the user's gesture
   * (iOS refuses the prompt otherwise).
   */
  function enable() {
    var e = env();
    if (e === 'ios-browser') { showSheet(); return Promise.resolve(false); }
    if (e === 'ios-too-old' || e === 'unsupported') { say(messageFor(e), 'ℹ️'); return Promise.resolve(false); }
    var asked = window.Notification ? Notification.requestPermission() : Promise.resolve('denied');
    P.busy = true; rerender();
    return Promise.resolve(asked).then(function (perm) {
      if (perm !== 'granted') {
        throw new Error(perm === 'denied'
          ? 'Notifications are blocked for TeamLink. Allow them in your phone or browser settings.'
          : 'Notifications were not turned on.');
      }
      return config();
    }).then(function (c) {
      if (!c.configured) throw new Error('Phone notifications are not set up on the server yet.');
      return registration().then(function (reg) {
        return reg.pushManager.getSubscription().then(function (sub) {
          return sub || reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(c.publicKey) });
        });
      });
    }).then(function (sub) {
      var j = sub.toJSON ? sub.toJSON() : sub;
      return TL.api.post('/push/subscribe', {
        endpoint: j.endpoint, keys: j.keys,
        platformHint: isIOS(navigator) ? 'ios' : /Android/i.test(navigator.userAgent) ? 'android' : 'desktop',
      });
    }).then(function () {
      P.busy = false; P.here = true;
      say('Phone notifications are on for this device.', '✅');
      loadDevices();
      return true;
    }).catch(function (err) {
      P.busy = false; rerender();
      say((err && err.message) || 'Phone notifications could not be turned on.', '⚠️');
      return false;
    });
  }

  function messageFor(e) {
    if (e === 'ios-too-old') return 'Please update your iPhone (iOS 16.4 or later) for phone notifications. Meanwhile you will get SMS/WhatsApp/email.';
    if (e === 'unsupported') return 'This browser cannot show phone notifications. You will get SMS/WhatsApp/email instead.';
    return '';
  }

  /* ---- the Home Screen sheet (iPhone in Safari) ---- */
  var ICON_SHARE = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#1d6ff2" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="M8 7l4-4 4 4"/><rect x="4" y="10" width="16" height="11" rx="2"/></svg>';
  var ICON_ADD = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#1d6ff2" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="4"/><path d="M12 8v8M8 12h8"/></svg>';
  var ICON_BELL = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#1d6ff2" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>';

  function showSheet() {
    if (typeof window.fcrModal !== 'function') return;
    flagSet();
    if (isInAppBrowser(navigator)) {
      fcrModal('<div class="fcr-jd-head"><h3>Open this page in Safari first</h3>'
        + '<p>This app’s built-in browser cannot add TeamLink to your Home Screen.</p>'
        + '<button class="fcr-jd-x" onclick="fcrCloseModal()">✕</button></div>'
        + '<div class="fcr-jd-body" style="font-size:13.5px;line-height:1.6">Tap the ••• or share menu and choose <b>Open in Safari</b>. '
        + 'Then add TeamLink to your Home Screen to get phone notifications.'
        + '<div style="margin-top:10px;color:#7b8794;font-size:12.5px">Until then we will send alerts by SMS / WhatsApp / email.</div></div>'
        + '<div class="fcr-jd-actions"><button class="btn btn-primary" onclick="fcrCloseModal()">OK</button></div>');
      return;
    }
    var step = function (n, icon, text) {
      return '<div style="display:flex;gap:12px;align-items:flex-start;padding:10px 0;border-top:1px solid #eef1f5">'
        + '<div style="flex:0 0 26px;height:26px;border-radius:50%;background:#e7f0ff;color:#1d6ff2;font-weight:800;display:flex;align-items:center;justify-content:center">' + n + '</div>'
        + '<div style="flex:0 0 22px;margin-top:2px">' + icon + '</div>'
        + '<div style="font-size:13.5px;line-height:1.5;color:#26313f">' + text + '</div></div>';
    };
    fcrModal('<div class="fcr-jd-head"><h3>Add TeamLink to your Home Screen</h3>'
      + '<p>On iPhone, phone notifications work only from the Home Screen app.</p>'
      + '<button class="fcr-jd-x" onclick="fcrCloseModal()">✕</button></div>'
      + '<div class="fcr-jd-body">'
      + step(1, ICON_SHARE, 'Tap the <b>Share</b> button (square with an arrow) at the bottom of Safari.')
      + step(2, ICON_ADD, 'Scroll and tap <b>Add to Home Screen</b>, then tap <b>Add</b>.')
      + step(3, ICON_BELL, 'Open TeamLink from the new icon and log in. Tap <b>Turn on notifications</b>.')
      + '<div style="margin-top:8px;color:#7b8794;font-size:12.5px">Until then we will send alerts by SMS / WhatsApp / email.</div></div>'
      + '<div class="fcr-jd-actions"><button class="btn btn-primary" onclick="fcrCloseModal()">Got it</button></div>');
  }

  /* ---- what the saved-search panel calls ---- */

  /** Inside the Save click: on Android/desktop this asks right away. */
  function onPushChosen() {
    var e = env();
    if (e === 'android-or-desktop' && permission() !== 'granted') enable();
    else if (e === 'android-or-desktop' && !P.here) enable();
  }
  /** After the search is saved. */
  function afterSave() {
    var e = env();
    if (e === 'ios-browser') { if (!flagGet()) showSheet(); else rerender(); }
    else if (e === 'ios-too-old' || e === 'unsupported') say(messageFor(e), 'ℹ️');
  }
  /** A line under the channel ticks, right for this device. */
  function panelHtml() {
    var e = env();
    if (e === 'ios-standalone' && !P.here) {
      return '<div style="margin-top:8px"><button type="button" class="cp-btn pri" style="padding:6px 12px;font-size:12px" onclick="TLPush.enable()">🔔 Turn on notifications</button></div>';
    }
    if (e === 'ios-browser') return '<div class="hint" style="font-size:11.5px;color:#8a94a6;margin-top:6px">On iPhone, add TeamLink to your Home Screen to get phone notifications.</div>';
    if (e === 'ios-too-old' || e === 'unsupported') return '<div class="hint" style="font-size:11.5px;color:#8a94a6;margin-top:6px">' + h(messageFor(e)) + '</div>';
    return '';
  }

  /* ---- the Job Alerts page section ---- */
  function status() {
    var e = env();
    if (e === 'unsupported') return ['Not available on this browser', '#8a94a6'];
    if (e === 'ios-too-old') return ['Needs iOS 16.4 or later', '#a35a0e'];
    if (e === 'ios-browser') return ['Needs Home Screen install', '#a35a0e'];
    if (permission() === 'denied') return ['Blocked', '#b4292b'];
    if (P.here) return ['On', '#0f7a44'];
    return ['Not set up', '#8a94a6'];
  }
  function sectionHtml() {
    var e = env(), st = status();
    var action = '';
    if (e === 'ios-browser') action = '<button class="cp-btn pri" onclick="TLPush.showSheet()">How to add to Home Screen</button>';
    else if ((e === 'ios-standalone' || e === 'android-or-desktop') && !P.here && permission() !== 'denied') {
      action = '<button class="cp-btn pri" ' + (P.busy ? 'disabled' : '') + ' onclick="TLPush.enable()">🔔 Turn on notifications</button>';
    }
    var help = permission() === 'denied' && e !== 'ios-browser'
      ? '<div style="font-size:12px;color:#7b8794;margin-top:6px">Allow notifications for TeamLink in your phone or browser settings, then reload.</div>'
      : (e === 'ios-too-old' || e === 'unsupported' ? '<div style="font-size:12px;color:#7b8794;margin-top:6px">' + h(messageFor(e)) + '</div>' : '');
    var devices = P.devices || [];
    var list = devices.length ? devices.map(function (d) {
      var added = d.createdAt ? new Date(d.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '';
      return '<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-top:1px solid #f0f3f7;font-size:12.5px">'
        + '<span style="flex:1">' + h(d.device) + (added ? ', added ' + h(added) : '') + '</span>'
        + '<button class="cp-btn" style="padding:4px 10px;font-size:11.5px" onclick="TLPush.remove(\'' + h(d.id) + '\')">Remove</button></div>';
    }).join('') : '<div style="font-size:12px;color:#8a94a6;margin-top:6px">No devices yet.</div>';
    var chip = (e === 'ios-browser' && flagGet())
      ? '<span style="display:inline-block;margin-left:6px;font-size:11px;font-weight:800;color:#a35a0e;background:#fff4e8;border-radius:10px;padding:2px 8px">Add to Home Screen to finish</span>' : '';
    var install = P.deferredInstall ? '<button class="cp-btn" onclick="TLPush.install()">Install TeamLink</button>' : '';
    return '<div class="cp-card" style="margin-bottom:12px" id="tlPushCard"><div class="cp-h2" style="margin:0 0 8px"><h2 style="font-size:15px">Phone notifications</h2></div>'
      + '<div style="font-size:12.5px">Status: <b style="color:' + st[1] + '">' + h(st[0]) + '</b>' + chip + '</div>'
      + help
      + '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">' + action + install
      + (devices.length ? '<button class="cp-btn" onclick="TLPush.test()">Send test notification</button>' : '') + '</div>'
      + '<div style="margin-top:10px">' + list + '</div></div>';
  }

  function wrapAlerts() {
    var prev = window.cpAlerts;
    if (typeof prev !== 'function' || prev.__tlpush) return;
    var next = function () {
      var html = prev.apply(this, arguments);
      if (typeof html !== 'string' || !isCand()) return html;
      if (P.devices === null) loadDevices();
      var marker = '<div class="cp-card" style="margin-bottom:12px"><div class="cp-h2" style="margin:0 0 8px"><h2 style="font-size:15px">Create a new alert</h2>';
      var at = html.indexOf(marker);
      return at >= 0 ? html.slice(0, at) + sectionHtml() + html.slice(at) : html;
    };
    next.__tlpush = true;
    window.cpAlerts = next;
  }

  /* ---- small actions ---- */
  api.enable = enable;
  api.showSheet = showSheet;
  api.onPushChosen = onPushChosen;
  api.afterSave = afterSave;
  api.panelHtml = panelHtml;
  api.env = env;
  api.available = function () { return env() !== 'unsupported'; };
  api.remove = function (id) {
    TL.api.del('/push/subscriptions/' + encodeURIComponent(id)).then(function () {
      say('Device removed', '🗑️'); return checkHere();
    }).then(loadDevices).catch(function (e) { say((e && e.message) || 'It could not be removed.', '⚠️'); });
  };
  api.test = function () {
    TL.api.post('/push/test', {}).then(function (out) {
      say(out.sent ? 'Test sent to ' + out.sent + ' device' + (out.sent === 1 ? '' : 's') + '.' : 'The test could not be delivered: '
        + ((out.results || []).map(function (r) { return r.error || r.status; }).join('; ') || 'no device answered'), out.sent ? '✅' : '⚠️');
      loadDevices();
    }).catch(function (e) { say((e && e.message) || 'The test could not be sent.', '⚠️'); });
  };
  api.install = function () {
    if (!P.deferredInstall) return;
    P.deferredInstall.prompt();
    P.deferredInstall.userChoice.then(function () { P.deferredInstall = null; rerender(); });
  };

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    P.deferredInstall = e;
    rerender();
  });

  /* The number on the Home Screen icon: new jobs across saved searches. */
  var lastBadge = -1;
  function badge() {
    if (!navigator.setAppBadge || !window.TLSavedSearches || !isCand()) return;
    /* Only the installed app has an icon to badge. */
    var standalone = navigator.standalone === true
      || !!(window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
    if (!standalone) return;
    TLSavedSearches.load().then(function (list) {
      var n = (list || []).reduce(function (s, x) { return s + (x.newCount || 0); }, 0);
      if (n === lastBadge) return;
      lastBadge = n;
      (n ? navigator.setAppBadge(n) : navigator.clearAppBadge ? navigator.clearAppBadge() : Promise.resolve())
        .catch(function () {});
    }).catch(function () {});
  }

  var lastSession = null;
  function install() {
    wrapAlerts();
    var prev = window.render;
    if (typeof prev === 'function' && !prev.__tlpush) {
      var r = function () {
        var out = prev.apply(this, arguments);
        try {
          var sid = isCand() ? STATE.session.id : null;
          if (sid !== lastSession) { lastSession = sid; P.devices = null; if (sid) { checkHere().then(rerender); loadDevices(); } }
          badge();
        } catch (e) {}
        return out;
      };
      r.__tlpush = true;
      window.render = r;
    }
  }
  if (document.readyState === 'complete') install();
  else window.addEventListener('load', install);
})(typeof window !== 'undefined' ? window : globalThis);
