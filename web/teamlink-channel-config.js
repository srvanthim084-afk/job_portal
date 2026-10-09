/* =====================================================================
   TEAMLINK — Administration -> Integrations: Email (SMTP), SMS Gateway, WhatsApp Business
   (api/src/notify/channel-config.js, 0122)

   Three cards, added to the Integrations page below the existing ones (nothing else on the page
   is touched). Each card: Connect / Reconnect, Test, Disconnect, History and "Configure ->".
   Configure opens a centred modal: title with icon, x, scrollable body, sticky footer with
   Cancel and "Save & Connect".

   SECRETS never reach this page. The server says "saved" and at most the last four characters,
   shown as a masked placeholder. Blank keeps the stored value, "-" clears it.
   ===================================================================== */
(function () {
  'use strict';
  if (window.__tlcc) return;
  window.__tlcc = true;

  var NOTE = 'Credentials are encrypted on the server before they are stored and are never sent back to this page. '
    + 'This channel really contacts the provider once it is connected.';

  /* ---- what each channel asks for (labels, placeholders and order as specified) ---- */
  var DEFS = {
    email: {
      icon: '✉️', title: 'Email (SMTP)',
      desc: 'Outbound email for candidate messages, offer letters, invoices, payslips and system notifications.',
      secret: 'password',
      fields: [
        { k: 'host', label: 'SMTP Host', ph: 'mail.tmlink.in' },
        { k: 'port', label: 'Port', ph: '465', half: true },
        { k: 'fromAddress', label: 'From Address', ph: 'hr@tmlink.in' },
        { k: 'username', label: 'Username', ph: '' },
        { secret: true, label: 'Password / App Key' },
        { k: 'encryption', label: 'Encryption', select: ['SSL', 'STARTTLS', 'None'], half: true },
        { k: 'fromName', label: 'Default From Name', ph: 'TeamLink HR' },
      ],
    },
    sms: {
      icon: '💬', title: 'SMS Gateway',
      desc: 'Transactional SMS (MSG91, Fast2SMS or Twilio) for signing OTPs, agreement links, interview alerts and bulk messages.',
      secret: 'apiKey',
      fields: [
        { k: 'provider', label: 'Provider', select: ['MSG91', 'Fast2SMS', 'Twilio'], half: true },
        { k: 'senderId', label: 'Sender ID (6 chars) / Twilio From Number', ph: 'TMLINK' },
        { secret: true, label: 'API Key / Auth Token' },
        { k: 'twilioSid', label: 'Twilio Account SID', ph: 'Twilio only (AC…)', twilioOnly: true },
        { k: 'dltAgreement', label: 'DLT Template ID, Agreement Link', ph: 'vars: name, agreement no., link' },
        { k: 'dltOtp', label: 'DLT Template ID, OTP', ph: 'vars: code, minutes' },
        { k: 'dltBulk', label: 'DLT Template ID, Bulk / General', ph: 'one var: the message' },
      ],
    },
    whatsapp: {
      icon: '🟢', title: 'WhatsApp Business',
      desc: 'WhatsApp Cloud API messages: approved templates, plain text only inside a 24-hour customer session.',
      secret: 'accessToken',
      fields: [
        { k: 'businessPhone', label: 'Business Phone Number', ph: '+91…' },
        { k: 'phoneNumberId', label: 'Phone Number ID', ph: 'from Meta → WhatsApp → API Setup' },
        { k: 'businessId', label: 'WhatsApp Business ID', ph: '' },
        { secret: true, label: 'Permanent Access Token' },
        { k: 'namespace', label: 'Template Namespace', ph: 'optional (legacy)' },
        { k: 'language', label: 'Template Language Code', ph: 'en', half: true },
        { k: 'templateAgreement', label: 'Template Name, Agreement Link', ph: 'body {{1}} name, {{2}} agreement no., {{3}} link' },
        { k: 'templateOtp', label: 'Template Name, OTP / Authentication', ph: 'authentication template, {{1}} code' },
        { k: 'templateBulk', label: 'Template Name, Bulk / General', ph: 'body {{1}} = the message' },
      ],
    },
  };
  var ORDER = ['email', 'sms', 'whatsapp'];
  var S = { list: null, keyOk: true, error: '', busy: {}, result: {} };

  function api() { return window.TL && window.TL.api; }
  function role() { try { return window.STATE && window.STATE.session && window.STATE.session.role; } catch (e) { return null; } }
  function h(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function when(iso) { try { return new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }); } catch (e) { return ''; } }
  function say(msg, icon) { if (typeof window.toast === 'function') window.toast(msg, icon || '✅'); }
  function errText(e, dflt) { return (e && e.message) || dflt; }

  /* ---------------------------------------------------------------- styles */
  var css = ''
    + '.tlcc-sec{margin-top:14px}'
    + '.tlcc-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px}'
    + '.tlcc-card{border:1px solid #e3e9f2;border-radius:12px;padding:16px 18px;background:#fff;display:flex;flex-direction:column;gap:8px}'
    + '.tlcc-top{display:flex;align-items:center;gap:10px}'
    + '.tlcc-ico{width:36px;height:36px;border-radius:10px;background:#eef3fb;display:flex;align-items:center;justify-content:center;font-size:18px}'
    + '.tlcc-name{font-weight:800;font-size:14.5px;color:#0f2540}'
    + '.tlcc-badges{display:flex;gap:6px;flex-wrap:wrap;margin-left:auto}'
    + '.tlcc-b{border-radius:20px;padding:2px 10px;font-size:11px;font-weight:800;white-space:nowrap}'
    + '.tlcc-b.on{background:#e8f6ee;color:#1d7a45}.tlcc-b.off{background:#eef1f6;color:#5b6b82}'
    + '.tlcc-b.live{background:#e6f0ff;color:#1a56b8}.tlcc-b.demo{background:#fdf1dc;color:#8a5a12}'
    + '.tlcc-desc{font-size:12.5px;color:#5b6b82;line-height:1.5}'
    + '.tlcc-sum{font-size:12.5px;color:#243449;font-weight:700;min-height:18px}'
    + '.tlcc-sub{font-size:11.5px;color:#7a8798;line-height:1.45}'
    + '.tlcc-res{font-size:12px;border-radius:8px;padding:6px 10px}.tlcc-res.ok{background:#e8f6ee;color:#1d7a45}.tlcc-res.bad{background:#fdeaea;color:#b3261e}'
    + '.tlcc-act{display:flex;gap:6px;flex-wrap:wrap;margin-top:auto;padding-top:6px;align-items:center}'
    + '.tlcc-act .tlcc-cfg{margin-left:auto}'
    /* the modal */
    + '.tlcc-ov{position:fixed;inset:0;z-index:9500;background:rgba(15,25,40,.55);display:flex;align-items:center;justify-content:center;padding:16px}'
    + '.tlcc-modal{background:#fff;border-radius:14px;width:min(560px,100%);max-height:calc(100vh - 32px);display:flex;flex-direction:column;box-shadow:0 24px 60px rgba(10,20,40,.35)}'
    + '.tlcc-head{display:flex;align-items:center;gap:10px;padding:16px 20px;border-bottom:1px solid #e9eef5}'
    + '.tlcc-head h3{margin:0;font-size:16px;color:#0f2540;flex:1}'
    + '.tlcc-x{border:0;background:transparent;font-size:22px;line-height:1;cursor:pointer;color:#5b6b82;padding:2px 6px;border-radius:6px}'
    + '.tlcc-x:hover{background:#eef1f6}'
    + '.tlcc-body{padding:16px 20px;overflow-y:auto;flex:1}'
    + '.tlcc-bdesc{font-size:12.5px;color:#5b6b82;margin:0 0 14px;line-height:1.5}'
    + '.tlcc-fields{display:grid;grid-template-columns:1fr 1fr;gap:12px}'
    + '.tlcc-f{display:flex;flex-direction:column;gap:4px;grid-column:1 / -1}.tlcc-f.half{grid-column:auto}'
    + '.tlcc-f label{font-size:10.5px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:#7a8798}'
    + '.tlcc-f label i{font-style:normal;color:#b07a1f}'
    + '.tlcc-f input,.tlcc-f select{border:1px solid #d5dde9;border-radius:9px;padding:9px 11px;font:inherit;font-size:13.5px;color:#0f2540;background:#fff;width:100%;box-sizing:border-box}'
    + '.tlcc-f input:focus,.tlcc-f select:focus{outline:2px solid #1a56b8;outline-offset:1px;border-color:#1a56b8}'
    + '.tlcc-f.err input,.tlcc-f.err select{border-color:#b3261e}'
    + '.tlcc-e{font-size:11.5px;color:#b3261e}'
    + '.tlcc-foot{border-top:1px solid #e9eef5;padding:12px 20px;background:#fff;border-radius:0 0 14px 14px}'
    + '.tlcc-fnote{font-size:11px;color:#7a8798;line-height:1.45;margin-bottom:10px}'
    + '.tlcc-fbtn{display:flex;justify-content:flex-end;gap:8px}'
    + '.tlcc-prim{background:#0f2540;color:#fff;border:0;border-radius:9px;padding:9px 18px;font-weight:800;font-size:13px;cursor:pointer}'
    + '.tlcc-prim:disabled{opacity:.6;cursor:default}'
    + '.tlcc-sec2{border:1px solid #d5dde9;background:#fff;color:#243449;border-radius:9px;padding:9px 16px;font-weight:700;font-size:13px;cursor:pointer}'
    + '.tlcc-hist{font-size:12.5px;color:#243449;line-height:1.5}.tlcc-hist div{padding:6px 0;border-bottom:1px solid #f0f3f8}'
    + '@media (max-width:560px){.tlcc-fields{grid-template-columns:1fr}}';
  var tag = document.createElement('style');
  tag.id = 'tlcc-css';
  tag.textContent = css;
  (document.head || document.documentElement).appendChild(tag);

  /* ------------------------------------------------------------------ data */
  function load() {
    var a = api();
    if (!a || role() !== 'admin') return;
    a.get('/admin/integration-channels').then(function (r) {
      S.list = r.channels || []; S.keyOk = !!r.secretKeyConfigured; S.error = '';
      paint();
    }, function (e) { S.error = errText(e, 'The messaging channels could not be loaded.'); paint(); });
  }
  function byKey(k) { return (S.list || []).filter(function (c) { return c.channel === k; })[0]; }
  function replace(c) {
    if (!c || !S.list) return;
    S.list = S.list.map(function (x) { return x.channel === c.channel ? c : x; });
  }

  /* ------------------------------------------------------------------ cards */
  function card(k) {
    var d = DEFS[k], c = byKey(k);
    if (!c) return '';
    var b = S.busy[k], res = S.result[k];
    var sub = c.connected
      ? 'Using the settings saved here.'
      : (c.usingEnvironment ? 'Not connected here. Using the server\'s own settings (environment) until you connect.' : 'Not connected. Messages on this channel are not sent.');
    return '<div class="tlcc-card" id="tlccCard_' + k + '">'
      + '<div class="tlcc-top"><span class="tlcc-ico" aria-hidden="true">' + d.icon + '</span><span class="tlcc-name">' + h(d.title) + '</span>'
      + '<span class="tlcc-badges"><span class="tlcc-b ' + (c.connected ? 'on' : 'off') + '">' + (c.connected ? 'Connected' : 'Not Connected') + '</span>'
      + '<span class="tlcc-b ' + (c.mode === 'Live' ? 'live' : 'demo') + '">' + h(c.mode) + '</span></span></div>'
      + '<div class="tlcc-desc">' + h(d.desc) + '</div>'
      + '<div class="tlcc-sum">' + (c.summary ? h(c.summary) : '&nbsp;') + '</div>'
      + '<div class="tlcc-sub">' + h(sub)
      + (c.lastTest ? ' Last test: ' + (c.lastTest.ok ? '✅ ' : '❌ ') + h(when(c.lastTest.at)) : '') + '</div>'
      + (c.secretsReadable === false ? '<div class="tlcc-res bad">The saved credentials cannot be read on this server (INTEGRATION_SECRET_KEY missing or changed). Enter them again in Configure.</div>' : '')
      + (res ? '<div class="tlcc-res ' + (res.ok ? 'ok' : 'bad') + '" role="status">' + h(res.message) + '</div>' : '')
      + '<div class="tlcc-act">'
      + '<button type="button" class="btn btn-ghost btn-sm" ' + (b ? 'disabled' : '') + ' onclick="tlccConnect(\'' + k + '\')">' + (b === 'connect' ? 'Connecting…' : (c.connected ? 'Reconnect' : 'Connect')) + '</button>'
      + '<button type="button" class="btn btn-ghost btn-sm" ' + (b ? 'disabled' : '') + ' onclick="tlccTest(\'' + k + '\')">' + (b === 'test' ? 'Testing…' : 'Test') + '</button>'
      + '<button type="button" class="btn btn-ghost btn-sm" ' + (b || !c.connected ? 'disabled' : '') + ' onclick="tlccDisconnect(\'' + k + '\')">Disconnect</button>'
      + '<button type="button" class="btn btn-ghost btn-sm" onclick="tlccHistory(\'' + k + '\')">History</button>'
      + '<button type="button" class="btn btn-primary btn-sm tlcc-cfg" onclick="tlccConfigure(\'' + k + '\')">Configure →</button>'
      + '</div></div>';
  }

  function paint() {
    var host = document.getElementById('tlccPanel');
    if (!host) return;
    if (S.error) { host.innerHTML = '<div class="tljp-why" role="alert">' + h(S.error) + '</div>'; return; }
    if (!S.list) { host.innerHTML = '<div class="tljp-note" role="status">Loading messaging channels…</div>'; return; }
    host.innerHTML = '<section class="panel tlcc-sec"><div class="panel-head"><div><h2>Messaging channels</h2>'
      + '<div class="desc">Email, SMS and WhatsApp used by candidate messages, offer letters, invoices, payslips and signing OTPs. '
      + 'Credentials are encrypted on the server and never shown again.</div></div></div>'
      + '<div class="panel-body">'
      + (S.keyOk ? '' : '<div class="tljp-why" role="alert"><b>INTEGRATION_SECRET_KEY is not set on the server.</b> Credentials cannot be saved until it is set in the server environment and the server is restarted.</div>')
      + '<div class="tlcc-grid">' + ORDER.map(card).join('') + '</div></div></section>';
  }

  /* ------------------------------------------------------------------ modal helpers */
  function closeModal() {
    var m = document.getElementById('tlccOv');
    if (m && m.parentNode) m.parentNode.removeChild(m);
    document.removeEventListener('keydown', onKey, true);
  }
  function onKey(ev) { if (ev.key === 'Escape') { ev.stopPropagation(); closeModal(); } }
  function openModal(icon, title, bodyHtml, footHtml) {
    closeModal();
    var ov = document.createElement('div');
    ov.className = 'tlcc-ov'; ov.id = 'tlccOv';
    ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true'); ov.setAttribute('aria-label', title);
    ov.innerHTML = '<div class="tlcc-modal"><div class="tlcc-head"><span class="tlcc-ico" aria-hidden="true">' + icon + '</span><h3>' + h(title) + '</h3>'
      + '<button type="button" class="tlcc-x" aria-label="Close" onclick="tlccClose()">×</button></div>'
      + '<div class="tlcc-body">' + bodyHtml + '</div><div class="tlcc-foot">' + footHtml + '</div></div>';
    document.body.appendChild(ov);
    document.addEventListener('keydown', onKey, true);
    var first = ov.querySelector('input,select');
    if (first) first.focus();
    return ov;
  }
  window.tlccClose = closeModal;

  /* ------------------------------------------------------------------ Configure */
  function fieldHtml(k, f, c, errs) {
    var id = 'tlccF_' + (f.k || 'secret');
    var cfg = c.config || {};
    var err = f.secret ? errs[DEFS[k].secret] : errs[f.k];
    var input;
    if (f.secret) {
      var info = (c.secrets && c.secrets[DEFS[k].secret]) || { saved: false };
      var ph = info.saved ? '••••••' + (info.hint || '') + ' — leave blank to keep, "-" to clear' : '';
      input = '<input type="password" id="' + id + '" placeholder="' + h(ph) + '" autocomplete="new-password" spellcheck="false">';
    } else if (f.select) {
      var cur = cfg[f.k] || f.select[0];
      input = '<select id="' + id + '"' + (f.k === 'provider' ? ' onchange="tlccProviderChanged()"' : '') + '>'
        + f.select.map(function (o) { return '<option' + (o === cur ? ' selected' : '') + '>' + h(o) + '</option>'; }).join('') + '</select>';
    } else {
      input = '<input type="text" id="' + id + '" value="' + h(cfg[f.k] || '') + '" placeholder="' + h(f.ph || '') + '" autocomplete="off" spellcheck="false">';
    }
    var hidden = f.twilioOnly && (cfg.provider || 'MSG91') !== 'Twilio';
    return '<div class="tlcc-f' + (f.half ? ' half' : '') + (err ? ' err' : '') + '" id="tlccW_' + (f.k || 'secret') + '"' + (hidden ? ' hidden' : '') + '>'
      + '<label for="' + id + '">' + h(f.label) + (f.secret ? ' <i>· STORED ENCRYPTED, NEVER SHOWN</i>' : '') + '</label>'
      + input + (err ? '<div class="tlcc-e" role="alert">' + h(err) + '</div>' : '') + '</div>';
  }

  window.tlccProviderChanged = function () {
    var p = document.getElementById('tlccF_provider');
    var w = document.getElementById('tlccW_twilioSid');
    if (p && w) w.hidden = p.value !== 'Twilio';
  };

  function readForm(k) {
    var d = DEFS[k], config = {}, secrets = {};
    d.fields.forEach(function (f) {
      var el = document.getElementById('tlccF_' + (f.k || 'secret'));
      if (!el) return;
      var v = String(el.value || '').trim();
      if (f.secret) { secrets[d.secret] = v; } else { config[f.k] = v; }
    });
    if (k === 'sms' && config.provider !== 'Twilio') config.twilioSid = '';
    return { config: config, secrets: secrets };
  }

  function showConfigure(k, errs, draft) {
    var d = DEFS[k], c = byKey(k);
    if (!c) return;
    var view = draft ? { config: draft.config, secrets: c.secrets } : c;
    var body = '<p class="tlcc-bdesc">' + h(d.desc) + '</p><div class="tlcc-fields">'
      + d.fields.map(function (f) { return fieldHtml(k, f, view, errs || {}); }).join('') + '</div>';
    var foot = '<div class="tlcc-fnote">' + h(NOTE) + '</div><div class="tlcc-fbtn">'
      + '<button type="button" class="tlcc-sec2" onclick="tlccClose()">Cancel</button>'
      + '<button type="button" class="tlcc-prim" id="tlccSave" onclick="tlccSave(\'' + k + '\')">Save &amp; Connect</button></div>';
    openModal(d.icon, 'Configure ' + d.title, body, foot);
    if (errs) {
      var firstErr = document.querySelector('#tlccOv .tlcc-f.err input, #tlccOv .tlcc-f.err select');
      if (firstErr) firstErr.focus();
    }
  }

  window.tlccConfigure = function (k) {
    if (role() !== 'admin') { say('Only the Super Admin can configure channels.', '⚠️'); return; }
    showConfigure(k, null, null);
  };

  window.tlccSave = function (k) {
    var a = api();
    if (!a) return;
    var form = readForm(k);
    var btn = document.getElementById('tlccSave');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    a.put('/admin/integration-channels/' + encodeURIComponent(k), { config: form.config, secrets: form.secrets, connect: true }).then(function (r) {
      replace(r.channel);
      S.result[k] = { ok: true, message: 'Saved and connected. Use Test to send a real message through ' + DEFS[k].title + '.' };
      closeModal(); paint();
      say(DEFS[k].title + ' saved and connected');
    }, function (e) {
      var details = (e && e.details) || null;
      if (details && typeof details === 'object') {
        showConfigure(k, details, { config: form.config });
      } else {
        showConfigure(k, {}, { config: form.config });
        say(errText(e, 'Could not save'), '⚠️');
      }
    });
  };

  /* ------------------------------------------------------------------ the card buttons */
  function act(k, label, path, body, okMsg) {
    var a = api();
    if (!a) return;
    S.busy[k] = label; paint();
    a.post('/admin/integration-channels/' + encodeURIComponent(k) + path, body || {}).then(function (r) {
      S.busy[k] = null;
      if (r.channel) replace(r.channel);
      S.result[k] = typeof okMsg === 'function' ? okMsg(r) : { ok: true, message: okMsg };
      paint();
    }, function (e) {
      S.busy[k] = null;
      var d = e && e.details && typeof e.details === 'object' ? Object.keys(e.details).map(function (x) { return e.details[x]; })[0] : '';
      S.result[k] = { ok: false, message: d || errText(e, 'That did not work') };
      paint();
    });
  }
  window.tlccConnect = function (k) {
    var c = byKey(k);
    if (c && !c.config.host && !c.config.provider && !c.config.phoneNumberId) { window.tlccConfigure(k); return; }
    act(k, 'connect', '/connect', {}, DEFS[k].title + ' connected.');
  };
  window.tlccDisconnect = function (k) {
    if (!window.confirm('Disconnect ' + DEFS[k].title + '? Messages on this channel stop using these settings.')) return;
    act(k, 'disconnect', '/disconnect', {}, DEFS[k].title + ' disconnected.');
  };
  window.tlccTest = function (k) {
    var c = byKey(k);
    var isMail = k === 'email';
    var body = '<p class="tlcc-bdesc">' + (isMail
      ? 'Sends a real test email through the saved SMTP settings. Leave the address blank to send it to your own email.'
      : 'Sends a real test message through the provider using the saved settings.') + '</p>'
      + '<div class="tlcc-fields"><div class="tlcc-f"><label for="tlccTo">' + (isMail ? 'Send test to (optional)' : 'Mobile number to send the test to') + '</label>'
      + '<input type="text" id="tlccTo" placeholder="' + (isMail ? 'you@company.com' : '98XXXXXXXX') + '" autocomplete="off"><div class="tlcc-e" id="tlccToErr" role="alert"></div></div></div>';
    var foot = '<div class="tlcc-fbtn"><button type="button" class="tlcc-sec2" onclick="tlccClose()">Cancel</button>'
      + '<button type="button" class="tlcc-prim" onclick="tlccTestGo(\'' + k + '\')">Send test</button></div>';
    openModal(DEFS[k].icon, 'Test ' + DEFS[k].title, body, foot);
    if (!c || !c.config) return;
  };
  window.tlccTestGo = function (k) {
    var to = (document.getElementById('tlccTo') || {}).value || '';
    to = String(to).trim();
    var err = document.getElementById('tlccToErr');
    if (k !== 'email' && to.replace(/\D/g, '').length < 10) { if (err) err.textContent = 'Enter a valid mobile number'; return; }
    closeModal();
    act(k, 'test', '/test', { to: to }, function (r) { return { ok: !!r.ok, message: (r.ok ? 'Test passed: ' : 'Test failed: ') + r.message }; });
  };

  window.tlccHistory = function (k) {
    var a = api();
    if (!a) return;
    openModal(DEFS[k].icon, DEFS[k].title + ' — history', '<div class="tlcc-hist" id="tlccHist">Loading…</div>',
      '<div class="tlcc-fbtn"><button type="button" class="tlcc-sec2" onclick="tlccClose()">Close</button></div>');
    var LABEL = { config_saved: 'Settings saved', secret_saved: 'Secret saved', secret_cleared: 'Secret cleared', connected: 'Connected',
      reconnected: 'Reconnected', saved_and_reconnected: 'Saved', disconnected: 'Disconnected', test_ok: 'Test passed', test_failed: 'Test failed' };
    a.get('/admin/integration-channels/' + encodeURIComponent(k) + '/events').then(function (r) {
      var el = document.getElementById('tlccHist');
      if (!el) return;
      var ev = r.events || [];
      el.innerHTML = ev.length ? ev.map(function (e) {
        return '<div><b>' + h(LABEL[e.event] || e.event) + '</b> · ' + h(when(e.at)) + (e.detail ? '<br><span class="tlcc-sub">' + h(e.detail) + '</span>' : '') + '</div>';
      }).join('') : 'Nothing has been done on this channel yet.';
    }, function (e) { var el = document.getElementById('tlccHist'); if (el) el.textContent = errText(e, 'The history could not be loaded.'); });
  };

  /* ------------------------------------------------------------------ slot into the Integrations page */
  function mount() {
    if (role() !== 'admin') return;
    if (!/#\/admin\/integrations/.test(location.hash)) return;
    var host = document.getElementById('tljpAdmHost');
    if (!host || document.getElementById('tlccPanel')) return;
    var panel = document.createElement('div');
    panel.id = 'tlccPanel';
    host.parentNode.insertBefore(panel, host.nextSibling);
    S.list = null; paint(); load();
  }
  var pending = null;
  function schedule() { if (pending) return; pending = setTimeout(function () { pending = null; mount(); }, 80); }
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('hashchange', schedule);
  schedule();
})();
