/* =====================================================================
   TEAMLINK - Admin -> Audit Log (0119, recruiter activity since 0125)

   WHAT IT IS. What RECRUITERS did in the portal and for how long: every
   sign-in and sign-out, and what they did in between (jobs created,
   published, unpublished, drafts saved, candidates shortlisted, ...),
   newest first.

   RECRUITERS ONLY. The rows come from GET /api/admin/recruiter-activity,
   which keeps a row only when the acting account's role is recruiter -
   administrators, candidates, clients, BDEs and the system are left out by
   the query, not hidden here.

   TIME IN PORTAL. On a Logout row, logout minus login ("2h 05m"). A
   browser closed without signing out is signed out after 30 minutes
   without activity, at the last activity, as "Auto logged out" - by the
   server, not by this page. A session still running shows "Active now"
   and its duration, which this page keeps ticking.

   SUMMARY. Recruiters active now, time in portal today and this week in
   total, and per recruiter (Today / This week).

   WHAT IT DOES NOT DO. It cannot edit or delete an entry: the page only
   reads. The log is append-only in the database.

   ADDITIVE: one sidebar entry, one page. The Reports panel's audit list
   (GET /api/admin/audit-log) is unchanged.
   ===================================================================== */
(function () {
  'use strict';
  if (window.TLAuditLog) return;

  var S = { recruiter: '', action: '', from: '', to: '', page: 1, pageSize: 25, span: 'today', data: null, loading: false, open: {} };

  function api() { return window.TL && window.TL.api; }
  function h(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function qs() {
    var o = { recruiter: S.recruiter, action: S.action, from: S.from, to: S.to, page: S.page, pageSize: S.pageSize };
    return Object.keys(o).filter(function (k) { return o[k] !== '' && o[k] != null; })
      .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(o[k]); }).join('&');
  }
  /* "09 Oct 2026, 02:58 PM", India time */
  function when(v) {
    var d = new Date(v);
    if (isNaN(d)) return '—';
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })
      + ', ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
  }
  function dur(sec) {
    var s = Math.max(0, Math.floor(Number(sec) || 0));
    var hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60);
    return hh ? hh + 'h ' + (mm < 10 ? '0' : '') + mm + 'm' : mm + 'm';
  }
  function since(iso) { return (Date.now() - new Date(iso).getTime()) / 1000; }

  function css() {
    if (document.getElementById('tlalCss')) return;
    var s = document.createElement('style');
    s.id = 'tlalCss';
    s.textContent = ''
      + '.tlal-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:0 0 12px}'
      + '.tlal-bar input,.tlal-bar select{border:1px solid #cfd6e0;border-radius:6px;height:34px;padding:0 10px;font-size:13px;background:#fff;color:#33465c;box-sizing:border-box;max-width:220px}'
      + '.tlal-t{width:100%;border-collapse:collapse}'
      + '.tlal-t th{text-align:left;font-size:10.5px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:#7a8798;background:#f3f5f8;padding:9px 10px;border-bottom:1px solid #e6ebf2}'
      + '.tlal-t td{padding:10px;vertical-align:top;font-size:12.5px;border-bottom:1px solid #f1f4f8;overflow-wrap:anywhere}'
      + '.tlal-t td:nth-child(4){white-space:nowrap}.tlal-t td:nth-child(5){min-width:120px}'
      + '.tlal-who b{display:block;font-size:12.5px}.tlal-who span{color:#6a7a8c;font-size:11.5px}'
      + '.tlal-rec b{display:block}.tlal-rec span{color:#6a7a8c;font-size:11.5px;word-break:break-all}'
      + '.tlal-more{border:0;background:none;color:#3b4fd8;cursor:pointer;font-size:11.5px;padding:0;margin-left:6px}'
      + '.tlal-kv{margin-top:6px;border:1px solid #e6ebf2;border-radius:8px;background:#fafbfd;padding:6px 10px;font-size:11.5px}'
      + '.tlal-kv div{display:flex;gap:10px;padding:2px 0}.tlal-kv .k{flex:0 0 130px;color:#6a7a8c}.tlal-kv .v{word-break:break-word;white-space:pre-wrap}'
      + '.tlal-pg{display:flex;gap:10px;align-items:center;justify-content:space-between;margin:12px 0 0;flex-wrap:wrap}'
      + '.tlal-act{display:inline-block;max-width:100%;white-space:normal;line-height:1.35;border-radius:6px;padding:2px 8px;font-size:11.5px;font-weight:700;background:#eef2fb;color:#2f4a8a}'
      + '.tlal-act.warn{background:#fff1df;color:#8a5a12}.tlal-act.bad{background:#fdeaea;color:#b3261e}.tlal-act.ok{background:#e8f6ee;color:#1d7a45}'
      + '.tlal-muted{color:#6a7a8c;font-size:12.5px}'
      + '.tlal-live{color:#1d7a45;font-weight:700}.tlal-live:before{content:"";display:inline-block;width:7px;height:7px;border-radius:50%;background:#1d9a55;margin-right:6px;vertical-align:1px}'
      + '.tlal-sum{margin:0 0 16px}.tlal-sum .stat-row{margin-bottom:12px}'
      + '.tlal-per{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:10px}'
      + '.tlal-per .stat-tile{padding:12px 14px}.tlal-per .val{font-size:20px}'
      + '.tlal-seg{display:inline-flex;border:1px solid #cfd6e0;border-radius:7px;overflow:hidden}'
      + '.tlal-seg button{border:0;background:#fff;padding:5px 12px;font-size:12px;font-weight:700;color:#4a5b76;cursor:pointer}'
      + '.tlal-seg button.on{background:#eef2fb;color:#2f4a8a}'
      + '.tlal-perhead{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:0 0 8px;flex-wrap:wrap}';
    document.head.appendChild(s);
  }

  function tone(code) {
    if (code === 'auth.auto_logout' || code === 'job.closed') return 'bad';
    if (code === 'job.unpublished' || code === 'auth.logout') return 'warn';
    if (/^auth\.login|session_resumed|job\.created|job\.published|shortlisted/.test(code)) return 'ok';
    return '';
  }

  /* ---- the cards ------------------------------------------------------ */
  function summary() {
    var d = S.data; var sm = d && d.summary;
    if (!sm) return '';
    var tile = function (label, val, unit) {
      return '<div class="stat-tile"><div class="lbl">' + label + '</div><div class="val tabular">' + val + '</div>' + (unit ? '<div class="unit">' + unit + '</div>' : '') + '</div>';
    };
    var key = S.span === 'week' ? 'weekSeconds' : 'todaySeconds';
    var per = sm.byRecruiter.filter(function (x) { return x[key] || x.active; });
    var perHtml = per.map(function (x) {
      var secs = x[key];
      return '<div class="stat-tile"><div class="lbl">' + h(x.name || 'Recruiter') + '</div>'
        + '<div class="val tabular"' + (x.active ? ' data-tlal-plus="' + h(secs) + '" data-tlal-at="' + Date.now() + '"' : '') + '>' + dur(secs) + '</div>'
        + '<div class="unit">' + (x.active ? '<span class="tlal-live">Active now</span>' : (S.span === 'week' ? 'this week' : 'today')) + '</div></div>';
    }).join('') || '<div class="tlal-muted">No recruiter has been in the portal ' + (S.span === 'week' ? 'this week' : 'today') + '.</div>';
    return '<div class="tlal-sum"><div class="stat-row" style="grid-template-columns:repeat(3,minmax(0,1fr))">'
      + tile('Recruiters active now', sm.activeNow.toLocaleString('en-IN'), 'signed in, active in the last ' + h(d.idleMinutes) + ' min')
      + tile('Time in portal today', dur(sm.today.totalSeconds), sm.today.recruiters + ' recruiter' + (sm.today.recruiters === 1 ? '' : 's'))
      + tile('Time in portal this week', dur(sm.week.totalSeconds), sm.week.recruiters + ' recruiter' + (sm.week.recruiters === 1 ? '' : 's') + ' · since Monday')
      + '</div>'
      + '<div class="tlal-perhead"><b style="font-size:13px">Time in portal by recruiter</b><span class="tlal-seg" role="group" aria-label="Period">'
      + '<button class="' + (S.span === 'today' ? 'on' : '') + '" aria-pressed="' + (S.span === 'today') + '" onclick="TLAuditLog.span(\'today\')">Today</button>'
      + '<button class="' + (S.span === 'week' ? 'on' : '') + '" aria-pressed="' + (S.span === 'week') + '" onclick="TLAuditLog.span(\'week\')">This week</button></span></div>'
      + '<div class="tlal-per">' + perHtml + '</div></div>';
  }

  /* ---- a row --------------------------------------------------------- */
  function moduleCell(r) {
    if (!r.target) return '<b>' + h(r.module) + '</b>';
    return '<b>' + h(r.target.name || r.target.id) + '</b><span>' + h(r.module) + (r.target.name ? ' · ' + h(r.target.id) : '') + '</span>';
  }
  function timeCell(r) {
    var t = r.timeInPortal;
    if (!t) return '<span class="tlal-muted">—</span>';
    if (t.active) return '<span class="tlal-live">Active now</span><div class="tlal-muted" data-tlal-since="' + h(t.since) + '">' + dur(since(t.since)) + '</div>';
    return '<b>' + h(t.label) + '</b>' + (r.code === 'auth.auto_logout' ? '<div class="tlal-muted">no activity for ' + h(S.data.idleMinutes) + ' min</div>' : '');
  }
  function kv(r) {
    var out = [];
    var s = r.session;
    if (s) {
      out.push(['Signed in', when(s.loginAt)]);
      if (s.logoutAt) out.push([s.endReason === 'auto_timeout' ? 'Auto logged out' : 'Signed out', when(s.logoutAt)]);
      out.push(['Last activity', s.lastActivityAt ? when(s.lastActivityAt) : '—']);
      out.push(['Sign-in method', s.method || '—']);
      if (s.ip) out.push(['IP address', s.ip]);
      if (s.userAgent) out.push(['Device', s.userAgent]);
    }
    var d = r.detail || {};
    Object.keys(d).forEach(function (k) {
      if (s && (k === 'durationSeconds' || k === 'method' || k === 'lastActivityAt')) return;
      var v = d[k];
      out.push([k, v !== null && typeof v === 'object' ? JSON.stringify(v) : v]);
    });
    out.push(['Action code', r.code]);
    return '<div class="tlal-kv">' + out.map(function (x) {
      return '<div><span class="k">' + h(x[0]) + '</span><span class="v">' + h(x[1]) + '</span></div>';
    }).join('') + '</div>';
  }

  /* ---- the page ------------------------------------------------------ */
  function shell() {
    css();
    return '<div class="panel"><div class="panel-head"><div><h2>Audit Log</h2>'
      + '<div class="desc">What recruiters did in the portal, and for how long. Recruiter accounts only. Entries cannot be edited or deleted. Times are India time.</div></div>'
      + '<button class="btn btn-ghost btn-sm" style="margin-left:auto" onclick="TLAuditLog.exportCsv()">⭳ Export CSV</button></div>'
      + '<div class="panel-body"><div id="tlalSummary"></div><div id="tlalFilters"></div><div id="tlalBody"><div class="empty-note">Loading…</div></div></div></div>';
  }
  function opt(v, label, cur) { return '<option value="' + h(v) + '"' + (v === cur ? ' selected' : '') + '>' + h(label) + '</option>'; }
  function filters() {
    var d = S.data || { actions: [], recruiters: [] };
    return '<div class="tlal-bar">'
      + '<select aria-label="Recruiter" onchange="TLAuditLog.set(\'recruiter\',this.value)">' + opt('', 'All recruiters', S.recruiter)
      + d.recruiters.map(function (r) { return opt(r.userId, r.name, S.recruiter); }).join('') + '</select>'
      + '<select aria-label="Action type" onchange="TLAuditLog.set(\'action\',this.value)">' + opt('', 'All actions', S.action)
      + d.actions.map(function (a) { return opt(a.code, a.label, S.action); }).join('') + '</select>'
      + '<label class="tlal-muted">From <input type="date" aria-label="From" value="' + h(S.from) + '" onchange="TLAuditLog.set(\'from\',this.value)"></label>'
      + '<label class="tlal-muted">To <input type="date" aria-label="To" value="' + h(S.to) + '" onchange="TLAuditLog.set(\'to\',this.value)"></label>'
      + '<button class="btn btn-ghost btn-sm" onclick="TLAuditLog.clear()">Clear</button></div>';
  }
  function paintBody() {
    var sum = document.getElementById('tlalSummary');
    var f = document.getElementById('tlalFilters'); var b = document.getElementById('tlalBody');
    if (!b) return;
    var d = S.data;
    if (sum) sum.innerHTML = summary();
    if (f && !S._fd && d) { f.innerHTML = filters(); S._fd = true; }
    if (!d) { b.innerHTML = '<div class="empty-note">Loading…</div>'; return; }
    var rows = d.rows.map(function (r) {
      var open = !!S.open[r.id];
      return '<tr><td class="tlal-who"><b>' + h(r.recruiter.name || 'Recruiter') + '</b></td>'
        + '<td><span class="tlal-act ' + tone(r.code) + '">' + h(r.action) + '</span>'
        + '<button class="tlal-more" aria-expanded="' + open + '" onclick="TLAuditLog.toggle(\'' + h(r.id) + '\')">' + (open ? 'Hide' : 'Details') + '</button>'
        + (open ? kv(r) : '') + '</td>'
        + '<td class="tlal-rec">' + moduleCell(r) + '</td>'
        + '<td>' + h(when(r.at)) + '</td>'
        + '<td>' + timeCell(r) + '</td></tr>';
    }).join('') || '<tr><td colspan="5" class="empty-note">No recruiter activity matches.</td></tr>';
    var from = d.total ? (d.page - 1) * d.pageSize + 1 : 0;
    var to = Math.min(d.total, d.page * d.pageSize);
    var pages = Math.max(1, Math.ceil(d.total / d.pageSize));
    b.innerHTML = '<div class="tbl-wrap"><table class="tlal-t"><thead><tr><th>Recruiter</th><th>Action</th><th>Job / Module</th><th>Date and Time</th><th>Time in Portal</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
      + '<div class="tlal-pg"><span class="tlal-muted">Showing ' + from + '–' + to + ' of ' + d.total.toLocaleString('en-IN') + '</span>'
      + '<span><select aria-label="Rows per page" onchange="TLAuditLog.size(this.value)">' + [25, 50, 100].map(function (n) { return opt(String(n), n + ' per page', String(S.pageSize)); }).join('') + '</select> '
      + '<button class="btn btn-ghost btn-sm" ' + (d.page <= 1 ? 'disabled' : '') + ' onclick="TLAuditLog.go(' + (d.page - 1) + ')">‹ Previous</button> '
      + '<span class="tlal-muted">Page ' + d.page + ' of ' + pages + '</span> '
      + '<button class="btn btn-ghost btn-sm" ' + (d.page >= pages ? 'disabled' : '') + ' onclick="TLAuditLog.go(' + (d.page + 1) + ')">Next ›</button></span></div>';
  }
  /* The running durations of sessions still open. */
  function tick() {
    var els = document.querySelectorAll('[data-tlal-since]');
    for (var i = 0; i < els.length; i++) els[i].textContent = dur(since(els[i].getAttribute('data-tlal-since')));
    var plus = document.querySelectorAll('[data-tlal-plus]');
    for (var j = 0; j < plus.length; j++) {
      var base = Number(plus[j].getAttribute('data-tlal-plus')) || 0;
      var at = Number(plus[j].getAttribute('data-tlal-at')) || Date.now();
      plus[j].textContent = dur(base + (Date.now() - at) / 1000);
    }
  }
  var ticker = null;
  function startTick() {
    if (ticker) return;
    ticker = setInterval(function () {
      if (!document.getElementById('tlalBody')) { clearInterval(ticker); ticker = null; return; }
      tick();
    }, 15000);
  }

  var seq = 0;
  function load() {
    if (!api()) return;
    var mine = ++seq;
    S.loading = true;
    api().get('/admin/recruiter-activity?' + qs()).then(function (d) {
      if (mine !== seq) return;           // a newer question has been asked
      S.data = d; S.loading = false; S.open = {}; paintBody(); startTick();
    }, function (err) {
      S.loading = false;
      var b = document.getElementById('tlalBody');
      if (b) b.innerHTML = '<div class="empty-note">' + h((err && err.message) || 'The log could not be loaded.') + '</div>';
    });
  }

  window.TLAuditLog = {
    state: S,
    set: function (k, v) { S[k] = v; S.page = 1; load(); },
    clear: function () { S.recruiter = ''; S.action = ''; S.from = ''; S.to = ''; S.page = 1; S._fd = false; load(); },
    go: function (p) { S.page = Math.max(1, p); load(); },
    size: function (n) { S.pageSize = Number(n) || 25; S.page = 1; load(); },
    span: function (v) { S.span = v === 'week' ? 'week' : 'today'; var sum = document.getElementById('tlalSummary'); if (sum) sum.innerHTML = summary(); },
    toggle: function (id) { S.open[id] = !S.open[id]; paintBody(); },
    exportCsv: function () { window.location.href = (window.TL && TL.apiBase ? TL.apiBase : '/api') + '/admin/recruiter-activity/export?' + qs().replace(/(^|&)(page|pageSize)=[^&]*/g, ''); },
  };

  /* ---- wiring: one sidebar entry, one page ---------------------------- */
  function nav() { try { return typeof NAV_CONFIG !== 'undefined' ? NAV_CONFIG.admin : null; } catch (e) { return null; } }
  var drawn = false;
  function install() {
    if (typeof window.pageAdminDash !== 'function' || typeof window.dashShell !== 'function') return false;
    var n = nav();
    if (n && !n.some(function (x) { return x[0] === 'audit-log'; })) {
      var i = n.findIndex(function (x) { return x[0] === 'reports'; });
      n.splice(i >= 0 ? i + 1 : n.length, 0, ['audit-log', 'Audit Log', '🧾']);
    }
    if (!window.pageAdminDash.__tlal) {
      var prev = window.pageAdminDash;
      var wrapped = function (section) {
        if (section !== 'audit-log') return prev.apply(this, arguments);
        setTimeout(function () { S.data = null; S._fd = false; load(); }, 0);
        return window.dashShell('admin', 'audit-log', 'Audit Log', 'Admin · TeamLink Platform', shell());
      };
      wrapped.__tlal = true; window.pageAdminDash = wrapped;
    }
    /* A page opened by its URL was drawn before this existed: draw it once more. */
    if (!drawn && /^#\/admin\/audit-log/.test(location.hash || '') && window.STATE && STATE.session && typeof window.render === 'function') {
      drawn = true; window.render();
    }
    return true;
  }
  /* Other modules wrap the same function and rebuild the menu in no fixed
     order; stay on top for the first half-minute. */
  var tries = 0;
  var t = setInterval(function () { install(); if (++tries > 60) clearInterval(t); }, 500);
})();
