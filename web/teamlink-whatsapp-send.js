/*
 * Send WhatsApp Message (0158) - choose candidates, choose an approved WhatsApp template, see each candidate's own message, send.
 *
 * ONE POPUP, opened from every place a recruiter selects candidates (Talent Pool, Find Candidates, Applications): tlWhatsApp({...}).
 * It is the only WhatsApp compose screen; the older compose box keeps Email and SMS.
 *
 *   - Nothing here fills a template in. The server does (api/src/whatsapp/templates.js), from the database, for each candidate, and
 *     the preview you read is the same text and the same parameters the send queues - so the screen cannot promise more than the
 *     send does.
 *   - Nothing here talks to WhatsApp or holds a key. It posts to /api/whatsapp/*; messages go onto the shared queue and show as
 *     Sent / Delivered / Read only when WhatsApp says so.
 *   - A click on Send is protected by a key made when the popup opens: the same click twice, or a request retried by the network,
 *     is one send. "Retry failed" re-queues only the failed messages.
 *
 * Administrators also manage the templates here (tlWaTemplateForm): the WhatsApp template name and language as in WhatsApp Manager,
 * header, body with {{fields}}, footer, buttons, and "Sync from WhatsApp Business" to pull the approved ones in.
 */
(function () {
  'use strict';

  var VARS_FALLBACK = [];
  var S = null;       // one send session; null when closed
  var poll = null;
  var previewTimer = null;

  var api = function () { return window.TL && window.TL.api; };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  };
  var toast = function (m, i) { if (typeof window.toast === 'function') { try { window.toast(m, i || 'ℹ️'); } catch (e) { /* none */ } } };
  var errText = function (e) { return (e && e.message) ? String(e.message) : 'Something went wrong. Please try again.'; };
  var uid = function () {
    try { if (window.crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (e) { /* older browser */ }
    return 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
  };
  var $ = function (id) { return document.getElementById(id); };

  /* ------------------------------------------------------------------ *
   * styles
   * ------------------------------------------------------------------ */
  function addStyle() {
    if ($('wx-style')) return;
    var css = ''
      + '.wx-ov{position:fixed;inset:0;z-index:9500;background:rgba(11,18,32,.55);display:flex;align-items:center;justify-content:center;padding:18px}'
      + '.wx-modal{background:var(--surface,#fff);color:var(--ink-900,#0b1220);width:min(1120px,100%);max-height:calc(100vh - 36px);display:flex;flex-direction:column;border-radius:14px;box-shadow:0 24px 60px rgba(0,0,0,.3);overflow:hidden}'
      + '.wx-head{display:flex;align-items:center;gap:14px;padding:14px 20px;border-bottom:1px solid var(--border,#dde2ea)}'
      + '.wx-head h2{margin:0;font-size:19px;display:flex;align-items:center;gap:9px}'
      + '.wx-head .wx-dot{width:26px;height:26px;border-radius:50%;background:#25d366;display:inline-flex;align-items:center;justify-content:center;color:#fff;font-size:14px}'
      + '.wx-tabs{display:flex;gap:2px;flex:1}'
      + '.wx-tab{border:0;background:transparent;padding:8px 13px;font-weight:700;font-size:13.5px;color:var(--ink-500,#5b6678);cursor:pointer;border-bottom:3px solid transparent}'
      + '.wx-tab.on{color:#128c4a;border-bottom-color:#25d366}'
      + '.wx-x{border:0;background:transparent;font-size:20px;line-height:1;cursor:pointer;color:var(--ink-500,#5b6678);padding:4px 8px;border-radius:8px}'
      + '.wx-x:hover{background:var(--paper-50,#eef1f5)}'
      + '.wx-body{overflow:auto;padding:16px 20px;flex:1;min-height:200px}'
      + '.wx-grid{display:grid;grid-template-columns:minmax(300px,2fr) minmax(340px,3fr);gap:16px;align-items:start}'
      + '@media (max-width:860px){.wx-grid{grid-template-columns:1fr}}'
      + '.wx-card{border:1px solid var(--border,#dde2ea);border-radius:12px;padding:13px 14px;background:var(--surface,#fff)}'
      + '.wx-card+.wx-card{margin-top:14px}'
      + '.wx-card h3{margin:0 0 9px;font-size:13.5px;display:flex;align-items:center;gap:8px}'
      + '.wx-num{width:20px;height:20px;border-radius:50%;background:#128c4a;color:#fff;font-size:11.5px;display:inline-flex;align-items:center;justify-content:center;flex:none}'
      + '.wx-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}'
      + '.wx-in,.wx-sel{border:1px solid var(--border,#dde2ea);border-radius:9px;padding:8px 10px;font:inherit;font-size:13px;background:var(--surface,#fff);min-width:0;box-sizing:border-box}'
      + '.wx-in{flex:1;min-width:140px}.wx-sel{width:100%}'
      + '.wx-btn{border:1px solid var(--border,#dde2ea);background:var(--surface,#fff);border-radius:8px;padding:6px 11px;font:inherit;font-size:12.5px;font-weight:650;cursor:pointer;white-space:nowrap}'
      + '.wx-btn:hover{border-color:#25d366}'
      + '.wx-btn.p{background:#128c4a;border-color:#128c4a;color:#fff;padding:9px 16px;font-size:13.5px}'
      + '.wx-btn.p:hover{background:#0f7a40}'
      + '.wx-btn[disabled]{opacity:.5;cursor:not-allowed}'
      + '.wx-list{max-height:330px;overflow:auto;border:1px solid var(--border,#dde2ea);border-radius:10px;margin-top:9px}'
      + '.wx-c{display:flex;gap:9px;padding:8px 10px;border-bottom:1px solid var(--border,#dde2ea);align-items:flex-start;cursor:pointer}'
      + '.wx-c:last-child{border-bottom:0}.wx-c.cur{background:#eefaf3}.wx-c.off{opacity:.62}'
      + '.wx-c input{margin-top:3px;flex:none}'
      + '.wx-cn{font-weight:700;font-size:13px}.wx-cs{font-size:12px;color:var(--ink-500,#5b6678);margin-top:1px}'
      + '.wx-chip{display:inline-block;border-radius:999px;padding:1px 8px;font-size:11px;font-weight:700;background:var(--paper-50,#eef1f5);margin:3px 4px 0 0;white-space:nowrap}'
      + '.wx-bad{background:var(--bad-100,#fbe4e1);color:var(--bad-600,#c0392b)}.wx-warn{background:var(--warn-100,#fbeed8);color:var(--warn-600,#a5670f)}'
      + '.wx-ok{background:var(--ok-100,#e2f5ec);color:var(--ok-600,#1e8e5a)}.wx-info{background:#e8f1fb;color:#1c5aa0}'
      + '.wx-tpls{max-height:210px;overflow:auto;margin-top:9px;display:grid;gap:7px}'
      + '.wx-t{border:1.5px solid var(--border,#dde2ea);border-radius:10px;padding:8px 11px;cursor:pointer;background:var(--surface,#fff);text-align:left;font:inherit}'
      + '.wx-t:hover{border-color:#25d366}.wx-t.on{border-color:#128c4a;background:#eefaf3}'
      + '.wx-t b{font-size:13px;display:block}.wx-t span{font-size:11.5px;color:var(--ink-500,#5b6678)}'
      + '.wx-label{font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;color:var(--ink-500,#5b6678);margin:0 0 5px}'
      + '.wx-sw{display:flex;gap:7px;align-items:center;margin-bottom:9px}.wx-sw .wx-sel{flex:1}'
      + '.wx-wa{background:#e5ddd5;border-radius:12px;padding:14px 12px}'
      + '.wx-bub{background:#fff;border-radius:9px 9px 9px 2px;padding:8px 11px 9px;max-width:420px;box-shadow:0 1px 1px rgba(0,0,0,.13);font-size:13.5px;line-height:1.45}'
      + '.wx-bh{font-weight:800;margin-bottom:5px}.wx-bm{background:#eef1f5;border-radius:7px;padding:22px 8px;text-align:center;margin-bottom:6px;color:#5b6678;font-size:12.5px}'
      + '.wx-bb{white-space:pre-wrap;word-break:break-word}.wx-bf{color:#8696a0;font-size:12px;margin-top:6px}'
      + '.wx-bt{max-width:420px;margin-top:3px}'
      + '.wx-bt div{background:#fff;border-radius:8px;text-align:center;padding:8px;color:#0a7cff;font-weight:650;font-size:13px;margin-top:3px;box-shadow:0 1px 1px rgba(0,0,0,.13)}'
      + '.wx-miss{background:var(--warn-100,#fbeed8);color:var(--warn-600,#a5670f);border-radius:9px;padding:8px 11px;margin-top:9px;font-size:12.5px}'
      + '.wx-err{background:var(--bad-100,#fbe4e1);color:var(--bad-600,#c0392b);border-radius:10px;padding:10px 14px;margin:0 0 12px;font-size:13.5px}'
      + '.wx-foot{display:flex;flex-wrap:wrap;gap:12px;align-items:center;padding:12px 20px;border-top:1px solid var(--border,#dde2ea);background:var(--paper-50,#f6f8fb)}'
      + '.wx-sum{flex:1;min-width:220px;font-size:13px}.wx-sum b{font-size:14px}'
      + '.wx-tick{display:flex;gap:7px;align-items:flex-start;font-size:12.5px;margin-top:5px}'
      + '.wx-state{padding:30px 10px;text-align:center;color:var(--ink-500,#5b6678);font-size:14px}'
      + '.wx-tbl{width:100%;border-collapse:collapse;font-size:13px}'
      + '.wx-tbl th{text-align:left;font-size:11.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--ink-500,#5b6678);padding:8px 10px;background:var(--paper-50,#eef1f5);position:sticky;top:0}'
      + '.wx-tbl td{padding:9px 10px;border-bottom:1px solid var(--border,#dde2ea);vertical-align:top}'
      + '.wx-kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:9px;margin:0 0 14px}'
      + '.wx-kv div{background:var(--paper-50,#eef1f5);border-radius:10px;padding:9px 12px}.wx-kv b{display:block;font-size:20px}.wx-kv span{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--ink-500,#5b6678)}'
      + '.wx-pool{border:1px solid var(--border,#dde2ea);border-radius:10px;margin-top:6px;max-height:170px;overflow:auto}'
      + '.wx-pool div{display:flex;gap:8px;align-items:center;padding:6px 10px;border-bottom:1px solid var(--border,#dde2ea);font-size:12.5px}.wx-pool div:last-child{border-bottom:0}.wx-pool span{flex:1}'
      + '.wx-form{display:grid;gap:12px}.wx-form label{display:block;font-size:12px;font-weight:700;margin-bottom:4px;color:var(--ink-700,#2c3648)}'
      + '.wx-form input,.wx-form select,.wx-form textarea{width:100%;box-sizing:border-box;border:1px solid var(--border,#dde2ea);border-radius:9px;padding:8px 10px;font:inherit;font-size:13px}'
      + '.wx-form textarea{min-height:140px;resize:vertical}.wx-form .e{color:var(--bad-600,#c0392b);font-size:12px;margin-top:3px}'
      + '.wx-f2{display:grid;grid-template-columns:1fr 1fr;gap:12px}.wx-f3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px}'
      + '.wx-msg.in{align-self:flex-start;background:#fff}.wx-msg.out{align-self:flex-end;background:#dcf8c6}.wx-msg .wx-cs{font-size:11px;margin-top:3px}'
      + '@media (max-width:640px){.wx-f2,.wx-f3{grid-template-columns:1fr}.wx-ov{padding:0}.wx-modal{max-height:100vh;height:100vh;border-radius:0}'
        + '.wx-head{gap:6px;padding:10px 12px}.wx-head h2{font-size:15px}.wx-body{padding:12px}.wx-foot{padding:10px 12px}}';
    var st = document.createElement('style'); st.id = 'wx-style'; st.textContent = css; document.head.appendChild(st);
  }

  /* ------------------------------------------------------------------ *
   * the preview "phone"
   * ------------------------------------------------------------------ */
  function bubble(p) {
    if (!p) return '';
    var h = p.header || { type: 'none' };
    var head = h.type === 'text' && h.text ? '<div class="wx-bh">' + esc(h.text) + '</div>'
      : (h.type === 'image' || h.type === 'document' || h.type === 'video')
        ? '<div class="wx-bm">' + (h.type === 'image' ? '🖼 Image' : h.type === 'video' ? '🎬 Video' : '📄 Document') + ' header' + (h.mediaUrl ? '' : ' (no link set)') + '</div>' : '';
    var btns = (p.buttons || []).map(function (b) {
      var ico = b.type === 'url' ? '🔗' : b.type === 'phone' ? '📞' : '↩';
      return '<div>' + ico + ' ' + esc(b.text) + (b.type === 'url' && b.shownUrl ? '<br><span style="font-weight:500;font-size:11px;color:#5b6678">' + esc(b.shownUrl) + '</span>' : '') + '</div>';
    }).join('');
    return '<div class="wx-wa"><div class="wx-bub">' + head + '<div class="wx-bb">' + esc(p.body || '') + '</div>'
      + (p.footer ? '<div class="wx-bf">' + esc(p.footer) + '</div>' : '') + '</div>' + (btns ? '<div class="wx-bt">' + btns + '</div>' : '') + '</div>';
  }
  window.tlWaBubble = bubble;

  /* ------------------------------------------------------------------ *
   * open / close
   * ------------------------------------------------------------------ */
  window.tlWhatsApp = function (opts) {
    opts = opts || {};
    if (!api()) { toast('The portal is not ready yet.', '⏳'); return; }
    /* conversations live in the WhatsApp Inbox */
    if (opts.tab === 'chats' || opts.chat) { if (typeof window.tlWhatsAppInbox === 'function') window.tlWhatsAppInbox(opts.chat || {}); return; }
    if (S) { return; }                      // one popup, ever
    addStyle();
    var rows = opts.rows || [];
    var ids = (opts.candidateIds || rows.map(function (r) { return r.id; })).filter(Boolean);
    S = {
      tab: 'send', phase: 'compose',              // compose | confirm | results
      ids: [], picked: {}, info: {}, pre: {}, names: {},
      templates: [], tplId: '', tplQ: '', canManage: false, connected: true, hiddenNote: '', numbers: [], numberId: '', numbersLoaded: false,
      jobId: opts.jobId || '', jobs: [], applicationIds: opts.applicationIds || [], campaign: '', campaignTyped: false,
      cur: '', filter: '', poolQ: '', pool: [], poolBusy: false,
      ticks: { includeNoOptIn: false, includeWarned: false, includeNotLooking: false }, canBypass: false,
      loading: true, previewing: false, sending: false, error: '', sendKey: uid(), seq: 0,
      batch: null, skippedOnSend: [], hist: null, histError: '', lastFocus: document.activeElement,
    };
    rows.forEach(function (r) { S.names[r.id] = { name: r.name, phone: r.phone, title: r.title || r.preferredRole || '' }; });
    ids.forEach(function (id) { addCandidate(id, true); });
    try { S.jobs = (window.DATA && DATA.jobs ? DATA.jobs : []).filter(function (j) { return j && String(j.status || 'open') !== 'closed'; }).map(function (j) { return { id: j.id, title: j.title }; }); } catch (e) { S.jobs = []; }
    var root = document.createElement('div'); root.id = 'wxRoot';
    document.body.appendChild(root);
    root.addEventListener('mousedown', function (e) { if (e.target === root.firstChild && S && !S.sending) S.downOnBackdrop = true; else if (S) S.downOnBackdrop = false; });
    root.addEventListener('click', function (e) { if (S && e.target === root.firstChild && S.downOnBackdrop && S.phase !== 'confirm') wxClose(); });
    document.addEventListener('keydown', onKey);
    window.addEventListener('hashchange', wxClose);
    if (opts.batchId) { S.phase = 'results'; S.loading = false; paint(); startPoll(opts.batchId); return; }
    paint();
    load();
  };

  function onKey(e) { if (e.key === 'Escape' && S) { if (S.phase === 'confirm') { S.phase = 'compose'; paint(); } else wxClose(); } }

  function wxClose() {
    if (!S) return;
    if (poll) { clearInterval(poll); poll = null; }
    clearTimeout(previewTimer);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('hashchange', wxClose);
    var r = $('wxRoot'); if (r && r.parentNode) r.parentNode.removeChild(r);
    var f = S.lastFocus; S = null;
    try { if (f && f.focus) f.focus(); } catch (e) { /* gone */ }
  }
  window.wxClose = wxClose;

  function addCandidate(id, picked) {
    if (S.ids.indexOf(id) < 0) S.ids.push(id);
    if (picked) S.picked[id] = true;
  }
  var pickedIds = function () { return S.ids.filter(function (id) { return S.picked[id]; }); };
  var infoOf = function (id) { return S.pre[id] || S.info[id] || null; };
  var nameOf = function (id) { var i = infoOf(id); return (i && i.name) || (S.names[id] && S.names[id].name) || 'Candidate'; };

  /* ------------------------------------------------------------------ *
   * data
   * ------------------------------------------------------------------ */
  function body() {
    return { candidateIds: S.ids.slice(0, 500), applicationIds: S.applicationIds, jobId: S.jobId || undefined };
  }
  function load() {
    var mine = S;
    S.loading = true; S.error = ''; paint();
    Promise.all([
      api().get('/whatsapp/templates'),
      api().get('/whatsapp/my-numbers').catch(function () { return { numbers: [] }; }),
      S.ids.length || S.applicationIds.length ? api().post('/whatsapp/recipients', body()) : Promise.resolve({ candidates: [] }),
    ]).then(function (r) {
      if (S !== mine) return;
      S.loading = false;
      S.templates = r[0].templates || []; S.canManage = !!r[0].canManage; S.connected = r[0].connected !== false;
      /* the numbers THIS person may send from: one is used as is, several default to the default one, none stops the send */
      S.numbers = (r[1] && r[1].numbers) || []; S.numbersLoaded = true;
      var dn = S.numbers.filter(function (n) { return n.isDefault; })[0];
      S.numberId = S.numbers.length === 1 ? S.numbers[0].id : (dn ? dn.id : '');
      applyRecipients(r[2]);
      if (!S.cur) S.cur = pickedIds()[0] || S.ids[0] || '';
      paint();
    }, function (e) { if (S !== mine) return; S.loading = false; S.error = errText(e); paint(); });
  }
  function applyRecipients(r) {
    S.canBypass = !!(r && r.canBypassOptIn);
    (r.candidates || []).forEach(function (c) {
      S.info[c.candidateId] = c;
      if (S.ids.indexOf(c.candidateId) < 0) addCandidate(c.candidateId, true);   // an application's candidate
    });
    /* alphabetical, so the list and the preview switcher read the same way every time */
    S.ids.sort(function (x, y) { return String(nameOf(x)).localeCompare(String(nameOf(y))); });
  }
  function refreshPreview(now) {
    clearTimeout(previewTimer);
    if (!S || !S.tplId || !S.ids.length) return;
    var run = function () {
      if (!S) return;
      var my = ++S.seq, mine = S;
      S.previewing = true; paintPreviewState();
      var b = body(); b.templateId = S.tplId;
      b.includeNoOptIn = S.ticks.includeNoOptIn; b.includeWarned = S.ticks.includeWarned; b.includeNotLooking = S.ticks.includeNotLooking;
      api().post('/whatsapp/preview', b).then(function (r) {
        if (S !== mine || my !== S.seq) return;
        S.previewing = false; S.error = '';
        S.pre = {}; (r.candidates || []).forEach(function (c) { S.pre[c.candidateId] = c; });
        S.canBypass = !!r.canBypassOptIn; S.templateOk = r.templateSendable; S.templateWhy = r.notSendableBecause || [];
        S.curTemplate = r.template;
        if (!S.cur || !S.pre[S.cur]) S.cur = pickedIds()[0] || S.ids[0] || '';
        paint();
      }, function (e) { if (S !== mine || my !== S.seq) return; S.previewing = false; S.error = errText(e); paint(); });
    };
    if (now) run(); else previewTimer = setTimeout(run, 220);
  }
  function paintPreviewState() { var el = $('wxPrevBox'); if (el) el.style.opacity = '.55'; }

  /* ------------------------------------------------------------------ *
   * painting
   * ------------------------------------------------------------------ */
  function paint() {
    var root = $('wxRoot'); if (!S || !root) return;
    var keep = null;
    var ae = document.activeElement;
    if (ae && ae.id && root.contains(ae) && /^wx(Filter|TplQ|PoolQ)$/.test(ae.id)) keep = { id: ae.id, s: ae.selectionStart, e: ae.selectionEnd };
    var scroll = root.querySelector('.wx-body') ? root.querySelector('.wx-body').scrollTop : 0;
    root.innerHTML = '<div class="wx-ov"><div class="wx-modal" role="dialog" aria-modal="true" aria-labelledby="wxTitle">'
      + '<div class="wx-head"><h2 id="wxTitle"><span class="wx-dot">✆</span>Send WhatsApp Message</h2>'
      + '<div class="wx-tabs"><button class="wx-tab ' + (S.tab === 'send' ? 'on' : '') + '" onclick="wxTab(\'send\')">Send</button>'
      + '<button class="wx-tab ' + (S.tab === 'history' ? 'on' : '') + '" onclick="wxTab(\'history\')">History</button></div>'
      + '<button class="wx-x" onclick="wxClose()" aria-label="Close">✕</button></div>'
      + (S.tab === 'history' ? historyHtml() : S.phase === 'results' ? resultsHtml() : S.phase === 'confirm' ? confirmHtml() : composeHtml())
      + '</div></div>';
    var b = root.querySelector('.wx-body'); if (b && scroll) b.scrollTop = scroll;
    if (keep) { var el = $(keep.id); if (el) { el.focus(); try { el.setSelectionRange(keep.s, keep.e); } catch (e) { /* not text */ } } }
  }

  function chips(it) {
    var o = '';
    if (!it) return o;
    (it.blocked || []).forEach(function (b) {
      var cls = b.kind === 'optin' || b.kind === 'warned' || b.kind === 'notlooking' ? 'wx-warn' : 'wx-bad';
      o += '<span class="wx-chip ' + cls + '">' + esc(b.reason) + '</span>';
    });
    return o;
  }

  function composeHtml() {
    if (S.loading) return '<div class="wx-body"><div class="wx-state">Loading…</div></div>' + footHtml();
    var shown = S.ids.filter(function (id) {
      if (!S.filter) return true;
      var i = infoOf(id) || {}; var h = (nameOf(id) + ' ' + (i.phone || '') + ' ' + (i.jobTitle || '')).toLowerCase();
      return h.indexOf(S.filter.toLowerCase()) >= 0;
    });
    var picked = pickedIds();
    var list = shown.map(function (id) {
      var i = infoOf(id); var on = !!S.picked[id];
      var line = [i && i.phone ? i.phone : (S.names[id] && S.names[id].phone) || '', i && i.jobTitle, i && i.applicationStatus].filter(Boolean).map(esc).join(' · ');
      return '<div class="wx-c ' + (S.cur === id ? 'cur ' : '') + (on ? '' : 'off') + '" onclick="wxCur(\'' + esc(id) + '\')">'
        + '<input type="checkbox" ' + (on ? 'checked' : '') + ' onclick="event.stopPropagation()" onchange="wxPick(\'' + esc(id) + '\',this.checked)" aria-label="Select ' + esc(nameOf(id)) + '">'
        + '<div style="min-width:0"><div class="wx-cn">' + esc(nameOf(id)) + '</div><div class="wx-cs">' + (line || '&nbsp;') + '</div>'
        + (on ? chips(S.pre[id] && S.tplId ? S.pre[id] : i) : '') + '</div></div>';
    }).join('');

    var q = S.tplQ.toLowerCase();
    var tpls = S.templates.filter(function (t) { return !q || (t.name + ' ' + t.waName + ' ' + (t.body || '')).toLowerCase().indexOf(q) >= 0; });
    var tplHtml = tpls.map(function (t) {
      return '<button type="button" class="wx-t ' + (S.tplId === t.id ? 'on' : '') + '" onclick="wxTpl(\'' + esc(t.id) + '\')">'
        + '<b>' + esc(t.name) + '</b><span>' + esc(t.waName) + ' · ' + esc(t.language) + (t.category ? ' · ' + esc(t.category.toLowerCase()) : '')
        + (t.header && t.header.type !== 'none' ? ' · header' : '') + ((t.buttons || []).length ? ' · ' + t.buttons.length + ' button' + (t.buttons.length > 1 ? 's' : '') : '') + '</span></button>';
    }).join('');
    var noTpl = !S.templates.length
      ? '<div class="wx-miss">No approved WhatsApp template is available yet.' + (S.canManage
        ? ' Use <a href="javascript:void(0)" onclick="wxManage()">Manage templates</a> to add one, or sync the approved ones from WhatsApp Business.'
        : ' Ask an administrator to add or sync the approved WhatsApp templates.') + '</div>' : '';

    var cur = S.pre[S.cur] || S.info[S.cur];
    var switcher = '';
    if (picked.length) {
      var idx = picked.indexOf(S.cur);
      switcher = '<div class="wx-sw"><button class="wx-btn" onclick="wxStep(-1)" aria-label="Previous candidate">‹</button>'
        + '<select class="wx-sel" onchange="wxCur(this.value)" aria-label="Preview candidate">'
        + picked.map(function (id) { return '<option value="' + esc(id) + '" ' + (id === S.cur ? 'selected' : '') + '>' + esc(nameOf(id)) + '</option>'; }).join('')
        + '</select><button class="wx-btn" onclick="wxStep(1)" aria-label="Next candidate">›</button>'
        + '<span class="wx-cs" style="white-space:nowrap">' + (idx >= 0 ? (idx + 1) + ' / ' + picked.length : '') + '</span></div>';
    }
    var preview;
    if (!S.tplId) preview = '<div class="wx-state" style="padding:22px 6px">Select a WhatsApp template to see each candidate\'s message.</div>';
    else if (!picked.length) preview = '<div class="wx-state" style="padding:22px 6px">Select at least one candidate to preview their message.</div>';
    else if (!S.pre[S.cur]) preview = '<div class="wx-state" style="padding:22px 6px">' + (S.previewing ? 'Preparing the preview…' : 'No preview yet.') + '</div>';
    else {
      var c = S.pre[S.cur];
      preview = '<div class="wx-row" style="margin-bottom:8px"><b style="font-size:13.5px">' + esc(c.name) + '</b><span class="wx-cs">WhatsApp ' + esc(c.number ? '+' + c.number : (c.phone || 'no number'))
        + '</span></div>' + bubble(c.preview)
        + (c.missing && c.missing.length ? '<div class="wx-miss"><b>Missing for ' + esc(c.name) + ':</b> ' + esc(c.missing.join(', ')) + '. Choose a job above, or ask an administrator to set a fallback in the template.</div>' : '')
        + ((c.blocked || []).length ? '<div style="margin-top:6px">' + chips(c) + '</div>' : '<div style="margin-top:8px"><span class="wx-chip wx-ok">Ready to send</span></div>');
    }
    if (S.templateOk === false && S.tplId) preview = '<div class="wx-err">This template cannot be sent: ' + esc((S.templateWhy || []).join('; ')) + '.</div>' + preview;

    var jobSel = S.jobs.length ? '<div style="margin-top:11px"><div class="wx-label">Job (optional)</div><select class="wx-sel" onchange="wxJob(this.value)">'
      + '<option value="">Each candidate\'s own application</option>'
      + S.jobs.map(function (j) { return '<option value="' + esc(j.id) + '" ' + (S.jobId === j.id ? 'selected' : '') + '>' + esc(j.title) + '</option>'; }).join('')
      + '</select><div class="wx-cs" style="margin-top:3px">Fills {{job_title}} and the job link for candidates who have not applied to anything yet.</div></div>' : '';

    var pool = '';
    if (S.pool.length || S.poolBusy) {
      pool = '<div class="wx-pool">' + (S.poolBusy ? '<div><span>Searching…</span></div>' : S.pool.map(function (c) {
        var have = S.ids.indexOf(c.id) >= 0;
        return '<div><span><b>' + esc(c.name) + '</b> · ' + esc(c.phone || 'no number') + (c.title ? ' · ' + esc(c.title) : '') + '</span>'
          + (have ? '<em class="wx-cs">added</em>' : '<button class="wx-btn" onclick="wxAdd(\'' + esc(c.id) + '\')">Add</button>') + '</div>';
      }).join('')) + '</div>';
    }

    return '<div class="wx-body">' + (S.error ? '<div class="wx-err">' + esc(S.error) + '</div>' : '')
      + (S.connected ? '' : '<div class="wx-miss" style="margin:0 0 12px">WhatsApp Business is not connected on this server, so messages cannot be delivered yet. You can still prepare and preview them.</div>')
      + '<div class="wx-grid"><div>'
      + '<div class="wx-card"><h3><span class="wx-num">1</span>Candidates <span class="wx-chip wx-info" id="wxCount">' + picked.length + ' selected</span></h3>'
      + '<div class="wx-row"><input id="wxFilter" class="wx-in" type="search" placeholder="Search these candidates…" value="' + esc(S.filter) + '" oninput="wxFilter(this.value)">'
      + '<button class="wx-btn" onclick="wxAll(true)">Select all</button><button class="wx-btn" onclick="wxAll(false)">Deselect all</button></div>'
      + '<div class="wx-list">' + (list || '<div class="wx-state" style="padding:18px">' + (S.ids.length ? 'No candidate matches that search.' : 'No candidates yet. Search your pool below and add them.') + '</div>') + '</div>'
      + '<div class="wx-row" style="margin-top:9px"><input id="wxPoolQ" class="wx-in" type="search" placeholder="Add someone else from your pool (name, phone, skill)…" value="' + esc(S.poolQ) + '" oninput="wxPoolQ(this.value)"></div>' + pool + '</div>'
      + '</div><div>'
      + numberCard()
      + '<div class="wx-card"><h3><span class="wx-num">2</span>Campaign name</h3>'
      + '<input id="wxCampaign" class="wx-in" style="width:100%" maxlength="120" placeholder="e.g. Nellore nurses - walk-in reminder" value="' + esc(S.campaign) + '" oninput="wxCampaign(this.value)">'
      + '<div class="wx-cs" style="margin-top:4px">Names this send. It appears in History and under Templates &amp; Campaigns → Campaigns.</div></div>'
      + '<div class="wx-card"><h3><span class="wx-num">3</span>Select WhatsApp Template' + (S.canManage ? ' <a href="javascript:void(0)" style="margin-left:auto;font-size:12px" onclick="wxManage()">Manage templates</a>' : '') + '</h3>'
      + '<input id="wxTplQ" class="wx-in" style="width:100%" type="search" placeholder="Search templates…" value="' + esc(S.tplQ) + '" oninput="wxTplQ(this.value)">'
      + '<div class="wx-tpls">' + (tplHtml || (S.templates.length ? '<div class="wx-state" style="padding:12px">No template matches that search.</div>' : '')) + '</div>' + noTpl + jobSel + '</div>'
      + '<div class="wx-card" id="wxPrevBox"><h3><span class="wx-num">4</span>WhatsApp Message Preview</h3>' + switcher + preview + '</div>'
      + '</div></div></div>' + footHtml();
  }

  function numberLabel(n) { return n.displayName + (n.displayPhone ? ' · ' + n.displayPhone : '') + (n.department ? ' · ' + n.department : ''); }
  function numberCard() {
    if (!S.numbersLoaded) return '';
    if (!S.numbers.length) {
      return '<div class="wx-card"><h3>Send from</h3><div class="wx-miss" style="margin:0">No WhatsApp number is assigned to you yet, so nothing can be sent. '
        + 'Ask an administrator to give you (or your department) a number in <b>Integrations → WhatsApp</b>.</div></div>';
    }
    if (S.numbers.length === 1) {
      return '<div class="wx-card"><h3>Send from</h3><div style="font-size:13.5px"><b>' + esc(S.numbers[0].displayName) + '</b>' + (S.numbers[0].displayPhone ? ' · ' + esc(S.numbers[0].displayPhone) : '')
        + (S.numbers[0].department ? ' <span class="wx-chip">' + esc(S.numbers[0].department) + '</span>' : '')
        + (S.numbers[0].status !== 'connected' ? ' <span class="wx-chip wx-warn">' + esc(S.numbers[0].status.replace('_', ' ')) + '</span>' : '') + '</div></div>';
    }
    return '<div class="wx-card"><h3>Send from</h3><select class="wx-sel" id="wxNumber" onchange="wxNumber(this.value)" aria-label="WhatsApp number to send from">'
      + (S.numberId ? '' : '<option value="">Choose a number…</option>')
      + S.numbers.map(function (n) { return '<option value="' + esc(n.id) + '"' + (S.numberId === n.id ? ' selected' : '') + '>' + esc(numberLabel(n)) + '</option>'; }).join('')
      + '</select><div class="wx-cs" style="margin-top:4px">Only the numbers an administrator has given you are listed.</div></div>';
  }
  window.wxNumber = function (v) { if (!S) return; S.numberId = v; paint(); };

  /* who will and will not get it, with the switches that are allowed */
  function tally() {
    var picked = pickedIds(), ready = 0, skip = [], kinds = {};
    picked.forEach(function (id) {
      var p = S.pre[id]; if (!p) return;
      if (p.sendable) ready += 1; else { skip.push(p); (p.blocked || []).forEach(function (b) { kinds[b.kind] = (kinds[b.kind] || 0) + 1; }); }
    });
    return { picked: picked.length, ready: ready, skip: skip, kinds: kinds };
  }
  function footHtml() {
    var t = tally();
    var havePre = S.tplId && Object.keys(S.pre).length;
    var ticks = '';
    if (havePre) {
      /* the "include anyway" switches, only where somebody is held back for that reason - and the opt-in one only for who may */
      var k = S.pre;
      var opt = pickedIds().filter(function (id) { return k[id] && ((k[id].blocked || []).some(function (b) { return b.kind === 'optin'; }) || (S.ticks.includeNoOptIn && !k[id].optIn)); }).length;
      var warned = pickedIds().filter(function (id) { return k[id] && (k[id].blocked || []).some(function (b) { return b.kind === 'warned'; }); }).length;
      var nl = pickedIds().filter(function (id) { return k[id] && (k[id].blocked || []).some(function (b) { return b.kind === 'notlooking'; }); }).length;
      if (opt && S.canBypass) ticks += '<label class="wx-tick"><input type="checkbox" ' + (S.ticks.includeNoOptIn ? 'checked' : '') + ' onchange="wxTick(\'includeNoOptIn\',this.checked)"><span>Include ' + opt + ' with no WhatsApp opt-in on record (administrators and team leads only; recorded)</span></label>';
      if (warned) ticks += '<label class="wx-tick"><input type="checkbox" ' + (S.ticks.includeWarned ? 'checked' : '') + ' onchange="wxTick(\'includeWarned\',this.checked)"><span>Include ' + warned + ' another recruiter has already contacted</span></label>';
      if (nl) ticks += '<label class="wx-tick"><input type="checkbox" ' + (S.ticks.includeNotLooking ? 'checked' : '') + ' onchange="wxTick(\'includeNotLooking\',this.checked)"><span>Include ' + nl + ' who said they are not looking</span></label>';
    }
    var summary = !S.tplId ? '<b>' + t.picked + '</b> candidate' + (t.picked === 1 ? '' : 's') + ' selected · choose a template'
      : '<b>' + t.ready + '</b> of ' + t.picked + ' selected will be sent' + (t.skip.length ? ' · <a href="javascript:void(0)" onclick="wxSkipped()">' + t.skip.length + ' will be skipped</a>' : '');
    var canSend = S.tplId && t.ready > 0 && S.templateOk !== false && !S.sending && !S.previewing && !S.loading && !!S.numberId;
    return '<div class="wx-foot"><div class="wx-sum">' + summary + ticks + '</div>'
      + '<button class="wx-btn" onclick="wxClose()">Cancel</button>'
      + '<button class="wx-btn" onclick="wxPreviewNow()" ' + (S.tplId ? '' : 'disabled') + '>Preview Message</button>'
      + '<button class="wx-btn p" id="wxSend" onclick="wxAskSend()" ' + (canSend ? '' : 'disabled') + '>Send WhatsApp</button></div>';
  }

  function confirmHtml() {
    var t = tally();
    var tpl = S.curTemplate || {};
    return '<div class="wx-body"><div class="wx-card" style="max-width:640px;margin:16px auto"><h3 style="font-size:16px">Send WhatsApp messages?</h3>'
      + '<p style="font-size:14.5px;margin:6px 0 10px">You are about to send WhatsApp messages to <b>' + t.ready + ' selected candidate' + (t.ready === 1 ? '' : 's') + '</b>.</p>'
      + '<p class="wx-cs" style="font-size:13px">From: <b>' + esc((S.numbers.filter(function (n) { return n.id === S.numberId; })[0] ? numberLabel(S.numbers.filter(function (n) { return n.id === S.numberId; })[0]) : '')) + '</b><br>Campaign: <b>' + esc((S.campaign || '').trim() || tpl.name || '') + '</b><br>Template: <b>' + esc(tpl.name || '') + '</b> (' + esc(tpl.waName || '') + ', ' + esc(tpl.language || '') + '). Each candidate receives their own message, with their own details filled in.</p>'
      + (t.skip.length ? '<div class="wx-miss">' + t.skip.length + ' selected candidate' + (t.skip.length === 1 ? ' is' : 's are') + ' not sent: '
        + esc(t.skip.slice(0, 4).map(function (p) { return p.name; }).join(', ')) + (t.skip.length > 4 ? ' and ' + (t.skip.length - 4) + ' more' : '') + '.</div>' : '')
      + (S.error ? '<div class="wx-err" style="margin-top:10px">' + esc(S.error) + '</div>' : '')
      + '<div class="wx-row" style="margin-top:14px;justify-content:flex-end"><button class="wx-btn" onclick="wxBack()" ' + (S.sending ? 'disabled' : '') + '>Back</button>'
      + '<button class="wx-btn p" onclick="wxSend()" ' + (S.sending ? 'disabled' : '') + '>' + (S.sending ? 'Sending…' : 'Confirm and send') + '</button></div></div></div>';
  }

  var STATUS = {
    pending: ['Pending', 'wx-warn'], sent: ['Sent', 'wx-info'], delivered: ['Delivered', 'wx-ok'], read: ['Read', 'wx-ok'], failed: ['Failed', 'wx-bad'], skipped_no_contact: ['No number', 'wx-bad'],
  };
  function when(t) { if (!t) return ''; try { return new Date(t).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } }

  function resultsHtml() {
    var b = S.batch;
    if (!b) return '<div class="wx-body"><div class="wx-state">Queued. Waiting for the first results…</div></div>';
    var rows = b.rows.map(function (r) {
      var st = r.readAt ? 'read' : r.status;
      var s = STATUS[st] || [st, ''];
      return '<tr><td>' + (r.to && b.numberId ? '<a href="javascript:void(0)" title="Open the conversation" onclick="wxOpenChat(\'' + esc(b.numberId) + '\',\'' + esc(r.to) + '\')"><b>' + esc(r.name) + '</b> 💬</a>' : '<b>' + esc(r.name) + '</b>') + '</td><td>' + esc(r.to ? '+' + r.to : '') + '</td><td><span class="wx-chip ' + s[1] + '">' + esc(s[0]) + '</span>'
        + (r.error ? '<div class="wx-cs" style="color:var(--bad-600,#c0392b)">' + esc(r.error) + '</div>' : '') + '</td>'
        + '<td class="wx-cs">' + esc(when(r.readAt || r.deliveredAt || r.sentAt || r.queuedAt)) + '</td></tr>';
    }).join('');
    var skipped = (S.skippedOnSend || []).map(function (s) {
      return '<tr><td><b>' + esc(s.name) + '</b></td><td></td><td><span class="wx-chip wx-warn">Not sent</span><div class="wx-cs">' + esc((s.reasons || []).join('; ')) + '</div></td><td></td></tr>';
    }).join('');
    return '<div class="wx-body">' + (S.error ? '<div class="wx-err">' + esc(S.error) + '</div>' : '')
      + '<div class="wx-row" style="margin-bottom:10px"><b style="font-size:15px">' + esc(b.campaignName || b.templateName || 'WhatsApp send') + '</b>'
      + (b.campaignName && b.templateName ? '<span class="wx-chip">' + esc(b.templateName) + '</span>' : '')
      + (b.numberLabel ? '<span class="wx-chip wx-info">from ' + esc(b.numberLabel) + '</span>' : '')
      + '<span class="wx-cs">' + (b.finished ? 'Finished' : 'Sending… this updates by itself') + '</span></div>'
      + '<div class="wx-kv"><div><b>' + b.total + '</b><span>Messages</span></div><div><b>' + b.pending + '</b><span>Pending</span></div><div><b>' + (b.sent + b.delivered) + '</b><span>Sent</span></div>'
      + '<div><b>' + b.delivered + '</b><span>Delivered</span></div><div><b>' + b.read + '</b><span>Read</span></div><div><b>' + b.failed + '</b><span>Failed</span></div></div>'
      + '<table class="wx-tbl"><thead><tr><th>Candidate</th><th>WhatsApp number</th><th>Status</th><th>Time</th></tr></thead><tbody>' + rows + skipped + '</tbody></table></div>'
      + '<div class="wx-foot"><div class="wx-sum">' + (b.failed ? '<b>' + b.failed + '</b> failed - retrying sends only those; messages already sent are not sent again.' : (b.finished ? 'All done.' : '')) + '</div>'
      + (b.failed ? '<button class="wx-btn p" onclick="wxRetry()" ' + (S.sending ? 'disabled' : '') + '>Retry failed (' + b.failed + ')</button>' : '')
      + '<button class="wx-btn" onclick="wxNew()">Send another</button><button class="wx-btn" onclick="wxClose()">Close</button></div>';
  }

  function historyHtml() {
    if (S.histError) return '<div class="wx-body"><div class="wx-err">' + esc(S.histError) + '</div></div>';
    if (!S.hist) return '<div class="wx-body"><div class="wx-state">Loading…</div></div>';
    var h = S.hist;
    var rows = (h.batches || []).map(function (b) {
      return '<tr style="cursor:pointer" onclick="wxOpenBatch(\'' + esc(b.batchId) + '\')"><td><b>' + esc(b.campaignName || b.templateName || '') + '</b><div class="wx-cs">' + esc(b.templateName || '') + ' · ' + esc(b.recruiter || '') + (b.numberLabel ? ' · from ' + esc(b.numberLabel) : '') + '</div></td>'
        + '<td class="wx-cs">' + esc(when(b.at)) + '</td><td>' + b.total + '</td><td>' + b.sent + '</td><td>' + b.delivered + '</td><td>' + b.read + '</td>'
        + '<td>' + (b.failed ? '<span class="wx-chip wx-bad">' + b.failed + ' failed</span>' : '0') + (b.pending ? ' <span class="wx-chip wx-warn">' + b.pending + ' pending</span>' : '') + '</td></tr>';
    }).join('');
    var by = h.byRecruiter ? '<h3 style="margin:18px 0 8px;font-size:14px">By recruiter</h3><table class="wx-tbl"><thead><tr><th>Recruiter</th><th>Messages</th><th>Sent</th><th>Delivered</th><th>Failed</th></tr></thead><tbody>'
      + h.byRecruiter.map(function (r) { return '<tr><td><b>' + esc(r.recruiter) + '</b></td><td>' + r.messages + '</td><td>' + r.sent + '</td><td>' + r.delivered + '</td><td>' + r.failed + '</td></tr>'; }).join('') + '</tbody></table>' : '';
    return '<div class="wx-body">' + (rows ? '<table class="wx-tbl"><thead><tr><th>Campaign / template · sent by</th><th>When</th><th>Messages</th><th>Sent</th><th>Delivered</th><th>Read</th><th>Problems</th></tr></thead><tbody>' + rows + '</tbody></table>'
      : '<div class="wx-state">No WhatsApp messages have been sent yet.</div>') + by + '</div>';
  }

  /* ------------------------------------------------------------------ *
   * actions
   * ------------------------------------------------------------------ */
  window.wxTab = function (t) {
    if (!S) return;
    S.tab = t; paint();
    if (t === 'history') {
      S.hist = null; S.histError = ''; paint();
      api().get('/whatsapp/history').then(function (r) { if (S) { S.hist = r; paint(); } }, function (e) { if (S) { S.histError = errText(e); paint(); } });
    }
  };
  window.wxOpenBatch = function (id) {
    if (!S) return;
    S.tab = 'send'; S.phase = 'results'; S.batch = null; S.skippedOnSend = []; paint();
    startPoll(id);
  };
  window.wxCur = function (id) { if (!S) return; S.cur = id; paint(); };
  window.wxStep = function (d) {
    if (!S) return; var p = pickedIds(); if (!p.length) return;
    var i = p.indexOf(S.cur); i = (i + d + p.length) % p.length; S.cur = p[i]; paint();
  };
  window.wxPick = function (id, on) { if (!S) return; S.picked[id] = !!on; if (on && !S.cur) S.cur = id; if (S.cur === id && !on) S.cur = pickedIds()[0] || id; paint(); };
  window.wxAll = function (on) {
    if (!S) return;
    var q = S.filter.toLowerCase();
    S.ids.forEach(function (id) {
      var i = infoOf(id) || {};
      if (q && (nameOf(id) + ' ' + (i.phone || '') + ' ' + (i.jobTitle || '')).toLowerCase().indexOf(q) < 0) return;   // only what is shown
      S.picked[id] = !!on;
    });
    S.cur = pickedIds()[0] || S.cur; paint();
  };
  window.wxFilter = function (v) { if (!S) return; S.filter = v; paint(); };
  window.wxTplQ = function (v) { if (!S) return; S.tplQ = v; paint(); };
  window.wxTpl = function (id) {
    if (!S) return;
    S.tplId = id; S.pre = {}; S.templateOk = undefined; S.templateWhy = [];
    if (!S.campaignTyped) {
      var t = S.templates.filter(function (x) { return x.id === id; })[0];
      S.campaign = t ? t.name + ' - ' + new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
    }
    paint(); refreshPreview(true);
  };
  window.wxCampaign = function (v) { if (!S) return; S.campaign = v; S.campaignTyped = true; };
  window.wxJob = function (v) { if (!S) return; S.jobId = v; S.pre = {}; reloadRecipients(); refreshPreview(true); };
  window.wxTick = function (k, on) { if (!S) return; S.ticks[k] = !!on; refreshPreview(true); paint(); };
  window.wxPreviewNow = function () {
    if (!S) return;
    if (!S.tplId) { toast('Select a template first', '☝️'); return; }
    refreshPreview(true);
    var el = $('wxPrevBox'); if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  window.wxSkipped = function () {
    if (!S) return; var t = tally();
    var lines = t.skip.map(function (p) { return p.name + ' - ' + (p.blocked || []).map(function (b) { return b.reason; }).join('; '); });
    alert('These selected candidates will not be sent a message:\n\n' + lines.join('\n'));
  };
  function reloadRecipients() {
    var mine = S;
    api().post('/whatsapp/recipients', body()).then(function (r) { if (S === mine) { applyRecipients(r); paint(); } }, function () { /* the preview says */ });
  }
  window.wxManage = function () { if (typeof window.tlWaTemplates === 'function') window.tlWaTemplates(); };

  var poolTimer = null;
  window.wxPoolQ = function (v) {
    if (!S) return; S.poolQ = v; clearTimeout(poolTimer);
    if (v.trim().length < 2) { S.pool = []; S.poolBusy = false; paint(); return; }
    S.poolBusy = true; paint();
    var mine = S;
    poolTimer = setTimeout(function () {
      api().get('/candidates?limit=8&q=' + encodeURIComponent(v.trim())).then(function (r) {
        if (S !== mine) return; S.poolBusy = false; S.pool = r.candidates || []; paint();
      }, function () { if (S === mine) { S.poolBusy = false; S.pool = []; paint(); } });
    }, 300);
  };
  window.wxAdd = function (id) {
    if (!S) return;
    var c = S.pool.filter(function (x) { return x.id === id; })[0];
    if (c) S.names[id] = { name: c.name, phone: c.phone, title: c.title };
    addCandidate(id, true); S.cur = id;
    reloadRecipients(); refreshPreview(true); paint();
  };

  window.wxAskSend = function () {
    if (!S || S.sending) return;
    if (!S.tplId) { toast('Select a template first', '☝️'); return; }
    S.error = ''; S.phase = 'confirm'; paint();
  };
  window.wxBack = function () { if (!S || S.sending) return; S.phase = 'compose'; S.error = ''; paint(); };

  window.wxSend = function () {
    if (!S || S.sending) return;                                // a second click while one is in flight does nothing
    var t = tally(); if (!t.ready) return;
    S.sending = true; S.error = ''; paint();
    var mine = S;
    var b = body();
    b.candidateIds = pickedIds();                                // exactly the ticked ones
    /* only the applications of candidates still ticked: an application never brings back someone who was deselected */
    var chosen = pickedIds();
    var apps = S.applicationIds.filter(function (aid) { return chosen.some(function (id) { var i = infoOf(id); return i && i.applicationId === aid; }); });
    b.applicationIds = apps.length ? apps : undefined;
    b.numberId = S.numberId || undefined;
    b.templateId = S.tplId; b.sendKey = S.sendKey; b.campaignName = (S.campaign || '').trim() || undefined;
    b.includeNoOptIn = S.ticks.includeNoOptIn; b.includeWarned = S.ticks.includeWarned; b.includeNotLooking = S.ticks.includeNotLooking;
    api().post('/whatsapp/send', b).then(function (r) {
      if (S !== mine) return;
      S.sending = false; S.phase = 'results'; S.skippedOnSend = r.skipped || [];
      S.batch = null; paint();
      startPoll(r.batchId);
    }, function (e) {
      if (S !== mine) return;
      S.sending = false;
      /* the same sendKey is kept: pressing again after a network error cannot send twice */
      S.error = errText(e) + (e && e.status ? '' : ' If you are unsure whether it went through, press Confirm again - nothing is sent twice.');
      paint();
    });
  };

  function startPoll(batchId) {
    if (poll) { clearInterval(poll); poll = null; }
    var mine = S;
    var tick = function () {
      if (!S || S !== mine) { clearInterval(poll); poll = null; return; }
      api().get('/whatsapp/batches/' + encodeURIComponent(batchId)).then(function (b) {
        if (S !== mine) return;
        S.batch = b; S.batchId = batchId; paint();
        if (b.finished) { clearInterval(poll); poll = null; }
      }, function (e) { if (S === mine) { S.error = errText(e); paint(); } });
    };
    tick(); poll = setInterval(tick, 2000);
  }
  window.wxRetry = function () {
    if (!S || S.sending || !S.batchId) return;
    S.sending = true; S.error = ''; paint();
    var mine = S;
    api().post('/whatsapp/batches/' + encodeURIComponent(S.batchId) + '/retry', {}).then(function (r) {
      if (S !== mine) return;
      S.sending = false; S.batch = r; toast(r.note || 'Retrying', '🔁'); paint(); startPoll(S.batchId);
    }, function (e) { if (S === mine) { S.sending = false; S.error = errText(e); paint(); } });
  };
  window.wxNew = function () {
    if (!S) return;
    if (poll) { clearInterval(poll); poll = null; }
    S.phase = 'compose'; S.batch = null; S.batchId = null; S.skippedOnSend = []; S.sendKey = uid(); S.error = '';
    refreshPreview(true); paint();
  };

  /* A conversation is opened in the WhatsApp Inbox (teamlink-whatsapp-inbox.js), the one place they live. */
  window.wxOpenChat = function (numberId, contact) {
    wxClose();
    if (typeof window.tlWhatsAppInbox === 'function') window.tlWhatsAppInbox({ numberId: numberId, contact: contact });
  };

  /* ================================================================== *
   * template management (administrators)
   * ================================================================== */
  var F = null;     // the template form being edited

  var LANGS = [['en', 'English (en)'], ['en_US', 'English US (en_US)'], ['en_GB', 'English UK (en_GB)'], ['hi', 'Hindi (hi)'], ['te', 'Telugu (te)'], ['ta', 'Tamil (ta)'], ['kn', 'Kannada (kn)'],
    ['ml', 'Malayalam (ml)'], ['mr', 'Marathi (mr)'], ['bn', 'Bengali (bn)'], ['gu', 'Gujarati (gu)'], ['ur', 'Urdu (ur)']];
  var WA_STATUSES = [['approved', 'Approved by WhatsApp'], ['pending', 'Pending WhatsApp review'], ['draft', 'Draft (not submitted)'], ['rejected', 'Rejected'], ['paused', 'Paused'], ['disabled', 'Disabled']];

  var SAMPLE = {};
  function sampleOf(k) { return SAMPLE[k] || '[' + k + ']'; }

  /** open the form: id = an existing template's id, or null for a new one */
  window.tlWaTemplateForm = function (id, done) {
    if (!api()) return;
    addStyle();
    if (F) return;
    F = { id: id || null, done: done, vars: [], v: blank(), errors: {}, busy: false, error: '', loading: true };
    var root = document.createElement('div'); root.id = 'wxTplRoot'; document.body.appendChild(root);
    paintForm();
    var calls = [api().get('/whatsapp/templates?all=true')];
    if (id) calls.push(api().get('/whatsapp/templates/' + encodeURIComponent(id)));
    Promise.all(calls).then(function (r) {
      F.vars = r[0].variables || VARS_FALLBACK;
      F.vars.forEach(function (v) { SAMPLE[v.key] = v.example; });
      if (r[1] && r[1].form) F.v = fromForm(r[1].form);
      F.loading = false; paintForm();
    }, function (e) { F.loading = false; F.error = errText(e); paintForm(); });
  };
  function blank() {
    return { name: '', waName: '', language: 'en', category: 'UTILITY', waStatus: 'approved', body: '', footer: '', headerType: 'none', headerText: '', headerParam: '', headerMediaUrl: '',
      buttons: [], fallbacks: {}, params: [], numbered: 0 };
  }
  function fromForm(f) {
    var v = blank(); Object.keys(v).forEach(function (k) { if (f[k] != null) v[k] = f[k]; });
    v.buttons = (f.buttons || []).map(function (b) { return { type: b.type, text: b.text, url: b.url || '', phone: b.phone || '', urlParam: b.urlParam || '' }; });
    return v;
  }
  function closeForm() {
    var r = $('wxTplRoot'); if (r && r.parentNode) r.parentNode.removeChild(r);
    F = null;
  }
  window.wxfClose = closeForm;

  function fieldErr(k) { return F.errors[k] ? '<div class="e">' + esc(F.errors[k]) + '</div>' : ''; }
  function varOptions(sel, allowNone) {
    return (allowNone ? '<option value="">—</option>' : '') + F.vars.map(function (x) { return '<option value="' + esc(x.key) + '" ' + (sel === x.key ? 'selected' : '') + '>' + esc(x.label) + '</option>'; }).join('');
  }
  function usedKeys() {
    var m = String(F.v.body).match(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/gi) || [];
    var out = [];
    m.forEach(function (x) { var k = x.replace(/[{}\s]/g, '').toLowerCase(); if (out.indexOf(k) < 0) out.push(k); });
    return out;
  }
  function formPreview() {
    var v = F.v;
    var body = String(v.body).replace(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/gi, function (w, k) { return sampleOf(k.toLowerCase()); })
      .replace(/\{\{\s*(\d+)\s*\}\}/g, function (w, n) { var k = v.params[Number(n) - 1]; return k ? sampleOf(k) : w; });
    var head = { type: v.headerType };
    if (v.headerType === 'text') head.text = String(v.headerText).replace(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/gi, function (w, k) { return sampleOf(k.toLowerCase()); })
      .replace(/\{\{\s*1\s*\}\}/g, v.headerParam ? sampleOf(v.headerParam) : '{{1}}');
    else head.mediaUrl = v.headerMediaUrl;
    return bubble({ header: head, body: body, footer: v.footer, buttons: v.buttons.map(function (b) { return { type: b.type, text: b.text }; }) });
  }
  function paintForm() {
    var root = $('wxTplRoot'); if (!F || !root) return;
    var ae = document.activeElement, keep = ae && ae.id && root.contains(ae) ? { id: ae.id, s: ae.selectionStart, e: ae.selectionEnd } : null;
    var v = F.v, editing = !!F.id;
    var numbered = (String(v.body).match(/\{\{\s*\d+\s*\}\}/g) || []).length;
    var map = '';
    if (numbered) {
      map = '<div class="wx-card"><h3>Match the numbered variables to candidate fields</h3><div class="wx-f2">';
      for (var n = 0; n < numbered; n += 1) {
        map += '<div><label>{{' + (n + 1) + '}} is filled with</label><select id="wxfP' + n + '" onchange="wxfParam(' + n + ',this.value)">' + varOptions(v.params[n] || '', true) + '</select></div>';
      }
      map += '</div>' + fieldErr('body') + '</div>';
    }
    var hdrNeedsParam = v.headerType === 'text' && /\{\{\s*1\s*\}\}/.test(v.headerText);
    var fbs = usedKeys().map(function (k) {
      return '<div><label>If “' + esc(k) + '” is missing, use</label><input id="wxfF_' + k + '" value="' + esc(v.fallbacks[k] || '') + '" oninput="wxfFb(\'' + k + '\',this.value)" placeholder="(send nothing - the candidate is skipped)"></div>';
    }).join('');
    var btns = v.buttons.map(function (b, i) {
      return '<div class="wx-card" style="margin-top:8px"><div class="wx-f3"><div><label>Button type</label><select onchange="wxfBtn(' + i + ',\'type\',this.value)">'
        + [['quick_reply', 'Quick reply'], ['url', 'Link (URL)'], ['phone', 'Call phone']].map(function (o) { return '<option value="' + o[0] + '" ' + (b.type === o[0] ? 'selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></div>'
        + '<div><label>Button text</label><input id="wxfB' + i + 't" value="' + esc(b.text) + '" oninput="wxfBtn(' + i + ',\'text\',this.value,true)" maxlength="25"></div>'
        + '<div style="align-self:end"><button class="wx-btn" onclick="wxfDelBtn(' + i + ')">Remove</button></div></div>'
        + (b.type === 'url' ? '<div class="wx-f2" style="margin-top:8px"><div><label>Link (https://…{{1}} for a variable end)</label><input id="wxfB' + i + 'u" value="' + esc(b.url) + '" oninput="wxfBtn(' + i + ',\'url\',this.value,true)"></div>'
          + (/\{\{\s*\d+\s*\}\}/.test(b.url || '') ? '<div><label>{{1}} is filled with</label><select onchange="wxfBtn(' + i + ',\'urlParam\',this.value)">' + varOptions(b.urlParam || '', true) + '</select></div>' : '') + '</div>' : '')
        + (b.type === 'phone' ? '<div style="margin-top:8px"><label>Phone number</label><input id="wxfB' + i + 'p" value="' + esc(b.phone) + '" oninput="wxfBtn(' + i + ',\'phone\',this.value,true)"></div>' : '')
        + fieldErr('buttons.' + i) + '</div>';
    }).join('');

    root.innerHTML = '<div class="wx-ov" style="z-index:9600"><div class="wx-modal" role="dialog" aria-modal="true" style="width:min(1020px,100%)">'
      + '<div class="wx-head"><h2><span class="wx-dot">✆</span>' + (editing ? 'Edit WhatsApp template' : 'New WhatsApp Business template') + '</h2><div class="wx-tabs"></div><button class="wx-x" onclick="wxfClose()" aria-label="Close">✕</button></div>'
      + '<div class="wx-body">' + (F.loading ? '<div class="wx-state">Loading…</div>' : (F.error ? '<div class="wx-err">' + esc(F.error) + '</div>' : '')
      + '<div class="wx-grid" style="grid-template-columns:minmax(320px,3fr) minmax(300px,2fr)"><div class="wx-form">'
      + '<div class="wx-f2"><div><label>Display name</label><input id="wxfName" value="' + esc(v.name) + '" oninput="wxfSet(\'name\',this.value,true)" placeholder="e.g. Profile review update">' + fieldErr('name') + '</div>'
      + '<div><label>WhatsApp template name (as in WhatsApp Manager)</label><input id="wxfWaName" value="' + esc(v.waName) + '" oninput="wxfSet(\'waName\',this.value,true)" placeholder="profile_review_update" ' + (editing ? '' : '') + '>' + fieldErr('waName') + '</div></div>'
      + '<div class="wx-f3"><div><label>Language</label><select onchange="wxfSet(\'language\',this.value)">' + LANGS.map(function (l) { return '<option value="' + l[0] + '" ' + (v.language === l[0] ? 'selected' : '') + '>' + l[1] + '</option>'; }).join('')
        + (LANGS.some(function (l) { return l[0] === v.language; }) ? '' : '<option selected>' + esc(v.language) + '</option>') + '</select>' + fieldErr('language') + '</div>'
      + '<div><label>Category</label><select onchange="wxfSet(\'category\',this.value)">' + ['UTILITY', 'MARKETING', 'AUTHENTICATION'].map(function (c) { return '<option ' + (v.category === c ? 'selected' : '') + '>' + c + '</option>'; }).join('') + '</select></div>'
      + '<div><label>WhatsApp approval status</label><select onchange="wxfSet(\'waStatus\',this.value)">' + WA_STATUSES.map(function (s) { return '<option value="' + s[0] + '" ' + (v.waStatus === s[0] ? 'selected' : '') + '>' + s[1] + '</option>'; }).join('') + '</select>' + fieldErr('waStatus') + '</div></div>'
      + '<div class="wx-f2"><div><label>Header</label><select onchange="wxfSet(\'headerType\',this.value)">' + [['none', 'No header'], ['text', 'Text'], ['image', 'Image'], ['document', 'Document'], ['video', 'Video']].map(function (o) { return '<option value="' + o[0] + '" ' + (v.headerType === o[0] ? 'selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></div>'
      + (v.headerType === 'text' ? '<div><label>Header text (one {{field}} allowed)</label><input id="wxfHT" value="' + esc(v.headerText) + '" oninput="wxfSet(\'headerText\',this.value,true)" maxlength="60">' + fieldErr('headerText') + '</div>' : '')
      + (v.headerType !== 'none' && v.headerType !== 'text' ? '<div><label>Media link (public https://)</label><input id="wxfHM" value="' + esc(v.headerMediaUrl) + '" oninput="wxfSet(\'headerMediaUrl\',this.value,true)">' + fieldErr('headerMediaUrl') + '</div>' : '') + '</div>'
      + (hdrNeedsParam ? '<div><label>Header {{1}} is filled with</label><select onchange="wxfSet(\'headerParam\',this.value)">' + varOptions(v.headerParam, true) + '</select></div>' : '')
      + '<div><label>Message body</label><textarea id="wxfBody" oninput="wxfSet(\'body\',this.value,true)" placeholder="Hello {{candidate_name}}, ...">' + esc(v.body) + '</textarea>' + (numbered ? '' : fieldErr('body'))
      + '<div class="wx-row" style="margin-top:6px">' + F.vars.map(function (x) { return '<button type="button" class="wx-btn" onclick="wxfInsert(\'' + x.key + '\')" title="' + esc(x.label) + '">{{' + x.key + '}}</button>'; }).join('') + '</div></div>'
      + map
      + '<div><label>Footer (optional)</label><input id="wxfFooter" value="' + esc(v.footer) + '" oninput="wxfSet(\'footer\',this.value,true)" maxlength="60">' + fieldErr('footer') + '</div>'
      + '<div><label>Buttons (optional)</label>' + btns + '<div style="margin-top:8px"><button class="wx-btn" onclick="wxfAddBtn()" ' + (v.buttons.length >= 10 ? 'disabled' : '') + '>+ Add button</button></div>' + fieldErr('buttons') + '</div>'
      + (fbs ? '<div class="wx-card"><h3>Fallbacks</h3><div class="wx-f2">' + fbs + '</div></div>' : '')
      + '</div><div><div class="wx-label">Preview with sample details</div>' + formPreview()
      + '<p class="wx-cs" style="margin-top:10px">Recruiters can send this template only when WhatsApp has approved it here and in WhatsApp Manager, and every {{number}} is matched to a field. Create the template in WhatsApp Manager with the same name, language and text first (use {{1}}, {{2}} there); the field names here are replaced by those numbers in the order they appear.</p></div></div>')
      + '</div><div class="wx-foot"><div class="wx-sum">' + (F.busy ? 'Saving…' : '') + '</div><button class="wx-btn" onclick="wxfClose()">Cancel</button>'
      + '<button class="wx-btn p" onclick="wxfSave()" ' + (F.busy || F.loading ? 'disabled' : '') + '>' + (editing ? 'Save changes' : 'Create template') + '</button></div></div></div>';
    if (keep) { var el = $(keep.id); if (el) { el.focus(); try { el.setSelectionRange(keep.s, keep.e); } catch (e) { /* select */ } } }
  }
  /* typing repaints only the preview, so the cursor never jumps */
  function repaintPreviewOnly() { paintForm(); }
  window.wxfSet = function (k, val, typing) { if (!F) return; F.v[k] = val; F.errors = {}; if (typing) repaintPreviewOnly(); else paintForm(); };
  window.wxfParam = function (n, k) { if (!F) return; F.v.params[n] = k; paintForm(); };
  window.wxfFb = function (k, val) { if (!F) return; if (val) F.v.fallbacks[k] = val; else delete F.v.fallbacks[k]; };
  window.wxfInsert = function (k) {
    if (!F) return; var ta = $('wxfBody'); var pos = ta ? ta.selectionStart : F.v.body.length;
    F.v.body = F.v.body.slice(0, pos) + '{{' + k + '}}' + F.v.body.slice(pos); paintForm();
    var t2 = $('wxfBody'); if (t2) { t2.focus(); var np = pos + k.length + 4; try { t2.setSelectionRange(np, np); } catch (e) { /* none */ } }
  };
  window.wxfAddBtn = function () { if (!F || F.v.buttons.length >= 10) return; F.v.buttons.push({ type: 'quick_reply', text: '', url: '', phone: '', urlParam: '' }); paintForm(); };
  window.wxfDelBtn = function (i) { if (!F) return; F.v.buttons.splice(i, 1); paintForm(); };
  window.wxfBtn = function (i, k, val, typing) { if (!F) return; F.v.buttons[i][k] = val; if (typing) repaintPreviewOnly(); else paintForm(); };
  window.wxfSave = function () {
    if (!F || F.busy) return;
    F.busy = true; F.errors = {}; F.error = ''; paintForm();
    var mine = F, v = F.v;
    var payload = { name: v.name, waName: v.waName, language: v.language, category: v.category, waStatus: v.waStatus, body: v.body, footer: v.footer,
      headerType: v.headerType, headerText: v.headerText, headerParam: v.headerParam, headerMediaUrl: v.headerMediaUrl, buttons: v.buttons, fallbacks: v.fallbacks, params: v.params };
    var call = F.id ? api().put('/whatsapp/templates/' + encodeURIComponent(F.id), payload) : api().post('/whatsapp/templates', payload);
    call.then(function (r) {
      if (F !== mine) return;
      var done = F.done; closeForm(); toast('WhatsApp template saved', '✅');
      if (typeof done === 'function') done(r.template); else if (S) load();
    }, function (e) {
      if (F !== mine) return;
      F.busy = false; F.errors = (e && e.details) || {}; F.error = Object.keys(F.errors).length ? 'Please check the highlighted fields.' : errText(e); paintForm();
    });
  };

  /** The list of WhatsApp templates (administrators): add, edit, sync. Opened from Admin -> Integrations and from the send popup. */
  var M = null;
  window.tlWaTemplates = function () {
    if (!api() || M) return;
    addStyle();
    M = { rows: null, error: '' };
    var root = document.createElement('div'); root.id = 'wxMgrRoot'; document.body.appendChild(root);
    root.addEventListener('mousedown', function (e) { if (e.target === root.firstChild) mgrClose(); });
    paintMgr(); loadMgr();
  };
  function mgrClose() { var r = $('wxMgrRoot'); if (r && r.parentNode) r.parentNode.removeChild(r); M = null; }
  window.wxmClose = mgrClose;
  function loadMgr() {
    api().get('/whatsapp/templates?all=true').then(function (r) { if (!M) return; M.rows = r.templates || []; M.connected = r.connected; paintMgr(); },
      function (e) { if (!M) return; M.error = errText(e); paintMgr(); });
  }
  function paintMgr() {
    var root = $('wxMgrRoot'); if (!M || !root) return;
    var rows = (M.rows || []).map(function (t) {
      return '<tr><td><b>' + esc(t.name) + '</b><div class="wx-cs">v' + esc(t.version) + (t.archived ? ' · archived' : '') + '</div></td><td>' + esc(t.waName) + '<div class="wx-cs">' + esc(t.language) + (t.category ? ' · ' + esc(t.category.toLowerCase()) : '') + '</div></td>'
        + '<td><span class="wx-chip ' + (t.status === 'approved' ? 'wx-ok' : 'wx-warn') + '">' + esc(t.status || 'not submitted') + '</span></td>'
        + '<td>' + (t.sendable ? '<span class="wx-chip wx-ok">Ready to send</span>' : '<span class="wx-chip wx-warn">Not ready</span><div class="wx-cs">' + esc((t.notSendableBecause || []).join('; ')) + '</div>') + '</td>'
        + '<td><button class="wx-btn" onclick="wxmEdit(\'' + esc(t.id) + '\')">Edit</button></td></tr>';
    }).join('');
    root.innerHTML = '<div class="wx-ov"><div class="wx-modal" role="dialog" aria-modal="true" style="width:min(980px,100%)">'
      + '<div class="wx-head"><h2><span class="wx-dot">✆</span>WhatsApp templates</h2><div class="wx-tabs"></div><button class="wx-x" onclick="wxmClose()" aria-label="Close">✕</button></div>'
      + '<div class="wx-body">' + (M.error ? '<div class="wx-err">' + esc(M.error) + '</div>' : '')
      + (M.connected === false ? '<div class="wx-miss" style="margin:0 0 12px">WhatsApp Business is not connected (Admin → Integrations → WhatsApp Business), so templates cannot be synced and messages cannot be delivered yet.</div>' : '')
      + '<div class="wx-row" style="margin-bottom:12px"><button class="wx-btn p" onclick="wxmNew()">+ New template</button><button class="wx-btn" onclick="wxmSync()">Sync from WhatsApp Business</button>'
      + '<span class="wx-cs" style="flex:1">Recruiters can send only templates that WhatsApp has approved and whose {{fields}} are all matched.</span></div>'
      + (M.rows === null ? '<div class="wx-state">Loading…</div>' : rows ? '<table class="wx-tbl"><thead><tr><th>Name</th><th>WhatsApp name · language</th><th>WhatsApp status</th><th>Recruiters can send it?</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>'
        : '<div class="wx-state">No WhatsApp templates yet. Add one, or sync the approved templates from WhatsApp Business.</div>')
      + '</div></div></div>';
  }
  window.wxmNew = function () { window.tlWaTemplateForm(null, function () { if (M) loadMgr(); }); };
  window.wxmEdit = function (id) { window.tlWaTemplateForm(id, function () { if (M) loadMgr(); }); };
  window.wxmSync = function () { window.tlWaSync(function () { if (M) loadMgr(); }); };

  /** "Sync from WhatsApp Business" (administrators) */
  window.tlWaSync = function (done) {
    if (!api()) return;
    toast('Asking WhatsApp Business for its templates…', '🔄');
    api().post('/whatsapp/templates/sync', {}).then(function (r) {
      var s = r.sync || {};
      toast('Synced ' + (s.found || 0) + ' template' + (s.found === 1 ? '' : 's') + ': ' + (s.added || 0) + ' new, ' + (s.updated || 0) + ' updated'
        + (s.needsMapping ? ', ' + s.needsMapping + ' need their {{numbers}} matched to fields' : ''), '✅');
      if (typeof done === 'function') done(s);
    }, function (e) { alert('Could not sync: ' + errText(e)); });
  };
}());
