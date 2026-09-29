/* =====================================================================
   TeamLink AutoFill — the button, the fill, and what is said afterwards
   =====================================================================

   IT NEVER PRESSES SUBMIT. There is no code path in this file that
   clicks a button on the host page. The candidate reviews and submits,
   every time, and the summary below exists so they know what to review.

   IT NEVER CLAIMS AN APPLICATION WAS SENT. When the page matches a job
   TeamLink already has on record, one event is posted marking it
   "Clicked" - the same word the portal uses for opening an employer's
   link. Whether it was actually submitted is something only the
   candidate can say, and they say it in TeamLink as they always have.

   IT DOES NOTHING ON A PAGE THAT IS NOT AN APPLICATION FORM. Being on
   an ATS domain is not enough: a jobs list, a company page and a search
   result are all on the same host. The adapter has to recognise a form
   with fields in it first.
   ===================================================================== */
/* global window, document, chrome */
(function () {
  'use strict';

  var F = window.TLAF_FIELDS;
  var A = window.TLAF_ADAPTERS;
  if (!F || !A) return;

  var state = { adapter: null, root: null, profile: null, filled: false };

  /* ---------------------------------------------------------------- *
   * which platform
   * ---------------------------------------------------------------- */
  function pickAdapter() {
    var named = ['workday', 'greenhouse', 'lever', 'icims'];
    for (var i = 0; i < named.length; i++) {
      var a = A[named[i]];
      if (a && a.matches()) return a;
    }
    return A.generic;
  }

  /* ---------------------------------------------------------------- *
   * the button
   * ---------------------------------------------------------------- */
  function mount() {
    if (document.getElementById('tlafFab')) return;

    var adapter = pickAdapter();
    var root = adapter.root();
    if (!adapter.detect(root)) return;      // not an application form

    state.adapter = adapter;
    state.root = root;

    var b = document.createElement('button');
    b.id = 'tlafFab';
    b.className = 'tlaf-fab';
    b.type = 'button';
    b.textContent = 'Fill with TeamLink';
    b.addEventListener('click', onFill);
    document.body.appendChild(b);

    /* Per-site, off unless the candidate turned it on for this host. */
    chrome.storage.local.get(['autoSites', 'disabled'], function (s) {
      if (s.disabled) { b.remove(); return; }
      var on = (s.autoSites || {})[location.hostname];
      if (on) setTimeout(onFill, 900);
    });
  }

  /* ---------------------------------------------------------------- *
   * filling
   * ---------------------------------------------------------------- */

  function valueFor(key, p) {
    if (key === 'fullName') {
      return [p.firstName, p.lastName].filter(Boolean).join(' ') || p.name || '';
    }
    if (key === 'skills') {
      return Array.isArray(p.skills) ? p.skills.join(', ') : (p.skills || '');
    }
    if (key === 'experienceYears') {
      return p.experienceYears == null ? '' : String(p.experienceYears);
    }
    return p[key] == null ? '' : String(p[key]);
  }

  function onFill() {
    var b = document.getElementById('tlafFab');
    if (b) { b.disabled = true; b.textContent = 'Filling…'; }

    chrome.runtime.sendMessage({ type: 'tlaf:profile' }, function (res) {
      if (b) { b.disabled = false; b.textContent = 'Fill with TeamLink'; }

      if (!res || !res.ok) {
        panel('Not signed in',
          '<p>Open the TeamLink AutoFill icon and sign in to your candidate '
          + 'account first.</p>'
          + (res && res.error ? '<p class="tlaf-muted">' + esc(res.error) + '</p>' : ''));
        return;
      }
      state.profile = res.profile;
      doFill(res.profile);
    });
  }

  function doFill(profile) {
    var fields = state.adapter.fields(state.root);

    var filled = [], skipped = [], blocked = 0;

    fields.forEach(function (f) {
      var el = f.el;

      /* Belt and braces: the adapter already checked, and this is the
         last gate before anything is written. An adapter that saw
         something this generic check cannot - Workday's wrapper-level
         data-automation-id, say - says so with `blocked`, and is
         believed. */
      if (f.blocked || F.neverFill(el, F.labelText(el))) { blocked += 1; return; }

      if (!f.key) { skipped.push(describe(el)); return; }

      var v = valueFor(f.key, profile);
      if (!v) { skipped.push(describe(el)); return; }

      var ok = el.tagName === 'SELECT' ? F.setSelect(el, v) : F.setValue(el, v);
      if (ok) {
        filled.push(label(f.key));
        el.classList.add('tlaf-hit');
        setTimeout(function () { el.classList.remove('tlaf-hit'); }, 2200);
      } else {
        skipped.push(describe(el));
      }
    });

    state.filled = true;
    summary(filled, skipped, blocked, fields.length);
    track();
  }

  function label(key) {
    return key.replace(/([A-Z])/g, ' $1').replace(/^./, function (c) {
      return c.toUpperCase();
    });
  }

  function describe(el) {
    var t = F.labelText(el).replace(/\s+/g, ' ').trim();
    return (t.slice(0, 44) || el.getAttribute('name') || 'an unnamed field');
  }

  /* ---------------------------------------------------------------- *
   * what was and was not done
   * ---------------------------------------------------------------- */
  function summary(filled, skipped, blocked, total) {
    var resume = !!document.querySelector('input[type="file"]');

    var html = '<p><b>Filled ' + filled.length + ' of ' + total + ' fields.</b></p>';

    if (skipped.length) {
      html += '<p>Please complete these yourself:</p><ul>'
        + skipped.slice(0, 8).map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('')
        + (skipped.length > 8 ? '<li class="tlaf-muted">and ' + (skipped.length - 8)
            + ' more</li>' : '')
        + '</ul>';
    }

    if (blocked) {
      html += '<p class="tlaf-muted">' + blocked + ' field'
        + (blocked === 1 ? ' was' : 's were')
        + ' left alone on purpose: passwords, payment and identity '
        + 'numbers are never filled.</p>';
    }

    if (resume) {
      html += '<div class="tlaf-warn"><b>Attach your resume yourself.</b> '
        + 'A browser will not let an extension choose a file for you - that '
        + 'has to be your click. Use the file button on the form.</div>';
    }

    if (state.adapter && state.adapter.caveat) {
      html += '<div class="tlaf-warn">' + esc(state.adapter.caveat) + '</div>';
    }

    html += '<p class="tlaf-muted" style="margin-top:9px">Nothing has been '
      + 'submitted. Read the form through and submit it yourself.</p>';

    panel('TeamLink AutoFill', html);
  }

  function panel(title, html) {
    var old = document.getElementById('tlafPanel');
    if (old) old.remove();
    var p = document.createElement('div');
    p.id = 'tlafPanel';
    p.className = 'tlaf-panel';
    p.innerHTML = '<button class="tlaf-x" type="button" aria-label="Close">✕</button>'
      + '<h4>' + esc(title) + '</h4>' + html;
    p.querySelector('.tlaf-x').addEventListener('click', function () { p.remove(); });
    document.body.appendChild(p);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  /* ---------------------------------------------------------------- *
   * telling TeamLink, carefully
   * ---------------------------------------------------------------- */
  function track() {
    /* Only the URL. Nothing the candidate typed, and nothing read off
       the employer's page, ever leaves this tab. */
    chrome.runtime.sendMessage({ type: 'tlaf:opened', url: location.href },
      function (res) {
        if (!res || !res.matched) return;    // not a job TeamLink knows
        var p = document.getElementById('tlafPanel');
        if (!p) return;
        var n = document.createElement('p');
        n.className = 'tlaf-muted';
        n.style.marginTop = '8px';
        n.textContent = 'Logged in TeamLink as Clicked. Tell TeamLink whether '
          + 'you actually applied when you get a moment — nothing here can know.';
        p.appendChild(n);
      });
  }

  /* ---------------------------------------------------------------- *
   * the page changes under us on all four of these
   * ---------------------------------------------------------------- */
  var queued = false;
  function queue() {
    if (queued) return;
    queued = true;
    setTimeout(function () { queued = false; try { mount(); } catch (e) {} }, 400);
  }

  try {
    new MutationObserver(queue).observe(document.documentElement,
      { childList: true, subtree: true });
  } catch (e) {}

  queue();
}());
