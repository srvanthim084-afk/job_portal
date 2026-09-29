/* =====================================================================
   TEAMLINK — Job Sources (admin)

   Where the external jobs come from, and whether each source can
   actually run. Until now sources could only be created through the API:
   there was no screen, so "add Adzuna" meant a curl command and finding
   out it was misconfigured meant reading a server log.

   WHAT IT SHOWS, per source: the name, whether it is switched on,
   whether its credentials are present, when it last synced, how many
   jobs that sync returned, the last error in the provider's own words,
   and a Sync now button.

   NO KEY IS EVER SHOWN OR SENT. The screen asks the server which
   environment variables each connector needs and whether each NAME has
   something behind it. The values never leave the server, and there is
   nowhere on this page to type one - which is deliberate: a key pasted
   into a web form ends up in a database, a log and a backup.

   ADDITIVE. One nav entry, one screen, one script tag. Nothing existing
   is replaced; pageAdminDash is wrapped the same way Notification
   Settings wraps it.
   ===================================================================== */
(function () {
  'use strict';

  var S = { sources: [], connectors: [], loading: false, error: '', busy: {} };

  function api() { return (window.TL && window.TL.api) || null; }
  function esc(s) {
    return (typeof window.esc === 'function') ? window.esc(s)
      : String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
  }
  function toast(m, i) { if (typeof window.toast === 'function') window.toast(m, i || 'i'); }

  function when(iso) {
    if (!iso) return 'never';
    try {
      var d = new Date(iso);
      var mins = Math.round((Date.now() - d.getTime()) / 60000);
      if (mins < 1) return 'just now';
      if (mins < 60) return mins + ' min ago';
      if (mins < 1440) return Math.round(mins / 60) + ' h ago';
      return d.toLocaleDateString();
    } catch (e) { return String(iso); }
  }

  /* ------------------------------------------------------------------ *
   * loading
   * ------------------------------------------------------------------ */
  function load() {
    var a = api();
    if (!a) return;
    S.loading = true; S.error = '';
    paint();
    Promise.all([a.get('/external/sources'), a.get('/external/connectors')])
      .then(function (out) {
        S.sources = out[0].sources || [];
        S.connectors = out[1].connectors || [];
        S.loading = false;
        paint();
      }, function (e) {
        S.loading = false;
        S.error = (e && e.message) || 'The job sources could not be loaded.';
        paint();
      });
  }

  /* ------------------------------------------------------------------ *
   * the screen
   * ------------------------------------------------------------------ */
  function page() {
    setTimeout(load, 0);
    return '<div class="panel"><div class="panel-head"><div>'
      + '<h2>Job Sources</h2>'
      + '<div class="desc">Where external jobs are collected from. A source with no '
      + 'credentials is skipped and says so — it never returns anything made up.</div>'
      + '</div></div><div class="panel-body"><div id="jsHost"></div></div></div>'
      + '<div class="panel" style="margin-top:14px"><div class="panel-head"><div>'
      + '<h2>Available connectors</h2>'
      + '<div class="desc">Each board TeamLink can collect from, and what it needs. '
      + 'Keys are read from the server environment and are never shown here.</div>'
      + '</div></div><div class="panel-body"><div id="jsConnHost"></div></div></div>';
  }

  function paint() {
    var host = document.getElementById('jsHost');
    var conn = document.getElementById('jsConnHost');
    if (!host) return;

    if (S.loading) {
      host.innerHTML = '<div class="js-empty">Loading…</div>';
      if (conn) conn.innerHTML = '';
      return;
    }
    if (S.error) {
      host.innerHTML = '<div class="js-err">' + esc(S.error) + '</div>';
      return;
    }

    host.innerHTML = S.sources.length ? sourceTable() : '<div class="js-empty">'
      + '<b>No job sources yet</b>'
      + 'Add one from the list below and external jobs start arriving on the next sync.'
      + '</div>';

    if (conn) conn.innerHTML = connectorTable();
  }

  function statusPill(s) {
    var st = String(s.lastSyncStatus || '');
    if (!st) return '<span class="js-pill wait">never synced</span>';
    if (st === 'ok') return '<span class="js-pill ok">ok</span>';
    if (st === 'manual') return '<span class="js-pill wait">manual</span>';
    if (st === 'not_configured') return '<span class="js-pill warn">not configured</span>';
    return '<span class="js-pill bad">' + esc(st) + '</span>';
  }

  function sourceTable() {
    return '<table class="js-tbl"><thead><tr>'
      + '<th>Source</th><th>Collects via</th><th>Enabled</th><th>Configured</th>'
      + '<th>Last sync</th><th>Jobs</th><th>Last error</th><th></th>'
      + '</tr></thead><tbody>'
      + S.sources.map(function (s) {
        var busy = S.busy[s.id];
        /* A connector source's credentials are the connector's business,
           so the row asks the registry rather than guessing from the
           source row. */
        var c = S.connectors.filter(function (x) { return x.id === s.connector; })[0];
        var configured = s.collectionMethod === 'connector'
          ? (c ? c.configured : false)
          : (s.credentialConfigured !== false);

        return '<tr>'
          + '<td><b>' + esc(s.name) + '</b>'
            + (s.connector ? '<div class="js-sub">' + esc(s.connector) + '</div>' : '')
            + '</td>'
          + '<td>' + esc(s.collectionMethod || 'manual') + '</td>'
          + '<td>' + (s.active
              ? '<span class="js-pill ok">on</span>'
              : '<span class="js-pill wait">off</span>') + '</td>'
          + '<td>' + (configured
              ? '<span class="js-pill ok">yes</span>'
              : '<span class="js-pill warn">no</span>'
                + (c && c.missing && c.missing.length
                    ? '<div class="js-sub">' + esc(c.missing.join(', ')) + '</div>' : ''))
            + '</td>'
          + '<td>' + esc(when(s.lastSyncAt)) + '<div class="js-sub">'
            + statusPill(s) + '</div></td>'
          + '<td class="js-num">' + (s.lastSyncJobCount == null ? '—' : s.lastSyncJobCount)
            + '</td>'
          /* The provider's own words, not a category. A recruiter who is
             told "failed" and nothing else cannot fix anything. */
          + '<td class="js-errcell">' + (s.lastSyncError
              ? '<span title="' + esc(s.lastSyncError) + '">'
                + esc(String(s.lastSyncError).slice(0, 90)) + '</span>'
              : '—') + '</td>'
          + '<td class="js-actions">'
            + '<button class="btn btn-sm" onclick="jsSync(&quot;' + esc(s.id) + '&quot;)"'
            + (busy ? ' disabled' : '') + '>' + (busy ? 'Syncing…' : 'Sync now') + '</button>'
            + '<button class="btn btn-sm" onclick="jsToggle(&quot;' + esc(s.id) + '&quot;)">'
            + (s.active ? 'Disable' : 'Enable') + '</button>'
            + '</td>'
          + '</tr>';
      }).join('') + '</tbody></table>';
  }

  function connectorTable() {
    var have = {};
    S.sources.forEach(function (s) { if (s.connector) have[s.connector] = s; });

    return '<table class="js-tbl"><thead><tr>'
      + '<th>Connector</th><th>Needs</th><th>Status</th><th></th>'
      + '</tr></thead><tbody>'
      + S.connectors.map(function (c) {
        var added = have[c.id];
        return '<tr>'
          + '<td><b>' + esc(c.label) + '</b><div class="js-sub">' + esc(c.id) + '</div></td>'
          + '<td>' + (c.envKeys && c.envKeys.length
              ? '<code class="js-code">'
                + c.envKeys.map(esc).join('</code> <code class="js-code">') + '</code>'
              : '<span class="js-sub">nothing — public</span>') + '</td>'
          + '<td>' + (c.configured
              ? '<span class="js-pill ok">ready</span>'
              : '<span class="js-pill warn">not configured</span>')
            + (c.missing && c.missing.length
                ? '<div class="js-sub">missing: ' + esc(c.missing.join(', ')) + '</div>' : '')
            + (c.note ? '<div class="js-sub">' + esc(c.note) + '</div>' : '')
            + '</td>'
          + '<td class="js-actions">' + (added
              ? '<span class="js-sub">added as “' + esc(added.name) + '”</span>'
              : (c.configured
                  ? '<button class="btn btn-sm" onclick="jsAdd(&quot;' + esc(c.id)
                    + '&quot;,&quot;' + esc(c.label) + '&quot;)">Add source</button>'
                  /* Not offered rather than offered-and-refused: adding a
                     source that cannot run just creates a red row. */
                  : '<span class="js-sub">set its keys first</span>'))
            + '</td>'
          + '</tr>';
      }).join('') + '</tbody></table>';
  }

  /* ------------------------------------------------------------------ *
   * actions
   * ------------------------------------------------------------------ */
  window.jsSync = function (id) {
    var a = api();
    if (!a) return;
    S.busy[id] = true; paint();
    a.post('/external/sources/' + encodeURIComponent(id) + '/sync', {}).then(function (out) {
      S.busy[id] = false;
      /* What it actually did, not "done". A sync that saved nothing
         because the source is not configured is a different outcome from
         one that saved nothing because there was nothing new. */
      if (out.status === 'ok') {
        toast(out.saved + ' job(s) collected'
          + (out.skipped ? ', ' + out.skipped + ' skipped' : ''), '✅');
      } else if (out.status === 'not_configured') {
        toast('Not configured: ' + (out.error || 'credentials are missing'), '⚠️');
      } else if (out.status === 'manual') {
        toast('This source is entered by hand — there is nothing to sync', 'i');
      } else {
        toast('Sync failed: ' + (out.error || out.status), '⚠️');
      }
      load();
    }, function (e) {
      S.busy[id] = false;
      toast((e && e.message) || 'The sync could not be started', '⚠️');
      paint();
    });
  };

  window.jsToggle = function (id) {
    var a = api();
    var s = S.sources.filter(function (x) { return x.id === id; })[0];
    if (!a || !s) return;
    a.post('/external/sources', {
      id: s.id, name: s.name, sourceType: s.sourceType,
      collectionMethod: s.collectionMethod, connector: s.connector || undefined,
      applicationMethod: s.applicationMethod,
      feedUrl: s.feedUrl || undefined,
      active: !s.active,
    }).then(function () {
      toast(s.active ? 'Disabled — it will not sync again' : 'Enabled', '✅');
      load();
    }, function (e) { toast((e && e.message) || 'Could not change that', '⚠️'); });
  };

  window.jsAdd = function (connector, label) {
    var a = api();
    if (!a) return;
    a.post('/external/sources', {
      name: label, sourceType: 'job_board', collectionMethod: 'connector',
      connector: connector, applicationMethod: 'redirect', active: true,
    }).then(function () {
      toast(label + ' added — press Sync now to collect', '✅');
      load();
    }, function (e) { toast((e && e.message) || 'Could not add that source', '⚠️'); });
  };

  /* ------------------------------------------------------------------ *
   * slotting it in
   * ------------------------------------------------------------------ */
  (function hook() {
    var tries = 0;
    var timer = setInterval(function () {
      tries += 1;
      if (tries > 60) { clearInterval(timer); return; }
      if (typeof window.pageAdminDash !== 'function') return;
      clearInterval(timer);

      /*
       * One nav entry, appended. Nothing is reordered.
       *
       * NAV_CONFIG is declared with a top-level `const`, which lives in
       * the global LEXICAL scope rather than on `window` - so it is
       * reachable by name from this file and invisible to
       * `window.NAV_CONFIG`. Guarded either way: a missing nav costs the
       * menu entry, not the screen, which stays reachable by URL.
       */
      try {
        var nav = (typeof NAV_CONFIG !== 'undefined' && NAV_CONFIG.admin) || null;
        if (nav && !nav.some(function (n) { return n[0] === 'job-sources'; })) {
          nav.push(['job-sources', 'Job Sources', '🌐']);
        }
      } catch (e) { /* the screen is still reachable by URL */ }

      var prev = window.pageAdminDash;
      window.pageAdminDash = function (section) {
        if (section !== 'job-sources') return prev.apply(this, arguments);
        return (typeof window.dashShell === 'function')
          ? window.dashShell('admin', 'job-sources', 'Job Sources',
              'Admin · TeamLink Platform', page())
          : page();
      };
    }, 400);
  })();

  /* ------------------------------------------------------------------ *
   * styles
   * ------------------------------------------------------------------ */
  var css = ''
    + '.js-tbl{width:100%;border-collapse:collapse;font-size:12.5px}'
    + '.js-tbl th{text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;'
      + 'color:var(--text-soft,#7a8798);padding:7px 8px;border-bottom:1px solid var(--line,#e6ebf2)}'
    + '.js-tbl td{padding:10px 8px;border-bottom:1px solid var(--line-soft,#f1f4f8);'
      + 'vertical-align:top}'
    + '.js-sub{font-size:11px;color:var(--text-soft,#8895a7);margin-top:3px}'
    + '.js-num{font-variant-numeric:tabular-nums}'
    + '.js-errcell{max-width:230px;color:#b3261e;font-size:11.5px}'
    + '.js-actions{white-space:nowrap;display:flex;gap:6px;flex-wrap:wrap}'
    + '.js-pill{display:inline-block;border-radius:999px;padding:2px 9px;font-size:10.5px;'
      + 'font-weight:800}'
    + '.js-pill.ok{background:#e8f6ee;color:#1d7a45}'
    + '.js-pill.warn{background:#fdf3dc;color:#8a5a12}'
    + '.js-pill.bad{background:#fdeaea;color:#b3261e}'
    + '.js-pill.wait{background:#eef2f7;color:#5b6b82}'
    + '.js-code{background:#f1f5f9;border-radius:5px;padding:1px 6px;font-size:11px;'
      + 'color:#334155}'
    + '.js-empty{padding:30px 6px;text-align:center;color:var(--text-soft,#97a3b6);'
      + 'font-size:13.5px}'
    + '.js-empty b{display:block;color:var(--text,#16202c);font-size:15px;margin-bottom:4px}'
    + '.js-err{padding:14px;border:1px solid #f0c27a;background:#fff9ee;border-radius:9px;'
      + 'color:#8a5a12;font-size:12.5px}'
    + '@media (max-width:760px){.js-tbl,.js-tbl tbody,.js-tbl tr,.js-tbl td{display:block}'
      + '.js-tbl thead{display:none}.js-tbl td{border:0;padding:4px 8px}'
      + '.js-tbl tr{border-bottom:1px solid var(--line,#e6ebf2);padding:10px 0}}';

  var tag = document.createElement('style');
  tag.id = 'js-sources-css';
  tag.textContent = css;
  (document.head || document.documentElement).appendChild(tag);
})();
