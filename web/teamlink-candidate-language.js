/*
 * TeamLink - the candidate's preferred language (0102).
 *
 *   Profile    a "Preferred language" card: English / తెలుగు / हिन्दी, saved
 *              to the server (PUT /api/candidates/:id {preferredLanguage}).
 *   Register   the same choice on the registration form, sent with the
 *              registration itself.
 *
 * What it changes: the interview prep kit's tips, bring-list and headings,
 * the AI assistant's Basic mode when a message does not show its own
 * language, and the Home page's career suggestion. It is NOT the
 * "Languages" card (the languages the candidate speaks), which stays as
 * it is.
 *
 * The server keeps the value; nothing here is stored in the browser.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || window.__tlLang) return;
  window.__tlLang = true;

  var CHOICES = [
    ['en', 'English', 'English'],
    ['te', 'తెలుగు', 'Telugu'],
    ['hi', 'हिन्दी', 'Hindi'],
  ];

  var api = function () { return window.TL && TL.api; };
  var isCand = function () { return !!(window.STATE && STATE.session && STATE.session.role === 'candidate'); };
  var cand = function () {
    return isCand() && window.DATA && DATA.candidateById ? DATA.candidateById(STATE.session.id) : null;
  };
  var h = function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  };
  var say = function (m, i) { if (typeof window.toast === 'function') toast(m, i || '✓'); };
  var rerender = function () { if (typeof window.render === 'function') render(); };
  var langOf = function (c) { var v = c && c.preferredLanguage; return v === 'te' || v === 'hi' ? v : 'en'; };

  var S = { saving: '', err: '' };

  function css() {
    if (document.getElementById('tllangCss')) return;
    var s = document.createElement('style');
    s.id = 'tllangCss';
    s.textContent = [
      '.tllang-opts{display:flex;gap:8px;flex-wrap:wrap;margin-top:4px}',
      '.tllang-opt{border:1px solid #d5dce6;background:#fff;border-radius:10px;padding:8px 14px;font-size:14px;font-weight:700;color:#26313f;cursor:pointer;min-width:96px;text-align:center;font-family:inherit}',
      '.tllang-opt small{display:block;font-size:11px;font-weight:600;color:#6b7a90;margin-top:1px}',
      '.tllang-opt.on{border-color:var(--cap-blue,#1d6ff2);background:#eaf2ff;color:#123f8c;box-shadow:0 0 0 1px var(--cap-blue,#1d6ff2) inset}',
      '.tllang-opt[disabled]{opacity:.6;cursor:wait}',
      '.tllang-note{font-size:12px;color:#6b7a90;line-height:1.55;margin-top:9px}',
      '.tllang-err{font-size:12px;color:#b42318;margin-top:6px}',
    ].join('\n');
    document.head.appendChild(s);
  }

  /* ------------------------------------------------------------------ *
   * profile card
   * ------------------------------------------------------------------ */

  function cardHtml(c) {
    var cur = langOf(c);
    return '<div class="cap-card cap-block" id="tllangCard" data-tllang="1"><div class="cap-bh"><h4>Preferred language</h4></div>'
      + '<div class="tllang-opts" role="radiogroup" aria-label="Preferred language">'
      + CHOICES.map(function (x) {
        var on = x[0] === cur;
        return '<button type="button" class="tllang-opt' + (on ? ' on' : '') + '" role="radio" aria-checked="' + on + '"'
          + ' data-lang="' + x[0] + '"' + (S.saving ? ' disabled' : '') + ' lang="' + x[0] + '">'
          + h(x[1]) + (x[0] === 'en' ? '' : '<small lang="en">' + h(x[2]) + '</small>') + '</button>';
      }).join('') + '</div>'
      + '<div class="tllang-note">Your interview prep kit (tips and checklist) and the assistant\'s Basic mode use this language. '
      + 'Interview questions stay in English. This is not the languages you speak - add those under <b>Languages</b>.</div>'
      + (S.err ? '<div class="tllang-err">' + h(S.err) + '</div>' : '')
      + '</div>';
  }

  function wrapProfile() {
    var prev = window.capProfile;
    if (typeof prev !== 'function' || prev.__tllang) return;
    var next = function () {
      var html = prev.apply(this, arguments);
      try {
        var c = cand();
        if (!c || typeof html !== 'string' || (STATE.cap && STATE.cap.tab === 'insights')) return html;
        css();
        var card = cardHtml(c);
        var at = html.indexOf('<h4>Resume</h4>');
        if (at > 0) {
          var start = html.lastIndexOf('<div class="cap-card', at);
          if (start > 0) return html.slice(0, start) + card + html.slice(start);
        }
        var end = html.lastIndexOf('</div>');
        return end > 0 ? html.slice(0, end) + card + html.slice(end) : html + card;
      } catch (e) { return html; }
    };
    next.__tllang = true;
    window.capProfile = next;
  }

  function choose(lang) {
    var c = cand();
    if (!c || !api() || S.saving || ['en', 'te', 'hi'].indexOf(lang) < 0 || langOf(c) === lang) return;
    S.saving = lang; S.err = '';
    rerender();
    api().put('/candidates/' + encodeURIComponent(c.id), { preferredLanguage: lang }).then(function (r) {
      var local = cand();
      if (local && r && r.candidate) Object.assign(local, r.candidate);
      var name = CHOICES.filter(function (x) { return x[0] === lang; })[0];
      say('Preferred language: ' + (name ? name[2] : lang), '✓');
    }).catch(function (e) {
      S.err = (e && e.message) || 'That could not be saved. Please try again.';
    }).then(function () { S.saving = ''; rerender(); });
  }

  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest && e.target.closest('#tllangCard [data-lang]');
    if (!b) return;
    e.preventDefault();
    choose(b.getAttribute('data-lang'));
  });

  /* ------------------------------------------------------------------ *
   * registration form
   * ------------------------------------------------------------------ */

  function decorateRegister() {
    if (document.getElementById('regPrefLang')) return;
    var anchor = document.getElementById('regAvailability') || document.getElementById('regNotice');
    var field = anchor && anchor.closest('.review-field');
    if (!field) return;
    var div = document.createElement('div');
    div.className = 'review-field';
    div.innerHTML = '<label for="regPrefLang">Preferred language for TeamLink messages</label>'
      + '<select id="regPrefLang">' + CHOICES.map(function (x, i) {
        return '<option value="' + x[0] + '"' + (i === 0 ? ' selected' : '') + '>' + h(x[1]) + (x[0] === 'en' ? '' : ' (' + h(x[2]) + ')') + '</option>';
      }).join('') + '</select>';
    field.parentNode.insertBefore(div, field.nextSibling);
  }

  function wrapApi() {
    var a = api();
    if (!a || a.__tllang) return;
    var post = a.post;
    a.post = function (path, body, opts) {
      if (path === '/auth/register' && body && typeof body === 'object' && !body.preferredLanguage) {
        var el = document.getElementById('regPrefLang');
        if (el && el.value && el.value !== 'en') body = Object.assign({}, body, { preferredLanguage: el.value });
      }
      return post.call(this, path, body, opts);
    };
    a.__tllang = true;
  }

  /* ------------------------------------------------------------------ */

  var queued = false;
  function afterPaint() {
    if (queued) return;
    queued = true;
    setTimeout(function () {
      queued = false;
      try {
        wrapApi();
        if ((location.hash || '').indexOf('#/register/candidate') === 0) decorateRegister();
      } catch (e) { /* cosmetic; the server enforces */ }
    }, 60);
  }

  function install() {
    wrapProfile();
    wrapApi();
    var prev = window.render;
    if (typeof prev === 'function' && !prev.__tllangR) {
      var r = function () { var out = prev.apply(this, arguments); afterPaint(); return out; };
      r.__tllangR = true;
      window.render = r;
    }
    if (isCand() && (location.hash || '').indexOf('#/candidate/profile') === 0) rerender();
    afterPaint();
  }
  if (document.readyState === 'complete') install();
  else window.addEventListener('load', install);

  window.TLCandidateLanguage = { current: function () { return langOf(cand()); }, set: choose };
})();
