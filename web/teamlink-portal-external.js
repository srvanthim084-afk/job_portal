/*
 * TeamLink — external jobs inside the job portal.
 *
 * External jobs (collected by the server from permitted sources and
 * stored in external_jobs) appear in the ordinary portal, next to
 * TeamLink's own jobs, instead of only on a page of their own:
 *
 *   - the candidate job search (#/candidate/search) and the public job
 *     board (#/jobs) list them with a small "External • <source>" label,
 *     filtered by the same search, location, type and posted filters;
 *   - the candidate search gains a Source filter (TeamLink / each
 *     external source);
 *   - #/job/<id> opens an external job's own details page.
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
 * TeamLink jobs are untouched: their cards, Apply button and application
 * flow are exactly what they were.
 */
(function () {
  'use strict';

  var X = { jobs: null, byId: {}, loading: null, at: 0, off: false,
    /* 0108: the server's ranked answer per search, and the saved set. */
    byQ: {}, qLoading: {}, saved: null, savedRows: null, savedFor: null };
  var h = function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  };
  var js = function (v) { return String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); };
  var low = function (v) { return String(v == null ? '' : v).trim().toLowerCase(); };
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
        X.jobs = (out && out.jobs) || [];
        X.jobs.forEach(function (j) { X.byId[j.id] = j; });
        X.at = Date.now(); X.loading = null;
        rerender();
        return X.jobs;
      })
      .catch(function () { X.loading = null; X.jobs = X.jobs || []; return X.jobs; });
    return X.loading;
  }

  /*
   * A SEARCH IS RANKED BY THE SERVER (0108). With a query, the listing
   * asks /api/portal/external-jobs?q=… once per query and keeps the
   * server's order - the deterministic score documented in migration
   * 0108 - instead of re-sorting here. The page's own filters (place,
   * type, posted, company) still narrow that list. Bounded to 500 rows,
   * cached per query for ten minutes.
   */
  function ranked(q) {
    var key = low(q);
    if (!key) return null;
    var hit = X.byQ[key];
    if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.jobs;
    if (!X.qLoading[key] && !X.off) {
      X.qLoading[key] = fetch('/api/portal/external-jobs?limit=500&sort=relevance&q=' + encodeURIComponent(String(q).slice(0, 120)),
        { credentials: 'same-origin', cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : { jobs: [] }; })
        .then(function (out) {
          var jobs = (out && out.jobs) || [];
          jobs.forEach(function (j) { if (!X.byId[j.id] || !X.byId[j.id].__full) X.byId[j.id] = j; });
          X.byQ[key] = { jobs: jobs, at: Date.now() };
          delete X.qLoading[key];
          rerender();
        })
        .catch(function () { delete X.qLoading[key]; });
    }
    return hit ? hit.jobs : null;
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
   * filtering, with the portal's own filters
   * ------------------------------------------------------------------ */
  var daysAgo = function (j) {
    var t = Date.parse(j.postedAt || j.lastSyncedAt || '');
    return isNaN(t) ? 999 : Math.floor((Date.now() - t) / 86400000);
  };
  var typeOf = function (t) { return low(t).replace(/[\s_-]+/g, ''); };

  function matchQ(j, q) {
    var terms = low(q).split(',').map(function (x) { return x.trim(); }).filter(Boolean);
    if (!terms.length) return true;
    var hay = low([j.title, j.company, (j.skills || []).join(' ')].join(' '));
    return terms.some(function (t) { return hay.indexOf(t) >= 0; });
  }
  function matchPlace(j, places, km) {
    if (!places.length) return true;
    if (/remote|anywhere|work from home/i.test(j.location)) return true;
    if (window.TL_LOC && TL_LOC.matchesAny) return TL_LOC.matchesAny(j.location, places, km || 0);
    return places.some(function (p) { return low(j.location).indexOf(low(p)) >= 0; });
  }

  /** The candidate search's filters, applied to external jobs. */
  function forCandidateSearch() {
    var rj = (window.STATE && STATE.rj) || {}; var f = rj.f || {};
    if (f.src === 'teamlink') return [];
    var places = [].concat(f.locTags || [], (f.locations || []).filter(function (x) { return x !== 'Any Location'; }),
      rj.loc && rj.loc !== 'Any Location' ? [rj.loc] : []);
    var types = (f.types || []).map(typeOf);
    var byServer = ranked(rj.q);
    return (byServer || X.jobs || []).filter(function (j) {
      if (f.src && j.source !== f.src) return false;
      if (!byServer && !matchQ(j, rj.q)) return false;
      if (!matchPlace(j, places, Number(f.locKm) || 0)) return false;
      if (types.length && types.indexOf(typeOf(j.employmentType)) < 0) return false;
      if (f.posted && daysAgo(j) > Number(f.posted)) return false;
      if (f.company && low(j.company).indexOf(low(f.company)) < 0) return false;
      return true;
    });
  }

  /** The public job board's filters, applied to external jobs. */
  function forPublicSearch() {
    var s = (window.STATE && STATE.search) || {};
    var places = [].concat(s.loc ? [s.loc] : [], s.locations || []);
    var types = (s.jobType || []).map(typeOf);
    var byServer = ranked(s.q);
    return (byServer || X.jobs || []).filter(function (j) {
      if (!byServer && !matchQ(j, s.q)) return false;
      if (!matchPlace(j, places, 0)) return false;
      if (types.length && types.indexOf(typeOf(j.employmentType)) < 0) return false;
      if (s.posted && daysAgo(j) > Number(s.posted)) return false;
      if (s.company && low(j.company).indexOf(low(s.company)) < 0) return false;
      return true;
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
  var posted = function (j) {
    var d = daysAgo(j);
    return d >= 999 ? '' : (d <= 0 ? 'Posted today' : d === 1 ? 'Posted 1 day ago' : 'Posted ' + d + ' days ago');
  };

  function rjCard(j) {
    return '<article class="rj-card" data-external="1">'
      + '<div class="rj-top">'
      + '<div class="rj-logo">' + h(String(j.company || 'EX').slice(0, 2).toUpperCase()) + '</div>'
      + '<div style="flex:1;min-width:200px">'
      + '<h3 class="rj-t">' + h(j.title) + '</h3>'
      + '<div class="rj-c">' + h(j.company || '—') + ' · ' + h(j.location || '—') + '</div>'
      + '<div class="rj-meta"><span>💰 ' + h(j.salary || 'Not disclosed') + '</span><span>💼 ' + h(j.experience || '—') + '</span>'
      + '<span>📄 ' + h(j.employmentType || '—') + '</span></div>'
      + '<div style="margin-top:7px">' + label(j) + '</div>'
      + '</div></div>'
      + ((j.skills || []).length ? '<div class="rj-sec"><div class="rj-sk">' + j.skills.slice(0, 8).map(function (s) {
        return '<span class="have">' + h(s) + '</span>';
      }).join('') + '</div></div>' : '')
      + '<div class="rj-foot"><div class="grow"><b style="color:#42505f">' + h(posted(j)) + '</b>'
      + ' · <span style="color:#8a94a6">You apply on the original website</span></div>'
      + '<button type="button" class="rj-btn" aria-label="View job: ' + h(j.title) + '" onclick="navigate(\'/job/' + js(j.id) + '\')">View Job</button>'
      + saveButton(j, 'rj-btn')
      + applyControl(j, 'rj-btn pri')
      + '</div></article>';
  }

  function publicRow(j) {
    return '<div class="job-row" data-external="1"><div class="jr-main" onclick="navigate(\'/job/' + js(j.id) + '\')">'
      + '<div class="jr-top"><div class="jr-headline"><h3><a class="tlpx-link" href="#/job/' + h(encodeURIComponent(j.id)) + '" onclick="event.stopPropagation()">' + h(j.title) + '</a></h3>'
      + '<div class="co-name">' + h(j.company || '—') + ' · ' + h(j.location || '—') + '</div></div></div>'
      + '<div class="job-meta"><span>💼 ' + h(j.experience || '—') + '</span><span>💰 ' + h(j.salary || 'Not disclosed') + '</span>'
      + '<span>🕒 ' + h(j.employmentType || '—') + '</span></div>'
      + '<div style="margin-top:6px">' + label(j) + ' <span style="font-size:12px;color:#8a94a6;margin-left:6px">' + h(posted(j)) + '</span></div>'
      + '</div><div style="display:flex;align-items:center;padding:0 14px">'
      + applyControl(j, 'btn btn-primary btn-sm', true)
      + '</div></div>';
  }

  /* ---- the candidate search ---- */
  window.tlpxSource = function (v) {
    STATE.rj = STATE.rj || {}; STATE.rj.f = STATE.rj.f || {};
    STATE.rj.f.src = v || '';
    STATE.rj.page = 1;
    rerender();
  };

  function sourceGroup() {
    var cur = ((STATE.rj || {}).f || {}).src || '';
    var seen = {};
    (X.jobs || []).forEach(function (j) { seen[j.source] = j.sourceName || j.source; });
    var opts = [['', 'All sources'], ['teamlink', 'TeamLink jobs']].concat(
      Object.keys(seen).sort(function (a, b) { return seen[a].localeCompare(seen[b]); })
        .map(function (k) { return [k, seen[k]]; }));
    return '<div class="rj-fg"><h5>Source</h5><select onchange="tlpxSource(this.value)">'
      + opts.map(function (o) { return '<option value="' + h(o[0]) + '"' + (o[0] === cur ? ' selected' : '') + '>' + h(o[1]) + '</option>'; }).join('')
      + '</select></div>';
  }

  /** The end of the <div> that starts at `from`, by counting nested divs. */
  function closeOf(html, from) {
    var depth = 0, i = from;
    var re = /<div\b|<\/div>/g; re.lastIndex = from;
    var m;
    while ((m = re.exec(html))) {
      depth += m[0] === '</div>' ? -1 : 1;
      if (depth === 0) return m.index;
      i = m.index;
    }
    return -1;
  }

  function wrapCandidateSearch() {
    var prevRec = window.recAll;
    if (typeof prevRec === 'function' && !prevRec.__tlpx) {
      /* Choosing an external source shows that source only. */
      var r2 = function () {
        var src = (((window.STATE || {}).rj || {}).f || {}).src;
        if (src && src !== 'teamlink') return [];
        return prevRec.apply(this, arguments);
      };
      r2.__tlpx = true;
      window.recAll = r2;
    }
    var prev = window.rjPage;
    if (typeof prev !== 'function' || prev.__tlpx) return;
    var next = function () {
      var html = prev.apply(this, arguments);
      if (typeof html !== 'string' || X.off) return html;
      if (!X.jobs) { load(); return html; }

      /* Source, in the filter rail, beside the others. */
      var at = html.indexOf('<div class="rj-fg"><h5>Experience</h5>');
      if (at > 0) html = html.slice(0, at) + sourceGroup() + html.slice(at);

      var ext = forCandidateSearch();
      var body = html.indexOf('<div class="rj-body">');
      if (body < 0) return html;
      var aside = html.indexOf('</aside>', body);
      var list = html.indexOf('<div', aside > 0 ? aside : body + 20);
      if (list < 0) return html;
      var end = closeOf(html, list);
      if (end < 0) return html;
      var inner = html.slice(html.indexOf('>', list) + 1, end);
      var empty = inner.indexOf('class="rj-empty"') >= 0;
      if (!ext.length) return html;
      var block = (empty ? '' : '<div style="font-size:12.5px;color:#7b8794;margin:14px 2px 8px">'
          + ext.length + ' more job' + (ext.length === 1 ? '' : 's') + ' from other job sites · you apply on the original website</div>')
        + ext.slice(0, 60).map(rjCard).join('')
        + (ext.length > 60 ? '<div style="font-size:12px;color:#8a94a6;margin:8px 2px">Showing 60 of ' + ext.length + ' — narrow the search to see the rest.</div>' : '');
      var nextInner = empty ? block : inner + block;
      return html.slice(0, html.indexOf('>', list) + 1) + nextInner + html.slice(end);
    };
    next.__tlpx = true;
    window.rjPage = next;
  }

  /* ---- the public job board ---- */
  function wrapPublic() {
    var prev = window.pageJobs;
    if (typeof prev !== 'function' || prev.__tlpx) return;
    var next = function () {
      var html = prev.apply(this, arguments);
      if (typeof html !== 'string' || X.off) return html;
      if (!X.jobs) { load(); return html; }
      var ext = forPublicSearch();
      if (!ext.length) return html;
      var at = html.indexOf('<div class="job-list">');
      if (at < 0) return html;
      var end = closeOf(html, at);
      if (end < 0) return html;
      var inner = html.slice(at + '<div class="job-list">'.length, end);
      var empty = inner.indexOf('class="empty-note"') >= 0;
      var block = ext.slice(0, 60).map(publicRow).join('');
      html = html.slice(0, at) + '<div class="job-list">' + (empty ? block : inner + block) + html.slice(end);
      /* The count says how many there are in total. */
      return html.replace(/<div class="result-count"><b>(\d+)<\/b> job(s?) found<\/div>/, function (m, n) {
        var total = Number(n) + ext.length;
        return '<div class="result-count"><b>' + total + '</b> job' + (total === 1 ? '' : 's') + ' found'
          + ' <span style="font-weight:600;color:#8a94a6;font-size:12.5px">(' + ext.length + ' from other job sites)</span></div>';
      });
    };
    next.__tlpx = true;
    window.pageJobs = next;
  }

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
        + '<button type="button" class="btn btn-primary" style="margin-top:14px" onclick="navigate(\'' + (isCand() ? '/candidate/search' : '/jobs') + '\')">See other jobs</button>'
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

  function wrapDetail() {
    var prev = window.pageJobDetail;
    if (typeof prev !== 'function' || prev.__tlpx) return;
    var next = function (id) {
      if (!/^xjob_/.test(String(id || ''))) return prev.apply(this, arguments);
      var j = X.byId[id];
      if (!j || (!j.__full && !j.missing)) {
        one(id);
        if (!j) return '<section class="block" style="padding-top:48px"><div class="wrap"><div class="panel"><div class="panel-body" style="text-align:center;padding:40px">Loading the job…</div></div></div></section>';
      }
      if (j && j.title && !j.missing) {
        try { document.title = j.title + (j.company ? ' at ' + j.company : '') + ' · External job via ' + (j.sourceName || j.source) + ' · TeamLink'; } catch (e) { /* ignore */ }
      }
      return detailHtml(j);
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
  window.tlpxApply = function (id) {
    var j = X.byId[id];
    var go = function (job) {
      var st = linkState(job);
      if (st === 'gone') { if (typeof window.toast === 'function') toast('Job no longer available', 'ℹ️'); return; }
      if (st === 'nolink') { if (typeof window.toast === 'function') toast('Application link unavailable', 'ℹ️'); return; }
      openUrl(job.originalJobUrl);
      record(job.id);
      if (typeof window.toast === 'function') toast('Opened ' + siteOf(job) + ' in a new tab — apply there', '↗️');
    };
    if (j && (j.__full || j.originalJobUrl !== undefined)) { go(j); return; }
    /* Not in the page's list (e.g. opened from another screen): ask once.
       A blank tab is opened inside the click so the browser allows it, and
       pointed at the original URL when the answer comes. */
    var tab = null;
    try { tab = window.open('', '_blank'); if (tab) tab.opener = null; } catch (e) { tab = null; }
    one(id).then(function (full) {
      if (linkState(full) === 'ok' && tab) { tab.location.replace(full.originalJobUrl); record(full.id); return; }
      if (tab) try { tab.close(); } catch (e) { /* ignore */ }
      go(full);
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
    wrapCandidateSearch();
    wrapPublic();
    wrapDetail();
    wrapTracked();
    guardTeamLinkApply();
    wrapSaved();
    load();
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

  window.TLPortalExternal = { load: load, state: X, ranked: ranked, loadSaved: loadSaved, linkState: linkState };
})();
