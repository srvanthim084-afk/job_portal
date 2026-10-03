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
 * APPLY NOW goes to the ORIGINAL job page. Nothing is created in
 * TeamLink's applications. A signed-in candidate's click goes through
 * the existing tracked flow (xjApply -> "Clicked", which asks later
 * whether they applied); anybody else is sent by the server's redirect,
 * which reads the URL from the database and validates it.
 *
 * TeamLink jobs are untouched: their cards, Apply button and application
 * flow are exactly what they were.
 */
(function () {
  'use strict';

  var X = { jobs: null, byId: {}, loading: null, at: 0, off: false };
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
    return (X.jobs || []).filter(function (j) {
      if (f.src && j.source !== f.src) return false;
      if (!matchQ(j, rj.q)) return false;
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
    return (X.jobs || []).filter(function (j) {
      if (!matchQ(j, s.q)) return false;
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
  var label = function (j) {
    return '<span title="Applied for on the original website" style="display:inline-block;font-size:11px;font-weight:800;'
      + 'color:#5b4bb7;background:#f1eefe;border-radius:10px;padding:2px 8px;white-space:nowrap">External • '
      + h(j.sourceName || j.source) + '</span>';
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
      + '<button class="rj-btn" onclick="navigate(\'/job/' + js(j.id) + '\')">View Job</button>'
      + '<button class="rj-btn pri" onclick="tlpxApply(\'' + js(j.id) + '\')">Apply Now ↗</button>'
      + '</div></article>';
  }

  function publicRow(j) {
    return '<div class="job-row" data-external="1"><div class="jr-main" onclick="navigate(\'/job/' + js(j.id) + '\')">'
      + '<div class="jr-top"><div class="jr-headline"><h3>' + h(j.title) + '</h3>'
      + '<div class="co-name">' + h(j.company || '—') + ' · ' + h(j.location || '—') + '</div></div></div>'
      + '<div class="job-meta"><span>💼 ' + h(j.experience || '—') + '</span><span>💰 ' + h(j.salary || 'Not disclosed') + '</span>'
      + '<span>🕒 ' + h(j.employmentType || '—') + '</span></div>'
      + '<div style="margin-top:6px">' + label(j) + ' <span style="font-size:12px;color:#8a94a6;margin-left:6px">' + h(posted(j)) + '</span></div>'
      + '</div><div style="display:flex;align-items:center;padding:0 14px">'
      + '<button class="btn btn-primary btn-sm" onclick="event.stopPropagation();tlpxApply(\'' + js(j.id) + '\')">Apply Now ↗</button>'
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
  function detailHtml(j) {
    if (j.missing || j.status !== 'ACTIVE') {
      return '<section class="block" style="padding-top:40px"><div class="wrap"><div class="panel"><div class="panel-body" style="text-align:center;padding:40px 22px">'
        + '<div style="font-size:30px">🔒</div><h1 style="font-size:19px;margin-top:10px">This job is no longer available.</h1>'
        + (j.title ? '<p style="color:#7b8794;margin-top:6px">' + h(j.title) + (j.company ? ' · ' + h(j.company) : '') + '</p>' : '')
        + '<button class="btn btn-primary" style="margin-top:14px" onclick="navigate(\'' + (isCand() ? '/candidate/search' : '/jobs') + '\')">See other jobs</button>'
        + '</div></div></div></section>';
    }
    var row = function (k, v) { return v ? '<div class="k">' + h(k) + '</div><div class="v">' + h(v) + '</div>' : ''; };
    var postedOn = j.postedAt ? new Date(j.postedAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
    return '<section class="block" style="padding-top:28px"><div class="wrap" style="max-width:920px">'
      + '<button class="btn btn-ghost btn-sm" onclick="history.back()">← Back</button>'
      + '<div class="panel" style="margin-top:12px"><div class="panel-body">'
      + '<div style="display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap">'
      + '<div style="flex:1;min-width:240px"><h1 style="font-size:22px;margin:0">' + h(j.title) + '</h1>'
      + '<div style="color:#42505f;margin-top:4px">' + h(j.company || '—') + ' · ' + h(j.location || '—') + '</div>'
      + '<div style="margin-top:8px">' + label(j) + '</div></div>'
      + '<div style="text-align:right"><button class="btn btn-primary" onclick="tlpxApply(\'' + js(j.id) + '\')">Apply Now ↗</button>'
      + '<div style="font-size:12px;color:#7b8794;margin-top:6px;max-width:240px">You will be redirected to the original job website to apply.</div></div>'
      + '</div>'
      + '<div class="cap-kv" style="margin-top:16px;display:grid;grid-template-columns:160px 1fr;gap:6px 14px;font-size:13.5px">'
      + row('Experience', j.experience) + row('Salary', j.salary) + row('Employment type', j.employmentType)
      + row('Qualifications', j.education) + row('Posted', postedOn) + row('Source', 'External • ' + (j.sourceName || j.source))
      + '</div>'
      + ((j.skills || []).length ? '<div style="margin-top:14px"><b style="font-size:13px">Skills</b><div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:6px">'
        + j.skills.map(function (s) { return '<span class="badge">' + h(s) + '</span>'; }).join('') + '</div></div>' : '')
      + (j.description ? '<div style="margin-top:16px"><b style="font-size:13px">Description</b>'
        + '<div style="margin-top:6px;font-size:13.5px;line-height:1.65;color:#26313f;white-space:pre-wrap">' + h(j.description) + '</div></div>' : '')
      + '</div></div></div></section>';
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
      return detailHtml(j);
    };
    next.__tlpx = true;
    window.pageJobDetail = next;
  }

  /* ---- Apply Now: to the original website ---- */
  window.tlpxApply = function (id) {
    var j = X.byId[id];
    if (j && (j.missing || (j.status && j.status !== 'ACTIVE'))) {
      if (typeof window.toast === 'function') toast('This job is no longer available.', 'ℹ️');
      return;
    }
    /* A signed-in candidate: the existing tracked flow - it opens the
       original page and later asks whether they applied. Still not a
       TeamLink application. */
    if (isCand() && typeof window.xjApply === 'function') { window.xjApply(id); return; }
    /* Anybody else: the server's validated redirect. */
    var url = '/api/portal/external-jobs/' + encodeURIComponent(id) + '/apply';
    var win = null;
    try { win = window.open(url, '_blank', 'noopener,noreferrer'); } catch (e) { win = null; }
    if (!win) location.href = url;
  };

  function install() {
    wrapCandidateSearch();
    wrapPublic();
    wrapDetail();
    load();
  }
  if (document.readyState === 'complete') install();
  else window.addEventListener('load', install);

  window.TLPortalExternal = { load: load, state: X };
})();
