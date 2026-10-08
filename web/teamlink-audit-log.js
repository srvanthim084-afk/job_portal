/* =====================================================================
   TEAMLINK - Admin -> Audit Log (0119)

   WHAT IT IS. One page that answers "who did what, to which record, and
   when": every row of the portal's audit trail in one list, newest first -
   candidate and application changes, status moves, interviews, documents,
   resume changes, client logins, and (0118) team assignments, login email
   and status changes, the contact cooldown and each override with its
   reason.

   WHAT IT DOES. Search (record id, person, action, anything in the
   details), filter by action, record type, role and India-date range, page
   through, open a row for every recorded value, and export the filtered
   list as CSV (the export is itself logged).

   WHAT IT DOES NOT DO. It cannot edit or delete an entry: the page only
   reads GET /api/admin/audit-log. The log is append-only in the database.

   It used to be a panel at the foot of Reports; that panel is unchanged.
   ADDITIVE: one sidebar entry, one page.
   ===================================================================== */
(function () {
  'use strict';
  if (window.TLAuditLog) return;

  var S = { q: '', action: '', entity: '', role: '', from: '', to: '', page: 1, pageSize: 25, data: null, loading: false, open: {} };

  function api() { return window.TL && window.TL.api; }
  function h(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function qs() {
    var o = { q: S.q, action: S.action, entity: S.entity, actorRole: S.role, from: S.from, to: S.to, page: S.page, pageSize: S.pageSize };
    return Object.keys(o).filter(function (k) { return o[k] !== '' && o[k] != null; })
      .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(o[k]); }).join('&');
  }
  function when(v) {
    var d = new Date(v);
    if (isNaN(d)) return '—';
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }).replace(/ /g, '-')
      + ' ' + d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
  }

  function css() {
    if (document.getElementById('tlalCss')) return;
    var s = document.createElement('style');
    s.id = 'tlalCss';
    s.textContent = ''
      + '.tlal-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:0 0 12px}'
      + '.tlal-bar input,.tlal-bar select{border:1px solid #cfd6e0;border-radius:6px;height:34px;padding:0 10px;font-size:13px;background:#fff;color:#33465c;box-sizing:border-box;max-width:200px}'
      + '.tlal-bar input.q{min-width:230px}'
      + '.tlal-t{width:100%;border-collapse:collapse}'
      + '.tlal-t th{text-align:left;font-size:10.5px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:#7a8798;background:#f3f5f8;padding:9px 10px;border-bottom:1px solid #e6ebf2}'
      + '.tlal-t td{padding:10px;vertical-align:top;font-size:12.5px;border-bottom:1px solid #f1f4f8;overflow-wrap:anywhere}'
      + '.tlal-t td:nth-child(1){width:100px}.tlal-t td:nth-child(3){min-width:140px;max-width:190px}.tlal-t td:nth-child(5){min-width:170px}'
      + '.tlal-who b{display:block;font-size:12.5px}.tlal-who span{color:#6a7a8c;font-size:11.5px}'
      + '.tlal-rec b{display:block}.tlal-rec span{color:#6a7a8c;font-size:11.5px;word-break:break-all}'
      + '.tlal-sum{color:#33465c;line-height:1.45}'
      + '.tlal-more{border:0;background:none;color:#3b4fd8;cursor:pointer;font-size:11.5px;padding:0;margin-left:6px}'
      + '.tlal-kv{margin-top:6px;border:1px solid #e6ebf2;border-radius:8px;background:#fafbfd;padding:6px 10px;font-size:11.5px}'
      + '.tlal-kv div{display:flex;gap:10px;padding:2px 0}.tlal-kv .k{flex:0 0 130px;color:#6a7a8c}.tlal-kv .v{word-break:break-word;white-space:pre-wrap}'
      + '.tlal-pg{display:flex;gap:10px;align-items:center;justify-content:space-between;margin:12px 0 0;flex-wrap:wrap}'
      + '.tlal-role{display:inline-block;border-radius:999px;padding:1px 8px;font-size:10.5px;font-weight:800;background:#eef1f5;color:#4a5b76;margin-left:4px}'
      + '.tlal-act{display:inline-block;max-width:100%;white-space:normal;line-height:1.35;border-radius:6px;padding:2px 8px;font-size:11.5px;font-weight:700;background:#eef2fb;color:#2f4a8a}'
      + '.tlal-act.warn{background:#fff1df;color:#8a5a12}.tlal-act.bad{background:#fdeaea;color:#b3261e}.tlal-act.ok{background:#e8f6ee;color:#1d7a45}'
      + '.tlal-muted{color:#6a7a8c;font-size:12.5px}';
    document.head.appendChild(s);
  }

  /* ---- what a row says, in words ------------------------------------- */
  function nm(kind, id) {
    var n = S.data && S.data.names && S.data.names[kind + ':' + id];
    return n || id || '—';
  }
  function arrow(a, b) { return h(a == null || a === '' ? '—' : a) + ' → ' + h(b == null || b === '' ? '—' : b); }
  function summary(r) {
    var d = r.detail || {};
    switch (r.action) {
      case 'RECRUITER_EMAIL_CHANGED': return 'Email: ' + arrow(d.oldEmail, d.newEmail);
      case 'RECRUITER_ASSIGNED': return 'Team lead: ' + h(nm('recruiter', d.newTlId)) + ' · Department: ' + h(d.newDepartment || '—');
      case 'RECRUITER_REASSIGNED':
        return 'Team lead: ' + arrow(nm('recruiter', d.oldTlId), nm('recruiter', d.newTlId)) + ' · Department: ' + arrow(d.oldDepartment, d.newDepartment);
      case 'RECRUITER_UNASSIGNED': return 'Was under ' + h(nm('recruiter', d.oldTlId)) + ' (' + h(d.oldDepartment || '—') + ')';
      case 'RECRUITER_DEPARTMENT_CHANGED': return 'Department: ' + arrow(d.old, d.new);
      case 'RECRUITER_STATUS_CHANGED': return 'Status: ' + arrow(d.old, d.new);
      case 'TL_ROLE_CHANGED': return d.new ? 'Made a team lead' : 'No longer a team lead';
      case 'CONTACT_COOLDOWN_OVERRIDDEN':
        return 'Reason: “' + h(d.reason) + '” · ' + h(nm('candidate', d.candidateId)) + (d.previousBy ? ' · earlier contact by ' + h(d.previousBy) : '');
      case 'CONTACT_COOLDOWN_CHANGED': return 'Cooldown: ' + arrow(d.old, d.new) + ' days';
      case 'AUDIT_LOG_EXPORTED': return h(d.rows) + ' rows exported';
      case 'status.changed': return 'Stage: ' + arrow(d.from, d.to) + (d.override ? ' (override)' : '');
      default: {
        var keys = Object.keys(d).filter(function (k) { return d[k] != null && typeof d[k] !== 'object'; }).slice(0, 3);
        return keys.map(function (k) { return h(k) + ': ' + h(String(d[k]).slice(0, 80)); }).join(' · ') || '—';
      }
    }
  }
  function tone(a) {
    if (/blocked|denied|deleted/i.test(a)) return 'bad';
    if (/OVERRIDDEN|override|anyway|EXPORT|STATUS|UNASSIGNED/i.test(a)) return 'warn';
    if (/created|submitted|ASSIGNED|approved/i.test(a)) return 'ok';
    return '';
  }
  function kv(r) {
    var d = r.detail || {};
    var keys = Object.keys(d);
    if (!keys.length) return '<div class="tlal-muted">Nothing more was recorded.</div>';
    return '<div class="tlal-kv">' + keys.map(function (k) {
      var v = d[k];
      return '<div><span class="k">' + h(k) + '</span><span class="v">' + h(v !== null && typeof v === 'object' ? JSON.stringify(v) : v) + '</span></div>';
    }).join('') + '</div>';
  }

  /* ---- the page ------------------------------------------------------ */
  function shell() {
    css();
    return '<div class="panel"><div class="panel-head"><div><h2>Audit Log</h2>'
      + '<div class="desc">Who did what, to which record, and when. Entries cannot be edited or deleted. Times are India time.</div></div>'
      + '<button class="btn btn-ghost btn-sm" style="margin-left:auto" onclick="TLAuditLog.exportCsv()">⭳ Export CSV</button></div>'
      + '<div class="panel-body"><div id="tlalFilters"></div><div id="tlalBody"><div class="empty-note">Loading…</div></div></div></div>';
  }
  function opt(v, label, cur) { return '<option value="' + h(v) + '"' + (v === cur ? ' selected' : '') + '>' + h(label) + '</option>'; }
  function filters() {
    var d = S.data || { actions: [], entities: [] };
    return '<div class="tlal-bar">'
      + '<input class="q" id="tlalQ" type="search" placeholder="Search record, person, action or detail" value="' + h(S.q) + '" oninput="TLAuditLog.set(\'q\',this.value)">'
      + '<select aria-label="Action" onchange="TLAuditLog.set(\'action\',this.value)">' + opt('', 'All actions', S.action)
      + d.actions.map(function (a) { return opt(a.id, a.label, S.action); }).join('') + '</select>'
      + '<select aria-label="Record type" onchange="TLAuditLog.set(\'entity\',this.value)">' + opt('', 'All records', S.entity)
      + d.entities.map(function (e) { return opt(e, e.charAt(0).toUpperCase() + e.slice(1), S.entity); }).join('') + '</select>'
      + '<select aria-label="Role" onchange="TLAuditLog.set(\'role\',this.value)">' + opt('', 'Any role', S.role)
      + ['admin', 'recruiter', 'candidate', 'client', 'bde', 'system'].map(function (r) { return opt(r, r.charAt(0).toUpperCase() + r.slice(1), S.role); }).join('') + '</select>'
      + '<label class="tlal-muted">From <input type="date" aria-label="From" value="' + h(S.from) + '" onchange="TLAuditLog.set(\'from\',this.value)"></label>'
      + '<label class="tlal-muted">To <input type="date" aria-label="To" value="' + h(S.to) + '" onchange="TLAuditLog.set(\'to\',this.value)"></label>'
      + '<button class="btn btn-ghost btn-sm" onclick="TLAuditLog.clear()">Clear</button></div>';
  }
  function paintBody() {
    var f = document.getElementById('tlalFilters'); var b = document.getElementById('tlalBody');
    if (!b) return;
    if (f && !S._fd && S.data) { f.innerHTML = filters(); S._fd = true; }
    var d = S.data;
    if (!d) { b.innerHTML = '<div class="empty-note">Loading…</div>'; return; }
    var rows = d.rows.map(function (r) {
      var open = !!S.open[r.id];
      return '<tr><td>' + h(when(r.at)) + '</td>'
        + '<td class="tlal-who"><b>' + h(r.userName || r.user) + '</b><span>' + (r.userName ? h(r.user) : '') + '</span>' + (r.role ? '<span class="tlal-role">' + h(r.role) + '</span>' : '') + '</td>'
        + '<td><span class="tlal-act ' + tone(r.action) + '">' + h(r.actionLabel) + '</span></td>'
        + '<td class="tlal-rec"><b>' + h(r.entityName || r.entityId) + '</b><span>' + h(r.entity) + (r.entityName ? ' · ' + h(r.entityId) : '') + '</span></td>'
        + '<td class="tlal-sum">' + summary(r)
        + '<button class="tlal-more" aria-expanded="' + open + '" onclick="TLAuditLog.toggle(\'' + h(r.id) + '\')">' + (open ? 'Hide' : 'All details') + '</button>'
        + (open ? kv(r) : '') + '</td></tr>';
    }).join('') || '<tr><td colspan="5" class="empty-note">Nothing in the log matches.</td></tr>';
    var from = d.total ? (d.page - 1) * d.pageSize + 1 : 0;
    var to = Math.min(d.total, d.page * d.pageSize);
    var pages = Math.max(1, Math.ceil(d.total / d.pageSize));
    b.innerHTML = '<div class="tbl-wrap"><table class="tlal-t"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Record</th><th>Details</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
      + '<div class="tlal-pg"><span class="tlal-muted">Showing ' + from + '–' + to + ' of ' + d.total + '</span>'
      + '<span><select aria-label="Rows per page" onchange="TLAuditLog.size(this.value)">' + [25, 50, 100].map(function (n) { return opt(String(n), n + ' per page', String(S.pageSize)); }).join('') + '</select> '
      + '<button class="btn btn-ghost btn-sm" ' + (d.page <= 1 ? 'disabled' : '') + ' onclick="TLAuditLog.go(' + (d.page - 1) + ')">‹ Previous</button> '
      + '<span class="tlal-muted">Page ' + d.page + ' of ' + pages + '</span> '
      + '<button class="btn btn-ghost btn-sm" ' + (d.page >= pages ? 'disabled' : '') + ' onclick="TLAuditLog.go(' + (d.page + 1) + ')">Next ›</button></span></div>';
  }
  var seq = 0;
  function load() {
    if (!api()) return;
    var mine = ++seq;
    S.loading = true;
    api().get('/admin/audit-log?' + qs()).then(function (d) {
      if (mine !== seq) return;           // a newer question has been asked
      S.data = d; S.loading = false; S.open = {}; paintBody();
    }, function (err) {
      S.loading = false;
      var b = document.getElementById('tlalBody');
      if (b) b.innerHTML = '<div class="empty-note">' + h((err && err.message) || 'The log could not be loaded.') + '</div>';
    });
  }

  var timer = null;
  window.TLAuditLog = {
    state: S,
    set: function (k, v) {
      S[k] = v; S.page = 1;
      clearTimeout(timer);
      timer = setTimeout(load, k === 'q' ? 300 : 0);
    },
    clear: function () { S.q = ''; S.action = ''; S.entity = ''; S.role = ''; S.from = ''; S.to = ''; S.page = 1; S._fd = false; load(); },
    go: function (p) { S.page = Math.max(1, p); load(); },
    size: function (n) { S.pageSize = Number(n) || 25; S.page = 1; load(); },
    toggle: function (id) { S.open[id] = !S.open[id]; paintBody(); },
    exportCsv: function () { window.location.href = (window.TL && TL.apiBase ? TL.apiBase : '/api') + '/admin/audit-log/export?' + qs().replace(/(^|&)(page|pageSize)=[^&]*/g, ''); },
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
