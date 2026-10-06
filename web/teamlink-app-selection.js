/* =====================================================================
   TEAMLINK — Recruiter -> Applications: one selection, and a bar that
   says how big it is
   =====================================================================

   WHAT WAS THERE. The tick-boxes on this table were Export's generic
   ones (teamlink-export.js): keyed by CANDIDATE id, thrown away on every
   route change, and "select all" ticked every row in the table body -
   including the rows the Screening filter had hidden. "Send screening
   questions" read the checked boxes straight out of the DOM. Two
   readers, two answers, and no count anywhere on the screen.

   WHAT THIS DOES.

   - ONE SET IS THE TRUTH. TLAppSelection holds the selected application
     ids (the internal `app_…` id every endpoint takes; the TL-APP-…
     reference the recruiter sees is available from references()). The
     count is the Set's size, never a count of ticked boxes, so it is the
     same after a filter, a repaint, or a trip to a candidate and back.

   - THE BOXES ARE A VIEW OF THE SET. The same column Export used to add
     (same `tlx-tick` cells, so the existing widths, pinning and mobile
     card layout are untouched) is drawn here from the Set, synchronously
     after every repaint - a MutationObserver callback runs before the
     browser paints, so a selected row is never shown unticked.

   - THE BAR. "{N} selected" and Clear selection, between the filter bars
     and the table header; gone entirely at N = 0. A selected row that a
     filter has taken off the screen stays selected and is counted:
     "{N} selected ({M} hidden by filters)". role=status / aria-live.

   - THE HEADER BOX acts on the VISIBLE rows only: checked when every
     visible row is selected, indeterminate when some are, and a click
     selects or deselects exactly those.

   - IT SURVIVES NAVIGATION within the tab: the Set is kept in
     sessionStorage (per signed-in user), so opening a candidate and
     coming back keeps the selection, and the first paint shows it.

   BULK ACTIONS READ THE SET. Export's "N selected" and "Send screening
   questions" both ask TLAppSelection on this screen instead of reading
   check boxes (see the two small hooks in those files).
   ===================================================================== */
(function () {
  'use strict';

  var KEY = 'tl.appSelection.v1';
  var STYLE_ID = 'tlasStyle';

  var set = new Set();
  var subs = [];
  var loadedFor = null;          // the user whose stored selection is in `set`

  /* ------------------------------------------------------------------ *
   * the Set and its storage
   * ------------------------------------------------------------------ */
  function who() {
    try {
      var s = window.STATE && window.STATE.session;
      return s && s.id ? String(s.role || '') + ':' + String(s.id) : '';
    } catch (e) { return ''; }
  }

  /** Bring the Set in line with whoever is signed in now. */
  function restore() {
    var u = who();
    if (u === loadedFor) return;
    loadedFor = u;
    set.clear();
    if (!u) return;
    try {
      var raw = sessionStorage.getItem(KEY);
      if (!raw) return;
      var v = JSON.parse(raw);
      if (!v || v.u !== u || !Array.isArray(v.ids)) return;
      v.ids.forEach(function (id) { if (typeof id === 'string' && id) set.add(id); });
    } catch (e) { /* no storage: the selection lives for this page only */ }
  }

  function persist() {
    try {
      var u = who();
      if (!u) return;
      if (!set.size) sessionStorage.removeItem(KEY);
      else sessionStorage.setItem(KEY, JSON.stringify({ u: u, ids: Array.from(set) }));
    } catch (e) { /* see restore() */ }
  }

  function changed() {
    persist();
    var snapshot = Array.from(set);
    subs.slice().forEach(function (fn) { try { fn(snapshot); } catch (e) {} });
    /* Export's button carries "(n selected)". */
    if (typeof window.tlExportRefresh === 'function') { try { window.tlExportRefresh(); } catch (e) {} }
    sync();
  }

  /* ------------------------------------------------------------------ *
   * applications, by id
   * ------------------------------------------------------------------ */

  /* The prototype addresses a candidate's primary application as
     'primary__<candidateId>'; TL.primaryAppId holds the real id. */
  function realId(rowId) {
    var m = /^primary__(.+)$/.exec(String(rowId || ''));
    if (!m) return String(rowId || '');
    var map = window.TL && window.TL.primaryAppId;
    return (map && map[m[1]]) || String(rowId);
  }

  function findApp(id) {
    try {
      var list = (window.DATA && window.DATA.applications) || [];
      for (var i = 0; i < list.length; i++) if (list[i] && list[i].id === id) return list[i];
      var map = window.TL && window.TL.primaryAppId;
      if (map) {
        for (var cid in map) if (map[cid] === id) return { id: id, candidateId: cid, primary: true };
      }
    } catch (e) {}
    return null;
  }

  /** Drop ids whose application no longer exists at all (not merely filtered). */
  function prune() {
    try {
      if (!(window.TL && window.TL.ready)) return false;
      var list = window.DATA && window.DATA.applications;
      if (!Array.isArray(list) || !list.length) return false;
      var gone = Array.from(set).filter(function (id) { return !findApp(id); });
      gone.forEach(function (id) { set.delete(id); });
      return gone.length > 0;
    } catch (e) { return false; }
  }

  /* ------------------------------------------------------------------ *
   * the table
   * ------------------------------------------------------------------ */
  function table() {
    return document.querySelector('#app .tl-apps-wrap table.data');
  }
  function rowsOf(t) {
    return t ? [].slice.call(t.querySelectorAll('tbody > tr[data-app-id]')) : [];
  }
  /* The Screening filter hides rows with display:none; the other filter
     bar re-renders without them. Either way: not visible. */
  function isVisible(tr) {
    return tr.style.display !== 'none' && !tr.hidden;
  }
  function idOf(tr) { return realId(tr.getAttribute('data-app-id')); }

  function visibleIds() {
    return rowsOf(table()).filter(isVisible).map(idOf);
  }

  function label(id) {
    var a = findApp(id), name = '';
    try {
      var c = a && window.DATA && DATA.candidateById ? DATA.candidateById(a.candidateId) : null;
      name = (c && c.name) || '';
    } catch (e) {}
    var ref = (a && a.reference) || '';
    return 'Select ' + (name || 'application') + (ref ? ' (' + ref + ')' : '');
  }

  /** The tick column: the same cells Export drew, now drawn from the Set. */
  function decorate(t) {
    if (t.__tlas) return;
    var head = t.querySelector('thead tr');
    var rows = rowsOf(t);
    if (!head || !rows.length) return;
    t.__tlas = true;
    t.__tlx = true;              /* Export: this table's boxes are taken */

    var th = document.createElement('th');
    th.className = 'tlx-tick';
    var all = document.createElement('input');
    all.type = 'checkbox';
    all.className = 'tlas-all';
    all.title = 'Select every row shown';
    all.setAttribute('aria-label', 'Select all visible applications');
    th.appendChild(all);
    head.insertBefore(th, head.firstChild);

    [].slice.call(t.querySelectorAll('tbody > tr')).forEach(function (tr) {
      var td = document.createElement('td');
      td.className = 'tlx-tick';
      if (tr.hasAttribute('data-app-id')) {
        var id = idOf(tr);
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'tlas-row';
        cb.setAttribute('data-app-id', id);
        cb.setAttribute('aria-label', label(id));
        cb.checked = set.has(id);
        td.appendChild(cb);
      } else if (tr.querySelector('td[colspan]')) {
        var wide = tr.querySelector('td[colspan]');
        wide.setAttribute('colspan', String((Number(wide.getAttribute('colspan')) || 1) + 1));
        return;
      }
      tr.insertBefore(td, tr.firstChild);
    });
  }

  /* ------------------------------------------------------------------ *
   * the bar
   * ------------------------------------------------------------------ */
  function injectCss() {
    if (document.getElementById(STYLE_ID)) return;
    var el = document.createElement('style');
    el.id = STYLE_ID;
    /* Same box as the Screening bar above it (.tlsq-bar): flex row, 10px
       gaps, 10px 14px padding, 10px radius, 12.5px type - in the
       portal's indigo (--brand-100 / --brand-700). */
    el.textContent = [
      '.tlas-bar{display:flex;flex-wrap:wrap;gap:10px;align-items:center;padding:10px 14px;margin:10px 0;',
      '  background:var(--brand-100,#eef1ff);border:1px solid rgba(79,70,229,.22);border-radius:10px;',
      '  font-size:12.5px;color:var(--brand-700,#3d34c4)}',
      '.tlas-bar[hidden]{display:none!important}',
      '.tlas-bar .tlas-n{font-weight:700}',
      '.tlas-bar .tlas-h{font-weight:600;opacity:.85}',
      '.tlas-bar .tlas-clear{color:var(--brand-700,#3d34c4)}',
      '.tlas-bar .tlas-clear:focus-visible{outline:2px solid var(--brand-500,#6366f1);outline-offset:2px}',
      '@media (prefers-color-scheme: dark){:root:not([data-theme="light"]) .tlas-bar{color:#c7cbff;border-color:rgba(139,147,248,.35)}}',
      ':root[data-theme="dark"] .tlas-bar{color:#c7cbff;border-color:rgba(139,147,248,.35)}',
    ].join('\n');
    document.head.appendChild(el);
  }

  function bar(t) {
    var wrap = t.closest('.tbl-wrap') || t;
    var host = wrap.parentNode;
    if (!host) return null;
    var b = host.querySelector(':scope > .tlas-bar');
    if (!b) {
      b = document.createElement('div');
      b.className = 'tlas-bar';
      b.id = 'tlasBar';
      b.setAttribute('role', 'status');
      b.setAttribute('aria-live', 'polite');
      b.setAttribute('aria-atomic', 'true');
      b.hidden = true;
      b.innerHTML = '<span class="tlas-n"></span><span class="tlas-h"></span>'
        + '<button type="button" class="btn btn-ghost btn-sm tlas-clear">Clear selection</button>';
    }
    /* Directly above the table, under whatever filter bar is there. */
    if (b.nextSibling !== wrap) host.insertBefore(b, wrap);
    return b;
  }

  function setText(el, s) { if (el && el.textContent !== s) el.textContent = s; }

  /* ------------------------------------------------------------------ *
   * one pass: boxes, header, bar - idempotent, so it can run on every
   * mutation without feeding itself
   * ------------------------------------------------------------------ */
  var syncing = false;
  function sync() {
    if (syncing) return;
    var t = table();
    if (!t) return;
    syncing = true;
    try {
      restore();
      if (prune()) persist();
      injectCss();
      decorate(t);

      var rows = rowsOf(t), shown = 0, picked = 0, visible = new Set();
      rows.forEach(function (tr) {
        var id = idOf(tr);
        var cb = tr.querySelector('input.tlas-row');
        var on = set.has(id);
        if (cb && cb.checked !== on) cb.checked = on;
        if (isVisible(tr)) { shown += 1; visible.add(id); if (on) picked += 1; }
      });

      var all = t.querySelector('thead input.tlas-all');
      if (all) {
        var full = shown > 0 && picked === shown;
        var part = picked > 0 && picked < shown;
        if (all.checked !== full) all.checked = full;
        if (all.indeterminate !== part) all.indeterminate = part;
        var ac = full ? 'true' : (part ? 'mixed' : 'false');
        if (all.getAttribute('aria-checked') !== ac) all.setAttribute('aria-checked', ac);
      }

      var n = set.size;
      var hidden = 0;
      set.forEach(function (id) { if (!visible.has(id)) hidden += 1; });
      var b = bar(t);
      if (b) {
        setText(b.querySelector('.tlas-n'), n ? n + ' selected' : '');
        setText(b.querySelector('.tlas-h'), n && hidden ? '(' + hidden + ' hidden by filters)' : '');
        if (b.hidden !== (n === 0)) b.hidden = n === 0;
      }
    } finally { syncing = false; }
  }

  /* ------------------------------------------------------------------ *
   * input
   * ------------------------------------------------------------------ */
  document.addEventListener('change', function (e) {
    var el = e.target;
    if (!el || !el.classList) return;
    if (el.classList.contains('tlas-row')) {
      var id = el.getAttribute('data-app-id');
      if (!id) return;
      if (el.checked) set.add(id); else set.delete(id);
      changed();
    } else if (el.classList.contains('tlas-all')) {
      var on = el.checked;
      visibleIds().forEach(function (vid) { if (on) set.add(vid); else set.delete(vid); });
      changed();
    }
  });

  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest && e.target.closest('.tlas-clear');
    if (!b) return;
    e.preventDefault();
    api.clear();
    /* The button has just disappeared; leave the keyboard somewhere useful. */
    var t = table();
    var next = t && (t.querySelector('thead input.tlas-all') || t.querySelector('input.tlas-row'));
    if (next && next.offsetParent) { try { next.focus(); } catch (err) {} }
  });

  /* A tick-box is not a click on the row. */
  document.addEventListener('click', function (e) {
    var td = e.target && e.target.closest && e.target.closest('.tl-apps-wrap td.tlx-tick');
    if (td) e.stopPropagation();
  });

  /* Every repaint, every filter: the Screening filter changes row styles,
     the other filters and the router replace the table. */
  try {
    new MutationObserver(function () { sync(); }).observe(document.documentElement,
      { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'hidden'] });
  } catch (e) {}

  /* ------------------------------------------------------------------ *
   * the API every bulk action on this table uses
   * ------------------------------------------------------------------ */
  var api = {
    /** Selected application ids (internal `app_…`). */
    get: function () { restore(); return Array.from(set); },
    has: function (id) { restore(); return set.has(realId(id)); },
    add: function (id) { restore(); id = realId(id); if (id && !set.has(id)) { set.add(id); changed(); } return api; },
    'delete': function (id) { restore(); id = realId(id); if (set.delete(id)) changed(); return api; },
    clear: function () { restore(); if (set.size) { set.clear(); changed(); } else sync(); return api; },
    get size() { restore(); return set.size; },
    /** fn(ids) after every change; returns an unsubscribe function. */
    onChange: function (fn) {
      if (typeof fn !== 'function') return function () {};
      subs.push(fn);
      return function () { subs = subs.filter(function (f) { return f !== fn; }); };
    },
    /** The TL-APP-… references of the selection, where known. */
    references: function () {
      return api.get().map(function (id) { var a = findApp(id); return (a && a.reference) || null; });
    },
    /** The distinct candidates behind the selection (Export works per person). */
    candidateIds: function () {
      var out = [];
      api.get().forEach(function (id) {
        var a = findApp(id);
        if (a && a.candidateId && out.indexOf(a.candidateId) < 0) out.push(a.candidateId);
      });
      return out;
    },
    visibleIds: visibleIds,
    hiddenCount: function () {
      var v = new Set(visibleIds()), n = 0;
      api.get().forEach(function (id) { if (!v.has(id)) n += 1; });
      return n;
    },
    /** True while the Applications table is on screen. */
    active: function () { return !!table(); },
    /** True for the table this selection owns. */
    owns: function (t) { return !!(t && t.closest && t.closest('.tl-apps-wrap')); },
    sync: sync,
  };
  window.TLAppSelection = api;
}());
