/*
 * WhatsApp Inbox (0161) - a WhatsApp Web-style inbox inside the Recruiter Portal.
 *
 *   tlWhatsAppInbox([{ numberId, contact }])    opened by the WhatsApp button in the header of every recruiter page
 *
 *   left     the conversations this person may see: avatar, name, number, latest message, time, unread count, campaign, owner; searchable
 *   middle   the conversation: every message with delivery ticks, the campaign it answers and the message it replies to, photos and documents,
 *            and the reply box (free text inside WhatsApp's 24-hour window; otherwise a template)
 *   right    filters (campaign, recruiter, department, date, unread, reply status, number) and the selected conversation's campaign and owner;
 *            an administrator reassigns it from here
 *
 * It holds no data of its own: everything is read from /api/whatsapp/inbox/* (the database decides who may see what), and it is kept live by
 * server-sent events - an event only says "something changed", and the page then asks for it, so nothing is shown to somebody who may not see it.
 * The header badge (unread) is kept by the same events, on every page, whether or not the inbox is open.
 */
(function () {
  'use strict';

  var API = '/whatsapp/inbox';            // through TL.api (which adds /api)
  var RAW = '/api/whatsapp/inbox';        // for the browser itself: the live stream, files and images
  var I = null;                      // the open inbox
  var badge = { unread: 0, waiting: 0, ready: false };
  var es = null, esOk = false, poll = null, refreshTimer = null;

  var api = function () { return window.TL && window.TL.api; };
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var errText = function (e) { return (e && e.message) ? String(e.message) : 'Something went wrong. Please try again.'; };
  var toast = function (m, i) { if (typeof window.toast === 'function') { try { window.toast(m, i || 'ℹ️'); } catch (e) { /* none */ } } };
  var uid = function () { try { if (window.crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (e) { /* older */ } return 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10); };
  var cookie = function (n) { var m = document.cookie.match(new RegExp('(?:^|; )' + n + '=([^;]*)')); return m ? decodeURIComponent(m[1]) : ''; };
  var isStaff = function () { try { var r = window.STATE && STATE.session && STATE.session.role; return r === 'recruiter' || r === 'bde' || r === 'admin'; } catch (e) { return false; } };

  /* ------------------------------------------------------------------ small helpers */
  var COLORS = ['#128c4a', '#2f7de1', '#8a4fd6', '#d9822b', '#c0392b', '#0d8aa8', '#7a8b2c', '#b5487a'];
  function avatar(name, contact, size) {
    var label = (name || '').trim();
    var ini = label ? label.split(/\s+/).slice(0, 2).map(function (w) { return w[0]; }).join('').toUpperCase() : '#';
    var h = 0, k = (contact || label); for (var i = 0; i < k.length; i += 1) h = (h * 31 + k.charCodeAt(i)) >>> 0;
    return '<span class="wib-av" style="background:' + COLORS[h % COLORS.length] + (size ? ';width:' + size + 'px;height:' + size + 'px;font-size:' + Math.round(size * 0.38) + 'px' : '') + '">' + esc(ini) + '</span>';
  }
  function sameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
  function clock(t) { return new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); }
  function stamp(t) {
    var d = new Date(t), now = new Date();
    if (sameDay(d, now)) return clock(t);
    var y = new Date(now.getTime() - 86400000);
    if (sameDay(d, y)) return 'Yesterday';
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }
  function dayLabel(t) {
    var d = new Date(t), now = new Date();
    if (sameDay(d, now)) return 'Today';
    if (sameDay(d, new Date(now.getTime() - 86400000))) return 'Yesterday';
    return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  }
  /* WhatsApp's own ticks, from what the provider reported */
  function ticks(status) {
    if (status === 'read') return '<span class="wib-tk wib-read" title="Read">✓✓</span>';
    if (status === 'delivered') return '<span class="wib-tk" title="Delivered">✓✓</span>';
    if (status === 'failed') return '<span class="wib-tk wib-fail" title="Failed">⚠</span>';
    if (status === 'sending') return '<span class="wib-tk" title="Sending">🕓</span>';
    return '<span class="wib-tk" title="Sent">✓</span>';
  }
  var STATUS_WORD = { sending: 'Sending', sent: 'Sent', delivered: 'Delivered', read: 'Read', failed: 'Failed' };

  /* ------------------------------------------------------------------ styles */
  function style() {
    if ($('wib-style')) return;
    var css = ''
      + '.wib-hbadge{display:inline-block;min-width:18px;height:18px;border-radius:9px;background:#e0463a;color:#fff;font-size:11px;font-weight:800;line-height:18px;text-align:center;padding:0 5px;margin-left:6px}'
      + '.wib-ov{position:fixed;inset:0;z-index:9450;background:rgba(11,18,32,.55);display:flex;align-items:center;justify-content:center;padding:14px}'
      + '.wib{background:var(--surface,#fff);color:var(--ink-900,#0b1220);width:min(1500px,100%);height:calc(100vh - 28px);border-radius:14px;box-shadow:0 24px 60px rgba(0,0,0,.35);overflow:hidden;'
        + 'display:grid;grid-template-columns:minmax(300px,340px) minmax(0,1fr) minmax(250px,300px);position:relative}'
      + '.wib-col{display:flex;flex-direction:column;min-height:0;min-width:0}'
      + '.wib-left{border-right:1px solid var(--border,#dde2ea);background:var(--surface,#fff)}.wib-right{border-left:1px solid var(--border,#dde2ea);background:var(--paper-50,#f6f8fb);overflow:auto}'
      + '.wib-top{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--border,#dde2ea);min-height:56px;box-sizing:border-box}'
      + '.wib-top h2{margin:0;font-size:17px;flex:1;display:flex;align-items:center;gap:8px}.wib-dot{width:24px;height:24px;border-radius:50%;background:#25d366;color:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:13px}'
      + '.wib-x{border:0;background:transparent;font-size:19px;cursor:pointer;color:var(--ink-500,#5b6678);padding:2px 8px;border-radius:8px}.wib-x:hover{background:var(--paper-50,#eef1f5)}'
      + '.wib-search{padding:8px 12px;border-bottom:1px solid var(--border,#dde2ea)}'
      + '.wib-in{width:100%;box-sizing:border-box;border:1px solid var(--border,#dde2ea);border-radius:9px;padding:8px 10px;font:inherit;font-size:13px;background:var(--surface,#fff)}'
      + '.wib-list{flex:1;overflow:auto;min-height:0}'
      + '.wib-item{display:flex;gap:10px;padding:10px 12px;border-bottom:1px solid var(--border,#eef0f4);cursor:pointer;align-items:flex-start}.wib-item:hover{background:var(--paper-50,#f6f8fb)}.wib-item.on{background:#eefaf3}'
      + '.wib-av{width:42px;height:42px;border-radius:50%;color:#fff;font-weight:800;font-size:15px;display:inline-flex;align-items:center;justify-content:center;flex:none}'
      + '.wib-im{flex:1;min-width:0}.wib-l1{display:flex;gap:6px;align-items:baseline}.wib-nm{font-weight:700;font-size:13.5px;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
      + '.wib-tm{font-size:11.5px;color:var(--ink-500,#5b6678);flex:none}.wib-tm.u{color:#128c4a;font-weight:700}'
      + '.wib-l2{display:flex;gap:6px;align-items:center;margin-top:2px}.wib-pv{flex:1;min-width:0;font-size:12.5px;color:var(--ink-500,#5b6678);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
      + '.wib-un{background:#25d366;color:#fff;border-radius:10px;min-width:19px;height:19px;font-size:11px;font-weight:800;line-height:19px;text-align:center;padding:0 5px;flex:none}'
      + '.wib-sub{font-size:11px;color:var(--ink-500,#5b6678);margin-top:3px;display:flex;gap:5px;flex-wrap:wrap}'
      + '.wib-chip{display:inline-block;border-radius:999px;padding:1px 8px;font-size:10.5px;font-weight:700;background:var(--paper-50,#eef1f5);white-space:nowrap}'
      + '.wib-camp{background:#e8f1fb;color:#1c4f87}.wib-warn{background:var(--warn-100,#fbeed8);color:var(--warn-600,#8a5410)}.wib-ok{background:var(--ok-100,#e2f5ec);color:var(--ok-600,#1e8e5a)}'
      + '.wib-mid{background:#efeae2}.wib-mid .wib-top{background:var(--surface,#fff)}'
      + '.wib-banner{background:#e8f1fb;color:#1c4f87;padding:8px 14px;font-size:12.5px;border-bottom:1px solid #cfe1f6}.wib-banner q{display:block;margin-top:2px;color:#33506f;quotes:none;font-style:italic;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
      + '.wib-msgs{flex:1;overflow:auto;padding:12px 6%;display:flex;flex-direction:column;gap:3px;min-height:0}'
      + '.wib-day{align-self:center;background:#fff;border-radius:8px;padding:3px 11px;font-size:11.5px;color:#5b6678;margin:8px 0;box-shadow:0 1px 1px rgba(0,0,0,.08)}'
      + '.wib-m{max-width:min(560px,78%);border-radius:9px;padding:6px 9px 4px;font-size:13.5px;line-height:1.42;box-shadow:0 1px 1px rgba(0,0,0,.13);word-break:break-word}'
      + '.wib-m.in{align-self:flex-start;background:#fff;border-top-left-radius:2px}.wib-m.out{align-self:flex-end;background:#d9fdd3;border-top-right-radius:2px}'
      + '.wib-m .t{white-space:pre-wrap}.wib-m .f{display:flex;justify-content:flex-end;gap:4px;align-items:center;font-size:10.5px;color:#667781;margin-top:2px}'
      + '.wib-m .by{font-size:11px;font-weight:700;color:#128c4a;margin-bottom:1px}.wib-m.in .by{color:#6a5acd}'
      + '.wib-tk{font-size:11.5px;color:#8696a0;letter-spacing:-2px}.wib-tk.wib-read{color:#34b7f1}.wib-tk.wib-fail{color:#d93025;letter-spacing:0}'
      + '.wib-quote{background:rgba(0,0,0,.06);border-left:3px solid #128c4a;border-radius:6px;padding:4px 8px;margin-bottom:4px;font-size:12px;color:#54656f;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
      + '.wib-err{color:#d93025;font-size:11.5px;margin-top:2px}.wib-img{display:block;max-width:100%;max-height:300px;border-radius:7px;margin-bottom:4px;cursor:zoom-in;background:#eee}'
      + '.wib-doc{display:flex;gap:8px;align-items:center;background:rgba(0,0,0,.05);border-radius:7px;padding:8px 10px;margin-bottom:4px;color:inherit;text-decoration:none}'
      + '.wib-camptag{align-self:center;font-size:11.5px;background:#fff7d6;border-radius:8px;padding:3px 10px;color:#6b5400;margin:6px 0;box-shadow:0 1px 1px rgba(0,0,0,.08)}'
      + '.wib-comp{background:var(--paper-50,#f0f2f5);border-top:1px solid var(--border,#dde2ea);padding:8px 12px}'
      + '.wib-note{font-size:12px;color:var(--ink-500,#5b6678);margin:0 2px 6px}.wib-note.w{color:var(--warn-600,#8a5410)}'
      + '.wib-row{display:flex;gap:8px;align-items:flex-end}.wib-ta{flex:1;border:1px solid var(--border,#dde2ea);border-radius:20px;padding:9px 14px;font:inherit;font-size:13.5px;resize:none;max-height:120px;min-height:38px;box-sizing:border-box;background:#fff}'
      + '.wib-btn{border:1px solid var(--border,#dde2ea);background:var(--surface,#fff);border-radius:8px;padding:7px 12px;font:inherit;font-size:12.5px;font-weight:650;cursor:pointer;white-space:nowrap}.wib-btn:hover{border-color:#25d366}'
      + '.wib-btn.p{background:#128c4a;border-color:#128c4a;color:#fff}.wib-btn[disabled]{opacity:.5;cursor:not-allowed}.wib-round{width:38px;height:38px;border-radius:50%;padding:0;font-size:16px}'
      + '.wib-side{padding:12px 14px}.wib-side h3{margin:14px 0 6px;font-size:11.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--ink-500,#5b6678)}.wib-side h3:first-child{margin-top:0}'
      + '.wib-side label{display:block;font-size:12px;font-weight:700;margin:8px 0 3px}.wib-side select,.wib-side input[type=date]{width:100%;box-sizing:border-box;border:1px solid var(--border,#dde2ea);border-radius:8px;padding:7px 8px;font:inherit;font-size:12.5px;background:#fff}'
      + '.wib-card{background:#fff;border:1px solid var(--border,#dde2ea);border-radius:10px;padding:10px 12px;font-size:12.5px;line-height:1.5}.wib-card b{display:block;font-size:11px;color:var(--ink-500,#5b6678);text-transform:uppercase;letter-spacing:.04em;margin-top:6px}.wib-card b:first-child{margin-top:0}'
      + '.wib-empty{margin:auto;text-align:center;color:var(--ink-500,#5b6678);padding:30px;font-size:14px}'
      + '.wib-back,.wib-fbtn{display:none}'
      + '@media (max-width:1180px){.wib{grid-template-columns:minmax(280px,320px) minmax(0,1fr)}.wib-right{position:absolute;right:0;top:0;bottom:0;width:min(320px,92%);z-index:3;box-shadow:-8px 0 24px rgba(0,0,0,.18);display:none}'
        + '.wib.fopen .wib-right{display:block}.wib-fbtn{display:inline-block}}'
      + '@media (max-width:760px){.wib-ov{padding:0}.wib{height:100vh;border-radius:0;grid-template-columns:1fr}.wib .wib-mid{display:none}.wib.chat .wib-left{display:none}.wib.chat .wib-mid{display:flex}.wib-back{display:inline-block}.wib-msgs{padding:10px 8px}.wib-m{max-width:88%}}';
    var st = document.createElement('style'); st.id = 'wib-style'; st.textContent = css; document.head.appendChild(st);
  }

  /* ------------------------------------------------------------------ header badge and live connection (every recruiter page) */
  function paintBadge() {
    var el = $('wxInboxBadge'); if (!el) return;
    var n = badge.unread;
    el.textContent = n > 99 ? '99+' : String(n);
    el.style.display = n > 0 ? 'inline-block' : 'none';
  }
  function loadSummary() {
    if (!api() || !isStaff()) return;
    api().get(API + '/summary').then(function (r) { badge.unread = r.unread || 0; badge.waiting = r.waiting || 0; badge.ready = true; paintBadge(); }, function () { /* the badge just stays */ });
  }
  function connect() {
    if (es || !isStaff() || typeof EventSource === 'undefined') return;
    try {
      es = new EventSource(RAW + '/stream', { withCredentials: true });
      es.onopen = function () { esOk = true; };
      es.addEventListener('inbox', function (ev) {
        var d = {}; try { d = JSON.parse(ev.data); } catch (e) { /* none */ }
        loadSummary();
        if (I) scheduleRefresh(d.conversationId);
      });
      es.onerror = function () { esOk = false; };
    } catch (e) { es = null; }
  }
  function boot() {
    var tries = 0;
    var t = setInterval(function () {
      tries += 1;
      if (tries > 120) { clearInterval(t); return; }
      if (!window.TL || !TL.ready || !api() || !isStaff()) return;
      clearInterval(t);
      loadSummary(); connect();
      /* the safety net: if the live connection is down, ask now and then; and keep the badge on whatever page is open */
      poll = setInterval(function () { if (!isStaff()) return; if (!esOk) { loadSummary(); if (I) scheduleRefresh(null); } paintBadge(); }, 15000);
      setInterval(paintBadge, 1500);
    }, 500);
  }
  boot();

  /* ------------------------------------------------------------------ the inbox */
  window.tlWhatsAppInbox = function (opts) {
    opts = opts || {};
    if (!api()) { toast('The portal is not ready yet.', '⏳'); return; }
    if (I) { if (opts.numberId || opts.contact) openByContact(opts.numberId, opts.contact); return; }
    style();
    I = { list: null, sel: null, thread: null, meta: null, f: { q: '', numberId: opts.numberId || '', campaign: '', assignee: '', department: '', from: '', to: '', unread: false, reply: '' },
      text: '', sending: false, pending: [], error: '', listErr: '', reqSeq: 0, thrSeq: 0, last: document.activeElement, mobileChat: false, filtersOpen: false, uploading: false };
    var root = document.createElement('div'); root.id = 'wibRoot'; document.body.appendChild(root);
    root.addEventListener('mousedown', function (e) { if (e.target === root.firstChild && I) I.down = true; else if (I) I.down = false; });
    root.addEventListener('click', function (e) { if (I && e.target === root.firstChild && I.down) wibClose(); });
    document.addEventListener('keydown', onKey);
    window.addEventListener('hashchange', wibClose);
    shell();
    api().get(API + '/filters').then(function (m) { if (!I) return; I.meta = m; renderSide(); }, function () { if (I) { I.meta = { campaigns: [], assignees: [], departments: [], numbers: [], staff: [] }; renderSide(); } });
    loadList(function () { if (opts.contact) openByContact(opts.numberId, opts.contact); });
  };
  function onKey(e) { if (e.key === 'Escape' && I) { if (I.filtersOpen) { I.filtersOpen = false; $('wibBox').classList.remove('fopen'); } else wibClose(); } }
  function wibClose() {
    if (!I) return;
    clearTimeout(refreshTimer);
    document.removeEventListener('keydown', onKey); window.removeEventListener('hashchange', wibClose);
    var r = $('wibRoot'); if (r && r.parentNode) r.parentNode.removeChild(r);
    var f = I.last; I = null;
    try { if (f && f.focus) f.focus(); } catch (e) { /* gone */ }
    loadSummary();
  }
  window.wibClose = wibClose;

  function shell() {
    var root = $('wibRoot');
    root.innerHTML = '<div class="wib-ov"><div class="wib" id="wibBox" role="dialog" aria-modal="true" aria-label="WhatsApp Inbox">'
      + '<div class="wib-col wib-left"><div class="wib-top"><h2><span class="wib-dot">✆</span>WhatsApp</h2><span class="wib-chip" id="wibCount"></span><button class="wib-x" onclick="wibClose()" aria-label="Close">✕</button></div>'
      + '<div class="wib-search"><input id="wibQ" class="wib-in" type="search" placeholder="Search by name, number or message…" oninput="wibSearch(this.value)" aria-label="Search conversations"></div>'
      + '<div class="wib-list" id="wibList"><div class="wib-empty">Loading…</div></div></div>'
      + '<div class="wib-col wib-mid" id="wibMid"></div>'
      + '<div class="wib-col wib-right" id="wibSide"></div></div></div>';
    renderMid(); renderSide();
  }

  /* ---- the list ---- */
  function query() {
    var f = I.f, p = [];
    ['q', 'numberId', 'campaign', 'assignee', 'department', 'from', 'to', 'reply'].forEach(function (k) { if (f[k]) p.push(k + '=' + encodeURIComponent(f[k])); });
    if (f.unread) p.push('unread=1');
    return p.length ? '?' + p.join('&') : '';
  }
  function loadList(done) {
    if (!I) return;
    var my = ++I.reqSeq, mine = I;
    api().get(API + '/conversations' + query()).then(function (r) {
      if (I !== mine || my !== I.reqSeq) return;
      I.list = r.conversations || []; I.listErr = ''; renderList(); if (done) done();
    }, function (e) { if (I !== mine || my !== I.reqSeq) return; I.listErr = errText(e); renderList(); });
  }
  function scheduleRefresh(convId) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(function () {
      if (!I) return;
      loadList();
      if (I.sel && (!convId || convId === I.sel)) loadThread(true);
    }, 250);
  }
  var searchTimer = null;
  window.wibSearch = function (v) { if (!I) return; I.f.q = v; clearTimeout(searchTimer); searchTimer = setTimeout(function () { loadList(); }, 250); };

  function renderList() {
    var el = $('wibList'); if (!el || !I) return;
    var c = $('wibCount');
    if (I.listErr) { el.innerHTML = '<div class="wib-empty"><div style="color:#c0392b">' + esc(I.listErr) + '</div><button class="wib-btn" style="margin-top:10px" onclick="wibReload()">Try again</button></div>'; return; }
    if (I.list === null) { el.innerHTML = '<div class="wib-empty">Loading…</div>'; return; }
    var unread = I.list.reduce(function (t, x) { return t + x.unread; }, 0);
    if (c) c.textContent = I.list.length + ' conversation' + (I.list.length === 1 ? '' : 's') + (unread ? ' · ' + unread + ' unread' : '');
    if (!I.list.length) {
      var filtered = Object.keys(I.f).some(function (k) { return I.f[k]; });
      el.innerHTML = '<div class="wib-empty">' + (filtered ? 'No conversation matches these filters.<br><button class="wib-btn" style="margin-top:10px" onclick="wibClear()">Clear filters</button>'
        : 'No conversations yet.<br>Replies to your WhatsApp campaigns appear here by themselves.') + '</div>';
      return;
    }
    el.innerHTML = I.list.map(function (x) {
      var nm = x.name || '+' + x.contact;
      var tickPre = x.lastDirection === 'out' ? ticks(x.lastStatus || 'sent') + ' ' : '';
      return '<div class="wib-item ' + (I.sel === x.id ? 'on' : '') + '" onclick="wibOpen(\'' + esc(x.id) + '\')" role="button" tabindex="0">' + avatar(x.name, x.contact)
        + '<div class="wib-im"><div class="wib-l1"><span class="wib-nm">' + esc(nm) + '</span><span class="wib-tm ' + (x.unread ? 'u' : '') + '">' + esc(stamp(x.lastAt)) + '</span></div>'
        + '<div class="wib-l2"><span class="wib-pv">' + tickPre + esc(x.lastText) + '</span>' + (x.unread ? '<span class="wib-un">' + x.unread + '</span>' : '') + '</div>'
        + '<div class="wib-sub"><span>+' + esc(x.contact) + '</span>' + (x.campaign ? '<span class="wib-chip wib-camp" title="Campaign">📣 ' + esc(x.campaign.name || 'Campaign') + '</span>' : '')
        + (x.needsReply ? '<span class="wib-chip wib-warn">Needs reply</span>' : '') + (x.assignee ? '<span class="wib-chip">' + esc(x.assignee.name) + '</span>' : '') + '</div></div></div>';
    }).join('');
  }
  window.wibReload = function () { loadList(); };
  window.wibClear = function () { if (!I) return; I.f = { q: '', numberId: '', campaign: '', assignee: '', department: '', from: '', to: '', unread: false, reply: '' }; var q = $('wibQ'); if (q) q.value = ''; renderSide(); loadList(); };

  /* ---- one conversation ---- */
  window.wibOpen = function (id) {
    if (!I) return;
    I.sel = id; I.thread = null; I.text = ''; I.error = ''; I.pending = []; I.mobileChat = true;
    $('wibBox').classList.add('chat');
    renderList(); renderMid(); renderSide();
    loadThread(false);
  };
  function openByContact(numberId, contact) {
    if (!I) return;
    var d = String(contact || '').replace(/\D/g, '');
    if (d.length === 10) d = '91' + d;
    api().get(API + '/conversations?q=' + encodeURIComponent(d.slice(-10)) + (numberId ? '&numberId=' + encodeURIComponent(numberId) : '')).then(function (r) {
      var hit = (r.conversations || []).filter(function (c) { return c.contact === d; })[0] || (r.conversations || [])[0];
      if (hit && I) { if (!I.list || !I.list.some(function (x) { return x.id === hit.id; })) { I.list = [hit].concat(I.list || []); renderList(); } window.wibOpen(hit.id); }
      else toast('There is no conversation with that number yet.', 'ℹ️');
    }, function (e) { toast(errText(e), '⚠️'); });
  }
  function loadThread(quiet) {
    if (!I || !I.sel) return;
    var id = I.sel, my = ++I.thrSeq, mine = I;
    api().get(API + '/conversations/' + encodeURIComponent(id)).then(function (r) {
      if (I !== mine || my !== I.thrSeq || I.sel !== id) return;
      var grew = !I.thread || I.thread.messages.length !== r.messages.length;
      I.thread = r; renderMid(grew || !quiet); renderSide();
      /* the conversation is open on screen: it is read (for this person) */
      var item = I.list && I.list.filter(function (x) { return x.id === id; })[0];
      if (item && item.unread) {
        item.unread = 0; renderList();
        api().post(API + '/conversations/' + encodeURIComponent(id) + '/read', {}).then(loadSummary, function () { /* the unread mark stays */ });
      } else if (!quiet) api().post(API + '/conversations/' + encodeURIComponent(id) + '/read', {}).then(loadSummary, function () { /* none */ });
    }, function (e) { if (I === mine && I.sel === id) { I.thread = { error: errText(e) }; renderMid(); } });
  }

  function msgHtml(m, i, all) {
    var out = m.direction === 'out';
    var prev = all[i - 1];
    var day = !prev || !sameDay(new Date(prev.at), new Date(m.at)) ? '<div class="wib-day">' + esc(dayLabel(m.at)) + '</div>' : '';
    var tag = m.campaign && out && (!prev || !prev.campaign || prev.campaign.batchId !== m.campaign.batchId) ? '<div class="wib-camptag">📣 Campaign: ' + esc(m.campaign.name || '') + '</div>' : '';
    var media = '';
    if (m.media) {
      var url = RAW + '/media/' + m.id;
      if (m.media.type === 'image' || m.media.type === 'sticker') media = '<a href="' + url + '" target="_blank" rel="noopener"><img class="wib-img" loading="lazy" alt="Photo" src="' + url + '"></a>';
      else media = '<a class="wib-doc" href="' + url + '" target="_blank" rel="noopener"><span style="font-size:22px">' + (m.media.type === 'video' ? '🎬' : m.media.type === 'audio' ? '🎧' : '📄') + '</span><span>' + esc(m.media.filename || (m.media.type[0].toUpperCase() + m.media.type.slice(1))) + '<br><span style="font-size:11px;opacity:.7">Open / download</span></span></a>';
    }
    var showText = m.text && !(m.media && (m.text === 'Photo' || m.text === 'Video' || m.text === 'Voice message' || m.text === 'Sticker' || /^Document: /.test(m.text) || /^(Image|Video|Audio|Document)$/.test(m.text)));
    return day + tag + '<div class="wib-m ' + (out ? 'out' : 'in') + '">'
      + (out && m.by && m.kind !== 'agent_reply' ? '<div class="by">' + esc(m.by) + '</div>' : '') + (out && m.kind === 'agent_reply' ? '<div class="by">TeamLink assistant</div>' : '')
      + (m.replyTo ? '<div class="wib-quote">' + esc(m.replyTo.text) + '</div>' : '') + media
      + (showText ? '<div class="t">' + esc(m.text) + '</div>' : '')
      + (m.status === 'failed' && m.error ? '<div class="wib-err">Not delivered: ' + esc(m.error) + '</div>' : '')
      + '<div class="f"><span>' + esc(clock(m.at)) + '</span>' + (out ? ticks(m.status) + (m.status === 'failed' ? '<span class="wib-err" style="margin:0">Failed</span>' : '') : '') + '</div></div>';
  }

  function renderMid(scroll) {
    var el = $('wibMid'); if (!el || !I) return;
    if (!I.sel) { el.innerHTML = '<div class="wib-empty"><div style="font-size:42px">💬</div><b>WhatsApp Inbox</b><br>Choose a conversation on the left. Replies to your campaigns appear here as they arrive.</div>'; return; }
    var t = I.thread, c = (I.list || []).filter(function (x) { return x.id === I.sel; })[0] || (t && t.conversation) || {};
    if (!t) { el.innerHTML = '<div class="wib-top"><button class="wib-btn wib-back" onclick="wibBack()">←</button><b>Loading…</b></div><div class="wib-empty">Loading…</div>'; return; }
    if (t.error) { el.innerHTML = '<div class="wib-top"><button class="wib-btn wib-back" onclick="wibBack()">←</button><b>Conversation</b></div><div class="wib-empty" style="color:#c0392b">' + esc(t.error) + '</div>'; return; }
    var cv = t.conversation, nm = cv.name || '+' + cv.contact;
    var msgsHtml = t.messages.map(msgHtml).join('');
    I.pending.forEach(function (p) { msgsHtml += '<div class="wib-m out"><div class="t">' + esc(p.text) + '</div><div class="f"><span>' + esc(clock(p.at)) + '</span>' + ticks('sending') + '</div></div>'; });
    var ctx = t.campaignContext;
    var banner = ctx ? '<div class="wib-banner">📣 <b>Campaign: ' + esc(ctx.name || '') + '</b> — ' + (cv.campaign && cv.campaign.match === 'reply' ? 'this is a reply to its message' : cv.campaign && cv.campaign.match === 'recent' ? 'most likely a reply (the latest campaign message sent to this contact)' : 'sent to this contact')
      + (ctx.originalMessage ? '<q>“' + esc(ctx.originalMessage) + '”</q>' : '') + '</div>' : '';
    var keepScroll = $('wibMsgs') ? { top: $('wibMsgs').scrollTop, h: $('wibMsgs').scrollHeight, h2: $('wibMsgs').clientHeight } : null;
    var composer = $('wibComposer'); var hadComposer = !!composer;
    var comp = composerHtml(t, cv);
    el.innerHTML = '<div class="wib-top"><button class="wib-btn wib-back" onclick="wibBack()" aria-label="Back">←</button>' + avatar(cv.name, cv.contact, 38)
      + '<div style="flex:1;min-width:0"><div style="font-weight:700;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(nm) + '</div>'
      + '<div class="wib-sub" style="margin:0"><span>+' + esc(cv.contact) + '</span><span>via ' + esc(cv.numberName || 'WhatsApp') + '</span>' + (cv.assignee ? '<span class="wib-chip">👤 ' + esc(cv.assignee.name) + '</span>' : '<span class="wib-chip wib-warn">Unassigned</span>') + '</div></div>'
      + (cv.candidateId ? '<button class="wib-btn" onclick="wibProfile(\'' + esc(cv.candidateId) + '\')">Profile</button>' : '')
      + '<button class="wib-btn wib-fbtn" onclick="wibToggleFilters()">Filters</button><button class="wib-x" onclick="wibClose()" aria-label="Close">✕</button></div>'
      + banner + '<div class="wib-msgs" id="wibMsgs">' + (msgsHtml || '<div class="wib-empty">No messages yet.</div>') + '</div>' + comp;
    var box = $('wibMsgs');
    if (box) {
      var nearBottom = !keepScroll || (keepScroll.top + keepScroll.h2 >= keepScroll.h - 80);
      if (scroll !== false && (scroll || nearBottom)) box.scrollTop = box.scrollHeight; else if (keepScroll) box.scrollTop = keepScroll.top;
    }
    var ta = $('wibText'); if (ta) { ta.value = I.text; autosize(ta); if (hadComposer && I.focusText) { ta.focus(); } }
  }

  function composerHtml(t, cv) {
    var can = t.window && t.window.open;
    var note = can ? '<p class="wib-note">You can reply freely until <b>' + esc(new Date(t.window.endsAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })) + '</b> (24 hours after their last message).</p>'
      : '<p class="wib-note w">This contact has not written to this number in the last 24 hours, so WhatsApp only allows an approved template now.'
        + (cv.candidateId ? ' <a href="javascript:void(0)" onclick="wibTemplate(\'' + esc(cv.candidateId) + '\')"><b>Send a template</b></a>' : '') + '</p>';
    return '<div class="wib-comp" id="wibComposer">' + note + (I.error ? '<div class="wib-err" style="margin:0 2px 6px;font-size:12.5px">' + esc(I.error) + '</div>' : '')
      + '<div class="wib-row"><input type="file" id="wibFile" style="display:none" accept="image/jpeg,image/png,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,video/mp4,audio/aac,audio/mpeg,audio/ogg,audio/amr" onchange="wibAttach(this)">'
      + '<button class="wib-btn wib-round" title="Attach a photo or document" onclick="document.getElementById(\'wibFile\').click()" ' + (can && !I.uploading ? '' : 'disabled') + '>📎</button>'
      + '<textarea id="wibText" class="wib-ta" rows="1" placeholder="' + (can ? 'Type a reply' : 'Replies are closed for this contact') + '" ' + (can ? '' : 'disabled')
      + ' oninput="wibText(this)" onkeydown="wibKey(event)" onfocus="wibFocus(true)" onblur="wibFocus(false)"></textarea>'
      + '<button class="wib-btn p wib-round" id="wibSend" title="Send" onclick="wibSend()" ' + (can && !I.sending ? '' : 'disabled') + '>➤</button></div></div>';
  }
  function autosize(ta) { ta.style.height = 'auto'; ta.style.height = Math.min(120, ta.scrollHeight) + 'px'; }
  window.wibText = function (ta) { if (!I) return; I.text = ta.value; autosize(ta); };
  window.wibFocus = function (on) { if (I) I.focusText = !!on; };
  window.wibKey = function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); window.wibSend(); } };
  window.wibBack = function () { if (!I) return; $('wibBox').classList.remove('chat'); };
  window.wibProfile = function (id) { wibClose(); if (typeof window.navigate === 'function') window.navigate('/recruiter/candidate-profile?id=' + id); else location.hash = '#/recruiter/candidate-profile?id=' + id; };
  window.wibTemplate = function (candidateId) { wibClose(); if (typeof window.tlWhatsApp === 'function') window.tlWhatsApp({ candidateIds: [candidateId] }); };
  window.wibToggleFilters = function () { if (!I) return; I.filtersOpen = !I.filtersOpen; $('wibBox').classList.toggle('fopen', I.filtersOpen); };

  /* ---- send a reply: shown at once as "sending", then as the provider reports ---- */
  window.wibSend = function () {
    if (!I || !I.sel || I.sending) return;
    var text = (I.text || '').trim(); if (!text) return;
    var id = I.sel, mine = I, key = uid();
    I.sending = true; I.error = ''; I.pending.push({ text: text, at: Date.now() }); I.text = '';
    renderMid(true);
    api().post(API + '/conversations/' + encodeURIComponent(id) + '/messages', { text: text, clientKey: key }).then(function () {
      if (I !== mine) return; I.sending = false; I.pending = []; loadThread(true); loadList();
    }, function (e) {
      if (I !== mine) return; I.sending = false; I.pending = []; I.text = text; I.error = errText(e); loadThread(true); renderMid(true);
    });
  };
  window.wibAttach = function (input) {
    var f = input.files && input.files[0]; input.value = '';
    if (!f || !I || !I.sel || I.uploading) return;
    var id = I.sel, mine = I, cap = (I.text || '').trim(), key = uid();
    I.uploading = true; I.error = ''; I.pending.push({ text: '📎 ' + f.name, at: Date.now() }); renderMid(true);
    fetch(RAW + '/conversations/' + encodeURIComponent(id) + '/media?filename=' + encodeURIComponent(f.name) + '&caption=' + encodeURIComponent(cap) + '&clientKey=' + key, {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': f.type || 'application/octet-stream', 'x-csrf-token': cookie('tl_csrf') }, body: f,
    }).then(function (res) { return res.json().catch(function () { return {}; }).then(function (j) { if (!res.ok) throw new Error((j.error && j.error.message) || 'The file could not be sent.'); return j; }); })
      .then(function () { if (I !== mine) return; I.uploading = false; I.pending = []; I.text = ''; loadThread(true); loadList(); },
        function (e) { if (I !== mine) return; I.uploading = false; I.pending = []; I.error = errText(e); loadThread(true); renderMid(true); });
  };

  /* ---- the right panel: filters, and the selected conversation's campaign and owner ---- */
  function optionsHtml(list, cur, allLabel, val, lab) {
    return '<option value="">' + esc(allLabel) + '</option>' + list.map(function (x) { var v = val(x); return '<option value="' + esc(v) + '"' + (String(cur) === String(v) ? ' selected' : '') + '>' + esc(lab(x)) + '</option>'; }).join('');
  }
  function renderSide() {
    var el = $('wibSide'); if (!el || !I) return;
    var m = I.meta || { campaigns: [], assignees: [], departments: [], numbers: [], staff: [], canAssign: false }, f = I.f;
    var html = '<div class="wib-side"><div class="wib-row" style="justify-content:space-between;align-items:center"><b style="font-size:14px">Campaign &amp; filters</b><button class="wib-btn" onclick="wibClear()">Clear</button></div>'
      + '<label for="wibFCamp">Campaign</label><select id="wibFCamp" onchange="wibF(\'campaign\',this.value)">' + optionsHtml(m.campaigns, f.campaign, 'All campaigns', function (c) { return c.id; }, function (c) { return c.name + ' (' + c.replies + ' repl' + (c.replies === 1 ? 'y' : 'ies') + ')'; }) + '</select>'
      + '<label for="wibFAs">Assigned recruiter</label><select id="wibFAs" onchange="wibF(\'assignee\',this.value)"><option value="">Everyone</option><option value="none"' + (f.assignee === 'none' ? ' selected' : '') + '>Unassigned</option>'
      + m.assignees.map(function (a) { return '<option value="' + esc(a.id) + '"' + (f.assignee === a.id ? ' selected' : '') + '>' + esc(a.name) + '</option>'; }).join('') + '</select>'
      + '<label for="wibFDe">Department</label><select id="wibFDe" onchange="wibF(\'department\',this.value)">' + optionsHtml(m.departments, f.department, 'All departments', function (d) { return d; }, function (d) { return d; }) + '</select>'
      + (m.numbers.length > 1 ? '<label for="wibFNu">WhatsApp number</label><select id="wibFNu" onchange="wibF(\'numberId\',this.value)">' + optionsHtml(m.numbers, f.numberId, 'All my numbers', function (n) { return n.id; }, function (n) { return n.name + (n.phone ? ' · ' + n.phone : ''); }) + '</select>' : '')
      + '<label for="wibFFr">Last message from</label><input id="wibFFr" type="date" value="' + esc(f.from) + '" onchange="wibF(\'from\',this.value)"><label for="wibFTo">to</label><input id="wibFTo" type="date" value="' + esc(f.to) + '" onchange="wibF(\'to\',this.value)">'
      + '<label for="wibFRe">Reply status</label><select id="wibFRe" onchange="wibF(\'reply\',this.value)"><option value="">All</option><option value="needs"' + (f.reply === 'needs' ? ' selected' : '') + '>Needs a reply</option><option value="replied"' + (f.reply === 'replied' ? ' selected' : '') + '>Replied</option></select>'
      + '<label style="display:flex;gap:7px;align-items:center;font-weight:600;margin-top:10px"><input type="checkbox" ' + (f.unread ? 'checked' : '') + ' onchange="wibF(\'unread\',this.checked)"> Unread only</label>';
    var t = I.thread && I.thread.conversation ? I.thread : null;
    if (t) {
      var cv = t.conversation, ctx = t.campaignContext;
      html += '<h3>This conversation</h3><div class="wib-card"><b>Contact</b>' + esc(cv.name || '—') + '<br>+' + esc(cv.contact) + '<b>Number</b>' + esc(cv.numberName || '') + (cv.numberPhone ? ' · ' + esc(cv.numberPhone) : '')
        + '<b>Campaign</b>' + (ctx ? esc(ctx.name || '') + '<br><span style="color:#5b6678">' + (cv.campaign && cv.campaign.match === 'reply' ? 'Replied to its message' : cv.campaign && cv.campaign.match === 'recent' ? 'Most likely a reply (latest campaign message)' : 'Sent to this contact') + '</span>'
          + (ctx.originalMessage ? '<br><i style="color:#33506f">“' + esc(ctx.originalMessage.slice(0, 160)) + (ctx.originalMessage.length > 160 ? '…' : '') + '”</i>' : '') : '<span style="color:#5b6678">None - this is not a reply to a campaign we can identify.</span>')
        + '<b>Assigned to</b>' + (cv.assignee ? esc(cv.assignee.name) + (cv.assignee.department ? ' · ' + esc(cv.assignee.department) : '') : 'Nobody - everyone on this number can see it') + '</div>';
      if (t.canAssign && m.staff) {
        html += '<label for="wibAssign">Assign to</label><select id="wibAssign" onchange="wibAssign(this.value)"><option value="">Nobody (the number\'s team)</option>'
          + m.staff.map(function (s) { return '<option value="' + esc(s.userId) + '"' + (cv.assignee && cv.assignee.id === s.userId ? ' selected' : '') + '>' + esc(s.name + (s.department ? ' · ' + s.department : '')) + '</option>'; }).join('')
          + '</select><div class="wib-note" style="margin-top:4px">Reassigning keeps the whole history.</div>';
      }
    }
    el.innerHTML = html + '</div>';
  }
  window.wibF = function (k, v) { if (!I) return; I.f[k] = v; loadList(); };
  window.wibAssign = function (userId) {
    if (!I || !I.sel) return;
    var id = I.sel;
    api().put(API + '/conversations/' + encodeURIComponent(id) + '/assign', { userId: userId || null }).then(function () { toast(userId ? 'Conversation reassigned' : 'Conversation unassigned', '✅'); loadList(); loadThread(true); },
      function (e) { toast(errText(e), '⚠️'); });
  };
}());
