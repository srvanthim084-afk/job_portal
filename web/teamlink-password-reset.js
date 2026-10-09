/* =====================================================================
   TEAMLINK — forgotten passwords

   Until now a forgotten password was the end of the account. The whole
   of auth was login, register, logout, me, and a password change that
   required you to be signed in already, so there was no route back -
   and support had none either, because no endpoint issued a reset.

   Seventy-odd candidate accounts were in that position, plus anyone
   whose stored address had been mangled on the way in.

   THREE SCREENS, all reachable signed-out:
     the sign-in form        inline error + a link out of the dead end
     #/forgot-password       ask for the link
     /reset-password?token=  choose the new password

   THE LAST ONE IS A REAL PATH, not a hash route. A reset link gets
   pasted into mail clients, chat windows and phone keyboards, and a '#'
   fragment is both easy for those to mangle and invisible to the server,
   so a damaged one 404s as the bare origin instead of saying anything.
   app.js serves index.html for that path; the token is read here from
   the query string.

   THE ANSWER TO "SEND ME A LINK" IS ALWAYS THE SAME. Known address,
   unknown address, suspended account - identical wording, because a form
   that distinguishes them is a way of asking whether a particular person
   has an account, and on a recruitment database that is a question about
   who is looking for work.

   ADDITIVE. Two route branches, one wrapped render(), one wrapped
   pageLogin() and one wrapped submitLogin(). Every other route falls
   through to the original untouched.
   ===================================================================== */
(function () {
  'use strict';

  function api() { return (window.TL && window.TL.api) || null; }

  function esc(s) {
    return (typeof window.esc === 'function') ? window.esc(s)
      : String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
  }
  function toast(m, i) { if (typeof window.toast === 'function') window.toast(m, i || 'ℹ️'); }

  var S = {
    busy: false,
    error: '',
    sent: false,          // the "check your email" state
    cooldownUntil: 0,     // resend is refused until this timestamp
    lastEmail: '',        // carried over from the sign-in form
    token: '',
    tokenState: 'unknown', // unknown | checking | valid | invalid
    resetDone: false,
  };

  var COOLDOWN_MS = 60 * 1000;
  var cooldownTimer = null;

  /* ------------------------------------------------------------------ *
   * chrome
   * ------------------------------------------------------------------ */
  function shell(inner) {
    var html = ''
      + '<div class="auth-shell">'
      +   '<div class="auth-side"><div class="content">'
      +     '<span class="role-chip" style="background:#e8eefc;color:#2a4bc0">Account access</span>'
      +     '<h2>Getting you back in</h2>'
      +     '<p>Reset links are single-use and expire 30 minutes after they are sent.</p>'
      +     '<ul>'
      +       '<li>✅&nbsp; The link works once, then stops</li>'
      +       '<li>✅&nbsp; Changing the password ends every signed-in session</li>'
      +       '<li>✅&nbsp; We never send your password by email</li>'
      +     '</ul>'
      +   '</div></div>'
      +   '<div class="auth-form-col">' + inner + '</div>'
      + '</div>';
    return (typeof window.withChrome === 'function') ? window.withChrome('', html) : html;
  }

  function errorLine() {
    if (!S.error) return '';
    return '<div class="fgroup" role="alert" style="margin-bottom:4px;color:#b42318;'
      + 'background:#fef3f2;border:1px solid #fecdca;border-radius:8px;padding:10px 12px;'
      + 'font-size:13px;line-height:1.4">' + esc(S.error) + '</div>';
  }

  function secondsLeft() {
    return Math.max(0, Math.ceil((S.cooldownUntil - Date.now()) / 1000));
  }

  /* A repaint a second while a cooldown is counting down, and not one
     second longer - a timer left running behind another screen is a
     render loop nobody asked for. */
  function ensureCooldownTicker() {
    if (cooldownTimer) return;
    cooldownTimer = setInterval(function () {
      if (secondsLeft() <= 0) {
        clearInterval(cooldownTimer); cooldownTimer = null;
      }
      if (typeof window.render === 'function') window.render();
    }, 1000);
  }

  /* ------------------------------------------------------------------ *
   * screen one — ask for the link
   * ------------------------------------------------------------------ */
  function pageForgot() {
    if (S.sent) {
      var left = secondsLeft();
      if (left > 0) ensureCooldownTicker();
      return shell(''
        + '<div class="auth-form">'
        +   '<h1>Check your email</h1>'
        +   '<p>If an account exists for this email, we&#39;ve sent a password reset link.</p>'
        +   '<p style="color:var(--text-soft);font-size:13px">'
        +     'It expires in 30 minutes. If nothing arrives, check the spam folder.</p>'
        +   errorLine()
        +   '<button class="btn btn-primary btn-block" onclick="tlForgotResend()" '
        +     (left > 0 || S.busy ? 'disabled' : '') + '>'
        +     (S.busy ? 'Sending…' : left > 0 ? 'Resend link in ' + left + 's' : 'Resend link')
        +   '</button>'
        +   '<div class="switch-role"><a href="#/login/candidate">Back to login</a></div>'
        + '</div>');
    }

    return shell(''
      + '<form class="auth-form" onsubmit="tlForgotSubmit(event)">'
      +   '<h1>Forgot your password?</h1>'
      +   '<p>Enter your registered email address and we will send you a link '
      +     'to choose a new password.</p>'
      +   errorLine()
      +   '<div class="fgroup"><label for="tlForgotEmail">Registered email address</label>'
      +     '<input id="tlForgotEmail" name="email" type="email" placeholder="you@example.com" '
      +       'autocomplete="username" value="' + esc(S.lastEmail) + '" '
      +       (S.busy ? 'disabled' : '') + '></div>'
      +   '<button class="btn btn-primary btn-block" type="submit" ' + (S.busy ? 'disabled' : '') + '>'
      +     (S.busy ? 'Sending…' : 'Send reset link') + '</button>'
      +   '<div class="switch-role"><a href="#/login/candidate">Back to login</a></div>'
      + '</form>');
  }

  function requestLink(email) {
    var a = api();
    if (!a) { S.error = 'The server could not be reached.'; window.render(); return; }

    S.busy = true; S.error = '';
    window.render();

    a.post('/auth/forgot', { email: email })
      .then(function () {
        /* SUCCESS AND "NO SUCH ADDRESS" LOOK THE SAME HERE, because the
           server deliberately answers both the same way. */
        S.busy = false;
        S.sent = true;
        S.lastEmail = email;
        S.cooldownUntil = Date.now() + COOLDOWN_MS;
        window.render();
        ensureCooldownTicker();
      })
      .catch(function (err) {
        S.busy = false;
        S.error = (err && err.message) || 'That did not go through. Please try again.';
        window.render();
      });
  }

  window.tlForgotSubmit = function (ev) {
    if (ev && ev.preventDefault) ev.preventDefault();
    if (S.busy) return;
    var el = document.getElementById('tlForgotEmail');
    var email = el ? String(el.value || '').trim() : '';
    if (!email) { S.error = 'Please enter your email address.'; window.render(); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      S.error = 'Please enter a valid email address.'; window.render(); return;
    }
    requestLink(email);
  };

  window.tlForgotResend = function () {
    if (S.busy || secondsLeft() > 0 || !S.lastEmail) return;
    requestLink(S.lastEmail);
  };

  /* ------------------------------------------------------------------ *
   * screen two — choose the new password
   * ------------------------------------------------------------------ */

  /* Length first, then variety. Deliberately not a percentage: a number
     out of a hundred invites people to optimise for the number. */
  function strengthOf(pw) {
    if (!pw) return null;
    var score = 0;
    if (pw.length >= 8) score += 1;
    if (pw.length >= 12) score += 1;
    if (/[A-Za-z]/.test(pw) && /\d/.test(pw)) score += 1;
    if (/[^A-Za-z0-9]/.test(pw)) score += 1;
    if (pw.length < 8 || !/[A-Za-z]/.test(pw) || !/\d/.test(pw)) {
      return { label: 'Too short — 8+ characters with a letter and a number', pct: 20, colour: '#b42318' };
    }
    if (score <= 2) return { label: 'Weak', pct: 40, colour: '#b54708' };
    if (score === 3) return { label: 'Good', pct: 70, colour: '#a15c07' };
    return { label: 'Strong', pct: 100, colour: '#067647' };
  }

  function strengthBar() {
    var el = document.getElementById('tlResetPw');
    var st = strengthOf(el ? el.value : '');
    if (!st) {
      return '<div id="tlPwStrength" style="min-height:8px;margin-bottom:12px"></div>';
    }
    return '<div id="tlPwStrength" style="min-height:8px;margin-bottom:12px">'
      + '<div style="height:4px;background:#e4e7ec;border-radius:3px;overflow:hidden">'
      +   '<div style="height:4px;width:' + st.pct + '%;background:' + st.colour + '"></div>'
      + '</div>'
      + '<div style="font-size:12px;color:' + st.colour + ';margin-top:4px">' + esc(st.label) + '</div>'
      + '</div>';
  }

  /* Repainted in place rather than through render(), so typing a
     password never rebuilds the form underneath the cursor. */
  window.tlPwTyped = function () {
    var host = document.getElementById('tlPwStrength');
    if (!host) return;
    var el = document.getElementById('tlResetPw');
    var st = strengthOf(el ? el.value : '');
    host.innerHTML = st
      ? '<div style="height:4px;background:#e4e7ec;border-radius:3px;overflow:hidden">'
        + '<div style="height:4px;width:' + st.pct + '%;background:' + st.colour + '"></div></div>'
        + '<div style="font-size:12px;color:' + st.colour + ';margin-top:4px">' + esc(st.label) + '</div>'
      : '';
  };

  function pageReset() {
    if (S.resetDone) {
      return shell(''
        + '<div class="auth-form">'
        +   '<h1>Password updated successfully</h1>'
        +   '<p>Every signed-in session for this account has been ended. '
        +     'Taking you to the sign-in page…</p>'
        +   '<a class="btn btn-primary btn-block" href="#/login/candidate">Go to login now</a>'
        + '</div>');
    }

    if (S.tokenState === 'checking') {
      return shell('<div class="auth-form"><h1>Checking your link…</h1>'
        + '<p style="color:var(--text-soft)">One moment.</p></div>');
    }

    if (S.tokenState === 'invalid' || !S.token) {
      return shell(''
        + '<div class="auth-form">'
        +   '<h1>This link is invalid or has expired</h1>'
        +   '<p>Reset links can be used once and last 30 minutes. '
        +     'Ask for a fresh one and it will work.</p>'
        +   '<a class="btn btn-primary btn-block" href="#/forgot-password">Request a new link</a>'
        +   '<div class="switch-role"><a href="#/login/candidate">Back to login</a></div>'
        + '</div>');
    }

    return shell(''
      + '<form class="auth-form" onsubmit="tlResetSubmit(event)">'
      +   '<h1>Choose a new password</h1>'
      +   '<p>At least 8 characters, including a letter and a number.</p>'
      +   errorLine()
      +   '<div class="fgroup">'
      +     '<label for="tlResetPw">New password</label>'
      /*
       * NO SHOW/HIDE BUTTON OF OUR OWN.
       *
       * The application already reveals password fields: a script in
       * index.html attaches a `.tl-eye` button to every type="password"
       * input and wraps it in a span.tl-eye-wrap. Adding a second
       * control put two toggles on one field and, worse, fought that
       * wrapper - the hand-rolled one anchored itself to a container
       * 50px wider than the input and sat outside the box.
       *
       * So the field is plain, and the reveal is the same control the
       * sign-in form uses.
       */
      +     '<input id="tlResetPw" type="password" '
      +       'placeholder="••••••••" autocomplete="new-password" '
      +       'oninput="tlPwTyped()" ' + (S.busy ? 'disabled' : '') + '>'
      +   '</div>'
      +   strengthBar()
      +   '<div class="fgroup"><label for="tlResetPw2">Confirm new password</label>'
      +     '<input id="tlResetPw2" type="password" '
      +       'placeholder="••••••••" autocomplete="new-password" '
      +       (S.busy ? 'disabled' : '') + '></div>'
      +   '<button class="btn btn-primary btn-block" type="submit" ' + (S.busy ? 'disabled' : '') + '>'
      +     (S.busy ? 'Saving…' : 'Update password') + '</button>'
      +   '<div class="switch-role"><a href="#/login/candidate">Back to login</a></div>'
      + '</form>');
  }

  window.tlResetSubmit = function (ev) {
    if (ev && ev.preventDefault) ev.preventDefault();
    if (S.busy) return;

    var p1 = (document.getElementById('tlResetPw') || {}).value || '';
    var p2 = (document.getElementById('tlResetPw2') || {}).value || '';

    /* Checked here so a typo costs a keystroke rather than a round trip
       and a spent token. The server enforces the same rule regardless. */
    if (p1.length < 8) { S.error = 'Password must be at least 8 characters.'; window.render(); return; }
    if (!/[A-Za-z]/.test(p1) || !/\d/.test(p1)) {
      S.error = 'Password must contain at least one letter and one number.';
      window.render(); return;
    }
    if (p1 !== p2) { S.error = 'Those two passwords do not match.'; window.render(); return; }

    var a = api();
    if (!a) { S.error = 'The server could not be reached.'; window.render(); return; }

    S.busy = true; S.error = '';
    window.render();

    a.post('/auth/reset', { token: S.token, password: p1 })
      .then(function () {
        S.busy = false; S.resetDone = true;
        window.render();
        toast('Password updated successfully', '✅');

        /*
         * NOT SIGNED IN AUTOMATICALLY. The reset destroyed every session
         * for this account, which is the point of it; signing them in
         * from here would quietly make a new one out of a link that may
         * well have been forwarded.
         */
        setTimeout(function () {
          S.resetDone = false; S.token = ''; S.tokenState = 'unknown';
          if (location.pathname === '/reset-password') {
            location.replace('/#/login/candidate');
          } else {
            location.hash = '#/login/candidate';
          }
        }, 3000);
      })
      .catch(function (err) {
        S.busy = false;
        var msg = (err && err.message) || '';
        /* A refusal at this point means the token went stale between
           opening the screen and submitting it. */
        if (/no longer valid|expired|invalid/i.test(msg)) {
          S.tokenState = 'invalid'; S.error = '';
        } else {
          S.error = msg || 'That did not go through. Please try again.';
        }
        window.render();
      });
  };

  /* ------------------------------------------------------------------ *
   * reading the token
   * ------------------------------------------------------------------ */
  function tokenFromLocation() {
    /* The real path, which is how the emailed link arrives. */
    try {
      var qs = new URLSearchParams(location.search || '');
      if (qs.get('token')) return qs.get('token');
    } catch (e) {}

    /* And the hash forms, so a link that has been through something
       which rewrote it still works. */
    var h = String(location.hash || '').replace(/^#\/?/, '');
    var q = h.indexOf('?');
    if (q >= 0) {
      try {
        var hq = new URLSearchParams(h.slice(q + 1));
        if (hq.get('token')) return hq.get('token');
      } catch (e2) {}
      h = h.slice(0, q);
    }
    var parts = h.split('/').filter(Boolean);
    if (parts[0] === 'reset-password' && parts[1]) {
      try { return decodeURIComponent(parts[1]); } catch (e3) { return parts[1]; }
    }
    return '';
  }

  function beginTokenCheck(token) {
    S.token = token;
    if (!token) { S.tokenState = 'invalid'; return; }
    if (S.tokenState === 'checking') return;

    S.tokenState = 'checking';
    var a = api();
    if (!a) { S.tokenState = 'invalid'; return; }

    a.post('/auth/reset/check', { token: token })
      .then(function (res) {
        S.tokenState = res && res.valid ? 'valid' : 'invalid';
        window.render();
      })
      .catch(function () {
        S.tokenState = 'invalid';
        window.render();
      });
  }

  /* ------------------------------------------------------------------ *
   * the sign-in form
   * ------------------------------------------------------------------ */

  /* The link, above the submit button - after the password field, before
     the thing you press when you cannot fill it in. */
  var originalPageLogin = window.pageLogin;
  if (typeof originalPageLogin === 'function') {
    window.pageLogin = function () {
      var html = originalPageLogin.apply(this, arguments);
      if (typeof html !== 'string') return html;

      var anchor = '<button class="btn btn-primary btn-block" type="submit">';
      if (html.indexOf(anchor) < 0) return html;   // markup moved: leave it alone

      var block = '<div id="tlLoginError" role="alert" style="display:none;color:#b42318;'
        + 'background:#fef3f2;border:1px solid #fecdca;border-radius:8px;padding:10px 12px;'
        + 'font-size:13px;margin-bottom:12px"></div>'
        + '<div class="fgroup" style="margin-top:-6px;text-align:right">'
        + '<a id="tlForgotLink" href="#/forgot-password" style="font-size:13px">'
        + 'Forgot password?</a></div>';
      return html.replace(anchor, block + anchor);
    };
  }

  /*
   * An inline failure message, and the way out made obvious.
   *
   * A failed sign-in previously produced only a toast, which is gone in
   * four seconds and says nothing about what to do next. Somebody whose
   * password does not work needs the reset link at exactly that moment,
   * so the link is emphasised as soon as an attempt fails.
   */
  var originalSubmitLogin = window.submitLogin;
  if (typeof originalSubmitLogin === 'function') {
    window.submitLogin = function (role, ev) {
      var form = ev && ev.target;
      try {
        if (form && form.elements && form.elements.email) {
          S.lastEmail = String(form.elements.email.value || '').trim();
        }
      } catch (e) {}

      var box = document.getElementById('tlLoginError');
      if (box) { box.style.display = 'none'; box.textContent = ''; }

      var out = originalSubmitLogin.apply(this, arguments);

      /* submitLogin swallows its own rejection, so "did it work" is
         answered by whether a session exists afterwards. */
      return Promise.resolve(out).then(function (v) {
        if (window.STATE && STATE.session) return v;

        var b = document.getElementById('tlLoginError');
        if (b) {
          b.textContent = 'Incorrect email or password.';
          b.style.display = 'block';
        }
        var link = document.getElementById('tlForgotLink');
        if (link) {
          link.style.fontWeight = '700';
          link.style.textDecoration = 'underline';
          link.textContent = 'Forgot password?';
        }
        return v;
      });
    };
  }

  /* ------------------------------------------------------------------ *
   * the first sign-in, on a password somebody else generated
   *
   * A candidate added by a recruiter is emailed a temporary password and
   * `must_change_password` is set on their account. The server has
   * always said so - it is on the sign-in answer, and now on every
   * answer about who is signed in - and nothing in the interface ever
   * read it. So "they must choose their own password before they get
   * in" was a column in the database and nothing else.
   *
   * This is a GATE, not a suggestion: while the flag is set, every route
   * renders this screen. It survives a refresh, a new tab and a typed
   * URL, because the flag comes back with the session every time.
   * ------------------------------------------------------------------ */
  function mustChange() {
    return !!(window.STATE && STATE.session && STATE.session.mustChangePassword);
  }

  function pageFirstPassword() {
    return shell(''
      + '<form class="auth-form" onsubmit="tlFirstPasswordSubmit(event)">'
      +   '<h1>Choose your password</h1>'
      +   '<p>You signed in with a temporary password we generated. '
      +     'Pick your own to continue — at least 8 characters, including a '
      +     'letter and a number.</p>'
      +   errorLine()
      +   '<div class="fgroup"><label for="tlFirstCur">Temporary password</label>'
      +     '<input id="tlFirstCur" type="password" placeholder="••••••••" '
      +       'autocomplete="current-password" ' + (S.busy ? 'disabled' : '') + '></div>'
      +   '<div class="fgroup"><label for="tlFirstNew">New password</label>'
      +     '<input id="tlFirstNew" type="password" placeholder="••••••••" '
      +       'autocomplete="new-password" oninput="tlFirstTyped()" '
      +       (S.busy ? 'disabled' : '') + '></div>'
      +   '<div id="tlFirstStrength" style="min-height:8px;margin-bottom:12px"></div>'
      +   '<div class="fgroup"><label for="tlFirstNew2">Confirm new password</label>'
      +     '<input id="tlFirstNew2" type="password" placeholder="••••••••" '
      +       'autocomplete="new-password" ' + (S.busy ? 'disabled' : '') + '></div>'
      +   '<button class="btn btn-primary btn-block" type="submit" ' + (S.busy ? 'disabled' : '') + '>'
      +     (S.busy ? 'Saving…' : 'Set my password and continue') + '</button>'
      + '</form>');
  }

  window.tlFirstTyped = function () {
    var host = document.getElementById('tlFirstStrength');
    if (!host) return;
    var el = document.getElementById('tlFirstNew');
    var st = strengthOf(el ? el.value : '');
    host.innerHTML = st
      ? '<div style="height:4px;background:#e4e7ec;border-radius:3px;overflow:hidden">'
        + '<div style="height:4px;width:' + st.pct + '%;background:' + st.colour + '"></div></div>'
        + '<div style="font-size:12px;color:' + st.colour + ';margin-top:4px">' + esc(st.label) + '</div>'
      : '';
  };

  window.tlFirstPasswordSubmit = function (ev) {
    if (ev && ev.preventDefault) ev.preventDefault();
    if (S.busy) return;

    var cur = (document.getElementById('tlFirstCur') || {}).value || '';
    var p1 = (document.getElementById('tlFirstNew') || {}).value || '';
    var p2 = (document.getElementById('tlFirstNew2') || {}).value || '';

    if (!cur) { S.error = 'Enter the temporary password you were sent.'; window.render(); return; }
    if (p1.length < 8) { S.error = 'Password must be at least 8 characters.'; window.render(); return; }
    if (!/[A-Za-z]/.test(p1) || !/\d/.test(p1)) {
      S.error = 'Password must contain at least one letter and one number.';
      window.render(); return;
    }
    if (p1 !== p2) { S.error = 'Those two passwords do not match.'; window.render(); return; }
    if (p1 === cur) { S.error = 'Choose a password different from the temporary one.'; window.render(); return; }

    var a = api();
    if (!a) { S.error = 'The server could not be reached.'; window.render(); return; }

    S.busy = true; S.error = '';
    window.render();

    a.post('/auth/password', { current: cur, next: p1 })
      .then(function () {
        S.busy = false;
        /* The gate is down. Cleared locally as well as on the server so
           the next render lets them through without another round trip. */
        if (window.STATE && STATE.session) STATE.session.mustChangePassword = false;
        toast('Password set. Welcome to TeamLink.', '✅');
        /* Onto Candidate Home, where "Build your profile" (teamlink-profile-onboarding.js) offers to walk
           them through the resume and the remaining details. */
        var role = (STATE.session && STATE.session.role) || 'candidate';
        window.navigate('/' + role + '/home');
      })
      .catch(function (err) {
        S.busy = false;
        S.error = (err && err.message) || 'That did not go through. Please try again.';
        window.render();
      });
  };

  /* ------------------------------------------------------------------ *
   * routing
   * ------------------------------------------------------------------ */
  var originalRender = window.render;
  if (typeof originalRender === 'function') {
    window.render = function () {
      var onResetPath = location.pathname === '/reset-password';
      var h = String(location.hash || '').replace(/^#\/?/, '');
      var head = h.split('?')[0].split('/').filter(Boolean)[0] || '';

      /*
       * THE GATE. While the account is on a generated password, every
       * route is this screen - except the ones that exist to get out of
       * it, because somebody who cannot remember the temporary password
       * still needs the reset flow.
       */
      if (mustChange() && head !== 'reset-password' && head !== 'forgot-password'
          && !onResetPath) {
        document.getElementById('app').innerHTML = pageFirstPassword();
        window.scrollTo(0, 0);
        var c0 = document.getElementById('tlFirstCur');
        if (c0 && !S.busy) { try { c0.focus(); } catch (e) {} }
        return;
      }

      if (head === 'forgot-password') {
        document.getElementById('app').innerHTML = pageForgot();
        window.scrollTo(0, 0);
        var f = document.getElementById('tlForgotEmail');
        if (f && !S.busy) { try { f.focus(); } catch (e) {} }
        return;
      }

      if (onResetPath || head === 'reset-password') {
        var tok = tokenFromLocation();
        if (tok !== S.token || S.tokenState === 'unknown') beginTokenCheck(tok);
        document.getElementById('app').innerHTML = pageReset();
        window.scrollTo(0, 0);
        var p = document.getElementById('tlResetPw');
        if (p && !S.busy) { try { p.focus(); } catch (e) {} }
        return;
      }

      /* Leaving these screens clears them, so coming back does not show
         a stale error or a stale confirmation. */
      if (S.sent || S.error || S.busy || S.resetDone) {
        S.sent = false; S.error = ''; S.busy = false; S.resetDone = false;
      }
      if (cooldownTimer) { clearInterval(cooldownTimer); cooldownTimer = null; }

      return originalRender.apply(this, arguments);
    };
  }

  /*
   * When the page is served at /reset-password there is no hash at all,
   * so nothing would call render() on its own.
   */
  if (location.pathname === '/reset-password') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { window.render(); });
    } else {
      setTimeout(function () { window.render(); }, 0);
    }
  }
}());
