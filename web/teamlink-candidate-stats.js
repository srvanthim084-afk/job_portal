/* =====================================================================
   TEAMLINK - registered candidates count (0125)

   WHAT IT IS. "Total Registered Candidates", with "New this week" and
   "Active jobs" beside it, at the top of Admin -> Availability (drawn by
   teamlink-availability.js with cards() below - no longer on the candidate
   dashboard, at the owner's request); and "X+ candidates registered" under
   the job portal's "Find your next role".

   WHERE THE NUMBERS COME FROM. GET /api/public/candidate-stats - three
   integers counted in the database (candidates with an active portal
   account, the ones created since Monday India time, and the jobs the
   Jobs page lists). Nothing about any candidate comes with them.

   STAYING CURRENT. Read when one of these pages is drawn (at most every
   15 seconds) and every 60 seconds while one is open, then painted in
   place, so a new registration shows without a reload.
   ===================================================================== */
(function () {
  'use strict';
  if (window.TLCandidateStats) return;

  var S = { data: null, at: 0, loading: false };
  var KEYS = ['registeredCandidates', 'newThisWeek', 'activeJobs'];

  function fmt(n) { return Number(n || 0).toLocaleString('en-IN'); }
  function val(k) { return S.data ? fmt(S.data[k]) : '…'; }
  function slot(k, suffix) {
    return '<span data-tlcs="' + k + '"' + (suffix ? ' data-tlcs-suffix="' + suffix + '"' : '') + '>' + val(k) + (S.data && suffix ? suffix : '') + '</span>';
  }

  function paint() {
    if (!S.data) return;
    var els = document.querySelectorAll('[data-tlcs]');
    for (var i = 0; i < els.length; i++) {
      var k = els[i].getAttribute('data-tlcs');
      if (KEYS.indexOf(k) < 0) continue;
      /* only a real change is written, so the observer below settles */
      var text = fmt(S.data[k]) + (els[i].getAttribute('data-tlcs-suffix') || '');
      if (els[i].textContent !== text) els[i].textContent = text;
    }
    var line = document.querySelectorAll('[data-tlcs-line]');
    for (var j = 0; j < line.length; j++) {
      var hide = !S.data.registeredCandidates;
      if (line[j].hidden !== hide) line[j].hidden = hide;
    }
  }
  function load(force) {
    if (S.loading || (!force && Date.now() - S.at < 15000)) { paint(); return; }
    S.loading = true;
    var base = (window.TL && TL.apiBase) || '/api';
    fetch(base + '/public/candidate-stats', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d) { S.data = d; S.at = Date.now(); } S.loading = false; paint(); },
            function () { S.loading = false; });
  }
  function soon() { setTimeout(function () { load(false); }, 0); }

  /* ---- the cards (Admin -> Availability) ----------------------------------- */
  function cards() {
    var tile = function (label, k) {
      return '<div class="stat-tile"><div class="lbl">' + label + '</div><div class="val tabular">' + slot(k) + '</div></div>';
    };
    return '<div class="stat-row tlcs-row" style="grid-template-columns:repeat(3,minmax(0,1fr));margin:0 0 14px">'
      + tile('Total Registered Candidates', 'registeredCandidates')
      + tile('New this week', 'newThisWeek')
      + tile('Active jobs', 'activeJobs')
      + '</div>';
  }
  /* ---- the line under "Find your next role" -------------------------------- */
  function line() {
    /* hidden until the number is known, and while it is zero */
    return '<span data-tlcs-line' + (!S.data || !S.data.registeredCandidates ? ' hidden' : '') + '> · '
      + '<b>' + slot('registeredCandidates', '+') + '</b> candidates registered</span>';
  }

  function install() {
    var done = true;
    /* The three cards are no longer added to the candidate's dashboard (cpHome): they are on
       Admin -> Availability. */
    if (typeof window.jobsPageBody === 'function' && !window.jobsPageBody.__tlcs) {
      var prevBody = window.jobsPageBody;
      var body = function () {
        var html = prevBody.apply(this, arguments);
        var mark = 'powered by TeamLink AI ranking';
        var at = typeof html === 'string' ? html.indexOf(mark) : -1;
        if (at < 0) return html;
        var end = html.indexOf('</p>', at);
        if (end < 0) return html;
        soon();
        return html.slice(0, end) + line() + html.slice(end);
      };
      body.__tlcs = true; window.jobsPageBody = body;
    } else if (typeof window.jobsPageBody !== 'function') done = false;
    return done;
  }

  window.TLCandidateStats = { load: load, state: S, cards: cards };

  install();
  /* Other modules wrap cpHome after this file is parsed; stay outermost. */
  var tries = 0;
  var t = setInterval(function () {
    if (window.jobsPageBody && !window.jobsPageBody.__tlcs) install();
    if (++tries > 60) clearInterval(t);
  }, 500);

  setInterval(function () {
    if (document.hidden) return;
    if (document.querySelector('[data-tlcs]')) load(true);
  }, 60000);

  /* A page drawn from HTML built before the numbers arrived (some screens
     render twice) still says "…": paint whatever new placeholder appears. */
  var queued = false;
  try {
    new MutationObserver(function () {
      if (queued || !S.data) return;
      queued = true;
      setTimeout(function () { queued = false; if (document.querySelector('[data-tlcs]')) paint(); }, 50);
    }).observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) { /* the poll above still paints */ }
})();
