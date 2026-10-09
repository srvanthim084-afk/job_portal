/* =====================================================================
   TEAMLINK - Jobs page: status cards, creator and dates (0125)

   WHAT IT IS. The helpers the recruiter's and the administrator's Jobs
   pages draw with:

     * four cards in one row - Total, Published, Not Published, Draft -
       counted from the same job list the table shows, so the cards and
       the table cannot disagree and Total = Published + Not Published +
       Draft always. Clicking a card filters the table; the active card is
       highlighted. A publish, unpublish or draft save re-renders the page,
       so the counts move with it.
     * the table's Created By / Created On / Published On cells, and the
       Created By (recruiter) and Created On (date range) filters.
     * the job page's "Job record" panel (staff only): created, published
       or taken down, and the last change a person made, by whom.

   THE STATES.
     Published      live: open, not paused, not archived, not expired
     Draft          saved as draft and never published
     Not Published  everything else - published once and now unpublished,
                    closed, paused, archived or expired (and the rare job
                    created already closed)

   The dates come from the database (jobs.created_at / created_by /
   published_at / unpublished_at / last_edited_*), stamped by 0125.
   ===================================================================== */
(function () {
  'use strict';
  if (window.TLJobStats) return;

  function h(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function st() {
    var S = window.STATE || {};
    S.tlJobsView = S.tlJobsView || {};
    return S.tlJobsView;
  }
  function view(key) {
    var v = st();
    v[key] = v[key] || { status: '', createdBy: '', from: '', to: '' };
    return v[key];
  }

  /* ---- what state a job is in ------------------------------------------ */
  function expired(j) {
    if (typeof window.jobIsExpired === 'function' && window.jobIsExpired(j)) return true;
    return !!(j && j.expiresAt && j.status === 'open' && new Date(j.expiresAt) < new Date());
  }
  function lifecycle(j) {
    if (j.status === 'open' && !j.paused && !j.archived && !expired(j)) return 'published';
    if (j.status === 'draft' && !j.publishedAt && !j.unpublishedAt) return 'draft';
    return 'not_published';
  }
  function statusOf(j) {
    var l = lifecycle(j);
    if (l === 'published') return { label: 'Published', cls: 'badge-ok' };
    if (l === 'draft') return { label: 'Draft', cls: 'badge-neutral' };
    if (j.archived) return { label: 'Archived', cls: 'badge-neutral' };
    if (j.status === 'closed') return { label: 'Closed', cls: 'badge-bad' };
    if (j.paused) return { label: 'Paused', cls: 'badge-warn' };
    if (j.status === 'open' && expired(j)) return { label: 'Expired', cls: 'badge-bad' };
    return { label: 'Unpublished', cls: 'badge-warn' };
  }
  function badge(j) { var s = statusOf(j); return '<span class="badge ' + s.cls + '">' + s.label + '</span>'; }

  /* ---- dates: "09 Oct 2026, 02:58 PM", India time ------------------------ */
  function when(v) {
    if (!v) return '';
    var d = new Date(v);
    if (isNaN(d)) return '';
    var date = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
    var time = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
    return date + ', ' + time;
  }
  function istDay(v) {
    var d = new Date(v);
    if (isNaN(d)) return '';
    return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });   /* YYYY-MM-DD */
  }
  function createdOf(j) { return j.createdAt || null; }
  /* Published On: when it went live; for a job that is down, when it came
     down (an expired job, its last date); for a draft, "-". */
  function publishedOn(j) {
    var l = lifecycle(j);
    if (l === 'draft') return { at: null, note: '' };
    if (l === 'published') return { at: j.publishedAt || null, note: '' };
    var s = statusOf(j).label;
    if (s === 'Expired') return { at: j.expiresAt || null, note: 'Expired' };
    return { at: j.unpublishedAt || j.lastEditedAt || null, note: s };
  }
  function creatorName(j) { return j.createdByName || '—'; }

  /* ---- the cards ---------------------------------------------------------- */
  function counts(list) {
    var c = { all: list.length, published: 0, not_published: 0, draft: 0 };
    list.forEach(function (j) { c[lifecycle(j)] += 1; });
    return c;
  }
  function css() {
    if (document.getElementById('tljsCss')) return;
    var s = document.createElement('style');
    s.id = 'tljsCss';
    s.textContent = ''
      + '.tljs-card{cursor:pointer;text-align:left;font:inherit;color:inherit;transition:border-color .12s,box-shadow .12s}'
      + '.tljs-card:hover{border-color:var(--brand-400)}'
      + '.tljs-card.on{border-color:var(--brand-600);box-shadow:0 0 0 2px var(--brand-100)}'
      + '.tljs-card.on .lbl{color:var(--brand-700)}'
      + '.tljs-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:10px 14px;border-bottom:1px solid var(--line)}'
      + '.tljs-bar select,.tljs-bar input{border:1px solid var(--line);border-radius:7px;height:32px;padding:2px 9px;font-size:12.5px;background:var(--card);color:var(--text);font-family:inherit}'
      + '.tljs-bar label{font-size:12px;color:var(--text-soft);display:flex;align-items:center;gap:6px}'
      + '.tljs-when{white-space:nowrap;font-size:12.5px}'
      + '.tljs-note{display:block;font-size:11px;color:var(--text-soft)}'
      + '.tljs-rec .k{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--text-soft)}'
      + '.tljs-rec .v{font-size:13px;margin-top:3px}.tljs-rec .v span{color:var(--text-soft);font-size:12px}';
    document.head.appendChild(s);
  }
  function cards(list, key) {
    css();
    var c = counts(list); var v = view(key);
    var one = function (status, label, n, tip) {
      return '<button type="button" class="stat-tile tljs-card' + (v.status === status ? ' on' : '') + '" title="' + h(tip) + '"'
        + ' aria-pressed="' + (v.status === status) + '" onclick="TLJobStats.setStatus(\'' + key + '\',\'' + status + '\')">'
        + '<div class="lbl">' + label + '</div><div class="val tabular">' + n.toLocaleString('en-IN') + '</div></button>';
    };
    return '<div class="stat-row tljs-cards" data-jobs-view="' + key + '">'
      + one('', 'Total Jobs', c.all, 'Every job created')
      + one('published', 'Published', c.published, 'Live and visible to candidates')
      + one('not_published', 'Not Published', c.not_published, 'Published earlier - now unpublished, closed or expired')
      + one('draft', 'Draft', c.draft, 'Saved as draft, never published')
      + '</div>';
  }

  /* ---- the filters --------------------------------------------------------- */
  function creators(list) {
    var seen = {};
    list.forEach(function (j) {
      var id = j.createdById || '';
      if (id && !seen[id]) seen[id] = j.createdByName || 'Unknown';
    });
    return Object.keys(seen).map(function (id) { return { id: id, name: seen[id] }; })
      .sort(function (a, b) { return a.name.localeCompare(b.name); });
  }
  function apply(list, key) {
    var v = view(key);
    return list.filter(function (j) {
      if (v.status && lifecycle(j) !== v.status) return false;
      if (v.createdBy && j.createdById !== v.createdBy) return false;
      if (v.from || v.to) {
        var d = istDay(createdOf(j));
        if (!d) return false;
        if (v.from && d < v.from) return false;
        if (v.to && d > v.to) return false;
      }
      return true;
    });
  }
  function filterBar(list, key) {
    css();
    var v = view(key);
    var opts = creators(list).map(function (c) {
      return '<option value="' + h(c.id) + '"' + (v.createdBy === c.id ? ' selected' : '') + '>' + h(c.name) + '</option>';
    }).join('');
    var any = v.status || v.createdBy || v.from || v.to;
    return '<div class="tljs-bar">'
      + '<label>Created By <select aria-label="Created By" onchange="TLJobStats.set(\'' + key + '\',\'createdBy\',this.value)"><option value="">All recruiters</option>' + opts + '</select></label>'
      + '<label>Created On <input type="date" aria-label="Created from" value="' + h(v.from) + '" onchange="TLJobStats.set(\'' + key + '\',\'from\',this.value)"></label>'
      + '<label>to <input type="date" aria-label="Created to" value="' + h(v.to) + '" onchange="TLJobStats.set(\'' + key + '\',\'to\',this.value)"></label>'
      + (any ? '<button class="btn btn-ghost btn-sm" onclick="TLJobStats.clear(\'' + key + '\')">Clear filters</button>' : '')
      + '</div>';
  }

  /* ---- table cells ---------------------------------------------------------- */
  function cells(j) {
    var p = publishedOn(j);
    return '<td>' + badge(j) + '</td>'
      + '<td>' + h(creatorName(j)) + '</td>'
      + '<td class="tljs-when">' + (createdOf(j) ? h(when(createdOf(j))) : '-') + '</td>'
      + '<td class="tljs-when">' + (p.at ? h(when(p.at)) + (p.note ? '<span class="tljs-note">' + h(p.note) + '</span>' : '') : '-') + '</td>';
  }
  var HEAD = '<th>Status</th><th>Created By</th><th>Created On</th><th>Published On</th>';

  /* ---- the job page's record, staff only ------------------------------------ */
  function isStaff() {
    var s = window.STATE && STATE.session;
    return !!s && ['recruiter', 'admin', 'bde', 'client'].indexOf(s.role) >= 0;
  }
  function recordPanel(j) {
    if (!j || !isStaff() || !('createdAt' in j)) return '';
    css();
    var p = publishedOn(j);
    var item = function (k, v, by) {
      return '<div class="item"><div class="k">' + k + '</div><div class="v">' + (v ? h(v) : '-') + (by ? ' <span>by ' + h(by) + '</span>' : '') + '</div></div>';
    };
    var edited = j.lastEditedAt || j.createdAt;
    var editor = j.lastEditedAt ? (j.lastEditedByName || '—') : creatorName(j);
    return '<div class="panel tljs-rec"><div class="panel-head"><h2>Job record</h2>' + badge(j) + '</div><div class="panel-body">'
      + '<div class="kv" style="grid-template-columns:repeat(2,1fr);margin-top:0">'
      + item('Created On', when(j.createdAt), creatorName(j))
      + item(p.note ? (p.note === 'Expired' ? 'Expired On' : p.note + ' On') : 'Published On', p.at ? when(p.at) : '')
      + item('Last Updated', when(edited), editor)
      + '</div></div></div>';
  }

  function rerender() { if (typeof window.render === 'function') window.render(); }
  var onJobsPage = function () { return /^#\/(recruiter|admin)\/jobs|^#\/job\//.test(location.hash || ''); };

  window.TLJobStats = {
    lifecycle: lifecycle, statusOf: statusOf, badge: badge, when: when, counts: counts,
    cards: cards, filterBar: filterBar, apply: apply, cells: cells, HEAD: HEAD, recordPanel: recordPanel,
    view: view,
    setStatus: function (key, status) { var v = view(key); v.status = v.status === status ? '' : status; rerender(); },
    set: function (key, k, val) { view(key)[k] = val || ''; rerender(); },
    clear: function (key) { var v = view(key); v.status = ''; v.createdBy = ''; v.from = ''; v.to = ''; rerender(); },
    /* The server answered a job write: its stamps (published / unpublished
       time, last edit) are now on the record, so draw them. */
    changed: function () { if (onJobsPage()) rerender(); },
  };
})();
