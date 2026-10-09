/* =====================================================================
   TEAMLINK — one Export menu, on every recruiter table
   =====================================================================

   WHAT IT DOES. Adds a tick-box to every row, a "select all" to the
   header, and one Export button beside "Clear filters" that offers:

     Download Resumes (ZIP)     the original files
     Export List (Excel .xlsx)
     Export List (CSV)

   with a scope - the ticked people, this page, or everything matching
   the filters currently set - and a column chooser for the two list
   formats.

   ONE COMPONENT, NOT ONE PER SCREEN. There are five recruiter tables
   that list people and there will be more. A per-screen export is five
   column lists that drift apart and five places to fix a bug in the
   filename rules, so this attaches itself to whatever table is on the
   page and the screens do not know it exists.

   "EVERYTHING MATCHING THE FILTERS" DOES NOT RE-IMPLEMENT THE FILTERS.
   The sidebar can set forty of them. Rather than rebuild that query,
   this remembers the last list request the SCREEN made - filters and
   all - and asks the server for the same thing again with a high limit,
   then exports the ids that come back. So the export is by construction
   the same set the recruiter is looking at, and a filter added to the
   sidebar next year needs no change here.

   WHAT IT NEVER DOES. It does not build the file. The server reads the
   rows under row-level security, so an id the recruiter may not see
   produces nothing, and every export is written to the audit log (0084)
   before a byte is sent. This file only decides WHO, and asks.

   THE CANDIDATE PORTAL IS UNTOUCHED. It mounts on recruiter, BDE and
   admin routes only, and checks the session role as well as the route.
   ===================================================================== */
(function () {
  'use strict';

  var API = function () { return (window.TL && window.TL.api) || null; };
  var toast = function (m, i) {
    if (typeof window.toast === 'function') window.toast(m, i);
  };

  /* Tables that list people. Same contract the scroll modules use. */
  var TABLE = '.tp-tbl table, .tbl-wrap table.data';

  var STYLE_ID = 'tlxStyle';

  /* The last list request each screen made, so "everything matching the
     filters" can be asked for again rather than reconstructed. */
  var lastList = null;

  /* ------------------------------------------------------------------ *
   * who may see this at all
   * ------------------------------------------------------------------ */
  function staff() {
    var s = window.STATE && window.STATE.session;
    return !!s && (s.role === 'recruiter' || s.role === 'bde' || s.role === 'admin');
  }

  function onStaffScreen() {
    var h = String(location.hash || '');
    return staff() && (h.indexOf('#/recruiter') === 0
      || h.indexOf('#/bde') === 0 || h.indexOf('#/admin') === 0);
  }

  /* ------------------------------------------------------------------ *
   * remembering the screen's own query
   * ------------------------------------------------------------------ */
  (function watchFetch() {
    if (!window.fetch || window.__tlxFetchWrapped) return;
    window.__tlxFetchWrapped = true;
    var original = window.fetch;
    window.fetch = function (input, init) {
      try {
        var url = String(typeof input === 'string' ? input : (input && input.url) || '');
        var method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
        /* Only the candidate LIST, and only a read. */
        if (method === 'GET' && /\/api\/candidates(\?|$)/.test(url)) lastList = url;
      } catch (e) { /* never break a request to remember it */ }
      return original.apply(this, arguments);
    };
  }());

  /* ------------------------------------------------------------------ *
   * styling — the app's own blue, its radii, its light theme
   * ------------------------------------------------------------------ */
  function injectCss() {
    if (document.getElementById(STYLE_ID)) return;
    var css = [
      '.tlx-btn{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line,#e6ebf2);',
      '  background:var(--card,#fff);color:var(--text,#243449);border-radius:8px;',
      '  padding:7px 12px;font-size:12.5px;font-weight:700;cursor:pointer;',
      '  font-family:inherit;line-height:1.2}',
      '.tlx-btn:hover:not(:disabled){border-color:var(--brand-600,#4f46e5);color:var(--brand-600,#4f46e5)}',
      '.tlx-btn:disabled{opacity:.5;cursor:not-allowed}',
      '.tlx-count{font-weight:600;color:var(--text-soft,#6b7a90)}',

      '.tlx-back{position:fixed;inset:0;background:rgba(15,20,30,.45);z-index:9100;',
      '  display:flex;align-items:center;justify-content:center;padding:18px}',
      '.tlx-box{background:var(--card,#fff);border-radius:12px;max-width:560px;width:100%;',
      '  max-height:88vh;overflow:auto;padding:20px 22px;',
      '  box-shadow:0 20px 60px rgba(15,25,45,.28);font-family:inherit}',
      '.tlx-h{font-size:15.5px;font-weight:800;color:var(--text,#243449);margin:0 0 3px}',
      '.tlx-sub{font-size:12.5px;color:var(--text-soft,#6b7a90);margin:0 0 14px;line-height:1.5}',
      '.tlx-lab{font-size:11px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;',
      '  color:var(--text-soft,#6b7a90);margin:14px 0 6px}',
      '.tlx-opt{display:flex;align-items:flex-start;gap:8px;padding:7px 9px;border-radius:8px;',
      '  border:1px solid var(--line,#e6ebf2);margin-bottom:6px;cursor:pointer;font-size:13px}',
      '.tlx-opt input{margin-top:2px}',
      '.tlx-opt.on{border-color:var(--brand-600,#4f46e5);background:#f5f6ff}',
      '.tlx-opt s{display:block;font-size:11.5px;color:var(--text-soft,#6b7a90);',
      '  text-decoration:none;margin-top:1px}',
      '.tlx-cols{display:grid;grid-template-columns:1fr 1fr;gap:4px 12px;',
      '  border:1px solid var(--line,#e6ebf2);border-radius:8px;padding:10px;max-height:190px;overflow:auto}',
      '.tlx-cols label{display:flex;align-items:center;gap:7px;font-size:12.5px;cursor:pointer}',
      '.tlx-note{margin-top:14px;padding:9px 11px;border-radius:8px;background:#fff7e8;',
      '  border:1px solid #f0d9a8;font-size:12px;color:#7a5a12;line-height:1.5}',
      '.tlx-acts{display:flex;gap:8px;justify-content:flex-end;margin-top:16px;flex-wrap:wrap}',
      '.tlx-go{background:var(--brand-600,#4f46e5);color:#fff;border:0;border-radius:8px;',
      '  padding:9px 16px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit}',
      '.tlx-go:disabled{opacity:.6;cursor:not-allowed}',

      '.tlx-tick{width:34px;text-align:center}',
      '@media (max-width:700px){',
      '  .tlx-cols{grid-template-columns:1fr}',
      '}',
    ].join('\n');
    var el = document.createElement('style');
    el.id = STYLE_ID; el.textContent = css;
    document.head.appendChild(el);
  }

  /* ------------------------------------------------------------------ *
   * the tick boxes
   * ------------------------------------------------------------------ */

  /* Ticked ids survive a repaint - filtering or paging must not throw
     away a selection the recruiter has been building. */
  var picked = Object.create(null);

  function rowId(tr) {
    /* The id is written in four different places across these screens,
       so all four are read rather than one being imposed on them. */
    var direct = tr.getAttribute('data-id') || tr.getAttribute('data-candidate-id');
    if (direct) return direct;
    var hay = (tr.getAttribute('onclick') || '') + ' ' + (tr.innerHTML || '').slice(0, 400);
    var m = hay.match(/(cand_[A-Za-z0-9_]+)/) || hay.match(/\bc\d{1,6}\b/);
    return m ? m[0] : '';
  }

  /**
   * The screen's own tick box, where it has one.
   *
   * Talent Pool already gives every row a checkbox wired to tpPick().
   * Adding a second column beside it would be two ways to select the
   * same person that disagree the moment either is used, so this binds
   * to the one that is there and only builds its own where there is
   * none.
   */
  function ownTick(tr) {
    var cb = tr.querySelector('td:first-child input[type="checkbox"]');
    return cb && !cb.closest('.tlx-tick') ? cb : null;
  }

  function tableHasOwnTicks(table) {
    var tr = table.querySelector('tbody tr');
    return !!(tr && ownTick(tr));
  }

  /* Recruiter -> Applications keeps its own selection (teamlink-app-
     selection.js): one Set of application ids, drawn into the same tick
     column. Export reads it rather than drawing a second one. */
  function appSelection() {
    var s = window.TLAppSelection;
    return s && typeof s.active === 'function' && s.active() ? s : null;
  }

  function decorate(table) {
    if (table.__tlx) return;
    if (window.TLAppSelection && typeof TLAppSelection.owns === 'function' && TLAppSelection.owns(table)) {
      TLAppSelection.sync();
      return;
    }
    var head = table.querySelector('thead tr');
    var body = table.querySelector('tbody');
    if (!head || !body) return;
    if (!body.querySelector('tr')) return;

    /* Only a table of PEOPLE. A table of jobs or of message logs has no
       candidate id on its rows and gets nothing. */
    var ids = [].slice.call(body.querySelectorAll('tr')).map(rowId).filter(Boolean);
    if (ids.length < 1) return;

    table.__tlx = true;

    /* Already has them: follow along instead of competing. */
    if (tableHasOwnTicks(table)) {
      [].slice.call(body.querySelectorAll('tr')).forEach(function (tr) {
        var id = rowId(tr), cb = ownTick(tr);
        if (!id || !cb) return;
        if (picked[id]) cb.checked = true;
        cb.addEventListener('change', function () {
          if (cb.checked) picked[id] = true; else delete picked[id];
          paintButton();
        });
      });
      var headAll = head.querySelector('input[type="checkbox"]');
      if (headAll) headAll.addEventListener('change', function () {
        /* The screen's own "select all" ticks the boxes; read them back
           a tick later, once it has. */
        setTimeout(function () {
          [].slice.call(body.querySelectorAll('tr')).forEach(function (tr) {
            var id = rowId(tr), cb = ownTick(tr);
            if (!id || !cb) return;
            if (cb.checked) picked[id] = true; else delete picked[id];
          });
          paintButton();
        }, 30);
      });
      paintButton();
      return;
    }

    var th = document.createElement('th');
    th.className = 'tlx-tick';
    var all = document.createElement('input');
    all.type = 'checkbox';
    all.title = 'Select every row on this page';
    all.addEventListener('change', function () {
      [].slice.call(body.querySelectorAll('tr')).forEach(function (tr) {
        var id = rowId(tr); if (!id) return;
        if (all.checked) picked[id] = true; else delete picked[id];
        var cb = tr.querySelector('.tlx-tick input');
        if (cb) cb.checked = all.checked;
      });
      paintButton();
    });
    th.appendChild(all);
    head.insertBefore(th, head.firstChild);

    [].slice.call(body.querySelectorAll('tr')).forEach(function (tr) {
      var id = rowId(tr);
      var td = document.createElement('td');
      td.className = 'tlx-tick';
      if (id) {
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !!picked[id];
        /* The row itself opens the candidate; the box must not. */
        cb.addEventListener('click', function (e) { e.stopPropagation(); });
        cb.addEventListener('change', function () {
          if (cb.checked) picked[id] = true; else delete picked[id];
          paintButton();
        });
        td.appendChild(cb);
      }
      td.addEventListener('click', function (e) { e.stopPropagation(); });
      tr.insertBefore(td, tr.firstChild);
    });
  }

  function pickedIds() {
    /* Where the screen owns the boxes it may also clear them - a filter
       change, a page turn - so the DOM is the truth for the rows that
       are on screen, and `picked` carries the ones that are not. */
    var sel = appSelection();
    if (sel) return sel.candidateIds();
    var t = document.querySelector(TABLE);
    if (t && tableHasOwnTicks(t)) {
      [].slice.call(t.querySelectorAll('tbody tr')).forEach(function (tr) {
        var id = rowId(tr), cb = ownTick(tr);
        if (!id || !cb) return;
        if (cb.checked) picked[id] = true; else delete picked[id];
      });
    }
    return Object.keys(picked);
  }

  function pageIds() {
    var t = document.querySelector(TABLE);
    if (!t) return [];
    return [].slice.call(t.querySelectorAll('tbody tr')).map(rowId).filter(Boolean);
  }

  /* ------------------------------------------------------------------ *
   * the button
   * ------------------------------------------------------------------ */

  function toolbar() {
    /* Beside "Clear filters" where there is one, because that is where a
       recruiter's eye already is when they have finished filtering. */
    var btns = [].slice.call(document.querySelectorAll('#app button, #app a'));
    for (var i = 0; i < btns.length; i++) {
      if (/clear\s*filters/i.test(btns[i].textContent || '')) return btns[i].parentElement;
    }
    var t = document.querySelector(TABLE);
    return t ? (t.closest('.tp-tbl, .tbl-wrap') || {}).parentElement || null : null;
  }

  function paintButton() {
    var btn = document.getElementById('tlxBtn');
    if (!btn) return;
    var n = pickedIds().length;
    var total = pageIds().length;
    btn.disabled = total === 0;
    btn.innerHTML = 'Export'
      + (n ? ' <span class="tlx-count">(' + n + ' selected)</span>' : '')
      + ' ▾';
  }

  function mountButton() {
    if (document.getElementById('tlxBtn')) { paintButton(); return; }
    var host = toolbar();
    if (!host) return;
    var btn = document.createElement('button');
    btn.id = 'tlxBtn';
    btn.type = 'button';
    btn.className = 'tlx-btn';
    btn.addEventListener('click', openDialog);
    host.appendChild(btn);
    paintButton();
  }

  /* ------------------------------------------------------------------ *
   * the dialog
   * ------------------------------------------------------------------ */

  var CATALOGUE = null;

  function loadColumns() {
    if (CATALOGUE) return Promise.resolve(CATALOGUE);
    var api = API();
    if (!api) return Promise.resolve(null);
    return api.get('/recruiter/candidates/export-columns')
      .then(function (out) { CATALOGUE = out; return out; })
      .catch(function () { return null; });
  }

  function openDialog() {
    injectCss();
    loadColumns().then(function (cat) {
      if (!cat) { toast('The export options could not be loaded.', '⚠️'); return; }
      render(cat);
    });
  }

  /* ------------------------------------------------------------------ *
   * 0130: the Applications screen filters in the browser, so "everything
   * matching the current filters" there is the list it is showing - the
   * filtered applications, one row each, with their Applied On - not the
   * last Talent Pool query.
   * ------------------------------------------------------------------ */
  function onApps() {
    return /^#\/recruiter\/applications/.test(String(location.hash || ''))
      && typeof window.tlAppFilteredRows === 'function';
  }
  var realApp = function (id) { return !!id && !/^(primary__|app_new)/.test(String(id)); };
  function appRowsFiltered() {
    try { return (window.tlAppFilteredRows() || []).filter(function (a) { return a && a.candidateId; }); }
    catch (e) { return []; }
  }
  function uniq(list) {
    var seen = {}; return list.filter(function (x) { if (!x || seen[x]) return false; seen[x] = 1; return true; });
  }
  function appIdsFor(scope) {
    if (!onApps()) return [];
    if (scope === 'filtered') return uniq(appRowsFiltered().map(function (a) { return a.id; }).filter(realApp));
    if (scope === 'page') {
      return uniq([].slice.call(document.querySelectorAll('.tl-apps-wrap tbody tr[data-app-id]'))
        .map(function (tr) { return tr.getAttribute('data-app-id'); }).filter(realApp));
    }
    return [];
  }

  function render(cat) {
    var nSel = pickedIds().length;
    var nPage = pageIds().length;
    var nApps = onApps() ? appRowsFiltered().length : 0;

    var back = document.createElement('div');
    back.className = 'tlx-back';
    back.addEventListener('click', function (e) { if (e.target === back) back.remove(); });

    var scopeOpt = function (val, title, sub, on, disabled) {
      return '<label class="tlx-opt' + (on ? ' on' : '') + '">'
        + '<input type="radio" name="tlxScope" value="' + val + '"'
        + (on ? ' checked' : '') + (disabled ? ' disabled' : '') + '>'
        + '<span><b>' + title + '</b><s>' + sub + '</s></span></label>';
    };

    var cols = cat.columns.map(function (c) {
      return '<label><input type="checkbox" class="tlxCol" value="' + c.key + '"'
        + (cat.defaults.indexOf(c.key) >= 0 ? ' checked' : '') + '>'
        + c.label + '</label>';
    }).join('');

    back.innerHTML =
      '<div class="tlx-box" role="dialog" aria-modal="true" aria-label="Export candidates">'
      + '<h3 class="tlx-h">Export candidates</h3>'
      + '<p class="tlx-sub">The list as a spreadsheet, or the resume files themselves.</p>'

      + '<div class="tlx-lab">Who</div>'
      + scopeOpt('selected', nSel + ' selected',
          nSel ? 'The rows you have ticked.' : 'Tick some rows first.', nSel > 0, nSel === 0)
      + scopeOpt('page', 'This page (' + nPage + ')',
          'Every row currently shown.', nSel === 0, nPage === 0)
      + (onApps()
        ? scopeOpt('filtered', 'Everything matching the current filters (' + nApps + ' application' + (nApps === 1 ? '' : 's') + ')',
            'Exactly the filtered applications, one row each, with their Applied On date.', false, nApps === 0)
        : scopeOpt('filtered', 'Everything matching the current filters',
            'Asks the server for the same list again, without the page limit.', false,
            !lastList))

      + '<div class="tlx-lab">What</div>'
      + scopeOpt('__f_csv', 'Export List (CSV)', 'Opens in Excel, Sheets or Numbers.', true, false)
        .replace(/name="tlxScope"/g, 'name="tlxFormat"').replace(/value="__f_csv"/, 'value="csv"')
      + scopeOpt('__f_xlsx', 'Export List (Excel .xlsx)', 'A real workbook.', false, false)
        .replace(/name="tlxScope"/g, 'name="tlxFormat"').replace(/value="__f_xlsx"/, 'value="xlsx"')
      + scopeOpt('__f_zip', 'Download Resumes (ZIP)',
          'The original files. Up to ' + cat.zipLimit + ' download at once; up to '
          + (cat.jobLimit || cat.zipLimit) + ' are prepared in the background. Anyone without a '
          + 'resume is listed in missing_resumes.txt inside the archive.', false, false)
        .replace(/name="tlxScope"/g, 'name="tlxFormat"').replace(/value="__f_zip"/, 'value="zip"')

      + '<div id="tlxColWrap"><div class="tlx-lab">Columns</div>'
      + '<div class="tlx-cols">' + cols + '</div></div>'

      + '<div class="tlx-note">Contains candidate personal data. '
      + 'Handle as per company policy.</div>'

      + '<div class="tlx-acts">'
      + '<button class="tlx-btn" type="button" id="tlxCancel">Cancel</button>'
      + '<button class="tlx-go" type="button" id="tlxGo">Export</button>'
      + '</div></div>';

    document.body.appendChild(back);

    var box = back.querySelector('.tlx-box');
    box.addEventListener('change', function () {
      /* The chosen option is the one that looks chosen. */
      [].slice.call(box.querySelectorAll('.tlx-opt')).forEach(function (l) {
        var i = l.querySelector('input');
        l.classList.toggle('on', !!(i && i.checked));
      });
      /* Columns mean nothing for a ZIP of files. */
      var fmt = (box.querySelector('input[name="tlxFormat"]:checked') || {}).value;
      var cw = document.getElementById('tlxColWrap');
      if (cw) cw.style.display = fmt === 'zip' ? 'none' : '';
    });

    box.querySelector('#tlxCancel').addEventListener('click', function () { back.remove(); });
    box.querySelector('#tlxGo').addEventListener('click', function () { run(box, back, cat); });

    /* Escape closes it, like every other dialog on the page. */
    var esc = function (e) {
      if (e.key === 'Escape') { back.remove(); document.removeEventListener('keydown', esc, true); }
    };
    document.addEventListener('keydown', esc, true);
  }

  /* ------------------------------------------------------------------ *
   * doing it
   * ------------------------------------------------------------------ */

  /** Every id matching what the screen last asked for. */
  function filteredIds() {
    if (!lastList) return Promise.resolve([]);
    var url = lastList
      .replace(/([?&])limit=\d+/, '$1limit=5000')
      .replace(/([?&])offset=\d+/, '$1offset=0');
    if (!/[?&]limit=/.test(url)) url += (url.indexOf('?') >= 0 ? '&' : '?') + 'limit=5000';
    return fetch(url, { headers: { 'x-csrf-token': csrf() }, credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (j) { return (j.candidates || []).map(function (c) { return c.id; }); });
  }

  function csrf() {
    var m = document.cookie.match(/tl_csrf=([^;]+)/);
    return m ? m[1] : '';
  }

  function idsFor(scope) {
    if (scope === 'selected') return Promise.resolve(pickedIds());
    if (scope === 'page') return Promise.resolve(pageIds());
    if (onApps()) return Promise.resolve(uniq(appRowsFiltered().map(function (a) { return a.candidateId; })));
    return filteredIds();
  }

  function run(box, back, cat) {
    var scope = (box.querySelector('input[name="tlxScope"]:checked') || {}).value || 'page';
    var format = (box.querySelector('input[name="tlxFormat"]:checked') || {}).value || 'csv';
    var columns = [].slice.call(box.querySelectorAll('.tlxCol:checked'))
      .map(function (c) { return c.value; });

    if (format !== 'zip' && !columns.length) {
      toast('Choose at least one column.', '⚠️'); return;
    }

    var go = box.querySelector('#tlxGo');
    go.disabled = true; go.textContent = 'Preparing…';

    idsFor(scope).then(function (ids) {
      if (!ids.length) {
        toast('There is nobody in that selection.', '⚠️');
        go.disabled = false; go.textContent = 'Export'; return;
      }
      if (format === 'zip' && ids.length > cat.zipLimit) {
        var most = cat.jobLimit || cat.zipLimit;
        if (ids.length > most) {
          toast('That is ' + ids.length + ' resumes. One export holds up to '
            + most + ' — narrow the selection, or export in batches.', '⚠️');
          go.disabled = false; go.textContent = 'Export'; return;
        }
        /* More than fit in one download: built in the background, and
           downloaded here when it is ready. */
        return backgroundZip(ids, scope, box, back, go);
      }
      if (ids.length > 100) {
        toast('Preparing ' + ids.length + ' records… this may take a moment.', '⏳');
      }

      var path = format === 'zip'
        ? '/api/recruiter/candidates/export-resumes'
        : '/api/recruiter/candidates/export';

      var body = { ids: ids, scope: scope, filters: filtersForAudit() };
      if (format !== 'zip') { body.format = format; body.columns = columns; }
      var appIds = format !== 'zip' ? appIdsFor(scope) : [];
      if (appIds.length) body.applicationIds = appIds.slice(0, 5000);

      return fetch(path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrf() },
        body: JSON.stringify(body),
      }).then(function (res) {
        if (!res.ok) {
          return res.json().catch(function () { return null; }).then(function (j) {
            throw new Error((j && j.error && j.error.message) || ('Export failed (' + res.status + ')'));
          });
        }
        var missing = res.headers.get('x-teamlink-missing');
        var included = res.headers.get('x-teamlink-included');
        return res.blob().then(function (blob) { return { blob: blob, res: res, missing: missing, included: included }; });
      }).then(function (out) {
        save(out.blob, filename(out.res, format));
        back.remove();
        if (format === 'zip') {
          toast(out.included + ' resume' + (out.included === '1' ? '' : 's') + ' downloaded'
            + (Number(out.missing) ? ' · ' + out.missing
              + ' had no file, listed in missing_resumes.txt' : ''), '✅');
        } else {
          toast(appIds.length
            ? appIds.length + ' application' + (appIds.length === 1 ? '' : 's') + ' exported as ' + format.toUpperCase()
            : ids.length + ' candidate' + (ids.length === 1 ? '' : 's') + ' exported as ' + format.toUpperCase(), '✅');
        }
      });
    }).catch(function (err) {
      toast(err && err.message ? err.message : 'That export did not complete.', '⚠️');
      go.disabled = false; go.textContent = 'Export';
    });
  }

  /**
   * A large resume export: start the job, show how far it has got, and
   * download the archive when the server says it is ready. Polled every
   * two seconds; the archive stays available for a day.
   */
  function backgroundZip(ids, scope, box, back, go) {
    var hdrs = { 'content-type': 'application/json', 'x-csrf-token': csrf() };
    return fetch('/api/recruiter/candidates/export-resumes/jobs', {
      method: 'POST', credentials: 'same-origin', headers: hdrs,
      body: JSON.stringify({ ids: ids, scope: scope, filters: filtersForAudit() }),
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (j) {
        if (!res.ok) throw new Error((j && j.error && j.error.message) || ('Export failed (' + res.status + ')'));
        return j.job;
      });
    }).then(function (job) {
      toast('Preparing ' + job.total + ' resumes in the background — the download starts when it is ready.', '⏳');
      return new Promise(function (resolve, reject) {
        var tick = function () {
          fetch('/api/recruiter/candidates/export-resumes/jobs/' + encodeURIComponent(job.id),
            { credentials: 'same-origin', cache: 'no-store' })
            .then(function (r) { return r.json(); })
            .then(function (out) {
              var j = out && out.job;
              if (!j) throw new Error((out && out.error && out.error.message) || 'That export is no longer available.');
              if (j.status === 'failed') throw new Error(j.error || 'That export did not complete.');
              if (j.status === 'ready') { resolve(j); return; }
              go.textContent = 'Preparing… ' + j.done + ' / ' + j.total;
              setTimeout(tick, 2000);
            })
            .catch(reject);
        };
        tick();
      });
    }).then(function (j) {
      var a = document.createElement('a');
      a.href = '/api/recruiter/candidates/export-resumes/jobs/' + encodeURIComponent(j.id) + '/download';
      a.rel = 'noopener';
      document.body.appendChild(a); a.click(); a.remove();
      back.remove();
      toast(j.included + ' resumes downloaded'
        + (j.missing ? ' · ' + j.missing + ' had no file, listed in missing_resumes.txt' : ''), '✅');
    });
  }

  /** What the sidebar had set, for the audit line. Never candidate data. */
  function filtersForAudit() {
    if (onApps() && typeof window.tlAppFilterState === 'function') {
      try {
        var f = window.tlAppFilterState(), out = {};
        Object.keys(f).forEach(function (k) { if (f[k]) out[k] = f[k]; });
        out.screen = 'applications';
        return out;
      } catch (e) { return {}; }
    }
    if (!lastList) return {};
    try {
      var qs = lastList.split('?')[1] || '';
      var out = {};
      qs.split('&').forEach(function (pair) {
        if (!pair) return;
        var kv = pair.split('=');
        var k = decodeURIComponent(kv[0] || '');
        if (k === 'limit' || k === 'offset') return;
        out[k] = decodeURIComponent((kv[1] || '').replace(/\+/g, ' '));
      });
      return out;
    } catch (e) { return {}; }
  }

  function filename(res, format) {
    var cd = res.headers.get('content-disposition') || '';
    var m = cd.match(/filename="([^"]+)"/);
    if (m) return m[1];
    var stamp = new Date().toISOString().slice(0, 10);
    return format === 'zip' ? 'teamlink-resumes-' + stamp + '.zip'
      : 'teamlink-candidates-' + stamp + '.' + format;
  }

  function save(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  /* ------------------------------------------------------------------ *
   * keeping up with the page
   * ------------------------------------------------------------------ */

  function sweep() {
    if (!onStaffScreen()) {
      var b = document.getElementById('tlxBtn');
      if (b) b.remove();
      return;
    }
    injectCss();
    var tables = document.querySelectorAll(TABLE);
    for (var i = 0; i < tables.length; i++) decorate(tables[i]);
    mountButton();
  }

  var queued = false;
  function queue() {
    if (queued) return;
    queued = true;
    setTimeout(function () {
      queued = false;
      try { sweep(); } catch (e) {
        if (window.console) console.warn('[export]', e && e.message);
      }
    }, 80);
  }

  function watch() {
    var root = document.getElementById('app') || document.body;
    try {
      new MutationObserver(queue).observe(root, { childList: true, subtree: true });
    } catch (e) {}
    window.addEventListener('hashchange', function () {
      /* A different screen is a different list; a selection built on the
         talent pool must not follow you to the applications table. */
      picked = Object.create(null);
      queue();
    });
    queue();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', watch);
  } else {
    watch();
  }

  window.tlExportRefresh = queue;
}());
