/**
 * Single sign-on from TeamLink HRMS - the portal page (docs/HRMS-SSO.md).
 *
 * Only for a session opened from HRMS (GET /auth/hrms-sso/status says
 * viaHrms) - nothing changes for anybody who signed in with a password:
 *
 *   - a "← Back to HRMS" link in the header of the recruiter and admin pages
 *   - Logout here goes on to the HRMS login (the server has already logged
 *     HRMS out too)
 *   - ONE inactivity timeout with HRMS: API calls carry `x-tl-idle-ms`
 *     (milliseconds since the user last touched the page), so background
 *     polling never counts as activity, and a heartbeat once a minute lets
 *     the server check the HRMS session. When it has ended (HRMS logout,
 *     30 minutes idle) the page goes to HRMS, which opens the portal again
 *     at the same page - or asks for the HRMS login first and then does.
 *
 * And, when SSO is set up on the server: a signed-out visit to a recruiter or
 * admin page goes to the HRMS login and comes back to that page, instead of
 * the portal's own login screen (HRMS_SSO_STAFF_REDIRECT=0 turns this off).
 */
(function () {
  'use strict';
  if (window.TLHrmsSso) return;

  var KEY = 'tl_hrms_sso';
  var HEARTBEAT_MS = 60000;
  var status = null;
  var waiting = [];
  var lastActivity = Date.now();
  var beat = null;

  function apiBase() {
    return (window.TL && window.TL.apiBase) || window.TL_API_BASE || '/api';
  }
  function stored() {
    try { return JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch (e) { return null; }
  }
  function remember(url) {
    try { sessionStorage.setItem(KEY, JSON.stringify({ hrmsUrl: url })); } catch (e) { /* private mode */ }
  }
  function forget() {
    try { sessionStorage.removeItem(KEY); } catch (e) { /* private mode */ }
  }
  function hrmsUrl() {
    return (status && status.hrmsUrl) || ((stored() || {}).hrmsUrl) || '';
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function isStaffHash(h) {
    return /^#\/(recruiter|admin)(\/|$)/.test(String(h || ''));
  }
  /** To HRMS, which opens the portal again at `next` (logging in first if needed). */
  function goHrms(next) {
    var base = hrmsUrl();
    if (!base) return false;
    var n = isStaffHash(next) ? next : '';
    location.assign(base + '/sso/job-portal' + (n ? '?next=' + encodeURIComponent(n) : ''));
    return true;
  }

  /* ---- activity ------------------------------------------------------ */
  var lastMove = 0;
  function mark() { lastActivity = Date.now(); }
  ['mousedown', 'keydown', 'wheel', 'touchstart', 'scroll'].forEach(function (ev) {
    window.addEventListener(ev, mark, { passive: true, capture: true });
  });
  window.addEventListener('mousemove', function () {
    var now = Date.now();
    if (now - lastMove > 5000) { lastMove = now; mark(); }
  }, { passive: true, capture: true });

  var fetchWrapped = false;
  function wrapFetch() {
    if (fetchWrapped || typeof window.fetch !== 'function') return;
    fetchWrapped = true;
    var orig = window.fetch;
    window.fetch = function (input, init) {
      try {
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        if (/\/api\//.test(url) && (url.charAt(0) === '/' || url.indexOf(location.origin) === 0 || !/^[a-z]+:/i.test(url))) {
          init = Object.assign({}, init || {});
          var h = new Headers(init.headers || (typeof input !== 'string' && input.headers) || {});
          h.set('x-tl-idle-ms', String(Math.max(0, Date.now() - lastActivity)));
          init.headers = h;
        }
      } catch (e) { /* send it as it was */ }
      return orig.call(this, input, init);
    };
  }

  /* ---- status + heartbeat ------------------------------------------- */
  function fetchStatus() {
    return fetch(apiBase() + '/auth/hrms-sso/status', { credentials: 'include', cache: 'no-store' })
      .then(function (r) { return r.json(); });
  }
  function apply(st) {
    var was = !!(status && status.viaHrms);
    status = st || {};
    if (status.viaHrms) {
      remember(status.hrmsUrl || hrmsUrl());
      wrapFetch();
      if (!beat) beat = setInterval(heartbeat, HEARTBEAT_MS);
      if (!was) rerender();
    } else if (status.ended || was) {
      // The HRMS session ended under this page: back to HRMS, which opens
      // the portal again at this page (or asks for the HRMS login first).
      if (!goHrms(location.hash)) forget();
      return;
    } else {
      forget();   // a password session, or none: nothing of HRMS applies
    }
    var q = waiting; waiting = [];
    q.forEach(function (fn) { try { fn(); } catch (e) { /* next */ } });
  }
  function heartbeat() {
    fetchStatus().then(function (st) {
      if (st && st.viaHrms) { status = st; return; }
      clearInterval(beat); beat = null;
      if (!goHrms(location.hash)) forget();
    }).catch(function () { /* offline: the server decides on the next call */ });
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && status && status.viaHrms) heartbeat();
  });

  function rerender() {
    if (typeof window.render === 'function' && isStaffHash(location.hash)) {
      try { window.render(); } catch (e) { /* the next navigation draws it */ }
    }
  }

  /* ---- header link --------------------------------------------------- */
  function installShell() {
    if (typeof window.dashShell !== 'function') return false;
    if (window.dashShell.__hrmsSso) return true;
    var base = window.dashShell;
    var wrapped = function (role, section, titleHtml, crumb, contentHtml) {
      var html = base.apply(this, arguments);
      if (!status || !status.viaHrms || (role !== 'recruiter' && role !== 'admin') || !hrmsUrl()) return html;
      var link = '<a class="btn btn-ghost btn-sm tl-back-hrms" href="' + esc(hrmsUrl() + '/')
        + '" title="Back to TeamLink HRMS" style="margin-right:8px;text-decoration:none">← Back to HRMS</a>';
      return String(html).replace('<div class="topbar-spacer"></div>', '<div class="topbar-spacer"></div>' + link);
    };
    wrapped.__hrmsSso = true;
    window.dashShell = wrapped;
    return true;
  }

  /* ---- logout -------------------------------------------------------- */
  function installLogout() {
    if (typeof window.doLogout !== 'function') return false;
    if (window.doLogout.__hrmsSso) return true;
    var base = window.doLogout;
    var wrapped = function () {
      var via = !!(status && status.viaHrms);
      var url = hrmsUrl();
      if (via) { status.viaHrms = false; if (beat) { clearInterval(beat); beat = null; } }
      forget();
      var p = base.apply(this, arguments);
      if (!via || !url) return p;
      return Promise.resolve(p).then(function () { location.assign(url + '/login'); });
    };
    wrapped.__hrmsSso = true;
    window.doLogout = wrapped;
    return true;
  }

  /* ---- session expiry ------------------------------------------------ */
  function installExpiry() {
    if (!window.TL || typeof window.TL.onAuthFailure !== 'function') return false;
    if (window.TL.onAuthFailure.__hrmsSso) return true;
    var base = window.TL.onAuthFailure;
    var wrapped = function (err) {
      var via = status ? !!status.viaHrms : !!stored();
      if (err && (err.code === 'SESSION_EXPIRED' || err.code === 'UNAUTHENTICATED') && via) {
        if (goHrms(location.hash)) return undefined;
      }
      return base.apply(this, arguments);
    };
    wrapped.__hrmsSso = true;
    window.TL.onAuthFailure = wrapped;
    return true;
  }

  /* ---- signed-out visit to a staff page ------------------------------ */
  function installStaffRedirect() {
    if (typeof window.requireRole !== 'function') return false;
    if (window.requireRole.__hrmsSso) return true;
    var base = window.requireRole;
    var wrapped = function (role) {
      var signedIn = window.STATE && window.STATE.session && window.STATE.session.role === role;
      var known = !(document.readyState === 'loading' || (window.TL && window.TL.ready === false));
      if (signedIn || !known || (role !== 'recruiter' && role !== 'admin')) return base.apply(this, arguments);
      var target = location.hash;
      var self = this; var args = arguments;
      var decide = function () {
        if (status && status.staffRedirect && goHrms(target)) return;
        base.apply(self, args);
      };
      if (status) { decide(); return false; }
      waiting.push(decide);
      return false;
    };
    wrapped.__hrmsSso = true;
    window.requireRole = wrapped;
    return true;
  }

  var tries = 0;
  (function install() {
    var done = [installShell(), installLogout(), installExpiry(), installStaffRedirect()];
    if (done.indexOf(false) !== -1 && ++tries < 60) setTimeout(install, 500);
  })();

  fetchStatus().then(apply, function () { apply({}); });

  window.TLHrmsSso = {
    status: function () { return status; },
    goHrms: goHrms,
    _idleMs: function () { return Date.now() - lastActivity; },
  };
})();
