/*
 * Templates & Campaigns (0157) - one button in the Recruiter Portal's shared header, one popup over whatever page is open.
 *
 * The button is part of the shared dashboard header (dashShell in index.html) and is drawn ONLY for the recruiter role, so the
 * candidate, admin, client and BDE shells - and every other application - are untouched. The popup is one element on <body>
 * (never a second one), so opening and closing it leaves the page underneath exactly as it was.
 *
 * It reads and writes through /api/comm/*: the server decides what each person may do (edit your own, review as an administrator or
 * a team lead who did not write it, built-in templates are read-only) and says so per row; the buttons here only follow that.
 */
(function () {
  'use strict';

  var COLS = [['template', 'Template'], ['channel', 'Channel'], ['usedIn', 'Used In'], ['department', 'Department'],
              ['approval', 'Approval'], ['version', 'Version'], ['actions', 'Actions']];
  var ALWAYS = { template: 1, actions: 1 };
  var CHANNELS = [['', 'All channels'], ['call', 'Call'], ['email', 'Email'], ['sms', 'SMS'], ['whatsapp', 'WhatsApp']];
  var CH_LABEL = { call: 'Call', email: 'Email', sms: 'SMS', whatsapp: 'WhatsApp' };
  var APPROVALS = [['', 'Any approval state'], ['approved', 'Approved'], ['waiting', 'Waiting for approval'], ['changes_needed', 'Changes needed']];
  var APPROVAL_LABEL = { approved: 'Approved', waiting: 'Waiting for approval', changes_needed: 'Changes needed' };
  var CAMP_STATUS = { draft: 'Draft', running: 'Running', paused: 'Paused', completed: 'Completed', cancelled: 'Cancelled' };

  var S = {
    open: false, tab: 'templates', channel: '', dept: '', approval: '', q: '', archived: false,
    loading: false, error: '', templates: null, campaigns: null, departments: [], perms: { canCreate: false, canReview: false },
    view: null,            // {type:'template'|'campaign'|'edit'|'review', ...}
    cols: loadCols(), busy: false, colsOpen: false, timer: null, seq: 0, lastFocus: null,
  };

  function api() { return window.TL && window.TL.api; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function toast(m, i) { if (typeof window.toast === 'function') { try { window.toast(m, i || 'ℹ️'); } catch (e) { /* no toast */ } } }
  function errText(e) { return (e && e.message) ? String(e.message) : 'Something went wrong. Please try again.'; }
  function loadCols() {
    var on = {}; COLS.forEach(function (c) { on[c[0]] = true; });
    try {
      var saved = JSON.parse(localStorage.getItem('tc_cols') || 'null');
      if (saved && typeof saved === 'object') COLS.forEach(function (c) { if (saved[c[0]] === false && !ALWAYS[c[0]]) on[c[0]] = false; });
    } catch (e) { /* unreadable: all columns */ }
    return on;
  }
  function saveCols() { try { localStorage.setItem('tc_cols', JSON.stringify(S.cols)); } catch (e) { /* private window */ } }

  /* ------------------------------------------------------------------ *
   * the button (drawn by dashShell for the recruiter role only)
   * ------------------------------------------------------------------ */
  window.tcHeaderButtonHtml = function () {
    return '<button type="button" class="tc-hbtn" id="tcHeaderBtn" onclick="tcOpen()" title="Templates &amp; Campaigns"'
      + ' aria-haspopup="dialog"><span class="tc-hico" aria-hidden="true">✉️</span><span class="tc-htxt">Templates &amp; Campaigns</span></button>';
  };

  /* ------------------------------------------------------------------ *
   * styles
   * ------------------------------------------------------------------ */
  function addStyle() {
    if (document.getElementById('tc-style')) return;
    var css = ''
      + '.tc-hbtn{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--border,#dde2ea);background:var(--surface,#fff);color:var(--ink-800,#141d2e);'
        + 'border-radius:10px;padding:8px 13px;font-weight:650;font-size:13px;cursor:pointer;white-space:nowrap;margin-right:8px}'
      + '.tc-hbtn:hover{border-color:var(--brand-500,#1490b3);color:var(--brand-600,#0b6e8f)}'
      + '@media (max-width:900px){.tc-htxt{display:none}.tc-hbtn{padding:8px 10px}}'
      + '.tc-ov{position:fixed;inset:0;z-index:9400;background:rgba(11,18,32,.55);display:flex;align-items:center;justify-content:center;padding:18px}'
      + '.tc-modal{background:var(--surface,#fff);color:var(--ink-900,#0b1220);width:min(1180px,100%);max-height:calc(100vh - 36px);display:flex;flex-direction:column;'
        + 'border-radius:14px;box-shadow:0 24px 60px rgba(0,0,0,.3);overflow:hidden}'
      + '.tc-head{display:flex;align-items:center;gap:12px;padding:16px 20px;border-bottom:1px solid var(--border,#dde2ea)}'
      + '.tc-head h2{margin:0;font-size:19px;flex:1}'
      + '.tc-x{border:0;background:transparent;font-size:20px;line-height:1;cursor:pointer;color:var(--ink-500,#5b6678);padding:4px 8px;border-radius:8px}'
      + '.tc-x:hover{background:var(--paper-50,#eef1f5)}'
      + '.tc-tabs{display:flex;gap:4px;padding:10px 20px 0;border-bottom:1px solid var(--border,#dde2ea)}'
      + '.tc-tab{border:0;background:transparent;padding:9px 14px;font-weight:700;font-size:13.5px;color:var(--ink-500,#5b6678);cursor:pointer;border-bottom:3px solid transparent}'
      + '.tc-tab.on{color:var(--brand-600,#0b6e8f);border-bottom-color:var(--brand-600,#0b6e8f)}'
      + '.tc-tab span{font-weight:600;background:var(--paper-50,#eef1f5);border-radius:999px;padding:1px 8px;margin-left:6px;font-size:11.5px}'
      + '.tc-bar{display:flex;flex-wrap:wrap;gap:10px;padding:14px 20px;align-items:center}'
      + '.tc-bar select,.tc-bar input[type=search]{border:1px solid var(--border,#dde2ea);border-radius:9px;padding:8px 10px;font:inherit;font-size:13px;background:var(--surface,#fff);min-width:0}'
      + '.tc-bar input[type=search]{flex:1;min-width:160px}'
      + '.tc-colwrap{position:relative}'
      + '.tc-colmenu{position:absolute;right:0;top:calc(100% + 6px);z-index:3;background:var(--surface,#fff);border:1px solid var(--border,#dde2ea);border-radius:10px;'
        + 'box-shadow:0 10px 30px rgba(0,0,0,.15);padding:8px 12px;min-width:190px}'
      + '.tc-colmenu label{display:flex;gap:8px;align-items:center;padding:5px 0;font-size:13px;cursor:pointer}'
      + '.tc-body{overflow:auto;padding:0 20px 18px;flex:1;min-height:180px}'
      + '.tc-table{width:100%;border-collapse:collapse;font-size:13px}'
      + '.tc-table th{position:sticky;top:0;background:var(--paper-50,#eef1f5);text-align:left;font-size:11.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--ink-500,#5b6678);padding:9px 10px;white-space:nowrap}'
      + '.tc-table td{padding:10px;border-bottom:1px solid var(--border,#dde2ea);vertical-align:top}'
      + '.tc-name{font-weight:700}.tc-sub{color:var(--ink-500,#5b6678);font-size:12px;margin-top:2px}'
      + '.tc-chip{display:inline-block;border-radius:999px;padding:2px 9px;font-size:11.5px;font-weight:700;background:var(--paper-50,#eef1f5);margin:0 4px 3px 0;white-space:nowrap}'
      + '.tc-ok{background:var(--ok-100,#e2f5ec);color:var(--ok-600,#1e8e5a)}.tc-wait{background:var(--warn-100,#fbeed8);color:var(--warn-600,#a5670f)}'
      + '.tc-bad{background:var(--bad-100,#fbe4e1);color:var(--bad-600,#c0392b)}'
      + '.tc-act{display:flex;flex-wrap:wrap;gap:5px}'
      + '.tc-act button,.tc-btn{border:1px solid var(--border,#dde2ea);background:var(--surface,#fff);border-radius:8px;padding:5px 10px;font:inherit;font-size:12.5px;font-weight:650;cursor:pointer}'
      + '.tc-act button:hover,.tc-btn:hover{border-color:var(--brand-500,#1490b3)}'
      + '.tc-btn.p{background:var(--brand-600,#0b6e8f);border-color:var(--brand-600,#0b6e8f);color:#fff}'
      + '.tc-btn[disabled],.tc-act button[disabled]{opacity:.5;cursor:not-allowed}'
      + '.tc-state{padding:34px 10px;text-align:center;color:var(--ink-500,#5b6678);font-size:14px}'
      + '.tc-err{background:var(--bad-100,#fbe4e1);color:var(--bad-600,#c0392b);border-radius:10px;padding:10px 14px;margin:10px 0;font-size:13.5px}'
      + '.tc-form{display:grid;gap:12px;max-width:760px;padding:6px 0 4px}'
      + '.tc-form label{display:block;font-size:12px;font-weight:700;color:var(--ink-700,#2c3648);margin-bottom:4px}'
      + '.tc-form input,.tc-form select,.tc-form textarea{width:100%;box-sizing:border-box;border:1px solid var(--border,#dde2ea);border-radius:9px;padding:9px 10px;font:inherit;font-size:13.5px}'
      + '.tc-form textarea{min-height:170px;resize:vertical}'
      + '.tc-pre{white-space:pre-wrap;background:var(--paper-50,#eef1f5);border-radius:10px;padding:12px 14px;font-size:13px;line-height:1.55}'
      + '.tc-kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin:8px 0 14px}'
      + '.tc-kv div{background:var(--paper-50,#eef1f5);border-radius:10px;padding:9px 12px}.tc-kv b{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--ink-500,#5b6678)}'
      + '@media (max-width:700px){.tc-ov{padding:0}.tc-modal{max-height:100vh;height:100vh;border-radius:0}.tc-bar select{flex:1}}';
    var st = document.createElement('style'); st.id = 'tc-style'; st.textContent = css; document.head.appendChild(st);
  }

  /* ------------------------------------------------------------------ *
   * data
   * ------------------------------------------------------------------ */
  function qs() {
    var p = [];
    if (S.channel) p.push('channel=' + encodeURIComponent(S.channel));
    if (S.dept) p.push('department=' + encodeURIComponent(S.dept));
    if (S.tab === 'templates' && S.approval) p.push('approval=' + encodeURIComponent(S.approval));
    if (S.q) p.push('q=' + encodeURIComponent(S.q));
    if (S.tab === 'templates' && S.archived) p.push('archived=true');
    return p.length ? '?' + p.join('&') : '';
  }
  function load(keepCounts) {
    if (!api()) { S.error = 'The portal is not ready yet. Please try again in a moment.'; paint(); return; }
    var my = ++S.seq;
    S.loading = true; S.error = ''; paintBody();
    var calls = [api().get('/comm/templates' + (S.tab === 'templates' ? qs() : '')), api().get('/comm/campaigns' + (S.tab === 'campaigns' ? qs() : ''))];
    Promise.all(calls).then(function (r) {
      if (my !== S.seq) return;            // a newer request replaced this one
      S.loading = false;
      if (S.tab === 'templates') S.templates = r[0].templates || []; else S.campaigns = r[1].campaigns || [];
      if (!keepCounts || S.tab === 'templates') S.perms = r[0].permissions || S.perms;
      S.departments = r[0].departments || S.departments;
      /* the other tab's count, kept current without showing it */
      if (S.tab === 'templates' && !S.campaigns) S.campaigns = r[1].campaigns || [];
      if (S.tab === 'campaigns' && !S.templates) S.templates = r[0].templates || [];
      paint();
    }, function (e) {
      if (my !== S.seq) return;
      S.loading = false; S.error = errText(e); paintBody();
    });
  }

  /* ------------------------------------------------------------------ *
   * painting
   * ------------------------------------------------------------------ */
  function root() { return document.getElementById('tcRoot'); }

  function toolbarHtml() {
    var camp = S.tab === 'campaigns';
    var deptOpts = '<option value="">Any department</option>' + S.departments.map(function (d) {
      return '<option value="' + esc(d) + '"' + (S.dept === d ? ' selected' : '') + '>' + esc(d) + '</option>'; }).join('');
    return '<div class="tc-bar" role="search">'
      + '<select id="tcChannel" aria-label="Channel" onchange="tcSet(\'channel\',this.value)">' + CHANNELS.map(function (c) {
          return '<option value="' + c[0] + '"' + (S.channel === c[0] ? ' selected' : '') + '>' + c[1] + '</option>'; }).join('') + '</select>'
      + '<select id="tcDept" aria-label="Department" onchange="tcSet(\'dept\',this.value)">' + deptOpts + '</select>'
      + (camp ? '' : '<select id="tcApproval" aria-label="Approval state" onchange="tcSet(\'approval\',this.value)">' + APPROVALS.map(function (c) {
          return '<option value="' + c[0] + '"' + (S.approval === c[0] ? ' selected' : '') + '>' + c[1] + '</option>'; }).join('') + '</select>')
      + '<input type="search" id="tcSearch" placeholder="Search ' + (camp ? 'campaigns' : 'templates') + '…" value="' + esc(S.q) + '" aria-label="Search" oninput="tcSearch(this.value)">'
      + (camp ? '' : '<label class="tc-sub" style="display:flex;gap:6px;align-items:center;cursor:pointer"><input type="checkbox" ' + (S.archived ? 'checked ' : '') + 'onchange="tcSet(\'archived\',this.checked)"> Archived</label>')
      + '<div class="tc-colwrap"><button type="button" class="tc-btn" id="tcColsBtn" aria-haspopup="true" aria-expanded="' + (S.colsOpen ? 'true' : 'false') + '" onclick="tcToggleCols(event)">Columns ▾</button>'
      + (S.colsOpen ? '<div class="tc-colmenu" role="menu">' + COLS.map(function (c) {
          return '<label><input type="checkbox" ' + (S.cols[c[0]] ? 'checked ' : '') + (ALWAYS[c[0]] ? 'disabled ' : '')
            + 'onchange="tcCol(\'' + c[0] + '\',this.checked)"> ' + esc(c[1] === 'Template' && camp ? 'Campaign' : c[1]) + '</label>'; }).join('') + '</div>' : '')
      + '</div>'
      + (!camp && S.perms.canCreate ? '<button type="button" class="tc-btn p" onclick="tcNew()">+ New template</button>' : '')
      /* 0158: an administrator manages the WhatsApp Business templates (the ones that can be sent through the WhatsApp API) */
      + (!camp && S.perms.role === 'admin' && S.channel === 'whatsapp' && typeof window.tlWaTemplateForm === 'function'
          ? '<button type="button" class="tc-btn p" onclick="tcNewWa()">+ WhatsApp Business template</button>'
            + '<button type="button" class="tc-btn" onclick="tcSyncWa()" title="Pull the templates WhatsApp has approved into this list">Sync from WhatsApp Business</button>' : '')
      + '</div>';
  }

  function approvalChip(t) {
    var cls = t.approval === 'approved' ? 'tc-ok' : t.approval === 'waiting' ? 'tc-wait' : 'tc-bad';
    return '<span class="tc-chip ' + cls + '"' + (t.approvalNote ? ' title="' + esc(t.approvalNote) + '"' : '') + '>' + esc(APPROVAL_LABEL[t.approval] || t.approval) + '</span>'
      + (t.approval === 'changes_needed' && t.approvalNote ? '<div class="tc-sub">' + esc(t.approvalNote) + '</div>' : '');
  }
  function usedInHtml(list) {
    return (list && list.length) ? list.map(function (u) { return '<span class="tc-chip">' + esc(u) + '</span>'; }).join('') : '<span class="tc-sub">—</span>';
  }

  function tableHtml() {
    if (S.loading) return '<div class="tc-state" role="status">Loading ' + (S.tab === 'campaigns' ? 'campaigns' : 'templates') + '…</div>';
    if (S.error) return '<div class="tc-err" role="alert">' + esc(S.error) + ' <button type="button" class="tc-btn" onclick="tcReload()">Try again</button></div>';
    var rows = S.tab === 'campaigns' ? S.campaigns : S.templates;
    if (!rows) return '<div class="tc-state">Loading…</div>';
    if (!rows.length) {
      var any = S.channel || S.dept || S.approval || S.q;
      return '<div class="tc-state">' + (any ? 'Nothing matches these filters.<br><button type="button" class="tc-btn" style="margin-top:10px" onclick="tcClear()">Clear filters</button>'
        : (S.tab === 'campaigns' ? 'No campaigns yet. AI calling campaigns and WhatsApp sends appear here.' : 'No templates yet.')) + '</div>';
    }
    var camp = S.tab === 'campaigns';
    var head = COLS.filter(function (c) { return S.cols[c[0]]; }).map(function (c) {
      return '<th scope="col">' + esc(c[0] === 'template' && camp ? 'Campaign' : c[1]) + '</th>'; }).join('');
    var body = rows.map(function (t) {
      var cells = [];
      if (S.cols.template) {
        cells.push('<td><div class="tc-name">' + esc(t.name) + '</div>'
          + (camp ? '<div class="tc-sub">' + esc(CAMP_STATUS[t.status] || t.status) + (t.owner ? ' · ' + esc(t.owner) : '') + '</div>'
            : '<div class="tc-sub">' + (t.source === 'system' ? 'Built in' : 'By ' + esc(t.createdBy || '—')) + (t.archived ? ' · Archived' : '') + '</div>') + '</td>');
      }
      if (S.cols.channel) cells.push('<td><span class="tc-chip">' + esc(CH_LABEL[t.channel] || t.channel) + '</span>'
        + (t.wa ? '<div class="tc-sub">' + esc(t.wa.waName) + ' · ' + esc(t.wa.language) + '</div><span class="tc-chip ' + (t.wa.status === 'approved' ? 'tc-ok' : 'tc-wait') + '">WhatsApp: ' + esc(t.wa.status || 'not submitted') + '</span>' : '') + '</td>');
      if (S.cols.usedIn) cells.push('<td>' + usedInHtml(t.usedIn) + '</td>');
      if (S.cols.department) cells.push('<td>' + esc(t.department) + '</td>');
      if (S.cols.approval) cells.push('<td>' + (camp ? '<span class="tc-sub">—</span>' : approvalChip(t)) + '</td>');
      if (S.cols.version) cells.push('<td>' + (camp ? '<span class="tc-sub">—</span>' : 'v' + esc(t.version)) + '</td>');
      if (S.cols.actions) {
        var id = esc(t.id);
        cells.push('<td><div class="tc-act">'
          + '<button type="button" onclick="tcView(\'' + id + '\')">' + (camp ? 'Details' : 'View') + '</button>'
          + (!camp && t.canEdit ? '<button type="button" onclick="tcEdit(\'' + id + '\')">Edit</button>' : '')
          + (!camp && t.canReview ? '<button type="button" onclick="tcApprove(\'' + id + '\')">Approve</button><button type="button" onclick="tcChanges(\'' + id + '\')">Changes</button>' : '')
          + (!camp && t.canDuplicate ? '<button type="button" onclick="tcDuplicate(\'' + id + '\')">Duplicate</button>' : '')
          + (!camp && t.canArchive ? '<button type="button" onclick="tcArchive(\'' + id + '\',' + (t.archived ? 'false' : 'true') + ')">' + (t.archived ? 'Restore' : 'Archive') + '</button>' : '')
          + '</div></td>');
      }
      return '<tr>' + cells.join('') + '</tr>';
    }).join('');
    return '<div style="overflow-x:auto"><table class="tc-table"><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table></div>';
  }

  function listHtml() {
    var tn = S.templates ? S.templates.length : 0, cn = S.campaigns ? S.campaigns.length : 0;
    return '<div class="tc-tabs" role="tablist">'
      + '<button type="button" class="tc-tab' + (S.tab === 'templates' ? ' on' : '') + '" role="tab" aria-selected="' + (S.tab === 'templates') + '" onclick="tcTab(\'templates\')">Templates<span>' + tn + '</span></button>'
      + '<button type="button" class="tc-tab' + (S.tab === 'campaigns' ? ' on' : '') + '" role="tab" aria-selected="' + (S.tab === 'campaigns') + '" onclick="tcTab(\'campaigns\')">Campaigns<span>' + cn + '</span></button></div>'
      + toolbarHtml() + '<div class="tc-body" id="tcBody">' + tableHtml() + '</div>';
  }

  function find(id) {
    var all = (S.templates || []).concat(S.campaigns || []);
    for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
    return null;
  }

  function detailHtml() {
    var v = S.view, t = v.item;
    if (v.type === 'campaign' && t.channel === 'whatsapp') {
      return '<div class="tc-body"><button type="button" class="tc-btn" onclick="tcBack()">← Back</button>'
        + '<h3 style="margin:14px 0 4px">' + esc(t.name) + '</h3><div class="tc-sub">WhatsApp campaign</div>'
        + '<div class="tc-kv"><div><b>Channel</b>WhatsApp</div><div><b>Status</b>' + esc(CAMP_STATUS[t.status] || t.status) + '</div>'
        + '<div><b>Template</b>' + esc((t.usedIn || []).join(', ') || '—') + '</div><div><b>Sent by</b>' + esc(t.owner || '—') + '</div>'
        + '<div><b>Messages</b>' + esc(t.messages) + '</div><div><b>Sent</b>' + esc(t.sent) + '</div><div><b>Delivered</b>' + esc(t.delivered) + '</div>'
        + '<div><b>Read</b>' + esc(t.read) + '</div><div><b>Failed</b>' + esc(t.failed) + '</div><div><b>Pending</b>' + esc(t.pending) + '</div>'
        + '<div><b>Started</b>' + esc(t.createdAt ? new Date(t.createdAt).toLocaleString() : '—') + '</div></div>'
        + '<div class="tc-act"><button type="button" onclick="tcOpenWa(\'' + esc(t.batchId) + '\')">Open results</button></div></div>';
    }
    if (v.type === 'campaign') {
      return '<div class="tc-body"><button type="button" class="tc-btn" onclick="tcBack()">← Back</button>'
        + '<h3 style="margin:14px 0 4px">' + esc(t.name) + '</h3><div class="tc-sub">AI calling campaign</div>'
        + '<div class="tc-kv"><div><b>Channel</b>Call</div><div><b>Status</b>' + esc(CAMP_STATUS[t.status] || t.status) + '</div>'
        + '<div><b>Used in</b>' + esc((t.usedIn || []).join(', ') || '—') + '</div><div><b>Department</b>' + esc(t.department) + '</div>'
        + '<div><b>Owner</b>' + esc(t.owner || '—') + '</div><div><b>Calls made</b>' + esc(t.calls) + ' of up to ' + esc(t.maxCalls) + '</div>'
        + '<div><b>Objective</b>' + esc(t.objective || '—') + '</div><div><b>Language</b>' + esc(t.language || 'auto') + '</div>'
        + '<div><b>Started</b>' + esc(t.createdAt ? new Date(t.createdAt).toLocaleString() : '—') + '</div></div></div>';
    }
    var versions = (v.versions || []).map(function (x) {
      return '<tr><td>v' + esc(x.version) + '</td><td>' + esc(new Date(x.savedAt).toLocaleString()) + '</td><td>' + esc(x.name) + '</td></tr>'; }).join('');
    return '<div class="tc-body"><button type="button" class="tc-btn" onclick="tcBack()">← Back</button>'
      + '<h3 style="margin:14px 0 4px">' + esc(t.name) + '</h3>'
      + '<div class="tc-sub">' + esc(CH_LABEL[t.channel]) + ' template' + (t.wa ? ' (WhatsApp Business: ' + esc(t.wa.waName) + ', ' + esc(t.wa.language) + ', ' + esc(t.wa.status || 'not submitted') + ')' : '') + ' · v' + esc(t.version) + (t.source === 'system' ? ' · Built in' : ' · By ' + esc(t.createdBy || '—')) + '</div>'
      + '<div class="tc-kv"><div><b>Approval</b>' + approvalChip(t) + '</div><div><b>Department</b>' + esc(t.department) + '</div>'
      + '<div><b>Used in</b>' + usedInHtml(t.usedIn) + '</div><div><b>Last changed</b>' + esc(t.updatedAt ? new Date(t.updatedAt).toLocaleString() : '—') + '</div></div>'
      + (t.subject ? '<div class="tc-sub" style="margin-bottom:4px">Subject</div><div class="tc-pre" style="margin-bottom:10px">' + esc(t.subject) + '</div>' : '')
      + '<div class="tc-sub" style="margin-bottom:4px">Text</div><div class="tc-pre">' + esc(t.body || '(no text)') + '</div>'
      + (t.source === 'system' ? '<p class="tc-sub">This is a built-in template. What the system sends does not change from here; duplicate it to make your own version.</p>' : '')
      + (versions ? '<h4 style="margin:18px 0 6px">Versions</h4><table class="tc-table"><thead><tr><th>Version</th><th>Saved</th><th>Name then</th></tr></thead><tbody>' + versions + '</tbody></table>' : '')
      + '<div class="tc-act" style="margin-top:14px">'
      + (t.canEdit ? '<button type="button" onclick="tcEdit(\'' + esc(t.id) + '\')">Edit</button>' : '')
      + (t.canReview ? '<button type="button" onclick="tcApprove(\'' + esc(t.id) + '\')">Approve</button><button type="button" onclick="tcChanges(\'' + esc(t.id) + '\')">Request changes</button>' : '')
      + (t.canDuplicate ? '<button type="button" onclick="tcDuplicate(\'' + esc(t.id) + '\')">Duplicate</button>' : '') + '</div></div>';
  }

  function editHtml() {
    var v = S.view, t = v.item || {}, isNew = !t.id;
    var chOpts = CHANNELS.slice(1).map(function (c) { return '<option value="' + c[0] + '"' + ((t.channel || 'email') === c[0] ? ' selected' : '') + '>' + c[1] + '</option>'; }).join('');
    return '<div class="tc-body"><button type="button" class="tc-btn" onclick="tcBack()">← Back</button>'
      + '<h3 style="margin:14px 0 4px">' + (isNew ? 'New template' : 'Edit template') + '</h3>'
      + '<div class="tc-sub">' + (S.perms.role === 'admin' ? 'An administrator\'s template is approved straight away.' : 'It is saved as a new version and waits for approval before it is offered for sending.') + '</div>'
      + (v.error ? '<div class="tc-err" role="alert">' + esc(v.error) + '</div>' : '')
      + '<form class="tc-form" onsubmit="return tcSave(event)">'
      + '<div><label for="tcfName">Name</label><input id="tcfName" maxlength="120" required value="' + esc(t.name || '') + '"></div>'
      + (isNew ? '<div><label for="tcfChannel">Channel</label><select id="tcfChannel" onchange="tcChannelChanged()">' + chOpts + '</select></div>' : '')
      + '<div id="tcfSubjWrap"' + ((t.channel || 'email') === 'email' ? '' : ' style="display:none"') + '><label for="tcfSubject">Subject (email)</label><input id="tcfSubject" maxlength="200" value="' + esc(t.subject || '') + '"></div>'
      + '<div><label for="tcfBody">Text</label><textarea id="tcfBody" required maxlength="8000">' + esc(t.body || '') + '</textarea>'
      + '<div class="tc-sub">You can use {{first_name}}, {{job_title}}, {{company}} and {{recruiter_name}}.</div></div>'
      + '<div><label for="tcfDept">Department</label><input id="tcfDept" list="tcDeptList" maxlength="80" placeholder="All departments" value="' + esc(t.department && t.department !== 'All departments' ? t.department : '') + '">'
      + '<datalist id="tcDeptList">' + S.departments.map(function (d) { return '<option value="' + esc(d) + '">'; }).join('') + '</datalist></div>'
      + '<div><label for="tcfUsed">Used in (separate with commas)</label><input id="tcfUsed" maxlength="300" placeholder="e.g. Walk-in jobs, Offers" value="' + esc((t.usedIn || []).join(', ')) + '"></div>'
      + '<div class="tc-act"><button type="submit" class="tc-btn p"' + (S.busy ? ' disabled' : '') + '>' + (S.busy ? 'Saving…' : 'Save') + '</button>'
      + '<button type="button" class="tc-btn" onclick="tcBack()">Cancel</button></div></form></div>';
  }

  function changesHtml() {
    var v = S.view;
    return '<div class="tc-body"><button type="button" class="tc-btn" onclick="tcBack()">← Back</button>'
      + '<h3 style="margin:14px 0 4px">Request changes</h3><div class="tc-sub">' + esc(v.item.name) + ' — say what needs to change; the author sees this note.</div>'
      + (v.error ? '<div class="tc-err" role="alert">' + esc(v.error) + '</div>' : '')
      + '<form class="tc-form" onsubmit="return tcSendChanges(event)"><div><label for="tcfNote">What needs to change</label><textarea id="tcfNote" required maxlength="500" style="min-height:100px"></textarea></div>'
      + '<div class="tc-act"><button type="submit" class="tc-btn p"' + (S.busy ? ' disabled' : '') + '>Send</button><button type="button" class="tc-btn" onclick="tcBack()">Cancel</button></div></form></div>';
  }

  function bodyHtml() {
    if (S.view) {
      if (S.view.type === 'edit') return editHtml();
      if (S.view.type === 'review') return changesHtml();
      return detailHtml();
    }
    return listHtml();
  }

  function paint() {
    var el = root(); if (!el) return;
    var focusId = document.activeElement && el.contains(document.activeElement) ? document.activeElement.id : '';
    var pos = focusId === 'tcSearch' ? document.activeElement.selectionStart : null;
    el.querySelector('.tc-content').innerHTML = bodyHtml();
    if (focusId) {
      var f = document.getElementById(focusId);
      if (f) { try { f.focus(); if (pos != null && f.setSelectionRange) f.setSelectionRange(pos, pos); } catch (e) { /* not a text box */ } }
    }
  }
  /* only the list under the toolbar - typing in the search box keeps its cursor */
  function paintBody() {
    var b = document.getElementById('tcBody');
    if (b && !S.view) b.innerHTML = tableHtml(); else paint();
  }

  /* ------------------------------------------------------------------ *
   * open / close - one instance only
   * ------------------------------------------------------------------ */
  window.tcOpen = function (opts) {
    if (S.open || root()) return;
    addStyle();
    S.open = true; S.view = null; S.colsOpen = false; S.error = '';
    if (opts && typeof opts === 'object' && opts.channel) { S.channel = String(opts.channel); S.tab = 'templates'; }
    S.lastFocus = document.activeElement;
    var ov = document.createElement('div');
    ov.className = 'tc-ov'; ov.id = 'tcRoot';
    ov.innerHTML = '<div class="tc-modal" role="dialog" aria-modal="true" aria-labelledby="tcTitle">'
      + '<div class="tc-head"><h2 id="tcTitle">Templates &amp; Campaigns</h2><button type="button" class="tc-x" id="tcClose" aria-label="Close" onclick="tcClose()">✕</button></div>'
      + '<div class="tc-content" style="display:flex;flex-direction:column;min-height:0;flex:1"></div></div>';
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) window.tcClose(); });
    document.body.appendChild(ov);
    document.addEventListener('keydown', onKey);
    paint();
    var c = document.getElementById('tcClose'); if (c) c.focus();
    load(false);
  };
  window.tcClose = function () {
    var el = root(); if (el && el.parentNode) el.parentNode.removeChild(el);
    document.removeEventListener('keydown', onKey);
    S.open = false; S.view = null; S.busy = false; clearTimeout(S.timer);
    var b = S.lastFocus && document.contains(S.lastFocus) ? S.lastFocus : document.getElementById('tcHeaderBtn');
    if (b && b.focus) { try { b.focus(); } catch (e) { /* gone */ } }
  };
  function onKey(e) {
    if (e.key === 'Escape') { if (S.colsOpen) { S.colsOpen = false; paint(); } else window.tcClose(); }
  }
  /* a different page was opened behind it: the popup does not follow along */
  window.addEventListener('hashchange', function () { if (S.open) window.tcClose(); });

  /* ------------------------------------------------------------------ *
   * list controls
   * ------------------------------------------------------------------ */
  window.tcTab = function (t) { if (S.tab === t) return; S.tab = t; S.view = null; S.error = ''; S.approval = t === 'campaigns' ? '' : S.approval; paint(); load(true); };
  window.tcSet = function (k, v) { S[k] = v; S.colsOpen = false; load(true); };
  window.tcSearch = function (v) { S.q = v; clearTimeout(S.timer); S.timer = setTimeout(function () { load(true); }, 280); };
  window.tcClear = function () { S.channel = ''; S.dept = ''; S.approval = ''; S.q = ''; paint(); load(true); };
  window.tcReload = function () { load(true); };
  window.tcToggleCols = function (e) { if (e) e.stopPropagation(); S.colsOpen = !S.colsOpen; paint(); };
  window.tcCol = function (k, on) { if (!ALWAYS[k]) { S.cols[k] = !!on; saveCols(); paint(); } };
  document.addEventListener('click', function (e) {
    if (S.open && S.colsOpen && !(e.target.closest && e.target.closest('.tc-colwrap'))) { S.colsOpen = false; paint(); }
  });

  /* ------------------------------------------------------------------ *
   * actions
   * ------------------------------------------------------------------ */
  window.tcBack = function () { S.view = null; S.busy = false; paint(); load(true); };
  window.tcView = function (id) {
    var t = find(id); if (!t) return;
    if (S.tab === 'campaigns') { S.view = { type: 'campaign', item: t }; paint(); return; }
    S.view = { type: 'template', item: t, versions: [] }; paint();
    api().get('/comm/templates/' + encodeURIComponent(id)).then(function (r) {
      if (S.view && S.view.item && S.view.item.id === id) { S.view.item = r.template; S.view.versions = r.versions || []; paint(); }
    }, function (e) { toast(errText(e), '⚠️'); });
  };
  window.tcNew = function () { S.view = { type: 'edit', item: null }; paint(); var n = document.getElementById('tcfName'); if (n) n.focus(); };
  window.tcEdit = function (id) {
    var t = find(id) || (S.view && S.view.item); if (!t) return;
    /* a WhatsApp Business template has its own form (name and language as in WhatsApp Manager, header, buttons, fields) */
    if (t.wa && typeof window.tlWaTemplateForm === 'function') { window.tlWaTemplateForm(t.id, function () { S.view = null; load(true); }); return; }
    S.view = { type: 'edit', item: t }; paint();
  };
  window.tcOpenWa = function (batchId) { if (typeof window.tlWhatsApp === 'function') { window.tcClose(); window.tlWhatsApp({ batchId: batchId }); } };
  window.tcNewWa = function () { if (typeof window.tlWaTemplateForm === 'function') window.tlWaTemplateForm(null, function () { S.view = null; load(true); }); };
  window.tcSyncWa = function () { if (typeof window.tlWaSync === 'function') window.tlWaSync(function () { load(true); }); };
  window.tcChannelChanged = function () {
    var ch = document.getElementById('tcfChannel'), w = document.getElementById('tcfSubjWrap');
    if (ch && w) w.style.display = ch.value === 'email' ? '' : 'none';
  };
  window.tcSave = function (ev) {
    if (ev && ev.preventDefault) ev.preventDefault();
    if (S.busy) return false;
    var v = S.view, t = v.item, isNew = !t;
    var val = function (id) { var e = document.getElementById(id); return e ? e.value : ''; };
    var body = {
      name: val('tcfName'), body: val('tcfBody'), subject: val('tcfSubject'), department: val('tcfDept'),
      usedIn: val('tcfUsed').split(',').map(function (x) { return x.trim(); }).filter(Boolean),
    };
    if (isNew) body.channel = val('tcfChannel') || 'email';
    S.busy = true; v.error = ''; paint();
    var req = isNew ? api().post('/comm/templates', body) : api().put('/comm/templates/' + encodeURIComponent(t.id), body);
    req.then(function (r) {
      S.busy = false; S.view = null;
      toast(isNew ? 'Template created' + (r.template.approval === 'waiting' ? ' - waiting for approval' : '') : 'Saved as version ' + r.template.version, '✅');
      load(true);
    }, function (e) { S.busy = false; v.error = errText(e); paint(); });
    return false;
  };
  function review(id, decision, note, fail) {
    return api().post('/comm/templates/' + encodeURIComponent(id) + '/review', { decision: decision, note: note }).then(function () {
      S.busy = false; S.view = null; toast(decision === 'approved' ? 'Approved' : 'Changes requested', '✅'); load(true);
    }, function (e) { S.busy = false; if (fail) fail(errText(e)); else toast(errText(e), '⚠️'); });
  }
  window.tcApprove = function (id) { if (S.busy) return; S.busy = true; review(id, 'approved', undefined); };
  window.tcChanges = function (id) { var t = find(id) || (S.view && S.view.item); if (!t) return; S.view = { type: 'review', item: t }; paint(); };
  window.tcSendChanges = function (ev) {
    if (ev && ev.preventDefault) ev.preventDefault();
    if (S.busy) return false;
    var note = (document.getElementById('tcfNote') || {}).value || '';
    S.busy = true; S.view.error = '';
    review(S.view.item.id, 'changes_needed', note, function (m) { S.view.error = m; paint(); });
    return false;
  };
  window.tcDuplicate = function (id) {
    if (S.busy) return; S.busy = true;
    api().post('/comm/templates/' + encodeURIComponent(id) + '/duplicate', {}).then(function (r) {
      S.busy = false; S.view = null; toast('Copy created: ' + r.template.name, '✅'); load(true);
    }, function (e) { S.busy = false; toast(errText(e), '⚠️'); });
  };
  window.tcArchive = function (id, archived) {
    if (S.busy) return; S.busy = true;
    api().post('/comm/templates/' + encodeURIComponent(id) + '/archive', { archived: archived }).then(function () {
      S.busy = false; toast(archived ? 'Archived' : 'Restored', '✅'); load(true);
    }, function (e) { S.busy = false; toast(errText(e), '⚠️'); });
  };
})();
