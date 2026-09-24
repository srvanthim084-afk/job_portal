/* =====================================================================
   TeamLink — backend integration layer
   =====================================================================

   This is the only file added to the prototype. It changes WHERE data
   comes from. It does not touch the DOM, the CSS, or any render function.

   THE CENTRAL PROBLEM
   -------------------
   The prototype reads data synchronously, inline, inside template
   literals. `DATA.jobById(id)` alone appears 163 times, always as a plain
   expression. Making those async would mean rewriting all 19 page
   renderers and most of the 691 functions — the rebuild the requirements
   forbid.

   THE APPROACH
   ------------
   `DATA` stays exactly what it is: a synchronous in-memory cache. Only
   its edges change.

     boot    one await, before the first paint, fills DATA from /api/bootstrap
     reads   unchanged — all ~700 synchronous call sites keep working
     writes  intercepted, sent to the API, then reconciled into the cache

   Two interception seams are used, both of which the prototype already
   uses on itself:

     1. Function wrapping (`const prev = window.fn; window.fn = ...`).
        The prototype does this in a dozen places already.

     2. localStorage. Every persistence path in the prototype funnels
        through a known key — `persistPosting()` writes both job creates
        AND edits through `teamlink_posted_jobs_v1`, for example. Shimming
        localStorage therefore catches flows without needing to know the
        name of every function that triggers them.

   RULES OBSERVED THROUGHOUT
   -------------------------
   - Never edit or replace a render function.
   - Never reassign a DATA array. Existing code holds references to them
     and monkey-patches their `.push`; arrays are refilled IN PLACE.
   - Never invent data. If the server says no, the UI says so.
   ===================================================================== */
(function () {
  'use strict';

  /**
   * Where the API lives.
   *
   * Served by the API itself - the normal case - this stays '/api', a
   * relative path that follows whatever domain serves the app, so the same
   * build works on localhost and in production without a rebuild.
   *
   * The standalone export is different: it is opened from a plain static
   * server on some other port, so it has to be told. In order:
   *
   *   window.TL_API_BASE   an explicit base, e.g. 'https://jobs.example.com/api'
   *   window.TL_API_PORT   just the API's port on THIS hostname
   *   ?api=<base>          the same thing from the address bar, no rebuild
   *
   * TL_API_PORT is built from `location.hostname` rather than a fixed host
   * on purpose. Session cookies are SameSite=Lax, which ignores the port but
   * not the host: a page on localhost:5183 calling 127.0.0.1:4323 is
   * cross-site and the cookie would be dropped, so you would sign in and
   * immediately appear signed out. Same hostname, any port, works.
   */
  var API = (function () {
    var q = /[?&]api=([^&]+)/.exec(location.search);
    if (q) return decodeURIComponent(q[1]).replace(/\/+$/, '');
    if (window.TL_API_BASE) return String(window.TL_API_BASE).replace(/\/+$/, '');
    if (window.TL_API_PORT) {
      return location.protocol + '//' + location.hostname + ':' + window.TL_API_PORT + '/api';
    }
    return '/api';
  })();

  // A cookie only travels cross-origin with 'include', and 'include' on a
  // same-origin request is equivalent - but 'same-origin' is kept for the
  // normal case so nothing about the usual deployment changes.
  var CREDENTIALS = /^https?:\/\//.test(API) &&
    API.indexOf(location.origin + '/') !== 0 ? 'include' : 'same-origin';

  var TL = (window.TL = window.TL || {});

  // The resolved API base, for the few things that need a URL rather than
  // the api.get/post wrappers - a file download, a multipart upload.
  TL.apiBase = API;

  TL.ready = false;        // the app may paint (true even if loading failed)
  TL.connected = false;    // /api/bootstrap actually answered - a different question
  TL.primaryAppId = Object.create(null);   // candidateId -> real application id

  /* ------------------------------------------------------------------ *
   * 1. Transport
   *
   * Every call the UI makes goes through request(). What it SAYS when a
   * call fails matters as much as the call itself.
   *
   * The first version of this file mapped every fetch rejection to one
   * message - "You appear to be offline - check your connection" - and
   * that is wrong in the two cases that actually happen, both of which
   * leave the connection perfectly healthy:
   *
   *   file://   web/index.html opened by double-clicking it. The page has
   *             no http origin, so fetch('/api/bootstrap') resolves to
   *             file:///C:/api/bootstrap and the browser refuses the
   *             scheme outright. There is no server to reach, and the app
   *             is empty: DATA.jobs is 0.
   *   API down  the page loaded from the server but the API is not
   *             answering (not started, crashed, nginx down, wrong port).
   *
   * In both, navigator.onLine is true. Telling the user to check their
   * connection sends them to fix something that is not broken, and the
   * message repeated once per failed call - boot, then login, then apply -
   * which is the stack of identical toasts in the bug report.
   *
   * Failures are now classified, the offline wording is used ONLY when
   * navigator.onLine is false, and identical toasts are collapsed.
   * ------------------------------------------------------------------ */

  // No http origin means there is no API to call, and no retry will fix it.
  var NO_ORIGIN = location.protocol === 'file:';

  // A request that never settles hangs the button forever. 20s is far past
  // any real response and well before a user assumes the app is dead.
  var TIMEOUT_MS = 20000;

  // Requirement 8: the failing endpoint, method, status and body have to be
  // identifiable. On by default on localhost; ?tlDebug=1 turns it on anywhere.
  TL.debug = /[?&]tlDebug=1/.test(location.search) ||
    /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);

  TL.failures = [];   // the last 20 failed calls, for TL.diagnose()

  function cookie(name) {
    var m = document.cookie.match('(^|;)\\s*' + name + '\\s*=\\s*([^;]+)');
    return m ? decodeURIComponent(m[2]) : null;
  }

  /**
   * Error codes come back from the API as stable strings (see
   * api/src/errors.js). They are mapped to the wording and icon the
   * prototype's own toast() already uses, so failures look native.
   */
  var TOAST = {
    INVALID_CREDENTIALS: ['Incorrect email or password', '⚠️'],
    VALIDATION_FAILED:   [null, '⚠️'],
    UNAUTHENTICATED:     ['Please sign in to continue', '🔒'],
    SESSION_EXPIRED:     ['Your session has expired — please sign in again', '🔒'],
    FORBIDDEN:           [null, '🚫'],
    NOT_FOUND:           [null, '⚠️'],
    DUPLICATE_APPLICATION: ['You already applied to this role', 'ℹ️'],
    JOB_UNAVAILABLE:     ['This role is no longer accepting applications', 'ℹ️'],
    EMAIL_TAKEN:         ['This email is already registered — try logging in instead', '⚠️'],
    UPLOAD_FAILED:       [null, '⚠️'],
    FILE_TOO_LARGE:      [null, '⚠️'],
    UNSUPPORTED_FILE:    [null, '⚠️'],
    RATE_LIMITED:        [null, '⏳'],
    CSRF_FAILED:         ['Please refresh the page and try again', '⚠️'],
    DATABASE_ERROR:      ['Something went wrong — please try again', '⚠️'],
    SERVER_ERROR:        ['Something went wrong — please try again', '⚠️'],
    CONFLICT:            [null, 'ℹ️'],

    // Transport failures. These are four different faults and they are
    // deliberately worded differently - see the note above.
    OFFLINE:         ['You appear to be offline — check your connection', '📡'],
    NOT_SERVED:      ['This page was opened as a file — open it from the TeamLink server instead', '🔌'],
    API_UNREACHABLE: ['Cannot reach the TeamLink server — the API is not responding', '🔌'],
    TIMEOUT:         ['The server took too long to respond — please try again', '⏳'],
  };

  /**
   * When the response carries no error code of its own (a proxy's 502 page,
   * a bare 404), the HTTP status still says what happened. Requirement 7.
   */
  var BY_STATUS = {
    400: 'VALIDATION_FAILED', 401: 'UNAUTHENTICATED', 403: 'FORBIDDEN',
    404: 'NOT_FOUND', 408: 'TIMEOUT', 409: 'CONFLICT', 413: 'FILE_TOO_LARGE',
    415: 'UNSUPPORTED_FILE', 422: 'VALIDATION_FAILED', 429: 'RATE_LIMITED',
    500: 'SERVER_ERROR', 502: 'API_UNREACHABLE', 503: 'API_UNREACHABLE',
    504: 'TIMEOUT',
  };

  function ApiFailure(code, message, details, status) {
    this.name = 'ApiFailure';
    this.code = code; this.message = message;
    this.details = details; this.status = status;
  }
  ApiFailure.prototype = Object.create(Error.prototype);

  /**
   * One failure, one toast.
   *
   * A single broken connection produces several failed calls in a row
   * (bootstrap, then login, then apply). Each used to raise its own toast,
   * so the same sentence stacked three or four deep. The prototype's
   * toast() dismisses after 4.2s, so an identical message repeated inside
   * that window is the same event being reported twice.
   */
  var lastSaid = { text: null, at: 0 };

  function say(err) {
    var m = TOAST[err && err.code] || [null, '⚠️'];
    var text = m[0] || (err && err.message) || 'Something went wrong';
    var now = Date.now();
    if (text === lastSaid.text && now - lastSaid.at < 4200) return err;
    lastSaid = { text: text, at: now };
    if (typeof window.toast === 'function') window.toast(text, m[1]);
    return err;
  }

  /**
   * Why did fetch reject? It only ever reports "Failed to fetch", so the
   * answer comes from the surrounding conditions rather than the error.
   */
  function classify(err) {
    if (navigator.onLine === false) return 'OFFLINE';      // the ONLY offline case
    if (NO_ORIGIN) return 'NOT_SERVED';
    if (err && err.name === 'AbortError') return 'TIMEOUT';
    return 'API_UNREACHABLE';     // API down, DNS, TLS, or a CORS rejection
  }

  /** Requirement 8/9: say exactly which call failed, and how. */
  function record(method, path, status, code, detail, ms) {
    var entry = {
      at: new Date().toISOString(), method: method, url: API + path,
      status: status || 0, code: code, detail: detail, ms: ms,
    };
    TL.failures.push(entry);
    if (TL.failures.length > 20) TL.failures.shift();
    if (!TL.debug) return entry;
    console.groupCollapsed('%cTeamLink API%c ' + method + ' ' + API + path +
      ' -> ' + (status || 'no response') + ' ' + code,
      'background:#b3261e;color:#fff;padding:2px 6px;border-radius:3px', '');
    console.log('status  :', status || '(the request never reached a server)');
    console.log('code    :', code);
    console.log('response:', detail);
    console.log('took    :', ms + 'ms');
    console.groupEnd();
    return entry;
  }

  /**
   * A one-line answer to "is the backend connected?", for the console.
   * Requirement 9 - look here instead of guessing from a toast.
   */
  TL.diagnose = function () {
    var out = {
      pageOrigin: location.origin === 'null' ? location.href : location.origin,
      protocol: location.protocol,
      apiBase: API,
      apiCredentials: CREDENTIALS,
      browserOnline: navigator.onLine,
      backendConnected: TL.connected,
      signedInAs: TL.session ? TL.session.role + ':' + TL.session.id : null,
      // `const DATA` at prototype.html:898 is a lexical global, so it is
      // NOT window.DATA - reading it that way reported 0 jobs always.
      jobsInCache: (typeof DATA !== 'undefined' && DATA.jobs ? DATA.jobs.length : 0),
      recentFailures: TL.failures.slice(-5),
    };
    var recent = TL.failures[TL.failures.length - 1];
    var justFailed = recent && (Date.now() - Date.parse(recent.at)) < 15000;

    if (NO_ORIGIN) {
      out.verdict = 'NOT SERVED - this page is running from a file, so there is ' +
        'no server to call. Start the app (npm run dev) and open the http:// address it prints.';
    } else if (justFailed && recent.code === 'OFFLINE') {
      out.verdict = 'BROWSER OFFLINE - the machine has no network. The server is ' +
        'not the problem; the last call never left the browser.';
    } else if (!TL.connected) {
      out.verdict = 'NOT CONNECTED - the page loaded but /api/bootstrap did not answer. ' +
        'The API is probably not running. See TL.failures for the exact call.';
    } else {
      out.verdict = 'CONNECTED - data came from ' + API + '.';
    }
    console.log(out.verdict);
    if (console.table) console.table(out.recentFailures);
    return out;
  };

  var SAFE_METHOD = { GET: 1, HEAD: 1, OPTIONS: 1 };

  /**
   * Make sure we hold a CSRF token before a write goes out.
   *
   * The server has always offered GET /api/csrf for exactly this and
   * NOTHING EVER CALLED IT. The token arrived only as a side effect of
   * signing in, which makes it circular: to sign in you needed a token,
   * and the token came from signing in. A browser that had the session
   * cookie but not the token - which is what you get by closing the
   * browser, since one was persistent and the other was not - could
   * never write again, and the toast said "refresh the page", which
   * could not possibly help.
   *
   * One request, only when the cookie is actually missing, and a failure
   * to get it does not stop the attempt: the server is the one that
   * decides, and it may not need a token at all.
   */
  function ensureCsrf() {
    if (NO_ORIGIN || cookie('tl_csrf')) return Promise.resolve();
    return fetch(API + '/csrf', { credentials: CREDENTIALS, cache: 'no-store' })
      .then(function () {}, function () {});
  }

  function request(method, path, body, opts) {
    opts = opts || {};

    /*
     * A write with no token in hand fetches one first, then goes.
     *
     * Only for writes, so reading a page never costs a second round
     * trip, and only when the cookie is missing, so the normal case is
     * unchanged.
     */
    if (!SAFE_METHOD[method] && !opts.__csrfReady && !NO_ORIGIN && !cookie('tl_csrf')) {
      return ensureCsrf().then(function () {
        var next = {};
        for (var k in opts) if (Object.prototype.hasOwnProperty.call(opts, k)) next[k] = opts[k];
        next.__csrfReady = true;
        return request(method, path, body, next);
      });
    }
    var headers = {};
    var payload = body;
    var started = Date.now();

    // There is no server behind a file:// page. Failing here rather than
    // in fetch keeps the error honest and costs nothing.
    if (NO_ORIGIN) {
      var noSrv = new ApiFailure('NOT_SERVED',
        'This page is running from a file, so it cannot reach the TeamLink API.');
      record(method, path, 0, 'NOT_SERVED',
        'location.protocol is "file:" - open the app from the server instead', 0);
      return Promise.reject(noSrv);
    }

    // FormData sets its own multipart boundary; setting content-type by
    // hand would corrupt the upload.
    if (body !== undefined && body !== null && !(body instanceof FormData)) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    // Double-submit CSRF: the cookie is readable, so the same value is
    // echoed in a header a cross-site page cannot set.
    var token = cookie('tl_csrf');
    if (token) headers['x-csrf-token'] = token;

    // `credentials: same-origin` is what carries the httpOnly session
    // cookie. The session lives in that cookie, not in localStorage, so
    // it survives a refresh without the page holding a token it could leak.
    var init = {
      method: method,
      headers: headers,
      body: payload,
      credentials: CREDENTIALS,
      cache: 'no-store',
    };

    // Bound the wait, so a hung server surfaces as a timeout instead of a
    // button that never re-enables.
    var ctl = null, timer = null;
    if (typeof AbortController === 'function') {
      ctl = new AbortController();
      init.signal = ctl.signal;
      timer = setTimeout(function () { ctl.abort(); }, opts.timeout || TIMEOUT_MS);
    }
    var settled = function () { if (timer) clearTimeout(timer); };

    return fetch(API + path, init).then(function (res) {
      return res.text().then(function (text) {
        settled();
        var json = null;
        try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
        if (!res.ok) {
          var e = (json && json.error) || {};
          // The API always sends a code. A proxy or a static 404 page does
          // not, so fall back to what the status itself means.
          var code = e.code || BY_STATUS[res.status] || 'SERVER_ERROR';

          /*
           * A refused token heals itself, once.
           *
           * A token can go stale for reasons nobody can see - the server
           * restarted, the cookie expired, two tabs raced. Showing
           * somebody "please refresh and try again" for that is asking
           * them to do by hand what this can do correctly: throw the
           * stale token away, ask for a new one, and send the request
           * again.
           *
           * ONCE. A second failure is a real refusal and is reported as
           * one, rather than becoming a loop.
           */
          if (code === 'CSRF_FAILED' && !opts.__csrfRetried) {
            record(method, path, res.status, code, 'stale token - fetching a new one',
              Date.now() - started);
            return fetch(API + '/csrf', { credentials: CREDENTIALS, cache: 'no-store' })
              .catch(function () {})
              .then(function () {
                var next = {};
                for (var k in opts) if (Object.prototype.hasOwnProperty.call(opts, k)) next[k] = opts[k];
                next.__csrfRetried = true;
                next.__csrfReady = true;
                return request(method, path, body, next);
              });
          }
          record(method, path, res.status, code,
            json || (text || '').slice(0, 400), Date.now() - started);
          throw new ApiFailure(code, e.message || 'Request failed',
            e.details, res.status);
        }
        return json;
      });
    }, function (err) {
      // fetch rejected: nothing came back at all. Which of the four
      // possible reasons it is decides what the user is told.
      settled();
      var code = classify(err);
      record(method, path, 0, code,
        (err && err.message) || String(err), Date.now() - started);
      throw new ApiFailure(code, TOAST[code][0]);
    });
  }

  // `opts.timeout` overrides TIMEOUT_MS - a resume upload legitimately
  // takes longer than a lookup, and a test needs to force the timeout path.
  var api = TL.api = {
    get:  function (p, o) { return request('GET', p, undefined, o); },
    post: function (p, b, o) { return request('POST', p, b, o); },
    put:  function (p, b, o) { return request('PUT', p, b, o); },
    // The settings routes take a partial update rather than a whole
    // object, so a screen that shows six of thirty fields cannot blank
    // the other twenty-four by saving.
    patch: function (p, b, o) { return request('PATCH', p, b, o); },
    del:  function (p, o) { return request('DELETE', p, undefined, o); },
    say: say,
  };

  /* ------------------------------------------------------------------ *
   * 2. localStorage shim
   *
   * The prototype uses 58 localStorage keys. They fall into three groups
   * (documented in docs/DATA-MAPPING.md §4):
   *
   *   entity keys  — real data that now lives in its own table. Writes
   *                  here are forwarded to the matching API endpoint.
   *   pref keys    — per-user settings, mirrored to /api/prefs.
   *   local keys   — transient UI state that is genuinely per-device and
   *                  deliberately stays in the browser.
   *
   * Reads stay synchronous against an in-memory map primed at boot, so
   * every existing `JSON.parse(localStorage.getItem(...))` call site keeps
   * working unchanged.
   * ------------------------------------------------------------------ */

  var mem = Object.create(null);     // key -> string
  var native = null;
  try { native = window.localStorage; } catch (e) { native = null; }

  // Genuinely device-local: filter selections and scratch UI state that
  // would be meaningless on another machine.
  var LOCAL_ONLY = {
    tl_ext_src_filter: 1, tl_ext_match_threshold: 1,
    teamlink_apps_cofilter_v1: 1, teamlink_apps_allco_v1: 1,
  };

  // Entity keys whose writes are forwarded to a real endpoint.
  var ENTITY_SYNC = {
    teamlink_posted_jobs_v1: syncPostedJobs,
  };

  // Keys the DATABASE now owns. The prototype still writes these as a
  // mirror of state it already sent to the server (applications, stages,
  // notifications, sessions). Forwarding them to /api/prefs would store a
  // stale second copy of data that already has a real table — exactly the
  // "separate frontend copies" requirement 17 rules out. They are kept in
  // memory so synchronous reads still work, and dropped on write.
  var SERVER_OWNED = {
    teamlink_applications_v1: 1, teamlink_candidate_stage_v1: 1,
    teamlink_app_snapshots_v1: 1, teamlink_job_base_applicants_v1: 1,
    teamlink_applied_on_v1: 1, tl_ext_applications: 1,
    teamlink_registered_candidates_v1: 1, teamlink_candidate_edits_v1: 1,
    teamlink_qualifications_v1: 1, teamlink_candidate_notifications_v1: 1,
    teamlink_notification_history_v1: 1, tl_job_portal_state_v1: 1,
    tl_portal_lifecycle_v1: 1, teamlink_web_companies_v1: 1,
    // credentials and session state — these must never be in the browser
    teamlink_session_v1: 1, teamlink_last_hash_v1: 1,
    teamlink_recruiter_password: 1,
    // provider secrets (requirement 21) — server-side env vars now
    teamlink_whatsapp_api_v1: 1, teamlink_sms_api_v1: 1, teamlink_ivr_settings_v1: 1,
  };

  function isLocalOnly(k) {
    return LOCAL_ONLY[k] === 1 || k.indexOf('tl_ai_last_qset_') === 0;
  }

  /**
   * Keys that hold BOTH settings and credentials.
   *
   * teamlink_notification_settings_v1 carries the EmailJS serviceId,
   * templateId and publicKey alongside ordinary preferences - per-type
   * message templates, lastVerifiedAt. Its three siblings
   * (teamlink_whatsapp_api_v1, teamlink_sms_api_v1, teamlink_ivr_settings_v1)
   * are in SERVER_OWNED and dropped; this one was missed, so typing EmailJS
   * credentials into Notification Settings sent them to /api/prefs, where
   * they were stored in user_prefs and handed back to the browser on every
   * load. Requirement 21 puts email API keys in server-side environment
   * variables, not in a preferences table.
   *
   * Dropping the whole key would also discard the templates, which are not
   * secrets and which a user reasonably expects to keep. So the credential
   * fields are stripped and the rest syncs as before.
   */
  var STRIP_SECRETS = {
    teamlink_notification_settings_v1: ['serviceId', 'templateId', 'publicKey',
                                        'accessToken', 'privateKey'],
  };

  function withoutSecrets(k, raw) {
    var fields = STRIP_SECRETS[k];
    if (!fields) return raw;
    var v;
    try { v = JSON.parse(raw); } catch (e) { return null; }   // unparseable: send nothing
    if (!v || typeof v !== 'object') return raw;
    var removed = false;
    fields.forEach(function (f) {
      if (v[f] !== undefined && v[f] !== '') { delete v[f]; removed = true; }
    });
    if (removed && TL.debug) {
      console.info('TeamLink: stripped provider credentials from "' + k +
                   '" before syncing - they belong in server environment variables.');
    }
    return Object.keys(v).length ? JSON.stringify(v) : null;
  }

  var prefQueue = Object.create(null);
  var prefTimer = null;

  function queuePref(key, raw) {
    prefQueue[key] = raw;
    if (prefTimer) return;
    // Coalesced: the prototype writes some keys on every keystroke.
    prefTimer = setTimeout(function () {
      prefTimer = null;
      var batch = prefQueue; prefQueue = Object.create(null);
      Object.keys(batch).forEach(function (k) {
        var value;
        try { value = JSON.parse(batch[k]); } catch (e) { value = batch[k]; }
        api.put('/prefs/' + encodeURIComponent(k), { value: value })
          .catch(function () { /* a preference failing to save is not worth a toast */ });
      });
    }, 400);
  }

  var shim = {
    get length() { return Object.keys(mem).length; },
    key: function (i) { return Object.keys(mem)[i] || null; },
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null; },
    setItem: function (k, v) {
      k = String(k); v = String(v);
      mem[k] = v;
      if (isLocalOnly(k)) { try { native && native.setItem(k, v); } catch (e) {} return; }
      if (!TL.ready) return;                       // boot-time replay, not a user action
      if (SERVER_OWNED[k] === 1) return;           // the database already has it
      if (ENTITY_SYNC[k]) { try { ENTITY_SYNC[k](v); } catch (e) {} return; }
      if (!TL.session) return;
      // The value stays complete in memory, so the screen still shows what
      // was typed; only what LEAVES the browser is stripped.
      var safe = withoutSecrets(k, v);
      if (safe !== null) queuePref(k, safe);
    },
    removeItem: function (k) {
      k = String(k);
      delete mem[k];
      if (isLocalOnly(k)) { try { native && native.removeItem(k); } catch (e) {} return; }
      // Mirror setItem's guards. Without the SERVER_OWNED check this sent a
      // DELETE /api/prefs/<key> for keys that were never stored as prefs -
      // a wasted round trip that 401s once the user signs out.
      if (SERVER_OWNED[k] === 1 || ENTITY_SYNC[k]) return;
      if (TL.ready && TL.session) api.del('/prefs/' + encodeURIComponent(k)).catch(function () {});
    },
    clear: function () { mem = Object.create(null); },
  };

  function installStorageShim() {
    // Seed from whatever is already in the real localStorage so nothing
    // the prototype wrote during parse is lost mid-session.
    try {
      if (native) {
        for (var i = 0; i < native.length; i++) {
          var k = native.key(i);
          if (k) mem[k] = native.getItem(k);
        }
      }
    } catch (e) {}

    try {
      Object.defineProperty(window, 'localStorage', {
        value: shim, configurable: true, writable: false,
      });
      TL.storageShimmed = true;
    } catch (e) {
      // Some browsers refuse to redefine it. The app still works — data
      // just also lands in real localStorage — but say so rather than
      // pretending the swap happened.
      TL.storageShimmed = false;
      console.warn('TeamLink: localStorage could not be replaced; ' +
                   'preferences will not sync to the server.', e);
    }
  }

  /** teamlink_posted_jobs_v1 carries both creates and edits. */
  /**
   * Was this job changed, or is it just the server's own copy read back?
   *
   * The prototype rebuilds teamlink_posted_jobs_v1 from DATA on load, so
   * the list contains every job it considers "posted" - including ones
   * that arrived from the API and were never edited. Syncing those sent a
   * PUT for each one, which a candidate or a signed-out visitor is
   * correctly refused: a stream of 401s and 403s for jobs nobody touched.
   */
  function jobUnchanged(j) {
    var server = TL.serverJobs && TL.serverJobs[j.id];
    if (!server) return false;                 // never seen from the server
    var now = jobToApi(j);
    for (var k in now) {
      if (!Object.prototype.hasOwnProperty.call(now, k)) continue;
      var a = now[k], b = server[k];
      if (Array.isArray(a) || Array.isArray(b)) {
        if (JSON.stringify(a || []) !== JSON.stringify(b || [])) return false;
      } else if (String(a == null ? '' : a) !== String(b == null ? '' : b)) {
        return false;
      }
    }
    return true;
  }

  function syncPostedJobs(raw) {
    var list;
    try { list = JSON.parse(raw); } catch (e) { return; }
    if (!Array.isArray(list)) return;

    // Only somebody who may post a job can be writing one. Without this the
    // list is replayed for every visitor, and the API rightly refuses.
    var role = TL.session && TL.session.role;
    if (role !== 'recruiter' && role !== 'admin') return;

    list.forEach(function (j) {
      if (!j || !j.id || TL.syncingJob === j.id) return;
      if (jobUnchanged(j)) return;             // nothing to write
      var known = TL.knownJobIds && TL.knownJobIds[j.id];
      var payload = jobToApi(j);
      TL.syncingJob = j.id;

      var p = known
        ? api.put('/jobs/' + encodeURIComponent(j.id), payload)
        : api.post('/jobs', Object.assign({ id: j.id }, payload));

      p.then(function (res) {
        TL.knownJobIds[j.id] = true;
        // adopt the server's view (derived applicants, posted label)
        var local = DATA.jobById(j.id);
        if (local && res && res.job) Object.assign(local, res.job);
      }).catch(say).then(function () { TL.syncingJob = null; });
    });
  }

  function jobToApi(j) {
    return {
      title: j.title, companyId: j.companyId, location: j.location, mode: j.mode,
      exp: j.exp, pay: j.pay, type: j.type, postingKind: j.postingKind,
      department: j.department, education: j.education,
      easyApply: !!j.easyApply, featured: !!j.featured,
      salaryMin: j.salaryMin == null ? null : Number(j.salaryMin),
      salaryMax: j.salaryMax == null ? null : Number(j.salaryMax),
      skills: j.skills || [], desc: j.desc || '',
      responsibilities: j.responsibilities || [], requirements: j.requirements || [],
      status: j.status === 'closed' ? 'closed' : (j.status === 'draft' ? 'draft' : 'open'),
    };
  }

  /* ------------------------------------------------------------------ *
   * 3. Hydration
   * ------------------------------------------------------------------ */

  /** Refills an array IN PLACE — see the header note about .push patches. */
  function refill(arr, rows) {
    if (!Array.isArray(arr)) return;
    arr.length = 0;
    if (rows && rows.length) Array.prototype.push.apply(arr, rows);
  }

  function applyPayload(payload) {
    var d = payload.data;

    refill(DATA.companies, d.companies);
    refill(DATA.jobs, d.jobs);
    // The server's own view of every job, kept so syncPostedJobs can tell
    // an edit from a read-back.
    TL.serverJobs = Object.create(null);
    (d.jobs || []).forEach(function (j) { TL.serverJobs[j.id] = jobToApi(j); });
    refill(DATA.candidates, d.candidates);
    refill(DATA.applications, d.applications);
    refill(DATA.interviews, d.interviews);
    refill(DATA.recruiters, d.recruiters);
    refill(DATA.clients, d.clients);
    // BDEs are new in this system - the prototype has no DATA.bdes array to
    // refill, so it is created on first hydrate and then kept in place like
    // every other collection.
    if (!DATA.bdes) DATA.bdes = [];
    refill(DATA.bdes, d.bdes || []);
    if (d.admin) DATA.admin = d.admin;

    if (d.stages && d.stages.length) {
      refill(DATA.stages, d.stages);
      refill(DATA.kanbanStages, d.stages.filter(function (s) { return s.kanban; }));
    }
    if (d.aiSettings && Object.keys(d.aiSettings).length) {
      Object.assign(DATA.aiSettings, d.aiSettings);
    }

    // remember the real id behind each candidate's primary application
    TL.primaryAppId = Object.create(null);
    d.candidates.forEach(function (c) {
      if (c.__primaryApplicationId) {
        TL.primaryAppId[c.id] = c.__primaryApplicationId;
        // keep it off the object the UI iterates over
        try { delete c.__primaryApplicationId; } catch (e) {}
      }
    });

    TL.knownJobIds = Object.create(null);
    d.jobs.forEach(function (j) { TL.knownJobIds[j.id] = true; });

    TL.offers = d.offers || [];
    TL.aiInterviews = d.aiInterviews || [];
    TL.notifications = d.notifications || [];

    // the session the SERVER says we have — not what localStorage claimed
    TL.session = payload.session;
    if (payload.session) {
      STATE.session = { role: payload.session.role, id: payload.session.id };
    } else {
      STATE.session = null;
    }
  }

  function loadPrefs() {
    if (!TL.session) return Promise.resolve();
    return api.get('/prefs').then(function (res) {
      var prefs = (res && res.prefs) || {};
      Object.keys(prefs).forEach(function (k) {
        try { mem[k] = JSON.stringify(prefs[k]); } catch (e) {}
      });
    }).catch(function () { /* a cold prefs table is not an error */ });
  }

  function hydrate() {
    // The demo fixtures are fetched alongside the bootstrap, not lazily on
    // first demo render: pageAIPipeline() dereferences the candidate
    // immediately, so anything arriving later is already too late.
    return Promise.all([
      api.get('/bootstrap').then(function (payload) {
        applyPayload(payload);
        return loadPrefs();
      }),
      loadDemoFixtures(),
      loadLoginHints(),
    ]);
  }
  TL.hydrate = hydrate;

  /** Re-reads everything, then repaints. Used after a login/logout. */
  function refresh() {
    return hydrate().then(function () {
      // The application records, the interview and its deadline all come
      // from the database - not from whatever this browser happens to
      // have in localStorage.
      try {
        if (TL.ensureLocalRecords) TL.ensureLocalRecords();
        if (TL.syncInterviewDeadlines) TL.syncInterviewDeadlines();
      } catch (e) {
        console.error('TeamLink: could not rebuild the local application records.', e);
      }
      if (typeof window.render === 'function') window.render();
    });
  }
  TL.refresh = refresh;

  /* ------------------------------------------------------------------ *
   * 4. Boot — hold the first paint until the data is real
   * ------------------------------------------------------------------ */

  var realRender = window.render;
  var pendingRender = false;

  window.render = function () {
    if (!TL.ready) { pendingRender = true; return; }   // suppress the seed-data flash
    return realRender.apply(this, arguments);
  };

  installStorageShim();

  /**
   * Makes DATA and STATE reachable as window.DATA / window.STATE.
   *
   * `const DATA = {}` (prototype.html:898) and `const STATE` are lexical
   * globals: reachable by bare name from any script on the page, but NOT
   * properties of window. That trips up anything reaching for them through
   * window - console one-liners, a devtools snippet, and TL.diagnose(),
   * which reported "0 jobs" for exactly this reason until a test caught it.
   *
   * These are references to the same objects, not copies, so window.DATA.jobs
   * and DATA.jobs are the same array and neither can drift from the other.
   */
  function publishGlobals() {
    try {
      if (typeof DATA !== 'undefined') window.DATA = DATA;
      if (typeof STATE !== 'undefined') window.STATE = STATE;
    } catch (e) { /* nothing depends on this succeeding */ }
  }

  function boot() {
    return hydrate().then(function () {
      TL.ready = true;
      TL.connected = true;
      publishGlobals();
      if (!location.hash) location.hash = '#/';
      window.render();
    }).catch(function (err) {
      TL.ready = true;      // let the app render rather than hang on a blank page
      TL.connected = false;
      publishGlobals();     // diagnosing a failure needs them more, not less
      say(err);
      window.render();
      // Requirement 9: the console must name the fault, not repeat the toast.
      if (err && err.code === 'NOT_SERVED') {
        console.error('TeamLink is not connected to a server.\n\n' +
          'This page was opened directly from disk (' + location.protocol + '//), ' +
          'so there is no origin to call - every request to ' + API + ' fails ' +
          'before it leaves the browser, and no data can load.\n\n' +
          'Start the app and open it over http instead:\n' +
          '    npm run dev\n' +
          '  then open the address it prints (the one beginning http://).\n\n' +
          'Run TL.diagnose() for the full picture.');
      } else {
        console.error('TeamLink: could not load data from the server (' +
          (err && err.code) + '). Run TL.diagnose() for details.', err);
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  /* ------------------------------------------------------------------ *
   * 5. Authentication — same forms, same markup, real credentials
   * ------------------------------------------------------------------ */

  // submitLogin(role, ev) is wired to the existing <form onsubmit=...>.
  // Only the body changes: a comparison against the hardcoded
  // ROLE_CREDENTIALS object becomes a call to the API.
  // A second submit while the first is still in flight produces two
  // sessions' worth of work and two toasts. Requirement 10.
  var signingIn = false;

  window.submitLogin = function (role, ev) {
    if (ev && ev.preventDefault) ev.preventDefault();
    if (signingIn) return;
    signingIn = true;
    var form = ev && ev.target;
    var email = form && form.elements.email ? String(form.elements.email.value || '').trim() : '';
    var password = form && form.elements.password ? String(form.elements.password.value || '') : '';

    var btn = form && form.querySelector('button[type="submit"], .btn-primary');
    if (btn) { btn.disabled = true; btn.dataset.tlLabel = btn.textContent; btn.textContent = 'Signing in…'; }

    var done = function () {
      signingIn = false;
      if (btn) { btn.disabled = false; if (btn.dataset.tlLabel) btn.textContent = btn.dataset.tlLabel; }
    };

    return api.post('/auth/login', { email: email, password: password, role: role })
      .then(function (res) {
        return refresh().then(function () {
          var who = res.session;
          var name = who.id;
          try {
            name = who.role === 'candidate' ? DATA.candidateById(who.id).name
                 : who.role === 'recruiter' ? DATA.recruiterById(who.id).name
                 : who.role === 'client'    ? DATA.clientById(who.id).name
                 : DATA.admin.name;
          } catch (e) {}
          if (typeof window.toast === 'function') window.toast('Signed in as ' + name);
          window.navigate('/' + who.role + '/' +
            (who.role === 'candidate' ? 'home'
             : who.role === 'recruiter' ? 'home'
             : who.role === 'client' ? 'jobs'
             : who.role === 'bde' ? 'candidates' : 'users'));
        });
      })
      .catch(say)
      .then(done, done);
  };

  window.doLogout = function () {
    // Clear the local view of the session FIRST. The prototype clears
    // several localStorage keys on the way out; with TL.session still set,
    // the shim forwarded those as authenticated DELETE /api/prefs calls
    // that arrived after the cookie was gone and came back 401 - a console
    // error for something that had already succeeded.
    TL.session = null;
    STATE.session = null;
    return api.post('/auth/logout', {})
      .catch(function () { /* sign out locally even if the call fails */ })
      .then(function () {
        mem = Object.create(null);
        return hydrate();
      })
      .then(function () {
        STATE.session = null;
        window.navigate('/');
        if (typeof window.toast === 'function') window.toast('Signed out');
      });
  };

  /**
   * The "Quick demo login" panel.
   *
   * In the prototype each button called loginAs(role, id) and signed you
   * straight in WITH NO PASSWORD. That is the same hole as submitLogin()
   * accepting any candidate, and it cannot survive real authentication —
   * a one-click passwordless sign-in would make every policy behind it
   * pointless.
   *
   * The panel is kept exactly as it looks. Clicking a name now PREFILLS
   * the email field and focuses the password box, so it stays the
   * convenience it was meant to be without being a way in.
   */
  window.loginAs = function (role, id) {
    if (TL.session && TL.session.role === role) {
      return window.navigate('/' + role + '/' +
        (role === 'candidate' ? 'home' : role === 'recruiter' ? 'home'
         : role === 'client' ? 'jobs' : 'users'));
    }

    var hint = (TL.loginHints[role] || []).filter(function (a) { return a.id === id; })[0];
    var form = document.querySelector('.auth-form');

    if (form && hint) {
      // Deliberately does NOT fill in the address. Only one staff email is
      // already printed on this page; auto-filling the rest would publish
      // addresses that are not otherwise public. The click focuses the
      // field and names the person, and the user types the credentials.
      var email = form.elements.email;
      if (email) email.focus();
      if (typeof window.toast === 'function') {
        window.toast('Sign in as ' + hint.name + ' using their email and password', '🔒');
      }
      return;
    }

    window.navigate('/login/' + role);
    if (typeof window.toast === 'function') {
      window.toast('Please sign in to continue', '🔒');
    }
  };

  /**
   * demoAccountsFor() read DATA directly, which meant an anonymous visitor
   * to the candidate login page was shown four real people's names and
   * email addresses. It now reads a server list that deliberately excludes
   * candidates — see public_login_hints() in 0002_rls.sql.
   */
  TL.loginHints = { candidate: [], recruiter: [], client: [], bde: [], admin: [] };

  window.demoAccountsFor = function (role) {
    return (TL.loginHints[role] || []).map(function (a) {
      return { id: a.id, name: a.name, sub: a.sub };
    });
  };

  function loadLoginHints() {
    return api.get('/login-hints').then(function (h) {
      TL.loginHints = {
        candidate: h.candidate || [],
        recruiter: h.recruiter || [],
        client:    h.client || [],
        bde:       h.bde || [],
        admin:     h.admin || [],
      };
    }).catch(function () { /* the panel renders empty; sign-in still works */ });
  }

  /* ------------------------------------------------------------------ *
   * 5b. The login page must not hand out a password that cannot work
   *
   * prototype.html:1328 defines ROLE_CREDENTIALS with a password per role
   * ("Admin@123", "Recruiter@123", "Client@123"). pageLogin() PREFILLS the
   * password box with it and prints it in a "Login credentials" panel.
   *
   * Those were the whole authentication system when the prototype checked
   * credentials in JavaScript. They are not passwords any more: accounts
   * live in the users table with bcrypt hashes, and the real password is
   * whatever was set when the database was seeded. So the page filled the
   * box with a value that could only ever be rejected, the user pressed
   * "Sign in as Administrator", and got "Incorrect email or password" -
   * which was correct, and completely misleading.
   *
   * The fix is not to reveal the real password (it must not be in the UI at
   * all) and not to weaken the check. The page simply stops asserting a
   * password it cannot honour: the box is cleared, and the panel says where
   * credentials come from instead of stating one.
   *
   * The panel keeps its position, its classes and its styling. Only the
   * sentence inside it changes, because the sentence is the bug.
   * ------------------------------------------------------------------ */

  // Exactly the values prototype.html ships. A password box is cleared only
  // when it still holds one of these - never when it holds something typed.
  var STALE_DEMO_PASSWORDS = { 'Admin@123': 1, 'Recruiter@123': 1, 'Client@123': 1, 'demo1234': 1 };

  function repairLoginPage() {
    if (location.hash.indexOf('#/login/') !== 0) return;

    var pw = document.querySelector('.auth-form input[name="password"]');
    if (pw && STALE_DEMO_PASSWORDS[pw.value]) {
      pw.value = '';
      // Put the cursor where the person now has to type.
      var email = document.querySelector('.auth-form input[name="email"]');
      if (email && email.value) { try { pw.focus(); } catch (e) {} }
    }

    // There are TWO .demo-box elements on a login page: the credentials
    // panel and the Quick demo login panel. Roles with no entry in
    // ROLE_CREDENTIALS (bde) have no credentials panel at all, so picking
    // the first one blanked their demo account list instead. Match on what
    // the box actually contains.
    var box = [].slice.call(document.querySelectorAll('.auth-form .demo-box'))
      .filter(function (el) { return /password\s*:/i.test(el.textContent || ''); })[0];
    if (box && !box.dataset.tlFixed) {
      box.dataset.tlFixed = '1';
      var email = document.querySelector('.auth-form input[name="email"]');
      var addr = email && email.value ? email.value : 'your account email';
      // Same element, same classes, same place on the page.
      box.innerHTML =
        '<p>Signing in</p><div style="font-size:12.5px;line-height:1.8">' +
        '<b>Email:</b> <span class="mono">' + escapeHtml(addr) + '</span><br>' +
        'Use the password issued for this environment. Passwords are never ' +
        'shown on this page.</div>';
    }
  }

  function escapeHtml(v) {
    return String(v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // afterRender() is the prototype's own post-paint hook, so this runs on
  // every navigation to a login screen without touching any renderer.
  var prevAfterRender = window.afterRender;
  window.afterRender = function () {
    var out = typeof prevAfterRender === 'function'
      ? prevAfterRender.apply(this, arguments) : undefined;
    try { repairLoginPage(); } catch (e) { /* never break a render */ }
    return out;
  };

  /* ------------------------------------------------------------------ *
   * 6. Registration
   * ------------------------------------------------------------------ */

  var prevRegister = window.submitCandidateRegistration;
  if (typeof prevRegister === 'function') {
    window.submitCandidateRegistration = function (ev) {
      if (ev && ev.preventDefault) ev.preventDefault();
      if (typeof window.validateRegisterForm === 'function' && !window.validateRegisterForm()) {
        if (typeof window.toast === 'function') window.toast('Please complete all required fields', '⚠️');
        return;
      }
      var g = function (id) {
        var el = document.getElementById(id);
        return el ? String(el.value || '').trim() : '';
      };
      var name = g('regName'), email = g('regEmail').toLowerCase();
      var password = (document.getElementById('regPassword') || {}).value || '';
      var phone = g('regMobile');

      return api.post('/auth/register', {
        name: name, email: email, password: password, phone: phone,
      }).then(function (res) {
        // Let the prototype's own function build the rich candidate object
        // from every field on the form, then persist it to the new record.
        var candidateId = res.candidateId;
        return refresh().then(function () {
          var profile = collectRegistrationProfile();
          if (!profile) return;
          return api.put('/candidates/' + encodeURIComponent(candidateId), profile)
            .then(function (r) {
              var local = DATA.candidateById(candidateId);
              if (local && r && r.candidate) Object.assign(local, r.candidate);
            })
            .catch(function () { /* the account exists; profile detail can be edited later */ });
        }).then(function () {
          /* ------------------------------------------------------------ *
           * The resume the candidate uploaded on this form.
           *
           * It was parsed to fill the fields, and then dropped. The file
           * was stashed on TL.pendingResume with the comment "uploaded
           * after the account is created" - and nothing ever read it, so
           * the bytes never reached the server and candidates.resume_file
           * stayed null.
           *
           * The visible consequence was elsewhere entirely: Easy Apply
           * checks `c.resumeFile` (prototype.html:12963) and told a
           * candidate who had just uploaded a resume that they had none.
           *
           * Uploading it here is the whole fix. It cannot happen earlier:
           * /uploads/resume requires a session, and during registration
           * there isn't one yet.
           * ------------------------------------------------------------ */
          var pending = TL.pendingResume;
          if (!pending) return;
          TL.pendingResume = null;
          return TL.uploadResume(pending, candidateId)
            .then(function () { return refresh(); })
            .catch(function (err) {
              // The account exists and the profile is saved; only the file
              // failed. Say so plainly instead of failing the registration.
              if (typeof window.toast === 'function') {
                window.toast('Your account was created, but the resume could not be saved — ' +
                             'please upload it again from your profile.', '\u26a0\ufe0f');
              }
              if (TL.debug) console.error('TeamLink: resume upload after registration failed', err);
            });
        }).then(function () {
          if (typeof window.toast === 'function') {
            window.toast('Profile created — welcome to TeamLink!', '🎉');
          }
          window.navigate('/candidate/home');
        });
      }).catch(function (err) {
        // A field problem names itself; anything else falls back to the
        // normal toast.
        if (!showFieldErrors(err)) say(err);
        if (typeof window.validateRegisterForm === 'function') window.validateRegisterForm();
      });
    };
  }

  /**
   * Reads the registration form into the candidate shape the API accepts.
   * Requirement 9: whatever could not be parsed stays editable and is
   * saved as-is rather than causing the record to be discarded.
   */
  function collectRegistrationProfile() {
    var g = function (id) {
      var el = document.getElementById(id);
      return el ? String(el.value || '').trim() : '';
    };
    var typeEl = document.querySelector('input[name="regCandidateType"]:checked');
    var out = {
      location: g('regLocation'),
      currentCompany: g('regCompany'),
      title: g('regDesignation'),
      candidateType: typeEl ? typeEl.value : undefined,
    };
    var exp = Number(g('regTotalExp') || 0);
    if (exp > 0) { out.expYears = exp; out.exp = exp + ' yrs'; }

    var modes = [].slice.call(
      document.querySelectorAll('.opt-row input[type="checkbox"]:checked'))
      .map(function (cb) { return cb.value; });
    if (modes.length) out.preferredWorkModes = modes;

    Object.keys(out).forEach(function (k) {
      if (out[k] === '' || out[k] === undefined) delete out[k];
    });
    return Object.keys(out).length ? out : null;
  }

  /* ------------------------------------------------------------------ *
   * 6b. Registration: say WHICH field, and agree with the server
   *
   * Reported as "uploading a resume breaks Create account". The resume was
   * not the cause. Two faults combined to make it look like one:
   *
   * 1. THE RULES DISAGREED. validateRegisterForm() accepts a password of
   *    six characters (prototype.html:2470, and the field's own hint says
   *    "At least 6 characters"). The server requires EIGHT, with at least
   *    one letter and one digit. So a password like "Sravanthi" passes the
   *    form, enables the button, and is then refused.
   *
   * 2. THE REASON WAS DISCARDED. The API answers with the field and the
   *    reason - {"password":"Password must contain at least one letter and
   *    one number."} - but say() shows only the generic sentence, so the
   *    candidate sees "Please check the highlighted fields and try again."
   *    with nothing highlighted and no idea which field. Having just
   *    uploaded a resume, the obvious conclusion is that the resume did it.
   *
   * Neither is fixed by relaxing anything: the client now applies the
   * SAME rule as the server, states it, and when the server does reject
   * something the actual message is shown against the actual field.
   * ------------------------------------------------------------------ */

  /** Exactly the server's rule (registerSchema in api/src/routes/auth.js). */
  function passwordProblem(pw) {
    var p = String(pw || '');
    if (p.length < 8) return 'Password must be at least 8 characters.';
    if (!/[A-Za-z]/.test(p) || !/\d/.test(p)) {
      return 'Password must contain at least one letter and one number.';
    }
    return null;
  }

  var prevValidateRegister = window.validateRegisterForm;
  if (typeof prevValidateRegister === 'function') {
    window.validateRegisterForm = function () {
      var ok = prevValidateRegister.apply(this, arguments);

      var el = document.getElementById('regPassword');
      if (!el) return ok;
      var problem = passwordProblem(el.value);

      // The field's own error line and placeholder state a rule that is not
      // the rule. Correcting the sentence is the fix; the element, its
      // classes and its position are untouched.
      var err = document.getElementById('regPasswordErr');
      if (err) {
        err.textContent = problem || 'Password must be at least 8 characters, with a letter and a number.';
        err.classList.toggle('show', !!(el.value && problem));
      }
      if (el.placeholder === 'At least 6 characters') {
        el.placeholder = 'At least 8 characters, with a letter and a number';
      }

      if (problem) {
        var btn = document.getElementById('regSubmitBtn');
        if (btn) { btn.disabled = true; btn.setAttribute('aria-disabled', 'true'); }
        return false;
      }
      return ok;
    };
  }

  /**
   * Which input a server-side field name belongs to, so a rejection can
   * point at something the candidate can see.
   */
  var FIELD_INPUT = {
    name: 'regName', email: 'regEmail', password: 'regPassword', phone: 'regMobile',
  };

  /**
   * Shows the server's own per-field messages.
   *
   * VALIDATION_FAILED carries `details`; without this they are dropped and
   * every field problem reads identically.
   */
  function showFieldErrors(err) {
    var details = err && err.details;
    if (!details || typeof details !== 'object') return false;

    var names = Object.keys(details);
    if (!names.length) return false;

    var first = null;
    names.forEach(function (field) {
      var id = FIELD_INPUT[field];
      var el = id && document.getElementById(id);
      if (el) {
        var errEl = document.getElementById(id + 'Err');
        if (errEl) { errEl.textContent = details[field]; errEl.classList.add('show'); }
        if (!first) { first = el; }
      }
    });

    if (first && typeof first.focus === 'function') { try { first.focus(); } catch (e) {} }

    if (typeof window.toast === 'function') {
      // The reason, not the fact that there is one.
      window.toast(names.map(function (f) { return details[f]; }).join(' '), '⚠️');
    }
    return true;
  }
  TL.showFieldErrors = showFieldErrors;

  /* ------------------------------------------------------------------ *
   * 6c. Recommended Jobs, removed from the candidate portal
   *
   * Asked for directly. There are THREE ways in, and leaving any of them
   * would put the screen back in front of a candidate:
   *
   *   1. the sidebar item          NAV_CONFIG.candidate -> 'recommended'
   *   2. the top tab               cpShell() appends "★ Recommended"
   *   3. the "View all" link       on the candidate home page
   *
   * The route itself is also closed, so a bookmark or a typed URL lands
   * somewhere sensible instead of on a page that is no longer offered.
   *
   * Nothing is deleted from the prototype: the page and its code remain,
   * unreferenced, so this is one small change to undo if it is wanted back.
   * ------------------------------------------------------------------ */

  if (typeof NAV_CONFIG === 'object' && NAV_CONFIG && Array.isArray(NAV_CONFIG.candidate)) {
    NAV_CONFIG.candidate = NAV_CONFIG.candidate.filter(function (item) {
      return item && item[0] !== 'recommended';
    });
  }

  // The top tab is appended by cpShell, which the prototype already wraps
  // once itself; wrapping it again is the established pattern here.
  var prevCpShell = window.cpShell;
  if (typeof prevCpShell === 'function') {
    window.cpShell = function () {
      var html = prevCpShell.apply(this, arguments);
      return String(html)
        // the tab, however its `on` class happens to be set
        .replace(/<a[^>]*onclick="tlNavGo\('#\/candidate\/recommended'\)"[^>]*>[\s\S]*?<\/a>/g, '')
        // the "View all" link beside "Recommended for you" on the home page
        .replace(/<a[^>]*href="#\/candidate\/recommended"[^>]*>[\s\S]*?<\/a>/g, '');
    };
  }

  /**
   * And close the route.
   *
   * render() is already wrapped for the BDE screens; this adds one more
   * case in front of it. A candidate who still has the link goes to their
   * job search, which is what Recommended was a filtered view of.
   */
  var realRenderForRecommended = window.render;
  window.render = function () {
    if (/^#\/candidate\/recommended\b/.test(String(location.hash || ''))) {
      window.navigate('/candidate/search');
      return;
    }
    return realRenderForRecommended.apply(this, arguments);
  };

  /* ------------------------------------------------------------------ *
   * 6d. Where the candidate came from
   *
   * A requirement is posted to Naukri, LinkedIn, Indeed, Shine and the
   * portal. Every one of those "Apply Now" buttons lands the candidate
   * here - so by the time an application is created, the only record of
   * which board sent them is whatever we captured on arrival.
   *
   * Nothing captured it. applyToJob() sent `source: 'portal'` for
   * everyone, so the ATS said TeamLink for every application and
   * source-wise reporting was meaningless.
   *
   * THE SOURCE MUST SURVIVE THE JOURNEY, which is not a single page load:
   *
   *     naukri.com -> /?src=naukri -> login or register -> job -> apply
   *
   * It is therefore captured on arrival and kept in sessionStorage, which
   * is per-tab and survives the navigations in between without following
   * the candidate around forever. localStorage would be wrong: a Naukri
   * visit in March should not label an application made from the portal
   * in June.
   * ------------------------------------------------------------------ */

  var SOURCE_KEY = 'tl_arrival_source';

  /** The sources the ATS reports on. Anything else is recorded as-is. */
  var KNOWN_SOURCES = {
    naukri: 'naukri', linkedin: 'linkedin', indeed: 'indeed', shine: 'shine',
    monster: 'monster', glassdoor: 'glassdoor', instahyre: 'instahyre',
    referral: 'referral', recruiter: 'recruiter', teamlink: 'teamlink',
    portal: 'teamlink', direct: 'teamlink',
    // An alert we sent is its own source, not "the portal".
    job_alert: 'job_alert', 'job alert': 'job_alert',
  };

  /** naukri.com, in.linkedin.com, www.indeed.co.in -> the source name. */
  function sourceFromHost(host) {
    var h = String(host || '').toLowerCase();
    if (!h) return null;
    var names = Object.keys(KNOWN_SOURCES);
    for (var i = 0; i < names.length; i++) {
      if (h.indexOf(names[i]) >= 0) return KNOWN_SOURCES[names[i]];
    }
    return null;
  }

  function normaliseSource(raw) {
    var v = String(raw || '').trim().toLowerCase();
    if (!v) return null;
    if (KNOWN_SOURCES[v]) return KNOWN_SOURCES[v];
    // "Naukri.com", "LinkedIn Jobs" and a bare hostname all arrive here.
    var byHost = sourceFromHost(v);
    if (byHost) return byHost;
    return v.replace(/[^a-z0-9_-]+/g, '-').slice(0, 40) || null;
  }

  /**
   * Tell the server the alert was opened.
   *
   * Sent once per arrival and never retried: a click is worth recording,
   * and it is not worth interrupting somebody's job hunt over. It runs
   * before login on purpose - the candidate follows the link from their
   * email, which is where they are least likely to be signed in.
   */
  function recordAlertClick(matchId) {
    if (!matchId) return;
    try {
      var key = 'tl_alert_clicked_' + matchId;
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, '1');
    } catch (e) { /* private mode: at worst the click is recorded twice */ }

    api.post('/job-matches/' + encodeURIComponent(matchId) + '/clicked', {})
      .catch(function () { /* never surface this to the candidate */ });
  }

  /**
   * Reads the source from the URL, remembers it, and returns it.
   *
   * An explicit parameter always beats the referrer: a board that tags its
   * links is telling us something definite, while a referrer is a guess
   * that breaks the moment somebody uses a link shortener.
   */
  function captureSource() {
    var q = location.search || '';
    var hash = String(location.hash || '');
    // Boards use different names, and some put it after the hash.
    var m = /[?&](?:src|source|utm_source|ref)=([^&]+)/i.exec(q) ||
            /[?&](?:src|source|utm_source|ref)=([^&]+)/i.exec(hash);

    var found = m ? normaliseSource(decodeURIComponent(m[1])) : null;
    var how = found ? 'link' : null;

    // A job alert we sent. Recorded as the source in its own right,
    // because "did the alerts produce applications" is the only question
    // that says whether the feature is worth running - and an alert
    // filed under "TeamLink Portal" cannot answer it.
    var alert = /[?&]alert=([^&#]+)/i.exec(q) || /[?&]alert=([^&#]+)/i.exec(hash);
    if (alert) {
      found = 'job_alert';
      how = 'alert';
      TL.alertId = decodeURIComponent(alert[1]);
      recordAlertClick(TL.alertId);
    }

    if (!found) {
      // No tag: fall back to who sent them, but only for a board we know.
      try {
        if (document.referrer) {
          var ref = new URL(document.referrer);
          if (ref.host !== location.host) {
            found = sourceFromHost(ref.host);
            if (found) how = 'referrer';
          }
        }
      } catch (e) { /* an opaque or malformed referrer tells us nothing */ }
    }

    if (found) {
      try {
        sessionStorage.setItem(SOURCE_KEY, JSON.stringify({
          source: found, how: how, at: new Date().toISOString(),
        }));
      } catch (e) { /* private mode: it stays in memory for this page */ }
      TL.arrival = { source: found, how: how };
      return found;
    }

    try {
      var kept = JSON.parse(sessionStorage.getItem(SOURCE_KEY) || 'null');
      if (kept && kept.source) { TL.arrival = kept; return kept.source; }
    } catch (e) { /* nothing kept */ }

    return TL.arrival ? TL.arrival.source : null;
  }

  /** What an application should record. Never null - unknown means direct. */
  TL.applicationSource = function () {
    return captureSource() || 'teamlink';
  };

  // Captured at load, before any navigation can drop the query string.
  captureSource();

  /* ------------------------------------------------------------------ *
   * 7. Applying
   * ------------------------------------------------------------------ */

  // One application per click, per job. Double-clicking Apply Now used to
  // fire two POSTs; the second lost the race and came back 409, so a
  // successful application also showed a failure. Requirement 10.
  var applying = Object.create(null);

  window.applyToJob = function (jobId, viaEasyApply) {
    if (!STATE.session || STATE.session.role !== 'candidate') {
      if (typeof window.toast === 'function') window.toast('Please log in as a candidate to apply');
      window.navigate('/login/candidate');
      return;
    }
    var cid = STATE.session.id;
    if (DATA.hasApplication(cid, jobId)) {
      if (typeof window.toast === 'function') window.toast('You already applied to this role');
      return;
    }
    if (applying[jobId]) return applying[jobId];

    var done = function () { delete applying[jobId]; };

    // The board that sent them, not the page they happen to be on.
    applying[jobId] = api.post('/applications',
        { jobId: jobId, source: TL.applicationSource() })
      .then(function (res) {
        // reconcile the cache with what the server actually recorded
        DATA.applications.push(res.application);
        var job = DATA.jobById(jobId);
        if (job && typeof res.applicants === 'number') job.applicants = res.applicants;
        if (res.notification) TL.notifications.unshift(res.notification);

        // The prototype's post-apply finalizer, which this override used
        // to skip.
        //
        // Skipping it looked harmless - it only builds a local record -
        // but that record is what the whole post-apply experience hangs
        // off: the confirmation screen, the "AI Interview required"
        // notification, the due-date chip, and the ATTEND AI INTERVIEW
        // button. Without it the candidate applied, saw a toast, and had
        // no way to reach the interview at all.
        //
        // It runs with the database's facts: the server's application id
        // is carried on the row it reads, and the deadline is overwritten
        // with the server's immediately below.
        var ranFinalizer = false;
        try {
          if (typeof window.__afterApply === 'function') {
            var c = DATA.candidateById(cid);
            var j = DATA.jobById(jobId);
            window.__afterApply(res.application.id, jobId, cid, c, j, viaEasyApply);
            ranFinalizer = true;
            if (TL.syncInterviewDeadlines) TL.syncInterviewDeadlines();
          }
        } catch (e) {
          console.error('TeamLink: the post-apply record could not be created.', e);
        }

        if (typeof window.toast === 'function' && (viaEasyApply || !ranFinalizer)) {
          window.toast(viaEasyApply
            ? 'Easy Apply submitted using your saved profile & resume — TeamLink AI will screen it next'
            : 'Application submitted — TeamLink AI will screen your resume next', '📨');
        }
        window.render();
      })
      .catch(function (err) {
        // 409 means the database already holds this application - the click
        // did not fail, the cache was simply behind. Adopt the server's view
        // instead of reporting an error for something that is true.
        if (err && err.code === 'DUPLICATE_APPLICATION') {
          return refresh().then(function () {
            if (typeof window.toast === 'function') {
              window.toast('You already applied to this role', 'ℹ️');
            }
          });
        }
        return say(err);
      })
      .then(done, done);

    return applying[jobId];
  };

  /* ------------------------------------------------------------------ *
   * 7b. Resume reading
   *
   * The prototype read resumes in the browser, lazy-loading mammoth and
   * pdf.js from cdnjs. The API's Content-Security-Policy does not allow
   * that origin, so both were refused, and every DOCX and PDF produced the
   * same sentence: "Something went wrong reading this file". The console
   * said `Refused to load ... violates the following Content Security
   * Policy directive`, but nothing surfaced it.
   *
   * Extraction now happens on the server (api/src/resume/), which is also
   * where .doc can actually be parsed and where an AI key can live. The
   * SCREEN IS UNCHANGED: the same button, the same status line, the same
   * "AI Extracted" tags, the same paste-text fallback. Only the source of
   * the text and the fields is different.
   *
   * Requirement 7 needed no work here - applyExtractedField() already
   * refuses to overwrite a field the candidate typed, offering
   * `AI found "X" - click to use` instead. That behaviour is reused as-is.
   * ------------------------------------------------------------------ */

  /** Server field names -> the shape parseResumeText() already returns. */
  function toPrototypeShape(f) {
    return {
      name: f.name || '',
      email: f.email || '',
      phone: f.phone || '',
      location: f.location || '',
      qualification: f.qualification || '',
      currentCompany: f.currentCompany || '',
      jobTitle: f.title || '',
      dob: f.dob || '',
      noticePeriod: f.noticePeriod || '',
      expYears: f.expYears == null ? null : f.expYears,
      skills: f.skills || [],
      certifications: f.certifications || [],
      previousCompanies: f.previousCompanies || [],
      languages: f.languages || [],
      linkedin: f.linkedin || '',
      github: f.github || '',
      portfolio: f.portfolio || '',
    };
  }

  /**
   * The prototype's own parser stays in place for anything that calls it
   * directly; when the server has just returned fields for this exact text,
   * those are used instead. Wrapping here means applyRegisterResumeExtraction
   * - and therefore all of the highlighting, the AI tags and the
   * do-not-overwrite rule - runs completely unchanged.
   */
  var prevParseResumeText = window.parseResumeText;
  if (typeof prevParseResumeText === 'function') {
    window.parseResumeText = function (text) {
      if (TL.lastExtract && TL.lastExtract.text === text && TL.lastExtract.fields) {
        return toPrototypeShape(TL.lastExtract.fields);
      }
      return prevParseResumeText.apply(this, arguments);
    };
  }

  /** Requirement 9: one message per failure, naming what actually happened. */
  var RESUME_MESSAGE = {
    RESUME_UNSUPPORTED_TYPE: null,      // the server's own wording is specific
    RESUME_DOCX_FAILED:      null,
    RESUME_PDF_FAILED:       null,
    RESUME_DOC_FAILED:       null,
    RESUME_NO_TEXT:          null,
    FILE_TOO_LARGE:          null,
    RATE_LIMITED:            'Too many uploads in a row — please wait a minute and try again.',
    OFFLINE:        'You appear to be offline — your resume could not be uploaded.',
    NOT_SERVED:     'This page was opened as a file, so the resume cannot be uploaded. Open it from the TeamLink server.',
    API_UNREACHABLE:'Could not reach the server to read your resume. Please try again in a moment.',
    TIMEOUT:        'Reading your resume took too long. Please try again, or paste the text below.',
  };

  function resumeMessage(err) {
    var code = err && err.code;
    if (RESUME_MESSAGE[code]) return RESUME_MESSAGE[code];
    // The server's message for a parse failure already says what to do
    // about it ("open it in Word and save it as .docx"), so it is shown
    // rather than replaced.
    if (err && err.message) return err.message;
    return 'Your resume could not be read. Please try a different file, or paste the text below.';
  }

  var prevHandleResume = window.handleRegisterResumeFile;
  if (typeof prevHandleResume === 'function') {
    window.handleRegisterResumeFile = function (file) {
      var setStatus = window.setResumeStatus || function () {};
      var nameEl = document.getElementById('regFileName');

      if (!/\.(pdf|docx?|txt)$/i.test(file.name)) {
        setStatus('error', '"' + file.name +
          '" isn\'t a supported format — please upload a PDF, DOC, DOCX or TXT resume.');
        return;
      }
      if (nameEl) nameEl.textContent = '📎 ' + file.name;
      setStatus('loading', 'Reading and analyzing your resume…');

      // Keep the actual bytes with the in-memory record, exactly as before,
      // so the submission carries the file and not just its name.
      if (typeof window.captureRegisterResumeFile === 'function') {
        window.captureRegisterResumeFile(file);
      }

      var fd = new FormData();
      fd.append('resume', file);

      // A large PDF takes longer than an ordinary request.
      return request('POST', '/resume/extract', fd, { timeout: 60000 })
        .then(function (res) {
          TL.lastExtract = res;          // read by the parseResumeText wrap

          var ta = document.getElementById('regResumeText');
          if (ta) ta.value = res.text;   // the paste-text fallback keeps the text

          var count = typeof window.applyRegisterResumeExtraction === 'function'
            ? window.applyRegisterResumeExtraction(res.text) : 0;

          // Two inputs the prototype's own extractor never filled, because
          // its parser did not look for them.
          if (typeof window.applyExtractedField === 'function') {
            if (res.fields.preferredLocation) {
              window.applyExtractedField('regPrefLocation', 'regPrefLocationAiTag',
                res.fields.preferredLocation);
            }
            if (res.fields.expectedSalary) {
              window.applyExtractedField('regExpSalary', 'regExpSalaryAiTag',
                res.fields.expectedSalary);
            }
          }

          // Carry everything the form has no input for onto the record, the
          // way the prototype already does for its own extras.
          STATE.regResumeExtras = Object.assign({}, STATE.regResumeExtras, {
            certifications: res.fields.certifications || [],
            previousCompanies: res.fields.previousCompanies || [],
            linkedin: res.fields.linkedin || '',
            github: res.fields.github || '',
            dob: res.fields.dob || '',
            languages: res.fields.languages || [],
            summary: res.fields.summary || '',
            projects: res.fields.projects || [],
            employmentHistory: res.fields.employmentHistory || [],
            education: res.fields.education || '',
            currentSalary: res.fields.currentSalary || '',
            relevantExpYears: res.fields.relevantExpYears == null ? null : res.fields.relevantExpYears,
            resumeText: res.text,
          });

          if (count > 0) {
            setStatus('success', 'Resume analyzed successfully — ' + count +
              ' field' + (count === 1 ? '' : 's') +
              ' detected. Review the highlighted fields below.');
          } else {
            setStatus('warn', 'We read your resume (' + res.chars +
              ' characters) but couldn\'t confidently detect any details — ' +
              'please fill the form in manually.');
          }
        })
        .catch(function (err) {
          // The text is gone but the FILE is not: it is still attached, and
          // the paste box below is still there. Requirement 10.
          setStatus('error', resumeMessage(err));
          if (TL.debug) console.error('TeamLink: resume extraction failed', err);
        })
        .then(function () {
          if (typeof window.validateRegisterForm === 'function') window.validateRegisterForm();
        });
    };
  }

  /** The "Analyze with AI" button under the paste box, server-side too. */
  var prevAnalyze = window.analyzeRegisterResumeText;
  if (typeof prevAnalyze === 'function') {
    window.analyzeRegisterResumeText = function () {
      var el = document.getElementById('regResumeText');
      var text = el ? el.value : '';
      var setStatus = window.setResumeStatus || function () {};
      if (!text.trim()) {
        if (typeof window.toast === 'function') window.toast('Paste some resume text first, then click Analyze');
        return;
      }
      setStatus('loading', 'Analyzing your pasted resume text…');
      return api.post('/resume/parse', { text: text })
        .then(function (res) {
          TL.lastExtract = { text: res.text, fields: res.fields };
          var count = typeof window.applyRegisterResumeExtraction === 'function'
            ? window.applyRegisterResumeExtraction(res.text) : 0;
          if (count > 0) {
            setStatus('success', 'Resume analyzed successfully — ' + count +
              ' field' + (count === 1 ? '' : 's') + ' detected. Review the highlighted fields below.');
          } else {
            setStatus('warn', "Couldn't detect much from that text — try pasting more of your resume, or fill the fields in manually.");
          }
        })
        .catch(function (err) {
          // The pasted text is untouched; only the analysis failed.
          setStatus('error', resumeMessage(err));
        });
    };
  }

  /* ------------------------------------------------------------------ *
   * 7c. Do not repaint a form somebody is filling in
   *
   * prototype.html:18022 polls localStorage every three seconds, and when
   * the signature of the watched keys changes it calls tlSyncNow(), which
   * ends with render(). That exists so a change made in another tab shows
   * up in this one.
   *
   * On the registration screen it destroys work. render() rebuilds #app
   * from DATA, and the registration form lives entirely in the DOM until
   * it is submitted - so the repaint blanked every field, the resume text
   * and the status line about a second after a resume was read. The
   * extraction had worked; 14 fields had been filled; they were simply
   * wiped, which looked exactly like extraction failing.
   *
   * The sync itself is still useful, so only the REPAINT is deferred, and
   * only while there is unsaved input on screen. The import still runs, so
   * DATA stays current; the next navigation renders it.
   * ------------------------------------------------------------------ */

  /** Anything typed, extracted or picked that a render would discard. */
  function hasUnsavedInput() {
    var form = document.getElementById('regName') || document.getElementById('regEmail');
    if (!form) return false;                      // not on the registration screen
    var ids = ['regName', 'regEmail', 'regMobile', 'regLocation', 'regSkills',
               'regTotalExp', 'regCompany', 'regDesignation', 'regPrefLocation',
               'regExpSalary', 'regResumeText', 'regPassword'];
    for (var i = 0; i < ids.length; i++) {
      var el = document.getElementById(ids[i]);
      if (el && String(el.value || '').trim()) return true;
    }
    return false;
  }

  var prevSyncNow = window.tlSyncNow;
  if (typeof prevSyncNow === 'function') {
    window.tlSyncNow = function (force) {
      if (!force && hasUnsavedInput()) {
        // Let the import happen without the repaint: render is stubbed for
        // the duration of this one call, then restored.
        var realRender = window.render;
        window.render = function () {};
        try { return prevSyncNow.apply(this, arguments); }
        finally { window.render = realRender; }
      }
      return prevSyncNow.apply(this, arguments);
    };
  }

  /* ------------------------------------------------------------------ *
   * 7d. The BDE role
   *
   * A BDE (Business Development Executive) sources candidates and pushes
   * their records into the agency's ATS, which is a separate product.
   *
   * NO NEW SCREENS ARE BUILT HERE, and none are needed. The prototype
   * renders a role's login page from ROLE_META[role] and its sidebar from
   * NAV_CONFIG[role] - both plain objects - and pageRecruiterDash(section)
   * renders every pipeline screen from the signed-in profile. So a BDE gets
   * the existing recruiter screens by adding data, not markup:
   *
   *   ROLE_META.bde      the login page renders itself
   *   NAV_CONFIG.bde     the sidebar renders itself
   *   ROLE_RAIL/TAG      the same accents the other roles use
   *   #/bde/*            routed into the screens that already exist
   *
   * What differs is not the page but the DATA: every query a BDE makes is
   * filtered by the policies in 0010, so they see the pool and the AI
   * interview scores, and cannot edit a candidate or move a pipeline stage.
   * ------------------------------------------------------------------ */

  if (typeof ROLE_META === 'object' && ROLE_META && !ROLE_META.bde) {
    ROLE_META.bde = {
      label: 'BDE',
      chipBg: 'rgba(122,162,247,.20)',
      chipColor: '#a9c1ff',
      title: 'Source candidates and push them to your ATS',
      blurb: 'Search the talent pool, review AI interview scores, and send complete candidate records to the ATS your agency runs on.',
      points: [
        'Full candidate record — profile, resume and AI interview scores',
        'One-click export to your ATS, with every push recorded',
        'Read-only on candidates: sourcing, not pipeline management',
      ],
    };
  }

  if (typeof NAV_CONFIG === 'object' && NAV_CONFIG && !NAV_CONFIG.bde) {
    // The same section names pageRecruiterDash already understands.
    NAV_CONFIG.bde = [
      ['candidates', 'Candidates', '🧑‍🤝‍🧑'],
      ['find-candidates', 'Find Candidates', '🔎'],
      ['applications', 'Applications', '📬'],
      ['jobs', 'Jobs', '💼'],
    ];
  }
  if (typeof ROLE_RAIL === 'object' && ROLE_RAIL) ROLE_RAIL.bde = 'var(--ai-500)';
  if (typeof ROLE_TAGCOLOR === 'object' && ROLE_TAGCOLOR) {
    ROLE_TAGCOLOR.bde = { bg: 'rgba(122,162,247,.22)', c: '#a9c1ff' };
  }

  /**
   * pageRecruiterDash() opens with DATA.recruiterById(STATE.session.id) and
   * derives the whole screen from it. A BDE is not in that table, so the
   * lookup is extended to fall back to their profile - the object has the
   * same shape (id, name, email, companyId), which is all the renderer uses.
   *
   * This is a read-through, not a copy: a BDE is never inserted into
   * DATA.recruiters, so nothing else in the app mistakes one for a recruiter.
   */
  if (window.DATA || typeof DATA !== 'undefined') {
    var prevRecruiterById = DATA.recruiterById;
    DATA.recruiterById = function (id) {
      var found = prevRecruiterById ? prevRecruiterById.call(DATA, id) : null;
      if (found) return found;
      var list = DATA.bdes || [];
      for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
      return found;
    };
    DATA.bdeById = function (id) {
      var list = DATA.bdes || [];
      for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
      return null;
    };
  }

  /**
   * #/bde/<section> -> the existing recruiter screens.
   *
   * The router is a chain of `else if (p0 === ...)` inside render(), which
   * cannot be extended without editing it. Rewriting the hash would change
   * what the address bar says and break the sidebar's active state, so the
   * hash is left alone and the render is delegated instead: when the route
   * is a BDE one, pageRecruiterDash is called for the same section.
   */
  /**
   * dashShell(role, ...) builds the whole frame - sidebar, rail colour, role
   * chip - from NAV_CONFIG[role] and ROLE_RAIL[role], and its nav links are
   * `#/<role>/<section>`. pageRecruiterDash() ends with
   * dashShell('recruiter', ...).
   *
   * So a BDE viewing those screens only needs the role swapped at that one
   * call: the sidebar then comes from NAV_CONFIG.bde and its links point at
   * #/bde/..., instead of sending them to recruiter routes they cannot open.
   */
  /* whoLabel() ends in `return DATA.admin`, so a BDE would appear in the
     sidebar as the administrator. */
  var realWhoLabel = window.whoLabel;
  if (typeof realWhoLabel === 'function') {
    window.whoLabel = function (role) {
      if (role === 'bde') {
        return DATA.bdeById(STATE.session && STATE.session.id) || realWhoLabel.apply(this, arguments);
      }
      return realWhoLabel.apply(this, arguments);
    };
  }

  var realDashShell = window.dashShell;
  if (typeof realDashShell === 'function') {
    window.dashShell = function (role, section, titleHtml, crumb, contentHtml) {
      if (role === 'recruiter' && STATE.session && STATE.session.role === 'bde') {
        return realDashShell.call(this, 'bde', section, titleHtml,
          String(crumb == null ? '' : crumb).replace(/^Recruiter/, 'BDE'), contentHtml);
      }
      return realDashShell.apply(this, arguments);
    };
  }

  /**
   * #/bde/<section> renders the existing screens.
   *
   * render()'s router is a chain of `else if (p0 === ...)` that cannot be
   * extended without editing it, and rewriting the hash to #/recruiter/...
   * would both lie in the address bar and break the sidebar's active state.
   * So the hash is left alone and the render is delegated.
   */
  var realRenderForBde = window.render;
  window.render = function () {
    var parts = String(location.hash || '').replace(/^#\/?/, '').split('/').filter(Boolean);
    if (parts[0] !== 'bde') return realRenderForBde.apply(this, arguments);

    if (!STATE.session || STATE.session.role !== 'bde') {
      window.navigate('/login/bde');
      return;
    }
    try {
      var html = window.pageRecruiterDash(parts[1] || 'candidates', {});
      document.getElementById('app').innerHTML = html;
      window.scrollTo(0, 0);
      if (typeof window.afterRender === 'function') window.afterRender();
    } catch (err) {
      // Never leave a blank screen.
      console.error('TeamLink: the BDE screen could not be rendered', err);
      return realRenderForBde.apply(this, arguments);
    }
  };

  /* ---- pushing a candidate to the ATS ------------------------------- *
   *
   * Exposed on TL rather than wired to a new button, because there is no
   * BDE-specific control in the prototype to wire it to and adding one
   * would be a UI change. The export is available from the console and
   * from the API; the screen for it is a separate, deliberate piece of
   * work.
   * ------------------------------------------------------------------ */
  TL.ats = {
    /** What this candidate looks like to the ATS, without sending anything. */
    preview: function (candidateId, applicationId) {
      var q = applicationId ? '?applicationId=' + encodeURIComponent(applicationId) : '';
      return api.get('/ats/payload/' + encodeURIComponent(candidateId) + q)
        .then(function (r) { return r.payload; });
    },

    destinations: function () {
      return api.get('/ats/destinations').then(function (r) { return r.destinations; });
    },

    /** Sends, records the attempt, and reports what actually happened. */
    push: function (candidateId, opts) {
      opts = opts || {};
      return api.post('/ats/push', {
        candidateId: candidateId,
        applicationId: opts.applicationId || null,
        destination: opts.destination || 'download',
      }).then(function (res) {
        if (typeof window.toast === 'function') {
          window.toast(res.status === 'delivered'
            ? 'Candidate record sent — export ' + res.exportId
            : res.status === 'not_configured'
              ? 'No ATS is configured — the record was recorded but not sent'
              : 'The ATS refused the record: ' + (res.detail || 'unknown reason'),
            res.status === 'delivered' ? '📤' : '⚠️');
        }
        return res;
      }).catch(function (err) { say(err); throw err; });
    },

    history: function () {
      return api.get('/ats/exports').then(function (r) { return r.exports; });
    },
  };

  /* ------------------------------------------------------------------ *
   * 8. Pipeline moves
   * ------------------------------------------------------------------ */

  window.moveApplicationStage = function (appId, newStageId) {
    var found = typeof window.findAppRecord === 'function' ? window.findAppRecord(appId) : null;
    if (!found) return;

    // `primary__<candId>` is the prototype's synthetic id for the
    // application it stored on the candidate row. The database has a real
    // row for it; TL.primaryAppId holds the mapping (DATA-MAPPING §3.1).
    var realId = appId.indexOf('primary__') === 0
      ? TL.primaryAppId[found.candId]
      : appId;

    if (!realId) {
      say(new ApiFailure('NOT_FOUND', 'That application could not be found on the server.'));
      return;
    }

    var before = found.record.stage;
    found.record.stage = newStageId;          // optimistic
    var cand = DATA.candidateById(found.candId);
    if (typeof window.toast === 'function') {
      window.toast(cand.name + ' moved to "' + DATA.stageMeta(newStageId).label + '"', '➡️');
    }
    window.render();

    return api.put('/applications/' + encodeURIComponent(realId) + '/status',
      { stage: newStageId })
      .catch(function (err) {
        found.record.stage = before;          // roll back — the DB said no
        say(err);
        window.render();
      });
  };

  /* ------------------------------------------------------------------ *
   * 9. Resume upload
   * ------------------------------------------------------------------ */

  TL.uploadResume = function (file, candidateId) {
    var fd = new FormData();
    fd.append('resume', file);
    if (candidateId) fd.append('candidateId', candidateId);
    return request('POST', '/uploads/resume', fd).then(function (res) {
      var local = DATA.candidateById(res.candidate.id);
      if (local) Object.assign(local, res.candidate);
      return res;
    });
  };

  // The prototype parses the file locally to drive its extraction UI.
  // That flow is left exactly as it is; the bytes are additionally sent to
  // the server so the resume actually persists (requirement 8).
  var prevResume = window.handleRegisterResumeFile;
  if (typeof prevResume === 'function') {
    window.handleRegisterResumeFile = function (file) {
      var out = prevResume.apply(this, arguments);
      if (file && STATE.session && STATE.session.role === 'candidate') {
        TL.uploadResume(file).catch(say);
      } else if (file) {
        TL.pendingResume = file;      // uploaded after the account is created
      }
      return out;
    };
  }

  /* ------------------------------------------------------------------ *
   * 9b. Replacing the resume from the profile
   *
   * handleResumeFileSelected() (prototype.html:3662) runs the profile
   * page's "Upload resume" button. Two things were wrong with it once
   * there was a real backend:
   *
   *   THE FILE WENT NOWHERE. Like the registration upload before it, the
   *   bytes were never sent, so candidates.resume_file kept pointing at
   *   the OLD resume - or at nothing. A candidate who replaced their CV
   *   went on applying with the previous one.
   *
   *   THE EXTRACTION WAS NOT AN EXTRACTION. It called
   *   buildResumeExtraction(cand, file.name), which assembles the "parsed"
   *   fields from the candidate record that is already on screen. Upload a
   *   blank file and it reports your existing details back to you as
   *   freshly extracted. The file name was the only thing that came from
   *   the file.
   *
   * Both now go through the same server path registration uses: the file
   * is read by api/src/resume/, its real fields fill the review form, and
   * the bytes are stored against the candidate. The review screen, its
   * progress steps and its confirm flow are untouched.
   * ------------------------------------------------------------------ */

  /** Server field names -> the keys the review form expects. */
  function toReviewDraft(fields, fileName) {
    var join = function (v) { return Array.isArray(v) ? v.join(', ') : (v || ''); };
    return {
      fileName: fileName,
      name: fields.name || '',
      email: fields.email || '',
      phone: fields.phone || '',
      location: fields.location || '',
      title: fields.title || '',
      currentCompany: fields.currentCompany || '',
      previousCompanies: join(fields.previousCompanies),
      exp: fields.expYears != null ? String(fields.expYears) + ' yrs' : '',
      noticePeriod: fields.noticePeriod || '',
      ctc: fields.currentSalary || '',
      expectedCtc: fields.expectedSalary || '',
      education: fields.education || '',
      skills: join(fields.skills),
      technicalSkills: join(fields.skills),
      certifications: join(fields.certifications),
      languages: join(fields.languages),
      linkedin: fields.linkedin || '',
      github: fields.github || '',
      portfolio: '',
      summary: fields.summary || '',
      projects: join(fields.projects),
    };
  }

  var prevProfileResume = window.handleResumeFileSelected;
  if (typeof prevProfileResume === 'function') {
    window.handleResumeFileSelected = function (file) {
      var cand = typeof window.currentCandidate === 'function' ? window.currentCandidate() : null;
      if (!cand || !file) return;

      // The prototype's own progress screen, unchanged.
      STATE.resumeReview = { status: 'extracting', fileName: file.name, progress: 0 };
      window.render();

      var fd = new FormData();
      fd.append('resume', file);

      return request('POST', '/resume/extract', fd, { timeout: 60000 })
        .then(function (res) {
          // Store the file itself, so Easy Apply and the recruiter see the
          // NEW resume rather than the one it replaced.
          return TL.uploadResume(file, cand.id).then(function () { return res; });
        })
        .then(function (res) {
          return refresh().then(function () { return res; });
        })
        .then(function (res) {
          var draft = toReviewDraft(res.fields || {}, file.name);
          var extracted = new Set(Object.keys(draft).filter(function (k) {
            return k !== 'fileName' && String(draft[k]).trim() !== '';
          }));
          STATE.resumeReview = { status: 'review', fileName: file.name, draft: draft, aiExtracted: extracted };
          if (typeof window.toast === 'function') {
            window.toast('Resume parsed — review your auto-filled profile below', '🤖');
          }
          window.render();
        })
        .catch(function (err) {
          // Back to the page, with the reason. Never the fabricated draft.
          STATE.resumeReview = null;
          window.render();
          if (typeof window.toast === 'function') {
            window.toast(resumeMessage(err), '⚠️');
          }
          if (TL.debug) console.error('TeamLink: profile resume upload failed', err);
        });
    };
  }

  /* ------------------------------------------------------------------ *
   * 9c. The Resume page: the document first, then what was read from it
   *
   * The page is not rebuilt. It already has the right bones - a summary
   * panel, an "AI-extracted skills" panel of .skill-tag chips, and an
   * "Extracted profile details" panel - so this fills them with what the
   * parser actually found and adds the parts that were missing, using the
   * page's own classes. No new colours, fonts or spacing.
   *
   * What changes:
   *
   *   - the summary states the real upload time, parse status, and a
   *     confidence COMPUTED from this file (0013), not an administrator's
   *     global setting
   *   - a candidate with no resume is told so, instead of being shown a
   *     "Parsed" badge over three empty tiles
   *   - a failed parse says so, and offers the two things worth doing
   *   - the actions a candidate expects - view, download, replace, re-parse
   *   - the preferences the portal collected at registration (work mode,
   *     expected salary, notice period) appear where they can be checked
   *   - LinkedIn, Naukri and Indeed can be pasted in and are saved
   * ------------------------------------------------------------------ */

  var esc = function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var dash = function (v) {
    if (Array.isArray(v)) return v.length ? v.join(', ') : '—';
    return String(v == null ? '' : v).trim() || '—';
  };
  var when = function (iso) {
    if (!iso) return '—';
    try {
      var d = new Date(iso);
      return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) +
             ' · ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    } catch (e) { return String(iso); }
  };

  /** One `.kv .item` tile, in the page's own markup. */
  function tile(label, value, size) {
    return '<div class="item"><div class="k">' + esc(label) + '</div>' +
           '<div class="v" style="font-size:' + (size || '13px') +
           ';word-break:break-word">' + esc(value) + '</div></div>';
  }

  function resumeSummaryHtml(me) {
    var p = me.resumeParse || {};
    var status = !me.resumeFile ? 'Not uploaded'
               : p.error ? 'Could not be read'
               : p.parsedAt ? 'Parsed' : 'Stored';

    var tiles = [
      tile('Uploaded', when(me.resumeUploadedAt), '12.5px'),
      tile('Parse status', status, '12.5px'),
    ];
    // Only stated when it was measured. An unparsed file has no score.
    if (p.confidence != null) {
      tiles.push(tile('Parse confidence', p.confidence + '%', '13px'));
      tiles.push(tile('Fields detected', String(p.fieldsDetected == null ? '—' : p.fieldsDetected), '13px'));
    }
    tiles.push(tile('Total experience', dash(me.exp)));
    tiles.push(tile('Highest education', dash(String(me.education || '').split(',')[0]), '12.5px'));
    tiles.push(tile('Current job title', dash(me.title)));
    tiles.push(tile('Current company', dash(me.currentCompany)));
    tiles.push(tile('Skills', ((me.skills || []).length) + ' detected'));

    return '<div class="kv">' + tiles.join('') + '</div>';
  }

  function resumeActionsHtml(me) {
    if (!me.resumeFile) {
      return '<div style="margin-top:14px;display:flex;gap:10px;flex-wrap:wrap">' +
             '<button class="btn btn-primary btn-sm" onclick="triggerResumeUpload()">📄 Upload resume</button></div>';
    }
    return '<div style="margin-top:14px;display:flex;gap:10px;flex-wrap:wrap">' +
      '<button class="btn btn-ghost btn-sm" onclick="TL.resume.view()">👁 View resume</button>' +
      '<button class="btn btn-ghost btn-sm" onclick="TL.resume.download()">⬇ Download</button>' +
      '<button class="btn btn-ghost btn-sm" onclick="TL.resume.reparse()">↺ Re-parse with AI</button>' +
      '<button class="btn btn-primary btn-sm" onclick="TL.resume.replace()">📄 Replace resume</button>' +
      '<button class="btn btn-ghost btn-sm" onclick="navigate(\'/candidate/profile\')">✎ Edit profile</button>' +
      '</div>';
  }

  function parseFailureHtml(p) {
    return '<div class="req-note" style="margin-top:12px">' +
      'We couldn’t extract all details from this resume. ' + esc(p.error || '') +
      '<div style="margin-top:10px;display:flex;gap:10px;flex-wrap:wrap">' +
      '<button class="btn btn-ghost btn-sm" onclick="TL.resume.reparse()">Try again</button>' +
      '<button class="btn btn-primary btn-sm" onclick="TL.resume.replace()">Upload another resume</button>' +
      '</div></div>';
  }

  /** 2800000 -> "28 LPA (₹28,00,000)" - the way it is actually spoken here. */
  function money(v) {
    var n = Number(v);
    if (!isFinite(n) || n <= 0) return '—';
    var lakhs = n / 100000;
    var pretty = n.toLocaleString('en-IN');
    return (lakhs >= 1 ? (Math.round(lakhs * 10) / 10) + ' LPA (₹' + pretty + ')'
                       : '₹' + pretty);
  }

  /** What the portal asked for at registration, where it can be checked. */
  function preferencesHtml(me) {
    var modes = (me.preferredWorkModes || []);
    return '<div class="panel"><div class="panel-head"><h2>Work preferences</h2>' +
      '<div class="desc">Collected when you registered — recruiters match on these</div></div>' +
      '<div class="panel-body"><div class="kv">' +
      tile('Work mode', modes.length ? modes.join(', ') : '—', '12.5px') +
      tile('Expected salary', money(me.expectedCtc), '12.5px') +
      tile('Current salary', money(me.ctc), '12.5px') +
      tile('Notice period', dash(me.noticePeriod), '12.5px') +
      tile('Preferred location', dash(me.preferredLocation), '12.5px') +
      tile('Current location', dash(me.location), '12.5px') +
      '</div>' +
      '<div style="margin-top:12px"><button class="btn btn-ghost btn-sm" ' +
      'onclick="navigate(\'/candidate/profile\')">✎ Edit these</button></div>' +
      '</div></div>';
  }

  /** Profile links, including the two this market actually uses. */
  function linksHtml(me) {
    var row = function (id, label, placeholder, value) {
      return '<div class="fgroup"><label>' + esc(label) + '</label>' +
        '<input id="' + id + '" type="url" placeholder="' + esc(placeholder) + '" value="' +
        esc(value || '') + '" style="width:100%"></div>';
    };
    return '<div class="panel"><div class="panel-head"><h2>Profile links</h2>' +
      '<div class="desc">Paste your profile URLs — recruiters open these alongside your resume</div></div>' +
      '<div class="panel-body">' +
      '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px">' +
      row('tlLinkLinkedin', 'LinkedIn', 'https://linkedin.com/in/your-name', me.linkedin) +
      row('tlLinkNaukri', 'Naukri', 'https://www.naukri.com/mnjuser/profile', me.naukri) +
      row('tlLinkIndeed', 'Indeed', 'https://profile.indeed.com/...', me.indeed) +
      row('tlLinkGithub', 'GitHub', 'https://github.com/you', me.github) +
      '</div>' +
      '<div style="margin-top:12px"><button class="btn btn-primary btn-sm" ' +
      'onclick="TL.resume.saveLinks()">Save links</button></div>' +
      '</div></div>';
  }

  function currentCandidateRecord() {
    try {
      if (!STATE.session || STATE.session.role !== 'candidate') return null;
      return DATA.candidateById(STATE.session.id) || null;
    } catch (e) { return null; }
  }

  function enhanceResumePage() {
    if (!/^#\/candidate\/resume\b/.test(String(location.hash || ''))) return;
    var app = document.getElementById('app');
    if (!app) return;

    var panel = app.querySelector('.panel');
    var head = panel && panel.querySelector('.panel-head');
    var body = panel && panel.querySelector('.panel-body');
    if (!head || !body || head.dataset.tlResume) return;
    // Only the resume panel: it is the one that talks about parsing.
    if (!/parsed|uploaded/i.test(head.textContent || '')) return;

    var me = currentCandidateRecord();
    if (!me) return;
    head.dataset.tlResume = '1';

    var p = me.resumeParse || {};
    var heading = head.querySelector('h2');
    var desc = head.querySelector('.desc');
    var badge = head.querySelector('.badge');

    if (!String(me.resumeFile || '').trim()) {
      if (heading) heading.textContent = 'No resume uploaded yet';
      if (desc) desc.textContent = 'Upload one and TeamLink will read it to fill your profile';
      if (badge) { badge.textContent = 'Not uploaded'; badge.className = 'badge'; }
    } else {
      if (heading) heading.textContent = me.resumeFile;
      if (desc) {
        desc.textContent = p.error
          ? 'Uploaded · could not be read'
          : 'Uploaded · parsed automatically by TeamLink AI';
      }
      if (badge) {
        badge.textContent = p.error ? 'Not parsed' : 'Parsed';
        badge.className = p.error ? 'badge' : 'badge badge-ok';
      }
    }

    body.innerHTML = resumeSummaryHtml(me) +
      (p.error ? parseFailureHtml(p) : '') +
      resumeActionsHtml(me);

    // The preferences and links belong beside the resume, not on another
    // screen: they are the rest of what a recruiter screens on.
    var host = panel.parentElement;
    if (host && !host.querySelector('[data-tl-prefs]')) {
      var wrap = document.createElement('div');
      wrap.setAttribute('data-tl-prefs', '1');
      wrap.innerHTML = preferencesHtml(me) + linksHtml(me);
      host.appendChild(wrap);
    }
  }

  /* ---- the actions -------------------------------------------------- */
  TL.resume = {
    /** Opens the file itself. The endpoint re-checks access server-side. */
    view: function () {
      var me = currentCandidateRecord();
      if (!me) return;
      window.open('/api/candidates/' + encodeURIComponent(me.id) + '/resume', '_blank', 'noopener');
    },

    download: function () {
      var me = currentCandidateRecord();
      if (!me) return;
      var a = document.createElement('a');
      a.href = '/api/candidates/' + encodeURIComponent(me.id) + '/resume?download=1';
      a.download = me.resumeFile || 'resume';
      document.body.appendChild(a);
      a.click();
      a.remove();
    },

    /** Replacing is destructive, so it is confirmed first. */
    replace: function () {
      var me = currentCandidateRecord();
      if (me && me.resumeFile) {
        var ok = window.confirm(
          'Replace "' + me.resumeFile + '"?\n\n' +
          'The new resume will be parsed and your profile details refreshed. ' +
          'Applications you have already submitted keep the resume they were sent with.');
        if (!ok) return;
      }
      if (typeof window.triggerResumeUpload === 'function') window.triggerResumeUpload();
    },

    /**
     * Re-reads the file already on record.
     *
     * The prototype's reparseResume() re-ran its simulated extraction over
     * the profile that was already on screen, so it could never discover
     * anything new. This asks the server to read the stored file again.
     */
    reparse: function () {
      var me = currentCandidateRecord();
      if (!me || !me.resumeFile) {
        if (typeof window.toast === 'function') window.toast('There is no resume on file to re-parse');
        return;
      }
      if (typeof window.toast === 'function') window.toast('Re-reading your resume…', '⏳');
      return api.post('/candidates/' + encodeURIComponent(me.id) + '/resume/reparse', {})
        .then(function () { return refresh(); })
        .then(function () {
          var r = currentCandidateRecord();
          var p = (r && r.resumeParse) || {};
          if (typeof window.toast === 'function') {
            window.toast(p.error
              ? 'Still could not read that file — try uploading another'
              : 'Resume re-parsed — ' + (p.fieldsDetected || 0) + ' fields detected',
              p.error ? '⚠️' : '✅');
          }
          window.render();
        })
        .catch(say);
    },

    saveLinks: function () {
      var me = currentCandidateRecord();
      if (!me) return;
      var val = function (id) {
        var el = document.getElementById(id);
        return el ? String(el.value || '').trim() : '';
      };
      return api.put('/candidates/' + encodeURIComponent(me.id), {
        linkedin: val('tlLinkLinkedin'),
        naukri: val('tlLinkNaukri'),
        indeed: val('tlLinkIndeed'),
        github: val('tlLinkGithub'),
      }).then(function (r) {
        if (r && r.candidate) Object.assign(me, r.candidate);
        if (typeof window.toast === 'function') window.toast('Profile links saved', '✅');
      }).catch(say);
    },
  };

  // The prototype's own re-parse button re-ran a simulation; point it at
  // the real one so both routes do the same thing.
  window.reparseResume = function () { return TL.resume.reparse(); };

  var prevAfterRenderResume = window.afterRender;
  window.afterRender = function () {
    var out = typeof prevAfterRenderResume === 'function'
      ? prevAfterRenderResume.apply(this, arguments) : undefined;
    try { enhanceResumePage(); } catch (e) {
      if (TL.debug) console.error('TeamLink: resume page enhancement failed', e);
    }
    return out;
  };

  /* ------------------------------------------------------------------ *
   * 10. Notifications
   * ------------------------------------------------------------------ */

  TL.markNotificationRead = function (id) {
    return api.put('/notifications/' + encodeURIComponent(id) + '/read', {})
      .then(function (res) {
        var n = (TL.notifications || []).filter(function (x) { return x.id === id; })[0];
        if (n) n.read = true;
        return res;
      }).catch(function () {});
  };

  TL.refreshNotifications = function () {
    if (!TL.session) return Promise.resolve();
    return api.get('/notifications').then(function (res) {
      TL.notifications = res.notifications || [];
      return res;
    }).catch(function () {});
  };

  /* ------------------------------------------------------------------ *
   * 11. Backend-backed candidate search (requirements 10 & 11)
   *
   * Exposed for the Find Candidates screen so filtering happens in SQL
   * with a LIMIT, instead of pulling every candidate into the browser.
   * ------------------------------------------------------------------ */

  TL.searchCandidates = function (filters, page) {
    var qs = [];
    var add = function (k, v) {
      if (v === undefined || v === null || v === '' ||
          (Array.isArray(v) && !v.length)) return;
      qs.push(encodeURIComponent(k) + '=' + encodeURIComponent(Array.isArray(v) ? v.join(',') : v));
    };
    filters = filters || {};
    Object.keys(filters).forEach(function (k) { add(k, filters[k]); });
    add('limit', (page && page.limit) || 25);
    add('offset', (page && page.offset) || 0);

    return api.get('/candidates?' + qs.join('&')).then(function (res) {
      // merge into the cache so DATA.candidateById() resolves for the
      // rows just returned, without discarding anything already loaded
      (res.candidates || []).forEach(function (c) {
        var existing = DATA.candidateById(c.id);
        if (existing) Object.assign(existing, c);
        else DATA.candidates.push(c);
      });
      return res;
    });
  };

  /* ------------------------------------------------------------------ *
   * 11b. Demo fixtures for the two PUBLIC demo screens
   *
   * /ai-pipeline and /whatsapp-demo sit in the public nav and render
   * cand5 and cand4 by id. An anonymous visitor cannot see any candidate
   * now — correctly — so those screens would throw on an undefined
   * record.
   *
   * The fix is NOT to relax the policy. These are marketing simulations,
   * and they get demo data, which is what they always had. The fixtures
   * live in a static file and are consulted ONLY as a last-resort
   * fallback by candidateById(), so they can never reach Find Candidates,
   * a dashboard total, or anyone's pipeline.
   * ------------------------------------------------------------------ */

  var demoById = Object.create(null);
  var demoPromise = null;

  function loadDemoFixtures() {
    if (demoPromise) return demoPromise;
    // The single-file export has no sibling files to fetch, so it carries
    // the fixtures inline. Served normally, this is undefined and the
    // static file is fetched exactly as before.
    demoPromise = (window.TL_DEMO_FIXTURES
      ? Promise.resolve(window.TL_DEMO_FIXTURES)
      : fetch('demo-fixtures.json', { credentials: 'same-origin' })
          .then(function (r) { return r.ok ? r.json() : null; }))
      .then(function (j) {
        if (!j) return;
        demoList = (j.candidates || []).slice();
        demoList.forEach(function (c) { demoById[c.id] = c; });
        if (j.transcripts && typeof DATA.aiInterviewTranscripts === 'object') {
          Object.keys(j.transcripts).forEach(function (k) {
            if (!DATA.aiInterviewTranscripts[k]) DATA.aiInterviewTranscripts[k] = j.transcripts[k];
          });
        }
        if (j.resumeBank && DATA.resumeBank) {
          Object.keys(j.resumeBank).forEach(function (k) {
            if (!DATA.resumeBank[k]) DATA.resumeBank[k] = j.resumeBank[k];
          });
        }
      })
      .catch(function () { /* the demo screens degrade; the app does not */ });
    return demoPromise;
  }
  TL.loadDemoFixtures = loadDemoFixtures;

  // Fallback only — a real record always wins.
  var realCandidateById = DATA.candidateById;
  DATA.candidateById = function (id) {
    return realCandidateById(id) || demoById[id];
  };

  var demoList = [];

  function isDemoRoute() {
    var h = location.hash || '';
    return h.indexOf('#/ai-pipeline') === 0 || h.indexOf('#/whatsapp-demo') === 0;
  }

  /**
   * The demo screens also render a candidate PICKER built from
   * DATA.candidates, which is empty for an anonymous visitor — correctly.
   *
   * For the duration of a demo-screen render, and ONLY then, the fixtures
   * stand in. render() is synchronous, so the swap is restored in the same
   * tick and no other screen can observe it. A signed-in user's real
   * records are put back untouched.
   */
  var renderBeforeDemo = window.render;
  window.render = function () {
    if (!isDemoRoute() || !demoList.length) {
      return renderBeforeDemo.apply(this, arguments);
    }
    var saved = DATA.candidates.slice();
    refill(DATA.candidates, demoList);
    try {
      return renderBeforeDemo.apply(this, arguments);
    } finally {
      refill(DATA.candidates, saved);
    }
  };



  /* ------------------------------------------------------------------ *
   * 13. Find Candidates — filtering moves into SQL (requirements 10, 11)
   *
   * The prototype filtered `DATA.candidates` in the browser. With a real
   * database that means shipping every candidate to every recruiter just
   * to narrow them down, which requirement 11 rules out explicitly.
   *
   * The screen already exposes the seams needed to fix this without
   * touching it:
   *
   *   window.getFilteredCandidates(pool)  the documented pool hook that
   *                                       baseResults() calls (:6502)
   *   window.fcrSet / fcrToggleFacet      every filter change
   *   window.fcrSetPage / fcrSetPageSize  paging
   *
   * So: the server applies the selective filters and returns a bounded
   * window of matches; the existing client chain still runs on top, so
   * saved-search criteria and the local "hide viewed / hide emailed"
   * refinements keep working exactly as before.
   * ------------------------------------------------------------------ */

  TL.fcr = {
    rows: null,        // current server result window, or null before the first query
    total: 0,          // true match count in the database
    capped: false,
    loading: false,
    window: 200,       // how many matches to pull at once
    key: '',           // signature of the last query, to avoid refetching
  };

  /** STATE.fcr -> /api/candidates query string. */
  function fcrQuery(f) {
    var p = [];
    var add = function (k, v) {
      if (v === undefined || v === null || v === '' ||
          (Array.isArray(v) && !v.length)) return;
      p.push(encodeURIComponent(k) + '=' + encodeURIComponent(Array.isArray(v) ? v.join(',') : v));
    };

    // anyKw and allKw are separate controls in the UI; both narrow the
    // same text search server-side.
    var kw = [f.anyKw, f.allKw].filter(Boolean).join(' ').trim();
    add('q', kw);
    add('skills', f.skills);
    add('location', f.locs);
    add('noticePeriod', f.notice);
    add('education', [].concat(f.degs || [], f.edus || []));
    add('industry', f.inds);
    add('expMin', f.expMin);
    add('expMax', f.expMax);
    add('ctcMin', f.salMin);
    add('ctcMax', f.salMax);
    add('includeZeroSalary', f.includeZeroSalary === false ? 'false' : 'true');
    if (f.womenOnly)      add('gender', 'Female');
    if (f.emailOnly)      add('emailVerified', 'true');
    if (f.mobileOnly)     add('mobileVerified', 'true');
    if (f.hideNoResume)   add('hasResume', 'true');
    if (f.hidePrivate)    add('hidePrivate', 'true');
    if (f.hideNoComments) add('hasComments', 'true');
    add('commentTag', f.commentTag);
    if (f.duration && f.duration !== 'all') add('activeWithinDays', f.duration);
    add('sort', f.sortBy);
    add('limit', TL.fcr.window);
    add('offset', 0);
    return p.join('&');
  }

  function onFindScreen() {
    // The route is 'find-candidates'. '#/recruiter/find' renders nothing —
    // matching on that prefix would still be true here, but being exact
    // documents which screen this is actually for.
    return (location.hash || '').indexOf('#/recruiter/find-candidates') === 0;
  }

  /**
   * Fetches a result window if the filters actually changed.
   * Returns a promise so callers can repaint once it lands.
   */
  function fcrFetch(force) {
    var f = STATE.fcr;
    if (!f) return Promise.resolve();
    var qs = fcrQuery(f);
    if (!force && qs === TL.fcr.key && TL.fcr.rows) return Promise.resolve();

    TL.fcr.key = qs;
    TL.fcr.loading = true;

    return api.get('/candidates?' + qs).then(function (res) {
      var rows = res.candidates || [];

      // Re-attach each candidate's pipeline position, exactly as the
      // bootstrap does, so cand.stage and cand.appliedJobId are present on
      // the result rows (DATA-MAPPING §3.1).
      var byId = {};
      rows.forEach(function (c) { byId[c.id] = c; });
      (res.applications || []).forEach(function (a) {
        if (!a.primary) return;
        var c = byId[a.candidateId];
        if (c) { c.appliedJobId = a.jobId; c.stage = a.stage; c.matchScore = a.matchScore; }
      });
      rows.forEach(function (c) {
        if (!c.appliedJobId) { c.appliedJobId = null; c.stage = c.stage || 'registered'; }
      });

      // Merge into the cache so DATA.candidateById() resolves when the
      // recruiter opens a profile from the results.
      rows.forEach(function (c) {
        var existing = DATA.candidates.filter(function (x) { return x.id === c.id; })[0];
        if (existing) Object.assign(existing, c);
        else DATA.candidates.push(c);
      });

      TL.fcr.rows = rows;
      TL.fcr.total = res.total || rows.length;
      TL.fcr.capped = TL.fcr.total > rows.length;
      TL.fcr.loading = false;
    }).catch(function (err) {
      TL.fcr.loading = false;
      TL.fcr.rows = [];
      say(err);
    });
  }
  TL.fcrFetch = fcrFetch;

  // The pool hook. The existing chain is preserved — prevGFC holds the
  // five layers of criteria filters the prototype stacks on top of each
  // other (:9768, :10400, :10672, :13413). It is simply handed the
  // server's result window instead of the entire candidate table.
  var prevGFC = window.getFilteredCandidates;
  window.getFilteredCandidates = function (cands) {
    if (onFindScreen() && TL.fcr.rows) {
      return typeof prevGFC === 'function' ? prevGFC(TL.fcr.rows) : TL.fcr.rows;
    }
    return typeof prevGFC === 'function' ? prevGFC(cands) : cands;
  };

  /**
   * Repaints the results panel after a fetch.
   *
   * refreshResults() lives inside the screen's own IIFE and is not
   * reachable from here, so this re-runs the render path the prototype
   * already uses, which rebuilds the results from the updated pool.
   */
  window.fcrRepaint = function () {
    if (onFindScreen() && typeof window.render === 'function') window.render();
  };

  // Every filter change goes through these. Each updates STATE.fcr and
  // paints immediately (as before), then refetches and repaints.
  function wrapFcr(name) {
    var prev = window[name];
    if (typeof prev !== 'function') return;
    window[name] = function () {
      var r = prev.apply(this, arguments);
      fcrFetch().then(function () { window.fcrRepaint(); });
      return r;
    };
  }
  ['fcrSet', 'fcrToggleFacet', 'fcrHideReset', 'fcrReset', 'fcrClearAll']
    .forEach(wrapFcr);

  // Paging and page size are handled client-side within the fetched
  // window, so they need no round trip and are left alone.

  // The first visit to the screen needs an initial query.
  var renderBeforeFcr = window.render;
  window.render = function () {
    var out = renderBeforeFcr.apply(this, arguments);
    if (onFindScreen() && !TL.fcr.rows && !TL.fcr.loading) {
      fcrFetch(true).then(function () { renderBeforeFcr.call(window); });
    }
    return out;
  };

  // Leaving the screen clears the window, so returning re-queries rather
  // than showing a stale result set.
  window.addEventListener('hashchange', function () {
    if (!onFindScreen()) { TL.fcr.rows = null; TL.fcr.key = ''; }
  });

  /* ------------------------------------------------------------------ *
   * 14. Interview scheduling
   *
   * mjScheduleInterview() pushed straight into DATA.interviews, so a
   * scheduled interview lived only in that browser tab. It now creates a
   * real row; the API also moves the application to interview_scheduled
   * and notifies the candidate in the same transaction, so the three can
   * never disagree.
   * ------------------------------------------------------------------ */

  TL.scheduleInterview = function (opts) {
    return api.post('/interviews', {
      candidateId: opts.candidateId,
      jobId: opts.jobId,
      type: opts.type || 'Technical (Human)',
      date: opts.date,
      time: opts.time,
      mode: opts.mode || 'Video Call',
      interviewer: opts.interviewer,
    }).then(function (res) {
      DATA.interviews.push(res.interview);
      return res.interview;
    });
  };

  var prevSchedule = window.mjScheduleInterview;
  if (typeof prevSchedule === 'function') {
    window.mjScheduleInterview = function (appId, jobId) {
      var date = String((document.getElementById('mjIvDate') || {}).value || '');
      var time = String((document.getElementById('mjIvTime') || {}).value || '');
      if (!date || !time) {
        if (typeof window.toast === 'function') window.toast('Pick an interview date and time', '⚠️');
        return;
      }
      var mode = String((document.getElementById('mjIvMode') || {}).value || 'Video Call');

      var f = typeof window.findAppRecord === 'function' ? window.findAppRecord(appId) : null;
      var c = f ? DATA.candidateById(f.candId) : null;
      var j = DATA.jobById(jobId);
      if (!c || !j) return;

      var who = (typeof window.whoLabel === 'function' && window.whoLabel('recruiter')) || {};

      return TL.scheduleInterview({
        candidateId: c.id, jobId: j.id, date: date, time: time, mode: mode,
        interviewer: who.name || undefined,
      }).then(function () {
        // The API already moved the stage and raised the notification, so
        // the local record is updated directly rather than calling
        // moveApplicationStage() — which would send a second request.
        if (f && f.record) f.record.stage = 'interview_scheduled';
        if (typeof window.toast === 'function') {
          window.toast('Interview scheduled for ' + c.name + '.', '🗓️');
        }
        if (typeof window.fcrCloseModal === 'function') window.fcrCloseModal();
        if (typeof window.render === 'function') window.render();
      }).catch(say);
    };
  }

  /* ------------------------------------------------------------------ *
   * 15. Disable the prototype's own direct-to-Supabase path
   *
   * The file already contains a partial Supabase integration (TL_SUPA /
   * TL_API, :21156) pointing at project `ohamvhilaljvkjpzaaln`, which
   * fetches jobs straight from the browser.
   *
   * The key there is a PUBLISHABLE one and the code explicitly refuses
   * service_role keys, so it was not a credential leak. But it is now a
   * SECOND source of truth for jobs, against a different database — which
   * is exactly what requirement 17 rules out, and it means the browser
   * talking to a database directly, which requirement 2 rules out.
   *
   * TL_API.configured() gates on TL_SUPA.url and falls back to reading
   * DATA — which this file fills from our own API. Clearing the url is
   * therefore all it takes: every TL_API call keeps working and resolves
   * against the real backend instead.
   * ------------------------------------------------------------------ */

  if (window.TL_SUPA) {
    TL.disabledSupabase = {
      url: window.TL_SUPA.url,
      table: window.TL_SUPA.table,
    };
    window.TL_SUPA.url = '';
    window.TL_SUPA.anonKey = '';
    console.info('TeamLink: the prototype direct-Supabase path is disabled; ' +
                 'jobs now come from the application API.');
  }


  /* ------------------------------------------------------------------ *
   * 16. AI voice interview — results become ATS data
   *
   * The interview itself is the prototype's own (the AIIV module at
   * :22084): it speaks the questions, listens, transcribes, and scores on
   * content. None of that is changed here.
   *
   * What changes is where the result goes. It used to live in
   * localStorage, so a score existed only in the tab that produced it —
   * invisible to the recruiter, the client, and even to the candidate on
   * their next visit. It is now recorded through the API and read back
   * from the database by all four roles.
   *
   * Two fabricated-score paths are also removed. They produced a number
   * from `matchScore` plus randomness, with no interview behind it, which
   * is the one thing the specification forbids outright.
   * ------------------------------------------------------------------ */

  TL.aiInterviews = [];

  /** Stable fingerprint of a question set, so repeats can be detected. */
  function questionSetHash(questions) {
    var s = (questions || []).map(function (q) { return q.q || q.question || ''; }).join('|');
    var h = 5381;
    for (var i = 0; i < s.length; i++) { h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; }
    return 'qs' + h.toString(36) + '-' + (questions || []).length;
  }
  TL.questionSetHash = questionSetHash;

  /** Maps the session's report onto the API's shape. */
  function toApiAnswers(per) {
    return (per || []).map(function (p, i) {
      var cat = p.category === 'resume' ? 'resume'
              : p.category === 'behavioral' ? 'behavioral'
              : p.category === 'intro' ? 'intro' : 'technical';
      return {
        seq: i + 1,
        category: cat,
        question: String(p.question || '').slice(0, 2000),
        answered: !!p.answered,
        answerSummary: p.answer_summary ? String(p.answer_summary).slice(0, 4000) : undefined,
        score: Math.max(0, Math.min(100, Number(p.score) || 0)),
        commScore: p.communication == null ? undefined
                 : Math.max(0, Math.min(100, Number(p.communication) || 0)),
        justification: p.justification ? String(p.justification).slice(0, 2000) : undefined,
      };
    });
  }

  TL.recordAiInterview = function (report, extra) {
    extra = extra || {};
    var answers = toApiAnswers(report.per_question);
    if (!answers.length) {
      return Promise.reject(new ApiFailure('VALIDATION_FAILED',
        'Refusing to record an interview with no answers.'));
    }
    return api.post('/ai-interviews', {
      candidateId: report.candidate_id,
      jobId: report.job_id,
      applicationId: extra.applicationId,
      mode: extra.mode || 'voice',
      contentScored: !!report.content_scored,
      transcript: report.transcript,
      feedback: extra.feedback,
      questionSetHash: extra.questionSetHash,
      startedAt: extra.startedAt,
      answers: answers,
    }).then(function (res) {
      var saved = res.aiInterview;
      TL.aiInterviews = TL.aiInterviews.filter(function (x) { return x.id !== saved.id; });
      TL.aiInterviews.unshift(saved);

      // Reflect the SERVER's numbers into the cache, not the browser's.
      // The two agree, but the database is the one that has to be right.
      var c = DATA.candidateById(saved.candidateId);
      if (c) c.aiInterviewScore = saved.overallPercentage;
      var app = (DATA.applications || []).filter(function (a) {
        return a.candidateId === saved.candidateId && a.jobId === saved.jobId;
      }).pop();
      if (app) {
        app.aiScore = saved.overallPercentage;
        if (app.stage === 'applied' || app.stage === 'ai_screening') {
          app.stage = 'ai_interview_done';
        }
      }
      return saved;
    });
  };

  /**
   * Has this candidate already been given this exact question set?
   *
   * The prototype remembered only the LAST set, in localStorage, so
   * clearing storage or switching machine silently allowed a repeat. The
   * server remembers every set the candidate has ever been asked.
   */
  TL.questionSetUsed = function (candidateId, hash) {
    return api.get('/ai-interviews/question-set-used?candidateId=' +
      encodeURIComponent(candidateId) + '&hash=' + encodeURIComponent(hash))
      .then(function (r) { return !!r.used; })
      .catch(function () { return false; });   // never block an interview on this
  };

  // Record the result when the session completes.
  var prevAiivSubmit = window.aiivSubmit;
  if (typeof prevAiivSubmit === 'function') {
    window.aiivSubmit = function () {
      var out = prevAiivSubmit.apply(this, arguments);
      try {
        var appId = TL.__aiivAppId || (window.AIIV && window.AIIV.appId);
        var found = TL.aiivRec(appId);
        var rec = found && found.rec;
        var report = rec && rec.aiInterview && rec.aiInterview.report;

        // When the interview was planned by the server - which is the
        // normal path - the transcripts go back to the session that asked
        // the questions, and the SERVER grades them. The browser's own
        // numbers are then replaced by the ones the database stores,
        // because those are the ones the recruiter will see.
        var ses = TL.__aiivSession;
        if (ses && ses.appId === appId && rec) {
          TL.submitAiSession(rec, ses);
          return out;
        }

        if (report && report.candidate_id && report.job_id) {
          TL.recordAiInterview(report, {
            applicationId: found.applicationId,
            feedback: rec.aiInterview.feedback,
            questionSetHash: questionSetHash(rec.aiInterview.questions),
            mode: rec.aiInterview.mode || 'voice',
          }).then(function () {
            if (typeof window.render === 'function') window.render();
          }).catch(function (err) {
            say(err);
            console.error('TeamLink: the AI interview result could not be saved.', err);
          });
        }
      } catch (e) {
        console.error('TeamLink: failed to record the AI interview result.', e);
      }
      return out;
    };
  }

  // aiivStart carries the application id the report needs.
  var prevAiivStart = window.aiivStart;
  if (typeof prevAiivStart === 'function') {
    window.aiivStart = function (appId) {
      TL.__aiivAppId = appId;
      TL.__aiivStartedAt = new Date().toISOString();
      return prevAiivStart.apply(this, arguments);
    };
  }

  /* ---- remove the fabricated-score paths -------------------------- *
   *
   * simulateAIInterview() (:4189) set
   *     aiInterviewScore = matchScore + random(-5..+5)
   * producing a score with no interview behind it at all.
   *
   * aiInterviewCard() (:4880) fell back to
   *     Math.max(55, matchScore - 6)
   * inventing a number whenever none existed.
   *
   * Both are "a score disconnected from what the candidate actually
   * said". The simulator now refuses and points at the real interview;
   * the card shows "Not yet interviewed" instead of a fiction. Neither
   * changes any layout — only what the number is allowed to be.
   * ----------------------------------------------------------------- */

  window.simulateAIInterview = function (candId) {
    var c = DATA.candidateById(candId);
    if (typeof window.toast === 'function') {
      window.toast((c ? c.name : 'This candidate') +
        ' has not completed an AI interview — a score can only come from a real session.', 'ℹ️');
    }
    return null;
  };

  var prevAiCard = window.aiInterviewCard;
  if (typeof prevAiCard === 'function') {
    window.aiInterviewCard = function (c) {
      var html = prevAiCard.apply(this, arguments);

      var hasReal = (TL.aiInterviews || []).some(function (x) { return x.candidateId === c.id; })
        || typeof c.aiInterviewScore === 'number'
        || !!(DATA.aiInterviewTranscripts && DATA.aiInterviewTranscripts[c.id]);
      if (hasReal) return html;

      // No interview has happened, so the number in that badge came from
      // `Math.max(55, matchScore - 6)`. Only the badge TEXT is replaced —
      // same element, same classes, same styling — because a made-up score
      // is exactly what the specification forbids.
      //
      // This is a deliberate, spec-mandated difference from the prototype,
      // recorded in docs/INTEGRATION.md rather than slipped in quietly.
      return String(html).replace(/Score\s+\d+\/100/, 'Not yet interviewed');
    };
  }


  /* ------------------------------------------------------------------ *
   * 16b. The interview is a blueprint, not a shuffle
   *
   * generateQuestions() (:22126) built the interview in the browser:
   *
   *     2 from an intro pool + 5 from TECH_TEMPLATES applied to a shuffled
   *     skill list + 3 from BEHAV_POOL, reshuffled until the signature
   *     differed from the last one in localStorage
   *
   * That is ten questions drawn at random from templates. It cannot ask
   * about the project on the candidate's resume, it cannot ask about a
   * requirement of the job the resume does not evidence, and because the
   * mix is random, two candidates for the same role are not comparable.
   *
   * The questions now come from the server, which plans them from the
   * resume and the job description to a fixed blueprint:
   *
   *     2 introduction - 5 job description - 5 resume - 3 behavioural = 15
   *
   * The interview screen, the voice, the timer, the camera and the
   * transcription are all still the prototype's. Only the SOURCE of the
   * questions and the destination of the answers change.
   * ------------------------------------------------------------------ */

  /**
   * The interview record behind a screen's application id.
   *
   * recById() (:22013) is local to the prototype's module, so
   * `window.recById` is undefined and every guard written against it
   * silently did nothing. The two ids are also different things:
   *
   *     rec.applicationId   'APP-7F3K2'  shown to people, generated here
   *     application.id      'app_7f3k2'  the database row
   *
   * __lcRecFor(candidateId, jobId) IS exposed, and DATA.applications
   * carries both ids, so the record and the database row can both be
   * found from either one.
   */
  TL.aiivRec = function (appId) {
    if (!appId) return null;
    var app = (DATA.applications || []).filter(function (a) {
      return a.applicationId === appId || a.id === appId;
    }).pop();
    if (!app) return null;

    var rec = (typeof window.__lcRecFor === 'function')
      ? window.__lcRecFor(app.candidateId, app.jobId) : null;
    return { rec: rec, app: app, applicationId: app.id };
  };

  /**
   * Show the deadline the DATABASE holds.
   *
   * The screens that mention it - "complete your AI Interview within 2
   * days (by ...)", the Deadline field on the interview card, the due
   * chip on the dashboard - all read rec.aiInterview.deadline, which the
   * prototype computed in the browser as applied + 2 days. That is the
   * right rule and the wrong source: it drifts from what the server will
   * actually enforce, and a candidate who is told the wrong hour has been
   * misled by us.
   *
   * No layout changes. The same field, filled from the database.
   */
  TL.syncInterviewDeadlines = function () {
    (DATA.applications || []).forEach(function (a) {
      if (!a.aiInterviewDueAt || typeof window.__lcRecFor !== 'function') return;
      var rec = window.__lcRecFor(a.candidateId, a.jobId);
      if (rec && rec.aiInterview) rec.aiInterview.deadline = a.aiInterviewDueAt;
    });
  };

  /**
   * Rebuild the local application records from the database.
   *
   * Those records live in localStorage, which means they exist only in
   * the browser that created them. A candidate who applied on their
   * phone and opened the portal on a laptop had no application record
   * there — and therefore no AI interview to attend, no deadline, and no
   * confirmation, while the database held all three.
   *
   * Nothing is invented here. Every field comes from the application,
   * the job and the interview rows the server returned; a record that
   * already exists is left alone apart from the facts the server owns.
   */
  TL.ensureLocalRecords = function () {
    if (!STATE.session || STATE.session.role !== 'candidate') return;

    // Force the store to load from localStorage first. __LC is created
    // lazily by the prototype's own LC(), and building it here instead
    // would throw away whatever this browser had already saved -
    // __lcRecFor is a harmless way to make the prototype do it.
    if (!window.__LC && typeof window.__lcRecFor === 'function') {
      try { window.__lcRecFor('', ''); } catch (e) {}
    }
    if (!window.__LC || !window.__LC.apps) return;      // module not loaded

    var mine = (DATA.applications || []).filter(function (a) {
      return a.candidateId === STATE.session.id;
    });

    mine.forEach(function (a) {
      var key = a.candidateId + '|' + a.jobId;
      var rec = window.__LC.apps[key];
      var job = DATA.jobById(a.jobId) || {};
      var cand = DATA.candidateById(a.candidateId) || {};
      var iv = (TL.aiInterviews || []).filter(function (x) {
        return x.applicationId === a.id;
      }).pop();

      if (!rec) {
        rec = window.__LC.apps[key] = {
          applicationId: a.applicationId || a.id,
          key: key,
          candidateId: a.candidateId,
          jobId: a.jobId,
          jobTitle: job.title || '(job)',
          company: (DATA.companyById && job.companyId
            ? (DATA.companyById(job.companyId) || {}).name : '') || 'TeamLink client',
          source: a.source || 'Job Portal',
          appliedISO: a.appliedAt || new Date().toISOString(),
          email: cand.email || '',
          phone: cand.phone || '',
          resumeScore: cand.resumeScore != null ? cand.resumeScore : a.matchScore,
          matchScore: a.matchScore != null ? a.matchScore : cand.matchScore,
          aiInterview: {
            required: true,
            status: 'pending',
            createdAt: a.appliedAt || new Date().toISOString(),
            deadline: a.aiInterviewDueAt || null,
            startedAt: null, completedAt: null, score: null, feedback: '', answers: [],
          },
          // Empty rather than fabricated: this browser did not witness
          // the earlier messages, and the delivery log on the server is
          // the record of what was actually sent.
          comms: [], commKeys: {}, timeline: [],
          stage: a.stage || 'applied',
        };
      }

      // Facts the server owns, whether the record is new or not.
      if (a.applicationId) rec.applicationId = a.applicationId;
      if (a.aiInterviewDueAt) rec.aiInterview.deadline = a.aiInterviewDueAt;
      if (a.stage) rec.stage = a.stage;

      if (iv && iv.status === 'completed') {
        rec.aiInterview.status = 'completed';
        rec.aiInterview.completedAt = iv.completedAt || rec.aiInterview.completedAt;
        rec.aiInterview.score = iv.overallPercentage;
        rec.aiInterview.technical = iv.technicalScore;
        rec.aiInterview.behavioral = iv.behavioralScore;
        rec.aiInterview.communication = iv.communicationScore;
        rec.aiInterview.jdRelevance = iv.jdRelevance;
        rec.aiInterview.resumeRelevance = iv.resumeRelevance;
        if (iv.feedback) rec.aiInterview.feedback = iv.feedback;
      } else if (iv && iv.status === 'expired') {
        rec.aiInterview.status = 'expired';
      }

      // The screens read the interview off the application too.
      a.aiInterview = rec.aiInterview;
      if (!a.applicationId) a.applicationId = rec.applicationId;
    });
  };

  /** The server's question, in the shape the interview screen expects. */
  function toProtoQuestion(q) {
    var expects = (q.expects || []).map(function (x) { return String(x).toLowerCase(); });
    return {
      cat: q.category,          // intro | technical | resume | behavioral
      q: q.question,
      exp: expects,             // what a good answer mentions
      topic: expects,           // what "on topic" means for this question
      section: q.section,       // which part of the blueprint asked it
      seq: q.seq,
      source: q.source,         // the JD line or resume entry behind it
    };
  }

  /**
   * Plan the interview on the server, once per attempt.
   *
   * Started as soon as the candidate opens the interview (the camera
   * check), so the questions are already in hand by the time they press
   * start and nothing has to wait on the network mid-session.
   */
  TL.planAiSession = function (appId) {
    var found = TL.aiivRec(appId);
    if (!found || !found.applicationId) return Promise.resolve(null);

    var p = api.post('/ai-interviews/session', { applicationId: found.applicationId })
      .then(function (r) {
        var ses = {
          appId: appId,
          interviewId: r.interviewId,
          expiresAt: r.expiresAt,
          startedAt: r.startedAt,
          deadlineHours: r.deadlineHours,
          questions: (r.questions || []).map(toProtoQuestion),
        };
        TL.__aiivSession = ses;
        return ses;
      })
      .catch(function (err) {
        // Never strand the candidate on a blank screen: the prototype's
        // own generator still works, and the result is still recorded.
        console.error('TeamLink: the interview could not be planned on the server.', err);
        TL.__aiivSession = null;
        return null;
      });

    TL.__aiivPlan = p;
    return p;
  };

  /** Send the transcripts to the session that asked the questions. */
  TL.submitAiSession = function (rec, ses) {
    var qs = (rec.aiInterview && rec.aiInterview.questions) || [];
    var answers = (rec.aiInterview && rec.aiInterview.answers) || [];

    // One at a time and in order: the server records each answer against
    // the question it belongs to, and a failure part-way must not leave
    // answers attributed to the wrong question.
    var chain = Promise.resolve();
    qs.forEach(function (q, i) {
      var a = answers[i] || {};
      chain = chain.then(function () {
        return api.post('/ai-interviews/' + encodeURIComponent(ses.interviewId) + '/answer', {
          seq: q.seq || (i + 1),
          transcript: String(a.transcript || '').slice(0, 20000),
          answered: !!a.answered,
          voicedMs: Math.max(0, Math.round(a.voicedMs || 0)),
        }).catch(function (err) {
          if (err && err.code === 'INTERVIEW_EXPIRED') throw err;
          console.error('TeamLink: an answer could not be recorded.', err);
        });
      });
    });

    return chain
      .then(function () {
        return api.post('/ai-interviews/' + encodeURIComponent(ses.interviewId) + '/finish', {});
      })
      .then(function (res) {
        var saved = res && res.aiInterview;
        if (!saved) return null;

        TL.aiInterviews = (TL.aiInterviews || []).filter(function (x) { return x.id !== saved.id; });
        TL.aiInterviews.unshift(saved);

        // The screen was showing the browser's arithmetic. Replace it with
        // the database's, so the candidate and the recruiter read the same
        // number from the same place.
        var ai = rec.aiInterview || (rec.aiInterview = {});
        ai.score = saved.overallPercentage;
        ai.technical = saved.technicalScore;
        ai.behavioral = saved.behavioralScore;
        ai.communication = saved.communicationScore;
        ai.jdRelevance = saved.jdRelevance;
        ai.resumeRelevance = saved.resumeRelevance;
        ai.serverId = saved.id;
        rec.interviewScore = saved.overallPercentage;

        var c = DATA.candidateById(saved.candidateId);
        if (c) c.aiInterviewScore = saved.overallPercentage;
        var app = (DATA.applications || []).filter(function (x) {
          return x.candidateId === saved.candidateId && x.jobId === saved.jobId;
        }).pop();
        if (app) {
          app.aiScore = saved.overallPercentage;
          app.interviewScore = saved.overallPercentage;
          if (app.stage === 'applied' || app.stage === 'ai_screening') app.stage = 'ai_interview_done';
        }

        TL.__aiivSession = null;
        if (typeof window.render === 'function') window.render();
        return saved;
      })
      .catch(function (err) {
        say(err);
        console.error('TeamLink: the AI interview result could not be saved.', err);
        return null;
      });
  };

  // Plan as soon as the interview is opened.
  var prevStartForPlan = window.aiivStart;
  if (typeof prevStartForPlan === 'function') {
    window.aiivStart = function (appId) {
      TL.__aiivSession = null;
      var out = prevStartForPlan.apply(this, arguments);
      try { TL.planAiSession(appId); } catch (e) {
        console.error('TeamLink: the interview could not be planned.', e);
      }
      return out;
    };
  }

  // Ask the server's questions, not the browser's.
  var prevBeginQuestions = window.aiivBeginQuestions;
  if (typeof prevBeginQuestions === 'function') {
    window.aiivBeginQuestions = function () {
      var self = this, args = arguments;
      var appId = TL.__aiivAppId || (window.AIIV && window.AIIV.appId);
      var plan = TL.__aiivPlan || TL.planAiSession(appId);

      return Promise.resolve(plan).then(function (ses) {
        // The prototype's own start: it sets the phase, renders, and
        // schedules the first question 60ms later. It also regenerates the
        // question list, so the server's set is put back immediately
        // afterwards - before anything reads it.
        var out = prevBeginQuestions.apply(self, args);

        if (ses && ses.questions && ses.questions.length) {
          var found = TL.aiivRec(ses.appId);
          var rec = found && found.rec;
          if (rec && rec.aiInterview) {
            rec.aiInterview.questions = ses.questions.slice();
            rec.aiInterview.expiresAt = ses.expiresAt;
            // The deadline the server will actually enforce.
            if (ses.expiresAt) rec.aiInterview.deadline = ses.expiresAt;
            try { if (typeof window.persist === 'function') window.persist(); } catch (e) {}
            if (typeof window.render === 'function') window.render();
          }
        }
        return out;
      });
    };
  }

  /* ------------------------------------------------------------------ *
   * 17. The AI calling agent, in Find Candidates
   *
   * The recruiter screen already had a 📞 IVR button, and what sat behind
   * it was a press-1-for-yes menu that POSTed from the BROWSER to an
   * arbitrary endpoint the recruiter typed into a box, with the URL kept
   * in localStorage. Three things wrong with that: the candidate got a
   * phone tree rather than a conversation, the endpoint was configured
   * per browser so no two recruiters agreed on it, and the call bypassed
   * the server entirely - no record, no RBAC, no ATS update.
   *
   * The same button now starts a real conversation through our own API.
   * Carrier credentials stay on the server, every call is recorded
   * against the candidate and the requirement, and the result lands in
   * the ATS by itself.
   *
   * THE SCREEN IS UNCHANGED: same toolbar, same button, same modal
   * chrome, same classes. Only what happens when it is pressed is
   * different.
   * ------------------------------------------------------------------ */

  TL.calling = {};

  /** The candidates ticked in the results list. */
  function callingSelection() {
    var ids = Object.keys((STATE.fcr && STATE.fcr.selection) || {});
    return ids.map(function (id) { return DATA.candidateById(id); }).filter(Boolean);
  }

  /**
   * Everything the current filters matched - across every page.
   *
   * Ticking 200 candidates ten at a time is not a workflow, and the point
   * of a filter is that it has already chosen who to call. The prototype
   * keeps the refined result set in its own closure, so this re-runs the
   * same predicates against DATA.candidates: skills, location, experience,
   * notice period and the keyword box, in the order the sidebar applies
   * them.
   */
  function callingFiltered() {
    var f = (STATE && STATE.fcr) || {};
    var all = (DATA.candidates || []).slice();

    var skills = (f.skills || []).map(function (x) { return String(x).toLowerCase(); });
    var locs = (f.locs || []).map(function (x) { return String(x).toLowerCase(); });
    var notice = (f.notices || []).map(function (x) { return String(x).toLowerCase(); });
    var expMin = f.expMin === '' || f.expMin == null ? null : Number(f.expMin);
    var expMax = f.expMax === '' || f.expMax == null ? null : Number(f.expMax);
    var q = String(f.q || '').trim().toLowerCase();

    return all.filter(function (c) {
      var mine = ((c.technicalSkills && c.technicalSkills.length ? c.technicalSkills : c.skills) || [])
        .map(function (x) { return String(x).toLowerCase(); });
      if (skills.length && !skills.every(function (s) {
        return mine.some(function (m) { return m.indexOf(s) >= 0; });
      })) return false;

      if (locs.length) {
        var where = (String(c.location || '') + ' ' + String(c.preferredLocation || '')).toLowerCase();
        if (!locs.some(function (l) { return where.indexOf(l) >= 0; })) return false;
      }

      if (expMin != null || expMax != null) {
        var yrs = Number(c.expYears != null ? c.expYears : parseFloat(String(c.exp || '')));
        if (!isFinite(yrs)) return false;
        if (expMin != null && yrs < expMin) return false;
        if (expMax != null && yrs > expMax) return false;
      }

      if (notice.length) {
        var np = String(c.noticePeriod || '').toLowerCase();
        if (!notice.some(function (n) { return np.indexOf(n) >= 0; })) return false;
      }

      if (q) {
        var blob = [c.name, c.title, c.currentCompany, c.location, c.education,
          (c.skills || []).join(' '), (c.technicalSkills || []).join(' ')]
          .filter(Boolean).join(' ').toLowerCase();
        if (blob.indexOf(q) < 0) return false;
      }
      return true;
    });
  }

  /** Who a calling action applies to: the ticked rows, else the filter. */
  function callingTargets() {
    var sel = callingSelection();
    return sel.length ? { list: sel, from: 'selection' }
                      : { list: callingFiltered(), from: 'filter' };
  }
  TL.calling = TL.calling || {};
  TL.callingTargets = callingTargets;

  /** Requirements this recruiter can call for. */
  function callableJobs() {
    return (DATA.jobs || []).filter(function (j) {
      return j.status === 'open' && !j.paused && !j.archived;
    });
  }

  function esc(v) {
    return String(v === undefined || v === null ? '' : v)
      .replace(/[&<>"]/g, function (c) {
        return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c];
      });
  }

  var CALL_STATUS_LABEL = {
    queued: 'Queued', dialing: 'Dialing', ringing: 'Ringing', in_progress: 'On call',
    completed: 'Completed', no_answer: 'No answer', busy: 'Busy', failed: 'Failed',
    cancelled: 'Cancelled', wrong_number: 'Wrong number', voicemail: 'Voicemail',
  };
  var OUTCOME_LABEL = {
    interested: 'Interested', not_interested: 'Not interested', not_looking: 'Not looking',
    callback_requested: 'Callback requested', recruiter_callback: 'Recruiter callback',
    do_not_contact: 'Do not contact', salary_mismatch: 'Salary mismatch',
    location_mismatch: 'Location mismatch', notice_period_mismatch: 'Notice period',
    already_joined: 'Already joined', wrong_number: 'Wrong number',
    no_response: 'No response', busy: 'Busy', technical_failure: 'Technical failure',
    call_completed: 'Completed', language_issue: 'Language issue',
  };
  var LANG_LABEL = { en: 'English', hi: 'Hindi', te: 'Telugu' };

  /**
   * The AI calling modal, in place of the old IVR one.
   *
   * Opens with the agent's status so a recruiter can see immediately
   * whether calls will actually be placed or run on the local driver -
   * rather than pressing a button and wondering.
   */
  window.fcrIvrModal = function () {
    var target = callingTargets();
    var sel = target.list;
    if (!sel.length) {
      if (typeof window.toast === 'function') {
        window.toast('No candidates match the current filters', 'ℹ️');
      }
      return;
    }
    var fromFilter = target.from === 'filter';
    var jobs = callableJobs();

    window.fcrModal(
      '<div class="fcr-modal-head"><h3>AI Calling — ' + sel.length +
      (fromFilter ? ' matched by your filters' : ' selected') + '</h3>' +
      '<button class="btn btn-ghost btn-sm" onclick="fcrCloseModal()">✕</button></div>' +
      '<div class="fcr-modal-body" id="tlCallBody">' +
      '<div class="req-note">Loading the calling agent…</div></div>');

    api.get('/ai-calling/status').then(function (st) {
      var body = document.getElementById('tlCallBody');
      if (!body) return;
      var t = st.telephony || {};
      var live = t.active !== 'local';

      body.innerHTML =
        '<div class="req-note" style="' + (live ? '' : 'background:var(--warn-100);color:var(--warn-600)') + '">' +
          (live
            ? '📞 Calls are placed through <b>' + esc(t.active) + '</b>. The agent speaks ' +
              'English, Hindi and Telugu, detects which one the candidate is comfortable in, ' +
              'and updates the ATS when the call ends.'
            : '<b>No telephony provider is configured</b>, so calls run on the local driver: ' +
              'the real conversation, the real ATS update, no audio. Set ' +
              '<code>TELEPHONY_PROVIDER</code> and its credentials on the server to place ' +
              'real calls' +
              (t.missing && t.missing.length ? ' (missing: ' + esc(t.missing.join(', ')) + ')' : '') +
              '.') +
        '</div>' +

        '<div class="fgroup" style="margin-top:14px"><label>Requirement</label>' +
        '<select id="tlCallJob">' +
          '<option value="">— no specific requirement —</option>' +
          jobs.map(function (j) {
            return '<option value="' + esc(j.id) + '">' + esc(j.title) +
                   (j.location ? ' · ' + esc(j.location) : '') + '</option>';
          }).join('') +
        '</select></div>' +

        '<div class="fgroup"><label>Language</label>' +
        '<select id="tlCallLang">' +
          '<option value="auto">Auto detect (recommended)</option>' +
          '<option value="en">English</option>' +
          '<option value="hi">Hindi</option>' +
          '<option value="te">Telugu</option>' +
        '</select></div>' +

        '<div class="fgroup"><label>Call objective (optional)</label>' +
        '<input id="tlCallObjective" placeholder="Confirm interest and availability"></div>' +

        (fromFilter && sel.length > 8
          ? '<div class="req-note" style="margin-top:12px">Nothing is ticked, so this applies to ' +
            'all <b>' + sel.length + '</b> candidates your filters matched. ' +
            'Tick individual rows to call only those.</div>'
          : '') +

        '<div style="margin-top:10px">' + sel.slice(0, 8).map(function (c) {
          var dnc = c.doNotContact;
          return '<div class="fcr-modal-row"><span><b>' + esc(c.name) + '</b> ' +
            '<span style="color:var(--text-soft)">· ' + esc(c.phone || 'no number') + '</span></span>' +
            (dnc
              ? '<span class="badge badge-bad">Do not contact</span>'
              : c.phone
                ? '<span style="display:flex;gap:6px">' +
                  '<button class="btn btn-ghost btn-sm" onclick="TL.calling.preview(\'' + esc(c.id) + '\')">What will it ask?</button>' +
                  '<button class="btn btn-primary btn-sm" id="tlCallBtn_' + esc(c.id) + '" ' +
                  'onclick="TL.calling.start(\'' + esc(c.id) + '\')">📞 Call now</button></span>'
                : '<span class="badge badge-neutral">No mobile number</span>') +
          '</div>';
        }).join('') +
        (sel.length > 8
          ? '<div style="font-size:12.5px;color:var(--text-soft);padding:6px 0">' +
            '…and ' + (sel.length - 8) + ' more</div>'
          : '') + '</div>' +

        '<div id="tlCallOut" style="margin-top:12px"></div>' +

        '<div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap">' +
          '<button class="btn btn-primary" onclick="TL.calling.campaign()">🤖 Call all ' + sel.length +
            (fromFilter ? ' filtered' : ' selected') + '</button>' +
          '<button class="btn btn-ghost" onclick="TL.calling.exportExcel()">📗 Export calls to Excel</button>' +
          '<button class="btn btn-ghost" onclick="TL.calling.dashboard()">📊 Calling dashboard</button>' +
          '<button class="btn btn-ghost" onclick="fcrCloseModal()">Close</button>' +
        '</div>';
    }).catch(function (err) {
      var body = document.getElementById('tlCallBody');
      if (body) body.innerHTML = '<div class="req-note">' + esc(err.message || 'The calling agent is unavailable.') + '</div>';
    });
  };

  function callFormValues() {
    var job = (document.getElementById('tlCallJob') || {}).value || '';
    var lang = (document.getElementById('tlCallLang') || {}).value || 'auto';
    var obj = ((document.getElementById('tlCallObjective') || {}).value || '').trim();
    return { jobId: job || undefined, language: lang, objective: obj || undefined };
  }

  function callOut(html) {
    var el = document.getElementById('tlCallOut');
    if (el) el.innerHTML = html;
  }

  /**
   * What the agent would ask, before anybody is called.
   *
   * The single most common worry about an automated call is that it will
   * ask the candidate something the ATS already knows. This shows the
   * answer up front: what it knows, and what it will actually ask.
   */
  TL.calling.preview = function (candidateId) {
    var v = callFormValues();
    api.get('/ai-calling/plan?candidateId=' + encodeURIComponent(candidateId) +
            (v.jobId ? '&jobId=' + encodeURIComponent(v.jobId) : ''))
      .then(function (r) {
        var p = r.plan || {};
        callOut(
          '<div class="panel" style="padding:12px">' +
          '<div style="font-size:11px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:var(--text-soft)">Call objective</div>' +
          '<div style="font-size:13px;margin:4px 0 10px">' + esc(p.objective) + '</div>' +
          '<div style="font-size:11px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:var(--text-soft)">Already known — will not be asked</div>' +
          '<div style="font-size:12.5px;color:var(--text-soft);margin:4px 0 10px">' +
            (p.known || []).map(esc).join(' · ') + '</div>' +
          '<div style="font-size:11px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:var(--text-soft)">Will ask</div>' +
          '<ul style="margin:6px 0 0 18px;font-size:13px">' +
            (p.needed || []).map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('') +
          '</ul></div>');
      })
      .catch(function (err) { say(err); });
  };

  /** Call one candidate now. */
  TL.calling.start = function (candidateId) {
    var v = callFormValues();
    var btn = document.getElementById('tlCallBtn_' + candidateId);
    if (btn) { btn.disabled = true; btn.textContent = 'Calling…'; }

    api.post('/ai-calling/call', {
      candidateId: candidateId,
      jobId: v.jobId,
      language: v.language,
      objective: v.objective,
    }).then(function (r) {
      if (btn) btn.textContent = '✓ Call started';
      var local = r.call.provider === 'local';
      callOut(
        '<div class="req-note" style="background:var(--ok-100);color:var(--ok-600)">' +
        'Call started. The agent opened with: “' + esc(r.say) + '”' +
        (local
          ? '<br><br>No carrier is configured, so this call runs locally. ' +
            '<button class="btn btn-ghost btn-sm" onclick="TL.calling.console(\'' + esc(r.call.id) + '\')">Open the conversation</button>'
          : '') +
        '</div>');
      if (typeof window.toast === 'function') window.toast('AI call started', '📞');
    }).catch(function (err) {
      if (btn) { btn.disabled = false; btn.textContent = '📞 Call now'; }
      callOut('<div class="req-note">' + esc(err.message || 'The call could not be started.') + '</div>');
    });
  };

  /**
   * The local conversation console.
   *
   * With no carrier configured the call has no audio, so the turns are
   * typed. Everything else is real — the same engine, the same database,
   * the same ATS update — which makes this the way to try the agent
   * before buying telephony minutes.
   */
  TL.calling.console = function (callId) {
    window.fcrModal(
      '<div class="fcr-modal-head"><h3>AI call — local conversation</h3>' +
      '<button class="btn btn-ghost btn-sm" onclick="fcrCloseModal()">✕</button></div>' +
      '<div class="fcr-modal-body">' +
      '<div id="tlCallLog" style="max-height:320px;overflow:auto;font-size:13px;line-height:1.55"></div>' +
      '<div style="display:flex;gap:8px;margin-top:12px">' +
        '<input id="tlCallSay" placeholder="Type what the candidate says…" style="flex:1" ' +
        'onkeydown="if(event.key===\'Enter\'){TL.calling.send(\'' + esc(callId) + '\')}">' +
        '<button class="btn btn-primary btn-sm" onclick="TL.calling.send(\'' + esc(callId) + '\')">Send</button>' +
        '<button class="btn btn-ghost btn-sm" onclick="TL.calling.send(\'' + esc(callId) + '\', true)">Silence</button>' +
      '</div>' +
      '<div style="margin-top:10px"><button class="btn btn-ghost btn-sm" onclick="TL.calling.end(\'' + esc(callId) + '\')">End call</button></div>' +
      '</div>');
    TL.calling.refreshLog(callId);
  };

  TL.calling.refreshLog = function (callId) {
    return api.get('/ai-calling/calls/' + encodeURIComponent(callId)).then(function (r) {
      var el = document.getElementById('tlCallLog');
      if (!el) return r;
      el.innerHTML = (r.transcript || []).map(function (t) {
        var agent = t.speaker === 'agent';
        return '<div style="margin:6px 0"><b style="color:' +
          (agent ? 'var(--brand-600)' : 'var(--text)') + '">' +
          (agent ? 'Agent' : 'Candidate') + ':</b> ' + esc(t.text) +
          (t.intent ? ' <span class="badge badge-neutral" style="font-size:9px">' + esc(t.intent) + '</span>' : '') +
          '</div>';
      }).join('');
      el.scrollTop = el.scrollHeight;
      if (r.call && r.call.summary) {
        el.innerHTML += '<div class="req-note" style="margin-top:10px">' + esc(r.call.summary) + '</div>';
      }
      return r;
    });
  };

  TL.calling.send = function (callId, silence) {
    var input = document.getElementById('tlCallSay');
    var text = silence ? '' : ((input || {}).value || '').trim();
    if (!silence && !text) return;
    if (input) input.value = '';
    api.post('/ai-calling/calls/' + encodeURIComponent(callId) + '/say', { text: text })
      .then(function () { return TL.calling.refreshLog(callId); })
      .then(function () { if (typeof window.render === 'function') window.render(); })
      .catch(function (err) { say(err); });
  };

  TL.calling.end = function (callId) {
    api.post('/ai-calling/calls/' + encodeURIComponent(callId) + '/end', {})
      .then(function () {
        return TL.calling.refreshLog(callId);
      })
      .then(function () {
        if (typeof window.toast === 'function') window.toast('Call ended and recorded', '📞');
        return refresh();
      })
      .catch(function (err) { say(err); });
  };

  /** Call everybody the filters matched, or everybody ticked. */
  TL.calling.campaign = function () {
    var sel = callingTargets().list;
    var v = callFormValues();
    if (!v.jobId) {
      callOut('<div class="req-note">Choose a requirement first — a calling campaign is always about one role.</div>');
      return;
    }
    callOut('<div class="req-note">Queueing…</div>');

    api.post('/ai-calling/campaign', {
      jobId: v.jobId,
      candidateIds: sel.map(function (c) { return c.id; }),
      languageMode: v.language,
      objective: v.objective,
    }).then(function (r) {
      callOut(
        '<div class="req-note" style="background:var(--ok-100);color:var(--ok-600)">' +
        '<b>' + r.campaign.queued + ' call' + (r.campaign.queued === 1 ? '' : 's') + ' queued.</b>' +
        (r.skipped.length
          ? '<br>' + r.skipped.length + ' skipped: ' +
            r.skipped.map(function (x) {
              var c = DATA.candidateById(x.candidateId);
              return esc((c ? c.name : x.candidateId) + ' (' + x.reason + ')');
            }).join(', ')
          : '') +
        '</div>');
      if (typeof window.toast === 'function') {
        window.toast(r.campaign.queued + ' AI calls queued', '🤖');
      }
    }).catch(function (err) {
      callOut('<div class="req-note">' + esc(err.message || 'The campaign could not be started.') + '</div>');
    });
  };

  /** The calling dashboard, in the same modal chrome. */
  TL.calling.dashboard = function () {
    window.fcrModal(
      '<div class="fcr-modal-head"><h3>AI Calling</h3>' +
      '<button class="btn btn-ghost btn-sm" onclick="fcrCloseModal()">✕</button></div>' +
      '<div class="fcr-modal-body" id="tlCallDash"><div class="req-note">Loading…</div></div>');

    Promise.all([api.get('/ai-calling/dashboard'), api.get('/ai-calling/calls?limit=25')])
      .then(function (out) {
        var d = out[0], calls = out[1].calls || [];
        var t = d.totals || {};
        var el = document.getElementById('tlCallDash');
        if (!el) return;

        var tile = function (k, v) {
          return '<div class="item"><div class="k">' + esc(k) + '</div><div class="v">' + (v || 0) + '</div></div>';
        };

        el.innerHTML =
          '<div class="kv" style="grid-template-columns:repeat(4,1fr)">' +
            tile('Total calls', t.total) + tile('Connected', t.connected) +
            tile('No answer', t.no_answer) + tile('Interested', t.interested) +
          '</div>' +
          '<div class="kv" style="grid-template-columns:repeat(4,1fr);margin-top:8px">' +
            tile('Not interested', t.not_interested) + tile('Callbacks', t.callbacks) +
            tile('Recruiter callbacks', t.recruiter_callbacks) + tile('Do not contact', t.do_not_contact) +
          '</div>' +

          (d.callbacks && d.callbacks.length
            ? '<div style="margin-top:14px"><div style="font-size:11px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:var(--text-soft);margin-bottom:6px">Pending callbacks</div>' +
              d.callbacks.map(function (cb) {
                return '<div class="fcr-modal-row"><span><b>' + esc(cb.candidateName) + '</b>' +
                  (cb.jobTitle ? ' <span style="color:var(--text-soft)">· ' + esc(cb.jobTitle) + '</span>' : '') +
                  '<div style="font-size:12px;color:var(--text-soft)">' +
                  (cb.kind === 'recruiter' ? 'Wants a recruiter' : 'Callback') +
                  (cb.requestedFor ? ' · ' + new Date(cb.requestedFor).toLocaleString('en-GB') : '') +
                  (cb.language ? ' · ' + esc(LANG_LABEL[cb.language] || cb.language) : '') +
                  (cb.question ? '<br>“' + esc(cb.question) + '”' : '') + '</div></span>' +
                  '<button class="btn btn-ghost btn-sm" onclick="TL.calling.callbackDone(\'' + esc(cb.id) + '\')">Mark done</button></div>';
              }).join('') + '</div>'
            : '') +

          '<div style="margin-top:14px"><div style="font-size:11px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:var(--text-soft);margin-bottom:6px">Recent calls</div>' +
          (calls.length
            ? calls.map(callRowHtml).join('')
            : '<div style="font-size:13px;color:var(--text-soft)">No calls yet.</div>') +
          '</div>';
      })
      .catch(function (err) {
        var el = document.getElementById('tlCallDash');
        if (el) el.innerHTML = '<div class="req-note">' + esc(err.message || 'Unavailable.') + '</div>';
      });
  };

  function callRowHtml(c) {
    return '<div class="fcr-modal-row"><span><b>' + esc(c.candidateName || c.candidateId) + '</b>' +
      (c.jobTitle ? ' <span style="color:var(--text-soft)">· ' + esc(c.jobTitle) + '</span>' : '') +
      '<div style="font-size:12px;color:var(--text-soft)">' +
        (c.queuedAt ? new Date(c.queuedAt).toLocaleString('en-GB') : '') +
        ' · ' + esc(LANG_LABEL[c.language] || c.language) +
        ' · ' + esc(CALL_STATUS_LABEL[c.status] || c.status) +
        (c.outcome ? ' · ' + esc(OUTCOME_LABEL[c.outcome] || c.outcome) : '') +
        (c.durationSeconds ? ' · ' + c.durationSeconds + 's' : '') +
        (c.summary ? '<br>' + esc(c.summary) : '') +
      '</div></span>' +
      '<button class="btn btn-ghost btn-sm" onclick="TL.calling.transcript(\'' + esc(c.id) + '\')">Transcript</button></div>';
  }

  TL.calling.transcript = function (callId) {
    window.fcrModal(
      '<div class="fcr-modal-head"><h3>Call transcript</h3>' +
      '<button class="btn btn-ghost btn-sm" onclick="fcrCloseModal()">✕</button></div>' +
      '<div class="fcr-modal-body"><div id="tlCallLog" style="max-height:420px;overflow:auto;font-size:13px;line-height:1.55"></div></div>');
    TL.calling.refreshLog(callId).catch(function (err) { say(err); });
  };

  /**
   * The call results, as a real workbook.
   *
   * Built on the server: a CSV written in the browser is not an Excel
   * file, and Excel turns a column of Indian mobile numbers into
   * scientific notation the moment it opens one.
   */
  TL.calling.exportExcel = function (params) {
    var q = params || '';
    var v = (typeof callFormValues === 'function') ? callFormValues() : {};
    if (!q && v.jobId) q = 'jobId=' + encodeURIComponent(v.jobId);
    TL.downloadFile('/ai-calling/export' + (q ? '?' + q : ''), 'the call results');
  };

  /**
   * Download a file from the API, with the session cookie attached.
   *
   * A plain <a href> to /api/... does carry cookies, but it cannot report
   * a 403 or a 404 - the browser simply navigates away and the recruiter
   * sees a blank tab. Fetching it means an error can be shown.
   */
  TL.downloadFile = function (path, what) {
    var url = (TL.apiBase || '/api') + path;
    return fetch(url, { credentials: CREDENTIALS })
      .then(function (res) {
        if (!res.ok) {
          return res.json().catch(function () { return {}; }).then(function (j) {
            throw new ApiFailure((j.error && j.error.code) || 'DOWNLOAD_FAILED',
              (j.error && j.error.message) || 'That file could not be produced.');
          });
        }
        var name = 'TeamLink.xlsx';
        var cd = res.headers.get('content-disposition') || '';
        var m = /filename="([^"]+)"/.exec(cd);
        if (m) name = m[1];
        return res.blob().then(function (blob) {
          var a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = name;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
          if (typeof window.toast === 'function') {
            window.toast('Downloaded ' + name, '📗');
          }
        });
      })
      .catch(function (err) { say(err); });
  };

  TL.calling.callbackDone = function (id) {
    api.post('/ai-calling/callbacks/' + encodeURIComponent(id) + '/done', {})
      .then(function () { TL.calling.dashboard(); })
      .catch(function (err) { say(err); });
  };

  /** The call history a recruiter sees on one candidate. */
  TL.calling.history = function (candidateId) {
    window.fcrModal(
      '<div class="fcr-modal-head"><h3>AI call history</h3>' +
      '<button class="btn btn-ghost btn-sm" onclick="fcrCloseModal()">✕</button></div>' +
      '<div class="fcr-modal-body" id="tlCallHist"><div class="req-note">Loading…</div></div>');

    api.get('/ai-calling/calls?candidateId=' + encodeURIComponent(candidateId))
      .then(function (r) {
        var el = document.getElementById('tlCallHist');
        if (!el) return;
        el.innerHTML = (r.calls || []).length
          ? r.calls.map(callRowHtml).join('')
          : '<div style="font-size:13px;color:var(--text-soft)">No AI calls for this candidate yet.</div>';
      })
      .catch(function (err) {
        var el = document.getElementById('tlCallHist');
        if (el) el.innerHTML = '<div class="req-note">' + esc(err.message || 'Unavailable.') + '</div>';
      });
  };

  /**
   * Export the candidate list as a real workbook.
   *
   * The screen's own export wrote a CSV, which Excel opens but mangles:
   * a phone number becomes 9.19E+11 and "Bengaluru, Karnataka" splits
   * across two columns. This asks the server for an .xlsx instead, and
   * carries the AI call outcome for each candidate with it.
   */
  var prevExportExcel = window.fcrExportExcel;
  window.fcrExportExcel = function () {
    var target = callingTargets();
    if (!target.list.length) {
      if (typeof window.toast === 'function') window.toast('Nothing to export', 'ℹ️');
      return;
    }
    var ids = target.list.map(function (c) { return c.id; });
    // A URL has a practical length limit; past it, fall back to the
    // prototype's own CSV rather than producing a broken request.
    if (ids.join(',').length > 6000) {
      if (typeof prevExportExcel === 'function') return prevExportExcel.apply(this, arguments);
    }
    return TL.downloadFile('/candidates/export?ids=' + encodeURIComponent(ids.join(',')),
      'the candidate list');
  };

  /**
   * Import accepts a real Excel file, not only CSV.
   *
   * The modal took .csv or pasted rows, so anybody working from the
   * .xlsx a client or a job board sent had to open Excel, Save As CSV,
   * and hope the commas inside "Bengaluru, Karnataka" survived. The file
   * is now read on the SERVER, which can parse both properly and match
   * columns by their headers in any order.
   */
  var prevImportModal = window.fcrImportModal;
  window.fcrImportModal = function () {
    window.fcrModal(
      '<div class="fcr-modal-head"><h3>Import Candidates</h3>' +
      '<button class="btn btn-ghost btn-sm" onclick="fcrCloseModal()">✕</button></div>' +
      '<div class="fcr-modal-body">' +
      '<div class="req-note">Upload an <b>Excel workbook (.xlsx)</b> or a <b>CSV</b>. ' +
      'Columns are matched by their headings, in any order — Name, Phone, Email, ' +
      'Skills, Location, Designation, Company, Experience, Current CTC, Expected CTC, ' +
      'Notice period, Education. Only <b>Name</b>, and an email or a phone number, are ' +
      'required. Somebody already in the database is updated rather than duplicated.</div>' +

      '<div class="fgroup" style="margin-top:14px"><label>Excel or CSV file</label>' +
      '<input type="file" id="tlImportFile" accept=".xlsx,.csv,text/csv,' +
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"></div>' +

      '<div class="fgroup"><label>…or paste CSV rows</label>' +
      '<textarea id="tlImportText" rows="5" style="width:100%;padding:10px 12px;' +
      'border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--text);' +
      'font-size:13px;font-family:inherit;resize:vertical" ' +
      'placeholder="Name, Phone, Email, Skills, Location&#10;' +
      'Ravi Kumar, +91 90000 11111, ravi@example.com, Java; SQL, Chennai"></textarea></div>' +

      '<div id="tlImportOut"></div>' +
      '<div style="display:flex;gap:8px;margin-top:12px">' +
      '<button class="btn btn-primary" id="tlImportBtn" onclick="TL.importCandidates()">Import</button>' +
      '<button class="btn btn-ghost" onclick="fcrCloseModal()">Cancel</button></div>' +
      '</div>');
  };

  TL.importCandidates = function () {
    var fileEl = document.getElementById('tlImportFile');
    var textEl = document.getElementById('tlImportText');
    var btn = document.getElementById('tlImportBtn');
    var file = fileEl && fileEl.files && fileEl.files[0];
    var text = textEl ? String(textEl.value || '').trim() : '';

    if (!file && !text) {
      document.getElementById('tlImportOut').innerHTML =
        '<div class="req-note">Choose a file or paste some rows first.</div>';
      return;
    }
    if (btn) { btn.disabled = true; btn.textContent = 'Importing…'; }

    // Through the api wrapper, not a raw fetch: it attaches the CSRF
    // token and leaves FormData's own multipart boundary alone.
    var body;
    if (file) {
      body = new FormData();
      body.append('file', file, file.name);
    } else {
      body = { text: text };
    }

    api.post('/candidates/import', body)
      .then(function (r) {
        if (btn) { btn.disabled = false; btn.textContent = 'Import'; }
        var d = r.detail || {};
        document.getElementById('tlImportOut').innerHTML =
          '<div class="req-note" style="background:var(--ok-100);color:var(--ok-600)">' +
          '<b>' + r.imported + ' imported</b>' +
          (r.updated ? ', ' + r.updated + ' existing candidate' + (r.updated === 1 ? '' : 's') + ' updated' : '') +
          (r.skipped ? ', ' + r.skipped + ' skipped' : '') +
          ' (read as ' + esc(r.format) + ')' +
          ((d.skipped || []).length
            ? '<div style="margin-top:6px;font-size:12.5px">' +
              d.skipped.slice(0, 8).map(function (x) {
                return 'row ' + x.line + (x.name ? ' (' + esc(x.name) + ')' : '') + ': ' + esc(x.reason);
              }).join('<br>') + '</div>'
            : '') +
          '</div>';
        if (typeof window.toast === 'function') {
          window.toast(r.imported + ' candidate' + (r.imported === 1 ? '' : 's') + ' imported', '⬆️');
        }
        return refresh();
      })
      .catch(function (err) {
        if (btn) { btn.disabled = false; btn.textContent = 'Import'; }
        document.getElementById('tlImportOut').innerHTML =
          '<div class="req-note">' + esc(err.message || 'The import failed.') + '</div>';
      });
  };

  /**
   * Say what the button now does.
   *
   * The toolbar button still reads "IVR", which described a press-1
   * phone menu that no longer exists - and left the calling agent
   * effectively unfindable, because nobody looks for a conversation
   * under "IVR". Only the LABEL changes: same button, same position,
   * same classes, same handler.
   *
   * Done after render rather than in the markup because the toolbar is
   * built inside the prototype's own closure, which has no seam to
   * override.
   */
  function relabelCallingButton() {
    var buttons = document.querySelectorAll('.fcr-toolbar button');
    for (var i = 0; i < buttons.length; i++) {
      var b = buttons[i];
      var handler = b.getAttribute('onclick') || '';
      if (handler.indexOf('fcrIvrModal') < 0) continue;
      if (b.dataset && b.dataset.tlCalling === '1') continue;
      b.textContent = '🤖 AI Call';
      b.title = 'Call the selected candidates with the AI recruitment agent';
      if (b.dataset) b.dataset.tlCalling = '1';
    }
  }

  var realRenderForCalling = window.render;
  window.render = function () {
    var out = realRenderForCalling.apply(this, arguments);
    try { relabelCallingButton(); } catch (e) { /* never break a render */ }
    return out;
  };

  // The results list repaints itself without a full render, so catch that
  // too - otherwise the label reverts the first time a filter is touched.
  document.addEventListener('click', function () {
    setTimeout(function () {
      try { relabelCallingButton(); } catch (e) {}
    }, 60);
  }, true);

  /* ---- the old browser-side IVR path is removed ------------------- *
   *
   * fcrStartIvrCall() POSTed from the browser to whatever URL was typed
   * into the settings box, with the candidate's phone number in the body.
   * Whatever that endpoint was, it was not this application: the call was
   * never recorded, never checked against do-not-contact, and never
   * reached the ATS.
   * ----------------------------------------------------------------- */
  window.fcrStartIvrCall = function (id) { return TL.calling.start(id); };
  window.fcrSaveIvrSettings = function () {
    if (typeof window.toast === 'function') {
      window.toast('Calling is configured on the server now — no endpoint to enter here.', 'ℹ️');
    }
    window.fcrIvrModal();
  };

  /* ------------------------------------------------------------------ *
   * 18. Naukri applications, imported from the recruiter's inbox
   *
   * The recruiter's Applications screen gets one button. Behind it:
   * connect the mailbox Naukri replies to, sync it, and deal with the
   * handful of emails the system will not guess at.
   *
   * Everything else happens without anybody pressing anything - the
   * server reads the connected mailboxes on a timer. The button exists
   * for "it should be there by now" and for the queue.
   *
   * No screen is replaced and no module is added: this is a button in an
   * existing panel head, a line under an existing table cell, and a
   * modal in the prototype's own modal chrome.
   * ------------------------------------------------------------------ */

  TL.intake = {};

  function intakeModalShell(title, body) {
    if (typeof window.fcrModal === 'function') {
      window.fcrModal(
        '<div class="fcr-modal-head"><h3>' + esc(title) + '</h3>' +
        '<button class="btn btn-ghost btn-sm" onclick="fcrCloseModal()">✕</button></div>' +
        '<div class="fcr-modal-body" id="tlIntakeBody">' + body + '</div>');
      return;
    }
    // The modal helper lives on the Find Candidates screen; elsewhere,
    // fall back to the prototype's own modal if there is one.
    if (typeof window.openModal === 'function') window.openModal(title, body);
  }

  var INTAKE_STATUS = {
    processed: 'Imported', needs_mapping: 'Needs a requirement',
    needs_review: 'Needs review', ignored: 'Not an application',
    duplicate: 'Already imported', failed: 'Failed', new: 'New',
  };

  /** The Import from Mail screen. */
  TL.intake.open = function () {
    TL.intake.lastMessage = '';
    intakeModalShell('Import from Mail',
      '<div class="req-note">Loading the connected mailboxes…</div>');
    TL.intake.refresh();
  };

  TL.intake.refresh = function () {
    return Promise.all([
      api.get('/intake/mailboxes'),
      api.get('/intake/queue'),
    ]).then(function (out) {
      var boxes = out[0].mailboxes || [];
      var queue = out[1].queue || [];
      var counts = out[1].counts || {};
      var body = document.getElementById('tlIntakeBody');
      if (!body) return;

      var jobs = (DATA.jobs || []).filter(function (j) {
        return j.status === 'open' && !j.paused && !j.archived;
      });

      body.innerHTML =
        // ---- the mailboxes -------------------------------------------
        '<div style="font-size:11px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;' +
        'color:var(--text-soft);margin-bottom:6px">Connected mailboxes</div>' +
        (boxes.length
          ? boxes.map(function (b) {
              /*
               * Three states, not two.
               *
               * "Not configured" was shown for everything that was not
               * connected, including a mailbox whose settings are all
               * present and whose password the server rejected. That
               * sends somebody to check environment variables that are
               * already correct. A refused login is a different problem
               * with a different fix, and says so.
               */
              var ok = b.status === 'connected';
              var missing = (b.missingConfig || []).length > 0;
              var label = ok ? 'Connected' : missing ? 'Not configured' : 'Login refused';
              return '<div class="fcr-modal-row"><span><b>' + esc(b.address) + '</b> ' +
                '<span class="badge ' + (ok ? 'badge-ok' : 'badge-neutral') + '">' +
                esc(label) + '</span>' +
                '<div style="font-size:12px;color:var(--text-soft)">' +
                esc(b.provider) + (b.recruiterName ? ' · ' + esc(b.recruiterName) : '') +
                (b.lastSyncAt ? ' · last read ' + new Date(b.lastSyncAt).toLocaleString('en-GB') : ' · never read') +
                (b.autoSync ? ' · syncing automatically' : ' · automatic sync off') +
                (b.missingConfig && b.missingConfig.length
                  ? '<br><span style="color:var(--warn-600)">Set on the server: ' +
                    esc(b.missingConfig.join(', ')) + '</span>'
                  : '') +
                (b.lastError ? '<br><span style="color:var(--bad-600)">' + esc(b.lastError) + '</span>' : '') +
                '</div></span>' +
                '<button class="btn btn-primary btn-sm" onclick="TL.intake.sync(\'' + esc(b.id) + '\')">Sync now</button>' +
                '</div>';
            }).join('')
          : '<div style="font-size:13px;color:var(--text-soft)">No mailbox is connected yet.</div>') +

        // ---- connect one ---------------------------------------------
        '<div class="panel" style="padding:12px;margin-top:12px">' +
        '<div style="font-size:11px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;' +
        'color:var(--text-soft);margin-bottom:8px">Connect the inbox Naukri replies to</div>' +
        '<div class="fgroup"><label>Email address</label>' +
        '<input id="tlIntakeAddr" placeholder="kiran@teamlink.com"></div>' +
        '<div class="fgroup"><label>Provider</label><select id="tlIntakeProvider">' +
        // IMAP first, and the demo inbox is not offered at all.
        //
        // It used to be the first option and therefore the DEFAULT, so
        // connecting a real company address without touching the
        // dropdown attached it to a generator of sample Naukri emails.
        // The ATS filled with applications from candidates who do not
        // exist, indistinguishable on screen from real ones - 86 of them
        // here before anybody noticed. The sample feed still exists for
        // tests, through the API, where choosing it is deliberate.
        /*
         * IMAP only.
         *
         * Gmail and Outlook here mean the REST APIs, which authenticate
         * with an OAuth access token and nothing else. This deployment's
         * mail is self-hosted (mail.tmlink.in), so there is no such
         * token to obtain - and picking Gmail for a self-hosted address
         * produced a mailbox that asked for a credential which cannot
         * exist. It happened three times.
         *
         * The providers are still in the API for a deployment that
         * genuinely uses Google or Microsoft; they are not offered here,
         * where every choice but one is a dead end.
         */
        '<option value="imap">IMAP</option>' +
        '</select></div>' +
        '<div class="req-note" style="font-size:12px">The mailbox password is never entered here. ' +
        'It is read from the server’s environment, keyed on the address — connect the ' +
        'mailbox and TeamLink will tell you exactly which variable to set.</div>' +
        '<div style="margin-top:10px"><button class="btn btn-primary btn-sm" onclick="TL.intake.connect()">Connect mailbox</button></div>' +
        '</div>' +

        // ---- the queue ------------------------------------------------
        '<div style="font-size:11px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;' +
        'color:var(--text-soft);margin:14px 0 6px">Needs a recruiter ' +
        '<span class="badge badge-neutral">' + queue.length + '</span></div>' +
        (queue.length
          ? queue.map(function (m) {
              var p = m.parsed || {};
              return '<div class="fcr-modal-row"><span><b>' + esc(p.name || m.subject || 'Unknown') + '</b> ' +
                '<span class="badge badge-warn">' + esc(INTAKE_STATUS[m.status] || m.status) + '</span>' +
                '<div style="font-size:12px;color:var(--text-soft)">' +
                (p.email ? esc(p.email) + ' · ' : '') + (p.phone ? esc(p.phone) + ' · ' : '') +
                (p.appliedRole ? 'applied for ' + esc(p.appliedRole) + ' · ' : '') +
                esc(m.reason || '') + '</div></span>' +
                (m.status === 'needs_mapping'
                  ? '<span style="display:flex;gap:6px;align-items:center">' +
                    '<select id="tlMap_' + esc(m.id) + '">' +
                    jobs.map(function (j) {
                      return '<option value="' + esc(j.id) + '">' + esc(j.title) +
                             (j.location ? ' · ' + esc(j.location) : '') + '</option>';
                    }).join('') + '</select>' +
                    '<button class="btn btn-primary btn-sm" onclick="TL.intake.map(\'' + esc(m.id) + '\')">Map</button>' +
                    '</span>'
                  : '<button class="btn btn-ghost btn-sm" onclick="TL.intake.ignore(\'' + esc(m.id) + '\')">Not an application</button>') +
                '</div>';
            }).join('')
          : '<div style="font-size:13px;color:var(--text-soft)">Nothing waiting — every email either imported or was ignored.</div>') +

        '<div id="tlIntakeOut" style="margin-top:12px">' + (TL.intake.lastMessage || '') + '</div>' +
        // Which board to read, beside the button that reads it. Three
        // plain buttons in the row that is already there - no new panel,
        // and "Both" is first because it is what a morning sync wants.
        '<div id="tlIntakeBoard" style="display:flex;gap:6px;align-items:center;margin-top:12px;flex-wrap:wrap">' +
        '<span style="font-size:11px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;' +
        'color:var(--text-soft);margin-right:2px">Import from</span>' +
        [['all', 'Both'], ['naukri', 'Naukri'], ['shine', 'Shine']].map(function (b) {
          return '<button type="button" data-board="' + b[0] + '"' +
            ' class="btn btn-sm ' + ((TL.intake.board || 'all') === b[0] ? 'btn-primary' : 'btn-ghost') + '"' +
            " onclick=\"TL.intake.setBoard('" + b[0] + "')\">" + esc(b[1]) + '</button>';
        }).join('') +
        '</div>' +
        '<div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">' +
        '<button class="btn btn-primary" onclick="TL.intake.sync()">Sync every mailbox now</button>' +
        '<button class="btn btn-ghost" onclick="fcrCloseModal()">Close</button>' +
        '</div>';
    }).catch(function (err) {
      var body = document.getElementById('tlIntakeBody');
      if (body) body.innerHTML = '<div class="req-note">' + esc(err.message || 'Unavailable.') + '</div>';
    });
  };

  function intakeOut(html) {
    // Remembered, because the refresh that follows an action rebuilds the
    // modal - and a result that disappears the instant it is produced is
    // the same as no result at all.
    TL.intake.lastMessage = html || '';
    var el = document.getElementById('tlIntakeOut');
    if (el) el.innerHTML = html;
  }

  TL.intake.connect = function () {
    var addr = ((document.getElementById('tlIntakeAddr') || {}).value || '').trim();
    var provider = (document.getElementById('tlIntakeProvider') || {}).value || 'mock';
    if (!addr) { intakeOut('<div class="req-note">Enter the email address first.</div>'); return; }

    api.post('/intake/mailboxes', { address: addr, provider: provider, autoSync: true })
      .then(function (r) {
        var m = r.mailbox;
        intakeOut('<div class="req-note" style="background:var(--ok-100);color:var(--ok-600)">' +
          esc(m.address) + ' connected.' +
          (m.missingConfig && m.missingConfig.length
            ? ' Before it can be read, set these on the server: <b>' +
              esc(m.missingConfig.join(', ')) + '</b>.'
            : ' TeamLink will read it automatically from now on.') +
          '</div>');
        return TL.intake.refresh();
      })
      .catch(function (err) {
        intakeOut('<div class="req-note">' + esc(err.message || 'That mailbox could not be connected.') + '</div>');
      });
  };

  /*
   * WHICH BOARD to read.
   *
   * The sync always read everything, which is right most mornings and
   * wrong when a recruiter is chasing one board: "Sync" gave no way to
   * say "just the Shine responses", and no way to tell afterwards which
   * of the two the candidates had come from. The API has taken a `board`
   * since Shine was added; nothing on screen ever sent one.
   */
  TL.intake.board = 'all';
  TL.intake.setBoard = function (v) {
    TL.intake.board = v || 'all';
    var host = document.getElementById('tlIntakeBoard');
    if (!host) return;
    [].forEach.call(host.querySelectorAll('button'), function (b) {
      b.className = 'btn btn-sm ' + (b.getAttribute('data-board') === TL.intake.board
        ? 'btn-primary' : 'btn-ghost');
    });
  };

  TL.intake.sync = function (mailboxId) {
    var board = TL.intake.board || 'all';
    intakeOut('<div class="req-note">Reading the mailbox'
      + (board === 'all' ? '' : ' for ' + esc(board === 'naukri' ? 'Naukri' : 'Shine'))
      + '…</div>');
    var body = mailboxId ? { mailboxId: mailboxId } : {};
    if (board !== 'all') body.board = board;
    return api.post('/intake/sync', body)
      .then(function (r) {
        var lines = (r.synced || []).map(function (s) {
          if (s.error) {
            return '<div><b>' + esc(s.mailbox || s.mailboxId) + '</b>: ' +
              esc(s.message || s.error) +
              (s.missing ? ' (set ' + esc((s.missing || []).join(', ')) + ')' : '') + '</div>';
          }
          return '<div><b>' + esc(s.mailbox) + '</b>: read ' + s.seen + ', imported ' + s.imported +
            (s.needsMapping ? ', ' + s.needsMapping + ' awaiting a requirement' : '') +
            (s.needsReview ? ', ' + s.needsReview + ' needing review' : '') +
            (s.ignored ? ', ' + s.ignored + ' ignored' : '') +
            (s.duplicates ? ', ' + s.duplicates + ' already seen' : '') + '</div>';
        }).join('');

        /*
         * How many came from each board, and the note the API returns
         * when a board's format has never been confirmed against a real
         * message - pressing "Shine" and getting nothing has two
         * explanations and this is the one that says which.
         */
        var tally = '';
        if ((r.naukri || 0) + (r.shine || 0) > 0) {
          tally = '<div style="margin-top:6px;font-size:12px">'
            + 'Naukri ' + (r.naukri || 0) + ' · Shine ' + (r.shine || 0) + '</div>';
        }
        intakeOut('<div class="req-note" style="background:var(--ok-100);color:var(--ok-600)">'
          + lines + tally + '</div>'
          + (r.note ? '<div class="req-note" style="margin-top:6px">' + esc(r.note) + '</div>' : ''));
        if (typeof window.toast === 'function' && r.imported) {
          window.toast(r.imported + ' application' + (r.imported === 1 ? '' : 's') + ' imported', '📥');
        }
        return refresh().then(function () { return TL.intake.refresh(); });
      })
      .catch(function (err) {
        intakeOut('<div class="req-note">' + esc(err.message || 'The sync failed.') + '</div>');
      });
  };

  TL.intake.map = function (messageId) {
    var sel = document.getElementById('tlMap_' + messageId);
    var jobId = sel ? sel.value : '';
    if (!jobId) return;
    api.post('/intake/messages/' + encodeURIComponent(messageId) + '/map', { jobId: jobId })
      .then(function (r) {
        intakeOut('<div class="req-note" style="background:var(--ok-100);color:var(--ok-600)">' +
          esc(r.reference ? 'Application ' + r.reference + ' created.' : (r.reason || 'Mapped.')) + '</div>');
        return refresh().then(function () { return TL.intake.refresh(); });
      })
      .catch(function (err) {
        intakeOut('<div class="req-note">' + esc(err.message || 'That could not be mapped.') + '</div>');
      });
  };

  TL.intake.ignore = function (messageId) {
    api.post('/intake/messages/' + encodeURIComponent(messageId) + '/ignore', {})
      .then(function () { return TL.intake.refresh(); })
      .catch(function (err) { say(err); });
  };

  /** The activity timeline for one application, and its messages. */
  TL.intake.timeline = function (applicationId) {
    intakeModalShell('Application activity', '<div class="req-note">Loading…</div>');
    Promise.all([
      api.get('/intake/timeline?applicationId=' + encodeURIComponent(applicationId)),
      api.get('/intake/applications/' + encodeURIComponent(applicationId) + '/communications'),
    ]).then(function (out) {
      var timeline = out[0].timeline || [];
      var comms = out[1].communications || [];
      var body = document.getElementById('tlIntakeBody');
      if (!body) return;

      body.innerHTML =
        '<div style="font-size:11px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;' +
        'color:var(--text-soft);margin-bottom:6px">Activity</div>' +
        (timeline.length
          ? timeline.map(function (t) {
              return '<div style="display:flex;gap:10px;padding:6px 0;border-bottom:1px solid var(--line)">' +
                '<span style="font-size:12px;color:var(--text-soft);white-space:nowrap;min-width:150px">' +
                new Date(t.at).toLocaleString('en-GB') + '</span>' +
                '<span style="font-size:13px">' + esc(t.detail || t.type) + '</span></div>';
            }).join('')
          : '<div style="font-size:13px;color:var(--text-soft)">Nothing recorded yet.</div>') +

        '<div style="font-size:11px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;' +
        'color:var(--text-soft);margin:14px 0 6px">Communication history</div>' +
        (comms.length
          ? '<table class="data" style="width:100%"><thead><tr><th>When</th><th>Channel</th>' +
            '<th>To</th><th>Status</th></tr></thead><tbody>' +
            comms.map(function (c) {
              return '<tr><td style="font-size:12px;white-space:nowrap">' +
                new Date(c.at).toLocaleString('en-GB') + '</td><td>' + esc(c.channel) + '</td>' +
                '<td style="font-size:12px">' + esc(c.to || '—') + '</td>' +
                '<td><span class="badge ' +
                (c.status === 'sent' || c.status === 'delivered' ? 'badge-ok'
                  : c.status === 'failed' ? 'badge-bad' : 'badge-neutral') + '">' +
                esc(c.status) + '</span>' +
                (c.error ? '<div style="font-size:11px;color:var(--bad-600)">' + esc(c.error) + '</div>' : '') +
                '</td></tr>';
            }).join('') + '</tbody></table>'
          : '<div style="font-size:13px;color:var(--text-soft)">Nothing sent yet.</div>') +

        '<div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap">' +
        '<button class="btn btn-primary btn-sm" onclick="TL.intake.resend(\'' + esc(applicationId) + '\')">Send the registration link again</button>' +
        '<button class="btn btn-ghost btn-sm" onclick="fcrCloseModal()">Close</button></div>' +
        '<div id="tlIntakeOut" style="margin-top:10px"></div>';
    }).catch(function (err) {
      var body = document.getElementById('tlIntakeBody');
      if (body) body.innerHTML = '<div class="req-note">' + esc(err.message || 'Unavailable.') + '</div>';
    });
  };

  TL.intake.resend = function (applicationId) {
    api.post('/intake/applications/' + encodeURIComponent(applicationId) + '/resend', {})
      .then(function (r) {
        intakeOut('<div class="req-note" style="background:var(--ok-100);color:var(--ok-600)">' +
          Object.keys(r.sent || {}).map(function (k) { return esc(k + ': ' + r.sent[k]); }).join(' · ') +
          (r.newPasswordIssued ? '<br>A new temporary password was issued.' : '') + '</div>');
      })
      .catch(function (err) {
        intakeOut('<div class="req-note">' + esc(err.message || 'That could not be sent.') + '</div>');
      });
  };

  /* ---- the button, in the panel that is already there ------------- */

  /**
   * Put "Import from Mail" in the Applications panel head, and show each
   * application's TL-APP reference under the candidate's name.
   *
   * Done after render because both live inside the prototype's own
   * closure, which has no seam to override. Idempotent, and it never
   * throws into a render.
   */
  function enhanceApplications() {
    var heads = document.querySelectorAll('.panel-head');
    for (var i = 0; i < heads.length; i++) {
      var head = heads[i];
      var h2 = head.querySelector('h2');
      if (!h2 || !/all applications/i.test(h2.textContent || '')) continue;
      if (head.querySelector('[data-tl-intake]')) continue;

      var btn = document.createElement('button');
      btn.className = 'btn btn-primary btn-sm';
      btn.textContent = '📥 Import from Mail';
      btn.title = 'Import Naukri applications from the recruiter mailbox';
      btn.setAttribute('data-tl-intake', '1');
      btn.onclick = function () { TL.intake.open(); };
      btn.style.marginLeft = 'auto';
      head.appendChild(btn);
    }

    // The application reference, where a recruiter is already looking.
    var byId = Object.create(null);
    (DATA.applications || []).forEach(function (a) {
      if (a.reference) byId[a.candidateId + '|' + a.jobId] = a;
    });

    var rows = document.querySelectorAll('table.data tbody tr');
    for (var r = 0; r < rows.length; r++) {
      var row = rows[r];
      if (row.querySelector('[data-tl-ref]')) continue;
      var onclick = (row.cells[0] && row.cells[0].getAttribute('onclick')) || '';
      var m = /candidate-profile\?id=([^']+)/.exec(onclick);
      if (!m) continue;

      var app = null;
      var keys = Object.keys(byId);
      for (var k = 0; k < keys.length; k++) {
        if (keys[k].indexOf(m[1] + '|') === 0) { app = byId[keys[k]]; break; }
      }
      if (!app) continue;

      var tag = document.createElement('div');
      tag.setAttribute('data-tl-ref', '1');
      tag.style.cssText = 'font-size:11px;color:var(--text-soft);margin-top:2px';
      tag.textContent = app.reference + (app.importMethod === 'recruiter_email' ? ' · from mail' : '');
      row.cells[0].appendChild(tag);
    }
  }

  /**
   * A candidate row must never read "undefined".
   *
   * personCell() builds its subtitle as `location · experience`, which is
   * fine for a profile somebody filled in and wrong for one imported from
   * an email that did not mention either - the cell then literally says
   * "undefined · 6 years". The original is called unchanged and only the
   * missing halves are removed, so nothing else about the cell moves.
   */
  /**
   * A missing match score is an em dash, not "undefined%".
   *
   * The pipeline reads `a.matchScore` straight into the score badge, and
   * an application created before scoring existed - or by any route that
   * did not set one - rendered the word "undefined" at the recruiter.
   * Nothing is invented to fill the gap: an unscored application says so.
   */
  /**
   * A horizontal scrollbar above a wide table, as well as below it.
   *
   * A table that scrolls sideways puts its scrollbar at the bottom, which
   * on a long list means scrolling down past every row to reach it, using
   * it, and scrolling back up to read the header you were trying to
   * reach. A second bar above the header solves it without changing the
   * table at all.
   *
   * The two are the same scroll position: a thin strip holding a spacer
   * the width of the table's content, with each one following the other.
   * It appears only when the table actually overflows, so nothing changes
   * on a table that fits.
   */
  function addTopScrollbars() {
    var wraps = document.querySelectorAll('.tbl-wrap, .fcr-table-wrap, .table-scroll');
    for (var i = 0; i < wraps.length; i++) {
      var wrap = wraps[i];
      var overflows = wrap.scrollWidth > wrap.clientWidth + 2;
      var existing = wrap.previousElementSibling;
      var bar = existing && existing.classList
        && existing.classList.contains('tl-scroll-top') ? existing : null;

      if (!overflows) {
        // The table fits now - a bar with nothing to scroll is clutter.
        if (bar) bar.remove();
        continue;
      }

      if (!bar) {
        bar = document.createElement('div');
        bar.className = 'tl-scroll-top';
        bar.appendChild(document.createElement('div'));
        wrap.parentNode.insertBefore(bar, wrap);

        // Each one follows the other. The guard stops the two scroll
        // handlers bouncing the position back and forth.
        var syncing = false;
        bar.addEventListener('scroll', function (b, w) {
          return function () {
            if (syncing) return;
            syncing = true;
            w.scrollLeft = b.scrollLeft;
            syncing = false;
          };
        }(bar, wrap), { passive: true });

        wrap.addEventListener('scroll', function (b, w) {
          return function () {
            if (syncing) return;
            syncing = true;
            b.scrollLeft = w.scrollLeft;
            syncing = false;
          };
        }(bar, wrap), { passive: true });
      }

      // The spacer is what gives the strip something to scroll.
      bar.firstChild.style.width = wrap.scrollWidth + 'px';
      bar.scrollLeft = wrap.scrollLeft;
    }
  }

  // The stylesheet is the prototype's; this adds one rule to it rather
  // than restyling anything that already exists.
  (function () {
    if (document.getElementById('tl-scroll-top-style')) return;
    var css = document.createElement('style');
    css.id = 'tl-scroll-top-style';
    css.textContent =
      '.tl-scroll-top{overflow-x:auto;overflow-y:hidden;height:12px;' +
      'border-bottom:1px solid var(--line, #e5e7eb)}' +
      '.tl-scroll-top>div{height:1px}' +
      '.tl-scroll-top::-webkit-scrollbar{height:10px}' +
      '.tl-scroll-top::-webkit-scrollbar-thumb{background:var(--line,#cbd5e1);border-radius:6px}' +
      '.tl-scroll-top::-webkit-scrollbar-thumb:hover{background:var(--text-soft,#94a3b8)}';
    (document.head || document.documentElement).appendChild(css);
  }());

  var realRenderForTables = window.render;
  window.render = function () {
    var out = realRenderForTables.apply(this, arguments);
    // After the paint, when the table has a width to measure.
    try {
      requestAnimationFrame(function () {
        try { addTopScrollbars(); } catch (e) { /* never break a render */ }
      });
    } catch (e) { /* no rAF: not worth failing over */ }
    return out;
  };

  window.addEventListener('resize', function () {
    try { addTopScrollbars(); } catch (e) {}
  });

  /*
   * The score, where the stage badge used to say nothing.
   *
   * Every application is screened automatically on arrival, and the
   * result - a percentage against the requirement, from the weights in
   * AI Settings - was written to the application and shown nowhere. The
   * recruiter saw an "AI Screening" badge instead, which said the
   * software had run without saying what it found.
   *
   * The score cell now prefers the SCREENING score and explains which
   * one it is, falling back to the keyword match when nothing has been
   * screened yet. An unscored application shows an em dash rather than
   * "undefined%".
   */
  function showScores() {
    var badges = document.querySelectorAll('span.score');
    for (var i = 0; i < badges.length; i++) {
      var b = badges[i];
      if (b.getAttribute('data-tl-score') === '1') continue;

      var row = b.closest ? b.closest('tr') : null;
      var cid = row ? reachCandidateOf(row) : null;
      var app = cid ? reachApplicationOfRow(row, cid) : null;

      if (app && app.aiScore != null) {
        b.textContent = app.aiScore + '%';
        b.title = 'AI screening score — how well this resume matches the '
          + 'requirement, scored automatically when they applied'
          + (app.matchScore != null ? '. Keyword match: ' + app.matchScore + '%' : '');
        b.setAttribute('data-tl-score', '1');
        continue;
      }

      if (/^\s*(undefined|null|NaN)%/.test(b.textContent || '')) {
        b.textContent = '\u2014';
        b.title = 'Not scored yet';
        b.setAttribute('data-tl-score', '1');
      }
    }
  }

  var realRenderForScores = window.render;
  window.render = function () {
    var out = realRenderForScores.apply(this, arguments);
    try { showScores(); } catch (e) { /* never break a render */ }
    return out;
  };

  var prevPersonCell = window.personCell;
  if (typeof prevPersonCell === 'function') {
    window.personCell = function () {
      var html = prevPersonCell.apply(this, arguments);
      return String(html)
        .replace(/>undefined\s*\u00b7\s*undefined</g, '><')
        .replace(/>undefined\s*\u00b7\s*/g, '>')
        .replace(/\s*\u00b7\s*undefined</g, '<')
        .replace(/>undefined</g, '><');
    };
  }

  var realRenderForIntake = window.render;
  window.render = function () {
    var out = realRenderForIntake.apply(this, arguments);
    try { enhanceApplications(); } catch (e) { /* never break a render */ }
    return out;
  };

  /* ------------------------------------------------------------------ *
   * 19. Every channel a candidate hears from us on, on the recruiter's
   *     own screen
   *
   * Two gaps, one screen.
   *
   * FIRST: email had a settings page and the other three did not. SMS,
   * WhatsApp and the calling agent already send at every stage - the
   * same dispatch, the same templates, the same delivery log - but with
   * no credentials they record `not_configured`, which reads like a
   * fault rather than a setting nobody has filled in. "She got no SMS"
   * had no answer anywhere a recruiter could reach.
   *
   * SECOND: the calling agent's configuration existed for an admin only,
   * so the recruiter placing the calls could not see what the agent
   * would say, which languages it answers in, whether it discloses that
   * it is an AI, or why a call is not going out.
   *
   * This is a TAB on the existing Email / SMS / IVR screen. Not a new
   * module, not a new menu: same tab strip, same panels, same classes,
   * same buttons.
   *
   * ONE DELIBERATE DIFFERENCE from the usual provider-settings page:
   * there is no API key box anywhere on it. Credentials are environment
   * variables on the server. This screen reports whether they are
   * present and names the ones that are missing - it never receives,
   * displays or stores a value. A page that takes an API key in a text
   * field hands it to everybody who can open the developer tools.
   *
   * A recruiter reads. Only an admin writes, and that is enforced by the
   * API and by row-level security, not by hiding a button.
   * ------------------------------------------------------------------ */

  TL.channels = {};

  var CH_LANGS = { en: 'English', hi: 'Hindi', te: 'Telugu' };

  var CH_META = {
    email:    { icon: '✉️', label: 'Email',       what: 'Every stage, and the interview deadline' },
    sms:      { icon: '💬', label: 'SMS',         what: 'The same updates, shortened to one message' },
    whatsapp: { icon: '🟢', label: 'WhatsApp',    what: 'The same updates, for candidates who read little else' },
    // The spoken STAGE UPDATE, which is a different thing from the
    // conversational agent below: this one reads an update out and hangs
    // up, the agent holds a conversation. They are configured separately
    // and a screen that blurs them sends somebody hunting the wrong
    // credential.
    ivr:      { icon: '📞', label: 'Voice call',  what: 'The same updates, read out over the phone' },
  };

  /*
   * READ-ONLY, and not for the reason it first looks.
   *
   * This started with editable fields for an admin. They were dead code:
   * the prototype routes /recruiter/* to the recruiter login for anybody
   * else, so an admin cannot open this screen at all. A Save button
   * nobody can reach is worse than none - it implies a way to change
   * these that does not exist.
   *
   * The settings ARE changed, through PATCH /ai-calling/settings, which
   * is admin-only and enforced in the API and in the database. This
   * screen is the recruiter's answer to "what will the agent say, and
   * why did nothing go out", which is what they actually needed.
   */
  function chRow(label, value) {
    return '<div class="fcr-jd-row"><label>' + esc(label) + '</label>' +
           '<span class="v">' + value + '</span></div>';
  }

  function chField(label, value, hint) {
    return chRow(label, esc(String(value == null ? '' : value)) +
      (hint ? '<div class="desc">' + esc(hint) + '</div>' : ''));
  }

  function chToggle(label, on, hint) {
    return chRow(label, (on
      ? '<span class="badge badge-ok">On</span>'
      : '<span class="badge badge-neutral">Off</span>') +
      (hint ? '<div class="desc">' + esc(hint) + '</div>' : ''));
  }

  /**
   * The four channels, side by side.
   *
   * Counts over thirty days, because "it has never worked" and "it
   * stopped working on Tuesday" are different problems and the screen
   * should not make somebody guess which one they have.
   */
  function chChannelsPanel(list) {
    var rows = list.map(function (c) {
      var m = CH_META[c.channel] || { icon: '•', label: c.channel, what: '' };
      var state = c.configured
        ? '<span class="badge badge-ok">Sending</span>'
        : '<span class="badge badge-neutral">Not configured</span>';

      var detail = c.configured
        ? esc(c.transport)
        : (c.missing && c.missing.length
            ? 'Needs ' + c.missing.map(esc).join(', ') +
              ' on the server — never entered here'
            : 'No provider connected');

      return '<tr><td><b>' + m.icon + ' ' + esc(m.label) + '</b>' +
        '<div class="desc">' + esc(m.what) + '</div></td>' +
        '<td>' + state + '<div class="desc">' + detail + '</div></td>' +
        '<td>' + c.sent + '</td>' +
        '<td>' + (c.failed ? '<b>' + c.failed + '</b>' : '0') + '</td>' +
        '<td>' + (c.notConfigured || 0) + '</td>' +
        '<td>' + (c.noAddress || 0) + '</td></tr>';
    }).join('');

    var silent = list.filter(function (c) { return !c.configured; });

    return '<div class="panel"><div class="panel-head"><div><h2>Notification channels</h2>' +
      '<div class="desc">What a candidate hears from us on, and what it has ' +
      'done in the last 30 days</div></div></div>' +
      '<div class="panel-body pad0"><div class="tbl-wrap"><table class="data">' +
      '<thead><tr><th>Channel</th><th>Status</th><th>Sent</th><th>Failed</th>' +
      '<th>Not configured</th><th>No number</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div>' +
      (silent.length
        ? '<div class="panel-body"><div class="req-note"><b>' +
          silent.map(function (c) { return esc((CH_META[c.channel] || {}).label || c.channel); }).join(', ') +
          '</b> already send at every stage — the same updates as email, ' +
          'from the same code. They are recorded as <i>not configured</i> rather ' +
          'than sent because the credentials are not on the server yet. Nothing ' +
          'needs building: add the values named above and they start going out, ' +
          'and everybody who was missed while they were silent is picked up by ' +
          'the retry.</div></div>'
        : '') +
      '</div>';
  }

  /**
   * SMS and WhatsApp configuration — what the carrier checks.
   *
   * Both channels have composed a message at every stage since the
   * dispatcher was built. What stopped them was never the code, and
   * adding the API key alone does not finish it either:
   *
   *   SMS       An Indian operator drops a message whose header is not a
   *             registered DLT sender and whose body does not match a
   *             registered DLT template. Some aggregators answer that
   *             with a success-shaped response, so it reads as sent.
   *   WhatsApp  Meta allows free text only inside the 24 hours after the
   *             candidate writes to us. A stage update is
   *             business-initiated, so it needs an approved template.
   *
   * These are the fields that carry those, and none of them is a secret:
   * a sender header and a template name are printed on the message the
   * candidate receives. The key is not here, for the same reason it is
   * not on the calling panel — every recruiter can open this page.
   */
  function chChannelForm(channel, cfg, status) {
    var f = function (id, label, value, placeholder, hint) {
      return '<div class="fgroup"><label>' + esc(label) + '</label>'
        + '<input id="' + id + '" value="' + esc(value == null ? '' : value) + '"'
        + ' placeholder="' + esc(placeholder || '') + '"'
        + ' style="width:100%;padding:10px 12px;border-radius:8px;border:1px solid var(--line);'
        + 'background:var(--card);color:var(--text);font-size:13px">'
        + (hint ? '<div class="desc">' + esc(hint) + '</div>' : '') + '</div>';
    };
    var missing = (status && status.missing) || [];
    var keyNote = '<div class="fgroup"><label>API Key</label>'
      + '<div class="req-note" style="margin:0;font-size:12px">'
      + (missing.length
          ? 'Set <b>' + missing.map(esc).join(', ') + '</b> in the server environment.'
          : 'Configured on the server.')
      + ' It is never entered here and never reaches a browser.</div></div>';

    var left, right, head, why;

    if (channel === 'sms') {
      head = 'SMS Configuration';
      why = 'The sender header and DLT registration an operator checks';
      left = f('chSmsSender', 'Sender ID / Header', cfg.senderId, 'TMLINK',
               'The six characters a candidate sees instead of a number')
           + f('chSmsEntity', 'DLT Entity ID', cfg.dltEntityId, '11010xxxxxxxxxxxxx',
               'Issued once, to the company, when it registers with the operator');
      right = f('chSmsTemplate', 'DLT Template ID', cfg.dltTemplateId, '11070xxxxxxxxxxxxx',
               'The approved wording this message must match')
           + keyNote;
    } else {
      head = 'WhatsApp Configuration';
      why = 'The approved template used for messages we start';
      left = f('chWaTemplate', 'Message Template Name', cfg.templateName, 'teamlink_update',
               'Approved in WhatsApp Manager. Leave empty to send plain text, '
               + 'which only reaches a candidate who messaged us in the last 24 hours.')
           + f('chWaLang', 'Template Language', cfg.templateLanguage, 'en',
               'The language code on the approved template, e.g. en, en_US, hi, te');
      right = keyNote
        + '<div class="req-note" style="margin:10px 0 0;font-size:12px">'
        + 'The template must have exactly <b>one</b> body variable. '
        + 'The whole message goes into it, so the wording stays the same '
        + 'across email, SMS and WhatsApp instead of drifting into a second copy.'
        + '</div>';
    }

    return '<div class="panel"><div class="panel-head"><div><h2>' + esc(head) + '</h2>'
      + '<div class="desc">' + esc(why) + '</div></div></div>'
      + '<div class="panel-body">'
      + '<div class="review-grid"><div>' + left + '</div><div>' + right + '</div></div>'
      + '<div style="display:flex;gap:8px;align-items:center;margin-top:12px">'
        + '<button class="btn btn-primary" id="chSave_' + channel + '"'
        + ' onclick="TL.channels.saveChannel(\'' + channel + '\')">Save Configuration</button>'
        + '<span id="chSaved_' + channel + '" style="font-size:12.5px;color:var(--text-soft)"></span>'
      + '</div>'
      + '</div></div>';
  }

  /**
   * Save one channel's settings to the server.
   *
   * Every field is sent, including the blank ones, so clearing a DLT
   * template id really clears it rather than leaving the old one on
   * every message.
   */
  TL.channels.saveChannel = function (channel) {
    var val = function (id) {
      var el = document.getElementById(id);
      return el ? String(el.value || '').trim() : '';
    };
    var body = channel === 'sms'
      ? { senderId: val('chSmsSender'),
          dltEntityId: val('chSmsEntity'),
          dltTemplateId: val('chSmsTemplate') }
      : { templateName: val('chWaTemplate'),
          templateLanguage: val('chWaLang') };

    var btn = document.getElementById('chSave_' + channel);
    var said = document.getElementById('chSaved_' + channel);
    if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }

    api.patch('/notifications/channels/' + channel, body).then(function () {
      if (btn) { btn.disabled = false; btn.textContent = 'Save Configuration'; }
      if (said) {
        said.textContent = 'Saved';
        setTimeout(function () { said.textContent = ''; }, 2600);
      }
      TL.channels.render(true);
    }).catch(function (err) {
      if (btn) { btn.disabled = false; btn.textContent = 'Save Configuration'; }
      if (said) said.textContent = err.message || 'It could not be saved';
    });
  };

  /** Whether calls can actually be placed, and what is missing if not. */
  /**
   * Provider Configuration — the fields a recruiter can actually set.
   *
   * The screen this replaces had an "API Key / Token" box labelled
   * "stored locally in this demo only". That is the one field that must
   * not exist: this page is readable by every recruiter, and a form
   * taking an API key hands it to anybody who can open the developer
   * tools. The credential lives in the server environment and the panel
   * reports only whether it is there.
   *
   * Everything else is genuinely a recruiter's to set — which provider,
   * the number a candidate sees, how often to try, whether calls go out
   * automatically — and is saved to the SERVER, not to the browser,
   * which is what the old screen did and why nothing it saved was ever
   * used to place a call.
   */
  function chProviderForm(s, t) {
    var sel = function (id, label, value, options, hint) {
      return '<div class="fgroup"><label>' + esc(label) + '</label>'
        + '<select id="' + id + '" style="width:100%;padding:10px 12px;border-radius:8px;'
        + 'border:1px solid var(--line);background:var(--card);color:var(--text);font-size:13px">'
        + options.map(function (o) {
            return '<option value="' + esc(o[0]) + '"'
              + (String(value) === String(o[0]) ? ' selected' : '') + '>'
              + esc(o[1]) + '</option>';
          }).join('')
        + '</select>' + (hint ? '<div class="desc">' + esc(hint) + '</div>' : '') + '</div>';
    };
    var inp = function (id, label, value, placeholder, hint) {
      return '<div class="fgroup"><label>' + esc(label) + '</label>'
        + '<input id="' + id + '" value="' + esc(value == null ? '' : value) + '"'
        + ' placeholder="' + esc(placeholder || '') + '"'
        + ' style="width:100%;padding:10px 12px;border-radius:8px;border:1px solid var(--line);'
        + 'background:var(--card);color:var(--text);font-size:13px">'
        + (hint ? '<div class="desc">' + esc(hint) + '</div>' : '') + '</div>';
    };
    var chk = function (id, label, on, hint) {
      return '<label style="display:flex;gap:8px;align-items:flex-start;margin:8px 0">'
        + '<input type="checkbox" id="' + id + '"' + (on ? ' checked' : '') + '>'
        + '<span><b>' + esc(label) + '</b>'
        + (hint ? '<div class="desc">' + esc(hint) + '</div>' : '') + '</span></label>';
    };

    var missing = (t && t.missing) || [];
    var live = !!(t && t.configured && t.real);

    return '<div class="panel"><div class="panel-head"><div><h2>Provider Configuration</h2>'
      + '<div class="desc">Which telephony provider places the calls, and how</div></div></div>'
      + '<div class="panel-body">'
      + '<div class="review-grid"><div>'
        + sel('chProvider', 'Provider', s.provider || 'not_selected', [
            ['not_selected', 'Not selected'],
            ['local', 'Built-in (rehearsal only — no phone rings)'],
            ['twilio', 'Twilio'],
            ['exotel', 'Exotel'],
          ])
        + inp('chCallerId', 'Caller ID', s.callerId, '+91XXXXXXXXXX',
              'The number a candidate sees when the agent rings them')
        + inp('chRetries', 'Max Retry Attempts', s.retryNoAnswer, '3',
              'How many times to try again when nobody answers')
      + '</div><div>'
        + inp('chApiUrl', 'API URL', s.apiUrl, 'https://api.provider.com/v1',
              'Only for a provider with a non-standard endpoint')
        + inp('chRetryMins', 'Retry Interval (minutes)', s.retryIntervalMinutes, '15')
        + '<div class="fgroup"><label>API Key / Token</label>'
          + '<div class="req-note" style="margin:0;font-size:12px">'
          + (missing.length
            ? 'Set <b>' + esc(missing.join(', ')) + '</b> in the server environment.'
            : 'Configured on the server.')
          + ' It is never entered here and never reaches a browser — this page is '
          + 'readable by every recruiter.</div></div>'
      + '</div></div>'
      + chk('chAutoInterview', 'Enable Automatic Interview Calls', s.autoInterviewCalls,
            live ? 'Calls a candidate when their interview is scheduled.'
                 : 'No carrier is connected, so this has no effect yet.')
      + chk('chAutoReminder', 'Enable Automatic Reminder Calls', s.autoReminderCalls,
            live ? 'Calls a candidate before their interview.'
                 : 'No carrier is connected, so this has no effect yet.')
      + '<div style="display:flex;gap:8px;align-items:center;margin-top:12px">'
        + '<button class="btn btn-primary" id="chSave" onclick="TL.channels.save()">'
        + 'Save Configuration</button>'
        + '<span id="chSaved" style="font-size:12.5px;color:var(--text-soft)"></span>'
      + '</div>'
      + '</div></div>';
  }

  /** Collect the form and save it to the server. */
  TL.channels.save = function () {
    var val = function (id) {
      var el = document.getElementById(id);
      return el ? String(el.value || '').trim() : '';
    };
    var on = function (id) {
      var el = document.getElementById(id);
      return !!(el && el.checked);
    };
    var num = function (id) {
      var v = Number(val(id));
      return isFinite(v) && v >= 0 ? v : undefined;
    };

    var btn = document.getElementById('chSave');
    var said = document.getElementById('chSaved');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }

    api.patch('/ai-calling/settings', {
      provider: val('chProvider') || undefined,
      // Sent even when blank, so clearing a caller ID really clears it
      // rather than silently keeping the old number on a candidate's
      // phone.
      callerId: val('chCallerId'),
      apiUrl: val('chApiUrl'),
      retryNoAnswer: num('chRetries'),
      retryIntervalMinutes: num('chRetryMins'),
      autoInterviewCalls: on('chAutoInterview'),
      autoReminderCalls: on('chAutoReminder'),
    }).then(function () {
      if (btn) { btn.disabled = false; btn.textContent = 'Save Configuration'; }
      if (said) {
        said.textContent = 'Saved';
        setTimeout(function () { said.textContent = ''; }, 2600);
      }
      TL.channels.render(true);
    }).catch(function (err) {
      if (btn) { btn.disabled = false; btn.textContent = 'Save Configuration'; }
      if (said) said.textContent = err.message || 'It could not be saved';
    });
  };

  function chTelephonyPanel(t) {
    /*
     * "Configured" and "a phone will ring" are different questions.
     *
     * The built-in driver is always usable - it is what lets the whole
     * conversation be rehearsed on screen without a carrier account -
     * and it reports itself as configured. Reading "Calls are live" off
     * that would tell a recruiter something untrue about a candidate who
     * was never actually rung.
     */
    var live = !!(t && t.configured && t.real);
    var rehearsal = !!(t && t.simulated);
    var missing = (t && t.missing) || [];

    var note = live
      ? '<div class="req-note" style="background:var(--ok-100);color:var(--ok-600)">' +
        '<b>Calls are live.</b> The agent places real calls through ' + esc(t.active) +
        ', and every call is recorded against the candidate and the requirement.</div>'
      : rehearsal
        ? '<div class="req-note"><b>Rehearsal only — no phone rings.</b> ' +
          'No carrier is connected, so calls run on the built-in driver: the ' +
          'agent plans the call and holds the whole conversation on screen, ' +
          'and the result is recorded, but nobody is dialled. Connect a ' +
          'provider to place real calls.</div>'
        : '<div class="req-note"><b>No phone rings yet.</b> ' +
          (missing.length
            ? 'The server is missing ' + missing.map(esc).join(', ') + '. Those are ' +
              'environment variables — they are never entered here and never ' +
              'reach a browser.'
            : 'No telephony provider is connected.') + '</div>';

    return '<div class="panel"><div class="panel-head"><div><h2>Calling provider</h2>' +
      '<div class="desc">Whether the agent can place a real call right now</div></div>' +
      '<span class="badge ' + (live ? 'badge-ok' : 'badge-neutral') + '" style="margin-left:auto">' +
      (live ? 'Connected' : rehearsal ? 'Rehearsal only' : 'Not configured') + '</span></div>' +
      '<div class="panel-body">' + note +
      chRow('Provider', esc(String((t && t.requested) || 'none'))) +
      chRow('In use', esc(String((t && t.active) || 'none'))) +
      chRow('Speech to text', esc(String((t && t.stt) || 'none'))) +
      chRow('Speech from text', esc(String((t && t.tts) || 'none'))) +
      '</div></div>';
  }

  /** What the agent says, and to whom. */
  function chAgentPanel(s) {
    var langs = (s.supportedLanguages || []).map(function (l) {
      return CH_LANGS[l] || l;
    }).join(', ');

    return '<div class="panel"><div class="panel-head"><div><h2>The calling agent</h2>' +
      '<div class="desc">What the agent calls itself, and the languages it ' +
      'answers in</div></div></div>' +
      '<div class="panel-body">' +
      chField('Agent name', s.agentName, 'The name it gives when somebody answers') +
      chField('Calling on behalf of', s.companyName) +
      chRow('Languages', esc(langs) + ' — detected from the first words the ' +
            'candidate speaks, and switched mid-call if they switch') +
      chRow('Default language', esc(CH_LANGS[s.defaultLanguage] || s.defaultLanguage || 'English')) +
      chField('Voice', s.voice) +
      chField('Style', s.conversationStyle) +
      '</div></div>';
  }

  /** Consent, disclosure and recording: the part with legal weight. */
  function chConsentPanel(s) {
    return '<div class="panel"><div class="panel-head"><div><h2>Disclosure and recording</h2>' +
      '<div class="desc">What the candidate is told before anything else</div></div></div>' +
      '<div class="panel-body">' +
      chToggle('Say that the caller is an AI', s.discloseAi,
        'Required in several places, and the honest default everywhere else.') +
      chRow('Wording', esc(s.aiDisclosure || '')) +
      chToggle('Record calls', s.recordingEnabled,
        'When on, the candidate is told before the conversation starts.') +
      chRow('Wording', esc(s.recordingDisclosure || '')) +
      chToggle('Discuss salary', s.discloseSalary) +
      chToggle('Name the client company', s.discloseClient,
        'Off by default — the client’s name is usually not ours to give out.') +
      '<div class="req-note">A candidate who asks not to be contacted again is ' +
      'recorded as do-not-contact, and that stops <b>every</b> channel — calls, ' +
      'job alerts, stage updates and the retry — not only the calling agent.</div>' +
      '</div></div>';
  }

  /** When it calls, how long it waits, and how often it tries again. */
  function chCallingPanel(s) {
    return '<div class="panel"><div class="panel-head"><div><h2>When and how often</h2>' +
      '<div class="desc">Calling hours, retries and how long a call may run</div></div></div>' +
      '<div class="panel-body">' +
      chField('Calls start at', s.callWindowStart) +
      chField('Calls stop at', s.callWindowEnd,
        'Nobody is called outside these hours, whatever a campaign asks for.') +
      chField('Retries when there is no answer', s.retryNoAnswer) +
      chField('Minutes between retries', s.retryIntervalMinutes) +
      chField('Longest a call may run (seconds)', s.maxDurationSeconds) +
      chField('Seconds of silence before prompting', s.silencePromptSeconds) +
      chField('Prompts before hanging up politely', s.maxSilencePrompts) +
      '</div></div>';
  }

  /** Paint the tab body, fetching the live status first. */
  TL.channels.render = function (force) {
    var host = document.getElementById('tlChannels');
    if (!host) return;
    if (host.getAttribute('data-loaded') === '1' && !force) return;
    host.setAttribute('data-loaded', '1');

    Promise.all([
      api.get('/notifications/channels'),
      // The calling agent's own configuration. A recruiter can read it;
      // only an admin can write, which the API enforces.
      api.get('/ai-calling/status').catch(function () { return null; }),
    ]).then(function (out) {
      var host2 = document.getElementById('tlChannels');
      if (!host2) return;

      var list = (out[0] && out[0].channels) || [];
      var chan = (out[0] && out[0].settings) || {};
      var calling = out[1];
      var s = (calling && calling.settings) || null;
      var statusOf = function (name) {
        for (var i = 0; i < list.length; i++) {
          if (list[i].channel === name) return list[i];
        }
        return null;
      };

      host2.innerHTML =
        chChannelsPanel(list) +
        chChannelForm('sms', chan.sms || {}, statusOf('sms')) +
        chChannelForm('whatsapp', chan.whatsapp || {}, statusOf('whatsapp')) +
        (calling ? chTelephonyPanel(calling.telephony) : '') +
        (s ? chProviderForm(s, calling && calling.telephony) : '') +
        (s ? chAgentPanel(s) + chConsentPanel(s) + chCallingPanel(s) : '') +
        (s
          ? '<div class="req-note">These settings are shared by everybody who ' +
            'calls, so an administrator changes them for the whole team. Ask ' +
            'one to, rather than working around a setting that is wrong.</div>'
          : '');
    }).catch(function (err) {
      var host2 = document.getElementById('tlChannels');
      if (host2) {
        host2.setAttribute('data-loaded', '0');
        host2.innerHTML = '<div class="req-note">' +
          esc(err.message || 'The channel settings could not be loaded.') + '</div>';
      }
    });
  };

  /**
   * Add the tab, and take over the body when it is the one selected.
   *
   * The tab strip is the prototype's own; this appends one button to it
   * and replaces what sits underneath. Nothing else on the screen is
   * touched, and on every other tab it does nothing at all.
   */
  function enhanceComm() {
    var strip = document.querySelector('.tws-tabs');
    if (!strip) return;

    // Only the recruiter's Email / SMS / IVR screen has an IVR tab, so
    // this cannot wander onto another screen that uses the same chrome.
    var isComm = false;
    var buttons = strip.querySelectorAll('.tws-tab');
    for (var i = 0; i < buttons.length; i++) {
      if (/ivr templates/i.test(buttons[i].textContent || '')) isComm = true;
    }
    if (!isComm) return;

    var active = /[?&]tab=channels(&|$)/.test(String(location.hash || location.href));

    var tab = strip.querySelector('[data-tl-channels]');
    if (!tab) {
      tab = document.createElement('button');
      tab.className = 'tws-tab';
      tab.textContent = 'SMS / WhatsApp / AI Calling';
      tab.setAttribute('data-tl-channels', '1');
      tab.onclick = function () { window.navigate('/recruiter/comm?tab=channels'); };
      strip.appendChild(tab);
    }
    tab.className = 'tws-tab' + (active ? ' on' : '');

    if (!active) return;

    // With tab=channels the prototype matched none of its own tabs and
    // fell through to the email template list. Replace that, and only that.
    var host = document.getElementById('tlChannels');
    if (!host) {
      var node = strip.nextElementSibling;
      while (node) {
        var next = node.nextElementSibling;
        node.parentNode.removeChild(node);
        node = next;
      }
      host = document.createElement('div');
      host.id = 'tlChannels';
      host.innerHTML = '<div class="req-note">Loading the notification channels…</div>';
      strip.parentNode.appendChild(host);
    }
    TL.channels.render(false);
  }

  var realRenderForChannels = window.render;
  window.render = function () {
    var out = realRenderForChannels.apply(this, arguments);
    try { enhanceComm(); } catch (e) { /* never break a render */ }
    return out;
  };

  /* ------------------------------------------------------------------ *
   * 20. Two things a person sees before anything else
   *
   * (a) THE RESUME COMES FIRST. It was section 3 of 5, below Personal
   *     and Professional Information - so the form asked somebody to
   *     type their name, mobile, location, company, designation,
   *     experience, qualification and skills, and only then offered to
   *     read all of it out of the file they were about to upload
   *     anyway. The upload fills those fields; putting it last is asking
   *     for work the software was about to do.
   *
   *     Nothing is rebuilt: the same panel, the same upload box, the
   *     same handlers. It is moved to the top of the form and the
   *     section numbers are renumbered to match, so the page still reads
   *     1, 2, 3, 4, 5.
   *
   * (b) ONE HOME, NOT TWO. The candidate header carries a Home chip, and
   *     the profile dropdown in the SAME header carries another. Two
   *     controls, one destination, an arm's length apart. The visible
   *     chip stays; the one hidden behind a menu goes.
   * ------------------------------------------------------------------ */

  /** Put the resume panel at the top of the registration form. */
  function resumeFirst() {
    var form = document.getElementById('registerForm');
    if (!form || form.getAttribute('data-tl-resume-first') === '1') return;

    var panels = form.querySelectorAll(':scope > .panel');
    if (!panels.length) return;

    var resume = null;
    for (var i = 0; i < panels.length; i++) {
      var h2 = panels[i].querySelector('.panel-head h2');
      if (h2 && /^\s*\d*\s*Resume\s*$/.test(h2.textContent || '')) { resume = panels[i]; break; }
    }
    if (!resume) return;

    // Already first: nothing to do, and marking it stops the walk on
    // every later render.
    if (resume !== panels[0]) form.insertBefore(resume, panels[0]);
    form.setAttribute('data-tl-resume-first', '1');

    // The numbers are part of the page's own design, so they are kept
    // correct rather than removed.
    var nums = form.querySelectorAll('.reg-section-num');
    for (var n = 0; n < nums.length; n++) nums[n].textContent = String(n + 1);

    // Say why it is first. Somebody who has just been asked to upload
    // before typing anything should be told the typing may not be
    // needed, rather than left to guess.
    var body = resume.querySelector('.panel-body');
    if (body && !body.querySelector('[data-tl-resume-lead]')) {
      var lead = document.createElement('div');
      lead.className = 'req-note';
      lead.setAttribute('data-tl-resume-lead', '1');
      lead.style.marginBottom = '12px';
      lead.textContent = 'Start here. Upload your resume and the rest of this form '
        + 'fills itself in — you only correct what it got wrong.';
      body.insertBefore(lead, body.firstChild);
    }
  }

  /**
   * One Home per header.
   *
   * A Home chip is injected into every header by a script of its own.
   * Where the header already had a Home, that leaves two controls with
   * one destination side by side - most plainly on the public site,
   * whose nav has read "Home ... Home" ever since.
   *
   * The rule: keep whichever Home is ALWAYS VISIBLE, and where both
   * are, keep the page's own.
   *
   *   public site       the nav Home is visible -> the chip goes
   *   candidate portal  the other one is inside a dropdown, behind a
   *                     click -> the chip stays, the menu entry goes
   */
  /**
   * No injected Home chip, in any portal.
   *
   * A script adds one to every header it can find. It was asked for
   * once and is now unwanted everywhere: on the public site the nav
   * already has Home, in the candidate portal the brand goes home, and
   * on a dashboard the sidebar is the way back while the breadcrumb is
   * a label rather than a control.
   *
   * Removed by its OWN marker rather than by guessing at a container.
   * The earlier version looked inside `.dash-main .topbar`, which is
   * not where the chip ends up on every screen - so it survived on the
   * admin pages and the request had to be made twice.
   *
   * The script re-adds it on its own schedule, so this runs on every
   * paint rather than once.
   */
  /*
   * A stylesheet, because removing the node loses a race.
   *
   * The injector re-mounts the chip after its own paint and on a timer,
   * so deleting it during a render meant it came straight back - the
   * count stayed at one on every screen however many times it was
   * removed. A rule cannot be outrun: whatever re-adds the element, it
   * is never displayed.
   *
   * The node is removed as well, so nothing is left in the layout or
   * reachable by keyboard.
   */
  (function () {
    if (document.getElementById('tl-no-home-style')) return;
    var css = document.createElement('style');
    css.id = 'tl-no-home-style';
    css.textContent = '[data-tlhome],.tl-home{display:none !important}';
    (document.head || document.documentElement).appendChild(css);
  }());

  function noHomeChip() {
    var chips = document.querySelectorAll('[data-tlhome]');
    for (var i = 0; i < chips.length; i++) {
      var c = chips[i];
      if (c.parentNode) c.parentNode.removeChild(c);
    }
  }

  function oneHome() {
    noHomeChip();

    // The prototype's own duplicate, in the candidate profile menu:
    // with the chip gone this is the only Home, so it stays.
  }

  var realRenderForDemoLogin = window.render;
  window.render = function () {
    var out = realRenderForDemoLogin.apply(this, arguments);
    try { hideDemoLogin(); } catch (e) { /* never break a render */ }
    return out;
  };

  var prevAfterRenderDemoLogin = window.afterRender;
  window.afterRender = function () {
    var out = typeof prevAfterRenderDemoLogin === 'function'
      ? prevAfterRenderDemoLogin.apply(this, arguments) : undefined;
    try { hideDemoLogin(); } catch (e) {}
    return out;
  };

  /* ------------------------------------------------------------------ *
   * 23. Localities inside the Location filter that already exists
   *
   * The filter knew 86 cities and nothing smaller, so a recruiter
   * searching Hyderabad could not narrow to Madhapur or Gachibowli - the
   * places candidates actually write on their profiles.
   *
   * ADD-ONLY, and deliberately so. The component, its markup, its
   * styling, its keyboard handling and its "Within" control are the
   * prototype's own and are not touched. Two things are extended:
   *
   *   INDIA_COORDS   gains locality coordinates, so the EXISTING
   *                  coordsOf(), canonical() and matches() understand
   *                  them - which is why picking one keeps working with
   *                  the existing candidate search, unchanged
   *   TL_LOC.suggest is wrapped to offer a city's localities and to put
   *                  the distance in the `sub` field the renderer
   *                  ALREADY prints beside every row
   *
   * So the distance appears with no change to a single line of markup.
   *
   * DISTANCES ARE NOT HARD-CODED. What is added here is coordinates -
   * latitude and longitude, geographic facts - and the distance is
   * computed by the haversine already in the file
   * (TL_LOC.distanceKm). Change a coordinate and every distance derived
   * from it changes with it.
   *
   * These cover the metros TeamLink recruits in. A locality that is not
   * listed behaves exactly as it did before: it is still typeable, still
   * matches by name, and simply has no distance beside it. Full national
   * coverage needs a geocoding service, which is a network call and a
   * key rather than a table.
   * ------------------------------------------------------------------ */

  /** [latitude, longitude] — real coordinates, to four decimal places. */
  var TL_LOCALITIES = {
    Hyderabad: [
      ['Hyderabad', 17.3850, 78.4867],
      ['Begumpet', 17.4400, 78.4600],
      ['Ameerpet', 17.4375, 78.4483],
      ['Madhapur', 17.4483, 78.3915],
      ['Hitech City', 17.4435, 78.3772],
      ['Gachibowli', 17.4401, 78.3489],
      ['Kondapur', 17.4849, 78.3915],
      ['Kukatpally', 17.4948, 78.4000],
      ['Miyapur', 17.4969, 78.3428],
      ['Manikonda', 17.4048, 78.3772],
      ['Secunderabad', 17.4399, 78.4983],
      ['Uppal', 17.4056, 78.5590],
      ['LB Nagar', 17.3457, 78.5522],
      ['Dilsukhnagar', 17.3687, 78.5247],
      ['Banjara Hills', 17.4126, 78.4392],
      ['Jubilee Hills', 17.4326, 78.4071],
      ['Kompally', 17.5430, 78.4870],
      ['Shamshabad', 17.2403, 78.4294],
      ['Nizampet', 17.5100, 78.3900],
      ['Attapur', 17.3600, 78.4200],
    ],
    Bengaluru: [
      ['Bengaluru', 12.9716, 77.5946],
      ['Whitefield', 12.9698, 77.7500],
      ['Electronic City', 12.8452, 77.6602],
      ['Koramangala', 12.9352, 77.6245],
      ['Indiranagar', 12.9784, 77.6408],
      ['Marathahalli', 12.9591, 77.6974],
      ['HSR Layout', 12.9116, 77.6474],
      ['Bellandur', 12.9304, 77.6784],
      ['Hebbal', 13.0358, 77.5970],
      ['Yelahanka', 13.1007, 77.5963],
      ['Jayanagar', 12.9250, 77.5938],
      ['Rajajinagar', 12.9916, 77.5526],
      ['Banashankari', 12.9250, 77.5460],
      ['Sarjapur Road', 12.9010, 77.6870],
      ['Hosur Road', 12.8900, 77.6300],
    ],
    Chennai: [
      ['Chennai', 13.0827, 80.2707],
      ['Guindy', 13.0067, 80.2206],
      ['Velachery', 12.9750, 80.2200],
      ['OMR', 12.8900, 80.2270],
      ['Perungudi', 12.9600, 80.2450],
      ['Sholinganallur', 12.9010, 80.2279],
      ['Adyar', 13.0063, 80.2574],
      ['T Nagar', 13.0418, 80.2341],
      ['Anna Nagar', 13.0850, 80.2101],
      ['Porur', 13.0382, 80.1565],
      ['Ambattur', 13.1143, 80.1548],
      ['Tambaram', 12.9229, 80.1275],
    ],
    Pune: [
      ['Pune', 18.5204, 73.8567],
      ['Hinjewadi', 18.5993, 73.7389],
      ['Kharadi', 18.5515, 73.9470],
      ['Magarpatta', 18.5150, 73.9290],
      ['Baner', 18.5590, 73.7868],
      ['Wakad', 18.5980, 73.7620],
      ['Viman Nagar', 18.5679, 73.9143],
      ['Kothrud', 18.5074, 73.8077],
      ['Hadapsar', 18.5089, 73.9260],
      ['Pimpri', 18.6298, 73.7997],
    ],
    Mumbai: [
      ['Mumbai', 19.0760, 72.8777],
      ['Andheri', 19.1197, 72.8468],
      ['Bandra', 19.0596, 72.8295],
      ['Powai', 19.1176, 72.9060],
      ['Goregaon', 19.1663, 72.8526],
      ['Malad', 19.1860, 72.8487],
      ['Lower Parel', 18.9960, 72.8300],
      ['Thane', 19.2183, 72.9781],
      ['Navi Mumbai', 19.0330, 73.0297],
      ['Vashi', 19.0771, 72.9986],
    ],
    Delhi: [
      ['Delhi', 28.7041, 77.1025],
      ['New Delhi', 28.6139, 77.2090],
      ['Gurgaon', 28.4595, 77.0266],
      ['Noida', 28.5355, 77.3910],
      ['Greater Noida', 28.4744, 77.5040],
      ['Faridabad', 28.4089, 77.3178],
      ['Ghaziabad', 28.6692, 77.4538],
      ['Dwarka', 28.5921, 77.0460],
      ['Saket', 28.5245, 77.2066],
      ['Connaught Place', 28.6315, 77.2167],
    ],
  };

  /** Locality -> its parent city, so a row can say where it is. */
  var TL_LOC_PARENT = Object.create(null);

  function tlLocalitiesInstall() {
    if (!window.INDIA_COORDS) return false;

    Object.keys(TL_LOCALITIES).forEach(function (city) {
      TL_LOCALITIES[city].forEach(function (row) {
        var name = row[0];
        // Never overwrite a coordinate the prototype already has: the
        // city entries are its own and are the reference point.
        if (!window.INDIA_COORDS[name]) window.INDIA_COORDS[name] = [row[1], row[2]];
        TL_LOC_PARENT[name.toLowerCase()] = city;

        /*
         * Deliberately NOT added to INDIA_CITY_STATE_MAP.
         *
         * The prototype's own suggester manufactures a "<name>
         * Metropolitan Area" row for every city it finds there, so
         * registering localities produced "Gachibowli Metropolitan
         * Area" - a place that does not exist. Coordinates are enough:
         * coordsOf() reads INDIA_COORDS, which is what distance and
         * radius matching actually need.
         */
      });
    });
    return true;
  }

  /**
   * Localities of a city, nearest first, with the distance computed.
   *
   * @param city    the parent city
   * @param radius  kilometres, or null for all of them
   */
  function tlLocalitiesOf(city, radius) {
    var rows = TL_LOCALITIES[city];
    if (!rows || !window.TL_LOC) return [];
    var origin = window.TL_LOC.coordsOf(city);
    if (!origin) return [];

    return rows.map(function (row) {
      /*
       * Read the coordinate back through coordsOf rather than using the
       * row directly, so the city measures against ITS OWN coordinate
       * and comes out at 0. The prototype's table already holds
       * Hyderabad, this one is not allowed to overwrite it, and the two
       * differ by a kilometre - which is how the city appeared as
       * "Hyderabad - 1 KM", a kilometre from itself.
       */
      var here = window.TL_LOC.coordsOf(row[0]) || [row[1], row[2]];
      var km = window.TL_LOC.distanceKm(origin, here);
      return { name: row[0], km: Math.round(km) };
    }).filter(function (x) {
      return radius == null || x.km <= Number(radius);
    }).sort(function (a, b) { return a.km - b.km; });
  }

  /** Which city is being typed or has already been picked. */
  function tlCityFor(q, key) {
    var t = String(q || '').trim().toLowerCase();
    var names = Object.keys(TL_LOCALITIES);

    for (var i = 0; i < names.length; i++) {
      if (names[i].toLowerCase().indexOf(t) === 0 && t) return names[i];
    }
    // Typing a locality shows its neighbours too, which is what somebody
    // narrowing down a search actually wants - and a PREFIX of one
    // counts, since "Gachi" is how it is typed in practice.
    if (t) {
      if (TL_LOC_PARENT[t]) return TL_LOC_PARENT[t];
      var keys = Object.keys(TL_LOC_PARENT);
      for (var k = 0; k < keys.length; k++) {
        if (keys[k].indexOf(t) === 0) return TL_LOC_PARENT[keys[k]];
      }
    }

    // Nothing typed: use whatever is already selected, so the radius
    // control has something to act on.
    if (!t && key && typeof window.tlLocState === 'function') {
      var tags = (window.tlLocState(key) || {}).tags || [];
      for (var j = 0; j < tags.length; j++) {
        var tag = String(tags[j]).toLowerCase();
        if (TL_LOCALITIES[tags[j]]) return tags[j];
        if (TL_LOC_PARENT[tag]) return TL_LOC_PARENT[tag];
      }
    }
    return null;
  }

  /**
   * The radius currently chosen in the field's own "Within" control.
   *
   * Read from the component's state rather than kept separately, so the
   * one control drives both the list and the candidate filtering it
   * already drove.
   */
  function tlRadiusFor(key) {
    if (!key || typeof window.tlLocState !== 'function') return null;
    var km = (window.tlLocState(key) || {}).km;
    if (km === '' || km == null || km === 'any') return null;
    var n = Number(km);
    return isFinite(n) && n > 0 ? n : null;
  }

  /*
   * The suggester is left alone.
   *
   * It was wrapped to add localities with distances to the flat list -
   * which a later layer stands down anyway, and which duplicated what
   * the panel already shows. Wrapping it now would add rows nothing
   * renders.
   */

  /**
   * The distances the panel offers.
   *
   * The active field keeps its radius as a row of pills inside the
   * location panel, built from a module-local `KM` array that cannot be
   * reached from here. So the pill row it returns is rewritten - same
   * `tl-kmp` class, same `tlTreeKm` handler, same markup - rather than
   * the function being replaced. Styling and behaviour stay the
   * prototype's; only the values on offer change.
   */
  var TL_KM_CHOICES = [5, 10, 15, 25, 50, 100];

  function tlLocalitiesWrapField() {
    if (typeof window.tlTreeHtml !== 'function' || window.tlTreeHtml.__tlLocalities) return false;
    var original = window.tlTreeHtml;

    window.tlTreeHtml = function (key) {
      window.__tlLocActiveKey = key;
      var html = original.apply(this, arguments);
      if (typeof html !== 'string') return html;

      var st = (typeof window.tlLocState === 'function' && window.tlLocState(key)) || {};
      /*
       * Single quotes inside the attribute, as the prototype writes it.
       * JSON.stringify emits DOUBLE quotes, which closed the
       * double-quoted onclick attribute early and left the browser
       * parsing "tlTreeKm(" as the whole handler - every pill threw
       * "Unexpected end of input" and none of them worked.
       */
      var q = function (v) { return String(v).split("'").join('&#39;'); };
      var pill = function (v, label) {
        return '<button type="button" class="tl-kmp '
          + (String(st.km || '') === String(v) ? 'on' : '') + '"'
          + ' onmousedown="event.preventDefault()"'
          + " onclick=\"tlTreeKm('" + q(key) + "','" + q(v) + "')\">"
          + esc(label) + '</button>';
      };

      var row = pill('', 'Exact city')
        + TL_KM_CHOICES.map(function (k) { return pill(k, k + ' KM'); }).join('')
        + pill('any', 'Any Distance');

      html = html.replace(/(<div class="tl-kmrow">)[\s\S]*?(<\/div>)/,
        '$1' + row + '$2');

      /*
       * THE NEARBY PLACES GO IN THE LIST, with their distance beside
       * them, as rows of the list that is already there.
       *
       * They used to be chips in a panel of their own beside it, which
       * meant a recruiter picking Hyderabad saw a second block appear
       * rather than the list they were already reading filling in. This
       * injects rows into the SAME list, built from the SAME markup the
       * list uses for every other row - the same <label class="tl-row2">,
       * the same checkbox, the same tlTreePick() - so ticking one is
       * indistinguishable from ticking a district, and the candidate
       * search receives it exactly as it always did.
       *
       * NOTHING HERE IS A STORED DISTANCE. Every kilometre on screen is
       * haversine over the latitude and longitude the dataset holds, so
       * changing the radius changes the list, and a place with no
       * coordinates on file never appears with a made-up number.
       */
      var anchor = null;
      var tags = st.tags || [];
      for (var i = tags.length - 1; i >= 0 && !anchor; i--) {
        // A whole state has no single point to measure from.
        if (window.INDIA_GEO && window.INDIA_GEO[tags[i]]) continue;
        var c = null;
        try {
          c = (window.INDIA_COORDS || {})[tags[i]]
            || (window.TL_LOC && TL_LOC.coordsOf ? TL_LOC.coordsOf(tags[i]) : null);
        } catch (e) { c = null; }
        if (c) anchor = { name: tags[i], c: c };
      }

      if (anchor && typeof window.tlNearbyList === 'function') {
        /*
         * "Any Distance" means every place we can locate, so the radius
         * is the planet rather than a number somebody has to maintain.
         * "Exact city" means the one they picked and nothing else.
         */
        var chosen = String(st.km || '');
        var radius = chosen === 'any' ? 20000 : (chosen ? Number(chosen) : 0);

        var near = radius ? window.tlNearbyList(anchor, radius, tags) : [];
        var picked = function (v) {
          return tags.some(function (t) { return String(t).toLowerCase() === String(v).toLowerCase(); });
        };
        var nearRow = function (name, km, isAnchor) {
          return '<label class="tl-row2' + (isAnchor ? ' b' : '') + '"'
            + ' onmousedown="event.preventDefault()">'
            + '<input type="checkbox"' + (picked(name) ? ' checked' : '')
            + " onchange=\"tlTreePick('" + q(key) + "','" + q(name) + "',this.checked)\">"
            + '<span class="nm">' + esc(name) + '</span>'
            // Rounded for reading, measured exactly for filtering.
            + '<span class="tl-km">' + esc(String(Math.round(km))) + ' KM</span>'
            + '</label>';
        };

        var rows = nearRow(anchor.name, 0, true)
          + near.map(function (p) { return nearRow(p.name, p.km, false); }).join('');

        var heading = chosen === 'any'
          ? 'Near ' + anchor.name
          : chosen
            ? 'Near ' + anchor.name + ' &middot; within ' + esc(chosen) + ' KM'
            : 'Near ' + anchor.name;
        var note = chosen
          ? (near.length + ' place' + (near.length === 1 ? '' : 's') + ' found')
          : 'Choose a distance above to list the places around it.';

        var block = '<div class="grp tl-nbgrp"><b>' + heading + '</b>'
          + rows
          + '<div class="tl-kmnote" style="padding-top:4px">' + esc(note) + '</div></div>';

        /*
         * At the top of the MAIN column, immediately above "Country &
         * region", inside the list a recruiter is already reading.
         *
         * The panel is two columns - tl-main scrolls the list, tl-side
         * holds the distance buttons - so this goes into the first, not
         * beside it. A plain string replace rather than a pattern,
         * because the one thing that must not happen is a silent miss
         * that leaves the list looking untouched.
         */
        var COUNTRY = '<div class="grp"><b>Country &amp; region</b>';
        if (html.indexOf(COUNTRY) >= 0) {
          html = html.replace(COUNTRY, block + COUNTRY);
        } else {
          // The list is built differently from what this expects. Say so
          // in the console rather than quietly rendering nothing.
          try { console.warn('[TeamLink] nearby rows: the list anchor moved'); } catch (e) {}
        }
      }

      return html;
    };
    window.tlTreeHtml.__tlLocalities = true;
    return true;
  }

  /**
   * Redraw the list when a distance pill is pressed.
   *
   * tlTreeKm() records the choice and refreshes the panel; the
   * suggestion list is a separate element, so a recruiter choosing
   * 25 KM saw the same locations until they typed again.
   */
  function tlLocalitiesWrapKm() {
    if (typeof window.tlTreeKm !== 'function' || window.tlTreeKm.__tlLocalities) return false;
    var original = window.tlTreeKm;
    window.tlTreeKm = function (key) {
      window.__tlLocActiveKey = key;
      var out = original.apply(this, arguments);
      try {
        if (typeof window.tlLocRefresh === 'function') window.tlLocRefresh(key);
      } catch (e) { /* the radius still applied */ }
      return out;
    };
    window.tlTreeKm.__tlLocalities = true;
    return true;
  }

  function tlLocalitiesSetUp() {
    if (!tlLocalitiesInstall()) return false;
    tlLocalitiesWrapField();
    tlLocalitiesWrapKm();
    return true;
  }

  // The prototype defines these in a later script block, so the first
  // attempt can be too early. Try now, then once more after load.
  if (!tlLocalitiesSetUp()) {
    var tlLocTries = 0;
    var tlLocTimer = setInterval(function () {
      if (tlLocalitiesSetUp() || ++tlLocTries > 40) clearInterval(tlLocTimer);
    }, 150);
  }

  /* ------------------------------------------------------------------ *
   * 24. Admin → Recruiter Management
   *
   * A recruiter existed as a login and almost nothing else: no way to
   * add one without editing the database, no way to see what any of them
   * were doing, and no way to turn a login off when somebody left.
   *
   * This fills the admin's existing Recruiters page rather than adding a
   * module beside it - the nav item, the shell, the styling and the
   * chrome are the prototype's. Everything here is its content.
   *
   * ONE ACCOUNT, NOT TWO. "Create Recruiter & Login" writes the same
   * `users` row the Recruiter Portal authenticates against. There is no
   * second credential store and nothing bypasses the ordinary login:
   * create kiran@ with a password, and kiran signs in at the Recruiter
   * Portal with exactly that.
   *
   * NO PASSWORD IS EVER SHOWN. Not after creating, not after a reset.
   * The screen reports that a login exists and whether it is active.
   * ------------------------------------------------------------------ */

  TL.staff = { list: [], q: '', dept: '', status: '' };

  var STAGE_LABELS = {
    applied: 'Applied', ai_screening: 'Screening', shortlisted: 'Shortlisted',
    interview_scheduled: 'Interview', ai_interview_done: 'AI Done',
    client_review: 'With Client', offer_extended: 'Offer',
    selected: 'Selected', rejected: 'Rejected',
  };
  var STAGE_ORDER = Object.keys(STAGE_LABELS);

  function staffModal(title, body) {
    if (typeof window.fcrModal === 'function') {
      window.fcrModal(
        '<div class="fcr-modal-head"><h3>' + esc(title) + '</h3>' +
        '<button class="btn btn-ghost btn-sm" onclick="fcrCloseModal()">✕</button></div>' +
        '<div class="fcr-modal-body" id="tlStaffModal">' + body + '</div>');
      return true;
    }
    return false;
  }
  function staffClose() {
    if (typeof window.fcrCloseModal === 'function') window.fcrCloseModal();
  }
  function staffSay(msg, icon) {
    if (typeof window.toast === 'function') window.toast(msg, icon || 'ℹ️');
  }

  /* ---- the list ---------------------------------------------------- */

  TL.staff.refresh = function () {
    return api.get('/staff/recruiters').then(function (r) {
      TL.staff.list = r.recruiters || [];
      staffPaint();
      return TL.staff.list;
    }).catch(function (err) {
      var host = document.getElementById('tlStaffBody');
      if (host) host.innerHTML = '<tr><td colspan="9"><div class="empty-note">' +
        esc(err.message || 'The recruiters could not be loaded.') + '</div></td></tr>';
    });
  };

  function staffVisible() {
    var q = String(TL.staff.q || '').trim().toLowerCase();
    return TL.staff.list.filter(function (x) {
      if (TL.staff.dept && String(x.department || '') !== TL.staff.dept) return false;
      if (TL.staff.status && x.loginStatus !== TL.staff.status) return false;
      if (!q) return true;
      return [x.name, x.email, x.employeeId, x.department, x.designation, x.team]
        .some(function (v) { return String(v || '').toLowerCase().indexOf(q) >= 0; });
    });
  }

  function staffPaint() {
    var body = document.getElementById('tlStaffBody');
    if (!body) return;
    var rows = staffVisible();

    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="9"><div class="empty-note">' +
        (TL.staff.list.length ? 'No recruiter matches those filters.'
          : 'No recruiters yet. Use + Add Recruiter to create the first one.') +
        '</div></td></tr>';
    } else {
      body.innerHTML = rows.map(function (x) {
        var live = x.loginStatus === 'active';
        var counts = STAGE_ORDER.map(function (s) {
          var n = (x.stages || {})[s] || 0;
          return '<td title="' + esc(STAGE_LABELS[s]) + '">'
            + (n ? '<b>' + n + '</b>' : '<span style="color:var(--text-soft)">0</span>') + '</td>';
        }).join('');

        return '<tr>'
          + '<td><b>' + esc(x.name) + '</b>'
            + '<div style="font-size:11.5px;color:var(--text-soft)">' + esc(x.email) + '</div></td>'
          + '<td>' + esc(x.employeeId || '—') + '</td>'
          + '<td>' + esc(x.department || '—')
            + '<div style="font-size:11.5px;color:var(--text-soft)">'
            + esc(x.designation || '') + (x.team ? ' · ' + esc(x.team) : '') + '</div></td>'
          + '<td>' + x.assignedRequirements + '</td>'
          + '<td><b>' + x.totalCandidates + '</b></td>'
          + counts
          + '<td><span class="badge ' + (live ? 'badge-ok' : 'badge-neutral') + '">'
            + (x.loginStatus === 'none' ? 'No login' : live ? 'Active' : 'Inactive')
            + '</span></td>'
          + '<td class="row-actions" style="flex-wrap:wrap">'
            + '<button class="btn btn-ghost btn-sm" onclick="TL.staff.view(\'' + esc(x.id) + '\')">View</button>'
            + '<button class="btn btn-ghost btn-sm" onclick="TL.staff.edit(\'' + esc(x.id) + '\')">Edit</button>'
            + '<button class="btn btn-primary btn-sm" onclick="TL.staff.loginAs(\'' + esc(x.id) + '\')">Login As Recruiter</button>'
            + '<button class="btn btn-ghost btn-sm" onclick="TL.staff.resetPassword(\'' + esc(x.id) + '\')">Reset Password</button>'
            + '<button class="btn btn-sm ' + (live ? 'btn-danger-ghost' : 'btn-ghost') + '"'
              + ' onclick="TL.staff.toggle(\'' + esc(x.id) + '\',' + (live ? 'false' : 'true') + ')">'
              + (live ? 'Deactivate' : 'Activate') + '</button>'
          + '</td></tr>';
      }).join('');
    }

    var dept = document.getElementById('tlStaffDept');
    if (dept && dept.options.length <= 1) {
      var seen = {};
      TL.staff.list.forEach(function (x) { if (x.department) seen[x.department] = 1; });
      dept.innerHTML = '<option value="">All departments</option>' +
        Object.keys(seen).sort().map(function (d) {
          return '<option value="' + esc(d) + '">' + esc(d) + '</option>';
        }).join('');
    }
  }

  TL.staff.filter = function (what, value) {
    TL.staff[what] = value;
    staffPaint();
  };

  /* ---- add ---------------------------------------------------------- */

  function field(id, label, opts) {
    opts = opts || {};
    return '<div class="fgroup"><label>' + esc(label) + (opts.required ? ' *' : '') + '</label>'
      + '<input id="' + id + '" type="' + (opts.type || 'text') + '"'
      + ' placeholder="' + esc(opts.placeholder || '') + '"'
      + ' style="width:100%;padding:10px 12px;border-radius:8px;border:1px solid var(--line);'
      + 'background:var(--card);color:var(--text);font-size:13px"></div>';
  }

  TL.staff.add = function () {
    var ok = staffModal('Add Recruiter',
      '<div class="review-grid">'
      + '<div>'
        + field('tlSfName', 'Employee Name', { required: true, placeholder: 'e.g. Kiran Kumar' })
        + field('tlSfEmp', 'Employee ID', { placeholder: 'e.g. TL-1042' })
        + field('tlSfEmail', 'Email', { required: true, type: 'email', placeholder: 'kiran@teamlinkcs.com' })
        + field('tlSfMobile', 'Mobile Number', { placeholder: '+91 90000 00000' })
        + field('tlSfDept', 'Department', { placeholder: 'e.g. Talent Acquisition' })
        + field('tlSfDesig', 'Designation', { placeholder: 'e.g. Senior Recruiter' })
      + '</div><div>'
        + field('tlSfRole', 'Recruiter Role', { placeholder: 'e.g. Recruiter, Team Lead' })
        + field('tlSfTeam', 'Assigned Team', { placeholder: 'e.g. Healthcare' })
        + field('tlSfPass', 'Password', { required: true, type: 'password', placeholder: 'At least 8 characters' })
        + field('tlSfPass2', 'Confirm Password', { required: true, type: 'password' })
        + '<div class="fgroup"><label>Login Status</label>'
          + '<select id="tlSfStatus" style="width:100%;padding:10px 12px;border-radius:8px;'
          + 'border:1px solid var(--line);background:var(--card);color:var(--text);font-size:13px">'
          + '<option value="active">Active</option><option value="inactive">Inactive</option>'
          + '</select></div>'
      + '</div></div>'
      + '<div class="req-note">The email and password entered here ARE the recruiter’s '
      + 'Recruiter Portal login — there is no second account. They will be asked to '
      + 'choose their own password the first time they sign in.</div>'
      + '<div id="tlSfErr"></div>'
      + '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">'
      + '<button class="btn btn-ghost" onclick="TL.staff.cancel()">Cancel</button>'
      + '<button class="btn btn-primary" id="tlSfGo" onclick="TL.staff.create()">Create Recruiter &amp; Login</button>'
      + '</div>');
    if (!ok) staffSay('This screen needs the recruiter modal', '⚠️');
  };

  TL.staff.cancel = function () { staffClose(); };

  TL.staff.create = function () {
    var val = function (id) {
      var el = document.getElementById(id);
      return el ? String(el.value || '').trim() : '';
    };
    var err = document.getElementById('tlSfErr');
    var say = function (m) {
      if (err) err.innerHTML = '<div class="req-note" style="background:var(--bad-100);'
        + 'color:var(--bad-600)">' + esc(m) + '</div>';
    };

    var body = {
      name: val('tlSfName'), email: val('tlSfEmail'),
      password: val('tlSfPass'), confirmPassword: val('tlSfPass2'),
      employeeId: val('tlSfEmp'), mobile: val('tlSfMobile'),
      department: val('tlSfDept'), designation: val('tlSfDesig'),
      recruiterRole: val('tlSfRole'), team: val('tlSfTeam'),
      loginStatus: (document.getElementById('tlSfStatus') || {}).value || 'active',
    };

    // Said here so the person is not sent to the server to be told
    // something the form already knows.
    if (!body.name || !body.email) return say('A name and an email address are required.');
    if (body.password.length < 8) return say('The password must be at least 8 characters.');
    if (body.password !== body.confirmPassword) return say('The two passwords do not match.');

    var go = document.getElementById('tlSfGo');
    if (go) { go.disabled = true; go.textContent = 'Creating…'; }

    api.post('/staff/recruiters', body).then(function (r) {
      staffClose();
      staffSay(r.recruiter.name + ' can now sign in at the Recruiter Portal', '✅');
      TL.staff.refresh();
    }).catch(function (e) {
      if (go) { go.disabled = false; go.textContent = 'Create Recruiter & Login'; }
      say(e.message || 'The recruiter could not be created.');
    });
  };

  /* ---- row actions -------------------------------------------------- */

  TL.staff.edit = function (id) {
    var x = TL.staff.list.filter(function (r) { return r.id === id; })[0];
    if (!x) return;
    staffModal('Edit ' + x.name,
      '<div class="review-grid"><div>'
      + field('tlSeName', 'Employee Name') + field('tlSeEmp', 'Employee ID')
      + field('tlSeMobile', 'Mobile Number')
      + '</div><div>'
      + field('tlSeDept', 'Department') + field('tlSeDesig', 'Designation')
      + field('tlSeTeam', 'Assigned Team')
      + '</div></div>'
      + '<div class="req-note">The email is the login and is not changed here — '
      + 'changing it would lock ' + esc(x.name) + ' out of an account they still use.</div>'
      + '<div id="tlSfErr"></div>'
      + '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">'
      + '<button class="btn btn-ghost" onclick="TL.staff.cancel()">Cancel</button>'
      + '<button class="btn btn-primary" onclick="TL.staff.saveEdit(\'' + esc(id) + '\')">Save</button>'
      + '</div>');

    [['tlSeName', x.name], ['tlSeEmp', x.employeeId], ['tlSeMobile', x.mobile],
     ['tlSeDept', x.department], ['tlSeDesig', x.designation], ['tlSeTeam', x.team]]
      .forEach(function (p) {
        var el = document.getElementById(p[0]);
        if (el) el.value = p[1] || '';
      });
  };

  TL.staff.saveEdit = function (id) {
    var val = function (i) { var e = document.getElementById(i); return e ? e.value.trim() : ''; };
    api.patch('/staff/recruiters/' + encodeURIComponent(id), {
      name: val('tlSeName'), employeeId: val('tlSeEmp'), mobile: val('tlSeMobile'),
      department: val('tlSeDept'), designation: val('tlSeDesig'), team: val('tlSeTeam'),
    }).then(function () {
      staffClose(); staffSay('Saved', '✅'); TL.staff.refresh();
    }).catch(function (e) { staffSay(e.message || 'It could not be saved', '⚠️'); });
  };

  TL.staff.toggle = function (id, active) {
    api.post('/staff/recruiters/' + encodeURIComponent(id) + '/status', { active: !!active })
      .then(function () {
        staffSay(active ? 'Login activated' : 'Login deactivated — their data is untouched', '🔐');
        TL.staff.refresh();
      }).catch(function (e) { staffSay(e.message || 'It could not be changed', '⚠️'); });
  };

  TL.staff.resetPassword = function (id) {
    var x = TL.staff.list.filter(function (r) { return r.id === id; })[0] || {};
    staffModal('Reset password for ' + (x.name || 'this recruiter'),
      field('tlSrPass', 'New password', { type: 'password', required: true, placeholder: 'At least 8 characters' })
      + field('tlSrPass2', 'Confirm new password', { type: 'password', required: true })
      + '<div class="req-note">They will be asked to choose their own the first time they '
      + 'sign in, so an address you know does not stay one you can sign in as.</div>'
      + '<div id="tlSfErr"></div>'
      + '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">'
      + '<button class="btn btn-ghost" onclick="TL.staff.cancel()">Cancel</button>'
      + '<button class="btn btn-primary" onclick="TL.staff.doReset(\'' + esc(id) + '\')">Reset password</button>'
      + '</div>');
  };

  TL.staff.doReset = function (id) {
    var a = (document.getElementById('tlSrPass') || {}).value || '';
    var b = (document.getElementById('tlSrPass2') || {}).value || '';
    var err = document.getElementById('tlSfErr');
    var say = function (m) {
      if (err) err.innerHTML = '<div class="req-note" style="background:var(--bad-100);color:var(--bad-600)">'
        + esc(m) + '</div>';
    };
    if (a.length < 8) return say('At least 8 characters.');
    if (a !== b) return say('The two passwords do not match.');

    api.post('/staff/recruiters/' + encodeURIComponent(id) + '/password',
      { password: a, confirmPassword: b })
      .then(function () { staffClose(); staffSay('Password reset', '🔐'); })
      .catch(function (e) { say(e.message || 'It could not be reset.'); });
  };

  /**
   * Open that recruiter's portal, as them.
   *
   * The admin session is REPLACED - two sessions in one browser is how
   * somebody acts as the wrong person without noticing - so this says so
   * before doing it.
   */
  TL.staff.loginAs = function (id) {
    var x = TL.staff.list.filter(function (r) { return r.id === id; })[0] || {};
    staffModal('Open ' + (x.name || 'this recruiter') + '’s portal',
      '<div class="req-note">You will be signed in as <b>' + esc(x.name || '') + '</b> '
      + '(' + esc(x.email || '') + ') and will see only what they see. Your own admin '
      + 'session ends — sign out and back in to return to it.</div>'
      + '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">'
      + '<button class="btn btn-ghost" onclick="TL.staff.cancel()">Cancel</button>'
      + '<button class="btn btn-primary" onclick="TL.staff.doLoginAs(\'' + esc(id) + '\')">Open their portal</button>'
      + '</div>');
  };

  TL.staff.doLoginAs = function (id) {
    api.post('/staff/recruiters/' + encodeURIComponent(id) + '/login-as', {})
      .then(function (r) {
        staffClose();
        staffSay('Signed in as ' + r.recruiter.name, '👤');
        return TL.refresh().then(function () {
          window.location.hash = '#/recruiter/home';
        });
      })
      .catch(function (e) { staffSay(e.message || 'Their portal could not be opened', '⚠️'); });
  };

  /** Read-only monitoring: their candidates and where each one stands. */
  TL.staff.view = function (id) {
    staffModal('Recruiter activity', '<div class="req-note">Loading…</div>');
    api.get('/staff/recruiters/' + encodeURIComponent(id) + '/activity').then(function (r) {
      var host = document.getElementById('tlStaffModal');
      if (!host) return;
      var x = r.recruiter || {};
      var rows = r.activity || [];

      host.innerHTML =
        '<div class="fcr-jd-row"><label>Recruiter</label><span class="v">' + esc(x.name || '')
          + ' · ' + esc(x.email || '') + '</span></div>'
        + '<div class="fcr-jd-row"><label>Department</label><span class="v">'
          + esc(x.department || '—') + (x.team ? ' · ' + esc(x.team) : '') + '</span></div>'
        + '<div class="fcr-jd-row"><label>Requirements</label><span class="v">'
          + x.assignedRequirements + '</span></div>'
        + (rows.length
          ? '<div class="tbl-wrap" style="margin-top:10px"><table class="data">'
            + '<thead><tr><th>Candidate</th><th>Requirement</th><th>Client</th>'
            + '<th>Stage</th><th>Last action</th><th>Updated</th></tr></thead><tbody>'
            + rows.map(function (a) {
                return '<tr><td><b>' + esc(a.candidate) + '</b>'
                  + (a.reference ? '<div style="font-size:11px;color:var(--text-soft)">'
                      + esc(a.reference) + '</div>' : '')
                  + '</td><td>' + esc(a.requirement) + '</td>'
                  + '<td>' + esc(a.client || '—') + '</td>'
                  + '<td>' + esc(a.stageLabel) + '</td>'
                  + '<td style="max-width:260px;font-size:12px">' + esc(a.lastAction || '—') + '</td>'
                  + '<td style="white-space:nowrap;font-size:12px">'
                    + esc(a.lastActionAt ? new Date(a.lastActionAt).toLocaleDateString('en-GB')
                        : (a.appliedAt ? new Date(a.appliedAt).toLocaleDateString('en-GB') : '—'))
                  + '</td></tr>';
              }).join('')
            + '</tbody></table></div>'
          : '<div class="empty-note">No candidates on this desk yet.</div>')
        + '<div class="req-note">Read-only. These are the same applications the recruiter '
        + 'sees — nothing is copied, so the two cannot disagree.</div>';
    }).catch(function (e) {
      var host = document.getElementById('tlStaffModal');
      if (host) host.innerHTML = '<div class="req-note">' + esc(e.message || 'Unavailable.') + '</div>';
    });
  };

  /* ---- the page ----------------------------------------------------- */

  function staffShell() {
    var head = STAGE_ORDER.map(function (s) {
      return '<th title="' + esc(STAGE_LABELS[s]) + '">' + esc(STAGE_LABELS[s]) + '</th>';
    }).join('');

    return '<div class="panel" data-tl-staff="1">'
      + '<div class="panel-head"><div><h2>Recruiter Management</h2>'
        + '<div class="desc">Every recruiter, their desk, and their login</div></div>'
        + '<button class="btn btn-primary btn-sm" style="margin-left:auto"'
        + ' onclick="TL.staff.add()">＋ Add Recruiter</button></div>'
      + '<div class="panel-body" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">'
        + '<input id="tlStaffQ" placeholder="Search name, email, employee ID…"'
          + ' oninput="TL.staff.filter(\'q\',this.value)"'
          + ' style="flex:1;min-width:220px;padding:9px 12px;border-radius:8px;'
          + 'border:1px solid var(--line);background:var(--card);color:var(--text);font-size:13px">'
        + '<select id="tlStaffDept" onchange="TL.staff.filter(\'dept\',this.value)"'
          + ' style="padding:9px 12px;border-radius:8px;border:1px solid var(--line);'
          + 'background:var(--card);color:var(--text);font-size:13px">'
          + '<option value="">All departments</option></select>'
        + '<select onchange="TL.staff.filter(\'status\',this.value)"'
          + ' style="padding:9px 12px;border-radius:8px;border:1px solid var(--line);'
          + 'background:var(--card);color:var(--text);font-size:13px">'
          + '<option value="">Any login status</option>'
          + '<option value="active">Active</option>'
          + '<option value="inactive">Inactive</option></select>'
      + '</div>'
      + '<div class="panel-body pad0"><div class="tbl-wrap"><table class="data">'
        + '<thead><tr><th>Recruiter</th><th>Employee ID</th><th>Department</th>'
        + '<th>Reqs</th><th>Candidates</th>' + head + '<th>Login</th><th>Actions</th></tr></thead>'
        + '<tbody id="tlStaffBody"><tr><td colspan="9">'
        + '<div class="empty-note">Loading…</div></td></tr></tbody>'
      + '</table></div></div></div>';
  }

  /**
   * Fill the admin's existing Recruiters page.
   *
   * The nav item, the shell and the chrome are the prototype's; this
   * replaces what sits inside, and only on that page.
   */
  function enhanceAdminRecruiters() {
    if (!/#\/admin\/recruiters/.test(String(location.hash || ''))) return;
    var session = TL.session;
    if (!session || session.role !== 'admin') return;

    var main = document.querySelector('.dash-main .dash-body')
      || document.querySelector('.dash-main');
    if (!main) return;
    if (main.querySelector('[data-tl-staff]')) return;

    var panels = main.querySelectorAll(':scope > .panel, :scope > .stat-row');
    for (var i = 0; i < panels.length; i++) panels[i].style.display = 'none';

    var host = document.createElement('div');
    host.innerHTML = staffShell();
    main.appendChild(host.firstChild);
    TL.staff.refresh();
  }

  var realRenderForStaff = window.render;
  window.render = function () {
    var out = realRenderForStaff.apply(this, arguments);
    try { enhanceAdminRecruiters(); } catch (e) { /* never break a render */ }
    return out;
  };

  var prevAfterRenderStaff = window.afterRender;
  window.afterRender = function () {
    var out = typeof prevAfterRenderStaff === 'function'
      ? prevAfterRenderStaff.apply(this, arguments) : undefined;
    try { enhanceAdminRecruiters(); } catch (e) {}
    return out;
  };

  /* ------------------------------------------------------------------ *
   * 12. Session expiry
   *
   * A cookie can expire while the tab is open. Rather than letting the
   * next action fail opaquely, notice it once and send the user to the
   * login screen (requirement 24).
   * ------------------------------------------------------------------ */

  var expiryHandled = false;
  TL.onAuthFailure = function (err) {
    if (expiryHandled) return;
    if (!err || (err.code !== 'SESSION_EXPIRED' && err.code !== 'UNAUTHENTICATED')) return;
    if (!TL.session) return;              // not signed in - nothing to expire
    expiryHandled = true;

    // Do NOT sign the user out on the strength of one 401.
    //
    // Any call can 401 for its own reasons - a background preference sync
    // racing a logout, a route the role may not touch. Treating each one as
    // "your session ended" threw candidates back to the login screen in the
    // middle of applying, with a valid cookie still in the jar.
    //
    // /auth/me is the authority: it answers {session:null} when the cookie
    // is really gone, and never 401s.
    api.get('/auth/me').then(function (me) {
      if (me && me.session) return;       // still signed in - a false alarm
      STATE.session = null;
      TL.session = null;
      window.navigate('/');
      if (typeof window.toast === 'function') {
        window.toast('Your session has expired — please sign in again', '🔒');
      }
    }).catch(function () {
      // The server could not be asked. Losing the local session as well
      // would only add a second failure; leave it and let the next call
      // report the real problem.
    }).then(function () {
      setTimeout(function () { expiryHandled = false; }, 3000);
    });
  };

  var baseSay = say;
  say = function (err) { baseSay(err); TL.onAuthFailure(err); return err; };
  api.say = say;

  console.info('TeamLink: backend integration active (API ' + API + ')');
})();
