/* =====================================================================
   TEAMLINK - Admin -> Integrations -> Naukri & Shine Email Import (0135)

   Admin connects the mailbox that receives Naukri responses, and the one
   that receives Shine responses, and chooses for each the recruiter whose
   records it feeds. Every candidate and application a mailbox imports is
   that recruiter's; a Naukri mailbox imports Naukri email only, a Shine
   mailbox Shine only.

   "Connected" is only ever shown after the server logged in to the mailbox
   for real (IMAP over SSL). The app password is typed here once, goes to the
   server, is sealed there and is never sent back - this page cannot show it.

   Uses the existing Admin shell (dashShell) and the tabs of the Integrations
   module; the styles follow the Admin panel's own cards, tables and buttons.
   ===================================================================== */
(function () {
  'use strict';
  if (typeof window === 'undefined' || window.__tlEmailImport) return;
  window.__tlEmailImport = true;

  var SECTION = 'email-import';
  var BOARD = { naukri: 'Naukri', shine: 'Shine' };
  var S = { data: null, loading: false, error: '', forms: { naukri: {}, shine: {} }, busy: {}, msg: {}, errs: { naukri: {}, shine: {} }, modal: null, poll: null };

  function h(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function api() { return window.TL && window.TL.api; }
  function $(id) { return document.getElementById(id); }
  function say(m, i) { if (typeof window.toast === 'function') window.toast(m, i || 'ℹ️'); }
  function onPage() { return /^#\/admin\/email-import/.test(location.hash || ''); }
  function when(iso) {
    if (!iso) return '—';
    var d = new Date(iso); if (isNaN(d)) return '—';
    return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function errMsg(e) { return (e && e.message) || 'That did not work. Please try again.'; }
  function errDetails(e) { return (e && (e.details || (e.body && e.body.error && e.body.error.details))) || {}; }

  /* ------------------------------------------------------------------ *
   * data
   * ------------------------------------------------------------------ */
  function load(quiet) {
    if (!api()) return;
    if (!quiet) { S.loading = true; S.error = ''; paint(); }
    return api().get('/intake/source-connections').then(function (r) {
      S.data = r; S.loading = false; S.error = '';
      paint(); schedulePoll();
    }, function (e) {
      S.loading = false; S.error = errMsg(e); paint();
    });
  }
  /* while a sync runs, the row says Processing; look again until it is done */
  function schedulePoll() {
    clearTimeout(S.poll);
    var busy = S.data && (S.data.connections || []).some(function (c) { return c.status === 'processing'; });
    if (busy && onPage()) S.poll = setTimeout(function () { if (onPage()) load(true); }, 2500);
  }

  /* ------------------------------------------------------------------ *
   * the connect form, one per board
   * ------------------------------------------------------------------ */
  function keep(src) {
    var f = S.forms[src];
    ['recruiterId', 'address', 'provider', 'username', 'appPassword', 'host', 'port'].forEach(function (k) {
      var el = $('tlei_' + src + '_' + k); if (el) f[k] = el.value;
    });
    return f;
  }
  function field(src, key, label, input, req, hint) {
    var e = S.errs[src][key];
    return '<div class="tlei-f' + (e ? ' bad' : '') + '"><label for="tlei_' + src + '_' + key + '">' + h(label) + (req ? ' <b class="tlei-req">*</b>' : '') + '</label>'
      + input + (e ? '<span class="tlei-err">' + h(e) + '</span>' : (hint ? '<span class="tlei-hint">' + hint + '</span>' : '')) + '</div>';
  }
  function formHtml(src) {
    var f = S.forms[src];
    var d = S.data || {};
    var provider = f.provider || 'gmail';
    var recs = (d.recruiters || []);
    var id = function (k) { return 'tlei_' + src + '_' + k; };
    var recSel = '<select id="' + id('recruiterId') + '"><option value="">Select recruiter…</option>'
      + recs.map(function (r) { return '<option value="' + h(r.id) + '"' + (f.recruiterId === r.id ? ' selected' : '') + '>' + h(r.name) + (r.email ? ' (' + h(r.email) + ')' : '') + '</option>'; }).join('') + '</select>';
    var provSel = '<select id="' + id('provider') + '" onchange="tleiProvider(\'' + src + '\')">'
      + [['gmail', 'Gmail'], ['outlook', 'Outlook / Microsoft 365'], ['other', 'Other (IMAP)']].map(function (p) {
        return '<option value="' + p[0] + '"' + (provider === p[0] ? ' selected' : '') + '>' + p[1] + '</option>';
      }).join('') + '</select>';
    var server = provider === 'gmail' ? 'imap.gmail.com : 993 (SSL)' : provider === 'outlook' ? 'outlook.office365.com : 993 (SSL)' : '';
    var busy = !!S.busy['connect_' + src];
    var msg = S.msg[src];
    return '<div class="tlei-card">'
      + '<div class="tlei-card-hd"><span class="tlei-logo ' + src + '">' + BOARD[src].charAt(0) + '</span><div><b>' + BOARD[src] + ' mailbox</b>'
      + '<span>Imports ' + BOARD[src] + ' applications only, into the selected recruiter\'s records.</span></div></div>'
      + (msg ? '<div class="tlei-msg ' + (msg.ok ? 'ok' : 'bad') + '">' + h(msg.text) + '</div>' : '')
      + '<div class="tlei-grid">'
      + field(src, 'recruiterId', 'Select Recruiter', recSel, true)
      + field(src, 'address', BOARD[src] + ' mailbox email', '<input id="' + id('address') + '" type="email" autocomplete="off" placeholder="responses@company.com" value="' + h(f.address || '') + '">', true)
      + field(src, 'provider', 'Email provider', provSel, true)
      + field(src, 'username', 'Username', '<input id="' + id('username') + '" autocomplete="off" placeholder="Same as the mailbox email" value="' + h(f.username || '') + '">', false)
      + field(src, 'appPassword', 'App Password', '<input id="' + id('appPassword') + '" type="password" autocomplete="new-password" placeholder="' + (provider === 'gmail' ? '16-character Google app password' : 'App password') + '" value="' + h(f.appPassword || '') + '">', true,
        provider === 'gmail' ? 'Google Account → Security → 2-Step Verification → App passwords. IMAP must be on in Gmail settings.' : 'Use an app password if the account has two-step sign-in.')
      + (provider === 'other'
        ? field(src, 'host', 'IMAP server', '<input id="' + id('host') + '" placeholder="imap.company.com" value="' + h(f.host || '') + '">', true)
          + field(src, 'port', 'Port (SSL)', '<input id="' + id('port') + '" type="number" min="1" max="65535" placeholder="993" value="' + h(f.port || '') + '">', false)
        : '<div class="tlei-f"><label>Incoming mail server</label><div class="tlei-fixed">' + h(server) + '</div></div>')
      + '</div>'
      + '<div class="tlei-card-ft"><span class="tlei-hint">The login is checked before anything is saved. The password is stored encrypted and never shown again.</span>'
      + '<button class="btn btn-primary btn-sm" ' + (busy ? 'disabled' : '') + ' onclick="tleiConnect(\'' + src + '\')">' + (busy ? 'Verifying login…' : 'Connect') + '</button></div>'
      + '</div>';
  }
  window.tleiProvider = function (src) { keep(src); S.errs[src] = {}; paint(); };

  window.tleiConnect = function (src) {
    var f = keep(src);
    var errs = {};
    if (!f.recruiterId) errs.recruiterId = 'Select a recruiter.';
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(f.address || '').trim())) errs.address = 'Enter a valid email address.';
    if (!f.appPassword) errs.appPassword = 'Enter the app password.';
    if ((f.provider || 'gmail') === 'other' && !String(f.host || '').trim()) errs.host = 'Enter the IMAP server.';
    S.errs[src] = errs; S.msg[src] = null;
    if (Object.keys(errs).length) { paint(); return; }
    S.busy['connect_' + src] = true; paint();
    var body = {
      source: src, recruiterId: f.recruiterId, address: String(f.address).trim(), provider: f.provider || 'gmail',
      appPassword: f.appPassword,
    };
    if (String(f.username || '').trim()) body.username = String(f.username).trim();
    if (body.provider === 'other') { body.host = String(f.host || '').trim(); if (f.port) body.port = Number(f.port); }
    api().post('/intake/source-connections', body).then(function (r) {
      S.busy['connect_' + src] = false;
      S.forms[src] = {};                 // the password leaves the page
      S.msg[src] = { ok: true, text: r.message || 'Connected.' };
      say(r.message || 'Connected.', '✅');
      load(true);
    }, function (e) {
      S.busy['connect_' + src] = false;
      S.forms[src].appPassword = '';
      var d = errDetails(e); var fe = {};
      Object.keys(d).forEach(function (k) { fe[k] = d[k]; });
      S.errs[src] = fe;
      S.msg[src] = { ok: false, text: errMsg(e) };
      paint();
    });
  };

  /* ------------------------------------------------------------------ *
   * the table
   * ------------------------------------------------------------------ */
  function chip(c) {
    var cls = { connected: 'ok', processing: 'run', disconnected: 'off', error: 'bad' }[c.status] || 'off';
    return '<span class="tlei-chip ' + cls + '">' + h(c.statusLabel) + '</span>'
      + (c.lastError ? '<div class="tlei-rowerr" title="' + h(c.lastError) + '">' + h(c.lastError.length > 90 ? c.lastError.slice(0, 90) + '…' : c.lastError) + '</div>' : '');
  }
  function tableHtml() {
    var rows = (S.data && S.data.connections) || [];
    if (!rows.length) {
      return '<div class="tlei-empty">No Naukri or Shine mailbox is connected yet. Connect one above - choose the recruiter, enter the mailbox and its app password.</div>';
    }
    return '<div class="table-wrap tlei-tablewrap"><table class="data tlei-table"><thead><tr>'
      + ['Recruiter Name', 'Source', 'Connected Mailbox', 'Connection Status', 'Last Successful Sync', 'Emails Processed', 'Candidates Imported', 'Duplicates Skipped', 'Pending Review', 'Failed Imports', 'Actions']
        .map(function (t) { return '<th>' + t + '</th>'; }).join('')
      + '</tr></thead><tbody>'
      + rows.map(function (c) {
        var b = function (act, label, cls, off) {
          return '<button class="btn ' + (cls || 'btn-ghost') + ' btn-sm" ' + (off ? 'disabled' : '') + ' onclick="tleiAct(\'' + act + '\',\'' + h(c.id) + '\')">' + label + '</button>';
        };
        var busy = !!S.busy[c.id];
        var off = c.status === 'disconnected';
        return '<tr data-id="' + h(c.id) + '">'
          + '<td><b>' + h(c.recruiterName || '—') + '</b></td>'
          + '<td><span class="tlei-src ' + h(c.source) + '">' + h(c.sourceLabel) + '</span></td>'
          + '<td>' + h(c.address) + '<div class="tlei-sub">' + h({ gmail: 'Gmail', outlook: 'Outlook', other: 'IMAP' }[c.provider] || c.provider) + '</div></td>'
          + '<td>' + chip(c) + '</td>'
          + '<td>' + h(when(c.lastSuccessfulSyncAt)) + '</td>'
          + '<td class="num">' + c.emailsProcessed + '</td>'
          + '<td class="num">' + c.candidatesImported + '</td>'
          + '<td class="num">' + c.duplicatesSkipped + '</td>'
          + '<td class="num">' + c.pendingReview + '</td>'
          + '<td class="num">' + c.failedImports + '</td>'
          + '<td><div class="tlei-acts">'
          + b('sync', busy ? 'Syncing…' : 'Sync Now', 'btn-primary', busy || off || c.status === 'processing')
          + b('reconnect', 'Reconnect', '', busy)
          + b('logs', 'View Logs', '', false)
          + b('reassign', 'Reassign', '', busy)
          + b('disconnect', 'Disconnect', 'tlei-danger', busy || off)
          + '</div></td></tr>';
      }).join('') + '</tbody></table></div>';
  }
  function byId(id) { return ((S.data && S.data.connections) || []).find(function (c) { return c.id === id; }); }

  window.tleiAct = function (act, id) {
    var c = byId(id); if (!c) return;
    if (act === 'sync') {
      S.busy[id] = true; paint();
      api().post('/intake/source-connections/' + encodeURIComponent(id) + '/sync', {}).then(function (r) {
        S.busy[id] = false;
        say(r.error ? ('Sync failed: ' + r.error)
          : ('Sync done: ' + r.emailsRead + ' read, ' + r.imported + ' imported, ' + r.duplicates + ' duplicates skipped, '
            + r.pendingReview + ' for review' + (r.failed ? ', ' + r.failed + ' failed' : '')), r.error ? '⚠️' : '✅');
        load(true);
      }, function (e) { S.busy[id] = false; say(errMsg(e), '⚠️'); load(true); });
    } else if (act === 'disconnect') {
      if (!window.confirm('Disconnect the ' + c.sourceLabel + ' mailbox ' + c.address + '?\n\nThe saved app password is erased and no more email is read. Candidates already imported stay with their recruiter.')) return;
      S.busy[id] = true; paint();
      api().post('/intake/source-connections/' + encodeURIComponent(id) + '/disconnect', {}).then(function (r) {
        S.busy[id] = false; say(r.message || 'Disconnected.', '🔌'); load(true);
      }, function (e) { S.busy[id] = false; say(errMsg(e), '⚠️'); load(true); });
    } else if (act === 'reconnect') {
      S.modal = { kind: 'reconnect', id: id, err: '' }; paint();
    } else if (act === 'reassign') {
      S.modal = { kind: 'reassign', id: id, err: '', recruiterId: '' }; paint();
    } else if (act === 'logs') {
      S.modal = { kind: 'logs', id: id, loading: true }; paint();
      api().get('/intake/source-connections/' + encodeURIComponent(id) + '/logs').then(function (r) {
        if (!S.modal || S.modal.id !== id) return;
        S.modal.loading = false; S.modal.emails = r.emails || []; S.modal.events = r.events || []; paint();
      }, function (e) { if (S.modal) { S.modal.loading = false; S.modal.err = errMsg(e); paint(); } });
    }
  };

  /* ------------------------------------------------------------------ *
   * the dialogs: Reconnect, Reassign, View Logs
   * ------------------------------------------------------------------ */
  var EVENT = {
    'intake.mailbox_connected': 'Connected', 'intake.mailbox_reconnected': 'Reconnected', 'intake.mailbox_disconnected': 'Disconnected',
    'intake.mailbox_reassigned': 'Reassigned', 'intake.mailbox_synced': 'Synced',
  };
  function recName(id) { var r = ((S.data && S.data.recruiters) || []).find(function (x) { return x.id === id; }); return r ? r.name : id; }
  function modalHtml() {
    var m = S.modal; if (!m) return '';
    var c = byId(m.id) || {};
    var inner = '';
    var foot = '<button class="btn btn-ghost btn-sm" onclick="tleiClose()">' + (m.kind === 'logs' ? 'Close' : 'Cancel') + '</button>';
    var title = '';
    if (m.kind === 'reconnect') {
      title = 'Reconnect ' + (c.sourceLabel || '') + ' mailbox';
      inner = '<p class="tlei-p">' + h(c.address) + ' - the login is tested again before it is marked connected.'
        + (c.hasCredential ? ' Leave the password empty to use the saved one, or enter a new app password.' : ' The saved password was erased when it was disconnected, so enter the app password.') + '</p>'
        + '<div class="tlei-f"><label for="tleiRePw">App Password' + (c.hasCredential ? '' : ' <b class="tlei-req">*</b>') + '</label><input id="tleiRePw" type="password" autocomplete="new-password"></div>';
      foot += '<button class="btn btn-primary btn-sm" ' + (m.busy ? 'disabled' : '') + ' onclick="tleiReconnect()">' + (m.busy ? 'Verifying login…' : 'Reconnect') + '</button>';
    } else if (m.kind === 'reassign') {
      title = 'Reassign ' + (c.sourceLabel || '') + ' mailbox';
      var recs = (S.data && S.data.recruiters) || [];
      inner = '<p class="tlei-p"><b>' + h(c.address) + '</b> is connected to <b>' + h(c.recruiterName || '—') + '</b>. '
        + 'New emails imported from now on will belong to the recruiter you choose. Candidates already imported stay with ' + h(c.recruiterName || 'their recruiter') + ' - nothing is moved.</p>'
        + '<div class="tlei-f"><label for="tleiReRec">New recruiter <b class="tlei-req">*</b></label><select id="tleiReRec"><option value="">Select recruiter…</option>'
        + recs.filter(function (r) { return r.id !== c.recruiterId; }).map(function (r) { return '<option value="' + h(r.id) + '"' + (m.recruiterId === r.id ? ' selected' : '') + '>' + h(r.name) + '</option>'; }).join('')
        + '</select></div>'
        + '<label class="tlei-check"><input type="checkbox" id="tleiReOk"> I understand: only new imports go to the new recruiter. This change is recorded in the audit log.</label>';
      foot += '<button class="btn btn-primary btn-sm" ' + (m.busy ? 'disabled' : '') + ' onclick="tleiReassign()">Reassign</button>';
    } else if (m.kind === 'logs') {
      title = (c.sourceLabel || '') + ' mailbox logs - ' + (c.address || '');
      if (m.loading) inner = '<div class="tlei-empty">Loading…</div>';
      else if (m.err) inner = '<div class="tlei-msg bad">' + h(m.err) + '</div>';
      else {
        var em = m.emails || [];
        inner = '<h4 class="tlei-h4">Emails</h4>'
          + (em.length ? '<div class="table-wrap"><table class="data tlei-table"><thead><tr><th>Received</th><th>From</th><th>Subject</th><th>Status</th><th>Details</th><th>Candidate</th></tr></thead><tbody>'
            + em.map(function (x) {
              var cls = { processed: 'ok', duplicate: 'off', needs_review: 'warn', needs_mapping: 'warn', failed: 'bad', 'new': 'run', ignored: 'off' }[x.status] || 'off';
              return '<tr><td>' + h(when(x.receivedAt)) + '</td><td>' + h(x.from || '—') + '</td><td>' + h(x.subject || '—') + '</td>'
                + '<td><span class="tlei-chip ' + cls + '">' + h(x.statusLabel) + '</span></td><td class="tlei-reason">' + h(x.reason || '') + '</td>'
                + '<td>' + h(x.candidateName || '—') + '</td></tr>';
            }).join('') + '</tbody></table></div>'
            : '<div class="tlei-empty">No email has been read from this mailbox yet.</div>')
          + '<h4 class="tlei-h4">Connection history</h4>'
          + ((m.events || []).length ? '<ul class="tlei-events">' + m.events.map(function (ev) {
            var d = ev.detail || {};
            var extra = ev.action === 'intake.mailbox_reassigned' ? ' - from ' + recName(d.from) + ' to ' + recName(d.to)
              : ev.action === 'intake.mailbox_synced' ? ' - ' + (d.seen || 0) + ' read, ' + (d.imported || 0) + ' imported, ' + (d.duplicates || 0) + ' duplicates, ' + (d.review || 0) + ' for review, ' + (d.failed || 0) + ' failed'
              : ev.action === 'intake.mailbox_connected' && d.recruiterId ? ' - to ' + recName(d.recruiterId) : '';
            return '<li><b>' + h(EVENT[ev.action] || ev.action) + '</b>' + h(extra) + ' <span>' + h(when(ev.at)) + '</span></li>';
          }).join('') + '</ul>' : '<div class="tlei-empty">Nothing yet.</div>');
      }
    }
    return '<div class="tlei-ov" onclick="if(event.target===this)tleiClose()"><div class="tlei-modal' + (m.kind === 'logs' ? ' wide' : '') + '" role="dialog" aria-modal="true">'
      + '<div class="tlei-mhd"><h3>' + h(title) + '</h3><button class="tlei-x" onclick="tleiClose()" aria-label="Close">✕</button></div>'
      + '<div class="tlei-mbody">' + (m.err && m.kind !== 'logs' ? '<div class="tlei-msg bad">' + h(m.err) + '</div>' : '') + inner + '</div>'
      + '<div class="tlei-mft">' + foot + '</div></div></div>';
  }
  window.tleiClose = function () { S.modal = null; paint(); };
  window.tleiReconnect = function () {
    var m = S.modal; var c = byId(m.id) || {};
    var pw = ($('tleiRePw') || {}).value || '';
    if (!pw && !c.hasCredential) { m.err = 'Enter the app password.'; paint(); return; }
    m.busy = true; m.err = ''; paint();
    api().post('/intake/source-connections/' + encodeURIComponent(m.id) + '/reconnect', pw ? { appPassword: pw } : {}).then(function (r) {
      S.modal = null; say(r.message || 'Reconnected.', '✅'); load(true);
    }, function (e) { m.busy = false; m.err = errMsg(e); paint(); load(true); });
  };
  window.tleiReassign = function () {
    var m = S.modal;
    var rid = ($('tleiReRec') || {}).value || '';
    m.recruiterId = rid;
    if (!rid) { m.err = 'Select the new recruiter.'; paint(); return; }
    if (!($('tleiReOk') || {}).checked) { m.err = 'Tick the box to confirm the reassignment.'; paint(); return; }
    m.busy = true; m.err = ''; paint();
    api().post('/intake/source-connections/' + encodeURIComponent(m.id) + '/reassign', { recruiterId: rid, confirm: true }).then(function (r) {
      S.modal = null; say(r.message || 'Reassigned.', '✅'); load(true);
    }, function (e) { m.busy = false; m.err = errMsg(e); paint(); });
  };

  /* ------------------------------------------------------------------ *
   * the page
   * ------------------------------------------------------------------ */
  function bodyHtml() {
    if (S.loading && !S.data) return '<div class="tlei-empty">Loading the mailbox connections…</div>';
    if (S.error && !S.data) {
      return '<div class="tlei-msg bad">' + h(S.error) + '</div><button class="btn btn-ghost btn-sm" onclick="tleiReload()">Try again</button>';
    }
    if (!S.data) return '<div class="tlei-empty">Loading the mailbox connections…</div>';
    return (S.data.canStoreCredentials === false
      ? '<div class="tlei-msg bad">The server cannot store mailbox passwords yet: INTEGRATION_SECRET_KEY is not set (at least 16 characters). Set it in the server environment and restart; until then, Connect is refused.</div>' : '')
      + '<div class="tlei-cards">' + formHtml('naukri') + formHtml('shine') + '</div>'
      + '<div class="tlei-tablehd"><b>Connected mailboxes</b><button class="btn btn-ghost btn-sm" onclick="tleiReload()">Refresh</button></div>'
      + tableHtml()
      + '<p class="tlei-foot">Each mailbox imports only its own job board\'s emails, and only into the recruiter chosen for it. Emails that cannot be matched safely are kept for review instead of being guessed. Syncing again never imports the same email twice.</p>';
  }
  function pageHtml() {
    return '<div id="tleiRoot" class="tlei">' + bodyHtml() + '</div><div id="tleiModal">' + modalHtml() + '</div>';
  }
  window.tleiReload = function () { load(); };

  function paint() {
    if (!onPage()) return;
    /* keep what is typed in the forms across a repaint */
    if ($('tlei_naukri_address')) keep('naukri');
    if ($('tlei_shine_address')) keep('shine');
    var root = $('tleiRoot'); if (root) root.innerHTML = bodyHtml();
    var mod = $('tleiModal'); if (mod) mod.innerHTML = modalHtml();
  }

  function css() {
    if ($('tlei-css')) return;
    var s = document.createElement('style');
    s.id = 'tlei-css';
    s.textContent = ''
      + '.tlei-cards{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:0 0 18px}'
      + '.tlei-card{background:var(--card,#fff);border:1px solid var(--line,#e3e8ef);border-radius:12px;padding:16px;display:flex;flex-direction:column}'
      + '.tlei-card-hd{display:flex;gap:10px;align-items:center;margin-bottom:12px}.tlei-card-hd b{display:block;font-size:15px}.tlei-card-hd span{font-size:12.5px;color:var(--text-soft,#5b6b7d)}'
      + '.tlei-logo{width:34px;height:34px;border-radius:9px;display:flex;align-items:center;justify-content:center;font-weight:800;color:#fff;flex:none}'
      + '.tlei-logo.naukri{background:#2563eb}.tlei-logo.shine{background:#f59e0b}'
      + '.tlei-grid{display:grid;grid-template-columns:1fr 1fr;gap:4px 12px}'
      + '.tlei-f{display:flex;flex-direction:column;gap:4px;margin-bottom:10px;min-width:0}.tlei-f label{font-size:12px;font-weight:700;color:#41506a}'
      + '.tlei-f input,.tlei-f select{border:1px solid #d7dfea;border-radius:8px;padding:8px 10px;font:inherit;font-size:13.5px;min-width:0;background:#fff}'
      + '.tlei-f.bad input,.tlei-f.bad select{border-color:#d4342c}'
      + '.tlei-fixed{font-size:13px;color:#41506a;padding:8px 0}'
      + '.tlei-req{color:#d4342c}.tlei-err{font-size:11.5px;color:#b42318;font-weight:600}.tlei-hint{font-size:11.5px;color:#5f7183}'
      + '.tlei-card-ft{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:auto;padding-top:6px;flex-wrap:wrap}'
      + '.tlei-card-ft .tlei-hint{flex:1;min-width:180px}'
      + '.tlei-msg{border-radius:9px;padding:9px 12px;font-size:13px;margin:0 0 10px}.tlei-msg.bad{background:#fef3f2;color:#b42318}.tlei-msg.ok{background:#ecfdf3;color:#067647}'
      + '.tlei-tablehd{display:flex;justify-content:space-between;align-items:center;margin:0 0 8px}.tlei-tablehd b{font-size:15px}'
      + '.tlei-tablewrap{overflow-x:auto}.tlei-table td,.tlei-table th{white-space:nowrap;vertical-align:top}.tlei-table td.num{text-align:center}'
      + '.tlei-table td.tlei-reason{white-space:normal;min-width:220px;font-size:12.5px;color:#41506a}'
      + '.tlei-sub{font-size:11.5px;color:#5f7183}'
      + '.tlei-acts{display:flex;gap:5px;flex-wrap:nowrap}'
      + '.tlei-danger{background:#fff;border:1px solid #f2c4c0;color:#b42318}'
      + '.tlei-chip{display:inline-block;font-size:11.5px;font-weight:700;border-radius:99px;padding:2px 9px;background:#eef2f7;color:#4b5b6e}'
      + '.tlei-chip.ok{background:#ecfdf3;color:#067647}.tlei-chip.bad{background:#fef3f2;color:#b42318}.tlei-chip.run{background:#eff6ff;color:#1d4ed8}.tlei-chip.warn{background:#fffaeb;color:#b54708}'
      + '.tlei-rowerr{font-size:11px;color:#b42318;max-width:220px;white-space:normal;margin-top:3px}'
      + '.tlei-src{font-weight:700;font-size:12px;border-radius:6px;padding:2px 8px}.tlei-src.naukri{background:#eff6ff;color:#1d4ed8}.tlei-src.shine{background:#fffaeb;color:#b54708}'
      + '.tlei-empty{background:var(--card,#fff);border:1px dashed var(--line,#d7dfea);border-radius:12px;padding:22px;text-align:center;color:#5f7183;font-size:13.5px}'
      + '.tlei-foot{font-size:12px;color:#5f7183;margin:12px 0 0}'
      + '.tlei-ov{position:fixed;inset:0;background:rgba(18,32,48,.38);z-index:9100;display:flex;align-items:center;justify-content:center;padding:20px}'
      + '.tlei-modal{background:#fff;border-radius:16px;width:100%;max-width:520px;max-height:90vh;display:flex;flex-direction:column;box-shadow:0 18px 50px rgba(16,32,52,.22)}'
      + '.tlei-modal.wide{max-width:1000px}'
      + '.tlei-mhd{display:flex;align-items:center;padding:16px 20px 8px}.tlei-mhd h3{margin:0;font-size:17px;flex:1}'
      + '.tlei-x{background:none;border:0;font-size:15px;cursor:pointer;color:#8a97a6}'
      + '.tlei-mbody{padding:4px 20px 12px;overflow:auto}.tlei-p{font-size:13.5px;color:#41506a;margin:0 0 12px}'
      + '.tlei-check{display:flex;gap:8px;align-items:flex-start;font-size:13px;color:#41506a}'
      + '.tlei-h4{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#5f7183;margin:12px 0 8px}'
      + '.tlei-events{list-style:none;padding:0;margin:0;font-size:13px}.tlei-events li{padding:6px 0;border-bottom:1px solid #eef2f7}.tlei-events span{color:#8a97a6;font-size:12px}'
      + '.tlei-mft{display:flex;justify-content:flex-end;gap:8px;padding:12px 20px;border-top:1px solid #eef2f7;background:#fbfcfe;border-radius:0 0 16px 16px}'
      + '@media (max-width:900px){.tlei-cards{grid-template-columns:1fr}}'
      + '@media (max-width:560px){.tlei-grid{grid-template-columns:1fr}.tlei-ov{padding:0}.tlei-modal{max-height:100%;height:100%;border-radius:0}}';
    document.head.appendChild(s);
  }

  /* ------------------------------------------------------------------ *
   * wiring: the page, inside the Integrations module
   * ------------------------------------------------------------------ */
  function install() {
    if (typeof window.pageAdminDash !== 'function' || typeof window.dashShell !== 'function') return false;
    css();
    try {
      /* the address resolves to a page title like every other Admin page; the sidebar shows the seven modules */
      var nav = (typeof NAV_CONFIG !== 'undefined' && NAV_CONFIG.admin) || null;
      if (nav && !nav.some(function (n) { return n[0] === SECTION; })) nav.push([SECTION, 'Naukri & Shine Email Import', '📥']);
    } catch (e) { /* reachable by URL */ }
    if (!window.pageAdminDash.__tlei) {
      var prev = window.pageAdminDash;
      var next = function (section) {
        if (section !== SECTION) return prev.apply(this, arguments);
        setTimeout(function () { load(!!S.data); }, 0);
        return window.dashShell('admin', SECTION, 'Naukri &amp; Shine Email Import', 'Admin · Integrations', pageHtml());
      };
      next.__tlei = true;
      window.pageAdminDash = next;
    }
    if (onPage() && window.STATE && STATE.session && STATE.session.role === 'admin' && typeof window.render === 'function') window.render();
    return true;
  }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && S.modal) { S.modal = null; paint(); } });
  window.addEventListener('hashchange', function () { if (!onPage()) { clearTimeout(S.poll); S.modal = null; } });

  var tries = 0;
  function boot() { if (!install() && tries++ < 40) setTimeout(boot, 250); }
  if (document.readyState === 'complete') setTimeout(boot, 0);
  else window.addEventListener('load', function () { setTimeout(boot, 0); });
})();
