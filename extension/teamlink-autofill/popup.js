/* =====================================================================
   The popup: sign in, see what is cached, turn it off.
   ===================================================================== */
/* global chrome, document */
(function () {
  'use strict';

  var view = document.getElementById('view');
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  };
  var send = function (msg) {
    return new Promise(function (r) { chrome.runtime.sendMessage(msg, r); });
  };
  var get = function (k) {
    return new Promise(function (r) { chrome.storage.local.get(k, r); });
  };
  var set = function (o) {
    return new Promise(function (r) { chrome.storage.local.set(o, r); });
  };

  function host(cb) {
    chrome.tabs.query({ active: true, currentWindow: true }, function (t) {
      var h = '';
      try { h = new URL(t[0].url).hostname; } catch (e) {}
      cb(h);
    });
  }

  async function paint() {
    var s = await get(['signedIn', 'who', 'profile', 'profileAt', 'baseUrl', 'disabled', 'autoSites']);

    if (!s.signedIn) {
      view.innerHTML =
        '<label>TeamLink address</label>'
        + '<input type="text" id="base" value="' + esc(s.baseUrl || 'http://localhost:4323') + '">'
        + '<label>Email</label><input type="email" id="em" autocomplete="username">'
        + '<label>Password</label><input type="password" id="pw" autocomplete="current-password">'
        + '<button class="pri" id="in">Sign in</button>'
        + '<div id="err" class="bad" style="display:none"></div>'
        + '<p class="muted" style="margin-top:10px">Your password is used for this one '
        + 'request and is never stored. The session lives in the browser cookie, '
        + 'which this extension cannot read.</p>';

      document.getElementById('in').addEventListener('click', async function () {
        var err = document.getElementById('err');
        err.style.display = 'none';
        await set({ baseUrl: document.getElementById('base').value.trim() });
        var res = await send({
          type: 'tlaf:signin',
          email: document.getElementById('em').value.trim(),
          password: document.getElementById('pw').value,
        });
        /* Cleared from the DOM the instant it has been used. */
        document.getElementById('pw').value = '';
        if (!res || !res.ok) {
          err.textContent = (res && res.error) || 'Could not sign in.';
          err.style.display = 'block';
          return;
        }
        paint();
      });
      return;
    }

    var p = s.profile || {};
    var age = s.profileAt ? Math.round((Date.now() - s.profileAt) / 60000) : null;
    var missing = (await send({ type: 'tlaf:missing' })).missing || [];

    host(function (h) {
      var auto = (s.autoSites || {})[h];
      view.innerHTML =
        '<p class="ok">Signed in as ' + esc(s.who || p.email || 'candidate') + '</p>'
        + '<p class="muted">' + esc([p.firstName, p.lastName].filter(Boolean).join(' '))
        + (p.currentTitle ? ' &middot; ' + esc(p.currentTitle) : '')
        + (age == null ? '' : '<br>Profile cached ' + age + ' min ago') + '</p>'
        + '<div class="row">'
        + '<button class="ghost" id="ref">Refresh profile</button>'
        + '<button class="ghost" id="out">Sign out</button>'
        + '</div>'
        + (h ? '<label class="sw"><input type="checkbox" id="auto"' + (auto ? ' checked' : '')
            + '> Fill automatically on ' + esc(h) + '</label>' : '')
        + '<label class="sw"><input type="checkbox" id="off"' + (s.disabled ? ' checked' : '')
            + '> Disable auto-fill everywhere</label>'
        + (missing.length ? '<div class="note"><b>Not on your TeamLink profile:</b> '
            + esc(missing.join(', ')) + '. Forms asking for these are left blank '
            + 'rather than guessed at.</div>' : '')
        + '<hr><p class="muted">Nothing you type into an employer\u2019s form is sent '
        + 'anywhere. Only the page address is checked against your TeamLink job list.</p>';

      document.getElementById('ref').addEventListener('click', async function () {
        var res = await send({ type: 'tlaf:refresh' });
        if (!res || !res.ok) alert((res && res.error) || 'Could not refresh.');
        paint();
      });
      document.getElementById('out').addEventListener('click', async function () {
        await send({ type: 'tlaf:signout' });
        paint();
      });
      var a = document.getElementById('auto');
      if (a) a.addEventListener('change', async function () {
        var cur = (await get(['autoSites'])).autoSites || {};
        if (a.checked) cur[h] = true; else delete cur[h];
        await set({ autoSites: cur });
      });
      document.getElementById('off').addEventListener('change', async function () {
        await set({ disabled: document.getElementById('off').checked });
      });
    });
  }

  paint();
}());
