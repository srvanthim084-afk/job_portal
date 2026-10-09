/* =====================================================================
   TEAMLINK - the applied date, everywhere (0130)

   applications.applied_at is stored in UTC and nobody edits it. This file
   is how the browser shows it - always in IST, always DD MMM YYYY - and
   the small things that hang off it:

     CANDIDATE   "Applied ✓ · 09 Oct 2026" wherever a job they applied to
                 is shown (job cards, job page, Search / Recommended,
                 Saved Jobs, home rows) - the button is off, and Saved
                 Jobs' own Apply buttons learn it too;
                 "Applied on 09 Oct 2026" (time on hover) · "Applied 2 days
                 ago" on the Applications page, and the status timeline
                 Applied → Screening → Interview → Offer, each step with
                 the date it happened;
                 a count on "My Applications" in the profile menu and on
                 Applications in the phone's bottom bar.
     RECRUITER   a new application reaches an open recruiter screen by
                 itself (a light check every 20 s while the tab is in
                 view, then the normal refresh), with a notice
                 "<candidate> applied for <job> · Applied on <date, time>".

   The filters and the calendar are elsewhere (teamlink-date-range.js and
   the screens that use it). This file only reads.
   ===================================================================== */
(function () {
  'use strict';
  if (typeof window === 'undefined' || window.TLAppliedOn) return;

  var TZ = 'Asia/Kolkata';
  var IST_MS = 330 * 60000;
  function h(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function session() { return (typeof STATE !== 'undefined' && STATE.session) || null; }
  function role() { var s = session(); return s ? s.role : null; }
  function hash() { return String(location.hash || ''); }

  /* ------------------------------------------------------------------ *
   * IST formatting
   * ------------------------------------------------------------------ */
  function toMs(v) {
    if (v == null || v === '') return NaN;
    if (v instanceof Date) return v.getTime();
    if (typeof v === 'number') return v;
    var s = String(v);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return Date.parse(s + 'T12:00:00+05:30');   // a day, no time
    return /^\d{4}-\d{2}-\d{2}T/.test(s) ? Date.parse(s) : NaN;
  }
  /** "09 Oct 2026" */
  function date(v) {
    var t = toMs(v); if (!Number.isFinite(t)) return '';
    try { return new Date(t).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: TZ }); }
    catch (e) { return new Date(t + IST_MS).toISOString().slice(0, 10); }
  }
  /** "3:20 PM" - '' when only the day is known */
  function time(v) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(v || ''))) return '';
    var t = toMs(v); if (!Number.isFinite(t)) return '';
    try { return new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: TZ }); }
    catch (e) { return ''; }
  }
  /** "09 Oct 2026, 3:20 PM" (now, if the value is not a moment) */
  function dateTime(v) {
    var t = toMs(v); if (!Number.isFinite(t)) t = Date.now();
    var tm = time(t);
    return date(t) + (tm ? ', ' + tm : '');
  }
  function istDay(v) { var t = toMs(v); return Number.isFinite(t) ? new Date(t + IST_MS).toISOString().slice(0, 10) : ''; }
  /** "today" / "yesterday" / "2 days ago", counted in India days */
  function rel(v) {
    var d = istDay(v); if (!d) return '';
    var today = istDay(Date.now());
    var n = Math.round((Date.parse(today + 'T00:00:00Z') - Date.parse(d + 'T00:00:00Z')) / 86400000);
    if (n <= 0) return 'today';
    if (n === 1) return 'yesterday';
    if (n < 30) return n + ' days ago';
    var m = Math.round(n / 30);
    return n < 365 ? (m <= 1 ? 'a month ago' : m + ' months ago') : (Math.round(n / 365) <= 1 ? 'a year ago' : Math.round(n / 365) + ' years ago');
  }

  /** The application's own moment: the server's applied_at, else what is known. */
  function appliedIso(a) {
    if (!a) return '';
    if (/^\d{4}-\d{2}-\d{2}T/.test(String(a.appliedAt || ''))) return String(a.appliedAt);
    if (/^\d{4}-\d{2}-\d{2}T/.test(String(a.appliedTs || ''))) return String(a.appliedTs);
    if (/^\d{4}-\d{2}-\d{2}T/.test(String(a.appliedISO || ''))) return String(a.appliedISO);
    try { if (typeof window.appliedTsOf === 'function') { var ts = appliedTsOf(a); if (ts) return String(ts); } } catch (e) { /* fall through */ }
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(a.appliedOn || ''))) return String(a.appliedOn);
    try { if (typeof window.appliedOnOf === 'function') { var d = appliedOnOf(a); if (d) return String(d); } } catch (e) { /* none */ }
    return '';
  }

  /** "Applied on 09 Oct 2026" (time on hover) · "Applied 2 days ago" */
  function cardLine(a) {
    var at = appliedIso(a);
    if (!at) return '<span class="tlao-on">Applied</span>';
    var tm = time(at);
    return '<span class="tlao-on" title="' + h(tm ? 'Applied at ' + tm + ' IST' : 'Applied on ' + date(at)) + '">Applied on <b>' + h(date(at)) + '</b></span>'
      + ' · <span class="tlao-rel">Applied ' + h(rel(at)) + '</span>';
  }

  /* ------------------------------------------------------------------ *
   * the candidate's timeline: Applied → Screening → Interview → Offer
   * ------------------------------------------------------------------ */
  var PHASE_OF_STAGE = {
    applied: 'applied', registered: 'applied',
    ai_screening: 'screening', shortlisted: 'screening', with_bde: 'screening', client_review: 'screening',
    interview_scheduled: 'interview', ai_interview_pending: 'interview', ai_interview_in_progress: 'interview',
    ai_interview_done: 'interview', ai_evaluation_done: 'interview', client_interview: 'interview',
    attended: 'interview', interviewed: 'interview',
    offer_extended: 'offer', selected: 'offer', joined: 'offer',
    rejected: 'rejected', no_show: 'rejected', hold: 'hold',
  };
  var SERVER_PHASE = { applied: 'applied', under_review: 'screening', shortlisted: 'screening', interview: 'interview', offer: 'offer', hired: 'offer', rejected: 'rejected', hold: 'hold' };
  var LINE = [['applied', 'Applied'], ['screening', 'Screening'], ['interview', 'Interview'], ['offer', 'Offer']];

  var TLC = { rows: Object.create(null), at: 0, busy: false, sig: '' };   // the timeline cache
  function loadTimeline() {
    if (role() !== 'candidate' || TLC.busy || !(window.TL && TL_api())) return;
    var mine = myApps();
    var sig = mine.map(function (a) { return a.id + ':' + a.stage; }).join('|');
    if (TLC.at && Date.now() - TLC.at < 20000 && sig === TLC.sig) return;
    TLC.busy = true;
    TL_api().get('/candidate/applications/history?page=1&pageSize=50').then(function (r) {
      TLC.rows = Object.create(null);
      ((r && r.rows) || []).forEach(function (x) { TLC.rows[x.applicationId] = x; TLC.rows['job:' + x.jobId] = x; });
      TLC.at = Date.now(); TLC.sig = sig; TLC.busy = false;
      refreshTimelines();
    }, function () { TLC.at = Date.now(); TLC.sig = sig; TLC.busy = false; });
  }
  function TL_api() { return window.TL && window.TL.api; }

  function timeline(a) {
    if (!a) return '';
    var row = TLC.rows[a.id] || TLC.rows['job:' + a.jobId] || null;
    var phase = row ? (SERVER_PHASE[row.phase] || 'screening') : (PHASE_OF_STAGE[a.stage] || 'screening');
    var at = {};
    var applied = appliedIso(a) || (row && row.appliedAt) || '';
    at.applied = applied;
    if (row) {
      (row.steps || []).forEach(function (s) {
        var p = SERVER_PHASE[s.phase]; if (!p || !s.at || p === 'applied') return;
        if (!at[p] || s.at < at[p]) at[p] = s.at;
      });
    }
    var off = phase === 'rejected' || phase === 'hold';
    var here = LINE.map(function (x) { return x[0]; }).indexOf(phase);
    if (off) { here = 0; LINE.forEach(function (x, i) { if (at[x[0]]) here = i; }); }
    var steps = LINE.map(function (x, i) {
      var cls = (!off && i === here) ? 'now' : (i < here || (off && i === here) || (at[x[0]] && i <= here)) ? 'done' : 'todo';
      var when = '';
      if (at[x[0]]) {
        var full = dateTime(at[x[0]]);
        when = x[0] === 'applied'
          ? '<span class="w" title="' + h(full + ' IST') + '">' + h(full) + '</span>'
          : '<span class="w" title="' + h(full + ' IST') + '">' + h(date(at[x[0]])) + '</span>';
      }
      return '<li class="' + cls + '" data-phase="' + x[0] + '"><span class="d" aria-hidden="true"></span><span class="l">' + x[1] + '</span>' + when + '</li>';
    }).join('');
    var banner = '';
    if (phase === 'rejected') {
      var r = row && row.offLine && row.offLine.at;
      banner = '<div class="tlao-off stop">Not moving forward' + (r ? ' · ' + h(date(r)) : '') + '</div>';
    } else if (phase === 'hold') {
      var hd = row && row.offLine && row.offLine.at;
      banner = '<div class="tlao-off pause">On hold' + (hd ? ' since ' + h(date(hd)) : '') + ' - a pause, not a rejection</div>';
    }
    return '<div class="tlao-tl" data-app="' + h(a.id) + '" data-job="' + h(a.jobId) + '"><ol aria-label="Application status">' + steps + '</ol>' + banner + '</div>';
  }
  function refreshTimelines() {
    Array.prototype.forEach.call(document.querySelectorAll('.tlao-tl[data-app]'), function (el) {
      var id = el.getAttribute('data-app');
      var a = (window.DATA && DATA.applications || []).filter(function (x) { return x.id === id; })[0];
      if (!a) return;
      var html = timeline(a);
      if (el.outerHTML !== html) el.outerHTML = html;
    });
  }

  /* ------------------------------------------------------------------ *
   * the candidate's buttons and badges
   * ------------------------------------------------------------------ */
  function myApps() {
    var s = session(); if (!s || s.role !== 'candidate') return [];
    return ((window.DATA && DATA.applications) || []).filter(function (a) { return a.candidateId === s.id; });
  }
  function appliedMap() {
    var m = Object.create(null);
    myApps().forEach(function (a) { if (a.jobId && !m[a.jobId]) m[a.jobId] = a; });
    return m;
  }
  var APPLY_RX = /\b(applyToJob|easyApply|cpEasyApply|capApply|rjApplyJob|capApplyConfirm|cpEasyApplyGo)\s*\(\s*['"]([^'"]+)['"]/;
  var ID_RX = /(?:toggleSaveJob|tlJdModal|cpEasyApply|rjApplyJob|capApply|applyToJob|easyApply|cpWhy|unhideJob|hideJob)\s*\(\s*['"]([^'"]+)['"]|navigate\(\s*['"]\/job\/([^'"]+)['"]/;
  /** The job a button belongs to: its own onclick, a sibling's, or the page. */
  function jobIdNear(b) {
    var own = APPLY_RX.exec(b.getAttribute('onclick') || '');
    if (own) return own[2];
    var el = b.parentElement;
    for (var depth = 0; el && depth < 4; depth++, el = el.parentElement) {
      var nodes = el.querySelectorAll('[onclick]');
      for (var i = 0; i < nodes.length; i++) {
        var m = ID_RX.exec(nodes[i].getAttribute('onclick') || '');
        if (m) return m[1] || m[2];
      }
    }
    var page = /^#\/job\/([^/?#]+)/.exec(hash());
    return page ? decodeURIComponent(page[1]) : '';
  }
  var DONE_TXT = /^(✓\s*Applied|Applied ✓|✓ Application submitted|✓ Already applied)$/;
  function paintCandidate() {
    if (role() !== 'candidate') return;
    var map = appliedMap();
    /* 1. an Apply button for a job already applied to (Saved Jobs, home
          rows, "why this match"): off, and says so. Never one that is
          applying right now. */
    Array.prototype.forEach.call(document.querySelectorAll('#app button[onclick]'), function (b) {
      if (b.getAttribute('aria-busy') === 'true' || b.disabled) return;
      var m = APPLY_RX.exec(b.getAttribute('onclick') || '');
      if (!m || /^xjob_/.test(m[2]) || !map[m[2]]) return;
      if (/(save|description|view|why)/i.test(b.textContent || '')) return;
      b.disabled = true;
      b.textContent = 'Applied ✓';
      b.classList.add('tl1c-applied');
    });
    /* 2. every applied button carries the date: "Applied ✓ · 09 Oct 2026" */
    Array.prototype.forEach.call(document.querySelectorAll('#app button[disabled], #app .badge, #fcrModalHost button[disabled]'), function (b) {
      var t = (b.textContent || '').replace(/\s+/g, ' ').trim();
      if (!DONE_TXT.test(t)) return;
      var id = b.getAttribute('data-tlao-job') || jobIdNear(b);
      var a = id && map[id];
      if (!a) return;
      var at = appliedIso(a);
      var d = date(at);
      if (!d) return;
      if (b.getAttribute('data-applied-on') !== d) {
        b.setAttribute('data-applied-on', d);
        b.setAttribute('data-tlao-job', id);
        b.classList.add('tlao-dated');
        var tm = time(at);
        b.setAttribute('title', 'Applied on ' + d + (tm ? ', ' + tm + ' IST' : ''));
        if (b.tagName === 'BUTTON') b.setAttribute('aria-label', 'Applied on ' + d);
      }
    });
    /* 3. the count on "My Applications" and on the bottom bar */
    var n = myApps().length;
    Array.prototype.forEach.call(document.querySelectorAll('.cp-menu button[onclick*="#/candidate/applications"], .cp-bottom button[onclick*="#/candidate/applications"], .nk-drawer [onclick*="#/candidate/applications"]'), function (b) {
      var badge = b.querySelector('.tlao-badge');
      if (!n) { if (badge) badge.remove(); return; }
      if (!badge) { badge = document.createElement('span'); badge.className = 'tlao-badge'; b.appendChild(badge); }
      if (badge.textContent !== String(n)) badge.textContent = String(n);
      badge.setAttribute('aria-label', n + ' application' + (n === 1 ? '' : 's'));
    });
    if (/^#\/candidate\/applications/.test(hash())) loadTimeline();
  }

  /* ------------------------------------------------------------------ *
   * the recruiter's screen hears about new applications
   * ------------------------------------------------------------------ */
  var LIVE = { base: '', busy: false, last: 0 };
  var STAFF_RX = /^#\/(recruiter|bde|admin)\b/;
  function checkNew() {
    var r = role();
    if (!(r === 'recruiter' || r === 'admin' || r === 'bde') || !STAFF_RX.test(hash())) return;
    if (document.hidden || LIVE.busy || !TL_api() || Date.now() - LIVE.last < 15000) return;
    LIVE.busy = true; LIVE.last = Date.now();
    TL_api().get('/applications?limit=1').then(function (res) {
      LIVE.busy = false;
      var top = res && res.applications && res.applications[0];
      var sig = (res && res.total) + ':' + (top ? top.id : '');
      if (sig === LIVE.base) return;
      LIVE.base = sig;
      /* The newest one the server has, and this screen does not: reload. */
      var known = !top || (DATA.applications || []).some(function (a) { return a.id === top.id; });
      if (known || !(window.TL && typeof TL.refresh === 'function')) return;
      Promise.resolve(TL.refresh()).then(function () {
        var a = top && (DATA.applications || []).filter(function (x) { return x.id === top.id; })[0];
        var c = a && DATA.candidateById ? DATA.candidateById(a.candidateId) : null;
        var j = a && DATA.jobById ? DATA.jobById(a.jobId) : null;
        if (a && c && j && typeof window.toast === 'function') {
          toast((c.name || 'A candidate') + ' applied for ' + (j.title || 'a job') + ' · Applied on ' + dateTime(appliedIso(a)), '👥');
        }
      });
    }, function () { LIVE.busy = false; });
  }

  /* ------------------------------------------------------------------ *
   * styles
   * ------------------------------------------------------------------ */
  function css() {
    if (document.getElementById('tlaoCss')) return;
    var s = document.createElement('style');
    s.id = 'tlaoCss';
    s.textContent = ''
      + '.tlao-dated::after{content:" · " attr(data-applied-on);font-weight:600;white-space:nowrap}'
      + '.tlao-badge{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 5px;margin-left:6px;border-radius:999px;background:var(--brand-600,#17695e);color:#fff;font-size:11px;font-weight:800;font-style:normal;line-height:1;vertical-align:middle}'
      + '.cp-bottom button{position:relative}'
      + '.cp-bottom .tlao-badge{position:absolute;top:2px;left:calc(50% + 6px);margin:0}'
      + '.tlao-on b{font-weight:700;color:#26313f}.tlao-on[title]{cursor:help}'
      + '.tlao-tl{margin-top:10px;width:100%;max-width:560px;min-width:260px}.cp-track .tlao-tl{flex:1 1 100%;margin-top:2px}'
      + '.tlao-tl ol{list-style:none;margin:0;padding:0;display:flex;gap:0}'
      + '.tlao-tl li{flex:1;min-width:0;position:relative;padding-top:18px;font-size:12px;color:#7b8794;text-align:center}'
      + '.tlao-tl li .d{position:absolute;top:2px;left:50%;width:12px;height:12px;margin-left:-6px;border-radius:50%;background:#d6dee8;z-index:1}'
      + '.tlao-tl li:before{content:"";position:absolute;top:7px;left:-50%;width:100%;height:2px;background:#d6dee8}'
      + '.tlao-tl li:first-child:before{display:none}'
      + '.tlao-tl li.done .d,.tlao-tl li.now .d{background:var(--brand-600,#17695e)}'
      + '.tlao-tl li.done:before,.tlao-tl li.now:before{background:var(--brand-600,#17695e)}'
      + '.tlao-tl li.now .d{box-shadow:0 0 0 4px rgba(23,105,94,.18)}'
      + '.tlao-tl li.done .l,.tlao-tl li.now .l{color:#16202c;font-weight:700}'
      + '.tlao-tl .l{display:block}.tlao-tl .w{display:block;font-size:11px;color:#5b6e84;margin-top:1px}'
      + '.tlao-off{margin-top:8px;font-size:12px;font-weight:700;padding:6px 10px;border-radius:8px}'
      + '.tlao-off.stop{background:#fdecea;color:#a1271d}.tlao-off.pause{background:#fff6e0;color:#8a5a00}'
      + '@media (max-width:520px){.tlao-tl .w{font-size:10px}.tlao-tl li{font-size:11px}}'
      /* the recruiter's filter bar: the calendar field, the chips, the count, the sortable column */
      + '.tp-date .tldr-field{width:100%}.tp-date .tldr-btn{min-height:34px}.tp-date-chips{margin:8px 0 0}'
      + '.tlaf .tlaf-date .tldr-field{width:100%}.tlaf .tlaf-date .tldr-btn{min-height:34px}'
      + '.tlaf .hd .n.tlaf-count{text-transform:none;letter-spacing:0}.tlaf .hd .n.tlaf-count b{font-size:12.5px}'
      + '.tlaf .row .fld.tlaf-date{flex:0 1 250px}'
      + '.tlaf-chips,.tlao-chips{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:10px}'
      + '.tlaf-chip,.tlao-chip{display:inline-flex;align-items:center;gap:4px;padding:4px 4px 4px 10px;border-radius:999px;background:var(--brand-100,#e8f1fe);color:var(--text,#16202c);font-size:12px;font-weight:600}'
      + '.tlaf-chip button,.tlao-chip button{width:22px;height:22px;border:0;border-radius:50%;background:transparent;cursor:pointer;font-size:11px;color:inherit}'
      + '.tlaf-chip button:hover,.tlao-chip button:hover{background:rgba(0,0,0,.08)}'
      + '.tlaf-clearall,.tlao-clearall{border:0;background:transparent;color:var(--brand-600,#1d6ff2);font-weight:700;font-size:12px;cursor:pointer;padding:4px 6px;text-decoration:underline}'
      + 'th.tl-sortable{cursor:pointer;user-select:none;white-space:nowrap}th.tl-sortable:hover{color:var(--brand-600,#1d6ff2)}'
      + '.tl-sort-ar{font-size:9px;margin-left:3px}';
    document.head.appendChild(s);
  }

  /* ------------------------------------------------------------------ *
   * wiring: after every repaint, and a slow clock for the recruiter
   * ------------------------------------------------------------------ */
  var queued = false;
  function paintSoon() {
    if (queued) return;
    queued = true;
    setTimeout(function () { queued = false; try { css(); paintCandidate(); } catch (e) { /* cosmetic */ } }, 40);
  }
  function start() {
    css();
    try { new MutationObserver(paintSoon).observe(document.body, { childList: true, subtree: true }); }
    catch (e) { /* the clock covers it */ }
    window.addEventListener('hashchange', paintSoon);
    setInterval(function () { try { checkNew(); } catch (e) { /* next time */ } }, 5000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) { LIVE.last = 0; try { checkNew(); } catch (e) { /* later */ } } });
    paintSoon();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();

  window.TLAppliedOn = {
    version: '0130', date: date, time: time, dateTime: dateTime, rel: rel, istDay: istDay,
    appliedIso: appliedIso, cardLine: cardLine, timeline: timeline, paint: paintSoon, checkNew: checkNew,
  };
})();
