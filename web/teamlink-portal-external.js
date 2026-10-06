/*
 * TeamLink — external jobs: their details page, Apply Now and saved list.
 *
 * JOB SOURCE SEPARATION (owner, 2026-10-05; migration 0113). The Jobs page
 * (#/candidate/search, #/candidate/recommended, the public board #/jobs)
 * lists TeamLink jobs ONLY - the server answers it from TeamLink's jobs and
 * nothing here adds to it. External jobs are on the External Jobs page
 * (#/candidate/external-jobs, teamlink-external-jobs.js) ONLY. What this
 * file still does, for external jobs and nowhere else:
 *
 *   - #/job/xjob_<id> opens an external job's own details page, marked
 *     External, whose "See other jobs" goes back to External Jobs;
 *   - Apply Now (below), from that page and from External Jobs;
 *   - the candidate's saved external jobs, in their own section of Saved Jobs.
 *
 * (Until 0113 this file also put external cards into the Jobs page's list,
 * a Source filter into its rail and a count into the public board. Those
 * are gone: the two datasets are never mixed.)
 *
 * APPLY NOW (the owner's final rule, 2026-10-05) opens the stored ORIGINAL
 * job URL directly in a new tab (noopener) - no TeamLink page in between,
 * never a TeamLink URL in its place, never the TeamLink application form.
 * The server hands the page that URL only after the one link rule
 * (api/src/external/link.js: https, a public host, an approved domain for
 * the source); otherwise the card says "Application link unavailable", and
 * a closed posting says "Job no longer available". The click is recorded as
 * "Apply Clicked" - against the candidate when signed in, as a bare count
 * otherwise - and never as an application.
 *
 * 0115: before the tab is pointed anywhere, the server is asked whether the
 * posting still exists at its source (GET .../:id/availability). One that
 * was taken down says "Job no longer available" and the tab opened for it
 * is closed - the candidate never lands on the employer's 404.
 *
 * TeamLink jobs are untouched: their cards, Apply button and application
 * flow are exactly what they were.
 */
(function () {
  'use strict';

  var X = { jobs: null, byId: {}, loading: null, at: 0, off: false,
    /* 0108: the saved set. */
    saved: null, savedRows: null, savedFor: null };
  var h = function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  };
  var js = function (v) { return String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); };
  var rerender = function () { if (typeof window.render === 'function') render(); };
  var isCand = function () { return !!(window.STATE && STATE.session && STATE.session.role === 'candidate'); };

  /* ------------------------------------------------------------------ *
   * the data - from TeamLink's own API, never from the sources directly
   * ------------------------------------------------------------------ */
  function load(force) {
    if (X.off) return Promise.resolve([]);
    if (X.loading) return X.loading;
    if (!force && X.jobs && Date.now() - X.at < 10 * 60 * 1000) return Promise.resolve(X.jobs);
    X.loading = fetch('/api/portal/external-jobs?limit=500', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) {
        if (r.status === 404) { X.off = true; return { jobs: [] }; }   // the feature is switched off
        return r.json();
      })
      .then(function (out) {
        /* 0113, the secondary guard: never a TeamLink job in the external list. */
        X.jobs = ((out && out.jobs) || []).filter(function (j) { return j && j.sourceType !== 'TEAMLINK'; });
        X.jobs.forEach(function (j) { X.byId[j.id] = j; });
        X.at = Date.now(); X.loading = null;
        rerender();
        return X.jobs;
      })
      .catch(function () { X.loading = null; X.jobs = X.jobs || []; return X.jobs; });
    return X.loading;
  }

  function one(id) {
    if (X.byId[id] && X.byId[id].__full) return Promise.resolve(X.byId[id]);
    return fetch('/api/portal/external-jobs/' + encodeURIComponent(id), { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : { job: null, missing: r.status }; })
      .then(function (out) {
        if (out.job) { out.job.__full = true; X.byId[id] = out.job; }
        else X.byId[id] = { id: id, missing: true };
        rerender();
        return X.byId[id];
      });
  }

  /* ------------------------------------------------------------------ *
   * drawing - the portal's own card styles, one small label added
   * ------------------------------------------------------------------ */
  /* Where the candidate will actually land: the board the advert lives on
     when the source names it (a publisher), else the source itself. */
  var siteOf = function (j) { return (j && (j.publisher || j.sourceName || j.source)) || 'the employer’s website'; };
  var label = function (j) {
    return '<span title="Applied for on the original website" style="display:inline-block;font-size:11px;font-weight:800;'
      + 'color:#4a3aa8;background:#f1eefe;border-radius:10px;padding:2px 8px;white-space:nowrap">'
      + 'Source: ' + h(j.jobSourceName || j.sourceName || j.source) + '<span class="tlpx-sr"> (external job)</span></span>';
  };
  /* Which Apply this card may offer. */
  var linkState = function (j) {
    if (!j || j.missing || (j.status && j.status !== 'ACTIVE') || j.applyLink === 'job_unavailable') return 'gone';
    return j.originalJobUrl ? 'ok' : 'nolink';
  };
  /* Apply Now - or, with no button, why there is none. */
  function applyControl(j, cls, stop) {
    var st = linkState(j);
    if (st === 'gone') return '<span class="tlpx-na" role="status">Job no longer available</span>';
    if (st === 'nolink') return '<span class="tlpx-na" role="status">Application link unavailable</span>';
    return '<button type="button" class="' + cls + '" aria-label="' + h(applyLabel(j)) + '" onclick="'
      + (stop ? 'event.stopPropagation();' : '') + 'tlpxApply(\'' + js(j.id) + '\')">Apply Now <span aria-hidden="true">↗</span></button>';
  }
  /* The Apply button says, to a screen reader as well, that it leaves
     TeamLink and opens another site. */
  var applyLabel = function (j) {
    return 'Apply Now on ' + siteOf(j) + ' (opens the original job website in a new tab)';
  };
  /* ---- the job details page ---- */
  var when = function (iso) {
    var t = Date.parse(iso || '');
    if (isNaN(t)) return '';
    var d = Math.floor((Date.now() - t) / 86400000);
    return d <= 0 ? 'today' : d === 1 ? 'yesterday' : d + ' days ago';
  };
  function detailHtml(j) {
    if (j.missing || j.status !== 'ACTIVE') {
      var gone = j.status === 'UNAVAILABLE' ? 'Source unavailable' : 'This job is no longer available.';
      return '<section class="block" style="padding-top:40px"><div class="wrap"><div class="panel"><div class="panel-body" style="text-align:center;padding:40px 22px">'
        + '<div style="font-size:30px" aria-hidden="true">🔒</div><h1 style="font-size:19px;margin-top:10px">' + h(gone) + '</h1>'
        + (j.title ? '<p style="color:#5b6676;margin-top:6px">' + h(j.title) + (j.company ? ' · ' + h(j.company) : '') + '</p>' : '')
        + (j.status === 'UNAVAILABLE' ? '<p style="color:#5b6676;margin-top:4px">This job is no longer available.</p>' : '')
        + (isCand() && X.saved && X.saved[j.id] ? '<p style="color:#5b6676;margin-top:4px">It stays in your Saved Jobs until you remove it.</p>' : '')
        + '<button type="button" class="btn btn-primary" style="margin-top:14px" onclick="navigate(\'' + (isCand() ? '/candidate/external-jobs' : '/jobs') + '\')">See other jobs</button>'
        + '</div></div></div></section>';
    }
    var row = function (k, v) { return v ? '<dt class="k">' + h(k) + '</dt><dd class="v" style="margin:0">' + h(v) + '</dd>' : ''; };
    var postedOn = j.postedAt ? new Date(j.postedAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
    var seen = j.lastSeenAt || j.lastSyncedAt;
    var fresh = j.freshness || {};
    return '<section class="block" style="padding-top:28px"><div class="wrap" style="max-width:920px">'
      + '<button type="button" class="btn btn-ghost btn-sm" onclick="history.back()">← Back</button>'
      + '<article class="panel" style="margin-top:12px" aria-labelledby="tlpxTitle"><div class="panel-body">'
      + '<div style="display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap">'
      + '<div style="flex:1;min-width:240px"><h1 id="tlpxTitle" style="font-size:22px;margin:0">' + h(j.title) + '</h1>'
      + '<div style="color:#42505f;margin-top:4px">' + h(j.company || '—') + ' · ' + h(j.location || '—') + '</div>'
      + '<div style="margin-top:8px">' + label(j) + '</div></div>'
      + '<div style="text-align:right">' + applyControl(j, 'btn btn-primary')
      + (isCand() ? '<div style="margin-top:6px">' + saveButton(j, 'btn btn-ghost btn-sm') + '</div>' : '')
      + (linkState(j) === 'ok' ? '<div style="font-size:12px;color:#5b6676;margin-top:6px;max-width:240px">Apply Now opens ' + h(siteOf(j)) + ' in a new tab. You apply there; TeamLink does not submit the application for you.</div>' : '') + '</div>'
      + '</div>'
      + '<dl class="cap-kv" style="margin:16px 0 0;display:grid;grid-template-columns:160px 1fr;gap:6px 14px;font-size:13.5px">'
      + row('Source', siteOf(j) === (j.sourceName || j.source) ? (j.sourceName || j.source) : siteOf(j) + ' (via ' + (j.sourceName || j.source) + ')')
      + row('Job type', 'External')
      + row('Experience', j.experience) + row('Salary', j.salary) + row('Employment type', j.employmentType)
      + row('Qualifications', j.education) + row('Posted', postedOn)
      + row('Last checked', seen ? 'on the source ' + when(seen) : '')
      + '</dl>'
      + (fresh.stale ? '<p role="note" style="margin-top:10px;font-size:12.5px;color:#7a4b00;background:#fff6e5;border-radius:8px;padding:8px 10px">'
        + 'This posting has not been seen on ' + h(j.sourceName || j.source) + ' for ' + h(fresh.checkedDaysAgo) + ' days. It may have closed.</p>' : '')
      + ((j.skills || []).length ? '<div style="margin-top:14px"><h2 style="font-size:13px;margin:0">Skills</h2><ul style="list-style:none;padding:0;margin:6px 0 0;display:flex;flex-wrap:wrap;gap:6px">'
        + j.skills.map(function (s) { return '<li class="badge">' + h(s) + '</li>'; }).join('') + '</ul></div>' : '')
      + (j.description ? '<div style="margin-top:16px"><h2 style="font-size:13px;margin:0">Description</h2>'
        + '<div style="margin-top:6px;font-size:13.5px;line-height:1.65;color:#26313f;white-space:pre-wrap">' + h(j.description) + '</div></div>' : '')
      + '</div></article></div></section>';
  }

  /* The header is chosen where every page's is (index.html
     tlCandidateChrome): a signed-in candidate gets the candidate shell with
     External Jobs lit; anyone else gets this page exactly as before. */
  function chrome(html) {
    var c = typeof window.tlCandidateChrome === 'function' ? window.tlCandidateChrome(html) : null;
    return c === null ? html : c;
  }
  function wrapDetail() {
    var prev = window.pageJobDetail;
    if (typeof prev !== 'function' || prev.__tlpx) return;
    var next = function (id) {
      if (!/^xjob_/.test(String(id || ''))) return prev.apply(this, arguments);
      var j = X.byId[id];
      if (!j || (!j.__full && !j.missing)) {
        one(id);
        if (!j) return chrome('<section class="block" style="padding-top:48px"><div class="wrap"><div class="panel"><div class="panel-body" style="text-align:center;padding:40px">Loading the job…</div></div></div></section>');
      }
      if (j && j.title && !j.missing) {
        try { document.title = j.title + (j.company ? ' at ' + j.company : '') + ' · External job via ' + (j.sourceName || j.source) + ' · TeamLink'; } catch (e) { /* ignore */ }
      }
      return chrome(detailHtml(j));
    };
    next.__tlpx = true;
    window.pageJobDetail = next;
  }

  /* ---- Apply Now: straight to the stored original URL ----------------- */
  var api = function () { return window.TL && window.TL.api; };
  function record(id) {
    /* "Apply Clicked": against the candidate (POST /external/apply - an
       external_applications row, never an `applications` one), or a bare
       count for a visitor. Fire and forget: the tab is already open. */
    try {
      if (isCand() && api()) {
        /* The candidate's own "Did you apply?" may follow later (the
           External Jobs page asks for clicks still unanswered) - their
           report, labelled as theirs; the click itself is only a click. */
        api().post('/external/apply', { externalJobId: id })
          .then(null, function () { /* the click stands; the record is best effort */ });
      } else {
        fetch('/api/portal/external-jobs/' + encodeURIComponent(id) + '/click',
          { method: 'POST', credentials: 'same-origin', keepalive: true }).catch(function () {});
      }
    } catch (e) { /* ignore */ }
  }
  function openUrl(url) {
    var win = null;
    try { win = window.open(url, '_blank', 'noopener,noreferrer'); } catch (e) { win = null; }
    /* noopener returns null in most browsers even when the tab opened; a
       real block is rare here because this runs inside the click. */
    return win;
  }
  /*
   * 0115: IS IT STILL THERE? Apply Now first asks TeamLink, which asks the
   * posting's own source (Greenhouse/Lever's public job endpoint, or a
   * bounded HEAD of the job's URL). A posting taken down at its source is
   * closed there and then, and the candidate is told "Job no longer
   * available" here instead of landing on the employer's 404. When the
   * check cannot reach the source the original URL opens exactly as before.
   *
   * The tab is opened INSIDE the click (so no pop-up blocker objects),
   * blank, with no opener, and only pointed at the original URL once the
   * answer is "available"; otherwise it is closed and the message is shown
   * in the page.
   */
  var say = function (msg, icon) { if (typeof window.toast === 'function') toast(msg, icon || 'ℹ️'); };
  function availability(id) {
    return fetch('/api/portal/external-jobs/' + encodeURIComponent(id) + '/availability',
      { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (b) { b.__http = r.status; return b; }); });
  }
  /* The job turned out to be gone: this page stops offering it. */
  function markGone(id, applyLink, message) {
    var j = X.byId[id] || (X.byId[id] = { id: id });
    j.applyLink = applyLink;
    if (applyLink === 'job_unavailable') { j.status = 'CLOSED'; j.externalStatus = 'Expired'; }
    j.originalJobUrl = null;
    if (X.jobs) X.jobs = X.jobs.filter(function (x) { return x.id !== id || applyLink !== 'job_unavailable'; });
    /* Every Apply control for this job on the page, replaced where it
       stands - the External Jobs cards, the details page, Saved Jobs. */
    try {
      var esc = (window.CSS && CSS.escape) ? CSS.escape(id) : id.replace(/[^\w-]/g, '');
      var sel = 'button[onclick*="tlpxApply(\'' + esc + '\')"],'
        + 'button[onclick*=\'xjApply("' + esc + '")\'],button[onclick*="xjApply(\'' + esc + '\')"]';
      Array.prototype.forEach.call(document.querySelectorAll(sel), function (b) {
        var span = document.createElement('span');
        span.className = 'tlpx-na';
        span.setAttribute('role', 'status');
        span.setAttribute('data-unavailable', id);
        span.textContent = message;
        b.parentNode.replaceChild(span, b);
      });
    } catch (e) { /* the message below still says it */ }
  }
  window.tlpxApply = function (id) {
    var j = X.byId[id];
    /* Already known to be gone: nothing to open, nothing to ask. */
    if (j && (j.__full || j.originalJobUrl !== undefined) && linkState(j) !== 'ok') {
      say(linkState(j) === 'gone' ? 'Job no longer available' : 'Application link unavailable');
      return;
    }
    var tab = null;
    try {
      tab = window.open('', '_blank');
      if (tab) {
        tab.opener = null;
        try { tab.document.title = 'Opening the original job page…'; } catch (e) { /* not ours to write */ }
      }
    } catch (e) { tab = null; }
    var closeTab = function () { if (tab) { try { tab.close(); } catch (e) { /* ignore */ } } };
    var send = function (url) {
      if (tab && !tab.closed) {
        try { tab.location.replace(url); } catch (e) { tab = null; }
      }
      if (!tab) openUrl(url);
      record(id);
      say('Opened ' + siteOf(X.byId[id] || j) + ' in a new tab — apply there', '↗️');
    };
    availability(id).then(function (a) {
      if (a && a.available && a.url) { send(a.url); return; }
      closeTab();
      var applyLink = (a && a.applyLink) || 'job_unavailable';
      var msg = applyLink === 'link_unavailable' ? 'Application link unavailable' : 'Job no longer available';
      markGone(id, applyLink, msg);
      /* Still counted: the click happened. The server records it against
         a closed posting, which creates nothing. */
      record(id);
      say(msg);
      if (/^#\/job\/xjob_/.test(location.hash || '')) rerender();
    }, function () {
      /* TeamLink itself did not answer: fall back to what the page already
         had, exactly as before 0115. */
      if (j && linkState(j) === 'ok') { send(j.originalJobUrl); return; }
      closeTab();
      say('Could not open the job just now — please try again', '⚠️');
    });
  };

  /* The External Jobs page's own Apply / "Open job again" take the same
     path: the original URL, opened from the click. */
  function wrapTracked() {
    var prev = window.xjApply;
    if (typeof prev !== 'function' || prev.__tlpx) return;
    var next = function (id) { window.tlpxApply(id); };
    next.__tlpx = true;
    next.__prev = prev;
    window.xjApply = next;
  }

  /*
   * NEVER THE TEAMLINK FORM FOR AN EXTERNAL JOB. W1's application form
   * wraps applyToJob / easyApply / cpEasyApply / capApply at load (after
   * this file) and hands an xjob_ id to the function it wrapped - which is
   * this guard, so an external id always ends in tlpxApply.
   */
  function guardTeamLinkApply() {
    ['applyToJob', 'easyApply', 'cpEasyApply', 'capApply', 'rjApplyJob'].forEach(function (fn) {
      var prev = window[fn];
      if (typeof prev !== 'function' || prev.__tlpxGuard) return;
      var g = function (jobId) {
        if (/^xjob_/.test(String(jobId || ''))) { window.tlpxApply(String(jobId)); return undefined; }
        return prev.apply(this, arguments);
      };
      g.__tlpxGuard = true;
      window[fn] = g;
    });
  }

  /* ---- saved external jobs (0108) -------------------------------------
   *
   * Saved on the server (external_saved_jobs), never in the browser. A
   * posting that closes stays saved and says so; only the candidate removes
   * it. TeamLink's own saved jobs are untouched.
   */
  function loadSaved(force) {
    if (!isCand() || !api()) return;
    var who = STATE.session && STATE.session.id;
    if (!force && X.savedFor === who && X.saved) return;
    X.savedFor = who;
    api().get('/external/saved').then(function (out) {
      X.saved = {};
      X.savedRows = (out && out.saved) || [];
      X.savedRows.forEach(function (r) { X.saved[r.job.id] = true; if (!X.byId[r.job.id]) X.byId[r.job.id] = r.job; });
      rerender();
    }, function () { X.savedFor = null; });
  }
  function saveButton(j, cls) {
    if (!isCand()) return '';
    var on = !!(X.saved && X.saved[j.id]);
    return '<button type="button" class="' + cls + '" aria-pressed="' + (on ? 'true' : 'false') + '" aria-label="'
      + (on ? 'Remove from saved jobs: ' : 'Save job: ') + h(j.title) + '" onclick="tlpxSave(\'' + js(j.id) + '\')">'
      + (on ? '★ Saved' : '☆ Save') + '</button>';
  }
  window.tlpxSave = function (id) {
    if (!api()) return;
    var on = !!(X.saved && X.saved[id]);
    var call = on ? api().del('/external/saved/' + encodeURIComponent(id)) : api().put('/external/saved/' + encodeURIComponent(id), {});
    call.then(function () {
      if (typeof window.toast === 'function') toast(on ? 'Removed from saved jobs' : 'Job saved', on ? 'ℹ️' : '⭐');
      loadSaved(true);
    }, function (e) {
      if (typeof window.toast === 'function') toast((e && e.message) || 'Could not save that job', '⚠️');
    });
  };
  function savedSection() {
    var rows = X.savedRows || [];
    if (!rows.length) return '';
    return '<section aria-labelledby="tlpxSavedH" style="margin-top:18px"><h2 id="tlpxSavedH" style="margin:0 0 4px;font-size:16px;font-weight:800;color:#16202c">Saved jobs from other job sites</h2>'
      + '<div style="font-size:12.5px;color:#5b6676;margin-bottom:10px">You apply for these on the original website.</div>'
      + rows.map(function (r) {
        var j = r.job;
        var open = r.available;
        return '<div class="cp-card" style="margin-bottom:12px"><div style="display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap">'
          + '<div style="flex:1;min-width:200px"><div style="font-size:15.5px;font-weight:800;color:#16202c">' + h(j.title) + '</div>'
          + '<div style="font-size:12.5px;color:#5b6676">' + h(j.company || '—') + ' · ' + h(j.location || '') + '</div>'
          + '<div style="margin-top:6px">' + label(j) + '</div></div>'
          + (open ? '' : '<div role="status" style="font-size:11.5px;font-weight:800;color:#8a3b12;background:#fdeee6;border-radius:12px;padding:4px 10px">No longer available</div>')
          + '</div><div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:11px;border-top:1px solid #f0f3f7;padding-top:11px">'
          + '<button type="button" class="cp-btn" onclick="navigate(\'/job/' + js(j.id) + '\')">View Job</button>'
          + (open ? applyControl(j, 'cp-btn pri') : '')
          + '<button type="button" class="cp-btn" onclick="tlpxSave(\'' + js(j.id) + '\')">Remove</button></div></div>';
      }).join('') + '</section>';
  }
  function wrapSaved() {
    var prev = window.cpSaved;
    if (typeof prev !== 'function' || prev.__tlpx) return;
    var next = function () {
      loadSaved(false);
      var extra = savedSection();
      var shell = window.cpShell;
      if (!extra || typeof shell !== 'function') return prev.apply(this, arguments);
      /* After the page's own list, inside the page's own shell: the body
         handed to cpShell('saved', …) gets the section appended. */
      window.cpShell = function (section, body) {
        return shell.apply(this, section === 'saved' && typeof body === 'string'
          ? [section, body + extra].concat([].slice.call(arguments, 2)) : arguments);
      };
      try { return prev.apply(this, arguments); } finally { window.cpShell = shell; }
    };
    next.__tlpx = true;
    window.cpSaved = next;
  }

  /* ---- styles: the dialog, focus, screen-reader text ---- */
  function addStyle() {
    if (document.getElementById('tlpx-css')) return;
    var css = '.tlpx-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}'
      + '.tlpx-na{display:inline-block;font-size:12.5px;font-weight:700;color:#7a4b00;background:#fff6e5;border-radius:8px;padding:6px 10px}'
      + '[data-external] button:focus-visible,.tlpx-link:focus-visible{outline:3px solid #1d6ff2;outline-offset:2px}'
      + '.tlpx-link{color:inherit;text-decoration:none}.tlpx-link:hover{text-decoration:underline}';
    var tag = document.createElement('style');
    tag.id = 'tlpx-css';
    tag.textContent = css;
    (document.head || document.documentElement).appendChild(tag);
  }

  function install() {
    addStyle();
    wrapDetail();
    wrapTracked();
    guardTeamLinkApply();
    wrapSaved();
    /* The external list is read only where external jobs are shown (the
       External Jobs page, an external job's own page), so Apply Now there
       has each job's original URL at hand. Never for the Jobs page. */
    var lazy = function () { if (/^#\/(candidate\/external-jobs|job\/xjob_)/.test(location.hash || '')) load(); };
    lazy();
    window.addEventListener('hashchange', lazy);
    loadSaved(false);
    /* A sign-in after load: pick up that candidate's saved jobs. */
    var prevRender = window.render;
    if (typeof prevRender === 'function' && !prevRender.__tlpxSaved) {
      var r2 = function () {
        var out = prevRender.apply(this, arguments);
        try {
          if (isCand() && X.savedFor !== (STATE.session && STATE.session.id)) loadSaved(false);
          if (!isCand()) { X.saved = null; X.savedRows = null; X.savedFor = null; }
        } catch (e) { /* ignore */ }
        return out;
      };
      r2.__tlpxSaved = true;
      window.render = r2;
    }
  }
  /* The details page is wrapped AT ONCE, not at load: a reload on
     #/job/xjob_… renders before the load event, and the page's own job
     view would treat an external id as unknown and move away. */
  wrapDetail();
  /* The deep-link opener (index.html tlOpenJobById) looks a job up in
     TeamLink's own table and sends the visitor to #/jobs when it is not
     there - which an external id never is. It is answered here instead. */
  (function guardDeepLink() {
    var prev = window.tlOpenJobById;
    if (typeof prev !== 'function' || prev.__tlpx) return;
    var next = function (id) {
      if (!/^xjob_/.test(String(id || ''))) return prev.apply(this, arguments);
      var want = '#/job/' + id;
      if (location.hash !== want) location.hash = want;
      return one(String(id)).then(function () { return true; });
    };
    next.__tlpx = true;
    window.tlOpenJobById = next;
  })();
  if (document.readyState === 'complete') install();
  else window.addEventListener('load', install);

  window.TLPortalExternal = { load: load, state: X, loadSaved: loadSaved, linkState: linkState };
})();
