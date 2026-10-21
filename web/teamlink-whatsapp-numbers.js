/*
 * Integrations -> WhatsApp: several WhatsApp Business numbers, assigned by the administrator (0160).
 *
 * Drawn into #tlwnPanel by tlWaNumbersMount() (called by the Integrations page). Everything goes through /api/admin/whatsapp-numbers,
 * which is administrator-only on the server; nothing here holds or shows a credential - a saved token is shown only as "saved ...1234".
 *
 *   table    Number, Display name, Department(s), Assigned users, Connection status, Actions (Edit, Assign, Verify/Reconnect, Make default,
 *            Deactivate/Activate, Remove, Messages)
 *   filters  search, department, user, connection status
 *   Assign   departments and people, or "all staff"; the server decides who may send from a number from exactly this
 */
(function () {
  'use strict';
  var N = { rows: null, error: '', q: '', dept: '', user: '', status: '', staff: [], depts: [], keyOk: true, busy: '', loaded: false };
  var api = function () { return window.TL && window.TL.api; };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var $ = function (id) { return document.getElementById(id); };
  var errText = function (e) { return (e && e.message) ? String(e.message) : 'Something went wrong. Please try again.'; };
  var toast = function (m, i) { if (typeof window.toast === 'function') { try { window.toast(m, i || 'ℹ️'); } catch (e) { /* none */ } } };

  function style() {
    if ($('wn-style')) return;
    var css = '.wn-sec{margin-top:18px}.wn-bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:12px 0}'
      + '.wn-in,.wn-sel{border:1px solid var(--border,#dde2ea);border-radius:9px;padding:8px 10px;font:inherit;font-size:13px;background:var(--surface,#fff);min-width:0;box-sizing:border-box}.wn-in{flex:1;min-width:150px}'
      + '.wn-btn{border:1px solid var(--border,#dde2ea);background:var(--surface,#fff);border-radius:8px;padding:6px 11px;font:inherit;font-size:12.5px;font-weight:650;cursor:pointer;white-space:nowrap}'
      + '.wn-btn:hover{border-color:#25d366}.wn-btn.p{background:#128c4a;border-color:#128c4a;color:#fff}.wn-btn[disabled]{opacity:.5;cursor:not-allowed}'
      + '.wn-btn.d{color:var(--bad-600,#c0392b)}'
      + '.wn-tbl{width:100%;border-collapse:collapse;font-size:13px}.wn-tbl th{text-align:left;font-size:11.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--ink-500,#5b6678);padding:8px 10px;background:var(--paper-50,#eef1f5);white-space:nowrap}'
      + '.wn-tbl td{padding:10px;border-bottom:1px solid var(--border,#dde2ea);vertical-align:top}.wn-sub{color:var(--ink-500,#5b6678);font-size:12px;margin-top:2px}'
      + '.wn-chip{display:inline-block;border-radius:999px;padding:2px 9px;font-size:11.5px;font-weight:700;background:var(--paper-50,#eef1f5);margin:0 4px 3px 0;white-space:nowrap}'
      + '.wn-ok{background:var(--ok-100,#e2f5ec);color:var(--ok-600,#1e8e5a)}.wn-bad{background:var(--bad-100,#fbe4e1);color:var(--bad-600,#c0392b)}.wn-warn{background:var(--warn-100,#fbeed8);color:var(--warn-600,#a5670f)}.wn-def{background:#e8f1fb;color:#1c4f87}'
      + '.wn-act{display:flex;gap:5px;flex-wrap:wrap}'
      + '.wn-ov{position:fixed;inset:0;z-index:9600;background:rgba(11,18,32,.55);display:flex;align-items:center;justify-content:center;padding:18px}'
      + '.wn-m{background:var(--surface,#fff);color:var(--ink-900,#0b1220);width:min(720px,100%);max-height:calc(100vh - 36px);display:flex;flex-direction:column;border-radius:14px;box-shadow:0 24px 60px rgba(0,0,0,.3);overflow:hidden}'
      + '.wn-h{display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid var(--border,#dde2ea)}.wn-h h3{margin:0;font-size:16px;flex:1}'
      + '.wn-x{border:0;background:transparent;font-size:20px;cursor:pointer;color:var(--ink-500,#5b6678);padding:2px 8px;border-radius:8px}'
      + '.wn-b{overflow:auto;padding:16px 18px}.wn-f{display:flex;gap:8px;justify-content:flex-end;padding:12px 18px;border-top:1px solid var(--border,#dde2ea);background:var(--paper-50,#f6f8fb)}'
      + '.wn-form{display:grid;gap:12px}.wn-form label{display:block;font-size:12px;font-weight:700;margin-bottom:4px}.wn-form input,.wn-form select{width:100%;box-sizing:border-box;border:1px solid var(--border,#dde2ea);border-radius:9px;padding:8px 10px;font:inherit;font-size:13px}'
      + '.wn-form .e{color:var(--bad-600,#c0392b);font-size:12px;margin-top:3px}.wn-2{display:grid;grid-template-columns:1fr 1fr;gap:12px}'
      + '.wn-note{border-radius:10px;padding:10px 13px;font-size:12.5px;line-height:1.5;background:#e8f1fb;color:#1c4f87}.wn-warnbox{background:var(--warn-100,#fbeed8);color:var(--warn-600,#8a5410)}'
      + '.wn-list{max-height:260px;overflow:auto;border:1px solid var(--border,#dde2ea);border-radius:10px;margin-top:6px}.wn-list label{display:flex;gap:8px;align-items:flex-start;padding:7px 10px;border-bottom:1px solid var(--border,#dde2ea);font-weight:500;margin:0;cursor:pointer}'
      + '.wn-list label:last-child{border-bottom:0}.wn-list input{width:auto;margin-top:3px}'
      + '.wn-code{font-family:ui-monospace,Menlo,Consolas,monospace;background:var(--paper-50,#eef1f5);border-radius:6px;padding:2px 6px;font-size:12px;word-break:break-all}'
      + '@media (max-width:700px){.wn-2{grid-template-columns:1fr}.wn-ov{padding:0}.wn-m{max-height:100vh;height:100vh;border-radius:0}}';
    var st = document.createElement('style'); st.id = 'wn-style'; st.textContent = css; document.head.appendChild(st);
  }

  /* ------------------------------------------------------------------ the panel */
  window.tlWaNumbersMount = function () {
    var host = $('tlwnPanel'); if (!host || !api()) return;
    style();
    paint();
    if (!N.loaded) load();
  };

  function load() {
    N.loaded = true;
    Promise.all([api().get('/admin/whatsapp-numbers'), api().get('/admin/whatsapp-numbers/assignable')]).then(function (r) {
      N.rows = r[0].numbers || []; N.keyOk = r[0].secretKeyConfigured !== false; N.staff = r[1].staff || []; N.depts = r[1].departments || [];
      N.error = ''; paint();
    }, function (e) { N.error = errText(e); paint(); });
  }
  function reload() { load(); }

  var STATUS = { connected: ['Connected', 'wn-ok'], disconnected: ['Disconnected', 'wn-bad'], verification_required: ['Verification required', 'wn-warn'] };

  function visible() {
    var q = N.q.toLowerCase();
    return (N.rows || []).filter(function (n) {
      if (N.status && n.status !== N.status) return false;
      if (N.dept && !(n.departments || []).some(function (d) { return d.toLowerCase() === N.dept.toLowerCase(); }) && !(n.openToAll && N.dept === '*')) return false;
      if (N.user && !(n.users || []).some(function (u) { return u.userId === N.user; })) return false;
      if (q && ((n.displayName || '') + ' ' + (n.displayPhone || '') + ' ' + (n.phoneNumberId || '') + ' ' + (n.departments || []).join(' ') + ' ' + (n.users || []).map(function (u) { return u.name; }).join(' ')).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
  }

  function paint() {
    var host = $('tlwnPanel'); if (!host) return;
    var deptOpts = '<option value="">All departments</option>' + N.depts.map(function (d) { return '<option value="' + esc(d) + '"' + (N.dept === d ? ' selected' : '') + '>' + esc(d) + '</option>'; }).join('');
    var userOpts = '<option value="">All users</option>' + N.staff.map(function (u) { return '<option value="' + esc(u.userId) + '"' + (N.user === u.userId ? ' selected' : '') + '>' + esc(u.name) + '</option>'; }).join('');
    var statusOpts = '<option value="">Any status</option>' + Object.keys(STATUS).map(function (k) { return '<option value="' + k + '"' + (N.status === k ? ' selected' : '') + '>' + STATUS[k][0] + '</option>'; }).join('');
    var rows = visible().map(function (n) {
      var st = STATUS[n.status] || [n.status, ''];
      var users = n.openToAll ? '<span class="wn-chip wn-def">All staff</span>' : '';
      users += (n.users || []).slice(0, 4).map(function (u) { return '<span class="wn-chip">' + esc(u.name) + '</span>'; }).join('');
      if ((n.users || []).length > 4) users += '<span class="wn-sub">+' + (n.users.length - 4) + ' more</span>';
      if (!users) users = '<span class="wn-chip wn-warn">Nobody yet</span>';
      var depts = (n.departments || []).map(function (d) { return '<span class="wn-chip">' + esc(d) + '</span>'; }).join('') || '<span class="wn-sub">—</span>';
      return '<tr><td><b>' + esc(n.displayPhone || (n.phoneNumberId ? 'ID ' + n.phoneNumberId : '—')) + '</b><div class="wn-sub">' + (n.phoneNumberId ? 'Phone ID ' + esc(n.phoneNumberId) : '') + '</div>'
        + '<div class="wn-sub">' + n.messagesOut + ' sent · ' + n.messagesIn + ' received</div></td>'
        + '<td><b>' + esc(n.displayName) + '</b>' + (n.verifiedName && n.verifiedName !== n.displayName ? '<div class="wn-sub">' + esc(n.verifiedName) + '</div>' : '')
        + '<div>' + (n.isDefault ? '<span class="wn-chip wn-def">Default</span>' : '') + (n.primary ? '<span class="wn-chip">Existing connection</span>' : '') + (!n.active ? '<span class="wn-chip wn-bad">Deactivated</span>' : '') + '</div></td>'
        + '<td>' + depts + '</td><td>' + users + '</td>'
        + '<td><span class="wn-chip ' + st[1] + '">' + st[0] + '</span><div class="wn-sub">' + esc(n.statusDetail || '') + '</div>'
        + (n.lastVerifiedAt ? '<div class="wn-sub">checked ' + esc(new Date(n.lastVerifiedAt).toLocaleString()) + '</div>' : '') + '</td>'
        + '<td><div class="wn-act">'
        + '<button class="wn-btn" onclick="wnEdit(\'' + esc(n.id) + '\')">Edit</button>'
        + '<button class="wn-btn" onclick="wnAssign(\'' + esc(n.id) + '\')">Assign</button>'
        + '<button class="wn-btn" onclick="wnVerify(\'' + esc(n.id) + '\')" ' + (N.busy === n.id ? 'disabled' : '') + '>' + (n.status === 'connected' ? 'Verify' : 'Reconnect') + '</button>'
        + (n.isDefault || !n.active ? '' : '<button class="wn-btn" onclick="wnDefault(\'' + esc(n.id) + '\')">Make default</button>')
        + (n.primary ? '' : '<button class="wn-btn" onclick="wnActive(\'' + esc(n.id) + '\',' + (n.active ? 'false' : 'true') + ')">' + (n.active ? 'Deactivate' : 'Activate') + '</button>')
        + '<button class="wn-btn" onclick="wnMessages(\'' + esc(n.id) + '\')">Messages</button>'
        + (n.primary ? '' : '<button class="wn-btn d" onclick="wnRemove(\'' + esc(n.id) + '\')">Remove</button>')
        + '</div></td></tr>';
    }).join('');
    host.innerHTML = '<section class="panel wn-sec"><div class="panel-head"><div><h2>WhatsApp numbers</h2><div class="desc">Connect several WhatsApp Business numbers and decide who may send from each. '
      + 'Messages leave from the sender\'s own number, replies come back to the number they were sent to, and each number keeps its own conversations.</div></div>'
      + '<button class="wn-btn p" onclick="wnAdd()">+ Add WhatsApp Number</button></div><div class="panel-body">'
      + (N.error ? '<div class="wn-note wn-warnbox">' + esc(N.error) + '</div>' : '')
      + (N.keyOk ? '' : '<div class="wn-note wn-warnbox" style="margin-bottom:10px"><b>INTEGRATION_SECRET_KEY is not set on the server</b>, so an access token cannot be saved for a new number.</div>')
      + '<div class="wn-bar"><input class="wn-in" type="search" id="wnQ" placeholder="Search number, name, department or person…" value="' + esc(N.q) + '" oninput="wnSet(\'q\',this.value)">'
      + '<select class="wn-sel" onchange="wnSet(\'dept\',this.value)">' + deptOpts + '</select><select class="wn-sel" onchange="wnSet(\'user\',this.value)">' + userOpts + '</select>'
      + '<select class="wn-sel" onchange="wnSet(\'status\',this.value)">' + statusOpts + '</select></div>'
      + (N.rows === null ? '<div class="wn-sub" style="padding:18px 0">Loading…</div>'
        : '<div style="overflow-x:auto"><table class="wn-tbl"><thead><tr><th>Number</th><th>Display name</th><th>Department</th><th>Assigned users</th><th>Connection</th><th>Actions</th></tr></thead><tbody>'
          + (rows || '<tr><td colspan="6" class="wn-sub" style="padding:18px">No number matches.</td></tr>') + '</tbody></table></div>')
      + '</div></section>';
    var q = $('wnQ'); if (q && N._focusQ) { q.focus(); try { q.setSelectionRange(q.value.length, q.value.length); } catch (e) { /* none */ } }
  }
  window.wnSet = function (k, v) { N[k] = v; N._focusQ = k === 'q'; paint(); };

  /* ------------------------------------------------------------------ modal shell */
  function modal(title, bodyHtml, footHtml) {
    closeModal();
    var ov = document.createElement('div'); ov.className = 'wn-ov'; ov.id = 'wnRoot';
    ov.innerHTML = '<div class="wn-m" role="dialog" aria-modal="true"><div class="wn-h"><h3>' + esc(title) + '</h3><button class="wn-x" onclick="wnClose()" aria-label="Close">✕</button></div>'
      + '<div class="wn-b" id="wnBody">' + bodyHtml + '</div><div class="wn-f" id="wnFoot">' + footHtml + '</div></div>';
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) closeModal(); });
    document.body.appendChild(ov);
    document.addEventListener('keydown', onKey);
  }
  function onKey(e) { if (e.key === 'Escape') closeModal(); }
  function closeModal() { var r = $('wnRoot'); if (r && r.parentNode) r.parentNode.removeChild(r); document.removeEventListener('keydown', onKey); }
  window.wnClose = closeModal;
  var find = function (id) { return (N.rows || []).filter(function (n) { return n.id === id; })[0]; };
  var errs = {};
  var fe = function (k) { return errs[k] ? '<div class="e">' + esc(errs[k]) + '</div>' : ''; };
  var val = function (id) { var e = $(id); return e ? e.value : ''; };

  /* ------------------------------------------------------------------ add / edit */
  function formHtml(n) {
    var primary = n && n.primary, edit = !!n;
    var wh = location.origin + '/api/whatsapp-agent/webhook';
    return '<div class="wn-form">'
      + '<div class="wn-2"><div><label for="wnName">Display name</label><input id="wnName" maxlength="80" value="' + esc(n ? n.displayName : '') + '" placeholder="e.g. Medical hiring">' + fe('displayName') + '</div>'
      + '<div><label for="wnPhone">WhatsApp number</label><input id="wnPhone" value="' + esc(n ? (n.displayPhone || '') : '') + '" placeholder="+91 98765 43210" ' + (primary ? 'disabled' : '') + '>' + fe('displayPhone')
      + '<div class="wn-sub">Optional: WhatsApp fills it in when the number is verified.</div></div></div>'
      + (primary ? '<div class="wn-note">This is the existing WhatsApp connection. Its token and phone number ID are changed in <b>Messaging channels → WhatsApp Business</b> above; here you set its name and who may use it.</div>' : '')
      + (primary ? '' : '<div class="wn-2"><div><label for="wnPid">Phone number ID (from Meta)</label><input id="wnPid" value="' + esc(n ? (n.phoneNumberId || '') : '') + '" inputmode="numeric">' + fe('phoneNumberId') + '</div>'
        + '<div><label for="wnBiz">WhatsApp Business account ID</label><input id="wnBiz" value="' + esc(n ? (n.businessAccountId || '') : '') + '" inputmode="numeric">' + fe('businessAccountId') + '</div></div>'
        + '<div><label for="wnTok">Permanent access token</label><input id="wnTok" type="password" autocomplete="new-password" placeholder="' + (edit && n.hasToken ? 'Saved' + (n.tokenHint ? ' (…' + esc(n.tokenHint) + ')' : '') + ' — leave blank to keep' : 'Paste the token from Meta') + '">' + fe('accessToken')
        + '<div class="wn-sub">Stored encrypted on the server and never shown again.</div></div>'
        + '<div><label for="wnSec">Meta app secret (optional)</label><input id="wnSec" type="password" autocomplete="new-password" placeholder="' + (edit && n.hasAppSecret ? 'Saved — leave blank to keep' : 'Only if this number belongs to a different Meta app') + '"></div>')
      + '<div class="wn-note"><b>Webhook for this number.</b> In Meta → WhatsApp → Configuration set <br>Callback URL: <span class="wn-code">' + esc(wh) + '</span>'
      + (edit && n.webhookVerifyToken ? '<br>Verify token: <span class="wn-code">' + esc(n.webhookVerifyToken) + '</span>' : '<br>The verify token is shown here once the number is saved.')
      + '<br>One URL serves every number: each incoming event says which number it is for, and it is filed under that number.</div></div>';
  }
  window.wnAdd = function () {
    errs = {};
    modal('Add WhatsApp Number', formHtml(null), '<button class="wn-btn" onclick="wnClose()">Cancel</button><button class="wn-btn p" id="wnSave" onclick="wnSave(null)">Add and verify</button>');
  };
  window.wnEdit = function (id) {
    var n = find(id); if (!n) return; errs = {};
    modal('Edit ' + n.displayName, formHtml(n), '<button class="wn-btn" onclick="wnClose()">Cancel</button><button class="wn-btn p" id="wnSave" onclick="wnSave(\'' + esc(id) + '\')">Save</button>');
  };
  window.wnSave = function (id) {
    var btn = $('wnSave'); if (btn && btn.disabled) return;
    var n = id ? find(id) : null, primary = n && n.primary;
    var body = { displayName: val('wnName'), displayPhone: val('wnPhone') };
    if (!primary) { body.phoneNumberId = val('wnPid'); body.businessAccountId = val('wnBiz'); body.accessToken = val('wnTok'); body.appSecret = val('wnSec'); }
    if (btn) { btn.disabled = true; btn.textContent = id ? 'Saving…' : 'Adding and verifying…'; }
    var call = id ? api().put('/admin/whatsapp-numbers/' + encodeURIComponent(id), body) : api().post('/admin/whatsapp-numbers', body);
    call.then(function (r) {
      closeModal(); toast(id ? 'Saved' : 'Number added: ' + ((r.number && r.number.status) || ''), '✅');
      if (id && !primary && (body.accessToken || (find(id) && body.phoneNumberId !== find(id).phoneNumberId))) wnVerify(id); else reload();
      if (!id && r.number) { N.rows = (N.rows || []).concat([r.number]); paint(); reload(); }
    }, function (e) {
      errs = (e && e.details) || {};
      var msg = Object.keys(errs).length ? '' : errText(e);
      var b = $('wnBody'); var cur = n || null;
      if (b) { b.innerHTML = (msg ? '<div class="wn-note wn-warnbox" style="margin-bottom:12px">' + esc(msg) + '</div>' : '') + formHtml(cur); }
      if (btn) { var nb = $('wnSave'); if (nb) { nb.disabled = false; nb.textContent = id ? 'Save' : 'Add and verify'; } }
    });
  };

  /* ------------------------------------------------------------------ verify / reconnect */
  window.wnVerify = function (id) {
    var n = find(id); if (!n) return;
    if (!n.primary && n.status !== 'connected') {
      modal('Reconnect ' + n.displayName,
        '<div class="wn-form"><div class="wn-note ' + (n.status === 'disconnected' ? 'wn-warnbox' : '') + '">' + esc(n.statusDetail || '') + '</div>'
        + '<div><label for="wnNewTok">New access token (optional)</label><input id="wnNewTok" type="password" autocomplete="new-password" placeholder="Leave blank to check the saved token again">' + fe('accessToken') + '</div></div>',
        '<button class="wn-btn" onclick="wnClose()">Cancel</button><button class="wn-btn p" id="wnGo" onclick="wnDoVerify(\'' + esc(id) + '\')">Verify with WhatsApp</button>');
      return;
    }
    wnDoVerify(id, true);
  };
  window.wnDoVerify = function (id, quiet) {
    var tok = val('wnNewTok'); var btn = $('wnGo'); if (btn) { btn.disabled = true; btn.textContent = 'Asking WhatsApp…'; }
    N.busy = id; paint(); toast('Asking WhatsApp to confirm the number…', '🔄');
    api().post('/admin/whatsapp-numbers/' + encodeURIComponent(id) + '/verify', tok ? { accessToken: tok } : {}).then(function (r) {
      N.busy = ''; closeModal(); var s = r.number && r.number.status;
      toast(s === 'connected' ? 'Connected' : (s === 'verification_required' ? 'Verification required' : 'Disconnected') + ': ' + ((r.number && r.number.statusDetail) || ''), s === 'connected' ? '✅' : '⚠️');
      reload();
    }, function (e) { N.busy = ''; closeModal(); toast(errText(e), '⚠️'); paint(); });
  };

  /* ------------------------------------------------------------------ default / active / remove */
  window.wnDefault = function (id) {
    api().post('/admin/whatsapp-numbers/' + encodeURIComponent(id) + '/default', {}).then(function () { toast('Default number changed', '✅'); reload(); }, function (e) { toast(errText(e), '⚠️'); });
  };
  window.wnActive = function (id, on) {
    var n = find(id); if (!n) return;
    if (!on && !confirm('Deactivate ' + n.displayName + '? Nobody can send from it until it is activated again; messages already queued from it will fail.')) return;
    api().post('/admin/whatsapp-numbers/' + encodeURIComponent(id) + '/active', { active: !!on }).then(function () { toast(on ? 'Activated' : 'Deactivated', '✅'); reload(); }, function (e) { toast(errText(e), '⚠️'); });
  };
  window.wnRemove = function (id) {
    var n = find(id); if (!n) return;
    if (!confirm('Remove ' + n.displayName + '? Its saved token is deleted and nobody can send from it. Its past messages stay in the history.')) return;
    api().del('/admin/whatsapp-numbers/' + encodeURIComponent(id)).then(function () { toast('Removed', '✅'); reload(); }, function (e) { toast(errText(e), '⚠️'); });
  };

  /* ------------------------------------------------------------------ assignment */
  var A = null;
  window.wnAssign = function (id) {
    var n = find(id); if (!n) return;
    A = { id: id, open: !!n.openToAll, depts: (n.departments || []).slice(), users: {}, q: '' };
    (n.users || []).forEach(function (u) { A.users[u.userId] = true; });
    paintAssign(n);
  };
  function paintAssign(n) {
    n = n || find(A.id);
    var q = A.q.toLowerCase();
    var staff = N.staff.filter(function (u) { return !q || (u.name + ' ' + (u.email || '') + ' ' + (u.department || '')).toLowerCase().indexOf(q) >= 0; });
    var dl = N.depts.concat(A.depts.filter(function (d) { return N.depts.map(function (x) { return x.toLowerCase(); }).indexOf(d.toLowerCase()) < 0; }));
    var body = '<div class="wn-form"><div class="wn-note">Who may send from <b>' + esc(n.displayName) + '</b>. A person can send if they are picked below, work in a ticked department, or the number is open to all staff. '
      + 'Administrators can always use every active number.</div>'
      + '<label style="display:flex;gap:8px;align-items:center;font-weight:600"><input type="checkbox" style="width:auto" ' + (A.open ? 'checked' : '') + ' onchange="wnA(\'open\',this.checked)"> Open to all staff (recruiters, team leaders and BDEs)</label>'
      + '<div><label>Departments / teams</label><div class="wn-list" style="max-height:170px">' + dl.map(function (d) {
        return '<label><input type="checkbox" ' + (A.depts.some(function (x) { return x.toLowerCase() === d.toLowerCase(); }) ? 'checked' : '') + ' onchange="wnAD(\'' + esc(d.replace(/'/g, '')) + '\',this.checked)"><span>' + esc(d) + '</span></label>'; }).join('') + '</div>'
      + '<div class="wn-bar" style="margin:6px 0 0"><input class="wn-in" id="wnNewDept" placeholder="Add another department…"><button class="wn-btn" onclick="wnAddDept()">Add</button></div></div>'
      + '<div><label>People (employees, recruiters, team leaders)</label><input class="wn-in" style="width:100%" id="wnUQ" type="search" placeholder="Search people…" value="' + esc(A.q) + '" oninput="wnA(\'q\',this.value)">'
      + '<div class="wn-list">' + (staff.map(function (u) {
        return '<label><input type="checkbox" ' + (A.users[u.userId] ? 'checked' : '') + ' onchange="wnAU(\'' + esc(u.userId) + '\',this.checked)"><span><b>' + esc(u.name) + '</b>'
          + (u.teamLead ? ' <span class="wn-chip wn-def">Team leader</span>' : '') + '<br><span class="wn-sub">' + esc(u.department || (u.role === 'bde' ? 'BDE' : 'No department')) + ' · ' + esc(u.email || '') + '</span></span></label>'; }).join('')
        || '<div class="wn-sub" style="padding:12px">No one matches.</div>') + '</div></div></div>';
    var keepQ = document.activeElement && document.activeElement.id === 'wnUQ';
    modal('Assign ' + n.displayName, body, '<button class="wn-btn" onclick="wnClose()">Cancel</button><button class="wn-btn p" id="wnSaveA" onclick="wnSaveAssign()">Save assignment</button>');
    if (keepQ || A.q) { var u = $('wnUQ'); if (u && A.q) { u.focus(); try { u.setSelectionRange(u.value.length, u.value.length); } catch (e) { /* none */ } } }
  }
  window.wnA = function (k, v) { if (!A) return; A[k] = v; if (k === 'q') paintAssign(); };
  window.wnAD = function (d, on) { if (!A) return; A.depts = A.depts.filter(function (x) { return x.toLowerCase() !== d.toLowerCase(); }); if (on) A.depts.push(d); };
  window.wnAU = function (id, on) { if (!A) return; if (on) A.users[id] = true; else delete A.users[id]; };
  window.wnAddDept = function () { var v = val('wnNewDept').trim(); if (!v || !A) return; if (!A.depts.some(function (x) { return x.toLowerCase() === v.toLowerCase(); })) A.depts.push(v); paintAssign(); };
  window.wnSaveAssign = function () {
    if (!A) return; var btn = $('wnSaveA'); if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    var ids = Object.keys(A.users);
    api().put('/admin/whatsapp-numbers/' + encodeURIComponent(A.id) + '/access', { departments: A.depts, userIds: ids, openToAll: A.open }).then(function () {
      closeModal(); A = null; toast('Assignment saved', '✅'); reload();
    }, function (e) { if (btn) { btn.disabled = false; btn.textContent = 'Save assignment'; } toast(errText(e), '⚠️'); });
  };

  /* ------------------------------------------------------------------ conversations of one number */
  window.wnMessages = function (id) {
    var n = find(id); if (!n) return;
    modal('Messages · ' + n.displayName, '<div class="wn-sub">Loading…</div>', '<button class="wn-btn" onclick="wnClose()">Close</button>');
    api().get('/whatsapp/conversations?numberId=' + encodeURIComponent(id)).then(function (r) {
      var b = $('wnBody'); if (!b) return;
      var list = (r.contacts || []).map(function (c) {
        return '<tr style="cursor:pointer" onclick="wnThread(\'' + esc(id) + '\',\'' + esc(c.contact) + '\')"><td><b>' + esc(c.name || '+' + c.contact) + '</b><div class="wn-sub">+' + esc(c.contact) + '</div></td>'
          + '<td>' + c.received + ' received · ' + c.sent + ' sent</td><td class="wn-sub">' + esc(c.lastAt ? new Date(c.lastAt).toLocaleString() : '') + '</td></tr>'; }).join('');
      b.innerHTML = list ? '<table class="wn-tbl"><thead><tr><th>Contact</th><th>Messages</th><th>Last</th></tr></thead><tbody>' + list + '</tbody></table>'
        : '<div class="wn-sub" style="padding:18px 0">No messages through this number yet.</div>';
    }, function (e) { var b = $('wnBody'); if (b) b.innerHTML = '<div class="wn-note wn-warnbox">' + esc(errText(e)) + '</div>'; });
  };
  window.wnThread = function (id, contact) {
    var b = $('wnBody'); if (b) b.innerHTML = '<div class="wn-sub">Loading…</div>';
    api().get('/whatsapp/conversations/' + encodeURIComponent(id) + '/' + encodeURIComponent(contact)).then(function (r) {
      var b2 = $('wnBody'); if (!b2) return;
      b2.innerHTML = '<button class="wn-btn" onclick="wnMessages(\'' + esc(id) + '\')">← All contacts</button><div style="margin-top:12px;display:grid;gap:8px">'
        + (r.thread || []).map(function (m) {
          var inb = m.direction === 'in';
          return '<div style="justify-self:' + (inb ? 'start' : 'end') + ';max-width:80%;background:' + (inb ? '#f1f3f6' : '#dcf8c6') + ';border-radius:10px;padding:8px 11px;font-size:13px;white-space:pre-wrap">'
            + esc(m.text) + '<div class="wn-sub">' + esc(m.by || (inb ? 'Contact' : '')) + (m.template ? ' · ' + esc(m.template) : '') + ' · ' + esc(new Date(m.at).toLocaleString()) + (m.status ? ' · ' + esc(m.status) : '') + '</div></div>'; }).join('')
        + '</div>';
    }, function (e) { var b2 = $('wnBody'); if (b2) b2.innerHTML = '<div class="wn-note wn-warnbox">' + esc(errText(e)) + '</div>'; });
  };
}());
