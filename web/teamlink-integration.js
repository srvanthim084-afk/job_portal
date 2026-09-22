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

  function request(method, path, body, opts) {
    opts = opts || {};
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

    applying[jobId] = api.post('/applications', { jobId: jobId, source: 'portal' })
      .then(function (res) {
        // reconcile the cache with what the server actually recorded
        DATA.applications.push(res.application);
        var job = DATA.jobById(jobId);
        if (job && typeof res.applicants === 'number') job.applicants = res.applicants;
        if (res.notification) TL.notifications.unshift(res.notification);

        if (typeof window.toast === 'function') {
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
        var rec = (typeof window.recById === 'function' && appId) ? window.recById(appId) : null;
        var report = rec && rec.aiInterview && rec.aiInterview.report;
        if (report && report.candidate_id && report.job_id) {
          TL.recordAiInterview(report, {
            applicationId: rec.applicationId,
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
