/*
 * Job portal upgrades (0095) - the browser side.
 *
 *   1  quick filter chips    a scrollable row above the results on Home /
 *                            Find Jobs and the candidate's Search Jobs; one
 *                            tap on/off, kept in step with the sidebar and
 *                            the URL (?qf=), counted by the server's SQL
 *   2  match reasons         "82% match · ✓ Java, Spring · ✓ 3 yrs · ✗ AWS"
 *                            on every card, the full breakdown on the job
 *                            page - the SERVER's number (the one screening
 *                            gives the application), not a browser guess
 *   3  share                 native share sheet on a phone; WhatsApp, Copy
 *                            link, Email, LinkedIn otherwise; never the
 *                            client's name; the recruiter sees
 *                            "Shared 23 times · 9 applies"
 *   4  one-click apply       every open job, one tap when the profile and
 *                            resume are complete; "Applied ✓" with a
 *                            10-second Undo; a small sheet for what is
 *                            missing; screening questions first when the
 *                            job has them (window.TLScreening)
 *   5  last date + urgent    badges, "Applications closed", and the two
 *                            fields on every job posting form
 *   +  inbox                 the urgent-hiring / last-date alerts in the
 *                            candidate's bell, with "Apply now"
 *
 * Wrappers, installed once, each calling the function it replaces:
 *   applyToJob, easyApply, capApply, navigate (only to notice
 *   a sign-in that is continuing an application), jobSearchBody,
 *   filterJobsAdvanced, activeFilterChips, sortJobs, rjPage, recAll,
 *   rjClear, recRecommendation, computeMatchScore, matchExplanation,
 *   candidateBellHtml, fcrRegisterPosting, saveEditJob, pageAdminDash.
 *
 * Nothing here decides anything the server does not decide again: the
 * chips, the score, the deadline, completeness, Undo and the rate limit
 * are all enforced by the API.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || window.__tlPortalUpgrades) return;
  window.__tlPortalUpgrades = true;

  /* ================================================================ *
   * small things
   * ================================================================ */
  function h(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function say(msg, icon) { if (typeof window.toast === 'function') window.toast(msg, icon); }
  function api() { return window.TL && TL.api; }
  function ready() { return !!(window.TL && TL.ready === true && TL.api); }
  function session() { return (typeof STATE !== 'undefined' && STATE.session) || null; }
  function role() { var s = session(); return s ? s.role : null; }
  function isCandidate() { return role() === 'candidate'; }
  function me() {
    try { return isCandidate() && DATA.candidateById ? DATA.candidateById(STATE.session.id) : null; } catch (e) { return null; }
  }
  function jobOf(id) { try { return DATA.jobById ? DATA.jobById(id) : null; } catch (e) { return null; } }
  function isExternal(id) { return /^xjob_/.test(String(id || '')); }
  function rerender() { if (typeof window.render === 'function') window.render(); }
  function typing() {
    var a = document.activeElement;
    return !!(a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable));
  }

  /* ---- the last date, in India ---- */
  var IST = 330 * 60 * 1000;
  function istDay(at) { return new Date(new Date(at).getTime() + IST).toISOString().slice(0, 10); }
  function daysLeft(job) {
    if (!job || !job.expiresAt) return null;
    var a = Date.parse(istDay(Date.now()) + 'T00:00:00Z');
    var b = Date.parse(istDay(job.expiresAt) + 'T00:00:00Z');
    return Math.round((b - a) / 86400000);
  }
  function expired(job) { return !!(job && job.expiresAt && Date.parse(job.expiresAt) <= Date.now()); }
  function urgent(job) { return !!(job && job.urgent && (!job.urgentUntil || Date.parse(job.urgentUntil) > Date.now())); }
  function fmtDate(at) {
    try { return new Date(at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }); }
    catch (e) { return istDay(at); }
  }

  /* ================================================================ *
   * styles
   * ================================================================ */
  var css = ''
    + '.tlpu-chips{display:flex;gap:8px;overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none;padding:2px 2px 10px;margin:0 0 12px}'
    + '.tlpu-chips::-webkit-scrollbar{display:none}'
    + '.tlpu-chip{flex:0 0 auto;border:1px solid #d5dde8;background:#fff;color:#2b3a4d;border-radius:999px;padding:8px 14px;font-size:13px;font-weight:600;line-height:1.1;cursor:pointer;white-space:nowrap;font-family:inherit;min-height:36px}'
    + '.tlpu-chip.on{background:#0f7c9c;border-color:#0f7c9c;color:#fff}'
    + '.tlpu-chip.on::before{content:"\\2713  "}'
    + '.tlpu-chip[data-k="urgent"]:not(.on){border-color:#f2c4c4;color:#b42318}'
    + '.tlpu-strip{display:flex;flex-direction:column;gap:6px;margin-top:8px}'
    + '.tlpu-badges{display:flex;flex-wrap:wrap;gap:6px;align-items:center}'
    + '.tlpu-b{display:inline-flex;align-items:center;gap:4px;border-radius:999px;padding:3px 9px;font-size:11.5px;font-weight:700;line-height:1.3}'
    + '.tlpu-b.urgent{background:#fde8e8;color:#b42318}'
    + '.tlpu-b.amber{background:#fff4dc;color:#a15c00}'
    + '.tlpu-b.closed{background:#eef1f5;color:#5b6676}'
    + '.tlpu-why{font-size:12.5px;color:#3b4859;line-height:1.45}'
    + '.tlpu-why b{color:#0f7c9c}'
    + '.tlpu-why .ok{color:#1d7a45;font-weight:600}.tlpu-why .no{color:#b42318;font-weight:600}'
    + '.tlpu-why a{color:#6941c6;font-weight:700;text-decoration:none}'
    + '.tlpu-row{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}'
    + '.tlpu-share{border:1px solid #d5dde8;background:#fff;color:#2b3a4d;border-radius:8px;padding:6px 11px;font-size:12.5px;font-weight:700;cursor:pointer;font-family:inherit;min-height:32px}'
    + '.tlpu-ov{position:fixed;inset:0;background:rgba(15,23,42,.45);z-index:9998;display:flex;align-items:flex-end;justify-content:center}'
    + '.tlpu-sheet{background:#fff;width:100%;max-width:480px;border-radius:16px 16px 0 0;padding:18px 16px calc(18px + env(safe-area-inset-bottom));box-shadow:0 -8px 30px rgba(0,0,0,.18);max-height:90vh;overflow:auto}'
    + '@media(min-width:700px){.tlpu-ov{align-items:center}.tlpu-sheet{border-radius:16px}}'
    + '.tlpu-sheet h3{margin:0 0 4px;font-size:17px}.tlpu-sheet p{margin:0 0 12px;font-size:13px;color:#5b6676}'
    + '.tlpu-sheet .f{margin:0 0 12px}.tlpu-sheet label{display:block;font-size:12.5px;font-weight:700;color:#2b3a4d;margin-bottom:4px}'
    + '.tlpu-sheet input,.tlpu-sheet select{width:100%;box-sizing:border-box;border:1px solid #d5dde8;border-radius:9px;padding:10px 12px;font-size:15px;font-family:inherit;background:#fff}'
    + '.tlpu-sheet .err{color:#b42318;font-size:12px;margin-top:3px}'
    + '.tlpu-acts{display:flex;gap:8px;flex-wrap:wrap;margin-top:6px}.tlpu-acts button{flex:1 1 auto;min-height:44px}'
    + '.tlpu-sharegrid{display:grid;grid-template-columns:1fr 1fr;gap:8px}'
    + '.tlpu-sharegrid button{min-height:48px;border:1px solid #d5dde8;border-radius:10px;background:#fff;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit}'
    + '.tlpu-link{font-size:12px;color:#5b6676;word-break:break-all;background:#f5f7fa;border-radius:8px;padding:8px 10px;margin:10px 0 0}'
    + '.tlpu-jp .panel-body{display:flex;flex-direction:column;gap:9px}'
    + '.tlpu-kv{display:flex;gap:8px;font-size:13px;line-height:1.45}.tlpu-kv .k{flex:0 0 96px;color:#5b6676;font-weight:600}'
    + '.tlpu-add{border:1px dashed #9fb3c8;background:#f8fafc;border-radius:999px;padding:4px 10px;font-size:12px;font-weight:700;color:#2b3a4d;cursor:pointer;margin:2px 4px 2px 0;font-family:inherit}'
    + '.tlpu-toasthost{position:fixed;left:50%;transform:translateX(-50%);top:calc(env(safe-area-inset-top, 0px) + 72px);z-index:10040;width:min(92vw,440px);display:flex;flex-direction:column;gap:8px;pointer-events:none}'
    + '.tlpu-toasthost .toast{max-width:none;width:100%;box-sizing:border-box;pointer-events:auto}'
    + '.tlpu-toast span:nth-child(2){flex:1;min-width:0}'
    + '.tlpu-toast .toast-action{margin-left:10px;min-height:36px;padding:0 14px;border-radius:8px;border:0;background:#fff;color:#0b1220;font-weight:800;cursor:pointer;font-family:inherit}'
    + '.tlpu-dl{border:1px dashed #c9d4e2;border-radius:10px;padding:10px 12px;margin:8px 0;background:#fafcff}'
    + '.tlpu-dl .row{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end}'
    + '.tlpu-dl label{font-size:12.5px;font-weight:700}'
    + '.tlpu-dl input[type=date]{border:1px solid #cfd6e0;border-radius:8px;padding:7px 9px;font-size:13px;font-family:inherit}'
    + '.tlpu-dl .sw{display:flex;align-items:center;gap:7px;font-size:13px;font-weight:700;color:#b42318;cursor:pointer}'
    + '.tlpu-dl small{display:block;color:#6b7a90;font-weight:500;font-size:11.5px;margin-top:3px}'
    + '.tlpu-stats{font-size:12.5px;font-weight:700;color:#0f5f78;background:#e8f6fa;border-radius:8px;padding:6px 10px;display:inline-block}'
    + '.tlpu-n{border-left:3px solid #b42318}'
    + '.tlpu-n .notif-msg b{display:block;color:#1c2a3a}'
    + '.tlpu-n .tlpu-m{color:#1d7a45;font-weight:700}'
    + '.tlpu-qf-admin .rowx{display:flex;align-items:center;gap:8px;border:1px solid #e5e9f0;border-radius:10px;padding:8px 10px;margin-bottom:8px;background:#fff}'
    + '.tlpu-qf-admin input[type=text]{flex:1;border:1px solid #d5dde8;border-radius:8px;padding:7px 9px;font-size:13px}';
  function addStyle() {
    if (document.getElementById('tlpu-style')) return;
    var st = document.createElement('style');
    st.id = 'tlpu-style';
    st.textContent = css;
    (document.head || document.documentElement).appendChild(st);
  }
  addStyle();

  /* ================================================================ *
   * 1. quick filter chips
   * ================================================================ */
  var DEFAULT_CHIPS = [
    { key: 'fresher', label: 'Fresher' }, { key: 'wfh', label: 'Work from home' },
    { key: 'immediate', label: 'Immediate joining' }, { key: 'near_me', label: 'Near me' },
    { key: 'today', label: 'Posted today' }, { key: 'urgent', label: 'Urgent hiring' },
    { key: 'salary3', label: 'Salary 3 LPA+' }, { key: 'walkin', label: 'Walk-in' },
  ];
  var CHIPS = null;                      // the admin's list, from the server
  var IDS = Object.create(null);         // query key -> Set of job ids
  var IDS_LOADING = Object.create(null);
  var NEAR = null;                       // {lat, lon} or a place name, for signed-out "Near me"

  function chipList() { return CHIPS || DEFAULT_CHIPS; }
  function loadChips() {
    if (!ready()) return;
    api().get('/quick-filters').then(function (r) {
      CHIPS = (r && r.chips) || DEFAULT_CHIPS;
      rerender();
    }, function () { CHIPS = DEFAULT_CHIPS; });
  }

  /* Which page's state the chips belong to. */
  function scopeNow() {
    var h0 = String(location.hash || '');
    if (/^#\/candidate\/(search|recommended)\b/.test(h0)) return 'rj';
    return 'public';
  }
  function rjF() { return (STATE.rj && STATE.rj.f) || null; }

  /* A chip the sidebar already has a control for is that control. */
  function mappedGet(scope, k) {
    if (scope === 'public') {
      var f = STATE.search || {};
      if (k === 'salary3') return String(f.salaryMin) === '3';
      return null;
    }
    var F = rjF();
    if (!F) return null;
    if (k === 'salary3') return String(F.ctcMin) === '3';
    if (k === 'fresher') return (F.exp || []).indexOf('Fresher') >= 0;
    if (k === 'wfh') return (F.modes || []).indexOf('Remote') >= 0;
    return null;
  }
  function mappedSet(scope, k, on) {
    if (scope === 'public') {
      var f = STATE.search;
      if (k === 'salary3') { f.salaryMin = on ? '3' : ''; return true; }
      return false;
    }
    var F = rjF();
    if (!F) return false;
    var arr = function (key, v) {
      F[key] = (F[key] || []).filter(function (x) { return x !== v; });
      if (on) F[key].push(v);
    };
    if (k === 'salary3') { F.ctcMin = on ? '3' : ''; return true; }
    if (k === 'fresher') { arr('exp', 'Fresher'); return true; }
    if (k === 'wfh') { arr('modes', 'Remote'); return true; }
    return false;
  }
  function quickArr(scope) {
    if (scope === 'public') { STATE.search.quick = STATE.search.quick || []; return STATE.search.quick; }
    STATE.rj = STATE.rj || {};
    STATE.rj.quick = STATE.rj.quick || [];
    return STATE.rj.quick;
  }
  function chipOn(scope, k) {
    var m = mappedGet(scope, k);
    if (m !== null) return m;
    return quickArr(scope).indexOf(k) >= 0;
  }
  /* The chips that only the server can answer (no sidebar control). */
  function serverChips(scope) {
    return quickArr(scope).filter(function (k) { return mappedGet(scope, k) === null; });
  }
  function activeKeys(scope) {
    return chipList().map(function (c) { return c.key; }).filter(function (k) { return chipOn(scope, k); });
  }

  function idsKey(keys) {
    var near = keys.indexOf('near_me') >= 0 ? JSON.stringify(nearParam() || null) : '';
    return keys.slice().sort().join(',') + '|' + near;
  }
  function nearParam() {
    if (NEAR && typeof NEAR === 'object') return { lat: NEAR.lat, lon: NEAR.lon };
    if (NEAR) return { near: NEAR };
    var c = me();
    if (c && (c.location || c.preferredLocation)) return null;   // the server reads the profile
    return null;
  }
  /** The ids the server says pass these chips; null while loading. */
  function idsFor(keys) {
    if (!keys.length) return null;
    var key = idsKey(keys);
    if (IDS[key]) return IDS[key];
    if (!IDS_LOADING[key] && ready()) {
      IDS_LOADING[key] = true;
      var qs = 'quick=' + encodeURIComponent(keys.join(',')) + '&ids=1&limit=2000';
      var np = nearParam();
      if (np && np.near) qs += '&near=' + encodeURIComponent(np.near);
      if (np && np.lat != null) qs += '&lat=' + np.lat + '&lon=' + np.lon;
      api().get('/jobs?' + qs).then(function (r) {
        IDS[key] = new Set((r && r.ids) || []);
        delete IDS_LOADING[key];
        rerender();
      }, function () { delete IDS_LOADING[key]; IDS[key] = new Set(); rerender(); });
    }
    return 'loading';
  }
  function passesChips(scope, jobId) {
    var keys = serverChips(scope);
    if (!keys.length) return true;
    var set = idsFor(keys);
    if (set === 'loading') return true;          // shown until the answer arrives
    return set ? set.has(jobId) : true;
  }

  function writeUrl(scope) {
    var keys = activeKeys(scope);
    var h0 = String(location.hash || '#/');
    var path = h0.split('?')[0] || '#/';
    var params = (h0.split('?')[1] || '').split('&').filter(function (kv) { return kv && kv.indexOf('qf=') !== 0; });
    if (keys.length) params.push('qf=' + keys.join(','));
    var next = path + (params.length ? '?' + params.join('&') : '');
    LAST_QF = keys.join(',');
    if (next !== h0) {
      try { history.replaceState(null, '', location.pathname + location.search + next); } catch (e) {}
    }
  }
  var LAST_QF = null;
  /** ?qf= in the URL turns those chips on (a shared or reloaded search). */
  function readUrl() {
    var m = /[?&]qf=([^&]*)/.exec(String(location.hash || ''));
    /* No ?qf= says nothing: the chips stay as the page has them. */
    if (!m) return;
    var want = decodeURIComponent(m[1]);
    if (want === LAST_QF) return;
    LAST_QF = want;
    if (typeof STATE === 'undefined') return;
    var scope = scopeNow();
    if (scope === 'public' && !STATE.search) return;
    var keys = want.split(',').filter(Boolean);
    chipList().forEach(function (c) {
      var on = keys.indexOf(c.key) >= 0;
      if (!mappedSet(scope, c.key, on)) {
        var a = quickArr(scope);
        var i = a.indexOf(c.key);
        if (on && i < 0) a.push(c.key);
        if (!on && i >= 0) a.splice(i, 1);
      }
    });
  }

  window.tlpuChip = function (key) {
    var scope = scopeNow();
    var on = !chipOn(scope, key);
    if (key === 'near_me' && on && !nearReady()) { askNear(function () { window.tlpuChip('near_me'); }); return; }
    if (!mappedSet(scope, key, on)) {
      var a = quickArr(scope);
      var i = a.indexOf(key);
      if (on && i < 0) a.push(key);
      if (!on && i >= 0) a.splice(i, 1);
    }
    writeUrl(scope);
    rerender();
  };

  /* Near me: the candidate's own location, or the browser's. */
  function nearReady() {
    if (NEAR) return true;
    var c = me();
    return !!(c && (c.location || c.preferredLocation));
  }
  function askNear(then) {
    var typed = function () {
      var el = document.querySelector('input[name="loc"], #rjQ');
      var v = el && el.name === 'loc' ? String(el.value || '').trim() : '';
      if (v) { NEAR = v; then(); return; }
      say('Allow location access, or type your city in Location, to see jobs near you', '📍');
    };
    if (!navigator.geolocation) { typed(); return; }
    navigator.geolocation.getCurrentPosition(function (pos) {
      NEAR = { lat: Number(pos.coords.latitude.toFixed(4)), lon: Number(pos.coords.longitude.toFixed(4)) };
      then();
    }, typed, { timeout: 8000, maximumAge: 600000 });
  }

  function chipRowHtml(scope) {
    var list = chipList();
    if (!list.length) return '';
    return '<div class="tlpu-chips" role="toolbar" aria-label="Quick filters">'
      + list.map(function (c) {
        var on = chipOn(scope, c.key);
        return '<button type="button" class="tlpu-chip' + (on ? ' on' : '') + '" data-k="' + h(c.key) + '" aria-pressed="' + on + '"'
          + ' onclick="event.stopPropagation();tlpuChip(\'' + h(c.key) + '\')">' + h(c.label) + '</button>';
      }).join('') + '</div>';
  }

  /* ---- the public Home / Find Jobs page ---- */
  var prevBody = window.jobSearchBody;
  if (typeof prevBody === 'function') {
    window.jobSearchBody = function () {
      readUrl();
      var out = prevBody.apply(this, arguments);
      if (typeof out !== 'string') return out;
      return chipRowHtml('public') + out;
    };
  }
  var prevFilter = window.filterJobsAdvanced;
  if (typeof prevFilter === 'function') {
    window.filterJobsAdvanced = function (f) {
      var list = prevFilter.apply(this, arguments);
      if (!Array.isArray(list) || typeof STATE === 'undefined') return list;
      return list.filter(function (j) { return j && passesChips('public', j.id); });
    };
  }
  var prevChips = window.activeFilterChips;
  if (typeof prevChips === 'function') {
    window.activeFilterChips = function (f) {
      var out = prevChips.apply(this, arguments) || [];
      try {
        (STATE.search.quick || []).forEach(function (k) {
          var c = chipList().filter(function (x) { return x.key === k; })[0];
          if (c && mappedGet('public', k) === null) out.push({ k: 'quick', val: k, label: c.label });
        });
      } catch (e) {}
      return out;
    };
  }
  var prevRemove = window.removeFilterChip;
  if (typeof prevRemove === 'function') {
    window.removeFilterChip = function (k) {
      var r = prevRemove.apply(this, arguments);
      try { writeUrl('public'); } catch (e) {}
      return r;
    };
  }

  /* ---- Relevance: urgent jobs up, by no more than 10 points ---- */
  function relScore(c, j) {
    var m = MATCH[j.id];
    var s = m ? m.score : (typeof prevCms === 'function' ? Number(prevCms(c, j)) || 0 : 0);
    return s + (urgent(j) ? 10 : 0);
  }
  var prevSort = window.sortJobs;
  if (typeof prevSort === 'function') {
    window.sortJobs = function (list, sort, cand) {
      var out = prevSort.apply(this, arguments);
      if ((sort || 'relevance') !== 'relevance' || !Array.isArray(out)) return out;
      if (cand) return out.slice().sort(function (a, b) { return relScore(cand, b) - relScore(cand, a); });
      /* signed out: urgent first among equals, nothing else moves */
      return out.slice().sort(function (a, b) { return (urgent(b) ? 1 : 0) - (urgent(a) ? 1 : 0); });
    };
  }

  /* ---- the candidate's Search Jobs / Recommended page ---- */
  var prevRj = window.rjPage;
  if (typeof prevRj === 'function') {
    window.rjPage = function () {
      readUrl();
      var out = prevRj.apply(this, arguments);
      if (typeof out !== 'string' || !out) return out;
      var row = chipRowHtml('rj');
      var at = out.indexOf('<div class="rj-aibox"');
      if (at < 0) at = out.indexOf('<div class="rj-mob"');
      if (at < 0) at = out.indexOf('<div class="rj-bar"');
      if (at < 0) return out;
      return out.slice(0, at) + row + out.slice(at);
    };
  }
  var prevRecAll = window.recAll;
  if (typeof prevRecAll === 'function') {
    window.recAll = function () {
      var list = prevRecAll.apply(this, arguments);
      if (!Array.isArray(list)) return list;
      return list.filter(function (r) { return r && r.job && passesChips('rj', r.job.id); });
    };
  }
  var prevRjClear = window.rjClear;
  if (typeof prevRjClear === 'function') {
    window.rjClear = function () {
      if (STATE.rj) STATE.rj.quick = [];
      var r = prevRjClear.apply(this, arguments);
      writeUrl('rj');
      return r;
    };
  }

  /* ================================================================ *
   * 2. match reasons - the server's score
   * ================================================================ */
  var MATCH = Object.create(null);       // jobId -> explain result
  var MATCH_PENDING = Object.create(null);
  var MATCH_SIG = '';
  var matchTimer = null;

  function profileSig(c) {
    if (!c) return '';
    return [c.id, (c.skills || []).join('|'), (c.technicalSkills || []).join('|'), c.exp, c.expYears,
      c.location, c.preferredLocation, c.expectedCtc, c.education, c.resumeFile, c.resumeUploadedAt].join('~');
  }
  function wantMatches(ids) {
    var c = me();
    if (!c || !ready()) return;
    var sig = profileSig(c);
    if (sig !== MATCH_SIG) { MATCH = Object.create(null); MATCH_PENDING = Object.create(null); MATCH_SIG = sig; }
    ids.forEach(function (id) {
      if (id && !isExternal(id) && !MATCH[id] && !MATCH_PENDING[id]) MATCH_PENDING[id] = 'want';
    });
    if (matchTimer) return;
    matchTimer = setTimeout(fetchMatches, 60);
  }
  function fetchMatches() {
    matchTimer = null;
    var want = Object.keys(MATCH_PENDING).filter(function (id) { return MATCH_PENDING[id] === 'want'; });
    if (!want.length || !isCandidate()) return;
    var batches = [];
    for (var i = 0; i < want.length; i += 50) batches.push(want.slice(i, i + 50));
    var sig = MATCH_SIG;
    Promise.all(batches.map(function (b) {
      b.forEach(function (id) { MATCH_PENDING[id] = 'asked'; });
      return api().get('/job-matches/explain?jobIds=' + b.map(encodeURIComponent).join(','))
        .then(function (r) {
          if (sig !== MATCH_SIG) return;
          (r.matches || []).forEach(function (m) { MATCH[m.jobId] = m; });
          (r.missing || []).forEach(function (id) { MATCH[id] = { jobId: id, gone: true }; });
        }, function () { b.forEach(function (id) { delete MATCH_PENDING[id]; }); });
    })).then(function () {
      if (typing()) decorate(); else rerender();
    });
  }
  window.TLPortalUpgrades = window.TLPortalUpgrades || {};
  window.TLPortalUpgrades.match = function (jobId) { return MATCH[jobId] || null; };

  var prevCms = window.computeMatchScore;
  if (typeof prevCms === 'function') {
    window.computeMatchScore = function (c, j) {
      var m = j && MATCH[j.id];
      var self = me();
      if (m && !m.gone && c && self && c.id === self.id) return m.score;
      return prevCms.apply(this, arguments);
    };
  }
  var prevRec = window.recRecommendation;
  if (typeof prevRec === 'function') {
    window.recRecommendation = function (c, j) {
      var r = prevRec.apply(this, arguments);
      var m = j && MATCH[j.id];
      var self = me();
      if (r && m && !m.gone && c && self && c.id === self.id) {
        r.matchPercentage = m.score;
        r.matchedSkills = m.matchedSkills.slice();
        r.missingSkills = m.missingSkills.slice();
        if (typeof r.aiRecommendation === 'string') {
          r.aiRecommendation = r.aiRecommendation.replace(/Estimated \d+%/, 'Estimated ' + m.score + '%');
        }
      }
      return r;
    };
  }
  var prevExplain = window.matchExplanation;
  if (typeof prevExplain === 'function') {
    window.matchExplanation = function (c, j) {
      var r = prevExplain.apply(this, arguments);
      var m = j && MATCH[j.id];
      if (r && m && !m.gone) {
        r.score = m.score;
        r.matched = m.matchedSkills.slice();
        r.missing = m.missingSkills.slice();
      }
      return r;
    };
  }

  function lineHtml(m, withPct) {
    var parts = [];
    if (withPct) parts.push('<b>' + h(m.score) + '% match</b>');
    (m.line || []).forEach(function (p) {
      parts.push('<span class="' + (p.ok ? 'ok' : 'no') + '">' + (p.ok ? '✓ ' : '✗ ') + h(p.text) + '</span>');
    });
    return parts.join(' · ');
  }

  /* ================================================================ *
   * 3. share
   * ================================================================ */
  function makeShare(jobId, channel) {
    return api().post('/jobs/' + encodeURIComponent(jobId) + '/share', { channel: channel });
  }
  function closeOverlay() {
    var o = document.getElementById('tlpuOverlay');
    if (o) o.remove();
  }
  function overlay(inner) {
    closeOverlay();
    var o = document.createElement('div');
    o.className = 'tlpu-ov';
    o.id = 'tlpuOverlay';
    o.innerHTML = '<div class="tlpu-sheet" role="dialog" aria-modal="true">' + inner + '</div>';
    o.addEventListener('click', function (e) { if (e.target === o) closeOverlay(); });
    document.body.appendChild(o);
    return o;
  }
  window.tlpuCloseSheet = closeOverlay;

  window.tlpuShare = function (jobId) {
    var job = jobOf(jobId);
    if (!ready()) return;
    var phone = (navigator.maxTouchPoints || 0) > 0 && window.matchMedia && window.matchMedia('(max-width: 820px)').matches;
    if (phone && typeof navigator.share === 'function') {
      makeShare(jobId, 'native').then(function (s) {
        return navigator.share({ title: job ? job.title : 'Job on TeamLink', text: s.text, url: s.url });
      }).catch(function (err) {
        if (err && err.name === 'AbortError') return;
        shareSheet(jobId);
      });
      return;
    }
    shareSheet(jobId);
  };
  function shareSheet(jobId) {
    var job = jobOf(jobId);
    overlay('<h3>Share this job</h3><p>' + h(job ? job.title : '') + (job && job.location ? ' · ' + h(job.location) : '') + '</p>'
      + '<div class="tlpu-sharegrid">'
      + '<button type="button" data-ch="whatsapp" onclick="tlpuShareVia(\'' + h(jobId) + '\',\'whatsapp\')">🟢 WhatsApp</button>'
      + '<button type="button" data-ch="copy" onclick="tlpuShareVia(\'' + h(jobId) + '\',\'copy\')">🔗 Copy link</button>'
      + '<button type="button" data-ch="email" onclick="tlpuShareVia(\'' + h(jobId) + '\',\'email\')">✉️ Email</button>'
      + '<button type="button" data-ch="linkedin" onclick="tlpuShareVia(\'' + h(jobId) + '\',\'linkedin\')">in LinkedIn</button>'
      + '</div><div class="tlpu-link" id="tlpuShareLink" style="display:none"></div>'
      + '<div class="tlpu-acts"><button type="button" class="btn btn-ghost" onclick="tlpuCloseSheet()">Close</button></div>');
  }
  window.tlpuShareVia = function (jobId, channel) {
    /* Opened inside the tap, filled in when the link exists - a window
       opened after an await is a pop-up, and blocked. */
    var win = (channel === 'whatsapp' || channel === 'linkedin') ? window.open('about:blank', '_blank') : null;
    makeShare(jobId, channel).then(function (s) {
      var box = document.getElementById('tlpuShareLink');
      if (box) { box.style.display = 'block'; box.textContent = s.text; }
      window.TLPortalUpgrades.lastShare = s;
      if (channel === 'whatsapp' || channel === 'linkedin') {
        var url = channel === 'whatsapp' ? s.links.whatsapp : s.links.linkedin;
        if (win && !win.closed) { try { win.opener = null; } catch (e) {} win.location.href = url; } else window.open(url, '_blank', 'noopener');
      } else if (channel === 'email') {
        location.href = s.links.email;
      } else {
        var done = function () { say('Link copied', '🔗'); };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(s.text).then(done, function () { say('Copy the link below', '🔗'); });
        } else say('Copy the link below', '🔗');
      }
    }, function (err) {
      if (win) try { win.close(); } catch (e) {}
      if (api() && api().say) api().say(err);
    });
  };

  var STATS = Object.create(null);
  function shareStats(jobId) {
    if (STATS[jobId] || !ready()) return STATS[jobId] || null;
    STATS[jobId] = { loading: true };
    api().get('/jobs/' + encodeURIComponent(jobId) + '/share-stats').then(function (r) {
      STATS[jobId] = r;
      var el = document.querySelector('[data-tlpu-stats="' + jobId + '"]');
      if (el) el.innerHTML = statsText(r);
    }, function () { STATS[jobId] = { denied: true }; });
    return STATS[jobId];
  }
  function statsText(r) {
    if (!r || r.loading || r.denied) return '';
    return 'Shared ' + r.shares + ' time' + (r.shares === 1 ? '' : 's') + ' · ' + r.applies + ' appl' + (r.applies === 1 ? 'y' : 'ies');
  }

  /* ================================================================ *
   * 4. one-click apply
   * ================================================================ */
  var FIELD = {
    name: 'Full name', phone: 'Mobile number', location: 'Current city',
    experience: 'Total experience', skills: 'Key skills', resume: 'Resume',
  };
  function missingFor(c) {
    var has = function (v) { return v != null && String(v).trim() !== ''; };
    var out = [];
    if (!has(c.name)) out.push('name');
    if (!has(c.phone)) out.push('phone');
    if (!has(c.location) && !has(c.preferredLocation)) out.push('location');
    if (!has(c.exp) && c.expYears == null) out.push('experience');
    if (![].concat(c.skills || [], c.technicalSkills || []).filter(has).length) out.push('skills');
    if (!has(c.resumeFile)) out.push('resume');
    return out;
  }

  /* A sign-in that is finishing an application someone started while
     signed out (teamlink-apply-auth.js) is that application: it goes the
     way it went before, not through the one-click sheet. */
  var authResume = null;
  function noteIntent() {
    try {
      var it = window.TLApplyAuth && TLApplyAuth.intent && TLApplyAuth.intent();
      if (it && it.jobId) authResume = { jobId: String(it.jobId), at: Date.now() };
    } catch (e) {}
  }
  noteIntent();
  var prevNavigate = window.navigate;
  if (typeof prevNavigate === 'function') {
    window.navigate = function () { noteIntent(); return prevNavigate.apply(this, arguments); };
  }
  function resuming(jobId) {
    return !!(authResume && authResume.jobId === String(jobId) && Date.now() - authResume.at < 60000);
  }

  var applying = Object.create(null);

  function oneClick(jobId, legacy, via) {
    var c = me();
    var job = jobOf(jobId);
    if (!c) return legacy(jobId, via);
    if (expired(job)) { say('Applications closed for this job', '⏳'); return; }
    if (DATA.hasApplication && DATA.hasApplication(c.id, jobId)) return legacy(jobId, via);
    if (applying[jobId]) return applying[jobId];
    var miss = missingFor(c);
    if (miss.length) { missingSheet(jobId, miss, legacy, via); return; }
    applying[jobId] = beforeApply(jobId).then(function (pre) {
      if (pre === false) return null;
      return post(jobId, pre && pre.answers);
    }).then(function (x) { delete applying[jobId]; return x; }, function (err) {
      delete applying[jobId];
      if (err && err.code === 'VALIDATION_FAILED' && err.details && err.details.missing) {
        missingSheet(jobId, err.details.missing, legacy, via);
        return;
      }
      if (api() && api().say) api().say(err);
    });
    return applying[jobId];
  }

  /* Screening questions first, when the job has them (agent D's hook):
     resolves to {answers} | null, or false when the candidate cancelled. */
  function beforeApply(jobId) {
    var s = window.TLScreening;
    if (!s || typeof s.beforeApply !== 'function') return Promise.resolve(null);
    return Promise.resolve().then(function () { return s.beforeApply(jobId); }).then(function (r) {
      if (r && r.cancelled) return false;
      return r || null;
    }, function () { return false; });
  }

  function post(jobId, answers) {
    var body = { jobId: jobId };
    try { if (TL.applicationSource) body.source = TL.applicationSource(); } catch (e) {}
    if (answers) body.answers = answers;
    return api().post('/applications/one-click', body).then(function (res) {
      var c = me();
      var a = res.application;
      a.fromServer = true;
      var have = (DATA.applications || []).some(function (x) { return x.id === a.id || (x.candidateId === a.candidateId && x.jobId === a.jobId); });
      if (!have) DATA.applications.push(a);
      var job = jobOf(jobId);
      if (job && typeof res.applicants === 'number') job.applicants = res.applicants;
      if (res.notification && TL.notifications) TL.notifications.unshift(res.notification);
      if (res.existing) { say('You already applied to this role', 'ℹ️'); rerender(); return res; }
      /* The post-apply record the interview flow hangs off - without its
         page change and its own toast; this one says it. */
      if (typeof window.__afterApply === 'function') {
        var nav = window.navigate, t = window.toast;
        try {
          window.navigate = function () {};
          window.toast = function () {};
          window.__afterApply(a.id, jobId, c.id, c, job, true);
        } catch (e) { /* the application stands either way */ }
        finally { window.navigate = nav; window.toast = t; }
        try { if (TL.syncInterviewDeadlines) TL.syncInterviewDeadlines(); } catch (e) {}
      }
      rerender();
      appliedToast(a, job);
      return res;
    });
  }

  function appliedToast(app, job) {
    /* Its own place near the top: at the bottom of a phone the tab bar and
       the assistant button sit over the ordinary toasts, and an Undo
       nobody can reach is not an Undo. */
    var host = document.getElementById('tlpuToastHost');
    if (!host) {
      host = document.createElement('div');
      host.id = 'tlpuToastHost';
      host.className = 'tlpu-toasthost';
      document.body.appendChild(host);
    }
    var el = document.createElement('div');
    el.className = 'toast tlpu-toast';
    el.setAttribute('role', 'status');
    el.innerHTML = '<span class="ic">✓</span><span>Applied ✓' + (job ? ' · ' + h(job.title) : '') + '</span>'
      + '<button class="toast-action" type="button">Undo (10)</button>';
    host.appendChild(el);
    var btn = el.querySelector('button');
    var left = 10;
    var gone = false;
    var dismiss = function () {
      if (gone) return; gone = true;
      clearInterval(tick);
      el.style.transition = 'opacity .3s'; el.style.opacity = '0';
      setTimeout(function () { el.remove(); }, 320);
    };
    var tick = setInterval(function () {
      left -= 1;
      if (left <= 0) { dismiss(); return; }
      btn.textContent = 'Undo (' + left + ')';
    }, 1000);
    btn.onclick = function () {
      btn.disabled = true;
      undo(app).then(dismiss, dismiss);
    };
  }

  function undo(app) {
    return api().del('/applications/' + encodeURIComponent(app.id)).then(function () {
      var list = DATA.applications || [];
      for (var i = list.length - 1; i >= 0; i--) {
        if (list[i].id === app.id || (list[i].candidateId === app.candidateId && list[i].jobId === app.jobId)) list.splice(i, 1);
      }
      var job = jobOf(app.jobId);
      if (job && job.applicants > 0) job.applicants -= 1;
      if (TL.notifications) TL.notifications = TL.notifications.filter(function (n) { return n.applicationId !== app.id; });
      try {
        if (window.__LC && window.__LC.apps) {
          delete window.__LC.apps[app.candidateId + '|' + app.jobId];
          localStorage.setItem('tl_portal_lifecycle_v1', JSON.stringify(window.__LC));
        }
      } catch (e) {}
      rerender();
      say('Application withdrawn', '↩️');
      /* A refresh already in flight when Undo was pressed would put the
         row back from its older snapshot; the server's answer settles it. */
      if (TL.refresh) {
        setTimeout(function () {
          Promise.resolve(TL.refresh()).then(function () {
            var l2 = DATA.applications || [];
            for (var k = l2.length - 1; k >= 0; k--) if (l2[k].id === app.id) l2.splice(k, 1);
            rerender();
          }, function () {});
        }, 400);
      }
    }, function (err) {
      say((err && err.message) || 'Undo is no longer possible', '⚠️');
    });
  }
  window.TLPortalUpgrades.undo = undo;

  /* ---- "Fill 2 things to apply" ---- */
  var EXP = ['Fresher', '1 yr', '2 yrs', '3 yrs', '4 yrs', '5 yrs', '6 yrs', '7 yrs', '8 yrs', '10 yrs', '12 yrs', '15+ yrs'];
  function missingSheet(jobId, miss, legacy, via) {
    var c = me() || {};
    var job = jobOf(jobId);
    var f = function (k) {
      var id = 'tlpuF_' + k;
      var input = k === 'experience'
        ? '<select id="' + id + '"><option value="">Select…</option>' + EXP.map(function (e) { return '<option>' + e + '</option>'; }).join('') + '</select>'
        : k === 'resume' ? '<input id="' + id + '" type="file" accept=".pdf,.doc,.docx,.txt">'
        : '<input id="' + id + '" type="' + (k === 'phone' ? 'tel' : 'text') + '"'
          + (k === 'skills' ? ' placeholder="e.g. Excel, Driving, Java"' : k === 'location' ? ' placeholder="e.g. Nellore"' : '')
          + ' value="' + h(k === 'name' ? (c.name || '') : k === 'phone' ? (c.phone || '') : '') + '">';
      return '<div class="f"><label for="' + id + '">' + h(FIELD[k]) + '</label>' + input + '<div class="err" id="' + id + '_err"></div></div>';
    };
    overlay('<h3>Fill ' + miss.length + ' thing' + (miss.length === 1 ? '' : 's') + ' to apply</h3>'
      + '<p>' + (job ? h(job.title) + ' · ' : '') + 'Saved to your profile, then your application goes in.</p>'
      + miss.map(f).join('')
      + '<div class="tlpu-acts"><button type="button" class="btn btn-primary" id="tlpuSaveApply">Save &amp; apply</button>'
      + '<button type="button" class="btn btn-ghost" id="tlpuWithout">Apply without them</button></div>'
      + '<div class="tlpu-acts"><button type="button" class="btn btn-ghost" onclick="tlpuCloseSheet()">Cancel</button></div>');
    document.getElementById('tlpuWithout').onclick = function () { closeOverlay(); legacy(jobId, via); };
    document.getElementById('tlpuSaveApply').onclick = function () {
      var btn = this;
      var val = function (k) { var el = document.getElementById('tlpuF_' + k); return el ? String(el.value || '').trim() : ''; };
      var body = {}, bad = false, file = null;
      miss.forEach(function (k) {
        var err = document.getElementById('tlpuF_' + k + '_err');
        if (err) err.textContent = '';
        var v = val(k);
        if (k === 'resume') {
          var el = document.getElementById('tlpuF_resume');
          file = el && el.files && el.files[0];
          if (!file) { err.textContent = 'Choose your resume file.'; bad = true; }
          return;
        }
        if (!v) { err.textContent = 'Please fill this in.'; bad = true; return; }
        if (k === 'name') body.name = v;
        if (k === 'phone') {
          if (!/^[0-9+\-\s]{10,15}$/.test(v)) { err.textContent = 'Enter a 10-digit mobile number.'; bad = true; return; }
          body.phone = v;
        }
        if (k === 'location') body.location = v;
        if (k === 'experience') { body.exp = v; var n = parseInt(v, 10); body.expYears = /fresher/i.test(v) ? 0 : (isFinite(n) ? n : 0); }
        if (k === 'skills') body.skills = v.split(',').map(function (s) { return s.trim(); }).filter(Boolean).slice(0, 30);
      });
      if (bad) return;
      btn.disabled = true; btn.textContent = 'Saving…';
      var cid = STATE.session.id;
      var step = Object.keys(body).length
        ? api().put('/candidates/' + encodeURIComponent(cid), body).then(function (r) {
            var local = DATA.candidateById(cid);
            if (local) Object.assign(local, (r && r.candidate) || body);
          })
        : Promise.resolve();
      step.then(function () {
        if (file && TL.uploadResume) return TL.uploadResume(file, null);
      }).then(function () {
        closeOverlay();
        oneClick(jobId, legacy, via);
      }, function (err) {
        btn.disabled = false; btn.textContent = 'Save & apply';
        if (api() && api().say) api().say(err);
      });
    };
  }

  /* ---- the wrappers ---- */
  var prevApply = window.applyToJob;
  if (typeof prevApply === 'function') {
    window.applyToJob = function (jobId, via) {
      var self = this, args = arguments;
      var legacy = function () { return prevApply.apply(self, args); };
      if (!jobId || isExternal(jobId) || !isCandidate() || resuming(jobId)) return legacy();
      return oneClick(jobId, legacy, via);
    };
  }
  /* The other Apply buttons mean the same thing now: one tap. The home
     page's "Easy Apply" (cpEasyApply) keeps its review step with the
     cover note - verify-easy-apply pins it - and its Submit comes back
     through applyToJob, so it is one-click from there. */
  ['easyApply', 'capApply'].forEach(function (fn) {
    var prev = window[fn];
    if (typeof prev !== 'function') return;
    window[fn] = function (jobId) {
      if (!jobId || isExternal(jobId) || !isCandidate() || resuming(jobId)) return prev.apply(this, arguments);
      return window.applyToJob(jobId, true);
    };
  });

  /* ================================================================ *
   * cards and the job page
   * ================================================================ */
  var ID_RE = /(?:navigate\('\/job\/|capApply\('|rjApplyJob\('|cpEasyApply\('|easyApply\('|applyToJob\('|toggleSaveJob\(')([A-Za-z0-9_\-]+)'/;
  var CARDS = '.job-card,.job-row,.rj-card,.cap-jobc,.cp-card';

  function badgesHtml(job) {
    var out = '';
    if (!job) return out;
    if (expired(job)) return '<span class="tlpu-b closed">Applications closed</span>';
    if (urgent(job)) out += '<span class="tlpu-b urgent">🔴 Urgent hiring</span>';
    var d = daysLeft(job);
    if (d === 0) out += '<span class="tlpu-b amber">⏳ Last day today</span>';
    else if (d != null && d > 0) out += '<span class="tlpu-b amber">⏳ ' + d + ' day' + (d === 1 ? '' : 's') + ' left</span>';
    return out;
  }
  function closeApplyButtons(root) {
    Array.prototype.forEach.call(root.querySelectorAll('button'), function (b) {
      var t = String(b.textContent || '');
      if (/apply/i.test(t) && !/applied|filters?/i.test(t) && !b.closest('.tlpu-strip')) {
        b.disabled = true;
        b.textContent = 'Applications closed';
        b.removeAttribute('onclick');
      }
    });
  }

  function decorateCard(el) {
    if (el.getAttribute('data-tlpu')) return;
    var m = ID_RE.exec(el.innerHTML);
    if (!m) return;
    var id = m[1];
    if (isExternal(id)) return;
    var job = jobOf(id);
    if (!job) return;
    el.setAttribute('data-tlpu', id);
    var strip = document.createElement('div');
    strip.className = 'tlpu-strip';
    strip.setAttribute('onclick', 'event.stopPropagation()');
    var hasPct = !!el.querySelector('.badge-match,.rj-score');
    var why = '';
    if (isCandidate()) {
      var mm = MATCH[id];
      if (mm && !mm.gone) why = '<div class="tlpu-why">' + lineHtml(mm, !hasPct) + '</div>';
      else wantMatches([id]);
    } else if (!session()) {
      why = '<div class="tlpu-why"><a href="#/login/candidate">Log in to see your match</a></div>';
    }
    var badges = badgesHtml(job);
    strip.innerHTML = why
      + '<div class="tlpu-row"><div class="tlpu-badges">' + badges + '</div>'
      + (expired(job) ? '' : '<button type="button" class="tlpu-share" onclick="event.stopPropagation();tlpuShare(\'' + h(id) + '\')">↗ Share</button>')
      + '</div>';
    var foot = el.querySelector('.foot,.rj-foot,.jr-foot-meta');
    if (foot && foot.parentNode === el) el.insertBefore(strip, foot); else el.appendChild(strip);
    if (expired(job)) closeApplyButtons(el);
  }

  function jobPageId() {
    var m = /^#\/job\/([^/?]+)/.exec(String(location.hash || ''));
    return m ? decodeURIComponent(m[1]) : null;
  }
  function decorateJobPage() {
    var id = jobPageId();
    if (!id || isExternal(id)) return;
    var app = document.getElementById('app');
    if (!app || app.querySelector('.tlpu-jp')) return;
    var job = jobOf(id);
    if (!job) return;
    var host = app.querySelector('.two-col > div') || app.querySelector('main') || app;
    var panel = document.createElement('div');
    panel.className = 'panel tlpu-jp';
    panel.setAttribute('data-tlpu-job', id);
    var top = '<div class="tlpu-row"><div class="tlpu-badges">' + badgesHtml(job) + '</div>'
      + (expired(job) ? '' : '<button type="button" class="tlpu-share" onclick="tlpuShare(\'' + h(id) + '\')">↗ Share</button>') + '</div>';
    if (job.expiresAt) {
      top += '<div class="tlpu-kv"><span class="k">Last date</span><span>' + h(fmtDate(job.expiresAt))
        + (expired(job) ? ' · <b style="color:#b42318">Applications closed</b>' : '') + '</span></div>';
    }
    var body = '';
    var r = role();
    if (r === 'recruiter' || r === 'admin') {
      var st = shareStats(id);
      body = '<div><span class="tlpu-stats" data-tlpu-stats="' + h(id) + '">' + h(statsText(st)) + '</span></div>';
    } else if (isCandidate()) {
      var m = MATCH[id];
      if (!m) { wantMatches([id]); body = '<div class="tlpu-why">Working out your match…</div>'; }
      else if (!m.gone) body = breakdownHtml(m);
    } else {
      body = '<div class="tlpu-why"><a href="#/login/candidate">Log in to see your match</a> - your skills, experience and location against this job.</div>';
    }
    var title = isCandidate() ? (MATCH[id] && !MATCH[id].gone ? 'Your match · ' + h(MATCH[id].score) + '%' : 'Your match')
      : (r === 'recruiter' || r === 'admin') ? 'Last date, urgency and sharing' : 'Your match';
    panel.innerHTML = '<div class="panel-head"><h2>' + title + '</h2></div>'
      + '<div class="panel-body">' + top + body + '</div>';
    /* Under the job's own heading panel, so the title is read first. */
    var first = null;
    for (var k = 0; k < host.children.length; k++) {
      if (host.children[k].classList && host.children[k].classList.contains('panel')) { first = host.children[k]; break; }
    }
    if (first) host.insertBefore(panel, first.nextSibling); else host.insertBefore(panel, host.firstChild);
    if (expired(job)) closeApplyButtons(app);
  }
  function breakdownHtml(m) {
    var kv = function (k, v) { return '<div class="tlpu-kv"><span class="k">' + h(k) + '</span><span>' + v + '</span></div>'; };
    var ok = function (b) { return b ? '<span class="ok" style="color:#1d7a45;font-weight:700">✓</span> ' : '<span style="color:#b42318;font-weight:700">✗</span> '; };
    var out = '<div class="tlpu-why">' + lineHtml(m, true) + '</div>';
    if (m.skillsStated) {
      out += kv('Skills', (m.matchedSkills.length ? ok(true) + h(m.matchedSkills.join(', ')) : '')
        + (m.impliedSkills && m.impliedSkills.length ? (m.matchedSkills.length ? '<br>' : '') + '~ ' + h(m.impliedSkills.join(', ')) + ' (in your resume)' : '')
        + (m.missingSkills.length ? ((m.matchedSkills.length || (m.impliedSkills || []).length) ? '<br>' : '') + ok(false) + h(m.missingSkills.join(', ')) + ' missing' : ''));
    }
    var e = m.experience || {};
    out += kv('Experience', e.years != null
      ? ok(e.ok) + h(e.years) + ' yrs' + (e.required ? ' · job asks ' + h(e.required) : '')
      : ok(false) + 'not on your profile' + (e.required ? ' · job asks ' + h(e.required) : ''));
    var l = m.location || {};
    out += kv('Location', ok(l.ok) + h(l.reason || '') + (l.jobLocation ? ' · ' + h(l.jobLocation) : ''));
    var s = m.salary || {};
    out += kv('Salary', s.fit === 'unknown' ? 'add your expected salary to compare'
      : ok(s.ok) + (s.fit === 'within' ? 'your expectation fits' : s.fit === 'slightly_above' ? 'your expectation is slightly above' : 'your expectation is above') + (s.offered ? ' · ' + h(s.offered) : ''));
    if (m.missingSkills.length) {
      out += '<div><div class="tlpu-kv"><span class="k">Improve your match</span><span>'
        + m.missingSkills.slice(0, 6).map(function (sk) {
          return '<button type="button" class="tlpu-add" onclick="tlpuAddSkill(\'' + h(String(sk).replace(/'/g, '')) + '\')">+ ' + h(sk) + '</button>';
        }).join('') + '</span></div></div>';
    }
    return out;
  }
  window.tlpuAddSkill = function (skill) {
    say('If you have ' + skill + ', add it under Skills on your profile', '✏️');
    if (typeof window.navigate === 'function') window.navigate('/candidate/profile');
  };

  /* ---- the urgent-only DOM pass on Search Jobs: urgent up by ≤10 points ---- */
  function reorderRj() {
    if (!STATE.rj || (STATE.rj.sort && STATE.rj.sort !== 'relevant') || (STATE.rj.view && ['best', 'relevant'].indexOf(STATE.rj.view) < 0)) return;
    var cards = Array.prototype.slice.call(document.querySelectorAll('#app .rj-card'));
    if (cards.length < 2) return;
    var parent = cards[0].parentNode;
    if (!cards.every(function (c) { return c.parentNode === parent; })) return;
    var c = me();
    var keyed = cards.map(function (el, i) {
      var m = ID_RE.exec(el.innerHTML);
      var j = m && jobOf(m[1]);
      var mm = j && MATCH[j.id];
      var s = mm && !mm.gone ? mm.score : (j && c && prevCms ? Number(prevCms(c, j)) || 0 : 0);
      return { el: el, i: i, s: s + (urgent(j) ? 10 : 0) };
    });
    var sorted = keyed.slice().sort(function (a, b) { return b.s - a.s || a.i - b.i; });
    if (sorted.every(function (x, i) { return x === keyed[i]; })) return;
    var anchor = cards[cards.length - 1].nextSibling;
    sorted.forEach(function (x) { parent.insertBefore(x.el, anchor); });
  }

  /* Server dates onto the recruiter's Manage Jobs view of the same job. */
  function syncExpiry() {
    try {
      (DATA.jobs || []).forEach(function (j) { if (j && j.expiresAt) j.expiresOn = istDay(j.expiresAt); });
    } catch (e) {}
  }

  var decorating = false;
  function decorate() {
    if (decorating) return;
    decorating = true;
    try {
      var app = document.getElementById('app');
      if (!app) return;
      var cards = app.querySelectorAll(CARDS);
      var want = [];
      Array.prototype.forEach.call(cards, function (el) {
        if (isCandidate()) { var m = ID_RE.exec(el.innerHTML); if (m && !MATCH[m[1]]) want.push(m[1]); }
        decorateCard(el);
      });
      if (want.length) wantMatches(want);
      decorateJobPage();
      if (/^#\/candidate\/(search|recommended)/.test(location.hash)) reorderRj();
      /* the URL follows the sidebar too, for the chips it shares */
      if (app.querySelector('.tlpu-chips')) writeUrl(scopeNow());
      injectPostingFields();
    } finally { decorating = false; }
  }
  var pending = null;
  function schedule() {
    if (pending) return;
    pending = setTimeout(function () { pending = null; decorate(); }, 40);
  }
  function observe() {
    var app = document.getElementById('app');
    if (!app || app.__tlpuObserved) return;
    app.__tlpuObserved = true;
    new MutationObserver(schedule).observe(app, { childList: true, subtree: true });
    /* the posting modals live outside #app */
    new MutationObserver(function () { injectPostingFields(); }).observe(document.body, { childList: true });
    schedule();
  }

  /* ================================================================ *
   * 5. the job posting forms: last date + urgent hiring
   * ================================================================ */
  var FORM_ANCHORS = ['njStatus', 'ejStatus', 'twStatus', 'tiStatus', 'bulkEmpType'];
  function todayIst() { return istDay(Date.now()); }
  function injectPostingFields() {
    if (!(role() === 'recruiter' || role() === 'admin')) return;
    FORM_ANCHORS.forEach(function (aid) {
      var a = document.getElementById(aid);
      if (!a || document.getElementById('tlpuDeadline')) return;
      var row = a.closest('.fgroup, .fcr-jd-row') || a.parentNode;
      var grid = row.parentNode;
      var existing = null;
      if (aid === 'ejStatus' && STATE.editJobId) existing = jobOf(STATE.editJobId);
      var box = document.createElement('div');
      box.className = 'tlpu-dl';
      box.id = 'tlpuDeadline';
      box.style.gridColumn = '1 / -1';
      box.innerHTML = '<div class="row">'
        + '<div><label for="tlpuLastDate">Last date to apply</label><br>'
        + '<input type="date" id="tlpuLastDate" min="' + todayIst() + '" value="' + h(existing && existing.expiresAt ? istDay(existing.expiresAt) : '') + '">'
        + '<small>Applications close at the end of this day (IST).</small></div>'
        + '<label class="sw"><input type="checkbox" id="tlpuUrgent"' + (existing && urgent(existing) ? ' checked' : '') + '> 🔴 Urgent hiring'
        + '</label></div><small>Urgent jobs get a red badge, rank a little higher and alert matching candidates. It switches off by itself after 14 days.</small>';
      box.setAttribute('data-for', aid);
      if (row.nextSibling) grid.insertBefore(box, row.nextSibling); else grid.appendChild(box);
    });
  }
  function readPostingFields() {
    var box = document.getElementById('tlpuDeadline');
    if (!box) return null;
    var d = document.getElementById('tlpuLastDate');
    var u = document.getElementById('tlpuUrgent');
    return { lastDate: d ? String(d.value || '') : '', urgent: !!(u && u.checked), edit: box.getAttribute('data-for') === 'ejStatus' };
  }
  var lastSync = Object.create(null);
  function syncDeadline(jobId, v, tries) {
    if (!ready() || !jobId) return;
    tries = tries || 0;
    if (!tries) {
      var sig = JSON.stringify([v.lastDate, v.urgent]);
      var prevSig = lastSync[jobId];
      if (prevSig && prevSig.sig === sig && Date.now() - prevSig.at < 5000) return;
      lastSync[jobId] = { sig: sig, at: Date.now() };
    }
    api().put('/jobs/' + encodeURIComponent(jobId) + '/deadline', { lastDate: v.lastDate || null, urgent: !!v.urgent })
      .then(function (r) {
        var local = jobOf(jobId);
        if (local && r && r.job) {
          local.expiresAt = r.job.expiresAt;
          if (r.job.urgent) { local.urgent = true; local.urgentUntil = r.job.urgentUntil; }
          else { delete local.urgent; delete local.urgentUntil; }
          syncExpiry();
        }
        if (v.urgent) say('Urgent hiring is on for 14 days', '🔴');
        rerender();
      }, function (err) {
        /* The job itself is still on its way to the server. */
        if (err && (err.status === 404 || err.status === 403) && tries < 12) {
          setTimeout(function () { syncDeadline(jobId, v, tries + 1); }, 1500);
          return;
        }
        if (api() && api().say) api().say(err);
      });
  }
  var prevReg = window.fcrRegisterPosting;
  if (typeof prevReg === 'function') {
    window.fcrRegisterPosting = function (job) {
      var v = readPostingFields();
      var r = prevReg.apply(this, arguments);
      if (v && job && job.id && (v.lastDate || v.urgent || v.edit)) {
        setTimeout(function () { syncDeadline(job.id, v); }, 800);
      }
      return r;
    };
  }
  var prevSaveEdit = window.saveEditJob;
  if (typeof prevSaveEdit === 'function') {
    window.saveEditJob = function (jobId) {
      var v = readPostingFields();
      var r = prevSaveEdit.apply(this, arguments);
      if (v && jobId) setTimeout(function () { syncDeadline(jobId, v); }, 800);
      return r;
    };
  }

  /* ================================================================ *
   * the candidate's inbox: urgent hiring and the last date
   * ================================================================ */
  var MINE = { URGENT_HIRING: 1, DEADLINE_SOON: 1, DEADLINE_TODAY: 1 };
  function myAlerts() {
    var s = session();
    if (!s || s.role !== 'candidate' || !window.TL || !Array.isArray(TL.notifications)) return [];
    return TL.notifications.filter(function (n) { return n && MINE[n.type] && String(n.recipientId) === String(s.id); }).slice(0, 10);
  }
  var prevBell = window.candidateBellHtml;
  if (typeof prevBell === 'function') {
    window.candidateBellHtml = function () {
      var out = prevBell.apply(this, arguments);
      var list = myAlerts();
      if (!list.length || typeof out !== 'string') return out;
      var unread = list.filter(function (n) { return !n.read; }).length;
      var rows = list.map(function (n) {
        var md = n.metadata || {};
        return '<div class="notif-row tlpu-n ' + (n.read ? '' : 'unread') + '"><div class="notif-msg"><b>' + h(n.title) + '</b>'
          + h(md.jobTitle || '') + (md.company ? ' · ' + h(md.company) : '')
          + (md.matchPercent != null ? ' · <span class="tlpu-m">' + h(md.matchPercent) + '% match</span>' : '')
          + (md.line ? '<br><span style="color:#5b6676">' + h(md.line) + '</span>' : '') + '</div>'
          + '<div class="notif-meta"><span>' + h(String(n.createdAt || '').slice(0, 10)) + '</span>'
          + '<button class="ss-link" onclick="tlpuOpenAlert(\'' + h(n.id) + '\')">Apply now</button></div></div>';
      }).join('');
      out = out.replace(/(<div class="pm-head">)([^<]*)(<\/div>)/, function (all, a, b, c) { return a + b + c + rows; });
      if (unread) {
        if (/<span class="notif-badge">(\d+|9\+)<\/span>/.test(out)) {
          out = out.replace(/<span class="notif-badge">(\d+|9\+)<\/span>/, function (all, n) {
            var t = (n === '9+' ? 10 : Number(n)) + unread;
            return '<span class="notif-badge">' + (t > 9 ? '9+' : t) + '</span>';
          });
        } else {
          out = out.replace('🔔</button>', '🔔<span class="notif-badge">' + (unread > 9 ? '9+' : unread) + '</span></button>');
        }
      }
      return out;
    };
  }
  window.tlpuOpenAlert = function (id) {
    var n = (TL.notifications || []).filter(function (x) { return x.id === id; })[0];
    if (!n) return;
    if (!n.read && TL.markNotificationRead) TL.markNotificationRead(id);
    n.read = true;
    if (n.jobId) window.navigate('/job/' + n.jobId);
  };

  /* ================================================================ *
   * admin: the chip list
   * ================================================================ */
  try {
    /* NAV_CONFIG is a script-level const in index.html. */
    // eslint-disable-next-line no-undef
    if (typeof NAV_CONFIG !== 'undefined' && NAV_CONFIG.admin && !NAV_CONFIG.admin.some(function (x) { return x[0] === 'quick-filters'; })) {
      // eslint-disable-next-line no-undef
      NAV_CONFIG.admin.push(['quick-filters', 'Quick Filters', '🏷️']);
    }
  } catch (e) {}
  var ADMIN_CHIPS = null;
  function adminChipsHtml() {
    if (!ADMIN_CHIPS) {
      if (ready()) api().get('/quick-filters').then(function (r) { ADMIN_CHIPS = (r.all || r.chips || []).map(function (c) { return { key: c.key, label: c.label, enabled: c.enabled !== false }; }); rerender(); });
      return '<div class="panel"><div class="panel-body">Loading…</div></div>';
    }
    return '<div class="panel tlpu-qf-admin"><div class="panel-head"><h2>Quick filter chips</h2></div><div class="panel-body">'
      + '<p style="font-size:13px;color:#5b6676;margin:0 0 10px">The chips candidates see above the job results, in this order. Untick a chip to hide it.</p>'
      + ADMIN_CHIPS.map(function (c, i) {
        return '<div class="rowx"><input type="checkbox" ' + (c.enabled ? 'checked' : '') + ' onchange="tlpuQfSet(' + i + ',\'enabled\',this.checked)">'
          + '<input type="text" value="' + h(c.label) + '" maxlength="40" onchange="tlpuQfSet(' + i + ',\'label\',this.value)">'
          + '<code style="font-size:11px;color:#8a94a6">' + h(c.key) + '</code>'
          + '<button class="btn btn-ghost btn-sm" ' + (i === 0 ? 'disabled' : '') + ' onclick="tlpuQfMove(' + i + ',-1)">↑</button>'
          + '<button class="btn btn-ghost btn-sm" ' + (i === ADMIN_CHIPS.length - 1 ? 'disabled' : '') + ' onclick="tlpuQfMove(' + i + ',1)">↓</button></div>';
      }).join('')
      + '<button class="btn btn-primary" onclick="tlpuQfSave()">Save chips</button></div></div>';
  }
  window.tlpuQfSet = function (i, k, v) { if (ADMIN_CHIPS && ADMIN_CHIPS[i]) ADMIN_CHIPS[i][k] = v; };
  window.tlpuQfMove = function (i, d) {
    if (!ADMIN_CHIPS) return;
    var j = i + d;
    if (j < 0 || j >= ADMIN_CHIPS.length) return;
    var t = ADMIN_CHIPS[i]; ADMIN_CHIPS[i] = ADMIN_CHIPS[j]; ADMIN_CHIPS[j] = t;
    rerender();
  };
  window.tlpuQfSave = function () {
    api().put('/admin/quick-filters', { chips: ADMIN_CHIPS }).then(function (r) {
      ADMIN_CHIPS = r.chips; CHIPS = r.chips.filter(function (c) { return c.enabled; });
      say('Quick filters saved', '✓'); rerender();
    }, function (err) { api().say(err); });
  };
  var prevAdmin = window.pageAdminDash;
  if (typeof prevAdmin === 'function') {
    window.pageAdminDash = function (section) {
      if (section === 'quick-filters' && typeof window.dashShell === 'function') {
        return window.dashShell('admin', 'quick-filters', 'Quick Filters', 'Admin · Job portal', adminChipsHtml());
      }
      return prevAdmin.apply(this, arguments);
    };
  }

  /* ================================================================ *
   * boot
   * ================================================================ */
  var booted = false;
  (function waitReady(n) {
    if (ready()) {
      if (!booted) {
        booted = true;
        loadChips();
        syncExpiry();
        observe();
        setInterval(function () {
          if (isCandidate() && TL.refreshNotifications) TL.refreshNotifications();
        }, 120000);
      }
      return;
    }
    if (n < 240) setTimeout(function () { waitReady(n + 1); }, 250);
  })(0);
  window.addEventListener('hashchange', function () { readUrl(); schedule(); });
  /* A new session (sign in / out) changes whose match it is. */
  var lastWho = null;
  setInterval(function () {
    var who = session() ? session().role + ':' + session().id : '';
    if (who !== lastWho) { lastWho = who; MATCH = Object.create(null); MATCH_PENDING = Object.create(null); MATCH_SIG = ''; STATS = Object.create(null); syncExpiry(); schedule(); }
  }, 1000);
})();
